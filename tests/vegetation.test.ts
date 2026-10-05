import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics, PhysicsWorld } from '../src/physics/physics';
import { legById } from '../src/data';
import { ChunkSource } from '../src/world/chunkgen';
import { TREE_DIMS, TREE_SPECIES } from '../src/world/flora';
import { forestAt, lushAt } from '../src/world/hydro';
import { CELL, CHUNK, heightAt } from '../src/world/terrain';
import { ChunkView, makeChunkMaterials } from '../src/render/chunkview';
import { buildScatter } from '../src/render/scatter';
import { buildTreesSteps, impostorDims, planFarForest, treeGeometry, treeInstances } from '../src/render/trees';

// The green country, drawn: tree models, the trees of a chunk, the living ground's data and the ground cover.

beforeAll(async () => {
  await initPhysics();
});

const leg = legById('W');
const src = new ChunkSource(leg);
const def = src.layout.terrain;
const chunkAt = (x: number, z: number) => src.get(Math.floor(x / CHUNK), Math.floor(z / CHUNK));

describe('tree models', () => {
  it('builds finite geometry for every species and variant, about the species size', () => {
    for (let sp = 0; sp < TREE_SPECIES.length; sp++) {
      const g = treeGeometry(sp);
      const P = g.attributes.position.array as Float32Array;
      const N = g.attributes.normal.array as Float32Array;
      const U = g.attributes.uv.array as Float32Array;
      const T = g.attributes.tree.array as Float32Array;
      for (const a of [P, N, U, T]) for (const v of a) expect(Number.isFinite(v)).toBe(true);
      for (const v of U) expect(v >= 0 && v <= 1).toBe(true);
      const idx = g.index!.array;
      for (let v = 0; v < 3; v++) {
        let tris = 0;
        let top = 0;
        for (let t = 0; t < idx.length; t += 3) {
          const vs = [idx[t], idx[t + 1], idx[t + 2]];
          const own = vs.map((i) => T[i * 3 + 1]);
          // A triangle never mixes variants: the shader drops a variant whole.
          expect(new Set(own).size, `${TREE_SPECIES[sp]} ${v}`).toBe(1);
          if (own[0] !== v) continue;
          tris++;
          for (const i of vs) top = Math.max(top, P[i * 3 + 1]);
        }
        expect(tris, `${TREE_SPECIES[sp]} variant ${v}`).toBeGreaterThan(50);
        expect(tris, `${TREE_SPECIES[sp]} variant ${v}`).toBeLessThan(900);
        const h = TREE_DIMS[TREE_SPECIES[sp]].h;
        expect(top, `${TREE_SPECIES[sp]} variant ${v} height`).toBeGreaterThan(h * (sp === TREE_SPECIES.indexOf('snag') ? 0.35 : 0.6));
        expect(top, `${TREE_SPECIES[sp]} variant ${v} height`).toBeLessThan(h * 1.4);
      }
      const d = impostorDims(sp);
      expect(d.w).toBeGreaterThan(1);
      expect(d.h).toBeGreaterThan(1);
    }
  });
});

describe('trees of a chunk', () => {
  it('draws the same trees the same way every time, one mesh per species plus the impostors', () => {
    const a = chunkAt(-1700, 1300);
    const b = new ChunkSource(leg).get(a.cx, a.cz);
    expect(a.trees.length).toBeGreaterThan(30);
    const ia = treeInstances(a.trees);
    expect(treeInstances(b.trees)).toEqual(ia);
    for (const t of ia) for (const v of t.m) expect(Number.isFinite(v)).toBe(true);
    const g = buildTreesSteps(a.trees);
    let r = g.next();
    while (!r.done) r = g.next();
    const set = r.value;
    const species = new Set(a.trees.map((t) => t.sp));
    expect(set.near.length).toBe(species.size);
    expect(set.near.reduce((n, im) => n + im.count, 0)).toBe(a.trees.length);
    expect(set.far!.count).toBe(a.trees.length);
    for (const im of set.near) expect(im.castShadow).toBe(true);
    // The variant rides in the instance colour: red holds the tint plus four times the variant.
    const m = set.near[0];
    const c = new THREE.Color();
    for (let i = 0; i < m.count; i++) {
      m.getColorAt(i, c);
      expect(Math.floor(c.r / 4)).toBeLessThan(3);
    }
  });

  it('plants none in the desert at the start', () => {
    expect(chunkAt(0, 10).trees.length).toBe(0);
  });
});

