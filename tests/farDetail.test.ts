import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FarDetail } from '../src/render/farDetail';
import { makeTerrainDef } from '../src/world/terrain';
import { legById } from '../src/data';
import type { PropSpawn } from '../src/world/layout';

describe('spatial far-prop batches', () => {
  it('preserves every original instance and shared prototype while culling unseen regions', () => {
    const def = makeTerrainDef(legById('L1'));
    const props: PropSpawn[] = Array.from({ length: 60 }, (_, i) => ({
      kind: 'rock', x: (i % 3 - 1) * 20, y: i % 5, z: Math.floor(i / 3) * 512 + 80,
      scale: 2 + i % 3, yaw: i * 0.13, seed: 4,
    }));
    props.push({ kind: 'rock', x: -256.01, y: 0, z: -512.01, scale: 2, yaw: 0.2, seed: 4 });
    const detail = new FarDetail(def, props, { tLoaded: { value: null }, uLoadedRect: { value: new THREE.Vector4(-5000, -5000, 20000, 20000) } });
    const batches = detail.group.children.filter(o => (o as THREE.InstancedMesh).isInstancedMesh) as THREE.InstancedMesh[];
    // 2048 m batches: five along the 10 km strip, two across it (x = -20 falls west of 0), and the lone rock behind.
    expect(batches.length).toBe(11);
    expect(new Set(batches.map(b => b.geometry)).size).toBe(1);
    expect(new Set(batches.map(b => b.material)).size).toBe(1);
    const expected = new Map(props.map(p => {
      const m = new THREE.Matrix4().compose(new THREE.Vector3(p.x, p.y, p.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw), new THREE.Vector3(p.scale, p.scale, p.scale));
      return [`${Math.fround(p.x)},${Math.fround(p.z)}`, Array.from(Float32Array.from(m.elements))];
    }));
    const camera = new THREE.PerspectiveCamera(60, 1.6, 0.2, 800);
    camera.position.set(0, 10, 0); camera.lookAt(0, 10, 800); camera.updateMatrixWorld();
    detail.group.updateMatrixWorld();
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    let submitted = 0, count = 0;
    const matrix = new THREE.Matrix4(), vertex = new THREE.Vector3();
    for (const mesh of batches) {
      expect(mesh.frustumCulled).toBe(true);
      expect(mesh.castShadow).toBe(false);
      if (frustum.intersectsObject(mesh)) submitted += mesh.count;
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, matrix);
        const key = `${matrix.elements[12]},${matrix.elements[14]}`;
        expect(matrix.elements).toEqual(expected.get(key)); expected.delete(key); count++;
        const positions = mesh.geometry.getAttribute('position');
        for (let j = 0; j < positions.count; j++) {
          vertex.fromBufferAttribute(positions, j).applyMatrix4(matrix);
          // Bounds cover real geometry plus the maximum shader-breath displacement.
          expect(vertex.distanceTo(mesh.boundingSphere!.center) + 0.24 * matrix.getMaxScaleOnAxis()).toBeLessThanOrEqual(mesh.boundingSphere!.radius);
        }
      }
    }
    expect(count).toBe(props.length); expect(expected.size).toBe(0);
    expect(submitted).toBeLessThan(props.length / 3);
    let disposed = 0;
    for (const mesh of batches) mesh.addEventListener('dispose', () => disposed++);
    detail.dispose(); expect(disposed).toBe(batches.length);
  });
});
