import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { chassisDef, legById, partDef } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { Btn } from '../src/input/intents';
import { Campaign } from '../src/game/campaign';
import { installPart, newBuild } from '../src/sim/garage';
import { newPart } from '../src/sim/parts';
import {
  FALL_SPEED,
  WALLED_FACTOR,
  fallThreshold,
  insideMax,
  insideUnits,
  looseStress,
  planLoad,
  securedSet,
  sizeOf,
  sizeOfPart,
  surfacesOf,
  walledStress,
  type CargoEntry,
  type Motion,
} from '../src/sim/cargo';
import { FUEL_CAN } from '../src/sim/carry';
import { effectiveStats } from '../src/sim/parts';
import { accessPointsOf } from '../src/render/accessPoints';
import { loadCarry } from '../src/game/hauling';
import { openPanel, standAt } from './helpers/access';
import { fakeServices } from './helpers/sim';
import type { Vehicle } from '../src/game/vehicle';
import { storageOf } from '../src/game/storage';
import { roadX } from '../src/world/terrain';

// Cargo that is really on a car: held by a holder, loose on an open surface, or stowed inside.
vi.setConfig({ testTimeout: 90000 });

beforeAll(async () => {
  await initPhysics();
});

const DT = 1 / 60;

function leg() {
  const h = fakeServices();
  const sc = new LegScene(h.svc, legById('L1'));
  sc.pendingResult = true;
  return { h, sc, c: h.campaign };
}

function pose(sc: LegScene) {
  for (const v of sc.vehicles) v.syncVisual(1, DT);
}

function run(sc: LegScene, secs: number) {
  for (let i = 0; i < Math.round(secs / DT); i++) {
    sc.tick(DT);
    if (i % 10 === 0) pose(sc);
  }
  pose(sc);
}

function tap(h: ReturnType<typeof fakeServices>, sc: LegScene, who: number, btn: number) {
  const it = h.intents[who];
  it.device = 'keyboard';
  it.held |= 1 << btn;
  it.pressed = 1 << btn;
  sc.tick(DT);
  it.held &= ~(1 << btn);
  it.pressed = 0;
  it.released = 1 << btn;
  sc.tick(DT);
  it.released = 0;
  sc.tick(DT);
}

function ownCar(sc: LegScene, chassis = 'hatch', fit: string[] = []): Vehicle {
  const p = sc.players[0];
  p.exitVehicle(false);
  const st = sc.src.layout.start;
  const x = st.x + 9;
  const z = st.z + 8;
  const b = newBuild(chassis, { seed: 31, fuel: 0.6 });
  for (const id of fit) installPart(b, newPart(id));
  const v = sc.spawnVehicle({ build: b, x, z, y: sc.groundAt(x, z), yaw: 0, ownerIndex: 0, faction: 'convoy' });
  sc.campaign.adopt(b);
  run(sc, 1.5);
  const d = v.doorPos(1);
  p.placeAt(d[0], d[2], v.yaw);
  return v;
}

/** Drive a car straight ahead at `speed` for `secs`, pushing its velocity every tick (the test has no driver). */
function drive(sc: LegScene, v: Vehicle, speed: number, secs: number, stop?: () => boolean) {
  for (let i = 0; i < Math.round(secs / DT); i++) {
    const [fx, , fz] = v.body.forward();
    const lv = v.body.body.linvel();
    v.body.body.setLinvel({ x: fx * speed, y: lv.y, z: fz * speed }, true);
    sc.tick(DT);
    if (i % 10 === 0) pose(sc);
    if (stop?.()) break;
  }
}

/** Stand `dist` metres in front of the car, facing the roof: far enough from the doors that only the roof is in reach. */
function standOff(sc: LegScene, v: Vehicle, spot: 'roof', dist: number) {
  const p = sc.players[0];
  const pt = accessPointsOf(v.def).find((q) => q.spot === spot)!;
  const [x, , z] = v.body.toWorld(pt.x + dist * 0.68, pt.y, pt.z + dist * 0.74);
  const [rx, , rz] = v.body.toWorld(pt.x, pt.y, pt.z);
  p.placeAt(x, z, Math.atan2(rx - x, rz - z));
  pose(sc);
}

