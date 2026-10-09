import * as THREE from 'three';
import { makeTerrainMaterial, type DeformUniforms, type GroundTheme } from './terrainMaterial';
import { DCELL, TILE, TILE_N, packLook, type GroundField, type GroundTile } from '../sim/groundField';
import { CELLS } from '../world/terrain';
import type { ChunkView } from './chunkview';

/**
 * Draws the loose ground's fine height field (`sim/groundField.ts`): every tile somebody has driven, walked or shot over
 * near a camera is drawn as a 4 cm grid in place of its 2 m cell of the ground mesh, whose own two triangles are hidden
 * meanwhile (`ChunkView.hideCell`). The tiles are instanced grids drawn with a variant of the ground's own material
 * (`makeTerrainMaterial(..., deform)`), so an untouched corner of a tile is the ground mesh exactly, and a rut, a berm or
 * a crater is lit, textured and shaded just as the ground round it is.
 *
 * Each drawn tile has a layer of `tex` (its heights and how turned its soil is, with a ring of the neighbours' vertices for
 * its normals) and a row of `base` (the ground mesh's four corners of its cell). A tile is drawn finer close to a camera
 * and coarser farther off, out to `LOD_FAR`; beyond it the ground mesh takes the cell back (the tyre track ribbons carry
 * the look of a track on into the distance).
 */

/** Tiles drawn at once. */
const SLOTS = 640;
/** Neighbours' vertices round a tile in its layer: one for its normals, the rest for the shadows its own relief casts. */
const HALO = 5;
/** Side of a tile's layer: its 51 vertices and the ring of its neighbours'. */
const LW = TILE_N + 1 + 2 * HALO;
/** Texels per tile of the base table. */
const BASE_W = 16;
/** Out to how far (m, from the nearest camera) each grid draws a tile: every vertex, every second, every fifth. */
const LOD_FAR = [26, 64, 130];
/** The same for a tile with a crater in it: a hole a hand across is lost on a coarser grid. */
const LOD_FINE = [48, 90, 130];
const STEPS = [1, 2, 5];
/** Layers re-sent to the GPU per frame at most (beyond that a tile shows its last shape a frame or two longer). */
const UPLOADS = 20;
/** Frames between re-choosing which tiles are drawn. */
const CHOOSE_EVERY = 8;

export interface DeformHost {
  /** The loaded chunk whose ground mesh holds a terrain cell (one tile), or null. */
  view(tx: number, tz: number): ChunkView | null;
  /**
   * Compile meshes made after the scene was warmed, without blocking. Until a group's material is ready its tiles wait,
   * and the ground mesh keeps their cells: a cell hidden with nothing drawn over it would be a hole in the world.
   */
  compile?(objects: THREE.Object3D[]): Promise<unknown>;
}

interface Slot {
  tile: GroundTile;
  key: number;
  /** Version of the tile last sent to the GPU; -1 never. */
  sent: number;
  /** Chunk the tile's cell is hidden in (null: none yet, or a cliff face that cannot be drawn). */
  view: ChunkView | null;
  base: THREE.Material | null;
  /** Distance to the nearest camera, m. */
  d: number;
}

interface Group {
  material: THREE.MeshStandardMaterial;
  /** Its program is compiled: its tiles may take their cells. */
  ready: boolean;
  lods: { mesh: THREE.Mesh; geo: THREE.InstancedBufferGeometry; attr: THREE.InstancedBufferAttribute; n: number }[];
}

function gridGeometry(step: number): THREE.InstancedBufferGeometry {
  const n = TILE_N / step;
  const N1 = n + 1;
  const pos = new Float32Array((N1 * N1 + 4 * N1) * 3);
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const k = (j * N1 + i) * 3;
      pos[k] = i * step;
      pos[k + 2] = j * step;
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * N1 + i;
      const b = a + 1;
      const d = a + N1;
      const e = d + 1;
      // The ground mesh's own winding.
      idx.push(a, d, e, a, e, b);
    }
  }
  // Skirts under each edge (both windings, as the ground mesh's): a coarser neighbour never shows a crack.
  const edges: number[][] = [[], [], [], []];
  for (let k = 0; k <= n; k++) {
    edges[0].push(k);
    edges[1].push(n * N1 + k);
    edges[2].push(k * N1);
    edges[3].push(k * N1 + n);
  }
  let sv = N1 * N1;
  for (const e of edges) {
    const start = sv;
    for (const vi of e) {
      pos[sv * 3] = pos[vi * 3];
      pos[sv * 3 + 1] = 1;
      pos[sv * 3 + 2] = pos[vi * 3 + 2];
      sv++;
    }
    for (let k = 0; k < n; k++) {
      const a = e[k];
      const b = e[k + 1];
      const as = start + k;
      const bs = start + k + 1;
      idx.push(a, b, as, b, bs, as, a, as, b, b, as, bs);
    }
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-1e7, -1e7, -1e7), new THREE.Vector3(1e7, 1e7, 1e7));
  g.instanceCount = 0;
  return g;
}

