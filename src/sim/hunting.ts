import type { AnimalKind } from '../data';
import { BODY } from './anatomy';

/**
 * Hunting, as pure rules (no engine imports): how grazing game comes to notice someone stalking it, where a shot lands in
 * the body and what it does there, and what a carcass gives up once it is butchered.
 *
 * Noticing is not a switch. Each animal builds up `awareness` from what it sees, hears and smells of the nearest person on
 * foot, and lets it fade when nothing is there. At `STALK.alert` it lifts its head and stares; at 1 it knows, and bolts.
 * - Eyes: out to its sight range, cut by a crouch, by standing still, by cover between, by the dark (for day animals), and
 *   halved again while its head is down in the grass. Movement is what it sees best: a walker is seen twice as far as
 *   someone frozen, and a runner further still.
 * - Ears: footsteps, the same noise level the Signature grid hears, out to a couple of metres a point.
 * - Nose: the wind carries a person's scent downwind in a cone. Inside it nothing else matters: crouched, still and hidden,
 *   the animal smells you and is gone. Rain washes most of it out of the air.
 */
export const STALK = {
  /** Awareness at which it stops grazing and stares, and below which a staring animal goes back to grazing. */
  alert: 0.35,
  calm: 0.15,
  /** Fades this much a second when nothing is noticed. */
  decay: 0.14,
  /**
   * Seconds it stares, head up, before it acts on what it knows (unless you are inside its flight distance or it has your
   * scent): the moment to freeze.
   */
  stare: 1.2,
  /** Sight range multipliers: frozen, walking, running; and for a crouch. */
  still: 0.6,
  walk: 1,
  run: 1.45,
  crouch: 0.55,
  /** Full cover takes this share off its sight; the dark takes this much from an animal that is not out at night. */
  coverCut: 0.9,
  darkCut: 0.55,
  /** Head down in the grass it sees this share as far; head up and staring, this much more. */
  grazing: 0.7,
  staring: 1.3,
  /** Scent: reach in still air, extra metres per m/s of wind, cap; cone half-angle as a cosine. */
  scentBase: 9,
  scentPerMs: 9,
  scentMax: 70,
  scentCone: 0.55,
  /** Metres of hearing per point of footstep noise. */
  hearPerPoint: 2.2,
  /** Rain: share of scent and of footstep noise left. */
  rainScent: 0.35,
  rainHush: 0.6,
};

export interface StalkSense {
  /** From the animal to the person: offset (m). */
  dx: number;
  dz: number;
  /** The species' sight range (difficulty already applied). */
  sight: number;
  /** How fast the person is moving (m/s) and whether they are crouched. */
  speed: number;
  crouch: boolean;
  /** 0 open ground to 1 completely hidden from it. */
  cover: number;
  /** 0 day to 1 deep night, and whether this animal sees in the dark. */
  dark: number;
  nightEyes: boolean;
  /** Head down grazing, drinking or feeding; or up and staring at something. */
  grazing: boolean;
  staring: boolean;
  /** The air's velocity, m/s. */
  windX: number;
  windZ: number;
  /** The person's footstep noise (see `Player.footSignature`), and how hard it is raining (0..1). */
  noise: number;
  rain: number;
}

export interface Notice {
  /** Awareness gained per second. */
  rate: number;
  seen: boolean;
  heard: boolean;
  smelled: boolean;
}

/** How far it can make out a person like this, before cover and the dark. */
export function sightReach(s: Pick<StalkSense, 'sight' | 'speed' | 'crouch' | 'grazing' | 'staring'>): number {
  const motion = s.speed > 4.5 ? STALK.run : s.speed > 0.5 ? STALK.walk : STALK.still;
  return s.sight * motion * (s.crouch ? STALK.crouch : 1) * (s.grazing ? STALK.grazing : s.staring ? STALK.staring : 1);
}

/**
 * How far downwind a person's scent carries toward a point at offset (-dx, -dz) from them: 0 outside the cone. Straight
 * downwind it reaches furthest; at the edge of the cone, not at all.
 */
