/**
 * The two people the game is about. In split screen Chinsky takes the left seat (player 1) and Leo the right (player 2);
 * a solo run is Leo's unless the title screen picks Chinsky instead.
 *
 * Height and weight are the real ones: they set how tall the rig stands and how broad it is built (see `render/heroLooks.ts`).
 */
export type HeroId = 'chinsky' | 'leo';
export const HERO_IDS: readonly HeroId[] = ['chinsky', 'leo'];

export interface HeroDef {
  id: HeroId;
  name: string;
  /** Standing height, metres. */
  height: number;
  /** Body weight, kilograms. */
  weight: number;
}

export const HEROES: Record<HeroId, HeroDef> = {
  chinsky: { id: 'chinsky', name: 'Chinsky', height: 1.72, weight: 80 },
  leo: { id: 'leo', name: 'Leo', height: 1.8, weight: 66 },
};

export const isHero = (v: unknown): v is HeroId => v === 'chinsky' || v === 'leo';

export const otherHero = (h: HeroId): HeroId => (h === 'leo' ? 'chinsky' : 'leo');

/** Who sits in each seat when nobody picked: Chinsky left and Leo right, or Leo alone (the second seat is an unused placeholder). */
export function seatHeroes(solo: boolean): [HeroId, HeroId] {
  return solo ? ['leo', 'chinsky'] : ['chinsky', 'leo'];
}
