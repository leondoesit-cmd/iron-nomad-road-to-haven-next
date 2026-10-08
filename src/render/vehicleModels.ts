import * as THREE from 'three';
import { MeshBuilder, S } from './builder';
import { C } from './palette';
import { Humanoid } from './humanoid';
import type { VehicleDef } from '../data';
import type { VehicleBuild } from '../sim/garage';
import type { Fit, PartItem } from '../sim/parts';
import { partDef } from '../data';
import { bedroll, crate, exhaust, heavyGun, jerryCan, plate, rivets, shock, signPlate, spareTyre, strap } from './parts';
import { addKit, panelOff, type CoolingLook, type EngineLook, type KitLook, type Mounts } from './attachments';
import { PANEL_TAG, partMeta, partTag } from './bodyParts';
import { attachBay } from './bayMesh';
import { bayFit, engineDef, hoodState, radiatorDef } from '../sim/engines';
import { defOf } from '../sim/garage';
import { paintPanels } from './paintJob';
import type { PanelPaint } from '../sim/paint';
import { addWheels, addWheelSet, blank, bodyMat, finish, headlamp, liveRig, rider, taillight, wheelSpec, wheelSpecs, type VehicleVisual } from './vehicleKit';
import { buildCar, carMounts, prepareCarShell } from './carModels';
import { attachCabin } from './interior';
import { TRIKE_MOUNTS, buildTrike } from './trikeModel';
import { buildHeavy, heavyMounts, isHeavy, prepareHeavyShell } from './truckModels';
import { rollTrim, type CarTrim } from '../sim/carTrim';
import { rideLiftOf } from './rideHeight';

export type { VehicleVisual, WheelVisual } from './vehicleKit';

/** What sets one vehicle apart from another of the same chassis: paint, stripes, fitted parts and how beaten up it is. */
export interface VehicleLook {
  paint: number;
  stripe: number;
  stripeColor: number;
  seed: number;
  fit: Fit;
  /** 0..1: grime and rust. */
  wear: number;
  engine?: EngineLook;
  cooling?: CoolingLook;
  /** Panels sprayed another colour. */
  panels?: PanelPaint;
  /** The tyre on each wheel: its grade 1..3, 0 for the factory tyre, -1 for none. */
  tyres?: number[];
  /** Brake grade: 0 factory, 2 and 3 big discs with painted calipers, -1 stripped. */
  brakeMk?: number;
  /** The body variant and details the car's seed rolls (found cars and the heavy chassis; see sim/carTrim.ts). */
  trim?: CarTrim | null;
  /** A burnt-out wreck: it has lost a wing or a quarter panel as well as its paint. */
  hulk?: boolean;
  /** How far the springs fitted stand the body up (+) or drop it (-) over its wheels, metres (see `rideHeight.ts`). */
  lift?: number;
}

/** What the engine and radiator look like from outside, for a build. */
function powertrainLook(b: VehicleBuild): { engine?: EngineLook; cooling?: CoolingLook } {
  const def = defOf(b);
  const e = engineDef(def, b.fit);
  const r = radiatorDef(def, b.fit);
  if (!e?.engine) return {};
  const hood = hoodState(b.fit);
  const bay = bayFit(def, e.engine, hood);
  // Condition in thirds, so cars with engines of about the same state share one cached bay mesh.
  const wear = Math.round((1 - Math.max(0, Math.min(1, b.comp.engine))) * 3) / 3;
  return {
    engine: { id: e.id, mk: e.stock ? 0 : e.mk, swapped: e.id !== def.stockEngine, blown: !!e.engine.blown, diesel: e.engine.fuel === 'diesel', oversize: bay.oversize, size: e.engine.size, empty: !!e.empty, wear, hood },
    cooling: r ? { mk: r.stock ? 0 : r.mk, kw: r.cooling ?? 0, empty: !!r.empty } : undefined,
  };
}

/** A tyre as the wheel model sees it: grade 1..3, 0 for a factory one, -1 for a bare rim. */
const tyreGrade = (t: PartItem | null | undefined): number => {
  if (!t) return 0;
  const d = partDef(t.id);
  return d.empty ? -1 : d.stock ? 0 : d.mk;
};
const brakeGrade = (def: VehicleDef, fit: Fit): number => {
  const d = fit.brakes ? partDef(fit.brakes.id) : null;
  return !d ? 0 : d.empty ? -1 : d.stock ? 0 : d.mk;
};

export function lookOf(b: VehicleBuild): VehicleLook {
  const def = defOf(b);
  const tyres = b.tyres.map(tyreGrade);
  return {
    paint: b.paint,
    stripe: b.stripe,
    stripeColor: b.stripeColor,
    seed: b.seed,
    fit: b.fit,
    wear: Math.min(0.95, 0.4 + (1 - b.hp) * 0.5),
    panels: b.panels,
    tyres: tyres.some((t) => t !== 0) ? tyres : undefined,
    brakeMk: brakeGrade(def, b.fit),
    trim: rollTrim(b.chassis, b.seed),
    // A rolled hulk is left at 5% with its tank and fuel mounts burnt out; a convoy wreck keeps its tank and is only charred.
    hulk: b.hp <= 0.06 && b.comp.tank <= 0.01,
    lift: rideLiftOf(b.fit),
    ...powertrainLook(b),
  };
}
export function defaultLook(color: number): VehicleLook {
  return { paint: color, stripe: 0, stripeColor: 0xe9dfc7, seed: 1, fit: {}, wear: 0.55 };
}
export const kitLook = (l: VehicleLook): KitLook => l;
export const mkOf = (fit: Fit, slot: keyof Fit): number => (fit[slot] ? partDef(fit[slot]!.id).mk : 0);

// Where parts attach on each of the tier chassis, in each model's own frame.
const MOPED_MOUNTS: Mounts = { hw: 0.12, front: { z: 0.78, y: 0.1, hw: 0.1 }, rear: { z: -1.08, y: 0.12, hw: 0.2 }, side: { y0: -0.25, y1: 0.1, z0: -0.5, z1: 0.3 }, sill: -0.26, narrow: true, wheelR: 0.33 };
const QUAD_MOUNTS: Mounts = {
  hw: 0.5,
  front: { z: 1.02, y: -0.04, hw: 0.45 },
  rear: { z: -1.1, y: 0.2, hw: 0.34 },
  side: { y0: -0.24, y1: 0.1, z0: -0.5, z1: 0.6 },
  sill: -0.28,
  gun: { x: 0, y: 0.42, z: 0.72 },
  narrow: true,
  wheelR: 0.36,
};
const BUGGY_MOUNTS: Mounts = {
  hw: 0.76,
  front: { z: 1.95, y: 0.0, hw: 0.82 },
  rear: { z: -2.08, y: 0.1, hw: 0.76 },
  hood: { y: 0.3, z0: 0.55, z1: 1.7, hw: 0.65 },
  roof: { y: 1.42, z0: -0.62, z1: 0.2, hw: 0.7 },
  trunk: { y: 0.02, z0: -2.0, z1: -0.8, hw: 0.7 },
  side: { y0: -0.12, y1: 0.5, z0: -0.5, z1: 0.5 },
  sill: -0.2,
  wheelR: 0.42,
  // The engine sits down between the ladder frame rails, below the floor plate.
  bayFloor: -0.34,
};

