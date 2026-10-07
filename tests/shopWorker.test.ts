import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { MELABES_WORKER_LOOK, MelabesWorker } from '../src/render/shopWorker';
import { FacePainter, scalpCover } from '../src/render/portrait';

describe('Melabes worker', () => {
  it('keeps a sparse crown, a full grey side fringe and a clean-shaven face', () => {
    expect(scalpCover(MELABES_WORKER_LOOK, 0, MELABES_WORKER_LOOK.shape.top)).toBeLessThan(0.1);
    expect(scalpCover(MELABES_WORKER_LOOK, Math.PI / 2, 0.15)).toBe(1);
    expect(MELABES_WORKER_LOOK.beard.chin).toBe(0);
  });

  it('blends the cheek into the jaw shadow without a horizontal colour seam', () => {
    const spec = MELABES_WORKER_LOOK;
    const painter = new FacePainter(spec);
    const above = new Float32Array(4);
    const below = new Float32Array(4);
    const boundary = spec.shape.eyeY + spec.shape.jaw[1] + 0.01;
    painter.paint(0.055, boundary + 0.0001, spec.shape.eyeZ - 0.015, -0.4, 1, above);
    painter.paint(0.055, boundary - 0.0001, spec.shape.eyeZ - 0.015, -0.4, 1, below);
    expect(Math.max(...[0, 1, 2].map((i) => Math.abs(above[i] - below[i])))).toBeLessThan(0.02);
  });

  it('carves at the spit, collects meat, and extends the plate toward the customer, then repeats', () => {
    const worker = new MelabesWorker();
    worker.update(3.1);
    const start = worker.rightHand.position.clone();
    const collect = worker.leftHand.position.clone();
    expect(worker.knife.visible).toBe(true);
    worker.update(3.5);
    expect(worker.rightHand.position.y).toBeLessThan(start.y);
    worker.update(19);
    expect(worker.knife.visible).toBe(false);
    expect(worker.leftHand.position.z).toBeGreaterThan(collect.z + 0.2);
    worker.root.updateMatrixWorld(true);
    worker.root.traverse((part) => {
      expect(part.matrixWorld.elements.every(Number.isFinite)).toBe(true);
      if (part.name === 'worker-upper-arm' || part.name === 'worker-forearm') expect(part.scale.y).toBeCloseTo(0.32, 6);
      if (part instanceof THREE.Mesh) expect(Array.from(part.geometry.getAttribute('position').array).every(Number.isFinite)).toBe(true);
    });
    worker.update(25.1);
    expect(worker.rightHand.position.distanceTo(start)).toBeLessThan(1e-8);
    const scene = new THREE.Group();
    scene.add(worker.root);
    worker.dispose();
    expect(worker.root.parent).toBeNull();
  });
});
