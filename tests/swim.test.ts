import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { Btn } from '../src/input/intents';
import { LegScene } from '../src/game/legScene';
import { Humanoid } from '../src/render/humanoid';
import { identityOf } from '../src/render/outfit';
import { SWIM, diveRate, newBreath, stepBreath, swimSpeed } from '../src/sim/swim';
import { fakeServices, run } from './helpers/sim';

beforeAll(async () => {
  await initPhysics();
});

const DT = 1 / 60;

describe('swim numbers', () => {
  it('a hard crawl beats an easy stroke, and under the surface is slower than either', () => {
    const w = false;
    expect(swimSpeed({ fast: true, under: false, winded: w })).toBeGreaterThan(swimSpeed({ fast: false, under: false, winded: w }));
    expect(swimSpeed({ fast: false, under: true, winded: w })).toBeLessThan(swimSpeed({ fast: false, under: false, winded: w }));
    expect(swimSpeed({ fast: true, under: false, winded: true })).toBeLessThan(swimSpeed({ fast: true, under: false, winded: w }));
  });

  it('the lungs last about half a minute under, fill in a few seconds, and then the water hurts', () => {
    const b = newBreath();
    let t = 0;
    let hurt = 0;
    while (b.air > 0 && t < 60) (stepBreath(b, DT, true), (t += DT));
    expect(t).toBeGreaterThan(SWIM.air * 0.95);
    expect(t).toBeLessThan(SWIM.air * 1.05);
    for (let i = 0; i < 120; i++) hurt += stepBreath(b, DT, true).hurt;
    expect(hurt).toBeCloseTo(SWIM.drown * 2, 1);
    let gasped = false;
    t = 0;
    while (b.air < 1 && t < 10) {
      // Step first: `gasped ||= step()` would stop stepping once it was true.
      const ev = stepBreath(b, DT, false);
      gasped = gasped || ev.gasped;
      t += DT;
    }
    expect(gasped).toBe(true);
    expect(t).toBeLessThan(SWIM.refill + 0.1);
  });

  it('a short hold comes up without a gasp', () => {
    const b = newBreath();
    for (let i = 0; i < 60 * 5; i++) stepBreath(b, DT, true);
    let gasped = false;
    for (let i = 0; i < 60 * 5; i++) {
      const ev = stepBreath(b, DT, false);
      gasped = gasped || ev.gasped;
    }
    expect(gasped).toBe(false);
    expect(b.air).toBe(1);
  });

  it('ducking goes down on its own, then looking down or up steers and level holds the depth', () => {
    expect(diveRate(0, 0, 0)).toBeLessThan(0);
    expect(diveRate(0, 0, SWIM.duckTo + 0.1)).toBe(0);
    expect(diveRate(-0.8, 2, 2)).toBeLessThan(-1);
    expect(diveRate(0.8, 2, 2)).toBeGreaterThan(1);
    // Looking up straight away undoes the duck rather than going deeper.
    expect(diveRate(0.6, 1, 0.1)).toBeGreaterThan(0);
  });
});

describe('the swimmer on the rig', () => {
  it('treads water upright when still and lies flat in a crawl when moving, arms turning', () => {
    const h = new Humanoid(identityOf(0));
    h.swim = 1;
    for (let i = 0; i < 90; i++) h.update(DT, 'stand', 0, 0, 0);
    const upright = h.hips.rotation.x;
    expect(upright).toBeLessThan(0.4);
    const seen: number[] = [];
    for (let i = 0; i < 180; i++) {
      h.update(DT, 'stand', 2, 0, 0);
      seen.push(h.armL.rotation.x);
    }
    // Face down, near horizontal, hips lifted to the surface.
    expect(h.hips.rotation.x).toBeGreaterThan(1.2);
    expect(h.hips.position.y).toBeGreaterThan(1.0);
    // An arm goes right round, in over the water and back under.
    expect(Math.max(...seen) - Math.min(...seen)).toBeGreaterThan(4.5);
    // The two arms are half a stroke apart.
    expect(Math.abs(h.armL.rotation.x - h.armR.rotation.x)).toBeGreaterThan(0.5);
  });

  it('a dive tips the nose down and standing again puts the body back upright', () => {
    const h = new Humanoid(identityOf(0));
    h.swim = 1;
    for (let i = 0; i < 90; i++) h.update(DT, 'stand', 2, 0, 0);
    const flat = h.hips.rotation.x;
    h.swimDive = 1;
    h.swimPitch = 0.8;
    for (let i = 0; i < 30; i++) h.update(DT, 'stand', 2, 0, 0);
    expect(h.hips.rotation.x).toBeGreaterThan(flat + 0.6);
    h.swim = 0;
    h.swimDive = 0;
    h.swimPitch = 0;
    for (let i = 0; i < 120; i++) h.update(DT, 'stand', 0, 0, 0);
    expect(h.hips.rotation.x).toBeLessThan(0.05);
    expect(h.hips.position.y).toBeCloseTo(0.92, 1);
  });

  it('first person shows the whole swinging arm, not the stand-still hide', () => {
    const h = new Humanoid(identityOf(0));
    h.swim = 1;
    for (let i = 0; i < 60; i++) h.update(DT, 'stand', 2, 0, 0);
    h.setFirstPerson(true, false);
    const arms = h.meshes.filter((m) => m.visible).length;
    h.setFirstPerson(false);
    h.swim = 0;
    for (let i = 0; i < 120; i++) h.update(DT, 'stand', 0, 0, 0);
    h.setFirstPerson(true, false);
    const bare = h.meshes.filter((m) => m.visible).length;
    h.setFirstPerson(false);
    expect(arms).toBeGreaterThan(bare);
  });
});

