import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { DISSOLVE_TIME, Fades, dissolveOf, dissolveTwin, markDissolvable, noteDrawn, twinWarmups } from '../src/render/dissolve';
import { CarStandIns } from '../src/render/carStandIns';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { WorldMemory } from '../src/game/worldMemory';
import type { ChunkView } from '../src/render/chunkview';
import { fakeServices, run } from './helpers/sim';

vi.setConfig({ testTimeout: 120000 });

const compiled = (m: THREE.Material) => {
  const shader = {
    uniforms: {} as Record<string, THREE.IUniform>,
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  };
  m.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
  return shader;
};

describe('fades', () => {
  const root = () => {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
    g.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
    return g;
  };

  it('dissolves a root in over DISSOLVE_TIME, then draws it as it is', () => {
    const f = new Fades();
    const g = root();
    f.fadeIn(g);
    for (const m of g.children) expect(dissolveOf(m)).toBe(0);
    f.update(DISSOLVE_TIME / 2);
    for (const m of g.children) expect(dissolveOf(m)).toBeCloseTo(0.5);
    f.update(DISSOLVE_TIME / 2 + 0.01);
    for (const m of g.children) {
      expect(dissolveOf(m)).toBe(1);
      expect(m.userData.dissolve).toBeUndefined();
    }
    expect(f.fading(g)).toBe(false);
  });

  it('dissolves a root out and only then lets it go; wanted again, it turns round from where it is', () => {
    const f = new Fades();
    const g = root();
    const done = vi.fn();
    f.fadeOut(g, done);
    f.update(DISSOLVE_TIME * 0.75);
    expect(dissolveOf(g.children[0])).toBeCloseTo(0.25);
    f.fadeIn(g);
    expect(f.leaving(g)).toBe(false);
    f.update(DISSOLVE_TIME * 0.25);
    expect(dissolveOf(g.children[0])).toBeCloseTo(0.5);
    f.fadeOut(g, done);
    f.update(DISSOLVE_TIME);
    expect(done).toHaveBeenCalledTimes(1);
    expect(dissolveOf(g.children[0])).toBe(1);
  });
});

describe('dissolve twins', () => {
  it('draw with the material’s own shader, plus a discard of the pixels not yet in', () => {
    const base = new THREE.MeshStandardMaterial({ color: 0x336699, vertexColors: true });
    base.onBeforeCompile = (s) => {
      s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\n// patched');
    };
    base.customProgramCacheKey = () => 'mine';
    noteDrawn(base);
    const t = dissolveTwin(base, 0.3);
    expect(t).not.toBe(base);
    expect(t.customProgramCacheKey()).toBe('mine|dissolve');
    expect((t as THREE.MeshStandardMaterial).vertexColors).toBe(true);
    const s = compiled(t);
    expect(s.fragmentShader).toContain('// patched');
    expect(s.fragmentShader).toContain('uniform float uDissolve;');
    expect(s.fragmentShader).toContain('if ( inDissolveNoise() >= uDissolve ) discard;');
    expect(s.uniforms.uDissolve.value).toBe(0.3);
    // A colour changed on the material after its twins were made reaches them.
    base.color.setHex(0xff0000);
    noteDrawn(new THREE.MeshBasicMaterial());
    expect((dissolveTwin(base, 0.3) as THREE.MeshStandardMaterial).color.getHex()).toBe(0xff0000);
  });

  it('never draws two different fades in a row with the same material, so three uploads each one', () => {
    const base = new THREE.MeshStandardMaterial();
    noteDrawn(new THREE.MeshBasicMaterial());
    const a = dissolveTwin(base, 0.2);
    noteDrawn(a);
    const b = dissolveTwin(base, 0.6);
    expect(b).not.toBe(a);
    noteDrawn(b);
    // The same fade again can go on with the same twin: its uniform holds it already.
    expect(dissolveTwin(base, 0.6)).toBe(b);
    noteDrawn(b);
    expect(dissolveTwin(base, 0.9)).toBe(a);
  });

  it('a default material’s twin keeps its own program key, apart from other kinds', () => {
    const a = dissolveTwin(new THREE.MeshStandardMaterial(), 0.5);
    const b = dissolveTwin(new THREE.MeshBasicMaterial(), 0.5);
    expect(a.customProgramCacheKey().endsWith('|dissolve')).toBe(true);
    expect(a.type).not.toBe(b.type);
  });

  it('warm-up stands in for each new material and its twin under dissolvable roots only, once', () => {
    const scene = new THREE.Scene();
    const keep = new THREE.Group();
    markDissolvable(keep);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.123 });
    keep.add(new THREE.Mesh(new THREE.BoxGeometry(), mat));
    keep.add(new THREE.InstancedMesh(new THREE.BoxGeometry(), mat, 3));
    scene.add(keep);
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshLambertMaterial()));
    const g = twinWarmups(scene)!;
    // The plain mesh and the instanced one want different programs: two pairs, and nothing for the root that cannot dissolve.
    expect(g.children.length).toBe(4);
    expect(g.children.filter((o) => (o as THREE.InstancedMesh).isInstancedMesh).length).toBe(2);
    expect(g.children.every((o) => ((o as THREE.Mesh).material as THREE.Material).type === 'MeshStandardMaterial')).toBe(true);
    expect(twinWarmups(scene)).toBeNull();
  });
});

