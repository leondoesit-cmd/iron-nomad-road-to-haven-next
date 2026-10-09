/**
 * Play settings that reach into the simulation: how tough the dead are, how fast fire runs, how hard the wind blows, and how
 * much a hero can take. Set from Settings (`game/game.ts` keeps and saves them); everything here defaults to the game as
 * tuned, so tests and the headless runs see the usual world.
 */
export const TUNING = {
  /** Pistol rounds to the body it takes to drop a walker (2 is the game as tuned). */
  zombieHits: 2,
  /** Grass and tree fires spread at this share of their tuned pace. */
  fire: 1,
  /** The wind (breeze, storm and gust fronts) at this share of its strength. */
  wind: 1,
  /** A hero's full health. God mode gives half again. */
  playerHp: 100,
  /** Seconds of play from first light to dark (the Dusk Bell rings at 0.72 of it). Half an hour by default. */
  dayLength: 1800,
};

/** The day length the body's needs and the floods were tuned against, seconds. */
export const TUNED_DAY = 720;

/** The day-length slider: minutes from first light to dark. */
export const DAY_MINUTES = { min: 5, max: 120, step: 5 };

/** Clamp a day length in seconds to what the slider offers. */
export function clampDayLength(sec: number): number {
  const m = Math.round(sec / 60 / DAY_MINUTES.step) * DAY_MINUTES.step;
  return Math.min(DAY_MINUTES.max, Math.max(DAY_MINUTES.min, m)) * 60;
}

/** How much of a tuned day one second of play is: needs that drain per day keep their pace per day on a longer one. */
export const dayPace = () => TUNED_DAY / TUNING.dayLength;

/** The steps the zombie-toughness setting offers, in pistol hits to the body. */
export const ZOMBIE_HITS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20];

/** Health of a hero with god mode on, as a share of the usual. */
export const GOD_HP = 1.5;

/** Walker's hit points and a pistol round's damage, the yardstick the hits are counted in (enemies.json / gear.json). */
const WALKER_HP = 45;
const PISTOL_DMG = 27;

/**
 * The share of their hit points the dead get for `hits` pistol rounds to the body to drop a walker: (3h - 1) / 5 lands a
 * walker's 45 between h - 1 and h rounds of 27, so 2 hits is the game as tuned (1). Bigger zombies take more, heavier guns
 * fewer, in the same proportion.
 */
export function zombieToughness(hits = TUNING.zombieHits): number {
  const m = (3 * hits - 1) / 5;
  return hits === 2 ? 1 : Math.max(0.2, m);
}

/** How many rounds of `dmg` it takes to drop a body of `hp` at toughness `hits`. */
export function hitsToDrop(hp: number, dmg: number, hits = TUNING.zombieHits): number {
  return Math.max(1, Math.ceil((hp * zombieToughness(hits)) / dmg - 1e-9));
}

/** The yardstick, for the settings line. */
export const walkerPistolHits = (hits = TUNING.zombieHits) => hitsToDrop(WALKER_HP, PISTOL_DMG, hits);
