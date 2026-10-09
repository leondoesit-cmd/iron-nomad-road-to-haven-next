// Bake rigged, animated glTF models into the game's compact model format (`src/render/bakedModel.ts`).
//
// Each model's skinned meshes are merged into one geometry, turned to face +Z with the feet at y = 0 and scaled to the size
// the game's anatomy expects. Every animation clip it is given a role for is sampled at a fixed rate and stored as the
// skinning matrices of every bone in every frame (3x4, half floats): the GPU reads them straight from a texture, so a herd
// or a horde animates with no per-bone work on the CPU. Run `node scripts/bake-models.mjs [name ...]`.
//
// Sources live in `assets/models/` (kept out of the shipped build); output goes to `public/models/`. Downloaded models
// are data: this script only parses their JSON and buffers.
import * as THREE from 'three';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessor, buildNodes, clipOf, decodeImage, readGltf, smoothNormals, texel } from './gltf-read.mjs';
import { autoRig } from './autorig.mjs';
import { retarget, ZOMBIE_BONES, ZOMBIE_JOINTS } from './retarget.mjs';

// `BAKE_CONFIG=path` bakes another list (tools: quick looks at a source).
const { MODELS } = await import(process.env.BAKE_CONFIG ? resolve(process.env.BAKE_CONFIG) : './models.config.mjs');


const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../assets/models');
const OUT = process.env.BAKE_OUT ? resolve(process.env.BAKE_OUT) : resolve(here, '../public/models');
mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------------------------------------ baking

const b8 = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));

/** A skinned glTF: its node tree, joints, merged geometry and clips (its own, or borrowed by joint name). */
function loadSkin(cfg) {
  const file = resolve(SRC, cfg.source);
  const g = readGltf(file);
  const { root, objs } = buildNodes(g);
  // Every skin's joints in one list (a body, its face and its tongue are often separate skins over the same bones).
  const jointNodes = [];
  const IBM = [];
  const jointOf = new Map();
  const skinMap = g.json.skins.map((skin) => {
    const ibm = accessor(g, skin.inverseBindMatrices).data;
    return skin.joints.map((node, j) => {
      if (!jointOf.has(node)) {
        jointOf.set(node, jointNodes.length);
        jointNodes.push(node);
        IBM.push(new THREE.Matrix4().fromArray(ibm, j * 16));
      }
      return jointOf.get(node);
    });
  });
  const joints = jointNodes.map((n) => objs[n]);
  // Merge every primitive of every skinned mesh node (unless excluded).
  const pos = [];
  const nrm = [];
  const uv = [];
  const col = [];
  const ji = [];
  const jw = [];
  const idx = [];
  let texture = null;
  const images = new Map();
  g.json.nodes.forEach((nd, ni) => {
    if (nd.mesh === undefined || nd.skin === undefined) return;
    const mesh = g.json.meshes[nd.mesh];
    if (cfg.excludeMesh && cfg.excludeMesh.test(mesh.name ?? nd.name ?? '')) return;
    const remap = skinMap[nd.skin];
    for (const prim of mesh.primitives) {
      if ((prim.mode ?? 4) !== 4) continue;
      const base = pos.length / 3;
      const P = accessor(g, prim.attributes.POSITION);
      const N = prim.attributes.NORMAL !== undefined ? accessor(g, prim.attributes.NORMAL) : null;
      const UV = prim.attributes.TEXCOORD_0 !== undefined ? accessor(g, prim.attributes.TEXCOORD_0) : null;
      const C = prim.attributes.COLOR_0 !== undefined ? accessor(g, prim.attributes.COLOR_0) : null;
      const J = accessor(g, prim.attributes.JOINTS_0, true);
      const W = accessor(g, prim.attributes.WEIGHTS_0);
      const mat = prim.material !== undefined ? g.json.materials[prim.material] : {};
      const pbr = mat.pbrMetallicRoughness ?? {};
      const factor = pbr.baseColorFactor ?? [1, 1, 1, 1];
      const texInfo = pbr.baseColorTexture;
      let img = null;
      if (texInfo && cfg.bakeTexture && UV) {
        // A palette texture: read it into the vertex colours and ship no map.
        const src = g.json.textures[texInfo.index].source;
        if (!images.has(src)) images.set(src, decodeImage(g, src));
        img = images.get(src);
      } else if (texInfo) {
        const tex = g.json.textures[texInfo.index];
        if (texture === null) texture = tex.source;
        else if (texture !== tex.source && !cfg.allowSecondTexture) throw new Error(`${cfg.name}: more than one base colour texture`);
      }
      const tint = cfg.tint?.[mat.name] ?? null;
      for (let i = 0; i < P.count; i++) {
        pos.push(P.data[i * 3], P.data[i * 3 + 1], P.data[i * 3 + 2]);
        if (N) nrm.push(N.data[i * 3], N.data[i * 3 + 1], N.data[i * 3 + 2]);
        else nrm.push(0, 1, 0);
        if (UV) uv.push(UV.data[i * 2], UV.data[i * 2 + 1]);
        else uv.push(0, 0);
        let r = factor[0], gg = factor[1], b = factor[2];
        if (tint) [r, gg, b] = tint;
        if (img) {
          const t = texel(img, UV.data[i * 2], UV.data[i * 2 + 1]);
          r *= t[0]; gg *= t[1]; b *= t[2];
        }
        if (C) { r *= C.data[i * C.n]; gg *= C.data[i * C.n + 1]; b *= C.data[i * C.n + 2]; }
        col.push(r, gg, b);
        for (let c = 0; c < 4; c++) { ji.push(remap[J.data[i * 4 + c]] ?? 0); jw.push(W.data[i * 4 + c]); }
      }
      if (prim.indices !== undefined) {
        const I = accessor(g, prim.indices, true).data;
        for (let i = 0; i < I.length; i++) idx.push(base + I[i]);
      } else for (let i = 0; i < P.count; i++) idx.push(base + i);
    }
  });
  // Clips by role: the model's own, or another file's on the same skeleton (bound by joint name).
  let anims = (g.json.animations ?? []).map((a) => clipOf(g, a));
  if (cfg.clipsFrom) {
    const cg = readGltf(resolve(SRC, cfg.clipsFrom));
    const byName = new Map(g.json.nodes.map((nd, i) => [nd.name, i]));
    anims = (cg.json.animations ?? []).map((a) => {
      const clip = clipOf(cg, a);
      clip.tracks = clip.tracks.filter((t) => {
        const [node, prop] = t.name.split('.');
        const target = byName.get(cg.json.nodes[Number(node.slice(1))].name);
        if (target === undefined) return false;
        // Proportions differ between bodies: only the hips may move, the rest only turn.
        if (prop === 'position' && !(cfg.moveJoints ?? /^(Root|Hips|Body)$/).test(cg.json.nodes[Number(node.slice(1))].name)) return false;
        if (prop === 'scale') return false;
        t.name = `n${target}.${prop}`;
        return true;
      });
      return clip;
    });
  }
  if (!pos.length) throw new Error(`${cfg.name}: no skinned geometry`);
  if (cfg.zombify) zombify(col, cfg.zombify === true ? {} : cfg.zombify);
  return { g, root, objs, joints, IBM, pos, nrm, uv, col, ji, jw, idx, texture, anims, rigged: false };
}

