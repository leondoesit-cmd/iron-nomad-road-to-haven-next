import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics, PhysicsWorld } from '../src/physics/physics';
import { VehicleBody, defaultEnv, type DriveInput } from '../src/physics/vehicle';
import { chassisDef } from '../src/data';
import { GroundWork } from '../src/game/groundWork';
import { SOILS, wheelSinkage, G, type Soil } from '../src/sim/soil';
import { AMMO } from '../src/sim/ballistics';
import type { Ctx } from '../src/game/ctx';
import type { Vehicle } from '../src/game/vehicle';

// The loose ground with real wheels on it: a car rolling over sand presses a rut as deep as its tyres sink and rides in
// it, a heavier load cuts deeper, a spinning tyre digs and throws its soil, a round digs a crater and the soil it throws
// comes down again. Nothing is made or lost on the way.

beforeAll(initPhysics);

const SIZE = 128;
const N = 64;

function world(soil: Soil | null = SOILS.sand) {
  const P = new PhysicsWorld();
  P.addHeightfield(-SIZE / 2, -SIZE / 2, SIZE, N, new Float32Array((N + 1) * (N + 1)));
  P.step();
  const ctx = {
    players: [] as unknown[],
    vehicles: [] as unknown[],
    time: 0,
    fx: { dust() {}, puff() {}, smoke: { emit() {} } },
    groundAt: () => 0,
    drawnGroundAt: undefined as undefined | ((x: number, z: number) => number),
  };
  const work = new GroundWork(ctx as unknown as Ctx, { view: () => null, soilAt: () => soil });
  ctx.drawnGroundAt = (x, z) => work.heightAt(x, z);
  return { P, ctx, work };
}

function car(P: PhysicsWorld, z = -40) {
  const def = chassisDef('sedan');
  const y = def.physics.suspension.rest + def.physics.wheelRadius - def.physics.hardY + 0.05;
  const body = new VehicleBody(P, def, 0, y, z, 0);
  const v = { id: Math.floor(Math.random() * 1e9), body, def, build: null, lastIntent: { steer: 0, throttle: 0, brake: 0, handbrake: false } as DriveInput };
  return v;
}

function drive(w: ReturnType<typeof world>, v: ReturnType<typeof car>, steps: number, input: (k: number) => DriveInput) {
  const env = defaultEnv();
  env.ground = w.work.wheelGround(v as unknown as Vehicle);
  for (let k = 0; k < steps; k++) {
    const it = input(k);
    v.lastIntent = it;
    v.body.update(it, env, 1 / 60);
    w.work.vehicleStep(v as unknown as Vehicle, 1 / 60);
    w.P.step();
    w.ctx.time += 1 / 60;
    w.work.tick(1 / 60);
  }
}

/** The deepest point of the field across a line at z, near x. */
function rutAt(w: ReturnType<typeof world>, x: number, z: number) {
  let lo = 0;
  let hi = 0;
  for (let dx = -0.4; dx <= 0.4; dx += 0.02) {
    const h = w.work.heightAt(x + dx, z);
    lo = Math.min(lo, h);
    hi = Math.max(hi, h);
  }
  return { lo, hi };
}

