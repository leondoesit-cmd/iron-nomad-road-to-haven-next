import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { legById } from '../src/data';
import { takePlan } from '../src/world/planCache';
import { CHUNK } from '../src/world/terrain';
import { Landscape } from '../src/render/landscape';

describe('far district', () => {
  const src = takePlan(legById('W'));
  const buildings = src.cityBuildings();
  const land = new Landscape(src.layout.terrain, src.layout, buildings);
  const meshes: THREE.Mesh[] = [];
  land.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && (m.material as THREE.Material).customProgramCacheKey?.().startsWith('facade')) meshes.push(m);
  });
  const far = meshes.find((m) => m.name === 'cityFar')!;
  const chunkOf = (x: number, z: number) => `${Math.floor(x / CHUNK)}:${Math.floor(z / CHUNK)}`;

  it('draws the whole district as one mesh, each building tagged with the chunk it stands in', () => {
    expect(buildings.length).toBeGreaterThan(50);
    expect(far).toBeTruthy();
    // No other mesh carries district walls: one draw for the lot.
    expect(meshes.filter((m) => m.geometry.getAttribute('lodAt'))).toEqual([far]);
    const g = far.geometry;
    const pos = g.getAttribute('position');
    const at = g.getAttribute('lodAt');
    expect(at.count).toBe(pos.count);
    // Neighbouring buildings can share a corner across a chunk border, so a corner keeps every chunk it was tagged with.
    const roofs = new Map<string, Set<string>>();
    for (let i = 0; i < at.count; i++) {
      // Chunk centres, so the mask lookup lands in the middle of the chunk's texel.
      expect(at.getX(i) / CHUNK - 0.5).toBe(Math.round(at.getX(i) / CHUNK - 0.5));
      expect(at.getY(i) / CHUNK - 0.5).toBe(Math.round(at.getY(i) / CHUNK - 0.5));
      const k = `${pos.getX(i).toFixed(2)},${pos.getY(i).toFixed(2)},${pos.getZ(i).toFixed(2)}`;
      if (!roofs.has(k)) roofs.set(k, new Set());
      roofs.get(k)!.add(chunkOf(at.getX(i), at.getY(i)));
    }
    // Every building's roof corners are there, tagged with the chunk its middle is in: the same chunk whose loading used
    // to hide its own mesh.
    for (const b of buildings) {
      const a = b.aabb;
      const h = a.y1 + (b.stepped ? 6.6 : 0);
      const want = chunkOf((a.minX + a.maxX) / 2, (a.minZ + a.maxZ) / 2);
      for (const [x, z] of [[a.minX, a.minZ], [a.maxX, a.maxZ]]) expect(roofs.get(`${x.toFixed(2)},${h.toFixed(2)},${z.toFixed(2)}`)?.has(want)).toBe(true);
    }
  });

  it('dissolves a building out as its chunk comes in, and folds it away once the chunk is all in', () => {
    const mat = far.material as THREE.MeshStandardMaterial;
    expect(mat.customProgramCacheKey()).toBe('facade:lod');
    const shader = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    };
    mat.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain('attribute vec2 lodAt;');
    expect(shader.vertexShader).toContain('texture2D( tLoaded, lc ).g : 0.0;');
    expect(shader.vertexShader).toContain('if ( vFarCut >= 1.0 ) transformed = vec3( 0.0 );');
    expect(shader.vertexShader.indexOf('transformed = vec3( 0.0 )')).toBeLessThan(shader.vertexShader.indexOf('#include <project_vertex>'));
    // In between, a pixel goes to whichever side the shared noise gives it (dissolve.ts).
    expect(shader.fragmentShader).toContain('if ( inDissolveNoise() < vFarCut ) discard;');
    const tex = shader.uniforms.tLoaded.value as THREE.DataTexture;
    const rect = shader.uniforms.uLoadedRect.value as THREE.Vector4;
    const data = tex.image.data as Uint8Array;
    const green = (x: number, z: number) => data[(Math.floor((z - rect.y) / CHUNK) * tex.image.width + Math.floor((x - rect.x) / CHUNK)) * 4 + 1];
    const b = buildings[0];
    const cx = Math.floor((b.aabb.minX + b.aabb.maxX) / 2 / CHUNK);
    const cz = Math.floor((b.aabb.minZ + b.aabb.maxZ) / 2 / CHUNK);
    const x = (cx + 0.5) * CHUNK;
    const z = (cz + 0.5) * CHUNK;
    expect(green(x, z)).toBe(0);
    land.setFade(cx, cz, 1, 0.5);
    expect(green(x, z)).toBe(128);
    land.setFade(cx, cz, 1, 1);
    expect(green(x, z)).toBe(255);
    land.setFade(cx, cz, 0, 0);
    expect(green(x, z)).toBe(0);
  });
});
