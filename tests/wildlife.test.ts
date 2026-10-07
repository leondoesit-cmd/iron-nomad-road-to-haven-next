import { describe, expect, it } from 'vitest';
import { WILDLIFE, type AnimalKind } from '../src/data';
import { WildlifeSystem } from '../src/game/wildlife';
import { Rng } from '../src/core/rng';
import type { Ctx } from '../src/game/ctx';

interface FakePlayer {
  index: number;
  pos: { x: number; y: number; z: number };
  state: string;
  alive: boolean;
  targetable: boolean;
  crouch: boolean;
  invuln: number;
  inVehicle: boolean;
  vehicle: null;
  hurt: (n: number, x: number, z: number, kind: string) => void;
  cam: { addShake: (n: number) => void };
  hits: number[];
}

function player(x: number, z: number): FakePlayer {
  const hits: number[] = [];
  return {
    index: 0,
    pos: { x, y: 0, z },
    state: 'foot',
    alive: true,
    targetable: true,
    crouch: false,
    invuln: 0,
    inVehicle: false,
    vehicle: null,
    hurt: (n) => hits.push(n),
    cam: { addShake: () => {} },
    hits,
  };
}

/** Just enough of a scene for the animals to think, move and be shot in. */
function world(players: FakePlayer[], noise: { x: number; z: number; level: number } | null = null) {
  const loot: Record<string, number>[] = [];
  const noop = () => {};
  const ctx = {
    rng: new Rng(5),
    time: 0,
    night: 0,
    players,
    vehicles: [],
    campaign: { difficulty: { aggro: 1, damage: 1, drain: 1 } },
    fx: { blood: noop, fire: noop, puff: noop, spark: noop },
    audio: { play: noop },
    input: { rumble: noop },
    obs: { segmentBlocked: () => false, resolveCircle: () => null },
    sig: { loudestFor: () => noise },
    groundAt: () => 0,
    waterAt: () => null,
    visibleToAnyView: () => false,
    notify: noop,
    addLoot: (g: Record<string, number>) => loot.push(g),
  } as unknown as Ctx;
  return { ctx, W: new WildlifeSystem(ctx), loot };
}

const step = (W: WildlifeSystem, s: number) => {
  for (let i = 0; i < s * 60; i++) W.update(1 / 60);
};

describe('wildlife data', () => {
  it('describes every species completely', () => {
    for (const [k, d] of Object.entries(WILDLIFE.species)) {
      expect(d.hp, k).toBeGreaterThan(0);
      expect(d.run, k).toBeGreaterThan(d.walk);
      expect(d.group[0], k).toBeGreaterThanOrEqual(1);
      expect(d.group[1], k).toBeGreaterThanOrEqual(d.group[0]);
      expect(d.cap, k).toBeGreaterThanOrEqual(d.group[1] >= 4 ? 4 : 1);
      expect(d.biomes.length, k).toBeGreaterThan(0);
      expect(d.themes.length, k).toBeGreaterThan(0);
      if (d.temper === 'pack' || d.temper === 'charger' || d.temper === 'brute') expect(d.damage, k).toBeGreaterThan(0);
    }
  });
  it('keeps a pack from killing a person in a couple of seconds', () => {
    const dog = WILDLIFE.species.dog;
    const bites = dog.group[1] * (dog.damage ?? 0);
    expect(bites).toBeLessThan(30);
  });
});

describe('prey', () => {
  it('bolts away from a person who walks up on it', () => {
    const p = Object.assign(player(0, 0), { moveSpeed: 1.4 });
    const { W } = world([p]);
    const deer = W.spawn('deer', 0, 25);
    step(W, 3);
    expect(deer.state).toBe('flee');
    expect(Math.hypot(deer.x - p.pos.x, deer.z - p.pos.z)).toBeGreaterThan(30);
  });
  it('the whole herd bolts when one is startled', () => {
    const p = player(0, 0);
    const { W } = world([p]);
    const herd = W.spawnGroup('deer', 0, 60);
    expect(herd.length).toBeGreaterThan(2);
    W.damage(herd[0], 1, { fromX: 0, fromZ: 0, killer: 0 });
    for (const d of herd) expect(d.state).toBe('flee');
  });
  it('grazing prey that hear gunfire run', () => {
    const p = player(0, 0);
    const { W } = world([p], { x: 5, z: 5, level: 80 });
    const hare = W.spawn('hare', 0, 90);
    step(W, 1);
    expect(hare.state).toBe('flee');
  });
});

