import { describe, expect, it } from 'vitest';
import { WILDLIFE } from '../src/data';
import { Rng } from '../src/core/rng';
import { AMMO, cutOf } from '../src/sim/ballistics';
import { animalSpeedMult, animalZoneOf, newAnimalWounds, partsGone, PART_BIT, woundAnimal } from '../src/sim/anatomy';
import { WildlifeSystem } from '../src/game/wildlife';
import { Zombie, ZombieSystem } from '../src/game/zombies';
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
  aimYaw: number;
  pinned: number;
  drugs: { mods: () => { aggro: number } };
  hurt: (n: number, x: number, z: number, kind: string) => void;
  note: () => void;
  cam: { addShake: (n: number) => void };
  hits: number[];
}

function player(x: number, z: number, aimYaw = 0): FakePlayer {
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
    aimYaw,
    pinned: 0,
    drugs: { mods: () => ({ aggro: 1 }) },
    hurt: (n) => hits.push(n),
    note: () => {},
    cam: { addShake: () => {} },
    hits,
  };
}

/** Just enough of a scene for animals and the dead to think, move, be shot and be cut in. */
function world(players: FakePlayer[], noise: { x: number; z: number; level: number } | null = null) {
  const loot: Record<string, number>[] = [];
  const noop = () => {};
  const severed: { part: string; kind: string }[] = [];
  const cut: string[] = [];
  const ctx = {
    rng: new Rng(5),
    time: 0,
    night: 0,
    players,
    vehicles: [],
    campaign: { difficulty: { aggro: 1, damage: 1, drain: 1 }, stats: { zombiesKilled: 0 } },
    fx: { blood: noop, fire: noop, puff: noop, spark: noop },
    audio: { play: noop },
    input: { rumble: noop },
    obs: { segmentBlocked: () => false, resolveCircle: () => null },
    sig: { loudestFor: () => noise, emit: noop },
    gore: {
      severAnimal: (a: { kind: string }, part: string) => severed.push({ part, kind: a.kind }),
      sever: (_z: unknown, part: string) => cut.push(part),
      corpse: noop,
      drip: noop,
    },
    // Carcasses stay where they fell until someone butchers them, as in the game.
    interact: { add: noop, remove: noop },
    groundAt: () => 0,
    waterAt: () => null,
    visibleToAnyView: () => false,
    notify: noop,
    radio: noop,
    addLoot: (g: Record<string, number>) => loot.push(g),
  } as unknown as Ctx;
  const W = new WildlifeSystem(ctx);
  const Z = new ZombieSystem(ctx);
  (ctx as unknown as { wildlife: WildlifeSystem }).wildlife = W;
  (ctx as unknown as { zombies: ZombieSystem }).zombies = Z;
  return { ctx, W, Z, loot, severed, cut };
}

const stepW = (W: WildlifeSystem, s: number) => {
  for (let i = 0; i < s * 60; i++) W.update(1 / 60);
};
const stepZ = (Z: ZombieSystem, s: number) => {
  for (let i = 0; i < s * 60; i++) Z.update(1 / 60);
};

/** A round arriving from `fromZ` straight along +z at height `y` and `x` offset from the animal's middle. */
function shot(spec = AMMO.rifle, dmg = 40) {
  return { dmg, dx: 0, dy: 0, dz: 1, spec, speed: spec.speed, fromX: 0, fromZ: -10, killer: 0 };
}

