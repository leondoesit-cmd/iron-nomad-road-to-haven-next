import * as THREE from 'three';
import type { PaneSet } from './glass';
import { MeshBuilder, S } from './builder';
import { Humanoid } from './humanoid';
import type { VehicleDef } from '../data';
import { shared } from './dispose';
import { kitMaterial, lampMaterials } from './materials';
import type { Rig } from './attachments';

/**
 * Shared vehicle plumbing: the body material, wheels, lamps and the blank visual every chassis model starts from.
 * Chassis models live in vehicleModels.ts (the tiers) and carModels.ts (found cars).
 */

export const bodyMat = kitMaterial();
const lamps = lampMaterials(0xfff1c8, 9);
export const lightMat = lamps.on;
export const lightOffMat = lamps.off;
const brakeMat = shared(new THREE.MeshStandardMaterial({ color: 0x3a0604, emissive: 0xff2414, emissiveIntensity: 2.4, roughness: 0.25 }));
const amberMat = shared(new THREE.MeshStandardMaterial({ color: 0x3a2004, emissive: 0xff9a1a, emissiveIntensity: 1.2, roughness: 0.25 }));

export interface WheelVisual {
  /** Positioned at the wheel centre, yawed by steering. */
  pivot: THREE.Group;
  spin: THREE.Group;
  steered: boolean;
  radius: number;
  /** 0..1 how flat the tyre is, eased so a puncture settles rather than snaps. */
  flatK: number;
  /** No tyre on this wheel: nothing to puncture. */
  bare?: boolean;
}

export interface VehicleVisual {
  root: THREE.Group;
  /** Roll pivot used to lean two-wheelers. */
  lean: THREE.Group;
  inner: THREE.Group;
  body: THREE.Mesh;
  wheels: WheelVisual[];
  driver: Humanoid | null;
  passenger: Humanoid | null;
  /** Pivot for a rotating gun (T3 bed MG). */
  gun: THREE.Group | null;
  /** World-space-ish anchor for muzzle flashes (child of gun or body). */
  muzzle: THREE.Object3D;
  headlights: THREE.Mesh[];
  /** Brake and indicator lenses, so a crumpled tail can carry them along. */
  tails?: THREE.Mesh[];
  /** The car's windows, in the chassis frame. */
  panes?: PaneSet;
  /** The cabin: floor, headliner, seats, dash, in a mesh of its own (see `interior.ts`). */
  interior?: THREE.Mesh;
  /** The engine bay under a bonnet that opens: hidden until the bonnet is up (see `bayMesh.ts`). */
  bay?: THREE.Mesh;
  /** The bay mesh stays drawn with the bonnet shut: a bonnet with a hole cut in it shows the engine standing through it. */
  bayAlways?: boolean;
  /** The steering wheel's rim, turned with the steering. */
  steerWheel?: THREE.Object3D;
  /** Sit an occupant in their seat, every frame after the pose; `drop` is how far a missing seat lets them sink. */
  seat?: (who: 'driver' | 'passenger', h: Humanoid, drop: number) => void;
  smoke: THREE.Object3D;
  /** Where the second seat's occupant stands (bed gun post or passenger seat), in the chassis frame. */
  gunSeat: [number, number, number];
  /** Seat occupants built on first use, so a car parked by the road does not carry two idle people. */
  lazy?: { driver?: () => Humanoid; passenger?: () => Humanoid };
  /** Ground offset (distance from the chassis origin to the ground) for lean pivoting. */
  groundY: number;
  /** How far the body is drawn above (or below) its wheels by the springs fitted, metres (see `rideHeight.ts`). */
  rideLift?: number;
  setHeadlights(on: boolean): void;
  damageTint(frac: number): void;
  dispose(): void;
}

// ----------------------------------------------------------------------------------------- wheels