// ----------------------------------------------------------------------------------------- tier 1

/** 50cc scrap moped: step-through frame, leg shield, crate and jerry can on the rack, laced wheels. */
export function buildMoped(def: VehicleDef, wheelLocal: [number, number, number][], steered: boolean[], look: VehicleLook): VehicleVisual {
  const color = look.paint;
  const v = blank(def);
  const b = new MeshBuilder();
  b.jitter = 0.03;
  b.roundSeg = 2;
  b.seed(11);
  const paint = S.paint(color, 0.7);
  const faded = S.paint(new THREE.Color(color).lerp(new THREE.Color(0x8a7a66), 0.35).getHex(), 0.9);
  const frame = S.paint(0x3a3a38, 0.8);
  const wy = wheelLocal[0][1] - def.physics.suspension.rest;
  const fz = wheelLocal[0][2];
  const rz = wheelLocal[1][2];
  // Spine: steering head down to the floor, back under the seat.
  b.pipe([[0, 0.32, 0.56], [0, 0.0, 0.42], [0, -0.22, 0.28], [0, -0.26, -0.2], [0, -0.1, -0.42], [0, 0.04, -0.72]], 0.032, frame, 10);
  b.cyl(0, 0.3, 0.57, 0.085, 0.2, 0.085, frame, -0.35, 0, 0, 14);
  // Leg shield: a curved pressed panel in the player's colour.
  b.extrude('mopedShield', () => {
    const s = new THREE.Shape();
    s.moveTo(-0.2, -0.2);
    s.quadraticCurveTo(-0.27, 0.1, -0.15, 0.36);
    s.lineTo(0.15, 0.36);
    s.quadraticCurveTo(0.27, 0.1, 0.2, -0.2);
    s.closePath();
    return s;
  }, 0.03, 0.012, 0, 0.02, 0.47, paint, -0.3, 0, 0);
  b.rbox(0, -0.27, 0.06, 0.3, 0.035, 0.5, 0.012, S.rubber(0x262626));
  for (let i = 0; i < 6; i++) b.box(0, -0.25, -0.15 + i * 0.08, 0.26, 0.01, 0.025, S.rubber(0x1a1a1a));
  // Rear body shell over the engine, scuffed.
  b.rbox(0, -0.02, -0.56, 0.34, 0.28, 0.66, 0.1, faded);
  b.rbox(0, -0.06, -0.92, 0.22, 0.16, 0.16, 0.06, faded);
  // Engine and CVT case below the shell.
  b.rbox(0.08, -0.25, -0.5, 0.14, 0.18, 0.42, 0.04, S.metal(0x9a9890, 0.6));
  for (let i = 0; i < 5; i++) b.box(-0.06, -0.2 + i * 0.03, -0.42, 0.12, 0.012, 0.14, S.metal(0x6e6c68, 0.7));
  exhaust(b, [[-0.08, -0.28, -0.38], [-0.12, -0.34, -0.5], [-0.15, -0.3, -0.75], [-0.15, -0.22, -0.98]], 0.022, 0.05);
  // Seat: cracked vinyl patched with tape.
  b.rbox(0, 0.15, -0.5, 0.3, 0.1, 0.62, 0.045, S.leather(0x262321, 0.5));
  b.box(0.06, 0.2, -0.38, 0.12, 0.012, 0.14, S.cloth(0x8c8c88, 0.3), 0, 0.4, 0);
  // Fork, fender and headset.
  for (const sx of [1, -1]) {
    b.rod(sx * 0.07, 0.22, 0.6, sx * 0.07, wy + 0.06, fz - 0.02, 0.022, S.metal(0x2a2a2a, 0.4), 10);
    b.rod(sx * 0.07, wy + 0.2, fz - 0.06, sx * 0.07, wy + 0.02, fz - 0.01, 0.027, S.chrome(), 10);
  }
  b.extrude('mopedFender', () => {
    const s = new THREE.Shape();
    s.absarc(0, 0, 0.37, 0.15, Math.PI - 0.6, false);
    s.absarc(0, 0, 0.35, Math.PI - 0.6, 0.15, true);
    s.closePath();
    return s;
  }, 0.13, 0.008, 0, wy, fz, paint, 0, Math.PI / 2, 0);
  b.extrude('mopedRearFender', () => {
    const s = new THREE.Shape();
    s.absarc(0, 0, 0.37, Math.PI * 0.45, Math.PI * 0.95, false);
    s.absarc(0, 0, 0.35, Math.PI * 0.95, Math.PI * 0.45, true);
    s.closePath();
    return s;
  }, 0.12, 0.008, 0, wy, rz, faded, 0, Math.PI / 2, 0);
  // Handlebar with grips, levers, mirrors (one snapped off), speedo.
  b.pipe([[0.36, 0.5, 0.6], [0.2, 0.47, 0.64], [0, 0.45, 0.64], [-0.2, 0.47, 0.64], [-0.36, 0.5, 0.6]], 0.014, S.chrome(), 8);
  for (const sx of [1, -1]) {
    b.capsule(sx * 0.3, 0.495, 0.61, sx * 0.4, 0.505, 0.59, 0.02, S.rubber(0x202020));
    b.rod(sx * 0.25, 0.5, 0.63, sx * 0.34, 0.49, 0.67, 0.006, S.metal(0x9a9a9a), 6);
  }
  b.rod(0.22, 0.5, 0.62, 0.3, 0.72, 0.6, 0.007, S.chrome(), 6);
  b.cyl(0.3, 0.74, 0.6, 0.09, 0.02, 0.06, S.chrome(), Math.PI / 2, 0, 0.3, 14);
  b.rod(-0.22, 0.5, 0.62, -0.25, 0.58, 0.61, 0.007, S.chrome(), 6);
  b.cyl(0, 0.5, 0.6, 0.11, 0.06, 0.11, S.plastic(0x1e1e1e), -0.6, 0, 0, 16);
  // Headlight nacelle.
  b.rbox(0, 0.38, 0.66, 0.2, 0.15, 0.14, 0.05, paint);
  headlamp(v, b, 0, 0.38, 0.735, 0.065, false);
  // Rear rack with a crate, a jerry can and a bedroll.
  b.pipe([[0.15, 0.13, -0.66], [0.15, 0.14, -1.06], [-0.15, 0.14, -1.06], [-0.15, 0.13, -0.66]], 0.012, frame, 6);
  for (let i = 0; i < 4; i++) b.rod(0.15, 0.14, -0.72 - i * 0.1, -0.15, 0.14, -0.72 - i * 0.1, 0.009, frame, 6);
  b.mark(partTag('crate'), partMeta({ kind: 'crate', pivot: [-0.06, 0.15, -0.9] }));
  crate(b, -0.06, 0.29, -0.9, 0.28, 0.28, 0.28, 0.08);
  b.end();
  jerryCan(b, 0.15, 0.15, -0.78, color, Math.PI / 2, false);
  bedroll(b, 0, 0.47, -0.88, 0.42, 0.07, 0x5b5a3e);
  strap(b, [[-0.21, 0.15, -0.9], [-0.21, 0.44, -0.9], [0.09, 0.44, -0.9], [0.09, 0.15, -0.9]]);
  // Plate and stand.
  b.box(0, 0.02, -1.08, 0.18, 0.1, 0.01, S.paint(0xc8b882, 0.95), -0.25, 0, 0);
  b.rod(-0.12, -0.3, -0.25, -0.2, -0.6, -0.32, 0.012, frame, 6);
  taillight(v, 0, 0.07, -1.05, 0.1, 0.05);
  taillight(v, 0.1, 0.02, -1.0, 0.04, 0.03, true);
  taillight(v, -0.1, 0.02, -1.0, 0.04, 0.03, true);
  addKit(b, liveRig(v, b), MOPED_MOUNTS, kitLook(look), { nativeGun: false });
  paintPanels(b, look.paint, look.panels, MOPED_MOUNTS);
  const bodyGeo = b.build();
  addWheelSet(v, def, wheelLocal, steered, wheelSpecs(def, look.tyres, look.brakeMk ?? 0));
  const r = rider(color, color);
  r.root.position.set(0, -0.28, -0.32);
  v.inner.add(r.root);
  v.driver = r;
  v.muzzle.position.set(0, 0.5, 0.9);
  v.inner.add(v.muzzle);
  v.smoke.position.set(-0.15, -0.22, -1.0);
  v.inner.add(v.smoke);
  return finish(v, bodyGeo);
}

