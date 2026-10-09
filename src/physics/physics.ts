import RAPIER from '@dimforge/rapier3d-compat';
import type { AmmoKind } from '../sim/ballistics';
import type { WoodKind } from '../sim/treeDamage';

export { RAPIER };
export type Collider = RAPIER.Collider;
export type RigidBody = RAPIER.RigidBody;

/** Interaction groups. Upper 16 bits are memberships, lower 16 bits are the filter. */
export const G = {
  STATIC: 0x0001,
  VEHICLE: 0x0002,
  PLAYER: 0x0004,
  PROP: 0x0008,
  SENSOR: 0x0010,
  BUILD: 0x0020,
  /** Furniture: solid to people and vehicles, invisible to the camera. */
  FURN: 0x0040,
  /** Loose props (tyres, drums): dynamic bodies that vehicles and people can shove. */
  LOOSE: 0x0080,
  /**
   * The drawn road's own surface, laid a few centimetres (up to ~17 on a late open-world road) over the terrain heightfield.
   * Wheels, chassis, feet and loose bodies ride it; rounds, marks and the camera keep to the heightfield under it and add
   * `roadLift` themselves.
   */
  ROAD: 0x0100,
} as const;

export const groups = (member: number, filter: number) => ((member & 0xffff) << 16) | (filter & 0xffff);

export const GROUPS = {
  /** Terrain, buildings, barricades. */
  static: groups(G.STATIC, G.VEHICLE | G.PLAYER | G.PROP | G.LOOSE),
  /** The road surface over the terrain (see `G.ROAD`): solid to whatever rests on the ground. */
  road: groups(G.ROAD, G.VEHICLE | G.PLAYER | G.PROP | G.LOOSE),
  /** Chassis: collides with static, other vehicles, players and props. */
  vehicle: groups(G.VEHICLE, G.STATIC | G.ROAD | G.VEHICLE | G.PLAYER | G.PROP | G.BUILD | G.FURN | G.LOOSE),
  /** Capsule: collides with static, vehicles and built structures. */
  player: groups(G.PLAYER, G.STATIC | G.ROAD | G.VEHICLE | G.BUILD | G.FURN | G.LOOSE),
  furn: groups(G.FURN, G.VEHICLE | G.PLAYER | G.LOOSE),
  prop: groups(G.PROP, G.STATIC | G.ROAD | G.VEHICLE),
  /** Camp structures (blocking elements). */
  build: groups(G.BUILD, G.VEHICLE | G.PLAYER | G.LOOSE),
  /** Loose props: solid to the ground, buildings, furniture, vehicles, people and each other; wheel rays ignore them so tyres ride over. */
  loose: groups(G.LOOSE, G.STATIC | G.ROAD | G.VEHICLE | G.PLAYER | G.FURN | G.BUILD | G.LOOSE),
  /** What wheel rays can hit: the ground and the road on it, built things, and parts that have come off a vehicle and lie in the road. */
  wheelRays: groups(0xffff, G.STATIC | G.ROAD | G.BUILD | G.PROP),
};

let ready: Promise<void> | null = null;
export function initPhysics() {
  if (!ready) ready = RAPIER.init();
  return ready;
}

export const FIXED_STEP = 1 / 60;

/** A localized mechanical blow, in SI units. Damage is optional cutting/crushing work. */
export interface PhysicsImpact {
  x: number; y: number; z: number;
  dx: number; dy: number; dz: number;
  impulse: number;
  energy: number;
  kind: 'contact' | 'bullet' | 'blast' | 'cut' | 'blunt';
  radius?: number;
  /** For a bullet: the round, which decides how it tears leaves and wood. */
  ammo?: AmmoKind;
}

/**
 * A tree's wood as weapons see it: a standing trunk (rounds cut a notch in it until it goes over), its stump, or its
 * fallen top (those only chip). Registered by `render/vegetation.ts` against the collider's handle in `PhysicsWorld.trees`.
 */
