import { describe, expect, it } from 'vitest';
import { CHASSIS, FUEL_TYPES, PARTS, chassisDef, partDef, validateData } from '../src/data';
import { Rng } from '../src/core/rng';
import { Campaign } from '../src/game/campaign';
import { effectiveStats, newPart, rollPart, describePart } from '../src/sim/parts';
import { bayFit, engineEffects, engineLine, engineSpec, stockEngineSpec } from '../src/sim/engines';
import { conditionSummary, dismantleYield, installPart, newBuild, partInSlot, rebuildOnto, removePart, serviceBuild, statsOf, toHealth } from '../src/sim/garage';
import { fuelMismatch, pickupFuel, planDrain, planPour, reserveOf, takeReserve, addReserve, TANK_DREGS } from '../src/sim/fuel';
import { T_CRITICAL, T_OVERHEAT, overheatPower, overheatWear, steadyTemp, tempState, thermalForecast, thermalStep } from '../src/sim/thermal';
import { applyHit } from '../src/sim/damage';
import { applyRepair, planRepair } from '../src/sim/repair';
import { rollCar, HOT_ROD } from '../src/sim/cars';
import { salvageLoot } from '../src/sim/salvage';
import { newStocks } from '../src/sim/resources';

const part = (id: string, cond = 1) => newPart(id, cond);
const ENGINES = PARTS.parts.filter((p) => p.slot === 'engine' && !p.empty);
const RADIATORS = PARTS.parts.filter((p) => p.slot === 'cooling' && !p.empty);
const CHASSIS_IDS = Object.keys(CHASSIS);

describe('the engine catalogue', () => {
  it('passes data validation', () => {
    expect(validateData()).toEqual([]);
  });
  it('has petrol and diesel engines at every size, from a scooter to a rig', () => {
    for (const f of FUEL_TYPES) expect(ENGINES.filter((e) => e.engine!.fuel === f && !e.stock).length).toBeGreaterThanOrEqual(3);
    const sizes = new Set(ENGINES.map((e) => e.engine!.size));
    for (const s of [1, 2, 3, 4, 5]) expect(sizes.has(s)).toBe(true);
  });
  it('every chassis has a factory engine and radiator that are real parts', () => {
    for (const id of CHASSIS_IDS) {
      const d = chassisDef(id);
      expect(partDef(d.stockEngine!).stock).toBe(true);
      expect(partDef(d.stockRadiator!).stock).toBe(true);
    }
  });
  it('trucks, vans and pickups burn diesel; cars and bikes burn petrol', () => {
    for (const id of ['pickup', 'van', 'truck', 'rig']) expect(stockEngineSpec(chassisDef(id)).fuel).toBe('diesel');
    for (const id of ['moped', 'quad', 'buggy', 'hatch', 'sedan']) expect(stockEngineSpec(chassisDef(id)).fuel).toBe('petrol');
  });
  it('factory fittings and the empty placeholders never turn up as loot', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 3000; i++) {
      const d = partDef(rollPart(rng, { bias: i % 3 }).id);
      expect(d.stock).toBeFalsy();
      expect(d.empty).toBeFalsy();
    }
  });
  it('an engine is described in plain words', () => {
    expect(engineLine(partDef('eng_v8').engine!)).toBe('5.7 L V8 blown · 260 kW · petrol');
    expect(engineLine(partDef('eng_50cc').engine!)).toBe('50cc · 3 kW · petrol');
    expect(describePart(partDef('rad_race_m'))).toEqual(['cooling 190 kW']);
  });
});

describe('a stock vehicle is exactly what the table says', () => {
  it('every chassis is neutral with its factory fittings', () => {
    for (const id of CHASSIS_IDS) {
      const st = effectiveStats(chassisDef(id), {});
      expect(st.forceMult).toBe(1);
      expect(st.topSpeedMult).toBe(1);
      expect(st.gripMult).toBe(1);
      expect(st.travelMult).toBe(1);
      expect(st.burnMult).toBeCloseTo(1, 9);
      expect(st.sigMult).toBeCloseTo(1, 9);
      expect(st.noEngine).toBe(false);
      expect(st.airflow).toBe(1);
    }
  });
  it('fitting the factory engine back changes nothing', () => {
    for (const id of CHASSIS_IDS) {
      const d = chassisDef(id);
      const a = effectiveStats(d, {});
      const b = effectiveStats(d, { engine: part(d.stockEngine!), cooling: part(d.stockRadiator!) });
      expect(b.forceMult).toBe(a.forceMult);
      expect(b.coolKw).toBe(a.coolKw);
    }
  });
  it('a stock vehicle never overheats, even flat out', () => {
    for (const id of CHASSIS_IDS) {
      const d = chassisDef(id);
      const st = effectiveStats(d, {});
      const f = thermalForecast(st.heat, st.coolKw, st.airflow, d.topSpeedKmh / 3.6);
      expect(f.verdict).toBe('cool');
    }
  });
});

