import * as THREE from 'three';
import { MeshBuilder, S, valueNoise3, type ColorIn, type Prim, type Surf } from './builder';
import { kitMaterial } from './materials';
import { Humanoid } from './humanoid';
import { identityOf, lookOf } from './outfit';
import { disposeTree } from './dispose';
import { smoothstep } from '../core/math';
import { COFFEE_TOP, DRIVEWAY, GARDEN_BOUNDS, GARDEN_LAYOUT, GATE } from '../world/ududHouse';

/**
 * Udud and Nuhat's single-storey house just north of Petah Tikva, its garden and the family barbecue, Amirat at the grill.
 * Metres, y = 0 on the patio, the house behind -Z, the garden toward +Z, the side passage, front garden and gate on the right
 * (+X) out at -Z, and the driveway beyond the gate down to the highway. The numbers live in `world/ududHouse.ts`, where the
 * colliders are built from them too.
 *
 * Everything static is drawn with `MeshBuilder` into the shared kit material, so the world can merge it into one mesh per
 * material. What moves or must stay separate (Amirat, his tongs, the smoke, the window glass, the ceiling fan's blades, the
 * trampoline's net) carries `userData.dynamic = true`.
 */
export { GARDEN_BOUNDS, GARDEN_LAYOUT };

type V3 = [number, number, number];
const TAU = Math.PI * 2;
const frac = (x: number) => x - Math.floor(x);
/** A repeatable 0..1 hash of an index and a salt. */
const hash = (i: number, salt = 0) => frac(Math.sin(i * 127.1 + salt * 311.7 + 0.5) * 43758.5453);

/** Living matter: no grime from the kit shader. */
const plant = (c: number, r = 0.8): Surf => ({ c, r, m: 0, w: 0 });
/** Softly lit interior surfaces, seen through the glass. */
const lit = (c: number, e = 0.16, r = 0.8): Surf => ({ c, r, m: 0, w: 0, e });
const GLASS: Surf = { c: 0x9fb8c0, r: 0.04, m: 0.1, w: 0 };
const GLASS_OPACITY = 0.35;

function mesh(name: string, draw: (b: MeshBuilder) => void, shadow = true) {
  const b = new MeshBuilder();
  b.seed(77);
  b.jitter = 0.025;
  draw(b);
  const out = new THREE.Mesh(b.build(), kitMaterial());
  out.name = name;
  out.castShadow = shadow;
  out.receiveShadow = true;
  return out;
}

/** Kept live and separate by the world's merge: it moves, or it is not opaque kit. */
function dynamic<T extends THREE.Object3D>(o: T): T {
  o.userData.dynamic = true;
  return o;
}

const _col = new THREE.Color();
const _col2 = new THREE.Color();

/** One vertex straight into a builder, for grids, blades and leaves that carry their own colours. */
function vert(b: MeshBuilder, x: number, y: number, z: number, nx: number, ny: number, nz: number, s: Surf, col: THREE.Color) {
  const i = b.pos.length / 3;
  b.pos.push(x, y, z);
  b.nor.push(nx, ny, nz);
  b.col.push(col.r, col.g, col.b);
  b.srf.push(s.r ?? 0.82, s.m ?? 0, s.w ?? 0.5, s.e ?? 0);
  b.uv.push(0, 0);
  return i;
}

/** A surface with a per-vertex colour (`paint` writes into `out`), on a grid of u and v lines; `skip` drops cells. */
function grid(b: MeshBuilder, us: number[], vs: number[], at: (u: number, v: number) => V3, n: V3, s: Surf, paint: (u: number, v: number, out: THREE.Color) => void, skip?: (u: number, v: number) => boolean) {
  const nu = us.length;
  const base = b.pos.length / 3;
  for (let j = 0; j < vs.length; j++) for (let i = 0; i < nu; i++) {
    const p = at(us[i], vs[j]);
    paint(us[i], vs[j], _col);
    vert(b, p[0], p[1], p[2], n[0], n[1], n[2], s, _col);
  }
  const p0 = at(us[0], vs[0]);
  const pu = at(us[1], vs[0]);
  const pv = at(us[0], vs[1]);
  const ux = pu[0] - p0[0], uy = pu[1] - p0[1], uz = pu[2] - p0[2];
  const wx = pv[0] - p0[0], wy = pv[1] - p0[1], wz = pv[2] - p0[2];
  const flip = (uy * wz - uz * wy) * n[0] + (uz * wx - ux * wz) * n[1] + (ux * wy - uy * wx) * n[2] < 0;
  for (let j = 0; j < vs.length - 1; j++) for (let i = 0; i < nu - 1; i++) {
    if (skip && skip((us[i] + us[i + 1]) / 2, (vs[j] + vs[j + 1]) / 2)) continue;
    const a = base + j * nu + i;
    const c = a + nu + 1;
    if (flip) b.idx.push(a, c, a + 1, a, a + nu, c);
    else b.idx.push(a, a + 1, c, a, c, a + nu);
  }
}

/** Grid lines from a to b about `step` apart, with the extra lines that fall inside. */
function steps(a: number, b: number, step: number, extra: number[] = []) {
  const out = [a, b, ...extra.filter((x) => x > a + 1e-4 && x < b - 1e-4)];
  const n = Math.max(1, Math.round((b - a) / step));
  for (let i = 1; i < n; i++) out.push(a + ((b - a) * i) / n);
  out.sort((x, y) => x - y);
  return out.filter((x, i) => i === 0 || x - out[i - 1] > 2e-3);
}

/** Multiply the colours of every vertex from `v0` on. */
function shadeFrom(b: MeshBuilder, v0: number, k: (x: number, y: number, z: number) => number) {
  for (let v = v0; v < b.pos.length / 3; v++) {
    const f = k(b.pos[v * 3], b.pos[v * 3 + 1], b.pos[v * 3 + 2]);
    b.col[v * 3] *= f;
    b.col[v * 3 + 1] *= f;
    b.col[v * 3 + 2] *= f;
  }
}

/** A colour scaled, as a surface the builder accepts. */
function tone(s: Surf, k: number): Surf {
  return { ...s, c: new THREE.Color(s.c as number).multiplyScalar(k) };
}

// ------------------------------------------------------------------------------------------------- foliage helpers

interface Blob { x: number; y: number; z: number; rx: number; ry: number; rz: number }

/** Lumpy masses of foliage: the blobs, displaced by noise. Returns the first vertex. */
function blobs(b: MeshBuilder, list: Blob[], s: Surf, amp: number, freq: number, seed: number, prim: Prim = 'ico1') {
  const v0 = b.vertexCount;
  for (const o of list) b.add(prim, o.x, o.y, o.z, o.rx * 2, o.ry * 2, o.rz * 2, s);
  b.displace(amp, freq, seed, v0);
  return v0;
}

/** A point on the skin of one of the blobs and its outward direction, or null when it faces below `minY`. */
function onBlobs(list: Blob[], i: number, seed: number, lift = 1, minY = -1): { p: V3; n: V3 } | null {
  const o = list[i % list.length];
  const u = hash(i, seed) * 2 - 1;
  if (u < minY) return null;
  const phi = hash(i, seed + 1) * TAU;
  const r = Math.sqrt(1 - u * u);
  const n: V3 = [Math.cos(phi) * r, u, Math.sin(phi) * r];
  return { p: [o.x + n[0] * o.rx * lift, o.y + n[1] * o.ry * lift, o.z + n[2] * o.rz * lift], n };
}

/** A small leaf on a crown: a two-sided diamond, lit as if it faced outward (`n`) so the crown shades as one mass. */
function leaf(b: MeshBuilder, p: V3, n: V3, len: number, wid: number, s: Surf, hex: number, k: number, spin: number) {
  // A tangent frame round the outward direction, turned by `spin`, the tip lifted outward.
  let ax = 0, ay = 1, az = 0;
  if (Math.abs(n[1]) > 0.9) { ax = 1; ay = 0; }
  let tx = n[1] * az - n[2] * ay, ty = n[2] * ax - n[0] * az, tz = n[0] * ay - n[1] * ax;
  let l = Math.hypot(tx, ty, tz) || 1;
  tx /= l; ty /= l; tz /= l;
  const bx = n[1] * tz - n[2] * ty, by = n[2] * tx - n[0] * tz, bz = n[0] * ty - n[1] * tx;
  const c = Math.cos(spin), sn = Math.sin(spin);
  let dx = tx * c + bx * sn + n[0] * 0.45, dy = ty * c + by * sn + n[1] * 0.45 - 0.25, dz = tz * c + bz * sn + n[2] * 0.45;
  l = Math.hypot(dx, dy, dz) || 1;
  dx /= l; dy /= l; dz /= l;
  const wx = n[1] * dz - n[2] * dy, wy = n[2] * dx - n[0] * dz, wz = n[0] * dy - n[1] * dx;
  _col.set(hex).multiplyScalar(k);
  _col2.copy(_col).multiplyScalar(0.72);
  const i0 = vert(b, p[0] - dx * len * 0.3, p[1] - dy * len * 0.3, p[2] - dz * len * 0.3, n[0], n[1], n[2], s, _col2);
  const i1 = vert(b, p[0] + wx * wid * 0.5, p[1] + wy * wid * 0.5, p[2] + wz * wid * 0.5, n[0], n[1], n[2], s, _col);
  const i2 = vert(b, p[0] + dx * len * 0.7, p[1] + dy * len * 0.7, p[2] + dz * len * 0.7, n[0], n[1], n[2], s, _col);
  const i3 = vert(b, p[0] - wx * wid * 0.5, p[1] - wy * wid * 0.5, p[2] - wz * wid * 0.5, n[0], n[1], n[2], s, _col);
  b.idx.push(i0, i1, i2, i0, i2, i3, i0, i2, i1, i0, i3, i2);
}

/** Leaves scattered over the skins of some blobs. */
function blobLeaves(b: MeshBuilder, list: Blob[], count: number, hexes: number[], len: number, wid: number, seed: number, s: Surf, minY = -0.75) {
  for (let i = 0; i < count; i++) {
    const at = onBlobs(list, i, seed, 0.96 + hash(i, seed + 2) * 0.14, minY);
    if (!at) continue;
    const k = 0.8 + 0.35 * smoothstep(-0.6, 0.9, at.n[1]) + (hash(i, seed + 3) - 0.5) * 0.2;
    leaf(b, at.p, at.n, len * (0.8 + hash(i, seed + 4) * 0.4), wid, s, hexes[i % hexes.length], k, hash(i, seed + 5) * TAU);
  }
}

/** A leaf clump: an octahedron, eight flat facets that each catch the light their own way. */
const CLUMP = new THREE.OctahedronGeometry(0.5, 0);

/**
 * Foliage as a mass of small faceted leaf clumps scattered through the skin of a lumpy ellipsoid round a dark core: a broken,
 * leafy silhouette that catches the light facet by facet. `accent` (with its share) mixes in flowers or bracts among them.
 * Returns the points the clumps sit on, for fruit.
 */
function foliage(b: MeshBuilder, cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, count: number, size: number, hexes: number[], seed: number, opts: { minY?: number; lump?: number; accent?: number[]; share?: number; gloss?: number; core?: number } = {}) {
  const minY = opts.minY ?? -0.8;
  const lump = opts.lump ?? 0.2;
  const leafR = opts.gloss ?? 0.7;
  const v0 = b.vertexCount;
  const core = opts.core ?? 1.55;
  b.add('ico1', cx, cy, cz, rx * core, ry * core * 0.97, rz * core, plant(hexes[0], 0.9));
  shadeFrom(b, v0, () => 0.5);
  const skin: { p: V3; n: V3 }[] = [];
  for (let i = 0; i < count; i++) {
    const u = 1 - (2 * (i + 0.5)) / count;
    if (u < minY) continue;
    const r = Math.sqrt(1 - u * u);
    const phi = i * 2.39996 + seed;
    const nx = Math.cos(phi) * r, ny = u, nz = Math.sin(phi) * r;
    const bump = 1 + lump * (valueNoise3(nx * 1.7 + seed, ny * 1.7, nz * 1.7, seed) - 0.5) * 2;
    const depth = 0.8 + hash(i, seed) * 0.24;
    const k = bump * depth;
    const p: V3 = [cx + nx * rx * k, cy + ny * ry * k, cz + nz * rz * k];
    skin.push({ p: [cx + nx * rx * bump, cy + ny * ry * bump, cz + nz * rz * bump], n: [nx, ny, nz] });
    const sz = size * (0.65 + hash(i, seed + 1) * 0.7);
    const accent = opts.accent && hash(i, seed + 4) < (opts.share ?? 0);
    const hex = accent ? opts.accent![i % opts.accent!.length] : hexes[i % hexes.length];
    const shade = accent ? 0.9 + hash(i, seed + 5) * 0.2 : (0.6 + 0.42 * smoothstep(-0.7, 0.85, ny)) * (0.78 + 0.28 * (depth - 0.8) / 0.24) * (0.9 + hash(i, seed + 6) * 0.2);
    b.geo(CLUMP, p[0], p[1], p[2], sz, sz * 0.62, sz, tone(plant(hex, accent ? 0.75 : leafR), shade), hash(i, seed + 2) * 3, hash(i, seed + 3) * 3, 0);
  }
  return skin;
}

/** Leafy shrub with an optional crop of flowers. */
function shrub(b: MeshBuilder, x: number, z: number, r: number, h: number, leafHex: number, flowerHex: number | null, flowers: number, seed: number) {
  const count = Math.round(45 + r * r * 800);
  const size = Math.max(0.06, r * 0.36);
  const light = new THREE.Color(leafHex).multiplyScalar(1.18).getHex();
  const dark = new THREE.Color(leafHex).multiplyScalar(0.82).getHex();
  foliage(b, x, h * 0.5, z, r, h * 0.5, r * 0.94, count, size, [leafHex, light, dark], seed, {
    minY: -0.55,
    accent: flowerHex === null ? undefined : [flowerHex, flowerHex, 0xffffff],
    share: flowerHex === null ? 0 : Math.min(0.45, flowers / count),
  });
}

// ------------------------------------------------------------------------------------------------- the house's frame

const HB = GARDEN_BOUNDS.house;
const WALL_TOP = 3.04;
const ROOF_TOP = 3.18;
const PARAPET = 3.42;
/** How far the solid inside of the house stands back from the rendered skin: the depth of every reveal. */
const CORE = 0.22;
/** The living room behind the sliding door, the one room seen into. */
const ROOM = { x0: HB.minX + CORE, x1: -2.6, z0: -7.6, z1: HB.maxZ - CORE, h: 2.86 };

/** One outer wall: its plane, the axis it runs along, its outward side, its extent and its base course's top. */
interface Facade { along: 'x' | 'z'; c: number; n: 1 | -1; a0: number; a1: number; base: number; seed: number }
type FacadeId = 'garden' | 'street' | 'left' | 'right';
const FACADES: Record<FacadeId, Facade> = {
  garden: { along: 'x', c: HB.maxZ, n: 1, a0: HB.minX, a1: HB.maxX, base: 0.32, seed: 3 },
  street: { along: 'x', c: HB.minZ, n: -1, a0: HB.minX, a1: HB.maxX, base: 0.5, seed: 5 },
  left: { along: 'z', c: HB.minX, n: -1, a0: HB.minZ, a1: HB.maxZ, base: 0.5, seed: 7 },
  right: { along: 'z', c: HB.maxX, n: 1, a0: HB.minZ, a1: HB.maxZ, base: 0.32, seed: 9 },
};

type OpeningKind = 'window' | 'small' | 'slider' | 'door' | 'front';
/** A hole in a wall: along-wall extent, sill and head heights; `shutter` is how far the trissim are down (0 up, 1 shut). */
interface Opening { a0: number; a1: number; y0: number; y1: number; kind: OpeningKind; shutter?: number; grille?: boolean; curtain?: number; cover?: number }
const OPENINGS: Record<FacadeId, Opening[]> = {
  garden: [
    { a0: -5.75, a1: -3.15, y0: 0.02, y1: 2.25, kind: 'slider', shutter: 0 },
    { a0: -1.45, a1: -0.35, y0: 0.3, y1: 2.42, kind: 'door', shutter: 0.22, curtain: 0xeee6d2 },
    { a0: 1.72, a1: 3.28, y0: 1.3, y1: 2.5, kind: 'window', shutter: 0.45, curtain: 0xe9e0cb, cover: 0.62 },
  ],
  street: [
    { a0: -6.0, a1: -4.6, y0: 1.0, y1: 2.3, kind: 'window', shutter: 1, grille: true },
    { a0: -3.0, a1: -1.4, y0: 1.0, y1: 2.3, kind: 'window', shutter: 0.38, grille: true, curtain: 0xd9cdb2, cover: 0.45 },
    { a0: 0.35, a1: 0.95, y0: 1.75, y1: 2.3, kind: 'small', grille: true },
    { a0: 3.3, a1: 4.3, y0: 0.17, y1: 2.32, kind: 'front' },
  ],
  left: [
    { a0: -10.05, a1: -8.75, y0: 1.0, y1: 2.3, kind: 'window', shutter: 0.62, grille: true, curtain: 0xc8d4d8, cover: 0.7 },
    { a0: -8.3, a1: -7.8, y0: 1.75, y1: 2.3, kind: 'small', grille: true },
  ],
  right: [{ a0: -9.6, a1: -8.4, y0: 1.1, y1: 2.3, kind: 'window', shutter: 0.25, curtain: 0xf0ede4, cover: 0.5 }],
};

/** A point on a facade: `a` along it, height `y`, `d` in from the skin (negative is out in front of it). */
function fp(f: Facade, a: number, y: number, d: number): V3 {
  return f.along === 'x' ? [a, y, f.c - f.n * d] : [f.c - f.n * d, y, a];
}
const fnorm = (f: Facade): V3 => (f.along === 'x' ? [0, 0, f.n] : [f.n, 0, 0]);
/** The way "right" runs along a facade for someone standing in front of it, in `a`. */
const fright = (f: Facade) => (f.along === 'x' ? f.n : -f.n);

/** A box set in a facade's frame; `tilt` leans its top edge outward. */
function fbox(b: MeshBuilder, f: Facade, a: number, y: number, d: number, sa: number, sy: number, sd: number, s: ColorIn, tilt = 0) {
  const p = fp(f, a, y, d);
  if (f.along === 'x') b.box(p[0], y, p[2], sa, sy, sd, s, tilt * f.n, 0, 0);
  else b.box(p[0], y, p[2], sd, sy, sa, s, 0, 0, -tilt * f.n);
}
function frbox(b: MeshBuilder, f: Facade, a: number, y: number, d: number, sa: number, sy: number, sd: number, r: number, s: ColorIn) {
  const p = fp(f, a, y, d);
  if (f.along === 'x') b.rbox(p[0], y, p[2], sa, sy, sd, r, s);
  else b.rbox(p[0], y, p[2], sd, sy, sa, r, s);
}
function frod(b: MeshBuilder, f: Facade, a0: number, y0: number, d0: number, a1: number, y1: number, d1: number, r: number, s: ColorIn, seg = 8) {
  const p = fp(f, a0, y0, d0);
  const q = fp(f, a1, y1, d1);
  b.rod(p[0], p[1], p[2], q[0], q[1], q[2], r, s, seg);
}
/** A ring or disc facing out of the facade. */
function ftorus(b: MeshBuilder, f: Facade, a: number, y: number, d: number, R: number, r: number, s: ColorIn, tubular = 20) {
  const p = fp(f, a, y, d);
  b.torus(p[0], p[1], p[2], R, r, s, 0, f.along === 'x' ? 0 : Math.PI / 2, 0, 6, tubular);
}
function fdisc(b: MeshBuilder, f: Facade, a: number, y: number, d: number, r: number, depth: number, s: ColorIn, seg = 20) {
  const p = fp(f, a, y, d);
  if (f.along === 'x') b.cyl(p[0], p[1], p[2], r * 2, depth, r * 2, s, Math.PI / 2, 0, 0, seg);
  else b.cyl(p[0], p[1], p[2], r * 2, depth, r * 2, s, 0, 0, Math.PI / 2, seg);
}

