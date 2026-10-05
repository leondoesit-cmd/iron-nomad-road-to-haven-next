import * as THREE from 'three';
import { MeshBuilder, S } from './builder';
import { GLOBALS, kitMaterial } from './materials';
import { bushTexture, fernTexture, flowerTexture, grassTexture, lilyTexture, reedTexture } from './proctex';
import { shared } from './dispose';
import { wetGround } from './groundMix';
import { hash2, noise2 } from '../core/rng';
import { CELL, CELLS, CHUNK, corridorHalf, heightAt, normalAt, roadX, surfaceAt, type TerrainDef } from '../world/terrain';
import { cityChunk, nearestRoad } from '../world/openWorld';
import { forestAt, lushAt, nearHydro, swampQ } from '../world/hydro';
import type { Aabb, PropSpawn } from '../world/layout';

/**
 * Ground cover: instanced dry grass cards, shrubs and pebble clusters, placed deterministically per chunk.
 * Grass sways in a shared wind and shrinks away with distance, so density costs nothing far from the camera.
 * In the green country (`lushAt`) the grass turns green and grows thick and tall, wildflowers stand in the meadows, ferns
 * under the woods (`forestAt`), reeds and cattails at the water's edge and lily pads on the swamps.
 */

// ---------------------------------------------------------------------------------------- geometry

/** Crossed vertical cards. `dome` gives normals that bulge outward (bushes); otherwise they point up (grass). */
function cardGeometry(cards: number, W: number, H: number, dome: boolean): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  for (let k = 0; k < cards; k++) {
    const a = (k / cards) * Math.PI;
    const cx = Math.cos(a) * W * 0.5;
    const cz = Math.sin(a) * W * 0.5;
    const base = pos.length / 3;
    pos.push(-cx, 0, -cz, cx, 0, cz, cx, H, cz, -cx, H, -cz);
    // Sprite textures are DataTextures (no flipY) with the plant base on the last row, so v runs top-down.
    uv.push(0, 1, 1, 1, 1, 0, 0, 0);
    for (let i = 0; i < 4; i++) {
      const vx = pos[(base + i) * 3];
      const vy = pos[(base + i) * 3 + 1];
      const vz = pos[(base + i) * 3 + 2];
      if (dome) {
        const n = new THREE.Vector3(vx, (vy - H * 0.25) * 1.2 + H * 0.35, vz).normalize();
        nor.push(n.x, n.y, n.z);
      } else nor.push(0, 1, 0);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return shared(g);
}

let grassGeo: THREE.BufferGeometry | null = null;
const grassGeometry = () => (grassGeo ??= cardGeometry(3, 1.0, 0.62, false));
let bushGeo: THREE.BufferGeometry | null = null;
const bushGeometry = () => (bushGeo ??= cardGeometry(4, 1.5, 1.15, true));
let flowerGeo: THREE.BufferGeometry | null = null;
const flowerGeometry = () => (flowerGeo ??= cardGeometry(2, 0.7, 0.55, false));
let fernGeo: THREE.BufferGeometry | null = null;
const fernGeometry = () => (fernGeo ??= cardGeometry(3, 1.5, 0.95, true));
let reedGeo: THREE.BufferGeometry | null = null;
const reedGeometry = () => (reedGeo ??= cardGeometry(3, 1.1, 1.9, false));
let padGeo: THREE.BufferGeometry | null = null;
/** A level card lying on the water, 1.8 m across, its picture seen from above. */
function padGeometry(): THREE.BufferGeometry {
  if (padGeo) return padGeo;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.9, 0, -0.9, 0.9, 0, -0.9, 0.9, 0, 0.9, -0.9, 0, 0.9], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 2, 1, 0, 3, 2]);
  return (padGeo = shared(g));
}

/** Displace a builder's vertices with smooth noise (used for rocks). */
function lumpy(b: MeshBuilder, amp: number, freq: number, seed: number) {
  for (let i = 0; i < b.pos.length; i += 3) {
    const x = b.pos[i];
    const y = b.pos[i + 1];
    const z = b.pos[i + 2];
    const n = noise2(x * freq + y * 0.7 + 11, z * freq - y * 0.5, seed) - 0.5;
    const n2 = noise2(x * freq * 2.7 - y, z * freq * 2.7 + y * 1.3, seed + 1) - 0.5;
    const nx = b.nor[i];
    const ny = b.nor[i + 1];
    const nz = b.nor[i + 2];
    const k = n * amp + n2 * amp * 0.35;
    b.pos[i] += nx * k;
    b.pos[i + 1] += ny * k;
    b.pos[i + 2] += nz * k;
  }
}

/** Rebuild smooth normals for a builder after displacement (indexed, so shared vertices only). */
function renormal(g: THREE.BufferGeometry) {
  g.computeVertexNormals();
  return g;
}

