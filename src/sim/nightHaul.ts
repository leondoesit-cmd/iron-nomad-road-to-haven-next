import { PARTS, isGlassSlot, type PartDef, type PartSlot } from '../data';
import { Rng, hashString } from '../core/rng';
import { clamp } from '../core/math';
import { isWorn } from './parts';
import { DRUGS } from './drugs';

/**
 * The night's haul: what a convoy that makes camp and holds it through the night raid finds at dawn (night camp is off by
 * default, so the camp is the player's choice, and this is what it is for). Ammunition for the guns they carry, one
 * uncommon-to-rare part for the cars, and something from the medicine chest. Pure: the roll is a function of the run's
 * seed and the day, so the same night always gives the same haul. Handed over by `game/nightHaul.ts`.
 */

/** A whole night held: the full haul. A night skipped after facing some of the raid: a share of it, no part. None: nothing. */
export type HaulGrade = 'full' | 'partial' | 'none';

/** The bolt-on kit the third kind of part is drawn from: armour, guns, cargo and the fittings outside the body. */
export const KIT_SLOTS: readonly PartSlot[] = ['armor', 'weapon', 'utility', 'front', 'roof', 'rear', 'side'];

export type HaulExtraId = 'medkit' | 'bandage' | 'medicine' | 'painkiller' | 'stim' | 'adrenaline' | 'weed' | 'alcohol';

/** The medicine chest's share, by weight, and how many of each come at once. */
const EXTRAS: readonly { id: HaulExtraId; w: number; n: number }[] = [
  { id: 'medkit', w: 2.2, n: 1 },
  { id: 'bandage', w: 2.4, n: 2 },
  { id: 'medicine', w: 2, n: 2 },
  { id: 'painkiller', w: 1.6, n: 1 },
  { id: 'stim', w: 1, n: 1 },
  { id: 'adrenaline', w: 0.7, n: 1 },
  { id: 'weed', w: 0.8, n: 1 },
  { id: 'alcohol', w: 0.6, n: 1 },
];

/** What the extra is called on the dawn report. */
export function haulExtraName(id: HaulExtraId, n = 1): string {
  if (id === 'medkit') return n > 1 ? `${n} Medkits` : 'Medkit';
  if (id === 'bandage') return n > 1 ? `${n} Bandages` : 'Bandage';
  if (id === 'medicine') return n > 1 ? `${n} Medicine` : 'Medicine';
  const name = DRUGS[id].name;
  return n > 1 ? `${n} × ${name}` : name;
}

export interface HaulRoll {
  grade: HaulGrade;
  /** Rounds for the convoy's guns. */
  ammo: number;
  /** Arrows, when somebody carries a bow. */
  arrows: number;
  /** The part, and which share of the draw it came from. Only a full haul has one. */
  part: { id: string; cond: number; tier: HaulTier } | null;
  extra: { id: HaulExtraId; n: number } | null;
}

export type HaulTier = 'mk2' | 'mk3' | 'kit';

export interface HaulOpts {
  seed: number;
  day: number;
  grade: HaulGrade;
  /** Waves faced, 0 to 3: a partial haul is that share of a full one. */
  waves: number;
  /** One load of every gun the players carry (their magazines summed); 0 with no gun at all. */
  mags: number;
  /** Somebody carries a bow. */
  bow: boolean;
  /** Part ids the convoy already has, fitted to the vehicles rolling out or in the trucks: not handed out again if avoidable. */
  have: ReadonlySet<string>;
  /** Whether a part has somewhere to go on one of the vehicles rolling out. Those come up three times as often. */
  fits?: (d: PartDef) => boolean;
}

/** The odds of each kind of part: mostly Mk2, a quarter Mk3 (more as the days go by), and the rest a piece of bolt-on kit. */
export function haulTierOdds(day: number): Record<HaulTier, number> {
  const shift = Math.min(0.15, Math.max(0, day - 1) * 0.02);
  return { mk2: 0.6 - shift, mk3: 0.25 + shift, kit: 0.15 };
}

/** Every part that can be handed out in one share of the draw. */
export function haulPool(tier: HaulTier): PartDef[] {
  return PARTS.parts.filter((p) => {
    if (p.stock || p.empty) return false;
    const kit = KIT_SLOTS.includes(p.slot);
    return tier === 'kit' ? kit && p.mk >= 2 : !kit && p.mk === (tier === 'mk3' ? 3 : 2);
  });
}

export function rollNightHaul(o: HaulOpts): HaulRoll {
  const rng = new Rng(hashString(`night-haul:${o.seed}:${o.day}`));
  // Every roll is made whatever the grade, in one order, so a night's haul is the same night however it went.
  const ammoRoll = rng.int(0, 20);
  const arrowRoll = rng.int(0, 6);
  const tierRoll = rng.next();
  const pickRoll = rng.next();
  const condRoll = rng.next();
  const extraRoll = rng.next();
  if (o.grade === 'none') return { grade: 'none', ammo: 0, arrows: 0, part: null, extra: null };
  const share = o.grade === 'full' ? 1 : clamp(o.waves / 3, 0.25, 0.67);
  // Two loads of every magazine carried, within reason, and a little more as the days get harder; a box for a convoy with no gun yet.
  const base = o.mags > 0 ? clamp(o.mags * 2, 40, 160) : 30;
  const ammo = Math.max(1, Math.round((base + ammoRoll + Math.min(30, o.day * 3)) * share));
  const arrows = o.bow ? Math.max(1, Math.round((8 + arrowRoll) * share)) : 0;
  const part = o.grade === 'full' ? pickPart(o, tierRoll, pickRoll, condRoll) : null;
  let r = extraRoll * EXTRAS.reduce((a, e) => a + e.w, 0);
  let extra = EXTRAS[EXTRAS.length - 1];
  for (const e of EXTRAS) {
    r -= e.w;
    if (r <= 0) {
      extra = e;
      break;
    }
  }
  return { grade: o.grade, ammo, arrows, part, extra: { id: extra.id, n: extra.n } };
}

function pickPart(o: HaulOpts, tierRoll: number, pickRoll: number, condRoll: number): HaulRoll['part'] {
  const odds = haulTierOdds(o.day);
  const tier: HaulTier = tierRoll < odds.mk2 ? 'mk2' : tierRoll < odds.mk2 + odds.mk3 ? 'mk3' : 'kit';
  const all = haulPool(tier);
  // Something the convoy does not have yet, if there is any such thing left in this share of the draw.
  const fresh = all.filter((p) => !o.have.has(p.id));
  const pool = fresh.length ? fresh : all;
  if (!pool.length) return null;
  const w = pool.map((p) => Math.max(0.05, p.weight) * (o.fits?.(p) ? 3 : 1));
  let r = pickRoll * w.reduce((a, b) => a + b, 0);
  let pick = pool[pool.length - 1];
  for (let i = 0; i < pool.length; i++) {
    r -= w[i];
    if (r <= 0) {
      pick = pool[i];
      break;
    }
  }
  // Worn kinds (an engine, tyres, glass) come out of a raider's stash used but sound.
  const cond = isWorn(pick.slot) || isGlassSlot(pick.slot) ? 0.82 + condRoll * 0.15 : 1;
  return { id: pick.id, cond, tier };
}
