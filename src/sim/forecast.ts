import { isInteriorSlot, partDef, type FuelType, type PartSlot } from '../data';
import { bayText, hoodState, type BayLabel } from './engines';
import { fuelMismatch } from './fuel';
import { type VehicleBuild, EMPTY_ID, defOf, statsOf } from './garage';
import { effectiveStats, type Fit, type PartItem, type Tyres } from './parts';
import { thermalForecast, VERDICT_TEXT, type ThermalForecast } from './thermal';

/**
 * What fitting (or pulling) a part would do, before any bolt turns. The garage shows it under each candidate so a
 * big engine in a small car is a choice made with the numbers in front of you rather than a surprise on the road.
 * It judges the whole machine: the gearbox that must carry the engine, the springs under it and the brakes behind it.
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
  /** Engine output over what the gearbox carries (above 1 it wears), before and after. */
  strain: number;
  strainBefore: number;
  /** Weight over what the springs carry (above 1 it sags), before and after. */
  overload: number;
  overloadBefore: number;
  /** Braking against the stock chassis, before and after. */
  brake: number;
  brakeBefore: number;
  /** Armour and grip, before and after. */
  armor: number;
  armorBefore: number;
  grip: number;
  gripBefore: number;
  /** Steering lock against the stock wheel, before and after (1 is stock). */
  steer: number;
  steerBefore: number;
  /** Litres of oil and of water the engine and its cooling system hold, before and after. */
  sumpL: number;
  sumpBefore: number;
  coolantL: number;
  coolantBefore: number;
  /** Warnings and facts worth a line each, worst first. */
  notes: string[];
}

function figures(b: VehicleBuild, fit: Fit, radiator: number, tyres: Tyres = b.tyres) {
  const def = defOf(b);
  const st = effectiveStats(def, fit, tyres);
  const topKmh = def.topSpeedKmh * st.topSpeedMult;
  return { st, topKmh, rangeKm: st.burnMult > 0 ? st.tank / (def.burn * st.burnMult) : 0, heat: thermalForecast(st.heat, st.coolKw, st.airflow, topKmh / 3.6, radiator) };
}

/**
 * Fit `item` into its slot (or pull the slot's part when `item` is null) and compare with how the vehicle is now.
 * A tyre goes on one wheel (`wheel`), or on all of them when none is named.
 */
