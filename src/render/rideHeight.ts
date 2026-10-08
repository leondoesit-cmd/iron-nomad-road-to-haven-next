import { partDef } from '../data';
import type { Fit } from '../sim/parts';
import type { VehicleVisual } from './vehicleKit';

/**
 * How the springs change the stance, as the eye sees it: a long-travel kit stands the body up off its wheels, sport springs
 * and air ride drop it over them. Visual only (metres): the physics body rides where the drivetrain and suspension code
 * put it. The body, the cabin, the glass and everything bolted on move together; the wheels stay where the physics has
 * them, so the gap between tyre and arch is what changes. Keep these small: a mismatch with the collider shows as a car
 * hovering or sinking.
 */
export const RIDE_LIFT: Record<string, number> = {
  sus_long: 0.05,
  sus_heavy: 0.025,
  sus_sport: -0.03,
  sus_air: -0.045,
};

/** The visual ride-height offset for what is fitted, metres. */
export function rideLiftOf(fit: Fit): number {
  const it = fit.suspension;
  if (!it) return 0;
  const d = partDef(it.id);
  return d.empty ? -0.03 : RIDE_LIFT[it.id] ?? 0;
}

/**
 * Lift a built visual by `lift` metres over its wheels. The wheel pivots are posed every frame from the physics
 * (`Vehicle.syncVisual` takes `rideLift` off them), so they stay on the ground while the rest rises or settles.
 */
export function applyRideLift(v: VehicleVisual, lift: number) {
  if (!lift) return;
  v.rideLift = lift;
  v.inner.position.y += lift;
  for (const w of v.wheels) w.pivot.position.y -= lift;
}
