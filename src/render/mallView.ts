import * as THREE from 'three';
import { MeshBuilder, S } from './builder';
import { levelBase, wallPieces, type BuildingPlan, type Rect } from '../world/interiors';
import { atriumRim, MALL, mallEscalators, rimOpen } from '../world/mall';
import type { RuralBuilding } from '../world/settlements';

/**
 * What makes Ofer Grand Mall (see `world/mall.ts`) more than a big plan building: the round court with its oval void,
 * the escalators, the glass balustrades and the downlights inside, and outside the cone over the court, the raised box
 * with the red sign, the grey block at the north end, the cantilevered wing over the blue glass corner and the bands of
 * pink stone along the walls. `render/buildingView.ts` calls in here for a plan whose look is 'mall'.
 */

type V3 = [number, number, number];
type Surf = Parameters<MeshBuilder['box']>[6];

const RIM_N = 64;
const WHITE = S.paint(0xf2f0ea, 0.18);
const MARBLE = S.gloss(0xe0dbd0, 0.1);
const STEEL = S.steel(0xb8bcc0, 0.25);
const LIGHT = S.glow(0xfff2dc, 1.1);
/** The court's ceilings: pale and faintly lit, as if the daylight from the cone were still bouncing round them. */
const CEILING = S.glow(0xe4e0d8, 0.16);

const X = (p: BuildingPlan, x: number) => p.x0 + x;
const Z = (p: BuildingPlan, z: number) => p.z0 + z;

/** The court, across the whole depth: on the upper floor its floor, its slab and the ceiling under it are the mall's own. */
export function mallCourt(p: BuildingPlan): Rect {
  return { x0: X(p, 0.3), x1: X(p, MALL.w - 0.3), z0: Z(p, MALL.court.z0), z1: Z(p, MALL.court.z1) };
}

/** Where the plain floors, ceilings and slabs of a level leave room for the court's own (`level` is the slab's level). */
export function mallCut(p: BuildingPlan, level: number): Rect[] {
  return p.look === 'mall' && level === 1 ? [mallCourt(p)] : [];
}

/** A flat shape with the oval cut out of it, laid level, `depth` thick, its top at `top`. */
function holed(b: MeshBuilder, p: BuildingPlan, key: string, half: [number, number], top: number, depth: number, color: Surf) {
  const a = MALL.atrium;
  b.extrude(
    `mall:${key}`,
    () => {
      const s = new THREE.Shape();
      s.moveTo(-half[0], -half[1]);
      s.lineTo(half[0], -half[1]);
      s.lineTo(half[0], half[1]);
      s.lineTo(-half[0], half[1]);
      s.closePath();
      const h = new THREE.Path();
      for (let i = 0; i <= RIM_N; i++) {
        const t = (-i / RIM_N) * Math.PI * 2;
        const x = Math.cos(t) * a.rx;
        const y = Math.sin(t) * a.rz;
        if (i === 0) h.moveTo(x, y);
        else h.lineTo(x, y);
      }
      s.holes.push(h);
      return s;
    },
    depth,
    0,
    X(p, a.x),
    top - depth / 2,
    Z(p, a.z),
    color,
    -Math.PI / 2,
  );
}

/** A band round the oval, `grow` out from its edge, from y0 to y1, both faces. */
function ovalBand(b: MeshBuilder, p: BuildingPlan, grow: number, y0: number, y1: number, color: Surf, inward = true, outward = true) {
  const pts = atriumRim(RIM_N, grow).map(([x, z]) => [X(p, x), Z(p, z)] as [number, number]);
  for (let i = 0; i < pts.length; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[(i + 1) % pts.length];
    // The rim runs clockwise seen from above, so the right of each step faces the middle.
    if (inward) b.quad([ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az], color);
    if (outward) b.quad([bx, y0, bz], [ax, y0, az], [ax, y1, az], [bx, y1, bz], color);
  }
}

