import type { Vehicle } from './vehicle';

/**
 * A vehicle's footprint on the ground: an oriented box. Things that walk without a Rapier body (the dead) use it to keep
 * out of cars. The obstacle index only holds parked cars, and as world-aligned boxes; a car with someone in it, or one
 * moving, is in neither.
 */
export interface Footprint {
  v: Vehicle;
  x: number;
  y: number;
  z: number;
  /** Forward along the ground, unit length. */
  fx: number;
  fz: number;
  /** Half width and half length. */
  hw: number;
  hl: number;
  /** Centre to corner. */
  reach: number;
}

/** Take every vehicle's footprint for this tick into `out` (reading a Rapier pose allocates, so walkers share one copy). */
export function footprints(vehicles: readonly Vehicle[], out: Footprint[]): Footprint[] {
  let n = 0;
  for (const v of vehicles) {
    const p = v.position;
    let [fx, , fz] = v.body.forward();
    let l = Math.hypot(fx, fz);
    // Stood on its nose or tail: the yaw still says which way it lies.
    if (l < 0.2) {
      fx = Math.sin(v.yaw);
      fz = Math.cos(v.yaw);
      l = 1;
    }
    const hw = v.def.width / 2;
    const hl = v.def.length / 2;
    const f = out[n] ?? (out[n] = { v, x: 0, y: 0, z: 0, fx: 0, fz: 1, hw: 0, hl: 0, reach: 0 });
    f.v = v;
    f.x = p.x;
    f.y = p.y;
    f.z = p.z;
    f.fx = fx / l;
    f.fz = fz / l;
    f.hw = hw;
    f.hl = hl;
    f.reach = Math.hypot(hw, hl);
    n++;
  }
  out.length = n;
  return out;
}

/**
 * Push a circle of radius `r`, standing on the ground at height `y`, out of every footprint it overlaps. Returns the last
 * one it was pushed out of, or null; `n` gets the outward direction of that push.
 */
export function pushOutOfVehicles(fps: readonly Footprint[], p: { x: number; z: number }, r: number, y: number, n?: { x: number; z: number }): Footprint | null {
  let hit: Footprint | null = null;
  for (const f of fps) {
    const rx = p.x - f.x;
    const rz = p.z - f.z;
    const reach = f.reach + r;
    if (rx * rx + rz * rz >= reach * reach) continue;
    // A car on the bridge overhead, or down in the street below a roof.
    if (f.y > y + 3 || f.y < y - 1.2) continue;
    let lx = rx * f.fz - rz * f.fx;
    let lz = rx * f.fx + rz * f.fz;
    const dx = lx - Math.max(-f.hw, Math.min(lx, f.hw));
    const dz = lz - Math.max(-f.hl, Math.min(lz, f.hl));
    const d2 = dx * dx + dz * dz;
    if (d2 >= r * r) continue;
    let nx: number;
    let nz: number;
    if (d2 > 1e-8) {
      const d = Math.sqrt(d2);
      nx = dx / d;
      nz = dz / d;
      lx += nx * (r - d);
      lz += nz * (r - d);
    } else if (f.hw - Math.abs(lx) < f.hl - Math.abs(lz)) {
      // Centre inside: out through the nearest side.
      nx = Math.sign(lx) || 1;
      nz = 0;
      lx = nx * (f.hw + r);
    } else {
      nx = 0;
      nz = Math.sign(lz) || 1;
      lz = nz * (f.hl + r);
    }
    p.x = f.x + lx * f.fz + lz * f.fx;
    p.z = f.z - lx * f.fx + lz * f.fz;
    if (n) {
      n.x = nx * f.fz + nz * f.fx;
      n.z = -nx * f.fx + nz * f.fz;
    }
    hit = f;
  }
  return hit;
}
