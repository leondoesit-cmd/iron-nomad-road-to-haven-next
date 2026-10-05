import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { LooseProps } from '../src/game/looseProps';
import { GROUPS, initPhysics, PhysicsWorld, RAPIER } from '../src/physics/physics';
import { PROP_COLLISION, PROP_DYNAMIC } from '../src/render/propCollision';
import type { PropKind } from '../src/world/layout';

async function world() {
  await initPhysics();
  const P = new PhysicsWorld();
  P.addStaticBox(0, -0.5, 0, 200, 0.5, 200);
  const field = new LooseProps({ P, root: new THREE.Group() } as never);
  return { P, field };
}

/** Throw a car-sized body at a prop and report how far the prop ends up from where it started. */
function shove(P: PhysicsWorld, field: LooseProps, mass: number, speed: number) {
  const l = field.all()[0];
  const start = l.body.translation();
  const b = P.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(start.x - 4, 0.6, start.z).setLinvel(speed, 0, 0).setLinearDamping(0).setGravityScale(0));
  P.world.createCollider(RAPIER.ColliderDesc.cuboid(1, 0.5, 1).setMass(mass).setFriction(0).setCollisionGroups(GROUPS.vehicle), b);
  for (let i = 0; i < 180; i++) P.step();
  const end = l.body.translation();
  return Math.hypot(end.x - start.x, end.z - start.z);
}

describe('loose props', () => {
  it('only tyres and drums are loose, and they are not also static', () => {
    expect(Object.keys(PROP_DYNAMIC).sort()).toEqual(['barrel', 'tires']);
    for (const k of Object.keys(PROP_DYNAMIC) as PropKind[]) expect(PROP_COLLISION[k]).toBe('dynamic');
  });

  it('sleeps until touched, and drops, lands and bounces when woken', async () => {
    const { P, field } = await world();
    field.add('a', [{ kind: 'tires', x: 0, y: 3, z: 0, yaw: 0.4, scale: 1, seed: 1 }]);
    const l = field.all()[0];
    expect(l.body.isSleeping()).toBe(true);
    l.body.wakeUp();
    let minAfterHit = Infinity;
    let lowest = Infinity;
    let rebound = 0;
    for (let i = 0; i < 240; i++) {
      field.update();
      P.step();
      const y = l.body.translation().y;
      if (y < lowest) lowest = y;
      else if (y - lowest > rebound) rebound = y - lowest;
      minAfterHit = Math.min(minAfterHit, y);
    }
    expect(minAfterHit).toBeGreaterThan(-0.05);
    expect(rebound).toBeGreaterThan(0.1);
  });

  it('is pushed further by a heavier, faster hit', async () => {
    const r: number[] = [];
    for (const [mass, speed] of [[100, 2], [1500, 2], [1500, 9]]) {
      const { P, field } = await world();
      field.add('a', [{ kind: 'tires', x: 0, y: 0.01, z: 0, yaw: 0, scale: 1, seed: 1 }]);
      r.push(shove(P, field, mass, speed));
    }
    expect(r[1]).toBeGreaterThan(r[0]);
    expect(r[2]).toBeGreaterThan(r[1]);
  });

  it('a barrel is lighter than a stack of tyres, so the same hit moves it further', async () => {
    const out: number[] = [];
    for (const kind of ['tires', 'barrel'] as const) {
      const { P, field } = await world();
      field.add('a', [{ kind, x: 0, y: 0.01, z: 0, yaw: 0, scale: 1, seed: 1 }]);
      out.push(shove(P, field, 400, 5));
    }
    expect(out[1]).toBeGreaterThan(out[0]);
  });

  it('release removes bodies', async () => {
    const { field } = await world();
    field.add('a', [{ kind: 'barrel', x: 0, y: 0, z: 0, yaw: 0, scale: 1, seed: 1 }]);
    expect(field.count).toBe(1);
    field.release('a');
    expect(field.count).toBe(0);
  });
});
