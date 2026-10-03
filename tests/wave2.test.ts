import { describe, expect, it } from 'vitest';
import { chassisDef, partDef, PARTS, CHASSIS } from '../src/data';
import { effectiveStats, newPart, type Fit } from '../src/sim/parts';
import { installPart, installTyre, newBuild, removePart, removeTyre, tyreIdAt, statsOf, dismantleYield } from '../src/sim/garage';
import { bodyOff, gearboxPower, gearboxRatingNow, gearboxWear } from '../src/sim/drivetrain';
import { STD_SUMP_L, WATER_CAN, coolantFactor, coolantLitres, coolantLoss, coolantState, oilRate, pourWater, sumpLitres } from '../src/sim/fluids';
import { OIL_CAN, pourOil } from '../src/sim/oil';
import { steadyTemp } from '../src/sim/thermal';
import { forecastSwap } from '../src/sim/forecast';
import { describePart } from '../src/sim/parts';
import { partModelKey } from '../src/sim/carry';
import { socketFor } from '../src/render/sockets';

// An engine is only the start of it. These cover everything around it: the gearbox that has to carry what it makes, the
// brakes that stop what it speeds up, the springs that hold up what it weighs, and the oil and water it drinks.

const fitOf = (...ids: string[]): Fit => {
  const b = newBuild('moped');
  for (const id of ids) installPart(b, newPart(id, 1));
  return b.fit;
};

describe('the rest of the machine is made of real parts', () => {
  it('every chassis has a factory gearbox, springs, brakes and exhaust, and the stripped placeholders exist', () => {
    for (const id of Object.keys(CHASSIS)) {
      const def = chassisDef(id);
      if (!(def.slots ?? []).includes('gearbox')) continue;
      for (const pre of ['gbx', 'sus', 'brk', 'exh', 'tyre']) expect(PARTS.parts.some((p) => p.id === `${pre}_${id}`)).toBe(true);
    }
    for (const id of ['gbx_none', 'sus_none', 'brk_none', 'exh_none', 'hood_none', 'door_none', 'tyre_none']) expect(partDef(id).empty).toBe(true);
  });

  it('a stock vehicle is exactly what the table says', () => {
    for (const id of ['moped', 'quad', 'buggy', 'hatch', 'sedan', 'pickup', 'van']) {
      const st = effectiveStats(chassisDef(id), {});
      expect(st.forceMult).toBeCloseTo(1, 5);
      expect(st.topSpeedMult).toBeCloseTo(1, 5);
      expect(st.brakeMult).toBeCloseTo(1, 5);
      expect(st.overload).toBeLessThanOrEqual(1);
      expect(st.strain).toBeLessThanOrEqual(1.001);
      expect(st.noDrive).toBe(false);
      expect(st.doorsOff).toBe(0);
      expect(st.hoodOff).toBe(false);
    }
  });

  it('describes gearboxes, springs, brakes and exhausts in plain words', () => {
    expect(describePart(partDef('gbx_race')).join(' ')).toMatch(/kW/);
    expect(describePart(partDef('sus_air')).join(' ')).toMatch(/kg/);
    expect(describePart(partDef('brk_race')).join(' ')).toMatch(/kJ/);
    expect(describePart(partDef('exh_stack')).join(' ')).toMatch(/noise|flow|louder/i);
  });

  it('carried parts get their own little models', () => {
    expect(partModelKey('gbx_race')).toMatch(/^gear\d$/);
    expect(partModelKey('sus_long')).toMatch(/^spring\d$/);
    expect(partModelKey('brk_big')).toMatch(/^brake\d$/);
    expect(partModelKey('exh_race')).toMatch(/^pipe\d$/);
    expect(partModelKey('hood_scoop')).toMatch(/^hood\d$/);
    expect(partModelKey('door_armor')).toMatch(/^door\d$/);
  });
});