export interface WheelStyle {
  tread: 'road' | 'knobby' | 'moto' | 'truck' | 'paddle';
  /** The knobby family's pattern: an all-terrain block (the default), a mud-terrain's open chevrons, a crawler's big lugs. */
  lug?: 'at' | 'mud' | 'crawler';
  rim: 'wire' | 'steel' | 'spoke' | 'beadlock' | 'alloy' | 'hubcap' | 'split';
  rimColor: number;
  /** No tyre at all: the rim runs bare on the hub. */
  bare?: boolean;
  /** Brake calipers painted this colour; big drilled discs. */
  caliper?: number;
  /** The brakes are off: no disc or drum behind the rim. */
  noBrake?: boolean;
  /** Two tyres on one hub, the way a truck's drive and trailer axles run. */
  dual?: boolean;
  /** Vulcanised patches on the sidewall: a tyre that has been mended more than once. */
  patched?: boolean;
}

const wheelGeoCache = new Map<string, THREE.BufferGeometry>();

/** Rim-to-tyre ratio by tread: off-road tyres stand on taller sidewalls, a road tyre on a bigger rim. */
function rimFrac(st: WheelStyle): number {
  if (st.bare) return 0.9;
  if (st.tread === 'moto') return 0.72;
  if (st.tread === 'truck') return 0.58;
  if (st.tread === 'paddle') return 0.6;
  if (st.tread === 'knobby') return st.lug === 'mud' ? 0.55 : st.lug === 'crawler' ? 0.58 : st.rim === 'beadlock' ? 0.62 : 0.6;
  return st.rim === 'alloy' ? 0.64 : 0.6;
}

/**
 * One tyre on its centre line `cx` (axle along X): the lathed carcass and its tread. Patterns are what tells the tyres apart
 * from across the road: a road tyre's ribs and sipes, an all-terrain's staggered blocks, a mud-terrain's open chevrons with
 * shoulder lugs down the sidewall, a crawler's huge blocks, a truck's directional bars, a sand tyre's paddles.
 */
