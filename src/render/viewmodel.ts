import * as THREE from 'three';
import { MeshBuilder, S } from './builder';
import { C } from './palette';
import { clamp, clamp01, damp, lerp } from '../core/math';
import { GUN_BASE, GUN_POINTS, curve } from '../sim/weaponanim';
import { FRAMES } from '../sim/gunFrames';
import { drillPose, newDrillPose, type Drill, type HandAt } from '../sim/gunDrills';
import { flashes } from '../sim/weaponfx';
import { GUN_MODELS, type GunModel } from '../data/gear';
import { shared } from './dispose';
import { kitMaterial } from './materials';
import { DEFAULT_LOOK, drawUpperArm, sleeveColor } from './outfit';
import { weaponGeometry, type Held, type Humanoid, type Palette } from './humanoid';
import { MuzzleFlash } from './muzzleFlash';
import { weaponMaterial } from './weapons';
import { muzzleAt, sightLine } from './gunMods';
import { parseLooks } from '../sim/gunmods';
import { ARROW_LEN, BRACE, BowRig } from './bow';

/**
 * The owner's own arms and weapon in first person, drawn the way a body camera sees them: two whole arms from shoulders
 * just below and behind the eye, gloved hands closed round the grips, the gun low in the middle of the frame. It lives in
 * the camera's space, so it sits the same on screen whichever way the view is turned, and the forearms run off the bottom
 * edge instead of ending in mid-air. On top of the held pose go the body's movements: the gun trails a turn, rocks with
 * the steps, cants into a sidestep, drops at a landing, kicks with a shot and breathes at rest.
 *
 * The third-person rig in `humanoid.ts` stays what a partner sees; this one is only ever drawn in its owner's view.
 */

/**
 * Both faces drawn: an arm runs back past the eye, and where the near plane slices a sleeve the inside of the cloth closes
 * the cut instead of leaving it open.
 */
const mat = kitMaterial({ side: THREE.DoubleSide });

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
/**
 * The support elbow under a long gun's fore-end hangs down, a little out: out to the side, a short gun's fore-end (held close
 * in) would be reached for level across the frame.
 */
const POLE_FORE = new THREE.Vector3(-0.5, -1, 0.1).normalize();
/**
 * Working the weapon over (a drill), the elbows are tucked down by the ribs: held out, a raised gun lifts the upper arms into
 * the bottom corners of the frame, where the lens cuts them open.
 */
const POLE_TUCK_R = new THREE.Vector3(0.45, -1, 0.15).normalize();
/**
 * With the sights up the firing elbow drops down by the ribs: held out to the side, the forearm runs back across the bottom
 * right of the frame so close to the eye that the lens cuts the sleeve open.
 */
const POLE_R_ADS = new THREE.Vector3(0.25, -1, -0.15).normalize();
const _pa = new THREE.Vector3();
const POLE_TUCK_L = new THREE.Vector3(-0.45, -1, 0.15).normalize();
const _pr = new THREE.Vector3();
const _pl = new THREE.Vector3();
/** Drawing a bow, the elbow comes up and out to the side, so the forearm runs off the right of the frame. */
const POLE_DRAW = new THREE.Vector3(1, 0.12, -0.2).normalize();
/** The hip-fire gun points at what the crosshair is on, this far out. */
const CONVERGE = 20;

/** A hand in a drill this frame: the drill, where the hand is in it, and how much of it shows. */
interface DrillHand {
  d: Drill;
  at: HandAt;
  w: number;
}

/**
 * A hand on the weapon, in the weapon's own frame (+z down the barrel, +y up, +x to the weapon's left): the middle of what
 * the hand closes round, the line it closes round, and which way the palm faces onto it.
 */
interface Grip {
  p: V3;
  a: V3;
  n: V3;
  /**
   * Where the thumb goes: round over the fingers, straight ahead along the far side or the near side of the grip, or
   * forward along the side of a fore-end lying slantwise in the palm.
   */
  thumb: Thumb;
  /** How the hand holds on, where it differs from a hand round a grip (see `Hold`). */
  hold?: Partial<Hold>;
}

type Thumb = 'wrap' | 'far' | 'near' | 'fore';

/**
 * How a hand holds what it closes round: how far it may roll round it toward the forearm, how far the wrist then bends
 * before the forearm swings, and how far the line slants across the palm (radians). A slant turns the hand about its palm,
 * the wrist back toward the shoulder: a fore-end held from below lies across the palm from the heel of the hand to the root
 * of the index finger, so the forearm comes up from behind it instead of square across it.
 */
interface Hold {
  roll: number;
  bend: number;
  skew: number;
}

/** The slant of a fore-end across the support hand's palm (radians), which its fingers are drawn closed round. */
const FORE_SKEW = 0.7;

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

