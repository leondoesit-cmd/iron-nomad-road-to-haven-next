import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { WorldMemory } from '../src/game/worldMemory';
import { acquire } from '../src/game/raiders';
import { treeKey } from '../src/game/wildfire';
import { riverFloodRise } from '../src/game/weatherSystem';
import { dayPlan, hydrograph, HYDRO_DT } from '../src/sim/climate';
import { clayAt, heightAt } from '../src/world/terrain';
import { FLOOD_RUN } from '../src/world/washes';
import type { TreeSpot } from '../src/world/flora';
import { fakeServices, run } from './helpers/sim';

// The weather in play: real leg scenes in Node, on the open-world leg.
vi.setConfig({ testTimeout: 180000 });

beforeAll(async () => {
  await initPhysics();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const leg = legById('W');

function open(day: number, start?: { x: number; z: number; yaw?: number }, memory = new WorldMemory()) {
  const h = fakeServices();
  h.campaign.day = day;
  const sc = new LegScene(h.svc, leg, { memory, start: start ? { x: start.x, z: start.z, yaw: start.yaw ?? 0 } : undefined });
  return { sc, memory, ...h };
}

/** Hold the clock at a time of day. */
function at(sc: LegScene, t: number) {
  sc.clock.frozen = true;
  sc.clock.elapsed = t * sc.clock.dayLength;
}

/** The campaign seed the headless services play. */
const SEED = fakeServices().campaign.seed;

/** The first day of that campaign with a storm over the mountains, and when its flood leaves them. */
function farDay() {
  for (let day = 2; day < 300; day++) {
    const p = dayPlan(SEED, day);
    if (p.cells.length !== 1 || p.cells[0].kind !== 'far' || p.night > 0) continue;
    const h = hydrograph(SEED, day);
    let m = 0;
    let tp = 0;
    h.wash.forEach((v, i) => {
      if (v > m) {
        m = v;
        tp = i * HYDRO_DT;
      }
    });
    if (m > 0.6 && tp < 0.5) return { day, tp, h };
  }
  throw new Error('no far-storm day');
}

describe('a fair first day', () => {
  it('has no rain, no wet ground, no flood and nothing to say about it', () => {
    const { sc } = open(1);
    for (const t of [0.15, 0.4, 0.65]) {
      at(sc, t);
      run(sc, 1.5);
      expect(sc.weather.rain).toBe(0);
      expect(sc.weather.wet).toBe(0);
      expect(sc.weather.riverK).toBe(0);
      expect(sc.weather.label()).toBe('');
    }
    sc.dispose();
  });
});

describe('a flash flood in play', () => {
  it('runs down Wadi Qedar under a clear sky and carries off a car parked in the bed', () => {
    const { day, tp } = farDay();
    const { sc, radio } = open(day, { x: 2150, z: 1200 });
    const net = sc.terrain!.washes!;
    const w = net.washes.find((q) => q.name === 'Wadi Qedar')!;
    const i = 90;
    // Before the flood: the wash is dry, and the radio has the warning out ahead of the water.
    at(sc, tp - 0.03);
    run(sc, 2);
    expect(sc.waterAt(w.x[i], w.z[i])).toBeNull();
    at(sc, tp - 0.006);
    run(sc, 1);
    expect(radio.some((r) => /FLASH FLOOD/.test(r))).toBe(true);
    expect(sc.weather.rain).toBe(0);
    // At the height of it, where we stand: deep, brown, running fast down the wash.
    const tHere = tp + w.s[i] / FLOOD_RUN + 0.004;
    at(sc, tHere);
    run(sc, 1);
    const water = sc.waterAt(w.x[i], w.z[i])!;
    expect(water.kind).toBe('flood');
    expect(water.depth).toBeGreaterThan(0.6);
    expect(sc.weather.label()).toBe('FLASH FLOOD');
    // A car left in the bed goes with it.
    const v = sc.players[0].vehicle!;
    v.setEngine(false);
    v.body.setPose(w.x[i], heightAt(sc.terrain!, w.x[i], w.z[i]) + 1.2, w.z[i], Math.atan2(w.dx[i], w.dz[i]) + Math.PI / 2);
    const x0 = v.position.x;
    const z0 = v.position.z;
    run(sc, 6, () => {
      sc.players[0].vehicle && (sc.input.intents[0].move = [0, 0]);
    });
    const moved = (v.position.x - x0) * w.dx[i] + (v.position.z - z0) * w.dz[i];
    expect(moved).toBeGreaterThan(4);
    // Hours later the wash is dry again.
    at(sc, tHere + 0.3);
    run(sc, 1);
    expect(sc.waterAt(w.x[i], w.z[i])).toBeNull();
    sc.dispose();
  });

  it('leaves a sheet of water on Qedar Pan through the afternoon, which is gone by the next morning but one', () => {
    const { day, tp } = farDay();
    const { sc } = open(day, { x: 2150, z: 1100 });
    const pan = sc.terrain!.washes!.pans.find((p) => p.name === 'Qedar Pan')!;
    at(sc, tp + pan.travel + 0.2);
    run(sc, 1);
    const pool = sc.waterAt(pan.x, pan.z);
    expect(pool?.kind).toBe('pool');
    expect(pool!.flow).toBeUndefined();
    sc.dispose();
    const later = open(day + 2, { x: 2150, z: 1100 });
    const plan = dayPlan(SEED, day + 2);
    if (!plan.cells.length && !plan.night && !dayPlan(SEED, day + 1).cells.length) {
      at(later.sc, 0.2);
      run(later.sc, 1);
      expect(later.sc.waterAt(pan.x, pan.z)).toBeNull();
    }
    later.sc.dispose();
  });

  it('raises the rivers: a river point is deeper, and the water spills out over the floodplain', () => {
    const { day, tp } = farDay();
    const hy = (() => {
      const { sc } = open(1);
      const r = sc.terrain!.hydro!.rivers.find((q) => q.key === 'yarkon')!;
      sc.dispose();
      return r;
    })();
    const k = 200;
    const x = hy.x[k];
    const z = hy.z[k];
    const calm = open(1, { x: x + 40, z: z + 40 });
    const base = calm.sc.waterAt(x, z)!;
    calm.sc.dispose();
    const { sc } = open(day, { x: x + 40, z: z + 40 });
    // The rivers peak after the flash flood, and slowly.
    const h = hydrograph(SEED, day);
    let tr = 0;
    h.river.forEach((v, i) => {
      if (v > h.river[Math.round(tr / HYDRO_DT)]) tr = i * HYDRO_DT;
    });
    expect(tr).toBeGreaterThan(tp);
    at(sc, tr);
    run(sc, 1);
    expect(sc.weather.riverK).toBeGreaterThan(0.2);
    const risen = sc.waterAt(x, z)!;
    expect(risen.level - base.level).toBeGreaterThan(0.2 * riverFloodRise('river'));
    expect(risen.level - base.level).toBeLessThanOrEqual(riverFloodRise('river') + 1e-6);
    const sp = (f?: [number, number]) => (f ? Math.hypot(f[0], f[1]) : 0);
    expect(sp(risen.flow)).toBeGreaterThan(sp(base.flow));
    // Just past the old waterline it is wet now.
    const nx = -hy.dz[k];
    const nz = hy.dx[k];
    let spilled = false;
    for (let d = hy.half[k] + 1.5; d < hy.half[k] + 7; d += 0.5) {
      for (const sgn of [-1, 1]) {
        const px = x + nx * d * sgn;
        const pz = z + nz * d * sgn;
        const w = sc.waterAt(px, pz);
        if (w && (w.kind === 'river' || w.kind === 'stream')) spilled = true;
      }
    }
    expect(spilled).toBe(true);
    sc.dispose();
  });
});

describe('lightning and fire', () => {
  /** A scene in the green country with a tree near the convoy, and that tree. */
  function inTheWoods(day = 3) {
    const { sc, memory, ...h } = open(day, { x: -1450, z: 900 });
    run(sc, 0.5);
    const near = (x: number, z: number, r: number) => (sc as unknown as { loadedTreesNear: (x: number, z: number, r: number) => TreeSpot[] }).loadedTreesNear(x, z, r);
    const p = sc.players[0];
    const px = p.vehicle?.position.x ?? p.pos.x;
    const pz = p.vehicle?.position.z ?? p.pos.z;
    let tree: TreeSpot | null = null;
    // One standing in a wood, with neighbours close enough to catch from it.
    for (let r = 20; r < 400 && !tree; r += 20) tree = near(px, pz, r).find((t) => near(t.x, t.z, 9).length >= 3) ?? null;
    return { sc, memory, tree: tree!, near, ...h };
  }

  it('goes for the tallest tree where it comes down, and never for a player', () => {
    const { sc, tree, near } = inTheWoods();
    expect(tree).toBeTruthy();
    sc.weather.strikeNear({ x: tree.x + 3, z: tree.z + 3 });
    const s = sc.weather.lastStrike!;
    expect(s.tree).not.toBeNull();
    expect(Math.hypot(s.x - tree.x, s.z - tree.z)).toBeLessThan(46);
    expect(s.y).toBeGreaterThan(sc.groundAt(s.x, s.z) + 3);
    // Out in the open by a player: nothing comes down on them.
    const p = sc.players[0];
    sc.weather.lastStrike = null;
    const px = p.vehicle?.position.x ?? p.pos.x;
    const pz = p.vehicle?.position.z ?? p.pos.z;
    if (!near(px, pz, 45).length) {
      sc.weather.strikeNear({ x: px + 2, z: pz + 2 });
      expect(sc.weather.lastStrike).toBeNull();
    }
    sc.dispose();
  });

  it('a burning tree flares up, burns whoever stands in it, spreads downwind when dry, and leaves a char that is remembered', () => {
    const { sc, tree, memory } = inTheWoods();
    const fire = sc.weather.fire;
    expect(fire.ignite(tree, 1)).not.toBeNull();
    // Stand a player at the trunk.
    const p = sc.players[0];
    if (p.vehicle) p.exitVehicle(false);
    run(sc, 0.3);
    const hp0 = p.hp;
    vi.spyOn(Math, 'random').mockReturnValue(0.01);
    for (let k = 0; k < 400; k++) {
      p.pos.x = tree.x + 1;
      p.pos.z = tree.z;
      fire.update(0.1, 0, 1, [6, 0]);
    }
    vi.restoreAllMocks();
    expect(fire.fires.length + fire.burnt.size).toBeGreaterThan(1);
    expect(p.hp).toBeLessThan(hp0);
    // Burn everything out.
    for (let k = 0; k < 3000 && fire.fires.length; k++) fire.update(0.1, 0, 0, [0, 0]);
    expect(fire.fires.length).toBe(0);
    expect(fire.burnt.get(treeKey(tree))).toBeGreaterThan(0.5);
    // The world remembers it overnight.
    expect(memory.burnt.get(treeKey(tree))).toBe(fire.burnt.get(treeKey(tree)));
    const save = memory.serialize();
    expect(WorldMemory.restore(save).burnt.get(treeKey(tree))).toBe(fire.burnt.get(treeKey(tree)));
    sc.dispose();
  });

  it('rain beats a fire down and puts it out', () => {
    const { sc, tree } = inTheWoods();
    const fire = sc.weather.fire;
    fire.ignite(tree, 1);
    for (let k = 0; k < 150; k++) fire.update(0.1, 0, 0.2, [0, 0]);
    expect(fire.fires[0].heat).toBeGreaterThan(0.5);
    for (let k = 0; k < 600 && fire.fires.length; k++) fire.update(0.1, 0.9, 0.05, [0, 0]);
    expect(fire.fires.length).toBe(0);
    // A tree only half burned can catch again another day; a black snag cannot.
    expect(fire.burnt.get(treeKey(tree))).toBeLessThan(0.85);
    sc.dispose();
  });
});

describe('the ground in the wet', () => {
  it('clay is hard dry and slick mud wet; asphalt loses grip in the rain', () => {
    const { sc } = open(1);
    const T = sc.terrain!;
    let spot: [number, number] | null = null;
    for (let x = 300; x < 2000 && !spot; x += 7) for (let z = -1000; z < 0 && !spot; z += 7) if (clayAt(T, x, z)) spot = [x, z];
    expect(spot).not.toBeNull();
    const w = sc.weather;
    w.wet = 0;
    w.puddle = 0;
    expect(sc.surfaceAt(...spot!).name).toBe('hardpan');
    w.wet = 0.8;
    w.puddle = 0.6;
    expect(sc.surfaceAt(...spot!).name).toBe('mud');
    const road = sc.terrain!.open!.roads.find((r) => r.kind === 'highway')!;
    const rx = road.pts[40];
    const rz = road.pts[41];
    const wetGrip = sc.surfaceAt(rx, rz).grip;
    w.wet = 0;
    w.puddle = 0;
    expect(wetGrip).toBeLessThan(sc.surfaceAt(rx, rz).grip * 0.9);
    sc.dispose();
  });

  it('heavy rain hides the convoy from a raider at the edge of his sight', () => {
    const { sc } = open(1);
    const v = sc.players[0].vehicle!;
    const get = () => acquire(sc, v.position.x + 120, v.position.z, 160);
    sc.weather.rain = 0;
    expect(get()).not.toBeNull();
    sc.weather.rain = 1;
    expect(get()).toBeNull();
    sc.dispose();
  });
});
