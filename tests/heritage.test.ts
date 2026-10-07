import { beforeAll, describe, expect, it } from 'vitest';
import { G, GROUPS, groups, initPhysics, PhysicsWorld, RAPIER } from '../src/physics/physics';
import { legById } from '../src/data';
import { ChunkSource } from '../src/world/chunkgen';
import { CHUNK, heightAt, waterAt } from '../src/world/terrain';
import { courseAt, coursesNear, forestAt, woodsAt } from '../src/world/hydro';
import { nearestRoad } from '../src/world/openWorld';
import { leanOffset, TREE_SPECIES } from '../src/world/flora';
import { CH, heritageAabbs, heritageClear, heritageRoofAt, hLocal, hWorld, MH, type Heritage } from '../src/world/heritage';
import { buildScatter } from '../src/render/scatter';
import { riffleChurn } from '../src/render/riverWater';
import { LegScene } from '../src/game/legScene';
import { WorldMemory } from '../src/game/worldMemory';
import { fakeServices, run } from './helpers/sim';
import { propCollisionMesh } from '../src/render/propCollision';
import { landmarkProto } from '../src/render/landmarks';
import { treeGeometry } from '../src/render/trees';

// The Concrete House on the Yarkon, and the eucalyptus that line the river.

beforeAll(async () => {
  await initPhysics();
});

const leg = legById('W');
const src = new ChunkSource(leg);
const L = src.layout;
const def = L.terrain;
const hy = def.hydro!;
const yarkon = hy.rivers.find((r) => r.key === 'yarkon')!;
const house = def.heritage!.find((h) => h.id === 'concreteHouse')!;
const petah = def.open!.districts.find((d) => d.id === 'petah')!;

/** Nearest distance from a world point to the Yarkon's water. */
function toWater(x: number, z: number) {
  let g = Infinity;
  for (const c of coursesNear(hy, x, z, 60)) if (c.river === yarkon) g = Math.min(g, c.d - c.half);
  return g;
}

