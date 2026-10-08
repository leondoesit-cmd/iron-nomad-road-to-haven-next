import { CHASSIS, FIT_SLOTS, PART_SLOTS, partDef, wheelLayout, type FuelType, type PartDef, type PartSlot, type VehicleDef } from '../data';
import { clamp } from '../core/math';
import { factoryIdFor, suspensionSpec } from './drivetrain';
import { coolantLitres, sumpLitres } from './fluids';
import type { Carried } from './carry';
import type { CargoEntry, Zone } from './cargo';
import type { Fit, PartItem, Tyres } from './parts';

/**
 * What a vehicle weighs, item by item, and where that weight sits. Every bolted-on part has a real weight (engines and
 * gearboxes carry their own in the catalogue; everything else is sized here by kind and by how big the chassis is), and so
 * does what is in it: fuel, oil and water, the people aboard, the spares stowed inside, and the load on the roof, in the
 * bed and on the racks. The result says how heavy the vehicle is and where its centre of mass sits, which is what the
 * physics needs to make a loaded pickup squat, roll more, pull slower and stop longer.
 *
 * A chassis' `physics.mass` is its curb weight as it leaves the factory: stock parts, full fluids, a full tank. The
 * vehicle's REFERENCE state is that plus a driver: what every chassis was tuned to drive like. The physics runs every
 * vehicle at the scale of its reference (`physicsScale`), so a stock car with someone at the wheel behaves exactly as the
 * table says, and anything heavier or lighter moves from there by the real ratio.
 */

/** Fuel units to litres: a full jerrycan is 5 FU and holds 20 litres. */
export const FU_LITRES = 4;
/** Kilograms per litre. */
export const FUEL_DENSITY: Record<FuelType, number> = { petrol: 0.74, diesel: 0.84 };
export const OIL_DENSITY = 0.88;
export const COOLANT_DENSITY = 1.03;
/** One person with what they wear and carry. */
export const OCCUPANT_KG = 80;
/** Loose oil: litres per sump unit of a can (a full can is half a sump and holds about four litres). */
const OIL_CAN_LITRES = 8;

export type MassGroup = 'chassis' | 'powertrain' | 'running' | 'body' | 'fittings' | 'fluids' | 'people' | 'cargo' | 'stowed';

export interface MassItem {
  label: string;
  kg: number;
  group: MassGroup;
  /** Where it sits, chassis frame (x left, y up, z forward), metres from the chassis centre. */
  at: [number, number, number];
}

export interface MassBreakdown {
  /** Kilograms, everything included. */
  total: number;
  /** Every contribution, heaviest groups first within the order the vehicle is put together. */
  items: MassItem[];
  /** Centre of mass, chassis frame, relative to where it sits in the reference state (stock, a driver, full tank). */
  com: { x: number; y: number; z: number };
  /** Kilograms in the reference state, and total over it. */
  ref: number;
  scale: number;
  /** Curb weight: the vehicle with its parts and fluids, nobody and nothing aboard. */
  curb: number;
  /** Load: people, stowed spares and outside cargo. */
  payload: number;
  /** Rotational inertia the payload adds about the centre of mass, about the chassis axes (x pitch, y yaw, z roll), kg m^2. */
  inertia: { x: number; y: number; z: number };
}

/** Who sits where. A gunner stands at the bed gun or rides the passenger seat. */
export type Seat = 'driver' | 'passenger' | 'gunner' | 'rear';

export interface MassLoad {
  /** Fuel in the tank, FU. Missing: what the build says (a full tank for a bare chassis). */
  fuel?: number;
  fuelType?: FuelType;
  /** Oil and coolant as fractions of a full system. Missing: what the build says (full for a bare chassis). */
  oil?: number;
  coolant?: number;
  /** Who is aboard. Missing: nobody. */
  occupants?: { seat: Seat; kg?: number }[];
  /** Spares stowed inside (the convoy inventory items carried on this vehicle). */
  stowed?: readonly PartItem[];
  /** Load on the outside. Missing: the build's own cargo. */
  cargo?: readonly CargoEntry[];
  /** Exact chassis-frame position of an outside load, when the caller knows the deck layout. */
  place?: (e: CargoEntry) => [number, number, number] | null;
}

