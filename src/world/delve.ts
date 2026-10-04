import { Rng } from '../core/rng';
import type { ZombieKind } from '../data';
import { rollLoot, type GunStash, type LootContext, type LootSpec } from '../sim/loot';
import type { Aabb, PropKind } from './layout';
import { newAabbId } from './layout';
import type { DelveTheme } from './delveSites';
import type { DrugId } from '../sim/drugs';

/**
 * The places under the ground. A delve is a flat grid of 2 m cells (solid or floor) generated from a seed: caves
 * grow from cellular automata, the bunker, mine and metro are rooms joined by corridors. On top of the grid the
 * generator places the start and the stairs up, chests, lairs of the dead, a locked door with its key, lamps and
 * decor, and a boss at the far end. Everything is a pure function of (theme, seed, tier): the same entrance
 * always leads to the same place.
 *
 * Coordinates: the grid is centred on the origin, x and z in metres, the floor is y = 0.
 */

export const CELL = 2;

export interface ChestLoot extends Partial<Record<DrugId, number>> {
  /** Guns, rolled from the weapons table when the chest is opened. */
  guns?: GunStash;
  /** Named finds: parts with their wear, cans, tins, dressings (see `sim/loot.ts`). Never abstract Scrap or Parts. */
  items: LootSpec[];
  ammo?: number;
  medkit?: number;
  bandage?: number;
  charge?: number;
  molotov?: number;
  flare?: number;
}

/** What the dark keeps in its pockets, by theme. Rolled on its own stream so adding a drug never reshuffles a map. */
function drugLoot(theme: DelveTheme, r: Rng, hoard: boolean): Partial<Record<DrugId, number>> {
  const out: Partial<Record<DrugId, number>> = {};
  const add = (id: DrugId, p: number, lo = 1, hi = 1) => {
    if (r.chance(p)) out[id] = (out[id] ?? 0) + r.int(lo, hi);
  };
  if (hoard) {
    add('stim', 1);
    add('adrenaline', 0.8);
    add('haze', 0.6);
    add('alcohol', 0.7, 1, 2);
    if (theme === 'cave') add('ayahuasca', 0.65);
    if (theme === 'cave') add('mushrooms', 0.8, 1, 2);
    if (theme === 'metro') add('lsd', 0.6, 1, 2);
    if (theme === 'bunker') add('painkiller', 0.8, 2, 3);
    if (theme === 'mine') add('weed', 0.5, 1, 3);
    return out;
  }
  switch (theme) {
    case 'cave':
      add('mushrooms', 0.35, 1, 2);
      add('weed', 0.15);
      add('alcohol', 0.15);
      break;
    case 'mine':
      add('alcohol', 0.4, 1, 2);
      add('painkiller', 0.25);
      add('stim', 0.15);
      break;
    case 'bunker':
      add('painkiller', 0.45, 1, 2);
      add('stim', 0.25);
      add('adrenaline', 0.15);
      add('alcohol', 0.15);
      break;
    default:
      add('weed', 0.25);
      add('alcohol', 0.25);
      add('haze', 0.15);
      add('lsd', 0.08);
  }
  return out;
}

export type DelveRoomRole = 'start' | 'hall' | 'lair' | 'loot' | 'key' | 'boss';

export interface DelveRoom {
  id: number;
  /** Cell bounds, x1 and z1 exclusive. */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  role: DelveRoomRole;
  /** Centre in metres. */
  cx: number;
  cz: number;
  /** Rough radius in metres, for scattering things inside. */
  r: number;
}

export interface DelveChest {
  id: string;
  x: number;
  z: number;
  label: string;
  loot: ChestLoot;
  /** 0 to 2: how long the search takes. */
  depth: 0 | 1 | 2;
  boss?: boolean;
}

export type DelveEnemy = ZombieKind | 'gunman' | 'sniper';

export interface DelveSpawn {
  kind: DelveEnemy;
  x: number;
  z: number;
  dormant: boolean;
  cluster: number;
  boss?: boolean;
}

export interface DelveDoor {
  id: string;
  /** Centre and size in metres. */
  x: number;
  z: number;
  w: number;
  d: number;
  keyId: string;
  label: string;
}

export interface DelveKey {
  id: string;
  x: number;
  z: number;
  label: string;
}

export interface DelveLight {
  x: number;
  y: number;
  z: number;
  color: number;
  /** Candela for a real light; the visual glow does not depend on it. */
  intensity: number;
  /** 0 steady, 1 guttering. */
  flicker: number;
  /** A fitting with no bulb behind it (broken). */
  dead?: boolean;
}

export type DelveDecor = PropKind | 'stalagmite' | 'stalactite' | 'fungus' | 'timber' | 'rails' | 'pipe' | 'pillar' | 'carriage' | 'bunk' | 'table' | 'cot' | 'generator' | 'altar';

export interface DelveProp {
  kind: DelveDecor;
  x: number;
  z: number;
  yaw: number;
  scale: number;
  seed: number;
}

