import { clamp } from '../core/math';

/**
 * Swimming. Afloat, a swimmer paddles at the surface (a head-up breaststroke when slow, a front crawl when pushed) and can
 * duck under: below the surface the lungs run down, and out of air the water hurts. All numbers live here so the player, the
 * rig and the tests agree on them.
 */
export const SWIM = {
  /** Metres a second: an easy stroke at the surface, a hard crawl (spends stamina), and under the surface. */
  stroke: 1.9,
  crawl: 3.2,
  under: 1.5,
  /** Seconds of air in a held breath, and seconds to fill the lungs again at the surface. */
  air: 28,
  refill: 3.5,
  /** Health lost a second with no air left. It never lands the killing blow by itself (see `drownFloor`). */
  drown: 6,
  /** The fraction of max health at which drowning stops: the water leaves you half dead rather than finishing you. */
  drownFloor: 0.08,
  /** Metres a second: going down on its own when ducking under, and coming back up when told to surface. */
  duck: 1.25,
  rise: 2.6,
  /** How far under the first duck goes, metres below the afloat height. */
  duckTo: 0.8,
  /** Eye height above the feet, afloat (a hair over the water) and under. */
  eyeAfloat: 1.3,
  eyeUnder: 1.0,
  /** Lying flat in a crawl the head is this far ahead of the hips, metres: the first-person eyes go with it. */
  lead: 0.3,
  /** Looking this far off level (radians) steers up or down; inside it the swimmer holds their depth. */
  dead: 0.1,
} as const;

/** The air in the lungs, 0 (none) to 1 (full). `gasp` is how far gone it was when the swimmer last came up, for the rasp. */
export interface Breath {
  air: number;
  gasp: number;
  /** Seconds since the lungs were empty: the drowning clock. */
  empty: number;
}

export const newBreath = (): Breath => ({ air: 1, gasp: 0, empty: 0 });

/** What a tick of breathing did: the swimmer just came up short of breath, or is drowning and takes `hurt` health this tick. */
export interface BreathEvent {
  gasped: boolean;
  hurt: number;
}

/**
 * One tick. `under` is whether the head is below the surface; `use` scales how fast the air goes (hard work empties the lungs
 * sooner, a calm swimmer or a good set of lungs longer).
 */
export function stepBreath(b: Breath, dt: number, under: boolean, use = 1, ev: BreathEvent = { gasped: false, hurt: 0 }): BreathEvent {
  ev.gasped = false;
  ev.hurt = 0;
  if (under) {
    b.air = Math.max(0, b.air - (dt / SWIM.air) * use);
    if (b.air <= 0) {
      b.empty += dt;
      ev.hurt = SWIM.drown * dt;
    }
    return ev;
  }
  if (b.air < 1) {
    // Coming up from a long hold: a gulp at the first breath.
    if (b.air < 0.45 && b.gasp < 0.05) {
      b.gasp = 1 - b.air;
      ev.gasped = true;
    }
    b.air = Math.min(1, b.air + dt / SWIM.refill);
  }
  b.gasp = Math.max(0, b.gasp - dt * 0.5);
  b.empty = 0;
  return ev;
}

/** How fast a swimmer can go. A hard crawl only at the surface; under it is slower; a poor swimmer (winded) is slower still. */
export function swimSpeed(opts: { fast: boolean; under: boolean; winded: boolean }): number {
  const base = opts.under ? SWIM.under : opts.fast ? SWIM.crawl : SWIM.stroke;
  return opts.winded ? base * 0.82 : base;
}

/**
 * How fast the swimmer rises (positive) or sinks (negative), m/s, while ducked under. Looking up or down steers it with the
 * head: at the speed they are going, so a swimmer standing still in the water only hangs where they are. Inside `SWIM.dead`
 * of level they hold their depth. `depth` is how far under the afloat height they already are, and the first duck takes them
 * `SWIM.duckTo` down by itself.
 */
export function diveRate(pitch: number, travel: number, depth: number): number {
  if (depth < SWIM.duckTo && pitch < SWIM.dead) return -SWIM.duck;
  const lean = Math.abs(pitch) < SWIM.dead ? 0 : pitch - Math.sign(pitch) * SWIM.dead;
  const reach = clamp(travel, 0.8, SWIM.crawl);
  return clamp(lean * 1.8, -1, 1) * reach;
}
