import { clamp, clamp01 } from '../core/math';
import type { Zone } from './ballistics';

/**
 * The flesh engine, as pure rules: what a blow does under the skin of one of the dead. `ballistics.ts` still decides how
 * much damage lands and whether a limb comes off; this decides what that looks like on the body and what it breaks on the
 * way: a round leaves a small hole going in and, fast enough, a crater coming out; a blade opens a gash along the line it
 * travelled and a heavy one chops to the bone; a club bruises, dents a skull and snaps a shin. Enough of it to the belly
 * and the gut comes out; a clean enough cut through the waist leaves a top half that keeps crawling.
 *
 * Everything is in the rest pose of the zombie mesh (`render/zombieRender.ts` `J`): metres at scale 1, feet at the origin,
 * facing +z, +x the body's own left. The renderer reads the same numbers, so a wound placed here lands on the drawn skin.
 * No engine imports.
 */

// ------------------------------------------------------------------ what each weapon does

export type Mech = 'pierce' | 'cut' | 'chop' | 'crush' | 'blast';

export interface Injury {
  mech: Mech;
  /** Radius (m) of the wound it opens on the skin: the hole a round makes going in, the half-width of a cut, a bruise. */
  hole: number;
  /** Exit wound as a multiple of the entry, for a round that comes out the far side (0: it never makes one). */
  exit: number;
  /** A blow this hard (damage over hit points) blows the far side out even when the round stops in the body: the cavity. */
  exitAt: number;
  /** How deep it goes, 0 a mark in the skin to 1 through to the organs. */
  depth: number;
  /** Bone damage per unit of power (damage over the body's hit points): 1 breaks a bone, 2 drives it out through the skin. */
  bone: number;
  /** Length of the cut a blade opens (m). */
  slice: number;
  /** Which way a blade travels across the body: 0 straight down, 1 level. */
  slant: number;
  /** How readily a blow to the belly opens it, per unit of power: a total of 1 and the gut comes out. */
  spill: number;
  /** How readily a blade goes right through a body: power times this past `BISECT` cuts it in two at the waist. */
  sever: number;
}

const round = (hole: number, exit: number, exitAt: number, depth: number, bone: number, spill: number): Injury =>
  ({ mech: 'pierce', hole, exit, exitAt, depth, bone, slice: 0, slant: 0, spill, sever: 0 });
const blade = (mech: 'cut' | 'chop', hole: number, slice: number, slant: number, depth: number, bone: number, spill: number, sever: number): Injury =>
  ({ mech, hole, exit: 0, exitAt: 99, depth, bone, slice, slant, spill, sever });
const club = (hole: number, depth: number, bone: number, spill: number): Injury =>
  ({ mech: 'crush', hole, exit: 0, exitAt: 99, depth, bone, slice: 0, slant: 0, spill, sever: 0 });

/**
 * By round (`AmmoKind`) and by hand weapon (`MeleeKind`), plus the blast of an explosion and the nose of a car. Rounds are
 * small going in; what comes out the back is what a horror film shows. Pellets each make a small hole, and a close blast
 * of them runs together into one crater (`merge`).
 */
export const INJURY: Record<string, Injury> = {
  pistol: round(0.017, 1.8, 99, 0.6, 0.3, 0.12),
  raider: round(0.017, 1.8, 99, 0.6, 0.3, 0.12),
  smg: round(0.016, 1.7, 99, 0.55, 0.25, 0.1),
  magnum: round(0.021, 2.7, 0.9, 0.72, 0.7, 0.35),
  pellet: round(0.013, 0, 99, 0.5, 0.45, 0.55),
  lever: round(0.019, 2.8, 0.85, 0.75, 0.8, 0.4),
  carbine: round(0.016, 3.2, 0.7, 0.8, 0.9, 0.5),
  battle: round(0.018, 3.8, 0.7, 0.85, 1.2, 0.65),
  rifle: round(0.018, 4, 0.7, 0.85, 1.3, 0.7),
  sniper: round(0.019, 4.6, 0.6, 0.9, 1.4, 0.8),
  turret: round(0.021, 4.4, 0.6, 0.9, 1.4, 0.9),
  bolt: round(0.013, 1.4, 99, 0.8, 0.4, 0.2),
  arrow: round(0.011, 0, 99, 0.7, 0.2, 0.1),
  fist: club(0.05, 0.02, 0.45, 0),
  bat: club(0.065, 0.06, 1.0, 0.05),
  pipe: club(0.055, 0.1, 1.05, 0.05),
  sledge: club(0.09, 0.25, 1.3, 0.25),
  knife: blade('cut', 0.009, 0.1, 0.25, 0.42, 0.05, 0.8, 0.3),
  machete: blade('chop', 0.013, 0.17, 0.3, 0.72, 0.5, 0.95, 0.9),
  axe: blade('chop', 0.019, 0.13, 0.1, 0.92, 0.9, 0.85, 1.1),
  katana: blade('cut', 0.008, 0.26, 0.78, 0.82, 0.4, 1.1, 1.3),
  blast: { mech: 'blast', hole: 0.06, exit: 0, exitAt: 99, depth: 0.75, bone: 1.1, slice: 0, slant: 0, spill: 1.1, sever: 0 },
  vehicle: club(0.12, 0.3, 1.3, 0.45),
};