export interface TreeTarget {
  readonly wood: WoodKind;
  readonly standing: boolean;
  /** True while it moves (a falling top): a mark laid on it would be left hanging in the air. */
  moving(): boolean;
  /** Radius of the stem at a point, m, for the size of the marks (0 when unknown). */
  stemRadius(x: number, y: number, z: number): number;
  /** The crown, for leaves shaken out of it: its centre, half width and half height. Null for bare wood. */
  crown(): { x: number; y: number; z: number; r: number; h: number } | null;
  /** How hard the wood is now (charred wood is weaker), for how far a round goes through it. */
  hardness(): number;
  /** A round has worked the wood here. Returns the share of the section gone at that height (0 when it cannot be notched). */
  shot(s: TreeShot): number;
}

export interface TreeShot {
  ammo: AmmoKind;
  /** Speed it struck at and left the far side at (0 if it stayed in), m/s. */
  speed: number;
  exit: number;
  x: number; y: number; z: number;
  dx: number; dy: number; dz: number;
  /** Player index of whoever fired it, or -1. */
  by: number;
}

/** A tree going over: its top as a rigid body, and what the scene needs to follow it down. */
export interface TreeFall {
  wood: WoodKind;
  body: RigidBody;
  /** Ends of its trunk in the body's own frame (m): the break and the top. */
  butt: [number, number, number];
  tip: [number, number, number];
  /** Trunk radius at the break and the crown's radius, m. */
  radius: number;
  crown: number;
  mass: number;
  /** Where it broke (world) and which way it is going over. */
  x: number; y: number; z: number;
  dx: number; dz: number;
  by: number;
}

/**
 * A stone lying on the ground that a round can break: the instanced mesh that draws it (an `InstancedMesh`, kept opaque
 * here so the physics needs no three.js) and its instance; what kind of stone (`render/scatter.ts` tags its meshes); and how
 * to take it out of the world (its instance hidden, its collider gone).
 */
export interface StoneTarget {
  im: unknown;
  i: number;
  kind: 'pebble' | 'boulder';
  v: number;
  /** Take it out of the world (once). */
  remove(): void;
}

/** A key for a stone's place (to the decimetre), to keep it gone. */
export function stoneKey(x: number, z: number): number {
  return Math.round(x * 10) * 1e6 + Math.round(z * 10);
}

/** What the scene does when trees break and land, and when leaves are torn off (`game/timber.ts`). */
export interface TreeEvents {
  snapped(f: TreeFall): void;
  landed(f: TreeFall, x: number, y: number, z: number, speed: number): void;
  /** `n` leaves torn loose round a point, `spread` metres across, in a colour. */
  leaves(x: number, y: number, z: number, n: number, rgb: readonly [number, number, number], spread: number): void;
}

export interface MovingCollider {
  collider: Collider;
  body: RigidBody;
  position: RAPIER.Vector;
  velocity: RAPIER.Vector;
  mass: number;
  radius: number;
  sweepVelocity: RAPIER.Vector;
  speed: number;
  edgeSpeed: number;
}

// Shape setters invalidate Rapier's cached shape; weak keys also survive collider removal/handle reuse safely.
const shapeRadii = new WeakMap<object, number>();
export function colliderRadius(collider: Collider): number {
  const shape = collider.shape as unknown as { halfExtents?: RAPIER.Vector; radius?: number; halfHeight?: number; vertices?: Float32Array };
  let radius = shape.halfExtents ? Math.hypot(shape.halfExtents.x, shape.halfExtents.y, shape.halfExtents.z) : (shape.radius ?? 0) + (shape.halfHeight ?? 0);
  if (!radius && shape.vertices) {
    const cached = shapeRadii.get(shape);
    if (cached !== undefined) return cached;
    for (let j = 0; j < shape.vertices.length; j += 3) radius = Math.max(radius, Math.hypot(shape.vertices[j], shape.vertices[j + 1], shape.vertices[j + 2]));
    shapeRadii.set(shape, radius || 2);
  }
  return radius || 2;
}

