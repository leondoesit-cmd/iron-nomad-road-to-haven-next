import { clamp01, lerp, TAU } from '../core/math';
import type { GunModel, MeleeModel } from '../data/gear';
import { curve, type V3 } from './weaponanim';

/**
 * What the hands do with a weapon besides firing and reloading it, as pure routines ("drills"). Now and then at rest a hand
 * comes off its grip and settles back, a long gun is hiked back into the shoulder, a magazine is patted home, a knife is
 * rolled in the fingers. And when a gun fails to fire, the drill that clears it, the one its action needs: tap and rack on
 * a pistol, the charging handle on a rifle, the next chamber on a revolver, the pump run again, the dud pulled from a
 * break-action, the bolt slapped up off a stuck case, the feed cover thrown open on a belt gun.
 *
 * A drill is keyframes over its own time, 0 to 1: how the weapon moves in front of the body (an offset of the grip in the
 * view, metres, x right, y up, z back toward the eye; and a turn, radians: muzzle up, muzzle left, cant with the top to the
 * left (a gun about its barrel, as the wrist turns it); `spin` turns the weapon in the fingers about its grip) and where each hand goes, from spot to spot on the weapon,
 * opening its fingers on the way. Spots are in the weapon's own frame (+z down the barrel, +y up, +x to its left); 'grip'
 * is the hand's own place on it. Every drill starts and ends at rest with both hands on their grips, so it can start on
 * any frame and stop on any frame.
 */

type Key = [number, number];
export type Chan = 'x' | 'y' | 'z' | 'rx' | 'ry' | 'rz' | 'spin';
export const CHANS: Chan[] = ['x', 'y', 'z', 'rx', 'ry', 'rz', 'spin'];

/**
 * A place for a hand on the weapon: at `p` (closed round the line `a`, the palm facing `n`; the grip's own when left out),
 * or `off` its own grip by so much.
 */
export type Spot = { p: V3; a?: V3; n?: V3 } | { off: V3; a?: V3; n?: V3 };
/** A hand's keyframe: when, the spot it is at, and how far its fingers are open (0 closed round what it holds, 1 open). */
export type HandKey = [number, string, number?];
/** A sound the hands make: the action worked, the trigger clicking, a light touch, a palm on the magazine, a case out, a shell. */
export type Cue = 'rack' | 'click' | 'handle' | 'slap' | 'magOut' | 'shell';

export interface Drill {
  /** For tests and the debug readout. */
  id: string;
  secs: number;
  gun: Partial<Record<Chan, Key[]>>;
  /** The support hand and the firing hand. Left out, that hand stays on its grip. */
  l?: HandKey[];
  r?: HandKey[];
  spots?: Record<string, Spot>;
  cues?: [number, Cue, number][];
  /** When a live round or a dud leaves the gun, as shares of the drill. */
  eject?: number[];
}

/** Where a hand is in a drill: partway (`k`) from one spot to the next, its fingers `open` so far. */
export interface HandAt {
  from: string;
  to: string;
  k: number;
  open: number;
}

export type DrillPose = Record<Chan, number> & { l: HandAt; r: HandAt };

const handAtRest = (): HandAt => ({ from: 'grip', to: 'grip', k: 0, open: 0 });
export const newDrillPose = (): DrillPose => ({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, spin: 0, l: handAtRest(), r: handAtRest() });

/** The pose of a drill at `t` (0 to 1 through it). */
export function drillPose(d: Drill, t: number, out: DrillPose = newDrillPose()): DrillPose {
  const u = clamp01(t);
  for (const c of CHANS) {
    const keys = d.gun[c];
    out[c] = keys ? curve(keys, u) : 0;
  }
  handAt(d.l, u, out.l);
  handAt(d.r, u, out.r);
  return out;
}

function handAt(keys: HandKey[] | undefined, t: number, out: HandAt): HandAt {
  out.from = out.to = 'grip';
  out.k = 0;
  out.open = 0;
  if (!keys || keys.length === 0) return out;
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i];
    if (t > b[0]) continue;
    const a = keys[i - 1];
    const u = clamp01((t - a[0]) / Math.max(1e-6, b[0] - a[0]));
    out.from = a[1];
    out.to = b[1];
    out.k = u * u * (3 - 2 * u);
    out.open = lerp(a[2] ?? 0, b[2] ?? 0, out.k);
    return out;
  }
  const z = keys[keys.length - 1];
  out.from = out.to = z[1];
  out.open = z[2] ?? 0;
  return out;
}

/** How far a hand is off its grip, 0 on it to 1 away at work: a hand only shifting on its grip counts for a little. */
export function offGrip(d: Drill, h: HandAt): number {
  const w = (s: string) => (s === 'grip' ? 0 : d.spots && 'off' in d.spots[s] ? 0.3 : 1);
  return lerp(w(h.from), w(h.to), h.k);
}

// ------------------------------------------------------------------------------------------- building blocks

/** Keys from flat pairs: `k(0, 0, 0.3, 0.5, 1, 0)`. */
const k = (...v: number[]): Key[] => {
  const out: Key[] = [];
  for (let i = 0; i < v.length; i += 2) out.push([v[i], v[i + 1]]);
  return out;
};

/** From the palm's face to the middle of what the hand closes round, metres. */
const PALM = 0.035;
/** An open palm turned up under a point `b` (a magazine's floor, a tool's head), `gap` short of touching it. */
const palmUp = (b: V3, gap = 0): Spot => ({ p: [b[0], b[1] + PALM - gap, b[2]], a: [0, 0, 1], n: [0, 1, 0] });
/**
 * The support hand over the top of the weapon, closed along it with the thumb back toward the eye: on a slide, a cover. It
 * comes over from low on the left, so the palm faces down and across and the forearm runs back down out of the frame.
 */
const over = (p: V3): Spot => ({ p, a: [0, 0, -1], n: [-0.55, -0.85, 0] });
/** The support hand closed round something on the weapon's left (a cocking handle, a shell in the port), palm toward the gun. */
const leftSide = (p: V3): Spot => ({ p, a: [0, 0, -1], n: [-1, 0, 0] });
/** The support hand's palm laid flat on the weapon's left face at `s` (a cylinder, a box magazine), `gap` short of it. */
const onLeft = (s: V3, gap = 0): Spot => ({ p: [s[0] - PALM + gap, s[1], s[2]], a: [0, 0, -1], n: [-1, 0, 0] });
/** The firing hand against the weapon's right side, palm onto it. */
const rightSide = (p: V3): Spot => ({ p, a: [0, 0, -1], n: [1, 0, 0] });
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
/**
 * The firing hand round a bolt's handle at `p`, from behind with the palm forward: the handle hangs down and out to the
 * right when the bolt is shut, and stands up and out when it has been lifted.
 */
const boltHand = (p: V3, up = false): Spot => ({ p, a: up ? [-0.6, 0.75, -0.3] : [-0.75, -0.6, -0.3], n: [0.3, 0, 1] });

/**
 * Brought up to look at the trouble: lifted, canted so the ejection port (on its left) turns up toward the eye, and drawn
 * in only a little (`pull`): any closer and the elbows come up into the lens. Held from `t0` to `t1`.
 */
