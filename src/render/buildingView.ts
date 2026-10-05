import * as THREE from 'three';
import { MeshBuilder, S } from './builder';
import { FacadeBuilder, facadeMaterial } from './facade';
import { appendFurn } from './furniture';
import { kitMaterial } from './materials';
import { hash2 } from '../core/rng';
import { PaneSet, type PaneSpec } from './glass';
import { levelBase, paneKey, paneKind, subtractRects, wallPieces, wellRails, type BuildingPlan, type FloorMat, type Opening, type Rect, type Stair, type Wall, T_EXT } from '../world/interiors';
import type { RuralBuilding } from '../world/settlements';

/**
 * One wasteland building as scenery: walls with real doorways and window openings (facade shader, inner and outer
 * faces), frames, doors and boards, floors, stairs, furniture, debris and a roof. Each storey is its own group and the
 * roof another, so the view can cut a building away: with a player inside, the roof and every storey above them go.
 */

// Facade styles (see facade.ts): 10 + base style gives the plain variant with no painted windows.
export const EXT_STYLE = { panel: 10, brick: 11, stucco: 12, siding: 14, metal: 16 } as const;
const INTERIOR_STYLE = 15;
const FLOOR_STYLE: Record<FloorMat, [number, number]> = {
  wood: [17, 0xb08a5c],
  tile: [18, 0xc8cac0],
  lino: [19, 0x8e9480],
  concrete: [19, 0xa6a49c],
  carpet: [19, 0x6e5248],
  dirt: [19, 0x6a5638],
};

const TRIM = [0xd8d4c8, 0xc8c0a8, 0x5a4630, 0x8a8a84];
const DOOR_COL = [0x6a5238, 0xa89a80, 0x4a5a58, 0x7a3a2c, 0x8a8478];

export interface BuildingGeometry {
  levels: { shell: THREE.BufferGeometry | null; trim: THREE.BufferGeometry | null; inside: THREE.BufferGeometry | null; panes: PaneSpec[] }[];
  roof: THREE.BufferGeometry | null;
}

const rect = (p: BuildingPlan): Rect => ({ x0: p.x0, x1: p.x1, z0: p.z0, z1: p.z1 });

export function buildBuildingGeometry(rb: RuralBuilding): BuildingGeometry {
  const plan = rb.plan;
  const levels: BuildingGeometry['levels'] = [];
  const rnd = (k: number) => hash2(rb.seed * 31 + k, k * 7 + 3, 53);
  for (let L = 0; L < plan.levels; L++) {
    const fb = new FacadeBuilder();
    const trim = new MeshBuilder();
    trim.jitter = 0.03;
    const inside = new MeshBuilder();
    inside.jitter = 0.03;
    const base = levelBase(plan, L);
    const roomTint = (x: number, z: number) => {
      const r = plan.rooms.find((q) => q.level === L && x >= q.x0 - 0.2 && x <= q.x1 + 0.2 && z >= q.z0 - 0.2 && z <= q.z1 + 0.2);
      return r ? r.tint : 0xc8c4b8;
    };
    const panes: PaneSpec[] = [];
    walls(rb, plan, L, base, fb, trim, roomTint, rnd, panes);
    floors(plan, L, base, fb, inside, rnd);
    ceiling(plan, L, base, fb);
    if (L > 0) slab(plan, L, base, inside);
    for (const s of plan.stairs) if (s.level === L) stairs(plan, s, base, inside);
    for (const f of plan.furn) if (f.level === L) appendFurn(inside, f, base + (L === 0 ? 0.012 : 0.004));
    for (const d of plan.debris) if (d.level === L) appendFurn(inside, { kind: 'rubble', level: L, x: d.x, z: d.z, yaw: 0, w: d.r * 2, d: d.r * 2, h: 0.4, seed: Math.floor(d.x * 13 + d.z * 7), solid: false }, base);
    levels.push({ shell: fb.empty ? null : fb.build(), trim: trim.empty ? null : trim.build(), inside: inside.empty ? null : inside.build(), panes });
  }
  const roof = new MeshBuilder();
  roof.jitter = 0.04;
  roofGeometry(rb, plan, roof, rnd);
  exterior(rb, plan, roof, rnd);
  return { levels, roof: roof.empty ? null : roof.build() };
}

// ------------------------------------------------------------------------------------------ walls

