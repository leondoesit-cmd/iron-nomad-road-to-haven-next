import { clamp } from '../core/math';

/**
 * What loose ground does when something presses on it, digs into it or hits it, as pure rules (SI units throughout:
 * metres, kilograms, newtons, pascals, joules). The ground field (`sim/groundField.ts`) applies them cell by cell.
 *
 * Pressing is Bekker's pressure-sinkage law, p = (kc / b + kphi) z^n, with b the narrow side of the load: a tyre's width,
 * a sole's. A rolling tyre is his rigid-wheel sinkage, with the tyre's flattening taken as a wheel half as big again. Soil
 * remembers the hardest pressure it has carried (its preconsolidation): a second tyre of the same weight in the same rut
 * barely sinks it, a heavier one cuts it deeper, and loose soil heaped beside a rut gives way under the next tyre at once.
 * Of the volume a load presses down, a share is pushed aside into berms (`displace`) and the rest is packed denser.
 *
 * Craters are dug by energy: the volume is the round's kinetic energy over what a cubic metre of this ground costs to
 * dig out, less for a glancing hit, which ploughs a longer, shallower furrow and throws its soil on downrange. Of what is
 * dug, part is heaped on the rim, part flies and lands as a blanket round it, part is packed into the floor.
 *
 * Every soil has an angle of repose: a wall steeper than that slumps, so ruts and craters in dry sand settle into the
 * soft-edged shapes they really have, while sticky mud and a hard crust keep a sharp edge.
 */

export type SoilKind = 'sand' | 'loam' | 'mud' | 'gravel' | 'clay' | 'rock';

/**
 * What the solid part of a crater flies as: loose grains (sand), crumbs of packed earth, wet clods of mud, pebbles out of a
 * gravel pavement, flat flakes of a dry crust, angular chips of rock.
 */
export type SoilPiece = 'grain' | 'crumb' | 'clod' | 'pebble' | 'flake' | 'chip';

export interface Soil {
  kind: SoilKind;
  /** Bekker's cohesive modulus, N/m^(n+1). */
  kc: number;
  /** Bekker's frictional modulus, N/m^(n+2). */
  kphi: number;
  /** Bekker's sinkage exponent. */
  n: number;
  /** Bulk density, kg/m^3. */
  rho: number;
  /** Share of the volume a load presses down that is pushed aside into berms, rather than packed. */
  displace: number;
  /** Angle of repose, radians: the steepest a slope of it stands. Cohesive ground (a crust, sticky mud) stands steeper. */
  repose: number;
  /** Energy to dig a cubic metre of it out with a bullet or a blade, J/m^3. */
  crater: number;
  /** The same for an explosion, which couples to the ground far better, J/m^3. */
  blast: number;
  /** Share of a crater's volume packed into its floor (the rest is heaped or thrown). */
  pack: number;
  /** Metres of material a tyre's tread carries off for every metre it slips over it. */
  scoop: number;
  /** Deepest a tyre digs into it before it reaches firm ground underneath, m. */
  floor: number;
  /** Pressure the undisturbed ground already bears (its crust, its settling), Pa: lighter loads leave no print. */
  crust: number;
  /** How much of what is thrown goes up as dust, 0..1. */
  dust: number;
  /**
   * A round's crater in it: how deep against its half width when it comes straight down (sand a wide shallow dish, packed
   * earth a hole), how much a glancing round stretches it into a gouge, how ragged its walls and lip break (cohesive ground
   * breaks in lumps, sand slides smooth), and what share of what it throws flies as solid clods rather than loose grains.
   */
  dish: number;
  gouge: number;
  lumpy: number;
  clods: number;
  /** How much it gives under something falling on it, 0 (a chip bounces off) to 1 (a clod plops in and stays). */
  give: number;
  /**
   * How far a blow cracks its dry crust, against the crater it digs (0: loose ground, nothing to crack). A crusted ground
   * takes a smaller hole than loose sand, its energy going into breaking the crust round it instead.
   */
  crack: number;
  /** Share of a crater's volume thrown out (the rest heaps on its rim or packs into its floor). Rock throws it all: no rim. */
  eject: number;
  /** How dark the broken-open inside of a hole is against the surface (damp under a dry skin), 0..1. */
  damp: number;
  /** What its clods are. */
  piece: SoilPiece;
  /**
   * Brittle: it does not give, it breaks. A blow chips a cone out of it and the chips fly off and are lost; nothing presses
   * it, nothing slumps.
   */
  brittle: boolean;
  /** Colour of the soil thrown in the air (linear-ish rgb). */
  tint: readonly [number, number, number];
}