/**
 * Living skin to dead: the survivors' skin tones in the kit's palette (sRGB bytes) become a grey-green, a lighter one for
 * fair skin and a darker for dark, so a turned survivor keeps their face, clothes and build.
 */
function zombify(col, o) {
  const skins = o.skins ?? [[191, 145, 100, 'light'], [174, 140, 104, 'light'], [123, 79, 42, 'dark']];
  const to = { light: o.light ?? [150, 160, 112], dark: o.dark ?? [104, 118, 82] };
  const lin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const srgb = (v) => Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255);
  for (let i = 0; i < col.length; i += 3) {
    const c = [srgb(col[i]), srgb(col[i + 1]), srgb(col[i + 2])];
    const hit = skins.find((s) => Math.abs(s[0] - c[0]) + Math.abs(s[1] - c[1]) + Math.abs(s[2] - c[2]) < 10);
    if (!hit) continue;
    const t = to[hit[3]];
    col[i] = lin(t[0]); col[i + 1] = lin(t[1]); col[i + 2] = lin(t[2]);
  }
}

function bake(cfg) {
  const src = cfg.rig ? autoRig(cfg, SRC) : loadSkin(cfg);
  const { g, root, objs, joints, IBM, pos, nrm, uv, col, ji, jw, idx, texture, anims } = src;
  const V = pos.length / 3;
  // Orientation: a rotation taking the model's forward to +Z and up to +Y (an auto-rig is built already turned).
  const fix = src.rigged ? new THREE.Matrix4() : new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...(cfg.rotate ?? [0, 0, 0])));

  // Skinning matrices of a pose: N * jointWorld * IBM (the mesh node's own transform is ignored for skins, per glTF).
  const skinMats = (out) => {
    root.updateMatrixWorld(true);
    for (let j = 0; j < joints.length; j++) out[j].multiplyMatrices(joints[j].matrixWorld, IBM[j]).premultiply(fix);
  };
  const mats = joints.map(() => new THREE.Matrix4());
  const _v = new THREE.Vector3();
  const _a = new THREE.Vector3();
  const skinned = (m) => {
    const out = new Float32Array(V * 3);
    for (let i = 0; i < V; i++) {
      _a.set(0, 0, 0);
      for (let c = 0; c < 4; c++) {
        const w = jw[i * 4 + c];
        if (!w) continue;
        _v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).applyMatrix4(m[ji[i * 4 + c]]);
        _a.addScaledVector(_v, w);
      }
      out.set([_a.x, _a.y, _a.z], i * 3);
    }
    return out;
  };

  const mixer = new THREE.AnimationMixer(root);
  const fps = cfg.fps ?? 30;
  const clips = {};
  const frames = [];
  const sampleAt = (clip, t) => {
    mixer.stopAllAction();
    mixer.uncacheRoot(root);
    // Reset to the rest pose first, so bones a clip does not animate hold still.
    rest.forEach((r, i) => { objs[i].position.copy(r.p); objs[i].quaternion.copy(r.q); objs[i].scale.copy(r.s); });
    if (clip) {
      const act = mixer.clipAction(clip);
      act.play();
      // A looping action wraps at its end: sample a held clip's last frame just short of it.
      mixer.setTime(Math.min(t, clip.duration - 1e-4));
    }
    skinMats(mats);
    return mats.map((m) => m.clone());
  };
  const rest = objs.map((o) => ({ p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() }));
  // An auto-rig's clips are already named by role.
  const roles = cfg.clips ?? Object.fromEntries(anims.map((a) => [a.name, { name: a.name, loop: a.loop !== false }]));
  for (const [role, spec] of Object.entries(roles)) {
    if (spec === undefined) continue;
    const { name, loop = true, speed = 1, from = 0, to } = typeof spec === 'string' ? { name: spec } : spec;
    // Exporters often prefix clips with the armature ("CharacterArmature|Walk"): either spelling matches.
    const clip = name === null ? null : anims.find((a) => a.name === name) ?? anims.find((a) => a.name.endsWith(`|${name}`));
    if (name !== null && !clip) throw new Error(`${cfg.name}: no clip "${name}" (has ${anims.map((a) => a.name).join(', ')})`);
    const t0 = from;
    const t1 = clip ? (to ?? clip.duration) : 0;
    const dur = Math.max(1 / fps, (t1 - t0) / speed);
    const n = clip ? Math.max(2, Math.round(dur * fps) + (loop ? 0 : 1)) : 1;
    clips[role] = { start: frames.length, frames: n, dur, loop };
    for (let f = 0; f < n; f++) {
      const t = t0 + (loop ? (f / n) : f / Math.max(1, n - 1)) * (t1 - t0);
      frames.push(sampleAt(clip, t));
    }
  }

  // Normalize from the reference pose (the idle's first frame): scale to the size asked for, feet on y = 0, centred.
  const refFrame = frames[clips[cfg.reference ?? 'idle'].start];
  const ref = skinned(refFrame);
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < V; i++) { _v.fromArray(ref, i * 3); min.min(_v); max.max(_v); }
  const size = max.clone().sub(min);
  const s = src.rigged ? 1 : cfg.height ? cfg.height / size.y : cfg.length ? cfg.length / size.z : 1;
  const norm = src.rigged ? new THREE.Matrix4() : new THREE.Matrix4().makeScale(s, s, s).premultiply(new THREE.Matrix4().makeTranslation(
    -(min.x + max.x) / 2 * s + (cfg.offset?.[0] ?? 0), -min.y * s + (cfg.offset?.[1] ?? 0), -(min.z + max.z) / 2 * s + (cfg.offset?.[2] ?? 0)));
  for (const fr of frames) for (const m of fr) m.premultiply(norm);

  // Parts: each joint belongs to the first part whose rule matches it or, failing that, its nearest matching ancestor.
  // A vertex carries the mask of its heaviest joint's part and every part above it (a lost thigh takes the shin too), and
  // folds to its own part's root joint when any of them is gone.
  const PARTS = cfg.partBits ?? {};
  const ruleOf = (o) => {
    const nm = o.userData.src ?? '';
    for (const [part, re] of Object.entries(cfg.parts ?? {})) if (PARTS[part] !== undefined && re.test(nm)) return part;
    return null;
  };
  const partOfJoint = joints.map((jt) => {
    let mask = 0;
    let root = null;
    for (let o = jt; o; o = o.parent) {
      const part = ruleOf(o);
      if (!part) continue;
      mask |= PARTS[part];
      // The root of a part is its topmost joint with the same rule.
      if (!root || ruleOf(root) === part) root = o;
    }
    return mask ? { mask, root } : null;
  });
  const partV = new Uint16Array(V);
  const pivot = new Float32Array(V * 3);
  // Bind-space position of each joint: the translation of its inverse bind matrix's inverse.
  const jointBind = joints.map((_, j) => new THREE.Vector3().setFromMatrixPosition(IBM[j].clone().invert()));
  for (let i = 0; i < V; i++) {
    let best = 0;
    for (let c = 1; c < 4; c++) if (jw[i * 4 + c] > jw[i * 4 + best]) best = c;
    const p = partOfJoint[ji[i * 4 + best]];
    if (!p) continue;
    partV[i] = p.mask;
    const rj = joints.indexOf(p.root);
    const b = jointBind[rj >= 0 ? rj : ji[i * 4 + best]];
    pivot.set([b.x, b.y, b.z], i * 3);
  }

  // Bounds in the final space, over every frame of every clip (for culling and hit boxes).
  const fmin = new THREE.Vector3(Infinity, Infinity, Infinity);
  const fmax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (let f = 0; f < frames.length; f += Math.max(1, Math.floor(frames.length / 40))) {
    const sk = skinned(frames[f]);
    for (let i = 0; i < V; i += 3) { _v.fromArray(sk, i * 3); fmin.min(_v); fmax.max(_v); }
  }

  // Pack.
  const B = joints.length;
  const anim = new Uint16Array(frames.length * B * 12);
  frames.forEach((fr, f) => fr.forEach((m, j) => {
    const e = m.elements; // column-major
    const o = (f * B + j) * 12;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) anim[o + r * 4 + c] = THREE.DataUtils.toHalfFloat(e[c * 4 + r]);
  }));
  const index = V > 65535 ? new Uint32Array(idx) : new Uint16Array(idx);
  const sections = [];
  const header = { v: 1, name: cfg.name, verts: V, bones: B, frames: frames.length, fps, clips, attrs: {}, bounds: [fmin.toArray(), fmax.toArray()],
    material: cfg.material ?? {}, texture: null };
  let off = 0;
  const add = (key, arr) => {
    header.attrs[key] = [off, arr.constructor.name, arr.length];
    sections.push(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
    off += arr.byteLength;
    const pad = (4 - (off % 4)) % 4;
    if (pad) { sections.push(Buffer.alloc(pad)); off += pad; }
  };
  add('position', new Float32Array(pos));
  add('normal', new Float32Array(nrm));
  if (texture !== null) add('uv', new Float32Array(uv));
  add('color', Uint8Array.from(col.map(b8)));
  add('skinIndex', Uint8Array.from(ji));
  add('skinWeight', Uint8Array.from(jw.map(b8)));
  add('part', partV);
  add('pivot', pivot);
  add('index', index);
  add('anim', anim);

  // Texture: extracted, resized and re-encoded as JPEG.
  if (texture !== null) {
    const img = g.json.images[texture];
    let bytes;
    if (img.bufferView !== undefined) {
      const bv = g.json.bufferViews[img.bufferView];
      const b = g.buffers[bv.buffer];
      bytes = b.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
    } else if (img.uri.startsWith('data:')) bytes = Buffer.from(img.uri.split(',')[1], 'base64');
    else bytes = readFileSync(resolve(g.dir, decodeURIComponent(img.uri)));
    const tmp = mkdtempSync(join(tmpdir(), 'bake-'));
    try {
      const inFile = join(tmp, 'in.' + ((img.mimeType ?? '').includes('png') || img.uri?.endsWith('.png') ? 'png' : 'jpg'));
      writeFileSync(inFile, bytes);
      const texName = `${cfg.name}.jpg`;
      const px = cfg.textureSize ?? 512;
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', inFile, '-vf', `scale=${px}:${px}:flags=lanczos`, '-q:v', '3', resolve(OUT, texName)]);
      header.texture = texName;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  let json = Buffer.from(JSON.stringify(header), 'utf8');
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(8);
  head.write('INMB', 0, 'latin1');
  head.writeUInt32LE(json.length, 4);
  const out = Buffer.concat([head, json, ...sections]);
  writeFileSync(resolve(OUT, `${cfg.name}.bin`), out);
  const tris = idx.length / 3;
  console.log(`${cfg.name}: ${V} verts, ${tris} tris, ${B} bones, ${frames.length} frames (${Object.keys(clips).join(' ')}), ${(out.length / 1024).toFixed(0)} KB, size ${size.toArray().map((v) => (v * s).toFixed(2)).join(' x ')} m`);
  return { file: `${cfg.name}.bin`, texture: header.texture, sha256: createHash('sha256').update(out).digest('hex') };
}


/**
 * A still model (no skeleton): every mesh node under its world transform, merged, colours from material factors and (with
 * `bakeTexture`) from the texture at each vertex, so it needs no map. Same file format, without bones or frames.
 */
function bakeStatic(cfg) {
  const g = readGltf(resolve(SRC, cfg.source));
  const { objs } = buildNodes(g);
  const fix = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...(cfg.rotate ?? [0, 0, 0])));
  const pos = [];
  const nrm = [];
  const col = [];
  const idx = [];
  const images = new Map();
  const _p = new THREE.Vector3();
  const _n = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  g.json.nodes.forEach((nd, ni) => {
    if (nd.mesh === undefined) return;
    const mesh = g.json.meshes[nd.mesh];
    if (cfg.excludeMesh && cfg.excludeMesh.test(mesh.name ?? nd.name ?? '')) return;
    const world = objs[ni].matrixWorld.clone().premultiply(fix);
    nm.getNormalMatrix(world);
    for (const prim of mesh.primitives) {
      if ((prim.mode ?? 4) !== 4) continue;
      const base = pos.length / 3;
      const P = accessor(g, prim.attributes.POSITION);
      const N = prim.attributes.NORMAL !== undefined ? accessor(g, prim.attributes.NORMAL) : null;
      const UV = prim.attributes.TEXCOORD_0 !== undefined ? accessor(g, prim.attributes.TEXCOORD_0) : null;
      const C = prim.attributes.COLOR_0 !== undefined ? accessor(g, prim.attributes.COLOR_0) : null;
      const mat = prim.material !== undefined ? g.json.materials[prim.material] : {};
      const pbr = mat.pbrMetallicRoughness ?? {};
      const factor = cfg.tint?.[mat.name] ?? pbr.baseColorFactor ?? [1, 1, 1, 1];
      let img = null;
      if (cfg.bakeTexture && pbr.baseColorTexture && UV) {
        const src = g.json.textures[pbr.baseColorTexture.index].source;
        if (!images.has(src)) images.set(src, decodeImage(g, src));
        img = images.get(src);
      }
      for (let i = 0; i < P.count; i++) {
        _p.fromArray(P.data, i * 3).applyMatrix4(world);
        pos.push(_p.x, _p.y, _p.z);
        if (N) _n.fromArray(N.data, i * 3).applyMatrix3(nm).normalize();
        else _n.set(0, 0, 0);
        nrm.push(_n.x, _n.y, _n.z);
        let [r, gg, b] = factor;
        if (img) {
          const t = texel(img, UV.data[i * 2], UV.data[i * 2 + 1]);
          r *= t[0]; gg *= t[1]; b *= t[2];
        }
        if (C) { r *= C.data[i * C.n]; gg *= C.data[i * C.n + 1]; b *= C.data[i * C.n + 2]; }
        col.push(r, gg, b);
      }
      if (prim.indices !== undefined) {
        const I = accessor(g, prim.indices, true).data;
        for (let i = 0; i < I.length; i++) idx.push(base + I[i]);
      } else for (let i = 0; i < P.count; i++) idx.push(base + i);
    }
  });
  const V = pos.length / 3;
  if (!V) throw new Error(`${cfg.name}: no geometry`);
  // Normals: smooth over shared positions where the source has none (or asks for it), so facets do not read as paper.
  if (cfg.smooth || nrm.every((v) => v === 0)) smoothNormals(pos, nrm, idx);
  // Size and place: length along +Z (or height), centred, resting on y = 0.
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < V; i++) for (let c = 0; c < 3; c++) { min[c] = Math.min(min[c], pos[i * 3 + c]); max[c] = Math.max(max[c], pos[i * 3 + c]); }
  const size = max.map((v, c) => v - min[c]);
  const s = cfg.height ? cfg.height / size[1] : cfg.width ? cfg.width / size[0] : cfg.length ? cfg.length / size[2] : 1;
  for (let i = 0; i < V; i++) {
    pos[i * 3] = (pos[i * 3] - (min[0] + max[0]) / 2) * s;
    pos[i * 3 + 1] = (pos[i * 3 + 1] - (cfg.centreY ? (min[1] + max[1]) / 2 : min[1])) * s;
    pos[i * 3 + 2] = (pos[i * 3 + 2] - (min[2] + max[2]) / 2) * s;
  }
  // Colours for a tinted kind: brightness only, scaled so the mean is `grey` (the instance colour gives the hue).
  if (cfg.grey) {
    let sum = 0;
    const L = [];
    for (let i = 0; i < V; i++) { const l = col[i * 3] * 0.2126 + col[i * 3 + 1] * 0.7152 + col[i * 3 + 2] * 0.0722; L.push(l); sum += l; }
    const k = cfg.grey / (sum / V || 1);
    for (let i = 0; i < V; i++) { const l = Math.min(1, Math.pow(L[i] * k, cfg.greyGamma ?? 1)); col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = l; }
  }
  let bounds = [[-size[0] * s / 2, 0, -size[2] * s / 2], [size[0] * s / 2, size[1] * s, size[2] * s / 2]];
  let extra = {};
  const files = [];
  if (cfg.wings) {
    // An insect whose wings the game flaps itself: the body keeps its largest piece; one wing (the right fore) becomes a
    // model of its own, laid flat from its hinge along +x and 1 long, and every wing's hinge, span and sweep go in the body's
    // header (`mounts`) so the game can hang four of them where the model had them.
    const w = splitWings(pos, nrm, col, idx, cfg.wings);
    pos.length = 0; pos.push(...w.body.pos);
    nrm.length = 0; nrm.push(...w.body.nrm);
    col.length = 0; col.push(...w.body.col);
    idx.length = 0; idx.push(...w.body.idx);
    extra = { mounts: w.mounts };
    const wv = w.wing.pos.length / 3;
    const wb = [[0, 0, Infinity], [1, 0, -Infinity]];
    for (let i = 0; i < wv; i++) { wb[0][2] = Math.min(wb[0][2], w.wing.pos[i * 3 + 2]); wb[1][2] = Math.max(wb[1][2], w.wing.pos[i * 3 + 2]); }
    const wh = { v: 1, name: cfg.wings.name, static: true, verts: wv, bones: 0, frames: 0, fps: 0, clips: {}, attrs: {}, bounds: wb, material: {}, texture: null };
    const wout = writeModel(wh, [['position', new Float32Array(w.wing.pos)], ['normal', new Float32Array(w.wing.nrm)], ['color', Uint8Array.from(w.wing.col.map(b8))], ['index', new Uint16Array(w.wing.idx)]]);
    writeFileSync(resolve(OUT, `${cfg.wings.name}.bin`), wout);
    console.log(`${cfg.wings.name}: wing, ${wv} verts, ${w.wing.idx.length / 3} tris, chord ${(wb[1][2] - wb[0][2]).toFixed(3)}`);
    files.push(`${cfg.wings.name}.bin`);
    const bb = [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]];
    for (let i = 0; i < pos.length / 3; i++) for (let c = 0; c < 3; c++) { bb[0][c] = Math.min(bb[0][c], pos[i * 3 + c]); bb[1][c] = Math.max(bb[1][c], pos[i * 3 + c]); }
    bounds = bb;
  }
  const NV = pos.length / 3;
  const index = NV > 65535 ? new Uint32Array(idx) : new Uint16Array(idx);
  const header = { v: 1, name: cfg.name, static: true, verts: NV, bones: 0, frames: 0, fps: 0, clips: {}, attrs: {},
    bounds, material: cfg.material ?? {}, texture: null, ...extra };
  const out = writeModel(header, [['position', new Float32Array(pos)], ['normal', new Float32Array(nrm)], ['color', Uint8Array.from(col.map(b8))], ['index', index]]);
  writeFileSync(resolve(OUT, `${cfg.name}.bin`), out);
  console.log(`${cfg.name}: still, ${NV} verts, ${idx.length / 3} tris, ${(out.length / 1024).toFixed(0)} KB, ${size.map((v) => (v * s).toFixed(3)).join(' x ')} m`);
  return { file: `${cfg.name}.bin`, files, texture: null };
}

