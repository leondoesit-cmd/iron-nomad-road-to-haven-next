import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { WILDLIFE, legById, type AnimalKind } from '../src/data';
import { Rng } from '../src/core/rng';
import { WildlifeSystem } from '../src/game/wildlife';
import { AmbientLife } from '../src/game/ambientLife';
import { AnimalRenderer } from '../src/render/animalRender';
import { LifeRenderer } from '../src/render/lifeRender';
import { animalZoneOf, BODY } from '../src/sim/anatomy';
import { ChunkSource } from '../src/world/chunkgen';
import { forestAt, lushAt } from '../src/world/hydro';
import { heightAt, waterAt } from '../src/world/terrain';
import type { Ctx } from '../src/game/ctx';

// The new life of the country: the wild animals of the water and the night, and the small life that is only for the eye.

type Water = { level: number; depth: number; kind?: string; flow?: [number, number] } | null;

interface Walker {
  index: number;
  pos: { x: number; y: number; z: number };
  state: string;
  alive: boolean;
  targetable: boolean;
  crouch: boolean;
  invuln: number;
  inVehicle: boolean;
  vehicle: null;
  moveSpeed: number;
  yaw: number;
  hurt: () => void;
  cam: { addShake: () => void };
  bites: string[];
  snakeBite: (kind: string) => void;
}

const walker = (x: number, z: number): Walker => ({
  index: 0,
  pos: { x, y: 0, z },
  state: 'foot',
  alive: true,
  targetable: true,
  crouch: false,
  invuln: 0,
  inVehicle: false,
  vehicle: null,
  moveSpeed: 0,
  yaw: 0,
  hurt: () => {},
  cam: { addShake: () => {} },
  bites: [],
  snakeBite(kind: string) {
    this.bites.push(kind);
  },
});

/** A flat world with whatever water `water` says, enough for the animals and the small life to live in. */
function world(players: Walker[], water: (x: number, z: number) => Water = () => null, opts: { night?: number; biome?: 'wasteland' | 'city' } = {}) {
  const sounds: string[] = [];
  const noop = () => {};
  const ctx = {
    rng: new Rng(11),
    time: 0,
    night: opts.night ?? 0,
    storm: 0,
    heat: 0.5,
    biome: opts.biome ?? 'wasteland',
    terrain: null,
    players,
    vehicles: [],
    campaign: { difficulty: { aggro: 1, damage: 1, drain: 1 } },
    fx: { blood: noop, fire: noop, puff: noop, spark: noop },
    audio: { play: (id: string) => sounds.push(id) },
    input: { rumble: noop },
    obs: { segmentBlocked: () => false, resolveCircle: () => null },
    sig: { loudestFor: () => null, emit: noop },
    interact: { add: noop, remove: noop },
    groundAt: () => 0,
    waterAt: water,
    visibleToAnyView: () => false,
    notify: noop,
    addLoot: noop,
  } as unknown as Ctx;
  const W = new WildlifeSystem(ctx);
  (ctx as unknown as { wildlife: WildlifeSystem }).wildlife = W;
  return { ctx, W, sounds };
}

const step = (W: WildlifeSystem, s: number) => {
  for (let i = 0; i < s * 60; i++) W.update(1 / 60);
};

/** Open water north of z = 0, a metre and a half deep. */
const lake = (x: number, z: number): Water => (z > 0 ? { level: 0, depth: 1.5, kind: 'lake' } : null);
/** A shallow margin from z = 0 to 8 m, then deep water. */
const shore = (x: number, z: number): Water => (z > 0 ? { level: 0, depth: Math.min(3, z * 0.05), kind: 'lake' } : null);

