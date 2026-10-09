import { clamp, clamp01 } from '../core/math';
import type { AnimalKind } from '../data';
import type { AnimalPart } from './anatomy';
import type { Zone } from './ballistics';
import { NOTCH, notchDepth, WOOD, type WoodKind } from './treeDamage';

/**
 * A blade through a swing, as pure rules (no engine imports). The swing is a sweep: the edge turns about the shoulder in one
 * plane, set by where the swinger looks and which way the arm comes across, and whatever that plane passes through inside
 * the arc is struck where the plane meets it, in the order the edge gets there. The edge carries the work of the swing (a
 * machete about a hundred joules at its sweet spot), and every cut spends some: through grass it hardly slows, a bush's
 * stems take a share, a body or a trunk stops it. What a cut costs is the cross-section the edge has to part, times how hard
 * that stuff is to part: rotten flesh little, bone a lot, green wood more again. A cut that is not finished stays where it
 * is, and the next stroke at the same place goes on from there, so a thick neck or a bear's leg takes a few.
 *
 * Gameplay approximations of real figures: fracture work across the grain of soft tissue a few kJ/m², bone and green wood
 * tens of kJ/m².
 */

// ------------------------------------------------------------------ the blades

export type BladeKind = 'knife' | 'machete' | 'axe' | 'katana';

export interface BladeSpec {
  /** Effective mass at the sweet spot, kg: the weapon and the share of the arm swinging behind it. */
  mass: number;
  /** Speed of the sweet spot at full swing, m/s. */
  speed: number;
  /** Length of the edge, m: the cutting part of the sweep, out to the tip. */
  edge: number;
  /** Deepest one stroke goes into a section, m: a long blade slices through what a short one only opens. */
  depth: number;
  /** Share of the work that goes into parting what it hits (the rest shoves and bruises). */
  sharp: number;
  /** How well a chop bites a chip out of wood (a wedge-shaped axe best, a thin katana poorly). */
  wood: number;
}

export const BLADE: Record<BladeKind, BladeSpec> = {
  knife: { mass: 0.3, speed: 11, edge: 0.15, depth: 0.12, sharp: 0.95, wood: 0.25 },
  machete: { mass: 0.62, speed: 17.5, edge: 0.46, depth: 0.4, sharp: 0.85, wood: 0.7 },
  axe: { mass: 1.25, speed: 15.5, edge: 0.12, depth: 0.26, sharp: 0.8, wood: 1.6 },
  katana: { mass: 0.9, speed: 18, edge: 0.68, depth: 0.6, sharp: 0.9, wood: 0.4 },
};

export const isBlade = (model: string | undefined): model is BladeKind => !!model && model in BLADE;

/** Work the sweet spot carries at full swing, J. */
export const bladeWork = (b: BladeSpec) => 0.5 * b.mass * b.speed * b.speed;

/**
 * Work at a point `r` metres from the pivot, for a sweep reaching `rOut`: the edge goes faster the further out, but nearer
 * the hilt more of the arm's own weight is behind the blow, so it falls off only as the distance (not its square) and never
 * below a share of the full blow. A tired arm (`arm` < 1) swings slower.
 */
export function workAt(b: BladeSpec, r: number, rOut: number, arm = 1): number {
  const sweet = Math.max(0.3, rOut - b.edge * 0.3);
  return bladeWork(b) * clamp(r / sweet, 0.45, 1.1) * arm * arm;
}

// ------------------------------------------------------------------ what it cuts through

/** J per m² to part a material across: soft tissue, and the bone in it. */
export interface Tough {
  soft: number;
  hard: number;
}

/** The dead are rotten and come apart easily; a living beast's hide, muscle and bone are tougher. */
export const FLESH: Record<'rotten' | 'living', Tough> = {
  rotten: { soft: 1500, hard: 20_000 },
  living: { soft: 2500, hard: 35_000 },
};

