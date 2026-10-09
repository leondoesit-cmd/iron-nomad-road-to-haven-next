import { clamp01, lerp } from '../core/math';
import type { GunModel } from '../data/gear';
import { FRAMES, type V3 } from './gunFrames';
import { curve } from './weaponanim';
import type { Cue, Drill, HandKey, Key, Spot } from './gunDrills';
import { ACTS, CROSSBOW_STRING, PROPS, ROUND_PATH, SHELL_PATH, addv, magLine, onPart, propSpot, scale, type Act, type ActPose, type Hold } from './gunActions';

/**
 * How each gun is reloaded, by hand, the way a body camera sees it: the gun brought in and canted so the well faces the
 * support hand, the empty magazine let fall (or stripped out and kept, when there are still rounds in it), a full one
 * fetched from the pouch on the belt, lined up, pushed home and slapped, and then the gun made ready the way its action
 * wants: a pistol's slide slingshot off the stop, an AR's bolt catch slapped, a rifle's handle run back, the roller gun's
 * handle locked up and slapped down. A revolver's cylinder swings out and is dumped muzzle up, a speedloader goes in muzzle
 * down; a double is broken open and its hulls plucked; a pump, a lever gun and a bolt rifle are fed a round at a time; the
 * belt gun's cover comes up and a new box goes on; a crossbow's string is drawn and a bolt laid on the rail.
 *
 * A routine is a hand drill (`gunDrills.ts`: the gun's movement in view and each hand's spots) plus the gun's working parts
 * (`act`, see `gunActions.ts`) and the things the hands carry (`props`: where each is, key by key). The rig in
 * `render/viewmodel.ts` plays it; this file is pure numbers.
 */

/** Where a carried thing is: in the gun (shifted by an offset from its seat), in a hand, falling free, or put away. */
export type Where = 'gun' | 'l' | 'r' | 'drop' | 'off';
export type PropKey = [number, Where, V3?];

export interface Reload extends Drill {
  /** The carried things, keyed by name (see `PROPS`): from each key on it is where that key says. */
  props?: Record<string, PropKey[]>;
}

/** How a gun is loaded: all at once, or a round at a time between opening the action and closing it. */
export interface ReloadSet {
  /** All at once: with rounds still in the gun (a tactical reload, the old magazine kept), and empty. */
  tac?: Reload;
  empty?: Reload;
  /** A revolver with no speedloader fitted is loaded by hand, two rounds at a time. */
  byHand?: Reload;
  /** A round at a time: the gun turned to load, one round (played once a round), and back up (or the first chambered). */
  open?: Reload;
  each?: Reload;
  close?: Reload;
  closeEmpty?: Reload;
}

/** The shares of a staged reload's time: opening the action and closing it, each as a share of the gun's reload time. */
export const STAGE = { open: 0.12, close: 0.09, closeEmpty: 0.15 };

// ------------------------------------------------------------------------------------------- building blocks

const k = (...v: number[]): Key[] => {
  const out: Key[] = [];
  for (let i = 0; i < v.length; i += 2) out.push([v[i], v[i + 1]]);
  return out;
};
const PALM = 0.035;
const spot = (h: Hold): { p: V3; a: V3; n: V3 } => ({ p: h.p, a: h.a, n: h.n });
/** The gun's frame turned into the view's (x right, y up, z back), for a gun held level ahead. */
const toCam = (v: V3): V3 => [-v[0], v[1], -v[2]];
/**
 * A pouch on the body, below the picture: the hand there holds what it carries the way it will hold it at the gun, so it
 * comes up already turned right.
 */
const pouch = (at: V3, h: Hold): Spot => ({ cam: at, a: toCam(h.a), n: toCam(h.n) });
/** The magazine pouches, low on the left of the belt; the dump pouch further back; the right hand's at the right hip. */
const POUCH_L: V3 = [-0.13, -0.5, -0.1];
const DUMP_L: V3 = [-0.17, -0.52, -0.02];
const POUCH_R: V3 = [0.16, -0.5, -0.08];
/** An open palm turned up under a point, `gap` short of touching it. */
const palmUp = (b: V3, gap = 0): Spot => ({ p: [b[0], b[1] + PALM - gap, b[2]], a: [0, 0, 1], n: [0, 1, 0] });
/** The support hand over the top of the weapon, closed along it with the thumb back toward the eye. */
const over = (p: V3): Spot => ({ p, a: [0, 0, -1], n: [-0.55, -0.85, 0] });
/** The support hand closed round something on the weapon's left, palm toward the gun. */
const leftSide = (p: V3): Spot => ({ p, a: [0, 0, -1], n: [-1, 0, 0] });
/** The support hand's palm laid flat on the weapon's left face at `s`, `gap` short of it. */
const onLeft = (s: V3, gap = 0): Spot => ({ p: [s[0] - PALM + gap, s[1], s[2]], a: [0, 0, -1], n: [-1, 0, 0] });
/** The firing hand against the weapon's right side, palm onto it. */
const rightSide = (p: V3): Spot => ({ p, a: [0, 0, -1], n: [1, 0, 0] });
/** The firing hand round a bolt's handle from behind, palm forward: hanging down and out when shut, standing up when lifted. */
const boltHand = (p: V3, up = false): Spot => ({ p, a: up ? [-0.6, 0.75, -0.3] : [-0.75, -0.6, -0.3], n: [0.3, 0, 1] });
const SP = (m: GunModel, s: string): V3 => FRAMES[m].spots![s];
const HANDGUNS: GunModel[] = ['pistol', 'compact', 'mp'];

/** The gun's movement in view, keyed: each channel through the same times, each with its own values. */
function moves(times: number[], ch: Partial<Record<'x' | 'y' | 'z' | 'rx' | 'ry' | 'rz', number[]>>): Drill['gun'] {
  const out: Drill['gun'] = {};
  for (const [c, vals] of Object.entries(ch) as [keyof Drill['gun'], number[]][]) out[c] = times.map((t, i) => [t, vals[i]] as Key);
  return out;
}

// ------------------------------------------------------------------------------------------- magazine guns

/** How the gun is made ready when it was run empty. */
type Charge = 'slide' | 'catch' | 'handleL' | 'handleR' | 'hk' | 'bolt';

interface MagOpts {
  /** The empty one is pulled out by the hand and dropped (an AK's, a roller gun's), not let fall from the well. */
  strip: boolean;
  charge: Charge;
}

const MAG_OPTS: Partial<Record<GunModel, MagOpts>> = {
  pistol: { strip: false, charge: 'slide' },
  compact: { strip: false, charge: 'slide' },
  mp: { strip: false, charge: 'slide' },
  smg: { strip: true, charge: 'handleL' },
  smg2: { strip: true, charge: 'hk' },
  carbine: { strip: true, charge: 'handleR' },
  ar: { strip: false, charge: 'catch' },
  dmr: { strip: false, charge: 'catch' },
  br: { strip: true, charge: 'handleL' },
  sniper: { strip: true, charge: 'bolt' },
};