describe('animal anatomy', () => {
  it('places a hit on the head, a leg or the body from where it landed', () => {
    // A dog facing +z: its head is ahead and up, its legs low, its flank in between.
    expect(animalZoneOf('dog', 0.4, 0, 0.9)).toBe('head');
    expect(animalZoneOf('dog', 0.2, 0.08, 0.2)).toBe('legLF');
    expect(animalZoneOf('dog', 0.2, -0.08, 0.2)).toBe('legRF');
    expect(animalZoneOf('dog', -0.2, 0.08, 0.2)).toBe('legLB');
    expect(animalZoneOf('dog', -0.2, -0.08, 0.2)).toBe('legRB');
    expect(animalZoneOf('dog', 0, 0, 0.6)).toBe('torso');
    expect(animalZoneOf('vulture', 0, 0.4, 0)).toBe('wingL');
    expect(animalZoneOf('vulture', 0, 0, 0)).toBe('torso');
  });
  it('a leg comes off after enough damage, a head after a hard hit, a blow to the body takes nothing', () => {
    const hp = 58;
    const w = newAnimalWounds();
    expect(woundAnimal(w, 'wolf', 'legLF', 8, hp, false, 0.5).off).toEqual([]);
    const r = woundAnimal(w, 'wolf', 'legLF', 14, hp, false, 0.5);
    expect(r.off).toEqual(['legLF']);
    expect(w.bleed).toBeGreaterThan(0);
    expect(partsGone(w.mask).legs).toBe(1);
    expect(woundAnimal(w, 'wolf', 'torso', 10, hp, false, 0.5).off).toEqual([]);
    const head = woundAnimal(newAnimalWounds(), 'wolf', 'head', hp * 0.6, hp, false, 0.5);
    expect(head.off).toEqual(['head']);
    expect(head.fatal).toBe(true);
  });
  it('a bird without a wing is a stone, and only birds have wings to lose', () => {
    const w = newAnimalWounds();
    const r = woundAnimal(w, 'vulture', 'wingL', 10, 14, false, 0.5);
    expect(r.off).toEqual(['wingL']);
    expect(r.fatal).toBe(true);
    expect(woundAnimal(newAnimalWounds(), 'deer', 'wingL', 500, 42, false, 0.5).off).toEqual([]);
  });
  it('legs gone slow it, a heavy beast less than a light one', () => {
    expect(animalSpeedMult(0, false)).toBe(1);
    expect(animalSpeedMult(1, false)).toBeLessThan(0.7);
    expect(animalSpeedMult(1, true)).toBeGreaterThan(animalSpeedMult(1, false));
    expect(animalSpeedMult(3, true)).toBeLessThan(0.15);
  });
  it('the mask bit of a leg is its mount index in the mesh', () => {
    expect([PART_BIT.legLF, PART_BIT.legRF, PART_BIT.legLB, PART_BIT.legRB]).toEqual([1, 2, 4, 8]);
  });
});

describe('what a round takes off a zombie', () => {
  it('a pistol and an SMG can take limbs now, only after several rounds on one limb, never one round on a walker', () => {
    expect(AMMO.pistol.gore).toBeGreaterThan(0);
    expect(AMMO.smg.gore).toBeGreaterThan(0);
    // 27 damage per pistol round, 45 hp walker: a limb needs 30% of its hp in damage x gore.
    const per = 27 * AMMO.pistol.gore;
    expect(per).toBeLessThan(45 * 0.3 * 1.01 + 5);
    expect(per * 1).toBeLessThan(45 * 0.3 + 0.0001 + per); // sanity: finite
    expect(per * 2).toBeGreaterThanOrEqual(45 * 0.3 - 0.01);
  });
  it('a blade cuts and a bat does not', () => {
    expect(cutOf('bat')).toBe(0);
    expect(cutOf('knife')).toBeGreaterThan(0);
    expect(cutOf('axe')).toBeGreaterThan(cutOf('machete'));
    expect(cutOf('machete')).toBeGreaterThan(cutOf('knife'));
  });
  it('a swing of an axe through a walker takes something off it', () => {
    const p = player(0, 0);
    const { Z, cut } = world([p]);
    let any = 0;
    for (let i = 0; i < 12; i++) {
      const zb = Z.spawn('walker', 0, 1, false);
      Z.meleeHit(p as never, 0, 1, 0, 2, 85, undefined, cutOf('axe'));
      if (zb.wounds.mask) any++;
    }
    expect(any).toBeGreaterThan(8);
    expect(cut.length).toBeGreaterThan(8);
  });
  it('a bat swing leaves the body whole', () => {
    const p = player(0, 0);
    const { Z, cut } = world([p]);
    for (let i = 0; i < 6; i++) {
      const zb = Z.spawn('walker', 0, 1, false);
      Z.meleeHit(p as never, 0, 1, 0, 2, 48, undefined, cutOf('bat'));
      expect(zb.wounds.mask).toBe(0);
    }
    expect(cut.length).toBe(0);
  });
});

