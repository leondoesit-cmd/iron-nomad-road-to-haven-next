import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { VEHICLES, chassisDef, legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { Btn } from '../src/input/intents';
import { installPart, newBuild, removePart } from '../src/sim/garage';
import { newPart } from '../src/sim/parts';
import { planFit, planStow, FUEL_CAN } from '../src/sim/carry';
import { PANELS, driverDoor, effectiveOpen, gate, needText, panelName, panelStripped, panelsOf, passengerDoor, slotsAt, workFor, type PanelOpen, type Spot } from '../src/sim/access';
import { accessPointsOf } from '../src/render/accessPoints';
import { GarageView, type GarageHost } from '../src/ui/garage';
import { Campaign } from '../src/game/campaign';
import { fakeServices } from './helpers/sim';
import { openPanel, pose, standAt } from './helpers/access';
import { SLAM_SPEED, type Vehicle } from '../src/game/vehicle';

vi.setConfig({ testTimeout: 90000 });

beforeAll(async () => {
  await initPhysics();
});

const DT = 1 / 60;
const CLOSED: PanelOpen = { hood: false, doorL: false, doorR: false, trunk: false };
const OPEN: PanelOpen = { hood: true, doorL: true, doorR: true, trunk: true };

// ------------------------------------------------------------------------------------------------ the rules table

describe('which panels a chassis has', () => {
  it('cars have a bonnet and doors; hatch, sedan and van also have a lid; the rest are always open', () => {
    expect(panelsOf(chassisDef('hatch'))).toEqual(['hood', 'doorL', 'doorR', 'trunk']);
    expect(panelsOf(chassisDef('sedan'))).toEqual(['hood', 'doorL', 'doorR', 'trunk']);
    expect(panelsOf(chassisDef('van'))).toEqual(['hood', 'doorL', 'doorR', 'trunk']);
    // A pickup's bed has no lid.
    expect(panelsOf(chassisDef('pickup'))).toEqual(['hood', 'doorL', 'doorR']);
    expect(panelsOf(chassisDef('buggy'))).toEqual(['hood']);
    for (const id of ['moped', 'quad', 'truck', 'rig']) expect(panelsOf(chassisDef(id))).toEqual([]);
  });

  it('shut by default; missing, stripped and absent panels count as open', () => {
    const hatch = chassisDef('hatch');
    expect(effectiveOpen(hatch, {}, {})).toEqual(CLOSED);
    expect(effectiveOpen(hatch, {}, { hood: true }).hood).toBe(true);
    // The bonnet or a door pulled off, a canvas flap in place of a door.
    expect(effectiveOpen(hatch, { hood: newPart('hood_none') }, {}).hood).toBe(true);
    expect(effectiveOpen(hatch, { doorL: newPart('door_none') }, {}).doorL).toBe(true);
    expect(effectiveOpen(hatch, { doorR: newPart('door_light') }, {}).doorR).toBe(true);
    expect(panelStripped(hatch, { doorR: newPart('door_plate') }, 'doorR')).toBe(false);
    // Torn or shot off.
    expect(effectiveOpen(hatch, {}, {}, { doorL: true }).doorL).toBe(true);
    // A pickup bed and a bike's bonnet are never shut.
    expect(effectiveOpen(chassisDef('pickup'), {}, {}).trunk).toBe(true);
    expect(effectiveOpen(chassisDef('moped'), {}, {}).hood).toBe(true);
  });
});

describe('where each job is done and what must be open', () => {
  const hatch = chassisDef('hatch');
  it('engine, radiator, oil and water: at the bonnet, bonnet open', () => {
    for (const job of ['engine', 'cooling', 'oil', 'water'] as const) {
      const w = workFor(hatch, job)!;
      expect(w.at).toEqual(['hood']);
      expect(w.open).toBe(true);
      expect(gate(hatch, job, 'hood', CLOSED)).toEqual({ ok: false, need: { kind: 'open', panel: 'hood' } });
      expect(gate(hatch, job, 'hood', { ...CLOSED, hood: true }).ok).toBe(true);
      expect(gate(hatch, job, 'trunk', OPEN).need).toEqual({ kind: 'go', spots: ['hood'] });
      expect(gate(hatch, job, null, OPEN).ok).toBe(false);
    }
  });

  it('fuel: at the flap, and nothing has to be open', () => {
    expect(gate(hatch, 'fuel', 'flap', CLOSED).ok).toBe(true);
    expect(gate(hatch, 'fuel', 'hood', OPEN).ok).toBe(false);
  });

  it('tyres, springs and brakes at a wheel; gearbox and exhaust underneath', () => {
    for (const s of ['wheels', 'suspension', 'brakes'] as const) expect(workFor(hatch, s)!.at).toEqual(['wheel']);
    for (const s of ['gearbox', 'exhaust'] as const) expect(workFor(hatch, s)!.at).toEqual(['under']);
    expect(gate(hatch, 'wheels', 'wheel', CLOSED).ok).toBe(true);
  });

  it('the bonnet and doors come off at their own panel, shut or open, and are not swapped in place', () => {
    expect(workFor(hatch, 'hood')).toEqual({ at: ['hood'], open: false, swap: false });
    expect(gate(hatch, 'doorL', 'doorL', CLOSED).ok).toBe(true);
    expect(gate(hatch, 'doorL', 'doorR', CLOSED).ok).toBe(false);
  });

  it('the cabin is reached through the door on its side, open; the rear seat through either', () => {
    const drv = driverDoor(hatch);
    const pas = passengerDoor(hatch);
    expect(drv).not.toBe(pas);
    for (const s of ['seatD', 'steer', 'dash'] as const) expect(workFor(hatch, s)!.at).toEqual([drv]);
    expect(workFor(hatch, 'seatP')!.at).toEqual([pas]);
    expect([...workFor(hatch, 'seatR')!.at].sort()).toEqual(['doorL', 'doorR']);
    expect(gate(hatch, 'seatP', pas, CLOSED).need).toEqual({ kind: 'open', panel: pas });
    expect(gate(hatch, 'seatP', pas, { ...CLOSED, [pas as string]: true }).ok).toBe(true);
    // The pickup has no rear seat to reach.
    expect(workFor(chassisDef('pickup'), 'seatR')).toBeNull();
  });

  it('stowing: the boot with its lid up, or the back seat through an open door; a pickup stows behind the seats (the bed is an open surface)', () => {
    expect([...workFor(hatch, 'stow')!.at].sort()).toEqual(['doorL', 'doorR', 'trunk']);
    expect(gate(hatch, 'stow', 'trunk', CLOSED).need).toEqual({ kind: 'open', panel: 'trunk' });
    expect(gate(hatch, 'stow', 'doorL', { ...CLOSED, doorL: true }).ok).toBe(true);
    const pickup = chassisDef('pickup');
    expect([...workFor(pickup, 'stow')!.at].sort()).toEqual(['doorL', 'doorR']);
    expect(gate(pickup, 'stow', 'doorL', { ...CLOSED, doorL: true }).ok).toBe(true);
    expect(gate(pickup, 'stow', 'doorL', CLOSED).need).toEqual({ kind: 'open', panel: 'doorL' });
  });

  it('bolt-ons outside need only proximity', () => {
    for (const [slot, spot] of [['roof', 'roof'], ['front', 'front'], ['rear', 'rear'], ['armor', 'flank'], ['weapon', 'gun']] as const) {
      expect(gate(hatch, slot, spot, CLOSED).ok).toBe(true);
    }
  });

  it('slotsAt says what is worked on at a point', () => {
    expect([...slotsAt(hatch, 'hood')].sort()).toEqual(['cooling', 'engine', 'hood']);
    expect([...slotsAt(hatch, 'under')].sort()).toEqual(['exhaust', 'gearbox']);
    // A mount the chassis lacks is not listed.
    expect(workFor(chassisDef('moped'), 'roof')).toBeNull();
  });

  it('prompts name where to go and what to open first', () => {
    const t = needText(hatch, { kind: 'go', spots: ['flap'] }, 'pour the fuel in');
    expect(t).toMatch(/^Go to the fuel flap at the back/);
    expect(t).toMatch(/pour the fuel in$/);
    expect(needText(hatch, { kind: 'open', panel: 'hood' })).toBe('Open the bonnet first');
    expect(needText(hatch, { kind: 'free', panel: 'doorL' })).toMatch(/Take the old .*door off first/);
    expect(panelName(chassisDef('van'), 'trunk')).toBe('rear doors');
    expect(panelName(hatch, 'trunk')).toBe('tailgate');
    expect(panelName(chassisDef('sedan'), 'trunk')).toBe('boot');
  });
});

describe('fits and stows report what is blocking them', () => {
  const hatch = chassisDef('hatch');
  const target = (access: { at: Spot | null; open: PanelOpen; mount?: 'doorL' }) => ({ def: hatch, fitted: () => undefined, fuel: 1, tankMax: 10, oil: 0.5, access });

  it('an engine cannot go in with the bonnet shut, and the plan says to open it', () => {
    const c = { kind: 'part' as const, item: newPart('eng_v6') };
    const shut = planFit(c, target({ at: 'hood', open: CLOSED }));
    expect(shut.ok).toBe(false);
    expect(shut.need).toEqual({ kind: 'open', panel: 'hood' });
    expect(shut.label).toBe('Open the bonnet first');
    expect(planFit(c, target({ at: 'hood', open: { ...CLOSED, hood: true } })).ok).toBe(true);
    const away = planFit(c, target({ at: 'trunk', open: OPEN }));
    expect(away.need?.kind).toBe('go');
    expect(away.label).toMatch(/Go to the engine bay at the front to fit/);
  });

  it('fuel is poured at the flap only; oil and water at the bonnet when it is open', () => {
    const fuel = { kind: 'fuel' as const, amount: FUEL_CAN };
    expect(planFit(fuel, target({ at: 'hood', open: OPEN })).ok).toBe(false);
    expect(planFit(fuel, target({ at: 'flap', open: CLOSED })).ok).toBe(true);
    const oil = { kind: 'oil' as const, amount: 0.5 };
    expect(planFit(oil, target({ at: 'hood', open: CLOSED })).need).toEqual({ kind: 'open', panel: 'hood' });
    expect(planFit(oil, target({ at: 'hood', open: { ...CLOSED, hood: true } })).ok).toBe(true);
  });

  it('a door is not fitted over the one hanging there; it goes where the mount is empty', () => {
    const door = { kind: 'part' as const, item: newPart('door_plate') };
    const hung = { ...target({ at: 'doorL', open: CLOSED, mount: 'doorL' }), fitted: () => ({ id: 'door_std' }) };
    const p1 = planFit(door, hung);
    expect(p1.ok).toBe(false);
    expect(p1.need).toEqual({ kind: 'free', panel: 'doorL' });
    const bare = { ...hung, fitted: () => ({ id: 'door_none' }) };
    expect(planFit(door, bare).ok).toBe(true);
  });

  it('stowing needs the boot open, or an open back door', () => {
    const c = { kind: 'part' as const, item: newPart('whl_mt') };
    const room = { parts: 3, oil: 1 };
    expect(planStow(c, room).ok).toBe(true);
    expect(planStow(c, room, { def: hatch, at: 'trunk', open: CLOSED }).need).toEqual({ kind: 'open', panel: 'trunk' });
    expect(planStow(c, room, { def: hatch, at: 'trunk', open: { ...CLOSED, trunk: true } }).ok).toBe(true);
    expect(planStow(c, room, { def: hatch, at: 'hood', open: OPEN }).need?.kind).toBe('go');
  });
});

describe('access points exist on every chassis', () => {
  const defs = [...VEHICLES.tiers, ...VEHICLES.cars];
  it.each(defs.map((d) => d.id))('%s has an engine, a boot, a flap, the underbody and a point per wheel', (id) => {
    const def = chassisDef(id);
    const pts = accessPointsOf(def);
    const spots = pts.map((q) => q.spot);
    for (const s of ['hood', 'trunk', 'flap', 'under', 'front', 'rear', 'flank']) expect(spots).toContain(s);
    expect(pts.filter((q) => q.spot === 'wheel').length).toBe(def.physics.wheelCount);
    for (const q of pts) {
      expect(Number.isFinite(q.x + q.y + q.z)).toBe(true);
      expect(Math.abs(q.x)).toBeLessThan(def.width + 0.5);
      expect(Math.abs(q.z)).toBeLessThan(def.length);
    }
    // A cabin, and so doors to reach it, only where there are seats to fit.
    expect(spots.includes('doorL')).toBe((def.slots ?? []).some((s) => ['seatD', 'seatP', 'seatR'].includes(s)));
    // Every job of the table has a point of its own kind.
    for (const s of def.slots ?? []) {
      const w = workFor(def, s);
      expect(w).toBeTruthy();
      expect(w!.at.some((spot) => spots.includes(spot))).toBe(true);
    }
    for (const chore of ['fuel', 'oil', 'water', 'stow'] as const) expect(workFor(def, chore)!.at.some((spot) => spots.includes(spot))).toBe(true);
  });

  it('the wheel points are beside the wheels, left and right', () => {
    const wheels = accessPointsOf(chassisDef('sedan')).filter((q) => q.spot === 'wheel');
    expect(wheels.filter((q) => q.x > 0).length).toBe(2);
    expect(wheels.filter((q) => q.x < 0).length).toBe(2);
    const doorL = accessPointsOf(chassisDef('sedan')).find((q) => q.spot === 'doorL')!;
    expect(doorL.x).toBeGreaterThan(0.8);
  });
});

// ------------------------------------------------------------------------------------------------ in a real scene

function leg() {
  const h = fakeServices();
  const sc = new LegScene(h.svc, legById('L1'));
  sc.pendingResult = true;
  return { h, sc, c: h.campaign };
}

function run(sc: LegScene, secs: number) {
  for (let i = 0; i < Math.round(secs / DT); i++) {
    sc.tick(DT);
    pose(sc);
  }
}

function hold(h: ReturnType<typeof fakeServices>, sc: LegScene, btn: number, secs: number) {
  const it = h.intents[0];
  it.device = 'keyboard';
  for (let i = 0; i < Math.round(secs / DT); i++) {
    it.held |= 1 << btn;
    it.pressed = i === 0 ? 1 << btn : 0;
    it.heldTime[btn] += DT;
    sc.tick(DT);
    pose(sc);
  }
  it.held &= ~(1 << btn);
  it.pressed = 0;
  it.released = 1 << btn;
  it.heldTime[btn] = 0;
  sc.tick(DT);
  it.released = 0;
  pose(sc);
}

function tap(h: ReturnType<typeof fakeServices>, sc: LegScene, btn: number) {
  const it = h.intents[0];
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

let nextX = 9;

function ownCar(sc: LegScene, chassis = 'hatch', fit?: (v: Vehicle) => void): Vehicle {
  const p = sc.players[0];
  p.exitVehicle(false);
  const st = sc.src.layout.start;
  const x = st.x + nextX;
  nextX += 9;
  const z = st.z + 8;
  const b = newBuild(chassis, { seed: 31, fuel: 0.2 });
  const v = sc.spawnVehicle({ build: b, x, z, y: sc.groundAt(x, z), yaw: 0, ownerIndex: 0, faction: 'convoy' });
  sc.campaign.adopt(b);
  run(sc, 1.5);
  fit?.(v);
  const d = v.doorPos(1);
  p.placeAt(d[0], d[2], v.yaw);
  return v;
}

describe('opening and closing panels by hand', () => {
  it('hold A at the bonnet opens it with an animation, again shuts it', () => {
    const { h, sc } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    p.equip = 'gun';
    standAt(sc, v, 'hood');
    run(sc, 0.2);
    expect(p.prompt?.text).toBe('Open the bonnet');
    expect(v.panelOpen().hood).toBe(false);
    hold(h, sc, Btn.A, 0.2);
    expect(v.open.hood).toBeFalsy();
    hold(h, sc, Btn.A, 0.8);
    expect(v.open.hood).toBe(true);
    // The animation runs on a transform: the hood leaves the shell as a mesh on a hinge, then comes back.
    expect(v.swing.hood).toBeLessThan(1);
    run(sc, 1);
    expect(v.swing.hood).toBeGreaterThan(0.95);
    expect(v.panelOpen().hood).toBe(true);
    expect(p.prompt?.text).toBe('Close the bonnet');
    expect(v.visual.bay?.visible).toBe(true);
    hold(h, sc, Btn.A, 0.8);
    run(sc, 1);
    expect(v.open.hood).toBeFalsy();
    expect(v.swing.hood).toBe(0);
    expect(v.visual.bay?.visible).toBe(false);
  });

  it('doors and the boot open at their own point, and not from the wrong place', () => {
    const { h, sc } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    p.equip = 'gun';
    standAt(sc, v, 'doorL');
    hold(h, sc, Btn.A, 0.8);
    expect(v.open.doorL).toBe(true);
    expect(v.open.doorR).toBeFalsy();
    standAt(sc, v, 'trunk');
    hold(h, sc, Btn.A, 0.8);
    expect(v.open.trunk).toBe(true);
    // Far from any panel: nothing to open.
    p.placeAt(v.position.x + 6, v.position.z, 0);
    run(sc, 0.2);
    expect(p.prompt?.text ?? '').not.toMatch(/Open|Close/);
  });

  it('opening a panel is a little noisy', () => {
    const { sc } = leg();
    const v = ownCar(sc);
    const calls: number[] = [];
    const sig = sc.sig as unknown as { emit: (...a: unknown[]) => unknown };
    const emit = sig.emit.bind(sig);
    sig.emit = (...a: unknown[]) => {
      if (a[2] === 4) calls.push(a[2] as number);
      return emit(...a);
    };
    v.setPanel('hood', true);
    expect(calls.length).toBe(1);
  });

  it('a car at speed slams its panels shut', () => {
    const { sc } = leg();
    const v = ownCar(sc);
    openPanel(v, 'hood');
    openPanel(v, 'doorL');
    v.body.body.setLinvel({ x: 0, y: 0, z: SLAM_SPEED + 3 }, true);
    run(sc, 0.3);
    expect(v.open.hood).toBeFalsy();
    expect(v.open.doorL).toBeFalsy();
  });

  it('climbing in closes the door behind you', () => {
    const { sc } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    openPanel(v, 'doorL');
    standAt(sc, v, 'doorL');
    expect(p.tryEnter()).toBe(true);
    run(sc, 1);
    expect(p.vehicle).toBe(v);
    expect(v.open.doorL).toBeFalsy();
  });

  it('a torn-off door counts as open, and a missing bonnet needs no opening', () => {
    const { h, sc } = leg();
    const v = ownCar(sc);
    expect(v.panelOpen().doorL).toBe(false);
    v.bodywork.strainPart('door:1', 5);
    expect(v.panelOpen().doorL).toBe(true);
    expect(v.hasPanel('doorL')).toBe(false);
    // A bonnet that has been pulled off: the engine is reached with nothing to open.
    const w = ownCar(sc, 'hatch', (c) => {
      removePart(c.build!, 'hood');
      installPart(c.build!, newPart('eng_v6', 0.8));
      c.syncFromBuild();
    });
    expect(w.panelOpen().hood).toBe(true);
    const p = sc.players[0];
    p.equip = 'wrench';
    standAt(sc, w, 'hood');
    hold(h, sc, Btn.A, 5);
    expect(p.carry).toMatchObject({ kind: 'part' });
  });

  it('a pickup bed and a bike are always open; a buggy has only a bonnet', () => {
    const { sc } = leg();
    const pick = ownCar(sc, 'pickup');
    expect(pick.panelOpen().trunk).toBe(true);
    expect(pick.setPanel('trunk', true)).toBe(false);
    const moped = ownCar(sc, 'moped');
    expect(moped.panelOpen()).toEqual(OPEN);
    expect(PANELS.some((q) => moped.hasPanel(q))).toBe(false);
    const buggy = ownCar(sc, 'buggy');
    expect(buggy.hasPanel('hood')).toBe(true);
    expect(buggy.hasPanel('doorL')).toBe(false);
  });
});

describe('the order of work, in a scene', () => {
  it('an engine cannot be fitted with the bonnet shut: A opens it first, then fits, then it can be shut', () => {
    const { h, sc } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    installPart(v.build!, newPart('eng_i4', 0.5));
    v.syncFromBuild();
    p.carry = { kind: 'part', item: newPart('eng_v6', 0.9) };
    standAt(sc, v, 'hood');
    run(sc, 0.2);
    expect(p.prompt?.text).toMatch(/^Open the bonnet/);
    hold(h, sc, Btn.A, 5);
    // The hold opened the bonnet and stopped there: still the old engine, the new one still in the arms.
    expect(v.build!.fit.engine?.id).toBe('eng_i4');
    expect(v.open.hood).toBe(true);
    expect(p.carry).not.toBeNull();
    run(sc, 1);
    expect(p.prompt?.text).toMatch(/Swap in/);
    hold(h, sc, Btn.A, 5);
    expect(v.build!.fit.engine?.id).toBe('eng_v6');
    expect(p.carry).toBeNull();
    // Hands free: shut the bonnet.
    hold(h, sc, Btn.A, 0.8);
    expect(v.open.hood).toBeFalsy();
  });

  it('standing at the wrong place gives guidance and does nothing', () => {
    const { h, sc } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    openPanel(v, 'hood');
    openPanel(v, 'trunk');
    p.carry = { kind: 'part', item: newPart('eng_v6', 0.9) };
    standAt(sc, v, 'trunk');
    run(sc, 0.2);
    expect(p.prompt?.text).toMatch(/Go to the engine bay at the front to fit/);
    hold(h, sc, Btn.A, 5);
    expect(v.build!.fit.engine?.id).not.toBe('eng_v6');
    // From a wheel too, even though it is beside the car.
    standAt(sc, v, 'wheel', 2);
    run(sc, 0.2);
    expect(p.prompt?.text).toMatch(/Go to the engine bay/);
  });

  it('fuel goes in at the flap only', () => {
    const { h, sc } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    v.fuel = 1;
    p.carry = { kind: 'fuel', amount: FUEL_CAN };
    standAt(sc, v, 'hood');
    openPanel(v, 'hood');
    run(sc, 0.2);
    expect(p.prompt?.text).toMatch(/Go to the fuel flap at the back/);
    hold(h, sc, Btn.A, 4);
    expect(v.fuel).toBeCloseTo(1, 3);
    standAt(sc, v, 'flap');
    run(sc, 0.2);
    expect(p.prompt?.text).toMatch(/Pour petrol/);
    hold(h, sc, Btn.A, 4);
    expect(v.fuel).toBeGreaterThan(3);
  });

  it('the jerrycan refuels at the flap, tops the oil at an open bonnet and says where to go otherwise', () => {
    const { h, sc, c } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    p.equip = 'jerrycan';
    c.stocks.fuel = 20;
    c.items.oil = 1;
    v.fuel = 1;
    v.health.comp.oil = 0.1;
    standAt(sc, v, 'doorL');
    run(sc, 0.2);
    expect(p.prompt?.text).toMatch(/^Go to the engine bay/);
    standAt(sc, v, 'hood');
    run(sc, 0.2);
    expect(p.prompt?.text).toMatch(/^Open the bonnet/);
    hold(h, sc, Btn.A, 1);
    run(sc, 0.6);
    hold(h, sc, Btn.A, 3);
    expect(v.health.comp.oil).toBeGreaterThan(0.5);
    v.health.comp.oil = 1;
    standAt(sc, v, 'flap');
    hold(h, sc, Btn.A, 5);
    expect(v.fuel).toBeGreaterThan(5);
  });

  it('the back seat is reached through an open door: stowing there works only with it open', () => {
    const { h, sc, c } = leg();
    const v = ownCar(sc, 'sedan');
    const p = sc.players[0];
    p.carry = { kind: 'part', item: newPart('eng_v6', 0.8) };
    standAt(sc, v, 'doorR');
    tap(h, sc, Btn.X);
    // At the door but it is shut: the part stays in the arms (A would open the door).
    expect(p.carry).not.toBeNull();
    expect(c.inventory.length).toBe(0);
    run(sc, 0.2);
    expect(p.prompt?.text).toMatch(/^Open the (passenger|driver)/);
    openPanel(v, 'doorR');
    tap(h, sc, Btn.X);
    expect(p.carry).toBeNull();
    expect(c.inventory.length).toBe(1);
  });

  it('a seat is fitted through the open door on its side', () => {
    const { h, sc } = leg();
    const v = ownCar(sc, 'sedan', (c) => {
      installPart(c.build!, newPart('seat_none'), 'seatP');
      c.syncFromBuild();
    });
    const p = sc.players[0];
    p.carry = { kind: 'part', item: newPart('seat_std') };
    const door = passengerDoor(v.def);
    standAt(sc, v, door);
    run(sc, 0.2);
    expect(p.prompt?.text).toMatch(/^Open the/);
    openPanel(v, door as 'doorL' | 'doorR');
    hold(h, sc, Btn.A, 4);
    expect(p.carry).toBeNull();
    expect(v.build!.fit.seatP?.id).toBe('seat_std');
  });

  it('spraying works on a shut or an open door, but not where it has been taken off', () => {
    const { sc } = leg();
    const v = ownCar(sc);
    const p = sc.players[0];
    p.carry = { kind: 'paint', color: 0x336699, charges: 6 };
    standAt(sc, v, 'doorL');
    run(sc, 0.2);
    expect(p.prompt?.text).toMatch(/Spray the (left )?door/i);
    openPanel(v, 'doorL');
    run(sc, 0.2);
    expect(p.prompt?.text).toMatch(/Spray the (left )?door/i);
    v.bodywork.strainPart('door:1', 5);
    run(sc, 0.2);
    expect(p.prompt?.text).toMatch(/no .*door to spray/i);
  });

  it('the field workbench keeps to paint and oil: no fitting, and oil only with the bonnet up', () => {
    const c = new Campaign(undefined, false);
    const b = newBuild('hatch', { seed: 3 });
    b.comp.oil = 0.2;
    c.garage.push(b);
    c.players[0].vehicle = b.uid;
    c.items.oil = 1;
    let blocked: string | null = 'Open the bonnet first';
    const h: GarageHost = {
      c,
      mode: 'field',
      players: [0],
      build: (i) => c.buildOf(i),
      btn: (id, label, _act, enabled = true, title = '') => `<button data-fid="${id}" ${enabled ? '' : 'disabled'} title="${title}">${label}</button>`,
      refresh: () => {},
      rerender: () => {},
      say: () => {},
      gate: (what) => (what === 'fit' ? 'Fit parts at the car' : blocked),
    };
    const view = new GarageView(h);
    expect(view.html()).toMatch(/<button data-fid="oil0" disabled title="Open the bonnet first"/);
    view.sel = { i: 0, slot: 'engine' };
    expect(view.html()).toMatch(/data-fid="rm0" disabled/);
    blocked = null;
    expect(view.html()).toMatch(/<button data-fid="oil0"  title=""/);
  });
});

describe('panels survive the vehicle being put away', () => {
  it('open panels are kept in the build, so streaming a car out and in, and the save file, keep them', () => {
    const { sc } = leg();
    const v = ownCar(sc);
    v.open.hood = true;
    v.open.trunk = true;
    v.commit();
    expect(v.build!.body?.open).toEqual(['hood', 'trunk']);
    // The build as the save file holds it, brought back as a new vehicle.
    const saved = JSON.parse(JSON.stringify(v.build));
    const st = sc.src.layout.start;
    const w = sc.spawnVehicle({ build: saved, x: st.x + 80, z: st.z + 8, y: sc.groundAt(st.x + 80, st.z + 8), yaw: 0, ownerIndex: 0, faction: 'convoy' });
    run(sc, 0.5);
    expect(w.open.hood).toBe(true);
    expect(w.open.trunk).toBe(true);
    expect(w.open.doorL).toBeFalsy();
    // Already swung open, not animating from shut.
    expect(w.swing.hood).toBe(1);
    // Shut again: nothing is kept, so the save of a tidy car is as it was.
    w.open = {};
    w.commit();
    expect(w.build!.body?.open).toBeUndefined();
  });

  it('old saves have no open panels and load with everything shut', () => {
    const { sc } = leg();
    const b = newBuild('sedan', { seed: 5 });
    expect(b.body).toBeUndefined();
    const st = sc.src.layout.start;
    const v = sc.spawnVehicle({ build: b, x: st.x + 100, z: st.z + 8, y: sc.groundAt(st.x + 100, st.z + 8), yaw: 0, ownerIndex: 0, faction: 'convoy' });
    expect(v.panelOpen()).toEqual(CLOSED);
  });

  it('a panel torn off while open is forgotten, so it comes back shut when it is welded on', () => {
    const { sc } = leg();
    const v = ownCar(sc);
    v.open.doorR = true;
    v.swing.doorR = 1;
    v.bodywork.strainPart('door:-1', 5);
    expect(v.open.doorR).toBeFalsy();
    expect(v.bodywork.restoreOne()).toBeTruthy();
    expect(v.panelOpen().doorR).toBe(false);
  });
});

describe('vehicles nobody works on are untouched', () => {
  it('a raider buggy and the crew have no panels to open', () => {
    const { sc } = leg();
    for (const v of sc.vehicles) {
      if (v.faction === 'convoy' && v.build) continue;
      expect(v.setPanel('hood', true)).toBe(false);
      expect(v.open).toEqual({});
    }
  });
});