describe('the gearbox has to carry the engine', () => {
  it('a big engine in a small gearbox strains it, and a heavy gearbox carries the same engine', () => {
    const weak = effectiveStats(chassisDef('moped'), fitOf('eng_v8'));
    expect(weak.strain).toBeGreaterThan(1.5);
    const strong = effectiveStats(chassisDef('moped'), fitOf('eng_v8', 'gbx_transfer'));
    expect(strong.strain).toBeLessThan(1);
    expect(strong.gearboxRating).toBeGreaterThan(weak.gearboxRating);
  });

  it('an overstrained box wears, a comfortable one never does, and a worn one slips', () => {
    expect(gearboxWear(0.9, 1, 10)).toBe(0);
    expect(gearboxWear(2, 1, 10)).toBeGreaterThan(0);
    expect(gearboxWear(2, 0.1, 10)).toBe(0);
    expect(gearboxWear(3, 1, 10)).toBeGreaterThan(gearboxWear(1.5, 1, 10));
    expect(gearboxPower(1)).toBe(1);
    expect(gearboxPower(0.6)).toBe(1);
    expect(gearboxPower(0)).toBeLessThan(0.5);
    expect(gearboxRatingNow(100, 0)).toBeLessThan(gearboxRatingNow(100, 1));
  });

  it('short gears launch hard and run out of speed, tall gears do the opposite', () => {
    const base = effectiveStats(chassisDef('sedan'), {});
    const sport = effectiveStats(chassisDef('sedan'), fitOf('gbx_sport'));
    const tall = effectiveStats(chassisDef('sedan'), fitOf('gbx_overdrive'));
    expect(sport.forceMult).toBeGreaterThan(base.forceMult);
    expect(sport.topSpeedMult).toBeLessThan(base.topSpeedMult);
    expect(tall.topSpeedMult).toBeGreaterThan(base.topSpeedMult);
  });

  it('with no gearbox nothing reaches the wheels', () => {
    const b = newBuild('sedan');
    expect(removePart(b, 'gearbox')).not.toBeNull();
    const st = statsOf(b);
    expect(st.noDrive).toBe(true);
    expect(st.forceMult).toBe(0);
  });
});

describe('brakes and springs', () => {
  it('a fast, heavy build stops worse than a stock one until the brakes match it', () => {
    const def = chassisDef('hatch');
    const stock = effectiveStats(def, {});
    const fast = effectiveStats(def, fitOf('eng_v8'));
    expect(fast.stopDemand).toBeGreaterThan(stock.stopDemand * 1.5);
    expect(fast.brakeMult).toBeLessThanOrEqual(stock.brakeMult + 1e-9);
    const braked = effectiveStats(def, fitOf('eng_v8', 'brk_race'));
    expect(braked.brakeMult).toBeGreaterThan(fast.brakeMult);
  });

  it('no brakes, hardly any stopping', () => {
    const b = newBuild('hatch');
    removePart(b, 'brakes');
    expect(statsOf(b).brakeMult).toBeLessThan(0.4);
  });

  it('a heavy engine on light springs sags, and heavy springs hold it', () => {
    const light = effectiveStats(chassisDef('moped'), fitOf('eng_v8'));
    expect(light.overload).toBeGreaterThan(1);
    expect(light.travelMult).toBeLessThan(1);
    const heavy = effectiveStats(chassisDef('moped'), fitOf('eng_v8', 'sus_air'));
    expect(heavy.overload).toBeLessThan(light.overload);
    expect(heavy.gripMult).toBeGreaterThanOrEqual(light.gripMult);
  });

  it('a free-flow exhaust adds power and noise, a silencer takes both away', () => {
    const base = effectiveStats(chassisDef('sedan'), {});
    const loud = effectiveStats(chassisDef('sedan'), fitOf('exh_stack'));
    const quiet = effectiveStats(chassisDef('sedan'), fitOf('exh_quiet'));
    expect(loud.forceMult).toBeGreaterThan(base.forceMult);
    expect(loud.sigMult).toBeGreaterThan(base.sigMult);
    expect(quiet.sigMult).toBeLessThan(base.sigMult);
    expect(quiet.forceMult).toBeLessThan(base.forceMult);
  });
});

