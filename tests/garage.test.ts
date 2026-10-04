import { describe, expect, it } from 'vitest';
import { CHASSIS, PARTS, VEHICLES, chassisDef, partDef, validateData } from '../src/data';
import { Rng } from '../src/core/rng';
import {
  effectiveStats,
  newPart,
  rollPart,
  scrapValue,
  terrainDrag,
  terrainGrip,
  weaponKind,
  type PartItem,
} from '../src/sim/parts';
import {
  currentCond,
  dismantleYield,
  fromHealth,
  inventoryCap,
  installPart,
  needsService,
  newBuild,
  rebuildOnto,
  removePart,
  serviceBuild,
  serviceCost,
  toHealth,
} from '../src/sim/garage';
import { applyRepair, listFaults, planRepair } from '../src/sim/repair';
import { SALVAGE_STAGES, salvageLoot, stripBuild } from '../src/sim/salvage';
import { isMissing, pickChassis, rollCar } from '../src/sim/cars';
import { INTERIOR_SLOTS } from '../src/data';
const isCabinPart = (id: string) => INTERIOR_SLOTS.includes(partDef(id).slot);
import { applyHit } from '../src/sim/damage';
import { newStocks } from '../src/sim/resources';

const part = (id: string, cond = 1): PartItem => newPart(id, cond);

describe('catalogue', () => {
  it('passes data validation', () => {
    expect(validateData()).toEqual([]);
  });
  it('every chassis only lists slots that exist, and every part fits some chassis', () => {
    for (const d of Object.values(CHASSIS)) for (const s of d.slots ?? PARTS.slots) expect(PARTS.slots).toContain(s);
    for (const p of PARTS.parts) expect(Object.values(CHASSIS).some((d) => (d.slots ?? PARTS.slots).includes(p.slot))).toBe(true);
  });
  it('quality never lowers cost: every Mk n costs more than every Mk n-1 in its slot', () => {
    for (const slot of ['engine', 'cooling', 'wheels', 'armor', 'weapon', 'utility'] as const) {
      // Factory fittings are not for sale, so they sit outside the ladder.
      const ps = PARTS.parts.filter((p) => p.slot === slot && !p.stock);
      for (const mk of [2, 3]) {
        const lower = Math.max(...ps.filter((p) => p.mk === mk - 1).map((p) => p.cost.scrap ?? 0));
        const here = Math.min(...ps.filter((p) => p.mk === mk).map((p) => p.cost.scrap ?? 0));
        expect(here).toBeGreaterThan(lower);
      }
    }
  });
  it('has four found-car chassis and they are distinct from the tiers', () => {
    expect(VEHICLES.cars.map((c) => c.id).sort()).toEqual(['hatch', 'pickup', 'sedan', 'van']);
    expect(Object.keys(CHASSIS)).toHaveLength(VEHICLES.tiers.length + VEHICLES.cars.length);
  });
});

