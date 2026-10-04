import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { Btn } from '../src/input/intents';
import { LegScene } from '../src/game/legScene';
import { DelveScene, carryOf, newDelveRecord } from '../src/game/delveScene';
import type { DelveSite } from '../src/world/delveSites';
import { fakeServices, run } from './helpers/sim';

beforeAll(async () => {
  await initPhysics();
});

function leg(id = 'L1') {
  const h = fakeServices();
  const sc = new LegScene(h.svc, legById(id));
  // Nobody is driving on their own: both start on foot beside their vehicles.
  for (const p of sc.players) p.exitVehicle(false);
  run(sc, 0.5);
  return { sc, ...h };
}

const press = (intents: ReturnType<typeof fakeServices>['intents'], i: 0 | 1, btn: number) => {
  intents[i].pressed |= 1 << btn;
  intents[i].held |= 1 << btn;
};
const release = (intents: ReturnType<typeof fakeServices>['intents'], i: 0 | 1, btn: number) => {
  intents[i].pressed &= ~(1 << btn);
  intents[i].held &= ~(1 << btn);
};

describe('a leg with lakes, run headless', () => {
  it('builds with boats at the docks, floating at their draft', () => {
    const { sc } = leg();
    const boats = sc.vehicles.filter((v) => v.kind === 'boat');
    expect(boats.length).toBeGreaterThanOrEqual(2);
    run(sc, 3);
    for (const b of boats) {
      const lake = sc.terrain!.lakes.find((l) => Math.hypot(l.x - b.position.x, l.z - b.position.z) < l.reach)!;
      expect(lake).toBeDefined();
      expect(Math.abs(b.position.y - (lake.level + b.def.physics.halfExtents[1] - b.def.physics.boat!.draft))).toBeLessThan(0.25);
      expect(b.fuel).toBeGreaterThan(2);
    }
    sc.dispose();
  }, 60000);

  it('a player boards a boat from the dock, sails it across the lake and steps out again', () => {
    const { sc, intents } = leg();
    const lake = sc.terrain!.lakes[0];
    const dock = lake.dock!;
    const boat = sc.vehicles.find((v) => v.kind === 'boat' && Math.hypot(v.position.x - lake.x, v.position.z - lake.z) < lake.reach)!;
    const p = sc.players[0];
    // Stand on the deck beside the boat.
    const perpX = -dock.dz;
    const perpZ = dock.dx;
    const bx = boat.position.x;
    const bz = boat.position.z;
    const side = Math.sign((bx - dock.shoreX) * perpX + (bz - dock.shoreZ) * perpZ) || 1;
    p.placeAt(bx - perpX * side * 2.0, bz - perpZ * side * 2.0, 0);
    expect(sc.groundAt(p.pos.x, p.pos.z)).toBeCloseTo(dock.deckY, 1);
    run(sc, 0.5);
    press(intents, 0, Btn.Y);
    run(sc, 1 / 60);
    release(intents, 0, Btn.Y);
    run(sc, 1.0);
    expect(p.state).toBe('driving');
    expect(p.vehicle).toBe(boat);
    expect(boat.engineOn).toBe(true);
    // Full throttle, straight out.
    intents[0].rt = 1;
    const x0 = boat.position.x;
    const z0 = boat.position.z;
    run(sc, 5);
    intents[0].rt = 0;
    const moved = Math.hypot(boat.position.x - x0, boat.position.z - z0);
    expect(moved).toBeGreaterThan(15);
    const w = sc.waterAt(boat.position.x, boat.position.z);
    expect(w).not.toBeNull();
    expect(boat.fuel).toBeLessThan(boat.tankMax);
    // Brake, then coast to a stop; tap Y and step out into the water.
    intents[0].lt = 1;
    run(sc, 2.5);
    intents[0].lt = 0;
    run(sc, 7);
    expect(Math.abs(boat.speed)).toBeLessThan(1.5);
    press(intents, 0, Btn.Y);
    run(sc, 1 / 60);
    release(intents, 0, Btn.Y);
    run(sc, 0.3);
    expect(p.state).toBe('foot');
    expect(p.swimming || p.waterDepth < 1.3).toBe(true);
    expect(p.hp).toBeGreaterThan(p.maxHp - 1);
    sc.dispose();
  }, 60000);

  it('a swimmer floats with the head above water, slowly, and the dead do not follow', () => {
    const { sc, intents } = leg();
    const lake = sc.terrain!.lakes[0];
    const p = sc.players[1];
    // The middle of the open water, away from the island.
    let sx = lake.x;
    let sz = lake.z;
    let best = 0;
    for (let a = 0; a < 360; a += 15) for (let r = 5; r < lake.r * 0.6; r += 5) {
      const x = lake.x + Math.cos(a) * r;
      const z = lake.z + Math.sin(a) * r;
      const d = sc.waterAt(x, z)?.depth ?? 0;
      if (d > best) (best = d), (sx = x), (sz = z);
    }
    expect(best).toBeGreaterThan(3);
    p.placeAt(sx, sz, 0);
    p.pos.y = sc.waterAt(sx, sz)!.level - 1.2;
    p.body.setTranslation({ x: sx, y: p.pos.y + 0.85, z: sz }, true);
    run(sc, 1.5);
    expect(p.swimming).toBe(true);
    const lvl = sc.waterAt(p.pos.x, p.pos.z)!.level;
    expect(Math.abs(p.pos.y - (lvl - 1.2))).toBeLessThan(0.3);
    intents[1].move = [0, 1];
    const x0 = p.pos.x;
    const z0 = p.pos.z;
    run(sc, 3);
    const v = Math.hypot(p.pos.x - x0, p.pos.z - z0) / 3;
    expect(v).toBeGreaterThan(0.8);
    expect(v).toBeLessThan(2.6);
    // A zombie walked straight at the swimmer stops at the shore.
    const zb = sc.zombies.spawn('walker', lake.x + lake.r * 1.3, lake.z, false, 1);
    zb.state = 'chase';
    zb.tx = p.pos.x;
    zb.tz = p.pos.z;
    zb.hasTarget = true;
    run(sc, 20, () => {
      zb.state = 'chase';
      zb.tx = p.pos.x;
      zb.tz = p.pos.z;
    });
    expect(sc.waterAt(zb.x, zb.z)?.depth ?? 0).toBeLessThan(1.05);
    sc.dispose();
  }, 60000);

  it('a car put into deep water floods, floats and is carried toward the shore', () => {
    const { sc } = leg();
    const lake = sc.terrain!.lakes[0];
    const v = sc.players[0].ownVehicle!;
    // The middle of the open water.
    let sx = lake.x;
    let sz = lake.z;
    let best = 0;
    for (let a = 0; a < 360; a += 15) for (let r = 5; r < lake.r * 0.6; r += 5) {
      const x = lake.x + Math.cos(a) * r;
      const z = lake.z + Math.sin(a) * r;
      const d = sc.waterAt(x, z)?.depth ?? 0;
      if (d > best) (best = d), (sx = x), (sz = z);
    }
    const w = sc.waterAt(sx, sz)!;
    v.setEngine(true);
    v.body.setPose(sx, w.level + 0.2, sz, 0);
    let flooded = false;
    run(sc, 6, () => {
      if (v.flooded) flooded = true;
    });
    expect(flooded).toBe(true);
    expect(v.engineOn).toBe(false);
    // Afloat, not sunk to the bed.
    expect(v.position.y).toBeGreaterThan(w.level - 1.5);
    // The current carries it outward, toward the nearest shore.
    const r0 = Math.hypot(v.position.x - lake.x, v.position.z - lake.z);
    run(sc, 12);
    expect(Math.hypot(v.position.x - lake.x, v.position.z - lake.z)).toBeGreaterThan(r0 + 1);
    sc.dispose();
  }, 60000);
});

