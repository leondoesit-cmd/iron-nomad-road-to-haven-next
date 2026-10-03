import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { mountsOf, pickMount } from '../src/game/carwork';
import { Btn } from '../src/input/intents';
import { installPart, newBuild } from '../src/sim/garage';
import { newPart } from '../src/sim/parts';
import { fakeServices } from './helpers/sim';
import type { Vehicle } from '../src/game/vehicle';
import type { PartSlot } from '../src/data';

// Working on a car with your hands: mounts light up, the wrench unbolts what is fitted, spares sit on the deck.
vi.setConfig({ testTimeout: 90000 });

beforeAll(async () => {
  await initPhysics();
});

const DT = 1 / 60;

function leg() {
  const h = fakeServices();
  const sc = new LegScene(h.svc, legById('L1'));
  sc.pendingResult = true;
  return { h, sc, c: h.campaign };
}

/** A page redraws the cars every frame; these tests never render, so pose the meshes by hand. */
function pose(sc: LegScene) {
  for (const v of sc.vehicles) v.syncVisual(1, DT);
}

function run(sc: LegScene, secs: number) {
  for (let i = 0; i < Math.round(secs / DT); i++) {
    sc.tick(DT);
    if (i % 10 === 0) pose(sc);
  }
  pose(sc);
}

function hold(h: ReturnType<typeof fakeServices>, sc: LegScene, who: number, btn: number, secs: number) {
  const it = h.intents[who];
  it.device = 'keyboard';
  for (let i = 0; i < Math.round(secs / DT); i++) {
    it.held |= 1 << btn;
    it.pressed = i === 0 ? 1 << btn : 0;
    it.heldTime[btn] += DT;
    sc.tick(DT);
    if (i % 10 === 0) pose(sc);
  }
  it.held &= ~(1 << btn);
  it.pressed = 0;
  it.released = 1 << btn;
  it.heldTime[btn] = 0;
  sc.tick(DT);
  it.released = 0;
}

function tap(h: ReturnType<typeof fakeServices>, sc: LegScene, who: number, btn: number) {
  const it = h.intents[who];
  it.device = 'keyboard';
  it.held |= 1 << btn;
  it.pressed = 1 << btn;
  sc.tick(DT);
  it.held &= ~(1 << btn);
  it.pressed = 0;
  it.released = 1 << btn;
  sc.tick(DT);
  it.released = 0;
  sc.tick(DT);
}

function ownCar(sc: LegScene, chassis = 'hatch'): Vehicle {
  const p = sc.players[0];
  p.exitVehicle(false);
  const st = sc.src.layout.start;
  const x = st.x + 9;
  const z = st.z + 8;
  const b = newBuild(chassis, { seed: 31, fuel: 0.2 });
  const v = sc.spawnVehicle({ build: b, x, z, y: sc.groundAt(x, z), yaw: 0, ownerIndex: 0, faction: 'convoy' });
  sc.campaign.adopt(b);
  run(sc, 1.5);
  const d = v.doorPos(1);
  p.placeAt(d[0], d[2], v.yaw);
  return v;
}

/** Stand where the hands reach a mount: a little way off it, facing it. */
function standAt(sc: LegScene, v: Vehicle, slot: PartSlot, index = 0) {
  const p = sc.players[0];
  pose(sc);
  const m = mountsOf(v, p.pos).filter((q) => q.slot === slot)[index];
  expect(m).toBeTruthy();
  // Approach from the outside of the car so nothing is in the way.
  const out = new THREE.Vector3(m.pos.x - v.position.x, 0, m.pos.z - v.position.z).normalize();
  p.placeAt(m.pos.x + out.x * 0.7, m.pos.z + out.z * 0.7, Math.atan2(-out.x, -out.z));
  return m;
}

describe('mount points', () => {
  it('a car has a mount for each slot it takes, and a wheel at every corner', () => {
    const { sc } = leg();
    const v = ownCar(sc);
    const ms = mountsOf(v, sc.players[0].pos);
    const slots = new Set(ms.map((m) => m.slot));
    for (const s of ['engine', 'wheels', 'armor', 'rear', 'front']) expect(slots.has(s as PartSlot)).toBe(true);
    expect(ms.filter((m) => m.slot === 'wheels').length).toBe(4);
    // All of them are on or beside the car, not scattered across the map.
    for (const m of ms) expect(Math.hypot(m.pos.x - v.position.x, m.pos.z - v.position.z)).toBeLessThan(v.def.length);
  });

  it('the mount your hands are over is the one picked', () => {
    const { sc } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    standAt(sc, v, 'engine');
    expect(pickMount(p, v)?.mount.slot).toBe('engine');
    expect(pickMount(p, v)?.near).toBe(true);
    standAt(sc, v, 'wheels', 2);
    const pick = pickMount(p, v);
    expect(pick?.mount.slot).toBe('wheels');
    expect(pick?.mount.index).toBe(2);
  });
});

