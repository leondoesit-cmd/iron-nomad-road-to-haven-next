import { describe, expect, it } from 'vitest';
import { chassisDef, partDef } from '../src/data';
import { Campaign, OIL_RESERVE_MAX } from '../src/game/campaign';
import { applyHit, newHealth, performance } from '../src/sim/damage';
import { conditionSummary, freshComp, fromHealth, needsService, newBuild, serviceBuild, serviceCost, toHealth } from '../src/sim/garage';
import { OIL_CAN, OIL_CRITICAL, OIL_LOW, OIL_PER_KM, oilBurn, oilLabel, oilPower, oilState, oilWear, pourOil } from '../src/sim/oil';
import { applyRepair, planRepair } from '../src/sim/repair';
import { newStocks } from '../src/sim/resources';
import { rollCar } from '../src/sim/cars';
import { SALVAGE_STAGES, lootText, salvageLoot } from '../src/sim/salvage';
import { FUEL_CAN, carriedName, carrySlow, liftSecs, planFit, planStow, pourFuel, type FitTarget } from '../src/sim/carry';
import { newPart } from '../src/sim/parts';

describe('engine oil', () => {
  it('a full sump is good for about fourteen kilometres', () => {
    expect(1 / OIL_PER_KM).toBeGreaterThan(12);
    expect(1 / OIL_PER_KM).toBeLessThan(16);
    expect(oilBurn(1000, 0, 1)).toBeCloseTo(OIL_PER_KM, 5);
  });

  it('burns faster with a worn engine and with the Drain slider up', () => {
    expect(oilBurn(1000, 0, 0.2)).toBeGreaterThan(oilBurn(1000, 0, 1) * 1.5);
    expect(oilBurn(1000, 0, 1, 2)).toBeCloseTo(oilBurn(1000, 0, 1) * 2, 5);
    expect(oilBurn(0, 60, 1)).toBeGreaterThan(0); // idling costs a little
  });

  it('a leg of driving leaves enough to finish it, and a can covers about two', () => {
    const leg = oilBurn(3500, 0, 1);
    expect(leg).toBeLessThan(0.3);
    expect(OIL_CAN / leg).toBeGreaterThan(1.5);
  });

  it('power only suffers below the low mark, and never by more than 30%', () => {
    expect(oilPower(1)).toBe(1);
    expect(oilPower(OIL_LOW)).toBe(1);
    expect(oilPower(OIL_LOW / 2)).toBeLessThan(1);
    expect(oilPower(0)).toBeCloseTo(0.7, 5);
  });

  it('wear only starts when it is nearly gone, and is worst when bone dry', () => {
    expect(oilWear(OIL_CRITICAL, 1)).toBe(0);
    expect(oilWear(0.5, 10)).toBe(0);
    expect(oilWear(0, 1)).toBeGreaterThan(oilWear(OIL_CRITICAL * 0.8, 1));
    expect(oilWear(0, 1)).toBeGreaterThan(0.005);
  });

  it('states and labels agree', () => {
    expect(oilState(0.8)).toBe('ok');
    expect(oilState(0.2)).toBe('low');
    expect(oilState(0.05)).toBe('critical');
    expect(oilLabel(0.05)).toBe('oil dry');
    expect(oilLabel(0.9)).toBe('oil ok');
  });

  it('pouring fills the sump and hands back what did not fit', () => {
    expect(pourOil(0.2, OIL_CAN)).toMatchObject({ used: 0.5, left: 0 });
    expect(pourOil(0.2, OIL_CAN).oil).toBeCloseTo(0.7, 5);
    const full = pourOil(0.9, OIL_CAN);
    expect(full.oil).toBe(1);
    expect(full.used).toBeCloseTo(0.1, 5);
    expect(full.left).toBeCloseTo(0.4, 5);
    expect(pourOil(1, OIL_CAN).used).toBe(0);
  });
});

