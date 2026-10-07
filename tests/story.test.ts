import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { initPhysics } from '../src/physics/physics';
import { legById, partDef } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { WorldMemory } from '../src/game/worldMemory';
import { STORY_FLAG, setupStoryCampaign } from '../src/game/story';
import { holdTick, lookedAt, restSpot } from '../src/game/grab';
import { Btn, newIntent } from '../src/input/intents';
import { installPart } from '../src/sim/garage';
import { YARD_ITEMS, YARD_NAR, yardWorld } from '../src/world/narYard';
import { fakeServices, run } from './helpers/sim';
import type { Vehicle } from '../src/game/vehicle';

// A real open-world leg in Node: give it room when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 120000 });

beforeAll(async () => {
  await initPhysics();
});

function story() {
  const h = fakeServices({ solo: true });
  setupStoryCampaign(h.campaign);
  const sc = new LegScene(h.svc, legById('W'), { memory: new WorldMemory(), story: true });
  sc.pendingResult = true;
  return { h, sc, c: h.campaign };
}

const trikeOf = (sc: LegScene): Vehicle => sc.vehicles.find((v) => v.build?.chassis === 'trike')!;

/** Hold a button on player 0's intent for `secs`, as the input manager would. */
function hold(h: ReturnType<typeof fakeServices>, sc: LegScene, btn: number, secs: number) {
  const it = h.intents[0];
  it.device = 'keyboard';
  const n = Math.round(secs * 60);
  for (let i = 0; i < n; i++) {
    it.held |= 1 << btn;
    it.pressed = i === 0 ? 1 << btn : 0;
    it.heldTime[btn] += 1 / 60;
    sc.tick(1 / 60);
  }
  it.held &= ~(1 << btn);
  it.pressed = 0;
  it.heldTime[btn] = 0;
  sc.tick(1 / 60);
}

