import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { legById } from '../src/data';
import { buildLayout } from '../src/world/layout';
import { heightAt, roadX } from '../src/world/terrain';
import { COFFEE_TOP, DRIVEWAY, GARDEN_BOUNDS, GARDEN_LAYOUT, GATE, PARTY, PATIO_LIFT, PLOT, SEAT, floorRect, houseBoxes, houseLocal, houseSolids, houseWorld, inGarden, placeHouse, plotRect } from '../src/world/ududHouse';
import { PartyCast, partyLook } from '../src/render/partyCast';
import { mergeStatic } from '../src/game/partyMission';
import { MeshBuilder, S } from '../src/render/builder';
import { kitMaterial } from '../src/render/materials';
import { G, GROUPS, groups, initPhysics, PhysicsWorld, RAPIER } from '../src/physics/physics';

describe("Udud and Nuhat's house", () => {
  const layout = buildLayout(legById('W'));
  const p = layout.house!;

  it('stands inside Petah Tikva at its north end, on the boulevard, its gate and driveway facing the road', () => {
    expect(p).toBeTruthy();
    // In the city's last row of blocks, with apartment blocks either side of it along the boulevard.
    const cityTop = Math.max(...layout.lots.map((l) => l.z1));
    expect(p.z).toBeLessThan(cityTop);
    expect(p.z).toBeGreaterThan(cityTop - 60);
    const r = plotRect(p);
    const beside = layout.lots.filter((l) => l.kind === 'building' && l.x0 < r.maxX && l.x1 > r.minX);
    expect(beside.some((l) => l.z0 >= r.maxZ)).toBe(true);
    expect(beside.some((l) => l.z1 <= r.minZ)).toBe(true);
    expect(layout.terrain.open!.districts.some((d) => p.x > d.x0 && p.x < d.x1 && p.z > d.z0 && p.z < d.z1)).toBe(true);
    const gate = houseWorld(p, GATE.x, GATE.z);
    const drive = houseWorld(p, (DRIVEWAY.minX + DRIVEWAY.maxX) / 2, DRIVEWAY.minZ);
    const rx = roadX(layout.terrain, p.z);
    expect(Math.abs(gate.x - rx)).toBeLessThan(Math.abs(p.x - rx));
    // The driveway runs out to the road's edge.
    expect(Math.abs(drive.x - rx)).toBeLessThan(layout.terrain.roadHalf + 2);
    expect(Math.abs(drive.x - rx)).toBeGreaterThan(layout.terrain.roadHalf - 0.5);
  });

  it('turns house points into the world and back', () => {
    for (const [x, z] of [[0, 0], [5.9, -14.3], [-7, 7.9], [3.2, -20]]) {
      const w = houseWorld(p, x, z);
      const l = houseLocal(p, w.x, w.z);
      expect(l.x).toBeCloseTo(x, 6);
      expect(l.z).toBeCloseTo(z, 6);
    }
  });

  it('clears the plot of everything the city and the country put there, and floors it at the patio', () => {
    const r = plotRect(p);
    const inside = (x: number, z: number) => x > r.minX && x < r.maxX && z > r.minZ && z < r.maxZ;
    expect(layout.props.some((q) => inside(q.x, q.z))).toBe(false);
    expect(layout.cars.some((c) => inside(c.x, c.z))).toBe(false);
    expect(layout.zombies.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 30)).toBe(false);
    // The floor slab, cut at the chunk lines: its pieces tile the plot exactly.
    const floors = layout.aabbs.filter((a) => a.physOnly && a.kind === 'furniture' && Math.abs(a.y1 - p.y) < 1e-6 && a.y0 < p.y - 0.5 && a.minX >= r.minX - 1e-6 && a.maxX <= r.maxX + 1e-6 && a.minZ >= r.minZ - 1e-6 && a.maxZ <= r.maxZ + 1e-6);
    expect(floors.length).toBeGreaterThan(0);
    const area = floors.reduce((s, a) => s + (a.maxX - a.minX) * (a.maxZ - a.minZ), 0);
    const fr = floorRect(p);
    expect(area).toBeCloseTo((fr.maxX - fr.minX) * (fr.maxZ - fr.minZ), 4);
    // Nothing solid on the road's shoulder.
    for (const a of floors) expect(Math.min(Math.abs(a.minX - roadX(layout.terrain, a.minZ)), Math.abs(a.minX - roadX(layout.terrain, a.maxZ)))).toBeGreaterThan(layout.terrain.roadHalf + 2);
    for (const a of floors) {
      const cx = Math.floor((a.minX + a.maxX) / 2 / 128);
      const cz = Math.floor((a.minZ + a.maxZ) / 2 / 128);
      expect(a.minX).toBeGreaterThanOrEqual(cx * 128 - 1e-6);
      expect(a.maxZ).toBeLessThanOrEqual((cz + 1) * 128 + 1e-6);
    }
    const floor = floors[0];
    // The house's own boxes are all on the plot, and nothing else overlaps it.
    const mine = houseBoxes(p, houseSolids());
    for (const b of mine) {
      expect(b.minX).toBeGreaterThanOrEqual(r.minX - 0.2);
      expect(b.maxX).toBeLessThanOrEqual(r.maxX + 0.2);
      expect(b.minZ).toBeGreaterThanOrEqual(r.minZ - 0.2);
      expect(b.maxZ).toBeLessThanOrEqual(r.maxZ + 0.2);
    }
    const foreign = layout.aabbs.filter((a) => !floors.includes(a) && !mine.some((b) => Math.abs(b.minX - a.minX) < 1e-6 && Math.abs(b.minZ - a.minZ) < 1e-6) && a.maxX > r.minX && a.minX < r.maxX && a.maxZ > r.minZ && a.minZ < r.maxZ);
    expect(foreign).toEqual([]);
    expect(layout.rural.some((b) => b.aabb.maxX > r.minX && b.aabb.minX < r.maxX && b.aabb.maxZ > r.minZ && b.aabb.minZ < r.maxZ)).toBe(false);
    // No city block stands on it: the lot it took is cut back clear of it (its block keeps the rest) or left open.
    expect(layout.lots.some((l) => l.kind === 'building' && l.x1 > r.minX - 1 && l.x0 < r.maxX + 1 && l.z1 > r.minZ - 1 && l.z0 < r.maxZ + 1)).toBe(false);
  });

  it('levels its plot flush with the road and eases the pad back into the land', () => {
    const T = layout.terrain;
    const floor = p.y - PATIO_LIFT;
    for (const [x, z] of [[-7, 7.9], [7, -14.3], [0, 0], [4, DRIVEWAY.minZ], [-7, DRIVEWAY.minZ]]) {
      const w = houseWorld(p, x, z);
      expect(heightAt(T, w.x, w.z), `${x}, ${z}`).toBeCloseTo(floor, 4);
    }
    // The road the driveway opens onto is at the same height (within a few centimetres).
    const edge = houseWorld(p, 4, DRIVEWAY.minZ - 2);
    expect(Math.abs(heightAt(T, edge.x, edge.z) - floor)).toBeLessThan(0.25);
    // Well away from the plot the land is its own.
    const far = houseWorld(p, 0, PLOT.maxZ + 12);
    const def2 = { ...T, house: undefined };
    expect(heightAt(T, far.x, far.z)).toBeCloseTo(heightAt(def2, far.x, far.z), 6);
  });

  it('leaves the gate, the side passage and the way to the garden clear', () => {
    const solids = houseSolids();
    const blocked = (x: number, z: number) => solids.some((s) => Math.abs(x - s.x) < s.hx + 0.25 && Math.abs(z - s.z) < s.hz + 0.25);
    // From the driveway, through the gate, down the passage and out onto the lawn.
    const path: [number, number][] = [[GATE.x, -18], [GATE.x, GATE.z], [GATE.x, -12], [GATE.x, -8], [GATE.x, -4], [GATE.x, -1.2], [5.6, 0.2], [3, 0.2]];
    for (const [x, z] of path) expect(blocked(x, z), `${x}, ${z}`).toBe(false);
    // And everyone at the party is somewhere in the garden, clear of one another.
    for (const s of PARTY) expect(inGarden(s.x, s.z), s.hero).toBe(true);
    for (const a of PARTY) for (const b of PARTY) if (a !== b) expect(Math.hypot(a.x - b.x, a.z - b.z), `${a.hero}/${b.hero}`).toBeGreaterThan(0.75);
    expect(inGarden(GATE.x, DRIVEWAY.minZ)).toBe(false);
    expect(PLOT.minZ).toBe(DRIVEWAY.minZ);
  });

  it('sets the patio just above the ground where the driveway meets the road', () => {
    const q = placeHouse({ x: 0, z: 0, yaw: 0.2 }, (x, z) => x * 0.01 + z * 0.02)!;
    expect(q.yaw).toBe(0);
    const mid = (DRIVEWAY.minX + DRIVEWAY.maxX) / 2;
    expect(q.y).toBeCloseTo(mid * 0.01 + DRIVEWAY.minZ * 0.02 + PATIO_LIFT, 6);
  });
});

