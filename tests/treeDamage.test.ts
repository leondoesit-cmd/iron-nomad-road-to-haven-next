import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { GROUPS, PhysicsWorld, initPhysics, type TreeEvents, type TreeFall, type TreeShot } from '../src/physics/physics';
import { Vegetation, clipHull } from '../src/render/vegetation';
import { buildTreesSteps, type TreeSet } from '../src/render/trees';
import { WoodChips, CHIP_CAP } from '../src/render/woodChips';
import { AMMO, type AmmoKind } from '../src/sim/ballistics';
import { addNotch, bandMid, NOTCH, notchDepth, notchGain, segmentShare, shotsToSnap, snapShare, throughTrunk, WOOD, woodFx } from '../src/sim/treeDamage';
import { vegetationKey, type VegetationMemory } from '../src/sim/vegetation';
import { TREE_SPECIES, type TreeSpot } from '../src/world/flora';
import { WorldMemory } from '../src/game/worldMemory';

// Gunfire in the trees: the notch a burst cuts, the snap, the stump and the falling top, what is remembered, the chip pool.

beforeAll(initPhysics);

const spot = (kind: string, s = 1, x = 0): TreeSpot => ({ x, y: 0, z: 0, s, yaw: 0.3, lean: [0, 0], v: 0, sp: TREE_SPECIES.indexOf(kind as (typeof TREE_SPECIES)[number]) });

function build(trees: TreeSpot[]): TreeSet {
  const g = buildTreesSteps(trees);
  let r = g.next();
  while (!r.done) r = g.next();
  return r.value;
}

/** A round from 20 m off to the -x side at chest height, as `game/timber.ts` hands one to a tree. */
function round(ammo: AmmoKind, x: number, y = 1.3): TreeShot {
  const speed = AMMO[ammo].speed * 0.97;
  return { ammo, speed, exit: 0, x, y, z: 0, dx: 1, dy: 0, dz: 0, by: 0 };
}

/** Fire at a tree's trunk until it goes (or `max` rounds), as combat does: entry point on its near face. */
function fireAt(physics: PhysicsWorld, field: Vegetation, ammo: AmmoKind, max = 600, y = 1.3): number {
  const p = field.plants[0];
  for (let n = 1; n <= max; n++) {
    const target = physics.trees.get(p.solid!.handle)!;
    const r = field.stemRadius(p, p.position.x, p.position.y + y, p.position.z);
    target.shot(round(ammo, p.position.x - r, p.position.y + y));
    if (p.record.broken) return n;
  }
  return Infinity;
}

