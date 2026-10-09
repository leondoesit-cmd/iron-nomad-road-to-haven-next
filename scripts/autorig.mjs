// Rig a still model and animate it: for species with no free animated model (camel, bear, boar, ibex, hare, the wading
// and perching birds, and a flying-pose bird per plumage). The mesh is read as it stands (facing +Z after `rotate`, scaled
// to `height` or `length`, feet on y = 0), its legs, neck, head, tail and wings are found from its shape, a skeleton is
// placed through them and every vertex is weighted to the bones of the region it lies in, with soft blends across the
// joints. The clips are made procedurally on that skeleton: walk, run (gallop or bound), idle, graze, attack, rear, lie
// down and die for four legs; walk, feed and swim for birds on the ground; flap and glide for birds in the air. They are
// then baked like any other model's clips (`bake-models.mjs`).
import * as THREE from 'three';
import { dirname, resolve } from 'node:path';
import { accessor, buildNodes, decodeImage, readGltf, smoothNormals, texel } from './gltf-read.mjs';
import { composeFlight } from './flightPose.mjs';

const sstep = (a, b, v) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * The still mesh under its node transforms, turned, scaled and placed; colours from factors and palette textures. With
 * `cfg.flight` a standing bird is first posed for the air and given a flyer's wings (`flightPose.mjs`).
 */
function loadStill(file, cfg) {
  let { pos, nrm, col, idx } = readStill(file, cfg);
  if (cfg.flight) {
    const wings = readStill(resolve(dirname(file), cfg.flight.wings), { rotate: cfg.flight.wingsRotate });
    ({ pos, nrm, col, idx } = composeFlight({ pos, nrm, col, idx }, wings, cfg.flight));
  }
  return placeStill({ pos, nrm, col, idx }, cfg);
}

/** A still mesh as it is in its file, turned by `cfg.rotate`, its colours baked in. */
function readStill(file, cfg) {
  const g = readGltf(file);
  const { objs } = buildNodes(g);
  const rot = cfg.rotate ?? [0, 0, 0];
  const fix = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], rot[3] ?? 'XYZ'));
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
      const mat = prim.material !== undefined ? g.json.materials[prim.material] : {};
      const pbr = mat.pbrMetallicRoughness ?? {};
      const factor = cfg.tint?.[mat.name] ?? pbr.baseColorFactor ?? [1, 1, 1, 1];
      let img = null;
      if (pbr.baseColorTexture && UV) {
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
        let [r, gg, b] = cfg.tintAll ?? factor;
        if (img && !cfg.tintAll) {
          const t = texel(img, UV.data[i * 2], UV.data[i * 2 + 1]);
          r *= t[0]; gg *= t[1]; b *= t[2];
        }
        col.push(r, gg, b);
      }
      if (prim.indices !== undefined) {
        const I = accessor(g, prim.indices, true).data;
        for (let i = 0; i < I.length; i++) idx.push(base + I[i]);
      } else for (let i = 0; i < P.count; i++) idx.push(base + i);
    }
  });
  if (cfg.smooth || nrm.every((v) => v === 0)) smoothNormals(pos, nrm, idx);
  return { pos, nrm, col, idx };
}

/** Recolour (`colorize`, `grey`), scale to `height`, `width` or `length`, centre and stand on y = 0. */
function placeStill({ pos, nrm, col, idx }, cfg) {
  // A new coat: every colour keeps its brightness but takes this hue, except the darkest (horns, hooves, eyes).
  if (cfg.colorize) {
    const t = cfg.colorize.color;
    const tl = t[0] * 0.2126 + t[1] * 0.7152 + t[2] * 0.0722;
    for (let i = 0; i < col.length; i += 3) {
      const l = col[i] * 0.2126 + col[i + 1] * 0.7152 + col[i + 2] * 0.0722;
      if (l < (cfg.colorize.keepBelow ?? 0.012)) continue;
      const k = (l / tl) * (cfg.colorize.gain ?? 1);
      col[i] = t[0] * k; col[i + 1] = t[1] * k; col[i + 2] = t[2] * k;
    }
  }
  const V = pos.length / 3;
  // Brightness only, its mean at `grey`: a kind the game tints per species (small birds), the pattern showing through.
  if (cfg.grey) {
    let sum = 0;
    const L = [];
    for (let i = 0; i < V; i++) { const l = col[i * 3] * 0.2126 + col[i * 3 + 1] * 0.7152 + col[i * 3 + 2] * 0.0722; L.push(l); sum += l; }
    const k = cfg.grey / (sum / V || 1);
    for (let i = 0; i < V; i++) { const l = Math.min(1, L[i] * k); col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = l; }
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < V; i++) for (let c = 0; c < 3; c++) { min[c] = Math.min(min[c], pos[i * 3 + c]); max[c] = Math.max(max[c], pos[i * 3 + c]); }
  const size = max.map((v, c) => v - min[c]);
  const s = cfg.height ? cfg.height / size[1] : cfg.width ? cfg.width / size[0] : cfg.length ? cfg.length / size[2] : 1;
  for (let i = 0; i < V; i++) {
    pos[i * 3] = (pos[i * 3] - (min[0] + max[0]) / 2) * s;
    pos[i * 3 + 1] = (pos[i * 3 + 1] - min[1]) * s;
    pos[i * 3 + 2] = (pos[i * 3 + 2] - (min[2] + max[2]) / 2) * s;
  }
  return { pos, nrm, col, idx };
}

