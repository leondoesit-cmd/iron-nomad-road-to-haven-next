import * as THREE from 'three';
import { MeshBuilder, S } from './builder';
import { C } from './palette';
import { clamp, clamp01, damp, lerp } from '../core/math';
import { GUN_BASE, GUN_POINTS, curve } from '../sim/weaponanim';
import type { GunModel } from '../data/gear';
import { shared } from './dispose';
import { kitMaterial } from './materials';
import { DEFAULT_LOOK, drawUpperArm, sleeveColor } from './outfit';
import { weaponGeometry, type Held, type Humanoid, type Palette } from './humanoid';
import { MuzzleFlash } from './muzzleFlash';

/**
 * The owner's own arms and weapon in first person, drawn the way a body camera sees them: two whole arms from shoulders
 * just below and behind the eye, gloved hands closed round the grips, the gun low in the middle of the frame. It lives in
 * the camera's space, so it sits the same on screen whichever way the view is turned, and the forearms run off the bottom
 * edge instead of ending in mid-air. On top of the held pose go the body's movements: the gun trails a turn, rocks with
 * the steps, cants into a sidestep, drops at a landing, kicks with a shot and breathes at rest.
 *
 * The third-person rig in `humanoid.ts` stays what a partner sees; this one is only ever drawn in its owner's view.
 */

const mat = kitMaterial();

type V3 = [number, number, number];

/** Shoulder to elbow, and elbow to wrist, metres. */
const UPPER = 0.3;
const FORE = 0.27;
/**
 * A hand's own frame has its origin in the middle of what it closes round, the line it closes round along x (toward the
 * thumb), the palm on the -z side facing +z, and the wrist up +y: here.
 */
const WRIST = new THREE.Vector3(0, 0.06, -0.036);
/** Camera space (x right, y up, -z ahead): shoulders a little behind and well below the eye, so the arms come up from out of frame. */
const SHOULDER_R = new THREE.Vector3(0.2, -0.27, 0.07);
const SHOULDER_L = new THREE.Vector3(-0.2, -0.27, 0.07);
const SHOULDER_L_LONG = new THREE.Vector3(-0.24, -0.36, 0.0);
/** How far the wrist bends off the line of the forearm, at most (radians). */
const WRIST_BEND = 0.5;
/** How far a hand rolls round its grip toward the forearm, and how far the forearm swings toward the hand, at most. */
const HAND_ROLL = 0.6;
const ARM_SWING = 0.55;
/** Elbows point out and down. */
const POLE_R = new THREE.Vector3(1, -0.75, 0.1).normalize();
const POLE_L = new THREE.Vector3(-1, -0.75, 0.1).normalize();
/** The hip-fire gun points at what the crosshair is on, this far out. */
const CONVERGE = 20;

/**
 * A hand on the weapon, in the weapon's own frame (+z down the barrel, +y up, +x to the weapon's left): the middle of what
 * the hand closes round, the line it closes round, and which way the palm faces onto it.
 */
interface Grip {
  p: V3;
  a: V3;
  n: V3;
  /** Where the thumb goes: round over the fingers, or straight ahead along the far side or the near side of the grip. */
  thumb: Thumb;
}

type Thumb = 'wrap' | 'far' | 'near';

interface Spec {
  /** Where the right hand's grip sits, camera space, at the hip (or at rest for a weapon with no sights). */
  hip: V3;
  /** Eye to the rear sight with the sights up, metres. 0: no sights, the weapon is held at `rest` instead. */
  ads: number;
  /** How the weapon is turned at rest when it has no sights: muzzle up, toward the middle, canted (camera-space radians). */
  rest?: V3;
  scale: number;
  r: Grip;
  /** The support hand on the weapon; absent, it stays down by the belt in a loose guard. */
  l?: Grip;
  /** A long gun shouldered: the support side's shoulder turns forward and in, behind the gun. */
  long?: boolean;
}

// Grips are read off the weapon models in `humanoid.ts`.
// The firing hand closes round the grip from its right side, palm onto it and a little forward, the thumb laid along the far
// side; the support hand wraps over it from the left, its thumb along the near side under the first; a fore-end is held
// from the left and below, the back of the hand showing.
const GRIP_R = (p: V3, a: V3): Grip => ({ p, a, n: [1, 0, 0.35], thumb: 'far' });
const PISTOL_L: Grip = { p: [0.013, -0.06, 0.045], a: [0, 0.97, -0.25], n: [-1, 0, 0.2], thumb: 'near' };
const UNDER = (z: number): Grip => ({ p: [0.026, -0.022, z], a: [0, 0, 1], n: [-1, 0.6, 0], thumb: 'near' });
const HANDLE = (z: number, n: V3 = [1, 0, 0]): Grip => ({ p: [0, 0, z], a: [0, 0, 1], n, thumb: 'wrap' });
const MELEE_REST: V3 = [1.05, 0.3, 0.12];