const cargoPieces = (sc: LegScene) => sc.debris.pieces.filter((p) => p.tag === 'cargo');

describe('footprints and holders', () => {
  it('cans are small, most parts medium, engines and tyre sets large', () => {
    expect(sizeOf({ kind: 'fuel', amount: FUEL_CAN })).toBe(1);
    expect(sizeOfPart('arm_sheet')).toBe(2);
    expect(sizeOfPart('whl_mt')).toBe(4);
    expect(sizeOfPart('eng_v8')).toBe(4);
    expect(sizeOfPart('eng_650')).toBe(2);
  });

  it('a stock vehicle has a sensible secure capacity, and holders are not counted as room inside', () => {
    const hatch = chassisDef('hatch');
    const van = chassisDef('van');
    const moped = chassisDef('moped');
    const cap = (d: ReturnType<typeof chassisDef>, fit = {}) => insideUnits(d, effectiveStats(d, fit).cargo, fit);
    expect(cap(van)).toBeGreaterThan(cap(hatch));
    expect(cap(hatch)).toBeGreaterThan(cap(moped));
    expect(cap(moped)).toBeGreaterThanOrEqual(2);
    // A roof rack's cargo stat is the convoy's, not room in the boot.
    const rack = { roof: newPart('rf_rack') };
    expect(cap(hatch, rack)).toBe(cap(hatch));
    expect(insideMax(moped)).toBe(2);
    expect(insideMax(van)).toBe(4);
  });

  it('every holder part has a hold and a model', () => {
    for (const id of ['rf_rack', 'rf_net', 'rf_basket', 'rf_basket2', 'rf_basket3', 'rr_cage', 'rr_cage2', 'utl_tie', 'utl_net', 'utl_rack', 'rr_spare']) {
      expect(partDef(id).hold, id).toBeTruthy();
    }
    expect(partDef('rf_basket3').hold!.units).toBeGreaterThan(partDef('rf_basket').hold!.units);
    expect(partDef('rf_basket').hold!.max).toBeLessThan(partDef('rf_basket2').hold!.max);
  });
});

describe('what the prompts say', () => {
  const hatch = chassisDef('hatch');
  const pickup = chassisDef('pickup');
  const part = { kind: 'part' as const, item: newPart('arm_sheet') };
  const engine = { kind: 'part' as const, item: newPart('eng_v8') };

  it('a bare roof says the load is loose', () => {
    const plan = planLoad(hatch, {}, [], 'roof', part);
    expect(plan.ok).toBe(true);
    expect(plan.secure).toBe(false);
    expect(plan.label).toMatch(/Loose: it will fall off when you drive/);
  });

  it('a basket says secured, until it is full or the load is too big for it', () => {
    const fit = { roof: newPart('rf_basket') };
    expect(planLoad(hatch, fit, [], 'roof', part)).toMatchObject({ ok: true, secure: true });
    expect(planLoad(hatch, fit, [], 'roof', part).label).toMatch(/Secured in the wire roof basket/);
    // An engine does not fit the small basket, but does the big one.
    expect(planLoad(hatch, fit, [], 'roof', engine)).toMatchObject({ ok: true, secure: false });
    expect(planLoad(hatch, fit, [], 'roof', engine).label).toMatch(/too big/);
    expect(planLoad(hatch, { roof: newPart('rf_basket2') }, [], 'roof', engine)).toMatchObject({ ok: true, secure: true });
    // Six units fill the small basket: three medium parts, and the fourth is loose.
    const entries: CargoEntry[] = [0, 1, 2].map((i) => ({ id: `e${i}`, zone: 'roof', c: { kind: 'part', item: newPart('arm_sheet') }, thr: 1 }));
    expect(securedSet(hatch, fit, entries).size).toBe(3);
    const fourth = planLoad(hatch, fit, entries, 'roof', part);
    expect(fourth.secure).toBe(false);
    expect(fourth.label).toMatch(/full/);
  });

  it('a pickup bed has walls but no lock; a tie-down kit secures it', () => {
    const bare = planLoad(pickup, {}, [], 'trunk', part);
    expect(bare).toMatchObject({ ok: true, secure: false, zone: 'bed' });
    expect(bare.label).toMatch(/walls hold it unless/);
    expect(planLoad(pickup, { utility: newPart('utl_tie') }, [], 'trunk', part).secure).toBe(true);
    expect(surfacesOf(pickup, {}).map((s) => s.zone)).toEqual(['roof', 'bed']);
  });

  it('the jerrycan rack takes only cans, and the spare carrier only a tyre set', () => {
    const rack = { utility: newPart('utl_rack') };
    expect(planLoad(hatch, rack, [], 'flank', { kind: 'fuel', amount: FUEL_CAN })).toMatchObject({ ok: true, secure: true, zone: 'rack' });
    expect(planLoad(hatch, rack, [], 'flank', part).ok).toBe(false);
    expect(planLoad(hatch, {}, [], 'flank', { kind: 'fuel', amount: FUEL_CAN }).ok).toBe(false);
    const spare = { rear: newPart('rr_spare') };
    expect(planLoad(hatch, spare, [], 'rear', { kind: 'part', item: newPart('whl_mt') })).toMatchObject({ ok: true, secure: true, zone: 'spare' });
    expect(planLoad(hatch, spare, [], 'rear', part).ok).toBe(false);
  });
});