// Grips are read off each gun's frame (`sim/gunFrames.ts`), which its model in `render/weapons` is drawn to.
// The firing hand closes round the grip from its right side, palm onto it and a little forward, the thumb laid along the far
// side; on a handgun the support hand wraps over it from the left, its thumb along the near side under the first. A fore-end
// (or a pump) is cupped from below, the palm under it, lying slantwise across the palm with the fingers up its right side
// and the thumb forward along its left; the wrist is cocked back, so the forearm comes up from low on the left behind it.
// The hand rolls round the fore-end toward the forearm only a little: further, the palm would come round onto its right.
const GRIP_R = (p: V3, a: V3): Grip => ({ p, a, n: [1, 0, 0.35], thumb: 'far' });
const SUPPORT_HANDGUN = (p: V3, a: V3): Grip => ({ p, a, n: [-1, 0, 0.2], thumb: 'near' });
const FORE_END = (p: V3): Grip => ({ p, a: [0, 0, 1], n: [-0.27, 1, 0], thumb: 'fore', hold: { roll: 0.35, bend: 0.8, skew: FORE_SKEW } });
const HANDLE = (z: number, n: V3 = [1, 0, 0]): Grip => ({ p: [0, 0, z], a: [0, 0, 1], n, thumb: 'wrap' });
const MELEE_REST: V3 = [1.05, 0.3, 0.12];
const HANDGUNS: GunModel[] = ['pistol', 'compact', 'mp', 'revolver', 'cannon'];

/** How each kind of gun is carried and aimed (hip, sight distance, shouldered); the hands come from the gun's frame. */
const CARRY: Record<'handgun' | 'smg' | 'sawn' | 'pump' | 'rifle' | 'crossbow', Pick<Spec, 'hip' | 'ads' | 'long'>> = {
  // Shouldered, but the grip held a little further out: the bolt is seated with the hand over the rail.
  crossbow: { hip: [0.11, -0.26, -0.26], ads: 0.3, long: true },
  handgun: { hip: [0.075, -0.18, -0.33], ads: 0.38 },
  smg: { hip: [0.1, -0.24, -0.28], ads: 0.27, long: true },
  sawn: { hip: [0.1, -0.24, -0.27], ads: 0.28, long: true },
  pump: { hip: [0.11, -0.26, -0.23], ads: 0.27, long: true },
  rifle: { hip: [0.11, -0.26, -0.22], ads: 0.27, long: true },
};
/** Which way each gun is carried: by its base gun, except the shouldered crossbow and the two-handed machine pistol. */
const carryOf = (m: GunModel) => (HANDGUNS.includes(m) ? CARRY.handgun : m === 'crossbow' ? CARRY.crossbow : CARRY[GUN_BASE[m] === 'pistol' || GUN_BASE[m] === 'revolver' ? 'handgun' : (GUN_BASE[m] as 'smg' | 'sawn' | 'pump' | 'rifle')]);

/**
 * With the sights up the firing hand stays at least this far out from the eye (metres), clear of the near plane (0.2 m) with
 * its wrist: a gun whose rear sight sits far up the barrel from the grip (a lever gun's buckhorn, a double's rib) is held
 * further out, up to `ADS_FAR`.
 */
const GRIP_CLEAR = 0.3;
const ADS_FAR = 0.5;
const adsOf = (m: GunModel) => {
  const f = FRAMES[m];
  return clamp(f.rear[2] - f.grip.p[2] + GRIP_CLEAR, carryOf(m).ads, ADS_FAR);
};

const SPECS = {} as Record<Exclude<Held, 'none'>, Spec>;
for (const m of GUN_MODELS) {
  const f = FRAMES[m];
  const hand = HANDGUNS.includes(m);
  SPECS[m] = {
    ...carryOf(m),
    ads: adsOf(m),
    scale: 1,
    r: GRIP_R(f.grip.p, f.grip.a),
    l: f.support ? (hand ? SUPPORT_HANDGUN(f.support, f.grip.a) : FORE_END(f.support)) : undefined,
  };
}
// A bow is placed by its grip (see `bowBase`) and its hands are its own (`bowHands`).
SPECS.bow = { ...CARRY.handgun, r: { p: [0, 0, 0], a: [0, 1, 0], n: [0, 0, 1], thumb: 'wrap' }, l: undefined, scale: 0.92 };
const MELEE_SPECS: Record<Exclude<Held, 'none' | GunModel>, Spec> = {
  knife: { hip: [0.2, -0.25, -0.42], ads: 0, rest: [0.75, 0.35, 0.15], scale: 1.1, r: HANDLE(0) },
  bat: { hip: [0.16, -0.22, -0.36], ads: 0, rest: [1.2, 0.35, 0.25], scale: 1, r: HANDLE(0.17), l: HANDLE(0.06, [-1, 0, 0]) },
  pipe: { hip: [0.16, -0.22, -0.36], ads: 0, rest: [1.2, 0.35, 0.25], scale: 1, r: HANDLE(0.1), l: HANDLE(0.06, [-1, 0, 0]) },
  machete: { hip: [0.2, -0.24, -0.4], ads: 0, rest: MELEE_REST, scale: 1, r: HANDLE(0) },
  katana: { hip: [0.2, -0.24, -0.4], ads: 0, rest: MELEE_REST, scale: 1, r: HANDLE(0) },
  axe: { hip: [0.16, -0.22, -0.36], ads: 0, rest: [1.15, 0.35, 0.25], scale: 1, r: HANDLE(0.1), l: HANDLE(-0.02, [-1, 0, 0]) },
  sledge: { hip: [0.16, -0.22, -0.36], ads: 0, rest: [1.15, 0.35, 0.25], scale: 1, r: HANDLE(0.15), l: HANDLE(0.03, [-1, 0, 0]) },
  wrench: { hip: [0.2, -0.24, -0.4], ads: 0, rest: MELEE_REST, scale: 1, r: HANDLE(0.04) },
  crowbar: { hip: [0.2, -0.24, -0.4], ads: 0, rest: MELEE_REST, scale: 1, r: HANDLE(0.02) },
  flare: { hip: [0.2, -0.22, -0.42], ads: 0, rest: [0.35, 0.2, 0], scale: 1, r: HANDLE(0.07) },
  jerrycan: { hip: [0.24, -0.44, -0.3], ads: 0, rest: [0, 0.2, 0], scale: 1, r: { p: [0.05, 0.06, 0.06], a: [0, 0, 1], n: [0, -1, 0], thumb: 'wrap' } },
};
Object.assign(SPECS, MELEE_SPECS);