function tyre(b: MeshBuilder, key: string, R: number, rimR: number, cx: number, width: number, st: WheelStyle, plain = false) {
  const hw = width / 2;
  const moto = st.tread === 'moto';
  const off = st.tread !== 'road';
  const tread = off ? R * 0.94 : R * 0.97;
  // Tyre carcass (axle along Y in the lathe, rotated onto X).
  const prof: [number, number][] = moto
    ? [[rimR, -hw * 0.7], [R * 0.86, -hw], [tread * 0.99, -hw * 0.75], [tread, -hw * 0.35], [tread, hw * 0.35], [tread * 0.99, hw * 0.75], [R * 0.86, hw], [rimR, hw * 0.7]]
    : [[rimR, -hw * 0.82], [R * 0.82, -hw], [tread * 0.985, -hw * 0.94], [tread, -hw * 0.7], [tread, hw * 0.7], [tread * 0.985, hw * 0.94], [R * 0.82, hw], [rimR, hw * 0.82]];
  b.lathe(`tyre:${key}`, prof, cx, 0, 0, S.rubber(0x1c1c1e), 0, 0, Math.PI / 2, 28);
  // The inner tyre of a twin is hidden behind the outer one: its carcass is enough.
  if (plain) return;
  const rubber = S.rubber(0x161618);
  // A lug as a short prism lying on the crown from (x0, angle a0) to (x1, angle a1).
  const lug = (x0: number, a0: number, x1: number, a1: number, r: number, h: number) => {
    const kr = tread + h * 0.5;
    b.rod(cx + x0, Math.sin(a0) * kr, Math.cos(a0) * kr, cx + x1, Math.sin(a1) * kr, Math.cos(a1) * kr, r, rubber, 4);
  };
  if (st.tread === 'knobby' && st.lug === 'mud') {
    // Open chevrons, a big void between each, and a lug curling down each shoulder.
    const n = Math.round((Math.PI * 2 * R) / 0.11);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const d = 0.06 / R;
      for (const sx of [1, -1]) {
        lug(sx * hw * 0.08, a + (i % 2 ? d * 0.4 : 0), sx * hw * 0.7, a + d, width * 0.07, 0.03);
        const sy = Math.sin(a + d);
        const sz = Math.cos(a + d);
        b.box(cx + sx * hw * 0.9, sy * (R * 0.86), sz * (R * 0.86), hw * 0.22, R * 0.1, R * 0.11, rubber, Math.PI / 2 - (a + d), 0, 0);
      }
    }
  } else if (st.tread === 'knobby' && st.lug === 'crawler') {
    // Huge staggered blocks across the crown and sidewall lugs that bite on rock.
    const n = Math.round((Math.PI * 2 * R) / 0.12);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const stag = i % 2 ? 1 : -1;
      const kr = tread + 0.018;
      b.box(cx + stag * hw * 0.26, Math.sin(a) * kr, Math.cos(a) * kr, width * 0.46, 0.036, R * 0.16, rubber, Math.PI / 2 - a, 0, 0);
      b.box(cx - stag * hw * 0.68, Math.sin(a) * (kr - 0.004), Math.cos(a) * (kr - 0.004), width * 0.3, 0.034, R * 0.13, rubber, Math.PI / 2 - a, 0, 0);
      for (const sx of [1, -1]) b.box(cx + sx * hw * 0.92, Math.sin(a + 0.05) * R * 0.84, Math.cos(a + 0.05) * R * 0.84, hw * 0.16, R * 0.12, R * 0.09, rubber, Math.PI / 2 - a, 0, 0);
    }
  } else if (st.tread === 'knobby' || moto) {
    // Staggered knobs across the crown and on the shoulders.
    const n = Math.round((Math.PI * 2 * R) / (moto ? 0.045 : 0.07));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const cy = Math.sin(a);
      const cz = Math.cos(a);
      const stag = i % 2 ? 1 : -1;
      const kr = tread + 0.012;
      b.box(cx + stag * hw * 0.32, cy * kr, cz * kr, width * (moto ? 0.4 : 0.34), moto ? 0.018 : 0.024, R * (moto ? 0.07 : 0.1), rubber, Math.PI / 2 - a, 0, 0);
      if (!moto) b.box(cx - stag * hw * 0.82, cy * (tread - 0.004), cz * (tread - 0.004), width * 0.2, 0.022, R * 0.11, rubber, Math.PI / 2 - a, 0, 0);
    }
  } else if (st.tread === 'truck') {
    // Directional bars: two angled lugs meeting off-centre, alternating, the pattern of a military or drive tyre.
    const n = Math.round((Math.PI * 2 * R) / 0.13);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const d = 0.08 / R;
      const mid = (i % 2 ? 1 : -1) * hw * 0.12;
      lug(-hw * 0.86, a, mid, a + d, width * 0.05, 0.026);
      lug(hw * 0.86, a, mid, a + d, width * 0.05, 0.026);
    }
    // A centre rib so it reads as a road-going truck tyre, not a tractor's.
    b.torus(cx, 0, 0, tread + 0.004, 0.012, rubber, 0, Math.PI / 2, 0, 4, 40);
  } else if (st.tread === 'paddle') {
    // Sand tyre: a smooth crown with a paddle across it every twentieth of a turn.
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      b.box(cx, Math.sin(a) * (tread + 0.03), Math.cos(a) * (tread + 0.03), width * 0.96, 0.07, 0.022, rubber, Math.PI / 2 - a, 0, 0);
    }
  } else {
    // Road tyre: two circumferential grooves and sipes.
    const n = Math.round((Math.PI * 2 * R) / 0.05);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      b.box(cx, Math.sin(a) * (tread + 0.003), Math.cos(a) * (tread + 0.003), width * 0.9, 0.008, 0.012, rubber, Math.PI / 2 - a, 0, 0);
    }
  }
  if (st.patched) {
    // Grey vulcanised plugs on the outer sidewall.
    const patch = S.rubber(0x3a3a3c);
    for (const a of [0.7, 2.6, 4.4]) b.rbox(cx + hw * 0.86, Math.sin(a) * (rimR + R) * 0.5, Math.cos(a) * (rimR + R) * 0.5, 0.012, (R - rimR) * 0.42, (R - rimR) * 0.5, 0.004, patch, Math.PI / 2 - a, 0, 0);
  }
}

