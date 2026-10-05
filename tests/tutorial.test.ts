import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { WorldMemory } from '../src/game/worldMemory';
import { TutorialDirector, TRAINING_STEPS, fillTokens } from '../src/game/tutorial';
import { Btn } from '../src/input/intents';
import { fakeServices } from './helpers/sim';
import { standAt } from './helpers/access';
import type { CoachView } from '../src/ui/coach';

// A real open-world scene in Node, with the training lessons running on it.
vi.setConfig({ testTimeout: 120000 });

beforeAll(async () => {
  await initPhysics();
});

const DT = 1 / 60;

function training(solo = false) {
  const h = fakeServices({ solo });
  const sc = new LegScene(h.svc, legById('W'), { memory: new WorldMemory(), training: true });
  const cards: { seat: number; v: CoachView }[] = [];
  const ui = { render: (seat: number, v: CoachView) => cards.push({ seat, v }), hide() {}, dispose() {} };
  const d = new TutorialDirector(ui as never);
  let camped = 0;
  sc.onResult = (r) => {
    if (r.type === 'dusk') {
      camped++;
      d.note('camp', 0);
    }
  };
  let finished = 0;
  d.onFinish = () => finished++;
  const it = h.intents;
  for (const i of it) i.device = 'pad';
  /** Run both the scene and the director. */
  const run = (secs: number, each?: (i: number) => void) => {
    for (let i = 0; i < Math.round(secs / DT); i++) {
      each?.(i);
      sc.tick(DT);
      d.tick(sc, DT);
      for (const x of it) {
        x.pressed = 0;
        x.released = 0;
      }
    }
  };
  /** Press a button for one tick. */
  const tap = (who: number, btn: number) => {
    const x = it[who];
    x.pressed = 1 << btn;
    x.held |= 1 << btn;
    run(DT);
    x.held &= ~(1 << btn);
    x.released = 1 << btn;
    run(DT);
  };
  /** Hold a button for `secs`. */
  const hold = (who: number, btn: number, secs: number) => {
    const x = it[who];
    x.held |= 1 << btn;
    x.pressed = 1 << btn;
    x.heldTime[btn] = 0;
    run(secs, () => (x.heldTime[btn] += DT));
    x.held &= ~(1 << btn);
    x.released = 1 << btn;
    x.heldTime[btn] = 0;
    run(DT);
  };
  return { h, sc, d, cards, it, run, tap, hold, camped: () => camped, finished: () => finished };
}

const lastCard = (t: ReturnType<typeof training>, seat = 0) => [...t.cards].reverse().find((c) => c.seat === seat)!.v;

describe('lesson text', () => {
  it('names the keys each seat actually presses', () => {
    expect(fillTokens('hold {interact} then {vehicle}', null, 0)).toBe('hold <kbd>A</kbd> then <kbd>Y</kbd>');
    const kb1 = fillTokens('{move} / {interact} / {jump}', { kind: 'kb', set: 1 }, 0);
    expect(kb1).toContain('<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>');
    expect(kb1).toContain('<kbd>E</kbd>');
    expect(kb1).toContain('<kbd>Space</kbd>');
    const kb2 = fillTokens('{interact}', { kind: 'kb', set: 2 }, 1);
    expect(kb2).toBe('<kbd>/</kbd>');
  });

  it('has a lesson for each thing the guide promises', () => {
    expect(TRAINING_STEPS).toBe(12);
  });
});

