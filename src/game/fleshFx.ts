import * as THREE from 'three';
import { G, groups } from '../physics/physics';
import { roadLift } from '../render/chunkview';
import { CELL } from '../render/decals';
import { FleshRenderer, type BodyPose } from '../render/fleshRender';
import { GutsRenderer } from '../render/guts';
import { Organs, type OrganKind } from '../render/organs';
import {
  CHAINS, CUT_RANGE, NECK_CUT, chainIndex, copyFlesh, injure, injuryOf, limbAt, newFlesh, pieceOf,
  type Chain, type FleshEvents, type FleshState, type LimbChain, type SurfacePoint,
} from '../sim/flesh';
import type { Zone } from '../sim/ballistics';
import type { ZombieKind } from '../data';
import type { Ctx } from './ctx';
import type { Gore } from './gore';
import type { Zombie } from './zombies';

const RAY = groups(0xffff, G.STATIC | G.VEHICLE | G.BUILD | G.FURN);

/** A blow as the game knows it: what did it (an `AmmoKind` or a melee model, 'blast', 'vehicle'), how hard, where, which way. */
export interface FleshHit {
  key: string;
  /** Damage over the body's hit points. */
  power: number;
  zone: Zone;
  /** World point it landed on and the way it was going. */
  x: number;
  y: number;
  z: number;
  dx: number;
  dy: number;
  dz: number;
  through?: boolean;
  killed: boolean;
  off?: Exclude<Zone, 'torso'>[];
  /** A swept swing's own reckoning of the cut (see `Blow.cutDepth`). */
  cutDepth?: number;
  cutThrough?: boolean;
  /** Where it landed already worked out in the rest pose (`locate`), as for a body lying on the ground. */
  rest?: Located;
}

/** A world point found on a body: which part it is nearest, and where that is in the rest pose (with the blow's way). */
export interface Located {
  zone: Zone;
  part: number;
  x: number;
  y: number;
  z: number;
  dx: number;
  dy: number;
  dz: number;
}

/** A point in the middle of each part of the body (rest pose), to find which one a point in the world is nearest. */
const REFS: [number, number, number, number, Zone][] = [
  [0, 0, 0.98, 0, 'torso'], [0, 0, 1.18, 0, 'torso'], [0, 0, 1.38, 0, 'torso'], [9, 0, 1.7, 0.02, 'head'],
  [5, 0.22, 1.28, 0, 'armL'], [7, 0.23, 1.0, 0.01, 'armL'], [6, -0.22, 1.28, 0, 'armR'], [8, -0.23, 1.0, 0.01, 'armR'],
  [1, 0.1, 0.73, 0.01, 'legL'], [3, 0.11, 0.3, 0.015, 'legL'], [2, -0.1, 0.73, 0.01, 'legR'], [4, -0.11, 0.3, 0.015, 'legR'],
];

/** A part of a body that came off it, flying and then lying where it fell. */
interface Piece {
  kind: ZombieKind;
  scale: number;
  variant: number;
  chain: number;
  f: FleshState;
  /** Rest-pose point it turns about, and its half extents. */
  c: [number, number, number];
  h: [number, number, number];
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  quat: THREE.Quaternion;
  spin: THREE.Vector3;
  rest: boolean;
  age: number;
  /** Seconds it goes on bleeding from the cut. */
  bleed: number;
  trailT: number;
  /** Long things (an arm, a leg, a lower body) settle lying along the ground. */
  long: boolean;
}

/** A spilled length of gut: a chain of points under gravity, hanging from where it came out until it tears free. */
interface Rope {
  n: number;
  seg: number;
  r: number;
  col: [number, number, number];
  /** Each node's own swelling and how bloody it is: gut is lumpy and smeared, not a string of beads. */
  rad: Float32Array;
  blood: Float32Array;
  /** Loops of it bulging out of the opening round where it hangs from: offsets and sizes. */
  lumps: Float32Array;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  px: Float32Array;
  py: Float32Array;
  pz: Float32Array;
  body: Zombie | null;
  piece: Piece | null;
  /** Rest-pose point it hangs from. */
  root: [number, number, number];
  attached: boolean;
  age: number;
  floor: number;
  floorT: number;
  smearT: number;
  /** The ground under each node, looked up a few times a second rather than every step. */
  gy: Float32Array;
  /** Which way and how tightly it coils as it settles on the ground. */
  curl: number;
}

const MAX_PIECES = 36;
const MAX_ROPES = 28;
/** Seconds a piece or a length of gut stays before it goes. */
const LINGER = 160;

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qd = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _a = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** Skin of each kind, as the zombie shader draws it. */
const SKIN: Record<ZombieKind, [number, number, number]> = {
  walker: [0.44, 0.46, 0.38], runner: [0.48, 0.46, 0.38], screamer: [0.56, 0.53, 0.6], bloater: [0.53, 0.56, 0.31], brute: [0.48, 0.35, 0.3], stalker: [0.36, 0.4, 0.44],
};

/**
 * The flesh engine in the world: turns a blow on one of the dead into what it does under the skin (`sim/flesh.ts`), and
 * plays out the rest: a crater blown out of the back, a skull bursting into bone and brain, a bone snapping with a crack, a
 * belly opening and the gut sliding out and hanging, dragging, tearing free; an arm, a head, the bottom half of a body
 * flying off as the real thing and lying where it lands. Wounded bodies, their pieces and their gut are drawn by
 * `FleshRenderer` and `GutsRenderer`; organ, brain and bone by `Organs`.
 */
