import { clamp, clamp01 } from '../core/math';
import { AMMO, type AmmoKind } from './ballistics';
import type { TreeSpecies } from '../world/flora';

/**
 * What gunfire does to a tree, as pure rules. A round that hits a trunk digs a crater: it takes a little of the wood's
 * section away at the height it struck, by the work it left in the wood. Rounds that land near the same height add up into a
 * notch, and when the notch has eaten enough of the section the tree goes over there on its own weight, leaving a stump.
 *
 * Gameplay numbers, tuned against the trees of the green country (trunks 0.35 to 1.4 m through): a young or thin tree goes
 * with a few full-power rifle rounds, a medium one takes an assault rifle's magazine or a handful of battle-rifle rounds, an
 * old gum or oak takes a machine gun's belt (or a charge). A pistol mostly chips bark: its rounds cannot reach the bottom of
 * a deepening notch. Buckshot shreds thin stems at close range and only peppers a trunk.
 */

export type WoodKind = TreeSpecies | 'deadTree';
type RGB = [number, number, number];

export interface WoodSpec {
  /** How hard the wood is to chew out and to go through, relative to a medium broadleaf (1). */
  hard: number;
  /** Bark flakes, the pale sapwood under it and the darker heartwood (linear RGB). */
  bark: RGB;
  sap: RGB;
  heart: RGB;
  /** Leaf colour; null for bare dead wood. */
  leaf: RGB | null;
  /** How readily the crown sheds when the tree is struck: a willow lets go of leaves, a palm hardly at all. */
  shed: number;
  /** Bark flakes per chip: a gum sheds long strips, a pine little plates, a palm fibres. */
  flake: number;
}

