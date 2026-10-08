import * as THREE from 'three';
import { GLOBALS } from './materials';
import { mirrorWaterMaterial, waterNoiseTexture, waterNormalTexture } from './water';
import { lakeColors } from '../world/lakes';
import { heightAt, type TerrainDef } from '../world/terrain';
import { FLOOD_SPEED, floodTaper, PAN_POOL, panQ, type Pan, type WashNet } from '../world/washes';
import { DrawnGround } from './drawnGround';
import { HYDRO_DT, type Hydrograph } from '../sim/climate';

/**
 * Flash floods and the pools they leave.
 *
 * Every wash gets a ribbon like a river's, laid flat across its dry bed and out over its banks. It is invisible until the
 * day's hydrograph says water is coming: the vertex shader reads the runoff leaving the mountains from a small texture
 * (`HYDRO`), delayed by how long a flood front takes to run that far down the wash, and lifts the ribbon by the flood's depth
 * there. So the front runs down the wash at its own speed, a churning brown bore with the water piling up behind it, and the
 * wash drains again from the top down. Nothing on the CPU moves per frame but one clock uniform. The stage is the physics'
 * own (`floodStage`): never over the lower bank (`Wash.cap`), sinking away at the mouth, and drawn only where it stands over
 * the drawn ground and over every bit of bank between it and the bed, so it fills the wash and nothing beyond.
 *
 * Each clay pan gets a sheet of the same silty water at the level its fill gives, with the ground under it carried per
 * vertex so the shore fades and only real water is drawn. A pan that has dried is just clay again.
 */

/**
 * Offsets of a cross-section's vertices each side of the centre-line: two out on the bed, its edge, then up the bank (as
 * shares of its width), where the flood's edge climbs as it rises.
 */
const BANK_AT = [0.1, 0.22, 0.36, 0.52, 0.7, 1];
const SIDE = 3 + BANK_AT.length;
/** Vertices across a flood ribbon's cross-section. */
export const FLOOD_NX = 1 + 2 * SIDE;
const NX = FLOOD_NX;
/** How far past the end of a wash its ribbon runs on into the pan or the river, fading out. */
const PAST_END = 6;
/** The hydrograph as a texture, R: runoff into the washes, G: river rise, B: pan fill, A: wet ground. One texel per step. */
export const HYDRO = {
  tHydro: { value: null as THREE.DataTexture | null },
  /** The day clock now (0 dawn, 1 dark). */
  uDayT: { value: 0 },
  /** Texels in the hydrograph texture, and the clock span one texel covers. */
  uHydro: { value: new THREE.Vector2(1, HYDRO_DT) },
  /** How far a flood front runs in one whole day of the clock, metres. */
  uFloodRun: { value: FLOOD_SPEED * 720 },
};

let hydroData: Uint8Array | null = null;

