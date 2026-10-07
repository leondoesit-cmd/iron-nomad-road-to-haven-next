/**
 * How a raider comes to see someone on foot, and how it shoots once it has: pure rules (no engine imports).
 *
 * Seeing is not a switch. What a raider's eye can make out of a person is `show`, 0 hidden to 1 in the open: the share of
 * head, chest and hips with a clear line past rock, wall, wood and hill, thinned by the leaves of any bush between (worked
 * out by `game/sight.ts`). From it each raider builds up `aware` and lets it fade; at 1 it has seen you, and fights.
 * - Range: out to `SIGHT.reach` for someone walking in the open by day, cut by a crouch and by standing still, by the dark,
 *   the dust and the rain, and by how little of you shows. Someone it is already fighting it looks harder for.
 * - Ears: a shot gives away where it came from, footsteps carry a few metres a point. Heard is not seen: it comes to look,
 *   but it will not shoot at a noise.
 * - Up close (a few metres) anyone is noticed, whatever cover they are in.
 *
 * Shooting asks for a clear sight now, or a moment ago. A raider that has just picked someone up takes a moment before it
 * fires and its first rounds go wide; its aim settles the longer it holds them in sight, and runs cold again the moment it
 * loses them. Lose it and it puts a round or two where you were, then stops and comes looking.
 */
export const SIGHT = {
  /** Metres a raider picks out someone walking in the open by day. */
  reach: 110,
  /** Range multipliers: frozen, walking, running; and for a crouch. */
  still: 0.65,
  walk: 1,
  run: 1.3,
  crouch: 0.6,
  /** Already fighting them: sees this much further, and picks them up again this much faster. */
  hunting: 1.5,
  huntRate: 3,
  /** Less than this share of a person showing is not enough to pick them out. */
  minShow: 0.15,
  /** The dark takes this share off a raider's sight. */
  darkCut: 0.6,
  /** Awareness a second at the edge of sight, and extra close in (scaled by how much shows). */
  rateFar: 0.3,
  rateNear: 2.2,
  /** Fades this much a second while nothing is seen or heard (once it has given up looking). */
  decay: 0.2,
  /** Metres inside which anyone is noticed, whatever they hide behind. */
  touch: 3,
  /** Metres a shot is heard, and metres of hearing per point of footstep noise. */
  shotHeard: 90,
  hearPerPoint: 1.6,
  /** What hearing someone does to awareness: it comes to look, never past this. */
  heardAware: 0.7,
  /** Metres off a heard position is guessed, per 10 m of distance. */
  heardError: 2,
};

export const FIRE = {
  /** Seconds from picking someone up (or picking them up again after a while) to the first shot. */
  react: [0.6, 1.2] as const,
  /** After losing them this long, finding them again takes a fresh reaction. */
  reacquire: 1.5,
  /** Spread multiplier for a raider who has just picked someone up, settling to 1 over `settle` seconds of clear sight. */
  cold: 3,
  settle: 2.8,
  /** Spread multiplier against someone running, and walking. */
  run: 1.7,
  walk: 1.25,
  /** Seconds a raider keeps shooting at where someone was after losing sight of them. */
  suppress: 0.8,
  /** Seconds after the last sight it hunts for them before it gives up. */
  forget: 12,
  /** A gunman's pistol: rounds in it, seconds to reload, seconds between pulls. */
  mag: 7,
  reload: [2.2, 3.2] as const,
  cadence: [0.5, 0.9] as const,
};

export interface Watch {
  /** 0 nothing to 1 seen (a little over while it holds them): how sure it is someone is there. */
  aware: number;
  /** Player index it is watching for, -1 nobody. */
  who: number;
  /** Seconds since it last saw them; Infinity before it ever has. */
  lost: number;
  /** Seconds of unbroken sight: its aim settles with them. */
  held: number;
  /** Where it last saw (or heard) them. */
  x: number;
  z: number;
  /** Seconds left before it may shoot after picking them up. */
  react: number;
  /** Ever actually seen them (not just heard)? */
  spotted: boolean;
}

export const newWatch = (): Watch => ({ aware: 0, who: -1, lost: Infinity, held: 0, x: 0, z: 0, react: 0, spotted: false });

/** How a person stands to a raider's eye. */
export interface Look {
  /** Metres from raider to person. */
  d: number;
  /** 0 hidden to 1 in the open (see `game/sight.ts`). */
  show: number;
  /** m/s. */
  speed: number;
  crouch: boolean;
  /** 0 day to 1 deep night. */
  dark: number;
  /** Dust and rain, as a multiplier on sight (1 clear). */
  weather: number;
  /** Already fighting this one. */
  hunting: boolean;
}