describe('training', () => {
  it('starts quiet, on foot, at midday, with the first lesson up', () => {
    const t = training();
    t.run(2);
    expect(t.sc.training).toBe(true);
    expect(t.sc.players.map((p) => p.state)).toEqual(['foot', 'foot']);
    expect(t.sc.zombies.aliveCount).toBe(0);
    expect(t.sc.raiders.units.length).toBe(0);
    expect(t.sc.clock.frozen).toBe(true);
    expect(t.d.index).toBe(0);
    expect(lastCard(t).title).toBe('Walk and look');
    expect(lastCard(t, 1).n).toBe(1);
  });

  it('walks the player through every lesson with real input', () => {
    const t = training();
    const { sc, d, it, run, tap, hold } = t;
    const [a, b] = sc.players;
    const finishLesson = () => run(2);
    const at = () => `${d.index}:${lastCard(t).title}`;

    // 1. Walk and look: the stick, then the right stick.
    for (const x of it) x.move = [0, 1];
    run(4);
    for (const x of it) {
      x.move = [0, 0];
      x.look = [1, 0];
    }
    run(3);
    for (const x of it) x.look = [0, 0];
    finishLesson();
    expect(at()).toBe('1:Sprint, jump, crouch');

    // 2. Sprint, jump, crouch.
    for (const x of it) {
      x.move = [0, 1];
      x.sprint = true;
    }
    run(1.5);
    for (const x of it) {
      x.move = [0, 0];
      x.sprint = false;
    }
    for (let w = 0; w < 2; w++) {
      tap(w, Btn.Jump);
      run(0.2);
    }
    tap(0, Btn.B);
    tap(1, Btn.B);
    run(0.5);
    finishLesson();
    expect(at()).toBe('2:Aim, shoot, reload');
    expect(a.crouch && b.crouch).toBe(true);
    tap(0, Btn.B);
    tap(1, Btn.B);

    // 3. Shoot: the sleepers are marked, and waking them is the point.
    expect(d.targets.length).toBe(2);
    expect(sc.zombies.aliveCount).toBe(2);
    expect(d.targets.every((z) => z.state === 'dormant')).toBe(true);
    const z0 = d.targets[0];
    // Stand twelve metres off and face them.
    for (const p of sc.players) {
      p.placeAt(z0.x + (p.index ? 1 : -1), z0.z - 12, 0);
      p.aimYaw = 0;
    }
    run(1);
    for (const x of it) x.lt = 1;
    run(0.6);
    for (const x of it) x.rt = 1;
    run(1.0);
    for (const x of it) x.rt = 0;
    for (const x of it) x.lt = 0;
    for (let w = 0; w < 2; w++) hold(w, Btn.X, 0.2);
    run(2.5);
    // The three things done by hand were noticed before the kills were.
    expect(lastCard(t).goals.filter((g) => g.done).map((g) => g.label)).toEqual(expect.arrayContaining(['Aim down the sights', 'Fire the pistol', 'Reload']));
    // Whatever the shots missed, the lesson wants both of them down.
    for (const z of d.targets) if (!z.dead) sc.zombies.damage(z, 999, { fromX: 0, fromZ: 0, killer: 0 });
    run(2.5);
    expect(at()).toBe('3:Take what you find');

    // 4. Loot: the goods lie in the road and the crate stands by.
    expect(d.loot.length).toBe(2);
    expect(d.crate?.taken).toBe(false);
    const start = { rations: sc.campaign.stocks.rations };
    for (const id of d.loot) {
      const spot = sc.pickupAt(id)!;
      a.placeAt(spot.x + 0.6, spot.z, -Math.PI / 2);
      hold(0, Btn.A, 1.5);
    }
    expect(sc.campaign.stocks.rations).toBeGreaterThan(start.rations);
    // One person's loot counts for both, so b has nothing to do for it. The crate is searched by either.
    run(0.3);
    expect(lastCard(t, 1).goals[0].done).toBe(true);
    b.placeAt(d.crate!.x + 0.8, d.crate!.z, 0);
    hold(1, Btn.A, 3);
    expect(d.crate!.taken).toBe(true);
    finishLesson();
    expect(at()).toBe('4:Get in your moped');

    // 5. Get in: each moped is marked, and a hold of the vehicle button does it.
    expect(sc.trainingPins.length).toBe(2);
    for (const p of sc.players) {
      const v = p.ownVehicle!;
      p.placeAt(v.position.x + 1.3, v.position.z, -Math.PI / 2);
      hold(p.index, Btn.Y, 0.8);
    }
    run(1.5);
    expect(sc.players.map((p) => p.state)).toEqual(['driving', 'driving']);
    finishLesson();
    expect(at()).toBe('5:Drive');
    expect(sc.trainingPins.length).toBe(0);

    // 6. Drive: throttle down the road, honk, lights.
    for (const x of it) x.rt = 1;
    for (let w = 0; w < 2; w++) {
      // A short press of B puts the lights on.
      it[w].held |= 1 << Btn.B;
      it[w].heldTime[Btn.B] = 0.1;
      run(0.1);
      it[w].held &= ~(1 << Btn.B);
      it[w].released = 1 << Btn.B;
      it[w].releasedAfter[Btn.B] = 0.1;
      run(DT);
    }
    run(14);
    expect(at()).toBe('6:Noise and dust');
    expect(lastCard(t).goals[0].done).toBe(true);
    expect(lastCard(t).goals[1].done).toBe(false);

    // 7. Noise and dust: already at speed, so the horn spikes the meter.
    for (let w = 0; w < 2; w++) tap(w, Btn.X);
    run(0.3);
    expect(lastCard(t).goals[1].done).toBe(true);
    finishLesson();
    expect(at()).toBe('7:Park and get out');

    // 8. Park and get out.
    for (const x of it) {
      x.rt = 0;
      x.lt = 1;
    }
    run(1.8);
    for (const x of it) x.lt = 0;
    run(2);
    expect(Math.abs(a.vehicle!.speed)).toBeLessThan(1);
    for (let w = 0; w < 2; w++) hold(w, Btn.Y, 0.8);
    run(0.5);
    expect(sc.players.map((p) => p.state)).toEqual(['foot', 'foot']);
    finishLesson();
    expect(at()).toBe('8:Wrench and can');

    // 9. Wrench and can: the moped is hurt and nearly dry, with a can beside it.
    for (const p of sc.players) {
      const v = p.ownVehicle!;
      expect(v.health.hp).toBeLessThan(v.health.maxHp * 0.5);
      expect(v.fuel).toBeLessThan(v.tankMax * 0.1);
      expect(d.cans.get(p.index)).toBeTruthy();
    }
    // LB walks the belt: pistol, then the wrench.
    for (let w = 0; w < 2; w++) {
      tap(w, Btn.LB);
      expect(sc.players[w].equip).toBe('wrench');
    }
    // Repair with the wrench held, standing at the moped.
    for (const p of sc.players) {
      const v = p.ownVehicle!;
      const hp0 = v.health.hp;
      p.placeAt(v.position.x + (p.index ? -1.3 : 1.3), v.position.z, p.index ? Math.PI / 2 : -Math.PI / 2);
      hold(p.index, Btn.A, 6);
      expect(v.health.hp).toBeGreaterThan(hp0 + v.health.maxHp * 0.08);
    }
    expect(lastCard(t).goals.map((g) => g.done)).toEqual([true, true, false, false]);
    // Then the can: lift it where it lies, carry it to the moped, pour.
    for (const p of sc.players) {
      const can = sc.pickupAt(d.cans.get(p.index)!)!;
      p.placeAt(can.x - (p.index ? -0.6 : 0.6), can.z, p.index ? -Math.PI / 2 : Math.PI / 2);
      hold(p.index, Btn.A, 1.5);
      expect(p.carry?.kind).toBe('fuel');
      const v = p.ownVehicle!;
      const f0 = v.fuel;
      standAt(sc, v, 'flap', 0, p.index);
      hold(p.index, Btn.A, 4);
      expect(v.fuel).toBeGreaterThan(f0 + 0.5);
    }
    finishLesson();
    expect(at()).toBe('9:Map and pings');

    // 10. Map and pings.
    for (let w = 0; w < 2; w++) tap(w, Btn.Map);
    expect(sc.players.map((p) => p.mapMode > 0)).toEqual([true, true]);
    run(0.3);
    expect(lastCard(t).goals[0].done).toBe(true);
    expect(lastCard(t).goals[1].done).toBe(false);
    // The ping itself is made by the Game from the command wheel; it lands as a ping owned by the seat.
    run(0.2);
    sc.addPing(a.pos.x, a.pos.z + 20, 0);
    sc.addPing(b.pos.x, b.pos.z + 20, 1);
    run(0.3);
    finishLesson();
    expect(at()).toBe('10:Your pack');

    // 11. The pack is opened by the Game, which tells the director who did.
    run(1);
    expect(lastCard(t).goals[0].done).toBe(false);
    d.note('inventory', 0);
    run(0.3);
    expect(lastCard(t, 0).goals[0].done).toBe(true);
    expect(lastCard(t, 0).waiting).toMatch(/Waiting for/);
    d.note('inventory', 1);
    finishLesson();
    expect(at()).toBe('11:Make camp');

    // 12. The Dusk Bell rings, and holding where you stand makes camp.
    expect(sc.clock.frozen).toBe(false);
    run(0.5);
    expect(sc.clock.bellRung).toBe(true);
    expect(t.camped()).toBe(0);
    // Away from the moped and the can, which would offer their own jobs first.
    a.placeAt(a.pos.x - 30, a.pos.z + 10, 0);
    hold(0, Btn.A, 3);
    expect(t.camped()).toBe(1);
    run(2.5);
    expect(d.finished).toBe(true);
    expect(t.finished()).toBe(1);
    expect(sc.trainingPins.length).toBe(0);
  });

  it('plays solo: one card, and the lesson ends when the one player is done', () => {
    const t = training(true);
    t.run(1);
    expect(t.sc.players.length).toBe(1);
    expect(t.cards.every((c) => c.seat === 0)).toBe(true);
    t.it[0].move = [0, 1];
    t.run(4);
    t.it[0].move = [0, 0];
    t.it[0].look = [1, 0];
    t.run(3);
    t.it[0].look = [0, 0];
    t.run(2);
    expect(t.d.index).toBe(1);
    // No partner to wait for.
    expect(lastCard(t).waiting).toBe('');
  });

  it('can skip a lesson that somebody is stuck on, and never finishes twice', () => {
    const t = training();
    t.run(0.5);
    t.d.skip();
    t.run(0.5);
    expect(t.d.index).toBe(1);
    for (let i = 0; i < 20; i++) t.d.skip();
    expect(t.d.finished).toBe(true);
    expect(t.finished()).toBe(1);
    t.d.skip();
    expect(t.finished()).toBe(1);
  });

  it('keeps people alive: a downed player is back on their feet', () => {
    const t = training();
    t.run(0.5);
    const p = t.sc.players[0];
    p.hurt(500, 0, 0, 'melee');
    expect(['downed', 'dead']).toContain(p.state);
    t.run(4);
    expect(p.state).toBe('foot');
  });
});
