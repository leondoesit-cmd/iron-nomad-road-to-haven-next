import * as THREE from 'three';
import { MeshBuilder, S } from './builder';
import { blank, finish, headlamp, rider, type VehicleVisual } from './vehicleKit';
import { heavyGun, rivets, spareTyre } from './parts';
import { C } from './palette';
import type { VehicleDef } from '../data';
import type { Humanoid } from './humanoid';

/**
 * Boats. Local frame: +Z is the bow, y = 0 is the hull's centre (the keel is at -halfHeight), +X is the port side.
 * Both models are one merged body plus a handful of moving parts: the gun pivot, the riders and the airboat's fan.
 */

function rng(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A fan that turns with the engine, wired into the visual's optional per-frame hook. */
export interface BoatVisual extends VehicleVisual {
  /** Called every frame with the throttle (0..1) and the speed (m/s). */
  animate?: (dt: number, throttle: number, speed: number) => void;
}

/** The skiff: a battered open aluminium boat with a centre console, an outboard, tyres for fenders and a pintle gun aft. */
export function buildSkiff(def: VehicleDef, color: number): BoatVisual {
  const v = blank(def) as BoatVisual;
  const b = new MeshBuilder();
  b.jitter = 0.04;
  b.roundSeg = 2;
  b.seed(61);
  const r = rng(61);
  const hy = def.physics.halfExtents[1];
  const hull = S.paint(color, 0.7);
  const hull2 = S.paint(new THREE.Color(color).lerp(new THREE.Color(0x6a6458), 0.4).getHex(), 0.8);
  const white = S.paint(0xcfc9b8, 0.75);
  const rust = S.rust(0x7a4a2c);
  const steel = S.steel(0x4a4d50, 0.7);
  const wood = S.wood(0x6a5238, 0.85);
  const L = def.length;
  const W = def.width;
  const hw = W / 2;
  // Bottom, a shallow V.
  b.box(0, -hy + 0.04, -0.15, W * 0.72, 0.08, L * 0.8, hull2);
  for (const s of [-1, 1]) b.box(s * hw * 0.62, -hy + 0.12, -0.15, W * 0.22, 0.06, L * 0.78, hull2, 0, 0, s * 0.25);
  // Sides: straight along the waist, then closing in to the bow.
  for (const s of [-1, 1]) {
    b.rbox(s * hw * 0.97, 0.0, -0.45, 0.09, hy * 1.8, L * 0.62, 0.02, hull);
    // The bow: two slabs that meet at the stem.
    b.rbox(s * hw * 0.62, 0.0, 1.45, 0.09, hy * 1.8, 1.55, 0.02, hull, 0, s * -0.52, 0);
    b.rbox(s * hw * 0.32, 0.0, 1.95, 0.09, hy * 1.7, 0.85, 0.02, hull, 0, s * -0.96, 0);
    // Gunwale rail and rivet lines.
    b.rod(s * hw, hy * 0.9 + 0.02, -1.8, s * hw, hy * 0.9 + 0.02, 0.8, 0.03, white, 6);
    b.rod(s * hw, hy * 0.9 + 0.02, 0.8, s * hw * 0.28, hy * 0.9 + 0.02, 2.15, 0.03, white, 6);
    rivets(b, [s * hw * 0.99, 0.15, -2.0], [s * hw * 0.99, 0.15, 0.6], 12);
  }
  // Foredeck over the bow, with an anchor locker, a cleat and a coil of line.
  b.box(0, hy * 0.82, 1.7, W * 0.62, 0.06, 1.0, hull, 0.08, 0, 0);
  b.box(0, hy * 0.92, 1.85, 0.2, 0.06, 0.12, steel);
  b.torus(0.25, hy * 0.9, 1.5, 0.18, 0.045, S.cloth(0xa89a74, 0.7), Math.PI / 2, 0, 0, 5, 14);
  // Transom and stern deck.
  b.rbox(0, 0.0, -L / 2 + 0.12, W * 0.95, hy * 1.8, 0.14, 0.02, hull);
  b.box(0, -hy + 0.2, -1.35, W * 0.86, 0.05, 1.5, wood);
  // Thwarts (benches).
  for (const z of [-0.2, 0.9]) b.box(0, -0.02, z, W * 0.82, 0.07, 0.34, wood);
  // Centre console with a screen, a wheel and a throttle box.
  b.rbox(0.0, -0.1, 0.55, 0.6, 0.62, 0.55, 0.04, white);
  b.box(0, 0.32, 0.4, 0.5, 0.04, 0.34, S.glass(0x0b1218), -0.5, 0, 0);
  b.rod(0, 0.2, 0.45, 0, 0.44, 0.38, 0.015, steel, 5);
  b.torus(0, 0.46, 0.34, 0.15, 0.015, S.rubber(0x1c1c1c), -0.5, 0, 0, 5, 16);
  b.box(0.22, 0.24, 0.62, 0.1, 0.14, 0.08, S.metal(0x2a2c2e, 0.6));
  // A fuel can strapped alongside and a stack of crates aft.
  b.rbox(-0.62, -0.12, 0.2, 0.2, 0.38, 0.32, 0.03, S.paint(0xc83a28, 0.75));
  b.box(0.55, -0.1, -1.0, 0.55, 0.5, 0.55, wood);
  b.box(0.62, 0.27, -1.0, 0.4, 0.26, 0.4, S.wood(0x7a5e3a, 0.8), 0, 0.3, 0);
  // Tyre fenders hung over the side.
  for (const s of [-1, 1]) for (const z of [-0.9, 0.2]) spareTyre(b, s * (hw + 0.08), -0.05, z, 0.32, 0.22, 0, Math.PI / 2);
  // Patches of bare metal and rust where the paint has gone.
  for (let i = 0; i < 7; i++) {
    const s = r() > 0.5 ? 1 : -1;
    b.box(s * (hw + 0.003), -0.1 + r() * 0.3, -1.9 + r() * 3, 0.01, 0.12 + r() * 0.15, 0.3 + r() * 0.5, r() > 0.4 ? rust : S.steel(0x7a7e82, 0.6));
  }
  // Outboard motor on the transom: cowl, leg, propeller housing and tiller.
  const tz = -L / 2 - 0.05;
  b.rbox(0, 0.28, tz - 0.12, 0.38, 0.5, 0.48, 0.07, S.paint(0x2e3a3e, 0.6));
  b.box(0, 0.28, tz - 0.38, 0.3, 0.14, 0.04, S.paint(0xc83a28, 0.6));
  b.rbox(0, -0.2, tz - 0.12, 0.2, 0.9, 0.3, 0.05, S.metal(0x6a6e70, 0.7));
  b.cyl(0, -0.62, tz - 0.12, 0.22, 0.4, 0.22, S.metal(0x6a6e70, 0.7), Math.PI / 2, 0, 0, 10);
  b.rod(0, 0.2, tz - 0.3, 0.1, 0.35, tz - 1.0, 0.025, steel, 5);
  b.box(0, 0.55, tz - 0.16, 0.5, 0.05, 0.12, steel);
  for (const s of [-1, 1]) b.rod(s * 0.18, 0.54, tz - 0.16, s * 0.12, 0.0, tz - 0.12, 0.02, steel, 4);
  // Hull number and a bow light.
  b.box(-hw - 0.004, 0.2, 1.1, 0.01, 0.2, 0.5, S.paint(0x1c1c1c, 0.8));
  headlamp(v, b, 0, 0.42, 2.15, 0.1, false);
  v.smoke.position.set(0, 0.55, tz - 0.3);
  v.inner.add(v.smoke);
  // The helmsman stands at the console; the gunner's pintle is on a post aft.
  const driver = rider(color, color);
  driver.root.position.set(0.42, -0.28, 0.5);
  v.inner.add(driver.root);
  v.driver = driver;
  const pass = rider(color, color);
  pass.root.position.set(0, -0.2, -1.05);
  v.passenger = pass;
  const gun = new THREE.Group();
  gun.position.set(0, 0.55, -1.05);
  const gb = new MeshBuilder();
  heavyGun(gb, 1.15, true);
  const gm = new THREE.Mesh(gb.build(), v.body?.material ?? undefined);
  gm.castShadow = true;
  gun.add(gm);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, 1.2);
  gun.add(muzzle);
  v.inner.add(gun);
  v.gun = gun;
  v.muzzle = muzzle;
  v.gunSeat = [0, -0.2, -1.05];
  b.rod(0, -hy + 0.2, -1.05, 0, 0.5, -1.05, 0.05, steel, 6);
  const out = finish(v, b.build()) as BoatVisual;
  // The gun was built before the shared material existed: use it now.
  gm.material = out.body.material;
  return out;
}

