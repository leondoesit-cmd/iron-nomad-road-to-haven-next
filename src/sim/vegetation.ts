import { TREE_DIMS, type TreeSpecies } from '../world/flora';

export type PlantKind = 'grass' | 'shrubs' | 'flowers' | 'ferns' | 'reeds' | 'cane' | 'pads' | 'papyrus' | 'iris' | 'oleander' | 'weed' | 'blooms' | 'tape' | 'pondweed' | 'hornwort' | 'fig' | 'bramble' | 'sabra' | 'zaatar' | 'yarrow' | 'mushroom';
export interface VegetationMaterial {
  /** Effective moving mass (kg), root/wood failure work (J), natural angular frequency (rad/s). */
  mass: number;
  strength: number;
  frequency: number;
  damping: number;
  maxBend: number;
}

/** Gameplay approximations, not measured botanical constants. Live flexible wood differs from brittle dead wood. */
export const TREE_MECHANICS: Record<TreeSpecies, VegetationMaterial> = {
  oak:     { mass: 2800, strength: 220000, frequency: 2.8, damping: 0.55, maxBend: 0.055 },
  pine:    { mass: 1600, strength: 85000, frequency: 2.4, damping: 0.45, maxBend: 0.085 },
  willow:  { mass: 2200, strength: 120000, frequency: 1.6, damping: 0.6, maxBend: 0.13 },
  poplar:  { mass: 1400, strength: 55000, frequency: 1.8, damping: 0.45, maxBend: 0.11 },
  palm:    { mass: 900, strength: 65000, frequency: 1.5, damping: 0.55, maxBend: 0.16 },
  acacia:  { mass: 650, strength: 35000, frequency: 3.2, damping: 0.6, maxBend: 0.075 },
  cypress: { mass: 2500, strength: 180000, frequency: 2.3, damping: 0.6, maxBend: 0.065 },
  snag:    { mass: 450, strength: 4500, frequency: 4.0, damping: 0.8, maxBend: 0.035 },
  // Tall and heavy but limber: a gum sways a long way in the wind, and its wood is hard.
  eucalyptus: { mass: 3200, strength: 170000, frequency: 1.4, damping: 0.5, maxBend: 0.1 },
};
const herb = (mass: number, strength: number, frequency = 5): VegetationMaterial => ({ mass, strength, frequency, damping: 0.65, maxBend: 1.15 });
export const PLANT_MECHANICS: Record<PlantKind, VegetationMaterial> = {
  grass: herb(0.035, 35, 7), flowers: herb(0.04, 15), ferns: herb(0.25, 65, 4),
  shrubs: { ...herb(8, 1800, 4), maxBend: 0.7 }, reeds: herb(0.3, 160, 3),
  papyrus: herb(0.6, 260, 2.5), cane: { ...herb(2.2, 900, 2.2), maxBend: 0.7 }, iris: herb(0.15, 70), oleander: { ...herb(18, 3600, 3.5), maxBend: 0.65 },
  pads: herb(0.08, 30, 2), blooms: herb(0.04, 20, 2), weed: herb(0.06, 40, 2),
  tape: herb(0.03, 35, 2), pondweed: herb(0.06, 40, 2), hornwort: herb(0.04, 30, 2),
  fig: { ...herb(45, 8000, 3), maxBend: 0.5 }, bramble: { ...herb(5, 1000, 4), maxBend: 0.8 },
  sabra: { ...herb(25, 1200, 4), maxBend: 0.45 }, zaatar: herb(0.4, 100), yarrow: herb(0.1, 30), mushroom: herb(0.02, 5),
};

export interface BendState { x: number; z: number; vx: number; vz: number }
export const newBend = (): BendState => ({ x: 0, z: 0, vx: 0, vz: 0 });

/** Stable damped spring, substepped so pauses/low frame rates cannot explode it. */
export function stepBend(b: BendState, material: VegetationMaterial, dt: number) {
  const n = Math.max(1, Math.ceil(dt / (1 / 120)));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    for (const axis of ['x', 'z'] as const) {
      const v = axis === 'x' ? 'vx' : 'vz';
      b[v] += (-(material.frequency ** 2) * b[axis] - 2 * material.damping * material.frequency * b[v]) * h;
      b[axis] += b[v] * h;
      if (Math.abs(b[axis]) > material.maxBend) {
        b[axis] = Math.sign(b[axis]) * material.maxBend;
        b[v] *= 0.25;
      }
    }
  }
}

export interface VegetationRecord {
  damage: number;
  broken: boolean;
  /** Fire went through it: burnt to stubble. */
  burnt?: boolean;
  /** Fallen pose: position and quaternion; retained when its chunk sleeps or a save is loaded. */
  pose?: [number, number, number, number, number, number, number];
  direction?: [number, number];
  /** Rounds have chewed a notch: the share of the section gone in each band up the trunk (`sim/treeDamage.ts`). */
  notch?: number[];
  /** Which way the rounds that cut it were going (x, z): the notch faces back along it. */
  notchDir?: [number, number];
  /** Snapped there by gunfire, at this height up its own model (model units): its stump stands, its top lies at `pose`. */
  cut?: number;
}
export type VegetationMemory = Map<string, VegetationRecord>;
export const vegetationKey = (kind: string, x: number, z: number) => `${kind}:${Math.round(x * 100)}:${Math.round(z * 100)}`;
export function treeMechanics(species: TreeSpecies, scale: number) {
  const m = TREE_MECHANICS[species];
  return { ...m, mass: m.mass * scale ** 3, strength: m.strength * scale ** 3, height: TREE_DIMS[species].h * scale };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** Permanent lean (rad) a plant keeps once its roots/stem have taken `damage` (1 = broken). Reaches the fallen pose at 1 so breaking never pops. */
export const setAngle = (damage: number, wood: boolean) => (wood ? 0.3 : 1.35) * clamp01(damage) ** 0.8;
/** Height multiplier of a soft plant that has been trampled; 1 untouched, 0.25 fully crushed. */
export const flatten = (damage: number) => 1 - 0.75 * clamp01(damage) ** 0.8;
/** How much of a body's weight actually loads a plant it rolls or walks over: a boot barely, a wheeled chassis fully. */
export const crushShare = (mass: number) => (mass * mass) / (mass * mass + 400 * 400);
/** Fraction of the plant's height the moving body spans (bumper only bends the base, a bus covers it all). */
export const coverage = (bodyBottom: number, bodyTop: number, plantBottom: number, height: number) =>
  clamp01((Math.min(bodyTop, plantBottom + height) - Math.max(bodyBottom, plantBottom)) / Math.max(0.05, height));