export function scentReach(dx: number, dz: number, windX: number, windZ: number, rain = 0): number {
  const ws = Math.hypot(windX, windZ);
  const d = Math.hypot(dx, dz);
  if (ws < 0.05 || d < 1e-3) return d < 1e-3 ? STALK.scentBase : 0;
  // The scent drifts from the person toward the animal: the way from them to it against the way the wind blows.
  const cos = (-dx * windX - dz * windZ) / (d * ws);
  if (cos <= STALK.scentCone) return 0;
  const edge = (cos - STALK.scentCone) / (1 - STALK.scentCone);
  const reach = Math.min(STALK.scentMax, STALK.scentBase + ws * STALK.scentPerMs);
  return reach * Math.sqrt(edge) * (1 - rain * (1 - STALK.rainScent));
}

/** What the animal makes of a person this second. */
export function notice(s: StalkSense): Notice {
  const d = Math.hypot(s.dx, s.dz);
  let rate = 0;
  // Eyes.
  let range = sightReach(s) * (1 - Math.min(1, s.cover) * STALK.coverCut);
  if (!s.nightEyes) range *= 1 - s.dark * STALK.darkCut;
  const seen = d < range;
  if (seen) rate += 0.25 + 1.6 * Math.sqrt(1 - d / range);
  // Ears.
  const hear = s.noise * STALK.hearPerPoint * (1 - s.rain * (1 - STALK.rainHush));
  const heard = d < hear;
  if (heard) rate += 0.2 + 0.9 * (1 - d / hear);
  // Nose: a whiff is enough.
  const sr = scentReach(s.dx, s.dz, s.windX, s.windZ, s.rain);
  const smelled = d < sr;
  if (smelled) rate += 1.8 + 2 * (1 - d / sr);
  return { rate, seen, heard, smelled };
}

/** One step of awareness: up by what it noticed, fading when it noticed nothing. Capped a little over 1. */
export function stepAwareness(aware: number, rate: number, dt: number): number {
  return rate > 0 ? Math.min(1.25, aware + rate * dt) : Math.max(0, aware - STALK.decay * dt);
}

// ------------------------------------------------------------------ shot placement

/** Where in the trunk a round went in: the heart and lungs behind the shoulder, the gut behind them, or the rest. */
export type TorsoPart = 'vitals' | 'gut' | 'body';

/**
 * Split a torso hit. `fwd` is how far ahead of the body's centre it went in (m), `relY` its height as a share of the
 * standing height (the top of the back). The heart and lungs sit low in the front half, behind the foreleg; the gut fills
 * the back third; a high shot through the back or a raking one through the haunch is just meat.
 */
export function torsoPart(kind: AnimalKind, fwd: number, relY: number, size = 1): TorsoPart {
  const b = BODY[kind];
  const half = (b.len * size) / 2;
  const f = fwd / Math.max(0.05, half);
  const belly = b.leg / Math.max(0.05, b.height);
  if (f < -0.2) return 'gut';
  if (f > 0.05 && f < 0.85 && relY >= belly - 0.04 && relY <= belly + (1 - belly) * 0.62) return 'vitals';
  return 'body';
}

/**
 * What a hit does in each part, beyond its damage: a damage multiplier, the bleed it opens (a share of the animal's full hit
 * points a second), and whether it taints the meat. A lung shot drops a deer within a short run; a gut shot is a long, slow
 * track and spoils a good part of the meat.
 */
export const SHOT: Record<TorsoPart | 'head' | 'leg', { mul: number; bleed: number; taint: boolean }> = {
  head: { mul: 1.8, bleed: 0.05, taint: false },
  vitals: { mul: 1.5, bleed: 0.07, taint: false },
  body: { mul: 1, bleed: 0.012, taint: false },
  gut: { mul: 0.8, bleed: 0.01, taint: true },
  leg: { mul: 1, bleed: 0.006, taint: false },
};