describe('stats from parts', () => {
  const sedan = chassisDef('sedan');
  it('a bare chassis has the stock numbers', () => {
    const s = effectiveStats(sedan, {});
    expect(s.forceMult).toBe(1);
    expect(s.armor).toBeCloseTo(sedan.armor);
    expect(s.tank).toBe(sedan.tank);
    expect(s.weapon).toBeNull();
  });
  it('parts add up', () => {
    const s = effectiveStats(sedan, { engine: part('eng_v8'), armor: part('arm_weld'), front: part('fr_bull') });
    // 260 kW against the sedan's 78 kW: a lot more shove, but with diminishing returns.
    expect(s.forceMult).toBeGreaterThan(2);
    expect(s.forceMult).toBeLessThanOrEqual(2.8);
    expect(s.armor).toBeCloseTo(sedan.armor + 0.1);
    expect(s.armorF).toBeCloseTo(0.08);
    expect(s.burnMult).toBeGreaterThan(1.2);
    expect(s.sigMult).toBeGreaterThan(1.1);
  });
  it('a weapon part grants a gun by the chassis mount, and boosts a native one', () => {
    expect(weaponKind(chassisDef('sedan'), { weapon: part('wpn_lmg') })).toBe('frontLMG');
    expect(weaponKind(chassisDef('pickup'), { weapon: part('wpn_lmg') })).toBe('bedMG');
    expect(weaponKind(chassisDef('moped'), { weapon: part('wpn_lmg') })).toBeNull();
    expect(weaponKind(chassisDef('quad'), {})).toBe('frontLMG');
    expect(weaponKind(chassisDef('sedan'), {})).toBeNull();
    expect(effectiveStats(chassisDef('quad'), { weapon: part('wpn_hmg') }).damageMult).toBeCloseTo(1.6);
  });
  it('off-road tyres shrink the sand penalty and a road car suffers more than a buggy', () => {
    const sedanSand = terrainGrip(0.6, effectiveStats(sedan, {}).offroad);
    const buggySand = terrainGrip(0.6, effectiveStats(chassisDef('buggy'), {}).offroad);
    // Tyres are one per wheel: crawlers on all four.
    const sedanMud = terrainGrip(0.6, effectiveStats(sedan, {}, [part('whl_bl'), part('whl_bl'), part('whl_bl'), part('whl_bl')]).offroad);
    expect(sedanSand).toBeLessThan(buggySand);
    expect(sedanMud).toBeGreaterThan(sedanSand);
    // The baseline chassis is unchanged by the model, so existing handling holds.
    expect(buggySand).toBeCloseTo(0.6, 5);
    expect(terrainDrag(0.35, 0.45)).toBeCloseTo(0.35, 5);
    expect(terrainGrip(1.1, 0.1)).toBeCloseTo(1.1, 5);
  });
});

describe('fitting parts', () => {
  it('installing sets the component to the part condition and returns the old part worn', () => {
    const b = newBuild('sedan', { seed: 1 });
    expect(installPart(b, part('eng_i4', 0.7)).ok).toBe(true);
    expect(b.comp.engine).toBeCloseTo(0.7);
    b.comp.engine = 0.3; // driven hard
    const res = installPart(b, part('eng_v6', 0.9));
    expect(res.removed?.id).toBe('eng_i4');
    expect(res.removed?.cond).toBeCloseTo(0.3);
    expect(b.comp.engine).toBeCloseTo(0.9);
  });
  it('a dead tyre set leaves every wheel flat; a good set fixes them all', () => {
    const b = newBuild('sedan', { seed: 1 });
    installPart(b, part('whl_mt', 0));
    expect(b.comp.tires.every((t) => t === 0)).toBe(true);
    installPart(b, part('whl_mt', 0.8));
    expect(b.comp.tires.every((t) => Math.abs(t - 0.8) < 1e-9)).toBe(true);
  });
  it('refuses a slot the chassis does not have', () => {
    const moped = newBuild('moped', { seed: 1 });
    const r = installPart(moped, part('fr_bull'));
    expect(r.ok).toBe(false);
    expect(moped.fit.front).toBeUndefined();
  });
  it('pulling a part leaves worn stock: removing a dead part cannot heal the vehicle', () => {
    const b = newBuild('sedan', { seed: 1 });
    installPart(b, part('eng_v6', 1));
    b.comp.engine = 0;
    const out = removePart(b, 'engine')!;
    expect(out.cond).toBe(0);
    expect(b.comp.engine).toBe(0);
    installPart(b, part('eng_v6', 1));
    const out2 = removePart(b, 'engine')!;
    expect(out2.cond).toBe(1);
    expect(b.comp.engine).toBeCloseTo(PARTS.stockCondition);
  });
  it('rebuilding onto a smaller chassis spills the parts that no longer fit', () => {
    const b = newBuild('buggy', { seed: 1 });
    installPart(b, part('fr_bull'));
    installPart(b, part('eng_i4'));
    const spill = rebuildOnto(b, 'moped');
    expect(spill.map((p) => p.id)).toEqual(['fr_bull']);
    expect(b.fit.engine?.id).toBe('eng_i4');
    expect(b.chassis).toBe('moped');
    expect(b.comp.tires).toHaveLength(2);
  });
  it('cargo space feeds the shared inventory', () => {
    const a = newBuild('van', { seed: 1 });
    const c = newBuild('moped', { seed: 2 });
    expect(inventoryCap([a, c])).toBeGreaterThan(inventoryCap([c]));
    installPart(a, part('rr_box'));
    expect(inventoryCap([a])).toBeGreaterThan(16 + chassisDef('van').cargo);
  });
});

