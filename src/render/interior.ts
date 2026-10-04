import * as THREE from 'three';
import { MeshBuilder, S } from './builder';
import { DASH_H, HIP_ABOVE_TOP, SEAT_TOP, cabinPartModel, steerColumn, steerRim, steerStub } from './cabinModels';
import { SPECS, restHeight } from './carSpecs';
import { cabinPart } from '../sim/cabin';
import type { Fit } from '../sim/parts';
import { INTERIOR_SLOTS, type PartSlot, type VehicleDef } from '../data';
import type { Humanoid } from './humanoid';
import { bodyMat, type VehicleVisual } from './vehicleKit';
import { cabinGaps } from '../sim/cabin';
import { shared } from './dispose';

/**
 * The cabin of a drivable vehicle: where the seats, the wheel and the dash are, and how they are drawn. The cabin is its
 * own mesh (not baked into the body shell), so it is lit and shadowed on its own, shows through an open door or a broken
 * window, and can be rebuilt when a part is swapped without touching the bodywork. Layouts are in the ground frame (y = 0
 * is the road under the car); `g0` shifts to the chassis frame.
 */

export interface SeatSpot {
  x: number;
  z: number;
  /** Height of the occupant's hip joint. The cushion top is `HIP_ABOVE_TOP` below it. */
  hip: number;
  /** Width across the cushion, or across the whole bench. */
  w: number;
}

export interface CabinLayout {
  kind: 'car' | 'open';
  g0: number;
  floor: number;
  ceil: number;
  /** Half the clear width between the door cards. */
  hw: number;
  /** Front of the cabin (the firewall) and the back wall, in z. */
  zFront: number;
  zBack: number;
  seats: Partial<Record<'seatD' | 'seatP' | 'seatR', SeatSpot>>;
  /** Hub of the wheel and how far the column leans (radians from the axis pointing straight forward). */
  steer: { x: number; y: number; z: number; tilt: number };
  /** The dash: centre z, height of its top, width, depth, and which side (x) the instruments face. */
  dash: { z: number; top: number; w: number; depth: number; driverX: number };
}

/** Per-chassis numbers that do not follow from the outline: where the dash and the wheel go. */
const FIT: Record<string, { dashZ: number; wheelDz: number; wheelUp: number; tilt: number; depth: number; backZ: number; ceilDrop: number }> = {
  hatch: { dashZ: 0.58, wheelDz: 0.44, wheelUp: 0.27, tilt: 0.5, depth: 0.34, backZ: -1.7, ceilDrop: 0.045 },
  sedan: { dashZ: 0.68, wheelDz: 0.46, wheelUp: 0.27, tilt: 0.5, depth: 0.34, backZ: -1.4, ceilDrop: 0.045 },
  pickup: { dashZ: 0.8, wheelDz: 0.5, wheelUp: 0.3, tilt: 0.6, depth: 0.34, backZ: -0.52, ceilDrop: 0.05 },
  van: { dashZ: 1.36, wheelDz: 0.42, wheelUp: 0.26, tilt: 1.0, depth: 0.26, backZ: 0.52, ceilDrop: 0.17 },
};

/** The cabin of a vehicle, or null when it has none the garage fits (bikes, trucks, boats). */
export function cabinLayout(def: VehicleDef): CabinLayout | null {
  const sp = SPECS[def.id as keyof typeof SPECS];
  if (sp && def.seat) {
    const f = FIT[sp.id];
    const g0 = restHeight(def);
    const floor = sp.sill + 0.06;
    const ceil = sp.roof - f.ceilDrop;
    const hw = sp.W / 2 - 0.14;
    const hip = Math.min(floor + 0.45, ceil - 0.78);
    const dx = def.seat.driver[0];
    const hipZ = def.seat.driver[2] - 0.05;
    const seats: CabinLayout['seats'] = {
      seatD: { x: dx, z: hipZ, hip, w: 0.54 },
      seatP: { x: def.seat.passenger[0], z: def.seat.passenger[2] - 0.05, hip, w: 0.54 },
    };
    if (sp.id === 'hatch' || sp.id === 'sedan') seats.seatR = { x: 0, z: hipZ - 0.95, hip, w: 2 * (hw - 0.14) };
    return {
      kind: 'car',
      g0,
      floor,
      ceil,
      hw,
      zFront: sp.wsBase + 0.02,
      zBack: f.backZ,
      seats,
      steer: { x: dx, y: hip + f.wheelUp, z: hipZ + f.wheelDz, tilt: f.tilt },
      dash: { z: f.dashZ, top: sp.belt + 0.07, w: 2 * hw - 0.04, depth: f.depth, driverX: Math.sign(dx) || 1 },
    };
  }
  if (def.id === 'buggy') {
    return {
      kind: 'open',
      g0: 0,
      floor: -0.17,
      ceil: 1.3,
      hw: 0.62,
      zFront: 0.52,
      zBack: -0.62,
      seats: { seatD: { x: 0.38, z: -0.1, hip: 0.24, w: 0.5 } },
      steer: { x: 0.38, y: 0.46, z: 0.28, tilt: 0.6 },
      dash: { z: 0.4, top: 0.4, w: 1.3, depth: 0.3, driverX: 1 },
    };
  }
  return null;
}

