import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { Btn } from '../src/input/intents';
import { installPart, newBuild, removePart } from '../src/sim/garage';
import { newPart } from '../src/sim/parts';
import { FUEL_CAN } from '../src/sim/carry';
import { T_OVERHEAT } from '../src/sim/thermal';
import { socketFor, socketsOf } from '../src/render/sockets';
import { CHASSIS, chassisDef } from '../src/data';
import { fakeServices } from './helpers/sim';
import { openPanel, standAt } from './helpers/access';
import type { Vehicle } from '../src/game/vehicle';
import type { Pilot } from '../src/game/vehicle';

// Real leg scenes in Node: engine swaps, fuels and heat as the player meets them.
vi.setConfig({ testTimeout: 120000 });

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

function run(sc: LegScene, secs: number) {
  for (let i = 0; i < Math.round(secs / DT); i++) sc.tick(DT);
}

function hold(h: ReturnType<typeof fakeServices>, sc: LegScene, who: number, btn: number, secs: number) {
  const it = h.intents[who];
  it.device = 'keyboard';
  for (let i = 0; i < Math.round(secs / DT); i++) {
    it.held |= 1 << btn;
    it.pressed = i === 0 ? 1 << btn : 0;
    it.heldTime[btn] += DT;
    sc.tick(DT);
  }
  it.held &= ~(1 << btn);
  it.pressed = 0;
  it.released = 1 << btn;
  it.heldTime[btn] = 0;
  sc.tick(DT);
  it.released = 0;
}

/** One of the convoy's own vehicles, parked still, with player 0 on foot beside its door. */
function ownCar(sc: LegScene, chassis = 'hatch', o: { fuel?: number } = {}): Vehicle {
  const p = sc.players[0];
  p.exitVehicle(false);
  const st = sc.src.layout.start;
  const x = st.x + 9;
  const z = st.z + 8;
  const b = newBuild(chassis, { seed: 31, fuel: o.fuel ?? 0.5 });
  const v = sc.spawnVehicle({ build: b, x, z, y: sc.groundAt(x, z), yaw: 0, ownerIndex: 0, faction: 'convoy' });
  sc.campaign.adopt(b);
  run(sc, 1.5);
  const d = v.doorPos(1);
  p.placeAt(d[0], d[2], v.yaw);
  return v;
}

/** An AI pilot who holds the throttle flat, so a vehicle works as hard as it can. */
const FLAT_OUT: Pilot = { isPlayer: false, index: 0, drive: () => ({ steer: 0, throttle: 1, brake: 0, handbrake: false }) };

describe('attach points: stand where the part goes', () => {
  it('far from the engine bay the prompt says to walk there, and holding A does nothing', () => {
    const { h, sc } = leg();
    const v = ownCar(sc, 'van');
    const p = sc.players[0];
    // Behind the van: close to the vehicle, but nowhere near the bonnet.
    const [bx, , bz] = v.body.toWorld(0, 0, -v.def.length / 2 - 1.5);
    p.placeAt(bx, bz, 0);
    p.carry = { kind: 'part', item: newPart('eng_v6') };
    hold(h, sc, 0, Btn.A, 5);
    expect(p.carry).not.toBeNull();
    expect(v.build!.fit.engine).toBeUndefined();
    expect(p.prompt?.text).toMatch(/Go to the engine bay at the front/);
  });

  it('at the bonnet it fits, with the factory engine going to the trunk as a real part', () => {
    const { h, sc, c } = leg();
    const v = ownCar(sc, 'van');
    const p = sc.players[0];
    openPanel(v, 'hood');
    standAt(sc, v, 'hood');
    p.carry = { kind: 'part', item: newPart('eng_i4', 0.9) };
    hold(h, sc, 0, Btn.A, 5);
    expect(p.carry).toBeNull();
    expect(v.build!.fit.engine?.id).toBe('eng_i4');
    expect(c.inventory.map((i) => i.id)).toContain('eng_d30');
    // A petrol engine in a diesel van: it says so, and the tank is still diesel.
    expect(v.stats.fuel).toBe('petrol');
    expect(v.fuelType).toBe('diesel');
    expect(p.notes.some((n) => /Wrong fuel/.test(n.text) || /drain the tank/.test(n.text))).toBe(true);
  });

  it('carrying a part near its socket shows the outline; it turns to aimed in reach', () => {
    const { sc } = leg();
    const v = ownCar(sc, 'sedan');
    const p = sc.players[0];
    p.carry = { kind: 'part', item: newPart('rad_race_m') };
    // From the middle of the road a few metres off: white.
    const [fx, , fz] = v.body.toWorld(7, 0, 0);
    p.placeAt(fx, fz, 0);
    run(sc, 0.2);
    expect(sc.work.ghostState(`g${p.index}`)).toBe('idle');
    standAt(sc, v, 'hood');
    run(sc, 0.2);
    // The bonnet is shut: the place is right but the job is not yet.
    expect(sc.work.ghostState(`g${p.index}`)).toBe('blocked');
    openPanel(v, 'hood');
    run(sc, 0.2);
    expect(sc.work.ghostState(`g${p.index}`)).toBe('aimed');
    // Put it down: the outline stops being refreshed and fades with the next frames.
    p.carry = null;
    for (let i = 0; i < 40; i++) {
      sc.tick(DT);
      sc.work.update(DT);
    }
    expect(sc.work.ghostCount).toBe(0);
  });
});

