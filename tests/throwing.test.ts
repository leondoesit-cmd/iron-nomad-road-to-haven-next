import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { restSpot } from '../src/game/grab';
import { Btn } from '../src/input/intents';
import { newBuild } from '../src/sim/garage';
import { newPart } from '../src/sim/parts';
import { pieceGeometry } from '../src/render/cargoLoad';
import { bodyMat } from '../src/render/vehicleKit';
import { throwBody, throwCharge, throwCost, throwKg, throwRange, throwSpeed, windTime, type Thrower } from '../src/sim/throwing';
import { fakeServices } from './helpers/sim';
import type { Carried } from '../src/sim/carry';

// Real leg scenes in Node: give them room when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 120000 });

beforeAll(async () => {
  await initPhysics();
});

const DT = 1 / 60;
const FRESH: Thrower = { stamina: 1, winded: false, hp: 1, wounds: 0, pace: 1, crouch: false, wading: 0 };
const BEAT: Thrower = { stamina: 0.05, winded: true, hp: 0.3, wounds: 2, pace: 0.9, crouch: false, wading: 0 };

const OIL: Carried = { kind: 'oil', amount: 0.5 };
const FUEL: Carried = { kind: 'fuel', amount: 5, fuel: 'petrol' };

/** How far a full throw at a level aim carries over flat ground, from chest height. */
const reach = (c: Carried, b: Thrower, held = 5) => {
  const kg = throwKg(c);
  return throwRange(throwSpeed(kg, throwCharge(held, kg, b.winded), throwBody(b)), 0.32, 1.3);
};

describe('throwing rules', () => {
  it('lighter things go further, and an engine barely leaves the hands', () => {
    const oil = reach(OIL, FRESH);
    const fuel = reach(FUEL, FRESH);
    const wheel = reach({ kind: 'part', item: newPart('whl_mt') }, FRESH);
    const engine = reach({ kind: 'part', item: newPart('eng_v6') }, FRESH);
    expect(oil).toBeGreaterThan(fuel);
    expect(fuel).toBeGreaterThan(engine);
    expect(wheel).toBeGreaterThan(engine);
    // Generous, not true: a full jerrycan clears several metres, an oil can more than ten, an engine a step or two.
    expect(fuel).toBeGreaterThan(6);
    expect(oil).toBeGreaterThan(10);
    expect(engine).toBeLessThan(4);
    expect(engine).toBeGreaterThan(0.5);
  });

  it('a tired, hurt body throws much shorter', () => {
    expect(throwBody(BEAT)).toBeLessThan(throwBody(FRESH) * 0.45);
    expect(reach(FUEL, BEAT)).toBeLessThan(reach(FUEL, FRESH) * 0.4);
    // Winded, the wind-up stops halfway.
    expect(throwCharge(10, 18, true)).toBe(0.5);
    // A stim on top of a rested body helps a little; wading to the waist hurts.
    expect(throwBody({ ...FRESH, pace: 1.25 })).toBeGreaterThan(throwBody(FRESH));
    expect(throwBody({ ...FRESH, wading: 0.9 })).toBeLessThan(throwBody(FRESH));
  });

  it('heavier things take longer to wind up and more wind to throw; a tap is a soft toss', () => {
    expect(windTime(throwKg(FUEL))).toBeGreaterThan(windTime(throwKg(OIL)));
    expect(throwCost(throwKg(FUEL), 1)).toBeGreaterThan(throwCost(throwKg(OIL), 1));
    expect(throwCost(200, 1)).toBeLessThanOrEqual(32);
    expect(reach(FUEL, FRESH, 0)).toBeLessThan(reach(FUEL, FRESH) * 0.6);
  });
});

function leg() {
  const h = fakeServices();
  const sc = new LegScene(h.svc, legById('L1'));
  sc.pendingResult = true;
  const p = sc.players[0];
  p.exitVehicle(false);
  return { h, sc, p };
}

function run(sc: LegScene, secs: number) {
  for (let i = 0; i < Math.round(secs / DT); i++) sc.tick(DT);
}

/** Hold the throw button for `secs` and let go, the way the input manager reports it. */
function windAndThrow(h: ReturnType<typeof fakeServices>, sc: LegScene, secs: number) {
  const it = h.intents[0];
  it.device = 'keyboard';
  for (let i = 0; i < Math.max(1, Math.round(secs / DT)); i++) {
    it.held |= 1 << Btn.LT;
    it.pressed = i === 0 ? 1 << Btn.LT : 0;
    it.heldTime[Btn.LT] += DT;
    sc.tick(DT);
  }
  it.held &= ~(1 << Btn.LT);
  it.pressed = 0;
  it.released = 1 << Btn.LT;
  it.releasedAfter[Btn.LT] = it.heldTime[Btn.LT];
  it.heldTime[Btn.LT] = 0;
  sc.tick(DT);
  it.released = 0;
  it.releasedAfter[Btn.LT] = 0;
}