export class FleshFx {
  readonly renderer: FleshRenderer;
  readonly guts = new GutsRenderer();
  readonly organs: Organs;
  readonly pieces: Piece[] = [];
  readonly ropes: Rope[] = [];
  /** Bodies with flesh state: they drip, and their gut hangs from them. */
  private bodies = new Set<Zombie>();
  private drips = new WeakMap<Zombie, number>();
  /** Chains whose piece has been thrown, per body. */
  private thrown = new WeakMap<FleshState, number>();
  /** Counts for tests and the debug overlay. */
  stats = { hits: 0, pieces: 0, ropes: 0, broke: 0, bursts: 0, bisects: 0 };

  constructor(private ctx: Ctx, private gore: Gore) {
    this.renderer = new FleshRenderer(110);
    this.organs = new Organs({
      floorAt: (x, y, z) => this.floorAt(x, y, z),
      splat: (x, y, z, speed, kind) => {
        const s = Math.min(1, speed / 6);
        gore.groundSplat(x, z, (kind === 'bone' ? 0.12 : 0.22) + s * 0.25, CELL.splat0 + Math.floor(Math.random() * 4), 0.85, undefined, undefined, y);
        if (kind !== 'bone' && kind !== 'skull') ctx.fx.bloodSpray(x, y + 0.03, z, 0, 0.6, 0, 3, 1.5 + s * 2, 1);
        if (speed > 2.5) ctx.audio.play('squelch', x, z, 0.12 + s * 0.2, { pitch: 1.2 + Math.random() * 0.3 });
      },
      trail: (x, y, z) => ctx.fx.bloodSpray(x, y, z, 0, -0.3, 0, 1, 0.8, 0.6),
    });
  }

  attach(root: THREE.Object3D) {
    root.add(this.renderer.mesh);
    root.add(this.guts.group);
    root.add(this.organs.group);
  }

  private floorAt(x: number, y: number, z: number): number | null {
    const ctx = this.ctx;
    const r = ctx.P.raycast(x, y, z, 0, -1, 0, 3, RAY);
    const lift = ctx.terrain && (!r || r.normal.y > 0.7) ? roadLift(ctx.terrain, x, z) : 0;
    return (r ? y - r.toi : ctx.groundAt(x, z)) + lift;
  }

  // ------------------------------------------------------------------ between the world and the rest pose

  /** A world point into a body's rest pose (scale 1), and a rest-pose point back out (`toWorld`). */
  private toRest(zb: Zombie, x: number, y: number, z: number, lift: number): [number, number, number] {
    const c = Math.cos(zb.yaw);
    const s = Math.sin(zb.yaw);
    const sc = zb.def.scale;
    const wx = x - zb.x;
    const wz = z - zb.z;
    return [(wx * c - wz * s) / sc, (y - zb.y) / sc + lift, (wx * s + wz * c) / sc];
  }

  private toWorld(zb: Zombie, lx: number, ly: number, lz: number, out: THREE.Vector3): THREE.Vector3 {
    const c = Math.cos(zb.yaw);
    const s = Math.sin(zb.yaw);
    const sc = zb.def.scale;
    return out.set(zb.x + (lx * c + lz * s) * sc, zb.y + ly * sc, zb.z + (-lx * s + lz * c) * sc);
  }

  private dirWorld(zb: Zombie, nx: number, ny: number, nz: number, out: THREE.Vector3): THREE.Vector3 {
    const c = Math.cos(zb.yaw);
    const s = Math.sin(zb.yaw);
    return out.set(nx * c + nz * s, ny, -nx * s + nz * c);
  }

  /** How far a crawling body (legs gone) lies below where it would stand. */
  private lying(zb: Zombie): number {
    const p = this.ctx.zombies.poseOf(zb);
    return (zb.y - p.y) / zb.def.scale;
  }

  // ------------------------------------------------------------------ bodies lying where they fell

  /**
   * Which part of a body a world point is nearest, and where it is on that part in the rest pose: the part's own pose this
   * frame run backwards. For the dead lying in whatever heap their fall left them in, where height means nothing.
   */
  locate(zb: Zombie, x: number, y: number, z: number, dx = 0, dy = -1, dz = 0): Located {
    const pose = this.ctx.zombies.poseOf(zb);
    const f = zb.flesh;
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < REFS.length; i++) {
      const [part, rx, ry, rz, zone] = REFS[i];
      // Not what is no longer there.
      if (f) {
        if (zone === 'head' && f.cut[4] > 0 && f.cut[4] < 1.6) continue;
        if (zone !== 'head' && zone !== 'torso' && f.cut[CHAINS.indexOf(zone)] > ry) continue;
        if (f.cut[5] > 0 && (zone === 'legL' || zone === 'legR' || (zone === 'torso' && ry < f.cut[5]))) continue;
      }
      const w = this.renderer.worldPoint(pose, part, rx, ry, rz, _v);
      const d = (w.x - x) ** 2 + (w.y - y) ** 2 + (w.z - z) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    const [part, , ry, , zone] = REFS[best];
    const inv = this.renderer.partWorld(pose, part, ry, _m).invert();
    const p = _v.set(x, y, z).applyMatrix4(inv);
    const d = _w.set(dx, dy, dz).transformDirection(inv);
    return { zone, part, x: p.x, y: p.y, z: p.z, dx: d.x, dy: d.y, dz: d.z };
  }