function assess(t0: number, t1: number, cant = 0.5, lift = 1, pull = 0.3 * lift): Drill['gun'] {
  return {
    z: k(0, 0, t0, 0.05 * pull, t1, 0.05 * pull, 1, 0),
    y: k(0, 0, t0, 0.035 * lift, t1, 0.03 * lift, 1, 0),
    x: k(0, 0, t0, -0.02 * lift, t1, -0.02 * lift, 1, 0),
    rz: k(0, 0, t0, -cant, t1, -cant * 0.9, 1, 0),
    rx: k(0, 0, t0, 0.05, t1, 0.03, 1, 0),
  };
}

// ------------------------------------------------------------------------------------------- habits at rest

/** The support hand comes off, opens and settles back on its grip. */
function supportRegrip(off: V3, secs = 1.1): Drill {
  return {
    id: 'support-regrip',
    secs,
    gun: { y: k(0, 0, 0.3, -0.006, 0.75, -0.004, 1, 0), rx: k(0, 0, 0.3, -0.03, 0.75, -0.012, 1, 0), rz: k(0, 0, 0.3, 0.045, 0.8, 0, 1, 0) },
    l: [[0, 'grip'], [0.25, 'off', 1], [0.55, 'off', 1], [0.82, 'grip'], [1, 'grip']],
    spots: { off: { off } },
    cues: [[0.8, 'handle', 0.05]],
  };
}

/** The firing hand loosens, works its way up the grip and closes again. */
function fireRegrip(off: V3 = [-0.016, -0.014, -0.004], secs = 0.9): Drill {
  return {
    id: 'fire-regrip',
    secs,
    gun: { rx: k(0, 0, 0.3, -0.055, 0.65, 0.012, 1, 0), y: k(0, 0, 0.3, -0.005, 1, 0) },
    r: [[0, 'grip'], [0.25, 'off', 0.8], [0.5, 'off', 0.8], [0.75, 'grip'], [1, 'grip']],
    spots: { off: { off } },
  };
}

/** A long gun eased forward and settled back into the shoulder, the firing hand letting the grip go a moment. */
function shoulderHike(heavy = 1, secs = 1.1): Drill {
  return {
    id: 'shoulder-hike',
    secs: secs * (0.8 + 0.2 * heavy),
    gun: {
      z: k(0, 0, 0.3, -0.035 * heavy, 0.55, 0.012 * heavy, 0.8, 0, 1, 0),
      y: k(0, 0, 0.3, 0.016 * heavy, 0.6, -0.008 * heavy, 1, 0),
      rx: k(0, 0, 0.3, 0.04, 0.6, -0.02, 1, 0),
      rz: k(0, 0, 0.3, -0.05, 0.65, 0.03, 1, 0),
    },
    r: [[0, 'grip'], [0.22, 'off', 0.6], [0.5, 'grip'], [1, 'grip']],
    spots: { off: { off: [-0.012, -0.01, 0] } },
  };
}

/** The support hand lifts off the fore-end, slides along it and takes hold again. */
function foreSlide(d = 0.06, secs = 1.2): Drill {
  return {
    id: 'fore-slide',
    secs,
    gun: { rx: k(0, 0, 0.25, -0.035, 0.6, -0.02, 1, 0), rz: k(0, 0, 0.3, 0.035, 1, 0) },
    l: [[0, 'grip'], [0.2, 'away', 1], [0.45, 'fwd', 1], [0.62, 'fwd', 0.3], [0.82, 'grip'], [1, 'grip']],
    spots: { away: { off: [0.015, -0.028, 0] }, fwd: { off: [0.01, -0.014, d] } },
    cues: [[0.8, 'handle', 0.05]],
  };
}

/** The support hand drops to the magazine's floor, pats it home twice and goes back. */
function magPat(floor: V3, secs = 1.3): Drill {
  return {
    id: 'mag-pat',
    secs,
    gun: { rz: k(0, 0, 0.25, -0.22, 0.75, -0.22, 1, 0), y: k(0, 0, 0.25, 0.02, 0.75, 0.02, 1, 0), rx: k(0, 0, 0.36, 0, 0.4, 0.02, 0.48, 0, 0.56, 0.02, 0.62, 0, 1, 0) },
    l: [[0, 'grip'], [0.25, 'low', 1], [0.38, 'hit', 1], [0.46, 'low', 0.8], [0.56, 'hit', 1], [0.66, 'low', 0.6], [0.86, 'grip'], [1, 'grip']],
    spots: { low: palmUp(floor, 0.05), hit: palmUp(floor) },
    cues: [[0.38, 'slap', 0.1], [0.56, 'slap', 0.1]],
  };
}

/** A pistol's slide eased back a finger's width to see brass in the chamber, then let home. */
function pressCheck(front: V3, secs = 1.5): Drill {
  return {
    id: 'press-check',
    secs,
    gun: assess(0.2, 0.75, 0.45, 0.9),
    l: [[0, 'grip'], [0.2, 'front', 0.4], [0.32, 'front'], [0.42, 'back'], [0.65, 'back'], [0.72, 'front'], [0.9, 'grip'], [1, 'grip']],
    spots: { front: over(front), back: over(add(front, [0, 0.002, -0.018])) },
    cues: [[0.42, 'handle', 0.08], [0.72, 'click', 0.08]],
  };
}

/** A revolver's cylinder rolled under the support thumb, a click at a time. */
function cylinderRoll(side: V3, secs = 1.3): Drill {
  return {
    id: 'cylinder-roll',
    secs,
    gun: { rz: k(0, 0, 0.25, -0.4, 0.75, -0.4, 1, 0), z: k(0, 0, 0.25, 0.02, 0.75, 0.02, 1, 0), y: k(0, 0, 0.25, 0.02, 0.75, 0.02, 1, 0) },
    l: [[0, 'grip'], [0.25, 'cyl', 0.7], [0.4, 'roll', 0.7], [0.45, 'cyl', 0.7], [0.6, 'roll', 0.7], [0.65, 'cyl', 0.7], [0.88, 'grip'], [1, 'grip']],
    spots: { cyl: onLeft(side), roll: onLeft(add(side, [0, -0.018, 0])) },
    cues: [[0.4, 'click', 0.06], [0.6, 'click', 0.06]],
  };
}

/** A pump's fore-end pressed forward to seat it, the hand taking a fresh hold. */
function pumpSettle(secs = 0.9): Drill {
  return {
    id: 'pump-settle',
    secs,
    gun: { z: k(0, 0, 0.3, -0.012, 0.55, 0.004, 1, 0), rx: k(0, 0, 0.3, -0.03, 1, 0) },
    l: [[0, 'grip'], [0.2, 'away', 0.9], [0.4, 'grip'], [0.5, 'press'], [0.65, 'grip'], [1, 'grip']],
    spots: { away: { off: [0.014, -0.022, 0.01] }, press: { off: [0, 0, 0.012] } },
    cues: [[0.5, 'handle', 0.07]],
  };
}

