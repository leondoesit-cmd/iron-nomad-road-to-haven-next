import { PhysicsWorld } from '../../src/physics/physics';
import { VehicleBody, defaultEnv, type DriveEnv, type DriveInput } from '../../src/physics/vehicle';
import type { VehicleDef } from '../../src/data';

/**
 * A headless test track for one vehicle: a flat pad and a ramp, and the numbers a road test prints. Every run builds its own
 * world, so runs never see each other. `prep` gets the body and the env before the run (to load it, swap its powertrain).
 */
export interface BenchOpts {
  env?: () => DriveEnv;
  prep?: (v: VehicleBody, env: DriveEnv) => void;
}

const DT = 1 / 60;

function flatWorld() {
  const P = new PhysicsWorld();
  P.addStaticBox(0, -1, 0, 3000, 1, 3000);
  P.step();
  return P;
}

/** A ramp rising `grade` (0.1 = 10%) along +z from z = 0, with a flat run-up before it. */
function rampWorld(grade: number) {
  const P = new PhysicsWorld();
  const th = Math.atan(grade);
  const hy = 1;
  const hz = 600;
  // Rotated about x by -th: the box's +z runs up the slope, its +y is the slope's normal (0, cos, -sin).
  const q: [number, number, number, number] = [Math.sin(-th / 2), 0, 0, Math.cos(-th / 2)];
  const cz = Math.cos(th) * hz + Math.sin(th) * hy;
  const cy = Math.sin(th) * hz - Math.cos(th) * hy;
  P.addStaticTilted(0, cy, cz, 6, hy, hz, q);
  P.addStaticBox(0, -1, -40, 6, 1, 40);
  P.step();
  return P;
}

function spawn(P: PhysicsWorld, def: VehicleDef, o: BenchOpts, z = 0, y0 = 0) {
  const p = def.physics;
  const g = p.suspension.rest + p.wheelRadius - p.hardY;
  const v = new VehicleBody(P, def, 0, y0 + g + 0.05, z, 0);
  const env = o.env ? o.env() : defaultEnv();
  o.prep?.(v, env);
  return { v, env };
}

const input = (o: Partial<DriveInput>): DriveInput => ({ steer: 0, throttle: 0, brake: 0, handbrake: false, ...o });

export interface Bench {
  /** Seconds from rest to 50, 80 and 100 km/h (Infinity when never reached in 40 s). */
  t50: number;
  t80: number;
  t100: number;
  /** Highest speed seen in 40 s flat out, km/h. */
  top: number;
  /** Metres to stop from `brakeFrom` km/h with the brake full on. */
  brakeFrom: number;
  brakeDist: number;
  /** Coasting deceleration from the same speed, m/s^2 (engine on, nothing pressed). */
  coast: number;
  /** Speed (km/h) after 12 s flat out from rest up a 10% and a 20% grade. */
  hill10: number;
  hill20: number;
  /** Gear held at the end of the flat run and at the end of the 20% climb. */
  gearFlat: number;
  gearHill: number;
  /** Settled height of the chassis centre above the pad, m. */
  rest: number;
}

export function bench(def: VehicleDef, o: BenchOpts = {}, opts: { skipHill?: boolean; brakeKmh?: number } = {}): Bench {
  const out: Bench = { t50: Infinity, t80: Infinity, t100: Infinity, top: 0, brakeFrom: 0, brakeDist: 0, coast: 0, hill10: 0, hill20: 0, gearFlat: 0, gearHill: 0, rest: 0 };
  // Settle and accelerate.
  {
    const P = flatWorld();
    const { v, env } = spawn(P, def, o);
    for (let i = 0; i < 120; i++) {
      v.update(input({ handbrake: true }), env, DT);
      P.step();
    }
    out.rest = v.position.y;
    for (let i = 0; i < 40 * 60; i++) {
      v.update(input({ throttle: 1 }), env, DT);
      P.step();
      const t = (i + 1) * DT;
      const kmh = v.speed * 3.6;
      if (kmh >= 50 && out.t50 === Infinity) out.t50 = t;
      if (kmh >= 80 && out.t80 === Infinity) out.t80 = t;
      if (kmh >= 100 && out.t100 === Infinity) out.t100 = t;
      out.top = Math.max(out.top, kmh);
    }
    out.gearFlat = v.unit.gear;
  }
  // Brake and coast from 80 km/h, or from 90% of what it can reach.
  const from = opts.brakeKmh ?? Math.min(80, out.top * 0.9);
  out.brakeFrom = from;
  for (const mode of ['brake', 'coast'] as const) {
    const P = flatWorld();
    const { v, env } = spawn(P, def, o);
    let i = 0;
    for (; i < 60 * 60 && v.speed * 3.6 < from; i++) {
      v.update(input({ throttle: 1 }), env, DT);
      P.step();
    }
    const z0 = v.position.z;
    const s0 = v.speed;
    if (mode === 'brake') {
      for (let k = 0; k < 30 * 60 && v.speed > 0.3; k++) {
        v.update(input({ brake: 1 }), env, DT);
        P.step();
      }
      out.brakeDist = v.position.z - z0;
    } else {
      for (let k = 0; k < 3 * 60; k++) {
        v.update(input({}), env, DT);
        P.step();
      }
      out.coast = (s0 - v.speed) / 3;
    }
  }
  if (!opts.skipHill) {
    for (const grade of [0.1, 0.2]) {
      const P = rampWorld(grade);
      const { v, env } = spawn(P, def, o, -def.length);
      for (let i = 0; i < 12 * 60; i++) {
        v.update(input({ throttle: 1 }), env, DT);
        P.step();
      }
      if (grade === 0.1) out.hill10 = v.speed * 3.6;
      else {
        out.hill20 = v.speed * 3.6;
        out.gearHill = v.unit.gear;
      }
    }
  }
  return out;
}

export const fmt = (b: Bench) =>
  [b.t50, b.t80, b.t100].map((t) => (Number.isFinite(t) ? t.toFixed(2).padStart(6) : '     -')).join(' ') +
  ` | top ${b.top.toFixed(1).padStart(5)} | brake ${b.brakeFrom.toFixed(0)}→0 ${b.brakeDist.toFixed(1).padStart(5)} m | coast ${b.coast.toFixed(2)} | hill10 ${b.hill10.toFixed(1).padStart(5)} hill20 ${b.hill20.toFixed(1).padStart(5)} | gear ${b.gearFlat}/${b.gearHill} | rest ${b.rest.toFixed(3)}`;
