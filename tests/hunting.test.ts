import { describe, expect, it } from 'vitest';
import { WILDLIFE } from '../src/data';
import { WildlifeSystem } from '../src/game/wildlife';
import { Rng } from '../src/core/rng';
import { AMMO } from '../src/sim/ballistics';
import { BED, carcassYield, HIDES, notice, scentReach, sightReach, STALK, stepAwareness, torsoPart, type CarcassState } from '../src/sim/hunting';
import type { Ctx } from '../src/game/ctx';

// The breeze with no storm blows toward +x, -z (see `windAt`): 0.8, -0.6 of 1.6 m/s.
const DOWN = { x: 0.8, z: -0.6 };

interface Stalker {
  index: number;
  pos: { x: number; y: number; z: number };
  state: string;
  alive: boolean;
  targetable: boolean;
  crouch: boolean;
  moveSpeed: number;
  invuln: number;
  inVehicle: boolean;
  vehicle: null;
  hurt: () => void;
  cam: { addShake: () => void };
}

const stalker = (x: number, z: number, o: Partial<Stalker> = {}): Stalker => ({
  index: 0,
  pos: { x, y: 0, z },
  state: 'foot',
  alive: true,
  targetable: true,
  crouch: false,
  moveSpeed: 0,
  invuln: 0,
  inVehicle: false,
  vehicle: null,
  hurt: () => {},
  cam: { addShake: () => {} },
  ...o,
});

/** Open, flat ground; `blocked` puts a wall between everything. Carcasses wait for the knife. */
function world(players: Stalker[], o: { blocked?: boolean; rain?: number } = {}) {
  const loot: Record<string, number>[] = [];
  const notes: { seat: number; text: string }[] = [];
  const carcasses: { id: string; run: (p: unknown) => void; prompt: string; enabled: (p: unknown) => boolean }[] = [];
  const noop = () => {};
  const ctx = {
    rng: new Rng(3),
    time: 0,
    night: 0,
    storm: 0,
    rain: o.rain ?? 0,
    terrain: null,
    players,
    vehicles: [],
    campaign: { difficulty: { aggro: 1, damage: 1, drain: 1 }, items: { hides: 0, bandage: 0 } },
    fx: { blood: noop, fire: noop, puff: noop, spark: noop },
    audio: { play: noop },
    input: { rumble: noop },
    obs: { segmentBlocked: () => !!o.blocked, resolveCircle: () => null },
    sig: { loudestFor: () => null, emit: noop },
    gore: { drip: noop, severAnimal: noop },
    interact: { add: (i: (typeof carcasses)[number]) => (carcasses.push(i), i), remove: noop },
    groundAt: () => 0,
    waterAt: () => null,
    visibleToAnyView: () => false,
    notify: (seat: number, text: string) => notes.push({ seat, text }),
    addLoot: (g: Record<string, number>) => loot.push(g),
  } as unknown as Ctx;
  const W = new WildlifeSystem(ctx);
  const step = (s: number) => {
    for (let i = 0; i < s * 60; i++) {
      (ctx as unknown as { time: number }).time += 1 / 60;
      W.update(1 / 60);
    }
  };
  return { ctx, W, step, loot, notes, carcasses, items: (ctx as unknown as { campaign: { items: { hides: number } } }).campaign.items };
}

/** A round along +z at (x, y, z) on a deer standing at (0, 30) facing +z. */
const round = (dmg: number, y: number, z: number) => ({ dmg, dx: 0, dy: 0, dz: 1, x: 0, y, z, spec: AMMO.rifle, speed: AMMO.rifle.speed, fromX: 0, fromZ: -40, killer: 0 });
const VITALS = (dmg: number) => round(dmg, 0.9, 30.2);
const GUT = (dmg: number) => round(dmg, 0.9, 29.7);

