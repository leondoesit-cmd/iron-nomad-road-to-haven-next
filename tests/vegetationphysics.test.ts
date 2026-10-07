import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { GROUPS, RAPIER, PhysicsWorld, initPhysics, type PhysicsImpact } from '../src/physics/physics';
import { Vegetation, treeCollisionMesh } from '../src/render/vegetation';
import { buildTreesSteps, treeGeometry } from '../src/render/trees';
import { PLANT_MECHANICS, coverage, crushShare, flatten, setAngle, TREE_MECHANICS, newBend, stepBend, vegetationKey, type VegetationMemory } from '../src/sim/vegetation';
import { TREE_SPECIES, type TreeSpot } from '../src/world/flora';
import { propBuilder } from '../src/render/propCollision';
import { WorldMemory } from '../src/game/worldMemory';

beforeAll(initPhysics);
const tree = (kind = 'snag', scale = 1): TreeSpot => ({ x: 0, y: 0, z: 0, s: scale, yaw: 0.2, lean: [0.02, -0.03], v: 0, sp: TREE_SPECIES.indexOf(kind as typeof TREE_SPECIES[number]) });
const hit = (energy: number, impulse = 50): PhysicsImpact => ({ x: 0, y: 1.1, z: 0, dx: 1, dy: 0, dz: 0, energy, impulse, kind: 'contact' });
function tuft(kind: 'grass' | 'shrubs', memory: VegetationMemory = new Map()) {
  const physics = new PhysicsWorld();
  const field = new Vegetation(physics, memory);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.5, 0, 0, 0.5, 0, 1, 0.5, 0, 1, -0.5], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial(), 1);
  mesh.setMatrixAt(0, new THREE.Matrix4());
  const plant = field.addInstances(mesh, kind)[0];
  return { physics, field, mesh, plant };
}
function movingBox(physics: PhysicsWorld, mass: number, speed: number, x = -1) {
  const body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, 0.5, 0)
    .setLinvel(speed, 0, 0).setGravityScale(0).setCcdEnabled(true));
  physics.world.createCollider(RAPIER.ColliderDesc.cuboid(0.3, 0.4, 0.3).setMass(mass).setCollisionGroups(GROUPS.vehicle), body);
  return body;
}