/** The gun turned port-up and a thumb run along the shells in the loading port, to count them. */
function portCheck(port: V3, secs = 1.4): Drill {
  return {
    id: 'port-check',
    secs,
    gun: assess(0.22, 0.72, 0.55, 0.8, 0.1),
    l: [[0, 'grip'], [0.25, 'port', 0.5], [0.4, 'along', 0.5], [0.55, 'port', 0.5], [0.85, 'grip'], [1, 'grip']],
    spots: { port: onLeft(port, 0.005), along: onLeft(add(port, [0, -0.005, 0.04]), 0.005) },
  };
}

/** A bolt's handle pressed down hard to be sure it is locked. */
function boltCheck(knob: V3, secs = 1.0): Drill {
  return {
    id: 'bolt-check',
    secs,
    gun: { rz: k(0, 0, 0.3, 0.12, 0.7, 0.12, 1, 0), rx: k(0, 0, 0.3, -0.03, 1, 0) },
    r: [[0, 'grip'], [0.28, 'knob'], [0.42, 'down'], [0.55, 'knob'], [0.8, 'grip'], [1, 'grip']],
    spots: { knob: boltHand(add(knob, [0, 0.02, 0])), down: boltHand(add(knob, [0, 0.006, 0])) },
    cues: [[0.42, 'click', 0.07]],
  };
}

/** A lever squeezed up tight against the wrist of the stock. */
function leverSqueeze(loop: V3, secs = 0.9): Drill {
  return {
    id: 'lever-squeeze',
    secs,
    gun: { rx: k(0, 0, 0.35, 0.03, 0.6, 0, 1, 0) },
    r: [[0, 'grip'], [0.3, 'loop'], [0.45, 'tight'], [0.6, 'loop'], [0.85, 'grip'], [1, 'grip']],
    spots: { loop: { p: loop }, tight: { p: add(loop, [0, 0.008, -0.01]) } },
    cues: [[0.45, 'click', 0.06]],
  };
}

/** The bolt on a crossbow's rail pressed back into the latch with two fingers. */
function railSeat(front: V3, latch: V3, secs = 1.1): Drill {
  return {
    id: 'rail-seat',
    secs,
    gun: { z: k(0, 0, 0.3, 0.03, 0.75, 0.03, 1, 0), rx: k(0, 0, 0.3, -0.04, 0.75, -0.04, 1, 0) },
    l: [[0, 'grip'], [0.28, 'front', 0.6], [0.55, 'latch', 0.6], [0.65, 'latch', 0.6], [0.88, 'grip'], [1, 'grip']],
    spots: { front: over(front), latch: over(latch) },
    cues: [[0.6, 'click', 0.07]],
  };
}

/** The weight of a heavy gun heaved up and the hands settled under it. */
function heave(secs = 1.3): Drill {
  return {
    id: 'heave',
    secs,
    gun: { y: k(0, 0, 0.25, -0.03, 0.5, 0.012, 0.75, 0, 1, 0), rx: k(0, 0, 0.25, -0.06, 0.5, 0.025, 1, 0), z: k(0, 0, 0.5, -0.015, 1, 0) },
    l: [[0, 'grip'], [0.3, 'away', 0.7], [0.5, 'grip'], [1, 'grip']],
    r: [[0, 'grip'], [0.45, 'grip'], [0.6, 'off', 0.6], [0.8, 'grip'], [1, 'grip']],
    spots: { away: { off: [0.012, -0.03, 0.02] }, off: { off: [-0.012, -0.01, 0] } },
    cues: [[0.5, 'handle', 0.08]],
  };
}

/** A box magazine's side slapped twice to settle the belt. */
function boxPat(side: V3, secs = 1.3): Drill {
  return {
    id: 'box-pat',
    secs,
    gun: { rz: k(0, 0, 0.3, -0.2, 0.75, -0.2, 1, 0), y: k(0, 0, 0.3, 0.015, 0.75, 0.015, 1, 0) },
    l: [[0, 'grip'], [0.28, 'near', 1], [0.4, 'hit', 1], [0.48, 'near', 1], [0.58, 'hit', 1], [0.68, 'near', 0.8], [0.88, 'grip'], [1, 'grip']],
    spots: { near: onLeft(side, 0.04), hit: onLeft(side) },
    cues: [[0.4, 'slap', 0.1], [0.58, 'slap', 0.1]],
  };
}

/** A bow rolled in the hand to settle the grip, the limbs swaying. */
function bowSettle(secs = 1.1): Drill {
  return { id: 'bow-settle', secs, gun: { rz: k(0, 0, 0.25, 0.14, 0.5, -0.08, 0.75, 0.04, 1, 0), y: k(0, 0, 0.3, 0.01, 0.7, -0.004, 1, 0), rx: k(0, 0, 0.35, 0.04, 1, 0) } };
}

/** The bow brought up a little to sight along the arrow on the shelf. */
function bowSight(secs = 1.4): Drill {
  return { id: 'bow-sight', secs, gun: { rx: k(0, 0, 0.3, 0.12, 0.7, 0.1, 1, 0), ry: k(0, 0, 0.3, -0.1, 0.7, -0.08, 1, 0), z: k(0, 0, 0.3, 0.04, 0.7, 0.04, 1, 0), y: k(0, 0, 0.3, 0.02, 0.7, 0.02, 1, 0) } };
}

// ---- held tools and blades

/** A knife rolled through the fingers once round its own length and caught again. */
function knifeRoll(secs = 1.0): Drill {
  return {
    id: 'knife-roll',
    secs,
    gun: { spin: k(0, 0, 0.2, 0, 0.7, TAU, 1, TAU), y: k(0, 0, 0.2, 0.02, 0.8, 0.02, 1, 0), z: k(0, 0, 0.2, 0.03, 0.8, 0.03, 1, 0), rx: k(0, 0, 0.2, 0.15, 0.8, 0.12, 1, 0) },
    r: [[0, 'grip'], [0.2, 'loose', 0.55], [0.7, 'loose', 0.55], [0.82, 'grip'], [1, 'grip']],
    spots: { loose: { off: [-0.008, -0.004, 0] } },
  };
}

/** A blade flicked over at the wrist and back, as if to loosen it up. */
function wristFlick(amp = 0.9, secs = 0.95): Drill {
  return {
    id: 'wrist-flick',
    secs,
    gun: { spin: k(0, 0, 0.25, amp, 0.45, -amp * 0.4, 0.65, amp * 0.2, 0.85, 0, 1, 0), rx: k(0, 0, 0.25, 0.08, 0.65, 0.04, 1, 0), ry: k(0, 0, 0.25, -0.1, 0.65, 0.05, 1, 0) },
    r: [[0, 'grip'], [0.2, 'loose', 0.3], [0.7, 'loose', 0.3], [0.85, 'grip'], [1, 'grip']],
    spots: { loose: { off: [-0.006, 0, 0] } },
  };
}

