import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ZombieRenderer } from '../src/render/zombieRender';
import { zombieAppearance, ZOMBIE_OUTFITS, ZOMBIE_BOTTOMS, ZOMBIE_FOOTWEAR, ZOMBIE_HAIRSTYLES } from '../src/render/zombieAppearance';
import { ZOMBIE_ACTION, ZOMBIE_VARIANTS, zombieMotion, zombieStepPhase } from '../src/sim/zombieAnimation';

const resting = { dead: false, grabbing: null, feedT: 0, eatT: 0, screamT: 0, smashT: 0, charge: 'none', chargeT: 0, burstT: 0, locomotion: 1 };

describe('infected animation', () => {
  it('mixes male and female bodies across every wardrobe with varied hair', () => {
    const looks = Array.from({ length: ZOMBIE_VARIANTS }, (_, i) => zombieAppearance(i));
    expect(looks.filter(x => x.female).length).toBe(ZOMBIE_VARIANTS / 2);
    for (const female of [false, true]) {
      const bodies = looks.filter(x => x.female === female);
      expect(new Set(bodies.map(x => x.outfit)).size).toBe(ZOMBIE_OUTFITS.length);
      expect(new Set(bodies.map(x => x.hairstyle)).size).toBe(ZOMBIE_HAIRSTYLES.length);
    }
    // The renderer must carry anatomy and hair independently of action and lower clothing.
    const renderer = new ZombieRenderer({ max: ZOMBIE_VARIANTS });
    renderer.begin();
    looks.forEach((_, i) => renderer.push('walker', 1, i, 0, 0, 0, 0, 0, 0, 0, i));
    renderer.end(0);
    const geo = renderer.mesh.geometry;
    const bodies = Array.from({ length: ZOMBIE_VARIANTS }, (_, i) => Math.floor(geo.getAttribute('aMotion').getW(i) / 8));
    expect(bodies.filter(x => x === 1).length).toBe(ZOMBIE_VARIANTS / 2);
    const hairstyles = Array.from({ length: ZOMBIE_VARIANTS }, (_, i) => Math.floor(geo.getAttribute('aGore').getW(i) / 16));
    expect(new Set(hairstyles).size).toBe(ZOMBIE_HAIRSTYLES.length);
    geo.dispose();
    (renderer.mesh.material as THREE.Material).dispose();
    renderer.mesh.customDepthMaterial?.dispose();
  });

  it('distributes the horde across clothing shapes and independent lower outfits', () => {
    const looks = Array.from({ length: ZOMBIE_VARIANTS }, (_, i) => zombieAppearance(i));
    expect(new Set(looks.map(x => x.outfit)).size).toBe(ZOMBIE_OUTFITS.length);
    expect(new Set(looks.map(x => x.bottoms)).size).toBe(ZOMBIE_BOTTOMS.length);
    expect(new Set(looks.map(x => x.footwear)).size).toBe(ZOMBIE_FOOTWEAR.length);
    expect(new Set(looks.map(x => `${x.outfit}/${x.bottoms}/${x.footwear}`)).size).toBeGreaterThan(20);
    for (let i = 0; i < ZOMBIE_VARIANTS; i++) {
      expect(zombieAppearance(i + ZOMBIE_VARIANTS)).toEqual(looks[i]);
      expect(zombieAppearance(i - ZOMBIE_VARIANTS)).toEqual(looks[i]);
    }
  });

  it('keeps the same wardrobe when enemy kind, pose and movement change', () => {
    const renderer = new ZombieRenderer({ max: 6 });
    renderer.begin();
    const kinds = ['walker', 'runner', 'screamer', 'bloater', 'brute', 'stalker'] as const;
    kinds.forEach((kind, i) => renderer.push(kind, 1, i, 0, 0, i, i * 3, i, i / 5, 0, 14,
      1, i ? 512 : 160, i / 5, 0, { move: i / 5, action: i, weight: 0.5 }));
    renderer.end(10);
    const geo = renderer.mesh.geometry;
    const outfits = Array.from({ length: 6 }, (_, i) => geo.getAttribute('aMotion').getW(i) % 8);
    const lower = Array.from({ length: 6 }, (_, i) => geo.getAttribute('aGore').getW(i) % 16);
    expect(new Set(outfits).size).toBe(1);
    expect(new Set(lower).size).toBe(1);
    expect(outfits[0]).toBeGreaterThanOrEqual(0);
    expect(outfits[0]).toBeLessThan(ZOMBIE_OUTFITS.length);
    expect(lower[0]).toBeLessThan(ZOMBIE_BOTTOMS.length * ZOMBIE_FOOTWEAR.length);
    geo.dispose();
    (renderer.mesh.material as THREE.Material).dispose();
    renderer.mesh.customDepthMaterial?.dispose();
  });

  it('builds finite, indexed model geometry within the instanced horde budget', () => {
    const renderer = new ZombieRenderer({ max: 1 });
    const geo = renderer.mesh.geometry;
    const position = geo.getAttribute('position');
    const normal = geo.getAttribute('normal');
    // Detailed heads, clothing and fingers must not multiply the work for a 600-body horde.
    expect(position.count).toBeLessThan(12000);
    expect(geo.index!.count / 3).toBeLessThan(10000);
    for (const name of ['normal', 'color', 'surf', 'aZ', 'aPivot', 'aPivot2']) {
      expect(geo.getAttribute(name).count).toBe(position.count);
      expect(Array.from(geo.getAttribute(name).array).every(Number.isFinite)).toBe(true);
    }
    expect(Array.from(position.array).every(Number.isFinite)).toBe(true);
    for (let i = 0; i < normal.count; i++) {
      expect(Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i))).toBeCloseTo(1, 4);
    }
    expect(Math.max(...geo.index!.array)).toBeLessThan(position.count);
    expect(Math.min(...geo.index!.array)).toBeGreaterThanOrEqual(0);
    expect(Object.keys(geo.attributes).length + 4).toBeLessThanOrEqual(16);
    geo.dispose();
    (renderer.mesh.material as THREE.Material).dispose();
    renderer.mesh.customDepthMaterial?.dispose();
  });

  it('advances by resolved distance, independent of update rate and speed changes', () => {
    const full = zombieStepPhase('walker', 17, 3, 1);
    const split = [0.1, 0.2, 0.7, 2].reduce((phase, distance) => phase + zombieStepPhase('walker', 17, distance, 1), 0);
    expect(split).toBeCloseTo(full, 10);
    expect(zombieStepPhase('walker', 17, 0, 1)).toBe(0);
    expect(zombieStepPhase('runner', 17, 3, 1)).toBeLessThan(full);
    expect(zombieStepPhase('walker', 17, 3, 1.5)).toBeCloseTo(full / 1.5);
  });

  it('holds the feet while grabbing, feeding or winding up, and gives combat actions priority', () => {
    expect(zombieMotion({ ...resting, grabbing: {} })).toEqual({ move: 0, action: ZOMBIE_ACTION.grab, weight: 1 });
    for (const food of [{ feedT: 2 }, { eatT: 2 }]) {
      expect(zombieMotion({ ...resting, ...food })).toEqual({ move: 0, action: ZOMBIE_ACTION.feed, weight: 1 });
    }
    expect(zombieMotion({ ...resting, charge: 'wind', chargeT: 0.3 }).move).toBe(0);
    expect(zombieMotion({ ...resting, burstT: 0.3 }).action).toBe(ZOMBIE_ACTION.burst);
    expect(zombieMotion({ ...resting, screamT: 1, grabbing: {} }).action).toBe(ZOMBIE_ACTION.scream);
    expect(zombieMotion({ ...resting, smashT: 0.3 }).action).toBe(ZOMBIE_ACTION.smash);
    expect(zombieMotion({ ...resting, dead: true, screamT: 1, grabbing: {} })).toEqual({ move: 0, action: 0, weight: 0 });
  });

  it('keeps 32 looks distinct and supports the phantom renderer without explicit motion', () => {
    const renderer = new ZombieRenderer({ max: ZOMBIE_VARIANTS });
    renderer.begin();
    for (let i = 0; i < ZOMBIE_VARIANTS; i++) renderer.push('walker', 1, i, 0, 0, 0, 0, 4, 0, 0, i);
    renderer.end(1);
    const geo = renderer.mesh.geometry;
    const kind = geo.getAttribute('aKind');
    expect(new Set(Array.from({ length: ZOMBIE_VARIANTS }, (_, i) => kind.getY(i))).size).toBe(ZOMBIE_VARIANTS);
    expect(geo.getAttribute('aMotion').getX(0)).toBe(1);
    // Matrices consume four attribute locations. Keep the horde within WebGL's guaranteed 16.
    expect(Object.keys(geo.attributes).length + 4).toBeLessThanOrEqual(16);
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
    const mat = renderer.mesh.material as THREE.MeshStandardMaterial;
    mat.onBeforeCompile(shader as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain('attribute vec4 aMotion');
    const color = shader.vertexShader.slice(shader.vertexShader.indexOf('int zs8'), shader.vertexShader.indexOf('// Raw flesh'));
    expect(color).not.toContain('aAnim.x');
    renderer.begin();
    renderer.push('brute', 1, 0, 0, 0, 0, 2, 0, 1, 0, 3, 1, 0, 0, 0, { move: 0, action: ZOMBIE_ACTION.wind, weight: 0.5 });
    renderer.end(2);
    expect(geo.getAttribute('aMotion').getY(0)).toBe(ZOMBIE_ACTION.wind);
    renderer.begin();
    renderer.push('walker', 1, 0, 0, 0, 0, 2, 0, 0, 0, 3);
    renderer.end(3);
    expect(geo.getAttribute('aMotion').getY(0)).toBe(0);
    expect(geo.getAttribute('aMotion').getZ(0)).toBe(0);
    renderer.mesh.geometry.dispose();
    mat.dispose();
    renderer.mesh.customDepthMaterial?.dispose();
  });
});