/** Seven-segment strokes for a painted house number. */
const SEGMENTS: Record<string, string> = { '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd', '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg' };
function houseNumber(b: MeshBuilder, f: Facade, text: string, a: number, y: number, d: number, h: number, s: ColorIn) {
  const w = h * 0.5;
  const t = h * 0.13;
  const r = fright(f);
  [...text].forEach((ch, i) => {
    const ax = a + r * (i - (text.length - 1) / 2) * (w + t * 2.2);
    for (const seg of SEGMENTS[ch] ?? '') {
      if (seg === 'a') fbox(b, f, ax, y + h / 2, d, w, t, 0.004, s);
      if (seg === 'g') fbox(b, f, ax, y, d, w, t, 0.004, s);
      if (seg === 'd') fbox(b, f, ax, y - h / 2, d, w, t, 0.004, s);
      if (seg === 'b') fbox(b, f, ax + (r * w) / 2, y + h / 4, d, t, h / 2, 0.004, s);
      if (seg === 'c') fbox(b, f, ax + (r * w) / 2, y - h / 4, d, t, h / 2, 0.004, s);
      if (seg === 'f') fbox(b, f, ax - (r * w) / 2, y + h / 4, d, t, h / 2, 0.004, s);
      if (seg === 'e') fbox(b, f, ax - (r * w) / 2, y - h / 4, d, t, h / 2, 0.004, s);
    }
  });
}

// ------------------------------------------------------------------------------------------------- walls and roof

const RENDER = 0xe9e2d0;
const renderSurf = S.concrete(RENDER, 0.16);

/** Patchy, sun-faded render with splash dirt at the foot and rain streaks under the sills and the coping. */
function renderPaint(f: Facade, ops: Opening[]) {
  const base = new THREE.Color(RENDER);
  return (a: number, y: number, out: THREE.Color) => {
    let k = 1 + (valueNoise3(a * 0.45, y * 0.45, f.seed, 17) - 0.5) * 0.14 + (valueNoise3(a * 1.9, y * 1.9, f.seed, 23) - 0.5) * 0.06;
    k *= 1 - 0.15 * (1 - smoothstep(f.base, f.base + 0.8, y));
    for (const o of ops) {
      if (o.kind !== 'window' && o.kind !== 'small') continue;
      if (y >= o.y0 || y < o.y0 - 1.4) continue;
      for (const ax of [o.a0 + 0.06, o.a1 - 0.06]) {
        const t = 1 - Math.abs(a - ax) / 0.1;
        if (t > 0) k *= 1 - 0.18 * t * (1 - (o.y0 - y) / 1.4);
      }
    }
    if (y > PARAPET - 0.6) k *= 1 - 0.12 * smoothstep(PARAPET - 0.6, PARAPET, y) * (0.4 + valueNoise3(a * 2.6, 0.5, f.seed, 31));
    out.copy(base).multiplyScalar(k);
  };
}

/** One outer wall: render skin round its openings, a limestone base course, reveals, cornice, parapet and coping. */
function drawFacade(b: MeshBuilder, f: Facade, ops: Opening[]) {
  const extraA: number[] = [];
  const extraY: number[] = [];
  for (const o of ops) {
    extraA.push(o.a0, o.a1);
    extraY.push(o.y0, o.y1);
    if (o.kind === 'window' || o.kind === 'small') for (const ax of [o.a0 + 0.06, o.a1 - 0.06]) extraA.push(ax - 0.1, ax, ax + 0.1);
  }
  const as = steps(f.a0, f.a1, 0.35, extraA);
  const ys = steps(f.base, PARAPET, 0.3, [...extraY, PARAPET - 0.6, PARAPET - 0.3]);
  grid(b, as, ys, (a, y) => fp(f, a, y, 0), fnorm(f), renderSurf, renderPaint(f, ops), (a, y) => ops.some((o) => a > o.a0 && a < o.a1 && y > o.y0 && y < o.y1));

  // Limestone base course: rows of dressed blocks proud of a mortar bed, with a projecting cap.
  const y0 = -0.3;
  const rows = f.base > 0.4 ? 3 : 2;
  const rowH = (f.base - y0) / rows;
  const gaps = ops.filter((o) => o.y0 < f.base).map((o) => [o.a0, o.a1]).sort((p, q) => p[0] - q[0]);
  const runs: [number, number][] = [];
  let from = f.a0 - 0.05;
  for (const [g0, g1] of gaps) {
    if (g0 > from) runs.push([from, g0]);
    from = Math.max(from, g1);
  }
  if (f.a1 + 0.05 > from) runs.push([from, f.a1 + 0.05]);
  const stones = [0xd9cfb6, 0xcfc3a7, 0xe1d8c2, 0xc8bb9f, 0xd4c7ab];
  let k = 0;
  for (const [s0, s1] of runs) {
    fbox(b, f, (s0 + s1) / 2, (y0 + f.base) / 2, -0.012, s1 - s0, f.base - y0, 0.024, S.concrete(0xa59d8b, 0.3));
    for (let r = 0; r < rows; r++) {
      let a = s0 - (r % 2 ? 0.22 : 0);
      while (a < s1 - 0.01) {
        const len = 0.36 + hash(k, f.seed) * 0.32;
        const lo = Math.max(a, s0);
        const hi = Math.min(a + len, s1);
        if (hi - lo > 0.06) {
          fbox(b, f, (lo + hi) / 2, y0 + rowH * (r + 0.5), -0.03 - hash(k, f.seed + 1) * 0.008, hi - lo - 0.012, rowH - 0.012, 0.04, S.concrete(stones[k % stones.length], 0.32));
        }
        a += len;
        k++;
      }
    }
    fbox(b, f, (s0 + s1) / 2, f.base + 0.013, -0.028, s1 - s0, 0.026, 0.07, S.concrete(0xe6dfcd, 0.25));
  }

  // Reveals round every opening, rendered like the wall.
  for (const o of ops) {
    const yc = (o.y0 + o.y1) / 2;
    fbox(b, f, o.a0 - 0.01, yc, CORE / 2 + 0.001, 0.02, o.y1 - o.y0, CORE - 0.002, renderSurf);
    fbox(b, f, o.a1 + 0.01, yc, CORE / 2 + 0.001, 0.02, o.y1 - o.y0, CORE - 0.002, renderSurf);
    fbox(b, f, (o.a0 + o.a1) / 2, o.y1 + 0.01, CORE / 2 + 0.001, o.a1 - o.a0 + 0.04, 0.02, CORE - 0.002, renderSurf);
    fbox(b, f, (o.a0 + o.a1) / 2, o.y0 - 0.01, CORE / 2 + 0.001, o.a1 - o.a0 + 0.04, 0.02, CORE - 0.002, renderSurf);
    if (o.kind === 'window' || o.kind === 'small') {
      // Stone sill with a drip edge.
      fbox(b, f, (o.a0 + o.a1) / 2, o.y0 - 0.018, 0.012, o.a1 - o.a0 + 0.1, 0.036, 0.175, S.concrete(0xe7e1d3, 0.18));
      fbox(b, f, (o.a0 + o.a1) / 2, o.y0 - 0.04, -0.06, o.a1 - o.a0 + 0.1, 0.012, 0.02, S.concrete(0xd2cbbb, 0.2));
    }
  }

  // The parapet's inner face, and the coping along its top.
  const len = f.a1 - f.a0;
  fbox(b, f, (f.a0 + f.a1) / 2, (ROOF_TOP + PARAPET) / 2, CORE - 0.01, len - 2 * CORE, PARAPET - ROOF_TOP, 0.02, renderSurf);
  fbox(b, f, (f.a0 + f.a1) / 2, PARAPET + 0.025, 0.11, len + 0.06, 0.05, 0.28, S.concrete(0xd9d4c6, 0.3));
  // A rendered band under the parapet (the patio cover meets the garden wall there instead).
  if (f !== FACADES.garden) fbox(b, f, (f.a0 + f.a1) / 2, 2.99, -0.024, len + 0.1, 0.1, 0.05, S.concrete(0xefe9d9, 0.16));
}

/** The solid inside of the house: two blocks round the living room, which is hollow and softly lit. */
function drawCore(b: MeshBuilder) {
  const core = S.concrete(0xcfc6b1, 0.2);
  const x1 = HB.maxX - CORE;
  const z0 = HB.minZ + CORE;
  b.box((ROOM.x1 + x1) / 2, WALL_TOP / 2, (z0 + ROOM.z1) / 2, x1 - ROOM.x1, WALL_TOP, ROOM.z1 - z0, core);
  b.box((ROOM.x0 + ROOM.x1) / 2, WALL_TOP / 2, (z0 + ROOM.z0) / 2, ROOM.x1 - ROOM.x0, WALL_TOP, ROOM.z0 - z0, core);
  // The roof slab, white-coated, with drain grates.
  b.box((ROOM.x0 + x1) / 2, (WALL_TOP + ROOF_TOP) / 2, (z0 + ROOM.z1) / 2, x1 - ROOM.x0, ROOF_TOP - WALL_TOP, ROOM.z1 - z0, S.paint(0xdedbd2, 0.45));
  for (const [x, z] of [[-6.6, -10.3], [4.4, -5.1], [4.4, -10.3]] as const) b.box(x, ROOF_TOP + 0.004, z, 0.16, 0.008, 0.16, S.steel(0x4d4f4c, 0.5));
}

/** The trissim: aluminium slats rolled down from a slot under the lintel, running in rails at the jambs. */
function trissim(b: MeshBuilder, f: Facade, o: Opening, shut: number) {
  const W = o.a1 - o.a0;
  const H = o.y1 - o.y0;
  const aC = (o.a0 + o.a1) / 2;
  const slat = S.paint(0xd8d4c8, 0.22);
  for (const a of [o.a0 + 0.022, o.a1 - 0.022]) fbox(b, f, a, (o.y0 + o.y1) / 2, 0.05, 0.044, H, 0.05, S.paint(0xcac6ba, 0.22));
  fbox(b, f, aC, o.y1 - 0.02, 0.06, W - 0.04, 0.04, 0.06, S.paint(0x3b3a36, 0.2));
  const bottom = o.y1 - 0.04 - shut * (H - 0.04);
  for (let y = o.y1 - 0.067; y > bottom + 0.03; y -= 0.054) {
    fbox(b, f, aC, y + 0.0135, 0.055, W - 0.06, 0.028, 0.012, slat, 0.3);
    fbox(b, f, aC, y - 0.0135, 0.055, W - 0.06, 0.028, 0.012, tone(slat, 0.92), -0.3);
  }
  fbox(b, f, aC, bottom, 0.055, W - 0.05, 0.036, 0.028, S.paint(0xb9b5a9, 0.3));
}

/** A curtain behind the glass: soft folds over `cover` of the width, the dim room beyond the rest. */
function curtain(b: MeshBuilder, f: Facade, a0: number, a1: number, y0: number, y1: number, hex: number, cover: number) {
  const W = a1 - a0;
  const folds = Math.max(2, Math.round((W * cover) / 0.085));
  const fw = (W * cover) / folds;
  for (let i = 0; i < folds; i++) fbox(b, f, a0 + fw * (i + 0.5), (y0 + y1) / 2, 0.19 + (i % 2) * 0.012, fw * 1.15, y1 - y0, 0.014, lit(i % 2 ? hex : new THREE.Color(hex).multiplyScalar(0.88).getHex(), 0.08, 0.95));
  if (cover < 1) fbox(b, f, a0 + W * cover + (W * (1 - cover)) / 2, (y0 + y1) / 2, 0.212, W * (1 - cover), y1 - y0, 0.008, lit(0x3a342c, 0.05));
}

/** An aluminium window: frame, two sliding sashes, glass, curtain, trissim and (on the road side) a white iron grille. */
function windowUnit(b: MeshBuilder, glass: MeshBuilder, f: Facade, o: Opening) {
  const W = o.a1 - o.a0;
  const aC = (o.a0 + o.a1) / 2;
  const alu = S.paint(0xedece6, 0.12);
  const shut = o.shutter ?? 0;
  if (o.kind === 'window') trissim(b, f, o, shut);
  const top = o.kind === 'window' ? o.y1 - 0.04 : o.y1;
  if (shut < 0.98) {
    const fw = 0.05;
    const yc = (o.y0 + top) / 2;
    const h = top - o.y0;
    fbox(b, f, aC, top - fw / 2, 0.13, W, fw, 0.06, alu);
    fbox(b, f, aC, o.y0 + fw / 2, 0.13, W, fw, 0.06, alu);
    for (const a of [o.a0 + fw / 2, o.a1 - fw / 2]) fbox(b, f, a, yc, 0.13, fw, h, 0.06, alu);
    if (o.kind === 'small') {
      // Frosted bathroom glass, tilted open a little at the top.
      fbox(b, f, aC, yc, 0.14, W - 2 * fw, h - 2 * fw, 0.012, { c: 0xdfe4e2, r: 0.3, m: 0, w: 0, e: 0.04 });
    } else {
      const sashes = [
        { a0: o.a0 + fw, a1: aC + 0.02, d: 0.115 },
        { a0: aC - 0.02, a1: o.a1 - fw, d: 0.145 },
      ];
      for (const s of sashes) {
        const sc = (s.a0 + s.a1) / 2;
        const sw = s.a1 - s.a0;
        fbox(b, f, sc, top - fw - 0.02, s.d, sw, 0.04, 0.03, alu);
        fbox(b, f, sc, o.y0 + fw + 0.02, s.d, sw, 0.04, 0.03, alu);
        for (const a of [s.a0 + 0.02, s.a1 - 0.02]) fbox(b, f, a, yc, s.d, 0.04, h - 2 * fw, 0.03, alu);
        fbox(glass, f, sc, yc, s.d, sw - 0.08, h - 2 * fw - 0.08, 0.006, GLASS);
      }
      fbox(b, f, aC - 0.05, yc, 0.096, 0.012, 0.09, 0.012, S.plastic(0x5a5a56, 0.1));
      if (o.curtain !== undefined) curtain(b, f, o.a0 + fw, o.a1 - fw, o.y0 + fw, top - fw, o.curtain, o.cover ?? 0.6);
      else fbox(b, f, aC, yc, 0.212, W - 2 * fw, h - 2 * fw, 0.008, lit(0x3a342c, 0.05));
    }
  }
  if (!o.grille) return;
  // Window bars ("soragim"): a flat frame, round uprights, two rails and a band of rings at the top.
  const iron = S.paint(0xeae8e1, 0.35);
  const ga0 = o.a0 - 0.05, ga1 = o.a1 + 0.05, gy0 = o.y0 + 0.01, gy1 = o.y1 + 0.05;
  const gd = -0.045;
  fbox(b, f, (ga0 + ga1) / 2, gy1, gd, ga1 - ga0, 0.025, 0.012, iron);
  fbox(b, f, (ga0 + ga1) / 2, gy0, gd, ga1 - ga0, 0.025, 0.012, iron);
  for (const a of [ga0, ga1]) fbox(b, f, a, (gy0 + gy1) / 2, gd, 0.025, gy1 - gy0, 0.012, iron);
  const bars = Math.max(3, Math.round((ga1 - ga0) / 0.12));
  for (let i = 1; i < bars; i++) {
    const a = ga0 + ((ga1 - ga0) * i) / bars;
    frod(b, f, a, gy0, gd, a, gy1, gd, 0.007, iron, 6);
    if (gy1 - gy0 > 0.7) ftorus(b, f, a + (ga1 - ga0) / bars / 2, gy1 - 0.075, gd, 0.042, 0.005, iron, 14);
  }
  if (gy1 - gy0 > 0.7) fbox(b, f, (ga0 + ga1) / 2, gy1 - 0.15, gd, ga1 - ga0, 0.02, 0.012, iron);
  fbox(b, f, (ga0 + ga1) / 2, gy0 + (gy1 - gy0) * 0.4, gd, ga1 - ga0, 0.02, 0.012, iron);
  for (const a of [ga0, ga1]) for (const y of [gy0 + 0.05, gy1 - 0.05]) frod(b, f, a, y, gd, a, y, 0.01, 0.006, iron, 5);
}

/** The big sliding door onto the patio: dark aluminium, one leaf slid open, the trissim rolled up. */
function sliderUnit(b: MeshBuilder, glass: MeshBuilder, f: Facade, o: Opening) {
  const dark = S.paint(0x3d4146, 0.12);
  const W = o.a1 - o.a0;
  const H = o.y1 - o.y0;
  const aC = (o.a0 + o.a1) / 2;
  fbox(b, f, aC, o.y0 + 0.012, 0.135, W, 0.024, 0.17, S.metal(0x9a9c9c, 0.2));
  fbox(b, f, aC, o.y1 - 0.03, 0.135, W, 0.06, 0.15, dark);
  for (const a of [o.a0 + 0.03, o.a1 - 0.03]) fbox(b, f, a, (o.y0 + o.y1) / 2, 0.135, 0.06, H, 0.15, dark);
  const leafW = (W - 0.06) / 2 + 0.035;
  const open = 0.74;
  const leaves = [
    { a0: o.a0 + 0.03, d: 0.17 },
    { a0: o.a1 - 0.03 - leafW - open, d: 0.1 },
  ];
  const ly0 = o.y0 + 0.024;
  const ly1 = o.y1 - 0.06;
  for (const l of leaves) {
    const lc = l.a0 + leafW / 2;
    fbox(b, f, l.a0 + 0.035, (ly0 + ly1) / 2, l.d, 0.07, ly1 - ly0, 0.05, dark);
    fbox(b, f, l.a0 + leafW - 0.035, (ly0 + ly1) / 2, l.d, 0.07, ly1 - ly0, 0.05, dark);
    fbox(b, f, lc, ly0 + 0.05, l.d, leafW, 0.1, 0.05, dark);
    fbox(b, f, lc, ly1 - 0.035, l.d, leafW, 0.07, 0.05, dark);
    fbox(glass, f, lc, (ly0 + 0.1 + ly1 - 0.07) / 2, l.d, leafW - 0.14, ly1 - ly0 - 0.17, 0.008, GLASS);
  }
  // The pull handle on the open leaf's edge.
  const edge = leaves[1].a0 + leafW - 0.035;
  frod(b, f, edge, 0.85, 0.055, edge, 1.35, 0.055, 0.011, S.metal(0xb7b9b8, 0.15));
  for (const y of [0.88, 1.32]) frod(b, f, edge, y, 0.055, edge, y, 0.08, 0.008, S.metal(0xb7b9b8, 0.15));
  // Trissim all the way up: rails at the jambs and the end bar under the slot.
  for (const a of [o.a0 + 0.022, o.a1 - 0.022]) fbox(b, f, a, (o.y0 + o.y1) / 2, 0.028, 0.044, H, 0.05, S.paint(0xcac6ba, 0.22));
  fbox(b, f, aC, o.y1 - 0.02, 0.03, W - 0.04, 0.04, 0.05, S.paint(0xb9b5a9, 0.3));
}

/** The kitchen door to the patio: white aluminium, glass above a solid panel, lace behind it, trissim part down. */
function gardenDoor(b: MeshBuilder, glass: MeshBuilder, f: Facade, o: Opening) {
  const alu = S.paint(0xefeee9, 0.12);
  const W = o.a1 - o.a0;
  const aC = (o.a0 + o.a1) / 2;
  trissim(b, f, o, o.shutter ?? 0);
  const top = o.y1 - 0.04;
  fbox(b, f, aC, top - 0.03, 0.12, W, 0.06, 0.07, alu);
  for (const a of [o.a0 + 0.03, o.a1 - 0.03]) fbox(b, f, a, (o.y0 + top) / 2, 0.12, 0.06, top - o.y0, 0.07, alu);
  const l0 = o.a0 + 0.06, l1 = o.a1 - 0.06;
  const lc = (l0 + l1) / 2;
  const lw = l1 - l0;
  for (const a of [l0 + 0.045, l1 - 0.045]) fbox(b, f, a, (o.y0 + top - 0.06) / 2, 0.135, 0.09, top - 0.06 - o.y0, 0.05, alu);
  fbox(b, f, lc, o.y0 + 0.47, 0.135, lw, 0.94, 0.05, alu);
  fbox(b, f, lc, o.y0 + 0.97, 0.135, lw, 0.06, 0.05, alu);
  fbox(b, f, lc, top - 0.1, 0.135, lw, 0.08, 0.05, alu);
  for (let i = 0; i < 3; i++) fbox(b, f, lc, o.y0 + 0.2 + i * 0.25, 0.109, lw - 0.24, 0.006, 0.004, S.paint(0xd4d3cc, 0.1));
  fbox(glass, f, lc, (o.y0 + 1.0 + top - 0.14) / 2, 0.135, lw - 0.18, top - 0.14 - o.y0 - 1.0, 0.006, GLASS);
  curtain(b, f, l0 + 0.09, l1 - 0.09, o.y0 + 1.0, top - 0.14, o.curtain ?? 0xeee6d2, 1);
  // Lever handle and lock, then the mezuzah on the right-hand doorpost as you go in.
  const hA = o.a1 - 0.13;
  fbox(b, f, hA, o.y0 + 1.0, 0.105, 0.035, 0.16, 0.012, S.chrome(0xcfd2d0));
  frod(b, f, hA, o.y0 + 1.04, 0.1, hA - 0.11 * fright(f), o.y0 + 1.04, 0.07, 0.009, S.chrome(0xcfd2d0), 8);
  frbox(b, f, aC + fright(f) * (W / 2 + 0.06), o.y0 + 1.42, -0.012, 0.028, 0.12, 0.02, 0.006, S.paint(0x9a7b4c, 0.1));
}