// ----------------------------------------------------------------------------------------- tier 2

/** Armoured quad: tube frame, plastic fenders, coil-overs, road-sign side armour and a fixed LMG. */
export function buildQuad(def: VehicleDef, wheelLocal: [number, number, number][], steered: boolean[], look: VehicleLook): VehicleVisual {
  const color = look.paint;
  const v = blank(def);
  const b = new MeshBuilder();
  b.jitter = 0.03;
  b.roundSeg = 2;
  b.seed(22);
  const paint = S.paint(color, 0.65);
  const frame = S.paint(0x2e3032, 0.7);
  const wy = wheelLocal[0][1] - def.physics.suspension.rest;
  const wx = Math.abs(wheelLocal[0][0]);
  // Tube frame cradle.
  for (const sx of [1, -1]) {
    b.pipe([[sx * 0.22, -0.28, 0.75], [sx * 0.24, -0.28, -0.7], [sx * 0.2, 0.05, -0.82], [sx * 0.18, 0.12, -0.2], [sx * 0.2, 0.08, 0.55], [sx * 0.22, -0.28, 0.75]], 0.025, frame, 8);
    // A-arms and coil-overs to each wheel.
    for (const wz of [wheelLocal[0][2], wheelLocal[2]?.[2] ?? -0.75]) {
      b.rod(sx * 0.2, -0.24, wz + 0.12, sx * (wx - 0.08), wy, wz, 0.018, frame, 8);
      b.rod(sx * 0.2, -0.24, wz - 0.12, sx * (wx - 0.08), wy, wz, 0.018, frame, 8);
      shock(b, [sx * (wx - 0.12), wy + 0.04, wz], [sx * 0.22, 0.12, wz + (wz > 0 ? -0.08 : 0.08)], 0xd8a21a, 0.04);
    }
  }
  // Engine block and skid plate.
  b.rbox(0, -0.18, 0.02, 0.36, 0.3, 0.5, 0.05, S.metal(0x75736e, 0.65));
  for (let i = 0; i < 5; i++) b.box(0, -0.06 + i * 0.03, 0.12, 0.38, 0.012, 0.2, S.metal(0x55524d, 0.7));
  plate(b, 0, -0.34, 0.1, 0.5, 1.1, 0.02, S.steel(0x4a4c4e, 0.8), Math.PI / 2, 0, 0, false);
  // Fenders: moulded plastic decks in the player's colour with arches over each wheel.
  b.rbox(0, 0.13, 0.6, 1.2, 0.05, 0.62, 0.025, paint);
  b.rbox(0, 0.14, -0.66, 1.22, 0.05, 0.7, 0.025, paint);
  for (const sx of [1, -1]) {
    for (const wz of [wheelLocal[0][2], wheelLocal[2]?.[2] ?? -0.75]) {
      b.extrude('quadArch', () => {
        const s = new THREE.Shape();
        s.absarc(0, 0, 0.47, 0.25, Math.PI - 0.25, false);
        s.absarc(0, 0, 0.43, Math.PI - 0.25, 0.25, true);
        s.closePath();
        return s;
      }, 0.3, 0.012, sx * wx, wy, wz, paint, 0, Math.PI / 2, 0);
    }
  }
  // Tank, seat and bars.
  b.rbox(0, 0.22, 0.25, 0.34, 0.2, 0.36, 0.08, paint);
  b.cyl(0.06, 0.33, 0.3, 0.07, 0.03, 0.07, S.chrome(), 0, 0, 0, 12);
  b.rbox(0, 0.24, -0.22, 0.34, 0.12, 0.6, 0.05, S.leather(0x1e1d1c, 0.45));
  b.pipe([[0.42, 0.55, 0.38], [0.24, 0.5, 0.42], [0, 0.48, 0.42], [-0.24, 0.5, 0.42], [-0.42, 0.55, 0.38]], 0.015, S.metal(0x2a2a2a), 8);
  b.rod(0, 0.48, 0.42, 0, 0.26, 0.4, 0.022, S.metal(0x2a2a2a), 10);
  for (const sx of [1, -1]) {
    b.capsule(sx * 0.36, 0.545, 0.39, sx * 0.47, 0.56, 0.37, 0.022, S.rubber(0x1c1c1c));
    // Hand guards.
    b.extrude('quadGuard', () => {
      const s = new THREE.Shape();
      s.moveTo(0, 0);
      s.quadraticCurveTo(0.14, 0.02, 0.16, -0.08);
      s.lineTo(0.12, -0.09);
      s.quadraticCurveTo(0.1, -0.02, 0, -0.03);
      s.closePath();
      return s;
    }, 0.12, 0.006, sx * 0.43, 0.58, 0.42, S.plastic(0x1c1c1c), 0, sx > 0 ? Math.PI : 0, 0);
  }
  // Front bumper / ram and twin lamps.
  b.pipe([[0.48, -0.2, 0.92], [0.48, 0.1, 1.0], [-0.48, 0.1, 1.0], [-0.48, -0.2, 0.92]], 0.03, S.steel(0x3c3e40), 8);
  plate(b, 0, -0.04, 1.02, 0.86, 0.26, 0.025, S.steel(0x5a5e60, 0.75), 0, 0, 0);
  b.box(0, 0.09, 1.04, 0.8, 0.04, 0.02, paint);
  b.rbox(0.25, 0.2, 0.86, 0.14, 0.12, 0.08, 0.03, S.plastic(0x1c1c1c));
  b.rbox(-0.25, 0.2, 0.86, 0.14, 0.12, 0.08, 0.03, S.plastic(0x1c1c1c));
  headlamp(v, b, 0.25, 0.2, 0.905, 0.05, false);
  headlamp(v, b, -0.25, 0.2, 0.905, 0.05, false);
  // Road-sign side plates as improvised armour.
  b.mark(partTag('sign', 1), partMeta({ kind: 'sign', side: 1, pivot: [0.45, 0.04, 0.1] }));
  signPlate(b, 0.5, 0.04, 0.1, 0.62, 0.3, C.signYellow, 0, Math.PI / 2, 0.04);
  b.end();
  b.mark(partTag('sign', -1), partMeta({ kind: 'sign', side: -1, pivot: [-0.45, 0.04, 0.1] }));
  signPlate(b, -0.5, 0.04, 0.1, 0.62, 0.3, C.signYellow, 0, -Math.PI / 2, -0.04);
  b.end();
  // The fixed LMG on the front rack is drawn by the weapon kit, so a better mount changes how it looks.
  b.pipe([[0.3, 0.16, 0.66], [0.3, 0.2, 0.92], [-0.3, 0.2, 0.92], [-0.3, 0.16, 0.66]], 0.014, frame, 6);
  // Rear rack loaded with salvage.
  b.pipe([[0.32, 0.25, -0.62], [0.34, 0.27, -1.08], [-0.34, 0.27, -1.08], [-0.32, 0.25, -0.62]], 0.016, frame, 6);
  b.mark(partTag('crate'), partMeta({ kind: 'crate', pivot: [-0.15, 0.28, -0.86] }));
  crate(b, -0.15, 0.43, -0.86, 0.32, 0.3, 0.32, 0.1);
  b.end();
  jerryCan(b, 0.2, 0.28, -0.8, color, Math.PI / 2);
  jerryCan(b, 0.2, 0.28, -1.0, 0x5a6442, Math.PI / 2);
  b.mark(partTag('spare'), partMeta({ kind: 'spare', pivot: [0, 0.4, -0.9] }));
  spareTyre(b, 0, 0.66, -0.9, 0.24, 0.12, 0, 0.3);
  b.end();
  strap(b, [[-0.33, 0.27, -0.86], [-0.33, 0.6, -0.86], [0.33, 0.6, -0.86], [0.33, 0.27, -0.86]]);
  exhaust(b, [[0.1, -0.15, -0.2], [0.18, -0.12, -0.6], [0.24, 0.1, -0.9], [0.24, 0.12, -1.1]], 0.025, 0.055);
  taillight(v, 0.2, 0.18, -1.1);
  taillight(v, -0.2, 0.18, -1.1);
  addKit(b, liveRig(v, b), QUAD_MOUNTS, kitLook(look), { nativeGun: true });
  paintPanels(b, look.paint, look.panels, QUAD_MOUNTS);
  const bodyGeo = b.build();
  addWheelSet(v, def, wheelLocal, steered, wheelSpecs(def, look.tyres, look.brakeMk ?? 0));
  const r = rider(color, color);
  r.root.position.set(0, -0.15, -0.12);
  v.inner.add(r.root);
  v.driver = r;
  v.smoke.position.set(0.24, 0.12, -1.1);
  v.inner.add(v.smoke);
  return finish(v, bodyGeo);
}