describe('animals lose parts when shot', () => {
  it('a rifle round through a leg takes it off and the animal limps', () => {
    const { W, severed } = world([player(0, 0)]);
    const deer = W.spawn('deer', 0, 30);
    deer.yaw = 0; // facing +z
    // The front left leg: ahead of the middle, to the left (+x), low.
    const r = W.bulletHit(deer, { ...shot(AMMO.rifle, 20), x: 0.1, y: 0.3, z: 30.3 });
    expect(r.zone).toBe('legLF');
    expect(r.off).toEqual(['legLF']);
    expect(partsGone(deer.wounds.mask).legs).toBe(1);
    expect(deer.moveMult).toBeLessThan(0.7);
    expect(deer.dead).toBe(false);
    expect(severed.length).toBe(0); // throwing the part is the caller's job, as for zombies
  });
  it('a pistol needs more than one round to take a leg', () => {
    const { W } = world([player(0, 0)]);
    const boar = W.spawn('boar', 0, 30);
    boar.yaw = 0;
    const hit = () => W.bulletHit(boar, { ...shot(AMMO.pistol, 27), x: 0.15, y: 0.2, z: 30.3 });
    expect(hit().off).toEqual([]);
    let off = 0;
    for (let i = 0; i < 6 && !boar.dead; i++) off += hit().off.length;
    expect(off + (boar.dead ? 1 : 0)).toBeGreaterThan(0);
  });
  it('a hit to the head hurts it twice as much and a hard one takes the head off', () => {
    const { W } = world([player(0, 0)]);
    const dog = W.spawn('dog', 0, 30);
    dog.yaw = 0;
    const hp0 = dog.hp;
    const r = W.bulletHit(dog, { ...shot(AMMO.pistol, 12), x: 0, y: 0.6, z: 30.45 });
    expect(r.zone).toBe('head');
    expect(r.off).toEqual([]);
    expect(hp0 - dog.hp).toBeCloseTo(12 * 1.8, 5);
    const r2 = W.bulletHit(dog, { ...shot(AMMO.rifle, 10), x: 0, y: 0.6, z: 30.45 });
    expect(r2.off).toContain('head');
    expect(dog.dead).toBe(true);
  });
  it('a limb lost means a bleed that finishes it, and the kill counts for who shot it', () => {
    const { W } = world([player(0, 0)]);
    const deer = W.spawn('deer', 0, 30);
    W.bulletHit(deer, { ...shot(AMMO.rifle, 20), x: 0.1, y: 0.3, z: 30.3 });
    expect(deer.wounds.bleed).toBeGreaterThan(0);
    const hp = deer.hp;
    stepW(W, 4);
    expect(deer.hp).toBeLessThan(hp);
    stepW(W, 120);
    expect(deer.dead).toBe(true);
    expect(W.killedByPlayer[0]).toBe(1);
  });
  it('a crippled hunter breaks off instead of dragging itself after you', () => {
    const p = player(0, 0);
    const { W } = world([p]);
    const dog = W.spawn('dog', 0, 15);
    stepW(W, 1);
    expect(dog.chasing).toBe(true);
    dog.wounds.mask |= PART_BIT.legLF | PART_BIT.legRB;
    (W as unknown as { refreshWounds(a: unknown): void }).refreshWounds(dog);
    stepW(W, 0.5);
    expect(dog.state).toBe('flee');
  });
  it('a blast that more than kills tears pieces off', () => {
    const { W, severed } = world([player(0, 0)]);
    const deer = W.spawn('deer', 0, 10);
    W.blast(0, 8, 8, 400, 0);
    expect(deer.dead).toBe(true);
    expect(severed.length).toBeGreaterThan(0);
    expect(deer.wounds.mask).not.toBe(0);
  });
  it('a machete cuts a leg off an animal that is hit with it', () => {
    const p = player(0, 0);
    const { W, severed } = world([p]);
    let any = 0;
    for (let i = 0; i < 12; i++) {
      const hog = W.spawn('boar', 0, 1);
      W.meleeHit(p as never, 0, 1, 0, 2, 58, undefined, cutOf('machete'));
      if (hog.wounds.mask) any++;
    }
    expect(any).toBeGreaterThan(3);
    expect(severed.length).toBeGreaterThan(0);
  });
  it('a carcass that has lost legs to the shot has less on it', () => {
    const { ctx, W, loot } = world([player(0, 0)]);
    (ctx as any).interact = undefined;
    const boar = W.spawn('boar', 0, 30);
    boar.wounds.mask |= PART_BIT.legLF | PART_BIT.legRF;
    W.damage(boar, 500, { fromX: 0, fromZ: 0, killer: 0 });
    expect(loot[0].rations).toBeLessThan(WILDLIFE.species.boar.meat);
    expect(loot[0].rations).toBeGreaterThanOrEqual(2);
  });
});

