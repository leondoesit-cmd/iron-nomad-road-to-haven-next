import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics, PhysicsWorld } from '../src/physics/physics';
import { GroundField, TILE_N, packLook } from '../src/sim/groundField';
import { SOILS, crater } from '../src/sim/soil';
import { GroundDeform } from '../src/render/groundDeform';
import { ChunkView, makeChunkMaterials } from '../src/render/chunkview';
import { ChunkSource } from '../src/world/chunkgen';
import { CELLS, CHUNK } from '../src/world/terrain';
import { legById } from '../src/data';

// The loose ground's tiles are drawn in place of the ground mesh's cells: each tile's layer must hold exactly the field
// (its own vertices and the ring of its neighbours' it is shaded with), and a tile must hide its cell and give it back.

beforeAll(initPhysics);

const sand = SOILS.sand;

describe('a tile layer', () => {
  it('holds the field, its neighbours\' ring included', () => {
    const f = new GroundField({ soilAt: () => sand });
    // Work across a tile corner so all nine tiles have something in them.
    f.crater(2.0, 2.0, 1, 0.3, crater(sand, 4e4, 0.8), sand);
    f.deposit(1.96, 2.1, 0.002, 0.2, sand);
    const d = new GroundDeform(f, { view: () => null });
    const t = f.tile(1, 1)!;
    (d as unknown as { fill(s: number, t: unknown): void }).fill(3, t);
    const data = d.tex.image.data as unknown as Float32Array;
    const LW = d.tex.image.width;
    const HALO = (LW - TILE_N - 1) / 2;
    let worst = 0;
    let looks = 0;
    for (let j = -HALO; j <= TILE_N + HALO; j++) {
      for (let i = -HALO; i <= TILE_N + HALO; i++) {
        const k = (3 * LW * LW + (j + HALO) * LW + (i + HALO)) * 2;
        worst = Math.max(worst, Math.abs(data[k] - f.hAt(TILE_N + i, TILE_N + j)));
        if (data[k + 1] !== f.lookAt(TILE_N + i, TILE_N + j)) looks++;
      }
    }
    expect(worst).toBe(0);
    expect(looks).toBe(0);
    expect(packLook(t, 0)).toBe(f.lookAt(TILE_N, TILE_N));
  });
});

describe('a tile over the ground mesh', () => {
  it('hides its cell while it is drawn and gives it back after', () => {
    const leg = legById('W');
    const src = new ChunkSource(leg);
    const def = src.layout.terrain;
    const P = new PhysicsWorld();
    const data = src.get(0, 0);
    const view = new ChunkView(data, def, makeChunkMaterials('wasteland', leg.theme), P, { scatter: 0 });
    const f = new GroundField({ soilAt: () => sand });
    // A crater in the middle of one cell of chunk (0, 0).
    const tx = 10;
    const tz = 12;
    f.crater(tx * 2 + 1, tz * 2 + 1, 1, 0, crater(sand, 3e3, 1), sand);
    const d = new GroundDeform(f, { view: (x, z) => (Math.floor(x / CELLS) === 0 && Math.floor(z / CELLS) === 0 ? view : null) });
    d.update([{ x: tx * 2, z: tz * 2 }]);
    const idx = view.terrainMesh!.geometry.index!.array;
    const N1 = CELLS + 1;
    const cellAt = (c: number, r: number) => {
      // The cell's six indices, wherever they are: the first triangle starts at its corner a.
      const a = r * N1 + c;
      for (let o = 0; o < idx.length; o += 6) if (idx[o] === a && idx[o + 1] === a + N1) return o;
      for (let o = 0; o < idx.length; o += 6) if (idx[o] === a && idx[o + 1] === a && idx[o + 5] === a) return o;
      return -1;
    };
    const o = cellAt(tx, tz);
    expect(o).toBeGreaterThanOrEqual(0);
    // Hidden: all six the same corner (no area).
    expect(new Set(Array.from(idx.slice(o, o + 6))).size).toBe(1);
    expect(d.drawn).toBeGreaterThan(0);
    // Far from every camera: the cell is the mesh's again.
    for (let k = 0; k < 9; k++) d.update([{ x: CHUNK * 5, z: CHUNK * 5 }]);
    expect(new Set(Array.from(idx.slice(o, o + 6))).size).toBe(4);
    expect(d.drawn).toBe(0);
    const corners = new Float32Array(60);
    expect(view.cellCorners(tx, tz, corners)).toBe(true);
    // Corner heights are the mesh's own.
    const pos = view.terrainMesh!.geometry.attributes.position;
    expect(corners[0]).toBeCloseTo(pos.getY(tz * N1 + tx), 6);
    expect(corners[3]).toBeCloseTo(pos.getY((tz + 1) * N1 + tx + 1), 6);
    void THREE;
  });
});
