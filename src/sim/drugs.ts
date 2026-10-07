/**
 * Drugs: single-dose consumables with an onset, a peak, a comedown, and a body that keeps score.
 * Pure simulation (no rendering, no input) so every number can be tested. One `DrugState` lives on each player and is
 * saved with the campaign, so a trip carries across a camp, a delve and a reload.
 *
 *  - Each drug has a timeline: onset (effects fade in), peak, taper, comedown. Some stack (alcohol, weed): every dose
 *    adds time and strength. Others just reset the clock.
 *  - Effects are `mods` (what the body does: speed, damage, noise, sway, sight...) and a `look` (what the player
 *    sees: hue swim, warp, double vision, trails, kaleidoscope, sky, breathing ground...). Both are sums over the
 *    active drugs, plus whatever the active blends add.
 *  - Mixing is the game inside the game: named blends reward some pairs, interactions make others dangerous, and
 *    ayahuasca amplifies whatever else is in the system.
 *  - Every dose adds toxicity (past 1 you are overdosing), dependence (withdrawal when you go without) and
 *    tolerance (the same dose hits softer next time).
 *  - Things that happen to you (vomiting, stumbling, laughing at the wrong moment, blacking out, a flashback)
 *    come out as `events` for the player to act on.
 */

export type DrugId = 'painkiller' | 'stim' | 'adrenaline' | 'alcohol' | 'weed' | 'haze' | 'mushrooms' | 'lsd' | 'ayahuasca';
/** Belt order: medicine first, then the party. */
export const DRUG_IDS: DrugId[] = ['painkiller', 'stim', 'adrenaline', 'alcohol', 'weed', 'haze', 'mushrooms', 'lsd', 'ayahuasca'];

// ------------------------------------------------------------------------------------------------ mods

export interface DrugMods {
  // Multipliers: 1 changes nothing.
  /** Walk and sprint speed. */
  speed: number;
  /** Damage taken (lower is tougher). */
  damage: number;
  /** Noise made (footsteps, shots, swings). */
  noise: number;
  /** Weapon spread. */
  spread: number;
  /** How far away the dead notice you. */
  aggro: number;
  /** Rations eaten at camp. */
  appetite: number;
  /** Melee damage dealt. */
  melee: number;
  // Additive: 0 changes nothing.
  /** Camera shake. */
  shake: number;
  /** Health regained per second. */
  regen: number;
  /** Body and aim sway: the drunk lurch. */
  sway: number;
  /** How hard the stomach is turning. */
  nausea: number;
  /** How likely you are to burst out laughing, hiccuping or singing. */
  outburst: number;
  /** How many things that are not there you see. */
  phantoms: number;
  /** Seeing through walls: 0 nothing, 1 the whole neighbourhood. */
  sight: number;
  /** Psychedelic intensity, for anything that needs a single number. */
  trip: number;
  /** Health lost per second to overdose. */
  poison: number;
}

export const MULT_KEYS = ['speed', 'damage', 'noise', 'spread', 'aggro', 'appetite', 'melee'] as const;
export const ADD_KEYS = ['shake', 'regen', 'sway', 'nausea', 'outburst', 'phantoms', 'sight', 'trip', 'poison'] as const;

export const NEUTRAL: DrugMods = {
  speed: 1,
  damage: 1,
  noise: 1,
  spread: 1,
  aggro: 1,
  appetite: 1,
  melee: 1,
  shake: 0,
  regen: 0,
  sway: 0,
  nausea: 0,
  outburst: 0,
  phantoms: 0,
  sight: 0,
  trip: 0,
  poison: 0,
};

/** Fold `src` into `out` at strength `k`: multipliers are raised to the power, additive terms are scaled. */
function foldMods(out: DrugMods, src: Partial<DrugMods> | undefined, k: number) {
  if (!src || k <= 0) return;
  for (const key of MULT_KEYS) {
    const v = src[key];
    if (v !== undefined) out[key] *= Math.pow(v, k);
  }
  for (const key of ADD_KEYS) {
    const v = src[key];
    if (v !== undefined) out[key] += v * k;
  }
}

function clampMods(m: DrugMods) {
  m.speed = clamp(m.speed, 0.35, 1.6);
  m.damage = clamp(m.damage, 0.2, 2);
  m.noise = clamp(m.noise, 0.3, 2.5);
  m.spread = clamp(m.spread, 0.4, 3);
  m.aggro = clamp(m.aggro, 0.3, 1.6);
  m.appetite = clamp(m.appetite, 0.5, 3);
  m.melee = clamp(m.melee, 0.5, 2);
  m.shake = clamp(m.shake, 0, 1);
  m.regen = clamp(m.regen, 0, 3);
  m.sway = clamp(m.sway, 0, 1);
  m.nausea = clamp(m.nausea, 0, 2);
  m.outburst = clamp(m.outburst, 0, 1);
  m.phantoms = clamp(m.phantoms, 0, 1);
  m.sight = clamp(m.sight, 0, 1);
  m.trip = clamp(m.trip, 0, 1.2);
  m.poison = Math.max(0, m.poison);
}

// ------------------------------------------------------------------------------------------------ look

/** What the player sees. All additive; 0 changes nothing. The renderer maps these onto shader and world effects. */
export interface Look {
  /** Hue swim (colours drift around the wheel, and swirl across the screen). */
  hue: number;
  /** Saturation (negative washes out). */
  sat: number;
  /** Wavy distortion of the picture. */
  warp: number;
  /** Chromatic aberration. */
  chroma: number;
  /** Double vision. */
  dbl: number;
  /** Kaleidoscope fold toward the edges. */
  kaleido: number;
  /** Vignette tightening: tunnel vision. */
  tunnel: number;
  /** Heartbeat breathing of the picture. */
  pulse: number;
  blur: number;
  /** Neon outlines. */
  edge: number;
  /** Bloom. */
  glow: number;
  /** Eyelids closing: 1 is black. */
  dark: number;
  /** Motion trails. */
  trail: number;
  /** Camera roll (the drunk tilt). */
  roll: number;
  /** Exposure. */
  bright: number;
  tintR: number;
  tintG: number;
  tintB: number;
  /** Sky: aurora and stars in daylight. */
  sky: number;
  /** An eye in the sky. */
  eye: number;
  /** The world breathes: ground and walls swell and sink. */
  breathe: number;
  /** Floating motes. */
  spores: number;
  /** Giant mushrooms grow around you. */
  mush: number;
  /** Speed of the visuals (0 is normal; negative is slow motion). */
  tempo: number;
}

