import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { CHASSIS, chassisDef, partDef } from '../src/data';
import { massBreakdown, curbKg, referenceKg, OCCUPANT_KG } from '../src/sim/massModel';
import { DriveUnit, engineCurve, gearing, powerAt, powertrainFor, stockPowertrain, straightRun, torqueAt } from '../src/sim/powertrain';
import { describePerformance, effectiveStats, newPart } from '../src/sim/parts';
import type { CargoEntry } from '../src/sim/cargo';
import { bench } from './helpers/carBench';

beforeAll(async () => {
  await initPhysics();
});

const fitOf = (...ids: string[]) => Object.fromEntries(ids.map((id) => [partDef(id).slot, newPart(id)]));
const engine = (id: string) => partDef(id).engine!;

/** The old arcade physics, measured with tests/helpers/carBench.ts before the powertrain went in. */
const BASELINE: Record<string, { t50: number; top: number; brake: number; hill20: number }> = {
  moped: { t50: 2.28, top: 66.9, brake: 16.6, hill20: 58.4 },
  quad: { t50: 1.77, top: 98.9, brake: 25.9, hill20: 87.5 },
  buggy: { t50: 1.82, top: 89.9, brake: 23.2, hill20: 79.4 },
  hatch: { t50: 1.73, top: 110.2, brake: 23.3, hill20: 97.2 },
  sedan: { t50: 1.78, top: 113.4, brake: 23.3, hill20: 99.2 },
  pickup: { t50: 1.97, top: 100.7, brake: 23.3, hill20: 87.3 },
  van: { t50: 2.2, top: 91.4, brake: 25.7, hill20: 77.9 },
  trike: { t50: 2.37, top: 73.8, brake: 20.0, hill20: 63.3 },
};
const BRAKE_FROM: Record<string, number> = { moped: 60.2, trike: 66.4 };

describe('what a vehicle weighs', () => {
  it('a stock chassis weighs exactly what the table says, item by item', () => {
    for (const d of Object.values(CHASSIS)) {
      const b = massBreakdown(d);
      expect(b.total).toBeCloseTo(d.physics.mass, 6);
      expect(b.items.reduce((a, i) => a + i.kg, 0)).toBeCloseTo(b.total, 6);
      expect(b.items[0].kg).toBeGreaterThan(d.physics.mass * 0.4);
      expect(referenceKg(d)).toBe(d.physics.mass + OCCUPANT_KG);
    }
  });

  it('fuel, people, stowed spares and cargo all count, and move the centre of mass where they sit', () => {
    const def = chassisDef('pickup');
    const base = { chassis: 'pickup', fit: {}, fuel: 1 };
    const empty = massBreakdown({ ...base, fuel: 0 });
    const full = massBreakdown(base);
    expect(full.total - empty.total).toBeCloseTo(def.tank * 4 * 0.84, 0);
    const crew = massBreakdown(base, { occupants: [{ seat: 'driver' }, { seat: 'passenger' }] });
    expect(crew.total - full.total).toBeCloseTo(2 * OCCUPANT_KG, 6);
    // A driver, a full tank and stock parts is the reference: scale 1, centre where it always was.
    const ref = massBreakdown(base, { occupants: [{ seat: 'driver' }] });
    expect(ref.scale).toBeCloseTo(1, 6);
    expect(Math.hypot(ref.com.x, ref.com.y, ref.com.z)).toBeLessThan(1e-6);
    const engines: CargoEntry[] = [0, 1, 2].map((i) => ({ id: `e${i}`, zone: 'bed', c: { kind: 'part', item: newPart('eng_v6') }, thr: 1 }));
    const bed = massBreakdown(base, { occupants: [{ seat: 'driver' }], cargo: engines });
    expect(bed.total - ref.total).toBeCloseTo(3 * 185, 0);
    expect(bed.com.z).toBeLessThan(-0.15);
    const roof: CargoEntry[] = [0, 1, 2].map((i) => ({ id: `r${i}`, zone: 'roof', c: { kind: 'part', item: newPart('eng_v6') }, thr: 1 }));
    const top = massBreakdown(base, { occupants: [{ seat: 'driver' }], cargo: roof });
    expect(top.com.y).toBeGreaterThan(bed.com.y + 0.15);
    expect(top.inertia.z).toBeGreaterThan(bed.inertia.z);
    const stowed = massBreakdown(base, { occupants: [{ seat: 'driver' }], stowed: [newPart('gbx_heavy'), newPart('brk_big')] });
    expect(stowed.total - ref.total).toBeCloseTo(140 + 32, 0);
  });

  it('heavy parts make a heavy car, and the stats say so', () => {
    const hatch = chassisDef('hatch');
    expect(curbKg(hatch, {})).toBeCloseTo(hatch.physics.mass, 6);
    // 170 kg more engine, and a bigger sump and water jacket with it.
    expect(curbKg(hatch, fitOf('eng_v8')) - curbKg(hatch, {})).toBeGreaterThan(170);
    expect(curbKg(hatch, fitOf('eng_v8')) - curbKg(hatch, {})).toBeLessThan(195);
    expect(curbKg(hatch, fitOf('arm_weld'))).toBeGreaterThan(hatch.physics.mass + 100);
    expect(effectiveStats(hatch, fitOf('arm_weld', 'sd_plate')).mass).toBeGreaterThan(hatch.physics.mass + 200);
  });
});