/** Where a cabin slot sits as a box in the ground frame, for the sockets: centre and full size. */
export function cabinAnchor(L: CabinLayout, slot: PartSlot): { x: number; y: number; z: number; sx: number; sy: number; sz: number } | null {
  if (slot === 'seatD' || slot === 'seatP' || slot === 'seatR') {
    const s = L.seats[slot];
    if (!s) return null;
    const top = s.hip - HIP_ABOVE_TOP;
    return { x: s.x, y: (top + L.floor) / 2 + 0.28, z: s.z - 0.05, sx: s.w, sy: top - L.floor + 0.55, sz: 0.7 };
  }
  if (slot === 'steer') return { x: L.steer.x, y: L.steer.y, z: L.steer.z, sx: 0.4, sy: 0.4, sz: 0.4 };
  if (slot === 'dash') return { x: 0, y: L.dash.top - 0.12, z: L.dash.z, sx: L.dash.w, sy: 0.3, sz: L.dash.depth };
  return null;
}

/** The ids drawn for each cabin slot, as a cache key: only these (and the chassis) decide what the cabin mesh looks like. */
export function cabinKey(def: VehicleDef, fit: Fit): string {
  return INTERIOR_SLOTS.map((s) => cabinPart(def, fit, s)?.id ?? '-').join(',');
}

/** The steering wheel's rim is a mesh of its own so it can turn: where it goes. */
export interface RimSpot {
  id: string;
  x: number;
  y: number;
  z: number;
  tilt: number;
}

const _m = new THREE.Matrix4();
const place = (x: number, y: number, z: number, rx = 0, ry = 0) => _m.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, 0, 'YXZ')), new THREE.Vector3(1, 1, 1));

/** Draw `part` (a cabin part model) into `b` at a spot. */
function put(b: MeshBuilder, id: string, x: number, y: number, z: number, o: { w?: number; driverX?: number } = {}) {
  const t = new MeshBuilder();
  t.jitter = 0.03;
  cabinPartModel(t, id, o);
  b.appendMatrix(t, place(x, y, z));
}

/**
 * Draw the whole cabin of `def` for a given set of fitted parts into `b`: the floor, the headliner and the trim that are
 * always there, and a model for each seat, the dash and the wheel's column, or the gap where one is missing. Returns where
 * the wheel's rim goes (null when the wheel is missing), for the caller to hang on a turning pivot.
 */