function walls(rb: RuralBuilding, plan: BuildingPlan, L: number, base: number, fb: FacadeBuilder, trim: MeshBuilder, roomTint: (x: number, z: number) => number, rnd: (k: number) => number, panes: PaneSpec[]) {
  const extTint = new THREE.Color(rb.tint);
  const trimCol = TRIM[Math.floor(rnd(1) * TRIM.length)];
  const cap = S.concrete(0xcfc8b8, 0.7);
  let wi = 0;
  for (const w of plan.walls) {
    if (w.level !== L) continue;
    wi++;
    for (const p of wallPieces(w)) {
      const yTop = base + p.v1;
      const yBot = base + p.v0;
      const mid = (p.u0 + p.u1) / 2;
      // Faces: exterior walls show the facade outside and plaster inside; interior walls plaster on both sides.
      for (const side of [-1, 1] as const) {
        const isOut = w.ext && side === w.out;
        const sx = w.axis === 'x' ? mid : w.c + side * 0.4;
        const sz = w.axis === 'x' ? w.c + side * 0.4 : mid;
        const tint = isOut ? extTint : new THREE.Color(roomTint(sx, sz));
        const y0 = isOut && L === 0 && p.v0 === 0 ? base - 0.9 : yBot;
        face(fb, w, p.u0, p.u1, y0, yTop, side, isOut ? rb.extStyle : INTERIOR_STYLE, tint, rb.seed * 0.37 + wi * 0.41, base);
      }
      // The long exterior walls run the full footprint and own the corner columns; their open ends would show the room
      // behind as a slit down every corner, so close them with a face in the exterior material.
      if (w.ext && w.axis === 'x') {
        const yCap = L === 0 && p.v0 === 0 ? base - 0.9 : yBot;
        const lo = w.c - w.t / 2;
        const hi = w.c + w.t / 2;
        const seed = rb.seed * 0.37 + wi * 0.41;
        if (p.u0 <= w.a + 0.001) fb.wall(w.a, lo, w.a, hi, yCap, yTop, 0, extTint, rb.extStyle, seed, 3, 2, base);
        if (p.u1 >= w.b - 0.001) fb.wall(w.b, hi, w.b, lo, yCap, yTop, 0, extTint, rb.extStyle, seed, 3, 2, base);
      }
      // Top edge so a cut-away wall reads as solid.
      if (p.v1 > 0.05 && p.solid) {
        const along = p.u1 - p.u0;
        const sillCap = p.v1 < w.h - 0.01;
        if (w.axis === 'x') trim.box(mid, yTop - 0.02, w.c, along, 0.04, w.t + (sillCap ? 0.1 : 0.01), cap);
        else trim.box(w.c, yTop - 0.02, mid, w.t + (sillCap ? 0.1 : 0.01), 0.04, along, cap);
      }
      // Plinth at the foot of exterior ground-floor walls.
      if (L === 0 && w.ext && p.v0 === 0 && p.solid) {
        const along = p.u1 - p.u0;
        const py = base + 0.12;
        // The plinth stands 0.08 proud of the wall, so at a corner the long wall's plinth has to run that far past the
        // wall end or it stops short of the side wall's plinth and leaves a notch.
        const lo = w.axis === 'x' && p.u0 <= w.a + 0.001 ? 0.08 : 0;
        const hi = w.axis === 'x' && p.u1 >= w.b - 0.001 ? 0.08 : 0;
        if (w.axis === 'x') trim.box(mid + (hi - lo) / 2, py - 0.18, w.c + w.out * 0.04, along + lo + hi, 0.5, w.t + 0.08, S.concrete(0x7c7a74, 0.6));
        else trim.box(w.c + w.out * 0.04, py - 0.18, mid, w.t + 0.08, 0.5, along, S.concrete(0x7c7a74, 0.6));
      }
    }
    const wallIndex = plan.walls.indexOf(w);
    for (const op of w.ops) opening(rb, plan, w, op, base, trim, trimCol, rnd, panes, wallIndex);
  }
}

/** One face of a wall piece. The normal of FacadeBuilder.wall is (-dz, dx), so the walking direction picks the side. */
function face(fb: FacadeBuilder, w: Wall, u0: number, u1: number, y0: number, y1: number, side: 1 | -1, style: number, tint: THREE.Color, seed: number, base: number) {
  const p = w.c + side * (w.t / 2);
  const forward = w.axis === 'x' ? side > 0 : side < 0;
  const a = forward ? u0 : u1;
  const b = forward ? u1 : u0;
  const uOff = forward ? u0 - w.a : w.b - u1;
  if (w.axis === 'x') fb.wall(a, p, b, p, y0, y1, uOff, tint, style, seed, 3, 2, base);
  else fb.wall(p, a, p, b, y0, y1, uOff, tint, style, seed, 3, 2, base);
}

function boxAlong(trim: MeshBuilder, w: Wall, u: number, y: number, perp: number, along: number, h: number, deep: number, color: Parameters<MeshBuilder['box']>[6], tilt = 0, yaw = 0) {
  if (w.axis === 'x') trim.box(u, y, w.c + perp, along, h, deep, color, 0, yaw, tilt);
  else trim.box(w.c + perp, y, u, deep, h, along, color, tilt, yaw, 0);
}