const DEG = Math.PI / 180;

/**
 * Desert sand is loose dune sand under a thin settled skin (a car sinks 4 cm, a lorry 9, a boot 1 to 3): a round digs a wide
 * shallow dish and its grains spray out and run back. Loam is the packed earth of hardpan, tracks and meadows (a car leaves
 * a few millimetres, a boot almost nothing): a round knocks a ragged hole in it, its walls a shade damp, and throws crumbs
 * and a plume of dust; where its skin is a dry crust the crust cracks into plates round the hole. Mud is wet clay, soft and
 * sticky (deep, sharp-walled ruts, nothing packs) and throws dark clods. Gravel is a desert's pavement of pebbles or a wash
 * bed: it scatters pebbles and dust out of a shallow pit. Dry clay is a pan's hard crust: a small hole, the crust broken
 * round it into flakes that fly. Rock does not give at all: a round chips a cone of it away, fresh stone paler than the
 * weathered face, and the chips fly off and are lost.
 */
export const SOILS: Record<SoilKind, Soil> = {
  sand: { kind: 'sand', kc: 1.5e3, kphi: 3.0e6, n: 1.0, rho: 1600, displace: 0.55, repose: 36 * DEG, crater: 2.2e6, blast: 3e6, pack: 0.15, scoop: 0.006, floor: 0.38, crust: 4e3, dust: 0.8, tint: [0.74, 0.61, 0.43], dish: 0.2, gouge: 0.7, lumpy: 0.1, clods: 0, give: 0.9, crack: 0, eject: 0.38, damp: 0, piece: 'grain', brittle: false },
  loam: { kind: 'loam', kc: 2e4, kphi: 1.5e7, n: 0.8, rho: 1700, displace: 0.3, repose: 58 * DEG, crater: 6e6, blast: 6e6, pack: 0.25, scoop: 0.0009, floor: 0.12, crust: 6e4, dust: 1, tint: [0.56, 0.46, 0.34], dish: 0.55, gouge: 2.4, lumpy: 0.6, clods: 0.35, give: 0.45, crack: 3.2, eject: 0.45, damp: 0.22, piece: 'crumb', brittle: false },
  mud: { kind: 'mud', kc: 1.3e4, kphi: 2.5e5, n: 0.5, rho: 1800, displace: 0.9, repose: 52 * DEG, crater: 1.6e6, blast: 2.5e6, pack: 0.05, scoop: 0.008, floor: 0.34, crust: 2e3, dust: 0, tint: [0.3, 0.24, 0.17], dish: 0.35, gouge: 1.2, lumpy: 0.3, clods: 0.6, give: 1, crack: 0, eject: 0.25, damp: 0, piece: 'clod', brittle: false },
  gravel: { kind: 'gravel', kc: 0, kphi: 6e7, n: 1.0, rho: 1800, displace: 0.6, repose: 39 * DEG, crater: 7e6, blast: 5e6, pack: 0.15, scoop: 0.0012, floor: 0.07, crust: 1e5, dust: 0.4, tint: [0.55, 0.52, 0.48], dish: 0.4, gouge: 1.6, lumpy: 0.8, clods: 0.6, give: 0.3, crack: 0, eject: 0.55, damp: 0, piece: 'pebble', brittle: false },
  clay: { kind: 'clay', kc: 5e4, kphi: 6e7, n: 0.6, rho: 1750, displace: 0.2, repose: 70 * DEG, crater: 1.4e7, blast: 1.2e7, pack: 0.3, scoop: 0.0002, floor: 0.03, crust: 3e5, dust: 0.9, tint: [0.68, 0.6, 0.5], dish: 0.5, gouge: 2.6, lumpy: 0.9, clods: 0.7, give: 0.2, crack: 4.5, eject: 0.5, damp: 0.12, piece: 'flake', brittle: false },
  rock: { kind: 'rock', kc: 0, kphi: 1e12, n: 1.0, rho: 2600, displace: 0, repose: 85 * DEG, crater: 6e7, blast: 1.5e8, pack: 0, scoop: 0, floor: 0.002, crust: 1e8, dust: 0.35, tint: [0.6, 0.56, 0.5], dish: 0.35, gouge: 0.8, lumpy: 0.9, clods: 0.85, give: 0.05, crack: 0, eject: 1, damp: 0, piece: 'chip', brittle: true },
};