/**
 * A vehicle to weigh: a build (its chassis, parts, fluids and load) or a bare chassis in its stock state. A build may carry
 * its chassis definition itself (`def`), for chassis that are not in the table (a raider's rig).
 */
export type MassSource = { chassis: string; def?: VehicleDef; fit: Fit; tyres?: Tyres; fuel?: number; tank?: FuelType; comp?: { oil?: number; coolant?: number }; cargo?: CargoEntry[] } | VehicleDef;

const isDef = (s: MassSource): s is VehicleDef => 'physics' in s;

// ------------------------------------------------------------------------------------------------ part weights

/** Aftermarket parts by id, kg. Factory parts are sized from the chassis below. */
const KG: Record<string, number> = {
  exh_free: 11, exh_quiet: 15, exh_race: 9, exh_stack: 24,
  sus_sport: 20, sus_heavy: 65, sus_long: 58, sus_air: 85, sus_lift: 42,
  brk_sport: 20, brk_big: 32, brk_race: 22, brk_air: 110,
  wpn_lmg: 32, wpn_twin: 60, wpn_hmg: 95,
  utl_rack: 10, utl_tank: 22, utl_aux: 35, utl_tie: 2, utl_net: 4,
  rf_basket: 16, rf_net: 6, rf_basket2: 24, rf_basket3: 34, rf_rack: 11, rf_light: 7, rf_cage: 55,
  rr_cage: 18, rr_cage2: 30, rr_spare: 10, rr_wing: 7, rr_box: 28, rr_rickshaw: 40,
  hood_std: 14, hood_cut: 10, hood_vent: 14, hood_scoop: 16, hood_armor: 50,
  door_std: 21, door_light: 8, door_plate: 42, door_armor: 65,
  seat_std: 16, seat_torn: 14, seat_bucket: 10, seat_leather: 20, seat_plate: 32,
  bench_std: 22, bench_torn: 20, bench_fold: 18, bench_rack: 12,
  steer_std: 2.5, steer_sport: 1.8, steer_chain: 3.5, dash_std: 10, dash_cracked: 10, dash_gauge: 11,
  gls_ws_std: 13, gls_ws_pane: 13, gls_ws_lam: 15, gls_ws_bullet: 55,
  gls_rw_std: 7, gls_rw_pane: 7, gls_rw_lam: 8,
  gls_side_std: 3.5, gls_side_pane: 3.5, gls_side_lam: 4, gls_side_bullet: 20,
};
/** Plates and bars cover the body, so they weigh by its size: armour by its area, bumpers by its width, skirts by its length. */
const BY_AREA: Record<string, number> = { arm_sheet: 55, arm_weld: 130, arm_ceramic: 95 };
const BY_WIDTH: Record<string, number> = { fr_bull: 30, fr_blade: 110, fr_spike: 55 };
const BY_LENGTH: Record<string, number> = { sd_skirt: 26, sd_plate: 110, sd_pipes: 16 };
/** Tyres against the chassis' own: knobblies and beadlocks are heavier, a bare rim is what is left of a wheel. */
const TYRE_K: Record<string, number> = { whl_road: 1, whl_mt: 1.2, whl_bl: 1.35, tyre_none: 0.4 };

/** The hatchback is the yardstick the per-size numbers are written for. */
const REF_AREA = 3.75 * 1.72;

/** One wheel with its tyre on a chassis, kg: by its size, and by how heavy a vehicle it is made to carry. */
export function wheelKg(def: VehicleDef, r = def.physics.wheelRadius): number {
  return (3 + 80 * r * r) * clamp(Math.pow(def.physics.mass / 1000, 0.3), 0.5, 2.2);
}

/** The chassis a factory tyre (`tyre_<id>`) was made for, if any. */
function tyreChassis(id: string): VehicleDef | null {
  if (!id.startsWith('tyre_')) return null;
  const rest = id.slice(5).replace(/_r$/, '');
  return CHASSIS[rest] ?? null;
}