describe('shots and meat', () => {
  it('a ray hits an animal at its height and misses over its back', () => {
    const { W } = world([player(0, 0)]);
    const boar = W.spawn('boar', 0, 20);
    expect(W.rayTest(0, 0.5, 0, 0, 0, 1, 50)?.animal).toBe(boar);
    expect(W.rayTest(0, 2.5, 0, 0, 0, 1, 50)).toBeNull();
  });
  it('killing a meat animal pays rations once, killing a vulture pays one ration', () => {
    const { W, loot } = world([player(0, 0)]);
    const deer = W.spawn('deer', 0, 20);
    expect(W.damage(deer, 500, { fromX: 0, fromZ: 0, killer: 0 })).toBe(true);
    // Meat is food and nothing else: no Scrap comes off a carcass.
    expect(loot).toEqual([{ rations: WILDLIFE.species.deer.meat }]);
    W.damage(deer, 500, { fromX: 0, fromZ: 0, killer: 0 });
    expect(loot.length).toBe(1);
    const dog = W.spawn('dog', 0, 20);
    W.damage(dog, 500, { fromX: 0, fromZ: 0, killer: 0 });
    expect(loot[1]).toEqual({ rations: 1 });
  });
  it('with an interact registry the kill leaves a carcass that pays when butchered', () => {
    const { ctx, W, loot } = world([player(0, 0)]);
    const adds: any[] = [];
    (ctx as any).interact = { add: (i: any) => adds.push(i), remove: () => {} };
    const boar = W.spawn('boar', 0, 20);
    W.damage(boar, 500, { fromX: 0, fromZ: 0, killer: 0 });
    expect(loot.length).toBe(0);
    expect(adds.length).toBe(1);
    adds[0].run(player(0, 19));
    expect(loot).toEqual([{ rations: WILDLIFE.species.boar.meat }]);
    adds[0].run(player(0, 19));
    expect(loot.length).toBe(1);
  });
  it('carcasses lie about for a while and are then cleared', () => {
    const { W } = world([player(0, 0)]);
    const a = W.spawn('hare', 0, 20);
    W.kill(a, 0);
    step(W, 5);
    expect(W.list.length).toBe(1);
    step(W, WILDLIFE.rules.corpseSeconds);
    expect(W.list.length).toBe(0);
  });
});

describe('hunters', () => {
  it('a pack spots someone on foot, closes in and bites', () => {
    const p = player(0, 0);
    const { W } = world([p]);
    const pack = W.spawnGroup('dog', 0, 28);
    step(W, 8);
    expect(pack.every((d) => d.chasing)).toBe(true);
    expect(p.hits.length).toBeGreaterThan(0);
    for (const h of p.hits) expect(h).toBe(WILDLIFE.species.dog.damage);
  });
  it('a bear ignores a distant person but turns on one who gets close', () => {
    const p = player(0, 0);
    const { W } = world([p]);
    const far = W.spawn('bear', 0, 40);
    step(W, 3);
    expect(far.chasing).toBe(false);
    const near = W.spawn('bear', 0, 9, 11);
    step(W, 1);
    expect(near.chasing).toBe(true);
  });
  it('a boar winds up, then charges in a line and is left winded', () => {
    const p = player(0, 0);
    const { W } = world([p]);
    const boar = W.spawn('boar', 0, 12);
    const seen = new Set<string>();
    for (let i = 0; i < 60 * 8; i++) {
      W.update(1 / 60);
      seen.add(boar.state);
    }
    expect(seen.has('windup')).toBe(true);
    expect(seen.has('charge')).toBe(true);
    expect(seen.has('rest')).toBe(true);
    expect(p.hits.length).toBeGreaterThan(0);
  });
  it('a badly hurt dog breaks off and runs', () => {
    const p = player(0, 0);
    const { W } = world([p]);
    const dog = W.spawn('dog', 0, 15);
    step(W, 1);
    expect(dog.chasing).toBe(true);
    dog.hp = 5;
    step(W, 0.5);
    expect(dog.state).toBe('flee');
  });
});

describe('ambient population', () => {
  it('fills in out of sight and never beyond the caps', () => {
    const p = player(0, 0);
    const { ctx, W } = world([p]);
    const seen: { x: number; z: number }[] = [];
    (ctx as unknown as { visibleToAnyView: (x: number, y: number, z: number) => boolean }).visibleToAnyView = (x, _y, z) => {
      seen.push({ x, z });
      return false;
    };
    for (let i = 0; i < 60 * 120; i++) W.ambient(1 / 60, 'wasteland', 'cinder', 3);
    expect(W.aliveCount).toBeGreaterThan(5);
    expect(W.aliveCount).toBeLessThanOrEqual(WILDLIFE.rules.maxAlive + 6);
    const by = new Map<AnimalKind, number>();
    for (const a of W.list) by.set(a.kind, (by.get(a.kind) ?? 0) + 1);
    for (const [k, n] of by) expect(n, k).toBeLessThanOrEqual(WILDLIFE.species[k].cap + 6);
    // Nothing appears closer than the spawn ring.
    for (const a of W.list) expect(Math.hypot(a.x, a.z) >= WILDLIFE.rules.spawnMin - 8 || a.flying).toBe(true);
  });
  it('keeps hostile packs and bears off the first leg and cities', () => {
    const { W } = world([player(0, 0)]);
    for (let i = 0; i < 60 * 200; i++) W.ambient(1 / 60, 'wasteland', 'dust', 1);
    expect(W.list.some((a) => a.kind === 'bear' || a.kind === 'wolf')).toBe(false);
    const city = world([player(0, 0)]);
    for (let i = 0; i < 60 * 200; i++) city.W.ambient(1 / 60, 'city', 'dust', 3);
    for (const a of city.W.list) expect(['dog', 'vulture', 'crow']).toContain(a.kind);
  });
});
