import * as THREE from 'three';
import { RAPIER, G, GROUPS, groups, type Collider, type RigidBody } from '../physics/physics';
import type { Carried, Loose } from '../sim/carry';
import type { PartItem } from '../sim/parts';
import type { Ctx } from './ctx';

/**
 * Things that came off vehicles. Each piece is a real dynamic body: it tumbles, bounces, rolls (a spare wheel) and lies in
 * the road, where it is an obstacle for any vehicle that comes along (the vehicle collision group sees it, the wheel rays do
 * not, so tyres ride over what the chassis would hit). A piece that was a fitted module keeps the part it was, worn by the
 * knock, and once it has settled it can be lifted like any loose part and bolted back on.
 */

const MAX_PIECES = 32;
/** Scrap is heavier than it looks, and a knock has to be felt: pieces weigh this much more than the parts they were. */
const HEFT = 2.2;
/** Seconds before a launched piece collides with vehicles, so it does not spring off the chassis it was bolted to. */
const ARM_AFTER = 0.45;
/** How long a piece without a part in it lies about before it is cleared, seconds. */
const SCRAP_LIFE = 150;

export interface DebrisIn {
  geo: THREE.BufferGeometry;
  material: THREE.Material;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  /** Collision box centre (in the piece's frame) and half-extents. */
  centre: [number, number, number];
  half: [number, number, number];
  mass: number;
  round?: boolean;
  item?: PartItem | null;
  /** A thing that is not a fitted part but can still be lifted once it lies still: a can that fell off a roof. */
  carried?: Carried | null;
  tag: string;
}

export interface Piece {
  id: number;
  tag: string;
  body: RigidBody;
  collider: Collider;
  mesh: THREE.Mesh;
  age: number;
  /** Seconds it has lain still. */
  rest: number;
  item: PartItem | null;
  carried: Carried | null;
  armed: boolean;
  /** 1 while it exists, falling to 0 as scrap is cleared away. */
  fade: number;
  prev: { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number };
}

let nextId = 1;

export class DebrisField {
  pieces: Piece[] = [];
  private cullT = 0;

  constructor(private ctx: Ctx) {}