export class GroundDeform {
  readonly group = new THREE.Group();
  readonly tex: THREE.DataArrayTexture;
  readonly base: THREE.DataTexture;
  private slots: (Slot | null)[] = new Array(SLOTS).fill(null);
  private free: number[] = [];
  private byKey = new Map<number, number>();
  private groups = new Map<THREE.Material, Group>();
  private uniforms: DeformUniforms;
  private corners = new Float32Array(60);
  private grids = STEPS.map(gridGeometry);
  private frame = 0;
  private madeSeen = -1;
  /** Tiles drawn and layers sent this frame, for tests and the debug overlay. */
  drawn = 0;
  sent = 0;

  constructor(
    private field: GroundField,
    private host: DeformHost,
  ) {
    for (let s = SLOTS - 1; s >= 0; s--) this.free.push(s);
    const tex = new THREE.DataArrayTexture(new Float32Array(LW * LW * 2 * SLOTS), LW, LW, SLOTS);
    tex.format = THREE.RGFormat;
    tex.type = THREE.FloatType;
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.unpackAlignment = 4;
    tex.needsUpdate = true;
    this.tex = tex;
    const base = new THREE.DataTexture(new Float32Array(BASE_W * 4 * SLOTS), BASE_W, SLOTS, THREE.RGBAFormat, THREE.FloatType);
    base.minFilter = base.magFilter = THREE.NearestFilter;
    base.generateMipmaps = false;
    base.needsUpdate = true;
    this.base = base;
    this.uniforms = { tDeform: { value: tex }, tDeformBase: { value: base }, sun: { value: new THREE.Vector4() }, n: TILE_N, cell: DCELL, size: TILE, halo: HALO };
    this.group.name = 'ground:deform';
  }

  /** The instanced meshes that draw tiles over ground drawn with `base` (one material per biome and theme). */
  private groupFor(base: THREE.Material): Group {
    const g = this.groups.get(base);
    if (g) return g;
    const info = base.userData.terrain as { biome: 'wasteland' | 'city'; theme: GroundTheme } | undefined;
    const material = makeTerrainMaterial(info?.biome ?? 'wasteland', undefined, info?.theme ?? 'dust', this.uniforms);
    const lods = this.grids.map((grid, k) => {
      const geo = new THREE.InstancedBufferGeometry();
      geo.index = grid.index;
      geo.setAttribute('position', grid.attributes.position);
      geo.boundingSphere = grid.boundingSphere;
      geo.boundingBox = grid.boundingBox;
      const attr = new THREE.InstancedBufferAttribute(new Float32Array(SLOTS * 3), 3);
      attr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aTile', attr);
      geo.instanceCount = 0;
      const mesh = new THREE.Mesh(geo, material);
      mesh.name = `ground:deform:${k}`;
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.visible = false;
      mesh.matrixAutoUpdate = false;
      // The grid's own positions are not where it is drawn: nothing should pick it.
      mesh.raycast = () => {};
      this.group.add(mesh);
      return { mesh, geo, attr, n: 0 };
    });
    const group: Group = { material, lods, ready: !this.host.compile };
    this.groups.set(base, group);
    this.host.compile?.(lods.map((l) => l.mesh)).then(
      () => (group.ready = true),
      () => (group.ready = true),
    );
    return group;
  }

  /** The materials it draws with, so a warm-up can compile them before the first rut. */
  materials(): THREE.Material[] {
    return [...this.groups.values()].map((g) => g.material);
  }

  /** Make (and so compile ahead) the variant for a ground material. */
  prepare(base: THREE.Material): THREE.Mesh[] {
    return this.groupFor(base).lods.map((l) => l.mesh);
  }