/** A part's cross-section where the edge crosses it: soft tissue and bone (m²) and how wide it is along the cut (m). */
export interface Section {
  soft: number;
  bone: number;
  width: number;
}

const ell = (a: number, b: number) => Math.PI * a * b;

/**
 * The section of one of the dead at rest-pose height `y` (metres at scale 1, feet at 0) in a zone, at scale `s`. The top
 * of the skull is mostly bone; the neck is a column of meat round the spine; the waist is meat and gut round the spine; the
 * chest a cage of ribs.
 */
export function bodySection(zone: Zone, y: number, s = 1): Section {
  const k = s * s;
  let soft: number, bone: number, width: number;
  switch (zone) {
    case 'head':
      if (y > 1.66) {
        // Through the skull.
        soft = ell(0.085, 0.09) * 0.75;
        bone = 0.0035;
        width = 0.18;
      } else {
        soft = ell(0.055, 0.06);
        bone = 0.0012;
        width = 0.12;
      }
      break;
    case 'armL':
    case 'armR':
      if (y > 1.14) {
        soft = ell(0.045, 0.045);
        bone = 0.00038;
        width = 0.09;
      } else {
        soft = ell(0.036, 0.034);
        bone = 0.0004;
        width = 0.07;
      }
      break;
    case 'legL':
    case 'legR':
      if (y > 0.52) {
        soft = ell(0.07, 0.07);
        bone = 0.00053;
        width = 0.14;
      } else {
        soft = ell(0.05, 0.05);
        bone = 0.00045;
        width = 0.1;
      }
      break;
    default:
      if (y >= 0.95 && y <= 1.26) {
        // The waist: the belly wall, the gut and the spine. Tougher going than a limb for its size.
        soft = ell(0.13, 0.085) * 2;
        bone = 0.0014;
        width = 0.26;
      } else if (y > 1.26) {
        soft = ell(0.18, 0.1) * 2;
        bone = 0.004;
        width = 0.36;
      } else {
        soft = ell(0.15, 0.1) * 2;
        bone = 0.005;
        width = 0.3;
      }
  }
  return { soft: soft * k, bone: bone * k, width: width * s };
}

/** Rest-pose heights at which each part of the dead can be cut through (the rest of a torso is only opened). */
export const WAIST: [number, number] = [0.95, 1.26];

/** How tough each kind of the dead is to cut, as a multiple: a brute's slabs of muscle, a bloater's swollen softness. */
export const DEAD_TOUGH: Record<string, number> = { brute: 1.6, bloater: 0.6, runner: 0.9, stalker: 0.9 };

/** Weight of each beast (kg): it sets how thick its legs and neck are. */
export const ANIMAL_KG: Record<AnimalKind, number> = {
  hare: 3, deer: 40, vulture: 8, dog: 25, wolf: 40, boar: 90, bear: 250, ibex: 55, camel: 450, fox: 6, jackal: 10, buffalo: 600,
  heron: 2, stork: 3.5, duck: 1.2, crow: 0.5, egret: 0.6,
};
/** The heavy-boned: legs like posts for their weight. */
const STOUT = new Set<AnimalKind>(['bear', 'buffalo', 'boar', 'camel']);

/** The section of a beast's part (a leg, the neck, a wing) at size `size`; the body itself is only opened, never cut in two. */
export function animalSection(kind: AnimalKind, part: AnimalPart | 'torso', size = 1): Section {
  const kg = ANIMAL_KG[kind] * size ** 3;
  const g = Math.cbrt(kg / 10);
  if (part === 'wingL' || part === 'wingR') {
    const r = 0.008 * g;
    return { soft: ell(r * 2, r), bone: ell(r * 0.4, r * 0.4), width: r * 4 };
  }
  if (part === 'head') {
    const r = 0.03 * g;
    return { soft: ell(r, r * 1.1), bone: ell(r, r) * 0.1, width: r * 2 };
  }
  if (part === 'torso') {
    const r = 0.09 * g;
    return { soft: ell(r, r * 1.2), bone: ell(r, r) * 0.06, width: r * 2 };
  }
  const r = 0.017 * g * (STOUT.has(kind) ? 1.4 : 1);
  return { soft: ell(r, r), bone: ell(r, r) * 0.12, width: r * 2 };
}

