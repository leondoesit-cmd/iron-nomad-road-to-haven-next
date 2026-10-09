// Retarget motion from humanoid animation sources onto the game's own zombie body (`src/render/zombieRender.ts`), whose
// eleven rigid parts hinge at fixed joints: pelvis, chest, head, and thigh, shin, upper arm and forearm each side. Sources:
// glTF libraries (Quaternius Universal Animation Library on an Unreal-mannequin skeleton, KayKit's Rig_Medium) and motion
// capture in BVH (the 100STYLE dataset, the CMU Graphics Lab database), each read through its own joint map.
//
// Each frame is matched by direction, not by bone rotations, so the skeletons need not share rest poses, proportions or
// units: the torso and head take the source's rotation relative to its rest, every limb is turned so it points where the
// source's limb points, the hips move with the source's (scaled by hip height) and, in a gait, the body is lowered or raised
// so the planted foot stays on the ground. Every pose is first turned to face +Z by the line of the source's hips, so a
// capture walking a curve becomes a walk on the spot. A clip can be cut from a long take (`from`, `to`, seconds) and, with
// `cycle`, trimmed to the single step cycle that best closes on itself, its seam then spread over the cycle so it loops
// without a hitch. The result is baked like any model's clips: skinning matrices per bone per frame.
import * as THREE from 'three';
import { BVHLoader } from 'three/addons/loaders/BVHLoader.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildNodes, clipOf, readGltf } from './gltf-read.mjs';

/** The zombie's joints at rest (metres, feet at y = 0, facing +Z, its left at +X): `zombieRender.ts` J. */
export const ZOMBIE_JOINTS = {
  pelvis: [0, 0.94, 0],
  chest: [0, 1.2, -0.01],
  head: [0, 1.54, 0.03],
  thighL: [0.1, 0.94, 0], shinL: [0.11, 0.52, 0.02], ankleL: [0.11, 0.12, 0.01],
  thighR: [-0.1, 0.94, 0], shinR: [-0.11, 0.52, 0.02], ankleR: [-0.11, 0.12, 0.01],
  upperArmL: [0.21, 1.42, -0.01], foreArmL: [0.23, 1.14, 0], handL: [0.23, 0.9, 0.02],
  upperArmR: [-0.21, 1.42, -0.01], foreArmR: [-0.23, 1.14, 0], handR: [-0.23, 0.9, 0.02],
};
/** Bone order in the baked file (the shader indexes by this). */
export const ZOMBIE_BONES = ['pelvis', 'chest', 'head', 'thighL', 'shinL', 'thighR', 'shinR', 'upperArmL', 'foreArmL', 'upperArmR', 'foreArmR'];
const PARENT = { chest: 'pelvis', head: 'chest', thighL: 'pelvis', shinL: 'thighL', thighR: 'pelvis', shinR: 'thighR', upperArmL: 'chest', foreArmL: 'upperArmL', upperArmR: 'chest', foreArmR: 'upperArmR' };
/** Limbs: [joint, end] on the zombie and [joint, end] by role on the source. */
const LIMB = {
  thighL: ['thighL', 'shinL', 'hipL', 'kneeL'], shinL: ['shinL', 'ankleL', 'kneeL', 'ankleL'],
  thighR: ['thighR', 'shinR', 'hipR', 'kneeR'], shinR: ['shinR', 'ankleR', 'kneeR', 'ankleR'],
  upperArmL: ['upperArmL', 'foreArmL', 'shoulderL', 'elbowL'], foreArmL: ['foreArmL', 'handL', 'elbowL', 'wristL'],
  upperArmR: ['upperArmR', 'foreArmR', 'shoulderR', 'elbowR'], foreArmR: ['foreArmR', 'handR', 'elbowR', 'wristR'],
};
/** Bones that take the source's rotation relative to rest, by role. */
const SPINE = { pelvis: 'pelvis', chest: 'chest', head: 'head' };