/** Points scattered over the surface (area-weighted), so sparse low-poly meshes still show where their volume is. */
function surfacePoints(pos, idx, n = 24000) {
  const tris = idx.length / 3;
  const area = new Float64Array(tris);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let total = 0;
  for (let t = 0; t < tris; t++) {
    a.fromArray(pos, idx[t * 3] * 3); b.fromArray(pos, idx[t * 3 + 1] * 3); c.fromArray(pos, idx[t * 3 + 2] * 3);
    total += area[t] = b.clone().sub(a).cross(c.clone().sub(a)).length() / 2;
  }
  const pts = [];
  let seed = 12345;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let t = 0; t < tris; t++) {
    const k = Math.round((area[t] / total) * n + rnd() - 0.5);
    a.fromArray(pos, idx[t * 3] * 3); b.fromArray(pos, idx[t * 3 + 1] * 3); c.fromArray(pos, idx[t * 3 + 2] * 3);
    for (let i = 0; i < k; i++) {
      let u = rnd(), v = rnd();
      if (u + v > 1) { u = 1 - u; v = 1 - v; }
      pts.push(a.clone().multiplyScalar(1 - u - v).addScaledVector(b, u).addScaledVector(c, v));
    }
  }
  return pts;
}

/** Height where the legs end and the body begins: the lowest slice whose points cover most of the body's length. */
function findBelly(pts, H, zmin, zmax) {
  const bins = 48;
  for (let s = 2; s < 40; s++) {
    const y0 = (s / 40) * H;
    const y1 = ((s + 1) / 40) * H;
    const occ = new Uint8Array(bins);
    for (const p of pts) if (p.y >= y0 && p.y < y1) occ[Math.min(bins - 1, Math.floor(((p.z - zmin) / (zmax - zmin)) * bins))] = 1;
    let n = 0;
    for (const o of occ) n += o;
    if (n / bins > 0.42) return y0;
  }
  return H * 0.4;
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);

/** Bones as a three hierarchy from {name, parent, at: [x,y,z] in model space}. */
function makeBones(list) {
  const map = new Map();
  const root = new THREE.Object3D();
  for (const b of list) {
    const o = new THREE.Bone();
    o.name = b.name;
    o.userData.src = b.name;
    o.userData.at = new THREE.Vector3(...b.at);
    const parent = b.parent ? map.get(b.parent) : root;
    o.position.copy(o.userData.at).sub(b.parent ? map.get(b.parent).userData.at : new THREE.Vector3());
    parent.add(o);
    map.set(b.name, o);
  }
  root.updateMatrixWorld(true);
  return { root, map };
}