const rockGeos: THREE.BufferGeometry[] = [];
function pebbleGeometry(v: number): THREE.BufferGeometry {
  if (rockGeos[v]) return rockGeos[v];
  const b = new MeshBuilder();
  b.seed(17 + v);
  b.jitter = 0.08;
  const base = [0x8f7a66, 0x7a6a5c, 0x9c8a74][v % 3];
  const n = v === 2 ? 1 : 3;
  for (let i = 0; i < n; i++) {
    const a = i * 2.3 + v;
    const r = v === 2 ? 0.55 : 0.12 + (i % 2) * 0.1;
    b.add('ico1', Math.cos(a) * (i ? 0.35 : 0), r * 0.35, Math.sin(a) * (i ? 0.3 : 0), r * 2, r * 1.3, r * 1.7, S.rock(base), 0, a, 0);
  }
  lumpy(b, v === 2 ? 0.35 : 0.08, v === 2 ? 2.2 : 7, 40 + v);
  rockGeos[v] = shared(b.build());
  return rockGeos[v];
}

/** Big weathered boulders for the cliff feet: flattened, split along bedding planes. */
const boulderGeos: THREE.BufferGeometry[] = [];
function boulderGeometry(v: number): THREE.BufferGeometry {
  if (boulderGeos[v]) return boulderGeos[v];
  const b = new MeshBuilder();
  b.seed(61 + v);
  b.jitter = 0.06;
  const tones = [0x9a6a4e, 0x8c5e44, 0xa77c5c];
  b.add('ico2', 0, 0.35, 0, 1.0, 0.62, 0.85, S.rock(tones[v % 3]), 0, v * 1.3, 0);
  if (v !== 1) b.add('ico2', 0.38, 0.62, -0.1, 0.62, 0.45, 0.55, S.rock(tones[(v + 1) % 3]), 0.1, v, 0.15);
  lumpy(b, 0.16, 2.6, 70 + v);
  // Bedding planes: flatten the tops into ledges.
  for (let i = 1; i < b.pos.length; i += 3) {
    const y = b.pos[i];
    const step = 0.17;
    const t = y / step;
    b.pos[i] = (Math.floor(t) + Math.min(1, (t - Math.floor(t)) * 1.6)) * step;
  }
  boulderGeos[v] = shared(renormal(b.build()));
  return boulderGeos[v];
}

// ---------------------------------------------------------------------------------------- materials

/** The wind every swaying plant shares (the trees too): x and z its direction and strength, w a master scale. */
export const WIND = {
  uWind: { value: new THREE.Vector4(0.8, 0.0, 0.6, 1.0) },
};

type CardKind = 'grass' | 'bush' | 'flower' | 'fern' | 'reed' | 'pad';

/** Per kind: texture, alpha cut, fade-out range (m), sway, and whether normals point up (a mat) or bulge out (a clump). */
const CARD: Record<CardKind, { tex: () => THREE.Texture; cut: number; fade: [number, number]; sway: number; up: boolean }> = {
  grass: { tex: grassTexture, cut: 0.42, fade: [55, 85], sway: 0.55, up: true },
  bush: { tex: bushTexture, cut: 0.38, fade: [120, 170], sway: 0.12, up: false },
  flower: { tex: flowerTexture, cut: 0.42, fade: [50, 80], sway: 0.6, up: true },
  fern: { tex: fernTexture, cut: 0.4, fade: [95, 140], sway: 0.18, up: false },
  reed: { tex: reedTexture, cut: 0.4, fade: [140, 185], sway: 0.07, up: true },
  pad: { tex: lilyTexture, cut: 0.45, fade: [150, 190], sway: 0, up: true },
};

/**
 * Flowers take their petal colour from the instance: the texture marks stems (R brightness), petals (G) and hearts (B), so
 * one card gives every colour of the meadow and the stems stay green.
 */
const FLOWER_MAP = /* glsl */ `
#ifdef USE_MAP
  vec4 fT = texture2D( map, vMapUv );
  diffuseColor.a *= fT.a;
  vec3 fStem = vec3( 0.12, 0.22, 0.05 ) * ( 0.6 + fT.r * 0.6 );
  vec3 fPetal = vColor.rgb * ( 0.55 + fT.r * 0.5 );
  vec3 fHeart = vec3( 0.75, 0.48, 0.05 ) * fT.r;
  diffuseColor.rgb = mix( mix( fStem, fPetal, fT.g ), fHeart, fT.b );
#endif
`;

const cardMats = new Map<string, THREE.MeshStandardMaterial>();

