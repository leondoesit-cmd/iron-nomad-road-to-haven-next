import type { ZombieKind } from '../data';
import { clamp } from '../core/math';

export const ZOMBIE_VARIANTS = 32;
export const ZOMBIE_ACTION = { idle: 0, grab: 1, feed: 2, scream: 3, wind: 4, burst: 5, smash: 6 } as const;

/** Full left/right cycle length in metres. Heavy infected plant their feet; runners take longer strides. */
const CYCLE: Record<ZombieKind, number> = { walker: 1.65, runner: 2.7, screamer: 1.85, bloater: 1.4, brute: 2.3, stalker: 2.4 };

export function zombieStepPhase(kind: ZombieKind, variant: number, distance: number, scale: number) {
  const cadence = 0.92 + (variant % 7) * 0.025;
  return Math.max(0, distance) * Math.PI * 2 * cadence / (CYCLE[kind] * scale);
}

export interface ZombieMotion {
  move: number;
  action: number;
  weight: number;
}

interface PoseState {
  dead: boolean;
  grabbing: unknown;
  feedT: number;
  eatT: number;
  screamT: number;
  smashT: number;
  charge: string;
  chargeT: number;
  burstT: number;
  locomotion: number;
}

/** Presentation follows the combat state; it never changes damage, reach or movement speed. */
export function zombieMotion(z: PoseState): ZombieMotion {
  if (z.dead) return { move: 0, action: ZOMBIE_ACTION.idle, weight: 0 };
  if (z.smashT > 0) return { move: z.locomotion * 0.3, action: ZOMBIE_ACTION.smash, weight: clamp(z.smashT / 0.65, 0, 1) };
  if (z.screamT > 0) return { move: z.locomotion * 0.25, action: ZOMBIE_ACTION.scream, weight: Math.min(1, z.screamT * 3) };
  if (z.grabbing) return { move: 0, action: ZOMBIE_ACTION.grab, weight: 1 };
  if (z.feedT > 0 || z.eatT > 0) return { move: 0, action: ZOMBIE_ACTION.feed, weight: 1 };
  if (z.charge === 'wind') return { move: 0, action: ZOMBIE_ACTION.wind, weight: clamp(1 - z.chargeT / 0.85, 0, 1) };
  if (z.burstT > 0 || z.charge === 'run') return { move: z.locomotion, action: ZOMBIE_ACTION.burst, weight: 1 };
  return { move: z.locomotion, action: ZOMBIE_ACTION.idle, weight: 0 };
}
