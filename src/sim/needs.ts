import { clamp } from '../core/math';

/**
 * The body's four chores: eat, drink, piss and shit. Food and water drain with time and effort and are topped up from the
 * convoy's rations and water reserve; what goes in comes out again, so the bladder and the bowels fill behind them and
 * have to be emptied, and a full one wrecks your aim and your sprint until you do. Nothing ever happens to you on its own.
 * Pure numbers, no engine imports. One `Needs` lives on each player (on the campaign, like the drugs) and is saved.
 */

export type NeedId = 'food' | 'water' | 'bladder' | 'bowel';
/** What a body can be told to do about it. Eating and drinking take from the stores; the other two empty you out. */
export type NeedAct = 'eat' | 'drink' | 'piss' | 'shit';
export const NEED_ACTS: NeedAct[] = ['eat', 'drink', 'piss', 'shit'];
export const isNeedAct = (id: string): id is NeedAct => (NEED_ACTS as string[]).includes(id);

export const NEEDS = {
  /** Fullness lost per second at rest. A day is 720 s: with no food you are hungry at nightfall, starving the day after. */
  foodPerSec: 0.0009,
  waterPerSec: 0.0011,
  /** A sprint burns water as well as wind: water drain is this much faster at full effort. */
  exertion: 1.2,
  /** Waste that builds on its own per second, and per unit of food or water taken in. */
  bladderPerSec: 0.0008,
  bowelPerSec: 0.0007,
  bladderPerWater: 0.4,
  bowelPerFood: 0.36,
  /** What one go at it gives back: a ration, and a drink (which costs `drinkLitres` from the reserve). */
  rationFood: 0.55,
  drinkWater: 0.25,
  drinkLitres: 0.75,
  /** A hydration of 1 is about three litres: a lake gulp costs nothing but is not always clean. */
  dirtyChance: 0.3,
  dirtyBowel: 0.3,
  /**
   * How likely raw water is to sit badly, by where it came from. A spring comes up out of the rock clean; running water
   * mostly is; a lake is as it always was; a swamp is standing rot and usually turns the stomach.
   */
  dirtyBy: { lake: 0.3, river: 0.12, stream: 0.08, spring: 0, swamp: 0.65 },
  /** Below this it is time to eat or drink, and below `critical` it is hurting. */
  low: 0.3,
  critical: 0.1,
  /** Waste: past `urge` you want to go, past `desperate` you can think of nothing else. */
  urge: 0.6,
  desperate: 0.85,
  /** How long the job takes from full, seconds. A squat is long and you are very much not watching your back. */
  pissSeconds: 3.4,
  shitSeconds: 7,
  /** Over a night's sleep the body fills up a little behind you. */
  sleepBladder: 0.3,
  sleepBowel: 0.14,
  /** Supper is only eaten by someone who is not already full. */
  supperBelow: 0.6,
  /** Starving and dying of thirst hurts, but never to the death: health stops falling at this fraction. */
  hpFloor: 0.2,
  /** Health per second lost when critical, and more again when it is bone dry. */
  starveHp: 0.1,
  parchedHp: 0.24,
} as const;

export interface Needs {
  /** Fullness: 1 is a full belly and a full body of water, 0 is empty. */
  food: number;
  water: number;
  /** How full the bladder and the bowels are: 1 and it is coming out. */
  bladder: number;
  bowel: number;
}

export function newNeeds(): Needs {
  return { food: 0.92, water: 0.9, bladder: 0.12, bowel: 0.1 };
}

export type NeedsSave = Partial<Needs>;

export function restoreNeeds(s: NeedsSave | undefined): Needs {
  const n = newNeeds();
  if (!s) return n;
  const f = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  n.food = clamp(f(s.food, n.food), 0, 1);
  n.water = clamp(f(s.water, n.water), 0, 1);
  n.bladder = clamp(f(s.bladder, n.bladder), 0, 1);
  n.bowel = clamp(f(s.bowel, n.bowel), 0, 1);
  return n;
}

export const serializeNeeds = (n: Needs): NeedsSave => ({ ...n });

// ------------------------------------------------------------------ levels

export type Level = 'ok' | 'low' | 'critical';
export type WasteLevel = 'ok' | 'urge' | 'desperate';

export function intakeLevel(v: number): Level {
  return v < NEEDS.critical ? 'critical' : v < NEEDS.low ? 'low' : 'ok';
}
export function wasteLevel(v: number): WasteLevel {
  return v >= NEEDS.desperate ? 'desperate' : v >= NEEDS.urge ? 'urge' : 'ok';
}

export type NeedEvent =
  | { type: 'warn'; need: NeedId; level: 'low' | 'critical' | 'urge' | 'desperate' };

export interface NeedsTick {
  /** Drug appetite: weed makes you hungry faster. */
  appetite?: number;
  /** 0 standing, 1 flat out. */
  effort?: number;
  /** Asleep or out cold: the body still fills, but a full bladder does not wake anyone here. */
  asleep?: boolean;
}

