import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initPhysics, PhysicsWorld, type Collider } from '../src/physics/physics';
import { legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { playerShows } from '../src/game/sight';
import { Vegetation } from '../src/render/vegetation';
import { FIRE, SIGHT, aimSpread, fighting, inSight, mayFire, newWatch, sightRate, stepWatch, type Look } from '../src/sim/enemySight';
import { fakeServices, run } from './helpers/sim';

vi.setConfig({ testTimeout: 240000 });

beforeAll(async () => {
  await initPhysics();
});

const open: Look = { d: 50, show: 1, speed: 1.4, crouch: false, dark: 0, weather: 1, hunting: false };

describe('raider sight rules', () => {
  it('a crouched, still person is picked out nearer than a walker, and a hidden one not at all', () => {
    const walker = sightRate({ ...open, d: 70 });
    const crouched = sightRate({ ...open, d: 70, crouch: true, speed: 0 });
    expect(walker).toBeGreaterThan(0);
    expect(crouched).toBe(0);
    expect(sightRate({ ...open, d: 20, crouch: true, speed: 0 })).toBeGreaterThan(0);
    // Down in a bush or behind a rock: nothing to see, until they are right on top of you.
    expect(sightRate({ ...open, d: 10, show: SIGHT.minShow * 0.9 })).toBe(0);
    expect(sightRate({ ...open, d: SIGHT.touch * 0.5, show: 0 })).toBeGreaterThan(0);
    // A head over a rock is seen only nearer than the whole of someone.
    expect(sightRate({ ...open, d: 60, show: 0.3 })).toBe(0);
    expect(sightRate({ ...open, d: 25, show: 0.3 })).toBeGreaterThan(0);
  });

  it('noticing takes a while; then a beat before the first shot, and the first rounds go wide', () => {
    const w = newWatch();
    const rate = sightRate({ ...open, d: 45 });
    let t = 0;
    while (w.aware < 1 && t < 10) {
      stepWatch(w, 0.25, { who: 0, x: 0, z: 45, rate }, null, 0.5);
      t += 0.25;
    }
    expect(t).toBeGreaterThan(0.5);
    expect(inSight(w)).toBe(true);
    expect(mayFire(w)).toBe(false);
    const cold = aimSpread(w, 0);
    expect(cold).toBeCloseTo(FIRE.cold);
    for (let i = 0; i < 8; i++) stepWatch(w, 0.25, { who: 0, x: 0, z: 45, rate }, null, 0.5);
    expect(mayFire(w)).toBe(true);
    expect(aimSpread(w, 0)).toBeLessThan(cold * 0.7);
    // Running makes them harder to hit.
    expect(aimSpread(w, 5)).toBeGreaterThan(aimSpread(w, 0));
  });

  it('lose sight and it fires only a moment longer, hunts a while, then gives up', () => {
    const w = newWatch();
    for (let i = 0; i < 40; i++) stepWatch(w, 0.25, { who: 0, x: 3, z: 30, rate: 3 }, null, 0);
    expect(mayFire(w)).toBe(true);
    stepWatch(w, 0.25, null, null, 0);
    expect(mayFire(w)).toBe(true);
    for (let i = 0; i < 4; i++) stepWatch(w, 0.25, null, null, 0);
    expect(mayFire(w)).toBe(false);
    expect(fighting(w)).toBe(true);
    expect([w.x, w.z]).toEqual([3, 30]);
    // Back in sight: aim runs cold again.
    stepWatch(w, 0.25, { who: 0, x: 4, z: 30, rate: 3 }, null, 0);
    expect(aimSpread(w, 0)).toBeGreaterThan(FIRE.cold * 0.9);
    for (let i = 0; i < 60 + FIRE.forget * 4; i++) stepWatch(w, 0.25, null, null, 0);
    expect(fighting(w)).toBe(false);
  });

  it('a heard shot brings it to look, but it will not fire at a noise', () => {
    const w = newWatch();
    for (let i = 0; i < 20; i++) stepWatch(w, 0.25, null, { who: 1, x: 10, z: 50 }, 0);
    expect(w.who).toBe(1);
    expect(w.aware).toBeCloseTo(SIGHT.heardAware);
    expect(w.aware).toBeLessThan(1);
    expect(mayFire(w)).toBe(false);
  });
});

describe('bushes on a sight line', () => {
  /** One shrub instance (crossed cards 1.5 m wide, 1.15 m tall, scaled by `s`) at the origin. */
  function shrub(s: number) {
    const P = new PhysicsWorld();
    const veg = new Vegetation(P);
    const geo = new THREE.BoxGeometry(1.5, 1.15, 1.5).translate(0, 0.575, 0);
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial(), 1);
    mesh.setMatrixAt(0, new THREE.Matrix4().makeScale(s, s, s));
    const [plant] = veg.addInstances(mesh, 'shrubs');
    return { veg, plant };
  }

  it('a big bush between hides a crouched body behind it; a line past it or over it is clear', () => {
    const { veg } = shrub(1.6);
    // Through its heart at chest height of someone crouched just behind it.
    expect(veg.seeThrough(0, 1.5, -30, 0, 0.8, 0.6)).toBeLessThan(0.15);
    // Off to the side, and over the top.
    expect(veg.seeThrough(4, 1.5, -30, 4, 0.8, 0.6)).toBe(1);
    expect(veg.seeThrough(0, 2.6, -30, 0, 2.6, 0.6)).toBe(1);
  });

  it('a trampled bush hides nobody, and grass never did', () => {
    const { veg, plant } = shrub(1.6);
    plant.record.broken = true;
    expect(veg.seeThrough(0, 1.5, -30, 0, 0.8, 0.6)).toBe(1);
    const P = new PhysicsWorld();
    const grass = new Vegetation(P);
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.6, 1).translate(0, 0.3, 0), new THREE.MeshBasicMaterial(), 1);
    mesh.setMatrixAt(0, new THREE.Matrix4().makeScale(3, 3, 3));
    grass.addInstances(mesh, 'grass');
    expect(grass.seeThrough(0, 1.5, -30, 0, 0.8, 0.6)).toBe(1);
  });
});

