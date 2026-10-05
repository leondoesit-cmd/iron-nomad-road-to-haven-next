import * as THREE from 'three';
import { heightAt, roadX, type TerrainDef } from '../world/terrain';
import type { PropKind, PropSpawn } from '../world/layout';
import { MeshBuilder, S } from './builder';
import { applyKit } from './materials';
import { propProto } from './props';
import { makeRoadMaterial, ROAD_REPEAT, type TerrainUniforms } from './terrainMaterial';

/**
 * What the far landscape adds beyond the streamed chunks so the view keeps its landmarks for navigation: the paved
 * roads as plain ribbons, and the props that stand out against the sky or the ground (dead trees, big rocks,
 * containers, poles, pylons, buses) as instances of cheap stand-ins. Each prop kind is one draw call for the whole world.
 *
 * Both step aside per chunk once that chunk is fully built in detail: the green channel of the far landscape's
 * loaded-chunk mask, read in the vertex shader for props (the instance collapses to a point) and in the fragment
 * shader for roads.
 */

/** Rocks smaller than this read as a pixel or two past the streamed ring; not worth drawing. */
const MIN_ROCK = 1.5;
/** Far road ribbons are cut into pieces no longer than this, so they follow the ground between road points. */
const ROAD_STEP = 8;
/** Height of the far road over the ground: above the far terrain (laid 0.6 under), close to the detailed road. */
const ROAD_LIFT = 0.1;

/** Kinds drawn from the real prototype: few enough in the world that its full detail is cheap. */
const REAL: ReadonlySet<PropKind> = new Set<PropKind>(['pylon', 'bus', 'tram', 'tent', 'cairn']);

