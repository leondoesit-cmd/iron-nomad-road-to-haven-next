import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { WorldMemory } from '../src/game/worldMemory';
import { ChunkSource } from '../src/world/chunkgen';
import { ChunkView } from '../src/render/chunkview';
import { CHUNK } from '../src/world/terrain';
import { fakeServices, run } from './helpers/sim';

// Streaming is paced so that no tick pays for a whole chunk. These tests pin what that must not change.
vi.setConfig({ testTimeout: 120000 });

beforeAll(async () => {
  await initPhysics();
});

const leg = legById('W');

/** Every vertex the chunk draws: terrain, buildings, props and ground cover (instances count once per instance). */
function drawn(v: ChunkView) {
  let verts = 0;
  let meshes = 0;
  v.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    meshes++;
    verts += (m.geometry.attributes.position?.count ?? 0) * ((m as THREE.InstancedMesh).count ?? 1);
  });
  return { verts, meshes };
}

describe('stepped chunk data', () => {
  it('is the same chunk whether it is made at once or a slice at a time', () => {
    const a = new ChunkSource(leg);
    const b = new ChunkSource(leg);
    let slices = 0;
    while (!b.step(0, 3)) slices++;
    expect(slices).toBeGreaterThan(3);
    const whole = a.get(0, 3);
    const stepped = b.get(0, 3);
    expect(b.has(0, 3)).toBe(true);
    expect(Array.from(stepped.heights)).toEqual(Array.from(whole.heights));
    expect(stepped.aabbs.length).toBe(whole.aabbs.length);
    expect(stepped.props.length).toBe(whole.props.length);
    expect(stepped.city).toBe(whole.city);
  });

  it('is not made twice: get after a few steps finishes the same chunk', () => {
    const src = new ChunkSource(leg);
    src.step(1, 4);
    src.step(1, 4);
    const c = src.get(1, 4);
    expect(src.get(1, 4)).toBe(c);
    expect(src.step(1, 4)).toBe(true);
  });
});

describe('staged chunk views', () => {
  function open() {
    const h = fakeServices();
    const sc = new LegScene(h.svc, leg, { memory: new WorldMemory() });
    run(sc, 3);
    return sc;
  }
  const build = (sc: LegScene, data: ChunkView['data'], staged: boolean) =>
    new ChunkView(data, sc.terrain!, (sc as unknown as { mats: ConstructorParameters<typeof ChunkView>[2] }).mats, sc.P, { scatter: 1, staged });

  it('has ground and colliders at once and the rest later, and ends up the same as a whole one', () => {
    const sc = open();
    // A chunk with something in it: the road runs through the start chunk.
    const data = [...sc.chunks.values()].sort((a, b) => b.data.props.length + b.data.aabbs.length - (a.data.props.length + a.data.aabbs.length))[0].data;
    const whole = build(sc, data, false);
    const staged = build(sc, data, true);
    expect(whole.pending).toBe(0);
    expect(staged.pending).toBeGreaterThan(0);
    expect(staged.colliders.length).toBe(whole.colliders.length);
    expect(drawn(staged).verts).toBe(0);
    let steps = 0;
    while (staged.buildNext()) steps++;
    expect(steps).toBeGreaterThan(5);
    expect(staged.pending).toBe(0);
    expect(drawn(staged)).toEqual(drawn(whole));
    whole.dispose();
    staged.dispose();
  });

  it('can be thrown away half built', () => {
    const sc = open();
    const data = [...sc.chunks.values()][0].data;
    const v = build(sc, data, true);
    v.buildNext();
    v.buildNext();
    expect(() => v.dispose()).not.toThrow();
  });

  it('tells the landscape when its ground is in, not before', () => {
    const sc = open();
    const data = [...sc.chunks.values()][0].data;
    let told = 0;
    const v = new ChunkView(data, sc.terrain!, (sc as unknown as { mats: ConstructorParameters<typeof ChunkView>[2] }).mats, sc.P, { scatter: 1, staged: true, onGround: () => told++ });
    expect(told).toBe(0);
    while (told === 0 && v.buildNext());
    expect(told).toBe(1);
    expect(v.pending).toBeGreaterThan(0);
    while (v.buildNext());
    expect(told).toBe(1);
    v.dispose();
  });
});

describe('paced streaming in a real leg', () => {
  function open() {
    const h = fakeServices();
    const sc = new LegScene(h.svc, leg, { memory: new WorldMemory() });
    run(sc, 3);
    return sc;
  }
  /** Calls into the streaming machinery in one tick, counted by spying on its three kinds of work. */
  function spy(sc: LegScene) {
    const counts = { n: 0 };
    const hit = (o: object, k: string) => {
      const f = (o as Record<string, (...a: unknown[]) => unknown>)[k].bind(o);
      (o as Record<string, unknown>)[k] = (...a: unknown[]) => {
        counts.n++;
        return f(...a);
      };
    };
    hit(sc.src, 'step');
    const proto = ChunkView.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    const orig = proto.buildNext;
    proto.buildNext = function (this: ChunkView, ...a: unknown[]) {
      counts.n++;
      return orig.apply(this, a);
    };
    return { counts, restore: () => (proto.buildNext = orig) };
  }
  const moveTo = (sc: LegScene, z: number) => {
    for (const p of sc.players) p.vehicle!.body.setPose(0, sc.groundAt(0, z) + 1.2, z, 0);
  };

  it('keeps each tick to a handful of steps, and has the ground under the convoy within a few ticks of a jump', () => {
    const sc = open();
    const s = spy(sc);
    try {
      moveTo(sc, 1200);
      const cz = Math.floor(1200 / CHUNK);
      let worst = 0;
      let groundTick = -1;
      for (let i = 0; i < 400; i++) {
        s.counts.n = 0;
        sc.tick(1 / 60);
        worst = Math.max(worst, s.counts.n);
        const own = [...sc.chunks.values()].find((c) => c.data.cx === 0 && c.data.cz === cz);
        if (groundTick < 0 && own) groundTick = i;
      }
      expect(worst).toBeLessThanOrEqual(6);
      expect(groundTick).toBeGreaterThanOrEqual(0);
      expect(groundTick).toBeLessThan(40);
    } finally {
      s.restore();
    }
  });

  it('finishes every chunk around the convoy once it has settled', () => {
    const sc = open();
    moveTo(sc, 900);
    run(sc, 12);
    const here = Math.floor(900 / CHUNK);
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const c = [...sc.chunks.values()].find((v) => v.data.cx === dx && v.data.cz === here + dz);
        expect(c, `chunk ${dx},${here + dz}`).toBeTruthy();
        expect(c!.pending).toBe(0);
      }
    }
  });

  it('keeps found cars to one spawn per pass', () => {
    const sc = open();
    // Put the convoy in the middle of the cars: many are in range at once.
    const cars = [...sc.cars.states.values()];
    const mid = cars[Math.floor(cars.length / 2)];
    moveTo(sc, mid.z);
    for (const p of sc.players) p.vehicle!.body.setPose(mid.x, sc.groundAt(mid.x, mid.z) + 1.2, mid.z, 0);
    let worst = 0;
    let last = sc.vehicles.length;
    for (let i = 0; i < 600; i++) {
      sc.tick(1 / 60);
      worst = Math.max(worst, sc.vehicles.length - last);
      last = sc.vehicles.length;
    }
    expect(worst).toBeLessThanOrEqual(1);
    expect(sc.vehicles.length).toBeGreaterThan(4);
  });
});
