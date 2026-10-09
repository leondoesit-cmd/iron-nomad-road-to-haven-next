// A wading bird on the wing, made from its standing model: no free model of a flying heron or stork exists, and a gull's
// shape in their colours reads wrong overhead. The standing bird is levelled, its legs swung back to trail behind it, its
// neck folded back onto the shoulders (a heron, `neck: 'tuck'`) or stretched out ahead (a stork, `neck: 'reach'`) with the
// head turned back level, and a gull's wings are taken off their body, laid flat, scaled to the bird's span and set on its
// shoulders. The result is a still mesh in spread-wing pose for the flyer rig (`autorig.mjs`), like any other flyer.
import * as THREE from 'three';

const sstep = (a, b, v) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);

/** Bounds of a position array: [min, max] per axis. */
function bounds(pos) {
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let c = 0; c < 3; c++) { mn[c] = Math.min(mn[c], pos[i + c]); mx[c] = Math.max(mx[c], pos[i + c]); }
  return [mn, mx];
}

/** Rotate points (and normals) about +x through `pivot` by `a`, each by its own weight (0 none, 1 all of it). */
function rotateX(pos, nrm, pivot, a, weight) {
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.length / 3; i++) {
    const w = weight(i);
    if (w <= 0) continue;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), a * w);
    p.fromArray(pos, i * 3).sub(pivot).applyQuaternion(q).add(pivot);
    pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
    n.fromArray(nrm, i * 3).applyQuaternion(q);
    nrm[i * 3] = n.x; nrm[i * 3 + 1] = n.y; nrm[i * 3 + 2] = n.z;
  }
}

/** The pitch (about +x) that turns direction `from` onto `to`, both in the y-z plane (turning about +x lowers +z toward -y). */
const pitchBetween = (from, to) => Math.atan2(from.y, from.z) - Math.atan2(to.y, to.z);

/**
 * Pose `body` (a standing bird facing +Z, feet on y = 0; `{ pos, nrm, col, idx }`) for flight and give it `wings` (a flying
 * bird's mesh facing +Z). `F`: belly and neckBase (fractions of height where the legs end and the neck begins), neck ('tuck'
 * or 'reach'), span (wingspan in body lengths), wingTint (multiplies the wings' colours). Returns a new `{ pos, nrm, col, idx }`.
 */