export const injuryOf = (key: string): Injury => INJURY[key] ?? INJURY.pistol;

/** A blade through the waist with power times `sever` past this cuts the body in two. */
export const BISECT = 1.6;
/** Bone damage that breaks a bone, and that drives the broken end out through the skin. */
export const BREAK = 1;
export const COMPOUND = 2;
/** Skull damage that caves the skull in (the brain with it: it kills), and that bursts the head. */
export const SKULL_CRUSH = 0.9;
export const SKULL_BURST = 2.3;

// ------------------------------------------------------------------ the body, in the rest pose

export type Chain = 'armL' | 'armR' | 'legL' | 'legR' | 'neck' | 'waist';
/** Order of `FleshState.cut`, and of the cut heights the renderer reads. */
export const CHAINS: Chain[] = ['armL', 'armR', 'legL', 'legR', 'neck', 'waist'];
export type LimbChain = 'armL' | 'armR' | 'legL' | 'legR';

type V3 = [number, number, number];

/** Each limb's axis, root first: shoulder, elbow, wrist, fingertips; hip, knee, ankle, sole. */
export const AXIS: Record<LimbChain, V3[]> = {
  armL: [[0.21, 1.42, -0.01], [0.23, 1.14, 0], [0.23, 0.9, 0.02], [0.23, 0.77, 0.05]],
  armR: [[-0.21, 1.42, -0.01], [-0.23, 1.14, 0], [-0.23, 0.9, 0.02], [-0.23, 0.77, 0.05]],
  legL: [[0.1, 0.94, 0], [0.11, 0.52, 0.02], [0.11, 0.12, 0.01], [0.11, 0, 0.04]],
  legR: [[-0.1, 0.94, 0], [-0.11, 0.52, 0.02], [-0.11, 0.12, 0.01], [-0.11, 0, 0.04]],
};
/** Skin radius at each axis point (the sleeve and trousers sit a little outside it). */
const RADII: Record<'arm' | 'leg', number[]> = { arm: [0.05, 0.04, 0.03, 0.03], leg: [0.078, 0.057, 0.045, 0.05] };
/** How high a limb can be cut: below the shoulder or hip joint, above the hand or foot. */
export const CUT_RANGE: Record<Chain, [number, number]> = {
  armL: [0.88, 1.36], armR: [0.88, 1.36], legL: [0.16, 0.86], legR: [0.16, 0.86], neck: [1.5, 1.76], waist: [0.98, 1.22],
};
/** Where the neck is cut to take a head off, where a burst skull leaves only the jaw, and a body cut in two. */
export const NECK_CUT = 1.53;
export const BURST_CUT = 1.655;

const isArm = (c: LimbChain) => c === 'armL' || c === 'armR';

/** The axis of a limb at a height: x and z of the line through its joints, and the radius of the skin there. */
export function limbAt(c: LimbChain, y: number): { x: number; z: number; r: number } {
  const ax = AXIS[c];
  const rr = RADII[isArm(c) ? 'arm' : 'leg'];
  for (let i = 0; i < ax.length - 1; i++) {
    const a = ax[i];
    const b = ax[i + 1];
    if (y >= b[1] || i === ax.length - 2) {
      const t = clamp01((a[1] - y) / Math.max(1e-6, a[1] - b[1]));
      return { x: a[0] + (b[0] - a[0]) * t, z: a[2] + (b[2] - a[2]) * t, r: rr[i] + (rr[i + 1] - rr[i]) * t };
    }
  }
  return { x: ax[0][0], z: ax[0][2], r: rr[0] };
}

/** Torso cross-sections (height, half width, half depth, centre z), from the pelvis and chest profiles of the mesh. */
const TORSO: [number, number, number, number][] = [
  [0.85, 0.11, 0.075, 0], [0.9, 0.145, 0.1, 0], [0.97, 0.145, 0.097, 0], [1.04, 0.13, 0.085, -0.005], [1.07, 0.122, 0.081, -0.01],
  [1.18, 0.14, 0.09, -0.02], [1.32, 0.18, 0.105, -0.02], [1.4, 0.195, 0.095, -0.02], [1.46, 0.145, 0.065, -0.025], [1.5, 0.05, 0.05, 0.005],
  [1.58, 0.045, 0.045, 0.025],
];
/** Skull cross-sections, with the face filled out in front (jaw, cheeks and nose sit ahead of the skull profile). */
const SKULL: [number, number, number, number][] = [
  [1.58, 0.05, 0.06, 0.03], [1.615, 0.06, 0.075, 0.03], [1.65, 0.08, 0.092, 0.025], [1.69, 0.095, 0.095, 0.022], [1.735, 0.098, 0.092, 0.014],
  [1.785, 0.08, 0.075, 0.006], [1.816, 0.046, 0.044, 0], [1.83, 0.01, 0.01, 0],
];

