import { FIT_SLOTS, PARTS, PART_SLOTS, isGlassSlot, isInteriorSlot, mountsFor, partDef, type FuelType, type ModuleSlot, type PartDef, type PartSlot, type PartStats, type VehicleDef } from '../data';
import { clamp } from '../core/math';
import type { Rng } from '../core/rng';
import { coolingKw, engineEffects, engineLine, type BayLabel } from './engines';
import { bodyOff, drivetrainEffects, gearTop } from './drivetrain';
import { coolantLitres, oilRate, sumpLitres } from './fluids';
import { cabinEffects, cabinGaps, cabinStatCounts } from './cabin';
import { OCCUPANT_KG, curbKg, referenceKg } from './massModel';
import { engineCurve, powerToWeight, powertrainFor, straightRun, topSpeed, type Powertrain } from './powertrain';

export { INTERIOR_SLOTS, isInteriorSlot } from '../data';
export { cabinGaps, cabinPart, canRidePassenger, type CabinGaps } from './cabin';

/**
 * A part you can carry: a catalogue entry plus how worn it is. Condition only matters for the parts that replace a
 * damaged component (engine, radiator, tyres, armour); everything else is always 1.
 */
export interface PartItem {
  uid: string;
  id: string;
  cond: number;
  /** Stowed on one particular vehicle's deck (a build uid). Unset parts ride wherever there is room. */
  on?: string;
}

/** What is bolted onto a vehicle, by slot. Tyres are not here: they are one per wheel (see `Tyres`). */
export type Fit = Partial<Record<PartSlot, PartItem>>;

/** The tyre on each wheel, in wheel order. `null` is the one the chassis was built with. */
export type Tyres = (PartItem | null)[];

let uidCounter = 1;
/** Unique within a save. Saves reseed the counter on load so new ids never collide with stored ones. */
export function newUid(prefix = 'i'): string {
  return `${prefix}${uidCounter++}`;
}
export function seedUids(used: Iterable<string>) {
  let max = 0;
  for (const u of used) {
    const n = parseInt(u.replace(/^\D+/, ''), 10);
    if (Number.isFinite(n)) max = Math.max(max, n);
  }
  uidCounter = Math.max(uidCounter, max + 1);
}

export function newPart(id: string, cond = 1): PartItem {
  return { uid: newUid('p'), id, cond: clamp(cond, 0, 1) };
}

export const CORE_SLOTS: PartSlot[] = ['engine', 'wheels', 'armor', 'weapon', 'utility'];

/** Slots whose part wears out with use: its condition is the vehicle's own component condition. */
export const WORN_SLOTS: PartSlot[] = ['engine', 'cooling', 'gearbox', 'wheels', 'armor'];
export const isWorn = (slot: PartSlot): boolean => WORN_SLOTS.includes(slot);

/** Slots a chassis accepts parts in. */
export function slotsOf(def: VehicleDef): PartSlot[] {
  return def.slots ?? PART_SLOTS;
}

/** Can a part of this category be bolted to this mount on this chassis? */
export function canMount(def: VehicleDef, category: PartSlot, mount: PartSlot): boolean {
  return mountsFor(category).includes(mount) && slotsOf(def).includes(mount) && (category === 'wheels' ? mount === 'wheels' : true);
}

/** Quality of the aftermarket part in a slot. A factory fitting (even one carried over from another car) counts as none. */
export function mkOf(fit: Fit, slot: PartSlot): number {
  const it = fit[slot];
  if (!it) return 0;
  const d = partDef(it.id);
  return d.stock ? 0 : d.mk;
}

/** The old five-slot Mk levels, for the raid threat estimate. */
export function modsOf(fit: Fit): Record<ModuleSlot, number> {
  return { engine: mkOf(fit, 'engine'), armor: mkOf(fit, 'armor'), wheels: mkOf(fit, 'wheels'), weapon: mkOf(fit, 'weapon'), utility: mkOf(fit, 'utility') };
}

export type WeaponKind = 'frontLMG' | 'bedMG' | 'topTurret' | 'autocannons' | 'mg';

/** Native weapon, or whatever a weapon part grants this chassis. */
export function weaponKind(def: VehicleDef, fit: Fit): WeaponKind | null {
  if (def.weapon) return def.weapon as WeaponKind;
  if (!fit.weapon) return null;
  const m = def.weaponMount ?? 'none';
  return m === 'bed' ? 'bedMG' : m === 'front' ? 'frontLMG' : null;
}

