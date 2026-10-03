import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { legById, partDef } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { Btn } from '../src/input/intents';
import { installPart, newBuild } from '../src/sim/garage';
import { newPart } from '../src/sim/parts';
import { OIL_CAN } from '../src/sim/oil';
import { FUEL_CAN } from '../src/sim/carry';
import { mountsOf } from '../src/game/carwork';
import { fakeServices } from './helpers/sim';
import type { Vehicle } from '../src/game/vehicle';

// Real leg scenes in Node: terrain, physics and every system. Give them room when the whole suite runs in parallel.
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

function run(sc: LegScene, secs: number) {
  for (let i = 0; i < Math.round(secs / DT); i++) sc.tick(DT);
}

/** Hold a button on one player's intent for `secs`, the way the input manager would. */
function hold(h: ReturnType<typeof fakeServices>, sc: LegScene, who: number, btn: number, secs: number) {
  const it = h.intents[who];
  it.device = 'keyboard';
  for (let i = 0; i < Math.round(secs / DT); i++) {
    const first = i === 0;
    it.held |= 1 << btn;
    it.pressed = first ? 1 << btn : 0;
    it.heldTime[btn] += DT;
    sc.tick(DT);
  }
  it.held &= ~(1 << btn);
  it.pressed = 0;
  it.released = 1 << btn;
  it.heldTime[btn] = 0;
  sc.tick(DT);
  it.released = 0;
}

/** A tap: one tick pressed, one released. */
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

/** A convoy hatchback with a build of its own, parked still, with player 0 on foot beside it. */
function ownCar(sc: LegScene, chassis = 'hatch'): Vehicle {
  const p = sc.players[0];
  p.exitVehicle(false);
  const st = sc.src.layout.start;
  const x = st.x + 9;
  const z = st.z + 8;
  const b = newBuild(chassis, { seed: 31, fuel: 0.2 });
  const v = sc.spawnVehicle({ build: b, x, z, y: sc.groundAt(x, z), yaw: 0, ownerIndex: 0, faction: 'convoy' });
  sc.campaign.adopt(b);
  run(sc, 1.5);
  const d = v.doorPos(1);
  p.placeAt(d[0], d[2], v.yaw);
  return v;
}

/** Lay a loose item on the ground at the player's feet. */
function layDown(sc: LegScene, c: Parameters<NonNullable<LegScene['loose']>['drop']>[2]) {
  const p = sc.players[0];
  sc.loose!.drop(p.pos.x, p.pos.z, c);
}

