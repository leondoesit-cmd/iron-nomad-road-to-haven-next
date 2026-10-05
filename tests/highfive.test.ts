import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { Btn } from '../src/input/intents';
import { LegScene } from '../src/game/legScene';
import { fakeServices, run } from './helpers/sim';

beforeAll(async () => {
  await initPhysics();
});

const DT = 1 / 60;

function leg() {
  const h = fakeServices();
  const sc = new LegScene(h.svc, legById('L1'));
  const p = sc.players;
  p[0].exitVehicle(false);
  p[1].exitVehicle(false);
  run(sc, 1);
  return { sc, ...h };
}

describe('greetings and climbing out', () => {
  it('holding the map button next to a friend starts a high five on both, and a tap still steps the map', () => {
    const { sc, intents } = leg();
    const [a, b] = sc.players;
    b.pos.set(a.pos.x + 2, a.pos.y, a.pos.z);
    b.body.setTranslation({ x: b.pos.x, y: b.pos.y + 0.9, z: b.pos.z }, true);
    run(sc, 0.2);
    const bit = 1 << Btn.Map;
    intents[0].pressed |= bit;
    intents[0].held |= bit;
    for (let i = 0; i < 40; i++) {
      intents[0].heldTime[Btn.Map] = i * DT;
      sc.tick(DT);
      intents[0].pressed = 0;
    }
    // @ts-expect-error private
    expect(a.five).not.toBeNull();
    // @ts-expect-error private
    expect(b.five?.partner).toBe(a);
    // @ts-expect-error private
    expect([1, 2, 3]).toContain(a.five.style);
    intents[0].held = 0;
    intents[0].released |= bit;
    intents[0].releasedAfter[Btn.Map] = 0.7;
    sc.tick(DT);
    intents[0].released = 0;
    expect(a.mapMode).toBe(0);
    run(sc, 1.6);
    // @ts-expect-error private
    expect(a.five).toBeNull();
    sc.dispose();
  }, 60000);

  it('climbing out of a car eases the body out of the seat', () => {
    const h = fakeServices();
    const sc = new LegScene(h.svc, legById('L1'));
    run(sc, 0.3);
    const p = sc.players[0];
    p.exitVehicle(false);
    expect(p.state).toBe('foot');
    // @ts-expect-error private
    expect(p.exitT).toBeGreaterThan(0.4);
    run(sc, 0.8);
    // @ts-expect-error private
    expect(p.exitT).toBe(0);
    sc.dispose();
  }, 60000);
});
