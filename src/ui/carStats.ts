import { PARTS, VEHICLES, isGlassSlot, isInteriorSlot, mountsFor, partDef, type EngineSpec, type PartDef, type PartSlot, type PartStats, type VehicleDef } from '../data';
import { clamp } from '../core/math';
import { EMPTY_CABIN_TEXT, EMPTY_GLASS_TEXT, conditionLabel, effectiveStats, fitsChassis, isWorn, slotsOf, terrainGrip, type Fit, type PartItem, type Stats, type Tyres } from '../sim/parts';
import { insideUnits, surfacesOf } from '../sim/cargo';
import { factoryIdFor } from '../sim/drivetrain';
import { EMPTY_ID, factoryTyreId, tyreFits } from '../sim/garage';

/**
 * Every number the car screens show, in one place: what a part is (its key stats in plain words with units), what the whole car
 * adds up to against the factory car, what a swap would change, and whether a spare is worth keeping. Pure: it reads the sim
 * (`effectiveStats`, the part catalogue) and returns words and numbers, never HTML, so the inspect card, the storage panel, the
 * breakdown and the tests all say the same thing.
 *
 * The drivetrain model is being reworked with real masses and torque curves. Everything that model will own goes through
 * `carData` below, so wiring it in is a change to those few functions and nothing else.
 */

// ------------------------------------------------------------------------------------------------ the data hooks

/** The drivetrain figures that come from the physics model. Each returns null when the model does not know it yet. */
export const carData = {
  /** Peak torque of an engine, Nm. */
  engineTorque(e: EngineSpec): number | null {
    void e;
    return null;
  },
  /** The whole vehicle's weight, kg, as it stands. */
  mass(def: VehicleDef, fit: Fit, tyres: Tyres | undefined, st: Stats): number | null {
    void def;
    void fit;
    void tyres;
    return Number.isFinite(st.mass) && st.mass > 0 ? st.mass : null;
  },
  /** One part's own weight, kg, when the catalogue knows it. */
  partMass(d: PartDef): number | null {
    if (d.empty) return null;
    const m = d.engine?.mass ?? d.gearbox?.mass ?? d.suspension?.mass ?? (d as { mass?: number }).mass;
    return typeof m === 'number' && m > 0 ? m : null;
  },
  /**
   * Seconds from standstill to `toKmh` on asphalt at full throttle: stepped with the same force taper the wheel model uses
   * (`physics/vehicle.ts`), so it moves with power, gearing and weight. Null for a car that never gets there.
   */
  accel(def: VehicleDef, st: Stats, massKg: number | null, toKmh: number): number | null {
    const p = def.physics;
    if (p.kind === 'boat' || st.noEngine || st.noDrive || st.forceMult <= 0) return null;
    const vmax = (def.topSpeedKmh / 3.6) * st.topSpeedMult;
    const goal = toKmh / 3.6;
    if (vmax * 0.97 <= goal) return null;
    // The force the wheels get is the chassis' own times the engine's; weight over the factory car's slows the launch in proportion.
    const m = massKg && massKg > 0 ? massKg : p.mass;
    const f = p.engineForce * st.forceMult;
    let v = 0;
    let t = 0;
    const dt = 0.05;
    while (v < goal && t < 60) {
      const taper = clamp(1 - Math.pow(v / vmax, 2.2), 0, 1);
      // Rolling resistance takes a little off the top.
      const a = (f * taper) / m - 0.15;
      if (a <= 0.01) return null;
      v += a * dt;
      t += dt;
    }
    return t < 60 ? t : null;
  },
};

// ------------------------------------------------------------------------------------------------ words and units

