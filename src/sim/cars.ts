import { INTERIOR_NONE, INTERIOR_SLOTS, PARTS, VEHICLES, chassisDef, partDef, type PartSlot } from '../data';
import { Rng } from '../core/rng';
import { clamp } from '../core/math';
import { EMPTY_ID, installPart, newBuild, type VehicleBuild } from './garage';
import { newPart, rollPart, slotsOf } from './parts';
import { emptyBody } from './bodywork';

/**
 * A world car is a burnt-out hulk (strip it for parts), a rough runner (fix it up), or sound enough to drive away. That is
 * what the game draws; `CarGrade` is what the car actually is underneath, and says what is missing from it.
 */
export type CarStatus = 'hulk' | 'rough' | 'intact';

/**
 * How complete a found car is. Almost nothing out there is whole: most cars still have their core mechanicals (engine,
 * radiator, gearbox, perhaps worn) and have lost body parts and wheels to the road, the weather and whoever came before. A
 * few are complete. Some are donors, with the engine or radiator long gone but the good bolt-ons still fitted. That is the
 * stock a convoy builds its own ride from.
 */
export type CarGrade =
  /** Everything fitted: drivable once it has fuel and air in the tyres. */
  | 'complete'
  /** Core present and worn, with the faults a repair job fixes. */
  | 'rough'
  /** Core present, a random handful of body parts, wheels, glass and trim gone. The common one. */
  | 'incomplete'
  /** The engine, radiator or gearbox is gone, a good bolt-on or two is still fitted: a car to strip. */
  | 'donor'
  /** Burnt out. Charred, wheelless and worthless to drive, with its worn core and its bolt-ons still on it. */
  | 'hulk'
  /** A dealership's stock: clean and whole, the odd wheel stolen. */
  | 'showroom'
  /** On the bay floor of a garage, half taken apart: hood off, wheels off, one core part on the bench. */
  | 'workshop';

