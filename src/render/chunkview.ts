import * as THREE from 'three';
import { MeshBuilder, S } from './builder';
import { appendProp } from './props';
import { appendLandmark, LANDMARK_KINDS } from './landmarks';
import { propCollisionMesh } from './propCollision';
import { C } from './palette';
import { makePavingMaterial, makeRoadMaterial, makeTerrainMaterial, ROAD_REPEAT, type GroundTheme } from './terrainMaterial';
import { FacadeBuilder, facadeMaterial } from './facade';
import { crate, plate, spareTyre } from './parts';
import { buildScatterSteps, type ScatterSet } from './scatter';
import { kitMaterial } from './materials';
import { SHOP_H, SHOP_W, shopFrontMaterial, type ShopId } from './shopFront';
import { buildSignGeometries } from './signs';
import { CELL, CELLS, CHUNK, corridorHalf, heightAt, normalAt, roadX, surfaceAt, waterAt, type TerrainDef } from '../world/terrain';
import { nearestRoad, type RoadPath } from '../world/openWorld';
import type { BuildingSpec, ChunkData } from '../world/chunkgen';
import type { Aabb } from '../world/layout';
import { facadeStyleOf } from '../world/shopGlass';
import { PaneSet } from './glass';
import { BOULEVARD_HALF, SIDEWALK } from '../world/layout';
import { GROUPS, type Collider, type PhysicsWorld } from '../physics/physics';
import { hash2, noise2 } from '../core/rng';
import { smoothstep } from '../core/math';
import { shoreShade } from '../world/lakes';

export interface ChunkMaterials {
  terrain: THREE.Material;
  props: THREE.Material;
  walls: THREE.MeshStandardMaterial;
  roofs: THREE.Material;
  road: THREE.Material;
}

export function makeChunkMaterials(biome: 'wasteland' | 'city', theme?: GroundTheme): ChunkMaterials {
  return {
    terrain: makeTerrainMaterial(biome, undefined, theme),
    props: kitMaterial(),
    walls: facadeMaterial(),
    roofs: kitMaterial(),
    road: makeRoadMaterial(biome),
  };
}

/** Free the per-leg materials and textures (shared kit materials and cached textures stay). */
export function disposeChunkMaterials(mats: ChunkMaterials) {
  for (const m of [mats.terrain, mats.props, mats.walls, mats.roofs, mats.road]) {
    if (m.userData.shared) continue;
    const mm = m as THREE.MeshStandardMaterial;
    if (mm.map && !mm.map.userData.shared) mm.map.dispose();
    m.dispose();
  }
}

let paving: THREE.MeshStandardMaterial | null = null;
const pavingMaterial = () => {
  if (!paving) {
    paving = makePavingMaterial();
    paving.userData.shared = true;
  }
  return paving;
};

export interface ChunkOpts {
  /** Ground cover density, 0..1 (quality setting). */
  scatter: number;
  /**
   * Build only the ground, roads and colliders at once and leave buildings, props and ground cover to `buildNext`, one
   * stage per call. A whole chunk costs 10 ms or so; spread over a few ticks it never costs a frame.
   */
  staged?: boolean;
  /** Called when the ground mesh is in, so the far landscape can step aside only once there is something to step aside for. */
  onGround?: () => void;
}

/** Visual-only crags on cliff faces nobody can reach, so the walls read as broken rock instead of a smooth ramp. */
export function cliffDetail(def: TerrainDef, x: number, z: number): number {
  if (def.biome === 'city') return 0;
  const d = Math.abs(x - roadX(def, z));
  const ch = corridorHalf(def, z);
  let m = smoothstep(ch + 1.5, ch + 7, d);
  m = Math.max(m, Math.min(1, smoothstep(def.zMax - 8, def.zMax + 8, z) + (1 - smoothstep(def.zMin - 8, def.zMin + 8, z))));
  if (m <= 0) return 0;
  const ridge = 1 - Math.abs(noise2(x / 9, z / 9, def.seed + 61) * 2 - 1);
  const ridge2 = 1 - Math.abs(noise2(x / 23 + 4, z / 23, def.seed + 64) * 2 - 1);
  const fine = noise2(x / 3.7, z / 3.7, def.seed + 62);
  const ledge = Math.floor(noise2(x / 37, z / 37, def.seed + 63) * 5) * 1.1;
  return m * (ridge * 4.2 + ridge2 * 3.5 + fine * 1.6 + ledge - 5.5) + mountainRelief(def, x, z, d, ch);
}

/** Big ridges and peaks on the slopes beyond the canyon rim: the far scenery, never reachable. */
/**
 * How far the drawn road sits above the ground under it (the collider's surface) at a point, 0 off the road. The road is a
 * crowned strip laid a few centimetres up, so anything meant to lie on the road (blood, brass, a thrown limb) rests on this.
 */
export function roadLift(def: TerrainDef, x: number, z: number): number {
  const city = def.biome === 'city';
  const crown = city ? 0.07 : 0.05;
  if (def.open) {
    const h = nearestRoad(def.open, x, z);
    if (!h.road || h.road.kind === 'track' || h.edge > 0) return 0;
    const t = h.d / h.road.half;
    return 0.035 + crown * (1 - t * t);
  }
  const half = city ? BOULEVARD_HALF : def.roadHalf;
  const t = Math.abs(x - roadX(def, z)) / half;
  return t > 1 ? 0 : 0.035 + crown * (1 - t * t);
}

export function mountainRelief(def: TerrainDef, x: number, z: number, d = Math.abs(x - roadX(def, z)), ch = corridorHalf(def, z)): number {
  const m = smoothstep(ch + 70, ch + 300, d);
  if (m <= 0) return 0;
  const r1 = 1 - Math.abs(noise2(x / 190, z / 190, def.seed + 81) * 2 - 1);
  const r2 = 1 - Math.abs(noise2(x / 61 + 9, z / 61, def.seed + 82) * 2 - 1);
  const mesa = smoothstep(0.55, 0.62, noise2(x / 260, z / 260, def.seed + 83));
  return m * (r1 * r1 * 85 + r2 * 20 + mesa * 40) - smoothstep(ch + 40, ch + 140, d) * 18;
}

/** Horizontal push for cliff vertices: bulges and recesses that a heightfield alone can't express. */
function cliffPush(def: TerrainDef, x: number, z: number, h: number): [number, number] | null {
  if (def.biome === 'city') return null;
  const rx = roadX(def, z);
  const d = Math.abs(x - rx);
  const ch = corridorHalf(def, z);
  const m = smoothstep(ch + 2, ch + 6, d) * (1 - smoothstep(ch + 16, ch + 24, d));
  if (m <= 0) return null;
  const n1 = noise2(z / 15 + h / 9, h / 13 + x / 40, def.seed + 66) * 2 - 1;
  const n2 = noise2(z / 5.5 - h / 4, h / 5 + 3.1, def.seed + 67) * 2 - 1;
  const amt = (n1 * 3.2 + n2 * 1.1) * m;
  // Toward the corridor (negative = into the rock).
  return [-Math.sign(x - rx) * amt, 0];
}

/** Meshes plus colliders for one 128 m chunk. Created and disposed by the streaming system. */
export class ChunkView {
  group = new THREE.Group();
  /** Glass over the shopfronts of this chunk, one pane to each of the glass boxes in its data. */
  panes = new PaneSet();
  colliders: Collider[] = [];
  aabbColliders = new Map<number, Collider>();
  barricadeMeshes = new Map<number, THREE.Mesh>();
  private geos: THREE.BufferGeometry[] = [];
  private instanced: THREE.InstancedMesh[] = [];
  /** This chunk is city: city ground, boulevard, facades. In a city leg that is every chunk; in the open world, the district's. */
  private city = false;
  /** Visual work still to do on a staged chunk. */
  private stages: (() => boolean | void)[] = [];
  /** Barricades that were blown apart before their mesh was built. */
  private removed = new Set<number>();

  constructor(
    public data: ChunkData,
    def: TerrainDef,
    mats: ChunkMaterials,
    private phys: PhysicsWorld,
    opts: ChunkOpts = { scatter: 1 },
  ) {
    const x0 = data.cx * CHUNK;
    const z0 = data.cz * CHUNK;
    this.city = data.city;
    this.buildColliders(def, x0, z0);
    const ground = this.buildTerrain(def, mats, x0, z0);
    this.stages.push(
      () => {
        if (!ground.next().done) return true;
        opts.onGround?.();
      },
      () => (def.open ? this.buildOpenRoads(def, mats, x0, z0) : this.buildRoad(def, mats, z0)),
      this.sliced(() => this.buildBuildings(data, mats)),
      () => this.buildProps(data, mats, def.biome === 'city'),
      this.sliced(() => this.buildScatter(def, opts.scatter)),
    );
    if (!opts.staged) while (this.buildNext());
  }

  /** A stage made of slices: the generator is started when the stage first runs and the stage repeats until it is done. */
  private sliced(make: () => Generator<void>): () => boolean {
    let g: Generator<void> | null = null;
    return () => !(g ??= make()).next().done;
  }

  /** Visual stages left on a staged chunk. */
  get pending(): number {
    return this.stages.length;
  }

  /** Run the next stage of a staged chunk. Returns whether there is more to do. */
  buildNext(): boolean {
    const stage = this.stages[0];
    if (stage && !stage()) this.stages.shift();
    return this.stages.length > 0;
  }

