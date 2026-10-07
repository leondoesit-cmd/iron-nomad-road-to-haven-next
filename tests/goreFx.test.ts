import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Gibs, type GibKind } from '../src/render/gibs';
import { Decals, CELL } from '../src/render/decals';
import { Particles } from '../src/render/particles';
import './helpers/sim';

function debris() {
  const world = { floorAt: () => 0, trail: vi.fn(), splash: vi.fn(), ring: vi.fn() };
  return { gibs: new Gibs(world), world };
}

describe('gore effects', () => {
  it('wood and masonry never bleed, while organic fragments trail and splash', () => {
    const { gibs, world } = debris();
    for (const kind of ['plank', 'chunk', 'shard'] as GibKind[]) gibs.throw(kind, 0, 2, 0, 2, 1, 0, 1, 1, 1, 1);
    for (let i = 0; i < 180; i++) gibs.update(1 / 60);
    expect(world.trail).not.toHaveBeenCalled();
    expect(world.splash).not.toHaveBeenCalled();
    gibs.throw('chunk', 0, 2, 0, 2, 1, 0, 1, 0.4, 0.02, 0.02, true);
    for (let i = 0; i < 180; i++) gibs.update(1 / 60);
    expect(world.trail).toHaveBeenCalled();
    expect(world.splash).toHaveBeenCalled();
    gibs.dispose();
  });

  it('rotated limbs settle above the floor and stop moving at different frame rates', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.37);
    try {
      const finals: THREE.Matrix4[] = [];
      for (const hz of [30, 60, 120]) {
        const { gibs } = debris();
        gibs.throw('limb', 0, 2, 0, 3, 2, 1, 1.5, 0.4, 0.3, 0.2);
        for (let i = 0; i < 10 * hz; i++) gibs.update(1 / hz);
        const mesh = gibs.group.children[0] as THREE.InstancedMesh;
        const final = new THREE.Matrix4();
        mesh.getMatrixAt(0, final);
        finals.push(final);
        const vertices = mesh.geometry.getAttribute('position');
        const v = new THREE.Vector3();
        for (let i = 0; i < vertices.count; i++) expect(v.fromBufferAttribute(vertices, i).applyMatrix4(final).y).toBeGreaterThanOrEqual(-0.00001);
        gibs.update(1 / hz);
        const after = new THREE.Matrix4();
        mesh.getMatrixAt(0, after);
        expect(after.elements).toEqual(final.elements);
        gibs.dispose();
      }
      for (const final of finals.slice(1)) final.elements.forEach((value, i) => expect(value).toBeCloseTo(finals[0].elements[i], 4));
    } finally {
      random.mockRestore();
    }
  });

  it('recycled flesh slots lose their blood behavior when used for rubble', () => {
    const { gibs, world } = debris();
    gibs.throw('chunk', 0, 2, 0, 2, 1, 0, 1, 1, 0, 0, true);
    for (let i = 0; i < 220; i++) gibs.throw('chunk', 0, 2, 0, 2, 1, 0, 1, 1, 1, 1);
    expect(gibs.counts().chunk).toBe(220);
    gibs.update(1 / 60);
    expect(world.trail).not.toHaveBeenCalled();
    gibs.clear();
    expect(gibs.counts().chunk).toBe(0);
    expect(gibs.group.children.every(child => (child as THREE.InstancedMesh).count === 0)).toBe(true);
    gibs.dispose();
  });

  it('blood is immediately visible and follows gravity without changing smoke sprites', () => {
    const fx = new Particles();
    fx.blood(0, 2, 0, 4);
    fx.puff(0, 2, 0);
    fx.update(1 / 120);
    const geo = fx.smoke.points.geometry;
    for (let i = 0; i < 4; i++) expect(geo.getAttribute('aColor').getW(i)).toBeGreaterThan(0.9);
    const before = geo.getAttribute('aVelocity').getY(0);
    fx.update(1 / 60);
    expect(geo.getAttribute('aVelocity').getY(0)).toBeLessThan(before);
    expect(geo.getAttribute('aBlood').getX(4)).toBe(0);
    for (const layer of [fx.smoke, fx.glow]) {
      layer.points.geometry.dispose();
      (layer.points.material as THREE.Material).dispose();
    }
  });

  it('a direction parallel to a sloped surface normal still produces an orthogonal decal', () => {
    const d = new Decals(2);
    const normal = new THREE.Vector3(0.2, 1, 0.3).normalize();
    d.add(0, 0, 0, { cell: CELL.pool, w: 2, h: 1, nx: normal.x, ny: normal.y, nz: normal.z, dx: normal.x, dy: normal.y, dz: normal.z });
    const m = new THREE.Matrix4();
    d.mesh.getMatrixAt(0, m);
    const x = new THREE.Vector3().setFromMatrixColumn(m, 0);
    const y = new THREE.Vector3().setFromMatrixColumn(m, 1);
    expect(x.dot(normal)).toBeCloseTo(0, 6);
    expect(y.dot(normal)).toBeCloseTo(0, 6);
    expect(x.length()).toBeCloseTo(2, 6);
    expect(y.length()).toBeCloseTo(1, 6);
    d.dispose();
  });
});
