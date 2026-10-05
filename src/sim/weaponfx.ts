import { clamp, clamp01 } from '../core/math';
import type { GunModel, MeleeModel } from '../data/gear';
import type { AmmoKind, Surface } from './ballistics';

/**
 * How weapons look and feel to use, as pure rules: the flash each gun throws, how a tracer is drawn, how a sustained burst
 * opens up the spread, how each gun is reloaded, how a skipped round leaves a hard surface, and what each melee weapon
 * does on the swing. No engine imports, so every number is tested and tuned in one place.
 */

// ------------------------------------------------------------------ muzzle

export interface MuzzleFx {
  /** Size of the glow sprite round the flash, metres (the flash itself is `star` and `tongue`). */
  flash: number;
  /** The flame at the muzzle: across its petals seen from in front, and how far its tongue reaches along the barrel (m). */
  star: number;
  tongue: number;
  /** Sprites strung down the line of the barrel, and how far they reach (m). */
  cone: number;
  reach: number;
  /** Burning grains thrown out of the muzzle. */
  sparks: number;
  /** Wisps of smoke left hanging in front of the muzzle. */
  smoke: number;
  /** Strength of the brief light the shot throws on its surroundings (1 is a pistol's). */
  light: number;
  tint: [number, number, number];
}

export const MUZZLE: Record<GunModel, MuzzleFx> = {
  pistol: { flash: 0.8, star: 0.11, tongue: 0.15, cone: 3, reach: 0.55, sparks: 3, smoke: 1, light: 0.8, tint: [1, 0.82, 0.45] },
  revolver: { flash: 1.25, star: 0.16, tongue: 0.22, cone: 5, reach: 0.85, sparks: 6, smoke: 2, light: 1.1, tint: [1, 0.72, 0.34] },
  smg: { flash: 0.7, star: 0.1, tongue: 0.13, cone: 3, reach: 0.5, sparks: 2, smoke: 1, light: 0.7, tint: [1, 0.86, 0.5] },
  sawn: { flash: 1.8, star: 0.3, tongue: 0.42, cone: 9, reach: 1.5, sparks: 11, smoke: 4, light: 1.5, tint: [1, 0.64, 0.26] },
  pump: { flash: 1.55, star: 0.26, tongue: 0.36, cone: 8, reach: 1.3, sparks: 9, smoke: 3, light: 1.3, tint: [1, 0.68, 0.3] },
  rifle: { flash: 1.4, star: 0.18, tongue: 0.3, cone: 6, reach: 1.2, sparks: 5, smoke: 3, light: 1.2, tint: [1, 0.9, 0.62] },
};

/** How long the flame at the muzzle lasts, seconds: a couple of frames. */
export const FLASH_SECS = 0.035;

/** How long the light from a shot lasts, seconds. */
export const MUZZLE_LIGHT_LIFE = 0.05;
/** The shot's light: brightness per unit of `MuzzleFx.light`, and how far out in front of the muzzle it sits (m). */
export const MUZZLE_LIGHT_POWER = 14;
export const MUZZLE_LIGHT_AHEAD = 0.35;

// ------------------------------------------------------------------ tracers

export interface TracerStyle {
  color: [number, number, number];
  /** Seconds a streak stays lit. */
  life: number;
  /** Share of rounds drawn: a burst of shot or an SMG would be a wall of lines if each one were. */
  chance: number;
  /** Brightness multiplier. */
  glow: number;
}

export const TRACER: Record<AmmoKind, TracerStyle> = {
  pistol: { color: [1, 0.85, 0.5], life: 0.1, chance: 0.7, glow: 1 },
  magnum: { color: [1, 0.8, 0.42], life: 0.12, chance: 0.9, glow: 1.15 },
  smg: { color: [1, 0.82, 0.42], life: 0.09, chance: 0.5, glow: 0.95 },
  pellet: { color: [1, 0.75, 0.4], life: 0.07, chance: 0.22, glow: 0.7 },
  rifle: { color: [1, 0.95, 0.72], life: 0.17, chance: 1, glow: 1.5 },
  sniper: { color: [1, 0.55, 0.38], life: 0.18, chance: 1, glow: 1.4 },
  turret: { color: [1, 0.72, 0.32], life: 0.13, chance: 0.85, glow: 1.2 },
  raider: { color: [1, 0.5, 0.3], life: 0.1, chance: 0.8, glow: 1 },
};