/** Keep each vertex's four heaviest weights, normalized. */
function topFour(ws) {
  const e = Object.entries(ws).filter(([, w]) => w > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const s = e.reduce((x, [, w]) => x + w, 0) || 1;
  return e.map(([k, w]) => [k, w / s]);
}

// ------------------------------------------------------------------------------------------ four legs

function rigQuad(geo, cfg, R) {
  const { pos, idx } = geo;
  const V = pos.length / 3;
  const pts = surfacePoints(pos, idx);
  let H = 0, zmin = Infinity, zmax = -Infinity, xw = 0;
  for (const p of pts) { H = Math.max(H, p.y); zmin = Math.min(zmin, p.z); zmax = Math.max(zmax, p.z); xw = Math.max(xw, Math.abs(p.x)); }
  const L = zmax - zmin;
  const belly = R.belly !== undefined ? R.belly * H : findBelly(pts, H, zmin, zmax);
  // Legs: the points below the belly, split left/right by x and front/back at the widest gap in z.
  const legPts = pts.filter((p) => p.y < belly * 0.85);
  const zs = legPts.map((p) => p.z).sort((a, b) => a - b);
  let split = (zmin + zmax) / 2, gap = -1;
  for (let i = Math.floor(zs.length * 0.1); i < Math.floor(zs.length * 0.9); i++) {
    const d = zs[i + 1] - zs[i];
    if (d > gap) { gap = d; split = (zs[i] + zs[i + 1]) / 2; }
  }
  if (R.split !== undefined) split = zmin + R.split * L;
  const legs = {};
  for (const [name, sx, front] of [['LF', 1, true], ['RF', -1, true], ['LB', 1, false], ['RB', -1, false]]) {
    const own = legPts.filter((p) => Math.sign(p.x || 1) === sx && (p.z > split) === front);
    const mid = own.filter((p) => p.y > belly * 0.3 && p.y < belly * 0.6);
    const use = mid.length > 10 ? mid : own;
    const cx = mean(use.map((p) => p.x));
    const cz = mean(use.map((p) => p.z));
    const rad = Math.max(0.02 * H, ...use.map((p) => Math.hypot(p.x - cx, p.z - cz)).sort((a, b) => a - b).slice(0, Math.max(1, Math.floor(use.length * 0.9))));
    // The leg's line, slice by slice: legs slant and hocks bend, so one vertical axis would miss the feet.
    const prof = [];
    for (let k = 0; k < 8; k++) {
      const y0 = (k / 8) * belly * 0.85, y1 = ((k + 1) / 8) * belly * 0.85;
      const sl = own.filter((p) => p.y >= y0 && p.y < y1);
      prof.push(sl.length > 3 ? [mean(sl.map((p) => p.x)), mean(sl.map((p) => p.z))] : null);
    }
    for (let k = 0; k < 8; k++) if (!prof[k]) prof[k] = prof.slice(k).find(Boolean) ?? prof.slice(0, k).reverse().find(Boolean) ?? [cx, cz];
    const at = (y) => {
      const f = Math.min(7, Math.max(0, (y / (belly * 0.85)) * 8 - 0.5));
      const k = Math.floor(f), t = f - k, n = Math.min(7, k + 1);
      return [prof[k][0] * (1 - t) + prof[n][0] * t, prof[k][1] * (1 - t) + prof[n][1] * t];
    };
    legs[name] = { cx, cz, rad, sx, front, at };
  }
  const top = belly + (R.joint ?? 0.12) * (H - belly);
  const hipZ = (legs.LB.cz + legs.RB.cz) / 2;
  const chestZ = (legs.LF.cz + legs.RF.cz) / 2;
  // Head: the front-most points; the neck runs from above the shoulders to it.
  const headPts = pts.filter((p) => p.z > zmax - (R.headLen ?? 0.13) * L && p.y > belly);
  const hc = new THREE.Vector3(mean(headPts.map((p) => p.x)), mean(headPts.map((p) => p.y)), mean(headPts.map((p) => p.z)));
  const shoulderTop = Math.max(...pts.filter((p) => Math.abs(p.z - chestZ) < 0.05 * L).map((p) => p.y));
  const nb = new THREE.Vector3(0, top + (shoulderTop - top) * 0.55, chestZ + (R.neckAhead ?? 0.25) * (zmax - chestZ) * 0.5);
  const neckDir = hc.clone().sub(nb);
  const neckLen = neckDir.length();
  neckDir.normalize();
  const along = (p) => p.clone().sub(nb).dot(neckDir) / neckLen;
  const n2 = nb.clone().addScaledVector(neckDir, neckLen * 0.45);
  const hp = nb.clone().addScaledVector(neckDir, neckLen * (R.headAt ?? 0.72));
  const tailZ = zmin + (R.tail ?? 0.07) * L;
  const tailY = mean(pts.filter((p) => p.z < tailZ && p.y > belly).map((p) => p.y)) || top;
  const bones = [
    { name: 'root', at: [0, 0, 0] },
    { name: 'pelvis', parent: 'root', at: [0, top, hipZ] },
    { name: 'chest', parent: 'pelvis', at: [0, top, chestZ] },
    { name: 'neck1', parent: 'chest', at: nb.toArray() },
    { name: 'neck2', parent: 'neck1', at: n2.toArray() },
    { name: 'head', parent: 'neck2', at: hp.toArray() },
    { name: 'tail', parent: 'pelvis', at: [0, tailY, tailZ + 0.03 * L] },
  ];
  const knee = (front) => belly * (front ? (R.kneeF ?? 0.42) : (R.kneeB ?? 0.5));
  for (const [n, l] of Object.entries(legs)) {
    const par = l.front ? 'chest' : 'pelvis';
    const hip = l.at(belly * 0.85);
    const kn = l.at(knee(l.front));
    bones.push({ name: `up${n}`, parent: par, at: [hip[0], top, hip[1]] });
    bones.push({ name: `lo${n}`, parent: `up${n}`, at: [kn[0], knee(l.front), kn[1]] });
  }
  const { root, map } = makeBones(bones);
  // Weights.
  const W = [];
  const _p = new THREE.Vector3();
  const blend = 0.06 * H;
  for (let i = 0; i < V; i++) {
    _p.fromArray(pos, i * 3);
    const t = sstep(hipZ, chestZ, _p.z);
    let ws = { pelvis: 1 - t, chest: t };
    // Neck and head.
    const s = along(_p);
    const frontish = _p.z > chestZ - 0.02 * L && _p.y > belly * 0.9;
    const nw = frontish ? sstep(-0.08, 0.1, s) : 0;
    if (nw > 0) {
      const hw = sstep((R.headAt ?? 0.72) - 0.07, (R.headAt ?? 0.72) + 0.05, s);
      const w2 = sstep(0.35, 0.55, s) * (1 - hw);
      const w1 = (1 - w2 - hw);
      ws = { pelvis: ws.pelvis * (1 - nw), chest: ws.chest * (1 - nw), neck1: w1 * nw, neck2: w2 * nw, head: hw * nw };
    }
    // Tail.
    const tw = _p.y > belly * 0.8 ? sstep(tailZ + 0.03 * L, tailZ - 0.02 * L, _p.z) : 0;
    if (tw > 0) for (const k of Object.keys(ws)) ws[k] *= 1 - tw;
    if (tw > 0) ws.tail = (ws.tail ?? 0) + tw;
    // Legs: below the body, near a leg's axis.
    let best = null, bd = Infinity;
    for (const [n, l] of Object.entries(legs)) {
      if (Math.sign(_p.x || l.sx) !== l.sx || (_p.z > split) !== l.front) continue;
      const c = l.at(Math.min(_p.y, belly * 0.85));
      const d = Math.hypot(_p.x - c[0], _p.z - c[1]) / l.rad;
      if (d < bd) { bd = d; best = n; }
    }
    // Well below the belly everything in a leg's quarter is that leg; near the belly only what is close to its line.
    const low = _p.y < belly * 0.7;
    if (best && (low || bd < (R.reach ?? 2.2))) {
      const lw = sstep(belly + blend, belly - blend * 0.5, _p.y) * (low ? 1 : sstep(R.reach ?? 2.2, (R.reach ?? 2.2) * 0.6, bd));
      if (lw > 0) {
        const k = knee(legs[best].front);
        const lo = sstep(k + 0.04 * H, k - 0.04 * H, _p.y);
        for (const key of Object.keys(ws)) ws[key] *= 1 - lw;
        ws[`up${best}`] = (1 - lo) * lw;
        ws[`lo${best}`] = lo * lw;
      }
    }
    W.push(topFour(ws));
  }
  const dims = { H, L, belly, top, halfW: xw, hipZ, chestZ };
  return { root, map, W, clips: quadClips(map, dims, R), dims };
}

/** A clip from a pose function sampled at `fps`: pose(t) gives { bone: [rx, ry, rz] } plus optional `root: [x, y, z]`. */
function poseClip(name, map, dur, loop, pose, fps = 30) {
  const n = loop ? Math.max(2, Math.round(dur * fps)) : Math.max(2, Math.round(dur * fps) + 1);
  const times = [];
  const rot = new Map();
  const rootPos = [];
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();
  for (let f = 0; f <= n; f++) {
    // Looping clips repeat their first key at the end so the track wraps cleanly.
    const t = loop ? (f / n) * dur : Math.min(dur, (f / Math.max(1, n - 1)) * dur);
    if (!loop && f === n) break;
    times.push(t);
    const p = pose(loop ? (f % n) / n : t / dur);
    for (const [bone, b] of map) {
      if (bone === 'root') continue;
      const r = p[bone] ?? [0, 0, 0];
      _e.set(r[0], r[1], r[2], 'YXZ');
      _q.setFromEuler(_e);
      if (!rot.has(bone)) rot.set(bone, []);
      rot.get(bone).push(_q.x, _q.y, _q.z, _q.w);
    }
    const rp = p.root ?? [0, 0, 0];
    rootPos.push(rp[0], rp[1], rp[2]);
  }
  const tracks = [];
  for (const [bone, vals] of rot) tracks.push(new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, times, vals));
  tracks.push(new THREE.VectorKeyframeTrack('root.position', times, rootPos));
  const clip = new THREE.AnimationClip(name, dur, tracks);
  clip.loop = loop;
  return clip;
}

