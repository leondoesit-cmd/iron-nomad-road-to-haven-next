import { beforeAll, describe, expect, it, vi } from 'vitest';
import { legById } from '../src/data';
import { initPhysics } from '../src/physics/physics';
import { LegScene } from '../src/game/legScene';
import { ChunkSource } from '../src/world/chunkgen';
import { facadeHash, shopBays, shopFaceOf } from '../src/world/shopGlass';
import { GLASS_HP } from '../src/sim/glass';
import { newBuild } from '../src/sim/garage';
import type { Aabb } from '../src/world/layout';
import { fakeServices, run } from './helpers/sim';

vi.setConfig({ testTimeout: 120000 });

beforeAll(async () => {
  await initPhysics();
});

const leg = legById('L3P');
const src = new ChunkSource(leg);
const DT = 1 / 60;

/** Every pane of street glass in the leg, by walking the chunks along the boulevard. */
function allPanes(from: ChunkSource = src): Aabb[] {
  const out: Aabb[] = [];
  for (let cx = -1; cx <= 0; cx++) for (let cz = -2; cz < 40; cz++) out.push(...from.get(cx, cz).aabbs.filter((a) => a.pane));
  return out;
}

describe('the facade hash, ported to the CPU', () => {
  it('stays in 0..1, never repeats exactly for neighbouring bays, and splits shutters from windows about 45:55', () => {
    let windows = 0;
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const h = facadeHash(i % 17, (i * 0.37 + Math.floor(i / 17) * 97) * 3.7);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
      seen.add(h);
      if (h >= 0.45) windows++;
    }
    expect(windows / 2000).toBeGreaterThan(0.45);
    expect(windows / 2000).toBeLessThan(0.65);
    expect(seen.size).toBeGreaterThan(1500);
  });

  it('is the same every time', () => {
    expect(facadeHash(3, 41.7)).toBe(facadeHash(3, 41.7));
    expect(shopBays(30, 0.31, 3, 2)).toEqual(shopBays(30, 0.31, 3, 2));
  });

  it('lays no bay over the end of the wall and none narrower than a person', () => {
    for (const len of [14, 22, 31.5, 60]) {
      for (const { s0, s1 } of shopBays(len, 0.5, 1, 2)) {
        expect(s1).toBeLessThanOrEqual(len);
        expect(s1 - s0).toBeGreaterThanOrEqual(0.9);
      }
    }
  });
});

describe('the shopfronts of Haim Ozer', () => {
  const panes = allPanes();

  it('have panes of glass over their window bays, and only on the street side', () => {
    expect(panes.length).toBeGreaterThan(12);
    const lots = src.layout.lots.filter((l) => l.kind === 'building');
    for (const a of panes) {
      expect(a.mat).toBe('glass');
      expect(a.kind).toBe('partition');
      expect(a.pane).toBe('shop');
      expect(a.wall).toBeUndefined();
      expect(Math.abs(a.paneN![0])).toBe(1);
      // Thin, tall enough to step through, and standing just off a facade of a lot on the boulevard.
      expect(a.maxX - a.minX).toBeLessThan(0.1);
      expect(a.y1 - a.y0).toBeGreaterThan(2);
      const lot = lots.find((l) => a.minZ >= l.z0 - 0.01 && a.maxZ <= l.z1 + 0.01 && (Math.abs(a.minX - l.x0) < 0.3 || Math.abs(a.maxX - l.x1) < 0.3));
      expect(lot, `pane at ${a.minX},${a.minZ}`).toBeDefined();
    }
  });

  it('no pane overlaps a building or another pane', () => {
    const bldg = [...src.layout.lots.filter((l) => l.kind === 'building')];
    for (const a of panes) {
      for (const l of bldg) {
        const inside = a.minX > l.x0 + 0.01 && a.maxX < l.x1 - 0.01 && a.maxZ > l.z0 && a.minZ < l.z1;
        expect(inside).toBe(false);
      }
    }
    for (let i = 0; i < panes.length; i++) {
      for (let j = i + 1; j < panes.length; j++) {
        const p = panes[i];
        const q = panes[j];
        const overlap = p.minX < q.maxX && p.maxX > q.minX && p.minZ < q.maxZ - 0.01 && p.maxZ > q.minZ + 0.01;
        expect(overlap).toBe(false);
      }
    }
  });

  it('leave the sign-lit shop and the landmarks to their own fronts', () => {
    for (const b of src.get(0, 5).buildings.concat(src.get(-1, 5).buildings)) {
      if (b.shop || b.role) expect(shopFaceOf(b)).toBeNull();
    }
  });
});

