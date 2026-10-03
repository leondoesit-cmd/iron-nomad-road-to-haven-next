import { clamp } from '../core/math';
import type { HurtKind } from './gear';

/**
 * The body as a survival game sees it: a stamina pool that sprinting and swinging spend, wounds that bleed until they are
 * bound, and the wear on whatever is in hand. Pure numbers, no engine imports.
 */

// ------------------------------------------------------------------ stamina

export const STAMINA = {
  max: 100,
  /** Per second while sprinting. */
  sprint: 17,
  /** Per second recovered, after `delay` seconds of not spending. */
  regen: 26,
  delay: 0.9,
  /** Crouched and still, you get your wind back faster. */
  restBonus: 1.35,
  jump: 11,
  swing: 9,
  /** Once it hits zero you cannot sprint until this much has come back. */
  recover: 30,
} as const;

export interface Stamina {
  value: number;
  /** Seconds until recovery starts again. */
  idle: number;
  /** Winded: no sprinting until `STAMINA.recover` is back. */
  winded: boolean;
}

export function newStamina(): Stamina {
  return { value: STAMINA.max, idle: 0, winded: false };
}

export function canSprint(s: Stamina): boolean {
  return !s.winded && s.value > 0;
}

/** Spend a lump (a jump, a swing). Returns false when there was not enough, and takes what is left. */
export function spendStamina(s: Stamina, amount: number): boolean {
  const had = s.value >= amount;
  s.value = Math.max(0, s.value - amount);
  s.idle = STAMINA.delay;
  if (s.value <= 0) s.winded = true;
  return had;
}

/**
 * One tick. `sprinting` drains; otherwise it recovers once the delay is over. `drain` scales the cost (stims and
 * adrenaline take the edge off, a heavy load makes it worse) and `regen` scales the recovery.
 */
export function tickStamina(s: Stamina, dt: number, o: { sprinting: boolean; resting?: boolean; drain?: number; regen?: number }) {
  if (o.sprinting) {
    s.value = Math.max(0, s.value - STAMINA.sprint * (o.drain ?? 1) * dt);
    s.idle = STAMINA.delay;
    if (s.value <= 0) s.winded = true;
    return;
  }
  s.idle = Math.max(0, s.idle - dt);
  if (s.idle > 0) return;
  s.value = Math.min(STAMINA.max, s.value + STAMINA.regen * (o.regen ?? 1) * (o.resting ? STAMINA.restBonus : 1) * dt);
  if (s.winded && s.value >= STAMINA.recover) s.winded = false;
}

// ------------------------------------------------------------------ bleeding

export const BLEED = {
  /** Wounds that can be open at once. */
  maxLevel: 3,
  /** HP per second, per open wound. */
  perLevel: 0.5,
  /** Seconds before one wound clots on its own. */
  clot: 15,
  /** Below this a hit is a bruise, not a cut. */
  minHit: 7,
  /** Bandage and medkit heal. */
  bandageHeal: 8,
} as const;

export interface Bleed {
  level: number;
  /** Seconds into the oldest wound. */
  t: number;
}

export function newBleed(): Bleed {
  return { level: 0, t: 0 };
}

/** The chance that a hit opens a wound, before armour. Teeth and blades cut; falls and spores do not. */
const CUT: Partial<Record<HurtKind, number>> = { bite: 0.4, melee: 0.34, bullet: 0.26, blast: 0.18, ram: 0.1 };

/** `roll` is a uniform [0,1). `damage` is what got through the armour. A bigger hit cuts deeper. */
export function woundChance(kind: HurtKind, damage: number, armor: number): number {
  const base = CUT[kind] ?? 0;
  if (!base || damage < BLEED.minHit) return 0;
  return clamp(base * (0.6 + damage / 40) * (1 - armor * 0.6), 0, 0.85);
}

export function openWound(b: Bleed): boolean {
  if (b.level >= BLEED.maxLevel) {
    b.t = 0;
    return false;
  }
  if (b.level === 0) b.t = 0;
  b.level++;
  return true;
}

/** HP lost this tick. Wounds clot one at a time, oldest first. */
export function tickBleed(b: Bleed, dt: number): number {
  if (b.level <= 0) return 0;
  const loss = b.level * BLEED.perLevel * dt;
  b.t += dt;
  if (b.t >= BLEED.clot) {
    b.t = 0;
    b.level--;
  }
  return loss;
}

/** Bind every wound shut. */
export function bind(b: Bleed): number {
  const n = b.level;
  b.level = 0;
  b.t = 0;
  return n;
}

export function bleedLabel(level: number): string {
  return level >= 3 ? 'HEAVY BLEEDING' : level === 2 ? 'BLEEDING' : level === 1 ? 'BLEEDING (LIGHT)' : '';
}

// ------------------------------------------------------------------ weapon wear

/** Condition is 0 to 1 and missing means mint. */
export const wearOf = (cond: number | undefined) => clamp(cond ?? 1, 0, 1);

export const WEAR = {
  /** Condition lost per shot, and per swing. */
  shot: 0.0032,
  swing: 0.011,
  /** Above this a weapon plays like new. */
  fine: 0.6,
  /** At or below this a gun can jam. */
  worn: 0.3,
} as const;

/** Spread multiplier for a gun: worn barrels wander. */
export function wearSpread(cond: number | undefined): number {
  const c = wearOf(cond);
  return c >= WEAR.fine ? 1 : 1 + (1 - c / WEAR.fine) * 0.7;
}

/** Damage multiplier for a blade or club: a dull edge bites less. */
export function wearDamage(cond: number | undefined): number {
  const c = wearOf(cond);
  return c >= WEAR.fine ? 1 : 0.65 + 0.35 * (c / WEAR.fine);
}

/** Chance that one shot jams the gun. Zero until the gun is worn out, then it climbs. */
export function jamChance(cond: number | undefined): number {
  const c = wearOf(cond);
  return c > WEAR.worn ? 0 : 0.03 + (1 - c / WEAR.worn) * 0.12;
}

/** What one use costs, a little more for the hard-hitting end of the rack. */
export function wearBy(cond: number | undefined, amount: number): number {
  return clamp(wearOf(cond) - amount, 0, 1);
}

/** Scrap to bring a weapon back to mint. Rarer ones cost more. */
export function repairCost(cond: number | undefined, rarity: number): number {
  const missing = 1 - wearOf(cond);
  return missing < 0.02 ? 0 : Math.max(1, Math.ceil(missing * (3 + rarity * 4)));
}

export function wearLabel(cond: number | undefined): string {
  const c = wearOf(cond);
  return c >= 0.9 ? 'Like new' : c >= WEAR.fine ? 'Good' : c >= 0.35 ? 'Worn' : c >= 0.12 ? 'Failing' : 'Falling apart';
}

/** What a find looks like when it comes out of the dirt: not mint, mostly usable. `roll` is uniform [0,1). */
export function foundCondition(roll: number, rarity: number): number {
  const lo = 0.3 + (rarity - 1) * 0.06;
  return Math.round(clamp(lo + roll * (0.95 - lo), 0, 1) * 100) / 100;
}
