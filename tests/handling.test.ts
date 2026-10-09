import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics, PhysicsWorld } from '../src/physics/physics';
import { VehicleBody, defaultEnv, type DriveEnv, type DriveInput } from '../src/physics/vehicle';
import { CHASSIS, chassisDef, partDef, wheelLayout } from '../src/data';
import { CHASSIS_FEEL, describeFeel, driveFeel, feelNotes } from '../src/sim/driveFeel';
import { lateralCurve, looseDrag, saturation, tyreKindOf, tyreScrub } from '../src/sim/tyreModel';
import { describePart, newPart } from '../src/sim/parts';

beforeAll(async () => {
  await initPhysics();
});

const DT = 1 / 60;
const fitOf = (...ids: string[]) => Object.fromEntries(ids.map((id) => [partDef(id).slot, newPart(id)]));

function spawn(id: string, env: DriveEnv = defaultEnv()) {
  const P = new PhysicsWorld();
  P.addStaticBox(0, -1, 0, 3000, 1, 3000);
  P.step();
  const def = chassisDef(id);
  const p = def.physics;
  const v = new VehicleBody(P, def, 0, p.suspension.rest + p.wheelRadius - p.hardY + 0.05, 0, 0);
  return { P, v, env };
}

const input = (o: Partial<DriveInput>): DriveInput => ({ steer: 0, throttle: 0, brake: 0, handbrake: false, ...o });
const holdSpeed = (v: VehicleBody, want: number) => (want > v.speed ? { throttle: Math.min(1, (want - v.speed) * 0.5 + 0.25) } : { brake: Math.min(1, (v.speed - want) * 0.3) });
const yawRate = (v: VehicleBody) => v.body.angvel().y;

/** Settle at a speed, then hold the stick over: the steady lateral g, and how long the yaw rate takes to build. */
function corner(id: string, speed: number, steer: number, assist = 1, env?: DriveEnv) {
  const { P, v } = spawn(id);
  const e = env ?? defaultEnv();
  const rs: number[] = [];
  for (let i = 0; i < 14 * 60; i++) {
    const t = i * DT;
    v.update(input({ ...holdSpeed(v, speed), steer: t > 8 ? steer : 0, assist }), e, DT);
    P.step();
    if (t > 8) rs.push(Math.abs(yawRate(v)));
  }
  const ss = rs.slice(-60).reduce((a, b) => a + b, 0) / 60;
  return { ay: (ss * Math.abs(v.speed)) / 9.81, t90: rs.findIndex((x) => x > ss * 0.9) * DT, v };
}

describe('the tyre', () => {
  it('grips more with slip up to its peak, then slides away to what the ground leaves it', () => {
    expect(lateralCurve(0, 0.7)).toBe(0);
    expect(lateralCurve(0.5, 0.7)).toBeGreaterThan(0.6);
    expect(lateralCurve(1, 0.7)).toBeCloseTo(1, 5);
    expect(lateralCurve(2, 0.7)).toBeLessThan(1);
    expect(lateralCurve(10, 0.7)).toBeCloseTo(0.7, 5);
    expect(saturation(0.9, 0.7)).toBe(1);
    expect(saturation(3, 0.7)).toBeCloseTo(0.7, 5);
  });

  it('sand bogs a tyre at a crawl, lets it skim at a run, and drags again flat out', () => {
    expect(looseDrag(0, 10)).toBe(0);
    expect(looseDrag(0.35, 0)).toBeGreaterThan(looseDrag(0.35, 8));
    expect(looseDrag(0.35, 30)).toBeGreaterThan(looseDrag(0.35, 8));
  });

  it('only a tyre past its grip scrubs: sliding, spinning, locked', () => {
    expect(tyreScrub(0, 0)).toBe(0);
    expect(tyreScrub(0.3, 0.5)).toBe(0);
    expect(tyreScrub(3, 0)).toBeGreaterThan(0.4);
    expect(tyreScrub(0, -20)).toBe(1);
  });

  it('every tyre part is a kind of tyre', () => {
    expect(tyreKindOf('tyre_none')).toBe('rim');
    expect(tyreKindOf('whl_bl')).toBe('crawler');
    expect(tyreKindOf('whl_mt')).toBe('mud');
    expect(tyreKindOf('tyre_hatch')).toBe('road');
    expect(tyreKindOf('tyre_pickup')).toBe('allTerrain');
  });
});