const DRAWN_SPECS: Partial<Record<Exclude<Held, 'none'>, Spec>> = {
  pistol: { hip: [0.075, -0.18, -0.33], ads: 0.38, scale: 1.12, r: GRIP_R([0, -0.045, 0.035], [0, 0.97, -0.25]), l: PISTOL_L },
  revolver: { hip: [0.075, -0.18, -0.33], ads: 0.38, scale: 1.1, r: GRIP_R([0, -0.05, 0.025], [0, 0.955, -0.3]), l: { ...PISTOL_L, p: [0.013, -0.064, 0.035] } },
  smg: { hip: [0.1, -0.24, -0.28], ads: 0.27, scale: 1.05, r: GRIP_R([0, -0.055, 0.035], [0, 0.98, -0.2]), l: UNDER(0.23), long: true },
  sawn: { hip: [0.1, -0.24, -0.27], ads: 0.28, scale: 1.05, r: GRIP_R([0, -0.04, -0.005], [0, 0.94, 0.34]), l: UNDER(0.13), long: true },
  pump: { hip: [0.11, -0.26, -0.23], ads: 0.27, scale: 1, r: GRIP_R([0, -0.045, 0.0], [0, 0.99, -0.15]), l: UNDER(0.32), long: true },
  rifle: { hip: [0.11, -0.26, -0.22], ads: 0.27, scale: 1, r: GRIP_R([0, -0.035, 0.01], [0, 0.98, 0.2]), l: UNDER(0.28), long: true },
  knife: { hip: [0.2, -0.25, -0.42], ads: 0, rest: [0.75, 0.35, 0.15], scale: 1.1, r: HANDLE(0) },
  bat: { hip: [0.16, -0.22, -0.36], ads: 0, rest: [1.2, 0.35, 0.25], scale: 1, r: HANDLE(0.17), l: HANDLE(0.06, [-1, 0, 0]) },
  machete: { hip: [0.2, -0.24, -0.4], ads: 0, rest: MELEE_REST, scale: 1, r: HANDLE(0) },
  axe: { hip: [0.16, -0.22, -0.36], ads: 0, rest: [1.15, 0.35, 0.25], scale: 1, r: HANDLE(0.1), l: HANDLE(-0.02, [-1, 0, 0]) },
  wrench: { hip: [0.2, -0.24, -0.4], ads: 0, rest: MELEE_REST, scale: 1, r: HANDLE(0.04) },
  crowbar: { hip: [0.2, -0.24, -0.4], ads: 0, rest: MELEE_REST, scale: 1, r: HANDLE(0.02) },
  flare: { hip: [0.2, -0.22, -0.42], ads: 0, rest: [0.35, 0.2, 0], scale: 1, r: HANDLE(0.07) },
  jerrycan: { hip: [0.24, -0.44, -0.3], ads: 0, rest: [0, 0.2, 0], scale: 1, r: { p: [0.05, 0.06, 0.06], a: [0, 0, 1], n: [0, -1, 0], thumb: 'wrap' } },
};

/** The hands were drawn for the six base guns and a few melee tools; every other model is held like the nearest of them. */
const MELEE_LIKE: Partial<Record<Exclude<Held, 'none'>, Exclude<Held, 'none'>>> = { pipe: 'bat', sledge: 'axe', katana: 'machete' };
const SPECS = {} as Record<Exclude<Held, 'none'>, Spec>;
for (const k of Object.keys(DRAWN_SPECS) as Exclude<Held, 'none'>[]) SPECS[k] = DRAWN_SPECS[k]!;
for (const m of Object.keys(GUN_BASE) as GunModel[]) SPECS[m] ??= DRAWN_SPECS[GUN_BASE[m]]!;
for (const [k, like] of Object.entries(MELEE_LIKE) as [Exclude<Held, 'none'>, Exclude<Held, 'none'>][]) SPECS[k] ??= DRAWN_SPECS[like]!;

/** Bare fists, for a punch. */
const FIST: Spec = { hip: [0.18, -0.3, -0.36], ads: 0, rest: [0, 0, 0], scale: 1, r: HANDLE(0) };

const isGun = (h: Held): h is GunModel => h === 'pistol' || h === 'revolver' || h === 'smg' || h === 'sawn' || h === 'pump' || h === 'rifle';

// ------------------------------------------------------------------------------------------- the arms' meshes

type Surf = ReturnType<typeof S.cloth>;

interface ArmGeo {
  upperR: THREE.BufferGeometry;
  upperL: THREE.BufferGeometry;
  fore: THREE.BufferGeometry;
  /** Hands by side (right, left) and thumb. */
  hand: Record<'r' | 'l', Record<Thumb, THREE.BufferGeometry>>;
  /** The left hand in a fist with the middle finger up. */
  bird: THREE.BufferGeometry;
}

const armCache = new Map<string, ArmGeo>();

/** A forearm for the close-up view: elbow at the origin, the sleeve bunching unevenly toward the cuff, the glove's cuff at the wrist (`FORE` down -y). */
function drawViewForearm(b: MeshBuilder, sleeve: Surf, glove: Surf) {
  b.limb(0, 0.02, 0, 0.003, -0.09, 0.002, 0.05, 0.051, sleeve, 14);
  b.limb(0.003, -0.09, 0.002, -0.002, -0.165, -0.002, 0.051, 0.046, sleeve, 14);
  b.limb(-0.002, -0.165, -0.002, 0, -0.228, 0, 0.047, 0.042, sleeve, 14);
  // A hem at the cuff, and the glove's own cuff coming out of it: oval, flatter through the hand than across it.
  b.torus(0, -0.224, 0, 0.041, 0.007, sleeve, Math.PI / 2, 0, 0, 6, 18);
  b.cyl(0, -0.243, 0, 0.068, 0.05, 0.054, glove, 0, 0, 0, 14);
}

