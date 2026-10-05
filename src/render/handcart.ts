import * as THREE from 'three';
import { MeshBuilder, S } from './builder';
import { kitMaterial } from './materials';
import { shared } from './dispose';

/**
 * A trader's handcart: a plank bed on two spoked wheels, a load roped down under a tarp, and two shafts that run forward to
 * the trader's hands. The cart's origin is the middle of the axle on the ground; it faces +z, so the shafts end near
 * `HANDLE_Z` ahead of it, where the trader walks.
 */
export const HANDLE_Z = 2.0;
/** Wheel radius, so the caller can turn the wheels as the cart rolls. */
export const WHEEL_R = 0.42;

const TARPS = [0x7a6a4a, 0x4f5a4a, 0x8a4a3a, 0x5a5f6a];
const bodyCache = new Map<number, THREE.BufferGeometry>();
let wheelGeo: THREE.BufferGeometry | null = null;

function bodyGeometry(variant: number): THREE.BufferGeometry {
  const hit = bodyCache.get(variant);
  if (hit) return hit;
  const b = new MeshBuilder();
  b.jitter = 0.03;
  const plank = S.wood(0x6a4a30, 0.7);
  const dark = S.wood(0x3f2c1c, 0.8);
  const tarp = S.cloth(TARPS[variant % TARPS.length], 0.7);
  const rope = S.cloth(0x8a7a5a, 0.4);
  const iron = S.steel(0x3c3f42, 0.7);
  // The bed and its low sides.
  b.box(0, 0.62, 0, 1.0, 0.07, 1.5, plank);
  for (const sx of [1, -1]) b.box(sx * 0.5, 0.78, 0, 0.06, 0.26, 1.5, dark);
  b.box(0, 0.78, -0.75, 1.0, 0.26, 0.06, dark);
  b.box(0, 0.78, 0.75, 1.0, 0.18, 0.06, dark);
  // The axle, running out to the hubs.
  b.cyl(0, WHEEL_R, 0, 0.05, 1.32, 0.05, iron, 0, 0, Math.PI / 2, 8);
  // The load: crates, a sack, a jerrycan and a roll, with a tarp over the back half.
  b.rbox(-0.2, 0.98, -0.3, 0.5, 0.42, 0.5, 0.02, S.wood(0x8a6a44, 0.7));
  b.rbox(0.22, 0.95, -0.34, 0.4, 0.36, 0.44, 0.02, S.wood(0x74583a, 0.7));
  b.rbox(0.0, 1.38 - 0.18, -0.34, 0.46, 0.26, 0.4, 0.02, tarp);
  b.rbox(0.0, 0.92, 0.28, 0.62, 0.3, 0.44, 0.07, tarp, 0, 0.1, 0);
  b.rbox(-0.22, 0.86, 0.52, 0.26, 0.2, 0.26, 0.05, S.cloth(0xb8a37a, 0.5));
  b.rbox(0.26, 0.84, 0.5, 0.2, 0.24, 0.12, 0.02, S.paint(0x9a3326, 0.6));
  b.cyl(0.18, 1.18, -0.05, 0.1, 0.5, 0.1, rope, Math.PI / 2, 0, 0, 8);
  b.box(0, 1.1, 0.0, 0.84, 0.02, 0.03, rope);
  // A cooking pot hung off the back.
  b.cyl(0.0, 0.68, -0.84, 0.18, 0.16, 0.18, iron, 0, 0, 0, 10);
  // Two shafts forward from the bed to a cross-bar at the trader's hands.
  for (const sx of [1, -1]) b.rod(sx * 0.4, 0.66, 0.7, sx * 0.3, 0.86, HANDLE_Z, 0.025, dark, 6);
  b.rod(-0.3, 0.86, HANDLE_Z, 0.3, 0.86, HANDLE_Z, 0.03, dark, 6);
  const g = shared(b.build());
  bodyCache.set(variant, g);
  return g;
}

function wheelGeometry(): THREE.BufferGeometry {
  if (wheelGeo) return wheelGeo;
  const b = new MeshBuilder();
  b.jitter = 0.03;
  const wood = S.wood(0x5a4129, 0.7);
  const tyre = S.rubber(0x242321);
  // A wheel stands in the y-z plane: a rim of segments, a hub and spokes.
  b.torus(0, 0, 0, WHEEL_R - 0.02, 0.035, tyre, 0, Math.PI / 2, 0, 6, 18);
  b.cyl(0, 0, 0, 0.09, 0.1, 0.09, S.steel(0x3c3f42, 0.7), 0, 0, Math.PI / 2, 8);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI;
    b.box(0, 0, 0, 0.03, (WHEEL_R - 0.05) * 2, 0.03, wood, a, 0, 0);
  }
  wheelGeo = shared(b.build());
  return wheelGeo;
}

export interface Handcart {
  root: THREE.Group;
  wheels: THREE.Mesh[];
  /** Roll the wheels by a distance in metres. */
  roll(d: number): void;
}

export function makeHandcart(variant = 0): Handcart {
  const mat = kitMaterial();
  const root = new THREE.Group();
  const body = new THREE.Mesh(bodyGeometry(variant), mat);
  body.castShadow = true;
  root.add(body);
  const wheels: THREE.Mesh[] = [];
  for (const sx of [1, -1]) {
    const w = new THREE.Mesh(wheelGeometry(), mat);
    w.castShadow = true;
    w.position.set(sx * 0.68, WHEEL_R, 0);
    root.add(w);
    wheels.push(w);
  }
  return {
    root,
    wheels,
    roll(d) {
      for (const w of wheels) w.rotation.x += d / WHEEL_R;
    },
  };
}