/** Work (J) to part a whole section of a material, with a toughness multiple (a thick hide, a brute's muscle). */
export const sectionCost = (s: Section, t: Tough, mul = 1) => (s.soft * t.soft + s.bone * t.hard) * mul;

// ------------------------------------------------------------------ plants

/**
 * What a blade parts in a plant, by kind: the stems' section at the root (m², at scale 1), how hard they are to part (J/m²),
 * and how fast the section thins up the plant (`taper`: 0 the same all the way up, as a clump of grass or a reed bed; a
 * bush's main stems near the ground, its twigs at the top). `bits` says what flies off the cut.
 */
export interface StemSpec {
  area: number;
  tough: number;
  taper: number;
  bits: 'clip' | 'flower' | 'leafy' | 'stalk' | 'pad' | 'frond' | 'cap';
}

export const STEMS: Record<string, StemSpec> = {
  grass: { area: 1.5e-4, tough: 20_000, taper: 0, bits: 'clip' },
  flowers: { area: 6e-5, tough: 25_000, taper: 0, bits: 'flower' },
  blooms: { area: 6e-5, tough: 15_000, taper: 0, bits: 'flower' },
  yarrow: { area: 1.2e-4, tough: 25_000, taper: 0, bits: 'flower' },
  iris: { area: 3e-4, tough: 15_000, taper: 0, bits: 'flower' },
  zaatar: { area: 2e-4, tough: 30_000, taper: 0.3, bits: 'leafy' },
  ferns: { area: 2.5e-4, tough: 15_000, taper: 0.2, bits: 'frond' },
  weed: { area: 1e-4, tough: 12_000, taper: 0, bits: 'clip' },
  pads: { area: 1.5e-4, tough: 8000, taper: 0, bits: 'pad' },
  reeds: { area: 8e-4, tough: 50_000, taper: 0.2, bits: 'stalk' },
  papyrus: { area: 1.2e-3, tough: 25_000, taper: 0.2, bits: 'stalk' },
  cane: { area: 2e-3, tough: 70_000, taper: 0.25, bits: 'stalk' },
  shrubs: { area: 1.6e-3, tough: 60_000, taper: 1.5, bits: 'leafy' },
  bramble: { area: 1e-3, tough: 50_000, taper: 1.2, bits: 'leafy' },
  oleander: { area: 3e-3, tough: 80_000, taper: 1.5, bits: 'flower' },
  fig: { area: 5e-3, tough: 110_000, taper: 1.6, bits: 'leafy' },
  sabra: { area: 0.015, tough: 9000, taper: 0.5, bits: 'pad' },
  mushroom: { area: 3e-4, tough: 3000, taper: 0, bits: 'cap' },
};

/** Whatever a plant's top keeps as its thinnest twigs, as a share of the root section. */
const TWIG = 0.06;

/** Work (J) to part a plant at a share `h` of its height (0 root, 1 top), at scale `s`. */
export function stemCost(kind: string, h: number, s = 1): number {
  const st = STEMS[kind];
  if (!st) return Infinity;
  const thin = st.taper > 0 ? TWIG + (1 - TWIG) * (1 - clamp01(h)) ** st.taper : 1;
  return st.area * s * s * thin * st.tough;
}

/** Below this share of its height a cut plant is down to stubble: nothing more to take. */
export const STUBBLE = 0.06;

// ------------------------------------------------------------------ a stroke

export interface Stroke {
  /** Share of the section this stroke parted, and the total so far (1 is through). */
  gain: number;
  done: number;
  through: boolean;
  /** Work the edge still carries past it (0: the blade stopped in it). */
  left: number;
}