  private addMesh(geo: THREE.BufferGeometry, mat: THREE.Material, cast: boolean, receive: boolean) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast;
    m.receiveShadow = receive;
    this.group.add(m);
    this.geos.push(geo);
    return m;
  }

  /** The ground mesh, built as a generator that yields every few rows so a staged chunk can spread it over several ticks. */
  private *buildTerrain(def: TerrainDef, mats: ChunkMaterials, x0: number, z0: number): Generator<void> {
    const n = CELLS;
    const N1 = n + 1;
    const W = n + 3;
    const city = this.city;
    const seed = def.seed;
    // Positions with a one-cell border so normals match across chunk seams. Cliff faces nobody can reach get
    // crags (vertical noise) and bulges (horizontal push toward the corridor), so they read as broken rock.
    const hb = new Float32Array(W * W);
    const px = new Float32Array(W * W);
    const pz = new Float32Array(W * W);
    for (let r = -1; r <= n + 1; r++) {
      if (r > 0 && r % 16 === 0) yield;
      for (let c = -1; c <= n + 1; c++) {
        const x = x0 + c * CELL;
        const z = z0 + r * CELL;
        const inside = c >= 0 && c <= n && r >= 0 && r <= n;
        const base = inside ? this.data.heights[c * N1 + r] : heightAt(def, x, z);
        const h = base + cliffDetail(def, x, z);
        const k = (r + 1) * W + (c + 1);
        hb[k] = h;
        px[k] = x;
        pz[k] = z;
        const push = cliffPush(def, x, z, h);
        if (push) {
          px[k] += push[0];
          pz[k] += push[1];
        }
      }
    }
    const H = (c: number, r: number) => hb[(r + 1) * W + (c + 1)];
    const PX = (c: number, r: number) => px[(r + 1) * W + (c + 1)];
    const PZ = (c: number, r: number) => pz[(r + 1) * W + (c + 1)];
    const vcount = N1 * N1;
    const skirtCount = 4 * N1;
    const total = vcount + skirtCount;
    const pos = new Float32Array(total * 3);
    const nor = new Float32Array(total * 3);
    const col = new Float32Array(total * 3);
    const spl = new Float32Array(total * 4);
    const tdat = new Float32Array(total * 4);
    const ao = new Float32Array(vcount).fill(1);
    // Contact darkening around props and obstacles.
    const shade = (cx: number, cz: number, rad: number, amount: number) => {
      const c0 = Math.max(0, Math.floor((cx - rad - x0) / CELL));
      const c1 = Math.min(n, Math.ceil((cx + rad - x0) / CELL));
      const r0 = Math.max(0, Math.floor((cz - rad - z0) / CELL));
      const r1 = Math.min(n, Math.ceil((cz + rad - z0) / CELL));
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const d = Math.hypot(x0 + c * CELL - cx, z0 + r * CELL - cz) / rad;
          if (d < 1) ao[r * N1 + c] *= 1 - amount * (1 - d) * (1 - d);
        }
      }
    };
    for (const p of this.data.props) {
      const rad = p.kind === 'rock' ? 2.6 * p.scale : p.kind === 'wreck' ? 4.2 : p.kind === 'deadTree' ? 2.2 : p.kind === 'pole' || p.kind === 'sign' || p.kind === 'streetlight' ? 1.2 : 2.4;
      shade(p.x, p.z, rad, p.kind === 'pole' || p.kind === 'sign' ? 0.35 : 0.55);
    }
    for (const a of this.data.aabbs) {
      const hx = (a.maxX - a.minX) / 2;
      const hz = (a.maxZ - a.minZ) / 2;
      if (hx > 30 || hz > 30 || a.kind === 'partition' || a.kind === 'furniture' || a.kind === 'stair' || a.kind === 'floor') continue;
      shade((a.minX + a.maxX) / 2, (a.minZ + a.maxZ) / 2, Math.max(hx, hz) + 2.4, a.kind === 'building' ? 0.4 : 0.5);
    }
    yield;
    for (let r = 0; r <= n; r++) {
      if (r > 0 && r % 16 === 0) yield;
      for (let c = 0; c <= n; c++) {
        const i = r * N1 + c;
        const x = x0 + c * CELL;
        const z = z0 + r * CELL;
        const h = H(c, r);
        // Normal from the displaced surface: cross of the central differences along z and x.
        const ux = PX(c + 1, r) - PX(c - 1, r);
        const uy = H(c + 1, r) - H(c - 1, r);
        const uz = PZ(c + 1, r) - PZ(c - 1, r);
        const vx = PX(c, r + 1) - PX(c, r - 1);
        const vy = H(c, r + 1) - H(c, r - 1);
        const vz = PZ(c, r + 1) - PZ(c, r - 1);
        let nx = vy * uz - vz * uy;
        let ny = vz * ux - vx * uz;
        let nz = vx * uy - vy * ux;
        const m = 1 / (Math.hypot(nx, ny, nz) || 1);
        nx *= m;
        ny *= m;
        nz *= m;
        pos[i * 3] = PX(c, r) - x0;
        pos[i * 3 + 1] = h;
        pos[i * 3 + 2] = PZ(c, r) - z0;
        nor[i * 3] = nx;
        nor[i * 3 + 1] = ny;
        nor[i * 3 + 2] = nz;
        // Material weights: sand, earth, rock, gravel.
        const slope = 1 - ny;
        const d = Math.abs(x - roadX(def, z));
        const surf = surfaceAt(def, x, z);
        let rock = smoothstep(0.26, 0.5, slope);
        let sand = 0;
        let earth = 0;
        let gravel = 0;
        let wet = 0;
        let track = false;
        if (city) {
          earth = 0.7 + noise2(x / 21, z / 21, seed + 73) * 0.5;
          gravel = smoothstep(0.62, 0.8, noise2(x / 15, z / 15, seed + 71)) * 0.9;
          sand = smoothstep(0.55, 0.8, noise2(x / 27 + 5, z / 27, seed + 72)) * 0.6;
        } else {
          const cliff = smoothstep(corridorHalf(def, z) + 2, corridorHalf(def, z) + 9, d);
          rock = Math.max(rock, cliff * 0.9);
          if (def.open) {
            // Worn ground beside every road, and a darker beaten strip down a track.
            const hit = nearestRoad(def.open, x, z);
            gravel = hit.road ? 1 - smoothstep(0.2, 3.2, hit.edge) : 0;
            track = hit.road?.kind === 'track';
            if (track) gravel = Math.max(gravel, 1 - smoothstep(-0.5, 1.6, hit.edge) * 0.9);
          } else gravel = 1 - smoothstep(def.roadHalf + 1.2, def.roadHalf + 4.2, d);
          gravel = Math.max(gravel, smoothstep(0.68, 0.84, noise2(x / 17, z / 17, seed + 71)) * 0.75);
          sand = surf === 'sand' ? 1 : smoothstep(0.5, 0.78, noise2(x / 36 + 3, z / 36, seed + 72)) * 0.85;
          earth = track ? 0.1 : 0.55 + noise2(x / 23, z / 23, seed + 73) * 0.6;
          if (surf === 'mud') {
            wet = 0.75;
            sand *= 0.2;
          }
        }
        // Damp sand along a lake's beach, and a murky green-grey floor under its water.
        let tr = 1;
        let tg = 1;
        let tb = 1;
        const shore = def.lakes.length ? shoreShade(def.lakes, x, z, h) : null;
        if (shore) {
          rock *= 1 - shore.damp;
          sand = Math.max(sand, shore.damp * 0.9);
          earth *= 1 - shore.damp * 0.8;
          if (shore.depth > 0) gravel = 0.5 + shore.depth * 0.1;
          wet = Math.max(wet, 0.35 + shore.damp * 0.5);
          if (shore.depth > 0) {
            const dk = Math.min(1, shore.depth / 3);
            tr = 0.62 - 0.3 * dk;
            tg = 0.82 - 0.24 * dk;
            tb = 0.78 - 0.18 * dk;
          }
        }
        const keep = 1 - rock;
        sand *= keep;
        earth *= keep;
        gravel *= keep;
        const sum = sand + earth + rock + gravel || 1;
        spl[i * 4] = sand / sum;
        spl[i * 4 + 1] = earth / sum;
        spl[i * 4 + 2] = rock / sum;
        spl[i * 4 + 3] = gravel / sum;
        // Ambient occlusion: hollows and cliff feet collect shadow, plus the contact shade above.
        const concave = (H(c - 1, r) + H(c + 1, r) + H(c, r - 1) + H(c, r + 1)) / 4 - h;
        const a = Math.min(1, Math.max(0.45, 1 - Math.max(0, concave) * 0.22)) * ao[i];
        tdat[i * 4] = a;
        tdat[i * 4 + 1] = wet;
        const k = 0.93 + hash2(Math.round(x / CELL), Math.round(z / CELL), 5) * 0.14;
        const kk = k * (0.82 + 0.18 * a);
        col[i * 3] = kk * tr;
        col[i * 3 + 1] = kk * tg;
        col[i * 3 + 2] = kk * tb;
      }
    }
    yield;
    // Skirts hang below each edge so the seams to neighbouring chunks (and the far landscape) never crack.
    const edges: number[][] = [[], [], [], []];
    for (let k = 0; k <= n; k++) {
      edges[0].push(0 * N1 + k);
      edges[1].push(n * N1 + k);
      edges[2].push(k * N1 + 0);
      edges[3].push(k * N1 + n);
    }
    let sv = vcount;
    const idx: number[] = [];
    for (let e = 0; e < 4; e++) {
      const start = sv;
      for (const vi of edges[e]) {
        pos[sv * 3] = pos[vi * 3];
        pos[sv * 3 + 1] = pos[vi * 3 + 1] - 4;
        pos[sv * 3 + 2] = pos[vi * 3 + 2];
        nor.copyWithin(sv * 3, vi * 3, vi * 3 + 3);
        col.copyWithin(sv * 3, vi * 3, vi * 3 + 3);
        spl.copyWithin(sv * 4, vi * 4, vi * 4 + 4);
        tdat.copyWithin(sv * 4, vi * 4, vi * 4 + 4);
        sv++;
      }
      for (let k = 0; k < n; k++) {
        const a = edges[e][k];
        const b = edges[e][k + 1];
        const as = start + k;
        const bs = start + k + 1;
        idx.push(a, b, as, b, bs, as, a, as, b, b, as, bs);
      }
    }
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const a = r * N1 + c;
        const b = a + 1;
        const d = a + N1;
        const e = d + 1;
        // Same diagonal as the physics heightfield, so wheels sit on what you see.
        idx.push(a, d, e, a, e, b);
      }
    }
    yield;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('splat', new THREE.BufferAttribute(spl, 4));
    g.setAttribute('tdata', new THREE.BufferAttribute(tdat, 4));
    g.setIndex(idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    const m = this.addMesh(g, mats.terrain, false, true);
    m.position.set(x0, 0, z0);
  }

  /** The road: a gently crowned strip with crumbling shoulders, built only in the chunk column it runs through. */
  private buildRoad(def: TerrainDef, mats: ChunkMaterials, z0: number) {
    const city = def.biome === 'city';
    const half = city ? BOULEVARD_HALF : def.roadHalf;
    const ext = city ? 0.04 : 0.7;
    const crown = city ? 0.07 : 0.05;
    const step = 2;
    const us = [-ext / (2 * half), 0, 0.18, 0.5, 0.82, 1, 1 + ext / (2 * half)];
    const cols = us.length;
    const verts: number[] = [];
    const nors: number[] = [];
    const uvs: number[] = [];
    const tans: number[] = [];
    const idx: number[] = [];
    const nSeg = CHUNK / step;
    const tmp: [number, number, number] = [0, 1, 0];
    const x0 = this.data.cx * CHUNK;
    let rows = 0;
    let lastIn = false;
    for (let i = 0; i <= nSeg; i++) {
      const z = z0 + i * step;
      const cx = roadX(def, z);
      const zm = z + step / 2;
      const inCol: boolean = Math.floor(roadX(def, zm) / CHUNK) === this.data.cx || (i === nSeg && lastIn);
      const ahead = roadX(def, z + 1) - roadX(def, z - 1);
      const len = Math.hypot(ahead / 2, 1);
      const px = 1 / len;
      const pz = -(ahead / 2) / len;
      for (const u of us) {
        const off = (u - 0.5) * 2 * half;
        const x = cx + off * px;
        const zz = z + off * pz;
        const uc = Math.min(1, Math.max(0, u));
        verts.push(x - x0, heightAt(def, x, zz) + 0.035 + crown * (1 - (uc * 2 - 1) ** 2), zz - z0);
        normalAt(def, x, zz, tmp);
        nors.push(tmp[0], tmp[1], tmp[2]);
        uvs.push(u, z / ROAD_REPEAT);
        tans.push(px, 0, pz);
      }
      if (i < nSeg && inCol) {
        const a = rows * cols;
        for (let k = 0; k < cols - 1; k++) idx.push(a + k, a + cols + k, a + k + 1, a + k + 1, a + cols + k, a + cols + k + 1);
      }
      lastIn = inCol;
      rows++;
    }
    if (!idx.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nors, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setAttribute('rtan', new THREE.Float32BufferAttribute(tans, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const m = this.addMesh(g, mats.road, false, true);
    m.position.set(x0, 0, z0);
  }

  /**
   * The open world's roads: a ribbon along every highway and road that passes through this chunk. A track gets no mesh;
   * the ground shader paints it. Where two roads cross, the later one sits a centimetre higher so they do not fight.
   */
  private buildOpenRoads(def: TerrainDef, mats: ChunkMaterials, x0: number, z0: number) {
    const o = def.open!;
    const city = this.city;
    const x1 = x0 + CHUNK;
    const z1 = z0 + CHUNK;
    const tmp: [number, number, number] = [0, 1, 0];
    o.roads.forEach((road, ri) => {
      if (road.kind === 'track') return;
      const half = road.half;
      const ext = city ? 0.04 : 0.7;
      const crown = city ? 0.07 : 0.05;
      const us = [-ext / (2 * half), 0, 0.18, 0.5, 0.82, 1, 1 + ext / (2 * half)];
      const cols = us.length;
      const p = road.pts;
      const n = p.length / 2;
      const pad = half + 2;
      // Which points belong to this chunk: any whose segment to a neighbour touches the chunk's rectangle.
      const hits = (i: number) => {
        const ax = p[i * 2];
        const az = p[i * 2 + 1];
        return ax > x0 - pad && ax < x1 + pad && az > z0 - pad && az < z1 + pad;
      };
      let run: number[] = [];
      const flush = () => {
        if (run.length >= 2) this.roadRibbon(def, mats, road, ri, run, x0, z0, us, cols, half, crown, tmp);
        run = [];
      };
      for (let i = 0; i < n; i++) {
        if (hits(i) || (i > 0 && hits(i - 1)) || (i + 1 < n && hits(i + 1))) run.push(i);
        else flush();
      }
      flush();
    });
  }

  private roadRibbon(def: TerrainDef, mats: ChunkMaterials, road: RoadPath, ri: number, run: number[], x0: number, z0: number, us: number[], cols: number, half: number, crown: number, tmp: [number, number, number]) {
    const p = road.pts;
    const n = p.length / 2;
    const verts: number[] = [];
    const nors: number[] = [];
    const uvs: number[] = [];
    const tans: number[] = [];
    const idx: number[] = [];
    let arc = 0;
    let rows = 0;
    // Arc length from the road's start, so the lane texture lines up across chunks.
    for (let i = 1; i <= run[0]; i++) arc += Math.hypot(p[i * 2] - p[i * 2 - 2], p[i * 2 + 1] - p[i * 2 - 1]);
    for (let k = 0; k < run.length; k++) {
      const i = run[k];
      if (k > 0) arc += Math.hypot(p[i * 2] - p[i * 2 - 2], p[i * 2 + 1] - p[i * 2 - 1]);
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 1);
      let tx = p[b * 2] - p[a * 2];
      let tz = p[b * 2 + 1] - p[a * 2 + 1];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      // Sideways is the tangent turned a quarter turn; the lane texture wants it as `rtan` too.
      const px = tz;
      const pz = -tx;
      for (const u of us) {
        const off = (u - 0.5) * 2 * half;
        const x = p[i * 2] + off * px;
        const z = p[i * 2 + 1] + off * pz;
        const uc = Math.min(1, Math.max(0, u));
        verts.push(x - x0, heightAt(def, x, z) + 0.035 + ri * 0.012 + crown * (1 - (uc * 2 - 1) ** 2), z - z0);
        normalAt(def, x, z, tmp);
        nors.push(tmp[0], tmp[1], tmp[2]);
        uvs.push(u, arc / ROAD_REPEAT);
        tans.push(px, 0, pz);
      }
      if (k < run.length - 1) {
        const r0 = rows * cols;
        for (let c = 0; c < cols - 1; c++) idx.push(r0 + c, r0 + cols + c, r0 + c + 1, r0 + c + 1, r0 + cols + c, r0 + cols + c + 1);
      }
      rows++;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nors, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setAttribute('rtan', new THREE.Float32BufferAttribute(tans, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const m = this.addMesh(g, mats.road, false, true);
    m.position.set(x0, 0, z0);
  }

  private *buildScatter(def: TerrainDef, density: number): Generator<void> {
    if (density <= 0) return;
    // Nothing grows on the lake bed.
    const submerged = def.lakes.length ? (x: number, z: number) => waterAt(def, x, z) !== null : undefined;
    const set = yield* buildScatterSteps(def, this.data.cx, this.data.cz, this.data.aabbs, this.data.props, density, submerged);
    for (const im of [set.grass, set.shrubs, ...set.pebbles, ...set.boulders]) {
      if (!im) continue;
      this.group.add(im);
      this.instanced.push(im);
    }
    this.scatterSet = set;
  }

  private scatterSet: ScatterSet | null = null;

  /** Distance from the nearest player to this chunk's edge: small ground cover switches off beyond its fade range. */
  setDetailDistance(d: number) {
    const s = this.scatterSet;
    if (!s) return;
    if (s.grass) s.grass.visible = d < 90;
    for (const p of s.pebbles) p.visible = d < 110;
    if (s.shrubs) s.shrubs.visible = d < 190;
  }

  private *buildBuildings(data: ChunkData, mats: ChunkMaterials): Generator<void> {
    if (data.blocks.length && (data.cx === 0 || data.cx === -1)) this.buildSidewalks(data);
    if (data.patches.length) this.buildPatches(data, mats);
    if (data.signs.length) {
      for (const { material, geometry } of buildSignGeometries(data.signs)) this.addMesh(geometry, material, false, false);
    }
    if (!data.buildings.length) return;
    const fb = new FacadeBuilder();
    const det = new MeshBuilder();
    det.jitter = 0.05;
    let built = 0;
    for (const bs of data.buildings) {
      if (built++ % 3 === 2) yield;
      const a = bs.aabb;
      const seed = hash2(Math.round(a.minX * 2), Math.round(a.minZ * 2), 77);
      const tall = bs.floors >= 9;
      const k = hash2(Math.round(a.minX), Math.round(a.maxZ), 78);
      // An Israeli apartment block is rendered, almost always stucco, in cream, sand and warm white; towers are panel.
      const il = !!bs.israeli && !bs.role;
      const style = facadeStyleOf(bs);
      const tint = new THREE.Color(bs.tint ?? (il && style !== 3 ? ISRAELI_TINT[Math.floor(seed * 977) % ISRAELI_TINT.length] : FACADE_TINT[style][Math.floor(seed * FACADE_TINT[style].length) % FACADE_TINT[style].length]));
      if (bs.role === 'standSide' || bs.role === 'standEnd') {
        this.grandstand(fb, det, bs, tint);
        continue;
      }
      // A shopfront with its own sign takes the place of the awnings.
      const face = !bs.shop && BOULEVARD_HALF + 4 > Math.min(Math.abs(a.minX), Math.abs(a.maxX)) ? (a.minX > 0 ? 'w' : 'e') : null;
      // A pitched roof replaces the flat slab and parapet; a landmark has no shopfront band.
      this.buildingShell(fb, det, a.minX, a.maxX, a.minZ, a.maxZ, 0, a.y1, tint, style, seed, true, face, { pitched: bs.role === 'synagogue', noShops: !!bs.role });
      if (bs.role) this.landmarkExtras(det, bs, tint);
      if (bs.shop) this.shopFront(bs, bs.shop as ShopId);
      if (bs.stepped) {
        const inset = 3;
        if (a.maxX - a.minX > inset * 3 && a.maxZ - a.minZ > inset * 3) {
          this.buildingShell(fb, det, a.minX + inset, a.maxX - inset, a.minZ + inset, a.maxZ - inset, a.y1, a.y1 + 6.6, tint, style, seed + 0.31, false, null);
        }
      }
      if (!bs.role) this.rooftop(det, a.minX, a.maxX, a.minZ, a.maxZ, a.y1 + (bs.stepped ? 6.6 : 0), seed, bs.stepped ? 3 : 0, il);
      if (il && style !== 3) {
        this.balconies(det, a, tint, seed, style);
        this.solarHeaters(det, a.minX, a.maxX, a.minZ, a.maxZ, a.y1 + (bs.stepped ? 6.6 : 0), seed, bs.stepped ? 3 : 0);
      }
      if (style === 1 && seed > 0.4 && a.y1 > 9 && !bs.role && !il) this.fireEscape(det, a, seed);
    }
    if (!fb.empty) this.addMesh(fb.build(), facadeMaterial(), true, true);
    if (!det.empty) this.addMesh(det.build(), mats.roofs, true, true);
  }

  /** Walls, ledges, cornice, parapet and (on the boulevard side) shopfront awnings for one block. */
  private buildingShell(fb: FacadeBuilder, det: MeshBuilder, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, tint: THREE.Color, style: number, seed: number, ground: boolean, shopFace: 'w' | 'e' | null, civic: { pitched?: boolean; noShops?: boolean } = {}) {
    const floorH = 3.3;
    const target = style === 3 ? 1.6 : 2.6 + seed * 0.7;
    const cell = (len: number) => len / Math.max(1, Math.round(len / target));
    // Walls counter-clockwise from above so they face outward. A raised base hides the shop band on upper blocks.
    const yb = ground ? y0 : y0 - floorH * 1.3;
    const corners: [number, number][] = [[x0, z1], [x1, z1], [x1, z0], [x0, z0], [x0, z1]];
    let u = 0;
    for (let i = 0; i < 4; i++) {
      const [ax, az] = corners[i];
      const [bx, bz] = corners[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      // A landmark has no shopfront band: shifting the wall's v coordinate makes its ground floor an ordinary storey.
      fb.wall(ax, az, bx, bz, y0, y1, 0, tint, style, seed * 97 + i * 0.37, floorH, cell(len), civic.noShops ? -floorH * 1.3 : 0);
      u += len;
    }
    void yb;
    void u;
    const wallC = S.concrete(tint.clone().multiplyScalar(0.92).getHex(), 0.7);
    const trim = S.concrete(tint.clone().multiplyScalar(1.08).getHex(), 0.6);
    const w = x1 - x0;
    const d = z1 - z0;
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    // Floor ledges on panel and stucco buildings, a heavier cornice at the top.
    if (style === 0 || style === 2) {
      const gh = floorH * 1.3;
      for (let y = gh; y < y1 - 1; y += floorH * (style === 2 ? 2 : 1)) {
        det.box(cx, y0 + y, z1 + 0.05, w + 0.1, 0.12, 0.1, trim);
        det.box(cx, y0 + y, z0 - 0.05, w + 0.1, 0.12, 0.1, trim);
        det.box(x1 + 0.05, y0 + y, cz, 0.1, 0.12, d + 0.1, trim);
        det.box(x0 - 0.05, y0 + y, cz, 0.1, 0.12, d + 0.1, trim);
      }
    }
    if (ground) {
      // Shop band lintel.
      const lh = floorH * 1.3 - 0.1;
      det.box(cx, lh, z1 + 0.06, w + 0.12, 0.2, 0.12, trim);
      det.box(cx, lh, z0 - 0.06, w + 0.12, 0.2, 0.12, trim);
      det.box(x1 + 0.06, lh, cz, 0.12, 0.2, d + 0.12, trim);
      det.box(x0 - 0.06, lh, cz, 0.12, 0.2, d + 0.12, trim);
    }
    const ct = style === 3 ? 0.2 : 0.38;
    det.box(cx, y1 - ct / 2, z1 + 0.12, w + 0.3, ct, 0.24, trim);
    det.box(cx, y1 - ct / 2, z0 - 0.12, w + 0.3, ct, 0.24, trim);
    det.box(x1 + 0.12, y1 - ct / 2, cz, 0.24, ct, d + 0.3, trim);
    det.box(x0 - 0.12, y1 - ct / 2, cz, 0.24, ct, d + 0.3, trim);
    // Roof slab and parapet with coping; some parapets broken away.
    det.box(cx, y1 + 0.02, cz, w - 0.1, 0.06, d - 0.1, S.concrete(C.concreteDark, 0.8));
    if (!civic.pitched) {
      const ph = 0.9;
      const parapet = (px: number, pz: number, sx: number, sz: number) => {
        det.box(px, y1 + ph / 2, pz, sx, ph, sz, wallC);
        det.box(px, y1 + ph + 0.04, pz, sx + 0.08, 0.08, sz + 0.08, trim);
      };
      const gap = hash2(Math.round(x0), Math.round(z0), 5) > 0.7;
      parapet(cx, z1 - 0.15, w, 0.3);
      if (gap) {
        parapet(x0 + w * 0.2, z0 + 0.15, w * 0.4, 0.3);
        parapet(x1 - w * 0.15, z0 + 0.15, w * 0.3, 0.3);
      } else parapet(cx, z0 + 0.15, w, 0.3);
      parapet(x1 - 0.15, cz, 0.3, d - 0.6);
      parapet(x0 + 0.15, cz, 0.3, d - 0.6);
    }
    // Awnings over the shopfronts that face the boulevard.
    if (ground && shopFace) {
      const fx = shopFace === 'w' ? x0 : x1;
      const out = shopFace === 'w' ? -1 : 1;
      const bay = cell(d) * 2;
      const n = Math.max(1, Math.round(d / bay));
      for (let i = 0; i < n; i++) {
        const h = hash2(Math.round(fx * 3) + i, Math.round(z0), 41);
        if (h < 0.45) continue;
        const bz = z0 + (i + 0.5) * (d / n);
        const col = AWNING[Math.floor(h * 97) % AWNING.length];
        const torn = h > 0.8;
        det.box(fx + out * 0.65, 3.55, bz, 1.3, 0.04, d / n - 0.5, S.cloth(col, 0.8), 0, 0, out * -0.32);
        if (!torn) det.box(fx + out * 1.28, 3.28, bz, 0.03, 0.32, d / n - 0.5, S.cloth(col, 0.8));
        for (const dz of [-1, 1]) det.rod(fx, 3.75, bz + dz * (d / n / 2 - 0.3), fx + out * 1.3, 3.33, bz + dz * (d / n / 2 - 0.3), 0.015, S.metal(0x3a3a3a), 6);
      }
    }
  }

  /** Rooftop clutter: AC units, vents, a stair hut, sometimes a water tower or antenna mast. */
  private rooftop(det: MeshBuilder, x0: number, x1: number, z0: number, z1: number, y: number, seed: number, inset: number, israeli = false) {
    const r = (k: number) => hash2(Math.round(seed * 1000) + k * 13, k, 91);
    const w = x1 - x0 - inset * 2;
    const d = z1 - z0 - inset * 2;
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    const metal = S.metal(0x8a8e90, 0.75);
    const at = (k: number): [number, number] => [cx + (r(k) - 0.5) * (w - 3), cz + (r(k + 50) - 0.5) * (d - 3)];
    const nAc = 1 + Math.floor(r(1) * 3);
    for (let i = 0; i < nAc; i++) {
      const [ax, az] = at(10 + i);
      det.rbox(ax, y + 0.55, az, 1.4, 1.0, 1.1, 0.05, metal);
      det.cyl(ax, y + 1.07, az, 0.8, 0.06, 0.8, S.metal(0x2a2a2a, 0.6), 0, 0, 0, 16);
      for (let k = 0; k < 4; k++) det.box(ax, y + 1.1, az, 0.75, 0.02, 0.06, S.metal(0x5a5a5a), 0, (k / 4) * Math.PI, 0);
    }
    for (let i = 0; i < 3; i++) {
      const [vx, vz] = at(30 + i);
      det.cyl(vx, y + 0.4, vz, 0.3, 0.8, 0.3, S.metal(0x6a6e70, 0.8), 0, 0, 0, 10);
      det.add('cone12', vx, y + 0.9, vz, 0.42, 0.22, 0.42, S.metal(0x6a6e70, 0.8));
    }
    if (w > 6 && d > 6) {
      const [hx, hz] = at(40);
      det.rbox(hx, y + 1.3, hz, 2.6, 2.6, 2.2, 0.05, S.concrete(C.concrete, 0.7));
      det.box(hx, y + 2.68, hz, 2.9, 0.12, 2.5, S.concrete(C.concreteDark, 0.7));
      det.box(hx + 1.31, y + 1.0, hz, 0.03, 2.0, 0.9, S.paint(0x4a3a2e, 0.8));
    }
    if (r(2) > 0.62 && !israeli) {
      // Water tower on legs, timber tank with steel hoops.
      const [tx, tz] = at(60);
      for (const [lx, lz] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) det.rod(tx + lx * 1.0, y, tz + lz * 1.0, tx + lx * 0.85, y + 3.2, tz + lz * 0.85, 0.06, S.steel(0x3a3c3e), 6);
      det.cyl(tx, y + 4.4, tz, 2.6, 2.4, 2.6, S.wood(0x6a5038, 0.8), 0, 0, 0, 16);
      for (const hy of [3.6, 4.4, 5.2]) det.torus(tx, y + hy, tz, 1.31, 0.03, S.steel(0x3a3c3e), Math.PI / 2, 0, 0, 5, 24);
      det.add('cone12', tx, y + 6.0, tz, 2.8, 0.9, 2.8, S.wood(0x4a3828, 0.8));
    }
    if (r(3) > 0.7) {
      const [mx, mz] = at(70);
      det.rod(mx, y, mz, mx, y + 7, mz, 0.05, metal, 6);
      for (let i = 0; i < 3; i++) det.rod(mx - 0.6, y + 4 + i * 1.1, mz, mx + 0.6, y + 4 + i * 1.1, mz, 0.02, metal, 5);
      det.lathe('roofDish', [[0, 0], [0.3, 0.05], [0.55, 0.18]], mx + 0.3, y + 2.6, mz, S.paint(0xd0d0c8, 0.6), Math.PI / 2 - 0.4, 0.8, 0, 14);
    }
  }

  /** Steel fire escape zig-zagging down one end wall. */
  private fireEscape(det: MeshBuilder, a: Aabb, seed: number) {
    const onPlusZ = seed > 0.7;
    const z = onPlusZ ? a.maxZ : a.minZ;
    const out = onPlusZ ? 1 : -1;
    const cx = (a.minX + a.maxX) / 2 + (seed - 0.5) * 4;
    const steel = S.paint(0x2a2a28, 0.85);
    const floors = Math.floor(a.y1 / 3.3);
    for (let f = 1; f < floors; f++) {
      const y = f * 3.3 + 0.9;
      det.box(cx, y, z + out * 0.6, 3.2, 0.05, 1.2, steel);
      det.box(cx, y + 0.95, z + out * 1.18, 3.2, 0.04, 0.04, steel);
      for (let i = 0; i <= 4; i++) det.rod(cx - 1.6 + i * 0.8, y, z + out * 1.18, cx - 1.6 + i * 0.8, y + 0.95, z + out * 1.18, 0.012, steel, 5);
      // Stair down to the platform below.
      const s = f % 2 ? 1 : -1;
      det.rod(cx + s * 1.3, y, z + out * 0.85, cx - s * 0.9, y - 3.3, z + out * 0.85, 0.03, steel, 5);
      det.rod(cx + s * 1.3, y + 0.9, z + out * 0.4, cx - s * 0.9, y - 2.4, z + out * 0.4, 0.015, steel, 5);
    }
    // The bottom ladder, retracted.
    det.rod(cx + 1.3, 1.5, z + out * 0.85, cx + 1.3, 4.2, z + out * 0.85, 0.02, steel, 5);
    det.rod(cx + 1.6, 1.5, z + out * 0.85, cx + 1.6, 4.2, z + out * 0.85, 0.02, steel, 5);
  }

  /** Sidewalk slabs and kerbs along the boulevard, interrupted at the cross streets. */
  private buildSidewalks(data: ChunkData) {
    const zc0 = data.cz * CHUNK;
    const zc1 = zc0 + CHUNK;
    const side = data.cx === 0 ? 1 : -1;
    const verts: number[] = [];
    const nors: number[] = [];
    const uvs: number[] = [];
    const tans: number[] = [];
    const idx: number[] = [];
    const kerb = new MeshBuilder();
    kerb.jitter = 0.05;
    const xa = side * (BOULEVARD_HALF + 0.22);
    const xb = side * (BOULEVARD_HALF + SIDEWALK);
    for (const blk of data.blocks) {
      const z0 = Math.max(zc0, blk.z0);
      const z1 = Math.min(zc1, blk.z1);
      if (z1 <= z0) continue;
      const base = verts.length / 3;
      const lo = Math.min(xa, xb);
      const hi = Math.max(xa, xb);
      verts.push(lo, 0.03, z0, hi, 0.03, z0, hi, 0.03, z1, lo, 0.03, z1);
      for (let i = 0; i < 4; i++) {
        nors.push(0, 1, 0);
        tans.push(1, 0, 0);
      }
      uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
      idx.push(base, base + 3, base + 2, base, base + 2, base + 1);
      // Kerb stones with rounded corners at the street ends.
      kerb.rbox(side * (BOULEVARD_HALF + 0.11), 0.06, (z0 + z1) / 2, 0.22, 0.12, z1 - z0, 0.03, S.concrete(0x9a9890, 0.6));
      // Gutter grates every so often.
      for (let z = Math.ceil(z0 / 18) * 18; z < z1 - 1; z += 18) kerb.box(side * (BOULEVARD_HALF - 0.25), 0.025, z, 0.35, 0.02, 0.8, S.metal(0x1e1e1e, 0.8));
    }
    if (!idx.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nors, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setAttribute('rtan', new THREE.Float32BufferAttribute(tans, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    this.addMesh(g, pavingMaterial(), false, true);
    this.addMesh(kerb.build(), kitMaterial(), false, true);
  }

  /** Planned city legs: asphalt side and cross streets, paved plazas and lawns, clipped to this chunk. */
  private buildPatches(data: ChunkData, mats: ChunkMaterials) {
    const bx0 = data.cx * CHUNK;
    const bz0 = data.cz * CHUNK;
    const quads = (kind: 'asphalt' | 'paving') => {
      const verts: number[] = [];
      const nors: number[] = [];
      const uvs: number[] = [];
      const tans: number[] = [];
      const idx: number[] = [];
      for (const p of data.patches) {
        if (p.kind !== kind) continue;
        const x0 = Math.max(p.x0, bx0);
        const x1 = Math.min(p.x1, bx0 + CHUNK);
        const z0 = Math.max(p.z0, bz0);
        const z1 = Math.min(p.z1, bz0 + CHUNK);
        if (x1 - x0 < 0.05 || z1 - z0 < 0.05) continue;
        // An east-west street runs its texture along x; a north-south one along z. The two keep the same handedness.
        const eastWest = p.x1 - p.x0 > p.z1 - p.z0;
        const y = kind === 'asphalt' ? 0.034 : 0.032;
        const base = verts.length / 3;
        for (const [x, z] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]) {
          verts.push(x, y, z);
          nors.push(0, 1, 0);
          if (eastWest) {
            uvs.push((z - p.z0) / (p.z1 - p.z0), -x / ROAD_REPEAT);
            tans.push(0, 0, 1);
          } else {
            uvs.push((x - p.x0) / (p.x1 - p.x0), z / ROAD_REPEAT);
            tans.push(1, 0, 0);
          }
        }
        idx.push(base, base + 3, base + 2, base, base + 2, base + 1);
      }
      if (!idx.length) return null;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nors, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      g.setAttribute('rtan', new THREE.Float32BufferAttribute(tans, 3));
      g.setIndex(idx);
      g.computeBoundingSphere();
      return g;
    };
    const asphalt = quads('asphalt');
    if (asphalt) this.addMesh(asphalt, mats.road, false, true);
    const paving = quads('paving');
    if (paving) this.addMesh(paving, pavingMaterial(), false, true);
    // Lawns: a low sod slab, dull and dry. Two tones so a big one is not a flat sheet.
    const turf = new MeshBuilder();
    turf.jitter = 0.03;
    for (const p of data.patches) {
      if (p.kind !== 'lawn') continue;
      const x0 = Math.max(p.x0, bx0);
      const x1 = Math.min(p.x1, bx0 + CHUNK);
      const z0 = Math.max(p.z0, bz0);
      const z1 = Math.min(p.z1, bz0 + CHUNK);
      if (x1 - x0 < 0.05 || z1 - z0 < 0.05) continue;
      const nx = Math.max(1, Math.round((x1 - x0) / 6));
      const nz = Math.max(1, Math.round((z1 - z0) / 6));
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < nz; j++) {
          const k = hash2(Math.round(x0) + i * 7, Math.round(z0) + j * 11, 61);
          const col = k < 0.5 ? 0x5d8a35 : k < 0.8 ? 0x6e9040 : 0x4f7a30;
          const sx = (x1 - x0) / nx;
          const sz = (z1 - z0) / nz;
          turf.box(x0 + (i + 0.5) * sx, 0.05, z0 + (j + 0.5) * sz, sx + 0.02, 0.1, sz + 0.02, S.cloth(col, 0.9));
        }
      }
    }
    if (!turf.empty) this.addMesh(turf.build(), kitMaterial(), false, true);
    // Tarmac: dark worn slabs, for a car park. The painted bays are props laid on top.
    const tar = new MeshBuilder();
    for (const p of data.patches) {
      if (p.kind !== 'tarmac') continue;
      const x0 = Math.max(p.x0, bx0);
      const x1 = Math.min(p.x1, bx0 + CHUNK);
      const z0 = Math.max(p.z0, bz0);
      const z1 = Math.min(p.z1, bz0 + CHUNK);
      if (x1 - x0 < 0.05 || z1 - z0 < 0.05) continue;
      const nx = Math.max(1, Math.round((x1 - x0) / 5));
      const nz = Math.max(1, Math.round((z1 - z0) / 5));
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < nz; j++) {
          const k = hash2(Math.round(x0) + i * 5, Math.round(z0) + j * 9, 41);
          const col = k < 0.4 ? 0x3a3b3d : k < 0.75 ? 0x424345 : 0x353638;
          const sx = (x1 - x0) / nx;
          const sz = (z1 - z0) / nz;
          tar.box(x0 + (i + 0.5) * sx, 0.02, z0 + (j + 0.5) * sz, sx + 0.02, 0.04, sz + 0.02, S.concrete(col, 0.8));
        }
      }
    }
    if (!tar.empty) this.addMesh(tar.build(), kitMaterial(), false, true);
    this.railway(data, mats);
    this.pitch(data, mats);
  }


  // ---------------------------------------------------------------- Israeli apartment blocks

  /**
   * A balcony under many of the windows on the two long walls, in stacks, as on the real blocks: a slab, a solid parapet with
   * a dark rail on top, now and then an air-conditioning condenser; and on the bays with no balcony, the odd condenser on
   * its bracket or a roller shutter half down over the window. The bays are the facade shader's own cells, so each balcony
   * sits in front of a window.
   */
  private balconies(det: MeshBuilder, a: Aabb, tint: THREE.Color, seed: number, style: number) {
    void style;
    const floorH = 3.3;
    const gh = floorH * 1.3;
    const upper = Math.floor((a.y1 - gh) / floorH);
    if (upper < 1) return;
    const slab = S.concrete(tint.clone().multiplyScalar(1.04).getHex(), 0.6);
    const parapet = S.concrete(tint.clone().multiplyScalar(0.9).getHex(), 0.7);
    const rail = S.paint(0x3b3d40, 0.7);
    const ac = S.paint(0xe4e4de, 0.6);
    const shutter = S.paint(0xb5ad98, 0.8);
    const target = 2.6 + seed * 0.7;
    const d = a.maxZ - a.minZ;
    const n = Math.max(1, Math.round(d / target));
    const cell = d / n;
    const sd = Math.round(seed * 1000);
    for (const out of [-1, 1] as const) {
      const wallX = out === 1 ? a.maxX : a.minX;
      for (let c = 0; c < n; c++) {
        const zc = a.minZ + (c + 0.5) * cell;
        const balcony = hash2(sd + c * 7, out + 3, 51) < 0.38;
        const bw = cell * 0.74;
        for (let f = 0; f < upper; f++) {
          const y = gh + f * floorH;
          const roll = hash2(c * 31 + f, sd + out, 52);
          if (balcony && roll > 0.12) {
            det.box(wallX + out * 0.72, y + 0.07, zc, 1.44, 0.14, bw, slab);
            det.box(wallX + out * 1.4, y + 0.62, zc, 0.08, 0.96, bw, parapet);
            det.box(wallX + out * 1.4, y + 1.13, zc, 0.12, 0.05, bw + 0.04, rail);
            if (roll > 0.74) det.box(wallX + out * 0.45, y + 0.4, zc + bw * 0.28, 0.5, 0.52, 0.72, ac);
          } else if (!balcony) {
            if (roll < 0.09) det.box(wallX + out * 0.2, y + 0.62, zc + cell * 0.3, 0.4, 0.55, 0.78, ac);
            else if (roll < 0.2) {
              // A roller shutter, lowered part way: housing over the window and the slats below it.
              det.box(wallX + out * 0.08, y + 2.6, zc, 0.16, 0.22, cell * 0.5, shutter);
              det.box(wallX + out * 0.05, y + 2.0, zc, 0.05, 1.1, cell * 0.46, shutter);
            }
          }
        }
      }
    }
  }

  /** Solar water heaters on the roof: a tilted collector panel with a white tank lying across the top, in a loose grid. */
  private solarHeaters(det: MeshBuilder, x0: number, x1: number, z0: number, z1: number, y: number, seed: number, inset: number) {
    const w = x1 - x0 - inset * 2 - 3;
    const d = z1 - z0 - inset * 2 - 3;
    if (w < 3 || d < 3) return;
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    const cols = Math.max(1, Math.min(5, Math.floor(w / 3)));
    const rows = Math.max(1, Math.min(4, Math.floor(d / 6)));
    const sd = Math.round(seed * 1000);
    const tankC = S.paint(0xefefe8, 0.5);
    const panelC = S.paint(0x1c2a44, 0.4);
    const frame = S.steel(0x8a8e90, 0.6);
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        if (hash2(sd + i * 11, j * 5 + 3, 61) > 0.5) continue;
        const px = cx + ((i + 0.5) / cols - 0.5) * w;
        const pz = cz + ((j + 0.5) / rows - 0.5) * d;
        det.box(px, y + 0.55, pz + 0.1, 1.5, 0.06, 1.05, panelC, 0.62, 0, 0);
        det.cyl(px, y + 1.05, pz - 0.28, 0.5, 1.4, 0.5, tankC, 0, 0, Math.PI / 2, 10);
        det.rod(px - 0.6, y, pz - 0.4, px - 0.6, y + 0.8, pz - 0.28, 0.025, frame, 5);
        det.rod(px + 0.6, y, pz - 0.4, px + 0.6, y + 0.8, pz - 0.28, 0.025, frame, 5);
      }
    }
  }

  // ---------------------------------------------------------------- stadium, light rail

  /**
   * One stand of HaMoshava Stadium. A solid back wall of concrete panels, the seating rake as full-height steps (so the
   * stand's flanks are stepped too), seats in alternating sectors of blue and white, a rail along the front, and on the
   * tall stands a roof that reaches out over the seats.
   */
  private grandstand(fb: FacadeBuilder, det: MeshBuilder, bs: BuildingSpec, tint: THREE.Color) {
    const a = bs.aabb;
    const front = bs.front ?? 'e';
    const ew = front === 'e' || front === 'w';
    const D = ew ? a.maxX - a.minX : a.maxZ - a.minZ;
    const L = ew ? a.maxZ - a.minZ : a.maxX - a.minX;
    const H = a.y1;
    const cx = (a.minX + a.maxX) / 2;
    const cz = (a.minZ + a.maxZ) / 2;
    // sgn: which way "towards the pitch" runs along the depth axis.
    const sgn = front === 'e' || front === 'n' ? 1 : -1;
    const frontEdge = ew ? (sgn > 0 ? a.maxX : a.minX) : sgn > 0 ? a.maxZ : a.minZ;
    const backEdge = ew ? (sgn > 0 ? a.minX : a.maxX) : sgn > 0 ? a.minZ : a.maxZ;
    const rowD = 0.95;
    const rows = Math.max(3, Math.floor(D / rowD));
    const y0 = H > 9 ? 1.0 : 0.7;
    const y1 = H - (H > 9 ? 1.4 : 1.2);
    const concrete = S.concrete(tint.clone().multiplyScalar(0.96).getHex(), 0.7);
    const dark = S.concrete(tint.clone().multiplyScalar(0.72).getHex(), 0.75);
    const blue = S.plastic(0x1f48a0, 0.6);
    const white = S.plastic(0xe6e6df, 0.6);
    const red = S.plastic(0xb3202a, 0.6);
    const sectors = Math.max(2, Math.round(L / 9));
    const secLen = L / sectors;
    // Put a box in stand coordinates: `t` is the distance back from the front edge, `lat` the position along the stand.
    const at = (t: number, lat: number, y: number, dt: number, h: number, dl: number, color: Parameters<MeshBuilder['box']>[6]) => {
      const pd = frontEdge - sgn * t;
      const pl = (ew ? a.minZ : a.minX) + lat;
      if (ew) det.box(pd, y, pl, dt, h, dl, color);
      else det.box(pl, y, pd, dl, h, dt, color);
    };
    for (let k = 0; k < rows; k++) {
      const top = y0 + ((y1 - y0) * k) / Math.max(1, rows - 1);
      const t = (k + 0.5) * (D / rows);
      // The step itself, from the ground up so the flanks are solid.
      at(t, L / 2, top / 2, D / rows + 0.02, top, L, concrete);
      for (let s = 0; s < sectors; s++) {
        const col = (s + Math.floor(k / 6)) % 4 === 3 ? red : s % 2 ? white : blue;
        at(t - 0.12, (s + 0.5) * secLen, top + 0.1, 0.5, 0.2, secLen - 0.9, col);
      }
    }
    // Aisles: a dark strip up the rake between every pair of sectors.
    for (let s = 1; s < sectors; s++) {
      for (let k = 0; k < rows; k += 2) {
        const top = y0 + ((y1 - y0) * k) / Math.max(1, rows - 1);
        at((k + 0.5) * (D / rows), s * secLen, top + 0.03, D / rows * 2, 0.06, 0.8, dark);
      }
    }
    // The back wall, in concrete panels, a little proud of the last step; the end faces are the steps.
    const wallX0 = ew ? backEdge - (sgn > 0 ? 0.02 : -0.02) : a.minX;
    const wallX1 = ew ? wallX0 : a.maxX;
    const wallZ0 = ew ? a.minZ : backEdge - (sgn > 0 ? 0.02 : -0.02);
    const wallZ1 = ew ? a.maxZ : wallZ0;
    // `wall` walks from its first to its second point with the face to the left of travel (towards (-dz, dx)).
    if (ew) {
      if (sgn > 0) fb.wall(wallX0, a.minZ, wallX1, a.maxZ, 0, H, 0, tint, 10, 0.5, 3.3, 3.2);
      else fb.wall(wallX0, a.maxZ, wallX1, a.minZ, 0, H, 0, tint, 10, 0.5, 3.3, 3.2);
    } else if (sgn > 0) fb.wall(a.maxX, wallZ0, a.minX, wallZ1, 0, H, 0, tint, 10, 0.5, 3.3, 3.2);
    else fb.wall(a.minX, wallZ0, a.maxX, wallZ1, 0, H, 0, tint, 10, 0.5, 3.3, 3.2);
    // A rail along the front row, and a drop of dark stripe where the pitch wall would be.
    at(0.15, L / 2, 0.55, 0.08, 1.1, L, S.steel(0x5c6266, 0.6));
    // The roof over the tall stands: a level slab reaching 3 m past the front, a red fascia, and slim columns at the back.
    if (H > 9) {
      const reach = D + 3.4;
      const tt = reach / 2 - 3.4;
      at(tt, L / 2, H + 0.3, reach, 0.35, L + 1.2, S.paint(0xcfd3d4, 0.6));
      at(-3.1, L / 2, H + 0.3, 0.3, 0.7, L + 1.3, S.paint(0xb3202a, 0.6));
      const cols = Math.max(2, Math.round(L / 10));
      for (let i = 0; i <= cols; i++) at(D - 0.4, (i / cols) * L, H / 2 + 0.3, 0.5, H, 0.5, S.steel(0x6a6e70, 0.5));
    } else {
      at(D / 2, L / 2, H + 0.12, D + 0.3, 0.24, L + 0.3, concrete);
    }
    // Tall stands are where the sign goes; nothing more to add for the low ones.
    void cx;
    void cz;
  }

  /** The light-rail line: a concrete slab with two tracks, island platforms with canopies, and overhead wire on masts. */
  private railway(data: ChunkData, mats: ChunkMaterials) {
    const bx0 = data.cx * CHUNK;
    const bz0 = data.cz * CHUNK;
    const bx1 = bx0 + CHUNK;
    const bz1 = bz0 + CHUNK;
    const det = new MeshBuilder();
    const slabC = S.concrete(0x8f8d86, 0.7);
    const bedC = S.concrete(0x5a5853, 0.8);
    const steel = S.steel(0x75797c, 0.5);
    const mastC = S.steel(0x7d8184, 0.55);
    const wire = S.steel(0x2a2c2e, 0.5);
    for (const p of data.patches) {
      if (p.kind === 'rail') {
        const x0 = Math.max(p.x0, bx0);
        const x1 = Math.min(p.x1, bx1);
        const zc = (p.z0 + p.z1) / 2;
        const wd = p.z1 - p.z0;
        if (x1 - x0 < 0.05 || zc + wd / 2 < bz0 || zc - wd / 2 > bz1) continue;
        const len = x1 - x0;
        const mx = (x0 + x1) / 2;
        det.box(mx, 0.045, zc, len, 0.09, wd, slabC);
        for (const tz of [-3.9, 3.9]) {
          det.box(mx, 0.093, zc + tz, len, 0.012, 2.3, bedC);
          for (const r of [-0.7175, 0.7175]) det.box(mx, 0.17, zc + tz + r, len, 0.14, 0.07, steel);
        }
        // Joints across the slab every six metres, on a lattice that does not care where the chunk starts.
        for (let x = Math.ceil((x0 - p.x0) / 6) * 6 + p.x0; x < x1; x += 6) det.box(x, 0.092, zc, 0.05, 0.006, wd, bedC);
        // Masts every 26 m on both sides; each reaches an arm over its own track. Contact wire and a messenger wire above it.
        for (let x = p.x0 + 8; x < p.x1 - 4; x += 26) {
          if (x >= x0 && x < x1) {
            for (const side of [-1, 1]) {
              const pz = zc + side * (wd / 2 + 0.9);
              if (pz < bz0 || pz >= bz1) continue;
              det.cyl(x, 3.5, pz, 0.28, 7.0, 0.28, mastC, 0, 0, 0, 8);
              det.rod(x, 6.4, pz, x, 6.25, zc + side * 3.9, 0.05, mastC, 5);
              det.rod(x, 6.25, zc + side * 3.9, x, 5.35, zc + side * 3.9, 0.012, wire, 4);
            }
          }
          for (const side of [-1, 1]) {
            if (zc + side * 3.9 >= bz0 && zc + side * 3.9 < bz1 && x + 13 >= x0 && x + 13 < x1) det.rod(x + 13, 6.25, zc + side * 3.9, x + 13, 5.35, zc + side * 3.9, 0.01, wire, 4);
          }
        }
        for (const side of [-1, 1]) {
          const wz = zc + side * 3.9;
          if (wz < bz0 || wz >= bz1) continue;
          det.box(mx, 5.35, wz, len, 0.03, 0.03, wire);
          det.box(mx, 6.25, wz, len, 0.025, 0.025, wire);
        }
      } else if (p.kind === 'platform') {
        const x0 = Math.max(p.x0, bx0);
        const x1 = Math.min(p.x1, bx1);
        const zc = (p.z0 + p.z1) / 2;
        if (x1 - x0 < 0.05 || zc < bz0 || zc >= bz1) continue;
        const len = x1 - x0;
        const mx = (x0 + x1) / 2;
        det.box(mx, 0.1, zc, len, 0.12, p.z1 - p.z0, S.concrete(0xa9a79e, 0.7));
        for (const e of [-1, 1]) det.box(mx, 0.165, zc + e * 1.4, len, 0.01, 0.4, S.paint(0xd8b02a, 0.7));
        // Canopy: a long slab on posts, with a red fascia along both edges.
        const cl = Math.max(0, len - (x0 > p.x0 ? 0 : 4) - (x1 < p.x1 ? 0 : 4));
        const cxm = (x0 + x1) / 2 + ((x0 > p.x0 ? 0 : 2) - (x1 < p.x1 ? 0 : 2)) / 2;
        if (cl > 1) {
          det.box(cxm, 4.0, zc, cl, 0.18, 4.4, S.paint(0xd7dadb, 0.55));
          for (const e of [-1, 1]) det.box(cxm, 3.92, zc + e * 2.2, cl, 0.36, 0.1, S.paint(0xc8161d, 0.5));
        }
        for (let x = Math.ceil((x0 - p.x0) / 8) * 8 + p.x0 + 4; x < x1 - 2; x += 8) {
          if (x < p.x0 + 3 || x > p.x1 - 3) continue;
          for (const e of [-1, 1]) det.cyl(x, 2.0, zc + e * 1.2, 0.16, 4.0, 0.16, S.steel(0x6a6e70, 0.55), 0, 0, 0, 8);
        }
      }
    }
    if (!det.empty) this.addMesh(det.build(), mats.roofs, true, true);
  }

  /** HaMoshava's pitch: dead grass in mowing stripes, white lines, a centre circle and a goal at each end. */
  private pitch(data: ChunkData, mats: ChunkMaterials) {
    const bx0 = data.cx * CHUNK;
    const bz0 = data.cz * CHUNK;
    const bx1 = bx0 + CHUNK;
    const bz1 = bz0 + CHUNK;
    const det = new MeshBuilder();
    det.jitter = 0.02;
    const line = S.paint(0xe8e6dc, 0.7);
    const flat = (x0: number, x1: number, z0: number, z1: number, y: number, h: number, color: Parameters<MeshBuilder['box']>[6]) => {
      const ax = Math.max(x0, bx0);
      const bx = Math.min(x1, bx1);
      const az = Math.max(z0, bz0);
      const bz = Math.min(z1, bz1);
      if (bx - ax < 0.01 || bz - az < 0.01) return;
      det.box((ax + bx) / 2, y, (az + bz) / 2, bx - ax, h, bz - az, color);
    };
    for (const p of data.patches) {
      if (p.kind !== 'pitch') continue;
      const w = p.x1 - p.x0;
      const l = p.z1 - p.z0;
      const mx = (p.x0 + p.x1) / 2;
      const mz = (p.z0 + p.z1) / 2;
      const stripes = Math.round(l / 7);
      for (let i = 0; i < stripes; i++) {
        flat(p.x0, p.x1, p.z0 + (i * l) / stripes, p.z0 + ((i + 1) * l) / stripes, 0.04, 0.08, S.cloth(i % 2 ? 0x76843a : 0x6a7a34, 0.9));
      }
      const t = 0.14;
      const m = 1.2;
      // Touchlines, goal lines, halfway line.
      flat(p.x0 + m, p.x0 + m + t, p.z0 + m, p.z1 - m, 0.085, 0.01, line);
      flat(p.x1 - m - t, p.x1 - m, p.z0 + m, p.z1 - m, 0.085, 0.01, line);
      flat(p.x0 + m, p.x1 - m, p.z0 + m, p.z0 + m + t, 0.085, 0.01, line);
      flat(p.x0 + m, p.x1 - m, p.z1 - m - t, p.z1 - m, 0.085, 0.01, line);
      flat(p.x0 + m, p.x1 - m, mz - t / 2, mz + t / 2, 0.085, 0.01, line);
      // Penalty areas and six-yard boxes.
      for (const end of [-1, 1]) {
        const zEdge = end < 0 ? p.z0 + m : p.z1 - m;
        const sign = end < 0 ? 1 : -1;
        for (const [hw, dp] of [[9.2, 14], [4.4, 4.6]]) {
          flat(mx - hw, mx - hw + t, Math.min(zEdge, zEdge + sign * dp), Math.max(zEdge, zEdge + sign * dp), 0.085, 0.01, line);
          flat(mx + hw - t, mx + hw, Math.min(zEdge, zEdge + sign * dp), Math.max(zEdge, zEdge + sign * dp), 0.085, 0.01, line);
          const zl = zEdge + sign * dp;
          flat(mx - hw, mx + hw, zl - t / 2, zl + t / 2, 0.085, 0.01, line);
        }
        // The goal: two posts, a crossbar, and net bars going back.
        const gz = zEdge - sign * -0.0;
        const back = -sign * 2.0;
        const inChunk = mx >= bx0 && mx < bx1 && gz >= bz0 && gz < bz1;
        if (inChunk) {
          const gp = S.paint(0xf0f0ea, 0.5);
          for (const px of [-3.66, 3.66]) {
            det.rod(mx + px, 0, gz, mx + px, 2.44, gz, 0.06, gp, 6);
            det.rod(mx + px, 2.44, gz, mx + px, 2.1, gz + back, 0.03, gp, 5);
            det.rod(mx + px, 0, gz + back, mx + px, 2.1, gz + back, 0.025, gp, 5);
          }
          det.rod(mx - 3.66, 2.44, gz, mx + 3.66, 2.44, gz, 0.06, gp, 6);
          det.rod(mx - 3.66, 2.1, gz + back, mx + 3.66, 2.1, gz + back, 0.03, gp, 5);
        }
      }
      if (mx >= bx0 && mx < bx1 && mz >= bz0 && mz < bz1) {
        det.torus(mx, 0.09, mz, 7.0, 0.07, line, Math.PI / 2, 0, 0, 4, 40);
        det.cyl(mx, 0.09, mz, 0.4, 0.02, 0.4, line, 0, 0, 0, 10);
      }
      void w;
    }
    if (!det.empty) this.addMesh(det.build(), mats.roofs, false, true);
  }

  /** A shopfront's drawn sign: one flat panel standing just off the wall that faces the boulevard. */
  private shopFront(bs: BuildingSpec, id: ShopId) {
    const a = bs.aabb;
    const onPositiveSide = a.minX > 0;
    const geo = new THREE.PlaneGeometry(SHOP_W, SHOP_H);
    geo.rotateY(onPositiveSide ? -Math.PI / 2 : Math.PI / 2);
    geo.translate(onPositiveSide ? a.minX - 0.14 : a.maxX + 0.14, SHOP_H / 2, (a.minZ + a.maxZ) / 2);
    this.addMesh(geo, shopFrontMaterial(id), false, false);
  }

  /**
   * What makes a landmark that landmark. The Great Synagogue: a pitched tile roof, a cupola and a four-column portico.
   * City Hall, from a photograph: a tall tower with rows of narrow windows and a mast, a four-storey wing with an entrance
   * canopy and a sign over it, and a six-storey wing with a colonnade, sun-shade ledges and air-conditioning units.
   */
  private landmarkExtras(det: MeshBuilder, bs: BuildingSpec, tint: THREE.Color) {
    const a = bs.aabb;
    const cx = (a.minX + a.maxX) / 2;
    const cz = (a.minZ + a.maxZ) / 2;
    const w = a.maxX - a.minX;
    const d = a.maxZ - a.minZ;
    const y1 = a.y1;
    const stone = S.concrete(tint.clone().multiplyScalar(1.06).getHex(), 0.5);
    const stoneDark = S.concrete(tint.clone().multiplyScalar(0.78).getHex(), 0.7);
    // The facade frame: `out` runs away from the front wall, `lat` along it from its middle.
    const front = bs.front ?? 'e';
    const ew = front === 'w' || front === 'e';
    const sgn = front === 'e' || front === 'n' ? 1 : -1;
    const face = front === 'e' ? a.maxX : front === 'w' ? a.minX : front === 'n' ? a.maxZ : a.minZ;
    const latLen = ew ? d : w;
    const latMid = ew ? cz : cx;
    const box = (out: number, y: number, lat: number, dOut: number, h: number, dLat: number, color: Parameters<MeshBuilder['box']>[6]) => {
      const o = face + sgn * out;
      if (ew) det.box(o, y, latMid + lat, dOut, h, dLat, color);
      else det.box(latMid + lat, y, o, dLat, h, dOut, color);
    };
    if (bs.role === 'synagogue') {
      // Pitched tile roof running the length of the hall, a ridge cap, and a small copper-green cupola.
      const rise = 3.6;
      const half = w / 2 + 0.6;
      det.extrude(`gable:${Math.round(w * 10)}`, () => {
        const sh = new THREE.Shape();
        sh.moveTo(-half, 0);
        sh.lineTo(half, 0);
        sh.lineTo(0, rise);
        sh.closePath();
        return sh;
      }, d + 1.2, 0, cx, y1 + 0.05, cz, S.paint(0x9a4a2e, 0.85));
      det.box(cx, y1 + 0.05 + rise, cz, 0.35, 0.22, d + 1.3, stoneDark);
      det.cyl(cx, y1 + rise + 0.9, cz, 2.8, 1.8, 2.8, stone, 0, 0, 0, 10);
      det.add('dome', cx, y1 + rise + 1.8, cz, 3.2, 2.2, 3.2, S.metal(0x6f9a86, 0.55));
      det.rod(cx, y1 + rise + 3.8, cz, cx, y1 + rise + 4.8, cz, 0.05, S.metal(0xcfa84a, 0.4), 6);
      // Portico: four columns under a pediment, three steps up from the forecourt.
      for (const dz of [-4.4, -1.5, 1.5, 4.4]) {
        box(1.7, 0.2, dz, 1.3, 0.4, 1.3, stoneDark);
        det.cyl(face + sgn * 1.7, 4.4, cz + dz, 0.9, 8.0, 0.9, stone, 0, 0, 0, 12);
        box(1.7, 8.6, dz, 1.45, 0.4, 1.45, stone);
      }
      box(1.9, y1 - 0.65, 0, 3.8, 1.0, 11.8, stone);
      det.extrude('pediment', () => {
        const sh = new THREE.Shape();
        sh.moveTo(-5.9, 0);
        sh.lineTo(5.9, 0);
        sh.lineTo(0, 1.9);
        sh.closePath();
        return sh;
      }, 3.8, 0, face + sgn * 1.9, y1 - 0.15, cz, stone, 0, Math.PI / 2, 0);
      for (let i = 0; i < 3; i++) box(3.9 + i * 0.6, 0.09 * (3 - i), 0, 0.6, 0.18 * (3 - i), 12 - i * 0.5, stoneDark);
      box(0.05, 1.9, 0, 0.14, 3.6, 2.6, S.wood(0x3a2a1e, 0.7));
    } else if (bs.role === 'hallTower') {
      // Two bands of narrow windows near the top on every face, corner piers, a plant room and a lattice mast.
      const slit = S.glass(0x0e1418);
      const band = (y: number, h: number) => {
        for (const [fx, fz, alongX] of [[a.minX, cz, false], [a.maxX, cz, false], [cx, a.minZ, true], [cx, a.maxZ, true]] as const) {
          const out = fx === a.minX && !alongX ? -0.05 : fx === a.maxX && !alongX ? 0.05 : 0;
          const outZ = fz === a.minZ && alongX ? -0.05 : fz === a.maxZ && alongX ? 0.05 : 0;
          const n = 7;
          for (let i = 0; i < n; i++) {
            const t = (i - (n - 1) / 2) * 1.1;
            if (alongX) det.box(cx + t, y, fz + outZ, 0.55, h, 0.1, slit);
            else det.box(fx + out, y, cz + t, 0.1, h, 0.55, slit);
          }
        }
      };
      band(y1 - 3.4, 2.4);
      band(y1 - 6.8, 2.4);
      for (const [px, pz] of [[a.minX, a.minZ], [a.maxX, a.minZ], [a.minX, a.maxZ], [a.maxX, a.maxZ]]) det.box(px, y1 / 2, pz, 0.6, y1, 0.6, stoneDark);
      det.box(cx, y1 + 1.2, cz, w * 0.5, 2.4, d * 0.5, stone);
      const mastY = y1 + 2.4;
      for (const [mx, mz] of [[-0.35, -0.35], [0.35, -0.35], [-0.35, 0.35], [0.35, 0.35]]) det.rod(cx + mx, mastY, cz + mz, cx + mx * 0.4, mastY + 11, cz + mz * 0.4, 0.04, S.steel(0x6a6e70, 0.5), 5);
      for (let k = 1; k < 8; k++) {
        const y = mastY + k * 1.4;
        const r = 0.35 * (1 - (k * 1.4) / 11) + 0.14;
        det.rod(cx - r, y, cz - r, cx + r, y, cz - r, 0.02, S.steel(0x6a6e70, 0.5), 4);
        det.rod(cx + r, y, cz - r, cx + r, y, cz + r, 0.02, S.steel(0x6a6e70, 0.5), 4);
      }
      det.sphereAt(cx, mastY + 11.2, cz, 0.1, S.glow(0xff3a2a, 2));
    } else if (bs.role === 'hallWing') {
      // A deep entrance canopy on slim columns with a blue and yellow sign band over it, and an arcade along the rest.
      box(3.0, 4.15, 0, 6.0, 0.3, 13, stone);
      for (const lat of [-5.6, -1.9, 1.9, 5.6]) box(5.6, 2.05, lat, 0.5, 4.1, 0.5, stone);
      box(5.9, 5.0, 0, 0.3, 1.0, 13, S.paint(0x1e3f7a, 0.5));
      box(5.97, 4.62, 0, 0.3, 0.16, 13, S.paint(0xe0b020, 0.5));
      for (let lat = -latLen / 2 + 3; lat < latLen / 2 - 2; lat += 4.6) {
        if (Math.abs(lat) < 7.5) continue;
        box(1.3, 1.95, lat, 0.45, 3.9, 0.45, stone);
      }
      box(1.5, 3.95, 0, 3.0, 0.2, latLen - 4, stoneDark);
      for (let i = 0; i < 3; i++) box(6.5 + i * 0.6, 0.09 * (3 - i), 0, 0.6, 0.18 * (3 - i), 14 - i * 0.5, stoneDark);
      box(0.06, 2.1, 0, 0.14, 4.2, 6.5, S.glass(0x10181e));
      for (const [ex, ez, ew2, ed] of [[cx, a.minZ + 0.1, w, 0.2], [cx, a.maxZ - 0.1, w, 0.2]]) det.box(ex, y1 + 0.5, ez, ew2, 1.0, ed, stoneDark);
    } else if (bs.role === 'busTerminal') {
      // The Central Bus Station's hall: a long concession canopy on pilotis along the front where the buses draw up, a band of
      // dark glass behind it, ribs on the upper floors, a plant room on the roof, and the rail along its edge.
      box(2.6, 4.3, 0, 5.2, 0.3, latLen - 2, stone);
      for (let lat = -latLen / 2 + 3; lat < latLen / 2 - 1; lat += 6) box(5.0, 2.15, lat, 0.45, 4.3, 0.45, stone);
      box(0.06, 2.1, 0, 0.14, 4.0, latLen - 5, S.glass(0x10181e));
      box(5.15, 4.62, 0, 0.1, 0.5, latLen - 2, S.paint(0x0d5c3a, 0.5));
      for (let k = 1; k < bs.floors; k++) box(0.25, k * 3.3 + 1.0, 0, 0.5, 0.18, latLen, stoneDark);
      det.box(cx, y1 + 1.4, cz, w * 0.5, 2.8, d * 0.2, stoneDark);
      for (const [ex, ez, ew2, ed] of [[cx, a.minZ + 0.1, w, 0.2], [cx, a.maxZ - 0.1, w, 0.2]]) det.box(ex, y1 + 0.5, ez, ew2, 1.0, ed, stoneDark);
    } else if (bs.role === 'hallSide') {
      // Long facade towards the car park: colonnade under a shade slab, sun-shade ledges above every window row,
      // and air-conditioning units here and there; a railing round the roof.
      for (let lat = -latLen / 2 + 2.4; lat < latLen / 2 - 1; lat += 4.8) box(1.5, 1.95, lat, 0.5, 3.9, 0.5, stone);
      box(1.7, 3.95, 0, 3.4, 0.2, latLen, stoneDark);
      const ac = S.paint(0xe6e6e0, 0.6);
      for (let k = 1; k < bs.floors; k++) {
        box(0.5, k * 3.3 + 1.15, 0, 1.0, 0.12, latLen, stone);
        for (let lat = -latLen / 2 + 1.6; lat < latLen / 2 - 1; lat += 3.2) {
          if (hash2(Math.round(lat * 3) + k * 31, Math.round(face), 14) < 0.32) box(0.35, k * 3.3 + 0.55, lat, 0.7, 0.55, 0.9, ac);
        }
      }
      const rail = S.steel(0x7a7e80, 0.5);
      det.box(cx, y1 + 1.0, a.minZ + 0.1, w, 0.05, 0.05, rail);
      det.box(cx, y1 + 1.0, a.maxZ - 0.1, w, 0.05, 0.05, rail);
      det.box(a.minX + 0.1, y1 + 1.0, cz, 0.05, 0.05, d, rail);
      det.box(a.maxX - 0.1, y1 + 1.0, cz, 0.05, 0.05, d, rail);
      for (let t = 0; t < 1.001; t += 1 / Math.max(2, Math.round(w / 2.5))) det.box(a.minX + t * w, y1 + 0.5, a.maxZ - 0.1, 0.05, 1.0, 0.05, rail);
    }
  }

  private buildProps(data: ChunkData, mats: ChunkMaterials, city: boolean) {
    const b = new MeshBuilder();
    // Wasteland landmarks are drawn by the far landscape; a city has no such pass, so its few (the metro headhouse) are drawn here.
    const lm = city ? new MeshBuilder() : null;
    for (const p of data.props) {
      if (!LANDMARK_KINDS.has(p.kind)) appendProp(b, p);
      else if (lm) appendLandmark(lm, p);
    }
    if (lm && !lm.empty) this.addMesh(lm.build(), kitMaterial(), true, true);
    for (const a of data.aabbs) {
      if (a.kind === 'wall') this.wallProp(b, a);
      else if (a.kind === 'barricade' && !this.removed.has(a.id)) {
        // Barricades are separate meshes so they can be rammed or blown apart.
        const bb = new MeshBuilder();
        this.barricadeProp(bb, a);
        this.barricadeMeshes.set(a.id, this.addMesh(bb.build(), mats.props, true, true));
      }
    }
    if (!b.empty) this.addMesh(b.build(), mats.props, true, true);
  }

  /** Ruined wall: brick courses with a broken top, a few holes and rubble heaped at the base. */
  private wallProp(b: MeshBuilder, a: Aabb) {
    const w = a.maxX - a.minX;
    const d = a.maxZ - a.minZ;
    const h = a.y1;
    const along = w > d;
    const len = along ? w : d;
    const cx = (a.minX + a.maxX) / 2;
    const cz = (a.minZ + a.maxZ) / 2;
    const brick = S.concrete(0x8a5240, 0.75);
    const brick2 = S.concrete(0x7a4636, 0.8);
    const n = Math.max(2, Math.round(len / 1.2));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const k = hash2(Math.round(cx * 7) + i, Math.round(cz * 7), 3);
      // Each section stands to a different height: a jagged, collapsed top.
      const top = h * (0.62 + k * 0.38);
      const x = along ? a.minX + t * w : cx;
      const z = along ? cz : a.minZ + t * d;
      const sw = len / n + 0.02;
      b.box(x, top / 2, z, along ? sw : w, top, along ? d : sw, k > 0.5 ? brick : brick2);
      // Courses: proud bands every 0.6 m.
      for (let y = 0.3; y < top - 0.2; y += 0.6) b.box(x, y, z, along ? sw : w + 0.03, 0.05, along ? d + 0.03 : sw, S.concrete(0x9a8a7a, 0.6));
      if (k > 0.75) b.add('ico1', x, top + 0.1, z, sw * 0.7, 0.3, (along ? d : w) * 1.1, brick2, 0, k * 6, 0);
    }
    // Rubble at the foot of the wall.
    for (let i = 0; i < Math.round(len / 2); i++) {
      const k = hash2(Math.round(cx) + i * 3, Math.round(cz), 9);
      const x = along ? a.minX + (i + 0.5) * (w / Math.round(len / 2)) : cx + (k > 0.5 ? 1 : -1) * (w / 2 + 0.4);
      const z = along ? cz + (k > 0.5 ? 1 : -1) * (d / 2 + 0.4) : a.minZ + (i + 0.5) * (d / Math.round(len / 2));
      b.add('ico1', x, 0.12, z, 0.7 + k * 0.5, 0.35, 0.6 + k * 0.4, k > 0.6 ? brick : S.concrete(C.concreteDark), 0, k * 9, 0);
    }
  }

  private barricadeProp(b: MeshBuilder, a: Aabb) {
    const w = a.maxX - a.minX;
    const d = a.maxZ - a.minZ;
    const flimsy = a.breakable === 'flimsy';
    const cx = (a.minX + a.maxX) / 2;
    const cz = (a.minZ + a.maxZ) / 2;
    b.jitter = 0.07;
    if (flimsy) {
      // Scrap barricade: pallets, doors, crates and tyres lashed together.
      const n = Math.max(2, Math.round(w / 1.4));
      for (let i = 0; i < n; i++) {
        const x = a.minX + ((i + 0.5) / n) * w;
        const k = hash2(a.id, i, 11);
        const tilt = (k - 0.5) * 0.25;
        if (k < 0.33) {
          // Pallet on end.
          for (let s = 0; s < 5; s++) b.box(x - 0.5 + s * 0.25, 0.75, cz, 0.18, 1.5, 0.04, S.wood(k > 0.15 ? C.wood : C.woodDark, 0.8), 0, tilt * 0.5, tilt);
          b.box(x, 0.4, cz - 0.08, 1.2, 0.12, 0.08, S.wood(C.woodDark, 0.8), 0, tilt * 0.5, tilt);
          b.box(x, 1.2, cz - 0.08, 1.2, 0.12, 0.08, S.wood(C.woodDark, 0.8), 0, tilt * 0.5, tilt);
        } else if (k < 0.66) {
          // A door torn off a car or a house.
          b.rbox(x, 0.9, cz, 1.3, 1.7, 0.08, 0.04, S.paint(CAR_DOOR[Math.floor(k * 37) % CAR_DOOR.length], 0.9), 0.08, tilt, tilt);
        } else {
          crate(b, x, 0.45, cz, 0.9, 0.9, 0.9, k);
          spareTyre(b, x, 1.0, cz, 0.38, 0.22, Math.PI / 2, k * 3);
        }
      }
      b.rod(a.minX, 1.1, cz + 0.12, a.maxX, 1.0, cz + 0.12, 0.012, S.steel(0x5a5a5a, 0.7), 5);
      for (let i = 0; i < 3; i++) spareTyre(b, a.minX + (i + 0.5) * (w / 3), 0.12, cz + 0.5, 0.4, 0.24, 0, i);
    } else {
      // Reinforced: concrete jersey barriers capped with welded plate and razor wire.
      const n = Math.max(2, Math.round(w / 3));
      for (let i = 0; i < n; i++) {
        const x = a.minX + ((i + 0.5) / n) * w;
        b.extrude('jersey', () => {
          const s = new THREE.Shape();
          s.moveTo(-0.6, 0);
          s.lineTo(0.6, 0);
          s.lineTo(0.42, 0.28);
          s.lineTo(0.2, 1.3);
          s.lineTo(-0.2, 1.3);
          s.lineTo(-0.42, 0.28);
          s.closePath();
          return s;
        }, w / n - 0.06, 0.02, x, 0, cz, S.concrete(0xa8a49a, 0.7), 0, Math.PI / 2, 0);
        b.box(x, 0.7, cz + 0.45, w / n - 0.3, 0.12, 0.02, S.paint(C.signYellow, 0.8));
        plate(b, x, 2.05, cz, w / n - 0.1, 1.5, 0.05, i % 2 ? S.steel(0x4e5052, 0.9) : S.rust(C.rust2), 0, 0, 0);
      }
      // Razor wire coil along the top.
      const pts: [number, number, number][] = [];
      for (let i = 0; i <= w * 8; i++) {
        const t = i / (w * 8);
        const ang = t * w * 8 * 1.2;
        pts.push([a.minX + t * w, 2.95 + Math.sin(ang) * 0.18, cz + Math.cos(ang) * 0.18]);
      }
      b.pipe(pts, 0.008, S.steel(0x9a9ea2, 0.5), 4);
      for (let i = 0; i < 4; i++) b.tube(a.minX + (i + 0.5) * (w / 4) - 0.5, 0.3, cz + d * 0.4, a.minX + (i + 0.5) * (w / 4) + 0.5, 2.6, cz + d * 0.4, 0.14, S.steel(0x5a5d60, 0.8));
    }
  }

  private buildColliders(def: TerrainDef, x0: number, z0: number) {
    // Heightfield for the ground.
    this.colliders.push(this.phys.addHeightfield(x0, z0, CHUNK, CELLS, this.data.heights));
    // Rocks are solid through their mesh below, not a box.
    for (const a of this.data.aabbs) if (a.kind !== 'rock') this.addAabb(a);
    // Every solid prop collides as its own drawn geometry (furniture group: solid to people and cars, invisible to the camera).
    for (const p of this.data.props) {
      const m = propCollisionMesh(p);
      const c = m && this.phys.addPropCollider(m, GROUPS.furn);
      if (c) this.colliders.push(c);
    }
    for (const a of this.data.aabbs) {
      if (!a.pane || !a.paneN) continue;
      const [nx, nz] = a.paneN;
      this.panes.add({ key: String(a.id), kind: a.pane, c: [(a.minX + a.maxX) / 2, (a.y0 + a.y1) / 2, (a.minZ + a.maxZ) / 2], n: [nx, 0, nz], hw: Math.max(a.maxX - a.minX, a.maxZ - a.minZ) / 2, hh: (a.y1 - a.y0) / 2 });
    }
    if (this.panes.size) this.group.add(this.panes.group);
    void def;
  }

  /** Give a box a collider (a wall piece added when a wall is breached, or one of the chunk's own on load). */
  addAabb(a: Aabb) {
    if (this.aabbColliders.has(a.id)) return;
    if (a.ramp) {
      const r = a.ramp;
      const rc = this.phys.addStaticTilted(r.x, r.y, r.z, r.hx, r.hy, r.hz, r.q, GROUPS.furn);
      this.colliders.push(rc);
      this.aabbColliders.set(a.id, rc);
      return;
    }
    const hy = (a.y1 - a.y0) / 2;
    const c = this.phys.addStaticBox(
      (a.minX + a.maxX) / 2,
      (a.y1 + a.y0) / 2,
      (a.minZ + a.maxZ) / 2,
      (a.maxX - a.minX) / 2,
      hy,
      (a.maxZ - a.minZ) / 2,
      0,
      // Glass stops people and cars and takes a round, but the camera sees through it.
      a.kind === 'furniture' || a.kind === 'floor' || a.mat === 'glass' ? GROUPS.furn : GROUPS.static,
    );
    this.colliders.push(c);
    this.aabbColliders.set(a.id, c);
  }

  removeAabb(id: number) {
    this.removed.add(id);
    const bm = this.barricadeMeshes.get(id);
    if (bm) {
      bm.visible = false;
      this.barricadeMeshes.delete(id);
    }
    const c = this.aabbColliders.get(id);
    if (c) {
      this.phys.removeCollider(c);
      this.aabbColliders.delete(id);
      this.colliders = this.colliders.filter((q) => q !== c);
    }
  }

  dispose() {
    for (const c of this.colliders) this.phys.removeCollider(c);
    this.colliders = [];
    this.panes.dispose();
    for (const g of this.geos) g.dispose();
    for (const im of this.instanced) im.dispose();
    this.group.removeFromParent();
  }
}

/** Base wall colours per facade style: panel concrete, brick, stucco, curtain wall. */
export const FACADE_TINT: number[][] = [
  [0xb8b6ae, 0xa8a8a2, 0xc2bcb0, 0x9ea4a6],
  [0x9a5a44, 0x8a4c3a, 0xa86a50, 0x7e5244],
  [0xd2c6a8, 0xc8b8a0, 0xb8b0a0, 0xd8cbb8],
  [0x5a6670, 0x4e5a62, 0x66707a, 0x56626a],
];
const AWNING = [0x8a2a24, 0x2a5a3a, 0x2a4a6a, 0xa87a2a, 0x5a3a5a];
/** Rendered walls of an Israeli apartment block: warm white, cream, Jerusalem-stone sand, a little pink. */
const ISRAELI_TINT = [0xe6dcc6, 0xdccfb2, 0xe9e2d0, 0xd6c6a2, 0xcdbf9f, 0xe2d2b8, 0xefe8da, 0xd9c8b4, 0xcfc4b0, 0xe0cfc0];
const CAR_DOOR = [0x8a4b2d, 0x5d7a8a, 0xc8c3b6, 0x6b6e5a];