describe('parked car stand-ins', () => {
  it('stand where the car is, in its paint, and step aside as the real car comes in', () => {
    const cars = new Map([
      ['a', { chassis: 'sedan', x: 10, y: 1, z: 20, yaw: 0.5, paint: 0x2244aa, hulk: false }],
      ['b', { chassis: 'sedan', x: -5, y: 0, z: 3, yaw: 0, paint: 0x2244aa, hulk: true }],
      ['c', { chassis: 'van', x: 0, y: 0, z: 0, yaw: 0, paint: 0xffffff, hulk: false }],
      ['d', { chassis: 'moped', x: 0, y: 0, z: 0, yaw: 0, paint: 0xffffff, hulk: false }],
    ]);
    const s = new CarStandIns(cars);
    // One draw per kind of body; a kind without a body of its own is not drawn.
    expect(s.group.children.map((c) => c.name).sort()).toEqual(['carStandIn:sedan', 'carStandIn:van']);
    const sedan = s.group.children.find((c) => c.name === 'carStandIn:sedan') as THREE.InstancedMesh;
    const m = new THREE.Matrix4();
    sedan.getMatrixAt(0, m);
    expect(new THREE.Vector3().setFromMatrixPosition(m).toArray()).toEqual([10, 1, 20]);
    const c = new THREE.Color();
    sedan.getColorAt(1, c);
    expect(c.getHex()).not.toBe(new THREE.Color(0x2244aa).getHex());
    const cut = sedan.geometry.getAttribute('aCut') as THREE.InstancedBufferAttribute;
    s.setCut('a', 0.4);
    s.flush();
    expect(cut.array[0]).toBeCloseTo(0.4);
    expect(cut.version).toBeGreaterThan(0);
    const sh = compiled(sedan.material as THREE.Material);
    expect(sh.vertexShader).toContain('if ( aCut >= 1.0 ) transformed = vec3( 0.0 );');
    expect(sh.fragmentShader).toContain('if ( inDissolveNoise() < vFarCut ) discard;');
    s.dispose();
  });
});

describe('streamed chunks', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  it('stay out of sight while they are built, then dissolve in as the far landscape over them dissolves out', () => {
    const h = fakeServices({ solo: true });
    const sc = new LegScene(h.svc, legById('W'), { memory: new WorldMemory() });
    run(sc, 6);
    const chunks = (sc as unknown as { chunks: Map<number, ChunkView> }).chunks;
    const land = (sc as unknown as { landscape: { loaded: Uint8Array; cx0: number; cz0: number; cw: number } }).landscape;
    const green = (v: ChunkView) => land.loaded[((v.data.cz - land.cz0) * land.cw + v.data.cx - land.cx0) * 4 + 1];
    // The chunks round the start are all in once it has settled.
    const first = [...chunks.values()];
    expect(first.length).toBeGreaterThan(0);
    for (const v of first) {
      expect(v.shown).toBe(true);
      expect(v.fade.value).toBe(1);
    }
    // Move on by a few chunks so new ones stream in, and watch them.
    const p = sc.players[0];
    const at = p.vehicle ? p.vehicle.position : p.pos;
    const x = at.x;
    const z = at.z + 700;
    if (p.vehicle) p.vehicle.body.setPose(x, sc.groundAt(x, z) + 1.2, z, 0);
    else p.pos.set(x, sc.groundAt(x, z) + 1, z);
    const seen = new Map<ChunkView, { hidden: boolean; fades: number[] }>();
    let checked = 0;
    for (let i = 0; i < 60 * 12; i++) {
      sc.tick(1 / 60);
      for (const v of chunks.values()) {
        if (first.includes(v)) continue;
        let s = seen.get(v);
        if (!s) seen.set(v, (s = { hidden: false, fades: [] }));
        if (!v.shown) {
          s.hidden = true;
          expect(v.group.visible).toBe(false);
          expect(green(v)).toBe(0);
        } else {
          s.fades.push(v.fade.value);
          if (!v.pending && !v.leaving) {
            // The mask holds the same fade the chunk is drawn at, to the step.
            expect(green(v)).toBe(Math.round(v.fade.value * 255));
            checked++;
          }
        }
      }
    }
    const dissolved = [...seen.values()].filter((s) => s.hidden && s.fades.length && s.fades[0] < 1);
    expect(dissolved.length).toBeGreaterThan(2);
    for (const s of dissolved) {
      // Up from nothing to all in, never back, in about DISSOLVE_TIME.
      for (let i = 1; i < s.fades.length; i++) expect(s.fades[i]).toBeGreaterThanOrEqual(s.fades[i - 1]);
      const steps = s.fades.findIndex((f) => f >= 1);
      if (steps >= 0) expect(Math.abs(steps / 60 - DISSOLVE_TIME)).toBeLessThan(0.1);
    }
    expect(checked).toBeGreaterThan(0);
    // Once in, nothing of a chunk is drawn through a twin.
    for (const v of chunks.values()) {
      if (v.fade.value < 1) continue;
      v.group.traverse((o) => expect(o.userData.dissolve).toBeUndefined());
    }
    sc.dispose();
  });
});