describe('health bridge', () => {
  it('round-trips condition through the live health object', () => {
    const b = newBuild('pickup', { seed: 3 });
    installPart(b, part('arm_weld', 0.8));
    installPart(b, part('sd_plate'));
    b.hp = 0.6;
    b.comp.tires[2] = 0;
    b.comp.leaking = true;
    const h = toHealth(b);
    expect(h.maxHp).toBeCloseTo(chassisDef('pickup').hp * 1.05);
    expect(h.hp / h.maxHp).toBeCloseTo(0.6);
    expect(h.comp.plates).toBeCloseTo(0.8);
    expect(h.leaking).toBe(true);
    expect(h.armorBonus?.side).toBeCloseTo(0.12);
    h.hp = h.maxHp * 0.3;
    h.comp.engine = 0.2;
    const back = newBuild('pickup', { seed: 3 });
    fromHealth(back, h, 0.4);
    expect(back.hp).toBeCloseTo(0.3);
    expect(back.comp.engine).toBeCloseTo(0.2);
    expect(back.comp.tires[2]).toBe(0);
    expect(back.fuel).toBeCloseTo(0.4);
  });
  it('side armour parts only protect against hits from that side', () => {
    const b = newBuild('sedan', { seed: 1 });
    const bare = toHealth(b);
    installPart(b, part('sd_plate'));
    const plated = toHealth(b);
    const roll = () => 0.99;
    const side = applyHit(plated, 40, { facing: 'side', roll }).dealt;
    const sideBare = applyHit(bare, 40, { facing: 'side', roll }).dealt;
    const frontPlated = applyHit(toHealth(b), 40, { facing: 'front', roll }).dealt;
    const frontBare = applyHit(toHealth(newBuild('sedan', { seed: 1 })), 40, { facing: 'front', roll }).dealt;
    expect(side).toBeLessThan(sideBare);
    expect(frontPlated).toBeCloseTo(frontBare);
  });
});