describe('any engine goes in any chassis', () => {
  it('every engine in every chassis gives finite, bounded numbers', () => {
    for (const id of CHASSIS_IDS) {
      for (const e of ENGINES) {
        const st = effectiveStats(chassisDef(id), { engine: part(e.id) });
        for (const v of [st.forceMult, st.topSpeedMult, st.gripMult, st.travelMult, st.burnMult, st.sigMult, st.heat]) expect(Number.isFinite(v)).toBe(true);
        expect(st.forceMult).toBeGreaterThanOrEqual(0.2 * 0.4);
        expect(st.forceMult).toBeLessThanOrEqual(4 * 1.8);
        expect(st.topSpeedMult).toBeGreaterThan(0.2);
        expect(st.topSpeedMult).toBeLessThanOrEqual(2);
        expect(st.gripMult).toBeGreaterThan(0.2);
        expect(st.fuel).toBe(e.engine!.fuel);
      }
    }
  });
  it('a big engine in a small car: much faster, thirstier, louder, heavier-handling, and crowded in the bay', () => {
    const hatch = chassisDef('hatch');
    const v8 = effectiveStats(hatch, { engine: part('eng_v8') });
    expect(v8.forceMult).toBeGreaterThan(2);
    expect(v8.topSpeedMult).toBeGreaterThan(1.3);
    expect(v8.burnMult).toBeGreaterThan(2);
    expect(v8.sigMult).toBeGreaterThan(1.3);
    expect(v8.gripMult).toBeLessThan(0.85);
    expect(v8.travelMult).toBeLessThan(1);
    expect(v8.bayLabel).toBe('cut');
    expect(v8.airflow).toBeLessThan(0.7);
    expect(v8.massDelta).toBeGreaterThan(150);
  });
  it('a small engine in a big van: slow and frugal, rattling around in the bay', () => {
    const van = chassisDef('van');
    const tiny = effectiveStats(van, { engine: part('eng_650') });
    expect(tiny.forceMult).toBeLessThan(0.5);
    expect(tiny.topSpeedMult).toBeLessThan(0.8);
    expect(tiny.burnMult).toBeLessThan(0.6);
    expect(tiny.bayLabel).toBe('loose');
    expect(tiny.gripMult).toBe(1);
  });
  it('the heavier the engine, the more the nose sags and the less it grips', () => {
    const sedan = chassisDef('sedan');
    const light = effectiveStats(sedan, { engine: part('eng_i4') });
    const heavy = effectiveStats(sedan, { engine: part('eng_d6') });
    expect(heavy.travelMult).toBeLessThan(light.travelMult);
    expect(heavy.gripMult).toBeLessThan(light.gripMult);
  });
  it('diesel is thriftier than petrol at the same output', () => {
    const sedan = chassisDef('sedan');
    const petrol = effectiveStats(sedan, { engine: part('eng_v6') });
    const diesel = effectiveStats(sedan, { engine: part('eng_d6') });
    // 150 kW petrol against 160 kW diesel.
    expect(diesel.burnMult).toBeLessThan(petrol.burnMult);
  });
  it('the bay is rated by how far the engine overshoots it', () => {
    const hatch = chassisDef('hatch');
    expect(bayFit(hatch, partDef('eng_i3').engine!).label).toBe('fits');
    expect(bayFit(hatch, partDef('eng_i4').engine!).label).toBe('snug');
    expect(bayFit(hatch, partDef('eng_v6').engine!).label).toBe('tight');
    expect(bayFit(hatch, partDef('eng_v8').engine!).label).toBe('cut');
    expect(bayFit(chassisDef('rig'), partDef('eng_50cc').engine!).label).toBe('loose');
  });
  it('a petrol motor in a diesel van, and a diesel in a petrol car', () => {
    expect(effectiveStats(chassisDef('van'), { engine: part('eng_i4') }).fuel).toBe('petrol');
    expect(effectiveStats(chassisDef('hatch'), { engine: part('eng_i3d') }).fuel).toBe('diesel');
    expect(engineSpec(chassisDef('van'), {}).fuel).toBe('diesel');
  });
});

