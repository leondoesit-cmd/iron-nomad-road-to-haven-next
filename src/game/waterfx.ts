import { clamp } from '../core/math';
import { swell, type BoatBody } from '../physics/boat';
import type { Vehicle } from './vehicle';

/**
 * What water does to a vehicle. Wheeled vehicles ford the shallows (drag, spray), drown their engine once the water
 * climbs past the axles, float afterwards and drift toward the nearest shore. Boats leave a wake. Both run once per
 * fixed tick, right after the vehicle's own body update.
 */

const G = 9.81;

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
  // Drag grows with how much of the wheel is under.
  const k = Math.exp(-(0.45 + 2.4 * clamp(imm / wr, 0, 1.6)) * dt);
  body.setLinvel({ x: lv.x * k, y: lv.y, z: lv.z * k }, true);
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
    // A gentle current toward the shore carries a swamped vehicle in, so a mistake costs time and not the run.
    if (v.flooded && w.flow) body.applyImpulse({ x: w.flow[0] * mass * 0.9 * dt, y: 0, z: w.flow[1] * mass * 0.9 * dt }, true);
  }
}

/** A boat's wake: foam astern, spray at the bow, prop wash. */
export function boatFx(v: Vehicle, dt: number) {
  if (v.def.physics.kind !== 'boat' || v.wreck) return;
  const ctx = v.ctx;
  const p = v.position;
  const w = ctx.waterAt(p.x, p.z);
  const body = v.body as BoatBody;
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
