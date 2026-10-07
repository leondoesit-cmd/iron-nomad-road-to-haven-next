import { beforeAll, describe, expect, it } from 'vitest';
import { legById } from '../src/data';
import { G, GROUPS, groups, initPhysics, PhysicsWorld, RAPIER } from '../src/physics/physics';
import { ChunkSource } from '../src/world/chunkgen';
import { BOULEVARD_HALF, SIDEWALK, type Aabb } from '../src/world/layout';
import { levelBase, planAabbs } from '../src/world/interiors';
import { atriumHalf, deckHeightAt, deckLine, FOOTBRIDGE, MALL, MALL_SHOPS, mallEscalators, SHOP_USE, shopRect } from '../src/world/mall';
import { propCollisionMesh } from '../src/render/propCollision';
import { buildBuildingGeometry } from '../src/render/buildingView';

beforeAll(async () => {
  await initPhysics();
});

const src = new ChunkSource(legById('L3P'));
const L = src.layout;
const mall = L.rural.find((b) => b.look === 'mall')!;
const plan = mall.plan;
const bridge = L.props.find((p) => p.kind === 'footbridge')!;
const X = (x: number) => plan.x0 + x;
const Z = (z: number) => plan.z0 + z;

describe('Ofer Grand Mall', () => {
  it('is the first thing on the left coming into Petah Tikva from the south', () => {
    expect(mall).toBeDefined();
    // Heading north (+z), +x is the driver's left.
    expect(plan.x0).toBeGreaterThanOrEqual(BOULEVARD_HALF + SIDEWALK);
    const at = (id: string) => L.places.find((p) => p.id === id)!;
    expect(at('grandMall').z).toBeLessThan(at('cityHall').z);
    for (const p of L.places) if (p.id !== 'grandMall') expect(p.z).toBeGreaterThan(plan.z0);
    // Nothing else stands on the left of the street before it.
    for (const b of src.cityBuildings()) if (b.aabb.minX > 0 && b.aabb.minX < plan.x1) expect(b.aabb.minZ).toBeGreaterThan(plan.z0);
  });

  it('is a walk-in building of two tall storeys, with every shop in its own room and its own sign', () => {
    expect(plan.levels).toBe(2);
    expect(plan.levelH).toBe(MALL.levelH);
    for (const s of MALL_SHOPS) {
      const r = shopRect(s);
      const room = plan.rooms.find((q) => q.level === s.level && q.role === 'sales' && Math.abs(q.z0 - Z(r.z0)) < 0.2 && Math.abs(q.x0 - X(r.x0)) < 0.2);
      expect(room, s.id).toBeDefined();
      expect(room!.use).toBe(SHOP_USE[s.kind]);
      const label = s.he ?? s.name;
      expect(L.signs.some((g) => g.theme === 'brand' && g.text === label && Math.abs(g.y - (s.level * MALL.levelH + (MALL.head + MALL.levelH) / 2)) < 0.01), s.id).toBe(true);
    }
    // The red board over the main doors.
    expect(L.signs.some((g) => g.text === 'עופר הקניון הגדול פ״ת' && g.x < plan.x0 && g.y > plan.levels * plan.levelH)).toBe(true);
  });

  it('has a way into every shop from the mall street, and doors to the street, both ends, the car park and the bridge', () => {
    for (const s of MALL_SHOPS) {
      const r = shopRect(s);
      const doors = plan.walls.filter((w) => w.level === s.level && !w.ext).flatMap((w) =>
        w.ops
          .filter((o) => o.kind === 'door')
          .map((o) => ({ w, o }))
          .filter(({ w, o }) => (s.row === 'anchor' ? w.axis === 'x' && Math.abs(w.c - Z(MALL.anchor)) < 0.01 : w.axis === 'z' && Math.abs(w.c - X(s.row === 'front' ? MALL.frontRow : MALL.backRow)) < 0.01 && o.a >= Z(r.z0) - 0.01 && o.b <= Z(r.z1) + 0.01)),
      );
      expect(doors.length, s.id).toBeGreaterThan(0);
    }
    const ext = (level: number, out: number, axis: 'x' | 'z') => plan.walls.find((w) => w.level === level && w.ext && w.axis === axis && w.out === out)!;
    const doorAt = (level: number, out: number, axis: 'x' | 'z', at: number) => ext(level, out, axis).ops.some((o) => o.kind === 'door' && o.a < at && o.b > at);
    expect(doorAt(0, -1, 'z', Z((MALL.court.z0 + MALL.court.z1) / 2))).toBe(true);
    expect(doorAt(0, -1, 'x', X(MALL.atrium.x))).toBe(true);
    expect(doorAt(0, 1, 'x', X(MALL.atrium.x))).toBe(true);
    expect(doorAt(0, 1, 'z', Z((MALL.court.z0 + MALL.court.z1) / 2))).toBe(true);
    expect(doorAt(1, -1, 'z', bridge.z)).toBe(true);
  });

  it('has the court open through the upper floor, with a balustrade round the void and the escalators climbing through it', () => {
    let id = 0;
    const boxes = planAabbs(plan, () => id++);
    const top = levelBase(plan, 1);
    // No slab over the middle of the void; slab everywhere just outside it.
    const slabAt = (x: number, z: number) => boxes.some((a) => a.kind === 'floor' && x > a.minX && x < a.maxX && z > a.minZ && z < a.maxZ && a.y1 === top);
    expect(slabAt(X(MALL.atrium.x), Z(MALL.atrium.z))).toBe(false);
    expect(slabAt(X(MALL.atrium.x), Z(MALL.atrium.z + MALL.atrium.rz + 0.2))).toBe(true);
    for (let z = MALL.atrium.z - MALL.atrium.rz + 0.5; z < MALL.atrium.z + MALL.atrium.rz - 0.5; z += 1.3) {
      expect(slabAt(X(MALL.atrium.x + atriumHalf(z) + 0.05), Z(z)), `edge at ${z}`).toBe(true);
      expect(slabAt(X(MALL.atrium.x + atriumHalf(z) - 0.45), Z(z)), `void at ${z}`).toBe(false);
    }
    expect(boxes.filter((a) => a.kind === 'stair' && a.ramp).length).toBe(2);
    expect(plan.stairs.every((s) => s.kind === 'escalator' && Math.abs((s.steps - 1) * s.rise - plan.levelH) < 1e-6)).toBe(true);
    // Thirty degrees.
    for (const e of mallEscalators()) expect(Math.atan2(e.rise, e.tread)).toBeCloseTo(Math.PI / 6, 6);
    expect(boxes.filter((a) => a.kind === 'furniture' && a.ramp && a.y0 >= top).length).toBeGreaterThan(50);
  });

  it('keeps upstairs colliders from stopping things spawning downstairs, and has the dead and the loot inside', () => {
    let id = 0;
    for (const a of planAabbs(plan, () => id++)) expect(!!a.overhead).toBe(a.y0 >= levelBase(plan, 1) - 0.35);
    const inside = (x: number, z: number) => x > plan.x0 && x < plan.x1 && z > plan.z0 && z < plan.z1;
    expect(L.zombies.filter((q) => inside(q.x, q.z)).length).toBeGreaterThan(12);
    expect(L.pickups.filter((q) => inside(q.x, q.z)).length).toBeGreaterThan(30);
    expect(L.zones.some((q) => q.kind === 'mall' && q.containers.length > 8)).toBe(true);
  });

  it('builds its geometry: the court, the escalators, the glass and the outside', () => {
    const g = buildBuildingGeometry(mall);
    expect(g.levels).toHaveLength(2);
    for (const lv of g.levels) {
      expect(lv.inside!.getAttribute('position').count).toBeGreaterThan(1000);
      expect(lv.glass!.getAttribute('position').count).toBeGreaterThan(20);
    }
    expect(g.roof!.getAttribute('position').count).toBeGreaterThan(2000);
    for (const geo of [g.roof!, ...g.levels.flatMap((l) => [l.shell, l.trim, l.inside, l.glass])]) {
      if (!geo) continue;
      const arr = geo.getAttribute('position').array as Float32Array;
      expect(arr.every((v) => Number.isFinite(v))).toBe(true);
    }
  });
});