function section(table: [number, number, number, number][], y: number): { w: number; d: number; zc: number } {
  if (y <= table[0][0]) return { w: table[0][1], d: table[0][2], zc: table[0][3] };
  for (let i = 0; i < table.length - 1; i++) {
    const a = table[i];
    const b = table[i + 1];
    if (y <= b[0]) {
      const t = (y - a[0]) / (b[0] - a[0]);
      return { w: a[1] + (b[1] - a[1]) * t, d: a[2] + (b[2] - a[2]) * t, zc: a[3] + (b[3] - a[3]) * t };
    }
  }
  const l = table[table.length - 1];
  return { w: l[1], d: l[2], zc: l[3] };
}
export const torsoAt = (y: number) => section(TORSO, y);
export const skullAt = (y: number) => section(SKULL, y);

export interface SurfacePoint {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
}

/**
 * Where a line at height `y` through (x, z) heading (dx, dz) meets an elliptic section going in, and where it leaves. A line
 * that misses the section (the pose is not the rest pose) lands on the nearest point of it instead, with no way out.
 */
function crossSection(w: number, d: number, cx: number, cz: number, x: number, y: number, z: number, dx: number, dz: number): { a: SurfacePoint; b: SurfacePoint | null } {
  const px = x - cx;
  const pz = z - cz;
  const iw = 1 / (w * w);
  const id = 1 / (d * d);
  const A = dx * dx * iw + dz * dz * id;
  const B = 2 * (px * dx * iw + pz * dz * id);
  const C = px * px * iw + pz * pz * id - 1;
  const at = (ex: number, ez: number): SurfacePoint => {
    const nx = ex * iw;
    const nz = ez * id;
    const l = Math.hypot(nx, nz) || 1;
    return { x: cx + ex, y, z: cz + ez, nx: nx / l, ny: 0, nz: nz / l };
  };
  const disc = B * B - 4 * A * C;
  if (A < 1e-9 || disc < 0) {
    // Closest approach (or a shot straight down): put it on the section, on the side the blow came from.
    const t = A < 1e-9 ? 0 : -B / (2 * A);
    let ex = px + dx * t;
    let ez = pz + dz * t;
    if (Math.hypot(ex, ez) < 1e-4) {
      ex = -dx;
      ez = -dz;
    }
    const k = 1 / Math.sqrt((ex * ex) * iw + (ez * ez) * id);
    return { a: at(ex * k, ez * k), b: null };
  }
  const s = Math.sqrt(disc);
  const t1 = (-B - s) / (2 * A);
  const t2 = (-B + s) / (2 * A);
  return { a: at(px + dx * t1, pz + dz * t1), b: at(px + dx * t2, pz + dz * t2) };
}

/** Which limb chain a zone is. */
export const chainOf = (zone: Exclude<Zone, 'torso' | 'head'>): LimbChain => zone as LimbChain;

/**
 * The point on the skin a blow at (x, y, z) heading (dx, dz) lands on, and the point it would leave by, on the part of the
 * body the zone names. Arms and legs are round; the torso, neck and head are their mesh's cross-sections.
 */
export function surfaceHit(zone: Zone, x: number, y: number, z: number, dx: number, dz: number): { entry: SurfacePoint; exit: SurfacePoint | null } {
  const l = Math.hypot(dx, dz);
  const ux = l > 1e-6 ? dx / l : 0;
  const uz = l > 1e-6 ? dz / l : 0;
  if (zone === 'head') {
    const hy = clamp(y, 1.6, 1.8);
    const s = skullAt(hy);
    const r = crossSection(s.w, s.d, 0, s.zc, x, hy, z, ux, uz);
    return { entry: r.a, exit: r.b };
  }
  if (zone === 'torso') {
    const ty = clamp(y, 0.88, 1.56);
    const s = torsoAt(ty);
    const r = crossSection(s.w, s.d, 0, s.zc, x, ty, z, ux, uz);
    return { entry: r.a, exit: r.b };
  }
  const c = chainOf(zone);
  const range = isArm(c) ? [0.8, 1.4] : [0.06, 0.92];
  const ly = clamp(y, range[0], range[1]);
  const a = limbAt(c, ly);
  const r = crossSection(a.r, a.r, a.x, a.z, x, ly, z, ux, uz);
  return { entry: r.a, exit: r.b };
}

// ------------------------------------------------------------------ bones

export type Bone = 'humerusL' | 'humerusR' | 'forearmL' | 'forearmR' | 'femurL' | 'femurR' | 'shinL' | 'shinR' | 'skull' | 'ribs' | 'pelvis' | 'jaw';
export const BONES: Bone[] = ['humerusL', 'humerusR', 'forearmL', 'forearmR', 'femurL', 'femurR', 'shinL', 'shinR', 'skull', 'ribs', 'pelvis', 'jaw'];
/** The long bones that bend where they break, in the order the renderer reads their bends. */
export const LIMB_BONES: Bone[] = BONES.slice(0, 8);
/** Each long bone: its limb, the height of the break (the middle of the bone), and the joint heights it runs between. */
export const LONG_BONE: Record<string, { chain: LimbChain; at: number; top: number; bottom: number }> = {
  humerusL: { chain: 'armL', at: 1.28, top: 1.42, bottom: 1.14 },
  humerusR: { chain: 'armR', at: 1.28, top: 1.42, bottom: 1.14 },
  forearmL: { chain: 'armL', at: 1.02, top: 1.14, bottom: 0.9 },
  forearmR: { chain: 'armR', at: 1.02, top: 1.14, bottom: 0.9 },
  femurL: { chain: 'legL', at: 0.73, top: 0.94, bottom: 0.52 },
  femurR: { chain: 'legR', at: 0.73, top: 0.94, bottom: 0.52 },
  shinL: { chain: 'legL', at: 0.32, top: 0.52, bottom: 0.12 },
  shinR: { chain: 'legR', at: 0.32, top: 0.52, bottom: 0.12 },
};