describe('the barbecue', () => {
  it('dresses everyone in their own clothes: no helmets, packs or work trousers', () => {
    for (const s of PARTY) {
      const look = partyLook(s.hero);
      expect(look.head.style).toBe('bare');
      expect(look.face.style).toBe('none');
      expect(look.pack.style).toBe('none');
      expect(look.hands.style).toBe('bare');
      expect(look.body.style).toBe('shirt');
      expect(look.feet.style).toBe('sneakers');
      if (s.hero !== 'iati') expect(look.legs.style).toBe('trousers');
    }
  });

  it('leaves out whoever is out on the road, and puts the rest where the house says', () => {
    const cast = new PartyCast(new Set(['chinsky', 'leo']));
    const heroes = cast.people.map((q) => q.hero).sort();
    expect(heroes).toEqual(['iati', 'lag', 'nar', 'nuhat', 'ro', 'udud']);
    for (let i = 0; i < 40; i++) cast.update(1 / 30, new THREE.Vector3(5.9, 1.55, -1));
    for (const q of cast.people) {
      const w = new THREE.Vector3();
      q.h.root.getWorldPosition(w);
      expect(Math.hypot(w.x - q.spot.x, w.z - q.spot.z), q.hero).toBeLessThan(0.05);
      // Everyone is sitting: nobody has fallen through the sofa or a chair or floated off it.
      const head = cast.faceOf(q.hero)!;
      expect(head.y, q.hero).toBeGreaterThan(1.0);
      expect(head.y, q.hero).toBeLessThan(1.6);
      if (q.spot.seat !== undefined) {
        const hips = new THREE.Vector3();
        q.h.hips.getWorldPosition(hips);
        expect(hips.y - q.spot.seat, q.hero).toBeGreaterThan(0.04);
        expect(hips.y - q.spot.seat, q.hero).toBeLessThan(0.15);
      }
    }
    cast.dispose();
    const two = new PartyCast(new Set(['lag', 'nar']));
    expect(two.has('lag')).toBe(false);
    expect(two.has('chinsky')).toBe(true);
    expect(two.has('leo')).toBe(true);
    two.dispose();
  });

  it("puts Lag's cake on his knees and Ro's burger plate on the crowded coffee table", () => {
    const cast = new PartyCast(new Set(['chinsky', 'leo']));
    cast.update(0.5, null);
    cast.group.updateMatrixWorld(true);
    const plateOf = (hero: 'lag' | 'ro') => {
      const spot = cast.people.find((q) => q.hero === hero)!;
      let best: THREE.Box3 | null = null;
      spot.root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !m.geometry || m.parent !== spot.root) return;
        m.geometry.computeBoundingBox();
        const b = m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld);
        // A plate: wide and flat.
        if (b.max.y - b.min.y < 0.06 && b.max.x - b.min.x > 0.2 && (!best || b.max.x - b.min.x > best.max.x - best.min.x)) best = b;
      });
      return best as THREE.Box3 | null;
    };
    const lag = plateOf('lag')!;
    const lagSpot = PARTY.find((s) => s.hero === 'lag')!;
    const c = lag.getCenter(new THREE.Vector3());
    // On his knees: above the sofa's cushion, below his chest, a little out in front of him.
    expect(lag.min.y).toBeGreaterThan(SEAT.sofa + 0.05);
    expect(lag.min.y).toBeLessThan(SEAT.sofa + 0.3);
    expect(Math.hypot(c.x - lagSpot.x, c.z - lagSpot.z)).toBeLessThan(0.45);
    const ro = plateOf('ro')!;
    const r = ro.getCenter(new THREE.Vector3());
    expect(Math.abs(ro.min.y - COFFEE_TOP)).toBeLessThan(0.02);
    const [cx, cz] = GARDEN_LAYOUT.coffee;
    expect(((r.x - cx) / 0.79) ** 2 + ((r.z - cz) / 0.44) ** 2).toBeLessThan(1);
    cast.dispose();
  });
});