describe('the feel of a build', () => {
  it('every chassis has one, and its drive adds up', () => {
    for (const def of Object.values(CHASSIS)) {
      if (def.physics.kind === 'boat') continue;
      const f = driveFeel(def);
      const sum = f.torque.reduce((a, b) => a + b, 0);
      expect(sum, def.id).toBeCloseTo(1, 5);
      expect(f.tyres.length).toBe(def.physics.wheelCount);
    }
    expect(Object.keys(CHASSIS_FEEL)).toContain('hatch');
  });

  it('a hatch pulls with its front wheels, a sedan pushes with its back ones, a pickup drives all four', () => {
    const steered = (id: string) => wheelLayout(chassisDef(id).physics).map((w) => w.steer);
    const drives = (id: string) => driveFeel(chassisDef(id)).torque.map((t) => t > 0);
    expect(drives('hatch')).toEqual(steered('hatch'));
    expect(drives('sedan')).toEqual(steered('sedan').map((s) => !s));
    expect(drives('pickup').every(Boolean)).toBe(true);
    // The trike's axles say its back wheels drive.
    expect(drives('trike')).toEqual(wheelLayout(chassisDef('trike').physics).map((w) => w.drive));
  });

  it('the parts change it: a transfer case, a race box, a stripped dash, a quick wheel, a wing, the tyres', () => {
    const sedan = chassisDef('sedan');
    const stock = driveFeel(sedan);
    const box = driveFeel(sedan, fitOf('gbx_transfer'));
    expect(box.layout).toBe('awd');
    expect(box.diff).toBe('locked');
    expect(box.torque.every((t) => t > 0)).toBe(true);
    expect(driveFeel(sedan, fitOf('gbx_race')).diff).toBe('lsd');
    const bare = driveFeel(sedan, fitOf('dash_none'));
    expect(stock.abs && stock.tcs).toBe(true);
    expect(bare.abs || bare.tcs || bare.esc).toBe(false);
    expect(driveFeel(sedan, fitOf('steer_sport')).steerRate).toBeGreaterThan(stock.steerRate);
    expect(driveFeel(sedan, fitOf('rr_wing')).downforce).toBeGreaterThan(0);
    const mixed = driveFeel(sedan, {}, [null, null, newPart('whl_bl'), newPart('whl_bl')]);
    expect(mixed.tyres).toEqual(['road', 'road', 'crawler', 'crawler']);
  });

  it('the garage says how it drives, and the parts say what they change', () => {
    const hatch = chassisDef('hatch');
    expect(describeFeel(hatch, driveFeel(hatch))).toMatch(/front-wheel drive.*open diff.*60\/40.*ABS/);
    expect(describeFeel(hatch, driveFeel(hatch, fitOf('dash_none')))).toMatch(/no driving aids/);
    expect(feelNotes('gbx_transfer')[0]).toMatch(/four-wheel drive/);
    expect(describePart(partDef('dash_none')).join(' ')).toMatch(/no ABS/);
  });
});