/** Where the gun is held for a magazine change: a handgun drawn in and raised, a long gun eased forward off the shoulder. */
const MAG_POSE = {
  hand: { x: -0.045, y: 0.06, z: 0.05, rx: 0.15, ry: 0.05, rz: -0.5 },
  // A long gun comes up off the hip and across the body, muzzle up and to the left, rolled so the well faces the eye.
  long: { x: -0.06, y: 0.085, z: -0.04, rx: 0.22, ry: 0.32, rz: -0.5 },
};
/** And while it is made ready: a slide slingshot nearly upright, an AR's catch and a left handle with the gun eased back level, a right handle with it rolled the other way. */
const READY_POSE: Record<Charge, { x: number; y: number; z: number; rx: number; ry: number; rz: number }> = {
  slide: { x: -0.035, y: 0.05, z: 0.03, rx: 0.08, ry: 0.0, rz: -0.18 },
  catch: { x: -0.05, y: 0.06, z: -0.01, rx: 0.1, ry: 0.22, rz: -0.25 },
  handleL: { x: -0.05, y: 0.06, z: -0.01, rx: 0.08, ry: 0.2, rz: -0.3 },
  handleR: { x: -0.02, y: 0.05, z: -0.02, rx: 0.06, ry: 0.1, rz: 0.35 },
  hk: { x: -0.05, y: 0.06, z: -0.01, rx: 0.08, ry: 0.2, rz: -0.3 },
  // Pushed well out: the bolt comes back a hand's width toward the eye.
  bolt: { x: -0.02, y: 0.05, z: -0.11, rx: 0.12, ry: 0.15, rz: 0.3 },
};
/** How much of the routine making ready takes (with the hand going back to the gun after). */
const CHARGE_SHARE: Record<Charge | 'none', number> = { slide: 0.34, catch: 0.27, handleL: 0.3, handleR: 0.32, hk: 0.27, bolt: 0.36, none: 0.2 };

/**
 * A magazine change. Empty: the old one falls free (or is stripped and dropped), a full one comes up from the pouch, is
 * pushed home and slapped, and the gun is made ready. Tactical: the old one is stripped into the hand and stowed in the
 * dump pouch on the way to a full one; nothing to make ready.
 */
