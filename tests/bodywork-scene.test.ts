import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { newBuild, type VehicleBuild } from '../src/sim/garage';
import { newPart } from '../src/sim/parts';
import { fakeServices } from './helpers/sim';
import type { Vehicle, Pilot } from '../src/game/vehicle';
import type { DriveInput } from '../src/physics/vehicle';

vi.setConfig({ testTimeout: 120000 });

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

/** An AI hand on the wheel that holds one input. */
const holding = (d: Partial<DriveInput>): Pilot => ({ isPlayer: false, index: 0, drive: () => ({ steer: 0, throttle: 0, brake: 0, handbrake: false, ...d }) });

/** A car parked beside the start, a little way off the road. */
function car(sc: LegScene, build: VehicleBuild, dx = 14, dz = 6, yaw = 0, faction: 'neutral' | 'convoy' = 'neutral'): Vehicle {
  const st = sc.src.layout.start;
  const x = st.x + dx;
  const z = st.z + dz;
  const v = sc.spawnVehicle({ build, x, z, y: sc.groundAt(x, z), yaw, ownerIndex: faction === 'convoy' ? 0 : -1, faction });
  run(sc, 1.5);
  return v;
}

/** A thick wall straight ahead of a vehicle, across its path. */
function wallAhead(sc: LegScene, v: Vehicle, dist: number) {
  const f = v.body.forward();
  const x = v.position.x + f[0] * dist;
  const z = v.position.z + f[2] * dist;
  sc.P.addStaticBox(x, sc.groundAt(x, z) + 2, z, 9, 4, 0.6, v.yaw);
  return { x, z };
}

/**
 * Give a vehicle speed the way a launch would: the velocity and what the impact detector last saw, so setting it is not
 * itself read as a crash.
 */
function launch(v: Vehicle, speed: number) {
  const f = v.body.forward();
  const lv = { x: f[0] * speed, y: 0, z: f[2] * speed };
  v.body.body.setLinvel(lv, true);
  (v.body as unknown as { prevVel: typeof lv }).prevVel = { ...lv };
}

/** Throw a vehicle at a wall at `speed` m/s from close range. */
function crash(sc: LegScene, v: Vehicle, speed: number) {
  v.driver = holding({ throttle: 1 });
  v.setEngine(true);
  wallAhead(sc, v, 12);
  launch(v, speed);
  run(sc, 1.6);
  v.driver = null;
}

