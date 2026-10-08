import * as THREE from 'three';
import { clamp, smoothstep } from '../core/math';
import { hash2, noise2 } from '../core/rng';
import type { Look } from '../sim/drugs';
import type { Bend, OldGum, Stump } from '../world/millBend';
import { TREE_DIMS } from '../world/flora';
import { shared } from './dispose';
import { LEAF_ATLAS, LEAF_CELL, leafAtlas } from './proctex';

/**
 * The old gums' swollen feet (`world/millBend.ts`): lumpy, buttressed, burred, fire-scarred, some forked and some split open,
 * dark rough bark below going pale and smooth up toward the stems (which are ordinary eucalyptus, planted by the chunks).
 * On the foot of each, a face or two: eye sockets where knots fell out, a ridge of a nose, the crack of a mouth, brows and
 * cheeks in the burls, a little lopsided, the way a face is in bark. Sober, they are hardly there.
 *
 * Tripping (`FACE_TRIP.k`, set per view from the viewer's own trip by `game/faceTrip.ts`), they come forward: the sockets
 * sink and darken, the brows and nose and cheekbones stand out and catch the light, the cheeks fill and empty like breath,
 * the brows lift and knit, the mouths open and close slowly in phrases as if saying something, and now and then an eye
 * blinks shut. At the peak there is an eye in each socket, a wet amber iris round a black pupil, and it turns to follow the
 * one who is tripping; at night a faint glow comes up from deep in the eyes and the mouth. Everything the trip adds rides in
 * vertex attributes and a handful of uniforms, so it costs nothing sober and never needs a rebuild.
 *
 * Each foot is a `THREE.LOD`: the full mesh (dense round the faces) up close, a plain one beyond, nothing far off.
 */

/**
 * The trip, as the faces see it, set per view before it is drawn (only the tripping player's view has `k` above 0): strength
 * 0..1, the trip's own clock, where the viewer's head is (the eyes follow it), and how dark it is (the glow).
 */
export const FACE_TRIP = { k: { value: 0 }, ph: { value: 0 }, look: { value: new THREE.Vector3() }, night: { value: 0 } };

/** How strongly a trip brings the faces out: mushrooms most of all, LSD and ayahuasca nearly as much, the rest a little. */
export function faceStrength(l: Look): number {
  return clamp(l.mush * 0.8 + l.breathe * 0.45 + l.kaleido * 0.7 + l.eye * 0.9 + l.warp * 0.25, 0, 1);
}

/** From what strength the eyes open in the sockets and follow the viewer (full by `EYES_FULL`). */
export const EYES_FROM = 0.45;
export const EYES_FULL = 0.85;

const FINE_TO = 40;
const HIDE_AT = 260;

// ---------------------------------------------------------------------------------------------------------------- bark

let barkTex: THREE.DataTexture | null = null;