describe('what the load feels', () => {
  const calm: Motion = { speed: 0, long: 0, lat: 0, vert: 0, airborne: false, upY: 1 };
  const secs = (m: Motion, limit: number, walled = false, gate = false) => {
    let e = 0;
    let t = 0;
    while (e < limit && t < 600) {
      e += walled ? walledStress(m, DT, gate) : looseStress(m, DT);
      t += DT;
    }
    return t;
  };

  it('nothing happens while parked or crawling', () => {
    expect(looseStress(calm, 1)).toBe(0);
    expect(looseStress({ ...calm, speed: FALL_SPEED - 0.2 }, 1)).toBe(0);
    expect(walledStress({ ...calm, speed: 2 }, 1, true)).toBe(0);
  });

  it('driving works a loose load free, sooner when faster, braking or cornering', () => {
    const slow = secs({ ...calm, speed: 4 }, 1);
    const fast = secs({ ...calm, speed: 14 }, 1);
    const braking = secs({ ...calm, speed: 14, long: -9 }, 1);
    const cornering = secs({ ...calm, speed: 14, lat: 8 }, 1);
    expect(slow).toBeGreaterThan(fast);
    expect(fast).toBeLessThan(2);
    expect(braking).toBeLessThan(fast);
    expect(cornering).toBeLessThan(fast);
    // A bump is felt at once.
    expect(looseStress({ ...calm, speed: 10, vert: 14 }, DT)).toBeGreaterThan(0.4);
  });

  it('a bed holds through ordinary driving and gives on hard events, a roll, or an open tailgate', () => {
    expect(walledStress({ ...calm, speed: 14 }, 1, false)).toBe(0);
    expect(walledStress({ ...calm, speed: 14, long: -10 }, 1, false)).toBeGreaterThan(0);
    expect(walledStress({ ...calm, speed: 14, upY: 0.1 }, 1, false)).toBeGreaterThan(0);
    expect(walledStress({ ...calm, speed: 14 }, 1, true)).toBeGreaterThan(0);
    expect(WALLED_FACTOR).toBeGreaterThan(2);
  });

  it('each load has its own seeded tolerance, so they do not all go at once', () => {
    const ts = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((s) => fallThreshold(s).toFixed(3)));
    expect(ts.size).toBe(8);
    for (const x of ts) {
      expect(+x).toBeGreaterThanOrEqual(0.5);
      expect(+x).toBeLessThanOrEqual(2.2);
    }
    expect(fallThreshold(5)).toBe(fallThreshold(5));
  });
});

