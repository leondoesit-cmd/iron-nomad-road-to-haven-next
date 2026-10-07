import { partDef, t, type PartHold, type VehicleDef } from '../data';
import type { Carried } from './carry';
import { FOODS } from './food';
import type { Spot } from './access';
import { slotsOf, type Fit, type PartItem } from './parts';

/**
 * Cargo that is really on a car. Three places hold things, and they differ in what they do when you drive:
 *
 *  - INSIDE (the boot, the van's load area, the back seat, behind the seats of a pickup or buggy, a bike's panniers): the
 *    convoy's stowed spares. Safe at any speed. A vehicle has only so much room inside (`insideUnits`), and the biggest single
 *    thing it takes is limited (`insideMax`): an engine will not go in a moped's panniers.
 *  - A HOLDER (roof basket, roof rack with a net, rear cage, bed tie-downs or net, the jerrycan rack, the spare-wheel
 *    carrier): things in it are SECURE and stay at any speed, up to the holder's capacity and size limit.
 *  - A bare OPEN SURFACE (the roof, a pickup or buggy bed): things stay while the car is parked and are LOOSE once it moves:
 *    they slide and fall off. A bed has low walls, so a load in it only comes out on hard braking, hard cornering, bumps,
 *    a roll, or out of the tailgate if there is none.
 *
 * Sizes are footprint classes: 1 small (a can, a steering wheel), 2 medium (most parts), 4 large (an engine, a tyre set,
 * a door). Everything here is pure rules; the scene side is `game/cargo.ts`, the drawing `render/cargoLoad.ts`.
 */

export type Size = 1 | 2 | 4;
export const SIZE_NAME: Record<Size, string> = { 1: 'small', 2: 'medium', 4: 'large' };

export type Zone = PartHold['zone'];
export const ZONE_NAME: Record<Zone, string> = { roof: 'roof', bed: 'bed', carrier: 'rear cage', rack: 'jerrycan rack', spare: 'spare wheel carrier' };

const LARGE_SLOTS = new Set(['wheels', 'hood', 'doorL', 'doorR', 'weapon', 'roof', 'front']);

/** The footprint class of a part. */
export function sizeOfPart(id: string): Size {
  const d = partDef(id);
  if (d.engine) return d.engine.size >= 2 ? 4 : 2;
  if (LARGE_SLOTS.has(d.slot)) return 4;
  if (d.slot === 'steer') return 1;
  return 2;
}

/** The footprint class of anything carried by hand: cans are small. */
export function sizeOf(c: Carried): Size {
  return c.kind === 'part' ? sizeOfPart(c.item.id) : 1;
}

/** Name of the carried thing for a toast ("Tuned V6", "Petrol can"). */
export function cargoName(c: Carried): string {
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
      return FOODS[c.food].name;
  }
}

// ------------------------------------------------------------------------------------------------ inside

/** Parts that are holders: their `cargo` stat is not room inside. */
function holderCargo(fit: Fit): number {
  let n = 0;
  for (const it of Object.values(fit)) {
    if (!it) continue;
    const d = partDef(it.id);
    if (d.hold) n += d.stats.cargo ?? 0;
  }
  return n;
}

/** Room inside, in footprint units: two per slot of the vehicle's cargo space (so one medium part per slot), holders excluded. */
export function insideUnits(def: VehicleDef, cargoStat: number, fit: Fit): number {
  return 2 * Math.max(0, Math.floor(cargoStat - holderCargo(fit)));
}

/** The biggest single item that goes inside: bikes and the buggy only take medium things. */
export function insideMax(def: VehicleDef): Size {
  return def.id === 'moped' || def.id === 'quad' || def.id === 'buggy' ? 2 : 4;
}

/** What the inside is called in a prompt. */
export function insideName(def: VehicleDef): string {
  switch (def.id) {
    case 'moped':
    case 'quad':
      return 'panniers';
    case 'pickup':
      return 'cab';
    case 'buggy':
      return 'seat well';
    case 'van':
      return 'load area';
    default:
      return 'boot';
  }
}