/** The last band each need was announced at, so a warning fires once as it is crossed and not every tick. */
const seen = new WeakMap<Needs, Record<NeedId, number>>();
const BAND = { ok: 0, low: 1, urge: 1, critical: 2, desperate: 2 } as const;

function announce(n: Needs, need: NeedId, level: Level | WasteLevel, out: NeedEvent[]) {
  let m = seen.get(n);
  if (!m) seen.set(n, (m = { food: 0, water: 0, bladder: 0, bowel: 0 }));
  const b = BAND[level];
  if (b > m[need]) out.push({ type: 'warn', need, level: level as 'low' });
  m[need] = b;
}

/** One tick of living. Returns what the body wants you to know. */
export function tickNeeds(n: Needs, dt: number, o: NeedsTick = {}): NeedEvent[] {
  const out: NeedEvent[] = [];
  const effort = clamp(o.effort ?? 0, 0, 1);
  const foodLoss = NEEDS.foodPerSec * Math.max(0.3, o.appetite ?? 1) * (1 + effort * 0.35) * dt;
  const waterLoss = NEEDS.waterPerSec * (1 + effort * NEEDS.exertion) * dt;
  // What leaves the stomach turns into waste, so an empty one stops filling the bowels.
  const f = Math.min(n.food, foodLoss);
  const w = Math.min(n.water, waterLoss);
  n.food -= f;
  n.water -= w;
  n.bowel = Math.min(1, n.bowel + NEEDS.bowelPerSec * dt * (n.food > 0.02 ? 1 : 0.2) + f * NEEDS.bowelPerFood * 0.5);
  n.bladder = Math.min(1, n.bladder + NEEDS.bladderPerSec * dt * (n.water > 0.02 ? 1 : 0.2) + w * NEEDS.bladderPerWater * 0.5);

  announce(n, 'food', intakeLevel(n.food), out);
  announce(n, 'water', intakeLevel(n.water), out);
  // Asleep, the bladder and bowels simply hold: the night's fill is added by `rest`.
  if (!o.asleep) {
    announce(n, 'bladder', wasteLevel(n.bladder), out);
    announce(n, 'bowel', wasteLevel(n.bowel), out);
  }
  return out;
}

// ------------------------------------------------------------------ doing it

export interface ActResult {
  ok: boolean;
  reason?: string;
  /** What was taken from the stores, in units (rations) or litres (water). */
  spent?: number;
  /** Raw lake water: it was free, and it may have disagreed with you. */
  dirty?: boolean;
}

/** Eat one ration: whole rations only. Food comes up and the bowels start to fill. */
export function eat(n: Needs, rations: number): ActResult {
  if (rations < 1 - 1e-6) return { ok: false, reason: 'No rations left' };
  if (n.food > 0.92) return { ok: false, reason: 'You are not hungry' };
  const gained = Math.min(NEEDS.rationFood, 1 - n.food);
  n.food += gained;
  n.bowel = Math.min(1, n.bowel + gained * NEEDS.bowelPerFood * 0.45);
  return { ok: true, spent: 1 };
}

/** Where raw water was drunk from: the kinds of water in the world. */
export type WaterSource = keyof typeof NEEDS.dirtyBy;

/**
 * Drink. `litres` is what the reserve can spare (ignored for raw water, where `lake` is set); `source` is the kind of water
 * it came from (a lake if not given), and `roll` is a uniform [0,1) that decides whether it sat badly.
 */
export function drink(n: Needs, litres: number, o: { lake?: boolean; source?: WaterSource; roll?: number } = {}): ActResult {
  if (!o.lake && litres < 0.05) return { ok: false, reason: 'No water in the reserve' };
  if (n.water > 0.92) return { ok: false, reason: 'You are not thirsty' };
  const want = Math.min(NEEDS.drinkWater, 1 - n.water);
  const cost = o.lake ? 0 : Math.min(litres, (want / NEEDS.drinkWater) * NEEDS.drinkLitres);
  const gained = o.lake ? want : (cost / NEEDS.drinkLitres) * NEEDS.drinkWater;
  n.water = Math.min(1, n.water + gained);
  n.bladder = Math.min(1, n.bladder + gained * NEEDS.bladderPerWater);
  const dirty = !!o.lake && (o.roll ?? 1) < (o.source ? NEEDS.dirtyBy[o.source] : NEEDS.dirtyChance);
  if (dirty) n.bowel = Math.min(1, n.bowel + NEEDS.dirtyBowel);
  return { ok: true, spent: cost, dirty };
}

/** How long it takes to empty what is in there now, never less than a moment's work. */
export function reliefSeconds(n: Needs, kind: 'piss' | 'shit'): number {
  const v = kind === 'piss' ? n.bladder : n.bowel;
  const full = kind === 'piss' ? NEEDS.pissSeconds : NEEDS.shitSeconds;
  return Math.max(full * 0.35, full * v);
}

/** Whether there is anything worth going for. A half-empty bladder will still oblige; an empty one will not. */
export function canRelieve(n: Needs, kind: 'piss' | 'shit'): ActResult {
  const v = kind === 'piss' ? n.bladder : n.bowel;
  return v < 0.12 ? { ok: false, reason: kind === 'piss' ? 'You do not need to piss' : 'You do not need to shit' } : { ok: true };
}