describe('field repair', () => {
  const rich = newStocks({ scrap: 50, parts: 50 });
  it('goes fire, leak, tyre, engine, mount, hull in that order', () => {
    const b = newBuild('sedan', { seed: 1 });
    const h = toHealth(b);
    h.hp = h.maxHp * 0.4;
    h.comp.engine = 0.2;
    h.comp.tires[1] = 0;
    h.leaking = true;
    h.burning = true;
    const order: string[] = [];
    for (let i = 0; i < 20; i++) {
      const job = planRepair(h, rich, { weapon: true });
      if (!job) break;
      order.push(job.kind);
      applyRepair(h, job);
    }
    expect(order.slice(0, 5)).toEqual(['fire', 'leak', 'tire', 'engine', 'engine']);
    expect(order[order.length - 1]).toBe('body');
    expect(planRepair(h, rich)).toBeNull();
    expect(h.hp).toBeCloseTo(h.maxHp, 0);
  });
  it('costs real stock and says what is missing', () => {
    const h = toHealth(newBuild('sedan', { seed: 1 }));
    h.comp.engine = 0.1;
    const nothing = planRepair(h, newStocks())!;
    expect(nothing.kind).toBe('engine');
    expect(nothing.ok).toBe(false);
    expect(nothing.why).toMatch(/Parts/);
    expect(planRepair(h, newStocks({ parts: 3 }))!.ok).toBe(true);
  });
  it('falls back to improvised scrap work so nobody is stranded without parts', () => {
    const h = toHealth(newBuild('sedan', { seed: 1 }));
    h.comp.engine = 0.1;
    const good = planRepair(h, newStocks({ scrap: 20, parts: 3 }))!;
    const improvised = planRepair(h, newStocks({ scrap: 20 }))!;
    expect(good.cost).toEqual({ parts: 3 });
    expect(improvised.ok).toBe(true);
    expect(improvised.cost).toEqual({ scrap: 9 });
    expect(improvised.label).toMatch(/improvised/);
    expect(improvised.secs).toBeGreaterThan(good.secs);
  });
  it('a spare wheel makes tyre swaps free and quicker', () => {
    const h = toHealth(newBuild('sedan', { seed: 1 }));
    h.comp.tires[0] = 0;
    const plain = planRepair(h, rich)!;
    const spare = planRepair(h, rich, { spare: true })!;
    expect(plain.cost.scrap).toBe(2);
    expect(spare.cost.scrap ?? 0).toBe(0);
    expect(spare.secs).toBeLessThan(plain.secs);
  });
  it('a destroyed vehicle cannot be repaired', () => {
    const h = toHealth(newBuild('sedan', { seed: 1 }));
    h.destroyed = true;
    expect(planRepair(h, rich)).toBeNull();
  });
  it('lists faults in plain words', () => {
    const h = toHealth(newBuild('sedan', { seed: 1 }));
    expect(listFaults(h)).toEqual([]);
    h.comp.tires[0] = 0;
    h.comp.tires[1] = 0;
    h.comp.engine = 0;
    expect(listFaults(h)).toEqual(['2 flat tyres', 'engine dead']);
  });
});

describe('servicing and dismantling', () => {
  it('a damaged build has a price, a full service clears it', () => {
    const b = newBuild('sedan', { seed: 1 });
    expect(needsService(b)).toBe(false);
    expect(serviceCost(b)).toEqual({});
    b.hp = 0.5;
    b.comp.engine = 0.2;
    b.comp.tires[0] = 0;
    expect(needsService(b)).toBe(true);
    const c = serviceCost(b);
    expect(c.scrap).toBeGreaterThan(0);
    expect(c.parts).toBeGreaterThan(0);
    serviceBuild(b);
    expect(needsService(b)).toBe(false);
  });
  it('dismantling returns fitted parts with their wear, the factory radiator, plus raw materials', () => {
    const b = newBuild('sedan', { seed: 1 });
    installPart(b, part('eng_v6', 1));
    b.comp.engine = 0.5;
    const y = dismantleYield(b);
    // Everything on it comes apart: engine, radiator, gearbox, exhaust, springs, brakes, bonnet, both doors and four tyres.
    expect(y.items.map((i) => i.id).sort()).toEqual(['brk_sedan', 'door_std', 'door_std', 'eng_v6', 'exh_sedan', 'gbx_sedan', 'hood_std', 'rad_sedan', 'sus_sedan', 'tyre_sedan', 'tyre_sedan', 'tyre_sedan', 'tyre_sedan']);
    expect(y.items.find((i) => i.id === 'eng_v6')!.cond).toBeCloseTo(0.5);
    expect((y.stocks.scrap ?? 0) + (y.stocks.parts ?? 0)).toBeGreaterThan(5);
  });
  it('currentCond reads the live component for worn slots and 1 for the rest', () => {
    const b = newBuild('sedan', { seed: 1 });
    b.comp.plates = 0.4;
    expect(currentCond(b, 'armor')).toBeCloseTo(0.4);
    expect(currentCond(b, 'front')).toBe(1);
  });
});