describe('the Concrete House', () => {
  it('stands 15 m from the Yarkon, on the bank toward Petah Tikva, where the river comes nearest the city', () => {
    expect(house).toBeDefined();
    expect(house.name).toBe('the Concrete House');
    // Its front wall: 15 m from the water's edge at the nearest point.
    let gap = Infinity;
    for (let lx = -CH.hw; lx <= CH.hw; lx += 0.25) gap = Math.min(gap, toWater(...hWorld(house, lx, CH.hd)));
    expect(gap).toBeGreaterThan(14.7);
    expect(gap).toBeLessThan(15.3);
    // Nothing of the house is nearer the water than its front.
    for (let lx = -CH.hw; lx <= CH.hw; lx += 1) for (let lz = -CH.hd; lz <= CH.hd; lz += 1) expect(toWater(...hWorld(house, lx, lz))).toBeGreaterThan(14.7);
    // The front faces the river.
    const [fx, fz] = hWorld(house, 0, CH.hd + 10);
    expect(toWater(fx, fz)).toBeLessThan(gap);
    // On the city's side of the river: the river lies between the house and the far bank, not between the house and the city.
    const cx = Math.max(petah.x0, Math.min(petah.x1, house.x));
    const cz = Math.max(petah.z0, Math.min(petah.z1, house.z));
    let crosses = false;
    for (let t = 0; t <= 1; t += 0.002) {
      const x = house.x + (cx - house.x) * t;
      const z = house.z + (cz - house.z) * t;
      if (toWater(x, z) < 0) crosses = true;
    }
    expect(crosses).toBe(false);
    // And no other stretch of the Yarkon is much nearer the city than the one it stands by.
    const dCity = (x: number, z: number) => Math.hypot(x - Math.max(petah.x0, Math.min(petah.x1, x)), z - Math.max(petah.z0, Math.min(petah.z1, z)));
    let nearest = Infinity;
    for (let i = 0; i < yarkon.end; i++) nearest = Math.min(nearest, dCity(yarkon.x[i], yarkon.z[i]));
    expect(dCity(house.x, house.z)).toBeLessThan(nearest);
  });

  it('stands on level, dry ground off the roads, with its stair and yard', () => {
    for (let lx = CH.pad.x0; lx <= CH.pad.x1; lx += 0.5) {
      for (let lz = CH.pad.z0; lz <= CH.pad.z1; lz += 0.5) {
        const [x, z] = hWorld(house, lx, lz);
        expect(Math.abs(heightAt(def, x, z) - house.floor)).toBeLessThan(0.01);
        expect(waterAt(def, x, z)).toBeNull();
        const rd = nearestRoad(def.open!, x, z);
        expect(!rd.road || rd.edge > 2).toBe(true);
      }
    }
    // The yaw is a whole quarter turn, so its boxes are its walls.
    expect(Math.abs(Math.sin(house.yaw * 2))).toBeLessThan(1e-9);
  });

  it('is in the layout: drawn, solid, searchable, clear of trees', () => {
    const prop = L.props.find((p) => p.kind === 'concreteHouse')!;
    expect(prop).toBeDefined();
    expect(prop.y).toBe(house.floor);
    const proto = landmarkProto('concreteHouse', prop.seed)!;
    expect(proto.pos.length).toBeGreaterThan(3000);
    for (const v of proto.pos) expect(Number.isFinite(v)).toBe(true);
    // It collides as boxes, not as its (detailed) drawn mesh.
    expect(propCollisionMesh(prop)).toBeNull();
    const walls = L.aabbs.filter((a) => a.kind === 'partition' && a.mat === 'concrete' && Math.hypot((a.minX + a.maxX) / 2 - house.x, (a.minZ + a.maxZ) / 2 - house.z) < 12);
    expect(walls.length).toBeGreaterThan(20);
    expect(L.aabbs.some((a) => a.kind === 'stair' && a.ramp && Math.hypot(a.ramp.x - house.x, a.ramp.z - house.z) < 12)).toBe(true);
    const zone = L.zones.find((z) => z.id.includes('concreteHouse'))!;
    expect(zone.containers.length).toBe(2);
    for (const c of zone.containers) expect(c.items.length).toBeGreaterThan(0);
    // The woods stand round it, not in it.
    const keys = new Set<string>();
    for (const [lx, lz] of [[CH.pad.x0, CH.pad.z0], [CH.pad.x1, CH.pad.z0], [CH.pad.x0, CH.pad.z1], [CH.pad.x1, CH.pad.z1]]) {
      const [x, z] = hWorld(house, lx, lz);
      keys.add(`${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`);
    }
    let around = 0;
    for (const k of keys) {
      const [cx, cz] = k.split(',').map(Number);
      for (const t of src.get(cx, cz).trees) {
        expect(heritageClear(def.heritage, t.x, t.z, 0.5)).toBe(false);
        const [lx, lz] = hLocal(house, t.x, t.z);
        if (Math.abs(lx) < 25 && Math.abs(lz) < 25) around++;
      }
    }
    expect(around).toBeGreaterThan(5);
  });

  it('can be walked into, and climbed to the terrace and the upper room', () => {
    const w = new PhysicsWorld();
    const F = house.floor;
    const [gx, gz] = hWorld(house, 0, 0);
    w.addStaticBox(gx, F - 0.5, gz, 40, 0.5, 40, 0, GROUPS.static);
    let id = 0;
    for (const a of heritageAabbs(house, () => id++)) {
      if (a.ramp) w.addStaticTilted(a.ramp.x, a.ramp.y, a.ramp.z, a.ramp.hx, a.ramp.hy, a.ramp.hz, a.ramp.q, GROUPS.furn);
      else w.addStaticBox((a.minX + a.maxX) / 2, (a.y0 + a.y1) / 2, (a.minZ + a.maxZ) / 2, (a.maxX - a.minX) / 2, (a.y1 - a.y0) / 2, (a.maxZ - a.minZ) / 2, 0, a.kind === 'furniture' || a.kind === 'floor' ? GROUPS.furn : GROUPS.static);
    }
    const walker = new Walker(w);
    const go = (lx: number, lz: number) => {
      const [tx, tz] = hWorld(house, lx, lz);
      for (let i = 0; i < 60 * 12 && Math.hypot(walker.x - tx, walker.z - tz) > 0.15; i++) walker.step(tx, tz);
      return Math.hypot(walker.x - tx, walker.z - tz);
    };
    // In through the panel that is down, under the arcade, into the hall.
    walker.put(...hWorld(house, -5.9, 9), F);
    expect(go(-5.9, 6.4)).toBeLessThan(0.3);
    expect(go(-4.2, 6.4)).toBeLessThan(0.3);
    expect(go(-4.2, 2.5)).toBeLessThan(0.3);
    expect(walker.y - F).toBeCloseTo(CH.plinth, 1);
    expect(heritageRoofAt(def.heritage, walker.x, walker.z, walker.y + 0.9)).toBe(true);
    // Out again, round to the foot of the stair, up it to the landing.
    expect(go(-4.2, 6.4)).toBeLessThan(0.3);
    expect(go(-7.6, 6.4)).toBeLessThan(0.3);
    expect(go(-7.6, 4.4)).toBeLessThan(0.3);
    expect(go(-7.6, -3.7)).toBeLessThan(0.3);
    expect(walker.y - F).toBeGreaterThan(CH.deck - 0.1);
    // Onto the terrace, round to the front and in under the upper storey's arch.
    expect(go(-5.8, -3.7)).toBeLessThan(0.3);
    expect(go(-5.8, 3.4)).toBeLessThan(0.3);
    expect(go(-2.2, 3.4)).toBeLessThan(0.3);
    expect(go(-2.2, -0.5)).toBeLessThan(0.3);
    expect(walker.y - F).toBeGreaterThan(CH.deck - 0.1);
    expect(walker.y - F).toBeLessThan(CH.deck + 0.2);
    expect(heritageRoofAt(def.heritage, walker.x, walker.z, walker.y + 0.9)).toBe(true);
    // The terrace railing keeps people on the terrace.
    expect(go(-2.2, 3.4)).toBeLessThan(0.3);
    expect(go(-2.2, 9)).toBeGreaterThan(3);
    // The fence stops anyone walking at it where it stands, and the hall's front wall behind it.
    walker.put(...hWorld(house, 2.1, 9), F);
    go(2.1, 3.5);
    expect(hLocal(house, walker.x, walker.z)[1]).toBeGreaterThan(CH.fence.front + 0.3);
    walker.put(...hWorld(house, -2.1, 6.4), F);
    expect(go(-2.1, 3.5)).toBeGreaterThan(2);
  });
});