describe('who sits where', () => {
  const at = (hero: string) => PARTY.find((s) => s.hero === hero)!;
  const dist = (s: { x: number; z: number }, p: readonly [number, number]) => Math.hypot(s.x - p[0], s.z - p[1]);
  // The garden door onto the patio, and the way out to the side passage and the gate.
  const DOOR = [-0.9, -4.5] as const;
  const EXIT = [5.9, -3.0] as const;
  const seated = PARTY.filter((s) => s.activity !== 'grill' && s.hero !== 'chinsky' && s.hero !== 'leo');

  it('puts Udud and Nuhat nearest the house door', () => {
    const byDoor = [...seated].sort((a, b) => dist(a, DOOR) - dist(b, DOOR));
    expect(byDoor.slice(0, 2).map((s) => s.hero).sort()).toEqual(['nuhat', 'udud']);
  });

  it('puts Nar on the sofa nearest the way out, and Iati on the chair beside him by the way out', () => {
    const nar = at('nar');
    expect(nar.seat).toBe(SEAT.sofa);
    const sofa = PARTY.filter((s) => s.seat === SEAT.sofa);
    for (const s of sofa) expect(dist(nar, EXIT)).toBeLessThanOrEqual(dist(s, EXIT));
    const iati = at('iati');
    expect(iati.seat).toBe(SEAT.chair);
    expect(iati.activity).toBe('smoke');
    const chairs = PARTY.filter((s) => s.seat === SEAT.chair);
    for (const s of chairs) expect(dist(iati, EXIT)).toBeLessThanOrEqual(dist(s, EXIT));
    expect(Math.hypot(iati.x - nar.x, iati.z - nar.z)).toBeLessThan(1.3);
  });

  it('sits the Karab brothers across the coffee table from the sofa', () => {
    const [cx, cz] = GARDEN_LAYOUT.coffee;
    const sofaZ = GARDEN_LAYOUT.sofa[1];
    for (const hero of ['lag', 'ro']) {
      const s = at(hero);
      // The other side of the table from the sofa, facing it.
      expect(Math.sign(s.z - cz)).toBe(-Math.sign(sofaZ - cz));
      expect(Math.cos(s.yaw - Math.atan2(cx - s.x, cz - s.z))).toBeGreaterThan(0.7);
    }
  });
});

