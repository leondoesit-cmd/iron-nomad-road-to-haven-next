import type { GunModel } from '../data/gear';
import { FRAMES, RAKE, type V3 } from './gunFrames';

/**
 * The working parts of each gun and the things the hands carry to it, as pure numbers: how a pistol's slide runs back, a
 * bolt turns up and comes back, a revolver's cylinder swings out on its crane, a double's barrels drop on their hinge, a
 * lever swings down, a belt gun's cover lifts; and where a magazine, a shell or a speedloader sits in the gun, and how a hand
 * holds it. The close-up model in `render/weapons` draws each moving part as its own mesh (`WB.piece`), and the reload
 * routines (`reloads.ts`) move them with channels (`Act`), so the parts and the hands on them always agree.
 *
 * Frames as everywhere for guns: +z down the barrel, +y up, +x to the gun's LEFT (its right side, where the ports and the
 * bolt handles are, is -x). Metres and radians.
 */

/** A routine's channels for the working parts, each 0 (home, closed) to 1 (fully worked). */
export type Act =
  /** A pistol's slide run back. */
  | 'slide'
  /** A bolt's handle turned up, and the bolt drawn back. */
  | 'boltUp'
  | 'boltBack'
  /** A pump's fore-end run back. */
  | 'pump'
  /** A charging (cocking) handle drawn back, and locked up in its notch (the roller-locked SMG). */
  | 'handle'
  | 'notch'
  /** A revolver's cylinder swung out on its crane, and its ejector rod pushed home. */
  | 'swing'
  | 'eject'
  /** A break-action's barrels dropped open. */
  | 'open'
  /** A lever swung down. */
  | 'lever'
  /** A belt gun's feed cover lifted. */
  | 'cover'
  /** A crossbow's string drawn back to the latch (1 cocked). */
  | 'cock';

export const ACTS: Act[] = ['slide', 'boltUp', 'boltBack', 'pump', 'handle', 'notch', 'swing', 'eject', 'open', 'lever', 'cover', 'cock'];

export type ActPose = Record<Act, number>;
export const newActPose = (): ActPose => ({ slide: 0, boltUp: 0, boltBack: 0, pump: 0, handle: 0, notch: 0, swing: 0, eject: 0, open: 0, lever: 0, cover: 0, cock: 0 });

/** One way a part moves with a channel: slid by `d` at full travel, or turned about `axis` through `at` by `angle`. */
export interface Move {
  act: Act;
  d?: V3;
  turn?: { axis: V3; at: V3; angle: number };
}

/** A moving part: its moves, applied in order (the first innermost), riding on the part `on` if it has one. */
export interface PartDef {
  moves: Move[];
  on?: string;
}

const slideBy = (act: Act, d: V3): Move => ({ act, d });
const turnBy = (act: Act, axis: V3, at: V3, angle: number): Move => ({ act, turn: { axis, at, angle } });

// ------------------------------------------------------------------------------------------- the parts

const pistolSlide = (travel: number): Record<string, PartDef> => ({ slide: { moves: [slideBy('slide', [0, 0, -travel])] } });

/**
 * A revolver's cylinder swings out to the left on its crane, hinged low on the frame's left under the cylinder; the
 * ejector rod and the extractor star ride on it and are pushed back to throw the cases.
 */
function revolverParts(m: 'revolver' | 'cannon'): Record<string, PartDef> {
  const f = FRAMES[m];
  const cy = f.spots!.cyl[1];
  const k = m === 'cannon' ? 1.1 : 1;
  const cr = m === 'cannon' ? 0.0213 : 0.0181;
  const at: V3 = [0.0105 * k, cy - cr - 0.002, 0];
  return {
    cyl: { moves: [turnBy('swing', [0, 0, 1], at, -1.62)] },
    star: { moves: [slideBy('eject', [0, 0, -0.021 * k])], on: 'cyl' },
  };
}