describe('carrying parts, fuel and oil by hand', () => {
  it('lifts a part off the ground, and it leaves the world', () => {
    const { h, sc } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    p.placeAt(v.position.x + 12, v.position.z, 0);
    const part = newPart('eng_v6', 0.7);
    layDown(sc, { kind: 'part', item: part });
    expect(sc.loose!.nearest(p.pos.x, p.pos.z, 3)?.carried).toMatchObject({ kind: 'part' });
    expect(p.carry).toBeNull();
    hold(h, sc, 0, Btn.A, 1.4);
    expect(p.carry).toMatchObject({ kind: 'part' });
    expect(p.carry!.kind === 'part' && p.carry!.item.id).toBe('eng_v6');
    expect(sc.loose!.nearest(p.pos.x, p.pos.z, 3)).toBeNull();
  });

  it('a lift finishes even with several things at the same distance', () => {
    const { h, sc } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    p.placeAt(v.position.x + 14, v.position.z, 0);
    const { x, z } = { x: p.pos.x, z: p.pos.z };
    sc.loose!.drop(x + 1.2, z + 1, { kind: 'part', item: newPart('eng_v6') });
    sc.loose!.drop(x - 1.2, z + 1, { kind: 'oil', amount: OIL_CAN });
    sc.loose!.drop(x, z - 1.56, { kind: 'fuel', amount: FUEL_CAN });
    hold(h, sc, 0, Btn.A, 1.6);
    expect(p.carry).not.toBeNull();
  });

  it('walking over a part on foot does not bank it: you have to pick it up', () => {
    const { sc, c } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    p.placeAt(v.position.x + 12, v.position.z, 0);
    layDown(sc, { kind: 'part', item: newPart('eng_v6', 0.7) });
    const n = c.inventory.length;
    run(sc, 2);
    expect(c.inventory.length).toBe(n);
    expect(sc.loose!.nearest(p.pos.x, p.pos.z, 3)).not.toBeNull();
  });

  it('A at your car bolts the part on; what it replaces goes in the trunk', () => {
    const { h, sc, c } = leg();
    const v = ownCar(sc);
    installPart(v.build!, newPart('eng_i4', 0.6));
    v.syncFromBuild();
    expect(v.health.comp.engine).toBeCloseTo(0.6, 2);
    const p = sc.players[0];
    p.carry = { kind: 'part', item: newPart('eng_v6', 0.9) };
    expect(c.inventory.length).toBe(0);
    // A part goes on at its own mount: carry it round to the engine bay first.
    v.syncVisual(1, DT);
    const bay = mountsOf(v, p.pos).find((m) => m.slot === 'engine')!;
    p.placeAt(bay.pos.x + Math.sin(v.yaw) * 0.7, bay.pos.z + Math.cos(v.yaw) * 0.7, v.yaw + Math.PI);
    hold(h, sc, 0, Btn.A, 5);
    expect(p.carry).toBeNull();
    expect(v.build!.fit.engine?.id).toBe('eng_v6');
    expect(v.stats.forceMult).toBeCloseTo(1 + partDef('eng_v6').stats.force!, 5);
    expect(c.inventory.map((it) => it.id)).toEqual(['eng_i4']);
    // The old engine kept the wear it had on the car.
    expect(c.inventory[0].cond).toBeCloseTo(0.6, 1);
    expect(v.health.comp.engine).toBeCloseTo(0.9, 1);
  });

  it('a part for a slot the car does not have is refused', () => {
    const { h, sc } = leg();
    const v = ownCar(sc, 'moped'); // no roof or side mounts
    const p = sc.players[0];
    p.carry = { kind: 'part', item: newPart('rf_rack') };
    hold(h, sc, 0, Btn.A, 4);
    expect(p.carry).not.toBeNull();
    expect(v.build!.fit.roof).toBeUndefined();
    expect(p.prompt?.text).toMatch(/no roof mount/);
  });

  it('X at your car stows it for later; a full trunk refuses', () => {
    const { h, sc, c } = leg();
    ownCar(sc);
    const p = sc.players[0];
    p.carry = { kind: 'part', item: newPart('whl_mt', 0.8) };
    tap(h, sc, 0, Btn.X);
    expect(p.carry).toBeNull();
    expect(c.inventory.map((it) => it.id)).toEqual(['whl_mt']);
    // Fill the trunk to the brim.
    while (c.inventory.length < c.inventoryCap) c.inventory.push(newPart('arm_sheet'));
    p.carry = { kind: 'part', item: newPart('whl_bl') };
    tap(h, sc, 0, Btn.X);
    expect(p.carry).not.toBeNull();
    expect(c.inventory.length).toBe(c.inventoryCap);
    expect(p.notes.some((n) => /Trunk is full/.test(n.text))).toBe(true);
  });

  it('X away from any car sets it down, and it can be lifted again with its wear intact', () => {
    const { h, sc, c } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    p.placeAt(v.position.x + 25, v.position.z, 0);
    p.carry = { kind: 'part', item: newPart('whl_mt', 0.55) };
    tap(h, sc, 0, Btn.X);
    expect(p.carry).toBeNull();
    expect(c.inventory.length).toBe(0);
    const near = sc.loose!.nearest(p.pos.x, p.pos.z, 3);
    expect(near?.carried.kind).toBe('part');
    hold(h, sc, 0, Btn.A, 1.4);
    expect(p.carry?.kind === 'part' && p.carry.item.cond).toBeCloseTo(0.55, 5);
  });

  it('pours a fuel can into the tank, keeping what does not fit', () => {
    const { h, sc } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    v.fuel = v.tankMax - 3;
    p.carry = { kind: 'fuel', amount: FUEL_CAN };
    hold(h, sc, 0, Btn.A, 3.5);
    expect(v.fuel).toBeCloseTo(v.tankMax, 1);
    expect(p.carry).toMatchObject({ kind: 'fuel' });
    expect(p.carry!.kind === 'fuel' && p.carry!.amount).toBeCloseTo(2, 1);
    // A full tank takes no more.
    const before = v.fuel;
    hold(h, sc, 0, Btn.A, 3.5);
    expect(v.fuel).toBeCloseTo(before, 3);
  });

  it('stows a fuel can in the reserve cans, and the jerrycan tool can use it later', () => {
    const { h, sc, c } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    c.stocks.fuel = 0;
    p.carry = { kind: 'fuel', amount: FUEL_CAN };
    tap(h, sc, 0, Btn.X);
    expect(p.carry).toBeNull();
    expect(c.stocks.fuel).toBeCloseTo(FUEL_CAN, 5);
    v.fuel = 1;
    p.equip = 'jerrycan';
    hold(h, sc, 0, Btn.A, 5);
    expect(v.fuel).toBeCloseTo(6, 1);
    expect(c.stocks.fuel).toBeCloseTo(0, 1);
  });

  it('tops up the oil from a can in hand, then from the stowed reserve', () => {
    const { h, sc, c } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    v.health.comp.oil = 0.1;
    p.carry = { kind: 'oil', amount: OIL_CAN };
    hold(h, sc, 0, Btn.A, 3);
    expect(v.health.comp.oil).toBeCloseTo(0.6, 2);
    expect(p.carry).toBeNull();
    // Stow another can, then use the jerrycan tool to pour it in.
    p.carry = { kind: 'oil', amount: OIL_CAN };
    c.items.oil = 0;
    tap(h, sc, 0, Btn.X);
    expect(c.items.oil).toBeCloseTo(OIL_CAN, 5);
    v.health.comp.oil = 0.15;
    p.equip = 'jerrycan';
    hold(h, sc, 0, Btn.A, 3);
    expect(v.health.comp.oil).toBeCloseTo(0.65, 2);
    expect(c.items.oil).toBeCloseTo(0, 2);
  });

  it('hands full: no shooting, no sprinting, no tools', () => {
    const { h, sc } = leg();
    ownCar(sc);
    const p = sc.players[0];
    p.equip = 'gun';
    p.carry = { kind: 'oil', amount: OIL_CAN };
    const mag = p.mag;
    h.intents[0].rt = 1;
    run(sc, 1);
    h.intents[0].rt = 0;
    expect(p.mag).toBe(mag);
    p.equip = 'wrench';
    tap(h, sc, 0, Btn.LB);
    expect(p.equip).toBe('wrench'); // LB would have cycled it
    expect(p.notes.some((n) => /Hands full/.test(n.text))).toBe(true);
  });

  it('climbing into a car with full hands stows the load, or sets it down if there is no room', () => {
    const { sc, c } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    p.carry = { kind: 'part', item: newPart('whl_mt') };
    expect(p.tryEnter()).toBe(true);
    expect(p.carry).toBeNull();
    expect(c.inventory.map((it) => it.id)).toEqual(['whl_mt']);
    run(sc, 1);
    p.exitVehicle(false);
    const d = v.doorPos(1);
    p.placeAt(d[0], d[2], v.yaw);
    while (c.inventory.length < c.inventoryCap) c.inventory.push(newPart('arm_sheet'));
    p.carry = { kind: 'part', item: newPart('whl_bl') };
    expect(p.tryEnter()).toBe(true);
    expect(p.carry).toBeNull();
    expect(sc.loose!.nearest(d[0], d[2], 4)?.carried.kind).toBe('part'); // left beside the car
  });

  it('going down drops what you carry', () => {
    const { sc } = leg();
    ownCar(sc);
    const p = sc.players[0];
    p.carry = { kind: 'fuel', amount: FUEL_CAN };
    p.invuln = 0;
    p.hurt(500, p.pos.x + 1, p.pos.z, 'bullet');
    expect(p.state).toBe('downed');
    expect(p.carry).toBeNull();
    expect(sc.loose!.nearest(p.pos.x, p.pos.z, 3)?.carried).toMatchObject({ kind: 'fuel', amount: FUEL_CAN });
  });

  it('what you are holding goes back to the convoy when the scene ends', () => {
    const { sc, c } = leg();
    ownCar(sc);
    const p = sc.players[0];
    c.stocks.fuel = 0;
    p.carry = { kind: 'fuel', amount: FUEL_CAN };
    sc.dispose();
    expect(c.stocks.fuel).toBeCloseTo(FUEL_CAN, 5);
  });
});

