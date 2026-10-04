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
  /** When the brass leaves: right with the shot, a beat after (the bolt or pump cycling), at the reload (a revolver), or never (a crossbow). */
  eject: 'shot' | 'cycle' | 'reload' | 'none';
  /** Seconds after the shot a cycled case leaves. */
  cycleDelay: number;
  /** Brass or a shotgun hull: pistol and magnum cases, a short rifle case (5.56), a long one, or a hull. */
  shell: 'pistol' | 'magnum' | 'carbine' | 'rifle' | 'hull';
}

export const HANDLING: Record<GunModel, Handling> = {
  pistol: { kick: 0.014, kickYaw: 0.004, kickRoll: 0.004, kickBack: 0.012, settleK: 300, settleZeta: 0.62, adsK: 436, adsZeta: 0.85, sway: 0.0035, eject: 'shot', cycleDelay: 0, shell: 'pistol' },
  revolver: { kick: 0.04, kickYaw: 0.008, kickRoll: 0.01, kickBack: 0.03, settleK: 170, settleZeta: 0.5, adsK: 212, adsZeta: 0.75, sway: 0.0045, eject: 'reload', cycleDelay: 0, shell: 'pistol' },
  smg: { kick: 0.0085, kickYaw: 0.006, kickRoll: 0.003, kickBack: 0.008, settleK: 340, settleZeta: 0.7, adsK: 210, adsZeta: 0.8, sway: 0.0048, eject: 'shot', cycleDelay: 0, shell: 'pistol' },
  sawn: { kick: 0.07, kickYaw: 0.012, kickRoll: 0.018, kickBack: 0.06, settleK: 120, settleZeta: 0.45, adsK: 74, adsZeta: 0.62, sway: 0.0055, eject: 'reload', cycleDelay: 0, shell: 'hull' },
  pump: { kick: 0.06, kickYaw: 0.01, kickRoll: 0.014, kickBack: 0.055, settleK: 130, settleZeta: 0.48, adsK: 58, adsZeta: 0.6, sway: 0.0058, eject: 'cycle', cycleDelay: 0.42, shell: 'hull' },
  rifle: { kick: 0.055, kickYaw: 0.007, kickRoll: 0.008, kickBack: 0.05, settleK: 110, settleZeta: 0.5, adsK: 40, adsZeta: 0.55, sway: 0.0065, eject: 'cycle', cycleDelay: 0.5, shell: 'rifle' },
  compact: { kick: 0.012, kickYaw: 0.004, kickRoll: 0.004, kickBack: 0.01, settleK: 310, settleZeta: 0.62, adsK: 480, adsZeta: 0.85, sway: 0.0038, eject: 'shot', cycleDelay: 0, shell: 'pistol' },
  cannon: { kick: 0.052, kickYaw: 0.009, kickRoll: 0.012, kickBack: 0.04, settleK: 150, settleZeta: 0.48, adsK: 190, adsZeta: 0.72, sway: 0.0048, eject: 'reload', cycleDelay: 0, shell: 'magnum' },
  mp: { kick: 0.0075, kickYaw: 0.007, kickRoll: 0.003, kickBack: 0.007, settleK: 330, settleZeta: 0.7, adsK: 260, adsZeta: 0.8, sway: 0.0055, eject: 'shot', cycleDelay: 0, shell: 'pistol' },
  smg2: { kick: 0.0075, kickYaw: 0.005, kickRoll: 0.003, kickBack: 0.008, settleK: 340, settleZeta: 0.7, adsK: 200, adsZeta: 0.8, sway: 0.0044, eject: 'shot', cycleDelay: 0, shell: 'pistol' },
  carbine: { kick: 0.02, kickYaw: 0.006, kickRoll: 0.005, kickBack: 0.02, settleK: 200, settleZeta: 0.62, adsK: 140, adsZeta: 0.72, sway: 0.0055, eject: 'shot', cycleDelay: 0, shell: 'carbine' },
  ar: { kick: 0.017, kickYaw: 0.006, kickRoll: 0.005, kickBack: 0.02, settleK: 210, settleZeta: 0.65, adsK: 110, adsZeta: 0.7, sway: 0.0058, eject: 'shot', cycleDelay: 0, shell: 'carbine' },
  br: { kick: 0.035, kickYaw: 0.007, kickRoll: 0.007, kickBack: 0.035, settleK: 150, settleZeta: 0.55, adsK: 70, adsZeta: 0.6, sway: 0.006, eject: 'shot', cycleDelay: 0, shell: 'rifle' },
  dmr: { kick: 0.04, kickYaw: 0.006, kickRoll: 0.006, kickBack: 0.038, settleK: 130, settleZeta: 0.55, adsK: 56, adsZeta: 0.58, sway: 0.0062, eject: 'shot', cycleDelay: 0, shell: 'rifle' },
  sniper: { kick: 0.075, kickYaw: 0.007, kickRoll: 0.009, kickBack: 0.06, settleK: 95, settleZeta: 0.5, adsK: 34, adsZeta: 0.55, sway: 0.0072, eject: 'cycle', cycleDelay: 0.55, shell: 'rifle' },
  lever: { kick: 0.04, kickYaw: 0.007, kickRoll: 0.007, kickBack: 0.038, settleK: 130, settleZeta: 0.52, adsK: 70, adsZeta: 0.62, sway: 0.0058, eject: 'cycle', cycleDelay: 0.35, shell: 'magnum' },
  crossbow: { kick: 0.01, kickYaw: 0.002, kickRoll: 0.003, kickBack: 0.015, settleK: 220, settleZeta: 0.7, adsK: 90, adsZeta: 0.7, sway: 0.005, eject: 'none', cycleDelay: 0, shell: 'pistol' },
  combat: { kick: 0.05, kickYaw: 0.009, kickRoll: 0.012, kickBack: 0.05, settleK: 140, settleZeta: 0.5, adsK: 80, adsZeta: 0.62, sway: 0.0056, eject: 'shot', cycleDelay: 0, shell: 'hull' },
  coach: { kick: 0.065, kickYaw: 0.011, kickRoll: 0.016, kickBack: 0.058, settleK: 125, settleZeta: 0.46, adsK: 90, adsZeta: 0.62, sway: 0.0054, eject: 'reload', cycleDelay: 0, shell: 'hull' },
  lmg: { kick: 0.012, kickYaw: 0.008, kickRoll: 0.005, kickBack: 0.02, settleK: 180, settleZeta: 0.65, adsK: 40, adsZeta: 0.62, sway: 0.0075, eject: 'shot', cycleDelay: 0, shell: 'carbine' },
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