/** Load a day's hydrograph into `HYDRO.tHydro` (the floods, the rivers and the pans all read it). */
export function setHydroTexture(h: Hydrograph, dayLength: number) {
  const n = h.wash.length;
  if (!hydroData || hydroData.length !== n * 4) {
    hydroData = new Uint8Array(n * 4);
    HYDRO.tHydro.value?.dispose();
    const t = new THREE.DataTexture(hydroData, n, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = false;
    t.userData.shared = true;
    HYDRO.tHydro.value = t;
  }
  const d = hydroData;
  for (let i = 0; i < n; i++) {
    d[i * 4] = Math.round(h.wash[i] * 255);
    d[i * 4 + 1] = Math.round(h.river[i] * 255);
    d[i * 4 + 2] = Math.round(h.pan[i] * 255);
    d[i * 4 + 3] = Math.round(h.wet[i] * 255);
  }
  HYDRO.tHydro.value!.needsUpdate = true;
  HYDRO.uHydro.value.set(n, HYDRO_DT);
  HYDRO.uFloodRun.value = FLOOD_SPEED * dayLength;
}

// ------------------------------------------------------------------------------------------------ the wash ribbons

/**
 * Attributes: `aWash` (metres down the wash; metres across it; how far the drawn ground at the vertex stands over the bed;
 * the flood's depth at the head of the wash), `aWash2` (flow direction x, z; the wash's length; fade into what it runs into),
 * `aWash3` (the most a flood stands over the bed here; how much of it is left this near the mouth; the bar: the highest drawn
 * ground over the bed between the bed and the vertex).
 */
export function floodRibbonGeometry(def: TerrainDef, net: WashNet): THREE.BufferGeometry | null {
  if (!net.washes.length) return null;
  const ground = new DrawnGround(def);
  let rows = 0;
  for (const w of net.washes) rows += Math.min(w.n - 1, w.end + PAST_END) + 1;
  const V = rows * NX;
  const pos = new Float32Array(V * 3);
  const nrm = new Float32Array(V * 3);
  const a1 = new Float32Array(V * 4);
  const a2 = new Float32Array(V * 4);
  const a3 = new Float32Array(V * 3);
  const idx: number[] = [];
  const us = new Float32Array(NX);
  const over = new Float32Array(NX);
  const bar = new Float32Array(NX);
  let v = 0;
  for (const w of net.washes) {
    const last = Math.min(w.n - 1, w.end + PAST_END);
    const first = v;
    for (let i = 0; i <= last; i++) {
      const h = w.half[i];
      const b = w.bank[i];
      const nx = -w.dz[i];
      const nz = w.dx[i];
      const bed = w.bed[i];
      const fade = 1 - Math.max(0, i - w.end) / (PAST_END + 1);
      const taper = floodTaper(w, w.s[i]);
      // Centre, then each side outward; the bar runs out from the bed, between the vertices too (every half metre).
      us[0] = 0;
      over[0] = ground.mesh(w.x[i], w.z[i]) - bed;
      bar[0] = Math.min(over[0], 0);
      for (const side of [1, -1]) {
        const base = side > 0 ? 1 : SIDE + 1;
        let bb = bar[0];
        let prev = 0;
        for (let q = 0; q < SIDE; q++) {
          const a = q === 0 ? 0.45 * h : q === 1 ? 0.8 * h : q === 2 ? h : h + b * BANK_AT[q - 3];
          const x = w.x[i] + nx * a * side;
          const z = w.z[i] + nz * a * side;
          us[base + q] = a * side;
          over[base + q] = ground.mesh(x, z) - bed;
          if (a < h - 1e-3) bb = Math.max(bb, Math.min(over[base + q], 0));
          else {
            const from = Math.max(prev, h);
            const steps = Math.floor((a - from) / 0.5);
            for (let t = 1; t <= steps; t++) {
              const ua = (from + ((a - from) * t) / (steps + 1)) * side;
              bb = Math.max(bb, ground.mesh(w.x[i] + nx * ua, w.z[i] + nz * ua) - bed);
            }
            bb = Math.max(bb, over[base + q]);
          }
          bar[base + q] = bb;
          prev = a;
        }
      }
      for (let slot = 0; slot < NX; slot++) {
        // Left edge to right edge.
        const q = slot < SIDE ? SIDE + SIDE - slot : slot === SIDE ? 0 : slot - SIDE;
        pos[v * 3] = w.x[i] + nx * us[q];
        pos[v * 3 + 1] = bed;
        pos[v * 3 + 2] = w.z[i] + nz * us[q];
        nrm[v * 3 + 1] = 1;
        a1[v * 4] = w.s[i];
        a1[v * 4 + 1] = us[q];
        a1[v * 4 + 2] = over[q];
        a1[v * 4 + 3] = w.flood;
        a2[v * 4] = w.dx[i];
        a2[v * 4 + 1] = w.dz[i];
        a2[v * 4 + 2] = w.len;
        a2[v * 4 + 3] = fade;
        a3[v * 3] = w.cap[i];
        a3[v * 3 + 1] = taper;
        a3[v * 3 + 2] = bar[q];
        v++;
      }
    }
    for (let i = 0; i < last; i++) {
      const a = first + i * NX;
      const b = a + NX;
      for (let k = 0; k < NX - 1; k++) idx.push(a + k, a + k + 1, b + k, a + k + 1, b + k + 1, b + k);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('aWash', new THREE.BufferAttribute(a1, 4));
  g.setAttribute('aWash2', new THREE.BufferAttribute(a2, 4));
  g.setAttribute('aWash3', new THREE.BufferAttribute(a3, 3));
  g.setIndex(idx);
  g.computeBoundingBox();
  g.boundingBox!.max.y += 2;
  g.boundingSphere = g.boundingBox!.getBoundingSphere(new THREE.Sphere());
  return g;
}

const HYDRO_PARS = /* glsl */ `
uniform sampler2D tHydro;
uniform float uDayT;
uniform vec2 uHydro;
uniform float uFloodRun;
vec4 hydroAt( float t ) {
  return texture2D( tHydro, vec2( ( t / uHydro.y + 0.5 ) / uHydro.x, 0.5 ) );
}
`;

const FLOOD_VERT_PARS = /* glsl */ `
attribute vec4 aWash;
attribute vec4 aWash2;
attribute vec3 aWash3;
${HYDRO_PARS}
varying vec4 vFl;
varying vec4 vFl2;
varying vec3 vFlW;
varying float vFlBar;
`;

const FLOOD_VERT_MAIN = /* glsl */ `
{
  // The runoff that left the mountains as long ago as the front takes to get this far down.
  float fT = uDayT - aWash.x / uFloodRun;
  float fQ = hydroAt( fT ).r;
  // A moment before: where the flood is still rising fast, this is the front.
  float fQ0 = hydroAt( fT - 0.004 ).r;
  // As floodStage has it: lower down the wash, never over the lower bank, sinking away at the mouth.
  float fStage = min( aWash.w * fQ * ( 1.0 - 0.35 * clamp( aWash.x / aWash2.z, 0.0, 1.0 ) ), aWash3.x ) * aWash3.y;
  transformed.y += fStage;
  // Over every bit of bank between the bed and here, or the water cannot be here.
  vFlBar = fStage - aWash3.z;
  // Depth over the ground here; how hard the front is breaking; across; down the wash.
  vFl = vec4( fStage - aWash.z, clamp( ( fQ - fQ0 ) * 26.0, 0.0, 1.0 ), aWash.y, aWash.x );
  // Flow direction, the flood's stage as a share of a big one, fade into what it runs into.
  vFl2 = vec4( aWash2.xy, fStage / max( 0.3, aWash.w ), aWash2.w );
  vFlW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
}
`;

const FLOOD_FRAG_PARS = /* glsl */ `
uniform sampler2D tWNorm;
uniform sampler2D tWNoise;
uniform vec3 cWShallow;
uniform vec3 cWDeep;
uniform vec3 cWFoam;
uniform float uWTime;
varying vec4 vFl;
varying vec4 vFl2;
varying vec3 vFlW;
varying float vFlBar;
`;

const FLOOD_COLOR = /* glsl */ `
float fD = vFl.x;
if ( fD < 0.012 || vFlBar < 0.0 || vFl2.z < 0.015 || vFl2.w < 0.02 ) discard;
float fSpd = 2.4 + 3.4 * clamp( vFl2.z, 0.0, 1.2 );
float fT = mod( uWTime, 100.0 );
// Down the wash at the water's own speed; boils and standing waves that hold still while the water runs through them.
vec2 fp = vec2( vFl.z, vFl.w - fT * fSpd );
vec4 fN1 = texture2D( tWNoise, fp * vec2( 0.11, 0.05 ) );
vec4 fN2 = texture2D( tWNoise, fp * vec2( 0.27, 0.13 ) + 0.31 );
vec4 fN3 = texture2D( tWNoise, vFlW.xz * 0.07 + vec2( fT * 0.05, - fT * 0.04 ) );
float fRough = fN1.r * 0.5 + fN2.g * 0.3 + fN3.b * 0.2;
vec3 fCol = mix( cWShallow, cWDeep, smoothstep( 0.05, 1.2, fD ) );
fCol *= 0.85 + 0.3 * fN3.r;
// Foam: the breaking front, the churn along the banks, streaks of scum and the crests of the standing waves.
float fFront = vFl.y * smoothstep( 0.3, 0.6, fRough + 0.25 );
float fBank = smoothstep( 0.25, 0.0, fD + ( fN2.r - 0.5 ) * 0.2 ) * 0.7;
float fStreak = smoothstep( 0.68, 0.86, fN1.g * 0.6 + fN2.b * 0.4 ) * ( 0.35 + 0.5 * clamp( vFl2.z, 0.0, 1.0 ) );
float fFoam = clamp( max( max( fFront, fBank ), fStreak ), 0.0, 1.0 );
fCol = mix( fCol, cWFoam * ( 0.85 + 0.2 * fN2.g ), fFoam * 0.85 );
// Sticks and brush tumbling in it.
float fJunk = smoothstep( 0.86, 0.9, texture2D( tWNoise, fp * vec2( 0.9, 0.4 ) + 0.7 ).b ) * ( 1.0 - fFoam );
fCol = mix( fCol, vec3( 0.12, 0.09, 0.06 ), fJunk * 0.8 );
float wA = smoothstep( 0.012, 0.09, fD ) * smoothstep( 0.0, 0.03, vFlBar ) * vFl2.w;
diffuseColor = vec4( fCol, wA );
// Silt-thick and churning: it scatters more than it mirrors.
float wRough = mix( 0.34, 0.62, fFoam ) + fRough * 0.12;
vec3 wNw;
{
  vec2 rF = normalize( vFl2.xy + vec2( 1e-4 ) );
  vec2 rA = vec2( - rF.y, rF.x );
  vec2 n1 = texture2D( tWNorm, fp * vec2( 0.16, 0.09 ) ).xy * 2.0 - 1.0;
  vec2 n2 = texture2D( tWNorm, fp * vec2( 0.41, 0.23 ) + 0.5 ).xy * 2.0 - 1.0;
  vec2 nn = ( n1 * 0.6 + n2 * 0.5 ) * ( 0.7 + 0.6 * clamp( vFl2.z, 0.0, 1.0 ) + vFl.y );
  vec2 rn = rA * nn.x + rF * nn.y;
  wNw = normalize( vec3( rn.x, 1.0, rn.y ) );
}
`;

function floodMaterial(): THREE.MeshStandardMaterial {
  const mat = mirrorWaterMaterial(0.25);
  const col = lakeColors('flood');
  const uniforms = {
    ...HYDRO,
    tWNorm: { value: waterNormalTexture() },
    tWNoise: { value: waterNoiseTexture() },
    cWShallow: { value: new THREE.Color(col.shallow) },
    cWDeep: { value: new THREE.Color(col.deep) },
    cWFoam: { value: new THREE.Color(col.foam) },
    uWTime: GLOBALS.uTime,
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${FLOOD_VERT_PARS}`)
      .replace('#include <project_vertex>', `${FLOOD_VERT_MAIN}\n#include <project_vertex>`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FLOOD_FRAG_PARS}`)
      .replace('#include <color_fragment>', FLOOD_COLOR)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = wRough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = 0.0;')
      .replace('#include <normal_fragment_maps>', 'normal = normalize( ( viewMatrix * vec4( wNw, 0.0 ) ).xyz );');
  };
  mat.customProgramCacheKey = () => 'floodWater';
  return mat;
}

// ------------------------------------------------------------------------------------------------ the pans

const POOL_RES = 28;

/** A grid over a pan, flat at its floor, carrying the ground's height over the floor at each vertex. */
function poolGeometry(def: TerrainDef, p: Pan): THREE.BufferGeometry {
  const ext = p.r * Math.max(p.ax, 1 / p.ax) * 1.08;
  const N = POOL_RES;
  const pos: number[] = [];
  const gnd: number[] = [];
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const x = p.x - ext + (2 * ext * i) / N;
      const z = p.z - ext + (2 * ext * j) / N;
      pos.push(x, p.floor, z);
      gnd.push(panQ(p, x, z) < 1.1 ? heightAt(def, x, z) - p.floor : 9);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i;
      const b = a + 1;
      const c = a + N + 1;
      const d = c + 1;
      // Skip cells wholly outside the pan.
      if (gnd[a] > 8 && gnd[b] > 8 && gnd[c] > 8 && gnd[d] > 8) continue;
      idx.push(a, c, d, a, d, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array((N + 1) * (N + 1) * 3).fill(0).map((_, k) => (k % 3 === 1 ? 1 : 0)), 3));
  g.setAttribute('aGround', new THREE.Float32BufferAttribute(gnd, 1));
  g.setIndex(idx);
  g.computeBoundingBox();
  g.boundingBox!.max.y += PAN_POOL + 0.2;
  g.boundingSphere = g.boundingBox!.getBoundingSphere(new THREE.Sphere());
  return g;
}

const POOL_VERT_PARS = /* glsl */ `
attribute float aGround;
uniform float uPool;
varying float vPoolD;
varying vec3 vPoolW;
`;
const POOL_VERT_MAIN = /* glsl */ `
transformed.y += uPool;
vPoolD = uPool - aGround;
vPoolW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
`;
const POOL_FRAG_PARS = /* glsl */ `
uniform sampler2D tWNorm;
uniform sampler2D tWNoise;
uniform vec3 cWShallow;
uniform vec3 cWDeep;
uniform vec3 cWFoam;
uniform float uWTime;
uniform float uRainHit;
varying float vPoolD;
varying vec3 vPoolW;
`;
const POOL_COLOR = /* glsl */ `
if ( vPoolD < 0.006 ) discard;
float pT = mod( uWTime, 100.0 );
vec4 pN = texture2D( tWNoise, vPoolW.xz * 0.05 + vec2( pT * 0.004, pT * 0.003 ) );
vec3 pCol = mix( cWShallow, cWDeep, smoothstep( 0.02, 0.5, vPoolD ) );
// A rim of drying scum round the shrinking shore.
float pRim = smoothstep( 0.05, 0.0, vPoolD + ( pN.r - 0.5 ) * 0.03 );
pCol = mix( pCol, cWFoam * 0.9, pRim * 0.55 );
diffuseColor = vec4( pCol, smoothstep( 0.006, 0.05, vPoolD ) * 0.94 );
vec2 pn = ( texture2D( tWNorm, vPoolW.xz * 0.11 + vec2( pT * 0.01, 0.0 ) ).xy * 2.0 - 1.0 ) * 0.12;
// Rain stipples the surface.
pn += ( texture2D( tWNorm, vPoolW.xz * 0.9 + vec2( 0.0, pT * 0.6 ) ).xy * 2.0 - 1.0 ) * 0.35 * uRainHit;
vec3 wNw = normalize( vec3( pn.x, 1.0, pn.y ) );
float wRough = 0.06 + pRim * 0.4 + uRainHit * 0.12;
`;

function poolMaterial(level: { value: number }, rain: { value: number }): THREE.MeshStandardMaterial {
  const mat = mirrorWaterMaterial(0.06);
  const col = lakeColors('flood');
  const uniforms = {
    uPool: level,
    uRainHit: rain,
    tWNorm: { value: waterNormalTexture() },
    tWNoise: { value: waterNoiseTexture() },
    cWShallow: { value: new THREE.Color(col.shallow) },
    cWDeep: { value: new THREE.Color(col.deep) },
    cWFoam: { value: new THREE.Color(col.foam) },
    uWTime: GLOBALS.uTime,
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${POOL_VERT_PARS}`)
      .replace('#include <project_vertex>', `${POOL_VERT_MAIN}\n#include <project_vertex>`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${POOL_FRAG_PARS}`)
      .replace('#include <color_fragment>', POOL_COLOR)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = wRough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = 0.0;')
      .replace('#include <normal_fragment_maps>', 'normal = normalize( ( viewMatrix * vec4( wNw, 0.0 ) ).xyz );');
  };
  mat.customProgramCacheKey = () => 'panPool';
  return mat;
}

// ------------------------------------------------------------------------------------------------ the whole set

export interface FloodWater {
  group: THREE.Group;
  /** Set each pan's water: how deep it stands over the floor (0 hides it), and how hard rain is falling on it. */
  setPools(depth: (p: Pan) => number, rain: number): void;
  dispose(): void;
}

/** Every wash's flood ribbon (one mesh) and every pan's pool. Null where the leg has no washes. */
export function buildFloodWater(def: TerrainDef): FloodWater | null {
  const net = def.washes;
  if (!net?.ready || !net.washes.length) return null;
  const group = new THREE.Group();
  group.name = 'floodWater';
  const disposables: { dispose(): void }[] = [];
  const geo = floodRibbonGeometry(def, net);
  if (geo) {
    const mat = floodMaterial();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.renderOrder = -1;
    group.add(mesh);
    disposables.push(geo, mat);
  }
  const rain = { value: 0 };
  // A dry salt flat never holds a sheet of water, so it has no pool to draw.
  const pools = net.pans.filter((p) => !p.dry).map((p) => {
    const level = { value: 0 };
    const g = poolGeometry(def, p);
    const m = poolMaterial(level, rain);
    const mesh = new THREE.Mesh(g, m);
    mesh.receiveShadow = true;
    mesh.renderOrder = -2;
    mesh.visible = false;
    group.add(mesh);
    disposables.push(g, m);
    return { p, level, mesh };
  });
  return {
    group,
    setPools(depth, r) {
      rain.value = r;
      for (const q of pools) {
        const d = depth(q.p);
        q.level.value = d;
        q.mesh.visible = d > 0.01;
      }
    },
    dispose() {
      for (const d of disposables) d.dispose();
      group.removeFromParent();
    },
  };
}