describe('stalking rules', () => {
  it('movement is what an animal sees: frozen < walking < running, and a crouch cuts it', () => {
    const base = { sight: 40, crouch: false, grazing: false, staring: false };
    const still = sightReach({ ...base, speed: 0 });
    const walk = sightReach({ ...base, speed: 1.4 });
    const run = sightReach({ ...base, speed: 6 });
    expect(still).toBeLessThan(walk);
    expect(walk).toBeLessThan(run);
    expect(sightReach({ ...base, speed: 1.4, crouch: true })).toBeLessThan(walk * 0.6);
    // Head down in the grass it sees less; head up and staring, more.
    expect(sightReach({ ...base, speed: 1.4, grazing: true })).toBeLessThan(walk);
    expect(sightReach({ ...base, speed: 1.4, staring: true })).toBeGreaterThan(walk);
  });
  it('scent carries downwind in a cone, not upwind or across, and rain washes it out', () => {
    // An animal straight downwind of the person, 15 m off: offset from it to the person is back up the wind.
    const dx = -DOWN.x * 15;
    const dz = -DOWN.z * 15;
    expect(scentReach(dx, dz, 1.28, -0.96)).toBeGreaterThan(15);
    expect(scentReach(-dx, -dz, 1.28, -0.96)).toBe(0);
    expect(scentReach(-dz, dx, 1.28, -0.96)).toBe(0);
    expect(scentReach(dx, dz, 1.28, -0.96, 1)).toBeLessThan(scentReach(dx, dz, 1.28, -0.96) * 0.5);
    // A storm wind carries it much further.
    expect(scentReach(dx, dz, 18, -7)).toBeGreaterThan(50);
  });
  it('a whiff spooks it in well under a second; a hidden, silent, upwind stalker builds nothing', () => {
    const sense = { sight: 45, speed: 0, crouch: true, cover: 1, dark: 0, nightEyes: false, grazing: true, staring: false, windX: 1.28, windZ: -0.96, noise: 2, rain: 0 };
    const down = notice({ ...sense, dx: -DOWN.x * 15, dz: -DOWN.z * 15 });
    expect(down.smelled).toBe(true);
    expect(down.rate).toBeGreaterThan(2);
    const up = notice({ ...sense, dx: DOWN.x * 15, dz: DOWN.z * 15 });
    expect(up.rate).toBe(0);
    expect(stepAwareness(0.5, 0, 1)).toBeCloseTo(0.5 - STALK.decay);
  });
});

describe('shot placement', () => {
  it('splits the trunk into heart-lungs behind the shoulder, the gut behind, and the rest', () => {
    expect(torsoPart('deer', 0.2, 0.69)).toBe('vitals');
    expect(torsoPart('deer', -0.3, 0.69)).toBe('gut');
    expect(torsoPart('deer', 0.2, 0.95)).toBe('body');
  });
  it('a lung shot bleeds it out fast and tells the shooter; a gut shot is a long track', () => {
    const { W, step, notes } = world([stalker(0, -40)]);
    const lung = W.spawn('deer', 0, 30);
    lung.yaw = 0;
    const r = W.bulletHit(lung, VITALS(20));
    expect(r.killed).toBe(false);
    expect(notes.some((n) => n.seat === 0 && /Lung/.test(n.text))).toBe(true);
    const gut = W.spawn('deer', 0, 30, 77);
    gut.yaw = 0;
    W.bulletHit(gut, GUT(20));
    expect(lung.wounds.bleed).toBeGreaterThan(gut.wounds.bleed * 5);
    expect(gut.tainted).toBe(true);
    step(6);
    expect(lung.dead).toBe(true);
    expect(gut.dead).toBe(false);
  });
  it('a heart-lung shot that drops it is a clean kill', () => {
    const { W } = world([stalker(0, -40)]);
    const deer = W.spawn('deer', 0, 30);
    deer.yaw = 0;
    expect(W.bulletHit(deer, VITALS(40)).killed).toBe(true);
    expect(deer.clean).toBe(true);
  });
});

