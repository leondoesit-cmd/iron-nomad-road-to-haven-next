import * as THREE from 'three';
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';
import { TREE_DIMS, TREE_SPECIES, type TreeSpot } from '../world/flora';
import { treeAspect, treeVariantGeometry } from './trees';

/**
 * Faces that are not there: at the peak of a trip, the trunks of ordinary trees round the one who is tripping start to look
 * back too. Each is a decal laid onto the trunk's own bark (projected from the tree's real triangles, so it follows the flare
 * and the lumps), drawn in the shader as little more than shadow: sockets with light along the brow over them, the shadows
 * either side of a nose, a slit of a mouth that works slowly; and in each socket an amber eye round a slit of a pupil that
 * drifts and blinks, glowing after dark. They fade in where the tripper is looking, hold a while and fade out.
 *
 * Per player and per view: each player's faces live in their own group, and only that player's view shows it (`showFor`,
 * called from the per-view hook in `game/faceTrip.ts`). The partner never sees them.
 */

/** Trunks that take a face: thick enough, and with no leaves hanging round them at head height. */
const TRUNKS = new Set(['oak', 'pine', 'poplar', 'snag', 'eucalyptus'].map((s) => TREE_SPECIES.indexOf(s as (typeof TREE_SPECIES)[number])));

/** Most faces one player sees at once. */
export const GHOSTS_MAX = 5;

const FADE_IN = 2.6;
const FADE_OUT = 3.2;

interface Ghost {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  u: GhostUniforms;
  /** Which tree (its foot, rounded), so one tree is not haunted twice. */
  key: string;
  age: number;
  hold: number;
  /** Fading out early: the trip is going, or it fell behind. */
  leaving: boolean;
  out: number;
}

interface GhostUniforms {
  uGhostA: { value: number };
  uGhostPh: { value: number };
  uGhostNight: { value: number };
}

const VERT = /* glsl */ `
varying vec2 vGhostUv;
`;

/** The face in the decal's square: everything but shadow and the eyes' coals is clear. */
const FRAG = /* glsl */ `
uniform float uGhostA;
uniform float uGhostPh;
uniform float uGhostNight;
varying vec2 vGhostUv;
float gHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float gNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( gHash( i ), gHash( i + vec2( 1.0, 0.0 ) ), f.x ), mix( gHash( i + vec2( 0.0, 1.0 ) ), gHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}
`;