/** Each source skeleton's joints by role. */
const RIGS = {
  // Quaternius UAL (Unreal mannequin names).
  ual: { pelvis: 'pelvis', chest: 'spine_03', head: 'Head', hipL: 'thigh_l', kneeL: 'calf_l', ankleL: 'foot_l', hipR: 'thigh_r', kneeR: 'calf_r', ankleR: 'foot_r',
    shoulderL: 'upperarm_l', elbowL: 'lowerarm_l', wristL: 'hand_l', shoulderR: 'upperarm_r', elbowR: 'lowerarm_r', wristR: 'hand_r' },
  // KayKit Rig_Medium.
  kaykit: { pelvis: 'hips', chest: 'chest', head: 'head', hipL: 'upperleg.l', kneeL: 'lowerleg.l', ankleL: 'foot.l', hipR: 'upperleg.r', kneeR: 'lowerleg.r', ankleR: 'foot.r',
    shoulderL: 'upperarm.l', elbowL: 'lowerarm.l', wristL: 'wrist.l', shoulderR: 'upperarm.r', elbowR: 'lowerarm.r', wristR: 'wrist.r' },
  // 100STYLE BVH.
  style100: { pelvis: 'Hips', chest: 'Chest4', head: 'Head', hipL: 'LeftHip', kneeL: 'LeftKnee', ankleL: 'LeftAnkle', hipR: 'RightHip', kneeR: 'RightKnee', ankleR: 'RightAnkle',
    shoulderL: 'LeftShoulder', elbowL: 'LeftElbow', wristL: 'LeftWrist', shoulderR: 'RightShoulder', elbowR: 'RightElbow', wristR: 'RightWrist' },
  // CMU BVH (the cmu-mocap conversion).
  cmu: { pelvis: 'Hips', chest: 'Spine1', head: 'Head', hipL: 'LeftUpLeg', kneeL: 'LeftLeg', ankleL: 'LeftFoot', hipR: 'RightUpLeg', kneeR: 'RightLeg', ankleR: 'RightFoot',
    shoulderL: 'LeftArm', elbowL: 'LeftForeArm', wristL: 'LeftHand', shoulderR: 'RightArm', elbowR: 'RightForeArm', wristR: 'RightHand' },
};

const V = (a) => new THREE.Vector3(...a);
const UP = new THREE.Vector3(0, 1, 0);

/** A source: its posable root, joints by role, clips, rest pose and a mixer. */
function loadSource(file, rig, SRC) {
  const path = resolve(SRC, file);
  let root;
  let byName;
  let anims;
  if (file.endsWith('.bvh')) {
    const { skeleton, clip } = new BVHLoader().parse(readFileSync(path, 'utf8'));
    root = new THREE.Group();
    root.add(skeleton.bones[0]);
    byName = new Map(skeleton.bones.map((b) => [b.name, b]));
    clip.name = 'take';
    anims = [clip];
  } else {
    const g = readGltf(path);
    const built = buildNodes(g);
    root = built.root;
    byName = new Map(g.json.nodes.map((n, i) => [n.name, built.objs[i]]));
    anims = (g.json.animations ?? []).map((a) => clipOf(g, a));
  }
  const map = RIGS[rig];
  const joint = (role) => {
    const o = byName.get(map[role]);
    if (!o) throw new Error(`retarget: ${file} has no ${map[role]} (${role})`);
    return o;
  };
  const objs = [];
  root.traverse((o) => objs.push(o));
  const rest = objs.map((o) => ({ o, p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() }));
  root.updateMatrixWorld(true);
  const W = (role) => joint(role).getWorldPosition(new THREE.Vector3());
  const restFix = facing(W('hipL'), W('hipR'));
  const restQ = {};
  for (const r of Object.values(SPINE)) restQ[r] = restFix.clone().multiply(joint(r).getWorldQuaternion(new THREE.Quaternion()));
  const restPelvis = W('pelvis');
  const restFoot = Math.min(W('ankleL').y, W('ankleR').y);
  return { file, root, joint, W, rest, restQ, restFix, restPelvis, restFoot, anims, mixer: new THREE.AnimationMixer(root) };
}

/** The turn about +Y that brings the line from the right hip to the left onto +X (the body then faces +Z). */
function facing(hipL, hipR) {
  const l = hipL.clone().sub(hipR);
  return new THREE.Quaternion().setFromAxisAngle(UP, Math.atan2(l.z, l.x));
}