function opening(rb: RuralBuilding, plan: BuildingPlan, w: Wall, op: Opening, base: number, trim: MeshBuilder, trimCol: number, rnd: (k: number) => number, panes: PaneSpec[], wallIndex: number) {
  const width = op.b - op.a;
  const mid = (op.a + op.b) / 2;
  const k = Math.floor((op.a * 7 + w.c * 13) * 10);
  const r = (n: number) => hash2(k + n, n * 3, rb.seed);
  const deep = w.t + 0.03;
  const frame = S.paint(trimCol, 0.35);
  const wood = S.wood(0x5a4630, 0.8);
  const outSide = w.ext ? w.out : r(1) > 0.5 ? 1 : -1;
  if (op.kind === 'door') {
    const h = op.head;
    for (const u of [op.a + 0.04, op.b - 0.04]) boxAlong(trim, w, u, base + h / 2, 0, 0.08, h, deep, frame);
    boxAlong(trim, w, mid, base + h - 0.04, 0, width, 0.08, deep, frame);
    boxAlong(trim, w, mid, base + 0.015, 0, width, 0.03, w.t + 0.05, S.concrete(0x8a867e, 0.6));
    if (op.leaf !== 'none') {
      // A door hanging open on one hinge, swung into the room.
      const hinge = r(2) > 0.5 ? op.a + 0.05 : op.b - 0.05;
      const dir = hinge === op.a + 0.05 ? 1 : -1;
      const ang = 0.7 + r(3) * 0.9;
      const lw = width - 0.1;
      const swing = -outSide;
      // Along-wall and across-wall components of the leaf's direction.
      const du = Math.cos(ang) * dir;
      const dp = Math.sin(ang) * swing;
      const cu = hinge + (du * lw) / 2;
      const cp = (dp * lw) / 2;
      const col = DOOR_COL[Math.floor(r(4) * DOOR_COL.length)];
      const hh = h - 0.1;
      const toWorld = (u: number, pp: number): [number, number] => (w.axis === 'x' ? [u, w.c + pp] : [w.c + pp, u]);
      const [lx, lz] = toWorld(cu, cp);
      const ry = w.axis === 'x' ? Math.atan2(-dp, du) : Math.atan2(-du, dp);
      trim.box(lx, base + hh / 2 + 0.02, lz, lw, hh, 0.045, S.paint(col, 0.4), 0, ry, 0);
      const [kx, kz] = toWorld(hinge + du * lw * 0.9, dp * lw * 0.9);
      trim.box(kx, base + 1.0, kz, 0.07, 0.07, 0.07, S.metal(0xa8a090, 0.5));
    }
    return;
  }
  if (op.kind === 'gate') {
    const h = op.head;
    for (const u of [op.a - 0.12, op.b + 0.12]) boxAlong(trim, w, u, base + h / 2, 0, 0.26, h, deep + 0.1, wood);
    boxAlong(trim, w, mid, base + h + 0.1, 0, width + 0.6, 0.3, deep + 0.1, wood);
    boxAlong(trim, w, mid, base + 0.02, 0, width, 0.04, w.t + 0.06, S.concrete(0x8a867e, 0.6));
    if (rb.look === 'warehouse') {
      // Roll-up shutter rolled most of the way up.
      boxAlong(trim, w, mid, base + h - 0.25, outSide * (w.t / 2 + 0.1), width + 0.2, 0.5, 0.2, S.metal(0x8a8e90, 0.6));
      boxAlong(trim, w, mid, base + h * 0.72, outSide * (w.t / 2 + 0.02), width, h * 0.5, 0.03, S.metal(0x7a7e80, 0.7));
      for (const u of [op.a - 0.02, op.b + 0.02]) boxAlong(trim, w, u, base + h / 2, outSide * (w.t / 2 + 0.05), 0.08, h, 0.1, S.steel(0x3a3c3e, 0.7));
    } else {
      // Sliding barn doors: one pushed back along the wall, one half closed.
      const dw = width / 2 + 0.1;
      const col = S.wood(0x6a4430, 0.85);
      boxAlong(trim, w, op.a - dw / 2 + 0.05, base + (h - 0.1) / 2, outSide * (w.t / 2 + 0.07), dw, h - 0.1, 0.07, col);
      boxAlong(trim, w, op.b - dw * (0.3 + r(5) * 0.4) + dw / 2 - 0.1, base + (h - 0.1) / 2, outSide * (w.t / 2 + 0.07), dw, h - 0.1, 0.07, col);
      for (const u of [op.a - dw / 2 + 0.05]) {
        const ang = Math.atan2(h - 0.1, dw);
        boxAlong(trim, w, u, base + (h - 0.1) / 2, outSide * (w.t / 2 + 0.12), Math.hypot(dw, h - 0.1) * 0.98, 0.1, 0.03, S.wood(0x4a2e20, 0.85), ang);
      }
      boxAlong(trim, w, mid, base + h + 0.28, outSide * (w.t / 2 + 0.1), width + 1.2, 0.06, 0.1, S.steel(0x3a3c3e, 0.7));
    }
    return;
  }
  if (op.kind === 'breach') {
    boxAlong(trim, w, mid, base + 0.015, 0, width, 0.03, w.t + 0.05, S.concrete(0x8a867e, 0.6));
    // Ragged edges and the rubble that fell.
    const col = S.concrete(w.ext ? rb.tint : 0xcfc8b8, 0.8);
    for (const side of [-1, 1]) {
      const n = 3 + Math.floor(r(6) * 3);
      for (let i = 0; i < n; i++) {
        const hh = 0.3 + r(10 + i + side * 7) * Math.min(op.head, w.h) * 0.8;
        const dd = 0.08 + r(20 + i + side * 5) * 0.28;
        boxAlong(trim, w, side < 0 ? op.a + dd / 2 : op.b - dd / 2, base + Math.min(hh, op.head) / 2, 0, dd, Math.min(hh, op.head), w.t + 0.01, col);
      }
    }
    for (let i = 0; i < 5; i++) {
      const u = op.a + r(30 + i) * width;
      const s = 0.25 + r(40 + i) * 0.35;
      if (w.axis === 'x') trim.add('ico1', u, base + s * 0.35, w.c + (r(50 + i) - 0.5) * 1.6, s * 1.3, s, s * 1.1, S.concrete(0x8a867e, 0.8), r(60 + i), r(70 + i) * 6, 0);
      else trim.add('ico1', w.c + (r(50 + i) - 0.5) * 1.6, base + s * 0.35, u, s * 1.1, s, s * 1.3, S.concrete(0x8a867e, 0.8), r(60 + i), r(70 + i) * 6, 0);
    }
    return;
  }
  // Window.
  const { sill, head } = op;
  const hgt = head - sill;
  const cy = base + sill + hgt / 2;
  const tc = TRIM[Math.floor(r(7) * 2)];
  const fr = S.paint(tc, 0.35);
  for (const u of [op.a + 0.035, op.b - 0.035]) boxAlong(trim, w, u, cy, 0, 0.07, hgt, deep, fr);
  boxAlong(trim, w, mid, base + head - 0.035, 0, width, 0.07, deep, fr);
  boxAlong(trim, w, mid, base + sill + 0.03, 0, width + 0.1, 0.06, w.t + 0.1, S.concrete(0xcfc8b8, 0.6));
  if (op.glass === 'intact') {
    // The glass is a pane of its own, so it can crack and go; the bars across it stay in the frame.
    const out = w.out || 1;
    panes.push({ key: paneKey(wallIndex, op), kind: paneKind(plan.look, op), c: w.axis === 'x' ? [mid, cy, w.c] : [w.c, cy, mid], n: w.axis === 'x' ? [0, 0, out] : [out, 0, 0], hw: (width - 0.1) / 2, hh: (hgt - 0.1) / 2 });
    if (width > 1.1) boxAlong(trim, w, mid, cy, 0, 0.04, hgt - 0.1, 0.03, fr);
    boxAlong(trim, w, mid, cy, 0, width - 0.1, 0.04, 0.03, fr);
  } else if (op.glass === 'broken') {
    // Shards stuck in the frame and a curtain left hanging.
    for (let i = 0; i < 5; i++) {
      const top = i % 2 === 0;
      const u = op.a + 0.08 + r(80 + i) * (width - 0.2);
      const sh = 0.08 + r(90 + i) * 0.2;
      boxAlong(trim, w, u, top ? base + head - 0.08 - sh / 2 : base + sill + 0.06 + sh / 2, 0, 0.05 + r(95 + i) * 0.08, sh, 0.01, S.glass(0x22323c), (r(100 + i) - 0.5) * 0.6);
    }
    if (r(8) > 0.55) boxAlong(trim, w, op.a + 0.2, cy + hgt * 0.15, 0.0, 0.3, hgt * 0.6, 0.02, S.cloth([0x8a6a4a, 0x6a7a8a, 0x8a4a44][Math.floor(r(9) * 3)], 0.9), (r(11) - 0.5) * 0.15);
  } else {
    for (let i = 0; i < 3; i++) {
      const y = base + sill + 0.16 + i * (hgt - 0.3) / 2;
      boxAlong(trim, w, mid + (r(110 + i) - 0.5) * 0.08, y, outSide * (w.t / 2 + 0.025), width + 0.3, 0.14, 0.035, S.wood(0x5a4632 + Math.floor(r(120 + i) * 4) * 0x080604, 0.85), (r(130 + i) - 0.5) * 0.14);
    }
  }
}