function magChange(m: GunModel, empty: boolean, secs = 1): Reload {
  const o = MAG_OPTS[m]!;
  const L = magLine(m);
  const out = (d: number): V3 => scale(L.out, d);
  const old = PROPS[m]!.oldMag.hold;
  const hand = HANDGUNS.includes(m);
  const at = (d: number): Spot => spot(propSpot(m, 'oldMag', out(d)));
  const floor = L.floor;
  const pushed = hand ? 0.028 : 0.014;
  const spots: Record<string, Spot> = {
    onMag: at(hand ? 0.045 : 0),
    stripped: at(hand ? 0.09 : 0.075),
    pouch: pouch(POUCH_L, old),
    dump: pouch(DUMP_L, old),
    entry: at(hand ? 0.07 : 0.06),
    push: at(pushed),
    low: palmUp(addv(floor, out(0.04))),
    slap: palmUp(floor),
  };
  const strip = !empty || o.strip;
  const charge = empty ? o.charge : null;
  // A roller gun's handle is locked back before its magazine comes out, so the slap at the end chambers a round.
  const hkFirst = charge === 'hk';
  const head = hkFirst ? 0.16 : 0;
  const tail = CHARGE_SHARE[charge ?? 'none'];
  // The change itself, in its own shares, laid into the time between the start (and the HK's lock) and making ready.
  const T = strip
    ? { release: 0.14, held: 0.16, out: 0.25, pouch: 0.46, entry: 0.68, push: 0.8, low: 0.88, slap: 1 }
    : { release: 0.12, held: -1, out: 0.18, pouch: 0.38, entry: 0.64, push: 0.77, low: 0.86, slap: 1 };
  const span = 1 - head - tail;
  const t = Object.fromEntries(Object.entries(T).map(([n, v]) => [n, v < 0 ? v : head + v * span])) as typeof T;
  const l: HandKey[] = [[0, 'grip']];
  const r: HandKey[] = [];
  const act: Partial<Record<Act, Key[]>> = {};
  const cues: [number, Cue, number][] = [];
  if (hkFirst) {
    const tube = SP(m, 'tube');
    spots.hkGrab = leftSide(tube);
    spots.hkBack = leftSide(onPart(m, 'handle', tube, { handle: 1 }));
    spots.hkLock = leftSide(onPart(m, 'handle', tube, { handle: 1, notch: 1 }));
    l.push([0.03, 'grip'], [0.07, 'hkGrab'], [0.11, 'hkBack'], [0.135, 'hkLock'], [0.15, 'hkLock', 0.8]);
    act.handle = k(0, 0, 0.07, 0, 0.11, 1);
    act.notch = k(0, 0, 0.11, 0, 0.135, 1);
    cues.push([0.11, 'handle', 0.2], [0.135, 'click', 0.14]);
  }
  // The old magazine.
  let oldKeys: PropKey[];
  if (!strip) {
    // Let fall from the well, muzzle a little up: it slides out of the grip under its own weight.
    oldKeys = [[0, 'gun'], [t.release, 'gun', out(0)], [t.out, 'gun', out(0.03)], [t.out + 0.001, 'drop']];
    l.push([t.release, 'grip']);
  } else {
    // Stripped: the hand closes on it, pulls it out and either drops it (empty) or takes it to the dump pouch (tactical).
    if (!hkFirst) l.push([Math.max(0.02, t.release - 0.07), 'grip']);
    l.push([t.release, 'onMag', hand ? 0.4 : 0]);
    if (hand) oldKeys = [[0, 'gun'], [t.release, 'gun', out(0)], [t.held, 'gun', out(0.045)], [t.held + 0.001, 'l']];
    else oldKeys = [[0, 'gun'], [t.held, 'l']];
    l.push([t.out, 'stripped']);
    if (empty) oldKeys.push([t.out + 0.02, 'drop']);
    else {
      const d = (t.out + t.pouch) / 2;
      l.push([d, 'dump']);
      oldKeys.push([d, 'off']);
    }
  }
  cues.push([t.release, 'magOut', 0.22]);
  // The new one: from the pouch, lined up under the well, pushed in, then slapped home with the heel of the open hand.
  l.push([t.pouch, 'pouch'], [t.entry, 'entry'], [t.push, 'push'], [t.low, 'low', 1], [t.slap, 'slap', 1]);
  const newKeys: PropKey[] = [[0, 'off'], [t.pouch, 'l'], [t.push, 'l'], [t.push + 0.001, 'gun', out(pushed)], [t.low, 'gun', out(pushed)], [t.slap, 'gun', out(0)]];
  cues.push([t.push, 'handle', 0.1], [t.slap, 'slap', 0.26]);
  // Making ready, in its own shares of the tail (`c(0)` just after the slap, `c(1)` the end of the routine).
  const c = (x: number) => t.slap + x * tail;
  let ready = c(0.25);
  let settle = c(0.55);
  if (charge) {
    switch (charge) {
      case 'slide': {
        // Slingshot: over the top of the slide where it is locked back, a short pull, let go.
        const sl = SP(m, 'slide');
        const back = onPart(m, 'slide', sl, { slide: 1 });
        // Up the gun's left side from the slap, the hand cupped, then over the top of the slide from behind.
        spots.side = over(addv(back, [0.05, -0.012, -0.012]));
        spots.grab = over([back[0], back[1], back[2] + 0.004]);
        spots.pull = over(onPart(m, 'slide', sl, { slide: 1.08 }));
        spots.release = over(addv(onPart(m, 'slide', sl, { slide: 1.08 }), [0.035, 0.012, -0.018]));
        l.push([c(0.18), 'side', 0.25], [c(0.34), 'grab'], [c(0.46), 'pull'], [c(0.52), 'release', 0.8]);
        act.slide = k(0, 1, c(0.34), 1, c(0.46), 1.08, c(0.49), 1.08, c(0.53), 0, 1, 0);
        cues.push([c(0.52), 'rack', 0.3]);
        ready = c(0.25);
        settle = c(0.56);
        break;
      }
      case 'catch': {
        // The bolt catch on the left of the lower, slapped with the palm: the bolt runs home.
        const f = FRAMES[m];
        const kk = m === 'dmr' ? 1.1 : 1;
        const ck: V3 = [0.0113 * kk + 0.002, f.bore - 0.0165 * kk - 0.007, f.well[2] - 0.034];
        spots.catchNear = onLeft(ck, 0.025);
        spots.catchHit = onLeft(ck, 0.004);
        l.push([c(0.25), 'catchNear', 1], [c(0.38), 'catchHit', 1], [c(0.52), 'catchNear', 0.8]);
        cues.push([c(0.38), 'rack', 0.3]);
        ready = c(0.2);
        settle = c(0.52);
        break;
      }
      case 'handleL': {
        // The cocking handle on the left: hooked, run back to its stop, let go to slam home.
        const h = SP(m, 'handle');
        const hb = onPart(m, 'handle', h, { handle: 1 });
        spots.hGrab = leftSide(h);
        spots.hBack = leftSide(hb);
        spots.hLet = leftSide(addv(hb, [0.04, 0.01, 0]));
        l.push([c(0.22), 'hGrab'], [c(0.42), 'hBack'], [c(0.52), 'hLet', 1]);
        act.handle = k(0, 0, c(0.22), 0, c(0.42), 1, c(0.5), 1, c(0.56), 0, 1, 0);
        cues.push([c(0.42), 'handle', 0.18], [c(0.56), 'rack', 0.3]);
        settle = c(0.56);
        break;
      }
      case 'handleR': {
        // The bolt handle on the right, worked by the firing hand while the support hand goes back to the gun.
        const h = SP(m, 'handle');
        const hb = onPart(m, 'handle', h, { handle: 1 });
        spots.hGrabR = rightSide(h);
        spots.hBackR = rightSide(hb);
        spots.hLetR = rightSide(addv(hb, [-0.04, 0.02, -0.01]));
        r.push([0, 'grip'], [c(0.08), 'grip'], [c(0.3), 'hGrabR'], [c(0.48), 'hBackR'], [c(0.56), 'hLetR', 1], [c(0.85), 'grip'], [1, 'grip']);
        act.handle = k(0, 0, c(0.3), 0, c(0.48), 1, c(0.54), 1, c(0.59), 0, 1, 0);
        cues.push([c(0.48), 'handle', 0.18], [c(0.59), 'rack', 0.3]);
        ready = c(0.2);
        settle = c(0.6);
        break;
      }
      case 'hk': {
        // Slapped down out of its notch with the flat of the hand: the bolt slams home.
        const tube = SP(m, 'tube');
        const back = onPart(m, 'handle', tube, { handle: 1, notch: 1 });
        // The flat of the hand down on the knob sticking out of the tube's left, the forearm in from the left. Palm down,
        // the palm lies a palm's depth above the hand's middle: on the knob's top, the middle is below it.
        spots.hkOver = { p: addv(back, [0.014, 0.01, 0.004]), a: [0, 0, -1], n: [0, -1, 0] };
        spots.hkSlap = { p: addv(back, [0.014, 0.006 - PALM, 0.002]), a: [0, 0, -1], n: [0, -1, 0] };
        l.push([c(0.25), 'hkOver', 1], [c(0.4), 'hkSlap', 1], [c(0.55), 'hkOver', 1]);
        act.handle!.push([c(0.38), 1], [c(0.46), 0], [1, 0]);
        act.notch!.push([c(0.36), 1], [c(0.4), 0], [1, 0]);
        cues.push([c(0.42), 'rack', 0.32]);
        settle = c(0.55);
        break;
      }
      case 'bolt': {
        // A bolt gun run dry: its bolt worked by the firing hand once the magazine is in.
        const knob = SP(m, 'knob');
        spots.kDown = boltHand(knob);
        spots.kUp = boltHand(onPart(m, 'bolt', knob, { boltUp: 1 }), true);
        spots.kBack = boltHand(onPart(m, 'bolt', knob, { boltUp: 1, boltBack: 1 }), true);
        r.push([0, 'grip'], [c(0.05), 'grip'], [c(0.22), 'kDown'], [c(0.33), 'kUp'], [c(0.45), 'kBack'], [c(0.57), 'kUp'], [c(0.66), 'kDown'], [c(0.86), 'grip'], [1, 'grip']);
        act.boltUp = k(0, 0, c(0.22), 0, c(0.33), 1, c(0.57), 1, c(0.66), 0, 1, 0);
        act.boltBack = k(0, 0, c(0.33), 0, c(0.45), 1, c(0.57), 0, 1, 0);
        cues.push([c(0.33), 'click', 0.12], [c(0.45), 'rack', 0.3], [c(0.57), 'rack', 0.24]);
        ready = c(0.15);
        settle = c(0.62);
        break;
      }
    }
  }
  const back = Math.min(0.97, settle + 0.2 * tail + 0.06);
  l.push([back, 'grip'], [1, 'grip']);
  // The gun: into the change pose, held through the slap, (turned for making ready,) and back.
  const P = hand ? MAG_POSE.hand : MAG_POSE.long;
  const R = charge ? READY_POSE[charge] : null;
  const tIn = Math.max(0.06, Math.min(t.release, 0.12)) + head * 0.5;
  const times = R ? [0, tIn, t.slap, ready, settle, 1] : [0, tIn, t.slap, settle, 1];
  const ch = (key: keyof typeof P) => (R ? [0, P[key], P[key], R[key], R[key] * 0.7, 0] : [0, P[key], P[key], P[key] * 0.35, 0]);
  return {
    id: `${m}-${empty ? 'empty' : 'tactical'}`,
    secs,
    gun: moves(times, { x: ch('x'), y: ch('y'), z: ch('z'), rx: ch('rx'), ry: ch('ry'), rz: ch('rz') }),
    l,
    r: r.length ? r : undefined,
    spots,
    act,
    props: { oldMag: oldKeys, newMag: newKeys },
    cues,
  };
}

/**
 * The belt gun: the cover thrown up, the box and its belt off, a new box on, its belt laid in the tray, the cover slapped
 * shut; run empty, the handle on the right charged.
 */
