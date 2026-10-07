import * as THREE from 'three';
import { G, groups } from '../physics/physics';
import { roadLift } from '../render/chunkview';
import { ARROW_LEN, arrowGeometry } from '../render/bow';
import { kitMaterial } from '../render/materials';
import { ARCHERY, arrowSurvives, embedDepth, sticks } from '../sim/archery';
import type { Surface } from '../sim/ballistics';
import type { Ctx } from './ctx';

/** Anything an arrow can stick in that moves about: the arrow is carried along, and falls out where the body falls. */
export interface ArrowHost {
  x: number;
  y: number;
  z: number;
  yaw: number;
  dead: boolean;
}

/** An arrow that has landed. */
interface Stuck {
  /** A crossbow bolt is shorter and does not enter the bow's quiver. */
  bolt?: boolean;
  /** Where its point is, and which way the shaft runs to it (unit, the way it was flying): in the world, or in its host's frame. */
  x: number;
  y: number;
  z: number;
  dx: number;
  dy: number;
  dz: number;
  host: ArrowHost | null;
  age: number;
}

/** A round in the air as the arrows read it: what it is, where it was a tick ago and is now, and the offset it is drawn from. */
export interface ArrowFlight {
  kind: string;
  x: number;
  y: number;
  z: number;
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  /** How far the drawn arrow sits off the round's path when it leaves the bow, and how far the round has come since. */
  seen?: [number, number, number];
  travelled: number;
}

const FLOOR = groups(0xffff, G.STATIC | G.BUILD | G.FURN);
/** Room for every arrow in the air and on the ground at once. */
const CAP = 96;
/** The drawn arrow eases from the bow onto the round's true path over this many metres. */
const EASE = 7;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _d = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const FWD = new THREE.Vector3(0, 0, 1);

/**
 * Arrows, the ones in the air and the ones that have come down: in the ground at the angle they fell, in a wall, or in a
 * body that walks on with them in it. Walk up to one that is not in something living and it is pulled out and goes back in
 * the quiver (the convoy's `items.arrow`); one in a body drops to the ground where the body falls. Some break when they land,
 * more on stone and steel. One instanced mesh draws them all.
 */
export class Arrows {
  readonly mesh: THREE.InstancedMesh;
  readonly stuck: Stuck[] = [];
  /** Arrows pulled back out this scene, and arrows broken landing, for the HUD's notes and the tests. */
  recovered = 0;
  broken = 0;
  private dice = 0x2545f491;

  constructor(private ctx: Ctx) {
    this.mesh = new THREE.InstancedMesh(arrowGeometry(), kitMaterial(), CAP);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.count = 0;
  }

  /** Its own dice, so arrows breaking never shifts the scene's random stream. */
  private roll(): number {
    this.dice = (Math.imul(this.dice, 1664525) + 1013904223) >>> 0;
    return this.dice / 4294967296;
  }

  private add(s: Omit<Stuck, 'age'>) {
    if (this.stuck.length >= ARCHERY.maxStuck) this.stuck.shift();
    this.stuck.push({ ...s, age: 0 });
  }

  /**
   * An arrow struck something solid at (x, y, z) flying along (dx, dy, dz), at `share` of a full draw's speed. It goes in, or
   * glances off and lies at the foot of it, or breaks. On something moving (a car) it is knocked off onto the ground.
   */
  landed(surface: Surface, x: number, y: number, z: number, nx: number, ny: number, nz: number, dx: number, dy: number, dz: number, share: number, moving = false, bolt = false) {
    const ctx = this.ctx;
    if (!arrowSurvives(surface, share, this.roll())) {
      if (!bolt) this.broken++;
      ctx.fx.puff(x, y, z, 0.6, 0.48, 0.32, 0.25, 0.3);
      return;
    }
    if (sticks(surface) && !moving) {
      const e = embedDepth(surface, share) * (bolt ? 0.65 : 1);
      this.add({ x: x + dx * e, y: y + dy * e, z: z + dz * e, dx, dy, dz, host: null, bolt });
      return;
    }
    // It glances off, and comes to rest a little way out from what it hit.
    this.fall(x + nx * 0.3 - dx * 0.2, y, z + nz * 0.3 - dz * 0.2, Math.atan2(dx, dz) + (this.roll() - 0.5) * 1.6, bolt);
  }

  /** An arrow went into a body. It rides there while the body lives, and falls out where it drops. */
  inBody(host: ArrowHost, x: number, y: number, z: number, dx: number, dy: number, dz: number, share: number) {
    if (!arrowSurvives('flesh', share, this.roll())) {
      this.broken++;
      return;
    }
    const e = embedDepth('flesh', share);
    // Into the body's own frame: turned back by its heading and measured from its feet.
    const c = Math.cos(host.yaw);
    const s = Math.sin(host.yaw);
    const wx = x + dx * e - host.x;
    const wz = z + dz * e - host.z;
    this.add({ x: wx * c - wz * s, y: y + dy * e - host.y, z: wx * s + wz * c, dx: dx * c - dz * s, dy, dz: dx * s + dz * c, host });
  }