// ------------------------------------------------------------------------------------------ floors, slabs, stairs

function floors(plan: BuildingPlan, L: number, base: number, fb: FacadeBuilder, inside: MeshBuilder, rnd: (k: number) => number) {
  const wells = plan.wells.filter((q) => q.level === L);
  const y = base + (L === 0 ? 0.012 : 0.004);
  for (const room of plan.rooms) {
    if (room.level !== L) continue;
    const [style, col] = FLOOR_STYLE[room.floor];
    const tint = new THREE.Color(room.floor === 'tile' && room.role === 'bath' ? 0xb4c4c4 : col);
    for (const p of subtractRects(room, wells)) {
      // Floor quads extend half a wall under each interior wall so no seam shows.
      const e = 0.09;
      const x0 = p.x0 - (p.x0 > plan.x0 + T_EXT + 0.05 ? e : 0);
      const x1 = p.x1 + (p.x1 < plan.x1 - T_EXT - 0.05 ? e : 0);
      const z0 = p.z0 - (p.z0 > plan.z0 + T_EXT + 0.05 ? e : 0);
      const z1 = p.z1 + (p.z1 < plan.z1 - T_EXT - 0.05 ? e : 0);
      fb.quad([[x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0]], [0, 1, 0], [[x0, z1], [x1, z1], [x1, z0], [x0, z0]], tint, style, room.id * 0.73 + plan.seed * 0.01, 3, 2);
    }
  }
  void inside;
  void rnd;
}

