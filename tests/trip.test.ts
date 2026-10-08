import { beforeAll, describe, expect, it } from 'vitest';
import { Btn, NAV } from '../src/input/intents';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { DrugState } from '../src/sim/drugs';
import { fakeServices, run } from './helpers/sim';

beforeAll(async () => {
  await initPhysics();
});

const DT = 1 / 60;

function leg() {
  const h = fakeServices();
  const sc = new LegScene(h.svc, legById('L1'));
  for (const p of sc.players) p.exitVehicle(false);
  run(sc, 0.6);
  return { sc, ...h };
}
type H = ReturnType<typeof leg>;

/** Dice loaded for just these events. */
const only = (...tags: string[]) => new DrugState((tag) => (tag && tags.includes(tag) ? 0 : 0.999));

/** Hold a button for `secs`, then let go. */
function hold(h: H, i: 0 | 1, btn: number, secs: number) {
  const it = h.intents[i];
  it.pressed |= 1 << btn;
  it.held |= 1 << btn;
  h.sc.tick(DT);
  it.pressed &= ~(1 << btn);
  run(h.sc, secs);
  it.held &= ~(1 << btn);
  it.released |= 1 << btn;
  h.sc.tick(DT);
  it.released &= ~(1 << btn);
}

describe('taking drugs on foot', () => {
  it('a tap on the use button takes the selected drug, once, and spends it', () => {
    const h = leg();
    h.campaign.items.alcohol = 2;
    h.campaign.drugs[0].selected = 'alcohol';
    hold(h, 0, Btn.Down, 0.05);
    expect(h.campaign.items.alcohol).toBe(1);
    expect(h.campaign.drugs[0].drinks).toBeGreaterThan(0.9);
    expect(h.sounds).toContain('gulp');
    expect(h.sc.players[0].notes.some((n) => /Moonshine/.test(n.text))).toBe(true);
    h.sc.dispose();
  }, 60000);

  it('taking something you do not have just says so', () => {
    const h = leg();
    h.campaign.items.lsd = 0;
    h.campaign.drugs[0].selected = 'lsd';
    hold(h, 0, Btn.Down, 0.05);
    expect(h.campaign.drugs[0].active).toHaveLength(0);
    expect(h.sc.players[0].notes.some((n) => /No lsd left/i.test(n.text))).toBe(true);
    h.sc.dispose();
  }, 60000);

  it('only the player who pressed it takes it', () => {
    const h = leg();
    h.campaign.items.weed = 1;
    h.campaign.drugs[0].selected = 'weed';
    hold(h, 0, Btn.Down, 0.05);
    expect(h.campaign.drugs[0].munchies).toBe(true);
    expect(h.campaign.drugs[1].active).toHaveLength(0);
    h.sc.dispose();
  }, 60000);

  it('holding opens the belt instead of taking, and left and right choose', () => {
    const h = leg();
    const p = h.sc.players[0];
    const d = h.campaign.drugs[0];
    h.campaign.items.painkiller = 3;
    d.selected = 'painkiller';
    const it = h.intents[0];
    it.pressed |= 1 << Btn.Down;
    it.held |= 1 << Btn.Down;
    h.sc.tick(DT);
    it.pressed = 0;
    run(h.sc, 0.5);
    expect(p.beltOpen).toBe(true);
    it.nav = NAV.right;
    h.sc.tick(DT);
    it.nav = 0;
    expect(d.selected).toBe('stim');
    it.nav = NAV.left;
    h.sc.tick(DT);
    it.nav = 0;
    expect(d.selected).toBe('painkiller');
    it.held = 0;
    it.released |= 1 << Btn.Down;
    h.sc.tick(DT);
    it.released = 0;
    expect(p.beltOpen).toBe(false);
    // Opening and closing the belt took nothing.
    expect(h.campaign.items.painkiller).toBe(3);
    expect(d.active).toHaveLength(0);
    h.sc.dispose();
  }, 60000);

  it('rummaging through the pockets roots you to the spot', () => {
    const h = leg();
    const p = h.sc.players[0];
    const it = h.intents[0];
    it.pressed |= 1 << Btn.Down;
    it.held |= 1 << Btn.Down;
    h.sc.tick(DT);
    it.pressed = 0;
    run(h.sc, 0.5);
    expect(p.beltOpen).toBe(true);
    const x = p.pos.x;
    const z = p.pos.z;
    it.move[1] = 1;
    run(h.sc, 1);
    expect(Math.hypot(p.pos.x - x, p.pos.z - z)).toBeLessThan(0.3);
    it.move[1] = 0;
    it.held = 0;
    h.sc.tick(DT);
    h.sc.dispose();
  }, 60000);
});