describe('vegetation mechanics', () => {
  it('settles back from a brush without unstable oscillations', () => {
    const bend = newBend();
    bend.vz = -4;
    for (let i = 0; i < 120; i++) stepBend(bend, PLANT_MECHANICS.grass, 1 / 30);
    expect(Math.abs(bend.z) + Math.abs(bend.vz)).toBeLessThan(0.0001);
    expect(TREE_MECHANICS.willow.maxBend).toBeGreaterThan(TREE_MECHANICS.oak.maxBend);
    expect(TREE_MECHANICS.oak.strength).toBeGreaterThan(TREE_MECHANICS.snag.strength * 20);
  });

  it('uses the actual wood of exactly one tree variant, excluding foliage', () => {
    for (let sp = 0; sp < TREE_SPECIES.length; sp++) for (let variant = 0; variant < 3; variant++) {
      const wood = treeCollisionMesh(sp, variant);
      expect(wood.indices.length).toBeGreaterThan(12);
      expect([...wood.indices].every((i) => i < wood.vertices.length / 3)).toBe(true);
      const geo = treeGeometry(sp), pos = geo.getAttribute('position'), t = geo.getAttribute('tree');
      const allowed = new Set<string>();
      for (let i = 0; i < pos.count; i++) if (t.getX(i) === 0 && t.getY(i) === variant) allowed.add(`${pos.getX(i)},${pos.getY(i)},${pos.getZ(i)}`);
      for (let i = 0; i < wood.vertices.length; i += 3) expect(allowed.has(`${wood.vertices[i]},${wood.vertices[i + 1]},${wood.vertices[i + 2]}`)).toBe(true);
    }
  });

  it('bends on a real collision, lets the object pass, and recovers', () => {
    const { physics, field, plant } = tuft('grass');
    const body = movingBox(physics, 75, 2);
    for (let i = 0; i < 30; i++) physics.step();
    expect(Math.abs(plant.bend.z)).toBeGreaterThan(0.001);
    expect(plant.record.broken).toBe(false);
    for (let i = 0; i < 220; i++) physics.step();
    expect(body.translation().x).toBeGreaterThan(4);
    expect(Math.abs(plant.bend.z)).toBeLessThan(0.001);
    field.dispose();
  });

  it('sweeps fast objects against the mesh so a thin plant cannot be skipped', () => {
    const { physics, field, plant } = tuft('shrubs');
    movingBox(physics, 40, 160, -1);
    physics.step();
    expect(plant.record.damage).toBeGreaterThan(0);
    expect(plant.record.broken).toBe(true);
    field.dispose();
  });

  it('crushes grass under a heavy chassis and remembers it across streaming and saves', () => {
    const memory = new WorldMemory();
    const a = tuft('grass', memory.vegetation);
    movingBox(a.physics, 1500, 2);
    for (let i = 0; i < 25; i++) a.physics.step();
    expect(a.plant.record.broken).toBe(true);
    a.field.dispose();
    const restored = WorldMemory.restore(JSON.parse(JSON.stringify(memory.serialize())));
    const b = tuft('grass', restored.vegetation);
    expect(b.plant.record.broken).toBe(true);
    const m = new THREE.Matrix4();
    b.mesh.getMatrixAt(0, m);
    expect(m.elements[5]).toBeLessThan(0.2);
    b.field.dispose();
  });

  it('does not accumulate damage from a stationary object standing in a plant', () => {
    const { physics, field, plant } = tuft('grass');
    movingBox(physics, 75, 0, 0);
    for (let i = 0; i < 180; i++) physics.step();
    expect(plant.record.damage).toBe(0);
    expect(plant.record.broken).toBe(false);
    field.dispose();
  });

  it('reacts to the tangential velocity of a rotating object', () => {
    const { physics, field, plant } = tuft('shrubs');
    const body = movingBox(physics, 50, 0, -0.2);
    body.setAngvel({ x: 0, y: 8, z: 0 }, true);
    physics.step();
    expect(Math.abs(plant.bend.vx)).toBeGreaterThan(0);
    field.dispose();
  });

  it('moves a kinematic player through foliage on its first walking step', () => {
    const { physics, field, plant } = tuft('shrubs');
    const player = physics.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(-0.4, 0.6, 0));
    physics.world.createCollider(RAPIER.ColliderDesc.capsule(0.3, 0.25).setCollisionGroups(GROUPS.player), player);
    player.setNextKinematicTranslation({ x: -0.15, y: 0.6, z: 0 });
    physics.step();
    expect(Math.abs(plant.bend.z)).toBeGreaterThan(0);
    expect(plant.record.broken).toBe(false);
    field.dispose();
  });
});