export function drawCabin(b: MeshBuilder, def: VehicleDef, fit: Fit): RimSpot | null {
  const L = cabinLayout(def);
  if (!L) return null;
  const sp = SPECS[def.id as keyof typeof SPECS];
  const carpet = S.cloth(0x4a4338, 0.7);
  const plasticDark = S.plastic(0x23211f, 0.5);
  const lining = S.cloth(0x7c7566, 0.6);
  const { floor, hw } = L;
  const zm = (L.zFront + L.zBack) / 2;
  const len = L.zFront - L.zBack;
  if (L.kind === 'car') {
    // Floor pan with mats, the tunnel between the seats and a liner on the firewall.
    b.rbox(0, floor - 0.02, zm, hw * 2, 0.04, len, 0.01, carpet);
    b.rbox(0, floor + 0.05, zm + 0.2, 0.2, 0.1, len - 0.5, 0.04, S.cloth(0x3e382e, 0.7));
    b.rbox(0, (floor + L.dash.top) / 2, L.zFront - 0.015, hw * 2, L.dash.top - floor, 0.03, 0.01, S.plastic(0x2e2b27, 0.6));
    // Sill plates and a seam of trim along each door sill.
    for (const sx of [1, -1]) {
      b.rbox(sx * (hw - 0.02), floor + 0.02, zm, 0.06, 0.04, len, 0.012, S.steel(0x4a4d50, 0.7));
      b.rbox(sx * (hw - 0.012), floor + 0.17, zm, 0.024, 0.2, len, 0.01, plasticDark);
    }
    // Headliner under the roof, with sun visors and a mirror on the screen header.
    const z1 = sp.wsTop - 0.02;
    const z0 = sp.id === 'van' ? sp.rwBase + 0.04 : sp.id === 'pickup' ? sp.rwBase + 0.04 : sp.rwTop + 0.04;
    b.rbox(0, L.ceil + 0.015, (z0 + z1) / 2, sp.W - 0.32, 0.03, z1 - z0, 0.012, lining);
    for (const sx of [1, -1]) b.rbox(sx * 0.38, L.ceil - 0.012, z1 - 0.12, 0.38, 0.02, 0.2, 0.008, S.cloth(0x6a6455, 0.65));
    b.rod(0, L.ceil, z1 - 0.02, 0.02, L.ceil - 0.1, z1 + 0.04, 0.008, plasticDark, 5);
    b.rbox(0.02, L.ceil - 0.12, z1 + 0.05, 0.22, 0.06, 0.025, 0.012, plasticDark);
    b.box(0.02, L.ceil - 0.12, z1 + 0.036, 0.19, 0.045, 0.004, S.chrome(0xb8bcc0));
    // The back wall of the cab (pickup, van), the parcel shelf (sedan) and the humps over the rear wheels.
    if (sp.id === 'pickup' || sp.id === 'van') b.rbox(0, (floor + L.ceil) / 2, L.zBack - 0.01, hw * 2, L.ceil - floor, 0.04, 0.01, S.plastic(0x2e2b27, 0.6));
    if (sp.id === 'sedan') b.rbox(0, sp.belt - 0.012, (L.zBack + sp.rwBase - 0.05) / 2 - 0.02, hw * 2, 0.024, L.zBack - sp.rwBase + 0.5, 0.008, S.cloth(0x3a352c, 0.8));
    if (sp.id === 'hatch' || sp.id === 'sedan') {
      const wz = def.physics.wheelsZ[1];
      const R = def.physics.wheelRadius;
      for (const sx of [1, -1]) b.rbox(sx * (hw - 0.1), (floor + R * 2 + 0.06) / 2, wz, 0.04, R * 2 + 0.06 - floor, (R + 0.08) * 2, 0.015, S.plastic(0x2e2b27, 0.6));
    }
  } else {
    // Open cab: just a floor plate and the mats.
    b.rbox(0.38, floor, -0.1, 0.62, 0.02, 0.9, 0.008, carpet);
  }
  // Seats.
  for (const slot of ['seatD', 'seatP', 'seatR'] as const) {
    const s = L.seats[slot];
    if (!s) continue;
    const part = cabinPart(def, fit, slot);
    if (!part) continue;
    const base = part.empty ? floor : Math.max(floor, s.hip - HIP_ABOVE_TOP - SEAT_TOP);
    // A seat that sits above the floor on a frame.
    if (!part.empty && base > floor + 0.02) b.rbox(s.x, (floor + base) / 2, s.z, s.w * 0.7, base - floor, 0.4, 0.015, S.steel(0x2a2c2e, 0.7));
    put(b, part.id, s.x, base, s.z, { w: slot === 'seatR' ? s.w : 0.54 });
  }
  // Dash.
  const dash = cabinPart(def, fit, 'dash');
  if (dash) put(b, dash.id, 0, L.dash.top - DASH_H, L.dash.z, { w: L.dash.w, driverX: L.dash.driverX });
  // Wheel column (the rim is separate), or the stub where the wheel was.
  const steer = cabinPart(def, fit, 'steer');
  let rim: RimSpot | null = null;
  if (steer) {
    const c = new MeshBuilder();
    c.jitter = 0.03;
    if (steer.empty) steerStub(c);
    else steerColumn(c, 0.42);
    b.appendMatrix(c, place(L.steer.x, L.steer.y, L.steer.z, L.steer.tilt));
    if (!steer.empty) rim = { id: steer.id, x: L.steer.x, y: L.steer.y, z: L.steer.z, tilt: L.steer.tilt };
  }
  return rim;
}