/** The street door: a brown steel security door with a stainless lever, a peephole, a kick plate and a mezuzah. */
function frontDoor(b: MeshBuilder, f: Facade, o: Opening) {
  const W = o.a1 - o.a0;
  const H = o.y1 - o.y0;
  const aC = (o.a0 + o.a1) / 2;
  const frame = S.paint(0x3f362e, 0.16);
  fbox(b, f, aC, o.y1 - 0.03, 0.06, W, 0.06, 0.06, frame);
  for (const a of [o.a0 + 0.03, o.a1 - 0.03]) fbox(b, f, a, (o.y0 + o.y1) / 2, 0.06, 0.06, H, 0.06, frame);
  const leafS = S.paint(0x6c4a31, 0.14);
  fbox(b, f, aC, (o.y0 + o.y1 - 0.06) / 2, 0.085, W - 0.12, H - 0.06, 0.05, leafS);
  // Raised panels and grooves in the wood-look skin.
  for (const [y, h] of [[o.y0 + 0.55, 0.7], [o.y0 + 1.45, 0.85]] as const) frbox(b, f, aC, y, 0.056, W - 0.34, h, 0.012, 0.004, tone(leafS, 1.12));
  for (let i = 0; i < 5; i++) fbox(b, f, aC, o.y0 + 0.2 + i * 0.4, 0.0585, W - 0.14, 0.008, 0.004, S.paint(0x3e2a1c, 0.1));
  fbox(b, f, aC, o.y0 + 0.08, 0.058, W - 0.14, 0.14, 0.004, S.chrome(0xb8bbb9));
  const r = fright(f);
  const hA = aC + r * (W / 2 - 0.16);
  frbox(b, f, hA, o.y0 + 1.02, 0.055, 0.05, 0.26, 0.012, 0.006, S.chrome(0xd2d5d3));
  frod(b, f, hA, o.y0 + 1.07, 0.05, hA - r * 0.13, o.y0 + 1.07, 0.02, 0.01, S.chrome(0xd2d5d3), 8);
  fdisc(b, f, hA, o.y0 + 0.93, 0.052, 0.014, 0.01, S.metal(0xc9a24a, 0.2), 10);
  fdisc(b, f, aC, o.y0 + 1.52, 0.055, 0.012, 0.01, S.chrome(0xd2d5d3), 10);
  frbox(b, f, aC + r * (W / 2 + 0.06), o.y0 + 1.5, -0.012, 0.028, 0.12, 0.02, 0.006, S.paint(0xc7c2b8, 0.1));
}

/** The living room seen through the sliding door: tiled floor, a sofa, the TV on, lamps lit, a painting and a plant. */
function livingRoom(b: MeshBuilder) {
  const { x0, x1, z0, z1, h } = ROOM;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const wall = lit(0xf0e6d4, 0.2);
  b.box(cx, 0.02, cz, x1 - x0, 0.04, z1 - z0, lit(0x8f8778, 0.08));
  let t = 0;
  for (let x = x0; x < x1 - 0.01; x += 0.6) for (let z = z0; z < z1 - 0.01; z += 0.6) {
    const xa = x + 0.003, xb = Math.min(x + 0.6, x1) - 0.003;
    const za = z + 0.003, zb = Math.min(z + 0.6, z1) - 0.003;
    b.quad([xa, 0.041, za], [xa, 0.041, zb], [xb, 0.041, zb], [xb, 0.041, za], tone(lit(0xd9cebb, 0.1, 0.35), 0.94 + hash(t++, 4) * 0.1));
  }
  b.box(x0 + 0.01, h / 2, cz, 0.02, h, z1 - z0, wall);
  b.box(x1 - 0.01, h / 2, cz, 0.02, h, z1 - z0, wall);
  b.box(cx, h / 2, z0 + 0.01, x1 - x0, h, 0.02, wall);
  b.box(cx, h + 0.05, cz, x1 - x0, 0.1, z1 - z0, lit(0xf6f1e8, 0.24));
  const skirting = lit(0x8a6a4a, 0.06);
  b.box(x0 + 0.025, 0.08, cz, 0.012, 0.08, z1 - z0, skirting);
  b.box(x1 - 0.025, 0.08, cz, 0.012, 0.08, z1 - z0, skirting);
  b.box(cx, 0.08, z0 + 0.025, x1 - x0, 0.08, 0.012, skirting);
  // Sofa along the left wall, facing the TV.
  const sofa = lit(0x5e6874, 0.1, 0.95);
  b.rbox(x0 + 0.5, 0.22, -6.3, 0.92, 0.28, 2.3, 0.04, sofa);
  b.rbox(x0 + 0.14, 0.6, -6.3, 0.24, 0.62, 2.3, 0.05, sofa);
  for (const z of [-7.38, -5.22]) b.rbox(x0 + 0.5, 0.48, z, 0.92, 0.26, 0.16, 0.05, sofa);
  for (const z of [-6.88, -6.3, -5.72]) {
    b.rbox(x0 + 0.56, 0.42, z, 0.72, 0.13, 0.56, 0.04, lit(0x6a7480, 0.1, 0.95));
    b.rbox(x0 + 0.32, 0.72, z, 0.16, 0.42, 0.54, 0.05, lit(0x6a7480, 0.1, 0.95));
  }
  b.rbox(x0 + 0.42, 0.62, -7.05, 0.12, 0.34, 0.34, 0.06, lit(0xc9922f, 0.12, 0.95));
  b.rbox(x0 + 0.42, 0.62, -5.55, 0.12, 0.32, 0.32, 0.06, lit(0xb4573a, 0.12, 0.95));
  // Kilim rug, low coffee table and its things.
  b.box(-4.95, 0.046, -6.25, 1.9, 0.008, 1.5, lit(0x9b4f3a, 0.1, 0.95));
  b.box(-4.95, 0.05, -6.25, 1.6, 0.004, 1.2, lit(0xc89660, 0.1, 0.95));
  b.box(-4.95, 0.053, -6.25, 1.2, 0.004, 0.8, lit(0x7d3a2c, 0.1, 0.95));
  const wood = lit(0x86603e, 0.1, 0.5);
  b.rbox(-4.95, 0.4, -6.25, 1.0, 0.04, 0.56, 0.01, wood);
  for (const x of [-5.38, -4.52]) for (const z of [-6.47, -6.03]) b.box(x, 0.2, z, 0.04, 0.38, 0.04, wood);
  b.lathe('room-bowl', [[0.03, 0], [0.12, 0.04], [0.14, 0.07], [0.13, 0.07], [0, 0.02]], -5.1, 0.42, -6.25, lit(0xe6e1d7, 0.12, 0.3), 0, 0, 0, 14);
  for (let i = 0; i < 4; i++) b.sphereAt(-5.13 + (i % 2) * 0.06, 0.47 + Math.floor(i / 2) * 0.03, -6.27 + (i % 3) * 0.03, 0.035, lit(i % 2 ? 0xe28a2a : 0xc9302a, 0.14, 0.5), false);
  b.box(-4.72, 0.435, -6.2, 0.22, 0.03, 0.16, lit(0x2f5a7a, 0.1));
  // The TV on its low cabinet against the right wall, playing.
  b.rbox(x1 - 0.24, 0.24, -6.25, 0.42, 0.44, 1.8, 0.01, lit(0xe7e1d6, 0.12, 0.4));
  for (const z of [-6.7, -5.8]) b.box(x1 - 0.452, 0.24, z, 0.004, 0.3, 0.7, lit(0xd6cfc2, 0.1));
  b.box(x1 - 0.07, 1.18, -6.25, 0.05, 0.7, 1.24, { c: 0x0c0d10, r: 0.15, m: 0, w: 0 });
  b.box(x1 - 0.097, 1.18, -6.25, 0.004, 0.64, 1.18, lit(0x35597a, 0.6, 0.2));
  b.box(x1 - 0.098, 1.1, -6.4, 0.004, 0.3, 0.5, lit(0xc69a5c, 0.6, 0.2));
  // Floor lamp in the corner and the ceiling light, both on.
  b.cyl(x0 + 0.36, 0.05, z0 + 0.32, 0.28, 0.02, 0.28, lit(0x2c2c2a, 0.05, 0.4), 0, 0, 0, 14);
  b.rod(x0 + 0.36, 0.05, z0 + 0.32, x0 + 0.36, 1.42, z0 + 0.32, 0.012, lit(0x2c2c2a, 0.05, 0.4), 6);
  b.frustum(x0 + 0.36, 1.5, z0 + 0.32, 0.15, 0.21, 0.3, S.glow(0xffdcaa, 1.2), 0, 0, 0, 16);
  b.cyl(-4.7, h - 0.025, -6.2, 0.55, 0.05, 0.55, S.glow(0xfff1d8, 1.5), 0, 0, 0, 20);
  // Back wall: a sideboard with photographs, a painting of the sea, the doorway to the hall.
  b.rbox(-5.15, 0.4, z0 + 0.23, 1.4, 0.74, 0.42, 0.01, wood);
  for (const x of [-5.6, -4.7]) b.box(x, 0.4, z0 + 0.442, 0.6, 0.6, 0.004, lit(0x6e4f33, 0.08));
  for (let i = 0; i < 3; i++) {
    b.box(-5.6 + i * 0.28, 0.87 + (i % 2) * 0.03, z0 + 0.2, 0.16, 0.2 + (i % 2) * 0.06, 0.02, lit(0x2a2a2a, 0.05));
    b.box(-5.6 + i * 0.28, 0.87 + (i % 2) * 0.03, z0 + 0.212, 0.12, 0.15 + (i % 2) * 0.06, 0.004, lit([0xd7b98e, 0x8fb2c4, 0xc58f6f][i], 0.2));
  }
  b.lathe('room-vase', [[0.03, 0], [0.07, 0.08], [0.05, 0.2], [0.04, 0.26], [0, 0.26]], -4.62, 0.77, z0 + 0.22, lit(0x3d7a8a, 0.12, 0.3), 0, 0, 0, 12);
  b.box(-5.15, 1.72, z0 + 0.03, 1.08, 0.74, 0.03, lit(0x3a2a1c, 0.05));
  b.box(-5.15, 1.82, z0 + 0.047, 0.98, 0.42, 0.004, lit(0x8cb6c8, 0.3));
  b.box(-5.15, 1.56, z0 + 0.047, 0.98, 0.22, 0.004, lit(0x2f6c86, 0.3));
  b.box(-5.15, 1.43, z0 + 0.048, 0.98, 0.08, 0.004, lit(0xe0c79a, 0.3));
  b.box(-3.25, 1.06, z0 + 0.014, 0.86, 2.12, 0.006, lit(0x2a2622, 0.03));
  for (const x of [-3.71, -2.79]) b.box(x, 1.08, z0 + 0.03, 0.06, 2.16, 0.03, lit(0xe9e2d5, 0.14));
  b.box(-3.25, 2.18, z0 + 0.03, 0.98, 0.06, 0.03, lit(0xe9e2d5, 0.14));
  // A fiddle-leaf fig by the glass, and the sheer curtain gathered at the left of the sliding door.
  b.lathe('room-pot', [[0.12, 0], [0.17, 0.36], [0.18, 0.38], [0, 0.36]], x1 - 0.38, 0.04, z1 - 0.4, lit(0xd9d2c4, 0.12, 0.5), 0, 0, 0, 14);
  b.rod(x1 - 0.38, 0.38, z1 - 0.4, x1 - 0.36, 1.5, z1 - 0.42, 0.018, lit(0x6b5236, 0.06), 6);
  const fig: Blob[] = [
    { x: x1 - 0.38, y: 1.35, z: z1 - 0.42, rx: 0.3, ry: 0.32, rz: 0.28 },
    { x: x1 - 0.48, y: 1.0, z: z1 - 0.35, rx: 0.24, ry: 0.22, rz: 0.22 },
    { x: x1 - 0.3, y: 1.7, z: z1 - 0.45, rx: 0.22, ry: 0.2, rz: 0.2 },
  ];
  blobs(b, fig, lit(0x2f5a2a, 0.08, 0.6), 0.04, 6, 21);
  blobLeaves(b, fig, 70, [0x3d6b32, 0x2f5a2a], 0.16, 0.1, 23, lit(0x3d6b32, 0.1, 0.5));
  b.rod(-5.9, 2.32, z1 - 0.07, -3.0, 2.32, z1 - 0.07, 0.012, lit(0xb9b5ad, 0.08, 0.3), 8);
  for (let i = 0; i < 6; i++) b.rbox(-5.66 + i * 0.075, 1.16, z1 - 0.08 - (i % 2) * 0.03, 0.09, 2.3, 0.03, 0.012, lit(i % 2 ? 0xf2efe8 : 0xe4e0d6, 0.2, 0.95));
}

/** An air conditioner's outdoor unit on wall brackets, its fan grille out front and the insulated pipes into the wall. */
function acUnit(b: MeshBuilder, f: Facade, a: number, y: number) {
  const casing = S.paint(0xebeae4, 0.32);
  const d = -0.2;
  const r = fright(f);
  frbox(b, f, a, y + 0.275, d, 0.8, 0.55, 0.28, 0.02, casing);
  const fa = a - r * 0.1;
  const yc = y + 0.275;
  fdisc(b, f, fa, yc, d - 0.13, 0.205, 0.02, S.rubber(0x262826), 24);
  for (let k = 0; k < 3; k++) {
    const ang = (k * TAU) / 3 + 0.4;
    const p = fp(f, fa + Math.cos(ang) * 0.1 * r, yc + Math.sin(ang) * 0.1, d - 0.13);
    b.box(p[0], p[1], p[2], f.along === 'x' ? 0.18 : 0.02, 0.07, f.along === 'x' ? 0.02 : 0.18, S.plastic(0x4a4d4b, 0.2), f.along === 'x' ? 0 : ang, 0, f.along === 'x' ? ang : 0);
  }
  for (const R of [0.075, 0.14, 0.205]) ftorus(b, f, fa, yc, d - 0.145, R, 0.005, S.paint(0xd9d8d2, 0.3), 24);
  frod(b, f, fa - 0.205, yc, d - 0.145, fa + 0.205, yc, d - 0.145, 0.004, S.paint(0xd9d8d2, 0.3), 5);
  frod(b, f, fa, yc - 0.205, d - 0.145, fa, yc + 0.205, d - 0.145, 0.004, S.paint(0xd9d8d2, 0.3), 5);
  fdisc(b, f, fa, yc, d - 0.15, 0.035, 0.012, S.paint(0xc9c8c2, 0.3), 12);
  for (let k = 0; k < 7; k++) fbox(b, f, a + r * 0.29, y + 0.1 + k * 0.055, d - 0.141, 0.16, 0.014, 0.006, S.paint(0xcfcec8, 0.3), 0.4);
  fbox(b, f, a + r * 0.29, y + 0.49, d - 0.142, 0.12, 0.03, 0.004, S.paint(0x7f8c94, 0.2));
  // Brackets: angle-iron arms with diagonal braces, bolted to the wall.
  const bracket = S.steel(0x8c908d, 0.5);
  for (const s of [-0.3, 0.3]) {
    fbox(b, f, a + s, y - 0.02, -0.19, 0.035, 0.04, 0.38, bracket);
    frod(b, f, a + s, y - 0.33, -0.01, a + s, y - 0.04, -0.34, 0.012, bracket, 6);
    fbox(b, f, a + s, y - 0.17, -0.006, 0.05, 0.36, 0.012, bracket);
  }
  // Insulated copper pipes and the condensate drain.
  const ins = S.rubber(0x2c2c2a);
  const pa = a + r * 0.4;
  for (const [dy, s] of [[0.14, ins], [0.2, S.plastic(0xd8d6ce, 0.2)]] as const) {
    frod(b, f, pa, y + dy, d + 0.06, pa + r * 0.1, y + dy, d + 0.06, 0.016, s, 8);
    frod(b, f, pa + r * 0.1, y + dy, d + 0.06, pa + r * 0.12, y + dy, -0.01, 0.016, s, 8);
  }
  fdisc(b, f, pa + r * 0.12, y + 0.17, -0.004, 0.05, 0.008, S.plastic(0xdedbd3, 0.2), 12);
  frod(b, f, a - r * 0.3, y, d, a - r * 0.3, y - 0.42, d + 0.05, 0.006, S.plastic(0xd8dcd8, 0.2), 5);
}

/** A grey PVC downpipe from a scupper in the parapet to a shoe at the foot of the wall. */
function downpipe(b: MeshBuilder, f: Facade, a: number) {
  const pvc = S.plastic(0xb9b7ae, 0.4);
  const d = -0.1;
  fbox(b, f, a, PARAPET - 0.2, -0.07, 0.14, 0.1, 0.14, pvc);
  frod(b, f, a, PARAPET - 0.24, d, a, 0.24, d, 0.042, pvc, 10);
  frod(b, f, a, 0.26, d, a, 0.09, d - 0.13, 0.042, pvc, 10);
  for (let y = 0.6; y < PARAPET - 0.4; y += 0.9) {
    fbox(b, f, a, y, -0.05, 0.11, 0.03, 0.03, S.steel(0x8f938f, 0.5));
    ftorus(b, f, a, y, d, 0.046, 0.007, S.steel(0x8f938f, 0.5), 12);
  }
}

/** An outdoor wall light: a dark cylinder on a short bracket throwing light up and down, its frosted face lit. */
function wallLamp(b: MeshBuilder, f: Facade, a: number, y: number) {
  const body = S.paint(0x343635, 0.2);
  frbox(b, f, a, y, -0.01, 0.07, 0.16, 0.02, 0.008, body);
  frod(b, f, a, y, -0.02, a, y, -0.06, 0.012, body, 8);
  const p = fp(f, a, y, -0.1);
  b.cyl(p[0], y, p[2], 0.1, 0.2, 0.1, body, 0, 0, 0, 16);
  b.cyl(p[0], y - 0.1, p[2], 0.08, 0.006, 0.08, S.glow(0xffe0b0, 2.2), 0, 0, 0, 16);
  b.cyl(p[0], y + 0.1, p[2], 0.08, 0.006, 0.08, S.glow(0xffe0b0, 1.6), 0, 0, 0, 16);
  fbox(b, f, a, y, -0.149, 0.03, 0.12, 0.004, S.glow(0xffe8c8, 1.2));
}

/** Things fixed to the outside walls: AC units, downpipes, lamps, the meter cabinet, the street door's step and canopy. */
function wallFittings(b: MeshBuilder) {
  const F = FACADES;
  acUnit(b, F.garden, 0.8, 2.1);
  acUnit(b, F.street, -3.8, 1.95);
  acUnit(b, F.left, -6.4, 2.0);
  acUnit(b, F.right, -7.2, 2.05);
  downpipe(b, F.street, -6.82);
  downpipe(b, F.street, 4.73);
  downpipe(b, F.left, -4.92);
  downpipe(b, F.right, -4.95);
  wallLamp(b, F.garden, -6.4, 2.15);
  wallLamp(b, F.garden, -2.3, 2.15);
  wallLamp(b, F.right, -10.2, 2.2);
  wallLamp(b, F.street, 3.0, 2.1);
  wallLamp(b, F.street, -0.4, 2.3);
  // The electricity and water meter cabinet, reachable from the street.
  const st = F.street;
  frbox(b, st, 1.62, 0.95, -0.04, 0.62, 0.86, 0.08, 0.01, S.plastic(0xcfcfc6, 0.4));
  fbox(b, st, 1.62, 0.95, -0.081, 0.006, 0.8, 0.004, S.plastic(0x8d8d86, 0.3));
  fbox(b, st, 1.47, 1.18, -0.082, 0.12, 0.08, 0.004, S.glass(0x233038));
  for (const a of [1.55, 1.69]) fbox(b, st, a, 0.95, -0.085, 0.02, 0.05, 0.01, S.steel(0x4e4f4c, 0.3));
  // The street door's marble step, doormat, canopy and number tile.
  const door = OPENINGS.street.find((o) => o.kind === 'front')!;
  const dc = (door.a0 + door.a1) / 2;
  fbox(b, st, dc, 0.075, -0.22, 1.4, 0.15, 0.44, S.concrete(0xc9c2b2, 0.25));
  fbox(b, st, dc, 0.16, -0.23, 1.46, 0.02, 0.48, S.concrete(0xe5e0d5, 0.12));
  fbox(b, st, dc, 0.176, -0.2, 0.76, 0.012, 0.36, S.cloth(0x6b5a40, 0.4));
  fbox(b, st, dc, 2.6, -0.4, 1.7, 0.12, 0.8, renderSurf);
  fbox(b, st, dc, 2.535, -0.79, 1.7, 0.012, 0.02, S.concrete(0xd8d0bf, 0.2));
  const plate = dc - fright(st) * 0.7;
  fbox(b, st, plate, 1.65, -0.012, 0.27, 0.2, 0.016, S.gloss(0xf3f0e6, 0.05));
  fbox(b, st, plate, 1.65, -0.0205, 0.24, 0.17, 0.002, S.gloss(0x2c5c9c, 0.05));
  fbox(b, st, plate, 1.65, -0.0215, 0.22, 0.15, 0.002, S.gloss(0xf3f0e6, 0.05));
  houseNumber(b, st, '18', plate, 1.65, -0.0235, 0.1, S.gloss(0x2c5c9c, 0.05));
}