describe('a crash bends the car and tears off what was bolted on', () => {
  it('a head-on wall crash dents the nose where it hit and leaves the tail straight', () => {
    const { sc } = leg();
    const v = car(sc, newBuild('sedan', { seed: 11 }));
    expect(v.bodywork.hull).toBeNull();
    crash(sc, v, 20);
    const hull = v.bodywork.hull!;
    expect(hull).not.toBeNull();
    expect(hull.events.length).toBeGreaterThan(0);
    // The dent is on the nose: forward of the middle, pushed backward.
    const front = hull.events.filter((e) => e.at[2] > 0.8 && e.push[2] < -0.5);
    expect(front.length).toBeGreaterThan(0);
    expect(hull.level()).toBeGreaterThan(0.05);
    // The body mesh the vehicle draws is its own copy, and has really moved.
    expect(v.visual.body.geometry).toBe(hull.geo);
    hull.update(Infinity);
    const rest = (v.visual.body.geometry.userData.parts as unknown[]).length;
    expect(rest).toBeGreaterThan(0);
  });

  it('a gentle bump does not mark it', () => {
    const { sc } = leg();
    const v = car(sc, newBuild('hatch', { seed: 4 }));
    // Rolling up to a wall at a walking pace, not driving into it.
    v.driver = holding({});
    v.setEngine(true);
    wallAhead(sc, v, 6);
    launch(v, 3);
    run(sc, 2);
    expect(v.bodywork.hull?.events.length ?? 0).toBe(0);
    expect(sc.debris.pieces.length).toBe(0);
  });

  it('a hard front hit rips the bull bar off: the stats go with it and it lies in the road as a physical piece', () => {
    const { sc } = leg();
    const b = newBuild('sedan', { seed: 12 });
    b.fit.front = newPart('fr_bull', 0.9);
    const v = car(sc, b);
    expect(v.stats.plow).toBeGreaterThan(0);
    const plowBefore = v.stats.plow;
    crash(sc, v, 24);
    expect(b.fit.front).toBeUndefined();
    expect(v.stats.plow).toBeLessThan(plowBefore);
    const piece = sc.debris.pieces.find((p) => p.tag === 'slot:front');
    expect(piece).toBeDefined();
    expect(piece!.item!.id).toBe('fr_bull');
    expect(piece!.item!.cond).toBeLessThan(0.9);
    // It is a real body: the physics holds it on the ground, clear of the car it came off.
    expect(piece!.collider).toBeDefined();
    run(sc, 6);
    const t1 = piece!.body.translation();
    expect(Number.isFinite(t1.x)).toBe(true);
    expect(t1.y).toBeGreaterThan(sc.groundAt(t1.x, t1.z) - 0.3);
    expect(t1.y).toBeLessThan(sc.groundAt(t1.x, t1.z) + 3);
    expect(Math.hypot(t1.x - v.position.x, t1.z - v.position.z)).toBeGreaterThan(0.8);
    // Settled, it can be lifted like any loose part, and is gone from the road once taken.
    run(sc, 12);
    expect(piece!.rest).toBeGreaterThan(0.8);
    const near = sc.loose!.nearest(t1.x, t1.z, 3);
    expect(near).not.toBeNull();
    expect(near!.carried.kind).toBe('part');
    const taken = sc.loose!.take(near!.id);
    expect(taken).not.toBeNull();
    expect(taken!.kind === 'part' && taken!.item.id).toBe('fr_bull');
    expect(sc.debris.pieces.includes(piece!)).toBe(false);
  });

  it('a two-sided module loses both halves, the second a moment after the first', () => {
    const { sc } = leg();
    const b = newBuild('pickup', { seed: 13 });
    b.fit.side = newPart('sd_plate', 1);
    const v = car(sc, b);
    const tags = v.bodywork.partStates().filter((p) => p.slot === 'side');
    expect(tags.length).toBe(2);
    v.bodywork.strainPart(tags[0].tag, 1.4, [1, 0, 0]);
    expect(b.fit.side).toBeUndefined();
    run(sc, 1.5);
    const sides = sc.debris.pieces.filter((p) => p.tag.startsWith('slot:side'));
    expect(sides.length).toBe(2);
    // Only one of them carries the part: the item is not duplicated.
    expect(sides.filter((p) => p.item).length).toBe(1);
  });

  it('a door can be torn off, and the car remembers it is gone', () => {
    const { sc } = leg();
    const b = newBuild('hatch', { seed: 5 });
    const v = car(sc, b);
    expect(v.bodywork.strainPart('door:1', 1.5, [0, 0, 1])).toBe(true);
    run(sc, 0.5);
    expect(sc.debris.pieces.some((p) => p.tag === 'door:1')).toBe(true);
    expect(v.bodywork.missing()).toBe(1);
    v.commit();
    expect(b.body!.gone).toContain('door:1');
    // Put the car away and bring it back: still no door, and the body does not heal.
    const again = car(sc, JSON.parse(JSON.stringify(b)) as VehicleBuild, 22, 6);
    expect(again.bodywork.missing()).toBe(1);
    expect(again.bodywork.partStates().find((p) => p.tag === 'door:1')!.state).toBe('gone');
    // A weld job puts it back.
    expect(again.bodywork.restoreOne()).toMatch(/door/i);
    expect(again.bodywork.missing()).toBe(0);
  });

  it('a part works loose first: it rattles on its joint before it goes', () => {
    const { sc } = leg();
    const v = car(sc, newBuild('sedan', { seed: 14 }));
    v.bodywork.strainPart('mirror:1', 0.7);
    const s = v.bodywork.partStates().find((p) => p.tag === 'mirror:1')!;
    expect(s.state).toBe('loose');
    expect(sc.debris.pieces.length).toBe(0);
    v.bodywork.strainPart('mirror:1', 0.4);
    expect(sc.debris.pieces.some((p) => p.tag === 'mirror:1')).toBe(true);
  });

  it('a wrecked car throws parts clear of the blast', () => {
    const { sc } = leg();
    const b = newBuild('sedan', { seed: 15 });
    b.fit.roof = newPart('rf_rack', 1);
    b.fit.rear = newPart('rr_spare', 1);
    const v = car(sc, b);
    v.takeHit(99999, v.position.x + 2, v.position.z, { incendiary: true });
    run(sc, 0.2);
    expect(v.wreck).toBe(true);
    expect(sc.debris.pieces.length).toBeGreaterThan(0);
  });

  it('a spare wheel is round and rolls', () => {
    const { sc } = leg();
    const b = newBuild('sedan', { seed: 16 });
    b.fit.rear = newPart('rr_spare', 1);
    const v = car(sc, b);
    v.bodywork.strainPart('slot:rear', 1.5, [0, 0, -1]);
    const piece = sc.debris.pieces.find((p) => p.tag === 'slot:rear')!;
    expect(piece).toBeDefined();
    expect(piece.collider.shape.type).toBe(10);
  });

  it('a hit from a bullet dents a little and a blast folds a panel and loosens what is near it', () => {
    const { sc } = leg();
    const v = car(sc, newBuild('sedan', { seed: 17 }));
    v.takeHit(10, v.position.x + 6, v.position.z, { at: [v.position.x + 0.9, v.position.y + 0.1, v.position.z] });
    const small = v.bodywork.hull!.events[0];
    expect(small.depth).toBeLessThan(0.05);
    v.takeHit(60, v.position.x, v.position.z + 3.5, { ram: true, blast: 0.9 });
    const big = v.bodywork.hull!.events.reduce((a, e) => Math.max(a, e.depth), 0);
    expect(big).toBeGreaterThan(0.15);
    // A collision does not dent through this path (its dent is placed from the real contact point).
    const w = car(sc, newBuild('sedan', { seed: 18 }), 24, 6);
    w.takeHit(30, w.position.x, w.position.z + 3, { ram: true, silent: true });
    expect(w.bodywork.hull).toBeNull();
  });
});