/**
 * Split an insect into its body (the largest connected piece) and its wings (the rest), welded by position. Returns the
 * body, one wing laid flat (hinge at the origin, span along +x scaled to 1, its plane turned to xz) and the mounts: per
 * wing, its hinge, span (in body lengths), the yaw of its span from straight out (+ swept back) and its tilt up.
 */
function splitWings(pos, nrm, col, idx) {
  const V = pos.length / 3;
  const parent = [...Array(V).keys()];
  const find = (a) => (parent[a] === a ? a : (parent[a] = find(parent[a])));
  const unite = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  const seen = new Map();
  for (let i = 0; i < V; i++) {
    const k = `${pos[i * 3].toFixed(5)},${pos[i * 3 + 1].toFixed(5)},${pos[i * 3 + 2].toFixed(5)}`;
    if (seen.has(k)) unite(i, seen.get(k));
    else seen.set(k, i);
  }
  for (let t = 0; t < idx.length; t += 3) { unite(idx[t], idx[t + 1]); unite(idx[t], idx[t + 2]); }
  const groups = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    const r = find(idx[t]);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(idx[t], idx[t + 1], idx[t + 2]);
  }
  const parts = [...groups.values()].sort((a, b) => b.length - a.length);
  const take = (tri) => {
    const map = new Map();
    const o = { pos: [], nrm: [], col: [], idx: [] };
    for (const v of tri) {
      if (!map.has(v)) {
        map.set(v, map.size);
        o.pos.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
        o.nrm.push(nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]);
        o.col.push(col[v * 3], col[v * 3 + 1], col[v * 3 + 2]);
      }
      o.idx.push(map.get(v));
    }
    return o;
  };
  const body = take(parts[0]);
  const wings = parts.slice(1).map(take);
  const P = (o, i) => new THREE.Vector3(o.pos[i * 3], o.pos[i * 3 + 1], o.pos[i * 3 + 2]);
  // Each wing's hinge: its vertex nearest the body's midline; its span: hinge to its farthest vertex.
  const info = wings.map((wg) => {
    const n = wg.pos.length / 3;
    let h = 0;
    for (let i = 1; i < n; i++) if (Math.abs(wg.pos[i * 3]) < Math.abs(wg.pos[h * 3])) h = i;
    const hinge = P(wg, h);
    let f = 0;
    for (let i = 1; i < n; i++) if (P(wg, i).distanceTo(hinge) > P(wg, f).distanceTo(hinge)) f = i;
    const span = P(wg, f).sub(hinge);
    return { wg, hinge, span };
  });
  const right = info.filter((w) => w.hinge.x + w.span.x * 0.5 > 0).sort((a, b) => b.hinge.z - a.hinge.z);
  const mounts = {};
  ['fore', 'hind'].forEach((k, i) => {
    const w = right[i];
    if (!w) return;
    const L = w.span.length();
    // Yaw back from straight out (+x), tilt up: what the game turns a flat +x wing by to lay it where this one was.
    mounts[k] = [w.hinge.x, w.hinge.y, w.hinge.z, L, Math.atan2(-w.span.z, w.span.x), Math.atan2(w.span.y, Math.hypot(w.span.x, w.span.z))];
  });
  // The fore wing laid flat: span to +x, its plane (by its widest chord) to xz, hinge at the origin, 1 long.
  const fw = right[0];
  const xAxis = fw.span.clone().normalize();
  const n = fw.wg.pos.length / 3;
  let best = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const d = P(fw.wg, i).sub(fw.hinge);
    const perp = d.sub(xAxis.clone().multiplyScalar(d.dot(xAxis)));
    if (perp.length() > best.length()) best = perp;
  }
  const zAxis = best.normalize();
  if (zAxis.z > 0) zAxis.negate(); // the chord reaches back (-z) from the leading edge
  const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
  const L = fw.span.length();
  const wing = { pos: [], nrm: [], col: fw.wg.col.slice(), idx: fw.wg.idx.slice() };
  for (let i = 0; i < n; i++) {
    const d = P(fw.wg, i).sub(fw.hinge);
    wing.pos.push(d.dot(xAxis) / L, 0, -d.dot(zAxis) / L);
    wing.nrm.push(0, 1, 0);
  }
  void yAxis;
  return { body, wing, mounts };
}

