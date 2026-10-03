import { clamp } from '../core/math';
import type { GunModel } from '../data/gear';

/**
 * How a gun feels in the hands, as pure rules: the kick it throws at the view, the spring the sights settle on, how the
 * barrel wanders while held, and how the empty brass leaves it. Every number is per gun model, in one table.
 */

export interface Handling {
  /** Muzzle climb per shot, radians. */
  kick: number;
  /** Sideways kick range per shot, radians (random sign). */
  kickYaw: number;
  /** Camera roll per shot, radians. */
  kickRoll: number;
  /** View pushed back per shot, metres (first person especially). */
  kickBack: number;
  /** How fast the kick settles (spring stiffness, 1/s²) and how much it rings (damping ratio, below 1 overshoots). */
  settleK: number;
  settleZeta: number;
  /** Aim-down-sights spring: stiffness and damping ratio. Heavy guns come up slowly and overshoot. */
  adsK: number;
  adsZeta: number;
  /** Barrel wander while held, radians at rest, and how much of it a sprint or walk adds. */
  sway: number;
  /** When the brass leaves: right with the shot, a beat after (the bolt or pump cycling), or at the reload (a revolver). */
  eject: 'shot' | 'cycle' | 'reload';
  /** Seconds after the shot a cycled case leaves. */
  cycleDelay: number;
  /** Brass or a shotgun hull. */
  shell: 'pistol' | 'rifle' | 'hull';
}

export const HANDLING: Record<GunModel, Handling> = {
  pistol: { kick: 0.014, kickYaw: 0.004, kickRoll: 0.004, kickBack: 0.012, settleK: 300, settleZeta: 0.62, adsK: 436, adsZeta: 0.85, sway: 0.0035, eject: 'shot', cycleDelay: 0, shell: 'pistol' },
  revolver: { kick: 0.04, kickYaw: 0.008, kickRoll: 0.01, kickBack: 0.03, settleK: 170, settleZeta: 0.5, adsK: 212, adsZeta: 0.75, sway: 0.0045, eject: 'reload', cycleDelay: 0, shell: 'pistol' },
  smg: { kick: 0.0085, kickYaw: 0.006, kickRoll: 0.003, kickBack: 0.008, settleK: 340, settleZeta: 0.7, adsK: 210, adsZeta: 0.8, sway: 0.0048, eject: 'shot', cycleDelay: 0, shell: 'pistol' },
  sawn: { kick: 0.07, kickYaw: 0.012, kickRoll: 0.018, kickBack: 0.06, settleK: 120, settleZeta: 0.45, adsK: 74, adsZeta: 0.62, sway: 0.0055, eject: 'reload', cycleDelay: 0, shell: 'hull' },
  pump: { kick: 0.06, kickYaw: 0.01, kickRoll: 0.014, kickBack: 0.055, settleK: 130, settleZeta: 0.48, adsK: 58, adsZeta: 0.6, sway: 0.0058, eject: 'cycle', cycleDelay: 0.42, shell: 'hull' },
  rifle: { kick: 0.055, kickYaw: 0.007, kickRoll: 0.008, kickBack: 0.05, settleK: 110, settleZeta: 0.5, adsK: 40, adsZeta: 0.55, sway: 0.0065, eject: 'cycle', cycleDelay: 0.5, shell: 'rifle' },
};

/** Kick for a gun mounted on a vehicle, or when no model is known. */
export const MOUNTED_KICK = 0.012;

/** The velocity that makes a spring's peak displacement come out near `amount`: the damped response, stepped at 60 Hz, peaks at about a third of v0/ω. */
export const kickVelocity = (h: Handling, amount: number) => amount * Math.sqrt(h.settleK) * 2.7;

export interface Spring {
  x: number;
  v: number;
}

export const spring = (): Spring => ({ x: 0, v: 0 });

/** Semi-implicit step of a damped spring toward `target`. Stable at the fixed 60 Hz step for the stiffnesses above. */
export function stepSpring(s: Spring, target: number, k: number, zeta: number, dt: number): void {
  const c = 2 * zeta * Math.sqrt(k);
  s.v += (k * (target - s.x) - c * s.v) * dt;
  s.x += s.v * dt;
}

/** Barrel wander: slow breathing plus a faster tremor, in radians. `held` is how steady the grip is (1 braced, 0 loose). */
export function swayAt(h: Handling, t: number, seed: number, moving: number, ads: number, crouch: boolean, winded: boolean): [number, number] {
  const calm = (1 - 0.55 * clamp(ads, 0, 1)) * (crouch ? 0.7 : 1) * (winded ? 1.8 : 1) * (1 + 1.4 * clamp(moving / 4, 0, 1));
  const a = h.sway * calm;
  const x = Math.sin(t * 0.83 + seed) * 0.8 + Math.sin(t * 2.1 + seed * 1.7) * 0.35 + Math.sin(t * 7.3 + seed) * 0.08;
  const y = Math.sin(t * 0.61 + seed * 2.3) * 0.7 + Math.sin(t * 1.9 + seed) * 0.3 + Math.sin(t * 6.1 + seed * 0.4) * 0.07;
  return [x * a, y * a];
}
