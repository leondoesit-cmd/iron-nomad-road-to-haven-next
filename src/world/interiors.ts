import { Rng, hash2 } from '../core/rng';
import type { DrugId } from '../sim/drugs';
import type { Stocks } from '../data';
import type { Aabb } from './layout';

/**
 * Floor plans for wasteland buildings. A plan is pure data: exterior and interior walls with their doorways and
 * windows, rooms with a role and a floor, stairs, furniture (some of it searchable) and damage. The renderer turns
 * it into geometry and `planAabbs` into colliders, so what you see is what you bump into.
 *
 * Layouts differ by building type and by seed: houses are split into a random handful of rooms (every room is
 * reachable from the front door), stores have a sales floor and back rooms, motels a row of rooms, barns and
 * warehouses one big hall with a few extras.
 */

export const T_EXT = 0.3;
export const T_INT = 0.16;
export const DOOR_W = 0.95;

export type Look = 'house' | 'store' | 'barn' | 'warehouse' | 'motel' | 'shack';
export type FloorMat = 'wood' | 'tile' | 'lino' | 'concrete' | 'carpet' | 'dirt';
export type RoomRole = 'living' | 'kitchen' | 'bedroom' | 'bath' | 'hall' | 'storage' | 'sales' | 'office' | 'lobby' | 'barn' | 'shed' | 'workshop' | 'room';
export type Side = 'w' | 'e' | 's' | 'n';

export interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export interface Opening {
  /** World coordinates along the wall. */
  a: number;
  b: number;
  kind: 'door' | 'window' | 'gate' | 'breach';
  /** Metres above the level's floor. */
  sill: number;
  head: number;
  leaf: 'none' | 'ajar' | 'open';
  glass: 'none' | 'intact' | 'broken' | 'boarded';
}

export interface Wall {
  level: number;
  /** 'x': runs along x at z = c. 'z': runs along z at x = c. */
  axis: 'x' | 'z';
  c: number;
  a: number;
  b: number;
  ext: boolean;
  /** Exterior walls: sign of the outward normal along the perpendicular axis. */
  out: 1 | -1 | 0;
  t: number;
  h: number;
  ops: Opening[];
}

export interface Room extends Rect {
  id: number;
  level: number;
  role: RoomRole;
  floor: FloorMat;
  tint: number;
}

export type FurnKind =
  | 'bed' | 'bunk' | 'nightstand' | 'wardrobe' | 'dresser'
  | 'sofa' | 'armchair' | 'coffeetable' | 'tvstand' | 'bookshelf' | 'rug'
  | 'counter' | 'sinkunit' | 'stove' | 'fridge' | 'table' | 'chair'
  | 'toilet' | 'vanity' | 'tub'
  | 'desk' | 'deskchair' | 'filing' | 'locker' | 'safe'
  | 'gondola' | 'checkout' | 'cooler' | 'rack' | 'pallet' | 'crate' | 'barrel' | 'haybale' | 'workbench' | 'stall' | 'woodstove' | 'footlocker' | 'shelf'
  | 'rubble' | 'tipped';

export interface Furn {
  kind: FurnKind;
  level: number;
  x: number;
  z: number;
  yaw: number;
  /** Footprint in the item's own frame: w along its width (local x), d along its depth (local z, the front). */
  w: number;
  d: number;
  h: number;
  seed: number;
  solid: boolean;
  /** Searchable: what is inside and what the player is told. */
  loot?: Partial<Stocks>;
  /** Drugs among the loot. */
  drugs?: Partial<Record<DrugId, number>>;
  label?: string;
  depth?: 0 | 1 | 2;
}

export interface Stair {
  /** The level the bottom step is on. */
  level: number;
  /** Centre of the first riser, on the floor. */
  x: number;
  z: number;
  dir: '+x' | '-x' | '+z' | '-z';
  width: number;
  steps: number;
  rise: number;
  tread: number;
}

export interface Debris {
  x: number;
  z: number;
  r: number;
  level: number;
}

export interface BuildingPlan {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  look: Look;
  door: 1 | -1;
  levels: number;
  levelH: number;
  /** Top of the ground floor. */
  floorY: number;
  seed: number;
  walls: Wall[];
  rooms: Room[];
  furn: Furn[];
  stairs: Stair[];
  debris: Debris[];
  /** Where the upper floor has no slab (the stairwell), per upper level, and the end the stair arrives at (left open). */
  wells: (Rect & { level: number; dir: Stair['dir'] })[];
  roof: 'intact' | 'partial' | 'gone';
  /** Ground-floor room centres where the dead may be waiting. */
  lairs: { x: number; z: number }[];
}

export interface PlanInput {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  look: Look;
  door: 1 | -1;
  seed: number;
  floors: number;
  floorY: number;
  /** 0..1: how battered it is. */
  wear: number;
  roof: 'gable' | 'shed' | 'flat' | 'none';
}

const PALETTE: Record<string, number[]> = {
  living: [0xcdbfa0, 0xbfae8c, 0xa8b09a, 0xc8b49a],
  kitchen: [0xd8d0b0, 0xaebea8, 0xd0c4a0],
  bedroom: [0xbaa8b0, 0xa8b0c4, 0xc8b898, 0xb4b8a0],
  bath: [0xa8c0c0, 0xb8c8c0, 0xc4c8b8],
  plain: [0xc8c4b8, 0xbcb8aa, 0xd0cabc],
  hall: [0xc0b8a4, 0xb4aa94],
  industrial: [0xb4b4ae, 0xa6a8a4],
  wood: [0xa88660, 0x9a7a56],
};

const rectOverlap = (a: Rect, b: Rect, m = 0) => a.x0 < b.x1 + m && a.x1 > b.x0 - m && a.z0 < b.z1 + m && a.z1 > b.z0 - m;

export function furnRect(f: Furn): Rect {
  const swap = Math.abs(Math.sin(f.yaw)) > 0.7;
  const hw = (swap ? f.d : f.w) / 2;
  const hd = (swap ? f.w : f.d) / 2;
  return { x0: f.x - hw, x1: f.x + hw, z0: f.z - hd, z1: f.z + hd };
}

/** Yaw that turns an item's front (+z) toward the room, for an item standing against `side`. */
const SIDE_YAW: Record<Side, number> = { w: Math.PI / 2, e: -Math.PI / 2, s: 0, n: Math.PI };

interface AgainstOpts {
  solid?: boolean;
  loot?: Partial<Stocks>;
  label?: string;
  depth?: 0 | 1 | 2;
  gap?: number;
  margin?: number;
}

class Builder {
  rng: Rng;
  walls: Wall[] = [];
  rooms: Room[] = [];
  furn: Furn[] = [];
  stairs: Stair[] = [];
  debris: Debris[] = [];
  wells: (Rect & { level: number; dir: Stair['dir'] })[] = [];
  keep: Rect[][] = [];
  roomId = 0;
  levelH: number;
  root: Rect;
  lairs: { x: number; z: number }[] = [];
  roofState: BuildingPlan['roof'] = 'intact';

  constructor(public inp: PlanInput) {
    this.rng = new Rng(inp.seed * 2654435761);
    this.levelH = inp.look === 'barn' ? 6.4 : inp.look === 'warehouse' ? 5.6 : inp.look === 'store' ? 3.2 : inp.look === 'shack' ? 2.5 : inp.look === 'motel' ? 2.7 : 2.8;
    this.root = { x0: inp.x0 + T_EXT, x1: inp.x1 - T_EXT, z0: inp.z0 + T_EXT, z1: inp.z1 - T_EXT };
    for (let l = 0; l < inp.floors; l++) this.keep.push([]);
  }

  // ---------------------------------------------------------------- walls

  addExterior(level: number) {
    const { x0, x1, z0, z1 } = this.inp;
    const h = this.levelH;
    const T = T_EXT;
    this.walls.push({ level, axis: 'x', c: z0 + T / 2, a: x0, b: x1, ext: true, out: -1, t: T, h, ops: [] });
    this.walls.push({ level, axis: 'x', c: z1 - T / 2, a: x0, b: x1, ext: true, out: 1, t: T, h, ops: [] });
    this.walls.push({ level, axis: 'z', c: x0 + T / 2, a: z0 + T, b: z1 - T, ext: true, out: -1, t: T, h, ops: [] });
    this.walls.push({ level, axis: 'z', c: x1 - T / 2, a: z0 + T, b: z1 - T, ext: true, out: 1, t: T, h, ops: [] });
  }

  extWall(level: number, side: Side) {
    const axis = side === 'w' || side === 'e' ? 'z' : 'x';
    const out = side === 'e' || side === 'n' ? 1 : -1;
    return this.walls.find((w) => w.level === level && w.ext && w.axis === axis && w.out === out)!;
  }

  addWall(level: number, axis: 'x' | 'z', c: number, a: number, b: number, t = T_INT): Wall {
    const w: Wall = { level, axis, c, a, b, ext: false, out: 0, t, h: this.levelH, ops: [] };
    this.walls.push(w);
    return w;
  }

  /** Cut an opening into a wall. Returns it, or null if it would hit an existing opening or the wall's ends. */
  open(w: Wall, centre: number, width: number, kind: Opening['kind'], extra: Partial<Opening> = {}): Opening | null {
    const a = centre - width / 2;
    const b = centre + width / 2;
    if (a < w.a + 0.12 || b > w.b - 0.12) return null;
    if (w.ops.some((o) => a < o.b + 0.15 && b > o.a - 0.15)) return null;
    const op: Opening =
      kind === 'door'
        ? { a, b, kind, sill: 0, head: Math.min(2.1, w.h - 0.3), leaf: 'ajar', glass: 'none' }
        : kind === 'gate'
          ? { a, b, kind, sill: 0, head: Math.min(w.h - 0.4, this.inp.look === 'warehouse' ? 4.2 : 3.8), leaf: 'open', glass: 'none' }
          : kind === 'breach'
            ? { a, b, kind, sill: 0, head: w.h, leaf: 'none', glass: 'none' }
            : { a, b, kind, sill: 0.95, head: Math.min(2.05, w.h - 0.4), leaf: 'none', glass: 'broken' };
    Object.assign(op, extra);
    w.ops.push(op);
    w.ops.sort((p, q) => p.a - q.a);
    return op;
  }

  // ---------------------------------------------------------------- rooms