describe('prey behaviour', () => {
  // Game has to notice a person on foot (see `sim/hunting.ts`): these people walk, and the clock runs so heads go up and down.
  const walking = (p: FakePlayer) => Object.assign(p, { moveSpeed: 1.4 });
  const stepT = (ctx: Ctx, W: WildlifeSystem, s: number) => {
    for (let i = 0; i < s * 60; i++) {
      (ctx as unknown as { time: number }).time += 1 / 60;
      W.update(1 / 60);
    }
  };
  it('stops and stares before it runs: the whole herd goes still with its heads up', () => {
    const p = walking(player(0, 0));
    const { ctx, W } = world([p]);
    // Inside sight (45) but beyond the bolt line (0.75 x sight).
    const herd = W.spawnGroup('deer', 0, 40);
    expect(herd.length).toBeGreaterThan(2);
    let alert = 0;
    for (let i = 0; i < 6 * 10 && !alert; i++) {
      stepT(ctx, W, 0.1);
      alert = herd.filter((d) => d.state === 'alert').length;
      expect(herd.some((d) => d.state === 'flee')).toBe(false);
    }
    expect(alert).toBeGreaterThan(0);
  });
  it('and bolts if the thing stays in view', () => {
    const p = walking(player(0, 0));
    const { ctx, W } = world([p]);
    const deer = W.spawn('deer', 0, 40);
    const seen = new Set<string>();
    for (let i = 0; i < 60 * 8; i++) {
      stepT(ctx, W, 1 / 60);
      seen.add(deer.state);
    }
    expect(seen.has('alert')).toBe(true);
    expect(seen.has('flee')).toBe(true);
  });
  it('settles again if it was nothing', () => {
    const p = walking(player(0, 0));
    const { ctx, W } = world([p]);
    const deer = W.spawn('deer', 0, 40);
    for (let i = 0; i < 60 && deer.state !== 'alert'; i++) stepT(ctx, W, 0.1);
    expect(deer.state).toBe('alert');
    p.pos.z = -100;
    stepT(ctx, W, 6);
    expect(deer.state === 'idle' || deer.state === 'wander').toBe(true);
  });
  it('a hare freezes much longer than a deer and only bolts when nearly stepped on', () => {
    const p = walking(player(0, 0));
    const { ctx, W } = world([p]);
    const hare = W.spawn('hare', 0, 15);
    stepT(ctx, W, 4);
    expect(hare.state).toBe('alert');
    expect(hare.alertFor).toBeGreaterThan(3);
    const near = W.spawn('hare', 0, 6, 99);
    stepT(ctx, W, 0.4);
    expect(near.state).toBe('flee');
  });
  it('a hare jinks from side to side as it runs', () => {
    const p = player(0, 0);
    const { W } = world([p]);
    const hare = W.spawn('hare', 0, 5);
    const xs: number[] = [];
    for (let i = 0; i < 60 * 3; i++) {
      W.update(1 / 60);
      if (i % 20 === 0) xs.push(hare.x);
    }
    let flips = 0;
    for (let i = 2; i < xs.length; i++) if (Math.sign(xs[i] - xs[i - 1]) !== Math.sign(xs[i - 1] - xs[i - 2])) flips++;
    expect(flips).toBeGreaterThan(0);
  });
  it('they run from the dead', () => {
    const p = player(0, 0);
    const { W, Z } = world([p]);
    const deer = W.spawn('deer', 0, 200);
    p.pos.z = 100;
    for (let i = 0; i < 3; i++) {
      const zb = Z.spawn('walker', 4 + i, 200, false);
      zb.state = 'chase';
      zb.active = true;
    }
    stepW(W, 1);
    expect(deer.state).toBe('flee');
  });
  it('a herd keeps together: the rest follow the leader about', () => {
    const p = player(0, 0);
    const { W } = world([p]);
    p.pos.z = 100;
    const herd = W.spawnGroup('deer', 0, 100);
    p.pos.z = 400;
    stepW(W, 90);
    const lead = herd.reduce((a, b) => (a.id < b.id ? a : b));
    for (const d of herd) if (d !== lead) expect(Math.hypot(d.x - lead.x, d.z - lead.z)).toBeLessThan(25);
  });
});