describe('a car on sand', () => {
  it('presses a rut as deep as its tyres sink, with berms, and rides down in it', () => {
    const w = world();
    const v = car(w.P);
    const b = v.body;
    drive(w, v, 360, (k) => ({ steer: 0, throttle: k < 200 ? 0.5 : 0, brake: 0, handbrake: false }));
    const wheelX = b.wheelLocal[0][0];
    const W = (b.mass * G) / b.wheelCount;
    const z0 = wheelSinkage(SOILS.sand, W, 0.2, b.radii[0], 6).z;
    // A stretch it drove over at speed.
    const z = -40 + 10;
    const r = rutAt(w, wheelX, z);
    expect(r.lo).toBeLessThan(-z0 * 0.5);
    expect(r.lo).toBeGreaterThan(-0.2);
    expect(r.hi).toBeGreaterThan(0.002);
    // Both tracks are there.
    expect(rutAt(w, -wheelX, z).lo).toBeLessThan(-z0 * 0.5);
    // Standing still at the end, every wheel sits in what it pressed.
    for (let i = 0; i < b.wheelCount; i++) expect(b.wheelSink(i)).toBeGreaterThan(0.01);
    // Nothing made or lost: pressed (packed denser), heaped, thrown and still in the air add up.
    const air = Array.from(w.work.ejecta.vol.subarray(0, w.work.ejecta.n)).reduce((a, c) => a + c, 0);
    expect(Math.abs(w.work.field.volume() + w.work.field.packed + air)).toBeLessThan(2e-4);
  });

  it('cuts deeper loaded than empty, and a second car in the same ruts drags less than the first', () => {
    const depth = (scale: number) => {
      const w = world();
      const v = car(w.P);
      v.body.setLoad({ scale, com: { x: 0, y: 0, z: 0 } });
      drive(w, v, 240, (k) => ({ steer: 0, throttle: k < 150 ? 0.5 : 0, brake: 0, handbrake: false }));
      return rutAt(w, v.body.wheelLocal[0][0], -30).lo;
    };
    const light = depth(1);
    const heavy = depth(2.6);
    expect(heavy).toBeLessThan(light * 1.4);

    const w = world();
    const a = car(w.P, -40);
    drive(w, a, 240, (k) => ({ steer: 0, throttle: k < 150 ? 0.5 : 0, brake: 0, handbrake: false }));
    const first = w.work.dragFactor(a as unknown as Vehicle);
    a.body.setPose(30, 2, 0, 0);
    const bcar = car(w.P, -40);
    let second = 1;
    drive(w, bcar, 120, (k) => {
      if (k === 100) second = w.work.dragFactor(bcar as unknown as Vehicle);
      return { steer: 0, throttle: 0.5, brake: 0, handbrake: false };
    });
    expect(second).toBeLessThan(first * 0.8);
  });

  it('spins its driven tyres on a standing start and throws what they dig behind it', () => {
    const w = world();
    const v = car(w.P);
    drive(w, v, 50, () => ({ steer: 0, throttle: 1, brake: 0, handbrake: false }));
    const dug = w.work.stats.dug;
    expect(dug).toBeGreaterThan(0);
    expect(w.work.ejecta.launched).toBeGreaterThan(dug * 0.99);
    // Let it all land: the books balance.
    drive(w, v, 300, () => ({ steer: 0, throttle: 0, brake: 1, handbrake: true }));
    expect(w.work.ejecta.n).toBe(0);
    expect(Math.abs(w.work.field.volume() + w.work.field.packed)).toBeLessThan(2e-4);
  });
});

