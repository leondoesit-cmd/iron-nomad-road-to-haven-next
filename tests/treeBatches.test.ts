import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildTreesSteps, charTreeInstance, treeGeometry, treeInstances, treeVariantGeometry, type TreeSet } from '../src/render/trees';
import { TREE_SPECIES, type TreeSpot } from '../src/world/flora';
import { Vegetation } from '../src/render/vegetation';
import { initPhysics, PhysicsWorld } from '../src/physics/physics';

beforeAll(initPhysics);
function build(trees: TreeSpot[]): TreeSet {
  const generator = buildTreesSteps(trees);
  let step = generator.next(); while (!step.done) step = generator.next(); return step.value;
}

describe('tree variant submission', () => {
  it('shares every vertex attribute and submits exactly the original triangles of each selected variant', () => {
    for (let sp = 0; sp < TREE_SPECIES.length; sp++) {
      const source = treeGeometry(sp), tags = source.getAttribute('tree'), index = source.index!;
      let triangles = 0;
      for (let v = 0; v < 3; v++) {
        const variant = treeVariantGeometry(sp, v);
        const expected: number[] = [];
        for (let i = 0; i < index.count; i += 3) if (tags.getY(index.getX(i)) === v) {
          expect(tags.getY(index.getX(i + 1))).toBe(v); expect(tags.getY(index.getX(i + 2))).toBe(v);
          expected.push(index.getX(i), index.getX(i + 1), index.getX(i + 2));
        }
        expect(Array.from(variant.index!.array)).toEqual(expected);
        for (const [name, attribute] of Object.entries(source.attributes)) expect(variant.getAttribute(name)).toBe(attribute);
        expect(variant.boundingSphere!.equals(source.boundingSphere!)).toBe(true);
        expect(treeVariantGeometry(sp, v)).toBe(variant);
        triangles += variant.index!.count;
      }
      // Three trees, one of each variant: one full model's worth rather than three full models.
      expect(triangles).toBe(index.count);
    }
  });

  it('keeps transforms, fire tint and falling-tree physics bound to the right instance across mixed variants', () => {
    const sp = TREE_SPECIES.indexOf('snag');
    const trees: TreeSpot[] = [2, 0, 1, 2, 1, 0].map((v, i) => ({ x: i * 50, y: 0, z: 0, s: 1, yaw: 0.2, lean: [0.02, -0.03], sp, v }));
    const set = build(trees), physics = new PhysicsWorld(), field = new Vegetation(physics);
    field.addTrees(trees); field.bindTrees(set);
    const instances = treeInstances(trees), slots = new Map<number, number>();
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < trees.length; i++) {
      const t = trees[i], slot = slots.get(t.v) ?? 0; slots.set(t.v, slot + 1);
      const mesh = set.near.find(m => m.userData.variant === t.v)!;
      mesh.getMatrixAt(slot, matrix);
      const expected = Float32Array.from(instances[i].m);
      for (let j = 0; j < 16; j++) expect(matrix.elements[j]).toBeCloseTo(expected[j], 5);
      expect(field.plants[i].refs[0].mesh).toBe(mesh); expect(field.plants[i].refs[0].index).toBe(slot);
    }
    const colors = set.near.map(m => Array.from(m.instanceColor!.array));
    const far = Array.from(set.far!.instanceColor!.array);
    const charredMesh = set.near.find(m => m.userData.variant === 1)!;
    const originalGreen = charredMesh.instanceColor!.getY(1);
    charTreeInstance(set, trees, 4, 1);
    for (let k = 0; k < set.near.length; k++) {
      const mesh = set.near[k], color = Array.from(mesh.instanceColor!.array);
      for (let j = 0; j < color.length; j++) {
        if (mesh.userData.variant === 1 && j >= 3 && j < 6) continue;
        expect(color[j]).toBe(colors[k][j]);
      }
    }
    expect(charredMesh.instanceColor!.getY(1)).not.toBe(originalGreen);
    const farNow = Array.from(set.far!.instanceColor!.array);
    for (let j = 0; j < farNow.length; j++) if (j < 12 || j >= 15) expect(farNow[j]).toBe(far[j]);
    field.hitTree(4, { x: 200, y: 1.1, z: 0, dx: 1, dy: 0, dz: 0, energy: 15000, impulse: 1000, kind: 'contact' });
    const body = field.plants[4].body!; expect(body).toBeDefined();
    body.setTranslation({ x: 400, y: 2, z: 0 }, true); physics.step();
    const ref = field.plants[4].refs[0]; ref.mesh.getMatrixAt(ref.index, matrix);
    expect(matrix.elements[12]).toBeCloseTo(body.translation().x, 4);
    expect(field.plants.filter(p => p.body).length).toBe(1);
    field.dispose(); physics.world.free();
    for (const mesh of [...set.near, set.far!]) mesh.dispose();
  });
});