export class PhysicsWorld {
  world: RAPIER.World;
  private pending: (() => void)[] = [];
  /** What a collider is made of (a ballistics Surface name), by handle, for things that are not boxes of the world: props, stones. */
  surfaces = new Map<number, string>();
  /** Hooks are released with their owning streamed chunk. */
  beforeStep = new Set<(dt: number) => void>();
  afterStep = new Set<(dt: number) => void>();
  impactHandlers = new Map<number, (hit: PhysicsImpact) => void>();
  areaImpactHandlers = new Set<(hit: PhysicsImpact) => void>();
  rayImpactHandlers = new Set<(hit: PhysicsImpact, distance: number) => void>();
  moving: MovingCollider[] = [];
  /** Kinematic bodies that are placed rather than driven (a walking player) report the velocity they really moved at. */
  kinematicVelocity = new Map<number, RAPIER.Vector>();
  private events?: RAPIER.EventQueue;
  contactForces: { a: number; b: number; x: number; y: number; z: number }[] = [];
  /** Wood that rounds can work, by collider handle (see `TreeTarget`). */
  trees = new Map<number, TreeTarget>();
  /** Stones and boulders lying about, by collider handle (see `StoneTarget`, `game/stones.ts`). */
  stones = new Map<number, StoneTarget>();
  /** Where stones were shattered or knocked away (`stoneKey`), so a chunk built again leaves them out. */
  brokenStones = new Set<number>();
  /** The scene's effects for trees breaking and leaves torn off; absent in bare physics. */
  treeEvents: TreeEvents | null = null;