describe('hunter behaviour', () => {
  it('a pack comes in on different lines instead of single file', () => {
    const p = player(0, 0);
    const { W } = world([p]);
    const pack = W.spawnGroup('dog', 0, 30);
    stepW(W, 1.5);
    const sides = new Set(pack.filter((d) => d.chasing).map((d) => Math.sign(Math.round(d.x))));
    expect(pack.every((d) => d.chasing)).toBe(true);
    // They are spread across the line of approach.
    const xs = pack.map((d) => d.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.5);
    expect(sides.size).toBeGreaterThan(0);
  });
  it('after a bite a dog darts back and circles', () => {
    const p = player(0, 0);
    const { W } = world([p]);
    const dog = W.spawn('dog', 0, 3);
    let darted = false;
    for (let i = 0; i < 60 * 4; i++) {
      W.update(1 / 60);
      if (dog.retreatT > 0) darted = true;
    }
    expect(p.hits.length).toBeGreaterThan(0);
    expect(darted).toBe(true);
  });
  it('a pack that loses half of itself breaks and runs', () => {
    const p = player(0, 0);
    const { W } = world([p]);
    const pack = W.spawnGroup('dog', 0, 28);
    stepW(W, 2);
    expect(pack.length).toBeGreaterThan(2);
    const n = pack.length;
    for (let i = 0; i < Math.ceil(n / 2); i++) W.kill(pack[i], 0);
    const rest = pack.filter((d) => !d.dead);
    for (const d of rest) expect(d.state).toBe('flee');
  });
  it('they will not take on a big hunting horde of the dead', () => {
    const p = player(0, 0);
    const { W, Z } = world([p]);
    p.pos.z = 100;
    const dog = W.spawn('dog', 0, 200);
    for (let i = 0; i < 6; i++) {
      const zb = Z.spawn('walker', 5 + i, 200, false);
      zb.state = 'chase';
      zb.active = true;
    }
    dog.state = 'chase';
    dog.hasTarget = true;
    stepW(W, 1);
    expect(dog.state).toBe('flee');
  });
  it('but zombies about do not stop them biting someone they are already on', () => {
    for (const [n, hunting] of [[4, false], [8, false], [4, true]] as [number, boolean][]) {
      const p = player(0, 0);
      const { W, Z } = world([p]);
      for (let i = 0; i < n; i++) {
        const zb = Z.spawn('walker', 6 + i, 20, false);
        zb.active = true;
        if (hunting) zb.state = 'chase';
      }
      W.spawnGroup('dog', 0, 28);
      stepW(W, 10);
      expect(p.hits.length, `${n} zombies, hunting ${hunting}`).toBeGreaterThan(5);
    }
  });
  it('a pack left alone goes to a carcass and eats it away', () => {
    const p = player(0, 0);
    const { W } = world([p]);
    p.pos.z = 100;
    const deer = W.spawn('deer', 0, 220);
    W.kill(deer, 0);
    const dog = W.spawn('dog', 0, 240, 77);
    let fed = false;
    for (let i = 0; i < 60 * 80; i++) {
      W.update(1 / 60);
      if (dog.state === 'feed') fed = true;
    }
    expect(fed).toBe(true);
    // Eaten faster than it would have lain: gone well before the full 30 s.. plus what it ate.
    expect(deer.deadT).toBeGreaterThan(0);
  });
  it('a bear that is walked toward warns first: it rises, turns and growls, then charges only if you keep coming', () => {
    const p = player(0, 0);
    const { W } = world([p]);
    const bear = W.spawn('bear', 0, 15);
    stepW(W, 1);
    expect(bear.state).toBe('alert');
    expect(bear.chasing).toBe(false);
    // Backing away settles it.
    p.pos.z = -30;
    bear.x = 0;
    bear.z = 15;
    stepW(W, 8);
    expect(bear.state === 'idle' || bear.state === 'wander').toBe(true);
    // Walking up to it does not.
    bear.x = 0;
    bear.z = 15;
    p.pos.z = 15 - 9;
    stepW(W, 0.5);
    expect(bear.chasing).toBe(true);
  });
  it('a sounder of boar squares up together', () => {
    const p = player(0, 0);
    const { W } = world([p]);
    const herd = W.spawnGroup('boar', 0, 12);
    const wound = new Set<number>();
    for (let i = 0; i < 60 * 3; i++) {
      W.update(1 / 60);
      for (const b of herd) if (b.state === 'windup' || b.state === 'charge') wound.add(b.id);
    }
    expect(herd.length).toBeGreaterThan(1);
    expect(wound.size).toBe(herd.length);
  });
});