export const BASE_OFFROAD = 0.45;

export interface Stats {
  forceMult: number;
  topSpeedMult: number;
  armor: number;
  /** Extra armour for hits from the front, side and rear. */
  armorF: number;
  armorS: number;
  armorR: number;
  gripMult: number;
  travelMult: number;
  offroad: number;
  damageMult: number;
  rateMult: number;
  tank: number;
  cargo: number;
  hpMult: number;
  burnMult: number;
  sigMult: number;
  plow: number;
  ram: number;
  light: number;
  spare: boolean;
  weapon: WeaponKind | null;
  /** The engine in the bay: output (kW), what it burns, how much heat it makes and how well the radiator copes. */
  power: number;
  fuel: FuelType;
  heat: number;
  coolKw: number;
  /** Share of the radiator's airflow left by the engine crowding the bay. */
  airflow: number;
  bayLabel: BayLabel;
  /** Kilograms heavier than the factory engine. */
  massDelta: number;
  noEngine: boolean;
  /** Total weight with the engine and gearbox it carries, kg. */
  mass: number;
  /** Braking against the stock chassis (1 is stock), and the energy to shed in a stop from top speed against what the brakes take, kJ. */
  brakeMult: number;
  stopDemand: number;
  stopRating: number;
  /** Weight over what the springs carry. Above 1 the vehicle sags. */
  overload: number;
  /** Engine output over what the gearbox carries at full throttle. Above 1 the gearbox wears. */
  strain: number;
  gearboxRating: number;
  /** The gearbox is gone: nothing reaches the wheels. */
  noDrive: boolean;
  /** Doors off (0 to 2), bonnet off, and wheels with no tyre at all. */
  doorsOff: number;
  hoodOff: boolean;
  tyresGone: number;
  /** Litres of oil the engine holds, how fast it burns it against the baseline, and litres of water in the cooling system. */
  sumpL: number;
  oilRate: number;
  coolantL: number;
  /** Steering lock against the stock wheel (1 stock; tiny with no steering wheel). */
  steerMult: number;
  /** Gun spread for whoever shoots from the driver's seat (1 stock; worse sitting on the floor). */
  seatSpread: number;
  /** Metres the driver sits lower than a seat would put them. */
  seatDrop: number;
  /** Cabin parts that are not there: the steering wheel, a seat, the dashboard. */
  noSteer: boolean;
  noDriverSeat: boolean;
  noPassengerSeat: boolean;
  noRearSeat: boolean;
  noDash: boolean;
  /** The engine's torque curve: its peak (Nm) and where it comes, where the power peaks, and the redline (rpm). 0 with no engine. */
  peakTorque: number;
  peakTorqueRpm: number;
  peakPowerRpm: number;
  redline: number;
  /** Forward gears (a CVT counts as one), whether it is a CVT, and the final drive matched to this engine. */
  gears: number;
  cvt: boolean;
  finalDrive: number;
  /** Kilowatts per tonne with a driver aboard. */
  powerToWeight: number;
  /** Seconds from rest to 100 km/h on the flat with a driver and a full tank (Infinity when it never gets there). */
  zeroTo100: number;
  /** Top speed on the flat with a driver and a full tank, km/h. */
  topKmh: number;
}

const perfCache = new WeakMap<Powertrain, Map<number, { t100: number; top: number }>>();

/** The straight-line figures of a powertrain at a weight (kg, real), from the same drive model the physics runs. Cached. */
function perfOf(def: VehicleDef, pt: Powertrain, kg: number): { t100: number; top: number } {
  let byMass = perfCache.get(pt);
  if (!byMass) perfCache.set(pt, (byMass = new Map()));
  const key = Math.round(kg);
  const hit = byMass.get(key);
  if (hit) return hit;
  // The physics runs every chassis at the scale of its reference weight (the table's mass stands for stock with a driver).
  const m = (def.physics.mass * kg) / referenceKg(def);
  const r = pt.curve && !pt.noDrive ? { t100: straightRun(pt, m, [100 / 3.6], 40).times[0], top: topSpeed(pt, m) * 3.6 } : { t100: Infinity, top: 0 };
  byMass.set(key, r);
  return r;
}