/** Pose a source at time t of a clip. */
function poseAt(src, clip, t) {
  src.mixer.stopAllAction();
  src.mixer.uncacheRoot(src.root);
  for (const r of src.rest) { r.o.position.copy(r.p); r.o.quaternion.copy(r.q); r.o.scale.copy(r.s); }
  src.mixer.clipAction(clip).play();
  // The action loops: sample just short of its end, where it would wrap to the first frame.
  src.mixer.setTime(Math.min(t, clip.duration - 1e-4));
  src.root.updateMatrixWorld(true);
}

/**
 * One frame on the zombie, before its chain is laid out: each bone's turn (G) and the hips' offset from rest, with the
 * source faced along +Z by `fix` and its travel taken off by `base` (the hips' path through the take).
 */
function sampleFrame(src, fix, base, hipK, restDir) {
  const G = {};
  for (const [b, r] of Object.entries(SPINE)) G[b] = fix.clone().multiply(src.joint(r).getWorldQuaternion(new THREE.Quaternion())).multiply(src.restQ[r].clone().invert());
  for (const [b, [, , sj, se]] of Object.entries(LIMB)) {
    const d = src.W(se).sub(src.W(sj)).applyQuaternion(fix).normalize();
    G[b] = new THREE.Quaternion().setFromUnitVectors(restDir[b], d);
  }
  const off = src.W('pelvis').sub(base).applyQuaternion(fix).multiplyScalar(hipK);
  return { G, off };
}

/** The hips' heading and position through a stretch of a take, sampled at `fps`. */
function track(src, clip, t0, t1, fps) {
  const out = [];
  const n = Math.max(2, Math.round((t1 - t0) * fps));
  for (let i = 0; i <= n; i++) {
    const t = t0 + ((t1 - t0) * i) / n;
    poseAt(src, clip, t);
    const l = src.W('hipL').sub(src.W('hipR'));
    const fix = facing(src.W('hipL'), src.W('hipR'));
    const ankle = src.W('ankleL').sub(src.W('ankleR')).applyQuaternion(fix);
    out.push({ t, yaw: Math.atan2(l.z, l.x), pelvis: src.W('pelvis'), stride: ankle.z, pose: limbDirs(src, fix) });
  }
  return out;
}

/** Limb directions (faced along +Z), for comparing poses. */
function limbDirs(src, fix) {
  return Object.values(LIMB).map(([, , sj, se]) => src.W(se).sub(src.W(sj)).applyQuaternion(fix).normalize());
}
const poseGap = (a, b) => a.reduce((s, d, i) => s + (1 - d.dot(b[i])), 0);

/** The yaw (radians) unwrapped along a track, so a turn through ±π does not jump. */
function unwrap(tr) {
  let prev = tr[0].yaw;
  let acc = prev;
  for (const s of tr) {
    let d = s.yaw - prev;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    acc += d;
    prev = s.yaw;
    s.uyaw = acc;
  }
}

/**
 * The single step cycle in [t0, t1] that best closes on itself: from one forward swing of the left foot to the next, on a
 * straight stretch (little turn), its end pose nearest its start. With `span` a held stretch of that length instead (an idle).
 */
function findLoop(src, clip, t0, t1, spec) {
  const fps = 60;
  const tr = track(src, clip, t0, t1, fps);
  unwrap(tr);
  const cands = [];
  if (spec.span) {
    const [lo, hi] = spec.span;
    for (let i = 0; i < tr.length; i += 3) {
      for (let j = i + Math.round(lo * fps); j < Math.min(tr.length, i + Math.round(hi * fps)); j += 2) {
        cands.push({ i, j, score: poseGap(tr[i].pose, tr[j].pose) + Math.abs(tr[j].uyaw - tr[i].uyaw) * 0.5 });
      }
    }
  } else {
    // Peaks of the left foot's lead, smoothed.
    const s = tr.map((x, k) => {
      let a = 0, c = 0;
      for (let q = Math.max(0, k - 3); q <= Math.min(tr.length - 1, k + 3); q++) { a += tr[q].stride; c++; }
      return a / c;
    });
    const peaks = [];
    for (let k = 4; k < s.length - 4; k++) if (s[k] > s[k - 1] && s[k] >= s[k + 1] && s[k] > 0) peaks.push(k);
    const [lo, hi] = spec.period ?? [0.6, 2.2];
    for (let p = 0; p < peaks.length - 1; p++) {
      const i = peaks[p], j = peaks[p + 1];
      const T = (j - i) / fps;
      if (T < lo || T > hi) continue;
      const turn = Math.abs(tr[j].uyaw - tr[i].uyaw);
      cands.push({ i, j, score: poseGap(tr[i].pose, tr[j].pose) + turn * 2 });
    }
  }
  if (!cands.length) throw new Error(`retarget: no loop in ${src.file} ${t0}-${t1}`);
  cands.sort((a, b) => a.score - b.score);
  const best = cands[0];
  return { t0: tr[best.i].t, t1: tr[best.j].t, score: best.score };
}