describe('oil in the vehicle model', () => {
  it('every new build and health starts with a full sump, and it round-trips', () => {
    const b = newBuild('sedan');
    expect(b.comp.oil).toBe(1);
    expect(newHealth(100, 0, 4).comp.oil).toBe(1);
    const h = toHealth(b);
    h.comp.oil = 0.33;
    fromHealth(b, h, 0.5);
    expect(b.comp.oil).toBeCloseTo(0.33, 5);
    expect(toHealth(b).comp.oil).toBeCloseTo(0.33, 5);
  });

  it('low oil costs power', () => {
    const h = newHealth(100, 0, 4);
    const p0 = performance(h).power;
    h.comp.oil = 0;
    expect(performance(h).power).toBeLessThan(p0 * 0.75);
  });

  it('a shot that holes the engine bleeds oil', () => {
    const h = newHealth(100, 0, 4);
    let n = 0;
    // Force the engine branch: roll() below the chance, then below 0.3.
    const roll = () => (n++ % 2 === 0 ? 0 : 0.1);
    const out = applyHit(h, 60, { facing: 'front', roll });
    expect(out.events.some((e) => e.kind === 'engine')).toBe(true);
    expect(h.comp.oil).toBeLessThan(1);
  });

  it('a service is an oil change, and an empty sump counts as needing one', () => {
    const b = newBuild('hatch');
    expect(needsService(b)).toBe(false);
    const free = serviceCost(b);
    b.comp.oil = 0.1;
    expect(needsService(b)).toBe(true);
    expect(serviceCost(b).scrap ?? 0).toBeGreaterThan(free.scrap ?? 0);
    serviceBuild(b);
    expect(b.comp.oil).toBe(1);
  });

  it('shows up in the condition line', () => {
    const b = newBuild('hatch');
    b.comp.oil = 0.2;
    expect(conditionSummary(b)).toMatch(/low on oil/);
    b.comp.oil = 0.02;
    expect(conditionSummary(b)).toMatch(/oil dry/);
  });

  it('rebuilding the engine puts fresh oil in it', () => {
    const h = newHealth(100, 0, 4);
    h.comp.engine = 0.02;
    h.comp.oil = 0;
    const job = planRepair(h, newStocks({ parts: 9, scrap: 9 }))!;
    expect(job.kind).toBe('engine');
    applyRepair(h, job);
    expect(h.comp.oil).toBeGreaterThanOrEqual(0.6);
  });

  it('found cars come with a sump of their own: hulks dry, runners part-full, and the roll is stable', () => {
    for (let s = 1; s <= 60; s++) {
      const r = rollCar(s * 17, { biome: 'wasteland' });
      expect(r.build.comp.oil).toBeGreaterThanOrEqual(0);
      expect(r.build.comp.oil).toBeLessThanOrEqual(0.8);
      if (r.status === 'hulk') expect(r.build.comp.oil).toBe(0);
      expect(rollCar(s * 17, { biome: 'wasteland' }).build.comp.oil).toBe(r.build.comp.oil);
    }
    const rough = [...Array(80).keys()].map((s) => rollCar(s * 31 + 5, { biome: 'wasteland', status: 'rough' }).build.comp.oil);
    expect(Math.min(...rough)).toBeLessThan(0.15);
  });

  it('pulling an engine drains the sump into a can; a burnt-out car has none', () => {
    const car = newBuild('sedan', { seed: 5 });
    car.comp.oil = 0.7;
    const ctx = { seed: 123, kind: 'car' as const, chassis: 'sedan', burnt: false, build: car };
    const l = salvageLoot(1, ctx);
    expect(l.oil).toBeGreaterThanOrEqual(0.2);
    expect(l.oil).toBeLessThanOrEqual(0.5);
    expect(salvageLoot(1, ctx).oil).toBe(l.oil);
    expect(salvageLoot(1, { ...ctx, burnt: true }).oil).toBe(0);
    for (const stage of [0, 2, 3]) expect(salvageLoot(stage, ctx).oil).toBe(0);
    expect(lootText(l, (it) => it.id)).toMatch(/oil can/);
    expect(SALVAGE_STAGES).toHaveLength(4);
  });
});

describe('oil and carrying in the campaign', () => {
  it('the convoy starts with a little oil, and stows more up to a limit', () => {
    const c = new Campaign();
    expect(c.items.oil).toBeGreaterThan(0);
    c.items.oil = 0;
    expect(c.stowOil(OIL_CAN)).toBe(OIL_CAN);
    c.items.oil = OIL_RESERVE_MAX - 0.2;
    expect(c.stowOil(OIL_CAN)).toBeCloseTo(0.2, 5);
    expect(c.items.oil).toBeCloseTo(OIL_RESERVE_MAX, 5);
    expect(c.stowOil(OIL_CAN)).toBe(0);
  });

  it('stowing a part respects the trunk; fuel just adds to the reserve', () => {
    const c = new Campaign();
    const cap = c.inventoryCap;
    expect(c.inventoryRoom).toBe(cap);
    for (let i = 0; i < cap; i++) expect(c.stowPart(newPart('arm_sheet'))).toBe(true);
    expect(c.inventoryRoom).toBe(0);
    expect(c.stowPart(newPart('arm_sheet'))).toBe(false);
    expect(c.inventory.length).toBe(cap);
    const f = c.stocks.fuel;
    c.stowFuel(FUEL_CAN);
    expect(c.stocks.fuel).toBeCloseTo(f + FUEL_CAN, 5);
  });

  it('a save made before oil existed loads with full sumps and the default reserve', () => {
    const c = new Campaign();
    const blob = JSON.parse(JSON.stringify(c.serialize()));
    delete blob.items.oil;
    for (const b of blob.garage) delete b.comp.oil;
    const back = Campaign.deserialize(blob);
    expect(back.items.oil).toBeGreaterThan(0);
    expect(back.buildOf(0).comp.oil).toBe(1);
  });

  it('oil survives a save', () => {
    const c = new Campaign();
    c.items.oil = 2.5;
    c.buildOf(0).comp.oil = 0.4;
    const back = Campaign.deserialize(JSON.parse(JSON.stringify(c.serialize())));
    expect(back.items.oil).toBe(2.5);
    expect(back.buildOf(0).comp.oil).toBe(0.4);
  });
});