describe('raiders in play', () => {
  /** A leg with both players on foot; player 1 is kept out of it. */
  function leg() {
    const h = fakeServices();
    const sc = new LegScene(h.svc, legById('L1'));
    for (const p of sc.players) p.exitVehicle(false);
    run(sc, 0.6);
    sc.players[1].invuln = 1e9;
    return sc;
  }

  /** Open, flat-ish ground well away from the convoy's vehicles, where a gunman 25 m north sees the player whole. */
  function stage(sc: LegScene) {
    const v = sc.players[0].vehicle ?? sc.vehicles[0];
    const p = sc.players[0];
    const base = v ? { x: v.position.x, z: v.position.z } : { x: p.pos.x, z: p.pos.z };
    for (let k = 0; k < 40; k++) {
      const x = base.x + 230 + (k % 8) * 18;
      const z = base.z + Math.floor(k / 8) * 25;
      p.placeAt(x, z);
      p.crouch = true;
      run(sc, 1.2);
      const gx = x;
      const gz = z + 25;
      const show = playerShows(sc, gx, sc.groundAt(gx, gz) + 1.55, gz, p);
      if (show.show > 0.9 && Math.abs(sc.groundAt(gx, gz) - sc.groundAt(x, z)) < 1.5) return { x, z, gx, gz };
    }
    throw new Error('no open ground found');
  }

  function raiderShots(sc: LegScene) {
    const shots: { t: number; spread: number }[] = [];
    const shoot = sc.combat.shoot.bind(sc.combat);
    sc.combat.shoot = ((...a: Parameters<typeof shoot>) => {
      if (a[6].side === 'raider') shots.push({ t: sc.time, spread: a[6].spread ?? 0 });
      return shoot(...a);
    }) as typeof shoot;
    return shots;
  }

  it('a gunman holds fire on someone behind a wall, then takes a beat and fires wide once they are in the open', () => {
    const sc = leg();
    const { x, z, gx, gz } = stage(sc);
    const p = sc.players[0];
    // A wall between them, 2 m in front of the player.
    const wy = sc.groundAt(x, z + 2);
    const wall: Collider = sc.P.addStaticBox(x, wy + 1.2, z + 2, 3, 1.2, 0.2);
    run(sc, 0.1);
    const shots = raiderShots(sc);
    const u = sc.raiders.spawnInfantry('gunman', gx, gz);
    run(sc, 6, () => p.placeAt(x, z));
    expect(shots.length).toBe(0);
    expect(inSight(u.watch)).toBe(false);
    // The wall goes: out in the open.
    sc.P.removeCollider(wall);
    const t0 = sc.time;
    run(sc, 6, () => p.placeAt(x, z));
    expect(shots.length).toBeGreaterThan(0);
    expect(shots[0].t - t0).toBeGreaterThan(0.5);
    // The first round is thrown wider than the ones after its aim has settled.
    expect(shots[0].spread).toBeGreaterThan(shots[shots.length - 1].spread * 1.4);
    sc.dispose();
  });

  it('a gunman does not fire into a thicket someone is crouched in', () => {
    const sc = leg();
    const { x, z, gx, gz } = stage(sc);
    const p = sc.players[0];
    // Stand in for a dense bush on every sight line.
    sc.leavesAlong = () => 0.95;
    const shots = raiderShots(sc);
    sc.raiders.spawnInfantry('gunman', gx, gz);
    run(sc, 6, () => p.placeAt(x, z));
    expect(shots.length).toBe(0);
    sc.dispose();
  });
});
