import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { legById, partDef } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { Btn } from '../src/input/intents';
import { installPart, newBuild, removePart, tyreIdAt } from '../src/sim/garage';
import { newPart } from '../src/sim/parts';
import { WATER_CAN } from '../src/sim/fluids';
import { socketFor, wheelCentres } from '../src/render/sockets';
import { fakeServices } from './helpers/sim';
import type { Vehicle, Pilot } from '../src/game/vehicle';

// Real leg scenes in Node: the whole machine in the player's hands. Tyres go on one wheel at a time, a crowbar pries
// doors and the bonnet off, and a big engine drinks fuel, oil and water faster than a small one.
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

function ownCar(sc: LegScene, chassis = 'sedan', o: { fuel?: number } = {}): Vehicle {
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

/** Stand `out` metres outside a point on the vehicle (chassis frame), facing it. */
function standAt(sc: LegScene, v: Vehicle, x: number, z: number, out: number) {
  const p = sc.players[0];
  const sx = Math.sign(x) || 1;
  const [wx, , wz] = v.body.toWorld(x + sx * out, 0, z);
  const [tx, , tz] = v.body.toWorld(x, 0, z);
  p.placeAt(wx, wz, 0);
  p.aimYaw = Math.atan2(tx - wx, tz - wz);
}

const FLAT_OUT: Pilot = { isPlayer: false, index: 0, drive: () => ({ steer: 0, throttle: 1, brake: 0, handbrake: false }) };

describe('tyres, one wheel at a time', () => {
  it('a tyre carried to a wheel goes on that wheel only, and the old one is stowed as a real tyre', () => {
    const { h, sc, c } = leg();
    const v = ownCar(sc, 'sedan');
    const p = sc.players[0];
    const wheels = wheelCentres(v.def);
    const target = 3;
    const [wx, , wz] = wheels[target];
    standAt(sc, v, wx, wz, 0.9);
    p.carry = { kind: 'part', item: newPart('whl_bl', 0.9) };
    hold(h, sc, 0, Btn.A, 4);
    expect(p.carry).toBeNull();
    expect(v.build!.tyres[target]?.id).toBe('whl_bl');
    for (let i = 0; i < wheels.length; i++) if (i !== target) expect(tyreIdAt(v.build!, i)).toBe('tyre_sedan');
    expect(c.inventory.map((i) => i.id)).toContain('tyre_sedan');
  });

  it('the outline from afar covers every wheel, and up close only the one you are fitting', () => {
    const { sc } = leg();
    const v = ownCar(sc, 'sedan');
    const p = sc.players[0];
    p.carry = { kind: 'part', item: newPart('whl_mt', 1) };
    // From the road a few metres off: all four outlines, white.
    const [fx, , fz] = v.body.toWorld(7, 0, 0);
    p.placeAt(fx, fz, 0);
    run(sc, 0.2);
    expect(sc.work.ghostState(`g${p.index}`)).toBe('idle');
    // Next to a wheel: one outline, green.
    const [wx, , wz] = wheelCentres(v.def)[0];
    standAt(sc, v, wx, wz, 0.9);
    run(sc, 0.2);
    expect(sc.work.ghostState(`g${p.index}`)).toBe('aimed');
  });
});

describe('the crowbar takes parts off your own vehicle', () => {
  it('pries a door off its hinges and carries it away; the mount is bare and the stats say so', () => {
    const { h, sc } = leg();
    const v = ownCar(sc, 'sedan');
    const p = sc.players[0];
    p.equip = 'crowbar';
    const door = socketFor(v.def, 'doorL')!.anchors[0];
    standAt(sc, v, door.x, door.z, 1.1);
    run(sc, 0.3);
    hold(h, sc, 0, Btn.A, 4);
    expect(v.build!.fit.doorL?.id).toBe('door_none');
    expect(p.carry).toMatchObject({ kind: 'part' });
    expect((p.carry as { item: { id: string } }).item.id).toBe('door_std');
    expect(v.stats.doorsOff).toBe(1);
    // Bolted back on with A.
    hold(h, sc, 0, Btn.A, 4);
    expect(p.carry).toBeNull();
    expect(v.build!.fit.doorL?.id).toBe('door_std');
    expect(v.stats.doorsOff).toBe(0);
  });

  it('pulls the bonnet and shows the engine bay', () => {
    const { h, sc } = leg();
    const v = ownCar(sc, 'sedan');
    const p = sc.players[0];
    p.equip = 'crowbar';
    // At the nose, facing back along the bonnet.
    const [hx, , hz] = v.body.toWorld(0.0, 0, v.def.length / 2 + 1.0);
    p.placeAt(hx, hz, 0);
    p.aimYaw = Math.PI;
    run(sc, 0.3);
    hold(h, sc, 0, Btn.A, 4);
    expect(v.stats.hoodOff).toBe(true);
    expect(partDef((p.carry as { item: { id: string } }).item.id).slot).toBe('hood');
  });

  it('will not pry anything off a moving vehicle', () => {
    const { h, sc } = leg();
    const v = ownCar(sc, 'sedan');
    const p = sc.players[0];
    p.equip = 'crowbar';
    const door = socketFor(v.def, 'doorL')!.anchors[0];
    standAt(sc, v, door.x, door.z, 1.1);
    v.body.body.setLinvel({ x: 0, y: 0, z: 9 }, true);
    hold(h, sc, 0, Btn.A, 3);
    expect(v.build!.fit.doorL?.id ?? 'door_std').not.toBe('door_none');
  });

  it('with no gearbox the engine runs and nothing moves', () => {
    const { sc } = leg();
    const v = ownCar(sc, 'sedan', { fuel: 1 });
    removePart(v.build!, 'gearbox');
    v.syncFromBuild();
    v.driver = FLAT_OUT;
    v.setEngine(true);
    run(sc, 4);
    expect(Math.abs(v.speed)).toBeLessThan(1.5);
  });
});

describe('a bigger engine drinks more of everything', () => {
  function drive(sc: LegScene, v: Vehicle, secs: number) {
    v.driver = FLAT_OUT;
    v.setEngine(true);
    const x0 = v.position.x;
    const z0 = v.position.z;
    const fuel0 = v.fuel;
    const oil0 = v.health.comp.oil * v.stats.sumpL;
    run(sc, secs);
    const metres = Math.hypot(v.position.x - x0, v.position.z - z0);
    return { metres, fuel: fuel0 - v.fuel, oilL: oil0 - v.health.comp.oil * v.stats.sumpL };
  }

  it('burns more fuel and oil per kilometre, and a bare cooling system boils the water away', () => {
    const { sc } = leg();
    const small = ownCar(sc, 'hatch', { fuel: 1 });
    const a = drive(sc, small, 14);
    const { sc: sc2 } = leg();
    const big = ownCar(sc2, 'hatch', { fuel: 1 });
    installPart(big.build!, newPart('eng_v8', 1));
    big.syncFromBuild();
    const z = drive(sc2, big, 14);
    expect(a.metres).toBeGreaterThan(10);
    expect(z.metres).toBeGreaterThan(10);
    expect(z.fuel / z.metres).toBeGreaterThan((a.fuel / a.metres) * 1.5);
    expect(z.oilL / z.metres).toBeGreaterThan(a.oilL / a.metres);
    // The factory radiator cannot hold a V8: it boils over and loses water.
    run(sc2, 60);
    expect(big.health.comp.coolant ?? 1).toBeLessThan(1);
  });
});

describe('water for the radiator', () => {
  it('a water can poured into the radiator tops it up in litres, and a big system takes more cans', () => {
    const { h, sc } = leg();
    const v = ownCar(sc, 'hatch');
    const p = sc.players[0];
    v.health.comp.coolant = 0.2;
    p.carry = { kind: 'water', amount: WATER_CAN };
    hold(h, sc, 0, Btn.A, 4);
    expect(v.health.comp.coolant ?? 0).toBeGreaterThan(0.9);
    expect(p.notes.some((n) => /radiator/i.test(n.text))).toBe(true);
    // A big engine and radiator: the same can fills less of it.
    const { h: h2, sc: sc2 } = leg();
    const big = ownCar(sc2, 'hatch');
    installPart(big.build!, newPart('eng_v8', 1));
    installPart(big.build!, newPart('rad_desert', 1));
    big.syncFromBuild();
    big.health.comp.coolant = 0;
    sc2.players[0].carry = { kind: 'water', amount: WATER_CAN };
    hold(h2, sc2, 0, Btn.A, 4);
    expect(big.health.comp.coolant ?? 0).toBeLessThan(v.health.comp.coolant ?? 1);
  });
});