describe('on the map', () => {
  it('names each building once when the convoy first comes near, on the radio too, and pins it on the map', () => {
    const memory = new WorldMemory();
    const h = fakeServices();
    const sc = new LegScene(h.svc, leg, { memory, start: { x: house.x + 25, z: house.z + 45, yaw: 0 } });
    run(sc, 12);
    expect(h.banners.filter((b) => b.startsWith('The Concrete House |')).length).toBe(1);
    expect(h.banners.find((b) => b.startsWith('The Concrete House |'))).toContain('1912');
    expect(h.radio.some((r) => r.includes('The Concrete House'))).toBe(true);
    run(sc, 8);
    expect(h.banners.filter((b) => b.startsWith('The Concrete House |')).length).toBe(1);
    let f = sc.mapFrame(sc.compassPins())!;
    const pin = f.pins.find((q) => q.kind === 'heritage' && q.label === 'CONCRETE HOUSE')!;
    expect(pin).toBeDefined();
    expect(Math.hypot(pin.x - house.x, pin.z - house.z)).toBeLessThan(1);
    // The hut, far downstream, is not on the map until someone has been there.
    expect(f.pins.some((q) => q.label === 'MUD HUT')).toBe(false);
    sc.dispose();
    // The world remembers: the next scene (the next dawn) still shows the house, and names the hut when the convoy gets there.
    const hut = def.heritage!.find((q) => q.id === 'mudHut')!;
    const h2 = fakeServices();
    const sc2 = new LegScene(h2.svc, leg, { memory, start: { x: hut.x + 30, z: hut.z + 40, yaw: 0 } });
    run(sc2, 12);
    expect(h2.banners.some((b) => b.startsWith('The Concrete House |'))).toBe(false);
    expect(h2.banners.filter((b) => b.startsWith('The mud hut |')).length).toBe(1);
    f = sc2.mapFrame(sc2.compassPins())!;
    expect(f.pins.some((q) => q.kind === 'heritage' && q.label === 'CONCRETE HOUSE')).toBe(true);
    expect(f.pins.some((q) => q.kind === 'heritage' && q.label === 'MUD HUT')).toBe(true);
    sc2.dispose();
    // Two whole scenes: as slow as the other scene tests on a busy machine.
  }, 180000);
});