/** Raiders' fire is warmer and redder than the convoy's, so you can tell who is shooting at whom. */
export function tracerTint(style: TracerStyle, raider: boolean): [number, number, number] {
  const [r, g, b] = style.color;
  return raider ? [r * style.glow, g * 0.62 * style.glow, b * 0.55 * style.glow] : [r * style.glow, g * style.glow, b * style.glow];
}

// ------------------------------------------------------------------ bloom

export interface BloomSpec {
  /** Spread added per shot, as a share of the gun's own spread. */
  shot: number;
  /** The most it can open to. */
  max: number;
  /** How fast it closes up again, share per second. */
  decay: number;
}

/**
 * Sustained fire opens the spread: a gun fired as fast as the trigger allows walks off the target, one fired in
 * deliberate shots barely does (it has nearly closed up again before the next round).
 */
export const BLOOM: Record<GunModel, BloomSpec> = {
  pistol: { shot: 0.16, max: 0.7, decay: 0.5 },
  revolver: { shot: 0.32, max: 0.6, decay: 0.45 },
  smg: { shot: 0.1, max: 1.2, decay: 0.6 },
  sawn: { shot: 0.35, max: 0.35, decay: 0.3 },
  pump: { shot: 0.3, max: 0.45, decay: 0.3 },
  rifle: { shot: 0.5, max: 0.8, decay: 0.4 },
};

/** Bloom after a shot. Braced behind the sights, a gun opens up less. */
export function bloomAfterShot(model: GunModel, bloom: number, ads: number): number {
  const b = BLOOM[model];
  return Math.min(b.max, bloom + b.shot * (1 - 0.45 * clamp01(ads)));
}

/** Bloom closing up. */
export function bloomSettle(model: GunModel, bloom: number, dt: number): number {
  return Math.max(0, bloom - BLOOM[model].decay * dt);
}

// ------------------------------------------------------------------ reloading

/** Share of the reload a pistol or SMG still needs when it has a round in it: no slide to rack. */
export const TACTICAL = 0.78;
/** Share of a pump's reload spent opening the action; the rest is the shells going in one by one. */
export const PUMP_OPEN = 0.12;

export interface ReloadPlan {
  /** Seconds until the first thing happens: the magazine in, or the first shell. */
  first: number;
  /** Seconds per round after that, when the gun is loaded round by round (0 when it takes the lot at once). */
  each: number;
}

/**
 * How a gun is reloaded. A pistol or SMG that still has a round in it comes up faster than an empty one. A pump is loaded
 * a shell at a time: the whole magazine takes the gun's reload time, a part-empty one less, and the trigger cuts it short.
 */
export function reloadPlan(model: GunModel, reload: number, mag: number, have: number): ReloadPlan {
  if (model === 'pump') {
    const each = (reload * (1 - PUMP_OPEN)) / Math.max(1, mag);
    return { first: reload * PUMP_OPEN + each, each };
  }
  const tactical = (model === 'pistol' || model === 'smg') && have > 0;
  return { first: reload * (tactical ? TACTICAL : 1), each: 0 };
}

// ------------------------------------------------------------------ skipped rounds

/** How readily each hard surface skips a round that arrives at a shallow angle. Wood, plaster and earth swallow it. */
export const SKIP: Partial<Record<Surface, number>> = { steel: 1, stone: 0.75, concrete: 0.6, sheet: 0.55, car: 0.35 };
/** Sine of the shallowest angle (to the surface) at which a round can still skip: about 19 degrees. */
export const SKIP_SIN = 0.33;
/** Damage a skipped round keeps. */
export const SKIP_DAMAGE = 0.4;

export interface Skipped {
  dx: number;
  dy: number;
  dz: number;
  speed: number;
}