/** The airboat: a wide flat hull, a high seat, a V8 and a caged fan on a pylon that turns with the throttle. */
export function buildAirboat(def: VehicleDef, color: number): BoatVisual {
  const v = blank(def) as BoatVisual;
  const b = new MeshBuilder();
  b.jitter = 0.04;
  b.roundSeg = 2;
  b.seed(73);
  const r = rng(73);
  const hy = def.physics.halfExtents[1];
  const L = def.length;
  const W = def.width;
  const hw = W / 2;
  const hull = S.paint(color, 0.65);
  const stripe = S.paint(0xe0c040, 0.7);
  const steel = S.steel(0x4a4d50, 0.7);
  const dark = S.paint(0x2a2c2e, 0.7);
  const rust = S.rust(0x7a4a2c);
  // Flat bottom, shallow sides, a pointed bow and a stern deck.
  b.box(0, -hy + 0.05, 0, W * 0.9, 0.1, L * 0.78, hull);
  for (const s of [-1, 1]) {
    b.rbox(s * hw * 0.95, -0.02, -0.4, 0.1, hy * 1.7, L * 0.66, 0.02, hull);
    b.rbox(s * hw * 0.6, -0.02, 1.7, 0.1, hy * 1.7, 1.7, 0.02, hull, 0, s * -0.55, 0);
    b.rbox(s * hw * 0.28, -0.02, 2.35, 0.1, hy * 1.6, 0.8, 0.02, hull, 0, s * -1.0, 0);
    b.box(s * hw * 0.95, hy * 0.78, -0.4, 0.14, 0.04, L * 0.66, stripe);
  }
  b.box(0, hy * 0.62, 2.2, W * 0.4, 0.05, 0.7, hull, 0.1, 0, 0);
  b.box(0, -hy + 0.2, -1.2, W * 0.88, 0.06, 2.6, S.wood(0x6a5238, 0.85));
  // The pedestal seats: a bench raised on a frame so the pilot sees over the grass.
  for (const z of [0.35, -0.85]) {
    b.rbox(0, 0.3, z, 0.9, 0.12, 0.5, 0.04, S.leather(0x3a2c22, 0.7));
    b.rbox(0, 0.68, z - 0.24, 0.9, 0.55, 0.1, 0.04, S.leather(0x3a2c22, 0.7));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.rod(sx * 0.4, -hy + 0.15, z + sz * 0.2, sx * 0.4, 0.26, z + sz * 0.2, 0.03, steel, 5);
  }
  // The engine and the pylon behind the seats, and the fan in its cage.
  const ez = -1.75;
  b.rbox(0, 0.15, ez + 0.45, 0.8, 0.62, 0.9, 0.06, dark);
  for (let i = 0; i < 4; i++) b.cyl(-0.3 + i * 0.2, 0.55, ez + 0.45, 0.14, 0.16, 0.14, S.chrome(0xb8bcc0), 0, 0, 0, 10);
  b.pipe([[0.4, 0.42, ez + 0.1], [0.6, 0.6, ez + 0.1], [0.62, 0.15, ez + 0.1]], 0.04, S.metal(0x6e5a4a, 0.85), 8);
  const fanY = 1.15;
  const fanZ = ez - 0.35;
  for (const sx of [-1, 1]) b.rod(sx * 0.45, 0.05, ez + 0.05, sx * 0.45, fanY - 0.2, fanZ, 0.05, steel, 6);
  b.rod(0, fanY - 0.2, ez - 0.05, 0, fanY, fanZ, 0.07, steel, 6);
  // Cage: two rings and spokes, in the plane facing aft.
  const cageR = 0.95;
  b.torus(0, fanY, fanZ - 0.55, cageR, 0.025, steel, 0, 0, 0, 5, 36);
  b.torus(0, fanY, fanZ + 0.15, cageR, 0.025, steel, 0, 0, 0, 5, 36);
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    b.rod(Math.cos(a) * cageR, fanY + Math.sin(a) * cageR, fanZ + 0.15, Math.cos(a) * cageR, fanY + Math.sin(a) * cageR, fanZ - 0.55, 0.012, steel, 4);
  }
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI;
    b.rod(Math.cos(a) * cageR, fanY + Math.sin(a) * cageR, fanZ - 0.55, -Math.cos(a) * cageR, fanY - Math.sin(a) * cageR, fanZ - 0.55, 0.012, steel, 4);
  }
  // Twin rudders behind the fan.
  for (const sx of [-0.28, 0.28]) b.box(sx, fanY - 0.1, fanZ - 0.85, 0.04, 1.4, 0.55, S.paint(0x2a2c2e, 0.7));
  // Paint wear, a fuel drum and a tangle of netting.
  for (let i = 0; i < 6; i++) {
    const s = r() > 0.5 ? 1 : -1;
    b.box(s * (hw * 0.95 + 0.006), -0.05 + r() * 0.15, -1.6 + r() * 3.4, 0.01, 0.1 + r() * 0.12, 0.3 + r() * 0.4, rust);
  }
  b.cyl(-0.65, -0.1, -0.2, 0.42, 0.7, 0.42, S.paint(0x5a6a4a, 0.85), 0, 0, 0, 12);
  headlamp(v, b, 0, 0.3, 2.45, 0.09, false);
  v.smoke.position.set(0, 0.7, ez + 0.4);
  v.inner.add(v.smoke);
  const driver = rider(color, color);
  driver.root.position.set(0, 0.28, 0.35);
  v.inner.add(driver.root);
  v.driver = driver;
  const pass = rider(color, color);
  pass.root.position.set(0, 0.28, -0.85);
  v.passenger = pass;
  v.gunSeat = [0, 0.28, -0.85];
  const out = finish(v, b.build()) as BoatVisual;
  // The fan blades: a separate mesh, spun by the throttle.
  const fan = new THREE.Group();
  fan.position.set(0, fanY, fanZ - 0.2);
  const fb = new MeshBuilder();
  fb.jitter = 0.02;
  fb.cyl(0, 0, 0, 0.2, 0.18, 0.2, S.steel(0x2a2c2e, 0.6), Math.PI / 2, 0, 0, 10);
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2;
    fb.box(Math.cos(a) * 0.45, Math.sin(a) * 0.45, 0, 0.16, 0.8, 0.025, S.paint(0xb8a47a, 0.6), 0, 0, a - Math.PI / 2 + 0.3);
  }
  const fm = new THREE.Mesh(fb.build(), out.body.material);
  fm.castShadow = true;
  fan.add(fm);
  out.inner.add(fan);
  const prevDispose = out.dispose;
  let phase = 0;
  out.animate = (dt, throttle, speed) => {
    phase += dt * (6 + throttle * 70 + Math.abs(speed) * 0.5);
    fan.rotation.z = phase;
  };
  out.dispose = () => {
    prevDispose();
    fm.geometry.dispose();
  };
  return out;
}