/** A flat ring between two ovals at height y, facing up or down. */
function ovalRing(b: MeshBuilder, p: BuildingPlan, g0: number, g1: number, y: number, up: boolean, color: Surf) {
  const i0 = atriumRim(RIM_N, g0).map(([x, z]) => [X(p, x), Z(p, z)] as [number, number]);
  const i1 = atriumRim(RIM_N, g1).map(([x, z]) => [X(p, x), Z(p, z)] as [number, number]);
  for (let i = 0; i < RIM_N; i++) {
    const j = (i + 1) % RIM_N;
    const q: [V3, V3, V3, V3] = [[i1[i][0], y, i1[i][1]], [i1[j][0], y, i1[j][1]], [i0[j][0], y, i0[j][1]], [i0[i][0], y, i0[i][1]]];
    if (up) b.quad(q[0], q[3], q[2], q[1], color);
    else b.quad(q[0], q[1], q[2], q[3], color);
  }
}

// ------------------------------------------------------------------ inside, per storey

/**
 * One storey's own fittings. Upstairs: the court's floor with the void cut out of it, the white bulkhead round the void
 * with its ring of lights, and the glass balustrade with a steel handrail. Downstairs: the inlaid ring on the court
 * floor and the escalators. Both: downlights down the mall street.
 */
export function mallLevel(rb: RuralBuilding, p: BuildingPlan, L: number, inside: MeshBuilder, glass: MeshBuilder) {
  void rb;
  const base = levelBase(p, L);
  const M = MALL;
  const court = mallCourt(p);
  const half: [number, number] = [(court.x1 - court.x0) / 2, (court.z1 - court.z0) / 2];
  if (L === 1) {
    // The court's floor stands 4 mm proud of the storey's base, as the plain floors do: at the base itself it was one
    // plane with the tops of the walls below and of the escalator housings.
    holed(inside, p, 'court', half, base + 0.004, 0.3, MARBLE);
    holed(inside, p, 'court', half, base - 0.305, 0.01, CEILING);
    holed(inside, p, 'court', half, base + M.levelH - 0.006, 0.01, CEILING);
    ovalBand(inside, p, 0, base - 1.1, base - 0.3, WHITE, true, false);
    ovalBand(inside, p, 0.32, base - 1.1, base - 0.3, WHITE, false, true);
    ovalRing(inside, p, 0, 0.32, base - 1.1, false, WHITE);
    for (const [x, z] of atriumRim(40, 0.16)) inside.box(X(p, x), base - 1.115, Z(p, z), 0.18, 0.02, 0.18, LIGHT);
    // The balustrade: a glass panel per step round the oval, a steel post at every other one, a handrail along the top.
    const rim = atriumRim(RIM_N, 0.1).map(([x, z]) => [X(p, x), Z(p, z), x, z] as [number, number, number, number]);
    for (let i = 0; i < rim.length; i++) {
      const [ax, az, lx, lz] = rim[i];
      const [bx, bz, mx, mz] = rim[(i + 1) % rim.length];
      if (rimOpen((lx + mx) / 2, (lz + mz) / 2)) continue;
      glass.quad([ax, base + 0.06, az], [bx, base + 0.06, bz], [bx, base + 1.02, bz], [ax, base + 1.02, az], S.glass(0x9ab8c2));
      inside.rod(ax, base + 1.06, az, bx, base + 1.06, bz, 0.03, STEEL, 6);
      inside.rod(ax, base, az, bx, base, bz, 0.05, WHITE, 4);
      if (i % 2 === 0) inside.rod(ax, base, az, ax, base + 1.06, az, 0.022, STEEL, 6);
    }
  } else {
    // The court floor downstairs: a ring of darker stone inlaid under the void, and the escalators.
    ovalRing(inside, p, -0.9, -0.55, base + 0.02, true, S.gloss(0x8c7c6a, 0.15));
    ovalRing(inside, p, -0.3, -0.18, base + 0.02, true, S.gloss(0x8c7c6a, 0.15));
    escalators(p, inside, glass);
  }
  // Downlights in pairs down the mall street, and in the court a grid round the void.
  const ceil = base + M.levelH - (L === p.levels - 1 ? 0.03 : 0.32);
  // The street's ceiling takes the court's pale finish, a hair under the plain one.
  const streets: [number, number, number, number][] = [[M.frontRow, M.backRow, 0.3, M.court.z0], [M.frontRow, M.backRow, M.court.z1, M.anchor]];
  if (L === 1) streets.push([0.3, M.frontRow, M.passage.z0, M.passage.z1]);
  for (const [x0, x1, z0, z1] of streets) inside.quad([X(p, x0), ceil + 0.005, Z(p, z0)], [X(p, x1), ceil + 0.005, Z(p, z0)], [X(p, x1), ceil + 0.005, Z(p, z1)], [X(p, x0), ceil + 0.005, Z(p, z1)], CEILING);
  for (let z = 3; z < M.anchor - 1; z += 3) {
    const inCourt = z > M.court.z0 - 0.5 && z < M.court.z1 + 0.5;
    for (const dx of inCourt ? [-12, -9, 9, 12] : [-3, 3]) inside.box(X(p, M.atrium.x + dx), ceil, Z(p, z), 0.3, 0.02, 0.3, LIGHT);
  }
  // Under the cone the ceiling is open: the skylight's ring of lights hangs on the drum.
  if (L === p.levels - 1) for (const [x, z] of atriumRim(32, 0.15)) inside.box(X(p, x), base + M.levelH - 0.012, Z(p, z), 0.2, 0.02, 0.2, LIGHT);
}