/** A side-by-side's barrels drop on the hinge pin at the front of the action, the fore-end with them. */
const doubleParts = (m: 'sawn' | 'coach'): Record<string, PartDef> => ({
  barrels: { moves: [turnBy('open', [1, 0, 0], [0, FRAMES[m].bore - 0.02, 0.034], 0.6)] },
});

/** A bolt action: the handle turned up about the bore, the bolt drawn back. */
const boltParts = (m: 'rifle' | 'sniper', back: number): Record<string, PartDef> => ({
  bolt: { moves: [turnBy('boltUp', [0, 0, 1], [0, FRAMES[m].bore, 0], -1.4), slideBy('boltBack', [0, 0, -back])] },
});

/** A charging handle run straight back from its spot to its back spot. */
const handleParts = (m: GunModel): Record<string, PartDef> => {
  const s = FRAMES[m].spots!;
  return { handle: { moves: [slideBy('handle', [0, 0, s.handleBack[2] - s.handle[2]])] } };
};

export const PARTS: Partial<Record<GunModel, Record<string, PartDef>>> = {
  pistol: pistolSlide(0.032),
  compact: pistolSlide(0.028),
  mp: pistolSlide(0.032),
  revolver: revolverParts('revolver'),
  cannon: revolverParts('cannon'),
  smg: handleParts('smg'),
  // The roller-locked gun's handle runs back in the tube's slot and is turned up into the notch at the back of it.
  smg2: { handle: { moves: [slideBy('handle', [0, 0, -0.09]), slideBy('notch', [0, 0.012, 0])] } },
  sawn: doubleParts('sawn'),
  coach: doubleParts('coach'),
  pump: { pump: { moves: [slideBy('pump', [0, 0, -0.09])] } },
  combat: { handle: { moves: [slideBy('handle', [0, 0, -0.07])] } },
  rifle: boltParts('rifle', 0.085),
  sniper: boltParts('sniper', 0.09),
  // The lever swings down about its pivot at the front of the receiver's bottom, the loop going down and forward.
  lever: { lever: { moves: [turnBy('lever', [1, 0, 0], [0, -0.019, 0.125], -0.75)] } },
  carbine: handleParts('carbine'),
  ar: { handle: { moves: [slideBy('handle', [0, 0, -0.065])] } },
  dmr: { handle: { moves: [slideBy('handle', [0, 0, -0.07])] } },
  br: handleParts('br'),
  // The feed cover lifts on its hinge at the back; the charging handle on the right runs back.
  lmg: { cover: { moves: [turnBy('cover', [1, 0, 0], [0, 0.062, -0.035], -1.15)] }, ...handleParts('lmg') },
};

// ------------------------------------------------------------------------------------------- moving points

const rot = (p: V3, axis: V3, at: V3, angle: number): V3 => {
  const [ax, ay, az] = norm(axis);
  const x = p[0] - at[0];
  const y = p[1] - at[1];
  const z = p[2] - at[2];
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const d = ax * x + ay * y + az * z;
  // Rodrigues: v cos + (k x v) sin + k (k . v)(1 - cos).
  return [
    at[0] + x * c + (ay * z - az * y) * s + ax * d * (1 - c),
    at[1] + y * c + (az * x - ax * z) * s + ay * d * (1 - c),
    at[2] + z * c + (ax * y - ay * x) * s + az * d * (1 - c),
  ];
};
const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** A point on a part moved by the channels in `act`, in the gun's frame (through the part it rides on, if any). */
export function movePoint(m: GunModel, part: string, act: Partial<ActPose>, p: V3): V3 {
  const def = PARTS[m]?.[part];
  if (!def) return p;
  let q: V3 = [p[0], p[1], p[2]];
  for (const mv of def.moves) {
    const k = act[mv.act] ?? 0;
    if (k === 0) continue;
    if (mv.d) q = [q[0] + mv.d[0] * k, q[1] + mv.d[1] * k, q[2] + mv.d[2] * k];
    else if (mv.turn) q = rot(q, mv.turn.axis, mv.turn.at, mv.turn.angle * k);
  }
  return def.on ? movePoint(m, def.on, act, q) : q;
}