/** The container: magic, header length, header JSON, then 4-aligned sections listed in `header.attrs`. */
function writeModel(header, sections) {
  const parts = [];
  let off = 0;
  for (const [key, arr] of sections) {
    header.attrs[key] = [off, arr.constructor.name, arr.length];
    parts.push(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
    off += arr.byteLength;
    const pad = (4 - (off % 4)) % 4;
    if (pad) { parts.push(Buffer.alloc(pad)); off += pad; }
  }
  let json = Buffer.from(JSON.stringify(header), 'utf8');
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(8);
  head.write('INMB', 0, 'latin1');
  head.writeUInt32LE(json.length, 4);
  return Buffer.concat([head, json, ...parts]);
}

/** An animation bank only (no mesh): clips retargeted onto a body the game builds itself (`retarget.mjs`). */
function bakeRetarget(cfg) {
  const { frames, clips, fps } = retarget(cfg.retarget, SRC);
  const B = ZOMBIE_BONES.length;
  const anim = new Uint16Array(frames.length * B * 12);
  frames.forEach((fr, f) => fr.forEach((m, j) => {
    const e = m.elements;
    const o = (f * B + j) * 12;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) anim[o + r * 4 + c] = THREE.DataUtils.toHalfFloat(e[c * 4 + r]);
  }));
  const header = { v: 1, name: cfg.name, verts: 0, bones: B, frames: frames.length, fps, clips, attrs: {}, bounds: [[0, 0, 0], [0, 0, 0]],
    material: {}, texture: null, boneNames: ZOMBIE_BONES, joints: ZOMBIE_JOINTS };
  const out = writeModel(header, [['anim', anim]]);
  writeFileSync(resolve(OUT, `${cfg.name}.bin`), out);
  console.log(`${cfg.name}: animation bank, ${B} bones, ${frames.length} frames (${Object.keys(clips).join(' ')}), ${(out.length / 1024).toFixed(0)} KB`);
  return { file: `${cfg.name}.bin`, texture: null };
}