describe('notch rules', () => {
  it('measures notch depth as the inverse of the share of a round section it takes', () => {
    for (const h of [0.05, 0.2, 0.5, 0.8]) expect(notchDepth(segmentShare(h))).toBeCloseTo(h, 3);
    expect(segmentShare(0.5)).toBeCloseTo(0.5, 5);
    expect(segmentShare(1)).toBeCloseTo(1, 5);
  });

  it('lets a full-power round through a thin trunk and stops a pistol round in it', () => {
    expect(throughTrunk('rifle', AMMO.rifle.speed, 0.3, 1)).toBeGreaterThan(0);
    expect(throughTrunk('pistol', AMMO.pistol.speed, 0.3, 1)).toBe(0);
    expect(throughTrunk('carbine', AMMO.carbine.speed, 1.0, 1.3)).toBe(0);
    // Harder wood stops a round sooner.
    expect(throughTrunk('rifle', AMMO.rifle.speed, 0.3, 1.3)).toBeLessThan(throughTrunk('rifle', AMMO.rifle.speed, 0.3, 0.7));
  });

  it('is tuned: thin trees go with a few rifle rounds, medium ones with a magazine, old ones with a belt', () => {
    // Thin (a small acacia or poplar, 0.38 m through).
    expect(shotsToSnap('rifle', 0.38, WOOD.acacia.hard)).toBeLessThanOrEqual(6);
    expect(shotsToSnap('battle', 0.38, WOOD.acacia.hard)).toBeLessThanOrEqual(6);
    expect(shotsToSnap('carbine', 0.38, WOOD.acacia.hard)).toBeLessThan(25);
    // Medium (0.55 m): an assault rifle's magazine, or a handful of big rounds.
    const mag = shotsToSnap('carbine', 0.55, 1);
    expect(mag).toBeGreaterThanOrEqual(20);
    expect(mag).toBeLessThanOrEqual(40);
    for (const big of ['battle', 'sniper', 'rifle'] as const) {
      expect(shotsToSnap(big, 0.55, 1)).toBeGreaterThanOrEqual(4);
      expect(shotsToSnap(big, 0.55, 1)).toBeLessThanOrEqual(10);
    }
    // Old gum or oak (1.1 m): a machine gun's belt.
    const belt = shotsToSnap('carbine', 1.1, WOOD.eucalyptus.hard);
    expect(belt).toBeGreaterThan(100);
    expect(belt).toBeLessThan(300);
    // A pistol mostly chips; buckshot shreds a sapling and only peppers a trunk.
    expect(shotsToSnap('pistol', 0.55, 1)).toBeGreaterThan(150);
    expect(shotsToSnap('pellet', 0.08, 1, 0, 9)).toBeLessThanOrEqual(3);
    expect(shotsToSnap('pellet', 0.55, 1, 0, 9)).toBeGreaterThan(40);
    // Even a sapling takes a second round.
    expect(shotsToSnap('rifle', 0.05, 1)).toBeGreaterThanOrEqual(2);
  });

  it('accumulates near the same height in overlapping bands, and cuts nothing below the flare or in the crown', () => {
    const bands: number[] = [];
    expect(addNotch(bands, 0.1, 0.1, 3)).toBe(-1);
    expect(addNotch(bands, 3.5, 0.1, 3)).toBe(-1);
    const j = addNotch(bands, 1.3, 0.1, 3);
    expect(j).toBeGreaterThanOrEqual(0);
    // A hit anywhere in a band's span counts there in full.
    addNotch(bands, 1.3 + NOTCH.step * 0.6, 0.1, 3);
    expect(Math.max(...bands)).toBeCloseTo(0.2, 6);
    expect(Math.abs(bandMid(bands.indexOf(Math.max(...bands))) - 1.3)).toBeLessThan(NOTCH.step * 1.5);
    // Far away it is a different notch.
    addNotch(bands, 2.6, 0.1, 3);
    expect(Math.max(...bands)).toBeCloseTo(0.2, 6);
  });

  it('caps a single round, weakens a pistol in a deep notch, and lets a leaning tree go sooner', () => {
    const hit = { ammo: 'rifle' as const, speed: AMMO.rifle.speed, work: 1300, section: 0.002, diameter: 0.05, done: 0, hard: 1 };
    expect(notchGain(hit)).toBe(NOTCH.maxPerHit);
    const pistol = { ammo: 'pistol' as const, speed: AMMO.pistol.speed, work: 250, section: 0.24, diameter: 0.55, done: 0, hard: 1 };
    expect(notchGain({ ...pistol, done: 0.5 })).toBeLessThan(notchGain(pistol) * 0.6);
    expect(snapShare(0.3)).toBeLessThan(snapShare(0));
    expect(snapShare(2)).toBeGreaterThanOrEqual(0.4);
  });

  it('throws more off a heavy round than a light one', () => {
    expect(woodFx('rifle', 1, 'oak').chips).toBeGreaterThan(woodFx('pistol', 1, 'oak').chips);
    expect(woodFx('rifle', 1, 'oak').scar).toBeGreaterThan(woodFx('pistol', 1, 'oak').scar);
    expect(woodFx('rifle', 1, 'snag').leaves).toBe(0);
  });

  it('clips a convex piece exactly at a plane', () => {
    const box = Float32Array.from([-1, 0, -1, 1, 0, -1, -1, 0, 1, 1, 0, 1, -1, 2, -1, 1, 2, -1, -1, 2, 1, 1, 2, 1]);
    const top = clipHull(box, 0.5, true)!;
    const bottom = clipHull(box, 0.5, false)!;
    for (let i = 1; i < top.length; i += 3) expect(top[i]).toBeGreaterThanOrEqual(0.5 - 1e-6);
    for (let i = 1; i < bottom.length; i += 3) expect(bottom[i]).toBeLessThanOrEqual(0.5 + 1e-6);
    expect(clipHull(box, 3, true)).toBeNull();
    expect(clipHull(box, -1, true)).toBe(box);
  });
});