describe('living ground', () => {
  it('packs lushAt and forestAt into the terrain mesh', () => {
    const data = chunkAt(-1700, 1300);
    const view = new ChunkView(data, def, makeChunkMaterials('wasteland', leg.theme), new PhysicsWorld(), { scatter: 0 });
    const mesh = view.group.children.find((o) => (o as THREE.Mesh).geometry?.attributes.tdata) as THREE.Mesh;
    const td = mesh.geometry.attributes.tdata.array as Float32Array;
    const x0 = data.cx * CHUNK;
    const z0 = data.cz * CHUNK;
    let green = 0;
    for (let r = 0; r <= 64; r += 8) {
      for (let c = 0; c <= 64; c += 8) {
        const i = r * 65 + c;
        const L = lushAt(def, x0 + c * CELL, z0 + r * CELL);
        expect(td[i * 4 + 2]).toBeCloseTo(L, 5);
        expect(td[i * 4 + 3]).toBeCloseTo(L > 0.42 ? forestAt(def, x0 + c * CELL, z0 + r * CELL) : 0, 5);
        if (L > 0.4) green++;
      }
    }
    expect(green).toBeGreaterThan(20);
    view.dispose();
    // The desert stays desert.
    const start = chunkAt(0, 10);
    const v2 = new ChunkView(start, def, makeChunkMaterials('wasteland', leg.theme), new PhysicsWorld(), { scatter: 0 });
    const m2 = v2.group.children.find((o) => (o as THREE.Mesh).geometry?.attributes.tdata) as THREE.Mesh;
    const t2 = m2.geometry.attributes.tdata.array as Float32Array;
    for (let i = 0; i < 65 * 65; i++) expect(t2[i * 4 + 2]).toBe(0);
    v2.dispose();
  });
});

describe('ground cover', () => {
  const cover = (x: number, z: number) => {
    const d = chunkAt(x, z);
    return buildScatter(def, d.cx, d.cz, d.aabbs, d.props, 1, undefined, d.heights);
  };

  it('still builds the desert as it was: dry grass, shrubs and stones, nothing green', () => {
    const s = cover(0, 10);
    expect(s.grass?.count ?? 0).toBeGreaterThan(100);
    expect(s.pebbles.length).toBeGreaterThan(0);
    expect(s.flowers).toBeNull();
    expect(s.ferns).toBeNull();
    expect(s.pads).toBeNull();
    // Straw, not green.
    const c = new THREE.Color();
    s.grass!.getColorAt(0, c);
    expect(c.r).toBeGreaterThan(c.g * 0.9);
  });

  it('grows a lush chunk thick and green, with ferns under the woods', () => {
    const desert = cover(0, 10);
    const s = cover(-1700, 1300);
    expect(s.grass!.count).toBeGreaterThan(desert.grass!.count);
    expect(s.ferns?.count ?? 0).toBeGreaterThan(10);
    const c = new THREE.Color();
    let greener = 0;
    for (let i = 0; i < s.grass!.count; i += 7) {
      s.grass!.getColorAt(i, c);
      if (c.g > c.r) greener++;
    }
    expect(greener).toBeGreaterThan(s.grass!.count / 14);
  });

  it('puts reeds by the water and lily pads on the swamp', () => {
    const s = cover(1000, 2080);
    expect(s.reeds?.count ?? 0).toBeGreaterThan(50);
    expect(s.pads?.count ?? 0).toBeGreaterThan(5);
    const hy = def.hydro!;
    const fen = hy.swamps.find((w) => Math.hypot(w.x - 1000, w.z - 2080) < 50)!;
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    const m = new THREE.Matrix4();
    for (let i = 0; i < s.pads!.count; i++) {
      s.pads!.getMatrixAt(i, m);
      m.decompose(p, q, sc);
      expect(p.y).toBeCloseTo(fen.level + 0.025, 3);
      const depth = fen.level - heightAt(def, p.x, p.z);
      expect(depth).toBeGreaterThan(0.1);
    }
  });
});

describe('far forest', () => {
  it('is planned the same every time, of real species, and not in the desert', () => {
    const ground = (x: number, z: number) => heightAt(def, x, z) - 0.6;
    const flat = () => 0;
    const a = planFarForest(def, ground, flat);
    const n = a.reduce((k, g) => k + g.length, 0);
    expect(n).toBeGreaterThan(5000);
    // Six triangles an impostor: well under 400k for the whole map.
    expect(n * 6).toBeLessThan(400000);
    for (const g of a) for (const t of g) expect(t.sp >= 0 && t.sp < TREE_SPECIES.length).toBe(true);
    for (const g of a) for (const t of g) expect(Math.hypot(t.x, t.z - 10)).toBeGreaterThan(150);
    const b = planFarForest(def, ground, flat);
    expect(b.length).toBe(a.length);
    expect(b[3]).toEqual(a[3]);
  });
});