describe('what comes off is an obstacle', () => {
  it('a car that drives into a tall piece lying in the road shoves it clear, and feels it', () => {
    const { sc } = leg();
    const st = sc.src.layout.start;
    const x = st.x + 16;
    const z = st.z + 60;
    // A bull bar's worth of scrap, standing on end: taller than the car's ground clearance.
    const geo = new THREE.BoxGeometry(0.5, 1.0, 1.4);
    const piece = sc.debris.spawn({
      geo,
      material: new THREE.MeshBasicMaterial(),
      pos: new THREE.Vector3(x, sc.groundAt(x, z) + 0.7, z),
      quat: new THREE.Quaternion(),
      vel: new THREE.Vector3(),
      spin: new THREE.Vector3(),
      centre: [0, 0, 0],
      half: [0.25, 0.5, 0.7],
      mass: 40,
      tag: 'test',
    });
    run(sc, 3);
    expect(piece.rest).toBeGreaterThan(0.5);
    const t = piece.body.translation();
    const b = sc.spawnVehicle({ build: newBuild('sedan', { seed: 52 }), x: t.x, z: t.z - 30, y: sc.groundAt(t.x, t.z - 30) + 0.3, yaw: 0, ownerIndex: -1, faction: 'neutral' });
    run(sc, 1.5);
    b.driver = holding({ throttle: 1 });
    b.setEngine(true);
    launch(b, 14);
    let before = 0;
    let after = 99;
    let flung = 0;
    for (let i = 0; i < 240; i++) {
      sc.tick(DT);
      const gap = t.z - b.position.z;
      if (gap > 3.2) before = b.speed;
      else after = Math.min(after, b.speed);
      const lv = piece.body.linvel();
      flung = Math.max(flung, Math.hypot(lv.x, lv.z));
    }
    expect(flung).toBeGreaterThan(3);
    expect(after).toBeLessThan(before - 0.5);
  });

  it('low scrap does not stop a car but its wheels stand on it as they pass', () => {
    const { sc } = leg();
    const st = sc.src.layout.start;
    const x = st.x + 16;
    const z = st.z + 60;
    const geo = new THREE.BoxGeometry(1.6, 0.16, 1.4);
    const piece = sc.debris.spawn({
      geo,
      material: new THREE.MeshBasicMaterial(),
      pos: new THREE.Vector3(x, sc.groundAt(x, z) + 0.3, z),
      quat: new THREE.Quaternion(),
      vel: new THREE.Vector3(),
      spin: new THREE.Vector3(),
      centre: [0, 0, 0],
      half: [0.8, 0.08, 0.7],
      mass: 20,
      tag: 'test',
    });
    run(sc, 3);
    const b = sc.spawnVehicle({ build: newBuild('sedan', { seed: 55 }), x, z: z - 25, y: sc.groundAt(x, z - 25) + 0.3, yaw: 0, ownerIndex: -1, faction: 'neutral' });
    run(sc, 1.5);
    b.driver = holding({ throttle: 0.5 });
    b.setEngine(true);
    launch(b, 12);
    let stood = false;
    const body = b.body as unknown as { ctl: { wheelGroundObject(i: number): { handle: number } | null }; wheelCount: number };
    for (let i = 0; i < 200; i++) {
      sc.tick(DT);
      for (let w = 0; w < body.wheelCount; w++) if (body.ctl.wheelGroundObject(w)?.handle === piece.collider.handle) stood = true;
    }
    // It was not a wall: the car came through still moving, with a wheel on the slab as it went.
    expect(b.speed).toBeGreaterThan(8);
    expect(stood).toBe(true);
  });

  it('raider wagons shed their armour plates too, which are only scrap', () => {
    const { sc } = leg();
    const st = sc.src.layout.start;
    const w = sc.raiders.spawnWagon(st.x + 40, st.z + 30, 0);
    run(sc, 1);
    const tags = w.bodywork.partStates().map((p) => p.tag);
    expect(tags.some((t) => t.startsWith('sign:'))).toBe(true);
    w.bodywork.strainPart(tags.find((t) => t.startsWith('sign:'))!, 1.6, [1, 0, 0]);
    const piece = sc.debris.pieces.find((p) => p.tag.startsWith('sign:'))!;
    expect(piece).toBeDefined();
    expect(piece.item).toBeNull();
  });

  it('a fitted part that comes off where nothing can be lifted goes into the trunk instead', () => {
    const { sc, c } = leg();
    const b = newBuild('sedan', { seed: 53 });
    b.fit.front = newPart('fr_blade', 1);
    const v = car(sc, b, 14, 6, 0, 'convoy');
    // The camp arena and the caves cannot lift anything off the ground.
    (sc as unknown as { loose: undefined }).loose = undefined;
    const before = c.inventory.length;
    v.bodywork.strainPart('slot:front', 1.5, [0, 0, 1]);
    expect(c.inventory.length).toBe(before + 1);
    expect(c.inventory[c.inventory.length - 1].id).toBe('fr_blade');
    expect(sc.debris.pieces.find((p) => p.tag === 'slot:front')!.item).toBeNull();
  });

  it('a piece left behind with a part in it becomes an ordinary pickup rather than vanishing', () => {
    const { sc } = leg();
    const b = newBuild('sedan', { seed: 54 });
    b.fit.rear = newPart('rr_box', 1);
    const v = car(sc, b);
    v.bodywork.strainPart('slot:rear', 1.5, [0, 0, -1]);
    const piece = sc.debris.pieces.find((p) => p.tag === 'slot:rear')!;
    const at = piece.body.translation();
    const x = at.x;
    const z = at.z;
    sc.debris.remove(piece, true);
    run(sc, 0.2);
    expect(sc.debris.pieces.includes(piece)).toBe(false);
    const found = sc.loose!.nearest(x, z, 3);
    expect(found).not.toBeNull();
    expect(found!.carried.kind === 'part' && found!.carried.item.id).toBe('rr_box');
  });
});