/** Throw `c` from a fixed spot, level, and say how far from the feet it came to rest. */
function throwFrom(c: Carried, secs: number, body?: (p: LegScene['players'][number]) => void): { dist: number; stamina: number } {
  const { h, sc, p } = leg();
  const st = sc.src.layout.start;
  p.placeAt(st.x - 25, st.z - 20, 0);
  run(sc, 0.3);
  body?.(p);
  p.carry = c;
  sc.tick(DT);
  const from = p.pos.clone();
  const before = p.stamina.value;
  windAndThrow(h, sc, secs);
  expect(p.carry).toBeNull();
  const stamina = before - p.stamina.value;
  run(sc, 3);
  const piece = sc.debris.pieces.find((q) => q.tag.startsWith('thrown'));
  expect(piece).toBeTruthy();
  const t = piece!.body.translation();
  return { dist: Math.hypot(t.x - from.x, t.z - from.z), stamina };
}

describe('throwing in the world', () => {
  it('a can flies further than a wheel, a full wind-up further than a tap, and it costs wind', () => {
    const oil = throwFrom(OIL, 1.2);
    const tap = throwFrom(OIL, DT);
    const wheel = throwFrom({ kind: 'part', item: newPart('whl_mt') }, 1.6);
    expect(oil.dist).toBeGreaterThan(8);
    expect(oil.dist).toBeGreaterThan(tap.dist * 1.4);
    expect(oil.dist).toBeGreaterThan(wheel.dist);
    expect(oil.stamina).toBeGreaterThan(2);
    expect(wheel.stamina).toBeGreaterThan(oil.stamina);
  });

  it('out of breath and bleeding, the same can lands much closer', () => {
    const fresh = throwFrom(FUEL, 1.5);
    const beat = throwFrom(FUEL, 1.5, (p) => {
      p.stamina.value = 3;
      p.stamina.winded = true;
      p.hp = 30;
      p.bleed.level = 2;
    });
    expect(beat.dist).toBeLessThan(fresh.dist * 0.6);
  });

  it('what comes to rest on your pickup bed is loaded there', () => {
    const { sc, p } = leg();
    const st = sc.src.layout.start;
    const x = st.x + 9;
    const z = st.z + 8;
    const b = newBuild('pickup', { seed: 31, fuel: 0.2 });
    const v = sc.spawnVehicle({ build: b, x, z, y: sc.groundAt(x, z), yaw: 0, ownerIndex: 0, faction: 'convoy' });
    sc.campaign.adopt(b);
    run(sc, 1.5);
    v.syncVisual(1, DT);
    // Find a point over the bed.
    const c: Carried = { kind: 'oil', amount: 0.5 };
    let over: THREE.Vector3 | null = null;
    for (let lz = -3; lz <= 3 && !over; lz += 0.25) {
      for (let ly = 0.4; ly <= 1.6 && !over; ly += 0.2) {
        const at = new THREE.Vector3(v.position.x, v.position.y + ly, v.position.z + lz);
        const s = restSpot(p, c, at);
        if (s.kind === 'deck' && s.ok && s.zone === 'bed') over = s.pos.clone();
      }
    }
    expect(over).toBeTruthy();
    const n = v.cargoRig.entries.length;
    const geo = pieceGeometry(c);
    geo.computeBoundingBox();
    const bb = geo.boundingBox!;
    sc.debris.spawn({
      geo,
      material: bodyMat,
      pos: over!.clone().add(new THREE.Vector3(0, 0.6, 0)),
      quat: new THREE.Quaternion(),
      vel: new THREE.Vector3(),
      spin: new THREE.Vector3(),
      centre: [(bb.max.x + bb.min.x) / 2, (bb.max.y + bb.min.y) / 2, (bb.max.z + bb.min.z) / 2],
      half: [(bb.max.x - bb.min.x) / 2, (bb.max.y - bb.min.y) / 2, (bb.max.z - bb.min.z) / 2],
      mass: 4,
      carried: c,
      tag: 'thrown',
      armAfter: 0.12,
    });
    // Node never renders: keep the car's visual (which the deck is read from) where its body is.
    for (let i = 0; i < 180; i++) {
      v.syncVisual(1, DT);
      sc.tick(DT);
    }
    expect(v.cargoRig.entries.length).toBe(n + 1);
    expect(sc.debris.pieces.some((q) => q.tag.startsWith('thrown'))).toBe(false);
  });
});