/** The pair of escalators: steps, side skirts, the silver cladding under them, glass balustrades and black handrails. */
function escalators(p: BuildingPlan, inside: MeshBuilder, glass: MeshBuilder) {
  const base = p.floorY;
  const top = base + MALL.levelH;
  const list = mallEscalators();
  const e0 = list[0];
  const run = (e0.steps - 1) * e0.tread;
  const theta = Math.atan2(MALL.levelH, run);
  const len = Math.hypot(run, MALL.levelH);
  const z0 = Z(p, e0.z);
  const z1 = z0 + run;
  const xs = list.map((e) => X(p, e.x));
  const pairW = Math.abs(xs[1] - xs[0]) + e0.width + 0.5;
  const mid = (xs[0] + xs[1]) / 2;
  // Silver cladding under the pair, following the slope, with level ends into the floor and under the upper slab.
  inside.box(mid, base + MALL.levelH / 2 - 0.55 / Math.cos(theta), (z0 + z1) / 2, pairW, 0.7, len, S.metal(0xc6cace, 0.15), -theta);
  inside.box(mid, base + 0.15, z0 - 0.7, pairW, 0.3, 1.4, S.metal(0x9ea2a6, 0.3));
  // Its top a centimetre under the upper floor, so the last treads and the landing plate lie over it, not in its plane.
  inside.box(mid, top - 0.455, z1 + 0.3, pairW, 0.89, 0.9, S.metal(0xc6cace, 0.15));
  for (const e of list) {
    const x = X(p, e.x);
    // Treads and risers in brushed steel, with yellow edges.
    for (let i = 1; i < e.steps; i++) {
      const zc = z0 + (i - 1) * e.tread;
      const y = base + i * e.rise;
      inside.box(x, y - 0.02, zc + e.tread / 2, e.width, 0.04, e.tread, S.steel(0x7a7e82, 0.4));
      inside.box(x, y - e.rise / 2, zc, e.width, e.rise, 0.02, S.steel(0x5e6266, 0.4));
      inside.box(x, y, zc + 0.03, e.width, 0.012, 0.04, S.paint(0xe8c22a, 0.3));
    }
    inside.box(x, base + 0.01, z0 - 0.7, e.width + 0.2, 0.02, 1.4, S.steel(0x8a8e92, 0.3));
    inside.box(x, top + 0.01, z1 + 0.45, e.width + 0.2, 0.02, 0.9, S.steel(0x8a8e92, 0.3));
    for (const s of [-1, 1]) {
      const sx = x + s * (e.width / 2 + 0.07);
      // The skirt beside the steps, and on it the glass with the handrail along its top.
      inside.box(sx, base + MALL.levelH / 2 + 0.05, (z0 + z1) / 2, 0.12, 0.42, len, S.steel(0xa8acb0, 0.25), -theta);
      const lift = 0.12;
      const a: V3 = [sx, base + lift, z0];
      const b: V3 = [sx, top + lift, z1];
      glass.quad([sx, a[1], z0 - 1.2], [sx, a[1], z0], [sx, a[1] + 0.95, z0], [sx, a[1] + 0.95, z0 - 1.2], S.glass(0x9ab8c2));
      glass.quad([sx, a[1], a[2]], [sx, b[1], b[2]], [sx, b[1] + 0.95, b[2]], [sx, a[1] + 0.95, a[2]], S.glass(0x9ab8c2));
      glass.quad([sx, b[1], z1], [sx, b[1], z1 + 0.9], [sx, b[1] + 0.95, z1 + 0.9], [sx, b[1] + 0.95, z1], S.glass(0x9ab8c2));
      const rail = S.rubber(0x161616);
      inside.rod(sx, a[1] + 0.98, z0 - 1.2, sx, a[1] + 0.98, z0, 0.04, rail, 6);
      inside.rod(sx, a[1] + 0.98, z0, sx, b[1] + 0.98, z1, 0.04, rail, 6);
      inside.rod(sx, b[1] + 0.98, z1, sx, b[1] + 0.98, z1 + 0.9, 0.04, rail, 6);
    }
  }
}