function house() {
  const group = new THREE.Group();
  group.name = 'single-story-family-home';
  const glass = new MeshBuilder();
  glass.jitter = 0;
  const ids = Object.keys(FACADES) as FacadeId[];
  group.add(mesh('house-walls-and-roof', (b) => {
    for (const id of ids) drawFacade(b, FACADES[id], OPENINGS[id]);
    drawCore(b);
    // Terrazzo entry steps up to the kitchen door, beneath the patio cover.
    b.box(-0.9, 0.08, -4.05, 1.6, 0.16, 1.3, S.concrete(0xb4afa1, 0.15));
    b.box(-0.9, 0.19, -4.38, 1.5, 0.22, 0.63, S.concrete(0xbfbaac, 0.15));
    b.box(-0.9, 0.162, -3.42, 1.62, 0.012, 0.04, S.concrete(0x9d998d, 0.15));
    b.box(-0.9, 0.302, -4.08, 1.52, 0.012, 0.04, S.concrete(0x9d998d, 0.15));
  }));
  group.add(mesh('house-windows-and-doors', (b) => {
    for (const id of ids) for (const o of OPENINGS[id]) {
      const f = FACADES[id];
      if (o.kind === 'window' || o.kind === 'small') windowUnit(b, glass, f, o);
      else if (o.kind === 'slider') sliderUnit(b, glass, f, o);
      else if (o.kind === 'door') gardenDoor(b, glass, f, o);
      else frontDoor(b, f, o);
    }
  }));
  group.add(mesh('living-room-glimpse', livingRoom, false));
  const panes = new THREE.Mesh(glass.build(), kitMaterial({ transparent: true, opacity: GLASS_OPACITY }));
  panes.name = 'house-window-glass';
  panes.renderOrder = 1;
  group.add(dynamic(panes));
  group.add(mesh('house-wall-fittings', wallFittings));
  // The hose reel on the passage wall, clear of the walking line.
  const hose = mesh('side-wall-hose-reel', (b) => {
    b.cyl(0, 1.2, 0, 0.4, 0.18, 0.4, S.paint(0x5b665b, 0.12), Math.PI / 2, 0, 0, 20);
    b.torus(0, 1.2, 0.12, 0.15, 0.043, S.rubber(0x809078), 0, 0, 0, 8, 24);
    b.pipe([[0.01, 1.08, 0.13], [0.15, 0.4, 0.14], [-0.2, 0.15, 0.22], [-0.55, 0.1, 0.28]], 0.018, S.rubber(0x809078), 6);
    b.rod(0.45, 0.4, 0.04, 0.45, 0.9, 0.04, 0.018, S.chrome(), 8);
    b.rod(0.45, 0.9, 0.04, 0.45, 0.9, 0.24, 0.018, S.chrome(), 8);
  });
  hose.rotation.y = Math.PI / 2;
  hose.position.set(HB.maxX + 0.02, 0, -6.0);
  group.add(hose);
  return group;
}

/** On the flat roof: the solar water heater, a water tank, a satellite dish, an old TV aerial and the roof hatch. */
function roofFittings() {
  return mesh('flat-roof-fittings', (b) => {
    const y = ROOF_TOP;
    const galv = S.steel(0xa7aca9, 0.35);
    // Dud shemesh: two collectors tilted toward the garden, the white tank across their top edge on a galvanised frame.
    const tilt = 0.62;
    const L = 1.8;
    const Wp = 0.95;
    const zLow = -6.2;
    const lift = 0.25;
    const cz = zLow - (Math.cos(tilt) * L) / 2;
    const cy = y + lift + (Math.sin(tilt) * L) / 2;
    const ny = Math.cos(tilt), nz = Math.sin(tilt);
    const zTop = zLow - Math.cos(tilt) * L;
    const yTop = y + lift + Math.sin(tilt) * L;
    const xs = [-2.2, -2.2 + Wp + 0.06];
    for (const px of xs) {
      b.box(px, cy, cz, Wp, 0.07, L, S.metal(0xb4b8b7, 0.3), tilt);
      b.box(px, cy + ny * 0.036, cz + nz * 0.036, Wp - 0.05, 0.004, L - 0.05, S.glass(0x1c2a3a), tilt);
      for (let k = 0; k < 9; k++) b.box(px - Wp / 2 + 0.07 + k * 0.101, cy + ny * 0.039, cz + nz * 0.039, 0.01, 0.002, L - 0.1, S.metal(0x3a4a5c, 0.2), tilt);
      for (const sx of [-1, 1]) {
        const lx = px + sx * (Wp / 2 - 0.04);
        b.rod(lx, y, zLow - 0.05, lx, y + lift, zLow - 0.05, 0.02, galv, 6);
        b.rod(lx, y, zTop, lx, yTop - 0.02, zTop, 0.022, galv, 6);
        b.rod(lx, y + 0.05, zLow - 0.05, lx, yTop - 0.3, zTop + 0.2, 0.014, galv, 6);
      }
    }
    const tx = (xs[0] + xs[1]) / 2;
    const ty = yTop + 0.36;
    const tz = zTop - 0.22;
    b.cyl(tx, ty, tz, 0.58, 2.0, 0.58, S.paint(0xf1efe8, 0.42), 0, 0, Math.PI / 2, 20);
    for (const s of [-1, 1]) {
      b.add('sphere16', tx + s * 1.0, ty, tz, 0.1, 0.56, 0.56, S.paint(0xb9bbb8, 0.4));
      b.torus(tx + s * 0.7, ty, tz, 0.295, 0.012, galv, 0, Math.PI / 2, 0, 5, 20);
      b.rod(tx + s * 0.7, y, tz - 0.25, tx + s * 0.7, ty - 0.25, tz - 0.12, 0.022, galv, 6);
      b.rod(tx + s * 0.7, y, tz + 0.25, tx + s * 0.7, ty - 0.25, tz + 0.12, 0.022, galv, 6);
      b.rod(tx + s * 0.7, ty - 0.27, tz - 0.25, tx + s * 0.7, ty - 0.27, tz + 0.25, 0.018, galv, 6);
    }
    const ins = S.rubber(0x262624);
    for (const px of xs) b.pipe([[px, yTop + 0.02, zTop - 0.02], [px, ty - 0.12, tz + 0.12]], 0.022, ins, 8);
    b.pipe([[xs[0] - 0.5, y + 0.15, zLow + 0.05], [xs[0] - 0.55, y + 0.15, zTop], [xs[0] - 0.55, ty - 0.1, tz], [tx - 0.95, ty - 0.1, tz]], 0.02, ins, 8);
    b.pipe([[tx + 0.9, ty - 0.2, tz + 0.1], [tx + 1.15, ty - 0.2, tz + 0.1], [tx + 1.15, y + 0.04, tz + 0.1], [tx + 1.15, y + 0.04, -5.6]], 0.02, S.metal(0xb87333, 0.4), 8);
    // Black water tank on its stand.
    b.box(2.6, y + 0.08, -8.6, 1.1, 0.16, 1.1, S.concrete(0xb8b3a6, 0.4));
    b.cyl(2.6, y + 0.7, -8.6, 0.98, 1.08, 0.98, S.plastic(0x2a2c2b, 0.45), 0, 0, 0, 22);
    for (const dy of [0.35, 0.7, 1.05]) b.torus(2.6, y + dy, -8.6, 0.495, 0.014, S.plastic(0x252726, 0.45), Math.PI / 2, 0, 0, 5, 24);
    b.add('dome', 2.6, y + 1.24, -8.6, 0.98, 0.16, 0.98, S.plastic(0x2e302f, 0.45));
    b.cyl(2.6, y + 1.33, -8.6, 0.3, 0.04, 0.3, S.plastic(0x3a3c3b, 0.4), 0, 0, 0, 14);
    b.pipe([[2.1, y + 0.3, -8.6], [1.7, y + 0.3, -8.6], [1.7, y + 0.04, -8.6], [1.0, y + 0.04, -8.6]], 0.02, S.plastic(0x9da3a6, 0.3), 8);
    // Satellite dish on the parapet at the street corner, aimed up and south.
    b.rod(-6.55, y + 0.2, -10.38, -6.55, y + 0.85, -10.38, 0.022, galv, 6);
    b.box(-6.55, y + 0.25, -10.43, 0.12, 0.14, 0.03, galv);
    b.cyl(-6.55, y + 0.95, -10.25, 0.62, 0.025, 0.56, S.paint(0xe6e6e1, 0.4), 1.0, 0, 0, 24);
    b.rod(-6.55, y + 0.78, -10.18, -6.55, y + 1.22, -9.92, 0.012, galv, 6);
    b.box(-6.55, y + 1.24, -9.9, 0.07, 0.09, 0.07, S.plastic(0x3a3c3b, 0.3));
    // An old Yagi aerial on a guyed mast at the back corner.
    b.rod(4.2, y, -10.2, 4.2, y + 2.1, -10.2, 0.022, galv, 6);
    b.rod(4.2, y + 1.95, -10.75, 4.2, y + 1.95, -9.65, 0.012, galv, 6);
    for (let k = 0; k < 7; k++) {
      const w = 0.42 - k * 0.035;
      b.rod(4.2 - w, y + 1.95, -10.7 + k * 0.17, 4.2 + w, y + 1.95, -10.7 + k * 0.17, 0.005, galv, 4);
    }
    for (const [gx, gz] of [[3.4, -10.4], [4.4, -9.4]] as const) b.rod(4.2, y + 1.6, -10.2, gx, y, gz, 0.003, S.steel(0x6d716e), 4);
    // Roof hatch and two soil vent pipes.
    b.box(-0.6, y + 0.1, -9.2, 0.8, 0.2, 0.8, S.concrete(0xc9c4b6, 0.4));
    b.box(-0.6, y + 0.215, -9.2, 0.86, 0.03, 0.86, S.steel(0x9a9e9b, 0.5));
    for (const [vx, vz] of [[1.4, -9.9], [-4.3, -9.7]] as const) {
      b.cyl(vx, y + 0.3, vz, 0.11, 0.6, 0.11, S.plastic(0x8f9294, 0.4), 0, 0, 0, 10);
      b.cyl(vx, y + 0.62, vz, 0.14, 0.05, 0.14, S.plastic(0x7d8082, 0.4), 0, 0, 0, 10);
    }
  });
}

/** A bent tube through some points, without joint balls (for gentle curves). */
function polyline(b: MeshBuilder, pts: V3[], r: number, s: ColorIn, seg = 8) {
  for (let i = 0; i < pts.length - 1; i++) b.rod(pts[i][0], pts[i][1], pts[i][2], pts[i + 1][0], pts[i + 1][1], pts[i + 1][2], r, s, seg);
}

const FAN = { x: 2.95, z: -2.85, y: 2.9 };

function patioCover() {
  const group = new THREE.Group();
  group.name = 'full-patio-cover';
  const { minX, maxX, minZ, maxZ } = GARDEN_BOUNDS.patio;
  const left = minX - 0.12, right = maxX + 0.12;
  const centreX = (left + right) / 2;
  const back = minZ - 0.12, front = maxZ + 0.17;
  const arc = (t: number): [number, number] => [3.03 + 0.38 * Math.sin(t * Math.PI) - 0.23 * t, back + (front - back) * t];
  group.add(mesh('curved-patio-cover', (b) => {
    b.jitter = 0;
    const skin = S.plastic(0xe4e1d0, 0.04);
    for (let i = 0; i < 40; i++) {
      const [y0, z0] = arc(i / 40), [y1, z1] = arc((i + 1) / 40);
      b.quad([left, y0, z0], [left, y1, z1], [right, y1, z1], [right, y0, z0], skin);
      b.quad([right, y0 - 0.016, z0], [right, y1 - 0.016, z1], [left, y1 - 0.016, z1], [left, y0 - 0.016, z0], skin);
    }
  }));
  group.add(mesh('pale-metal-cover-frame', (b) => {
    const frame = S.paint(0xd9dccf, 0.06);
    // Curved ribs run from the wall to the lawn, with rails along the house.
    for (let i = 0; i <= 10; i++) {
      const x = left + ((right - left) * i) / 10;
      const points: V3[] = [];
      for (let k = 0; k <= 24; k++) {
        const [y, z] = arc(k / 24);
        points.push([x, y - 0.045, z]);
      }
      polyline(b, points, 0.028, frame, 8);
    }
    for (const t of [0, 0.33, 0.66, 1]) {
      const [y, z] = arc(t);
      b.rod(left, y - 0.075, z, right, y - 0.075, z, 0.028, frame, 8);
    }
    for (const x of [-6.85, -3.45, 0, 4.65]) {
      const [y, z] = arc(1);
      b.box(x, (y - 0.08) / 2, z, 0.075, y - 0.08, 0.075, frame);
      b.box(x, 0.018, z, 0.18, 0.036, 0.18, S.steel(0x9b9d94, 0.08));
      b.rod(x, y - 0.55, z, x, y - 0.13, z - 0.42, 0.022, frame, 8);
    }
    b.box(centreX, 2.73, front + 0.025, right - left, 0.1, 0.08, frame);
  }));
  // Warm string lights strung from rib to rib under the cover, sagging between them.
  group.add(mesh('patio-string-lights', (b) => {
    b.jitter = 0;
    const wire = S.rubber(0x1d1d1b);
    const bulb = S.glow(0xffc979, 2.6);
    const socket = S.plastic(0x222220, 0.1);
    for (const t of [0.2, 0.52, 0.84]) {
      const [yr, z] = arc(t);
      const y0 = yr - 0.1;
      for (let i = 0; i < 10; i++) {
        const xa = left + ((right - left) * i) / 10;
        const xb = left + ((right - left) * (i + 1)) / 10;
        const sag = 0.13;
        const sagAt = (s: number) => y0 - sag * 4 * s * (1 - s);
        const pts: V3[] = [];
        for (let k = 0; k <= 6; k++) pts.push([xa + ((xb - xa) * k) / 6, sagAt(k / 6), z]);
        polyline(b, pts, 0.004, wire, 4);
        for (let k = 0; k < 4; k++) {
          const s = (k + 0.5) / 4;
          const x = xa + (xb - xa) * s;
          const y = sagAt(s);
          b.box(x, y - 0.018, z, 0.014, 0.024, 0.014, socket);
          b.add('ico', x, y - 0.048, z, 0.032, 0.044, 0.032, bulb);
        }
      }
    }
  }, false));
  // A ceiling fan over the sofa corner: the mount is fixed, the blades turn.
  const [fy] = arc((FAN.z - back) / (front - back));
  group.add(mesh('patio-ceiling-fan', (b) => {
    const white = S.paint(0xeeece4, 0.08);
    b.cyl(FAN.x, fy - 0.035, FAN.z, 0.14, 0.03, 0.14, white, 0, 0, 0, 14);
    b.rod(FAN.x, fy - 0.04, FAN.z, FAN.x, FAN.y + 0.06, FAN.z, 0.012, white, 8);
    b.add('sphere16', FAN.x, FAN.y + 0.02, FAN.z, 0.22, 0.11, 0.22, white);
    b.add('dome', FAN.x, FAN.y - 0.03, FAN.z, 0.18, 0.09, 0.18, S.glow(0xfff0d6, 1.3), Math.PI, 0, 0);
  }));
  const blades = new MeshBuilder();
  blades.jitter = 0.02;
  for (let k = 0; k < 5; k++) {
    const a = (k * TAU) / 5;
    const c = Math.cos(a), s = Math.sin(a);
    blades.rod(c * 0.08, 0, s * 0.08, c * 0.2, -0.01, s * 0.2, 0.012, S.chrome(0xbfc2c0), 6);
    blades.rbox(c * 0.42, -0.012, s * 0.42, 0.5, 0.01, 0.12, 0.004, S.wood(0xa47a4c, 0.12), 0, -a, 0.08);
  }
  const fan = new THREE.Mesh(blades.build(), kitMaterial());
  fan.name = 'patio-ceiling-fan-blades';
  fan.position.set(FAN.x, FAN.y, FAN.z);
  fan.castShadow = true;
  group.add(dynamic(fan));
  return { group, fan };
}