export interface InsideRoom {
  /** Free units. */
  free: number;
  max: Size;
  name: string;
}

/** Units of the vehicle's inside already taken by stowed parts. */
export const unitsUsed = (items: { id: string }[]): number => items.reduce((a, it) => a + sizeOfPart(it.id), 0);

/** Can this go inside? Null when it can, otherwise the reason. */
export function insideRefusal(c: Carried, room: InsideRoom, def: VehicleDef): string | null {
  const size = sizeOf(c);
  if (size > room.max) return t('cargo.tooBigInside', { name: cargoName(c), size: SIZE_NAME[size], where: `${def.name} ${room.name}` });
  if (c.kind === 'part' && size > room.free) return t('cargo.insideFull', { where: `${def.name} ${room.name}`, free: room.free, size: SIZE_NAME[size] });
  return null;
}

// ------------------------------------------------------------------------------------------------ surfaces and holders

export interface Holder {
  id: string;
  name: string;
  zone: Zone;
  units: number;
  max: Size;
  only?: 'cans' | 'tyres';
}

/** Every holder fitted to a vehicle. */
export function holdersOf(fit: Fit): Holder[] {
  const out: Holder[] = [];
  for (const it of Object.values(fit) as (PartItem | undefined)[]) {
    if (!it) continue;
    const d = partDef(it.id);
    if (d.hold) out.push({ id: it.id, name: d.name, ...d.hold });
  }
  return out;
}

export interface Surface {
  zone: Zone;
  /** Where the player stands to put things there. */
  spot: Spot;
  /** Footprint units that physically fit (the larger of the bare surface and its holder). */
  units: number;
  /** The holder that makes it secure, if one is fitted. */
  holder: Holder | null;
  /** Low walls: a load in it is only thrown out by hard events. */
  walled: boolean;
  /** Name for a prompt: "roof", "roof basket", "bed". */
  name: string;
}

const BED: Record<string, { units: number; max: Size }> = { pickup: { units: 14, max: 4 }, buggy: { units: 8, max: 2 } };
/** Bare roofs hold a few things lying on them (a holder inside that is smaller leaves the rest loose). */
const ROOF_UNITS = 10;

/** Is there a bed (low-walled open load area) on this chassis? */
export const hasBed = (def: VehicleDef): boolean => def.id in BED;

/** The places something can be put outside on this vehicle with what is fitted. */
export function surfacesOf(def: VehicleDef, fit: Fit): Surface[] {
  const slots = slotsOf(def);
  const hs = holdersOf(fit);
  const pick = (zone: Zone) => hs.filter((h) => h.zone === zone).sort((a, b) => b.units - a.units)[0] ?? null;
  const out: Surface[] = [];
  if (slots.includes('roof')) {
    const h = pick('roof');
    out.push({ zone: 'roof', spot: 'roof', units: Math.max(ROOF_UNITS, h?.units ?? 0), holder: h, walled: false, name: h ? h.name.toLowerCase() : 'roof' });
  }
  const bed = BED[def.id];
  if (bed) {
    const h = pick('bed');
    out.push({ zone: 'bed', spot: 'trunk', units: Math.max(bed.units, h?.units ?? 0), holder: h, walled: true, name: h ? `bed (${h.name.toLowerCase()})` : 'bed' });
  } else {
    // A body that brings its own floor and walls (a rickshaw's cab): what is set down in it rides inside, held.
    const h = pick('bed');
    if (h) out.push({ zone: 'bed', spot: 'trunk', units: h.units, holder: h, walled: true, name: h.name.toLowerCase() });
  }
  const rack = pick('rack');
  if (rack) out.push({ zone: 'rack', spot: 'flank', units: rack.units, holder: rack, walled: false, name: rack.name.toLowerCase() });
  const spare = pick('spare');
  if (spare) out.push({ zone: 'spare', spot: 'rear', units: spare.units, holder: spare, walled: false, name: spare.name.toLowerCase() });
  const cage = pick('carrier');
  if (cage) out.push({ zone: 'carrier', spot: 'rear', units: cage.units, holder: cage, walled: false, name: cage.name.toLowerCase() });
  return out;
}