describe('graduated damage', () => {
  const height = (mesh: THREE.InstancedMesh) => { const m = new THREE.Matrix4(); mesh.getMatrixAt(0, m); return m.elements[5]; };
  it('has no step between untouched, damaged and crushed', () => {
    let last = 0;
    for (let d = 0; d <= 1.001; d += 0.05) {
      expect(setAngle(d, false)).toBeGreaterThanOrEqual(last);
      expect(setAngle(d, false) - last).toBeLessThan(0.3);
      last = setAngle(d, false);
    }
    expect(setAngle(1, false)).toBeCloseTo(1.35);
    expect(flatten(1)).toBeCloseTo(0.25);
    expect(flatten(0.2)).toBeGreaterThan(0.75);
    expect(crushShare(75)).toBeLessThan(0.05);
    expect(crushShare(1500)).toBeGreaterThan(0.9);
    expect(coverage(0, 0.3, 0, 1)).toBeCloseTo(0.3);
    expect(coverage(0, 5, 0, 1)).toBe(1);
  });

  it('leaves a lasting partial flatten that grows with the hitter, never just on/off', () => {
    const shown: number[] = [], damage: number[] = [];
    for (const [mass, speed] of [[2, 1.5], [75, 1.5], [250, 3], [1500, 6]]) {
      const { physics, field, mesh, plant } = tuft('shrubs');
      movingBox(physics, mass, speed);
      for (let i = 0; i < 90; i++) physics.step();
      shown.push(height(mesh)); damage.push(plant.record.damage);
      field.dispose();
    }
    for (let i = 1; i < damage.length; i++) expect(damage[i]).toBeGreaterThan(damage[i - 1]);
    for (let i = 1; i < shown.length; i++) expect(shown[i]).toBeLessThanOrEqual(shown[i - 1] + 1e-6);
    expect(damage.some((d) => d > 0.02 && d < 0.98)).toBe(true);
    expect(shown.some((h) => h < 0.98 && h > 0.3)).toBe(true);
  });

  it('a person walking through grass bends it without breaking it, a car breaks it, and heavier is worse', () => {
    const d = (mass: number, speed: number) => {
      const { physics, field, plant } = tuft('grass');
      movingBox(physics, mass, speed);
      for (let i = 0; i < 90; i++) physics.step();
      field.dispose();
      return plant.record.damage;
    };
    const walk = d(75, 1.5), jeep = d(1500, 5), truck = d(8000, 5);
    expect(walk).toBeLessThan(0.5);
    expect(jeep).toBeGreaterThanOrEqual(1);
    expect(truck).toBeGreaterThanOrEqual(jeep);
    expect(d(75, 6)).toBeGreaterThan(walk);
  });
});