const FRAG_MAIN = /* glsl */ `
{
  vec2 p = vGhostUv - 0.5;
  float rag = 0.75 + 0.5 * gNoise( vGhostUv * 9.0 + uGhostPh * 0.05 );
  // Two sockets, a little lopsided, a brow's shadow over them and a ridge of light along the brow; in each, an eye.
  float eyes = 0.0;
  float ridge = 0.0;
  float iris = 0.0;
  float pupil = 0.0;
  // The eyes drift as if following something, now and then; a blink every so often.
  vec2 look = vec2( sin( uGhostPh * 0.37 ) * 0.25, sin( uGhostPh * 0.23 + 1.0 ) * 0.12 );
  float open = 1.0 - pow( max( 0.0, sin( uGhostPh * 0.31 + 2.0 ) ), 40.0 );
  for ( int s = 0; s < 2; s++ ) {
    float sx = s == 0 ? -1.0 : 1.0;
    vec2 e = ( p - vec2( sx * 0.17, 0.1 + sx * 0.012 ) ) / vec2( 0.085, 0.062 );
    float q = length( e ) / rag;
    eyes = max( eyes, 1.0 - smoothstep( 0.55, 1.15, q ) );
    vec2 b = ( p - vec2( sx * 0.18, 0.19 ) ) / vec2( 0.16, 0.05 );
    eyes = max( eyes, 0.45 * exp( -dot( b, b ) ) );
    vec2 rb = ( p - vec2( sx * 0.18, 0.235 ) ) / vec2( 0.15, 0.025 );
    ridge = max( ridge, exp( -dot( rb, rb ) ) );
    vec2 ie = ( e - look ) * vec2( 1.0, 1.1 / max( open, 0.05 ) );
    float d = length( ie );
    iris = max( iris, ( 1.0 - smoothstep( 0.42, 0.52, d ) ) * open );
    pupil = max( pupil, ( 1.0 - smoothstep( 0.17, 0.22, length( ie * vec2( 2.6, 1.0 ) ) ) ) * open );
  }
  // The mouth: a split that opens and closes, slowly, as if saying something.
  float talk = 0.5 + 0.5 * sin( uGhostPh * 1.3 ) * sin( uGhostPh * 0.41 + 1.0 );
  vec2 m = ( p - vec2( 0.0, -0.2 - 0.03 * p.x * p.x * 30.0 ) ) / vec2( 0.17 * rag, 0.02 + 0.035 * talk );
  float mouth = exp( -pow( abs( m.x ), 4.0 ) ) * exp( -m.y * m.y );
  // The nose's shadow either side.
  float nose = 0.0;
  for ( int s = 0; s < 2; s++ ) {
    vec2 n = ( p - vec2( ( s == 0 ? -1.0 : 1.0 ) * 0.055, -0.03 ) ) / vec2( 0.025, 0.1 );
    nose = max( nose, 0.5 * exp( -dot( n, n ) ) );
  }
  float shadow = clamp( max( max( eyes, mouth ), nose ), 0.0, 1.0 );
  // Soft at the edge of the square, and only ever as strong as the trip.
  float edge = 1.0 - smoothstep( 0.36, 0.5, max( abs( p.x ), abs( p.y ) ) );
  float pulse = 0.75 + 0.25 * sin( uGhostPh * 2.7 );
  // Shadow in the hollows, a little light on the brow, and in the sockets an amber eye round a slit, glowing after dark.
  vec3 col = vec3( 0.025, 0.018, 0.013 );
  float a = shadow * 0.85;
  col = mix( col, vec3( 0.5, 0.38, 0.26 ), ridge * ( 1.0 - shadow ) );
  a = max( a, ridge * 0.3 );
  vec3 amber = vec3( 1.0, 0.56, 0.14 ) * ( 0.9 + 2.2 * uGhostNight ) * pulse;
  col = mix( col, amber, iris * ( 1.0 - pupil ) );
  col = mix( col, vec3( 0.0 ), pupil * iris );
  a = max( a, iris );
  diffuseColor.rgb = col;
  diffuseColor.a = clamp( a, 0.0, 1.0 ) * edge * uGhostA;
  if ( diffuseColor.a < 0.004 ) discard;
}
`;

function ghostMaterial(): { mat: THREE.MeshBasicMaterial; u: GhostUniforms } {
  const u: GhostUniforms = { uGhostA: { value: 0 }, uGhostPh: { value: 0 }, uGhostNight: { value: 0 } };
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${VERT}`).replace('#include <uv_vertex>', '#include <uv_vertex>\nvGhostUv = uv;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${FRAG}`).replace('#include <color_fragment>', `#include <color_fragment>\n${FRAG_MAIN}`);
  };
  mat.customProgramCacheKey = () => 'faceGhost';
  return { mat, u };
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _n = new THREE.Vector3();

/** A tree's world matrix, as `treeInstances` draws it. */
function treeMatrix(t: TreeSpot, out: THREE.Matrix4): THREE.Matrix4 {
  _p.set(t.x, t.y, t.z);
  _e.set(t.lean[0], t.yaw, t.lean[1], 'YXZ');
  _q.setFromEuler(_e);
  const [ax, ay] = treeAspect(t);
  _s.set(t.s * ax, t.s * ay, t.s * ax);
  return out.compose(_p, _q, _s);
}

/**
 * The bark of one trunk round a height band, in world space, facing one way: just the triangles a face there could lie on,
 * so the decal's projection works through a few hundred of them rather than the whole tree.
 */