/**
 * What one part weighs on (or off) a chassis, kg. `def` sizes the factory parts and the body-sized ones; a part lying in
 * a boot is weighed against the vehicle it is in. A placeholder for a stripped mount weighs nothing.
 */
export function partKg(d: PartDef, def: VehicleDef, wheelR?: number): number {
  if (d.empty && d.slot !== 'wheels') return 0;
  if (d.engine) return d.engine.mass;
  if (d.gearbox) return d.gearbox.mass;
  if (d.cooling !== undefined) return 2 + 0.065 * d.cooling;
  const m = def.physics.mass;
  const area = (def.length * def.width) / REF_AREA;
  if (d.slot === 'wheels') {
    const own = tyreChassis(d.id);
    if (own && d.stock) return wheelKg(own, d.wheel === 'small' ? Math.min(own.physics.wheelRadius, 0.26) : own.physics.wheelRadius);
    return wheelKg(def, wheelR) * (TYRE_K[d.id] ?? 1);
  }
  if (d.stock) {
    if (d.exhaust) return Math.min(70, 2 + 0.008 * m);
    if (d.suspension) return 0.022 * m;
    if (d.brakes) return 0.016 * m;
  }
  if (KG[d.id] !== undefined) {
    // Bonnets and doors are panels of the body they belong to.
    const panel = d.slot === 'hood' || d.slot === 'doorL' || d.slot === 'doorR';
    return KG[d.id] * (panel ? clamp(Math.pow(area, 0.6), 0.5, 2.5) : 1);
  }
  if (BY_AREA[d.id] !== undefined) return BY_AREA[d.id] * Math.pow(area, 0.8);
  if (BY_WIDTH[d.id] !== undefined) return BY_WIDTH[d.id] * (def.width / 1.72);
  if (BY_LENGTH[d.id] !== undefined) return BY_LENGTH[d.id] * (def.length / 3.75);
  return 10;
}

// ------------------------------------------------------------------------------------------------ where things sit

/** Roof height above the chassis centre, for the bodies that have one worth loading. */
const ROOF_Y: Record<string, number> = { hatch: 0.83, sedan: 0.78, pickup: 1.15, van: 1.55, buggy: 0.9, truck: 1.5, rig: 2.1 };

/** Engine placement: in the nose of anything with a bonnet, under the seat of a bike, quad or rickshaw, behind the crew of a raider's buggy. */
function engineBay(def: VehicleDef): 'nose' | 'mid' | 'rear' {
  if (def.id === 'raider_buggy') return 'rear';
  return def.id === 'moped' || def.id === 'quad' || def.id === 'trike' || def.physics.wheelCount <= 2 ? 'mid' : 'nose';
}

function seatZ(def: VehicleDef): number {
  return def.seat?.driver[2] ?? -0.1 * def.length;
}