const only = process.argv.slice(2);
const results = [];
for (const cfg of MODELS) {
  if (only.length && !only.includes(cfg.name)) continue;
  if (cfg.source && !existsSync(resolve(SRC, cfg.source))) {
    console.warn(`${cfg.name}: source ${cfg.source} missing, skipped`);
    continue;
  }
  results.push({ cfg, ...(cfg.static ? bakeStatic(cfg) : cfg.retarget ? bakeRetarget(cfg) : bake(cfg)) });
}

/** What was done to a source, for the credits. */
function editOf(cfg) {
  if (cfg.credit.edit) return cfg.credit.edit;
  const recolour = cfg.grey ? '; reduced to brightness for in-game tinting' : cfg.tint || cfg.colorize || cfg.tintAll ? '; recoloured' : '';
  if (cfg.static) return `Mesh merged, reoriented and scaled to 1 m; palette colours baked into vertex colours${cfg.grey ? ' and reduced to brightness for in-game tinting' : ''}`;
  if (cfg.rig) return `Mesh reoriented and scaled; palette colours baked into vertex colours${recolour}; auto-rigged (${cfg.rig.type}) with generated animation clips, baked to bone matrices`;
  return `Skinned meshes merged, reoriented and scaled; palette colours baked into vertex colours${recolour}; animation clips resampled to baked bone matrices`;
}