/** A blade turned flat in front of the eye to look along its edge. */
function edgeLook(secs = 1.6): Drill {
  return {
    id: 'edge-look',
    secs,
    gun: { rz: k(0, 0, 0.3, 1.0, 0.7, 0.95, 1, 0), ry: k(0, 0, 0.3, -0.45, 0.7, -0.4, 1, 0), rx: k(0, 0, 0.3, -0.25, 0.7, -0.22, 1, 0), z: k(0, 0, 0.3, 0.04, 0.7, 0.04, 1, 0), x: k(0, 0, 0.3, -0.04, 0.7, -0.04, 1, 0) },
  };
}

/** The head of a one-handed tool tapped into the open free palm, twice. */
function palmTap(head: V3, secs = 1.4): Drill {
  return {
    id: 'palm-tap',
    secs,
    gun: { rx: k(0, 0, 0.25, -0.75, 0.38, -0.82, 0.46, -0.75, 0.56, -0.82, 0.64, -0.75, 1, 0), x: k(0, 0, 0.25, -0.07, 0.75, -0.07, 1, 0), y: k(0, 0, 0.25, -0.02, 0.75, -0.02, 1, 0) },
    l: [[0, 'grip'], [0.25, 'near', 1], [0.38, 'hit', 1], [0.46, 'near', 1], [0.56, 'hit', 1], [0.64, 'near', 1], [0.88, 'grip'], [1, 'grip']],
    spots: { near: palmUp(head, 0.035), hit: palmUp(head) },
    cues: [[0.38, 'slap', 0.06], [0.56, 'slap', 0.06]],
  };
}

/** A two-handed haft: the top hand slides up toward the head, takes the weight and slides back, the head dipping. */
function haftSlide(d = 0.12, secs = 1.3): Drill {
  return {
    id: 'haft-slide',
    secs,
    gun: { rx: k(0, 0, 0.3, -0.25, 0.6, -0.2, 1, 0), y: k(0, 0, 0.3, -0.02, 0.6, -0.015, 1, 0) },
    r: [[0, 'grip'], [0.2, 'loose', 0.4], [0.45, 'up', 0.2], [0.6, 'up'], [0.8, 'grip'], [1, 'grip']],
    spots: { loose: { off: [-0.01, 0, 0.01] }, up: { off: [0, 0, d] } },
    cues: [[0.6, 'handle', 0.05]],
  };
}

/** Both hands loosen in turn and the handle is rolled a little in them. */
function handleRoll(secs = 1.3): Drill {
  return {
    id: 'handle-roll',
    secs,
    gun: { spin: k(0, 0, 0.25, 0.5, 0.5, -0.3, 0.75, 0.1, 1, 0), rz: k(0, 0, 0.3, 0.06, 1, 0) },
    l: [[0, 'grip'], [0.15, 'loose', 0.6], [0.45, 'grip'], [1, 'grip']],
    r: [[0, 'grip'], [0.4, 'grip'], [0.55, 'loose', 0.6], [0.85, 'grip'], [1, 'grip']],
    spots: { loose: { off: [0, -0.008, 0] } },
  };
}

/** Something heavy and loose in the hand shaken to hear it: a can's fuel, a flare's charge. */
function shake(amp = 0.12, secs = 1.0): Drill {
  return { id: 'shake', secs, gun: { rz: k(0, 0, 0.2, amp, 0.35, -amp, 0.5, amp * 0.8, 0.65, -amp * 0.5, 0.85, 0, 1, 0), y: k(0, 0, 0.2, 0.02, 0.7, 0.02, 1, 0) } };
}

// ------------------------------------------------------------------------------------------- faults and their drills

/** The pistol and the guns worked like it: where the support hand slaps the magazine and grabs the slide or the handle. */
interface RackSpots {
  /** The magazine's floor. */
  floor: V3;
  /** Where the support hand takes hold to rack the action, and where it lets go. */
  grab: Spot;
  back: Spot;
  /** A point clear of the gun on its left, so the hand goes round and not through it. */
  side: V3;
  /** How far the gun is pulled in to look at it: all the way for a handgun, hardly at all for a shouldered long gun. */
  pull?: number;
  /**
   * How far the gun comes forward off the shoulder while the action is worked, metres: a rifle's charging handle is at the
   * shooter's cheek, so it is pushed out a hand's width to be reached.
   */
  push?: number;
}

/** `assess`, with the gun pushed forward by `s.push` from `from` to `to` while the action is worked. */
function assessRack(s: RackSpots, t0: number, t1: number, cant: number, lift: number, from: number, to: number): Drill['gun'] {
  const g = assess(t0, t1, cant, lift, s.pull);
  if (s.push) {
    const z = 0.05 * (s.pull ?? lift);
    g.z = k(0, 0, t0, z, from - 0.06, z, from, -s.push, to, -s.push, to + 0.06, z, t1, z, 1, 0);
    g.y = k(0, 0, t0, 0.035 * lift, from, -0.03, to, -0.03, t1, 0.03 * lift, 1, 0);
  }
  return g;
}

/** Misfire: tap the magazine home, rack the action, the dud out of the port. */
function tapRack(s: RackSpots, secs = 1.0, id = 'tap-rack'): Drill {
  return {
    id,
    secs,
    gun: assessRack(s, 0.15, 0.8, 0.5, 1, 0.44, 0.66),
    l: [
      [0, 'grip'],
      [0.1, 'side', 1],
      [0.18, 'low', 1],
      [0.24, 'hit', 1],
      [0.3, 'low', 1],
      [0.4, 'side', 0.6],
      [0.48, 'grab'],
      [0.58, 'back'],
      [0.64, 'release', 1],
      [0.76, 'side', 0.8],
      [0.92, 'grip'],
      [1, 'grip'],
    ],
    spots: { side: { p: s.side, a: [0, 0, 1], n: [-1, 0.3, 0] }, low: palmUp(s.floor, 0.05), hit: palmUp(s.floor), grab: s.grab, back: s.back, release: over(add(spotP(s.back), [0.055, -0.01, -0.01])) },
    cues: [[0.24, 'slap', 0.24], [0.57, 'rack', 0.3]],
    eject: [0.6],
  };
}

/** A stovepipe: the case caught upright in the port is swept out with the edge of the hand, then the action is racked. */
function stovepipe(s: RackSpots, port: V3, secs = 1.25): Drill {
  return {
    id: 'stovepipe',
    secs,
    gun: assessRack(s, 0.12, 0.84, 0.6, 1, 0.52, 0.74),
    l: [
      [0, 'grip'],
      [0.12, 'side', 1],
      [0.24, 'sweepA', 1],
      [0.36, 'sweepB', 1],
      [0.46, 'side', 0.8],
      [0.56, 'grab'],
      [0.66, 'back'],
      [0.72, 'release', 1],
      [0.82, 'side', 0.8],
      [0.94, 'grip'],
      [1, 'grip'],
    ],
    spots: {
      side: { p: s.side, a: [0, 0, 1], n: [-1, 0.3, 0] },
      sweepA: onLeft(add(port, [0, 0.012, -0.08]), 0.012),
      sweepB: onLeft(add(port, [0, 0.025, 0.1]), 0.02),
      grab: s.grab,
      back: s.back,
      release: over(add(spotP(s.back), [0.055, -0.01, -0.01])),
    },
    cues: [[0.33, 'handle', 0.12], [0.65, 'rack', 0.3]],
    eject: [0.34],
  };
}