/** A wheel with its axle along X: lathed tyre with rounded shoulders, tread blocks, rim, hub and brake. */
export function wheelGeometry(radius: number, width: number, st: WheelStyle): THREE.BufferGeometry {
  const key = `${radius}:${width}:${st.tread}:${st.lug ?? ''}:${st.rim}:${st.rimColor}:${st.bare ? 'b' : ''}${st.caliper ?? ''}${st.noBrake ? 'n' : ''}${st.dual ? 'd' : ''}${st.patched ? 'p' : ''}`;
  const hit = wheelGeoCache.get(key);
  if (hit) return hit;
  const b = new MeshBuilder();
  b.jitter = 0.02;
  const hw = width / 2;
  const R = radius;
  const moto = st.tread === 'moto';
  const rimR = R * rimFrac(st);
  if (!st.bare) {
    if (st.dual) {
      // Two tyres with a hand's width between them; the outer one carries the rim face.
      tyre(b, `${key}:o`, R, rimR, hw * 0.5, width * 0.47, st);
      tyre(b, `${key}:o`, R, rimR, -hw * 0.5, width * 0.47, st, true);
    } else tyre(b, key, R, rimR, 0, width, st);
  }
  // Rim: barrel and face.
  const rimS = st.rim === 'wire' ? S.chrome(0xb8bcc0) : st.rim === 'alloy' ? S.metal(st.rimColor, 0.35) : S.paint(st.rimColor, 0.5);
  b.lathe(`rim:${key}`, [[rimR * 0.98, -hw * 0.78], [rimR, -hw * 0.7], [rimR * 0.96, -hw * 0.6], [rimR * 0.94, hw * 0.6], [rimR, hw * 0.7], [rimR * 0.98, hw * 0.78]], 0, 0, 0, rimS, 0, 0, Math.PI / 2, 24);
  const face = hw * (moto ? 0 : st.dual ? 0.62 : 0.25);
  if (st.rim === 'alloy' || st.rim === 'hubcap' || st.rim === 'split') {
    if (!st.noBrake) {
      b.cyl(-hw * 0.42, 0, 0, rimR * 1.7, 0.02, rimR * 1.7, S.metal(0x7a7e82, 0.5), 0, 0, Math.PI / 2, 22);
      if (st.caliper !== undefined) b.rbox(-hw * 0.42, rimR * 0.78, rimR * 0.2, 0.07, rimR * 0.5, rimR * 0.5, 0.01, S.paint(st.caliper, 0.35));
    }
    rimFace(b, st, rimR, face, rimS);
  } else if (st.rim === 'wire') {
    // Laced spokes from a hub to the rim, crossing.
    b.cyl(0, 0, 0, R * 0.16, width * 0.9, R * 0.16, S.metal(0x8a8e92), 0, 0, Math.PI / 2, 14);
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const side = i % 2 ? 1 : -1;
      const a2 = a + side * 0.35;
      b.rod(side * hw * 0.35, Math.sin(a) * R * 0.07, Math.cos(a) * R * 0.07, 0, Math.sin(a2) * rimR * 0.95, Math.cos(a2) * rimR * 0.95, 0.0035, S.chrome(), 6);
    }
    // Drum brake on the right.
    if (!st.noBrake) b.cyl(-hw * 0.4, 0, 0, R * 0.42, 0.04, R * 0.42, S.metal(0x6a6d70, 0.6), 0, 0, Math.PI / 2, 16);
    if (st.caliper !== undefined) b.rbox(-hw * 0.4, R * 0.3, 0, 0.06, R * 0.22, R * 0.2, 0.01, S.paint(st.caliper, 0.35));
  } else {
    // The disc behind the rim, with its caliper when the brakes are upgraded.
    if (!st.noBrake) {
      b.cyl(-hw * 0.42, 0, 0, rimR * 1.7, 0.02, rimR * 1.7, S.metal(0x7a7e82, 0.5), 0, 0, Math.PI / 2, 22);
      if (st.caliper !== undefined) b.rbox(-hw * 0.42, rimR * 0.78, rimR * 0.2, 0.07, rimR * 0.5, rimR * 0.5, 0.01, S.paint(st.caliper, 0.35));
    }
    b.cyl(face, 0, 0, rimR * 1.88, 0.02, rimR * 1.88, rimS, 0, 0, Math.PI / 2, 24);
    if (st.rim === 'steel') {
      // Pressed steel: a ring of ventilation holes and a domed centre.
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        b.cyl(face + 0.012, Math.sin(a) * rimR * 0.62, Math.cos(a) * rimR * 0.62, rimR * 0.24, 0.01, rimR * 0.24, S.metal(0x161616, 0.5), 0, 0, Math.PI / 2, 10);
      }
    } else if (st.rim === 'spoke' || st.rim === 'beadlock') {
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        b.box(face + 0.02, Math.sin(a) * rimR * 0.52, Math.cos(a) * rimR * 0.52, 0.03, rimR * 0.62, rimR * 0.2, rimS, Math.PI / 2 - a, 0, 0);
      }
      if (st.rim === 'beadlock') {
        // Bolted outer ring.
        b.torus(face + 0.03, 0, 0, rimR * 0.97, 0.02, S.steel(0x3a3c3e), 0, Math.PI / 2, 0, 6, 28);
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * Math.PI * 2;
          b.cyl(face + 0.045, Math.sin(a) * rimR * 0.97, Math.cos(a) * rimR * 0.97, 0.03, 0.02, 0.03, S.steel(), 0, 0, Math.PI / 2, 6);
        }
      }
    }
    // Hub cap and lug nuts.
    b.cyl(face + 0.03, 0, 0, rimR * 0.42, 0.05, rimR * 0.42, S.metal(0x9a9ea2, 0.5), 0, 0, Math.PI / 2, 16);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      b.cyl(face + 0.06, Math.sin(a) * rimR * 0.3, Math.cos(a) * rimR * 0.3, 0.03, 0.025, 0.03, S.steel(0x5a5d60), 0, 0, Math.PI / 2, 6);
    }
  }
  const g = shared(b.build());
  wheelGeoCache.set(key, g);
  return g;
}