/** Where a slot's part sits, chassis frame. */
export function slotAt(def: VehicleDef, slot: PartSlot): [number, number, number] {
  const L = def.length;
  const W = def.width;
  const hy = def.physics.halfExtents[1];
  const bay = engineBay(def);
  const roof = ROOF_Y[def.id] ?? hy + 0.45;
  const sz = seatZ(def);
  switch (slot) {
    case 'engine':
      return bay === 'nose' ? [0, -0.05, 0.32 * L] : bay === 'rear' ? [0, 0, -0.3 * L] : [0, -0.1, -0.1 * L];
    case 'cooling':
      return bay === 'nose' ? [0, 0, 0.45 * L] : [0.2 * W, 0, -0.05 * L];
    case 'gearbox':
      return bay === 'nose' ? [0, -0.15, 0.18 * L] : bay === 'rear' ? [0, -0.1, -0.18 * L] : [0, -0.15, -0.2 * L];
    case 'exhaust':
      return [0.2 * W, -hy, -0.15 * L];
    case 'suspension':
    case 'brakes':
      return [0, def.physics.hardY, 0];
    case 'armor':
      return [0, 0, 0];
    case 'weapon':
      return def.weaponMount === 'bed' && def.gunner ? [def.gunner[0], def.gunner[1] + 0.5, def.gunner[2]] : [0, hy + 0.2, 0.32 * L];
    case 'utility':
      return [0, -0.1, -0.35 * L];
    case 'front':
      return [0, -0.1, 0.5 * L];
    case 'roof':
      return [0, roof, -0.05 * L];
    case 'rear':
      return [0, 0.05, -0.5 * L];
    case 'side':
      return [0, -0.1, 0];
    case 'hood':
      return [0, hy, 0.36 * L];
    case 'doorL':
      return [0.47 * W, 0, sz];
    case 'doorR':
      return [-0.47 * W, 0, sz];
    case 'seatD':
      return def.seat ? [...def.seat.driver] : [0, 0.2, sz];
    case 'seatP':
      return def.seat ? [...def.seat.passenger] : [0, 0.2, sz];
    case 'seatR':
      return [0, 0, sz - 0.8];
    case 'steer':
    case 'dash':
      return [def.seat ? def.seat.driver[0] * 0.5 : 0, 0.45, sz + 0.45];
    case 'glassF':
      return [0, hy + 0.35, 0.18 * L];
    case 'glassB':
      return [0, hy + 0.35, -0.3 * L];
    case 'glassL':
      return [0.48 * W, hy + 0.3, sz];
    case 'glassR':
      return [-0.48 * W, hy + 0.3, sz];
    default:
      return [0, 0, 0];
  }
}

/** Where a person sits: the cab seats, a bike's saddle, the bed gun's post. The point is their own centre of mass. */
export function seatAt(def: VehicleDef, seat: Seat): [number, number, number] {
  const up = 0.32;
  if (seat === 'gunner' && def.gunner) return [def.gunner[0], def.gunner[1] + 0.7, def.gunner[2]];
  if (def.seat) {
    const s = seat === 'driver' ? def.seat.driver : seat === 'rear' ? [0, def.seat.driver[1], def.seat.driver[2] - 0.8] : def.seat.passenger;
    return [s[0], s[1] + up, s[2]];
  }
  // A saddle: the rider sits high and a little back of the middle; a pillion or a second rider behind them.
  const back = seat === 'driver' ? -0.08 : -0.3;
  return [0, def.physics.halfExtents[1] + 0.45, back * def.length];
}

/** Where loose spares ride inside. */
function insideAt(def: VehicleDef): [number, number, number] {
  const L = def.length;
  switch (def.id) {
    case 'moped':
    case 'quad':
      return [0, 0.15, -0.35 * L];
    case 'pickup':
      return [0, 0.1, seatZ(def) - 0.45];
    case 'van':
      return [0, 0, -0.22 * L];
    case 'buggy':
      return [0, 0, -0.12 * L];
    default:
      return [0, 0, -0.38 * L];
  }
}

/** Where an outside load sits by default on each deck. */
export function zoneAt(def: VehicleDef, zone: Zone): [number, number, number] {
  const L = def.length;
  const hy = def.physics.halfExtents[1];
  switch (zone) {
    case 'roof':
      return [0, (ROOF_Y[def.id] ?? hy + 0.45) + 0.18, -0.05 * L];
    case 'bed':
      return [0, hy * 0.2, -0.32 * L];
    case 'carrier':
      return [0, 0.15, -0.56 * L];
    case 'rack':
      return [0.45 * def.width, 0, -0.4 * L];
    case 'spare':
      return [0, 0.2, -0.52 * L];
  }
}

// ------------------------------------------------------------------------------------------------ loads

