import * as THREE from 'three';
import { GLOBALS } from './materials';
import { mirrorWaterMaterial, waterNoiseTexture, waterNormalTexture } from './water';
import { lakeColors } from '../world/lakes';
import { heightAt, type TerrainDef } from '../world/terrain';
import { nearestRoad } from '../world/openWorld';
import { RIFFLE_HALF, type Hydro, type River, type Waterfall } from '../world/hydro';
import { clamp, lerp, smoothstep } from '../core/math';

/**
 * Running water: every river and stream of the open world as one ribbon mesh, and every waterfall as one more.
 *
 * The ribbon follows each course's centre-line sample by sample. A cross-section is seven vertices: the waterline on each
 * side, three across the channel between them, and one a metre and a half out over each bank, which the banks hide by the
 * depth test. It is flat across (the water level of that sample), so the channel cut into the terrain shapes the water's
 * edge exactly as it shapes the ground. Each vertex carries the depth of water under it, how far across the channel it is,
 * a travel-time coordinate along the flow and the current's speed, so the shader can scroll ripples down the stream at
 * the speed the water actually runs, fade the waterline and whiten the shallows, the rapids and the boil under a fall.
 *
 * The steep runs of a course (the falls) are left out of the ribbon and drawn by the falls mesh instead: a sheet down the
 * drop that leaves the lip in a short arc, a veil of streaks just in front of it, and a ring of spray standing in the
 * plunge pool. Falling water is white and rough and must not mirror anything, so it has its own material and blend.
 */

/** Samples drawn past `end`, into whatever the course runs into: there the ribbon sinks under that water and fades out. */
const PAST_END = 4;
/** How far the ribbon reaches out over each bank. */
const BANK_PAD = 1.5;
/** And further out over the floodplain, hidden under the ground until the river rises over it. */
const FLOOD_PAD = 8;
/** Vertices across a ribbon cross-section. */
export const RIBBON_NX = 9;
const NX = RIBBON_NX;
/** Rivers whose rise the shader knows (`RIVER_RISE.uRise`). */
export const MAX_RIVERS = 8;

/**
 * How high each river runs over its normal level (metres, by river id) and how much flood silt it carries (0..1). The leg
 * scene sets these every frame from the day's hydrograph; the ribbon's vertex shader lifts the water by them.
 */
export const RIVER_RISE = {
  uRise: { value: new Float32Array(MAX_RIVERS) },
  uMurk: { value: 0 },
};

/**
 * How much of a river's rise reaches a sample: none where it runs into a lake or swamp (whose level stays put), out of a
 * spring pool or near a fall (whose sheet stands still), all of it everywhere else. The physics asks the same.
 */
export function riseTaper(hy: Hydro, r: River, i: number): number {
  let k = 1 - smoothstep(r.end - 14, r.end - 2, i);
  if (r.spring >= 0) k *= smoothstep(4, 18, i);
  for (const f of hy.falls) {
    if (f.river !== r.id) continue;
    const d = i < f.i0 ? f.i0 - i : i > f.i1 ? i - f.i1 : 0;
    k *= smoothstep(1, 10, d);
  }
  return k;
}
/** How far the ribbon sinks where it meets standing water at the same level, so that water's sheet wins the depth test. */
const SINK = 0.06;
/** Every scrolling coordinate repeats a whole number of texture tiles in this many seconds, so time can wrap. */
const PERIOD = 100;
/** Free fall. The speed the water leaves a lip with, straight down. */
const G = 9.8;
const V0 = 1.5;

export interface RibbonCourse {
  river: number;
  /** First vertex of the course in the merged geometry, and how many cross-sections it has (NX vertices each). */
  first: number;
  rows: number;
}

export interface RibbonData {
  geometry: THREE.BufferGeometry;
  courses: RibbonCourse[];
}

/** Across offsets of a cross-section, metres from the centre-line, for a half-width `h`. */
function acrossOffsets(h: number): number[] {
  return [-(h + FLOOD_PAD), -(h + BANK_PAD), -h, -0.55 * h, 0, 0.55 * h, h, h + BANK_PAD, h + FLOOD_PAD];
}

/**
 * How hard the water boils below each sample: the plunge pool of a fall foams for a distance that grows with its height.
 * Exported for the effects that want the same numbers.
 */
