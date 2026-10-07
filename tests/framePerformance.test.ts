import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { FrameBudget } from '../src/core/frameBudget';
import { AdaptiveResolution } from '../src/render/adaptiveResolution';
import { staticTransform } from '../src/render/staticTransform';
import { colliderRadius, initPhysics, PhysicsWorld, RAPIER } from '../src/physics/physics';
import { externalRapierWasm } from '../scripts/rapier-wasm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LegScene } from '../src/game/legScene';
import { CHUNK } from '../src/world/terrain';

beforeAll(initPhysics);

describe('frame work budgets', () => {
  it('shares calm and urgent allowances across five catch-up ticks and resets for the next frame', () => {
    const budget = new FrameBudget();
    let slices = 0;
    for (let tick = 0; tick < 5; tick++) {
      while (budget.available(4)) { budget.charge(2); slices++; }
    }
    expect(slices).toBe(2);
    expect(budget.available(10)).toBe(true); // Critical nearby work can use the remainder.
    budget.charge(6);
    expect(budget.available(10)).toBe(false);
    budget.reset();
    expect(budget.available(4)).toBe(true);
  });
  it('the real streaming scheduler cannot multiply its allowance during catch-up', () => {
    let now = 0, builds = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const scene = Object.create(LegScene.prototype) as {
        inFrame: boolean; streamBudget: FrameBudget; R: { quality: string };
        chunks: Map<number, unknown>; streamWork(points: { x: number; z: number }[], here: { x: number; z: number }[]): void;
        beginFrame(): void; endFrame(): void;
      };
      scene.streamBudget = new FrameBudget(); scene.R = { quality: 'low' };
      scene.chunks = new Map([[0, { pending: 1, data: { cx: 4, cz: 0 }, buildNext() { now += 3; builds++; } }]]);
      const points = [{ x: 4 * CHUNK, z: 0 }];
      scene.beginFrame();
      for (let tick = 0; tick < 5; tick++) scene.streamWork(points, [{ x: 0, z: 0 }]);
      expect(builds).toBe(2); // Calm 4 ms, with one indivisible slice allowed to finish.
      scene.streamWork(points, points); // Nearby collision work may spend the urgent remainder.
      expect(builds).toBe(4);
      scene.endFrame(); scene.beginFrame();
      scene.streamWork(points, points);
      expect(builds).toBe(8);
      scene.endFrame();
      scene.streamWork(points, points); // Headless ticks have independent allowances.
      expect(builds).toBe(12);
    } finally { clock.mockRestore(); }
  });
});

describe('resolution settling', () => {
  it('keeps the existing floor, ceiling and 5% levels without consecutive-frame reallocations', () => {
    const controller = new AdaptiveResolution();
    let scale = 1, changes = 0, sinceChange = 0;
    for (let frame = 0; frame < 200; frame++) {
      sinceChange += 30;
      const next = controller.update(30, scale);
      if (next !== scale) { expect(sinceChange).toBeGreaterThanOrEqual(250); sinceChange = 0; changes++; }
      scale = next;
    }
    expect(changes).toBe(8);
    expect(scale).toBe(0.6);
    sinceChange = 0;
    for (let frame = 0; frame < 500; frame++) {
      sinceChange += 10;
      const next = controller.update(10, scale);
      if (next !== scale) { expect(sinceChange).toBeGreaterThanOrEqual(500); sinceChange = 0; }
      scale = next;
    }
    expect(scale).toBe(1);
  });
  it('ignores invalid timings and cannot resize from a single suspended-tab frame', () => {
    const controller = new AdaptiveResolution();
    expect(controller.update(NaN, 1)).toBe(1);
    expect(controller.update(10000, 1)).toBe(1);
    controller.reset();
    expect(controller.update(16, 1)).toBe(1);
  });
});