describe('a bigger engine drinks more of everything', () => {
  it('burns more fuel', () => {
    const def = chassisDef('hatch');
    const small = effectiveStats(def, {});
    const big = effectiveStats(def, fitOf('eng_v8'));
    expect(big.burnMult).toBeGreaterThan(small.burnMult * 1.5);
  });

  it('holds more oil, and burns it faster in litres', () => {
    const def = chassisDef('hatch');
    const small = effectiveStats(def, {});
    const big = effectiveStats(def, fitOf('eng_v8'));
    expect(big.sumpL).toBeGreaterThan(small.sumpL);
    expect(sumpLitres(6)).toBeGreaterThan(sumpLitres(1));
    // Litres per km: the rate is a share of its own sump, so multiply back.
    expect(big.oilRate * big.sumpL).toBeGreaterThan(small.oilRate * small.sumpL);
    expect(oilRate(6, true, false, 8)).toBeGreaterThan(oilRate(6, false, false, 8));
  });

  it('holds more water, and a small can goes a short way into a big system', () => {
    const def = chassisDef('moped');
    const small = effectiveStats(def, {});
    const big = effectiveStats(def, fitOf('eng_v8', 'rad_race_l'));
    expect(big.coolantL).toBeGreaterThan(small.coolantL * 2);
    expect(coolantLitres(100, 5)).toBeGreaterThan(coolantLitres(20, 1));
    const half = pourWater(0.5, WATER_CAN, big.coolantL);
    expect(half.used).toBeGreaterThan(0);
    const filled = pourWater(0, 1, big.coolantL);
    expect(filled.coolant).toBeCloseTo(1 / big.coolantL, 5);
    expect(filled.left).toBe(0);
  });

  it('an oil can fills a scooter and only tops up a rig', () => {
    const small = pourOil(0, OIL_CAN, sumpLitres(0.05));
    const rig = pourOil(0, OIL_CAN, sumpLitres(12));
    expect(small.oil).toBeGreaterThan(rig.oil);
    expect(STD_SUMP_L).toBe(3);
  });

  it('a dry cooling system cooks the engine, and a holed or boiling one loses its water', () => {
    expect(coolantFactor(1)).toBe(1);
    expect(coolantFactor(0)).toBeLessThan(0.2);
    const cool = steadyTemp({ heat: 40, cooling: 60, radiator: 1, airflow: 1, load: 0.8, speed: 20, running: true, coolant: 1 });
    const dry = steadyTemp({ heat: 40, cooling: 60, radiator: 1, airflow: 1, load: 0.8, speed: 20, running: true, coolant: 0.1 });
    expect(dry).toBeGreaterThan(cool);
    const calm = coolantLoss({ T: 0.4, radiator: 1, coolantL: 5, running: true, dt: 1 });
    const holed = coolantLoss({ T: 0.4, radiator: 0.1, coolantL: 5, running: true, dt: 1 });
    const boiling = coolantLoss({ T: 1.2, radiator: 1, coolantL: 5, running: true, dt: 1 });
    expect(holed).toBeGreaterThan(calm);
    expect(boiling).toBeGreaterThan(calm);
    expect(coolantState(0.05)).toBe('critical');
    expect(coolantState(0.2)).toBe('low');
    expect(coolantState(0.9)).toBe('ok');
  });
});