/**
 * Bake `cfg.clips` ({ role: { src, name, from, to, cycle, span, loop, ground, speed, hold } }) from `cfg.sources`
 * ({ key: { file, rig } } or a glTF file name, read as UAL). Returns frames of skinning matrices in `ZOMBIE_BONES` order and
 * the clip table, for `bake-models.mjs` to write.
 */
export function retarget(cfg, SRC) {
  const fps = cfg.fps ?? 30;
  const libs = {};
  for (const [key, s] of Object.entries(cfg.sources)) {
    const { file, rig } = typeof s === 'string' ? { file: s, rig: 'ual' } : s;
    libs[key] = loadSource(file, rig, SRC);
  }
  const J = Object.fromEntries(Object.entries(ZOMBIE_JOINTS).map(([k, v]) => [k, V(v)]));
  const restDir = {};
  for (const [b, [j, e]] of Object.entries(LIMB)) restDir[b] = J[e].clone().sub(J[j]).normalize();

  const frames = [];
  const clips = {};
  const report = {};
  for (const [role, spec] of Object.entries(cfg.clips)) {
    const src = libs[spec.src];
    const clip = spec.name ? src.anims.find((a) => a.name === spec.name || a.name.endsWith(`|${spec.name}`)) : src.anims[0];
    if (!clip) throw new Error(`retarget: no clip ${spec.name} in ${spec.src}`);
    // Hip height in the source's own units, standing: from the rest pose's hips to its feet.
    const hipK = (J.pelvis.y - J.ankleL.y) / (src.restPelvis.y - src.restFoot);
    let t0 = spec.from ?? 0;
    let t1 = spec.to ?? clip.duration;
    if (spec.cycle || spec.span) {
      const l = findLoop(src, clip, t0, t1, spec);
      t0 = l.t0;
      t1 = l.t1;
      report[role] = `${t0.toFixed(2)}-${t1.toFixed(2)} s (gap ${l.score.toFixed(3)})`;
    }
    const loop = spec.loop !== false;
    const dur = (t1 - t0) / (spec.speed ?? 1);
    const n = Math.max(2, Math.round(dur * fps) + (loop ? 0 : 1));
    // The take's own heading and travel: a clip from a capture walks on the spot facing +Z; a library clip made in place
    // keeps its hips where they are (it already faces +Z).
    const mocap = !!(spec.cycle || spec.span || spec.from !== undefined);
    // The floor under the take (a capture's hips are metres up its own axis; a library's stand at rest): its lowest ankle.
    let floor = Infinity;
    for (let k = 0; k <= 30; k++) {
      poseAt(src, clip, t0 + ((t1 - t0) * k) / 30);
      floor = Math.min(floor, src.W('ankleL').y, src.W('ankleR').y);
    }
    const standY = floor + (src.restPelvis.y - src.restFoot);
    poseAt(src, clip, t0);
    const p0 = src.W('pelvis');
    const yaw0 = facing(src.W('hipL'), src.W('hipR'));
    poseAt(src, clip, t1);
    const p1 = src.W('pelvis');
    const yaw1 = facing(src.W('hipL'), src.W('hipR'));
    const raw = [];
    for (let f = 0; f <= n; f++) {
      const u = loop ? f / n : f / Math.max(1, n - 1);
      if (!loop && f === n) break;
      poseAt(src, clip, t0 + u * (t1 - t0));
      const fix = mocap ? yaw0.clone().slerp(yaw1, u) : src.restFix.clone();
      const base = mocap ? p0.clone().lerp(p1, u).setY(standY) : src.restPelvis.clone().setY(standY);
      raw.push(sampleFrame(src, fix, base, hipK, restDir));
    }
    // A loop's seam: the pose it ends on is turned back onto the one it starts from, spread evenly over the cycle.
    if (loop && raw.length === n + 1) {
      const end = raw[n];
      const first = raw[0];
      for (let f = 0; f < n; f++) {
        const k = f / n;
        for (const b of ZOMBIE_BONES) {
          const fixQ = first.G[b].clone().multiply(end.G[b].clone().invert());
          raw[f].G[b].premultiply(new THREE.Quaternion().slerp(fixQ, k));
        }
        raw[f].off.add(first.off.clone().sub(end.off).multiplyScalar(k));
      }
      raw.length = n;
    }
    clips[role] = { start: frames.length, frames: n, dur, loop };
    if (spec.inPlace !== false && !mocap) for (const { off } of raw) { off.x *= cfg.sway ?? 1; off.z = 0; }
    // A death is laid on the ground frame by frame, in the pose this take of it ends in.
    const laid = spec.lie ? lieDown(raw, spec.lie, J, restDir) : null;
    for (const [fi, { G, off }] of raw.entries()) {
      const P = laid ? laid[fi] : chainOf(G, off, J);
      // Planted feet: in a gait the lower ankle rests at its rest height.
      if (spec.ground) {
        const ankle = (side) => P[`shin${side}`].clone().add(J[`ankle${side}`].clone().sub(J[`shin${side}`]).applyQuaternion(G[`shin${side}`]));
        const low = Math.min(ankle('L').y, ankle('R').y);
        const dy = J.ankleL.y - low;
        for (const b of ZOMBIE_BONES) P[b].y += dy;
      }
      const _p = new THREE.Vector3();
      frames.push(ZOMBIE_BONES.map((b) => {
        // Skinning: v' = P_b + G_b (v - J_b).
        const m = new THREE.Matrix4().makeRotationFromQuaternion(G[b]);
        _p.copy(J[b]).applyQuaternion(G[b]);
        m.setPosition(P[b].x - _p.x, P[b].y - _p.y, P[b].z - _p.z);
        return m;
      }));
    }
  }
  if (Object.keys(report).length) console.log('  cut from takes:', Object.entries(report).map(([k, v]) => `${k} ${v}`).join('; '));
  return { frames, clips, fps };
}