describe('a tree shot down', () => {
  function stand(kind: string, s = 1, memory: VegetationMemory = new Map(), x = 0) {
    const physics = new PhysicsWorld();
    physics.addStaticBox(x, -0.5, 0, 40, 0.5, 40);
    const breaks: (number | undefined)[] = [];
    const field = new Vegetation(physics, memory, (_i, top) => breaks.push(top));
    const trees = [spot(kind, s, x)];
    field.addTrees(trees);
    const set = build(trees);
    field.bindTrees(set);
    const falls: TreeFall[] = [];
    const landed: number[] = [];
    let leaves = 0;
    const events: TreeEvents = { snapped: (f) => falls.push(f), landed: (_f, _x, _y, _z, s2) => landed.push(s2), leaves: (_x, _y, _z, n) => void (leaves += n) };
    physics.treeEvents = events;
    return { physics, field, set, breaks, falls, landed, leaves: () => leaves, trees };
  }

  it('fills the notch round by round and snaps at it: a rooted stump and a falling top on a hinge', () => {
    const t = stand('poplar', 0.85);
    const p = t.field.plants[0];
    const trunk = p.solid!.handle;
    const n = fireAt(t.physics, t.field, 'carbine');
    expect(n).toBeGreaterThan(8);
    expect(n).toBeLessThan(60);
    expect(p.record.broken).toBe(true);
    expect(p.record.cut).toBeGreaterThan(0.5);
    expect(p.record.cut! * p.scale.y).toBeCloseTo(1.3, 0);
    // The standing trunk is gone; the stump and the top are wood a round can still chip, but not notch.
    expect(t.physics.trees.has(trunk)).toBe(false);
    expect(p.stump!.body.isFixed()).toBe(true);
    expect(p.stump!.colliders.length).toBeGreaterThan(0);
    for (const c of p.stump!.colliders) expect(t.physics.trees.get(c.handle)!.standing).toBe(false);
    expect(p.body!.isDynamic()).toBe(true);
    expect(p.hinge).toBeDefined();
    // It tells the scene, which keeps the stump in the way at its new height.
    expect(t.falls.length).toBe(1);
    expect(t.breaks.length).toBe(1);
    expect(t.breaks[0]).toBeGreaterThan(1);
    expect(t.breaks[0]).toBeLessThan(2.2);
    // The top's mass is its share of the tree.
    expect(t.falls[0].mass).toBeGreaterThan(p.material.mass * 0.4);
    expect(t.falls[0].mass).toBeLessThan(p.material.mass);
    // Its own instance draws the top; a new one, where the tree stood, draws the stump.
    const near = t.set.near[0];
    expect(near.count).toBe(2);
    const notch = near.geometry.getAttribute('aNotch') as THREE.InstancedBufferAttribute;
    expect(notch.getW(0)).toBe(1);
    expect(notch.getW(1)).toBe(-1);
    expect(notch.getX(1)).toBeCloseTo(p.record.cut!, 5);
    const a = new THREE.Matrix4(), b = new THREE.Matrix4();
    near.getMatrixAt(1, a);
    b.copy(p.refs[0].base);
    for (let i = 0; i < 16; i++) expect(a.elements[i]).toBeCloseTo(b.elements[i], 5);
    // It goes over away from the guns, swinging on the hinge, tears free and lands.
    for (let i = 0; i < 60 * 8; i++) t.physics.step();
    expect(p.hinge).toBeUndefined();
    const pos = p.body!.translation();
    near.getMatrixAt(0, a);
    expect(a.elements[12]).toBeCloseTo(pos.x, 3);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(p.body!.rotation().x, p.body!.rotation().y, p.body!.rotation().z, p.body!.rotation().w));
    expect(up.y).toBeLessThan(0.5);
    expect(up.x).toBeGreaterThan(0.3);
    expect(t.landed.length).toBe(1);
    expect(t.landed[0]).toBeGreaterThan(3);
    // Once down, people collide with it again.
    for (const c of p.colliders) expect(c.collisionGroups()).toBe(GROUPS.loose);
    t.field.dispose();
    expect(t.physics.world.bodies.len()).toBe(0);
    expect(t.physics.trees.size).toBe(0);
  });

  it('needs far more rounds for an old gum than a poplar, and a pistol barely marks one', () => {
    const gum = stand('eucalyptus', 1.1);
    const n = fireAt(gum.physics, gum.field, 'carbine', 600, 1.4);
    expect(n).toBeGreaterThan(90);
    gum.field.dispose();
    const oak = stand('oak', 1);
    expect(fireAt(oak.physics, oak.field, 'pistol', 120)).toBe(Infinity);
    expect(Math.max(...oak.field.plants[0].record.notch!)).toBeLessThan(0.4);
    oak.field.dispose();
  });

  it('only notches the trunk: shots into the crown shake it but cut nothing', () => {
    const t = stand('oak', 1);
    const p = t.field.plants[0];
    const target = t.physics.trees.get(p.solid!.handle)!;
    for (let i = 0; i < 50; i++) target.shot(round('battle', -0.3, 5.5));
    expect(p.record.broken).toBe(false);
    expect(p.record.notch?.some((b) => b > 0) ?? false).toBe(false);
    t.field.dispose();
  });

  it('remembers the snap: a reload puts back the stump and the top where it lay, and the notch of a tree still standing', () => {
    const memory = new WorldMemory();
    const t = stand('poplar', 0.85, memory.vegetation);
    fireAt(t.physics, t.field, 'battle');
    for (let i = 0; i < 60 * 6; i++) t.physics.step();
    const pose = [...memory.vegetation.get(vegetationKey('tree', 0, 0))!.pose!];
    t.field.dispose();
    // A second tree, half cut.
    const half = stand('pine', 1, memory.vegetation, 60);
    const hp = half.field.plants[0];
    const target = half.physics.trees.get(hp.solid!.handle)!;
    for (let i = 0; i < 6; i++) target.shot(round('carbine', 60 - 0.3));
    expect(hp.record.broken).toBe(false);
    const share = Math.max(...hp.record.notch!);
    expect(share).toBeGreaterThan(0);
    half.field.dispose();
    const restored = WorldMemory.restore(JSON.parse(JSON.stringify(memory.serialize())));
    const again = stand('poplar', 0.85, restored.vegetation);
    const p = again.field.plants[0];
    expect(p.record.cut).toBeDefined();
    expect(p.stump).toBeDefined();
    expect(p.body!.isSleeping()).toBe(true);
    expect(p.body!.translation().x).toBeCloseTo(pose[0], 4);
    expect(again.falls.length).toBe(0);
    expect(again.set.near[0].count).toBe(2);
    again.field.dispose();
    const pine = stand('pine', 1, restored.vegetation, 60);
    expect(Math.max(...pine.field.plants[0].record.notch!)).toBeCloseTo(share, 4);
    const notch = pine.set.near[0].geometry.getAttribute('aNotch') as THREE.InstancedBufferAttribute;
    expect(notch.getY(0)).toBeCloseTo(share, 4);
    expect(notch.getW(0)).toBe(0);
    pine.field.dispose();
  });

  it('still takes a whole-tree fall from a blast, and a charred tree goes sooner', () => {
    const a = stand('poplar', 0.85), b = stand('poplar', 0.85);
    b.field.charTree(0, 1);
    const na = fireAt(a.physics, a.field, 'carbine'), nb = fireAt(b.physics, b.field, 'carbine');
    expect(nb).toBeLessThan(na);
    a.field.dispose();
    b.field.dispose();
    const c = stand('snag', 1);
    c.physics.hitArea({ x: 0, y: 1, z: 0, dx: 0, dy: 0, dz: 0, impulse: 3000, energy: 1e6, kind: 'blast', radius: 5 });
    expect(c.field.plants[0].record.broken).toBe(true);
    expect(c.field.plants[0].record.cut).toBeUndefined();
    expect(c.field.plants[0].stump).toBeUndefined();
    c.field.dispose();
  });
});