/**
 * The faces that are not pressed steel: a cast alloy with five split spokes and a polished lip, a plastic hubcap with its
 * vents over a steel wheel, and the military split rim with its ring of clamp bolts and ten studs.
 */
function rimFace(b: MeshBuilder, st: WheelStyle, rimR: number, face: number, rimS: ReturnType<typeof S.paint>) {
  const dark = S.metal(0x161616, 0.5);
  if (st.rim === 'alloy') {
    // Dished face: a recessed disc behind the spokes, a bright machined lip, five twin spokes from a centre cap.
    b.cyl(face - 0.012, 0, 0, rimR * 1.86, 0.012, rimR * 1.86, dark, 0, 0, Math.PI / 2, 24);
    b.torus(face + 0.012, 0, 0, rimR * 0.95, rimR * 0.045, S.metal(0xd4d8dc, 0.2), 0, Math.PI / 2, 0, 4, 28);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      for (const d of [-0.11, 0.11]) {
        const aa = a + d;
        b.rod(face + 0.02, Math.sin(a) * rimR * 0.3, Math.cos(a) * rimR * 0.3, face + 0.005, Math.sin(aa) * rimR * 0.9, Math.cos(aa) * rimR * 0.9, rimR * 0.055, rimS, 4);
      }
    }
    b.cyl(face + 0.025, 0, 0, rimR * 0.5, 0.04, rimR * 0.5, rimS, 0, 0, Math.PI / 2, 16);
    b.cyl(face + 0.048, 0, 0, rimR * 0.24, 0.012, rimR * 0.24, S.metal(0x2a2c2e, 0.3), 0, 0, Math.PI / 2, 12);
  } else if (st.rim === 'hubcap') {
    // A plastic wheel cover clipped over a black steel wheel: domed, eight vents, a badge in the middle.
    const cover = S.plastic(st.rimColor, 0.45);
    b.cyl(face - 0.01, 0, 0, rimR * 1.9, 0.012, rimR * 1.9, S.paint(0x1e1e1e, 0.6), 0, 0, Math.PI / 2, 24);
    b.cyl(face + 0.01, 0, 0, rimR * 1.84, 0.024, rimR * 1.84, cover, 0, 0, Math.PI / 2, 24);
    b.cyl(face + 0.03, 0, 0, rimR * 1.2, 0.02, rimR * 1.2, cover, 0, 0, Math.PI / 2, 20);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      b.box(face + 0.024, Math.sin(a) * rimR * 0.76, Math.cos(a) * rimR * 0.76, 0.006, rimR * 0.08, rimR * 0.22, dark, Math.PI / 2 - a, 0, 0);
    }
    b.cyl(face + 0.042, 0, 0, rimR * 0.3, 0.01, rimR * 0.3, S.chrome(0xb4b8bc), 0, 0, Math.PI / 2, 12);
  } else {
    // Split rim: a dished steel centre, a ring of clamp nuts round the join, and ten big studs.
    b.cyl(face, 0, 0, rimR * 1.88, 0.02, rimR * 1.88, rimS, 0, 0, Math.PI / 2, 24);
    b.torus(face + 0.012, 0, 0, rimR * 0.72, 0.012, rimS, 0, Math.PI / 2, 0, 4, 28);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      b.cyl(face + 0.024, Math.sin(a) * rimR * 0.84, Math.cos(a) * rimR * 0.84, 0.036, 0.024, 0.036, S.steel(0x3a3c3e), 0, 0, Math.PI / 2, 6);
    }
    b.cyl(face + 0.03, 0, 0, rimR * 0.62, 0.05, rimR * 0.62, S.steel(0x4a4d50, 0.6), 0, 0, Math.PI / 2, 16);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      b.cyl(face + 0.06, Math.sin(a) * rimR * 0.4, Math.cos(a) * rimR * 0.4, 0.042, 0.03, 0.042, S.steel(0x5a5d60), 0, 0, Math.PI / 2, 6);
    }
    b.cyl(face + 0.07, 0, 0, rimR * 0.22, 0.06, rimR * 0.22, S.steel(0x2a2c2e, 0.6), 0, 0, Math.PI / 2, 10);
  }
}