const hex = (h: number): RGB => {
  const s = (c: number) => ((c / 255) <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  return [s((h >> 16) & 255), s((h >> 8) & 255), s(h & 255)];
};

export const WOOD: Record<WoodKind, WoodSpec> = {
  oak: { hard: 1.3, bark: hex(0x4a3f35), sap: hex(0xd8c39a), heart: hex(0x9a744a), leaf: hex(0x4f6e2b), shed: 1, flake: 0.5 },
  pine: { hard: 0.8, bark: hex(0x5a3c2a), sap: hex(0xe8d09a), heart: hex(0xc49660), leaf: hex(0x31502f), shed: 0.45, flake: 0.6 },
  willow: { hard: 0.7, bark: hex(0x4a4236), sap: hex(0xe4d6b6), heart: hex(0xb89a76), leaf: hex(0x7f9b48), shed: 1.5, flake: 0.4 },
  poplar: { hard: 0.65, bark: hex(0x6e695e), sap: hex(0xece0c4), heart: hex(0xcbb690), leaf: hex(0x56792f), shed: 1.2, flake: 0.35 },
  palm: { hard: 0.95, bark: hex(0x5a4936), sap: hex(0xcdb88e), heart: hex(0x8c6a46), leaf: hex(0x6a8a3e), shed: 0.25, flake: 0.8 },
  acacia: { hard: 1.15, bark: hex(0x3e342c), sap: hex(0xdcbc8c), heart: hex(0x8a4a2c), leaf: hex(0x74874a), shed: 0.9, flake: 0.4 },
  cypress: { hard: 0.9, bark: hex(0x4e463e), sap: hex(0xdec59c), heart: hex(0xb48a5a), leaf: hex(0x5c7b34), shed: 0.7, flake: 0.7 },
  snag: { hard: 0.55, bark: hex(0x77705f), sap: hex(0xbcae90), heart: hex(0x8a7a62), leaf: null, shed: 0, flake: 0.8 },
  eucalyptus: { hard: 1.25, bark: hex(0xb8b0a2), sap: hex(0xe2b690), heart: hex(0x9a4a32), leaf: hex(0x5f7350), shed: 1.1, flake: 1.2 },
  deadTree: { hard: 0.5, bark: hex(0x6e6252), sap: hex(0xb8a68a), heart: hex(0x84725a), leaf: null, shed: 0, flake: 0.7 },
};

export const NOTCH = {
  /** Step between notch bands, metres along the trunk. Each band is two steps tall and overlaps its neighbours by half. */
  step: 0.25,
  /** Joules of a round's work that take one square metre of a medium trunk's section away. */
  work: 100_000,
  /** Share of the section gone at which an upright tree goes over on its own weight (the rest snaps as it tips). */
  crit: 0.62,
  /** One round never takes more than this share of a section: even a sapling needs a second. */
  maxPerHit: 0.45,
  /** Below this height (m) the root flare and the ground take the round: no notch is cut there. */
  floor: 0.2,
};

/** How much wood a joule of each round takes out of a trunk, relative to the intermediate rifle round. */
export const WOOD_BITE: Record<AmmoKind, number> = {
  pistol: 0.55, magnum: 0.8, smg: 0.5, pellet: 0.45, rifle: 1.8, sniper: 1.7, turret: 1.3, raider: 0.6, carbine: 1, battle: 1.8, lever: 1, bolt: 0.5, arrow: 0.1,
};

/** Metres of medium green wood each round goes through at its muzzle speed. */
export const WOOD_DEPTH: Record<AmmoKind, number> = {
  pistol: 0.1, magnum: 0.15, smg: 0.09, pellet: 0.035, rifle: 0.42, sniper: 0.38, turret: 0.3, raider: 0.1, carbine: 0.3, battle: 0.4, lever: 0.22, bolt: 0.12, arrow: 0.04,
};

/** Metres of a wood `hard` as hard as a medium broadleaf a round still going `speed` gets through. */
export function woodDepth(ammo: AmmoKind, speed: number, hard = 1): number {
  const v = speed / AMMO[ammo].speed;
  return (WOOD_DEPTH[ammo] * v * v) / Math.sqrt(Math.max(0.2, hard));
}

/** Speed a round leaves a trunk `thickness` metres thick at, or 0 if it stays in the wood. */
export function throughTrunk(ammo: AmmoKind, speed: number, thickness: number, hard = 1): number {
  const d = woodDepth(ammo, speed, hard);
  if (thickness >= d) return 0;
  return speed * Math.sqrt(1 - thickness / d);
}

/** Share of a round section a cut `h` of its diameter deep (from one side) takes away: the area of a circular segment. */
export function segmentShare(h: number): number {
  const c = 1 - 2 * clamp01(h);
  return (Math.acos(c) - c * Math.sqrt(Math.max(0, 1 - c * c))) / Math.PI;
}

/** How deep (share of the diameter) a notch cut in from one side is when it has taken `share` of the section. */
export function notchDepth(share: number): number {
  const f = clamp01(share);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (segmentShare(mid) < f) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface NotchHit {
  ammo: AmmoKind;
  /** Speed the round struck at, m/s. */
  speed: number;
  /** Work it left in the wood, J (what it lost going in, or all of it if it stayed). */
  work: number;
  /** Wood section at that height, m², and its diameter, m (as one round stem of the same area). */
  section: number;
  diameter: number;
  /** Share of the section already gone there. */
  done: number;
  /** The wood's hardness (WOOD[..].hard, less for charred wood). */
  hard: number;
}

/**
 * Share of the section one round takes away. A round that cannot reach the bottom of the notch any more (a pistol's in a
 * deep notch, buckshot in anything but a thin stem) only widens its mouth, and does far less.
 */
export function notchGain(h: NotchHit): number {
  if (h.work <= 0 || h.section <= 0) return 0;
  const depth = notchDepth(h.done) * h.diameter;
  const reach = woodDepth(h.ammo, h.speed, h.hard) * 1.6;
  const eff = depth <= reach ? 1 : (reach / depth) ** 1.5;
  const area = (h.work * WOOD_BITE[h.ammo] * eff) / (NOTCH.work * h.hard);
  return Math.min(NOTCH.maxPerHit, area / h.section);
}

/** Share of the section that has to go before the tree goes over: less for a tree that leans (rad) or in a storm's wind. */
export function snapShare(lean: number, storm = 0): number {
  return clamp(NOTCH.crit - 0.55 * Math.abs(lean) - 0.08 * clamp01(storm), 0.4, NOTCH.crit);
}

/** The two overlapping bands a hit `h` metres up the trunk counts in (band j spans [j, j + 2) steps). */
export function bandsAt(h: number): [number, number] {
  const j = Math.floor(h / NOTCH.step);
  return [j - 1, j];
}

/** Height (m up the trunk) of the middle of band `j`. */
export const bandMid = (j: number) => (j + 1) * NOTCH.step;

/**
 * Lay a hit's gain into a tree's notch bands (`bands[j]` is the share of the section gone in band j, grown as needed).
 * Hits below the root flare or above `top` (the branches) cut nothing. Returns the deepest band touched, or -1.
 */
export function addNotch(bands: number[], h: number, gain: number, top: number): number {
  if (h < NOTCH.floor || h > top || gain <= 0) return -1;
  let best = -1;
  const j1 = Math.floor(h / NOTCH.step);
  for (let j = j1 - 1; j <= j1; j++) {
    if (j < 0 || bandMid(j) > top + NOTCH.step) continue;
    while (bands.length <= j) bands.push(0);
    bands[j] = Math.min(1, bands[j] + gain);
    if (best < 0 || bands[j] > bands[best]) best = j;
  }
  return best;
}

/** The deepest band of a notch, or -1 when there is none. */
export function deepest(bands: readonly number[]): number {
  let best = -1;
  for (let j = 0; j < bands.length; j++) if (bands[j] > 0 && (best < 0 || bands[j] > bands[best])) best = j;
  return best;
}

/** Rounded copy for a save: three decimals of a share is plenty. */
export const packNotch = (bands: readonly number[]) => bands.map((b) => Math.round(b * 1000) / 1000);

/**
 * How many rounds it takes to bring a trunk of diameter `d` (m) down, all at one height and from the muzzle at close range.
 * For tests and tuning; the game counts real hits.
 */
export function shotsToSnap(ammo: AmmoKind, d: number, hard: number, lean = 0, pellets = 1): number {
  const section = (Math.PI * d * d) / 4;
  const spec = AMMO[ammo];
  const crit = snapShare(lean);
  let done = 0;
  for (let n = 1; n <= 2000; n++) {
    for (let k = 0; k < pellets; k++) {
      const speed = spec.speed;
      const exit = throughTrunk(ammo, speed, d, hard);
      const work = 0.5 * spec.mass * (speed * speed - exit * exit);
      done = Math.min(1, done + notchGain({ ammo, speed, work, section, diameter: d, done, hard }));
    }
    if (done >= crit) return n;
  }
  return Infinity;
}

// ------------------------------------------------------------------ what flies off

export interface WoodFx {
  /** Chips of pale wood and flakes of bark thrown off the hit. */
  chips: number;
  bark: number;
  /** Leaves shaken out of the crown. */
  leaves: number;
  /** Width of the scar left where the bark came off, m. */
  scar: number;
  /** Pitch and loudness of the knock in the wood. */
  pitch: number;
  loud: number;
  /** How fast the chips fly, m/s. */
  fling: number;
}

const CHIPS: Record<AmmoKind, number> = { pistol: 4, magnum: 6, smg: 3, pellet: 1, rifle: 10, sniper: 10, turret: 9, raider: 4, carbine: 7, battle: 10, lever: 7, bolt: 2, arrow: 0 };
const PITCH: Record<AmmoKind, number> = { pistol: 1.2, magnum: 1.05, smg: 1.25, pellet: 1.4, rifle: 0.85, sniper: 0.85, turret: 0.9, raider: 1.2, carbine: 1, battle: 0.85, lever: 0.95, bolt: 1.1, arrow: 1.3 };

/** What one round striking wood throws off, by the round and how much of its punch is left (`left`, 0..1 of its muzzle energy). */
export function woodFx(ammo: AmmoKind, left: number, wood: WoodKind): WoodFx {
  const e = clamp(left, 0.15, 1.2);
  const w = WOOD[wood];
  const chips = Math.max(ammo === 'arrow' ? 0 : 1, Math.round(CHIPS[ammo] * (0.5 + 0.5 * e)));
  return {
    chips,
    bark: Math.round(chips * w.flake * 0.5 + (ammo === 'pellet' ? 0 : 0.6)),
    leaves: w.leaf ? Math.round(w.shed * (ammo === 'pellet' ? 0.6 : 0.5 + 3.5 * AMMO[ammo].mass * AMMO[ammo].speed * e / 5)) : 0,
    scar: AMMO[ammo].hole * (ammo === 'pellet' ? 1.1 : 1.3),
    pitch: PITCH[ammo],
    loud: clamp(0.25 + 0.5 * e * (WOOD_BITE[ammo] / 1.8), 0.2, 0.8),
    fling: 3 + 4 * e * Math.min(1.2, WOOD_BITE[ammo]),
  };
}

/** Hit points a falling trunk takes off someone it strikes: by the mass coming down and how fast that part of it moves. */
export function crushDamage(mass: number, speed: number): number {
  if (speed < 2.5 || mass <= 0) return 0;
  return Math.min(420, Math.sqrt(mass) * (speed - 1.5) * 1.3);
}

/** Leaves of the bushes and tall plants a round can tear through, by plant kind (linear RGB). */
export const BUSH_LEAF: Partial<Record<string, RGB>> = {
  shrubs: hex(0x5a7a34), oleander: hex(0x3f5e2c), cane: hex(0x8a9a4a), reeds: hex(0x7a8a46), papyrus: hex(0x6a8a3a),
  ferns: hex(0x4e7a32), bramble: hex(0x3e5a2a), sabra: hex(0x6a8a4a), fig: hex(0x55782e),
};

/** How many leaves a round tears through a crown or a bush's leaves, by the round. */
export function leafTear(ammo: AmmoKind): number {
  return ammo === 'pellet' ? 1 : AMMO[ammo].mass * AMMO[ammo].speed > 3 ? 2 : 1;
}

/**
 * Share of a round's work a leafy plant takes from it (a bush, cane, a fig): enough that a magazine thins a bush and a few
 * shells of buckshot shred one. Buckshot shreds best: many small holes.
 */
export function shredShare(ammo: AmmoKind): number {
  return ammo === 'pellet' ? 1.8 : ammo === 'arrow' || ammo === 'bolt' ? 0.1 : 0.7;
}