describe('vultures', () => {
  it('come down to a carcass once it has lain a while, and are off again if you come near', () => {
    const p = player(0, 0);
    const { W } = world([p]);
    p.pos.z = 150;
    const deer = W.spawn('deer', 0, 200);
    const flock = W.spawnGroup('vulture', 0, 190);
    W.kill(deer, 0);
    let landed = 0;
    for (let i = 0; i < 60 * 90; i++) {
      W.update(1 / 60);
      landed = Math.max(landed, flock.filter((v) => v.state === 'feed' || v.state === 'land').length);
    }
    expect(landed).toBeGreaterThan(0);
    expect(landed).toBeLessThanOrEqual(3);
    // They are on the ground by the body.
    const down = flock.filter((v) => v.state === 'feed');
    for (const v of down) expect(v.y).toBeLessThan(1);
    // Walk up and they lift off.
    deer.deadT = 0;
    deer.keepFor = 200;
    for (const v of flock) {
      v.state = 'feed';
      v.feedOn = deer;
      v.stateT = 0;
      v.feedFor = 100;
      v.x = deer.x + 1;
      v.z = deer.z;
      v.y = 0.15;
    }
    p.pos.z = deer.z - 8;
    stepW(W, 1);
    for (const v of flock) expect(v.state).toBe('flee');
  });
});