  constructor() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = FIXED_STEP;
    this.world.integrationParameters.numSolverIterations = 6;
  }

  step() {
    if (this.beforeStep.size || this.afterStep.size) {
      this.moving.length = 0;
      this.world.forEachRigidBody((body) => {
        if (body.isFixed() || body.isSleeping()) return;
        const velocity = (body.isKinematic() && this.kinematicVelocity.get(body.handle)) || body.linvel();
        // Kinematic players have no finite solver mass; use an adult's effective mass.
        const mass = body.isKinematic() ? 75 : body.mass();
        let sweepVelocity = velocity;
        if (body.isKinematic()) {
          const next = body.nextTranslation(), now = body.translation(), dt = this.world.timestep;
          const driven = { x: (next.x - now.x) / dt, y: (next.y - now.y) / dt, z: (next.z - now.z) / dt };
          if (Math.hypot(driven.x, driven.y, driven.z) > 1e-6) sweepVelocity = driven;
        }
        const speed = Math.hypot(sweepVelocity.x, sweepVelocity.y, sweepVelocity.z);
        const angular = body.angvel();
        const angularSpeed = Math.hypot(angular.x, angular.y, angular.z);
        for (let i = 0; i < body.numColliders(); i++) {
          const collider = body.collider(i);
          if (!collider.isEnabled() || collider.isSensor()) continue;
          const radius = colliderRadius(collider);
          this.moving.push({ collider, body, position: collider.translation(), velocity, mass, radius, sweepVelocity, speed, edgeSpeed: angularSpeed * radius });
        }
      });
      for (const f of this.beforeStep) f(this.world.timestep);
    }
    if (this.afterStep.size && !this.events) this.events = new RAPIER.EventQueue(true);
    this.world.step(this.events);
    this.contactForces.length = 0;
    this.events?.drainContactForceEvents((event) => {
      const force = event.totalForce();
      this.contactForces.push({ a: event.collider1(), b: event.collider2(), x: force.x * this.world.timestep, y: force.y * this.world.timestep, z: force.z * this.world.timestep });
    });
    for (const f of this.afterStep) f(this.world.timestep);
    // Removals queued during gameplay callbacks apply after the step.
    if (this.pending.length) {
      const q = this.pending;
      this.pending = [];
      for (const f of q) f();
    }
  }

  later(fn: () => void) {
    this.pending.push(fn);
  }

  /** Static axis-aligned or yawed box. Positions are the centre. */
  addStaticBox(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, yaw = 0, collisionGroups = GROUPS.static): Collider {
    const desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setTranslation(cx, cy, cz)
      .setCollisionGroups(collisionGroups)
      .setFriction(0.8);
    if (yaw) desc.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });
    return this.world.createCollider(desc);
  }

  /** Static box with an arbitrary orientation (a quaternion): ramps. */
  addStaticTilted(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, q: [number, number, number, number], collisionGroups = GROUPS.static): Collider {
    const desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setTranslation(cx, cy, cz)
      .setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] })
      .setCollisionGroups(collisionGroups)
      .setFriction(0.8);
    return this.world.createCollider(desc);
  }

  /** Static triangle-mesh collider from world-space vertices (x,y,z triples) and triangle indices. */
  addStaticTrimesh(vertices: Float32Array, indices: Uint32Array, collisionGroups = GROUPS.static): Collider {
    const desc = RAPIER.ColliderDesc.trimesh(vertices, indices).setCollisionGroups(collisionGroups).setFriction(0.8);
    return this.world.createCollider(desc);
  }

  /** Either of the two above, picked by `shape`. */
  addPropCollider(m: { shape: 'trimesh' | 'hull'; vertices: Float32Array; indices?: Uint32Array }, collisionGroups = GROUPS.static): Collider | null {
    return m.shape === 'hull' || !m.indices ? this.addStaticHull(m.vertices, collisionGroups) : this.addStaticTrimesh(m.vertices, m.indices, collisionGroups);
  }

  /** Note what a collider is made of, so a bullet that hits it knows. Returns the collider for chaining. */
  tag<T extends Collider | null>(c: T, surface: string): T {
    if (c) this.surfaces.set(c.handle, surface);
    return c;
  }

  /** Static convex hull of world-space vertices (x,y,z triples), or null when they are degenerate. */
  addStaticHull(vertices: Float32Array, collisionGroups = GROUPS.static): Collider | null {
    const desc = RAPIER.ColliderDesc.convexHull(vertices);
    if (!desc) return null;
    return this.world.createCollider(desc.setCollisionGroups(collisionGroups).setFriction(0.8));
  }

  /**
   * Heightfield over [x0, x0+size] x [z0, z0+size]. `heights` is (n+1)*(n+1) in column-major order:
   * index = col*(n+1)+row with col along x and row along z. Verified against Rapier 0.21.
   *
   * Rapier splits each cell along its (x0, z1)-(x1, z0) diagonal, but the drawn ground (and everything set on it: trees,
   * scatter, `drawnGroundAt`) splits along (x0, z0)-(x1, z1). On rough ground the two differ by a hand's breadth or more in
   * the middle of a cell, so wheels and feet sank into the drawn ground or floated over it. The collider is laid a quarter
   * turn round, with the heights turned to match, which puts its split on the drawn one.
   */
  addHeightfield(x0: number, z0: number, size: number, n: number, heights: Float32Array): Collider {
    const N1 = n + 1;
    const turned = new Float32Array(N1 * N1);
    // Turned a quarter round +y, the collider's x runs along world -z and its z along world x: its column j and row i
    // are the world's row n - j and column i.
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) turned[j * N1 + i] = heights[i * N1 + (n - j)];
    const desc = RAPIER.ColliderDesc.heightfield(n, n, turned, { x: size, y: 1, z: size })
      .setTranslation(x0 + size / 2, 0, z0 + size / 2)
      .setRotation({ x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 })
      .setCollisionGroups(GROUPS.static)
      .setFriction(0.9);
    return this.world.createCollider(desc);
  }

  removeCollider(c: Collider) {
    this.surfaces.delete(c.handle);
    this.impactHandlers.delete(c.handle);
    this.trees.delete(c.handle);
    this.stones.delete(c.handle);
    this.world.removeCollider(c, false);
  }

  releaseStepEvents() {
    if (this.afterStep.size) return;
    this.events?.free();
    this.events = undefined;
    this.moving.length = 0;
    this.contactForces.length = 0;
  }

  hitCollider(handle: number, hit: PhysicsImpact) {
    this.impactHandlers.get(handle)?.(hit);
  }

  hitArea(hit: PhysicsImpact) {
    for (const f of this.areaImpactHandlers) f(hit);
  }

  hitAlongRay(hit: PhysicsImpact, distance: number) {
    for (const f of this.rayImpactHandlers) f(hit, distance);
  }

  /** Cast a ray. Returns distance or null. */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, filter = groups(0xffff, G.STATIC | G.VEHICLE | G.BUILD), exclude?: RigidBody, predicate?: (collider: Collider) => boolean) {
    const ray = new RAPIER.Ray({ x: ox, y: oy, z: oz }, { x: dx, y: dy, z: dz });
    const hit = this.world.castRayAndGetNormal(ray, maxDist, true, undefined, filter, undefined, exclude, predicate);
    if (!hit) return null;
    return { toi: hit.timeOfImpact, normal: hit.normal, collider: hit.collider };
  }

  groundHeight(x: number, z: number, fromY = 200): number | null {
    const r = this.raycast(x, fromY, z, 0, -1, 0, fromY + 50, groups(0xffff, G.STATIC));
    return r ? fromY - r.toi : null;
  }
}