const sum = (fit: Fit, k: keyof PartStats): number => {
  let t = 0;
  for (const slot of FIT_SLOTS) {
    const it = fit[slot];
    if (it && cabinStatCounts(slot, k)) t += partDef(it.id).stats[k] ?? 0;
  }
  return t;
};

/** A stat summed over the tyres and averaged across the wheels, so a mixed set counts as the mix it is. */
function tyreMean(tyres: Tyres | undefined, wheels: number, k: keyof PartStats): number {
  if (!tyres || wheels <= 0) return 0;
  let t = 0;
  for (let i = 0; i < wheels; i++) {
    const it = tyres[i];
    if (it) t += partDef(it.id).stats[k] ?? 0;
  }
  return t / wheels;
}

/** Wheels with no tyre on them at all. */
export function tyresGone(tyres: Tyres | undefined, wheels: number): number {
  let n = 0;
  for (let i = 0; i < wheels; i++) if (tyres?.[i] && partDef(tyres[i]!.id).empty) n++;
  return n;
}

/** Stats a chassis gets from its fitted parts. Pure, so it can be tested. */
export function effectiveStats(def: VehicleDef, fit: Fit, tyres?: Tyres): Stats {
  const ef = engineEffects(def, fit);
  const wheels = def.physics.wheelCount;
  const gone = tyresGone(tyres, wheels);
  const goneK = 1 - 0.18 * gone;
  const topMult = clamp(Math.max(0.5, 1 + sum(fit, 'top')) * ef.top * gearTop(def, fit) * goneK, 0.2, 2);
  // Every part has a weight (`sim/massModel.ts`): the curb weight is what the springs and the brakes are judged against.
  const curb = def.physics.kind === 'boat' ? def.physics.mass : curbKg(def, fit, tyres);
  const dt = drivetrainEffects(def, fit, ef, topMult, curb);
  const pt = def.physics.kind === 'boat' ? null : powertrainFor(def, fit, tyres);
  const run = pt ? perfOf(def, pt, curb + OCCUPANT_KG) : { t100: Infinity, top: 0 };
  const curve = pt?.curve ?? null;
  const off = bodyOff(def, fit);
  const spec = ef.spec;
  const sump = sumpLitres(spec.litres);
  const cab = cabinEffects(def, fit, sum(fit, 'steer'));
  const gaps = cabinGaps(def, fit);
  return {
    forceMult: Math.max(0.4, 1 + sum(fit, 'force')) * ef.force * dt.force * goneK,
    topSpeedMult: topMult,
    armor: clamp(def.armor + sum(fit, 'armor'), 0, 0.9),
    armorF: sum(fit, 'armorF'),
    // A door that is not there stops nothing on that side.
    armorS: sum(fit, 'armorS') - 0.06 * off.doors,
    armorR: sum(fit, 'armorR'),
    gripMult: (1 + sum(fit, 'grip') + tyreMean(tyres, wheels, 'grip')) * ef.grip * dt.grip * goneK * cab.seatGrip,
    travelMult: (1 + sum(fit, 'travel') + tyreMean(tyres, wheels, 'travel')) * ef.travel * dt.travel,
    offroad: clamp((def.offroad ?? BASE_OFFROAD) + sum(fit, 'offroad') + tyreMean(tyres, wheels, 'offroad'), 0, 1),
    damageMult: 1 + sum(fit, 'dmg'),
    rateMult: 1 + sum(fit, 'rate'),
    tank: def.tank * (1 + sum(fit, 'tank')),
    cargo: def.cargo + sum(fit, 'cargo'),
    hpMult: 1 + sum(fit, 'hp'),
    burnMult: Math.max(0.5, 1 + sum(fit, 'burn')) * ef.burn,
    sigMult: Math.max(0.5, 1 + sum(fit, 'sig')) * ef.sig * dt.sig,
    plow: sum(fit, 'plow'),
    ram: sum(fit, 'ram'),
    light: sum(fit, 'light'),
    spare: sum(fit, 'spare') > 0,
    weapon: weaponKind(def, fit),
    power: ef.spec.kw,
    fuel: ef.fuel,
    heat: ef.heat,
    coolKw: coolingKw(def, fit),
    airflow: clamp(ef.bay.airflow + sum(fit, 'airflow'), 0.3, 1.5),
    bayLabel: ef.bay.label,
    massDelta: ef.massDelta,
    noEngine: ef.empty,
    mass: dt.mass,
    brakeMult: dt.brake,
    stopDemand: dt.stopDemand,
    stopRating: dt.stopRating,
    overload: dt.overload,
    strain: dt.strain,
    gearboxRating: dt.gearboxRating,
    noDrive: dt.noDrive,
    doorsOff: off.doors,
    hoodOff: off.hood,
    tyresGone: gone,
    sumpL: sump,
    oilRate: oilRate(spec.litres, !!spec.blown, spec.fuel === 'diesel', sump),
    coolantL: coolantLitres(coolingKw(def, fit), spec.litres),
    steerMult: cab.steerMult,
    seatSpread: cab.spread,
    seatDrop: cab.drop,
    noSteer: gaps.steer,
    noDriverSeat: gaps.seatD,
    noPassengerSeat: gaps.seatP,
    noRearSeat: gaps.seatR,
    noDash: gaps.dash,
    peakTorque: curve?.peakNm ?? 0,
    peakTorqueRpm: curve?.peakTqRpm ?? 0,
    peakPowerRpm: curve?.peakPwRpm ?? 0,
    redline: curve?.redline ?? 0,
    gears: pt ? (pt.gearing.cvt ? 1 : pt.gearing.ratios.length) : 0,
    cvt: !!pt?.gearing.cvt,
    finalDrive: pt?.gearing.final ?? 0,
    powerToWeight: powerToWeight(ef.empty ? 0 : ef.spec.kw, curb + OCCUPANT_KG),
    zeroTo100: run.t100,
    topKmh: run.top,
  };
}