  /** An arrow lying flat on the ground at (x, z), its point toward `yaw`. */
  private fall(x: number, y: number, z: number, yaw: number, bolt = false) {
    const floor = this.floorAt(x, y + 0.6, z);
    const dx = Math.sin(yaw);
    const dz = Math.cos(yaw);
    // Lying on its vanes, a finger's width off the ground, the point half its length ahead of where it fell.
    const len = ARROW_LEN * (bolt ? 0.6 : 1);
    this.add({ x: x + dx * len * 0.5, y: floor + 0.012, z: z + dz * len * 0.5, dx, dy: 0, dz, host: null, bolt });
  }

  private floorAt(x: number, y: number, z: number): number {
    const ctx = this.ctx;
    const r = ctx.P.raycast(x, y, z, 0, -1, 0, 4, FLOOR);
    const lift = ctx.terrain && (!r || r.normal.y > 0.7) ? roadLift(ctx.terrain, x, z) : 0;
    return (r ? y - r.toi : ctx.groundAt(x, z)) + lift;
  }

  /** Where an arrow's point is in the world, and which way it runs, into `p` and `d`. */
  private pose(s: Stuck, p: THREE.Vector3, d: THREE.Vector3) {
    const h = s.host;
    if (!h) {
      p.set(s.x, s.y, s.z);
      d.set(s.dx, s.dy, s.dz);
      return;
    }
    const c = Math.cos(h.yaw);
    const n = Math.sin(h.yaw);
    p.set(h.x + s.x * c + s.z * n, h.y + s.y, h.z - s.x * n + s.z * c);
    d.set(s.dx * c + s.dz * n, s.dy, -s.dx * n + s.dz * c);
  }

  /**
   * Once a tick: arrows in bodies that have fallen drop out beside them, ones given up on go, and anyone on foot who walks
   * up to one pulls it out.
   */
  update(dt: number) {
    const ctx = this.ctx;
    for (let i = this.stuck.length - 1; i >= 0; i--) {
      const s = this.stuck[i];
      s.age += dt;
      const h = s.host;
      if (!h) continue;
      if (h.dead) {
        this.pose(s, _p, _d);
        this.stuck.splice(i, 1);
        this.fall(_p.x, _p.y, _p.z, Math.atan2(_d.x, _d.z) + (this.roll() - 0.5) * 2);
      } else if (s.age > ARCHERY.bodyLife) this.stuck.splice(i, 1);
    }
    const reach = ARCHERY.reach;
    for (const p of ctx.players) {
      if (p.state !== 'foot' || !p.alive) continue;
      let got = 0;
      for (let i = this.stuck.length - 1; i >= 0; i--) {
        const s = this.stuck[i];
        if (s.host || s.bolt) continue;
        // Reach for the middle of the shaft.
        const mx = s.x - s.dx * ARROW_LEN * 0.5;
        const my = s.y - s.dy * ARROW_LEN * 0.5;
        const mz = s.z - s.dz * ARROW_LEN * 0.5;
        if ((mx - p.pos.x) ** 2 + (mz - p.pos.z) ** 2 > reach * reach) continue;
        if (my < p.pos.y - 0.5 || my > p.pos.y + 2.3) continue;
        this.stuck.splice(i, 1);
        got++;
      }
      if (got) {
        this.recovered += got;
        ctx.campaign.items.arrow += got;
        ctx.audio.play('pickup', p.pos.x, p.pos.z, 0.35);
        p.note(`${got > 1 ? `${got} arrows` : 'Arrow'} back in the quiver (${ctx.campaign.items.arrow})`, 'good');
      }
    }
  }

  /** Draw the arrows: the arrows among the rounds in the air (between their last two ticks by `alpha`), then the landed ones. */
  sync(flights: readonly ArrowFlight[], alpha: number) {
    let n = 0;
    for (const f of flights) {
      if (f.kind !== 'arrow' && f.kind !== 'bolt') continue;
      if (n >= CAP) break;
      _p.set(f.px + (f.x - f.px) * alpha, f.py + (f.y - f.py) * alpha, f.pz + (f.z - f.pz) * alpha);
      if (f.seen) {
        const k = Math.max(0, 1 - f.travelled / EASE);
        _p.x += f.seen[0] * k;
        _p.y += f.seen[1] * k;
        _p.z += f.seen[2] * k;
      }
      _d.set(f.vx, f.vy, f.vz);
      if (_d.lengthSq() < 1e-8) continue;
      this.put(n++, _p, _d.normalize(), f.kind === 'bolt');
    }
    for (const s of this.stuck) {
      if (n >= CAP) break;
      this.pose(s, _p, _d);
      this.put(n++, _p, _d, s.bolt);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  private put(i: number, p: THREE.Vector3, d: THREE.Vector3, bolt = false) {
    _q.setFromUnitVectors(FWD, d);
    _s.setScalar(bolt ? 0.6 : 1);
    this.mesh.setMatrixAt(i, _m.compose(p, _q, _s));
  }

  clear() {
    this.stuck.length = 0;
    this.mesh.count = 0;
  }

  dispose() {
    this.clear();
    this.mesh.removeFromParent();
    this.mesh.dispose();
  }
}