const TAU = Math.PI * 2;

function quadClips(map, d, R) {
  const legsOf = ['LF', 'RF', 'LB', 'RB'];
  const amp = R.stride ?? 0.38;
  const walkT = R.walkT ?? 1.1;
  const runT = R.runT ?? 0.55;
  const clips = [];
  const walkPhase = { LB: 0, LF: 0.25, RB: 0.5, RF: 0.75 };
  const gallopPhase = R.gait === 'bound' ? { LB: 0, RB: 0.03, LF: 0.5, RF: 0.53 } : { LB: 0, RB: 0.1, LF: 0.5, RF: 0.6 };
  const legPose = (o, ph, A, flex, lift = 0) => {
    for (const n of legsOf) {
      const q = (ph + o.phases[n]) * TAU;
      const front = n.endsWith('F');
      o[`up${n}`] = [-A * (front ? 1 : 1.05) * Math.sin(q), 0, 0];
      // The knee bends while the foot swings forward (cos > 0 while the upper leg moves forward).
      o[`lo${n}`] = [flex * Math.max(0, Math.cos(q)) + lift, 0, 0];
    }
  };
  clips.push(poseClip('idle', map, 4, true, (u) => {
    const p = u * TAU;
    return { neck1: [0.03 * Math.sin(p), 0.12 * Math.sin(p * 1), 0], head: [0.04 * Math.sin(p * 2), 0.1 * Math.sin(p), 0], tail: [0, 0.25 * Math.sin(p * 3), 0], chest: [0, 0, 0.01 * Math.sin(p * 2)] };
  }));
  clips.push(poseClip('walk', map, walkT, true, (u) => {
    const o = { phases: walkPhase };
    legPose(o, u, amp, amp * 1.4);
    const p = u * TAU;
    o.root = [0, d.H * 0.012 * (1 - Math.cos(p * 2)) * 0.5, 0];
    o.chest = [0, 0.03 * Math.sin(p), 0.02 * Math.sin(p)];
    o.neck1 = [0.05 * Math.sin(p * 2), 0, 0];
    o.head = [-0.04 * Math.sin(p * 2), 0, 0];
    o.tail = [0, 0.15 * Math.sin(p), 0];
    delete o.phases;
    return o;
  }));
  clips.push(poseClip('run', map, runT, true, (u) => {
    const o = { phases: gallopPhase };
    legPose(o, u, amp * (R.runAmp ?? 1.5), amp * (R.runFlex ?? 2.0));
    const p = u * TAU;
    const flexS = R.gait === 'bound' ? 0.25 : 0.12;
    o.root = [0, d.H * (R.gait === 'bound' ? 0.12 : 0.05) * (0.5 + 0.5 * Math.sin(p + 0.6)), 0];
    o.pelvis = [flexS * Math.sin(p), 0, 0];
    o.chest = [-flexS * 1.6 * Math.sin(p), 0, 0];
    o.neck1 = [0.12 * Math.sin(p + Math.PI), 0, 0];
    o.tail = [-0.2 + 0.15 * Math.sin(p), 0, 0];
    delete o.phases;
    return o;
  }));
  const graze = R.graze ?? 1.15;
  clips.push(poseClip('eat', map, 3, true, (u) => {
    const p = u * TAU;
    return { neck1: [graze * 0.7, 0.05 * Math.sin(p), 0], neck2: [graze * 0.25, 0, 0], head: [graze * 0.1 + 0.06 * Math.sin(p * 6), 0, 0], upLF: [-0.06, 0, 0], upRF: [0.04, 0, 0], tail: [0, 0.2 * Math.sin(p * 2), 0] };
  }));
  clips.push(poseClip('attack', map, 0.7, false, (u) => {
    const k = Math.sin(Math.min(1, u * 1.6) * Math.PI);
    const butt = R.attack === 'butt';
    return { root: [0, 0, d.L * 0.12 * k], chest: [0.1 * k, 0, 0], neck1: [(butt ? 0.7 : -0.25) * k, 0, 0], head: [(butt ? 0.3 : 0.35) * k, 0, 0], upLF: [-0.5 * k, 0, 0], upRF: [-0.4 * k, 0, 0], upLB: [0.25 * k, 0, 0], upRB: [0.3 * k, 0, 0] };
  }));
  // Up on the hind legs (a bear standing to look or swipe): the body pivots about the hips, the hind legs stay planted.
  clips.push(poseClip('rear', map, 1, true, (u) => {
    const p = u * TAU;
    const up = R.rear ?? 1.05;
    return { pelvis: [-up, 0, 0], upLB: [up - 0.1, 0, 0], upRB: [up - 0.1, 0, 0], loLB: [-0.25, 0, 0], loRB: [-0.25, 0, 0], upLF: [-0.2 + 0.15 * Math.sin(p), 0, 0.15], upRF: [-0.2 - 0.15 * Math.sin(p), 0, -0.15], loLF: [0.7, 0, 0], loRF: [0.7, 0, 0], neck1: [up * 0.55, 0.15 * Math.sin(p), 0], head: [up * 0.25, 0, 0], root: [0, d.belly * 0.08, 0] };
  }));
  // Bedded down on the brisket: forelegs folded back under the chest, hind legs tucked forward under the belly.
  clips.push(poseClip('lie', map, 4, true, (u) => {
    const p = u * TAU;
    const drop = d.belly * (R.lieDrop ?? 0.9);
    return { root: [0, -drop, 0], upLF: [1.35, 0, 0], upRF: [1.35, 0, 0], loLF: [-2.4, 0, 0], loRF: [-2.4, 0, 0], upLB: [-1.25, 0, 0.1], upRB: [-1.25, 0, -0.1], loLB: [2.3, 0, 0], loRB: [2.3, 0, 0], neck1: [-0.1 + 0.03 * Math.sin(p), 0.1 * Math.sin(p * 0.5), 0], tail: [0.3, 0, 0] };
  }));
  // Down on its side, legs stiff (and a take falling to the other side, legs kicking as it goes).
  clips.push(poseClip('death', map, 1, false, (u) => {
    const k = sstep(0, 0.75, u);
    const side = d.halfW * 0.8;
    return { root: [0, side * k + d.H * 0.05 * Math.sin(u * Math.PI), 0], pelvis: [0, 0, (Math.PI / 2) * 0.95 * k], upLF: [-0.3 * k, 0, 0.1 * k], upRF: [-0.2 * k, 0, -0.1 * k], upLB: [0.25 * k, 0, 0], upRB: [0.35 * k, 0, 0], neck1: [-0.3 * k, 0, 0.1 * k], head: [-0.2 * k, 0, 0] };
  }));
  clips.push(poseClip('death.1', map, 1.3, false, (u) => {
    const k = sstep(0.1, 0.8, u);
    const kick = Math.sin(Math.min(1, u * 1.6) * Math.PI * 3) * (1 - k) * 0.2;
    const side = d.halfW * 0.8;
    return { root: [0, side * k, 0], pelvis: [0.15 * (1 - k), 0, -(Math.PI / 2) * 0.95 * k], upLF: [-0.45 * k + kick, 0, -0.1 * k], upRF: [-0.15 * k - kick, 0, 0.1 * k], upLB: [0.4 * k - kick, 0, 0], upRB: [0.15 * k + kick, 0, 0], loLF: [0.3 * k, 0, 0], neck1: [0.4 * k, 0, -0.2 * k], head: [0.3 * k, 0, 0] };
  }));
  // More ways of standing about: a slow look round, and a nose down to the ground for a scent, its tail going.
  clips.push(poseClip('idle.1', map, 6, true, (u) => {
    const p = u * TAU;
    const look = Math.sin(p) * 0.6;
    return { neck1: [0.05 + 0.05 * Math.sin(p * 2), look * 0.55, 0], neck2: [0, look * 0.3, 0], head: [-0.05, look * 0.35, 0.05 * Math.sin(p)], tail: [0, 0.15 * Math.sin(p * 4), 0] };
  }));
  clips.push(poseClip('idle.2', map, 5, true, (u) => {
    const p = u * TAU;
    const down = 0.5 + 0.5 * Math.sin(p - Math.PI / 2);
    return { neck1: [graze * 0.45 * down, 0.15 * Math.sin(p * 0.5), 0], head: [graze * 0.15 * down + 0.05 * Math.sin(p * 9) * down, 0, 0], tail: [0, 0.3 * Math.sin(p * 3), 0], upLF: [-0.05 * down, 0, 0] };
  }));
  // A flinch from a hit: jerked away from its side (`hit` from its left, `hit.1` from its right) and back.
  for (const [name, s] of [['hit', 1], ['hit.1', -1]]) {
    clips.push(poseClip(name, map, 0.6, false, (u) => {
      const k = Math.sin(Math.min(1, u * 1.4) * Math.PI);
      return { root: [-s * d.halfW * 0.25 * k, 0, 0], pelvis: [0, 0, -s * 0.12 * k], chest: [0.06 * k, s * 0.15 * k, -s * 0.15 * k], neck1: [-0.2 * k, -s * 0.35 * k, 0], head: [-0.15 * k, 0, -s * 0.1 * k], tail: [0.3 * k, 0, 0], upLF: [0.2 * k, 0, s * 0.1 * k], upRF: [0.2 * k, 0, s * 0.1 * k] };
    }));
  }
  return clips;
}