describe('the footbridge', () => {
  const mesh = propCollisionMesh(bridge)!;

  it('leaves the mall from its upper-floor door, crosses Haim Ozer high enough for a bus, and comes down on the far side', () => {
    expect(bridge.x).toBeCloseTo(plan.x0, 6);
    expect(FOOTBRIDGE.y).toBe(levelBase(plan, 1) - plan.floorY);
    const line = deckLine(1).map((p) => ({ x: p.x + bridge.x, y: p.y, z: p.z + bridge.z }));
    expect(Math.min(...line.map((p) => p.x))).toBeLessThan(-(BOULEVARD_HALF + SIDEWALK));
    const foot = line[line.length - 1];
    expect(foot.y).toBe(0);
    expect(foot.x).toBeLessThan(-(BOULEVARD_HALF + SIDEWALK));
    // Over the carriageway nothing of the bridge comes below four and a half metres.
    const v = mesh.vertices;
    for (let i = 0; i < v.length; i += 3) if (Math.abs(v[i]) < BOULEVARD_HALF) expect(v[i + 1]).toBeGreaterThan(4.5);
    // The deck's surface follows the line it was drawn from.
    expect(deckHeightAt(-10, 0)).toBe(FOOTBRIDGE.y);
    expect(deckHeightAt(-FOOTBRIDGE.straight - FOOTBRIDGE.radius, -FOOTBRIDGE.radius - FOOTBRIDGE.ramp / 2)).toBeCloseTo(FOOTBRIDGE.y / 2, 6);
    expect(deckHeightAt(-10, 5)).toBeNull();
  });

  it('keeps spawns from under its low end and its piers, but not from the road under its span', () => {
    expect(L.blockedAt(bridge.x - FOOTBRIDGE.straight - FOOTBRIDGE.radius, bridge.z - FOOTBRIDGE.radius - FOOTBRIDGE.ramp * 0.9, 0.3)).toBe(true);
    expect(L.blockedAt(bridge.x + FOOTBRIDGE.mast.x, bridge.z + FOOTBRIDGE.mast.z, 0.3)).toBe(true);
    expect(L.blockedAt(0, bridge.z, 0.3)).toBe(false);
  });
});