function beltChange(empty: boolean, secs = 1): Reload {
  const m: GunModel = 'lmg';
  const old = PROPS.lmg!.oldMag.hold;
  const cover = SP(m, 'cover');
  // Lifted by its middle, not its far end: the hand stays low over the gun.
  const coverUp = onPart(m, 'cover', addv(cover, [0, 0.004, 0.015]), { cover: 1 });
  const box = (d: V3): Spot => spot(propSpot(m, 'oldMag', d));
  const spots: Record<string, Spot> = {
    latch: over(addv(cover, [0, -0.02, -0.08])),
    lift: over(addv(cover, [0, -0.018, 0.06])),
    up: { p: coverUp, a: [0, 0, -1], n: [-0.4, -0.3, 0.85] },
    onBox: box([0, 0, 0]),
    boxOut: box([0.02, -0.07, 0]),
    pouch: pouch(POUCH_L, old),
    dump: pouch(DUMP_L, old),
    boxEntry: box([0.01, -0.06, 0]),
    boxIn: box([0, -0.004, 0]),
    tray: { p: addv(cover, [0.03, 0.0, 0.01]), a: [0, 0, -1], n: [-0.6, -1, 0] },
    // The palm slapped down flat on the shut cover (its middle a palm's depth under it).
    shut: over(addv(cover, [0, -0.022, 0.05])),
  };
  const l: HandKey[] = [
    [0, 'grip'],
    [0.05, 'grip'],
    [0.1, 'latch'],
    [0.13, 'lift', 0.4],
    [0.19, 'up', 0.6],
    [0.26, 'onBox'],
    [0.33, 'boxOut'],
    [empty ? 0.37 : 0.4, empty ? 'boxOut' : 'dump'],
    [0.5, 'pouch'],
    [0.6, 'boxEntry'],
    [0.66, 'boxIn'],
    [0.72, 'tray', 0.3],
    [0.76, 'tray'],
    [0.8, 'up', 1],
    [0.85, 'shut', 1],
    [0.9, 'shut', 0.6],
    [0.97, 'grip'],
    [1, 'grip'],
  ];
  const r: HandKey[] = [[0, 'grip']];
  const cues: [number, Cue, number][] = [[0.13, 'click', 0.18], [0.19, 'handle', 0.14], [0.3, 'magOut', 0.24], [0.66, 'slap', 0.28], [0.75, 'shell', 0.16], [0.85, 'slap', 0.3]];
  if (empty) {
    const h = SP(m, 'handle');
    spots.hGrabR = rightSide(h);
    spots.hBackR = rightSide(onPart(m, 'handle', h, { handle: 1 }));
    r.push([0.86, 'grip'], [0.9, 'hGrabR'], [0.94, 'hBackR'], [0.97, 'hGrabR', 0.6], [1, 'grip']);
    cues.push([0.94, 'rack', 0.32]);
  }
  return {
    id: `lmg-${empty ? 'empty' : 'tactical'}`,
    secs,
    // Up off the hip and across, the cover and the box on the left turned up to the eye.
    gun: moves([0, 0.08, 0.86, 1], { x: [0, -0.06, -0.06, 0], y: [0, 0.08, 0.08, 0], z: [0, -0.06, -0.06, 0], rx: [0, 0.2, 0.2, 0], ry: [0, 0.32, 0.32, 0], rz: [0, -0.2, -0.2, 0] }),
    l,
    r: empty ? r : undefined,
    spots,
    act: {
      cover: k(0, 0, 0.13, 0, 0.19, 1, 0.8, 1, 0.85, 0, 1, 0),
      ...(empty ? { handle: k(0, 0, 0.9, 0, 0.94, 1, 0.97, 0, 1, 0) } : {}),
    },
    props: { oldMag: [[0, 'gun'], [0.26, 'l'], ...(empty ? ([[0.37, 'drop']] as PropKey[]) : ([[0.4, 'off']] as PropKey[]))], newMag: [[0, 'off'], [0.5, 'l'], [0.66, 'l'], [0.661, 'gun', [0, -0.004, 0]], [0.7, 'gun', [0, 0, 0]]] },
    cues,
  };
}

// ------------------------------------------------------------------------------------------- revolvers

/**
 * A revolver: the cylinder thrown out with the support thumb and the muzzle tipped up, the rod punched so the empties fall,
 * the muzzle down, the rounds in (a speedloader's six at once, its knob turned to let them go, or by hand two at a time),
 * and the cylinder closed with the support hand.
 */
function revolverReload(m: 'revolver' | 'cannon', loader: boolean, secs = 1): Reload {
  const cy = SP(m, 'cyl');
  const out = { swing: 1 };
  const rounds = (d: V3, name = 'rounds'): Spot => spot(propSpot(m, name, d, out));
  const cylSide = onPart(m, 'cyl', cy, out);
  const spots: Record<string, Spot> = {
    // The support thumb on the latch and the fingers pushing the cylinder out from the right through the frame.
    push: onLeft(addv(cy, [0, 0.004, -0.004]), 0.004),
    // Holding it out: the fingers round the cylinder from the left, the thumb on the rod's head; the thumb punches the rod.
    holdOut: onLeft(cylSide, 0.006),
    holdPush: onLeft(addv(cylSide, [0, 0, -0.016]), 0.006),
    pouch: pouch(POUCH_L, PROPS[m]!.rounds.hold),
    near: rounds([0, 0, -0.035]),
    in: rounds([0, 0, 0]),
    twist: rounds([0, 0, -0.002]),
    away: rounds([0.01, -0.02, -0.07]),
    close: onLeft(addv(cylSide, [-0.004, 0, 0]), 0.004),
    shut: onLeft(addv(cy, [0, 0, 0]), 0.004),
  };
  // Up in front of the chest, the muzzle tipped up to dump the empties; then brought up and in, the muzzle a little down and
  // the gun rolled, so the eye looks past the frame into the open cylinder's chambers while the support hand feeds them.
  const gun = (load: number[]) =>
    moves([0, 0.06, 0.14, 0.24, 0.32, 0.42, ...load, 1], {
      x: [0, -0.03, -0.04, -0.04, -0.04, -0.08, ...load.map(() => -0.08), 0],
      y: [0, 0.03, 0.05, 0.06, 0.06, 0.08, ...load.map(() => 0.08), 0],
      z: [0, 0.03, 0.02, 0.01, 0.01, 0.02, ...load.map(() => 0.02), 0],
      rx: [0, 0.1, 0.5, 0.65, 0.5, -0.15, ...load.map(() => -0.12), 0],
      rz: [0, -0.3, -0.4, -0.35, -0.4, -0.6, ...load.map(() => -0.6), 0],
    });
  const cues: [number, Cue, number][] = [[0.09, 'click', 0.2], [0.27, 'handle', 0.18]];
  const props: Record<string, PropKey[]> = { cases: [[0, 'gun'], [0.27, 'drop']], rounds: [[0, 'off']] };
  const l: HandKey[] = [[0, 'grip'], [0.04, 'push', 0.3], [0.12, 'holdOut', 0.3], [0.21, 'holdOut', 0.3], [0.26, 'holdPush', 0.3], [0.31, 'holdOut', 0.3]];
  let load: number[];
  if (loader) {
    l.push([0.46, 'pouch'], [0.6, 'near'], [0.66, 'in'], [0.7, 'twist'], [0.76, 'away', 0.6], [0.84, 'close', 0.6], [0.9, 'shut', 0.6], [0.97, 'grip'], [1, 'grip']);
    props.rounds = [[0, 'off'], [0.46, 'l'], [0.66, 'l'], [0.661, 'gun']];
    props.loader = [[0, 'off'], [0.46, 'l'], [0.76, 'l'], [0.761, 'drop']];
    cues.push([0.66, 'shell', 0.2], [0.7, 'click', 0.12], [0.9, 'click', 0.24]);
    load = [0.86, 0.92];
  } else {
    // Two at a time: three trips to the dump pouch's loose rounds, each pair to its own two chambers.
    const trip = (i: number, t0: number) => {
      spots[`near${i}`] = rounds([0, 0, -0.03], `pair${i}`);
      spots[`in${i}`] = rounds([0, 0, 0], `pair${i}`);
      spots[`pouch${i}`] = pouch(POUCH_L, PROPS[m]![`pair${i}`].hold);
      l.push([t0, `pouch${i}`], [t0 + 0.07, `near${i}`], [t0 + 0.1, `in${i}`]);
      props[`pair${i}`] = [[0, 'off'], [t0, 'l'], [t0 + 0.1, 'l'], [t0 + 0.101, 'gun']];
      cues.push([t0 + 0.1, 'shell', 0.18]);
    };
    trip(0, 0.42);
    trip(1, 0.57);
    trip(2, 0.72);
    l.push([0.86, 'close', 0.6], [0.91, 'shut', 0.6], [0.97, 'grip'], [1, 'grip']);
    cues.push([0.91, 'click', 0.24]);
    load = [0.86, 0.92];
  }
  return {
    id: `${m}-${loader ? 'speedloader' : 'by-hand'}`,
    secs,
    gun: gun(load),
    l,
    spots,
    act: { swing: k(0, 0, 0.06, 0, 0.12, 1, loader ? 0.86 : 0.87, 1, 0.91, 0, 1, 0), eject: k(0, 0, 0.21, 0, 0.26, 1, 0.3, 0, 1, 0) },
    props,
    cues,
  };
}