export const LOOK_KEYS: (keyof Look)[] = [
  'hue', 'sat', 'warp', 'chroma', 'dbl', 'kaleido', 'tunnel', 'pulse', 'blur', 'edge', 'glow', 'dark', 'trail', 'roll', 'bright',
  'tintR', 'tintG', 'tintB', 'sky', 'eye', 'breathe', 'spores', 'mush', 'tempo',
];

/** Spatial distortion only; colour, trails and hallucinations keep their normal strength and timing. */
export const MORPH_KEYS = ['warp', 'kaleido', 'pulse', 'breathe'] as const satisfies readonly (keyof Look)[];
const DEFAULT_MORPH_STRENGTH = 0.8;
const MORPH_STRENGTH = 0.8;
const MORPH_DURATION = 0.7;

export const NO_LOOK: Look = Object.freeze({
  hue: 0, sat: 0, warp: 0, chroma: 0, dbl: 0, kaleido: 0, tunnel: 0, pulse: 0, blur: 0, edge: 0, glow: 0, dark: 0, trail: 0, roll: 0, bright: 0,
  tintR: 0, tintG: 0, tintB: 0, sky: 0, eye: 0, breathe: 0, spores: 0, mush: 0, tempo: 0,
}) as Look;

const LOOK_RANGE: Partial<Record<keyof Look, [number, number]>> = {
  sat: [-1, 1.5],
  bright: [-0.5, 0.6],
  tintR: [-0.3, 0.3],
  tintG: [-0.3, 0.3],
  tintB: [-0.3, 0.3],
  tempo: [-0.6, 0.6],
};

function foldLook(out: Look, src: Partial<Look> | undefined, k: number, morphK = k) {
  if (!src || k <= 0) return;
  for (const key of LOOK_KEYS) {
    const v = src[key];
    if (v !== undefined) out[key] += v * ((MORPH_KEYS as readonly (keyof Look)[]).includes(key) ? morphK : k);
  }
}

function clampLook(l: Look) {
  for (const key of LOOK_KEYS) {
    const [lo, hi] = LOOK_RANGE[key] ?? [0, 1];
    l[key] = clamp(l[key], lo, hi);
  }
}

// ------------------------------------------------------------------------------------------------ the drugs

export type DrugClass = 'medical' | 'stimulant' | 'depressant' | 'psychedelic';

export interface DrugDef {
  id: DrugId;
  name: string;
  /** One line for the dose note and the Ledger. */
  blurb: string;
  cls: DrugClass;
  /** A single letter and a colour for the belt. */
  glyph: string;
  color: string;
  /** Seconds for the effects to fade in. */
  onset: number;
  /** Seconds one dose lasts. */
  duration: number;
  /** Seconds the effect tapers off at the end (drugs that do not stack). */
  taper: number;
  /** Seconds of comedown after the effect ends. */
  crash: number;
  /** `stack`: each dose adds time and strength up to `maxStack` doses. `refresh`: a dose just restarts the clock. */
  stack: 'stack' | 'refresh';
  maxStack: number;
  /** Instant health restored. */
  heal: number;
  /** Toxicity per dose. */
  tox: number;
  /** Dependence per dose. */
  dep: number;
  /** Tolerance per dose: the next one lands this much softer. */
  tol: number;
  /** Effects while it works, per unit of strength. */
  on: Partial<DrugMods>;
  /** Effects that only show while it is coming on, shaped like a bump over the onset. */
  front?: Partial<DrugMods>;
  /** Effects during the comedown. */
  down: Partial<DrugMods>;
  look: Partial<Look>;
  lookDown?: Partial<Look>;
  /** Whatever else is in the system lands this much harder while this one works. */
  amplifies?: number;
}

