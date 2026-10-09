import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { drawSidesWithTwins, installDrawFilter, isEmptyDraw } from '../src/render/drawFilter';
import { paneMaterials } from '../src/render/glass';

type Draw = { material: THREE.Material; object: THREE.Object3D };

/** A stand-in renderer: only the method the filter wraps, recording what reaches it. */
function fakeRenderer() {
  const seen: Draw[] = [];
  const gl = {
    properties: { get: () => ({}) },
    renderBufferDirect(_c: THREE.Camera, _s: THREE.Scene | null, _g: THREE.BufferGeometry, material: THREE.Material, object: THREE.Object3D) {
      seen.push({ material, object });
    },
  } as unknown as THREE.WebGLRenderer;
  installDrawFilter(gl);
  return { gl, seen };
}

const camera = new THREE.PerspectiveCamera();
const draw = (gl: THREE.WebGLRenderer, o: THREE.Mesh, group: { start: number; count: number } | null = null) =>
  gl.renderBufferDirect(camera, null as unknown as THREE.Scene, o.geometry, o.material as THREE.Material, o, group as THREE.GeometryGroup);

describe('draw filter', () => {
  it('drops draws with nothing to draw and keeps every other draw', () => {
    const { gl, seen } = fakeRenderer();
    const geo = new THREE.BoxGeometry();
    const mat = new THREE.MeshStandardMaterial();
    const plain = new THREE.Mesh(geo, mat);
    const inst = new THREE.InstancedMesh(geo, mat, 8);
    draw(gl, plain);
    draw(gl, inst);
    inst.count = 0;
    draw(gl, inst);
    expect(isEmptyDraw(geo, inst, null)).toBe(true);
    const ig = new THREE.InstancedBufferGeometry().copy(geo as unknown as THREE.InstancedBufferGeometry);
    ig.instanceCount = 0;
    const igMesh = new THREE.Mesh(ig, mat);
    draw(gl, igMesh);
    ig.instanceCount = 3;
    draw(gl, igMesh);
    const ranged = new THREE.Mesh(geo.clone(), mat);
    ranged.geometry.setDrawRange(0, 0);
    draw(gl, ranged);
    draw(gl, plain, { start: 0, count: 0 });
    draw(gl, plain, { start: 0, count: 6 });
    expect(seen.map(d => d.object)).toEqual([plain, inst, igMesh, plain]);
  });

  it('draws a marked double-sided material through fixed one-sided copies, in three\'s pass order', () => {
    const { gl, seen } = fakeRenderer();
    const glass = drawSidesWithTwins(new THREE.MeshStandardMaterial({ transparent: true, side: THREE.DoubleSide, opacity: 0.3, polygonOffset: true, polygonOffsetFactor: -1, depthWrite: false }));
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(), glass);
    const versions: number[] = [];
    // What three's renderObject does for a transparent double-sided material, frame after frame.
    for (let frame = 0; frame < 3; frame++) {
      glass.side = THREE.BackSide; glass.needsUpdate = true; draw(gl, mesh);
      glass.side = THREE.FrontSide; glass.needsUpdate = true; draw(gl, mesh);
      glass.side = THREE.DoubleSide;
      versions.push(...seen.slice(-2).map(d => d.material.version));
    }
    const [back, front] = seen.slice(0, 2).map(d => d.material);
    expect(seen.map(d => d.material)).toEqual([back, front, back, front, back, front]);
    expect(back).not.toBe(glass);
    expect(back.side).toBe(THREE.BackSide);
    expect(front.side).toBe(THREE.FrontSide);
    // The copies never change, so three never has to look their program up again.
    expect(new Set(versions).size).toBe(1);
    for (const t of [back, front] as THREE.MeshStandardMaterial[]) {
      expect(t.transparent).toBe(true);
      expect(t.opacity).toBe(0.3);
      expect(t.depthWrite).toBe(false);
      expect([t.polygonOffset, t.polygonOffsetFactor]).toEqual([true, -1]);
      expect(t.userData.sideTwins).toBe(false);
    }
    // A double-sided draw (no two passes) and unmarked materials go through untouched.
    draw(gl, mesh);
    expect(seen.at(-1)!.material).toBe(glass);
    const other = new THREE.Mesh(mesh.geometry, new THREE.MeshStandardMaterial({ side: THREE.BackSide, transparent: true }));
    draw(gl, other);
    expect(seen.at(-1)!.material).toBe(other.material);
    let disposed = 0;
    back.addEventListener('dispose', () => disposed++);
    front.addEventListener('dispose', () => disposed++);
    glass.dispose();
    expect(disposed).toBe(2);
  });

  it('marks the shared window glass', () => {
    const p = paneMaterials();
    for (const m of [p.clear, p.frost, p.crazed]) {
      expect(m.userData.sideTwins).toBe(true);
      expect(m.side).toBe(THREE.DoubleSide);
      expect(m.transparent).toBe(true);
    }
  });
});