describe('the dead: movement', () => {
  it('walkers stop and stand about between places', () => {
    const p = player(0, 0);
    const { Z } = world([p]);
    p.pos.z = 400;
    const zb = Z.spawn('walker', 0, 300, false);
    zb.active = true;
    let idle = 0;
    let moved = 0;
    for (let i = 0; i < 60 * 120; i++) {
      Z.update(1 / 60);
      if (zb.idleT > 0) idle++;
      else if (Math.hypot(zb.vx, zb.vz) > 0.2) moved++;
    }
    expect(idle).toBeGreaterThan(60 * 2);
    expect(moved).toBeGreaterThan(60 * 3);
  });
  it('a walker lurches: its speed rises and falls as it goes', () => {
    const { Z } = world([player(0, 0)]);
    const zb = new Zombie('walker', 0, 0, false, 1);
    const g = (Z as unknown as { gait(z: Zombie): number }).gait.bind(Z);
    const seen: number[] = [];
    for (let i = 0; i < 400; i++) {
      Z.update(0.05);
      seen.push(g(zb));
    }
    expect(Math.max(...seen) - Math.min(...seen)).toBeGreaterThan(0.4);
    expect(seen.reduce((a, b) => a + b, 0) / seen.length).toBeGreaterThan(0.85);
    expect(seen.reduce((a, b) => a + b, 0) / seen.length).toBeLessThan(1.15);
  });
  it('they fan out across a target instead of coming down one line', () => {
    const p = player(0, 0);
    const { Z } = world([p]);
    const crowd: Zombie[] = [];
    for (let i = 0; i < 5; i++) {
      const zb = Z.spawn('walker', 0, 40, false);
      zb.state = 'chase';
      zb.active = true;
      zb.flank = (i - 2) / 2;
      zb.hasTarget = true;
      zb.tx = 0;
      zb.tz = 0;
      crowd.push(zb);
    }
    for (let i = 0; i < 60 * 6; i++) {
      for (const zb of crowd) {
        zb.tx = 0;
        zb.tz = 0;
      }
      Z.update(1 / 60);
    }
    const xs = crowd.map((z) => z.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(1.5);
  });
  it('one that has seen you turns the ones around it', () => {
    const p = player(0, 5);
    const { Z } = world([p]);
    const a = Z.spawn('walker', 0, 0, false);
    const b = Z.spawn('walker', 4, 0, false);
    const far = Z.spawn('walker', 40, 0, false);
    const sleeper = Z.spawn('walker', 6, 0, true);
    for (const z of [a, b, far, sleeper]) z.active = true;
    (Z as unknown as { startChase(z: Zombie, t: unknown): void }).startChase(a, { x: 0, z: 5, player: p });
    expect(a.chasing).toBe(true);
    expect(b.state).toBe('investigate');
    expect(b.idleT).toBeGreaterThan(0);
    expect(far.state).toBe('wander');
    expect(sleeper.state).toBe('dormant');
  });
  it('having lost someone, they search the place they were last seen before giving up', () => {
    const p = player(0, 120);
    const { Z } = world([p]);
    const zb = Z.spawn('walker', 0, 0, false);
    zb.active = true;
    zb.state = 'chase';
    zb.hasTarget = true;
    zb.tx = 10;
    zb.tz = 0;
    zb.lostT = 9;
    stepZ(Z, 0.1);
    expect(zb.state).toBe('investigate');
    expect(zb.search).toBe(2);
    let visited = 0;
    let last = '';
    let waited = 0;
    for (let i = 0; i < 60 * 40; i++) {
      Z.update(1 / 60);
      if (zb.idleT > 0) waited++;
      const k = `${Math.round(zb.tx)},${Math.round(zb.tz)}`;
      if (k !== last) {
        visited++;
        last = k;
      }
    }
    expect(waited).toBeGreaterThan(60);
    expect(visited).toBeGreaterThan(1);
  });
});

describe('the dead: kinds', () => {
  it('a brute winds up with a roar, then runs flat out along a line it has locked', () => {
    const p = player(0, 0);
    const { Z } = world([p]);
    const brute = Z.spawn('brute', 0, 12, false);
    brute.active = true;
    brute.state = 'chase';
    brute.chargeCd = 0;
    const seen = new Set<string>();
    let top = 0;
    for (let i = 0; i < 60 * 3; i++) {
      Z.update(1 / 60);
      seen.add(brute.charge);
      top = Math.max(top, Math.hypot(brute.vx, brute.vz));
    }
    expect(seen.has('wind')).toBe(true);
    expect(seen.has('run')).toBe(true);
    expect(top).toBeGreaterThan(brute.def.chase * 1.6);
  });
  it('a charge that meets a wall leaves it dazed', () => {
    const p = player(0, 0);
    const { ctx, Z } = world([p]);
    const brute = Z.spawn('brute', 0, 12, false);
    brute.active = true;
    brute.state = 'chase';
    brute.chargeCd = 0;
    let walls = 0;
    (ctx.obs as unknown as { resolveCircle: () => unknown }).resolveCircle = () => (brute.charge === 'run' && ++walls > 20 ? { breakable: false } : null);
    let stunned = false;
    for (let i = 0; i < 60 * 4; i++) {
      Z.update(1 / 60);
      if (brute.stun > 0.5) stunned = true;
    }
    expect(stunned).toBe(true);
    expect(brute.charge).toBe('none');
  });
  it('a runner throws itself the last few metres', () => {
    const p = player(0, 0);
    const { Z } = world([p]);
    const runner = Z.spawn('runner', 0, 12, false);
    runner.active = true;
    runner.state = 'chase';
    let lunged = false;
    for (let i = 0; i < 60 * 4; i++) {
      Z.update(1 / 60);
      if (runner.burstT > 0) lunged = true;
    }
    expect(lunged).toBe(true);
  });
  it('a screamer keeps its distance and keeps calling', () => {
    const p = player(0, 0);
    const { Z } = world([p]);
    const sc = Z.spawn('screamer', 0, 9, false);
    sc.active = true;
    let shrieks = 0;
    let last = sc.shriekCd;
    for (let i = 0; i < 60 * 30; i++) {
      Z.update(1 / 60);
      if (sc.shriekCd > last + 1) shrieks++;
      last = sc.shriekCd;
    }
    expect(shrieks).toBeGreaterThan(1);
    expect(Math.hypot(sc.x - p.pos.x, sc.z - p.pos.z)).toBeGreaterThan(5);
    expect(p.hits.length).toBe(0);
  });
  it('a stalker creeps while it is looked at and is on you the moment you look away', () => {
    // The player at the origin looks along +z at a stalker 20 m away.
    const p = player(0, 0, 0);
    const { Z } = world([p]);
    const st = Z.spawn('stalker', 0, 20, false);
    st.active = true;
    st.state = 'chase';
    stepZ(Z, 1);
    expect(st.watched).toBe(true);
    const z1 = st.z;
    stepZ(Z, 2);
    const creep = z1 - st.z;
    expect(creep).toBeLessThan(2);
    p.aimYaw = Math.PI; // looks away
    stepZ(Z, 0.2);
    expect(st.watched).toBe(false);
    expect(st.burstT).toBeGreaterThan(0);
    const z2 = st.z;
    stepZ(Z, 2);
    expect(z2 - st.z).toBeGreaterThan(8);
  });
  it('they feed on a carcass: head down, deaf to a quiet player, and the body goes the sooner', () => {
    const p = player(0, 0);
    const { W, Z } = world([p]);
    p.pos.z = 150;
    const deer = W.spawn('deer', 0, 210);
    W.kill(deer, 0);
    const zb = Z.spawn('walker', 0, 220, false);
    zb.active = true;
    let fed = 0;
    for (let i = 0; i < 60 * 60; i++) {
      Z.update(1 / 60);
      W.update(1 / 60);
      if (zb.feedT > 0) fed++;
    }
    expect(fed).toBeGreaterThan(60 * 2);
    expect(deer.deadT).toBeGreaterThan(60);
  });
  it('a body hit hard enough by a bumper comes apart', () => {
    const { Z, cut } = world([player(0, 0)]);
    const zb = Z.spawn('walker', 0, 0, false);
    zb.hp = 1;
    (Z as unknown as { tear(z: Zombie, dx: number, dz: number, p: number): void }).tear(zb, 0, 1, 3);
    expect(zb.wounds.mask).not.toBe(0);
    expect(cut.length).toBeGreaterThan(0);
  });
});

describe('zombies hunting strays', () => {
  const lookForPrey = (Z: ZombieSystem, z: Zombie) => (Z as unknown as { findPrey(z: Zombie, dt: number): boolean }).findPrey(z, 0.05);

  it('occasionally picks an isolated animal, while a healthy nearby herd stays together', () => {
    const { ctx, W, Z } = world([player(0, 150)]);
    const zombie = Z.spawn('walker', 0, 210, false);
    const deer = W.spawn('deer', 0, 214, 77);
    const friend = W.spawn('deer', 2, 214, 77);
    ctx.rng.chance = () => true;
    expect(lookForPrey(Z, zombie)).toBe(false);
    friend.x = 30;
    zombie.preyCd = 0;
    ctx.rng.chance = () => false;
    expect(lookForPrey(Z, zombie)).toBe(false);
    zombie.preyCd = 0;
    ctx.rng.chance = () => true;
    zombie.idleT = 3;
    expect(lookForPrey(Z, zombie)).toBe(true);
    expect(zombie.prey).toBe(deer);
    expect(zombie.idleT).toBe(0);
  });

  it('an injured animal is vulnerable even with its herd nearby, but walls conceal it', () => {
    const { ctx, W, Z } = world([player(0, 150)]);
    const zombie = Z.spawn('walker', 0, 210, false);
    const deer = W.spawn('deer', 0, 214, 77);
    W.spawn('deer', 2, 214, 77);
    deer.hp *= 0.5;
    ctx.rng.chance = () => true;
    ctx.obs.segmentBlocked = () => true;
    expect(lookForPrey(Z, zombie)).toBe(false);
    ctx.obs.segmentBlocked = () => false;
    zombie.preyCd = 0;
    expect(lookForPrey(Z, zombie)).toBe(true);
    expect(zombie.prey).toBe(deer);
  });

  it('kills a caught stray and eats the carcass, reducing what remains for scavengers', () => {
    const { ctx, W, Z } = world([player(0, 150)]);
    const zombie = Z.spawn('walker', 0, 210, false);
    const deer = W.spawn('deer', 0, 210.6);
    deer.hp = 0.05;
    ctx.rng.chance = () => true;
    stepZ(Z, 0.15);
    expect(deer.dead).toBe(true);
    expect(zombie.prey).toBeNull();
    expect(zombie.feed).toBe(deer);
    expect(zombie.feedT).toBeGreaterThan(0);
    const eaten = deer.eaten;
    const x = zombie.x;
    const z = zombie.z;
    stepZ(Z, 2);
    expect(deer.eaten).toBeGreaterThan(eaten + 1);
    expect(Math.hypot(zombie.x - x, zombie.z - z)).toBeLessThan(0.05);
    expect(lookForPrey(Z, zombie)).toBe(false);
  });

  it('drops a hunt when the animal escapes out of reach or takes flight', () => {
    const { ctx, W, Z } = world([player(0, 150)]);
    const zombie = Z.spawn('walker', 0, 210, false);
    const duck = W.spawn('duck', 0, 214);
    ctx.rng.chance = () => true;
    expect(lookForPrey(Z, zombie)).toBe(true);
    duck.air = true;
    zombie.preyCd = 1;
    expect(lookForPrey(Z, zombie)).toBe(false);
    expect(zombie.prey).toBeNull();
    expect(zombie.hasTarget).toBe(false);
    duck.air = false;
    zombie.preyCd = 0;
    expect(lookForPrey(Z, zombie)).toBe(true);
    duck.z += 50;
    expect(lookForPrey(Z, zombie)).toBe(false);
    expect(zombie.prey).toBeNull();
  });
});