  /**
   * Where a settled body lies: its head, its middle and its feet in the world, for rounds and blades to find it. Worked out
   * once it has stopped moving.
   */
  lie(zb: Zombie): Float32Array {
    if (zb.lie) return zb.lie;
    const pose = this.ctx.zombies.poseOf(zb);
    const r = this.renderer;
    const l = new Float32Array(9);
    const put = (o: number, v: THREE.Vector3) => l.set([v.x, v.y, v.z], o);
    put(0, r.worldPoint(pose, 9, 0, 1.7, 0.02, _v));
    put(3, r.worldPoint(pose, 0, 0, 1.0, 0, _v));
    const a = r.worldPoint(pose, 3, 0.11, 0.12, 0, _v).clone();
    const b = r.worldPoint(pose, 4, -0.11, 0.12, 0, _w);
    put(6, a.add(b).multiplyScalar(0.5));
    zb.lie = l;
    return l;
  }

  // ------------------------------------------------------------------ a blow

  /** A blow landed on one of the dead: what it does under the skin, and everything that comes of it. */
  hit(zb: Zombie, o: FleshHit): FleshEvents {
    const ctx = this.ctx;
    const f = (zb.flesh ??= newFlesh());
    this.bodies.add(zb);
    const [lx, ly, lz] = o.rest ? [o.rest.x, o.rest.y, o.rest.z] : this.toRest(zb, o.x, o.y, o.z, zb.dead ? 0 : this.lying(zb));
    const c = Math.cos(zb.yaw);
    const s = Math.sin(zb.yaw);
    const dl = Math.hypot(o.dx, o.dy, o.dz) || 1;
    const ev = injure(f, {
      inj: injuryOf(o.key), power: o.power, zone: o.zone, x: lx, y: ly, z: lz,
      dx: o.rest ? o.rest.dx : (o.dx * c - o.dz * s) / dl, dy: o.rest ? o.rest.dy : o.dy / dl, dz: o.rest ? o.rest.dz : (o.dx * s + o.dz * c) / dl,
      through: o.through, killed: o.killed, off: o.off, cutDepth: o.cutDepth, cutThrough: o.cutThrough, time: ctx.time, rng: () => ctx.rng.next(),
    });
    this.stats.hits++;
    this.effects(zb, ev, o);
    return ev;
  }

  /** What comes out: the far side of a wound, bone, brain, the gut. */
  private effects(zb: Zombie, ev: FleshEvents, o: FleshHit) {
    const ctx = this.ctx;
    const f = zb.flesh!;
    const sc = zb.def.scale;
    const p = Math.max(0.2, Math.min(3, o.power));
    const dl = Math.hypot(o.dx, o.dz) || 1;
    const ux = o.dx / dl;
    const uz = o.dz / dl;
    const skin = SKIN[zb.kind];
    if (ev.exit) {
      // Blown out of the far side: a wet cone of blood and meat, and the wall behind painted with it.
      const at = this.toWorld(zb, ev.exit.x, ev.exit.y, ev.exit.z, _v);
      const n = this.dirWorld(zb, ev.exit.nx, ev.exit.ny, ev.exit.nz, _w);
      ctx.fx.bloodSpray(at.x, at.y, at.z, n.x * 0.5 + ux * 0.6, 0.15, n.z * 0.5 + uz * 0.6, 6 + Math.round(p * 4), 5 + p * 2, 0.45);
      for (let i = 0; i < Math.min(6, ev.meat); i++) this.meat(at, ux * (2 + p * 2), uz * (2 + p * 2));
      if (ev.exit.y > 1.6) this.brain(at, ux, uz, 1 + Math.round(p));
    }
    for (let i = 0; i < Math.min(4, ev.splinters); i++) {
      const at = this.toWorld(zb, ev.entry.x, ev.entry.y, ev.entry.z, _v);
      this.organs.throw('bone', at.x, at.y, at.z, ux * (1 + Math.random() * 2) + (Math.random() - 0.5) * 2, 1 + Math.random() * 2.5, uz * (1 + Math.random() * 2) + (Math.random() - 0.5) * 2, 0.6 + Math.random() * 0.6, 0.86, 0.8, 0.68);
    }
    if (ev.broke.length || ev.compound.length) {
      const at = this.toWorld(zb, ev.entry.x, ev.entry.y, ev.entry.z, _v);
      this.stats.broke += ev.broke.length;
      ctx.audio.play('boneCrack', at.x, at.z, ev.compound.length ? 0.85 : 0.6, { pitch: 1.05 + Math.random() * 0.35, intensity: Math.min(1, p) });
      if (ev.compound.length) {
        ctx.fx.bloodSpray(at.x, at.y, at.z, ux, 0.3, uz, 6, 3.5, 0.6);
        ctx.audio.play('squelch', at.x, at.z, 0.4);
      }
    }
    if (ev.head) {
      const head = this.toWorld(zb, 0, 1.72, 0.02, _w).clone();
      switch (ev.head) {
        case 'crushed':
          ctx.audio.play('boneCrack', head.x, head.z, 0.9, { pitch: 0.85 + Math.random() * 0.2, intensity: 1 });
          ctx.audio.play('squelch', head.x, head.z, 0.5, { pitch: 0.8 });
          // Out of the nose, the ears, the eyes.
          ctx.fx.bloodSpray(head.x, head.y - 0.05, head.z, ux * 0.3, 0.4, uz * 0.3, 10, 2.5, 0.9);
          break;
        case 'burst': {
          this.stats.bursts++;
          ctx.audio.play('squelch', head.x, head.z, 1, { pitch: 0.75, intensity: 1 });
          ctx.audio.play('boneCrack', head.x, head.z, 0.8, { pitch: 0.75 + Math.random() * 0.2, intensity: 1 });
          ctx.fx.bloodSpray(head.x, head.y, head.z, ux, 0.45, uz, 22, 6 + p * 1.5, 0.75);
          ctx.fx.bloodSpray(head.x, head.y, head.z, 0, 1, 0, 10, 4, 1);
          this.gore.flesh(head.x, head.y, head.z, ux, 0.05, uz, 2.6);
          this.brain(head, ux, uz, 4 + Math.round(p));
          for (let i = 0; i < 6; i++) {
            const k = 2 + Math.random() * 4;
            const t = Math.random() < 0.5 ? skin : ([0.82, 0.76, 0.62] as const);
            this.organs.throw('skull', head.x, head.y + 0.05, head.z, ux * k + (Math.random() - 0.5) * 4, 1.5 + Math.random() * 3, uz * k + (Math.random() - 0.5) * 4, (0.5 + Math.random() * 0.5) * sc, t[0], t[1], t[2]);
          }
          if (Math.random() < 0.8) this.organs.throw('eye', head.x, head.y, head.z, ux * 3 + (Math.random() - 0.5) * 3, 2 + Math.random() * 2, uz * 3 + (Math.random() - 0.5) * 3, sc, 1, 1, 1);
          for (let i = 0; i < 5; i++) this.meat(head, ux * 4, uz * 4);
          break;
        }
        case 'split':
          ctx.audio.play('boneCrack', head.x, head.z, 0.9, { pitch: 0.7, intensity: 1 });
          ctx.audio.play('squelch', head.x, head.z, 0.6);
          ctx.fx.bloodSpray(head.x, head.y + 0.08, head.z, 0, 1, 0, 12, 3.5, 0.8);
          this.brain(head, ux, uz, 2);
          break;
        default:
          break;
      }
    }
    if (ev.bisect) {
      // In two: the legs and hips go over on their own, and both halves pour out what was between them.
      this.stats.bisects++;
      const waist = this.toWorld(zb, 0, ev.bisect, 0.02, _v).clone();
      ctx.audio.play('squelch', waist.x, waist.z, 1, { pitch: 0.7, intensity: 1 });
      ctx.audio.play('gutSpill', waist.x, waist.z, 0.9);
      ctx.fx.bloodSpray(waist.x, waist.y, waist.z, ux, 0.1, uz, 26, 6, 1.1);
      this.gore.groundSplat(waist.x + ux * 0.5, waist.z + uz * 0.5, 1.3 * sc, CELL.pool, 0.9, undefined, undefined, waist.y);
      const legs = this.spawnPiece(zb, 'waist', ev.bisect, ux * 0.4, 0, uz * 0.4, 0.4);
      for (let i = 0; i < 3; i++) this.organ(waist, ux, uz, i === 0 ? 'organ' : 'gut', i === 0 ? [0.34, 0.08, 0.07] : [0.75, 0.5, 0.44]);
      this.spill(zb, null, [0, ev.bisect - 0.02, 0.03], 2);
      if (legs) this.spill(null, legs, [0, ev.bisect + 0.01, 0.03], 1);
    } else if (ev.spill && f.open) {
      const at = this.toWorld(zb, f.open.x, f.open.y, f.open.z, _v).clone();
      ctx.audio.play('gutSpill', at.x, at.z, 0.8);
      ctx.audio.play('squelch', at.x, at.z, 0.6, { pitch: 0.85 });
      ctx.fx.bloodSpray(at.x, at.y, at.z, ux * 0.5, -0.2, uz * 0.5, 12, 3, 0.8);
      this.gore.groundSplat(at.x, at.z, 0.9 * sc, CELL.pool, 0.88, undefined, undefined, at.y);
      if (Math.random() < 0.6) this.organ(at, ux, uz, 'gut', [0.76, 0.5, 0.44]);
      this.spill(zb, null, [f.open.x * 0.85, f.open.y, f.open.z * 0.85], 2);
    }
  }