describe('story mode: Nar\'s yard', () => {
  it('starts on foot in the yard with the trike in pieces on its stand and Nar on his mattress', () => {
    const { sc, h } = story();
    const yard = sc.terrain!.yard!;
    expect(yard).toBeTruthy();
    const p = sc.players[0];
    expect(sc.players).toHaveLength(1);
    expect(p.state).toBe('foot');
    // At the foot of Nar's lean-to, beside the garage.
    expect(Math.hypot(p.pos.x - yard.x, p.pos.z - yard.z)).toBeLessThan(12);
    const v = trikeOf(sc);
    expect(v).toBeTruthy();
    expect(v.onStands).toBe(true);
    expect(v.cantStart()).toMatch(/No engine/);
    expect(sc.story?.nar).toBeTruthy();
    // Every part of the trike and the yard's kit lies about.
    const around = sc.loose!.around!(yard.x, yard.z, 14);
    expect(around.length).toBeGreaterThanOrEqual(YARD_ITEMS.length);
    expect(around.some((q) => q.carried.kind === 'part' && q.carried.item.id === 'eng_594')).toBe(true);
    expect(around.some((q) => q.carried.kind === 'food')).toBe(true);
    // The first thing said: is he alive?
    run(sc, 1.5);
    expect(h.radio[0]).toBe('Nar — is he alive?');
    expect(sc.objective?.title).toBe('Check on Nar');
    // The frame stays put on its stand.
    const at = v.position.x;
    run(sc, 2);
    expect(Math.abs(v.position.x - at)).toBeLessThan(0.01);
  });

  it('plays mission one through: check Nar, build the trike, fuel it, help Nar in, drive out', () => {
    const { sc, h, c } = story();
    const yard = sc.terrain!.yard!;
    const p = sc.players[0];
    const v = trikeOf(sc);
    // Check on him.
    const nar = yardWorld(yard, YARD_NAR.x, YARD_NAR.z);
    p.placeAt(nar.x + 0.8, nar.z + 0.8, 0);
    hold(h, sc, Btn.A, 2);
    expect(c.flags[STORY_FLAG.checked]).toBe(true);
    expect(sc.objective?.title).toBe('Build the trike');
    expect(sc.objective?.steps?.every((s) => !s.done)).toBe(true);
    // Bolt every part of it on (the hands-on fit has its own tests; this is the story's bookkeeping).
    const b = v.build!;
    for (const id of ['eng_594', 'tyre_trike', 'tyre_trike_r', 'tyre_trike_r', 'rr_rickshaw']) {
      const q = sc.loose!.around!(yard.x, yard.z, 14).find((o) => o.carried.kind === 'part' && o.carried.item.id === id)!;
      expect(q, id).toBeTruthy();
      const got = sc.loose!.take(q.id)!;
      if (got.kind !== 'part') throw new Error('not a part');
      const r = installPart(b, got.item);
      expect(r.ok, `${id}: ${r.reason}`).toBe(true);
      v.syncFromBuild();
    }
    expect(b.tyres.map((t) => t?.id)).toEqual(['tyre_trike', 'tyre_trike_r', 'tyre_trike_r']);
    run(sc, 0.5);
    expect(v.onStands).toBe(false);
    expect(c.flags[STORY_FLAG.built]).toBe(true);
    // An empty tank: fill it.
    expect(sc.objective?.title).toBe('Fill the tank');
    v.fuel = 3;
    run(sc, 0.3);
    expect(sc.objective?.title).toBe('Help Nar into the cab');
    // Help him in, with the trike close by.
    p.placeAt(nar.x + 0.8, nar.z + 0.8, 0);
    hold(h, sc, Btn.A, 2);
    expect(c.flags[STORY_FLAG.aboard]).toBe(true);
    expect(sc.objective?.title).toBe('Drive out of the yard');
    // Nar now rides in the cab.
    sc.renderFrame(1, 1 / 60);
    expect(sc.story!.nar!.root.parent).toBe(v.visual.inner);
    // Out of the yard: mission one is done.
    v.body.setPose(yard.x - 45, sc.groundAt(yard.x - 45, yard.z) + 1, yard.z, v.yaw);
    run(sc, 0.5);
    expect(c.flags[STORY_FLAG.m1]).toBe(true);
    expect(h.banners.some((s) => s.startsWith('MISSION ONE COMPLETE'))).toBe(true);
  });

  it('only takes each kind of wheel on its own hub', () => {
    const { sc } = story();
    const b = trikeOf(sc).build!;
    const road = { uid: 'x', id: 'whl_road', cond: 1 };
    expect(installPart(b, road).ok).toBe(false);
    expect(installPart(b, { uid: 'y', id: 'tyre_trike_r', cond: 1 }, 0).ok).toBe(false);
    expect(installPart(b, { uid: 'z', id: 'tyre_trike', cond: 1 }, 0).ok).toBe(true);
    expect(partDef('tyre_trike').wheel).toBe('moto');
  });
});