// ------------------------------------------------------------------------------------------ birds on the ground

function rigBird(geo, cfg, R) {
  const { pos, idx } = geo;
  const V = pos.length / 3;
  const pts = surfacePoints(pos, idx);
  let H = 0, zmin = Infinity, zmax = -Infinity, xw = 0;
  for (const p of pts) { H = Math.max(H, p.y); zmin = Math.min(zmin, p.z); zmax = Math.max(zmax, p.z); xw = Math.max(xw, Math.abs(p.x)); }
  const L = zmax - zmin;
  const belly = (R.belly ?? 0.3) * H;
  const legPts = pts.filter((p) => p.y < belly * 0.9);
  const legs = {};
  for (const [name, sx] of [['L', 1], ['R', -1]]) {
    // The leg proper: what is below the belly and near the middle (wing and tail tips can hang lower, further out back).
    const all = legPts.filter((p) => Math.sign(p.x || 1) === sx);
    const zc = mean(all.filter((p) => p.y < belly * 0.4).map((p) => p.z));
    const own = all.filter((p) => Math.abs(p.z - zc) < 0.2 * L || p.y < belly * 0.4);
    const cx = mean(own.map((p) => p.x)) || sx * 0.05 * L;
    const cz = mean(own.map((p) => p.z)) || 0;
    const prof = [];
    for (let k = 0; k < 6; k++) {
      const y0 = (k / 6) * belly, y1 = ((k + 1) / 6) * belly;
      const sl = own.filter((p) => p.y >= y0 && p.y < y1);
      prof.push(sl.length > 2 ? [mean(sl.map((p) => p.x)), mean(sl.map((p) => p.z))] : null);
    }
    for (let k = 0; k < 6; k++) if (!prof[k]) prof[k] = prof.slice(k).find(Boolean) ?? prof.slice(0, k).reverse().find(Boolean) ?? [cx, cz];
    const at = (y) => {
      const f = Math.min(5, Math.max(0, (y / belly) * 6 - 0.5));
      const k = Math.floor(f), t = f - k, n = Math.min(5, k + 1);
      return [prof[k][0] * (1 - t) + prof[n][0] * t, prof[k][1] * (1 - t) + prof[n][1] * t];
    };
    const rad = Math.max(0.012 * H, ...own.filter((p) => p.y > belly * 0.2 && p.y < belly * 0.8).map((p) => { const c = at(p.y); return Math.hypot(p.x - c[0], p.z - c[1]); }).sort((a, b) => a - b).slice(0, Math.max(1, Math.floor(own.length * 0.85))));
    legs[name] = { cx, cz, rad, sx, at };
  }
  const hipZ = (legs.L.cz + legs.R.cz) / 2;
  const top = belly + 0.25 * (H - belly) * (R.hipUp ?? 1);
  // Head: the top-front points; for a long neck the neck chain follows them.
  const headPts = pts.filter((p) => p.z > zmax - (R.headLen ?? 0.25) * L && p.y > H * (R.headMin ?? 0.55));
  const hc = new THREE.Vector3(0, mean(headPts.map((p) => p.y)), mean(headPts.map((p) => p.z)));
  const nb = new THREE.Vector3(0, belly + (H - belly) * (R.neckBase ?? 0.35), hipZ + (R.neckAhead ?? 0.12) * L);
  const neckDir = hc.clone().sub(nb);
  const neckLen = neckDir.length();
  neckDir.normalize();
  const along = (p) => p.clone().sub(nb).dot(neckDir) / neckLen;
  const headAt = R.headAt ?? 0.75;
  const bones = [
    { name: 'root', at: [0, 0, 0] },
    { name: 'pelvis', parent: 'root', at: [0, top, hipZ] },
    { name: 'neck1', parent: 'pelvis', at: nb.toArray() },
    { name: 'neck2', parent: 'neck1', at: nb.clone().addScaledVector(neckDir, neckLen * 0.45).toArray() },
    { name: 'head', parent: 'neck2', at: nb.clone().addScaledVector(neckDir, neckLen * headAt).toArray() },
    { name: 'tail', parent: 'pelvis', at: [0, top, zmin + 0.25 * L] },
  ];
  const knee = belly * (R.knee ?? 0.5);
  for (const [n, l] of Object.entries(legs)) {
    const hip = l.at(belly);
    const kn = l.at(knee);
    bones.push({ name: `up${n}`, parent: 'pelvis', at: [hip[0], belly * 1.02, hip[1]] });
    bones.push({ name: `lo${n}`, parent: `up${n}`, at: [kn[0], knee, kn[1]] });
  }
  const { root, map } = makeBones(bones);
  const W = [];
  const _p = new THREE.Vector3();
  for (let i = 0; i < V; i++) {
    _p.fromArray(pos, i * 3);
    let ws = { pelvis: 1 };
    const s = along(_p);
    const nw = _p.z > hipZ - 0.05 * L ? sstep(-0.05, 0.12, s) * sstep(belly, belly + 0.1 * H, _p.y) : 0;
    if (nw > 0) {
      const hw = sstep(headAt - 0.06, headAt + 0.05, s);
      const w2 = sstep(0.35, 0.55, s) * (1 - hw);
      ws = { pelvis: 1 - nw, neck1: (1 - w2 - hw) * nw, neck2: w2 * nw, head: hw * nw };
    }
    const tw = sstep(zmin + 0.3 * L, zmin + 0.15 * L, _p.z) * sstep(belly, belly + 0.1 * H, _p.y);
    if (tw > 0) { for (const k of Object.keys(ws)) ws[k] *= 1 - tw; ws.tail = (ws.tail ?? 0) + tw; }
    const side = Math.sign(_p.x || 1) > 0 ? 'L' : 'R';
    const l = legs[side];
    const c = l.at(Math.min(_p.y, belly));
    const d = Math.hypot(_p.x - c[0], _p.z - c[1]) / l.rad;
    // Feet splay wide, so the bottom slice is all leg; above it only what lies close to the leg's line.
    const lw = sstep(belly * 1.08, belly * 0.92, _p.y) * (_p.y < belly * 0.12 ? 1 : sstep(4, 2, d));
    if (lw > 0) {
      const lo = sstep(knee + 0.03 * H, knee - 0.03 * H, _p.y);
      for (const key of Object.keys(ws)) ws[key] *= 1 - lw;
      ws[`up${side}`] = (1 - lo) * lw;
      ws[`lo${side}`] = lo * lw;
    }
    W.push(topFour(ws));
  }
  const dims = { H, L, belly, top, halfW: xw };
  return { root, map, W, clips: birdClips(map, dims, R), dims };
}

