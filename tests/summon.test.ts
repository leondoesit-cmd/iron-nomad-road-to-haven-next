import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { WorldMemory } from '../src/game/worldMemory';
import type { Player } from '../src/game/player';
import { Btn } from '../src/input/intents';
import { restHeight } from '../src/render/carSpecs';
import { roadX } from '../src/world/terrain';
import { navOf } from '../src/ui/mapnav';
import { SUMMON } from '../src/game/summon';
import { fakeServices, run } from './helpers/sim';

// Calling the ride, and working the big map, in a real open-world scene in Node.
vi.setConfig({ testTimeout: 240000 });

beforeAll(async () => {
  await initPhysics();
});

function open() {
  const h = fakeServices();
  const sc = new LegScene(h.svc, legById('W'), { memory: new WorldMemory() });
  for (const p of sc.players) if (p.vehicle) p.exitVehicle(false);
  run(sc, 0.5);
  return { sc, ...h };
}

function notesOf(p: Player): string[] {
  const out: string[] = [];
  const note = p.note.bind(p);
  p.note = (text, kind) => {
    out.push(text);
    note(text, kind);
  };
  return out;
}

const press = (h: ReturnType<typeof fakeServices>, seat: number, b: number) => {
  h.intents[seat].pressed |= 1 << b;
  h.intents[seat].held |= 1 << b;
};
const clear = (h: ReturnType<typeof fakeServices>, seat: number) => {
  h.intents[seat].pressed = 0;
  h.intents[seat].held = 0;
  h.intents[seat].released = 0;
};

describe('calling your ride', () => {
  it('drives a parked car from 120 m up the road to within a few metres, and honks', () => {
    const h = open();
    const { sc } = h;
    const p = sc.players[0];
    const car = p.ownVehicle!;
    expect(car).toBeTruthy();
    const T = sc.terrain!;
    // Park it up the highway, on ground that is loaded.
    const z = p.pos.z + 120;
    const x = roadX(T, z);
    expect(sc.colliderReady(x, z)).toBe(true);
    car.body.setPose(x, sc.groundAt(x, z) + restHeight(car.def) + 0.05, z, Math.PI);
    car.snapshotPrev();
    car.setEngine(false);
    run(sc, 1);
    const notes = notesOf(p);
    const start = Math.hypot(car.position.x - p.pos.x, car.position.z - p.pos.z);
    expect(start).toBeGreaterThan(100);
    press(h, 0, Btn.Summon);
    sc.tick(1 / 60);
    clear(h, 0);
    expect(car.driver).not.toBeNull();
    expect(notes.some((n) => n.startsWith('Ride on its way'))).toBe(true);
    // The compass shows it coming, with how far.
    expect(sc.compassPins().some((q) => q.kind === 'ride' && q.dist)).toBe(true);
    let t = 0;
    while (car.driver && t < 60) {
      run(sc, 0.5);
      t += 0.5;
    }
    const d = Math.hypot(car.position.x - p.pos.x, car.position.z - p.pos.z);
    expect(car.driver).toBeNull();
    expect(d).toBeLessThan(10);
    expect(d).toBeGreaterThan(3);
    expect(h.sounds).toContain('horn');
    expect(notes).toContain('Your ride is here');
    // The cooldown: an immediate second call has to wait.
    car.body.setPose(x, sc.groundAt(x, z) + restHeight(car.def) + 0.05, z, Math.PI);
    car.snapshotPrev();
    sc.summoner.request(p);
    expect(notes[notes.length - 1]).toMatch(/needs a moment/);
    sc.dispose();
  });

  it('a far car turns up behind the player, out of view, settled on dry ground', () => {
    const h = open();
    const { sc } = h;
    const p = sc.players[0];
    const car = p.ownVehicle!;
    const T = sc.terrain!;
    // The views look where the players look, so "out of view" means something.
    sc.renderFrame(1, 1 / 60);
    const z = p.pos.z + 700;
    car.body.setPose(roadX(T, z), sc.groundAt(roadX(T, z), z) + 2, z, 0);
    car.snapshotPrev();
    const notes = notesOf(p);
    sc.summoner.request(p);
    expect(notes[notes.length - 1]).toMatch(/waiting behind you/);
    const cx = car.position.x;
    const cz = car.position.z;
    const d = Math.hypot(cx - p.pos.x, cz - p.pos.z);
    expect(d).toBeGreaterThanOrEqual(SUMMON.near - 1);
    expect(d).toBeLessThan(SUMMON.far + 25);
    expect(car.driver).toBeNull();
    expect(sc.visibleToAnyView(cx, sc.groundAt(cx, cz) + 1.2, cz, 2)).toBe(false);
    expect(sc.waterAt(cx, cz)).toBeNull();
    // It sits on its wheels and stays put.
    run(sc, 2);
    const g = sc.groundAt(car.position.x, car.position.z);
    expect(Math.abs(car.position.y - (g + restHeight(car.def)))).toBeLessThan(0.6);
    expect(Math.hypot(car.position.x - cx, car.position.z - cz)).toBeLessThan(1.5);
    sc.dispose();
  });

  it('says why when there is nothing to call, and a second press calls it off', () => {
    const h = open();
    const { sc } = h;
    const p = sc.players[0];
    const notes = notesOf(p);
    const car = p.ownVehicle!;
    // Already there.
    car.body.setPose(p.pos.x + 4, sc.groundAt(p.pos.x + 4, p.pos.z) + restHeight(car.def), p.pos.z, 0);
    car.snapshotPrev();
    sc.summoner.request(p);
    expect(notes[notes.length - 1]).toBe('Your ride is right here');
    // Out of fuel.
    const fuel = car.fuel;
    car.fuel = 0;
    sc.summoner.request(p);
    expect(notes[notes.length - 1]).toBe('Your ride is out of fuel');
    car.fuel = fuel;
    // On its way, then called off.
    const T = sc.terrain!;
    const z = p.pos.z + 90;
    car.body.setPose(roadX(T, z), sc.groundAt(roadX(T, z), z) + restHeight(car.def), z, Math.PI);
    car.snapshotPrev();
    sc.summoner.request(p);
    expect(car.driver).not.toBeNull();
    sc.summoner.request(p);
    expect(car.driver).toBeNull();
    expect(notes[notes.length - 1]).toBe('Ride called off');
    sc.dispose();
  });
});

