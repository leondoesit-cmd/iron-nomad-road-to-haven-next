import { PARTS, VEHICLES, partDef } from '../data';
import { Rng } from '../core/rng';
import { newBuild, type VehicleBuild } from './garage';
import { rollPart } from './parts';

/** A world car is a burnt-out hulk (strip it for parts), a rough runner (fix it up), or sound enough to drive away. */
export type CarStatus = 'hulk' | 'rough' | 'intact';

export interface CarRoll {
  status: CarStatus;
  build: VehicleBuild;
}

/** One found-car chassis by loot weight: hatchbacks and sedans are common, vans are not. */
export function pickChassis(rng: Rng): string {
  const cars = VEHICLES.cars;
  const total = cars.reduce((a, c) => a + (c.lootWeight ?? 1), 0);
  let r = rng.next() * total;
  for (const c of cars) {
    r -= c.lootWeight ?? 1;
    if (r <= 0) return c.id;
  }
  return cars[0].id;
}

/** Share of drivable world cars with a bigger engine than they were built with. */
export const HOT_ROD = 0.08;

const ODDS: Record<'wasteland' | 'city', [number, number]> = {
  // [hulk, rough] — the rest is intact
  wasteland: [0.34, 0.46],
  city: [0.44, 0.4],
};

/** A sump level from the car's own seed, so the oil roll never shifts any other roll. */
function oilOf(seed: number, lo: number, hi: number): number {
  const u = (Math.imul(seed | 0, 2654435761) >>> 8) / 16777216;
  return lo + (hi - lo) * u;
}

/**
 * Decide what a world car is, deterministically from its seed. A rough car has two or three real faults,
 * so getting it moving is a small job of its own rather than a formality.
 */
export function rollCar(seed: number, o: { biome: 'wasteland' | 'city'; chassis?: string; status?: CarStatus }): CarRoll {
  const rng = new Rng((Math.imul(seed | 0, 2246822519) ^ 0x9e3779b1) >>> 0);
  const chassis = o.chassis ?? pickChassis(rng);
  const odds = ODDS[o.biome];
  const r = rng.next();
  const status: CarStatus = o.status ?? (r < odds[0] ? 'hulk' : r < odds[0] + odds[1] ? 'rough' : 'intact');
  const paint = PARTS.paints[Math.floor(rng.next() * PARTS.paints.length)].c;
  const b = newBuild(chassis, { seed: Math.floor(rng.next() * 1e6), paint });
  b.stripe = rng.chance(0.16) ? rng.int(1, 3) : 0;
  b.stripeColor = rng.pick([0xe9dfc7, 0x1c1c1c, 0xc2402e, 0xe0be1a]);
  const wheels = b.comp.tires.length;
  if (status === 'hulk') {
    b.hp = 0.05;
    b.comp = { engine: 0, tires: b.comp.tires.map(() => 0), tank: 0, mount: 0, plates: 0.1, oil: 0, radiator: 0.1, leaking: false };
    b.fuel = 0;
    return { status, build: b };
  }
  if (status === 'rough') {
    b.hp = rng.range(0.28, 0.68);
    b.comp.engine = rng.chance(0.3) ? 0 : rng.range(0.15, 0.8);
    b.comp.tires = b.comp.tires.map(() => (rng.chance(0.45) ? 0 : 1));
    b.comp.leaking = rng.chance(0.2);
    // Never hand out a car that only needs fuel: at least two different kinds of fault.
    const engineBad = () => b.comp.engine < 0.6;
    const flat = () => b.comp.tires.some((t) => t === 0);
    const kinds = () => (engineBad() ? 1 : 0) + (flat() ? 1 : 0) + (b.comp.leaking ? 1 : 0);
    if (kinds() < 2 && !flat()) b.comp.tires[rng.int(0, wheels - 1)] = 0;
    if (kinds() < 2 && !engineBad()) b.comp.engine = Math.min(b.comp.engine, 0.4);
    b.comp.plates = rng.range(0.3, 0.8);
    b.fuel = rng.range(0.04, 0.4);
    b.comp.oil = oilOf(b.seed, 0.02, 0.45);
  } else {
    b.hp = rng.range(0.55, 0.95);
    b.comp.engine = rng.range(0.7, 1);
    if (rng.chance(0.2)) b.comp.tires[rng.int(0, wheels - 1)] = 0;
    b.comp.plates = rng.range(0.55, 1);
    b.fuel = rng.range(0.15, 0.55);
    b.comp.oil = oilOf(b.seed, 0.2, 0.8);
  }
  // Someone was working on it: a mild upgrade is already bolted on.
  if (rng.chance(status === 'intact' ? 0.18 : 0.1)) {
    const it = rollPart(rng, { minMk: 1, maxMk: 1, condLo: 0.5, condHi: 0.9 });
    b.fit[PARTS.parts.find((p) => p.id === it.id)!.slot] = it;
  }
  // A hot rod: somebody dropped a bigger engine in and never upgraded the radiator. Drawn last so every other roll is unchanged.
  if (rng.chance(HOT_ROD)) {
    const e = rollPart(rng, { slots: ['engine'], minMk: 2, maxMk: 3, condLo: 0.5, condHi: 0.9 });
    b.fit.engine = e;
    b.comp.engine = Math.min(b.comp.engine, e.cond);
  }
  // Whoever swapped the engine ran it, so the tank holds what the engine in there burns.
  if (b.fit.engine) b.tank = partDef(b.fit.engine.id).engine!.fuel;
  return { status, build: b };
}