describe('noticing a stalker', () => {
  it('a crouched, still stalker upwind is not noticed at 28 m; one walking upright is', () => {
    const p = stalker(0, 10, { crouch: true });
    const { W, step } = world([p]);
    // The deer is upwind of the person: the breeze carries their scent away from it. (It grazes a few metres about.)
    const deer = W.spawn('deer', -DOWN.x * 28, 10 - DOWN.z * 28);
    step(8);
    expect(deer.state === 'idle' || deer.state === 'wander').toBe(true);
    expect(deer.aware).toBeLessThan(STALK.alert);
    p.crouch = false;
    p.moveSpeed = 1.4;
    step(6);
    expect(deer.state).toBe('flee');
  });
  it('behind cover, a walker is not seen at 30 m, but downwind the deer smells even a hidden one', () => {
    const p = stalker(0, 0, { moveSpeed: 1.4 });
    const { W, step } = world([p], { blocked: true });
    const seen = W.spawn('deer', -DOWN.x * 30, -DOWN.z * 30);
    step(6);
    expect(seen.state).not.toBe('flee');
    const smelt = W.spawn('deer', DOWN.x * 18, DOWN.z * 18, 55);
    p.moveSpeed = 0;
    p.crouch = true;
    // It has the scent within a few thinks, long before anything else could give the stalker away.
    let smelled = false;
    for (let i = 0; i < 30 && !smelled; i++) {
      step(1 / 60);
      smelled = smelt.smelled;
    }
    expect(smelled).toBe(true);
    step(0.5);
    expect(smelt.state).toBe('flee');
  });
  it('freeze when it stares, and it goes back to grazing', () => {
    const p = stalker(0, 0, { moveSpeed: 1.4 });
    const { W, step } = world([p]);
    // Upwind, beyond its flight distance.
    const deer = W.spawn('deer', -DOWN.x * 38, -DOWN.z * 38);
    for (let i = 0; i < 80 && deer.state !== 'alert'; i++) step(0.1);
    expect(deer.state).toBe('alert');
    p.moveSpeed = 0;
    p.crouch = true;
    const states = new Set<string>();
    for (let i = 0; i < 60 * 12; i++) {
      step(1 / 60);
      states.add(deer.state);
    }
    expect(states.has('flee')).toBe(false);
    expect(deer.state === 'idle' || deer.state === 'wander').toBe(true);
  });
  it('rain hides footsteps and scent', () => {
    const dry = notice({ dx: -DOWN.x * 14, dz: -DOWN.z * 14, sight: 10, speed: 1.4, crouch: false, cover: 1, dark: 0, nightEyes: false, grazing: true, staring: false, windX: 1.28, windZ: -0.96, noise: 8, rain: 0 });
    const wet = notice({ dx: -DOWN.x * 14, dz: -DOWN.z * 14, sight: 10, speed: 1.4, crouch: false, cover: 1, dark: 0, nightEyes: false, grazing: true, staring: false, windX: 1.28, windZ: -0.96, noise: 8, rain: 1 });
    expect(dry.smelled && dry.heard).toBe(true);
    expect(wet.smelled || wet.heard).toBe(false);
  });
  it('a quiet kill does not send the herd off: they stare toward the shooter', () => {
    const p = stalker(0, 0, { crouch: true });
    const { W, step } = world([p]);
    const herd = W.spawnGroup('deer', -DOWN.x * 60, -DOWN.z * 60);
    expect(herd.length).toBeGreaterThan(2);
    step(0.5);
    W.kill(herd[0], 0);
    step(0.2);
    const rest = herd.slice(1);
    expect(rest.some((d) => d.state === 'alert')).toBe(true);
    expect(rest.some((d) => d.state === 'flee')).toBe(false);
  });
  it('the HUD sees how aware the game near you is', () => {
    const p = stalker(0, 0, { moveSpeed: 1.4 });
    const { W, step } = world([p]);
    expect(W.stalkView(p as never)).toBeNull();
    W.spawn('deer', -DOWN.x * 40, -DOWN.z * 40);
    step(1 / 60);
    expect(W.stalkView(p as never)).not.toBeNull();
    step(4);
    expect(W.stalkView(p as never)!.aware).toBeGreaterThan(0);
  });
});