describe("Iati's blessing", () => {
  it('turns, takes a drag, blows the cloud across and says when it lands', () => {
    const cast = new PartyCast(new Set(['chinsky', 'leo']));
    const target = new THREE.Vector3(5.6, 1.6, -1.2);
    expect(cast.bless(target)).toBe(true);
    expect(cast.bless(target)).toBe(false);
    let hitAt = -1;
    let smoke = 0;
    for (let i = 0; i < 6.5 * 30; i++) {
      cast.update(1 / 30, target);
      if (cast.blessHit) hitAt = i / 30;
      let n = 0;
      cast.group.traverse((o) => { if (o.name === 'party-smoke' && o.visible) n++; });
      smoke = Math.max(smoke, n);
    }
    expect(hitAt).toBeGreaterThan(3);
    expect(hitAt).toBeLessThan(4.5);
    expect(smoke).toBeGreaterThan(15);
    expect(cast.blessing).toBe(false);
    cast.dispose();
    // Nobody to bless with when Iati is the one out on the road.
    const without = new PartyCast(new Set(['iati', 'leo']));
    expect(without.bless(target)).toBe(false);
    without.dispose();
  });

  it('makes the party strange while you are high: the spoon and cake grow, they float, the glasses leave Udud', () => {
    const cast = new PartyCast(new Set(['chinsky', 'leo']));
    cast.update(0.5, null);
    const lag = cast.people.find((q) => q.hero === 'lag')!;
    const udud = cast.people.find((q) => q.hero === 'udud')!;
    const glasses = udud.h.head.getObjectByName('udud-prescription-glasses')!;
    const spoon = (lag.root.children.find((o) => (o as THREE.Mesh).isMesh && o.children.length > 0) ?? lag.root) as THREE.Object3D;
    const sober = { y: lag.root.position.y, spoon: spoon.scale.x, glasses: glasses.position.length() };
    cast.high = 1;
    for (let i = 0; i < 20; i++) cast.update(1 / 30, null);
    expect(lag.root.position.y).toBeGreaterThan(sober.y + 0.04);
    expect(spoon.scale.x).toBeGreaterThan(sober.spoon * 2);
    expect(glasses.position.length()).toBeGreaterThan(sober.glasses + 0.1);
    cast.high = 0;
    for (let i = 0; i < 5; i++) cast.update(1 / 30, null);
    expect(lag.root.position.y).toBeCloseTo(0, 6);
    cast.dispose();
  });
});