describe('in the scene', () => {
  it('X at the roof puts a part on it: loose, it stays while parked', () => {
    const { h, sc } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    p.carry = { kind: 'part', item: newPart('arm_sheet', 0.9) };
    standOff(sc, v, 'roof', 1.9);
    run(sc, 0.2);
    // At a shut door X does not quietly turn into a loose load on the roof: it says to open the door, or step back.
    expect(p.promptAlt?.text ?? p.prompt?.text).toMatch(/Open the driver's door first.*put it on the roof/);
    tap(h, sc, 0, Btn.X);
    expect(p.carry).not.toBeNull();
    expect(v.cargoRig.entries.length).toBe(0);
    // Out of reach of the doors, the roof is what X means.
    expect(loadCarry(p)).toBe(true);
    expect(p.carry).toBeNull();
    expect(v.cargoRig.entries.length).toBe(1);
    expect(v.cargoRig.isSecure(v.cargoRig.entries[0])).toBe(false);
    expect(p.notes.some((n) => /Loose: it will fall off when you drive/.test(n.text))).toBe(true);
    // The long warning comes once.
    expect(p.notes.filter((n) => /Loose loads fall off a moving car/.test(n.text)).length).toBe(1);
    // Parked, it sits there as long as you like.
    run(sc, 12);
    expect(v.cargoRig.entries.length).toBe(1);
    expect(cargoPieces(sc).length).toBe(0);
  });

  it('driving off with a loose load on the roof drops it in the road as something you can pick up', () => {
    const { sc } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    const item = newPart('arm_sheet', 0.9);
    v.cargoRig.add({ kind: 'part', item }, 'roof');
    v.cargoRig.add({ kind: 'fuel', amount: FUEL_CAN }, 'roof');
    run(sc, 1);
    drive(sc, v, 11, 30, () => v.cargoRig.entries.length === 0);
    expect(v.cargoRig.entries.length).toBe(0);
    expect(v.build!.cargo).toBeUndefined();
    expect(p.notes.some((n) => /Your .* fell off the roof/.test(n.text))).toBe(true);
    const pieces = cargoPieces(sc);
    expect(pieces.length).toBe(2);
    // Land, settle, and both can be lifted again.
    v.body.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    run(sc, 8);
    const found: string[] = [];
    for (const pc of sc.debris.pieces) {
      const c = pc.item ? { kind: 'part' as const, item: pc.item } : pc.carried;
      if (c) found.push(c.kind);
    }
    expect(found.sort()).toEqual(['fuel', 'part']);
    const t0 = cargoPieces(sc)[0].body.translation();
    const near = sc.loose!.nearest(t0.x, t0.z, 3);
    expect(near).not.toBeNull();
    expect(sc.loose!.take(near!.id)).not.toBeNull();
  });

  it('a fuel can that falls off spills nothing, but a fragile part is knocked about', () => {
    const { sc, c } = leg();
    const v = ownCar(sc);
    v.cargoRig.add({ kind: 'fuel', amount: FUEL_CAN }, 'roof');
    v.cargoRig.add({ kind: 'part', item: newPart('eng_v6', 0.9) }, 'roof');
    v.cargoRig.spillAll();
    const pc = sc.debris.pieces.filter((x) => x.tag === 'cargo');
    const can = pc.find((x) => x.carried)!;
    expect(can.carried).toMatchObject({ kind: 'fuel', amount: FUEL_CAN });
    const eng = pc.find((x) => x.item)!;
    expect(eng.item!.cond).toBeLessThan(0.9);
    void c;
  });

  it('a roof basket keeps what is in it at any speed', () => {
    const { sc } = leg();
    const v = ownCar(sc, 'hatch', ['rf_basket']);
    v.cargoRig.add({ kind: 'part', item: newPart('arm_sheet', 0.9) }, 'roof');
    v.cargoRig.add({ kind: 'oil', amount: 0.5 }, 'roof');
    expect(v.cargoRig.entries.every((e) => v.cargoRig.isSecure(e))).toBe(true);
    run(sc, 1);
    drive(sc, v, 16, 20);
    expect(v.cargoRig.entries.length).toBe(2);
    expect(cargoPieces(sc).length).toBe(0);
  });

  it('what is beyond the basket, or too big for it, is loose and goes', () => {
    const { sc } = leg();
    const v = ownCar(sc, 'hatch', ['rf_basket']);
    for (let i = 0; i < 3; i++) v.cargoRig.add({ kind: 'part', item: newPart('arm_sheet') }, 'roof');
    const extra = v.cargoRig.add({ kind: 'part', item: newPart('arm_sheet') }, 'roof');
    expect(v.cargoRig.isSecure(extra)).toBe(false);
    run(sc, 1);
    drive(sc, v, 14, 20, () => !v.cargoRig.entries.includes(extra));
    expect(v.cargoRig.entries.includes(extra)).toBe(false);
    expect(v.cargoRig.entries.length).toBe(3);
  });

  it('a pickup bed holds a load through steady driving, and lets it go out of an open tailgate', () => {
    const { sc } = leg();
    const v = ownCar(sc, 'pickup');
    v.cargoRig.add({ kind: 'part', item: newPart('whl_mt') }, 'bed');
    // Down the middle of the road (pushed dead straight, nothing steers it: the road bends away after about 60 m).
    const z0 = v.position.z;
    const x0 = roadX(sc.terrain!, z0);
    v.body.setPose(x0, sc.groundAt(x0, z0) + 1.2, z0, 0);
    run(sc, 1);
    drive(sc, v, 12, 5);
    expect(v.cargoRig.entries.length).toBe(1);
    // Tailgate gone: it slides out the back. Turned round, back over the ground it has just crossed.
    v.open.trunk = true;
    const t = v.position;
    v.body.setPose(t.x, t.y + 0.05, t.z, v.yaw + Math.PI);
    run(sc, 0.5);
    drive(sc, v, 12, 30, () => v.cargoRig.entries.length === 0);
    expect(v.cargoRig.entries.length).toBe(0);
  });

  it('a tie-down kit keeps a bed load in even then', () => {
    const { sc } = leg();
    const v = ownCar(sc, 'pickup', ['utl_net']);
    v.cargoRig.add({ kind: 'part', item: newPart('whl_mt') }, 'bed');
    v.open.trunk = true;
    run(sc, 1);
    drive(sc, v, 14, 12);
    expect(v.cargoRig.entries.length).toBe(1);
  });

  it('a car that rolls over throws its load, held or not', () => {
    const { sc } = leg();
    const v = ownCar(sc, 'pickup');
    v.cargoRig.add({ kind: 'part', item: newPart('arm_sheet') }, 'bed');
    const m = v.cargoRig.motion;
    m.upY = 0.1;
    // The rule itself (a real roll needs a real crash): the bed's stress is huge when on its side.
    expect(walledStress({ ...m, speed: 10, upY: 0.1 }, DT, false) * 60 * 3).toBeGreaterThan(2.2 * WALLED_FACTOR);
  });

  it('only convoy cars carry loads this way: a raider or crew vehicle is untouched', () => {
    const { sc } = leg();
    const v = ownCar(sc);
    expect(v.cargoRig.active).toBe(true);
    v.faction = 'raider';
    expect(v.cargoRig.active).toBe(false);
    v.faction = 'convoy';
  });

  it('inside: a stowed part is secure, counted against the boot, and a big thing needs a big enough vehicle', () => {
    const { h, sc, c } = leg();
    const v = ownCar(sc, 'moped');
    const p = sc.players[0];
    openPanel(v, 'trunk');
    // An engine is too big for panniers.
    p.carry = { kind: 'part', item: newPart('eng_v8') };
    standAt(sc, v, 'trunk');
    tap(h, sc, 0, Btn.X);
    expect(p.carry).not.toBeNull();
    expect(p.notes.some((n) => /too big for the 50cc Scrap Moped panniers/.test(n.text))).toBe(true);
    // A medium part goes in; the second no longer fits.
    p.carry = { kind: 'part', item: newPart('arm_sheet') };
    tap(h, sc, 0, Btn.X);
    expect(p.carry).toBeNull();
    expect(c.inventory[0].on).toBe(v.build!.uid);
    expect(v.insideRoom().free).toBeLessThan(2 + 1);
    p.carry = { kind: 'part', item: newPart('arm_sheet') };
    tap(h, sc, 0, Btn.X);
    tap(h, sc, 0, Btn.X);
    expect(c.inventory.length).toBeLessThanOrEqual(2);
    // Whatever happens, stowed parts never fall off.
    drive(sc, v, 14, 6);
    expect(c.inventory.length).toBeGreaterThanOrEqual(1);
    expect(cargoPieces(sc).length).toBe(0);
  });

  it('a hatchback boot has room for a few things and says when it is full', () => {
    const { h, sc, c } = leg();
    const v = ownCar(sc, 'hatch');
    const p = sc.players[0];
    openPanel(v, 'trunk');
    standAt(sc, v, 'trunk');
    let put = 0;
    for (let i = 0; i < 12; i++) {
      p.carry = { kind: 'part', item: newPart('whl_mt') };
      tap(h, sc, 0, Btn.X);
      if (p.carry === null) put++;
      else break;
    }
    expect(put).toBeGreaterThan(1);
    expect(put).toBeLessThan(12);
    expect(c.inventory.length).toBe(put);
    expect(p.notes.some((n) => /is full/.test(n.text))).toBe(true);
  });

  it('X with empty hands at a loaded roof opens the storage on the load, says whether it was secure, and A takes it back', () => {
    const { h, sc } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    v.cargoRig.add({ kind: 'part', item: newPart('arm_sheet') }, 'roof');
    v.refreshLoadNow();
    standOff(sc, v, 'roof', 1.9);
    run(sc, 0.2);
    expect(p.promptAlt?.text ?? p.prompt?.text).toMatch(/on the roof, loose/);
    tap(h, sc, 0, Btn.X);
    const s = storageOf(p)!;
    const row = s.entries.findIndex((e) => e.kind === 'cargo');
    expect(s.entries[row]).toMatchObject({ where: 'roof', secure: false });
    s.select(row);
    tap(h, sc, 0, Btn.A);
    expect(p.carry).toMatchObject({ kind: 'part' });
    expect(v.cargoRig.entries.length).toBe(0);
  });

  it('a load on the car goes into the save with the build and comes back', () => {
    const { sc, c } = leg();
    const v = ownCar(sc, 'hatch', ['rf_basket']);
    const item = newPart('arm_sheet', 0.7);
    v.cargoRig.add({ kind: 'part', item }, 'roof');
    v.cargoRig.add({ kind: 'fuel', amount: 3, fuel: 'diesel' }, 'roof');
    v.commit();
    const json = JSON.parse(JSON.stringify(c.serialize()));
    const back = Campaign.deserialize(json);
    const b = back.garage.find((g) => g.uid === v.build!.uid)!;
    expect(b.cargo?.length).toBe(2);
    expect(b.cargo![0].c).toMatchObject({ kind: 'part', item: { uid: item.uid, id: 'arm_sheet' } });
    expect(b.cargo![1].c).toMatchObject({ kind: 'fuel', amount: 3, fuel: 'diesel' });
    // And a vehicle built from it carries the load, secure in its basket.
    const v2 = sc.spawnVehicle({ build: b, x: v.position.x + 6, z: v.position.z, y: v.position.y, yaw: 0, ownerIndex: 0, faction: 'convoy' });
    expect(v2.cargoRig.entries.length).toBe(2);
    expect(v2.cargoRig.entries.every((e) => v2.cargoRig.isSecure(e))).toBe(true);
  });

  it('an old save with no cargo loads, and stowed parts with no vehicle are not emptied', () => {
    const { sc, c } = leg();
    const v = ownCar(sc);
    c.inventory.push(newPart('arm_sheet'), newPart('whl_mt'));
    expect(c.inventory.every((i) => !i.on)).toBe(true);
    const back = Campaign.deserialize(JSON.parse(JSON.stringify(c.serialize())));
    expect(back.inventory.length).toBe(c.inventory.length);
    expect(back.garage.every((g) => g.cargo === undefined)).toBe(true);
    // They show up in the boot of any of the convoy's cars, ready to be taken out.
    expect(v.deckSpots().filter((s) => s.kind === 'part').length).toBe(c.inventory.length);
  });

  it('breaking a vehicle down gives back what rode on it', () => {
    const b = newBuild('hatch', { seed: 5 });
    b.cargo = [{ id: 'x', zone: 'roof', c: { kind: 'part', item: newPart('eng_v6') }, thr: 1 }];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return import('../src/sim/garage').then(({ dismantleYield }) => {
      expect(dismantleYield(b).items.some((i) => i.id === 'eng_v6')).toBe(true);
    });
  });
});
