import { clamp } from '../core/math';
import type { Needs } from './needs';

/**
 * Foraging, as pure rules (no engine imports): what grows wild in the green country and the dry edges, what a handful of
 * it is worth, and what it costs to pick.
 *
 * Every plant bears a few handfuls and is stripped by picking them, one hold of A each; a stripped plant bears again some
 * days later. Someone hungry or thirsty eats what they pick there and then (grazing); someone fed puts it by for the
 * convoy (rations, medicine, a dressing). Thorns and spines tear bare hands: gloves are worth wearing for it, and a blade
 * cuts herbs quicker.
 *
 * Mushrooms are the gamble. Three kinds grow in the woods and look much alike to someone who has never learned them: field
 * mushrooms (food), liberty caps (a trip), and death caps (a day of being very sick). A person learns a kind by eating it
 * (or, slowly, by looking it over), and once they know it they pick it for what it is. What each person knows is theirs.
 */

export type ForageKind = 'fig' | 'bramble' | 'sabra' | 'zaatar' | 'yarrow' | 'mushroom';
export const FORAGE_KINDS: ForageKind[] = ['fig', 'bramble', 'sabra', 'zaatar', 'yarrow', 'mushroom'];

export type Shroom = 'field' | 'liberty' | 'deathcap';
export const SHROOMS: Shroom[] = ['field', 'liberty', 'deathcap'];
export const SHROOM_NAME: Record<Shroom, string> = { field: 'field mushrooms', liberty: 'liberty caps', deathcap: 'death caps' };

/** What a handful puts by in the convoy's stores. */
export interface ForageBank {
  rations?: number;
  medicine?: number;
  bandage?: number;
  /** Liberty caps, counted with the drugs (`items.mushrooms`). */
  mushrooms?: number;
}

export interface ForageDef {
  /** The plant, and the crop it bears. */
  name: string;
  crop: string;
  /** Handfuls on a plant in fruit. */
  handfuls: number;
  /** Seconds to pick one handful with bare hands. */
  pick: number;
  /** Days before a stripped plant bears again. */
  regrow: number;
  /** Eaten on the spot: belly and water per handful. */
  food: number;
  water: number;
  /** Put by instead. */
  bank: ForageBank;
  /** Thorns or spines: health torn off bare hands per handful, and the chance it opens a bleeding scratch. `full` needs fingers covered. */
  thorns?: { hp: number; bleed: number; cover: 'any' | 'full' };
  /** A blade in the hand (knife, machete, axe) cuts it this much quicker. */
  blade?: number;
  /** Noise of the work, on the Signature grid. */
  noise: number;
}

export const FORAGE: Record<ForageKind, ForageDef> = {
  fig: { name: 'wild fig', crop: 'figs', handfuls: 3, pick: 2.2, regrow: 3, food: 0.2, water: 0.04, bank: { rations: 0.35 }, noise: 6 },
  bramble: {
    name: 'bramble',
    crop: 'blackberries',
    handfuls: 4,
    pick: 2.6,
    regrow: 2,
    food: 0.13,
    water: 0.06,
    bank: { rations: 0.25 },
    thorns: { hp: 3, bleed: 0.12, cover: 'any' },
    noise: 8,
  },
  sabra: {
    name: 'prickly pear',
    crop: 'prickly pears',
    handfuls: 3,
    pick: 3.2,
    regrow: 3,
    food: 0.16,
    water: 0.13,
    bank: { rations: 0.3 },
    thorns: { hp: 5, bleed: 0, cover: 'full' },
    blade: 0.6,
    noise: 6,
  },
  zaatar: { name: "za'atar", crop: "za'atar", handfuls: 2, pick: 2.4, regrow: 2, food: 0.03, water: 0, bank: { medicine: 0.25 }, blade: 0.55, noise: 4 },
  yarrow: { name: 'yarrow', crop: 'yarrow', handfuls: 1, pick: 2.8, regrow: 4, food: 0, water: 0, bank: { bandage: 1 }, blade: 0.6, noise: 4 },
  mushroom: { name: 'mushrooms', crop: 'mushrooms', handfuls: 2, pick: 1.8, regrow: 2, food: 0.16, water: 0.02, bank: { rations: 0.3 }, noise: 4 },
};

export const FORAGE_RULES = {
  /** Below this belly (or, for juicy fruit, this water) a forager eats what they pick instead of putting it by. */
  grazeBelow: 0.78,
  /** Share of a hold's time that looking over an unknown mushroom takes, and the chance it tells you what it is. */
  studyChance: 0.45,
  /** Mushrooms fruit on a dry day in this share of patches; after rain (`wet` 1), in all of them. */
  shroomDry: 0.35,
  /** Reach (m) at which a plant can be picked. */
  reach: 1.9,
};

/** What covers the hands: nothing, gloves without fingers, or proper gloves. */
export type Cover = 'none' | 'fingerless' | 'full';