/**
 * One stroke into a section that `done` of has already been cut through. The edge parts what its work pays for, up to how
 * deep it can go in one stroke (`spec.depth` into a section `width` across); what is left of its work carries on through
 * if it finishes the cut, or is spent if it stops in there.
 */
export function stroke(spec: BladeSpec, work: number, cost: number, done: number, width: number): Stroke {
  const was = clamp01(done);
  if (cost <= 0 || !Number.isFinite(cost)) return { gain: 0, done: was, through: false, left: 0 };
  const reach = clamp(spec.depth / Math.max(1e-4, width), 0.12, 1);
  const pays = (work * spec.sharp) / cost;
  const gain = Math.max(0, Math.min(1 - was, reach, pays));
  const now = was + gain;
  const through = now >= 1 - 1e-6;
  // What finishing it cost: the share it parted, paid for out of the work that went into the cut.
  const used = (gain * cost) / spec.sharp;
  return { gain, done: through ? 1 : now, through, left: through ? Math.max(0, work - used) : 0 };
}

/** A cut in progress on one part of something: where along it (rest-pose or model height) and how far through it is. */
export interface CutLine {
  part: string;
  y: number;
  done: number;
}

/** Strokes this close (m) along a part to an earlier cut go into that cut rather than starting a new one. */
export const SAME_CUT = 0.08;

/**
 * The cut a stroke at height `y` on `part` goes into: an earlier one close enough, else a new one. A body keeps a handful;
 * the shallowest goes first when it needs room.
 */
export function cutLine(lines: CutLine[], part: string, y: number, near = SAME_CUT): CutLine {
  let best: CutLine | null = null;
  for (const l of lines) if (l.part === part && Math.abs(l.y - y) <= near && (!best || l.done > best.done)) best = l;
  if (best) return best;
  if (lines.length >= 8) {
    let worst = 0;
    for (let i = 1; i < lines.length; i++) if (lines[i].done < lines[worst].done) worst = i;
    lines.splice(worst, 1);
  }
  const l = { part, y, done: 0 };
  lines.push(l);
  return l;
}

/** Lay a stroke into its cut: the cut's height moves toward where this one landed, by how much each parted. */
export function deepen(l: CutLine, y: number, s: Stroke) {
  const w = l.done + s.gain;
  if (w > 0) l.y = (l.y * l.done + y * s.gain) / w;
  l.done = s.done;
}

// ------------------------------------------------------------------ chopping wood

/** Joules of a blade's work that take a square metre of a medium trunk's section out (a chop is cleaner than a round). */
export const CHOP_WORK = NOTCH.work * 0.9;

/**
 * Share of a trunk's section one chop takes out. Like a round's notch, but the edge only gets to the bottom of a notch as
 * deep as it can bite: past that it only widens the mouth.
 */
export function chopGain(spec: BladeSpec, work: number, section: number, diameter: number, done: number, hard: number): number {
  if (work <= 0 || section <= 0) return 0;
  const depth = notchDepth(done) * diameter;
  const eff = depth <= spec.depth ? 1 : (spec.depth / depth) ** 1.5;
  const area = (work * spec.wood * eff) / (CHOP_WORK * Math.max(0.2, hard));
  return Math.min(NOTCH.maxPerHit, area / section);
}

/** How big the chips a chop knocks out are (a scale on the chip piece), by the work that went in. */
export const chipSize = (work: number) => clamp(0.7 + work / 90, 0.7, 2.6);

/** Chips and bark flakes out of one chop. */
export function chopBits(work: number, wood: WoodKind): { chips: number; bark: number } {
  const chips = Math.round(clamp(2 + work / 18, 2, 12));
  return { chips, bark: Math.round(chips * WOOD[wood].flake * 0.6) };
}

// ------------------------------------------------------------------ the sweep

type V3 = [number, number, number];

export type SwingStyle = 'fore' | 'back' | 'over';