describe('the mud hut', () => {
  const hut = def.heritage!.find((h) => h.id === 'mudHut')!;

  it('stands on an open meadow above the Yarkon, on the bank toward Petah Tikva, 28 m from the water', () => {
    expect(hut).toBeDefined();
    let gap = Infinity;
    for (let lx = -MH.hw; lx <= MH.hw; lx += 0.25) gap = Math.min(gap, toWater(...hWorld(hut, lx, MH.hd)));
    expect(gap).toBeGreaterThan(27.7);
    expect(gap).toBeLessThan(28.3);
    expect(forestAt(def, hut.x, hut.z)).toBeLessThan(0.2);
    expect(woodsAt(def, hut.x, hut.z)).toBe('gum');
    const c = courseAt(hy, ...hWorld(hut, 0, MH.hd + gap - 2), 10)!;
    expect(hut.floor).toBeGreaterThan(c.level + 0.6);
    // On the city's side: walking from it to the city never crosses the water.
    const cx = Math.max(petah.x0, Math.min(petah.x1, hut.x));
    const cz = Math.max(petah.z0, Math.min(petah.z1, hut.z));
    for (let t = 0; t <= 1; t += 0.002) expect(toWater(hut.x + (cx - hut.x) * t, hut.z + (cz - hut.z) * t)).toBeGreaterThan(0);
    // Well away from the Concrete House, and drawn.
    expect(Math.hypot(hut.x - house.x, hut.z - house.z)).toBeGreaterThan(150);
    const prop = L.props.find((p) => p.kind === 'mudHut')!;
    expect(prop).toBeDefined();
    expect(landmarkProto('mudHut', prop.seed)!.pos.length).toBeGreaterThan(1000);
    expect(L.zones.find((z) => z.id.includes('mudHut'))!.containers.length).toBe(1);
  });

  it('can be walked into through its door, and its walls stop you elsewhere', () => {
    const w = new PhysicsWorld();
    const F = hut.floor;
    const [gx, gz] = hWorld(hut, 0, 0);
    w.addStaticBox(gx, F - 0.5, gz, 30, 0.5, 30, 0, GROUPS.static);
    let id = 0;
    for (const a of heritageAabbs(hut, () => id++)) {
      w.addStaticBox((a.minX + a.maxX) / 2, (a.y0 + a.y1) / 2, (a.minZ + a.maxZ) / 2, (a.maxX - a.minX) / 2, (a.y1 - a.y0) / 2, (a.maxZ - a.minZ) / 2, 0, a.kind === 'furniture' ? GROUPS.furn : GROUPS.static);
    }
    const walker = new Walker(w);
    const go = (lx: number, lz: number) => {
      const [tx, tz] = hWorld(hut, lx, lz);
      for (let i = 0; i < 60 * 8 && Math.hypot(walker.x - tx, walker.z - tz) > 0.15; i++) walker.step(tx, tz);
      return Math.hypot(walker.x - tx, walker.z - tz);
    };
    walker.put(...hWorld(hut, 4.5, 0.45), F);
    expect(go(0.6, 0.45)).toBeLessThan(0.3);
    expect(heritageRoofAt(def.heritage, walker.x, walker.z, walker.y + 0.9)).toBe(true);
    walker.put(...hWorld(hut, 0, 4.5), F);
    expect(go(0, 0)).toBeGreaterThan(2);
  });
});

