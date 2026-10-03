import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics, PhysicsWorld } from '../src/physics/physics';
import { VehicleBody, defaultEnv, type DriveInput } from '../src/physics/vehicle';
import { vehicleDef } from '../src/data';

beforeAll(async () => {
  await initPhysics();
});

function makeWorld() {
  const P = new PhysicsWorld();
  P.addStaticBox(0, -1, 0, 800, 1, 800);
  P.step();
  return P;
}

function run(tier: number, seconds: number, input: (t: number) => Partial<DriveInput>, envMod?: (e: ReturnType<typeof defaultEnv>) => void) {
  const P = makeWorld();
  const def = vehicleDef(tier);
  const g = def.physics.suspension.rest + def.physics.wheelRadius - def.physics.hardY;
  const v = new VehicleBody(P, def, 0, g + 0.05, 0, 0);
  const env = defaultEnv();
  envMod?.(env);
  const log: { t: number; speed: number; x: number; z: number; yaw: number; up: number; grounded: number }[] = [];
  for (let i = 0; i < seconds * 60; i++) {
    const t = i / 60;
    const inp: DriveInput = { steer: 0, throttle: 0, brake: 0, handbrake: false, ...input(t) };
    v.update(inp, env, 1 / 60);
    P.step();
    if (i % 30 === 29) {
      const p = v.position;
      log.push({ t, speed: v.speed, x: p.x, z: p.z, yaw: v.yaw, up: v.up()[1], grounded: v.grounded });
    }
  }
  return { v, log, P };
}

describe.each([1, 2, 3])('tier %i raycast vehicle', (tier) => {
  const top = vehicleDef(tier).topSpeedKmh / 3.6;
  it('accelerates toward its top speed without flipping', () => {
    const { log } = run(tier, 14, () => ({ throttle: 1 }));
    const end = log[log.length - 1];
    // eslint-disable-next-line no-console
    console.log(`T${tier} top ${top.toFixed(1)} m/s ->`, log.filter((_, i) => i % 4 === 3).map((l) => l.speed.toFixed(1)).join(' '));
    expect(end.speed).toBeGreaterThan(top * 0.85);
    expect(end.speed).toBeLessThan(top * 1.08);
    expect(end.up).toBeGreaterThan(0.95);
    expect(Math.abs(end.x)).toBeLessThan(2);
  });
  it('reaches 60% of top speed in a reasonable time', () => {
    const { log } = run(tier, 8, () => ({ throttle: 1 }));
    const hit = log.find((l) => l.speed > top * 0.6);
    expect(hit).toBeDefined();
    expect(hit!.t).toBeLessThan(tier === 1 ? 4.5 : 5.5);
  });
  it('steers and stays upright in a sustained turn', () => {
    const { log } = run(tier, 10, (t) => ({ throttle: t < 4 ? 1 : 0.45, steer: t > 3 ? 0.7 : 0 }));
    const end = log[log.length - 1];
    // eslint-disable-next-line no-console
    console.log(`T${tier} turn: yaw ${end.yaw.toFixed(2)} up ${end.up.toFixed(2)} speed ${end.speed.toFixed(1)}`);
    expect(Math.abs(end.x)).toBeGreaterThan(8); // it genuinely carved a turn
    expect(end.up).toBeGreaterThan(0.7);
  });
  it('brakes to a stop and reverses', () => {
    const { log } = run(tier, 16, (t) => (t < 6 ? { throttle: 1 } : { brake: 1 }));
    const stopped = log.find((l) => l.t > 6 && l.speed < 1);
    // eslint-disable-next-line no-console
    console.log(`T${tier} brake: stop at ${stopped?.t}, final ${log[log.length - 1].speed.toFixed(1)}`);
    expect(stopped).toBeDefined();
    expect(log[log.length - 1].speed).toBeLessThan(0);
  });
});

describe.each([1, 2, 3])('tier %i ride height', (tier) => {
  it('rests on its suspension with travel to spare (no bottoming out)', () => {
    const { v } = run(tier, 3, () => ({}));
    const p = vehicleDef(tier).physics;
    let minSusp = Infinity;
    for (let i = 0; i < v.wheelCount; i++) minSusp = Math.min(minSusp, v.wheelSusp(i));
    // Compression at rest must stay clear of the travel limit.
    expect(minSusp).toBeGreaterThan(p.suspension.rest - p.suspension.travel + 0.04);
    // The chassis floats above the ground instead of resting on its collider.
    expect(v.position.y).toBeGreaterThan(p.halfExtents[1] + 0.12);
  });
});