// The inventory: every shipped file with its source, author, licence and checksum.
const invFile = resolve(OUT, 'sources.json');
const inv = existsSync(invFile) ? JSON.parse(readFileSync(invFile, 'utf8')) : [];
for (const r of results) {
  for (const f of [r.file, ...(r.files ?? []), r.texture].filter(Boolean)) {
    const entry = { file: f, model: r.cfg.name, title: r.cfg.credit.title, author: r.cfg.credit.author, license: r.cfg.credit.license,
      source: r.cfg.credit.source, original: r.cfg.source ?? Object.values(r.cfg.retarget?.sources ?? {}).map((x) => (typeof x === 'string' ? x : x.file)).join(', '),
      edit: editOf(r.cfg), ...(r.cfg.alsoCredits ? { also: r.cfg.alsoCredits } : {}),
      sha256: createHash('sha256').update(readFileSync(resolve(OUT, f))).digest('hex') };
    const i = inv.findIndex((e) => e.file === f);
    if (i >= 0) inv[i] = entry;
    else inv.push(entry);
  }
}
inv.sort((a, b) => a.file.localeCompare(b.file));
writeFileSync(invFile, JSON.stringify(inv, null, 2) + '\n');

// Credits: every source once (a bank's further sources too), the attribution CC BY needs first.
const LICENSE_URL = {
  'CC0-1.0': 'https://creativecommons.org/publicdomain/zero/1.0/', 'CC-BY-3.0': 'https://creativecommons.org/licenses/by/3.0/',
  'CC-BY-4.0': 'https://creativecommons.org/licenses/by/4.0/', 'CMU-mocap': 'http://mocap.cs.cmu.edu/faqs.php',
};
const bySource = new Map();
for (const e of inv) {
  for (const c of [e, ...(e.also ?? [])]) if (!bySource.has(c.source)) bySource.set(c.source, { ...c, model: e.model });
}
const usedFor = (src) => [...new Set(inv.filter((x) => x.source === src || x.also?.some((a) => a.source === src)).map((x) => x.model))].join(', ');
const credit = (e) => `"${e.title}" by ${e.author}, ${e.source} (${e.license}, ${LICENSE_URL[e.license] ?? ''}). Changes: ${e.edit}.${e.note ? ` ${e.note}` : ''} Used for: ${usedFor(e.source)}.`;
const lines = [
  'IRON NOMAD — MODEL AND ANIMATION CREDITS',
  '',
  'Rigged and animated models baked for the game by scripts/bake-models.mjs. Keep this file with distributions.',
  'The file-by-file source, licence, edits and SHA-256 inventory is in sources.json.',
  '',
  'Required attribution (Creative Commons Attribution 3.0 Unported / 4.0 International, no endorsement implied):',
  ...[...bySource.values()].filter((e) => e.license === 'CC-BY-3.0' || e.license === 'CC-BY-4.0').map(credit),
  '',
  'Motion capture (free for all uses; acknowledgement requested):',
  ...[...bySource.values()].filter((e) => e.license === 'CMU-mocap').map(credit),
  '',
  'Public domain (CC0 1.0; credit appreciated, not required):',
  ...[...bySource.values()].filter((e) => e.license === 'CC0-1.0').map(credit),
  '',
];
writeFileSync(resolve(OUT, 'CREDITS.txt'), lines.join('\n'));