describe('wood impacts and falling trees', () => {
  it('leaves mature oak standing under a blow that breaks a dead snag', () => {
    for (const species of ['snag', 'oak']) {
      const physics = new PhysicsWorld(), field = new Vegetation(physics);
      field.addTrees([tree(species)]);
      const p = field.plants[0];
      expect(p.solid!.shape.type).toBe(RAPIER.ShapeType.TriMesh);
      physics.hitCollider(p.solid!.handle, hit(12000, 500));
      expect(p.record.broken).toBe(species === 'snag');
      if (species === 'snag') expect(p.body!.isDynamic()).toBe(true);
      else expect(p.body).toBeUndefined();
      field.dispose();
    }
  });

  it('breaks a weaker trunk from real solver impulses and scales with hitter momentum', () => {
    const results: boolean[] = [];
    for (const [mass, speed] of [[75, 2], [1500, 15]]) {
      const physics = new PhysicsWorld(), field = new Vegetation(physics);
      field.addTrees([tree()]);
      const p = field.plants[0];
      movingBox(physics, mass, speed, -2.5);
      for (let i = 0; i < 160; i++) physics.step();
      results.push(p.record.broken);
      field.dispose();
    }
    expect(results).toEqual([false, true]);
  });

  it('keeps fallen physics, the near mesh and impostor together and releases them on unload', () => {
    const physics = new PhysicsWorld(), memory: VegetationMemory = new Map();
    physics.addStaticBox(0, -0.5, 0, 30, 0.5, 30);
    let breaks = 0;
    const field = new Vegetation(physics, memory, () => breaks++);
    const trees = [tree()];
    field.addTrees(trees);
    const gen = buildTreesSteps(trees);
    let result = gen.next();
    while (!result.done) result = gen.next();
    field.bindTrees(result.value);
    const p = field.plants[0], oldHandle = p.solid!.handle;
    physics.hitCollider(oldHandle, hit(15000, 1000));
    for (let i = 0; i < 180; i++) physics.step();
    expect(breaks).toBe(1);
    expect(p.body!.translation().y).toBeGreaterThan(-1);
    expect(Math.abs(p.body!.rotation().z)).toBeGreaterThan(0.1);
    const matrix = new THREE.Matrix4();
    result.value.near[0].getMatrixAt(0, matrix);
    expect(matrix.elements[12]).toBeCloseTo(p.body!.translation().x, 4);
    // A settled tree must stop uploading a whole instance buffer, then follow a new impact immediately.
    p.body!.sleep(); physics.step();
    const attribute = result.value.near[0].instanceMatrix;
    const settledVersion = attribute.version;
    const settledPose = memory.get(vegetationKey('tree', 0, 0))!.pose;
    for (let i = 0; i < 20; i++) physics.step();
    expect(attribute.version).toBe(settledVersion);
    expect(memory.get(vegetationKey('tree', 0, 0))!.pose).toBe(settledPose);
    attribute.clearUpdateRanges();
    p.body!.applyImpulse({ x: 50, y: 50, z: 0 }, true); physics.step();
    expect(attribute.version).toBeGreaterThan(settledVersion);
    expect(attribute.updateRanges).toEqual([{ start: 0, count: 16 }]);
    result.value.near[0].getMatrixAt(0, matrix);
    expect(matrix.elements[12]).toBeCloseTo(p.body!.translation().x, 4);
    expect(physics.impactHandlers.has(oldHandle)).toBe(false);
    const pose = [...memory.get(vegetationKey('tree', 0, 0))!.pose!];
    field.dispose();
    expect(physics.beforeStep.size).toBe(0);
    expect(physics.afterStep.size).toBe(0);
    expect(physics.areaImpactHandlers.size).toBe(0);
    expect(physics.world.bodies.len()).toBe(0);
    const reloaded = new Vegetation(physics, memory);
    reloaded.addTrees(trees);
    expect(reloaded.plants[0].body!.translation().x).toBeCloseTo(pose[0], 5);
    reloaded.dispose();
  });

  it('gives desert dead-tree props mesh collisions and a physical fall', () => {
    const physics = new PhysicsWorld(), field = new Vegetation(physics);
    physics.addStaticBox(0, -0.5, 0, 20, 0.5, 20);
    const geo = propBuilder({ kind: 'deadTree', seed: 2 })!.build();
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial(), 1);
    mesh.setMatrixAt(0, new THREE.Matrix4());
    const p = field.addDeadTree(mesh)!;
    expect(p.solid!.shape.type).toBe(RAPIER.ShapeType.TriMesh);
    physics.hitCollider(p.solid!.handle, hit(100000, 2000));
    expect(p.record.broken).toBe(true);
    expect(p.colliders.length).toBeGreaterThan(3);
    expect(p.body!.mass()).toBeGreaterThan(10);
    for (let i = 0; i < 240; i++) physics.step();
    expect(p.body!.translation().y).toBeGreaterThan(-1);
    field.dispose();
  });

  it('reacts to projectile mesh hits only up to the first blocking hit', () => {
    const { physics, field, plant } = tuft('grass');
    physics.hitAlongRay({ ...hit(500, 8), x: -2, y: 0.6, kind: 'bullet' }, 1);
    expect(plant.record.damage).toBe(0);
    physics.hitAlongRay({ ...hit(500, 8), x: -2, y: 0.6, kind: 'bullet' }, 3);
    expect(plant.record.damage).toBeGreaterThan(0);
    expect(Math.abs(plant.bend.vz)).toBeGreaterThan(0);
    field.dispose();
    expect(physics.rayImpactHandlers.size).toBe(0);
  });

  it('scorched wood loses strength and a centered blast still starts a fall', () => {
    const physics = new PhysicsWorld(), field = new Vegetation(physics);
    field.addTrees([tree('oak')]);
    const p = field.plants[0], strength = p.material.strength;
    field.charTree(0, 1);
    expect(p.material.strength).toBe(strength * 0.25);
    physics.hitArea({ ...hit(1000000, 3000), dx: 0, dz: 0, kind: 'blast', radius: 5 });
    expect(p.record.broken).toBe(true);
    expect(Math.abs(p.body!.angvel().z)).toBeGreaterThan(0.1);
    field.dispose();
  });

  it('uses scale and impact height, and damages both wood and ground cover with blasts', () => {
    const physics = new PhysicsWorld(), field = new Vegetation(physics);
    field.addTrees([tree('snag', 0.6), { ...tree('snag', 1.3), x: 3 }]);
    physics.hitArea({ ...hit(10000, 500), kind: 'blast', radius: 8 });
    expect(field.plants[0].record.broken).toBe(true);
    expect(field.plants[0].record.damage).toBeGreaterThan(field.plants[1].record.damage);
    field.dispose();
  });
});
