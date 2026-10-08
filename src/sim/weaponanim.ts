import { clamp01 } from '../core/math';
import type { GunModel } from '../data/gear';
import { FRAMES } from './gunFrames';

/**
 * What the hands do to a gun while it is reloaded and worked, as pure curves: how far the gun is canted, how the muzzle
 * moves, how far the support hand leaves the gun for the belt or the pouch, and how the slide, pump or bolt travels.
 * Each gun has its own routine, timed in shares of the reload. The rig turns the numbers into arm angles.
 */

/** The six guns the reload and handling animations were drawn for; every other model moves like the nearest of them. */
export type BaseGun = 'pistol' | 'revolver' | 'smg' | 'sawn' | 'pump' | 'rifle';
export const GUN_BASE: Record<GunModel, BaseGun> = {
  pistol: 'pistol', revolver: 'revolver', smg: 'smg', sawn: 'sawn', pump: 'pump', rifle: 'rifle',
  compact: 'pistol', cannon: 'revolver', mp: 'smg', smg2: 'smg', carbine: 'rifle', ar: 'rifle', br: 'rifle', dmr: 'rifle',
  sniper: 'rifle', lever: 'rifle', crossbow: 'pistol', bow: 'pistol', combat: 'pump', coach: 'sawn', lmg: 'smg',
};
/** A table written for the base guns, read for every model. */
export function forGuns<T>(base: Record<BaseGun, T>): Record<GunModel, T> {
  const out = {} as Record<GunModel, T>;
  for (const m of Object.keys(GUN_BASE) as GunModel[]) out[m] = base[GUN_BASE[m]];
  return out;
}

export type ReloadKind = 'mag' | 'cylinder' | 'shell' | 'bolt';

/** How each gun is reloaded: a magazine, a cylinder or break-action, a shell at a time, or a bolt action. */
const RELOAD_BASE: Record<BaseGun, ReloadKind> = { pistol: 'mag', smg: 'mag', revolver: 'cylinder', sawn: 'cylinder', pump: 'shell', rifle: 'bolt' };
export const RELOAD_KIND = forGuns(RELOAD_BASE);

export interface GunPose {
  /** Cant of the gun about its barrel, radians: tipped over so the magazine well or the loading port faces the support hand. */
  tilt: number;
  /** Extra muzzle pitch, radians: positive tips the muzzle down, negative up. */
  pitch: number;
  /** How far the support hand has left the gun for the belt or the pouch: 0 on the gun, 1 at the belt. */
  down: number;
  /** How far the slide, pump or bolt has travelled back: 0 home, 1 fully back. */
  rack: number;
}

export const newGunPose = (): GunPose => ({ tilt: 0, pitch: 0, down: 0, rack: 0 });

type Key = [number, number];

/** Smooth interpolation through keyframes `[time, value]`, eased between each pair. */
export function curve(keys: Key[], t: number): number {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1] = keys[i];
    if (t <= t1) {
      const [t0, v0] = keys[i - 1];
      const k = clamp01((t - t0) / Math.max(1e-6, t1 - t0));
      const e = k * k * (3 - 2 * k);
      return v0 + (v1 - v0) * e;
    }
  }
  return keys[keys.length - 1][1];
}

interface Routine {
  tilt: Key[];
  pitch: Key[];
  down: Key[];
  rack: Key[];
  /** When the empty magazine drops (or the empties fall), as a share of the routine; negative for never. */
  drop: number;
}

const ROUTINES: Record<ReloadKind, Routine> = {
  // Pistol and SMG: tip the gun, the hand drops to the belt for a fresh magazine and brings it to the well, then slaps the slide.
  mag: {
    tilt: [[0, 0], [0.16, 0.5], [0.62, 0.5], [0.8, 0], [1, 0]],
    pitch: [[0, 0], [0.16, -0.22], [0.62, -0.22], [0.8, 0], [1, 0]],
    down: [[0, 0], [0.14, 0], [0.34, 1], [0.46, 1], [0.62, 0], [1, 0]],
    rack: [[0, 0], [0.78, 0], [0.86, 1], [0.95, 0], [1, 0]],
    drop: 0.18,
  },
  // Revolver and break-action: the gun is opened muzzle up and the empties fall, the hand goes to the pouch and back, and it is snapped shut.
  cylinder: {
    tilt: [[0, 0], [0.12, 0.35], [0.34, 0.35], [0.7, 0.2], [0.82, -0.3], [0.92, 0], [1, 0]],
    pitch: [[0, 0], [0.12, -0.7], [0.34, -0.7], [0.5, 0.15], [0.7, 0.1], [0.82, -0.1], [1, 0]],
    down: [[0, 0], [0.34, 0], [0.5, 1], [0.6, 1], [0.74, 0], [1, 0]],
    rack: [[0, 0], [1, 0]],
    drop: 0.2,
  },
  // One shell of a pump: the gun is canted so the port faces up, the hand goes to the pouch and brings a shell to the port.
  shell: {
    tilt: [[0, 0.5], [1, 0.5]],
    pitch: [[0, -0.1], [1, -0.1]],
    down: [[0, 0], [0.12, 0], [0.4, 1], [0.5, 1], [0.85, 0], [1, 0]],
    rack: [[0, 0], [1, 0]],
    drop: -1,
  },
  // Bolt rifle: the bolt is thrown up and back, the hand goes to the pouch for rounds and presses them in, and the bolt is run home.
  bolt: {
    tilt: [[0, 0], [0.14, 0.25], [0.7, 0.25], [0.9, 0], [1, 0]],
    pitch: [[0, 0], [0.14, -0.15], [0.7, -0.15], [0.9, 0], [1, 0]],
    down: [[0, 0], [0.3, 0], [0.45, 1], [0.58, 1], [0.7, 0], [1, 0]],
    rack: [[0, 0], [0.1, 0], [0.2, 1], [0.7, 1], [0.84, 0], [1, 0]],
    drop: 0.22,
  },
};

