import { ENCOUNTERS, type EncounterDef, type EncounterEffects, type Stocks } from '../data';
import { Rng } from '../core/rng';

export interface Axes {
  mercy: number;
  trust: number;
  notoriety: number;
}
export const newAxes = (): Axes => ({ mercy: 0, trust: 0, notoriety: 0 });

/** Thresholds scaled to a full 14-leg campaign (each encounter moves an axis by 1 to 3). */
export const THRESH = {
  highMercy: 12,
  moderateMercy: 4,
  highNotoriety: 12,
  maxNotoriety: 24,
  minMercy: -10,
  lowTrust: -4,
};

export type EndingId = 'openGate' | 'toll' | 'twoWalked' | 'warlord' | 'hollow';

export interface EndingInput {
  axes: Axes;
  /** Crew that are alive, not deserted, and Loyal (70+). */
  loyalCrewAlive: number;
  /** Crew that are alive and still with the convoy. */
  crewAlive: number;
  fragments: number;
}

/**
 * Priority: the secret ending first, then the extremes, then the middle.
 * Anything that fits no ending falls to the quietest: Two Walked In.
 */
export function selectEnding(i: EndingInput): EndingId {
  const { axes } = i;
  if (i.fragments >= 4) return 'hollow';
  if (axes.notoriety >= THRESH.maxNotoriety && axes.mercy <= THRESH.minMercy) return 'warlord';
  if (axes.mercy >= THRESH.highMercy && i.loyalCrewAlive >= 2) return 'openGate';
  if (axes.notoriety >= THRESH.highNotoriety && axes.mercy >= THRESH.moderateMercy) return 'toll';
  if (axes.trust <= THRESH.lowTrust || i.crewAlive === 0) return 'twoWalked';
  if (axes.notoriety >= THRESH.highNotoriety) return 'toll';
  if (axes.mercy >= THRESH.moderateMercy && i.loyalCrewAlive >= 2) return 'openGate';
  return 'twoWalked';
}

/** Which ending the convoy is currently leaning toward, for the vague end-of-leg hint. */
export function leaning(axes: Axes): EndingId | 'neutral' {
  const m = axes.mercy;
  const n = axes.notoriety;
  if (n >= 4 && m <= -3) return 'warlord';
  if (n >= 4 && m >= 0) return 'toll';
  if (m >= 3) return 'openGate';
  if (axes.trust <= -2) return 'twoWalked';
  return 'neutral';
}

export function applyAxes(a: Axes, d: Partial<Axes> | undefined) {
  if (!d) return;
  a.mercy += d.mercy ?? 0;
  a.trust += d.trust ?? 0;
  a.notoriety += d.notoriety ?? 0;
}

// ------------------------------------------------------------ encounter picking

export interface EncounterContext {
  biome: 'wasteland' | 'city';
  seen: Set<string>;
}

/** Draw an encounter by context that hasn't been seen this run (falls back to repeats only if none are left). */
export function pickEncounter(ctx: EncounterContext, rng: Rng): EncounterDef | null {
  const pool = ENCOUNTERS.filter((e) => e.biome === ctx.biome);
  const fresh = pool.filter((e) => !ctx.seen.has(e.id));
  const from = fresh.length ? fresh : pool;
  return from.length ? rng.pick(from) : null;
}

export interface ResolvedEffects {
  stocks: Partial<Stocks>;
  axes: Partial<Axes>;
  loyalty: number;
  ambush: number;
  zombies: number;
  fragment: boolean;
}

/** Flatten an effect block, rolling any chance branch with the supplied RNG. */
export function resolveEffects(e: EncounterEffects, rng: Rng): ResolvedEffects {
  const out: ResolvedEffects = {
    stocks: { ...(e.stocks ?? {}) },
    axes: { ...(e.axes ?? {}) },
    loyalty: e.loyalty ?? 0,
    ambush: e.ambush ?? 0,
    zombies: e.zombies ?? 0,
    fragment: !!e.fragment,
  };
  if (e.chance && rng.next() < e.chance.p) {
    const f = resolveEffects(e.chance.fail, rng);
    for (const k of Object.keys(f.stocks) as (keyof Stocks)[]) out.stocks[k] = (out.stocks[k] ?? 0) + (f.stocks[k] ?? 0);
    out.axes.mercy = (out.axes.mercy ?? 0) + (f.axes.mercy ?? 0);
    out.axes.trust = (out.axes.trust ?? 0) + (f.axes.trust ?? 0);
    out.axes.notoriety = (out.axes.notoriety ?? 0) + (f.axes.notoriety ?? 0);
    out.loyalty += f.loyalty;
    out.ambush += f.ambush;
    out.zombies += f.zombies;
    if (f.fragment) out.fragment = true;
  }
  return out;
}

/**
 * Two-player vote. Agreement resolves immediately. Disagreement is decided by the Encounter Lead,
 * and overriding your partner costs one point of Trust.
 */
export function resolveVote(votes: [number, number], leadIndex: 0 | 1): { choice: number; overridden: boolean; trustCost: number } {
  if (votes[0] === votes[1]) return { choice: votes[0], overridden: false, trustCost: 0 };
  return { choice: votes[leadIndex], overridden: true, trustCost: 1 };
}