describe('salvage', () => {
  const ctx = { seed: 777, kind: 'car' as const, chassis: 'sedan', burnt: false };
  it('is fixed by the seed so a reloaded car cannot be rerolled', () => {
    for (let i = 0; i < SALVAGE_STAGES.length; i++) {
      const a = salvageLoot(i, ctx);
      const b = salvageLoot(i, ctx);
      expect(a.items.map((p) => p.id)).toEqual(b.items.map((p) => p.id));
      expect(a.goods).toEqual(b.goods);
    }
  });
  it('hands over only concrete things: named parts, cans and tins, never abstract Scrap, Parts or Tech', () => {
    for (let s = 1; s <= 60; s++) {
      for (let stage = 0; stage < SALVAGE_STAGES.length; stage++) {
        const l = salvageLoot(stage, { ...ctx, seed: s * 31 });
        expect(Object.keys(l).sort()).not.toContain('stocks');
        for (const it of l.items) expect(partDef(it.id).name.length).toBeGreaterThan(0);
        for (const g of l.goods) expect(['fuel', 'oil', 'water', 'rations', 'medicine', 'medkit', 'bandage', 'ammo', 'part', 'paint']).toContain(g.kind);
      }
    }
  });
  it('takes what is really on the car: the stage pulls the parts that are fitted, and a missing part gives nothing', () => {
    for (let s = 1; s < 80; s++) {
      const seed = s * 31;
      const car = rollCar(seed, { biome: 'wasteland', chassis: 'sedan' }).build;
      const c = { ...ctx, seed, build: car };
      const tyres = car.tyres.filter((t, i) => !t || !partDef(t.id).empty).length;
      expect(salvageLoot(0, c).items).toHaveLength(tyres);
      for (const it of salvageLoot(0, c).items) expect(partDef(it.id).slot).toBe('wheels');
      const eng = salvageLoot(1, c).items.filter((p) => partDef(p.id).slot === 'engine');
      expect(eng.length).toBe(isMissing(car, 'engine') ? 0 : 1);
      // Stripping leaves the mounts bare: a second pass finds nothing.
      for (const stage of [0, 1, 2, 3]) stripBuild(stage, car);
      for (const stage of [0, 1, 2]) expect(salvageLoot(stage, { ...c, build: car }).items).toEqual([]);
      // Only a spare in the boot can still be a cabin part: the mounts are bare.
      expect(salvageLoot(3, { ...c, build: car }).items.filter((p) => isCabinPart(p.id)).length).toBeLessThanOrEqual(1);
    }
  });
  it('burnt hulks give worn parts and often nothing in the trunk', () => {
    let worn = 0;
    let withEngine = 0;
    let empty = 0;
    for (let s = 1; s < 100; s++) {
      const c = { ...ctx, seed: s * 17, burnt: true, build: rollCar(s * 17, { biome: 'wasteland', chassis: 'sedan', status: 'hulk' }).build };
      const eng = salvageLoot(1, c).items.find((p) => partDef(p.id).slot === 'engine');
      if (eng) {
        withEngine++;
        if (eng.cond < 0.6) worn++;
      }
      const t = salvageLoot(3, c);
      if (!t.goods.length && !t.items.filter((p) => !isCabinPart(p.id)).length) empty++;
    }
    expect(worn).toBe(withEngine);
    expect(withEngine).toBeGreaterThan(60);
    expect(empty).toBeGreaterThan(40);
    expect(empty).toBeLessThan(90);
  });
  it('raiders carry better kit than family cars', () => {
    const avg = (kind: 'car' | 'raider') => {
      let t = 0;
      // The quality of what was found, not of the factory fittings that come out of any car.
      for (let s = 1; s <= 300; s++) for (let st = 0; st < 3; st++) t += salvageLoot(st, { ...ctx, kind, seed: s * 13 }).items.filter((p) => !partDef(p.id).stock).reduce((a, p) => a + partDef(p.id).mk, 0);
      return t / 300;
    };
    expect(avg('raider')).toBeGreaterThan(avg('car'));
  });
  it('a lost convoy vehicle gives back its own parts, battered', () => {
    const b = newBuild('sedan', { seed: 1 });
    installPart(b, part('eng_v8', 1));
    installPart(b, part('fr_blade', 1));
    const c = { ...ctx, kind: 'convoy' as const, fit: b.fit };
    expect(salvageLoot(1, c).items[0].id).toBe('eng_v8');
    expect(salvageLoot(1, c).items[0].cond).toBeLessThanOrEqual(0.45);
    expect(salvageLoot(2, c).items.map((p) => p.id)).toContain('fr_blade');
  });
  it('Mk3 salvage stays rare for ordinary cars', () => {
    let mk3 = 0;
    const n = 600;
    for (let s = 1; s <= n; s++) for (let st = 0; st < 3; st++) for (const it of salvageLoot(st, { ...ctx, seed: s * 7919 }).items) if (partDef(it.id).mk === 3) mk3++;
    expect(mk3 / (n * 3)).toBeLessThan(0.1);
  });
});