// ----------------------------------------------------------------------------------------- tier 3

/** Technical buggy: long hood, open cab under a roll cage, sign-plate doors, a bed with a pintle MG. */
export function buildBuggy(def: VehicleDef, wheelLocal: [number, number, number][], steered: boolean[], look: VehicleLook): VehicleVisual {
  const color = look.paint;
  const v = blank(def);
  const b = new MeshBuilder();
  b.jitter = 0.03;
  b.roundSeg = 2;
  b.seed(33);
  const paint = S.paint(color, 0.45);
  // Body panels in a sun-faded version of the player's colour; a couple of replaced panels stay bare rust.
  const body = S.paint(new THREE.Color(color).lerp(new THREE.Color(0x6c5a44), 0.35).getHex(), 0.6);
  const rust = S.rust(C.rust);
  const steel = S.steel(0x4a4d50, 0.7);
  const cage = S.paint(0x2a2c2e, 0.6);
  const wy = wheelLocal[0][1] - def.physics.suspension.rest;
  const wx = Math.abs(wheelLocal[0][0]);
  const fz = wheelLocal[0][2];
  const rz = wheelLocal[2][2];
  // Ladder frame and floor.
  for (const sx of [1, -1]) b.rbox(sx * 0.45, -0.3, 0, 0.1, 0.14, 3.5, 0.02, steel);
  b.box(0, -0.2, -0.1, 1.5, 0.06, 2.9, S.steel(0x3a3c3e, 0.8));
  // Suspension: coil-overs and arms at every corner.
  for (const sx of [1, -1]) {
    for (const wz of [fz, rz]) {
      b.rod(sx * 0.45, -0.28, wz + 0.2, sx * (wx - 0.12), wy, wz, 0.03, steel, 8);
      b.rod(sx * 0.45, -0.28, wz - 0.2, sx * (wx - 0.12), wy, wz, 0.03, steel, 8);
      shock(b, [sx * (wx - 0.15), wy + 0.05, wz], [sx * 0.5, 0.25, wz + (wz > 0 ? -0.12 : 0.12)], 0xc9471f, 0.06);
    }
  }
  // Hood and nose. With the bonnet off it is a bare frame round the engine (drawn by the kit).
  // The nose is a hollow frame (two wing walls, the grille panel and the firewall), not a solid block, so the engine has a real bay.
  for (const sx of [1, -1]) b.rbox(sx * 0.7, 0.05, 1.12, 0.06, 0.42, 1.25, 0.02, body);
  b.rbox(0, 0.05, 1.7, 1.4, 0.4, 0.06, 0.02, body);
  b.rbox(0, 0.1, 0.52, 1.4, 0.5, 0.05, 0.02, S.steel(0x2a2c2e, 0.8));
  if (!panelOff(look.fit, 'hood')) {
    // The bonnet plate hinges at the cowl and swings up.
    b.mark(PANEL_TAG.hood, partMeta({ kind: 'hood', pivot: [0, 0.27, 0.45] }));
    b.rbox(0, 0.27, 1.1, 1.3, 0.04, 1.1, 0.02, paint);
    b.rbox(0, 0.29, 1.15, 0.5, 0.08, 0.5, 0.03, S.metal(0x2a2a2a, 0.6));
    for (let i = 0; i < 5; i++) b.box(0, 0.335, 0.96 + i * 0.09, 0.4, 0.015, 0.03, S.metal(0x1a1a1a, 0.5));
    b.end();
  }
  // Grille, bull bar and ram spikes.
  b.rbox(0, 0.02, 1.76, 1.2, 0.34, 0.06, 0.02, S.metal(0x1f2022, 0.5));
  for (let i = 0; i < 9; i++) b.box(-0.48 + i * 0.12, 0.02, 1.8, 0.03, 0.3, 0.03, S.chrome(0x9da2a6));
  b.mark(partTag('bullbar'), partMeta({ kind: 'bullbar', pivot: [0, 0.0, 1.8] }));
  b.pipe([[0.82, -0.3, 1.86], [0.82, 0.32, 1.92], [-0.82, 0.32, 1.92], [-0.82, -0.3, 1.86]], 0.045, steel, 10);
  b.pipe([[0.82, 0.02, 1.9], [-0.82, 0.02, 1.9]], 0.04, steel, 10);
  plate(b, 0, -0.18, 1.95, 1.7, 0.3, 0.03, S.steel(0x5c6064, 0.85), -0.15, 0, 0);
  b.end();
  for (let i = 0; i < 5; i++) b.add('cone12', -0.6 + i * 0.3, -0.18, 2.12, 0.08, 0.26, 0.08, S.steel(0x7a7e82, 0.6), Math.PI / 2, 0, 0);
  // Headlights in buckets on the bull bar, plus a roof light bar.
  headlamp(v, b, 0.56, 0.28, 1.97, 0.1);
  headlamp(v, b, -0.56, 0.28, 1.97, 0.1);
  // Fenders flared over the wheels.
  for (const sx of [1, -1]) {
    for (const wz of [fz, rz]) {
      b.extrude('buggyFlare', () => {
        const s = new THREE.Shape();
        s.absarc(0, 0, 0.62, 0.1, Math.PI - 0.1, false);
        s.absarc(0, 0, 0.55, Math.PI - 0.1, 0.1, true);
        s.closePath();
        return s;
      }, 0.42, 0.015, sx * (wx - 0.02), wy, wz, sx > 0 ? body : rust, 0, Math.PI / 2, 0);
    }
  }
  // Cab: windscreen frame with a cracked screen, dash, seats, wheel.
  b.pipe([[0.7, 0.32, 0.52], [0.66, 0.92, 0.32], [-0.66, 0.92, 0.32], [-0.7, 0.32, 0.52]], 0.035, cage, 10);
  // Windscreen: a welded bar guard in an open frame. (The glass that used to be painted in here was an opaque dark slab that filled
  // the driver's first-person view; the frame and bars are all that stand between the eyes and the road.)
  for (let i = 0; i < 8; i++) {
    const x = -0.56 + i * 0.16;
    b.rod(x, 0.39, 0.55, x, 0.87, 0.38, 0.011, S.steel(0x2e3032, 0.8), 6);
  }
  b.rod(-0.62, 0.62, 0.48, 0.62, 0.62, 0.48, 0.012, S.steel(0x2e3032, 0.8), 6);
  // The driver's seat, wheel and dash are parts (see `interior.ts`); the seat on the other side is just bolted in.
  b.rbox(-0.38, 0.08, -0.1, 0.5, 0.14, 0.52, 0.06, S.leather(0x2a2522, 0.5));
  b.rbox(-0.38, 0.45, -0.37, 0.5, 0.62, 0.12, 0.06, S.leather(0x2a2522, 0.5), -0.12, 0, 0);
  for (const dx of [0.12, -0.12]) b.box(-0.38 + dx, 0.45, -0.3, 0.05, 0.6, 0.01, S.cloth(0x8a1c1c, 0.4), -0.12, 0, 0);
  // Roll cage over the cab.
  for (const sx of [1, -1]) {
    b.pipe([[sx * 0.72, -0.15, 0.48], [sx * 0.7, 1.32, 0.18], [sx * 0.7, 1.36, -0.5], [sx * 0.72, -0.15, -0.68]], 0.042, cage, 10);
    b.rod(sx * 0.72, 0.62, 0.36, sx * 0.72, 0.62, -0.62, 0.03, cage, 8);
  }
  b.pipe([[0.7, 1.32, 0.18], [-0.7, 1.32, 0.18]], 0.042, cage, 10);
  b.pipe([[0.7, 1.36, -0.5], [-0.7, 1.36, -0.5]], 0.042, cage, 10);
  b.rod(0.7, 1.34, -0.16, -0.7, 1.34, -0.16, 0.03, cage, 8);
  // Corrugated roof plate in rust.
  for (let i = 0; i < 7; i++) b.cyl(-0.6 + i * 0.2, 1.4, -0.16, 0.12, 0.66, 0.12, rust, Math.PI / 2, 0, 0, 8);
  // Roof light bar.
  b.mark(partTag('lightbar'), partMeta({ kind: 'lightbar', pivot: [0, 1.42, 0.12] }));
  b.rbox(0, 1.47, 0.12, 0.9, 0.1, 0.12, 0.03, S.plastic(0x1a1a1a));
  b.end();
  headlamp(v, b, 0.3, 1.47, 0.19, 0.04, false);
  headlamp(v, b, -0.3, 1.47, 0.19, 0.04, false);
  // Doors: road signs welded in place.
  b.mark(partTag('door', 1), partMeta({ kind: 'door', side: 1, pivot: [0.77, 0.2, 0.54] }));
  signPlate(b, 0.77, 0.2, 0.05, 0.98, 0.5, C.signYellow, 0, Math.PI / 2, 0);
  b.end();
  b.mark(partTag('door', -1), partMeta({ kind: 'door', side: -1, pivot: [-0.77, 0.2, 0.54] }));
  signPlate(b, -0.77, 0.2, 0.05, 0.98, 0.5, 0xc2402e, 0, -Math.PI / 2, 0);
  b.end();
  // Bed: floor at y = 0 so the gunner stands on it.
  b.box(0, -0.06, -1.3, 1.5, 0.1, 1.5, S.steel(0x5a5a56, 0.8));
  for (let i = 0; i < 6; i++) b.box(-0.6 + i * 0.24, 0.0, -1.3, 0.05, 0.03, 1.46, S.steel(0x444442, 0.8));
  for (const sx of [1, -1]) {
    b.rbox(sx * 0.75, 0.22, -1.3, 0.06, 0.5, 1.5, 0.015, sx > 0 ? body : paint);
    rivets(b, [sx * 0.785, 0.42, -0.62], [sx * 0.785, 0.42, -1.98], 9);
  }
  b.rbox(0, 0.22, -2.04, 1.52, 0.5, 0.06, 0.015, rust);
  b.box(0, 0.25, -2.075, 0.3, 0.14, 0.01, S.paint(0xd8c690, 0.9));
  // Gun post, cargo, spare wheel and jerry cans.
  b.cyl(0, 0.38, -0.95, 0.1, 0.8, 0.1, steel, 0, 0, 0, 12);
  b.cyl(0, 0.0, -0.95, 0.28, 0.04, 0.28, steel, 0, 0, 0, 12);
  b.mark(partTag('spare'), partMeta({ kind: 'spare', pivot: [0.38, 0.1, -1.72] }));
  spareTyre(b, 0.38, 0.3, -1.72, 0.36, 0.22, Math.PI / 2, 0);
  b.end();
  jerryCan(b, -0.5, 0.0, -1.5, color, 0);
  jerryCan(b, -0.5, 0.0, -1.2, 0x55603e, 0);
  b.mark(partTag('crate'), partMeta({ kind: 'crate', pivot: [-0.05, 0.0, -1.62] }));
  crate(b, -0.05, 0.15, -1.62, 0.42, 0.3, 0.38, 0.3);
  b.end();
  strap(b, [[-0.66, 0.36, -1.38], [-0.32, 0.36, -1.38]]);
  // Exhaust stacks behind the cab.
  for (const sx of [1, -1]) exhaust(b, [[sx * 0.6, -0.1, 0.62], [sx * 0.8, 0.05, 0.4], [sx * 0.82, 0.6, 0.3], [sx * 0.82, 1.1, 0.32]], 0.04, 0.065);
  taillight(v, 0.55, 0.08, -2.08, 0.14, 0.08);
  taillight(v, -0.55, 0.08, -2.08, 0.14, 0.08);
  addKit(b, liveRig(v, b), BUGGY_MOUNTS, kitLook(look), { nativeGun: false, wheels: wheelLocal.map(([x, , z]) => [x, z] as [number, number]), bayFloor: -0.1 });
  paintPanels(b, look.paint, look.panels, BUGGY_MOUNTS);
  const bodyGeo = b.build();
  addWheelSet(v, def, wheelLocal, steered, wheelSpecs(def, look.tyres, look.brakeMk ?? 0));
  const driver = rider(color, color);
  attachCabin(v, def, look.fit, look.seed);
  v.inner.add(driver.root);
  v.driver = driver;
  // The partner rides in the bed behind the gun.
  const pass = rider(color, color);
  pass.root.position.set(0, 0.0, -1.0);
  v.passenger = pass;
  // Rotating gun pivot.
  const gun = new THREE.Group();
  gun.position.set(0, 0.85, -0.95);
  const gb = new MeshBuilder();
  heavyGun(gb, 1.2, true);
  if (mkOf(look.fit, 'weapon') >= 2) heavyGun(gb, 1.2, false);
  const gm = new THREE.Mesh(gb.build(), bodyMat);
  gm.castShadow = true;
  gun.add(gm);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, 1.22);
  gun.add(muzzle);
  v.inner.add(gun);
  v.gun = gun;
  v.muzzle = muzzle;
  v.smoke.position.set(0.82, 1.1, 0.32);
  v.inner.add(v.smoke);
  const out = finish(v, bodyGeo);
  // The engine bay under the bonnet, for when someone lifts it (the engine stands on the body block).
  attachBay(out, def.id, BUGGY_MOUNTS, look, 0.285, 0);
  return out;
}