/** The pedal boat's numbers: the bench, the footwell floor, the riders' hips and the pedal axle (boat frame). */
const PEDALO = { seatZ: -0.22, floor: -0.08, hip: 0.25, axleY: 0.02, axleZ: 0.56, crank: 0.11, seatX: 0.34 };

/**
 * Sit a rider on the pedal boat's bench with their feet on the pedals, the cranks at `crank` (radians): each leg reaches its
 * pedal round the axle, the two half a turn apart, so the knees come up and go down as the boat is pedalled.
 */
function pedalSeat(h: Humanoid, x: number, crank: number) {
  const P = PEDALO;
  const k = h.root.scale.y;
  h.root.position.set(x, P.floor, P.seatZ);
  h.hips.position.y = (P.hip - P.floor) / k;
  h.hips.position.z = 0;
  h.torso.rotation.x = -0.18;
  for (const [leg, knee, sx, ph] of [
    [h.legL, h.kneeL, 1, 0],
    [h.legR, h.kneeR, -1, Math.PI],
  ] as const) {
    const a = crank + ph;
    const R = P.axleZ - P.seatZ + Math.cos(a) * P.crank;
    const D = Math.max(0.1, P.hip - (P.axleY + Math.sin(a) * P.crank) - 0.04);
    const d = Math.min(0.85 * k, Math.hypot(R, D));
    const phi = Math.atan2(R, D);
    const alpha = Math.acos(Math.min(1, d / (0.86 * k)));
    leg.rotation.x = -(phi + alpha);
    leg.rotation.z = sx * 0.07;
    knee.rotation.x = 2 * alpha;
  }
}

