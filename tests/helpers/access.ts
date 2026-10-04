import * as THREE from 'three';
import { accessPointsOf } from '../../src/render/accessPoints';
import { pointPos } from '../../src/game/access';
import type { Spot, Panel } from '../../src/sim/access';
import type { LegScene } from '../../src/game/legScene';
import type { Vehicle } from '../../src/game/vehicle';

/** Pose every car's meshes by hand: these tests never render. */
export function pose(sc: LegScene) {
  for (const v of sc.vehicles) v.syncVisual(1, 1 / 60);
}

/** Stand a short step outside an access point of a vehicle, facing it, the way a player walks up to it. */
export function standAt(sc: LegScene, v: Vehicle, spot: Spot, index = 0, who = 0): THREE.Vector3 {
  const p = sc.players[who];
  const pt = accessPointsOf(v.def).filter((q) => q.spot === spot)[index];
  if (!pt) throw new Error(`${v.def.id} has no ${spot} point #${index}`);
  const pos = pointPos(v, pt);
  const out = new THREE.Vector3(pos.x - v.position.x, 0, pos.z - v.position.z);
  if (out.lengthSq() < 1e-6) out.set(0, 0, 1);
  out.normalize();
  p.placeAt(pos.x + out.x * 0.8, pos.z + out.z * 0.8, Math.atan2(-out.x, -out.z));
  pose(sc);
  return pos;
}

/** Leave a panel open without waiting for the hold and the swing. */
export function openPanel(v: Vehicle, panel: Panel, open = true) {
  if (open) {
    v.open[panel] = true;
    v.swing[panel] = 1;
  } else {
    delete v.open[panel];
    v.swing[panel] = 0;
  }
}