describe('a round in the sand', () => {
  it('digs a crater by its energy and its soil lands round it', () => {
    const w = world();
    const strike = (kind: 'pistol' | 'rifle', x: number) => {
      expect(w.work.strike(kind, x, 0, 0, 1, 0, 0.3, -1, 0, AMMO[kind].speed)).not.toBeNull();
      for (let k = 0; k < 400 && w.work.ejecta.n; k++) w.work.tick(1 / 60);
      let lo = 0;
      for (let dx = -0.3; dx <= 0.3; dx += 0.01) for (let dz = -0.3; dz <= 0.3; dz += 0.01) lo = Math.min(lo, w.work.heightAt(x + dx, dz));
      return lo;
    };
    const pistol = strike('pistol', -5);
    const rifle = strike('rifle', 5);
    expect(pistol).toBeLessThan(-0.005);
    expect(rifle).toBeLessThan(pistol * 1.3);
    expect(w.work.ejecta.landed).toBeGreaterThan(0);
    expect(Math.abs(w.work.field.volume() + w.work.field.packed)).toBeLessThan(1e-6);
  });

  it('in packed earth gouges a glancing round\'s hole deeper downrange and throws clods that land and keep the volume', () => {
    const w = world(SOILS.loam);
    const thrown: number[] = [];
    (w.ctx as unknown as { gore: unknown }).gore = { gibs: { throw: (...a: number[]) => thrown.push(a[7]) } };
    // A round coming in low along +z.
    const hit = w.work.strike('rifle', 0, 0, 0, 1, 0, 0, -0.26, 1, AMMO.rifle.speed)!;
    expect(hit).not.toBeNull();
    expect(hit.along / hit.across).toBeGreaterThan(2);
    expect(thrown.length).toBeGreaterThan(1);
    // Deeper toward the far end of the gouge than the near end.
    const near = w.work.heightAt(hit.x, hit.z - hit.along * 0.5);
    const far = w.work.heightAt(hit.x, hit.z + hit.along * 0.5);
    expect(far).toBeLessThan(near);
    for (let k = 0; k < 400 && w.work.ejecta.n; k++) {
      w.ctx.time += 1 / 60;
      w.work.tick(1 / 60);
    }
    for (let k = 0; k < 120; k++) {
      w.ctx.time += 1 / 60;
      w.work.tick(1 / 60);
    }
    expect(Math.abs(w.work.field.volume() + w.work.field.packed)).toBeLessThan(1e-6);
  });

  it('leaves hard ground to the old marks', () => {
    const w = world(null);
    expect(w.work.strike('rifle', 0, 0, 0, 1, 0, 0, -1, 0, AMMO.rifle.speed)).toBeNull();
    expect(w.work.field.tiles.size).toBe(0);
  });
});

describe('feet', () => {
  it('a walking dead man and a camel print the sand, the camel deeper', () => {
    const w = world();
    const ctx = w.ctx as unknown as { players: unknown[]; zombies: { list: unknown[] }; wildlife: { list: unknown[] } };
    ctx.players = [{ pos: { x: 0, z: 0 }, vehicle: null }];
    const zb = { id: 1, dead: false, x: -3, z: -2, yaw: 0, vx: 0, vz: 1.2, def: { scale: 1 } };
    const camel = { id: 2, dead: false, x: 3, z: -2, yaw: 0, vx: 0, vz: 1.4, def: { temper: 'prey', radius: 0.7, size: 1 } };
    ctx.zombies = { list: [zb] };
    ctx.wildlife = { list: [camel] };
    for (let k = 0; k < 240; k++) {
      zb.z += 1.2 / 60;
      camel.z += 1.4 / 60;
      w.work.tick(1 / 60);
    }
    expect(w.work.stats.prints).toBeGreaterThan(6);
    const deepest = (x: number) => {
      let lo = 0;
      for (let dx = -0.6; dx <= 0.6; dx += 0.02) for (let z = -2; z <= 2.5; z += 0.02) lo = Math.min(lo, w.work.heightAt(x + dx, z));
      return lo;
    };
    expect(deepest(-3)).toBeLessThan(-0.005);
    expect(deepest(3)).toBeLessThan(deepest(-3));
  });
});

