import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ALBEDO_ONLY, PHOTO_SETS, REL, detailTexture, grainTexture, normalFields, photoCell, setPhoto, type Photo } from '../src/render/photoTex';
import { GROUND_LAYERS, terrainTextures } from '../src/render/proctex';

const root = resolve('public/textures');
const sources = JSON.parse(readFileSync(resolve(root, 'sources.json'), 'utf8')) as { file: string; license: string; source: string; author: string; sha256: string }[];

/** A synthetic scan: `fn(u, v)` gives RGB 0..255 at texel centres, row 0 at the bottom. */
function scan(size: number, fn: (u: number, v: number) => [number, number, number]): Photo {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b] = fn((x + 0.5) / size, (y + 0.5) / size);
      const i = (y * size + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { w: size, h: size, data };
}

describe('photo-scanned textures', () => {
  it('ships every map with a CC0 source, an author and a checksum', () => {
    for (const set of PHOTO_SETS) {
      for (const map of ALBEDO_ONLY.has(set) ? ['albedo'] : ['albedo', 'normal', 'height']) {
        const file = `${set}-${map}.jpg`;
        expect(existsSync(resolve(root, file)), file).toBe(true);
        const entry = sources.find((e) => e.file === file);
        expect(entry, file).toBeDefined();
        expect(entry!.license).toBe('CC0-1.0');
        expect(entry!.source).toMatch(/^https:\/\/polyhaven\.com\/a\//);
        expect(entry!.author.length).toBeGreaterThan(0);
        expect(createHash('sha256').update(readFileSync(resolve(root, file))).digest('hex'), file).toBe(entry!.sha256);
      }
    }
    expect(existsSync(resolve(root, 'CREDITS.txt'))).toBe(true);
  });

  it('reads an OpenGL normal map as tilt along +u and +v, the procedural encoding', () => {
    // Facing +u (red high) and facing -v (green low).
    const n = normalFields(scan(16, () => [200, 60, 255]), 8);
    expect(n.x[0]).toBeGreaterThan(0.6);
    expect(n.y[0]).toBeLessThan(0.4);
  });

  it('packs every ground scan into its own layer: colour about its mean, stretched height, normal; second looks lean their own way', () => {
    const flatN = scan(64, () => [128, 128, 255]);
    for (const [set, lum, warm] of [['sand', 200, 1], ['sand2', 170, 1.3], ['earth', 150, 1], ['rock', 90, 1], ['gravel', 120, 1]] as const) {
      setPhoto(set, 'albedo', scan(64, (u, v) => {
        const l = lum + Math.sin(u * Math.PI * 8) * 30 + Math.cos(v * Math.PI * 6) * 20;
        return [Math.min(255, l * warm), l, l / warm];
      }));
      setPhoto(set, 'normal', flatN);
      setPhoto(set, 'height', scan(64, (u) => [u * 255, u * 255, u * 255]));
    }
    const t = terrainTextures();
    expect(t.photo).toBe(true);
    expect(t.col.image.width).toBe(1024);
    expect(t.col.image.depth).toBe(GROUND_LAYERS.length);
    expect(t.photoLayer[GROUND_LAYERS.indexOf('sand2')]).toBe(true);
    // A layer whose scan is missing falls back to its procedural field (still a full layer, drawn at procedural scale).
    expect(t.photoLayer[GROUND_LAYERS.indexOf('mud')]).toBe(false);
    const N = 1024 * 1024;
    expect(t.nrm.image.width).toBe(512);
    const col = t.col.image.data as Uint8Array;
    const nrm = t.nrm.image.data as Uint8Array;
    // Every layer's colour averages to REL whatever its scan's brightness: the palettes set the mean.
    for (const name of ['sand', 'rock', 'mud'] as const) {
      const o = GROUND_LAYERS.indexOf(name) * N * 4;
      let sum = 0;
      for (let i = 0; i < N; i += 97) sum += col[o + i * 4 + 1];
      expect(sum / Math.ceil(N / 97) / 255, name).toBeCloseTo(REL, 1);
    }
    // A flat normal map stays flat; the height ramp is stretched to the full range (away from the wrapped seam).
    const sand = GROUND_LAYERS.indexOf('sand');
    expect(Math.abs(nrm[sand * (N / 4) * 2] - 128)).toBeLessThanOrEqual(1);
    const row = 1024 * 4;
    expect(col[sand * N * 4 + row * 10 + 40 * 4 + 3]).toBeLessThan(30);
    expect(col[sand * N * 4 + row * 10 + 980 * 4 + 3]).toBeGreaterThan(225);
    // The warmer second sand leans warm against the first, bounded.
    const tint = t.tint[GROUND_LAYERS.indexOf('sand2')];
    expect(tint.x).toBeGreaterThan(1);
    expect(tint.z).toBeLessThan(1);
    expect(tint.z).toBeGreaterThanOrEqual(0.72);
    expect(t.tint[sand].x).toBe(1);
    // The facades still find the earth's cracks in the old two-material texture.
    expect(t.a.image.width).toBe(1024);
    expect(t.crackK).toBeCloseTo(0.8 / REL);
  });

  it('makes close-up detail around a multiplier of one, and tiles wall grain seamlessly', () => {
    setPhoto('asphalt', 'albedo', scan(64, (u) => [60 + u * 80, 60 + u * 80, 60 + u * 80]));
    setPhoto('asphalt', 'normal', scan(64, () => [128, 128, 255]));
    setPhoto('asphalt', 'height', scan(64, (u, v) => [v * 255, 0, 0]));
    const d = detailTexture('asphalt', 64)!;
    const px = d.image.data as Uint8Array;
    let sum = 0;
    for (let i = 0; i < 64 * 64; i++) sum += px[i * 4];
    expect(sum / (64 * 64)).toBeGreaterThan(118);
    expect(sum / (64 * 64)).toBeLessThan(138);

    setPhoto('wood', 'albedo', scan(64, (u, v) => {
      const l = 120 + Math.sin(v * Math.PI * 2 * 5) * 50;
      return [l, l, l];
    }));
    const g = grainTexture([{ set: 'missing', real: 1 }, { set: 'missing', real: 1 }, { set: 'wood', real: 0.5, turn: true }], 2, 128)!;
    const gp = g.image.data as Uint8Array;
    // Four tiles across: column x and x + 32 match; `turn` lays the grain along u (rows constant along v).
    expect(gp[(5 * 128 + 3) * 4 + 2]).toBe(gp[(5 * 128 + 35) * 4 + 2]);
    expect(gp[(5 * 128 + 3) * 4 + 2]).toBe(gp[(60 * 128 + 3) * 4 + 2]);
    // Missing scans stay neutral.
    expect(gp[0]).toBe(128);
  });

  it('tiles a bark scan into an atlas cell at the brightness asked for', () => {
    const p = scan(64, (u) => [100 + u * 100, 90 + u * 90, 80 + u * 80]);
    const cell = photoCell(p, 32, 2, 2, 0.6, [1, 0.95, 0.88]);
    let sum = 0;
    for (let i = 0; i < 32 * 32; i++) sum += cell[i * 4];
    expect(sum / (32 * 32) / 255).toBeGreaterThan(0.54);
    expect(sum / (32 * 32) / 255).toBeLessThan(0.66);
    expect(cell[3]).toBe(255);
  });
});