describe('planning a fit or a stow', () => {
  const target = (chassis: string, o: Partial<FitTarget> = {}): FitTarget => ({
    def: chassisDef(chassis),
    fitted: () => undefined,
    fuel: 5,
    tankMax: 10,
    oil: 0.5,
    ...o,
  });

  it('a part fits a slot the chassis has, and says what it replaces', () => {
    const p = { kind: 'part' as const, item: newPart('eng_v6') };
    expect(planFit(p, target('sedan')).label).toMatch(/Bolt on Tuned V6/);
    const swap = planFit(p, target('sedan', { fitted: (s) => (s === 'engine' ? newPart('eng_i4') : undefined) }));
    expect(swap.label).toMatch(/Swap in Tuned V6 \(replaces Rebuilt Inline-4\)/);
    const down = planFit({ kind: 'part', item: newPart('eng_i4') }, target('sedan', { fitted: (s) => (s === 'engine' ? newPart('eng_v6') : undefined) }));
    expect(down.label).toMatch(/downgrade/);
  });

  it('a part with no mount on the chassis is refused', () => {
    const plan = planFit({ kind: 'part', item: newPart('rf_rack') }, target('moped'));
    expect(plan.ok).toBe(false);
    expect(plan.label).toMatch(/no roof mount/);
  });

  it('fuel and oil are refused when there is no room, and say how much goes in', () => {
    expect(planFit({ kind: 'fuel', amount: FUEL_CAN }, target('sedan', { fuel: 10 })).ok).toBe(false);
    const f = planFit({ kind: 'fuel', amount: FUEL_CAN }, target('sedan', { fuel: 8 }));
    expect(f.ok).toBe(true);
    expect(f.label).toMatch(/\+2\.0 FU/);
    expect(planFit({ kind: 'oil', amount: OIL_CAN }, target('sedan', { oil: 1 })).ok).toBe(false);
    expect(planFit({ kind: 'oil', amount: OIL_CAN }, target('sedan', { oil: 0.2 })).label).toMatch(/70%/);
  });

  it('stowing: parts need a slot, fuel always fits, oil needs reserve room', () => {
    const part = { kind: 'part' as const, item: newPart('eng_v6') };
    expect(planStow(part, { parts: 3, oil: 1 }).ok).toBe(true);
    expect(planStow(part, { parts: 0, oil: 1 })).toMatchObject({ ok: false, label: 'Trunk is full' });
    expect(planStow({ kind: 'fuel', amount: 5 }, { parts: 0, oil: 0 }).ok).toBe(true);
    expect(planStow({ kind: 'oil', amount: 0.5 }, { parts: 5, oil: 0 }).ok).toBe(false);
  });

  it('pouring fuel is capped by the tank', () => {
    expect(pourFuel(8, 10, 5)).toMatchObject({ used: 2, fuel: 10, left: 3 });
    expect(pourFuel(0, 10, 5)).toMatchObject({ used: 5, left: 0 });
    expect(pourFuel(10, 10, 5).used).toBe(0);
  });

  it('heavy things slow you more, and lifting an engine takes longer than a can', () => {
    const engine = { kind: 'part' as const, item: newPart('eng_v8') };
    const oil = { kind: 'oil' as const, amount: OIL_CAN };
    expect(carrySlow(engine)).toBeLessThan(carrySlow(oil));
    expect(carrySlow(engine)).toBeGreaterThan(0.5);
    expect(liftSecs(engine)).toBeGreaterThan(liftSecs(oil));
    expect(partDef('eng_v8').slot).toBe('engine');
  });

  it('names read well', () => {
    expect(carriedName({ kind: 'oil', amount: OIL_CAN })).toBe('Oil can');
    expect(carriedName({ kind: 'oil', amount: 0.2 })).toMatch(/40% full/);
    expect(carriedName({ kind: 'fuel', amount: 3.25 })).toMatch(/3\.3 FU/);
    expect(carriedName({ kind: 'part', item: newPart('eng_v6') })).toBe('Tuned V6');
  });

  it('freshComp has oil for every chassis', () => {
    for (const id of ['moped', 'quad', 'buggy', 'hatch', 'van']) expect(freshComp(chassisDef(id)).oil).toBe(1);
  });
});
