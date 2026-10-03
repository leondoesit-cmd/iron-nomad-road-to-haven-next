import * as THREE from 'three';
import { MeshBuilder, S } from './builder';
import { GLOBALS, kitMaterial } from './materials';
import { bushTexture, grassTexture } from './proctex';
import { shared } from './dispose';
import { hash2, noise2 } from '../core/rng';
import { CHUNK, corridorHalf, heightAt, normalAt, roadX, surfaceAt, type TerrainDef } from '../world/terrain';
import { cityChunk, nearestRoad } from '../world/openWorld';
import type { Aabb, PropSpawn } from '../world/layout';

/**
 * Ground cover: instanced dry grass cards, shrubs and pebble clusters, placed deterministically per chunk.
 * Grass sways in a shared wind and shrinks away with distance, so density costs nothing far from the camera.
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

const WIND = {
  uWind: { value: new THREE.Vector4(0.8, 0.0, 0.6, 1.0) },
};

const cardMats = new Map<string, THREE.MeshStandardMaterial>();

/** Alpha-tested foliage card material: wind sway, distance shrink, and normals that ignore the face side. */
function cardMaterial(kind: 'grass' | 'bush'): THREE.MeshStandardMaterial {
  const hit = cardMats.get(kind);
  if (hit) return hit;
  const grass = kind === 'grass';
  const m = new THREE.MeshStandardMaterial({ map: grass ? grassTexture() : bushTexture(), alphaTest: grass ? 0.42 : 0.38, side: THREE.DoubleSide, roughness: 0.95, metalness: 0 });
  const fade = grass ? new THREE.Vector2(55, 85) : new THREE.Vector2(120, 170);
  const sway = grass ? 0.55 : 0.12;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = GLOBALS.uTime;
    shader.uniforms.uWind = WIND.uWind;
    shader.uniforms.uFade = { value: fade };
    shader.uniforms.uSway = { value: sway };
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
      grass
        ? '#include <normal_fragment_begin>\nnormal = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );'
        : '#include <normal_fragment_begin>\nnormal = normalize( vNormal );',
    );
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
 * has a collider, and nothing is placed on the road, in a building or on another prop.
 */