  private meat(at: THREE.Vector3, vx: number, vz: number) {
    this.gore.gibs.throw('chunk', at.x, at.y, at.z, vx * (0.5 + Math.random()) + (Math.random() - 0.5) * 2.5, 1 + Math.random() * 2.5, vz * (0.5 + Math.random()) + (Math.random() - 0.5) * 2.5,
      0.5 + Math.random() * 0.8, 0.3 + Math.random() * 0.15, 0.025, 0.02, true);
  }

  private brain(at: THREE.Vector3, ux: number, uz: number, n: number) {
    for (let i = 0; i < n; i++) {
      const k = 1.5 + Math.random() * 3.5;
      const sh = 0.8 + Math.random() * 0.3;
      // Pink-grey, streaked with blood.
      this.organs.throw('brain', at.x, at.y, at.z, ux * k + (Math.random() - 0.5) * 3, 1 + Math.random() * 2.5, uz * k + (Math.random() - 0.5) * 3, 0.5 + Math.random() * 0.7, 0.66 * sh, 0.36 * sh, 0.34 * sh);
    }
  }

  private organ(at: THREE.Vector3, ux: number, uz: number, kind: OrganKind, col: readonly [number, number, number]) {
    const k = 1 + Math.random() * 2;
    this.organs.throw(kind, at.x, at.y, at.z, ux * k + (Math.random() - 0.5) * 2, 0.5 + Math.random() * 2, uz * k + (Math.random() - 0.5) * 2, 0.8 + Math.random() * 0.5, col[0], col[1], col[2]);
  }