// ------------------------------------------------------------------------------------------- break-actions

/**
 * A side-by-side: the top lever thumbed over, the barrels pushed down open; the sawn-off's ejectors throw its hulls, the
 * coach gun's are plucked out and flicked away; two fresh shells from the pouch, into the chambers, and the gun snapped
 * shut by lifting the barrels.
 */
function breakReload(m: 'sawn' | 'coach', secs = 1): Reload {
  const open = { open: 1 };
  const sh = (name: string, d: V3): Spot => spot(propSpot(m, name, d, open));
  const support = FRAMES[m].support!;
  const ejectors = m === 'sawn';
  const spots: Record<string, Spot> = {
    foreOpen: { p: onPart(m, 'barrels', support, open), a: [0, 0, 1], n: [-0.27, 1, 0] },
    lever: { off: [0, 0.012, -0.012] },
    pluck: sh('empties', [0, 0, -0.004]),
    pulled: sh('empties', [0, 0, -0.06]),
    // Flicked away low to the left, out of the picture.
    flick: sh('empties', [0.1, -0.09, -0.05]),
    pouch: pouch(POUCH_L, PROPS[m]!.fresh.hold),
    entry: sh('fresh', [0, 0, -0.05]),
    seat: sh('fresh', [0, 0, -0.01]),
  };
  const l: HandKey[] = ejectors
    ? [[0, 'grip'], [0.08, 'grip'], [0.16, 'foreOpen'], [0.22, 'foreOpen', 0.4], [0.42, 'pouch'], [0.58, 'entry'], [0.64, 'seat'], [0.7, 'foreOpen', 0.5], [0.76, 'foreOpen'], [0.84, 'grip'], [1, 'grip']]
    : [[0, 'grip'], [0.08, 'grip'], [0.16, 'foreOpen'], [0.24, 'pluck', 0.3], [0.28, 'pluck'], [0.34, 'pulled'], [0.39, 'flick', 0.3], [0.52, 'pouch'], [0.64, 'entry'], [0.7, 'seat'], [0.75, 'foreOpen', 0.5], [0.8, 'foreOpen'], [0.87, 'grip'], [1, 'grip']];
  const shut = ejectors ? 0.84 : 0.87;
  const empties: PropKey[] = ejectors ? [[0, 'gun'], [0.16, 'gun', [0, 0, 0]], [0.18, 'gun', [0, 0, -0.03]], [0.181, 'drop']] : [[0, 'gun'], [0.16, 'gun', [0, 0, 0]], [0.2, 'gun', [0, 0, -0.008]], [0.28, 'gun', [0, 0, -0.008]], [0.281, 'l'], [0.385, 'drop']];
  const fresh: PropKey[] = ejectors
    ? [[0, 'off'], [0.42, 'l'], [0.64, 'l'], [0.641, 'gun', [0, 0, -0.01]], [0.68, 'gun', [0, 0, 0]]]
    : [[0, 'off'], [0.52, 'l'], [0.7, 'l'], [0.701, 'gun', [0, 0, -0.01]], [0.74, 'gun', [0, 0, 0]]];
  return {
    id: `${m}-break`,
    secs,
    // Up off the hip and out across the body, the muzzle up and to the left (the stock down and away, out of the eye), so
    // the barrels hang open below the breech and its chambers face up at the eye.
    gun: moves([0, 0.08, 0.16, shut - 0.1, shut, 1], {
      x: [0, -0.04, -0.07, -0.07, -0.04, 0],
      y: [0, 0.05, 0.09, 0.09, 0.05, 0],
      z: [0, -0.02, -0.05, -0.05, -0.03, 0],
      rx: [0, 0.08, 0.15, 0.15, 0.08, 0],
      ry: [0, 0.2, 0.4, 0.4, 0.2, 0],
      rz: [0, -0.15, -0.25, -0.25, -0.1, 0],
    }),
    l,
    r: [[0, 'grip'], [0.04, 'lever'], [0.1, 'grip'], [1, 'grip']],
    spots,
    act: { open: k(0, 0, 0.08, 0, 0.16, 1, shut - 0.06, 1, shut, 0, 1, 0) },
    props: { empties, fresh },
    cues: [[0.06, 'click', 0.22], [0.16, 'handle', 0.2], [ejectors ? 0.18 : 0.34, 'shell', 0.16], [ejectors ? 0.66 : 0.72, 'shell', 0.18], [shut, 'click', 0.3]],
  };
}

// ------------------------------------------------------------------------------------------- a round at a time