export interface WheelSpec {
  width: number;
  style: WheelStyle;
}

/** One model per wheel, so a vehicle can run a different tyre on each corner, or none. */
export function addWheelSet(v: VehicleVisual, def: VehicleDef, wheelLocal: [number, number, number][], steered: boolean[], specs: WheelSpec[]) {
  wheelLocal.forEach(([x, y, z], i) => {
    const sp = specs[i] ?? specs[0];
    const geo = wheelGeometry(def.physics.wheelRadius, sp.width, sp.style);
    const pivot = new THREE.Group();
    pivot.position.set(x, y - def.physics.suspension.rest, z);
    const spin = new THREE.Group();
    const m = new THREE.Mesh(geo, bodyMat);
    m.castShadow = true;
    // Mirror the right-hand wheels so the rim face always looks outward.
    if (x < -0.01) m.scale.x = -1;
    spin.add(m);
    pivot.add(spin);
    v.inner.add(pivot);
    v.wheels.push({ pivot, spin, steered: steered[i], radius: def.physics.wheelRadius, flatK: 0, bare: !!sp.style.bare });
  });
}

export function addWheels(v: VehicleVisual, def: VehicleDef, wheelLocal: [number, number, number][], steered: boolean[], width: number, st: WheelStyle) {
  addWheelSet(v, def, wheelLocal, steered, [{ width, style: st }]);
}

// ----------------------------------------------------------------------------------------- shell

export function finish(v: VehicleVisual, bodyGeo: THREE.BufferGeometry): VehicleVisual {
  v.body = new THREE.Mesh(bodyGeo, bodyMat);
  v.body.castShadow = true;
  v.body.receiveShadow = true;
  v.inner.add(v.body);
  v.setHeadlights = (on: boolean) => {
    for (const h of v.headlights) h.material = on ? lightMat : lightOffMat;
  };
  v.damageTint = () => {};
  v.dispose = () => {
    bodyGeo.dispose();
  };
  return v;
}