export interface CarRoll {
  status: CarStatus;
  grade: CarGrade;
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

type Odds = [CarGrade, number][];

/** The mix of an ordinary roadside car, by biome: a few are whole, most have lost their body parts, many are donors. */
const ODDS: Record<'wasteland' | 'city', Odds> = {
  wasteland: [['complete', 0.1], ['rough', 0.17], ['incomplete', 0.4], ['donor', 0.17], ['hulk', 0.16]],
  city: [['complete', 0.07], ['rough', 0.13], ['incomplete', 0.38], ['donor', 0.2], ['hulk', 0.22]],
};

/** Near the start the road is kinder: a convoy that has only mopeds must be able to find something to build a runner from. */
const NEAR_START: Odds = [['complete', 0.16], ['rough', 0.26], ['incomplete', 0.38], ['donor', 0.12], ['hulk', 0.08]];
/** How far out (0 to 1 of the map) that kindness lasts. */
export const NEAR_REACH = 0.3;

/** The odds of each grade for a car this far out. */
export function gradeOdds(biome: 'wasteland' | 'city', reach = 0.5): Odds {
  const n = clamp(1 - reach / NEAR_REACH, 0, 1);
  return ODDS[biome].map(([g, w], i) => [g, w * (1 - n) + NEAR_START[i][1] * n] as [CarGrade, number]);
}

/** A sump level from the car's own seed, so the oil roll never shifts any other roll. */
function oilOf(seed: number, lo: number, hi: number): number {
  const u = (Math.imul(seed | 0, 2654435761) >>> 8) / 16777216;
  return lo + (hi - lo) * u;
}

/** Slots a body shell loses without the engine caring: bonnet, doors and the running gear under it. */
export const BODY_SLOTS: PartSlot[] = ['hood', 'doorL', 'doorR', 'exhaust', 'brakes', 'suspension'];
/** The powertrain a car has to have to be worth building a runner round. */
export const CORE_SLOTS: PartSlot[] = ['engine', 'cooling', 'gearbox'];

/** A cheap, worn version of each cabin mount, and the nicer ones a donor or a showroom car keeps (the nicest only far out). */
const TORN: Record<string, string> = { seatD: 'seat_torn', seatP: 'seat_torn', seatR: 'bench_torn', steer: 'steer_chain', dash: 'dash_cracked' };
const NICE: Record<string, string[]> = { seatD: ['seat_bucket', 'seat_leather'], seatP: ['seat_bucket', 'seat_leather'], seatR: ['bench_fold', 'bench_rack'], steer: ['steer_sport'], dash: ['dash_gauge'] };

/**
 * The cabin: seats, wheel and dash go missing or get torn like any other part. A car with no wheel or no driver's seat is a
 * car you cannot properly drive, so it is mostly the wrecks that lack them, and near the start almost never a runner.
 * `miss` is the chance each mount is empty, `torn` that a present one is a cheap worn one, `nice` that it is a good one.
 */
function cabin(b: VehicleBuild, rng: Rng, o: { miss: number; torn: number; nice: number; core: number; reach: number }) {
  const have = slotsOf(chassisDef(b.chassis));
  for (const slot of INTERIOR_SLOTS) {
    if (!have.includes(slot)) continue;
    // The wheel and the driver's seat are the ones that matter: they go missing least.
    const m = o.miss * (slot === 'steer' || slot === 'seatD' ? o.core : 1);
    const r = rng.next();
    if (r < m) b.fit[slot] = newPart(INTERIOR_NONE[slot], 1);
    else if (r < m + o.torn) b.fit[slot] = newPart(TORN[slot], 1);
    else if (r < m + o.torn + o.nice) {
      const ids = NICE[slot].filter((id) => partDef(id).mk <= (o.reach > 0.5 ? 3 : 2));
      b.fit[slot] = newPart(rng.pick(ids), 1);
    }
  }
}

/** Is a cabin mount stripped bare on the build? */
export const cabinMissing = (b: VehicleBuild): PartSlot[] => INTERIOR_SLOTS.filter((s) => isMissing(b, s));

const wheelsOf = (b: VehicleBuild) => b.tyres.length;

/** Is this slot stripped bare on the build? */
export function isMissing(b: VehicleBuild, slot: PartSlot): boolean {
  const it = b.fit[slot];
  return !!it && !!partDef(it.id).empty;
}

/** Wheels with no tyre on them (a bare rim). */
export function bareWheels(b: VehicleBuild): number {
  let n = 0;
  for (const t of b.tyres) if (t && partDef(t.id).empty) n++;
  return n;
}

/** Every slot of the build with nothing in it, tyres counted as `wheels` when any wheel is bare. */
export function missingSlots(b: VehicleBuild): PartSlot[] {
  const out: PartSlot[] = [];
  const have = slotsOf(chassisDef(b.chassis));
  for (const slot of have) if (slot !== 'wheels' && isMissing(b, slot)) out.push(slot);
  if (bareWheels(b)) out.push('wheels');
  return out;
}

/** Pull a part off the build and leave its mount empty. False if this chassis has no such mount. */
function strip(b: VehicleBuild, slot: PartSlot): boolean {
  const none = EMPTY_ID[slot];
  if (!none || !slotsOf(chassisDef(b.chassis)).includes(slot)) return false;
  b.fit[slot] = newPart(none, 1);
  if (slot === 'engine') b.comp.engine = 0;
  else if (slot === 'cooling') {
    b.comp.radiator = 0;
    b.comp.coolant = 0;
  } else if (slot === 'gearbox') b.comp.gearbox = 0;
  return true;
}

function bareWheel(b: VehicleBuild, i: number) {
  b.tyres[i] = newPart('tyre_none', 1);
  b.comp.tires[i] = 0;
}

/** Glass: the windscreen goes first, then whatever else the road threw at it. */
function breakGlass(b: VehicleBuild, rng: Rng, p: number) {
  const glass: Record<string, number> = {};
  for (const key of ['ws', 'rw', 'sL0', 'sL1', 'sR0', 'sR1']) {
    const hit = key === 'ws' ? Math.min(0.95, p * 1.3) : p;
    if (rng.chance(hit)) glass[key] = rng.chance(0.55) ? 3 : rng.int(1, 2);
  }
  if (Object.keys(glass).length) (b.body ??= emptyBody()).glass = glass;
}

/** Bumpers and mirrors that came off in some old collision. */
function loseTrim(b: VehicleBuild, rng: Rng, p: number) {
  const gone: string[] = [];
  for (const tag of ['bumper:front', 'bumper:rear', 'mirror:1', 'mirror:-1']) if (rng.chance(p)) gone.push(tag);
  if (gone.length) (b.body ??= emptyBody()).gone = gone;
}

/** A good bolt-on somebody left fitted: the part a convoy is after when it strips a donor. */
function valuable(b: VehicleBuild, rng: Rng, reach: number, chance: number, charred = false) {
  if (!rng.chance(chance)) return;
  const mk = reach > 0.55 ? 3 : reach > 0.2 ? 2 : 1;
  const slots: PartSlot[] = ['engine', 'cooling', 'gearbox', 'suspension', 'brakes', 'exhaust', 'armor', 'front', 'roof', 'rear', 'side', 'utility'];
  const have = slotsOf(chassisDef(b.chassis));
  const it = rollPart(rng, { slots: slots.filter((s) => have.includes(s) && !isMissing(b, s)), minMk: 1, maxMk: rng.chance(0.4) ? mk : Math.max(1, mk - 1), condLo: charred ? 0.15 : 0.45, condHi: charred ? 0.45 : 0.92 });
  installPart(b, it);
}

/**
 * Decide what a world car is, deterministically from its seed. Most are incomplete: the core mechanicals are usually
 * still there, worn, but a random subset of the bonnet, doors, exhaust, brakes, springs, tyres, trim and glass is missing,
 * and in a cluster of cases (donors, hulks) the engine or radiator is gone too while the good bolt-ons stay fitted.
 *
 * `status` forces how the car is drawn (a hulk, a runner, or sound); `grade` forces what it is; `reach` (how far from the
 * start, 0 to 1) makes the near-start road kinder and the far one richer in good fitted parts.
 */
export function rollCar(seed: number, o: { biome: 'wasteland' | 'city'; chassis?: string; status?: CarStatus; grade?: CarGrade; reach?: number }): CarRoll {
  const rng = new Rng((Math.imul(seed | 0, 2246822519) ^ 0x9e3779b1) >>> 0);
  const chassis = o.chassis ?? pickChassis(rng);
  const reach = clamp(o.reach ?? 0.5, 0, 1);
  const rollG = rng.next();
  const paint = PARTS.paints[Math.floor(rng.next() * PARTS.paints.length)].c;
  const b = newBuild(chassis, { seed: Math.floor(rng.next() * 1e6), paint });
  b.stripe = rng.chance(0.16) ? rng.int(1, 3) : 0;
  b.stripeColor = rng.pick([0xe9dfc7, 0x1c1c1c, 0xc2402e, 0xe0be1a]);
  // The grade: forced, implied by a forced status, or rolled from the odds of the place.
  let grade: CarGrade = o.grade ?? 'incomplete';
  if (!o.grade) {
    if (o.status === 'hulk') grade = 'hulk';
    else if (o.status === 'intact') grade = 'complete';
    else {
      const odds = gradeOdds(o.biome, reach).filter(([g]) => !(o.status === 'rough' && (g === 'complete' || g === 'hulk')));
      let r = rollG * odds.reduce((a, [, w]) => a + w, 0);
      grade = odds[odds.length - 1][0];
      for (const [g, w] of odds) {
        r -= w;
        if (r <= 0) {
          grade = g;
          break;
        }
      }
    }
  }
  const wheels = wheelsOf(b);
  const have = slotsOf(chassisDef(b.chassis));
  const removable = BODY_SLOTS.filter((s) => have.includes(s));
  let status: CarStatus = 'rough';

  switch (grade) {
    case 'complete':
    case 'showroom': {
      status = 'intact';
      const showroom = grade === 'showroom';
      b.hp = showroom ? rng.range(0.85, 1) : rng.range(0.55, 0.95);
      b.comp.engine = showroom ? rng.range(0.85, 1) : rng.range(0.7, 1);
      b.comp.radiator = showroom ? rng.range(0.85, 1) : rng.range(0.7, 1);
      b.comp.gearbox = showroom ? rng.range(0.85, 1) : rng.range(0.7, 1);
      b.comp.plates = showroom ? rng.range(0.85, 1) : rng.range(0.55, 1);
      b.fuel = showroom ? rng.range(0.05, 0.25) : rng.range(0.15, 0.55);
      b.comp.oil = oilOf(b.seed, showroom ? 0.5 : 0.2, showroom ? 0.9 : 0.8);
      if (rng.chance(showroom ? 0.15 : 0.2)) b.comp.tires[rng.int(0, wheels - 1)] = 0;
      if (showroom && rng.chance(0.25)) bareWheel(b, rng.int(0, wheels - 1));
      break;
    }
    case 'rough': {
      b.hp = rng.range(0.28, 0.68);
      b.comp.engine = rng.chance(0.3) ? 0 : rng.range(0.15, 0.8);
      b.comp.radiator = rng.range(0.25, 0.9);
      b.comp.gearbox = rng.range(0.3, 0.9);
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
      // A rough car has usually lost a panel or a pipe on top.
      for (const slot of removable) if (rng.chance(0.12)) strip(b, slot);
      break;
    }
    case 'incomplete':
    case 'workshop': {
      b.hp = rng.range(0.2, 0.7);
      b.comp.engine = rng.range(0.2, 0.85);
      b.comp.radiator = rng.range(0.25, 0.9);
      b.comp.gearbox = rng.range(0.3, 0.9);
      b.comp.plates = rng.range(0.2, 0.7);
      b.fuel = rng.range(0, 0.3);
      b.comp.oil = oilOf(b.seed, 0.02, 0.4);
      b.comp.leaking = rng.chance(0.15);
      const work = grade === 'workshop';
      // Each of the body parts is independently gone or not; at least two are, or it is not much of a find.
      const odds: Partial<Record<PartSlot, number>> = work ? { hood: 0.9, doorL: 0.4, doorR: 0.4, exhaust: 0.3, brakes: 0.2, suspension: 0.15 } : { hood: 0.6, doorL: 0.5, doorR: 0.5, exhaust: 0.42, brakes: 0.3, suspension: 0.25 };
      let lost = 0;
      for (const slot of removable) if (rng.chance(odds[slot] ?? 0.3) && strip(b, slot)) lost++;
      for (let i = 0; i < wheels; i++) {
        if (rng.chance(work ? 0.85 : 0.35)) {
          bareWheel(b, i);
          lost++;
        } else if (rng.chance(0.2)) b.comp.tires[i] = 0;
      }
      const pool = removable.filter((s) => !isMissing(b, s));
      while (lost < 2 && pool.length) {
        if (strip(b, pool.splice(rng.int(0, pool.length - 1), 1)[0])) lost++;
      }
      if (lost < 2) bareWheel(b, rng.int(0, wheels - 1));
      // The engine is on the bench: a garage car often has none, though the radiator and box are still in.
      if (work && rng.chance(0.55)) strip(b, 'engine');
      loseTrim(b, rng, 0.35);
      breakGlass(b, rng, 0.45);
      break;
    }
    case 'donor':
    case 'hulk': {
      const burnt = grade === 'hulk';
      status = burnt ? 'hulk' : 'rough';
      b.hp = burnt ? 0.05 : rng.range(0.1, 0.5);
      b.fuel = 0;
      b.comp.oil = 0;
      b.comp.coolant = 0;
      b.comp.tank = burnt ? 0 : 1;
      b.comp.mount = burnt ? 0 : 1;
      b.comp.plates = burnt ? 0.1 : rng.range(0.1, 0.5);
      // What is left of the powertrain is worn, and burnt-out ones are charred, but it is still fitted and can be pried off.
      b.comp.engine = burnt ? rng.range(0.12, 0.45) : rng.range(0.15, 0.7);
      b.comp.radiator = burnt ? rng.range(0.1, 0.35) : rng.range(0.15, 0.7);
      b.comp.gearbox = burnt ? rng.range(0.15, 0.5) : rng.range(0.2, 0.75);
      b.comp.tires = b.comp.tires.map(() => (burnt ? rng.range(0.08, 0.3) : rng.range(0.25, 0.85)));
      for (let i = 0; i < wheels; i++) if (rng.chance(burnt ? 0.7 : 0.55)) bareWheel(b, i);
      for (const slot of removable) if (rng.chance(burnt ? 0.4 : 0.5)) strip(b, slot);
      if (!burnt) {
        // A donor has lost at least one piece of the powertrain: the engine, the radiator or the box.
        const core = rng.pick([['engine'], ['cooling'], ['engine', 'cooling'], ['gearbox'], ['engine', 'gearbox'], ['cooling', 'gearbox']] as PartSlot[][]);
        for (const s of core) strip(b, s);
      }
      loseTrim(b, rng, 0.5);
      // The good kit is still on it: that is why it is worth the crowbar.
      valuable(b, rng, reach, burnt ? 0.55 : 0.75, burnt);
      if (rng.chance(0.3)) valuable(b, rng, reach, 1, burnt);
      break;
    }
  }

  if (grade !== 'donor' && grade !== 'hulk') {
    // Someone was working on it: a mild upgrade is already bolted on.
    if (rng.chance(grade === 'complete' || grade === 'showroom' ? 0.18 : 0.1)) {
      const it = rollPart(rng, { minMk: 1, maxMk: 1, condLo: 0.5, condHi: 0.9 });
      const slot = PARTS.parts.find((p) => p.id === it.id)!.slot;
      // Parts that need a mount the chassis has, and never one that would undo a stripped mount.
      if (slot !== 'wheels' && have.includes(slot) && !isMissing(b, slot)) b.fit[slot] = it;
    }
    // A hot rod: somebody dropped a bigger engine in and never upgraded the radiator. Drawn last so every other roll is unchanged.
    if (rng.chance(HOT_ROD) && !isMissing(b, 'engine')) {
      const e = rollPart(rng, { slots: ['engine'], minMk: 2, maxMk: 3, condLo: 0.5, condHi: 0.9 });
      b.fit.engine = e;
      b.comp.engine = Math.min(b.comp.engine, e.cond);
    }
  }
  // The cabin, drawn last so every other roll is what it was.
  const near = reach < NEAR_REACH;
  const cab: Record<CarGrade, { miss: number; torn: number; nice: number; core: number }> = {
    complete: { miss: 0, torn: 0.15, nice: 0.1, core: 0 },
    showroom: { miss: 0, torn: 0, nice: 0.45, core: 0 },
    rough: { miss: 0.05, torn: 0.25, nice: 0.05, core: 0 },
    incomplete: { miss: 0.34, torn: 0.25, nice: 0.04, core: near ? 0.1 : 0.55 },
    workshop: { miss: 0.3, torn: 0.2, nice: 0.04, core: 0.5 },
    donor: { miss: 0.12, torn: 0.15, nice: 0.5, core: 0.3 },
    hulk: { miss: 0.55, torn: 0.3, nice: 0.1, core: 0.9 },
  };
  cabin(b, rng, { ...cab[grade], reach });
  // Whoever swapped the engine ran it, so the tank holds what the engine in there burns.
  if (b.fit.engine && !partDef(b.fit.engine.id).empty) b.tank = partDef(b.fit.engine.id).engine!.fuel;
  return { status, grade, build: b };
}

/**
 * Parts a build still has on it that could be pried off: what a stripped car holds. A tyre counts per wheel. Used by tests
 * and by the viability check on the first couple of kilometres.
 */
export function fittedCore(b: VehicleBuild): { engine: boolean; radiator: boolean; gearbox: boolean; tyres: number } {
  return {
    engine: !isMissing(b, 'engine'),
    radiator: !isMissing(b, 'cooling'),
    gearbox: !isMissing(b, 'gearbox'),
    tyres: b.tyres.length - bareWheels(b),
  };
}