// ----------------------------------------------------------------------------------------- raiders

/** Raider dune buggy: exposed tube frame, rear engine, red war paint, spikes and a pennant. */
export function buildRaiderBuggy(def: VehicleDef, wheelLocal: [number, number, number][], steered: boolean[]): VehicleVisual {
  const v = blank(def);
  const b = new MeshBuilder();
  b.jitter = 0.04;
  b.roundSeg = 2;
  b.seed(44);
  const red = S.paint(C.raiderRed, 0.8);
  const black = S.paint(0x1a1a1a, 0.6);
  const tube = S.paint(0x3a2a22, 0.8);
  const wy = wheelLocal[0][1] - def.physics.suspension.rest;
  const wx = Math.abs(wheelLocal[0][0]);
  const fz = wheelLocal[0][2];
  const rz = wheelLocal[2][2];
  // Pan and nose cone.
  b.box(0, -0.25, 0, 1.0, 0.06, 2.4, S.steel(0x3a3c3e, 0.8));
  b.extrude('raiderNose', () => {
    const s = new THREE.Shape();
    s.moveTo(-0.55, -0.15);
    s.lineTo(0.55, -0.15);
    s.lineTo(0.4, 0.22);
    s.lineTo(-0.4, 0.22);
    s.closePath();
    return s;
  }, 1.0, 0.03, 0, -0.05, 0.95, red, 0, 0, 0);
  b.rbox(0, 0.18, 0.95, 0.82, 0.04, 0.95, 0.015, black);
  // Skull-white teeth painted on the nose.
  for (let i = 0; i < 6; i++) b.add('cone6', -0.3 + i * 0.12, -0.02, 1.46, 0.06, 0.12, 0.02, S.paint(0xe8e2d0, 0.7), Math.PI, 0, 0);
  // Tube frame and roll cage.
  for (const sx of [1, -1]) {
    b.pipe([[sx * 0.5, -0.22, 1.4], [sx * 0.55, 0.15, 0.55], [sx * 0.6, 1.15, 0.2], [sx * 0.6, 1.15, -0.55], [sx * 0.55, -0.2, -0.9]], 0.035, tube, 8);
    b.rod(sx * 0.55, 0.15, 0.55, sx * 0.55, 0.2, -0.85, 0.03, tube, 8);
    for (const wz of [fz, rz]) shock(b, [sx * (wx - 0.12), wy + 0.04, wz], [sx * 0.5, 0.2, wz + (wz > 0 ? -0.1 : 0.1)], 0x2a2a2a, 0.05);
  }
  b.rod(0.6, 1.15, 0.2, -0.6, 1.15, 0.2, 0.035, tube, 8);
  b.rod(0.6, 1.15, -0.55, -0.6, 1.15, -0.55, 0.035, tube, 8);
  b.rod(0.6, 1.15, -0.55, -0.6, 1.15, 0.2, 0.03, tube, 8);
  // Bucket seat and wheel.
  b.rbox(0, 0.0, 0.0, 0.5, 0.12, 0.5, 0.05, S.leather(0x1c1a18, 0.5));
  b.rbox(0, 0.35, -0.24, 0.5, 0.6, 0.1, 0.05, S.leather(0x1c1a18, 0.5), 0.2, 0, 0);
  b.torus(0, 0.45, 0.42, 0.15, 0.016, S.leather(0x111111), -0.9, 0, 0, 8, 18);
  // Exposed rear engine with stacks.
  b.rbox(0, 0.08, -0.95, 0.6, 0.42, 0.55, 0.05, S.metal(0x55524d, 0.75));
  for (let i = 0; i < 4; i++) b.cyl(-0.18 + i * 0.12, 0.34, -0.95, 0.07, 0.12, 0.07, S.metal(0x8a8478, 0.6), 0, 0, 0, 10);
  for (const sx of [1, -1]) exhaust(b, [[sx * 0.2, 0.1, -1.1], [sx * 0.3, 0.2, -1.3], [sx * 0.32, 0.65, -1.35]], 0.03, 0.05);
  // Spikes on the front and the wheel hubs.
  for (let i = 0; i < 5; i++) b.add('cone12', -0.5 + i * 0.25, -0.12, 1.6, 0.07, 0.3, 0.07, S.steel(0x8a8e92, 0.6), Math.PI / 2, 0, 0);
  // Pennant pole: red-orange flag reads as raiders at a glance.
  b.rod(-0.5, 0.2, -0.85, -0.5, 2.5, -0.9, 0.018, S.metal(0x2a2a2a), 6);
  b.extrude('raiderFlag', () => {
    const s = new THREE.Shape();
    s.moveTo(0, 0);
    s.lineTo(0.75, -0.12);
    s.lineTo(0.62, -0.28);
    s.lineTo(0.78, -0.48);
    s.lineTo(0, -0.55);
    s.closePath();
    return s;
  }, 0.015, 0, -0.5, 2.48, -0.9, S.cloth(C.raiderFlag, 0.6), 0, -0.15, 0);
  b.box(-0.18, 2.24, -0.94, 0.14, 0.14, 0.02, S.cloth(0x1c1c1c, 0.4), 0, -0.15, 0);
  // Mounted MG on the cage.
  const gun = new MeshBuilder();
  heavyGun(gun, 0.85, false);
  b.appendMatrix(gun, new THREE.Matrix4().compose(new THREE.Vector3(0, 1.32, 0.12), new THREE.Quaternion(), new THREE.Vector3(0.8, 0.8, 0.8)));
  headlamp(v, b, 0.38, 0.22, 1.42, 0.07);
  headlamp(v, b, -0.38, 0.22, 1.42, 0.07);
  taillight(v, 0.3, 0.1, -1.24);
  taillight(v, -0.3, 0.1, -1.24);
  const bodyGeo = b.build();
  addWheels(v, def, wheelLocal, steered, 0.3, { tread: 'knobby', rim: 'steel', rimColor: 0x7a1c14 });
  const driver = new Humanoid({ jacket: C.raiderRed, trim: 0x1a1a1a, helmet: 0x111111, mask: true });
  driver.root.position.set(0, -0.15, 0.05);
  v.inner.add(driver.root);
  v.driver = driver;
  v.muzzle.position.set(0, 1.32, 0.86);
  v.inner.add(v.muzzle);
  v.smoke.position.set(0.32, 0.65, -1.35);
  v.inner.add(v.smoke);
  return finish(v, bodyGeo);
}