/**
 * Whether a round that has hit a surface skips off it, and if so how it leaves. Only a glancing blow on something hard
 * does: the shallower the angle the likelier, and it comes off slower and a little scattered. A shotgun pellet is too light.
 * `roll` is a number in [0, 1) deciding the chance; `jitter` three numbers in [-1, 1) scatter the new heading.
 */
export function skipOf(kind: AmmoKind, surface: Surface, speed: number, d: [number, number, number], n: [number, number, number], roll: number, jitter: [number, number, number]): Skipped | null {
  const base = SKIP[surface];
  if (!base || kind === 'pellet' || speed < 60) return null;
  const nl = Math.hypot(n[0], n[1], n[2]);
  if (nl < 1e-6) return null;
  let nx = n[0] / nl;
  let ny = n[1] / nl;
  let nz = n[2] / nl;
  let along = d[0] * nx + d[1] * ny + d[2] * nz;
  // The normal that faces the shooter.
  if (along > 0) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
    along = -along;
  }
  const cos = -along;
  if (cos > SKIP_SIN) return null;
  const chance = base * (1 - 0.6 * (cos / SKIP_SIN));
  if (roll >= chance) return null;
  let rx = d[0] - 2 * along * nx + jitter[0] * 0.05;
  let ry = d[1] - 2 * along * ny + jitter[1] * 0.05;
  let rz = d[2] - 2 * along * nz + jitter[2] * 0.05;
  // Never into the surface.
  const into = rx * nx + ry * ny + rz * nz;
  if (into < 0.02) {
    rx += nx * (0.02 - into);
    ry += ny * (0.02 - into);
    rz += nz * (0.02 - into);
  }
  const rl = Math.hypot(rx, ry, rz);
  return { dx: rx / rl, dy: ry / rl, dz: rz / rl, speed: speed * (0.65 - 0.3 * (cos / SKIP_SIN)) };
}

/** What a round landing on a surface sounds like. Earth and glass are left to their own sounds. */
export const IMPACT_SOUND: Partial<Record<Surface, 'tink' | 'chip'>> = { steel: 'tink', sheet: 'tink', car: 'tink', stone: 'chip', concrete: 'chip', wood: 'chip', plaster: 'chip' };

// ------------------------------------------------------------------ melee

export type MeleeKind = MeleeModel | 'fist';

export interface MeleeFeel {
  /** Seconds the swing animation runs, start to finish: a knife is a flick, an axe a long chop. */
  swing: number;
  /** Seconds from the start of the swing to the blow landing: the weapon has to come round first (`CONTACT` of the swing). */
  windup: number;
  /** Speed (m/s) a standing walker is shoved back, and the seconds it is staggered for. */
  knock: number;
  stun: number;
  /** How many bodies one swing can go through. */
  cleave: number;
  /** Camera shake on a hit that lands. */
  shake: number;
  /** Seconds the arm hangs on a landed blow before the follow-through. */
  hitStop: number;
  /** Colour of the streak the weapon draws through the air, and how strong it is. */
  trail: [number, number, number];
  trailAlpha: number;
  /** Pitch of the swing's whoosh: a light blade is higher than an axe. */
  pitch: number;
  /** What a landed blow sounds like. */
  hit: 'thud' | 'slash';
  /** How far the weapon's tip is from the hand, metres: where its streak is drawn. */
  blade: number;
}

/** How far through the swing the weapon is when it lands: the arm comes down late (it eases in), so contact is near the end. */
export const CONTACT = 0.72;

const feel = (swing: number, f: Omit<MeleeFeel, 'swing' | 'windup'>): MeleeFeel => ({ swing, windup: Math.round(swing * CONTACT * 1000) / 1000, ...f });