describe('the new animals', () => {
  it('every species is complete, has a body and a model', () => {
    const ar = new AnimalRenderer();
    ar.begin();
    for (const k of Object.keys(WILDLIFE.species) as AnimalKind[]) {
      expect(BODY[k], k).toBeTruthy();
      ar.push(k, 1, 0, 0, 0, 0, 0, 0.5, 0, 0, 0, 1, { fold: 1 });
    }
    ar.end();
    // Every mesh got its instance and every vertex is a number.
    let meshes = 0;
    for (const m of ar.group.children as THREE.InstancedMesh[]) {
      expect(m.count).toBeGreaterThan(0);
      for (const v of m.geometry.attributes.position.array as Float32Array) expect(Number.isFinite(v)).toBe(true);
      meshes++;
    }
    expect(meshes).toBeGreaterThan(Object.keys(WILDLIFE.species).length * 2);
    ar.dispose();
  });

  it('a wing can be shot off any bird', () => {
    for (const k of ['crow', 'heron', 'stork', 'duck'] as AnimalKind[]) expect(['wingL', 'wingR']).toContain(animalZoneOf(k, 0, 0.6, 0.7));
  });

  it('ducks sit on the water, swim from a stranger and fly off to other water when one comes close', () => {
    const p = walker(0, -60);
    const { W } = world([p], lake);
    const raft = W.spawnOnWater('duck', 0, 30);
    expect(raft.length).toBeGreaterThan(1);
    step(W, 6);
    for (const d of raft) {
      expect(lake(d.x, d.z), 'on the water').not.toBeNull();
      expect(Math.abs(d.y)).toBeLessThan(0.05);
    }
    p.pos.z = 22;
    step(W, 0.5);
    expect(raft.some((d) => d.air)).toBe(true);
    step(W, 40);
    for (const d of raft) {
      expect(d.air).toBe(false);
      expect(lake(d.x, d.z), 'came down on water').not.toBeNull();
      expect(Math.hypot(d.x - p.pos.x, d.z - p.pos.z)).toBeGreaterThan(35);
    }
  });

  it('a heron fishes the shallows without wading deep, and goes up when someone comes', () => {
    const p = walker(0, -200);
    const { W, sounds } = world([p], shore);
    const h = W.spawn('heron', 3, 4);
    let deepest = 0;
    for (let i = 0; i < 60 * 40; i++) {
      W.update(1 / 60);
      deepest = Math.max(deepest, shore(h.x, h.z)?.depth ?? 0);
    }
    expect(h.air).toBe(false);
    expect(deepest).toBeLessThanOrEqual((WILDLIFE.species.heron.wade ?? 0.45) + 0.05);
    p.pos.z = h.z - 12;
    p.pos.x = h.x;
    step(W, 0.3);
    expect(h.air).toBe(true);
    expect(sounds).toContain('flutter');
    step(W, 40);
    expect(h.air).toBe(false);
    expect(Math.hypot(h.x - p.pos.x, h.z - p.pos.z)).toBeGreaterThan(30);
  });

  it('jackals keep their distance from people but come in to a carcass', () => {
    const p = walker(0, -80);
    const { W } = world([p]);
    const deer = W.spawn('deer', 0, 40);
    W.kill(deer, -1);
    const pack = W.spawnGroup('jackal', 30, 40);
    expect(pack.length).toBeGreaterThan(1);
    let fed = false;
    for (let i = 0; i < 60 * 60 && !fed; i++) {
      W.update(1 / 60);
      fed = pack.some((j) => j.state === 'feed' && j.feedOn === deer);
    }
    expect(fed).toBe(true);
    p.pos.z = 30;
    step(W, 1);
    for (const j of pack) expect(j.state).toBe('flee');
    expect(pack.some((j) => j.chasing)).toBe(false);
  });

  it('jackals howl together after dark, and not by day', () => {
    const p = walker(0, -60);
    const day = world([p]);
    day.W.spawnGroup('jackal', 0, 60);
    step(day.W, 120);
    expect(day.sounds.filter((s) => s === 'howl').length).toBe(0);
    const night = world([walker(0, -60)], undefined, { night: 1 });
    const pack = night.W.spawnGroup('jackal', 0, 60);
    expect(pack.length).toBeGreaterThan(1);
    // The leader starts and the rest answer within a couple of seconds.
    let first = -1;
    let answered = false;
    for (let i = 0; i < 60 * 60 && !answered; i++) {
      night.W.update(1 / 60);
      const n = night.sounds.filter((s) => s === 'howl').length;
      if (n >= 1 && first < 0) first = i;
      if (n >= 2) answered = i - first < 60 * 2.5;
    }
    expect(answered).toBe(true);
  });

  it('buffalo wallow in the shallows but never go out of their depth', () => {
    const p = walker(0, -100);
    const { W } = world([p], shore);
    const herd = W.spawnGroup('buffalo', 0, 6);
    let wet = 0;
    let deepest = 0;
    for (let i = 0; i < 60 * 240; i++) {
      W.update(1 / 60);
      for (const b of herd) {
        const d = shore(b.x, b.z)?.depth ?? 0;
        deepest = Math.max(deepest, d);
        if (d > 0.3) wet++;
      }
    }
    expect(wet).toBeGreaterThan(0);
    expect(deepest).toBeLessThan((WILDLIFE.species.buffalo.wade ?? 1.3) + 0.15);
  });

  it('crows come down to walk and peck, and go up when someone walks over', () => {
    const p = walker(0, -80);
    const { W } = world([p]);
    const flock = W.spawnGroup('crow', 0, 20);
    let down: (typeof flock)[number] | undefined;
    for (let i = 0; i < 60 * 120 && !down; i++) {
      W.update(1 / 60);
      down = flock.find((c) => c.state === 'feed' && !c.feedOn && c.y < 0.05);
    }
    expect(down).toBeTruthy();
    p.pos.x = down!.x;
    p.pos.z = down!.z - 3;
    step(W, 1);
    expect(down!.state).toBe('flee');
    expect(down!.y).toBeGreaterThan(0.5);
  });

  it('the water species turn up only by water, and the night ones at night', () => {
    const ctx = { rng: new Rng(9), night: 0, players: [], terrain: null } as unknown as Ctx;
    const W = new WildlifeSystem(ctx);
    const tally = (land: { lush: number; wood: number; near: number }) => {
      const n: Record<string, number> = {};
      for (let k = 0; k < 3000; k++) {
        const kind = W.pickKind('wasteland', 'dust', 2, land);
        if (kind) n[kind] = (n[kind] ?? 0) + 1;
      }
      return n;
    };
    const dry = tally({ lush: 0.6, wood: 0, near: 0 });
    const wet = tally({ lush: 0.6, wood: 0, near: 1 });
    expect(dry.heron ?? 0).toBe(0);
    expect(dry.buffalo ?? 0).toBe(0);
    expect(wet.heron ?? 0).toBeGreaterThan(100);
    expect(wet.buffalo ?? 0).toBeGreaterThan(30);
    // Ducks come with the water itself, never with the land.
    expect(wet.duck ?? 0).toBe(0);
    const day = tally({ lush: 0.5, wood: 0.3, near: 0.3 });
    (ctx as { night: number }).night = 1;
    const night = tally({ lush: 0.5, wood: 0.3, near: 0.3 });
    expect(night.jackal ?? 0).toBeGreaterThan((day.jackal ?? 0) * 2);
    // Foxes are about by day as well in the green country.
    expect(day.fox ?? 0).toBeGreaterThan(50);
    expect(night.stork ?? 0).toBeLessThan((day.stork ?? 0) * 0.3);
  });

  it('a camel watches a car go by at a distance and only runs from one coming at it', () => {
    const p = walker(0, -300);
    const { W } = world([p]);
    const herd = W.spawnGroup('camel', 0, 0);
    // A car 30 m off, passing across (moving along x, the camels off to its side).
    const car = { position: { x: -10, z: -30 }, speed: 15, wreck: false, def: { length: 4 }, body: { forward: () => [1, 0, 0] } };
    const driver = { ...walker(-10, -30), inVehicle: true, vehicle: car } as unknown as Walker;
    const { W: W2, ctx } = world([driver]);
    void W;
    const camels = W2.spawnGroup('camel', 0, 0);
    expect(camels.length).toBeGreaterThan(1);
    step(W2, 3);
    for (const c of camels) expect(c.state).not.toBe('flee');
    // The same car close by and driving straight at them.
    car.position.x = 0;
    car.position.z = -12;
    driver.pos.x = 0;
    driver.pos.z = -12;
    car.body.forward = () => [0, 0, 1];
    (ctx as unknown as { players: unknown[] }).players = [driver];
    step(W2, 1.5);
    expect(camels.some((c) => c.state === 'flee')).toBe(true);
    void herd;
  });

  it('a fox lets you come closer than other game, sits and watches you', () => {
    const p = walker(0, -100);
    const { ctx, W } = world([p]);
    const fox = W.spawn('fox', 0, 0);
    // Game has to notice someone (see sim/hunting.ts): this one is on the move, and the clock runs.
    p.pos.z = -16;
    p.moveSpeed = 1;
    let watched = false;
    for (let i = 0; i < 60 * 8; i++) {
      (ctx as unknown as { time: number }).time += 1 / 60;
      W.update(1 / 60);
      if (fox.state === 'alert' && fox.rear > 0.2) watched = true;
    }
    expect(watched).toBe(true);
    expect(fox.state).not.toBe('flee');
    p.pos.z = fox.z - 5;
    step(W, 1);
    expect(fox.state).toBe('flee');
  });

  it('grazers walk down to the water to drink, the herd together, and face it', () => {
    const p = walker(0, -120);
    const { W } = world([p], shore);
    const herd = W.spawnGroup('deer', 0, -20);
    for (const d of herd) d.drinkT = 0;
    let drank = 0;
    for (let i = 0; i < 60 * 70; i++) {
      W.update(1 / 60);
      drank = Math.max(drank, herd.filter((d) => d.state === 'drink').length);
    }
    expect(drank).toBeGreaterThan(1);
    // Drinking at the edge: never out in the deep.
    for (const d of herd) expect(shore(d.x, d.z)?.depth ?? 0).toBeLessThan(0.6);
  });

  it('little egrets wade the shallows and never go deep', () => {
    const p = walker(0, -100);
    const { W } = world([p], shore);
    const group = W.spawnGroup('egret', 0, 3);
    expect(group.length).toBeGreaterThan(0);
    let deepest = 0;
    for (let i = 0; i < 60 * 40; i++) {
      W.update(1 / 60);
      for (const e of group) if (!e.air) deepest = Math.max(deepest, shore(e.x, e.z)?.depth ?? 0);
    }
    expect(deepest).toBeLessThanOrEqual((WILDLIFE.species.egret.wade ?? 0.3) + 0.05);
  });

  it('the ambient spawner puts rafts of ducks on open water', () => {
    const p = walker(0, 0);
    const { W } = world([p], (x, z) => ({ level: 2, depth: 2, kind: 'lake' }));
    for (let i = 0; i < 60 * 60; i++) W.ambient(1 / 60, 'wasteland', 'dust', 2);
    expect(W.list.length).toBeGreaterThan(3);
    for (const a of W.list) {
      expect(a.kind).toBe('duck');
      expect(a.y).toBeCloseTo(2, 3);
    }
  });
});