export function plungeChurn(hy: Hydro, r: River): Float32Array {
  const out = new Float32Array(r.n);
  for (const f of hy.falls) {
    if (f.river !== r.id) continue;
    const H = f.top - f.bottom;
    const strength = clamp(0.35 + H / 10, 0.35, 1);
    const L = 4 + H * 0.35;
    for (let i = f.i1; i < r.n; i++) {
      const ds = r.s[i] - r.s[f.i1];
      if (ds > L * 4) break;
      out[i] = Math.max(out[i], strength * Math.exp(-ds / L));
    }
  }
  return out;
}

/** How white the water runs over each sample's riffle stones (0..1). */
export function riffleChurn(hy: Hydro, r: River): Float32Array {
  const out = new Float32Array(r.n);
  for (const q of hy.riffles) {
    if (q.river !== r.id) continue;
    const L = RIFFLE_HALF + 3;
    for (let k = -L; k <= L; k++) {
      const j = q.i + k;
      if (j < 0 || j >= r.n) continue;
      // White just over and below the stones, where the run tumbles off them, and calm again a few metres on.
      out[j] = Math.max(out[j], 0.5 * Math.exp(-(((k - 1.5) / (L * 0.28)) ** 2)));
    }
  }
  return out;
}

/** Segments of a course (by their first sample) that belong to a fall and are drawn by the falls mesh. */
function steepSegments(hy: Hydro, r: River): Uint8Array {
  const out = new Uint8Array(r.n);
  for (const f of hy.falls) if (f.river === r.id) for (let i = f.i0; i < f.i1; i++) out[i] = 1;
  return out;
}

/**
 * The ribbon geometry of every course, merged. Attributes besides position and normal:
 * `aFlow` (metres across the channel, travel time down the course in seconds, depth of water, current in m/s),
 * `aDir` (flow direction x, z; how steeply the level drops, m/m; plunge-pool churn 0..1),
 * `aFade` (opacity, 0 where the course has run into other water; how far the far-view lift may raise it).
 */