export function composeFlight(body, wings, F) {
  const pos = body.pos.slice();
  const nrm = body.nrm.slice();
  const V = pos.length / 3;
  // Height 1, feet at y = 0, centred.
  let [mn, mx] = bounds(pos);
  const s = 1 / (mx[1] - mn[1]);
  for (let i = 0; i < V; i++) {
    pos[i * 3] = (pos[i * 3] - (mn[0] + mx[0]) / 2) * s;
    pos[i * 3 + 1] = (pos[i * 3 + 1] - mn[1]) * s;
    pos[i * 3 + 2] = (pos[i * 3 + 2] - (mn[2] + mx[2]) / 2) * s;
  }
  const y0 = pos.filter((_, k) => k % 3 === 1);
  const belly = F.belly ?? 0.4;
  const neckY = F.neckBase ?? 0.62;
  const headY = F.headY ?? 0.86;
  // Regions, by the standing height of each point (kept from before any turning).
  const legW = y0.map((y) => 1 - sstep(belly - 0.05, belly + 0.02, y));
  // The neck rises from the front of the body: points behind its base (folded wings reaching as high) stay with the body.
  const z0 = pos.filter((_, k) => k % 3 === 2);
  const band = z0.filter((_, i) => Math.abs(y0[i] - neckY) < 0.05);
  const neckZ = Math.max(...band) - (F.neckThick ?? 0.07);
  const neckW = y0.map((y, i) => sstep(neckY - 0.03, neckY + 0.06, y) * (F.neckGate ? sstep(neckZ - 0.1, neckZ - 0.03, z0[i]) : 1));
  const headW = y0.map((y) => sstep(headY - 0.03, headY + 0.03, y));
  const at = (filter) => {
    const pts = [];
    for (let i = 0; i < V; i++) if (filter(i)) pts.push(new THREE.Vector3().fromArray(pos, i * 3));
    return pts.length ? pts.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length) : new THREE.Vector3();
  };
  // 1. Level the body: the line from its tail end to its chest (the trunk between the legs and the neck) made horizontal.
  const trunk = [];
  for (let i = 0; i < V; i++) if (legW[i] < 0.05 && neckW[i] < 0.05) trunk.push(new THREE.Vector3().fromArray(pos, i * 3));
  const tc = trunk.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / trunk.length);
  // Principal axis in y-z.
  let syy = 0, szz = 0, syz = 0;
  for (const p of trunk) { const dy = p.y - tc.y, dz = p.z - tc.z; syy += dy * dy; szz += dz * dz; syz += dy * dz; }
  const ang = 0.5 * Math.atan2(2 * syz, szz - syy);
  const axis = new THREE.Vector3(0, Math.sin(ang), Math.cos(ang));
  if (axis.z < 0) axis.negate();
  // The hip and feet as it stands: the feet are its lowest points, the hip straight above them where the legs end (low-poly
  // legs are bare cylinders, often ending inside the body).
  const feet = at((i) => y0[i] < belly * 0.15);
  const hip = new THREE.Vector3(feet.x, belly, feet.z);
  // A model whose trunk is hard to read (its folded wings as tall as its neck) can be given its pitch outright.
  const level = F.level ?? pitchBetween(axis, new THREE.Vector3(0, 0, 1));
  rotateX(pos, nrm, tc, level, () => 1);
  const lq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), level);
  for (const p of [feet, hip]) p.sub(tc).applyQuaternion(lq).add(tc);
  // 2. Legs swung back from the hip to trail behind, a little below the tail.
  rotateX(pos, nrm, hip, pitchBetween(feet.clone().sub(hip), new THREE.Vector3(0, -0.12, -1)), (i) => legW[i]);
  // 3. The neck: folded back so the head sits just ahead of and above the shoulders, or stretched straight out ahead.
  const base = at((i) => neckW[i] > 0.3 && neckW[i] < 0.7);
  const head = at((i) => headW[i] > 0.5);
  const tuck = F.neck === 'tuck';
  const target = tuck ? new THREE.Vector3(0, 0.35, 1) : new THREE.Vector3(0, F.reachUp ?? 0.1, 1);
  const turn = pitchBetween(head.clone().sub(base), target);
  rotateX(pos, nrm, base, turn, (i) => neckW[i]);
  if (tuck) {
    // Fold: draw the neck in toward its base (an S folded flat, at this size).
    const k = 1 - (F.tuck ?? 0.55);
    for (let i = 0; i < V; i++) {
      const w = neckW[i];
      if (w <= 0) continue;
      for (let c = 1; c < 3; c++) pos[i * 3 + c] = pos[i * 3 + c] * (1 - w) + (base.getComponent(c) + (pos[i * 3 + c] - base.getComponent(c)) * k) * w;
    }
  }
  // The head turned so the bill points ahead, a little down: its tip is the head point farthest from the neck's base.
  const headNow = at((i) => headW[i] > 0.5);
  let tip = -1;
  for (let i = 0; i < V; i++) {
    if (headW[i] < 0.9) continue;
    if (tip < 0 || new THREE.Vector3().fromArray(pos, i * 3).distanceTo(base) > new THREE.Vector3().fromArray(pos, tip * 3).distanceTo(base)) tip = i;
  }
  const bill = new THREE.Vector3().fromArray(pos, tip * 3).sub(headNow);
  rotateX(pos, nrm, headNow, pitchBetween(bill, new THREE.Vector3(0, -0.2, 1)), (i) => headW[i]);

  // 4. Wings: a gull's, off its body (only what lies well out from its middle), each laid flat about its root.
  const wp = wings.pos;
  const [wmn, wmx] = bounds(wp);
  const half = Math.max(Math.abs(wmn[0]), Math.abs(wmx[0]));
  const core = (F.wingCore ?? 0.16) * half;
  const keep = [];
  for (let t = 0; t < wings.idx.length; t += 3) {
    const a = wings.idx[t], b = wings.idx[t + 1], c = wings.idx[t + 2];
    if (Math.abs(wp[a * 3]) > core && Math.abs(wp[b * 3]) > core && Math.abs(wp[c * 3]) > core) keep.push(a, b, c);
  }
  // Body measurements after posing: its length (bill to tail, legs aside), its trunk's top and its shoulders.
  const bodyPts = [];
  for (let i = 0; i < V; i++) if (legW[i] < 0.05) bodyPts.push(new THREE.Vector3().fromArray(pos, i * 3));
  const zMin = Math.min(...bodyPts.map((p) => p.z));
  const zMax = Math.max(...bodyPts.map((p) => p.z));
  const L = zMax - zMin;
  const trunkNow = [];
  for (let i = 0; i < V; i++) if (legW[i] < 0.05 && neckW[i] < 0.05) trunkNow.push(new THREE.Vector3().fromArray(pos, i * 3));
  const shoulderZ = F.shoulderZ !== undefined ? zMin + F.shoulderZ * L : mean(trunkNow.map((p) => p.z)) + 0.15 * L;
  const nearShoulder = trunkNow.filter((p) => Math.abs(p.z - shoulderZ) < 0.12 * L);
  const shoulderY = mean(nearShoulder.map((p) => p.y)) + 0.25 * (Math.max(...nearShoulder.map((p) => p.y)) - mean(nearShoulder.map((p) => p.y)));
  const halfW = Math.max(...nearShoulder.map((p) => Math.abs(p.x))) * 0.7;
  const scale = (F.span * L) / (2 * (half - core));
  const out = { pos, nrm, col: body.col.slice(), idx: body.idx.slice() };
  for (const side of [1, -1]) {
    const tri = keep.filter((_, k) => Math.sign(wp[keep[k - (k % 3)] * 3]) === side);
    const verts = [...new Set(tri)];
    // Root: the innermost vertices; dihedral: root to tip.
    const inner = verts.filter((v) => Math.abs(wp[v * 3]) < core + 0.08 * half);
    const root = new THREE.Vector3(mean(inner.map((v) => wp[v * 3])), mean(inner.map((v) => wp[v * 3 + 1])), mean(inner.map((v) => wp[v * 3 + 2])));
    let tip = verts[0];
    for (const v of verts) if (Math.abs(wp[v * 3]) > Math.abs(wp[tip * 3])) tip = v;
    const up = Math.atan2(wp[tip * 3 + 1] - root.y, Math.abs(wp[tip * 3] - root.x));
    const flat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -side * up);
    const map = new Map();
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (const v of verts) {
      map.set(v, out.pos.length / 3);
      p.fromArray(wp, v * 3).sub(root).applyQuaternion(flat).multiplyScalar(scale).add(new THREE.Vector3(side * halfW, shoulderY, shoulderZ));
      out.pos.push(p.x, p.y, p.z);
      n.fromArray(wings.nrm, v * 3).applyQuaternion(flat);
      out.nrm.push(n.x, n.y, n.z);
      const t = F.wingTint ?? [1, 1, 1];
      out.col.push(wings.col[v * 3] * t[0], wings.col[v * 3 + 1] * t[1], wings.col[v * 3 + 2] * t[2]);
    }
    for (const v of tri) out.idx.push(map.get(v));
  }
  return out;
}
