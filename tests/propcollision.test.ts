import { describe, expect, it } from 'vitest';
import { PROP_COLLISION, propCollisionMesh } from '../src/render/propCollision';
import { initPhysics, PhysicsWorld } from '../src/physics/physics';
import type { PropKind } from '../src/world/layout';

const kinds = Object.keys(PROP_COLLISION) as PropKind[];
const solid = kinds.filter((k) => PROP_COLLISION[k] === 'mesh' || PROP_COLLISION[k] === 'hull');

describe('prop mesh colliders', () => {
  it('covers every kind', () => expect(kinds.length).toBeGreaterThan(45));
  it.each(solid)('%s builds a valid triangle mesh from its drawn geometry', (kind) => {
    for (const seed of [0, 1, 2, 3]) {
      const m = propCollisionMesh({ kind, x: 10, y: 2, z: -5, yaw: 0.7, scale: 1, seed, tag: 0 });
      expect(m, `${kind}:${seed}`).not.toBeNull();
      expect(m!.shape).toBe(PROP_COLLISION[kind]  === 'hull' ? 'hull' : 'trimesh');
      if (m!.indices) {
        expect(m!.indices.length % 3).toBe(0);
        let max = 0;
        for (const i of m!.indices) max = Math.max(max, i);
        expect(max).toBeLessThan(m!.vertices.length / 3);
      }
      expect(m!.vertices.every(Number.isFinite)).toBe(true);
    }
  });
  it('Rapier accepts every shape', async () => {
    await initPhysics();
    const P = new PhysicsWorld();
    let tris = 0;
    for (const kind of solid) {
      const m = propCollisionMesh({ kind, x: 0, y: 0, z: 0, yaw: 0, scale: 1, seed: 0, tag: 0 })!;
      tris += (m.indices?.length ?? 0) / 3;
      expect(P.addPropCollider(m), kind).not.toBeNull();
    }
    expect(tris).toBeLessThan(60000);
  });
});