describe('hands-on carrying', () => {
  it('sets what is held down where it is held, and throws it', () => {
    const { sc, h } = story();
    const yard = sc.terrain!.yard!;
    const p = sc.players[0];
    const q = sc.loose!.around!(yard.x, yard.z, 14).find((o) => o.carried.kind === 'food')!;
    p.carry = sc.loose!.take(q.id);
    expect(p.carry?.kind).toBe('food');
    run(sc, 0.2);
    const spot = restSpot(p, p.carry!, p.hold.at);
    expect(spot.kind).toBe('ground');
    // Fire lets go of it: it lies where it was held.
    const it = h.intents[0];
    it.pressed = 1 << Btn.RT;
    holdTick(p, it);
    it.pressed = 0;
    expect(p.carry).toBe(null);
    const placed = sc.loose!.around!(spot.pos.x, spot.pos.z, 0.3);
    expect(placed.some((o) => o.carried.kind === 'food')).toBe(true);
    // Lift it again and throw it with aim: it flies off as a piece and can be lifted once it lies still.
    p.carry = sc.loose!.take(placed.find((o) => o.carried.kind === 'food')!.id);
    const before = sc.debris.pieces.length;
    const it2 = newIntent();
    it2.pressed = 1 << Btn.LT;
    holdTick(p, it2);
    expect(p.carry).toBe(null);
    expect(sc.debris.pieces.length).toBe(before + 1);
  });

  it('the wheel moves it out and in, and swap turns it', () => {
    const { sc } = story();
    const p = sc.players[0];
    p.carry = { kind: 'fuel', amount: 4, fuel: 'petrol' };
    const it = newIntent();
    holdTick(p, it);
    const d0 = p.hold.dist;
    it.toolStep = -1;
    holdTick(p, it);
    expect(p.hold.dist).toBeGreaterThan(d0);
    it.toolStep = 0;
    it.pressed = 1 << Btn.LB;
    holdTick(p, it);
    expect(p.hold.yaw).toBeCloseTo(Math.PI / 4);
  });

  it('snatches a basking lizard and eats it: hunger down, health up', () => {
    const { sc, h } = story();
    const p = sc.players[0];
    // Out on the open flat, clear of Nar and of everything lying in the yard.
    const yard = sc.terrain!.yard!;
    p.placeAt(yard.x - 20, yard.z, -Math.PI / 2);
    const life = sc.life!;
    // A lizard basking just in front of the hands (the test reaches into the private spawner).
    const add = (life as unknown as { add: (k: string, x: number, y: number, z: number, i?: object) => { state: number } }).add.bind(life);
    const fx = p.pos.x + Math.sin(p.aimYaw) * 1.1;
    const fz = p.pos.z + Math.cos(p.aimYaw) * 1.1;
    add('lizard', fx, sc.groundAt(fx, fz), fz, { ref: 0, state: 0, timer: 99 });
    const rnd = Math.random;
    Math.random = () => 0.01;
    try {
      hold(h, sc, Btn.A, 0.5);
    } finally {
      Math.random = rnd;
    }
    expect(p.carry).toEqual({ kind: 'food', food: 'lizard' });
    p.needs.food = 0.5;
    p.hp = 50;
    const it = h.intents[0];
    it.pressed = 1 << Btn.Eat;
    sc.tick(1 / 60);
    it.pressed = 0;
    expect(p.carry).toBe(null);
    expect(p.needs.food).toBeCloseTo(0.57, 2);
    expect(p.hp).toBeGreaterThanOrEqual(52.9);
  });

  it('names what you are looking at', () => {
    const { sc } = story();
    const yard = sc.terrain!.yard!;
    const p = sc.players[0];
    const eng = sc.loose!.around!(yard.x, yard.z, 14).find((o) => o.carried.kind === 'part' && o.carried.item.id === 'eng_594')!;
    // Stand 1.5 m off the engine and look at it, with the view camera on the eyes.
    p.placeAt(eng.x + 1.5, eng.z, -Math.PI / 2);
    const cam = sc.R.views[0].camera as THREE.PerspectiveCamera;
    cam.position.set(p.pos.x, p.pos.y + 1.6, p.pos.z);
    cam.lookAt(eng.x, eng.y + 0.2, eng.z);
    cam.updateMatrixWorld();
    expect(lookedAt(p)?.id).toBe(eng.id);
    run(sc, 1 / 60);
    cam.position.set(p.pos.x, p.pos.y + 1.6, p.pos.z);
    cam.lookAt(eng.x, eng.y + 0.2, eng.z);
    cam.updateMatrixWorld();
    sc.tick(1 / 60);
    expect(p.lookInfo?.lines[0].text).toMatch(/594CC I2 23HP 39NM GASOLINE/);
    expect(p.lookInfo?.lines[1].text).toBe('62 %');
    expect(p.handHints[0].text).toBe('Grab');
  });
});