  /** The floor space of a rect once the walls around it are accounted for. */
  usable(r: Rect): Rect {
    const e = 0.001;
    const s = T_INT / 2;
    return {
      x0: r.x0 + (r.x0 - this.root.x0 < e ? 0 : s),
      x1: r.x1 - (this.root.x1 - r.x1 < e ? 0 : s),
      z0: r.z0 + (r.z0 - this.root.z0 < e ? 0 : s),
      z1: r.z1 - (this.root.z1 - r.z1 < e ? 0 : s),
    };
  }

  addRoom(level: number, r: Rect, role: RoomRole, floor: FloorMat, palette: string): Room {
    const pal = PALETTE[palette];
    const room: Room = { ...this.usable(r), id: this.roomId++, level, role, floor, tint: pal[Math.floor(this.rng.next() * pal.length)] };
    this.rooms.push(room);
    return room;
  }

  /** Recursive subdivision of `root` into `target` rooms. Walls get doors that avoid every junction. */
  subdivide(level: number, root: Rect, target: number, minDim: number, avoid: Rect[] = []): Rect[] {
    const leaves: Rect[] = [root];
    const added: Wall[] = [];
    let guard = 0;
    while (leaves.length < target && guard++ < 40) {
      // Split the largest splittable leaf.
      const order = leaves.map((r, i) => ({ r, i, a: (r.x1 - r.x0) * (r.z1 - r.z0) })).sort((p, q) => q.a - p.a);
      let done = false;
      for (const { r, i } of order) {
        const wx = r.x1 - r.x0;
        const wz = r.z1 - r.z0;
        const canX = wx >= minDim * 2;
        const canZ = wz >= minDim * 2;
        if (!canX && !canZ) continue;
        const alongX = canX && (!canZ || wx / wz > 0.85 + this.rng.next() * 0.5);
        for (let t = 0; t < 14; t++) {
          const lo = (alongX ? r.x0 : r.z0) + minDim;
          const hi = (alongX ? r.x1 : r.z1) - minDim;
          const c = Math.round((lo + this.rng.next() * (hi - lo)) * 4) / 4;
          const wall = alongX ? { x0: c - 0.5, x1: c + 0.5, z0: r.z0, z1: r.z1 } : { x0: r.x0, x1: r.x1, z0: c - 0.5, z1: c + 0.5 };
          if (avoid.some((q) => rectOverlap(wall, q))) continue;
          const w = alongX ? this.addWall(level, 'z', c, r.z0, r.z1) : this.addWall(level, 'x', c, r.x0, r.x1);
          added.push(w);
          const [p, q] = alongX ? [{ ...r, x1: c }, { ...r, x0: c }] : [{ ...r, z1: c }, { ...r, z0: c }];
          leaves.splice(i, 1, p, q);
          done = true;
          break;
        }
        if (done) break;
      }
      if (!done) break;
    }
    this.doorsFor(added, avoid);
    return leaves;
  }

  /** One doorway per interior wall, kept clear of walls that meet it. */
  doorsFor(walls: Wall[], avoid: Rect[]) {
    for (const w of walls) {
      const junctions: number[] = [];
      for (const v of this.walls) {
        if (v === w || v.level !== w.level || v.axis === w.axis || v.ext) continue;
        const touches = Math.abs(v.a - w.c) < 0.02 || Math.abs(v.b - w.c) < 0.02;
        if (touches && v.c > w.a - 0.02 && v.c < w.b + 0.02) junctions.push(v.c);
      }
      const lo = w.a + 0.75;
      const hi = w.b - 0.75;
      if (hi <= lo) {
        const mid = (w.a + w.b) / 2;
        if (w.b - w.a >= 1.3) this.open(w, mid, DOOR_W, 'door');
        continue;
      }
      const cands: { c: number; score: number }[] = [];
      for (let i = 0; i < 28; i++) {
        const c = lo + ((hi - lo) * (i + this.rng.next() * 0.9)) / 28;
        const dj = junctions.reduce((m, j) => Math.min(m, Math.abs(j - c)), 9);
        const blocked = avoid.some((q) => (w.axis === 'x' ? c > q.x0 - 0.5 && c < q.x1 + 0.5 && w.c > q.z0 - 0.3 && w.c < q.z1 + 0.3 : c > q.z0 - 0.5 && c < q.z1 + 0.5 && w.c > q.x0 - 0.3 && w.c < q.x1 + 0.3));
        cands.push({ c, score: Math.min(dj, 1.4) + this.rng.next() * 0.6 - (blocked ? 5 : 0) });
      }
      cands.sort((p, q) => q.score - p.score);
      // Best first; a wall is never left without a way through.
      for (const { c } of cands) if (this.open(w, c, DOOR_W, 'door')) break;
    }
  }

  // ---------------------------------------------------------------- doors and windows on the shell

  /** The front door: on the entrance wall, inside the span of `room`. */
  frontDoor(level: number, room: Rect, kind: 'door' | 'gate' = 'door', width = DOOR_W) {
    const side: Side = this.inp.door > 0 ? 'e' : 'w';
    const w = this.extWall(level, side);
    const lo = Math.max(room.z0, w.a) + width / 2 + 0.3;
    const hi = Math.min(room.z1, w.b) - width / 2 - 0.3;
    const c = hi > lo ? lo + this.rng.next() * (hi - lo) : (room.z0 + room.z1) / 2;
    const op = this.open(w, c, width, kind);
    if (op) this.noteDoor(w, op);
    return op;
  }

  /** Keep the floor in front of a doorway clear of furniture. */
  noteDoor(w: Wall, op: Opening) {
    const reach = op.kind === 'gate' ? 2.4 : 1.0;
    const k = w.axis === 'x' ? { x0: op.a - 0.1, x1: op.b + 0.1, z0: w.c - reach, z1: w.c + reach } : { x0: w.c - reach, x1: w.c + reach, z0: op.a - 0.1, z1: op.b + 0.1 };
    this.keep[w.level].push(k);
  }

  /** Doors cut by `doorsFor` also need their keep-out rects. */
  noteAllDoors() {
    for (const k of this.keep) k.length = 0;
    for (const w of this.walls) for (const op of w.ops) if (op.kind === 'door' || op.kind === 'gate') this.noteDoor(w, op);
    for (const s of this.stairs) {
      // The stair is a hazard to furniture on both storeys: the bottom on one, the landing on the other.
      this.keep[s.level].push(this.stairKeep(s));
      if (this.keep[s.level + 1]) this.keep[s.level + 1].push(this.stairKeep(s));
    }
  }

  stairRect(s: Stair): Rect {
    const run = (s.steps - 1) * s.tread;
    const hw = s.width / 2;
    switch (s.dir) {
      case '+x':
        return { x0: s.x, x1: s.x + run, z0: s.z - hw, z1: s.z + hw };
      case '-x':
        return { x0: s.x - run, x1: s.x, z0: s.z - hw, z1: s.z + hw };
      case '+z':
        return { x0: s.x - hw, x1: s.x + hw, z0: s.z, z1: s.z + run };
      default:
        return { x0: s.x - hw, x1: s.x + hw, z0: s.z - run, z1: s.z };
    }
  }

  /** The stair plus the landing at the top and the approach at the bottom. */
  stairKeep(s: Stair): Rect {
    const r = this.stairRect(s);
    const e = 1.0;
    switch (s.dir) {
      case '+x':
        return { x0: r.x0 - 0.8, x1: r.x1 + e, z0: r.z0 - 0.1, z1: r.z1 + 0.1 };
      case '-x':
        return { x0: r.x0 - e, x1: r.x1 + 0.8, z0: r.z0 - 0.1, z1: r.z1 + 0.1 };
      case '+z':
        return { x0: r.x0 - 0.1, x1: r.x1 + 0.1, z0: r.z0 - 0.8, z1: r.z1 + e };
      default:
        return { x0: r.x0 - 0.1, x1: r.x1 + 0.1, z0: r.z0 - e, z1: r.z1 + 0.8 };
    }
  }

  /** One or two windows per room on the exterior walls. */
  windows(level: number, rooms: Room[], opts: { width?: number; sill?: number; chance?: number } = {}) {
    const sides: Side[] = ['w', 'e', 's', 'n'];
    for (const room of rooms) {
      for (const side of sides) {
        const w = this.extWall(level, side);
        const touches = side === 'w' ? room.x0 - this.root.x0 < 0.05 : side === 'e' ? this.root.x1 - room.x1 < 0.05 : side === 's' ? room.z0 - this.root.z0 < 0.05 : this.root.z1 - room.z1 < 0.05;
        if (!touches) continue;
        const lo = side === 'w' || side === 'e' ? room.z0 : room.x0;
        const hi = side === 'w' || side === 'e' ? room.z1 : room.x1;
        const span = hi - lo;
        const bath = room.role === 'bath';
        const ww = bath ? 0.55 : opts.width ?? (room.role === 'living' || room.role === 'sales' ? 1.6 : 1.15);
        if (span < ww + 1.1) continue;
        if (this.rng.next() > (opts.chance ?? 0.92)) continue;
        const n = span > 4.6 && !bath ? 2 : 1;
        for (let i = 0; i < n; i++) {
          const c = n === 1 ? lo + span * (0.4 + this.rng.next() * 0.2) : lo + span * (i === 0 ? 0.27 : 0.73);
          const glass = this.rng.next();
          this.open(w, c, ww, 'window', {
            sill: bath ? 1.5 : opts.sill ?? 0.95,
            head: bath ? 2.0 : Math.min(w.h - 0.45, (opts.sill ?? 0.95) + 1.15),
            glass: glass < 0.3 ? 'intact' : glass < 0.78 ? 'broken' : 'boarded',
          });
        }
      }
    }
  }

  // ---------------------------------------------------------------- furniture

  /** Try to stand an item against a wall of `room`. `along` is 0..1 across the wall. */
  against(level: number, room: Room, side: Side, kind: FurnKind, w: number, d: number, h: number, along: number, opts: AgainstOpts = {}): Furn | null {
    const gap = opts.gap ?? 0.03;
    const m = opts.margin ?? 0.1;
    const horiz = side === 'w' || side === 'e';
    const span = (horiz ? room.z1 - room.z0 : room.x1 - room.x0) - m * 2;
    if (span < w) return null;
    const lo = (horiz ? room.z0 : room.x0) + m + w / 2;
    const c = lo + (span - w) * along;
    let x: number;
    let z: number;
    if (side === 'w') {
      x = room.x0 + gap + d / 2;
      z = c;
    } else if (side === 'e') {
      x = room.x1 - gap - d / 2;
      z = c;
    } else if (side === 's') {
      z = room.z0 + gap + d / 2;
      x = c;
    } else {
      z = room.z1 - gap - d / 2;
      x = c;
    }
    return this.put(level, room, { kind, level, x, z, yaw: SIDE_YAW[side], w, d, h, seed: this.rng.int(0, 999), solid: opts.solid ?? true, loot: opts.loot, label: opts.label, depth: opts.depth });
  }

