import * as THREE from 'three';
import { cacheArrayUniforms } from './uniformCache';
import { dissolveOf, dissolveTwin, noteDrawn } from './dissolve';

type Group = { start: number; count: number } | null;

/**
 * A draw that cannot put a pixel anywhere: an instanced mesh with no instances left (a bramble picked bare, a crop that
 * is not fruiting, a pool with nothing live), an instanced geometry asked for none, or a draw range or group of no
 * vertices. three would still pick the program, upload the material's uniforms and bind the vertex arrays for it before
 * issuing an empty draw, in every view and in every shadow pass.
 */
export function isEmptyDraw(geometry: THREE.BufferGeometry, object: THREE.Object3D, group: Group): boolean {
  if ((object as THREE.InstancedMesh).isInstancedMesh && (object as THREE.InstancedMesh).count <= 0) return true;
  if ((geometry as THREE.InstancedBufferGeometry).isInstancedBufferGeometry && (geometry as THREE.InstancedBufferGeometry).instanceCount <= 0) return true;
  if (geometry.drawRange.count <= 0) return true;
  return !!group && group.count <= 0;
}

/**
 * Mark a transparent, double-sided material that many meshes share (window glass) so its two passes are drawn with two
 * fixed one-sided copies. three draws such a material back faces first and then front faces by setting `side` and
 * `needsUpdate` on it before each pass, and the version bump sends every one of those draws through a full program look-up
 * (its parameters, its cache key) although the program already exists. The copies never change, so they skip it. The pass
 * order, and so the picture, stays the same. Only for materials whose properties are not changed after they are made.
 */
export function drawSidesWithTwins<T extends THREE.Material>(m: T): T {
  m.userData.sideTwins = true;
  return m;
}

const twins = new WeakMap<THREE.Material, THREE.Material[]>();

/** The one-sided copy of a marked material for the side three has just set on it. */
export function sideTwin(m: THREE.Material): THREE.Material {
  let pair = twins.get(m);
  if (!pair) {
    twins.set(m, (pair = []));
    m.addEventListener('dispose', () => {
      for (const t of twins.get(m) ?? []) t?.dispose();
      twins.delete(m);
    });
  }
  let t = pair[m.side];
  if (!t) {
    t = m.clone();
    t.side = m.side;
    t.userData.sideTwins = false;
    pair[m.side] = t;
  }
  return t;
}

/** The draw is of the object's own material (not a shadow pass's depth material or an override). */
function ownMaterial(object: THREE.Object3D, material: THREE.Material): boolean {
  const m = (object as THREE.Mesh).material;
  return m === material || (Array.isArray(m) && m.includes(material));
}

/**
 * Filter what reaches the GPU before three sets it up: empty draws are dropped, marked double-sided materials are drawn
 * through their one-sided copies, dissolving objects through their material's dissolve twin (`dissolve.ts`), and each
 * program's array uniforms learn to skip unchanged uploads. Both the scene passes and the shadow map go through
 * `renderBufferDirect`, so one wrapper covers them all; `compile`/`compileAsync` do not, so shader warm-up still sees every material (and the copies share
 * the programs it compiles for each side).
 */
export function installDrawFilter(gl: THREE.WebGLRenderer) {
  const draw = gl.renderBufferDirect.bind(gl);
  const properties = gl.properties as unknown as { get(m: THREE.Material): { currentProgram?: Parameters<typeof cacheArrayUniforms>[0] } };
  let lastMaterial: THREE.Material | null = null;
  gl.renderBufferDirect = (camera, scene, geometry, material, object, group) => {
    if (isEmptyDraw(geometry, object, group)) return;
    // Arriving (or leaving) things are drawn through a dissolving twin of their material; nothing of them shows at 0.
    // A shadow pass draws them with its own depth material: their shadow comes in halfway through the dissolve.
    const fade = dissolveOf(object);
    const own = fade < 1 && ownMaterial(object, material);
    if (fade < 1 && (fade <= 0 || (!own && fade < 0.5))) return;
    if (material.userData.sideTwins === true && material.side !== THREE.DoubleSide) material = sideTwin(material);
    if (own) material = dissolveTwin(material, fade);
    draw(camera, scene, geometry, material, object, group);
    noteDrawn(material);
    // Once a program has drawn, its uniforms exist: let its array uniforms skip re-sending unchanged values (uniformCache).
    if (material !== lastMaterial) {
      lastMaterial = material;
      const program = properties.get(material).currentProgram;
      if (program) cacheArrayUniforms(program);
    }
  };
}