describe('breaking a shop window in the street', () => {
  function scene() {
    const h = fakeServices();
    const sc = new LegScene(h.svc, leg);
    for (const p of sc.players) p.exitVehicle(false);
    const pane = allPanes(sc.src)[0];
    const x = (pane.minX + pane.maxX) / 2;
    const z = (pane.minZ + pane.maxZ) / 2;
    sc.players[0].placeAt(x + pane.paneN![0] * 14, z, 0);
    run(sc, 6);
    const view = [...sc.chunks.values()].find((v) => v.data.aabbs.includes(pane))!;
    return { sc, pane, x, z, view };
  }

  const shoot = (sc: LegScene, pane: Aabb, x: number, z: number, damage: number) => {
    const n = pane.paneN!;
    sc.combat.shoot(x + n[0] * 6, (pane.y0 + pane.y1) / 2, z, -n[0], 0, 0, { side: 'convoy', damage, range: 40, ammo: 'pistol', tracer: false });
    for (let i = 0; i < 12; i++) sc.tick(DT);
  };

  it('is there as a collider and a pane, whole', () => {
    const { sc, pane, view } = scene();
    expect(sc.obs.byId(pane.id)).toBeDefined();
    expect(view).toBeDefined();
    expect(view.panes.has(String(pane.id))).toBe(true);
    expect(view.panes.stageOf(String(pane.id))).toBe(0);
    sc.dispose();
  });

  it('cracks under a few rounds and goes on the last one, with a pane gone and a collider gone', () => {
    const { sc, pane, x, z, view } = scene();
    const key = String(pane.id);
    const shards0 = sc.gore.gibs.counts().shard;
    // 8 a round: well short of what a shop front takes.
    shoot(sc, pane, x, z, 8);
    expect(view.panes.stageOf(key)).toBe(0);
    shoot(sc, pane, x, z, 8);
    shoot(sc, pane, x, z, 8);
    expect(view.panes.stageOf(key)).toBeGreaterThanOrEqual(1);
    expect(view.panes.stageOf(key)).toBeLessThan(3);
    expect(sc.obs.byId(pane.id)).toBeDefined();
    expect(sc.world!.panes).toBe(0);
    for (let i = 0; i < 6 && view.panes.stageOf(key) < 3; i++) shoot(sc, pane, x, z, 8);
    expect(view.panes.stageOf(key)).toBe(3);
    expect(sc.world!.panes).toBe(1);
    expect(sc.obs.byId(pane.id)).toBeUndefined();
    expect(sc.gore.gibs.counts().shard).toBeGreaterThan(shards0);
    // A reload of the chunk would not bring it back.
    expect(sc.src.get(view.data.cx, view.data.cz).aabbs.includes(pane)).toBe(false);
    sc.dispose();
  });

  it('a heavy round shatters a shop pane at once', () => {
    const { sc, pane, x, z, view } = scene();
    shoot(sc, pane, x, z, GLASS_HP.shop + 5);
    expect(view.panes.stageOf(String(pane.id))).toBe(3);
    sc.dispose();
  });

  it('stops a person until it goes: its box is in the obstacle index and in physics, and both are gone after', () => {
    const { sc, pane, x, z } = scene();
    const mid = (pane.y0 + pane.y1) / 2;
    expect(sc.obs.pointInside(x, z, mid)).toBeTruthy();
    // A line of sight passes through it all the same (it stops short of the wall behind).
    const n = pane.paneN!;
    expect(sc.obs.segmentFirst(x + n[0] * 3, z, x - n[0] * 0.04, z, 1.5)).toBeNull();
    shoot(sc, pane, x, z, 50);
    expect(sc.obs.pointInside(x, z, mid)).toBeFalsy();
    sc.dispose();
  });

  it('a swing at it, and a blast near it, break panes', () => {
    const { sc, pane, x, z, view } = scene();
    const key = String(pane.id);
    sc.world!.hit(pane, 30, 'ram', { x, y: (pane.y0 + pane.y1) / 2, z });
    expect(view.panes.stageOf(key)).toBe(3);
    const rest = allPanes(sc.src).filter((a) => a !== pane && view.panes.has(String(a.id)) && sc.obs.byId(a.id));
    expect(rest.length).toBeGreaterThan(0);
    const c = rest[0];
    sc.world!.blast((c.minX + c.maxX) / 2 + c.paneN![0] * 2, (c.y0 + c.y1) / 2, (c.minZ + c.maxZ) / 2, 8, 100);
    expect(view.panes.stageOf(String(c.id))).toBe(3);
    sc.dispose();
  });

  it('a car at speed goes through a shop front, and the pane is gone behind it', () => {
    const { sc, pane, x, z, view } = scene();
    const n = pane.paneN!;
    const x0 = x + n[0] * 9;
    const v = sc.spawnVehicle({ build: newBuild('sedan', { seed: 4 }), x: x0, z, y: sc.groundAt(x0, z) + 0.3, yaw: -n[0] * Math.PI / 2, ownerIndex: -1, faction: 'neutral' });
    run(sc, 1.5);
    const f = v.body.forward();
    expect(Math.abs(f[0] + n[0])).toBeLessThan(0.1);
    const lv = { x: f[0] * 9, y: 0, z: f[2] * 9 };
    v.body.body.setLinvel(lv, true);
    (v.body as unknown as { prevVel: typeof lv }).prevVel = { ...lv };
    for (let i = 0; i < 90 && view.panes.stageOf(String(pane.id)) < 3; i++) {
      sc.tick(DT);
      const g = v.body.body.linvel();
      // Keep it rolling toward the glass the way a driver on the throttle would.
      if (Math.hypot(g.x, g.z) < 7) v.body.body.setLinvel({ x: f[0] * 8, y: g.y, z: f[2] * 8 }, true);
    }
    expect(view.panes.stageOf(String(pane.id))).toBe(3);
    expect(sc.obs.byId(pane.id)).toBeUndefined();
    sc.dispose();
  });
});