export function buildScatter(def: TerrainDef, cx: number, cz: number, aabbs: Aabb[], props: PropSpawn[], density: number, extraBlock?: (x: number, z: number) => boolean): ScatterSet {
  const g = buildScatterSteps(def, cx, cz, aabbs, props, density, extraBlock);
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

/** `buildScatter` in slices: it yields between phases and every few rows, so a streaming chunk can spread it over several ticks. */
export function* buildScatterSteps(def: TerrainDef, cx: number, cz: number, aabbs: Aabb[], props: PropSpawn[], density: number, extraBlock?: (x: number, z: number) => boolean): Generator<void, ScatterSet> {
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
  // Grass: clumpy, thinned on sand, absent on rock, gravel shoulders and in the city's open asphalt.
  const gStep = city ? 3.2 : 2.0;
  const gn = Math.floor(CHUNK / gStep);
  for (let gz = 0; gz < gn; gz++) {
    if (gz % 8 === 7) yield;
    for (let gx = 0; gx < gn; gx++) {
      const p = jitter(gx, gz, gStep, 11);
      const x = p.x;
      const z = p.z;
      const clump = noise2(x / 19 + 7, z / 19 - 3, seed + 5);
      let prob = city ? 0 : smoothstep(0.3, 0.72, clump) * 0.85;
      if (city) {
        // Weeds hug walls and kerbs.
        const d = Math.abs(x - roadX(def, z));
        prob = (d > 9.4 && d < 10.6 ? 0.55 : 0) + smoothstep(0.7, 0.9, clump) * 0.25;
      }
      prob *= density;
      if (hash2(gx + cx * 31, gz + cz * 17, seed + 21) > prob) continue;
      if (!roadClear(x, z, city ? -0.8 : 1.6) || !inCorridor(x, z)) continue;
      normalAt(def, x, z, nrm);
      if (nrm[1] < 0.82) continue;
      const surf = surfaceAt(def, x, z);
      if (surf === 'asphalt' && !city) continue;
      if (surf === 'sand' && hash2(gx, gz, seed + 99) > 0.35) continue;
      if (blockedBy(aabbs, props, x, z, 0.4) || extraBlock?.(x, z)) continue;
      const k = hash2(gx + cx * 5, gz + cz * 3, seed + 7);
      grass.push({ x, y: heightAt(def, x, z) - 0.04, z, yaw: k * 6.283, s: (city ? 0.55 : 0.75) + k * 0.6, tilt: [(nrm[2]) * 0.8, -nrm[0] * 0.8] });
    }
  }
  // Shrubs: sparse, on firm ground away from the road.
  if (!city) {
    const sStep = 7.5;
    const sn = Math.floor(CHUNK / sStep);
    for (let gz = 0; gz < sn; gz++) {
      if (gz % 4 === 3) yield;
      for (let gx = 0; gx < sn; gx++) {
        const p = jitter(gx, gz, sStep, 31);
        const x = p.x;
        const z = p.z;
        const prob = (0.12 + smoothstep(0.45, 0.8, noise2(x / 31, z / 31, seed + 8)) * 0.4) * density;
        if (hash2(gx + cx * 13, gz + cz * 29, seed + 33) > prob) continue;
        if (!roadClear(x, z, 3) || !inCorridor(x, z)) continue;
        normalAt(def, x, z, nrm);
        if (nrm[1] < 0.86) continue;
        if (surfaceAt(def, x, z) === 'sand' && hash2(gx, gz, seed + 5) > 0.3) continue;
        if (blockedBy(aabbs, props, x, z, 1.2) || extraBlock?.(x, z)) continue;
        const k = hash2(gx + cx * 3, gz + cz * 7, seed + 9);
        shrubs.push({ x, y: heightAt(def, x, z) - 0.06, z, yaw: k * 6.283, s: 0.55 + k * 0.9, tilt: [0, 0] });
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
      const prob = (city ? 0.18 : 0.3) * density;
      if (hash2(gx + cx * 41, gz + cz * 43, seed + 55) > prob) continue;
      if (!roadClear(x, z, city ? -0.4 : 0.6)) continue;
      if (!inCorridor(x, z)) continue;
      if (blockedBy(aabbs, props, x, z, 0.5) || extraBlock?.(x, z)) continue;
      normalAt(def, x, z, nrm);
      const k = hash2(gx + cx * 9, gz + cz * 11, seed + 57);
      const v = k < 0.12 && !city ? 2 : k < 0.56 ? 0 : 1;
      pebbles[v].push({ x, y: heightAt(def, x, z) - (v === 2 ? 0.2 : 0.03), z, yaw: k * 40, s: v === 2 ? 0.6 + k * 2.5 : 0.7 + k * 0.8, tilt: [nrm[2] * 0.9, -nrm[0] * 0.9] });
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
    return _col.setRGB(0.8 + dry * 0.22 + h * 0.08, 0.68 + dry * 0.1 + h * 0.06, 0.42 - dry * 0.06).multiplyScalar(dim);
  };
  const shrubTint = (_: number, s: Spot) => {
    const h = hash2(Math.floor(s.x), Math.floor(s.z), 79);
    const dry = noise2(s.x / 50, s.z / 50, 6);
    // Sage green to dead brown.
    return _col.setRGB(0.95 + dry * 0.35 + h * 0.15, 0.95 + h * 0.15 - dry * 0.1, 0.85 - dry * 0.25).multiplyScalar(dim * 0.5 + 0.5);
  };
  const rockTint = (_: number, s: Spot) => {
    const h = hash2(Math.floor(s.x * 2), Math.floor(s.z * 2), 81);
    if (city) return _col.setRGB(0.72 + h * 0.2, 0.72 + h * 0.2, 0.74 + h * 0.2);
    return _col.setRGB(0.85 + h * 0.3, 0.8 + h * 0.25, 0.75 + h * 0.2).multiplyScalar(dim * 0.7 + 0.3);
  };
  const set: ScatterSet = { grass: null, shrubs: null, pebbles: [], boulders: [] };
  set.grass = instanced(grassGeometry(), grassMaterial(), grass, grassTint);
  yield;
  set.shrubs = instanced(bushGeometry(), cardMaterial('bush'), shrubs, shrubTint);
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
  for (const pb of set.pebbles) pb.receiveShadow = true;
  if (set.grass) set.grass.receiveShadow = true;
  return set;
}

function smoothstep(e0: number, e1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Instanced ground cover from precomputed spots (the camp arena places its own). */
export function scatterFromSpots(grass: Spot[], shrubs: Spot[], pebbles: Spot[][], city: boolean): ScatterSet {
  const col = new THREE.Color();
  const set: ScatterSet = {
    grass: instanced(grassGeometry(), grassMaterial(), grass, (_, s) => {
      const h = hash2(Math.floor(s.x * 3), Math.floor(s.z * 3), 77);
      return city ? col.setRGB(0.42 + h * 0.1, 0.44 + h * 0.08, 0.3) : col.setRGB(0.85 + h * 0.15, 0.72 + h * 0.08, 0.42);
    }),
    shrubs: instanced(bushGeometry(), cardMaterial('bush'), shrubs, (_, s) => {
      const h = hash2(Math.floor(s.x), Math.floor(s.z), 79);
      return col.setRGB(1 + h * 0.2, 0.95 + h * 0.15, 0.8);
    }),
    pebbles: [],
    boulders: [],
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