/** Spiked battle-wagon: an armour-plated truck with a ram, side spikes, a smokestack and a war banner. */
export function buildWagon(def: VehicleDef, wheelLocal: [number, number, number][], steered: boolean[]): VehicleVisual {
  const v = blank(def);
  const b = new MeshBuilder();
  b.jitter = 0.04;
  b.roundSeg = 2;
  b.seed(55);
  const armour = S.steel(0x4e4c48, 0.9);
  const rust = S.rust(C.rust2);
  const red = S.paint(C.raiderRed, 0.9);
  const wy = wheelLocal[0][1] - def.physics.suspension.rest;
  const wx = Math.abs(wheelLocal[0][0]);
  // Chassis and hull.
  for (const sx of [1, -1]) b.rbox(sx * 0.7, -0.35, 0, 0.16, 0.22, 4.6, 0.02, S.steel(0x2e3032));
  b.rbox(0, 0.32, 0.1, 2.2, 1.05, 3.4, 0.06, rust);
  // Overlapping armour plates along each flank, riveted.
  for (const sx of [1, -1]) {
    for (let i = 0; i < 4; i++) {
      b.mark(partTag('sign', `${sx}:${i}`), partMeta({ kind: 'sign', side: sx as 1 | -1, pivot: [sx * 1.1, 0.35, -1.25 + i * 0.85] }));
      plate(b, sx * 1.13, 0.35, -1.25 + i * 0.85, 0.95, 0.85, 0.05, i % 2 ? armour : rust, 0, sx * Math.PI / 2, 0);
      b.end();
    }
    // Spikes along the hull.
    for (let i = 0; i < 6; i++) b.add('cone12', sx * 1.32, 0.48 + (i % 2) * 0.22, -1.6 + i * 0.66, 0.12, 0.6, 0.12, S.steel(0x8a8e92, 0.5), 0, 0, -sx * Math.PI / 2);
    // Wheel arches.
    for (const wz of [wheelLocal[0][2], wheelLocal[2][2]]) {
      b.extrude('wagonArch', () => {
        const s = new THREE.Shape();
        s.absarc(0, 0, 0.72, 0.05, Math.PI - 0.05, false);
        s.absarc(0, 0, 0.64, Math.PI - 0.05, 0.05, true);
        s.closePath();
        return s;
      }, 0.5, 0.02, sx * (wx + 0.02), wy, wz, armour, 0, Math.PI / 2, 0);
    }
  }
  // Cab with slit visors.
  b.rbox(0, 1.1, 0.75, 2.0, 0.6, 1.5, 0.08, armour);
  b.box(0, 1.2, 1.51, 1.6, 0.08, 0.02, S.glass(0x0c0f12));
  b.box(0, 1.05, 1.51, 1.6, 0.06, 0.02, S.glass(0x0c0f12));
  plate(b, 0, 1.12, 1.53, 1.9, 0.5, 0.04, rust, -0.1, 0, 0);
  // Ram: angled plow with teeth.
  plate(b, 0, 0.35, 2.12, 2.3, 0.75, 0.06, S.steel(0x6a6e72, 0.8), -0.45, 0, 0);
  for (let i = 0; i < 7; i++) b.add('cone12', -1.05 + i * 0.35, 0.05, 2.38, 0.14, 0.55, 0.14, S.steel(0x9a9ea2, 0.4), Math.PI / 2, 0, 0);
  // Smokestack, roof cage, banner pole.
  exhaust(b, [[0.8, 0.9, 0.2], [0.8, 1.6, 0.15], [0.8, 2.2, 0.1]], 0.08, 0.1);
  b.pipe([[0.9, 1.4, -0.2], [0.9, 1.75, -0.5], [-0.9, 1.75, -0.5], [-0.9, 1.4, -0.2]], 0.04, S.steel(0x2a2c2e), 8);
  b.rod(-0.2, 1.4, -0.4, -0.2, 3.3, -0.45, 0.025, S.metal(0x2a2a2a), 6);
  b.extrude('wagonBanner', () => {
    const s = new THREE.Shape();
    s.moveTo(0, 0);
    s.lineTo(1.0, -0.1);
    s.lineTo(0.85, -0.38);
    s.lineTo(1.05, -0.7);
    s.lineTo(0, -0.8);
    s.closePath();
    return s;
  }, 0.02, 0, -0.2, 3.28, -0.45, S.cloth(C.raiderFlag, 0.7), 0, -0.1, 0);
  // Painted red war stripe and skull plate on the cab.
  b.box(0, 0.75, 1.52, 2.0, 0.12, 0.02, red);
  b.add('sphere16', 0, 0.62, 1.58, 0.3, 0.3, 0.12, S.paint(0xe2dccb, 0.6));
  b.box(0, 0.5, 1.6, 0.18, 0.1, 0.06, S.paint(0xe2dccb, 0.6));
  // Rear deck with barrels and a ladder.
  b.box(0, 0.88, -1.2, 2.0, 0.08, 1.4, S.steel(0x3a3c3e));
  b.cyl(0.6, 1.25, -1.3, 0.55, 0.75, 0.55, S.paint(0x3a5f8a, 0.9), 0, 0, 0, 16);
  b.cyl(0.0, 1.25, -1.4, 0.55, 0.75, 0.55, S.paint(C.rust, 0.9), 0, 0, 0, 16);
  headlamp(v, b, 0.8, 0.8, 1.56, 0.12);
  headlamp(v, b, -0.8, 0.8, 1.56, 0.12);
  taillight(v, 0.8, 0.2, -1.62, 0.16, 0.1);
  taillight(v, -0.8, 0.2, -1.62, 0.16, 0.1);
  const bodyGeo = b.build();
  addWheels(v, def, wheelLocal, steered, 0.5, { tread: 'knobby', rim: 'steel', rimColor: 0x3a3a3a });
  v.muzzle.position.set(0, 1.6, 1.6);
  v.inner.add(v.muzzle);
  v.smoke.position.set(0.8, 2.2, 0.1);
  v.inner.add(v.smoke);
  return finish(v, bodyGeo);
}