/** Sand and mud grip for a chassis: wide off-road tyres shrink the penalty, a road car doubles down on it. */
export function terrainGrip(surfaceGrip: number, offroad: number): number {
  const penalty = (1 - surfaceGrip) * clamp(1 + (BASE_OFFROAD - offroad) * 1.6, 0.35, 1.9);
  return clamp(1 - penalty, 0.2, 1.1);
}
export function terrainDrag(surfaceDrag: number, offroad: number): number {
  return surfaceDrag * clamp(1 + (BASE_OFFROAD - offroad) * 1.0, 0.4, 1.6);
}

// ---------------------------------------------------------------- naming and rarity

export const RARITY_NAMES = ['', 'Common', 'Uncommon', 'Rare'];
export const RARITY_CSS = ['', '#cfc4a8', '#7ddc7a', '#ffb454'];

export function partName(it: PartItem | PartDef): string {
  return 'name' in it ? it.name : partDef(it.id).name;
}

export function conditionLabel(cond: number): string {
  return cond >= 0.9 ? 'Like new' : cond >= 0.65 ? 'Good' : cond >= 0.4 ? 'Worn' : cond > 0.05 ? 'Barely holding' : 'Dead';
}

/** True if the part is built for a mount this chassis has. */
export function fitsChassis(def: VehicleDef, it: PartItem): boolean {
  return mountsFor(partDef(it.id).slot).some((m) => slotsOf(def).includes(m));
}

// ---------------------------------------------------------------- loot

export interface RollOpts {
  /** Only these slots. */
  slots?: PartSlot[];
  minMk?: number;
  maxMk?: number;
  /** Bias toward better quality: each point multiplies the weight of Mk n by (1 + bias * (n - 1)). */
  bias?: number;
  condLo?: number;
  condHi?: number;
}

/** A part lying in the world: id and wear only, so the world stays deterministic. */
export interface PartSpec {
  id: string;
  cond: number;
}

/** One random part from the catalogue by weight, as an id and a wear value. */
export function rollPartSpec(rng: Rng, o: RollOpts = {}): PartSpec {
  const loot = PARTS.parts.filter((p) => !p.stock);
  const pool = loot.filter((p) => (!o.slots || o.slots.includes(p.slot)) && p.mk >= (o.minMk ?? 1) && p.mk <= (o.maxMk ?? 3));
  const list = pool.length ? pool : loot;
  const w = list.map((p) => p.weight * (1 + (o.bias ?? 0) * (p.mk - 1)));
  const total = w.reduce((a, b) => a + b, 0);
  let r = rng.next() * total;
  let pick = list[list.length - 1];
  for (let i = 0; i < list.length; i++) {
    r -= w[i];
    if (r <= 0) {
      pick = list[i];
      break;
    }
  }
  // Glass comes out of wrecks as cracked as the road left it, so it is rolled like a worn part.
  const cond = isWorn(pick.slot) || isGlassSlot(pick.slot) ? rng.range(o.condLo ?? 0.5, o.condHi ?? 0.95) : 1;
  return { id: pick.id, cond };
}