/**
 * The middle finger's joints round a grip, in the hand's (y, z) plane: knuckle, then the ends of its three bones. The
 * knuckles sit out past the front corner of the grip; the first bone crosses the front strap, the second turns the far
 * corner, and the tip lies back along the far side. Laid out round a pistol grip (3 by 5 cm, the palm a little behind
 * it), which most grips and handles are near enough to.
 */
const FINGER: [number, number][] = [[-0.034, -0.035], [-0.035, 0.007], [-0.023, 0.031], [-0.004, 0.026]];
/** Per finger, index to little: across the hand (toward the thumb +), knuckle forward, length and thickness. */
const FINGERS = [
  { x: 0.0285, k: 0.001, l: 0.95, r: 0.0094 },
  { x: 0.0095, k: -0.001, l: 1, r: 0.0098 },
  { x: -0.0095, k: 0, l: 0.96, r: 0.0093 },
  { x: -0.0275, k: 0.004, l: 0.8, r: 0.0083 },
];
/**
 * The firing hand's index finger, off the grip and through the guard onto the trigger: along the side of the frame, then
 * curled in, its pad on the blade.
 */
const TRIGGER_FINGER: [number, number][] = [[-0.034, -0.035], [-0.069, -0.026], [-0.09, -0.011], [-0.088, 0.004]];
/** The middle finger held straight up out of the fist. */
const BIRD_FINGER: [number, number][] = [[-0.034, -0.035], [-0.078, -0.037], [-0.104, -0.036], [-0.125, -0.034]];
/** The others closed tight into the palm round nothing, and the thumb laid across them. */
const FIST_FINGER: [number, number][] = [[-0.034, -0.035], [-0.044, 0.004], [-0.02, 0.012], [-0.004, -0.006]];
const FIST_THUMB = { x: [0.62, 0.85, 0.45, 0.05], yz: [[0.03, -0.028], [0.0, -0.002], [-0.035, 0.012], [-0.05, 0.012]] as [number, number][] };
/** The thumb's bones from its root in the heel of the hand, by where it goes (`x` along the grip as a share of the hand's half-width). */
const THUMBS: Record<Thumb, { x: number[]; yz: [number, number][] }> = {
  // Over the back of the grip and forward along the far side, under the slide.
  far: { x: [0.62, 0.95, 1.05, 1.05], yz: [[0.03, -0.028], [0.034, 0.004], [0.006, 0.025], [-0.02, 0.031]] },
  // Straight ahead along the near side, under the other hand's thumb.
  near: { x: [0.62, 0.92, 1.02, 1.02], yz: [[0.036, -0.03], [0.012, -0.026], [-0.02, -0.019], [-0.046, -0.015]] },
  // Round the back of the handle and over the first two fingers.
  wrap: { x: [0.62, 0.9, 0.82, 0.62], yz: [[0.036, -0.03], [0.04, 0.004], [0.012, 0.036], [-0.012, 0.038]] },
};

/** The joints of a finger: the template's bends with its bones scaled by `l`, from a knuckle `k` further forward. */
function fingerJoints(tpl: [number, number][], x: number, k: number, l: number): V3[] {
  const out: V3[] = [[x, tpl[0][0] - k, tpl[0][1]]];
  for (let i = 1; i < tpl.length; i++) {
    const p = out[i - 1];
    out.push([x, p[1] + (tpl[i][0] - tpl[i - 1][0]) * l, p[2] + (tpl[i][1] - tpl[i - 1][1]) * l]);
  }
  return out;
}

/**
 * A gloved hand closed round a grip, in the hand's frame (see `WRIST`): an oval wrist, the back of the hand built over
 * its four bones so it tapers to the wrist and ridges at the knuckles, the pad at the heel of the thumb, four fingers
 * of different lengths that wrap the grip without going into it, and the thumb. `side` is 1 for the right hand, -1 for
 * the left: the thumb is at the -x end of the right hand's knuckles and the +x end of the left's. The firing hand
 * (`far`) has its index finger on the trigger.
 */
