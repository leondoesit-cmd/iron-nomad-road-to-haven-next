import * as THREE from 'three';
import { staticTransform } from './staticTransform';
import { CHUNK, corridorHalf, heightAt, roadX, type TerrainDef } from '../world/terrain';
import { hash2, noise2 } from '../core/rng';
import { smoothstep } from '../core/math';
import { FACADE_TINT, cliffDetail } from './chunkview';
import type { BuildingSpec } from '../world/chunkgen';
import { makeTerrainMaterial, type TerrainUniforms } from './terrainMaterial';
import { forestAt, lushAt } from '../world/hydro';
import { dryGround, mixDry, mixWater, wetGround, type GroundMix } from './groundMix';
import { farForestMaterial, farForestMeshes, planFarForest, treeWarmup, type FarTree } from './trees';
import { scatterWarmup } from './scatter';
import { FacadeBuilder, facadeMaterial, farFacadeMaterial } from './facade';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshBuilder } from './builder';
import { kitMaterial } from './materials';
import { appendLandmark, LANDMARK_KINDS } from './landmarks';
import { BuildingView } from './buildingView';
import { BuildingBatches } from './buildingBatch';
import type { LegLayout } from '../world/layout';
import { shoreShade } from '../world/lakes';
import { buildLakeWater, buildSpringWater, buildSwampWater } from './water';
import { buildRiverWater } from './riverWater';
import { FAR_SINK, farGridAxes } from './drawnGround';

/** The far forest's plan per leg: the same every time a scene of that leg is built, so it is worked out once. */
const FAR_PLANS = new WeakMap<TerrainDef, FarTree[][]>();
import { FarDetail } from './farDetail';

/**
 * Scenery beyond the streamed chunks. In the wasteland, one coarse terrain mesh covers the whole leg out to
 * the mountains and punches a hole wherever a detailed chunk is loaded, so the view runs to the haze instead
 * of a fog wall. In the city, a skyline of towers stands behind the corridor using the facade shader.
 */
export class Landscape {
  group = staticTransform(new THREE.Group());
  private loadedTex: THREE.DataTexture | null = null;
  private loaded: Uint8Array | null = null;
  private cx0 = 0;
  private cz0 = 0;
  private cw = 0;
  private ch = 0;
  private geos: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  /** Lakes, swamps, spring pools, rivers and falls. */
  private water: { dispose(): void }[] = [];
  /** Roads and standout props beyond the streamed chunks. */
  private farDetail: FarDetail | null = null;
  /** Every roadside building of the leg, each cut away on its own when someone steps inside. */
  buildings: BuildingView[] = [];
  /** Far cells of those buildings, drawn two calls a cell (`buildingBatch.ts`). */
  private batches: BuildingBatches | null = null;

  /** The far mesh's grid (open world), to stand the far forest on exactly what is drawn, and the loaded-chunk mask. */
  private farGrid: { us: number[]; zs: number[]; pos: Float32Array } | null = null;
  private lod: TerrainUniforms | null = null;
  /** The far forest, one impostor mesh per region, and the meshes that compile the vegetation's shaders at load. */
  private farTrees: THREE.InstancedMesh[] = [];

  constructor(
    private def: TerrainDef,
    layout?: Pick<LegLayout, 'rural' | 'props'>,
    cityBuildings?: BuildingSpec[],
  ) {
    if (def.biome === 'wasteland') {
      const lod = this.buildFarTerrain();
      this.buildFarForest();
      this.farDetail = new FarDetail(def, layout?.props ?? [], lod);
      this.group.add(this.farDetail.group);
      this.buildLakes();
      if (layout) this.buildSettlements(layout);
      if (def.open && cityBuildings?.length) this.buildDistrictFar(cityBuildings);
    } else {
      this.buildSkyline();
      // City trades (a garage, a dealership, a depot) are real buildings with interiors, drawn like the roadside ones.
      if (layout?.rural.length) this.buildSettlements(layout);
    }
    for (const child of this.group.children) staticTransform(child);
    this.farDetail?.group.traverse(staticTransform);
  }

