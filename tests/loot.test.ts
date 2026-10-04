import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { INTERIOR_SLOTS, chassisDef, legById, partDef } from '../src/data';
import { cabinGaps } from '../src/sim/cabin';
import { stripBuild } from '../src/sim/salvage';
import { Rng } from '../src/core/rng';
import { buildLayout, type LegLayoutImpl, type PickupSpawn } from '../src/world/layout';
import { ChunkSource } from '../src/world/chunkgen';
import { fitsSlot, furnRect, furnSlots, levelBase, slotWorld } from '../src/world/interiors';
import { generateDelve } from '../src/world/delve';
import { HOST_PROPS, HOST_REACH, LOOT_CONTEXTS, rollItem, rollLoot, specFoot, specSize, specTag, fits, type LootContext, type LootSpec } from '../src/sim/loot';
import { cabinMissing, fittedCore, isMissing, missingSlots, rollCar, bareWheels } from '../src/sim/cars';
import { salvageLoot } from '../src/sim/salvage';
import { checkTierUp, canAfford, spend } from '../src/sim/resources';
import { scrapValue, slotsOf } from '../src/sim/parts';
import { LEGS } from '../src/data';
import { Campaign } from '../src/game/campaign';
import { LegScene } from '../src/game/legScene';
import { fakeServices, run } from './helpers/sim';

vi.setConfig({ testTimeout: 120000 });

beforeAll(async () => {
  await initPhysics();
});

const strip = (l: LootSpec[]) => JSON.stringify(l);

