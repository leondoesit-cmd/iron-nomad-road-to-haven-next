import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { rayCapsule } from '../src/game/raiders';
import { BULLET_FLOOR, applyHit, newHealth } from '../src/sim/damage';
import { structuralMul } from '../src/sim/breach';
import { fakeServices } from './helpers/sim';
import type { Vehicle } from '../src/game/vehicle';

vi.setConfig({ testTimeout: 90000 });

beforeAll(async () => {
  await initPhysics();
});

const DT = 1 / 60;
const PISTOL = structuralMul('pistol', 'sheet');
const RIFLE = structuralMul('rifle', 'sheet');

describe('bullets against a car (rules)', () => {
  it('a magazine of pistol rounds through the doors holes a hatchback but does not finish it', () => {
    const h = newHealth(120, 0, 4);
    for (let i = 0; i < 12; i++) applyHit(h, 27, { facing: 'side', roll: () => 0.5, bullet: PISTOL, zone: 'body' });
    expect(h.hp).toBeGreaterThan(120 * 0.5);
    expect(h.comp.engine).toBe(1);
    expect(h.comp.tires.every((t) => t === 1)).toBe(true);
    expect(h.leaking).toBe(false);
  });

  it('shot to pieces, a car is left standing with a dead engine, and never blows up', () => {
    const h = newHealth(120, 0, 4);
    const events: string[] = [];
    for (let i = 0; i < 400; i++) for (const e of applyHit(h, 130, { facing: 'side', roll: () => 0.99, bullet: RIFLE, zone: 'body' }).events) events.push(e.kind);
    expect(h.destroyed).toBe(false);
    expect(h.hp).toBeCloseTo(120 * BULLET_FLOOR, 5);
    expect(h.comp.engine).toBe(0);
    expect(events).not.toContain('destroyed');
  });

  it('what a round breaks is what it lands on', () => {
    const wheel = newHealth(170, 0.05, 4);
    applyHit(wheel, 27, { facing: 'side', roll: () => 0.1, bullet: PISTOL, zone: 'wheel', wheel: 2 });
    expect(wheel.comp.tires[2]).toBe(0);
    expect(wheel.comp.tires.filter((t) => t === 0)).toHaveLength(1);

    const bay = newHealth(170, 0.05, 4);
    applyHit(bay, 80, { facing: 'front', roll: () => 0.1, bullet: RIFLE, zone: 'engine' });
    expect(bay.comp.engine).toBeLessThan(1);

    const tank = newHealth(170, 0.05, 4);
    applyHit(tank, 27, { facing: 'rear', roll: () => 0.1, bullet: PISTOL, zone: 'tank' });
    expect(tank.leaking).toBe(true);
  });

  it('crashes and blasts still wreck a car outright', () => {
    const h = newHealth(120, 0, 4);
    applyHit(h, 9999, { facing: 'front', roll: () => 0.5, ram: true });
    expect(h.destroyed).toBe(true);
  });
});

describe('ray against a seated body', () => {
  it('finds a capsule square on, misses one off to the side, and respects the range', () => {
    const a: [number, number, number] = [0, 0, 0];
    const b: [number, number, number] = [0, 1, 0];
    expect(rayCapsule(-5, 0.5, 0, 1, 0, 0, a, b, 0.3, 20)).toBeCloseTo(4.7, 5);
    expect(rayCapsule(-5, 0.5, 0.5, 1, 0, 0, a, b, 0.3, 20)).toBeNull();
    expect(rayCapsule(-5, 0.5, 0, 1, 0, 0, a, b, 0.3, 3)).toBeNull();
    // Over the top of the head, just missing.
    expect(rayCapsule(-5, 1.35, 0, 1, 0, 0, a, b, 0.3, 20)).toBeNull();
  });
});

// ------------------------------------------------------------------ in a real scene

function scene() {
  const h = fakeServices();
  const sc = new LegScene(h.svc, legById('L1'));
  sc.pendingResult = true;
  for (const p of sc.players) p.exitVehicle(false);
  for (let i = 0; i < 18; i++) sc.tick(DT);
  sc.zombies.list.length = 0;
  sc.wildlife.list.length = 0;
  return { sc };
}