function lake() {
  const h = fakeServices();
  const sc = new LegScene(h.svc, legById('L1'));
  for (const p of sc.players) p.exitVehicle(false);
  run(sc, 0.5);
  // The deepest open water of the first lake, with the other survivor out of the way.
  const lk = sc.terrain!.lakes[0];
  let sx = lk.x;
  let sz = lk.z;
  let best = 0;
  for (let a = 0; a < 360; a += 15) {
    for (let r = 5; r < lk.r * 0.6; r += 5) {
      const x = lk.x + Math.cos(a) * r;
      const z = lk.z + Math.sin(a) * r;
      const d = sc.waterAt(x, z)?.depth ?? 0;
      if (d > best) (best = d), (sx = x), (sz = z);
    }
  }
  const p = sc.players[1];
  p.placeAt(sx, sz, 0);
  p.pos.y = sc.waterAt(sx, sz)!.level - 1.2;
  p.body.setTranslation({ x: sx, y: p.pos.y + 0.85, z: sz }, true);
  (sc as unknown as { updateTether: () => void }).updateTether = () => {};
  run(sc, 1.5);
  return { sc, ...h, p, best };
}

const tap = (h: ReturnType<typeof lake>, btn: number) => {
  h.intents[1].pressed |= 1 << btn;
  h.intents[1].held |= 1 << btn;
  h.sc.tick(DT);
  h.intents[1].pressed &= ~(1 << btn);
  h.intents[1].held &= ~(1 << btn);
};

describe('swimming in a lake', () => {
  it('crawls faster with the sprint button, at a cost in stamina', () => {
    const h = lake();
    const { sc, intents, p } = h;
    expect(p.swimming).toBe(true);
    intents[1].move = [0, 1];
    const pace = (secs: number) => {
      const x0 = p.pos.x;
      const z0 = p.pos.z;
      run(sc, secs);
      return Math.hypot(p.pos.x - x0, p.pos.z - z0) / secs;
    };
    run(sc, 1);
    const easy = pace(2);
    const s0 = p.stamina.value;
    intents[1].sprint = true;
    run(sc, 0.7);
    const hard = pace(2);
    expect(hard).toBeGreaterThan(easy + 0.5);
    expect(p.stamina.value).toBeLessThan(s0 - 5);
    // Still a swimmer's pace, not a sprinter's.
    expect(hard).toBeLessThan(4.2);
    sc.dispose();
  }, 60000);

  it('ducks under on the crouch button, goes down, loses its air, and comes up on jump', () => {
    const h = lake();
    const { sc, intents, p } = h;
    expect(h.best).toBeGreaterThan(3);
    const lvl = sc.waterAt(p.pos.x, p.pos.z)!.level;
    expect(p.underwater).toBe(false);
    tap(h, Btn.B);
    run(sc, 1.5);
    expect(p.diveY).toBeGreaterThan(0.6);
    expect(p.underwater).toBe(true);
    expect(p.pos.y).toBeLessThan(lvl - 1.2 - 0.5);
    run(sc, 8);
    expect(p.breath.air).toBeLessThan(0.8);
    expect(p.breath.air).toBeGreaterThan(0.4);
    // Look straight down and swim: deeper.
    const d0 = p.diveY;
    p.aimPitch = -1.0;
    intents[1].move = [0, 1];
    run(sc, 1.5);
    expect(p.diveY).toBeGreaterThan(d0 + 0.5);
    // Jump: up to the surface, the lungs fill again.
    p.aimPitch = 0;
    intents[1].move = [0, 0];
    tap(h, Btn.Jump);
    run(sc, 4);
    expect(p.underwater).toBe(false);
    expect(p.diveY).toBeLessThan(0.05);
    expect(p.breath.air).toBeGreaterThan(0.95);
    sc.dispose();
  }, 60000);

  it('holding out of air hurts, but never to the death', () => {
    const h = lake();
    const { sc, p } = h;
    tap(h, Btn.B);
    p.aimPitch = 0;
    run(sc, SWIM.air + 3);
    expect(p.breath.air).toBe(0);
    const hp0 = p.hp;
    run(sc, 6);
    expect(p.hp).toBeLessThan(hp0);
    run(sc, 40);
    expect(p.state).toBe('foot');
    expect(p.hp).toBeGreaterThan(0);
    expect(p.hp).toBeGreaterThanOrEqual(p.maxHp * SWIM.drownFloor - 0.01);
    sc.dispose();
  }, 60000);

  it('a swimmer cannot fire: the gun is slung', () => {
    const h = lake();
    const { sc, intents, p } = h;
    p.equip = 'gun';
    const mag = p.mag;
    intents[1].rt = 1;
    run(sc, 1);
    intents[1].rt = 0;
    expect(p.mag).toBe(mag);
    p.syncVisual(1, DT);
    expect(p.human.swim).toBe(1);
    sc.dispose();
  }, 60000);
});