describe('merging the static garden', () => {
  it('folds plain kit meshes into one per material and leaves the rest alone', () => {
    const root = new THREE.Group();
    const keep = new THREE.Group();
    for (let i = 0; i < 6; i++) {
      const b = new MeshBuilder();
      b.box(i, 0.5, 0, 1, 1, 1, S.paint(0x888888, 0.2));
      const m = new THREE.Mesh(b.build(), kitMaterial());
      m.position.set(0, i, 0);
      (i < 4 ? root : keep).add(m);
    }
    root.add(keep);
    const live = new THREE.Mesh(new MeshBuilder().build(), kitMaterial());
    live.userData.dynamic = true;
    root.add(live);
    mergeStatic(root, [keep]);
    const meshes: THREE.Mesh[] = [];
    root.traverse((o) => (o as THREE.Mesh).isMesh && meshes.push(o as THREE.Mesh));
    expect(meshes.filter((m) => m.name === 'house-merged')).toHaveLength(1);
    expect(meshes).toContain(live);
    expect(keep.children).toHaveLength(2);
    const merged = meshes.find((m) => m.name === 'house-merged')!;
    merged.geometry.computeBoundingBox();
    // The four boxes kept their places (x 0..3, y 0..3 plus their own half-metre).
    expect(merged.geometry.boundingBox!.max.x).toBeCloseTo(3.5, 5);
    expect(merged.geometry.boundingBox!.max.y).toBeCloseTo(4, 5);
    void GARDEN_BOUNDS;
  });
});