export const DRUGS: Record<DrugId, DrugDef> = {
  painkiller: {
    id: 'painkiller',
    name: 'Painkillers',
    blurb: 'Half damage for 90s. Eases drug morphing by a further 20% and cuts its remaining time by 30%. A sore comedown.',
    cls: 'medical',
    glyph: 'P',
    color: '#9ad0ff',
    onset: 6,
    duration: 90,
    taper: 15,
    crash: 20,
    stack: 'refresh',
    maxStack: 1,
    heal: 0,
    tox: 0.2,
    dep: 0.1,
    tol: 0.1,
    on: { damage: 0.5 },
    down: { speed: 0.92, shake: 0.1 },
    look: { sat: -0.22, blur: 0.08, glow: 0.08 },
  },
  stim: {
    id: 'stim',
    name: 'Stim',
    blurb: 'Run 25% faster for 40s. The crash costs you.',
    cls: 'stimulant',
    glyph: 'S',
    color: '#ffd24a',
    onset: 4,
    duration: 40,
    taper: 8,
    crash: 25,
    stack: 'refresh',
    maxStack: 1,
    heal: 0,
    tox: 0.35,
    dep: 0.15,
    tol: 0.12,
    on: { speed: 1.25, shake: 0.12, spread: 1.12 },
    down: { speed: 0.86 },
    look: { chroma: 0.06, tunnel: 0.12, pulse: 0.18, sat: 0.08, bright: 0.05 },
  },
  adrenaline: {
    id: 'adrenaline',
    name: 'Adrenaline',
    blurb: 'Heal 30, take 70% less damage for 12s, wake from anything. Then a hard crash.',
    cls: 'stimulant',
    glyph: 'A',
    color: '#ff6a5a',
    onset: 1,
    duration: 12,
    taper: 3,
    crash: 30,
    stack: 'refresh',
    maxStack: 1,
    heal: 30,
    tox: 0.45,
    dep: 0.1,
    tol: 0.1,
    on: { speed: 1.15, damage: 0.3, shake: 0.2 },
    down: { speed: 0.78, shake: 0.2 },
    look: { tunnel: 0.35, pulse: 0.45, chroma: 0.12, sat: 0.15, bright: 0.1, tempo: -0.3 },
  },
  alcohol: {
    id: 'alcohol',
    name: 'Moonshine',
    blurb: 'Liquid courage. Each drink hits harder, and past four the floor comes up to meet you.',
    cls: 'depressant',
    glyph: 'M',
    color: '#ffb25a',
    onset: 12,
    duration: 70,
    taper: 0,
    crash: 80,
    stack: 'stack',
    maxStack: 6,
    heal: 0,
    tox: 0.17,
    dep: 0.12,
    tol: 0.03,
    on: { damage: 0.93, melee: 1.18, noise: 1.08, sway: 0.2, spread: 1.18, speed: 0.985, aggro: 1.06, outburst: 0.1, nausea: 0.1 },
    down: { speed: 0.94, shake: 0.12, spread: 1.2 },
    look: { dbl: 0.3, roll: 0.45, blur: 0.08, warp: 0.1, tintR: 0.05, tintG: 0.015, tintB: -0.04, tunnel: 0.1, glow: 0.08, tempo: -0.1 },
    lookDown: { glow: 0.3, blur: 0.1, sat: -0.12, bright: 0.08, tunnel: 0.1 },
  },
  weed: {
    id: 'weed',
    name: 'Weed',
    blurb: 'Slow, quiet, hungry. The dead lose interest. Settles the stomach.',
    cls: 'depressant',
    glyph: 'W',
    color: '#7ddc7a',
    onset: 10,
    duration: 80,
    taper: 0,
    crash: 25,
    stack: 'stack',
    maxStack: 3,
    heal: 0,
    tox: 0.06,
    dep: 0.05,
    tol: 0.05,
    on: { speed: 0.9, noise: 0.6, aggro: 0.78, damage: 0.93, spread: 0.9, appetite: 1.8, sway: 0.05, outburst: 0.06, phantoms: 0.05, trip: 0.12, nausea: -0.55 },
    down: { speed: 0.92, appetite: 1.4 },
    look: { sat: 0.3, glow: 0.3, blur: 0.08, trail: 0.22, hue: 0.07, tintR: -0.02, tintG: 0.05, tintB: -0.02, spores: 0.35, tempo: -0.25, pulse: 0.08 },
    lookDown: { sat: -0.05, glow: 0.1 },
  },
  haze: {
    id: 'haze',
    name: 'Spore haze',
    blurb: 'Quiet and slow-healing for 60s. The world swims. Hard to put down.',
    cls: 'psychedelic',
    glyph: 'H',
    color: '#c58aff',
    onset: 8,
    duration: 60,
    taper: 10,
    crash: 15,
    stack: 'refresh',
    maxStack: 1,
    heal: 0,
    tox: 0.15,
    dep: 0.3,
    tol: 0.1,
    on: { noise: 0.7, regen: 0.6, speed: 0.95, shake: 0.3, trip: 0.25 },
    down: {},
    look: { hue: 0.18, sat: 0.3, warp: 0.22, blur: 0.1, spores: 0.5, glow: 0.15, tintG: 0.03 },
  },
  mushrooms: {
    id: 'mushrooms',
    name: 'Mushrooms',
    blurb: 'Feel the mycelium: the living glow through walls. Gut-churning on the way up, and the giggles.',
    cls: 'psychedelic',
    glyph: 'U',
    color: '#e08aff',
    onset: 30,
    duration: 110,
    taper: 20,
    crash: 25,
    stack: 'refresh',
    maxStack: 1,
    heal: 0,
    tox: 0.14,
    dep: 0,
    tol: 0.3,
    on: { sight: 0.55, regen: 0.2, aggro: 0.9, speed: 0.98, shake: 0.05, outburst: 0.1, phantoms: 0.35, trip: 0.6 },
    front: { nausea: 1.0 },
    down: {},
    look: { hue: 0.4, sat: 0.65, warp: 0.45, chroma: 0.2, kaleido: 0.08, pulse: 0.6, glow: 0.35, breathe: 0.55, sky: 0.45, spores: 1, mush: 1, tintR: 0.03, tintB: 0.06, tempo: -0.15, trail: 0.15 },
    lookDown: { sat: 0.1, glow: 0.1, mush: 0.2 },
  },
  lsd: {
    id: 'lsd',
    name: 'LSD',
    blurb: 'Two and a half minutes of everything. Auras on the dead, and company that is not there. Tolerance builds fast.',
    cls: 'psychedelic',
    glyph: 'L',
    color: '#5ad6ff',
    onset: 25,
    duration: 150,
    taper: 25,
    crash: 40,
    stack: 'refresh',
    maxStack: 1,
    heal: 0,
    tox: 0.12,
    dep: 0,
    tol: 0.5,
    on: { speed: 1.08, sight: 0.2, phantoms: 0.6, trip: 0.9, sway: 0.1, shake: 0.1, spread: 1.3 },
    down: { speed: 0.92 },
    look: { hue: 0.95, sat: 0.75, warp: 0.5, chroma: 0.45, kaleido: 0.3, trail: 0.55, edge: 0.45, pulse: 0.25, glow: 0.3, breathe: 0.8, sky: 0.85, spores: 0.55, bright: 0.08, tempo: 0.15 },
    lookDown: { hue: 0.1, trail: 0.1, glow: 0.1 },
  },
  ayahuasca: {
    id: 'ayahuasca',
    name: 'Ayahuasca',
    blurb: 'Three and a half minutes. It purges you first, then shows you everything: the dead, the loot, the road. It amplifies whatever else you took.',
    cls: 'psychedelic',
    glyph: 'Y',
    color: '#ffcf5a',
    onset: 60,
    duration: 210,
    taper: 30,
    crash: 60,
    stack: 'refresh',
    maxStack: 1,
    heal: 0,
    tox: 0.3,
    dep: 0,
    tol: 0.4,
    amplifies: 0.35,
    on: { sight: 1, trip: 1, phantoms: 0.5, speed: 0.85, shake: 0.15, aggro: 0.8, spread: 1.4, regen: 0.3, sway: 0.25 },
    front: { nausea: 1.5 },
    down: { speed: 0.9, shake: 0.1 },
    look: { hue: 0.5, sat: 0.6, warp: 0.5, chroma: 0.3, kaleido: 0.45, trail: 0.35, edge: 0.4, pulse: 0.4, glow: 0.4, breathe: 1, sky: 1, eye: 1, spores: 0.8, tunnel: 0.15, tintG: 0.03, tintB: 0.05, tempo: -0.2 },
    lookDown: { hue: 0.1, glow: 0.15, dark: 0.05 },
  },
};

// ------------------------------------------------------------------------------------------------ blends and interactions

/**
 * Pairs (and a few trios) that do something on their own when both are working. Strength is the weakest ingredient's
 * strength, so a blend fades as soon as one of its drugs does.
 */