/**
 * The plane a swing turns in, from where the swinger looks (`aim`, unit) and the arm's way across: a forehand comes down
 * from high on the right to low on the left, a backhand comes back the other way flatter, an overhead chop straight down.
 * `u` is the aim, `v` the way the edge starts out from it (the sweep turns from +v through u toward -v), `n` the normal.
 */
export interface SwingPlane {
  pivot: V3;
  u: V3;
  v: V3;
  n: V3;
  /** Angles (rad) from the aim the sweep starts and ends at: +start to -end. */
  start: number;
  end: number;
  /** Radial span of the edge from the pivot, m. */
  rIn: number;
  rOut: number;
}

const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Tilt of each style's line across the view, rad above level (the forehand's 40°, the backhand flatter). */
const TILT: Record<SwingStyle, number> = { fore: 0.7, back: 0.42, over: Math.PI / 2 };

export function swingPlane(pivot: V3, aim: V3, style: SwingStyle, rOut: number, edge: number): SwingPlane {
  const u = unit(aim);
  // The view's right and up (the aim never points straight up or down in the game's pitch range).
  let right = cross(u, [0, 1, 0]);
  if (Math.hypot(...right) < 1e-3) right = [1, 0, 0];
  right = unit(right);
  const up = unit(cross(right, u));
  const t = TILT[style];
  const side = style === 'back' ? -1 : 1;
  const v = unit([right[0] * Math.cos(t) * side + up[0] * Math.sin(t), right[1] * Math.cos(t) * side + up[1] * Math.sin(t), right[2] * Math.cos(t) * side + up[2] * Math.sin(t)]);
  const n = unit(cross(u, v));
  return { pivot, u, v, n, start: style === 'over' ? 1.5 : 1.35, end: style === 'back' ? 1.2 : 1.35, rIn: Math.max(0.3, rOut - edge - 0.25), rOut };
}

/** The way the edge points at angle `a` of the sweep, and the way it is moving there. */
export function edgeAt(pl: SwingPlane, a: number): { dir: V3; motion: V3 } {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return {
    dir: [pl.u[0] * c + pl.v[0] * s, pl.u[1] * c + pl.v[1] * s, pl.u[2] * c + pl.v[2] * s],
    motion: [pl.u[0] * s - pl.v[0] * c, pl.u[1] * s - pl.v[1] * c, pl.u[2] * s - pl.v[2] * c],
  };
}

/** Where the edge first meets a capsule: the sweep angle it gets there at, how far out along the blade, and the point. */
export interface Contact {
  angle: number;
  r: number;
  x: number;
  y: number;
  z: number;
}

/**
 * Where the sweep first meets a capsule from `a` to `b` of radius `rad` (a body, a leg, a stem, a bush), or null if the
 * plane passes it by or it lies outside the arc. Samples the axis, and always the point where the plane crosses it, so a
 * stem a centimetre thick is not slipped past between samples.
 */