  /**
   * Something came off: the damage rules took it (`ballistics.wound`), this throws it as the piece of the body it is and
   * leaves the stump spraying. A head burst or split by the blow has nothing left to throw.
   */
  sever(zb: Zombie, zone: Exclude<Zone, 'torso'>, dx: number, dy: number, dz: number, power: number) {
    const ctx = this.ctx;
    const f = (zb.flesh ??= newFlesh());
    this.bodies.add(zb);
    const sc = zb.def.scale;
    let chain: Chain;
    if (zone === 'head') {
      // Torn off by a blast or a car rather than cut: at the neck.
      if (f.head === 'whole' || f.head === 'crushed') {
        f.head = 'off';
        f.cut[4] = NECK_CUT;
        f.rag[4] = 1;
        f.version++;
      }
      chain = 'neck';
    } else {
      chain = zone as LimbChain;
      const i = chainIndex(chain);
      if (f.cut[i] === 0) {
        f.cut[i] = CUT_RANGE[chain][1] - Math.random() * 0.06;
        f.rag[i] = 1;
        f.version++;
      }
    }
    const ci = chainIndex(chain);
    const y = f.cut[ci];
    const p = Math.max(0.4, Math.min(3, power));
    const done = this.thrown.get(f) ?? 0;
    const whole = chain !== 'neck' || f.head === 'off' || f.head === 'sliced';
    if (!(done & (1 << ci)) && whole) {
      this.thrown.set(f, done | (1 << ci));
      this.spawnPiece(zb, chain, y, dx * (3 + p * 2.6), 2.2 + Math.random() * 2.4 + dy * 1.5, dz * (3 + p * 2.6), p);
    }
    // The stump: a spray now, pumping for a few seconds after.
    let lx = 0;
    let lz = 0.02;
    if (chain !== 'neck') {
      const a = limbAt(chain as LimbChain, y);
      lx = a.x;
      lz = a.z;
    }
    const at = this.toWorld(zb, lx, y, lz, _v);
    ctx.fx.bloodSpray(at.x, at.y, at.z, dx, 0.6, dz, 8 + Math.round(p * 5), 5 + p * 2, 0.8);
    ctx.fx.bloodSpray(at.x, at.y, at.z, 0, 1, 0, 4, 3, 0.7);
    for (let i = 0; i < 2 + Math.round(p); i++) this.meat(at, dx * 3, dz * 3);
    ctx.audio.play('squelch', at.x, at.z, 0.55, { pitch: 0.9 + Math.random() * 0.25 });
    ctx.audio.play('thud', at.x, at.z, 0.35);
    this.gore.groundSplat(at.x, at.z, 0.9 + p * 0.3, CELL.splat0 + Math.floor(Math.random() * 4), 0.9, dx, dz, at.y);
    const c = Math.cos(zb.yaw);
    const s = Math.sin(zb.yaw);
    void c;
    void s;
    this.gore.bleed(zb, lx * sc, y * sc, lz * sc, chain === 'neck' ? 3.2 : 2.4, p, dx, dz, chain === 'neck');
  }

  /** Throw a piece of a body: `chain`'s side of a cut at rest-pose height `y`, starting where the body has it now. */
  private spawnPiece(zb: Zombie, chain: Chain, y: number, vx: number, vy: number, vz: number, power: number): Piece | null {
    const f = zb.flesh;
    if (!f) return null;
    const pc = pieceOf(chain, y);
    const pose = this.ctx.zombies.poseOf(zb);
    // The part the middle of the piece sits in, and its transform this frame.
    const part = chain === 'neck' ? 9 : chain === 'waist' ? 0 : chain === 'armL' ? (pc.cy > 1.14 ? 5 : 7) : chain === 'armR' ? (pc.cy > 1.14 ? 6 : 8)
      : chain === 'legL' ? (pc.cy > 0.52 ? 1 : 3) : (pc.cy > 0.52 ? 2 : 4);
    this.renderer.partWorld(pose, part, pc.cy, _m);
    const pos = new THREE.Vector3(pc.cx, pc.cy, pc.cz).applyMatrix4(_m);
    const quat = new THREE.Quaternion();
    _m.decompose(_a, quat, _s);
    const long = chain !== 'neck';
    const w = chain === 'waist' ? 3 : 7 + power * 3;
    const piece: Piece = {
      kind: zb.kind, scale: zb.def.scale, variant: zb.variant, chain: chainIndex(chain), f: copyFlesh(f),
      c: [pc.cx, pc.cy, pc.cz], h: [pc.hx, pc.hy, pc.hz], pos, vel: new THREE.Vector3(vx, vy, vz), quat,
      spin: new THREE.Vector3((Math.random() - 0.5) * w, (Math.random() - 0.5) * w, (Math.random() - 0.5) * w),
      rest: false, age: 0, bleed: chain === 'waist' ? 9 : 5, trailT: 0, long,
    };
    if (chain === 'waist') {
      // The legs go over backwards or forwards, not spinning off through the air.
      piece.spin.set(Math.cos(zb.yaw) * (Math.random() < 0.5 ? 2.5 : -2.5), 0, -Math.sin(zb.yaw) * 2.5);
    }
    if (this.pieces.length >= MAX_PIECES) this.dropPiece(0);
    this.pieces.push(piece);
    this.stats.pieces++;
    return piece;
  }

  private dropPiece(i: number) {
    const gone = this.pieces[i];
    for (const r of this.ropes) if (r.piece === gone) r.attached = false;
    this.pieces.splice(i, 1);
  }