function trunkPatch(t: TreeSpot, y0: number, y1: number, dirX: number, dirZ: number): THREE.Mesh | null {
  const geo = treeVariantGeometry(t.sp, t.v);
  const pos = geo.getAttribute('position');
  const tree = geo.getAttribute('tree');
  const idx = geo.index;
  if (!idx) return null;
  const M = treeMatrix(t, _m);
  const reach = TREE_DIMS[TREE_SPECIES[t.sp]].trunk * 2.6;
  const out: number[] = [];
  const nor: number[] = [];
  for (let i = 0; i < idx.count; i += 3) {
    const ia = idx.getX(i);
    const ib = idx.getX(i + 1);
    const ic = idx.getX(i + 2);
    // Bark only (leaves flutter), across the band (the trunk's triangles can be a metre or two tall), near the axis.
    if (tree.getX(ia) > 0 || tree.getX(ib) > 0 || tree.getX(ic) > 0) continue;
    const ya = pos.getY(ia);
    const yb = pos.getY(ib);
    const yc = pos.getY(ic);
    if (Math.max(ya, yb, yc) < y0 || Math.min(ya, yb, yc) > y1) continue;
    if (Math.min(Math.hypot(pos.getX(ia), pos.getZ(ia)), Math.hypot(pos.getX(ib), pos.getZ(ib)), Math.hypot(pos.getX(ic), pos.getZ(ic))) > reach) continue;
    _a.fromBufferAttribute(pos, ia).applyMatrix4(M);
    _b.fromBufferAttribute(pos, ib).applyMatrix4(M);
    _c.fromBufferAttribute(pos, ic).applyMatrix4(M);
    _n.subVectors(_c, _b).cross(_p.subVectors(_a, _b)).normalize();
    // Facing the one who sees it (either winding: the bark is drawn both sides).
    const f = _n.x * dirX + _n.z * dirZ;
    if (Math.abs(f) < 0.3) continue;
    const sg = f > 0 ? 1 : -1;
    out.push(_a.x, _a.y, _a.z, _b.x, _b.y, _b.z, _c.x, _c.y, _c.z);
    for (let k = 0; k < 3; k++) nor.push(_n.x * sg, _n.y * sg, _n.z * sg);
  }
  if (out.length < 9) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return new THREE.Mesh(g);
}

export class FaceGhosts {
  readonly group = new THREE.Group();
  /** One group per player: only their own view shows it. */
  private mine: THREE.Group[] = [new THREE.Group(), new THREE.Group()];
  private ghosts: Ghost[][] = [[], []];

  constructor() {
    this.group.name = 'faceGhosts';
    for (const g of this.mine) {
      g.visible = false;
      this.group.add(g);
    }
  }

  count(i: number): number {
    return this.ghosts[i].length;
  }

  /** Whether a tree already wears one of this player's faces. */
  haunted(i: number, t: TreeSpot): boolean {
    const key = `${Math.round(t.x * 10)}:${Math.round(t.z * 10)}`;
    return this.ghosts[i].some((g) => g.key === key);
  }

  /** Whether a tree can take a face at all. */
  static takes(t: TreeSpot): boolean {
    return TRUNKS.has(t.sp) && t.s >= 0.6;
  }