// ------------------------------------------------------------------ outside

/**
 * The roof and the outside: the roof slab with the oval skylight, its drum and white cone; the parapet; the raised box
 * that carries the red sign; the grey block at the north end with walls that lean out as they rise; the angular wing over
 * the blue glass corner at the south end; the pink stone bands; the canopies over the doors; plant on the roof.
 */
export function mallRoof(rb: RuralBuilding, p: BuildingPlan, roof: MeshBuilder) {
  const M = MALL;
  const roofY = levelBase(p, p.levels);
  const cream = S.paint(rb.tint, 0.3);
  // Roof slab: bottom face just above the top ceiling, so it is the ceiling over the court. Its edges stop 2 cm inside the
  // walls' faces, behind the parapet, which comes down to the wall top: flush, the slab's edge, the parapet and the sign box
  // were all one plane along the front and flickered through each other.
  holed(roof, p, 'roof', [M.w / 2 - 0.02, M.d / 2 - 0.02], roofY + 0.32, 0.32, S.concrete(0xc9c5bc, 0.6));
  // The long sides run between the ends, so no two parapets share a face at the corners.
  for (const [cx, cz, sx, sz] of [[M.w / 2, 0.15, M.w, 0.3], [M.w / 2, M.d - 0.15, M.w, 0.3], [0.15, M.d / 2, 0.3, M.d - 0.6], [M.w - 0.15, M.d / 2, 0.3, M.d - 0.6]] as const) {
    roof.box(X(p, cx), roofY + 0.625, Z(p, cz), sx, 1.25, sz, cream);
    roof.box(X(p, cx), roofY + 1.27, Z(p, cz), sx + 0.08, 0.05, sz + 0.08, S.metal(0x9a9ea2, 0.35));
  }
  skylight(p, roof, roofY + 0.32);
  // The raised box over the main doors that carries the red sign, standing just proud of the front (and of the parapet's
  // coping) so it shares no face with them.
  const court = (M.court.z0 + M.court.z1) / 2;
  roof.box(X(p, 3) - 0.03, roofY + 1.8, Z(p, court), 6.06, 3.6, 32, S.metal(0xa6aaae, 0.3));
  roof.box(X(p, 3), roofY + 3.63, Z(p, court), 6.2, 0.06, 32.2, S.metal(0x8a8e92, 0.3));
  greyBlock(p, roof, roofY);
  southWing(p, roof, roofY);
  blueCorner(p, roof, roofY);
  stoneBands(rb, p, roof);
  // A canopy over the main doors, and one over the south doors.
  const glassRoof = S.glass(0x5a7480);
  roof.box(X(p, -1.7), 4.7, Z(p, court), 3.4, 0.2, 12, WHITE);
  roof.box(X(p, -1.7), 4.83, Z(p, court), 3.2, 0.06, 11.6, glassRoof);
  for (const dz of [-5.5, 5.5]) roof.rod(X(p, -3.3), 4.7, Z(p, court + dz), X(p, 0), 7.2, Z(p, court + dz), 0.04, STEEL, 6);
  roof.box(X(p, M.atrium.x), 3.8, Z(p, -1.4), 7, 0.2, 2.8, WHITE);
  // Plant on the roof: condensers in a row, a lift overrun, ducts.
  for (let i = 0; i < 6; i++) roof.rbox(X(p, 24.5), roofY + 0.32 + 0.6, Z(p, 8 + i * 4.2), 2.2, 1.2, 2.6, 0.06, S.metal(0x9a9ea0, 0.6));
  roof.box(X(p, 24), roofY + 1.7, Z(p, 86), 4, 2.8, 5, cream);
  roof.box(X(p, 22), roofY + 0.62, Z(p, 30), 0.7, 0.6, 22, S.metal(0x8a8e90, 0.5));
}