/** Bare fists, for a punch. */
const FIST: Spec = { hip: [0.18, -0.3, -0.36], ads: 0, rest: [0, 0, 0], scale: 1, r: HANDLE(0) };

const isGun = (h: Held): h is GunModel => GUN_MODELS.includes(h as GunModel);

// ------------------------------------------------------------------------------------------- the bow

/**
 * The bow, in camera space: the bow arm out toward the middle of the frame, the bow canted with its top to the right, and
 * the draw hand on the string. Lowered (`k` 0) it rests low and further over, the arrow pointing at the ground ahead; drawn
 * (`k` 1) the draw hand is low on the right by the jaw and the arrow runs in from it to just under the crosshair, the way
 * a bow is seen from behind it. `rest` is where the arrow lies on the shelf and `dir` the way it points.
 */
const BOW = {
  low: { rest: [-0.12, -0.2, -0.56] as V3, dir: [-0.15, -0.24, -1] as V3, cant: 0.75 },
  up: { rest: [-0.035, -0.055, -0.76] as V3, dir: [-0.115, 0.06, -0.44] as V3, cant: 0.25 },
  /** The string's travel in this view: short of the real draw, so the draw hand stays in front of the eye. */
  drawLen: 0.22,
};
/** The bow hand round the grip, the palm behind it pushing forward; the draw hand's fingers hooked round the string. */
const BOW_HAND: Grip = { p: [0, -0.01, -0.012], a: [0, 1, 0], n: [0, 0, 1], thumb: 'wrap' };
const STRING_HAND: Grip = { p: [0, 0, 0], a: [0, 1, 0], n: [1, 0, -0.3], thumb: 'wrap' };
/** Where the draw hand goes to pull the next arrow, low by the right hip (camera space). */
const QUIVER: V3 = [0.2, -0.5, -0.05];
/** The bow arm comes up from low on the left, so it reaches the grip at a slant instead of hiding the hand behind its forearm. */
const BOW_SHOULDER = new THREE.Vector3(-0.34, -0.52, 0.04);

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
  /** Each hand open, off its grip. */
  open: Record<'r' | 'l', THREE.BufferGeometry>;
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
const TRIGGER_FINGER: [number, number][] = [[-0.034, -0.035], [-0.065, -0.027], [-0.082, -0.012], [-0.08, 0.004]];
/**
 * How far each of the trigger finger's joints rises up the grip (toward the thumb) from the line of the other fingers: a
 * grip is raked back, so the fingers round it point a little down, while the trigger finger lies along the frame, level
 * with the bore.
 */