function drawViewHand(b: MeshBuilder, glove: Surf, fingers: Surf, side: number, thumb: Thumb, padded: boolean, bird = false) {
  const sx = -side;
  const half = 0.042;
  // The wrist, flatter through the hand than across it, running back into the forearm's cuff.
  b.add('sphere16', 0, WRIST.y, WRIST.z, 0.052, 0.07, 0.036, glove);
  b.add('sphere16', 0, WRIST.y - 0.018, WRIST.z, 0.058, 0.04, 0.04, glove);
  // The body of the hand: a flat core, the four bones fanning out from the wrist over its back, the heel of the hand
  // under the little finger and the thumb's pad.
  b.rbox(0, 0.008, -0.037, 0.076, 0.078, 0.026, 0.011, glove);
  for (let i = 0; i < 4; i++) {
    const f = FINGERS[i];
    b.limb(sx * f.x * 0.5, 0.03, -0.039, sx * f.x * 0.95, -0.03 - f.k, -0.04, 0.0085, 0.0108, glove, 10);
  }
  b.add('sphere16', -sx * 0.02, 0.026, -0.03, 0.034, 0.06, 0.03, glove);
  b.add('sphere16', sx * 0.025, 0.028, -0.026, 0.036, 0.052, 0.032, glove, 0, 0, sx * 0.35);
  if (padded) {
    b.rbox(0, 0.008, -0.053, 0.066, 0.05, 0.01, 0.004, S.metal(0x5a5e62, 0.4));
    for (const f of FINGERS) b.sphereAt(sx * f.x, -0.031 - f.k, -0.05, 0.007, S.metal(0x5a5e62, 0.4));
  }
  // Fingers, index to little, each in three tapering bones.
  for (let i = 0; i < 4; i++) {
    const f = FINGERS[i];
    const j = fingerJoints(bird ? (i === 1 ? BIRD_FINGER : FIST_FINGER) : i === 0 && thumb === 'far' ? TRIGGER_FINGER : FINGER, sx * f.x, f.k, f.l);
    b.limb(j[0][0], j[0][1], j[0][2], j[1][0], j[1][1], j[1][2], f.r * 1.08, f.r, i === 0 ? glove : fingers, 10);
    b.limb(j[1][0], j[1][1], j[1][2], j[2][0], j[2][1], j[2][2], f.r, f.r * 0.93, fingers, 10);
    b.limb(j[2][0], j[2][1], j[2][2], j[3][0], j[3][1], j[3][2], f.r * 0.93, f.r * 0.84, fingers, 10);
  }
  // The thumb: a thick root in the heel of the hand, then two bones.
  const t = bird ? FIST_THUMB : THUMBS[thumb];
  const pt = (i: number): V3 => [sx * half * t.x[i], t.yz[i][0], t.yz[i][1]];
  const [t0, t1, t2, t3] = [pt(0), pt(1), pt(2), pt(3)];
  b.limb(t0[0], t0[1], t0[2], t1[0], t1[1], t1[2], 0.016, 0.0118, glove, 10);
  b.limb(t1[0], t1[1], t1[2], t2[0], t2[1], t2[2], 0.0112, 0.0102, fingers, 10);
  b.limb(t2[0], t2[1], t2[2], t3[0], t3[1], t3[2], 0.0102, 0.0088, fingers, 10);
}

function viewArms(pal: Palette): ArmGeo {
  const key = JSON.stringify(pal);
  const hit = armCache.get(key);
  if (hit) return hit;
  const look = pal.look ?? DEFAULT_LOOK;
  const sleeve = S.cloth(sleeveColor(look.body, pal.jacket), 0.55);
  const skin = S.skin(pal.skin ?? C.skin);
  const hands = look.hands;
  const glove = hands.style === 'bare' ? skin : S.leather(hands.c ?? 0x2b2622, 0.4);
  const fingers = hands.style === 'bare' || hands.style === 'fingerless' ? skin : glove;
  const padded = hands.style === 'padded';
  const mk = (fn: (b: MeshBuilder) => void) => {
    const b = new MeshBuilder();
    b.jitter = 0.025;
    b.roundSeg = 2;
    fn(b);
    return shared(b.build());
  };
  const upper = (band: boolean) =>
    mk((b) => {
      b.sphereAt(0, 0, 0, 0.07, sleeve);
      drawUpperArm(b, look.body, sleeve);
      if (band && pal.band) b.torus(0, -0.12, 0, 0.066, 0.018, S.cloth(pal.band, 0.4), Math.PI / 2, 0, 0, 6, 12);
    });
  const hand = (side: number) => ({
    wrap: mk((b) => drawViewHand(b, glove, fingers, side, 'wrap', padded)),
    far: mk((b) => drawViewHand(b, glove, fingers, side, 'far', padded)),
    near: mk((b) => drawViewHand(b, glove, fingers, side, 'near', padded)),
  });
  const out: ArmGeo = {
    upperR: upper(false),
    upperL: upper(true),
    fore: mk((b) => drawViewForearm(b, sleeve, glove)),
    hand: { r: hand(1), l: hand(-1) },
    bird: mk((b) => drawViewHand(b, glove, fingers, -1, 'wrap', padded, true)),
  };
  armCache.set(key, out);
  return out;
}

// ------------------------------------------------------------------------------------------- the rig

/** What the owner's body is doing this frame, beyond what the third-person rig already holds (gun pose, kick, swing). */
export interface ViewMotion {
  /** Sights up, 0 to 1. */
  ads: number;
  /** The gun's lag behind a turn of the view, radians (yaw positive left, pitch positive down). */
  lagYaw: number;
  lagPitch: number;
  /** Step bob from the gait, radians. */
  bobX: number;
  bobY: number;
  /** Landing dip of the eye, metres (negative is down). */
  dip: number;
  /** Speed to the right and ahead, m/s. */
  strafe: number;
  fwd: number;
  /** In the air, 0 to 1. */
  air: number;
  crouch: boolean;
  /** The body's lean (camera roll, radians, positive to the left): the gun is held a little against it. */
  lean: number;
  /** How far the last shot pushed the gun back, metres. */
  back: number;
  /** The free hand up in a rude salute after a fight, 0 to 1 (the gun stays in the other). */
  flip: number;
}