export interface BlendDef {
  id: string;
  name: string;
  needs: DrugId[];
  blurb: string;
  mods?: Partial<DrugMods>;
  look?: Partial<Look>;
  /** Extra toxicity per second while it runs: the dangerous mixes. */
  toxRate?: number;
  /** Things that are not there are friendly. */
  friendly?: boolean;
}

export const BLENDS: BlendDef[] = [
  {
    id: 'couchlock',
    name: 'Couchlock',
    needs: ['alcohol', 'weed'],
    blurb: 'Nothing can find you if you cannot move.',
    mods: { speed: 0.78, noise: 0.75, sway: 0.15, damage: 0.9, appetite: 1.3, aggro: 0.85 },
    look: { blur: 0.18, trail: 0.15 },
  },
  {
    id: 'wired',
    name: 'Wired',
    needs: ['alcohol', 'stim'],
    blurb: 'The stim hides the drunk. The drunk does not care and keeps going.',
    mods: { sway: -0.22, shake: -0.08 },
    toxRate: 0.004,
  },
  {
    id: 'liver',
    name: 'Liver Roulette',
    needs: ['alcohol', 'painkiller'],
    blurb: 'You feel nothing, which is the problem.',
    mods: { damage: 0.85 },
    toxRate: 0.012,
  },
  {
    id: 'messy',
    name: 'Messy Night',
    needs: ['alcohol', 'lsd'],
    blurb: 'The room is spinning. Some of the people in it are not real.',
    mods: { phantoms: 0.2, sway: 0.15, outburst: 0.1 },
    look: { warp: 0.2, dbl: 0.2 },
  },
  {
    id: 'dreamscape',
    name: 'Dreamscape',
    needs: ['weed', 'lsd'],
    blurb: 'Everything is soft and nothing wants to hurt you. The things that are not there are friendly.',
    mods: { aggro: 0.8, speed: 0.95 },
    look: { trail: 0.3, hue: 0.2, glow: 0.2 },
    friendly: true,
  },
  {
    id: 'giggle',
    name: 'Giggle Fit',
    needs: ['weed', 'mushrooms'],
    blurb: 'The stomach settles. The laughing does not.',
    mods: { outburst: 0.35, nausea: -0.6, sight: 0.1 },
    look: { sat: 0.2 },
  },
  {
    id: 'deep',
    name: 'Deep Trip',
    needs: ['lsd', 'mushrooms'],
    blurb: 'The walls open. So do the shadows.',
    mods: { sight: 0.3, phantoms: 0.4, speed: 1.05, trip: 0.3 },
    look: { kaleido: 0.35, warp: 0.25, mush: 0.3, hue: 0.3 },
  },
  {
    id: 'spirit',
    name: 'Spirit Walk',
    needs: ['mushrooms', 'ayahuasca'],
    blurb: 'The forest and the vine agree: you are not alone, and neither is anything else.',
    mods: { sight: 0.2, nausea: 0.4 },
    look: { eye: 0.3, mush: 0.3, spores: 0.2 },
  },
  {
    id: 'overdrive',
    name: 'Overdrive',
    needs: ['stim', 'lsd'],
    blurb: 'Faster, brighter, narrower.',
    mods: { speed: 1.1 },
    look: { tunnel: 0.3, trail: 0.3, chroma: 0.2 },
    toxRate: 0.004,
  },
  {
    id: 'focus',
    name: 'Zen Focus',
    needs: ['stim', 'weed'],
    blurb: 'The edges of each cancel the other. Steady hands.',
    mods: { spread: 0.55, shake: -0.15, speed: 1.1 },
  },
  {
    id: 'purgefest',
    name: 'Purge Fest',
    needs: ['alcohol', 'ayahuasca'],
    blurb: 'The vine wants it all out, and it was not subtle about asking.',
    mods: { nausea: 0.8 },
  },
  {
    id: 'heartrace',
    name: 'Heart Race',
    needs: ['stim', 'adrenaline'],
    blurb: 'Both hearts want out.',
    mods: { shake: 0.3 },
    look: { pulse: 0.3, tunnel: 0.2 },
    toxRate: 0.02,
  },
];

/** Dose-time toxicity multipliers for dangerous pairs: taking `a` while `b` is working, or the other way round. */
export const INTERACTIONS: { a: DrugId; b: DrugId; tox: number; note: string }[] = [
  { a: 'alcohol', b: 'painkiller', tox: 1.8, note: 'Booze and painkillers do not mix' },
  { a: 'alcohol', b: 'stim', tox: 1.4, note: 'The stim is hiding how drunk you are' },
  { a: 'alcohol', b: 'adrenaline', tox: 1.3, note: 'Your heart is racing against the booze' },
  { a: 'stim', b: 'adrenaline', tox: 1.6, note: 'Two things telling your heart to run' },
  { a: 'ayahuasca', b: 'stim', tox: 2, note: 'The vine and a stimulant: the worst idea you have had today' },
  { a: 'ayahuasca', b: 'adrenaline', tox: 2, note: 'The vine and adrenaline: the worst idea you have had today' },
  { a: 'ayahuasca', b: 'alcohol', tox: 1.4, note: 'The vine and booze: this will come back up' },
  { a: 'ayahuasca', b: 'painkiller', tox: 1.3, note: 'The vine does not like painkillers' },
  { a: 'lsd', b: 'stim', tox: 1.15, note: 'Your heart is a drum' },
];

// ------------------------------------------------------------------------------------------------ constants

export const TOX_OVERDOSE = 1;
export const TOX_DECAY = 0.012;
export const DEP_DECAY = 0.002;
export const TOL_DECAY = 0.0015;
/** Tolerance that takes this much off a dose's strength. */
export const TOL_MAX_CUT = 0.6;
/** Seconds without a dose before a dependent body starts to withdraw, and how long it takes to reach the worst of it. */
export const WITHDRAW_AFTER = 90;
export const WITHDRAW_RAMP = 60;
const OVERDOSE_DPS = 5;
/** A drug counts as working for blends and sensing once it is at least this strong. */
export const BLEND_MIN = 0.25;
/** Alcohol strength (drinks in the blood) where the floor starts coming up. */
export const BLACKOUT_AT = 4.2;
const BLACKOUT_WARN = 3.4;
const STRENGTH_CAP = 2.4;

// ------------------------------------------------------------------------------------------------ state

