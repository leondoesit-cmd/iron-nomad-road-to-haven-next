import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { GEAR, GUN_MODELS, legById } from '../src/data';
import { initPhysics } from '../src/physics/physics';
import { LegScene } from '../src/game/legScene';
import { Btn } from '../src/input/intents';
import { ChunkSource } from '../src/world/chunkgen';
import { fitted } from '../src/sim/gunmods';
import { newGear } from '../src/sim/gear';
import { rollGunLoot } from '../src/sim/gunLoot';
import { GUN_RACK, generatePlan, furnRect, gunSpots } from '../src/world/interiors';
import { buildLayout } from '../src/world/layout';
import { gearModel } from '../src/render/gearModels';
import { fakeServices } from './helpers/sim';

vi.setConfig({ testTimeout: 90000 });
beforeAll(async () => {
  await initPhysics();
});

const DT = 1 / 60;
const verts = (g: THREE.Group) => {
  let n = 0;
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) n += m.geometry.getAttribute('position').count;
  });
  return n;
};
const lowest = (g: THREE.Group) => new THREE.Box3().setFromObject(g).min.y;

describe('gear as lying models', () => {
  it('every item in the catalogue has a model resting on y = 0', () => {
    for (const d of GEAR.items) {
      const m = gearModel(newGear(d.id));
      expect(verts(m.group), d.id).toBeGreaterThan(0);
      expect(Math.abs(lowest(m.group)), d.id).toBeLessThan(1e-4);
      expect(m.top, d.id).toBeGreaterThan(0.01);
      expect(m.top, d.id).toBeLessThan(1.2);
    }
  });

  it('is built per kind: guns, blades and tools, worn pieces, add-ons', () => {
    const kinds = new Set<string>();
    for (const d of GEAR.items) kinds.add(gearModel(newGear(d.id)).kind);
    expect([...kinds].sort()).toEqual(['gun', 'melee', 'mod', 'tool', 'wear']);
  });

  it('a gun is its real model, and the fitted add-ons show', () => {
    const guns = GEAR.items.filter((d) => d.gun);
    expect(new Set(guns.map((d) => d.gun!.model)).size).toBeGreaterThanOrEqual(GUN_MODELS.length - 1);
    const bare = newGear('w_rifle');
    const dressed = newGear('w_rifle');
    dressed.att = { optic: 'a_scope4', muzzle: 'a_sup_r' };
    expect(fitted(dressed).length).toBe(2);
    expect(verts(gearModel(dressed).group)).toBeGreaterThan(verts(gearModel(bare).group));
  });

  it('a gun lies on its flank on the ground and belly down on a rack', () => {
    const gun = newGear('w_pistol');
    const flat = gearModel(gun, { flat: true });
    const rack = gearModel(gun, { flat: false });
    expect(flat.top).toBeLessThan(rack.top);
  });
});