/** Alpha-tested foliage card material: wind sway, distance shrink, and normals that ignore the face side. */
function cardMaterial(kind: CardKind): THREE.MeshStandardMaterial {
  const hit = cardMats.get(kind);
  if (hit) return hit;
  const k = CARD[kind];
  const m = new THREE.MeshStandardMaterial({ map: k.tex(), alphaTest: k.cut, side: THREE.DoubleSide, roughness: 0.95, metalness: 0 });
  // Pads float on swamp water: drawn a hair above it.
  if (kind === 'pad') {
    m.polygonOffset = true;
    m.polygonOffsetFactor = -2;
    m.polygonOffsetUnits = -2;
    m.roughness = 0.6;
  }
  const fade = new THREE.Vector2(k.fade[0], k.fade[1]);
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = GLOBALS.uTime;
    shader.uniforms.uWind = WIND.uWind;
    shader.uniforms.uFade = { value: fade };
    shader.uniforms.uSway = { value: k.sway };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform vec4 uWind;\nuniform vec2 uFade;\nuniform float uSway;')
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
#ifdef USE_INSTANCING
  vec3 gO = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
  mat3 gR = mat3( instanceMatrix );
#else
  vec3 gO = ( modelMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
  mat3 gR = mat3( 1.0 );
#endif
  float gD = distance( gO, cameraPosition );
  float gKeep = 1.0 - smoothstep( uFade.x, uFade.y, gD );
  float gH = transformed.y;
  float gS = sin( uTime * 1.6 + gO.x * 0.21 + gO.z * 0.17 ) * 0.6 + sin( uTime * 3.7 + gO.x * 0.9 - gO.z * 0.6 ) * 0.25;
  vec3 gWind = transpose( gR ) * vec3( uWind.x, 0.0, uWind.z );
  transformed += gWind * gS * gH * gH * uSway * uWind.w;
  transformed *= gKeep;`,
      );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_begin>',
      k.up ? '#include <normal_fragment_begin>\nnormal = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );' : '#include <normal_fragment_begin>\nnormal = normalize( vNormal );',
    );
    if (kind === 'flower') shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', FLOWER_MAP).replace('#include <color_fragment>', '');
  };
  m.customProgramCacheKey = () => `card:${kind}`;
  cardMats.set(kind, shared(m));
  return m;
}

export const grassMaterial = () => cardMaterial('grass');

// ---------------------------------------------------------------------------------------- placement

export interface ScatterSet {
  grass: THREE.InstancedMesh | null;
  shrubs: THREE.InstancedMesh | null;
  pebbles: THREE.InstancedMesh[];
  boulders: THREE.InstancedMesh[];
  /** The green country: wildflowers in the meadows, ferns under the woods, reeds at the water's edge, pads on the swamps. */
  flowers: THREE.InstancedMesh | null;
  ferns: THREE.InstancedMesh | null;
  reeds: THREE.InstancedMesh | null;
  pads: THREE.InstancedMesh | null;
}

export interface Spot {
  x: number;
  y: number;
  z: number;
  yaw: number;
  s: number;
  tilt: [number, number];
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _col = new THREE.Color();

function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, spots: Spot[], tint?: (i: number, s: Spot) => THREE.Color): THREE.InstancedMesh | null {
  if (!spots.length) return null;
  const im = new THREE.InstancedMesh(geo, mat, spots.length);
  spots.forEach((s, i) => {
    _p.set(s.x, s.y, s.z);
    _e.set(s.tilt[0], s.yaw, s.tilt[1], 'YXZ');
    _q.setFromEuler(_e);
    _s.set(s.s, s.s, s.s);
    _m.compose(_p, _q, _s);
    im.setMatrixAt(i, _m);
    if (tint) im.setColorAt(i, tint(i, s));
  });
  im.instanceMatrix.needsUpdate = true;
  if (im.instanceColor) im.instanceColor.needsUpdate = true;
  im.computeBoundingSphere();
  return im;
}

function blockedBy(aabbs: Aabb[], props: PropSpawn[], x: number, z: number, r: number) {
  for (const a of aabbs) if (x > a.minX - r && x < a.maxX + r && z > a.minZ - r && z < a.maxZ + r) return true;
  for (const p of props) {
    const pr = p.kind === 'rock' ? 1.6 * p.scale : p.kind === 'wreck' ? 2.6 : p.kind === 'pole' || p.kind === 'sign' ? 0.5 : 1.0;
    if ((p.x - x) ** 2 + (p.z - z) ** 2 < (pr + r) ** 2) return true;
  }
  return false;
}

/**
 * Ground cover for one chunk. `density` scales every layer (quality setting). Purely visual: nothing here
 * has a collider, and nothing is placed on the road, in a building or on another prop. `heights` is the chunk's own
 * heightfield (as `ChunkData.heights`): given it, things stand on the drawn ground and cost far less to place.
 */
export function buildScatter(def: TerrainDef, cx: number, cz: number, aabbs: Aabb[], props: PropSpawn[], density: number, extraBlock?: (x: number, z: number) => boolean, heights?: Float32Array): ScatterSet {
  const g = buildScatterSteps(def, cx, cz, aabbs, props, density, extraBlock, heights);
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

/** Wildflower colours: poppy, mustard, daisy, lupin, cyclamen pink, cornflower. */
const FLOWER_COLS: [number, number, number][] = [
  [0.9, 0.06, 0.04],
  [0.95, 0.68, 0.06],
  [0.92, 0.92, 0.86],
  [0.42, 0.22, 0.72],
  [0.95, 0.38, 0.55],
  [0.25, 0.38, 0.95],
];

/** `buildScatter` in slices: it yields between phases and every few rows, so a streaming chunk can spread it over several ticks. */
export function* buildScatterSteps(def: TerrainDef, cx: number, cz: number, aabbs: Aabb[], props: PropSpawn[], density: number, extraBlock?: (x: number, z: number) => boolean, heights?: Float32Array): Generator<void, ScatterSet> {
  const city = def.biome === 'city' || cityChunk(def.open, cx, cz);
  const x0 = cx * CHUNK;
  const z0 = cz * CHUNK;
  const seed = def.seed * 7 + 3;
  const grass: Spot[] = [];
  const shrubs: Spot[] = [];
  const pebbles: Spot[][] = [[], [], []];
  const nrm: [number, number, number] = [0, 1, 0];
  const out = { x: 0, z: 0 };
  const jitter = (gx: number, gz: number, step: number, salt: number) => {
    out.x = x0 + (gx + 0.15 + hash2(gx + cx * 977, gz + cz * 613, seed + salt) * 0.7) * step;
    out.z = z0 + (gz + 0.15 + hash2(gx + cx * 977, gz + cz * 613, seed + salt + 1) * 0.7) * step;
    return out;
  };
  const roadClear = (x: number, z: number, margin: number) => {
    if (def.open && !city) {
      const hit = nearestRoad(def.open, x, z);
      return hit.edge > margin;
    }
    const half = city ? 10.2 : def.roadHalf;
    return Math.abs(x - roadX(def, z)) > half + margin;
  };
  const inCorridor = (x: number, z: number) => Math.abs(x - roadX(def, z)) < corridorHalf(def, z) + (city ? -2 : 4);
  // The ground's height: the chunk's heightfield, split into triangles as it is drawn, or the terrain function.
  const N1 = CELLS + 1;
  const H = (x: number, z: number) => {
    if (!heights) return heightAt(def, x, z);
    const fc = Math.min(CELLS - 1e-4, Math.max(0, (x - x0) / CELL));
    const fr = Math.min(CELLS - 1e-4, Math.max(0, (z - z0) / CELL));
    const c = Math.floor(fc);
    const r = Math.floor(fr);
    const tx = fc - c;
    const tz = fr - r;
    const a = heights[c * N1 + r];
    const b = heights[(c + 1) * N1 + r];
    const d = heights[c * N1 + r + 1];
    const e = heights[(c + 1) * N1 + r + 1];
    return tx > tz ? a + (b - a) * tx + (e - b) * tz : a + (e - d) * tx + (d - a) * tz;
  };
  // How green this chunk is, coarsely, so the green layers can skip a desert chunk outright.
  const green = !city && !!def.hydro?.lush;
  let maxL = 0;
  let maxF = 0;
  if (green) {
    for (let i = 0; i <= 4; i++) {
      for (let j = 0; j <= 4; j++) {
        maxL = Math.max(maxL, lushAt(def, x0 + i * 32, z0 + j * 32));
        maxF = Math.max(maxF, forestAt(def, x0 + i * 32, z0 + j * 32));
      }
    }
  }
  const lush = (x: number, z: number) => (maxL > 0 ? lushAt(def, x, z) : 0);
  const forest = (x: number, z: number) => (maxF > 0 ? forestAt(def, x, z) : 0);
  // Grass: clumpy, thinned on sand, absent on rock, gravel shoulders and in the city's open asphalt. Lush land grows it
  // thick and tall (a second, offset grid fills the meadows in), thinning again in the shade of the woods.
  const gStep = city ? 3.2 : 2.0;
  const gn = Math.floor(CHUNK / gStep);
  for (let pass = 0; pass < (maxL > 0.45 ? 2 : 1); pass++) {
    for (let gz = 0; gz < gn; gz++) {
      if (gz % 8 === 7) yield;
      for (let gx = 0; gx < gn; gx++) {
        const p = jitter(gx + pass * 0.5, gz + pass * 0.5, gStep, pass ? 211 : 11);
        const x = p.x;
        const z = p.z;
        const L = lush(x, z);
        const F = L > 0.42 ? forest(x, z) : 0;
        const clump = noise2(x / 19 + 7, z / 19 - 3, seed + 5);
        let prob = city ? 0 : smoothstep(0.3, 0.72, clump) * 0.85;
        if (city) {
          // Weeds hug walls and kerbs.
          const d = Math.abs(x - roadX(def, z));
          prob = (d > 9.4 && d < 10.6 ? 0.55 : 0) + smoothstep(0.7, 0.9, clump) * 0.25;
        } else if (L > 0) {
          const meadow = pass ? smoothstep(0.45, 0.8, L) * 0.85 : 0.55 + 0.4 * smoothstep(0.3, 0.7, clump);
          prob = (prob + (meadow - prob) * smoothstep(0.15, 0.55, L)) * (1 - F * 0.7);
        } else if (pass) prob = 0;
        prob *= density;
        if (hash2(gx + cx * 31 + pass * 7919, gz + cz * 17, seed + 21) > prob) continue;
        if (!roadClear(x, z, city ? -0.8 : 1.6) || !inCorridor(x, z)) continue;
        normalAt(def, x, z, nrm);
        if (nrm[1] < 0.82) continue;
        const surf = surfaceAt(def, x, z);
        if (surf === 'asphalt' && !city) continue;
        // Drifted sand is thin ground, but the green country holds it together (the dune seas stay bare all the same).
        if (surf === 'sand' && hash2(gx, gz, seed + 99) > 0.35 + 0.65 * smoothstep(0.3, 0.6, L)) continue;
        if (blockedBy(aabbs, props, x, z, 0.4) || extraBlock?.(x, z)) continue;
        const k = hash2(gx + cx * 5 + pass * 3, gz + cz * 3, seed + 7);
        grass.push({ x, y: H(x, z) - 0.04, z, yaw: k * 6.283, s: ((city ? 0.55 : 0.75) + k * 0.6) * (1 + L * 0.5), tilt: [nrm[2] * 0.8, -nrm[0] * 0.8] });
      }
    }
  }
  // Shrubs: sparse, on firm ground away from the road; more of them, and greener, in the green country.
  if (!city) {
    const sStep = 7.5;
    const sn = Math.floor(CHUNK / sStep);
    for (let gz = 0; gz < sn; gz++) {
      if (gz % 4 === 3) yield;
      for (let gx = 0; gx < sn; gx++) {
        const p = jitter(gx, gz, sStep, 31);
        const x = p.x;
        const z = p.z;
        const L = lush(x, z);
        const prob = (0.12 + smoothstep(0.45, 0.8, noise2(x / 31, z / 31, seed + 8)) * 0.4 + L * 0.15 + (L > 0.42 ? forest(x, z) * 0.2 : 0)) * density;
        if (hash2(gx + cx * 13, gz + cz * 29, seed + 33) > prob) continue;
        if (!roadClear(x, z, 3) || !inCorridor(x, z)) continue;
        normalAt(def, x, z, nrm);
        if (nrm[1] < 0.86) continue;
        if (surfaceAt(def, x, z) === 'sand' && hash2(gx, gz, seed + 5) > 0.3 + 0.7 * smoothstep(0.3, 0.6, L)) continue;
        if (blockedBy(aabbs, props, x, z, 1.2) || extraBlock?.(x, z)) continue;
        const k = hash2(gx + cx * 3, gz + cz * 7, seed + 9);
        shrubs.push({ x, y: H(x, z) - 0.06, z, yaw: k * 6.283, s: 0.55 + k * 0.9, tilt: [0, 0] });
      }
    }
  }
  // Wildflowers in clumps across the lushest meadows, out of the woods' shade.
  const flowers: Spot[] = [];
  if (maxL > 0.5) {
    const fStep = 2.5;
    const fn = Math.floor(CHUNK / fStep);
    for (let gz = 0; gz < fn; gz++) {
      if (gz % 10 === 9) yield;
      for (let gx = 0; gx < fn; gx++) {
        const p = jitter(gx, gz, fStep, 141);
        const x = p.x;
        const z = p.z;
        const L = lushAt(def, x, z);
        if (L < 0.55) continue;
        const prob = smoothstep(0.55, 0.8, L) * smoothstep(0.5, 0.72, noise2(x / 13, z / 13, seed + 41)) * (1 - forest(x, z)) * 0.85 * density;
        if (hash2(gx + cx * 71, gz + cz * 37, seed + 143) > prob) continue;
        if (!roadClear(x, z, 1.2)) continue;
        const surf = surfaceAt(def, x, z);
        if (surf === 'asphalt' || surf === 'mud') continue;
        normalAt(def, x, z, nrm);
        if (nrm[1] < 0.84) continue;
        if (blockedBy(aabbs, props, x, z, 0.4) || extraBlock?.(x, z)) continue;
        const k = hash2(gx + cx * 7, gz + cz * 11, seed + 145);
        flowers.push({ x, y: H(x, z) - 0.03, z, yaw: k * 6.283, s: 0.8 + k * 0.5, tilt: [nrm[2] * 0.6, -nrm[0] * 0.6] });
      }
    }
  }
  // Ferns and undergrowth under the woods.
  const ferns: Spot[] = [];
  if (maxF > 0.25) {
    const eStep = 3;
    const en = Math.floor(CHUNK / eStep);
    for (let gz = 0; gz < en; gz++) {
      if (gz % 8 === 7) yield;
      for (let gx = 0; gx < en; gx++) {
        const p = jitter(gx, gz, eStep, 151);
        const x = p.x;
        const z = p.z;
        const F = forest(x, z);
        if (F < 0.3) continue;
        const prob = smoothstep(0.3, 0.7, F) * (0.35 + 0.55 * smoothstep(0.35, 0.65, noise2(x / 9, z / 9, seed + 51))) * density;
        if (hash2(gx + cx * 19, gz + cz * 53, seed + 153) > prob) continue;
        if (!roadClear(x, z, 1.5)) continue;
        const surf = surfaceAt(def, x, z);
        if (surf === 'asphalt' || surf === 'mud') continue;
        normalAt(def, x, z, nrm);
        if (nrm[1] < 0.8) continue;
        if (blockedBy(aabbs, props, x, z, 0.6) || extraBlock?.(x, z)) continue;
        const k = hash2(gx + cx * 23, gz + cz * 29, seed + 155);
        ferns.push({ x, y: H(x, z) - 0.05, z, yaw: k * 6.283, s: 0.7 + k * 0.7, tilt: [nrm[2] * 0.5, -nrm[0] * 0.5] });
      }
    }
  }
  // Reeds and cattails at the water's edge: in the shallows and a couple of metres up the bank. A coarse pass finds the
  // 8 m cells by any water, and only those are planted.
  const reeds: Spot[] = [];
  const pads: Spot[] = [];
  const xm = x0 + CHUNK / 2;
  const zm = z0 + CHUNK / 2;
  const wateryChunk = !city && (def.lakes.some((l) => Math.abs(l.x - xm) < l.reach + 80 && Math.abs(l.z - zm) < l.reach + 80) || (!!def.hydro && nearHydro(def, xm, zm, 100)));
  if (wateryChunk) {
    const CW = 8;
    const cn = CHUNK / CW;
    const wetCell = new Uint8Array(cn * cn);
    for (let j = 0; j < cn; j++) {
      for (let i = 0; i < cn; i++) {
        const x = x0 + (i + 0.5) * CW;
        const z = z0 + (j + 0.5) * CW;
        const w = wetGround(def, x, z, H(x, z));
        if (w && w.depth < 2 && (w.damp > 0.1 || w.depth > 0)) {
          for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if (i + di >= 0 && j + dj >= 0 && i + di < cn && j + dj < cn) wetCell[(j + dj) * cn + i + di] = 1;
        }
      }
    }
    yield;
    const rStep = 1.6;
    const per = CW / rStep;
    for (let j = 0; j < cn; j++) {
      if (j % 4 === 3) yield;
      for (let i = 0; i < cn; i++) {
        if (!wetCell[j * cn + i]) continue;
        for (let b = 0; b < per; b++) {
          for (let a = 0; a < per; a++) {
            const gx = i * per + a;
            const gz = j * per + b;
            const p = jitter(gx, gz, rStep, 161);
            const x = p.x;
            const z = p.z;
            const prob = (0.3 + 0.65 * smoothstep(0.35, 0.7, noise2(x / 6, z / 6, seed + 71))) * density;
            if (hash2(gx + cx * 41, gz + cz * 59, seed + 163) > prob) continue;
            const h = H(x, z);
            const w = wetGround(def, x, z, h);
            if (!w) continue;
            const edge = w.depth > 0.03 ? w.depth < 0.55 : w.damp > 0.45;
            if (!edge || (w.kind === 'swamp' && w.depth > 0.03 && w.depth < 0.2 && hash2(gx, gz, seed + 165) < 0.5)) continue;
            if (!roadClear(x, z, 1) || blockedBy(aabbs, props, x, z, 0.5)) continue;
            const k = hash2(gx + cx * 43, gz + cz * 61, seed + 167);
            reeds.push({ x, y: h - 0.05, z, yaw: k * 6.283, s: 0.75 + k * 0.6 + (w.kind === 'swamp' ? 0.25 : 0), tilt: [(k - 0.5) * 0.15, (hash2(gx, gz, seed + 169) - 0.5) * 0.15] });
          }
        }
      }
    }
    // Lily pads and duckweed floating on a swamp's open water, 0.2 to 1.2 m deep.
    for (const s of def.hydro?.swamps ?? []) {
      if (Math.abs(s.x - xm) > s.reach + CHUNK / 2 || Math.abs(s.z - zm) > s.reach + CHUNK / 2) continue;
      const pStep = 2.2;
      const pn = Math.floor(CHUNK / pStep);
      for (let gz = 0; gz < pn; gz++) {
        if (gz % 12 === 11) yield;
        for (let gx = 0; gx < pn; gx++) {
          const p = jitter(gx, gz, pStep, 171);
          const x = p.x;
          const z = p.z;
          if (swampQ(s, x, z) >= 0.98) continue;
          const prob = smoothstep(0.35, 0.65, noise2(x / 8, z / 8, seed + 81)) * 0.75 * density;
          if (hash2(gx + cx * 47, gz + cz * 67, seed + 173) > prob) continue;
          const depth = s.level - H(x, z);
          if (depth < 0.2 || depth > 1.2) continue;
          const k = hash2(gx + cx * 49, gz + cz * 71, seed + 175);
          pads.push({ x, y: s.level + 0.025, z, yaw: k * 6.283, s: 0.6 + k * 0.7, tilt: [0, 0] });
        }
      }
    }
  }
  // Boulders heaped along the cliff feet (outside the drivable corridor), breaking up the base line.
  const boulders: Spot[][] = [[], [], []];
  if (!city && !def.open) {
    const bStep = 6;
    for (let k = 0; k < CHUNK / bStep; k++) {
      for (const side of [-1, 1]) {
        const z = z0 + (k + hash2(k + cz * 97, side, seed + 91)) * bStep;
        const ch = corridorHalf(def, z);
        const kk = hash2(k + cz * 17, side + 3, seed + 94);
        const sc = 3 + kk * kk * 7;
        // Sit against the cliff foot: the front edge rests on the ground just outside the drivable floor.
        const d = ch + 1 + sc * 0.35 + hash2(k + cz * 31, side, seed + 92) * 2;
        const x = roadX(def, z) + side * d;
        if (Math.floor(x / CHUNK) !== cx || hash2(k + cz * 13, side, seed + 93) > 0.8 * Math.max(0.5, density)) continue;
        const front = heightAt(def, x - side * sc * 0.45, z);
        boulders[Math.floor(kk * 2.99)].push({ x, y: front - sc * 0.15, z, yaw: kk * 37, s: sc, tilt: [(kk - 0.5) * 0.3, (hash2(k, side, 5) - 0.5) * 0.3] });
      }
    }
  }
  // Pebbles and stones (rubble chunks in the city).
  const pStep = city ? 5 : 5.5;
  const pn = Math.floor(CHUNK / pStep);
  for (let gz = 0; gz < pn; gz++) {
    if (gz % 8 === 7) yield;
    for (let gx = 0; gx < pn; gx++) {
      const p = jitter(gx, gz, pStep, 51);
      const x = p.x;
      const z = p.z;
      const prob = (city ? 0.18 : 0.3) * density * (1 - lush(x, z) * 0.6);
      if (hash2(gx + cx * 41, gz + cz * 43, seed + 55) > prob) continue;
      if (!roadClear(x, z, city ? -0.4 : 0.6)) continue;
      if (!inCorridor(x, z)) continue;
      if (blockedBy(aabbs, props, x, z, 0.5) || extraBlock?.(x, z)) continue;
      normalAt(def, x, z, nrm);
      const k = hash2(gx + cx * 9, gz + cz * 11, seed + 57);
      const v = k < 0.12 && !city ? 2 : k < 0.56 ? 0 : 1;
      pebbles[v].push({ x, y: H(x, z) - (v === 2 ? 0.2 : 0.03), z, yaw: k * 40, s: v === 2 ? 0.6 + k * 2.5 : 0.7 + k * 0.8, tilt: [nrm[2] * 0.9, -nrm[0] * 0.9] });
    }
  }
  yield;
  // Cinder country is dark: ash-grey tufts and black rock, not straw and sandstone.
  const dim = def.theme === 'cinder' ? 0.5 : 1;
  const grassTint = (_: number, s: Spot) => {
    const h = hash2(Math.floor(s.x * 3), Math.floor(s.z * 3), 77);
    const dry = noise2(s.x / 40, s.z / 40, 5);
    // Straw yellow to grey-olive.
    if (city) return _col.setRGB(0.42 + h * 0.1, 0.44 + h * 0.08, 0.3);
    _col.setRGB(0.8 + dry * 0.22 + h * 0.08, 0.68 + dry * 0.1 + h * 0.06, 0.42 - dry * 0.06).multiplyScalar(dim);
    const L = lush(s.x, s.z);
    if (L <= 0) return _col;
    // Green country: fresh green, olive and yellow-green in drifts, still straw at the dry edge of the green.
    const hue = noise2(s.x / 23 + 3, s.z / 23, 6);
    const r = 0.17 + hue * 0.2 + h * 0.05;
    const g = 0.36 + hue * 0.08 + h * 0.07;
    const b = 0.06 + (1 - hue) * 0.04;
    const t = smoothstep(0.18, 0.6, L);
    return _col.setRGB(_col.r + (r - _col.r) * t, _col.g + (g - _col.g) * t, _col.b + (b - _col.b) * t);
  };
  const shrubTint = (_: number, s: Spot) => {
    const h = hash2(Math.floor(s.x), Math.floor(s.z), 79);
    const dry = noise2(s.x / 50, s.z / 50, 6);
    // Sage green to dead brown; in the green country, leafy green.
    _col.setRGB(0.95 + dry * 0.35 + h * 0.15, 0.95 + h * 0.15 - dry * 0.1, 0.85 - dry * 0.25).multiplyScalar(dim * 0.5 + 0.5);
    const t = smoothstep(0.2, 0.6, lush(s.x, s.z));
    return t > 0 ? _col.lerp(_c2.setRGB(0.26 + h * 0.1, 0.46 + h * 0.1, 0.16 + dry * 0.06), t) : _col;
  };
  const rockTint = (_: number, s: Spot) => {
    const h = hash2(Math.floor(s.x * 2), Math.floor(s.z * 2), 81);
    if (city) return _col.setRGB(0.72 + h * 0.2, 0.72 + h * 0.2, 0.74 + h * 0.2);
    return _col.setRGB(0.85 + h * 0.3, 0.8 + h * 0.25, 0.75 + h * 0.2).multiplyScalar(dim * 0.7 + 0.3);
  };
  const flowerTint = (_: number, s: Spot) => {
    const pick = Math.floor(noise2(s.x / 17, s.z / 17, seed + 43) * 7.99 + hash2(Math.floor(s.x * 4), Math.floor(s.z * 4), 83) * 1.2) % FLOWER_COLS.length;
    const c = FLOWER_COLS[pick];
    const l = 0.85 + hash2(Math.floor(s.x * 5), Math.floor(s.z * 5), 84) * 0.3;
    return _col.setRGB(c[0] * l, c[1] * l, c[2] * l);
  };
  const fernTint = (_: number, s: Spot) => {
    const h = hash2(Math.floor(s.x * 2), Math.floor(s.z * 2), 85);
    // Mostly green fern, here and there a patch of bracken gone brown.
    if (noise2(s.x / 21, s.z / 21, seed + 86) > 0.72) return _col.setRGB(0.32 + h * 0.08, 0.2 + h * 0.05, 0.09);
    return _col.setRGB(0.2 + h * 0.08, 0.34 + h * 0.08, 0.12 + h * 0.04);
  };
  const reedTint = (_: number, s: Spot) => {
    const h = hash2(Math.floor(s.x * 2), Math.floor(s.z * 2), 87);
    return _col.setRGB(0.42 + h * 0.12, 0.46 + h * 0.1, 0.36 + h * 0.08);
  };
  const padTint = (_: number, s: Spot) => {
    const h = hash2(Math.floor(s.x * 2), Math.floor(s.z * 2), 88);
    return _col.setRGB(0.55 + h * 0.2, 0.6 + h * 0.2, 0.5 + h * 0.15);
  };
  const set: ScatterSet = { grass: null, shrubs: null, pebbles: [], boulders: [], flowers: null, ferns: null, reeds: null, pads: null };
  set.grass = instanced(grassGeometry(), grassMaterial(), grass, grassTint);
  yield;
  set.shrubs = instanced(bushGeometry(), cardMaterial('bush'), shrubs, shrubTint);
  set.flowers = instanced(flowerGeometry(), cardMaterial('flower'), flowers, flowerTint);
  set.ferns = instanced(fernGeometry(), cardMaterial('fern'), ferns, fernTint);
  set.reeds = instanced(reedGeometry(), cardMaterial('reed'), reeds, reedTint);
  set.pads = instanced(padGeometry(), cardMaterial('pad'), pads, padTint);
  yield;
  boulders.forEach((list, v) => {
    const im = instanced(boulderGeometry(v), kitMaterial(), list, rockTint);
    if (im) {
      im.castShadow = true;
      im.receiveShadow = true;
      set.boulders.push(im);
    }
  });
  yield;
  pebbles.forEach((list, v) => {
    const im = instanced(pebbleGeometry(v), kitMaterial(), list, rockTint);
    if (im) set.pebbles.push(im);
  });
  if (set.shrubs) set.shrubs.castShadow = true;
  if (set.ferns) set.ferns.receiveShadow = true;
  if (set.reeds) set.reeds.receiveShadow = true;
  if (set.flowers) set.flowers.receiveShadow = true;
  for (const pb of set.pebbles) pb.receiveShadow = true;
  if (set.grass) set.grass.receiveShadow = true;
  return set;
}

const _c2 = new THREE.Color();

function smoothstep(e0: number, e1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Instanced ground cover from precomputed spots (the camp arena places its own). */
export function scatterFromSpots(grass: Spot[], shrubs: Spot[], pebbles: Spot[][], city: boolean, lush = 0): ScatterSet {
  const col = new THREE.Color();
  const green = new THREE.Color();
  const set: ScatterSet = {
    grass: instanced(grassGeometry(), grassMaterial(), grass, (_, s) => {
      const h = hash2(Math.floor(s.x * 3), Math.floor(s.z * 3), 77);
      if (city) return col.setRGB(0.42 + h * 0.1, 0.44 + h * 0.08, 0.3);
      // On the green the straw goes to living grass.
      col.setRGB(0.85 + h * 0.15, 0.72 + h * 0.08, 0.42);
      return lush > 0 ? col.lerp(green.setRGB(0.42 + h * 0.12, 0.62 + h * 0.1, 0.24), Math.min(1, lush * 1.2)) : col;
    }),
    shrubs: instanced(bushGeometry(), cardMaterial('bush'), shrubs, (_, s) => {
      const h = hash2(Math.floor(s.x), Math.floor(s.z), 79);
      col.setRGB(1 + h * 0.2, 0.95 + h * 0.15, 0.8);
      return lush > 0 ? col.lerp(green.setRGB(0.6 + h * 0.15, 0.9 + h * 0.1, 0.5), Math.min(1, lush)) : col;
    }),
    pebbles: [],
    boulders: [],
    flowers: null,
    ferns: null,
    reeds: null,
    pads: null,
  };
  pebbles.forEach((list, v) => {
    const im = instanced(pebbleGeometry(v), kitMaterial(), list, (_, s) => {
      const h = hash2(Math.floor(s.x * 2), Math.floor(s.z * 2), 81);
      return city ? col.setRGB(0.72 + h * 0.2, 0.72 + h * 0.2, 0.74 + h * 0.2) : col.setRGB(0.85 + h * 0.3, 0.8 + h * 0.25, 0.75 + h * 0.2);
    });
    if (im) set.pebbles.push(im);
  });
  if (set.shrubs) set.shrubs.castShadow = true;
  return set;
}

/** A big boulder geometry (variant 0..2) for hand-placed rock formations. */
export function boulderGeo(v: number) {
  return boulderGeometry(v);
}

/**
 * Meshes that draw nothing but make the renderer compile the green country's card programs at load (the landscape adds
 * them), instead of with the first meadow streamed in.
 */
export function scatterWarmup(): THREE.InstancedMesh[] {
  const kinds: [THREE.BufferGeometry, CardKind][] = [
    [grassGeometry(), 'grass'],
    [flowerGeometry(), 'flower'],
    [fernGeometry(), 'fern'],
    [reedGeometry(), 'reed'],
    [padGeometry(), 'pad'],
  ];
  return kinds.map(([geo, kind]) => {
    const im = new THREE.InstancedMesh(geo, cardMaterial(kind), 1);
    im.setMatrixAt(0, _m.makeScale(0, 0, 0));
    im.setColorAt(0, _col.setRGB(1, 1, 1));
    im.frustumCulled = false;
    im.onAfterRender = () => {
      im.visible = false;
    };
    return im;
  });
}