export const newViewMotion = (): ViewMotion => ({ ads: 0, lagYaw: 0, lagPitch: 0, bobX: 0, bobY: 0, dip: 0, strafe: 0, fwd: 0, air: 0, crouch: false, lean: 0, back: 0, flip: 0 });

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t = new THREE.Vector3();
const _s = new THREE.Vector3();
const _d = new THREE.Vector3();
const _el = new THREE.Vector3();
const _x = new THREE.Vector3();
const _w = new THREE.Vector3();
const _hz = new THREE.Vector3();
const _wr = new THREE.Vector3();
const _fd = new THREE.Vector3();
const _ax = new THREE.Vector3();
const _hy = new THREE.Vector3();
const _m = new THREE.Matrix4();
const DOWN = new THREE.Vector3(0, -1, 0);
const UP = new THREE.Vector3(0, 1, 0);
const AHEAD = new THREE.Vector3(0, 0, -1);
const BASE = new THREE.Quaternion().setFromAxisAngle(UP, Math.PI);

export class ViewModel {
  /** Placed on the camera for the owner's view, hidden otherwise. */
  readonly root = new THREE.Group();
  /** The weapon's frame in camera space. */
  private gun = new THREE.Group();
  private weapon: THREE.Mesh | null = null;
  private held: Held = 'none';
  private flash = new MuzzleFlash();
  private upperR: THREE.Mesh;
  private upperL: THREE.Mesh;
  private foreR: THREE.Mesh;
  private foreL: THREE.Mesh;
  private handR: THREE.Mesh;
  private handL: THREE.Mesh;
  private geo: ArmGeo;
  /** Smoothed movement, so the gun settles into a sidestep instead of snapping. */
  private sf = 0;
  private ff = 0;
  private t = Math.random() * 10;
  /** Whether there is anything to draw this frame (a weapon, or a punch). */
  active = false;
  readonly motion = newViewMotion();

  constructor(pal: Palette) {
    const g = (this.geo = viewArms(pal));
    const mk = (geo: THREE.BufferGeometry) => {
      const m = new THREE.Mesh(geo, mat);
      m.frustumCulled = false;
      this.root.add(m);
      return m;
    };
    this.upperR = mk(g.upperR);
    this.upperL = mk(g.upperL);
    // The third-person upper arm is a hair short for these arms: stretched to reach the elbow.
    this.upperR.scale.y = this.upperL.scale.y = UPPER / 0.27;
    this.foreR = mk(g.fore);
    this.foreL = mk(g.fore);
    this.handR = mk(g.hand.r.far);
    this.handL = mk(g.hand.l.near);
    this.root.add(this.gun);
    this.root.visible = false;
  }

  dress(pal: Palette) {
    const g = (this.geo = viewArms(pal));
    this.upperR.geometry = g.upperR;
    this.upperL.geometry = g.upperL;
    this.foreR.geometry = g.fore;
    this.foreL.geometry = g.fore;
  }

  private setHeld(kind: Held) {
    if (kind === this.held) return;
    this.held = kind;
    this.flash.setGun(null);
    this.flash.group.removeFromParent();
    if (this.weapon) {
      this.gun.remove(this.weapon);
      this.weapon = null;
    }
    if (kind === 'none') return;
    const m = new THREE.Mesh(weaponGeometry(kind), mat);
    m.frustumCulled = false;
    this.gun.add(m);
    this.weapon = m;
    if (isGun(kind)) {
      this.flash.setGun(kind);
      m.add(this.flash.group);
    }
  }