export function riverRibbonGeometry(def: TerrainDef): RibbonData | null {
  const hy = def.hydro;
  if (!hy?.ready || !hy.rivers.length) return null;
  const hit = ribbonCache.get(hy);
  if (hit) return { geometry: geometryFrom(hit, 2.6), courses: hit.courses! };
  const o = def.open;
  let rowsTotal = 0;
  for (const r of hy.rivers) rowsTotal += Math.min(r.n - 1, r.end + PAST_END) + 1;
  const V = rowsTotal * NX;
  const pos = new Float32Array(V * 3);
  const nrm = new Float32Array(V * 3);
  const flow = new Float32Array(V * 4);
  const dir = new Float32Array(V * 4);
  const fade = new Float32Array(V * 2);
  const rise = new Float32Array(V * 2);
  const idx: number[] = [];
  const courses: RibbonCourse[] = [];
  let v = 0;
  for (const r of hy.rivers) {
    const last = Math.min(r.n - 1, r.end + PAST_END);
    const churn = plungeChurn(hy, r);
    const rif = riffleChurn(hy, r);
    for (let i = 0; i < r.n; i++) churn[i] = Math.max(churn[i], rif[i]);
    const steep = steepSegments(hy, r);
    const sp = r.spring >= 0 ? hy.springs[r.spring] : null;
    const first = v;
    let tau = 0;
    for (let i = 0; i <= last; i++) {
      if (i > 0) tau += (r.s[i] - r.s[i - 1]) / Math.max(0.2, 0.5 * (r.speed[i] + r.speed[i - 1]));
      // Into a lake, swamp or river at the same level: sink under its sheet and fade out.
      const into = smoothstep(r.end - 2, r.end + 1, i);
      let alpha = 1 - smoothstep(r.end, r.end + PAST_END, i);
      let sink = SINK * into;
      let lift = 1 - smoothstep(r.end - 6, r.end, i);
      if (sp) {
        // Out of a spring pool: the pool's own sheet covers the first metres.
        const inPool = 1 - smoothstep(sp.r - 1, sp.r + 1.5, Math.hypot(r.x[i] - sp.x, r.z[i] - sp.z));
        sink = Math.max(sink, SINK * inPool);
        alpha *= 1 - inPool * 0.85;
        lift = Math.min(lift, 1 - inPool);
      }
      const y = r.level[i] - sink;
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(r.n - 1, i + 1);
      const drop = clamp((r.level[i0] - r.level[i1]) / Math.max(0.5, r.s[i1] - r.s[i0]), 0, 1);
      const h = r.half[i];
      const nx = -r.dz[i];
      const nz = r.dx[i];
      const us = acrossOffsets(h);
      const taper = riseTaper(hy, r, i);
      for (let k = 0; k < NX; k++) {
        const u = us[k];
        const x = r.x[i] + nx * u;
        const z = r.z[i] + nz * u;
        let depth: number;
        // Where a road crosses on its causeway the water runs on underneath, in the channel's own shape (the causeway hides it).
        const rd = o ? nearestRoad(o, x, z) : null;
        const causeway = !!rd?.road && rd.road.kind !== 'track' && rd.edge < 5;
        if (causeway) {
          const a = Math.abs(u) / h;
          depth = a < 1 ? r.depth[i] * Math.pow(1 - a * a, 0.7) : -(Math.abs(u) - h) * 0.4;
        } else depth = r.level[i] - heightAt(def, x, z);
        pos[v * 3] = x;
        pos[v * 3 + 1] = y;
        pos[v * 3 + 2] = z;
        nrm[v * 3 + 1] = 1;
        flow[v * 4] = u;
        flow[v * 4 + 1] = tau;
        flow[v * 4 + 2] = depth;
        flow[v * 4 + 3] = r.speed[i];
        dir[v * 4] = r.dx[i];
        dir[v * 4 + 1] = r.dz[i];
        dir[v * 4 + 2] = drop;
        dir[v * 4 + 3] = churn[i];
        fade[v * 2] = alpha;
        // The floodplain edge never lifts for the far view: it would stand up out of the banks.
        fade[v * 2 + 1] = k === 0 || k === NX - 1 ? 0 : lift;
        rise[v * 2] = r.id;
        rise[v * 2 + 1] = taper;
        v++;
      }
    }
    // Quads between cross-sections, wound to face up; the falls' segments are the falls mesh's.
    for (let i = 0; i < last; i++) {
      if (steep[i]) continue;
      const a = first + i * NX;
      const b = a + NX;
      for (let k = 0; k < NX - 1; k++) idx.push(a + k, a + k + 1, b + k, a + k + 1, b + k + 1, b + k);
    }
    courses.push({ river: r.id, first, rows: last + 1 });
  }
  const data: MeshArrays = {
    attrs: { position: [pos, 3], normal: [nrm, 3], aFlow: [flow, 4], aDir: [dir, 4], aFade: [fade, 2], aRise: [rise, 2] },
    index: Uint32Array.from(idx),
    courses,
  };
  ribbonCache.set(hy, data);
  return { geometry: geometryFrom(data, 2.6), courses };
}

/**
 * The arrays a mesh is made from, kept per water network: the leg scene is built again every dawn on the same terrain, and
 * there is no need to walk every course again.
 */
interface MeshArrays {
  attrs: Record<string, [Float32Array, number]>;
  index: Uint32Array;
  courses?: RibbonCourse[];
}
const ribbonCache = new WeakMap<Hydro, MeshArrays>();
const fallCache = new WeakMap<Hydro, MeshArrays>();

/** A geometry over cached arrays, with its bounds and room above them for what the vertex shader adds. */
function geometryFrom(d: MeshArrays, lift: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const [name, [arr, size]] of Object.entries(d.attrs)) g.setAttribute(name, new THREE.BufferAttribute(arr, size));
  g.setIndex(new THREE.BufferAttribute(d.index, 1));
  g.computeBoundingBox();
  const box = g.boundingBox!;
  box.max.y += lift;
  g.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
  return g;
}

// ------------------------------------------------------------------------------------------------ falls

/** Where a fall leaves its lip and where it lands, for the mist, the sound and the map. */
export interface FallSpot {
  name: string;
  rim: boolean;
  /** Height of the drop, and half the width of the water going over. */
  height: number;
  half: number;
  /** Direction of flow over the lip. */
  dx: number;
  dz: number;
  /** The lip, on the water. */
  lip: [number, number, number];
  /** The middle of the plunge pool, on the water, where the spray stands. */
  foot: [number, number, number];
  /** Radius and height of the spray standing over the foot. */
  sprayR: number;
  sprayH: number;
}