  /**
   * Once per rendered frame: choose the tiles near the cameras, bind them to their cells, send what changed, lay out the
   * draws. `sun` (unit, toward the sun) aims the shadows the field's own relief casts.
   */
  update(cams: { x: number; z: number }[], sun?: THREE.Vector3) {
    this.frame++;
    const u = this.uniforms.sun.value;
    if (sun) {
      const h = Math.hypot(sun.x, sun.z);
      // The march runs a texel at a time toward the sun: its step in texels, the sun's height as a slope, and how much it
      // counts (none at night: headlights and fires light a rut from wherever they are).
      u.set(h > 1e-4 ? sun.x / h : 0, h > 1e-4 ? sun.z / h : 0, sun.y / Math.max(h, 1e-3), Math.min(1, Math.max(0, (sun.y - 0.02) / 0.1)));
    } else u.set(0, 0, 1, 0);
    // A new tile (a first rut, a crater in untouched ground) is drawn at once; otherwise a look round now and then.
    if (this.frame % CHOOSE_EVERY === 1 || this.free.length === SLOTS || this.field.made !== this.madeSeen) {
      this.madeSeen = this.field.made;
      this.choose(cams);
    }
    for (let s = 0; s < SLOTS; s++) {
      const slot = this.slots[s];
      if (!slot) continue;
      if (this.field.tiles.get(slot.key) !== slot.tile) {
        this.release(s);
        continue;
      }
      this.bind(s, slot);
      slot.d = this.distance(slot.tile, cams);
    }
    this.upload();
    this.layout();
  }

  private distance(t: GroundTile, cams: { x: number; z: number }[]): number {
    const cx = t.x0 + TILE / 2;
    const cz = t.z0 + TILE / 2;
    let d = Infinity;
    for (const c of cams) d = Math.min(d, Math.hypot(c.x - cx, c.z - cz));
    return d;
  }

  /** Which tiles are worth drawing: the nearest within the far grid's reach, as many as there are layers. */
  private choose(cams: { x: number; z: number }[]) {
    const far = LOD_FAR[LOD_FAR.length - 1];
    const want: { t: GroundTile; d: number }[] = [];
    for (const t of this.field.tiles.values()) {
      const d = this.distance(t, cams);
      if (d < far) want.push({ t, d });
    }
    want.sort((a, b) => a.d - b.d);
    if (want.length > SLOTS) want.length = SLOTS;
    const keep = new Set<number>();
    for (const w of want) keep.add(w.t.key);
    for (let s = 0; s < SLOTS; s++) {
      const slot = this.slots[s];
      if (slot && !keep.has(slot.key)) this.release(s);
    }
    for (const w of want) {
      if (this.byKey.has(w.t.key)) continue;
      const s = this.free.pop();
      if (s === undefined) break;
      const slot: Slot = { tile: w.t, key: w.t.key, sent: -1, view: null, base: null, d: w.d };
      this.slots[s] = slot;
      this.byKey.set(slot.key, s);
      this.bind(s, slot);
    }
  }

  /** Tie a slot to the ground mesh its cell is in now (a chunk reloaded is a new mesh): its corners, its hidden cell. */
  private bind(s: number, slot: Slot) {
    const t = slot.tile;
    const view = this.host.view(t.tx, t.tz);
    if (view === slot.view) return;
    const cx = Math.floor(t.tx / CELLS);
    const cz = Math.floor(t.tz / CELLS);
    // A different view here means the old one was unloaded (one view per chunk): its mesh is gone, nothing to give back.
    slot.view = null;
    slot.base = null;
    if (!view?.terrainMesh) return;
    // Not before the tiles' material can draw (`DeformHost.compile`): the cell stays the ground mesh's until then.
    if (!this.groupFor(view.terrainMesh.material as THREE.Material).ready) return;
    const c = t.tx - cx * CELLS;
    const r = t.tz - cz * CELLS;
    slot.view = view;
    if (!view.cellCorners(c, r, this.corners)) return;
    const data = this.base.image.data as Float32Array;
    data.set(this.corners, s * BASE_W * 4);
    this.base.addUpdateRange(s * BASE_W * 4, 60);
    this.base.needsUpdate = true;
    slot.base = view.terrainMesh.material as THREE.Material;
    // Its layer goes up with the cell hidden, the same frame: the slot may hold another tile's old shape.
    this.fill(s, t);
    slot.sent = t.version;
    view.hideCell(c, r, true);
  }

  private release(s: number) {
    const slot = this.slots[s];
    if (!slot) return;
    const t = slot.tile;
    if (slot.view && slot.base && this.host.view(t.tx, t.tz) === slot.view) {
      const cx = Math.floor(t.tx / CELLS);
      const cz = Math.floor(t.tz / CELLS);
      slot.view.hideCell(t.tx - cx * CELLS, t.tz - cz * CELLS, false);
    }
    this.slots[s] = null;
    this.byKey.delete(slot.key);
    this.free.push(s);
  }