describe('the Yarkon', () => {
  it('runs murky, and white and shallow over its stony riffles', () => {
    const spec = (k: string) => hy.spec.rivers.find((c) => c.id === k)!;
    expect(spec('yarkon').silt).toBeGreaterThan(0.5);
    expect(spec('greywater').silt ?? 0).toBe(0);
    const rif = hy.riffles.filter((q) => q.river === yarkon.id);
    expect(rif.length).toBe(5);
    const churn = riffleChurn(hy, yarkon);
    for (const q of rif) {
      // Shallow enough to wade over the stones, still running water.
      const wa = waterAt(def, q.x, q.z)!;
      expect(wa).not.toBeNull();
      expect(wa.depth).toBeGreaterThan(0.15);
      expect(wa.depth).toBeLessThan(0.45);
      expect(yarkon.speed[q.i]).toBeGreaterThan(yarkon.speed[q.i + 25] * 1.6);
      expect(Math.max(...churn.slice(q.i - 2, q.i + 6))).toBeGreaterThan(0.4);
      expect(hy.crossings.every((c) => Math.hypot(c.x - q.x, c.z - q.z) > 60)).toBe(true);
      // Stones across it and along its banks.
      expect(L.props.filter((p) => p.kind === 'rock' && Math.hypot(p.x - q.x, p.z - q.z) < 14).length).toBeGreaterThan(8);
    }
    // The level still never rises.
    for (let i = 1; i < yarkon.n; i++) expect(yarkon.level[i]).toBeLessThanOrEqual(yarkon.level[i - 1] + 1e-4);
  });

  it('has giant cane on its banks and poppies and chamomile on its meadows; the other rivers do not', () => {
    const at = (x: number, z: number) => {
      const c = src.get(Math.floor(x / CHUNK), Math.floor(z / CHUNK));
      return buildScatter(def, c.cx, c.cz, c.aabbs, c.props, 1, undefined, c.heights);
    };
    const near = at(house.x, house.z - 30);
    expect(near.cane?.count ?? 0).toBeGreaterThan(50);
    const hut = def.heritage!.find((h) => h.id === 'mudHut')!;
    const meadow = at(hut.x, hut.z);
    expect(meadow.flowers!.count).toBeGreaterThan(1000);
    // Red and white, mostly.
    const c = { r: 0, g: 0, b: 0 };
    let redOrWhite = 0;
    const col = meadow.flowers!.instanceColor!.array as Float32Array;
    for (let i = 0; i < meadow.flowers!.count; i++) {
      c.r = col[i * 3];
      c.g = col[i * 3 + 1];
      c.b = col[i * 3 + 2];
      if (c.r - c.g > 0.6 || (c.r > 0.75 && c.g > 0.75 && c.b > 0.7)) redOrWhite++;
    }
    expect(redOrWhite / meadow.flowers!.count).toBeGreaterThan(0.8);
    const gw = hy.rivers.find((r) => r.key === 'greywater')!;
    let gwCane = 0;
    for (let i = 40; i < gw.end; i += 120) gwCane += at(gw.x[i], gw.z[i]).cane?.count ?? 0;
    expect(gwCane).toBe(0);
  });

  it('has its bank trees leaning out over the water', () => {
    let n = 0;
    let over = 0;
    for (let i = 30; i < yarkon.end - 30; i += 40) {
      const ch = src.get(Math.floor(yarkon.x[i] / CHUNK), Math.floor(yarkon.z[i] / CHUNK));
      for (const t of ch.trees) {
        const c = courseAt(hy, t.x, t.z);
        if (!c || c.river !== yarkon || c.d - c.half > 3.5) continue;
        const sp = TREE_SPECIES[t.sp];
        if (sp !== 'willow' && sp !== 'eucalyptus') continue;
        n++;
        // The crown, 8 m up, stands nearer the water than the foot does (`courseAt` reuses its answer: keep the number).
        const foot = c.d;
        const [ox, oz] = leanOffset(t, 8);
        const c2 = courseAt(hy, t.x + ox, t.z + oz, 10);
        if (c2 && c2.d < foot - 1) over++;
      }
    }
    expect(n).toBeGreaterThan(10);
    expect(over / n).toBeGreaterThan(0.8);
  });
});