export function forecastSwap(b: VehicleBuild, slot: PartSlot, item: PartItem | null, wheel?: number): Forecast {
  const before = figures(b, b.fit, b.comp.radiator ?? 1);
  const fit: Fit = { ...b.fit };
  let tyres: Tyres = b.tyres;
  if (slot === 'wheels') {
    const next: PartItem | null = item ?? { uid: 'x', id: 'tyre_none', cond: 1 };
    tyres = b.tyres.map((t, i) => (wheel === undefined || wheel === i ? next : t));
  } else if (item) {
    fit[slot] = item;
  } else {
    const empty = EMPTY_ID[slot];
    if (empty) fit[slot] = { uid: 'x', id: empty, cond: 1 };
    else delete fit[slot];
  }
  const radiator = slot === 'cooling' && item ? item.cond : b.comp.radiator ?? 1;
  const after = figures(b, fit, radiator, tyres);
  const wrongFuel = !!fuelMismatch(after.st.fuel, b.tank, b.fuel * after.st.tank);
  const notes: string[] = [];
  if (after.st.noEngine) notes.push('No engine: it will not run');
  if (after.st.noDrive) notes.push('No gearbox: nothing reaches the wheels');
  if (wrongFuel) notes.push(`The tank holds ${b.tank}, the engine burns ${after.st.fuel}: drain it`);
  else if (after.st.fuel !== before.st.fuel) notes.push(`Burns ${after.st.fuel} instead of ${before.st.fuel}`);
  if (after.heat.verdict === 'overheats') notes.push(VERDICT_TEXT.overheats);
  else if (after.heat.verdict === 'hot' && before.heat.verdict !== 'hot') notes.push(VERDICT_TEXT.hot);
  if ((slot === 'engine' || slot === 'hood') && (after.st.bayLabel === 'cut' || after.st.bayLabel === 'tight' || after.st.bayLabel === 'snug')) {
    notes.push(bayText(after.st.bayLabel, hoodState(fit)));
  }
  if (slot === 'hood' && item?.id === 'hood_cut') notes.push('A hole cut in the bonnet: it cannot be undone, and the rain gets in');
  if (!after.st.noDrive && after.st.strain > 1.05 && after.st.strain > before.st.strain + 0.02) notes.push(`The gearbox is overstrained (${after.st.strain.toFixed(1)}x): it will wear out. Fit a stronger one`);
  if (after.st.overload > 1.08 && after.st.overload > before.st.overload + 0.02) notes.push(`The springs are overloaded (${after.st.overload.toFixed(1)}x): it will sag and lose grip`);
  if (after.st.brakeMult < before.st.brakeMult - 0.12) notes.push('The brakes are not up to it: much longer stops');
  if (after.st.gripMult < before.st.gripMult - 0.08 && !(after.st.overload > 1.08)) notes.push('Heavier up front: it will handle worse');
  if (after.rangeKm < before.rangeKm * 0.7 && before.rangeKm > 0) notes.push('Much thirstier: the tank will not go as far');
  if (after.st.sumpL > before.st.sumpL * 1.25 || after.st.coolantL > before.st.coolantL * 1.25) {
    notes.push(`Thirstier for oil and water: ${after.st.sumpL.toFixed(1)} L sump (was ${before.st.sumpL.toFixed(1)}), ${after.st.coolantL.toFixed(1)} L cooling system (was ${before.st.coolantL.toFixed(1)})`);
  }
  if (after.st.hoodOff && !before.st.hoodOff) notes.push('No bonnet: the engine takes every hit and the rain');
  if (after.st.doorsOff > before.st.doorsOff) notes.push('No door: less armour on that side');
  if (after.st.tyresGone > before.st.tyresGone) notes.push('A bare wheel: almost no grip, and the rim chews up');
  if (after.st.noSteer && !before.st.noSteer) notes.push('No steering wheel: the steering barely turns. It still goes straight');
  if (after.st.noDriverSeat && !before.st.noDriverSeat) notes.push('No driver seat: you sit on the floor, with worse grip and aim');
  if (after.st.noPassengerSeat && !before.st.noPassengerSeat) notes.push('No passenger seat: nobody can ride beside the driver');
  if (after.st.noRearSeat && !before.st.noRearSeat) notes.push('No rear seat: bare floor, a little more room for cargo');
  if (after.st.noDash && !before.st.noDash) notes.push('No dashboard: the lamps flicker and barely light the road');
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
    strain: after.st.strain,
    strainBefore: before.st.strain,
    overload: after.st.overload,
    overloadBefore: before.st.overload,
    brake: after.st.brakeMult,
    brakeBefore: before.st.brakeMult,
    armor: after.st.armor,
    armorBefore: before.st.armor,
    grip: after.st.gripMult,
    gripBefore: before.st.gripMult,
    steer: after.st.steerMult,
    steerBefore: before.st.steerMult,
    sumpL: after.st.sumpL,
    sumpBefore: before.st.sumpL,
    coolantL: after.st.coolantL,
    coolantBefore: before.st.coolantL,
    notes,
  };
}

/** The same, for the build as it stands: used for the vehicle card. */
export function currentFigures(b: VehicleBuild) {
  const f = figures(b, b.fit, b.comp.radiator ?? 1);
  return { powerKw: f.st.power, topKmh: f.topKmh, rangeKm: f.rangeKm, heat: f.heat, bay: f.st.bayLabel, fuel: f.st.fuel, stats: statsOf(b) };
}

/** True when a part is worth the forecast line: anything that moves the numbers a driver feels. */
export function forecastWorthy(item: PartItem): boolean {
  const d = partDef(item.id);
  return ['engine', 'cooling', 'wheels', 'gearbox', 'suspension', 'brakes', 'exhaust', 'hood', 'doorL', 'doorR'].includes(d.slot) || isInteriorSlot(d.slot);
}