/** What something carried weighs, kg: a part, a can and what is in it, a spray can, a bit of food. */
export function carriedKg(c: Carried, def: VehicleDef): number {
  switch (c.kind) {
    case 'part':
      return partKg(partDef(c.item.id), def);
    case 'fuel':
      return 3.5 + c.amount * FU_LITRES * FUEL_DENSITY[c.fuel ?? 'petrol'];
    case 'oil':
      return 1 + c.amount * OIL_CAN_LITRES * OIL_DENSITY;
    case 'water':
      return 1.5 + c.amount * COOLANT_DENSITY;
    case 'paint':
      return 0.5;
    case 'food':
      return 1;
  }
}

// ------------------------------------------------------------------------------------------------ the sum

interface Acc {
  items: MassItem[];
  m: number;
  mx: number;
  my: number;
  mz: number;
}

function add(a: Acc, label: string, kg: number, group: MassGroup, at: readonly [number, number, number]) {
  if (kg <= 0) return;
  a.items.push({ label, kg, group, at: [at[0], at[1], at[2]] });
  a.m += kg;
  a.mx += kg * at[0];
  a.my += kg * at[1];
  a.mz += kg * at[2];
}

/** The tank's capacity in FU with the parts that enlarge it. */
function tankFU(def: VehicleDef, fit: Fit): number {
  let k = 0;
  for (const it of Object.values(fit)) if (it) k += partDef(it.id).stats.tank ?? 0;
  return def.tank * (1 + k);
}

/** The engine's litres, for the sump and the water jacket. */
function engineOf(def: VehicleDef, fit: Fit): PartDef | null {
  const id = fit.engine?.id ?? def.stockEngine;
  return id ? partDef(id) : null;
}

function radiatorKw(def: VehicleDef, fit: Fit): number {
  const id = fit.cooling?.id ?? def.stockRadiator;
  return id ? (partDef(id).cooling ?? 0) : 100;
}

/**
 * Everything bolted on and poured in: the parts in every slot the chassis has (fitted, else factory), the tyre on each
 * wheel, and the fuel, oil and water. `full` puts a full tank and full fluids in, as the reference does.
 */
function machine(a: Acc, def: VehicleDef, fit: Fit, tyres: Tyres | undefined, fluids: { fuel: number; fuelType: FuelType; oil: number; coolant: number }) {
  const slots = def.slots ?? PART_SLOTS;
  for (const slot of slots) {
    if (slot === 'wheels') continue;
    const id = fit[slot]?.id ?? (slot === 'engine' ? def.stockEngine : slot === 'cooling' ? def.stockRadiator : factoryIdFor(def, slot));
    if (!id) continue;
    const d = partDef(id);
    add(a, d.name, partKg(d, def), groupOf(slot), slotAt(def, slot));
  }
  const layout = wheelLayout(def.physics);
  let tyreKg = 0;
  let tz = 0;
  for (let i = 0; i < layout.length; i++) {
    const w = layout[i];
    const it = tyres?.[i];
    const kg = it ? partKg(partDef(it.id), def, w.r) : wheelKg(def, w.r);
    tyreKg += kg;
    tz += kg * w.z;
  }
  if (tyreKg > 0) add(a, `Wheels and tyres x${layout.length}`, tyreKg, 'running', [0, def.physics.hardY - def.physics.suspension.rest * 0.6, tz / tyreKg]);
  const eng = engineOf(def, fit);
  const litres = eng?.engine?.litres ?? 1;
  const bay = slotAt(def, 'engine');
  add(a, 'Fuel', fluids.fuel * FU_LITRES * FUEL_DENSITY[fluids.fuelType], 'fluids', [0, -def.physics.halfExtents[1] * 0.6, -0.3 * def.length]);
  if (eng && !eng.empty) {
    add(a, 'Engine oil', fluids.oil * sumpLitres(litres) * OIL_DENSITY, 'fluids', [bay[0], bay[1] - 0.15, bay[2]]);
    add(a, 'Coolant', fluids.coolant * coolantLitres(radiatorKw(def, fit), litres) * COOLANT_DENSITY, 'fluids', slotAt(def, 'cooling'));
  }
}