function birdClips(map, d, R) {
  const clips = [];
  const stride = R.stride ?? 0.45;
  clips.push(poseClip('idle', map, 5, true, (u) => {
    const p = u * TAU;
    // A bird's head turns in small jerks, not a smooth sweep.
    const look = Math.round(Math.sin(p * 2) * 2) / 2 * 0.35;
    return { head: [0.03 * Math.sin(p * 3), look, 0], neck2: [0, look * 0.4, 0], tail: [0.05 * Math.sin(p * 4), 0, 0] };
  }));
  clips.push(poseClip('walk', map, R.walkT ?? 0.8, true, (u) => {
    const p = u * TAU;
    const o = {};
    for (const [n, off] of [['L', 0], ['R', Math.PI]]) {
      o[`up${n}`] = [-stride * Math.sin(p + off), 0, 0];
      o[`lo${n}`] = [stride * 1.6 * Math.max(0, Math.cos(p + off)), 0, 0];
    }
    o.root = [0, d.H * 0.015 * (1 - Math.cos(p * 2)) * 0.5, 0];
    o.pelvis = [0, 0, 0.06 * Math.sin(p)];
    // The head bobs: thrust forward, then held while the body catches up.
    o.neck1 = [0.08 * Math.sin(p * 2), 0, 0];
    o.head = [-0.08 * Math.sin(p * 2), 0, 0];
    return o;
  }));
  const reach = R.reach ?? 1.1;
  clips.push(poseClip('eat', map, 1.6, true, (u) => {
    const p = u * TAU;
    const peck = Math.max(0, Math.sin(p * 2)) ** 2;
    return { pelvis: [reach * 0.35, 0, 0], neck1: [reach * 0.55 + peck * 0.15, 0, 0], neck2: [reach * 0.25, 0, 0], head: [0.2 + peck * 0.2, 0, 0], upL: [-reach * 0.3, 0, 0], upR: [-reach * 0.3, 0, 0] };
  }));
  clips.push(poseClip('attack', map, 0.5, false, (u) => {
    const k = Math.sin(Math.min(1, u * 1.8) * Math.PI);
    return { pelvis: [0.3 * k, 0, 0], neck1: [0.6 * k, 0, 0], neck2: [-0.3 * k, 0, 0], head: [0.2 * k, 0, 0] };
  }));
  clips.push(poseClip('swim', map, 2, true, (u) => {
    const p = u * TAU;
    return { upL: [-0.6 + 0.5 * Math.sin(p * 2), 0, 0], upR: [-0.6 - 0.5 * Math.sin(p * 2), 0, 0], neck1: [0.04 * Math.sin(p), 0, 0], head: [0, 0.25 * Math.sin(p), 0], root: [0, 0.01 * d.H * Math.sin(p * 2), 0] };
  }));
  clips.push(poseClip('death', map, 0.8, false, (u) => {
    const k = sstep(0, 0.8, u);
    return { root: [0, d.halfW * 0.6 * k, 0], pelvis: [0, 0, (Math.PI / 2) * 0.9 * k], neck1: [0.6 * k, 0, 0.3 * k], head: [0.3 * k, 0, 0], upL: [0.6 * k, 0, 0], upR: [0.4 * k, 0, 0] };
  }));
  clips.push(poseClip('death.1', map, 1, false, (u) => {
    const k = sstep(0.1, 0.8, u);
    return { root: [0, d.halfW * 0.6 * k, 0], pelvis: [0.3 * (1 - k) * Math.sin(u * Math.PI), 0, -(Math.PI / 2) * 0.9 * k], neck1: [0.3 * k, 0, -0.5 * k], head: [0.5 * k, 0, 0], upL: [0.3 * k, 0, 0], upR: [0.7 * k, 0, 0] };
  }));
  // Standing about: preening (the head turned back into the feathers of a shoulder), and craning up to watch the sky.
  clips.push(poseClip('idle.1', map, 4, true, (u) => {
    const p = u * TAU;
    const back = sstep(0.05, 0.25, u) * (1 - sstep(0.75, 0.95, u));
    const s = Math.sin(p * 0.5) >= 0 ? 1 : -1;
    return { neck1: [0.2 * back, s * 1.1 * back, 0], neck2: [0.35 * back, s * 0.9 * back, 0], head: [0.5 * back + 0.12 * Math.sin(p * 10) * back, s * 0.4 * back, 0], tail: [0.08 * Math.sin(p * 6), 0, 0] };
  }));
  clips.push(poseClip('idle.2', map, 5, true, (u) => {
    const p = u * TAU;
    const up = 0.5 + 0.5 * Math.sin(p - Math.PI / 2);
    return { neck1: [-0.25 * up, 0.2 * Math.sin(p), 0], neck2: [-0.15 * up, 0, 0], head: [-0.35 * up, 0.3 * Math.sin(p * 2), 0.2 * up * Math.sin(p)], tail: [0.05 * Math.sin(p * 3), 0, 0] };
  }));
  for (const [name, s] of [['hit', 1], ['hit.1', -1]]) {
    clips.push(poseClip(name, map, 0.5, false, (u) => {
      const k = Math.sin(Math.min(1, u * 1.4) * Math.PI);
      return { root: [-s * d.halfW * 0.3 * k, d.H * 0.04 * k, 0], pelvis: [-0.15 * k, 0, -s * 0.2 * k], neck1: [-0.3 * k, -s * 0.4 * k, 0], head: [-0.2 * k, 0, 0], tail: [0.3 * k, 0, 0] };
    }));
  }
  return clips;
}

