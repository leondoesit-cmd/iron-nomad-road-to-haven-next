import { partDef, type EngineSpec, type FuelType, type PartDef, type VehicleDef } from '../data';
import { clamp } from '../core/math';
import type { Fit } from './parts';

/**
 * Engines are real: litres, kilowatts, kilograms, a size class and a fuel. Any engine goes in any chassis ("a V8 in a
 * hatchback", "a petrol motor in a diesel van"); what changes is how the result drives, how hot it runs and what it burns.
 * Everything here is pure, so the garage can forecast a swap before a single bolt is turned.
 *
 * A chassis is balanced around its factory engine. Fitting another one scales the chassis' own numbers by how the two
 * compare, so a stock car is exactly what `vehicles.json` says and nothing else moves.
 */

/** Used for chassis with no factory engine data (boats, raider rigs): they behave as if nothing was swapped. */
const NEUTRAL: EngineSpec = { litres: 1, kw: 100, mass: 100, size: 3, fuel: 'petrol' };

/** Waste heat at full load, as a share of the engine's output. */
export const HEAT_PER_KW = 0.9;

/** The part in the engine bay: whatever has been fitted, otherwise the one the chassis left the factory with. */
export function engineDef(def: VehicleDef, fit: Fit): PartDef | null {
  if (fit.engine) return partDef(fit.engine.id);
  return def.stockEngine ? partDef(def.stockEngine) : null;
}

/** The part behind the grille, likewise. */
export function radiatorDef(def: VehicleDef, fit: Fit): PartDef | null {
  if (fit.cooling) return partDef(fit.cooling.id);
  return def.stockRadiator ? partDef(def.stockRadiator) : null;
}

export function stockEngineDef(def: VehicleDef): PartDef | null {
  return def.stockEngine ? partDef(def.stockEngine) : null;
}

export function engineSpec(def: VehicleDef, fit: Fit): EngineSpec {
  return engineDef(def, fit)?.engine ?? NEUTRAL;
}

export function stockEngineSpec(def: VehicleDef): EngineSpec {
  return stockEngineDef(def)?.engine ?? NEUTRAL;
}

/** True when the bay has been stripped. */
export function bayEmpty(def: VehicleDef, fit: Fit): boolean {
  return !!engineDef(def, fit)?.empty;
}

/** Heat the radiator can shed at full airflow and full condition, in kW. */
export function coolingKw(def: VehicleDef, fit: Fit): number {
  const r = radiatorDef(def, fit);
  // Chassis with no radiator data never overheat: size the core to the engine so the maths stays quiet.
  return r ? (r.cooling ?? 0) : engineSpec(def, fit).kw * HEAT_PER_KW * 2;
}

/** What the engine in this chassis burns. */
export function fuelOf(def: VehicleDef, fit: Fit): FuelType {
  return engineSpec(def, fit).fuel;
}

// ---------------------------------------------------------------- the bay

export type BayLabel = 'loose' | 'fits' | 'snug' | 'tight' | 'cut';

export interface BayFit {
  /** Engine size class minus bay size class. Negative: room to spare. */
  oversize: number;
  label: BayLabel;
  /** Share of the radiator's airflow that survives the engine crowding it. */
  airflow: number;
}

export const BAY_TEXT: Record<BayLabel, string> = {
  loose: 'Rattles around in the bay',
  fits: 'Fits the bay',
  snug: 'A snug fit',
  tight: 'Tight: hoses and airflow suffer',
  cut: 'Forced in: the bonnet is cut to fit',
};

/** The same in a few words, for crowded cards. */
export const BAY_SHORT: Record<BayLabel, string> = { loose: 'loose fit', fits: 'fits', snug: 'snug fit', tight: 'tight fit', cut: 'bonnet cut' };

