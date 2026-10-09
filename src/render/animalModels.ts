import * as THREE from 'three';
import type { AnimalKind } from '../data';
import { bakedModel, HerdMesh, type ClipInfo } from './bakedModel';
import type { AnimalPose } from './animalRender';

/**
 * Wild animals drawn from licensed, rigged models (`public/models`, baked by `scripts/bake-models.mjs`): the mammals with
 * their own animations, the rest auto-rigged with generated ones. A bird has two models, one standing and one in the air.
 * A species whose model is missing keeps its procedural body (`animalRender.ts`).
 */

interface Species {
  /** Standing / walking model. */
  ground: string;
  /** The same bird on the wing, and its wingspan (m) and colour (a flyer shared between species takes theirs). */
  flyer?: string;
  span?: number;
  fly?: [number, number, number];
}

export const ANIMAL_MODELS: Record<AnimalKind, Species> = {
  hare: { ground: 'animal-hare' },
  deer: { ground: 'animal-deer' },
  dog: { ground: 'animal-dog' },
  wolf: { ground: 'animal-wolf' },
  boar: { ground: 'animal-boar' },
  bear: { ground: 'animal-bear' },
  ibex: { ground: 'animal-ibex' },
  camel: { ground: 'animal-camel' },
  fox: { ground: 'animal-fox' },
  jackal: { ground: 'animal-jackal' },
  buffalo: { ground: 'animal-buffalo' },
  vulture: { ground: 'bird-vulture', flyer: 'flyer-brown', span: 2.4 },
  crow: { ground: 'bird-crow', flyer: 'flyer-dark', span: 0.95 },
  // Heron and egret on the wing are their own bodies, posed for flight (neck folded, legs trailing); the stork flies as the gull.
  heron: { ground: 'bird-heron', flyer: 'flyer-heron', span: 1.75 },
  stork: { ground: 'bird-stork', flyer: 'flyer-gull', span: 1.9, fly: [1, 1, 1] },
  egret: { ground: 'bird-egret', flyer: 'flyer-egret', span: 0.95 },
  duck: { ground: 'bird-duck', flyer: 'flyer-gull', span: 0.9, fly: [0.52, 0.44, 0.32] },
};

/** Every model the animals use, for the loader. */
export const ANIMAL_MODEL_NAMES = [...new Set(Object.values(ANIMAL_MODELS).flatMap((s) => [s.ground, ...(s.flyer ? [s.flyer] : [])]))];

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const TAU = Math.PI * 2;
const sstep = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const wrap = (v: number) => v - Math.floor(v);
/** A repeatable 0..1 from two integers. */
const hash = (a: number, b: number) => wrap(Math.sin(a * 127.1 + b * 311.7) * 43758.5453);

/** One species' herd: its ground model and, for a bird, its flyer (shared flyers are separate meshes per species). */
export class AnimalHerd {
  readonly ground: HerdMesh;
  readonly flyer: HerdMesh | null;
  private clip: Record<string, ClipInfo | null>;
  private fclip: Record<string, ClipInfo | null>;
  /** Every take of each move (`idle`, `idle.1` ...) on the ground model and on the flyer. */
  private takes: Record<string, ClipInfo[]> = {};
  private ftakes: Record<string, ClipInfo[]> = {};

  constructor(readonly kind: AnimalKind, max: number, group: THREE.Group) {
    const sp = ANIMAL_MODELS[kind];
    const g = bakedModel(sp.ground)!;
    this.ground = new HerdMesh(g.data, g.anim, { max, map: g.map });
    group.add(this.ground.mesh);
    const c = (h: HerdMesh, r: string) => h.clip(r);
    this.clip = Object.fromEntries(['idle', 'walk', 'run', 'eat', 'attack', 'death', 'rear', 'lie', 'swim', 'hit'].map((r) => [r, c(this.ground, r)]));
    const f = sp.flyer ? bakedModel(sp.flyer) : null;
    this.flyer = f ? new HerdMesh(f.data, f.anim, { max, map: f.map, side: THREE.DoubleSide }) : null;
    if (this.flyer) group.add(this.flyer.mesh);
    this.fclip = this.flyer ? { flap: this.flyer.clip('flap'), glide: this.flyer.clip('glide') } : {};
    const group_ = (clips: Record<string, ClipInfo>, out: Record<string, ClipInfo[]>) => {
      for (const [name, c] of Object.entries(clips)) (out[name.split('.')[0]] ??= []).push(c);
    };
    group_(g.data.clips, this.takes);
    if (f) group_(f.data.clips, this.ftakes);
  }

  /** An animal's own take of a move, the same every frame (null when the model has none). */
  private take(takes: Record<string, ClipInfo[]>, move: string, seed: number): ClipInfo | null {
    const list = takes[move];
    if (!list?.length) return null;
    return list[(Math.abs(seed) * 7 + move.length * 3) % list.length];
  }

  /** Both models are loaded. */
  static ready(kind: AnimalKind): boolean {
    const sp = ANIMAL_MODELS[kind];
    return !!bakedModel(sp.ground) && (!sp.flyer || !!bakedModel(sp.flyer));
  }

  begin() {
    this.ground.begin();
    this.flyer?.begin();
  }

  end() {
    this.ground.end();
    this.flyer?.end();
  }

