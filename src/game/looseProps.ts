import * as THREE from 'three';
import { RAPIER, GROUPS, type Collider, type RigidBody } from '../physics/physics';
import { kitMaterial } from '../render/materials';
import { PROP_DYNAMIC, propBuilder } from '../render/propCollision';
import type { PropSpawn } from '../world/layout';
import type { Ctx } from './ctx';

/**
 * Props that are not scenery: tyres and drums lie where the map put them, asleep and free, and become real rigid bodies the
 * moment anything touches them. A car at speed sends them rolling and bouncing, a person walking into one shoves it, and how
 * far and how lively depends on the weight and speed of whatever hit it against the weight of the prop (Rapier does the
 * contact; the mass, friction and bounce come from PROP_DYNAMIC). They are drawn as their own meshes instead of being baked
 * into the chunk's merged prop mesh, and live and die with the chunk they were placed in.
 */

interface Loose {
  body: RigidBody;
  collider: Collider;
  mesh: THREE.Mesh;
  prev: { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number };
}

const geoCache = new Map<string, THREE.BufferGeometry>();
const hullCache = new Map<string, Float32Array>();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

/** The kinds this system owns (the chunk leaves them out of its static prop mesh and colliders). */
export const isLooseKind = (kind: PropSpawn['kind']) => PROP_DYNAMIC[kind] !== undefined;

function shapeOf(p: PropSpawn): { geo: THREE.BufferGeometry; hull: Float32Array } | null {
  const b = propBuilder(p);
  if (!b || b.empty) return null;
  const key = `${p.kind}:${Math.abs(p.seed) % 4}:${p.tag ?? 0}`;
  let geo = geoCache.get(key);
  if (!geo) {
    geo = b.build();
    geoCache.set(key, geo);
    hullCache.set(key, Float32Array.from(b.pos));
  }
  return { geo, hull: hullCache.get(key)! };
}

export class LooseProps {
  private byChunk = new Map<string, Loose[]>();

  constructor(private ctx: Ctx) {}

  get count() {
    let n = 0;
    for (const l of this.byChunk.values()) n += l.length;
    return n;
  }

  /** Every loose body, for tests and tools. */
  all(): Loose[] {
    return [...this.byChunk.values()].flat();
  }

  /** Create the loose props among `props` and file them under `key`, to be released with the chunk. */
  add(key: string, props: readonly PropSpawn[]) {
    for (const p of props) {
      const def = PROP_DYNAMIC[p.kind];
      if (!def) continue;
      const shape = shapeOf(p);
      if (!shape) continue;
      const l = this.make(p, def, shape);
      if (!l) continue;
      let list = this.byChunk.get(key);
      if (!list) this.byChunk.set(key, (list = []));
      list.push(l);
    }
  }

  private make(p: PropSpawn, def: { mass: number; restitution: number; friction: number }, shape: { geo: THREE.BufferGeometry; hull: Float32Array }): Loose | null {
    const P = this.ctx.P;
    const verts = shape.hull.map((v) => v * p.scale);
    const cd = RAPIER.ColliderDesc.convexHull(verts);
    if (!cd) return null;
    const half = p.yaw / 2;
    const body = P.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(p.x, p.y, p.z)
        .setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) })
        .setLinearDamping(0.12)
        .setAngularDamping(0.35)
        .setCcdEnabled(true)
        // Asleep until touched: a map full of drums costs nothing while nobody is near them.
        .setSleeping(true),
    );
    const collider = P.world.createCollider(
      cd
        .setMass(def.mass * p.scale ** 3)
        .setFriction(def.friction)
        .setRestitution(def.restitution)
        .setCollisionGroups(GROUPS.loose),
      body,
    );
    const mesh = new THREE.Mesh(shape.geo, kitMaterial());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.scale.setScalar(p.scale);
    mesh.position.set(p.x, p.y, p.z);
    mesh.quaternion.set(0, Math.sin(half), 0, Math.cos(half));
    this.ctx.root.add(mesh);
    return { body, collider, mesh, prev: { x: p.x, y: p.y, z: p.z, qx: 0, qy: Math.sin(half), qz: 0, qw: Math.cos(half) } };
  }

  /** Take the props of an unloaded chunk out of the world. */
  release(key: string) {
    const list = this.byChunk.get(key);
    if (!list) return;
    for (const l of list) this.destroy(l);
    this.byChunk.delete(key);
  }

  private destroy(l: Loose) {
    this.ctx.P.world.removeCollider(l.collider, false);
    this.ctx.P.world.removeRigidBody(l.body);
    l.mesh.removeFromParent();
  }

  /** Once per fixed tick, before the world steps: remember where everything was, for smooth drawing. */
  update() {
    for (const [key, list] of this.byChunk) {
      for (let i = list.length - 1; i >= 0; i--) {
        const l = list[i];
        if (l.body.isSleeping()) continue;
        const t = l.body.translation();
        const r = l.body.rotation();
        l.prev.x = t.x;
        l.prev.y = t.y;
        l.prev.z = t.z;
        l.prev.qx = r.x;
        l.prev.qy = r.y;
        l.prev.qz = r.z;
        l.prev.qw = r.w;
        // Knocked off the map.
        if (t.y < -60) {
          this.destroy(l);
          list.splice(i, 1);
        }
      }
      if (!list.length) this.byChunk.delete(key);
    }
  }

  /** Once per rendered frame. */
  sync(alpha: number) {
    for (const list of this.byChunk.values()) {
      for (const l of list) {
        if (l.body.isSleeping()) continue;
        const t = l.body.translation();
        const r = l.body.rotation();
        l.mesh.position.set(l.prev.x + (t.x - l.prev.x) * alpha, l.prev.y + (t.y - l.prev.y) * alpha, l.prev.z + (t.z - l.prev.z) * alpha);
        _q.set(l.prev.qx, l.prev.qy, l.prev.qz, l.prev.qw);
        _q2.set(r.x, r.y, r.z, r.w);
        l.mesh.quaternion.copy(_q.slerp(_q2, alpha));
      }
    }
  }

  clear() {
    for (const list of this.byChunk.values()) for (const l of list) this.destroy(l);
    this.byChunk.clear();
  }
}