/** Gravity, m/s^2. */
export const G = 9.81;

/** Bekker's plate stiffness for a load whose narrow side is `b` metres. */
function plateK(s: Soil, b: number): number {
  return s.kc / Math.max(0.03, b) + s.kphi;
}

/** How far a plate `b` metres across sinks under a pressure, m. */
export function plateSinkage(s: Soil, p: number, b: number): number {
  return p > 0 ? Math.pow(p / plateK(s, b), 1 / s.n) : 0;
}

/** The pressure that sinks a plate `b` metres across to `z`, Pa (the inverse of `plateSinkage`). */
export function platePressure(s: Soil, z: number, b: number): number {
  return z > 0 ? plateK(s, b) * Math.pow(z, s.n) : 0;
}

/** How much a pneumatic tyre on soft ground behaves like a bigger rigid wheel. */
const TYRE_FLAT = 1.5;

/**
 * Sinkage of a tyre rolling over fresh ground: Bekker's rigid wheel with load `W` (N), width `b` and radius `r` (m), less
 * at speed (sand has no time to give way under a fast tyre). Returns the sinkage and the plate pressure that gives it,
 * which is what the ground field presses each cell with.
 */
export function wheelSinkage(s: Soil, W: number, b: number, r: number, speed = 0): { z: number; p: number } {
  if (W <= 0) return { z: 0, p: 0 };
  const n = s.n;
  const D = 2 * r * TYRE_FLAT;
  const z0 = Math.pow((3 * W) / ((3 - n) * (s.kc + b * s.kphi) * Math.sqrt(D)), 2 / (2 * n + 1));
  const z = Math.min(s.floor, z0 / (1 + 0.035 * Math.abs(speed)));
  return { z, p: platePressure(s, z, b) };
}

/**
 * Bekker's compaction resistance of a tyre `b` wide sinking `z` into fresh ground, N: the work of pressing a rut, per metre
 * of it. A tyre running in a rut already pressed has little of it left to do.
 */
export function compactionResistance(s: Soil, b: number, z: number): number {
  return z > 0 ? (b * plateK(s, b) * Math.pow(z, s.n + 1)) / (s.n + 1) : 0;
}

/** A car's tyre on sand: what the soft-ground drag of the vehicle tables was tuned against. */
export const REF_TYRE = { W: 1400 * G * 0.25, b: 0.2, r: 0.33 };

/**
 * How hard the ground drags at a vehicle against the tuned drag of that surface: as much again for a reference car on fresh
 * ground at that speed, more for a heavier load cutting deeper, much less for tyres following a rut already pressed
 * (`fresh` is the sinkage its leading tyres are making, m).
 */
export function sinkDrag(s: Soil, fresh: number, speed = 0): number {
  const ref = wheelSinkage(s, REF_TYRE.W, REF_TYRE.b, REF_TYRE.r, speed).z;
  return ref > 1e-5 ? clamp(0.35 + (0.65 * fresh) / ref, 0.35, 1.8) : 1;
}

/** Extra sinkage a later pass adds to a rut already pressed as hard (repeated loading still settles it a little). */
export function repassSinkage(z: number, passes: number): number {
  return z * 0.14 * Math.pow(0.55, passes);
}

/** Volume a slipping tyre `b` wide digs out and throws, m^3, over `dt` seconds at slip speed `slip` (m/s). */
export function digVolume(s: Soil, b: number, slip: number, dt: number): number {
  return s.scoop * b * Math.max(0, slip) * dt;
}

/** Highest difference between neighbouring cells `cell` metres apart that this soil stands at. */
export function talus(s: Soil, cell: number): number {
  return Math.tan(s.repose) * cell;
}