function groupOf(slot: PartSlot): MassGroup {
  switch (slot) {
    case 'engine':
    case 'cooling':
    case 'gearbox':
    case 'exhaust':
      return 'powertrain';
    case 'suspension':
    case 'brakes':
      return 'running';
    case 'hood':
    case 'doorL':
    case 'doorR':
    case 'seatD':
    case 'seatP':
    case 'seatR':
    case 'steer':
    case 'dash':
    case 'glassF':
    case 'glassB':
    case 'glassL':
    case 'glassR':
      return 'body';
    default:
      return 'fittings';
  }
}

const refCache = new Map<string, { kg: number; mx: number; my: number; mz: number; parts: number }>();

/**
 * The reference state of a chassis: stock, a full tank, full fluids, and a driver. Its weight is the curb weight plus the
 * driver, and its centre of mass is where the chassis' own is; the frame and body take whatever weight the stock parts leave.
 */
function reference(def: VehicleDef) {
  const key = `${def.id}:${def.physics.mass}:${def.stockEngine ?? ''}`;
  const hit = refCache.get(key);
  if (hit) return hit;
  const a: Acc = { items: [], m: 0, mx: 0, my: 0, mz: 0 };
  machine(a, def, {}, undefined, { fuel: def.tank, fuelType: engineOf(def, {})?.engine?.fuel ?? 'petrol', oil: 1, coolant: 1 });
  const parts = a.m;
  add(a, 'Driver', OCCUPANT_KG, 'people', seatAt(def, 'driver'));
  const r = { kg: def.physics.mass + OCCUPANT_KG, mx: a.mx, my: a.my, mz: a.mz, parts };
  refCache.set(key, r);
  return r;
}

/** Kilograms of the reference state: the curb weight with a driver. */
export const referenceKg = (def: VehicleDef): number => def.physics.mass + OCCUPANT_KG;

/**
 * What a vehicle weighs, item by item, and where its centre of mass is. A build is weighed as it stands (its parts, the fuel
 * and fluids it has, the cargo it carries), plus whoever and whatever `load` adds; a bare chassis as it left the factory.
 */
export function massBreakdown(src: MassSource, load: MassLoad = {}): MassBreakdown {
  const def = isDef(src) ? src : (src.def ?? CHASSIS[src.chassis]);
  if (!def) throw new Error(`massBreakdown: unknown chassis ${(src as { chassis: string }).chassis}`);
  const fit: Fit = isDef(src) ? {} : src.fit;
  const tyres = isDef(src) ? undefined : src.tyres;
  const ref = reference(def);
  const a: Acc = { items: [], m: 0, mx: 0, my: 0, mz: 0 };
  // The frame and body: what the curb weight leaves once the stock parts and fluids are counted. Placed at the centre:
  // the moments below are taken against the reference, so where the frame "is" never matters.
  const frame = Math.max(def.physics.mass * 0.25, def.physics.mass - ref.parts);
  add(a, 'Frame and body', frame, 'chassis', [0, 0, 0]);
  const tank = tankFU(def, fit);
  const engFuel = engineOf(def, fit)?.engine?.fuel ?? 'petrol';
  const fuel = load.fuel ?? (isDef(src) ? def.tank : (src.fuel ?? 1) * tank);
  const fuelType = load.fuelType ?? (isDef(src) ? engFuel : (src.tank ?? engFuel));
  const comp = isDef(src) ? undefined : src.comp;
  machine(a, def, fit, tyres, { fuel: clamp(fuel, 0, tank * 1.001), fuelType, oil: clamp(load.oil ?? comp?.oil ?? 1, 0, 1), coolant: clamp(load.coolant ?? comp?.coolant ?? 1, 0, 1) });
  const curb = a.m;
  for (const o of load.occupants ?? []) add(a, o.seat === 'driver' ? 'Driver' : o.seat === 'gunner' ? 'Gunner' : 'Passenger', o.kg ?? OCCUPANT_KG, 'people', seatAt(def, o.seat));
  if (load.stowed?.length) {
    let kg = 0;
    for (const it of load.stowed) kg += partKg(partDef(it.id), def);
    add(a, `Spares inside x${load.stowed.length}`, kg, 'stowed', insideAt(def));
  }
  const cargo = load.cargo ?? (isDef(src) ? [] : (src.cargo ?? []));
  for (const e of cargo) {
    const at = (e.at ? [e.at[0], e.at[1] + 0.1, e.at[2]] : null) ?? load.place?.(e) ?? zoneAt(def, e.zone);
    add(a, cargoLabel(e.c), carriedKg(e.c, def), 'cargo', at as [number, number, number]);
  }
  // The frame stands at the centre in both states, so it drops out of the moment against the reference: what is left is
  // every other item's moment now, less the reference's.
  const total = a.m;
  const com = { x: (a.mx - ref.mx) / total, y: (a.my - ref.my) / total, z: (a.mz - ref.mz) / total };
  // What the payload adds to the body's resistance to rolling, pitching and turning: a load on the roof is a long lever.
  // The driver is part of the reference the body was tuned with, so only what rides beyond them counts.
  const inertia = { x: 0, y: 0, z: 0 };
  let driver = false;
  for (const it of a.items) {
    if (it.group !== 'people' && it.group !== 'cargo' && it.group !== 'stowed') continue;
    if (it.label === 'Driver' && !driver) {
      driver = true;
      continue;
    }
    const dx = it.at[0] - com.x;
    const dy = it.at[1] - com.y;
    const dz = it.at[2] - com.z;
    inertia.x += it.kg * (dy * dy + dz * dz);
    inertia.y += it.kg * (dx * dx + dz * dz);
    inertia.z += it.kg * (dx * dx + dy * dy);
  }
  return { total, items: a.items, com, ref: ref.kg, scale: total / ref.kg, curb, payload: total - curb, inertia };
}