/**
 * Ceiling of a storey, a one-sided quad seen from below. The roof and the storeys above are cut away when the
 * viewer is inside, so without this the room would be open to the sky; from above it is culled and stays unseen.
 */
function ceiling(plan: BuildingPlan, L: number, base: number, fb: FacadeBuilder) {
  const top = L === plan.levels - 1;
  const y = base + plan.levelH - (top ? 0.02 : 0.31);
  const wells = plan.wells.filter((q) => q.level === L + 1);
  const tint = new THREE.Color(0xc8c4b8);
  for (const room of plan.rooms) {
    if (room.level !== L) continue;
    for (const p of subtractRects(room, wells)) {
      const { x0, x1, z0, z1 } = p;
      fb.quad([[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]], [0, -1, 0], [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], tint, 19, room.id * 0.37 + plan.seed * 0.01, 3, 2);
    }
  }
}

/** Floor slab of an upper storey: its underside is the ceiling below. */
function slab(plan: BuildingPlan, L: number, base: number, inside: MeshBuilder) {
  const pieces = subtractRects(rect(plan), plan.wells.filter((q) => q.level === L));
  // Banister round the stairwell: posts, a top rail and a mid rail.
  const wood = S.wood(0x6a4a30, 0.5);
  for (const w of plan.wells.filter((q) => q.level === L)) {
    for (const r of wellRails(w, 0.05)) {
      const alongX = r.x1 - r.x0 > r.z1 - r.z0;
      const cx = (r.x0 + r.x1) / 2;
      const cz = (r.z0 + r.z1) / 2;
      const len = alongX ? r.x1 - r.x0 : r.z1 - r.z0;
      const n = Math.max(1, Math.round(len / 0.7));
      for (let i = 0; i <= n; i++) {
        const t = -len / 2 + (i / n) * len;
        inside.box(alongX ? cx + t : cx, base + 0.5, alongX ? cz : cz + t, 0.07, 1.0, 0.07, wood);
      }
      if (alongX) {
        inside.box(cx, base + 1.0, cz, len, 0.06, 0.08, wood);
        inside.box(cx, base + 0.5, cz, len, 0.03, 0.04, wood);
      } else {
        inside.box(cx, base + 1.0, cz, 0.08, 0.06, len, wood);
        inside.box(cx, base + 0.5, cz, 0.04, 0.03, len, wood);
      }
    }
  }
  for (const p of pieces) inside.box((p.x0 + p.x1) / 2, base - 0.15, (p.z0 + p.z1) / 2, p.x1 - p.x0, 0.3, p.z1 - p.z0, S.concrete(0xb8ae98, 0.8));
}