// ------------------------------------------------------------------ on foot, with real physics

const RAY = groups(0xffff, G.STATIC | G.VEHICLE | G.BUILD | G.FURN);

class Walker {
  w = new PhysicsWorld();
  body: RAPIER.RigidBody;
  col: RAPIER.Collider;
  kcc: RAPIER.KinematicCharacterController;
  vy = 0;
  constructor(boxes: Aabb[]) {
    const w = this.w;
    w.addStaticBox((plan.x0 + plan.x1) / 2 - 30, -0.5, (plan.z0 + plan.z1) / 2, 90, 0.5, 120, 0, GROUPS.static);
    for (const a of boxes) {
      if (a.ramp) w.addStaticTilted(a.ramp.x, a.ramp.y, a.ramp.z, a.ramp.hx, a.ramp.hy, a.ramp.hz, a.ramp.q, GROUPS.furn);
      else w.addStaticBox((a.minX + a.maxX) / 2, (a.y0 + a.y1) / 2, (a.minZ + a.maxZ) / 2, (a.maxX - a.minX) / 2, (a.y1 - a.y0) / 2, (a.maxZ - a.minZ) / 2, 0, a.kind === 'furniture' || a.kind === 'floor' ? GROUPS.furn : GROUPS.static);
    }
    w.addPropCollider(propCollisionMesh(bridge)!, GROUPS.furn);
    this.body = w.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 1, 0));
    this.col = w.world.createCollider(RAPIER.ColliderDesc.capsule(0.55, 0.3).setCollisionGroups(GROUPS.player), this.body);
    this.kcc = w.world.createCharacterController(0.03);
    this.kcc.enableAutostep(0.45, 0.2, false);
    this.kcc.setMaxSlopeClimbAngle((55 * Math.PI) / 180);
    this.kcc.setMinSlopeSlideAngle((60 * Math.PI) / 180);
    this.kcc.enableSnapToGround(0.35);
  }
  put(x: number, y: number, z: number) {
    this.body.setTranslation({ x, y: y + 0.87, z }, true);
    this.w.step();
  }
  get p() {
    const t = this.body.translation();
    return { x: t.x, y: t.y - 0.85, z: t.z };
  }
  /** Walk toward a point for up to `secs`; true once within half a metre of it. */
  to(tx: number, tz: number, secs = 30): boolean {
    for (let i = 0; i < secs * 60; i++) {
      const p = this.p;
      const dx = tx - p.x;
      const dz = tz - p.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.5) return true;
      const k = Math.min(1, d / (3.2 / 60));
      this.vy = Math.max(-30, this.vy - 22 / 60);
      this.kcc.computeColliderMovement(this.col, { x: (dx / d) * (3.2 / 60) * k, y: this.vy / 60, z: (dz / d) * (3.2 / 60) * k }, undefined, RAY);
      const m = this.kcc.computedMovement();
      if (this.kcc.computedGrounded() && this.vy < 0) this.vy = 0;
      const t = this.body.translation();
      const n = { x: t.x + m.x, y: t.y + m.y, z: t.z + m.z };
      this.body.setNextKinematicTranslation(n);
      this.body.setTranslation(n, false);
      this.w.step();
    }
    return false;
  }
}

