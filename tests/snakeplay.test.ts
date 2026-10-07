import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { WorldMemory } from '../src/game/worldMemory';
import { VENOM } from '../src/sim/venom';
import { fakeServices, run } from './helpers/sim';

// Snakes in a real scene: a viper's bite and its venom on a real player, the tick that drives them, and the cure.

beforeAll(async () => {
  await initPhysics();
});

function open() {
  const h = fakeServices();
  const sc = new LegScene(h.svc, legById('W'), { memory: new WorldMemory(), start: { x: 0, z: 10, yaw: 0 } });
  for (const p of sc.players) if (p.vehicle) p.exitVehicle(false);
  run(sc, 0.5);
  sc.life!.enabled = false;
  return sc;
}

describe('snakes in play', () => {
  it('a viper the player walks into strikes on the fixed tick, and the venom works on', () => {
    const sc = open();
    const p = sc.players[0];
    const life = sc.life!;
    life.spawnAt('snake', p.pos.x, p.pos.z + 0.6);
    const v = life.list[life.list.length - 1];
    v.ref = 1;
    v.size = 0.9;
    v.yaw = Math.PI;
    v.state = 4;
    v.timer = 3;
    const hp0 = p.hp;
    run(sc, 1);
    expect(p.venom.dose).toBeGreaterThan(0);
    expect(p.hp).toBeLessThan(hp0);
    const after = p.hp;
    // Step well away and wait: the venom keeps taking health.
    p.placeAt(p.pos.x, p.pos.z - 15, 0);
    run(sc, 10);
    expect(p.hp).toBeLessThan(after - 2);
  });

  it('a medkit draws most of the venom', () => {
    const sc = open();
    const p = sc.players[0];
    p.snakeBite('palestine', p.pos.x, p.pos.z + 1);
    const dose = p.venom.dose;
    expect(dose).toBeCloseTo(VENOM.palestine.dose, 3);
    sc.campaign.items.medkit = Math.max(1, sc.campaign.items.medkit);
    expect(p.useDressing('medkit')).toBe(true);
    expect(p.venom.dose).toBeLessThan(dose * 0.35);
  });
});