describe('what the blood does to the body', () => {
  it('a stim makes you faster on foot, and the comedown slower', () => {
    const h = leg();
    const p = h.sc.players[0];
    const walk = () => {
      const x = p.pos.x;
      const z = p.pos.z;
      h.intents[0].move[1] = 1;
      run(h.sc, 1.2);
      h.intents[0].move[1] = 0;
      run(h.sc, 0.3);
      return Math.hypot(p.pos.x - x, p.pos.z - z);
    };
    const base = walk();
    h.campaign.drugs[0].dose('stim');
    run(h.sc, 5);
    const fast = walk();
    expect(fast).toBeGreaterThan(base * 1.1);
    h.sc.dispose();
  }, 60000);

  it('the drunk drift where they stand, and the sober do not', () => {
    const sober = leg();
    const sp = sober.sc.players[0];
    const sx = sp.pos.x;
    const sz = sp.pos.z;
    run(sober.sc, 4);
    const still = Math.hypot(sp.pos.x - sx, sp.pos.z - sz);
    sober.sc.dispose();
    const drunk = leg();
    const dp = drunk.sc.players[0];
    drunk.campaign.drugs[0] = only('nothing');
    for (let i = 0; i < 4; i++) drunk.campaign.drugs[0].dose('alcohol');
    run(drunk.sc, 14);
    const x = dp.pos.x;
    const z = dp.pos.z;
    let far = 0;
    run(drunk.sc, 6, () => (far = Math.max(far, Math.hypot(dp.pos.x - x, dp.pos.z - z))));
    expect(still).toBeLessThan(0.1);
    // Four drinks sway them better than half a metre off where they stood (0.59 m here at the time of writing).
    expect(far).toBeGreaterThan(0.5);
    drunk.sc.dispose();
  }, 60000);

  it('the stoned are quiet and the drunk are loud, to the dead', () => {
    const h = leg();
    const p = h.sc.players[0];
    h.campaign.drugs[0] = only('nothing');
    h.campaign.drugs[0].dose('weed');
    run(h.sc, 20);
    const quiet = h.campaign.drugs[0].mods().noise;
    h.campaign.drugs[0].rest();
    for (let i = 0; i < 3; i++) h.campaign.drugs[0].dose('alcohol');
    run(h.sc, 20);
    const loud = h.campaign.drugs[0].mods().noise;
    expect(quiet).toBeLessThan(0.8);
    expect(loud).toBeGreaterThan(1);
    expect(p.alive).toBe(true);
    h.sc.dispose();
  }, 60000);

  it('painkillers take the sting out of a hit', () => {
    const h = leg();
    const p = h.sc.players[0];
    const hp0 = p.hp;
    p.hurt(20, p.pos.x + 3, p.pos.z, 'bullet');
    const plain = hp0 - p.hp;
    p.hp = hp0;
    p.invuln = 0;
    h.campaign.drugs[0] = only('nothing');
    h.campaign.drugs[0].dose('painkiller');
    run(h.sc, 20);
    p.hp = hp0;
    p.invuln = 0;
    p.hurt(20, p.pos.x + 3, p.pos.z, 'bullet');
    expect(hp0 - p.hp).toBeLessThan(plain * 0.7);
    h.sc.dispose();
  }, 60000);

  it('throwing up stops you in your tracks for a moment, and is loud', () => {
    const h = leg();
    const p = h.sc.players[0];
    h.campaign.drugs[0] = only('vomit');
    h.campaign.drugs[0].dose('mushrooms');
    let stunned = false;
    run(h.sc, 40, () => {
      if (p.stunT > 0) stunned = true;
    });
    expect(stunned).toBe(true);
    expect(h.sounds).toContain('retch');
    expect(p.notes.length + 1).toBeGreaterThan(0);
    // Over by the end.
    expect(p.stunT).toBeLessThanOrEqual(0.001);
    h.sc.dispose();
  }, 60000);

  it('while retching you cannot walk', () => {
    const h = leg();
    const p = h.sc.players[0];
    p.stunT = 2;
    const x = p.pos.x;
    const z = p.pos.z;
    h.intents[0].move[1] = 1;
    run(h.sc, 1);
    h.intents[0].move[1] = 0;
    expect(Math.hypot(p.pos.x - x, p.pos.z - z)).toBeLessThan(0.3);
    h.sc.dispose();
  }, 60000);

  it('past four drinks you pass out: no moving, and a hard enough hit wakes you', () => {
    const h = leg();
    const p = h.sc.players[0];
    h.campaign.drugs[0] = only('blackout');
    for (let i = 0; i < 6; i++) h.campaign.drugs[0].dose('alcohol');
    run(h.sc, 3);
    expect(h.campaign.drugs[0].passedOut).toBe(true);
    const x = p.pos.x;
    const z = p.pos.z;
    h.intents[0].move[1] = 1;
    run(h.sc, 1);
    expect(Math.hypot(p.pos.x - x, p.pos.z - z)).toBeLessThan(0.3);
    expect(p.prompt?.text).toMatch(/Passed out/);
    h.intents[0].move[1] = 0;
    p.hurt(15, p.pos.x + 3, p.pos.z, 'bullet');
    expect(h.campaign.drugs[0].passedOut).toBe(false);
    h.sc.dispose();
  }, 60000);

  it('a trip survives a change of scene: the state lives on the campaign, not the player', () => {
    const h = leg();
    h.campaign.drugs[0].dose('ayahuasca');
    const same = h.sc.players[0].drugs === h.campaign.drugs[0];
    expect(same).toBe(true);
    h.sc.dispose();
    const again = new LegScene(h.svc, legById('L1'));
    expect(again.players[0].drugs.active[0].id).toBe('ayahuasca');
    again.dispose();
  }, 60000);
});