// ------------------------------------------------------------------------------------------ birds in the air

function rigFlyer(geo, cfg, R) {
  const { pos, idx } = geo;
  const V = pos.length / 3;
  const pts = surfacePoints(pos, idx);
  let xw = 0, H = 0, zmin = Infinity, zmax = -Infinity;
  for (const p of pts) { xw = Math.max(xw, Math.abs(p.x)); H = Math.max(H, p.y); zmin = Math.min(zmin, p.z); zmax = Math.max(zmax, p.z); }
  // The body is the narrow core: its half-width is where the wings start.
  const body = (R.body ?? 0.12) * xw;
  const core = pts.filter((p) => Math.abs(p.x) < body);
  const cy = mean(core.map((p) => p.y));
  const shoulderZ = mean(pts.filter((p) => Math.abs(p.x) > body * 1.2 && Math.abs(p.x) < body * 2).map((p) => p.z)) || 0;
  const wrist = body + (R.wrist ?? 0.5) * (xw - body);
  const bones = [
    { name: 'root', at: [0, 0, 0] },
    { name: 'pelvis', parent: 'root', at: [0, cy, 0] },
    { name: 'wingL', parent: 'pelvis', at: [body, cy, shoulderZ] },
    { name: 'handL', parent: 'wingL', at: [wrist, cy, shoulderZ] },
    { name: 'wingR', parent: 'pelvis', at: [-body, cy, shoulderZ] },
    { name: 'handR', parent: 'wingR', at: [-wrist, cy, shoulderZ] },
    { name: 'tail', parent: 'pelvis', at: [0, cy, zmin + 0.35 * (zmax - zmin)] },
  ];
  const { root, map } = makeBones(bones);
  const W = [];
  const _p = new THREE.Vector3();
  for (let i = 0; i < V; i++) {
    _p.fromArray(pos, i * 3);
    const ax = Math.abs(_p.x);
    const side = _p.x > 0 ? 'L' : 'R';
    const ww = sstep(body * 0.75, body * 1.3, ax);
    const hw = sstep(wrist - 0.06 * xw, wrist + 0.06 * xw, ax);
    const tw = (1 - ww) * sstep(zmin + 0.35 * (zmax - zmin), zmin + 0.15 * (zmax - zmin), _p.z);
    W.push(topFour({ pelvis: (1 - ww) * (1 - tw), tail: tw, [`wing${side}`]: ww * (1 - hw), [`hand${side}`]: ww * hw }));
  }
  const rest = R.rest ?? 0;
  const amp = R.flap ?? 0.75;
  const clips = [
    poseClip('flap', map, R.flapT ?? 0.5, true, (u) => {
      const p = u * TAU;
      const a = rest + amp * Math.sin(p);
      const h = 0.45 * amp * Math.sin(p - 0.7);
      return { wingL: [0, 0, a], handL: [0, 0, h], wingR: [0, 0, -a], handR: [0, 0, -h], root: [0, -0.06 * xw * Math.sin(p), 0], tail: [0.08 * Math.sin(p + 1), 0, 0] };
    }),
    poseClip('glide', map, 3, true, (u) => {
      const p = u * TAU;
      const a = rest + (R.dihedral ?? 0.12) + 0.04 * Math.sin(p);
      return { wingL: [0, 0, a], handL: [0, 0, -0.05 + 0.03 * Math.sin(p + 1)], wingR: [0, 0, -a], handR: [0, 0, 0.05 - 0.03 * Math.sin(p + 1)], tail: [0, 0.08 * Math.sin(p), 0] };
    }),
    // Other takes: deeper, rowing beats with the hands sweeping late, and a glide on a lean, one wing tip high.
    poseClip('flap.1', map, (R.flapT ?? 0.5) * 1.2, true, (u) => {
      const p = u * TAU;
      const a = rest + amp * 1.2 * Math.sin(p) + 0.08;
      const h = 0.6 * amp * Math.sin(p - 1.1);
      return { wingL: [0, 0.08 * Math.cos(p), a], handL: [0, 0, h], wingR: [0, -0.08 * Math.cos(p), -a], handR: [0, 0, -h], root: [0, -0.08 * xw * Math.sin(p), 0], tail: [0.12 * Math.sin(p + 1), 0, 0] };
    }),
    poseClip('glide.1', map, 4, true, (u) => {
      const p = u * TAU;
      const lean = 0.12 * Math.sin(p);
      const a = rest + (R.dihedral ?? 0.12);
      return { wingL: [0, 0, a + lean], handL: [0, 0, -0.08], wingR: [0, 0, -a + lean], handR: [0, 0, 0.08], tail: [0, -0.12 * Math.sin(p), 0.1 * Math.sin(p)] };
    }),
  ];
  // A held pose for the rest frame (the reference for sizing).
  clips.unshift(poseClip('idle', map, 1, true, () => ({ wingL: [0, 0, rest], wingR: [0, 0, -rest] })));
  return { root, map, W, clips, dims: { H, halfW: xw } };
}

