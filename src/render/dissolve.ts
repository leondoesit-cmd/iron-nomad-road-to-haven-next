import * as THREE from 'three';

/**
 * Things that arrive in view (a streamed chunk, a parked car, a pickup) dissolve in over a moment instead of popping, and
 * the far stand-ins they replace dissolve out over the same moment, so there is never a gap or a double image.
 *
 * It is a screen-door dissolve: opaque, so nothing is sorted. A pixel of the arriving object is kept where a fixed
 * per-pixel noise is below its fade, a pixel of the stand-in where the same noise is at or above that fade, so at every
 * fade the two share the screen between them exactly. The noise is a function of the pixel alone, the same in every view.
 *
 * Nothing changes in the shaders everything is normally drawn with. While an object is dissolving the draw filter
 * (`drawFilter.ts`) draws it with a twin of its material that discards the pixels not yet in; the twin shares the
 * material's shader patches, uniforms and program cache key plus one suffix, so it compiles once per kind of material
 * (`twinWarmups`: behind the loading veil, or while a chunk is still hidden) and costs nothing once the object is in.
 */

/** Seconds an arrival takes. */
export const DISSOLVE_TIME = 0.6;

/** The per-pixel noise both sides compare against (interleaved gradient noise: even and fine-grained). */
export const DISSOLVE_NOISE = /* glsl */ `
float inDissolveNoise() {
  return fract( 52.9829189 * fract( dot( floor( gl_FragCoord.xy ), vec2( 0.06711056, 0.00583715 ) ) ) );
}
`;

/**
 * The fragment side of a far stand-in stepping aside, for a vertex shader that has set `vFarCut` to how far the detailed
 * chunk under it is in: its pixel goes wherever the arriving chunk has taken that pixel.
 */
export const FAR_CUT_FRAG_PARS = `varying float vFarCut;\n${DISSOLVE_NOISE}`;
export const FAR_CUT_FRAG = '#include <clipping_planes_fragment>\nif ( inDissolveNoise() < vFarCut ) discard;';

/** How far in an object is, read by the draw filter at each of its draws. 1 (or no state) draws it as it is. */
export interface DissolveState {
  value: number;
}

/** Mark every drawable under `root` as dissolving by `s` (null when it is fully in again). */
export function markDissolve(root: THREE.Object3D, s: DissolveState | null) {
  root.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh && !(o as THREE.Points).isPoints && !(o as THREE.Line).isLine) return;
    if (s) o.userData.dissolve = s;
    else delete o.userData.dissolve;
  });
}

/** The fade of an object at a draw, or 1 when it is not dissolving. */
export function dissolveOf(object: THREE.Object3D): number {
  const s = object.userData.dissolve as DissolveState | undefined;
  return s ? s.value : 1;
}

/**
 * Fades owned by one system: each root fades in, or out and then calls back (to be removed for good). A root faded in
 * while still fading out turns round from where it is.
 */
export class Fades {
  private list = new Map<THREE.Object3D, { s: DissolveState; dir: 1 | -1; done?: () => void }>();

  /** Fade `root` in from nothing (or from where an unfinished fade-out left it). */
  fadeIn(root: THREE.Object3D) {
    const e = this.list.get(root);
    if (e) {
      e.dir = 1;
      e.done = undefined;
      return;
    }
    const s = { value: 0 };
    markDissolve(root, s);
    this.list.set(root, { s, dir: 1 });
  }

  /** Fade `root` out, then call `done`. */
  fadeOut(root: THREE.Object3D, done: () => void) {
    const e = this.list.get(root);
    if (e) {
      e.dir = -1;
      e.done = done;
      return;
    }
    const s = { value: 1 };
    markDissolve(root, s);
    this.list.set(root, { s, dir: -1, done });
  }

  /** Forget a root (it was removed some other way): draw it whole, call nothing. */
  cancel(root: THREE.Object3D) {
    if (!this.list.delete(root)) return;
    markDissolve(root, null);
  }

  /** How far in `root` is: its fade while it is fading, otherwise 1. */
  value(root: THREE.Object3D): number {
    return this.list.get(root)?.s.value ?? 1;
  }

  fading(root: THREE.Object3D): boolean {
    return this.list.has(root);
  }

  /** Whether a fade-out is under way for `root`. */
  leaving(root: THREE.Object3D): boolean {
    return this.list.get(root)?.dir === -1;
  }