// ------------------------------------------------------------------ the small life

/** A scene's worth of context for the small life, on the flat world (or the real open world when `def` is given). */
function lifeWorld(players: Walker[], water: (x: number, z: number) => Water = () => null, opts: { night?: number; biome?: 'wasteland' | 'city' } = {}) {
  const w = world(players, water, opts);
  const life = new AmbientLife(w.ctx);
  (w.ctx as unknown as { life: AmbientLife }).life = life;
  return { ...w, life };
}

/** Render-time life and the fixed tick (the snakes) together, as a scene runs them. */
const run = (life: AmbientLife, s: number) => {
  for (let i = 0; i < s * 30; i++) {
    life.update(1 / 30);
    life.tick(1 / 30);
  }
};

describe('the small life', () => {
  it('schools fish in living water, under the surface, and none in a flood', () => {
    const p = walker(0, 0);
    const { life } = lifeWorld([p], (x, z) => (Math.hypot(x, z) > 2 ? { level: 1, depth: 1.6, kind: 'lake' } : null));
    run(life, 20);
    const fish = life.list.filter((c) => c.kind === 'fish');
    expect(fish.length).toBeGreaterThan(5);
    for (const f of fish) {
      expect(f.y).toBeLessThan(1 - 0.1);
      expect(f.y).toBeGreaterThan(1 - 1.6);
    }
    const flood = lifeWorld([walker(0, 0)], () => ({ level: 1, depth: 1.6, kind: 'flood' }));
    run(flood.life, 20);
    expect(flood.life.list.filter((c) => c.kind === 'fish' || c.kind === 'leap').length).toBe(0);
  });

  it('a school scatters from someone wading into it', () => {
    const p = walker(0, -15);
    const { life } = lifeWorld([p], lake);
    life.enabled = false;
    life.spawnAt('fish', 0, 10);
    const school = life.list.filter((c) => c.kind === 'fish');
    expect(school.length).toBeGreaterThan(2);
    run(life, 2);
    p.pos.z = 8;
    run(life, 0.2);
    expect(school.some((f) => f.state === 2)).toBe(true);
    run(life, 3);
    const mid = school.reduce((s, f) => s + f.z, 0) / school.length;
    expect(Math.abs(mid - 8)).toBeGreaterThan(2);
  });

  it('a frog on the bank goes into the water with a ring when you walk up to it', () => {
    const p = walker(0, -15);
    const { life } = lifeWorld([p], (x, z) => (z > 0 ? { level: 0, depth: 0.6, kind: 'stream' } : null));
    life.enabled = false;
    // A frog only sits within a jump of the water, so not every try puts one there.
    for (let k = 0; k < 20 && !life.count('frog'); k++) life.spawnAt('frog', 0, -0.8);
    const frogs = life.list.filter((c) => c.kind === 'frog');
    expect(frogs.length).toBeGreaterThan(0);
    run(life, 1);
    expect(frogs.every((f) => f.state === 0)).toBe(true);
    p.pos.z = -2.5;
    let rings = 0;
    for (let i = 0; i < 60; i++) {
      life.update(1 / 30);
      rings = Math.max(rings, life.rings.length);
    }
    expect(life.list.filter((c) => c.kind === 'frog').length).toBe(0);
    expect(rings).toBeGreaterThan(0);
  });

  it('a flock of small birds goes up together when someone comes near, and comes down again further off', () => {
    const p = walker(0, -20);
    const { life, sounds } = lifeWorld([p]);
    life.enabled = false;
    life.spawnAt('songbird', 0, 30);
    const flock = life.list.filter((c) => c.kind === 'songbird');
    expect(flock.length).toBeGreaterThan(2);
    run(life, 2);
    expect(flock.every((b) => b.state === 0)).toBe(true);
    p.pos.z = 26;
    run(life, 0.2);
    expect(flock.every((b) => b.state === 2)).toBe(true);
    expect(sounds).toContain('flutter');
    run(life, 10);
    for (const b of flock) {
      expect(b.state).toBe(0);
      expect(Math.hypot(b.x - p.pos.x, b.z - p.pos.z)).toBeGreaterThan(12);
    }
  });

  it('the city has pigeons, not meadow birds', () => {
    const { life } = lifeWorld([walker(0, 0)], undefined, { biome: 'city' });
    run(life, 30);
    expect(life.count('pigeon')).toBeGreaterThan(4);
    expect(life.count('songbird')).toBe(0);
    expect(life.count('butterfly')).toBe(0);
  });

  it('grasshoppers spring out ahead of someone walking, and land', () => {
    const p = walker(0, 0);
    p.moveSpeed = 1.5;
    const { life } = lifeWorld([p]);
    let jumped = false;
    for (let i = 0; i < 30 * 10; i++) {
      life.update(1 / 30);
      if (life.list.some((c) => c.kind === 'hopper' && c.state === 1 && c.y > 0.05)) jumped = true;
    }
    expect(jumped).toBe(true);
    for (const c of life.list) if (c.kind === 'hopper' && c.state === 0) expect(c.y).toBeCloseTo(0, 3);
  });

  it('flies find a carcass', () => {
    const p = walker(0, 0);
    const { W, life } = lifeWorld([p]);
    const deer = W.spawn('deer', 5, 5);
    W.kill(deer, -1);
    for (let i = 0; i < 60 * 5; i++) W.update(1 / 60);
    run(life, 1);
    expect(life.list.some((c) => c.kind === 'flies' && c.ref === deer.id)).toBe(true);
  });

  it('draws everything it has', () => {
    const p = walker(0, -12);
    const { life } = lifeWorld([p], (x, z) => (z > 0 ? { level: 0, depth: 1.2, kind: 'stream' } : null));
    life.enabled = false;
    for (const k of ['butterfly', 'dragonfly', 'bees', 'midges', 'songbird', 'swallow', 'bat', 'lizard'] as const) life.spawnAt(k, 3, -8);
    life.spawnAt('fish', 0, 8);
    for (let k = 0; k < 20 && !life.count('frog'); k++) life.spawnAt('frog', 0, -0.8);
    for (let k = 0; k < 20 && !life.count('turtle'); k++) life.spawnAt('turtle', 2, -0.8);
    life.spawnAt('fireflies', 0, -5);
    life.ripple(0, 0, 5, 1);
    run(life, 0.5);
    const lr = new LifeRenderer();
    life.render(lr);
    const counts = new Map<string, number>();
    for (const m of lr.group.children) if ((m as THREE.InstancedMesh).isInstancedMesh) counts.set((m as THREE.InstancedMesh).geometry.uuid, (m as THREE.InstancedMesh).count);
    // Wings, a dragonfly and its wings, birds and their wings, a fish, a frog, a turtle, a lizard, and the rings.
    expect([...counts.values()].filter((n) => n > 0).length).toBeGreaterThanOrEqual(10);
    expect(lr.dots.n).toBeGreaterThan(10);
    lr.dispose();
  });
});