/** The bone under a point of the body. */
export function boneAt(zone: Zone, y: number, z: number): Bone {
  switch (zone) {
    case 'head':
      return y < 1.64 && z > 0.02 ? 'jaw' : 'skull';
    case 'torso':
      return y < 1.0 ? 'pelvis' : 'ribs';
    case 'armL':
      return y > 1.14 ? 'humerusL' : 'forearmL';
    case 'armR':
      return y > 1.14 ? 'humerusR' : 'forearmR';
    case 'legL':
      return y > 0.52 ? 'femurL' : 'shinL';
    case 'legR':
      return y > 0.52 ? 'femurR' : 'shinR';
  }
}

// ------------------------------------------------------------------ the state of a body

/** Kinds of wound, as the wound shader reads them. */
export const WOUND = { entry: 1, exit: 2, crater: 3, gash: 4, chop: 5, stab: 6, bruise: 7, burn: 8 } as const;
export type WoundKind = (typeof WOUND)[keyof typeof WOUND];

export interface FleshWound {
  k: WoundKind;
  /** Centre, on the skin. */
  x: number;
  y: number;
  z: number;
  /** Outward normal there. */
  nx: number;
  ny: number;
  nz: number;
  /** Along a cut: the way the blade went (unit). */
  tx: number;
  ty: number;
  tz: number;
  /** Radius, or a cut's half width. */
  r: number;
  /** A cut's half length (0 for a round wound). */
  len: number;
  /** 0 a mark in the skin to 1 open to the organs. */
  depth: number;
  /** When it was made (scene seconds): blood runs further from it the longer it has been open. */
  t: number;
  /** Raggedness seed. */
  seed: number;
}

export type HeadState = 'whole' | 'crushed' | 'split' | 'sliced' | 'burst' | 'off';

export interface Dent {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  r: number;
  depth: number;
}

export interface FleshState {
  wounds: FleshWound[];
  /** Height of each chain's cut in the rest pose (`CHAINS` order), 0 while it is whole. */
  cut: number[];
  /** 1 where the cut is torn (a blast, a rifle round, a car) rather than clean (a blade). */
  rag: number[];
  /** Damage each bone has taken (`BONES` order). */
  bone: number[];
  /** How far each broken long bone is bent (rad) and which way, as an angle round the bone (`LIMB_BONES` order). */
  bend: number[];
  bendDir: number[];
  /** Up to two places stoved in: a skull, a chest. */
  dents: Dent[];
  /** How open the belly is (1 and the gut comes out), whether it has, and where it comes out. */
  gut: number;
  spilled: boolean;
  open: SurfacePoint | null;
  head: HeadState;
  /** Bumped on every change, so the renderer re-uploads only bodies that changed. */
  version: number;
}

export const MAX_WOUNDS = 14;

export function newFlesh(): FleshState {
  return {
    wounds: [], cut: CHAINS.map(() => 0), rag: CHAINS.map(() => 0), bone: BONES.map(() => 0), bend: LIMB_BONES.map(() => 0),
    bendDir: LIMB_BONES.map(() => 0), dents: [], gut: 0, spilled: false, open: null, head: 'whole', version: 0,
  };
}

/** A copy for a piece that comes off: it carries the wounds and breaks it had, and the state goes on changing on its own. */
export function copyFlesh(f: FleshState): FleshState {
  return {
    wounds: f.wounds.map((w) => ({ ...w })), cut: [...f.cut], rag: [...f.rag], bone: [...f.bone], bend: [...f.bend], bendDir: [...f.bendDir],
    dents: f.dents.map((d) => ({ ...d })), gut: f.gut, spilled: f.spilled, open: f.open ? { ...f.open } : null, head: f.head, version: f.version,
  };
}

export const chainIndex = (c: Chain) => CHAINS.indexOf(c);
export const isCut = (f: FleshState, c: Chain) => f.cut[CHAINS.indexOf(c)] > 0;

// ------------------------------------------------------------------ a blow

export interface Blow {
  inj: Injury;
  /** Damage over the body's hit points. */
  power: number;
  zone: Zone;
  /** Where it landed and which way it was going, in the rest pose (scale 1). */
  x: number;
  y: number;
  z: number;
  dx: number;
  dy: number;
  dz: number;
  /** A round that carried on out of the body. */
  through?: boolean;
  /** Did the blow kill. */
  killed?: boolean;
  /** Parts the damage rules took off with this blow (`ballistics.wound`). */
  off?: Exclude<Zone, 'torso'>[];
  /**
   * A swing that works out its own cutting (how far through the part the blade has got over every stroke, and whether this
   * one finished it) passes it here: the cut opens that deep, and a finished cut through the waist parts the body.
   */
  cutDepth?: number;
  cutThrough?: boolean;
  /** Scene time. */
  time: number;
  /** 0..1 dice. */
  rng: () => number;
}