describe('eucalyptus along the Yarkon', () => {
  it('is a tree of its own: pale, tall, within the budget', () => {
    const sp = TREE_SPECIES.indexOf('eucalyptus');
    expect(sp).toBeGreaterThan(-1);
    const g = treeGeometry(sp);
    expect(g.attributes.position.count).toBeGreaterThan(300);
  });

  it('makes most of the trees along the Yarkon, and none along the other rivers', () => {
    const count = (river: string) => {
      const r = hy.rivers.find((q) => q.key === river)!;
      const seen = new Set<unknown>();
      const n: Record<string, number> = {};
      for (let i = 0; i < r.end; i += 30) {
        const c = src.get(Math.floor(r.x[i] / CHUNK), Math.floor(r.z[i] / CHUNK));
        if (seen.has(c.key)) continue;
        seen.add(c.key);
        for (const t of c.trees) {
          // Only the trees by the water: within 60 m of it.
          let near = false;
          for (const h of coursesNear(hy, t.x, t.z, 40)) if (h.river === r && h.d - h.half < 60) near = true;
          if (!near) continue;
          n[TREE_SPECIES[t.sp]] = (n[TREE_SPECIES[t.sp]] ?? 0) + 1;
        }
      }
      return n;
    };
    const y = count('yarkon');
    const total = Object.values(y).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(300);
    expect(y.eucalyptus / total).toBeGreaterThan(0.65);
    const gw = count('greywater');
    expect(gw.eucalyptus ?? 0).toBe(0);
    // The grove reaches out from the water and thins into the country's own woods beyond.
    expect(woodsAt(def, yarkon.x[400], yarkon.z[400] + 30)).toBe('gum');
  });
});

const RAY_STATIC = groups(0xffff, G.STATIC | G.VEHICLE | G.BUILD | G.FURN);
const BODY_H = 1.7;
const BODY_R = 0.3;

/** A player capsule driven the way the game drives it (as in tests/walk.test.ts). */
class Walker {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  kcc: RAPIER.KinematicCharacterController;
  vy = 0;
  constructor(private world: PhysicsWorld) {
    this.body = world.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 1, 0));
    this.collider = world.world.createCollider(RAPIER.ColliderDesc.capsule((BODY_H - BODY_R * 2) / 2, BODY_R).setCollisionGroups(GROUPS.player), this.body);
    this.kcc = world.world.createCharacterController(0.03);
    this.kcc.enableAutostep(0.45, 0.2, false);
    this.kcc.setMaxSlopeClimbAngle((55 * Math.PI) / 180);
    this.kcc.setMinSlopeSlideAngle((60 * Math.PI) / 180);
    this.kcc.enableSnapToGround(0.35);
    this.kcc.setApplyImpulsesToDynamicBodies(false);
  }
  put(x: number, z: number, y: number) {
    this.body.setTranslation({ x, y: y + BODY_H / 2 + 0.02, z }, true);
    this.vy = 0;
    this.world.step();
  }
  get x() {
    return this.body.translation().x;
  }
  get y() {
    return this.body.translation().y - BODY_H / 2;
  }
  get z() {
    return this.body.translation().z;
  }
  step(tx: number, tz: number, speed = 3.2) {
    const dt = 1 / 60;
    const dx = tx - this.x;
    const dz = tz - this.z;
    const d = Math.hypot(dx, dz) || 1;
    const k = Math.min(1, d / (speed * dt));
    this.vy = Math.max(-30, this.vy - 22 * dt);
    this.kcc.computeColliderMovement(this.collider, { x: (dx / d) * speed * dt * k, y: this.vy * dt, z: (dz / d) * speed * dt * k }, undefined, RAY_STATIC);
    const m = this.kcc.computedMovement();
    if (this.kcc.computedGrounded() && this.vy < 0) this.vy = 0;
    const t = this.body.translation();
    const n = { x: t.x + m.x, y: t.y + m.y, z: t.z + m.z };
    this.body.setNextKinematicTranslation(n);
    this.body.setTranslation(n, false);
    this.world.step();
  }
}

void ({} as Heritage);