describe('tracking a wounded animal', () => {
  it('a badly hit deer that has run out of sight beds down, and gets up again when you walk in on it', () => {
    const p = stalker(0, -40);
    const { W, step } = world([p]);
    const deer = W.spawn('deer', 0, 30);
    deer.yaw = 0;
    W.bulletHit(deer, GUT(30));
    expect(deer.state).toBe('flee');
    let bedded = false;
    for (let i = 0; i < 60 * 20 && !bedded; i++) {
      step(1 / 60);
      bedded = deer.state === 'bed';
    }
    expect(bedded).toBe(true);
    expect(deer.dead).toBe(false);
    expect(Math.hypot(deer.x - p.pos.x, deer.z - p.pos.z)).toBeGreaterThan(BED.clear);
    // Bedded, it bleeds slower.
    const hp = deer.hp;
    step(1);
    expect(hp - deer.hp).toBeLessThan(deer.wounds.bleed * 0.6);
    // Walk straight in on it, upright.
    p.pos.x = deer.x;
    p.pos.z = deer.z - 12;
    p.moveSpeed = 1.4;
    step(1.5);
    expect(deer.state).toBe('flee');
  });
});

describe('the carcass', () => {
  const base: CarcassState = { meat: 4, legsGone: 0, tainted: false, hits: 1, cause: 'shot', clean: false, eaten: 0 };
  it('a clean kill gives more meat; a gut shot, a blast, a bumper or scavengers less', () => {
    const plain = carcassYield(base, 'deer').rations;
    expect(plain).toBe(4);
    expect(carcassYield({ ...base, clean: true }, 'deer').rations).toBeGreaterThan(plain);
    expect(carcassYield({ ...base, tainted: true }, 'deer').rations).toBeLessThan(plain);
    expect(carcassYield({ ...base, cause: 'blast' }, 'deer').rations).toBeLessThan(plain);
    expect(carcassYield({ ...base, cause: 'vehicle' }, 'deer').rations).toBeLessThan(plain);
    expect(carcassYield({ ...base, eaten: 12 }, 'deer').rations).toBeLessThan(plain);
    // Small game is a ration whatever happened to it, until scavengers have most of it.
    expect(carcassYield({ ...base, meat: 1, cause: 'vehicle' }, 'hare').rations).toBe(1);
    expect(carcassYield({ ...base, meat: 1, eaten: 20 }, 'hare').rations).toBe(0);
  });
  it('hides come off game with a coat worth having, unless it was blown up, burned or riddled', () => {
    expect(carcassYield(base, 'deer').hides).toBe(HIDES.deer);
    expect(carcassYield({ ...base, meat: 10 }, 'bear').hides).toBe(3);
    expect(carcassYield({ ...base, meat: 1 }, 'hare').hides).toBe(0);
    expect(carcassYield({ ...base, cause: 'blast' }, 'deer').hides).toBe(0);
    expect(carcassYield({ ...base, cause: 'fire' }, 'deer').hides).toBe(0);
    expect(carcassYield({ ...base, meat: 10, hits: 6 }, 'bear').hides).toBe(2);
  });
  it('butchering pays rations to the stores and hides to the convoy, and says what was lost', () => {
    const { W, loot, carcasses, items, notes } = world([stalker(0, -40)]);
    const deer = W.spawn('deer', 0, 30);
    deer.yaw = 0;
    W.bulletHit(deer, GUT(20));
    W.bulletHit(deer, VITALS(60));
    expect(deer.dead).toBe(true);
    expect(carcasses.length).toBe(1);
    expect(carcasses[0].prompt).toMatch(/1 hide/);
    carcasses[0].run(stalker(0, 29));
    expect(loot).toEqual([{ rations: Math.max(2, Math.round(WILDLIFE.species.deer.meat * 0.65)) }]);
    expect(items.hides).toBe(1);
    expect(notes.some((n) => /gut-shot/.test(n.text))).toBe(true);
  });
});