/** Mount points of a drivable chassis and the ground offset to take them into the chassis frame, or null (boats, raiders). */
export function mountsOfChassis(def: VehicleDef): { m: Mounts; g0: number } | null {
  switch (def.id) {
    case 'moped':
      return { m: MOPED_MOUNTS, g0: 0 };
    case 'trike':
      return { m: TRIKE_MOUNTS, g0: 0 };
    case 'quad':
      return { m: QUAD_MOUNTS, g0: 0 };
    case 'buggy':
      return { m: BUGGY_MOUNTS, g0: 0 };
    case 'hatch':
    case 'sedan':
    case 'pickup':
    case 'van':
      return carMounts(def);
    case 'truck':
    case 'rig':
      return heavyMounts(def);
    default:
      return null;
  }
}

export function buildVehicleVisual(def: VehicleDef, wheelLocal: [number, number, number][], steered: boolean[], look: VehicleLook): VehicleVisual {
  switch (def.id) {
    case 'moped':
      return buildMoped(def, wheelLocal, steered, look);
    case 'trike':
      return buildTrike(def, wheelLocal, steered, look);
    case 'quad':
      return buildQuad(def, wheelLocal, steered, look);
    case 'hatch':
    case 'sedan':
    case 'pickup':
    case 'van':
      return buildCar(def, wheelLocal, steered, look);
    case 'truck':
    case 'rig':
      return buildHeavy(def, wheelLocal, steered, look);
    default:
      return buildBuggy(def, wheelLocal, steered, look);
  }
}

/**
 * Do the heavy part of a car's model ahead of time, a slice per step. Spawning the car afterwards finds it ready.
 * Only the found-car and heavy chassis have anything to prepare; the rest build in one go and nothing is lost by it.
 */
export function* prepareVehicleVisual(def: VehicleDef, build: VehicleBuild): Generator<void> {
  if (def.id === 'hatch' || def.id === 'sedan' || def.id === 'pickup' || def.id === 'van') yield* prepareCarShell(def, lookOf(build));
  else if (isHeavy(def.id)) yield* prepareHeavyShell(def, lookOf(build));
}