  /** Place an item anywhere in the room (centre, yaw free) if it fits. */
  free(level: number, room: Room, kind: FurnKind, w: number, d: number, h: number, cx: number, cz: number, yaw: number, opts: { solid?: boolean; loot?: Partial<Stocks>; label?: string; depth?: 0 | 1 | 2 } = {}): Furn | null {
    return this.put(level, room, { kind, level, x: cx, z: cz, yaw, w, d, h, seed: this.rng.int(0, 999), solid: opts.solid ?? true, loot: opts.loot, label: opts.label, depth: opts.depth });
  }

  private put(level: number, room: Room, f: Furn): Furn | null {
    const r = furnRect(f);
    if (r.x0 < room.x0 - 0.01 || r.x1 > room.x1 + 0.01 || r.z0 < room.z0 - 0.01 || r.z1 > room.z1 + 0.01) return null;
    if (this.keep[level].some((k) => rectOverlap(r, k))) return null;
    const flat = f.kind === 'rug';
    for (const o of this.furn) {
      if (o.level !== level) continue;
      if ((o.kind === 'rug') !== flat && (o.kind === 'rug' || flat)) continue;
      if (o.kind === 'rug' && flat) continue;
      if (rectOverlap(r, furnRect(o), 0.06)) return null;
    }
    this.furn.push(f);
    // A solid item may not cut a doorway or the stairs off from the rest of the room.
    if (f.solid && f.h >= 0.45 && !this.connected(level, room)) {
      this.furn.pop();
      return null;
    }
    return f;
  }

  /** Points just inside the room at each doorway, and where stairs arrive. They must all be reachable from each other. */
  private roomPoints(level: number, room: Room): [number, number][] {
    const pts: [number, number][] = [];
    for (const w of this.walls) {
      if (w.level !== level) continue;
      for (const op of w.ops) {
        if (op.kind === 'window') continue;
        const mid = (op.a + op.b) / 2;
        const near = w.t / 2 + 0.2;
        if (w.axis === 'x') {
          if (mid < room.x0 - 0.01 || mid > room.x1 + 0.01) continue;
          if (Math.abs(w.c - room.z0) < near) pts.push([mid, room.z0 + 0.5]);
          else if (Math.abs(w.c - room.z1) < near) pts.push([mid, room.z1 - 0.5]);
        } else {
          if (mid < room.z0 - 0.01 || mid > room.z1 + 0.01) continue;
          if (Math.abs(w.c - room.x0) < near) pts.push([room.x0 + 0.5, mid]);
          else if (Math.abs(w.c - room.x1) < near) pts.push([room.x1 - 0.5, mid]);
        }
      }
    }
    for (const s of this.stairs) {
      const dx = s.dir === '+x' ? 1 : s.dir === '-x' ? -1 : 0;
      const dz = s.dir === '+z' ? 1 : s.dir === '-z' ? -1 : 0;
      const run = (s.steps - 1) * s.tread;
      const p: [number, number] | null = level === s.level ? [s.x - dx * 0.55, s.z - dz * 0.55] : level === s.level + 1 ? [s.x + dx * (run + 0.65), s.z + dz * (run + 0.65)] : null;
      if (p && p[0] > room.x0 && p[0] < room.x1 && p[1] > room.z0 && p[1] < room.z1) pts.push(p);
    }
    return pts;
  }

  private connected(level: number, room: Room): boolean {
    const pts = this.roomPoints(level, room);
    if (pts.length < 1) return true;
    const R = 0.34;
    const C = 0.14;
    const nx = Math.ceil((room.x1 - room.x0) / C);
    const nz = Math.ceil((room.z1 - room.z0) / C);
    const blocked = new Uint8Array(nx * nz);
    // A body's centre stays clear of the walls around the room.
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const x = room.x0 + (i + 0.5) * C;
        const z = room.z0 + (j + 0.5) * C;
        if (x - room.x0 < R || room.x1 - x < R || z - room.z0 < R || room.z1 - z < R) blocked[j * nx + i] = 1;
      }
    }
    // The stairwell is a hole with a banister, not floor.
    for (const wl of this.wells) {
      if (wl.level !== level) continue;
      for (let j = 0; j < nz; j++) {
        for (let i = 0; i < nx; i++) {
          const x = room.x0 + (i + 0.5) * C;
          const z = room.z0 + (j + 0.5) * C;
          if (x > wl.x0 - 0.05 && x < wl.x1 + 0.05 && z > wl.z0 - 0.05 && z < wl.z1 + 0.05) blocked[j * nx + i] = 1;
        }
      }
    }
    for (const o of this.furn) {
      if (o.level !== level || !o.solid || o.h < 0.45) continue;
      const r = furnRect(o);
      if (r.x1 + R < room.x0 || r.x0 - R > room.x1 || r.z1 + R < room.z0 || r.z0 - R > room.z1) continue;
      const i0 = Math.max(0, Math.floor((r.x0 - R - room.x0) / C));
      const i1 = Math.min(nx - 1, Math.floor((r.x1 + R - room.x0) / C));
      const j0 = Math.max(0, Math.floor((r.z0 - R - room.z0) / C));
      const j1 = Math.min(nz - 1, Math.floor((r.z1 + R - room.z0) / C));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) blocked[j * nx + i] = 1;
    }
    const cell = (p: [number, number]) => {
      const i = Math.min(nx - 1, Math.max(0, Math.floor((p[0] - room.x0) / C)));
      const j = Math.min(nz - 1, Math.max(0, Math.floor((p[1] - room.z0) / C)));
      return j * nx + i;
    };
    const start = cell(pts[0]);
    if (blocked[start]) return false;
    const seen = new Uint8Array(nx * nz);
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      const i = c % nx;
      const j = (c - i) / nx;
      for (const n of [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, j > 0 ? c - nx : -1, j < nz - 1 ? c + nx : -1]) {
        if (n < 0 || seen[n] || blocked[n]) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    if (!pts.every((p) => seen[cell(p)] === 1)) return false;
    // And most of the floor must stay open to the doorway: no sealing a pocket off behind a bed.
    let free = 0;
    let open = 0;
    for (let c = 0; c < nx * nz; c++) {
      if (blocked[c]) continue;
      free++;
      if (seen[c]) open++;
    }
    return open >= free * 0.8;
  }

  /** The sides of a room that have a free stretch of wall, longest first, shuffled among near-equals. */
  wallsOf(room: Room): Side[] {
    const sides: Side[] = ['w', 'e', 's', 'n'];
    return sides.sort((p, q) => this.len(room, q) - this.len(room, p) + (this.rng.next() - 0.5) * 0.8);
  }

  len(room: Room, s: Side) {
    return s === 'w' || s === 'e' ? room.z1 - room.z0 : room.x1 - room.x0;
  }

  try(level: number, room: Room, kinds: FurnKind[], w: number, d: number, h: number, opts: AgainstOpts = {}, sidesPref?: Side[]) {
    const sides = sidesPref ?? this.wallsOf(room);
    for (const s of sides) {
      for (let k = 0; k < 4; k++) {
        const f = this.against(level, room, s, kinds[Math.floor(this.rng.next() * kinds.length)], w, d, h, this.rng.next(), opts);
        if (f) return f;
      }
    }
    return null;
  }
}

// ------------------------------------------------------------------------------------------ loot tables

const pick = <T>(rng: Rng, arr: T[]) => arr[Math.floor(rng.next() * arr.length) % arr.length];

function lootFor(rng: Rng, kind: FurnKind, wealth: number): Partial<Stocks> | undefined {
  const r = rng.next();
  // Rations and medicine are scarce; the building's scrap and parts are a supplement to what lies on the road.
  const n = (lo: number, hi: number) => Math.max(1, Math.round((lo + (hi - lo) * rng.next() * wealth) * 0.5));
  switch (kind) {
    case 'fridge':
      return r < 0.4 ? { rations: 1 } : { scrap: n(2, 4) };
    case 'wardrobe':
    case 'dresser':
      return { scrap: n(4, 9), ...(r < 0.08 ? { medicine: 1 } : {}) };
    case 'vanity':
      return r < 0.55 ? { medicine: 1 } : { scrap: 2 };
    case 'filing':
    case 'desk':
      return { scrap: n(3, 7), ...(r < 0.12 ? { tech: 1 } : {}) };
    case 'locker':
      return { parts: n(3, 7) + 1, ...(r < 0.4 ? { scrap: n(3, 6) } : {}) };
    case 'workbench':
      return { parts: n(5, 10) + 1, scrap: n(3, 6), ...(r < 0.2 ? { tech: 1 } : {}) };
    case 'checkout':
      return { scrap: n(6, 12), ...(r < 0.12 ? { tech: 1 } : {}) };
    case 'cooler':
      return r < 0.45 ? { rations: 1 } : { scrap: 2 };
    case 'gondola':
    case 'shelf':
    case 'rack':
      return r < 0.55 ? { scrap: n(4, 9) } : r < 0.67 ? { rations: 1 } : { parts: n(3, 6) };
    case 'footlocker':
      return { scrap: n(4, 8), parts: n(2, 5) };
    case 'safe':
      return { tech: 1 + (rng.chance(0.3) ? 1 : 0), scrap: n(8, 14), ...(r < 0.3 ? { medicine: 1 } : {}) };
    case 'crate':
      return { parts: n(2, 6), scrap: n(2, 5) };
    default:
      return undefined;
  }
}

const LABEL: Partial<Record<FurnKind, string>> = {
  fridge: 'the fridge',
  wardrobe: 'the wardrobe',
  dresser: 'the dresser',
  vanity: 'the medicine cabinet',
  filing: 'the filing cabinet',
  desk: 'the desk drawers',
  locker: 'the locker',
  workbench: 'the workbench',
  checkout: 'the till',
  cooler: 'the cooler',
  gondola: 'the shelves',
  shelf: 'the shelves',
  rack: 'the racking',
  footlocker: 'the footlocker',
  safe: 'the safe',
  crate: 'the crate',
};