function frontGardenAndPassage() {
  const group = new THREE.Group();
  group.name = 'front-garden-and-side-passage';
  const p = GARDEN_BOUNDS.passage, g = GARDEN_BOUNDS.frontGarden;
  const entryDepth = 0.72, entryWidth = 1.5;
  const pathStart = p.minZ + entryDepth;
  const pathWidth = 1.35, pathDepth = p.maxZ - pathStart;
  const pathX = (p.minX + p.maxX) / 2, pathZ = (pathStart + p.maxZ) / 2;
  group.add(mesh('side-passage-to-front-garden', (b) => {
    b.box(pathX, -0.005, pathZ, pathWidth, 0.022, pathDepth, S.concrete(0x9a958a, 0.1));
    // Square concrete slabs, each a shade apart, over a grout bed.
    let k = 0;
    for (let z = pathStart; z < p.maxZ - 0.01; z += 0.45) for (let x = pathX - pathWidth / 2; x < pathX + pathWidth / 2 - 0.01; x += 0.45) {
      const z1 = Math.min(z + 0.45, p.maxZ) - 0.005, x1 = Math.min(x + 0.45, pathX + pathWidth / 2) - 0.005;
      b.quad([x + 0.005, 0.0075, z + 0.005], [x + 0.005, 0.0075, z1], [x1, 0.0075, z1], [x1, 0.0075, z + 0.005], tone(S.concrete(0xcac4b2, 0.12), 0.93 + hash(k++, 8) * 0.12));
    }
  }));
  group.add(mesh('passage-gravel-edges', (b) => {
    const stripWidth = (p.maxX - p.minX - pathWidth) / 2;
    for (const x of [p.minX + stripWidth / 2, p.maxX - stripWidth / 2]) {
      b.box(x, 0.005, pathZ, stripWidth, 0.025, pathDepth, S.concrete(0x938e7f, 0.25));
      for (let i = 0; i < 170; i++) {
        const s = 0.04 + hash(i, x) * 0.035;
        b.add('ico', x + (((i * 0.618) % 1) - 0.5) * (stripWidth - 0.07), 0.02, pathStart + 0.05 + ((i * 0.4142) % 1) * (pathDepth - 0.1), s * 1.2, s * 0.7, s, S.concrete([0xa9a494, 0x787467, 0xc2bcaa][i % 3], 0.15), 0, i, 0);
      }
    }
    const entrySideWidth = (p.maxX - p.minX - entryWidth) / 2;
    for (const x of [p.minX + entrySideWidth / 2, p.maxX - entrySideWidth / 2]) b.box(x, 0.005, p.minZ + entryDepth / 2, entrySideWidth, 0.025, entryDepth, S.concrete(0x938e7f, 0.25));
    b.box(pathX, -0.17, (g.maxZ + p.maxZ) / 2, p.maxX - p.minX, 0.32, p.maxZ - g.maxZ, S.concrete(0xaca99e, 0.12));
  }));
  group.add(mesh('small-front-garden', (b) => {
    const lawnMinX = g.minX + 0.1, lawnMaxX = p.minX - 0.04;
    const lawnMinZ = g.minZ + 0.1, lawnMaxZ = g.maxZ - 0.1;
    const foundation = S.concrete(0xaca99e, 0.12);
    b.box((g.minX + g.maxX) / 2, -0.17, (pathStart + g.maxZ) / 2, g.maxX - g.minX, 0.32, g.maxZ - pathStart, foundation);
    const entryLeft = pathX - entryWidth / 2, entryRight = pathX + entryWidth / 2;
    b.box((g.minX + entryLeft) / 2, -0.17, g.minZ + entryDepth / 2, entryLeft - g.minX, 0.32, entryDepth, foundation);
    b.box((entryRight + g.maxX) / 2, -0.17, g.minZ + entryDepth / 2, g.maxX - entryRight, 0.32, entryDepth, foundation);
    b.box((lawnMinX + lawnMaxX) / 2, 0.022, (lawnMinZ + lawnMaxZ) / 2, lawnMaxX - lawnMinX, 0.035, lawnMaxZ - lawnMinZ, S.cloth(0x52713b, 0));
    grid(b, steps(lawnMinX, lawnMaxX, 0.35), steps(lawnMinZ, lawnMaxZ, 0.35), (x, z) => [x, 0.041, z], [0, 1, 0], plant(0x58783a, 0.95), lawnPaint);
    grass(b, lawnMinX, lawnMaxX, lawnMinZ, lawnMaxZ, 420, 0.04, 5, (x, z) => z < -13.55 || (x < 3.25 && z > -11.25) || Math.hypot(x - 4.42, z + 12.3) < 0.2 || Math.hypot(x - 4.0, z + 11.85) < 0.2 || Math.hypot(x - 3.78, z + 11.38) < 0.19, lawnPaint);
    // Stepping stones from the passage to the street door.
    for (const [sx, sz, r] of [[4.42, -12.3, 0.2], [4.0, -11.85, 0.19], [3.78, -11.38, 0.18]] as const) {
      b.cyl(sx, 0.045, sz, r * 2.1, 0.03, r * 1.8, S.concrete(0xb9b1a0, 0.25), 0, sx * 3, 0, 12);
    }
    // A low bed against the fence: lavender, a rosemary and a small lemon bush, edged in timber.
    const bedWidth = lawnMaxX - lawnMinX - 0.2, bedX = (lawnMinX + lawnMaxX) / 2;
    b.box(bedX, 0.03, -13.85, bedWidth, 0.05, 0.54, S.concrete(0x4e3d2c, 0.3));
    for (const z of [-14.12, -13.58]) b.box(bedX, 0.06, z, bedWidth + 0.04, 0.08, 0.04, S.wood(0x6d5a44, 0.3));
    shrub(b, lawnMinX + 0.45, -13.85, 0.26, 0.5, 0x6d8a6a, 0x8a6fc0, 26, 31);
    shrub(b, bedX, -13.85, 0.3, 0.7, 0x3f6a2e, 0xf1d63a, 14, 33);
    shrub(b, lawnMaxX - 0.45, -13.85, 0.24, 0.45, 0x7b8d74, 0x9a86c8, 18, 35);
  }));
  // The threshold paving through the open gate, flush with the street outside.
  group.add(mesh('front-gate-threshold', (b) => {
    b.box(pathX, -0.016, g.minZ + entryDepth / 2, entryWidth, 0.016, entryDepth, S.concrete(0x9a958a, 0.1));
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) {
      const x0 = pathX - entryWidth / 2 + i * (entryWidth / 3) + 0.005, x1 = x0 + entryWidth / 3 - 0.01;
      const z0 = g.minZ + j * (entryDepth / 2) + 0.005, z1 = z0 + entryDepth / 2 - 0.01;
      b.quad([x0, -0.0065, z0], [x0, -0.0065, z1], [x1, -0.0065, z1], [x1, -0.0065, z0], tone(S.concrete(0xcac4b2, 0.12), 0.95 + hash(i * 2 + j, 9) * 0.1));
    }
  }, false));
  const steps2 = new THREE.Group();
  steps2.name = 'front-gate-two-steps';
  steps2.add(mesh('front-gate-upper-step', (b) => b.box(pathX, -0.24, g.minZ + 0.54, entryWidth, 0.16, 0.36, S.concrete(0xbcb8a8, 0.1))));
  steps2.add(mesh('front-gate-lower-step', (b) => b.box(pathX, -0.37, g.minZ + 0.18, entryWidth, 0.1, 0.36, S.concrete(0xbcb8a8, 0.1))));
  group.add(steps2);
  // The gas cylinders in their cage against the house, by the street door.
  group.add(mesh('gas-cylinder-cage', (b) => {
    const cx = 2.8, cz = HB.minZ - 0.23;
    const galv = S.steel(0xa3a7a4, 0.4);
    b.box(cx, 0.03, cz, 0.78, 0.06, 0.5, S.concrete(0xbdb7a8, 0.3));
    for (let k = 0; k < 2; k++) {
      const x = cx - 0.17 + k * 0.34;
      b.cyl(x, 0.62, cz, 0.3, 1.0, 0.3, S.paint(0x9ea4a8, 0.35), 0, 0, 0, 16);
      b.add('sphere16', x, 1.12, cz, 0.3, 0.16, 0.3, S.paint(0x9ea4a8, 0.35));
      b.cyl(x, 1.25, cz, 0.13, 0.12, 0.13, S.paint(0x3f6fa8, 0.3), 0, 0, 0, 12);
      b.cyl(x, 1.3, cz, 0.05, 0.06, 0.05, S.metal(0xb08d3a, 0.3), 0, 0, 0, 8);
      b.torus(x, 0.4, cz, 0.152, 0.008, S.paint(0x3f6fa8, 0.3), Math.PI / 2, 0, 0, 4, 18);
    }
    b.pipe([[cx - 0.17, 1.33, cz], [cx - 0.17, 1.42, cz + 0.05], [cx + 0.17, 1.42, cz + 0.05], [cx + 0.17, 1.33, cz]], 0.008, S.metal(0xb87333, 0.4), 6);
    b.pipe([[cx, 1.42, cz + 0.05], [cx, 1.42, HB.minZ - 0.01]], 0.008, S.metal(0xb87333, 0.4), 6);
    b.box(cx, 1.42, cz + 0.12, 0.08, 0.06, 0.05, S.metal(0x8b8f8d, 0.3));
    const w = 0.39, d = 0.24, h = 1.48;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box(cx + sx * w, h / 2, cz + sz * d, 0.03, h, 0.03, galv);
    for (const y of [0.08, h]) {
      for (const sz of [-1, 1]) b.box(cx, y, cz + sz * d, 2 * w, 0.03, 0.03, galv);
      for (const sx of [-1, 1]) b.box(cx + sx * w, y, cz, 0.03, 0.03, 2 * d, galv);
    }
    b.box(cx, h + 0.04, cz - 0.02, 2 * w + 0.08, 0.02, 2 * d + 0.12, galv, -0.08);
    for (let k = 1; k < 13; k++) b.rod(cx - w + (k * 2 * w) / 13, 0.08, cz - d, cx - w + (k * 2 * w) / 13, h, cz - d, 0.005, galv, 4);
    for (const sx of [-1, 1]) for (let k = 1; k < 8; k++) b.rod(cx + sx * w, 0.08, cz - d + (k * 2 * d) / 8, cx + sx * w, h, cz - d + (k * 2 * d) / 8, 0.005, galv, 4);
    b.box(cx + 0.2, 0.8, cz - d - 0.025, 0.04, 0.05, 0.02, S.metal(0xb79a3a, 0.3));
  }));
  return group;
}

/** The front gate, standing open into the front garden, with its posts, mailbox, intercom and number plate. */
/** How far the gate swings open, radians (into the front garden). */
export const GATE_SWING = (-100 * Math.PI) / 180;

function frontGate() {
  const group = new THREE.Group();
  group.name = 'front-garden-metal-gate';
  const g = GARDEN_BOUNDS.frontGarden;
  const hingeX = GATE.x - GATE.w / 2;
  const latchX = GATE.x + GATE.w / 2;
  const steel = S.steel(0x697677, 0.08);
  group.add(mesh('front-gate-posts', (b) => {
    for (const x of [hingeX, latchX]) {
      b.box(x, 0.8, g.minZ, 0.075, 2.22, 0.075, steel);
      b.box(x, 1.92, g.minZ, 0.09, 0.02, 0.09, S.steel(0x4f5a5b, 0.1));
      b.box(x, -0.02, g.minZ, 0.18, 0.04, 0.18, S.concrete(0xa9a497, 0.3));
    }
    for (const y of [0.4, 1.3]) b.cyl(hingeX + 0.03, y, g.minZ, 0.045, 0.12, 0.045, S.chrome(0xa6afad), 0, 0, 0, 10);
    // The latch keeper on the far post.
    b.box(latchX - 0.045, 0.95, g.minZ, 0.02, 0.12, 0.05, steel);
  }));
  // The leaf, drawn in its own frame (hinge at the origin, leaf along +X, the street side toward -Z), then swung ~100°.
  const leafLen = GATE.w - 0.1;
  const leaf = mesh('front-gate-leaf', (b) => {
    b.box(0.02, 0.9, 0, 0.04, 1.72, 0.04, steel);
    b.box(leafLen - 0.02, 0.9, 0, 0.04, 1.72, 0.04, steel);
    for (const y of [0.06, 0.9, 1.74]) b.box(leafLen / 2, y, 0, leafLen, 0.04, 0.04, steel);
    for (let i = 1; i < 11; i++) b.rod((leafLen * i) / 11, 0.08, 0, (leafLen * i) / 11, 1.72, 0, 0.01, steel, 6);
    for (const y of [0.4, 1.3]) b.cyl(0.0, y, 0, 0.035, 0.1, 0.035, S.chrome(0xa6afad), 0, 0, 0, 8);
    b.box(leafLen - 0.06, 0.95, 0, 0.07, 0.17, 0.07, steel);
    for (const s of [-1, 1]) b.rod(leafLen - 0.08, 0.96, s * 0.05, leafLen - 0.18, 0.96, s * 0.05, 0.012, S.chrome(), 8);
    // The drop bolt that holds it open, down in its socket.
    b.rod(leafLen - 0.1, 0.02, 0.03, leafLen - 0.1, 0.5, 0.03, 0.008, S.chrome(0xa6afad), 6);
  });
  const screen = mesh('gate-exterior-blue-privacy-screen', (b) => {
    b.box(leafLen / 2, 0.9, -0.03, leafLen - 0.1, 1.6, 0.008, S.cloth(0x253f6d, 0.04));
    for (const x of [0.1, leafLen / 2, leafLen - 0.12]) for (const y of [0.14, 1.66]) b.rod(x, y, -0.035, x, y, 0.0, 0.004, S.rubber(0x313c4b), 5);
  });
  // Both hang on a hinge that turns: shut across the gateway until the buzzer opens it, then swung ~100° into the garden.
  const hinge = new THREE.Group();
  hinge.name = 'front-gate-hinge';
  hinge.position.set(hingeX + 0.04, 0, g.minZ);
  hinge.add(leaf, screen);
  group.add(dynamic(hinge));
  group.add(mesh('gate-mailbox-and-intercom', (b) => {
    const street = { along: 'x', c: g.minZ - 0.06, n: -1, a0: 0, a1: 0, base: 0, seed: 1 } as Facade;
    // Mailbox on the fence beside the gate.
    frbox(b, street, 6.79, 1.2, -0.08, 0.32, 0.4, 0.13, 0.012, S.paint(0x3f4a52, 0.3));
    fbox(b, street, 6.79, 1.33, -0.148, 0.26, 0.025, 0.004, S.paint(0x1d2226, 0.2));
    fbox(b, street, 6.79, 1.12, -0.147, 0.12, 0.05, 0.003, S.gloss(0xece8dc, 0.05));
    frbox(b, street, 6.79, 1.42, -0.08, 0.34, 0.03, 0.15, 0.008, S.paint(0x36404a, 0.3));
    // Intercom with its camera on the latch post.
    const post = { ...street, c: g.minZ - 0.0375 } as Facade;
    frbox(b, post, latchX, 1.36, -0.016, 0.075, 0.18, 0.03, 0.006, S.metal(0x9ea2a2, 0.2));
    fdisc(b, post, latchX, 1.42, -0.032, 0.012, 0.006, S.glass(0x10161c), 10);
    for (let k = 0; k < 4; k++) fbox(b, post, latchX, 1.36 - k * 0.012, -0.0315, 0.04, 0.004, 0.002, S.rubber(0x2a2c2c));
    fbox(b, post, latchX, 1.3, -0.033, 0.03, 0.025, 0.006, S.glow(0x9fd0ff, 0.8));
    // The house number on the fence the other side of the gate.
    fbox(b, street, 4.95, 1.42, -0.012, 0.26, 0.19, 0.016, S.gloss(0xf3f0e6, 0.05));
    fbox(b, street, 4.95, 1.42, -0.0205, 0.23, 0.16, 0.002, S.gloss(0x2c5c9c, 0.05));
    fbox(b, street, 4.95, 1.42, -0.0215, 0.21, 0.14, 0.002, S.gloss(0xf3f0e6, 0.05));
    houseNumber(b, street, '18', 4.95, 1.42, -0.0235, 0.09, S.gloss(0x2c5c9c, 0.05));
  }));
  return group;
}

function metalFenceAndPrivacyScreen() {
  const group = new THREE.Group();
  group.name = 'metal-fence-with-exterior-blue-screen';
  const g = GARDEN_BOUNDS.frontGarden;
  // Start/end points and the direction facing out of the property.
  const sections: [number, number, number, number, number, number][] = [
    [-7, -4.7, -7, 7.9, -1, 0], [-7, 7.9, 7, 7.9, 0, 1],
    [7, g.minZ, 7, 7.9, 1, 0], [g.minX, g.minZ, g.minX, g.maxZ, -1, 0],
    [g.minX, g.minZ, GATE.x - GATE.w / 2, g.minZ, 0, -1], [GATE.x + GATE.w / 2, g.minZ, 7, g.minZ, 0, -1],
  ];
  sections.forEach(([x0, z0, x1, z1, nx, nz], i) => {
    const dx = x1 - x0, dz = z1 - z0, length = Math.hypot(dx, dz);
    group.add(mesh(`metal-fence-section-${i + 1}`, (b) => {
      const steel = S.steel(0x758282, 0.08);
      for (const y of [0.14, 1.62]) b.rod(x0, y, z0, x1, y, z1, 0.018, steel, 8);
      const count = Math.ceil(length / 0.14);
      for (let k = 0; k <= count; k++) {
        const t = k / count;
        b.rod(x0 + dx * t, 0.05, z0 + dz * t, x0 + dx * t, 1.65, z0 + dz * t, 0.009, steel, 6);
      }
      const posts = Math.ceil(length / 2.0);
      for (let k = 0; k <= posts; k++) b.box(x0 + (dx * k) / posts, 0.85, z0 + (dz * k) / posts, 0.065, 1.7, 0.065, S.steel(0x566566, 0.08));
    }));
    group.add(mesh(`exterior-blue-privacy-screen-${i + 1}`, (b) => {
      const cloth = S.cloth(0x253f6d, 0.04), panels = Math.ceil(length / 0.25);
      for (let k = 0; k < panels; k++) {
        const t0 = k / panels, t1 = (k + 1) / panels;
        const offset0 = 0.06 + Math.sin(t0 * length * 9) * 0.008;
        const offset1 = 0.06 + Math.sin(t1 * length * 9) * 0.008;
        const a: V3 = [x0 + dx * t0 + nx * offset0, 0.12, z0 + dz * t0 + nz * offset0];
        const b0: V3 = [x0 + dx * t1 + nx * offset1, 0.12, z0 + dz * t1 + nz * offset1];
        const c: V3 = [b0[0], 1.63, b0[2]];
        const d: V3 = [a[0], 1.63, a[2]];
        b.quad(a, b0, c, d, cloth);
        b.quad(d, c, b0, a, cloth);
      }
    }));
    group.add(mesh(`privacy-screen-ties-${i + 1}`, (b) => {
      // Ties hold the privacy fabric on the exterior face of the railing.
      for (let t = 0.08 / length; t < 1; t += 0.5 / length) for (const y of [0.16, 1.59]) {
        const x = x0 + dx * t, z = z0 + dz * t;
        b.rod(x, y, z, x + nx * 0.08, y, z + nz * 0.08, 0.004, S.rubber(0x313c4b), 5);
      }
    }));
  });
  return group;
}

// ------------------------------------------------------------------------------------------------- patio, lawn, beds

const LAWN_GREEN = new THREE.Color(0x58783a);
const LAWN_DRY = new THREE.Color(0x8f9150);
const LAWN_DARK = new THREE.Color(0x3d5c29);

/** Mottled summer lawn: greener in the hollows, a few straw-coloured dry patches. */
function lawnPaint(x: number, z: number, out: THREE.Color) {
  const n = valueNoise3(x * 0.32, z * 0.32, 1.7, 41);
  const m = valueNoise3(x * 1.3, z * 1.3, 0.3, 43);
  out.copy(LAWN_GREEN).lerp(LAWN_DRY, smoothstep(0.58, 0.88, n) * 0.65).lerp(LAWN_DARK, smoothstep(0.45, 0.15, n) * 0.5);
  out.multiplyScalar(0.9 + m * 0.18);
}

/** Tufts of three blades each, scattered evenly over a rectangle and coloured to match the lawn beneath. */
function grass(b: MeshBuilder, x0: number, x1: number, z0: number, z1: number, count: number, y: number, seed: number, skip: (x: number, z: number) => boolean, paint: (x: number, z: number, out: THREE.Color) => void, tall = 1) {
  const s = plant(0x6f8f45, 0.85);
  const base = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const x = x0 + frac(0.5 + i * 0.7548776662466927) * (x1 - x0);
    const z = z0 + frac(0.5 + i * 0.5698402909980532) * (z1 - z0);
    if (skip(x, z)) continue;
    paint(x, z, base);
    const h = (0.045 + hash(i, seed) * 0.065) * tall;
    const rot = hash(i, seed + 1) * TAU;
    for (let k = 0; k < 3; k++) {
      const a = rot + k * 2.094;
      const ca = Math.cos(a), sa = Math.sin(a);
      const lean = (hash(i * 3 + k, seed + 2) - 0.5) * 0.07;
      const bx = x + (hash(i * 3 + k, seed + 3) - 0.5) * 0.05;
      const bz = z + (hash(i * 3 + k, seed + 4) - 0.5) * 0.05;
      _col.copy(base).multiplyScalar(0.72);
      const i0 = vert(b, bx - ca * 0.009, y, bz - sa * 0.009, 0, 1, 0, s, _col);
      const i1 = vert(b, bx + ca * 0.009, y, bz + sa * 0.009, 0, 1, 0, s, _col);
      _col.copy(base).multiplyScalar(1.22 + hash(i, seed + 5) * 0.22);
      const i2 = vert(b, bx - sa * lean, y + h, bz + ca * lean, 0, 1, 0, s, _col);
      b.idx.push(i0, i1, i2, i0, i2, i1);
    }
  }
}

const BEDS = {
  back: { minX: -6.95, maxX: 6.95, minZ: 7.3, maxZ: 7.85 },
  left: { minX: -6.95, maxX: -6.4, minZ: -1.3, maxZ: 7.3 },
  right: { minX: 6.42, maxX: 6.95, minZ: -1.3, maxZ: 7.3 },
};
const inBed = (x: number, z: number, pad = 0) => Object.values(BEDS).some((r) => x > r.minX - pad && x < r.maxX + pad && z > r.minZ - pad && z < r.maxZ + pad);