describe('every chassis has a socket for every slot it accepts', () => {
  it('and each one is a sensible box on the vehicle', () => {
    for (const id of Object.keys(CHASSIS)) {
      const def = chassisDef(id);
      const socks = socketsOf(def);
      expect(socks.map((s) => s.slot).sort()).toEqual([...(def.slots ?? [])].sort());
      for (const s of socks) {
        expect(s.anchors.length).toBeGreaterThan(0);
        for (const a of s.anchors) {
          expect(Math.abs(a.x)).toBeLessThan(def.width / 2 + 0.6);
          expect(Math.abs(a.z)).toBeLessThan(def.length / 2 + 0.8);
          expect(a.y).toBeGreaterThan(-def.physics.wheelRadius * 2.5);
          expect(a.y).toBeLessThan(3.2);
          expect(Math.min(a.sx, a.sy, a.sz)).toBeGreaterThan(0.05);
        }
      }
    }
  });
  it('wheels have one anchor per wheel, doors one per side', () => {
    expect(socketFor(chassisDef('sedan'), 'wheels')!.anchors).toHaveLength(4);
    expect(socketFor(chassisDef('moped'), 'wheels')!.anchors).toHaveLength(2);
    expect(socketFor(chassisDef('sedan'), 'armor')!.anchors).toHaveLength(2);
    expect(socketFor(chassisDef('moped'), 'roof')).toBeUndefined();
  });
});

describe('petrol and diesel on the road', () => {
  it('a wrong-fuel tank will not start; the jerrycan drains it into the right reserve; then the right fuel runs it', () => {
    const { h, sc, c } = leg();
    const v = ownCar(sc, 'van', { fuel: 0.6 });
    installPart(v.build!, newPart('eng_i4', 1));
    v.syncFromBuild();
    expect(v.fuelType).toBe('diesel');
    v.setEngine(true);
    expect(v.engineOn).toBe(false);
    expect(v.startFail).toMatch(/Wrong fuel/);
    // Jerrycan at the van: drain.
    const p = sc.players[0];
    p.equip = 'jerrycan';
    const before = v.fuel;
    const diesel0 = c.items.diesel;
    standAt(sc, v, 'flap');
    hold(h, sc, 0, Btn.A, 5);
    expect(v.fuel).toBe(0);
    expect(v.fuelType).toBe('petrol');
    expect(c.items.diesel).toBeCloseTo(diesel0 + before, 1);
    // Refuel from the petrol reserve.
    c.stocks.fuel = 12;
    hold(h, sc, 0, Btn.A, 5);
    expect(v.fuel).toBeGreaterThan(3);
    expect(v.fuelType).toBe('petrol');
    v.setEngine(true);
    expect(v.engineOn).toBe(true);
    expect(c.stocks.fuel).toBeLessThan(12);
  });

  it('a petrol can will not mix into a diesel tank, but goes into a dry one and switches it', () => {
    const { h, sc } = leg();
    const v = ownCar(sc, 'pickup', { fuel: 0.5 });
    const p = sc.players[0];
    p.carry = { kind: 'fuel', amount: FUEL_CAN, fuel: 'petrol' };
    standAt(sc, v, 'flap');
    hold(h, sc, 0, Btn.A, 4);
    expect(p.carry).not.toBeNull();
    expect(v.fuelType).toBe('diesel');
    expect(p.prompt?.text).toMatch(/drain/i);
    v.fuel = 0.1;
    hold(h, sc, 0, Btn.A, 4);
    expect(p.carry).toBeNull();
    expect(v.fuelType).toBe('petrol');
    expect(v.fuel).toBeGreaterThan(4);
    // Petrol in a diesel-engined pickup: it will not run until drained.
    v.setEngine(true);
    expect(v.engineOn).toBe(false);
  });

  it('a diesel can fills a diesel tank and says so', () => {
    const { h, sc } = leg();
    const v = ownCar(sc, 'van', { fuel: 0.2 });
    const p = sc.players[0];
    const f0 = v.fuel;
    p.carry = { kind: 'fuel', amount: FUEL_CAN, fuel: 'diesel' };
    standAt(sc, v, 'flap');
    hold(h, sc, 0, Btn.A, 4);
    expect(v.fuel).toBeCloseTo(f0 + FUEL_CAN, 1);
    expect(v.fuelType).toBe('diesel');
  });

  it('the pump at roll-out gives each engine what it burns and leaves a mismatched tank alone', () => {
    const { sc, c } = leg();
    const van = ownCar(sc, 'van', { fuel: 0 });
    c.stocks.fuel = 30;
    c.items.diesel = 30;
    van.fuel = 0;
    sc.fillTanksFromReserve();
    expect(van.fuelType).toBe('diesel');
    expect(c.items.diesel).toBeLessThan(30);
    // The player's own starting moped may top up a few drops of petrol; the van takes none.
    expect(c.stocks.fuel).toBeGreaterThan(29);
    // Swap in a petrol engine while the tank holds diesel: left alone until it is drained.
    installPart(van.build!, newPart('eng_i4', 1));
    van.syncFromBuild();
    van.fuel = 3;
    const diesel = c.items.diesel;
    sc.fillTanksFromReserve();
    expect(van.fuel).toBe(3);
    expect(c.items.diesel).toBe(diesel);
  });

  it('with no engine in the bay nothing starts', () => {
    const { sc } = leg();
    const v = ownCar(sc, 'sedan');
    removePart(v.build!, 'engine');
    v.syncFromBuild();
    v.setEngine(true);
    expect(v.engineOn).toBe(false);
    expect(v.startFail).toMatch(/No engine/);
  });
});