function run(sc: LegScene, secs: number) {
  for (let i = 0; i < Math.round(secs / DT); i++) sc.tick(DT);
}

/** Fire one round from `side` metres off the vehicle's flank (+x) at a point in its own frame, and let it land. */
function shootAt(sc: LegScene, v: Vehicle, local: [number, number, number], o: { ammo: 'pistol' | 'rifle'; damage: number; side?: 'convoy' | 'raider'; from?: [number, number, number] }) {
  const [tx, ty, tz] = v.body.toWorld(...local);
  const f = o.from ?? [6, 0, 0];
  const [ox, oy, oz] = v.body.toWorld(local[0] + f[0], local[1] + f[1], local[2] + f[2]);
  const dx = tx - ox;
  const dy = ty - oy;
  const dz = tz - oz;
  const l = Math.hypot(dx, dy, dz);
  sc.combat.shoot(ox, oy, oz, dx / l, dy / l, dz / l, { side: o.side ?? 'convoy', damage: o.damage, range: 60, ammo: o.ammo, headshots: true });
  run(sc, 0.1);
}

/** A raider buggy out in the open, held still so the shots land where they are aimed. */
function buggy(sc: LegScene): Vehicle {
  const st = sc.src.layout.start;
  const v = sc.raiders.spawnBuggy(st.x + 40, st.z + 30, 0);
  run(sc, 0.5);
  return v;
}

function hold(v: Vehicle) {
  v.body.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  v.body.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
}

describe('shooting raiders out of their cars', () => {
  it('a driver shot in the seat dies there, and the buggy is left whole', () => {
    const { sc } = scene();
    const v = buggy(sc);
    const hp = v.health.hp;
    const kills = sc.raiders.kills;
    expect(sc.raiders.vehiclesAlive).toBe(1);
    for (let i = 0; i < 10 && !v.abandoned; i++) {
      hold(v);
      shootAt(sc, v, [0, 0.75, 0.05], { ammo: 'rifle', damage: 32 });
    }
    expect(v.abandoned).toBe(true);
    expect(v.slumped).toBe(true);
    expect(v.wreck).toBe(false);
    expect(v.driver).toBeNull();
    expect(v.health.hp).toBe(hp);
    expect(sc.raiders.kills).toBe(kills + 1);
    expect(sc.raiders.vehiclesAlive).toBe(0);
    expect(sc.cars.canSalvage(v)).toBe(true);
    // With nobody at the wheel it rolls to a stop rather than driving on.
    run(sc, 4);
    expect(Math.abs(v.speed)).toBeLessThan(1);
    expect(v.wreck).toBe(false);
  });

  it('a buggy shot to pieces does not blow up: its crew climbs out and fights on foot', () => {
    const { sc } = scene();
    const v = buggy(sc);
    const before = sc.raiders.units.length;
    // Into the engine behind the seats, from the flank, clear of the driver.
    for (let i = 0; i < 80 && !v.abandoned; i++) {
      hold(v);
      shootAt(sc, v, [0.5, 0.05, -1.15], { ammo: 'rifle', damage: 80 });
    }
    run(sc, 0.2);
    expect(v.health.comp.engine).toBe(0);
    expect(v.abandoned).toBe(true);
    expect(v.wreck).toBe(false);
    expect(v.health.destroyed).toBe(false);
    expect(sc.raiders.units.length).toBe(before + 1);
    expect(sc.raiders.vehiclesAlive).toBe(0);
  });

  it("raider fire chews a convoy car's panels but cannot blow it up", () => {
    const { sc } = scene();
    const v = sc.vehicles.find((q) => q.faction === 'convoy' && !q.driver && q.def.physics.kind !== 'boat')!;
    expect(v).toBeDefined();
    for (let i = 0; i < 150; i++) shootAt(sc, v, [0, 0.2, 0], { ammo: 'pistol', damage: 30, side: 'raider', from: [8, 0.6, 0] });
    expect(v.wreck).toBe(false);
    expect(v.health.destroyed).toBe(false);
    expect(v.health.hp).toBeGreaterThanOrEqual(v.health.maxHp * BULLET_FLOOR - 1e-6);
  });
});