/** Empty the bladder or the bowels by `share` of what the full job would take, from a start level. */
export function relieve(n: Needs, kind: 'piss' | 'shit', amount: number) {
  if (kind === 'piss') n.bladder = Math.max(0, n.bladder - amount);
  else n.bowel = Math.max(0, n.bowel - amount);
}

/**
 * A night's sleep at camp. Supper and a drink bring you back up; without them you wake hollow. Either way you wake
 * with a full bladder.
 */
export function rest(n: Needs, o: { fed: boolean; watered: boolean }) {
  n.food = o.fed ? 1 : Math.max(0, n.food - 0.2);
  n.water = o.watered ? Math.min(1, Math.max(n.water, 0.85) + 0.1) : Math.max(0, n.water - 0.25);
  n.bladder = clamp(n.bladder + NEEDS.sleepBladder, 0, 0.95);
  n.bowel = clamp(n.bowel + NEEDS.sleepBowel, 0, 0.9);
  seen.delete(n);
}

// ------------------------------------------------------------------ what it does to you

export interface NeedMods {
  /** Walk and sprint speed. */
  speed: number;
  /** Stamina: how fast sprinting drains it, and how fast it comes back. */
  drain: number;
  regen: number;
  /** Weapon spread. */
  spread: number;
  /** Aim and body sway, and camera shake. */
  sway: number;
  shake: number;
  /** Health lost per second to starving or dying of thirst. */
  hurt: number;
}

export const NEUTRAL_NEEDS: NeedMods = { speed: 1, drain: 1, regen: 1, spread: 1, sway: 0, shake: 0, hurt: 0 };

export function needMods(n: Needs): NeedMods {
  const m = { ...NEUTRAL_NEEDS };
  const fl = intakeLevel(n.food);
  const wl = intakeLevel(n.water);
  const bl = wasteLevel(n.bladder);
  const ol = wasteLevel(n.bowel);
  if (fl === 'low') m.regen *= 0.88;
  if (fl === 'critical') {
    m.regen *= 0.6;
    m.speed *= 0.93;
    m.spread *= 1.1;
    m.hurt += NEEDS.starveHp;
  }
  if (wl === 'low') m.drain *= 1.12;
  if (wl === 'critical') {
    m.drain *= 1.4;
    m.speed *= 0.92;
    m.spread *= 1.2;
    m.sway += 0.07;
    m.shake += 0.06;
    m.hurt += n.water <= 0.01 ? NEEDS.parchedHp : NEEDS.parchedHp * 0.6;
  }
  // Clenching: you cannot run properly and your aim is not what it was.
  if (bl === 'desperate') {
    m.drain *= 1.2;
    m.spread *= 1.1;
    m.sway += 0.03;
  }
  if (ol === 'desperate') {
    m.speed *= 0.94;
    m.drain *= 1.15;
    m.spread *= 1.1;
    m.sway += 0.03;
  }
  m.sway = clamp(m.sway, 0, 0.3);
  return m;
}

export interface NeedChip {
  text: string;
  kind: 'good' | 'warn' | 'bad';
}

/** HUD chips: nothing while the body is comfortable. */
export function needChips(n: Needs): NeedChip[] {
  const out: NeedChip[] = [];
  const fl = intakeLevel(n.food);
  if (fl !== 'ok') out.push({ text: fl === 'critical' ? 'STARVING' : 'HUNGRY', kind: fl === 'critical' ? 'bad' : 'warn' });
  const wl = intakeLevel(n.water);
  if (wl !== 'ok') out.push({ text: wl === 'critical' ? 'PARCHED' : 'THIRSTY', kind: wl === 'critical' ? 'bad' : 'warn' });
  const bl = wasteLevel(n.bladder);
  if (bl !== 'ok') out.push({ text: bl === 'desperate' ? 'BURSTING' : 'NEED A PISS', kind: bl === 'desperate' ? 'bad' : 'warn' });
  const ol = wasteLevel(n.bowel);
  if (ol !== 'ok') out.push({ text: ol === 'desperate' ? 'CLENCHING' : 'NEED A SHIT', kind: ol === 'desperate' ? 'bad' : 'warn' });
  return out;
}

/** The line each warning says out loud. */
export function warnText(need: NeedId, level: 'low' | 'critical' | 'urge' | 'desperate'): string {
  if (need === 'food') return level === 'critical' ? 'You are starving: eat something' : 'Your stomach growls';
  if (need === 'water') return level === 'critical' ? 'Your mouth is dry and your head is pounding: drink' : 'You are thirsty';
  if (need === 'bladder') return level === 'desperate' ? 'You are about to burst: find a spot now' : 'You need a piss';
  return level === 'desperate' ? 'You cannot hold it much longer' : 'You need a shit';
}

export const needLabel = (id: NeedAct): string => ({ eat: 'Eat', drink: 'Drink', piss: 'Piss', shit: 'Shit' })[id];