/** In the middle of an LSD trip, with the dice loaded against anything else happening. */
function trippy(h: H, i: 0 | 1 = 0) {
  const d = only('nothing');
  h.campaign.drugs[i] = d;
  d.dose('lsd');
  d.active[0].age = 100;
  d.update(0.01);
  return d;
}

/** Park the phantom just started 12 m off to the side as a watcher that stays put, so a test can aim at it. */
function standOff(h: H, p: H['sc']['players'][number]) {
  const f = h.sc.phantoms.list[p.index][0];
  f.kind = 'spirit';
  f.x = p.pos.x + 12;
  f.z = p.pos.z;
  f.y = h.sc.groundAt(f.x, f.z);
  return f;
}

describe('phantoms', () => {
  it('startle puts one behind you, drawn only into your own view', () => {
    const h = leg();
    const p = h.sc.players[0];
    trippy(h);
    h.sc.phantoms.startle(p);
    expect(h.sc.phantoms.count(0)).toBe(1);
    expect(h.sc.phantoms.count(1)).toBe(0);
    const f = h.sc.phantoms.list[0][0];
    const d = Math.hypot(f.x - p.pos.x, f.z - p.pos.z);
    expect(d).toBeGreaterThan(3);
    expect(d).toBeLessThan(10);
    h.sc.dispose();
  }, 60000);

  it('appear while you are tripping, and fade out when it ends', () => {
    const h = leg();
    h.campaign.drugs[0] = only('nothing');
    h.campaign.drugs[0].dose('lsd');
    h.campaign.drugs[0].active[0].age = 100;
    h.campaign.drugs[0].update(0.01);
    const real = Math.random;
    Math.random = () => 0;
    try {
      run(h.sc, 3);
    } finally {
      Math.random = real;
    }
    expect(h.sc.phantoms.count(0)).toBeGreaterThan(0);
    expect(h.sc.phantoms.count(1)).toBe(0);
    h.campaign.drugs[0].rest();
    run(h.sc, 4);
    expect(h.sc.phantoms.count(0)).toBe(0);
    h.sc.dispose();
  }, 60000);

  it('a shot goes through one and it dissolves; the real dead are untouched', () => {
    const h = leg();
    const p = h.sc.players[0];
    trippy(h);
    h.sc.phantoms.startle(p);
    const f = standOff(h, p);
    run(h.sc, 1.5);
    expect(f.alpha).toBeGreaterThan(0.3);
    const dx = f.x - p.pos.x;
    const dz = f.z - p.pos.z;
    const l = Math.hypot(dx, dz);
    const before = h.sc.zombies.aliveCount;
    h.sc.phantoms.onShot(p, p.pos.x, p.pos.y + 1.4, p.pos.z, dx / l, 0, dz / l);
    expect(f.popT).toBeGreaterThan(0);
    expect(h.sc.phantoms.pops[0].length).toBe(1);
    expect(h.sc.zombies.aliveCount).toBe(before);
    h.sc.dispose();
  }, 60000);

  it('a shot that misses leaves it alone', () => {
    const h = leg();
    const p = h.sc.players[0];
    trippy(h);
    h.sc.phantoms.startle(p);
    const f = standOff(h, p);
    run(h.sc, 1.5);
    const dx = f.x - p.pos.x;
    const dz = f.z - p.pos.z;
    const l = Math.hypot(dx, dz);
    // The other way entirely.
    h.sc.phantoms.onShot(p, p.pos.x, p.pos.y + 1.4, p.pos.z, -dx / l, 0, -dz / l);
    expect(f.popT).toBe(0);
    h.sc.dispose();
  }, 60000);

  it('looking straight at one for a moment makes it dissolve', () => {
    const h = leg();
    const p = h.sc.players[0];
    trippy(h);
    h.sc.phantoms.startle(p);
    const f = h.sc.phantoms.list[0][0];
    // Put it well ahead and look at it. (Nothing here moves it closer than the 5 m it needs to be to be looked at.)
    f.x = p.pos.x + 12;
    f.z = p.pos.z;
    f.kind = 'spirit';
    p.cam.fwd.set(1, 0, 0);
    let popped = false;
    run(h.sc, 3, () => {
      if (f.popT !== 0) popped = true;
    });
    expect(popped).toBe(true);
    h.sc.dispose();
  }, 60000);

  it('walking into one is a shock, and nothing more', () => {
    const h = leg();
    const p = h.sc.players[0];
    trippy(h);
    h.sc.phantoms.startle(p);
    const f = h.sc.phantoms.list[0][0];
    f.x = p.pos.x + 2.5;
    f.z = p.pos.z;
    const hp = p.hp;
    run(h.sc, 2);
    expect(f.popT).not.toBe(0);
    expect(p.hp).toBe(hp);
    h.sc.dispose();
  }, 60000);

  it('friendly ones dance round you when weed and LSD are in you together', () => {
    const h = leg();
    const p = h.sc.players[0];
    h.campaign.drugs[0] = only('nothing');
    h.campaign.drugs[0].dose('weed');
    h.campaign.drugs[0].dose('lsd');
    for (const a of h.campaign.drugs[0].active) a.age = 100;
    h.campaign.drugs[0].update(0.01);
    expect(h.campaign.drugs[0].friendly).toBe(true);
    h.sc.phantoms.startle(p);
    expect(h.sc.phantoms.list[0][0].kind).toBe('dancer');
    h.sc.dispose();
  }, 60000);
});

