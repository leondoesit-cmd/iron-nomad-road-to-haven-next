import type { Cost, Stocks } from '../data';
import { canAfford, costText } from './resources';
import type { VehicleHealth } from './damage';
import { STRAIGHT } from './bodywork';

export type RepairKind = 'fire' | 'leak' | 'tire' | 'engine' | 'radiator' | 'gearbox' | 'mount' | 'body';

export interface RepairJob {
  kind: RepairKind;
  /** What the prompt says, e.g. "Patch a tyre". */
  label: string;
  /** Seconds of holding the button. */
  secs: number;
  cost: Cost;
  /** Whether the convoy can pay for it right now. */
  ok: boolean;
  /** Why not, when it can't be done. */
  why?: string;
  /** Which wheel, for tyre jobs. */
  wheel?: number;
}

export interface RepairOpts {
  /** A spare wheel on the back: tyre swaps cost no Scrap and go faster. */
  spare?: boolean;
  /** Does the vehicle carry a weapon mount worth fixing? */
  weapon?: boolean;
  /** Extra speed from a Mechanic or a workshop (1 = normal). */
  speed?: number;
  /** How bent the body is, 0..1: a crumpled car wants hammering out even when its hit points are full. */
  dents?: number;
  /** Doors, mirrors and bumpers that have come off. */
  missing?: number;
  /** Windows that have gone. */
  glass?: number;
}

/** The single most urgent thing wrong, with what it costs. Fire first, then leaks, tyres, engine, mount, hull. */
export function planRepair(h: VehicleHealth, stocks: Stocks, o: RepairOpts = {}): RepairJob | null {
  if (h.destroyed) return null;
  const sp = o.speed ?? 1;
  const job = (kind: RepairKind, label: string, secs: number, cost: Cost, wheel?: number, fallback?: Cost): RepairJob => {
    // Proper parts first; improvised scrap work if that is all the convoy has, so nobody is ever stranded.
    const useFallback = !canAfford(stocks, cost) && !!fallback && canAfford(stocks, fallback);
    const c = useFallback ? (fallback as Cost) : cost;
    const ok = canAfford(stocks, c);
    return { kind, label: useFallback ? `${label} (improvised)` : label, secs: (useFallback ? secs * 1.4 : secs) / sp, cost: c, ok, why: ok ? undefined : `Need ${costText(cost)}`, wheel };
  };
  if (h.burning) return job('fire', 'Put out the fire', 2.5, {});
  if (h.leaking) return job('leak', 'Patch the fuel tank', 3, { scrap: 1 });
  const flat = h.comp.tires.findIndex((t) => t <= 0.001);
  if (flat >= 0) return job('tire', o.spare ? 'Swap on the spare' : 'Patch a tyre', o.spare ? 3 : 4.5, o.spare ? {} : { scrap: 2 }, flat);
  if (h.comp.engine < 0.999) return job('engine', 'Rebuild the engine', 7, { parts: 3 }, undefined, { scrap: 9 });
  if ((h.comp.radiator ?? 1) < 0.7) return job('radiator', 'Re-core the radiator', 5, { parts: 1, scrap: 2 }, undefined, { scrap: 6 });
  if ((h.comp.gearbox ?? 1) < 0.7) return job('gearbox', 'Strip and rebuild the gearbox', 7, { parts: 3 }, undefined, { scrap: 9 });
  if (o.weapon && h.comp.mount < 0.999) return job('mount', 'Fix the weapon mount', 4, { parts: 2 }, undefined, { scrap: 6 });
  const bent = (o.dents ?? 0) > STRAIGHT;
  if (h.hp < h.maxHp - 0.5 || h.comp.plates < 0.999 || bent) return job('body', bent ? 'Hammer out the dents' : 'Hammer out the bodywork', 5, { scrap: 2 });
  if ((o.missing ?? 0) > 0) return job('body', 'Weld a missing panel back on', 5, { scrap: 3 });
  if ((o.glass ?? 0) > 0) return job('body', 'Cut and fit new glass', 4, { scrap: 2 });
  return null;
}

/** Carry out a job that has been paid for. Returns a short result for the toast. */
export function applyRepair(h: VehicleHealth, job: RepairJob): string {
  switch (job.kind) {
    case 'fire':
      h.burning = false;
      return 'Fire out';
    case 'leak':
      h.leaking = false;
      h.comp.tank = Math.max(h.comp.tank, 0.8);
      return 'Tank patched';
    case 'tire': {
      const i = job.wheel ?? h.comp.tires.findIndex((t) => t <= 0.001);
      if (i >= 0) h.comp.tires[i] = 1;
      return 'Tyre fixed';
    }
    case 'engine':
      h.comp.engine = Math.min(1, h.comp.engine + 0.5);
      // A rebuilt engine goes back together with fresh oil in it, or it would seize again at once.
      h.comp.oil = Math.max(h.comp.oil, 0.6);
      return h.comp.engine >= 0.999 ? 'Engine rebuilt' : 'Engine running better';
    case 'radiator':
      h.comp.radiator = Math.min(1, (h.comp.radiator ?? 1) + 0.6);
      return 'Radiator patched';
    case 'gearbox':
      h.comp.gearbox = Math.min(1, (h.comp.gearbox ?? 1) + 0.6);
      return 'Gearbox rebuilt';
    case 'mount':
      h.comp.mount = 1;
      return 'Mount fixed';
    case 'body':
      h.hp = Math.min(h.maxHp, h.hp + h.maxHp * 0.12);
      h.comp.plates = Math.min(1, h.comp.plates + 0.15);
      return 'Bodywork repaired';
  }
}

/** Every job needed to get back to like-new, for showing "needs: 2 tyres, engine" without doing the work. */
export function listFaults(h: VehicleHealth): string[] {
  const out: string[] = [];
  if (h.burning) out.push('on fire');
  if (h.leaking) out.push('leaking fuel');
  const flats = h.comp.tires.filter((t) => t <= 0.001).length;
  if (flats) out.push(flats === 1 ? '1 flat tyre' : `${flats} flat tyres`);
  if (h.comp.engine < 0.15) out.push('engine dead');
  else if (h.comp.engine < 0.999) out.push('engine worn');
  if ((h.comp.radiator ?? 1) < 0.4) out.push('radiator holed');
  if ((h.comp.gearbox ?? 1) < 0.4) out.push('gearbox slipping');
  if (h.hp < h.maxHp * 0.5) out.push('badly dented');
  return out;
}