/** How far a raider can pick out a person like this in the open, before cover. */
export function sightRange(l: Omit<Look, 'd' | 'show'>): number {
  const motion = l.speed > 4.5 ? SIGHT.run : l.speed > 0.5 ? SIGHT.walk : SIGHT.still;
  return SIGHT.reach * motion * (l.crouch ? SIGHT.crouch : 1) * (1 - l.dark * SIGHT.darkCut) * l.weather * (l.hunting ? SIGHT.hunting : 1);
}

/** Awareness a second gained from seeing them; 0 when they cannot be made out at all. */
export function sightRate(l: Look): number {
  if (l.d < SIGHT.touch) return 4;
  if (l.show < SIGHT.minShow) return 0;
  // Little showing is seen only nearer: a head over a rock at forty metres, not at a hundred.
  const range = sightRange(l) * (0.15 + 0.85 * l.show);
  if (l.d >= range) return 0;
  const near = 1 - l.d / range;
  return (SIGHT.rateFar + SIGHT.rateNear * near * near) * l.show * (l.hunting ? SIGHT.huntRate : 1);
}

/** Is a noise heard? `noise` is a footstep level, or < 0 for a shot (with `quiet` the gun's loudness share). */
export function hears(d: number, footNoise: number, shot: boolean, quiet = 1): boolean {
  if (shot && d < SIGHT.shotHeard * quiet) return true;
  return d < footNoise * SIGHT.hearPerPoint;
}

/**
 * One brain tick of a watch. `seen` is the best sighting this tick (rate from `sightRate`), `heard` a noise it caught, both
 * with the place. `rnd` is a 0..1 roll for the reaction time.
 */
export function stepWatch(
  w: Watch,
  dt: number,
  seen: { who: number; x: number; z: number; rate: number } | null,
  heard: { who: number; x: number; z: number } | null,
  rnd: number,
): void {
  if (w.react > 0) w.react = Math.max(0, w.react - dt);
  if (seen && seen.rate > 0) {
    const fresh = w.who !== seen.who;
    if (fresh) {
      w.who = seen.who;
      w.spotted = false;
    }
    const was = w.aware >= 1 && w.lost < FIRE.reacquire && !fresh;
    w.aware = Math.min(1.25, w.aware + seen.rate * dt);
    w.x = seen.x;
    w.z = seen.z;
    if (w.aware >= 1) {
      // Picked up (or picked up again after a while): a beat to bring the gun round before the first shot.
      if (!was) w.react = FIRE.react[0] + (FIRE.react[1] - FIRE.react[0]) * rnd;
      w.held = was ? w.held + dt : 0;
      w.lost = 0;
      w.spotted = true;
      return;
    }
  }
  w.held = 0;
  if (w.lost !== Infinity) w.lost += dt;
  if (heard && (w.who === heard.who || w.who < 0 || !w.spotted)) {
    w.who = heard.who;
    w.x = heard.x;
    w.z = heard.z;
    w.aware = Math.max(w.aware, SIGHT.heardAware);
    return;
  }
  // Fighting, it keeps its edge while it hunts; then it gives up.
  if (w.spotted && w.lost < FIRE.forget) return;
  if (!seen || seen.rate <= 0) w.aware = Math.max(0, w.aware - SIGHT.decay * dt);
  if (w.aware <= 0 && w.lost >= FIRE.forget) {
    w.who = -1;
    w.spotted = false;
  }
}

/** Fighting someone: has seen them and not yet given up the hunt. */
export const fighting = (w: Watch) => w.spotted && w.lost < FIRE.forget;

/** Has them in sight right now (or a moment ago). */
export const inSight = (w: Watch) => w.spotted && w.lost <= FIRE.suppress;

/** May it pull the trigger: in sight, or just lost and still putting rounds where they were; and past its reaction. */
export const mayFire = (w: Watch) => inSight(w) && w.react <= 0;

/** Spread multiplier: wide when it has just picked them up or lost them, settling as it holds them; worse on a mover. */
export function aimSpread(w: Watch, targetSpeed: number): number {
  const settle = Math.min(1, w.held / FIRE.settle);
  const cold = w.lost > 0 ? FIRE.cold : FIRE.cold + (1 - FIRE.cold) * settle;
  const move = targetSpeed > 4.5 ? FIRE.run : targetSpeed > 0.8 ? FIRE.walk : 1;
  return cold * move;
}

/** Where a heard noise is guessed to be: off by a couple of metres per ten. */
export function guessAt(x: number, z: number, d: number, r1: number, r2: number): [number, number] {
  const err = (d / 10) * SIGHT.heardError * r1;
  const a = r2 * Math.PI * 2;
  return [x + Math.sin(a) * err, z + Math.cos(a) * err];
}