/** Every waterfall's lip and foot. Pure: no three.js objects. */
export function waterfallSpots(hy: Hydro): FallSpot[] {
  const out: FallSpot[] = [];
  for (const f of hy.falls) {
    const r = hy.rivers[f.river];
    const H = f.top - f.bottom;
    const j = Math.min(f.i1, r.n - 1);
    const ahead = 0.4 + Math.min(H, 20) * 0.06;
    out.push({
      name: f.name,
      rim: f.rim,
      height: H,
      half: f.half,
      dx: f.dx,
      dz: f.dz,
      lip: [f.x, f.top, f.z],
      foot: [r.x[j] + r.dx[j] * ahead, f.bottom, r.z[j] + r.dz[j] * ahead],
      sprayR: r.half[j] * 0.8 + Math.min(H, 40) * 0.015,
      sprayH: 0.7 + Math.min(H, 40) * 0.13,
    });
  }
  return out;
}

/** A point down a fall: `p` 0 at the lip to 1 at the foot, along the course's samples. */
function fallPoint(r: River, f: Waterfall, p: number) {
  const segs = f.i1 - f.i0;
  const fi = f.i0 + p * segs;
  const i = Math.min(f.i1 - 1, Math.floor(fi));
  const t = fi - i;
  let dx = lerp(r.dx[i], r.dx[i + 1], t);
  let dz = lerp(r.dz[i], r.dz[i + 1], t);
  const dl = Math.hypot(dx, dz) || 1;
  dx /= dl;
  dz /= dl;
  const H = f.top - f.bottom;
  const yLin = lerp(r.level[i], r.level[i + 1], t);
  // Water leaves a lip moving forward, so it falls in an arc that stands off the face below; a single step arcs more
  // than a long fall down a cliff, which mostly clings to the rock.
  const yArc = f.top - H * p * p;
  const y = Math.max(yLin, lerp(yLin, yArc, segs === 1 ? 0.6 : 0.3));
  return { x: lerp(r.x[i], r.x[i + 1], t), z: lerp(r.z[i], r.z[i + 1], t), y, dx, dz, half: lerp(r.half[i], r.half[i + 1], t) };
}

/** Seconds since leaving the lip, `d` metres down. */
const fallTime = (d: number) => (-V0 + Math.sqrt(V0 * V0 + 2 * G * Math.max(0, d))) / G;

/** Noise tiles per metre across a fall, in the shader. The spray's ring is sized to a whole number of them. */
const FALL_ACROSS = 0.22;

/**
 * Every fall merged: the sheet (kind 0), the veil (1) and the spray ring (2). Attributes besides position and normal:
 * `aFall` (across: -1..1 at the edges of the sheet; seconds of fall; 0 at the lip to 1 at the foot; kind),
 * `aFall2` (height of the fall; metres per unit of `aFall.x`; flow direction x, z).
 */