describe('stability assist', () => {
  it.each([2, 3])('tier %i holds a straight line at speed after a bump (no runaway yaw)', (tier) => {
    // A sideways kick at speed must not escalate into a spin when the driver steers straight.
    const P = makeWorld();
    const def = vehicleDef(tier);
    const g = def.physics.suspension.rest + def.physics.wheelRadius - def.physics.hardY;
    const v = new VehicleBody(P, def, 0, g + 0.05, 0, 0);
    const env = defaultEnv();
    let maxYawRate = 0;
    for (let i = 0; i < 60 * 12; i++) {
      v.update({ steer: 0, throttle: v.speed < 18 ? 1 : 0.4, brake: 0, handbrake: false }, env, 1 / 60);
      if (i === 60 * 5) v.body.setAngvel({ x: 0, y: 0.8, z: 0 }, true); // spin kick
      P.step();
      if (i > 60 * 5) maxYawRate = Math.max(maxYawRate, Math.abs(v.body.angvel().y));
    }
    expect(Math.abs(v.body.angvel().y)).toBeLessThan(0.15);
    expect(v.up()[1]).toBeGreaterThan(0.9);
    expect(maxYawRate).toBeLessThan(1.6);
  });
});

describe.each([1, 2, 3])('tier %i handbrake turn', (tier) => {
  /** Cruise, then pull the handbrake with the wheel over, and watch the slide. */
  function turn(handbrake: boolean) {
    const P = makeWorld();
    const def = vehicleDef(tier);
    const g = def.physics.suspension.rest + def.physics.wheelRadius - def.physics.hardY;
    const v = new VehicleBody(P, def, 0, g + 0.05, 0, 0);
    const env = defaultEnv();
    let maxYaw = 0;
    let maxLat = 0;
    let minUp = 1;
    let yaw0 = 0;
    let speed0 = 0;
    let headingChange = 0;
    let speed1 = 0;
    for (let i = 0; i < 12 * 60; i++) {
      const t = i / 60;
      const hb = handbrake && t > 6 && t < 7.5;
      v.update({ steer: t > 6 && t < 9 ? 0.8 : 0, throttle: t < 6 ? 0.8 : 0.3, brake: 0, handbrake: hb }, env, 1 / 60);
      P.step();
      if (i === 6 * 60) {
        yaw0 = v.yaw;
        speed0 = v.speed;
      }
      if (t > 6) {
        const w = v.body.angvel();
        const up = v.up();
        maxYaw = Math.max(maxYaw, Math.abs(w.x * up[0] + w.y * up[1] + w.z * up[2]));
        const lv = v.body.linvel();
        const f = v.forward();
        maxLat = Math.max(maxLat, Math.abs(lv.x * f[2] - lv.z * f[0]));
        minUp = Math.min(minUp, up[1]);
      }
      if (i === 9 * 60) {
        let d = v.yaw - yaw0;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        headingChange = Math.abs(d);
        speed1 = v.speed;
      }
    }
    return { maxYaw, maxLat, minUp, headingChange, speed0, speed1 };
  }

  it('turns the car round faster than the wheel alone, and stays a slide the driver can hold', () => {
    const with_ = turn(true);
    const without = turn(false);
    // eslint-disable-next-line no-console
    console.log(`T${tier} handbrake`, JSON.stringify(with_), 'wheel only', JSON.stringify(without));
    expect(with_.headingChange).toBeGreaterThan(without.headingChange * 1.2);
    // No spin-out: the yaw rate stays within a few rad/s, the car stays on its wheels and is not skating sideways.
    expect(with_.maxYaw).toBeLessThan(2.6);
    expect(with_.maxLat).toBeLessThan(4);
    expect(with_.minUp).toBeGreaterThan(0.9);
    // And it does not stop the car dead.
    expect(with_.speed1).toBeGreaterThan(with_.speed0 * 0.45);
  });

  it('comes out of the slide pointing where it is going', () => {
    const r = turn(true);
    expect(r.maxLat).toBeLessThan(4);
  });
});