/** The drum round the void and the white cone over it, ribbed outside and lit from within. */
function skylight(p: BuildingPlan, roof: MeshBuilder, y0: number) {
  const a = MALL.atrium;
  const drumH = 1.5;
  const coneH = 7.4;
  ovalBand(roof, p, 0.3, y0, y0 + drumH, WHITE, false, true);
  const ring = atriumRim(RIM_N, 0.3).map(([x, z]) => [X(p, x), Z(p, z)] as [number, number]);
  const apex: V3 = [X(p, a.x), y0 + drumH + coneH, Z(p, a.z)];
  const yb = y0 + drumH;
  const membrane = S.paint(0xf7f6f1, 0.12);
  const lit = S.glow(0xfff6e4, 0.42);
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i];
    const [bx, bz] = ring[(i + 1) % ring.length];
    roof.quad([bx, yb, bz], [ax, yb, az], apex, apex, membrane);
    roof.quad([ax, yb, az], [bx, yb, bz], apex, apex, lit);
    if (i % 4 === 0) roof.rod(ax, yb, az, apex[0], apex[1], apex[2], 0.06, WHITE, 5);
  }
  // The inside of the drum glows too: daylight through the membrane.
  ovalBand(roof, p, 0.28, y0 - 0.3, yb, lit, true, false);
  roof.limb(apex[0], apex[1] - 0.2, apex[2], apex[0], apex[1] + 1.4, apex[2], 0.12, 0.02, WHITE, 8, true);
}

/** Horizontal metal panels, a quad per panel on a face that leans out by `lean` metres over its height. */
function cladFace(roof: MeshBuilder, corner: (u: number, y: number) => V3, u0: number, u1: number, y0: number, y1: number, skip?: (u0: number, u1: number, y0: number, y1: number) => [number, number][] | null) {
  const panel = [S.metal(0xa9aeb3, 0.3), S.metal(0x9da3a8, 0.3)];
  const groove = S.steel(0x50555a, 0.5);
  let k = 0;
  for (let y = y0; y < y1 - 0.01; y += 1.1) {
    const ya = y;
    const yb = Math.min(y1, y + 1.0);
    const spans = skip?.(u0, u1, ya, yb) ?? [[u0, u1]];
    for (const [a, b] of spans) {
      roof.quad(corner(a, ya), corner(b, ya), corner(b, yb), corner(a, yb), panel[k % 2]);
      if (yb < y1 - 0.01) roof.quad(corner(a, yb), corner(b, yb), corner(b, Math.min(y1, yb + 0.1)), corner(a, Math.min(y1, yb + 0.1)), groove);
    }
    k++;
  }
}

