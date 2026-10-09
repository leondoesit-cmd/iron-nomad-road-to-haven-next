import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { StoneTarget } from '../physics/physics';
import { PEBBLE_BASE, pebbleParts } from '../render/scatter';
import { clamp } from '../core/math';
import type { Ctx } from './ctx';

/**
 * Stones lying about, struck by a round. What happens to one is down to its size, the round's energy and the angle it
 * comes in at:
 *
 * - **Shattered.** A stone breaks when the blow brings more than it costs to split it, which grows with its cross-section
 *   (`BREAK` J per m^2 of its width squared): a rifle round splits a stone a forearm across, a pistol round one a hand
 *   across, a shotgun pellet a walnut. The harder the blow is against that, the more pieces and the smaller: a blow that
 *   barely splits it leaves a few big pieces; one far over it leaves many small ones and dust. Square on, they burst out
 *   all round; glancing, they fly on the way the round was going.
 * - **Knocked away.** A stone too big to split but light enough is shoved by the round's momentum: it jumps off its place
 *   and tumbles, chipped where it was struck.
 * - **Chipped.** A rock or a boulder only loses a cone of itself (`Gore.spall`), in chips as big as the blow and its angle
 *   make them.
 *
 * A stone of a cluster leaves the others where they lay, now loose. A stone broken or knocked off stays gone (`stoneKey`).
 */

/** What it costs to split a stone, J per m^2 of its width squared (weathered desert sandstone and limestone). */
const BREAK = 7e3;
/** Rock, kg/m^3. */
const RHO = 2600;
/** A stone moves off its place when a round gives it at least this, m/s. */
const KNOCK = 0.35;

export type StoneResult = { did: 'shattered' | 'knocked' | 'chipped'; tint: [number, number, number] };

const _m = new THREE.Matrix4();
const _inv = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _v = new THREE.Vector3();
const _yaw = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);

/** A stone of its own, for a piece that is loose now: an icosahedron of its size, pushed in and out. */
function stoneGeometry(sx: number, sy: number, sz: number, seed: number, rgb: readonly number[], surf: readonly number[]): THREE.BufferGeometry {
  // Fine enough to read as a rounded stone, not a cut gem.
  const g = mergeVertices(new THREE.IcosahedronGeometry(0.5, 3));
  const pos = g.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    _v.fromBufferAttribute(pos, i);
    // Lumps over the whole stone, not a spike per corner.
    const u = 0.5 + 0.25 * Math.sin(_v.x * 7 + seed) * Math.sin(_v.y * 6 + seed * 1.7) + 0.25 * Math.sin(_v.z * 8 + _v.x * 3 + seed * 2.3);
    _v.multiplyScalar(0.86 + 0.22 * u);
    pos.setXYZ(i, _v.x * sx, _v.y * sy, _v.z * sz);
    const k = 0.92 + 0.16 * u;
    col[i * 3] = rgb[0] * k;
    col[i * 3 + 1] = rgb[1] * k;
    col[i * 3 + 2] = rgb[2] * k;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  // The kit material's own per-vertex surface (roughness, metal, wear), as the stone it came from had it.
  const sf = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) sf.set(surf, i * 4);
  g.setAttribute('surf', new THREE.BufferAttribute(sf, 4));
  g.computeVertexNormals();
  return g;
}

const surfs = new WeakMap<THREE.BufferGeometry, number[]>();

/** The mean of a geometry's kit surface attribute (roughness, metal, wear, and its fourth), or a matt stone's. */
function meanSurf(g: THREE.BufferGeometry): number[] {
  let m = surfs.get(g);
  if (!m) {
    const a = g.getAttribute('surf') as THREE.BufferAttribute | undefined;
    m = [0.95, 0, 0.3, 1];
    if (a) {
      m = [0, 0, 0, 0];
      for (let i = 0; i < a.count; i++) {
        m[0] += a.getX(i);
        m[1] += a.getY(i);
        m[2] += a.getZ(i);
        m[3] += a.itemSize > 3 ? a.getW(i) : 1;
      }
      m = m.map((v) => v / a.count);
    }
    surfs.set(g, m);
  }
  return m;
}

const means = new WeakMap<THREE.BufferGeometry, [number, number, number]>();