/**
 * The pedal boat at the Mill Bend's landing, the kind every park lake on the coast hired out by the hour: two white
 * fibreglass floats with a blue stripe, a moulded tub between them with a bench for two side by side, a footwell with a pair
 * of pedals for each, the steering stick between the seats and a paddle wheel under a cowl at the stern. The cranks and the
 * wheel turn as it is pedalled, and the riders' legs go round with them.
 */
export function buildPedalo(def: VehicleDef, color: number): BoatVisual {
  const v = blank(def) as BoatVisual;
  const b = new MeshBuilder();
  b.jitter = 0.02;
  b.roundSeg = 3;
  b.seed(91);
  const r = rng(91);
  const P = PEDALO;
  const white = S.gloss(0xe6e4dc, 0.4);
  const white2 = S.gloss(0xd4d2c8, 0.5);
  const blue = S.gloss(color, 0.4);
  const dark = S.plastic(0x2a2e33, 0.5);
  const grey = S.steel(0x8a8e90, 0.5);
  const grime = S.paint(0x8a8a6a, 0.9);
  // Twin floats with upswept noses, a stripe down the outside of each.
  for (const s of [-1, 1]) {
    b.rbox(s * 0.56, -0.1, -0.08, 0.46, 0.42, 2.25, 0.2, white);
    b.rbox(s * 0.56, -0.02, 1.08, 0.4, 0.34, 0.6, 0.17, white, -0.28, 0, 0);
    b.box(s * 0.795, 0.05, -0.08, 0.02, 0.07, 2.05, blue);
    // A green-brown tidemark of the river at the waterline.
    b.box(s * 0.792, -0.14, -0.08, 0.02, 0.05, 2.1, grime);
  }
  // The tub between them: the deck, the footwell's floor, the foredeck.
  b.rbox(0, 0.0, -0.2, 1.18, 0.2, 1.9, 0.07, white2);
  b.box(0, P.floor + 0.005, 0.42, 0.86, 0.02, 0.82, dark);
  b.rbox(0, 0.1, 1.0, 1.1, 0.1, 0.55, 0.05, white, -0.08, 0, 0);
  // The bench and its back, and the boat's number on the backrest.
  b.box(0, 0.06, P.seatZ, 1.02, 0.12, 0.42, white2);
  b.rbox(0, P.hip - 0.09, P.seatZ, 1.06, 0.07, 0.44, 0.03, blue);
  b.rbox(0, 0.46, P.seatZ - 0.27, 1.06, 0.5, 0.07, 0.03, blue, -0.22, 0, 0);
  b.box(0, 0.52, P.seatZ - 0.33, 0.2, 0.18, 0.01, S.paint(0xf0eee6, 0.5), -0.22, 0, 0);
  b.box(0.0, 0.52, P.seatZ - 0.335, 0.05, 0.12, 0.01, S.paint(0x1a3a6a, 0.5), -0.22, 0, 0);
  // Axle brackets in the footwell, and the steering stick between the seats.
  for (const s of [-1, 1]) for (const e of [-0.13, 0.13]) b.box(s * P.seatX + e, (P.floor + P.axleY) / 2, P.axleZ, 0.03, P.axleY - P.floor + 0.04, 0.06, grey);
  b.rod(0, 0.1, P.seatZ + 0.18, 0.02, 0.6, P.seatZ + 0.26, 0.016, grey, 6);
  b.add('sphere', 0.02, 0.62, P.seatZ + 0.27, 0.07, 0.07, 0.07, dark);
  // The cowl over the paddle wheel at the stern, and the rudder behind it.
  const wz = -1.08;
  b.rbox(0, 0.16, wz, 0.6, 0.26, 0.72, 0.12, white);
  for (const s of [-1, 1]) b.box(s * 0.31, -0.02, wz, 0.03, 0.34, 0.66, white2);
  b.box(0, -0.12, -1.42, 0.03, 0.3, 0.22, dark);
  // A coil of mooring line on the foredeck and a fender.
  b.torus(0.25, 0.17, 1.02, 0.12, 0.022, S.cloth(0xc8b890, 0.7), Math.PI / 2, 0, 0, 5, 14);
  b.rod(0.25, 0.17, 1.1, 0.4, -0.05, 1.45, 0.02, S.cloth(0xc8b890, 0.7), 4);
  for (let i = 0; i < 5; i++) b.box((r() - 0.5) * 1.2, 0.105 + r() * 0.01, -0.6 + r() * 1.6, 0.1 + r() * 0.2, 0.004, 0.05 + r() * 0.1, grime, 0, r() * 3, 0);
  // Riders: on the bench side by side.
  const driver = rider(color, color);
  v.inner.add(driver.root);
  v.driver = driver;
  v.passenger = rider(color, color);
  v.gunSeat = [P.seatX, P.floor, P.seatZ];
  const out = finish(v, b.build()) as BoatVisual;
  // Moving parts: a pair of cranks for each seat, and the paddle wheel.
  const parts = new MeshBuilder();
  parts.jitter = 0.01;
  const cranks: THREE.Group[] = [];
  const crankGeo = (() => {
    const cb = new MeshBuilder();
    cb.cyl(0, 0, 0, 0.03, 0.34, 0.03, grey, 0, 0, Math.PI / 2, 6);
    for (const [e, a] of [
      [-0.14, 0],
      [0.14, Math.PI],
    ] as const) {
      cb.box(e, Math.sin(a) * P.crank * 0.5, Math.cos(a) * P.crank * 0.5, 0.025, 0.025, P.crank, grey, a, 0, 0);
      cb.box(e + Math.sign(e) * 0.05, Math.sin(a) * P.crank, Math.cos(a) * P.crank, 0.1, 0.03, 0.14, dark);
    }
    return cb.build();
  })();
  for (const s of [-1, 1]) {
    const g = new THREE.Group();
    g.position.set(s * P.seatX, P.axleY, P.axleZ);
    const m = new THREE.Mesh(crankGeo, out.body.material);
    m.castShadow = true;
    g.add(m);
    out.inner.add(g);
    cranks.push(g);
  }
  const wheel = new THREE.Group();
  wheel.position.set(0, -0.06, wz);
  parts.cyl(0, 0, 0, 0.1, 0.56, 0.1, grey, 0, 0, Math.PI / 2, 8);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    parts.box(0, Math.sin(a) * 0.17, Math.cos(a) * 0.17, 0.5, 0.025, 0.3, S.plastic(color, 0.5), a, 0, 0);
  }
  const wm = new THREE.Mesh(parts.build(), out.body.material);
  wm.castShadow = true;
  wheel.add(wm);
  out.inner.add(wheel);
  let crank = 0;
  out.animate = (dt, throttle, speed) => {
    const push = throttle * 5.5 + Math.min(2, Math.abs(speed)) * 0.6;
    crank += dt * push * (speed < -0.15 ? -1 : 1);
    for (const g of cranks) g.rotation.x = crank;
    wheel.rotation.x = -crank * 1.3;
  };
  out.seat = (who, h) => pedalSeat(h, who === 'driver' ? -P.seatX : P.seatX, crank + (who === 'driver' ? 0 : 1.2));
  const prevDispose = out.dispose;
  out.dispose = () => {
    prevDispose();
    crankGeo.dispose();
    wm.geometry.dispose();
  };
  return out;
}

export function buildBoatVisual(def: VehicleDef, color: number): BoatVisual {
  return def.id === 'airboat' ? buildAirboat(def, color) : def.id === 'pedalo' ? buildPedalo(def, color) : buildSkiff(def, color);
}

void C;