describe('bodies and debris on sand', () => {
  /** The deepest the field goes in a box round (x, z). */
  const deepest = (w: ReturnType<typeof world>, x: number, z: number, r: number) => {
    let lo = 0;
    for (let dx = -r; dx <= r; dx += 0.02) for (let dz = -r; dz <= r; dz += 0.02) lo = Math.min(lo, w.work.heightAt(x + dx, z + dz));
    return lo;
  };

  it('a dead man falling presses his back into the sand once, where he fell', () => {
    const w = world();
    const ctx = w.ctx as unknown as { players: unknown[]; zombies: { list: unknown[] }; wildlife: { list: unknown[] } };
    ctx.players = [{ pos: { x: 0, z: 0 }, vehicle: null, state: 'foot' }];
    const zb = { id: 1, dead: true, deadT: 0, x: 2, z: 0, yaw: 0, vx: 0, vz: 0, def: { scale: 1 } };
    ctx.zombies = { list: [zb] };
    ctx.wildlife = { list: [] };
    for (let k = 0; k < 90; k++) {
      zb.deadT += 1 / 60;
      w.work.tick(1 / 60);
    }
    expect(w.work.stats.laid).toBe(2);
    // Facing +z, he falls back: his back lies a metre or so behind his feet, deeper than a boot goes.
    expect(deepest(w, 2, -1.2, 0.3)).toBeLessThan(-0.01);
    expect(deepest(w, 2, 1.2, 0.3)).toBe(0);
  });

  it('dropped weight dents by its weight and its fall, and a light thing on hard clay leaves nothing', () => {
    const w = world();
    w.work.lay(-2, 0, 1, 0, 0.3, 0.5, 15, 2);
    w.work.lay(2, 0, 1, 0, 0.3, 0.5, 120, 4);
    expect(deepest(w, 2, 0, 0.5)).toBeLessThan(deepest(w, -2, 0, 0.5));
    expect(deepest(w, -2, 0, 0.5)).toBeLessThan(0);
    const clay = world(SOILS.clay);
    clay.work.lay(0, 0, 1, 0, 0.05, 0.05, 0.3, 2);
    expect(clay.work.field.tiles.size).toBe(0);
  });

  it('a piece of debris hitting the sand dents it the tick its fall stops', () => {
    const w = world();
    let vy = -5;
    let y = 0.6;
    const piece = {
      id: 7,
      body: { linvel: () => ({ x: 0, y: vy, z: 0 }), translation: () => ({ x: 1, y, z: 1 }), rotation: () => ({ x: 0, y: 0, z: 0, w: 1 }), mass: () => 40 * 2.2 },
      collider: { halfExtents: () => ({ x: 0.5, y: 0.05, z: 0.3 }), radius: () => 0, halfHeight: () => 0 },
    };
    (w.ctx as unknown as { debris: unknown }).debris = { pieces: [piece] };
    w.work.tick(1 / 60);
    expect(w.work.stats.laid).toBe(0);
    vy = 0;
    y = 0.05;
    w.work.tick(1 / 60);
    expect(w.work.stats.laid).toBe(1);
    expect(deepest(w, 1, 1, 0.5)).toBeLessThan(-0.005);
  });

  it('a blast bowl has walls to climb; a pistol dish does not', () => {
    const w = world();
    w.work.blast(-3, 0, 0, 4, 120);
    w.work.strike('pistol', 3, 0, 0, 1, 0, 0, -1, 0, AMMO.pistol.speed);
    for (let k = 0; k < 600 && w.work.ejecta.n; k++) w.work.tick(1 / 60);
    let wall = 0;
    for (let x = -4.5; x <= -1.5; x += 0.05) wall = Math.max(wall, Math.abs(w.work.slopeAt(x, 0)[0]));
    let dish = 0;
    for (let x = 2.6; x <= 3.4; x += 0.02) dish = Math.max(dish, Math.abs(w.work.slopeAt(x, 0)[0]));
    expect(wall).toBeGreaterThan(0.15);
    expect(dish).toBeLessThan(0.08);
  });
});