function grounds() {
  const group = new THREE.Group();
  group.name = 'patio-lawn-and-fence';
  const P = GARDEN_BOUNDS.patio;
  const depth = P.maxZ - P.minZ, centreZ = (P.maxZ + P.minZ) / 2;
  const width = P.maxX - P.minX, centreX = (P.maxX + P.minX) / 2;
  group.add(mesh('tiled-patio', (b) => {
    b.box(centreX, -0.005, centreZ, width, 0.022, depth, S.concrete(0x8c897f, 0.12));
    // 75 cm porcelain tiles, each a shade apart, cut at the edges.
    const xs: number[] = [P.minX];
    for (let x = -6.75; x < P.maxX - 0.01; x += 0.75) xs.push(x);
    xs.push(P.maxX);
    const zs: number[] = [P.minZ];
    for (let z = -4.5; z < P.maxZ - 0.01; z += 0.75) zs.push(z);
    zs.push(P.maxZ);
    let k = 0;
    for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < zs.length - 1; j++) {
      const x0 = xs[i] + 0.004, x1 = xs[i + 1] - 0.004, z0 = zs[j] + 0.004, z1 = zs[j + 1] - 0.004;
      b.quad([x0, 0.0075, z0], [x0, 0.0075, z1], [x1, 0.0075, z1], [x1, 0.0075, z0], tone({ c: 0xc6c1b2, r: 0.55, m: 0, w: 0.15 }, 0.95 + hash(k++, 2) * 0.09));
    }
  }));
  const lawnStart = P.maxZ + 0.05;
  group.add(mesh('lawn-and-boundary', (b) => {
    b.box(0, -0.17, 1.6, 14.0, 0.32, 12.6, S.concrete(0xaca99e, 0.12));
    const lawnDepth = GARDEN_BOUNDS.lawnEnd - P.maxZ;
    b.box(0, 0.022, (P.maxZ + GARDEN_BOUNDS.lawnEnd) / 2, 13.8, 0.035, lawnDepth, S.cloth(0x52713b, 0));
    b.box(0, 0.035, P.maxZ, 14, 0.07, 0.1, S.concrete(0xd0cbbd, 0.08));
    grid(b, steps(BEDS.left.maxX, BEDS.right.minX, 0.35), steps(lawnStart, BEDS.back.minZ, 0.35), (x, z) => [x, 0.041, z], [0, 1, 0], plant(0x58783a, 0.95), lawnPaint);
  }));
  group.add(mesh('lawn-grass', (b) => {
    const trees = GARDEN_LAYOUT.trees;
    const T = GARDEN_LAYOUT.trampoline;
    grass(b, BEDS.left.maxX, BEDS.right.minX, lawnStart, BEDS.back.minZ, 4200, 0.04, 11, (x, z) => trees.some(([tx, tz]) => Math.hypot(x - tx, z - tz) < 0.5), lawnPaint);
    // Longer grass where the mower misses: along the beds and round the trampoline's legs.
    grass(b, BEDS.left.maxX, BEDS.right.minX, lawnStart, BEDS.back.minZ, 2600, 0.04, 13, (x, z) => {
      const edge = Math.min(x - BEDS.left.maxX, BEDS.right.minX - x, BEDS.back.minZ - z);
      const leg = Math.abs(Math.hypot(x - T[0], z - T[1]) - 1.44);
      return edge > 0.25 && leg > 0.12;
    }, lawnPaint, 1.6);
  }, false));
  group.add(mesh('flower-beds', flowerBeds));
  return group;
}

/** Beds along the fences: dark soil behind a concrete edging, bougainvillea climbing the fence, flowering shrubs between. */
function flowerBeds(b: MeshBuilder) {
  const soil = S.concrete(0x4a3a2b, 0.3);
  const edging = S.concrete(0xc9c3b3, 0.2);
  for (const r of Object.values(BEDS)) b.box((r.minX + r.maxX) / 2, 0.045, (r.minZ + r.maxZ) / 2, r.maxX - r.minX, 0.03, r.maxZ - r.minZ, soil);
  b.box((BEDS.left.maxX + BEDS.right.minX) / 2, 0.065, BEDS.back.minZ - 0.03, BEDS.right.minX - BEDS.left.maxX + 0.06, 0.07, 0.06, edging);
  b.box(BEDS.left.maxX + 0.03, 0.065, (BEDS.left.minZ + BEDS.left.maxZ) / 2, 0.06, 0.07, BEDS.left.maxZ - BEDS.left.minZ, edging);
  b.box(BEDS.right.minX - 0.03, 0.065, (BEDS.right.minZ + BEDS.right.maxZ) / 2, 0.06, 0.07, BEDS.right.maxZ - BEDS.right.minZ, edging);
  // Mulch and pebbles scattered in the soil.
  for (let i = 0; i < 90; i++) {
    const r = [BEDS.back, BEDS.left, BEDS.right][i % 3];
    const x = r.minX + 0.05 + hash(i, 61) * (r.maxX - r.minX - 0.1);
    const z = r.minZ + 0.05 + hash(i, 62) * (r.maxZ - r.minZ - 0.1);
    b.add('ico', x, 0.062, z, 0.05, 0.02, 0.04, S.wood(i % 2 ? 0x6a5038 : 0x7d6448, 0.3), 0, i, 0);
  }
  bougainvillea(b, -5.9, 7.62, 2.2, 'x', -1, 71);
  bougainvillea(b, 1.9, 7.62, 1.8, 'x', -1, 73);
  bougainvillea(b, -6.7, 2.4, 1.9, 'z', 1, 75);
  bougainvillea(b, 6.7, -0.4, 1.6, 'z', -1, 77);
  // Low shrubs between them: geranium, lantana, rosemary, agapanthus, lavender.
  const kinds: [number, number | null, number, number][] = [
    [0x3f6a2e, 0xd83a2a, 0.22, 0.4], [0x4a6b31, 0xf2a03a, 0.26, 0.45], [0x6d8a6a, null, 0.25, 0.55], [0x3e6b35, 0x6f8fd8, 0.2, 0.5], [0x7b8d74, 0x8a6fc0, 0.22, 0.4],
  ];
  const spots: [number, number][] = [];
  for (let x = -4.0; x < 6.2; x += 1.15) if (Math.abs(x - 1.9) > 1.2) spots.push([x, 7.58]);
  for (let z = -0.6; z < 7.0; z += 1.25) if (Math.abs(z - 2.4) > 1.2) spots.push([-6.66, z]);
  for (let z = 1.3; z < 7.0; z += 1.3) spots.push([6.68, z]);
  spots.forEach(([x, z], i) => {
    const [leafHex, flower, r, h] = kinds[i % kinds.length];
    shrub(b, x, z, r * (0.85 + hash(i, 81) * 0.3), h * (0.85 + hash(i, 82) * 0.3), leafHex, flower, flower === null ? 0 : 22, 90 + i);
  });
  // A garden tap on a standpipe in the left bed, and the hose snaking out across the lawn.
  b.rod(-6.72, 0.03, 1.6, -6.72, 0.62, 1.6, 0.016, S.metal(0xb87333, 0.4), 8);
  b.rod(-6.72, 0.6, 1.6, -6.64, 0.6, 1.6, 0.014, S.metal(0xb7a24a, 0.3), 8);
  b.box(-6.72, 0.66, 1.6, 0.06, 0.02, 0.02, S.paint(0xb03a2e, 0.2));
  const hose = S.rubber(0x3f7a3a);
  b.pipe([[-6.62, 0.58, 1.6], [-6.56, 0.3, 1.62], [-6.48, 0.07, 1.7], [-6.2, 0.06, 1.92], [-5.86, 0.06, 2.35], [-5.42, 0.06, 2.48], [-5.06, 0.06, 2.22], [-5.2, 0.06, 1.88], [-5.6, 0.06, 1.8], [-5.75, 0.06, 2.05]], 0.012, hose, 6);
  b.rod(-5.75, 0.06, 2.05, -5.72, 0.065, 2.22, 0.018, S.plastic(0xe0a020, 0.2), 8);
}

/** Bougainvillea trained up the fence: woody stems, a dense green mass spilling over the top, magenta bracts all over it. */
function bougainvillea(b: MeshBuilder, x: number, z: number, span: number, along: 'x' | 'z', out: number, seed: number) {
  const P = (u: number, y: number, w: number): V3 => (along === 'x' ? [x + u, y, z + w * out] : [x + w * out, y, z + u]);
  const bark = S.wood(0x6a5440, 0.3);
  for (let k = 0; k < 4; k++) {
    const u = (hash(k, seed) - 0.5) * span * 0.5;
    const a = P(u * 0.3, 0.05, 0.12), m = P(u, 0.9, 0.1), t = P(u * 1.3, 1.6, 0.05);
    b.pipe([a, m, t], 0.022 - k * 0.003, bark, 6);
  }
  const greens = [0x355e2a, 0x426f31, 0x2c5224];
  const bracts = [0xc8186e, 0xd6338a, 0xb3125f, 0xe0559c];
  // One mass trained flat along the fence, and a looser spill over its top.
  const flat = (w: number, d: number): [number, number] => (along === 'x' ? [w, d] : [d, w]);
  const m = P(0, 1.02, 0.24);
  const [mx, mz] = flat(span * 0.52, 0.3);
  foliage(b, m[0], m[1], m[2], mx, 0.86, mz, Math.round(span * 320), 0.16, greens, seed, { minY: -0.55, lump: 0.3, accent: bracts, share: 0.4 });
  const t = P(span * 0.08, 1.86, 0.04);
  const [tx, tz] = flat(span * 0.4, 0.26);
  foliage(b, t[0], t[1], t[2], tx, 0.26, tz, Math.round(span * 110), 0.13, greens, seed + 5, { minY: -0.3, lump: 0.3, accent: bracts, share: 0.55 });
}

// ------------------------------------------------------------------------------------------------- the driveway

function driveway() {
  const group = new THREE.Group();
  group.name = 'driveway-and-street-front';
  const D = DRIVEWAY;
  const kerbW = 0.15;
  const apron = 0.3;
  const x0 = D.minX + kerbW, x1 = D.maxX - kerbW, z0 = D.minZ + apron, z1 = D.maxZ;
  const gateA = GATE.x - GATE.w / 2 - 0.05, gateB = GATE.x + GATE.w / 2 + 0.05;
  group.add(mesh('driveway-pavers', (b) => {
    b.box((x0 + x1) / 2, -0.018, (z0 + z1) / 2, x1 - x0, 0.012, z1 - z0, S.concrete(0x6b675f, 0.3));
    // Interlocking concrete pavers in running bond: a charcoal border, a terracotta walk to the gate, grey for the car.
    const pw = 0.24, pd = 0.12, gap = 0.006;
    const col = new THREE.Color();
    let row = 0, k = 0;
    for (let z = z0; z < z1 - 1e-6; z += pd, row++) {
      const za = z + gap / 2, zb = Math.min(z + pd, z1) - gap / 2;
      const off = (row % 2) * pw * 0.5;
      for (let x = x0 - off; x < x1 - 1e-6; x += pw, k++) {
        const xa = Math.max(x, x0) + gap / 2, xb = Math.min(x + pw, x1) - gap / 2;
        if (xb - xa < 0.02) continue;
        const cx = (xa + xb) / 2, cz = (za + zb) / 2;
        let hex = 0x8f8b83;
        if (cx < x0 + 0.24 || cx > x1 - 0.24 || cz < z0 + 0.24 || cz > z1 - 0.12) hex = 0x57544e;
        else if (cx > gateA && cx < gateB) hex = 0x9c6a54;
        else if (hash(k, 3) > 0.86) hex = 0x7a766e;
        col.set(hex).multiplyScalar(0.92 + hash(k, 5) * 0.14);
        // An oil stain and tyre-worn strips where the car stands.
        const stain = Math.hypot((cx - 2.9) / 0.5, (cz + 16.6) / 0.35);
        if (stain < 1) col.multiplyScalar(0.72 + 0.28 * stain);
        if (cx > 1.0 && cx < 4.8 && cz < -15 && (Math.abs(cx - 2.05) < 0.15 || Math.abs(cx - 3.65) < 0.15)) col.multiplyScalar(0.93);
        b.quad([xa, -0.008, za], [xa, -0.008, zb], [xb, -0.008, zb], [xb, -0.008, za], { c: col, r: 0.85, m: 0, w: 0.35 });
      }
    }
    // The dropped kerb where the driveway meets the road.
    b.box((D.minX + D.maxX) / 2, -0.013, D.minZ + apron / 2, D.maxX - D.minX, 0.014, apron, S.concrete(0xa9a59b, 0.4));
  }, false));
  group.add(mesh('driveway-kerbs', (b) => {
    // Kerb stones down both sides; the last metres before the road painted red and white (no parking).
    for (const x of [D.minX + kerbW / 2, D.maxX - kerbW / 2]) {
      let i = 0;
      for (let z = D.minZ + apron; z < D.maxZ - 0.01; z += 0.5, i++) {
        const len = Math.min(0.5, D.maxZ - z) - 0.01;
        const painted = z < D.minZ + 3.2;
        const s = painted ? S.paint(i % 2 ? 0xf0ede4 : 0xc23b2e, 0.4) : S.concrete(0xb5b2a8, 0.35);
        b.box(x, 0.035, z + len / 2 + 0.005, kerbW, 0.13, len, tone(s as Surf, 0.95 + hash(i, x) * 0.08));
      }
    }
  }));
  group.add(mesh('street-lamp', (b) => {
    const pole = S.paint(0x8d9496, 0.35);
    const lx = D.maxX - 0.08, lz = D.maxZ - 0.55;
    b.cyl(lx, 0.05, lz, 0.3, 0.1, 0.3, S.concrete(0xa8a398, 0.4), 0, 0, 0, 12);
    b.frustum(lx, 0.45, lz, 0.065, 0.085, 0.8, pole, 0, 0, 0, 12);
    b.frustum(lx, 2.2, lz, 0.045, 0.065, 2.7, pole, 0, 0, 0, 12);
    b.pipe([[lx, 3.5, lz], [lx, 3.72, lz], [lx - 0.25, 3.86, lz], [lx - 0.85, 3.9, lz]], 0.03, pole, 8);
    b.rbox(lx - 1.05, 3.88, lz, 0.5, 0.08, 0.22, 0.03, S.paint(0x5d6466, 0.3));
    b.box(lx - 1.05, 3.835, lz, 0.4, 0.012, 0.16, S.glow(0xfff2dc, 2.2));
    b.box(lx, 0.9, lz - 0.07, 0.08, 0.16, 0.02, S.paint(0x6d7476, 0.3));
  }));
  group.add(mesh('street-front-apron', (b) => {
    // Pebbles along the walls that face the road, with agaves and a rosemary.
    const strips = [
      { minX: HB.minX, maxX: GARDEN_BOUNDS.frontGarden.minX - 0.05, minZ: HB.minZ - 0.55, maxZ: HB.minZ },
      { minX: HB.minX - 0.28, maxX: HB.minX, minZ: HB.minZ - 0.55, maxZ: HB.maxZ },
    ];
    let k = 0;
    for (const r of strips) {
      b.box((r.minX + r.maxX) / 2, -0.016, (r.minZ + r.maxZ) / 2, r.maxX - r.minX, 0.016, r.maxZ - r.minZ, S.concrete(0x8f8a7f, 0.3));
      const n = Math.round((r.maxX - r.minX) * (r.maxZ - r.minZ) * 32);
      for (let i = 0; i < n; i++, k++) {
        const s = 0.03 + hash(k, 21) * 0.03;
        b.add('ico', r.minX + 0.02 + hash(k, 22) * (r.maxX - r.minX - 0.04), -0.008, r.minZ + 0.02 + hash(k, 23) * (r.maxZ - r.minZ - 0.04), s * 1.2, s * 0.6, s, S.concrete([0xd7d2c6, 0xb9b3a6, 0xe8e4da][k % 3], 0.2), 0, k, 0);
      }
    }
    for (const [ax, az, s] of [[-5.2, -10.98, 1], [-1.0, -10.98, 0.85], [-7.14, -7.0, 0.7]] as const) {
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * TAU + hash(i, ax) * 0.3;
        const tiltA = 0.5 + (i % 3) * 0.25;
        const len = (0.32 + hash(i, az) * 0.12) * s;
        b.add('cone6', ax + Math.cos(a) * len * 0.35 * Math.sin(tiltA), len * 0.45 * Math.cos(tiltA), az + Math.sin(a) * len * 0.35 * Math.sin(tiltA), 0.07 * s, len, 0.03 * s, plant(i % 2 ? 0x7f9c8d : 0x6f8c7e, 0.6), tiltA, -a + Math.PI / 2, 0);
      }
    }
    shrub(b, -3.1, -11.0, 0.3, 0.45, 0x6d8a6a, 0x9fb0d8, 12, 141);
    shrub(b, 1.0, -11.0, 0.24, 0.38, 0x7b8d74, 0x8a6fc0, 14, 143);
  }));
  return group;
}

// ------------------------------------------------------------------------------------------------- trees and furniture

function storageUnit() {
  return mesh('left-fence-storage-unit', (b) => {
    const frame = S.paint(0xc9cfc5, 0.12), trim = S.paint(0x999f93, 0.1);
    b.rbox(0, 0.94, 0, 1.3, 1.84, 0.55, 0.02, frame);
    for (const x of [-0.319, 0.319]) b.rbox(x, 0.94, 0.286, 0.622, 1.76, 0.026, 0.008, S.paint(0xc1c8bd, 0.1));
    b.box(0, 0.94, 0.307, 0.018, 1.76, 0.018, trim);
    for (const x of [-0.07, 0.08]) b.box(x, 1.02, 0.328, 0.025, 0.14, 0.025, S.steel(0x4b5650));
    for (const x of [-0.59, 0.59]) for (const y of [0.45, 1.45]) b.box(x, y, 0.3, 0.03, 0.06, 0.035, trim);
    for (const x of [-0.57, 0.57]) for (const z of [-0.22, 0.22]) b.box(x, 0.02, z, 0.06, 0.04, 0.06, trim);
  });
}

function officeFridge() {
  const fridge = mesh('office-refrigerator-70-litre', (b) => {
    const enamel = S.paint(0xe9e7db, 0.04), seal = S.rubber(0x777e75);
    for (const x of [-0.17, 0.17]) for (const z of [-0.17, 0.17]) b.cyl(x, 0.017, z, 0.035, 0.034, 0.035, seal, 0, 0, 0, 8);
    b.rbox(0, 0.348, 0, 0.46, 0.65, 0.47, 0.02, enamel);
    b.rbox(0, 0.348, 0.242, 0.443, 0.623, 0.014, 0.01, seal);
    b.rbox(0, 0.348, 0.263, 0.436, 0.617, 0.042, 0.018, enamel);
    b.rbox(0.07, 0.592, 0.287, 0.2, 0.019, 0.018, 0.006, S.paint(0x606b66, 0.04));
    b.box(0, 0.14, -0.239, 0.3, 0.13, 0.012, S.steel(0x48534e, 0.08));
    for (let i = 0; i < 5; i++) b.box(0, 0.09 + i * 0.024, -0.248, 0.28, 0.009, 0.005, S.paint(0x999f94, 0.08));
  });
  fridge.userData.capacityLitres = 70;
  return fridge;
}

/** A citrus tree: a short grey trunk, scaffold limbs, a dense rounded crown of glossy leaves, ripe oranges through it. */
function orangeTree(i: number) {
  return mesh(`orange-tree-${i + 1}`, (b) => {
    b.jitter = 0.05;
    const bark = S.wood(0x6e5e4e, 0.25);
    const lean = [0.05, -0.04, 0.03][i % 3];
    b.limb(0, 0, 0, lean, 0.98, lean * 0.6, 0.075, 0.056, bark, 9);
    for (let k = 0; k < 4; k++) {
      const a = k * 1.65 + i;
      const tx = Math.cos(a) * 0.42, tz = Math.sin(a) * 0.42, ty = 1.5 + (k % 2) * 0.18;
      b.limb(lean, 0.92, lean * 0.6, tx, ty, tz, 0.042, 0.022, bark, 7, true);
      b.limb(tx, ty, tz, tx * 1.35, ty + 0.35, tz * 1.35, 0.022, 0.012, bark, 5, true);
    }
    // The crown: a main dome and two side lobes of glossy leaf clumps, ripe fruit hanging in their skin.
    const greens = [0x2f5d27, 0x3d6e2e, 0x264f21, 0x4a7c36];
    const lobes: [number, number, number, number, number, number, number][] = [
      [lean * 0.8, 1.98, lean * 0.5, 0.82, 0.62, 0.8, 980],
      [Math.cos(i * 2.1) * 0.32, 1.72, Math.sin(i * 2.1) * 0.32, 0.55, 0.45, 0.55, 380],
      [Math.cos(i * 2.1 + 2.6) * 0.3, 1.78, Math.sin(i * 2.1 + 2.6) * 0.3, 0.5, 0.42, 0.52, 330],
    ];
    const skin: { p: V3; n: V3 }[] = [];
    lobes.forEach(([x, y, z, rx, ry, rz, n], k) => skin.push(...foliage(b, x, y, z, rx, ry, rz, n, 0.15, greens, 40 + i * 7 + k, { minY: -0.7, lump: 0.22, gloss: 0.55 })));
    for (let k = 0; k < 30; k++) {
      const at = skin[Math.floor(hash(k, 60 + i) * skin.length)];
      if (at.n[1] > 0.5) continue;
      const p: V3 = [at.p[0] + at.n[0] * 0.02, at.p[1] + at.n[1] * 0.02 - 0.03, at.p[2] + at.n[2] * 0.02];
      b.add('sphere', p[0], p[1], p[2], 0.08, 0.084, 0.08, { c: k % 4 ? 0xee8c1a : 0xf6a42b, r: 0.45, m: 0, w: 0 });
      b.add('ico', p[0], p[1] + 0.042, p[2], 0.016, 0.012, 0.016, plant(0x4b5a26));
    }
    b.cyl(0, 0.03, 0, 0.9, 0.06, 0.9, S.wood(0x5c4632, 0.3), 0, 0, 0, 24);
    b.torus(0, 0.045, 0, 0.46, 0.042, S.concrete(0xb6aa8e, 0.1), Math.PI / 2, 0, 0, 6, 24);
    for (let k = 0; k < 3; k++) {
      const a = k * 2.1 + i * 1.3;
      b.add('sphere', Math.cos(a) * 0.28, 0.095, Math.sin(a) * 0.28, 0.075, 0.07, 0.075, { c: k ? 0xd9801a : 0xb5701e, r: 0.5, m: 0, w: 0.2 });
    }
  });
}