describe('static scenery transforms', () => {
  it('preserves exact matrices, follows parent movement, and leaves animated descendants live', () => {
    const scene = staticTransform(new THREE.Scene());
    const root = staticTransform(new THREE.Group());
    const object = new THREE.Group();
    object.position.set(13, -2, 41); object.rotation.set(0.1, 0.3, -0.4); object.scale.set(2, 3, 4);
    const animated = new THREE.Object3D(); animated.position.set(1, 2, 3);
    object.add(animated); root.add(object); scene.add(root);
    scene.updateMatrixWorld();
    const expected = object.matrixWorld.clone();
    staticTransform(object);
    const compose = vi.spyOn(object, 'updateMatrix');
    scene.updateMatrixWorld(); scene.updateMatrixWorld();
    expect(object.matrixWorld.equals(expected)).toBe(true);
    expect(compose).not.toHaveBeenCalled();
    animated.position.x += 4;
    scene.updateMatrixWorld();
    expect(animated.getWorldPosition(new THREE.Vector3()).equals(new THREE.Vector3(5, 2, 3).applyMatrix4(expected))).toBe(true);
    // An explicitly moved parent updates the cached descendants normally.
    root.position.x = 9; root.updateMatrix(); scene.updateMatrixWorld();
    expect(object.matrixWorld.elements[12]).toBeCloseTo(expected.elements[12] + 9);
    expect(animated.matrixAutoUpdate).toBe(true);
  });
});

describe('shared vegetation motion', () => {
  it('refreshes convex radii when the native shape changes and after collider removal', () => {
    const physics = new PhysicsWorld();
    const cube = (s: number) => Float32Array.from([-s,-s,-s, s,-s,-s, -s,s,-s, s,s,-s, -s,-s,s, s,-s,s, -s,s,s, s,s,s]);
    const collider = physics.world.createCollider(RAPIER.ColliderDesc.convexHull(cube(1))!);
    expect(colliderRadius(collider)).toBeCloseTo(Math.sqrt(3));
    collider.setShape(new RAPIER.ConvexPolyhedron(cube(3)));
    expect(colliderRadius(collider)).toBeCloseTo(3 * Math.sqrt(3));
    physics.removeCollider(collider);
    const next = physics.world.createCollider(RAPIER.ColliderDesc.convexHull(cube(2))!);
    expect(colliderRadius(next)).toBeCloseTo(2 * Math.sqrt(3));
    physics.world.free();
  });
  it('samples the first kinematic move and placed-player velocity once before all chunk callbacks', () => {
    const physics = new PhysicsWorld();
    const body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
    physics.world.createCollider(RAPIER.ColliderDesc.capsule(0.3, 0.25), body);
    body.setNextKinematicTranslation({ x: 0.15, y: 0, z: 0 });
    const seen: number[] = [];
    for (let chunk = 0; chunk < 20; chunk++) physics.beforeStep.add(() => seen.push(physics.moving[0].speed));
    physics.step();
    expect(seen).toEqual(Array(20).fill(seen[0]));
    expect(seen[0]).toBeCloseTo(9);
    physics.kinematicVelocity.set(body.handle, { x: 2, y: 0, z: 0 });
    physics.step();
    expect(physics.moving[0].speed).toBe(2);
    physics.world.free();
  });
});

describe('external physics binary', () => {
  it('replaces only the verified embedded binary and rejects drift', () => {
    const path = resolve('node_modules/@dimforge/rapier3d-compat/dist/rapier.mjs');
    const plugin = externalRapierWasm();
    const transform = plugin.transform as (this: unknown, code: string, id: string) => { code: string } | undefined;
    const context = { error(message: string): never { throw new Error(message); }, addWatchFile() {} };
    const output = transform.call(context, readFileSync(path, 'utf8'), path)!;
    expect(output.code).toContain('module_or_path:fetch(__nomadWasmUrl)');
    expect(output.code).not.toContain('fetch(__nomadWasmUrl).buffer');
    expect(output.code).not.toContain('AGFzbQ');
    expect(output.code.length).toBeLessThan(400000);
    expect(() => transform.call(context, 'changed dependency', path)).toThrow('Rapier embedded WASM changed');
  });
});