describe('walking in from the road', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  /** A player capsule on the house's colliders, moved the way the game moves one (kinematic, character controller). */
  function walker() {
    const layout = buildLayout(legById('W'));
    const p = layout.house!;
    const r = plotRect(p);
    const w = new PhysicsWorld();
    // The levelled ground, then every box on the plot as the chunks would make it.
    w.addStaticBox((r.minX + r.maxX) / 2, p.y - PATIO_LIFT - 0.5, (r.minZ + r.maxZ) / 2, 60, 0.5, 60, 0, GROUPS.static);
    for (const a of layout.aabbs) {
      if (a.maxX < r.minX - 2 || a.minX > r.maxX + 2 || a.maxZ < r.minZ - 2 || a.minZ > r.maxZ + 2) continue;
      w.addStaticBox((a.minX + a.maxX) / 2, (a.y0 + a.y1) / 2, (a.minZ + a.maxZ) / 2, (a.maxX - a.minX) / 2, (a.y1 - a.y0) / 2, (a.maxZ - a.minZ) / 2, 0, a.kind === 'furniture' || a.kind === 'floor' ? GROUPS.furn : GROUPS.static);
    }
    const H = 1.7;
    const R = 0.3;
    const body = w.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
    const col = w.world.createCollider(RAPIER.ColliderDesc.capsule((H - 2 * R) / 2, R).setCollisionGroups(GROUPS.player), body);
    const kcc = w.world.createCharacterController(0.03);
    kcc.enableAutostep(0.45, 0.2, false);
    kcc.enableSnapToGround(0.35);
    const rays = groups(0xffff, G.STATIC | G.VEHICLE | G.BUILD | G.FURN);
    let vy = 0;
    const at = () => {
      const t = body.translation();
      return houseLocal(p, t.x, t.z);
    };
    const put = (lx: number, lz: number) => {
      const q = houseWorld(p, lx, lz);
      body.setTranslation({ x: q.x, y: p.y + H / 2 + 0.05, z: q.z }, true);
      w.step();
    };
    /** Walk toward a house point for up to `secs`; returns where it got to (house frame). */
    const walkTo = (lx: number, lz: number, secs = 8) => {
      const q = houseWorld(p, lx, lz);
      for (let i = 0; i < secs * 60; i++) {
        const t = body.translation();
        const dx = q.x - t.x;
        const dz = q.z - t.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.05) break;
        const s = Math.min(3.2 / 60, d);
        vy = Math.max(-30, vy - 22 / 60);
        kcc.computeColliderMovement(col, { x: (dx / d) * s, y: vy / 60, z: (dz / d) * s }, undefined, rays);
        const m = kcc.computedMovement();
        if (kcc.computedGrounded() && vy < 0) vy = 0;
        const n = { x: t.x + m.x, y: t.y + m.y, z: t.z + m.z };
        body.setNextKinematicTranslation(n);
        body.setTranslation(n, false);
        w.step();
      }
      return at();
    };
    return { put, walkTo };
  }

  it('gets from the driveway through the open gate and down the side passage to the grill', () => {
    const w = walker();
    w.put(4, -24);
    const route: [number, number][] = [[GATE.x, -16], [GATE.x, GATE.z + 1], [GATE.x, -8], [GATE.x, -2], [5.4, 0.1], [2.8, 0.1], [-0.9, -3.4]];
    for (const [x, z] of route) {
      const got = w.walkTo(x, z);
      expect(Math.hypot(got.x - x, got.z - z), `to ${x}, ${z}: got ${got.x.toFixed(2)}, ${got.z.toFixed(2)}`).toBeLessThan(0.3);
    }
  });

  it('cannot walk through the house, the fence or the grill', () => {
    const w = walker();
    w.put(-0.9, -3.4);
    expect(w.walkTo(-3.5, -8).z).toBeGreaterThan(GARDEN_BOUNDS.house.maxZ);
    w.put(-2, 6.5);
    expect(w.walkTo(-2, 11).z).toBeLessThan(GARDEN_BOUNDS.lawnEnd);
    w.put(-6, 2);
    expect(w.walkTo(-10, 2).x).toBeGreaterThan(-7);
    const [gx, gz] = GARDEN_LAYOUT.grill;
    w.put(gx - 0.1, gz - 1.1);
    expect(w.walkTo(gx - 0.1, gz + 1.1, 4).z).toBeLessThan(gz - 0.37);
  });
});