function stairs(plan: BuildingPlan, s: Stair, base: number, inside: MeshBuilder) {
  const wood = S.wood(0x6a4a30, 0.7);
  const nose = S.wood(0x8a6a44, 0.6);
  const axisX = s.dir === '+x' || s.dir === '-x';
  const sign = s.dir === '+x' || s.dir === '+z' ? 1 : -1;
  for (let i = 1; i < s.steps; i++) {
    const c = (i - 1) * s.tread * sign;
    const h = i * s.rise;
    if (axisX) {
      inside.box(s.x + c, base + h / 2, s.z, s.tread, h, s.width, wood);
      inside.box(s.x + c - sign * 0.01, base + h - 0.015, s.z, s.tread + 0.03, 0.03, s.width + 0.02, nose);
    } else {
      inside.box(s.x, base + h / 2, s.z + c, s.width, h, s.tread, wood);
      inside.box(s.x, base + h - 0.015, s.z + c - sign * 0.01, s.width + 0.02, 0.03, s.tread + 0.03, nose);
    }
  }
  // Banister on the sides that face open floor.
  const x0 = plan.x0 + T_EXT + 0.15;
  const x1 = plan.x1 - T_EXT - 0.15;
  const z0 = plan.z0 + T_EXT + 0.15;
  const z1 = plan.z1 - T_EXT - 0.15;
  for (const side of [-1, 1]) {
    const off = side * (s.width / 2 + 0.03);
    const px = axisX ? s.x : s.x + off;
    const pz = axisX ? s.z + off : s.z;
    if (px < x0 || px > x1 || pz < z0 || pz > z1) continue;
    const top = (s.steps - 1) * s.rise;
    const run = (s.steps - 2) * s.tread * sign;
    const a: [number, number, number] = axisX ? [s.x, base + 0.95, s.z + off] : [s.x + off, base + 0.95, s.z];
    const b: [number, number, number] = axisX ? [s.x + run, base + top + 0.75, s.z + off] : [s.x + off, base + top + 0.75, s.z + run];
    inside.rod(a[0], a[1], a[2], b[0], b[1], b[2], 0.03, wood, 6);
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      const x = a[0] + (b[0] - a[0]) * t;
      const y = a[1] + (b[1] - a[1]) * t;
      const z = a[2] + (b[2] - a[2]) * t;
      inside.rod(x, y, z, x, base + t * top * 0.98 + 0.05, z, 0.012, wood, 4);
    }
  }
}

// ------------------------------------------------------------------------------------------ roof and exterior

function roofGeometry(rb: RuralBuilding, plan: BuildingPlan, roof: MeshBuilder, rnd: (k: number) => number) {
  const y = levelBase(plan, plan.levels);
  const w = plan.x1 - plan.x0;
  const d = plan.z1 - plan.z0;
  const cx = (plan.x0 + plan.x1) / 2;
  const cz = (plan.z0 + plan.z1) / 2;
  const state = plan.roof;
  const cols = [0x7a4a32, 0x5a5c5a, 0x6a4a3a, 0x8a6a4a, 0x4a4e50];
  const col = rb.look === 'warehouse' || rb.look === 'barn' ? (rb.look === 'barn' ? 0x6a3a2c : 0x6a6e70) : cols[Math.floor(rnd(2) * cols.length)];
  const mat = S.metal(col, 0.55);
  const wall = S.paint(rb.tint, 0.25);
  if (rb.roof === 'gable') {
    const ridgeX = rb.ridgeX;
    const span = ridgeX ? d : w;
    const run = ridgeX ? w : d;
    const rh = span * (rb.look === 'barn' ? 0.34 : rb.look === 'warehouse' ? 0.09 : 0.26);
    const ovh = 0.5;
    const half = span / 2 + ovh;
    const len = Math.hypot(half, rh * (half / (span / 2)));
    const ang = Math.atan2(rh, span / 2);
    const tmp = new MeshBuilder();
    tmp.jitter = 0.04;
    const segs = Math.max(1, Math.round((run + 1) / 1.6));
    const sl = (run + 1.0) / segs;
    for (const side of [-1, 1]) {
      for (let i = 0; i < segs; i++) {
        const missing = state === 'gone' ? true : state === 'partial' && rnd(20 + i + (side > 0 ? 50 : 0)) < 0.45;
        const z = -run / 2 - 0.5 + (i + 0.5) * sl;
        if (missing) {
          // Bare rafters where the sheets are gone.
          for (let k = 0; k < 2; k++) {
            const zz = z + (k - 0.5) * sl * 0.6;
            tmp.rod(side * (span / 2 + ovh * 0.7), -0.1, zz, 0, rh + 0.05, zz, 0.045, S.wood(0x4a3a2c, 0.8), 5);
          }
          continue;
        }
        tmp.box(side * (half / 2), rh * (1 - half / 2 / (span / 2)) + 0.05, z, len, 0.1, sl - 0.02, mat, 0, 0, -side * ang);
      }
    }
    if (state !== 'gone') {
      tmp.box(0, rh + 0.1, 0, 0.3, 0.1, run + 1.0, S.metal(0x3a3c3c, 0.8));
      // Gable ends in the wall colour.
      for (const z of [-run / 2 + 0.1, run / 2 - 0.1]) {
        const key = `rg:${span.toFixed(1)}:${rh.toFixed(1)}`;
        tmp.extrude(
          key,
          () => {
            const s = new THREE.Shape();
            s.moveTo(-span / 2, 0);
            s.lineTo(span / 2, 0);
            s.lineTo(0, rh);
            s.closePath();
            return s;
          },
          0.2,
          0,
          0,
          0,
          z,
          wall,
        );
      }
    } else {
      for (const z of [-run / 2 + 0.1, run / 2 - 0.1]) tmp.box(0, 0.4, z, span, 0.8, 0.2, wall);
    }
    roof.append(tmp, cx, y, cz, ridgeX ? Math.PI / 2 : 0, 1);
    if (rb.look === 'house' && plan.roof !== 'gone' && rnd(3) > 0.35) roof.box(cx + (ridgeX ? (rnd(4) - 0.5) * w * 0.5 : 0), y + rh + 0.7, cz + (ridgeX ? 0 : (rnd(5) - 0.5) * d * 0.5), 0.7, 1.9, 0.7, S.concrete(0x8a4c3a, 0.7));
  } else if (rb.roof === 'shed') {
    const rise = 1.1;
    const alongX = w >= d;
    if (state !== 'gone') {
      if (alongX) roof.box(cx, y + rise / 2 + 0.05, cz, w + 0.8, 0.12, d + 0.8, mat, 0, 0, Math.atan2(rise, w));
      else roof.box(cx, y + rise / 2 + 0.05, cz, w + 0.8, 0.12, d + 0.8, mat, -Math.atan2(rise, d), 0, 0);
    } else for (let i = 0; i < 4; i++) roof.rod(plan.x0, y, plan.z0 + (i + 0.5) * (d / 4), plan.x1, y + rise, plan.z0 + (i + 0.5) * (d / 4), 0.05, S.wood(0x4a3a2c, 0.8), 5);
    if (state === 'partial') roof.box(cx - w * 0.2, y + 0.2, cz, w * 0.4, 0.1, d * 0.5, mat, 0.3, 0.2, 0.2);
  } else if (rb.roof === 'flat') {
    const slabMat = S.concrete(0x6a6862, 0.8);
    const parapet = S.concrete(new THREE.Color(rb.tint).multiplyScalar(0.92).getHex(), 0.7);
    // Quarter slabs so a collapse can take one away.
    const gone = state === 'partial' ? Math.floor(rnd(6) * 4) : state === 'gone' ? 9 : -1;
    for (let q = 0; q < 4; q++) {
      if (q === gone || gone === 9) continue;
      const sx = q % 2 ? 1 : -1;
      const sz = q < 2 ? -1 : 1;
      roof.box(cx + sx * w / 4, y + 0.07, cz + sz * d / 4, w / 2 + 0.3, 0.14, d / 2 + 0.3, slabMat);
    }
    for (const [px, pz, sx, sz] of [[cx, plan.z1 - 0.1, w, 0.25], [cx, plan.z0 + 0.1, w, 0.25], [plan.x1 - 0.1, cz, 0.25, d - 0.5], [plan.x0 + 0.1, cz, 0.25, d - 0.5]] as const) {
      roof.box(px, y + 0.5, pz, sx, 0.7, sz, parapet);
    }
    if (state === 'intact') {
      const nAc = 1 + Math.floor(rnd(12) * 2);
      for (let i = 0; i < nAc; i++) roof.rbox(cx + (rnd(13 + i) - 0.5) * (w - 3), y + 0.75, cz + (rnd(20 + i) - 0.5) * (d - 3), 1.4, 1.0, 1.1, 0.05, S.metal(0x8a8e90, 0.75));
    }
  }
}