export function sweepCapsule(pl: SwingPlane, a: V3, b: V3, rad: number, samples = 14): Contact | null {
  const P = pl.pivot;
  const ab: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const da = dot(pl.n, [a[0] - P[0], a[1] - P[1], a[2] - P[2]]);
  const dab = dot(pl.n, ab);
  let best: Contact | null = null;
  const test = (t: number) => {
    const x = a[0] + ab[0] * t, y = a[1] + ab[1] * t, z = a[2] + ab[2] * t;
    const off = da + dab * t;
    if (Math.abs(off) > rad) return;
    // The slice of the capsule the plane cuts here is narrower the further the axis is from the plane.
    const half = Math.sqrt(Math.max(0, rad * rad - off * off));
    const px = x - pl.n[0] * off - P[0], py = y - pl.n[1] * off - P[1], pz = z - pl.n[2] * off - P[2];
    const pu = px * pl.u[0] + py * pl.u[1] + pz * pl.u[2];
    const pv = px * pl.v[0] + py * pl.v[1] + pz * pl.v[2];
    const r = Math.hypot(pu, pv);
    if (r < pl.rIn - half || r > pl.rOut + half || r < 1e-3) return;
    // The edge comes from the +v side: it reaches the near rim of the slice first.
    const ang = Math.atan2(pv, pu) + Math.asin(Math.min(1, half / r));
    if (ang < -pl.end || Math.atan2(pv, pu) - Math.asin(Math.min(1, half / r)) > pl.start) return;
    const first = Math.min(ang, pl.start);
    if (best && first <= best.angle) return;
    const rr = clamp(r, pl.rIn, pl.rOut);
    // The point on the near rim, where the edge goes in.
    const m = edgeAt(pl, Math.atan2(pv, pu)).motion;
    best = { angle: first, r: rr, x: P[0] + pl.u[0] * pu + pl.v[0] * pv - m[0] * half, y: P[1] + pl.u[1] * pu + pl.v[1] * pv - m[1] * half, z: P[2] + pl.u[2] * pu + pl.v[2] * pv - m[2] * half };
  };
  for (let i = 0; i <= samples; i++) test(i / samples);
  if (Math.abs(dab) > 1e-6) {
    const t = -da / dab;
    if (t > 0 && t < 1) test(t);
  }
  return best;
}

/**
 * Where the sweep first meets an axis-aligned box (a wall, a crate, a barricade), stepping the edge through the arc; the
 * box is solid, so nothing slips between steps. Null if it never does.
 */
export function sweepBox(pl: SwingPlane, min: V3, max: V3, steps = 72): Contact | null {
  for (let i = 0; i <= steps; i++) {
    const a = pl.start - ((pl.start + pl.end) * i) / steps;
    const d = edgeAt(pl, a).dir;
    const t = segBox(pl.pivot, d, pl.rIn, pl.rOut, min, max);
    if (t >= 0) return { angle: a, r: t, x: pl.pivot[0] + d[0] * t, y: pl.pivot[1] + d[1] * t, z: pl.pivot[2] + d[2] * t };
  }
  return null;
}

/** Distance along `d` from `o` (between t0 and t1) at which the ray enters a box, or -1. */
function segBox(o: V3, d: V3, t0: number, t1: number, min: V3, max: V3): number {
  let lo = t0;
  let hi = t1;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-9) {
      if (o[k] < min[k] || o[k] > max[k]) return -1;
      continue;
    }
    let a = (min[k] - o[k]) / d[k];
    let b = (max[k] - o[k]) / d[k];
    if (a > b) [a, b] = [b, a];
    lo = Math.max(lo, a);
    hi = Math.min(hi, b);
    if (lo > hi) return -1;
  }
  return lo;
}

/**
 * The first angle at which the edge's tip goes into the ground (`ground(x, z)` its height), or null if the swing stays
 * clear of it. Looking down, an overhead chop ends in the earth; a level swing never reaches it.
 */
export function sweepGround(pl: SwingPlane, ground: (x: number, z: number) => number, steps = 48): Contact | null {
  for (let i = 0; i <= steps; i++) {
    const a = pl.start - ((pl.start + pl.end) * i) / steps;
    const d = edgeAt(pl, a).dir;
    if (d[1] > -0.05) continue;
    const x = pl.pivot[0] + d[0] * pl.rOut, y = pl.pivot[1] + d[1] * pl.rOut, z = pl.pivot[2] + d[2] * pl.rOut;
    const g = ground(x, z);
    if (y > g) continue;
    // Back along the edge to where it meets the ground.
    const t = clamp((g - pl.pivot[1]) / d[1], pl.rIn, pl.rOut);
    return { angle: a, r: t, x: pl.pivot[0] + d[0] * t, y: g, z: pl.pivot[2] + d[2] * t };
  }
  return null;
}

/** Rest-pose height to world and back for one of the dead: `feet` is where its feet would be standing, `s` its scale. */
export const restY = (worldY: number, feet: number, s: number) => (worldY - feet) / Math.max(0.1, s);