  /**
   * Pose the arms and the weapon for this frame, in camera space. Reads what the third-person rig was handed (the weapon,
   * how the gun is handled, the kick, the swing) and `motion` for the rest.
   */
  pose(dt: number, h: Humanoid) {
    const m = this.motion;
    this.t += dt;
    const swing = h.swing;
    const kind = h.heldKind;
    this.setHeld(kind);
    this.active = kind !== 'none' || swing > 0;
    if (!this.active) return;
    const spec = kind === 'none' ? FIST : SPECS[kind];
    const gun = isGun(kind);
    const gp = h.gunPose;
    this.sf = damp(this.sf, m.strafe, 7, dt);
    this.ff = damp(this.ff, m.fwd, 5, dt);
    const ads = gun ? smooth01(m.ads) : 0;
    // How much of the body's movement reaches the gun: braced behind the sights, very little.
    const free = 1 - 0.78 * ads;
    const s = spec.scale;
    const P = _t.set(spec.hip[0], spec.hip[1], spec.hip[2]);
    const Q = _q;
    if (gun) {
      // From the hip the barrel points at what the crosshair is on.
      _m.lookAt(_v.set(0, 0, -CONVERGE), P, UP);
      Q.setFromRotationMatrix(_m);
      if (ads > 0) {
        // Sights up: the rear sight on the line of sight, the sight line straight down it.
        const g = GUN_POINTS[kind];
        const tilt = Math.atan2(g.front[1] - g.rear[1], g.front[2] - g.rear[2]);
        _q2.setFromAxisAngle(_x.set(1, 0, 0), -tilt).multiply(BASE);
        const rear = _v.set(g.rear[0], g.rear[1], g.rear[2]).multiplyScalar(s).applyQuaternion(_q2);
        const grip = _a.set(spec.r.p[0], spec.r.p[1], spec.r.p[2]).multiplyScalar(s).applyQuaternion(_q2);
        // Where the grip is with the rear sight at the right distance down the line of sight.
        grip.sub(rear).add(_n.set(0, 0, -spec.ads));
        P.lerp(grip, ads);
        Q.slerp(_q2, ads);
      }
    } else {
      const r = spec.rest!;
      Q.setFromEuler(_e.set(r[0], r[1], r[2], 'YXZ')).multiply(BASE);
    }

    // The body's movement, as an offset of the grip (metres) and a turn of the weapon about it (radians: muzzle up, left, cant).
    let dx = 0;
    let dy = 0;
    let dz = 0;
    let rx = 0;
    let ry = 0;
    let rz = 0;
    // Trailing a turn of the view, and canting with it.
    dx -= m.lagYaw * 0.3 * free;
    dy -= m.lagPitch * 0.22 * free;
    ry += m.lagYaw * 0.9 * free;
    rx -= m.lagPitch * 0.8 * free;
    rz += m.lagYaw * 0.7 * free;
    // Rocking with the steps.
    dx += m.bobX * 1.3 * free;
    dy += (m.bobY * 1.5 - Math.abs(m.bobX) * 0.6) * free;
    rz += m.bobX * 1.6 * free;
    rx += m.bobY * 0.7 * free;
    // Cants into a sidestep and swings out against it; pulled in a touch walking forward.
    dx -= this.sf * 0.009 * free;
    rz -= this.sf * 0.03 * free;
    dz += clamp(this.ff, -2, 6) * 0.005 * free;
    dy -= clamp(Math.abs(this.ff), 0, 6) * 0.002 * free;
    // Held a little against the body's lean, so the lean reads as the body and not the picture.
    rz -= m.lean * 0.5;
    // The landing goes through the arms, and in the air they come up a little.
    dy += m.dip * 0.7 + m.air * 0.025 * free;
    rx += m.air * 0.06 * free;
    if (m.crouch) dy -= 0.008;
    // Breathing at rest.
    const still = 1 - clamp(Math.abs(this.ff) + Math.abs(this.sf), 0, 1);
    dy += Math.sin(this.t * 1.5) * 0.0025 * still * free;
    rx += Math.sin(this.t * 1.5 + 0.6) * 0.004 * still * free;
    // The barrel's own wander, at the hip (behind the sights the whole view wanders instead).
    rx -= h.gunSway[1] * 0.8 * (1 - ads);
    ry += h.gunSway[0] * 0.8 * (1 - ads);
    if (gun) {
      // A shot bucks the gun back into the hands and climbs the muzzle.
      const kick = h.gunKick;
      dz += m.back * 1.4 + Math.max(0, kick) * 0.022;
      dy += Math.max(0, kick) * 0.006;
      rx += kick * 0.09;
      // Low ready (a sprint, a draw): drawn in to the chest, the muzzle down and across.
      const low = gp.low;
      dx -= 0.05 * low;
      dy -= 0.035 * low;
      dz += 0.05 * low;
      rx -= 0.6 * low;
      ry += 0.5 * low;
      rz += 0.35 * low;
      // High ready: a wall in the way, the muzzle up and the gun pulled back.
      dz += 0.1 * gp.high;
      dy += 0.02 * gp.high;
      rx += 1.0 * gp.high;
      // A reload brings the gun in to the middle of the chest, canted to the support hand, the muzzle moved.
      const rl = clamp(Math.max(Math.abs(gp.tilt) * 2, Math.abs(gp.pitch) * 1.5, gp.down), 0, 1);
      dx -= 0.05 * rl;
      dy += 0.035 * rl;
      dz += 0.07 * rl;
      rx -= gp.pitch;
    }
    if (swing > 0) {
      const e = 1 - swing;
      if (gun) {
        // A butt-stroke: the gun driven forward and across.
        const k = Math.sin(Math.PI * e);
        dx -= 0.1 * k;
        dz -= 0.16 * k;
        ry += 0.5 * k;
        rz += 0.4 * k;
      } else if (kind === 'none') {
        // A jab: the fist driven out and back.
        const k = Math.sin(Math.PI * Math.min(1, e * 1.4));
        dx -= 0.12 * k;
        dy += 0.14 * k;
        dz -= 0.22 * k;
      } else {
        // Over the top and down across: wound up and back, chopped down to the left, recovered.
        dx += curve([[0, 0], [0.3, 0.08], [0.55, -0.3], [1, 0]], e);
        dy += curve([[0, 0], [0.3, 0.17], [0.55, -0.08], [1, 0]], e);
        dz += curve([[0, 0], [0.3, 0.1], [0.55, -0.12], [1, 0]], e);
        rx += curve([[0, 0], [0.3, 0.55], [0.55, -1.9], [1, 0]], e);
        ry += curve([[0, 0], [0.3, -0.45], [0.55, 0.75], [1, 0]], e);
        rz += curve([[0, 0], [0.3, -0.5], [0.55, 0.6], [1, 0]], e);
      }
    }
    P.x += dx;
    P.y += dy;
    P.z += dz;
    Q.premultiply(_q2.setFromEuler(_e.set(rx, ry, rz, 'YXZ')));
    // Canted about the barrel for a reload.
    if (gun && gp.tilt) Q.multiply(_q2.setFromAxisAngle(_x.set(0, 0, 1), gp.tilt));

    // The weapon: placed so its grip lands on P.
    const g = this.gun;
    g.quaternion.copy(Q);
    g.scale.setScalar(s);
    g.position.copy(P).sub(_v.set(spec.r.p[0], spec.r.p[1], spec.r.p[2]).multiplyScalar(s).applyQuaternion(Q));
    g.updateMatrix();

    // Right hand: on the grip, or off to the bolt.
    let rp = spec.r.p;
    if (gun && gp.bolt && gp.rack > 0.001) {
      const k = clamp01(gp.rack * 3);
      rp = [lerp(rp[0], -0.045, k), lerp(rp[1], 0.05, k), lerp(rp[2], 0.12 - gp.rack * 0.09, k)];
    }
    this.handOn(rp, spec.r, 'r', this.handR, SHOULDER_R, POLE_R, this.upperR, this.foreR);
    // Left hand: on the support grip unless a reload has it at the belt or it is racking the slide; or a loose guard.
    if (spec.l) {
      let lp = spec.l.p;
      if (gun && !gp.bolt && gp.rack > 0.001) {
        if (kind === 'pump') lp = [lp[0], lp[1], lp[2] - gp.rack * 0.09];
        else {
          // Over the top of the slide and back.
          const k = clamp01(gp.rack * 3);
          lp = [lerp(lp[0], 0.0, k), lerp(lp[1], 0.075, k), lerp(lp[2], 0.08 - gp.rack * 0.06, k)];
        }
      }
      const down = gun ? gp.down : 0;
      this.handOn(lp, spec.l, 'l', this.handL, spec.long ? SHOULDER_L_LONG : SHOULDER_L, POLE_L, this.upperL, this.foreL, down);
    } else this.guard(swing);
    if (m.flip > 0.001) this.flipOff(smooth01(m.flip), spec.long ? SHOULDER_L_LONG : SHOULDER_L);
  }