  /** The gut comes out of a body (or a lower half): `n` lengths of it, from a rest-pose point. */
  private spill(body: Zombie | null, piece: Piece | null, root: [number, number, number], n: number) {
    const ctx = this.ctx;
    const at = this.ropeRoot({ body, piece, root } as Rope, _v);
    if (!at) return;
    for (let k = 0; k < n; k++) {
      const small = k !== 1;
      // Coils of it: the small gut a long rope of it, the large a thicker, shorter loop; both reach the ground.
      const nodes = small ? 25 + Math.floor(Math.random() * 7) : 18 + Math.floor(Math.random() * 4);
      const seg = small ? 0.055 : 0.065;
      const rope: Rope = {
        n: nodes, seg, r: small ? 0.017 : 0.024, col: small ? [0.6, 0.34, 0.31] : [0.48, 0.25, 0.22],
        rad: Float32Array.from({ length: nodes }, () => 0.8 + Math.random() * 0.5),
        blood: Float32Array.from({ length: nodes }, (_, i) => Math.min(1, Math.random() * 0.7 + (i < 4 ? 0.5 : 0))),
        lumps: Float32Array.from({ length: 24 }, (_, i) => (i % 4 === 3 ? 0.9 + Math.random() * 0.7 : (Math.random() - 0.5) * 0.07)),
        x: new Float32Array(nodes), y: new Float32Array(nodes), z: new Float32Array(nodes),
        px: new Float32Array(nodes), py: new Float32Array(nodes), pz: new Float32Array(nodes),
        body, piece, root: [root[0] + (Math.random() - 0.5) * 0.04, root[1] - k * 0.015, root[2]], attached: true, age: 0,
        floor: this.floorAt(at.x, at.y + 0.3, at.z) ?? ctx.groundAt(at.x, at.z), floorT: 0, smearT: 0,
        gy: new Float32Array(nodes).fill(-1e9),
        curl: (Math.random() < 0.5 ? -1 : 1) * (0.7 + Math.random() * 0.6),
      };
      // Out of the opening and down: the first frames give it the speed it slides out with.
      const out = body ? this.dirWorld(body, 0, 0, 1, _w) : _w.set(0, 1, 0);
      const vx = out.x * 0.7 + (Math.random() - 0.5) * 0.8;
      const vz = out.z * 0.7 + (Math.random() - 0.5) * 0.8;
      for (let i = 0; i < nodes; i++) {
        // Bunched up as it comes out, in loops that fall open as it slides.
        const t = i * seg * 0.3;
        const a = i * 1.7 + k * 2;
        rope.x[i] = at.x + out.x * t + Math.cos(a) * 0.04;
        rope.y[i] = at.y - t * 0.5;
        rope.z[i] = at.z + out.z * t + Math.sin(a) * 0.04;
        rope.px[i] = rope.x[i] - vx / 60;
        rope.py[i] = rope.y[i] + 0.5 / 60;
        rope.pz[i] = rope.z[i] - vz / 60;
      }
      if (this.ropes.length >= MAX_ROPES) this.ropes.shift();
      this.ropes.push(rope);
      this.stats.ropes++;
    }
  }

  /** Where a length of gut hangs from this frame, or null once what held it is gone. */
  private ropeRoot(r: Pick<Rope, 'body' | 'piece' | 'root'>, out: THREE.Vector3): THREE.Vector3 | null {
    if (r.body) {
      if (r.body.gone) return null;
      return this.renderer.worldPoint(this.ctx.zombies.poseOf(r.body), 0, r.root[0], r.root[1], r.root[2], out);
    }
    if (r.piece) {
      const pc = r.piece;
      _s.set(pc.scale, pc.scale, pc.scale);
      _m.compose(pc.pos, pc.quat, _s);
      return out.set(r.root[0] - pc.c[0], r.root[1] - pc.c[1], r.root[2] - pc.c[2]).applyMatrix4(_m);
    }
    return null;
  }

  // ------------------------------------------------------------------ per tick

  update(dt: number) {
    if (dt <= 0) return;
    this.organs.update(dt);
    this.stepPieces(Math.min(dt, 0.1));
    this.stepRopes(Math.min(dt, 1 / 20));
    // The wounded leave a trail: drops at their feet while they still walk about bleeding.
    for (const zb of this.bodies) {
      if (zb.gone) {
        this.bodies.delete(zb);
        continue;
      }
      if (zb.dead || !zb.flesh) continue;
      let open = 0;
      for (const w of zb.flesh.wounds) if (w.depth > 0.3) open += w.r + w.len;
      if (zb.flesh.spilled) open += 0.1;
      if (open <= 0) continue;
      const t = (this.drips.get(zb) ?? Math.random()) - dt;
      if (t > 0) {
        this.drips.set(zb, t);
        continue;
      }
      this.drips.set(zb, Math.max(0.25, 1.4 - open * 6) * (0.6 + Math.random() * 0.8));
      this.gore.drip(zb.x + (Math.random() - 0.5) * 0.4, zb.z + (Math.random() - 0.5) * 0.4, 0.12 + Math.min(0.2, open));
    }
  }