/** A pump or the combat shotgun: turned port to the support hand, a shell at a time pushed up into the port and on into the tube. */
function shellLoad(m: 'pump' | 'combat'): ReloadSet {
  const hold = PROPS[m]!.shell.hold;
  const below = spot(propSpot(m, 'shell', SHELL_PATH.below));
  const port = spot(propSpot(m, 'shell', SHELL_PATH.port));
  const ready: Spot = { p: addv(below.p, [0.02, -0.03, -0.02]), a: [0, 0, 1], n: [0, 1, 0] };
  const spots: Record<string, Spot> = {
    ready,
    pouch: pouch(POUCH_L, hold),
    below,
    port,
    thumb: { p: addv(port.p, [0, 0.004, 0.035]), a: [0, 0, 1], n: [0, 1, 0] },
  };
  // Up off the hip and across, muzzle up and to the left, rolled so the loading port underneath faces the support hand.
  const pose = { x: -0.06, y: 0.08, z: -0.06, rx: 0.25, ry: 0.35, rz: -0.65 };
  const held = (vals: number[]) => ({ x: vals.map((v) => v * pose.x), y: vals.map((v) => v * pose.y), z: vals.map((v) => v * pose.z), rx: vals.map((v) => v * pose.rx), ry: vals.map((v) => v * pose.ry), rz: vals.map((v) => v * pose.rz) });
  const open: Reload = { id: `${m}-open`, secs: 1, gun: moves([0, 1], held([0, 1])), l: [[0, 'grip'], [0.25, 'grip'], [1, 'ready', 0.4]], spots, cues: [[0.3, 'handle', 0.1]] };
  const each: Reload = {
    id: `${m}-shell`,
    secs: 1,
    gun: moves([0, 0.6, 0.8, 1], { ...held([1, 1, 1, 1]), rx: [pose.rx, pose.rx, pose.rx - 0.02, pose.rx] }),
    l: [[0, 'ready', 0.4], [0.28, 'pouch'], [0.58, 'below'], [0.7, 'port'], [0.82, 'thumb', 0.3], [1, 'ready', 0.4]],
    spots,
    props: { shell: [[0, 'off'], [0.28, 'l'], [0.7, 'l'], [0.701, 'gun', SHELL_PATH.port], [0.82, 'gun', [0, 0, 0]], [0.83, 'off']] },
    cues: [[0.8, 'shell', 0.22]],
  };
  const close: Reload = { id: `${m}-settle`, secs: 1, gun: moves([0, 0.3, 1], held([1, 1, 0])), l: [[0, 'ready', 0.4], [0.75, 'grip'], [1, 'grip']], spots };
  // Run dry: the first shell is chambered by working the action once (the pump run back and forward, the combat gun's
  // bolt let go with its handle).
  const pumpIt = m === 'pump';
  const h = pumpIt ? null : SP(m, 'handle');
  if (h) {
    spots.hGrabR = rightSide(h);
    spots.hBackR = rightSide(onPart(m, 'handle', h, { handle: 1 }));
  }
  const closeEmpty: Reload = pumpIt
    ? {
        id: `${m}-chamber`,
        secs: 1,
        gun: moves([0, 0.3, 0.5, 0.65, 1], { ...held([1, 0.4, 0.3, 0.3, 0]), z: [pose.z, 0, 0.012, -0.006, 0] }),
        l: [[0, 'ready', 0.4], [0.3, 'grip'], [0.48, 'back'], [0.66, 'grip'], [1, 'grip']],
        spots: { ...spots, back: { off: [0, 0, -0.09] } },
        act: { pump: k(0, 0, 0.3, 0, 0.48, 1, 0.66, 0, 1, 0) },
        cues: [[0.48, 'rack', 0.3], [0.64, 'rack', 0.2]],
      }
    : {
        id: `${m}-chamber`,
        secs: 1,
        gun: moves([0, 0.3, 1], held([1, 0.5, 0])),
        l: [[0, 'ready', 0.4], [0.4, 'grip'], [1, 'grip']],
        r: [[0, 'grip'], [0.3, 'grip'], [0.45, 'hGrabR'], [0.55, 'hBackR'], [0.62, 'hBackR', 1], [0.85, 'grip'], [1, 'grip']],
        spots,
        act: { handle: k(0, 1, 0.55, 1, 0.6, 1.05, 0.63, 0, 1, 0) },
        cues: [[0.63, 'rack', 0.3]],
      };
  return { open, each, close, closeEmpty };
}

/**
 * A bolt rifle with a fixed magazine: the bolt thrown up and back, rounds pressed down into the open action one at a time
 * with the firing hand, and the bolt run home on the last.
 */
function boltLoad(): ReloadSet {
  const m: GunModel = 'rifle';
  const knob = SP(m, 'knob');
  const hold = PROPS.rifle!.round.hold;
  const near = spot(propSpot(m, 'round', ROUND_PATH.rifle.near));
  const at = spot(propSpot(m, 'round', ROUND_PATH.rifle.at));
  const spots: Record<string, Spot> = {
    kDown: boltHand(knob),
    kUp: boltHand(onPart(m, 'bolt', knob, { boltUp: 1 }), true),
    kBack: boltHand(onPart(m, 'bolt', knob, { boltUp: 1, boltBack: 1 }), true),
    readyR: { p: addv(near.p, [-0.05, 0.02, -0.03]), a: [0, 0, 1], n: hold.n },
    pouchR: pouch(POUCH_R, hold),
    near,
    at,
  };
  // Up off the hip and across, rolled onto its left side so the open action and its port face up at the eye.
  const pose = { x: -0.04, y: 0.08, z: -0.06, rx: 0.2, ry: 0.3, rz: 0.35 };
  const p = (v: number) => ({ x: pose.x * v, y: pose.y * v, z: pose.z * v, rx: pose.rx * v, ry: pose.ry * v, rz: pose.rz * v });
  const g = (times: number[], vals: number[]) => moves(times, { x: vals.map((v) => p(v).x), y: vals.map((v) => p(v).y), z: vals.map((v) => p(v).z), rx: vals.map((v) => p(v).rx), ry: vals.map((v) => p(v).ry), rz: vals.map((v) => p(v).rz) });
  const open: Reload = {
    id: 'rifle-open',
    secs: 1,
    gun: g([0, 0.3, 1], [0, 1, 1]),
    r: [[0, 'grip'], [0.25, 'kDown'], [0.45, 'kUp'], [0.7, 'kBack'], [1, 'readyR', 0.5]],
    spots,
    act: { boltUp: k(0, 0, 0.25, 0, 0.45, 1, 1, 1), boltBack: k(0, 0, 0.45, 0, 0.7, 1, 1, 1) },
    cues: [[0.45, 'click', 0.12], [0.7, 'rack', 0.26]],
  };
  const held = { boltUp: k(0, 1, 1, 1), boltBack: k(0, 1, 1, 1) };
  const each: Reload = {
    id: 'rifle-round',
    secs: 1,
    gun: g([0, 1], [1, 1]),
    r: [[0, 'readyR', 0.5], [0.3, 'pouchR'], [0.6, 'near'], [0.75, 'at'], [0.85, 'at', 0.4], [1, 'readyR', 0.5]],
    spots,
    act: held,
    props: { round: [[0, 'off'], [0.3, 'r'], [0.75, 'r'], [0.751, 'gun', ROUND_PATH.rifle.at], [0.84, 'gun', [0, 0, 0]], [0.85, 'off']] },
    cues: [[0.82, 'shell', 0.2]],
  };
  const close: Reload = {
    id: 'rifle-close',
    secs: 1,
    gun: g([0, 0.6, 1], [1, 1, 0]),
    r: [[0, 'readyR', 0.5], [0.2, 'kBack'], [0.45, 'kUp'], [0.6, 'kDown'], [0.85, 'grip'], [1, 'grip']],
    spots,
    act: { boltUp: k(0, 1, 0.45, 1, 0.6, 0, 1, 0), boltBack: k(0, 1, 0.2, 1, 0.45, 0, 1, 0) },
    cues: [[0.45, 'rack', 0.28], [0.6, 'click', 0.14]],
  };
  return { open, each, close, closeEmpty: close };
}