/** A double feed: looked at, the magazine tapped, the action racked three times hard, the magazine tapped home again. */
function doubleFeed(s: RackSpots, secs = 2.4): Drill {
  const rack = (t: number): HandKey[] => [
    [t, 'grab'],
    [t + 0.05, 'back'],
    [t + 0.09, 'grab', 0.2],
  ];
  return {
    id: 'double-feed',
    secs,
    gun: { ...assessRack(s, 0.1, 0.88, 0.65, 1.1, 0.4, 0.75), rx: k(0, 0, 0.1, 0.06, 0.3, 0.03, 0.36, 0.06, 0.48, 0.03, 0.6, 0.06, 0.88, 0.03, 1, 0) },
    l: [
      [0, 'grip'],
      [0.18, 'grip'],
      [0.24, 'side', 1],
      [0.28, 'low', 1],
      [0.31, 'hit', 1],
      [0.34, 'low', 1],
      [0.38, 'side', 0.5],
      ...rack(0.42),
      ...rack(0.53),
      ...rack(0.64),
      [0.77, 'side', 1],
      [0.81, 'low', 1],
      [0.84, 'hit', 1],
      [0.87, 'low', 1],
      [0.95, 'grip'],
      [1, 'grip'],
    ],
    spots: { side: { p: s.side, a: [0, 0, 1], n: [-1, 0.3, 0] }, low: palmUp(s.floor, 0.05), hit: palmUp(s.floor), grab: s.grab, back: s.back },
    cues: [[0.31, 'slap', 0.22], [0.47, 'rack', 0.3], [0.58, 'rack', 0.3], [0.69, 'rack', 0.3], [0.84, 'slap', 0.24]],
    eject: [0.48, 0.59],
  };
}

const spotP = (s: Spot): V3 => ('p' in s ? s.p : s.off);

/** The firing hand comes off the grip to rack a handle on the gun's right side, the support hand keeping the gun up. */
function rightRack(grab: V3, back: V3, secs = 1.0, id = 'right-rack', floor?: V3): Drill {
  const tap: HandKey[] = floor ? [[0, 'grip'], [0.12, 'low', 1], [0.2, 'hit', 1], [0.28, 'low', 1], [0.4, 'grip'], [1, 'grip']] : [];
  return {
    id,
    secs,
    gun: assess(0.15, 0.82, -0.3, 1, 0.2),
    l: floor ? tap : undefined,
    r: [[0, 'grip'], [0.38, 'grip'], [0.5, 'grab'], [0.62, 'back'], [0.68, 'release', 1], [0.88, 'grip'], [1, 'grip']],
    spots: { grab: rightSide(grab), back: rightSide(back), release: rightSide(add(back, [-0.04, 0.03, -0.02])), ...(floor ? { low: palmUp(floor, 0.05), hit: palmUp(floor) } : {}) },
    cues: [...(floor ? ([[0.2, 'slap', 0.22]] as [number, Cue, number][]) : []), [0.61, 'rack', 0.3]],
    eject: [0.63],
  };
}

/**
 * The roller-locked SMG's way: the cocking handle up front pulled back and locked up, then slapped down so the bolt slams
 * home.
 */
function hkSlap(floor: V3, tube: V3, secs = 1.35): Drill {
  return {
    id: 'hk-slap',
    secs,
    gun: assess(0.12, 0.85, 0.35, 1, 0.2),
    l: [
      [0, 'grip'],
      [0.12, 'low', 1],
      [0.2, 'hit', 1],
      [0.28, 'low', 1],
      [0.38, 'grab'],
      [0.48, 'back'],
      [0.56, 'lock'],
      [0.64, 'over', 1],
      [0.7, 'slap', 1],
      [0.76, 'over', 1],
      [0.92, 'grip'],
      [1, 'grip'],
    ],
    spots: {
      low: palmUp(floor, 0.05),
      hit: palmUp(floor),
      grab: leftSide(tube),
      back: leftSide(add(tube, [0, 0, -0.09])),
      lock: leftSide(add(tube, [0, 0.025, -0.09])),
      over: { p: add(tube, [0, 0.08, -0.07]), a: [0, 0, 1], n: [0, -1, 0] },
      slap: { p: add(tube, [0, 0.035, -0.06]), a: [0, 0, 1], n: [0, -1, 0] },
    },
    cues: [[0.2, 'slap', 0.22], [0.48, 'handle', 0.2], [0.7, 'rack', 0.32]],
    eject: [0.72],
  };
}

/** A revolver's dud: a flinch at the dead click, the hand settles, and the next pull turns a fresh chamber under the hammer. */
function revolverDud(secs = 0.6): Drill {
  return {
    id: 'next-chamber',
    secs,
    gun: { y: k(0, 0, 0.12, -0.012, 0.5, -0.004, 1, 0), rx: k(0, 0, 0.1, -0.07, 0.5, -0.02, 1, 0), z: k(0, 0, 0.15, 0.012, 0.6, 0, 1, 0) },
    r: [[0, 'grip'], [0.25, 'loose', 0.4], [0.55, 'grip'], [1, 'grip']],
    spots: { loose: { off: [-0.01, -0.006, 0] } },
    cues: [[0.75, 'click', 0.12]],
  };
}

/** A cylinder that will not turn: knocked out on its crane by the support thumb, turned, and closed again. */
function cylinderBind(side: V3, secs = 1.7): Drill {
  return {
    id: 'cylinder-bind',
    secs,
    gun: { ...assess(0.15, 0.85, 0.65, 1, 0.3), ry: k(0, 0, 0.15, -0.12, 0.85, -0.1, 1, 0) },
    l: [
      [0, 'grip'],
      [0.18, 'near', 0.7],
      [0.28, 'cyl', 0.7],
      [0.38, 'out', 0.7],
      [0.5, 'roll', 0.7],
      [0.6, 'out', 0.7],
      [0.72, 'cyl', 1],
      [0.9, 'grip'],
      [1, 'grip'],
    ],
    spots: { near: onLeft(side, 0.03), cyl: onLeft(side), out: onLeft(add(side, [0.025, 0, 0])), roll: onLeft(add(side, [0.025, -0.02, 0])) },
    cues: [[0.3, 'click', 0.2], [0.5, 'shell', 0.14], [0.72, 'click', 0.24]],
    eject: [0.42],
  };
}

/** A short-stroked pump: run back and forward again, hard. */
function shortStroke(travel = 0.09, secs = 0.75): Drill {
  return {
    id: 'short-stroke',
    secs,
    gun: { z: k(0, 0, 0.15, 0.005, 0.35, 0.012, 0.55, -0.005, 1, 0), rz: k(0, 0, 0.15, -0.2, 0.7, -0.2, 1, 0), rx: k(0, 0, 0.35, -0.03, 0.55, 0.02, 1, 0) },
    l: [[0, 'grip'], [0.15, 'grip'], [0.35, 'back'], [0.55, 'grip'], [1, 'grip']],
    spots: { back: { off: [0, 0, -travel] } },
    cues: [[0.35, 'rack', 0.32]],
    eject: [0.38],
  };
}