/** What might be tucked away in a piece of furniture. A roll off the furniture's own position, so the build stays as it was. */
function drugsFor(f: Furn): Partial<Record<DrugId, number>> | undefined {
  const r = hash2(Math.round(f.x * 10), Math.round(f.z * 10), f.level * 131 + f.seed);
  switch (f.kind) {
    case 'vanity':
      return r < 0.35 ? { painkiller: 1 } : r < 0.4 ? { stim: 1 } : undefined;
    case 'cooler':
      return r < 0.3 ? { alcohol: 1 } : undefined;
    case 'fridge':
      return r < 0.12 ? { alcohol: 1 } : undefined;
    case 'dresser':
      return r < 0.08 ? { weed: 1 } : undefined;
    case 'wardrobe':
      return r < 0.06 ? { weed: 1 } : undefined;
    case 'checkout':
      return r < 0.1 ? { alcohol: 1 } : undefined;
    case 'safe':
      return r < 0.3 ? { alcohol: 1 } : r < 0.45 ? { adrenaline: 1 } : r < 0.53 ? { lsd: 1 } : undefined;
    default:
      return undefined;
  }
}

function searchable(b: Builder, f: Furn | null, wealth: number, depth: 0 | 1 | 2 = 0, chance = 1) {
  if (!f || !b.rng.chance(chance)) return f;
  f.loot = lootFor(b.rng, f.kind, wealth);
  f.drugs = drugsFor(f);
  f.label = LABEL[f.kind];
  f.depth = f.kind === 'safe' ? 2 : f.kind === 'locker' || f.kind === 'workbench' || f.kind === 'footlocker' ? 1 : depth;
  return f;
}

// ------------------------------------------------------------------------------------------ furnishing by role

function furnishRoom(b: Builder, room: Room, wealth: number) {
  const L = room.level;
  const rng = b.rng;
  const cx = (room.x0 + room.x1) / 2;
  const cz = (room.z0 + room.z1) / 2;
  const area = (room.x1 - room.x0) * (room.z1 - room.z0);
  const wide = room.x1 - room.x0;
  const deep = room.z1 - room.z0;
  switch (room.role) {
    case 'living': {
      const sofa = b.try(L, room, ['sofa'], pick(rng, [1.9, 2.1, 1.6]), 0.9, 0.85);
      if (sofa) {
        const f = furnRect(sofa);
        // A coffee table in front of the sofa, a television opposite.
        const fx = Math.sin(sofa.yaw);
        const fz = Math.cos(sofa.yaw);
        b.free(L, room, 'coffeetable', 1.0, 0.55, 0.42, sofa.x + fx * 1.35, sofa.z + fz * 1.35, sofa.yaw, { solid: false });
        const opp = Math.abs(fx) > 0.5 ? (fx > 0 ? 'e' : 'w') : fz > 0 ? 'n' : 's';
        const tv = b.against(L, room, opp as Side, 'tvstand', 1.3, 0.45, 0.55, 0.3 + rng.next() * 0.4, { solid: true });
        void tv;
        void f;
      } else b.try(L, room, ['armchair'], 0.85, 0.85, 0.85);
      if (rng.chance(0.6)) b.try(L, room, ['armchair'], 0.85, 0.85, 0.85);
      if (rng.chance(0.7)) searchable(b, b.try(L, room, ['bookshelf'], 1.1, 0.35, 1.8, { solid: true }), wealth, 0, 0.7);
      if (area > 12 && rng.chance(0.75)) b.free(L, room, 'rug', 2.2, 1.5, 0.02, cx, cz, rng.chance(0.5) ? 0 : Math.PI / 2, { solid: false });
      if (area > 16 && rng.chance(0.6)) b.free(L, room, 'table', 1.2, 0.8, 0.75, cx + 1.1, cz - 0.9, 0, { solid: true });
      break;
    }
    case 'kitchen': {
      const side = (b.wallsOf(room) as Side[])[0];
      const len = b.len(room, side);
      let used = 0;
      // A run of cabinets along the longest wall: sink, stove, then cabinets, then the fridge.
      const units: FurnKind[] = ['sinkunit', 'stove', 'counter', 'counter'];
      if (len > 3.4) units.push('counter');
      if (len > 4.2) units.push('counter');
      rng.shuffle(units);
      const fridge = b.against(L, room, side, 'fridge', 0.75, 0.72, 1.85, rng.chance(0.5) ? 0 : 1, { solid: true });
      searchable(b, fridge, wealth, 0);
      for (const u of units) {
        const wd = u === 'sinkunit' ? 1.2 : 0.6;
        const along = Math.min(1, (used + wd / 2 + 0.1) / Math.max(0.01, len - 0.2 - wd));
        const f = b.against(L, room, side, u, wd, 0.62, 0.92, fridge && fridge.x < cx ? 1 - along : along, { solid: true });
        if (f) {
          used += wd;
          if (f.kind === 'counter') searchable(b, f, wealth * 0.6, 0, 0.3);
        }
      }
      if (area > 9) {
        const t = b.free(L, room, 'table', 1.2, 0.8, 0.75, cx, cz + (rng.next() - 0.5) * 0.4, rng.chance(0.5) ? 0 : Math.PI / 2, { solid: true });
        if (t) for (const [dx, dz] of [[0, 0.75], [0, -0.75], [0.85, 0], [-0.85, 0]]) if (rng.chance(0.65)) b.free(L, room, 'chair', 0.42, 0.42, 0.85, t.x + dx * (Math.abs(Math.sin(t.yaw)) > 0.7 ? 0 : 1) + dz * (Math.abs(Math.sin(t.yaw)) > 0.7 ? 1 : 0), t.z + dz * (Math.abs(Math.sin(t.yaw)) > 0.7 ? 0 : 1) + dx * (Math.abs(Math.sin(t.yaw)) > 0.7 ? 1 : 0), rng.range(0, 6.28), { solid: false });
      }
      break;
    }
    case 'bedroom': {
      const single = area < 9 || rng.chance(0.3);
      const bed = b.try(L, room, ['bed'], single ? 0.95 : 1.45, 2.0, 0.55, { solid: true, gap: 0.03 });
      if (bed) {
        // A nightstand at the head.
        const fx = Math.sin(bed.yaw);
        const fz = Math.cos(bed.yaw);
        const sx = Math.cos(bed.yaw);
        const sz = -Math.sin(bed.yaw);
        b.free(L, room, 'nightstand', 0.45, 0.4, 0.5, bed.x - fx * 0.8 + sx * ((single ? 0.95 : 1.45) / 2 + 0.3), bed.z - fz * 0.8 + sz * ((single ? 0.95 : 1.45) / 2 + 0.3), bed.yaw, { solid: true });
      }
      searchable(b, b.try(L, room, ['wardrobe'], 1.1, 0.58, 2.0), wealth, 0, 0.9);
      if (area > 8) searchable(b, b.try(L, room, ['dresser'], 1.0, 0.48, 0.9), wealth, 0, 0.8);
      if (area > 12 && rng.chance(0.7)) b.free(L, room, 'rug', 2.0, 1.4, 0.02, cx, cz, 0, { solid: false });
      if (area > 11 && rng.chance(0.4)) {
        const d = b.try(L, room, ['desk'], 1.2, 0.6, 0.75);
        if (d) b.free(L, room, 'deskchair', 0.45, 0.45, 0.85, d.x + Math.sin(d.yaw) * 0.7, d.z + Math.cos(d.yaw) * 0.7, d.yaw + 3.14 + rng.range(-0.5, 0.5), { solid: false });
      }
      break;
    }
    case 'bath': {
      const tub = b.try(L, room, ['tub'], 0.75, 1.6, 0.55);
      b.try(L, room, ['toilet'], 0.4, 0.7, 0.75);
      searchable(b, b.try(L, room, ['vanity'], 0.6, 0.45, 0.85), wealth, 0, 0.85);
      void tub;
      break;
    }
    case 'storage': {
      searchable(b, b.try(L, room, ['shelf'], 1.2, 0.4, 1.9), wealth, 0, 0.9);
      if (wide > 1.6) b.try(L, room, ['crate', 'barrel'], 0.6, 0.6, 0.6);
      if (wide > 2.2 && rng.chance(0.6)) searchable(b, b.try(L, room, ['crate'], 0.8, 0.6, 0.7), wealth, 0, 0.6);
      break;
    }
    case 'hall':
    case 'lobby': {
      if (room.role === 'lobby') {
        searchable(b, b.try(L, room, ['desk'], 1.6, 0.7, 1.05), wealth, 0, 0.9);
        b.try(L, room, ['armchair'], 0.85, 0.85, 0.85);
        b.try(L, room, ['sofa'], 1.7, 0.85, 0.85);
      } else b.try(L, room, ['shelf'], 0.9, 0.35, 1.0);
      break;
    }
    case 'office': {
      const d = b.try(L, room, ['desk'], 1.5, 0.75, 0.75);
      searchable(b, d, wealth, 0, 0.9);
      if (d) b.free(L, room, 'deskchair', 0.5, 0.5, 0.9, d.x + Math.sin(d.yaw) * 0.85, d.z + Math.cos(d.yaw) * 0.85, d.yaw + 3.14 + rng.range(-0.6, 0.6), { solid: false });
      searchable(b, b.try(L, room, ['filing'], 0.5, 0.6, 1.3), wealth, 0, 0.9);
      if (rng.chance(0.25) && area > 6) searchable(b, b.try(L, room, ['safe'], 0.55, 0.55, 0.55), wealth * 1.2, 2, 1);
      if (area > 8) b.try(L, room, ['shelf'], 1.0, 0.35, 1.8);
      break;
    }
    case 'shed':
    case 'workshop': {
      searchable(b, b.try(L, room, ['workbench'], 1.8, 0.7, 0.95), wealth, 1, 1);
      searchable(b, b.try(L, room, ['locker'], 0.5, 0.5, 1.8), wealth, 1, 0.7);
      for (let i = 0; i < 3; i++) b.try(L, room, ['barrel', 'crate'], 0.6, 0.6, 0.8);
      break;
    }
    default:
      break;
  }
}

// ------------------------------------------------------------------------------------------ stairs