export function fallsGeometry(def: TerrainDef): THREE.BufferGeometry | null {
  const hy = def.hydro;
  if (!hy?.ready || !hy.falls.length) return null;
  const hit = fallCache.get(hy);
  if (hit) return geometryFrom(hit, 0);
  const pos: number[] = [];
  const fa: number[] = [];
  const fb: number[] = [];
  const idx: number[] = [];
  const spots = waterfallSpots(hy);
  const grid = (rows: number, cols: number, base: number) => {
    for (let j = 0; j < rows - 1; j++) {
      for (let k = 0; k < cols - 1; k++) {
        const a = base + j * cols + k;
        const b = a + cols;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
  };
  hy.falls.forEach((f, fi) => {
    const r = hy.rivers[f.river];
    const H = f.top - f.bottom;
    const rows = clamp(Math.round(H / 1.1) + 3, 4, 34);
    // The sheet.
    const SHEET = [-1.12, -0.75, -0.38, 0, 0.38, 0.75, 1.12];
    let base = pos.length / 3;
    for (let j = 0; j < rows; j++) {
      const p = j / (rows - 1);
      const q = fallPoint(r, f, p);
      const w = q.half * (1 + 0.12 * p);
      const T = fallTime(f.top - q.y);
      for (const a of SHEET) {
        pos.push(q.x - q.dz * a * w, q.y, q.z + q.dx * a * w);
        fa.push(a, T, p, 0);
        fb.push(H, w, q.dx, q.dz);
      }
    }
    grid(rows, SHEET.length, base);
    // The veil: streaks a little in front of the sheet, spreading as they fall, running on into the pool.
    const VEIL = [-1, -0.5, 0, 0.5, 1];
    const big = H > 8;
    base = pos.length / 3;
    const vRows = rows + 1;
    for (let j = 0; j < vRows; j++) {
      const p = Math.min(1, j / (rows - 1));
      const q = fallPoint(r, f, p);
      const over = j === vRows - 1;
      const fwd = (big ? 0.5 + 1.6 * p : 0.2 + 0.45 * p) + (over ? 0.4 : 0);
      const y = q.y - 0.1 - (over ? 0.6 : 0);
      const w = q.half * (0.92 + 0.28 * p);
      const T = fallTime(f.top - y);
      for (const a of VEIL) {
        pos.push(q.x + q.dx * fwd - q.dz * a * w, y, q.z + q.dz * fwd + q.dx * a * w);
        fa.push(a, T, over ? 1.08 : p, 1);
        fb.push(H, w, q.dx, q.dz);
      }
    }
    grid(vRows, VEIL.length, base);
    // Spray: a ring standing in the plunge pool, wider at the top.
    const s = spots[fi];
    const SEG = 16;
    const around = Math.max(1, Math.round(2 * Math.PI * s.sprayR * FALL_ACROSS)) / FALL_ACROSS;
    base = pos.length / 3;
    for (const p of [0, 0.45, 1]) {
      const R = s.sprayR * (1 + 0.35 * p);
      const y = s.foot[1] - 0.25 + p * s.sprayH;
      for (let a = 0; a <= SEG; a++) {
        const th = (a / SEG) * Math.PI * 2;
        pos.push(s.foot[0] + Math.cos(th) * R, y, s.foot[2] + Math.sin(th) * R);
        fa.push((a / SEG) * around, (y - s.foot[1]) / 1.6, p, 2);
        fb.push(H, 1, f.dx, f.dz);
      }
    }
    grid(3, SEG + 1, base);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const data: MeshArrays = {
    attrs: { position: [Float32Array.from(pos), 3], normal: [g.getAttribute('normal').array as Float32Array, 3], aFall: [Float32Array.from(fa), 4], aFall2: [Float32Array.from(fb), 4] },
    index: Uint32Array.from(idx),
  };
  g.dispose();
  fallCache.set(hy, data);
  return geometryFrom(data, 0);
}

// ------------------------------------------------------------------------------------------------ shaders

const COMMON_PARS = /* glsl */ `
uniform sampler2D tWNorm;
uniform sampler2D tWNoise;
uniform vec3 cWShallow;
uniform vec3 cWDeep;
uniform vec3 cWFoam;
uniform float uWTime;
`;

const RIVER_VERT_PARS = /* glsl */ `
attribute vec4 aFlow;
attribute vec4 aDir;
attribute vec2 aFade;
attribute vec2 aRise;
uniform float uRise[ ${MAX_RIVERS} ];
uniform float uSilt[ ${MAX_RIVERS} ];
varying vec3 vWWorld;
varying vec4 vFlow;
varying vec4 vDir;
varying float vFade;
varying float vSilt;
`;

const RIVER_VERT_MAIN = /* glsl */ `
vFlow = aFlow;
vDir = aDir;
vFade = aFade.x;
vSilt = uSilt[ int( aRise.x + 0.5 ) ];
{
  // A river in flood: the whole surface stands higher (and out over the floodplain), deeper and quicker.
  float rRise = uRise[ int( aRise.x + 0.5 ) ] * aRise.y;
  transformed.y += rRise;
  vFlow.z += rRise;
  vFlow.w *= 1.0 + rRise * 0.9;
}
vWWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
// Beyond the streamed chunks the coarse far terrain lies a little proud of the water along the banks: lift the water
// clear of it there. The edges stay where they were, since the waterline comes from the depth, not the mesh.
transformed.y += smoothstep( 240.0, 420.0, distance( vWWorld.xz, cameraPosition.xz ) ) * 0.7 * aFade.y;
`;

const RIVER_FRAG_PARS = /* glsl */ `
uniform float uMurk;
varying vec3 vWWorld;
varying vec4 vFlow;
varying vec4 vDir;
varying float vFade;
varying float vSilt;
${COMMON_PARS}
`;

const RIVER_COLOR = /* glsl */ `
float rD = vFlow.z;
if ( rD < 0.015 || vFade < 0.01 ) discard;
vec2 wp = vWWorld.xz;
vec2 rF = normalize( vDir.xy );
vec2 rAc = vec2( - rF.y, rF.x );
float rSpd = vFlow.w;
float rChurn = vDir.w;
float rT = mod( uWTime, ${PERIOD.toFixed(1)} );
// Water space: metres across, and down the flow a travel time that moves with the current. It runs at the local speed,
// so fast water stretches the ripples and the foam into streaks.
vec2 rp = vec2( vFlow.x, vFlow.y - rT );
float rRapid = clamp( smoothstep( 1.1, 2.8, rSpd ) + smoothstep( 0.02, 0.22, vDir.z ) + rChurn * 0.8, 0.0, 1.0 );
vec2 rn1 = texture2D( tWNorm, rp * vec2( 0.13, 0.1 ) ).xy * 2.0 - 1.0;
vec2 rn2 = texture2D( tWNorm, rp * vec2( 0.31, 0.25 ) + 0.41 ).xy * 2.0 - 1.0;
vec2 rn3 = texture2D( tWNorm, wp * 0.6 + vec2( rT * 0.03, - rT * 0.02 ) ).xy * 2.0 - 1.0;
vec2 rnF = ( rn1 * 0.55 + rn2 * 0.4 ) * ( 0.3 + rRapid * 0.55 );
vec2 rn = rAc * rnF.x + rF * rnF.y + rn3 * ( 0.07 + rChurn * 0.25 );
vec3 wNw = normalize( vec3( rn.x, 1.0, rn.y ) );
float rDeep = smoothstep( 0.1, 2.6, rD );
vec3 wCol = mix( cWShallow, cWDeep, rDeep );
// A lowland river's own silt and algae: an opaque olive-grey, greener in the deep, whatever the weather.
wCol = mix( wCol, mix( vec3( 0.2, 0.18, 0.115 ), vec3( 0.085, 0.085, 0.052 ), smoothstep( 0.05, 1.2, rD ) ), vSilt );
// Flood silt: the river runs the colour of the desert it has washed off, and the foam goes dirty.
wCol = mix( wCol, mix( vec3( 0.42, 0.32, 0.2 ), vec3( 0.26, 0.19, 0.12 ), rDeep ), uMurk * 0.85 );
rRapid = clamp( rRapid + uMurk * 0.35, 0.0, 1.0 );
// Foam: a lace along the banks and over the shallows, streaks in fast water, and the boil under a fall.
vec4 rN = texture2D( tWNoise, rp * vec2( 0.07, 0.04 ) );
vec4 rN2 = texture2D( tWNoise, rp * vec2( 0.19, 0.12 ) + 0.27 );
vec4 rN3 = texture2D( tWNoise, wp * 0.11 + vec2( rT * 0.07, - rT * 0.05 ) );
float rBank = smoothstep( 0.4, 0.0, rD + ( rN.r - 0.5 ) * 0.35 ) * ( 0.4 + 0.45 * rRapid );
float rStreak = smoothstep( 0.8 - 0.32 * rRapid, 0.95 - 0.22 * rRapid, rN.g * 0.6 + rN2.r * 0.4 ) * ( 0.2 + 0.8 * rRapid );
float rBoil = rChurn * smoothstep( 0.62 - 0.4 * rChurn, 0.78 - 0.2 * rChurn, rN2.g * 0.45 + rN3.b * 0.55 );
float wFoam = clamp( max( max( rBank, rStreak ), rBoil ), 0.0, 1.0 );
// Sunlight glinting through the shallows.
wCol *= 1.0 + ( rN3.r * rN2.b ) * 0.55 * ( 1.0 - rDeep );
wCol = mix( wCol, mix( mix( cWFoam, vec3( 0.78, 0.76, 0.66 ), vSilt * 0.6 ), vec3( 0.7, 0.6, 0.46 ), uMurk ), wFoam * 0.92 );
// Clear enough to see the cobbles, the weed and the fish down to a metre or two; a flood's silt makes it opaque.
float wA = mix( 0.26, 0.95, smoothstep( 0.05, 3.4, rD ) ) * smoothstep( 0.015, 0.14, rD );
wA = mix( wA, max( wA, 0.94 * smoothstep( 0.015, 0.2, rD ) ), max( uMurk, vSilt ) );
wA = max( wA, wFoam * 0.9 * smoothstep( 0.015, 0.06, rD ) ) * vFade;
diffuseColor = vec4( wCol, wA );
float wRough = mix( 0.05, 0.5, wFoam ) + rRapid * 0.05;
`;

const FALL_VERT_PARS = /* glsl */ `
attribute vec4 aFall;
attribute vec4 aFall2;
varying vec4 vFall;
varying vec4 vFall2;
`;

const FALL_VERT_MAIN = /* glsl */ `
vFall = aFall;
vFall2 = aFall2;
{
  // Beyond the streamed chunks the coarse far terrain can stand in front of a fall in its notch: draw it a little nearer
  // the eye there (along the line of sight, so it stays where it was on screen).
  vec3 fW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  float fd = distance( fW, cameraPosition );
  transformed += ( cameraPosition - fW ) * smoothstep( 230.0, 480.0, fd ) * min( 0.025, 14.0 / max( fd, 1.0 ) );
}
`;

const FALL_FRAG_PARS = /* glsl */ `
varying vec4 vFall;
varying vec4 vFall2;
uniform vec3 uLight;
${COMMON_PARS}
`;

const FALL_COLOR = /* glsl */ `
float fK = vFall.w;
float fu = vFall.x;
float fp = vFall.z;
float rT = mod( uWTime, ${PERIOD.toFixed(1)} );
// Down the fall the pattern moves with the water, which speeds up as it drops: tight ripples at the lip, long streaks below.
vec2 fq = vec2( fu * vFall2.y * ${FALL_ACROSS.toFixed(2)}, ( vFall.y - rT ) * 0.6 );
float fn = texture2D( tWNoise, fq ).r * 0.6 + texture2D( tWNoise, fq * vec2( 2.0, 1.5 ) + 0.5 ).g * 0.4;
float fn2 = texture2D( tWNoise, fq * vec2( 3.1, 2.0 ) + 0.13 ).b;
// Ragged edges, not a ruled strip.
float fEdge = 1.0 - smoothstep( 0.5 + 0.25 * fn + 0.2 * fn2, 1.1, abs( fu ) );
vec3 wCol;
float wA;
if ( fK < 0.5 ) {
  // The sheet: glassy as it bends over the lip, then ropes of white water with thinner, darker water between them. A short
  // step stays glassier than a tall fall, which is white long before the foot.
  float fAer = smoothstep( 0.0, 0.3, fp ) * clamp( vFall2.x / 7.0, 0.4, 1.0 );
  float fRope = smoothstep( 0.4, 0.62, fn ) * 0.75 + fn2 * 0.25;
  vec3 fThin = mix( cWDeep, cWShallow, 0.55 );
  wCol = mix( mix( cWShallow * 1.1, fThin, fAer ), cWFoam * ( 0.85 + 0.25 * fn2 ), clamp( fAer * ( 0.3 + 0.85 * fRope ), 0.0, 1.0 ) );
  wCol += cWFoam * ( 1.0 - smoothstep( 0.0, 0.06, fp ) ) * 0.25;
  wA = mix( 0.7, 0.97, fAer * fRope ) * fEdge;
} else if ( fK < 1.5 ) {
  // The veil: loose streaks falling in front.
  float fS = smoothstep( 0.52, 0.7, fn );
  wCol = cWFoam * ( 0.85 + 0.25 * fn2 );
  wA = fS * 0.7 * fEdge * smoothstep( 0.04, 0.2, fp ) * ( 1.0 - smoothstep( 0.98, 1.08, fp ) );
} else {
  // The spray standing in the pool: clots of white boiling up, thinning as they rise.
  float fB = texture2D( tWNoise, fq * vec2( 1.0, 0.7 ) + vec2( 0.0, rT * 0.11 ) ).b;
  wCol = cWFoam * ( 0.9 + 0.15 * fn2 );
  wA = smoothstep( 0.45, 0.68, fn * 0.6 + fB * 0.4 ) * 0.55 * pow( 1.0 - clamp( fp, 0.0, 1.0 ), 1.6 ) * smoothstep( 0.0, 0.12, fp );
}
if ( wA < 0.01 ) discard;
diffuseColor = vec4( wCol, wA );
`;

const FALL_NORMAL = /* glsl */ `
{
  vec3 fAc = normalize( ( viewMatrix * vec4( - vFall2.w, 0.0, vFall2.z, 0.0 ) ).xyz );
  normal = normalize( normal + fAc * ( fn - 0.5 ) * 0.8 );
}
`;

function colourUniforms() {
  const col = lakeColors('river');
  return {
    tWNorm: { value: waterNormalTexture() },
    tWNoise: { value: waterNoiseTexture() },
    cWShallow: { value: new THREE.Color(col.shallow) },
    cWDeep: { value: new THREE.Color(col.deep) },
    cWFoam: { value: new THREE.Color(col.foam) },
    uWTime: GLOBALS.uTime,
  };
}

/** Each river's own cloudiness (`WaterCourseSpec.silt`), by river id. */
function siltOf(hy: Hydro): Float32Array {
  const out = new Float32Array(MAX_RIVERS);
  for (const r of hy.rivers) if (r.id < MAX_RIVERS) out[r.id] = clamp(hy.spec.rivers.find((c) => c.id === r.key)?.silt ?? 0, 0, 1);
  return out;
}

function riverMaterial(hy: Hydro): THREE.MeshStandardMaterial {
  const mat = mirrorWaterMaterial();
  const uniforms = { ...colourUniforms(), ...RIVER_RISE, uSilt: { value: siltOf(hy) } };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${RIVER_VERT_PARS}`)
      .replace('#include <project_vertex>', `${RIVER_VERT_MAIN}\n#include <project_vertex>`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${RIVER_FRAG_PARS}`)
      .replace('#include <color_fragment>', RIVER_COLOR)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = wRough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = 0.0;')
      .replace('#include <normal_fragment_maps>', 'normal = normalize( ( viewMatrix * vec4( wNw, 0.0 ) ).xyz );');
  };
  mat.customProgramCacheKey = () => 'riverWater';
  return mat;
}

/**
 * Falling water. Colour blends as usual, but alpha adds: whatever lies behind, the reflection pass then reads the fall as
 * matte (gloss.ts), since white water mirrors nothing. It writes no depth, so the veil and the spray layer over the sheet.
 */
function fallMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.5,
    metalness: 0,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  const uniforms = { ...colourUniforms(), uLight: GLOBALS.uLight };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${FALL_VERT_PARS}`)
      .replace('#include <project_vertex>', `${FALL_VERT_MAIN}\n#include <project_vertex>`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FALL_FRAG_PARS}`)
      .replace('#include <color_fragment>', FALL_COLOR)
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = 0.0;')
      .replace('#include <normal_fragment_maps>', FALL_NORMAL)
      // Broken water scatters light through itself: it stays bright in the shade of its own cliff.
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * uLight * 0.12;');
  };
  mat.customProgramCacheKey = () => 'fallWater';
  return mat;
}

export interface RiverWater {
  group: THREE.Group;
  /** The two meshes (either may be missing): the ribbon of every course, and the falls. */
  river: THREE.Mesh | null;
  falls: THREE.Mesh | null;
  dispose(): void;
}

/** Every river, stream and waterfall of the leg: two draw calls. Null off the open world. */
export function buildRiverWater(def: TerrainDef): RiverWater | null {
  const ribbon = riverRibbonGeometry(def);
  const fallGeo = fallsGeometry(def);
  if (!ribbon && !fallGeo) return null;
  const group = new THREE.Group();
  group.name = 'riverWater';
  const mats: THREE.Material[] = [];
  let river: THREE.Mesh | null = null;
  let falls: THREE.Mesh | null = null;
  if (ribbon) {
    const m = riverMaterial(def.hydro!);
    mats.push(m);
    river = new THREE.Mesh(ribbon.geometry, m);
    river.receiveShadow = true;
    // After the standing water, which it sinks under where they meet; before anything else see-through.
    river.renderOrder = -1;
    group.add(river);
  }
  if (fallGeo) {
    const m = fallMaterial();
    mats.push(m);
    falls = new THREE.Mesh(fallGeo, m);
    falls.receiveShadow = true;
    falls.renderOrder = -0.5;
    group.add(falls);
  }
  return {
    group,
    river,
    falls,
    dispose() {
      ribbon?.geometry.dispose();
      fallGeo?.dispose();
      for (const m of mats) m.dispose();
      group.removeFromParent();
    },
  };
}