export interface DelveMap {
  theme: DelveTheme;
  seed: number;
  tier: number;
  w: number;
  h: number;
  /** 1 = floor, 0 = rock. Row-major: grid[j * w + i]. */
  grid: Uint8Array;
  rooms: DelveRoom[];
  start: { x: number; z: number; yaw: number };
  /** The stairs back up. */
  exit: { x: number; z: number };
  boss: { x: number; z: number };
  /** Where a service lift appears once the boss is down: a short way back to the surface. */
  lift: { x: number; z: number };
  chests: DelveChest[];
  spawns: DelveSpawn[];
  doors: DelveDoor[];
  keys: DelveKey[];
  lights: DelveLight[];
  props: DelveProp[];
  /** Ceiling height in metres. */
  ceil: number;
  /** How many chests (boss hoard included) there are to find. */
  total: number;
}

export const cellX = (m: { w: number }, i: number) => (i - m.w / 2) * CELL;
export const cellZ = (m: { h: number }, j: number) => (j - m.h / 2) * CELL;

export function cellOf(m: { w: number; h: number }, x: number, z: number): [number, number] {
  return [Math.floor(x / CELL + m.w / 2), Math.floor(z / CELL + m.h / 2)];
}

export function floorAt(m: DelveMap, x: number, z: number): boolean {
  const [i, j] = cellOf(m, x, z);
  return i >= 0 && j >= 0 && i < m.w && j < m.h && m.grid[j * m.w + i] === 1;
}

const SIZE: Record<DelveTheme, [number, number]> = { cave: [56, 56], mine: [54, 54], bunker: [46, 46], metro: [64, 44] };
const CEIL: Record<DelveTheme, number> = { cave: 5.2, mine: 3.6, bunker: 3.8, metro: 4.4 };

export function generateDelve(theme: DelveTheme, seed: number, tier: number): DelveMap {
  const [W, H] = SIZE[theme];
  const base = seed * 8191 + tier * 131 + theme.length * 17;
  let last: DelveMap | null = null;
  // Layouts that cannot be sealed properly (a corridor grazing the boss room) are thrown away and rolled again.
  for (let attempt = 0; attempt < 60; attempt++) {
    const m: DelveMap = {
      theme,
      seed,
      tier,
      w: W,
      h: H,
      grid: new Uint8Array(W * H),
      rooms: [],
      start: { x: 0, z: 0, yaw: 0 },
      exit: { x: 0, z: 0 },
      boss: { x: 0, z: 0 },
      lift: { x: 0, z: 0 },
      chests: [],
      spawns: [],
      doors: [],
      keys: [],
      lights: [],
      props: [],
      ceil: CEIL[theme],
      total: 0,
    };
    const g = new Gen(m, new Rng(base + attempt * 7919));
    last = m;
    if (theme === 'cave') g.cave();
    else if (!g.rooms()) continue;
    g.populate();
    m.total = m.chests.length;
    return m;
  }
  last!.total = last!.chests.length;
  return last!;
}

// ------------------------------------------------------------------------------------------------------------

type Pt = [number, number];