/** Things that hang off the outside of a building: porch, awning, steps. */
function exterior(rb: RuralBuilding, plan: BuildingPlan, out: MeshBuilder, rnd: (k: number) => number) {
  const front = plan.walls.find((w) => w.level === 0 && w.ext && w.axis === 'z' && w.out === plan.door);
  if (!front) return;
  const y = plan.floorY;
  const dx = front.c + plan.door * (front.t / 2);
  for (const op of front.ops) {
    if (op.kind !== 'door') continue;
    const zc = (op.a + op.b) / 2;
    const wood = S.wood(0x6a5038, 0.75);
    if (rb.look === 'house' || rb.look === 'shack') {
      const pd = 3.2;
      out.box(dx + plan.door * 1.0, y + 0.05, zc, 2.0, 0.14, pd, wood);
      for (const s of [-1, 1]) out.rod(dx + plan.door * 1.9, y, zc + s * (pd / 2 - 0.15), dx + plan.door * 1.9, y + 2.45, zc + s * (pd / 2 - 0.15), 0.06, S.wood(0x5a4630, 0.7), 5);
      out.box(dx + plan.door * 1.1, y + 2.5, zc, 2.4, 0.07, pd + 0.4, S.metal(0x6a4a3a, 0.85), 0, 0, plan.door * 0.1);
    } else if (rb.look === 'store' || rb.look === 'motel') {
      out.box(dx + plan.door * 0.9, y + 2.55, zc, 1.9, 0.06, Math.max(3, op.b - op.a + 2.4), S.cloth([0x8a2a24, 0x2a5a3a, 0x2a4a6a, 0xa87a2a][Math.floor(rnd(8) * 4)], 0.8), 0, 0, plan.door * 0.25);
      for (const s of [-1, 1]) out.rod(dx + plan.door * 1.8, y, zc + s * 1.6, dx + plan.door * 1.8, y + 2.4, zc + s * 1.6, 0.05, S.steel(0x3a3c3e, 0.7), 5);
    }
    break;
  }
}