/** The grey block over the anchor stores: a box clad in horizontal panels whose street and north walls lean out as they rise. */
function greyBlock(p: BuildingPlan, roof: MeshBuilder, roofY: number) {
  const M = MALL;
  const H = 15.6;
  const lean = 1.3;
  const out = (y: number) => 0.06 + (y / H) * lean;
  const za = Z(p, M.anchor);
  const zb = (y: number) => Z(p, M.d) + out(y);
  const xf = (y: number) => X(p, 0) - out(y);
  const xb = X(p, M.w) + 0.06;
  const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
  // The street face, from the court side to the north corner (u runs south to north).
  cladFace(roof, (u, y) => [xf(y), y, lerp(za, zb(y), u)], 0, 1, 0, H);
  // The north face (u runs from the street corner to the back), round the anchor's street door.
  const door: [number, number] = [X(p, M.atrium.x - 2.1), X(p, M.atrium.x + 2.1)];
  cladFace(roof, (u, y) => [lerp(xf(y), xb, u), y, zb(y)], 0, 1, 0, H, (u0, u1, ya) => {
    if (ya > 3.25) return null;
    const at = (x: number) => (x - xf(ya)) / (xb - xf(ya));
    return [[u0, at(door[0])], [at(door[1]), u1]];
  });
  // The back (the car park side) stands upright (u runs north to south).
  cladFace(roof, (u, y) => [xb, y, lerp(zb(y), za, u)], 0, 1, 0, H);
  // The south face above the main roof, and the wedge between the leaning street face and the wall below.
  cladFace(roof, (u, y) => [lerp(xb, xf(y), u), y, za - 0.04], 0, 1, roofY + 1.3, H);
  // Up to where that face starts: above it, the face already covers the wedge and the two were one plane.
  for (let y = 0; y < roofY + 1.3 - 0.01; y += 1.1) {
    const yb = Math.min(roofY + 1.3, y + 1.1);
    roof.quad([X(p, 0), y, za - 0.04], [xf(y), y, za - 0.04], [xf(yb), yb, za - 0.04], [X(p, 0), yb, za - 0.04], S.metal(0x9da3a8, 0.3));
  }
  // The lid.
  roof.quad([xf(H), H, za], [xf(H), H, zb(H)], [xb, H, zb(H)], [xb, H, za], S.concrete(0x7e7a74, 0.7));
  roof.box((xf(H) + xb) / 2, H + 0.35, za + 0.12, xb - xf(H), 0.7, 0.25, S.metal(0x8e9398, 0.3));
  // The street door through the north face: a dark frame and a canopy.
  roof.box((door[0] + door[1]) / 2, 3.4, zb(3.4) + 0.4, 5.4, 0.2, 1.6, WHITE);
}

/** The angular wing over the south end: a sloping plane lifted at its south-west corner, on two slim columns. */
function southWing(p: BuildingPlan, roof: MeshBuilder, roofY: number) {
  const x0 = X(p, -2.5);
  const x1 = X(p, MALL.w + 1.5);
  const z0 = Z(p, -7);
  const z1 = Z(p, 22);
  const h = (x: number, z: number) => roofY + 1.9 + ((x1 - x) / (x1 - x0)) * 1.4 + ((z1 - z) / (z1 - z0)) * 1.6;
  const c: V3[] = [[x0, h(x0, z0), z0], [x1, h(x1, z0), z0], [x1, h(x1, z1), z1], [x0, h(x0, z1), z1]];
  const t = 0.35;
  const down = (v: V3): V3 => [v[0], v[1] - t, v[2]];
  const top = S.metal(0xb4b9be, 0.25);
  // Seen from above the corners run anticlockwise as listed when walked x0z1, x1z1, x1z0, x0z0.
  roof.quad(c[3], c[2], c[1], c[0], top);
  roof.quad(down(c[0]), down(c[1]), down(c[2]), down(c[3]), WHITE);
  for (let i = 0; i < 4; i++) {
    const a = c[i];
    const b = c[(i + 1) % 4];
    roof.quad(down(a), a, b, down(b), WHITE);
  }
  for (const z of [-5, 12]) roof.rod(X(p, -1.6), 0, Z(p, z), X(p, -1.6), h(X(p, -1.6), Z(p, z)) - t, Z(p, z), 0.16, WHITE, 10);
  // Struts from the roof up to the wing's underside.
  for (const [x, z] of [[8, 4], [22, 4], [8, 16], [22, 16]]) roof.rod(X(p, x), roofY + 0.32, Z(p, z), X(p, x), h(X(p, x), Z(p, z)) - t, Z(p, z), 0.12, S.steel(0x8a8e92, 0.3), 8);
}