export const MELEE: Record<MeleeKind, MeleeFeel> = {
  fist: feel(0.22, { knock: 3.5, stun: 0.3, cleave: 2, shake: 0.08, hitStop: 0.03, trail: [0.9, 0.85, 0.8], trailAlpha: 0.12, pitch: 1, hit: 'thud', blade: 0.15 }),
  knife: feel(0.18, { knock: 2, stun: 0.2, cleave: 1, shake: 0.05, hitStop: 0.02, trail: [0.85, 0.9, 1], trailAlpha: 0.4, pitch: 1.5, hit: 'slash', blade: 0.3 }),
  bat: feel(0.28, { knock: 9, stun: 0.8, cleave: 2, shake: 0.16, hitStop: 0.06, trail: [0.8, 0.62, 0.4], trailAlpha: 0.25, pitch: 0.85, hit: 'thud', blade: 0.85 }),
  machete: feel(0.24, { knock: 4.5, stun: 0.3, cleave: 2, shake: 0.1, hitStop: 0.04, trail: [0.8, 0.88, 1], trailAlpha: 0.45, pitch: 1.2, hit: 'slash', blade: 0.67 }),
  axe: feel(0.34, { knock: 6.5, stun: 0.6, cleave: 3, shake: 0.22, hitStop: 0.08, trail: [1, 0.55, 0.4], trailAlpha: 0.4, pitch: 0.7, hit: 'slash', blade: 0.86 }),
};

export const meleeFeel = (model: string | undefined): MeleeFeel => MELEE[(model as MeleeKind) in MELEE ? (model as MeleeKind) : 'fist'];

/** A body's mass in kg shapes how far a blow moves it: a brute barely stumbles, a small thing is thrown. */
export function knockFor(feel: MeleeFeel, victimMass: number): number {
  return feel.knock * clamp(70 / Math.max(20, victimMass), 0.3, 1.4);
}

/** Shoulder height of a standing person, and the lengths of the upper arm and forearm (to the hand), metres. */
const SHOULDER = 1.45;
const UPPER = 0.3;
const FORE = 0.28;

/**
 * The right arm through a swing, as the rotations (about the body's side-to-side axis, radians) the rig is given. The arm
 * comes down from overhead behind the head through level in front to low, easing in so most of the travel is at the end,
 * the elbow closing as it goes, while the body turns across. The wrist leads: `blade` is the weapon's own angle, the way it
 * is pointing, which starts back and up, comes over the top and finishes forward and down, so the head of the weapon
 * chops down in front instead of staying up behind. `e` is 0 at the start of the swing and 1 at the end.
 */
export function swingPose(e: number): { arm: number; elbow: number; blade: number; yaw: number } {
  const t = clamp01(e);
  return { arm: -(2.7 - 2.2 * t * t), elbow: -(0.2 + 0.7 * t), blade: -2.9 + 3.9 * Math.pow(t, 0.555), yaw: 0.45 - 0.85 * t };
}

/**
 * Where the tip of the weapon is along a swing, for the streak it leaves, worked out from the same pose the rig is given.
 * Returns the yaw offset from the aim (rad), the height above the feet and the horizontal distance ahead of the body (negative
 * while the weapon is still cocked back behind it).
 * `blade` is how far the tip is from the hand.
 */
export function swingArc(e: number, blade = 0.8): { yaw: number; y: number; r: number } {
  const p = swingPose(e);
  // The arm hangs down its own length; rotating about the side axis by `a` takes it forward by -sin(a) and up by -cos(a).
  const fore = p.arm + p.elbow;
  let fwd = -Math.sin(p.arm) * UPPER - Math.sin(fore) * FORE;
  let up = -Math.cos(p.arm) * UPPER - Math.cos(fore) * FORE;
  // The weapon lies along the hand's forward axis: rotated by the whole chain's angle (`p.blade`) it points (cos, -sin).
  fwd += Math.cos(p.blade) * blade;
  up += -Math.sin(p.blade) * blade;
  return { yaw: p.yaw, y: SHOULDER + up, r: fwd };
}

// ------------------------------------------------------------------ thrown things

/** Seconds a flying molotov or flare may be airborne before it comes down wherever it is. */
export const THROW_LIFE = 4;
/** How close a molotov must pass to a body to burst on it (m). */
export const MOLOTOV_CONTACT = 0.75;