/** The spots a vehicle has somewhere to put an item on the outside. */
export const loadSpots = (def: VehicleDef, fit: Fit): Spot[] => [...new Set(surfacesOf(def, fit).map((s) => s.spot))];

export const isCan = (c: Carried) => c.kind === 'fuel' || c.kind === 'oil' || c.kind === 'water';
export const isTyres = (c: Carried) => c.kind === 'part' && partDef(c.item.id).slot === 'wheels';

/** Does the holder accept this item at all (the jerrycan rack takes cans, the spare carrier a tyre)? */
function accepts(h: Holder, c: Carried): boolean {
  if (h.only === 'cans') return isCan(c);
  if (h.only === 'tyres') return isTyres(c);
  return true;
}

/** One thing on the outside of a vehicle. Saved in the build (`VehicleBuild.cargo`). */
export interface CargoEntry {
  id: string;
  zone: Zone;
  c: Carried;
  /** Where it was set down by hand, in the chassis frame, and which way it was turned. Missing: dealt into the deck's grid. */
  at?: [number, number, number];
  yaw?: number;
  /** Seeded 0.5..2.2: how long a loose load rides before it works free. */
  thr: number;
}

/** Which entries are held by a holder right now, in the order they were put there. */
export function securedSet(def: VehicleDef, fit: Fit, cargo: readonly CargoEntry[]): Set<string> {
  const out = new Set<string>();
  const surf = surfacesOf(def, fit);
  for (const s of surf) {
    if (!s.holder) continue;
    let used = 0;
    for (const e of cargo) {
      if (e.zone !== s.zone) continue;
      const size = sizeOf(e.c);
      if (!accepts(s.holder, e.c) || size > s.holder.max || used + size > s.holder.units) continue;
      used += size;
      out.add(e.id);
    }
  }
  return out;
}

export interface LoadPlan {
  ok: boolean;
  secure: boolean;
  zone?: Zone;
  label: string;
}

/** Units of a zone already used. */
const zoneUsed = (cargo: readonly CargoEntry[], zone: Zone) => cargo.filter((e) => e.zone === zone).reduce((a, e) => a + sizeOf(e.c), 0);

/**
 * What happens when `c` is set down at `spot` on the outside of a vehicle: where it goes, whether it will be secure, and a
 * line that says so ("Secured in the roof basket" / "Loose: it will fall off when you drive").
 */
export function planLoad(def: VehicleDef, fit: Fit, cargo: readonly CargoEntry[], spot: Spot, c: Carried): LoadPlan {
  if (c.kind === 'paint') return { ok: false, secure: false, label: t('cargo.noPaint') };
  const size = sizeOf(c);
  const here = surfacesOf(def, fit).filter((s) => s.spot === spot);
  if (!here.length) return { ok: false, secure: false, label: t('cargo.nowhere') };
  // Prefer a place that will hold it: a holder with room, then the open surface.
  let best: { s: Surface; secure: boolean } | null = null;
  const reasons: string[] = [];
  for (const s of here) {
    if (s.holder && !accepts(s.holder, c)) {
      reasons.push(s.holder.only === 'cans' ? t('cargo.cansOnly', { name: s.name }) : t('cargo.tyresOnly', { name: s.name }));
      continue;
    }
    if (zoneUsed(cargo, s.zone) + size > s.units) {
      reasons.push(t('cargo.noRoomOn', { name: s.name }));
      continue;
    }
    const probe: CargoEntry = { id: '_probe', zone: s.zone, c, thr: 1 };
    const secure = !!s.holder && securedSet(def, fit, [...cargo, probe]).has('_probe');
    if (!best || (secure && !best.secure)) best = { s, secure };
    if (secure) break;
  }
  if (!best) return { ok: false, secure: false, label: reasons[0] ?? t('cargo.nowhere') };
  const { s, secure } = best;
  if (secure) return { ok: true, secure: true, zone: s.zone, label: t('cargo.secured', { name: s.name }) };
  if (s.holder) {
    const why = size > s.holder.max ? t('cargo.tooBigHolder', { size: SIZE_NAME[size], name: s.name }) : t('cargo.holderFull', { name: s.name });
    return { ok: true, secure: false, zone: s.zone, label: `${t('cargo.loose')}  ·  ${why}` };
  }
  if (s.walled) return { ok: true, secure: false, zone: s.zone, label: t('cargo.walled', { name: s.name }) };
  return { ok: true, secure: false, zone: s.zone, label: t('cargo.loose') };
}

