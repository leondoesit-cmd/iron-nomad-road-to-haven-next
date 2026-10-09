// glTF reading for the model tools (`bake-models.mjs`, `autorig.mjs`): GLB/glTF JSON and buffers, accessors, the node
// tree as three objects, clips as three AnimationClips, embedded images decoded through ffmpeg. Data only: nothing in a
// model file is ever run.
import * as THREE from 'three';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// ------------------------------------------------------------------------------------------ glTF reading

const COMP = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const NORM = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };

export function readGltf(file) {
  const buf = readFileSync(file);
  if (buf.toString('latin1', 0, 4) === 'glTF') {
    let off = 12;
    let json = null;
    let bin = null;
    while (off < buf.length) {
      const len = buf.readUInt32LE(off);
      const type = buf.readUInt32LE(off + 4);
      const chunk = buf.subarray(off + 8, off + 8 + len);
      if (type === 0x4e4f534a) json = JSON.parse(chunk.toString('utf8'));
      else if (type === 0x004e4942) bin = chunk;
      off += 8 + len;
    }
    return { json, buffers: [bin] };
  }
  const json = JSON.parse(buf.toString('utf8'));
  const buffers = (json.buffers ?? []).map((b) => {
    if (b.uri.startsWith('data:')) return Buffer.from(b.uri.split(',')[1], 'base64');
    return readFileSync(resolve(dirname(file), decodeURIComponent(b.uri)));
  });
  return { json, buffers, dir: dirname(file) };
}

/** An accessor as a flat Float32Array (normalized integers mapped to 0..1 / -1..1), plus its item size. */
export function accessor(g, idx, raw = false) {
  const a = g.json.accessors[idx];
  const n = SIZE[a.type];
  const T = COMP[a.componentType];
  const out = raw ? new T(a.count * n) : new Float32Array(a.count * n);
  if (a.bufferView === undefined) return { data: out, n, count: a.count };
  const bv = g.json.bufferViews[a.bufferView];
  const buf = g.buffers[bv.buffer];
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const esize = T.BYTES_PER_ELEMENT;
  const stride = bv.byteStride ?? esize * n;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const get = {
    5120: (o) => dv.getInt8(o), 5121: (o) => dv.getUint8(o), 5122: (o) => dv.getInt16(o, true),
    5123: (o) => dv.getUint16(o, true), 5125: (o) => dv.getUint32(o, true), 5126: (o) => dv.getFloat32(o, true),
  }[a.componentType];
  const k = !raw && a.normalized ? 1 / NORM[a.componentType] : 1;
  for (let i = 0; i < a.count; i++) {
    for (let c = 0; c < n; c++) out[i * n + c] = get(base + i * stride + c * esize) * (a.normalized && !raw ? 1 : 1) * k;
  }
  if (a.sparse) throw new Error('sparse accessors are not supported');
  return { data: out, n, count: a.count };
}

/** The node hierarchy as three objects (names n0, n1, ... so animation tracks bind unambiguously). */
export function buildNodes(g) {
  const objs = g.json.nodes.map((nd, i) => {
    const o = new THREE.Object3D();
    o.name = `n${i}`;
    o.userData.src = nd.name ?? `node${i}`;
    if (nd.matrix) new THREE.Matrix4().fromArray(nd.matrix).decompose(o.position, o.quaternion, o.scale);
    if (nd.translation) o.position.fromArray(nd.translation);
    if (nd.rotation) o.quaternion.fromArray(nd.rotation);
    if (nd.scale) o.scale.fromArray(nd.scale);
    return o;
  });
  const root = new THREE.Object3D();
  const hasParent = new Set();
  g.json.nodes.forEach((nd, i) => (nd.children ?? []).forEach((c) => { objs[i].add(objs[c]); hasParent.add(c); }));
  objs.forEach((o, i) => { if (!hasParent.has(i)) root.add(o); });
  root.updateMatrixWorld(true);
  return { root, objs };
}

export function clipOf(g, anim) {
  const tracks = [];
  for (const ch of anim.channels) {
    if (ch.target.node === undefined) continue;
    const s = anim.samplers[ch.sampler];
    const times = accessor(g, s.input).data;
    let vals = accessor(g, s.output).data;
    const path = ch.target.path;
    if (path === 'weights') continue;
    const n = path === 'rotation' ? 4 : 3;
    if (s.interpolation === 'CUBICSPLINE') {
      // Keep the values, drop the tangents (in-tangent, value, out-tangent per key).
      const v = new Float32Array(times.length * n);
      for (let i = 0; i < times.length; i++) for (let c = 0; c < n; c++) v[i * n + c] = vals[(i * 3 + 1) * n + c];
      vals = v;
    }
    const name = `n${ch.target.node}.${path === 'translation' ? 'position' : path === 'rotation' ? 'quaternion' : 'scale'}`;
    const T = path === 'rotation' ? THREE.QuaternionKeyframeTrack : THREE.VectorKeyframeTrack;
    const track = new T(name, Array.from(times), Array.from(vals));
    if (s.interpolation === 'STEP') track.setInterpolation(THREE.InterpolateDiscrete);
    tracks.push(track);
  }
  return new THREE.AnimationClip(anim.name ?? 'clip', -1, tracks);
}

// ------------------------------------------------------------------------------------------ textures into vertex colours

/** Decode an embedded or external glTF image to RGBA bytes (via ffmpeg). */
export function decodeImage(g, imageIdx) {
  const img = g.json.images[imageIdx];
  let bytes;
  if (img.bufferView !== undefined) {
    const bv = g.json.bufferViews[img.bufferView];
    const b = g.buffers[bv.buffer];
    bytes = b.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
  } else if (img.uri.startsWith('data:')) bytes = Buffer.from(img.uri.split(',')[1], 'base64');
  else bytes = readFileSync(resolve(g.dir, decodeURIComponent(img.uri)));
  const tmp = mkdtempSync(join(tmpdir(), 'img-'));
  try {
    const f = join(tmp, 'img');
    writeFileSync(f, bytes);
    const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim().split(',').map(Number);
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 256 * 1024 * 1024 });
    return { w: probe[0], h: probe[1], data: raw };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export const SRGB = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
/** Linear colour of an image at a glTF UV (v down from the top), nearest texel, wrapping. */
export function texel(img, u, v) {
  const x = ((Math.floor(u * img.w) % img.w) + img.w) % img.w;
  const y = ((Math.floor(v * img.h) % img.h) + img.h) % img.h;
  const i = (y * img.w + x) * 4;
  return [SRGB(img.data[i] / 255), SRGB(img.data[i + 1] / 255), SRGB(img.data[i + 2] / 255)];
}

/** Area-weighted vertex normals, shared across vertices at the same position. */
export function smoothNormals(pos, nrm, idx) {
  const key = (i) => `${pos[i * 3].toFixed(5)},${pos[i * 3 + 1].toFixed(5)},${pos[i * 3 + 2].toFixed(5)}`;
  const acc = new Map();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let t = 0; t < idx.length; t += 3) {
    a.fromArray(pos, idx[t] * 3); b.fromArray(pos, idx[t + 1] * 3); c.fromArray(pos, idx[t + 2] * 3);
    n.subVectors(c, b).cross(a.clone().sub(b));
    for (let k = 0; k < 3; k++) {
      const kk = key(idx[t + k]);
      const v = acc.get(kk) ?? new THREE.Vector3();
      v.add(n);
      acc.set(kk, v);
    }
  }
  for (let i = 0; i < pos.length / 3; i++) {
    const v = acc.get(key(i));
    if (!v) continue;
    v.clone().normalize().toArray(nrm, i * 3);
  }
}