// ------------------------------------------------------------------------------------------ entry

/**
 * Rig `cfg.source` by `cfg.rig.type` ('quad', 'bird' or 'flyer'). Returns what `bake-models.mjs` needs: the bone tree, joints
 * with inverse bind matrices, the geometry with skin indices and weights, and the generated clips.
 */
export function autoRig(cfg, SRC) {
  const geo = loadStill(resolve(SRC, cfg.source), cfg);
  const R = cfg.rig;
  const rig = R.type === 'quad' ? rigQuad(geo, cfg, R) : R.type === 'bird' ? rigBird(geo, cfg, R) : rigFlyer(geo, cfg, R);
  const joints = [...rig.map.values()];
  const index = new Map(joints.map((j, i) => [j.name, i]));
  rig.root.updateMatrixWorld(true);
  const IBM = joints.map((j) => j.matrixWorld.clone().invert());
  const ji = [];
  const jw = [];
  for (const w of rig.W) {
    for (let c = 0; c < 4; c++) {
      ji.push(w[c] ? index.get(w[c][0]) : 0);
      jw.push(w[c] ? w[c][1] : 0);
    }
  }
  const V = geo.pos.length / 3;
  // Animation tracks are bound by bone name; the baker's mixer resets every object in `objs` before each frame.
  return {
    g: null, root: rig.root, objs: joints, joints, IBM,
    pos: geo.pos, nrm: geo.nrm, uv: new Array(V * 2).fill(0), col: geo.col, ji, jw, idx: geo.idx, texture: null,
    anims: rig.clips, rigged: true, dims: rig.dims,
  };
}