describe('the wrench takes parts off by hand', () => {
  it('hold A over a fitted engine: it comes off the car and into your arms', () => {
    const { h, sc } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    installPart(v.build!, newPart('eng_v6', 0.8));
    v.syncFromBuild();
    p.equip = 'wrench';
    standAt(sc, v, 'engine');
    run(sc, 0.2);
    expect(p.prompt?.text).toMatch(/Unbolt Tuned V6/);
    // Not yet: the hold has to be seen through.
    hold(h, sc, 0, Btn.A, 1);
    expect(v.build!.fit.engine).toBeDefined();
    hold(h, sc, 0, Btn.A, 4);
    expect(v.build!.fit.engine?.id).toBe('eng_none');
    expect(p.carry).toMatchObject({ kind: 'part' });
    expect(p.carry && p.carry.kind === 'part' && p.carry.item.id).toBe('eng_v6');
  });

  it('a stock mount has nothing to unbolt, and the wrench keeps to repairs there', () => {
    const { h, sc } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    p.equip = 'wrench';
    standAt(sc, v, 'roof');
    hold(h, sc, 0, Btn.A, 4);
    expect(p.carry).toBeNull();
  });

  it('tyres come off all four wheels as one set', () => {
    const { h, sc } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    installPart(v.build!, newPart('whl_mt', 1));
    v.syncFromBuild();
    p.equip = 'wrench';
    standAt(sc, v, 'wheels', 1);
    hold(h, sc, 0, Btn.A, 4);
    expect(v.build!.fit.wheels).toBeUndefined();
    expect(p.carry).toMatchObject({ kind: 'part' });
  });

  it('a part carried to the wrong place will not go on, and goes on at its own mount', () => {
    const { h, sc } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    p.carry = { kind: 'part', item: newPart('rr_box') };
    standAt(sc, v, 'front');
    run(sc, 0.1);
    expect(p.prompt?.text).toMatch(/to the rear/i);
    hold(h, sc, 0, Btn.A, 4);
    expect(p.carry).not.toBeNull();
    expect(v.build!.fit.rear).toBeUndefined();
    standAt(sc, v, 'rear');
    hold(h, sc, 0, Btn.A, 4);
    expect(p.carry).toBeNull();
    expect(v.build!.fit.rear?.id).toBe('rr_box');
  });

  it('swapping an engine in the field: off, then the new one on, each at the engine bay', () => {
    const { h, sc, c } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    installPart(v.build!, newPart('eng_i4', 0.7));
    v.syncFromBuild();
    p.equip = 'wrench';
    standAt(sc, v, 'engine');
    hold(h, sc, 0, Btn.A, 5);
    expect(p.carry).toMatchObject({ kind: 'part' });
    // Set the old one on the deck, pick up a better one and fit it.
    tap(h, sc, 0, Btn.X);
    expect(p.carry).toBeNull();
    expect(c.inventory.map((i) => i.id)).toEqual(['eng_i4']);
    p.carry = { kind: 'part', item: newPart('eng_v8', 1) };
    standAt(sc, v, 'engine');
    hold(h, sc, 0, Btn.A, 5);
    expect(v.build!.fit.engine?.id).toBe('eng_v8');
  });
});

describe('the deck', () => {
  it('a part stowed on a car rides on that car, in view, and is lifted off by hand', () => {
    const { h, sc, c } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    p.carry = { kind: 'part', item: newPart('whl_bl', 0.8) };
    tap(h, sc, 0, Btn.X);
    expect(p.carry).toBeNull();
    expect(c.inventory[0].on).toBe(v.build!.uid);
    run(sc, 1);
    const spots = v.deckSpots();
    expect(spots.filter((s) => s.kind === 'part').map((s) => s.id)).toEqual(['whl_bl']);
    // Stand at the spare and take it back.
    const at = spots.find((s) => s.kind === 'part')!.world;
    const out = new THREE.Vector3(at.x - v.position.x, 0, at.z - v.position.z);
    out.y = 0;
    out.normalize();
    p.placeAt(at.x + out.x * 0.7, at.z + out.z * 0.7, Math.atan2(-out.x, -out.z));
    run(sc, 0.2);
    expect(p.prompt?.text).toMatch(/Take .* off the/);
    hold(h, sc, 0, Btn.A, 1.5);
    expect(p.carry).toMatchObject({ kind: 'part' });
    expect(c.inventory.length).toBe(0);
    run(sc, 1);
    expect(v.deckSpots().filter((s) => s.kind === 'part').length).toBe(0);
  });

  it('spares stowed on the first car do not jump to the second when one is taken off', () => {
    const { h, sc, c } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    for (const id of ['arm_sheet', 'whl_mt']) {
      p.carry = { kind: 'part', item: newPart(id, 1) };
      tap(h, sc, 0, Btn.X);
    }
    run(sc, 1);
    expect(v.deckSpots().filter((s) => s.kind === 'part').map((s) => s.id).sort()).toEqual(['arm_sheet', 'whl_mt']);
    expect(c.inventory.every((i) => i.on === v.build!.uid)).toBe(true);
  });
});