describe('heat on the road', () => {
  function drive(sc: LegScene, v: Vehicle, secs: number) {
    v.driver = FLAT_OUT;
    v.setEngine(true);
    let peak = 0;
    for (let i = 0; i < Math.round(secs / DT); i++) {
      sc.tick(DT);
      peak = Math.max(peak, v.temp);
    }
    return peak;
  }

  it('a stock hatchback flat out stays comfortable', () => {
    const { sc } = leg();
    const v = ownCar(sc, 'hatch', { fuel: 1 });
    const peak = drive(sc, v, 25);
    expect(v.engineOn).toBe(true);
    expect(peak).toBeLessThan(0.7);
  });

  it('a V8 in a hatchback on the factory radiator cooks: warnings, lost power, a worn engine', () => {
    const { sc } = leg();
    const v = ownCar(sc, 'hatch', { fuel: 1 });
    installPart(v.build!, newPart('eng_v8', 1));
    v.syncFromBuild();
    const e0 = v.health.comp.engine;
    const peak = drive(sc, v, 60);
    expect(peak).toBeGreaterThan(T_OVERHEAT);
    expect(v.health.comp.engine).toBeLessThan(e0);
    const p = sc.players[0];
    void p;
  });

  it('the same V8 behind a big race radiator runs cool', () => {
    const { sc } = leg();
    const v = ownCar(sc, 'hatch', { fuel: 1 });
    installPart(v.build!, newPart('eng_v8', 1));
    installPart(v.build!, newPart('rad_desert', 1));
    v.syncFromBuild();
    const peak = drive(sc, v, 40);
    expect(peak).toBeLessThan(T_OVERHEAT);
    expect(v.health.comp.engine).toBeGreaterThan(0.99);
  });

  it('a holed radiator makes even a stock engine run hot', () => {
    const { sc } = leg();
    const good = ownCar(sc, 'sedan', { fuel: 1 });
    const peakGood = drive(sc, good, 30);
    const { sc: sc2 } = leg();
    const bad = ownCar(sc2, 'sedan', { fuel: 1 });
    bad.health.comp.radiator = 0;
    const peakBad = drive(sc2, bad, 30);
    expect(peakBad).toBeGreaterThan(peakGood + 0.3);
  });

  it('an engine that is switched off cools down', () => {
    const { sc } = leg();
    const v = ownCar(sc, 'sedan', { fuel: 1 });
    v.temp = 1.1;
    v.setEngine(false);
    run(sc, 40);
    expect(v.temp).toBeLessThan(0.7);
  });

  it('a seriously overheated engine will not restart until it has cooled', () => {
    const { sc } = leg();
    const v = ownCar(sc, 'sedan', { fuel: 1 });
    v.temp = 1.15;
    v.setEngine(true);
    expect(v.engineOn).toBe(false);
    expect(v.startFail).toMatch(/too hot/);
  });
});