  spawn(o: DebrisIn): Piece {
    const P = this.ctx.P;
    const body = P.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(o.pos.x, o.pos.y, o.pos.z)
        .setRotation({ x: o.quat.x, y: o.quat.y, z: o.quat.z, w: o.quat.w })
        .setLinvel(o.vel.x, o.vel.y, o.vel.z)
        .setAngvel({ x: o.spin.x, y: o.spin.y, z: o.spin.z })
        .setLinearDamping(0.1)
        .setAngularDamping(0.5)
        .setCcdEnabled(true),
    );
    const [hx, hy, hz] = o.half.map((h) => Math.max(0.04, h));
    let desc: RAPIER.ColliderDesc;
    if (o.round) {
      // A wheel: a cylinder whose axis is its thinnest dimension, so it rolls.
      const axis = hx <= hy && hx <= hz ? 0 : hy <= hz ? 1 : 2;
      const radius = axis === 0 ? Math.max(hy, hz) : axis === 1 ? Math.max(hx, hz) : Math.max(hx, hy);
      const half = [hx, hy, hz][axis];
      desc = RAPIER.ColliderDesc.cylinder(half, radius);
      // The cylinder's axis is Y: turn it onto X or Z when that is the thin side.
      if (axis === 0) desc.setRotation({ x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 });
      else if (axis === 2) desc.setRotation({ x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 });
    } else desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz);
    desc
      .setTranslation(o.centre[0], o.centre[1], o.centre[2])
      .setMass(o.mass * HEFT)
      .setFriction(0.8)
      .setRestitution(0.28)
      // Until it is armed it belongs to the "people" group: solid to the ground, invisible to vehicles and to the wheel rays.
      .setCollisionGroups(groups(G.PLAYER, G.STATIC));
    const collider = P.world.createCollider(desc, body);
    const mesh = new THREE.Mesh(o.geo, o.material);
    mesh.castShadow = true;
    mesh.position.copy(o.pos);
    mesh.quaternion.copy(o.quat);
    this.ctx.root.add(mesh);
    const piece: Piece = {
      id: nextId++,
      tag: o.tag,
      body,
      collider,
      mesh,
      age: 0,
      rest: 0,
      item: o.item ?? null,
      carried: o.carried ?? null,
      armed: false,
      fade: 1,
      prev: { x: o.pos.x, y: o.pos.y, z: o.pos.z, qx: o.quat.x, qy: o.quat.y, qz: o.quat.z, qw: o.quat.w },
    };
    this.pieces.push(piece);
    while (this.pieces.length > MAX_PIECES) this.remove(this.oldest(), true);
    return piece;
  }

  /** Which piece goes when there are too many: scrap that has stopped moving, then scrap, then anything but a part. */
  private oldest(): Piece {
    const pick = (f: (p: Piece) => boolean) => this.pieces.find(f);
    return pick((p) => !p.item && !p.carried && p.rest > 1) ?? pick((p) => !p.item && !p.carried) ?? pick((p) => p.rest > 1) ?? this.pieces[0];
  }

  /** Take a piece out of the world. A piece that still carries a part is not simply lost: it becomes an ordinary pickup where it lies, when `keep` is set. */
  remove(p: Piece, keep = false) {
    const i = this.pieces.indexOf(p);
    if (i < 0) return;
    if (keep && (p.item || p.carried) && this.ctx.loose) {
      const t = p.body.translation();
      this.ctx.loose.drop(t.x, t.z, p.item ? { kind: 'part', item: p.item } : p.carried!);
    }
    this.pieces.splice(i, 1);
    this.ctx.P.world.removeCollider(p.collider, false);
    this.ctx.P.world.removeRigidBody(p.body);
    p.mesh.removeFromParent();
    p.mesh.geometry.dispose();
  }

  /** Once per fixed tick, before the world steps. */
  update(dt: number) {
    if (!this.pieces.length) return;
    this.cullT -= dt;
    const far = this.cullT <= 0;
    if (far) this.cullT = 1;
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const p = this.pieces[i];
      const t = p.body.translation();
      const r = p.body.rotation();
      p.prev.x = t.x;
      p.prev.y = t.y;
      p.prev.z = t.z;
      p.prev.qx = r.x;
      p.prev.qy = r.y;
      p.prev.qz = r.z;
      p.prev.qw = r.w;
      p.age += dt;
      if (!p.armed && p.age > ARM_AFTER) {
        p.armed = true;
        p.collider.setCollisionGroups(GROUPS.prop);
      }
      const lv = p.body.linvel();
      const av = p.body.angvel();
      if (Math.hypot(lv.x, lv.y, lv.z) < 0.25 && Math.hypot(av.x, av.y, av.z) < 0.45) p.rest += dt;
      else p.rest = 0;
      if (!p.item && !p.carried && p.age > SCRAP_LIFE) {
        p.fade -= dt / 3;
        p.mesh.scale.setScalar(Math.max(0.01, p.fade));
        if (p.fade <= 0) {
          this.remove(p);
          continue;
        }
      }
      if (t.y < -60) {
        this.remove(p);
        continue;
      }
      if (far && !this.nearAnyone(t.x, t.z, 420)) this.remove(p, true);
    }
  }

  private nearAnyone(x: number, z: number, r: number): boolean {
    for (const pl of this.ctx.players) {
      const at = pl.vehicle ? pl.vehicle.position : pl.pos;
      if (Math.abs(at.x - x) < r && Math.abs(at.z - z) < r) return true;
    }
    // No one in the scene (a headless test): keep everything.
    return this.ctx.players.length === 0;
  }

  /** Once per rendered frame. */
  sync(alpha: number) {
    for (const p of this.pieces) {
      const t = p.body.translation();
      const r = p.body.rotation();
      p.mesh.position.set(p.prev.x + (t.x - p.prev.x) * alpha, p.prev.y + (t.y - p.prev.y) * alpha, p.prev.z + (t.z - p.prev.z) * alpha);
      _q.set(p.prev.qx, p.prev.qy, p.prev.qz, p.prev.qw);
      _q2.set(r.x, r.y, r.z, r.w);
      p.mesh.quaternion.copy(_q.slerp(_q2, alpha));
    }
  }

  // ------------------------------------------------------------------ lifting

  /** The nearest settled piece that still carries a part, as something to lift. */
  nearestLoose(x: number, z: number, r: number, prefer?: string): Loose | null {
    let best: Loose | null = null;
    let bd = r;
    for (const p of this.pieces) {
      if ((!p.item && !p.carried) || p.rest < 0.8) continue;
      const t = p.body.translation();
      const id = `debris:${p.id}`;
      const d = Math.hypot(t.x - x, t.z - z) - (id === prefer ? 0.3 : 0);
      if (d < bd) {
        bd = d;
        best = { id, carried: p.item ? { kind: 'part', item: p.item } : p.carried!, x: t.x, y: t.y, z: t.z };
      }
    }
    return best;
  }

  /** Lift a piece off the road: it leaves the world and the part it was is handed over. */
  take(id: string): Carried | null {
    if (!id.startsWith('debris:')) return null;
    const n = Number(id.slice(7));
    const p = this.pieces.find((q) => q.id === n);
    if (!p?.item && !p?.carried) return null;
    const out: Carried = p.item ? { kind: 'part', item: p.item } : p.carried!;
    this.remove(p);
    return out;
  }

  clear() {
    for (const p of [...this.pieces]) this.remove(p);
  }
}

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
