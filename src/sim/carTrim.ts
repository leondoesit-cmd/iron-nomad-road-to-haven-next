import { Rng } from '../core/rng';
import type { PanelId } from './paint';

/**
 * What sets one found car apart from another of the same model: the body it was sold as (a three-door or a five, an
 * estate, a flatbed, a windowed van), the bumpers, grille and lamps of its year, the wheels somebody put on it, the roof
 * rails, flaps and aerials, the state of its paint, and whatever was sprayed on it since. Pure data, rolled from the car's
 * own seed on a stream of its own, so it never moves any other roll of the car and is the same every time the car is
 * built (and after a save). The model draws it (render/carTrimKit.ts); nothing here changes how the car drives.
 *
 * The trim never moves a hard point: the glass panes, the cabin, the bed and the mount points are the chassis' own, so
 * the glass, cargo and car-work code see every variant of a model the same way. Variants that would have to move one
 * (a crew cab, a high roof) are not rolled.
 */

/** The body a car left the factory with (or was rebuilt into). One set per chassis. */
export type BodyStyle =
  // Hatchback.
  | 'hatch5'
  | 'hatch3'
  | 'hot'
  // Sedan.
  | 'saloon'
  | 'estate'
  | 'taxi'
  | 'patrol'
  // Pickup.
  | 'pickup'
  | 'flatbed'
  | 'tilt'
  | 'work'
  // Van.
  | 'panel'
  | 'windowed'
  | 'ambulance'
  | 'utility'
  // War truck.
  | 'dropside'
  | 'canvas'
  | 'gun'
  // War rig.
  | 'tanker'
  | 'hauler'
  | 'scrap';

export type BumperStyle = 'chrome' | 'plastic' | 'steel' | 'none' | 'bull';
export type GrilleStyle = 'bars' | 'mesh' | 'slats' | 'egg' | 'none';
export type LampStyle = 'round' | 'square' | 'twin' | 'wide';
export type RimStyle = 'steel' | 'alloy' | 'hubcap' | 'spoked' | 'white';
export type PaintScheme = 'solid' | 'twoTone' | 'faded' | 'primer' | 'rusty' | 'bleached' | 'patched';
export type TonePlace = 'roof' | 'lower' | 'doors';
export type Stencil = 'none' | 'number' | 'mark' | 'scrawl' | 'tally';

export interface CarTrim {
  body: BodyStyle;
  /** A sleeper cab behind the rig's day cab (the rig only). */
  sleeper: boolean;
  bumperF: BumperStyle;
  bumperR: BumperStyle;
  grille: GrilleStyle;
  lamps: LampStyle;
  rims: RimStyle;
  rimColor: number;
  /** The wheel that wears a different rim (the spare that went on after a puncture and stayed), or -1. */
  oddWheel: number;
  /** Roof rails along the gutters. */
  rails: boolean;
  mirrors: 'black' | 'chrome';
  flaps: boolean;
  /** 0 none, 1 a whip on the wing, 2 a CB on a spring base. */
  antenna: 0 | 1 | 2;
  /** Where a spare wheel rides when the car carries one of its own. */
  spare: 'none' | 'tail' | 'roof' | 'bonnet';
  /** Jerry cans strapped on (0..2). */
  cans: number;
  scheme: PaintScheme;
  /** Where the second colour of a two-tone goes. */
  tone: TonePlace;
  /** The second colour: the two-tone, the primer, the panel off another car. */
  second: number;
  /** The panel in primer or off another car. */
  patch: PanelId;
  stencil: Stencil;
  /** The number painted on, or which mark or word. */
  glyph: number;
  stencilColor: number;
  /** Ran with a gang once: war paint, spikes on the bumper, a bar cage over the windscreen. */
  raider: boolean;
}

/** The chassis that roll a trim. Bikes, the buggy and the trike are the convoy's own builds and look as they are built. */
const BODIES: Record<string, [BodyStyle, number][]> = {
  hatch: [['hatch5', 0.5], ['hatch3', 0.35], ['hot', 0.15]],
  sedan: [['saloon', 0.55], ['estate', 0.25], ['taxi', 0.1], ['patrol', 0.1]],
  pickup: [['pickup', 0.45], ['flatbed', 0.2], ['tilt', 0.15], ['work', 0.2]],
  van: [['panel', 0.45], ['windowed', 0.25], ['ambulance', 0.1], ['utility', 0.2]],
  truck: [['dropside', 0.4], ['canvas', 0.35], ['gun', 0.25]],
  rig: [['tanker', 0.45], ['hauler', 0.3], ['scrap', 0.25]],
};

export const hasTrim = (chassis: string): boolean => chassis in BODIES;

function weighted<T>(rng: Rng, table: [T, number][]): T {
  const total = table.reduce((a, [, w]) => a + w, 0);
  let r = rng.next() * total;
  for (const [v, w] of table) {
    r -= w;
    if (r <= 0) return v;
  }
  return table[table.length - 1][0];
}