describe('fuel cans in the world', () => {
  it('a diesel can lifted from the ground is a diesel can, and stowing it fills the diesel reserve', () => {
    const { h, sc, c } = leg();
    const v = ownCar(sc, 'hatch');
    const p = sc.players[0];
    p.placeAt(v.position.x + 12, v.position.z, 0);
    sc.loose!.drop(p.pos.x, p.pos.z, { kind: 'fuel', amount: FUEL_CAN, fuel: 'diesel' });
    hold(h, sc, 0, Btn.A, 1.4);
    expect(p.carry).toMatchObject({ kind: 'fuel', fuel: 'diesel' });
    const d0 = c.items.diesel;
    const f0 = c.stocks.fuel;
    openPanel(v, 'trunk');
    standAt(sc, v, 'trunk');
    h.intents[0].device = 'keyboard';
    h.intents[0].held |= 1 << Btn.X;
    h.intents[0].pressed = 1 << Btn.X;
    sc.tick(DT);
    h.intents[0].held = 0;
    h.intents[0].pressed = 0;
    sc.tick(DT);
    expect(p.carry).toBeNull();
    expect(c.items.diesel).toBeCloseTo(d0 + FUEL_CAN, 1);
    expect(c.stocks.fuel).toBe(f0);
  });
});

describe('spray paint in the field', () => {
  it('a can in your hands paints the panel you face, one charge a panel, and the model changes', () => {
    const { h, sc } = leg();
    const v = ownCar(sc, 'sedan');
    const p = sc.players[0];
    // Beside the left door, facing it.
    const [dx, , dz] = v.body.toWorld(v.def.width / 2 + 1.1, 0, -0.1);
    p.placeAt(dx, dz, -Math.PI / 2);
    p.aimYaw = -Math.PI / 2;
    p.carry = { kind: 'paint', color: 0xe0be1a, charges: 2 };
    run(sc, 0.2);
    expect(p.prompt?.text).toMatch(/Spray the left door Hazard Yellow \(2 left\)/);
    expect(sc.work.ghostState(`g${p.index}`)).toBe('aimed');
    const shell0 = v.visual.body.geometry;
    hold(h, sc, 0, Btn.A, 2.6);
    expect(v.build!.panels).toEqual({ doorL: 0xe0be1a });
    expect(p.carry).toMatchObject({ kind: 'paint', charges: 1 });
    // The vehicle was rebuilt with the new colour.
    expect(v.visual.body.geometry).not.toBe(shell0);
    // Already that colour: nothing to do.
    run(sc, 0.2);
    expect(p.prompt?.text).toMatch(/already Hazard Yellow/);
  });

  it('the last charge empties the can; a can cannot be stowed, and X sets it down', () => {
    const { h, sc, c } = leg();
    const v = ownCar(sc, 'hatch');
    const p = sc.players[0];
    const [dx, , dz] = v.body.toWorld(0, 0, -v.def.length / 2 - 1.2);
    p.placeAt(dx, dz, 0);
    p.aimYaw = 0;
    p.carry = { kind: 'paint', color: 0x2a2a2a, charges: 1 };
    hold(h, sc, 0, Btn.A, 2.6);
    expect(v.build!.panels?.rear).toBe(0x2a2a2a);
    expect(p.carry).toBeNull();
    // A fresh can: X does not put it in the trunk, it sets it on the road.
    p.carry = { kind: 'paint', color: 0x2a2a2a, charges: 3 };
    const inv = c.inventory.length;
    h.intents[0].device = 'keyboard';
    h.intents[0].held |= 1 << Btn.X;
    h.intents[0].pressed = 1 << Btn.X;
    sc.tick(DT);
    h.intents[0].held = 0;
    h.intents[0].pressed = 0;
    sc.tick(DT);
    expect(p.carry).toBeNull();
    expect(c.inventory.length).toBe(inv);
    const near = sc.loose!.nearest(p.pos.x, p.pos.z, 3);
    expect(near?.carried).toMatchObject({ kind: 'paint', color: 0x2a2a2a, charges: 3 });
  });

  it('a vehicle driving over a spray can leaves it where it lies', () => {
    const { sc } = leg();
    const v = ownCar(sc, 'sedan');
    sc.loose!.drop(v.position.x, v.position.z, { kind: 'paint', color: 0x336699, charges: 4 });
    expect(sc.players[0].tryEnter()).toBe(true);
    run(sc, 2.5);
    expect(sc.players[0].vehicle).toBe(v);
    expect(sc.loose!.nearest(v.position.x, v.position.z, 6)?.carried.kind).toBe('paint');
  });
});

describe('stripping a car', () => {
  it('pulling the engine leaves an empty bay, not a ghost of the factory motor', () => {
    const { h, sc } = leg();
    const v = ownCar(sc, 'sedan');
    v.faction = 'neutral';
    const p = sc.players[0];
    p.equip = 'crowbar';
    hold(h, sc, 0, Btn.A, 3.5);
    expect(v.salvaged).toBe(1);
    hold(h, sc, 0, Btn.A, 6);
    expect(v.salvaged).toBeGreaterThanOrEqual(2);
    expect(v.build!.fit.engine?.id).toBe('eng_none');
    expect(v.stats.noEngine).toBe(true);
  });
});
