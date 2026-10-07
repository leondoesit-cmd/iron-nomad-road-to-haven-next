import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { FadedBatch } from '../src/render/fadedBatch';
import { Vegetation, type VegetationPlant } from '../src/render/vegetation';
import { initPhysics, PhysicsWorld, RAPIER, type Collider } from '../src/physics/physics';
import { Rng } from '../src/core/rng';

beforeAll(initPhysics);
const geometry = () => new THREE.BoxGeometry(0.6, 0.8, 0.2);
function batch(positions: THREE.Vector3[], fadeEnd = 85) {
  const mesh = new THREE.InstancedMesh(geometry(), new THREE.MeshStandardMaterial(), positions.length);
  const matrix = new THREE.Matrix4();
  positions.forEach((p, i) => mesh.setMatrixAt(i, matrix.makeTranslation(p.x, p.y, p.z)));
  return new FadedBatch(mesh, fadeEnd);
}

describe('fully faded ground cover', () => {
  it('never culls a batch containing a root inside the shader fade, including transformed parents', () => {
    const rng = new Rng(4728);
    const positions = Array.from({ length: 300 }, () => new THREE.Vector3(rng.range(-60, 60), rng.range(-8, 8), rng.range(-60, 60)));
    const b = batch(positions), parent = new THREE.Group(); parent.add(b.mesh);
    let culled = 0;
    for (let transform = 0; transform < 4; transform++) {
      parent.position.set(transform * 200, transform * 20, -transform * 120);
      parent.rotation.y = transform * 0.7; parent.scale.set(1 + transform * 0.4, 0.8, 1.7);
      parent.updateMatrixWorld(true);
      const roots = positions.map(p => p.clone().applyMatrix4(b.mesh.matrixWorld));
      for (let i = 0; i < 1000; i++) {
        const camera = new THREE.Vector3(rng.range(-400, 1200), rng.range(-60, 160), rng.range(-700, 500));
        // Chunks refresh the shared parent once for all batches; standalone batches refresh it themselves.
        b.updateView(camera, transform % 2 === 0);
        if (!b.mesh.visible) {
          culled++;
          expect(roots.every(p => p.distanceTo(camera) > 85)).toBe(true);
        }
      }
    }
    expect(culled).toBeGreaterThan(1000);
  });

  it('switches visibility independently for both cameras, retaining the Float32 safety margin and global visibility', () => {
    const b = batch([new THREE.Vector3(0, 0, 0)]);
    const original = Array.from(b.mesh.instanceMatrix.array);
    for (const x of [0, 85, 85.049, 86, 0]) {
      b.updateView(new THREE.Vector3(x, 0, 0));
      expect(b.mesh.visible).toBe(x < 86);
    }
    b.enabled = false; b.updateView(new THREE.Vector3()); expect(b.mesh.visible).toBe(false);
    b.enabled = true; b.updateView(new THREE.Vector3()); expect(b.mesh.visible).toBe(true);
    expect(Array.from(b.mesh.instanceMatrix.array)).toEqual(original);
    expect(b.mesh.count).toBe(1);
  });

  it('retains shadow casters and batches whose moving roots invalidate the static bound', () => {
    const b = batch([new THREE.Vector3()]), far = new THREE.Vector3(1000, 1000, 1000);
    b.mesh.castShadow = true; b.updateView(far); expect(b.mesh.visible).toBe(true);
    b.mesh.castShadow = false; b.mesh.frustumCulled = false;
    b.updateView(far); expect(b.mesh.visible).toBe(true);
    b.enabled = false; b.updateView(far); expect(b.mesh.visible).toBe(false);
  });
});

describe('on-demand plant contact shapes', () => {
  it('shares one immutable geometry snapshot and builds only the contacted plant with exactly the original scaled vertices', () => {
    const physics = new PhysicsWorld(), field = new Vegetation(physics), geo = geometry();
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial(), 300);
    const matrix = new THREE.Matrix4(), q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.3);
    for (let i = 0; i < mesh.count; i++) mesh.setMatrixAt(i, matrix.compose(new THREE.Vector3(i * 3, 0, 0), q, new THREE.Vector3(0.75 + i / 1000, 1.3, 0.85)));
    const plants = field.addInstances(mesh, 'grass');
    expect(plants.every(p => p.shape === null && p.shapeSource === plants[0].shapeSource)).toBe(true);
    const target = plants[12], original = Float32Array.from(geo.getAttribute('position').array);
    const expected = original.map((v, i) => v * [target.scale.x, target.scale.y, target.scale.z][i % 3]);
    // Later geometry edits cannot change the collision shape the eager implementation captured at registration.
    (geo.getAttribute('position').array as Float32Array).fill(99);
    const sensor = (field as unknown as { sensor(p: VegetationPlant): Collider }).sensor(target);
    expect(sensor.isSensor()).toBe(true);
    expect(Array.from((target.shape as RAPIER.TriMesh).vertices)).toEqual(Array.from(expected));
    expect(plants.filter(p => p.shape).length).toBe(1);
    const shape = target.shape;
    expect((field as unknown as { sensor(p: VegetationPlant): Collider }).sensor(target)).toBe(sensor);
    expect(target.shape).toBe(shape);
    field.dispose(); physics.world.free(); geo.dispose(); mesh.dispose();
  });
});