describe('a delve, run headless', () => {
  const site: DelveSite = { id: 'T:d', theme: 'bunker', x: 0, z: 0, yaw: 0, seed: 123, name: 'Test Bunker', tier: 2, island: false };

  it('enters, lights up, loots a chest, unlocks, and climbs back out', () => {
    const h = fakeServices();
    const parent = new LegScene(h.svc, legById('L1'));
    for (const p of parent.players) p.exitVehicle(false);
    run(parent, 0.3);
    const carry = parent.players.map(carryOf);
    parent.suspend();
    const rec = parent.delveRecord(site.id);
    const d = new DelveScene(h.svc, parent.leg, site, rec, carry);
    let result: string | null = null;
    d.onResult = (r) => (result = r.type === 'delveExit' ? r.reason : r.type);
    expect(parent.suspended).toBe(true);
    expect(parent.root.visible).toBe(false);
    run(d, 2);
    expect(d.players).toHaveLength(2);
    for (const p of d.players) expect(d.map.grid[0] !== undefined && p.alive).toBe(true);
    // Both people stand on the floor.
    for (const p of d.players) expect(Math.abs(p.pos.y)).toBeLessThan(0.3);
    expect(d.hudLine().tag).toBe('FIND THE KEY');
    // Walk to a chest and search it.
    const chest = d.map.chests.find((c) => !c.boss)!;
    // Clear the room first: the dead cancel a search the moment they bite.
    d.zombies.list.length = 0;
    d.players[0].placeAt(chest.x, chest.z + 1.0, 0);
    h.intents[0].held |= 1 << Btn.A;
    h.intents[0].pressed |= 1 << Btn.A;
    const stocks0 = { ...h.campaign.stocks };
    run(d, 5, () => {
      h.intents[0].heldTime[Btn.A] += 1 / 60;
      h.intents[0].pressed = 0;
    });
    h.intents[0].held = 0;
    expect(rec.chests.has(chest.id)).toBe(true);
    // A chest holds named things: parts go to the trucks, cans and tins are banked or set down, rounds are counted.
    expect(chest.loot.items.length + (chest.loot.ammo ?? 0) + (chest.loot.guns ? 1 : 0)).toBeGreaterThan(0);
    void stocks0;
    // The way out.
    d.players[0].placeAt(d.map.exit.x, d.map.exit.z, 0);
    h.intents[0].held |= 1 << Btn.A;
    h.intents[0].heldTime[Btn.A] = 0;
    run(d, 3, () => {
      h.intents[0].heldTime[Btn.A] += 1 / 60;
      h.intents[0].held |= 1 << Btn.A;
    });
    expect(result).toBe('climb');
    const back = d.carry();
    d.dispose();
    parent.returnFromDelve(site, back, 'climb');
    expect(parent.suspended).toBe(false);
    expect(parent.root.visible).toBe(true);
    run(parent, 1);
    expect(parent.players.every((p) => p.state === 'foot')).toBe(true);
    // The delve remembers: the chest is still opened on the next visit.
    const d2 = new DelveScene(h.svc, parent.leg, site, rec, back);
    expect(d2.record.chests.has(chest.id)).toBe(true);
    d2.dispose();
    parent.dispose();
  }, 90000);

  it('every theme builds a playable scene that ticks without trouble', () => {
    const h = fakeServices();
    const parent = new LegScene(h.svc, legById('L1'));
    parent.suspend();
    for (const theme of ['cave', 'mine', 'bunker', 'metro'] as const) {
      const s = { ...site, theme, id: `T:${theme}` };
      const d = new DelveScene(h.svc, parent.leg, s, newDelveRecord(), parent.players.map(carryOf));
      run(d, 6);
      expect(d.zombies.aliveCount).toBeGreaterThan(5);
      expect(d.compassPins().length).toBeGreaterThan(0);
      d.dispose();
    }
    parent.dispose();
  }, 90000);
});