/** The joints laid out down the chain from the hips: each bone's joint where its parent's turn carries it. */
function chainOf(G, off, J) {
  const P = { pelvis: J.pelvis.clone().add(off) };
  for (const b of ZOMBIE_BONES) {
    if (b === 'pelvis') continue;
    const par = PARENT[b];
    P[b] = P[par].clone().add(J[b].clone().sub(J[par]).applyQuaternion(G[par]));
  }
  return P;
}

// ------------------------------------------------------------------------------------------ the dead

/**
 * Points on the zombie's skin at rest, by bone (`zombieRender.ts`: the hips' and rib cage's elliptic rings, the skull's,
 * limbs as round sections, flat soles, hands): what touches the ground when a body lies on it.
 */
const SKIN = (() => {
  const out = [];
  const ring = (bone, y, w, d, z, n = 12) => {
    for (let i = 0; i < n; i++) out.push([bone, new THREE.Vector3(Math.sin((i / n) * Math.PI * 2) * w, y, z + Math.cos((i / n) * Math.PI * 2) * d)]);
  };
  const round = (bone, a, b, r, steps = 3) => {
    for (let k = 0; k <= steps; k++) {
      const c = new THREE.Vector3(...a).lerp(new THREE.Vector3(...b), k / steps);
      for (let i = 0; i < 8; i++) out.push([bone, c.clone().add(new THREE.Vector3(Math.sin((i / 8) * Math.PI * 2) * r, 0, Math.cos((i / 8) * Math.PI * 2) * r))]);
    }
  };
  for (const [y, w, d, z] of [[0.85, 0.11, 0.075, 0], [0.9, 0.145, 0.1, 0], [0.97, 0.145, 0.095, 0], [1.04, 0.127, 0.083, -0.005]]) ring('pelvis', y, w, d, z);
  for (const [y, w, d, z] of [[1.07, 0.12, 0.08, -0.01], [1.18, 0.14, 0.09, -0.02], [1.32, 0.18, 0.105, -0.02], [1.4, 0.195, 0.095, -0.02], [1.46, 0.145, 0.065, -0.025]]) ring('chest', y, w, d, z);
  ring('head', 1.56, 0.05, 0.05, 0.02, 8);
  for (const [y, w, d, z] of [[1.615, 0.055, 0.06, 0.005], [1.69, 0.093, 0.084, 0.014], [1.735, 0.098, 0.087, 0.012], [1.785, 0.08, 0.073, 0.006], [1.816, 0.045, 0.042, 0]]) ring('head', y, w, d, z);
  out.push(['head', new THREE.Vector3(0, 1.58, 0.1)], ['head', new THREE.Vector3(0, 1.829, 0)]);
  for (const [s, x] of [['L', 1], ['R', -1]]) {
    round(`thigh${s}`, [0.1 * x, 0.9, 0], [0.11 * x, 0.56, 0.02], 0.075);
    round(`shin${s}`, [0.11 * x, 0.48, 0.02], [0.11 * x, 0.16, 0.01], 0.055);
    for (const z of [-0.05, 0.05, 0.16]) for (const dx of [-0.045, 0.045]) out.push([`shin${s}`, new THREE.Vector3(0.11 * x + dx, 0.005, z)]);
    out.push([`shin${s}`, new THREE.Vector3(0.11 * x, 0.11, 0.15)], [`shin${s}`, new THREE.Vector3(0.11 * x, 0.1, -0.07)]);
    round(`upperArm${s}`, [0.21 * x, 1.38, -0.01], [0.23 * x, 1.16, 0], 0.05, 2);
    round(`foreArm${s}`, [0.23 * x, 1.12, 0], [0.23 * x, 0.92, 0.02], 0.045, 2);
    round(`foreArm${s}`, [0.23 * x, 0.86, 0.02], [0.23 * x, 0.76, 0.03], 0.035, 1);
  }
  return out;
})();
/** Which bones each one carries with it (itself first). */
const CARRIES = Object.fromEntries(ZOMBIE_BONES.map((b) => [b, ZOMBIE_BONES.filter((c) => { for (let x = c; x; x = PARENT[x]) if (x === b) return true; return false; })]));
const CORE = new Set(['pelvis', 'chest', 'thighL', 'shinL', 'thighR', 'shinR']);