/** A lever gun: turned gate up, rounds pushed in at the gate one at a time with the firing hand; run dry, the lever worked. */
function leverLoad(): ReloadSet {
  const m: GunModel = 'lever';
  const hold = PROPS.lever!.round.hold;
  const near = spot(propSpot(m, 'round', ROUND_PATH.lever.near));
  const at = spot(propSpot(m, 'round', ROUND_PATH.lever.at));
  const loop = SP(m, 'loop');
  const spots: Record<string, Spot> = {
    readyR: { p: addv(near.p, [-0.04, -0.03, -0.04]), a: [0, 0, 1], n: hold.n },
    pouchR: pouch(POUCH_R, hold),
    near,
    at,
    push: { p: addv(at.p, [0.006, 0.002, 0.02]), a: [0, 0, 1], n: hold.n },
    loop: { p: loop },
    down: { p: onPart(m, 'lever', loop, { lever: 1 }) },
  };
  // Up off the hip and across, rolled onto its left side so the loading gate on the right faces up.
  const pose = { x: -0.05, y: 0.08, z: -0.06, rx: 0.2, ry: 0.35, rz: 0.6 };
  const p = (v: number[]) => ({ x: v.map((x) => x * pose.x), y: v.map((x) => x * pose.y), z: v.map((x) => x * pose.z), rx: v.map((x) => x * pose.rx), ry: v.map((x) => x * pose.ry), rz: v.map((x) => x * pose.rz) });
  const open: Reload = { id: 'lever-open', secs: 1, gun: moves([0, 0.6, 1], p([0, 1, 1])), r: [[0, 'grip'], [0.35, 'grip'], [1, 'readyR', 0.5]], spots };
  const each: Reload = {
    id: 'lever-round',
    secs: 1,
    gun: moves([0, 1], p([1, 1])),
    r: [[0, 'readyR', 0.5], [0.3, 'pouchR'], [0.58, 'near'], [0.72, 'at'], [0.84, 'push', 0.3], [1, 'readyR', 0.5]],
    spots,
    props: { round: [[0, 'off'], [0.3, 'r'], [0.72, 'r'], [0.721, 'gun', ROUND_PATH.lever.at], [0.84, 'gun', [0, 0, 0]], [0.85, 'off']] },
    cues: [[0.82, 'shell', 0.2]],
  };
  const close: Reload = { id: 'lever-settle', secs: 1, gun: moves([0, 0.3, 1], p([1, 0.8, 0])), r: [[0, 'readyR', 0.5], [0.7, 'grip'], [1, 'grip']], spots };
  const closeEmpty: Reload = {
    id: 'lever-chamber',
    secs: 1,
    gun: moves([0, 0.3, 1], p([1, 0.3, 0])),
    r: [[0, 'readyR', 0.5], [0.25, 'loop'], [0.48, 'down'], [0.7, 'loop'], [0.9, 'grip'], [1, 'grip']],
    spots,
    act: { lever: k(0, 0, 0.25, 0, 0.48, 1, 0.7, 0, 1, 0) },
    cues: [[0.48, 'rack', 0.28], [0.7, 'click', 0.16]],
  };
  return { open, each, close, closeEmpty };
}

// ------------------------------------------------------------------------------------------- the crossbow

/** The string drawn back to the latch by hand, a bolt fetched from the quiver and laid in the groove, slid back onto the string. */
function crossbowLoad(secs = 1): Reload {
  const m: GunModel = 'crossbow';
  const { rest, cocked } = CROSSBOW_STRING;
  const hold = PROPS.crossbow!.quarrel.hold;
  // Two fingers hooked round the string's middle from in front, the palm back toward the body, the forearm low.
  const string = (p: V3): Spot => ({ p: addv(p, [0.004, 0.006, 0.012]), a: [1, 0, 0], n: [0, 0.3, -0.95] });
  const spots: Record<string, Spot> = {
    strRest: string(rest),
    strCocked: string(cocked),
    pouch: pouch(POUCH_L, hold),
    qAbove: spot(propSpot(m, 'quarrel', [0.0, 0.04, 0.06])),
    qLaid: spot(propSpot(m, 'quarrel', [0, 0.004, 0.03])),
    qHome: spot(propSpot(m, 'quarrel', [0, 0, 0])),
  };
  return {
    id: 'crossbow-load',
    secs,
    // Up and across, tipped muzzle down while the string is drawn, then level to lay the bolt on the rail.
    gun: moves([0, 0.1, 0.5, 0.6, 0.9, 1], { x: [0, -0.04, -0.04, -0.05, -0.05, 0], y: [0, 0.02, 0.02, 0.07, 0.07, 0], z: [0, -0.1, -0.1, -0.06, -0.06, 0], rx: [0, -0.05, -0.05, 0.12, 0.12, 0], ry: [0, 0.35, 0.35, 0.3, 0.3, 0], rz: [0, -0.1, -0.1, -0.15, -0.15, 0] }),
    l: [[0, 'grip'], [0.08, 'grip'], [0.18, 'strRest', 0.4], [0.22, 'strRest'], [0.46, 'strCocked'], [0.5, 'strCocked', 0.6], [0.62, 'pouch'], [0.74, 'qAbove'], [0.8, 'qLaid'], [0.86, 'qHome'], [0.9, 'qHome', 0.5], [0.98, 'grip'], [1, 'grip']],
    spots,
    act: { cock: k(0, 0, 0.22, 0, 0.46, 1, 1, 1) },
    props: { quarrel: [[0, 'off'], [0.62, 'l'], [0.86, 'l'], [0.861, 'gun']] },
    cues: [[0.22, 'handle', 0.14], [0.46, 'click', 0.24], [0.86, 'click', 0.14]],
  };
}

// ------------------------------------------------------------------------------------------- per gun

export const RELOADS: Partial<Record<GunModel, ReloadSet>> = {
  revolver: { tac: revolverReload('revolver', true), empty: revolverReload('revolver', true), byHand: revolverReload('revolver', false) },
  cannon: { tac: revolverReload('cannon', true), empty: revolverReload('cannon', true), byHand: revolverReload('cannon', false) },
  sawn: { tac: breakReload('sawn'), empty: breakReload('sawn') },
  coach: { tac: breakReload('coach'), empty: breakReload('coach') },
  pump: shellLoad('pump'),
  combat: shellLoad('combat'),
  rifle: boltLoad(),
  lever: leverLoad(),
  lmg: { tac: beltChange(false), empty: beltChange(true) },
  crossbow: { tac: crossbowLoad(), empty: crossbowLoad() },
};
for (const m of Object.keys(MAG_OPTS) as GunModel[]) RELOADS[m] = { tac: magChange(m, false), empty: magChange(m, true) };