describe('torque curves', () => {
  it('every engine makes its rated power at its power peak, and never more', () => {
    for (const p of Object.values(CHASSIS)) {
      const e = engine(p.stockEngine!);
      const c = engineCurve(e)!;
      expect(powerAt(c, c.peakPwRpm)).toBeCloseTo(e.kw, 0);
      for (let rpm = c.idle; rpm < c.redline; rpm += 100) expect(powerAt(c, rpm)).toBeLessThanOrEqual(e.kw * 1.001);
      expect(c.idle).toBeLessThan(c.peakTqRpm);
      expect(c.peakTqRpm).toBeLessThan(c.peakPwRpm);
      expect(c.peakPwRpm).toBeLessThan(c.redline);
    }
  });

  it('a diesel pulls low and runs out early, a petrol revs, a blower holds a plateau, a scooter lives in a narrow band', () => {
    const diesel = engineCurve(engine('eng_d25'))!;
    const petrol = engineCurve(engine('eng_i4'))!;
    const blown = engineCurve(engine('eng_v8'))!;
    const scooter = engineCurve(engine('eng_50cc'))!;
    expect(diesel.redline).toBeLessThan(petrol.redline * 0.7);
    expect(diesel.peakTqRpm).toBeLessThan(petrol.peakTqRpm * 0.6);
    // Less output, but the diesel has far more torque.
    expect(diesel.peakNm).toBeGreaterThan(petrol.peakNm * 1.5);
    // The blower is nearly flat across the middle of its band.
    expect(torqueAt(blown, blown.peakTqRpm * 1.5)).toBeGreaterThan(blown.peakNm * 0.97);
    // The scooter has little until high in its band.
    expect(torqueAt(scooter, scooter.idle * 1.5)).toBeLessThan(scooter.peakNm * 0.6);
    // Real-world sizes: a 1.8 L four makes about 145 Nm, a 14.5 L truck diesel over 2,000.
    expect(engineCurve(engine('eng_i4_18'))!.peakNm).toBeGreaterThan(120);
    expect(engineCurve(engine('eng_d145'))!.peakNm).toBeGreaterThan(2000);
  });
});