const BUMPERS: Record<string, [BumperStyle, number][]> = {
  hatch: [['plastic', 0.5], ['chrome', 0.25], ['none', 0.12], ['steel', 0.05], ['bull', 0.08]],
  sedan: [['plastic', 0.42], ['chrome', 0.33], ['none', 0.12], ['steel', 0.05], ['bull', 0.08]],
  pickup: [['chrome', 0.25], ['steel', 0.35], ['plastic', 0.12], ['bull', 0.18], ['none', 0.1]],
  van: [['plastic', 0.5], ['steel', 0.2], ['chrome', 0.1], ['bull', 0.1], ['none', 0.1]],
  truck: [['steel', 0.7], ['bull', 0.3]],
  rig: [['steel', 0.55], ['chrome', 0.25], ['bull', 0.2]],
};
const LAMPS: Record<string, [LampStyle, number][]> = {
  hatch: [['round', 0.3], ['square', 0.45], ['wide', 0.25]],
  sedan: [['round', 0.2], ['square', 0.35], ['twin', 0.25], ['wide', 0.2]],
  pickup: [['round', 0.35], ['square', 0.4], ['twin', 0.25]],
  van: [['square', 0.5], ['round', 0.3], ['wide', 0.2]],
  truck: [['round', 0.6], ['twin', 0.4]],
  rig: [['round', 0.4], ['square', 0.3], ['twin', 0.3]],
};

const RIM_COLORS: Record<RimStyle, number[]> = {
  steel: [0x6a6c6e, 0x2a2a2a, 0x3a3c3e, 0x4a4c4e],
  alloy: [0xb8bcc0, 0x8a8e92, 0x2a2c2e],
  hubcap: [0xb0b4b8, 0x9a9ea2],
  spoked: [0x9a9ea2, 0x2a2a2a],
  white: [0xe2ded2],
};

const TWO_TONE = [0xe9e4d6, 0x1c1c1c, 0xc8b88a, 0x6a6c6e, 0x2a3a5a];
const PRIMER = [0x7a7c78, 0x7a3a2a, 0x3a3c3a, 0x8a8a84];
/** Paint off other cars, for the panel that came from one. */
const DONOR = [0xb85f2e, 0xc9b084, 0x5c6b3e, 0x4d6a82, 0xd8d0c0, 0x8c2e26, 0x23231f, 0x3f8a84, 0xcf9f2b];
const STENCIL = [0xf0ece0, 0x1a1a1a, 0xc8321e, 0xe0be1a];

/** How many scrawled words and marks the model knows (see render/carTrimKit.ts). */
export const SCRAWLS = ['HELP', 'NO GAS', 'EMPTY', 'DEAD', 'KEEP OUT', 'TAKEN', 'SOLD', 'GONE SOUTH'];
export const MARKS = 6;

/**
 * The trim of a car, from its chassis and seed alone, or null for a chassis that has none. Its own stream: the seed is
 * mixed with a constant no other roll uses, so adding or reordering rolls here never shifts the car's parts or damage.
 */
