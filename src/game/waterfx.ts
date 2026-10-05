import { clamp } from '../core/math';
import { swell, type BoatBody } from '../physics/boat';
import type { Vehicle } from './vehicle';

/**
 * What water does to a vehicle. Wheeled vehicles ford the shallows (drag, spray), drown their engine once the water
 * climbs past the axles, float afterwards and drift toward the nearest shore; in running water whatever floats goes
 * where the river goes, and a fast stream leans on a car fording it. Boats leave a wake. Anything that comes down a
 * waterfall lands with a splash (and a tall one hurts). All of it runs once per fixed tick, right after the vehicle's own
 * body update.
 */

const G = 9.81;

type Water = NonNullable<ReturnType<Vehicle['ctx']['waterAt']>>;
const running = (w: Water) => w.kind === 'river' || w.kind === 'stream';

/** Per vehicle: the highest running water under it of the last few seconds, and when the last splash-down was. */
const falls = new WeakMap<Vehicle, { top: number; t: number; plunged: number }>();

/**
 * Whether a vehicle has just come down a waterfall: the running water under it is suddenly well below the highest it was on
 * a moment ago, and the hull is down at the new surface. A splash, a jolt for whoever is aboard, and on a tall drop some
 * damage, never enough to wreck it.
 */
function overFalls(v: Vehicle, w: Water, bottom: number) {
  const ctx = v.ctx;
  let s = falls.get(v);
  if (!s) falls.set(v, (s = { top: w.level, t: ctx.time, plunged: -99 }));
  if (ctx.time - s.t > 3 || w.level >= s.top) {
    s.top = w.level;
    s.t = ctx.time;
  }
  const drop = s.top - w.level;
  if (drop < 1.4 || bottom > w.level + 0.3) return;
  s.top = w.level;
  s.t = ctx.time;
  const again = ctx.time - s.plunged < 3;
  s.plunged = ctx.time;
  const p = v.position;
  const k = Math.min(1, drop / 30);
  for (let i = 0; i < 10 + 16 * k; i++) ctx.fx.puff(p.x + (Math.random() - 0.5) * v.def.length, w.level + 0.1, p.z + (Math.random() - 0.5) * v.def.length, 0.92, 0.96, 1, 1.8 + 3 * k, 1.2 + k);
  ctx.audio.play('plunge', p.x, p.z, 0.8 + 0.4 * k);
  const hard = again ? drop : drop - 4;
  if (hard > 0 && v.hpFrac > 0.3) v.takeHit(Math.min(hard * 4, 60), p.x, p.z + 1, { ram: true, silent: true });
  for (const pl of ctx.players) {
    if (pl.vehicle !== v) continue;
    pl.cam.addShake(0.3 + 0.5 * k);
    if (!again) ctx.notify(pl.index, 'Over the falls!', drop > 4 ? 'bad' : 'warn');
  }
}

