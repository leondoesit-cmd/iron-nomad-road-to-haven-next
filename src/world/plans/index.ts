import type { CityPlan } from '../cityPlan';
import { PETAH_TIKVA } from './petahTikva';

export const CITY_PLANS: Record<string, CityPlan> = {
  [PETAH_TIKVA.id]: PETAH_TIKVA,
};

export function planById(id: string): CityPlan {
  const p = CITY_PLANS[id];
  if (!p) throw new Error(`Unknown city plan ${id}`);
  return p;
}