/** Default seat top of the white garden chair, in metres. */
export const GARDEN_CHAIR_SEAT = 0.4785;

/**
 * The white garden chair with a slatted wooden seat. `seatTop` is the height of the top of the seat (the legs and back scale
 * with it), so a sitter of any build can be given a chair at his own seat height. Origin at the floor under the seat's middle,
 * facing +Z.
 */
export function gardenChair(seatTop = GARDEN_CHAIR_SEAT): THREE.Mesh {
  const s = seatTop - 0.0185;
  return mesh('white-leg-wooden-seat-chair', (b) => {
    const white = S.paint(0xf0ece0, 0.06);
    const wood = S.wood(0xb99462, 0.08);
    for (const x of [-0.2, 0.2]) for (const z of [-0.19, 0.19]) b.rod(x * 1.15, 0.03, z * 1.15, x, s, z, 0.025, white, 8);
    for (const x of [-0.2, 0.2]) b.rod(x, s - 0.07, -0.19, x, s + 0.44, -0.24, 0.025, white, 8);
    for (let k = 0; k < 4; k++) b.rbox(0, s, -0.175 + k * 0.116, 0.49, 0.037, 0.105, 0.01, wood);
    b.rbox(0, s + 0.33, -0.234, 0.48, 0.17, 0.038, 0.02, wood, -0.08);
    const brace = Math.max(0.1, s * 0.43);
    b.rod(-0.2, brace, -0.2, 0.2, brace, -0.2, 0.016, white, 6);
  });
}

function sofa() {
  return mesh('sofa-against-house-wall', (b) => {
    const frame = S.wood(0xb88d51, 0.1);
    const fabric = S.cloth(0xe2ddc7, 0.05);
    for (const x of [-1.15, 1.15]) for (const z of [-0.31, 0.31]) b.box(x, 0.15, z, 0.07, 0.3, 0.07, frame);
    b.rbox(0, 0.3, 0, 2.6, 0.17, 0.85, 0.04, frame);
    b.rbox(0, 0.68, -0.34, 2.6, 0.63, 0.13, 0.04, frame);
    for (const x of [-1.24, 1.24]) {
      b.rbox(x, 0.6, 0, 0.2, 0.08, 0.85, 0.025, frame);
      for (const z of [-0.3, 0.3]) b.box(x, 0.44, z, 0.07, 0.31, 0.07, frame);
    }
    for (const x of [-0.79, 0, 0.79]) {
      b.rbox(x, 0.43, 0.04, 0.76, 0.16, 0.69, 0.055, fabric);
      b.rbox(x, 0.71, -0.19, 0.76, 0.48, 0.18, 0.055, fabric, -0.13);
    }
    b.rbox(-0.98, 0.61, 0.03, 0.3, 0.32, 0.12, 0.07, S.cloth(0xcb9c62, 0.05), 0, 0, -0.25);
    b.rbox(0.97, 0.62, 0, 0.32, 0.32, 0.12, 0.07, S.cloth(0xd8d3bd, 0.05), 0, 0, 0.3);
    b.rbox(0.35, 0.6, -0.08, 0.3, 0.3, 0.11, 0.07, S.cloth(0x3f6f8a, 0.05), 0.2, 0.2, 0.1);
  });
}

function coffeeTable() {
  return mesh('coffee-table', (b) => {
    const white = S.paint(0xe4dfd1, 0.08);
    const wood = S.wood(0xd0ba8c, 0.06);
    for (const x of [-0.51, 0.51]) for (const z of [-0.25, 0.25]) b.rod(x * 1.08, 0.03, z * 1.08, x, 0.38, z, 0.026, white, 8);
    b.extrude('garden-oval-coffee-top', () => {
      const shape = new THREE.Shape();
      shape.absellipse(0, 0, 0.79, 0.44, 0, Math.PI * 2, false, 0);
      return shape;
    }, 0.045, 0.008, 0, 0.425, 0, wood, Math.PI / 2);
  });
}

function slide() {
  return mesh('kids-slide', (b) => {
    const green = S.plastic(0x488d65, 0.03);
    const red = S.plastic(0xc9472c, 0.02);
    const blue = S.plastic(0x447eac, 0.03);
    for (const x of [-0.28, 0.28]) {
      b.rod(x, 0.03, -0.35, x, 1.32, 0, 0.043, green, 10);
      b.rod(x, 0.03, -0.9, x, 1.32, -0.35, 0.043, green, 10);
      b.pipe([[x, 1.3, -0.4], [x, 1.55, -0.35], [x, 1.55, 0], [x, 1.29, 0.18]], 0.03, green, 8);
      b.pipe([[x, 1.28, 0.08], [x, 1.08, 0.5], [x, 0.42, 1.32], [x, 0.15, 1.8]], 0.055, red, 10);
    }
    for (let k = 0; k < 5; k++) b.rbox(0, 0.22 + k * 0.21, -0.83 + k * 0.095, 0.52, 0.06, 0.19, 0.018, blue);
    b.rbox(0, 1.27, -0.13, 0.62, 0.08, 0.42, 0.03, red);
    b.rbox(0, 0.71, 0.92, 0.54, 0.065, 2.02, 0.028, red, 0.6);
    b.rbox(0, 0.13, 1.85, 0.6, 0.06, 0.45, 0.028, red);
  });
}

function trampoline() {
  const group = new THREE.Group();
  group.name = 'trampoline';
  group.add(mesh('trampoline-frame', (b) => {
    const steel = S.chrome(0xa9aead);
    const pad = S.plastic(0x327aa0, 0.03);
    b.cyl(0, 0.67, 0, 2.66, 0.035, 2.66, S.rubber(0x282c2b), 0, 0, 0, 64);
    b.torus(0, 0.7, 0, 1.39, 0.12, pad, Math.PI / 2, 0, 0, 8, 64);
    for (let k = 0; k < 6; k++) {
      const a = (k * Math.PI) / 3;
      const x = Math.cos(a) * 1.44, z = Math.sin(a) * 1.44;
      b.rod(x, 0.1, z, x, 2.32, z, 0.024, steel, 8);
      b.rod(x, 0.72, z, x, 2.3, z, 0.04, S.rubber(0x262a2b), 8);
      const a2 = a + 0.4;
      b.pipe([[x, 0.62, z], [x, 0.04, z], [Math.cos(a2) * 1.43, 0.04, Math.sin(a2) * 1.43], [Math.cos(a2) * 1.43, 0.62, Math.sin(a2) * 1.43]], 0.023, steel, 8);
    }
    b.torus(0, 2.3, 0, 1.45, 0.022, S.rubber(0x272b2d), Math.PI / 2, 0, 0, 6, 64);
    // A small access ladder facing the garden.
    for (const x of [-0.21, 0.21]) b.rod(x, 0.02, 1.89, x, 0.72, 1.48, 0.018, steel, 8);
    for (let k = 0; k < 3; k++) b.rod(-0.21, 0.14 + k * 0.21, 1.81 - k * 0.12, 0.21, 0.14 + k * 0.21, 1.81 - k * 0.12, 0.022, steel, 8);
  }));
  // Real open mesh netting: thin lines leave the lawn and background visible through it.
  const vertices: number[] = [];
  const point = (a: number, y: number) => vertices.push(Math.cos(a) * 1.44, y, Math.sin(a) * 1.44);
  for (let k = 0; k < 112; k++) {
    const a = (k * Math.PI * 2) / 112;
    point(a, 0.78);
    point(a, 2.29);
  }
  for (let y = 0.78; y < 2.3; y += 0.075) for (let k = 0; k < 112; k++) {
    point((k * Math.PI * 2) / 112, y);
    point(((k + 1) * Math.PI * 2) / 112, y);
  }
  const net = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)), new THREE.LineBasicMaterial({ color: 0x1d2827, transparent: true, opacity: 0.42 }));
  net.name = 'trampoline-safety-net';
  group.add(dynamic(net));
  return group;
}

export function tongsGeometry() {
  const b = new MeshBuilder();
  b.jitter = 0;
  const steel = S.chrome(0xc9cccb);
  for (const sx of [-1, 1]) {
    b.rod(sx * 0.009, 0, -0.08, sx * 0.025, 0, 0.21, 0.006, steel, 8);
    b.add('sphere16', sx * 0.031, 0, 0.25, 0.046, 0.012, 0.085, steel);
    for (let k = 0; k < 4; k++) b.add('sphere', sx * 0.052, 0, 0.222 + k * 0.018, 0.013, 0.013, 0.017, steel);
  }
  b.torus(0, 0, -0.085, 0.012, 0.004, steel, Math.PI / 2, 0, 0, 6, 12);
  return b.build();
}

function steak(i: number) {
  return mesh(`tomahawk-steak-${i + 1}`, (b) => {
    b.add('sphere16', 0, 0.038, 0, 0.35, 0.09, 0.28, S.gloss(0xc89b68, 0.02));
    b.add('sphere16', 0, 0.07, 0, 0.31, 0.045, 0.24, S.gloss(0x85532d, 0.03));
    b.pipe([[0.12, 0.038, 0.06], [0.2, 0.041, 0.17], [0.27, 0.043, 0.34], [0.32, 0.044, 0.43]], 0.024, S.gloss(0xd3bb8a, 0), 10);
    // Seared parallel stripes and fat marbling on the upper surface.
    for (let k = -2; k <= 2; k++) b.rod(k * 0.049, 0.09, -0.082, k * 0.049 + 0.032, 0.091, 0.077, 0.006, S.cloth(0x38271b, 0), 6);
    b.pipe([[-0.08, 0.092, -0.035], [-0.02, 0.095, -0.005], [0.01, 0.095, 0.047], [0.07, 0.092, 0.072]], 0.004, S.gloss(0xd6b581, 0), 6);
  });
}

/** A skewer of kebab on the grill. */
function kebab(b: MeshBuilder, x: number, y: number, z: number, yaw: number, len = 0.3) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  b.rod(x - c * len * 0.6, y, z + s * len * 0.6, x + c * len * 0.6, y, z - s * len * 0.6, 0.003, S.chrome(0xb9bcbb), 5);
  b.capsule(x - c * len * 0.4, y + 0.006, z + s * len * 0.4, x + c * len * 0.4, y + 0.006, z - s * len * 0.4, 0.017, S.gloss(0x6b3a1e, 0.05), 8);
  for (let k = 0; k < 4; k++) {
    const t = -0.3 + k * 0.2;
    b.add('ico', x + c * len * t, y + 0.02, z - s * len * t, 0.02, 0.008, 0.036, S.cloth(0x2e1d12, 0), 0, yaw, 0);
  }
}

function grill() {
  const group = new THREE.Group();
  group.name = 'barbecue-grill';
  group.add(mesh('black-grill-and-grate', (b) => {
    const black = S.steel(0x202521, 0.15);
    for (const x of [-0.42, 0.42]) for (const z of [-0.27, 0.27]) b.rod(x * 1.12, 0.05, z * 1.2, x, 0.77, z, 0.028, black, 8);
    b.rbox(0, 0.77, 0, 1.05, 0.19, 0.73, 0.08, black);
    b.box(0, 0.825, 0, 0.95, 0.018, 0.63, S.rubber(0x151714));
    for (let k = 0; k < 22; k++) b.rod(-0.47 + k * 0.045, 0.875, -0.315, -0.47 + k * 0.045, 0.875, 0.315, 0.009, S.steel(0x3b3c34, 0.13), 6);
    for (const z of [-0.34, 0.34]) b.rod(-0.5, 0.88, z, 0.5, 0.88, z, 0.015, black, 8);
    b.box(-0.68, 0.85, 0, 0.29, 0.045, 0.68, black);
    b.box(0, 0.23, 0, 0.82, 0.04, 0.55, black);
    for (let k = 0; k < 15; k++) {
      b.add('ico1', -0.38 + (k % 5) * 0.18, 0.83, -0.21 + Math.floor(k / 5) * 0.19, 0.08, 0.045, 0.08, k % 3 ? S.rubber(0x34352e) : S.glow(0xd54812, 1.4));
    }
    // Kebab skewers along the front of the grate, and a stack of pitas warming on the side shelf.
    for (let k = 0; k < 2; k++) kebab(b, -0.15 + k * 0.32, 0.895, 0.285, 0.04 * k);
    for (let k = 0; k < 4; k++) b.cyl(-0.68 + (k % 2) * 0.01, 0.88 + k * 0.012, -0.12, 0.2, 0.011, 0.2, S.cloth(k === 3 ? 0xd7b277 : 0xe2c48f, 0.05), 0, 0, 0, 14);
    b.box(-0.68, 0.876, 0.17, 0.2, 0.012, 0.16, S.wood(0xb58a55, 0.1));
  }));
  const steaks = [steak(0), steak(1)];
  steaks.forEach((s, i) => {
    s.position.set(i ? 0.21 : -0.23, 0.883, i ? -0.1 : 0.06);
    s.rotation.y = i ? -0.42 : 0.65;
    // Kept out of the merged garden: they lift off the grate when the party gets strange (`AmiratGarden.high`).
    group.add(dynamic(s));
  });
  return group;
}

function prepTable() {
  return mesh('barbecue-prep-table', (b) => {
    const ivory = S.paint(0xeadfc5, 0.04);
    for (const x of [-0.28, 0.28]) for (const z of [-0.28, 0.28]) b.rod(x * 1.1, 0.025, z * 1.1, x, 0.72, z, 0.022, S.paint(0xe5dfcf, 0.04), 8);
    b.cyl(0, 0.755, 0, 1.04, 0.055, 1.04, ivory, 0, 0, 0, 48);
    b.torus(0, 0.744, 0, 0.505, 0.012, S.paint(0xd6cfb9, 0.04), Math.PI / 2, 0, 0, 8, 48);
    // Two steel bowls: curved sides and visible hollow interiors, with meat in one.
    for (const x of [-0.24, 0.24]) {
      b.lathe('amirat-bowl', [[0.04, 0], [0.08, 0.015], [0.15, 0.09], [0.19, 0.16], [0.185, 0.165], [0.142, 0.09], [0.072, 0.025], [0, 0.025]], x, 0.784, 0, S.chrome(0xbbc3c2), 0, 0, 0, 24);
    }
    for (let k = 0; k < 4; k++) b.rbox(0.19 + (k % 2) * 0.08, 0.844 + Math.floor(k / 2) * 0.04, 0, 0.09, 0.045, 0.09, 0.02, S.gloss(0xbd7865, 0));
    b.rbox(0, 0.795, 0.27, 0.32, 0.024, 0.18, 0.008, S.wood(0xcbaf7d, 0.02));
  });
}

/** A round plate or bowl from a profile: `r` its rim radius. */
function dish(b: MeshBuilder, key: string, x: number, y: number, z: number, r: number, deep: boolean, s: ColorIn) {
  const pts: [number, number][] = deep
    ? [[0, 0.004], [0.5, 0], [0.62, 0.01], [0.9, 0.3], [1, 0.52], [0.97, 0.53], [0.86, 0.32], [0.58, 0.05], [0, 0.04]]
    : [[0, 0.004], [0.6, 0], [0.7, 0.03], [1, 0.14], [0.97, 0.15], [0.68, 0.06], [0, 0.05]];
  b.lathe(`dish-${key}-${deep}`, pts, x, y, z, s, 0, 0, 0, 20, r);
}

/**
 * The coffee table crowded with the takeaway: foil trays of shawarma and kebabs, tubs of hummus and tahini with their lids
 * off, a bag of pitas, chips in their paper, cans and a big bottle of cola, cups, napkins, the bowl of sunflower seeds.
 * Coffee-table frame (its middle, the top at `COFFEE_TOP`). Ro's plate and beer go on the table's near-left corner, from the
 * cast, so that corner is left clear.
 */
function takeaway() {
  return mesh('coffee-table-takeaway', (b) => {
    const y = COFFEE_TOP;
    const foil = S.metal(0xc9ccce, 0.2);
    const tub = S.plastic(0xf4f2ec, 0.05);
    // A foil tray of shawarma strips with onion and parsley, its card lid folded back.
    const tray = (x: number, z: number, yaw: number, meat: number, seed: number) => {
      b.rbox(x, y + 0.02, z, 0.24, 0.04, 0.17, 0.008, foil, 0, yaw, 0);
      b.rbox(x, y + 0.036, z, 0.22, 0.012, 0.15, 0.006, S.metal(0xb7babc, 0.2), 0, yaw, 0);
      for (let k = 0; k < 14; k++) {
        const u = (hash(k, seed) - 0.5) * 0.18, v = (hash(k, seed + 1) - 0.5) * 0.11;
        const c = Math.cos(yaw), s = Math.sin(yaw);
        b.box(x + u * c + v * s, y + 0.048 + hash(k, seed + 2) * 0.01, z - u * s + v * c, 0.05, 0.012, 0.018, S.gloss(k % 4 ? meat : 0xd9c7a0, 0.05), 0, yaw + hash(k, seed + 3), 0);
      }
      for (let k = 0; k < 5; k++) b.box(x + (hash(k, seed + 4) - 0.5) * 0.15, y + 0.06, z + (hash(k, seed + 5) - 0.5) * 0.09, 0.008, 0.003, 0.008, plant(0x3f7a2a));
    };
    tray(0.12, 0.03, 0.15, 0x8a4f26, 21);
    tray(0.48, -0.12, -0.3, 0x6a391c, 23);
    // A tub of hummus, lid off and leaning on it, oil and paprika on top.
    const hummus = (x: number, z: number, top: number) => {
      b.frustum(x, y + 0.03, z, 0.075, 0.065, 0.06, tub, 0, 0, 0, 16);
      b.cyl(x, y + 0.058, z, 0.14, 0.004, 0.14, { c: top, r: 0.6, m: 0, w: 0 }, 0, 0, 0, 16);
      b.cyl(x, y + 0.061, z, 0.05, 0.003, 0.05, { c: 0x9b8a25, r: 0.12, m: 0, w: 0 }, 0, 0, 0, 12);
      // The lid, leaning on the tub on its rim.
      b.cyl(x + 0.1, y + 0.075, z + 0.03, 0.16, 0.008, 0.16, S.plastic(0xe9eef0, 0.05), 0.2, 0, 1.1, 16);
    };
    hummus(-0.36, -0.2, 0xd8bf8b);
    hummus(0.3, 0.26, 0xe8dcbc);
    // The seed bowl and a saucer of shells.
    dish(b, 'bowl', 0.04, y, -0.24, 0.08, true, S.gloss(0x2d6a8a, 0.05));
    for (let k = 0; k < 14; k++) b.add('ico', 0.04 + (hash(k, 1) - 0.5) * 0.1, y + 0.038 + hash(k, 2) * 0.01, -0.24 + (hash(k, 3) - 0.5) * 0.1, 0.016, 0.006, 0.009, S.wood(k % 2 ? 0x2b2a26 : 0x4a4740, 0.1), 0, k, 0);
    dish(b, 'plate', -0.14, y, -0.3, 0.07, false, S.gloss(0xf3f0e8, 0.04));
    for (let k = 0; k < 10; k++) b.add('ico', -0.14 + (hash(k, 4) - 0.5) * 0.08, y + 0.014, -0.3 + (hash(k, 5) - 0.5) * 0.08, 0.014, 0.004, 0.008, S.wood(0x6a6458, 0.1), 0, k, 0);
    // A bag of pitas, folded over.
    b.rbox(0.62, y + 0.03, 0.12, 0.2, 0.06, 0.16, 0.03, S.plastic(0xe9e4da, 0.04), 0, 0.4, 0);
    for (let k = 0; k < 3; k++) b.cyl(0.6 + k * 0.01, y + 0.012 + k * 0.012, 0.11, 0.15, 0.01, 0.15, S.cloth(k === 2 ? 0xd7b277 : 0xe2c48f, 0.05), 0, 0, 0, 14);
    // Chips in their paper, spilling.
    b.frustum(-0.02, y + 0.06, 0.24, 0.05, 0.035, 0.12, S.cloth(0xf0ece2, 0.04), 0, 0, 0, 12);
    for (let k = 0; k < 16; k++) b.box(-0.02 + (hash(k, 6) - 0.5) * 0.07, y + 0.11 + hash(k, 7) * 0.04, 0.24 + (hash(k, 8) - 0.5) * 0.07, 0.012, 0.07, 0.012, S.cloth(0xe2b54e, 0.05), hash(k, 9) - 0.5, k, hash(k, 10) - 0.5);
    for (let k = 0; k < 6; k++) b.box(0.06 + hash(k, 11) * 0.1, y + 0.007, 0.18 + hash(k, 12) * 0.1, 0.012, 0.012, 0.06, S.cloth(0xe2b54e, 0.05), 0, k * 0.9, 1.57);
    // Cans, a big bottle of cola and a stack of plastic cups.
    for (const [cx, cz, hue] of [[0.33, -0.3, 0xc8201e], [0.68, -0.08, 0x2a6a3a], [-0.2, -0.12, 0xc8201e]] as const) {
      b.cyl(cx, y + 0.06, cz, 0.066, 0.12, 0.066, S.metal(hue, 0.15), 0, 0, 0, 14);
      b.cyl(cx, y + 0.121, cz, 0.058, 0.004, 0.058, S.metal(0xc9ccce, 0.15), 0, 0, 0, 14);
    }
    b.lathe('cola-big', [[0, 0], [0.042, 0], [0.045, 0.01], [0.045, 0.2], [0.04, 0.25], [0.016, 0.29], [0.014, 0.31], [0, 0.31]], -0.55, y, -0.2, { c: 0x2a1408, r: 0.15, m: 0, w: 0 }, 0, 0, 0, 14);
    b.cyl(-0.55, y + 0.13, -0.2, 0.093, 0.075, 0.093, S.gloss(0xc8201e, 0.03), 0, 0, 0, 14);
    b.cyl(-0.55, y + 0.315, -0.2, 0.032, 0.02, 0.032, S.plastic(0xc8201e, 0.05), 0, 0, 0, 10);
    b.frustum(0.2, y + 0.055, -0.33, 0.037, 0.027, 0.11, S.plastic(0xdfe9ee, 0.05), 0, 0, 0, 12);
    b.frustum(0.5, y + 0.055, 0.24, 0.037, 0.027, 0.11, S.plastic(0xdfe9ee, 0.05), 0, 0, 0, 12);
    // Paper napkins, a few screwed up.
    b.box(0.74, y + 0.008, -0.02, 0.1, 0.016, 0.1, S.cloth(0xf7f5ef, 0.03), 0, 0.3, 0);
    for (let k = 0; k < 3; k++) b.add('ico', 0.2 + k * 0.17, y + 0.02, 0.33 - k * 0.27, 0.05, 0.035, 0.045, S.cloth(0xf2efe6, 0.03), 0, k, 0);
  });
}