describe('gears and the automatic', () => {
  it('a gearbox has its gears, and the final drive is matched to the engine', () => {
    const sedan = chassisDef('sedan');
    expect(gearing(sedan, {}).ratios).toHaveLength(6);
    expect(gearing(chassisDef('moped'), {}).cvt).toBe(true);
    expect(gearing(sedan, fitOf('gbx_transfer')).ratios).toHaveLength(8);
    // Short gears run out of revs sooner, tall ones later.
    expect(gearing(sedan, fitOf('gbx_sport')).vRev).toBeLessThan(gearing(sedan, {}).vRev);
    expect(gearing(sedan, fitOf('gbx_overdrive')).vRev).toBeGreaterThan(gearing(sedan, {}).vRev);
    // A V8 gets taller gearing for the speed its power is good for.
    expect(gearing(sedan, fitOf('eng_v8')).vRev).toBeGreaterThan(gearing(sedan, {}).vRev * 1.3);
  });

  it('flat out it climbs through every gear in order, and holds a cruise without hunting', () => {
    const def = chassisDef('sedan');
    const pt = stockPowertrain(def);
    const u = new DriveUnit(pt);
    const m = def.physics.mass;
    let v = 0;
    const seen: number[] = [];
    for (let t = 0; t < 30; t += 1 / 60) {
      const F = Math.min(u.step(1 / 60, v, 1, 1, true), pt.mu * m * 9.81);
      v += (F / m - 0.04 * v - (pt.air * v * v) / m) / 60;
      if (seen[seen.length - 1] !== u.gear) seen.push(u.gear);
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
    // Cruise at half throttle near 70 km/h: a few shifts at most, then it stays put.
    let shifts = 0;
    let last = u.gear;
    for (let t = 0; t < 20; t += 1 / 60) {
      u.step(1 / 60, 19.5 + Math.sin(t) * 0.3, 0.35, 1, true);
      if (u.gear !== last) shifts++;
      last = u.gear;
    }
    expect(shifts).toBeLessThanOrEqual(2);
    // A stab of the throttle kicks it down.
    const before = u.gear;
    u.step(1 / 60, 19.5, 1, 1, true);
    expect(u.gear).toBeLessThan(before);
  });

  it('reverse is its own gear, and the revs follow the wheels', () => {
    const u = new DriveUnit(stockPowertrain(chassisDef('hatch')));
    const F = u.step(1 / 60, 0, 1, -1, true);
    expect(u.gear).toBe(-1);
    for (let i = 0; i < 60; i++) u.step(1 / 60, -2, 1, -1, true);
    expect(u.step(1 / 60, -2, 1, -1, true)).toBeLessThan(0);
    expect(F).toBeLessThanOrEqual(0);
    expect(u.rpm).toBeGreaterThan(u.pt.curve!.idle);
  });

  it('the garage figures: a V8 is quicker, a 650 slower, and an overloaded build quotes its weight', () => {
    const hatch = chassisDef('hatch');
    const stock = effectiveStats(hatch, {});
    const v8 = effectiveStats(hatch, fitOf('eng_v8'));
    const tiny = effectiveStats(hatch, fitOf('eng_650'));
    expect(stock.zeroTo100).toBeGreaterThan(3);
    expect(stock.zeroTo100).toBeLessThan(8);
    expect(v8.zeroTo100).toBeLessThan(stock.zeroTo100);
    expect(tiny.zeroTo100).toBeGreaterThan(stock.zeroTo100);
    expect(v8.peakTorque).toBeGreaterThan(stock.peakTorque * 4);
    expect(v8.powerToWeight).toBeGreaterThan(stock.powerToWeight * 3);
    expect(v8.topKmh).toBeGreaterThan(stock.topKmh * 1.3);
    expect(stock.gears).toBe(5);
    expect(describePerformance(stock).join(' ')).toMatch(/kg.*kW\/t.*Nm.*0-100/);
  });
});

describe('on the road', () => {
  it('stock vehicles drive within 15% of the old tuning (launch, top speed, brakes, a 20% hill)', () => {
    for (const [id, b] of Object.entries(BASELINE)) {
      const r = bench(chassisDef(id), {}, { brakeKmh: BRAKE_FROM[id] ?? 80 });
      expect(Math.abs(r.t50 / b.t50 - 1), `${id} 0-50`).toBeLessThan(0.15);
      expect(Math.abs(r.top / b.top - 1), `${id} top`).toBeLessThan(0.05);
      expect(Math.abs(r.brakeDist / b.brake - 1), `${id} brakes`).toBeLessThan(0.15);
      expect(Math.abs(r.hill20 / b.hill20 - 1), `${id} hill`).toBeLessThan(0.15);
    }
  }, 120000);

  it('a loaded pickup squats, pulls slower, stops longer, and drops a gear up a hill it used to take in its stride', () => {
    const def = chassisDef('pickup');
    const empty = bench(def, {}, { brakeKmh: 80 });
    // 800 kg in the bed: three engines and a gearbox, give or take.
    const loaded = bench(def, { prep: (v) => v.setLoad({ scale: (referenceKg(def) + 800) / referenceKg(def), com: { x: 0, y: 0.05, z: -0.6 } }) }, { brakeKmh: 80 });
    expect(loaded.rest).toBeLessThan(empty.rest - 0.02);
    expect(loaded.t50).toBeGreaterThan(empty.t50 * 1.2);
    expect(loaded.brakeDist).toBeGreaterThan(empty.brakeDist * 1.1);
    expect(loaded.hill20).toBeLessThan(empty.hill20 * 0.9);
    expect(loaded.gearHill).toBeLessThan(loaded.gearFlat);
  }, 60000);

  it('stock, a driver aboard, the body sits exactly where the model expects it', () => {
    for (const id of ['hatch', 'pickup', 'moped', 'trike']) {
      const def = chassisDef(id);
      const plain = bench(def, {}, { skipHill: true });
      const weighed = bench(def, { prep: (v) => v.setLoad({ scale: 1, com: { x: 0, y: 0, z: 0 } }) }, { skipHill: true });
      expect(Math.abs(weighed.rest - plain.rest)).toBeLessThan(0.002);
    }
  }, 60000);

  it('a 1D run and the physics agree on the stock launch', () => {
    const def = chassisDef('hatch');
    const r = straightRun(powertrainFor(def, {}), def.physics.mass, [50 / 3.6], 10);
    expect(Math.abs(r.times[0] / BASELINE.hatch.t50 - 1)).toBeLessThan(0.15);
  });
});
