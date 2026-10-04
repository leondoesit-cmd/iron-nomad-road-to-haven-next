import * as THREE from 'three';
import { MeshBuilder } from './builder';
import { bayKit, bodyPart, type KitLook, type Mounts } from './attachments';
import { acquireShell, releaseShell, type Shell } from './shellCache';
import { bodyMat, type VehicleVisual } from './vehicleKit';

/**
 * The engine bay as a mesh of its own, for a car whose bonnet can be opened. The body shell closes the bay over (and with the
 * bonnet off it draws the bay itself, see `bayKit`); this mesh is hidden until the bonnet is lifted, and then shows the engine
 * and radiator under it. It is cached by what is in the bay, so every car with the same engine shares one.
 */
export function attachBay(v: VehicleVisual, defId: string, m: Mounts, look: KitLook, floor: number, g0: number) {
  const hood = bodyPart(look.fit, 'hood');
  if (!m.hood || hood?.off) return;
  const key = `bay|${defId}|${floor}|${JSON.stringify([look.engine ?? null, look.cooling ?? null])}`;
  const shell = acquireShell(key, (): Shell => {
    const b = new MeshBuilder();
    b.jitter = 0.03;
    b.roundSeg = 2;
    b.seed(look.seed + 17);
    bayKit(b, m, look, floor);
    const geo = b.build();
    geo.translate(0, -g0, 0);
    geo.computeBoundingSphere();
    return { geo, lamps: [], tails: [], muzzle: null };
  });
  const mesh = new THREE.Mesh(shell.geo, bodyMat);
  mesh.receiveShadow = true;
  mesh.visible = false;
  v.inner.add(mesh);
  v.bay = mesh;
  v.bayAlways = hood?.id === 'hood_cut';
  const prev = v.dispose;
  v.dispose = () => {
    prev();
    releaseShell(key);
  };
}
