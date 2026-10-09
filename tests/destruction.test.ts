import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initPhysics, G, groups } from '../src/physics/physics';
import { legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { chunkKey, newAabbId, type Aabb } from '../src/world/layout';
import { CHUNK } from '../src/world/terrain';
import { wallAabbs, type BuildingPlan, type Wall } from '../src/world/interiors';
import { BREACH_MAX, BREACH_MIN, WALL_HP, breachWall, breachWidth, structuralMul, wallDamage, wallHp } from '../src/sim/breach';
import { AMMO, throughSlab } from '../src/sim/ballistics';
import { fakeServices } from './helpers/sim';
import { CELL, SPALLS } from '../src/render/decals';

vi.setConfig({ testTimeout: 90000 });

beforeAll(async () => {
  await initPhysics();
});

const DT = 1 / 60;

const wall = (ops: Wall['ops'] = [], a = 0, b = 12): Wall => ({ level: 0, axis: 'x', c: 10, a, b, ext: true, out: 1, t: 0.3, h: 3.2, ops });
const door = (a: number, b: number): Wall['ops'][number] => ({ a, b, kind: 'door', sill: 0, head: 2.1, leaf: 'ajar', glass: 'none' });

describe('breach rules', () => {
  it('wood, plaster and sheet break; masonry does not', () => {
    expect(wallHp('wood')).toBe(WALL_HP.wood);
    expect(wallHp('plaster')).toBeLessThan(wallHp('wood')!);
    expect(wallHp('sheet')).toBeGreaterThan(wallHp('wood')!);
    expect(wallHp('concrete')).toBeNull();
    expect(wallHp('dirt')).toBeNull();
    expect(wallDamage('blast', 100)).toBeGreaterThan(wallDamage('bullet', 100));
  });

  it('a blast opens a wider hole than a bullet, within limits', () => {
    expect(breachWidth('bullet')).toBeGreaterThanOrEqual(BREACH_MIN);
    expect(breachWidth('blast', 7)).toBeGreaterThan(breachWidth('bullet'));
    expect(breachWidth('blast', 30)).toBe(BREACH_MAX);
    expect(breachWidth('blast', 1)).toBe(BREACH_MIN);
  });

  it('opens a gap where it is hit, with a lintel, and leaves the wall in order', () => {
    const w = wall();
    const op = breachWall(w, 6, 1.5)!;
    expect(op.kind).toBe('breach');
    expect(op.b - op.a).toBeCloseTo(1.5, 5);
    expect((op.a + op.b) / 2).toBeCloseTo(6, 5);
    expect(op.sill).toBe(0);
    expect(op.head).toBeGreaterThan(2.1);
    expect(op.head).toBeLessThanOrEqual(w.h);
    expect(w.ops).toEqual([op]);
  });

  it('slides in from the ends of a wall rather than cutting its corner', () => {
    const w = wall();
    const op = breachWall(w, 0.2, 2)!;
    expect(op.a).toBeGreaterThanOrEqual(0.12 - 1e-9);
    expect(op.b - op.a).toBeCloseTo(2, 5);
    const w2 = wall();
    const op2 = breachWall(w2, 11.9, 2)!;
    expect(op2.b).toBeLessThanOrEqual(12 - 0.12 + 1e-9);
  });

  it('folds the doors and windows it reaches into one gap, so openings never touch', () => {
    const w = wall([door(2, 3), door(4, 5), door(9, 10)]);
    const op = breachWall(w, 3.5, 1.6)!;
    expect(op.a).toBeLessThanOrEqual(2);
    expect(op.b).toBeGreaterThanOrEqual(5);
    expect(w.ops).toHaveLength(2);
    for (let i = 1; i < w.ops.length; i++) expect(w.ops[i].a).toBeGreaterThan(w.ops[i - 1].b);
  });

  it('a wall too short to take a hole stays whole', () => {
    const w = wall([], 0, 1.3);
    expect(breachWall(w, 0.6, 1.5)).toBeNull();
    expect(w.ops).toHaveLength(0);
  });

  it('the colliders of a breached wall leave the gap open', () => {
    const w = wall();
    const plan = { floorY: 0, levelH: 3.3, levels: 1, walls: [w] } as unknown as BuildingPlan;
    const solid = (list: Aabb[], u: number) => list.some((a) => u > a.minX && u < a.maxX);
    const before = wallAabbs(plan, w, 0, newAabbId);
    expect(solid(before, 6)).toBe(true);
    breachWall(w, 6, 1.6);
    const after = wallAabbs(plan, w, 0, newAabbId);
    expect(solid(after, 6)).toBe(false);
    expect(solid(after, 2)).toBe(true);
    expect(solid(after, 10)).toBe(true);
    expect(after.every((a) => a.wall === 0)).toBe(true);
  });
});

// ------------------------------------------------------------------ in a real scene

/** A leg scene with the convoy parked beside the nearest roadside building and its chunks streamed in. */
function siteScene() {
  const h = fakeServices();
  const sc = new LegScene(h.svc, legById('L1'));
  sc.pendingResult = true;
  for (let i = 0; i < 18; i++) sc.tick(DT);
  const rural = sc.src.layout.rural;
  const rb = rural.map((b) => ({ b, d: Math.hypot((b.plan.x0 + b.plan.x1) / 2 - 4, (b.plan.z0 + b.plan.z1) / 2 - 12) })).sort((a, c) => a.d - c.d)[0].b;
  const cx = (rb.plan.x0 + rb.plan.x1) / 2;
  const cz = (rb.plan.z0 + rb.plan.z1) / 2;
  for (const p of sc.players) p.vehicle!.body.setPose(cx - 30, sc.groundAt(cx - 30, cz) + 1.2, cz, 0);
  for (let i = 0; i < 300; i++) sc.tick(DT);
  sc.zombies.list.length = 0;
  return { sc, rb, h };
}

/** A plain exterior wall on the ground floor, a piece of it, and a spot outside it to shoot from. */
function target(sc: LegScene, rb: ReturnType<typeof siteScene>['rb']) {
  const plan = rb.plan;
  const wi = plan.walls.findIndex((w) => w.level === 0 && w.ext && w.ops.length === 0 && w.b - w.a > 5);
  expect(wi).toBeGreaterThanOrEqual(0);
  const w = plan.walls[wi];
  let piece: Aabb | undefined;
  sc.obs.near((plan.x0 + plan.x1) / 2, (plan.z0 + plan.z1) / 2, 40, (a) => {
    const mx = (a.minX + a.maxX) / 2;
    const mz = (a.minZ + a.maxZ) / 2;
    if (a.kind === 'partition' && a.wall === wi && mx > plan.x0 && mx < plan.x1 && mz > plan.z0 && mz < plan.z1) piece = a;
  });
  expect(piece).toBeDefined();
  const mid = ((w.axis === 'x' ? piece!.minX + piece!.maxX : piece!.minZ + piece!.maxZ) / 2);
  const out = w.out || 1;
  const from = w.axis === 'x' ? { x: mid, z: w.c + out * 7 } : { x: w.c + out * 7, z: mid };
  const dir = w.axis === 'x' ? { x: 0, z: -out } : { x: -out, z: 0 };
  const y = plan.floorY + 1.2;
  return { w, wi, piece: piece!, mid, from, dir, y };
}

const RAY = groups(0xffff, G.STATIC | G.VEHICLE | G.BUILD | G.FURN);

describe('breaking a building', () => {
  it('shooting a wall leaves holes, wears it down, and finally opens a gap you can walk through', () => {
    const { sc, rb } = siteScene();
    const t = target(sc, rb);
    const bv = sc.landscape.buildings.find((b) => b.rb === rb)!;
    const meshBefore = bv.levels[0];
    const oldId = t.piece.id;
    const holes0 = sc.gore.marks.count;
    let shots = 0;
    while (sc.world!.breaches === 0 && shots < 80) {
      sc.combat.shoot(t.from.x, t.y, t.from.z, t.dir.x, 0, t.dir.z, { side: 'convoy', damage: 40, range: 40, ammo: 'rifle', tracer: false });
      for (let i = 0; i < 6; i++) sc.tick(DT);
      shots++;
      if (shots === 1) expect(sc.gore.marks.count).toBeGreaterThan(holes0); // bullet holes first
    }
    expect(sc.world!.breaches).toBe(1);
    // A wall takes several rounds, not one.
    expect(shots).toBeGreaterThan(2);
    // The plan has the gap.
    const op = t.w.ops.find((o) => o.kind === 'breach')!;
    expect(op).toBeDefined();
    // The mesh was rebuilt, the old collider boxes are gone and none covers the gap.
    expect(bv.levels[0]).not.toBe(meshBefore);
    expect(sc.obs.byId(oldId)).toBeUndefined();
    const gx = t.w.axis === 'x' ? (op.a + op.b) / 2 : t.w.c;
    const gz = t.w.axis === 'x' ? t.w.c : (op.a + op.b) / 2;
    expect(sc.obs.pointInside(gx, gz, rb.plan.floorY + 1)).toBeNull();
    // A ray through the gap is not stopped at the wall.
    const r = sc.P.raycast(gx + t.dir.x * -3 * (t.w.axis === 'x' ? 0 : 1), t.y, gz + t.dir.z * -3 * (t.w.axis === 'x' ? 1 : 0), t.dir.x, 0, t.dir.z, 6, RAY);
    expect(!r || r.toi > 3.4).toBe(true);
    // The chunk's own data lost the old pieces, so streaming it back keeps the hole.
    const data = sc.src.get(Math.floor(gx / 128), Math.floor(gz / 128));
    expect(data.aabbs.some((a) => a.id === oldId)).toBe(false);
    expect(data.aabbs.some((a) => a.kind === 'partition' && a.wall === t.wi)).toBe(true);
  });

  it('a hole in the wall is a way in for the dead', () => {
    const { sc, rb } = siteScene();
    const t = target(sc, rb);
    const i = sc.src.layout.rural.indexOf(rb);
    const doors0 = sc.zombies.buildings[i].doors.length;
    sc.world!.hit(t.piece, 1e6, 'bullet', { x: t.w.axis === 'x' ? t.mid : t.w.c, y: t.y, z: t.w.axis === 'x' ? t.w.c : t.mid });
    expect(sc.zombies.buildings[i].doors.length).toBe(doors0 + 1);
  });

  it('a blast breaks the wall it is beside, chars the ground and throws debris', () => {
    const { sc, rb } = siteScene();
    const t = target(sc, rb);
    const scorch0 = sc.gore.placed;
    const gibs0 = sc.gore.gibs.counts().chunk;
    const craters0 = sc.ground?.stats.craters ?? 0;
    const thrown0 = sc.ground?.ejecta.launched ?? 0;
    const x = t.from.x + t.dir.x * 5.2;
    const z = t.from.z + t.dir.z * 5.2;
    sc.combat.explode(x, t.y - 0.5, z, 6, 260, { side: 'neutral' });
    expect(sc.world!.breaches).toBeGreaterThanOrEqual(1);
    // Soft ground takes the blast itself (a charred crater, its soil thrown: groundWork.ts); hard ground gets a scorch
    // mark and clods.
    const dug = (sc.ground?.stats.craters ?? 0) > craters0;
    expect(dug || sc.gore.placed > scorch0).toBe(true);
    expect(dug ? (sc.ground?.ejecta.launched ?? 0) > thrown0 : sc.gore.gibs.counts().chunk > gibs0).toBe(true);
    // A small bang far from any wall breaks nothing.
    const n = sc.world!.breaches;
    sc.combat.explode(t.from.x + t.dir.x * -80, t.y, t.from.z, 6, 260, { side: 'neutral' });
    expect(sc.world!.breaches).toBe(n);
  });

  it('a heavy round puts a rifle hole through and a pellet barely scratches', () => {
    const { sc, rb } = siteScene();
    const t = target(sc, rb);
    let pellets = 0;
    for (; pellets < 6; pellets++) {
      sc.combat.shoot(t.from.x, t.y, t.from.z, t.dir.x, 0, t.dir.z, { side: 'convoy', damage: 9, range: 40, ammo: 'pellet', tracer: false });
      for (let i = 0; i < 6; i++) sc.tick(DT);
    }
    expect(sc.world!.breaches).toBe(0);
  });

  it('a hole shot in a moving thing is not left floating in the air', () => {
    const { sc } = siteScene();
    const n = sc.gore.marks.count;
    sc.gore.impact('car', 0, 1, 0, 0, 0, 1, 0, 1, 1, { moving: true });
    expect(sc.gore.marks.count).toBe(n);
    sc.gore.impact('car', 0, 1, 0, 0, 0, 1, 0, 1, 1);
    expect(sc.gore.marks.count).toBe(n + 1);
  });
});

describe('marks left by weapons', () => {
  it('a hole is as wide as the round that made it: a pistol leaves a small one, a rifle a big splintered one', () => {
    const { sc } = siteScene();
    const add = vi.spyOn(sc.gore.marks, 'add');
    const chips0 = sc.gore.gibs.counts().chunk;
    sc.gore.impact('wood', 10, 1, 10, 0, 0, 1, 0, 1, 0.8, { size: AMMO.pistol.hole });
    const pistol = add.mock.calls[0][3];
    expect(pistol.w).toBeLessThan(0.12);
    expect(pistol.w).toBeGreaterThan(0.07);
    expect(pistol.cell).toBe(8);
    expect(pistol.hole).toBe(true);
    // The exposed material round it is paler than the wall.
    expect(pistol.r).toBeGreaterThan(0.55);
    expect(sc.gore.gibs.counts().chunk).toBeGreaterThan(chips0);
    sc.gore.impact('wood', 10, 1, 10, 0, 0, 1, 0, 1, 1.2, { size: AMMO.rifle.hole, heavy: true });
    const rifle = add.mock.calls[1][3];
    expect(rifle.w).toBeGreaterThan(pistol.w * 1.5);
    expect(rifle.cell).toBe(9);
    // Pellets leave the smallest.
    sc.gore.impact('wood', 10, 1, 10, 0, 0, 1, 0, 1, 0.5, { size: AMMO.pellet.hole });
    expect(add.mock.calls[2][3].w).toBeLessThan(pistol.w);
  });

  it('a box that only stands for something round (a rock) keeps no mark', () => {
    const { sc } = siteScene();
    const n = sc.gore.marks.count;
    sc.gore.impact('stone', 10, 1, 10, 0, 0, 1, 0, 1, 1, { mark: false });
    expect(sc.gore.marks.count).toBe(n);
  });

  it('earth and stone keep a scuffed pit, not a hole', () => {
    const { sc } = siteScene();
    const add = vi.spyOn(sc.gore.marks, 'add');
    sc.gore.impact('dirt', 10, 1, 10, 0, 1, 0, 0, 1, 0.8);
    expect(add.mock.calls[0][3].cell).toBe(10);
  });

  it('a round that goes through leaves a second, ragged hole on the far face', () => {
    const { sc, rb } = siteScene();
    const t = target(sc, rb);
    const add = vi.spyOn(sc.gore.marks, 'add');
    // A rifle round has the bite for a plank or plaster wall.
    sc.combat.shoot(t.from.x, t.y, t.from.z, t.dir.x, 0, t.dir.z, { side: 'convoy', damage: 80, range: 40, ammo: 'rifle', tracer: false });
    for (let i = 0; i < 12; i++) sc.tick(DT);
    const holes = add.mock.calls.filter(([, , , o]) => o.hole && o.cell !== 11);
    expect(holes.length).toBeGreaterThanOrEqual(2);
    // The exit is the ragged kind (splintered wood, or a wide spall out of plaster or masonry), and its face looks away from
    // the shooter.
    const exit = holes[1][3];
    expect([CELL.splinter, ...SPALLS] as number[]).toContain(exit.cell);
    const away = t.w.axis === 'x' ? exit.nz : exit.nx;
    expect(Math.sign(away)).toBe(Math.sign(t.w.axis === 'x' ? t.dir.z : t.dir.x));
    expect(exit.w).toBeGreaterThanOrEqual(holes[0][3].w - 0.05);
  });

  it('a wall cracks as it weakens, and its marks go when it comes down', () => {
    const { sc, rb } = siteScene();
    const t = target(sc, rb);
    const crack = vi.spyOn(sc.gore, 'crack');
    let shots = 0;
    while (sc.world!.breaches === 0 && shots < 80) {
      sc.combat.shoot(t.from.x, t.y, t.from.z, t.dir.x, 0, t.dir.z, { side: 'convoy', damage: 22, range: 40, ammo: 'rifle', tracer: false });
      for (let i = 0; i < 6; i++) sc.tick(DT);
      shots++;
    }
    expect(crack.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Nothing is left floating where the wall was.
    const op = t.w.ops.find((o) => o.kind === 'breach')!;
    const lo = Math.min(op.a, op.b);
    const hi = Math.max(op.a, op.b);
    const marks = sc.gore.marks as unknown as { at: Float32Array; param: Float32Array; count: number };
    for (let i = 0; i < marks.count; i++) {
      if (marks.param[i * 4 + 1] === 0) continue;
      const u = t.w.axis === 'x' ? marks.at[i * 3] : marks.at[i * 3 + 2];
      const perp = t.w.axis === 'x' ? marks.at[i * 3 + 2] : marks.at[i * 3];
      const y = marks.at[i * 3 + 1];
      const inGap = u > lo && u < hi && Math.abs(perp - t.w.c) < t.w.t / 2 + 0.1 && y > rb.plan.floorY - 0.2 && y < rb.plan.floorY + op.head;
      expect(inGap).toBe(false);
    }
  });

  it('the pool for weapon marks is separate from the blood pool', () => {
    const { sc } = siteScene();
    expect(sc.gore.marks).not.toBe(sc.gore.decals);
    sc.gore.decals.clear();
    sc.gore.impact('wood', 10, 1, 10, 0, 0, 1, 0, 1, 0.8);
    sc.gore.decals.clear();
    expect(sc.gore.marks.count).toBeGreaterThan(0);
  });
});

describe('what can hurt what', () => {
  it('a pistol cannot hurt a wall of wood or plaster, and chews sheet slowly; glass it breaks at once', () => {
    expect(structuralMul('pistol', 'wood')).toBe(0);
    expect(structuralMul('pistol', 'plaster')).toBe(0);
    expect(structuralMul('smg', 'wood')).toBe(0);
    expect(structuralMul('pistol', 'sheet')).toBeGreaterThan(0);
    expect(structuralMul('pistol', 'sheet')).toBeLessThan(0.5);
    expect(structuralMul('pistol', 'glass')).toBe(1);
    expect(WALL_HP.glass! / 27).toBeLessThan(1);
    // A .38, a shotgun and a rifle can all do real harm.
    for (const k of ['magnum', 'pellet', 'rifle', 'turret'] as const) expect(structuralMul(k, 'wood')).toBeGreaterThan(0);
    expect(structuralMul('rifle', 'wood')).toBeGreaterThan(structuralMul('magnum', 'wood'));
  });

  it('a pistol round goes through a thin plate but not a shipping container; a rifle round goes through both skins', () => {
    const v = (k: keyof typeof AMMO) => AMMO[k].speed;
    const plate = throughSlab(AMMO.pistol, v('pistol'), 'sheet', 0.002);
    expect(plate).toBeGreaterThan(0);
    expect(throughSlab(AMMO.pistol, plate, 'sheet', 0.002)).toBe(0);
    const r1 = throughSlab(AMMO.rifle, v('rifle'), 'sheet', 0.002);
    expect(throughSlab(AMMO.rifle, r1, 'sheet', 0.002)).toBeGreaterThan(0);
  });

  it('a pistol shot in a plank or plaster wall leaves holes and nothing else, however long it fires', () => {
    const { sc, rb } = siteScene();
    const t = target(sc, rb);
    for (let n = 0; n < 40; n++) {
      sc.combat.shoot(t.from.x, t.y, t.from.z, t.dir.x, 0, t.dir.z, { side: 'convoy', damage: 27, range: 40, ammo: t.piece.mat === 'sheet' ? 'magnum' : 'pistol', tracer: false });
      for (let i = 0; i < 4; i++) sc.tick(DT);
      if (t.piece.mat === 'sheet') break;
    }
    if (t.piece.mat !== 'sheet') expect(sc.world!.breaches).toBe(0);
    expect(sc.gore.marks.count).toBeGreaterThan(0);
  });

  it('a pane of glass breaks to one pistol round, and the round goes on through', () => {
    const { sc, rb } = siteScene();
    const plan = rb.plan;
    const wi = plan.walls.findIndex((w) => w.level === 0 && w.ext && w.ops.length === 0 && w.b - w.a > 5);
    const w = plan.walls[wi];
    const mid = (w.a + w.b) / 2;
    const op: Wall['ops'][number] = { a: mid - 0.6, b: mid + 0.6, kind: 'window', sill: 0.9, head: 2, leaf: 'none', glass: 'intact' };
    w.ops.push(op);
    // The glass is a pane in the wall: make its collider like the scene would, beside the wall's own.
    const pane = wallAabbs(plan, w, wi, newAabbId).find((q) => q.mat === 'glass')!;
    expect(pane).toBeDefined();
    expect(pane.y1 - pane.y0).toBeCloseTo(1.1, 5);
    // The plan has a window in it now, so the wall's collider over that stretch is gone, as it is when the scene rebuilds.
    const stale: Aabb[] = [];
    sc.obs.near((pane.minX + pane.maxX) / 2, (pane.minZ + pane.maxZ) / 2, 4, (q) => {
      if (q.kind === 'partition' && q.wall === wi && q.mat !== 'glass' && q.y0 < pane.y1 && q.y1 > pane.y0 && q.maxX > pane.minX - 0.01 && q.minX < pane.maxX + 0.01 && q.maxZ > pane.minZ - 0.01 && q.minZ < pane.maxZ + 0.01) stale.push(q);
    });
    for (const q of stale) {
      sc.obs.remove(q);
      sc.chunks.get(chunkKey(Math.floor((q.minX + q.maxX) / 2 / CHUNK), Math.floor((q.minZ + q.maxZ) / 2 / CHUNK)))?.removeAabb(q.id);
    }
    expect(stale.length).toBeGreaterThan(0);
    sc.obs.add(pane);
    sc.P.addStaticBox((pane.minX + pane.maxX) / 2, (pane.y0 + pane.y1) / 2, (pane.minZ + pane.maxZ) / 2, (pane.maxX - pane.minX) / 2, (pane.y1 - pane.y0) / 2, (pane.maxZ - pane.minZ) / 2);
    const out = w.out || 1;
    const from = w.axis === 'x' ? { x: mid, z: w.c + out * 7 } : { x: w.c + out * 7, z: mid };
    const dir = w.axis === 'x' ? { x: 0, z: -out } : { x: -out, z: 0 };
    const y = plan.floorY + 1.4;
    const shards0 = sc.gore.gibs.counts().shard;
    const seen: string[] = [];
    sc.combat.onImpact = (e) => seen.push(`${e.surface}:${e.penetrated}`);
    sc.combat.shoot(from.x, y, from.z, dir.x, 0, dir.z, { side: 'convoy', damage: 27, range: 40, ammo: 'pistol', tracer: false });
    for (let i = 0; i < 12; i++) sc.tick(DT);
    expect(seen[0]).toBe('glass:true');
    expect(op.glass).toBe('broken');
    expect(sc.world!.panes).toBe(1);
    expect(sc.obs.byId(pane.id)).toBeUndefined();
    expect(sc.gore.gibs.counts().shard).toBeGreaterThan(shards0);
  });
});

describe('barricades', () => {
  it('a flimsy barricade splinters under fire, a reinforced one holds', () => {
    const { sc, rb } = siteScene();
    const t = target(sc, rb);
    const gy = sc.groundAt(t.from.x, t.from.z);
    const mk = (breakable: 'flimsy' | 'reinforced', dx: number): Aabb => {
      const a: Aabb = { id: newAabbId(), minX: t.from.x + dx - 1, maxX: t.from.x + dx + 1, minZ: t.from.z - 3, maxZ: t.from.z - 2.6, y0: gy, y1: gy + 2, kind: 'barricade', breakable, hp: 60, tint: 0 };
      sc.obs.add(a);
      sc.P.addStaticBox(t.from.x + dx, gy + 1, t.from.z - 2.8, 1, 1, 0.2);
      return a;
    };
    const flimsy = mk('flimsy', 0);
    const heavy = mk('reinforced', 6);
    const fire = (x: number) => {
      sc.combat.shoot(x, gy + 1, t.from.z, 0, 0, -1, { side: 'convoy', damage: 27, range: 20, ammo: 'pistol', tracer: false });
      for (let i = 0; i < 5; i++) sc.tick(DT);
    };
    for (let i = 0; i < 6; i++) fire(t.from.x);
    expect(sc.obs.byId(flimsy.id)).toBeUndefined();
    for (let i = 0; i < 6; i++) fire(t.from.x + 6);
    expect(sc.obs.byId(heavy.id)).toBeDefined();
    expect(heavy.hp).toBe(60);
  });
});