export interface Severed {
  chain: Chain;
  /** Rest-pose height of the cut. */
  y: number;
  ragged: boolean;
}

export interface FleshEvents {
  /** Wounds added (or grown). */
  wounds: number;
  /** Where it went in and where (if anywhere) it came out, on the skin. */
  entry: SurfacePoint;
  exit: SurfacePoint | null;
  broke: Bone[];
  compound: Bone[];
  severed: Severed[];
  /** Height the body was cut in two at (0: it was not). */
  bisect: number;
  /** The gut came out with this blow. */
  spill: boolean;
  /** What happened to the head with this blow, if anything. */
  head: HeadState | null;
  /** Pieces of the inside thrown out: meat, bone splinters, brain. */
  meat: number;
  splinters: number;
  brain: number;
}

const norm = (x: number, y: number, z: number): V3 => {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
};

/** Add a wound, or grow one already there into it (a close blast of pellets runs into one crater). */
function addWound(f: FleshState, w: FleshWound): FleshWound {
  for (const o of f.wounds) {
    if (o.len > 0 || w.len > 0 || o.k === WOUND.bruise || w.k === WOUND.bruise) continue;
    const d = Math.hypot(o.x - w.x, o.y - w.y, o.z - w.z);
    // Holes made in the same instant (one blast of pellets) tear the skin between them as well.
    const together = w.k === WOUND.entry && o.k !== WOUND.burn && Math.abs(o.t - w.t) < 0.08;
    if (d > (o.r + w.r) * (together ? 3 : 0.85)) continue;
    // Two holes that overlap become one bigger one: area adds, and it is a crater once it is wider than a fist.
    const r = Math.min(0.11, Math.sqrt(o.r * o.r + w.r * w.r) * 1.08);
    const k = r / Math.max(1e-6, o.r + w.r);
    o.x += (w.x - o.x) * k;
    o.y += (w.y - o.y) * k;
    o.z += (w.z - o.z) * k;
    o.r = r;
    o.depth = Math.min(1, Math.max(o.depth, w.depth) + 0.06);
    if (o.r > 0.035 && (o.k === WOUND.entry || o.k === WOUND.exit)) o.k = WOUND.crater;
    o.t = Math.min(o.t, w.t);
    return o;
  }
  if (f.wounds.length >= MAX_WOUNDS) {
    // Full: the smallest mark goes (a bruise first).
    let worst = 0;
    let score = Infinity;
    for (let i = 0; i < f.wounds.length; i++) {
      const s = f.wounds[i].r * (f.wounds[i].k === WOUND.bruise ? 0.3 : 1) * (1 + f.wounds[i].depth);
      if (s < score) {
        score = s;
        worst = i;
      }
    }
    f.wounds.splice(worst, 1);
  }
  f.wounds.push(w);
  return w;
}

function wound(k: WoundKind, p: SurfacePoint, r: number, depth: number, time: number, seed: number, t?: V3, len = 0): FleshWound {
  return { k, x: p.x, y: p.y, z: p.z, nx: p.nx, ny: p.ny, nz: p.nz, tx: t?.[0] ?? 0, ty: t?.[1] ?? 0, tz: t?.[2] ?? 0, r, len, depth, t: time, seed };
}

/** The way a blade travels over the skin at a point: down, and across by the weapon's slant, flat to the surface. */
function bladePath(p: SurfacePoint, slant: number, side: number): V3 {
  let tx = side * slant;
  let ty = -(1 - slant * 0.85);
  let tz = 0;
  const dn = tx * p.nx + ty * p.ny + tz * p.nz;
  tx -= dn * p.nx;
  ty -= dn * p.ny;
  tz -= dn * p.nz;
  return norm(tx, ty, tz);
}

/** Cut a chain at a height (kept inside its range); the first cut stands unless a new one is nearer the body. */
function cutChain(f: FleshState, c: Chain, y: number, ragged: boolean, ev: FleshEvents) {
  const i = CHAINS.indexOf(c);
  const [lo, hi] = CUT_RANGE[c];
  const cy = clamp(y, lo, hi);
  const old = f.cut[i];
  // Limbs and the waist lose what is below the cut, the neck what is above: a new cut only matters nearer the body.
  const nearer = c === 'neck' ? old === 0 || cy < old : old === 0 || cy > old;
  if (!nearer) return;
  f.cut[i] = cy;
  f.rag[i] = ragged ? 1 : 0;
  ev.severed.push({ chain: c, y: cy, ragged });
}

/** A long bone breaks: it bends at the break, more if it came through the skin. */
function breakBone(f: FleshState, b: Bone, compound: boolean, rng: () => number) {
  const li = LIMB_BONES.indexOf(b);
  if (li < 0) return;
  const lb = LONG_BONE[b];
  const side = lb.chain.endsWith('L') ? 1 : -1;
  // Shins and forearms fold out to the side or back; the angle is a real fracture's, not a rubber limb's.
  if (f.bend[li] === 0) f.bendDir[li] = (rng() - 0.5) * 2.4 + (isArm(lb.chain) ? side * 0.6 : Math.PI * (rng() < 0.5 ? 0.5 : -0.5) * side * 0.6);
  f.bend[li] = Math.max(f.bend[li], (compound ? 0.75 : 0.42) + rng() * 0.3);
}

