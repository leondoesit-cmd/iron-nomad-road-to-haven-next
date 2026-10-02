import { beforeAll, describe, expect, it } from 'vitest';
import { assignBinding, defaultBindings, exportBindings, importBindings } from '../src/input/bindings';
import { Btn } from '../src/input/intents';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
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

/** Press a button for one tick, then let go. */
function press(h: ReturnType<typeof leg>, i: 0 | 1, btn: number) {
  h.intents[i].pressed |= 1 << btn;
  h.intents[i].held |= 1 << btn;
  h.sc.tick(DT);
  h.intents[i].pressed &= ~(1 << btn);
}

/** Highest point reached over the next `seconds`, relative to where the feet started. */
function apex(h: ReturnType<typeof leg>, seconds: number) {
  const p = h.sc.players[0];
  const y0 = p.pos.y;
  let top = 0;
  run(h.sc, seconds, () => (top = Math.max(top, p.pos.y - y0)));
  return top;
}

describe('jump bindings', () => {
  it('jump shares the interact button on a pad and has its own key on each keyboard', () => {
    const b = defaultBindings();
    expect(b.pad.jump).toBe(Btn.A);
    expect(b.pad.interact).toBe(Btn.A);
    expect(b.kb[0].jump).toBeDefined();
    expect(b.kb[1].jump).toBeDefined();
    expect(b.kb[0].jump).not.toBe(b.kb[1].jump);
  });

  it('survives a save and load, including the shared pad button', () => {
    const b = defaultBindings();
    const back = importBindings(JSON.parse(JSON.stringify(exportBindings(b))));
    expect(back.pad.jump).toBe(Btn.A);
    expect(back.pad.interact).toBe(Btn.A);
    expect(back).toEqual(b);
  });

  it('rebinding another action onto A moves interact and jump off it together', () => {
    const b = defaultBindings();
    assignBinding('pad', b.pad, 'crouch', Btn.A);
    expect(b.pad.crouch).toBe(Btn.A);
    expect(b.pad.interact).toBe(Btn.B);
    expect(b.pad.jump).toBe(Btn.B);
  });

  it('rebinding jump alone leaves interact where it was, and a taken button swaps', () => {
    const b = defaultBindings();
    assignBinding('pad', b.pad, 'jump', Btn.X);
    expect(b.pad.interact).toBe(Btn.A);
    expect(b.pad.jump).toBe(Btn.X);
    expect(b.pad.reload).toBe(Btn.A);
    const k = defaultBindings();
    const taken = k.kb[0].crouch!;
    assignBinding('kb', k.kb[0], 'jump', taken);
    expect(k.kb[0].crouch).toBe('KeyJ');
  });
});

describe('jumping on foot', () => {
  it('leaves the ground, reaches about a metre, and lands again', () => {
    const h = leg();
    const p = h.sc.players[0];
    expect(p.grounded).toBe(true);
    const y0 = p.pos.y;
    press(h, 0, Btn.Jump);
    h.intents[0].held = 0;
    let top = 0;
    let airborne = false;
    run(h.sc, 1.2, () => {
      top = Math.max(top, p.pos.y - y0);
      if (!p.grounded) airborne = true;
    });
    expect(airborne).toBe(true);
    expect(top).toBeGreaterThan(0.7);
    expect(top).toBeLessThan(1.3);
    expect(p.grounded).toBe(true);
    expect(Math.abs(p.pos.y - y0)).toBeLessThan(0.1);
    expect(h.sounds).toContain('thud');
    h.sc.dispose();
  }, 60000);

  it('keeps the run speed in the air', () => {
    const h = leg();
    const p = h.sc.players[0];
    const x0 = p.pos.x;
    const z0 = p.pos.z;
    h.intents[0].move[1] = 1;
    run(h.sc, 0.4);
    const x1 = p.pos.x;
    const z1 = p.pos.z;
    press(h, 0, Btn.Jump);
    run(h.sc, 0.3);
    expect(p.grounded).toBe(false);
    // Still travelling: it covered at least half the ground a walker would in that time.
    const flown = Math.hypot(p.pos.x - x1, p.pos.z - z1);
    expect(Math.hypot(x1 - x0, z1 - z0)).toBeGreaterThan(0.5);
    expect(flown).toBeGreaterThan(0.5);
    h.intents[0].move[1] = 0;
    h.sc.dispose();
  }, 60000);

  it('cannot jump again in mid-air', () => {
    const h = leg();
    const p = h.sc.players[0];
    press(h, 0, Btn.Jump);
    run(h.sc, 0.28);
    const y = p.pos.y;
    press(h, 0, Btn.Jump);
    run(h.sc, 0.1);
    expect(p.pos.y).toBeLessThan(y + 0.05);
    h.sc.dispose();
  }, 60000);

  it('a press just before landing is buffered into the next jump', () => {
    const h = leg();
    const p = h.sc.players[0];
    const y0 = p.pos.y;
    press(h, 0, Btn.Jump);
    run(h.sc, 0.5); // landing is due at about 0.6 s
    expect(p.grounded).toBe(false);
    press(h, 0, Btn.Jump);
    // The fall was heading down; touching down inside the buffer window sends it back up.
    let rose = false;
    run(h.sc, 0.4, () => {
      if (p.vy > 5) rose = true;
    });
    expect(rose).toBe(true);
    expect(p.pos.y - y0).toBeGreaterThan(-0.1);
    h.sc.dispose();
  }, 60000);

  it('A jumps when nothing is in reach, and the dedicated key jumps regardless', () => {
    const h = leg();
    const p = h.sc.players[0];
    // A pad press raises both A and Jump together.
    h.intents[0].pressed |= (1 << Btn.A) | (1 << Btn.Jump);
    h.intents[0].held |= (1 << Btn.A) | (1 << Btn.Jump);
    h.sc.tick(DT);
    h.intents[0].pressed = 0;
    h.intents[0].held = 0;
    run(h.sc, 0.2);
    expect(p.grounded).toBe(false);
    h.sc.dispose();
  }, 60000);

  it('jumping from a crouch stands up', () => {
    const h = leg();
    const p = h.sc.players[0];
    p.crouch = true;
    press(h, 0, Btn.Jump);
    run(h.sc, 0.2);
    expect(p.grounded).toBe(false);
    expect(p.crouch).toBe(false);
    h.sc.dispose();
  }, 60000);

  it('a ceiling stops the rise instead of sticking to it', () => {
    const h = leg();
    const p = h.sc.players[0];
    press(h, 0, Btn.Jump);
    run(h.sc, 0.1);
    p.vy = 8;
    p.body.setTranslation({ x: p.pos.x, y: p.pos.y + 0.85, z: p.pos.z }, true);
    run(h.sc, 1.2);
    expect(p.grounded).toBe(true);
    h.sc.dispose();
  }, 60000);
});