describe('world cars', () => {
  it('rolls deterministically from the seed', () => {
    const a = rollCar(4242, { biome: 'wasteland' });
    const b = rollCar(4242, { biome: 'wasteland' });
    expect(a.status).toBe(b.status);
    expect(a.build.chassis).toBe(b.build.chassis);
    expect(a.build.paint).toBe(b.build.paint);
    expect(a.build.comp).toEqual(b.build.comp);
  });
  it('mixes hulks, rough runners and sound cars, with most of them incomplete', () => {
    const count = { hulk: 0, rough: 0, intact: 0 };
    const grade: Record<string, number> = {};
    for (let s = 1; s <= 1000; s++) {
      const r = rollCar(s * 97, { biome: 'wasteland', reach: 0.6 });
      count[r.status]++;
      grade[r.grade] = (grade[r.grade] ?? 0) + 1;
    }
    expect(count.hulk).toBeGreaterThan(100);
    expect(count.rough).toBeGreaterThan(450);
    expect(count.intact).toBeGreaterThan(50);
    expect(count.intact).toBeLessThan(count.rough);
    // A minority are complete; the common car is an incomplete one.
    expect(grade.complete / 1000).toBeLessThan(0.2);
    expect(grade.incomplete).toBeGreaterThan(grade.complete * 2);
    expect(grade.incomplete).toBeGreaterThan(300);
  });
  it('a rough car has at least two real faults, and a hulk cannot be driven', () => {
    for (let s = 1; s <= 400; s++) {
      const r = rollCar(s * 31, { biome: 'city' });
      const b = r.build;
      if (r.grade === 'rough') {
        const faults = (b.comp.engine < 0.6 ? 1 : 0) + (b.comp.tires.some((t) => t === 0) ? 1 : 0) + (b.comp.leaking ? 1 : 0);
        expect(faults).toBeGreaterThanOrEqual(2);
      }
      if (r.status === 'hulk') {
        expect(b.hp).toBeLessThan(0.1);
        expect(b.fuel).toBe(0);
      }
      expect(b.comp.tires).toHaveLength(4);
    }
  });
  it('every found chassis turns up, hatchbacks more than vans', () => {
    const rng = new Rng(5);
    const n: Record<string, number> = {};
    for (let i = 0; i < 3000; i++) {
      const c = pickChassis(rng);
      n[c] = (n[c] ?? 0) + 1;
    }
    expect(Object.keys(n).sort()).toEqual(['hatch', 'pickup', 'sedan', 'van']);
    expect(n.hatch).toBeGreaterThan(n.van);
  });
  it('rolled parts come from the requested slot and are worth something', () => {
    const rng = new Rng(9);
    for (let i = 0; i < 80; i++) {
      const it = rollPart(rng, { slots: ['armor'], minMk: 2 });
      expect(partDef(it.id).slot).toBe('armor');
      expect(partDef(it.id).mk).toBeGreaterThanOrEqual(2);
      expect(scrapValue(it)).toBeGreaterThan(0);
    }
  });
});