/**
 * A blow lands. Opens the wound it makes (and the exit), breaks what it breaks, cuts what the damage rules took off at the
 * height it was hit, opens the belly when enough has gone into it, and decides what became of a head that came off or
 * caved in. Returns what happened so the game can throw the pieces and make the noise.
 */
export function injure(f: FleshState, b: Blow): FleshEvents {
  const { inj, power, rng } = b;
  const p = Math.max(0, power);
  const hitAt = surfaceHit(b.zone, b.x, b.y, b.z, b.dx, b.dz);
  const ev: FleshEvents = { wounds: 0, entry: hitAt.entry, exit: null, broke: [], compound: [], severed: [], bisect: 0, spill: false, head: null, meat: 0, splinters: 0, brain: 0 };
  const e = hitAt.entry;
  const seed = rng();
  const head = b.zone === 'head';
  const belly = b.zone === 'torso' && e.y > 0.9 && e.y < 1.24;
  const side = b.dx >= 0 ? 1 : -1;
  const strong = clamp01(p);

  // The wound itself.
  switch (inj.mech) {
    case 'pierce': {
      const r = inj.hole * (0.85 + 0.35 * strong);
      addWound(f, wound(WOUND.entry, e, r, inj.depth, b.time, seed));
      ev.wounds++;
      const out = hitAt.exit && inj.exit > 0 && (b.through || p >= inj.exitAt);
      if (out && hitAt.exit) {
        // Out the far side: the round tumbles and drags a cavity behind it; the faster it was going, the bigger the hole.
        const rx = Math.min(0.1, inj.hole * inj.exit * (0.7 + 0.3 * Math.min(1.6, p)) * (head ? 1.25 : 1));
        addWound(f, wound(rx > 0.04 ? WOUND.crater : WOUND.exit, hitAt.exit, rx, Math.min(1, inj.depth + 0.15), b.time, rng()));
        ev.exit = hitAt.exit;
        ev.wounds++;
        ev.meat += Math.round(1 + rx * 40);
      }
      break;
    }
    case 'cut':
    case 'chop': {
      const killedHead = head && inj.mech === 'cut' && inj.slice < 0.15 && (b.killed || p > 0.6);
      if (killedHead) {
        // A knife to the head goes in, not across.
        addWound(f, wound(WOUND.stab, e, inj.hole * 1.6, 1, b.time, seed, bladePath(e, 0, side), 0.02));
      } else {
        const t = bladePath(e, inj.slant, side);
        const len = inj.slice * (0.6 + 0.4 * strong) * 0.5;
        const depth = b.cutDepth !== undefined ? clamp01(Math.max(b.cutDepth, 0.15)) : Math.min(1, inj.depth * (0.55 + 0.55 * strong));
        addWound(f, wound(inj.mech === 'chop' ? WOUND.chop : WOUND.gash, e, inj.hole * (1 + 0.6 * strong), depth, b.time, seed, t, len));
        if (inj.mech === 'chop') ev.meat += 1 + Math.round(p);
      }
      ev.wounds++;
      break;
    }
    case 'crush': {
      addWound(f, wound(WOUND.bruise, e, inj.hole * (0.8 + 0.5 * strong), 0, b.time, seed));
      // A hard enough blow splits the skin over the bone as well as bruising it.
      if (p * inj.bone > 1.2) {
        addWound(f, wound(WOUND.gash, e, inj.hole * 0.22, Math.min(1, inj.depth + 0.3), b.time, rng(), bladePath(e, 0.6, side), inj.hole * 0.45));
      }
      ev.wounds++;
      break;
    }
    case 'blast': {
      addWound(f, wound(WOUND.burn, e, 0.08 + 0.05 * strong, 0, b.time, seed));
      addWound(f, wound(WOUND.crater, e, Math.min(0.1, inj.hole * (0.6 + 0.6 * strong)), inj.depth, b.time, rng()));
      ev.wounds += 2;
      ev.meat += 2 + Math.round(p);
      break;
    }
  }

  // Bone under it.
  const bone = boneAt(b.zone, e.y, e.z);
  const bi = BONES.indexOf(bone);
  const reach = inj.mech === 'pierce' ? (bone === 'ribs' || bone === 'pelvis' ? 0.6 : 1) : 1;
  const before = f.bone[bi];
  f.bone[bi] += p * inj.bone * reach;
  const now = f.bone[bi];
  const compoundAt = inj.mech === 'crush' ? COMPOUND * 0.9 : COMPOUND;
  if (bone === 'skull') {
    // The head: a club caves it in, and a heavy one bursts it; a round or a blade does what the wound already shows.
    if (inj.mech === 'crush' || inj.mech === 'blast') {
      if (now >= SKULL_BURST && f.head !== 'burst' && f.head !== 'off') {
        f.head = 'burst';
        ev.head = 'burst';
        cutChain(f, 'neck', BURST_CUT, true, ev);
        ev.brain += 4;
        ev.splinters += 5;
      } else if (now >= SKULL_CRUSH && f.head === 'whole') {
        f.head = 'crushed';
        ev.head = 'crushed';
        ev.splinters += 1;
      }
      if (inj.mech === 'crush' && f.dents.length < 2 && !f.dents.some((d) => d.y > 1.55)) {
        f.dents.push({ x: e.x, y: e.y, z: e.z, nx: e.nx, ny: e.ny, nz: e.nz, r: 0.06, depth: 0 });
      }
      const dent = f.dents.find((d) => d.y > 1.55);
      if (dent) dent.depth = Math.min(0.045, dent.depth + p * inj.bone * 0.018);
      if (f.head === 'crushed') {
        // Blood out of the nose and ears once the skull has gone.
        for (const sx of [1, -1]) addWound(f, wound(WOUND.exit, { x: sx * 0.097, y: 1.69, z: 0.01, nx: sx, ny: 0, nz: 0 }, 0.008, 0.2, b.time, rng()));
      }
    }
  } else if (bone === 'ribs' && inj.mech === 'crush' && now >= BREAK) {
    if (f.dents.length < 2 && !f.dents.some((d) => d.y <= 1.55)) f.dents.push({ x: e.x, y: e.y, z: e.z, nx: e.nx, ny: e.ny, nz: e.nz, r: 0.1, depth: 0 });
    const dent = f.dents.find((d) => d.y <= 1.55);
    if (dent) dent.depth = Math.min(0.05, dent.depth + p * inj.bone * 0.012);
    if (before < BREAK) ev.broke.push('ribs');
  } else if (LONG_BONE[bone]) {
    if (before < BREAK && now >= BREAK) {
      ev.broke.push(bone);
      breakBone(f, bone, false, rng);
      ev.splinters += inj.mech === 'pierce' ? 2 : 0;
    }
    if (before < compoundAt && now >= compoundAt) {
      ev.compound.push(bone);
      breakBone(f, bone, true, rng);
      // The broken end comes out through the skin at the break.
      const lb = LONG_BONE[bone];
      const a = limbAt(lb.chain, lb.at);
      const ang = f.bendDir[LIMB_BONES.indexOf(bone)];
      const nx = Math.sin(ang);
      const nz = Math.cos(ang);
      addWound(f, wound(WOUND.exit, { x: a.x + nx * a.r, y: lb.at, z: a.z + nz * a.r, nx, ny: 0, nz }, 0.022, 0.8, b.time, rng()));
      ev.splinters += 2;
    }
  } else if (now >= BREAK && before < BREAK) ev.broke.push(bone);

  // The belly.
  if (belly && inj.spill > 0) {
    const cutsIn = inj.mech === 'cut' || inj.mech === 'chop' ? 1 : inj.depth;
    f.gut += p * inj.spill * cutsIn;
    if (!f.spilled && f.gut >= 1) {
      f.spilled = true;
      ev.spill = true;
      // The gut comes out where the blow went in, torn wide (a round's entry bursts open under it), or out of the biggest
      // hole in the belly when that one is too small to matter.
      let best: FleshWound | null = null;
      let bestD = 0.05;
      for (const w of f.wounds) {
        if (w.y < 0.9 || w.y > 1.26 || w.k === WOUND.bruise || w.k === WOUND.burn) continue;
        const d = Math.hypot(w.x - e.x, w.y - e.y, w.z - e.z);
        if (d < bestD) {
          bestD = d;
          best = w;
        }
      }
      if (!best) {
        for (const w of f.wounds) {
          if (w.y < 0.9 || w.y > 1.26 || w.k === WOUND.bruise || w.k === WOUND.burn) continue;
          if (!best || w.r + w.len > best.r + best.len) best = w;
        }
      }
      const at = best ?? wound(WOUND.crater, e, 0.05, 1, b.time, rng());
      if (!best) addWound(f, at);
      // Opened wide enough to let it out.
      at.depth = 1;
      if (at.len > 0) at.r = Math.max(at.r, 0.02);
      else at.r = Math.max(at.r, 0.045);
      if (at.k === WOUND.entry || at.k === WOUND.exit) at.k = WOUND.crater;
      f.open = { x: at.x, y: at.y, z: at.z, nx: at.nx, ny: at.ny, nz: at.nz };
      ev.meat += 2;
    }
  }

  // What the damage rules took off, cut at the height it was hit.
  const ragged = inj.mech === 'pierce' || inj.mech === 'blast' || inj.mech === 'crush';
  for (const z of b.off ?? []) {
    if (z === 'head') {
      if (f.head === 'burst' || f.head === 'off' || f.head === 'split' || f.head === 'sliced') continue;
      if (inj.mech === 'pierce' || inj.mech === 'crush') {
        // A round heavy enough to take the head takes the skull apart: the jaw stays.
        f.head = 'burst';
        cutChain(f, 'neck', BURST_CUT + (rng() - 0.5) * 0.02, true, ev);
        ev.brain += 4;
        ev.splinters += 4;
      } else if (b.cutThrough && (inj.mech === 'chop' || inj.mech === 'cut')) {
        // The swing says the blade went right through: off at the neck, or the top of the skull off level with the eyes.
        if (e.y > 1.66) {
          f.head = 'sliced';
          cutChain(f, 'neck', clamp(e.y, 1.68, 1.75), false, ev);
          ev.brain += 1;
        } else {
          f.head = 'off';
          cutChain(f, 'neck', clamp(e.y, NECK_CUT - 0.03, NECK_CUT + 0.04), false, ev);
        }
      } else if (inj.mech === 'chop' && e.y > 1.66) {
        // An axe or a machete into the crown: the skull is split down to the brain.
        f.head = 'split';
        const t: V3 = norm(0, -0.2, 1);
        addWound(f, wound(WOUND.chop, { x: 0, y: 1.8, z: 0, nx: 0, ny: 1, nz: 0 }, 0.016, 1, b.time, rng(), t, 0.1));
        addWound(f, wound(WOUND.chop, { x: e.x * 0.3, y: 1.74, z: 0.07, nx: 0, ny: 0.35, nz: 0.94 }, 0.012, 1, b.time, rng(), norm(0, -1, 0), 0.05));
        ev.brain += 2;
        ev.splinters += 1;
      } else if (inj.mech === 'cut' && e.y > 1.66) {
        // A long blade through the top of the head takes it off clean, level with the eyes.
        f.head = 'sliced';
        cutChain(f, 'neck', clamp(e.y, 1.68, 1.75), false, ev);
        ev.brain += 1;
      } else {
        f.head = 'off';
        cutChain(f, 'neck', NECK_CUT + (rng() - 0.5) * 0.04, ragged, ev);
      }
      ev.head = f.head;
      continue;
    }
    const c = chainOf(z);
    // Hit on that limb: cut where it was hit. Torn off by a blow elsewhere: at the joint.
    const y = z === b.zone ? e.y : CUT_RANGE[c][1] - (ragged ? rng() * 0.05 : 0);
    cutChain(f, c, y, ragged, ev);
    ev.splinters += ragged ? 1 : 0;
    ev.meat += 1;
  }

  // A long blade through the waist, or a blow that tears a body apart: two halves.
  if (b.zone === 'torso' && f.cut[5] === 0) {
    const cleanly = inj.mech === 'cut' || inj.mech === 'chop';
    const enough = b.cutThrough !== undefined
      ? b.cutThrough && cleanly && e.y >= 0.95 && e.y <= 1.26
      : cleanly ? p * inj.sever >= BISECT && e.y < 1.26 : inj.mech === 'blast' || inj.mech === 'crush' ? p >= 3.2 && rng() < 0.6 : false;
    if (enough) {
      cutChain(f, 'waist', clamp(e.y, 0.98, 1.22), !cleanly, ev);
      ev.bisect = f.cut[5];
      if (!f.spilled) {
        f.spilled = true;
        ev.spill = true;
      }
      f.open = { x: 0, y: f.cut[5], z: 0.02, nx: 0, ny: -1, nz: 0 };
      ev.meat += 3;
    }
  }
  f.version++;
  return ev;
}