// ------------------------------------------------------------------------------------------------ falling off

/** What the load feels, per tick. `long` is forward acceleration (negative braking), `lat` sideways, both in m/s^2. */
export interface Motion {
  speed: number;
  long: number;
  lat: number;
  /** Upward acceleration on top of gravity, m/s^2: a bump or a landing. */
  vert: number;
  airborne: boolean;
  /** The body's up vector's y: below 0.4 it is on its side. */
  upY: number;
}

/** Under this a car is parked as far as the load is concerned. */
export const FALL_SPEED = 3.2;

/** Exposure (seconds-equivalent) a loose load takes this tick. Compare with the entry's `thr`. */
export function looseStress(m: Motion, dt: number): number {
  if (m.upY < 0.4) return 3 * dt;
  const sp = Math.abs(m.speed);
  if (sp <= FALL_SPEED) return 0;
  let rate = 0.2 + Math.min(1, (sp - FALL_SPEED) / 6) * 0.6;
  const brake = Math.max(0, -m.long * Math.sign(m.speed || 1) - 2.5);
  rate += brake * 0.25;
  rate += Math.max(0, Math.abs(m.lat) - 3) * 0.25;
  if (m.airborne) rate += 0.6;
  let bump = 0;
  if (m.vert > 8) bump = Math.min(1.2, (m.vert - 8) * 0.12);
  return rate * dt + bump;
}

/** The same for a load in a walled bed: only hard events count, and it takes about three times as much. */
export function walledStress(m: Motion, dt: number, tailgateOpen: boolean): number {
  if (m.upY < 0.4) return 3 * dt;
  const sp = Math.abs(m.speed);
  if (sp <= FALL_SPEED) return 0;
  if (tailgateOpen) return looseStress(m, dt) * 0.8;
  let s = 0;
  const brake = -m.long * Math.sign(m.speed || 1);
  if (brake > 6) s += (brake - 6) * 0.35;
  if (Math.abs(m.lat) > 5.5) s += (Math.abs(m.lat) - 5.5) * 0.35;
  if (m.airborne && sp > 6) s += 0.5;
  let bump = 0;
  if (m.vert > 11) bump = Math.min(1, (m.vert - 11) * 0.1);
  return s * dt + bump;
}

/** A load's seeded tolerance: how much exposure it takes to work free. Walled loads multiply it. */
export function fallThreshold(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  const r = x - Math.floor(x);
  return 0.5 + r * 1.7;
}
export const WALLED_FACTOR = 3;

/** How a thing is hurt by the fall: fragile working parts lose some condition. Returns the new condition. */
export function fallWear(c: Carried, roll: number): number | null {
  if (c.kind !== 'part') return null;
  const d = partDef(c.item.id);
  const fragile = ['engine', 'cooling', 'gearbox', 'suspension', 'brakes'].includes(d.slot);
  return fragile ? Math.max(0.05, c.item.cond - 0.04 - roll * 0.1) : null;
}

/** The toast for a thing that fell off. */
export function fallLine(c: Carried, zone: Zone, surfaceName: string): string {
  return t('cargo.fell', { name: cargoName(c), where: zone === 'bed' ? 'the back of the bed' : `the ${surfaceName}` });
}