// ------------------------------------------------------------------------------------------- working the action

/**
 * The action worked by hand after each shot, timed like `cycleRack` (back over the first half, the case out at the far
 * end, home again): a pump's fore-end run back and forward, a bolt thrown up, back, forward and down, a lever swung
 * down and up.
 */
function pumpCycle(): Reload {
  return {
    id: 'pump-cycle',
    secs: 1,
    gun: { z: k(0, 0, 0.12, 0, 0.45, 0.01, 0.6, 0.01, 0.92, -0.004, 1, 0), rx: k(0, 0, 0.45, -0.02, 0.92, 0.01, 1, 0) },
    l: [[0, 'grip'], [0.12, 'grip'], [0.45, 'back'], [0.6, 'back'], [0.92, 'grip'], [1, 'grip']],
    spots: { back: { off: [0, 0, -0.09] } },
    act: { pump: k(0, 0, 0.12, 0, 0.45, 1, 0.6, 1, 0.92, 0, 1, 0) },
  };
}
function boltCycle(m: 'rifle' | 'sniper'): Reload {
  const knob = SP(m, 'knob');
  return {
    id: `${m}-cycle`,
    secs: 1,
    gun: { rz: k(0, 0, 0.15, 0.1, 0.8, 0.1, 1, 0), z: k(0, 0, 0.2, -0.02, 0.8, -0.02, 1, 0) },
    r: [[0, 'grip'], [0.1, 'kDown'], [0.22, 'kUp'], [0.45, 'kBack'], [0.6, 'kBack'], [0.75, 'kUp'], [0.86, 'kDown'], [1, 'grip']],
    spots: {
      kDown: boltHand(knob),
      kUp: boltHand(onPart(m, 'bolt', knob, { boltUp: 1 }), true),
      kBack: boltHand(onPart(m, 'bolt', knob, { boltUp: 1, boltBack: 1 }), true),
    },
    act: { boltUp: k(0, 0, 0.1, 0, 0.22, 1, 0.75, 1, 0.86, 0, 1, 0), boltBack: k(0, 0, 0.22, 0, 0.45, 1, 0.6, 1, 0.75, 0, 1, 0) },
  };
}
function leverCycle(): Reload {
  const loop = SP('lever', 'loop');
  return {
    id: 'lever-cycle',
    secs: 1,
    gun: { rx: k(0, 0, 0.45, -0.04, 0.9, 0.01, 1, 0), z: k(0, 0, 0.45, 0.008, 1, 0) },
    r: [[0, 'grip'], [0.1, 'loop'], [0.45, 'down'], [0.6, 'down'], [0.9, 'loop'], [1, 'grip']],
    spots: { loop: { p: loop }, down: { p: onPart('lever', 'lever', loop, { lever: 1 }) } },
    act: { lever: k(0, 0, 0.1, 0, 0.45, 1, 0.6, 1, 0.9, 0, 1, 0) },
  };
}
/** The routine that works each gun's action after a shot, for the guns worked by hand. */
export const CYCLES: Partial<Record<GunModel, Reload>> = { pump: pumpCycle(), rifle: boltCycle('rifle'), sniper: boltCycle('sniper'), lever: leverCycle() };

/** The magazine guns: quicker to reload with rounds still in them (the old magazine kept, nothing to make ready). */
export const TACTICAL_GUNS: GunModel[] = [...(Object.keys(MAG_OPTS) as GunModel[]), 'lmg'];

/** Whether a gun is loaded a round at a time (and cut short by the trigger). */
export const byRound = (m: GunModel) => !!RELOADS[m]?.each;

/** The routine for a reload: all at once (`empty` or not, by hand for a revolver with no loader), or a stage of a staged one. */
export function reloadRoutine(m: GunModel, stage: 'all' | 'open' | 'each' | 'close', empty: boolean, loader = true): Reload | null {
  const s = RELOADS[m];
  if (!s) return null;
  if (stage === 'all') return (!loader && s.byHand) || (empty ? s.empty : s.tac) || null;
  if (stage === 'close') return (empty ? s.closeEmpty : s.close) ?? null;
  return s[stage] ?? null;
}

// ------------------------------------------------------------------------------------------- playing a routine

/** The working parts at `t` through a routine (or a drill), over what the gun has at rest (`rest`): each channel keyed, 0 home to 1 fully worked. */
export function actAt(r: Drill | null, t: number, rest: ActPose, out: ActPose): ActPose {
  for (const a of ACTS) {
    const keys = r?.act?.[a];
    out[a] = keys ? curve(keys, clamp01(t)) : rest[a];
  }
  return out;
}

/** Where a carried thing is at `t`: in the gun (and its offset from its seat), in a hand, falling free, or away. */
export interface PropAt {
  where: Where;
  off: V3;
  /** When it started falling (a share of the routine), for a falling thing. */
  since: number;
}

export function propAt(keys: PropKey[], t: number, out: PropAt = { where: 'off', off: [0, 0, 0], since: 0 }): PropAt {
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1][0] <= t) i++;
  const a = keys[i];
  out.where = t < a[0] ? 'off' : a[1];
  out.since = a[0];
  const o = a[2] ?? [0, 0, 0];
  const b = keys[i + 1];
  if (a[1] === 'gun' && b && b[1] === 'gun') {
    const u = clamp01((t - a[0]) / Math.max(1e-6, b[0] - a[0]));
    const e = u * u * (3 - 2 * u);
    const p = b[2] ?? [0, 0, 0];
    out.off = [lerp(o[0], p[0], e), lerp(o[1], p[1], e), lerp(o[2], p[2], e)];
  } else out.off = [o[0], o[1], o[2]];
  return out;
}

/** When, through a routine, carried things are let go to fall into the world: (share, prop name). */
export function dropsOf(r: Reload): [number, string][] {
  const out: [number, string][] = [];
  for (const [name, keys] of Object.entries(r.props ?? {})) for (const kk of keys) if (kk[1] === 'drop') out.push([kk[0], name]);
  return out;
}

/** What a gun's parts are at rest: a pistol run dry has its slide locked back, a combat shotgun its bolt; a crossbow is cocked unless shot. */
export function restAct(m: GunModel, empty: boolean, out: ActPose): ActPose {
  for (const a of ACTS) out[a] = 0;
  if (empty && (m === 'pistol' || m === 'compact' || m === 'mp')) out.slide = 1;
  if (empty && m === 'combat') out.handle = 1;
  if (m === 'crossbow') out.cock = empty ? 0 : 1;
  return out;
}

/** Whether a carried thing is in the gun at rest (a magazine, the rounds in a cylinder, a crossbow's bolt unless it is shot). */
export function restProp(m: GunModel, name: string, empty: boolean): boolean {
  if (name === 'oldMag' || name === 'rounds' || name === 'fresh') return true;
  if (name === 'quarrel') return !empty;
  return false;
}