describe('on the road', () => {
  it('a nose-heavy hatch sits level on springs wound for its weight, and carries it on the front', () => {
    const { P, v, env } = spawn('hatch');
    for (let i = 0; i < 180; i++) {
      v.update(input({ handbrake: true }), env, DT);
      P.step();
    }
    const front = v.wheelLoad[0] + v.wheelLoad[1];
    const all = v.wheelLoad.reduce((a, b) => a + b, 0);
    expect(front / all).toBeGreaterThan(0.57);
    expect(front / all).toBeLessThan(0.63);
    expect(Math.abs(v.forward()[1])).toBeLessThan(0.004);
  });

  it('a light car turns in quicker and holds more of a bend than a van, and a van more than a truck', () => {
    const hatch = corner('hatch', 15, 1);
    const van = corner('van', 15, 1);
    const truck = corner('truck', 15, 1);
    expect(hatch.ay).toBeGreaterThan(van.ay);
    expect(van.ay).toBeGreaterThan(truck.ay);
    expect(hatch.t90).toBeLessThan(truck.t90);
    // And none of them corners like the old one-size 1.45 g on firm dirt.
    expect(hatch.ay).toBeLessThan(1.35);
    expect(hatch.ay).toBeGreaterThan(0.9);
  });

  it('a front-driver with an open diff goes straight when both wheels grip alike', () => {
    const { P, v, env } = spawn('hatch');
    for (let i = 0; i < 10 * 60; i++) {
      v.update(input({ throttle: 1 }), env, DT);
      P.step();
    }
    expect(Math.abs(v.position.x)).toBeLessThan(0.3);
  });

  it('without anti-lock the brakes lock the wheels and the car will not turn; with it, it steers while stopping', () => {
    function stop(abs: boolean) {
      const { P, v, env } = spawn('sedan');
      env.feel = driveFeel(chassisDef('sedan'), abs ? {} : fitOf('dash_none'));
      let locked = 0;
      let x0 = 0;
      let braking = false;
      for (let i = 0; i < 20 * 60 && !(braking && v.speed < 1); i++) {
        if (!braking && v.speed > 22) {
          braking = true;
          x0 = v.position.x;
        }
        v.update(input(braking ? { brake: 1, steer: 0.6, assist: 0 } : { throttle: 1, assist: 0 }), env, DT);
        P.step();
        if (braking) locked = Math.min(locked, v.slipSpin[0]);
      }
      return { locked, turned: Math.abs(v.position.x - x0) };
    }
    const withAbs = stop(true);
    const without = stop(false);
    expect(without.locked).toBeLessThan(-5);
    expect(withAbs.locked).toBeGreaterThan(-3);
    expect(withAbs.turned).toBeGreaterThan(without.turned * 1.5);
  });

  it('the handbrake locks the back wheels and leaves the front ones rolling', () => {
    const { P, v, env } = spawn('sedan');
    let rear = 0;
    let front = 0;
    for (let i = 0; i < 9 * 60; i++) {
      const t = i * DT;
      v.update(input(t < 7 ? holdSpeed(v, 18) : { handbrake: true }), env, DT);
      P.step();
      if (t > 7.4 && t < 7.6) {
        rear = Math.min(v.slipSpin[2], v.slipSpin[3]);
        front = Math.max(Math.abs(v.slipSpin[0]), Math.abs(v.slipSpin[1]));
      }
    }
    expect(rear).toBeLessThan(-5);
    expect(front).toBeLessThan(1.5);
  });

  it('brakes run hot stop after stop, and fade', () => {
    const { P, v, env } = spawn('pickup');
    env.feel = { ...driveFeel(chassisDef('pickup')), brakeKj: 300 };
    const dists: number[] = [];
    for (let stop = 0; stop < 4; stop++) {
      let z0 = 0;
      let braking = false;
      for (let i = 0; i < 40 * 60; i++) {
        if (!braking && v.speed > 25) {
          braking = true;
          z0 = v.position.z;
        }
        if (braking && v.speed < 0.5) break;
        v.update(input(braking ? { brake: 1 } : { throttle: 1 }), env, DT);
        P.step();
      }
      dists.push(v.position.z - z0);
    }
    expect(v.brakeHeat).toBeGreaterThan(1);
    expect(dists[3]).toBeGreaterThan(dists[0] * 1.1);
  });

  it('on sand a road car still crawls away, and carries its speed when it lifts', () => {
    const env = defaultEnv();
    env.surface = () => ({ grip: 0.44, drag: 0.44, name: 'sand' });
    const { P, v } = spawn('sedan', env);
    for (let i = 0; i < 6 * 60; i++) {
      v.update(input({ throttle: 1 }), env, DT);
      P.step();
    }
    expect(v.speed).toBeGreaterThan(4);
    const v0 = v.speed;
    for (let i = 0; i < 60; i++) {
      v.update(input({}), env, DT);
      P.step();
    }
    // Lifting off on sand slows it hard, but not dead: under 5 m/s^2 of drag.
    expect(v0 - v.speed).toBeLessThan(5);
    expect(v0 - v.speed).toBeGreaterThan(1);
  });

  it('a rig rests on all twelve wheels instead of chattering on its dampers', () => {
    const { P, v, env } = spawn('rig');
    let lo = Infinity;
    let hi = 0;
    for (let i = 0; i < 4 * 60; i++) {
      v.update(input({ handbrake: true }), env, DT);
      P.step();
      if (i > 2 * 60) {
        for (let k = 0; k < v.wheelCount; k++) {
          const f = v.ctl.wheelSuspensionForce(k) ?? 0;
          lo = Math.min(lo, f);
          hi = Math.max(hi, f);
        }
      }
    }
    expect(lo).toBeGreaterThan(9000);
    expect(hi).toBeLessThan(14000);
  });

  it('in the air the throttle lifts the nose and the brake drops it', () => {
    function jump(o: Partial<DriveInput>) {
      const { P, v, env } = spawn('buggy');
      for (let i = 0; i < 60; i++) {
        v.update(input({}), env, DT);
        P.step();
      }
      const t = v.position;
      v.setPose(t.x, t.y + 6, t.z, 0);
      for (let i = 0; i < 40; i++) {
        v.update(input(o), env, DT);
        P.step();
      }
      return v.forward()[1];
    }
    expect(jump({ throttle: 1 })).toBeGreaterThan(0.05);
    expect(jump({ brake: 1 })).toBeLessThan(-0.05);
  });

  it('the stability control on a car that has it catches a tail that comes round too fast', () => {
    function kick(esc: boolean) {
      const { P, v, env } = spawn('sedan');
      env.feel = { ...driveFeel(chassisDef('sedan')), esc };
      let peak = 0;
      for (let i = 0; i < 9 * 60; i++) {
        v.update(input({ ...holdSpeed(v, 20), assist: 0 }), env, DT);
        if (i === 5 * 60) v.body.setAngvel({ x: 0, y: 1.2, z: 0 }, true);
        P.step();
        if (i > 5 * 60) peak = Math.max(peak, Math.abs(v.slide));
      }
      return peak;
    }
    expect(kick(true)).toBeLessThan(kick(false));
  });
});