/** A short line for the shooter on a hit that did not drop it. */
export function hitLine(part: TorsoPart | 'head' | 'leg', name: string): string {
  switch (part) {
    case 'vitals':
      return `Lung shot: the ${name} won't go far. Follow the blood.`;
    case 'gut':
      return `Gut shot: the ${name} will run a long way. Give it time to bed down.`;
    case 'head':
      return `Grazed the ${name}'s head.`;
    case 'leg':
      return `Hit the ${name} in the leg.`;
    default:
      return `Hit the ${name}. It is bleeding.`;
  }
}

/**
 * A badly hit animal that has run out of sight lies down to stiffen, and a bedded one bleeds slower. It gets up and runs
 * again if it notices you coming: come in slow, from downwind, and finish it.
 */
export const BED = {
  /** Lies down once it has run this long, is bleeding, and is down to this share of its life. */
  afterRun: 4,
  hpShare: 0.6,
  /** No one within this many metres who it can see. */
  clear: 25,
  /** Bleed rate while bedded, as a share. */
  bleed: 0.5,
};

// ------------------------------------------------------------------ the carcass

/** Hides on each species (a camel, a buffalo or a bear gives several); birds and dogs none worth the knife. */
export const HIDES: Partial<Record<AnimalKind, number>> = {
  fox: 1,
  jackal: 1,
  wolf: 1,
  deer: 1,
  ibex: 1,
  boar: 1,
  camel: 2,
  buffalo: 3,
  bear: 3,
};

export type KillCause = 'shot' | 'blade' | 'blast' | 'fire' | 'vehicle' | 'bleed';

export interface CarcassState {
  /** Rations on the whole animal (the species' `meat`). */
  meat: number;
  /** Legs blown off it, and whether it is big game (meat 4 or more), which loses meat with them. */
  legsGone: number;
  /** A round through the gut, how many times it was hit, and what killed it. */
  tainted: boolean;
  hits: number;
  cause: KillCause;
  /** Head or heart-lung shot that dropped it within two hits. */
  clean: boolean;
  /** Seconds scavengers spent eating it. */
  eaten: number;
}

export interface Yield {
  rations: number;
  hides: number;
  /** What was lost and why, for the line on the HUD. */
  notes: string[];
}

/** What a carcass gives up to the knife. */
export function carcassYield(c: CarcassState, kind: AnimalKind): Yield {
  const notes: string[] = [];
  const big = c.meat >= 4;
  let m = c.meat;
  if (big && c.legsGone) m *= 1 - 0.1 * c.legsGone;
  if (c.tainted) {
    m *= 0.65;
    notes.push('gut-shot');
  }
  if (c.cause === 'blast') {
    m *= 0.5;
    notes.push('blown apart');
  } else if (c.cause === 'vehicle') {
    m *= 0.6;
    notes.push('roadkill');
  } else if (c.cause === 'fire') {
    m *= 0.8;
    notes.push('charred');
  }
  if (c.eaten > 0) {
    m *= Math.max(0.25, 1 - c.eaten / 24);
    notes.push('scavenged');
  }
  if (c.clean && big) {
    m *= 1.25;
    notes.push('clean kill');
  }
  // Small game is one ration, whatever happened to it, as long as something is left.
  const rations = big ? Math.max(2, Math.round(m)) : c.meat > 0 && m >= c.meat * 0.4 ? c.meat : 0;
  let hides = HIDES[kind] ?? 0;
  if (hides) {
    if (c.cause === 'blast' || c.cause === 'fire' || c.cause === 'vehicle') hides = 0;
    else if (c.hits >= 5) hides = Math.max(0, hides - 1);
    if (c.eaten > 12) hides = Math.max(0, hides - 1);
    if (!hides) notes.push('hide ruined');
  }
  return { rations, hides, notes };
}

/** Scrap the Ledger pays for each hide. */
export const HIDE_PRICE = 3;