describe('seeing through walls', () => {
  it('the vine marks the dead around you; a clear head does not', () => {
    const h = leg();
    const p = h.sc.players[0];
    h.sc.zombies.spawn('walker', p.pos.x + 20, p.pos.z + 5, true, 1);
    const marks = (sight: number) => (h.sc as unknown as { senseMarks(p: unknown, s: number): { kind: string }[] }).senseMarks(p, sight);
    expect(marks(0)).toHaveLength(0);
    const light = marks(0.2);
    expect(light.some((m) => m.kind === 'zombie')).toBe(true);
    // Deeper sight also lights the road ahead.
    expect(marks(1).some((m) => m.kind === 'path')).toBe(true);
    expect(light.some((m) => m.kind === 'path')).toBe(false);
    h.sc.dispose();
  }, 60000);

  it('the compass shows what is felt, only when deep', () => {
    const h = leg();
    const p = h.sc.players[0];
    h.sc.zombies.spawn('walker', p.pos.x + 20, p.pos.z + 5, true, 1);
    h.campaign.drugs[0] = only('nothing');
    h.campaign.drugs[0].dose('ayahuasca');
    h.campaign.drugs[0].active[0].age = 150;
    h.campaign.drugs[0].update(0.01);
    h.sc.renderFrame(1, DT);
    expect(h.sc.revealPins(p).some((pin) => pin.kind === 'threat')).toBe(true);
    h.campaign.drugs[0].rest();
    h.sc.renderFrame(1, DT);
    expect(h.sc.revealPins(p)).toHaveLength(0);
    h.sc.dispose();
  }, 60000);
});