describe('under the water', () => {
  /** A stream north of z = 0, 40 cm deep over a flat bed at y = 0 (the surface at 0.4). */
  const stream = (x: number, z: number): Water => (z > 0 ? { level: 0.4, depth: 0.4, kind: 'stream' } : null);
  /** A still swamp pool, 30 cm deep. */
  const pool = (x: number, z: number): Water => (Math.hypot(x, z - 10) < 8 ? { level: 0.3, depth: 0.3, kind: 'swamp' } : null);

  it('crabs walk the stream bed sideways, and scuttle off and hide when you come', () => {
    const p = walker(0, -12);
    const { life } = lifeWorld([p], stream);
    life.enabled = false;
    for (let k = 0; k < 20 && !life.count('crab'); k++) life.spawnAt('crab', 0, 2);
    const crabs = life.list.filter((c) => c.kind === 'crab');
    expect(crabs.length).toBeGreaterThan(0);
    const c = crabs[0];
    let fwd = 0;
    let side = 0;
    for (let i = 0; i < 30 * 12; i++) {
      const x0 = c.x;
      const z0 = c.z;
      life.update(1 / 30);
      expect(c.y).toBeCloseTo(0, 5);
      fwd += Math.abs((c.x - x0) * Math.sin(c.yaw) + (c.z - z0) * Math.cos(c.yaw));
      side += Math.abs((c.x - x0) * Math.cos(c.yaw) - (c.z - z0) * Math.sin(c.yaw));
    }
    expect(side).toBeGreaterThan(0.2);
    expect(fwd).toBeLessThan(side * 0.1);
    p.pos.x = c.x;
    p.pos.z = c.z - 2;
    run(life, 2.5);
    expect(life.list.includes(c)).toBe(false);
  });

  it('tadpoles wriggle about the bed of a still pool', () => {
    const { life } = lifeWorld([walker(0, -4)], pool);
    life.enabled = false;
    life.spawnAt('tadpole', 0, 10);
    const tads = life.list.filter((c) => c.kind === 'tadpole');
    expect(tads.length).toBeGreaterThan(5);
    run(life, 6);
    for (const t of tads) {
      expect(t.y).toBeGreaterThan(0 - 0.01);
      expect(t.y).toBeLessThan(0.3 - 0.01);
      expect(pool(t.x, t.z)).not.toBeNull();
    }
  });

  it('water striders skate on the surface and leave rings where they stop', () => {
    const { life } = lifeWorld([walker(0, -4)], pool);
    life.enabled = false;
    for (let k = 0; k < 10 && !life.count('skater'); k++) life.spawnAt('skater', 0, 10);
    const sk = life.list.filter((c) => c.kind === 'skater');
    expect(sk.length).toBeGreaterThan(1);
    let rings = 0;
    for (let i = 0; i < 30 * 6; i++) {
      life.update(1 / 30);
      rings = Math.max(rings, life.rings.length);
    }
    for (const s of sk) {
      expect(s.y).toBeCloseTo(0.304, 3);
      expect(pool(s.x, s.z)).not.toBeNull();
    }
    expect(rings).toBeGreaterThan(0);
  });

  it('bottom fish keep to the bed; the rest swim up in the water', () => {
    const { life } = lifeWorld([walker(0, -10)], (x, z) => (z > 0 ? { level: 2, depth: 2, kind: 'lake' } : null));
    life.enabled = false;
    for (let k = 0; k < 30; k++) life.spawnAt('fish', 0, 10);
    run(life, 4);
    const fish = life.list.filter((c) => c.kind === 'fish');
    const bottom = fish.filter((f) => f.ref === 1);
    const mid = fish.filter((f) => f.ref !== 1);
    expect(bottom.length).toBeGreaterThan(0);
    expect(mid.length).toBeGreaterThan(0);
    for (const f of bottom) expect(f.y).toBeLessThan(0.25);
    for (const f of mid) expect(f.y).toBeGreaterThan(0.9);
  });
});