/** The mean of a geometry's vertex colours (what its material draws it in before an instance's tint), or a fallback. */
function meanColour(g: THREE.BufferGeometry, fallback: number): [number, number, number] {
  let m = means.get(g);
  if (!m) {
    const a = g.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (a) {
      m = [0, 0, 0];
      for (let i = 0; i < a.count; i++) {
        m[0] += a.getX(i);
        m[1] += a.getY(i);
        m[2] += a.getZ(i);
      }
      m = [m[0] / a.count, m[1] / a.count, m[2] / a.count];
    } else {
      _c.setHex(fallback);
      m = [_c.r, _c.g, _c.b];
    }
    means.set(g, m);
  }
  return [m[0], m[1], m[2]];
}

/**
 * A round of `ke` joules and momentum `mom` (kg m/s) struck the stone `t` at (x, y, z) on its face of normal n, going along
 * d. Returns what became of it and the colour it is (for the chips and the mark when it was only chipped: the caller's
 * `Gore.impact` does that part).
 */
export function stoneHit(ctx: Ctx, t: StoneTarget, x: number, y: number, z: number, nx: number, ny: number, nz: number, dx: number, dy: number, dz: number, ke: number, mom: number): StoneResult {
  const im = t.im as THREE.InstancedMesh;
  im.getMatrixAt(t.i, _m);
  _m.decompose(_p, _q, _s);
  const scale = (_s.x + _s.y + _s.z) / 3;
  // Its colour as drawn: its rock's vertex colour, times its own tint.
  const tint = meanColour(im.geometry, t.kind === 'pebble' ? PEBBLE_BASE[t.v % 3] : 0x9a6a4e);
  if (im.instanceColor) {
    im.getColorAt(t.i, _c);
    tint[0] *= _c.r;
    tint[1] *= _c.g;
    tint[2] *= _c.b;
  }
  // Boulders and the big single rocks only chip.
  if (t.kind !== 'pebble' || t.v === 2) return { did: 'chipped', tint };
  const parts = pebbleParts(t.v);
  // Which of its stones the round struck: the one whose middle is nearest, against its size.
  _inv.copy(_m).invert();
  _v.set(x, y, z).applyMatrix4(_inv);
  let hit = 0;
  let best = Infinity;
  parts.forEach((p, k) => {
    const d = Math.hypot((_v.x - p.c[0]) / p.s[0], (_v.y - p.c[1]) / p.s[1], (_v.z - p.c[2]) / p.s[2]);
    if (d < best) {
      best = d;
      hit = k;
    }
  });
  const part = parts[hit];
  const width = ((part.s[0] + part.s[1] + part.s[2]) / 3) * scale;
  const mass = RHO * (Math.PI / 6) * part.s[0] * part.s[1] * part.s[2] * scale * scale * scale;
  const dl = Math.hypot(dx, dy, dz) || 1;
  dx /= dl;
  dy /= dl;
  dz /= dl;
  const square = Math.min(1, Math.abs(dx * nx + dy * ny + dz * nz));
  const e = ke * (0.3 + 0.7 * square);
  const cost = BREAK * width * width;
  const shatter = e >= cost;
  const knock = !shatter && mom / mass >= KNOCK;
  if (!shatter && !knock) return { did: 'chipped', tint };
  // It comes out of the world as it was drawn; what is left of the cluster lies loose where it lay.
  t.remove();
  const world = (k: number) => _v.set(parts[k].c[0], parts[k].c[1], parts[k].c[2]).applyMatrix4(_m);
  for (let k = 0; k < parts.length; k++) {
    if (k === hit && shatter) continue;
    const p = parts[k];
    const c = world(k).clone();
    const q = _q.clone().multiply(_yaw.setFromAxisAngle(_up, p.yaw));
    const sx = p.s[0] * scale;
    const sy = p.s[1] * scale;
    const sz = p.s[2] * scale;
    const kmass = RHO * (Math.PI / 6) * sx * sy * sz;
    const vel = new THREE.Vector3();
    const spin = new THREE.Vector3();
    if (k === hit) {
      // Shoved by the round: away along its line, a little up, tumbling.
      const u = mom / kmass;
      vel.set(dx * u, Math.abs(dy) * u * 0.3 + u * 0.35, dz * u);
      spin.set((Math.random() - 0.5) * u * 6, (Math.random() - 0.5) * u * 6, (Math.random() - 0.5) * u * 6);
    }
    const shade = 0.92 + 0.16 * Math.random();
    ctx.debris?.spawn({
      // Drawn as it was: the same material, its colour in its vertices.
      geo: stoneGeometry(sx, sy, sz, k * 7 + t.i, [tint[0] * shade, tint[1] * shade, tint[2] * shade], meanSurf(im.geometry)),
      material: im.material as THREE.Material,
      pos: c,
      quat: q,
      vel,
      spin,
      centre: [0, 0, 0],
      half: [sx * 0.45, sy * 0.45, sz * 0.45],
      // The field weighs pieces heavier than they are (`HEFT`): a stone is its own weight.
      mass: kmass / 2.2,
      tag: 'stone',
      keep: true,
      armAfter: 0.2,
    });
  }
  if (knock) {
    // Chipped where it was struck, as it goes.
    ctx.gore?.spall('stone', tint, x, y, z, nx, ny, nz, dx, dy, dz, ke * 0.5);
    ctx.audio.play('chip', x, z, 0.3);
    return { did: 'knocked', tint };
  }
  burst(ctx, world(hit).clone(), width, mass, e, cost, square, nx, ny, nz, dx, dy, dz, tint);
  ctx.audio.play('chip', x, z, clamp(0.25 + e / 3000, 0.25, 0.6), { pitch: 0.85 });
  return { did: 'shattered', tint };
}