  /**
   * The free hand off whatever it held and up beside the gun, back of the hand to the world and the middle finger up, with
   * a couple of jabs. `k` blends from where the hand was.
   */
  private flipOff(k: number, shoulder: THREE.Vector3) {
    const h = this.handL;
    const jab = Math.max(0, Math.sin(this.t * 9)) * 0.012 * k;
    const t = _s.set(-0.115 + this.motion.bobX * 0.3, -0.12 + this.motion.bobY + jab, -0.37 - jab * 0.5);
    t.lerpVectors(_t.copy(h.position), t, k);
    const a = _a.set(1, 0, 0).applyQuaternion(h.quaternion).lerp(_v.set(-0.96, -0.05, -0.25), k).normalize();
    const n = _n.set(0, 0, 1).applyQuaternion(h.quaternion).lerp(_v.set(0.15, 0.1, 1), k).normalize();
    if (k > 0.45) h.geometry = this.geo.bird;
    solveArm(shoulder, t, a, n, POLE_L, h, this.upperL, this.foreL);
  }

  /** Put a hand on the weapon at `p` (weapon space), or partway to the belt by `down`, and bend the arm to it. */
  private handOn(p: V3, grip: Grip, side: 'r' | 'l', hand: THREE.Mesh, shoulder: THREE.Vector3, pole: THREE.Vector3, upper: THREE.Mesh, fore: THREE.Mesh, down = 0) {
    hand.geometry = this.geo.hand[side][grip.thumb];
    const g = this.gun;
    const t = _s.set(p[0], p[1], p[2]).applyMatrix4(g.matrix);
    const a = _a.set(grip.a[0], grip.a[1], grip.a[2]).applyQuaternion(g.quaternion);
    const n = _n.set(grip.n[0], grip.n[1], grip.n[2]).applyQuaternion(g.quaternion);
    if (down > 0) {
      // Down to the belt, out of the bottom of the frame.
      t.lerp(_v.set(-0.12, -0.62, -0.08), down);
      a.lerp(AHEAD, down).normalize();
      n.lerp(_v.set(1, 0, 0), down).normalize();
    }
    solveArm(shoulder, t, a, n, pole, hand, upper, fore);
  }

  /** The free hand of a one-handed weapon: low on the left, a loose fist, barely in frame; it comes up for balance in a swing. */
  private guard(swing: number) {
    const up = swing > 0 ? Math.sin(Math.PI * (1 - swing)) : 0;
    const t = _s.set(-0.2 - up * 0.05, -0.37 + up * 0.08, -0.33 - up * 0.05);
    t.y += this.motion.bobY * 1.2;
    this.handL.geometry = this.geo.hand.l.wrap;
    solveArm(SHOULDER_L, t, _a.set(0.2, 1, -0.4).normalize(), _n.set(1, 0.2, -0.3).normalize(), POLE_L, this.handL, this.upperL, this.foreL);
  }

  /** Move onto the camera for its view. */
  place(cam: THREE.Camera) {
    cam.matrixWorld.decompose(this.root.position, this.root.quaternion, _v);
    this.root.updateMatrixWorld(true);
  }

  /** The muzzle flash: how much of it is left this frame (the rig's own flash decides when). */
  muzzle(k: number) {
    this.flash.set(isGun(this.held) ? k : 0);
  }

