import * as THREE from 'three';
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
  smoke: THREE.Object3D;
  /** Where the second seat's occupant stands (bed gun post or passenger seat), in the chassis frame. */
  gunSeat: [number, number, number];
  /** Seat occupants built on first use, so a car parked by the road does not carry two idle people. */
  lazy?: { driver?: () => Humanoid; passenger?: () => Humanoid };
  /** Ground offset (distance from the chassis origin to the ground) for lean pivoting. */
  groundY: number;
  setHeadlights(on: boolean): void;
  damageTint(frac: number): void;
  dispose(): void;
}

// ----------------------------------------------------------------------------------------- wheels

export interface WheelStyle {
  tread: 'road' | 'knobby' | 'moto';
  rim: 'wire' | 'steel' | 'spoke' | 'beadlock';
  rimColor: number;
  /** No tyre at all: the rim runs bare on the hub. */
  bare?: boolean;
  /** Brake calipers painted this colour; big drilled discs. */
  caliper?: number;
  /** The brakes are off: no disc or drum behind the rim. */
  noBrake?: boolean;
}

const wheelGeoCache = new Map<string, THREE.BufferGeometry>();

/** A wheel with its axle along X: lathed tyre with rounded shoulders, tread blocks, rim, hub and brake. */
export function wheelGeometry(radius: number, width: number, st: WheelStyle): THREE.BufferGeometry {
  const key = `${radius}:${width}:${st.tread}:${st.rim}:${st.rimColor}:${st.bare ? 'b' : ''}${st.caliper ?? ''}${st.noBrake ? 'n' : ''}`;
  const hit = wheelGeoCache.get(key);
  if (hit) return hit;
  const b = new MeshBuilder();
  b.jitter = 0.02;
  const hw = width / 2;
  const R = radius;
  const moto = st.tread === 'moto';
  const rimR = R * (st.bare ? 0.9 : moto ? 0.72 : st.rim === 'beadlock' ? 0.62 : 0.6);
  const tread = st.tread === 'knobby' || moto ? R * 0.94 : R * 0.97;
  // Tyre carcass (axle along Y in the lathe, rotated onto X).
  const prof: [number, number][] = moto
    ? [[rimR, -hw * 0.7], [R * 0.86, -hw], [tread * 0.99, -hw * 0.75], [tread, -hw * 0.35], [tread, hw * 0.35], [tread * 0.99, hw * 0.75], [R * 0.86, hw], [rimR, hw * 0.7]]
    : [[rimR, -hw * 0.82], [R * 0.82, -hw], [tread * 0.985, -hw * 0.94], [tread, -hw * 0.7], [tread, hw * 0.7], [tread * 0.985, hw * 0.94], [R * 0.82, hw], [rimR, hw * 0.82]];
  if (!st.bare) b.lathe(`tyre:${key}`, prof, 0, 0, 0, S.rubber(0x1c1c1e), 0, 0, Math.PI / 2, 28);
  const rubber = S.rubber(0x161618);
  if (st.bare) {
    // Nothing on the rim: a steel wheel, a rusted hub and the brake behind it.
  } else if (st.tread === 'knobby' || moto) {
    // Staggered knobs across the crown and on the shoulders.
    const n = Math.round((Math.PI * 2 * R) / (moto ? 0.045 : 0.07));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const cy = Math.sin(a);
      const cz = Math.cos(a);
      const stag = i % 2 ? 1 : -1;
      const kr = tread + 0.012;
      b.box(stag * hw * 0.32, cy * kr, cz * kr, width * (moto ? 0.4 : 0.34), moto ? 0.018 : 0.024, R * (moto ? 0.07 : 0.1), rubber, Math.PI / 2 - a, 0, 0);
      if (!moto) b.box(-stag * hw * 0.82, cy * (tread - 0.004), cz * (tread - 0.004), width * 0.2, 0.022, R * 0.11, rubber, Math.PI / 2 - a, 0, 0);
    }
  } else {
    // Road tyre: two circumferential grooves and sipes.
    const n = Math.round((Math.PI * 2 * R) / 0.05);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      b.box(0, Math.sin(a) * (tread + 0.003), Math.cos(a) * (tread + 0.003), width * 0.9, 0.008, 0.012, rubber, Math.PI / 2 - a, 0, 0);
    }
  }
  // Rim: barrel and face.
  const rimS = st.rim === 'wire' ? S.chrome(0xb8bcc0) : S.paint(st.rimColor, 0.5);
  b.lathe(`rim:${key}`, [[rimR * 0.98, -hw * 0.78], [rimR, -hw * 0.7], [rimR * 0.96, -hw * 0.6], [rimR * 0.94, hw * 0.6], [rimR, hw * 0.7], [rimR * 0.98, hw * 0.78]], 0, 0, 0, rimS, 0, 0, Math.PI / 2, 24);
  const face = hw * (moto ? 0 : 0.25);
  if (st.rim === 'wire') {
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
          b.add('sphere', face + 0.05, Math.sin(a) * rimR * 0.97, Math.cos(a) * rimR * 0.97, 0.025, 0.025, 0.025, S.steel());
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

/** Headlight: chrome bucket in the body builder plus a glowing lens mesh registered for switching. */
export function headlamp(v: VehicleVisual, b: MeshBuilder, x: number, y: number, z: number, r: number, bucket = true) {
  if (bucket) {
    b.frustum(x, y, z - r * 0.45, r * 1.12, r * 0.7, r * 0.9, S.chrome(0xc8ccd0), Math.PI / 2, 0, 0, 16);
    b.torus(x, y, z + 0.0, r * 1.08, r * 0.1, S.chrome(), 0, 0, 0, 6, 20);
  }
  const m = new THREE.Mesh(lensGeo, lightOffMat);
  m.position.set(x, y, z);
  m.scale.set(r * 2, r * 2, r * 0.9);
  v.inner.add(m);
  v.headlights.push(m);
}

export function taillight(v: VehicleVisual, x: number, y: number, z: number, w = 0.12, h = 0.07, amber = false) {
  const m = new THREE.Mesh(tailGeo, amber ? amberMat : brakeMat);
  m.position.set(x, y, z);
  m.scale.set(w, h, 0.03);
  v.inner.add(m);
}

export function rider(color: number, helmet: number): Humanoid {
  return new Humanoid({ jacket: color, trim: 0x4a4636, helmet, scarf: new THREE.Color(color).multiplyScalar(0.45).getHex() });
}


/** A rig that drops lamps straight onto a live visual, for models that are built per instance. */
export function liveRig(v: VehicleVisual, b: MeshBuilder): Rig {
  return {
    lamp: (x, y, z, r, bucket = true) => headlamp(v, b, x, y, z, r, bucket),
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
};

/**
 * Tyre width and tread for a chassis: its stock set, or what the fitted tyre looks like. `mk` 0 is the factory tyre, 1..3
 * the aftermarket grades, and -1 is no tyre at all.
 */
export function wheelSpec(def: VehicleDef, mk: number, brakeMk = 0): WheelSpec {
  const base = WHEEL_DEFAULT[def.id] ?? WHEEL_DEFAULT.buggy;
  const brake: Partial<WheelStyle> = brakeMk < 0 ? { noBrake: true } : brakeMk >= 3 ? { caliper: 0xd62a1a } : brakeMk === 2 ? { caliper: 0xe0a01a } : {};
  if (mk < 0) return { width: base.width, style: { ...base.style, ...brake, bare: true } };
  if (mk === 0) return { width: base.width, style: { ...base.style, ...brake } };
  const two = def.physics.wheelCount === 2;
  if (mk === 1) return { width: base.width * 1.05, style: { ...base.style, ...brake, tread: two ? 'moto' : 'road', rim: two ? 'wire' : 'steel' } };
  if (mk === 2) return { width: base.width * 1.12, style: { ...brake, tread: two ? 'moto' : 'knobby', rim: 'spoke', rimColor: 0x2a2a2a } };
  return { width: base.width * 1.22, style: { ...brake, tread: two ? 'moto' : 'knobby', rim: two ? 'spoke' : 'beadlock', rimColor: 0x24262a } };
}

/** The wheel models for a whole vehicle: a tyre grade per wheel (see `wheelSpec`) and the brakes behind them. */
export function wheelSpecs(def: VehicleDef, tyres: number[] | undefined, brakeMk: number): WheelSpec[] {
  const n = def.physics.wheelCount;
  return Array.from({ length: n }, (_, i) => wheelSpec(def, tyres?.[i] ?? 0, brakeMk));
}