describe('loot contexts', () => {
  it('rolls the same things for the same seed, and every context has something to give', () => {
    for (const c of LOOT_CONTEXTS) {
      let any = 0;
      for (let s = 1; s <= 40; s++) {
        const a = rollLoot(c, s * 977, 1, { progress: 0.4 });
        expect(strip(a)).toBe(strip(rollLoot(c, s * 977, 1, { progress: 0.4 })));
        any += a.length;
      }
      expect(any, c).toBeGreaterThan(10);
    }
  });

  it('only ever hands out named things: parts with a wear, cans, tins, dressings, rounds', () => {
    for (const c of LOOT_CONTEXTS) {
      for (let s = 1; s <= 30; s++) {
        for (const it of rollLoot(c, s * 31, 2, { progress: 0.7 })) {
          expect(['part', 'fuel', 'oil', 'water', 'paint', 'rations', 'medicine', 'medkit', 'bandage', 'ammo']).toContain(it.kind);
          if (it.kind === 'part') {
            expect(partDef(it.id).stock).toBeFalsy();
            expect(it.cond).toBeGreaterThan(0);
            expect(it.cond).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it('fits the context: kitchens hold food, bathrooms medicine, tyre shops tyres, gas stations fuel and oil, garages engines', () => {
    const rng = new Rng(7);
    const roll = (c: LootContext, n = 300) => Array.from({ length: n }, () => rollItem(c, rng, { progress: 0.5 })!).filter(Boolean);
    expect(roll('kitchen').every((s) => specTag(s) === 'food' || specTag(s) === 'water')).toBe(true);
    expect(roll('bathroom').every((s) => specTag(s) === 'med')).toBe(true);
    expect(roll('pharmacy').every((s) => specTag(s) === 'med')).toBe(true);
    const tyre = roll('tyreshop');
    expect(tyre.filter((s) => specTag(s) === 'tyre').length / tyre.length).toBeGreaterThan(0.6);
    const gas = roll('gas_station');
    expect(gas.filter((s) => specTag(s) === 'fuel' || specTag(s) === 'oil').length / gas.length).toBeGreaterThan(0.5);
    const garage = roll('garage');
    expect(garage.some((s) => specTag(s) === 'engine')).toBe(true);
    expect(garage.filter((s) => s.kind === 'part').length / garage.length).toBeGreaterThan(0.6);
    // Ammunition is for the places with guns, not for kitchens.
    expect(roll('kitchen').some((s) => s.kind === 'ammo')).toBe(false);
    expect(roll('police').some((s) => s.kind === 'ammo')).toBe(true);
  });

  it('asks a surface for the sort it wants and the size it can take', () => {
    const rng = new Rng(3);
    for (let i = 0; i < 200; i++) {
      const s = rollItem('garage', rng, { progress: 0.5, only: ['engine'] });
      expect(s && specTag(s)).toBe('engine');
      const t = rollItem('garage', rng, { progress: 0.5, cap: 'small' });
      if (t) expect(fits(specSize(t), 'small')).toBe(true);
      expect(specFoot(s!).w).toBeGreaterThan(0.3);
    }
  });

  it('gets better with distance from the start', () => {
    const mk = (progress: number) => {
      const rng = new Rng(11);
      let t = 0;
      let n = 0;
      for (let i = 0; i < 600; i++) {
        const s = rollItem('warehouse', rng, { progress, only: ['engine', 'radiator', 'gearbox', 'spring', 'mount'] });
        if (s?.kind === 'part') {
          t += partDef(s.id).mk;
          n++;
        }
      }
      return t / n;
    };
    expect(mk(0.9)).toBeGreaterThan(mk(0.05) + 0.3);
  });
});

// ------------------------------------------------------------------------------------------ the world

const allowed = new Set(['fuel', 'oil', 'rations', 'medicine', 'medkit', 'bandage', 'ammo', 'fragment', 'chassis', 'part', 'paint', 'water']);

/** Why this pickup may lie where it does, or what is wrong. Checked against the layout itself, not against what the generator says. */
function anchorProblem(L: LegLayoutImpl, p: PickupSpawn): string | null {
  const h = p.host;
  if (!h) return 'no host';
  if (!allowed.has(p.kind)) return `abstract kind ${p.kind}`;
  if (h.mode === 'on') {
    for (const b of L.rural) {
      const pl = b.plan;
      if (p.x < pl.x0 || p.x > pl.x1 || p.z < pl.z0 || p.z > pl.z1) continue;
      for (const f of pl.furn) {
        if (f.kind !== h.kind) continue;
        const r = furnRect(f);
        if (p.x < r.x0 - 0.02 || p.x > r.x1 + 0.02 || p.z < r.z0 - 0.02 || p.z > r.z1 + 0.02) continue;
        const base = levelBase(pl, f.level);
        for (const s of furnSlots(f)) {
          const w = slotWorld(f, s);
          if (Math.abs(w.x - p.x) < 0.01 && Math.abs(w.z - p.z) < 0.01 && Math.abs(base + s.y - p.y) < 0.01) return null;
        }
      }
    }
    return `on ${h.kind}: no such surface at ${p.x.toFixed(1)},${p.z.toFixed(1)},${p.y.toFixed(2)}`;
  }
  switch (h.kind) {
    case 'car': {
      const d = Math.min(...L.cars.map((c) => Math.hypot(c.x - p.x, c.z - p.z)));
      return d <= 2.4 + HOST_REACH + 0.6 ? null : `car ${d.toFixed(1)} m away`;
    }
    case 'building': {
      const d = Math.min(...L.rural.map((b) => Math.hypot(Math.max(b.aabb.minX - p.x, 0, p.x - b.aabb.maxX), Math.max(b.aabb.minZ - p.z, 0, p.z - b.aabb.maxZ))));
      return d <= 3.5 ? null : `building ${d.toFixed(1)} m away`;
    }
    case 'tyrestack': {
      for (const b of L.rural) for (const f of b.plan.furn) if (f.kind === 'tyrestack') {
        const r = furnRect(f);
        if (Math.hypot(Math.max(r.x0 - p.x, 0, p.x - r.x1), Math.max(r.z0 - p.z, 0, p.z - r.z1)) < 1.2) return null;
      }
      return 'no tyre stack beside it';
    }
    default: {
      const r = HOST_PROPS[h.kind];
      if (r === undefined && h.kind !== 'cafeTable') return `unknown host ${h.kind}`;
      const kinds = h.kind === 'cafeTable' ? 1.2 : r;
      const d = Math.min(...L.props.filter((q) => q.kind === h.kind).map((q) => Math.hypot(q.x - p.x, q.z - p.z) - kinds * q.scale));
      return d <= HOST_REACH + 0.6 ? null : `${h.kind} ${d.toFixed(1)} m away`;
    }
  }
}

describe.each(['W', 'L3P', 'L2C', 'L1'])('loose things in %s', (id) => {
  const L = buildLayout(legById(id));

  it('are all named things: no Scrap, Tech or generic Parts lying about', () => {
    expect(L.pickups.length).toBeGreaterThan(20);
    // Guns on display are gear (see tests/groundgear.test.ts), not loot.
    for (const p of L.pickups.filter((q) => q.kind !== 'gear')) {
      expect(allowed.has(p.kind), `${p.id}: ${p.kind}`).toBe(true);
      if (p.kind === 'part') expect(partDef(p.part!.id).name.length).toBeGreaterThan(0);
    }
  });

  it('each lies on furniture inside a building, or beside the host that justifies it, and never in open ground by itself', () => {
    const bad: string[] = [];
    for (const p of L.pickups.filter((q) => q.kind !== 'gear')) {
      const why = anchorProblem(L, p);
      if (why) bad.push(`${p.id} ${p.kind}: ${why}`);
    }
    expect(bad.slice(0, 10).join('\n')).toBe('');
  });

  it('lie at a fixed heading, clear of walls and solids', () => {
    for (const p of L.pickups) {
      expect(p.yaw, p.id).toBeTypeOf('number');
      if (p.host!.mode === 'beside' && p.kind !== 'chassis' && p.kind !== 'fragment' && !p.tilt) expect(L.blockedAt(p.x, p.z, 0.05), `${p.id} ${p.host!.kind}`).toBe(false);
    }
  });

  it('are the same every time, and every one lands in exactly one chunk', () => {
    const again = buildLayout(legById(id));
    expect(JSON.stringify(again.pickups)).toBe(JSON.stringify(L.pickups));
    const src = new ChunkSource(legById(id));
    const keys = new Set<string>();
    let n = 0;
    const zs = L.pickups.map((p) => Math.floor(p.z / 128));
    for (const cz of new Set(zs.slice(0, 60))) {
      for (let cx = -3; cx <= 3; cx++) for (const p of src.get(cx, cz).pickups) {
        expect(keys.has(p.id)).toBe(false);
        keys.add(p.id);
        n++;
      }
    }
    expect(n).toBeGreaterThan(0);
  });

  it('searchable containers hold named things', () => {
    for (const z of L.zones) for (const c of z.containers) expect(c.items.length + (c.guns ? 1 : 0) + Object.keys(c.drugs ?? {}).length).toBeGreaterThan(0);
  });
});

describe('the car trades', () => {
  const L = buildLayout(legById('L3P'));
  it('the authored city has a garage, a car dealership, a tyre shop and a warehouse, each a real building', () => {
    const looks = new Set(L.rural.map((b) => b.look));
    for (const look of ['garage', 'dealership', 'tyreshop', 'warehouse']) expect(looks.has(look as never), look).toBe(true);
    const garage = L.rural.find((b) => b.look === 'garage')!;
    expect(garage.plan.furn.some((f) => f.kind === 'partsshelf')).toBe(true);
    expect(garage.plan.furn.some((f) => f.kind === 'enginestand')).toBe(true);
    const tyre = L.rural.find((b) => b.look === 'tyreshop')!;
    expect(tyre.plan.furn.some((f) => f.kind === 'tyrerack')).toBe(true);
    const wh = L.rural.find((b) => b.look === 'warehouse')!;
    expect(wh.plan.furn.filter((f) => f.kind === 'rack').length).toBeGreaterThan(1);
  });
  it('a dealership has showroom cars standing on its floor', () => {
    const d = L.rural.find((b) => b.look === 'dealership')!;
    expect(d.plan.bays.length).toBeGreaterThan(0);
    for (const bay of d.plan.bays) {
      const car = L.cars.find((c) => Math.abs(c.x - bay.x) < 0.01 && Math.abs(c.z - bay.z) < 0.01);
      expect(car?.grade).toBe('showroom');
      expect(bay.x).toBeGreaterThan(d.plan.x0);
      expect(bay.x).toBeLessThan(d.plan.x1);
    }
  });
  it('engines lie on engine stands and tyres on racks', () => {
    const on = L.pickups.filter((p) => p.host?.mode === 'on');
    expect(on.length).toBeGreaterThan(10);
    for (const p of on) {
      if (p.host!.kind === 'enginestand') expect(partDef(p.part!.id).slot).toBe('engine');
      if (p.host!.kind === 'tyrerack') expect(partDef(p.part!.id).slot).toBe('wheels');
    }
  });
});

describe('the first kilometres are enough to get going', () => {
  const L = buildLayout(legById('W'));
  const near = (R: number) => L.cars.filter((c) => Math.hypot(c.x, c.z - 12) < R);

  it('hold enough core mechanicals to assemble a runner: cars with an engine, radiator and gearbox, and tyres', () => {
    let whole = 0;
    let tyres = 0;
    for (const c of near(2000)) {
      const r = rollCar(c.seed, { biome: 'wasteland', chassis: c.chassis, status: c.status, grade: c.grade, reach: c.reach });
      const k = fittedCore(r.build);
      if (k.engine && k.radiator && k.gearbox) whole++;
      tyres += k.tyres;
    }
    expect(whole).toBeGreaterThanOrEqual(15);
    expect(tyres).toBeGreaterThanOrEqual(60);
  });

  it("Dustwell's workshop keeps an engine, a radiator, a gearbox and tyres on its stands and benches", () => {
    const here = L.pickups.filter((p) => Math.hypot(p.x - 97, p.z - 100) < 40 && p.part);
    const slot = (s: string) => here.filter((p) => partDef(p.part!.id).slot === s).length;
    expect(slot('engine')).toBeGreaterThanOrEqual(1);
    expect(slot('cooling')).toBeGreaterThanOrEqual(1);
    expect(slot('gearbox')).toBeGreaterThanOrEqual(1);
    expect(slot('wheels')).toBeGreaterThanOrEqual(2);
  });

  it('the moped to quad to buggy chain is still within reach of a fresh run: stripping the nearest cars and breaking spares down pays for both rebuilds', () => {
    const camp = new Campaign();
    const cars = near(1500).slice(0, 14);
    let scrap = 0;
    for (const c of cars) {
      const r = rollCar(c.seed, { biome: 'wasteland', chassis: c.chassis, status: c.status, grade: c.grade, reach: c.reach });
      for (let stage = 0; stage < 4; stage++) {
        const loot = salvageLoot(stage, { seed: r.build.seed, kind: 'car', chassis: c.chassis ?? r.build.chassis, burnt: r.status === 'hulk', build: r.build });
        for (const it of loot.items) scrap += scrapValue(it);
      }
    }
    // Scrap is the one thing breaking spares down makes; the Ledger's workbench turns it into Parts and Tech.
    camp.stocks.scrap += scrap;
    const bench = (id: 'parts' | 'tech', need: number) => {
      const unit = id === 'parts' ? { cost: { scrap: 6 }, n: 3 } : { cost: { scrap: 10 }, n: 1 };
      while (camp.stocks[id] < need && spend(camp.stocks, unit.cost)) camp.stocks[id] += unit.n;
    };
    for (const tier of [1, 2]) {
      const info = checkTierUp(camp.stocks, tier, 1, true);
      const cost = info.cost as Record<string, number>;
      bench('parts', cost.parts ?? 0);
      bench('tech', cost.tech ?? 0);
      expect(canAfford(camp.stocks, info.cost), `tier ${tier}`).toBe(true);
      spend(camp.stocks, info.cost);
    }
  });
});

// ------------------------------------------------------------------------------------------ cars

describe('found cars are in bad shape', () => {
  const N = 1500;
  const rolls = Array.from({ length: N }, (_, i) => rollCar(i * 131 + 7, { biome: 'wasteland', reach: 0.6 }));
  const share = (f: (r: ReturnType<typeof rollCar>) => boolean) => rolls.filter(f).length / N;

  it('are rolled from their seed alone', () => {
    for (let s = 1; s <= 60; s++) {
      const a = rollCar(s * 97, { biome: 'city', reach: 0.4 });
      const b = rollCar(s * 97, { biome: 'city', reach: 0.4 });
      expect(a.grade).toBe(b.grade);
      expect(missingSlots(a.build)).toEqual(missingSlots(b.build));
      expect(a.build.comp).toEqual(b.build.comp);
      expect(a.build.tyres.map((t) => t?.id)).toEqual(b.build.tyres.map((t) => t?.id));
    }
  });

  it('most are missing body parts, and a fair share are missing wheels, doors or the bonnet', () => {
    expect(share((r) => r.grade !== 'complete' && missingSlots(r.build).length > 0)).toBeGreaterThan(0.55);
    expect(share((r) => isMissing(r.build, 'hood'))).toBeGreaterThan(0.25);
    expect(share((r) => isMissing(r.build, 'doorL') || isMissing(r.build, 'doorR'))).toBeGreaterThan(0.3);
    expect(share((r) => bareWheels(r.build) > 0)).toBeGreaterThan(0.3);
    expect(share((r) => isMissing(r.build, 'exhaust'))).toBeGreaterThan(0.15);
    expect(share((r) => isMissing(r.build, 'brakes'))).toBeGreaterThan(0.1);
    expect(share((r) => isMissing(r.build, 'suspension'))).toBeGreaterThan(0.08);
    expect(share((r) => !!r.build.body?.glass)).toBeGreaterThan(0.2);
    expect(share((r) => !!r.build.body?.gone.length)).toBeGreaterThan(0.2);
  });

  it('usually keep their core mechanicals, worn; in a cluster of cases the engine or radiator is gone too; a minority are complete', () => {
    expect(share((r) => !isMissing(r.build, 'engine') && !isMissing(r.build, 'cooling') && !isMissing(r.build, 'gearbox'))).toBeGreaterThan(0.6);
    expect(share((r) => isMissing(r.build, 'engine'))).toBeGreaterThan(0.06);
    expect(share((r) => isMissing(r.build, 'engine'))).toBeLessThan(0.3);
    expect(share((r) => isMissing(r.build, 'cooling'))).toBeGreaterThan(0.05);
    expect(share((r) => r.grade === 'complete')).toBeGreaterThan(0.04);
    expect(share((r) => r.grade === 'complete')).toBeLessThan(0.2);
    expect(share((r) => r.status === 'intact')).toBeLessThan(0.2);
  });

  it('only miss what the chassis has: every empty mount is a slot of that vehicle', () => {
    for (const r of rolls.slice(0, 600)) {
      const have = slotsOf(chassisDef(r.build.chassis));
      for (const s of missingSlots(r.build)) expect(have).toContain(s);
      expect(r.build.tyres).toHaveLength(r.build.comp.tires.length);
      // A bare wheel is a dead one.
      r.build.tyres.forEach((t, i) => {
        if (t && partDef(t.id).empty) expect(r.build.comp.tires[i]).toBe(0);
      });
    }
  });

  it('donors and wrecks keep their valuable parts fitted, for the crowbar', () => {
    const donors = rolls.filter((r) => r.grade === 'donor' || r.grade === 'hulk');
    expect(donors.length).toBeGreaterThan(150);
    const valuable = donors.filter((r) => Object.values(r.build.fit).some((it) => !partDef(it!.id).stock && !partDef(it!.id).empty));
    expect(valuable.length / donors.length).toBeGreaterThan(0.45);
    // And what they hold comes off when stripped.
    const r = valuable[0];
    const got = [0, 1, 2].flatMap((st) => salvageLoot(st, { seed: r.build.seed, kind: 'car', chassis: r.build.chassis, burnt: r.status === 'hulk', build: r.build }).items);
    expect(got.some((it) => !partDef(it.id).stock)).toBe(true);
  });

  it('the road near the start is kinder, further out is richer', () => {
    const complete = (reach: number) => Array.from({ length: 800 }, (_, i) => rollCar(i * 17 + 3, { biome: 'wasteland', reach })).filter((r) => r.grade === 'complete' || r.grade === 'rough').length;
    expect(complete(0.05)).toBeGreaterThan(complete(0.8));
  });
});


describe('the cabin of found cars', () => {
  const N = 1500;
  const rolls = Array.from({ length: N }, (_, i) => rollCar(i * 131 + 7, { biome: 'wasteland', reach: 0.6 }));
  const share = (rs: ReturnType<typeof rollCar>[], f: (r: ReturnType<typeof rollCar>) => boolean) => rs.filter(f).length / Math.max(1, rs.length);
  const grade = (g: string) => rolls.filter((r) => r.grade === g);

  it('incomplete and burnt-out cars often lack seats, the wheel or the dash; complete and showroom cars never do', () => {
    expect(share(grade('incomplete'), (r) => cabinMissing(r.build).length > 0)).toBeGreaterThan(0.5);
    expect(share(grade('hulk'), (r) => cabinMissing(r.build).length > 0)).toBeGreaterThan(0.8);
    expect(share(grade('incomplete'), (r) => isMissing(r.build, 'dash'))).toBeGreaterThan(0.15);
    for (const g of ['complete', 'showroom']) for (const r of grade(g)) expect(cabinMissing(r.build)).toEqual([]);
  });

  it('donors and showroom cars keep nice ones, and torn ones turn up in the common car', () => {
    const nice = (r: ReturnType<typeof rollCar>) => INTERIOR_SLOTS.some((s) => ['seat_bucket', 'seat_leather', 'seat_plate', 'bench_fold', 'bench_rack', 'steer_sport', 'dash_gauge'].includes(r.build.fit[s]?.id ?? ''));
    expect(share(grade('donor'), nice)).toBeGreaterThan(0.4);
    expect(share(grade('incomplete'), (r) => INTERIOR_SLOTS.some((s) => ['seat_torn', 'bench_torn', 'dash_cracked', 'steer_chain'].includes(r.build.fit[s]?.id ?? '')))).toBeGreaterThan(0.3);
  });

  it('a cabin gap is a real gap on the vehicle (cabinGaps reads it) and only for mounts the chassis has', () => {
    for (const r of rolls.slice(0, 500)) {
      const def = chassisDef(r.build.chassis);
      const g = cabinGaps(def, r.build.fit);
      expect(g.steer).toBe(isMissing(r.build, 'steer'));
      expect(g.seatD).toBe(isMissing(r.build, 'seatD'));
      for (const s of cabinMissing(r.build)) expect(slotsOf(def)).toContain(s);
    }
  });

  it('near the start a runner keeps its wheel and driver seat; missing ones are the exception, and only wrecks and donors lack them', () => {
    const near = Array.from({ length: 1200 }, (_, i) => rollCar(i * 17 + 5, { biome: 'wasteland', reach: 0.05 }));
    const runners = near.filter((r) => r.grade !== 'hulk' && r.grade !== 'donor');
    expect(share(runners, (r) => isMissing(r.build, 'steer') || isMissing(r.build, 'seatD'))).toBeLessThan(0.08);
    for (const r of near.filter((r) => r.grade === 'complete' || r.grade === 'rough')) expect(cabinMissing(r.build).filter((x) => x === 'steer' || x === 'seatD')).toEqual([]);
  });

  it('salvage takes the fitted seats, wheel and dash in the cabin stage, and leaves the mounts empty', () => {
    let took = 0;
    for (const r of rolls.slice(0, 300)) {
      const b = r.build;
      const fitted = INTERIOR_SLOTS.filter((s) => slotsOf(chassisDef(b.chassis)).includes(s) && !isMissing(b, s));
      const loot = salvageLoot(3, { seed: b.seed, kind: 'car', chassis: b.chassis, burnt: r.status === 'hulk', build: b });
      const cab = loot.items.filter((it) => INTERIOR_SLOTS.includes(partDef(it.id).slot));
      // The fitted ones, and now and then a spare seat in the boot.
      expect(cab.length).toBeGreaterThanOrEqual(fitted.length);
      expect(cab.length).toBeLessThanOrEqual(fitted.length + 1);
      took += cab.length;
      stripBuild(3, b);
      for (const s of INTERIOR_SLOTS) if (slotsOf(chassisDef(b.chassis)).includes(s)) expect(isMissing(b, s)).toBe(true);
      expect(salvageLoot(3, { seed: b.seed, kind: 'car', chassis: b.chassis, burnt: false, build: b }).items.filter((it) => INTERIOR_SLOTS.includes(partDef(it.id).slot)).length).toBeLessThanOrEqual(1);
    }
    expect(took).toBeGreaterThan(300);
  });

  it('seats, wheels and dashboards are in the garage, dealership, warehouse and wreck loot tables', () => {
    for (const c of ['garage', 'dealership', 'warehouse', 'wreck'] as const) {
      const rng = new Rng(21);
      const got = Array.from({ length: 600 }, () => rollItem(c, rng, { progress: 0.5, only: ['cabin'] })).filter(Boolean);
      expect(got.length, c).toBeGreaterThan(0);
      for (const s of got) expect(INTERIOR_SLOTS).toContain(partDef((s as { id: string }).id).slot);
    }
  });
});

// ------------------------------------------------------------------------------------------ delves

describe('delve chests hold named things', () => {
  it('every chest of every theme lists parts, cans or tins, never Scrap, Parts or Tech', () => {
    for (const theme of ['cave', 'mine', 'bunker', 'metro'] as const) {
      for (const seed of [1, 42, 311]) {
        const m = generateDelve(theme, seed, 2);
        expect(m.chests.length).toBeGreaterThan(1);
        for (const c of m.chests) {
          expect(Object.keys(c.loot)).not.toContain('stocks');
          expect(c.loot.items.length + (c.loot.ammo ?? 0) + (c.loot.medkit ?? 0)).toBeGreaterThan(0);
        }
        expect(m.chests.find((c) => c.boss)!.loot.items.length).toBeGreaterThan(0);
      }
    }
  });
});

// ------------------------------------------------------------------------------------------ nothing spins

describe('loose things lie still', () => {
  it('a pickup keeps its position and heading for as long as it lies there, and nothing hovers', () => {
    const h = fakeServices();
    const sc = new LegScene(h.svc, legById('L1'));
    sc.pendingResult = true;
    run(sc, 2);
    const spawn = (sc as unknown as { spawnPickup(s: object): void }).spawnPickup.bind(sc);
    const p = sc.players[0];
    spawn({ id: 't1', kind: 'part', amount: 2, part: { id: 'eng_v6', cond: 0.6 }, x: p.pos.x + 2, y: sc.groundAt(p.pos.x + 2, p.pos.z), z: p.pos.z, yaw: 1.3, host: { kind: 'workbench', mode: 'on' } });
    spawn({ id: 't2', kind: 'oil', amount: 0.5, x: p.pos.x - 2, y: sc.groundAt(p.pos.x - 2, p.pos.z), z: p.pos.z });
    const snap = () => [...sc.pickups.values()].map((e) => [e.spawn.id, e.group.position.x, e.group.position.y, e.group.position.z, e.group.rotation.y, e.group.quaternion.y, e.group.children[0]?.rotation.y ?? 0]);
    const before = snap();
    expect(before.length).toBeGreaterThanOrEqual(2);
    run(sc, 6);
    expect(snap().filter((r) => before.some((b) => b[0] === r[0]))).toEqual(before.filter((b) => snap().some((r) => r[0] === b[0])));
    const e = sc.pickups.get('t1')!;
    expect(e.group.position.y).toBeCloseTo(sc.groundAt(p.pos.x + 2, p.pos.z), 5);
    // Its model lies with the heading it was given.
    expect(e.group.children[0].rotation.y).toBeCloseTo(1.3, 5);
    // The old animation state is gone.
    expect('phase' in e).toBe(false);
    expect('baseY' in e).toBe(false);
  });
});

void LEGS;
void fitsSlot;