/** A shell stuck in the pump's port, picked out with the fingers before the pump is worked. */
function stuckShell(port: V3, travel = 0.09, secs = 1.6): Drill {
  return {
    id: 'stuck-shell',
    secs,
    gun: assess(0.15, 0.8, 0.7, 1, 0.2),
    l: [
      [0, 'grip'],
      [0.2, 'near', 0.6],
      [0.3, 'port'],
      [0.36, 'wiggle'],
      [0.42, 'port'],
      [0.5, 'flick', 1],
      [0.64, 'grip'],
      [0.74, 'back'],
      [0.86, 'grip'],
      [1, 'grip'],
    ],
    spots: { near: leftSide(add(port, [0.04, 0.02, 0])), port: leftSide(add(port, [0, 0.01, 0])), wiggle: leftSide(add(port, [0.005, 0.02, -0.01])), flick: leftSide(add(port, [0.06, 0.07, -0.03])), back: { off: [0, 0, -travel] } },
    cues: [[0.42, 'handle', 0.14], [0.74, 'rack', 0.32]],
    eject: [0.5],
  };
}

/** A dud in a break-action: thrown open, the shell plucked from the breech and flicked away, the gun snapped shut. */
function breakDud(breech: V3, secs = 1.5): Drill {
  return {
    id: 'break-dud',
    secs,
    gun: { rx: k(0, 0, 0.14, -0.5, 0.7, -0.5, 0.8, 0.12, 0.9, -0.03, 1, 0), z: k(0, 0, 0.14, -0.03, 0.8, -0.03, 1, 0), y: k(0, 0, 0.14, 0.01, 0.8, 0.01, 1, 0), rz: k(0, 0, 0.14, -0.2, 0.8, -0.15, 1, 0) },
    l: [[0, 'grip'], [0.14, 'grip'], [0.3, 'breech', 0.3], [0.38, 'breech'], [0.46, 'pull'], [0.54, 'flick', 1], [0.72, 'grip'], [1, 'grip']],
    r: [[0, 'grip'], [0.06, 'lever'], [0.14, 'grip'], [1, 'grip']],
    spots: { breech: over(add(breech, [0, 0.0, 0])), pull: over(add(breech, [0, 0.025, -0.03])), flick: { p: add(breech, [0.08, 0.08, -0.06]), a: [0, 0, -1], n: [-0.5, -1, 0] }, lever: { off: [0, 0.012, -0.012] } },
    cues: [[0.1, 'click', 0.22], [0.5, 'shell', 0.12], [0.8, 'click', 0.28]],
    eject: [0.54],
  };
}

/** Misfire in a bolt gun: the bolt thrown up, back and home again on a fresh round. */
function boltCycle(knob: V3, secs = 0.95): Drill {
  return {
    id: 'bolt-cycle',
    secs,
    // Off the shoulder and forward a hand's width, so the bolt comes back in front of the eye and not into it.
    gun: { rz: k(0, 0, 0.2, 0.15, 0.8, 0.15, 1, 0), rx: k(0, 0, 0.2, -0.04, 0.8, -0.03, 1, 0), z: k(0, 0, 0.18, -0.07, 0.72, -0.07, 0.9, 0, 1, 0), y: k(0, 0, 0.18, -0.025, 0.72, -0.025, 1, 0) },
    r: [[0, 'grip'], [0.2, 'down'], [0.3, 'up'], [0.45, 'back'], [0.6, 'up'], [0.7, 'down'], [0.9, 'grip'], [1, 'grip']],
    spots: { down: boltHand(knob), up: boltHand(add(knob, [0.02, 0.05, 0]), true), back: boltHand(add(knob, [0.02, 0.05, -0.075]), true) },
    cues: [[0.3, 'click', 0.12], [0.45, 'rack', 0.3]],
    eject: [0.47],
  };
}

/** A case stuck in a bolt gun's chamber: the handle slapped up with the heel of the hand, then the bolt hauled back. */
function boltStuck(knob: V3, secs = 1.5): Drill {
  return {
    id: 'stuck-case',
    secs,
    gun: { ...assess(0.15, 0.85, -0.2, 0.7, 0.15), rx: k(0, 0, 0.15, -0.05, 0.3, -0.02, 0.33, -0.08, 0.5, -0.03, 0.85, -0.03, 1, 0), z: k(0, 0, 0.15, -0.05, 0.4, -0.08, 0.82, -0.08, 0.94, 0, 1, 0), y: k(0, 0, 0.15, -0.02, 0.82, -0.02, 1, 0) },
    r: [[0, 'grip'], [0.15, 'down'], [0.22, 'under', 1], [0.3, 'strike', 1], [0.38, 'under', 0.8], [0.46, 'up'], [0.6, 'back'], [0.72, 'up'], [0.8, 'down'], [0.94, 'grip'], [1, 'grip']],
    spots: { down: boltHand(knob), under: { p: add(knob, [0.0, -0.05, 0]), a: [0, 0, 1], n: [0, 1, 0] }, strike: { p: add(knob, [0.0, -0.02, 0]), a: [0, 0, 1], n: [0, 1, 0] }, up: boltHand(add(knob, [0.02, 0.05, 0]), true), back: boltHand(add(knob, [0.02, 0.05, -0.075]), true) },
    cues: [[0.3, 'slap', 0.22], [0.6, 'rack', 0.32]],
    eject: [0.62],
  };
}

/** Misfire in a lever gun: the lever thrown down and up again. */
function leverCycle(loop: V3, secs = 0.8): Drill {
  return {
    id: 'lever-cycle',
    secs,
    gun: { rx: k(0, 0, 0.2, -0.03, 0.45, 0.04, 0.7, 0, 1, 0), z: k(0, 0, 0.45, 0.012, 1, 0) },
    r: [[0, 'grip'], [0.2, 'loop'], [0.45, 'down'], [0.68, 'loop'], [0.88, 'grip'], [1, 'grip']],
    spots: { loop: { p: loop }, down: { p: add(loop, [0, -0.07, 0.07]) } },
    cues: [[0.45, 'rack', 0.3]],
    eject: [0.47],
  };
}

/** A lever that sticks halfway: worked back, forced down hard, and closed. */
function leverJam(loop: V3, secs = 1.4): Drill {
  return {
    id: 'lever-jam',
    secs,
    gun: { ...assess(0.15, 0.85, 0.3, 0.6, 0.15), rx: k(0, 0, 0.15, -0.03, 0.3, 0.02, 0.4, -0.02, 0.55, 0.05, 0.85, 0, 1, 0) },
    r: [[0, 'grip'], [0.15, 'loop'], [0.3, 'half'], [0.38, 'loop'], [0.55, 'down'], [0.62, 'down'], [0.78, 'loop'], [0.92, 'grip'], [1, 'grip']],
    spots: { loop: { p: loop }, half: { p: add(loop, [0, -0.03, 0.03]) }, down: { p: add(loop, [0, -0.075, 0.075]) } },
    cues: [[0.3, 'click', 0.14], [0.55, 'rack', 0.32]],
    eject: [0.57],
  };
}