describe('the big map in play', () => {
  it('moves a cursor instead of the player, sets a waypoint with a route, marks a place, and clears the waypoint on arrival', () => {
    const h = open();
    const { sc } = h;
    const p = sc.players[0];
    const it = h.intents[0];
    it.device = 'pad';
    const notes = notesOf(p);
    p.mapMode = 1;
    const before = { x: p.pos.x, z: p.pos.z };
    // The left stick moves the cursor right for a second; the player stays put.
    run(sc, 1, () => {
      it.move[0] = 1;
      it.move[1] = 0;
    });
    it.move[0] = 0;
    expect(Math.hypot(p.pos.x - before.x, p.pos.z - before.z)).toBeLessThan(0.3);
    const nav = navOf(p);
    expect(nav.sx).toBeGreaterThan(100);
    const aim = nav.cursorWorld();
    press(h, 0, Btn.A);
    sc.tick(1 / 60);
    clear(h, 0);
    const w = sc.campaign.nav.waypoints[0]!;
    expect(w).not.toBeNull();
    expect(Math.hypot(w.x - aim.x, w.z - aim.z)).toBeLessThan(5);
    // Right on the screen is -X (east) when north is up.
    expect(w.x).toBeLessThan(p.pos.x - 50);
    expect(sc.navigation.route(0)).not.toBeNull();
    expect(sc.compassPins().some((q) => q.kind === 'waypoint' && q.dist)).toBe(true);
    const f = sc.mapFrame(sc.compassPins())!;
    expect(f.nav.waypoints).toHaveLength(1);
    expect(f.nav.routes).toHaveLength(1);
    // X opens the chooser; two steps down is Loot; A marks it.
    press(h, 0, Btn.X);
    sc.tick(1 / 60);
    clear(h, 0);
    expect(nav.menu?.kind).toBe('kinds');
    for (let k = 0; k < 2; k++) {
      it.nav = 2;
      sc.tick(1 / 60);
      it.nav = 0;
    }
    press(h, 0, Btn.A);
    sc.tick(1 / 60);
    clear(h, 0);
    expect(sc.campaign.nav.pois.map((q) => q.kind)).toEqual(['loot']);
    expect(sc.campaign.nav.pois[0].leg).toBe('W');
    // B closes the map.
    press(h, 0, Btn.B);
    sc.tick(1 / 60);
    clear(h, 0);
    expect(p.mapMode).toBe(0);
    // Walk up to the waypoint: it has done its job.
    p.placeAt(w.x + 3, w.z, 0);
    run(sc, 0.2);
    expect(sc.campaign.nav.waypoints[0]).toBeNull();
    expect(notes).toContain('Waypoint reached');
    sc.dispose();
  });
});