describe('swapping an engine on a build', () => {
  it('the factory engine comes out as a real part carrying the wear it had', () => {
    const b = newBuild('hatch', { seed: 1 });
    b.comp.engine = 0.6;
    const res = installPart(b, part('eng_v6', 0.9));
    expect(res.ok).toBe(true);
    expect(res.removed).toMatchObject({ id: 'eng_i3' });
    expect(res.removed!.cond).toBeCloseTo(0.6);
    expect(b.comp.engine).toBeCloseTo(0.9);
    // And it goes back in, restoring the old numbers.
    const back = installPart(b, res.removed!);
    expect(back.removed?.id).toBe('eng_v6');
    expect(effectiveStats(chassisDef('hatch'), b.fit).forceMult).toBe(1);
  });
  it('stripping the bay leaves an empty mount: no power, nothing to burn', () => {
    const b = newBuild('sedan', { seed: 1 });
    const out = removePart(b, 'engine')!;
    expect(out.id).toBe('eng_i4_18');
    expect(partInSlot(b, 'engine')).toBeNull();
    const st = statsOf(b);
    expect(st.noEngine).toBe(true);
    expect(st.forceMult).toBe(0);
    expect(st.burnMult).toBe(0);
    expect(st.power).toBe(0);
    expect(conditionSummary(b)).toContain('no engine');
    // Pulling from an empty bay gives nothing, and a new engine goes straight in with no phantom part coming out.
    expect(removePart(b, 'engine')).toBeNull();
    const res = installPart(b, part('eng_v6'));
    expect(res.ok).toBe(true);
    expect(res.removed).toBeUndefined();
    expect(statsOf(b).noEngine).toBe(false);
  });
  it('the empty placeholder is not a part you can fit', () => {
    const b = newBuild('sedan', { seed: 1 });
    expect(installPart(b, part('eng_none')).ok).toBe(false);
    expect(installPart(b, part('rad_none')).ok).toBe(false);
  });
  it('dismantling a vehicle returns its factory engine and radiator too', () => {
    const b = newBuild('van', { seed: 1 });
    const ids = dismantleYield(b).items.map((i) => i.id);
    expect(ids).toContain('eng_d30');
    expect(ids).toContain('rad_van');
    removePart(b, 'engine');
    const after = dismantleYield(b).items.map((i) => i.id);
    expect(after).not.toContain('eng_d30');
    expect(after).toContain('rad_van');
  });
  it('rebuilding onto another chassis takes that chassis its own factory engine and fuel', () => {
    const b = newBuild('hatch', { seed: 1 });
    expect(b.tank).toBe('petrol');
    rebuildOnto(b, 'pickup');
    expect(b.tank).toBe('diesel');
    expect(statsOf(b).forceMult).toBe(1);
  });
  it('a swapped-in engine from another car stays when the frame is rebuilt', () => {
    const b = newBuild('buggy', { seed: 1 });
    installPart(b, part('eng_d6'));
    rebuildOnto(b, 'moped');
    expect(b.fit.engine?.id).toBe('eng_d6');
    expect(b.tank).toBe('diesel');
  });
});