describe('walking it', () => {
  const near = L.aabbs.filter((a) => a.maxX > plan.x0 - 70 && a.minX < plan.x1 + 2 && a.maxZ > plan.z0 - 10 && a.minZ < plan.z1 + 10);

  it('up the ramp, over the street, into the upper floor, down the escalator and out of the main doors', () => {
    const w = new Walker(near);
    const B = FOOTBRIDGE;
    const bx = (x: number) => bridge.x + x;
    const bz = (z: number) => bridge.z + z;
    w.put(bx(-B.straight - B.radius), 0, bz(-B.radius - B.ramp - 2));
    expect(w.to(bx(-B.straight - B.radius), bz(-B.radius - 0.5))).toBe(true);
    expect(w.p.y).toBeGreaterThan(B.y - 0.3);
    for (const a of [160, 135, 110]) {
      const t = (a * Math.PI) / 180;
      expect(w.to(bx(-B.straight + Math.cos(t) * B.radius), bz(-B.radius + Math.sin(t) * B.radius)), `curve ${a}`).toBe(true);
    }
    // Over the middle of the street, on the deck.
    expect(w.to(0, bz(0))).toBe(true);
    expect(w.p.y).toBeGreaterThan(B.y - 0.3);
    // Through the door and the passage onto the mall street, then south to the escalators' head.
    expect(w.to(X(3), bz(0))).toBe(true);
    expect(w.to(X(18.5), bz(0))).toBe(true);
    expect(w.p.y).toBeGreaterThan(levelBase(plan, 1) - 0.3);
    const esc = mallEscalators()[1];
    const run = (esc.steps - 1) * esc.tread;
    expect(w.to(X(18.5), Z(esc.z + run + 4))).toBe(true);
    expect(w.to(X(esc.x), Z(esc.z + run + 2))).toBe(true);
    expect(w.to(X(esc.x), Z(esc.z - 2.4))).toBe(true);
    expect(w.p.y).toBeLessThan(plan.floorY + 0.3);
    // Out across the court and through the main doors to the street.
    expect(w.to(X(8), Z(esc.z - 2.4))).toBe(true);
    expect(w.to(X(-3), Z((MALL.court.z0 + MALL.court.z1) / 2))).toBe(true);
    expect(w.p.y).toBeLessThan(0.3);
  });

  it('cannot walk off the gallery into the void', () => {
    const w = new Walker(near);
    const top = levelBase(plan, 1);
    w.put(X(2), top, Z(MALL.atrium.z));
    w.to(X(MALL.atrium.x), Z(MALL.atrium.z), 6);
    expect(w.p.y).toBeGreaterThan(top - 0.2);
    expect(w.p.x).toBeLessThan(X(MALL.atrium.x - MALL.atrium.rx + 0.3));
  });
});

describe('in the open world', () => {
  it('is in the Petah Tikva district, just north of the start', () => {
    const W = new ChunkSource(legById('W')).layout;
    const m = W.rural.find((b) => b.look === 'mall')!;
    const d = W.terrain.open!.districts[0];
    expect(m.plan.z0).toBeCloseTo(plan.z0 + d.dz, 6);
    expect(m.plan.z0).toBeGreaterThan(d.z0);
    expect(W.props.find((p) => p.kind === 'footbridge')!.z).toBeCloseTo(bridge.z + d.dz, 6);
    expect(W.footbridges[0].z).toBeCloseTo(bridge.z + d.dz, 6);
    expect(W.start.z).toBeLessThan(m.plan.z0);
  }, 60000);
});
