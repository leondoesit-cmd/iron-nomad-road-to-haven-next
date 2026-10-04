import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { accessPointsOf } from '../src/render/accessPoints';
import { openPanel, standAt } from './helpers/access';
import { Btn } from '../src/input/intents';
import { installPart, newBuild } from '../src/sim/garage';
import { newPart } from '../src/sim/parts';
import { fakeServices } from './helpers/sim';
import type { Vehicle } from '../src/game/vehicle';

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

describe('access points', () => {
  it('a car has a point for every kind of job, and a wheel at every corner', () => {
    const { sc } = leg();
    const v = ownCar(sc);
    const pts = accessPointsOf(v.def);
    const spots = new Set(pts.map((q) => q.spot));
    for (const s of ['hood', 'doorL', 'doorR', 'trunk', 'flap', 'wheel', 'under', 'roof', 'front', 'rear', 'flank']) expect(spots.has(s as never)).toBe(true);
    expect(pts.filter((q) => q.spot === 'wheel').length).toBe(4);
    // All of them are on or beside the car, not scattered across the map.
    for (const q of pts) {
      const [x, , z] = v.body.toWorld(q.x, q.y, q.z);
      expect(Math.hypot(x - v.position.x, z - v.position.z)).toBeLessThan(v.def.length);
    }
  });
});

describe('the wrench takes parts off by hand', () => {
  it('hold A over a fitted engine: the bonnet comes up first, then the engine comes off into your arms', () => {
    const { h, sc } = leg();
    const v = ownCar(sc, 'sedan');
    const p = sc.players[0];
    installPart(v.build!, newPart('eng_v6', 0.8));
    v.syncFromBuild();
    p.equip = 'wrench';
    standAt(sc, v, 'hood');
    run(sc, 0.2);
    // The bonnet is shut: the first step is to open it.
    expect(p.prompt?.text).toMatch(/Open the bonnet/);
    hold(h, sc, 0, Btn.A, 4);
    expect(v.build!.fit.engine?.id).toBe('eng_v6');
    hold(h, sc, 0, Btn.A, 1);
    expect(v.open.hood).toBe(true);
    run(sc, 1);
    expect(v.swing.hood).toBeGreaterThan(0.95);
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

  it('tyres come off all four wheels as one set, standing at one wheel', () => {
    const { h, sc } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    installPart(v.build!, newPart('whl_mt', 1));
    v.syncFromBuild();
    p.equip = 'wrench';
    standAt(sc, v, 'wheel', 1);
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
    expect(p.prompt?.text).toMatch(/Go to the rear mount/i);
    hold(h, sc, 0, Btn.A, 4);
    expect(p.carry).not.toBeNull();
    expect(v.build!.fit.rear).toBeUndefined();
    standAt(sc, v, 'rear');
    hold(h, sc, 0, Btn.A, 4);
    expect(p.carry).toBeNull();
    expect(v.build!.fit.rear?.id).toBe('rr_box');
  });

  it('swapping an engine in the field: open, off, stow in the boot, the new one on, shut', () => {
    const { h, sc, c } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    installPart(v.build!, newPart('eng_i4', 0.7));
    v.syncFromBuild();
    p.equip = 'wrench';
    openPanel(v, 'hood');
    standAt(sc, v, 'hood');
    hold(h, sc, 0, Btn.A, 5);
    expect(p.carry).toMatchObject({ kind: 'part' });
    // Walk it to the boot, lift the lid, and stow it.
    standAt(sc, v, 'trunk');
    tap(h, sc, 0, Btn.X);
    expect(p.carry).not.toBeNull();
    openPanel(v, 'trunk');
    tap(h, sc, 0, Btn.X);
    expect(p.carry).toBeNull();
    expect(c.inventory.map((i) => i.id)).toEqual(['eng_i4']);
    // Fetch a better one, and fit it at the engine bay.
    p.equip = 'gun';
    p.carry = { kind: 'part', item: newPart('eng_v8', 1) };
    standAt(sc, v, 'hood');
    hold(h, sc, 0, Btn.A, 5);
    expect(v.build!.fit.engine?.id).toBe('eng_v8');
    // Hands free again: hold A at the bonnet to shut it.
    hold(h, sc, 0, Btn.A, 1);
    expect(v.open.hood).toBeFalsy();
  });
});

describe('the boot', () => {
  it('a part stowed on a car rides on that car, and comes out again with X at an open boot', () => {
    const { h, sc, c } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    p.carry = { kind: 'part', item: newPart('whl_bl', 0.8) };
    openPanel(v, 'trunk');
    standAt(sc, v, 'trunk');
    tap(h, sc, 0, Btn.X);
    expect(p.carry).toBeNull();
    expect(c.inventory[0].on).toBe(v.build!.uid);
    run(sc, 1);
    const spots = v.deckSpots();
    expect(spots.filter((s) => s.kind === 'part').map((s) => s.id)).toEqual(['whl_bl']);
    // At the boot, hands empty: the prompt offers to take it out, and X does.
    standAt(sc, v, 'trunk');
    run(sc, 0.2);
    expect(p.promptAlt?.text).toMatch(/Take .* out of the/);
    tap(h, sc, 0, Btn.X);
    expect(p.carry).toMatchObject({ kind: 'part' });
    expect(c.inventory.length).toBe(0);
    run(sc, 1);
    expect(v.deckSpots().filter((s) => s.kind === 'part').length).toBe(0);
  });

  it('a shut boot keeps the part in your arms and tells you to open it', () => {
    const { h, sc, c } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    p.carry = { kind: 'part', item: newPart('whl_bl', 0.8) };
    standAt(sc, v, 'trunk');
    run(sc, 0.2);
    expect(p.prompt?.text).toMatch(/Open the boot|Open the tailgate/);
    tap(h, sc, 0, Btn.X);
    expect(p.carry).not.toBeNull();
    expect(c.inventory.length).toBe(0);
    expect(p.notes.some((n) => /Open the (boot|tailgate)/.test(n.text))).toBe(true);
    // Hold A: the lid opens with the part still in your arms, then X puts it in.
    hold(h, sc, 0, Btn.A, 1);
    expect(v.open.trunk).toBe(true);
    tap(h, sc, 0, Btn.X);
    expect(p.carry).toBeNull();
    expect(c.inventory.length).toBe(1);
  });

  it('spares stowed on the first car do not jump to the second when one is taken off', () => {
    const { h, sc, c } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    openPanel(v, 'trunk');
    standAt(sc, v, 'trunk');
    for (const id of ['arm_sheet', 'whl_mt']) {
      p.carry = { kind: 'part', item: newPart(id, 1) };
      tap(h, sc, 0, Btn.X);
    }
    run(sc, 1);
    expect(v.deckSpots().filter((s) => s.kind === 'part').map((s) => s.id).sort()).toEqual(['arm_sheet', 'whl_mt']);
    expect(c.inventory.every((i) => i.on === v.build!.uid)).toBe(true);
  });
});