  /** The gun's points in the world as this view draws them, into the rig's `points` (call after `place`). */
  capturePoints(out: Humanoid['points']) {
    out.valid = false;
    if (!this.weapon || !isGun(this.held)) return;
    const g = GUN_POINTS[this.held];
    const w = this.weapon;
    w.updateWorldMatrix(true, false);
    w.localToWorld(out.muzzle.set(g.muzzle[0], g.muzzle[1], g.muzzle[2]));
    w.localToWorld(out.port.set(g.port[0], g.port[1], g.port[2]));
    w.localToWorld(out.well.set(g.well[0], g.well[1], g.well[2]));
    w.localToWorld(_v.set(g.rear[0], g.rear[1], g.rear[2]));
    out.dir.copy(out.muzzle).sub(_v).normalize();
    out.valid = true;
  }

  /** The weapon mesh, for tests. */
  get weaponMesh(): THREE.Mesh | null {
    return this.weapon;
  }

  dispose() {
    this.root.removeFromParent();
  }
}

/**
 * Close a hand round the line `a` through `t` with the palm facing `n`, then bend the arm from `shoulder` to its wrist: the
 * elbow toward `pole`. Past arm's reach the shoulder comes forward (it is out of frame), so the hand never leaves the grip.
 * A wrist only bends so far, so the hand first rolls round the grip toward the forearm (its fingers stay closed on it),
 * and then the forearm swings toward the line of the hand for what is left, the shoulder following.
 */
function solveArm(shoulder: THREE.Vector3, t: THREE.Vector3, a: THREE.Vector3, n: THREE.Vector3, pole: THREE.Vector3, hand: THREE.Mesh, upper: THREE.Mesh, fore: THREE.Mesh) {
  // The hand's frame: along the grip, the palm onto it, and the wrist toward the shoulder, so the forearm comes from there.
  const x = a.normalize();
  const z = _hz.copy(n).addScaledVector(x, -n.dot(x));
  if (z.lengthSq() < 1e-6) z.set(0, 0, 1).addScaledVector(x, -x.z);
  z.normalize();
  const y = _hy.copy(z).cross(x);
  if (y.dot(_v.copy(shoulder).sub(t)) < 0) {
    x.negate();
    y.negate();
  }
  const sh = _el.copy(shoulder);
  const elbow = _x;
  const wrist = _wr;
  const place = () => {
    _m.makeBasis(x, y, z);
    hand.quaternion.setFromRotationMatrix(_m);
    wrist.copy(WRIST).applyQuaternion(hand.quaternion).add(t);
    reachArm(sh.copy(shoulder), wrist, pole, elbow);
  };
  place();
  // Roll round the grip toward where the forearm comes from.
  const fd = _fd.copy(elbow).sub(wrist).normalize();
  const fp = _ax.copy(fd).addScaledVector(x, -fd.dot(x));
  if (fp.lengthSq() > 1e-6) {
    fp.normalize();
    const roll = clamp(Math.atan2(_v.copy(y).cross(fp).dot(x), y.dot(fp)), -HAND_ROLL, HAND_ROLL);
    y.applyAxisAngle(x, roll);
    z.applyAxisAngle(x, roll);
    place();
  }
  // Then swing the forearm toward the line of the hand, so far.
  fd.copy(elbow).sub(wrist).normalize();
  const bend = Math.acos(clamp(fd.dot(y), -1, 1));
  if (bend > WRIST_BEND) {
    const ax = _ax.copy(fd).cross(y);
    if (ax.lengthSq() > 1e-8) {
      fd.applyAxisAngle(ax.normalize(), Math.min(bend - WRIST_BEND, ARM_SWING));
      elbow.copy(wrist).addScaledVector(fd, FORE);
      sh.sub(elbow).normalize().multiplyScalar(UPPER).add(elbow);
    }
  }
  hand.position.copy(t);
  upper.position.copy(sh);
  upper.quaternion.setFromUnitVectors(DOWN, _v.copy(elbow).sub(sh).normalize());
  // The forearm runs elbow to wrist, twisted to match the hand so the cuff and glove line up.
  const fy = _v.copy(elbow).sub(wrist).normalize();
  const fz = _a.copy(z).addScaledVector(fy, -z.dot(fy));
  if (fz.lengthSq() < 1e-6) fz.copy(_w.copy(pole).addScaledVector(fy, -pole.dot(fy)));
  fz.normalize();
  const fx = _n.copy(fy).cross(fz);
  _m.makeBasis(fx, fy, fz);
  fore.quaternion.setFromRotationMatrix(_m);
  fore.position.copy(elbow);
}

/** Shoulder `sh` to `wrist` in two bones, the elbow toward `pole`, into `elbow`; past reach `sh` moves along the line. */
function reachArm(sh: THREE.Vector3, wrist: THREE.Vector3, pole: THREE.Vector3, elbow: THREE.Vector3) {
  const d = _d.copy(wrist).sub(sh);
  let dist = d.length();
  d.divideScalar(Math.max(dist, 1e-6));
  const reach = UPPER + FORE - 1e-3;
  const near = Math.abs(UPPER - FORE) + 0.02;
  if (dist > reach || dist < near) {
    const want = clamp(dist, near, reach);
    sh.copy(wrist).addScaledVector(d, -want);
    dist = want;
  }
  const along = (UPPER * UPPER - FORE * FORE + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, UPPER * UPPER - along * along));
  const side = _w.copy(pole).addScaledVector(d, -pole.dot(d)).normalize();
  elbow.copy(sh).addScaledVector(d, along).addScaledVector(side, h);
}

function smooth01(x: number) {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}
