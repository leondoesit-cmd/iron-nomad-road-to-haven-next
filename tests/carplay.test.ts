import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { Btn } from '../src/input/intents';
import { newBuild } from '../src/sim/garage';
import { newPart } from '../src/sim/parts';
import { fakeServices } from './helpers/sim';
import type { Vehicle } from '../src/game/vehicle';

// Each test builds a real leg scene (terrain, textures, physics); give them room when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 90000 });

beforeAll(async () => {
  await initPhysics();
});

const DT = 1 / 60;

/** A real leg scene in Node, with the cars of L1 streaming. */
function leg() {
  const h = fakeServices();
  const sc = new LegScene(h.svc, legById('L1'));
  sc.pendingResult = true; // no encounters or camp decisions while we poke at cars
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

/** Put a fresh neutral car beside player 0 and stand them at its door. */
function carBeside(sc: LegScene, chassis: string, o: { hulk?: boolean; seed?: number } = {}): Vehicle {
  const p = sc.players[0];
  p.exitVehicle(false);
  const st = sc.src.layout.start;
  const b = newBuild(chassis, { seed: o.seed ?? 31 });
  const x = st.x + 9;
  const z = st.z + 8;
  const v = sc.spawnVehicle({ build: b, x, z, y: sc.groundAt(x, z), yaw: 0, ownerIndex: -1, faction: 'neutral', hulk: o.hulk });
  run(sc, 1.5);
  const d = v.doorPos(1);
  p.placeAt(d[0], d[2], v.yaw);
  return v;
}

describe('abandoned cars in a live leg', () => {
  it('streams in as the convoy approaches and is put away, with its state, when it falls behind', () => {
    const { sc } = leg();
    // Pick a car well down the road and carry the convoy there.
    const st = [...sc.cars.states.values()].find((s) => s.status !== 'hulk' && s.z > 400)!;
    expect(st.live).toBeNull();
    for (const p of sc.players) p.vehicle!.body.setPose(st.x + 4, sc.groundAt(st.x + 4, st.z - 80) + 1.2, st.z - 80, 0);
    run(sc, 4);
    expect(st.live).not.toBeNull();
    expect(st.live!.faction).toBe('neutral');
    expect(sc.vehicles).toContain(st.live!);
    // Strip a tyre set so we can see state survive a round trip.
    st.live!.salvaged = 1;
    st.live!.health.comp.tires[0] = 0;
    const id = st.spawn.id;
    for (const p of sc.players) p.vehicle!.body.setPose(st.x, sc.groundAt(st.x, st.z + 700) + 1.2, st.z + 700, 0);
    run(sc, 4);
    expect(sc.cars.states.get(id)!.live).toBeNull();
    expect(sc.vehicles.some((v) => v.carId === id)).toBe(false);
    expect(sc.cars.states.get(id)!.salvaged).toBe(1);
    expect(sc.cars.states.get(id)!.build.comp.tires[0]).toBe(0);
    for (const p of sc.players) p.vehicle!.body.setPose(st.x + 4, sc.groundAt(st.x + 4, st.z - 80) + 1.2, st.z - 80, 0);
    run(sc, 4);
    const back = sc.cars.states.get(id)!.live!;
    expect(back).not.toBeNull();
    expect(back.salvaged).toBe(1);
    expect(back.health.comp.tires[0]).toBe(0);
  });

  it('leaves a parked car as an obstacle for zombies and drivers', () => {
    const { sc } = leg();
    const v = carBeside(sc, 'sedan');
    run(sc, 1);
    let found = false;
    sc.obs.near(v.position.x, v.position.z, 3, (a) => {
      if (a.kind === 'car' && a.minX < v.position.x && a.maxX > v.position.x && a.minZ < v.position.z && a.maxZ > v.position.z) found = true;
    });
    expect(found).toBe(true);
  });

  it('claims the car when you climb in, and a dead engine will not start until it is rebuilt', () => {
    const { sc, c } = leg();
    const v = carBeside(sc, 'hatch');
    v.health.comp.engine = 0.02;
    const before = c.garage.length;
    expect(sc.players[0].tryEnter()).toBe(true);
    run(sc, 1);
    const p = sc.players[0];
    expect(p.state).toBe('driving');
    expect(v.faction).toBe('convoy');
    expect(v.ownerIndex).toBe(0);
    expect(c.garage.length).toBe(before + 1);
    expect(c.garage).toContain(v.build);
    expect(sc.cars.states.has(v.carId)).toBe(false);
    expect(v.engineOn).toBe(false);
    expect(v.startFail).toMatch(/seized/);
    expect(p.notes.some((n) => /joins the convoy/.test(n.text))).toBe(true);
    // Rebuilt, it starts.
    v.health.comp.engine = 0.6;
    v.setEngine(true);
    expect(v.engineOn).toBe(true);
  });

  it('a claimed car is never put away when the convoy drives on', () => {
    const { sc } = leg();
    const v = carBeside(sc, 'sedan');
    sc.players[0].tryEnter();
    run(sc, 1);
    sc.players[0].exitVehicle(false);
    const id = v.carId;
    for (const p of sc.players) if (p.vehicle) p.vehicle.body.setPose(0, sc.groundAt(0, 900) + 1.2, 900, 0);
    sc.players[0].placeAt(0, 900, 0);
    run(sc, 4);
    expect(sc.vehicles).toContain(v);
    expect(id).toBe('');
  });

  it('wrench: repairs cost what the prompt says, one job per hold', () => {
    const { h, sc, c } = leg();
    const v = carBeside(sc, 'hatch');
    v.health.comp.tires[0] = 0;
    v.health.comp.tires[2] = 0;
    v.health.comp.engine = 0.05;
    const p = sc.players[0];
    p.equip = 'wrench';
    const scrap0 = c.stocks.scrap;
    const parts0 = c.stocks.parts;
    hold(h, sc, 0, Btn.A, 6);
    expect(v.health.comp.tires.filter((t) => t === 0).length).toBe(1);
    expect(c.stocks.scrap).toBe(scrap0 - 2);
    hold(h, sc, 0, Btn.A, 6);
    expect(v.health.comp.tires.every((t) => t > 0)).toBe(true);
    expect(c.stocks.scrap).toBe(scrap0 - 4);
    hold(h, sc, 0, Btn.A, 9);
    expect(v.health.comp.engine).toBeCloseTo(0.55, 1);
    expect(c.stocks.parts).toBe(parts0 - 3);
    expect(v.faction).toBe('neutral'); // repairing does not claim
  });

  it('wrench: nothing happens without the stock to pay for the job', () => {
    const { h, sc, c } = leg();
    const v = carBeside(sc, 'hatch');
    v.health.comp.tires[1] = 0;
    c.stocks.scrap = 1;
    sc.players[0].equip = 'wrench';
    hold(h, sc, 0, Btn.A, 6);
    expect(v.health.comp.tires[1]).toBe(0);
    expect(c.stocks.scrap).toBe(1);
  });

  it('crowbar: strips an abandoned car stage by stage, into the inventory, and the car gets worse', () => {
    const { h, sc, c } = leg();
    const v = carBeside(sc, 'sedan', { seed: 2 });
    v.build!.fit.engine = newPart('eng_v6', 0.9);
    const p = sc.players[0];
    p.equip = 'crowbar';
    const inv0 = c.inventory.length;
    hold(h, sc, 0, Btn.A, 4);
    expect(v.salvaged).toBe(1);
    expect(c.inventory.length).toBeGreaterThan(inv0);
    expect(v.health.comp.tires.every((t) => t === 0)).toBe(true);
    hold(h, sc, 0, Btn.A, 6);
    expect(v.salvaged).toBe(2);
    expect(v.health.comp.engine).toBe(0);
    expect(v.build!.fit.engine).toBeUndefined();
    // The engine it was running on came back out of the trunk of inventory.
    expect(c.inventory.some((it) => it.id === 'eng_v6')).toBe(true);
    hold(h, sc, 0, Btn.A, 5);
    hold(h, sc, 0, Btn.A, 4);
    expect(v.salvaged).toBe(4);
    // Nothing more to take.
    const invN = c.inventory.length;
    hold(h, sc, 0, Btn.A, 5);
    expect(c.inventory.length).toBe(invN);
    expect(v.salvaged).toBe(4);
  });

  it('crowbar refuses your own working vehicle', () => {
    const { h, sc, c } = leg();
    const own = sc.players[1].vehicle!;
    const p = sc.players[0];
    p.exitVehicle(false);
    const d = own.doorPos(1);
    p.placeAt(d[0], d[2], own.yaw);
    p.equip = 'crowbar';
    const inv0 = c.inventory.length;
    hold(h, sc, 0, Btn.A, 6);
    expect(own.salvaged).toBe(0);
    expect(c.inventory.length).toBe(inv0);
  });

  it('jerrycan: siphons an abandoned tank into the convoy reserve', () => {
    const { h, sc, c } = leg();
    const v = carBeside(sc, 'pickup');
    v.fuel = 6;
    const p = sc.players[0];
    p.equip = 'jerrycan';
    const fuel0 = c.stocks.fuel;
    hold(h, sc, 0, Btn.A, 5);
    expect(v.fuel).toBeCloseTo(1, 1);
    expect(c.stocks.fuel).toBeCloseTo(fuel0 + 5, 1);
  });

  it('a hulk cannot be driven or claimed but can be stripped, and it blocks the way', () => {
    const { h, sc, c } = leg();
    const v = carBeside(sc, 'van', { hulk: true });
    expect(v.wreck).toBe(true);
    expect(sc.players[0].nearestDoor()).toBeNull();
    sc.players[0].equip = 'crowbar';
    hold(h, sc, 0, Btn.A, 4);
    expect(v.salvaged).toBe(1);
    expect(c.garage.includes(v.build!)).toBe(false);
  });

  it('a second player can ride along as a passenger in a convoy car', () => {
    const { sc } = leg();
    const v = carBeside(sc, 'sedan');
    sc.players[0].tryEnter();
    run(sc, 1);
    expect(sc.players[0].state).toBe('driving');
    const p2 = sc.players[1];
    p2.exitVehicle(false);
    const g = v.gunnerPos();
    p2.placeAt(g[0] + 0.6, g[2], 0);
    expect(p2.nearestDoor()?.seat).toBe('gunner');
    expect(p2.tryEnter()).toBe(true);
    run(sc, 1);
    expect(p2.state).toBe('gunner');
    expect(v.passenger?.index).toBe(1);
  });

  it('a passenger can look from their own seat in first person, hidden from their own view only', () => {
    const { h, sc } = leg();
    const v = carBeside(sc, 'sedan');
    sc.players[0].tryEnter();
    run(sc, 1);
    const p2 = sc.players[1];
    p2.exitVehicle(false);
    const g = v.gunnerPos();
    p2.placeAt(g[0] + 0.6, g[2], 0);
    expect(p2.tryEnter()).toBe(true);
    run(sc, 1);
    expect(p2.state).toBe('gunner');
    p2.toggleView();
    expect(p2.firstPerson).toBe(true);
    for (let i = 0; i < 5; i++) sc.renderFrame(1, DT);
    const cam = h.R.views[1].camera;
    // The eyes are in the passenger seat of the sedan: within the car's footprint and above the seat.
    expect(Math.hypot(cam.position.x - v.position.x, cam.position.z - v.position.z)).toBeLessThan(2.3);
    expect(cam.position.y).toBeGreaterThan(v.position.y);
    const occ = v.visual.passenger!;
    (h.R.onBeforeView[2] as (i: number) => void)(1);
    expect(occ.root.visible).toBe(false);
    (h.R.onAfterView[0] as (i: number) => void)(1);
    expect(occ.root.visible).toBe(true);
    // The driver's own view (player 0, third person) never hides the passenger.
    (h.R.onBeforeView[2] as (i: number) => void)(0);
    expect(occ.root.visible).toBe(true);
    (h.R.onAfterView[0] as (i: number) => void)(0);
  });
});

describe('the fleet is saved with the campaign', () => {
  it('commits condition and fuel back to builds, keeps what you drove, and loses wrecks', () => {
    const { sc, c } = leg();
    const v = carBeside(sc, 'sedan');
    sc.players[0].tryEnter();
    run(sc, 1);
    v.health.hp = v.health.maxHp * 0.4;
    v.health.comp.tires[3] = 0;
    v.fuel = v.tankMax * 0.25;
    const old = sc.players[0].ownVehicle === v ? c.buildByUid(c.players[0].vehicle) : null;
    const moped = sc.vehicles.find((q) => q.faction === 'convoy' && q.def.id === 'moped' && q.ownerIndex === 0)!;
    const lost = sc.players[1].vehicle!;
    lost.takeHit(99999, lost.position.x, lost.position.z + 4, {});
    run(sc, 0.2);
    expect(lost.wreck).toBe(true);
    const names = sc.commitFleet();
    expect(names).toEqual([lost.def.name]);
    expect(c.buildByUid(lost.build!.uid)).toBeUndefined();
    expect(c.players[0].vehicle).toBe(v.build!.uid);
    expect(v.build!.hp).toBeCloseTo(0.4, 1);
    expect(v.build!.comp.tires[3]).toBe(0);
    expect(v.build!.fuel).toBeCloseTo(0.25, 1);
    // The old moped is still in the yard; player 1 gets a vehicle even though theirs was lost.
    expect(c.garage).toContain(moped.build);
    expect(old).toBeDefined();
    expect(c.buildOf(1).uid).not.toBe(c.buildOf(0).uid);
  });

  it('a save made after claiming a car restores it', async () => {
    const { Campaign } = await import('../src/game/campaign');
    const { sc, c } = leg();
    const v = carBeside(sc, 'pickup');
    v.build!.fit.front = newPart('fr_blade');
    sc.players[0].tryEnter();
    run(sc, 1);
    sc.commitFleet();
    const back = Campaign.deserialize(JSON.parse(JSON.stringify(c.serialize())));
    expect(back.buildOf(0).chassis).toBe('pickup');
    expect(back.buildOf(0).fit.front?.id).toBe('fr_blade');
  });
});

describe('part pickups', () => {
  it('driving over a part leaves it on the ground', () => {
    const { sc, c } = leg();
    const p = sc.players[0];
    const pos = p.vehicle!.position;
    sc.loose!.drop(pos.x, pos.z, { kind: 'part', item: newPart('eng_v6', 0.7) });
    run(sc, 0.5);
    expect(c.inventory.length).toBe(0);
  });
});