const TRIGGER_RISE = [0, 0.012, 0.02, 0.022];
/** The middle finger held straight up out of the fist. */
const BIRD_FINGER: [number, number][] = [[-0.034, -0.035], [-0.078, -0.037], [-0.104, -0.036], [-0.125, -0.034]];
/** The others closed tight into the palm round nothing, and the thumb laid across them. */
const FIST_FINGER: [number, number][] = [[-0.034, -0.035], [-0.044, 0.004], [-0.02, 0.012], [-0.004, -0.006]];
const FIST_THUMB = { x: [0.62, 0.85, 0.45, 0.05], yz: [[0.03, -0.028], [0.0, -0.002], [-0.035, 0.012], [-0.05, 0.012]] as [number, number][] };
/** An open hand, letting go of a grip or slapping a magazine home: the fingers out nearly straight, the thumb spread. */
const OPEN_FINGER: [number, number][] = [[-0.034, -0.035], [-0.07, -0.029], [-0.093, -0.017], [-0.108, -0.002]];
const OPEN_THUMB = { x: [0.62, 1.05, 1.3, 1.45], yz: [[0.03, -0.028], [0.008, -0.03], [-0.016, -0.028], [-0.038, -0.024]] as [number, number][] };
/** The thumb's bones from its root in the heel of the hand, by where it goes (`x` along the grip as a share of the hand's half-width). */
const THUMBS: Record<Thumb, { x: number[]; yz: [number, number][] }> = {
  // Over the back of the grip and forward along the far side, under the slide.
  far: { x: [0.62, 0.95, 1.05, 1.05], yz: [[0.03, -0.028], [0.034, 0.004], [0.006, 0.025], [-0.02, 0.031]] },
  // Straight ahead along the near side, under the other hand's thumb.
  near: { x: [0.62, 0.92, 1.02, 1.02], yz: [[0.036, -0.03], [0.012, -0.026], [-0.02, -0.019], [-0.046, -0.015]] },
  // Up out of the palm and forward along the side of a fore-end lying slantwise in the hand (`FORE_SKEW`), clear of it.
  fore: { x: [0.62, 0.72, 1.27, 1.71], yz: [[0.036, -0.03], [0.0176, -0.004], [-0.0017, -0.002], [-0.0171, 0]] },
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
function drawViewHand(b: MeshBuilder, glove: Surf, fingers: Surf, side: number, thumb: Thumb, padded: boolean, bird = false, open = false) {
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
  // A fore-end lying slantwise in the palm crosses each finger at a different place: out by the index finger's root, back
  // in the heel of the hand by the little finger. Each finger closes round it where it crosses.
  const slant = thumb === 'fore' && !open && !bird ? Math.tan(FORE_SKEW) : 0;
  // Fingers, index to little, each in three tapering bones.
  for (let i = 0; i < 4; i++) {
    const f = FINGERS[i];
    const tpl = open ? OPEN_FINGER : bird ? (i === 1 ? BIRD_FINGER : FIST_FINGER) : i === 0 && thumb === 'far' ? TRIGGER_FINGER : FINGER;
    // Spread a little when open, the way a hand relaxes.
    const j = fingerJoints(tpl, sx * f.x * (open ? 1.12 : 1), f.k, f.l);
    if (tpl === TRIGGER_FINGER) for (let n = 0; n < j.length; n++) j[n][0] += sx * TRIGGER_RISE[n];
    for (let n = 1; n < j.length; n++) j[n][1] -= j[0][0] * slant;
    b.limb(j[0][0], j[0][1], j[0][2], j[1][0], j[1][1], j[1][2], f.r * 1.08, f.r, i === 0 ? glove : fingers, 10);
    b.limb(j[1][0], j[1][1], j[1][2], j[2][0], j[2][1], j[2][2], f.r, f.r * 0.93, fingers, 10);
    b.limb(j[2][0], j[2][1], j[2][2], j[3][0], j[3][1], j[3][2], f.r * 0.93, f.r * 0.84, fingers, 10);
  }
  // The thumb: a thick root in the heel of the hand, then two bones.
  const t = open ? OPEN_THUMB : bird ? FIST_THUMB : THUMBS[thumb];
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
    fore: mk((b) => drawViewHand(b, glove, fingers, side, 'fore', padded)),
  });
  const out: ArmGeo = {
    upperR: upper(false),
    upperL: upper(true),
    fore: mk((b) => drawViewForearm(b, sleeve, glove)),
    hand: { r: hand(1), l: hand(-1) },
    bird: mk((b) => drawViewHand(b, glove, fingers, -1, 'wrap', padded, true)),
    open: { r: mk((b) => drawViewHand(b, glove, fingers, 1, 'wrap', padded, false, true)), l: mk((b) => drawViewHand(b, glove, fingers, -1, 'wrap', padded, false, true)) },
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
const _rp = new THREE.Vector3();
const _ra = new THREE.Vector3();
const _rn = new THREE.Vector3();
const _h0 = { p: new THREE.Vector3(), a: new THREE.Vector3(), n: new THREE.Vector3() };
const _h1 = { p: new THREE.Vector3(), a: new THREE.Vector3(), n: new THREE.Vector3() };
const DOWN = new THREE.Vector3(0, -1, 0);
const UP = new THREE.Vector3(0, 1, 0);
const AHEAD = new THREE.Vector3(0, 0, -1);
const BASE = new THREE.Quaternion().setFromAxisAngle(UP, Math.PI);
const _kx = new THREE.Vector3();
const _ky = new THREE.Vector3();

/** A hand round a grip: it rolls and bends so far, and the grip runs square across the palm. */
const HOLD: Hold = { roll: HAND_ROLL, bend: WRIST_BEND, skew: 0 };
const _hold: Hold = { ...HOLD };

/** How a hand holds on to `grip`, `on` of the way from the plain hold (0: off it, holding something else). */
function holdOf(grip: Grip, on: number): Hold {
  const g = grip.hold;
  if (!g) return HOLD;
  _hold.roll = lerp(HOLD.roll, g.roll ?? HOLD.roll, on);
  _hold.bend = lerp(HOLD.bend, g.bend ?? HOLD.bend, on);
  _hold.skew = lerp(HOLD.skew, g.skew ?? HOLD.skew, on);
  return _hold;
}

export class ViewModel {
  /** Placed on the camera for the owner's view, hidden otherwise. */
  readonly root = new THREE.Group();
  /** The weapon's frame in camera space. */
  private gun = new THREE.Group();
  private weapon: THREE.Mesh | null = null;
  private held: Held = 'none';
  private bow: BowRig | null = null;
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
  private dp = newDrillPose();
  private dhL: DrillHand = { d: null!, at: this.dp.l, w: 0 };
  private dhR: DrillHand = { d: null!, at: this.dp.r, w: 0 };

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

  private setHeld(kind: Held, mods = '') {
    if (kind === this.held && mods === this.mods) return;
    this.held = kind;
    this.mods = mods;
    this.sight = null;
    this.flash.setGun(null);
    this.flash.group.removeFromParent();
    if (this.weapon) {
      this.weapon.removeFromParent();
      this.weapon = null;
    }
    if (this.bow) {
      this.bow.group.removeFromParent();
      this.bow = null;
    }
    if (kind === 'none') return;
    if (kind === 'bow') {
      this.bow = new BowRig();
      this.bow.drawLen = BOW.drawLen;
      this.bow.arrowScale = (BRACE + BOW.drawLen + 0.1) / ARROW_LEN;
      this.gun.add(this.bow.group);
      this.weapon = this.bow.riser;
      return;
    }
    // The close-up model, with the add-ons fitted: a dot or a scope on the rail is what the sights come up behind.
    const m = new THREE.Mesh(weaponGeometry(kind, mods, 'hi'), weaponMaterial());
    m.frustumCulled = false;
    this.gun.add(m);
    this.weapon = m;
    if (!isGun(kind)) return;
    const looks = parseLooks(mods);
    this.sight = sightLine(kind, looks);
    const tip = muzzleAt(kind, looks);
    this.tip.set(GUN_POINTS[kind].muzzle[0], tip.y, tip.z);
    if (flashes(kind)) {
      this.flash.setGun(kind);
      this.flash.group.position.copy(this.tip).z += 0.005;
      m.add(this.flash.group);
    }
  }

  /** The add-ons on the weapon in hand (their look key), the line its sights or optic look along, and its muzzle's tip. */
  private mods = '';
  private sight: { rear: V3; front: V3 } | null = null;
  private tip = new THREE.Vector3();

  /**
   * Pose the arms and the weapon for this frame, in camera space. Reads what the third-person rig was handed (the weapon,
   * how the gun is handled, the kick, the swing) and `motion` for the rest.
   */
  pose(dt: number, h: Humanoid) {
    const m = this.motion;
    this.t += dt;
    const swing = h.swing;
    const kind = h.heldKind;
    this.setHeld(kind, h.heldMods);
    this.active = kind !== 'none' || swing > 0;
    if (!this.active) return;
    const spec = kind === 'none' ? FIST : SPECS[kind];
    const gun = isGun(kind);
    const bow = this.bow;
    const gp = h.gunPose;
    this.sf = damp(this.sf, m.strafe, 7, dt);
    this.ff = damp(this.ff, m.fwd, 5, dt);
    const ads = gun ? smooth01(m.ads) : 0;
    // How much of the body's movement reaches the gun: braced behind the sights, very little.
    const free = 1 - 0.78 * ads;
    const s = spec.scale;
    const P = _t.set(spec.hip[0], spec.hip[1], spec.hip[2]);
    const Q = _q;
    if (bow) this.bowBase(P, Q, Math.max(h.bowDraw, ads * 0.7));
    else if (gun) {
      // From the hip the barrel points at what the crosshair is on.
      _m.lookAt(_v.set(0, 0, -CONVERGE), P, UP);
      Q.setFromRotationMatrix(_m);
      if (ads > 0) {
        // Sights up: the rear sight on the line of sight, the sight line straight down it.
        const g = this.sight ?? GUN_POINTS[kind];
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
    // The barrel's own wander, at the hip (behind the sights the whole view wanders instead). A drawn bow wanders as a
    // whole with the view, like sights.
    const braced = bow ? Math.max(ads, h.bowDraw) : ads;
    rx -= h.gunSway[1] * 0.8 * (1 - braced);
    ry += h.gunSway[0] * 0.8 * (1 - braced);
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
    // A drill of the hands (a re-grip, a jam being cleared) moves the weapon too.
    const dr = h.drill;
    const dw = dr.r && kind !== 'none' ? clamp01(dr.w) : 0;
    const dp = dw > 0 ? drillPose(dr.r!, dr.t, this.dp) : null;
    // A gun is canted about its barrel, the way a wrist turns it (about the view it would swing the forearm into the lens);
    // a blade or a tool is turned about the view.
    let cant = 0;
    if (dp) {
      dx += dp.x * dw;
      dy += dp.y * dw;
      dz += dp.z * dw;
      rx += dp.rx * dw;
      ry += dp.ry * dw;
      if (gun) cant = -dp.rz * dw;
      else rz += dp.rz * dw;
    }
    P.x += dx;
    P.y += dy;
    P.z += dz;
    Q.premultiply(_q2.setFromEuler(_e.set(rx, ry, rz, 'YXZ')));
    // Canted about the barrel for a reload, or a drill.
    if (gun && (gp.tilt || cant)) Q.multiply(_q2.setFromAxisAngle(_x.set(0, 0, 1), gp.tilt + cant));

    // The weapon: placed so its grip lands on P.
    const g = this.gun;
    g.quaternion.copy(Q);
    g.scale.setScalar(s);
    g.position.copy(P).sub(_v.set(spec.r.p[0], spec.r.p[1], spec.r.p[2]).multiplyScalar(s).applyQuaternion(Q));
    g.updateMatrix();
    // Turned in the fingers about its grip (a knife rolled, a handle twisted), the hand staying where it is.
    if (this.weapon && !bow) this.spin(spec.r, dp ? dp.spin * dw : 0);
    const dhL = dp && dr.r!.l ? this.drillHand(this.dhL, dr.r!, dw) : null;
    const dhR = dp && dr.r!.r ? this.drillHand(this.dhR, dr.r!, dw) : null;

    if (bow) {
      this.bowHands(bow, h);
      if (m.flip > 0.001) this.flipOff(smooth01(m.flip), SHOULDER_L);
      return;
    }
    // Right hand: on the grip, or off to the bolt.
    let rp = spec.r.p;
    if (gun && gp.bolt && gp.rack > 0.001) {
      const k = clamp01(gp.rack * 3);
      rp = [lerp(rp[0], -0.045, k), lerp(rp[1], 0.05, k), lerp(rp[2], 0.12 - gp.rack * 0.09, k)];
    }
    const poleR0 = ads > 0 ? _pa.copy(POLE_R).lerp(POLE_R_ADS, ads).normalize() : POLE_R;
    const poleR = dp ? _pr.copy(poleR0).lerp(POLE_TUCK_R, dw).normalize() : poleR0;
    const pole0 = spec.long && spec.l ? POLE_FORE : POLE_L;
    const poleL = dp ? _pl.copy(pole0).lerp(POLE_TUCK_L, dw).normalize() : pole0;
    this.handOn(rp, spec.r, 'r', this.handR, SHOULDER_R, poleR, this.upperR, this.foreR, 0, dhR);
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
      this.handOn(lp, spec.l, 'l', this.handL, spec.long ? SHOULDER_L_LONG : SHOULDER_L, poleL, this.upperL, this.foreL, down, dhL);
    } else this.guard(swing, dhL);
    if (m.flip > 0.001) this.flipOff(smooth01(m.flip), spec.long ? SHOULDER_L_LONG : SHOULDER_L);
  }

  /** The bow's grip at `P`, turned by `Q`, for a draw `k`: the arrow along its line from the shelf, the top canted right. */
  private bowBase(P: THREE.Vector3, Q: THREE.Quaternion, k: number) {
    const e = smooth01(k);
    const lo = BOW.low;
    const hi = BOW.up;
    const rest = _s.set(lerp(lo.rest[0], hi.rest[0], e), lerp(lo.rest[1], hi.rest[1], e), lerp(lo.rest[2], hi.rest[2], e));
    const d0 = _a.set(lo.dir[0], lo.dir[1], lo.dir[2]).normalize();
    const d1 = _n.set(hi.dir[0], hi.dir[1], hi.dir[2]).normalize();
    const at = d0.lerp(d1, e).normalize().add(rest);
    _m.lookAt(at, rest, UP);
    Q.setFromRotationMatrix(_m).multiply(_q2.setFromAxisAngle(_x.set(0, 0, 1), lerp(lo.cant, hi.cant, e)));
    const mz = GUN_POINTS.bow.muzzle;
    P.copy(rest).sub(_v.set(mz[0], mz[1], mz[2]).multiplyScalar(SPECS.bow.scale).applyQuaternion(Q));
  }

  /** The bow hand round the grip, and the draw hand on the nock (or reaching to the hip for the next arrow). */
  private bowHands(bow: BowRig, h: Humanoid) {
    bow.set(h.bowDraw, h.nocked);
    this.handOn(BOW_HAND.p, BOW_HAND, 'l', this.handL, BOW_SHOULDER, POLE_L, this.upperL, this.foreL);
    const g = this.gun;
    const t = _s.copy(bow.nock).applyMatrix4(g.matrix);
    const a = _a.set(STRING_HAND.a[0], STRING_HAND.a[1], STRING_HAND.a[2]).applyQuaternion(g.quaternion);
    const n = _n.set(STRING_HAND.n[0], STRING_HAND.n[1], STRING_HAND.n[2]).applyQuaternion(g.quaternion);
    const down = clamp01(h.gunPose.down);
    if (down > 0) {
      t.lerp(_v.set(QUIVER[0], QUIVER[1], QUIVER[2]), down);
      a.lerp(AHEAD, down).normalize();
    }
    this.handR.geometry = this.geo.hand.r.wrap;
    solveArm(SHOULDER_R, t, a, n, POLE_DRAW, this.handR, this.upperR, this.foreR);
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

  /**
   * Put a hand on the weapon at `p` (weapon space), or partway to the belt by `down`, and bend the arm to it. In a drill the
   * hand goes where the drill has it instead.
   */
  private handOn(p: V3, grip: Grip, side: 'r' | 'l', hand: THREE.Mesh, shoulder: THREE.Vector3, pole: THREE.Vector3, upper: THREE.Mesh, fore: THREE.Mesh, down = 0, dh: DrillHand | null = null) {
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
    hand.geometry = dh ? this.drillReach(dh, side, t, a, n, p, grip) : this.geo.hand[side][grip.thumb];
    // Off its grip (down at the belt, or away at work in a drill) the hand holds on the plain way.
    const on = (1 - clamp01(down)) * (dh ? 1 - dh.w * (1 - this.gripOn) : 1);
    solveArm(shoulder, t, a, n, pole, hand, upper, fore, holdOf(grip, on));
  }

  /** The free hand of a one-handed weapon: low on the left, a loose fist, barely in frame; it comes up for balance in a swing. */
  private guard(swing: number, dh: DrillHand | null = null) {
    const up = swing > 0 ? Math.sin(Math.PI * (1 - swing)) : 0;
    const t = _s.set(-0.2 - up * 0.05, -0.37 + up * 0.08, -0.33 - up * 0.05);
    t.y += this.motion.bobY * 1.2;
    const a = _a.set(0.2, 1, -0.4).normalize();
    const n = _n.set(1, 0.2, -0.3).normalize();
    this.handL.geometry = dh ? this.drillReach(dh, 'l', t, a, n, null, null) : this.geo.hand.l.wrap;
    solveArm(SHOULDER_L, t, a, n, POLE_L, this.handL, this.upperL, this.foreL);
  }

  /** Point a reused drill-hand record at this frame's drill. */
  private drillHand(out: DrillHand, d: Drill, w: number): DrillHand {
    out.d = d;
    out.w = w;
    return out;
  }

  /**
   * Move a hand's target `t`, `a`, `n` (camera space, where it would rest) to where the drill has it: partway between two
   * spots, `w` of the way from rest. Returns the hand to draw: open, closed round its own grip, or closed round whatever
   * else it has hold of. With no grip (the free hand of a one-handed weapon), rest stands for 'grip'.
   */
  private drillReach(dh: DrillHand, side: 'r' | 'l', t: THREE.Vector3, a: THREE.Vector3, n: THREE.Vector3, p: V3 | null, grip: Grip | null): THREE.BufferGeometry {
    const rp = _rp.copy(t);
    const ra = _ra.copy(a);
    const rn = _rn.copy(n);
    const at = dh.at;
    const fromOn = this.spotAt(dh.d, at.from, p, grip, rp, ra, rn, _h0);
    const toOn = this.spotAt(dh.d, at.to, p, grip, rp, ra, rn, _h1);
    // A hand's frame does not care which way along its line `a` points, so take the nearer way round.
    if (_h1.a.dot(_h0.a) < 0) _h1.a.negate();
    _h0.p.lerp(_h1.p, at.k);
    _h0.a.lerp(_h1.a, at.k).normalize();
    _h0.n.lerp(_h1.n, at.k).normalize();
    if (_h0.a.dot(a) < 0) _h0.a.negate();
    t.lerp(_h0.p, dh.w);
    a.lerp(_h0.a, dh.w).normalize();
    n.lerp(_h0.n, dh.w).normalize();
    const open = at.open * dh.w;
    this.gripOn = (fromOn ? 1 - at.k : 0) + (toOn ? at.k : 0);
    if (open > 0.5) return this.geo.open[side];
    return this.gripOn > 0.5 && grip ? this.geo.hand[side][grip.thumb] : this.geo.hand[side].wrap;
  }

  /** How much of the hand `drillReach` last placed is on its own grip (or a shift on it), 0 to 1. */
  private gripOn = 1;

  /** A drill's spot in camera space, into `out`; true if it is the hand's own grip (or a shift on it). */
  private spotAt(d: Drill, name: string, p: V3 | null, grip: Grip | null, rp: THREE.Vector3, ra: THREE.Vector3, rn: THREE.Vector3, out: typeof _h0): boolean {
    const s = name === 'grip' ? undefined : d.spots?.[name];
    const g = this.gun;
    if (!s || ('off' in s && (!p || !grip))) {
      out.p.copy(rp);
      out.a.copy(ra);
      out.n.copy(rn);
      return true;
    }
    if ('off' in s) out.p.set(p![0] + s.off[0], p![1] + s.off[1], p![2] + s.off[2]);
    else out.p.set(s.p[0], s.p[1], s.p[2]);
    out.p.applyMatrix4(g.matrix);
    const a = s.a ?? grip?.a;
    const n = s.n ?? grip?.n;
    if (a) out.a.set(a[0], a[1], a[2]).applyQuaternion(g.quaternion);
    else out.a.copy(ra);
    if (n) out.n.set(n[0], n[1], n[2]).applyQuaternion(g.quaternion);
    else out.n.copy(rn);
    return 'off' in s;
  }

  /** Turn the weapon in the hand by `k` radians about its grip's line (0 puts it back square in the hand). */
  private spin(grip: Grip, k: number) {
    const w = this.weapon!;
    if (k === 0) {
      w.position.set(0, 0, 0);
      w.quaternion.identity();
      return;
    }
    w.quaternion.setFromAxisAngle(_ax.set(grip.a[0], grip.a[1], grip.a[2]).normalize(), k);
    const pivot = _v.set(grip.p[0], grip.p[1], grip.p[2]);
    w.position.copy(pivot).sub(_w.copy(pivot).applyQuaternion(w.quaternion));
  }

  /** Move onto the camera for its view. */
  place(cam: THREE.Camera) {
    cam.matrixWorld.decompose(this.root.position, this.root.quaternion, _v);
    this.root.updateMatrixWorld(true);
  }

  /** The muzzle flash: how much of it is left this frame (the rig's own flash decides when). */
  muzzle(k: number) {
    this.flash.set(isGun(this.held) && flashes(this.held) ? k : 0);
  }

  /** The gun's points in the world as this view draws them, into the rig's `points` (call after `place`). */
  capturePoints(out: Humanoid['points']) {
    out.valid = false;
    if (!this.weapon || !isGun(this.held)) return;
    const g = GUN_POINTS[this.held];
    const w = this.weapon;
    w.updateWorldMatrix(true, false);
    w.localToWorld(this.held === 'bow' ? out.muzzle.set(g.muzzle[0], g.muzzle[1], g.muzzle[2]) : out.muzzle.copy(this.tip));
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
 * and then the forearm swings toward the line of the hand for what is left, the shoulder following. `hold` says how far
 * each goes, and how far the line slants across the palm.
 */
function solveArm(shoulder: THREE.Vector3, t: THREE.Vector3, a: THREE.Vector3, n: THREE.Vector3, pole: THREE.Vector3, hand: THREE.Mesh, upper: THREE.Mesh, fore: THREE.Mesh, hold: Hold = HOLD) {
  // The grip's frame: along the grip, the palm onto it, and the wrist toward the shoulder, so the forearm comes from there.
  const x = a.normalize();
  const z = _hz.copy(n).addScaledVector(x, -n.dot(x));
  if (z.lengthSq() < 1e-6) z.set(0, 0, 1).addScaledVector(x, -x.z);
  z.normalize();
  const y = _hy.copy(z).cross(x);
  if (y.dot(_v.copy(shoulder).sub(t)) < 0) {
    x.negate();
    y.negate();
  }
  // The hand's own frame is the grip's turned about the palm by the slant, the wrist leaning back toward the shoulder.
  const skew = x.dot(_v.copy(shoulder).sub(t)) < 0 ? hold.skew : -hold.skew;
  const cs = Math.cos(skew);
  const sn = Math.sin(skew);
  const hx = _kx;
  const hy = _ky;
  const sh = _el.copy(shoulder);
  const elbow = _x;
  const wrist = _wr;
  const place = () => {
    hx.copy(x).multiplyScalar(cs).addScaledVector(y, sn);
    hy.copy(y).multiplyScalar(cs).addScaledVector(x, -sn);
    _m.makeBasis(hx, hy, z);
    hand.quaternion.setFromRotationMatrix(_m);
    wrist.copy(WRIST).applyQuaternion(hand.quaternion).add(t);
    reachArm(sh.copy(shoulder), wrist, pole, elbow);
  };
  place();
  // Roll round the grip toward where the forearm comes from.
  const fd = _fd.copy(elbow).sub(wrist).normalize();
  const fp = _ax.copy(fd).addScaledVector(x, -fd.dot(x));
  if (fp.lengthSq() > 1e-6 && hold.roll > 0) {
    fp.normalize();
    const roll = clamp(Math.atan2(_v.copy(y).cross(fp).dot(x), y.dot(fp)), -hold.roll, hold.roll);
    y.applyAxisAngle(x, roll);
    z.applyAxisAngle(x, roll);
    place();
  }
  // Then swing the forearm toward the line of the hand, so far.
  fd.copy(elbow).sub(wrist).normalize();
  const bend = Math.acos(clamp(fd.dot(hy), -1, 1));
  if (bend > hold.bend) {
    const ax = _ax.copy(fd).cross(hy);
    if (ax.lengthSq() > 1e-8) {
      fd.applyAxisAngle(ax.normalize(), Math.min(bend - hold.bend, ARM_SWING));
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
