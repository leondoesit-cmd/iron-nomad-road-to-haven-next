import { clamp, clamp01 } from '../core/math';
import { AMMO, type AmmoKind } from './ballistics';
import type { MeleeKind } from './weaponfx';

export type GroundMaterial = 'asphalt' | 'hardpan' | 'sand' | 'mud' | 'stone' | 'concrete';
export type GroundWeapon = AmmoKind | MeleeKind;

const SOIL: Record<GroundMaterial, { tint: [number, number, number]; dust: number; hard: boolean }> = {
  asphalt: { tint: [0.3, 0.3, 0.29], dust: 0.24, hard: true },
  hardpan: { tint: [0.55, 0.45, 0.33], dust: 0.75, hard: false },
  sand: { tint: [0.72, 0.6, 0.42], dust: 1, hard: false },
  mud: { tint: [0.3, 0.24, 0.17], dust: 0, hard: false },
  stone: { tint: [0.6, 0.57, 0.52], dust: 0.3, hard: true },
  concrete: { tint: [0.62, 0.6, 0.57], dust: 0.4, hard: true },
};

const MELEE_ENERGY: Record<MeleeKind, number> = { fist: 8, knife: 10, machete: 35, katana: 30, bat: 65, pipe: 80, axe: 140, sledge: 260 };

/** Visual disturbance in metres, driven by kinetic energy, the angle into the ground, and its material. */
export function groundImpact(weapon: GroundWeapon, material: GroundMaterial, speed: number, incidence: number, dry = 1) {
  const soil = SOIL[material];
  const ammo = weapon in AMMO ? AMMO[weapon as AmmoKind] : null;
  const shaft = weapon === 'arrow' || weapon === 'bolt';
  const energy = ammo ? 0.5 * ammo.mass * Math.max(0, speed) ** 2 : MELEE_ENERGY[weapon as MeleeKind] * Math.max(0, speed) ** 2;
  const angle = clamp01(incidence);
  const power = clamp(Math.sqrt(energy / 250), 0, 2.8) * (0.35 + 0.65 * Math.sqrt(angle)) * (shaft ? 0.22 : 1);
  const size = clamp((ammo ? ammo.hole : 0.06) * (0.45 + 0.8 * power), 0.018, 0.38);
  const dust = soil.dust * clamp01(dry) * power;
  return {
    tint: soil.tint,
    hard: soil.hard,
    shaft,
    power,
    size,
    stretch: shaft ? 1 : 1 + (1 - angle) * 1.8,
    dust,
    plume: 0.08 + dust * 0.3,
    life: 0.18 + dust * 0.35,
    chips: power < 0.05 ? 0 : Math.min(10, Math.ceil(power * (shaft ? 1 : soil.hard ? 3 : 4))),
    chipSize: shaft ? 0.035 : clamp(0.06 + power * 0.06, 0.06, 0.22),
    eject: 0.4 + Math.sqrt(power) * (soil.hard ? 2.2 : 1.7),
    // Shafts, blades and lead pellets do not throw a shower of glowing sparks.
    sparks: soil.hard && ammo && !shaft && weapon !== 'pellet' && power > 0.7 ? Math.min(3, Math.floor(power)) : 0,
    sound: shaft ? (soil.hard ? 'tink' : 'thunk') : soil.hard ? 'chip' : 'thud',
    volume: clamp(0.07 + power * 0.12, 0.07, 0.42),
  } as const;
}