function cargoLabel(c: Carried): string {
  switch (c.kind) {
    case 'part':
      return partDef(c.item.id).name;
    case 'fuel':
      return c.fuel === 'diesel' ? 'Diesel can' : 'Petrol can';
    case 'oil':
      return 'Oil can';
    case 'water':
      return 'Water can';
    case 'paint':
      return 'Spray can';
    case 'food':
      return 'Food';
  }
}

/**
 * Spring rate against the factory springs: heavy-duty springs (rated for more weight) are stiffer, sport springs for a
 * lighter car softer. A stripped suspension leaves the body on its bump stops.
 */
export function springRate(def: VehicleDef, fit: Fit): number {
  const now = suspensionSpec(def, fit).load;
  const id = factoryIdFor(def, 'suspension');
  const stock = id ? (partDef(id).suspension?.load ?? now) : now;
  if (now <= 0) return 0.5;
  return clamp(Math.sqrt(now / Math.max(1, stock)), 0.8, 1.6);
}

/**
 * What the physics body needs from a weighing: the mass against the reference, where the centre of mass sits, the spring
 * rate, and the payload's inertia at the physics' own scale (the table's mass stands for the reference weight).
 */
export function bodyLoadOf(def: VehicleDef, fit: Fit, mb: MassBreakdown) {
  const k = def.physics.mass / mb.ref;
  return { scale: mb.scale, com: mb.com, spring: springRate(def, fit), inertia: { x: mb.inertia.x * k, y: mb.inertia.y * k, z: mb.inertia.z * k } };
}

const curbCache = new Map<string, number>();

/** Curb weight of a fit, kg: the chassis with these parts and full fluids, nobody aboard. Stock is the table's own mass. Cached. */
export function curbKg(def: VehicleDef, fit: Fit, tyres?: Tyres): number {
  let key = `${def.id}:${def.physics.mass}`;
  for (const slot of FIT_SLOTS) key += `,${fit[slot]?.id ?? ''}`;
  if (tyres) for (const t of tyres) key += `;${t?.id ?? ''}`;
  const hit = curbCache.get(key);
  if (hit !== undefined) return hit;
  if (curbCache.size > 500) curbCache.clear();
  const kg = massBreakdown({ chassis: def.id, def, fit, tyres, fuel: 1 }, {}).curb;
  curbCache.set(key, kg);
  return kg;
}