export function blank(def: VehicleDef): VehicleVisual {
  const p = def.physics;
  const groundY = Math.abs(p.hardY) + p.suspension.rest + p.wheelRadius;
  const root = new THREE.Group();
  const lean = new THREE.Group();
  const inner = new THREE.Group();
  lean.position.y = -groundY;
  inner.position.y = groundY;
  root.add(lean);
  lean.add(inner);
  return {
    root,
    lean,
    inner,
    body: null as unknown as THREE.Mesh,
    wheels: [],
    driver: null,
    passenger: null,
    gun: null,
    muzzle: new THREE.Object3D(),
    headlights: [],
    smoke: new THREE.Object3D(),
    gunSeat: [0, 0, -1.05],
    groundY,
    setHeadlights: () => {},
    damageTint: () => {},
    dispose: () => {},
  };
}

const lensGeo = shared(new THREE.SphereGeometry(0.5, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2));
const tailGeo = shared(new THREE.BoxGeometry(1, 1, 1));

const rectLensGeo = shared(new THREE.SphereGeometry(0.5, 12, 4, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2).scale(1, 1, 0.35));

/**
 * Headlight: chrome bucket in the body builder plus a glowing lens mesh registered for switching. With `w` and `h` the lamp
 * is a rectangular one (a square or wide lamp of the eighties): a flat lens of that size, its housing drawn by the caller.
 */
export function headlamp(v: VehicleVisual, b: MeshBuilder, x: number, y: number, z: number, r: number, bucket = true, w?: number, h?: number) {
  if (bucket && !w) {
    b.frustum(x, y, z - r * 0.45, r * 1.12, r * 0.7, r * 0.9, S.chrome(0xc8ccd0), Math.PI / 2, 0, 0, 16);
    b.torus(x, y, z + 0.0, r * 1.08, r * 0.1, S.chrome(), 0, 0, 0, 6, 20);
  }
  const m = new THREE.Mesh(w && h ? rectLensGeo : lensGeo, lightOffMat);
  m.position.set(x, y, z);
  if (w && h) m.scale.set(w, h, Math.min(w, h) * 0.6);
  else m.scale.set(r * 2, r * 2, r * 0.9);
  v.inner.add(m);
  v.headlights.push(m);
}

export function taillight(v: VehicleVisual, x: number, y: number, z: number, w = 0.12, h = 0.07, amber = false) {
  const m = new THREE.Mesh(tailGeo, amber ? amberMat : brakeMat);
  m.position.set(x, y, z);
  m.scale.set(w, h, 0.03);
  v.inner.add(m);
  (v.tails ??= []).push(m);
}

export function rider(color: number, helmet: number): Humanoid {
  return new Humanoid({ jacket: color, trim: 0x4a4636, helmet, scarf: new THREE.Color(color).multiplyScalar(0.45).getHex() });
}


/** A rig that drops lamps straight onto a live visual, for models that are built per instance. */
export function liveRig(v: VehicleVisual, b: MeshBuilder): Rig {
  return {
    lamp: (x, y, z, r, bucket = true, w, h) => headlamp(v, b, x, y, z, r, bucket, w, h),
    tail: (x, y, z, w, h, amber) => taillight(v, x, y, z, w, h, amber),
    muzzle: (x, y, z) => {
      v.muzzle.position.set(x, y, z);
      if (!v.muzzle.parent) v.inner.add(v.muzzle);
    },
  };
}

const WHEEL_DEFAULT: Record<string, { width: number; style: WheelStyle }> = {
  moped: { width: 0.11, style: { tread: 'moto', rim: 'wire', rimColor: 0xa0a4a8 } },
  quad: { width: 0.26, style: { tread: 'knobby', rim: 'spoke', rimColor: 0x2a2a2a } },
  buggy: { width: 0.34, style: { tread: 'knobby', rim: 'beadlock', rimColor: 0x2a2a2a } },
  hatch: { width: 0.2, style: { tread: 'road', rim: 'steel', rimColor: 0x6a6c6e } },
  sedan: { width: 0.22, style: { tread: 'road', rim: 'steel', rimColor: 0x5e6062 } },
  pickup: { width: 0.28, style: { tread: 'road', rim: 'steel', rimColor: 0x4a4c4e } },
  van: { width: 0.24, style: { tread: 'road', rim: 'steel', rimColor: 0x707274 } },
  // Military split rims in drab on directional bar tyres; the rig runs twin tyres on its drive and trailer axles.
  truck: { width: 0.42, style: { tread: 'truck', rim: 'split', rimColor: 0x4a5236 } },
  rig: { width: 0.62, style: { tread: 'truck', rim: 'split', rimColor: 0x3a3c3e } },
};