  update(dt: number) {
    if (!this.list.size) return;
    const step = dt / DISSOLVE_TIME;
    for (const [root, e] of this.list) {
      e.s.value = Math.min(1, Math.max(0, e.s.value + step * e.dir));
      if (e.dir === 1 && e.s.value >= 1) {
        this.list.delete(root);
        markDissolve(root, null);
      } else if (e.dir === -1 && e.s.value <= 0) {
        this.list.delete(root);
        markDissolve(root, null);
        e.done?.();
      }
    }
  }

  /** Finish every fade at once (a scene going away). */
  clear() {
    for (const [root, e] of this.list) {
      markDissolve(root, null);
      if (e.dir === -1) e.done?.();
    }
    this.list.clear();
  }
}

// ------------------------------------------------------------------------------------------ twins

const MAIN = /void\s+main\s*\(\s*(?:void)?\s*\)\s*\{/;

/** Add the discard to a compiled shader's fragment stage. */
function injectDissolve(shader: THREE.WebGLProgramParametersWithUniforms, u: { value: number }) {
  shader.uniforms.uDissolve = u;
  shader.fragmentShader = shader.fragmentShader.replace(
    MAIN,
    (m) => `uniform float uDissolve;\n${DISSOLVE_NOISE}\n${m}\n  if ( inDissolveNoise() >= uDissolve ) discard;\n`,
  );
}

/** Properties that may be changed on a material after it is made, copied onto its twins at every draw. */
const LIVE_VALUES = ['opacity', 'emissiveIntensity', 'roughness', 'metalness', 'depthWrite', 'depthTest', 'colorWrite', 'polygonOffset', 'polygonOffsetFactor', 'polygonOffsetUnits', 'envMapIntensity'] as const;
/** Those of them that choose the program as well: a change has the twin's program looked up again. */
const LIVE_PROGRAM = ['map', 'alphaTest', 'transparent', 'side'] as const;
const LIVE_COLORS = ['color', 'emissive'] as const;

interface Twins {
  pair: [THREE.Material, THREE.Material];
  u: [{ value: number }, { value: number }];
}

const twins = new WeakMap<THREE.Material, Twins>();
const baseKey = THREE.Material.prototype.customProgramCacheKey;

function makeTwin(base: THREE.Material, u: { value: number }): THREE.Material {
  // userData can hold anything (it is copied through JSON); twins need none of it.
  const ud = base.userData;
  base.userData = {};
  let t: THREE.Material;
  try {
    t = base.clone();
  } finally {
    base.userData = ud;
  }
  t.userData = { dissolveTwinOf: base };
  // A ShaderMaterial's clone copies its uniform values: share the original's (so they stay live) and add our own.
  const sm = t as THREE.ShaderMaterial;
  if (sm.isShaderMaterial) sm.uniforms = { ...(base as THREE.ShaderMaterial).uniforms, uDissolve: u };
  const bm = base as THREE.Material & { defines?: Record<string, unknown> };
  if (bm.defines) (t as typeof bm).defines = { ...bm.defines };
  // Neither the shader patch nor its cache key is copied by clone(); without the key every twin would share one program.
  const patch = base.onBeforeCompile;
  t.onBeforeCompile = function (shader, renderer) {
    patch.call(t, shader, renderer);
    injectDissolve(shader, u);
  };
  t.customProgramCacheKey = () => `${base.customProgramCacheKey === baseKey ? patch.toString() : base.customProgramCacheKey()}|dissolve`;
  return t;
}

function twinsOf(base: THREE.Material): Twins {
  let tw = twins.get(base);
  if (!tw) {
    const u: Twins['u'] = [{ value: 1 }, { value: 1 }];
    tw = { pair: [makeTwin(base, u[0]), makeTwin(base, u[1])], u };
    twins.set(base, tw);
  }
  return tw;
}

/**
 * Bring a twin up to what its material is now. (three's own double-sided transparent pass flips `side` on the material,
 * with a version bump, twice a draw: the twin follows the side rather than being made anew.)
 */
function syncLive(base: THREE.Material, t: THREE.Material) {
  const b = base as unknown as Record<string, unknown>;
  const d = t as unknown as Record<string, unknown>;
  for (const k of LIVE_VALUES) if (k in b && d[k] !== b[k]) d[k] = b[k];
  for (const k of LIVE_PROGRAM) {
    if (!(k in b) || d[k] === b[k]) continue;
    d[k] = b[k];
    t.needsUpdate = true;
  }
  for (const k of LIVE_COLORS) {
    const c = b[k] as THREE.Color | undefined;
    if (c?.isColor) (d[k] as THREE.Color).copy(c);
  }
}

/** The material last handed to three, and its fade, so two draws in a row of one twin never share a stale value. */
let lastTwin: THREE.Material | null = null;
let lastValue = -1;

/**
 * The material to draw `base` with at fade `value` (0..1). three uploads a material's uniforms only when the material
 * changes from one draw to the next, so each base has two twins: a draw that needs another fade than the draw just before
 * it on the same twin takes the other one, and the change of material uploads the value.
 */
export function dissolveTwin(base: THREE.Material, value: number): THREE.Material {
  const tw = twinsOf(base);
  let i = 0;
  if (tw.pair[0] === lastTwin && lastValue !== value) i = 1;
  else if (tw.pair[1] === lastTwin && lastValue === value) i = 1;
  const t = tw.pair[i];
  tw.u[i].value = value;
  syncLive(base, t);
  lastTwin = t;
  lastValue = value;
  return t;
}

/** The draw filter tells this module about every draw, so `dissolveTwin` knows what three drew last. */
export function noteDrawn(material: THREE.Material) {
  if (material !== lastTwin) {
    lastTwin = null;
    lastValue = -1;
  }
}

// ------------------------------------------------------------------------------------------ warm-up

/** Mark a root whose drawables may dissolve, so `twinWarmups` compiles their twins ahead of time. */
export function markDissolvable(root: THREE.Object3D) {
  root.userData.dissolvable = true;
}

/** What three keys a material's program on: enough of it to tell when two draws would want different programs. */
function programKey(o: THREE.Mesh, m: THREE.Material): string {
  const r = m as unknown as Record<string, unknown>;
  const im = o as THREE.InstancedMesh;
  const variant = im.isInstancedMesh ? (im.instanceColor ? 'ic' : 'i') : (o as THREE.SkinnedMesh).isSkinnedMesh ? 's' : 'm';
  const maps = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'alphaMap', 'aoMap', 'envMap', 'lightMap', 'bumpMap'].map((k) => (r[k] ? 1 : 0)).join('');
  const geo = o.geometry;
  const attrs = `${geo.attributes.color?.itemSize ?? 0}${geo.attributes.tangent ? 't' : ''}${geo.morphAttributes.position ? 'p' : ''}`;
  const defines = (m as THREE.ShaderMaterial).defines ? JSON.stringify((m as THREE.ShaderMaterial).defines) : '';
  return [m.type, m.customProgramCacheKey(), variant, maps, attrs, m.vertexColors, m.transparent, m.alphaTest > 0, m.side, r.flatShading, r.fog, defines].join('|');
}

