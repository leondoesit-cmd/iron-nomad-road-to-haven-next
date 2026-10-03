import * as THREE from 'three';
import { BodyMesh, boundsOf } from '../render/deform';
import { groupParts, type PartGroup } from '../render/bodyParts';
import { newSkinUniforms, skinMaterial, type SkinUniforms } from '../render/vehicleDirt';
import { bodyMat, wheelSpec } from '../render/vehicleKit';
import { restHeight } from '../render/carModels';
import { GLOBALS } from '../render/materials';
import { partDef } from '../data';
import { rotateByQuat, type Contact, type VehicleBody } from '../physics/vehicle';
import {
  FREE_SPEED,
  LOOSE_AT,
  SNAP_AT,
  blastDent,
  bloodSplat,
  condAfterBreak,
  dentDepth,
  dentRadius,
  dirtStep,
  emptyBody,
  jointTol,
  markStyle,
  packDent,
  shockLoad,
  skidAmount,
  stateOf,
  strikeDent,
  stressFromShock,
  stressFromSpin,
  surfaceToward,
  unpackDent,
  STRAIGHT,
  STRAIGHTEN,
  type BodySave,
  type Dirt,
  type JointState,
  type V3,
} from '../sim/bodywork';
import { removePart } from '../sim/garage';
import { partName, type PartItem } from '../sim/parts';
import { clamp } from '../core/math';
import type { PartSlot } from '../data';
import type { Vehicle } from './vehicle';

/**
 * Everything that happens to a vehicle's body after the physics: crumpling, parts working loose and breaking off, mud and
 * blood building up, tyres leaving marks. One of these lives on each vehicle (not boats). The rules are in sim/bodywork.ts;
 * the lattice that bends the mesh is render/deform.ts; what flies off becomes debris (game/debris.ts).
 */

const ONE = new THREE.Vector3(1, 1, 1);