  private stepPieces(dt: number) {
    const ctx = this.ctx;
    const steps = Math.ceil(dt * 120);
    const h = dt / steps;
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const pc = this.pieces[i];
      pc.age += dt;
      if (pc.age > LINGER) {
        // Sinks away into the ground, as the old bodies did.
        pc.pos.y -= dt * 0.25;
        if (pc.age > LINGER + 2) this.dropPiece(i);
        continue;
      }
      // Blood pours from the cut while it flies, and drips while it lies there.
      if (pc.bleed > 0) {
        pc.bleed -= dt;
        pc.trailT -= dt;
        if (pc.trailT <= 0) {
          pc.trailT = pc.rest ? 0.5 + Math.random() * 0.5 : 0.06;
          const cap = this.capWorld(pc, _v);
          if (pc.rest) this.gore.drip(cap.x + (Math.random() - 0.5) * 0.1, cap.z + (Math.random() - 0.5) * 0.1, 0.18);
          else ctx.fx.bloodSpray(cap.x, cap.y, cap.z, -pc.vel.x * 0.05, 0.1, -pc.vel.z * 0.05, 1, 1.2, 0.6);
        }
      }
      if (pc.rest) continue;
      const floor = this.floorAt(pc.pos.x, pc.pos.y + 0.6, pc.pos.z);
      for (let s = 0; s < steps && !pc.rest; s++) {
        const w = pc.spin.length();
        if (w > 1e-4) {
          _qd.setFromAxisAngle(_a.copy(pc.spin).divideScalar(w), w * h);
          pc.quat.premultiply(_qd).normalize();
        }
        pc.vel.y -= 9.81 * h;
        pc.pos.addScaledVector(pc.vel, h);
        const support = this.support(pc);
        if (floor !== null && pc.pos.y - support <= floor) {
          pc.pos.y = floor + support;
          const impact = -pc.vel.y;
          if (impact > 1.8) {
            pc.vel.y = impact * 0.16;
            pc.vel.x *= 0.55;
            pc.vel.z *= 0.55;
            pc.spin.multiplyScalar(0.45);
            ctx.audio.play('thud', pc.pos.x, pc.pos.z, Math.min(0.5, impact * 0.08));
            if (pc.bleed > 0) this.gore.groundSplat(pc.pos.x, pc.pos.z, 0.35 + Math.min(0.4, impact * 0.06), CELL.splat0 + Math.floor(Math.random() * 4), 0.85, pc.vel.x, pc.vel.z, floor);
          } else {
            pc.vel.y = 0;
            const grip = Math.exp(-10 * h);
            pc.vel.x *= grip;
            pc.vel.z *= grip;
            pc.spin.multiplyScalar(Math.exp(-14 * h));
            let flat = true;
            if (pc.long) {
              // Lie down along the ground: tip the long axis level.
              _a.set(0, 1, 0).applyQuaternion(pc.quat);
              const level = _w.set(_a.x, 0, _a.z);
              if (level.lengthSq() < 1e-4) level.set(1, 0, 0);
              _qd.setFromUnitVectors(_a, level.normalize());
              _q.copy(pc.quat).premultiply(_qd);
              pc.quat.slerp(_q, 1 - Math.exp(-8 * h));
              pc.pos.y = floor + this.support(pc);
              flat = Math.abs(_a.y) < 0.05;
            }
            if (flat && pc.vel.lengthSq() < 0.01 && pc.spin.lengthSq() < 0.02) {
              pc.vel.set(0, 0, 0);
              pc.rest = true;
            }
          }
        }
      }
    }
  }

  /** Height of a piece's lowest point under its middle: its half extents turned with it. */
  private support(pc: Piece): number {
    const q = pc.quat;
    const s = pc.scale;
    return s * (Math.abs(2 * (q.x * q.y + q.z * q.w)) * pc.h[0] + Math.abs(1 - 2 * (q.x * q.x + q.z * q.z)) * pc.h[1] + Math.abs(2 * (q.y * q.z - q.x * q.w)) * pc.h[2]) * 0.8;
  }

  /** Where a piece's cut face is in the world. */
  private capWorld(pc: Piece, out: THREE.Vector3): THREE.Vector3 {
    const chain = CHAINS[pc.chain];
    const y = pc.f.cut[pc.chain];
    let x = 0;
    let z = 0.02;
    if (chain !== 'neck' && chain !== 'waist') {
      const a = limbAt(chain as LimbChain, y);
      x = a.x;
      z = a.z;
    }
    _s.set(pc.scale, pc.scale, pc.scale);
    _m.compose(pc.pos, pc.quat, _s);
    return out.set(x - pc.c[0], y - pc.c[1], z - pc.c[2]).applyMatrix4(_m);
  }

  private stepRopes(dt: number) {
    const ctx = this.ctx;
    const steps = 2;
    const h = dt / steps;
    const g = 9.81 * h * h;
    for (let k = this.ropes.length - 1; k >= 0; k--) {
      const r = this.ropes[k];
      r.age += dt;
      if (r.age > LINGER) {
        this.ropes.splice(k, 1);
        continue;
      }
      let rx = 0;
      let ry = 0;
      let rz = 0;
      if (r.attached) {
        const at = this.ropeRoot(r, _v);
        if (!at) r.attached = false;
        else {
          rx = at.x;
          ry = at.y;
          rz = at.z;
        }
      }
      r.floorT -= dt;
      if (r.floorT <= 0) {
        // The floor under where it hangs (a road, a floor indoors), and the ground under every node of it.
        r.floorT = 0.2 + Math.random() * 0.1;
        const ax = r.x[0];
        const az = r.z[0];
        r.floor = this.floorAt(ax, Math.max(r.y[0], r.floor) + 0.4, az) ?? ctx.groundAt(ax, az);
        for (let i = 0; i < r.n; i++) {
          const g = ctx.groundAt(r.x[i], r.z[i]);
          r.gy[i] = Math.abs(r.x[i] - ax) < 1.6 && Math.abs(r.z[i] - az) < 1.6 ? Math.max(r.floor, g) : g;
        }
      }
      const n = r.n;
      for (let s = 0; s < steps; s++) {
        for (let i = r.attached ? 1 : 0; i < n; i++) {
          const vx = (r.x[i] - r.px[i]) * 0.985;
          const vy = (r.y[i] - r.py[i]) * 0.985;
          const vz = (r.z[i] - r.pz[i]) * 0.985;
          r.px[i] = r.x[i];
          r.py[i] = r.y[i];
          r.pz[i] = r.z[i];
          r.x[i] += vx;
          r.y[i] += vy - g;
          r.z[i] += vz;
        }
        if (r.attached) {
          r.px[0] = r.x[0];
          r.py[0] = r.y[0];
          r.pz[0] = r.z[0];
          r.x[0] = rx;
          r.y[0] = ry;
          r.z[0] = rz;
        }
        for (let it = 0; it < 7; it++) {
          for (let i = 0; i < n - 1; i++) {
            const dx = r.x[i + 1] - r.x[i];
            const dy = r.y[i + 1] - r.y[i];
            const dz = r.z[i + 1] - r.z[i];
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
            const diff = (d - r.seg) / d;
            const pinned = i === 0 && r.attached;
            const a = pinned ? 0 : 0.5;
            const b = pinned ? 1 : 0.5;
            r.x[i] += dx * diff * a;
            r.y[i] += dy * diff * a;
            r.z[i] += dz * diff * a;
            r.x[i + 1] -= dx * diff * b;
            r.y[i + 1] -= dy * diff * b;
            r.z[i + 1] -= dz * diff * b;
          }
        }
        // The ground: it lies where it falls and drags heavy and wet, and as it piles up it folds over into loops
        // rather than lying out straight.
        const coil = r.age < 6 ? r.curl * 0.0016 * (1 - r.age / 6) : 0;
        for (let i = 0; i < n; i++) {
          const top = r.gy[i] + r.r * 0.8;
          if (coil && i > 0 && r.y[i] < top + r.r) {
            const ax = r.x[i] - r.x[i - 1];
            const az = r.z[i] - r.z[i - 1];
            const al = Math.hypot(ax, az) || 1;
            const k = coil * Math.sin(i * 0.55 + r.curl * 3);
            r.x[i] += (-az / al) * k;
            r.z[i] += (ax / al) * k;
          }
          if (r.y[i] < top) {
            r.y[i] = top;
            r.py[i] = top;
            r.px[i] = r.x[i] - (r.x[i] - r.px[i]) * 0.45;
            r.pz[i] = r.z[i] - (r.z[i] - r.pz[i]) * 0.45;
          }
        }
      }
      // Pulled too far, it tears loose from the body.
      if (r.attached && Math.hypot(r.x[1] - r.x[0], r.y[1] - r.y[0], r.z[1] - r.z[0]) > r.seg * 4) r.attached = false;
      // Dragged along the ground, it smears.
      r.smearT -= dt;
      if (r.smearT <= 0) {
        r.smearT = 0.35;
        const i = n - 1 - Math.floor(Math.random() * Math.min(5, n));
        const vx = (r.x[i] - r.px[i]) / h;
        const vz = (r.z[i] - r.pz[i]) / h;
        if (Math.hypot(vx, vz) > 0.35 && r.y[i] < ctx.groundAt(r.x[i], r.z[i]) + r.r * 2) this.gore.groundSplat(r.x[i], r.z[i], 0.16, CELL.spray, 0.55, vx, vz);
      }
    }
  }

  // ------------------------------------------------------------------ drawing

  /** Pieces into the wounded-body renderer (between its `begin` and `end`) and the gut into its own. */
  render() {
    const fr = this.renderer;
    for (const pc of this.pieces) fr.pushPiece(pc.kind, pc.scale, pc.variant, pc.chain, pc.f, pc.pos, pc.quat, pc.c[0], pc.c[1], pc.c[2]);
    const gr = this.guts;
    gr.begin();
    for (const r of this.ropes) {
      const [cr, cg, cb] = r.col;
      for (let i = 0; i < r.n; i++) {
        // Pink-grey and lumpy, smeared dark with blood in patches and most where it came out.
        const bl = r.blood[i];
        const red = (c: number, to: number) => c + (to - c) * bl * 0.75;
        const rr = r.r * r.rad[i];
        if (i < r.n - 1) {
          const bn = r.blood[i + 1];
          const m = (bl + bn) / 2;
          gr.segment(r.x[i], r.y[i], r.z[i], r.x[i + 1], r.y[i + 1], r.z[i + 1], r.r * Math.min(r.rad[i], r.rad[i + 1]),
            cr + (0.42 - cr) * m * 0.75, cg + (0.07 - cg) * m * 0.75, cb + (0.06 - cb) * m * 0.75);
        }
        gr.knot(r.x[i], r.y[i], r.z[i], rr * 1.06, red(cr, 0.42), red(cg, 0.07), red(cb, 0.06));
      }
      // Where it hangs from the body, a mass of loops pushes out of the hole after it.
      if (r.attached) {
        const l = r.lumps;
        for (let j = 0; j < l.length; j += 4) {
          const k = 0.7 + 0.3 * (j / l.length);
          gr.knot(r.x[0] + l[j], r.y[0] + l[j + 1] * 0.7 - 0.01, r.z[0] + l[j + 2], r.r * l[j + 3] * 1.3, cr * k * 0.9, cg * k * 0.6, cb * k * 0.6);
        }
      }
    }
    gr.end();
  }

  /** The body with its flesh state drawn by `FleshRenderer` this frame, if there is room. */
  pushBody(zb: Zombie, pose: BodyPose, alpha: number): boolean {
    if (!zb.flesh || !this.renderer.room) return false;
    this.renderer.pushBody(pose, alpha, zb.flesh);
    return true;
  }

  clear() {
    this.pieces.length = 0;
    this.ropes.length = 0;
    this.bodies.clear();
    this.organs.clear();
  }

  dispose() {
    this.clear();
    this.organs.dispose();
    this.guts.dispose();
    this.renderer.innards.geometry.dispose();
    this.renderer.mesh.geometry.dispose();
    (this.renderer.mesh.material as THREE.Material).dispose();
    this.renderer.mesh.removeFromParent();
  }
}

export type { SurfacePoint };
void UP;
