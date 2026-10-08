import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { pushOutOfVehicles, type Footprint } from '../src/game/vehicleFootprint';
import type { Vehicle } from '../src/game/vehicle';
import { fakeServices, run } from './helpers/sim';

beforeAll(async () => {
  await initPhysics();
});

/** How far a point is outside a vehicle's footprint (negative inside). */
function outside(f: { x: number; z: number; fx: number; fz: number; hw: number; hl: number }, x: number, z: number) {
  const rx = x - f.x;
  const rz = z - f.z;
  const lx = Math.abs(rx * f.fz - rz * f.fx) - f.hw;
  const lz = Math.abs(rx * f.fx + rz * f.fz) - f.hl;
  return lx > 0 || lz > 0 ? Math.hypot(Math.max(0, lx), Math.max(0, lz)) : Math.max(lx, lz);
}

describe('vehicle footprints', () => {
  // A 2 x 4 m car at the origin, turned 30 degrees.
  const yaw = Math.PI / 6;
  const f: Footprint = { v: null as unknown as Vehicle, x: 0, y: 1, z: 0, fx: Math.sin(yaw), fz: Math.cos(yaw), hw: 1, hl: 2, reach: Math.hypot(1, 2) };

  it('pushes a circle out of a turned car to touch its side, whichever way it came in', () => {
    for (let i = 0; i < 400; i++) {
      const p = { x: (Math.random() - 0.5) * 7, z: (Math.random() - 0.5) * 7 };
      const n = { x: 0, z: 0 };
      const hit = pushOutOfVehicles([f], p, 0.4, 0, n);
      expect(outside(f, p.x, p.z)).toBeGreaterThan(0.4 - 1e-6);
      if (hit) expect(Math.hypot(n.x, n.z)).toBeCloseTo(1, 6);
    }
  });

  it('leaves alone a car on the bridge above or the street below', () => {
    const p = { x: 0.2, z: 0.3 };
    expect(pushOutOfVehicles([{ ...f, y: 6 }], p, 0.4, 0)).toBeNull();
    expect(pushOutOfVehicles([{ ...f, y: -4 }], p, 0.4, 0)).toBeNull();
    expect(p).toEqual({ x: 0.2, z: 0.3 });
  });
});

describe('the dead and cars', () => {
  it('a horde chasing a driver crowds round the car instead of walking into it', () => {
    const sc = new LegScene(fakeServices().svc, legById('L1'));
    run(sc, 0.5);
    const p = sc.players[0];
    const v = p.vehicle!;
    expect(p.inVehicle).toBe(true);
    const c = v.position;
    const zs: ReturnType<typeof sc.zombies.spawn>[] = [];
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      zs.push(sc.zombies.spawn(i % 2 ? 'runner' : 'walker', c.x + Math.cos(a) * 9, c.z + Math.sin(a) * 9, false, 1));
    }
    const chase = () => {
      for (const zb of zs) {
        zb.state = 'chase';
        zb.tx = p.pos.x;
        zb.tz = p.pos.z;
        zb.hasTarget = true;
      }
    };
    chase();
    let closest = Infinity;
    run(sc, 8, (i) => {
      chase();
      if (i < 240) return;
      const [fx, , fz] = v.body.forward();
      const l = Math.hypot(fx, fz);
      const at = v.position;
      const box = { x: at.x, z: at.z, fx: fx / l, fz: fz / l, hw: v.def.width / 2, hl: v.def.length / 2 };
      for (const zb of zs) if (!zb.dead) closest = Math.min(closest, outside(box, zb.x, zb.z) - zb.def.radius);
    });
    // They got there, and they are pressed against the panels, not standing in the seats.
    expect(closest).toBeLessThan(0.3);
    expect(closest).toBeGreaterThan(-0.12);
    sc.dispose();
  }, 60000);
});