describe('driving over loose things', () => {
  it('a car passing over a part or an oil can leaves it where it lies', () => {
    const { sc, c } = leg();
    const p = sc.players[0];
    const pos = p.vehicle!.position;
    c.items.oil = 0;
    sc.loose!.drop(pos.x, pos.z, { kind: 'oil', amount: OIL_CAN });
    sc.loose!.drop(pos.x, pos.z, { kind: 'part', item: newPart('eng_v6', 0.7) });
    run(sc, 0.5);
    expect(c.items.oil).toBe(0);
    expect(c.inventory.length).toBe(0);
    expect(sc.loose!.nearest(pos.x, pos.z, 4)).not.toBeNull();
  });
});

describe('goods are taken by hand', () => {
  it('holding A on foot takes the scrap and banks it', () => {
    const { h, sc, c } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    p.placeAt(v.position.x + 12, v.position.z, 0);
    const before = c.stocks.scrap;
    (sc as unknown as { spawnPickup(s: object): void }).spawnPickup({ id: 'handscrap', kind: 'scrap', amount: 9, x: p.pos.x + 0.5, z: p.pos.z, y: p.pos.y });
    run(sc, 1);
    expect(c.stocks.scrap).toBe(before);
    hold(h, sc, 0, Btn.A, 1);
    expect(c.stocks.scrap).toBe(before + 9);
  });

  it('scrap lying under the player stays put until it is taken', () => {
    const { sc, c } = leg();
    const p = sc.players[0];
    const before = c.stocks.scrap;
    const spawn = { id: 'testscrap', kind: 'scrap' as const, amount: 12, x: p.pos.x, z: p.pos.z, y: p.pos.y };
    (sc as unknown as { spawnPickup(s: typeof spawn): void }).spawnPickup(spawn);
    run(sc, 0.5);
    expect(c.stocks.scrap).toBe(before);
    expect(sc.loose!.nearestGoods(p.pos.x, p.pos.z, 3)?.label).toMatch(/Scrap/);
    expect(sc.loose!.takeGoods('testscrap', p)).toBe(true);
    expect(c.stocks.scrap).toBe(before + 12);
    expect(sc.loose!.nearestGoods(p.pos.x, p.pos.z, 3)).toBeNull();
  });
});