describe('petrol and diesel', () => {
  it('a petrol engine in a diesel van leaves diesel in the tank, and says so', () => {
    const b = newBuild('van', { seed: 1, fuel: 0.7 });
    expect(b.tank).toBe('diesel');
    const res = installPart(b, part('eng_i4'));
    expect(res.note).toMatch(/Wrong fuel/);
    expect(fuelMismatch(statsOf(b).fuel, b.tank, b.fuel)).not.toBe('');
    expect(conditionSummary(b)).toContain('wrong fuel');
  });
  it('an empty tank has nothing to be wrong about', () => {
    expect(fuelMismatch('petrol', 'diesel', 0)).toBe('');
    expect(fuelMismatch('petrol', 'petrol', 0.9)).toBe('');
  });
  it('pouring: same fuel is fine, a different fuel only goes into a dry tank, mixing is refused', () => {
    expect(planPour('diesel', 6, 'diesel').ok).toBe(true);
    const mix = planPour('diesel', 6, 'petrol');
    expect(mix.ok).toBe(false);
    expect(mix.note).toMatch(/drain/);
    const dry = planPour('diesel', TANK_DREGS - 0.1, 'petrol');
    expect(dry.ok).toBe(true);
    expect(dry.tank).toBe('petrol');
  });
  it('draining a wrong-fuel tank is offered, and an empty one is not', () => {
    expect(planDrain('diesel', 5.5, 'petrol')).toMatchObject({ ok: true, amount: 5.5 });
    expect(planDrain('diesel', 5.5, 'petrol').label).toMatch(/engine wants petrol/);
    expect(planDrain('petrol', 0.1, 'petrol').ok).toBe(false);
  });
  it('the reserve keeps the two fuels apart', () => {
    const c = { stocks: newStocks({ fuel: 10 }), items: { diesel: 4 } };
    expect(reserveOf(c, 'petrol')).toBe(10);
    expect(reserveOf(c, 'diesel')).toBe(4);
    expect(takeReserve(c, 'diesel', 9)).toBe(4);
    expect(c.items.diesel).toBe(0);
    expect(c.stocks.fuel).toBe(10);
    addReserve(c, 'diesel', 3);
    addReserve(c, 'petrol', 2);
    expect([c.items.diesel, c.stocks.fuel]).toEqual([3, 12]);
  });
  it('about a third of the fuel found in the world is diesel, decided by where it lies', () => {
    let diesel = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) if (pickupFuel(`f${i}`) === 'diesel') diesel++;
    expect(diesel / n).toBeGreaterThan(0.28);
    expect(diesel / n).toBeLessThan(0.4);
    expect(pickupFuel('f12')).toBe(pickupFuel('f12'));
  });
});

describe('the radiator', () => {
  it('fitting one sets the radiator condition; pulling the factory one leaves a worn mount', () => {
    const b = newBuild('hatch', { seed: 1 });
    installPart(b, part('rad_race_m', 0.8));
    expect(b.comp.radiator).toBeCloseTo(0.8);
    expect(statsOf(b).coolKw).toBe(190);
    b.comp.radiator = 0.5;
    const out = removePart(b, 'cooling')!;
    expect(out.id).toBe('rad_race_m');
    expect(out.cond).toBeCloseTo(0.5);
    expect(statsOf(b).coolKw).toBe(0);
  });
  it('the factory radiator is a part too: pulled, it carries its wear', () => {
    const b = newBuild('sedan', { seed: 1 });
    b.comp.radiator = 0.4;
    const out = removePart(b, 'cooling')!;
    expect(out.id).toBe('rad_sedan');
    expect(out.cond).toBeCloseTo(0.4);
  });
  it('a hit that holes the engine also dents the radiator', () => {
    const b = newBuild('sedan', { seed: 1 });
    const h = toHealth(b);
    let r = 0.3;
    for (let i = 0; i < 400 && h.comp.radiator === 1; i++) {
      applyHit(h, 80, { facing: 'front', roll: () => (r = (r + 0.137) % 1) });
      h.hp = h.maxHp;
      h.destroyed = false;
    }
    expect(h.comp.radiator).toBeLessThan(1);
  });
  it('a holed radiator is repaired with the wrench, after the engine', () => {
    const b = newBuild('sedan', { seed: 1 });
    const h = toHealth(b);
    h.comp.radiator = 0.2;
    const job = planRepair(h, newStocks({ parts: 5, scrap: 5 }));
    expect(job?.kind).toBe('radiator');
    applyRepair(h, job!);
    expect(h.comp.radiator).toBeGreaterThan(0.7);
    h.comp.engine = 0.3;
    expect(planRepair(h, newStocks({ parts: 5, scrap: 5 }))?.kind).toBe('engine');
  });
  it('a service renews the radiator', () => {
    const b = newBuild('sedan', { seed: 1 });
    b.comp.radiator = 0.2;
    serviceBuild(b);
    expect(b.comp.radiator).toBe(1);
  });
});