export function coverOf(handsId: string | undefined): Cover {
  if (!handsId) return 'none';
  return handsId === 'g_finger' ? 'fingerless' : 'full';
}

/** Whether the hands are covered well enough for this plant's thorns. */
export function handsSafe(kind: ForageKind, cover: Cover): boolean {
  const t = FORAGE[kind].thorns;
  if (!t || cover === 'full') return true;
  return t.cover === 'any' && cover === 'fingerless';
}

/** How long one handful takes: a blade is quicker on what it cuts, and careful bare hands are slower in thorns. */
export function pickSeconds(kind: ForageKind, blade: boolean, cover: Cover): number {
  const d = FORAGE[kind];
  let s = d.pick;
  if (blade && d.blade) s *= d.blade;
  if (d.thorns && !handsSafe(kind, cover)) s *= 1.25;
  return s;
}

/** Whether a body wants to eat this rather than keep it. */
export function wantsToEat(n: Needs, kind: ForageKind): boolean {
  const d = FORAGE[kind];
  if (d.food <= 0 && d.water <= 0) return false;
  return (d.food > 0.05 && n.food < FORAGE_RULES.grazeBelow) || (d.water > 0.05 && n.water < FORAGE_RULES.grazeBelow);
}

/** Whether a mushroom patch is fruiting today: some always are, all of them after rain. `h` is the patch's own [0,1) hash for the day. */
export function shroomsUp(h: number, wet: number): boolean {
  return h < FORAGE_RULES.shroomDry + clamp(wet, 0, 1) * (1 - FORAGE_RULES.shroomDry);
}

/** Days left before a stripped plant bears again (0: it is bearing). */
export function regrowLeft(kind: ForageKind, pickedDay: number, today: number): number {
  return Math.max(0, FORAGE[kind].regrow - (today - pickedDay));
}

/** Handfuls left on a plant picked `taken` times, last on `day`. A stripped plant comes back whole once it has regrown. */
export function handfulsLeft(kind: ForageKind, taken: number, day: number, today: number): number {
  const full = FORAGE[kind].handfuls;
  if (taken <= 0) return full;
  if (today - day >= FORAGE[kind].regrow) return full;
  return Math.max(0, full - taken);
}

// ------------------------------------------------------------------ one handful

export interface PickInput {
  needs: Needs;
  cover: Cover;
  /** Bleeding now: yarrow goes straight on the wound. */
  bleeding: boolean;
  /** For a mushroom patch: what it really is, and what this person already knows. */
  shroom?: Shroom;
  known?: ReadonlySet<Shroom>;
  /** A uniform [0,1) from the forager's own dice. */
  roll: number;
}

export interface PickOutcome {
  /** False when nothing was picked (the plant keeps its handful). */
  took: boolean;
  /** Eaten there and then. */
  ate: { food: number; water: number };
  /** Put by for the convoy. */
  bank: ForageBank;
  /** Health torn off by thorns, and whether a scratch opened. */
  hurt: number;
  scratch: boolean;
  /** Yarrow packed into a bleeding wound: bind it. */
  bind: boolean;
  /** A raw liberty cap was eaten: dose the forager. */
  trip: boolean;
  /** A death cap was eaten: poison them. */
  poison: boolean;
  /** A mushroom kind this person now knows. */
  learn?: Shroom;
  note: string;
  tone: 'good' | 'info' | 'warn' | 'bad';
}

const blank = (): PickOutcome => ({ took: true, ate: { food: 0, water: 0 }, bank: {}, hurt: 0, scratch: false, bind: false, trip: false, poison: false, note: '', tone: 'good' });

function scale(b: ForageBank, k: number): ForageBank {
  const o: ForageBank = {};
  for (const [id, v] of Object.entries(b)) o[id as keyof ForageBank] = (v as number) * k;
  return o;
}

/**
 * Pick one handful. Pure: says what happened, and the caller applies it (fills the belly, banks the stores, hurts the hands,
 * binds a bleed, doses or poisons) and strips the plant by one if `took`.
 */
export function pickHandful(kind: ForageKind, i: PickInput): PickOutcome {
  const d = FORAGE[kind];
  const o = blank();
  // Thorns and spines on bare hands: the second roll is drawn from the same uniform so a test can pin both.
  if (d.thorns && !handsSafe(kind, i.cover)) {
    o.hurt = d.thorns.hp;
    o.scratch = ((i.roll * 7.31) % 1) < d.thorns.bleed;
  }
  if (kind === 'mushroom') return pickShroom(i, o);
  if (kind === 'yarrow' && i.bleeding) {
    o.bind = true;
    o.note = 'Yarrow leaves packed into the wound: the bleeding stops';
    return o;
  }
  if (wantsToEat(i.needs, kind)) {
    o.ate = { food: Math.min(d.food, 1 - i.needs.food), water: Math.min(d.water, 1 - i.needs.water) };
    o.note = `Ate a handful of ${d.crop}`;
  } else {
    o.bank = { ...d.bank };
    o.note = kind === 'zaatar' ? "Cut a bunch of za'atar for the medicine chest" : kind === 'yarrow' ? 'Picked yarrow: a field dressing' : `Picked ${d.crop} for the stores`;
  }
  if (o.hurt) {
    o.note += kind === 'sabra' ? ': the spines are in your fingers' : ': the thorns tear your hands';
    o.tone = 'warn';
  }
  return o;
}

