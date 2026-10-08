import * as THREE from 'three';
import { RAPIER, G, GROUPS, groups, type Collider, type PhysicsWorld, type PhysicsImpact, type RigidBody, type TreeFall, type TreeShot, type TreeTarget } from '../physics/physics';
import { TREE_DIMS, TREE_SPECIES, type TreeSpot } from '../world/flora';
import { coverage, crushShare, flatten, newBend, PLANT_MECHANICS, setAngle, stepBend, TREE_MECHANICS, treeMechanics, vegetationKey, type BendState, type PlantKind, type VegetationMaterial, type VegetationMemory, type VegetationRecord } from '../sim/vegetation';
import { AMMO } from '../sim/ballistics';
import { addNotch, bandMid, BUSH_LEAF, deepest, leafTear, NOTCH, notchGain, shredShare, snapShare, WOOD, type NotchHit, type WoodKind } from '../sim/treeDamage';
import { addTreeSlot, setTreeNotch, treeGeometry, treeInstances, type TreeSet } from './trees';
import type { ScatterSet } from './scatter';

interface ShapeMesh { vertices: Float32Array; indices: Uint32Array }
const treeShapes = new Map<string, ShapeMesh>();
/** Wood only: leaf cards must never become a solid wall round a canopy. Exact variant and render vertices. */
export function treeCollisionMesh(sp: number, variant: number, foliage = false): ShapeMesh {
  const key = `${sp}:${variant}:${foliage}`;
  let mesh = treeShapes.get(key);
  if (mesh) return mesh;
  const geo = treeGeometry(sp);
  const p = geo.getAttribute('position');
  const t = geo.getAttribute('tree');
  const idx = geo.index!;
  const remap = new Map<number, number>();
  const vertices: number[] = [], indices: number[] = [];
  for (let i = 0; i < idx.count; i += 3) {
    const tri = [idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)];
    if (t.getY(tri[0]) !== variant || tri.some((v) => t.getX(v) > 0) !== foliage) continue;
    for (const v of tri) {
      if (!remap.has(v)) {
        remap.set(v, vertices.length / 3);
        vertices.push(p.getX(v), p.getY(v), p.getZ(v));
      }
      indices.push(remap.get(v)!);
    }
  }
  mesh = { vertices: Float32Array.from(vertices), indices: Uint32Array.from(indices) };
  treeShapes.set(key, mesh);
  return mesh;
}