describe('engine oil in a live vehicle', () => {
  it('burns with distance, and a dry sump wrecks the engine', () => {
    const { sc } = leg();
    const v = sc.players[0].vehicle!;
    expect(v.health.comp.oil).toBe(1);
    v.engineOn = true;
    v.health.comp.oil = 0.006;
    v.health.comp.engine = 1;
    // Drive: pin the speed with autopilot.
    sc.players[0].autopilot = { speed: 12 };
    run(sc, 20);
    expect(v.health.comp.oil).toBe(0);
    expect(v.health.comp.engine).toBeLessThan(0.9);
  });

  it('the driver is warned as it runs low', () => {
    const { sc } = leg();
    const p = sc.players[0];
    const v = p.vehicle!;
    v.engineOn = true;
    v.health.comp.oil = 0.255;
    p.autopilot = { speed: 12 };
    // Notes fade after a few seconds, so watch for it as it happens.
    let warned = false;
    for (let i = 0; i < 30 * 60; i++) {
      sc.tick(DT);
      if (p.notes.some((n) => /Oil is low/.test(n.text))) warned = true;
    }
    expect(v.health.comp.oil).toBeLessThan(0.25);
    expect(warned).toBe(true);
  });

  it('survives a trip through the build and back', () => {
    const { sc } = leg();
    const v = sc.players[0].vehicle!;
    v.health.comp.oil = 0.37;
    v.commit();
    expect(v.build!.comp.oil).toBeCloseTo(0.37, 5);
    v.syncFromBuild();
    expect(v.health.comp.oil).toBeCloseTo(0.37, 5);
  });
});