function planStairs(b: Builder, rect: Rect): Stair | null {
  const { levelH } = b;
  const rise = 0.2;
  const steps = Math.round(levelH / rise);
  const tread = 0.26;
  const run = (steps - 1) * tread;
  const wide = rect.x1 - rect.x0;
  const deep = rect.z1 - rect.z0;
  const width = 0.95;
  const along: 'x' | 'z' = deep >= wide ? 'z' : 'x';
  const need = run + 1.9;
  if ((along === 'z' ? deep : wide) < need + 0.2 || (along === 'z' ? wide : deep) < width + 2.6) return null;
  const dirSign = b.rng.chance(0.5) ? 1 : -1;
  const wallSign = b.rng.chance(0.5) ? 1 : -1;
  if (along === 'z') {
    const x = wallSign > 0 ? rect.x1 - width / 2 - 0.05 : rect.x0 + width / 2 + 0.05;
    const z = dirSign > 0 ? rect.z0 + 0.9 : rect.z1 - 0.9;
    return { level: 0, x, z, dir: dirSign > 0 ? '+z' : '-z', width, steps, rise, tread };
  }
  const z = wallSign > 0 ? rect.z1 - width / 2 - 0.05 : rect.z0 + width / 2 + 0.05;
  const x = dirSign > 0 ? rect.x0 + 0.9 : rect.x1 - 0.9;
  return { level: 0, x, z, dir: dirSign > 0 ? '+x' : '-x', width, steps, rise, tread };
}

/** The part of the stair under the next slab can keep the slab above it: the hole starts where head room runs out. */
function stairWell(b: Builder, s: Stair): Rect {
  const r = b.stairRect(s);
  // Where a 1.7 m body (0.3 wide on every side) first meets the slab above: open the well from there.
  const clearFeet = b.levelH - 0.3 - 1.7 - 0.15;
  const head = Math.max(0, (clearFeet / s.rise - 1) * s.tread - 0.4);
  switch (s.dir) {
    case '+x':
      return { ...r, x0: r.x0 + head, x1: r.x1 + 0.05 };
    case '-x':
      return { ...r, x1: r.x1 - head, x0: r.x0 - 0.05 };
    case '+z':
      return { ...r, z0: r.z0 + head, z1: r.z1 + 0.05 };
    default:
      return { ...r, z1: r.z1 - head, z0: r.z0 - 0.05 };
  }
}

// ------------------------------------------------------------------------------------------ building types

function entranceRoom(b: Builder, leaves: Rect[], level: number): Rect {
  const side: Side = b.inp.door > 0 ? 'e' : 'w';
  const edge = side === 'e' ? b.root.x1 : b.root.x0;
  const touching = leaves.filter((r) => Math.abs((side === 'e' ? r.x1 : r.x0) - edge) < 0.01);
  const pool = touching.length ? touching : leaves;
  void level;
  return pool.sort((p, q) => (q.x1 - q.x0) * (q.z1 - q.z0) - (p.x1 - p.x0) * (p.z1 - p.z0))[0];
}

function assignHouseRoles(b: Builder, level: number, leaves: Rect[], entrance: Rect | null, upper: boolean) {
  const rng = b.rng;
  const area = (r: Rect) => (r.x1 - r.x0) * (r.z1 - r.z0);
  const sorted = leaves.filter((r) => r !== entrance).sort((p, q) => area(q) - area(p));
  const rooms: Room[] = [];
  const roleOf = new Map<Rect, RoomRole>();
  if (entrance) roleOf.set(entrance, upper ? 'hall' : 'living');
  let kitchenDone = upper;
  let bathDone = false;
  // The smallest decent room is the bathroom.
  const bathCand = [...sorted].reverse().find((r) => area(r) >= 3.2 && area(r) <= 11 && Math.min(r.x1 - r.x0, r.z1 - r.z0) >= 1.6);
  if (bathCand && (leaves.length > 2 || upper)) {
    roleOf.set(bathCand, 'bath');
    bathDone = true;
  }
  for (const r of sorted) {
    if (roleOf.has(r)) continue;
    if (!kitchenDone && area(r) >= 6) {
      roleOf.set(r, 'kitchen');
      kitchenDone = true;
    } else if (area(r) >= 5.5) roleOf.set(r, 'bedroom');
    else if (Math.min(r.x1 - r.x0, r.z1 - r.z0) < 1.7) roleOf.set(r, 'hall');
    else roleOf.set(r, 'storage');
  }
  if (!bathDone && !upper && leaves.length > 3) {
    const r = [...sorted].reverse().find((q) => roleOf.get(q) === 'storage');
    if (r) roleOf.set(r, 'bath');
  }
  for (const r of leaves) {
    const role = roleOf.get(r) ?? 'room';
    const floor: FloorMat = role === 'bath' ? 'tile' : role === 'kitchen' ? (rng.chance(0.5) ? 'tile' : 'lino') : role === 'bedroom' ? (rng.chance(0.4) ? 'carpet' : 'wood') : role === 'storage' ? 'concrete' : 'wood';
    const pal = role === 'living' ? 'living' : role === 'kitchen' ? 'kitchen' : role === 'bedroom' ? 'bedroom' : role === 'bath' ? 'bath' : 'hall';
    rooms.push(b.addRoom(level, r, role, floor, pal));
  }
  return rooms;
}

function genHouse(b: Builder) {
  const { inp, rng } = b;
  const floors = inp.floors;
  const w = b.root.x1 - b.root.x0;
  const d = b.root.z1 - b.root.z0;
  let stair: Stair | null = null;
  if (floors > 1) {
    stair = planStairs(b, b.root);
    if (!stair) {
      // Not enough room for a stair: a single storey after all.
      inp.floors = 1;
    }
  }
  const nLevels = inp.floors;
  for (let l = 0; l < nLevels; l++) b.addExterior(l);
  const avoid: Rect[] = [];
  if (stair) {
    b.stairs.push(stair);
    avoid.push(b.stairKeep(stair));
    b.wells.push({ ...stairWell(b, stair), level: 1, dir: stair.dir });
  }
  const area = w * d;
  let living: Room | null = null;
  for (let l = 0; l < nLevels; l++) {
    const target = Math.max(2, Math.min(l === 0 ? 6 : 4, Math.round(area / (l === 0 ? 17 : 15) + rng.range(-0.8, 1.2))));
    const leaves = b.subdivide(l, b.root, target, 2.3, avoid);
    const entrance = l === 0 ? entranceRoom(b, leaves, l) : leaves.find((r) => stair && rectOverlap(r, b.stairRect(stair))) ?? null;
    const rooms = assignHouseRoles(b, l, leaves, entrance, l > 0);
    if (l === 0) {
      living = rooms.find((r) => r.role === 'living') ?? rooms[0];
      b.frontDoor(l, living, 'door');
      // A back door, often through the kitchen.
      if (rng.chance(0.6)) {
        const back = b.extWall(l, inp.door > 0 ? 'w' : 'e');
        const k = rooms.find((r) => r.role === 'kitchen') ?? rooms.find((r) => r !== living && (inp.door > 0 ? r.x0 - b.root.x0 < 0.05 : b.root.x1 - r.x1 < 0.05));
        if (k && (inp.door > 0 ? k.x0 - b.root.x0 < 0.05 : b.root.x1 - k.x1 < 0.05)) {
          const c = (k.z0 + k.z1) / 2 + rng.range(-0.5, 0.5);
          b.open(back, c, DOOR_W, 'door');
        }
      }
    }
    b.windows(l, rooms);
    b.noteAllDoors();
    if (l === 0) {
      // Stair rooms: the stair is furniture of its own.
    }
    for (const r of rooms) furnishRoom(b, r, 1);
    if (l === 0) for (const r of rooms) b.lairs.push({ x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 });
  }
}