/** A wheeled vehicle wading, flooding or floating. Does nothing for boats and wrecks. */
export function waterTick(v: Vehicle, dt: number) {
  if (v.def.physics.kind === 'boat' || v.wreck) return;
  const ctx = v.ctx;
  const p = v.position;
  const w = ctx.waterAt(p.x, p.z);
  const [, hy] = v.def.physics.halfExtents;
  const wr = v.def.physics.wheelRadius;
  const imm = w ? w.level - (p.y - hy) : 0;
  if (!w || imm <= 0.03) {
    // Out of the water: a flooded engine dries out after a moment.
    if (v.flooded) {
      v.dryT += dt;
      if (v.dryT > 2.5) {
        v.flooded = false;
        for (const pl of ctx.players) {
          if (Math.hypot(pl.pos.x - p.x, pl.pos.z - p.z) < 25) ctx.notify(pl.index, 'Engine dried out: it will start again', 'good');
        }
      }
    }
    return;
  }
  v.dryT = 0;
  const body = v.body.body;
  const lv = body.linvel();
  const horizontal = Math.hypot(lv.x, lv.z);
  // Drag grows with how much of the wheel is under. In running water it drags toward the water's own speed rather than
  // to a stop, as much as the car is afloat: a floating car goes where the river goes.
  const k = Math.exp(-(0.45 + 2.4 * clamp(imm / wr, 0, 1.6)) * dt);
  const afloat = w.flow && running(w) ? clamp((imm - wr * 0.7) / wr, 0, 1) : 0;
  const ux = afloat ? w.flow![0] * afloat : 0;
  const uz = afloat ? w.flow![1] * afloat : 0;
  body.setLinvel({ x: ux + (lv.x - ux) * k, y: lv.y, z: uz + (lv.z - uz) * k }, true);
  if (running(w)) overFalls(v, w, p.y - hy);
  // Spray off the wheels.
  v.splashT -= dt;
  if (v.splashT <= 0 && horizontal > 1.2) {
    v.splashT = 0.07;
    const [fx, , fz] = v.body.forward();
    ctx.fx.puff(p.x + fx * 0.6 + (Math.random() - 0.5), w.level + 0.05, p.z + fz * 0.6 + (Math.random() - 0.5), 0.9, 0.95, 1.0, 0.8 + horizontal * 0.1, 0.8);
  }
  // Past the axles the engine drowns.
  if (imm > wr * 1.5 && !v.flooded) {
    v.flooded = true;
    v.setEngine(false);
    if (v.driver?.isPlayer) ctx.notify(v.driver.index, 'Engine flooded! Bail out and swim, or wait for the current', 'bad');
    ctx.audio.play('splash', p.x, p.z, 1);
  }
  // Floating: neutral when the water reaches about the door line.
  if (imm > wr * 0.9) {
    const mass = v.mass;
    const lift = clamp((imm - wr * 0.7) / (hy * 2 + 0.12), 0, 1.35);
    const lv2 = body.linvel();
    const f = mass * G * lift - mass * 2.4 * lv2.y * (lift > 0.05 ? 1 : 0);
    body.applyImpulse({ x: 0, y: Math.max(0, f) * dt, z: 0 }, true);
    // A gentle current toward the shore carries a swamped vehicle in, so a mistake costs time and not the run; one still
    // running feels it less.
    if (w.flow && !running(w)) {
      const push = mass * (v.flooded ? 0.9 : 0.4) * dt;
      body.applyImpulse({ x: w.flow[0] * push, y: 0, z: w.flow[1] * push }, true);
    }
  } else if (w.flow && running(w) && imm > 0.3) {
    // Fording a quick stream: the water leans on the body, more the deeper and faster it runs.
    const push = v.mass * 0.35 * clamp(imm / (wr * 0.9), 0, 1) * dt;
    body.applyImpulse({ x: w.flow[0] * push, y: 0, z: w.flow[1] * push }, true);
  }
}

/** A boat's wake: foam astern, spray at the bow, prop wash. */
export function boatFx(v: Vehicle, dt: number) {
  if (v.def.physics.kind !== 'boat' || v.wreck) return;
  const ctx = v.ctx;
  const p = v.position;
  const w = ctx.waterAt(p.x, p.z);
  const body = v.body as BoatBody;
  if (w && running(w)) overFalls(v, w, p.y - v.def.physics.halfExtents[1]);
  v.splashT -= dt;
  if (v.splashT > 0 || !w || body.submerged < 0.25) return;
  v.splashT = 0.05;
  const sp = Math.abs(v.speed);
  const level = w.level + swell(p.x, p.z, ctx.time);
  const L = v.def.length;
  const [sx, , sz] = v.body.toWorld(0, 0, -L * 0.5 - 0.2);
  if (v.engineOn && (sp > 1.5 || v.lastIntent.throttle > 0.2)) {
    const size = 0.8 + sp * 0.11 + v.lastIntent.throttle * 0.6;
    ctx.fx.puff(sx + (Math.random() - 0.5) * 0.7, level + 0.04, sz + (Math.random() - 0.5) * 0.7, 0.94, 0.97, 1.0, size, 1.2);
  }
  if (sp > 6) {
    for (const s of [-1, 1]) {
      const [bx, , bz] = v.body.toWorld(s * 0.55, 0, L * 0.4);
      ctx.fx.puff(bx, level + 0.1, bz, 0.95, 0.98, 1.0, 0.5 + sp * 0.05, 0.6);
    }
  }
  // The fan or the outboard is loud: that is in the vehicle's Signature already, the splash is for the ear.
  if (sp > 8 && Math.random() < 0.05) ctx.audio.play('splash', p.x, p.z, 0.4);
}