describe('tyres, one per wheel', () => {
  it('fitting one tyre changes one wheel', () => {
    const b = newBuild('sedan');
    const before = tyreIdAt(b, 2);
    const r = installPart(b, newPart('whl_bl', 0.8), 1);
    expect(r.ok).toBe(true);
    expect(tyreIdAt(b, 1)).toBe('whl_bl');
    expect(tyreIdAt(b, 0)).toBe(before);
    expect(tyreIdAt(b, 2)).toBe(before);
    // The old tyre comes back as the real part it was.
    expect(r.removed?.id).toBe(before);
    expect(b.comp.tires[1]).toBeCloseTo(0.8, 5);
  });

  it('a mixed set counts as the mix it is, and a fitted set counts for everything', () => {
    const mixed = newBuild('sedan');
    installPart(mixed, newPart('whl_bl', 1), 0);
    const all = newBuild('sedan');
    installPart(all, newPart('whl_bl', 1));
    expect(all.tyres.every((t) => t?.id === 'whl_bl')).toBe(true);
    const a = statsOf(mixed);
    const z = statsOf(all);
    expect(z.offroad).toBeGreaterThan(a.offroad);
    expect(a.offroad).toBeGreaterThan(statsOf(newBuild('sedan')).offroad);
  });

  it('pulling a tyre leaves a bare hub that grips little, and a fresh tyre fixes it', () => {
    const b = newBuild('hatch');
    const out = removeTyre(b, 3);
    expect(out).not.toBeNull();
    expect(tyreIdAt(b, 3)).toBeNull();
    expect(b.comp.tires[3]).toBe(0);
    expect(statsOf(b).tyresGone).toBe(1);
    expect(statsOf(b).gripMult).toBeLessThan(statsOf(newBuild('hatch')).gripMult);
    installTyre(b, 3, out!);
    expect(statsOf(b).tyresGone).toBe(0);
  });

  it('a wrecked vehicle gives its tyres back as parts', () => {
    const b = newBuild('hatch');
    const y = dismantleYield(b);
    expect(y.items.filter((i) => partDef(i.id).slot === 'wheels').length).toBe(4);
  });
});

describe('doors and bonnet come off', () => {
  it('strip them and the stats say so; fit them back and they are gone again', () => {
    const b = newBuild('sedan');
    expect(removePart(b, 'hood')?.id).toBe('hood_std');
    expect(removePart(b, 'doorL')?.id).toBe('door_std');
    const st = statsOf(b);
    expect(st.hoodOff).toBe(true);
    expect(st.doorsOff).toBe(1);
    expect(bodyOff(chassisDef('sedan'), b.fit)).toEqual({ hood: true, doors: 1 });
    installPart(b, newPart('hood_armor', 1));
    installPart(b, newPart('door_armor', 1), 'doorL');
    expect(statsOf(b).hoodOff).toBe(false);
    expect(statsOf(b).doorsOff).toBe(0);
    expect(statsOf(b).armor).toBeGreaterThan(statsOf(newBuild('sedan')).armor);
  });

  it('a door that is not there stops nothing on that side', () => {
    const b = newBuild('sedan');
    const armS = statsOf(b).armorS;
    removePart(b, 'doorL');
    expect(statsOf(b).armorS).toBeLessThan(armS);
    removePart(b, 'doorR');
    expect(statsOf(b).armorS).toBeLessThan(armS - 0.1);
  });

  it('a door fits either side', () => {
    const b = newBuild('sedan');
    removePart(b, 'doorR');
    const r = installPart(b, newPart('door_plate', 1), 'doorR');
    expect(r.ok).toBe(true);
    expect(b.fit.doorR?.id).toBe('door_plate');
    // And with no side named it goes where there is a gap.
    removePart(b, 'doorL');
    installPart(b, newPart('door_light', 1));
    expect(b.fit.doorL?.id).toBe('door_light');
  });

  it('a bike has no doors or bonnet to speak of', () => {
    const b = newBuild('moped');
    expect(installPart(b, newPart('door_plate', 1)).ok).toBe(false);
    expect(installPart(b, newPart('hood_vent', 1)).ok).toBe(false);
  });

  it('every chassis that takes them has a socket for them', () => {
    for (const id of ['hatch', 'sedan', 'pickup', 'van']) {
      const def = chassisDef(id);
      for (const slot of ['hood', 'doorL', 'doorR', 'gearbox', 'exhaust'] as const) expect(socketFor(def, slot)?.anchors.length).toBeGreaterThan(0);
      expect(socketFor(def, 'suspension')!.anchors).toHaveLength(def.physics.wheelCount);
      expect(socketFor(def, 'brakes')!.anchors).toHaveLength(def.physics.wheelCount);
    }
  });
});

describe('forecasts judge the whole machine', () => {
  it('say what a V8 does to a moped gearbox and springs before the bolts go in', () => {
    const b = newBuild('moped');
    const f = forecastSwap(b, 'engine', newPart('eng_v8', 1));
    const text = JSON.stringify(f);
    expect(text).toMatch(/gearbox/i);
    expect(text).toMatch(/spring|sag|suspension/i);
  });
});
