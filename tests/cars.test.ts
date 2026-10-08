import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics, PhysicsWorld } from '../src/physics/physics';
import { VehicleBody, defaultEnv, type DriveInput } from '../src/physics/vehicle';
import { VEHICLES, chassisDef } from '../src/data';
import { restHeight } from '../src/render/carModels';
import { terrainDrag, terrainGrip } from '../src/sim/parts';

beforeAll(async () => {
  await initPhysics();
});

const CARS = VEHICLES.cars.map((c) => c.id);

function makeWorld() {
  const P = new PhysicsWorld();
  P.addStaticBox(0, -1, 0, 800, 1, 800);
  P.step();
  return P;
}

function run(id: string, seconds: number, input: (t: number) => Partial<DriveInput>, envMod?: (e: ReturnType<typeof defaultEnv>) => void) {
  const P = makeWorld();
  const def = chassisDef(id);
  const g = def.physics.suspension.rest + def.physics.wheelRadius - def.physics.hardY;
  const v = new VehicleBody(P, def, 0, g + 0.05, 0, 0);
  const env = defaultEnv();
  envMod?.(env);
  const log: { t: number; speed: number; x: number; yaw: number; up: number }[] = [];
  for (let i = 0; i < seconds * 60; i++) {
    const t = i / 60;
    v.update({ steer: 0, throttle: 0, brake: 0, handbrake: false, ...input(t) }, env, 1 / 60);
    P.step();
    if (i % 30 === 29) log.push({ t, speed: v.speed, x: v.position.x, yaw: v.yaw, up: v.up()[1] });
  }
  return { v, log, P };
}

describe.each(CARS)('%s drives', (id) => {
  const def = chassisDef(id);
  const top = def.topSpeedKmh / 3.6;
  it('accelerates toward its top speed without flipping or wandering', () => {
    const { log } = run(id, 16, () => ({ throttle: 1 }));
    const end = log[log.length - 1];
    expect(end.speed).toBeGreaterThan(top * 0.85);
    expect(end.speed).toBeLessThan(top * 1.08);
    expect(end.up).toBeGreaterThan(0.95);
    expect(Math.abs(end.x)).toBeLessThan(2);
  });
  it('gets up to 60% of top speed in reasonable time', () => {
    const { log } = run(id, 10, () => ({ throttle: 1 }));
    const hit = log.find((l) => l.speed > top * 0.6);
    expect(hit).toBeDefined();
    expect(hit!.t).toBeLessThan(6.5);
  });
  it('carves a turn and stays upright', () => {
    const { log } = run(id, 10, (t) => ({ throttle: t < 4 ? 1 : 0.45, steer: t > 3 ? 0.7 : 0 }));
    const end = log[log.length - 1];
    expect(Math.abs(end.x)).toBeGreaterThan(8);
    expect(end.up).toBeGreaterThan(0.75);
  });
  it('brakes to a stop and reverses', () => {
    const { log } = run(id, 18, (t) => (t < 6 ? { throttle: 1 } : { brake: 1 }));
    expect(log.find((l) => l.t > 6 && l.speed < 1)).toBeDefined();
    expect(log[log.length - 1].speed).toBeLessThan(0);
  });
  it('rests on its suspension with travel to spare', () => {
    const { v } = run(id, 3, () => ({}));
    const p = def.physics;
    let minSusp = Infinity;
    for (let i = 0; i < v.wheelCount; i++) minSusp = Math.min(minSusp, v.wheelSusp(i));
    expect(minSusp).toBeGreaterThan(p.suspension.rest - p.suspension.travel + 0.04);
    expect(v.position.y).toBeGreaterThan(p.halfExtents[1] + 0.12);
  });
  it('the model sits on the ground: the predicted rest height matches the physics', () => {
    const { v } = run(id, 4, () => ({}));
    // The body mesh is placed using restHeight; a mismatch would float or sink every car.
    expect(Math.abs(v.position.y - restHeight(def))).toBeLessThan(0.012);
  });
  it('holds a straight line after a spin kick', () => {
    const P = makeWorld();
    const g = def.physics.suspension.rest + def.physics.wheelRadius - def.physics.hardY;
    const v = new VehicleBody(P, def, 0, g + 0.05, 0, 0);
    const env = defaultEnv();
    let maxYaw = 0;
    for (let i = 0; i < 60 * 12; i++) {
      v.update({ steer: 0, throttle: v.speed < 18 ? 1 : 0.4, brake: 0, handbrake: false }, env, 1 / 60);
      if (i === 60 * 5) v.body.setAngvel({ x: 0, y: 0.8, z: 0 }, true);
      P.step();
      if (i > 60 * 5) maxYaw = Math.max(maxYaw, Math.abs(v.body.angvel().y));
    }
    expect(Math.abs(v.body.angvel().y)).toBeLessThan(0.15);
    expect(v.up()[1]).toBeGreaterThan(0.9);
    expect(maxYaw).toBeLessThan(1.6);
  });
});

describe.each(['truck', 'rig'])('the %s model', (id) => {
  it('sits on the ground: the predicted rest height matches the physics', () => {
    const def = chassisDef(id);
    const { v } = run(id, 5, () => ({}));
    // The truck and rig bodies are built on the ground and shifted down by restHeight, like the cars'.
    expect(Math.abs(v.position.y - restHeight(def))).toBeLessThan(0.012);
  });
});

describe('cars are balanced against the signature tiers', () => {
  it('road cars are faster than the buggy but fragile off-road; the pickup is the sturdiest', () => {
    const buggy = chassisDef('buggy');
    expect(chassisDef('sedan').topSpeedKmh).toBeGreaterThan(buggy.topSpeedKmh);
    expect(terrainGrip(0.6, chassisDef('sedan').offroad!)).toBeLessThan(terrainGrip(0.6, buggy.offroad!));
    expect(terrainGrip(0.6, chassisDef('pickup').offroad!)).toBeGreaterThan(terrainGrip(0.6, chassisDef('sedan').offroad!));
    expect(chassisDef('pickup').hp).toBeGreaterThan(chassisDef('sedan').hp);
    expect(chassisDef('van').cargo).toBeGreaterThan(chassisDef('pickup').cargo);
    expect(chassisDef('hatch').physics.mass).toBeLessThan(chassisDef('sedan').physics.mass);
  });
  it('the sedan loses more speed in sand than the buggy does', () => {
    const sand = { grip: 0.6, drag: 0.35 };
    const final = (id: string) => {
      const def = chassisDef(id);
      const off = def.offroad ?? 0.45;
      const { log } = run(id, 14, () => ({ throttle: 1 }), (e) => {
        e.surface = () => ({ grip: terrainGrip(sand.grip, off), drag: terrainDrag(sand.drag, off) });
      });
      return log[log.length - 1].speed / (def.topSpeedKmh / 3.6);
    };
    expect(final('sedan')).toBeLessThan(final('buggy'));
  });
});
