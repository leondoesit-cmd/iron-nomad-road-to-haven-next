import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { CITY_PLANS } from '../src/world/plans';
import { ChunkSource } from '../src/world/chunkgen';
import { clearPlans, copyGraph, planMade, takePlan } from '../src/world/planCache';
import { LegScene } from '../src/game/legScene';
import { WorldMemory } from '../src/game/worldMemory';
import { fakeServices, run } from './helpers/sim';

// The world plan cache (`world/planCache.ts`): one build per leg, a pristine copy per scene, the terrain shared.

// Whole open-world scenes run here: a loaded machine needs more than the default.
vi.setConfig({ testTimeout: 180000 });

beforeAll(async () => {
  await initPhysics();
});

/**
 * A structural fingerprint of an object graph: every number, string and boolean in a stable walk order, with shared
 * references noted by first-visit index. Numeric `id` fields (aabb ids come from a page-wide counter) are skipped.
 */
function fingerprint(root: unknown, skipIds = false): string {
  const seen = new Map<object, number>();
  const out: string[] = [];
  const walk = (v: unknown, key: string) => {
    if (skipIds && key === 'id' && typeof v === 'number') return;
    if (v === null || typeof v !== 'object') {
      out.push(typeof v === 'number' ? (Number.isFinite(v) ? v.toPrecision(12) : String(v)) : String(v));
      return;
    }
    const at = seen.get(v);
    if (at !== undefined) {
      out.push(`@${at}`);
      return;
    }
    seen.set(v, seen.size);
    if (ArrayBuffer.isView(v)) {
      const a = v as unknown as ArrayLike<number>;
      let h = 0;
      for (let i = 0; i < a.length; i++) h = (Math.imul(h, 31) + Math.round(a[i] * 1000)) | 0;
      out.push(`ta${a.length}:${h}`);
      return;
    }
    if (v instanceof Map) {
      out.push(`map${v.size}`);
      for (const [k, x] of v) {
        walk(k, '');
        walk(x, '');
      }
      return;
    }
    if (v instanceof Set) {
      out.push(`set${v.size}`);
      for (const x of v) walk(x, '');
      return;
    }
    const keys = Object.keys(v);
    out.push(`{${keys.join(',')}}`);
    for (const k of keys) walk((v as Record<string, unknown>)[k], k);
  };
  walk(root, '');
  return out.join('|');
}

describe('world plan cache', () => {
  const leg = legById('W');

  it('hands out pristine copies that match a fresh build, sharing the terrain and the data', () => {
    clearPlans();
    expect(planMade(leg)).toBe(false);
    const a = takePlan(leg);
    expect(planMade(leg)).toBe(true);
    const b = takePlan(leg);
    expect(a).not.toBe(b);
    expect(a).toBeInstanceOf(ChunkSource);
    expect(a.layout).not.toBe(b.layout);
    expect(a.layout.zones).not.toBe(b.layout.zones);
    expect(a.layout.rural[0]).not.toBe(b.layout.rural[0]);
    // The terrain is one object for every copy, so render caches keyed by it stay warm; the data stays the data.
    expect(a.layout.terrain).toBe(b.layout.terrain);
    expect(a.leg).toBe(leg);
    expect(a.layout.leg).toBe(leg);
    expect(a.layout.plan).toBe(Object.values(CITY_PLANS)[0]);
    // Methods still work on the copies (class instances keep their class).
    expect(a.layout.blockedAt(a.layout.start.x, a.layout.start.z, 1)).toBe(b.layout.blockedAt(b.layout.start.x, b.layout.start.z, 1));
    expect(fingerprint(a)).toBe(fingerprint(b));
    // And a copy is what a fresh build would have made (aabb ids aside: they count up across the page).
    const fresh = new ChunkSource(leg);
    expect(fingerprint(a.layout, true)).toBe(fingerprint(fresh.layout, true));
    expect(fingerprint(a.get(0, 0), true)).toBe(fingerprint(fresh.get(0, 0), true));
  });

  it('keeps one copy\'s changes out of the others', () => {
    const a = takePlan(leg);
    const before = fingerprint(takePlan(leg).layout);
    const zone = a.layout.zones.find((z) => z.containers.length)!;
    zone.containers[0].taken = true;
    a.layout.aabbs[0].hp = -5;
    a.layout.rural[0].plan.walls.pop();
    a.get(1, 1);
    const b = takePlan(leg);
    expect(fingerprint(b.layout)).toBe(before);
    expect(b.layout.zones.find((z) => z.id === zone.id)!.containers[0].taken).toBeFalsy();
  });

  it('copies graphs faithfully: shared references, classes, maps, sets, typed arrays, kept objects', () => {
    class P {
      constructor(public x: number) {}
      twice() {
        return this.x * 2;
      }
    }
    const kept = { k: 1 };
    const shared = { s: 2 };
    const root = { a: [shared, shared], m: new Map([['x', shared]]), s: new Set([shared]), t: new Float32Array([1, 2]), p: new P(3), kept };
    const c = copyGraph(root, (o) => o === kept);
    expect(c.a[0]).toBe(c.a[1]);
    expect(c.a[0]).not.toBe(shared);
    expect(c.m.get('x')).toBe(c.a[0]);
    expect([...c.s][0]).toBe(c.a[0]);
    expect(c.t).not.toBe(root.t);
    expect([...c.t]).toEqual([1, 2]);
    expect(c.p).toBeInstanceOf(P);
    expect(c.p.twice()).toBe(6);
    expect(c.kept).toBe(kept);
    // A deep chain does not overflow the stack.
    let chain: { next: unknown } = { next: null };
    for (let i = 0; i < 200000; i++) chain = { next: chain };
    expect(() => copyGraph(chain, () => false)).not.toThrow();
  });

  it('a scene never writes to the shared terrain', () => {
    const h = fakeServices();
    const sc = new LegScene(h.svc, leg, { memory: new WorldMemory() });
    const T = sc.src.layout.terrain;
    const before = fingerprint(T);
    // Drive, walk about, let the world stream and the weather turn.
    for (const p of sc.players) p.autopilot = { speed: 18 };
    run(sc, 20);
    for (const p of sc.players) if (p.vehicle) p.exitVehicle(false);
    run(sc, 3);
    expect(fingerprint(T)).toBe(before);
    sc.dispose();
  });

  it('keeps a run on its own copy from one day to the next, and gives a new run a new one', () => {
    const memory = new WorldMemory();
    const day1 = new LegScene(fakeServices().svc, leg, { memory });
    const src = day1.src;
    expect(memory.src).toBe(src);
    day1.capture(memory);
    day1.dispose();
    const day2 = new LegScene(fakeServices().svc, leg, { memory, start: { x: src.layout.start.x, z: src.layout.start.z, yaw: 0 } });
    expect(day2.src).toBe(src);
    day2.dispose();
    const other = new LegScene(fakeServices().svc, leg, { memory: new WorldMemory() });
    expect(other.src).not.toBe(src);
    expect(other.src.layout.terrain).toBe(src.layout.terrain);
    other.dispose();
  });
});