/** The lowest skin point of some bones in a pose. */
function lowest(P, G, J, bones) {
  let y = Infinity;
  const v = new THREE.Vector3();
  for (const [b, p] of SKIN) {
    if (bones && !bones.has(b)) continue;
    v.copy(p).sub(J[b]).applyQuaternion(G[b]).add(P[b]);
    if (v.y < y) y = v.y;
  }
  return y;
}

const _ax = new THREE.Vector3();
const _q = new THREE.Quaternion();
/** Turn a direction `v` about unit `axis` by `a` radians (towards axis x v). */
const turn = (v, axis, a) => v.clone().applyQuaternion(_q.setFromAxisAngle(axis, a));
/** Turn a bone and all it carries about its joint (world axis), then lay the chain out again. */
function swing(G, P, J, bone, axis, a) {
  _q.setFromAxisAngle(axis, a);
  for (const b of CARRIES[bone]) G[b].premultiply(_q);
  const o = P[bone].clone();
  for (const b of CARRIES[bone]) if (b !== bone) P[b].sub(o).applyQuaternion(_q).add(o);
}

/** Where the last bones of a chain end, at rest: ankles, wrists, the crown. */
const TIP = { shinL: V(ZOMBIE_JOINTS.ankleL), shinR: V(ZOMBIE_JOINTS.ankleR), foreArmL: V(ZOMBIE_JOINTS.handL), foreArmR: V(ZOMBIE_JOINTS.handR), head: new THREE.Vector3(0, 1.82, 0.01) };