  /** Send the tiles that changed since they were last sent, nearest first, up to the frame's budget. */
  private upload() {
    this.sent = 0;
    const stale: number[] = [];
    for (let s = 0; s < SLOTS; s++) {
      const slot = this.slots[s];
      if (slot && slot.base && slot.sent !== slot.tile.version) stale.push(s);
    }
    if (stale.length > UPLOADS) stale.sort((a, b) => this.slots[a]!.d - this.slots[b]!.d);
    for (let k = 0; k < stale.length && k < UPLOADS; k++) {
      const slot = this.slots[stale[k]]!;
      this.fill(stale[k], slot.tile);
      slot.sent = slot.tile.version;
    }
  }

  /**
   * Write a tile's layer: its own vertices, then the ring of its eight neighbours' it is drawn with, copied straight out of
   * their arrays (a neighbour the field does not hold is flat).
   */
  private fill(s: number, t: GroundTile) {
    const data = this.tex.image.data as unknown as Float32Array;
    const o = s * LW * LW * 2;
    const f = this.field;
    for (let dz = -1; dz <= 1; dz++) {
      // Rows of the layer this neighbour covers, in the tile's own vertex coordinates.
      const j0 = dz < 0 ? -HALO : dz === 0 ? 0 : TILE_N;
      const j1 = dz < 0 ? -1 : dz === 0 ? TILE_N - 1 : TILE_N + HALO;
      for (let dx = -1; dx <= 1; dx++) {
        const i0 = dx < 0 ? -HALO : dx === 0 ? 0 : TILE_N;
        const i1 = dx < 0 ? -1 : dx === 0 ? TILE_N - 1 : TILE_N + HALO;
        const n = dx === 0 && dz === 0 ? t : f.tile(t.tx + dx, t.tz + dz);
        for (let j = j0; j <= j1; j++) {
          let k = o + ((j + HALO) * LW + (i0 + HALO)) * 2;
          if (!n) {
            for (let i = i0; i <= i1; i++, k += 2) data[k] = data[k + 1] = 0;
            continue;
          }
          const r = (j - dz * TILE_N) * TILE_N - dx * TILE_N;
          const h = n.h;
          for (let i = i0; i <= i1; i++, k += 2) {
            data[k] = h[r + i];
            // Turned, charred and loose, packed as one whole number (exact in a float).
            data[k + 1] = packLook(n, r + i);
          }
        }
      }
    }
    this.tex.addLayerUpdate(s);
    this.tex.needsUpdate = true;
    this.sent++;
  }

  /** Every bound tile into its group's grid for its distance. */
  private layout() {
    for (const g of this.groups.values()) for (const l of g.lods) l.n = 0;
    this.drawn = 0;
    for (let s = 0; s < SLOTS; s++) {
      const slot = this.slots[s];
      if (!slot || !slot.base || slot.sent < 0) continue;
      const far = slot.tile.fine ? LOD_FINE : LOD_FAR;
      let lod = 0;
      while (lod < far.length - 1 && slot.d > far[lod]) lod++;
      if (slot.d > LOD_FAR[LOD_FAR.length - 1] + 8) continue;
      const l = this.groupFor(slot.base).lods[lod];
      const a = l.attr.array as Float32Array;
      a[l.n * 3] = slot.tile.x0;
      a[l.n * 3 + 1] = slot.tile.z0;
      a[l.n * 3 + 2] = s;
      l.n++;
      this.drawn++;
    }
    for (const g of this.groups.values()) {
      for (const l of g.lods) {
        if (l.n) {
          l.attr.clearUpdateRanges();
          l.attr.addUpdateRange(0, l.n * 3);
          l.attr.needsUpdate = true;
        }
        l.geo.instanceCount = l.n;
        l.mesh.visible = l.n > 0;
      }
    }
  }

  /** Give every cell back to the ground mesh and forget the tiles (the field was cleared, or the scene is going). */
  reset() {
    for (let s = 0; s < SLOTS; s++) this.release(s);
  }

  dispose() {
    this.reset();
    for (const g of this.groups.values()) {
      g.material.dispose();
      for (const l of g.lods) l.geo.dispose();
    }
    for (const grid of this.grids) grid.dispose();
    this.groups.clear();
    this.tex.dispose();
    this.base.dispose();
    this.group.removeFromParent();
  }
}