const N4: Pt[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

class Gen {
  /** Corridor links between rooms (room ids), and the cells each one carved. */
  links: { a: number; b: number; path: Pt[] }[] = [];
  private cid = 0;

  constructor(
    private m: DelveMap,
    private rng: Rng,
  ) {}

  private at(i: number, j: number) {
    const m = this.m;
    return i < 0 || j < 0 || i >= m.w || j >= m.h ? 0 : m.grid[j * m.w + i];
  }
  private set(i: number, j: number, v: number) {
    const m = this.m;
    if (i < 2 || j < 2 || i >= m.w - 2 || j >= m.h - 2) return;
    m.grid[j * m.w + i] = v;
  }
  private cx(i: number) {
    return cellX(this.m, i);
  }
  private cz(j: number) {
    return cellZ(this.m, j);
  }

  // ------------------------------------------------------------------------------------------- caves

  cave() {
    const m = this.m;
    const { w: W, h: H } = m;
    const rng = this.rng;
    let ok = false;
    for (let attempt = 0; attempt < 12 && !ok; attempt++) {
      let g = new Uint8Array(W * H);
      for (let j = 3; j < H - 3; j++) for (let i = 3; i < W - 3; i++) g[j * W + i] = rng.chance(0.52) ? 1 : 0;
      for (let it = 0; it < 5; it++) {
        const n = new Uint8Array(W * H);
        for (let j = 3; j < H - 3; j++) {
          for (let i = 3; i < W - 3; i++) {
            let c = 0;
            for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if ((di || dj) && g[(j + dj) * W + i + di]) c++;
            n[j * W + i] = g[j * W + i] ? (c >= 4 ? 1 : 0) : c >= 5 ? 1 : 0;
          }
        }
        g = n;
      }
      m.grid = g;
      // Keep only the largest cavern.
      const region = this.largestRegion();
      let count = 0;
      for (let k = 0; k < g.length; k++) {
        if (region[k]) count++;
        else g[k] = 0;
      }
      ok = count > W * H * 0.2;
    }
    this.widenThin();
    this.widenThin();
    // Start near the south edge, boss at the far end of the longest walk.
    const dist = this.bfsFrom(this.pickStart());
    let far = 0;
    let fi = 0;
    for (let k = 0; k < dist.length; k++) if (dist[k] > far) (far = dist[k]), (fi = k);
    const bi = fi % W;
    const bj = Math.floor(fi / W);
    const [sx, sz] = cellOf(m, m.start.x, m.start.z);
    this.disc(bi, bj, 5);
    this.disc(sx, sz, 3);
    this.finishAnchors(bi, bj);
    // Caverns: the roomy spots become chambers.
    const dt = this.distanceTransform();
    const picks: { i: number; j: number; d: number }[] = [];
    const cand: { i: number; j: number; d: number }[] = [];
    for (let j = 4; j < H - 4; j++) for (let i = 4; i < W - 4; i++) if (dt[j * W + i] >= 3) cand.push({ i, j, d: dt[j * W + i] + rng.next() * 0.5 });
    cand.sort((a, b) => b.d - a.d);
    for (const c of cand) {
      if (picks.length >= 7) break;
      if (picks.some((p) => Math.hypot(p.i - c.i, p.j - c.j) < 11)) continue;
      if (Math.hypot(c.i - sx, c.j - sz) < 9 || Math.hypot(c.i - bi, c.j - bj) < 10) continue;
      picks.push(c);
    }
    m.rooms.push(this.room(0, sx - 3, sz - 3, sx + 4, sz + 4, 'start'), this.room(1, bi - 5, bj - 5, bi + 6, bj + 6, 'boss'));
    picks.forEach((p, k) => {
      const r = Math.max(2, Math.floor(p.d));
      m.rooms.push(this.room(2 + k, p.i - r, p.j - r, p.i + r + 1, p.j + r + 1, k % 3 === 2 ? 'loot' : 'lair'));
    });
  }

  private pickStart(): number {
    const m = this.m;
    const { w: W, h: H } = m;
    // Nearest floor cell to the south-middle.
    let best = -1;
    let bd = Infinity;
    for (let j = 3; j < H * 0.3; j++) {
      for (let i = 3; i < W - 3; i++) {
        if (!m.grid[j * W + i]) continue;
        const d = Math.hypot(i - W / 2, j - 4);
        if (d < bd) (bd = d), (best = j * W + i);
      }
    }
    if (best < 0) best = m.grid.findIndex((v) => v === 1);
    const i = best % W;
    const j = Math.floor(best / W);
    m.start = { x: this.cx(i) + 1, z: this.cz(j) + 1, yaw: 0 };
    return best;
  }

  private largestRegion(): Uint8Array {
    const m = this.m;
    const W = m.w;
    const seen = new Uint8Array(m.grid.length);
    let best: number[] = [];
    for (let s = 0; s < m.grid.length; s++) {
      if (!m.grid[s] || seen[s]) continue;
      const stack = [s];
      const cur: number[] = [];
      seen[s] = 1;
      while (stack.length) {
        const k = stack.pop()!;
        cur.push(k);
        const i = k % W;
        const j = Math.floor(k / W);
        for (const [di, dj] of N4) {
          const ni = i + di;
          const nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= W || nj >= m.h) continue;
          const nk = nj * W + ni;
          if (m.grid[nk] && !seen[nk]) {
            seen[nk] = 1;
            stack.push(nk);
          }
        }
      }
      if (cur.length > best.length) best = cur;
    }
    const out = new Uint8Array(m.grid.length);
    for (const k of best) out[k] = 1;
    return out;
  }

  /** Caves have no passage thinner than two cells (the camera and a pair of people need the room). */
  private widenThin() {
    const m = this.m;
    const W = m.w;
    const add: number[] = [];
    for (let j = 3; j < m.h - 3; j++) {
      for (let i = 3; i < W - 3; i++) {
        if (!m.grid[j * W + i]) continue;
        if (!this.at(i - 1, j) && !this.at(i + 1, j) && (this.at(i, j - 1) || this.at(i, j + 1))) add.push(j * W + i + 1);
        if (!this.at(i, j - 1) && !this.at(i, j + 1) && (this.at(i - 1, j) || this.at(i + 1, j))) add.push((j + 1) * W + i);
      }
    }
    for (const k of add) if (k % W < W - 3 && Math.floor(k / W) < m.h - 3) m.grid[k] = 1;
  }

  private disc(ci: number, cj: number, r: number) {
    for (let j = cj - r; j <= cj + r; j++) for (let i = ci - r; i <= ci + r; i++) if (Math.hypot(i - ci, j - cj) <= r + 0.3) this.set(i, j, 1);
  }

  private bfsFrom(k0: number): Int32Array {
    const m = this.m;
    const W = m.w;
    const d = new Int32Array(m.grid.length).fill(-1);
    d[k0] = 0;
    const q = [k0];
    for (let h = 0; h < q.length; h++) {
      const k = q[h];
      const i = k % W;
      const j = Math.floor(k / W);
      for (const [di, dj] of N4) {
        const nk = (j + dj) * W + i + di;
        if (i + di < 0 || i + di >= W || j + dj < 0 || j + dj >= m.h) continue;
        if (m.grid[nk] && d[nk] < 0) {
          d[nk] = d[k] + 1;
          q.push(nk);
        }
      }
    }
    return d;
  }

  /** Distance (in cells) from each floor cell to the nearest rock, by two chamfer passes. */
  private distanceTransform(): Float32Array {
    const m = this.m;
    const W = m.w;
    const H = m.h;
    const d = new Float32Array(W * H);
    for (let k = 0; k < d.length; k++) d[k] = m.grid[k] ? 1e6 : 0;
    for (let j = 1; j < H - 1; j++) for (let i = 1; i < W - 1; i++) {
      const k = j * W + i;
      d[k] = Math.min(d[k], d[k - 1] + 1, d[k - W] + 1, d[k - W - 1] + 1.4, d[k - W + 1] + 1.4);
    }
    for (let j = H - 2; j > 0; j--) for (let i = W - 2; i > 0; i--) {
      const k = j * W + i;
      d[k] = Math.min(d[k], d[k + 1] + 1, d[k + W] + 1, d[k + W + 1] + 1.4, d[k + W - 1] + 1.4);
    }
    return d;
  }

  /** The way up: a few metres from where the party arrives, on clear floor, never on top of them. */
  private pickExit() {
    const m = this.m;
    const spots: Pt[] = [[-4.2, -1.8], [4.2, -1.8], [-4.2, 1.6], [4.2, 1.6], [0, -4.4], [0, 4.4], [-6, 0], [6, 0], [-3, -3], [3, -3]];
    for (const [dx, dz] of spots) {
      if (this.clear(m.start.x + dx, m.start.z + dz, 1.6)) return { x: m.start.x + dx, z: m.start.z + dz };
    }
    return { x: m.start.x, z: m.start.z - 1.5 };
  }

  private finishAnchors(bi: number, bj: number) {
    const m = this.m;
    m.boss = { x: this.cx(bi) + 1, z: this.cz(bj) + 1 };
    m.exit = this.pickExit();
    // The lift rises in the boss chamber, on its far side from the entrance.
    m.lift = { x: m.boss.x, z: m.boss.z + 4 };
  }

  private room(id: number, x0: number, z0: number, x1: number, z1: number, role: DelveRoomRole): DelveRoom {
    const cx = this.cx((x0 + x1) / 2);
    const cz = this.cz((z0 + z1) / 2);
    return { id, x0, z0, x1, z1, role, cx, cz, r: (Math.min(x1 - x0, z1 - z0) * CELL) / 2 };
  }

  // ------------------------------------------------------------------------------------------- rooms

  rooms(): boolean {
    const m = this.m;
    const rng = this.rng;
    const { w: W, h: H } = m;
    const spec = { bunker: { n: 9, lo: 5, hi: 9 }, mine: { n: 10, lo: 4, hi: 7 }, metro: { n: 8, lo: 5, hi: 8 }, cave: { n: 0, lo: 0, hi: 0 } }[m.theme];
    const rooms: DelveRoom[] = [];
    const tryPlace = (w: number, h: number, role: DelveRoomRole) => {
      for (let t = 0; t < 80; t++) {
        const x0 = rng.int(3, W - 3 - w);
        const z0 = rng.int(3, H - 3 - h);
        if (rooms.some((r) => x0 < r.x1 + 4 && x0 + w > r.x0 - 4 && z0 < r.z1 + 4 && z0 + h > r.z0 - 4)) continue;
        const r = this.room(rooms.length, x0, z0, x0 + w, z0 + h, role);
        rooms.push(r);
        return r;
      }
      return null;
    };
    // The metro is built around one long platform hall.
    if (m.theme === 'metro') {
      const hallW = 32;
      const hallH = 7;
      const r = this.room(0, Math.round((W - hallW) / 2), Math.round(H / 2 - hallH / 2), Math.round((W + hallW) / 2), Math.round(H / 2 + hallH / 2), 'hall');
      rooms.push(r);
    }
    while (rooms.length < spec.n) {
      const w = rng.int(spec.lo, spec.hi);
      const h = rng.int(spec.lo, spec.hi);
      if (!tryPlace(w, h, 'hall')) break;
    }
    // Carve rooms, then join them: a chain by position, and a couple of loops.
    for (const r of rooms) for (let j = r.z0; j < r.z1; j++) for (let i = r.x0; i < r.x1; i++) this.set(i, j, 1);
    const order = [...rooms].sort((a, b) => a.cx + a.cz * 0.35 - (b.cx + b.cz * 0.35));
    for (let k = 0; k < order.length - 1; k++) this.link(order[k], order[k + 1]);
    for (let k = 0; k < 2; k++) {
      const a = rng.pick(rooms);
      const b = rng.pick(rooms);
      if (a !== b && !this.links.some((l) => (l.a === a.id && l.b === b.id) || (l.a === b.id && l.b === a.id))) this.link(a, b);
    }
    m.rooms = rooms;
    // Start in the room nearest the south edge; the boss is the farthest room by corridor walk.
    const start = [...rooms].sort((a, b) => a.cz - b.cz)[0];
    start.role = 'start';
    const depth = this.roomDepths(start.id);
    let boss = rooms[0];
    for (const r of rooms) if (r !== start && (depth.get(r.id) ?? 0) > (depth.get(boss.id) ?? 0)) boss = r;
    if (boss === start) boss = rooms.find((r) => r !== start) ?? start;
    boss.role = 'boss';
    m.start = { x: start.cx, z: start.cz - Math.min(start.r - 2, 3), yaw: 0 };
    m.exit = this.pickExit();
    m.boss = { x: boss.cx, z: boss.cz };
    m.lift = { x: boss.cx + Math.min(boss.r - 2, 3), z: boss.cz + Math.min(boss.r - 2, 3) };
    // The key lies in one of the lairs that can be reached without passing through the boss's door.
    const reach = new Set<number>([start.id]);
    const q = [start.id];
    for (let h = 0; h < q.length; h++) {
      if (q[h] === boss.id) continue;
      for (const l of this.links) {
        const other = l.a === q[h] ? l.b : l.b === q[h] ? l.a : -1;
        if (other >= 0 && !reach.has(other)) {
          reach.add(other);
          q.push(other);
        }
      }
    }
    const rest = rooms.filter((r) => r !== start && r !== boss && reach.has(r.id));
    rng.shuffle(rest);
    for (const r of rooms) if (r !== start && r !== boss && !reach.has(r.id)) r.role = 'loot';
    if (rest.length) rest[0].role = 'key';
    rest.slice(1).forEach((r, k) => (r.role = k % 3 === 2 ? 'loot' : 'lair'));
    // The boss room must be sealable: one or two clean openings, each no wider than a corridor.
    const ops = this.openings(boss);
    return ops.length >= 1 && ops.length <= 2 && ops.every((o) => o.b - o.a + 1 <= 3) && rest.length >= 3;
  }

  /** Carve an L-shaped corridor, two cells wide, between the centres of two rooms. */
  private link(a: DelveRoom, b: DelveRoom) {
    const rng = this.rng;
    const ai = Math.round((a.x0 + a.x1) / 2);
    const aj = Math.round((a.z0 + a.z1) / 2);
    const bi = Math.round((b.x0 + b.x1) / 2);
    const bj = Math.round((b.z0 + b.z1) / 2);
    const horizFirst = rng.chance(0.5);
    const path: Pt[] = [];
    const run = (i0: number, j0: number, i1: number, j1: number) => {
      const di = Math.sign(i1 - i0);
      const dj = Math.sign(j1 - j0);
      let i = i0;
      let j = j0;
      for (let n = 0; n < 200; n++) {
        path.push([i, j]);
        this.set(i, j, 1);
        this.set(i + (dj === 0 ? 0 : 1), j + (di === 0 ? 0 : 1), 1);
        if (i === i1 && j === j1) break;
        if (i !== i1) i += di;
        else if (j !== j1) j += dj;
      }
    };
    if (horizFirst) {
      run(ai, aj, bi, aj);
      run(bi, aj, bi, bj);
    } else {
      run(ai, aj, ai, bj);
      run(ai, bj, bi, bj);
    }
    this.links.push({ a: a.id, b: b.id, path });
  }

  private roomDepths(from: number): Map<number, number> {
    const depth = new Map<number, number>([[from, 0]]);
    const q = [from];
    for (let h = 0; h < q.length; h++) {
      const a = q[h];
      for (const l of this.links) {
        const other = l.a === a ? l.b : l.b === a ? l.a : -1;
        if (other < 0 || depth.has(other)) continue;
        depth.set(other, depth.get(a)! + l.path.length);
        q.push(other);
      }
    }
    return depth;
  }

  // ------------------------------------------------------------------------------------------- contents

  populate() {
    const m = this.m;
    const rng = this.rng;
    const tier = m.tier;
    const theme = m.theme;
    let cluster = 100;
    const spawn = (kind: DelveEnemy, x: number, z: number, dormant = true, boss = false) => m.spawns.push({ kind, x, z, dormant, cluster, boss });
    const scatter = (r: DelveRoom, n: number, fn: (x: number, z: number) => void, inset = 1.6) => {
      for (let i = 0; i < n * 6 && n > 0; i++) {
        const x = r.cx + (rng.next() - 0.5) * (r.x1 - r.x0) * CELL * (theme === 'cave' ? 0.9 : 0.8);
        const z = r.cz + (rng.next() - 0.5) * (r.z1 - r.z0) * CELL * (theme === 'cave' ? 0.9 : 0.8);
        if (!this.clear(x, z, inset)) continue;
        fn(x, z);
        n--;
      }
    };
    const kinds: Record<DelveTheme, ZombieKind[]> = {
      cave: tier >= 2 ? ['walker', 'walker', 'runner', 'stalker'] : ['walker', 'walker', 'runner'],
      mine: ['walker', 'walker', 'runner', 'walker'],
      bunker: ['walker', 'runner', 'runner'],
      metro: tier >= 2 ? ['walker', 'runner', 'runner', 'screamer'] : ['walker', 'walker', 'runner'],
    };
    const lairSize = 3 + tier * 2;
    // Rooms by role.
    for (const r of m.rooms) {
      cluster++;
      if (r.role === 'start') continue;
      if (r.role === 'lair' || r.role === 'key') {
        const n = r.role === 'key' ? lairSize + 1 : lairSize;
        scatter(r, n, (x, z) => spawn(rng.pick(kinds[theme]), x, z));
        if (tier >= 2 && rng.chance(0.4)) scatter(r, 1, (x, z) => spawn('brute', x, z));
        if ((theme === 'bunker' || theme === 'mine') && tier >= 2) scatter(r, 1 + (tier >= 3 ? 1 : 0), (x, z) => spawn('gunman', x, z, false));
      }
      if (r.role === 'boss') {
        spawn('brute', m.boss.x, m.boss.z, true, true);
        if (tier >= 3) spawn(theme === 'cave' ? 'bloater' : 'brute', m.boss.x + 2.5, m.boss.z + 1.5, true, true);
        scatter(r, 4 + tier * 2, (x, z) => spawn(rng.pick(kinds[theme]), x, z));
        if (theme === 'metro') spawn('screamer', m.boss.x - 3, m.boss.z, true);
      }
      if (r.role === 'loot') scatter(r, 1 + tier, (x, z) => spawn(rng.pick(kinds[theme]), x, z));
    }
    this.chests();
    this.decor();
    this.lighting();
  }

  /** Is the point a metre or more from any rock? */
  clear(x: number, z: number, r = 1): boolean {
    const m = this.m;
    for (let dz = -r; dz <= r; dz += 0.8) for (let dx = -r; dx <= r; dx += 0.8) if (!floorAt(m, x + dx, z + dz)) return false;
    return true;
  }

  private chests() {
    const m = this.m;
    const rng = this.rng;
    const tier = m.tier;
    const theme = m.theme;
    const label: Record<DelveTheme, string[]> = {
      cave: ['a smuggler’s cache', 'a nest of bones and gear', 'a rotted pack', 'a hollow in the rock'],
      mine: ['a powder crate', 'the paymaster’s box', 'a tool locker', 'an ore chest'],
      bunker: ['an ammunition locker', 'a medical cabinet', 'a supply crate', 'a sealed footlocker'],
      metro: ['a ticket-office safe', 'a luggage cage', 'a vending machine', 'a maintenance locker'],
    };
    const drng = new Rng(m.seed * 40503 + tier * 977 + 11);
    const loot = (): ChestLoot => {
      const l: ChestLoot = { ...baseLoot(), ...drugLoot(theme, drng, false) };
      // Armouries and caches hold the odd gun.
      if ((theme === 'bunker' && rng.chance(0.35)) || (theme !== 'bunker' && rng.chance(0.12))) l.guns = { context: theme === 'bunker' ? 'bunker' : 'cache', seed: rng.int(1, 1e9), depth: 1 };
      return l;
    };
    // What each kind of place keeps: a mine its spares and fuel, a bunker its ammunition and dressings, a cave a smuggler's cache.
    const ctx: LootContext = ({ cave: 'delve_cave', mine: 'delve_mine', bunker: 'delve_bunker', metro: 'delve_metro' } as const)[theme];
    const progress = Math.min(1, 0.15 + tier * 0.22);
    const baseLoot = (): ChestLoot => {
      const items = rollLoot(ctx, rng.int(1, 1e9), 1, { progress });
      switch (theme) {
        case 'cave':
          return { items, ammo: rng.chance(0.5) ? 10 : 0 };
        case 'mine':
          return { items, charge: rng.chance(0.3) ? 1 : 0 };
        case 'bunker':
          return { items, ammo: rng.int(12, 24) + tier * 6, medkit: rng.chance(0.35) ? 1 : 0, bandage: rng.chance(0.6) ? rng.int(1, 2) : 0, flare: rng.chance(0.4) ? 1 : 0 };
        default:
          return { items, molotov: rng.chance(0.3) ? 1 : 0, ammo: rng.chance(0.4) ? 12 : 0 };
      }
    };
    let n = 0;
    for (const r of m.rooms) {
      if (r.role === 'start' || r.role === 'boss') continue;
      const count = r.role === 'loot' ? 2 : r.role === 'key' ? 1 : 1;
      for (let c = 0; c < count; c++) {
        for (let t = 0; t < 40; t++) {
          const x = r.cx + (rng.next() - 0.5) * (r.x1 - r.x0 - 1) * CELL;
          const z = r.cz + (rng.next() - 0.5) * (r.z1 - r.z0 - 1) * CELL;
          if (!this.clear(x, z, 1.2)) continue;
          m.chests.push({ id: `c${n++}`, x, z, label: rng.pick(label[theme]), loot: loot(), depth: r.role === 'loot' ? 1 : 0 });
          break;
        }
      }
    }
    // The hoard behind the boss.
    const hoard: ChestLoot = { guns: { context: theme === 'bunker' || theme === 'metro' ? 'bunker' : 'cache', seed: m.seed * 31 + 3, depth: 2 }, items: [...rollLoot(ctx, m.seed * 977 + 5, 2, { progress: Math.min(1, progress + 0.3) }), ...rollLoot(ctx, m.seed * 977 + 6, 2, { progress: Math.min(1, progress + 0.3) })], ammo: 30 + tier * 10, medkit: 1 + (tier > 1 ? 1 : 0), bandage: 2 + tier, charge: 1, ...drugLoot(theme, drng, true) };
    const br = m.rooms.find((r) => r.role === 'boss');
    if (br) {
      let hx = m.boss.x + (br.x1 - br.x0) * CELL * 0.28;
      let hz = m.boss.z - (br.z1 - br.z0) * CELL * 0.1;
      if (!this.clear(hx, hz, 1)) [hx, hz] = [m.boss.x - 3, m.boss.z + 2];
      m.chests.push({ id: `c${n++}`, x: hx, z: hz, label: { cave: 'the hoard', mine: 'the strongroom', bunker: 'the armoury', metro: 'the vault' }[theme], loot: hoard, depth: 2, boss: true });
    }
    // A key for the locked door, in the key room (or in a far lair for caves, which have no doors).
    if (theme !== 'cave') {
      const kr = m.rooms.find((r) => r.role === 'key') ?? m.rooms.find((r) => r.role === 'lair');
      if (kr) {
        for (let t = 0; t < 40; t++) {
          const x = kr.cx + (rng.next() - 0.5) * (kr.x1 - kr.x0 - 1) * CELL;
          const z = kr.cz + (rng.next() - 0.5) * (kr.z1 - kr.z0 - 1) * CELL;
          if (!this.clear(x, z, 1)) continue;
          m.keys.push({ id: 'k0', x, z, label: { bunker: 'a security keycard', mine: 'a rusted door key', metro: 'a station master key', cave: '' }[theme] });
          break;
        }
      }
      this.placeDoor();
    }
  }

  /** Gaps in the boss room's walls: runs of floor just outside its rectangle that touch floor inside it. */
  openings(r: DelveRoom): { side: 'w' | 'e' | 's' | 'n'; a: number; b: number }[] {
    const out: { side: 'w' | 'e' | 's' | 'n'; a: number; b: number }[] = [];
    const scan = (side: 'w' | 'e' | 's' | 'n', from: number, to: number, ok: (k: number) => boolean) => {
      let a = -1;
      for (let k = from; k <= to; k++) {
        const open = k < to && ok(k);
        if (open && a < 0) a = k;
        else if (!open && a >= 0) {
          out.push({ side, a, b: k - 1 });
          a = -1;
        }
      }
    };
    scan('w', r.z0, r.z1, (j) => !!this.at(r.x0 - 1, j) && !!this.at(r.x0, j));
    scan('e', r.z0, r.z1, (j) => !!this.at(r.x1, j) && !!this.at(r.x1 - 1, j));
    scan('s', r.x0, r.x1, (i) => !!this.at(i, r.z0 - 1) && !!this.at(i, r.z0));
    scan('n', r.x0, r.x1, (i) => !!this.at(i, r.z1) && !!this.at(i, r.z1 - 1));
    return out;
  }

  /** Lock every opening into the boss room; the one key opens them all. */
  private placeDoor() {
    const m = this.m;
    const boss = m.rooms.find((r) => r.role === 'boss');
    const key = m.keys[0];
    if (!boss || !key) return;
    const label = { bunker: 'Security door', mine: 'Barred gate', metro: 'Staff gate', cave: '' }[m.theme];
    this.openings(boss).forEach((o, n) => {
      const t = 0.6;
      if (o.side === 'w' || o.side === 'e') {
        const x = this.cx(o.side === 'w' ? boss.x0 : boss.x1);
        m.doors.push({ id: `door${n}`, x, z: (this.cz(o.a) + this.cz(o.b + 1)) / 2, w: t, d: (o.b - o.a + 1) * CELL, keyId: key.id, label });
      } else {
        const z = this.cz(o.side === 's' ? boss.z0 : boss.z1);
        m.doors.push({ id: `door${n}`, x: (this.cx(o.a) + this.cx(o.b + 1)) / 2, z, w: (o.b - o.a + 1) * CELL, d: t, keyId: key.id, label });
      }
    });
  }

  private decor() {
    const m = this.m;
    const rng = this.rng;
    const theme = m.theme;
    const prop = (kind: DelveDecor, x: number, z: number, scale = 1, yaw = rng.range(0, 6.28)) => m.props.push({ kind, x, z, yaw, scale, seed: rng.int(0, 9999) });
    const inRoom = (r: DelveRoom, n: number, kinds: DelveDecor[], inset = 1.4) => {
      for (let i = 0; i < n * 5 && n > 0; i++) {
        const x = r.cx + (rng.next() - 0.5) * (r.x1 - r.x0) * CELL * 0.86;
        const z = r.cz + (rng.next() - 0.5) * (r.z1 - r.z0) * CELL * 0.86;
        if (!this.clear(x, z, inset)) continue;
        prop(rng.pick(kinds), x, z, rng.range(0.85, 1.25));
        n--;
      }
    };
    for (const r of m.rooms) {
      switch (theme) {
        case 'cave':
          inRoom(r, 4 + Math.floor(r.r / 3), ['stalagmite', 'stalagmite', 'rock', 'bones', 'fungus', 'rubble'], 1.4);
          break;
        case 'mine':
          inRoom(r, 3, ['crateStack', 'barrel', 'rubble', 'bones', 'tires'], 1.4);
          if (r.role === 'lair' || r.role === 'key') inRoom(r, 1, ['rails'], 1);
          break;
        case 'bunker':
          inRoom(r, r.role === 'start' ? 1 : 3, r.role === 'lair' ? ['bunk', 'table', 'cot', 'locker', 'shelf'] : ['shelf', 'locker', 'crateStack', 'barrel', 'generator'], 1.6);
          break;
        default:
          inRoom(r, r.role === 'hall' ? 0 : 3, ['crateStack', 'barrel', 'dumpster', 'rubble', 'bones'], 1.6);
      }
    }
    if (theme === 'metro') {
      // The platform hall: two stalled carriages on the tracks, columns down the middle.
      const hall = m.rooms[0];
      if (hall && hall.role === 'hall') {
        prop('carriage', hall.cx - 9, hall.cz + 1.2, 1, 0);
        prop('carriage', hall.cx + 8, hall.cz + 1.2, 1, 0);
        for (let x = hall.cx - 13; x <= hall.cx + 13; x += 6.5) prop('pillar', x, hall.cz - 2.2, 1);
      }
    }
    // The boss's lair gets an altar-like centrepiece.
    const br = m.rooms.find((r) => r.role === 'boss');
    if (br) {
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + 0.4;
        const x = br.cx + Math.cos(a) * br.r * 0.62;
        const z = br.cz + Math.sin(a) * br.r * 0.62;
        if (this.clear(x, z, 1)) prop(theme === 'cave' ? 'stalagmite' : theme === 'metro' ? 'pillar' : 'crateStack', x, z, 1.3);
      }
      prop('bones', br.cx + 1.5, br.cz - 1, 1.4);
    }
    // Structural dressing along corridors: timber sets in mines, pipes in bunkers, rails in the metro.
    if (theme === 'mine') {
      for (const l of this.links) for (let k = 4; k < l.path.length - 3; k += 4) {
        const [i, j] = l.path[k];
        prop('timber', this.cx(i) + 1, this.cz(j) + 1, 1, 0);
      }
    }
  }

  private lighting() {
    const m = this.m;
    const rng = this.rng;
    const theme = m.theme;
    const push = (x: number, y: number, z: number, color: number, intensity: number, flicker = 0, dead = false) => m.lights.push({ x, y, z, color, intensity, flicker, dead });
    const warm = 0xffc27a;
    const cold = 0xcfe6ff;
    // Rooms: lamps near their centres (cave: glowing fungus and a few torches).
    for (const r of m.rooms) {
      const n = r.role === 'start' ? 2 : 1 + (r.r > 6 ? 1 : 0) + (r.role === 'boss' ? 2 : 0);
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + rng.range(0, 1);
        const x = r.cx + Math.cos(a) * r.r * 0.5;
        const z = r.cz + Math.sin(a) * r.r * 0.5;
        if (!this.clear(x, z, 0.8)) continue;
        if (theme === 'cave') push(x, r.role === 'boss' ? 1.2 : 0.9, z, r.role === 'boss' ? 0xff7a3a : rng.chance(0.5) ? 0x66ffc8 : 0x7ac8ff, r.role === 'boss' ? 160 : 70, r.role === 'boss' ? 0.8 : 0.25);
        else if (theme === 'bunker') push(x, m.ceil - 0.3, z, rng.chance(0.25) ? 0xff6a4a : cold, 120, rng.chance(0.3) ? 0.9 : 0.1, rng.chance(0.15));
        else if (theme === 'mine') push(x, m.ceil - 0.5, z, warm, 110, 0.5, rng.chance(0.2));
        else push(x, m.ceil - 0.4, z, rng.chance(0.4) ? 0xd8f0ff : cold, 130, rng.chance(0.3) ? 0.8 : 0.05, rng.chance(0.2));
      }
    }
    // Corridors: a lamp every few cells.
    for (const l of this.links) {
      for (let k = 5; k < l.path.length - 3; k += 7) {
        const [i, j] = l.path[k];
        push(this.cx(i) + 1, m.ceil - 0.4, this.cz(j) + 1, theme === 'mine' ? warm : cold, 90, 0.4, rng.chance(0.25));
      }
    }
    // The way in is always lit, so people know which way is out.
    push(m.exit.x, 2.4, m.exit.z + 0.8, 0xffe2a8, 140, 0.1);
    if (theme === 'cave') for (let k = 0; k < 16; k++) {
      const r = rng.pick(m.rooms);
      const x = r.cx + rng.range(-r.r, r.r) * 0.8;
      const z = r.cz + rng.range(-r.r, r.r) * 0.8;
      if (this.clear(x, z, 0.8)) push(x, 0.5, z, rng.chance(0.5) ? 0x66ffc8 : 0x9a7aff, 40, 0.3);
    }
  }
}