// ------------------------------------------------------------------------------------------------- garden props

function gardenProps() {
  return mesh('garden-props', (b) => {
    // The cooler box beside the grill.
    const cool = { x: GARDEN_LAYOUT.cooler[0], z: GARDEN_LAYOUT.cooler[1] };
    b.rbox(cool.x, 0.18, cool.z, 0.56, 0.32, 0.36, 0.03, S.plastic(0x2e6db0, 0.15));
    b.rbox(cool.x, 0.36, cool.z, 0.58, 0.06, 0.38, 0.025, S.plastic(0xeeeeea, 0.12));
    for (const s of [-1, 1]) b.box(cool.x + s * 0.29, 0.26, cool.z, 0.025, 0.05, 0.14, S.plastic(0x9da3a6, 0.1));
    b.box(cool.x, 0.395, cool.z, 0.3, 0.012, 0.05, S.plastic(0x9da3a6, 0.1));
    // A football on the lawn by the trampoline.
    const ball = { x: 2.15, z: 2.65, r: 0.11 };
    b.add('sphere16', ball.x, ball.r + 0.04, ball.z, ball.r * 2, ball.r * 2, ball.r * 2, S.plastic(0xf2f1ec, 0.1));
    const ico = new THREE.IcosahedronGeometry(1, 0).getAttribute('position');
    const seen = new Set<string>();
    for (let i = 0; i < ico.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(ico, i).normalize();
      const key = v.toArray().map((n) => n.toFixed(2)).join();
      if (seen.has(key)) continue;
      seen.add(key);
      b.add('ico', ball.x + v.x * ball.r * 0.93, ball.r + 0.04 + v.y * ball.r * 0.93, ball.z + v.z * ball.r * 0.93, 0.07, 0.07, 0.07, S.plastic(0x1d1d1f, 0.1));
    }
    // The nargila by the sofa, its hose looped on the tiles.
    const ng = { x: 1.68, z: -4.28 };
    b.lathe('nargila-base', [[0, 0], [0.09, 0.005], [0.12, 0.08], [0.11, 0.16], [0.06, 0.23], [0.03, 0.26], [0, 0.26]], ng.x, 0, ng.z, S.gloss(0x2f7f86, 0.05), 0, 0, 0, 16);
    b.rod(ng.x, 0.26, ng.z, ng.x, 0.72, ng.z, 0.014, S.metal(0xc9a24a, 0.25), 10);
    for (const y of [0.34, 0.5, 0.6]) b.add('sphere16', ng.x, y, ng.z, 0.05, 0.035, 0.05, S.metal(0xc9a24a, 0.25));
    b.cyl(ng.x, 0.67, ng.z, 0.18, 0.012, 0.18, S.metal(0xc9a24a, 0.25), 0, 0, 0, 16);
    b.frustum(ng.x, 0.75, ng.z, 0.05, 0.03, 0.07, S.wood(0x8a4a2a, 0.2), 0, 0, 0, 12);
    b.cyl(ng.x, 0.79, ng.z, 0.1, 0.01, 0.1, S.chrome(0xd7d9d8), 0, 0, 0, 12);
    for (let k = 0; k < 3; k++) b.add('ico', ng.x + (k - 1) * 0.022, 0.802, ng.z + (k % 2) * 0.015, 0.025, 0.018, 0.025, S.glow(0xe0501a, 1.2));
    b.pipe([[ng.x + 0.03, 0.45, ng.z + 0.02], [ng.x + 0.15, 0.3, ng.z + 0.15], [ng.x + 0.2, 0.03, ng.z + 0.3], [ng.x + 0.05, 0.03, ng.z + 0.45], [ng.x - 0.15, 0.03, ng.z + 0.35], [ng.x - 0.1, 0.03, ng.z + 0.18], [ng.x + 0.05, 0.06, ng.z + 0.22]], 0.012, S.cloth(0x6a2a3a, 0.1), 6);
    b.rod(ng.x + 0.05, 0.06, ng.z + 0.22, ng.x + 0.17, 0.08, ng.z + 0.27, 0.01, S.wood(0xb98a4a, 0.1), 6);
    // Geraniums in terracotta by the kitchen wall, and a pot each side of the street door.
    for (const [px, pz, hue, r] of [[-2.0, -4.42, 0xd8322a, 0.17], [-2.6, -4.45, 0xe6567a, 0.15], [-3.0, -4.48, 0xd8322a, 0.12], [3.0, -11.35, 0xd8322a, 0.14], [4.62, -11.35, 0xe6567a, 0.14]] as const) {
      b.lathe('terracotta', [[0.62, 0], [0.8, 0.02], [1, 0.95], [1.06, 1.0], [1.06, 1.12], [0.95, 1.12], [0.9, 1.0], [0, 0.95]], px, 0, pz, S.concrete(0xb5653d, 0.3), 0, 0, 0, 16, r);
      const top = r * 1.05;
      const leaves: Blob[] = [{ x: px, y: top + r * 0.55, z: pz, rx: r * 1.15, ry: r * 0.65, rz: r * 1.15 }];
      foliage(b, px, top + r * 0.5, pz, r * 1.1, r * 0.6, r * 1.1, Math.round(26 + r * 160), Math.max(0.05, r * 0.42), [0x3d6a2c, 0x4a7a34, 0x335c26], Math.round(px * 10 + pz), { minY: -0.3 });
      for (let k = 0; k < 7; k++) {
        const at = onBlobs(leaves, k, 7 + Math.round(px * 3), 1.05, 0.15);
        if (!at) continue;
        b.rod(at.p[0], at.p[1] - 0.05, at.p[2], at.p[0], at.p[1] + 0.06, at.p[2], 0.004, plant(0x4a7a34), 4);
        for (let j = 0; j < 5; j++) b.add('ico', at.p[0] + Math.cos(j * 1.26) * 0.022, at.p[1] + 0.07 + (j % 2) * 0.01, at.p[2] + Math.sin(j * 1.26) * 0.022, 0.026, 0.02, 0.026, plant(hue, 0.7));
      }
    }
    // The olive tree in a big pot at the end of the patio.
    const ol = { x: -6.2, z: -1.9 };
    b.lathe('olive-pot', [[0.6, 0], [0.75, 0.02], [0.95, 0.7], [1, 0.95], [1.08, 1.0], [1.08, 1.1], [0.97, 1.1], [0.93, 1.0], [0, 0.92]], ol.x, 0, ol.z, S.concrete(0xa95a36, 0.35), 0, 0, 0, 20, 0.32);
    for (let k = 0; k < 3; k++) b.torus(ol.x, 0.08 + k * 0.1, ol.z, 0.21 + k * 0.02, 0.006, S.concrete(0x93492a, 0.3), Math.PI / 2, 0, 0, 4, 20);
    b.cyl(ol.x, 0.3, ol.z, 0.58, 0.02, 0.58, S.concrete(0x3e3024, 0.3), 0, 0, 0, 18);
    const olBark = S.wood(0x7a7062, 0.35);
    b.limb(ol.x, 0.3, ol.z, ol.x + 0.05, 0.85, ol.z - 0.03, 0.06, 0.045, olBark, 8);
    b.limb(ol.x + 0.05, 0.85, ol.z - 0.03, ol.x - 0.12, 1.3, ol.z + 0.05, 0.04, 0.025, olBark, 7, true);
    b.limb(ol.x + 0.05, 0.85, ol.z - 0.03, ol.x + 0.2, 1.35, ol.z - 0.1, 0.035, 0.022, olBark, 7, true);
    const crown: Blob[] = [
      { x: ol.x - 0.12, y: 1.45, z: ol.z + 0.05, rx: 0.32, ry: 0.26, rz: 0.3 },
      { x: ol.x + 0.2, y: 1.5, z: ol.z - 0.1, rx: 0.3, ry: 0.25, rz: 0.3 },
      { x: ol.x + 0.04, y: 1.72, z: ol.z, rx: 0.3, ry: 0.22, rz: 0.28 },
      { x: ol.x - 0.02, y: 1.3, z: ol.z - 0.18, rx: 0.22, ry: 0.18, rz: 0.2 },
    ];
    crown.forEach((c, k) => foliage(b, c.x, c.y, c.z, c.rx, c.ry, c.rz, 150, 0.085, [0x7d8b62, 0x95a37a, 0x6a7852, 0xa3ad8c], 151 + k * 5, { minY: -0.75, lump: 0.25, core: 1.3 }));
    for (let k = 0; k < 12; k++) {
      const at = onBlobs(crown, k, 155, 0.98, -0.6);
      if (at) b.add('sphere', at.p[0], at.p[1], at.p[2], 0.018, 0.024, 0.018, { c: 0x3a2a3a, r: 0.3, m: 0, w: 0 });
    }
  });
}

// ------------------------------------------------------------------------------------------------- the scene

/** How far behind the grill Amirat stands. */
const STATION_BACK = Math.hypot(GARDEN_LAYOUT.amirat[0] - GARDEN_LAYOUT.grill[0], GARDEN_LAYOUT.amirat[1] - GARDEN_LAYOUT.grill[1]);

export interface AmiratGardenOptions {
  /** False when Amirat is out on the road in a player's seat: the grill still smokes, but nobody stands at it. */
  amirat?: boolean;
}

export class AmiratGarden {
  readonly root = new THREE.Group();
  /** Amirat at the grill, or null when he is out on the road. */
  readonly amirat: Humanoid | null;
  /** His tongs, or null when he is not here. */
  readonly tongs: THREE.Mesh | null;
  readonly grill: THREE.Group;
  /** The grill and the man at it, turned to face the patio (`GARDEN_LAYOUT.grillYaw`). */
  readonly station = new THREE.Group();
  /** The gate's hinge: 0 shut, 1 swung open (`setGate`). */
  readonly gate: THREE.Object3D;
  /**
   * How high whoever is watching is, 0..1 (Iati's smoke): the steaks drift up off the grate and turn, Amirat sways at the
   * grill. Set it every frame; 0 is the ordinary barbecue.
   */
  high = 0;
  private steaks: THREE.Object3D[] = [];
  private steakRest: THREE.Vector3[] = [];
  readonly cover: THREE.Group;
  private fan: THREE.Mesh;
  private smoke: THREE.Mesh[] = [];
  private time = 0;
  private target = new THREE.Vector3();
  private pole = new THREE.Vector3(-0.8, -0.5, 0);
  private up = new THREE.Vector3(0, 1, 0);
  private axisX = new THREE.Vector3();
  private axisY = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private matrix = new THREE.Matrix4();

  constructor(opts: AmiratGardenOptions = {}) {
    this.root.name = 'amirat-family-garden';
    this.root.add(grounds(), house(), roofFittings(), frontGardenAndPassage(), frontGate(), metalFenceAndPrivacyScreen(), driveway());
    const cover = patioCover();
    this.cover = cover.group;
    this.fan = cover.fan;
    this.root.add(this.cover);
    const at = (o: THREE.Object3D, p: readonly [number, number]) => {
      o.position.set(p[0], 0, p[1]);
      this.root.add(o);
    };
    GARDEN_LAYOUT.trees.forEach((p, i) => at(orangeTree(i), p));
    GARDEN_LAYOUT.chairs.forEach(([x, z, yaw], i) => {
      const c = gardenChair();
      c.name = `white-leg-wooden-seat-chair-${i + 1}`;
      c.rotation.y = yaw;
      at(c, [x, z]);
    });
    at(sofa(), GARDEN_LAYOUT.sofa);
    at(coffeeTable(), GARDEN_LAYOUT.coffee);
    at(trampoline(), GARDEN_LAYOUT.trampoline);
    at(slide(), GARDEN_LAYOUT.slide);
    at(prepTable(), GARDEN_LAYOUT.prep);
    const storage = storageUnit(), fridge = officeFridge();
    storage.rotation.y = fridge.rotation.y = Math.PI / 2;
    at(storage, GARDEN_LAYOUT.storage);
    at(fridge, GARDEN_LAYOUT.fridge);
    this.root.add(gardenProps());
    at(takeaway(), GARDEN_LAYOUT.coffee);
    // The grill station out on the lawn: the grill, and Amirat behind it facing the patio. Its own frame: the grill at the
    // origin, Amirat at -Z facing +Z.
    this.station.name = 'grill-station';
    this.station.rotation.y = GARDEN_LAYOUT.grillYaw;
    at(this.station, GARDEN_LAYOUT.grill);
    this.grill = grill();
    this.station.add(this.grill);
    for (const name of ['tomahawk-steak-1', 'tomahawk-steak-2']) {
      const s = this.grill.getObjectByName(name);
      if (!s) continue;
      this.steaks.push(s);
      this.steakRest.push(s.position.clone());
    }
    this.gate = this.root.getObjectByName('front-gate-hinge')!;
    this.setGate(1);
    if (opts.amirat !== false) {
      const look = lookOf({});
      // Party clothes: plain dark jeans and his sneakers.
      look.legs = { style: 'trousers', c: 0x2b3442 };
      look.feet = { style: 'sneakers', c: 0x333936, c2: 0xaba99c };
      const amirat = new Humanoid({ ...identityOf(0), hero: 'amirat', look });
      amirat.root.name = 'amirat-grill-man';
      amirat.setWeapon('none');
      amirat.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
      amirat.root.position.set(0, 0, -STATION_BACK);
      this.station.add(dynamic(amirat.root));
      const tongs = new THREE.Mesh(tongsGeometry(), kitMaterial());
      tongs.name = 'amirat-grill-tongs';
      tongs.castShadow = true;
      this.station.add(dynamic(tongs));
      this.amirat = amirat;
      this.tongs = tongs;
    } else {
      this.amirat = null;
      this.tongs = null;
    }
    // A small reusable pool of smoke wisps above the coals.
    const smokeGeo = new THREE.SphereGeometry(1, 10, 8);
    for (let i = 0; i < 9; i++) {
      const m = new THREE.Mesh(smokeGeo, new THREE.MeshBasicMaterial({ color: 0xc2bdae, transparent: true, opacity: 0.04, depthWrite: false }));
      m.name = `grill-smoke-${i}`;
      this.station.add(dynamic(m));
      this.smoke.push(m);
    }
    this.update(0);
  }

  /** Cook for a few seconds, then look up with the photograph's smile. Allocates nothing. */
  update(dt: number) {
    this.time += dt;
    this.fan.rotation.y -= dt * 3.4;
    const h = this.amirat;
    const tongs = this.tongs;
    if (h && tongs) {
      const t = this.time % 9;
      const tending = smoothstep(1, 2, t) * (1 - smoothstep(6, 7.2, t));
      h.update(dt, 'stand', 0, 0, 0);
      h.torso.rotation.x = 0.04 + tending * 0.1;
      h.head.rotation.x = tending * 0.32;
      h.head.rotation.y = -0.06 * tending;
      // Seen high, he sways at the grill to music nobody else hears.
      h.torso.rotation.z = Math.sin(this.time * 2.2) * 0.14 * this.high;
      h.head.rotation.z = Math.sin(this.time * 2.2 + 0.8) * 0.18 * this.high;
      h.root.updateMatrixWorld(true);
      // Target is in the station's frame; reach expects the torso's frame.
      this.target.set(-0.19 + Math.sin(this.time * 1.2) * 0.055 * tending, 1.12 - 0.09 * tending, -STATION_BACK + 0.41 + 0.29 * tending);
      this.station.localToWorld(this.target);
      h.torso.worldToLocal(this.target);
      h.reach('R', this.target, this.pole);
      h.root.updateMatrixWorld(true);
      h.hand.getWorldPosition(this.target);
      this.station.worldToLocal(this.target);
      tongs.position.copy(this.target);
      this.dir.set(0.25 - tending * 0.2, -0.28 - tending * 0.16, 0.92).normalize();
      this.axisX.copy(this.up).cross(this.dir).normalize();
      this.axisY.copy(this.dir).cross(this.axisX).normalize();
      tongs.quaternion.setFromRotationMatrix(this.matrix.makeBasis(this.axisX, this.axisY, this.dir));
    }
    // Seen high: the steaks float up off the grate, turning, and the man at the grill sways to music nobody else hears.
    const k = this.high;
    for (let i = 0; i < this.steaks.length; i++) {
      const s = this.steaks[i];
      const r = this.steakRest[i];
      s.position.set(r.x + Math.sin(this.time * 0.9 + i * 2) * 0.12 * k, r.y + k * (0.35 + 0.12 * Math.sin(this.time * 1.7 + i)), r.z + Math.cos(this.time * 0.8 + i) * 0.1 * k);
      s.rotation.set(Math.sin(this.time * 1.3 + i) * 0.6 * k, (i ? -0.42 : 0.65) + this.time * 1.4 * k, Math.cos(this.time * 1.1 + i) * 0.5 * k);
    }
    for (let i = 0; i < this.smoke.length; i++) {
      const m = this.smoke[i];
      const age = (this.time * 0.23 + i / this.smoke.length) % 1;
      m.position.set(Math.sin(i * 2.4 + age * 2) * 0.12 + age * 0.25, 0.97 + age * 0.95, Math.cos(i * 2.4) * 0.14);
      m.scale.set(0.045 + age * 0.13, 0.04 + age * 0.2, 0.05 + age * 0.12);
      (m.material as THREE.MeshBasicMaterial).opacity = Math.sin(age * Math.PI) * 0.045;
    }
  }

  /** Swing the gate: 0 shut across the gateway, 1 open into the front garden (eased). */
  setGate(open: number) {
    const k = Math.min(1, Math.max(0, open));
    this.gate.rotation.y = GATE_SWING * k * k * (3 - 2 * k);
  }

  dispose() {
    disposeTree(this.root);
    this.root.removeFromParent();
  }
}