function genShack(b: Builder) {
  const { rng } = b;
  b.addExterior(0);
  const w = b.root.x1 - b.root.x0;
  const d = b.root.z1 - b.root.z0;
  let rooms: Room[];
  if (Math.max(w, d) > 5 && rng.chance(0.6)) {
    const leaves = b.subdivide(0, b.root, 2, 2.0);
    rooms = leaves.map((r, i) => b.addRoom(0, r, i === 0 ? 'shed' : 'storage', 'wood', 'plain'));
  } else rooms = [b.addRoom(0, b.root, 'shed', rng.chance(0.5) ? 'wood' : 'concrete', 'plain')];
  const main = rooms[0];
  b.frontDoor(0, rooms.sort((p, q) => (q.x1 - q.x0) * (q.z1 - q.z0) - (p.x1 - p.x0) * (p.z1 - p.z0))[0]);
  b.windows(0, rooms, { chance: 0.7, width: 0.9 });
  b.noteAllDoors();
  for (const r of rooms) {
    if (r.role === 'shed') {
      const bunk = b.try(0, r, ['bunk'], 0.9, 1.9, 1.5);
      void bunk;
      b.try(0, r, ['woodstove'], 0.55, 0.55, 1.0);
      searchable(b, b.try(0, r, ['footlocker'], 0.9, 0.5, 0.45), 1, 1, 0.9);
      const t = b.free(0, r, 'table', 1.0, 0.7, 0.75, (r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2, 0, { solid: true });
      if (t) b.free(0, r, 'chair', 0.42, 0.42, 0.85, t.x + 0.8, t.z, rng.range(0, 6), { solid: false });
      searchable(b, b.try(0, r, ['workbench'], 1.4, 0.6, 0.9), 1, 1, 0.5);
    } else {
      searchable(b, b.try(0, r, ['shelf'], 1.1, 0.4, 1.8), 1, 0, 0.9);
      b.try(0, r, ['crate', 'barrel'], 0.6, 0.6, 0.6);
    }
  }
  b.lairs.push({ x: (main.x0 + main.x1) / 2, z: (main.z0 + main.z1) / 2 });
}

function genStore(b: Builder) {
  const { inp, rng } = b;
  b.addExterior(0);
  const doorWall = inp.door;
  const w = b.root.x1 - b.root.x0;
  const d = b.root.z1 - b.root.z0;
  // Sales floor takes the road end; a back strip is split into storage, an office and a toilet.
  const back = Math.min(d * 0.38, 5.2);
  const hasBack = d > 8 && rng.chance(0.9);
  const sales: Rect = hasBack ? { ...b.root, z0: b.root.z0 + back } : b.root;
  const strip: Rect = { ...b.root, z1: b.root.z0 + back };
  const rooms: Room[] = [];
  if (hasBack) {
    const wall = b.addWall(0, 'x', b.root.z0 + back, b.root.x0, b.root.x1);
    const leaves = b.subdivide(0, strip, Math.min(3, Math.max(2, Math.round(w / 3.2))), 2.2);
    b.doorsFor([wall], []);
    const order = leaves.sort((p, q) => (q.x1 - q.x0) - (p.x1 - p.x0));
    const roles: RoomRole[] = ['storage', 'office', 'bath'];
    order.forEach((r, i) => rooms.push(b.addRoom(0, r, roles[i % 3], roles[i % 3] === 'bath' ? 'tile' : roles[i % 3] === 'office' ? 'carpet' : 'concrete', roles[i % 3] === 'bath' ? 'bath' : 'plain')));
  }
  const salesRoom = b.addRoom(0, sales, 'sales', 'lino', 'plain');
  rooms.push(salesRoom);
  b.frontDoor(0, salesRoom, 'door', 1.3);
  b.windows(0, [salesRoom], { width: 2.0, sill: 0.8, chance: 1 });
  b.windows(0, rooms.filter((r) => r !== salesRoom), { chance: 0.6 });
  b.noteAllDoors();
  // Rows of shelves run across the shop, a counter by the door, coolers on the far wall.
  const frontSide: Side = doorWall > 0 ? 'e' : 'w';
  const backSide: Side = doorWall > 0 ? 'w' : 'e';
  const counter = b.against(0, salesRoom, 's', 'checkout', 2.0, 0.7, 1.05, doorWall > 0 ? 0.85 : 0.15, { solid: true });
  searchable(b, counter, 1.1, 0, 1);
  if (!counter) searchable(b, b.try(0, salesRoom, ['checkout'], 2.0, 0.7, 1.05, {}, [frontSide, 's', 'n']), 1.1, 0, 1);
  searchable(b, b.try(0, salesRoom, ['cooler'], 2.2, 0.8, 1.9, {}, [backSide, 'n']), 1, 0, 0.9);
  searchable(b, b.try(0, salesRoom, ['cooler'], 1.6, 0.8, 1.9, {}, [backSide, 'n']), 1, 0, 0.6);
  const rowsAcross = (salesRoom.x1 - salesRoom.x0) > (salesRoom.z1 - salesRoom.z0);
  const nRows = Math.max(1, Math.floor(((rowsAcross ? salesRoom.x1 - salesRoom.x0 : salesRoom.z1 - salesRoom.z0) - 3.0) / 2.6));
  for (let i = 0; i < nRows; i++) {
    const t = (i + 1) / (nRows + 1);
    const len = rowsAcross ? salesRoom.z1 - salesRoom.z0 : salesRoom.x1 - salesRoom.x0;
    const shelfLen = Math.min(3.2, len - 3.0);
    if (shelfLen < 1.4) break;
    const cx = rowsAcross ? salesRoom.x0 + (salesRoom.x1 - salesRoom.x0) * t : (salesRoom.x0 + salesRoom.x1) / 2 + (rng.next() - 0.5) * 0.6;
    const cz = rowsAcross ? (salesRoom.z0 + salesRoom.z1) / 2 + (rng.next() - 0.5) * 0.6 : salesRoom.z0 + (salesRoom.z1 - salesRoom.z0) * t;
    if (rng.chance(0.15)) continue;
    const f = b.free(0, salesRoom, 'gondola', shelfLen, 0.6, 1.5, cx, cz, rowsAcross ? Math.PI / 2 : 0, { solid: true });
    searchable(b, f, 1, 0, 0.6);
  }
  if (rng.chance(0.5)) b.free(0, salesRoom, 'crate', 0.8, 0.8, 0.6, salesRoom.x0 + 1, salesRoom.z1 - 1, rng.range(0, 3), { solid: true });
  for (const r of rooms) if (r !== salesRoom) furnishRoom(b, r, 1);
  for (const r of rooms) b.lairs.push({ x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 });
}

function genMotel(b: Builder) {
  const { inp, rng } = b;
  b.addExterior(0);
  const lenZ = b.root.z1 - b.root.z0;
  const depth = b.root.x1 - b.root.x0;
  const bay = 4.2 + rng.next() * 0.8;
  const n = Math.max(2, Math.round(lenZ / bay));
  const cell = lenZ / n;
  const doorSide: Side = inp.door > 0 ? 'e' : 'w';
  const rooms: Room[] = [];
  const partitions: Wall[] = [];
  for (let i = 1; i < n; i++) partitions.push(b.addWall(0, 'x', b.root.z0 + i * cell, b.root.x0, b.root.x1));
  for (let i = 0; i < n; i++) {
    const z0 = b.root.z0 + i * cell;
    const z1 = z0 + cell;
    const lobby = i === 0 && rng.chance(0.8);
    const bathD = 2.5;
    if (lobby || depth < 6) {
      const r = b.addRoom(0, { x0: b.root.x0, x1: b.root.x1, z0, z1 }, lobby ? 'lobby' : 'room', lobby ? 'lino' : 'carpet', 'plain');
      rooms.push(r);
      continue;
    }
    // A bathroom at the back, the sleeping room in front.
    const bx = doorSide === 'e' ? b.root.x0 + bathD : b.root.x1 - bathD;
    const wall = b.addWall(0, 'z', bx, z0, z1);
    const bath = b.addRoom(0, doorSide === 'e' ? { x0: b.root.x0, x1: bx, z0, z1 } : { x0: bx, x1: b.root.x1, z0, z1 }, 'bath', 'tile', 'bath');
    const sleep = b.addRoom(0, doorSide === 'e' ? { x0: bx, x1: b.root.x1, z0, z1 } : { x0: b.root.x0, x1: bx, z0, z1 }, 'bedroom', rng.chance(0.5) ? 'carpet' : 'wood', 'bedroom');
    rooms.push(bath, sleep);
    b.open(wall, z0 + cell * (0.25 + rng.next() * 0.5), DOOR_W, 'door');
    // Front door and window of each room.
    const w = b.extWall(0, doorSide);
    const dc = z0 + cell * (0.3 + rng.next() * 0.15);
    const op = b.open(w, dc, DOOR_W, 'door');
    void op;
    b.open(w, z0 + cell * 0.74, 1.2, 'window', { sill: 0.9, head: 2.0, glass: pick(rng, ['intact', 'broken', 'broken', 'boarded'] as const) });
  }
  // Doors between rooms along the partitions: occasionally a connecting door.
  for (const p of partitions) if (rng.chance(0.2)) b.open(p, (p.a + p.b) / 2 + rng.range(-1, 1), DOOR_W, 'door');
  const lobbyRoom = rooms.find((r) => r.role === 'lobby');
  if (lobbyRoom) {
    const w = b.extWall(0, doorSide);
    w.ops = w.ops.filter((o) => o.a > lobbyRoom.z1 || o.b < lobbyRoom.z0);
    b.open(w, (lobbyRoom.z0 + lobbyRoom.z1) / 2, 1.3, 'door');
    b.open(w, lobbyRoom.z0 + 0.7, 0.8, 'window', { sill: 0.9, head: 2.0, glass: 'broken' });
    // The lobby doubles as the way through to the first room.
  }
  b.windows(0, rooms.filter((r) => r.role === 'bath' || r.role === 'room'), { chance: 0.5, width: 0.9 });
  b.noteAllDoors();
  for (const r of rooms) {
    if (r.role === 'bedroom') {
      const double = r.z1 - r.z0 > 3.8 || rng.chance(0.4);
      const bed = b.try(0, r, ['bed'], double ? 1.5 : 0.95, 2.0, 0.55, { solid: true }, doorSide === 'e' ? ['w', 's', 'n'] : ['e', 's', 'n']);
      void bed;
      if (rng.chance(0.5)) b.try(0, r, ['bed'], 0.95, 2.0, 0.55, { solid: true });
      b.try(0, r, ['nightstand'], 0.45, 0.4, 0.5);
      searchable(b, b.try(0, r, ['dresser'], 1.1, 0.5, 0.9), 1, 0, 0.7);
      b.try(0, r, ['tvstand'], 1.0, 0.45, 0.5);
      if (rng.chance(0.4)) b.free(0, r, 'table', 0.8, 0.8, 0.75, (r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2, 0, { solid: true });
    } else if (r.role === 'bath') furnishRoom(b, r, 1);
    else furnishRoom(b, r, 1);
  }
  for (const r of rooms) if (r.role !== 'bath') b.lairs.push({ x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 });
}

function genBarn(b: Builder) {
  const { inp, rng } = b;
  b.addExterior(0);
  const hall = b.addRoom(0, b.root, 'barn', 'dirt', 'wood');
  b.frontDoor(0, hall, 'gate', 4.0);
  const rear = b.extWall(0, inp.door > 0 ? 'w' : 'e');
  b.open(rear, (hall.z0 + hall.z1) / 2 + rng.range(-3, 3), 4.0, 'gate');
  b.open(b.extWall(0, 's'), (hall.x0 + hall.x1) / 2, 0.95, 'door');
  // High windows under the eaves.
  for (const side of ['n', 's'] as Side[]) {
    const w = b.extWall(0, side);
    for (let x = hall.x0 + 2.5; x < hall.x1 - 2; x += 4.5) b.open(w, x, 0.9, 'window', { sill: 3.6, head: 4.5, glass: 'broken' });
  }
  b.noteAllDoors();
  const wide = hall.x1 - hall.x0;
  const deep = hall.z1 - hall.z0;
  // Stalls down one long side: board partitions every three metres, hay in some of them.
  const stallSide: Side = deep > wide ? (rng.chance(0.5) ? 'w' : 'e') : rng.chance(0.5) ? 's' : 'n';
  const alongZ = stallSide === 'w' || stallSide === 'e';
  const longDim = alongZ ? deep : wide;
  const pitch = 3.0;
  const count = Math.max(2, Math.floor((longDim - 2) / pitch));
  const plen = 2.4;
  for (let i = 0; i <= count; i++) {
    const t = (alongZ ? hall.z0 : hall.x0) + 1.2 + i * pitch;
    if (t > (alongZ ? hall.z1 : hall.x1) - 1.2) break;
    const edge = stallSide === 'w' ? hall.x0 + 0.2 + plen / 2 : stallSide === 'e' ? hall.x1 - 0.2 - plen / 2 : stallSide === 's' ? hall.z0 + 0.2 + plen / 2 : hall.z1 - 0.2 - plen / 2;
    b.free(0, hall, 'stall', plen, 0.12, 1.5, alongZ ? edge : t, alongZ ? t : edge, alongZ ? 0 : Math.PI / 2, { solid: true });
    if (i < count && rng.chance(0.45)) {
      const hx = alongZ ? edge : t + pitch / 2;
      const hz = alongZ ? t + pitch / 2 : edge;
      b.free(0, hall, 'haybale', 0.9, 0.5, 0.4, hx, hz, rng.range(0, 3), { solid: false });
    }
  }
  for (let i = 0; i < 5; i++) {
    const hb = b.try(0, hall, ['haybale'], 1.0, 0.5, 0.5);
    if (hb && rng.chance(0.5)) b.free(0, hall, 'haybale', 1.0, 0.5, 0.5, hb.x, hb.z, hb.yaw, { solid: true });
  }
  searchable(b, b.try(0, hall, ['workbench'], 2.0, 0.7, 0.95), 1, 1, 1);
  searchable(b, b.try(0, hall, ['locker'], 0.6, 0.5, 1.8), 1, 1, 0.8);
  for (let i = 0; i < 4; i++) searchable(b, b.try(0, hall, ['crate', 'barrel'], 0.8, 0.8, 0.8), 1, 0, 0.5);
  b.lairs.push({ x: (hall.x0 + hall.x1) / 2, z: (hall.z0 + hall.z1) / 2 });
}

function genWarehouse(b: Builder) {
  const { inp, rng } = b;
  b.addExterior(0);
  const doorSide: Side = inp.door > 0 ? 'e' : 'w';
  // An office and a toilet in one corner, the rest one great hall.
  const wide = b.root.x1 - b.root.x0;
  const deep = b.root.z1 - b.root.z0;
  const offD = 5.0;
  const corner = rng.chance(0.5);
  const offRect: Rect = { x0: b.root.x0, x1: b.root.x1, z0: corner ? b.root.z0 : b.root.z1 - offD, z1: corner ? b.root.z0 + offD : b.root.z1 };
  const hallRect: Rect = { ...b.root, z0: corner ? b.root.z0 + offD : b.root.z0, z1: corner ? b.root.z1 : b.root.z1 - offD };
  const wall = b.addWall(0, 'x', corner ? b.root.z0 + offD : b.root.z1 - offD, b.root.x0, b.root.x1);
  const offices = b.subdivide(0, offRect, 3, 2.2);
  b.doorsFor([wall], []);
  const rooms: Room[] = [];
  offices.sort((p, q) => (q.x1 - q.x0) - (p.x1 - p.x0)).forEach((r, i) => rooms.push(b.addRoom(0, r, i === 0 ? 'office' : i === 1 ? 'storage' : 'bath', i === 0 ? 'carpet' : i === 1 ? 'concrete' : 'tile', i === 2 ? 'bath' : 'plain')));
  const hall = b.addRoom(0, hallRect, 'barn', 'concrete', 'industrial');
  hall.role = 'workshop';
  rooms.push(hall);
  b.frontDoor(0, hall, 'gate', 4.4);
  const rear = b.extWall(0, doorSide === 'e' ? 'w' : 'e');
  if (rng.chance(0.8)) b.open(rear, (hall.z0 + hall.z1) / 2 + rng.range(-4, 4), 4.4, 'gate');
  const sd = b.extWall(0, corner ? 'n' : 's');
  b.open(sd, (hall.x0 + hall.x1) / 2, 0.95, 'door');
  for (const side of ['n', 's'] as Side[]) {
    const w = b.extWall(0, side);
    for (let x = b.root.x0 + 2.5; x < b.root.x1 - 2; x += 5) b.open(w, x, 1.8, 'window', { sill: 3.4, head: 4.6, glass: pick(rng, ['intact', 'broken', 'broken'] as const) });
  }
  b.windows(0, rooms.filter((r) => r !== hall), { chance: 0.7, width: 1.2 });
  b.noteAllDoors();
  // Racking in aisles, pallets and crates on the floor.
  const aisleAlong = deep > wide;
  const rows = Math.max(1, Math.floor(((aisleAlong ? hall.x1 - hall.x0 : hall.z1 - hall.z0) - 6) / 5.2));
  for (let i = 0; i < rows; i++) {
    const t = (i + 1) / (rows + 1);
    const cx = aisleAlong ? hall.x0 + (hall.x1 - hall.x0) * t : (hall.x0 + hall.x1) / 2;
    const cz = aisleAlong ? (hall.z0 + hall.z1) / 2 : hall.z0 + (hall.z1 - hall.z0) * t;
    const len = (aisleAlong ? hall.z1 - hall.z0 : hall.x1 - hall.x0) - 12;
    if (len < 4) continue;
    const segs = Math.floor(len / 3.6);
    for (let k = 0; k < segs; k++) {
      if (rng.chance(0.2)) continue;
      const off = (k - (segs - 1) / 2) * 3.6;
      const f = b.free(0, hall, 'rack', 3.4, 1.0, 3.6, aisleAlong ? cx : cx + off, aisleAlong ? cz + off : cz, aisleAlong ? 0 : Math.PI / 2, { solid: true });
      searchable(b, f, 1.1, 0, 0.45);
    }
  }
  for (let i = 0; i < 9; i++) {
    const x = rng.range(hall.x0 + 1.2, hall.x1 - 1.2);
    const z = rng.range(hall.z0 + 1.2, hall.z1 - 1.2);
    const kind: FurnKind = rng.chance(0.5) ? 'pallet' : rng.chance(0.5) ? 'crate' : 'barrel';
    const f = b.free(0, hall, kind, kind === 'pallet' ? 1.2 : 0.9, kind === 'pallet' ? 1.0 : 0.9, kind === 'pallet' ? 1.1 : 0.9, x, z, rng.range(0, 3), { solid: true });
    if (kind === 'crate') searchable(b, f, 1, 0, 0.5);
  }
  searchable(b, b.try(0, hall, ['workbench'], 2.2, 0.8, 0.95), 1.2, 1, 1);
  searchable(b, b.try(0, hall, ['locker'], 0.6, 0.5, 1.8), 1, 1, 0.9);
  for (const r of rooms) if (r.role !== 'bath') furnishRoom(b, r, 1);
  b.lairs.push({ x: (hall.x0 + hall.x1) / 2, z: (hall.z0 + hall.z1) / 2 });
  for (const r of rooms) if (r !== hall && r.role === 'office') b.lairs.push({ x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 });
}

// ------------------------------------------------------------------------------------------ damage

function weather(b: Builder) {
  const { inp, rng } = b;
  const wear = inp.wear;
  // Breaches: a section of an exterior or interior wall has fallen.
  for (const w of b.walls) {
    if (w.level !== 0 && rng.next() > 0.3) continue;
    if (rng.next() > wear * 0.22) continue;
    const len = w.b - w.a;
    if (len < 3) continue;
    const width = 1.2 + rng.next() * 1.6;
    const c = w.a + 0.6 + width / 2 + rng.next() * Math.max(0.01, len - width - 1.2);
    const op = b.open(w, c, width, 'breach');
    if (op) {
      op.head = w.h * (0.5 + rng.next() * 0.5);
      b.debris.push(w.axis === 'x' ? { x: c, z: w.c + (w.out || (rng.chance(0.5) ? 1 : -1)) * 0.9, r: 0.9, level: w.level } : { x: w.c + (w.out || (rng.chance(0.5) ? 1 : -1)) * 0.9, z: c, r: 0.9, level: w.level });
    }
  }
  // Roof.
  b.roofState = inp.roof === 'none' ? 'gone' : rng.next() < wear * 0.5 ? 'partial' : 'intact';
  // Debris and tipped furniture inside.
  const rooms = b.rooms.filter((r) => r.level === 0);
  const n = Math.round(rooms.length * (0.5 + wear * 2) * rng.next() + (b.roofState !== 'intact' ? 2 : 0));
  for (let i = 0; i < n; i++) {
    const r = rooms[Math.floor(rng.next() * rooms.length)];
    const x = rng.range(r.x0 + 0.6, r.x1 - 0.6);
    const z = rng.range(r.z0 + 0.6, r.z1 - 0.6);
    if (b.keep[0].some((k) => x > k.x0 && x < k.x1 && z > k.z0 && z < k.z1)) continue;
    b.debris.push({ x, z, r: 0.5 + rng.next() * 0.7, level: 0 });
  }
  // Knocked-over furniture: swap a few for a tipped version in place.
  for (const f of b.furn) {
    if (f.kind === 'chair' || f.kind === 'deskchair') f.yaw += rng.range(-1.2, 1.2) * (rng.chance(wear + 0.1) ? 2 : 0.2);
  }
}

// ------------------------------------------------------------------------------------------ entry points

export function generatePlan(inp: PlanInput): BuildingPlan {
  const b = new Builder({ ...inp });
  switch (inp.look) {
    case 'house':
      genHouse(b);
      break;
    case 'store':
      genStore(b);
      break;
    case 'motel':
      genMotel(b);
      break;
    case 'barn':
      genBarn(b);
      break;
    case 'warehouse':
      genWarehouse(b);
      break;
    case 'shack':
      genShack(b);
      break;
  }
  weather(b);
  return {
    x0: inp.x0,
    x1: inp.x1,
    z0: inp.z0,
    z1: inp.z1,
    look: inp.look,
    door: inp.door,
    levels: b.inp.floors,
    levelH: b.levelH,
    floorY: inp.floorY,
    seed: inp.seed,
    walls: b.walls,
    rooms: b.rooms,
    furn: b.furn,
    stairs: b.stairs,
    debris: b.debris,
    wells: b.wells,
    roof: b.roofState,
    lairs: b.lairs,
  };
}

/** The three sides of a stairwell that need a banister: both long sides and the end the stairs climb from. */
export function wellRails(w: Rect & { dir: Stair['dir'] }, t = 0.06): Rect[] {
  const L: Rect = { x0: w.x0, x1: w.x0 + t, z0: w.z0, z1: w.z1 };
  const R: Rect = { x0: w.x1 - t, x1: w.x1, z0: w.z0, z1: w.z1 };
  const S: Rect = { x0: w.x0, x1: w.x1, z0: w.z0, z1: w.z0 + t };
  const N: Rect = { x0: w.x0, x1: w.x1, z0: w.z1 - t, z1: w.z1 };
  const Wd: Rect = { x0: w.x0, x1: w.x0 + t, z0: w.z0, z1: w.z1 };
  switch (w.dir) {
    case '+z':
      return [L, R, S];
    case '-z':
      return [L, R, N];
    case '+x':
      return [S, N, Wd];
    default:
      return [S, N, R];
  }
}

// ------------------------------------------------------------------------------------------ wall pieces and colliders

export interface WallPiece {
  wall: Wall;
  /** Along-wall range and height range above the level floor. */
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  /** True for the sill under a window and for the plain wall between openings: things you can bump into. */
  solid: boolean;
}

/** Split a wall around its openings into rectangles. */
export function wallPieces(w: Wall): WallPiece[] {
  const out: WallPiece[] = [];
  let u = w.a;
  for (const op of w.ops) {
    if (op.a > u + 0.001) out.push({ wall: w, u0: u, u1: op.a, v0: 0, v1: w.h, solid: true });
    if (op.sill > 0.001) out.push({ wall: w, u0: op.a, u1: op.b, v0: 0, v1: op.sill, solid: true });
    if (op.head < w.h - 0.001) out.push({ wall: w, u0: op.a, u1: op.b, v0: op.head, v1: w.h, solid: false });
    u = op.b;
  }
  if (w.b > u + 0.001) out.push({ wall: w, u0: u, u1: w.b, v0: 0, v1: w.h, solid: true });
  return out;
}

export function levelBase(plan: BuildingPlan, level: number) {
  return plan.floorY + level * plan.levelH;
}

/** What a building's walls are made of decides what a bullet can punch through: siding and planks, plaster, corrugated tin. */
export function wallMaterial(look: BuildingPlan['look']): NonNullable<Aabb['mat']> {
  return look === 'warehouse' || look === 'shack' ? 'sheet' : look === 'barn' || look === 'house' ? 'wood' : 'plaster';
}

/** What a window of a building is glazed with: a shop's wide front takes more than a house's sash. */
export function paneKind(look: BuildingPlan['look'], op: Opening): import('../sim/glass').GlassKind {
  return look === 'store' && op.b - op.a >= 1.8 ? 'shop' : 'window';
}

/** The key a window's pane goes by, for the building's glass and the collider that stands in for it. */
export const paneKey = (wall: number, op: Opening) => `${wall}:${op.a.toFixed(2)}`;

/** The colliders of one wall: a box for each solid piece between its openings. `wi` is the wall's index in the plan. */
export function wallAabbs(plan: BuildingPlan, w: Wall, wi: number, newId: () => number): Aabb[] {
  const out: Aabb[] = [];
  const mat = wallMaterial(plan.look);
  const base = levelBase(plan, w.level);
  for (const p of wallPieces(w)) {
    if (!p.solid) continue;
    const y0 = w.level === 0 && p.v0 === 0 ? plan.floorY - 1.2 : base + p.v0;
    const y1 = base + p.v1;
    const extra = { mat, wall: wi };
    if (w.axis === 'x') out.push({ id: newId(), minX: p.u0, maxX: p.u1, minZ: w.c - w.t / 2, maxZ: w.c + w.t / 2, y0, y1, kind: 'partition', hp: 99999, ...extra });
    else out.push({ id: newId(), minX: w.c - w.t / 2, maxX: w.c + w.t / 2, minZ: p.u0, maxZ: p.u1, y0, y1, kind: 'partition', hp: 99999, ...extra });
  }
  // Whole panes of glass stop a person as much as a wall does, and any bullet breaks them.
  for (const op of w.ops) {
    if (op.kind !== 'window' || op.glass !== 'intact') continue;
    const py0 = base + op.sill;
    const py1 = base + op.head;
    if (w.axis === 'x') out.push({ id: newId(), minX: op.a, maxX: op.b, minZ: w.c - 0.025, maxZ: w.c + 0.025, y0: py0, y1: py1, kind: 'partition', hp: 99999, mat: 'glass', wall: wi, pane: paneKind(plan.look, op) });
    else out.push({ id: newId(), minX: w.c - 0.025, maxX: w.c + 0.025, minZ: op.a, maxZ: op.b, y0: py0, y1: py1, kind: 'partition', hp: 99999, mat: 'glass', wall: wi, pane: paneKind(plan.look, op) });
  }
  return out;
}

/** Colliders for walls, furniture, stairs and upper floors. Ground floors are the terrain itself. */
export function planAabbs(plan: BuildingPlan, newId: () => number): Aabb[] {
  const out: Aabb[] = [];
  const box = (minX: number, maxX: number, minZ: number, maxZ: number, y0: number, y1: number, kind: Aabb['kind'], extra: Partial<Aabb> = {}) => {
    out.push({ id: newId(), minX, maxX, minZ, maxZ, y0, y1, kind, hp: 99999, ...extra });
  };
  plan.walls.forEach((w, wi) => out.push(...wallAabbs(plan, w, wi, newId)));
  for (const f of plan.furn) {
    if (!f.solid || f.h < 0.3) continue;
    const r = furnRect(f);
    const base = levelBase(plan, f.level);
    box(r.x0, r.x1, r.z0, r.z1, base, base + f.h, 'furniture', { physOnly: false });
  }
  // Stairs collide as one slope that follows the treads: a capsule can't climb narrow steps, it can walk a ramp.
  for (const s of plan.stairs) {
    const base = levelBase(plan, s.level);
    const sign = s.dir === '+x' || s.dir === '+z' ? 1 : -1;
    const alongX = s.dir === '+x' || s.dir === '-x';
    const u0 = -s.tread / 2;
    const u1 = (s.steps - 2) * s.tread + s.tread / 2;
    const h0 = s.rise * (u0 / s.tread + 1) + 0.03;
    const h1 = s.rise * (u1 / s.tread + 1) + 0.03;
    const du = u1 - u0;
    const len = Math.hypot(du, h1 - h0);
    const theta = Math.atan2(h1 - h0, du);
    const thick = 0.12;
    // Centre of the sloped top surface, then down by half the thickness along the normal.
    const um = (u0 + u1) / 2;
    const hm = (h0 + h1) / 2;
    const cu = um + Math.sin(theta) * (thick / 2);
    const ch = hm - Math.cos(theta) * (thick / 2);
    const yaw = s.dir === '+z' ? 0 : s.dir === '-z' ? Math.PI : s.dir === '+x' ? Math.PI / 2 : -Math.PI / 2;
    const sx = Math.sin(-theta / 2);
    const cx = Math.cos(theta / 2);
    const sy = Math.sin(yaw / 2);
    const cy = Math.cos(yaw / 2);
    const q: [number, number, number, number] = [cy * sx, sy * cx, -sy * sx, cy * cx];
    const run = (s.steps - 1) * s.tread;
    const hw = s.width / 2;
    const foot: Rect = alongX
      ? { x0: Math.min(s.x, s.x + sign * run), x1: Math.max(s.x, s.x + sign * run), z0: s.z - hw, z1: s.z + hw }
      : { x0: s.x - hw, x1: s.x + hw, z0: Math.min(s.z, s.z + sign * run), z1: Math.max(s.z, s.z + sign * run) };
    out.push({
      id: newId(),
      minX: foot.x0,
      maxX: foot.x1,
      minZ: foot.z0,
      maxZ: foot.z1,
      y0: base,
      y1: base + (s.steps - 1) * s.rise,
      kind: 'stair',
      hp: 99999,
      physOnly: true,
      ramp: {
        x: alongX ? s.x + sign * cu : s.x,
        y: base + ch,
        z: alongX ? s.z : s.z + sign * cu,
        hx: hw,
        hy: thick / 2,
        hz: len / 2,
        q,
      },
    });
  }
  // A banister keeps people out of the stairwell.
  for (const w of plan.wells) {
    const base = levelBase(plan, w.level);
    for (const r of wellRails(w)) box(r.x0, r.x1, r.z0, r.z1, base, base + 1.0, 'furniture', { physOnly: true });
  }
  // Upper floors: slabs around the stairwell.
  for (let l = 1; l < plan.levels; l++) {
    const base = levelBase(plan, l);
    const full: Rect = { x0: plan.x0, x1: plan.x1, z0: plan.z0, z1: plan.z1 };
    const wells = plan.wells.filter((q) => q.level === l);
    const pieces = subtractRects(full, wells);
    for (const p of pieces) box(p.x0, p.x1, p.z0, p.z1, base - 0.3, base, 'floor', { physOnly: true });
  }
  return out;
}

/** `r` minus the given holes, as a handful of rectangles. */
export function subtractRects(r: Rect, holes: Rect[]): Rect[] {
  let pieces: Rect[] = [r];
  for (const h of holes) {
    const next: Rect[] = [];
    for (const p of pieces) {
      if (!rectOverlap(p, h)) {
        next.push(p);
        continue;
      }
      if (h.z0 > p.z0) next.push({ x0: p.x0, x1: p.x1, z0: p.z0, z1: h.z0 });
      if (h.z1 < p.z1) next.push({ x0: p.x0, x1: p.x1, z0: h.z1, z1: p.z1 });
      const z0 = Math.max(p.z0, h.z0);
      const z1 = Math.min(p.z1, h.z1);
      if (h.x0 > p.x0) next.push({ x0: p.x0, x1: h.x0, z0, z1 });
      if (h.x1 < p.x1) next.push({ x0: h.x1, x1: p.x1, z0, z1 });
    }
    pieces = next;
  }
  return pieces;
}

/** Rooms reachable from `from` through doorways, gates and breaches (for tests and for lair placement). */
export function reachable(plan: BuildingPlan, from: Room): Set<number> {
  const seen = new Set<number>([from.id]);
  const queue = [from];
  const roomAt = (x: number, z: number, level: number) => plan.rooms.find((r) => r.level === level && x >= r.x0 - 0.2 && x <= r.x1 + 0.2 && z >= r.z0 - 0.2 && z <= r.z1 + 0.2 && !(x < r.x0 - 0.01 || x > r.x1 + 0.01 || z < r.z0 - 0.01 || z > r.z1 + 0.01));
  while (queue.length) {
    const r = queue.pop()!;
    for (const w of plan.walls) {
      if (w.level !== r.level || w.ext) continue;
      for (const op of w.ops) {
        if (op.kind === 'window') continue;
        const mid = (op.a + op.b) / 2;
        const [p, q] = w.axis === 'x' ? [roomAt(mid, w.c - 0.5, r.level), roomAt(mid, w.c + 0.5, r.level)] : [roomAt(w.c - 0.5, mid, r.level), roomAt(w.c + 0.5, mid, r.level)];
        if (!p || !q) continue;
        if (p.id === r.id && !seen.has(q.id)) {
          seen.add(q.id);
          queue.push(q);
        } else if (q.id === r.id && !seen.has(p.id)) {
          seen.add(p.id);
          queue.push(p);
        }
      }
    }
  }
  return seen;
}