export interface ActiveDrug {
  id: DrugId;
  /** Seconds since it came on. */
  age: number;
  /** Seconds of effect left. */
  left: number;
  /** Separate visual clock after a painkiller: morphing is weaker and ends before the other effects. */
  morphLeft?: number;
  /** Seconds of comedown left. */
  crash: number;
  crashMax: number;
  /** The strongest it has been, which sets how bad the comedown is. */
  peak: number;
  /** Tolerance this dose met: what earlier doses had already built, not what this one adds. */
  tol?: number;
}

export type Phase = 'onset' | 'peak' | 'taper' | 'comedown';

export type DrugEvent =
  | { type: 'delayedDose'; id: DrugId; source: string; result: DoseResult }
  | { type: 'vomit'; purge: boolean }
  | { type: 'stumble'; dir: number }
  | { type: 'outburst'; kind: 'laugh' | 'hiccup' | 'sing'; loud: number }
  | { type: 'blackout'; seconds: number }
  | { type: 'wake' }
  | { type: 'surge'; seconds: number }
  | { type: 'paranoia' }
  | { type: 'blend'; id: string; name: string; blurb: string; on: boolean }
  | { type: 'overdose' }
  | { type: 'warn'; text: string };

export interface DoseResult {
  heal: number;
  /** The dose pushed the body over the line. */
  overdose: boolean;
  /** The dose took the edge off a withdrawal. */
  relieved: boolean;
  /** Warnings about what this was taken on top of. */
  notes: string[];
}

export interface DelayedDose { id: DrugId; left: number; source: string }

export interface DrugSave {
  delayed?: DelayedDose[];
  active: ActiveDrug[];
  toxicity: number;
  dependence: number;
  since: number;
  tolerance: Partial<Record<DrugId, number>>;
  selected: DrugId;
  munchies: boolean;
  blackout: number;
}

/** A source of luck. The tag says what the roll is for, so tests can load the dice one event at a time. */
export type Rand = (tag?: string) => number;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const smooth = (t: number) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

export class DrugState {
  active: ActiveDrug[] = [];
  /** Ingested effects wait here, per player and across scene changes/saves. */
  delayed: DelayedDose[] = [];
  toxicity = 0;
  dependence = 0;
  /** Seconds since the last dose. */
  since = 999;
  tolerance: Partial<Record<DrugId, number>> = {};
  /** Which drug the use button takes. */
  selected: DrugId = 'painkiller';
  /** Weed was taken since the last sleep: rations are eaten for two. */
  munchies = false;
  /** Seconds left passed out, and how long the faint is in all. */
  blackout = 0;
  private blackoutMax = 0;
  /** A flashback in progress: the visuals surge for this many more seconds. */
  surge = 0;
  private surgeMax = 5;
  /** Things that happened this tick, for the player to act on. Drained by `takeEvents`. */
  events: DrugEvent[] = [];
  private cd: Record<string, number> = {};
  private lastBlends = new Set<string>();
  private wasOverdosing = false;
  private strength: Partial<Record<DrugId, number>> = {};
  private modsCache: DrugMods = { ...NEUTRAL };
  private lookCache: Look = { ...NO_LOOK };
  private blendsCache: { def: BlendDef; k: number }[] = [];

  constructor(private rng: Rand = Math.random) {
    this.recompute();
  }

  // ------------------------------------------------------------------ queries

  /** How hard a drug is working right now, 0..~2.4: onset ramp × taper × strength × tolerance × amplification. */
  intensity(id: DrugId): number {
    return this.strength[id] ?? 0;
  }

  /** True while anything is working or coming down. */
  get high() {
    return this.active.length > 0;
  }

  get overdosing() {
    return this.toxicity >= TOX_OVERDOSE;
  }

  get passedOut() {
    return this.blackout > 0;
  }

  /** 0..1: how hard the body is craving. Only a dependent body that has gone without a while. */
  get withdrawal(): number {
    if (this.dependence < 0.25) return 0;
    const ramp = clamp((this.since - WITHDRAW_AFTER) / WITHDRAW_RAMP, 0, 1);
    return this.dependence * ramp;
  }

  /** Things that are not there are friendly. */
  get friendly() {
    return this.blendsCache.some((b) => b.def.friendly && b.k >= BLEND_MIN);
  }

  /** Alcohol in the blood, in drinks. */
  get drinks() {
    const a = this.active.find((x) => x.id === 'alcohol');
    return a && a.left > 0 ? a.left / DRUGS.alcohol.duration : 0;
  }

  blends() {
    return this.blendsCache.filter((b) => b.k >= BLEND_MIN).map((b) => ({ ...b.def, k: b.k }));
  }

  mods(): DrugMods {
    return this.modsCache;
  }

  look(): Look {
    return this.lookCache;
  }

  phase(id: DrugId): Phase | null {
    const a = this.active.find((x) => x.id === id);
    if (!a) return null;
    const def = DRUGS[id];
    if (a.left <= 0) return 'comedown';
    if (a.age < def.onset) return 'onset';
    if (def.stack === 'refresh' && def.taper > 0 && a.left < def.taper) return 'taper';
    return 'peak';
  }

  takeEvents(): DrugEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  // ------------------------------------------------------------------ taking