describe('the body is remembered', () => {
  it('dents, mud and loose joints survive a commit, a JSON round trip and a respawn', () => {
    const { sc } = leg();
    const b = newBuild('sedan', { seed: 21 });
    const v = car(sc, b);
    v.bodywork.strainPart('mirror:-1', 0.7);
    // A blast from behind: it is a long way from the mirror.
    v.bodywork.hit({ dmg: 60, srcX: v.position.x, srcZ: v.position.z - 4, blast: 0.8 });
    v.bodywork.dirt.mud = 0.6;
    v.bodywork.dirt.blood = 0.3;
    v.commit();
    const saved = JSON.parse(JSON.stringify(b)) as VehicleBuild;
    expect(saved.body!.dents.length).toBeGreaterThan(0);
    expect(saved.body!.dirt[0]).toBeCloseTo(0.6, 2);
    expect(saved.body!.stress['mirror:-1']).toBeGreaterThan(0.5);
    const back = car(sc, saved, 24, 6);
    expect(back.bodywork.hull!.events.length).toBe(saved.body!.dents.length);
    expect(back.bodywork.dirt.mud).toBeCloseTo(0.6, 2);
    expect(back.bodywork.dirt.blood).toBeCloseTo(0.3, 2);
    expect(back.bodywork.partStates().find((p) => p.tag === 'mirror:-1')!.state).toBe('loose');
    // A clean car keeps nothing.
    const clean = newBuild('hatch', { seed: 22 });
    const c = car(sc, clean, 30, 6);
    c.commit();
    expect(clean.body).toBeUndefined();
  });

  it('goes into the save file with the garage and comes back out of it', async () => {
    const { Campaign } = await import('../src/game/campaign');
    const { sc, c } = leg();
    const b = newBuild('sedan', { seed: 61 });
    c.garage.push(b);
    const v = car(sc, b, 14, 6, 0, 'convoy');
    v.bodywork.hit({ dmg: 70, srcX: v.position.x, srcZ: v.position.z + 4, blast: 0.9 });
    v.bodywork.dirt.mud = 0.5;
    v.bodywork.strainPart('mirror:1', 1.4);
    v.commit();
    const json = JSON.stringify(c.serialize());
    const back = Campaign.deserialize(JSON.parse(json));
    const kept = back.garage.find((g) => g.uid === b.uid)!;
    expect(kept.body).toBeDefined();
    expect(kept.body!.dents.length).toBeGreaterThan(0);
    expect(kept.body!.dirt[0]).toBeCloseTo(0.5, 2);
    expect(kept.body!.gone).toContain('mirror:1');
  });

  it('hammering the dents out straightens the body, and a rebuild (refit) keeps what is left', () => {
    const { sc } = leg();
    const b = newBuild('sedan', { seed: 23 });
    const v = car(sc, b, 14, 6, 0, 'convoy');
    v.bodywork.hit({ dmg: 80, srcX: v.position.x, srcZ: v.position.z + 4, blast: 1 });
    expect(v.bodywork.dentLevel()).toBeGreaterThan(0.1);
    const before = v.bodywork.dentLevel();
    v.bodywork.straighten();
    expect(v.bodywork.dentLevel()).toBeLessThan(before);
    const left = v.bodywork.hull!.events.length;
    // Fitting a part rebuilds the model: the dents are laid back on the new one.
    b.fit.roof = newPart('rf_light', 1);
    v.syncFromBuild();
    expect(v.bodywork.hull).not.toBeNull();
    expect(v.bodywork.hull!.events.length).toBe(left);
    expect(v.visual.body.geometry).toBe(v.bodywork.hull!.geo);
    for (let i = 0; i < 6; i++) v.bodywork.straighten();
    expect(v.bodywork.dentLevel()).toBeLessThan(0.06);
  });
});