/** A crossbow bolt slipped off the latch: pushed back along the rail and seated. */
function boltReseat(front: V3, latch: V3, secs = 1.1): Drill {
  return { ...railSeat(front, latch, secs), id: 'bolt-reseat', cues: [[0.62, 'click', 0.2]] };
}

/** A belt gun's feed jam: the cover thrown open, the belt seated in the tray, the cover slapped shut, the handle run back. */
function feedJam(cover: V3, handle: V3, secs = 2.8): Drill {
  return {
    id: 'feed-jam',
    secs,
    gun: assess(0.1, 0.9, 0.3, 0.9, 0.2),
    l: [[0, 'grip'], [0.12, 'cover'], [0.22, 'up', 0.4], [0.3, 'up', 0.6], [0.38, 'belt'], [0.48, 'belt'], [0.56, 'up', 1], [0.64, 'shut', 1], [0.7, 'up', 1], [0.86, 'grip'], [1, 'grip']],
    r: [[0, 'grip'], [0.66, 'grip'], [0.74, 'grab'], [0.82, 'back'], [0.86, 'release', 1], [0.95, 'grip'], [1, 'grip']],
    spots: {
      cover: over(cover),
      up: over(add(cover, [0, 0.06, -0.04])),
      belt: { p: add(cover, [0.03, 0.01, -0.06]), a: [0, 0, -1], n: [-0.6, -1, 0] },
      shut: over(add(cover, [0, 0.005, -0.03])),
      grab: rightSide(handle),
      back: rightSide(add(handle, [0, 0, -0.14])),
      release: rightSide(add(handle, [-0.04, 0.03, -0.16])),
    },
    cues: [[0.22, 'handle', 0.22], [0.48, 'shell', 0.16], [0.64, 'slap', 0.28], [0.82, 'rack', 0.34]],
    eject: [0.3],
  };
}

// ------------------------------------------------------------------------------------------- per weapon

/** What a fault is called on the HUD and the drill that clears it; `cost` rounds are lost with it (thrown out, or a dud). */
export interface Fault {
  kind: 'misfire' | 'jam';
  note: string;
  drill: Drill;
  cost: number;
}

const misfire = (drill: Drill, note = 'Misfire: tap, rack', cost = 1): Fault => ({ kind: 'misfire', note, drill, cost });
const jam = (drill: Drill, note: string, cost = 1): Fault => ({ kind: 'jam', note, drill, cost });

type Holdable = GunModel | MeleeModel | 'wrench' | 'crowbar' | 'flare' | 'jerrycan';

/** Spots off the models in `render/humanoid.ts`, in each gun's own frame. */
// A slide is gripped round its middle, toward the back.
const PISTOL: RackSpots = { floor: [0, -0.092, 0.03], grab: over([0, 0.03, 0.05]), back: over([0, 0.032, 0.012]), side: [0.08, -0.02, 0.04], pull: 0.3 };
const COMPACT: RackSpots = { floor: [0, -0.078, 0.025], grab: over([0, 0.028, 0.045]), back: over([0, 0.03, 0.012]), side: [0.075, -0.02, 0.035], pull: 0.3 };
const MP: RackSpots = { floor: [0, -0.19, 0.08], grab: over([0, 0.03, 0.15]), back: over([0, 0.034, 0.07]), side: [0.08, -0.05, 0.12], pull: 0.3 };
const SMG: RackSpots = { floor: [0, -0.185, 0.14], grab: leftSide([0.034, 0.03, 0.12]), back: leftSide([0.034, 0.03, 0.03]), side: [0.09, -0.04, 0.16], pull: 0.2 };
// A rifle's charging handle: hooked at the back of the receiver and pulled straight back (shortened in view, see `push`).
const AR: RackSpots = { floor: [0, -0.183, 0.216], grab: { p: [0, 0.07, 0.0], a: [1, 0, 0], n: [0, -0.6, -0.8] }, back: { p: [0, 0.07, -0.05], a: [1, 0, 0], n: [0, -0.6, -0.8] }, side: [0.09, -0.03, 0.22], pull: 0.2, push: 0.15 };
const DMR: RackSpots = { ...AR, floor: [0, -0.195, 0.24], grab: { ...AR.grab, p: [0, 0.07, 0.02] }, back: { ...AR.back, p: [0, 0.07, -0.03] } };
const BR: RackSpots = { floor: [0, -0.195, 0.22], grab: leftSide([0.038, 0.04, 0.34]), back: leftSide([0.038, 0.04, 0.2]), side: [0.1, -0.03, 0.3], pull: 0.2 };
const RIFLE_KNOB: V3 = [-0.075, 0.0, 0.08];
const LEVER_LOOP: V3 = [0, -0.07, 0.12];
// Over the rail just above the support hand, and back along it to the latch.
const CROSSBOW_RAIL: [V3, V3] = [[0, 0.05, 0.33], [0, 0.05, 0.19]];

const PISTOL_HABITS = (front: V3) => [supportRegrip([0.036, -0.045, 0.005]), fireRegrip(), pressCheck(front)];
const LONG_HABITS = (floor: V3, heavy = 1) => [foreSlide(), shoulderHike(heavy), magPat(floor)];

/** The habits each weapon has: what its owner does with it at rest. */
export const HABITS: Record<Holdable, Drill[]> = {
  pistol: PISTOL_HABITS([0, 0.03, 0.17]),
  compact: PISTOL_HABITS([0, 0.028, 0.14]),
  revolver: [supportRegrip([0.036, -0.045, 0.005]), fireRegrip(), cylinderRoll([0.026, 0.03, 0.085])],
  cannon: [supportRegrip([0.036, -0.045, 0.005]), fireRegrip([-0.018, -0.016, -0.004]), cylinderRoll([0.029, 0.035, 0.085])],
  mp: [foreSlide(0.03, 1), fireRegrip(), magPat(MP.floor)],
  smg: LONG_HABITS(SMG.floor),
  smg2: LONG_HABITS([0, -0.185, 0.12]),
  carbine: LONG_HABITS([0, -0.18, 0.175]),
  ar: LONG_HABITS(AR.floor),
  br: LONG_HABITS(BR.floor, 1.15),
  dmr: LONG_HABITS(DMR.floor, 1.15),
  lmg: [foreSlide(0.05, 1.3), heave(), boxPat([0.05, -0.1, 0.18])],
  pump: [pumpSettle(), shoulderHike(1.1), portCheck([0.03, 0.03, 0.08])],
  combat: [pumpSettle(), shoulderHike(1.1), portCheck([0.026, 0.03, 0.1])],
  sawn: [foreSlide(0.03, 1), fireRegrip(), shoulderHike(0.7, 1)],
  coach: [foreSlide(0.06), shoulderHike(1.1), fireRegrip()],
  rifle: [foreSlide(), shoulderHike(1.2), boltCheck(RIFLE_KNOB)],
  sniper: [foreSlide(), shoulderHike(1.3), boltCheck([-0.077, -0.004, 0.08])],
  lever: [foreSlide(), shoulderHike(1.1), leverSqueeze(LEVER_LOOP)],
  crossbow: [foreSlide(0.05), railSeat(...CROSSBOW_RAIL), shoulderHike(1.1)],
  bow: [bowSettle(), bowSight()],
  knife: [knifeRoll(), wristFlick(0.7), fireRegrip([-0.012, 0, 0.01], 0.8)],
  machete: [wristFlick(), fireRegrip([-0.012, 0, 0.012], 0.85), edgeLook(1.5)],
  katana: [wristFlick(0.8), edgeLook(), fireRegrip([-0.012, 0, 0.012], 0.85)],
  bat: [handleRoll(), haftSlide(0.1)],
  pipe: [handleRoll(), haftSlide(0.12)],
  axe: [haftSlide(0.2, 1.4), handleRoll(), edgeLook(1.6)],
  sledge: [haftSlide(0.22, 1.5), handleRoll()],
  wrench: [palmTap([0, 0, 0.44]), fireRegrip([-0.012, 0, 0.012], 0.85)],
  crowbar: [palmTap([0, 0.02, 0.5]), fireRegrip([-0.012, 0, 0.012], 0.85)],
  flare: [shake(0.1), fireRegrip([-0.012, 0, 0.01], 0.8)],
  jerrycan: [shake(0.16, 1.2), fireRegrip([0, -0.012, 0], 0.9)],
};