  /**
   * Lay a face on a trunk, looking toward (`fx`, `fz`). Returns false when the bark there would not take it (too thin, no
   * triangles facing that way).
   */
  spawn(i: number, t: TreeSpot, fx: number, fz: number, seed: number): boolean {
    if (!FaceGhosts.takes(t) || this.ghosts[i].length >= GHOSTS_MAX) return false;
    let dx = fx - t.x;
    let dz = fz - t.z;
    const l = Math.hypot(dx, dz);
    if (l < 1) return false;
    dx /= l;
    dz /= l;
    const D = TREE_DIMS[TREE_SPECIES[t.sp]];
    const [ax, ay] = treeAspect(t);
    const sy = t.s * ay;
    const R = D.trunk * t.s * ax;
    // The face's eyes a little over head height on a big trunk, lower on a small one.
    const h = Math.min(1.55, 0.9 + R * 1.1) + (seed - 0.5) * 0.2;
    const patch = trunkPatch(t, (h - 0.75) / sy, (h + 0.75) / sy, dx, dz);
    if (!patch) return false;
    // The axis at that height, leaning with the tree (the matrix first: it works in `_p` too).
    const M = treeMatrix(t, _m);
    _p.set(0, h / sy, 0).applyMatrix4(M);
    const w = Math.min(0.75, Math.max(0.34, R * 1.45));
    const depth = R * 2.4 + 0.5;
    _a.set(_p.x + dx * (depth / 2 - 0.05), _p.y, _p.z + dz * (depth / 2 - 0.05));
    const yaw = Math.atan2(dx, dz);
    const decal = new DecalGeometry(patch, _a, new THREE.Euler(0, yaw, (seed - 0.5) * 0.18, 'YXZ'), new THREE.Vector3(w, w * 1.3, depth));
    patch.geometry.dispose();
    if (!decal.getAttribute('position') || decal.getAttribute('position').count < 3) {
      decal.dispose();
      return false;
    }
    // Lift it off the bark a hair, along its own normals, so the trunk's breathing on a trip does not swallow it.
    const pa = decal.getAttribute('position') as THREE.BufferAttribute;
    const na = decal.getAttribute('normal') as THREE.BufferAttribute | undefined;
    if (na) for (let k = 0; k < pa.count; k++) pa.setXYZ(k, pa.getX(k) + na.getX(k) * 0.012, pa.getY(k) + na.getY(k) * 0.012, pa.getZ(k) + na.getZ(k) * 0.012);
    decal.computeBoundingSphere();
    const { mat, u } = ghostMaterial();
    u.uGhostPh.value = seed * 40;
    const mesh = new THREE.Mesh(decal, mat);
    mesh.renderOrder = 2;
    this.mine[i].add(mesh);
    this.ghosts[i].push({ mesh, mat, u, key: `${Math.round(t.x * 10)}:${Math.round(t.z * 10)}`, age: 0, hold: 7 + seed * 8, leaving: false, out: 0 });
    return true;
  }

  /**
   * Age one player's faces. `k` is how far into the trip they are (the faces fade with it), `night` how dark it is, and
   * `keep` says whether a face's tree is still worth haunting (near enough, roughly in view).
   */
  update(i: number, dt: number, k: number, night: number, keep: (x: number, z: number) => boolean) {
    const list = this.ghosts[i];
    const strength = Math.max(0, Math.min(1, (k - 0.5) / 0.3));
    for (let n = list.length - 1; n >= 0; n--) {
      const g = list[n];
      g.age += dt;
      g.u.uGhostPh.value += dt;
      g.u.uGhostNight.value = night;
      const sp = g.mesh.geometry.boundingSphere!;
      if (!g.leaving && (g.age > FADE_IN + g.hold || strength <= 0 || !keep(sp.center.x, sp.center.z))) g.leaving = true;
      if (g.leaving) g.out += dt;
      const a = Math.min(1, g.age / FADE_IN) * (1 - Math.min(1, g.out / FADE_OUT)) * strength;
      g.u.uGhostA.value = a;
      if (g.leaving && g.out >= FADE_OUT) this.drop(i, n);
    }
  }

  /** Show only player `i`'s faces (or nobody's, -1): set before each view is drawn. */
  showFor(i: number) {
    this.mine[0].visible = i === 0 && this.ghosts[0].length > 0;
    this.mine[1].visible = i === 1 && this.ghosts[1].length > 0;
  }

  /** Where one player's faces are (for whispers), and how strongly each shows. */
  each(i: number, fn: (x: number, y: number, z: number, a: number) => void) {
    for (const g of this.ghosts[i]) {
      const c = g.mesh.geometry.boundingSphere!.center;
      fn(c.x, c.y, c.z, g.u.uGhostA.value);
    }
  }

  private drop(i: number, n: number) {
    const g = this.ghosts[i][n];
    g.mesh.removeFromParent();
    g.mesh.geometry.dispose();
    g.mat.dispose();
    this.ghosts[i].splice(n, 1);
  }

  clear(i: number) {
    for (let n = this.ghosts[i].length - 1; n >= 0; n--) this.drop(i, n);
  }

  dispose() {
    this.clear(0);
    this.clear(1);
    this.group.removeFromParent();
  }
}