describe('bushes under fire', () => {
  /** One shrub, a metre across, at the origin. */
  function shrub() {
    const physics = new PhysicsWorld();
    const field = new Vegetation(physics);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.5, 0, 0, 0.5, 0, 1, 0.5, 0, 1, -0.5, -0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial(), 1);
    mesh.setMatrixAt(0, new THREE.Matrix4());
    const plant = field.addInstances(mesh, 'shrubs')[0];
    let leaves = 0;
    physics.treeEvents = { snapped() {}, landed() {}, leaves: (_x, _y, _z, n) => void (leaves += n) };
    return { physics, field, plant, leaves: () => leaves };
  }
  const shoot = (physics: PhysicsWorld, ammo: AmmoKind) => {
    const v = AMMO[ammo].speed;
    physics.hitAlongRay({ x: -3, y: 0.5, z: 0.05, dx: 1, dy: 0, dz: 0, impulse: AMMO[ammo].mass * v, energy: 0.5 * AMMO[ammo].mass * v * v, kind: 'bullet', ammo }, 6);
  };

  it('thins a bush round by round (a magazine strips it, a few shells of buckshot shred it) and tears leaves off it', () => {
    const a = shrub();
    for (let i = 0; i < 5; i++) shoot(a.physics, 'carbine');
    const five = a.plant.record.damage;
    expect(five).toBeGreaterThan(0.1);
    expect(a.plant.record.broken).toBe(false);
    for (let i = 0; i < 25; i++) shoot(a.physics, 'carbine');
    expect(a.plant.record.broken).toBe(true);
    expect(a.leaves()).toBeGreaterThan(20);
    a.field.dispose();
    const b = shrub();
    for (let shell = 0; shell < 5 && !b.plant.record.broken; shell++) for (let k = 0; k < 9; k++) shoot(b.physics, 'pellet');
    expect(b.plant.record.broken).toBe(true);
    b.field.dispose();
    // An unnamed round (the old path) still only grazes it.
    const c = shrub();
    c.physics.hitAlongRay({ x: -3, y: 0.5, z: 0.05, dx: 1, dy: 0, dz: 0, impulse: 5, energy: 500, kind: 'bullet' }, 6);
    expect(c.plant.record.damage).toBeLessThan(0.01);
    c.field.dispose();
  });
});

describe('chip pool', () => {
  it('never holds more than its cap, recycling the oldest, and clears itself once everything has settled and faded', () => {
    const chips = new WoodChips(() => 0);
    for (let i = 0; i < 1500; i++) chips.throw('chip', 0, 1.2, 0, Math.random() - 0.5, 2, Math.random() - 0.5, 1, 1, 1, 0.8, 0.7, 0.5, 0);
    expect(chips.count('chip')).toBe(CHIP_CAP.chip);
    for (let i = 0; i < 300; i++) chips.throw('leaf', 0, 6, 0, 0, 0, 0, 1, 1, 1, 0.3, 0.5, 0.2, 0);
    expect(chips.count('leaf')).toBe(CHIP_CAP.leaf);
    for (let i = 0; i < 60 * 4; i++) chips.update(1 / 60);
    expect(chips.flying('chip')).toBe(0);
    // Leaves take their time coming down.
    for (let i = 0; i < 60 * 6; i++) chips.update(1 / 60);
    expect(chips.flying('leaf')).toBe(0);
    for (let i = 0; i < 60 * 60; i++) chips.update(1 / 60);
    expect(chips.count('chip')).toBe(0);
    expect(chips.count('leaf')).toBe(0);
    chips.dispose();
  });
});