describe('engine temperature', () => {
  const run = (heat: number, cooling: number, o: { load?: number; speed?: number; radiator?: number; airflow?: number; secs?: number }) => {
    let T = 0.1;
    for (let t = 0; t < (o.secs ?? 120); t += 0.1) T = thermalStep(T, { heat, cooling, radiator: o.radiator ?? 1, airflow: o.airflow ?? 1, load: o.load ?? 0.6, speed: o.speed ?? 20, running: true }, 0.1);
    return T;
  };
  it('a V8 in a hatchback cooks on the factory radiator and runs cool on a race core', () => {
    const hatch = chassisDef('hatch');
    const st = effectiveStats(hatch, { engine: part('eng_v8') });
    const stock = run(st.heat, st.coolKw, { airflow: st.airflow, load: 0.7 });
    expect(stock).toBeGreaterThan(T_OVERHEAT);
    const race = effectiveStats(hatch, { engine: part('eng_v8'), cooling: part('rad_race_l') });
    const cool = run(race.heat, race.coolKw, { airflow: race.airflow, load: 0.7 });
    expect(cool).toBeLessThan(0.8);
  });
  it('an unmodified vehicle holds a comfortable temperature', () => {
    const st = effectiveStats(chassisDef('sedan'), {});
    expect(run(st.heat, st.coolKw, { load: 1, speed: 33 })).toBeLessThan(0.5);
  });
  it('standing still is hotter than moving, a worn radiator is hotter, a crowded bay is hotter', () => {
    const base = { load: 0.8 };
    const moving = run(100, 120, { ...base, speed: 25 });
    expect(run(100, 120, { ...base, speed: 0 })).toBeGreaterThan(moving);
    expect(run(100, 120, { ...base, speed: 25, radiator: 0.3 })).toBeGreaterThan(moving);
    expect(run(100, 120, { ...base, speed: 25, airflow: 0.66 })).toBeGreaterThan(moving);
  });
  it('a dead radiator cannot be rescued by speed', () => {
    expect(run(100, 120, { load: 0.9, speed: 30, radiator: 0, airflow: 0.66 })).toBeGreaterThan(T_OVERHEAT);
  });
  it('an engine that is off cools toward cold, more slowly than it heated', () => {
    let T = 1.1;
    for (let t = 0; t < 30; t += 0.1) T = thermalStep(T, { heat: 100, cooling: 100, radiator: 1, airflow: 1, load: 0, speed: 0, running: false }, 0.1);
    expect(T).toBeLessThan(1.1);
    expect(T).toBeGreaterThan(0.3);
  });
  it('power fades and the engine wears only above the redline', () => {
    expect(overheatPower(0.9)).toBe(1);
    expect(overheatPower(T_OVERHEAT)).toBe(1);
    expect(overheatPower(T_CRITICAL)).toBeCloseTo(0.45);
    expect(overheatWear(0.95, 1)).toBe(0);
    expect(overheatWear(T_CRITICAL, 10)).toBeGreaterThan(overheatWear(1.05, 10));
  });
  it('states and steady temperatures are ordered', () => {
    expect(tempState(0.05)).toBe('cold');
    expect(tempState(0.4)).toBe('ok');
    expect(tempState(0.8)).toBe('warm');
    expect(tempState(0.95)).toBe('hot');
    expect(tempState(1.1)).toBe('overheating');
    expect(steadyTemp({ heat: 100, cooling: 100, radiator: 1, airflow: 1, load: 1, speed: 30, running: true })).toBeLessThan(
      steadyTemp({ heat: 200, cooling: 100, radiator: 1, airflow: 1, load: 1, speed: 30, running: true }),
    );
  });
  it('the forecast warns before the bolts go in', () => {
    const d = chassisDef('hatch');
    const bad = effectiveStats(d, { engine: part('eng_v8') });
    expect(thermalForecast(bad.heat, bad.coolKw, bad.airflow, 45).verdict).toBe('overheats');
    const good = effectiveStats(d, { engine: part('eng_v8'), cooling: part('rad_desert') });
    expect(thermalForecast(good.heat, good.coolKw, good.airflow, 45).verdict).toBe('cool');
  });
  it('every radiator is stronger than the factory core of a small car, and the ladder climbs', () => {
    const ps = RADIATORS.filter((r) => !r.stock).sort((a, b) => (a.cooling ?? 0) - (b.cooling ?? 0));
    expect(ps[0].cooling!).toBeGreaterThan(partDef('rad_hatch').cooling!);
    for (let i = 1; i < ps.length; i++) expect(ps[i].mk).toBeGreaterThanOrEqual(ps[i - 1].mk);
  });
});

