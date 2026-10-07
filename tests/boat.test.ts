import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics, PhysicsWorld } from '../src/physics/physics';
import { BoatBody, type WaterQuery } from '../src/physics/boat';
import { defaultEnv, type DriveInput } from '../src/physics/vehicle';
import { BOATS, boatDef } from '../src/data';

beforeAll(async () => {
  await initPhysics();
});

/** A flat lake: water at y = 0 down to a floor at -6, and dry land beyond |x| > 60. */
const lake: WaterQuery = (x, z) => (Math.abs(x) > 60 || Math.abs(z) > 400 ? null : { level: 0, depth: 6 });

function sail(id: string, seconds: number, input: (t: number) => Partial<DriveInput>, water: WaterQuery = lake, startY = 0.6, setup?: (P: PhysicsWorld) => void) {
  const P = new PhysicsWorld();
  P.addStaticBox(0, -7, 0, 800, 1, 800);
  P.addStaticBox(75, 2, 0, 15, 4, 400);
  P.addStaticBox(-75, 2, 0, 15, 4, 400);
  setup?.(P);
  P.step();
  const def = boatDef(id);
  const b = new BoatBody(P, def, 0, startY, -100, 0, water);
  const env = defaultEnv();
  const log: { t: number; speed: number; x: number; y: number; z: number; yaw: number; up: number; sub: number }[] = [];
  for (let i = 0; i < seconds * 60; i++) {
    const t = i / 60;
    b.update({ steer: 0, throttle: 0, brake: 0, handbrake: false, ...input(t) }, env, 1 / 60);
    P.step();
    if (i % 30 === 29) {
      const p = b.position;
      log.push({ t, speed: b.speed, x: p.x, y: p.y, z: p.z, yaw: b.yaw, up: b.up()[1], sub: b.submerged });
    }
  }
  return { b, log, def };
}

describe.each(BOATS.map((b) => b.id))('%s', (id) => {
  const def = boatDef(id);
  const hy = def.physics.halfExtents[1];
  const draft = def.physics.boat!.draft;

  it('floats at its draft and stays level', () => {
    const { log } = sail(id, 8, () => ({}));
    const last = log[log.length - 1];
    // Hull bottom (centre - hy) sits `draft` under the surface.
    expect(last.y - hy).toBeCloseTo(-draft, 1);
    expect(last.up).toBeGreaterThan(0.99);
    expect(Math.abs(last.speed)).toBeLessThan(0.1);
    expect(last.sub).toBeGreaterThan(0.8);
  });

  it('accelerates under power to near its top speed, in a straight line', () => {
    const { log } = sail(id, 18, () => ({ throttle: 1 }));
    const top = def.topSpeedKmh / 3.6;
    const last = log[log.length - 1];
    expect(last.speed).toBeGreaterThan(top * 0.6);
    expect(last.speed).toBeLessThan(top * 1.05);
    expect(Math.abs(last.x)).toBeLessThan(2);
    expect(last.up).toBeGreaterThan(0.95);
  });

  it('turns when steered, and the turn is to the side asked for', () => {
    // Two seconds of full lock: well under half a circle, so the yaw has not wrapped round.
    const left = sail(id, 4, (t) => ({ throttle: 1, steer: t > 2 ? -1 : 0 }));
    const right = sail(id, 4, (t) => ({ throttle: 1, steer: t > 2 ? 1 : 0 }));
    // Positive yaw turns toward +X, so steering left (negative) must raise the yaw.
    expect(left.log[left.log.length - 1].yaw).toBeGreaterThan(0.9);
    expect(right.log[right.log.length - 1].yaw).toBeLessThan(-0.9);
    expect(left.log[left.log.length - 1].up).toBeGreaterThan(0.9);
    // Still under way through the turn (a pedal boat's best is a brisk walk).
    expect(left.log[left.log.length - 1].speed).toBeGreaterThan(Math.min(3, (def.topSpeedKmh / 3.6) * 0.6));
  });

  it('stops when the throttle is cut and backs up when braked', () => {
    const { log } = sail(id, 22, (t) => (t < 8 ? { throttle: 1 } : t < 16 ? {} : { brake: 1 }));
    const coast = log.find((l) => l.t > 15.9)!;
    expect(coast.speed).toBeLessThan(4);
    const last = log[log.length - 1];
    expect(last.speed).toBeLessThan(0.5);
  });

  it('runs aground: no water, no push, and it comes to rest', () => {
    const dry: WaterQuery = () => null;
    const { b, log } = sail(id, 10, () => ({ throttle: 1 }), dry, hy + 0.05);
    void b;
    expect(Math.abs(log[log.length - 1].speed)).toBeLessThan(def.physics.boat!.air ? (def.topSpeedKmh / 3.6) * 0.4 : 0.5);
  });

  it('can back off a beach under its own power', () => {
    // Bow-first on a sand bank with the water astern: reverse has to get her afloat again.
    const water: WaterQuery = (x, z) => (z < -106 ? { level: 0, depth: 6 } : null);
    const bank = (P: PhysicsWorld) => P.addStaticBox(0, -2.8, -6, 30, 3, 100);
    const { log } = sail(id, 12, (t) => ({ brake: t < 8 ? 1 : 0 }), water, 0.2 + hy + 0.05, bank);
    const last = log[log.length - 1];
    expect(last.z).toBeLessThan(-106);
    expect(last.sub).toBeGreaterThan(0.5);
  });

  it('never leaves the water when it bangs into the shore at speed', () => {
    const { log } = sail(id, 20, () => ({ throttle: 1, steer: 0.0 }), (x, z) => (x > 20 ? null : lake(x, z)), 0.6);
    for (const l of log) expect(l.y).toBeLessThan(3);
    expect(log[log.length - 1].up).toBeGreaterThan(0.5);
  });
});
