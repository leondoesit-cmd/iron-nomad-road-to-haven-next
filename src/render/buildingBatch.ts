import * as THREE from 'three';
import { staticTransform } from './staticTransform';
import type { BuildingView } from './buildingView';

/**
 * Far roadside buildings drawn a cell at a time.
 *
 * Every building of a leg is its own handful of meshes (a shell per storey, trim per storey, a roof), so each can be cut away
 * when someone steps inside. Seen from far off they never are, and a view of the open world spent about 190 draw calls a
 * frame on the outsides of buildings hundreds of metres away. So the outsides of the buildings in one CELL_M square share
 * their vertex and index buffers: one merged geometry per material holds them all, and each building's own meshes draw
 * their slice of it (`drawRange`). Per view, a cell whose every building is far from the camera and untouched draws its
 * batch (two draws), and its buildings' outsides step aside; otherwise the buildings draw themselves as before. The same
 * triangles either way, from the same buffers, so the picture is the same; GPU memory grows only by the batch's objects.
 *
 * A building that is rebuilt (a wall breached, a window broken) gets fresh meshes of its own, and its cell stops batching.
 */

/** Side of a batch cell, metres. */
const CELL_M = 256;
/** A cell batches for a view only when every building in it is at least this far beyond its own radius from the camera. */
export const BATCH_FAR = 150;

interface Cell {
  buildings: BuildingView[];
  /** Each building's `version` when the batch was made. */
  versions: number[];
  meshes: THREE.Mesh[];
  geos: THREE.BufferGeometry[];
  merged: boolean;
}

/** The attribute layout of a geometry, so only alike geometries share buffers. */
function layoutOf(g: THREE.BufferGeometry): string {
  const parts = Object.keys(g.attributes).sort().map((k) => {
    const a = g.attributes[k] as THREE.BufferAttribute;
    return `${k}:${a.itemSize}:${a.array.constructor.name}:${a.normalized}`;
  });
  return `${parts.join(',')}|${g.index ? 'i' : '-'}|${Object.keys(g.morphAttributes).length}|${g.groups.length}`;
}

/**
 * Merge the geometries of `meshes` into one set of shared buffers and point every mesh at its own slice of them. Returns the
 * merged geometry, or null when there is nothing to merge or the geometries are not alike.
 */
function share(meshes: THREE.Mesh[], owner: Map<THREE.Mesh, BuildingView>): THREE.BufferGeometry | null {
  if (meshes.length < 2) return null;
  const geos = meshes.map((m) => m.geometry);
  const layout = layoutOf(geos[0]);
  if (!geos[0].index || geos.some((g) => layoutOf(g) !== layout || g.drawRange.start !== 0 || g.drawRange.count !== Infinity)) return null;
  let verts = 0;
  let indices = 0;
  for (const g of geos) {
    verts += g.attributes.position.count;
    indices += g.index!.count;
  }
  const merged = new THREE.BufferGeometry();
  for (const k of Object.keys(geos[0].attributes)) {
    const a0 = geos[0].attributes[k] as THREE.BufferAttribute;
    const Arr = a0.array.constructor as new (n: number) => THREE.TypedArray;
    const arr = new Arr(verts * a0.itemSize);
    let o = 0;
    for (const g of geos) {
      const a = g.attributes[k] as THREE.BufferAttribute;
      arr.set(a.array as ArrayLike<number>, o);
      o += a.array.length;
    }
    merged.setAttribute(k, new THREE.BufferAttribute(arr, a0.itemSize, a0.normalized));
  }
  const idx = verts > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
  const starts: number[] = [];
  let vo = 0;
  let io = 0;
  for (const g of geos) {
    const src = g.index!.array;
    starts.push(io);
    for (let i = 0; i < src.length; i++) idx[io + i] = src[i] + vo;
    io += src.length;
    vo += g.attributes.position.count;
  }
  merged.setIndex(new THREE.BufferAttribute(idx, 1));
  merged.computeBoundingSphere();
  merged.computeBoundingBox();
  meshes.forEach((m, i) => {
    const g = geos[i];
    if (!g.boundingSphere) g.computeBoundingSphere();
    if (!g.boundingBox) g.computeBoundingBox();
    // The building's own slice: the same attribute and index objects (so the same GPU buffers), its own range and bounds.
    const view = new THREE.BufferGeometry();
    for (const k of Object.keys(merged.attributes)) view.setAttribute(k, merged.attributes[k]);
    view.setIndex(merged.index);
    view.setDrawRange(starts[i], g.index!.count);
    view.boundingSphere = g.boundingSphere!.clone();
    view.boundingBox = g.boundingBox!.clone();
    view.userData.sharedBuffers = true;
    owner.get(m)!.shareGeometry(m, view);
  });
  return merged;
}

export class BuildingBatches {
  readonly group = staticTransform(new THREE.Group());
  private cells: Cell[] = [];

  constructor(buildings: BuildingView[]) {
    this.group.name = 'buildingBatches';
    const byCell = new Map<string, BuildingView[]>();
    for (const b of buildings) {
      const key = `${Math.floor(b.cx / CELL_M)}:${Math.floor(b.cz / CELL_M)}`;
      let list = byCell.get(key);
      if (!list) byCell.set(key, (list = []));
      list.push(b);
    }
    for (const list of byCell.values()) {
      if (list.length < 2) continue;
      const cell: Cell = { buildings: list, versions: list.map((b) => b.version), meshes: [], geos: [], merged: false };
      for (const kind of ['facade', 'kit'] as const) {
        const meshes = list.flatMap((b) => b.exterior[kind]);
        const owner = new Map<THREE.Mesh, BuildingView>();
        for (const b of list) for (const m of b.exterior[kind]) owner.set(m, b);
        const merged = share(meshes, owner);
        if (!merged) continue;
        const m = staticTransform(new THREE.Mesh(merged, meshes[0].material));
        m.castShadow = true;
        m.receiveShadow = true;
        m.visible = false;
        this.group.add(m);
        cell.meshes.push(m);
        cell.geos.push(merged);
      }
      if (cell.meshes.length) this.cells.push(cell);
    }
  }

  /** Per view, before it renders: each cell draws its batch or its buildings, whichever this camera allows. */
  updateView(camX: number, camZ: number) {
    for (const c of this.cells) {
      let merge = true;
      for (let i = 0; i < c.buildings.length && merge; i++) {
        const b = c.buildings[i];
        if (b.version !== c.versions[i] || Math.hypot(camX - b.cx, camZ - b.cz) < BATCH_FAR + b.radius) merge = false;
      }
      if (merge === c.merged) continue;
      c.merged = merge;
      for (const m of c.meshes) m.visible = merge;
      // A rebuilt building has fresh meshes of its own; the others' outsides come back.
      for (const b of c.buildings) for (const m of [...b.exterior.facade, ...b.exterior.kit]) m.visible = !merge;
    }
  }

  dispose() {
    // The batch owns the shared buffers: the buildings have already let go of them (`releaseGeometry`).
    for (const c of this.cells) for (const g of c.geos) g.dispose();
    this.group.removeFromParent();
  }
}