/** The blue glass round the south-west corner, in front of the walls, with white mullions and transoms. */
function blueCorner(p: BuildingPlan, roof: MeshBuilder, roofY: number) {
  const g = S.glass(0x2e5288);
  const mull = S.paint(0xe8e8e4, 0.2);
  const top = roofY + 1.25;
  // Along the street face. The panes stand 5 mm clear of the plinth's face (8 cm proud of the wall), not level with it.
  roof.box(X(p, -0.065), top / 2, Z(p, 5.2), 0.04, top, 10.4, g);
  for (let z = 0; z <= 10.4; z += 1.73) roof.box(X(p, -0.1), top / 2, Z(p, z), 0.08, top, 0.08, mull);
  // Along the south face, short of the doors.
  roof.box(X(p, 5), top / 2, Z(p, -0.065), 10, top, 0.04, g);
  for (let x = 0; x <= 10; x += 1.67) roof.box(X(p, x), top / 2, Z(p, -0.1), 0.08, top, 0.08, mull);
  for (let y = 2.8; y < top; y += 2.8) {
    roof.box(X(p, -0.1), y, Z(p, 5.2), 0.08, 0.08, 10.4, mull);
    roof.box(X(p, 5), y, Z(p, -0.1), 10, 0.08, 0.08, mull);
  }
}

/** Bands of pale pink stone across the cream walls, where the walls are solid and not hidden by glass or cladding. */
function stoneBands(rb: RuralBuilding, p: BuildingPlan, roof: MeshBuilder) {
  const pink = S.concrete(0xdcb6a6, 0.35);
  const M = MALL;
  for (const w of p.walls) {
    if (!w.ext || w.out === 0) continue;
    const base = levelBase(p, w.level);
    const face = w.c + w.out * (w.t / 2 + 0.015);
    for (const piece of wallPieces(w)) {
      // Not behind the grey block, nor behind the blue glass corner.
      const u0 = piece.u0;
      const u1 = piece.u1;
      for (let y = 0.9; y < M.levelH * 2 + 1.2; y += 1.2) {
        const ya = Math.max(y, base + piece.v0);
        const yb = Math.min(y + 0.55, base + piece.v1);
        if (yb - ya < 0.05) continue;
        let a = u0;
        let b = u1;
        if (w.axis === 'z') {
          // A street or car park face: u is z.
          b = Math.min(b, Z(p, M.anchor) - 0.05);
          if (w.out < 0) a = Math.max(a, Z(p, 10.5));
        } else if (w.out > 0) continue;
        else a = Math.max(a, X(p, 10.2));
        if (b - a < 0.05) continue;
        if (w.axis === 'z') {
          if (w.out < 0) roof.quad([face, ya, a], [face, ya, b], [face, yb, b], [face, yb, a], pink);
          else roof.quad([face, ya, b], [face, ya, a], [face, yb, a], [face, yb, b], pink);
        } else roof.quad([b, ya, face], [a, ya, face], [a, yb, face], [b, yb, face], pink);
      }
    }
  }
  void rb;
}