  dose(id: DrugId): DoseResult {
    const def = DRUGS[id];
    const notes: string[] = [];
    const relieved = this.withdrawal > 0.2;
    // Amplification: ayahuasca makes everything else hit harder, and everything else cost more.
    const amp = id === 'ayahuasca' ? 1 : this.amplification();
    let mult = amp;
    for (const it of INTERACTIONS) {
      const other = it.a === id ? it.b : it.b === id ? it.a : null;
      if (!other) continue;
      if (this.active.some((a) => a.id === other && a.left > 0)) {
        mult *= it.tox;
        notes.push(it.note);
      }
    }
    mult = Math.min(3.5, mult);
    const cur = this.active.find((a) => a.id === id);
    const tolBefore = this.tolerance[id] ?? 0;
    if (cur) {
      if (def.stack === 'stack') cur.left = Math.min(def.duration * def.maxStack, Math.max(0, cur.left) + def.duration);
      else cur.left = Math.max(cur.left, def.duration);
      // A dose in the comedown brings it back without a fresh onset.
      cur.age = Math.max(cur.age, def.onset);
      cur.crash = cur.crashMax = def.crash;
      cur.tol = tolBefore;
      // A fresh dose restores its visuals; stacked doses add visual time to what remains.
      if (cur.morphLeft !== undefined) {
        if (def.stack === 'stack') cur.morphLeft = Math.min(cur.left, cur.morphLeft + def.duration);
        else delete cur.morphLeft;
      }
    } else {
      this.active.push({ id, age: 0, left: def.duration, crash: def.crash, crashMax: def.crash, peak: 0, tol: tolBefore });
    }
    this.toxicity += def.tox * mult;
    this.dependence = Math.min(1, this.dependence + def.dep);
    this.tolerance[id] = Math.min(1, (this.tolerance[id] ?? 0) + def.tol);
    this.since = 0;
    if (id === 'weed') this.munchies = true;
    if (id === 'adrenaline') {
      // Adrenaline wakes you from anything and burns the booze off a little.
      if (this.blackout > 0) {
        this.blackout = 0;
        this.events.push({ type: 'wake' });
      }
      const al = this.active.find((a) => a.id === 'alcohol');
      if (al) al.left *= 0.6;
    }
    if (id === 'painkiller') {
      for (const a of this.active) {
        if (a.id !== 'painkiller' && a.left > 0) a.morphLeft = (a.morphLeft ?? a.left) * MORPH_DURATION;
      }
    }
    this.recompute();
    const overdose = this.overdosing;
    if (overdose && !this.wasOverdosing) {
      this.wasOverdosing = true;
      this.events.push({ type: 'overdose' });
    }
    return { heal: def.heal, overdose, relieved, notes };
  }

  scheduleDose(id: DrugId, seconds: number, source: string) {
    this.delayed.push({ id, left: Math.max(0, seconds), source });
  }

  /** Sleep it off: the night passes. Effects clear, toxicity goes, the body half forgets. */
  rest() {
    this.active = [];
    this.delayed = [];
    this.toxicity = 0;
    this.dependence *= 0.7;
    for (const k of Object.keys(this.tolerance) as DrugId[]) this.tolerance[k] = (this.tolerance[k] ?? 0) * 0.5;
    this.since = 999;
    this.munchies = false;
    this.blackout = 0;
    this.surge = 0;
    this.events = [];
    this.lastBlends.clear();
    this.wasOverdosing = false;
    this.recompute();
  }

  /** The convoy's medic, or a vomit: lose some of what is in the blood. */
  private purge() {
    this.toxicity = Math.max(0, this.toxicity - 0.25);
    this.dependence = Math.max(0, this.dependence - 0.12);
    const al = this.active.find((a) => a.id === 'alcohol');
    if (al) al.left *= 0.7;
  }

  /** Cycle the belt selection to the next drug in stock. */
  cycle(owned: (id: DrugId) => number, dir: 1 | -1 = 1) {
    const start = DRUG_IDS.indexOf(this.selected);
    for (let i = 1; i <= DRUG_IDS.length; i++) {
      const id = DRUG_IDS[(start + dir * i + DRUG_IDS.length * 2) % DRUG_IDS.length];
      if (owned(id) > 0) {
        this.selected = id;
        return id;
      }
    }
    this.selected = DRUG_IDS[(start + dir + DRUG_IDS.length) % DRUG_IDS.length];
    return this.selected;
  }

  /** Step the belt selection one slot, in stock or not. */
  step(dir: 1 | -1) {
    const i = DRUG_IDS.indexOf(this.selected);
    this.selected = DRUG_IDS[(i + dir + DRUG_IDS.length) % DRUG_IDS.length];
    return this.selected;
  }

  /** Wake from a faint, because something hurt. */
  wake() {
    if (this.blackout <= 0) return;
    this.blackout = 0;
    this.events.push({ type: 'wake' });
  }

  // ------------------------------------------------------------------ time

  update(dt: number) {
    this.since += dt;
    this.toxicity = Math.max(0, this.toxicity - TOX_DECAY * dt);
    this.dependence = Math.max(0, this.dependence - DEP_DECAY * dt);
    for (const k of Object.keys(this.tolerance) as DrugId[]) {
      const v = (this.tolerance[k] ?? 0) - TOL_DECAY * dt;
      if (v <= 0) delete this.tolerance[k];
      else this.tolerance[k] = v;
    }
    for (const a of this.active) {
      a.age += dt;
      if (a.morphLeft !== undefined) a.morphLeft = Math.max(0, a.morphLeft - dt);
      if (a.left > 0) {
        a.left -= dt;
        a.peak = Math.max(a.peak, this.potency(a));
      } else a.crash -= dt;
    }
    this.active = this.active.filter((a) => a.left > 0 || a.crash > 0);
    for (const k of Object.keys(this.cd)) this.cd[k] = Math.max(0, this.cd[k] - dt);
    if (this.surge > 0) this.surge = Math.max(0, this.surge - dt);
    if (this.blackout > 0) {
      this.blackout -= dt;
      if (this.blackout <= 0) {
        this.blackout = 0;
        this.events.push({ type: 'wake' });
      }
    }
    this.recompute();
    // Dangerous mixes keep poisoning you while they run.
    for (const b of this.blendsCache) if (b.def.toxRate && b.k >= BLEND_MIN) this.toxicity += b.def.toxRate * b.k * dt;
    this.rollEvents(dt);
    const over = this.overdosing;
    if (over && !this.wasOverdosing) this.events.push({ type: 'overdose' });
    this.wasOverdosing = over;
    // Apply after the existing doses tick, so a newly triggered dose starts at age zero.
    const due: DelayedDose[] = [];
    this.delayed = this.delayed.filter((d) => {
      d.left -= dt;
      if (d.left > 1e-8) return true;
      due.push(d);
      return false;
    });
    for (const d of due) this.events.push({ type: 'delayedDose', id: d.id, source: d.source, result: this.dose(d.id) });
  }

  // ------------------------------------------------------------------ the maths

  private amplification(): number {
    let amp = 1;
    for (const a of this.active) {
      const def = DRUGS[a.id];
      if (def.amplifies && a.left > 0) amp += def.amplifies * (this.strength[a.id] ?? 0);
    }
    return amp;
  }

  /** Strength of a dose before onset, taper and tolerance: 1 for a single dose, more for stacked ones. */
  private potency(a: ActiveDrug): number {
    const def = DRUGS[a.id];
    return def.stack === 'stack' ? clamp(a.left / def.duration, 0, def.maxStack) : 1;
  }