export function rollTrim(chassis: string, seed: number): CarTrim | null {
  const bodies = BODIES[chassis];
  if (!bodies) return null;
  const rng = new Rng((Math.imul(seed | 0, 0x2c1b3c6d) ^ 0x7e3a91c5) >>> 0);
  const body = weighted(rng, bodies);
  const sleeper = rng.chance(0.55);
  let bumperF = weighted(rng, BUMPERS[chassis]);
  // The rear mostly matches the front; now and then it was lost in some old shunt, or a pickup has a step bumper.
  const rr = rng.next();
  let bumperR: BumperStyle = bumperF === 'bull' ? (chassis === 'pickup' || chassis === 'van' ? 'steel' : 'plastic') : bumperF;
  if (rr < 0.1) bumperR = 'none';
  else if (rr < 0.2 && chassis === 'pickup') bumperR = 'steel';
  const grille = weighted<GrilleStyle>(rng, [['bars', 0.35], ['mesh', 0.25], ['slats', 0.2], ['egg', 0.12], ['none', 0.08]]);
  const lamps = weighted(rng, LAMPS[chassis]);
  let rims = weighted<RimStyle>(rng, [['steel', 0.4], ['hubcap', 0.25], ['alloy', 0.2], ['spoked', 0.1], ['white', 0.05]]);
  const rimPick = rng.next();
  const oddRoll = rng.next();
  const oddIdx = rng.next();
  const rails = rng.chance(chassis === 'van' ? 0.35 : chassis === 'pickup' ? 0.12 : 0.22);
  const mirrors = rng.chance(0.35) ? 'chrome' : 'black';
  const flaps = rng.chance(chassis === 'pickup' || chassis === 'van' || chassis === 'truck' ? 0.4 : 0.15);
  const ar = rng.next();
  const antenna: CarTrim['antenna'] = ar < 0.5 ? 0 : ar < (chassis === 'pickup' || chassis === 'van' ? 0.75 : 0.9) ? 1 : 2;
  const sr = rng.next();
  let spare: CarTrim['spare'] = 'none';
  if (chassis === 'pickup') spare = sr < 0.12 ? 'bonnet' : 'none';
  else if (chassis === 'van') spare = sr < 0.22 ? 'tail' : sr < 0.3 ? 'roof' : 'none';
  else if (chassis === 'hatch') spare = sr < 0.1 ? 'tail' : sr < 0.14 ? 'roof' : 'none';
  else if (chassis === 'truck' || chassis === 'rig') spare = sr < 0.7 ? 'tail' : 'none';
  const cans = rng.chance(chassis === 'pickup' || chassis === 'van' || chassis === 'truck' ? 0.32 : 0.1) ? rng.int(1, 2) : 0;
  let scheme = weighted<PaintScheme>(rng, [['solid', 0.4], ['twoTone', 0.12], ['faded', 0.16], ['primer', 0.1], ['rusty', 0.1], ['bleached', 0.07], ['patched', 0.05]]);
  let tone = weighted<TonePlace>(rng, [['roof', 0.5], ['lower', 0.35], ['doors', 0.15]]);
  const sc = rng.next();
  const patch = rng.pick<PanelId>(['hood', 'doorL', 'doorR', 'front', 'rear']);
  const stencil = weighted<Stencil>(rng, [['none', 0.6], ['number', 0.12], ['mark', 0.1], ['scrawl', 0.1], ['tally', 0.08]]);
  const glyphRoll = rng.next();
  const stencilColor = rng.pick(STENCIL);
  const raider = rng.chance(chassis === 'truck' || chassis === 'rig' ? 0 : 0.05);
  // What the body implies: the trim of a taxi, a patrol car or a hot hatch is part of what it is.
  if (body === 'patrol') {
    bumperF = 'bull';
    rims = 'steel';
    scheme = 'twoTone';
    tone = 'doors';
  } else if (body === 'taxi') {
    bumperF = bumperR = 'plastic';
    rims = 'hubcap';
  } else if (body === 'hot') {
    rims = 'alloy';
    if (bumperF === 'bull' || bumperF === 'chrome') bumperF = 'plastic';
    bumperR = bumperR === 'none' ? 'none' : 'plastic';
  } else if (body === 'ambulance') {
    scheme = scheme === 'rusty' || scheme === 'faded' ? scheme : 'twoTone';
    tone = 'lower';
  }
  if (chassis === 'truck' || chassis === 'rig') {
    // Heavy iron: steel or spoked wheels, never a hubcap or an alloy.
    if (rims === 'hubcap' || rims === 'alloy' || rims === 'white') rims = 'steel';
  }
  const cols = RIM_COLORS[rims];
  const second = scheme === 'primer' ? PRIMER[Math.floor(sc * PRIMER.length)] : scheme === 'patched' ? DONOR[Math.floor(sc * DONOR.length)] : body === 'patrol' || body === 'ambulance' ? 0xeceae2 : TWO_TONE[Math.floor(sc * TWO_TONE.length)];
  const glyph = stencil === 'number' ? 1 + Math.floor(glyphRoll * 99) : stencil === 'scrawl' ? Math.floor(glyphRoll * SCRAWLS.length) : stencil === 'mark' ? Math.floor(glyphRoll * MARKS) : 2 + Math.floor(glyphRoll * 9);
  return {
    body,
    sleeper,
    bumperF,
    bumperR,
    grille,
    lamps,
    rims,
    rimColor: cols[Math.floor(rimPick * cols.length)],
    oddWheel: oddRoll < 0.18 ? Math.floor(oddIdx * 4) : -1,
    rails,
    mirrors,
    flaps,
    antenna,
    spare,
    cans,
    scheme,
    tone,
    second,
    patch,
    stencil,
    glyph,
    stencilColor,
    raider,
  };
}

/** A stable string for the trim, for shell cache keys: two cars with equal keys draw the same body. */
export function trimKey(t: CarTrim | null | undefined): string {
  if (!t) return '';
  return [
    t.body,
    t.sleeper ? 's' : 'd',
    t.bumperF,
    t.bumperR,
    t.grille,
    t.lamps,
    t.rims,
    t.rimColor.toString(16),
    t.oddWheel,
    t.rails ? 'r' : '',
    t.mirrors,
    t.flaps ? 'f' : '',
    t.antenna,
    t.spare,
    t.cans,
    t.scheme,
    t.tone,
    t.second.toString(16),
    t.patch,
    t.stencil,
    t.glyph,
    t.stencilColor.toString(16),
    t.raider ? 'x' : '',
  ].join('.');
}