/** A direction on a part turned with it. */
export function moveDir(m: GunModel, part: string, act: Partial<ActPose>, d: V3): V3 {
  const o = movePoint(m, part, act, [0, 0, 0]);
  const e = movePoint(m, part, act, d);
  return norm([e[0] - o[0], e[1] - o[1], e[2] - o[2]]);
}

// ------------------------------------------------------------------------------------------- what the hands carry

/** A hand's frame on something it holds: the middle of what it closes round, the line it closes round, the palm's facing. */
export interface Hold {
  p: V3;
  a: V3;
  n: V3;
}

/**
 * A thing the hands carry to the gun and put in it (a magazine, a shell, rounds, a speedloader) or take out of it. `geo`
 * names its mesh in the close-up model (the gun's own magazine, or a `prop:` piece drawn where it sits in the gun). `hold`
 * is the hand's frame on it while it sits in its place: a hand anywhere else carries it the same way, so a hand brought to
 * `hold` (shifted by an offset) puts it there exactly. `on` is the part it rides in (a cylinder, the barrels). `pinch`: held
 * in the fingers rather than the fist.
 */
export interface PropDef {
  geo: string;
  hold: Hold;
  on?: string;
  pinch?: boolean;
  /** The world thing it becomes when it is let go and falls out of the picture: an empty magazine, cases, hulls. */
  falls?: 'pistolMag' | 'smgMag' | 'cases' | 'hulls';
  /** How many cases fall with it. */
  count?: number;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addv = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const neg = (a: V3): V3 => [-a[0], -a[1], -a[2]];

/** The way a magazine comes out of its well (unit), and how long it is from the well's mouth to its floor. */
export interface MagLine {
  out: V3;
  len: number;
  /** The mouth of the well, and the magazine's floor when seated. */
  well: V3;
  floor: V3;
}

/** A pistol's magazine runs up the raked grip; a long gun's hangs below the well, curved forward a little. */
export function magLine(m: GunModel): MagLine {
  const f = FRAMES[m];
  if (m === 'pistol' || m === 'compact' || m === 'mp') {
    const out = neg(RAKE.pistol);
    const floor = f.spots!.floor;
    return { out, len: 0.115 + (m === 'mp' ? 0.085 : m === 'compact' ? -0.03 : 0), well: f.well, floor };
  }
  const floor: V3 = m === 'lmg' ? [0.034, -0.13, 0.115] : f.spots?.floor ?? [0, f.mag.y, f.mag.z];
  const d = sub(floor, f.well);
  // The top of a curved magazine goes in straight: the line it leaves along is its top run, not the chord to its floor.
  const out = norm([0, d[1], d[2] * 0.45]);
  return { out: m === 'lmg' ? [0, -1, 0] : out, len: Math.hypot(d[1], d[2]), well: f.well, floor };
}

/**
 * The support hand round a seated magazine: closed round its body, the thumb up toward the gun, the palm on its left face
 * (the hand comes to it from the left, the forearm back toward the body). A pistol's magazine is held near its floor (the
 * rest of it is up the grip), a long gun's round its middle below the well, a belt gun's box with the open hand on its side.
 */
function magHold(m: GunModel): Hold {
  if (m === 'lmg') return { p: [0.064 - 0.035, -0.075, 0.115], a: [0, 0, -1], n: [-1, 0, 0] };
  const L = magLine(m);
  const up = neg(L.out);
  const short = m === 'pistol' || m === 'compact' || m === 'mp';
  const p = short ? addv(L.floor, scale(up, 0.032)) : addv(L.well, scale(L.out, L.len * 0.55));
  return { p, a: up, n: [-1, 0, 0] };
}

const magProp = (m: GunModel): PropDef => ({ geo: 'mag', hold: magHold(m), falls: m === 'pistol' || m === 'compact' || m === 'mp' ? 'pistolMag' : 'smgMag' });

/** Both: an empty one coming out and a full one going in. */
const mags = (m: GunModel): Record<string, PropDef> => ({ oldMag: magProp(m), newMag: magProp(m) });

/** A revolver's cylinder: its back and front faces, how far the chambers are off its axis. */
export const CYLINDER = {
  revolver: { c0: 0.056, c1: 0.096, pitch: 0.0115, ch: 0.0047 },
  cannon: { c0: 0.054, c1: 0.1, pitch: 0.0138, ch: 0.0057 },
};
/** Where chamber `i` is on a revolver's cylinder, across it (x, y about the axis). */
export const chamberAt = (m: 'revolver' | 'cannon', i: number): [number, number] => {
  const a = (i / 6) * Math.PI * 2 + Math.PI / 2;
  const r = CYLINDER[m].pitch;
  return [Math.cos(a) * r, Math.sin(a) * r];
};

/**
 * Rounds in a revolver's chambers, the empties on the extractor star, the speedloader's ring behind them, and the rounds by
 * twos when there is no loader. The left hand comes in behind the swung-out cylinder, the fist round the loader's knob
 * (or the rounds' heads), thumb down and palm forward.
 */
function revolverProps(m: 'revolver' | 'cannon'): Record<string, PropDef> {
  const cy = FRAMES[m].spots!.cyl[1];
  const { c0 } = CYLINDER[m];
  const hold: Hold = { p: [0, cy, c0 - 0.026], a: [0, -1, 0], n: [0, 0, 1] };
  const pair = (i: number): PropDef => {
    const a = chamberAt(m, i * 2);
    const b = chamberAt(m, i * 2 + 1);
    return { geo: `prop:pair${i}`, hold: { ...hold, p: [(a[0] + b[0]) / 2, cy + (a[1] + b[1]) / 2, c0 - 0.014] }, on: 'cyl', pinch: true };
  };
  return {
    cases: { geo: 'prop:cases', hold, on: 'star', falls: 'cases', count: 6 },
    rounds: { geo: 'prop:rounds', hold, on: 'cyl' },
    loader: { geo: 'prop:loader', hold, on: 'cyl' },
    pair0: pair(0),
    pair1: pair(1),
    pair2: pair(2),
  };
}

/**
 * Two shells in a double's chambers, fired or fresh, their brass heads flush with the breech: held by the heads across the
 * fist, pointing into the breech, the palm toward it and the wrist down and back.
 */
function doubleProps(m: 'sawn' | 'coach'): Record<string, PropDef> {
  const B = FRAMES[m].bore;
  const hold: Hold = { p: [0, B, 0.034 - 0.018], a: [-1, 0, 0], n: [0, -0.3, 1] };
  return { empties: { geo: 'prop:shells', hold, on: 'barrels', falls: 'hulls', count: 2 }, fresh: { geo: 'prop:shells', hold, on: 'barrels' } };
}

/**
 * A shell for a pump's tube. Its seat is just inside the tube, in line with it, hidden in the receiver; it is brought up
 * under the loading port, pushed up into it and on forward into the tube. Held round its brass end, the palm under it.
 */
export const SHELL_LEN = 0.07;
function shellProp(m: 'pump' | 'combat'): Record<string, PropDef> {
  const f = FRAMES[m];
  return { shell: { geo: 'prop:shell', hold: { p: [0, f.mag.y, 0.13 + 0.014], a: [0, 0, 1], n: [0, 1, 0] }, pinch: true } };
}
/** Where a shell is pushed in from: under the loading port, then up in it (offsets from its seat in the tube). */
export const SHELL_PATH = { below: [0, -0.042, -0.075] as V3, port: [0, -0.008, -0.07] as V3 };

/** A cartridge's seat, as its back and its tip, in a bolt gun's open action and in a lever gun's magazine. */
export const ROUND_SEAT = {
  rifle: { back: [0, FRAMES.rifle.bore - 0.012, FRAMES.rifle.port[2] - 0.036] as V3, tip: [0, FRAMES.rifle.bore - 0.012, FRAMES.rifle.port[2] + 0.036] as V3 },
  lever: { back: [0, FRAMES.lever.mag.y, 0.128] as V3, tip: [0, FRAMES.lever.mag.y, 0.168] as V3 },
};

/**
 * A cartridge carried in the right hand's fist like a short rod, round its back, the tip ahead: pressed in through a bolt
 * gun's open port from the right (under the scope), or pushed nose first in at a lever gun's gate on its right side.
 */
function roundProp(m: 'rifle' | 'lever'): Record<string, PropDef> {
  const s = ROUND_SEAT[m];
  const p: V3 = [s.back[0], s.back[1], s.back[2] + 0.01];
  // Both come in from the right: a bolt gun's through its port under the scope, the palm toward the gun and a little down.
  const n: V3 = m === 'rifle' ? [0.85, -0.5, 0] : [0.85, 0.5, 0];
  return { round: { geo: 'prop:round', hold: { p, a: [0, 0, 1], n }, pinch: true } };
}
/** The way a cartridge goes in: from above the open action down into it, or from beside the gate in through it. */
export const ROUND_PATH = {
  rifle: { near: [-0.045, 0.014, -0.004] as V3, at: [-0.016, 0.008, 0] as V3 },
  lever: { near: [-0.034, -0.016, -0.075] as V3, at: [-0.016, -0.012, -0.05] as V3 },
};

/**
 * A crossbow's string, which the close-up model draws itself: from each limb's tip to its middle, which lies across the
 * limbs' tips when the bow is down and is drawn back to the latch when it is cocked.
 */
export const CROSSBOW_STRING = {
  tips: [
    [0.34, FRAMES.crossbow.bore - 0.012, 0.43],
    [-0.34, FRAMES.crossbow.bore - 0.012, 0.43],
  ] as [V3, V3],
  rest: [0, FRAMES.crossbow.bore - 0.012, 0.43] as V3,
  cocked: [0, FRAMES.crossbow.spots!.latch[1] - 0.004, FRAMES.crossbow.spots!.latch[2] - 0.13] as V3,
};

export const PROPS: Partial<Record<GunModel, Record<string, PropDef>>> = {
  pistol: mags('pistol'),
  compact: mags('compact'),
  mp: mags('mp'),
  smg: mags('smg'),
  smg2: mags('smg2'),
  carbine: mags('carbine'),
  ar: mags('ar'),
  dmr: mags('dmr'),
  br: mags('br'),
  sniper: mags('sniper'),
  lmg: mags('lmg'),
  revolver: revolverProps('revolver'),
  cannon: revolverProps('cannon'),
  sawn: doubleProps('sawn'),
  coach: doubleProps('coach'),
  pump: shellProp('pump'),
  combat: shellProp('combat'),
  rifle: roundProp('rifle'),
  lever: roundProp('lever'),
  // The bolt held by its shaft between the fingers from the left, laid in the groove and slid back onto the string.
  crossbow: { quarrel: { geo: 'quarrel', hold: { p: [0, FRAMES.crossbow.bore + 0.002, 0.24], a: [0, 0, -1], n: [-1, 0, 0] } } },
};

/**
 * The hand's frame that puts a prop at `off` from its seat (gun frame, metres), with the parts moved by `act`: a hand
 * keyed to this spot carries the prop exactly there.
 */
export function propSpot(m: GunModel, prop: string, off: V3 = [0, 0, 0], act: Partial<ActPose> = {}): Hold {
  const d = PROPS[m]![prop];
  const h = d.hold;
  // The offset is in the frame of the part the prop rides in, so a shell goes into a dropped barrel along its bore.
  const p = addv(h.p, off);
  if (!d.on) return { p, a: h.a, n: h.n };
  return { p: movePoint(m, d.on, act, p), a: moveDir(m, d.on, act, h.a), n: moveDir(m, d.on, act, h.n) };
}

/** A spot on a moving part (a slide's serrations, a bolt's knob, a lever's loop) where it is with the parts moved by `act`. */
export function onPart(m: GunModel, part: string, p: V3, act: Partial<ActPose>): V3 {
  return movePoint(m, part, act, p);
}

export { addv, scale, sub, norm };