const hullCache = new WeakMap<THREE.BufferGeometry, Float32Array[]>();
/** Weld coincident render corners and collect the separate limbs of a wood-only prop. */
function woodPieces(geo: THREE.BufferGeometry): Float32Array[] {
  const cached = hullCache.get(geo);
  if (cached) return cached;
  const pos = geo.getAttribute('position'), idx = geo.index!;
  const parent = Array.from({ length: pos.count }, (_, i) => i);
  const root = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const weld = new Map<string, number>();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(5)},${pos.getY(i).toFixed(5)},${pos.getZ(i).toFixed(5)}`;
    const other = weld.get(key);
    if (other !== undefined) parent[root(i)] = root(other);
    else weld.set(key, i);
  }
  for (let i = 0; i < idx.count; i += 3) {
    const a = root(idx.getX(i));
    parent[root(idx.getX(i + 1))] = a;
    parent[root(idx.getX(i + 2))] = a;
  }
  const groups = new Map<number, number[]>();
  for (const i of weld.values()) {
    const key = root(i), vertices = groups.get(key) ?? [];
    vertices.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    groups.set(key, vertices);
  }
  const hulls = [...groups.values()].filter((v) => v.length >= 12).map((v) => Float32Array.from(v));
  hullCache.set(geo, hulls);
  return hulls;
}

interface InstanceRef { mesh: THREE.InstancedMesh; index: number; base: THREE.Matrix4 }
export interface VegetationPlant {
  key: string;
  kind: string;
  position: THREE.Vector3;
  rotation: THREE.Quaternion;
  scale: THREE.Vector3;
  material: VegetationMaterial;
  height: number;
  radius: number;
  bend: BendState;
  record: VegetationRecord;
  shape: RAPIER.Shape | null;
  /** Shared immutable geometry; a scaled contact shape is needed only when something reaches this plant. */
  shapeSource?: { vertices: Float32Array; indices: Uint32Array };
  refs: InstanceRef[];
  tree?: TreeSpot;
  woodHulls?: Float32Array[];
  treeIndex?: number;
  solid?: Collider;
  body?: RigidBody;
  colliders: Collider[];
  contacts: Set<number>;
  sensor?: Collider;
  sensorLife?: number;
  /** What a tree's wood is, for weapons (`physics.trees`). */
  wood?: WoodKind;
  /** Upright stretches of its stems, model units, worked out the first time a round needs them. */
  stems?: StemSeg[];
  /** The stem a notch was cut in (model centre x, z and radius), for drawing it. */
  notchStem?: [number, number, number];
  /** A snapped tree's stump: its fixed body (with the wood below the break) and the extra instance that draws it. */
  stump?: { body: RigidBody; colliders: Collider[]; ref?: { mesh: THREE.InstancedMesh; index: number } };
  /** The hinge of uncut wood the top swings over on as it goes, until it tears. */
  hinge?: RAPIER.ImpulseJoint;
  /** The top coming down, until it has landed and settled. */
  fall?: TreeFall & { t: number; tipVy: number; landedAt: number; stuck: number; nudges: number };
}

/** An upright stretch of a stem between two of its rings, model units: heights, ring centres (x, z) and radii. */
interface StemSeg { ya: number; yb: number; ax: number; az: number; bx: number; bz: number; ra: number; rb: number }

/**
 * Height (model units) below which a species' stem is one trunk a notch can be cut in: up to where its limbs part (an
 * acacia's fork stems are still taken, a gum's tall stems up to a good way up). Shots higher only chip and shake leaves.
 */
const NOTCH_TOP: Record<WoodKind, number> = { oak: 2.9, pine: 4, willow: 2.3, poplar: 2, palm: 6, acacia: 1.6, cypress: 4, snag: 3.5, eucalyptus: 5, deadTree: 2 };
/** A falling top passes through people (it hurts and throws them instead, see `game/timber.ts`) until it has landed. */
const FALLING = groups(G.LOOSE, G.STATIC | G.ROAD | G.VEHICLE | G.FURN | G.BUILD | G.LOOSE);

/** Mean radius of a tube piece's two rings (or half its widest extent, for a piece that is not one). */
function pieceRadius(v: Float32Array): number {
  const n = v.length / 3;
  if (n < 6 || n % 2) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { lo = Math.min(lo, v[i * 3]); hi = Math.max(hi, v[i * 3]); }
    return (hi - lo) / 2;
  }
  const h = n / 2;
  let r = 0;
  for (const o of [0, h]) {
    let cx = 0, cy = 0, cz = 0;
    for (let i = o; i < o + h; i++) { cx += v[i * 3]; cy += v[i * 3 + 1]; cz += v[i * 3 + 2]; }
    cx /= h; cy /= h; cz /= h;
    for (let i = o; i < o + h; i++) r += Math.hypot(v[i * 3] - cx, v[i * 3 + 1] - cy, v[i * 3 + 2] - cz);
  }
  return r / n;
}

/** The rings of each tube piece of a model's wood as stem stretches: only those standing more upright than not. */
function stemSegments(hulls: Float32Array[]): StemSeg[] {
  const out: StemSeg[] = [];
  for (const v of hulls) {
    const n = v.length / 3;
    if (n < 6 || n % 2) continue;
    const h = n / 2;
    let ax = 0, ay = 0, az = 0, bx = 0, by = 0, bz = 0;
    for (let i = 0; i < h; i++) {
      ax += v[i * 3]; ay += v[i * 3 + 1]; az += v[i * 3 + 2];
      bx += v[(i + h) * 3]; by += v[(i + h) * 3 + 1]; bz += v[(i + h) * 3 + 2];
    }
    ax /= h; ay /= h; az /= h; bx /= h; by /= h; bz /= h;
    let ra = 0, rb = 0;
    for (let i = 0; i < h; i++) {
      ra += Math.hypot(v[i * 3] - ax, v[i * 3 + 1] - ay, v[i * 3 + 2] - az);
      rb += Math.hypot(v[(i + h) * 3] - bx, v[(i + h) * 3 + 1] - by, v[(i + h) * 3 + 2] - bz);
    }
    const L = Math.hypot(bx - ax, by - ay, bz - az);
    if (L < 1e-4 || Math.abs(by - ay) / L < 0.55) continue;
    if (ay <= by) out.push({ ya: ay, yb: by, ax, az, bx, bz, ra: ra / h, rb: rb / h });
    else out.push({ ya: by, yb: ay, ax: bx, az: bz, bx: ax, bz: az, ra: rb / h, rb: ra / h });
  }
  return out;
}

/**
 * The part of a convex piece (x, y, z triples) above (or below) the plane y = c, as points whose hull is exactly that part:
 * its own points on that side and where every segment between points on either side crosses the plane. Null if too little
 * is left to make a solid.
 */
export function clipHull(v: Float32Array, c: number, above: boolean): Float32Array | null {
  const n = v.length / 3;
  const out: number[] = [];
  let kept = 0;
  for (let i = 0; i < n; i++) {
    const y = v[i * 3 + 1];
    if (above ? y >= c : y <= c) { out.push(v[i * 3], y, v[i * 3 + 2]); kept++; }
  }
  if (kept === n) return v;
  if (!kept) return null;
  for (let i = 0; i < n; i++) {
    const yi = v[i * 3 + 1];
    for (let j = i + 1; j < n; j++) {
      const yj = v[j * 3 + 1];
      if ((yi - c) * (yj - c) >= 0) continue;
      const t = (c - yi) / (yj - yi);
      out.push(v[i * 3] + (v[j * 3] - v[i * 3]) * t, c, v[i * 3 + 2] + (v[j * 3 + 2] - v[i * 3 + 2]) * t);
    }
  }
  return out.length >= 12 ? Float32Array.from(out) : null;
}

/** Bodies of fallen trees and snapped tops, by physics world: ground cover does not drag on them. */
const LOGS = new WeakMap<PhysicsWorld, Set<number>>();

/** A tree's wood as the weapons see it: notched while it stands, chipped once it is a stump or a fallen top. */
class TreeWood implements TreeTarget {
  constructor(private veg: Vegetation, private p: VegetationPlant, readonly wood: WoodKind, readonly standing: boolean, private part: 'tree' | 'stump' | 'top') {}
  moving() {
    const b = this.part === 'top' ? this.p.body : undefined;
    if (!b || b.isSleeping()) return false;
    const v = b.linvel(), w = b.angvel();
    return Math.hypot(v.x, v.y, v.z) + Math.hypot(w.x, w.y, w.z) > 0.15;
  }
  stemRadius(x: number, y: number, z: number) { return this.part === 'top' ? 0 : this.veg.stemRadius(this.p, x, y, z); }
  crown() { return this.part === 'tree' ? this.veg.crownOf(this.p) : null; }
  hardness() { return this.veg.hardness(this.p); }
  shot(s: TreeShot) { return this.part === 'tree' ? this.veg.shootTree(this.p, s) : 0; }
}

const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3();
const Q2 = new THREE.Quaternion(), V2 = new THREE.Vector3(), V3 = new THREE.Vector3(), C = new THREE.Color();
const ZERO = { x: 0, y: 0, z: 0 };
const CELL = 8;
const NOTCH_STEP = NOTCH.step;
/** Scratch for one round's sums: no allocation per hit. */
const SEC = { area: 0, cx: 0, cz: 0, r: 0 };
const STEMS = new Float32Array(16 * 3);
const CROWN = { x: 0, y: 0, z: 0, r: 0, h: 0 };
const HIT: NotchHit = { ammo: 'pistol', speed: 0, work: 0, section: 0, diameter: 0, done: 0, hard: 1 };

/**
 * Plants a person can hide in, and how thick each is: the share of a sight line it lets through falls off as
 * exp(-density × metres of it crossed). Through the heart of a common bush that is about a tenth. Grass and flowers hide nobody.
 */
const LEAF_DENSITY: Partial<Record<string, number>> = {
  shrubs: 2.2, oleander: 2.4, cane: 2.6, reeds: 1.4, papyrus: 1.6, ferns: 1.0, bramble: 2.2, sabra: 1.6, fig: 2.0,
};
/** The drawn cards are sprites: their leaves fill this share of the card's width and height. */
const LEAF_FILL = 0.85;
/** Widest reach of any screening plant (m), so a sight line's cell walk does not miss one rooted in the next cell. */
const LEAF_REACH = 3;
interface Screen { p: VegetationPlant; r: number; k: number }
const screenKey = (ix: number, iz: number) => (ix + 32768) * 65536 + (iz + 32768);

/**
 * A chunk's wood colliders and flexible mesh contact shapes. Only nearby moving objects query ground cover;
 * grass/foliage consume momentum gently instead of blocking a person like concrete. Rooted plants use damped
 * angular springs. Broken herbs remain flattened; unrooted trees become compound convex rigid bodies made
 * from their drawn wood rings, so Rapier carries their weight, gravity and subsequent impacts.
 */
export class Vegetation {
  readonly plants: VegetationPlant[] = [];
  private bins = new Map<string, VegetationPlant[]>();
  private bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  private trees: VegetationPlant[] = [];
  private treeByCollider = new Map<number, VegetationPlant>();
  private active = new Set<VegetationPlant>();
  private drawnSleeping = new WeakSet<VegetationPlant>();
  private sensors = new Set<VegetationPlant>();
  /** Plants a person can hide in, binned like `bins`, for sight lines. */
  private screens = new Map<number, Screen[]>();
  private before = (dt: number) => this.touch(dt);
  private after = (dt: number) => this.update(dt);
  private area = (hit: PhysicsImpact) => this.hitArea(hit);
  private ray = (hit: PhysicsImpact, distance: number) => this.hitRay(hit, distance);
  /** Tops of snapped trees on their way down. */
  private falling = new Set<VegetationPlant>();

  /**
   * `onTreeBreak` is told when one of `addTrees`' trees goes down: with the height (world y) of its stump's top when gunfire
   * snapped it, or nothing when it went over whole.
   */
  constructor(private physics: PhysicsWorld, readonly memory: VegetationMemory = new Map(), private onTreeBreak?: (index: number, stumpTop?: number) => void) {
    physics.beforeStep.add(this.before);
    physics.afterStep.add(this.after);
    physics.areaImpactHandlers.add(this.area);
    physics.rayImpactHandlers.add(this.ray);
  }

  private add(p: VegetationPlant) {
    this.plants.push(p);
    this.bounds.minX = Math.min(this.bounds.minX, p.position.x);
    this.bounds.maxX = Math.max(this.bounds.maxX, p.position.x);
    this.bounds.minZ = Math.min(this.bounds.minZ, p.position.z);
    this.bounds.maxZ = Math.max(this.bounds.maxZ, p.position.z);
    const key = `${Math.floor(p.position.x / CELL)},${Math.floor(p.position.z / CELL)}`;
    const bin = this.bins.get(key) ?? [];
    bin.push(p);
    this.bins.set(key, bin);
    if (p.record.broken) { p.record.damage = Math.max(1, p.record.damage); this.active.add(p); }
  }

  addTrees(trees: TreeSpot[]) {
    const instances = treeInstances(trees);
    trees.forEach((t, treeIndex) => {
      const base = new THREE.Matrix4().fromArray(instances[treeIndex].m);
      const position = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3();
      base.decompose(position, rotation, scale);
      const key = vegetationKey('tree', t.x, t.z);
      const material = treeMechanics(TREE_SPECIES[t.sp], t.s);
      const wood = treeCollisionMesh(t.sp, t.v);
      const leaf = treeCollisionMesh(t.sp, t.v, true);
      const verts = wood.vertices.map((v) => v * t.s);
      const solid = this.physics.tag(this.physics.world.createCollider(RAPIER.ColliderDesc.trimesh(verts, wood.indices)
        .setTranslation(t.x, t.y, t.z).setRotation(rotation).setCollisionGroups(GROUPS.furn).setFriction(0.7).setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(0)), 'wood');
      const p: VegetationPlant = {
        key, kind: TREE_SPECIES[t.sp], position, rotation, scale, material, height: material.height,
        radius: treeGeometry(t.sp).boundingSphere!.radius * t.s,
        bend: newBend(), record: this.memory.get(key) ?? { damage: 0, broken: false },
        shape: leaf.indices.length ? new RAPIER.TriMesh(leaf.vertices.map((v) => v * t.s), leaf.indices) : null,
        refs: [], tree: t, treeIndex, solid, colliders: [solid], contacts: new Set(),
        woodHulls: (treeGeometry(t.sp).userData.woodHulls as { variant: number; vertices: Float32Array }[]).filter((h) => h.variant === t.v).map((h) => h.vertices),
      };
      this.physics.impactHandlers.set(solid.handle, (hit) => this.hit(p, hit));
      p.wood = TREE_SPECIES[t.sp];
      this.physics.trees.set(solid.handle, new TreeWood(this, p, p.wood, true, 'tree'));
      this.trees.push(p);
      this.treeByCollider.set(solid.handle, p);
      this.add(p);
      if (p.record.broken) {
        if (p.record.cut !== undefined) this.snap(p, p.record.cut, p.record.direction ?? [1, 0]);
        else this.fall(p, p.record.direction ?? [1, 0]);
      }
    });
  }

  bindTrees(set: TreeSet) {
    const slots = new Map<number, number>();
    for (const p of this.trees) {
      const t = p.tree!;
      const key = t.sp * 3 + t.v;
      const index = slots.get(key) ?? 0;
      slots.set(key, index + 1);
      const mesh = set.near.find((m) => m.userData.sp === t.sp && m.userData.variant === t.v)!;
      mesh.getMatrixAt(index, M);
      p.refs.push({ mesh, index, base: M.clone() });
      if (set.far) {
        set.far.getMatrixAt(p.treeIndex!, M);
        p.refs.push({ mesh: set.far, index: p.treeIndex!, base: M.clone() });
      }
      this.draw(p);
      this.wound(p);
    }
  }

  addScatter(set: ScatterSet) {
    for (const kind of Object.keys(PLANT_MECHANICS) as PlantKind[]) {
      const mesh = (set as unknown as Record<string, THREE.InstancedMesh | null>)[kind];
      if (mesh) this.addInstances(mesh, kind);
    }
  }

  /** Returns entries so a crop/fruit mesh can follow the same plant without a second collider. */
  addInstances(mesh: THREE.InstancedMesh, kind: PlantKind, keys?: string[]): VegetationPlant[] {
    const out: VegetationPlant[] = [];
    const geo = mesh.geometry;
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    const positions = geo.getAttribute('position').array as Float32Array;
    const indices = geo.index ? Uint32Array.from(geo.index.array) : Uint32Array.from({ length: positions.length / 3 }, (_, i) => i);
    const shapeSource = { vertices: positions.slice(), indices };
    for (let index = 0; index < mesh.count; index++) {
      mesh.getMatrixAt(index, M);
      const base = M.clone(), position = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3();
      base.decompose(position, rotation, scale);
      if (scale.lengthSq() < 1e-8) continue;
      const key = keys?.[index] ?? vegetationKey(kind, position.x, position.z);
      const s = Math.max(scale.x, scale.y, scale.z);
      const material = { ...PLANT_MECHANICS[kind], mass: PLANT_MECHANICS[kind].mass * s ** 3, strength: PLANT_MECHANICS[kind].strength * s ** 3 };
      const p: VegetationPlant = {
        key, kind, position, rotation, scale, material, height: Math.max(0.1, geo.boundingBox!.max.y * scale.y),
        radius: geo.boundingSphere!.radius * s, bend: newBend(), record: this.memory.get(key) ?? { damage: 0, broken: false },
        shape: null, shapeSource,
        refs: [{ mesh, index, base }], colliders: [], contacts: new Set(),
      };
      this.add(p);
      const k = LEAF_DENSITY[kind];
      if (k) {
        const bb = geo.boundingBox!;
        const r = Math.max(-bb.min.x, bb.max.x, -bb.min.z, bb.max.z) * Math.max(scale.x, scale.z) * LEAF_FILL;
        const key = screenKey(Math.floor(position.x / CELL), Math.floor(position.z / CELL));
        const bin = this.screens.get(key) ?? [];
        bin.push({ p, r: Math.min(r, LEAF_REACH), k });
        this.screens.set(key, bin);
      }
      out.push(p);
      if (p.record.damage > 0 || p.record.broken || p.record.burnt) this.draw(p);
    }
    return out;
  }

  /** Desert dead-tree props also own their actual mesh and brittle-wood physics. */
  addDeadTree(mesh: THREE.InstancedMesh) {
    const m = new THREE.Matrix4();
    mesh.getMatrixAt(0, m);
    const position = new THREE.Vector3().setFromMatrixPosition(m);
    const p = this.addInstances(mesh, 'fig', [vegetationKey('deadTree', position.x, position.z)])[0];
    if (!p) return;
    p.kind = 'deadTree';
    // Bare wood hides nobody: its trunk is solid to a sight line through its collider instead.
    const bin = this.screens.get(screenKey(Math.floor(p.position.x / CELL), Math.floor(p.position.z / CELL)));
    const at = bin?.findIndex((s) => s.p === p) ?? -1;
    if (at >= 0) bin!.splice(at, 1);
    p.material = treeMechanics('snag', p.scale.x);
    p.shape = null;
    p.shapeSource = undefined;
    p.woodHulls = woodPieces(mesh.geometry);
    const vertices = (mesh.geometry.getAttribute('position').array as Float32Array).map((v, i) => v * [p.scale.x, p.scale.y, p.scale.z][i % 3]);
    p.solid = this.physics.tag(this.physics.world.createCollider(RAPIER.ColliderDesc.trimesh(vertices, Uint32Array.from(mesh.geometry.index!.array))
      .setTranslation(p.position.x, p.position.y, p.position.z).setRotation(p.rotation).setCollisionGroups(GROUPS.furn)
      .setFriction(0.7).setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(0)), 'wood');
    p.colliders.push(p.solid);
    this.treeByCollider.set(p.solid.handle, p);
    this.physics.impactHandlers.set(p.solid.handle, (hit) => this.hit(p, hit));
    p.wood = 'deadTree';
    this.physics.trees.set(p.solid.handle, new TreeWood(this, p, 'deadTree', true, 'tree'));
    if (p.record.broken) { this.fall(p, p.record.direction ?? [1, 0]); this.draw(p); }
    return p;
  }

  bindCompanion(p: VegetationPlant, mesh: THREE.InstancedMesh, index: number) {
    mesh.getMatrixAt(index, M);
    p.refs.push({ mesh, index, base: M.clone() });
    this.draw(p);
  }

  private near(x: number, z: number, radius: number, f: (p: VegetationPlant) => void) {
    const b = this.bounds;
    if (x + radius < b.minX || x - radius > b.maxX || z + radius < b.minZ || z - radius > b.maxZ) return;
    for (let ix = Math.floor((x - radius) / CELL); ix <= Math.floor((x + radius) / CELL); ix++) {
      for (let iz = Math.floor((z - radius) / CELL); iz <= Math.floor((z + radius) / CELL); iz++) {
        for (const p of this.bins.get(`${ix},${iz}`) ?? []) f(p);
      }
    }
  }

  private sensor(p: VegetationPlant): Collider {
    p.sensorLife = 1;
    if (p.sensor) return p.sensor;
    if (!p.shape && p.shapeSource) {
      const source = p.shapeSource, vertices = new Float32Array(source.vertices.length), scale = p.scale;
      for (let i = 0; i < vertices.length; i += 3) {
        vertices[i] = source.vertices[i] * scale.x;
        vertices[i + 1] = source.vertices[i + 1] * scale.y;
        vertices[i + 2] = source.vertices[i + 2] * scale.z;
      }
      p.shape = new RAPIER.TriMesh(vertices, source.indices);
    }
    // Keep the native mesh/BVH while it is nearby. Rebuilding a triangle mesh in each query is expensive.
    p.sensor = this.physics.world.createCollider(new RAPIER.ColliderDesc(p.shape!).setSensor(true).setCollisionGroups(0)
      .setTranslation(p.position.x, p.position.y, p.position.z).setRotation(this.rotation(p)));
    this.sensors.add(p);
    return p.sensor;
  }

  private touch(dt: number) {
    if (!this.plants.length) return;
    const touching = new Map<VegetationPlant, Set<number>>();
    const logs = LOGS.get(this.physics);
    for (const source of this.physics.moving) {
      // Motion is sampled once by PhysicsWorld, shared by all streamed vegetation chunks.
      const { sweepVelocity: velocity, speed, edgeSpeed } = source;
      if (speed + edgeSpeed < 0.08) continue;
      // A tree coming down is not held back by the grass and bushes it falls through (and two dozen pieces of it sweeping
      // the ground cover every step would cost more than the fall); it does thrash its neighbours' crowns.
      const log = !!logs?.has(source.body.handle);
      const reach = source.radius + speed * dt + 10;
      this.near(source.position.x, source.position.z, reach, (p) => {
        if (p.record.broken || (!p.shape && !p.shapeSource) || p.body === source.body || (log && !p.woodHulls)) return;
        if (Math.hypot(p.position.x - source.position.x, p.position.z - source.position.z) > source.radius + p.radius + speed * dt) return;
        if (source.position.y + source.radius + speed * dt < p.position.y || source.position.y - source.radius - speed * dt > p.position.y + p.height) return;
        const contact = source.collider.castCollider(velocity, this.sensor(p), ZERO, 0.015, dt, true);
        if (!contact && !(edgeSpeed > 0.08 && source.collider.contactCollider(this.sensor(p), 0.015))) return;
        const at = { x: p.position.x, y: p.position.y + p.height * 0.5, z: p.position.z };
        const pointVelocity = source.body.isKinematic() ? velocity : source.body.velocityAtPoint(at);
        const contactSpeed = Math.hypot(pointVelocity.x, pointVelocity.y, pointVelocity.z);
        if (contactSpeed < 0.08) return;
        const seen = touching.get(p) ?? new Set<number>();
        if (seen.has(source.body.handle)) return;
        seen.add(source.body.handle);
        touching.set(p, seen);
        const fresh = !p.contacts.has(source.body.handle);
        const movingMass = p.woodHulls ? p.material.mass * 0.005 : p.material.mass;
        const reducedMass = source.mass * movingMass / Math.max(0.001, source.mass + movingMass);
        // Continuous work depends on time; merely standing inside grass never repeatedly damages it.
        const fraction = fresh ? 1 : dt * 3;
        // How much of the plant the body actually spans: a low bumper works the base, a tall body the whole stem.
        const span = coverage(source.position.y - source.radius, source.position.y + source.radius, p.position.y, p.height);
        const impulse = reducedMass * contactSpeed * fraction * Math.max(0.2, span);
        let energy = 0.5 * reducedMass * contactSpeed * contactSpeed * fraction * span;
        // Weight pressing a soft plant flat grows smoothly with mass and with the speed it drives over (a creeping boot
        // trampling is gentle, a rolling wheel crushes), instead of switching on at a mass threshold.
        if (!p.woodHulls) energy += source.mass * 9.81 * p.height * 0.08 * fraction * crushShare(source.mass) * span * Math.min(1, contactSpeed / 3);
        const centre = Math.max(p.position.y, Math.min(source.position.y, p.position.y + p.height));
        this.hit(p, { x: p.position.x, y: centre, z: p.position.z,
          dx: pointVelocity.x / contactSpeed, dy: pointVelocity.y / contactSpeed, dz: pointVelocity.z / contactSpeed, impulse, energy: p.woodHulls ? 0 : energy, kind: 'contact' });
        if (!p.woodHulls && source.body.isDynamic() && speed > 0.08) {
          const drag = Math.min(impulse * 0.15, source.mass * speed * 0.03);
          source.body.applyImpulse({ x: -velocity.x / speed * drag, y: 0, z: -velocity.z / speed * drag }, true);
        }
      });
    }
    for (const p of this.active) p.contacts = touching.get(p) ?? new Set();
  }

  hit(p: VegetationPlant, hit: PhysicsImpact) {
    if (p.record.broken || !Number.isFinite(hit.energy) || !Number.isFinite(hit.impulse)) return;
    const lever = Math.min(p.height, Math.max(p.height * (p.woodHulls ? 0.05 : 0.3), hit.y - p.position.y));
    const inertia = Math.max(0.001, p.material.mass * p.height * p.height / 3);
    p.bend.vx += hit.dz * hit.impulse * lever / inertia;
    p.bend.vz -= hit.dx * hit.impulse * lever / inertia;
    // Deformation takes more work near the roots than at a high lever arm. Bullets only make local holes: in wood they cut
    // a notch instead (`shootTree`), and never loosen the roots.
    const work = Math.max(0, hit.energy) * (hit.kind === 'bullet' ? (p.woodHulls ? 0 : hit.ammo ? 1 : 0.12) : 1) * (p.woodHulls ? Math.max(0.3, lever / (p.height * 0.2)) : 1);
    const gained = work / p.material.strength;
    if (gained > 0 && Math.hypot(hit.dx, hit.dz) > 1e-4) {
      // The permanent lean follows the damage-weighted direction of every blow, not just the last one.
      const was = p.record.direction ?? [hit.dx, hit.dz], w = Math.min(1, p.record.damage);
      const dx = was[0] * w + hit.dx * gained, dz = was[1] * w + hit.dz * gained, l = Math.hypot(dx, dz) || 1;
      p.record.direction = [dx / l, dz / l];
    }
    p.record.damage += gained;
    this.active.add(p);
    if (work > 0) this.memory.set(p.key, p.record);
    if (p.record.damage >= 1) {
      p.record.broken = true;
      p.bend = newBend();
      p.record.direction = p.record.direction ?? [hit.dx, hit.dz];
      this.memory.set(p.key, p.record);
      if (p.woodHulls) this.fall(p, p.record.direction ?? [hit.dx, hit.dz], hit);
    }
  }

  private fall(p: VegetationPlant, direction: [number, number], kick?: PhysicsImpact) {
    if (p.body) return;
    if (p.treeIndex !== undefined) this.onTreeBreak?.(p.treeIndex);
    for (const c of p.colliders) { this.treeByCollider.delete(c.handle); this.physics.removeCollider(c); }
    p.colliders = [];
    p.solid = undefined;
    const saved = p.record.pose;
    if (Math.hypot(...direction) < 0.0001) direction = [1, 0];
    const length = Math.hypot(...direction);
    const q = saved ? new THREE.Quaternion(saved[3], saved[4], saved[5], saved[6]) : new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(direction[1] / length, 0, -direction[0] / length), 0.35).multiply(this.rotation(p));
    const pos = saved ? { x: saved[0], y: saved[1], z: saved[2] } : p.position;
    p.body = this.physics.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(pos.x, pos.y + (saved ? 0 : 0.08), pos.z)
      .setRotation(q).setLinearDamping(0.25).setAngularDamping(0.4).setCcdEnabled(true).setSleeping(!!saved));
    this.logs().add(p.body.handle);
    const log = new TreeWood(this, p, p.wood ?? 'snag', false, 'top');
    for (const hull of p.woodHulls!) {
      const desc = RAPIER.ColliderDesc.convexHull(hull.map((v, i) => v * [p.scale.x, p.scale.y, p.scale.z][i % 3]));
      if (!desc) continue;
      const c = this.physics.world.createCollider(desc.setDensity(650).setCollisionGroups(GROUPS.loose).setFriction(0.85).setRestitution(0.02), p.body);
      this.physics.tag(c, 'wood');
      this.physics.trees.set(c.handle, log);
      p.colliders.push(c);
    }
    p.body.recomputeMassPropertiesFromColliders();
    const woodMass = p.body.mass();
    if (woodMass > 0) {
      for (const c of p.colliders) c.setMass(c.mass() * p.material.mass / woodMass);
      p.body.recomputeMassPropertiesFromColliders();
    }
    if (!saved) {
      // Start the fall in the blow's direction. Gravity and contacts determine where it actually lands.
      const length = Math.hypot(...direction) || 1;
      p.body.setAngvel({ x: direction[1] / length * 1.1, y: 0, z: -direction[0] / length * 1.1 }, true);
    }
    if (kick && !saved) {
      const transferred = Math.min(Math.max(0, kick.impulse) * 0.6, p.material.mass * 10);
      p.body.applyImpulseAtPoint({ x: kick.dx * transferred, y: kick.dy * transferred, z: kick.dz * transferred },
        { x: kick.x, y: kick.y, z: kick.z }, true);
    }
    this.active.add(p);
    this.savePose(p);
  }

  // ------------------------------------------------------------------ gunfire in the wood

  private logs(): Set<number> {
    let s = LOGS.get(this.physics);
    if (!s) LOGS.set(this.physics, (s = new Set()));
    return s;
  }

  private stemsOf(p: VegetationPlant): StemSeg[] {
    return (p.stems ??= p.woodHulls ? stemSegments(p.woodHulls) : []);
  }

  /** A world point in a plant's model frame (its own units, before its scale), into `out`. */
  private toModel(p: VegetationPlant, x: number, y: number, z: number, out: THREE.Vector3) {
    out.set(x - p.position.x, y - p.position.y, z - p.position.z).applyQuaternion(Q2.copy(p.rotation).invert());
    return out.set(out.x / p.scale.x, out.y / p.scale.y, out.z / p.scale.z);
  }

  /**
   * The wood's cross-section at model height `y`, into `SEC`: its area (m², every stem there, each counted once: a gum's
   * rough sleeve and the stem inside it are one), and the stem nearest the model point (mx, mz), its centre and radius in
   * model units. False where no upright stem is.
   */
  private section(p: VegetationPlant, y: number, mx: number, mz: number): boolean {
    if (!p.tree) {
      // A desert dead tree's trunk (`render/props.ts`): one stem a little over a third of a metre through.
      if (p.kind !== 'deadTree') return false;
      SEC.cx = 0; SEC.cz = 0; SEC.r = 0.17;
      SEC.area = Math.PI * 0.17 * 0.17 * p.scale.x * p.scale.z;
      return true;
    }
    let n = 0;
    for (const s of this.stemsOf(p)) {
      if (y < s.ya || y > s.yb) continue;
      const t = (y - s.ya) / Math.max(1e-6, s.yb - s.ya);
      const cx = s.ax + (s.bx - s.ax) * t, cz = s.az + (s.bz - s.az) * t, r = s.ra + (s.rb - s.ra) * t;
      let same = -1;
      for (let k = 0; k < n; k++) if (Math.hypot(STEMS[k * 3] - cx, STEMS[k * 3 + 1] - cz) < Math.max(r, STEMS[k * 3 + 2]) * 0.6) { same = k; break; }
      if (same >= 0) {
        if (r > STEMS[same * 3 + 2]) { STEMS[same * 3] = cx; STEMS[same * 3 + 1] = cz; STEMS[same * 3 + 2] = r; }
        continue;
      }
      if (n >= STEMS.length / 3) continue;
      STEMS[n * 3] = cx; STEMS[n * 3 + 1] = cz; STEMS[n * 3 + 2] = r;
      n++;
    }
    if (!n) return false;
    let area = 0, best = 0, bestD = Infinity;
    for (let k = 0; k < n; k++) {
      const r = STEMS[k * 3 + 2];
      area += Math.PI * r * r * p.scale.x * p.scale.z;
      const d = Math.hypot(STEMS[k * 3] - mx, STEMS[k * 3 + 1] - mz) - r;
      if (d < bestD) { bestD = d; best = k; }
    }
    SEC.area = area;
    SEC.cx = STEMS[best * 3];
    SEC.cz = STEMS[best * 3 + 1];
    SEC.r = STEMS[best * 3 + 2];
    return true;
  }

  /** Radius (m) of the stem at a world point, for the size of a mark; 0 where there is none. */
  stemRadius(p: VegetationPlant, x: number, y: number, z: number): number {
    const m = this.toModel(p, x, y, z, V2);
    return this.section(p, Math.max(0.05, m.y), m.x, m.z) ? SEC.r * p.scale.x : 0;
  }

  /** A tree's crown: centre, half width and half height (m), for leaves shaken out of it. Null for bare wood. */
  crownOf(p: VegetationPlant): { x: number; y: number; z: number; r: number; h: number } | null {
    if (!p.tree || !p.wood || p.wood === 'deadTree' || !WOOD[p.wood].leaf) return null;
    const d = TREE_DIMS[p.wood];
    V2.set(0, (d.bole + d.h) * 0.5 * p.scale.y, 0).applyQuaternion(p.rotation).add(p.position);
    CROWN.x = V2.x; CROWN.y = V2.y; CROWN.z = V2.z;
    CROWN.r = d.crown * p.scale.x * 0.8;
    CROWN.h = (d.h - d.bole) * 0.5 * p.scale.y;
    return CROWN;
  }

  /** How hard a tree's wood is now: its species', less as fire has charred it. */
  hardness(p: VegetationPlant): number {
    const w = WOOD[p.wood ?? 'snag'];
    if (!p.tree) return w.hard;
    const base = TREE_MECHANICS[TREE_SPECIES[p.tree.sp]].strength * p.tree.s ** 3;
    return w.hard * Math.max(0.35, Math.min(1, p.material.strength / base));
  }

  /** How far a plant's stem leans from upright, radians. */
  private leanOf(p: VegetationPlant) {
    return Math.acos(Math.min(1, V2.set(0, 1, 0).applyQuaternion(p.rotation).y));
  }

  /**
   * A round has gone into a tree's wood (`TreeTarget.shot`): it takes its share of the section at that height out of the
   * notch bands there, and if that has eaten enough of the section the tree snaps at the notch. Returns the share gone there.
   */
  shootTree(p: VegetationPlant, s: TreeShot): number {
    if (p.record.broken || p.body || !p.woodHulls || !p.wood) return 0;
    const m = this.toModel(p, s.x, s.y, s.z, V2);
    const sy = p.scale.y;
    const h = m.y * sy;
    if (!this.section(p, m.y, m.x, m.z)) return 0;
    const spec = AMMO[s.ammo];
    const bands = (p.record.notch ??= []);
    const j1 = Math.floor(h / NOTCH_STEP);
    let done = 0;
    for (let j = Math.max(0, j1 - 1); j <= j1 && j < bands.length; j++) done = Math.max(done, bands[j]);
    HIT.ammo = s.ammo;
    HIT.speed = s.speed;
    HIT.work = 0.5 * spec.mass * Math.max(0, s.speed * s.speed - s.exit * s.exit);
    HIT.section = SEC.area;
    HIT.diameter = 2 * Math.sqrt(SEC.area / Math.PI);
    HIT.done = done;
    HIT.hard = this.hardness(p);
    const gain = notchGain(HIT);
    // A small tree's stems still count as its trunk up to where a man aims from the hip or the shoulder.
    const j = addNotch(bands, h, gain, Math.min(p.height * 0.5, Math.max(NOTCH_TOP[p.wood] * sy, 1.9)));
    if (j < 0) return 0;
    for (let k = Math.max(0, j1 - 1); k <= j1 && k < bands.length; k++) bands[k] = Math.round(bands[k] * 1e4) / 1e4;
    // Which way the rounds have been going, weighted by what each took: the notch faces back along it.
    const l = Math.hypot(s.dx, s.dz) || 1;
    const was = p.record.notchDir;
    const w = Math.min(1, done * 4);
    const nx = (was ? was[0] * w : 0) + (s.dx / l) * (gain + 0.01), nz = (was ? was[1] * w : 0) + (s.dz / l) * (gain + 0.01);
    const nl = Math.hypot(nx, nz) || 1;
    if (was) { was[0] = nx / nl; was[1] = nz / nl; } else p.record.notchDir = [nx / nl, nz / nl];
    if (!p.notchStem) p.notchStem = [SEC.cx, SEC.cz, SEC.r];
    else if (bands[j] <= gain + 1e-6 || done < 0.05) { p.notchStem[0] = SEC.cx; p.notchStem[1] = SEC.cz; p.notchStem[2] = SEC.r; }
    this.memory.set(p.key, p.record);
    this.wound(p);
    if (bands[j] >= snapShare(this.leanOf(p))) this.snap(p, bandMid(j) / sy, this.fallWay(p, s), s);
    return bands[j];
  }

  /**
   * Which way a snapped tree goes over: away from the guns that cut it, unless it already leans hard (a gum over the river
   * goes the way it leans), and a little either side as the hinge tears.
   */
  private fallWay(p: VegetationPlant, s: TreeShot): [number, number] {
    const d = p.record.notchDir ?? [s.dx, s.dz];
    const up = V2.set(0, 1, 0).applyQuaternion(p.rotation);
    let x = d[0] + up.x * 6;
    let z = d[1] + up.z * 6;
    const k = Math.sin(p.position.x * 12.9898 + p.position.z * 78.233) * 43758.5453;
    const a = (k - Math.floor(k) - 0.5) * 0.6;
    const c = Math.cos(a), sn = Math.sin(a);
    [x, z] = [x * c - z * sn, x * sn + z * c];
    const l = Math.hypot(x, z) || 1;
    return [x / l, z / l];
  }

  /**
   * The tree snaps at model height `cut`: a stump stays rooted with the wood below the break (a fixed body, still solid,
   * still wood to a round), and the top becomes one rigid body of the wood above it, swinging over on a hinge of the uncut
   * wood on the side it falls to and tearing free part-way down. Its fall throws people aside and its landing is heard
   * (`TreeEvents`). With a saved pose (a reload) the top is simply put back where it lay. A desert dead tree goes over whole.
   */
  private snap(p: VegetationPlant, cut: number, dir: [number, number], s?: TreeShot) {
    if (p.body || !p.woodHulls) return;
    const rec = p.record;
    if (!p.tree) {
      rec.broken = true;
      rec.damage = Math.max(1, rec.damage);
      rec.direction = dir;
      this.memory.set(p.key, rec);
      this.fall(p, dir, s && { x: s.x, y: s.y, z: s.z, dx: s.dx, dy: s.dy, dz: s.dz, impulse: AMMO[s.ammo].mass * s.speed * 30, energy: 0, kind: 'bullet' });
      this.draw(p);
      return;
    }
    rec.broken = true;
    rec.cut = cut;
    rec.direction = dir;
    this.memory.set(p.key, rec);
    if (!p.notchStem) p.notchStem = this.section(p, cut, 0, 0) ? [SEC.cx, SEC.cz, SEC.r] : [0, 0, 0.3];
    const [cx, cz, r] = p.notchStem;
    const sx = p.scale.x, sy = p.scale.y, sz = p.scale.z;
    const yCut = cut * sy;
    if (p.treeIndex !== undefined) this.onTreeBreak?.(p.treeIndex, p.position.y + yCut + r * sx * 0.5);
    for (const c of p.colliders) { this.treeByCollider.delete(c.handle); this.physics.removeCollider(c); }
    p.colliders = [];
    p.solid = undefined;
    p.bend = newBend();
    const world = this.physics.world;
    const scaled = (hull: Float32Array) => hull.map((v, i) => v * (i % 3 === 0 ? sx : i % 3 === 1 ? sy : sz));
    // The stump: the wood below the break stays where it grew.
    const stump = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(p.position.x, p.position.y, p.position.z).setRotation(p.rotation));
    const stumpWood = new TreeWood(this, p, p.wood!, false, 'stump');
    const stumpColliders: Collider[] = [];
    const pieces = p.woodHulls.map(scaled);
    let stumpMass = 0;
    for (const v of pieces) {
      const below = clipHull(v, yCut, false);
      const desc = below && RAPIER.ColliderDesc.convexHull(below);
      if (!desc) continue;
      const c = world.createCollider(desc.setDensity(650).setCollisionGroups(GROUPS.furn).setFriction(0.8), stump);
      this.physics.tag(c, 'wood');
      this.physics.trees.set(c.handle, stumpWood);
      stumpMass += c.mass();
      stumpColliders.push(c);
    }
    p.stump = { body: stump, colliders: stumpColliders };
    // The top: everything above the break, one rigid body carrying its share of the tree's weight.
    const saved = rec.pose;
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(saved ? saved[0] : p.position.x, saved ? saved[1] : p.position.y, saved ? saved[2] : p.position.z)
      .setRotation(saved ? { x: saved[3], y: saved[4], z: saved[5], w: saved[6] } : p.rotation)
      .setLinearDamping(0.1).setAngularDamping(0.15).setCcdEnabled(true).setSleeping(!!saved));
    p.body = body;
    this.logs().add(body.handle);
    const topWood = new TreeWood(this, p, p.wood!, false, 'top');
    // Only the trunk and the main limbs are solid: twigs and thin boughs would snag the top in its neighbours' branches.
    const thin = Math.max(0.05, r * 0.3) * sx;
    for (const v of pieces) {
      if (pieceRadius(v) < thin) continue;
      const above = clipHull(v, yCut, true);
      const desc = above && RAPIER.ColliderDesc.convexHull(above);
      if (!desc) continue;
      const c = world.createCollider(desc.setDensity(650).setCollisionGroups(saved ? GROUPS.loose : FALLING).setFriction(0.85).setRestitution(0.02), body);
      this.physics.tag(c, 'wood');
      this.physics.trees.set(c.handle, topWood);
      p.colliders.push(c);
    }
    body.recomputeMassPropertiesFromColliders();
    const topMass = body.mass();
    const mass = p.material.mass * (topMass / Math.max(1e-6, topMass + stumpMass));
    if (topMass > 0) {
      for (const c of p.colliders) c.setMass((c.mass() * mass) / topMass);
      body.recomputeMassPropertiesFromColliders();
    }
    this.active.add(p);
    if (!saved && p.colliders.length) {
      // It goes over on the hinge of uncut wood at the far edge of the notch, the side it falls to.
      const local = V.set(dir[0], 0, dir[1]).applyQuaternion(Q2.copy(p.rotation).invert());
      const ll = Math.hypot(local.x, local.z) || 1;
      const lx = local.x / ll, lz = local.z / ll;
      const anchor = { x: cx * sx + lx * r * sx * 0.6, y: yCut, z: cz * sz + lz * r * sz * 0.6 };
      const joint = world.createImpulseJoint(RAPIER.JointData.revolute(anchor, anchor, { x: lz, y: 0, z: -lx }), stump, body, true);
      joint.setContactsEnabled(false);
      p.hinge = joint;
      body.setAngvel({ x: dir[1] * 0.8, y: 0, z: -dir[0] * 0.8 }, true);
      // The trunk from the break to its highest wood, for whatever it comes down on.
      let tip: StemSeg | null = null;
      for (const g of this.stemsOf(p)) if (!tip || g.yb > tip.yb) tip = g;
      V.set(cx * sx, yCut, cz * sz).applyQuaternion(p.rotation).add(p.position);
      p.fall = {
        wood: p.wood!, body, butt: [cx * sx, yCut, cz * sz], tip: tip ? [tip.bx * sx, tip.yb * sy, tip.bz * sz] : [cx * sx, p.height, cz * sz],
        radius: r * sx, crown: TREE_DIMS[p.wood as keyof typeof TREE_DIMS].crown * sx, mass, x: V.x, y: V.y, z: V.z, dx: dir[0], dz: dir[1],
        by: s?.by ?? -1, t: 0, tipVy: 0, landedAt: -1, stuck: 0, nudges: 0,
      };
      this.falling.add(p);
      this.physics.treeEvents?.snapped(p.fall);
    }
    this.savePose(p);
    this.wound(p);
  }

  /**
   * A snapped top on its way down: the hinge tears once it has gone a third of the way over (or after a few seconds hung up
   * in its neighbours), and the moment its tip stops coming down fast it has landed. Once it has lain still a moment people
   * collide with it again.
   */
  private follow(p: VegetationPlant, dt: number) {
    const f = p.fall, b = p.body;
    if (!f || !b || !b.isValid()) { this.falling.delete(p); return; }
    f.t += dt;
    const r = b.rotation();
    Q.set(r.x, r.y, r.z, r.w);
    if (p.hinge) {
      const up = V.set(0, 1, 0).applyQuaternion(Q).dot(V2.set(0, 1, 0).applyQuaternion(p.rotation));
      const w = b.angvel();
      // Torn through, or stopped against a neighbour (it will slide off it, below).
      if (up < 0.85 || f.t > 5 || (f.t > 1.2 && Math.hypot(w.x, w.y, w.z) < 0.12)) {
        if (p.hinge.isValid()) this.physics.world.removeImpulseJoint(p.hinge, true);
        p.hinge = undefined;
      }
    }
    const t = b.translation();
    V.set(f.tip[0], f.tip[1], f.tip[2]).applyQuaternion(Q).add(V2.set(t.x, t.y, t.z));
    const v = b.velocityAtPoint({ x: V.x, y: V.y, z: V.z });
    // Hung up in a neighbour's limbs: it slides and twists off a little at a time until it is down.
    const tilt = V3.set(0, 1, 0).applyQuaternion(Q).dot(V2.set(0, 1, 0).applyQuaternion(p.rotation));
    const lv = b.linvel(), av = b.angvel();
    if (!p.hinge && tilt > 0.5 && f.nudges < 8 && Math.hypot(lv.x, lv.y, lv.z) + Math.hypot(av.x, av.y, av.z) < 0.35) {
      f.stuck += dt;
      if (f.stuck > 1.2) {
        f.stuck = 0;
        f.nudges++;
        const len2 = (f.tip[0] - f.butt[0]) ** 2 + (f.tip[1] - f.butt[1]) ** 2 + (f.tip[2] - f.butt[2]) ** 2;
        const k = (0.35 * f.mass * len2) / 3;
        b.applyTorqueImpulse({ x: f.dz * k, y: (f.nudges % 2 ? 0.25 : -0.25) * k, z: -f.dx * k }, true);
      }
    } else f.stuck = 0;
    if (f.landedAt < 0) {
      if ((f.tipVy < -3.5 && v.y > f.tipVy * 0.35) || f.t > 9) {
        f.landedAt = f.t;
        V.set(f.butt[0] + (f.tip[0] - f.butt[0]) * 0.75, f.butt[1] + (f.tip[1] - f.butt[1]) * 0.75, f.butt[2] + (f.tip[2] - f.butt[2]) * 0.75)
          .applyQuaternion(Q).add(V2.set(t.x, t.y, t.z));
        this.physics.treeEvents?.landed(f, V.x, V.y, V.z, -f.tipVy);
      }
      f.tipVy = v.y;
    } else if ((f.t - f.landedAt > 1.5 || b.isSleeping()) && (tilt < 0.5 || f.nudges >= 8)) {
      for (const c of p.colliders) if (c.isValid()) c.setCollisionGroups(GROUPS.loose);
      this.falling.delete(p);
    }
  }

  /** Draw a tree's notch and, once it has snapped, which piece its instance is now, with the stump in an instance of its own. */
  private wound(p: VegetationPlant) {
    const near = p.refs[0];
    if (!p.tree || !near || !near.mesh.geometry.getAttribute('aNotch')) return;
    const rec = p.record;
    const j = rec.notch ? deepest(rec.notch) : -1;
    if (j < 0 && rec.cut === undefined) return;
    const sy = p.scale.y;
    const y = rec.cut ?? bandMid(j) / sy;
    if (!p.notchStem) {
      if (!this.section(p, y, 0, 0)) return;
      p.notchStem = [SEC.cx, SEC.cz, SEC.r];
    }
    const [cx, cz, r] = p.notchStem;
    const share = j >= 0 ? rec.notch![j] : 0.6;
    const d = rec.notchDir ?? [1, 0];
    V.set(-d[0], 0, -d[1]).applyQuaternion(Q2.copy(p.rotation).invert());
    const angle = Math.atan2(V.z, V.x);
    const half = (0.2 + 0.25 * r * p.scale.x) / sy;
    setTreeNotch(near.mesh, near.index, y, share, angle, rec.cut !== undefined ? 1 : 0, cx, cz, r, half);
    if (rec.cut === undefined || !p.stump) return;
    if (!p.stump.ref) {
      const i = addTreeSlot(near.mesh, near.index);
      if (i < 0) return;
      near.mesh.setMatrixAt(i, near.base);
      near.mesh.instanceMatrix.addUpdateRange(i * 16, 16);
      near.mesh.instanceMatrix.needsUpdate = true;
      p.stump.ref = { mesh: near.mesh, index: i };
    }
    setTreeNotch(p.stump.ref.mesh, p.stump.ref.index, y, share, angle, -1, cx, cz, r, half);
  }

  /** Elastic spring bend plus the permanent set the plant has taken so far, which grows with accumulated damage. */
  private rotation(p: VegetationPlant) {
    const [dx, dz] = p.record.direction ?? [1, 0], len = Math.hypot(dx, dz) || 1;
    const set = p.record.damage > 0 ? setAngle(p.record.damage, !!p.woodHulls) : 0;
    return Q.setFromEuler(new THREE.Euler(p.bend.x + dz / len * set, 0, p.bend.z - dx / len * set)).multiply(p.rotation).clone();
  }

  private savePose(p: VegetationPlant) {
    const pos = p.body!.translation(), q = p.body!.rotation();
    p.record.pose = [pos.x, pos.y, pos.z, q.x, q.y, q.z, q.w];
    this.memory.set(p.key, p.record);
  }

  private update(dt: number) {
    for (const p of this.falling) this.follow(p, dt);
    for (const p of this.sensors) {
      p.sensorLife = (p.sensorLife ?? 0) - dt;
      if (p.sensorLife > 0 && !p.record.broken) continue;
      this.physics.removeCollider(p.sensor!);
      p.sensor = undefined;
      this.sensors.delete(p);
    }
    // Read real solver impulses, not resting overlap or a speed guessed after the collision.
    const blows: { p: VegetationPlant; hit: PhysicsImpact }[] = [];
    for (const event of this.physics.contactForces) {
      const p = this.treeByCollider.get(event.a) ?? this.treeByCollider.get(event.b);
      if (!p?.solid || p.record.broken) continue;
      const source = this.physics.moving.find((s) => s.collider.handle === (event.a === p.solid!.handle ? event.b : event.a));
      if (!source) continue;
      // Rapier reports the force toward collider 2. The tree receives the opposite when it is collider 1.
      const sign = event.a === p.solid.handle ? -1 : 1;
      const dx = event.x * sign, dz = event.z * sign;
      const impulse = Math.hypot(dx, dz);
      if (impulse < 0.1) continue;
      let y = source.position.y;
      this.physics.world.contactPair(source.collider, p.solid, (manifold) => {
        const point = manifold.solverContactPoint(0);
        if (point) y = point.y;
      });
      const speed = Math.max(0, source.velocity.x * dx / impulse + source.velocity.z * dz / impulse);
      blows.push({ p, hit: { x: p.position.x, y, z: p.position.z, dx: dx / impulse, dy: 0, dz: dz / impulse, impulse,
        energy: Math.min(0.5 * source.mass * speed ** 2, impulse * speed * 0.5), kind: 'contact' } });
    }
    for (const blow of blows) this.hit(blow.p, blow.hit);
    for (const p of this.active) {
      if (p.body) {
        if (p.body.isSleeping()) {
          if (this.drawnSleeping.has(p)) continue;
          this.drawnSleeping.add(p);
        } else this.drawnSleeping.delete(p);
        this.savePose(p);
      }
      else if (!p.record.broken) stepBend(p.bend, p.material, dt);
      this.draw(p);
      if (p.record.broken && !p.body) { this.active.delete(p); continue; }
      if (!p.record.broken && !p.contacts.size && Math.abs(p.bend.x) + Math.abs(p.bend.z) + Math.abs(p.bend.vx) + Math.abs(p.bend.vz) < 0.00005) {
        p.bend = newBend();
        this.draw(p);
        this.active.delete(p);
      }
    }
  }

  private draw(p: VegetationPlant) {
    let pos = p.position, q = this.rotation(p);
    if (p.body) {
      const t = p.body.translation(), r = p.body.rotation();
      pos = V.set(t.x, t.y, t.z);
      q = Q.set(r.x, r.y, r.z, r.w).clone();
    }
    if (p.sensor) { p.sensor.setTranslation(pos); p.sensor.setRotation(q); }
    if (p.solid) {
      p.solid.setTranslation(pos);
      p.solid.setRotation(q);
    }
    // Apply a root-space delta to every representation, preserving the impostor's dimensions and crop layout.
    const base = new THREE.Matrix4().compose(p.position, p.rotation, new THREE.Vector3(1, 1, 1));
    const current = new THREE.Matrix4().compose(pos, q, new THREE.Vector3(1, 1, 1));
    const delta = current.multiply(base.invert());
    for (const ref of p.refs) {
      M.copy(delta).multiply(ref.base);
      if (!p.woodHulls && p.record.damage > 0) M.scale(V.set(1, flatten(p.record.damage), 1));
      // Burnt to the ground: a black stub of what it was.
      if (p.record.burnt) M.scale(V.set(0.55, 0.06, 0.55));
      ref.mesh.setMatrixAt(ref.index, M);
      ref.mesh.instanceMatrix.addUpdateRange(ref.index * 16, 16);
      ref.mesh.instanceMatrix.needsUpdate = true;
      // Fallen trees can travel outside the chunk's original instance bounds.
      if (p.body) ref.mesh.frustumCulled = false;
    }
  }

  hitArea(hit: PhysicsImpact) {
    const radius = hit.radius ?? 1;
    this.near(hit.x, hit.z, radius + 10, (p) => {
      if (p.record.broken) return;
      const d = Math.hypot(p.position.x - hit.x, p.position.z - hit.z);
      if (d > radius + (p.woodHulls ? 0.5 * p.scale.x : Math.min(1.5, p.radius)) || hit.y < p.position.y - radius || hit.y > p.position.y + p.height + radius) return;
      const falloff = hit.kind === 'blast' ? Math.max(0, 1 - d / radius) : 1;
      if (!falloff) return;
      const length = d || 1;
      this.hit(p, { ...hit, dx: hit.kind === 'blast' ? (p.position.x - hit.x) / length : hit.dx,
        dz: hit.kind === 'blast' ? (p.position.z - hit.z) / length : hit.dz,
        impulse: hit.impulse * falloff, energy: hit.energy * falloff });
    });
  }

  private hitRay(hit: PhysicsImpact, distance: number) {
    if (distance <= 0) return;
    const ray = new RAPIER.Ray({ x: hit.x, y: hit.y, z: hit.z }, { x: hit.dx, y: hit.dy, z: hit.dz });
    const visited = new Set<VegetationPlant>();
    // Walk the segment's cells, avoiding a quadratic scan over a long diagonal shot.
    const n = Math.max(1, Math.ceil(distance / CELL));
    for (let i = 0; i <= n; i++) {
      const d = distance * i / n;
      this.near(hit.x + hit.dx * d, hit.z + hit.dz * d, 10, (p) => {
        if (visited.has(p) || p.record.broken || (!p.shape && !p.shapeSource)) return;
        visited.add(p);
        if (Math.max(hit.y, hit.y + hit.dy * distance) < p.position.y || Math.min(hit.y, hit.y + hit.dy * distance) > p.position.y + p.height) return;
        const toi = this.sensor(p).castRay(ray, distance, true);
        if (toi < 0 || toi > distance) return;
        const x = hit.x + hit.dx * toi, y = hit.y + hit.dy * toi, z = hit.z + hit.dz * toi;
        // A small share of a projectile's work tears flexible leaves; most of it carries on. A bush's leaves and twigs take
        // more of a round (buckshot most): a magazine thins one, a few shells shred it.
        const bush = !p.woodHulls ? BUSH_LEAF[p.kind] : undefined;
        // (A round named by its ammo has its whole share here; `hit` takes the old 0.12 off only an unnamed one.)
        const share = hit.kind === 'bullet' && hit.ammo ? (bush ? shredShare(hit.ammo) : 0.04 * 0.12) : 0.04;
        this.hit(p, { ...hit, x, y, z, impulse: hit.impulse * 0.03, energy: p.woodHulls ? 0 : hit.energy * share });
        // And a few leaves come away, out of a crown or a bush.
        const leaf = p.wood ? WOOD[p.wood].leaf : bush;
        if (leaf && hit.kind === 'bullet' && this.physics.treeEvents) {
          this.physics.treeEvents.leaves(x, y, z, leafTear(hit.ammo ?? 'pistol') + (bush ? 1 : 0), leaf, bush ? 0.4 : 0.8);
        }
      });
    }
  }

  /** Fire has been through: the grass and low plants within `r` of a point burn to stubble, and stay that way. */
  burnArea(x: number, z: number, r: number): number {
    let n = 0;
    this.near(x, z, r, (p) => {
      if (p.tree || p.woodHulls || p.body || p.record.burnt) return;
      if ((p.position.x - x) ** 2 + (p.position.z - z) ** 2 > r * r) return;
      p.record.burnt = true;
      this.memory.set(p.key, p.record);
      this.draw(p);
      n++;
    });
    return n;
  }

  charTree(index: number, char: number) {
    const p = this.trees[index];
    if (!p?.tree) return;
    p.material.strength = treeMechanics(TREE_SPECIES[p.tree.sp], p.tree.s).strength * (1 - Math.min(1, Math.max(0, char)) * 0.75);
    // A snapped tree's stump chars with it (the chunk has just coloured the tree's own instance).
    const near = p.refs[0], stump = p.stump?.ref;
    if (near?.mesh.instanceColor && stump?.mesh.instanceColor) {
      near.mesh.getColorAt(near.index, C);
      stump.mesh.setColorAt(stump.index, C);
      stump.mesh.instanceColor.addUpdateRange(stump.index * 3, 3);
      stump.mesh.instanceColor.needsUpdate = true;
    }
  }

  /**
   * How much of a sight line from a to b the leaves rooted here let through: 1 clear, toward 0 through a thicket. Each
   * screening plant the line crosses (in plan within its reach, in height between its root and its flattened top) dims it
   * by the metres of it crossed. Broken plants hide nobody.
   */
  seeThrough(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
    const b = this.bounds;
    if (Math.max(ax, bx) + LEAF_REACH < b.minX || Math.min(ax, bx) - LEAF_REACH > b.maxX || Math.max(az, bz) + LEAF_REACH < b.minZ || Math.min(az, bz) - LEAF_REACH > b.maxZ) return 1;
    const dx = bx - ax;
    const dz = bz - az;
    const L = Math.hypot(dx, dz);
    if (L < 1e-3) return 1;
    let clear = 1;
    // Walk the cells the line's strip (widened by the widest plant) crosses, a row at a time.
    const z0 = Math.floor((Math.max(Math.min(az, bz), b.minZ) - LEAF_REACH) / CELL);
    const z1 = Math.floor((Math.min(Math.max(az, bz), b.maxZ) + LEAF_REACH) / CELL);
    for (let iz = z0; iz <= z1; iz++) {
      let ta = 0;
      let tb = 1;
      if (Math.abs(dz) > 1e-9) {
        const t0 = (iz * CELL - LEAF_REACH - az) / dz;
        const t1 = ((iz + 1) * CELL + LEAF_REACH - az) / dz;
        ta = Math.max(0, Math.min(t0, t1));
        tb = Math.min(1, Math.max(t0, t1));
        if (ta > tb) continue;
      }
      const xa = ax + dx * ta;
      const xb = ax + dx * tb;
      const x0 = Math.floor((Math.max(Math.min(xa, xb), b.minX) - LEAF_REACH) / CELL);
      const x1 = Math.floor((Math.min(Math.max(xa, xb), b.maxX) + LEAF_REACH) / CELL);
      for (let ix = x0; ix <= x1; ix++) {
        const bin = this.screens.get(screenKey(ix, iz));
        if (!bin) continue;
        for (const s of bin) {
          const p = s.p;
          if (p.record.broken || p.body) continue;
          const px = p.position.x - ax;
          const pz = p.position.z - az;
          // Closest approach in plan, in metres along the line, and how far off it the stem is.
          const along = (px * dx + pz * dz) / L;
          const off2 = px * px + pz * pz - along * along;
          if (off2 >= s.r * s.r) continue;
          const half = Math.sqrt(s.r * s.r - off2);
          const s0 = Math.max(0, along - half);
          const s1 = Math.min(L, along + half);
          if (s1 <= s0) continue;
          const t = Math.min(1, Math.max(0, along / L));
          const y = ay + (by - ay) * t;
          const top = p.position.y + p.height * LEAF_FILL * (p.record.damage > 0 ? flatten(p.record.damage) : 1);
          if (y < p.position.y || y > top) continue;
          clear *= Math.exp(-s.k * (s1 - s0));
        }
      }
    }
    return clear;
  }

  hitTree(index: number, hit: PhysicsImpact) { const p = this.trees[index]; if (p) this.hit(p, hit); }
  treeBroken(index: number) { return this.trees[index]?.record.broken ?? false; }

  dispose() {
    this.physics.beforeStep.delete(this.before);
    this.physics.afterStep.delete(this.after);
    this.physics.areaImpactHandlers.delete(this.area);
    this.physics.rayImpactHandlers.delete(this.ray);
    for (const p of this.plants) {
      if (p.body) this.savePose(p);
      if (p.sensor?.isValid()) this.physics.removeCollider(p.sensor);
      for (const c of p.colliders) if (c.isValid()) this.physics.removeCollider(c);
      // Removing a body takes the hinge joined to it.
      if (p.body) LOGS.get(this.physics)?.delete(p.body.handle);
      if (p.body?.isValid()) this.physics.world.removeRigidBody(p.body);
      if (p.stump) {
        for (const c of p.stump.colliders) if (c.isValid()) this.physics.removeCollider(c);
        if (p.stump.body.isValid()) this.physics.world.removeRigidBody(p.stump.body);
      }
      p.hinge = undefined;
    }
    this.falling.clear();
    this.active.clear();
    this.sensors.clear();
    this.plants.length = 0;
    this.trees.length = 0;
    this.treeByCollider.clear();
    this.screens.clear();
    this.physics.releaseStepEvents();
    this.bins.clear();
  }
}