// ------------------------------------------------------------------ what a body can still do

/** Legs that no longer carry it: cut off, broken, or not there below a cut waist. */
export function legsUseless(f: FleshState): number {
  if (f.cut[5] > 0) return 2;
  let n = 0;
  for (const [c, a, b] of [['legL', 4, 6], ['legR', 5, 7]] as const) {
    if (f.cut[CHAINS.indexOf(c)] > 0 || f.bone[a] >= BREAK || f.bone[b] >= BREAK) n++;
  }
  return n;
}

/** Arms that no longer grab: cut off or broken. */
export function armsUseless(f: FleshState): number {
  let n = 0;
  for (const [c, a, b] of [['armL', 0, 2], ['armR', 1, 3]] as const) {
    if (f.cut[CHAINS.indexOf(c)] > 0 || f.bone[a] >= BREAK || f.bone[b] >= BREAK) n++;
  }
  return n;
}

/** Share of its walking speed left: a broken leg is a lurching limp, two and it drags itself; the gut out slows it a little. */
export function fleshMoveMult(f: FleshState): number {
  const legs = legsUseless(f);
  return (legs >= 2 ? 0.2 : legs === 1 ? 0.5 : 1) * (f.spilled && f.cut[5] === 0 ? 0.85 : 1);
}

/** Is the brain gone: nothing that walks on after this. */
export const brainGone = (f: FleshState) => f.head === 'crushed' || f.head === 'split' || f.head === 'sliced' || f.head === 'burst' || f.head === 'off';

/**
 * What comes off with a cut, in the rest pose: the middle of it (where it spins about) and its half extents, for throwing it
 * as one piece of the body it came off.
 */
export function pieceOf(c: Chain, y: number): { cx: number; cy: number; cz: number; hx: number; hy: number; hz: number } {
  switch (c) {
    case 'neck':
      return { cx: 0, cy: (y + 1.83) / 2, cz: 0.02, hx: 0.1, hy: (1.83 - y) / 2, hz: 0.11 };
    case 'waist':
      return { cx: 0, cy: y * 0.52, cz: 0.02, hx: 0.17, hy: y / 2, hz: 0.12 };
    default: {
      const end = isArm(c) ? 0.77 : 0;
      const a = limbAt(c, (y + end) / 2);
      return { cx: a.x, cy: (y + end) / 2, cz: a.z + (isArm(c) ? 0 : 0.03), hx: 0.06, hy: (y - end) / 2, hz: isArm(c) ? 0.06 : 0.1 };
    }
  }
}