/** How each gun fails: first its misfire, then its jams. A bow does not jam. */
export const FAULTS: Record<GunModel, Fault[]> = {
  pistol: [misfire(tapRack(PISTOL)), jam(stovepipe(PISTOL, [0.02, 0.05, 0.1]), 'Jammed: stovepipe'), jam(doubleFeed(PISTOL), 'Jammed: double feed')],
  compact: [misfire(tapRack(COMPACT, 0.95)), jam(stovepipe(COMPACT, [0.02, 0.045, 0.09]), 'Jammed: stovepipe'), jam(doubleFeed(COMPACT), 'Jammed: double feed')],
  mp: [misfire(tapRack(MP, 1.05)), jam(doubleFeed(MP, 2.3), 'Jammed: double feed')],
  revolver: [misfire(revolverDud(), 'Misfire: next chamber'), jam(cylinderBind([0.026, 0.03, 0.085]), 'Jammed: cylinder bound')],
  cannon: [misfire(revolverDud(0.65), 'Misfire: next chamber'), jam(cylinderBind([0.029, 0.035, 0.085], 1.8), 'Jammed: cylinder bound')],
  smg: [misfire(tapRack(SMG, 1.1)), jam(stovepipe(SMG, [0.025, 0.03, 0.12], 1.3), 'Jammed: stovepipe')],
  smg2: [misfire(hkSlap([0, -0.185, 0.12], [0.03, 0.05, 0.24])), jam(stovepipe({ ...SMG, floor: [0, -0.185, 0.12] }, [0.025, 0.03, 0.12], 1.3), 'Jammed: stovepipe')],
  carbine: [misfire(rightRack([-0.04, 0.03, 0.25], [-0.04, 0.03, 0.13], 1.05, 'right-rack', [0, -0.18, 0.175])), jam(rightRack([-0.04, 0.03, 0.25], [-0.04, 0.03, 0.13], 1.5, 'mag-rock', [0, -0.18, 0.175]), 'Jammed: double feed')],
  ar: [misfire(tapRack(AR, 1.1)), jam(stovepipe(AR, [0.03, 0.03, 0.2], 1.35), 'Jammed: stovepipe'), jam(doubleFeed(AR, 2.6), 'Jammed: double feed')],
  dmr: [misfire(tapRack(DMR, 1.1)), jam(stovepipe(DMR, [0.03, 0.03, 0.22], 1.35), 'Jammed: stovepipe'), jam(doubleFeed(DMR, 2.6), 'Jammed: double feed')],
  br: [misfire(tapRack(BR, 1.15)), jam(doubleFeed(BR, 2.6), 'Jammed: double feed')],
  lmg: [misfire(rightRack([-0.045, 0.02, 0.32], [-0.045, 0.02, 0.18], 1.2, 'charge'), 'Misfire: charge it'), jam(feedJam([0, 0.035, 0.3], [-0.045, 0.02, 0.32]), 'Jammed: feed jam')],
  pump: [misfire(shortStroke(), 'Short-stroked: pump it'), jam(stuckShell([0.03, 0.03, 0.08]), 'Jammed: stuck shell')],
  combat: [misfire(shortStroke(0.09, 0.7), 'Short-stroked: pump it'), jam(stuckShell([0.026, 0.03, 0.1], 0.09, 1.5), 'Jammed: stuck shell')],
  sawn: [misfire(breakDud([0.016, 0.04, 0.035]), 'Dud shell: break it open')],
  coach: [misfire(breakDud([0.016, 0.04, 0.075], 1.6), 'Dud shell: break it open')],
  rifle: [misfire(boltCycle(RIFLE_KNOB), 'Misfire: work the bolt'), jam(boltStuck(RIFLE_KNOB), 'Jammed: stuck case')],
  sniper: [misfire(boltCycle([-0.077, -0.004, 0.08], 1.0), 'Misfire: work the bolt'), jam(boltStuck([-0.077, -0.004, 0.08], 1.6), 'Jammed: stuck case')],
  lever: [misfire(leverCycle(LEVER_LOOP), 'Misfire: work the lever'), jam(leverJam(LEVER_LOOP), 'Jammed: lever stuck')],
  crossbow: [misfire(boltReseat(...CROSSBOW_RAIL), 'Bolt slipped: reseat it', 0)],
  bow: [],
};

/** How often the hands find something to do at rest: seconds between habits, and how long things must have been quiet. */
export const HABIT = { gapMin: 6, gapMax: 16, settle: 1.8 };

/** The habit to play next on `held`, from a roll 0..1, not the same one twice in a row when there is a choice. */
export function pickHabit(held: string, roll: number, last = ''): Drill | null {
  const list = HABITS[held as Holdable];
  if (!list || list.length === 0) return null;
  const pool = list.length > 1 ? list.filter((d) => d.id !== last) : list;
  return pool[Math.min(pool.length - 1, Math.floor(roll * pool.length))];
}

/**
 * What goes wrong when a gun fails to fire, from its condition and two rolls: mostly a dud round in a sound gun, more
 * often a real jam as it wears out. Null for a gun that cannot fail (a bow).
 */
export function pickFault(model: GunModel, cond: number | undefined, rollKind: number, rollWhich: number): Fault | null {
  const list = FAULTS[model];
  if (!list || list.length === 0) return null;
  const jams = list.filter((f) => f.kind === 'jam');
  const c = clamp01(cond ?? 1);
  const misfireShare = c >= 0.6 ? 0.85 : c >= 0.3 ? 0.6 : 0.4;
  if (jams.length === 0 || rollKind < misfireShare) return list[0];
  return jams[Math.min(jams.length - 1, Math.floor(rollWhich * jams.length))];
}