describe('mud, dust and blood on the paint', () => {
  it('driving through mud cakes the car and a river washes it clean', () => {
    const { sc } = leg();
    const v = car(sc, newBuild('hatch', { seed: 31 }));
    const surf = sc.surfaceAt.bind(sc);
    sc.surfaceAt = () => ({ grip: 0.7, drag: 0, name: 'mud' });
    v.driver = holding({ throttle: 1 });
    v.setEngine(true);
    run(sc, 12);
    expect(v.speed).toBeGreaterThan(5);
    expect(v.bodywork.dirt.mud).toBeGreaterThan(0.15);
    sc.surfaceAt = surf;
    // Soaked to the axles.
    const wet = sc.waterAt.bind(sc);
    sc.waterAt = (x: number, z: number) => ({ level: sc.groundAt(x, z) + 3, depth: 3, flow: [0, 0] });
    v.bodywork.dirt.mud = 0.9;
    run(sc, 4);
    sc.waterAt = wet;
    expect(v.bodywork.dirt.mud).toBeLessThan(0.5);
  });

  it('running down a zombie leaves blood on the nose', () => {
    const { sc } = leg();
    const v = car(sc, newBuild('pickup', { seed: 32 }), 14, 6, 0, 'convoy');
    v.driver = holding({ throttle: 1 });
    v.setEngine(true);
    const f = v.body.forward();
    run(sc, 3);
    const pos = v.position;
    for (let i = 0; i < 6; i++) sc.zombies.spawn('walker', pos.x + f[0] * (10 + i * 2.5), pos.z + f[2] * (10 + i * 2.5), false);
    launch(v, 14);
    run(sc, 3);
    expect(v.bodywork.dirt.blood).toBeGreaterThan(0.03);
  });
});