/**
 * A stone of `width` metres split by `e` joules against its `cost`: pieces as many and as small as the blow is hard against
 * what split it, the biggest a good share of the stone when it barely went; out all round square on, on along the round's
 * way when it glanced; the fresh faces paler than the weathered outside; dust.
 */
function burst(ctx: Ctx, c: THREE.Vector3, width: number, mass: number, e: number, cost: number, square: number, nx: number, ny: number, nz: number, dx: number, dy: number, dz: number, tint: readonly number[]) {
  const gibs = ctx.gore?.gibs;
  const over = e / cost;
  const n = clamp(Math.round(3 + 3.5 * Math.log2(over) + Math.random() * 2), 3, 16);
  const biggest = clamp(0.62 / Math.cbrt(over), 0.16, 0.62);
  const glance = 1 - square;
  // A quarter of the blow goes into the pieces' flight.
  const v0 = clamp(Math.sqrt((0.5 * 0.25 * e) / Math.max(0.05, mass)), 1.5, 9);
  for (let k = 0; k < n; k++) {
    const f = biggest * Math.pow(k + 1, -0.5) * (0.8 + 0.4 * Math.random());
    const size = width * f;
    // Out from the middle of the stone in a random way, leaning on along the round's way (the more it glanced, the more).
    let ox = Math.random() - 0.5;
    let oy = Math.random() * 0.7;
    let oz = Math.random() - 0.5;
    const ol = Math.hypot(ox, oy, oz) || 1;
    ox /= ol;
    oy /= ol;
    oz /= ol;
    const lean = 0.35 + 0.9 * glance;
    const wx = ox + dx * lean - nx * 0.4 * square;
    const wy = oy + Math.max(0, dy) * lean + 0.3;
    const wz = oz + dz * lean - nz * 0.4 * square;
    const wl = Math.hypot(wx, wy, wz) || 1;
    // Small pieces fly faster.
    const sp = v0 * Math.sqrt(biggest / f) * (0.5 + 0.7 * Math.random());
    const fresh = Math.random() < 0.5 ? 1.25 : 1;
    const k2 = (0.88 + 0.24 * Math.random()) * fresh;
    const shape: [number, number, number] = [0.8 + 0.5 * Math.random(), 0.45 + 0.4 * Math.random(), 0.7 + 0.5 * Math.random()];
    gibs?.throw('chunk', c.x + ox * width * 0.3, c.y + oy * width * 0.3, c.z + oz * width * 0.3, (wx / wl) * sp, (wy / wl) * sp, (wz / wl) * sp, clamp(size / 0.1, 0.03, 2.4), Math.min(1, tint[0] * k2), Math.min(1, tint[1] * k2), Math.min(1, tint[2] * k2), false, shape);
  }
  // The crushed part: grit and a puff of rock dust, more for a hard blow.
  ctx.ground?.grit(c.x, c.y + width * 0.3, c.z, 0, 1, 0, dx * glance, 0, dz * glance, clamp(Math.round(4 + over * 3), 4, 16), 2 + 2 * square, [tint[0], tint[1], tint[2]], Math.max(0.002, width * 0.03));
  ctx.fx.puff(c.x, c.y + width * 0.3, c.z, tint[0] * 1.1, tint[1] * 1.1, tint[2] * 1.1, 0.4 + Math.min(1, width * 3), 0.7);
}