describe('the banks, the trees and the dry country', () => {
  const stream = (x: number, z: number): Water => (z > 0 ? { level: 0, depth: Math.min(1.2, 0.1 + z * 0.1), kind: 'stream' } : null);
  const lakeW = (x: number, z: number): Water => (z > 0 ? { level: 0, depth: 1.5, kind: 'lake' } : null);

  it('birds sit up in the trees and go to another tree when you come near', () => {
    const p = walker(0, -10);
    const { life, ctx } = lifeWorld([p]);
    const oak = { x: 0, y: 0, z: 20, yaw: 0, s: 1, sp: 0, v: 0, lean: [0, 0] as [number, number] };
    const far = { ...oak, x: 40, z: 55 };
    (ctx as unknown as { treesNear: (x: number, z: number, r: number) => (typeof oak)[] }).treesNear = (x, z, r) => [oak, far].filter((t) => Math.hypot(t.x - x, t.z - z) < r);
    life.enabled = false;
    life.spawnAt('perched', 0, 20);
    const birds = life.list.filter((c) => c.kind === 'perched');
    expect(birds.length).toBeGreaterThan(0);
    for (const b of birds) expect(b.y).toBeGreaterThan(6);
    run(life, 2);
    expect(birds.every((b) => b.state === 0)).toBe(true);
    p.pos.z = 10;
    run(life, 0.3);
    expect(birds.every((b) => b.state === 2)).toBe(true);
    run(life, 12);
    for (const b of birds) {
      expect(b.state).toBe(0);
      // On the outside of the far oak's crown (4.4 m across at this size).
      expect(Math.hypot(b.x - far.x, b.z - far.z)).toBeLessThan(4.4 * 1.05 + 0.1);
      expect(b.y).toBeGreaterThan(6);
    }
  });

  it('a pied kingfisher hovers over the water and dives in', () => {
    const { life } = lifeWorld([walker(0, -30)], lakeW);
    life.enabled = false;
    life.spawnAt('kingfisher', 0, 10);
    const k = life.list.find((c) => c.kind === 'kingfisher')!;
    let dove = false;
    let rings = 0;
    for (let i = 0; i < 30 * 30; i++) {
      life.update(1 / 30);
      if (k.state === 2 && k.y < 0.5) dove = true;
      rings = Math.max(rings, life.rings.length);
    }
    expect(dove).toBe(true);
    expect(rings).toBeGreaterThan(0);
  });

  it('wagtails and birds come down to drink keep to the water\'s edge', () => {
    const { life } = lifeWorld([walker(0, -25)], stream);
    life.enabled = false;
    for (let k = 0; k < 10 && !life.count('wagtail'); k++) life.spawnAt('wagtail', 0, -0.8);
    for (let k = 0; k < 10 && !life.list.some((c) => c.kind === 'songbird' && c.ref === 3); k++) life.spawnAt('songbird', 0, -0.8);
    const edge = life.list.filter((c) => c.kind === 'wagtail' || c.kind === 'songbird');
    expect(edge.some((c) => c.kind === 'wagtail')).toBe(true);
    expect(edge.some((c) => c.ref === 3)).toBe(true);
    run(life, 15);
    for (const c of edge) {
      expect(stream(c.x, c.z)).toBeNull();
      expect(c.z).toBeGreaterThan(-1.8);
    }
  });

  it('damselflies settle on the reeds just over the water', () => {
    const { life } = lifeWorld([walker(0, -10)], stream);
    life.enabled = false;
    life.spawnAt('damselfly', 0, 1);
    const ds = life.list.filter((c) => c.kind === 'damselfly');
    expect(ds.length).toBeGreaterThan(1);
    let settled = 0;
    for (let i = 0; i < 30 * 10; i++) {
      life.update(1 / 30);
      for (const d of ds) {
        expect(d.y - d.level).toBeGreaterThan(0.2);
        expect(d.y - d.level).toBeLessThan(1.1);
      }
      settled = Math.max(settled, ds.filter((d) => d.state === 0).length);
    }
    expect(settled).toBeGreaterThan(0);
  });

  /** One snake of a kind lying at (x, z) facing +z, resting. */
  const snake = (life: AmbientLife, ref: number, x: number, z: number) => {
    life.spawnAt('snake', x, z);
    const s = life.list[life.list.length - 1];
    s.ref = ref;
    s.x = x;
    s.z = z;
    s.yaw = 0;
    s.size = ref === 2 ? 1.6 : 0.9;
    s.state = 0;
    s.timer = 99;
    return s;
  };

  it('a viper coils and hisses at someone coming close, and strikes if they stay within reach', () => {
    const p = walker(0, -10);
    const { life, sounds } = lifeWorld([p]);
    life.enabled = false;
    const v = snake(life, 1, 0, 0);
    p.pos.z = 2.5;
    p.moveSpeed = 1.2;
    run(life, 0.2);
    expect(v.state).toBe(4);
    expect(sounds).toContain('hiss');
    expect(p.bites.length).toBe(0);
    // Stays just in front of its head.
    p.pos.z = 1.0;
    run(life, 1);
    expect(p.bites).toContain('palestine');
    // It goes on striking while you stand there.
    run(life, 3);
    expect(p.bites.length).toBeGreaterThan(1);
  });

  it('a viper does not bite someone who gives it room, and slides away', () => {
    const p = walker(0, -10);
    const { life } = lifeWorld([p]);
    life.enabled = false;
    const v = snake(life, 1, 0, 0);
    p.pos.z = 2.4;
    run(life, 0.5);
    expect(v.state).toBe(4);
    p.pos.z = 8;
    run(life, 8);
    expect(p.bites.length).toBe(0);
    expect(life.list.includes(v)).toBe(false);
  });

  it('a horned viper in the sand bites whoever steps on it', () => {
    const p = walker(0, -10);
    const { life } = lifeWorld([p]);
    life.enabled = false;
    const v = snake(life, 0, 0, 0);
    p.pos.z = 0.3;
    p.moveSpeed = 2;
    run(life, 0.1);
    expect(p.bites).toEqual(['horned']);
    void v;
  });

  it('a whip snake is off into cover, and only bites when cornered', () => {
    const p = walker(0, -10);
    const { life } = lifeWorld([p]);
    life.enabled = false;
    const w = snake(life, 2, 0, 0);
    p.pos.z = -3.5;
    run(life, 0.2);
    expect(w.state).toBe(2);
    run(life, 4);
    expect(life.list.includes(w)).toBe(false);
    expect(p.bites.length).toBe(0);
    const w2 = snake(life, 2, 0, 0);
    p.pos.x = 0.4;
    p.pos.z = 0.75;
    p.moveSpeed = 1;
    run(life, 0.2);
    expect(p.bites).toContain('whip');
    void w2;
  });

  it('a shot, a blow or a wheel kills a snake', () => {
    const p = walker(0, -10);
    const { life, ctx } = lifeWorld([p]);
    life.enabled = false;
    const a = snake(life, 1, 0, 0);
    // A round fired down at it from head height a few metres off.
    const ox = 0;
    const oy = 1.5;
    const oz = -3;
    const L = Math.hypot(3, 1.5);
    life.shootThrough(ox, oy, oz, 0, -1.5 / L, 3 / L, L - 0.05);
    expect(a.state).toBe(6);
    const b = snake(life, 2, 10, 0);
    expect(life.meleeHit(10, 0.3, 1.2)).toBe(1);
    expect(b.state).toBe(6);
    const c = snake(life, 0, 20, 0);
    (ctx as unknown as { vehicles: unknown[] }).vehicles = [{ position: { x: 20, z: 0.5 }, speed: 8, wreck: false, def: { length: 4 } }];
    run(life, 0.05);
    expect(c.state).toBe(6);
  });

  it('a desert monitor walks slowly about; a spiny-tailed lizard runs for its burrow', () => {
    const p = walker(0, -20);
    const { life } = lifeWorld([p]);
    life.enabled = false;
    life.spawnAt('lizard', 0, 0);
    life.spawnAt('lizard', 8, 0);
    const [mon, spiny] = life.list.filter((c) => c.kind === 'lizard');
    mon.ref = 3;
    mon.size = 1;
    spiny.ref = 2;
    const x0 = mon.x;
    const z0 = mon.z;
    run(life, 6);
    expect(Math.hypot(mon.x - x0, mon.z - z0)).toBeGreaterThan(0.5);
    expect(mon.state).toBe(0);
    p.pos.x = 8;
    p.pos.z = -2;
    run(life, 3);
    expect(life.list.includes(spiny)).toBe(false);
  });
});