/** A conjugate quaternion rotates a world vector into the vehicle's frame. */
function toLocal(q: { x: number; y: number; z: number; w: number }, x: number, y: number, z: number): V3 {
  return rotateByQuat({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, x, y, z);
}

interface Joint {
  g: PartGroup;
  tol: number;
  stress: number;
  state: JointState;
  centre: V3 | null;
  half: V3;
  pivot: V3;
  /** The part as a separate mesh on a pivot, once it has started to work loose. */
  hang: THREE.Group | null;
  ang: [number, number];
  vel: [number, number];
  phase: number;
  /** Seconds until a part that has lost its mounting breaks the rest of the way, or -1. */
  cascade: number;
  gone: boolean;
}

const KIND_NAME: Record<string, string> = { door: 'Door', mirror: 'Mirror', bumper: 'Bumper', sign: 'Armour plate', spare: 'Spare wheel', crate: 'Crate', lightbar: 'Light bar', bullbar: 'Bull bar', slot: 'Part' };

export class Bodywork {
  readonly dirt: Dirt = { mud: 0, dust: 0, blood: 0 };
  hull: BodyMesh | null = null;
  enabled = true;
  private joints: Joint[] = [];
  private skin: SkinUniforms | null = null;
  private mat: THREE.MeshStandardMaterial | null = null;
  private restGeo: THREE.BufferGeometry | null = null;
  private lamps: { mesh: THREE.Mesh; rest: V3; hidden: boolean }[] = [];
  private lampsDirty = false;
  private cbuf: Contact[] = [];
  private acc: V3 = [0, 0, 0];
  private dirtT = 0;
  private trackT = 0;
  private scrapeT = 0;
  private time = Math.random() * 10;
  private sparkT = 0;
  private lastDirt = '';

  constructor(private v: Vehicle) {
    this.attach();
  }

  // ------------------------------------------------------------------ setup

  /** Bind to the vehicle's current model: its parts, a material of its own, and whatever the build remembers. */
  attach() {
    const v = this.v;
    this.release();
    this.enabled = v.def.physics.kind !== 'boat';
    if (!this.enabled) return;
    const vis = v.visual;
    this.restGeo = vis.body.geometry;
    const seed = v.build?.seed ?? v.id;
    const saved = v.build?.body;
    this.joints = groupParts(this.restGeo.userData.parts).map((g) => ({
      g,
      tol: jointTol(g.meta.tol, seed, g.tag),
      stress: saved?.stress[g.tag] ?? 0,
      state: 'fixed' as JointState,
      centre: null,
      half: [0, 0, 0] as V3,
      pivot: [0, 0, 0] as V3,
      hang: null,
      ang: [0, 0] as [number, number],
      vel: [0, 0] as [number, number],
      phase: Math.random() * 6.28,
      cascade: -1,
      gone: false,
    }));
    const p = v.def.physics;
    const wz = p.wheelsZ;
    this.skin = newSkinUniforms(-restHeight(v.def), wz[0], wz[wz.length - 1]);
    this.mat = skinMaterial(this.skin);
    if (!v.wreck) vis.body.material = this.mat;
    for (const w of vis.wheels) {
      const m = w.spin.children[0] as THREE.Mesh | undefined;
      if (m) m.material = this.mat;
    }
    this.lamps = [...vis.headlights, ...(vis.tails ?? [])].map((mesh) => ({ mesh, rest: [mesh.position.x, mesh.position.y, mesh.position.z] as V3, hidden: false }));
    if (saved) {
      this.dirt.mud = saved.dirt[0];
      this.dirt.dust = saved.dirt[1];
      this.dirt.blood = saved.dirt[2];
      if (saved.dents.length || saved.gone.length) {
        const hull = this.ensureHull();
        if (saved.dents.length) hull.replay(saved.dents.map(unpackDent));
        for (const tag of saved.gone) {
          const j = this.joints.find((q) => q.g.tag === tag);
          if (j) this.hideGone(j);
        }
        this.lampsDirty = true;
      }
      // Parts that were already hanging when the vehicle was put away hang again.
      for (const j of this.joints) if (stateOf(j.stress) === 'loose' && !j.gone) this.loosen(j);
    }
  }

  /** Let go of everything tied to the current model (before it is rebuilt or thrown away). */
  release() {
    for (const j of this.joints) {
      if (j.hang) {
        j.hang.removeFromParent();
        j.hang = null;
      }
    }
    this.joints = [];
    this.hull?.dispose();
    this.hull = null;
    this.mat?.dispose();
    this.mat = null;
    this.skin = null;
    this.lamps = [];
  }

  dispose() {
    this.release();
  }

  private ensureHull(): BodyMesh {
    if (!this.hull) {
      this.hull = new BodyMesh(this.restGeo!);
      this.v.visual.body.geometry = this.hull.geo;
    }
    return this.hull;
  }

  private geom(j: Joint) {
    if (j.centre) return;
    const b = boundsOf(this.restGeo!, j.g);
    j.centre = b.centre;
    j.half = b.half;
    j.pivot = j.g.meta.pivot ? [...j.g.meta.pivot] : [...b.centre];
  }

  // ------------------------------------------------------------------ fixed tick

  /** After the vehicle's own physics step: shocks, spin, loose parts, dirt and tyre marks. */
  tick(dt: number) {
    if (!this.enabled) return;
    const v = this.v;
    const b = v.body as VehicleBody;
    this.time += dt;
    const sp = Math.abs(v.speed);
    // The acceleration the chassis feels, in its own frame, smoothed: what hanging parts swing to.
    const q = b.body.rotation();
    const a = toLocal(q, b.shock[0] / dt, b.shock[1] / dt + 9.81, b.shock[2] / dt);
    const k = Math.min(1, 12 * dt);
    this.acc[0] += (a[0] - this.acc[0]) * k;
    this.acc[1] += (a[1] - this.acc[1]) * k;
    this.acc[2] += (a[2] - this.acc[2]) * k;

    if (!v.wreck) {
      const shock = Math.hypot(b.shock[0], b.shock[1] * 0.5, b.shock[2]);
      const spinShock = Math.hypot(b.shock[3], b.shock[4], b.shock[5]) * 1.4;
      if (shock > FREE_SPEED || spinShock > FREE_SPEED) this.knock(shock, spinShock);
      // Whirled about (a roll, a tumble, a spin-out): the parts furthest out are pulled hardest.
      const w = b.spin;
      if (w[0] * w[0] + w[1] * w[1] + w[2] * w[2] > 6) {
        const wl = toLocal(q, w[0], w[1], w[2]);
        for (const j of this.joints) {
          if (j.gone || j.state === 'gone') continue;
          this.geom(j);
          this.strain(j, stressFromSpin(wl, j.pivot, j.tol, dt));
        }
      }
      this.scrape(dt, sp);
    }
    for (const j of this.joints) {
      if (j.cascade >= 0 && !j.gone && (j.cascade -= dt) < 0) {
        j.cascade = -1;
        this.detach(j, [0, 0, 0], 4);
      }
      if (j.hang && !j.gone && sp > 5 && Math.random() < dt * 3 * j.stress) this.sparkAt(j, 2, 3);
    }

    // Dirt and tyre marks only matter for a vehicle that is moving, near someone who can see it.
    if (sp > 0.4 || this.dirt.mud > 0.01) {
      this.dirtT += dt;
      if (this.dirtT >= 0.1) {
        this.dirtOn(this.dirtT);
        this.dirtT = 0;
      }
    }
    if (sp > 0.8 && !v.wreck) {
      this.trackT += dt;
      const every = v.driver?.isPlayer ? 0 : 0.05;
      if (this.trackT >= every) {
        this.marks(this.trackT);
        this.trackT = 0;
      }
    }
  }

  // ------------------------------------------------------------------ crashes

  /** A real crash this tick: dent the body where it was hit, and shake every joint by what they felt. */
  private knock(shock: number, spinShock: number) {
    void spinShock;
    const v = this.v;
    const ctx = v.ctx;
    const b = v.body as VehicleBody;
    const q = b.body.rotation();
    const cs = b.contacts(this.cbuf);
    const speed = b.impact;
    const sparkAt = (c: V3, n: number) => {
      const [wx, wy, wz] = b.toWorld(c[0], c[1], c[2]);
      ctx.fx.spark(wx, wy, wz, n, 3 + speed * 0.3);
    };
    let main: Contact | null = null;
    let mainW = 0;
    for (const c of cs) {
      const w = c.impulse > 0 ? c.impulse : 0.5;
      if (w > mainW) {
        mainW = w;
        main = c;
      }
    }
    if (speed > 0) {
      const other = main ? ctx.vehicleByCollider.get(main.other) : undefined;
      const ratio = other ? other.mass / (other.mass + v.mass) : 0.55;
      const depth = dentDepth(speed, ratio);
      const radius = dentRadius(speed);
      if (depth > 0.004) {
        let hits = 0;
        const done: V3[] = [];
        const hitAt = (at: V3, push: V3, d: number) => {
          // The body is only copied out of the shared shell once something has really dented it.
          this.ensureHull().dent(at, push, d, radius);
          done.push(at);
          sparkAt(at, hits === 0 ? 5 + Math.min(10, speed * 0.6) : 2);
          hits++;
        };
        if (main) {
          const push = norm([-main.nx, -main.ny, -main.nz]);
          hitAt([main.x, main.y, main.z], push, depth);
          // Further points of the same crash (a corner, a long scrape) dent less.
          for (const c of cs) {
            if (hits >= 3 || c === main || done.some((p) => Math.hypot(p[0] - c.x, p[1] - c.y, p[2] - c.z) < 0.7)) continue;
            hitAt([c.x, c.y, c.z], norm([-c.nx, -c.ny, -c.nz]), depth * 0.55);
          }
        } else if (Math.hypot(b.shock[0], b.shock[2]) > speed * 0.6) {
          // (A hard landing is mostly vertical and has no side to dent.)
          // No contact to read (a blast, a shove): the obstacle was in the direction the velocity change came from.
          const t = toLocal(q, b.impactDirX, 0, b.impactDirZ);
          const toward = norm(t);
          const p = v.def.physics.halfExtents;
          hitAt(surfaceToward(toward, [v.def.width / 2, p[1], v.def.length / 2], 0), [-toward[0], 0, -toward[2]], depth);
        }
        this.lampsDirty = true;
      }
    }
    // What each part's joint felt: the car's own sudden change of speed plus the arm's swing.
    const dv = toLocal(q, b.shock[0], b.shock[1] * 0.5, b.shock[2]);
    const dw = toLocal(q, b.shock[3], b.shock[4], b.shock[5]);
    const worldDv: V3 = [b.shock[0], 0, b.shock[2]];
    for (const j of this.joints) {
      if (j.gone || j.state === 'gone') continue;
      this.geom(j);
      const load = shockLoad(dv, dw, j.pivot);
      const reach = Math.max(j.half[0], j.half[1], j.half[2]) + 0.55;
      const direct = cs.some((c) => Math.hypot(c.x - j.centre![0], c.y - j.centre![1], c.z - j.centre![2]) < reach);
      const add = stressFromShock(load, j.tol, direct);
      if (add > 0) this.strain(j, add, worldDv, load);
    }
    void shock;
  }

  /** Paint comes off along a scrape: a sideswipe that does not dent still throws sparks and scuffs the panel. */
  private scrape(dt: number, speed: number) {
    if (speed < 5) return;
    this.scrapeT -= dt;
    if (this.scrapeT > 0) return;
    this.scrapeT = 0.12;
    const b = this.v.body as VehicleBody;
    const cs = b.contacts(this.cbuf);
    if (!cs.length) return;
    // Contacts that are mostly sideways on the chassis are a wall or a car sliding along the flank.
    let c: Contact | null = null;
    for (const k of cs) if (Math.abs(k.nx) > 0.6 && k.impulse >= 0 && (!c || k.impulse > c.impulse)) c = k;
    if (!c) return;
    const hull = this.ensureHull();
    hull.scrape([c.x, c.y, c.z], 0.45, 0.07);
    const [wx, wy, wz] = b.toWorld(c.x, c.y, c.z);
    this.v.ctx.fx.spark(wx, wy, wz, 3, 4 + speed * 0.2);
    if (Math.random() < 0.4) this.v.ctx.audio.play('hit', wx, wz, 0.35);
    this.lampsDirty = true;
  }

  /** Something other than a collision hit the vehicle: a bullet, a blast, a brute's fist. */
  hit(o: { dmg: number; srcX: number; srcZ: number; at?: V3; blast?: number; smash?: boolean }) {
    if (!this.enabled || this.v.wreck) return;
    const v = this.v;
    const b = v.body as VehicleBody;
    const q = b.body.rotation();
    const t = b.body.translation();
    const toward = norm(toLocal(q, o.srcX - t.x, 0, o.srcZ - t.z));
    const half = v.def.physics.halfExtents;
    const at: V3 = o.at ? (toLocal(q, o.at[0] - t.x, o.at[1] - t.y, o.at[2] - t.z) as V3) : surfaceToward(toward, [v.def.width / 2, half[1], v.def.length / 2], 0.1);
    const push: V3 = [-toward[0], 0, -toward[2]];
    const hull = this.ensureHull();
    if (o.blast !== undefined) {
      const d = blastDent(o.dmg, o.blast);
      hull.dent(at, push, d.depth, d.radius);
      for (const j of this.joints) {
        if (j.gone || j.state === 'gone') continue;
        this.geom(j);
        const dist = Math.hypot(j.centre![0] - at[0], j.centre![1] - at[1], j.centre![2] - at[2]);
        const load = 16 * o.blast * Math.exp(-dist / 2.2);
        const add = stressFromShock(load, j.tol, dist < 1.6);
        if (add > 0) this.strain(j, add, [-(o.srcX - t.x), 0, -(o.srcZ - t.z)], load);
      }
    } else if (o.smash) {
      hull.dent(at, push, 0.1, 0.45);
    } else {
      const d = strikeDent(o.dmg);
      hull.dent(at, push, d.depth, d.radius);
      // A bullet that finds a mirror or a loose plate knocks it about.
      for (const j of this.joints) {
        if (j.gone || j.state === 'gone') continue;
        this.geom(j);
        const dist = Math.hypot(j.centre![0] - at[0], j.centre![1] - at[1], j.centre![2] - at[2]);
        if (dist > Math.max(...j.half) + 0.35) continue;
        const add = stressFromShock(3.4 + o.dmg * 0.07, j.tol, true);
        if (add > 0) this.strain(j, add, [t.x - o.srcX, 0, t.z - o.srcZ], 4);
      }
    }
    this.lampsDirty = true;
  }

  // ------------------------------------------------------------------ joints

  private strain(j: Joint, add: number, kick: V3 = [0, 0, 0], load = 6) {
    if (add <= 0 || j.gone) return;
    j.stress += add;
    const st = stateOf(j.stress);
    if (st === 'gone') {
      this.detach(j, kick, load);
      return;
    }
    if (st === 'loose' && j.state === 'fixed') {
      j.state = 'loose';
      this.loosen(j);
      this.sparkAt(j, 6, 5);
      const d = this.v.driver;
      if (d?.isPlayer && this.v.faction === 'convoy') this.v.ctx.notify(d.index, `${this.nameOf(j)} is coming loose`, 'warn');
    }
  }

  /** The part becomes its own mesh on a pivot, so it can rattle and swing on its joint. */
  private loosen(j: Joint) {
    if (j.hang || j.gone) return;
    this.geom(j);
    const hull = this.ensureHull();
    const geo = hull.extract(j.g, j.pivot);
    hull.hide(j.g, j.pivot);
    const grp = new THREE.Group();
    grp.position.set(j.pivot[0], j.pivot[1], j.pivot[2]);
    const m = new THREE.Mesh(geo, this.mat ?? bodyMat);
    m.castShadow = true;
    grp.add(m);
    this.v.visual.inner.add(grp);
    j.hang = grp;
    j.state = 'loose';
  }

  /** Hide a part for good (it came off in an earlier scene). */
  private hideGone(j: Joint) {
    this.geom(j);
    this.ensureHull().hide(j.g, j.pivot);
    j.gone = true;
    j.state = 'gone';
    j.stress = 1;
  }

  /** The joint lets go: the part leaves the body as a physical piece with the vehicle's speed and the knock behind it. */
  private detach(j: Joint, kick: V3, load: number) {
    if (j.gone) return;
    const v = this.v;
    const ctx = v.ctx;
    this.loosen(j);
    const grp = j.hang;
    if (!grp) return;
    j.gone = true;
    j.state = 'gone';
    j.stress = Math.max(j.stress, SNAP_AT);
    // Where the part is right now, from the physics body and the model's own lean and swing: the scene graph's world
    // matrices are only brought up to date at render time.
    const { pos, quat } = this.partPose(grp);
    const mesh = grp.children[0] as THREE.Mesh;
    const geo = mesh.geometry;
    grp.remove(mesh);
    grp.removeFromParent();
    j.hang = null;
    // Velocity of the joint: the vehicle's, plus its spin carried out to the arm.
    const lv = v.body.body.linvel();
    const av = v.body.body.angvel();
    const t = v.body.body.translation();
    const rx = pos.x - t.x;
    const ry = pos.y - t.y;
    const rz = pos.z - t.z;
    const vel = new THREE.Vector3(lv.x + av.y * rz - av.z * ry, lv.y + av.z * rx - av.x * rz, lv.z + av.x * ry - av.y * rx);
    // The part keeps going the way the car was pushed from: thrown against the knock.
    const kl = Math.hypot(kick[0], kick[2]);
    if (kl > 0.01) vel.add(new THREE.Vector3((-kick[0] / kl) * (2 + load * 0.35), 0, (-kick[2] / kl) * (2 + load * 0.35)));
    vel.y += 1.8 + load * 0.12 + Math.random() * 1.5;
    vel.x += (Math.random() - 0.5) * 2;
    vel.z += (Math.random() - 0.5) * 2;
    // Outward along its own side, so a door swings out of the way of the car.
    const side = j.g.meta.side;
    if (side) {
      const out = rotateByQuat(v.body.body.rotation(), side, 0, 0);
      vel.x += out[0] * 2.2;
      vel.z += out[2] * 2.2;
    }
    const spin = new THREE.Vector3((Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9);
    geo.computeBoundingBox();
    const bb = geo.boundingBox!;
    const half: V3 = [(bb.max.x - bb.min.x) / 2, (bb.max.y - bb.min.y) / 2, (bb.max.z - bb.min.z) / 2];
    const centre: V3 = [(bb.max.x + bb.min.x) / 2, (bb.max.y + bb.min.y) / 2, (bb.max.z + bb.min.z) / 2];
    // A fitted module takes its part with it: the stats go, and the part lies in the road for whoever wants it back.
    let item: PartItem | null = null;
    const slot = j.g.meta.slot as PartSlot | undefined;
    if (slot && v.build && v.build.fit[slot]) {
      v.commit();
      const out = removePart(v.build, slot);
      if (out) {
        item = { ...out, cond: condAfterBreak(out.cond, j.stress) };
        v.fitLost();
        // The other halves of the same module (the far side's plate, the second can rack) lose their mounting too.
        for (const o of this.joints) {
          if (o !== j && o.g.meta.slot === slot && !o.gone) {
            o.stress = Math.max(o.stress, SNAP_AT * 0.97);
            o.cascade = 0.12 + Math.random() * 0.5;
            if (!o.hang) this.loosen(o);
          }
        }
      }
    }
    const name = item ? partName(item) : this.nameOf(j);
    // Where nothing can be lifted off the ground (the camp arena, a cave), the part goes into the trunk instead of being lost.
    let stowed = false;
    if (item && !ctx.loose) {
      ctx.campaign.addPart(item);
      item = null;
      stowed = true;
    }
    ctx.debris.spawn({ geo, material: this.mat ?? bodyMat, pos, quat, vel, spin, centre, half, mass: j.g.meta.mass, round: j.g.meta.round, item, tag: j.g.tag });
    ctx.fx.spark(pos.x, pos.y, pos.z, 14, 7);
    ctx.audio.play('crash', pos.x, pos.z, 0.75);
    const d = v.driver;
    if (d?.isPlayer && v.faction === 'convoy') {
      ctx.notify(d.index, `${name} torn off${item ? ': it is in the road' : stowed ? ': stowed in the trunk' : ''}`, 'warn');
      ctx.players[d.index]?.cam.addShake(0.2);
    }
    this.lampsDirty = true;
  }

  private partPose(grp: THREE.Group): { pos: THREE.Vector3; quat: THREE.Quaternion } {
    const v = this.v;
    const vis = v.visual;
    const bq = v.body.body.rotation();
    const bt = v.body.body.translation();
    const body = new THREE.Quaternion(bq.x, bq.y, bq.z, bq.w);
    // Up the model's own tree: the part on its pivot, inside the inner group, inside the lean group.
    const quat = vis.lean.quaternion.clone().multiply(vis.inner.quaternion).multiply(grp.quaternion);
    const pos = grp.position.clone().add(vis.inner.position).applyQuaternion(vis.lean.quaternion).add(vis.lean.position);
    pos.applyQuaternion(body).add(new THREE.Vector3(bt.x, bt.y, bt.z));
    return { pos, quat: body.multiply(quat) };
  }

  private sparkAt(j: Joint, n: number, speed: number) {
    this.geom(j);
    const [x, y, z] = this.v.body.toWorld(j.pivot[0], j.pivot[1], j.pivot[2]);
    this.v.ctx.fx.spark(x, y, z, n, speed);
  }

  private nameOf(j: Joint): string {
    const slot = j.g.meta.slot;
    const fit = slot && this.v.build?.fit[slot as PartSlot];
    if (fit) return partDef(fit.id).name;
    return KIND_NAME[j.g.tag.split(':')[0]] ?? 'Part';
  }

  /** A vehicle blown apart: a few of its parts go with the explosion. */
  wreck() {
    if (!this.enabled) return;
    const v = this.v;
    let left = 5;
    const order = [...this.joints].sort(() => Math.random() - 0.5);
    for (const j of order) {
      if (left <= 0) break;
      // The first part always goes; after that, about two in three.
      if (j.gone || (left < 5 && Math.random() < 0.35)) continue;
      this.geom(j);
      const [x, , z] = v.body.toWorld(j.pivot[0], j.pivot[1], j.pivot[2]);
      this.detach(j, [x - v.position.x, 0, z - v.position.z], 14);
      left--;
    }
    // The shell is buckled by the blast.
    const hull = this.ensureHull();
    hull.dent([0, 0.35, v.def.length * 0.3], [0, -0.4, -0.9], 0.3, 1.1);
    hull.dent([0, 0.6, -v.def.length * 0.2], [0, -0.9, 0.2], 0.22, 1.0);
  }

  // ------------------------------------------------------------------ dirt, blood, tracks

  private dirtOn(dt: number) {
    const v = this.v;
    const ctx = v.ctx;
    if (v.wreck) return;
    const p = v.position;
    const sf = ctx.surfaceAt(p.x, p.z);
    const w = ctx.waterAt(p.x, p.z);
    const half = v.def.physics.halfExtents;
    const wr = v.def.physics.wheelRadius;
    const imm = w ? w.level - (p.y - half[1] - wr * 0.6) : 0;
    dirtStep(this.dirt, {
      dt,
      speed: v.speed,
      surface: sf.name,
      wet: GLOBALS.uWet.value,
      wading: imm > 0.05 ? clamp(imm / (wr * 2), 0, 1) : 0,
      storm: ctx.storm,
      grounded: v.onGround,
    });
  }

  /** A body in front of the bumper. */
  splat(amount: number) {
    if (!this.enabled) return;
    bloodSplat(this.dirt, amount);
  }

  private marks(dt: number) {
    const v = this.v;
    const ctx = v.ctx;
    const b = v.body as VehicleBody;
    // Not worth laying where nobody is looking.
    let near = ctx.players.length === 0;
    for (const pl of ctx.players) {
      const at = pl.vehicle ? pl.vehicle.position : pl.pos;
      if (Math.abs(at.x - v.position.x) < 130 && Math.abs(at.z - v.position.z) < 130) near = true;
    }
    const n = b.wheelCount;
    if (!near) {
      for (let i = 0; i < n; i++) ctx.marks.lift(v.id * 16 + i);
      return;
    }
    const f = b.forward();
    const up = b.up();
    const lv = b.body.linvel();
    const side: V3 = [up[1] * f[2] - up[2] * f[1], up[2] * f[0] - up[0] * f[2], up[0] * f[1] - up[1] * f[0]];
    const lateral = lv.x * side[0] + lv.y * side[1] + lv.z * side[2];
    const speed = b.speed;
    const mk = v.build?.fit.wheels ? partDef(v.build.fit.wheels.id).mk : 0;
    const halfW = wheelSpec(v.def, mk).width / 2;
    const it = v.lastIntent;
    for (let i = 0; i < n; i++) {
      const key = v.id * 16 + i;
      if (!b.ctl.wheelIsInContact(i)) {
        ctx.marks.lift(key);
        continue;
      }
      const cp = b.ctl.wheelContactPoint(i);
      if (!cp) continue;
      const surf = ctx.surfaceAt(cp.x, cp.z);
      const wet = GLOBALS.uWet.value;
      const skid = skidAmount({ lateral, speed, throttle: it.throttle, brake: it.brake, handbrake: it.handbrake, rear: b.rear[i] });
      const style = markStyle(surf.name, skid, speed, wet);
      if (!style || ctx.waterAt(cp.x, cp.z)) {
        ctx.marks.lift(key);
        continue;
      }
      ctx.marks.lay(key, cp.x, cp.z, halfW, style, (x, z) => ctx.groundAt(x, z));
    }
    void dt;
  }

  // ------------------------------------------------------------------ repair

  /** How bent the body is overall, 0 to 1. */
  dentLevel(): number {
    return this.hull?.level() ?? 0;
  }

  /** Body parts that have come off and can be put back (not the modules: those are in the road or in the bag). */
  missing(): number {
    return this.joints.filter((j) => j.gone && !j.g.meta.slot).length;
  }

  /** Hammer the dents out: a share of them goes with each job. Returns true when the body is straight. */
  straighten(): boolean {
    const hull = this.hull;
    if (!hull) return true;
    hull.straighten(STRAIGHTEN);
    if (hull.level() < STRAIGHT) hull.straighten(1);
    // The joints are reset by the same job: a part that was hanging is bolted tight again.
    for (const j of this.joints) {
      if (j.gone || j.stress <= 0) continue;
      j.stress = Math.max(0, j.stress - 0.5);
      if (j.hang && stateOf(j.stress) === 'fixed') this.tighten(j);
    }
    this.lampsDirty = true;
    return hull.level() < STRAIGHT;
  }

  private tighten(j: Joint) {
    if (!j.hang || !this.hull) return;
    j.hang.removeFromParent();
    (j.hang.children[0] as THREE.Mesh).geometry.dispose();
    j.hang = null;
    j.state = 'fixed';
    this.hull.show(j.g);
  }

  /** Weld one missing door, mirror or bumper back on. Returns its name, or null if nothing is missing. */
  restoreOne(): string | null {
    const j = this.joints.find((q) => q.gone && !q.g.meta.slot);
    if (!j || !this.hull) return null;
    j.gone = false;
    j.stress = 0;
    j.state = 'fixed';
    this.hull.show(j.g);
    this.lampsDirty = true;
    return this.nameOf(j);
  }

  /** Wash the paint (water, a rain, a bucket). */
  clean(amount = 1) {
    this.dirt.mud *= 1 - amount;
    this.dirt.dust *= 1 - amount;
    this.dirt.blood *= 1 - amount;
  }

  // ------------------------------------------------------------------ rendered frame

  frame(dt: number) {
    if (!this.enabled) return;
    const v = this.v;
    const sk = this.skin;
    if (sk) {
      const d = this.dirt;
      const key = `${d.mud.toFixed(3)}${d.dust.toFixed(3)}${d.blood.toFixed(3)}`;
      if (d.mud + d.dust + d.blood > 0.004) {
        sk.uDirt.value.set(d.mud, d.dust, d.blood);
        const r = v.visual.root;
        sk.uVehInv.value.compose(r.position, r.quaternion, ONE).invert();
      } else if (this.lastDirt !== key) sk.uDirt.value.set(0, 0, 0);
      this.lastDirt = key;
    }
    const hull = this.hull;
    if (hull && hull.pending) {
      hull.update(9000);
      this.lampsDirty = true;
    }
    if (this.lampsDirty && hull && !hull.pending) {
      this.lampsDirty = false;
      this.carryLamps(hull);
    }
    // Parts hanging on their joints swing to the car's acceleration and rattle with its speed.
    const sp = Math.abs(v.speed);
    for (const j of this.joints) {
      const g = j.hang;
      if (!g) continue;
      const loose = clamp((j.stress - LOOSE_AT) / (SNAP_AT - LOOSE_AT), 0, 1);
      const hinge = j.g.meta.joint === 'hinge';
      const rattle = Math.sin(this.time * 31 + j.phase) * 0.018 * Math.min(1, sp / 12) * (0.4 + loose);
      const side = j.g.meta.side || 1;
      const drive0 = clamp(-this.acc[2] * 0.012, -0.35, 0.35) * (0.4 + loose) + rattle;
      const drive1 = hinge ? -side * (0.1 + 0.55 * loose + clamp(this.acc[0] * side * 0.02, -0.3, 0.45)) : clamp(this.acc[0] * 0.012, -0.35, 0.35) * (0.4 + loose) + rattle * 0.7;
      const K = 60 * (1.15 - 0.7 * loose);
      const C = 4.5;
      const drives = [drive0, drive1];
      for (let i = 0; i < 2; i++) {
        const ac = K * (drives[i] - j.ang[i]) - C * j.vel[i];
        j.vel[i] += ac * Math.min(dt, 0.033);
        j.ang[i] = clamp(j.ang[i] + j.vel[i] * Math.min(dt, 0.033), -1.1, 1.1);
      }
      if (hinge) g.rotation.set(0, j.ang[1], 0);
      else g.rotation.set(j.ang[0], 0, j.ang[1]);
    }
  }

  /** Lamps ride the lattice with the panel they sit in, and go dark when it is crushed. */
  private carryLamps(hull: BodyMesh) {
    const out = { x: 0, y: 0, z: 0, crush: 0 };
    for (const l of this.lamps) {
      hull.sample(l.rest, out);
      l.mesh.position.set(l.rest[0] + out.x, l.rest[1] + out.y, l.rest[2] + out.z);
      const dead = out.crush > 0.7;
      if (dead !== l.hidden) {
        l.hidden = dead;
        l.mesh.visible = !dead;
      }
    }
  }

  // ------------------------------------------------------------------ memory

  /** What the build keeps of this body. */
  save(): BodySave | null {
    if (!this.enabled) return null;
    const s = emptyBody();
    if (this.hull) s.dents = this.hull.events.map((e) => packDent(e));
    s.dirt = [round3(this.dirt.mud), round3(this.dirt.dust), round3(this.dirt.blood)];
    for (const j of this.joints) {
      if (j.gone) {
        if (!j.g.meta.slot) s.gone.push(j.g.tag);
      } else if (j.stress > 0.02) s.stress[j.g.tag] = round3(j.stress);
    }
    const glass = this.v.glass?.stages();
    if (glass) s.glass = glass;
    return s;
  }

  commit() {
    const b = this.v.build;
    if (!b || !this.enabled) return;
    const s = this.save();
    if (!s) return;
    const empty = !s.dents.length && !s.gone.length && !s.glass && !Object.keys(s.stress).length && s.dirt.every((d) => d < 0.004);
    if (empty) delete b.body;
    else b.body = s;
  }

  /** Test and tooling access: the parts this body knows about, with their state. */
  partStates(): { tag: string; slot?: string; state: JointState; stress: number }[] {
    return this.joints.map((j) => ({ tag: j.g.tag, slot: j.g.meta.slot, state: j.state, stress: j.stress }));
  }

  /** Test and tooling access: push strain straight into one part's joint. */
  strainPart(tag: string, add: number, kick: V3 = [0, 0, 0]): boolean {
    const j = this.joints.find((q) => q.g.tag === tag);
    if (!j) return false;
    this.geom(j);
    this.strain(j, add, kick, 10);
    return true;
  }
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

function norm(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