/** One random part from the catalogue by weight. */
export function rollPart(rng: Rng, o: RollOpts = {}): PartItem {
  const s = rollPartSpec(rng, o);
  return newPart(s.id, s.cond);
}

/**
 * Worth in Scrap when a part is broken down. Scrap is only ever made this way: by deliberately breaking down a part you do
 * not need (or a vehicle, or gear). It does not lie about in the world and nothing hands it out for stripping a car.
 */
export function scrapValue(it: PartItem): number {
  const d = partDef(it.id);
  // What it would cost to make, as Scrap: the metal, the machining and the rare bits, scaled by what is left of it.
  return Math.max(1, Math.round(((d.cost.scrap ?? 0) * 0.6 + (d.cost.parts ?? 0) * 0.5 + (d.cost.tech ?? 0) * 1) * (0.5 + 0.5 * it.cond)));
}

// ---------------------------------------------------------------- descriptions

const pct = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`;

/** What a part is, in plain words: an engine's size, output and fuel, a radiator's rating, otherwise its stat changes. */
export function describePart(d: PartDef): string[] {
  if (d.engine) {
    if (d.empty) return ['no engine: the vehicle will not run'];
    const c = engineCurve(d.engine);
    const torque = c ? `${Math.round(c.peakNm)} Nm at ${rpmText(c.peakTqRpm)} · redline ${rpmText(c.redline)}` : '';
    return [engineLine(d.engine), ...(torque ? [torque] : []), `${Math.round(d.engine.mass)} kg · size ${d.engine.size}`];
  }
  if (d.cooling !== undefined) return d.empty ? ['no cooling: it will overheat fast'] : [`cooling ${Math.round(d.cooling)} kW`];
  if (d.gearbox) {
    if (d.empty) return ['no gearbox: nothing reaches the wheels'];
    const g = d.gearbox.gearing;
    const n = d.gearbox.ratios?.length ?? 0;
    const kind = d.gearbox.cvt ? 'CVT: no steps, it holds the engine where it pulls' : n ? `${n} speeds${(d.gearbox.shift ?? 0.3) <= 0.1 ? ', lightning shifts' : ''}` : '';
    return [`carries ${Math.round(d.gearbox.rating)} kW`, ...(kind ? [kind] : []), g > 0.05 ? 'short gears: quick off the line, lower top speed' : g < -0.05 ? 'tall gears: higher top speed, slower launch' : 'balanced gearing', `${Math.round(d.gearbox.mass)} kg`];
  }
  if (d.suspension) {
    if (d.empty) return ['no springs: the body sits on the axles'];
    return [`carries ${Math.round(d.suspension.load)} kg`, `${Math.round(d.suspension.travel * 100)}% travel`];
  }
  if (d.brakes) {
    if (d.empty) return ['no brakes: it will barely stop'];
    return [`stops ${Math.round(d.brakes.energy)} kJ`, `${d.brakes.power >= 1 ? '+' : ''}${Math.round((d.brakes.power - 1) * 100)}% bite`];
  }
  if (d.exhaust) {
    if (d.empty) return ['no exhaust: loud, and it still burns'];
    const f = d.exhaust.flow;
    return [`${f >= 0 ? '+' : ''}${Math.round(f * 100)}% power`, d.exhaust.noise > 1.05 ? `louder x${d.exhaust.noise.toFixed(1)}: the dead hear it too` : d.exhaust.noise < 0.95 ? 'quieter: harder to hear on the road' : 'stock noise'];
  }
  if (d.empty && (d.slot === 'hood' || d.slot === 'doorL' || d.slot === 'doorR')) return [`no ${d.slot === 'hood' ? 'bonnet' : 'door'}: the mount is bare`];
  if (d.empty && d.slot === 'wheels') return ['no tyre: a bare rim'];
  if (d.empty && isInteriorSlot(d.slot)) return [EMPTY_CABIN_TEXT[d.id] ?? 'an empty mount'];
  if (d.empty && isGlassSlot(d.slot)) return [EMPTY_GLASS_TEXT[d.id] ?? 'an empty frame'];
  if (d.glass) return [d.glass.hp >= 4 ? 'ballistic: stops rifle rounds for a long while' : d.glass.hp > 1.5 ? `laminated: ${d.glass.hp.toFixed(1)}x as tough as plain glass` : 'plain glass: a pistol round or a hard knock cracks it', ...describeStats(d.stats)];
  if (d.hold) {
    const size = d.hold.max >= 4 ? 'large' : d.hold.max === 2 ? 'medium' : 'small';
    const what = d.hold.only === 'cans' ? 'cans' : d.hold.only === 'tyres' ? 'a spare tyre' : `${size} loads`;
    return [`holds ${what} secure at any speed (${d.hold.units} units)`, ...describeStats(d.stats)];
  }
  return describeStats(d.stats);
}

/** What a frame with no glass in it costs you, in plain words. */
export const EMPTY_GLASS_TEXT: Record<string, string> = {
  gls_ws_none: 'no windscreen: wind, dust and rain come straight in, and a stone hits the driver',
  gls_rw_none: 'no rear window: an open frame at the back of the cab',
  gls_side_none: 'no side window: an open frame, and the door has nothing to wind up',
};

/** What a stripped cabin mount costs you, in plain words. */
export const EMPTY_CABIN_TEXT: Record<string, string> = {
  seat_none: 'no seat: nobody can ride here, and a driver sits on the floor (worse grip and aim)',
  bench_none: 'no rear seat: bare floor, room for a little cargo',
  steer_none: 'no steering wheel: the steering barely turns; it still goes straight',
  dash_none: 'no dashboard: the wiring hangs out and the lamps flicker',
};

/** Revs for reading: "3,900 rpm". */
export const rpmText = (rpm: number): string => `${(Math.round(rpm / 50) * 50).toLocaleString('en-US')} rpm`;

/**
 * How a whole build goes, in a few lines: its weight and power to weight, the engine's torque, the gears, and the figures
 * from the same drive model the physics runs ("1,080 kg · 46 kW/t", "87 Nm at 3,950 rpm", "5 speeds · 0-100 km/h 5.4 s",
 * "top 112 km/h"). For the garage and the inspection cards.
 */
export function describePerformance(st: Stats): string[] {
  if (st.noEngine) return [`${Math.round(st.mass).toLocaleString('en-US')} kg`, 'no engine'];
  const out = [`${Math.round(st.mass).toLocaleString('en-US')} kg · ${Math.round(st.powerToWeight)} kW/t`];
  if (st.peakTorque > 0) out.push(`${Math.round(st.peakTorque)} Nm at ${rpmText(st.peakTorqueRpm)}`);
  const box = st.noDrive ? 'no gearbox' : st.cvt ? 'CVT' : `${st.gears} speeds`;
  out.push(`${box} · 0-100 km/h ${Number.isFinite(st.zeroTo100) ? `${st.zeroTo100.toFixed(1)} s` : 'never'}`);
  if (st.topKmh > 0) out.push(`top ${Math.round(st.topKmh)} km/h`);
  return out;
}

/** A part's effects in plain words, best news first: "+17% power · +8% top speed · +10% fuel burn". */
export function describeStats(st: PartStats): string[] {
  const out: string[] = [];
  const add = (v: number | undefined, label: string) => {
    if (v) out.push(`${pct(v)} ${label}`);
  };
  add(st.force, 'power');
  add(st.top, 'top speed');
  add(st.armor, 'armour');
  add(st.armorF, 'front armour');
  add(st.armorS, 'side armour');
  add(st.armorR, 'rear armour');
  add(st.hp, 'hull');
  add(st.grip, 'grip');
  add(st.travel, 'suspension');
  add(st.offroad, 'off-road');
  add(st.dmg, 'gun damage');
  add(st.rate, 'fire rate');
  add(st.tank, 'fuel capacity');
  if (st.cargo) out.push(`+${st.cargo} cargo`);
  add(st.plow, 'zombie plough');
  add(st.ram, 'ram damage');
  add(st.light, 'headlight');
  add(st.steer, 'steering lock');
  if (st.spare) out.push('free tyre swaps');
  add(st.burn, 'fuel burn');
  add(st.sig, 'noise');
  return out;
}