describe('the small life in the open world', () => {
  const leg = legById('W');
  const def = new ChunkSource(leg).layout.terrain;

  /** The real ground and water of the open world around a walker. */
  function openWorld(x: number, z: number, night: number) {
    const p = walker(x, z);
    const w = world([p], (px, pz) => waterAt(def, px, pz), { night });
    (w.ctx as unknown as { terrain: typeof def }).terrain = def;
    (w.ctx as unknown as { groundAt: (x: number, z: number) => number }).groundAt = (px, pz) => heightAt(def, px, pz);
    const life = new AmbientLife(w.ctx);
    return { p, life };
  }

  /** A meadow: lush, out of the woods, dry. */
  function meadow(): [number, number] {
    for (let r = 0; r < 3000; r += 16) {
      for (let a = 0; a < 6.28; a += 0.3) {
        const x = -1700 + Math.cos(a) * r;
        const z = 1300 + Math.sin(a) * r;
        if (lushAt(def, x, z) > 0.75 && forestAt(def, x, z) < 0.05 && !waterAt(def, x, z)) return [x, z];
      }
    }
    throw new Error('no meadow');
  }

  it('butterflies and bees on the meadow by day, fireflies there at night', () => {
    const [x, z] = meadow();
    const day = openWorld(x, z, 0);
    run(day.life, 25);
    expect(day.life.count('butterfly')).toBeGreaterThan(2);
    expect(day.life.count('fireflies')).toBe(0);
    const night = openWorld(x, z, 1);
    run(night.life, 25);
    expect(night.life.count('fireflies')).toBeGreaterThan(5);
    expect(night.life.count('butterfly')).toBe(0);
  });

  it('fish in a river, dragonflies over it', () => {
    const hy = def.hydro!;
    const r = hy.rivers.find((q) => q.kind === 'river')!;
    const i = Math.floor(r.n * 0.4);
    // On the bank, looking at the water.
    const { life } = openWorld(r.x[i] - r.dz[i] * (r.half[i] + 4), r.z[i] + r.dx[i] * (r.half[i] + 4), 0);
    run(life, 30);
    expect(life.count('fish')).toBeGreaterThan(2);
    expect(life.count('dragonfly')).toBeGreaterThan(0);
    for (const c of life.list) if (c.kind === 'fish') expect(waterAt(def, c.x, c.z)).not.toBeNull();
  });
});