/** What the trim puts on a factory wheel: its rim style and colour (see sim/carTrim.ts). */
export interface RimLook {
  rims: 'steel' | 'alloy' | 'hubcap' | 'spoked' | 'white';
  rimColor: number;
  oddWheel: number;
}

const TRIM_RIM: Record<RimLook['rims'], WheelStyle['rim']> = { steel: 'steel', alloy: 'alloy', hubcap: 'hubcap', spoked: 'spoke', white: 'steel' };

/**
 * Tyre width and tread for a chassis: its stock set, or what the fitted tyre looks like. `mk` 0 is the factory tyre, 1..3
 * the aftermarket grades, and -1 is no tyre at all. Grade 1 is a patched road tyre, 2 a mud-terrain, 3 a beadlock crawler.
 * `rim` is the car's own rim (its trim) for a factory tyre; `odd` puts the mismatched spare on this wheel instead.
 */
export function wheelSpec(def: VehicleDef, mk: number, brakeMk = 0, rim?: RimLook, odd = false): WheelSpec {
  const base = WHEEL_DEFAULT[def.id] ?? WHEEL_DEFAULT.buggy;
  const brake: Partial<WheelStyle> = brakeMk < 0 ? { noBrake: true } : brakeMk >= 3 ? { caliper: 0xd62a1a } : brakeMk === 2 ? { caliper: 0xe0a01a } : {};
  const own: WheelStyle = rim ? { ...base.style, rim: odd ? (rim.rims === 'steel' ? 'alloy' : 'steel') : TRIM_RIM[rim.rims], rimColor: odd ? (rim.rims === 'steel' ? 0x9a9ea2 : 0x2a2a2a) : rim.rimColor } : base.style;
  if (mk < 0) return { width: base.width, style: { ...own, ...brake, bare: true } };
  if (mk === 0) return { width: base.width, style: { ...own, ...brake } };
  const two = def.physics.wheelCount === 2;
  const heavy = def.id === 'truck' || def.id === 'rig';
  if (mk === 1) return { width: base.width * 1.05, style: { ...own, ...brake, tread: two ? 'moto' : heavy ? 'truck' : 'road', rim: two ? 'wire' : own.rim === 'wire' ? 'steel' : own.rim, patched: !two } };
  if (mk === 2) return { width: base.width * 1.12, style: { ...brake, tread: two ? 'moto' : 'knobby', lug: two ? undefined : 'mud', rim: heavy ? 'split' : 'spoke', rimColor: 0x2a2a2a } };
  return { width: base.width * 1.22, style: { ...brake, tread: two ? 'moto' : 'knobby', lug: two ? undefined : 'crawler', rim: two ? 'spoke' : 'beadlock', rimColor: 0x24262a } };
}

/** The wheel models for a whole vehicle: a tyre grade per wheel (see `wheelSpec`), the brakes behind them, the car's own rims. */
export function wheelSpecs(def: VehicleDef, tyres: number[] | undefined, brakeMk: number, rim?: RimLook): WheelSpec[] {
  const n = def.physics.wheelCount;
  return Array.from({ length: n }, (_, i) => {
    const sp = wheelSpec(def, tyres?.[i] ?? 0, brakeMk, rim, !!rim && rim.oddWheel === i);
    // A rig runs twin tyres on every axle behind the two steering ones.
    if (def.id === 'rig' && i >= 4) return { width: sp.width * 1.0, style: { ...sp.style, dual: true } };
    if (def.id === 'rig') return { width: sp.width * 0.62, style: sp.style };
    return sp;
  });
}
