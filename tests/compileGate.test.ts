import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { asShadowDraws, installCompileGate } from '../src/render/compileGate';

/** A stand-in renderer: the draw the gate wraps, and the per-material programs three keeps (set when a draw compiles). */
function fakeRenderer() {
  const seen: { material: THREE.Material; object: THREE.Object3D }[] = [];
  const props = new WeakMap<THREE.Material, { programs?: Map<string, unknown> }>();
  const get = (m: THREE.Material) => {
    let p = props.get(m);
    if (!p) props.set(m, (p = {}));
    return p;
  };
  const gl = {
    properties: { get },
    renderBufferDirect(_c: THREE.Camera, _s: THREE.Scene | null, _g: THREE.BufferGeometry, material: THREE.Material, object: THREE.Object3D) {
      get(material).programs ??= new Map([['k', {}]]);
      seen.push({ material, object });
    },
  } as unknown as THREE.WebGLRenderer;
  const gate = installCompileGate(gl);
  return { gl, gate, seen, compiled: (m: THREE.Material) => (get(m).programs = new Map([['k', {}]])) };
}

const camera = new THREE.PerspectiveCamera();
camera.updateMatrixWorld();
const at = (z: number, material: THREE.Material = new THREE.MeshStandardMaterial()) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(), material);
  m.position.set(0, 0, z);
  m.updateMatrixWorld();
  return m;
};
const draw = (gl: THREE.WebGLRenderer, o: THREE.Mesh, material = o.material as THREE.Material) =>
  gl.renderBufferDirect(camera, null as unknown as THREE.Scene, o.geometry, material, o, null as unknown as THREE.GeometryGroup);
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('compile gate', () => {
  it('holds a far object with a never-compiled material until its compile between frames is done', async () => {
    const { gl, gate, seen, compiled } = fakeRenderer();
    const far = at(-200);
    const queued: THREE.Object3D[] = [];
    let finish = () => {};
    draw(gl, far);
    expect(seen).toHaveLength(0);
    gate.flush((o) => {
      queued.push(o);
      compiled(far.material as THREE.Material);
      return new Promise<void>((r) => (finish = r));
    });
    expect(queued).toEqual([far]);
    draw(gl, far);
    expect(seen).toHaveLength(0);
    // Its shadow (drawn with a depth material) waits with it.
    draw(gl, far, new THREE.MeshDepthMaterial());
    expect(seen).toHaveLength(0);
    finish();
    await settle();
    gate.flush(() => Promise.resolve());
    draw(gl, far);
    expect(seen.map((d) => d.object)).toEqual([far]);
  });

  it('draws near things, and materials compiled before, at once', () => {
    const { gl, seen, compiled } = fakeRenderer();
    const near = at(-5);
    const old = at(-200);
    compiled(old.material as THREE.Material);
    draw(gl, near);
    draw(gl, old);
    expect(seen.map((d) => d.object)).toEqual([near, old]);
  });

  it('holds a batch with no bounds to measure, and gives up on a compile that never finishes', () => {
    const { gl, gate, seen } = fakeRenderer();
    const pool = at(-5);
    pool.frustumCulled = false;
    draw(gl, pool);
    expect(seen).toHaveLength(0);
    for (let i = 0; i < 100; i++) gate.flush(() => new Promise(() => {}));
    draw(gl, pool);
    expect(seen.map((d) => d.object)).toEqual([pool]);
  });

  it('sets a custom depth material up the way the shadow pass draws it', () => {
    const map = new THREE.Texture();
    const own = new THREE.MeshStandardMaterial({ map, alphaTest: 0.4, side: THREE.FrontSide });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), own);
    const depth = new THREE.MeshDepthMaterial();
    asShadowDraws(mesh, depth);
    expect(depth.side).toBe(THREE.BackSide);
    expect(depth.map).toBe(map);
    expect(depth.alphaTest).toBe(0.4);
  });
});
