/**
 * The people the game is about. In split screen Chinsky takes the left seat (player 1) and Leo the right (player 2);
 * a solo run is Leo's. The title screen can put any of them in either seat, Nar Divad and Lag Karab included. Lag Karab
 * is also the man who eats the huge slice of cake (see `render/cake.ts`), for the opening. Ro Karab, his younger brother, sits
 * with a burger and a beer and laughs (see `render/burger.ts`).
 *
 * Height and weight are the real ones: they set how tall the rig stands and how broad it is built (see `render/heroLooks.ts`).
 */
export type HeroId = 'chinsky' | 'leo' | 'nar' | 'lag' | 'amirat' | 'iati' | 'ro' | 'nuhat' | 'udud';
export const HERO_IDS: readonly HeroId[] = ['chinsky', 'leo', 'nar', 'lag', 'amirat', 'iati', 'ro', 'nuhat', 'udud'];

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
  nar: { id: 'nar', name: 'Nar Divad', height: 1.75, weight: 82 },
  lag: { id: 'lag', name: 'Lag Karab', height: 1.75, weight: 75 },
  amirat: { id: 'amirat', name: 'Amirat', height: 1.75, weight: 77 },
  // Height supplied by the user; weight is an appearance estimate for the rig's build.
  iati: { id: 'iati', name: 'Iati', height: 1.79, weight: 86 },
  ro: { id: 'ro', name: 'Ro Karab', height: 1.75, weight: 88 },
  nuhat: { id: 'nuhat', name: 'Nuhat', height: 1.70, weight: 73 },
  udud: { id: 'udud', name: 'Udud', height: 1.76, weight: 82 },
};

export const isHero = (v: unknown): v is HeroId => HERO_IDS.includes(v as HeroId);

/** Someone other than `h` to fill a second seat: Leo's partner is Chinsky, anyone else's is the first of the others. */
export const otherHero = (h: HeroId): HeroId => HERO_IDS.find((x) => x !== h)!;

/** The next hero after `h` in the roster, round to the start, passing over `taken` (whoever holds the other seat). */
export function nextHero(h: HeroId, taken?: HeroId): HeroId {
  const i = HERO_IDS.indexOf(h);
  for (let k = 1; k <= HERO_IDS.length; k++) {
    const n = HERO_IDS[(i + k) % HERO_IDS.length];
    if (n !== taken) return n;
  }
  return h;
}

/** Who sits in each seat when nobody picked: Chinsky left and Leo right, or Leo alone (the second seat is an unused placeholder). */
export function seatHeroes(solo: boolean): [HeroId, HeroId] {
  return solo ? ['leo', 'chinsky'] : ['chinsky', 'leo'];
}