/**
 * Let a limb (or the head) go limp onto the ground: turned up or down about its joint, across its own line, by the least
 * that leaves the lowest of its skin just on the ground; `droop` lets one held in the air fall, else it is only lifted
 * out of the ground. `w` takes that share of the turn (a body still falling lies down by degrees).
 */
function settle(G, P, J, bone, end, w, droop, fallback, reach = 1.5) {
  const dir = (end ? P[end].clone().sub(P[bone]) : TIP[bone].clone().sub(J[bone]).applyQuaternion(G[bone])).normalize();
  _ax.crossVectors(dir, UP);
  if (_ax.lengthSq() < 1e-4) _ax.crossVectors(fallback, UP);
  _ax.normalize();
  const set = new Set(CARRIES[bone]);
  const base = ZOMBIE_BONES.map((b) => [b, G[b].clone(), P[b].clone()]);
  const at = (a) => {
    for (const [b, g, p] of base) { G[b].copy(g); P[b].copy(p); }
    if (a) swing(G, P, J, bone, _ax.clone(), a);
    return lowest(P, G, J, set);
  };
  const y0 = at(0);
  let best = 0;
  if (y0 < 0) {
    for (let a = 0.04; a <= 1.6; a += 0.04) { best = a; if (at(a) >= 0) break; }
  } else if (droop && y0 > 0.01) {
    let bestY = y0;
    for (let a = -0.04; a >= -reach; a -= 0.04) {
      const y = at(a);
      if (y < -0.005) break;
      best = a;
      bestY = y;
      if (bestY < 0.01) break;
    }
  }
  at(best * w);
}

const TRUNK = new Set(['pelvis', 'chest']);
const _hips = new Set(['pelvis']);
const _ribs = new Set(['chest']);

/** Tip the whole body, about the hips, so the hips and the rib cage lie equally low (by `w`: still falling, part way). */
function flatten(G, P, J, w) {
  if (w <= 0) return;
  const spine = P.chest.clone().sub(P.pelvis).normalize();
  const axis = new THREE.Vector3().crossVectors(spine, UP);
  if (axis.lengthSq() < 1e-4) return;
  axis.normalize();
  const base = ZOMBIE_BONES.map((b) => [b, G[b].clone(), P[b].clone()]);
  const at = (a) => {
    for (const [b, g, p] of base) { G[b].copy(g); P[b].copy(p); }
    if (a) swing(G, P, J, 'pelvis', axis, a);
    return Math.abs(lowest(P, G, J, _hips) - lowest(P, G, J, _ribs)) + Math.abs(a) * 0.02;
  };
  let best = 0;
  let cost = at(0);
  for (let a = -0.9; a <= 0.9; a += 0.03) {
    const c = at(a);
    if (c < cost) { cost = c; best = a; }
  }
  at(best * w);
}

/** Every frame's joints, settled on the ground (see `lieDown`). */
function placeOnGround(P, G, J) {
  const dy = -lowest(P, G, J, null);
  for (const b of ZOMBIE_BONES) P[b].y += dy;
}

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const DEG = Math.PI / 180;

/**
 * Lay a death take on the ground and, as the body comes down, into a pose of its own: the whole body rolled about its
 * length (onto a side, or part way), the chest twisted on the hips, the head turned, and each arm and leg put where `opts`
 * says (`top`/`bottom`: the limbs of the side that ends higher and lower; arm [out from the side, forward, elbow bend] and
 * leg [out, forward at the hip, knee bend], in degrees, in the body's own frame, and optionally the forearm or shin turned
 * about the body's normal; `limp: false` keeps a raised knee up). Then everything that hangs in the air
 * goes limp onto the ground and nothing sinks into it: every frame, the body's lowest skin is on the ground.
 */