/** Grey-scale detail multiplied over the vertex colours: long fissures, flaking plates between them. */
function barkTexture(): THREE.DataTexture {
  if (barkTex) return barkTex;
  const W = 128;
  const H = 256;
  const d = new Uint8Array(W * H * 4);
  // Noise that tiles: four samples a period apart, blended across the tile.
  const tile = (x: number, y: number, px: number, py: number, s: number) => {
    const a = x / px;
    const b = y / py;
    return (
      noise2(x, y, s) * (1 - a) * (1 - b) + noise2(x - px, y, s) * a * (1 - b) + noise2(x, y - py, s) * (1 - a) * b + noise2(x - px, y - py, s) * a * b
    );
  };
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const u = i / W;
      const v = j / H;
      // Fissures a hand's width apart running up the trunk (but broken every few tens of centimetres), flaking plates between
      // them, and a fine grain.
      const f1 = tile(u * 8, v * 1.8, 8, 1.8, 11) * 0.75 + tile(u * 16, v * 3.6, 16, 3.6, 14) * 0.25;
      const fiss = Math.pow(Math.min(1, Math.abs(f1 - 0.5) * 3.2), 0.7);
      const plate = tile(u * 14, v * 7, 14, 7, 12);
      const flake = tile(u * 34, v * 26, 34, 26, 13);
      let k = 0.6 + 0.4 * fiss;
      k *= 0.82 + 0.3 * plate;
      k *= 0.88 + 0.18 * flake;
      const c = Math.round(clamp(k, 0, 1) * 255);
      const o = (j * W + i) * 4;
      d[o] = c;
      d[o + 1] = c;
      d[o + 2] = Math.round(c * 0.97);
      d[o + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(d, W, H, THREE.RGBAFormat);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return (barkTex = shared(t));
}

let mat: THREE.MeshStandardMaterial | null = null;

/**
 * The faces' vertex work. Attributes (all zero away from a face, and on the stumps):
 *  - `aFace`: what the trip adds along the normal (m), the holes' darkness, the mouth's working (m), the eye socket's floor;
 *  - `aMorph`: the brows' and cheeks' motion (m), the wider shading a trip brings, the face's own 0..1 seed (its rhythm);
 *  - `aEye`: where this point is in the nearest eye (eye radii, across and up), which way the face looks (azimuth), and how
 *    far a blink pushes the socket's floor out to close it (m);
 *  - `aNormal2`: the normal of the face at its strongest, blended in with the trip.
 */
const FACE_VERTEX = /* glsl */ `#include <begin_vertex>
{
  float fk = uFaceK;
  float fk2 = fk * fk;
  float fSeed = aMorph.w * 6.2832;
  float fPh = uFacePh;
  // Speech in phrases: a while of slow working, a while still.
  float fPhrase = smoothstep( 0.1, 0.8, 0.5 + 0.5 * sin( fPh * 0.37 + fSeed ) );
  float fTalk = fPhrase * ( 0.5 + 0.5 * sin( fPh * 2.1 + fSeed * 1.7 + position.y * 2.0 ) );
  // The brows lift and knit; the cheeks fill and empty; an eye shuts for a moment now and then.
  float fBrow = sin( fPh * 0.53 + fSeed * 2.3 ) * 0.7 + sin( fPh * 1.31 + fSeed ) * 0.3;
  float fBreath = sin( fPh * 0.71 + fSeed * 0.9 );
  float fBlink = pow( max( 0.0, sin( fPh * 0.29 + fSeed * 3.1 ) ), 30.0 );
  // At the peak an eyeball comes up into each socket (and a blink closes it over).
  float fOpen = smoothstep( ${EYES_FROM.toFixed(2)}, ${EYES_FULL.toFixed(2)}, fk );
  float fBall = max( 0.85 * fOpen, fBlink );
  // Out from the trunk's axis, the way the foot was built (not along the normal: in a deep socket that points sideways, and
  // the walls would fold across the hole).
  vec3 fOut = normalize( vec3( position.x, 0.0, position.z ) + vec3( 1e-5, 0.0, 0.0 ) );
  transformed += fOut * ( aFace.x * fk - aFace.z * fk2 * ( 0.35 + 0.95 * fTalk ) + aMorph.x * fk2 * fBrow + aMorph.y * fk2 * fBreath + aEye.w * fk2 * fBall );
  transformed.y += aMorph.x * fk2 * fBrow * 0.6;
  // The eyes turn to the one looking: the viewer's head, in the face's own frame (across, up).
  vec3 fW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  vec3 fTo = normalize( uFaceLook - fW );
  float fCa = cos( aEye.z );
  float fSa = sin( aEye.z );
  vec2 fLook = vec2( dot( fTo, vec3( -fSa, 0.0, fCa ) ), fTo.y );
  // From behind, they strain round as far as they go.
  if ( dot( fTo.xz, vec2( fCa, fSa ) ) < 0.0 ) fLook = normalize( fLook + vec2( 1e-4 ) );
  vFaceEye = vec4( aEye.xy, clamp( fLook * 0.45, vec2( -0.32 ), vec2( 0.32 ) ) );
  vFaceMisc = vec2( fOpen * ( 1.0 - fBlink ), aFace.z );
  vFace = vec4( aFace.y, aFace.w, aMorph.z, clamp( ( aMorph.x + aMorph.y ) * 30.0, 0.0, 1.0 ) );
}`;

const FACE_COLOUR = /* glsl */ `#include <color_fragment>
float faceIris = 0.0;
float faceBall = 0.0;
float faceWet = 0.0;
{
  float fk = uFaceK;
  // Shadow deep in the holes, darker on a trip, and a wider shading round them; brows and cheekbones catch the light.
  diffuseColor.rgb *= 1.0 - vFace.x * ( 0.55 + 0.3 * fk );
  diffuseColor.rgb *= 1.0 - vFace.z * 0.32 * fk;
  diffuseColor.rgb *= 1.0 + vFace.w * 0.4 * fk;
  // At the peak an eye in each socket: dark and wet, an amber iris round a slit of a pupil, turned to the viewer, a glint
  // on it.
  if ( vFaceMisc.x > 0.002 ) {
    float r = length( vFaceEye.xy );
    faceBall = ( 1.0 - smoothstep( 0.46, 0.62, r ) ) * vFaceMisc.x;
    faceWet = ( 1.0 - smoothstep( 0.25, 0.42, r ) ) * vFaceMisc.x;
    vec2 e = ( vFaceEye.xy - vFaceEye.zw ) * vec2( 1.0, 1.1 );
    float d = length( e );
    float iris = 1.0 - smoothstep( 0.33, 0.39, d );
    float pupil = 1.0 - smoothstep( 0.16, 0.2, length( e * vec2( 2.8, 1.0 ) ) );
    vec3 irisC = mix( vec3( 0.95, 0.58, 0.12 ), vec3( 0.5, 0.75, 0.2 ), 0.5 + 0.5 * sin( uFacePh * 0.31 ) ) * ( 0.5 + 0.8 * smoothstep( 0.08, 0.36, d ) );
    vec3 eyeC = mix( vec3( 0.24, 0.14, 0.07 ) * ( 0.55 + 0.6 * ( 1.0 - r ) ), irisC, iris );
    eyeC = mix( eyeC, vec3( 0.006 ), pupil );
    eyeC += ( 1.0 - smoothstep( 0.035, 0.07, length( e - vec2( 0.12, 0.13 ) ) ) ) * 0.8;
    diffuseColor.rgb = mix( diffuseColor.rgb, eyeC, faceBall );
    faceIris = iris * ( 1.0 - pupil ) * faceBall;
  }
}`;

const FACE_WET = /* glsl */ `#include <roughnessmap_fragment>
roughnessFactor = mix( roughnessFactor, 0.3, faceWet );`;

const FACE_GLOW = /* glsl */ `#include <emissivemap_fragment>
{
  float fk = uFaceK;
  float fPulse = 0.6 + 0.4 * sin( uFacePh * 2.3 );
  // The irises glow a little by day and burn at night; deep in the sockets and the mouth an ember comes up after dark.
  totalEmissiveRadiance += faceIris * vec3( 1.0, 0.58, 0.16 ) * fk * ( 0.35 + 1.6 * uFaceNight );
  float deep = vFace.y * ( 1.0 - vFaceMisc.x ) + clamp( vFaceMisc.y * 14.0, 0.0, 1.0 ) * vFace.x;
  totalEmissiveRadiance += deep * fk * fPulse * vec3( 1.0, 0.4, 0.1 ) * ( 0.12 + 1.1 * uFaceNight );
}`;

/** The feet's material: bark map over vertex colours, and the trip's carving, darkening, motion, eyes and glow. */
export function faceGumMaterial(): THREE.MeshStandardMaterial {
  if (mat) return mat;
  const m = new THREE.MeshStandardMaterial({ map: barkTexture(), vertexColors: true, roughness: 0.93, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uFaceK = FACE_TRIP.k;
    shader.uniforms.uFacePh = FACE_TRIP.ph;
    shader.uniforms.uFaceLook = FACE_TRIP.look;
    shader.uniforms.uFaceNight = FACE_TRIP.night;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 aFace;
attribute vec4 aMorph;
attribute vec4 aEye;
attribute vec3 aNormal2;
uniform float uFaceK;
uniform float uFacePh;
uniform vec3 uFaceLook;
varying vec4 vFace;
varying vec4 vFaceEye;
varying vec2 vFaceMisc;`,
      )
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = normalize( mix( normal, aNormal2, uFaceK ) );\n#ifdef USE_TANGENT\nvec3 objectTangent = vec3( tangent.xyz );\n#endif')
      .replace('#include <begin_vertex>', FACE_VERTEX);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uFaceK;\nuniform float uFacePh;\nuniform float uFaceNight;\nvarying vec4 vFace;\nvarying vec4 vFaceEye;\nvarying vec2 vFaceMisc;')
      .replace('#include <color_fragment>', FACE_COLOUR)
      .replace('#include <roughnessmap_fragment>', FACE_WET)
      .replace('#include <emissivemap_fragment>', FACE_GLOW);
  };
  m.customProgramCacheKey = () => 'faceGum2';
  return (mat = shared(m));
}

// ---------------------------------------------------------------------------------------------------------------- shape

const TAU = Math.PI * 2;
const wrap = (a: number) => {
  let x = (a + Math.PI) % TAU;
  if (x < 0) x += TAU;
  return x - Math.PI;
};

interface Burl {
  az: number;
  y: number;
  sa: number;
  sy: number;
  amp: number;
}

/** A face's own features, a little off true. */
interface FaceShape {
  az: number;
  h: number;
  s: number;
  eyes: { x: number; y: number; rx: number; ry: number; tilt: number }[];
  mouth: { x: number; y: number; w: number; curve: number };
  nose: number;
  seed: number;
}

function faceShape(f: OldGum['faces'][number]): FaceShape {
  const j = (k: number, a: number) => (hash2(f.seed, k, 71) - 0.5) * 2 * a;
  return {
    az: f.az,
    h: f.h,
    s: f.s,
    eyes: [
      { x: -0.2 + j(1, 0.03), y: j(2, 0.035), rx: 0.095 + j(3, 0.02), ry: 0.07 + j(4, 0.02), tilt: j(5, 0.35) },
      { x: 0.2 + j(6, 0.03), y: j(7, 0.035), rx: 0.095 + j(8, 0.02), ry: 0.07 + j(9, 0.02), tilt: j(10, 0.35) },
    ],
    mouth: { x: j(11, 0.04), y: -0.47 + j(12, 0.04), w: 0.19 + j(13, 0.05), curve: j(14, 0.08) },
    nose: 0.85 + j(15, 0.25),
    seed: f.seed,
  };
}

/** What the faces of a foot do to one point of its bark, summed over them (see `faceAt`). */
interface FacePt {
  /** Displacement along the normal sober, and what the trip adds at full strength (m). */
  rest: number;
  trip: number;
  /** Shadow deep in a hole (0..0.72), the mouth's working (m), the eye socket's floor (0..1). */
  hole: number;
  mouth: number;
  eye: number;
  /** The brows' and cheeks' motion (m), the wider shading a trip brings (0..1), a blink's push (m). */
  brow: number;
  cheek: number;
  shade: number;
  lid: number;
  /** The nearest face's own 0..1 seed (its rhythm) and how near its middle is (for picking it). */
  seed: number;
  sd: number;
  /** Where this point is in its nearest eye (eye radii, across and up), how near that eye is, and its face's azimuth. */
  eu: number;
  ev: number;
  eq: number;
  az: number;
}

const newPt = (): FacePt => ({ rest: 0, trip: 0, hole: 0, mouth: 0, eye: 0, brow: 0, cheek: 0, shade: 0, lid: 0, seed: 0, sd: Infinity, eu: 0, ev: 0, eq: Infinity, az: 0 });

function clearPt(p: FacePt) {
  p.rest = p.trip = p.hole = p.mouth = p.eye = p.brow = p.cheek = p.shade = p.lid = p.seed = p.eu = p.ev = p.az = 0;
  p.eq = p.sd = Infinity;
}

/**
 * What a face does to one point of the bark. Sober it is carved, not painted: the eyes are knot holes with the bark rolled up
 * in a lip round them, the mouth a split with lips, the nose a burl; the dark is only the shadow deep in a hole. The trip
 * deepens and swells all of it (`trip`), shades it wider, and gives the brows, cheeks, mouth and eyelids room to move.
 */
function faceAt(fs: FaceShape, arcR: number, theta: number, y: number, out: FacePt) {
  const s = fs.s;
  const U = (wrap(theta - fs.az) * arcR) / s;
  const V = (y - fs.h) / s;
  if (Math.abs(U) > 0.75 || V < -0.9 || V > 0.5) return;
  const g = (x: number, yy: number, rx: number, ry: number) => Math.exp(-((x * x) / (rx * rx)) - (yy * yy) / (ry * ry));
  // A ragged edge to every feature, the way a knot or a split never has a clean outline.
  const rag = 1 + 0.4 * (noise2(U * 9 + fs.seed * 0.001, V * 9, fs.seed) - 0.5);
  // Where the bark's own grain breaks a feature up (a lip only partly rolled, a brow half there).
  const broken = smoothstep(0.25, 0.75, noise2(U * 5 - fs.seed * 0.002, V * 5, fs.seed + 3));
  let rest = 0;
  let trip = 0;
  let hole = 0;
  let eye = 0;
  let brow = 0;
  let cheek = 0;
  let shade = 0;
  let lid = 0;
  for (const e of fs.eyes) {
    const ct = Math.cos(e.tilt);
    const st = Math.sin(e.tilt);
    const dx = U - e.x;
    const dy = V - e.y;
    const ex = (dx * ct + dy * st) / (e.rx * rag);
    const ey = (-dx * st + dy * ct) / (e.ry * rag);
    const q = Math.hypot(ex, ey);
    // The hole: steep sided, its floor deep in the wood.
    const pit = 1 - smoothstep(0.55, 1.05, q);
    rest -= 0.095 * pit;
    trip -= 0.15 * pit;
    hole = Math.max(hole, smoothstep(0.25, 0.85, pit));
    eye = Math.max(eye, smoothstep(0.6, 1, pit));
    // How far the eyeball comes up into it at the peak, and a blink closes it right over (`FACE_VERTEX`).
    lid = Math.max(lid, 0.24 * pit);
    // The socket's shadow, wider than the hole, on a trip.
    shade = Math.max(shade, 1 - smoothstep(0.9, 1.7, q));
    // Where the pupil sits: this eye's own frame, without the ragged edge.
    if (q < out.eq) {
      out.eq = q;
      out.eu = (dx * ct + dy * st) / e.rx;
      out.ev = (-dx * st + dy * ct) / e.ry;
      out.az = fs.az;
    }
    // The lip of rolled bark round it.
    const lip = Math.exp(-Math.pow((q - 1.3) / 0.3, 2));
    rest += 0.02 * lip * broken;
    trip += 0.05 * lip;
    // The brow: a burl over it, that lifts and knits.
    const b = g(U - e.x * 1.05, V - e.y - 0.15, 0.16, 0.05);
    rest += 0.016 * b * (0.5 + broken);
    trip += 0.075 * b;
    brow = Math.max(brow, 0.045 * g(U - e.x * 1.05, V - e.y - 0.13, 0.2, 0.08));
    // Under the brow, in its shadow.
    shade = Math.max(shade, 0.6 * g(U - e.x, V - e.y - 0.06, 0.16, 0.06));
  }
  // The nose: a ridge down from between the eyes to a rounded burl of a tip, shadowed either side.
  const nv = clamp((V + 0.02) / -0.26, 0, 1);
  const nd = Math.hypot(U, V - (-0.02 - 0.26 * nv));
  const ridge = Math.exp(-(nd * nd) / (0.06 * 0.06)) * fs.nose;
  const tip = g(U, V + 0.29, 0.08, 0.065) * fs.nose;
  rest += 0.025 * ridge + 0.03 * tip;
  trip += 0.075 * ridge + 0.085 * tip;
  for (const sx of [-1, 1]) {
    const n = g(U - sx * 0.05, V + 0.34, 0.025, 0.02);
    rest -= 0.02 * n;
    trip -= 0.02 * n;
    hole = Math.max(hole, n * 0.5);
    shade = Math.max(shade, 0.55 * g(U - sx * 0.1, V + 0.17, 0.035, 0.13));
  }
  // The mouth: a split in the wood, flat-ended and a little curved, with the bark swollen above and below it.
  const m = fs.mouth;
  const mu = (U - m.x) / (m.w * rag);
  const mvc = V - m.y - m.curve * mu * mu;
  const along = Math.exp(-Math.pow(Math.abs(mu), 4));
  const mk = along * Math.exp(-(mvc * mvc) / (0.034 * 0.034));
  rest -= 0.06 * mk;
  trip -= 0.09 * mk;
  hole = Math.max(hole, smoothstep(0.35, 0.9, mk));
  const mouth = 0.08 * along * Math.exp(-(mvc * mvc) / (0.045 * 0.045));
  shade = Math.max(shade, 0.8 * along * Math.exp(-(mvc * mvc) / (0.08 * 0.08)));
  for (const sy of [-1, 1]) {
    const l = along * Math.exp(-Math.pow((mvc - sy * 0.07) / 0.04, 2));
    rest += 0.012 * l * broken;
    trip += 0.045 * l;
  }
  // Cheeks and the swell of the chin; the cheeks breathe.
  for (const sx of [-1, 1]) {
    const c = g(U - sx * 0.25, V + 0.26, 0.11, 0.1);
    rest += 0.015 * c;
    trip += 0.05 * c;
    cheek = Math.max(cheek, 0.028 * c);
  }
  const chin = g(U - m.x, V - m.y + 0.17, 0.16, 0.08);
  rest += 0.015 * chin;
  trip += 0.035 * chin;
  out.rest += rest * s;
  out.trip += trip * s;
  // Shadow only deep in a hole: the floor of a knot, the inside of the split.
  out.hole = Math.max(out.hole, Math.pow(hole, 1.8) * 0.72);
  out.mouth += mouth * s;
  out.eye = Math.max(out.eye, eye);
  out.brow = Math.max(out.brow, brow * s);
  out.cheek = Math.max(out.cheek, cheek * s);
  out.shade = Math.max(out.shade, clamp(shade, 0, 1));
  out.lid = Math.max(out.lid, lid * s);
  // The face this point belongs to, for its rhythm: the one whose middle is nearest.
  const near = Math.hypot(U, V + 0.2);
  if (near < out.sd) {
    out.sd = near;
    out.seed = ((fs.seed % 997) + 1) / 998;
  }
}

const C_DARK = new THREE.Color(0x4e3324);
const C_RED = new THREE.Color(0x7a4a2e);
const C_PALE = new THREE.Color(0xc9c2b2);
const C_PINK = new THREE.Color(0xc89a76);
const C_CHAR = new THREE.Color(0x1d1612);
const C_ROT = new THREE.Color(0x3a281b);
const C_ROT2 = new THREE.Color(0x7a4c2c);
const _c = new THREE.Color();
const _d = new THREE.Color();

/** One foot's geometry. `fine` adds the dense rings and columns round its faces (and its split). */
export function gumFootGeometry(g: OldGum, fine: boolean): THREE.BufferGeometry {
  const r = g.r;
  const seed = g.seed;
  const faces = g.faces.map(faceShape);
  const axis = g.stems.length > 1 ? g.stems[0].dir : (seed % 628) / 100;
  const nb = 4 + (seed % 3);
  const butt: { az: number; a: number }[] = [];
  for (let k = 0; k < nb; k++) butt.push({ az: (k / nb) * TAU + (hash2(seed, k, 3) - 0.5) * 0.9, a: r * (0.3 + hash2(seed, k, 4) * 0.45) });
  const burls: Burl[] = [];
  const nBurl = g.form === 'burl' ? 8 : 4;
  for (let k = 0; k < nBurl; k++) {
    let az = hash2(seed, k, 5) * TAU;
    // Keep the big lumps off the faces themselves (they are the face's cheeks and brows).
    for (const f of faces) if (Math.abs(wrap(az - f.az)) < 0.5) az += 1.1;
    burls.push({ az, y: 0.4 + hash2(seed, k, 6) * (g.top - 0.6), sa: 0.25 + hash2(seed, k, 7) * 0.3, sy: 0.25 + hash2(seed, k, 8) * 0.35, amp: r * (0.07 + hash2(seed, k, 9) * (g.form === 'burl' ? 0.16 : 0.1)) });
  }
  const top = g.top;
  const fork = g.form === 'fork';
  // The stem a few metres up its trunk (see `trees.ts`): the old red gum (variant 0) is a third thicker, the V's bole broad.
  const stemR = (s: number) => TREE_DIMS.eucalyptus.trunk * s * (fork ? 1.25 : 1.16 * 1.3);
  const sr = Math.max(...g.stems.map((s) => stemR(s.s)));
  /** The radius of the foot without faces or the split: a fork's stays broad to its crotch, one stem's tapers into it. */
  const radius = (th: number, y: number) => {
    const yy = Math.max(0, y);
    const up = clamp((yy - 1) / Math.max(0.5, top - 1), 0, 1);
    let base = yy < 1 ? r * (1.3 - 0.28 * smoothstep(0, 1, yy)) : fork ? r * (1.02 - 0.2 * up) : r * 1.02 + (sr + 0.2 - r * 1.02) * up * up * (3 - 2 * up);
    if (y < 0) base = r * 1.3;
    const ell = g.form === 'fork' ? 1 + 0.16 * Math.cos(2 * (th - axis)) : 1 + 0.06 * Math.cos(2 * (th - axis));
    let R = base * ell;
    for (const b of butt) R += b.a * Math.pow(Math.max(0, Math.cos(th - b.az)), 16) * Math.exp(-yy / 0.32);
    const c = Math.cos(th);
    const s = Math.sin(th);
    R += (noise2(c * 1.5 + y * 0.8 + seed * 0.001, s * 1.5 - y * 0.6, seed) - 0.5) * 0.3 * r;
    R += (noise2(c * 4 + y * 2.4, s * 4 - y * 2.1, seed + 1) - 0.5) * 0.1 * r;
    for (const b of burls) {
      const da = wrap(th - b.az) / b.sa;
      const dy = (y - b.y) / b.sy;
      R += b.amp * Math.exp(-da * da - dy * dy);
    }
    return R;
  };
  // Where the samples go: round the foot, denser across each face and the split; up it, denser through each face.
  const ths: number[] = [];
  const n0 = fine ? 44 : 22;
  for (let k = 0; k < n0; k++) ths.push((k / n0) * TAU);
  const ys: number[] = [];
  const yStep = fine ? 0.14 : 0.3;
  for (let y = -0.45; y < top; y += y < 0.6 ? (fine ? 0.1 : 0.25) : yStep) ys.push(y);
  if (fine) {
    for (const f of faces) {
      const arcR = radius(f.az, f.h);
      const aw = (0.62 * f.s) / arcR;
      for (let a = -aw; a <= aw; a += (0.028 * f.s) / arcR) ths.push((f.az + a + TAU * 4) % TAU);
      for (let y = f.h - 0.85 * f.s; y <= f.h + 0.4 * f.s; y += 0.028 * f.s) if (y > -0.3 && y < top - 0.05) ys.push(y);
    }
    if (g.cav) for (let a = -0.6; a <= 0.6; a += 0.05) ths.push((g.cav.az + a + TAU * 4) % TAU);
  }
  ys.push(top);
  ths.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  const TH = ths.filter((a, i) => i === 0 || a - ths[i - 1] > 0.004);
  const YS = ys.filter((a, i) => i === 0 || a - ys[i - 1] > 0.012);
  const nT = TH.length;
  // The cap: the top closes in to the stems that rise out of it, an ellipse round a fork's pair (lower between them), a
  // circle round a single stem.
  const capRings = [0.35, 0.7, 1];
  // Where the stem rises out of it (the V forks a little higher, inside its own bole).
  const capEnd = () => sr + 0.28;
  const nRing = YS.length + capRings.length;
  const pos: number[] = [];
  const pos2: number[] = [];
  const col: number[] = [];
  const uv: number[] = [];
  const face: number[] = [];
  const morph: number[] = [];
  const eyes: number[] = [];
  const fp = newPt();
  // Each face's arc radius, once (it is the same for every point of it).
  const arcR = faces.map((f) => radius(f.az, f.h));
  const uRep = Math.max(2, Math.round((TAU * r) / 1.3));
  for (let j = 0; j < nRing; j++) {
    const cap = j >= YS.length ? 0 : 1;
    for (let i = 0; i <= nT; i++) {
      const th = i < nT ? TH[i] : TH[0] + TAU;
      let y: number;
      let R: number;
      if (cap < 1) {
        const t = capRings[j - YS.length];
        y = top + 0.6 * t;
        const R0 = radius(th, top);
        R = R0 + (capEnd() - R0) * Math.sqrt(t);
      } else {
        y = YS[j];
        R = radius(th, y);
      }
      // The split down a hollow one: a deep lens of rotten heartwood, its lips rolled outward.
      let rot = 0;
      if (g.cav && cap === 1) {
        const da = Math.abs(wrap(th - g.cav.az));
        const span = clamp((y - g.cav.h0) / (g.cav.h1 - g.cav.h0), 0, 1);
        const lens = Math.sin(Math.PI * span);
        const w = 0.42 * lens + 0.05;
        if (lens > 0 && da < w) {
          const k = Math.pow(Math.cos((da / w) * (Math.PI / 2)), 1.2) * lens;
          R -= r * 0.62 * k;
          rot = smoothstep(0.02, 0.25, k) + smoothstep(0.45, 0.8, k);
        } else if (lens > 0 && da < w + 0.25) {
          R += r * 0.1 * Math.sin(((da - w) / 0.25) * Math.PI) * lens;
          rot = -lens;
        }
      }
      clearPt(fp);
      if (cap === 1) faces.forEach((f, k) => faceAt(f, arcR[k], th, y, fp));
      const c = Math.cos(th);
      const s = Math.sin(th);
      const R0 = R + fp.rest;
      pos.push(c * R0, y, s * R0);
      pos2.push(c * (R0 + fp.trip), y, s * (R0 + fp.trip));
      // Bark: dark, red-brown and rough below, pale smooth patches spreading up toward the stems, black where fire
      // took it, the rotten heartwood in a split.
      const n = noise2(c * 2.2 + y * 0.55, s * 2.2 - y * 0.75, seed + 5);
      const n2 = noise2(c * 6 + y * 1.6, s * 6 - y * 1.9, seed + 6);
      _c.copy(C_DARK).lerp(C_RED, n2);
      // Toward the top the old bark gives way to the stems' own: pale and smooth.
      const pale = smoothstep(0.3, 0.8, n + smoothstep(1.2, top + 0.6, y) * 0.6 - 0.38 + smoothstep(top - 0.9, top + 0.5, y) * 0.9);
      if (pale > 0) _c.lerp(_d.copy(C_PALE).lerp(C_PINK, smoothstep(0.4, 0.8, n2)), pale * 0.85);
      const burn = Math.exp(-Math.pow(wrap(th - g.burn.az) / 0.75, 2)) * (1 - smoothstep(g.burn.h * 0.6, g.burn.h + 0.3, y + (n2 - 0.5) * 0.6));
      if (burn > 0.05) _c.lerp(C_CHAR, smoothstep(0.2, 0.6, burn));
      // The split: its lips the fresh pinkish bark rolled over the wound, inside it orange heartwood going black deep in.
      if (rot < 0) _c.lerp(C_PINK, Math.min(1, -rot) * 0.8);
      else if (rot > 0) _c.copy(C_ROT2).lerp(C_ROT, clamp(rot - 1, 0, 1) * 0.85).multiplyScalar(0.85 + 0.3 * n2);
      if (y < 0.15) _c.multiplyScalar(0.72 + 0.28 * smoothstep(-0.3, 0.15, y));
      col.push(_c.r, _c.g, _c.b);
      uv.push((th / TAU) * uRep, y / 1.6);
      // The plain mesh far off keeps the carving but not the moving parts: its points are too far apart for eyes.
      face.push(fp.trip, fp.hole, fp.mouth, fine ? fp.eye : 0);
      morph.push(fine ? fp.brow : 0, fine ? fp.cheek : 0, fp.shade, fp.seed);
      // Eye coordinates only in and round a socket, far out (9) elsewhere: between the two eyes the nearest one flips, and
      // a triangle across the flip would otherwise blend through 0 and draw an eye on the bridge of the nose.
      eyes.push(fine && fp.eq < 1.25 ? fp.eu : 9, fine && fp.eq < 1.25 ? fp.ev : 9, fp.az, fine ? fp.lid : 0);
    }
  }
  const idx: number[] = [];
  const row = nT + 1;
  for (let j = 0; j + 1 < nRing; j++) {
    for (let i = 0; i < nT; i++) {
      const a = j * row + i;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  // The very top: a fan to one point where the stems rise out of it.
  const centre = pos.length / 3;
  const ty = top + 0.7;
  pos.push(0, ty, 0);
  pos2.push(0, ty, 0);
  col.push(C_RED.r * 0.8, C_RED.g * 0.8, C_RED.b * 0.8);
  uv.push(0, ty / 1.6);
  face.push(0, 0, 0, 0);
  morph.push(0, 0, 0, 0);
  eyes.push(9, 9, 0, 0);
  const last = (nRing - 1) * row;
  for (let i = 0; i < nT; i++) idx.push(last + i, centre, last + i + 1);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos2, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const n2 = (geo.getAttribute('normal') as THREE.BufferAttribute).array.slice();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  geo.setAttribute('aNormal2', new THREE.Float32BufferAttribute(n2, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('aFace', new THREE.Float32BufferAttribute(face, 4));
  geo.setAttribute('aMorph', new THREE.Float32BufferAttribute(morph, 4));
  geo.setAttribute('aEye', new THREE.Float32BufferAttribute(eyes, 4));
  geo.computeBoundingSphere();
  // Room for the trip's swelling and the blinks, so a foot is never culled while it still shows.
  geo.boundingSphere!.radius += 0.3;
  return geo;
}

/** The stumps of one bend, merged: flared sides of bark, a cut top of pale rings, a charred hollow in the burnt ones. */
export function stumpGeometry(stumps: Stump[], ox: number, oz: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const N = 18;
  const ringC = new THREE.Color(0xb48a5c);
  const ringD = new THREE.Color(0x8a6440);
  for (const st of stumps) {
    const base = pos.length / 3;
    const levels: [number, number][] = [
      [-0.35, 1.35],
      [0, 1.3],
      [st.h * 0.35, 1.08],
      [st.h, 1.0],
      [st.h + 0.01, 0.92],
      [st.h - (st.burnt ? 0.05 : 0), 0.62],
      [st.h - (st.burnt ? 0.22 : -0.01), 0.3],
      [st.h - (st.burnt ? 0.3 : -0.02), 0.0],
    ];
    levels.forEach(([y, k], j) => {
      for (let i = 0; i <= N; i++) {
        const th = (i / N) * TAU;
        const lump = 1 + (noise2(Math.cos(th) * 2 + j * 0.1, Math.sin(th) * 2, st.seed) - 0.5) * 0.25;
        const R = st.r * k * (j < 4 ? lump : 1);
        pos.push(st.x - ox + Math.cos(th) * R, st.y + y, st.z - oz + Math.sin(th) * R);
        if (j < 4) {
          _c.copy(C_DARK).lerp(C_RED, noise2(Math.cos(th) * 3 + y, Math.sin(th) * 3, st.seed + 1));
          if (st.burnt && y > st.h * 0.4) _c.lerp(C_CHAR, 0.6);
        } else if (st.burnt && j >= 5) _c.copy(C_CHAR);
        else _c.copy(j % 2 ? ringC : ringD);
        col.push(_c.r, _c.g, _c.b);
        uv.push((i / N) * 3, y / 1.6);
      }
    });
    for (let j = 0; j + 1 < levels.length; j++) {
      for (let i = 0; i < N; i++) {
        const a = base + j * (N + 1) + i;
        const b = a + 1;
        const c = a + N + 1;
        const d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.setAttribute('aNormal2', (geo.getAttribute('normal') as THREE.BufferAttribute).clone());
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('aFace', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 4), 4));
  geo.setAttribute('aMorph', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 4), 4));
  const noEye = new Float32Array((pos.length / 3) * 4);
  for (let i = 0; i < noEye.length; i += 4) noEye[i] = noEye[i + 1] = 9;
  geo.setAttribute('aEye', new THREE.Float32BufferAttribute(noEye, 4));
  geo.computeBoundingSphere();
  return geo;
}

let litterMat: THREE.MeshStandardMaterial | null = null;
let litterGeo: THREE.BufferGeometry | null = null;

/** Fallen gum leaves: a flat card of the atlas's eucalyptus spray, browned. */
function litterParts(): { geo: THREE.BufferGeometry; mat: THREE.MeshStandardMaterial } {
  if (!litterGeo) {
    const g = new THREE.PlaneGeometry(1, 1);
    g.rotateX(-Math.PI / 2);
    const { cols, cell, w, h } = LEAF_ATLAS;
    const ci = LEAF_CELL.gum;
    const u0 = ((ci % cols) * cell + 3) / w;
    const u1 = ((ci % cols + 1) * cell - 3) / w;
    const v0 = (Math.floor(ci / cols) * cell + 3) / h;
    const v1 = ((Math.floor(ci / cols) + 1) * cell - 3) / h;
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
    litterGeo = shared(g);
  }
  if (!litterMat) {
    litterMat = shared(
      new THREE.MeshStandardMaterial({ map: leafAtlas().tex, alphaTest: 0.5, side: THREE.DoubleSide, color: 0xffffff, roughness: 0.95, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    );
  }
  return { geo: litterGeo, mat: litterMat };
}

const LITTER = [0x8a5e3a, 0xa0703f, 0x9a8a70, 0x6e5a44, 0xb27a46, 0x7f7a62].map((c) => new THREE.Color(c));

/** Every bend's old gums' feet and stumps, ready to add to the scene. */
export class FaceGums {
  readonly group = new THREE.Group();
  private geos: THREE.BufferGeometry[] = [];

  constructor(bends: Bend[], ground?: (x: number, z: number) => number) {
    this.group.name = 'faceGums';
    const m = faceGumMaterial();
    for (const b of bends) {
      for (const g of b.gums) {
        const lod = new THREE.LOD();
        lod.position.set(g.x, g.y, g.z);
        const fine = gumFootGeometry(g, true);
        const coarse = gumFootGeometry(g, false);
        this.geos.push(fine, coarse);
        for (const [geo, at] of [[fine, 0], [coarse, FINE_TO]] as const) {
          const mesh = new THREE.Mesh(geo, m);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          lod.addLevel(mesh, at);
        }
        lod.addLevel(new THREE.Object3D(), HIDE_AT);
        lod.userData.gum = g.id;
        this.group.add(lod);
      }
      // Their fallen leaves on the bare earth round their feet.
      if (ground) {
        const spots: { x: number; z: number; s: number; a: number }[] = [];
        for (const g of b.gums) {
          const rr = g.r * 1.35 + 1.6;
          const n = Math.round(rr * rr * (g.island ? 8 : 16));
          for (let k = 0; k < n; k++) {
            const a = hash2(g.seed, k, 41) * TAU;
            const d = g.r * 1.05 + Math.sqrt(hash2(g.seed, k, 42)) * (rr - g.r * 1.05);
            spots.push({ x: g.x + Math.cos(a) * d, z: g.z + Math.sin(a) * d, s: 0.2 + hash2(g.seed, k, 43) * 0.22, a: hash2(g.seed, k, 44) * TAU });
          }
        }
        // And over the landing's mud, thinner, blown down from the gums on the bank.
        const L = b.loop.landing;
        if (L) {
          for (let k = 0; k < 120; k++) {
            const u = (hash2(k, 3, 47) - 0.5) * 2 * (L.w + 2);
            const v = hash2(k, 4, 47) * 9 - 0.5;
            spots.push({ x: L.x + L.nx * v - L.nz * u, z: L.z + L.nz * v + L.nx * u, s: 0.18 + hash2(k, 5, 47) * 0.2, a: hash2(k, 6, 47) * TAU });
          }
        }
        const { geo, mat: lm } = litterParts();
        const im = new THREE.InstancedMesh(geo, lm, spots.length);
        const m4 = new THREE.Matrix4();
        const q = new THREE.Quaternion();
        const e = new THREE.Euler();
        const v = new THREE.Vector3();
        const sc = new THREE.Vector3();
        spots.forEach((sp, i) => {
          e.set((hash2(i, 7, 45) - 0.5) * 0.12, sp.a, (hash2(i, 7, 46) - 0.5) * 0.12, 'YXZ');
          q.setFromEuler(e);
          v.set(sp.x - b.loop.x, ground(sp.x, sp.z) + 0.035, sp.z - b.loop.z);
          sc.set(sp.s, 1, sp.s * 1.3);
          im.setMatrixAt(i, m4.compose(v, q, sc));
          im.setColorAt(i, LITTER[i % LITTER.length]);
        });
        im.position.set(b.loop.x, 0, b.loop.z);
        im.receiveShadow = true;
        im.frustumCulled = false;
        this.group.add(im);
      }
      if (b.stumps.length) {
        const geo = stumpGeometry(b.stumps, b.loop.x, b.loop.z);
        this.geos.push(geo);
        const mesh = new THREE.Mesh(geo, m);
        mesh.position.set(b.loop.x, 0, b.loop.z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.group.add(mesh);
      }
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose();
    this.geos.length = 0;
    this.group.clear();
  }
}
