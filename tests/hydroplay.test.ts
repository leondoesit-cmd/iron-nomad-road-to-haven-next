import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { WorldMemory } from '../src/game/worldMemory';
import { WildlifeSystem } from '../src/game/wildlife';
import type { Ctx } from '../src/game/ctx';
import type { Player } from '../src/game/player';
import type { WaterAmbience } from '../src/audio/audio';
import { Rng } from '../src/core/rng';
import { drink, newNeeds } from '../src/sim/needs';
import { forestAt, type River } from '../src/world/hydro';
import { CHUNK } from '../src/world/terrain';
import { fakeServices, run } from './helpers/sim';

// The open world's running water in play: real scenes in Node, on the open-world leg.
vi.setConfig({ testTimeout: 180000 });

beforeAll(async () => {
  await initPhysics();
});

const leg = legById('W');

function open(start: { x: number; z: number; yaw?: number }) {
  const h = fakeServices();
  const amb: WaterAmbience[] = [];
  (h.svc.audio as unknown as { setWaterAmbience: (a: WaterAmbience) => void }).setWaterAmbience = (a) => void amb.push(a);
  const sc = new LegScene(h.svc, leg, { memory: new WorldMemory(), start: { x: start.x, z: start.z, yaw: start.yaw ?? 0 } });
  return { sc, amb, ...h };
}

/** Everyone out and standing about, so nothing is driving. */
function onFoot(sc: LegScene) {
  for (const p of sc.players) if (p.vehicle) p.exitVehicle(false);
  run(sc, 0.5);
}