// ------------------------------------------------------------------------------------------ the scene object

export class BuildingView {
  group = new THREE.Group();
  levels: THREE.Group[] = [];
  insides: THREE.Mesh[] = [];
  /** The glass of each storey. */
  paneSets: PaneSet[] = [];
  roof: THREE.Group | null = null;
  private geos: THREE.BufferGeometry[] = [];
  readonly plan: BuildingPlan;
  private cx: number;
  private cz: number;
  private radius: number;

  constructor(public rb: RuralBuilding) {
    this.plan = rb.plan;
    this.build();
    const p = this.plan;
    this.cx = (p.x0 + p.x1) / 2;
    this.cz = (p.z0 + p.z1) / 2;
    this.radius = Math.hypot(p.x1 - p.x0, p.z1 - p.z0) / 2;
  }

  /** Make the meshes from the plan as it is now. */
  private build() {
    const g = buildBuildingGeometry(this.rb);
    const kit = kitMaterial();
    const facade = facadeMaterial();
    const add = (parent: THREE.Group, geo: THREE.BufferGeometry | null, mat: THREE.Material, inside = false) => {
      if (!geo) return;
      this.geos.push(geo);
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      m.receiveShadow = true;
      parent.add(m);
      if (inside) this.insides.push(m);
    };
    g.levels.forEach((lv) => {
      const lg = new THREE.Group();
      add(lg, lv.shell, facade);
      add(lg, lv.trim, kit);
      add(lg, lv.inside, kit, true);
      const ps = new PaneSet();
      for (const sp of lv.panes) ps.add(sp);
      lg.add(ps.group);
      this.paneSets.push(ps);
      this.group.add(lg);
      this.levels.push(lg);
    });
    if (g.roof) {
      this.roof = new THREE.Group();
      add(this.roof, g.roof, kit);
      this.group.add(this.roof);
    }
  }

  /** The plan changed (a wall was breached): throw the meshes away and build them again. */
  rebuild() {
    // Panes that were hurt stay hurt: the plan only knows which have gone.
    const hurt: [string, number][] = [];
    for (const ps of this.paneSets) for (const k of ps.keys()) if (ps.stageOf(k) > 0 && ps.stageOf(k) < 3) hurt.push([k, ps.stageOf(k)]);
    for (const ps of this.paneSets) ps.dispose();
    this.paneSets = [];
    for (const g of this.geos) g.dispose();
    this.geos = [];
    for (const l of this.levels) l.removeFromParent();
    this.roof?.removeFromParent();
    this.levels = [];
    this.insides = [];
    this.roof = null;
    this.build();
    for (const [k, stage] of hurt) {
      const set = this.pane(k);
      const sp = set?.spec(k);
      if (set && sp) set.crack(k, stage as 1 | 2, [sp.c[0] + (Math.random() - 0.5) * sp.hw, sp.c[1] + (Math.random() - 0.5) * sp.hh, sp.c[2]]);
    }
  }

  /** The set of panes a window's pane is in, by its key. */
  pane(key: string): PaneSet | null {
    for (const ps of this.paneSets) if (ps.has(key)) return ps;
    return null;
  }

  /** True if a point stands within the walls. */
  contains(x: number, z: number, margin = 0.15) {
    const p = this.plan;
    return x > p.x0 - margin && x < p.x1 + margin && z > p.z0 - margin && z < p.z1 + margin;
  }

  /**
   * Cut the building away for a viewer: with the focus inside, the roof and every storey above theirs are hidden.
   * Furniture is skipped for cameras far away.
   */
  setView(focus: { x: number; y: number; z: number } | null, camX: number, camZ: number) {
    const p = this.plan;
    let inside = false;
    let level = 0;
    if (focus && this.contains(focus.x, focus.z) && focus.y > p.floorY - 2 && focus.y < p.floorY + p.levels * p.levelH + 1) {
      inside = true;
      level = Math.max(0, Math.min(p.levels - 1, Math.floor((focus.y - p.floorY + 0.4) / p.levelH)));
    }
    if (this.roof) this.roof.visible = !inside;
    this.levels.forEach((g, i) => (g.visible = !inside || i <= level));
    const near = Math.hypot(camX - this.cx, camZ - this.cz) < 110 + this.radius;
    for (const m of this.insides) m.visible = near;
  }

  dispose() {
    for (const ps of this.paneSets) ps.dispose();
    for (const g of this.geos) g.dispose();
    this.group.removeFromParent();
  }
}
