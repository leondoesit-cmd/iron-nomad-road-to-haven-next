import RAPIER from '@dimforge/rapier3d-compat';

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
} as const;

export const groups = (member: number, filter: number) => ((member & 0xffff) << 16) | (filter & 0xffff);

export const GROUPS = {
  /** Terrain, buildings, barricades. */
  static: groups(G.STATIC, G.VEHICLE | G.PLAYER | G.PROP | G.LOOSE),
  /** Chassis: collides with static, other vehicles, players and props. */
  vehicle: groups(G.VEHICLE, G.STATIC | G.VEHICLE | G.PLAYER | G.PROP | G.BUILD | G.FURN | G.LOOSE),
  /** Capsule: collides with static, vehicles and built structures. */
  player: groups(G.PLAYER, G.STATIC | G.VEHICLE | G.BUILD | G.FURN | G.LOOSE),
  furn: groups(G.FURN, G.VEHICLE | G.PLAYER | G.LOOSE),
  prop: groups(G.PROP, G.STATIC | G.VEHICLE),
  /** Camp structures (blocking elements). */
  build: groups(G.BUILD, G.VEHICLE | G.PLAYER | G.LOOSE),
  /** Loose props: solid to the ground, buildings, furniture, vehicles, people and each other; wheel rays ignore them so tyres ride over. */
  loose: groups(G.LOOSE, G.STATIC | G.VEHICLE | G.PLAYER | G.FURN | G.BUILD | G.LOOSE),
  /** What wheel rays can hit: the ground, built things, and parts that have come off a vehicle and lie in the road. */
  wheelRays: groups(0xffff, G.STATIC | G.BUILD | G.PROP),
};

let ready: Promise<void> | null = null;
export function initPhysics() {
  if (!ready) ready = RAPIER.init();
  return ready;
}

export const FIXED_STEP = 1 / 60;

export class PhysicsWorld {
  world: RAPIER.World;
  private pending: (() => void)[] = [];
  /** What a collider is made of (a ballistics Surface name), by handle, for things that are not boxes of the world: props, stones. */
  surfaces = new Map<number, string>();

  constructor() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = FIXED_STEP;
    this.world.integrationParameters.numSolverIterations = 6;
  }

  step() {
    this.world.step();
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
   */
  addHeightfield(x0: number, z0: number, size: number, n: number, heights: Float32Array): Collider {
    const desc = RAPIER.ColliderDesc.heightfield(n, n, heights, { x: size, y: 1, z: size })
      .setTranslation(x0 + size / 2, 0, z0 + size / 2)
      .setCollisionGroups(GROUPS.static)
      .setFriction(0.9);
    return this.world.createCollider(desc);
  }

  removeCollider(c: Collider) {
    this.surfaces.delete(c.handle);
    this.world.removeCollider(c, false);
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