describe('each ground breaks its own way', () => {
  /** Gibs thrown at a fake gore: their size and shape. */
  const withGibs = (w: ReturnType<typeof world>) => {
    const thrown: { size: number; shape?: readonly number[] }[] = [];
    (w.ctx as unknown as { gore: unknown }).gore = { gibs: { throw: (...a: unknown[]) => thrown.push({ size: a[7] as number, shape: a[12] as number[] | undefined }) } };
    return thrown;
  };
  const extent = (w: ReturnType<typeof world>, x: number, r: number) => {
    let lo = 0;
    let hi = 0;
    for (let dx = -r; dx <= r; dx += 0.005) for (let dz = -r; dz <= r; dz += 0.005) {
      const h = w.work.heightAt(x + dx, dz);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    return { lo, hi };
  };

  it('rock is chipped, not dug: a small pit with no rim, its chips flying off flat and lost', () => {
    const w = world(SOILS.rock);
    const thrown = withGibs(w);
    const hit = w.work.strike('rifle', 0, 0, 0, 1, 0, 0, -1, 0, AMMO.rifle.speed)!;
    expect(hit.across).toBeGreaterThan(0.008);
    expect(hit.across).toBeLessThan(0.04);
    // A cone a centimetre or so deep: finer than the field's 4 cm grid holds (the drawing's spall shows it), but the field
    // has lost its volume.
    expect(hit.depth).toBeGreaterThan(0.004);
    expect(hit.depth).toBeLessThan(0.02);
    const e = extent(w, 0, 0.1);
    expect(e.lo).toBeLessThan(-0.001);
    expect(e.hi).toBeLessThan(1e-4);
    expect(thrown.length).toBeGreaterThan(0);
    // Flakes: flatter than they are wide.
    for (const t of thrown) expect(t.shape![1]).toBeLessThan(t.shape![0]);
    for (let k = 0; k < 400 && w.work.ejecta.n; k++) w.work.tick(1 / 60);
    // What was chipped off is gone, not heaped back.
    expect(w.work.field.volume()).toBeLessThan(-1e-7);
    // A tyre does not press it and a boot leaves nothing.
    w.work.step(1, 0, 0, 100, 2);
    expect(w.work.stats.prints).toBe(0);
  });

  it('a pistol throws fewer crumbs out of packed earth than a rifle, and shotgun pellets hardly any', () => {
    const count = (kind: 'pistol' | 'rifle' | 'pellet') => {
      let n = 0;
      for (let k = 0; k < 12; k++) {
        const w = world(SOILS.loam);
        const thrown = withGibs(w);
        w.work.strike(kind, 0, 0, 0, 1, 0, 0, -1, 0, AMMO[kind].speed);
        n += thrown.length;
      }
      return n / 12;
    };
    const pellet = count('pellet');
    const rifle = count('rifle');
    expect(rifle).toBeGreaterThan(count('pistol'));
    expect(pellet).toBeLessThan(1);
    expect(rifle).toBeLessThanOrEqual(7);
  });

  it('a dry crust breaks round the hole; loose sand and gravel do not', () => {
    const cracked = (s: typeof SOILS.loam) => {
      const w = world(s);
      w.work.strike('rifle', 0, 0, 0, 1, 0, 0, -1, 0, AMMO.rifle.speed);
      let n = 0;
      for (const t of w.work.field.tiles.values()) for (let i = 0; i < t.k.length; i++) if (t.k[i] > 30) n++;
      return n;
    };
    expect(cracked(SOILS.loam)).toBeGreaterThan(10);
    expect(cracked(SOILS.clay)).toBeGreaterThan(10);
    expect(cracked(SOILS.sand)).toBe(0);
    expect(cracked(SOILS.gravel)).toBe(0);
  });

  it('gravel throws pebbles, not one colour', () => {
    const colours = new Set<string>();
    for (let k = 0; k < 10; k++) {
      const w = world(SOILS.gravel);
      const got: number[][] = [];
      (w.ctx as unknown as { gore: unknown }).gore = { gibs: { throw: (...a: number[]) => got.push([a[8], a[9], a[10]]) } };
      w.work.strike('rifle', 0, 0, 0, 1, 0, 0, -1, 0, AMMO.rifle.speed);
      for (const c of got) colours.add(c.map((v) => v.toFixed(1)).join());
    }
    expect(colours.size).toBeGreaterThan(3);
  });
});