function lieDown(raw, opts, J, restDir) {
  const out = [];
  // Which side ends up higher: the last frame, rolled.
  const roll = (opts.roll ?? 0) * DEG;
  const lastG = raw[raw.length - 1].G;
  const lp = new THREE.Vector3(0, 1, 0).applyQuaternion(lastG.pelvis);
  const leftUp = new THREE.Vector3(1, 0, 0).applyQuaternion(lastG.pelvis).applyQuaternion(_q.setFromAxisAngle(lp, roll)).y >= 0;
  const sides = { L: leftUp ? 'top' : 'bottom', R: leftUp ? 'bottom' : 'top' };
  let w = 0;
  for (const { G, off } of raw) {
    // How far down it has come: the spine from upright to lying flat.
    const spine = new THREE.Vector3(0, 1, 0).applyQuaternion(G.chest);
    w = Math.max(w, smooth(0.3, 0.85, 1 - Math.abs(spine.y)));
    // Rolled about its length through the hips; the chest further.
    const along = new THREE.Vector3(0, 1, 0).applyQuaternion(G.pelvis);
    _q.setFromAxisAngle(along, roll * w);
    for (const b of ZOMBIE_BONES) G[b].premultiply(_q);
    if (opts.twist) {
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0).applyQuaternion(G.chest), opts.twist * DEG * w);
      for (const b of CARRIES.chest) G[b].premultiply(q);
    }
    if (opts.head) G.head.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0).applyQuaternion(G.head), opts.head * DEG * w));
    // Limbs to the pose it ends in, in the body's frame as it is now.
    for (const s of ['L', 'R']) {
      const want = opts[sides[s]] ?? {};
      const x = s === 'L' ? 1 : -1;
      for (const [kind, frameBone, upper, lower, sign] of [['arm', 'chest', `upperArm${s}`, `foreArm${s}`, 1], ['leg', 'pelvis', `thigh${s}`, `shin${s}`, -1]]) {
        const p = want[kind];
        if (!p) continue;
        const L = new THREE.Vector3(0, 1, 0).applyQuaternion(G[frameBone]);
        const S = new THREE.Vector3(1, 0, 0).applyQuaternion(G[frameBone]);
        const F = new THREE.Vector3(0, 0, 1).applyQuaternion(G[frameBone]);
        const out0 = L.clone().multiplyScalar(-Math.cos(p[0] * DEG)).addScaledVector(S, x * Math.sin(p[0] * DEG)).normalize();
        const axis = new THREE.Vector3().crossVectors(out0, F).normalize();
        const up = turn(out0, axis, p[1] * DEG);
        let lo = turn(up, axis, sign * p[2] * DEG);
        // Bent across the ground instead (a body on its back or face): the forearm or shin turned about the body's normal.
        if (p[3]) lo = turn(lo, F, x * p[3] * DEG);
        G[upper].slerp(new THREE.Quaternion().setFromUnitVectors(restDir[upper], up), w);
        G[lower].slerp(new THREE.Quaternion().setFromUnitVectors(restDir[lower], lo), w);
      }
    }
    const P = chainOf(G, off, J);
    // The trunk comes down flat on the ground, whatever it was propped on (knees, arms) giving way under it; then whatever
    // hangs in the air or is pressed into the ground settles, twice over.
    const length = new THREE.Vector3(0, 1, 0).applyQuaternion(G.pelvis);
    flatten(G, P, J, w);
    for (let pass = 0; pass < 2; pass++) {
      const dyAll = -lowest(P, G, J, null);
      const dyTrunk = -lowest(P, G, J, TRUNK);
      for (const b of ZOMBIE_BONES) P[b].y += dyAll + (dyTrunk - dyAll) * w;
      for (const s of ['L', 'R']) {
        const limp = opts[sides[s]]?.limp ?? true;
        settle(G, P, J, `thigh${s}`, `shin${s}`, w, limp && opts.legsLimp !== false, length);
        settle(G, P, J, `shin${s}`, null, w, limp && opts.legsLimp !== false, length);
        settle(G, P, J, `upperArm${s}`, `foreArm${s}`, w, true, length);
        settle(G, P, J, `foreArm${s}`, null, w, true, length);
      }
      settle(G, P, J, 'head', null, w, true, length, 0.8);
    }
    placeOnGround(P, G, J);
    out.push(P);
  }
  return out;
}