  private recompute() {
    // Per-drug strength.
    this.strength = {};
    for (const a of this.active) {
      if (a.left <= 0) continue;
      const def = DRUGS[a.id];
      const ramp = def.onset > 0 ? smooth(a.age / def.onset) : 1;
      const taper = def.stack === 'refresh' && def.taper > 0 ? smooth(a.left / def.taper) : 1;
      const tol = 1 - TOL_MAX_CUT * (a.tol ?? 0);
      this.strength[a.id] = this.potency(a) * ramp * taper * tol;
    }
    const amp = this.amplification();
    if (amp > 1) {
      for (const a of this.active) {
        if (a.left > 0 && !DRUGS[a.id].amplifies) this.strength[a.id] = Math.min(STRENGTH_CAP, (this.strength[a.id] ?? 0) * amp);
      }
    }
    // Blends.
    this.blendsCache = [];
    for (const def of BLENDS) {
      const k = Math.min(...def.needs.map((n) => this.strength[n] ?? 0));
      if (k > 0) this.blendsCache.push({ def, k: Math.min(1, k) });
    }
    // Mods and look.
    const m: DrugMods = { ...NEUTRAL };
    const l: Look = { ...NO_LOOK };
    const morphStrength: Partial<Record<DrugId, number>> = {};
    for (const a of this.active) {
      const def = DRUGS[a.id];
      if (a.left > 0) {
        const k = this.strength[a.id] ?? 0;
        let morphK = k;
        if (a.morphLeft !== undefined) {
          // Replace the normal taper with the shorter visual taper, without fading the rest of the trip.
          const taper = def.stack === 'refresh' && def.taper > 0 ? smooth(a.left / def.taper) : 1;
          const visualTaper = smooth(a.morphLeft / Math.max(1, def.taper * MORPH_DURATION));
          morphK = taper > 0 ? k / taper * MORPH_STRENGTH * visualTaper : 0;
        }
        morphStrength[a.id] = morphK;
        foldMods(m, def.on, k);
        foldLook(l, def.look, k, morphK);
        if (def.front) {
          // A bump over the onset: nothing at the first sip, worst around the time it comes on, gone by twice that.
          const bump = Math.sin(Math.PI * clamp(a.age / (def.onset * 2.2), 0, 1));
          foldMods(m, def.front, bump * (1 - 0.3 * (a.tol ?? 0)));
        }
      } else if (a.crashMax > 0) {
        const kc = clamp(a.crash / a.crashMax, 0, 1) * Math.max(0.35, Math.min(a.peak, 3));
        foldMods(m, def.down, kc);
        foldLook(l, def.lookDown, kc, a.morphLeft === undefined ? kc : 0);
      }
    }
    for (const b of this.blendsCache) {
      if (b.k < BLEND_MIN) continue;
      foldMods(m, b.def.mods, b.k);
      const morphRatio = Math.min(...b.def.needs.map((id) => {
        const k = this.strength[id] ?? 0;
        return k > 0 ? (morphStrength[id] ?? 0) / k : 0;
      }));
      foldLook(l, b.def.look, b.k, b.k * morphRatio);
    }
    // The body's own complaints.
    const w = this.withdrawal;
    if (w > 0) {
      m.speed *= 1 - 0.14 * w;
      m.shake += 0.35 * w;
      l.warp += 0.2 * w;
      l.tunnel += 0.15 * w;
      l.hue += 0.08 * w;
    }
    if (this.overdosing) {
      const over = this.toxicity - TOX_OVERDOSE;
      m.poison = OVERDOSE_DPS * (over + 0.4);
      m.speed *= 0.7;
      m.shake = 1;
      l.tunnel += 0.5;
      l.warp += 0.5;
      l.chroma += 0.3;
    }
    // A flashback turns everything up.
    if (this.surge > 0) {
      const s = smooth(Math.min((this.surgeMax - this.surge) / 1, this.surge / 1.5));
      for (const key of ['hue', 'warp', 'kaleido', 'chroma', 'trail', 'edge', 'glow'] as (keyof Look)[]) l[key] *= 1 + 0.9 * s;
      l.sat += 0.3 * s;
      m.phantoms += 0.3 * s;
    }
    // Passed out: the eyelids come down fast and go up slow.
    if (this.blackout > 0) {
      const elapsed = this.blackoutMax - this.blackout;
      l.dark = Math.max(l.dark, Math.min(1, elapsed / 1.2, this.blackout / 1.6));
    }
    clampMods(m);
    clampLook(l);
    // Keep the same 20% cut when a heavy blend would otherwise saturate the visual range.
    if (this.active.some((a) => a.morphLeft !== undefined) &&
        this.active.every((a) => a.id === 'painkiller' || a.morphLeft !== undefined)) {
      for (const key of MORPH_KEYS) l[key] = Math.min(l[key], MORPH_STRENGTH);
    }
    // Apply after the range limit so even peak blends have 20% less default distortion.
    for (const key of MORPH_KEYS) l[key] *= DEFAULT_MORPH_STRENGTH;
    this.modsCache = m;
    this.lookCache = l;
  }

  private cool(key: string, secs: number) {
    this.cd[key] = secs;
  }

  private ready(key: string) {
    return (this.cd[key] ?? 0) <= 0;
  }