/** The pose of the gun at a point through its reload routine. `t` is progress, 0 to 1. */
export function reloadPose(kind: ReloadKind, t: number, out: GunPose = newGunPose()): GunPose {
  const r = ROUTINES[kind];
  const k = clamp01(t);
  out.tilt = curve(r.tilt, k);
  out.pitch = curve(r.pitch, k);
  out.down = curve(r.down, k);
  out.rack = curve(r.rack, k);
  return out;
}

/** When the empty magazine drops, as a share of the reload (negative if nothing drops). */
export const dropAt = (kind: ReloadKind) => ROUTINES[kind].drop;

/**
 * How far the pump or bolt travels after a shot, `t` from 0 to 1 over the cycle: back and forward again, quicker out than in.
 * The spent case leaves at the far end of the stroke.
 */
export function cycleRack(t: number): number {
  return curve([[0, 0], [0.12, 0], [0.45, 1], [0.6, 1], [0.92, 0], [1, 0]], t);
}

/** Where in the cycle the spent case leaves, as a share of it. */
export const CYCLE_EJECT = 0.5;

/** Seconds the pump or bolt takes to work after a shot, from when it is fired to the end of the stroke. */
export const cycleTime = (cycleDelay: number) => cycleDelay / CYCLE_EJECT;

// ------------------------------------------------------------------ where things are on each gun

export type V3 = [number, number, number];

export interface GunPoints {
  /** The notch of the rear sight and the top of the front one: the line the eye looks along (or the scope's axis). */
  rear: V3;
  front: V3;
  /** The tip of the barrel, the ejection port, and the mouth of the magazine well (where an empty magazine leaves), in the gun's own frame. */
  muzzle: V3;
  port: V3;
  well: V3;
}

/**
 * Points on each gun in its own frame (origin at the hand, +z along the barrel, +y up, +x to the left of the gun), off its
 * frame in `gunFrames.ts`: the models in `render/weapons` are drawn to the same numbers, the sights on top (a gun with a
 * built-in scope is aimed down the scope), the ejection port on the right.
 */
export const GUN_POINTS = {} as Record<GunModel, GunPoints>;
for (const m of Object.keys(FRAMES) as GunModel[]) {
  const f = FRAMES[m];
  GUN_POINTS[m] = { rear: f.rear, front: f.front, muzzle: [f.rear[0], f.bore, f.muzzle], port: f.port, well: f.well };
}
/**
 * A bow's frame has its origin in the bow hand's grip, the limbs up and down y, and the arrow along +z on the shelf to the
 * left of the grip: it leaves from the shelf ("muzzle") and is sighted along its shaft back to the nock at full draw ("rear").
 */
GUN_POINTS.bow = { rear: [0.016, 0.035, -0.62], front: [0.016, 0.035, 0.04], muzzle: [0.016, 0.035, 0.06], port: [0.016, 0.035, -0.18], well: [0, -0.1, 0] };

/** Which guns drop an empty magazine when reloaded (a revolver's empties are brass, a pump has none, a bolt rifle's rounds go in loose). */
const DROPS_BASE: Record<BaseGun, 'pistol' | 'smg' | null> = { pistol: 'pistol', smg: 'smg', revolver: null, sawn: null, pump: null, rifle: null };
export const DROPS_MAG = forGuns(DROPS_BASE);
// Nothing falls out of a crossbow or a bow when it is loaded.
DROPS_MAG.crossbow = null;
DROPS_MAG.bow = null;
