import { partDef, type FuelType, type PartSlot } from '../data';
import { BAY_TEXT, type BayLabel } from './engines';
import { fuelMismatch } from './fuel';
import { type VehicleBuild, defOf, statsOf } from './garage';
import { effectiveStats, type Fit, type PartItem } from './parts';
import { thermalForecast, VERDICT_TEXT, type ThermalForecast } from './thermal';

/**
 * What fitting (or pulling) a part would do, before any bolt turns. The garage shows it under each candidate so a
 * big engine in a small car is a choice made with the numbers in front of you rather than a surprise on the road.
 */
export interface Forecast {
  slot: PartSlot;
  powerKw: number;
  powerBefore: number;
  topKmh: number;
  topBefore: number;
  /** Kilometres on a full tank. */
  rangeKm: number;
  rangeBefore: number;
  massDelta: number;
  bay: BayLabel;
  fuel: FuelType;
  /** After the swap the tank would hold the wrong fuel for the engine. */
  wrongFuel: boolean;
  heat: ThermalForecast;
  heatBefore: ThermalForecast;
  /** Warnings and facts worth a line each, worst first. */
  notes: string[];
}

function figures(b: VehicleBuild, fit: Fit, radiator: number) {
  const def = defOf(b);
  const st = effectiveStats(def, fit);
  const topKmh = def.topSpeedKmh * st.topSpeedMult;
  return { st, topKmh, rangeKm: st.burnMult > 0 ? st.tank / (def.burn * st.burnMult) : 0, heat: thermalForecast(st.heat, st.coolKw, st.airflow, topKmh / 3.6, radiator) };
}

/** Fit `item` into its slot (or pull the slot's part when `item` is null) and compare with how the vehicle is now. */
export function forecastSwap(b: VehicleBuild, slot: PartSlot, item: PartItem | null): Forecast {
  const before = figures(b, b.fit, b.comp.radiator ?? 1);
  const fit: Fit = { ...b.fit };
  if (item) fit[slot] = item;
  else if (slot === 'engine') fit.engine = { uid: 'x', id: 'eng_none', cond: 1 };
  else if (slot === 'cooling') fit.cooling = { uid: 'x', id: 'rad_none', cond: 1 };
  else delete fit[slot];
  const radiator = slot === 'cooling' && item ? item.cond : b.comp.radiator ?? 1;
  const after = figures(b, fit, radiator);
  const wrongFuel = !!fuelMismatch(after.st.fuel, b.tank, b.fuel * after.st.tank);
  const notes: string[] = [];
  if (after.st.noEngine) notes.push('No engine: it will not run');
  if (wrongFuel) notes.push(`The tank holds ${b.tank}, the engine burns ${after.st.fuel}: drain it`);
  else if (after.st.fuel !== before.st.fuel) notes.push(`Burns ${after.st.fuel} instead of ${before.st.fuel}`);
  if (after.heat.verdict === 'overheats') notes.push(VERDICT_TEXT.overheats);
  else if (after.heat.verdict === 'hot' && before.heat.verdict !== 'hot') notes.push(VERDICT_TEXT.hot);
  if (slot === 'engine' && (after.st.bayLabel === 'cut' || after.st.bayLabel === 'tight')) notes.push(BAY_TEXT[after.st.bayLabel]);
  if (after.st.gripMult < before.st.gripMult - 0.08) notes.push('Heavier up front: it will handle worse');
  if (after.rangeKm < before.rangeKm * 0.7 && before.rangeKm > 0) notes.push('Much thirstier: the tank will not go as far');
  return {
    slot,
    powerKw: after.st.power,
    powerBefore: before.st.power,
    topKmh: after.topKmh,
    topBefore: before.topKmh,
    rangeKm: after.rangeKm,
    rangeBefore: before.rangeKm,
    massDelta: after.st.massDelta,
    bay: after.st.bayLabel,
    fuel: after.st.fuel,
    wrongFuel,
    heat: after.heat,
    heatBefore: before.heat,
    notes,
  };
}

/** The same, for the build as it stands: used for the vehicle card. */
export function currentFigures(b: VehicleBuild) {
  const f = figures(b, b.fit, b.comp.radiator ?? 1);
  return { powerKw: f.st.power, topKmh: f.topKmh, rangeKm: f.rangeKm, heat: f.heat, bay: f.st.bayLabel, fuel: f.st.fuel, stats: statsOf(b) };
}

/** True when a part is worth the forecast line: engines, radiators and anything that moves the numbers. */
export function forecastWorthy(item: PartItem): boolean {
  const d = partDef(item.id);
  return d.slot === 'engine' || d.slot === 'cooling' || d.slot === 'wheels';
}
