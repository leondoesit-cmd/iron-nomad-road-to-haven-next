import type { VehicleDef } from '../data';

/** The outline numbers of the four found-car bodies, in the ground frame (y = 0 is the road). */
export interface Spec {
  id: 'hatch' | 'sedan' | 'pickup' | 'van';
  L: number;
  W: number;
  sill: number;
  belt: number;
  hood: number;
  roof: number;
  /** Windscreen base and top (z). */
  wsBase: number;
  wsTop: number;
  /** Rear glass base and top (z), where the cabin ends. */
  rwBase: number;
  rwTop: number;
}

export const SPECS: Record<Spec['id'], Spec> = {
  hatch: { id: 'hatch', L: 3.75, W: 1.72, sill: 0.26, belt: 0.92, hood: 0.95, roof: 1.5, wsBase: 0.78, wsTop: 0.3, rwBase: -1.84, rwTop: -1.42 },
  sedan: { id: 'sedan', L: 4.4, W: 1.82, sill: 0.26, belt: 0.95, hood: 0.98, roof: 1.46, wsBase: 0.88, wsTop: 0.38, rwBase: -1.42, rwTop: -0.82 },
  pickup: { id: 'pickup', L: 5.0, W: 1.96, sill: 0.32, belt: 1.08, hood: 1.12, roof: 1.92, wsBase: 1.0, wsTop: 0.68, rwBase: -0.56, rwTop: -0.56 },
  van: { id: 'van', L: 5.3, W: 2.0, sill: 0.34, belt: 1.12, hood: 1.06, roof: 2.3, wsBase: 1.5, wsTop: 1.16, rwBase: 0.5, rwTop: 0.5 },
};

/**
 * Distance from the chassis centre down to the ground when the suspension has settled.
 * The spring term is `g / (wheels * stiffness)`; Rapier's controller settles 2.2 cm higher than that, measured.
 */
export function restHeight(def: VehicleDef): number {
  const p = def.physics;
  return -p.hardY + (p.suspension.rest - 9.81 / (p.wheelCount * p.suspension.stiffness)) + p.wheelRadius + 0.022;
}

