import { ZOMBIE_VARIANTS } from '../sim/zombieAnimation';

export const ZOMBIE_OUTFITS = ['T-shirt', 'Button shirt', 'Hoodie', 'Work jacket', 'Tank top', 'Shredded vest'] as const;
export const ZOMBIE_BOTTOMS = ['Jeans', 'Shorts', 'Cargo trousers', 'Work trousers'] as const;
export const ZOMBIE_FOOTWEAR = ['Shoes', 'Trainers', 'Boots'] as const;
export const ZOMBIE_HAIRSTYLES = ['Cropped', 'Bob', 'Tied back', 'Long'] as const;

/** Clothing belongs to a persistent appearance, independently of enemy kind or animation. */
export function zombieAppearance(variant: number) {
  const look = ((variant % ZOMBIE_VARIANTS) + ZOMBIE_VARIANTS) % ZOMBIE_VARIANTS;
  return {
    look,
    outfit: look % ZOMBIE_OUTFITS.length,
    bottoms: (look * 5 + Math.floor(look / 6)) % ZOMBIE_BOTTOMS.length,
    footwear: (look + Math.floor(look / 4)) % ZOMBIE_FOOTWEAR.length,
    // Balanced across the existing saved seeds, with every outfit available to both bodies.
    female: look % 4 === 1 || look % 4 === 2,
    hairstyle: (look + Math.floor(look / 6)) % ZOMBIE_HAIRSTYLES.length,
  };
}