  /**
   * Plain walls and roofs for every building of a district, so Petah Tikva shows on the horizon before its chunks stream in.
   * The whole district is one mesh: each building folds away once its chunk is loaded in detail (`farFacadeMaterial`), so it
   * costs one draw however many chunks it spans (a chunk's worth of walls is a few dozen triangles, not worth a draw).
   */
  private buildDistrictFar(buildings: BuildingSpec[]) {
    const byChunk = new Map<string, FacadeBuilder>();
    for (const bs of buildings) {
      const a = bs.aabb;
      const key = `${Math.floor((a.minX + a.maxX) / 2 / CHUNK)}:${Math.floor((a.minZ + a.maxZ) / 2 / CHUNK)}`;
      let fb = byChunk.get(key);
      if (!fb) byChunk.set(key, (fb = new FacadeBuilder()));
      const k = hash2(Math.round(a.minX), Math.round(a.maxZ), 78);
      const tall = bs.floors >= 9;
      const style = bs.style ?? (tall ? (k < 0.35 ? 3 : k < 0.75 ? 0 : 2) : k < 0.45 ? 1 : k < 0.75 ? 2 : 0);
      const seed = hash2(Math.round(a.minX * 2), Math.round(a.minZ * 2), 77);
      const tint = new THREE.Color(bs.tint ?? FACADE_TINT[style][Math.floor(seed * FACADE_TINT[style].length) % FACADE_TINT[style].length]);
      const h = a.y1 + (bs.stepped ? 6.6 : 0);
      const corners: [number, number][] = [[a.minX, a.maxZ], [a.maxX, a.maxZ], [a.maxX, a.minZ], [a.minX, a.minZ], [a.minX, a.maxZ]];
      for (let i = 0; i < 4; i++) {
        const [ax, az] = corners[i];
        const [bx, bz] = corners[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        const target = style === 3 ? 1.6 : 2.6 + seed * 0.7;
        fb.wall(ax, az, bx, bz, 0, h, 0, tint, style, seed * 97 + i * 0.37, 3.3, len / Math.max(1, Math.round(len / target)));
      }
      const b = fb.pos.length / 3;
      fb.pos.push(a.minX, h, a.minZ, a.minX, h, a.maxZ, a.maxX, h, a.maxZ, a.maxX, h, a.minZ);
      for (let i = 0; i < 4; i++) {
        fb.nor.push(0, 1, 0);
        fb.col.push(0.3, 0.3, 0.3);
        fb.uv.push(0, -100);
        fb.fd.push(0, 0, 3.3, 3);
      }
      fb.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    if (!this.lod || !byChunk.size) return;
    // Every vertex carries the centre of its building's chunk, where the loaded-chunk mask is read.
    const parts: THREE.BufferGeometry[] = [];
    for (const [key, fb] of byChunk) {
      const g = fb.build();
      const [cx, cz] = key.split(':').map(Number);
      const at = new Float32Array(g.attributes.position.count * 2);
      for (let i = 0; i < at.length; i += 2) {
        at[i] = (cx + 0.5) * CHUNK;
        at[i + 1] = (cz + 0.5) * CHUNK;
      }
      g.setAttribute('lodAt', new THREE.BufferAttribute(at, 2));
      parts.push(g);
    }
    const g = mergeGeometries(parts)!;
    for (const p of parts) p.dispose();
    g.computeBoundingSphere();
    this.geos.push(g);
    const mat = farFacadeMaterial(this.lod);
    this.mats.push(mat);
    const m = new THREE.Mesh(g, mat);
    m.receiveShadow = false;
    m.name = 'cityFar';
    this.group.add(m);
  }

  /**
   * Every roadside building and landmark of the leg, merged into one mesh per 256 m cell. They are drawn from here
   * whether or not their chunk is streamed, so a gas station or a wind farm shows on the horizon minutes ahead.
   */
  private buildSettlements(layout: Pick<LegLayout, 'rural' | 'props'>) {
    const CELL_M = 256;
    const key = (x: number, z: number) => `${Math.floor(x / CELL_M)}:${Math.floor(z / CELL_M)}`;
    const cells = new Map<string, { det: MeshBuilder }>();
    const cell = (x: number, z: number) => {
      const k = key(x, z);
      let c = cells.get(k);
      if (!c) {
        c = { det: new MeshBuilder() };
        cells.set(k, c);
      }
      return c;
    };
    for (const b of layout.rural) {
      const v = new BuildingView(b);
      this.buildings.push(v);
      this.group.add(v.group);
    }
    this.batches = new BuildingBatches(this.buildings);
    this.group.add(this.batches.group);
    // A city leg's chunks draw its landmarks themselves (see ChunkView.buildProps); only the wasteland needs them here.
    for (const p of layout.props) {
      if (this.def.biome !== 'city' && LANDMARK_KINDS.has(p.kind)) appendLandmark(cell(p.x, p.z).det, p);
    }
    const addMesh = (g: THREE.BufferGeometry, mat: THREE.Material) => {
      this.geos.push(g);
      const m = new THREE.Mesh(g, mat);
      m.castShadow = true;
      m.receiveShadow = true;
      this.group.add(m);
    };
    for (const c of cells.values()) {
      if (!c.det.empty) addMesh(c.det.build(), kitMaterial());
    }
  }

  private buildFarTerrain(): TerrainUniforms {
    const def = this.def;
    // Chunk grid the hole mask covers.
    const open = def.open;
    // The grid is shared with `DrawnGround`, which lays the rivers over this mesh where it is what is drawn.
    const { halfW, z0, z1, us, zs } = farGridAxes(def);
    this.cx0 = Math.floor((-halfW - 200) / CHUNK);
    this.cw = Math.ceil((halfW + 200) / CHUNK) - this.cx0 + 1;
    this.cz0 = Math.floor(z0 / CHUNK);
    this.ch = Math.ceil(z1 / CHUNK) - this.cz0 + 1;
    this.loaded = new Uint8Array(this.cw * this.ch * 4);
    this.loadedTex = new THREE.DataTexture(this.loaded, this.cw, this.ch, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.loadedTex.magFilter = THREE.NearestFilter;
    this.loadedTex.minFilter = THREE.NearestFilter;
    this.loadedTex.needsUpdate = true;
    const lod: TerrainUniforms = {
      tLoaded: { value: this.loadedTex },
      uLoadedRect: { value: new THREE.Vector4(this.cx0 * CHUNK, this.cz0 * CHUNK, this.cw * CHUNK, this.ch * CHUNK) },
    };
    const mat = makeTerrainMaterial('wasteland', lod, def.theme);
    this.mats.push(mat);
    this.lod = lod;
    // Lush and wooded land is packed into tdata exactly as the detailed chunks pack it, so the two meshes agree.
    const green = !!(open && def.hydro?.lush);
    const gm: GroundMix = { sand: 0, earth: 0, rock: 0, gravel: 0, wet: 0, tr: 1, tg: 1, tb: 1 };
    // A grid in (offset from the road, z): dense near the canyon, coarse toward the mountains (`farGridAxes`).
    const cols = us.length;
    const rows = zs.length;
    const pos = new Float32Array(cols * rows * 3);
    const col = new Float32Array(cols * rows * 3);
    const spl = new Float32Array(cols * rows * 4);
    const tda = new Float32Array(cols * rows * 4);
    for (let r = 0; r < rows; r++) {
      const z = zs[r];
      const rx = roadX(def, z);
      for (let c = 0; c < cols; c++) {
        // In the open world the grid is laid over the map, not strung along the road.
        const x = (open ? 0 : rx) + us[c];
        // Slightly below the detailed chunks, so any seam hides under them.
        const h = heightAt(def, x, z) + cliffDetail(def, x, z) - FAR_SINK;
        const i = r * cols + c;
        pos[i * 3] = x;
        pos[i * 3 + 1] = h;
        pos[i * 3 + 2] = z;
        const d = Math.abs(x - rx);
        const cliff = smoothstep(corridorHalf(def, z) + 1, corridorHalf(def, z) + 10, d);
        const L = green ? lushAt(def, x, z) : 0;
        const F = L > 0.42 ? forestAt(def, x, z) : 0;
        const sand = smoothstep(0.5, 0.78, noise2(x / 36 + 3, z / 36, def.seed + 72)) * (1 - cliff) * (1 - L * 0.8);
        const k = 0.93 + hash2(c, r, 5) * 0.14;
        gm.sand = sand;
        gm.earth = (1 - cliff) * ((1 - sand) * 0.8 + L * 0.3);
        gm.rock = cliff;
        gm.gravel = (1 - cliff) * 0.2 * (1 - L * 0.85);
        gm.wet = 0;
        gm.tr = gm.tg = gm.tb = 1;
        // Shores, banks and beds read the same as in the detailed chunks.
        const wg = wetGround(def, x, z, h + FAR_SINK);
        if (wg) mixWater(gm, wg);
        const dg = dryGround(def, x, z);
        if (dg) mixDry(gm, dg);
        col[i * 3] = k * gm.tr;
        col[i * 3 + 1] = k * gm.tg;
        col[i * 3 + 2] = k * gm.tb;
        spl[i * 4] = gm.sand;
        spl[i * 4 + 1] = gm.earth;
        spl[i * 4 + 2] = gm.rock;
        spl[i * 4 + 3] = gm.gravel;
        tda[i * 4] = 1;
        tda[i * 4 + 1] = gm.wet;
        tda[i * 4 + 2] = L;
        tda[i * 4 + 3] = F;
      }
    }
    if (open) this.farGrid = { us, zs, pos };
    const idx: number[] = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c;
        const b = a + 1;
        const d = a + cols;
        const e = d + 1;
        idx.push(a, d, e, a, e, b);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('splat', new THREE.BufferAttribute(spl, 4));
    g.setAttribute('tdata', new THREE.BufferAttribute(tda, 4));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    this.geos.push(g);
    const m = new THREE.Mesh(g, mat);
    m.receiveShadow = true;
    m.frustumCulled = false;
    this.group.add(m);
    return lod;
  }

  /**
   * The far forest: impostor trees over every wood of the open world out to the haze (`planFarForest`), one mesh per
   * region so the views cull them, each tree hidden while its chunk is loaded (the chunk draws its own). With it go the
   * meshes that have the vegetation's shaders compiled now rather than when the first wood streams in.
   */
  private buildFarForest() {
    const def = this.def;
    if (!def.open || !def.hydro?.lush || !this.farGrid || !this.lod) return;
    let plan = FAR_PLANS.get(def);
    if (!plan) {
      const G = (x: number, z: number) => this.farGroundAt(x, z);
      plan = planFarForest(def, G, (x, z) => Math.hypot(G(x + 3, z) - G(x - 3, z), G(x, z + 3) - G(x, z - 3)) / 6);
      FAR_PLANS.set(def, plan);
    }
    const mat = farForestMaterial(this.lod);
    this.mats.push(mat);
    for (const im of [...farForestMeshes(plan, mat), ...treeWarmup(), ...scatterWarmup()]) {
      this.group.add(im);
      this.farTrees.push(im);
    }
  }

  /** Height of the far mesh at a point, on the same triangles it is drawn with (the terrain itself off its grid). */
  private farGroundAt(x: number, z: number): number {
    const { us, zs, pos } = this.farGrid!;
    const cols = us.length;
    if (x <= us[0] || x >= us[cols - 1] || z <= zs[0] || z >= zs[zs.length - 1]) return heightAt(this.def, x, z) - FAR_SINK;
    let lo = 0;
    let hi = cols - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (us[mid] <= x) lo = mid;
      else hi = mid;
    }
    const r = Math.min(zs.length - 2, Math.floor((z - zs[0]) / (zs[1] - zs[0])));
    const tx = (x - us[lo]) / (us[lo + 1] - us[lo]);
    const tz = (z - zs[r]) / (zs[r + 1] - zs[r]);
    const H = (c: number, rr: number) => pos[(rr * cols + c) * 3 + 1];
    const a = H(lo, r);
    const b = H(lo + 1, r);
    const d = H(lo, r + 1);
    const e = H(lo + 1, r + 1);
    // Triangles (a, d, e) and (a, e, b), as the index buffer splits each cell.
    return tz > tx ? a + (e - d) * tx + (d - a) * tz : a + (b - a) * tx + (e - b) * tz;
  }

  /**
   * Per view, before it renders: cut away the building the viewer's focus is in (roof and upper storeys), leave
   * every other one whole, and drop furniture for cameras too far away to see through a window.
   */
  updateView(focus: { x: number; y: number; z: number } | null, camX: number, camY: number, camZ: number) {
    for (const b of this.buildings) b.setView(focus, camX, camY, camZ);
    this.batches?.updateView(camX, camZ);
  }

  /**
   * All the water of the leg, drawn whole: a sheet per lake and per swamp, one mesh for every spring pool, and in the open
   * world one for every river and stream and one for every waterfall.
   */
  private buildLakes() {
    for (const l of this.def.lakes) {
      const w = buildLakeWater(l);
      this.water.push(w);
      this.group.add(w.mesh);
    }
    const hy = this.def.hydro;
    if (!hy?.ready) return;
    for (const s of hy.swamps) {
      const w = buildSwampWater(this.def, s);
      this.water.push(w);
      this.group.add(w.mesh);
    }
    const springs = buildSpringWater(this.def, hy.springs);
    if (springs) {
      this.water.push(springs);
      this.group.add(springs.mesh);
    }
    const rivers = buildRiverWater(this.def, this.lod ?? undefined);
    if (rivers) {
      this.water.push(rivers);
      this.group.add(rivers.group);
    }
  }

  /**
   * How far a detailed chunk is in, 0..1 each: `ground` is its ground (the far terrain, the far forest and the far rivers
   * step aside), `built` the whole chunk (the far roads, props and district buildings step aside). In between, the far
   * side dissolves out pixel for pixel as the chunk dissolves in (`dissolve.ts`): the mask holds the fade itself.
   */
  setFade(cx: number, cz: number, ground: number, built: number) {
    if (!this.loaded || !this.loadedTex) return;
    const x = cx - this.cx0;
    const z = cz - this.cz0;
    if (x < 0 || z < 0 || x >= this.cw || z >= this.ch) return;
    const i = (z * this.cw + x) * 4;
    const r = Math.round(Math.min(1, Math.max(0, ground)) * 255);
    const g = Math.round(Math.min(1, Math.max(0, built)) * 255);
    if (this.loaded[i] === r && this.loaded[i + 1] === g) return;
    this.loaded[i] = r;
    this.loaded[i + 1] = g;
    this.loadedTex.needsUpdate = true;
  }

  /** Towers behind the city corridor, standing on the rubble slopes. */
  private buildSkyline() {
    const def = this.def;
    const fb = new FacadeBuilder();
    const tints = [0xa8a8a2, 0x9a5a44, 0xc8b8a0, 0x5a6670, 0xb8b6ae, 0x8a4c3a];
    for (let z = -400; z < def.length + 600; z += 26) {
      for (const side of [-1, 1]) {
        for (let row = 0; row < 3; row++) {
          const k = hash2(Math.round(z), side * 7 + row, def.seed + 3);
          if (k < 0.35) continue;
          const cx = side * (175 + row * 95 + k * 50);
          const w = 18 + k * 22;
          const dz = 14 + hash2(Math.round(z), row, 9) * 16;
          const gz = z + (k - 0.5) * 10;
          const base = heightAt(def, cx, gz) - 2;
          const hgt = 25 + k * k * 110 + row * 15;
          const style = k > 0.8 ? 3 : Math.floor(k * 7) % 3;
          const tint = new THREE.Color(tints[Math.floor(k * 61) % tints.length]);
          const x0 = cx - w / 2;
          const x1 = cx + w / 2;
          const z0 = gz - dz / 2;
          const z1 = gz + dz / 2;
          const corners: [number, number][] = [[x0, z1], [x1, z1], [x1, z0], [x0, z0], [x0, z1]];
          for (let i = 0; i < 4; i++) {
            const [ax, az] = corners[i];
            const [bx, bz] = corners[i + 1];
            const len = Math.hypot(bx - ax, bz - az);
            fb.wall(ax, az, bx, bz, base, base + hgt, 0, tint, style, k * 97 + i, 3.3, len / Math.max(1, Math.round(len / 3)));
          }
          // Roof cap.
          const b = fb.pos.length / 3;
          fb.pos.push(x0, base + hgt, z0, x0, base + hgt, z1, x1, base + hgt, z1, x1, base + hgt, z0);
          for (let i = 0; i < 4; i++) {
            fb.nor.push(0, 1, 0);
            fb.col.push(0.3, 0.3, 0.3);
            fb.uv.push(0, -100);
            fb.fd.push(0, 0, 3.3, 3);
          }
          fb.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
        }
      }
    }
    const g = fb.build();
    this.geos.push(g);
    const m = new THREE.Mesh(g, facadeMaterial());
    m.frustumCulled = false;
    m.receiveShadow = false;
    this.group.add(m);
  }

  dispose() {
    this.farDetail?.dispose();
    for (const w of this.water) w.dispose();
    for (const b of this.buildings) b.dispose();
    this.batches?.dispose();
    for (const g of this.geos) g.dispose();
    for (const im of this.farTrees) im.dispose();
    for (const m of this.mats) m.dispose();
    this.loadedTex?.dispose();
    this.group.removeFromParent();
  }
}