function rng(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const LOD_VERT_PARS = /* glsl */ `
uniform sampler2D tLoaded;
uniform vec4 uLoadedRect;
`;

const LOD_VERT = /* glsl */ `
#include <begin_vertex>
#ifdef USE_INSTANCING
{
  // The detailed chunk under this instance is built: fold the stand-in to a point so nothing rasterizes.
  vec2 lc = ( instanceMatrix[ 3 ].xz - uLoadedRect.xy ) / uLoadedRect.zw;
  if ( lc.x >= 0.0 && lc.y >= 0.0 && lc.x < 1.0 && lc.y < 1.0 && texture2D( tLoaded, lc ).g > 0.5 ) transformed = vec3( 0.0 );
}
#endif
`;

function farPropMaterial(lod: TerrainUniforms): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    applyKit(shader, false);
    Object.assign(shader.uniforms, lod);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${LOD_VERT_PARS}`)
      .replace('#include <begin_vertex>', LOD_VERT);
  };
  m.customProgramCacheKey = () => 'kit:far';
  return m;
}

// ------------------------------------------------------------------------------------------ stand-ins

function treeProxy(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  const r = rng(seed + 7);
  const bark = S.wood(0x5a4b3e, 0.35);
  const dead = S.wood(0x7a6a58, 0.3);
  // Same build as the real tree (a trunk that forks twice), at a handful of faces per limb.
  const limb = (x: number, y: number, z: number, dx: number, dy: number, dz: number, len: number, rad: number, depth: number) => {
    const m = Math.hypot(dx, dy, dz);
    const ex = x + (dx / m) * len;
    const ey = y + (dy / m) * len;
    const ez = z + (dz / m) * len;
    // A four-sided rod: no joint spheres, which are most of the real limb's faces.
    b.rod(x, y, z, ex, ey, ez, rad * 0.8, depth > 0 ? dead : bark, 4);
    if (depth >= 2) return;
    const n = depth === 0 ? 3 : 2;
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2;
      const spread = 0.55 + r() * 0.5;
      limb(ex, ey, ez, dx / m + Math.cos(a) * spread, (dy / m) * 0.7 + 0.45, dz / m + Math.sin(a) * spread, len * 0.68, rad * 0.62, depth + 1);
    }
  };
  limb(0, 0, 0, (r() - 0.5) * 0.3, 1, (r() - 0.5) * 0.3, 2.3 + r() * 0.5, 0.2, 0);
  return b;
}

function rockProxy(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  const r = rng(seed + 3);
  const tones = [0x9a6a4e, 0x8a6248, 0xa47c5a, 0x7e5c46];
  b.geo(ICO0, 0, 0.38, 0, 2.1 + r() * 0.5, 1.3 + r() * 0.3, 1.8 + r() * 0.5, S.rock(tones[seed % 4]), 0, r() * 6, 0);
  b.flatNormals();
  return b;
}
const ICO0 = new THREE.IcosahedronGeometry(0.5, 0);

const CONTAINER = [0x8a3a2c, 0x2f5a7a, 0x4a6a4a, 0xa8842c, 0x6a6a68, 0x7a4a2c];
function containerProxy(c: number): MeshBuilder {
  const b = new MeshBuilder();
  b.box(0, 1.35, 0, 2.44, 2.6, 6.06, S.paint(c, 0.9));
  return b;
}

function poleProxy(): MeshBuilder {
  const b = new MeshBuilder();
  const wood = S.wood(0x5c4632, 0.55);
  b.frustum(0, 3.6, 0, 0.11, 0.15, 7.2, wood, 0, 0, 0, 5);
  b.box(0, 6.6, 0, 2.1, 0.13, 0.12, wood);
  return b;
}

function streetlightProxy(): MeshBuilder {
  const b = new MeshBuilder();
  const metal = S.paint(0x4a4e52, 0.75);
  b.frustum(0, 3.6, 0, 0.07, 0.12, 7.2, metal, 0, 0, 0, 5);
  b.box(0.95, 7.3, 0, 1.9, 0.12, 0.14, metal);
  return b;
}

/** Which stand-in a prop gets and how many looks its kind has; null for props not worth drawing far away. */
function proxyKey(p: PropSpawn): string | null {
  switch (p.kind) {
    case 'deadTree':
      return `deadTree:${Math.abs(p.seed) % 4}`;
    case 'rock':
      return p.scale >= MIN_ROCK ? `rock:${Math.abs(p.seed) % 4}` : null;
    case 'container':
      return `container:${(p.seed + (p.tag ?? 0)) % CONTAINER.length}`;
    case 'pole':
      return 'pole';
    case 'streetlight':
      return 'streetlight';
    default:
      return REAL.has(p.kind) ? `real:${p.kind}:${Math.abs(p.seed) % 4}:${p.tag ?? 0}` : null;
  }
}

function proxyFor(key: string, p: PropSpawn): MeshBuilder {
  const [kind, a] = key.split(':');
  switch (kind) {
    case 'deadTree':
      return treeProxy(Number(a));
    case 'rock':
      return rockProxy(Number(a));
    case 'container':
      return containerProxy(CONTAINER[Number(a)]);
    case 'pole':
      return poleProxy();
    case 'streetlight':
      return streetlightProxy();
    default:
      return propProto(p.kind, p.seed, p.tag ?? 0);
  }
}

export class FarDetail {
  group = new THREE.Group();
  private geos: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];

  constructor(def: TerrainDef, props: PropSpawn[], lod: TerrainUniforms) {
    this.group.name = 'farDetail';
    this.buildProps(props, lod);
    this.buildRoads(def, lod);
  }

  private buildProps(props: PropSpawn[], lod: TerrainUniforms) {
    const groups = new Map<string, PropSpawn[]>();
    for (const p of props) {
      const k = proxyKey(p);
      if (!k) continue;
      let g = groups.get(k);
      if (!g) groups.set(k, (g = []));
      g.push(p);
    }
    if (!groups.size) return;
    const mat = farPropMaterial(lod);
    this.mats.push(mat);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const s = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    for (const [k, list] of groups) {
      const mb = proxyFor(k, list[0]);
      if (mb.empty) continue;
      const geo = mb.build();
      this.geos.push(geo);
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((p, i) => {
        // Same placement as MeshBuilder.append: yaw about +Y, uniform scale.
        q.setFromAxisAngle(up, p.yaw);
        im.setMatrixAt(i, m4.compose(v.set(p.x, p.y, p.z), q, s.setScalar(p.scale)));
      });
      im.instanceMatrix.needsUpdate = true;
      // Spread over the whole world: a bounding sphere test would keep them all anyway.
      im.frustumCulled = false;
      im.castShadow = false;
      im.receiveShadow = true;
      im.name = `far:${k}`;
      this.group.add(im);
    }
  }

  /** The paved roads as plain ribbons (the open world's network, or a corridor leg's one road). */
  private buildRoads(def: TerrainDef, lod: TerrainUniforms) {
    const paths: { half: number; pts: number[] }[] = [];
    if (def.open) {
      for (const r of def.open.roads) if (r.kind !== 'track') paths.push({ half: r.half, pts: r.pts });
    } else {
      const pts: number[] = [];
      for (let z = -600; z <= def.length + 600; z += ROAD_STEP) pts.push(roadX(def, z), z);
      paths.push({ half: def.biome === 'city' ? 0 : def.roadHalf, pts });
    }
    const pos: number[] = [];
    const nor: number[] = [];
    const uv: number[] = [];
    const tan: number[] = [];
    const idx: number[] = [];
    for (const path of paths) {
      if (path.half <= 0) continue;
      // Resample so no piece is longer than ROAD_STEP.
      const p = path.pts;
      const xs: number[] = [];
      for (let i = 0; i < p.length / 2 - 1; i++) {
        const ax = p[i * 2];
        const az = p[i * 2 + 1];
        const bx = p[i * 2 + 2];
        const bz = p[i * 2 + 3];
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / ROAD_STEP));
        for (let k = 0; k < n; k++) xs.push(ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n);
      }
      xs.push(p[p.length - 2], p[p.length - 1]);
      const n = xs.length / 2;
      let arc = 0;
      for (let i = 0; i < n; i++) {
        const x = xs[i * 2];
        const z = xs[i * 2 + 1];
        if (i > 0) arc += Math.hypot(x - xs[i * 2 - 2], z - xs[i * 2 - 1]);
        const a = Math.max(0, i - 1);
        const b = Math.min(n - 1, i + 1);
        let tx = xs[b * 2] - xs[a * 2];
        let tz = xs[b * 2 + 1] - xs[a * 2 + 1];
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl;
        tz /= tl;
        const base = pos.length / 3;
        for (const u of [0, 0.5, 1]) {
          const off = (u - 0.5) * 2 * path.half;
          const px = x + off * tz;
          const pz = z - off * tx;
          pos.push(px, heightAt(def, px, pz) + ROAD_LIFT, pz);
          nor.push(0, 1, 0);
          uv.push(u, arc / ROAD_REPEAT);
          tan.push(tz, 0, -tx);
        }
        if (i < n - 1) for (let c = 0; c < 2; c++) idx.push(base + c, base + 3 + c, base + c + 1, base + c + 1, base + 3 + c, base + 3 + c + 1);
      }
    }
    if (!idx.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('rtan', new THREE.Float32BufferAttribute(tan, 3));
    g.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    this.geos.push(g);
    const mat = makeRoadMaterial(def.biome, lod);
    this.mats.push(mat);
    const m = new THREE.Mesh(g, mat);
    m.frustumCulled = false;
    m.receiveShadow = true;
    m.name = 'far:roads';
    this.group.add(m);
  }

  dispose() {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    this.group.removeFromParent();
  }
}