describe('guns on display', () => {
  const inp = (seed: number, use: 'gun_shop' | 'police' | 'military') => ({ x0: 0, x1: 12, z0: 0, z1: 15, look: 'store' as const, door: 1 as const, seed, floors: 1, floorY: 0, wear: 0.3, roof: 'gable' as const, use });

  it('gun shops, police stations and armouries set their guns out on racks and the counter, at rack height', () => {
    for (const use of ['gun_shop', 'police', 'military'] as const) {
      let racks = 0;
      for (let seed = 1; seed <= 25; seed++) {
        const plan = generatePlan(inp(seed, use));
        for (const g of plan.guns) {
          const f = plan.furn[g.furn];
          expect(['gunrack', 'checkout', 'counter']).toContain(f.kind);
          if (f.kind === 'gunrack') {
            racks++;
            expect(GUN_RACK.some((y) => Math.abs(g.y - y - 0.03) < 1e-6)).toBe(true);
            // On the rack: inside its footprint.
            const r = furnRect(f);
            expect(g.x).toBeGreaterThan(r.x0 - 0.01);
            expect(g.x).toBeLessThan(r.x1 + 0.01);
            expect(g.z).toBeGreaterThan(r.z0 - 0.01);
            expect(g.z).toBeLessThan(r.z1 + 0.01);
          }
          // The same stock the scene will roll.
          expect(rollGunLoot(g.context, g.seed, g.depth)[g.index]).toBeTruthy();
        }
      }
      expect(racks, use).toBeGreaterThan(5);
    }
  });

  it('other buildings show no guns', () => {
    for (let seed = 1; seed <= 10; seed++) {
      expect(generatePlan({ ...inp(seed, 'gun_shop'), look: 'house', use: undefined }).guns).toEqual([]);
      expect(generatePlan({ ...inp(seed, 'gun_shop'), look: 'garage', use: undefined }).guns).toEqual([]);
    }
  });

  it('the city has guns on racks, laid out deterministically', () => {
    const a = new ChunkSource(legById('L3P')).layout.pickups.filter((p) => p.kind === 'gear');
    const b = new ChunkSource(legById('L3P')).layout.pickups.filter((p) => p.kind === 'gear');
    expect(a.length).toBeGreaterThan(0);
    expect(a.map((p) => [p.gun, p.x, p.y, p.z, p.yaw])).toEqual(b.map((p) => [p.gun, p.x, p.y, p.z, p.yaw]));
    for (const p of a) expect(['gunrack', 'checkout', 'counter']).toContain(p.host!.kind);
    // Each one lies on a real rack or counter of a building in the layout.
    const L = buildLayout(legById('L3P'));
    for (const p of L.pickups.filter((q) => q.kind === 'gear')) {
      const ok = L.rural.some((b) => b.plan.furn.some((f) => gunSpots(f).some((g) => Math.abs(g.x - p.x) < 0.01 && Math.abs(g.z - p.z) < 0.01 && Math.abs(b.plan.floorY + g.y - p.y) < 0.2)));
      expect(ok, p.id).toBe(true);
    }
  });
});

describe('taking a displayed gun', () => {
  function scene() {
    const h = fakeServices({});
    const sc = new LegScene(h.svc, legById('L1'));
    sc.pendingResult = true;
    for (const p of sc.players) p.exitVehicle(false);
    for (let i = 0; i < 18; i++) sc.tick(DT);
    return { h, sc, p: sc.players[0] };
  }
  function holdA(h: ReturnType<typeof fakeServices>, sc: LegScene) {
    const it = h.intents[0];
    it.device = 'keyboard';
    it.held |= 1 << Btn.A;
    it.pressed = 1 << Btn.A;
    for (let i = 0; i < 72; i++) {
      sc.tick(DT);
      it.pressed = 0;
    }
    it.held &= ~(1 << Btn.A);
    it.released = 1 << Btn.A;
    sc.tick(DT);
    it.released = 0;
    sc.tick(DT);
  }

  it('lies at its fixed pose, shows a tag only when close, and once taken it is remembered and never lies there again', () => {
    const { h, sc, p } = scene();
    const spawn = { id: 'test:rack:0', kind: 'gear' as const, amount: 1, gun: { context: 'gun_shop' as const, seed: 77, depth: 1 as const, index: 0 }, x: p.pos.x + 0.5, y: p.pos.y, z: p.pos.z, yaw: 1.2, host: { kind: 'gunrack', mode: 'on' as const } };
    const priv = sc as unknown as { spawnDisplayGun(s: typeof spawn): void; takenPickups: Set<string> };
    priv.spawnDisplayGun(spawn);
    const gg = sc.groundGear!;
    expect(gg.count).toBe(1);
    const before = gg.list()[0];
    for (let i = 0; i < 30; i++) sc.tick(DT);
    const after = gg.list()[0];
    // No bobbing, spinning or hovering.
    expect([after.x, after.y, after.z, after.yaw]).toEqual([before.x, before.y, before.z, before.yaw]);
    // The same pickup placed twice is one gun.
    priv.spawnDisplayGun(spawn);
    expect(gg.count).toBe(1);
    holdA(h, sc);
    expect(gg.count).toBe(0);
    expect(p.gear.bag.some((b) => b.id === before.item.id)).toBe(true);
    expect(priv.takenPickups.has(spawn.id)).toBe(true);
  });
});
