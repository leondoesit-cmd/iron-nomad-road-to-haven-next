/** Things to eat that are carried by hand (see `sim/carry.ts`): a tin of dog food, a lizard caught on the hot ground. */
export type FoodId = 'dogfood' | 'lizard';

/**
 * What a bite of it does: `hunger` is how much hunger it takes away (in hundredths of a full belly), `health` the hit
 * points it gives back, `rations` what it is worth stowed in the convoy's stores.
 */
export const FOODS: Record<FoodId, { name: string; hunger: number; health: number; rations: number }> = {
  dogfood: { name: 'Dogfood', hunger: 30, health: 15, rations: 0.5 },
  lizard: { name: 'Lizard', hunger: 7, health: 3, rations: 0.1 },
};