describe('tyre marks laid by real wheels', () => {
  it('a car driving along soft ground leaves grooves behind each wheel', () => {
    const { sc } = leg();
    const v = car(sc, newBuild('hatch', { seed: 41 }));
    sc.surfaceAt = () => ({ grip: 0.8, drag: 0, name: 'sand' });
    const before = sc.marks.count;
    v.driver = holding({ throttle: 1 });
    v.setEngine(true);
    run(sc, 6);
    sc.marks.update(DT);
    const laid = sc.marks.count - before;
    // Four tyres, several metres of travel at a segment every half metre or so: a few dozen at least.
    expect(laid).toBeGreaterThan(30);
  });

  it('asphalt takes nothing from a rolling car and a black skid from a locked wheel', () => {
    const { sc } = leg();
    const v = car(sc, newBuild('sedan', { seed: 42 }));
    sc.surfaceAt = () => ({ grip: 1, drag: 0, name: 'asphalt' });
    v.driver = holding({ throttle: 0.6 });
    v.setEngine(true);
    run(sc, 5);
    const rolling = sc.marks.count;
    expect(rolling).toBe(0);
    v.driver = holding({ throttle: 0, brake: 1 });
    run(sc, 2);
    expect(sc.marks.count).toBeGreaterThan(0);
  });

  it('marks are only laid near a player', () => {
    const { sc } = leg();
    const v = car(sc, newBuild('hatch', { seed: 43 }), 600, 6);
    sc.surfaceAt = () => ({ grip: 0.8, drag: 0, name: 'sand' });
    v.driver = holding({ throttle: 1 });
    v.setEngine(true);
    run(sc, 4);
    expect(sc.marks.count).toBe(0);
  });
});

describe('the open world remembers the road overnight', () => {
  it('tyre marks and a part left in the road are still there the next morning', async () => {
    const { WorldMemory } = await import('../src/game/worldMemory');
    const memory = new WorldMemory();
    const h = fakeServices();
    const sc = new LegScene(h.svc, legById('W'), { memory });
    sc.pendingResult = true;
    run(sc, 1);
    // Today's driving: a car in the sand, and a bull bar torn off in the road.
    const p = sc.players[0].vehicle!;
    const b = newBuild('sedan', { seed: 71 });
    b.fit.front = newPart('fr_bull', 0.8);
    const x = p.position.x + 14;
    const z = p.position.z + 20;
    const v = sc.spawnVehicle({ build: b, x, z, y: sc.groundAt(x, z), yaw: 0, ownerIndex: -1, faction: 'neutral' });
    run(sc, 1.5);
    sc.surfaceAt = () => ({ grip: 0.8, drag: 0, name: 'sand' });
    v.driver = holding({ throttle: 0.8 });
    v.setEngine(true);
    run(sc, 4);
    v.driver = null;
    v.bodywork.strainPart('slot:front', 1.5, [0, 0, 1]);
    run(sc, 6);
    const laid = sc.marks.count;
    expect(laid).toBeGreaterThan(20);
    const piece = sc.debris.pieces.find((q) => q.tag === 'slot:front')!;
    const at = piece.body.translation();
    sc.capture(memory);
    expect(memory.tracks).not.toBeNull();
    expect(memory.drops.length).toBe(1);
    sc.dispose();

    // Next morning: a new scene adopts the memory.
    const h2 = fakeServices();
    const next = new LegScene(h2.svc, legById('W'), { memory });
    next.pendingResult = true;
    expect(next.marks.count).toBe(laid);
    const found = next.loose!.nearest(memory.drops[0].x, memory.drops[0].z, 2);
    expect(found).not.toBeNull();
    expect(found!.carried.kind === 'part' && found!.carried.item.id).toBe('fr_bull');
    expect(Math.hypot(found!.x - at.x, found!.z - at.z)).toBeLessThan(0.5);
    next.dispose();
  });
});