export interface Crater {
  /** Volume dug out of the bowl, m^3. */
  volume: number;
  /** Semi-axes of the bowl, m: along the line of the shot (or of the blast's push) and across it. */
  along: number;
  across: number;
  depth: number;
  /** How far downrange of the point of impact the bowl's centre lies, m. */
  shift: number;
  /** Shares of the dug volume heaped on the rim and thrown (the rest is packed into the floor). */
  rim: number;
  eject: number;
  /** How lopsided the rim and the throw are toward downrange, 0 even to 1 all of it. */
  skew: number;
  /** How much deeper the bowl runs at its downrange end (a glancing round digs in as it goes), 0 even. */
  asym: number;
  /** How ragged its walls and lip are, 0 smooth. */
  lumpy: number;
  /** Typical speed of the thrown soil, m/s. */
  throwSpeed: number;
}

/**
 * The crater a projectile digs: `energy` its kinetic energy (J), `sinT` the sine of the angle it meets the ground at (1
 * straight down, near 0 grazing). Sand takes a wide shallow dish, round whatever the angle; packed earth a deeper hole, and
 * a glancing round there gouges a long furrow that deepens where it digs in, its lip and its soil thrown on ahead. A
 * glancing round spends less of itself on the ground.
 */
export function crater(s: Soil, energy: number, sinT: number): Crater {
  const st = clamp(sinT, 0.02, 1);
  const eff = 0.25 + 0.75 * Math.pow(st, 0.7);
  const volume = (Math.max(0, energy) * eff) / s.crater;
  const g = (1 - st) * (1 - st);
  const elong = 1 + s.gouge * g;
  const dr = s.dish * (0.6 + 0.4 * st);
  const across = Math.cbrt((2 * volume) / (Math.PI * elong * dr));
  const along = across * elong;
  const pack = s.pack;
  const eject = s.eject;
  return {
    volume,
    along,
    across,
    depth: dr * across,
    shift: 0.35 * along * (1 - st),
    rim: 1 - pack - eject,
    eject,
    skew: 0.85 * (1 - st),
    asym: (s.gouge > 1 ? 0.9 : 0.3) * (1 - st),
    lumpy: s.lumpy,
    // Mud clings and leaves slow; chips of rock spring off fast.
    throwSpeed: (0.9 + 1.7 * Math.pow(Math.max(1, energy) / 500, 0.22)) * (s.kind === 'mud' ? 0.7 : s.brittle ? 2.2 : 1),
  };
}

/** Deepest a blast digs, m: below it is ground no grenade or mine shifts. */
export const BLAST_FLOOR = 0.6;

/** The crater an explosion on (or just over) the ground digs: `energy` is what reaches the ground, J. */
export function blastCrater(s: Soil, energy: number): Crater {
  const volume = Math.max(0, energy) / s.blast;
  const dr = 0.45;
  let across = Math.cbrt((2 * volume) / (Math.PI * dr));
  if (across * dr > BLAST_FLOOR) across = Math.sqrt((2 * volume) / (Math.PI * BLAST_FLOOR));
  const depth = Math.min(BLAST_FLOOR, across * dr);
  const pack = s.pack;
  // A blast throws more of what it digs than a round does; rock all of it.
  const eject = s.brittle ? 1 : Math.min(1 - pack, s.eject + 0.1);
  return {
    volume: (Math.PI / 2) * across * across * depth,
    along: across,
    across,
    depth,
    shift: 0,
    rim: 1 - pack - eject,
    eject,
    skew: 0,
    asym: 0,
    lumpy: s.lumpy * 0.5,
    throwSpeed: 2.5 + 4 * Math.pow(Math.max(1, energy) / 1e6, 0.2),
  };
}

/**
 * How deep a body of mass `m` (kg) landing at `vy` (m/s, downward) on a patch `b` by `l` metres presses in, m: its energy
 * spent pressing the ground, E = A k z^(n+1) / (n+1), on top of its own weight's sinkage.
 */
export function landingSinkage(s: Soil, m: number, vy: number, b: number, l: number): number {
  const A = Math.max(1e-3, b * l);
  const k = plateK(s, b);
  const E = 0.5 * m * vy * vy;
  const zE = Math.pow(((s.n + 1) * E) / (A * k), 1 / (s.n + 1));
  return Math.min(s.floor, Math.max(zE, plateSinkage(s, (m * G) / A, b)));
}
