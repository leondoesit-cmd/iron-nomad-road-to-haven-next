import { describe, expect, it } from 'vitest';
import { LEGS } from '../src/data';
import { cliffDetail, mountainRelief } from '../src/render/chunkview';
import { MeshBuilder, S } from '../src/render/builder';
import { fbm, voronoi } from '../src/render/proctex';
import { corridorHalf, makeTerrainDef, roadX } from '../src/world/terrain';

describe('visual terrain detail', () => {
  const wasteland = LEGS.legs.filter((l) => l.biome === 'wasteland');
  it.each(wasteland.map((l) => [l.id, l] as const))('%s: crags and mountains never touch the drivable corridor', (_id, leg) => {
    const def = makeTerrainDef(leg);
    for (let z = -40; z < leg.length + 140; z += 7) {
      const rx = roadX(def, z);
      const ch = corridorHalf(def, z);
      // Everything a wheel can reach (the floor up to the foot of the cliff) keeps the physics height.
      for (const off of [0, 0.5, 0.9, 1.0]) {
        for (const side of [-1, 1]) {
          const x = rx + side * ch * off;
          expect(Math.abs(cliffDetail(def, x, z))).toBeLessThan(1e-9);
        }
      }
      expect(mountainRelief(def, rx + ch + 60, z)).toBe(0);
    }
  });
  it('city legs have no visual displacement at all', () => {
    const def = makeTerrainDef(LEGS.legs.find((l) => l.biome === 'city')!);
    expect(cliffDetail(def, 300, 400)).toBe(0);
  });
});

describe('mesh builder', () => {
  it('keeps every vertex attribute in step', () => {
    const b = new MeshBuilder();
    b.box(0, 0, 0, 1, 1, 1, 0xff0000);
    b.rbox(1, 0, 0, 1, 0.5, 2, 0.1, S.paint(0x00ff00));
    b.capsule(0, 0, 0, 0, 1, 0, 0.1, S.cloth(0x123456));
    b.limb(0, 0, 0, 1, 1, 1, 0.1, 0.05, S.skin(0xc0a080));
    b.pipe([[0, 0, 0], [1, 0, 0], [1, 1, 0]], 0.05, S.steel());
    b.torus(0, 0, 0, 0.4, 0.1, S.rubber());
    b.lathe('test', [[0.1, 0], [0.3, 0.2], [0.1, 0.4]], 0, 0, 0, S.metal());
    b.rbox(0, 0, 0, -1, 1, 1, 0.1, 0xffffff);
    const n = b.vertexCount;
    const g = b.build();
    expect(g.attributes.position.count).toBe(n);
    expect(g.attributes.normal.count).toBe(n);
    expect(g.attributes.color.count).toBe(n);
    expect(g.attributes.surf.count).toBe(n);
    expect(g.attributes.uv.count).toBe(n);
    const idx = g.index!;
    for (let i = 0; i < idx.count; i++) expect(idx.getX(i)).toBeLessThan(n);
    for (let i = 0; i < n * 3; i++) expect(Number.isFinite((g.attributes.position.array as Float32Array)[i])).toBe(true);
  });
  it('writes surface presets per vertex', () => {
    const b = new MeshBuilder();
    b.box(0, 0, 0, 1, 1, 1, S.chrome());
    const surf = b.build().attributes.surf.array as Float32Array;
    expect(surf[0]).toBeLessThan(0.2);
    expect(surf[1]).toBeGreaterThan(0.9);
  });
});

describe('procedural textures', () => {
  it('fractal noise is normalised and deterministic', () => {
    const a = fbm(32, 4, { seed: 3 });
    const b = fbm(32, 4, { seed: 3 });
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Math.min(...a)).toBeCloseTo(0, 5);
    expect(Math.max(...a)).toBeCloseTo(1, 5);
  });
  it('voronoi distances are ordered and the pattern tiles', () => {
    const v = voronoi(32, 4, 9);
    for (let i = 0; i < v.f1.length; i++) expect(v.f1[i]).toBeLessThanOrEqual(v.f2[i]);
    // The left and right edges meet: neighbouring cells across the seam see the same feature points.
    expect(Math.abs(v.f1[0] - v.f1[31])).toBeLessThan(0.3);
  });
});

describe('facade material', () => {
  it('forces alpha to 1.0 to prevent screen-space reflections on procedural building windows', async () => {
    const { facadeMaterial } = await import('../src/render/facade');
    const { installGloss } = await import('../src/render/gloss');
    const THREE = await import('three');
    installGloss();

    const m = facadeMaterial();
    expect(m.customProgramCacheKey()).toBe('facade');

    const shader = {
      uniforms: {} as Record<string, any>,
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    };
    m.onBeforeCompile(shader as any, {} as any);

    expect(shader.fragmentShader).toContain('gl_FragColor.a = 1.0;');
    expect(shader.fragmentShader).toContain('diffuseColor.a = 1.0;');
    // Roughness for glass should be smooth without CRT noise
    expect(shader.fragmentShader).toContain('roughnessFactor = mix( fRough, 0.08,');
  });
});