// ------------------------------------------------------------------------------------------------------------

/**
 * Colliders for the rock: the cells that touch the floor, merged into boxes (runs along x, then stacked in z).
 * Everything deeper inside the rock is unreachable, so it needs no collider.
 */
export function wallColliders(m: DelveMap, height: number): Aabb[] {
  const { w: W, h: H } = m;
  const near = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      if (m.grid[j * W + i]) continue;
      let touch = i === 0 || j === 0 || i === W - 1 || j === H - 1;
      for (let dj = -1; dj <= 1 && !touch; dj++) for (let di = -1; di <= 1; di++) if (i + di >= 0 && j + dj >= 0 && i + di < W && j + dj < H && m.grid[(j + dj) * W + i + di]) touch = true;
      if (touch) near[j * W + i] = 1;
    }
  }
  // Runs along x.
  type Run = { i0: number; i1: number; j0: number; j1: number };
  const open: Run[] = [];
  const out: Aabb[] = [];
  const flush = (r: Run) =>
    out.push({ id: newAabbId(), minX: cellX(m, r.i0), maxX: cellX(m, r.i1), minZ: cellZ(m, r.j0), maxZ: cellZ(m, r.j1), y0: -1, y1: height, kind: 'wall', hp: 99999 });
  let prev: Run[] = [];
  for (let j = 0; j < H; j++) {
    const row: Run[] = [];
    let i = 0;
    while (i < W) {
      if (!near[j * W + i]) {
        i++;
        continue;
      }
      const i0 = i;
      while (i < W && near[j * W + i]) i++;
      row.push({ i0, i1: i, j0: j, j1: j + 1 });
    }
    const next: Run[] = [];
    for (const r of row) {
      const p = prev.find((q) => q.i0 === r.i0 && q.i1 === r.i1);
      if (p) {
        p.j1 = r.j1;
        next.push(p);
        prev.splice(prev.indexOf(p), 1);
      } else next.push(r);
    }
    for (const q of prev) flush(q);
    prev = next;
  }
  for (const q of prev) flush(q);
  void open;
  return out;
}