export function bayFit(def: VehicleDef, spec: EngineSpec): BayFit {
  const bay = def.bay ?? spec.size;
  const oversize = spec.size - bay;
  const label: BayLabel = oversize <= -2 ? 'loose' : oversize <= 0 ? 'fits' : oversize === 1 ? 'snug' : oversize === 2 ? 'tight' : 'cut';
  const airflow = label === 'snug' ? 0.92 : label === 'tight' ? 0.8 : label === 'cut' ? 0.66 : 1;
  return { oversize, label, airflow };
}

// ---------------------------------------------------------------- what an engine does to a chassis

const burnRate = (e: EngineSpec) => Math.pow(Math.max(e.kw, 0.01), 0.6) * (e.fuel === 'diesel' ? 0.78 : 1);
const noiseRate = (e: EngineSpec) => Math.pow(Math.max(e.kw, 0.01), 0.22) * (e.fuel === 'diesel' ? 1.04 : 1) * (e.blown ? 1.04 : 1);

export interface EngineEffects {
  spec: EngineSpec;
  stock: EngineSpec;
  empty: boolean;
  /** Output compared with the factory engine. */
  powerRatio: number;
  /** Kilograms heavier (or lighter) than the factory engine. */
  massDelta: number;
  bay: BayFit;
  /** Multipliers on the chassis' own numbers. */
  force: number;
  top: number;
  grip: number;
  travel: number;
  burn: number;
  sig: number;
  /** Waste heat at full load, kW. */
  heat: number;
  fuel: FuelType;
}

/**
 * Turn an engine into multipliers for a chassis. Output counts with diminishing returns (a tyre can only put so much
 * down), weight sags the suspension and pushes the nose wide, a crowded bay starves the radiator.
 */
export function engineEffects(def: VehicleDef, fit: Fit): EngineEffects {
  const spec = engineSpec(def, fit);
  const stock = stockEngineSpec(def);
  const empty = bayEmpty(def, fit);
  const ratio = empty ? 0 : spec.kw / Math.max(1, stock.kw);
  const massDelta = spec.mass - stock.mass;
  const bay = bayFit(def, spec);
  const f = clamp(massDelta / Math.max(60, def.physics.mass), -0.25, 1);
  const heavy = Math.max(0, f);
  let force: number;
  let top: number;
  if (empty) {
    force = 0;
    top = 0.5;
  } else {
    force = clamp(Math.pow(ratio, 0.75), 0.22, 2.5);
    top = ratio >= 1 ? clamp(1 + 0.32 * Math.log(ratio), 1, 1.45) : clamp(0.3 + 0.7 * Math.sqrt(ratio), 0.3, 1);
  }
  const grip = clamp((1 - 0.28 * heavy) * (1 - 0.04 * Math.max(0, bay.oversize)) * (1 - 0.06 * clamp(Math.log(Math.max(1, ratio)), 0, 1.5)), 0.55, 1.05);
  const travel = clamp(1 - 0.4 * heavy + 0.1 * Math.max(0, -f), 0.55, 1.08);
  return {
    spec,
    stock,
    empty,
    powerRatio: ratio,
    massDelta,
    bay,
    force,
    top,
    grip,
    travel,
    burn: empty ? 0 : clamp(burnRate(spec) / burnRate(stock), 0.4, 3),
    sig: empty ? 0.5 : clamp(noiseRate(spec) / noiseRate(stock), 0.7, 1.7),
    heat: empty ? 0 : spec.kw * HEAT_PER_KW,
    fuel: spec.fuel,
  };
}

// ---------------------------------------------------------------- words

export const FUEL_NAME: Record<FuelType, string> = { petrol: 'Petrol', diesel: 'Diesel' };

/** "3.5 L V6 · 150 kW · petrol": a one-line spec for tooltips and lists. */
export function engineLine(e: EngineSpec): string {
  if (e.kw <= 0) return 'no engine';
  const size = e.litres < 0.7 ? `${Math.round(e.litres * 1000)}cc` : `${e.litres.toFixed(1)} L`;
  return `${size}${e.layout && e.layout !== 'none' && e.litres >= 0.7 ? ` ${e.layout}` : ''}${e.blown ? ' blown' : ''} · ${Math.round(e.kw)} kW · ${e.fuel}`;
}