describe('found cars and salvage', () => {
  it('some drivable world cars are hot rods with a bigger engine and a tank that matches it', () => {
    let rods = 0;
    const n = 1500;
    for (let s = 1; s <= n; s++) {
      const r = rollCar(s * 977, { biome: 'wasteland', status: 'intact' });
      if (r.build.fit.engine) {
        rods++;
        expect(partDef(r.build.fit.engine.id).mk).toBeGreaterThanOrEqual(1);
        expect(r.build.tank).toBe(partDef(r.build.fit.engine.id).engine!.fuel);
      }
    }
    expect(rods / n).toBeGreaterThan(HOT_ROD * 0.5);
    expect(rods / n).toBeLessThan(HOT_ROD * 3);
  });
  it('stripping a car often gives its own engine, which can go into something else', () => {
    const ctx = { seed: 1, kind: 'car' as const, chassis: 'van', burnt: false };
    let own = 0;
    const n = 400;
    for (let s = 1; s <= n; s++) if (salvageLoot(1, { ...ctx, seed: s * 31 }).items.some((i) => i.id === 'eng_d30')) own++;
    // Most found cars still have their own engine in them; donors and hulks lost it.
    expect(own / n).toBeGreaterThan(0.45);
    expect(own / n).toBeLessThan(0.95);
  });
  it('the engine stage is the same every time for the same car', () => {
    const ctx = { seed: 4242, kind: 'car' as const, chassis: 'pickup', burnt: false };
    // Items get fresh uids each time; everything else is fixed by the seed.
    const plain = (stage: number) => {
      const l = salvageLoot(stage, ctx);
      return { ...l, items: l.items.map(({ uid, ...rest }) => rest) };
    };
    expect(plain(1)).toEqual(plain(1));
    expect(plain(2)).toEqual(plain(2));
  });
  it('a lost convoy vehicle gives back its radiator, battered', () => {
    const b = newBuild('sedan', { seed: 1 });
    installPart(b, part('rad_race_m', 1));
    let got = false;
    for (let s = 1; s < 60 && !got; s++) {
      const loot = salvageLoot(2, { seed: s, kind: 'convoy', chassis: 'sedan', burnt: false, fit: b.fit, comp: b.comp });
      const rad = loot.items.find((i) => i.id === 'rad_race_m');
      if (rad) {
        got = true;
        expect(rad.cond).toBeLessThanOrEqual(0.45);
      }
    }
    expect(got).toBe(true);
  });
});

describe('saves', () => {
  it('a build from before engines had a fuel gets the right tank and a good radiator', () => {
    const c = new Campaign(undefined, false);
    c.garage.push(newBuild('van', { seed: 3 }));
    const raw = JSON.parse(JSON.stringify(c.serialize()));
    for (const b of raw.garage) {
      delete b.tank;
      delete b.comp.radiator;
    }
    delete raw.items.diesel;
    const back = Campaign.deserialize(raw);
    const van = back.garage.find((b) => b.chassis === 'van')!;
    expect(van.tank).toBe('diesel');
    expect(van.comp.radiator).toBe(1);
    expect(back.items.diesel).toBe(0);
    const moped = back.garage.find((b) => b.chassis === 'moped')!;
    expect(moped.tank).toBe('petrol');
  });
  it('a swapped engine, a stripped bay and a diesel reserve survive a save', () => {
    const c = new Campaign(undefined, false);
    const b = c.garage[0];
    installPart(b, part('eng_d4', 0.8));
    removePart(b, 'cooling');
    c.items.diesel = 7.5;
    const back = Campaign.deserialize(JSON.parse(JSON.stringify(c.serialize())));
    const nb = back.garage[0];
    expect(nb.fit.engine?.id).toBe('eng_d4');
    expect(nb.fit.cooling?.id).toBe('rad_none');
    expect(statsOf(nb).coolKw).toBe(0);
    expect(back.items.diesel).toBe(7.5);
    expect(engineEffects(chassisDef(nb.chassis), nb.fit).fuel).toBe('diesel');
  });
});