const warmed = new Set<string>();

/**
 * Stand-ins for every material under the dissolvable roots of `root` whose dissolve twin (and the material itself) has not
 * been compiled yet: one mesh each, sharing the geometry and the kind of object (instanced or not), so a `compileAsync`
 * of the group builds exactly the programs those draws will want. Null when there is nothing new.
 */
export function twinWarmups(root: THREE.Object3D): THREE.Group | null {
  const g = new THREE.Group();
  const add = (o: THREE.Mesh, m: THREE.Material) => {
    const key = programKey(o, m);
    if (warmed.has(key)) return;
    warmed.add(key);
    for (const mat of [m, twinsOf(m).pair[0]]) {
      const src = o as THREE.InstancedMesh;
      let p: THREE.Mesh;
      if (src.isInstancedMesh) {
        const ip = new THREE.InstancedMesh(o.geometry, mat, 1);
        if (src.instanceColor) ip.instanceColor = src.instanceColor;
        p = ip;
      } else p = new THREE.Mesh(o.geometry, mat);
      g.add(p);
    }
  };
  const walk = (o: THREE.Object3D, on: boolean) => {
    on ||= o.userData.dissolvable === true;
    const m = o as THREE.Mesh;
    // A skinned mesh needs its skeleton to compile: those few compile when first drawn.
    if (on && m.isMesh && !(m as THREE.SkinnedMesh).isSkinnedMesh && m.material) {
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) add(m, mat);
    }
    for (const c of o.children) walk(c, on);
  };
  walk(root, false);
  return g.children.length ? g : null;
}