function pickShroom(i: PickInput, o: PickOutcome): PickOutcome {
  const s = i.shroom ?? 'field';
  const known = i.known?.has(s) ?? false;
  const d = FORAGE.mushroom;
  if (known) {
    if (s === 'deathcap') return { ...o, took: false, note: 'Death caps: you know better than to touch them', tone: 'warn' };
    if (s === 'liberty') return { ...o, bank: { mushrooms: 1 }, note: 'Picked liberty caps (on the belt with the other drugs)', tone: 'good' };
    if (wantsToEat(i.needs, 'mushroom')) return { ...o, ate: { food: Math.min(d.food, 1 - i.needs.food), water: 0 }, note: 'Ate a handful of field mushrooms' };
    return { ...o, bank: scale(d.bank, 1), note: 'Picked field mushrooms for the stores' };
  }
  // Unknown. Hungry, you eat them and find out; fed, you turn one over and maybe learn what it is.
  if (wantsToEat(i.needs, 'mushroom')) {
    o.learn = s;
    if (s === 'field') return { ...o, ate: { food: Math.min(d.food, 1 - i.needs.food), water: 0 }, note: 'You ate them: field mushrooms, and good ones. Now you know them' };
    if (s === 'liberty') return { ...o, trip: true, note: 'You ate them. Liberty caps: the colours are starting to move', tone: 'warn' };
    return { ...o, poison: true, note: 'You ate them. They tasted fine', tone: 'info' };
  }
  if (i.roll < FORAGE_RULES.studyChance) {
    o.learn = s;
    if (s === 'deathcap') return { ...o, took: false, note: 'Pale green cap, white gills, a cup at the foot: death caps. You leave them', tone: 'warn' };
    if (s === 'liberty') return { ...o, bank: { mushrooms: 1 }, note: 'Little pointed caps: liberty caps. Picked them (on the belt)', tone: 'good' };
    return { ...o, bank: scale(d.bank, 1), note: 'Field mushrooms, you are sure of it. Picked them for the stores' };
  }
  return { ...o, took: false, note: "You can't tell what these are. Leave them, or eat one when you're hungry and find out", tone: 'info' };
}

// ------------------------------------------------------------------ death cap

/**
 * A death cap's poison: nothing at first, then hours of being sick, squeezed into minutes. It takes health down to a
 * floor (never the killing blow), and with it the water and the belly. A night's sleep at camp sees it through.
 */
export const DEATHCAP = {
  /** Seconds before it starts. */
  onset: 45,
  /** Seconds of being sick once it has. */
  span: 140,
  /** Health a second while sick, down to `floor` (share of max). */
  hp: 0.56,
  floor: 0.25,
  /** Water and belly lost over the whole of it. */
  water: 0.35,
  food: 0.3,
  /** Seconds between bouts of retching (a note and a stop). */
  retch: 22,
};

export interface Sickness {
  /** Seconds since it was eaten. */
  t: number;
  /** When the last retch was. */
  lastRetch: number;
}

export function newSickness(): Sickness {
  return { t: 0, lastRetch: -99 };
}

export interface SickTick {
  hp: number;
  water: number;
  food: number;
  /** A bout of retching this tick. */
  retch: boolean;
  /** It has just started, or has just ended. */
  started: boolean;
  over: boolean;
}

/** One tick of a poisoning. `hp`/`maxHp` cap the loss at the floor. */
export function tickSickness(s: Sickness, dt: number, hp: number, maxHp: number): SickTick {
  const before = s.t;
  s.t += dt;
  const out: SickTick = { hp: 0, water: 0, food: 0, retch: false, started: false, over: false };
  const a = DEATHCAP.onset;
  const b = DEATHCAP.onset + DEATHCAP.span;
  if (before < a && s.t >= a) out.started = true;
  if (before < b && s.t >= b) out.over = true;
  const live = Math.max(0, Math.min(s.t, b) - Math.max(before, a));
  if (live <= 0) return out;
  out.hp = Math.min(Math.max(0, hp - maxHp * DEATHCAP.floor), DEATHCAP.hp * live);
  out.water = (DEATHCAP.water / DEATHCAP.span) * live;
  out.food = (DEATHCAP.food / DEATHCAP.span) * live;
  if (s.t - s.lastRetch >= DEATHCAP.retch) {
    s.lastRetch = s.t;
    out.retch = true;
  }
  return out;
}

export function sickLabel(s: Sickness): string {
  if (s.t < DEATHCAP.onset) return '';
  return s.t < DEATHCAP.onset + DEATHCAP.span ? 'POISONED' : '';
}