/** The turning rim of a wheel, in its own frame: its geometry is cached per id and shared by every car. */
export function rimGeometry(id: string): THREE.BufferGeometry {
  const hit = rimCache.get(id);
  if (hit) return hit;
  const b = new MeshBuilder();
  b.jitter = 0.03;
  steerRim(b, id);
  const g = shared(b.build());
  rimCache.set(id, g);
  return g;
}
const rimCache = new Map<string, THREE.BufferGeometry>();

/** Add a faint light of its own to everything from vertex `from`: the cabin is under a roof, so the sun does not reach it. */
export function fillLight(b: MeshBuilder, from: number, e: number) {
  for (let i = from; i < b.srf.length / 4; i++) if (b.srf[i * 4 + 3] < e) b.srf[i * 4 + 3] = e;
}

// ------------------------------------------------------------------------------------------------ occupants

/** The hip height of an occupant: the layout's, or on the floor with no seat under them. */
export function hipHeight(L: CabinLayout, spot: SeatSpot, missing: boolean, drop: number): number {
  if (!missing) return spot.hip;
  return Math.max(L.floor + 0.2, spot.hip - drop);
}

/**
 * Sit a person in a seat: the hips down on the cushion and the legs folded so the feet land on the floor under the dash,
 * whatever pose they were last given. Call after `Humanoid.update`, every frame. `reach` is how far forward the feet go.
 * Positions are in the chassis frame (the visual's inner group), the way the rest of the visual is.
 */
export function seatOccupant(h: Humanoid, L: CabinLayout, spot: SeatSpot, hip: number, lean = -0.06) {
  const floorY = L.floor - L.g0;
  // A taller or shorter rider is the whole rig scaled: the hips go on the cushion all the same, the legs reach further.
  const k = h.root.scale.y;
  h.root.position.set(spot.x, floorY, spot.z);
  h.hips.position.y = (hip - L.floor) / k;
  h.hips.position.z = 0;
  h.torso.rotation.x = lean;
  // Two equal links from the hip to the heel: thigh and shin 0.43 m. The foot ends up under the dash on the floor.
  const D = Math.max(0.12, hip - L.floor - 0.07);
  const R = Math.min(0.78, Math.max(0.45, L.zFront - 0.18 - spot.z));
  const d = Math.min(0.85 * k, Math.hypot(R, D));
  const phi = Math.atan2(R, D);
  const alpha = Math.acos(Math.min(1, d / (0.86 * k)));
  const thigh = phi + alpha;
  const shin = phi - alpha;
  for (const [leg, knee, sx] of [[h.legL, h.kneeL, 1], [h.legR, h.kneeR, -1]] as const) {
    leg.rotation.x = -thigh;
    leg.rotation.z = sx * 0.04;
    knee.rotation.x = thigh - shin;
  }
}

/** The light a cabin gets of its own: the roof keeps the sun off it, so without a fill it reads as a black hole. */
export const CABIN_FILL = 0.2;

/**
 * Build a cabin straight onto a visual (vehicles that are not cached shells: the buggy). The seat, the wheel and the
 * dash are drawn as fitted; the wheel's rim turns, and `seat` sits the driver.
 */
export function attachCabin(v: VehicleVisual, def: VehicleDef, fit: Fit, seed: number) {
  const L = cabinLayout(def);
  if (!L) return;
  const b = new MeshBuilder();
  b.jitter = 0.03;
  b.roundSeg = 2;
  b.seed(seed + 9);
  const rim = drawCabin(b, def, fit);
  fillLight(b, 0, CABIN_FILL);
  const geo = b.build();
  geo.translate(0, -L.g0, 0);
  v.interior = new THREE.Mesh(geo, bodyMat);
  v.interior.receiveShadow = true;
  v.inner.add(v.interior);
  if (rim) {
    const pivot = new THREE.Group();
    pivot.position.set(rim.x, rim.y - L.g0, rim.z);
    pivot.rotation.x = rim.tilt;
    const mesh = new THREE.Mesh(rimGeometry(rim.id), bodyMat);
    pivot.add(mesh);
    v.inner.add(pivot);
    v.steerWheel = mesh;
  }
  const gaps = cabinGaps(def, fit);
  v.seat = (who, h, drop) => {
    if (who !== 'driver' || !L.seats.seatD) return;
    seatOccupant(h, L, L.seats.seatD, hipHeight(L, L.seats.seatD, gaps.seatD, drop));
  };
}