  private rollEvents(dt: number) {
    const m = this.modsCache;
    const r = this.rng;
    // Stomach.
    if (m.nausea > 0.05 && this.ready('vomit') && r('vomit') < m.nausea * 0.09 * dt) {
      this.cool('vomit', 13);
      const purge = this.intensity('ayahuasca') > 0.25;
      this.events.push({ type: 'vomit', purge });
      this.purge();
    }
    // Lurching about.
    if (m.sway > 0.35 && this.ready('stumble') && r('stumble') < (m.sway - 0.25) * 0.15 * dt) {
      this.cool('stumble', 5);
      this.events.push({ type: 'stumble', dir: r('stumbleDir') < 0.5 ? -1 : 1 });
    }
    // Laughing, hiccuping and singing at the worst moment.
    if (m.outburst > 0.04 && this.ready('outburst') && r('outburst') < m.outburst * 0.07 * dt) {
      this.cool('outburst', 9);
      const al = this.intensity('alcohol');
      const gig = this.intensity('weed') + this.intensity('mushrooms');
      const kind = al > gig ? (r('outburstKind') < 0.55 ? 'hiccup' : 'sing') : 'laugh';
      this.events.push({ type: 'outburst', kind, loud: kind === 'hiccup' ? 18 : kind === 'sing' ? 28 : 38 });
    }
    // The floor comes up.
    const drinks = this.drinks;
    if (drinks >= BLACKOUT_WARN && drinks < BLACKOUT_AT && this.ready('warn')) {
      this.cool('warn', 40);
      this.events.push({ type: 'warn', text: 'The room tilts. One more and you are on the floor' });
    }
    if (drinks >= BLACKOUT_AT && this.blackout <= 0 && this.ready('blackout') && r('blackout') < (drinks - BLACKOUT_AT + 0.2) * 0.12 * dt) {
      const seconds = 6 + r('blackoutLen') * 4;
      this.blackout = this.blackoutMax = seconds;
      this.cool('blackout', 25);
      this.events.push({ type: 'blackout', seconds });
    }
    // Flashbacks and things in the corner of the eye.
    if (m.trip > 0.45 && this.surge <= 0 && this.ready('surge') && r('surge') < m.trip * 0.012 * dt) {
      this.cool('surge', 30);
      this.surge = this.surgeMax = 5;
      this.events.push({ type: 'surge', seconds: 5 });
    }
    if (m.phantoms > 0.03 && this.ready('paranoia') && r('paranoia') < m.phantoms * 0.025 * dt) {
      this.cool('paranoia', 20);
      this.events.push({ type: 'paranoia' });
    }
    // Blends starting and stopping.
    const now = new Set<string>();
    for (const b of this.blendsCache) if (b.k >= BLEND_MIN) now.add(b.def.id);
    for (const id of now) {
      if (!this.lastBlends.has(id)) {
        const def = BLENDS.find((b) => b.id === id)!;
        this.events.push({ type: 'blend', id, name: def.name, blurb: def.blurb, on: true });
      }
    }
    for (const id of this.lastBlends) {
      if (!now.has(id)) {
        const def = BLENDS.find((b) => b.id === id)!;
        this.events.push({ type: 'blend', id, name: def.name, blurb: def.blurb, on: false });
      }
    }
    this.lastBlends = now;
  }

  // ------------------------------------------------------------------ display

  /** Short labels for the HUD: what is working, what is coming on, what is coming down. */
  status(): { text: string; kind: 'good' | 'warn' | 'bad'; drug?: DrugId }[] {
    const out: { text: string; kind: 'good' | 'warn' | 'bad'; drug?: DrugId }[] = [];
    for (const a of this.active) {
      const def = DRUGS[a.id];
      const name = def.name.toUpperCase();
      const ph = this.phase(a.id);
      if (ph === 'comedown') out.push({ text: `${name} COMEDOWN ${Math.ceil(a.crash)}s`, kind: 'warn', drug: a.id });
      else if (a.id === 'alcohol') out.push({ text: `${name} ${drunkLabel(this.drinks)} ×${this.drinks.toFixed(1)}`, kind: this.drinks >= BLACKOUT_AT - 0.5 ? 'bad' : 'good', drug: a.id });
      else if (ph === 'onset') out.push({ text: `${name} COMING ON`, kind: 'good', drug: a.id });
      else out.push({ text: `${name} ${fmtTime(a.left)}`, kind: 'good', drug: a.id });
    }
    for (const b of this.blendsCache) if (b.k >= BLEND_MIN) out.push({ text: b.def.name.toUpperCase(), kind: b.def.toxRate && b.def.toxRate >= 0.01 ? 'bad' : 'good' });
    if (this.blackout > 0) out.push({ text: 'PASSED OUT', kind: 'bad' });
    else if (this.overdosing) out.push({ text: 'OVERDOSE', kind: 'bad' });
    else if (this.withdrawal > 0.3) out.push({ text: 'WITHDRAWAL', kind: 'bad' });
    else if (this.toxicity > 0.7) out.push({ text: 'SHAKING: DO NOT', kind: 'warn' });
    return out;
  }

  // ------------------------------------------------------------------ save

  serialize(): DrugSave {
    return {
      active: this.active.map((a) => ({ ...a })),
      delayed: this.delayed.map((d) => ({ ...d })),
      toxicity: this.toxicity,
      dependence: this.dependence,
      since: Math.min(this.since, 999),
      tolerance: { ...this.tolerance },
      selected: this.selected,
      munchies: this.munchies,
      blackout: this.blackout,
    };
  }

  static restore(d: Partial<DrugSave> | undefined, rng: Rand = Math.random): DrugState {
    const s = new DrugState(rng);
    if (!d) return s;
    const known = (id: unknown): id is DrugId => typeof id === 'string' && id in DRUGS;
    s.active = (d.active ?? []).filter((a) => known(a.id)).map((a) => ({ ...a }));
    s.delayed = (d.delayed ?? []).filter((v) => known(v.id) && Number.isFinite(v.left) && v.left >= 0 && typeof v.source === 'string').map((v) => ({ ...v }));
    s.toxicity = d.toxicity ?? 0;
    s.dependence = d.dependence ?? 0;
    s.since = d.since ?? 999;
    s.tolerance = {};
    for (const [k, v] of Object.entries(d.tolerance ?? {})) if (known(k) && typeof v === 'number') s.tolerance[k] = v;
    s.selected = known(d.selected) ? d.selected : 'painkiller';
    s.munchies = !!d.munchies;
    s.blackout = d.blackout ?? 0;
    s.blackoutMax = s.blackout;
    s.recompute();
    return s;
  }
}

// ------------------------------------------------------------------------------------------------ helpers

export function drunkLabel(drinks: number): string {
  if (drinks >= BLACKOUT_AT) return 'WASTED';
  if (drinks >= 2.6) return 'DRUNK';
  if (drinks >= 1.2) return 'BUZZED';
  return 'TIPSY';
}

export function fmtTime(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** What sight lets you sense, and how far. */
export interface SenseSpec {
  radius: number;
  zombies: boolean;
  animals: boolean;
  raiders: boolean;
  loot: boolean;
  /** The road ahead lights up and every pin shows on the compass. */
  guide: boolean;
}

export function senseSpec(sight: number): SenseSpec {
  if (sight < 0.05) return { radius: 0, zombies: false, animals: false, raiders: false, loot: false, guide: false };
  return {
    radius: 12 + 75 * sight,
    zombies: true,
    animals: sight >= 0.3,
    raiders: sight >= 0.3,
    loot: sight >= 0.5,
    guide: sight >= 0.85,
  };
}
