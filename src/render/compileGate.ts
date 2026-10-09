import * as THREE from 'three';

/**
 * No frame waits for a shader to compile.
 *
 * Everything in the scene when a world loads is compiled behind the loading veil (`GameRenderer.compileScene`), but the
 * world keeps arriving as it streams in: a swamp's water, a kind of prop, a shop worker's face. The first draw of a
 * material three has never compiled builds its program on the spot and then waits for the driver to finish it, 40 to 70 ms
 * of a frame on this hardware: the hitch felt while driving. Here such a draw is held back instead when the object is far
 * from the camera (it is only arriving, at the edge of what is streamed in), and the material is compiled between frames
 * with `compileAsync`, in parallel where the driver can; once its program is ready the object draws as normal, a few frames
 * later. Near things, and every material that has been compiled once, draw at once exactly as before.
 *
 * Only draws of an object's own materials are held (its material, or the custom depth material its shadow is drawn with),
 * and its shadow with it while it waits: the shadow pass's built-in depth materials, or a twin a draw filter swaps in, are
 * the renderer's to compile on the spot as before.
 */

/** Closer than this (to the bounds, metres) a new material compiles on the spot rather than leave the thing unseen. */
const NEAR = 25;
/** Frames to hold back a draw at most, should its material never come ready (a compile error, a variant compile missed). */
const GIVE_UP = 90;

interface Wait {
  object: THREE.Object3D;
  material: THREE.Material;
  frame: number;
  started: boolean;
  done: boolean;
}

export interface CompileGate {
  /**
   * Between frames: compile what the last frame held back. `compile` compiles one object, drawn with `material`, for the
   * frames' targets.
   */
  flush(compile: (object: THREE.Object3D, material: THREE.Material) => Promise<unknown>): void;
}

const _s = new THREE.Sphere();
const _cam = new THREE.Vector3();

function ownMaterial(object: THREE.Object3D, material: THREE.Material): boolean {
  const m = (object as THREE.Mesh).material;
  return m === material || (Array.isArray(m) && m.includes(material)) || object.customDepthMaterial === material ||
    object.customDistanceMaterial === material;
}

/**
 * Whether the object stands far enough off to arrive a few frames late. A batch drawn wherever its members are (bounds off:
 * a herd, a crowd, the small life) has no place to measure, and is held: a member turning up late beats every member, and
 * everything else, stopping for the compile.
 */
function farFrom(camera: THREE.Camera, object: THREE.Object3D, geometry: THREE.BufferGeometry): boolean {
  if (!object.frustumCulled) return true;
  const im = object as THREE.InstancedMesh;
  let bs: THREE.Sphere | null;
  if (im.isInstancedMesh) {
    if (!im.boundingSphere) im.computeBoundingSphere();
    bs = im.boundingSphere;
  } else {
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    bs = geometry.boundingSphere;
  }
  if (!bs || !Number.isFinite(bs.radius)) return false;
  _s.copy(bs).applyMatrix4(object.matrixWorld);
  _cam.setFromMatrixPosition(camera.matrixWorld);
  return _s.distanceToPoint(_cam) > NEAR;
}

/** Install the gate over the renderer's draw. */
export function installCompileGate(gl: THREE.WebGLRenderer): CompileGate {
  const draw = gl.renderBufferDirect.bind(gl);
  const properties = gl.properties as unknown as { get(m: THREE.Material): { programs?: Map<string, unknown> } };
  const ready = new WeakSet<THREE.Material>();
  const waits = new Map<THREE.Material, Wait>();
  let frame = 0;
  /** Whether a draw of `material` for `object` has to wait for its compile; queues the compile if so. */
  const held = (camera: THREE.Camera, geometry: THREE.BufferGeometry, material: THREE.Material, object: THREE.Object3D) => {
    const w = waits.get(material);
    if (w) {
      if (!w.done && frame - w.frame < GIVE_UP) return true;
      waits.delete(material);
      ready.add(material);
      return false;
    }
    if (properties.get(material).programs !== undefined) {
      ready.add(material);
      return false;
    }
    if (!farFrom(camera, object, geometry)) return false;
    waits.set(material, { object, material, frame, started: false, done: false });
    return true;
  };
  const waiting = (object: THREE.Object3D) => {
    const own = (object as THREE.Mesh).material;
    for (const m of [Array.isArray(own) ? undefined : own, object.customDepthMaterial, object.customDistanceMaterial]) {
      const w = m && waits.get(m);
      if (w && !w.done) return true;
    }
    return false;
  };
  gl.renderBufferDirect = (camera, scene, geometry, material, object, group) => {
    if (!ready.has(material)) {
      if (ownMaterial(object, material)) {
        if (held(camera, geometry, material, object)) return;
      } else if (waits.size && waiting(object)) {
        // A depth or twin draw of something still waiting (the shadow pass may draw through a copy of its depth material):
        // its shadow comes in with it.
        return;
      }
    }
    draw(camera, scene, geometry, material, object, group);
  };
  return {
    flush(compile) {
      frame++;
      for (const w of waits.values()) {
        if (w.started) continue;
        w.started = true;
        const done = () => (w.done = true);
        compile(w.object, w.material).then(done, done);
      }
    },
  };
}

const SHADOW_SIDE: Record<number, THREE.Side> = { [THREE.FrontSide]: THREE.BackSide, [THREE.BackSide]: THREE.FrontSide, [THREE.DoubleSide]: THREE.DoubleSide };

/**
 * Set an object's custom depth (or distance) material up as the shadow pass will before drawing with it, which it does at
 * every draw (three's `WebGLShadowMap`): the side turned round, and the object's own map, alpha test and displacement. A
 * compile ahead of time then builds the program the shadow pass will use, not a variant of it.
 */
export function asShadowDraws(object: THREE.Object3D, depth: THREE.Material) {
  const own = (object as THREE.Mesh).material;
  const m = (Array.isArray(own) ? own[0] : own) as THREE.MeshStandardMaterial | undefined;
  if (!m) return;
  const d = depth as THREE.MeshDepthMaterial;
  d.visible = m.visible;
  d.wireframe = m.wireframe;
  d.side = m.shadowSide !== null ? m.shadowSide : SHADOW_SIDE[m.side];
  d.alphaMap = m.alphaMap ?? null;
  d.alphaTest = m.alphaToCoverage === true ? 0.5 : m.alphaTest;
  d.map = m.map ?? null;
  d.clipShadows = m.clipShadows;
  d.clippingPlanes = m.clippingPlanes;
  d.clipIntersection = m.clipIntersection;
  d.displacementMap = m.displacementMap ?? null;
  d.displacementScale = m.displacementScale ?? 1;
  d.displacementBias = m.displacementBias ?? 0;
}