export const fmt = {
  kw: (kw: number) => `${Math.round(kw)} kW`,
  hp: (kw: number) => `${Math.round(kw * 1.341)} hp`,
  power: (kw: number) => `${Math.round(kw)} kW (${Math.round(kw * 1.341)} hp)`,
  nm: (nm: number) => `${Math.round(nm)} Nm`,
  kg: (kg: number) => `${Math.round(kg)} kg`,
  kmh: (v: number) => `${Math.round(v)} km/h`,
  km: (v: number) => `${Math.round(v)} km`,
  secs: (s: number) => `${s.toFixed(1)} s`,
  pct: (f: number) => `${Math.round(f * 100)}%`,
  /** A share as a signed change: 0.08 is "+8%". */
  signed: (f: number) => `${f >= 0 ? '+' : '−'}${Math.round(Math.abs(f) * 100)}%`,
  /** A signed amount with its unit: "+12 km/h", "−40 kg". */
  delta: (v: number, unit: string, digits = 0) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}${unit ? ` ${unit}` : ''}`,
};

/** A part's quality in a word: a factory fitting, or its mark. */
export function markOf(d: PartDef): string {
  if (d.empty) return 'Empty';
  return d.stock ? 'Factory' : `Mk${d.mk}`;
}

/** Colour of a mark: the rarity colours, plain for factory parts. */
export const MARK_CSS = ['#cfc4a8', '#cfc4a8', '#7ddc7a', '#ffb454'];
export const markCss = (d: PartDef) => (d.empty ? '#8a8172' : d.stock ? MARK_CSS[0] : MARK_CSS[d.mk]);

/** How worn: a share, a word, and a tone for the bar. */
export interface CondInfo {
  pct: number;
  label: string;
  tone: 'good' | 'mid' | 'bad';
}

export function condInfo(cond: number, d?: PartDef): CondInfo {
  const pct = Math.round(clamp(cond, 0, 1) * 100);
  const glass = d && isGlassSlot(d.slot);
  const label = glass ? (cond >= 0.8 ? 'Whole' : cond >= 0.4 ? 'Cracked' : cond > 0.05 ? 'Crazed' : 'Gone') : conditionLabel(cond);
  return { pct, label, tone: pct < 35 ? 'bad' : pct < 70 ? 'mid' : 'good' };
}

/** Does this part wear (so its condition is worth a bar)? */
export const showsWear = (d: PartDef) => !d.empty && (isWorn(d.slot) || isGlassSlot(d.slot));

/** One key stat of a part: what it is and its value with units. `tone` says which way it cuts. */
export interface Fact {
  label: string;
  text: string;
  tone?: 'good' | 'bad';
}

/** The stat keys of a part, as labels with what a bigger number means. */
const STAT_WORDS: [keyof PartStats, string, boolean][] = [
  ['force', 'Power', true],
  ['top', 'Top speed', true],
  ['armor', 'Armour', true],
  ['armorF', 'Front armour', true],
  ['armorS', 'Side armour', true],
  ['armorR', 'Rear armour', true],
  ['hp', 'Hull', true],
  ['grip', 'Grip', true],
  ['travel', 'Suspension', true],
  ['offroad', 'Off-road', true],
  ['dmg', 'Gun damage', true],
  ['rate', 'Fire rate', true],
  ['tank', 'Fuel tank', true],
  ['plow', 'Zombie plough', true],
  ['ram', 'Ram damage', true],
  ['light', 'Headlights', true],
  ['steer', 'Steering lock', true],
  ['burn', 'Fuel burn', false],
  ['sig', 'Noise', false],
];

/** The stats of a catalogue entry as facts, best news first. */
function statFacts(st: PartStats): Fact[] {
  const out: Fact[] = [];
  for (const [k, label, up] of STAT_WORDS) {
    const v = st[k];
    if (typeof v !== 'number' || !v) continue;
    out.push({ label, text: fmt.signed(v), tone: v > 0 === up ? 'good' : 'bad' });
  }
  if (st.cargo) out.push({ label: 'Cargo', text: `${st.cargo > 0 ? '+' : ''}${st.cargo} space`, tone: st.cargo > 0 ? 'good' : 'bad' });
  if (st.spare) out.push({ label: 'Spare wheel', text: 'free tyre swaps', tone: 'good' });
  return out;
}

/**
 * What a part is, as a mechanic would read it off: an engine by output, torque, size, fuel and weight; a radiator by the heat it
 * sheds; a gearbox by what it carries; springs by the load; brakes by the stop; tyres by grip; the rest by what they add.
 */
export function partFacts(d: PartDef): Fact[] {
  const out: Fact[] = [];
  const mass = carData.partMass(d);
  if (d.empty) {
    const why = d.slot === 'hood' || d.slot === 'doorL' || d.slot === 'doorR' ? `no ${d.slot === 'hood' ? 'bonnet' : 'door'}: the mount is bare` : d.slot === 'wheels' ? 'a bare rim' : isInteriorSlot(d.slot) ? EMPTY_CABIN_TEXT[d.id] : isGlassSlot(d.slot) ? EMPTY_GLASS_TEXT[d.id] : d.slot === 'engine' ? 'no engine: it will not run' : d.slot === 'cooling' ? 'no cooling: it overheats fast' : d.slot === 'gearbox' ? 'no gearbox: nothing reaches the wheels' : 'nothing fitted';
    return [{ label: 'Empty', text: why ?? 'nothing fitted', tone: 'bad' }];
  }
  if (d.engine) {
    const e = d.engine;
    out.push({ label: 'Power', text: fmt.power(e.kw) });
    const nm = carData.engineTorque(e);
    if (nm) out.push({ label: 'Torque', text: fmt.nm(nm) });
    const size = e.litres < 0.7 ? `${Math.round(e.litres * 1000)} cc` : `${e.litres.toFixed(1)} L`;
    out.push({ label: 'Engine', text: `${size}${e.layout && e.layout !== 'none' && e.litres >= 0.7 ? ` ${e.layout}` : ''}${e.blown ? ' turbo' : ''} · ${e.fuel}` });
    out.push({ label: 'Size', text: `class ${e.size}` });
  } else if (d.cooling !== undefined) {
    out.push({ label: 'Cooling', text: fmt.kw(d.cooling) });
  } else if (d.gearbox) {
    const g = d.gearbox.gearing;
    out.push({ label: 'Carries', text: fmt.kw(d.gearbox.rating) });
    out.push({ label: 'Gearing', text: g > 0.05 ? 'short: quick launch' : g < -0.05 ? 'tall: higher top speed' : 'balanced' });
  } else if (d.suspension) {
    out.push({ label: 'Carries', text: fmt.kg(d.suspension.load) });
    out.push({ label: 'Travel', text: fmt.pct(d.suspension.travel), tone: d.suspension.travel >= 1 ? 'good' : 'bad' });
  } else if (d.brakes) {
    out.push({ label: 'Stops', text: `${Math.round(d.brakes.energy)} kJ` });
    out.push({ label: 'Bite', text: fmt.signed(d.brakes.power - 1), tone: d.brakes.power >= 1 ? 'good' : 'bad' });
  } else if (d.exhaust) {
    const f = d.exhaust.flow;
    out.push(Math.abs(f) < 0.005 ? { label: 'Power', text: 'as stock' } : { label: 'Power', text: fmt.signed(f), tone: f > 0 ? 'good' : 'bad' });
    out.push({ label: 'Noise', text: `×${d.exhaust.noise.toFixed(1)}`, tone: d.exhaust.noise > 1.05 ? 'bad' : d.exhaust.noise < 0.95 ? 'good' : undefined });
  } else if (d.glass) {
    out.push({ label: 'Toughness', text: `×${d.glass.hp.toFixed(1)}`, tone: d.glass.hp > 1.2 ? 'good' : undefined });
  }
  if (d.hold) {
    const what = d.hold.only === 'cans' ? 'cans' : d.hold.only === 'tyres' ? 'a spare tyre' : d.hold.max >= 4 ? 'large loads' : d.hold.max === 2 ? 'medium loads' : 'small loads';
    out.push({ label: 'Holds', text: `${d.hold.units} space · ${what}`, tone: 'good' });
  }
  if (!d.engine && !d.exhaust) out.push(...statFacts(d.stats));
  else if (d.engine) out.push(...statFacts(d.stats).filter((f) => f.label !== 'Power'));
  if (mass) out.push({ label: 'Weight', text: fmt.kg(mass) });
  return out;
}

// ------------------------------------------------------------------------------------------------ the whole car

/** What a car adds up to. Mass and torque are null where the model does not know them. */
export interface CarFigures {
  powerKw: number;
  torqueNm: number | null;
  massKg: number | null;
  topKmh: number;
  /** Seconds to `accelTo` km/h (100, or 50 for slow frames), estimated; null when it never gets there. */
  accelS: number | null;
  accelTo: number;
  /** Grip against the factory car on asphalt (1 is factory), on asphalt, hardpan, sand and mud. */
  grip: { road: number; dirt: number; sand: number; mud: number };
  armourPct: number;
  hull: number;
  /** Braking against the factory car. */
  brake: number;
  rangeKm: number;
  tankFu: number;
  /** Space inside (units, two per cargo point) and on the outside (roof, bed, racks). */
  inside: number;
  outside: number;
  noEngine: boolean;
  noDrive: boolean;
}

const surfaceGrip = (name: string) => VEHICLES.surfaces?.[name]?.grip ?? 1;

/** The factory tyres on every wheel: what a stock car stands on. */
export const stockTyres = (def: VehicleDef): Tyres => new Array(def.physics.wheelCount).fill(null);

/** What a car with these parts adds up to. */
export function carFigures(def: VehicleDef, fit: Fit, tyres?: Tyres): CarFigures {
  const st = effectiveStats(def, fit, tyres);
  const massKg = carData.mass(def, fit, tyres, st);
  const topKmh = def.topSpeedKmh * st.topSpeedMult;
  const accelTo = def.topSpeedKmh >= 115 ? 100 : 50;
  const g = st.gripMult;
  const torque = (() => {
    const e = partDef(fit.engine?.id ?? def.stockEngine ?? '');
    return e?.engine && !e.empty ? carData.engineTorque(e.engine) : null;
  })();
  return {
    powerKw: st.noEngine ? 0 : st.power,
    torqueNm: torque,
    massKg,
    topKmh,
    accelS: carData.accel(def, st, massKg, accelTo),
    accelTo,
    grip: { road: g * surfaceGrip('asphalt'), dirt: g * terrainGrip(surfaceGrip('hardpan'), st.offroad), sand: g * terrainGrip(surfaceGrip('sand'), st.offroad), mud: g * terrainGrip(surfaceGrip('mud'), st.offroad) },
    armourPct: st.armor,
    hull: def.hp * st.hpMult,
    brake: st.brakeMult,
    rangeKm: st.burnMult > 0 && def.burn > 0 ? st.tank / (def.burn * st.burnMult) : 0,
    tankFu: st.tank,
    inside: insideUnits(def, st.cargo, fit),
    outside: surfacesOf(def, fit).reduce((a, s) => a + s.units, 0),
    noEngine: st.noEngine,
    noDrive: st.noDrive,
  };
}

/** The car as it left the factory. */
export const stockFigures = (def: VehicleDef): CarFigures => carFigures(def, {}, stockTyres(def));

/** One line of the totals table: the value now, the factory value, and another car's for a comparison. */
export interface FigureRow {
  key: string;
  label: string;
  now: string;
  stock: string;
  other?: string;
  /** Which way "now" sits against the factory car (and the other car): 1 better, -1 worse, 0 the same. */
  vsStock: -1 | 0 | 1;
  vsOther?: -1 | 0 | 1;
}

/** Bigger is better, unless `lower`. Changes under `eps` (a share of the value) count as the same. */
function cmp(a: number | null, b: number | null, lower = false, eps = 0.015): -1 | 0 | 1 {
  if (a === null || b === null) return 0;
  const d = a - b;
  if (Math.abs(d) <= Math.abs(b) * eps + 1e-6) return 0;
  return (d > 0) !== lower ? 1 : -1;
}

/**
 * The totals as rows: power, torque and mass (where known), top speed, the sprint, grip on each ground, armour, hull, brakes,
 * range and room. `other` adds a third column for comparing two cars.
 */
export function figureRows(now: CarFigures, stock: CarFigures, other?: CarFigures): FigureRow[] {
  const rows: FigureRow[] = [];
  const add = (key: string, label: string, get: (f: CarFigures) => number | null, show: (v: number) => string, lower = false) => {
    const a = get(now);
    const s = get(stock);
    const o = other ? get(other) : null;
    if (a === null && s === null && o === null) return;
    const txt = (v: number | null) => (v === null ? '—' : show(v));
    rows.push({ key, label, now: txt(a), stock: txt(s), other: other ? txt(o) : undefined, vsStock: cmp(a, s, lower), vsOther: other ? cmp(a, o, lower) : undefined });
  };
  add('power', 'Power', (f) => f.powerKw, fmt.kw);
  add('torque', 'Torque', (f) => f.torqueNm, fmt.nm);
  add('mass', 'Weight', (f) => f.massKg, fmt.kg, true);
  add('top', 'Top speed', (f) => f.topKmh, fmt.kmh);
  add('accel', `0–${now.accelTo} km/h`, (f) => (f.accelTo === now.accelTo ? f.accelS : null), (v) => `${fmt.secs(v)} est.`, true);
  add('grip', 'Grip: road', (f) => f.grip.road, fmt.pct);
  add('gripDirt', 'Grip: dirt', (f) => f.grip.dirt, fmt.pct);
  add('gripSand', 'Grip: sand', (f) => f.grip.sand, fmt.pct);
  add('gripMud', 'Grip: mud', (f) => f.grip.mud, fmt.pct);
  add('armour', 'Armour', (f) => f.armourPct, fmt.pct);
  add('hull', 'Hull', (f) => f.hull, (v) => `${Math.round(v)} HP`);
  add('brake', 'Brakes', (f) => f.brake, fmt.pct);
  add('range', 'Range', (f) => f.rangeKm, fmt.km);
  add('cargo', 'Space inside', (f) => f.inside, (v) => `${Math.round(v)}`);
  add('outside', 'Space outside', (f) => f.outside, (v) => `${Math.round(v)}`);
  return rows;
}

// ------------------------------------------------------------------------------------------------ swaps

/** The parts list with `item` put at `mount` (a wheel number for a tyre, or the slot), as copies. */
export function swapped(def: VehicleDef, fit: Fit, tyres: Tyres | undefined, item: PartItem, at?: PartSlot | number): { fit: Fit; tyres: Tyres } {
  const d = partDef(item.id);
  const t: Tyres = tyres ? tyres.slice() : stockTyres(def);
  const f: Fit = { ...fit };
  if (d.slot === 'wheels') {
    if (typeof at === 'number') t[at] = item;
    else for (let i = 0; i < t.length; i++) if (tyreFits(def, i, item.id)) t[i] = item;
  } else {
    const opts = mountsFor(d.slot).filter((m) => slotsOf(def).includes(m));
    const slot = typeof at === 'string' && opts.includes(at) ? at : opts[0];
    if (slot) f[slot] = item;
  }
  return { fit: f, tyres: t };
}

/** The measure a slot is judged by, read off a car's stats: bigger is better. */
export function slotScore(slot: PartSlot, def: VehicleDef, st: Stats, fit: Fit): number {
  const armour = st.armor + (st.armorF + st.armorS + st.armorR) / 3;
  switch (slot) {
    case 'engine':
      // Power that the car can use: one that cooks itself or wrecks the gearbox is worth less.
      return st.noEngine ? 0 : st.power * (st.strain > 1.05 ? 0.75 : 1) * (st.coolKw < st.heat * 0.85 ? 0.8 : 1);
    case 'cooling':
      return st.coolKw;
    case 'gearbox':
      return st.noDrive ? 0 : Math.min(1.4, 1 / Math.max(0.3, st.strain)) * st.forceMult * st.topSpeedMult;
    case 'exhaust':
      return st.forceMult * st.topSpeedMult / Math.sqrt(st.sigMult);
    case 'suspension':
      return st.gripMult * st.travelMult;
    case 'brakes':
      return st.brakeMult;
    case 'wheels':
      return st.gripMult * (0.8 + 0.4 * st.offroad) * st.topSpeedMult;
    case 'weapon':
      return st.weapon ? st.damageMult * st.rateMult : 0;
    case 'utility':
    case 'roof':
    case 'rear':
      return 1 + st.cargo * 0.05 + st.tank * 0.01 + armour + st.light * 0.2 + surfacesOf(def, fit).reduce((a, s) => a + (s.holder ? s.holder.units * 0.02 : 0), 0);
    case 'front':
      return 1 + st.ram + st.plow + armour + st.light * 0.2;
    case 'steer':
      return st.steerMult;
    case 'seatD':
    case 'seatP':
    case 'seatR':
    case 'dash':
      return st.gripMult * (st.noPassengerSeat ? 0.95 : 1) * (st.noDash ? 0.95 : 1) / st.seatSpread;
    default:
      return 1 + armour + st.hpMult - 1 + st.topSpeedMult * 0.2;
  }
}

/** What the measure is called, for "+8% grip". */
export const SCORE_WORD: Partial<Record<PartSlot, string>> = {
  engine: 'power',
  cooling: 'cooling',
  gearbox: 'drive',
  exhaust: 'power',
  suspension: 'handling',
  brakes: 'braking',
  wheels: 'grip',
  weapon: 'firepower',
  steer: 'steering',
  front: 'ramming',
  armor: 'protection',
  side: 'protection',
  hood: 'protection',
  doorL: 'protection',
  doorR: 'protection',
};
export const scoreWord = (slot: PartSlot) => SCORE_WORD[slot] ?? (isGlassSlot(slot) ? 'protection' : 'use');

/** Glass is judged by the pane itself (its toughness, as worn as it is), not by what it does to the stats. */
function glassScore(item: PartItem | null): number {
  if (!item) return 0;
  const d = partDef(item.id);
  return d.empty ? 0 : (d.glass?.hp ?? 1) * (0.25 + 0.75 * item.cond);
}

/**
 * What the wear of the part in a slot costs, as the sim has it: a worn engine makes less power, a worn radiator sheds less
 * heat and a worn gearbox slips; a tyre is fine until it is flat. Everything else works the same worn or new.
 */
export function wearFactor(slot: PartSlot, cond: number): number {
  const c = clamp(cond, 0, 1);
  switch (slot) {
    case 'engine':
      return 0.45 + 0.55 * c;
    case 'cooling':
      return 0.4 + 0.6 * c;
    case 'gearbox':
      return c >= 0.5 ? 1 : 0.33 + 0.67 * (c / 0.5);
    case 'armor':
      return 0.5 + 0.5 * c;
    case 'wheels':
      return c <= 0.001 ? 0.3 : 1;
    default:
      return 1;
  }
}

/**
 * How much better (positive) or worse a car gets on its slot's measure with `item` put in at `at`, as a share. Null when it
 * does not go on this car at all. A tyre is judged as a set (grip is the mean of the wheels, so one tyre moves it a quarter as
 * much) against the most worn tyre on now; a flat one makes any sound tyre a big step up.
 */
export function swapGain(def: VehicleDef, fit: Fit, tyres: Tyres | undefined, item: PartItem, at?: PartSlot | number, current?: PartItem | null): number | null {
  if (!fitsChassis(def, item)) return null;
  const d = partDef(item.id);
  if (d.slot === 'wheels' && !tyresFor(def, item.id).length) return null;
  if (isGlassSlot(d.slot)) {
    const now = glassScore(current ?? null);
    const then = glassScore(item);
    return now > 0 ? then / now - 1 : then > 0 ? 1 : 0;
  }
  const before = effectiveStats(def, fit, tyres);
  const s = swapped(def, fit, tyres, item, d.slot === 'wheels' ? undefined : at);
  const after = effectiveStats(def, s.fit, s.tyres);
  const a = slotScore(d.slot, def, before, fit);
  const b = slotScore(d.slot, def, after, s.fit);
  const base = a * wearFactor(d.slot, current ? current.cond : 1);
  return base > 1e-6 ? (b * wearFactor(d.slot, item.cond)) / base - 1 : b > 0 ? 1 : 0;
}

/** The wheels of a chassis a tyre goes on (a motorcycle wheel only on its own hub). */
export function tyresFor(def: VehicleDef, id: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < def.physics.wheelCount; i++) if (tyreFits(def, i, id)) out.push(i);
  return out;
}

/** One change a swap makes, in words: "+8% grip", "+12 km/h top speed". */
export interface Delta {
  text: string;
  good: boolean;
  /** Size of the change, for picking the ones worth saying. */
  w: number;
}

/**
 * What putting `item` on (at `at`) changes about the whole car, the biggest changes first. Equal-ish figures are left out.
 */
export function swapDeltas(def: VehicleDef, fit: Fit, tyres: Tyres | undefined, item: PartItem, at?: PartSlot | number, max = 3): Delta[] {
  if (!fitsChassis(def, item)) return [];
  // Tyres are said as a set, as they are judged (`swapGain`).
  const s = swapped(def, fit, tyres, item, partDef(item.id).slot === 'wheels' ? undefined : at);
  const a = carFigures(def, fit, tyres);
  const b = carFigures(def, s.fit, s.tyres);
  const out: Delta[] = [];
  const share = (label: string, x: number, y: number, lower = false) => {
    if (x <= 0 && y <= 0) return;
    const r = x > 0 ? y / x - 1 : 1;
    if (Math.abs(r) < 0.015) return;
    out.push({ text: `${fmt.signed(r)} ${label}`, good: r > 0 !== lower, w: Math.abs(r) });
  };
  const abs = (label: string, x: number | null, y: number | null, unit: string, scale: number, lower = false) => {
    if (x === null || y === null) return;
    const dlt = y - x;
    if (Math.abs(dlt) < scale) return;
    out.push({ text: `${fmt.delta(dlt, unit)} ${label}`.trim(), good: dlt > 0 !== lower, w: Math.abs(dlt) / Math.max(1, Math.abs(x)) });
  };
  abs('', a.powerKw, b.powerKw, 'kW', 1);
  abs('top speed', a.topKmh, b.topKmh, 'km/h', 1);
  share('grip', a.grip.road, b.grip.road);
  share('off-road grip', a.grip.sand, b.grip.sand);
  share('armour', a.armourPct + 0.05, b.armourPct + 0.05);
  share('hull', a.hull, b.hull);
  share('braking', a.brake, b.brake);
  share('range', a.rangeKm, b.rangeKm);
  abs('', a.massKg, b.massKg, 'kg', 4, true);
  abs('space', a.inside, b.inside, '', 1);
  // Glass, seats and the rest that do not move the car's numbers still change something: the part's own stats.
  if (!out.length) {
    const d = partDef(item.id);
    if (d.glass) out.push({ text: `×${d.glass.hp.toFixed(1)} glass toughness`, good: d.glass.hp >= 1, w: 0 });
  }
  return out.sort((x, y) => y.w - x.w).slice(0, max);
}

// ------------------------------------------------------------------------------------------------ judging spares

/** A car the convoy owns, for judging spares against. */
export interface OwnCar {
  uid: string;
  name: string;
  def: VehicleDef;
  fit: Fit;
  tyres: Tyres;
  /** What is on each wheel now (its condition), for judging a tyre against the worst one. */
  tyreCond?: number[];
}

/** What a spare is good for. */
export interface Verdict {
  /** Cars it bolts onto. */
  fits: string[];
  /** It goes on the car being looked at. */
  fitsHere: boolean;
  /** Best gain over what is fitted, on the car being looked at (or, failing that, any car it fits), as a share. */
  gain: number | null;
  /** The car that gain is on. */
  gainOn: string | null;
  /** The measure ("grip", "power"). */
  word: string;
  /** Fits nothing the convoy owns, or is worse than what every car it fits already has. */
  junk: boolean;
}

/** The part on a car's mount for `slot` (the worst tyre for a tyre), so a spare is judged against what it would replace. */
function currentOn(car: OwnCar, slot: PartSlot): { item: PartItem | null; at: PartSlot | number | undefined } {
  if (slot === 'wheels') {
    let worst = -1;
    let wc = Infinity;
    car.tyres.forEach((_, i) => {
      const c = car.tyreCond?.[i] ?? 1;
      if (c < wc) {
        wc = c;
        worst = i;
      }
    });
    const i = Math.max(0, worst);
    const t = car.tyres[i];
    return { item: t ?? { uid: 'x', id: factoryTyreId(car.def, i), cond: car.tyreCond?.[i] ?? 1 }, at: i };
  }
  const mount = mountsFor(slot).find((m) => slotsOf(car.def).includes(m));
  if (!mount) return { item: null, at: undefined };
  const it = car.fit[mount];
  if (it) return { item: it, at: mount };
  const id = slot === 'engine' ? car.def.stockEngine : slot === 'cooling' ? car.def.stockRadiator : factoryIdFor(car.def, mount);
  return { item: id ? { uid: 'x', id, cond: 1 } : null, at: mount };
}

/** Judge a spare: which cars it fits, how much better it is than what is fitted, and whether it is junk. */
export function judgeSpare(item: PartItem, here: OwnCar | null, cars: OwnCar[]): Verdict {
  const d = partDef(item.id);
  const word = scoreWord(d.slot);
  const fitsList = cars.filter((c) => fitsChassis(c.def, item) && (d.slot !== 'wheels' || tyresFor(c.def, item.id).length > 0));
  const fitsHere = !!here && fitsChassis(here.def, item) && (d.slot !== 'wheels' || tyresFor(here.def, item.id).length > 0);
  const gainOf = (car: OwnCar) => {
    const cur = currentOn(car, d.slot);
    return swapGain(car.def, car.fit, car.tyres, item, cur.at, cur.item);
  };
  let gain: number | null = null;
  let gainOn: string | null = null;
  if (fitsHere && here) {
    gain = gainOf(here);
    gainOn = here.name;
  }
  let anyBetter = gain !== null && gain > 0.01;
  for (const c of fitsList) {
    if (here && c.uid === here.uid) continue;
    const g = gainOf(c);
    if (g !== null && g > 0.01) anyBetter = true;
    if (!fitsHere && g !== null && (gain === null || g > gain)) {
      gain = g;
      gainOn = c.name;
    }
  }
  // A placeholder for an empty mount is never a spare; anything that fits something and is not worse everywhere is kept.
  const junk = !fitsList.length || (!anyBetter && !d.stock && fitsList.every((c) => (gainOf(c) ?? -1) < -0.02));
  return { fits: fitsList.map((c) => c.name), fitsHere, gain, gainOn, word, junk: junk && !d.empty };
}

/** Every component of a car, each as it stands: what is in the mount, how worn it is, and its own stats. */
export interface ComponentRow {
  slot: PartSlot;
  /** For tyres: the wheel. */
  wheel?: number;
  /** "Engine", "Front left tyre". */
  label: string;
  group: string;
  id: string | null;
  name: string;
  mark: string;
  css: string;
  state: 'fitted' | 'factory' | 'empty';
  cond: number | null;
  facts: Fact[];
}

/** The garage's groups, in order. */
export const COMPONENT_GROUPS: { name: string; slots: PartSlot[] }[] = [
  { name: 'Powertrain', slots: ['engine', 'cooling', 'gearbox', 'exhaust'] },
  { name: 'Running gear', slots: ['suspension', 'brakes', 'wheels'] },
  { name: 'Body', slots: ['hood', 'doorL', 'doorR', 'armor', 'side', 'front', 'rear', 'roof'] },
  { name: 'Fittings', slots: ['weapon', 'utility'] },
  { name: 'Cabin', slots: ['seatD', 'seatP', 'seatR', 'steer', 'dash'] },
  { name: 'Glass', slots: ['glassF', 'glassB', 'glassL', 'glassR'] },
];

/** What a wheel is called by where it sits. */
export function wheelName(n: number, count: number): string {
  if (count <= 2) return n === 0 ? 'Front' : 'Rear';
  if (count === 3) return n === 0 ? 'Front' : n === 1 ? 'Rear left' : 'Rear right';
  const axle = Math.floor(n / 2);
  const axles = Math.ceil(count / 2);
  const end = axle === 0 ? 'Front' : axle === axles - 1 ? 'Rear' : `Axle ${axle + 1}`;
  return `${end} ${n % 2 === 0 ? 'left' : 'right'}`;
}

/** The condition source for a component row: a build's own `comp`, or a live vehicle's health. */
export interface CompLike {
  engine: number;
  tires: number[];
  plates: number;
  radiator?: number;
  gearbox?: number;
}

/** How worn the part in a slot is, read from the car's components (the slots that wear) or the part itself. */
export function condIn(slot: PartSlot, fitted: PartItem | undefined, comp: CompLike, wheel?: number, glass?: (slot: PartSlot) => number): number | null {
  switch (slot) {
    case 'engine':
      return comp.engine;
    case 'cooling':
      return comp.radiator ?? 1;
    case 'gearbox':
      return comp.gearbox ?? 1;
    case 'armor':
      return comp.plates;
    case 'wheels':
      return comp.tires[wheel ?? 0] ?? 1;
  }
  if (isGlassSlot(slot)) return glass ? glass(slot) : fitted?.cond ?? 1;
  return fitted ? fitted.cond : null;
}

/** Every component, grouped as the garage groups them. `idIn` is what the mount holds (fitted or factory), null if empty. */
export function componentRows(def: VehicleDef, fit: Fit, tyres: Tyres, comp: CompLike, idIn: (slot: PartSlot) => string | null, tyreId: (i: number) => string | null, glass?: (slot: PartSlot) => number): ComponentRow[] {
  const have = slotsOf(def);
  const out: ComponentRow[] = [];
  const row = (slot: PartSlot, group: string, id: string | null, label: string, fitted: PartItem | null | undefined, wheel?: number): ComponentRow => {
    const d = id ? partDef(id) : null;
    const emptyId = EMPTY_ID[slot] ?? (slot === 'wheels' ? 'tyre_none' : undefined);
    const shown = d ?? (emptyId ? partDef(emptyId) : null);
    const state: ComponentRow['state'] = !d ? 'empty' : fitted && !partDef(fitted.id).stock ? 'fitted' : 'factory';
    return {
      slot,
      wheel,
      label,
      group,
      id,
      name: d ? d.name : 'Empty mount',
      mark: d ? markOf(d) : 'Empty',
      css: d ? markCss(d) : '#8a8172',
      state,
      cond: d && showsWear(d) ? condIn(slot, fitted ?? undefined, comp, wheel, glass) : null,
      facts: shown ? partFacts(shown) : [],
    };
  };
  for (const g of COMPONENT_GROUPS) {
    for (const slot of g.slots) {
      if (!have.includes(slot)) continue;
      if (slot === 'wheels') {
        tyres.forEach((t, i) => out.push(row('wheels', g.name, tyreId(i), `${wheelName(i, tyres.length)} tyre`, t, i)));
        continue;
      }
      out.push(row(slot, g.name, idIn(slot), PARTS.labels[slot], fit[slot]));
    }
  }
  return out;
}