  /**
   * The same arguments as `AnimalRenderer.push`. Gait blends idle, walk and run by `gait` with the legs on `phase`; a dead
   * one plays its death (or rolls over, for a model without one); grazing, attacking, rearing and bedding down play their
   * own clips over that; a bird with its wings spread switches to its flyer, flapping on `flap` or gliding.
   */
  push(scale: number, x: number, y: number, z: number, yaw: number, phase: number, gait: number, roll: number, flap: number, bank: number, tint: number, pose: AnimalPose, time: number) {
    const sp = ANIMAL_MODELS[this.kind];
    const C = this.clip;
    const dead = roll !== 0 || (pose.dying ?? 0) > 0;
    const inAir = !!this.flyer && !dead && (pose.fold ?? 1) < 0.5;
    const mask = pose.mask ?? 0;
    if (inAir) {
      const f = this.flyer!;
      const span = (sp.span ?? 1) * scale;
      _e.set(pose.pitch ?? 0, yaw, bank, 'YXZ');
      _m.compose(_p.set(x, y, z), _q.setFromEuler(_e), _s.set(span, span, span));
      const fc = sp.fly ?? [1, 1, 1];
      _c.setRGB(fc[0] * tint, fc[1] * tint, fc[2] * tint);
      const glide = pose.glide ?? 0;
      // Its own wingbeat and glide (some row deeper, some soar on a lean). Wing masks: the flyer's wings carry the same part
      // bits as the body's.
      const seed = pose.seed ?? 0;
      const flapClip = this.take(this.ftakes, 'flap', seed) ?? this.fclip.flap!;
      const glideClip = this.take(this.ftakes, 'glide', seed + 1) ?? this.fclip.glide;
      f.set(_m, flapClip, wrap(flap / TAU), glideClip, wrap(time / (glideClip?.dur ?? 3) + x * 0.1), glide, mask, _c);
      return;
    }
    // On the ground (or dead): body orientation; a model with a death clip lies down by itself.
    const death = C.death;
    const rollHere = dead && !death ? roll : 0;
    _e.set(pose.pitch ?? 0, yaw, rollHere, 'YXZ');
    _m.compose(_p.set(x, y, z), _q.setFromEuler(_e), _s.set(scale, scale, scale));
    _c.setScalar(tint);
    const h = this.ground;
    const seed = pose.seed ?? 0;
    if (dead && death) {
      const k = Math.min(1, Math.abs(roll) / ((Math.PI / 2) * 0.95));
      h.set(_m, this.take(this.takes, 'death', seed) ?? death, Math.max(k, pose.dying ?? 0), null, 0, 0, mask, _c);
      return;
    }
    // Locomotion: idle → walk → run. Standing, it mostly keeps its own idle and now and then falls into another for a
    // while (a look round, a nose to the ground), on a schedule of its own.
    const idle = this.take(this.takes, 'idle', seed) ?? C.idle!;
    const idles = this.takes.idle ?? [];
    let fidget: ClipInfo | null = null;
    let fidgetW = 0;
    if (idles.length > 1) {
      const slot = (time + seed * 1.37) / 9;
      const k = Math.floor(slot);
      const u = slot - k;
      const pick = hash(k, seed);
      if (pick < 0.55) {
        fidget = idles[Math.floor(hash(k + 101, seed) * idles.length)];
        if (fidget === idle) fidget = null;
        fidgetW = sstep(0, 0.15, u) * (1 - sstep(0.75, 0.95, u));
      }
    }
    const walk = C.walk ?? idle;
    const run = C.run ?? walk;
    const lp = wrap(phase / TAU);
    const ip = wrap(time / idle.dur + (x * 0.37 + z * 0.61));
    let A = idle, pa = ip, B: ClipInfo | null = null, pb = 0, wb = 0;
    if (fidget && fidgetW > 0.001 && gait <= 0.04) {
      B = fidget; pb = wrap(time / fidget.dur + seed * 0.29); wb = fidgetW;
    }
    if (gait > 0.04) {
      if (gait < 0.5 || run === walk) {
        A = idle; pa = ip; B = walk; pb = lp; wb = sstep(0.04, 0.35, gait);
      } else {
        A = walk; pa = lp; B = run; pb = lp; wb = sstep(0.5, 0.8, gait);
      }
    }
    // A duck on the water paddles.
    if (this.kind === 'duck' && C.swim && (pose.swim ?? 0) > 0.5) {
      A = C.swim; pa = wrap(time / C.swim.dur + x); B = null; wb = 0;
    }
    // What it is doing over its legs, strongest first.
    const atk = pose.attack ?? 0;
    const hit = pose.hit ?? 0;
    const lie = pose.lie ?? 0;
    const rear = pose.rear ?? 0;
    const head = pose.head ?? 0;
    if (atk > 0 && C.attack) {
      B = this.take(this.takes, 'attack', seed) ?? C.attack; pb = atk; wb = 1;
    } else if (hit !== 0 && this.takes.hit) {
      // A flinch away from the side it was hit on, over whatever it was doing.
      const side = this.takes.hit[hit > 0 ? 0 : Math.min(1, this.takes.hit.length - 1)];
      const k = Math.abs(hit);
      B = side; pb = k; wb = Math.min(1, Math.sin(Math.min(1, k) * Math.PI) * 1.3);
    } else if (lie > 0.02 && (C.lie || death)) {
      B = C.lie ?? death; pb = C.lie ? wrap(time / (C.lie.dur || 1)) : lie; wb = sstep(0, 0.8, lie);
    } else if (rear > 0.05 && C.rear) {
      B = C.rear; pb = wrap(time / C.rear.dur); wb = sstep(0.05, 0.6, rear);
    } else if (head > 0.25 && C.eat && gait < 0.4) {
      B = C.eat; pb = wrap(time / C.eat.dur + x * 0.3); wb = sstep(0.25, 0.75, head) * (1 - sstep(0.1, 0.4, gait));
    }
    h.set(_m, A, pa, B, pb, wb, mask, _c);
  }

  dispose() {
    this.ground.dispose();
    this.flyer?.dispose();
  }
}