/** Put someone in the water at a point: afloat if it is deep, on the bed if not. */
function dropIn(sc: LegScene, p: Player, x: number, z: number) {
  const w = sc.waterAt(x, z)!;
  p.placeAt(x, z, 0);
  if (w.depth > 1.3) {
    p.pos.y = w.level - 1.2;
    p.body.setTranslation({ x, y: p.pos.y + 0.85, z }, true);
  }
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

/** A deep, steady stretch of a river: well clear of its falls, its crossings and its mouth. */
function deepReach(sc: LegScene, r: River): number {
  const hy = sc.terrain!.hydro!;
  let best = -1;
  for (let i = 40; i < r.end - 40; i++) {
    if (r.depth[i] < 1.9 || r.speed[i] < 0.6 || r.speed[i] > 1.6) continue;
    if (hy.falls.some((f) => Math.hypot(f.x - r.x[i], f.z - r.z[i]) < 120)) continue;
    if (hy.crossings.some((c) => Math.hypot(c.x - r.x[i], c.z - r.z[i]) < 120)) continue;
    // Straight here, so the drift is easy to read.
    if (r.dx[i] * r.dx[i + 8] + r.dz[i] * r.dz[i + 8] < 0.97) continue;
    if (best < 0 || Math.hypot(r.x[i] - 400, r.z[i] + 390) < Math.hypot(r.x[best] - 400, r.z[best] + 390)) best = i;
  }
  return best;
}

describe('running water in play', () => {
  it('carries a swimmer downstream, and a boat left to itself', () => {
    const probe = open({ x: 0, z: -300 });
    const hy = probe.sc.terrain!.hydro!;
    const yarkon = hy.rivers.find((r) => r.name === 'the Yarkon')!;
    const i = deepReach(probe.sc, yarkon);
    expect(i).toBeGreaterThan(0);
    probe.sc.dispose();
    const [x, z] = [yarkon.x[i], yarkon.z[i]];
    const [dx, dz] = [yarkon.dx[i], yarkon.dz[i]];
    const { sc } = open({ x: x - dz * 30, z: z + dx * 30 });
    onFoot(sc);
    const p = sc.players[0];
    dropIn(sc, p, x, z);
    run(sc, 1);
    expect(p.swimming).toBe(true);
    const x0 = p.pos.x;
    const z0 = p.pos.z;
    run(sc, 5);
    const down = (p.pos.x - x0) * dx + (p.pos.z - z0) * dz;
    const across = Math.abs(-(p.pos.x - x0) * dz + (p.pos.z - z0) * dx);
    // About the river's own speed: well under a metre a second in the slow middle reaches, and all of it downstream.
    expect(down).toBeGreaterThan(2.5);
    expect(down).toBeLessThan(5 * 1.7);
    expect(across).toBeLessThan(down);

    // A boat put in the same water with nobody at the throttle goes the same way, picking up the current over a few seconds.
    const boat = sc.vehicles.find((v) => v.kind === 'boat')!;
    const bx = x + dx * 25;
    const bz = z + dz * 25;
    const w = sc.waterAt(bx, bz)!;
    boat.body.setPose(bx, w.level + boat.def.physics.halfExtents[1] - boat.def.physics.boat!.draft + 0.05, bz, Math.atan2(dx, dz));
    run(sc, 8);
    const bdown = (boat.position.x - bx) * dx + (boat.position.z - bz) * dz;
    const lv = boat.body.body.linvel();
    expect(bdown).toBeGreaterThan(3);
    expect(lv.x * dx + lv.z * dz).toBeGreaterThan(0.5);
    sc.dispose();
  });

  it('sweeps a wader over Thorn Brook Falls: a splash and a blow, never the death of them', () => {
    const { sc } = open({ x: 1080, z: 1930 });
    const hy = sc.terrain!.hydro!;
    const f = hy.falls.find((q) => q.name === 'Thorn Brook Falls')!;
    expect(f.top - f.bottom).toBeGreaterThan(6);
    onFoot(sc);
    const p = sc.players[0];
    const notes = notesOf(p);
    const sx = f.x - f.dx * 3;
    const sz = f.z - f.dz * 3;
    expect(sc.waterAt(sx, sz)?.flow).toBeTruthy();
    dropIn(sc, p, sx, sz);
    const hp0 = p.hp;
    run(sc, 8);
    // Below the lip now, in the pool at the foot.
    expect((p.pos.x - f.x) * f.dx + (p.pos.z - f.z) * f.dz).toBeGreaterThan(1);
    expect(p.pos.y).toBeLessThan(f.top - 4);
    expect(notes).toContain('Over Thorn Brook Falls!');
    expect(notes.filter((n) => n.startsWith('Over ')).length).toBe(1);
    expect(p.hp).toBeLessThan(hp0);
    expect(p.hp).toBeGreaterThan(p.maxHp * 0.2);
    expect(p.state).toBe('foot');
    sc.dispose();
  });

  it('a car on the highway bridge over the Yarkon sits on dry road, and the river leaves it be', () => {
    const { sc } = open({ x: 0, z: -360 });
    const c = sc.terrain!.hydro!.crossings.find((q) => q.road.kind === 'highway')!;
    expect(Math.hypot(c.x, c.z + 407)).toBeLessThan(20);
    const v = sc.players[0].vehicle!;
    const hy = v.def.physics.halfExtents[1];
    v.body.setPose(c.x, sc.groundAt(c.x, c.z) + hy + 0.6, c.z, 0);
    run(sc, 4);
    expect(sc.waterAt(v.position.x, v.position.z)).toBeNull();
    expect(Math.abs(sc.groundAt(c.x, c.z) - c.y)).toBeLessThan(0.3);
    expect(Math.abs(v.position.y - (c.y + hy))).toBeLessThan(0.9);
    expect(Math.hypot(v.position.x - c.x, v.position.z - c.z)).toBeLessThan(1.5);
    expect(v.flooded).toBe(false);
    sc.dispose();
  });

  it('a spring is always clean to drink, and a swamp seldom is', () => {
    // The rules alone: every roll clean at a spring, most of them bad in a swamp.
    let springBad = 0;
    let swampBad = 0;
    for (let k = 0; k < 100; k++) {
      const a = newNeeds();
      a.water = 0.3;
      if (drink(a, 0, { lake: true, source: 'spring', roll: k / 100 }).dirty) springBad++;
      const b = newNeeds();
      b.water = 0.3;
      if (drink(b, 0, { lake: true, source: 'swamp', roll: k / 100 }).dirty) swampBad++;
    }
    expect(springBad).toBe(0);
    expect(swampBad).toBeGreaterThan(50);

    // And in play, at the edge of Ein Tamar's pool.
    const { sc, campaign } = open({ x: -760, z: 2060 });
    const sp = sc.terrain!.hydro!.springs.find((q) => q.name === 'Ein Tamar')!;
    onFoot(sc);
    const p = sc.players[0];
    const notes = notesOf(p);
    p.placeAt(sp.x, sp.z - sp.r - 0.6, 0);
    p.aimYaw = 0;
    run(sc, 0.3);
    const reserve = campaign.items.water;
    for (let k = 0; k < 12; k++) {
      p.needs.water = 0.3;
      const bowel = (p.needs.bowel = 0);
      expect(p.drinkUp()).toBe(true);
      expect(p.needs.bowel).toBeLessThan(bowel + 0.2);
    }
    expect(campaign.items.water).toBe(reserve);
    expect(notes.every((n) => n === 'You drink from Ein Tamar: cold and clean')).toBe(true);
    sc.dispose();
  });

  it('names a waterfall once when the convoy comes near, pins it on the map, and lets it be heard and seen', () => {
    const { sc, banners, radio, amb } = open({ x: -2200, z: 1650, yaw: -Math.PI / 2 });
    let mist = 0;
    const emit = sc.fx.smoke.emit.bind(sc.fx.smoke);
    sc.fx.smoke.emit = (...a: Parameters<typeof emit>) => {
      mist++;
      emit(...a);
    };
    run(sc, 14);
    expect(banners.filter((b) => b.startsWith('Veil Falls |')).length).toBe(1);
    expect(radio.some((r) => r.includes('Veil Falls'))).toBe(true);
    run(sc, 10);
    expect(banners.filter((b) => b.startsWith('Veil Falls |')).length).toBe(1);
    expect(radio.filter((r) => r.includes('Veil Falls')).length).toBe(1);
    // The same day's memory keeps it named: on the map, labelled, at the foot of the fall.
    const f = sc.mapFrame(sc.compassPins())!;
    expect(f.pins.some((q) => q.kind === 'falls' && q.label === 'VEIL FALLS')).toBe(true);
    expect(f.waters.length).toBe(sc.terrain!.hydro!.rivers.length);
    // The roar of a tall fall, and mist at its foot.
    const last = amb[amb.length - 1];
    expect(last.roar).toBeGreaterThan(0.2);
    expect(last.tall).toBeGreaterThan(0.9);
    expect(mist).toBeGreaterThan(100);
    sc.dispose();
  });

  it('wakes a convoy that camped in a wood on clear ground, not inside the trees', () => {
    const probe = open({ x: 0, z: -300 });
    const T = probe.sc.terrain!;
    // A camp made right at the foot of a trunk, deep in the woods.
    let pose: { x: number; z: number; yaw: number } | null = null;
    for (let x = -2000; x < 2000 && !pose; x += 64) {
      for (let z = -1200; z < 4200 && !pose; z += 64) {
        if (forestAt(T, x, z) < 0.8) continue;
        const tr = probe.sc.src.get(Math.floor(x / CHUNK), Math.floor(z / CHUNK)).trees.find((q) => forestAt(T, q.x, q.z) > 0.8);
        if (tr) pose = { x: tr.x + 0.5, z: tr.z, yaw: 0 };
      }
    }
    expect(pose).not.toBeNull();
    const spot = (probe.sc as unknown as { freeSpot(p: { x: number; z: number; yaw: number }): { x: number; z: number } }).freeSpot(pose!);
    for (let cx = Math.floor((spot.x - 8) / CHUNK); cx <= Math.floor((spot.x + 8) / CHUNK); cx++) {
      for (let cz = Math.floor((spot.z - 8) / CHUNK); cz <= Math.floor((spot.z + 8) / CHUNK); cz++) {
        for (const tr of probe.sc.src.get(cx, cz).trees) expect(Math.hypot(tr.x - spot.x, tr.z - spot.z)).toBeGreaterThanOrEqual(6);
      }
    }
    expect(Math.hypot(spot.x - pose!.x, spot.z - pose!.z)).toBeLessThan(91);
    probe.sc.dispose();
  });

  it('crowds the meadows with grazers and keeps the wolves and bears to the woods', () => {
    const ctx = { rng: new Rng(9), night: 0, players: [], terrain: null } as unknown as Ctx;
    const W = new WildlifeSystem(ctx);
    const tally = (land?: { lush: number; wood: number }) => {
      const n: Record<string, number> = {};
      for (let k = 0; k < 3000; k++) {
        const kind = W.pickKind('wasteland', 'dust', 2, land);
        if (kind) n[kind] = (n[kind] ?? 0) + 1;
      }
      return n;
    };
    const bare = tally({ lush: 0, wood: 0 });
    const meadow = tally({ lush: 1, wood: 0 });
    const wood = tally({ lush: 0.9, wood: 0.9 });
    const grazers = (n: Record<string, number>) => (n.deer ?? 0) + (n.hare ?? 0);
    expect(grazers(meadow)).toBeGreaterThan(grazers(bare) * 1.3);
    expect(meadow.deer ?? 0).toBeGreaterThan((bare.deer ?? 0) * 2);
    expect(bare.wolf ?? 0).toBe(0);
    expect(bare.bear ?? 0).toBe(0);
    expect(wood.wolf ?? 0).toBeGreaterThan(200);
    expect(wood.bear ?? 0).toBeGreaterThan(50);
    expect((wood.vulture ?? 0) / 3000).toBeLessThan(((bare.vulture ?? 0) / 3000) * 0.5);
    // With no land to read (any other leg) the old rules stand: no wolves on the dust.
    expect(tally().wolf ?? 0).toBe(0);
  });
});
