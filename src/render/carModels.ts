import * as THREE from 'three';
import { MeshBuilder, S } from './builder';
import { addKit, fitSignature, type Mounts, type Rig } from './attachments';
import { addWheels, blank, bodyMat, headlamp, lightMat as lampOn, lightOffMat as lampOff, rider, taillight, wheelSpec, type VehicleVisual } from './vehicleKit';
import { acquireShell, releaseShell, type Shell } from './shellCache';
import { heavyGun } from './parts';
import { partDef, type VehicleDef } from '../data';
import type { VehicleLook } from './vehicleModels';
import { paintPanels } from './paintJob';
import { panelSignature } from '../sim/paint';

/**
 * Drivable versions of the cars standing along the road: hatchback, sedan, pickup and van.
 * The windscreen and rear glass are in place but the side windows are open, so whoever is driving can be seen.
 * Bodies are built in a frame where y = 0 is the ground, then shifted to the chassis centre.
 */

interface Spec {
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

const SPECS: Record<Spec['id'], Spec> = {
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

/** A flat plate laid between two points of a side profile (each [y, z]), spanning `width` across the car. */
function slab(b: MeshBuilder, a: [number, number], c: [number, number], width: number, thick: number, color: Parameters<MeshBuilder['box']>[6], x = 0) {
  const dy = c[0] - a[0];
  const dz = c[1] - a[1];
  const n = Math.hypot(dy, dz);
  b.box(x, (a[0] + c[0]) / 2, (a[1] + c[1]) / 2, width, thick, n, color, Math.atan2(-dy, dz), 0, 0);
}

function rnd(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Where loose cargo can ride on a car, in the chassis frame (the body's own ground frame shifted down to the chassis centre). */
export function carMounts(def: VehicleDef): { m: Mounts; g0: number } | null {
  const sp = SPECS[def.id as Spec['id']];
  return sp ? { m: mountsFor(sp, def.physics.wheelRadius), g0: restHeight(def) } : null;
}

/** Mount points per spec, in the ground frame. */
function mountsFor(sp: Spec, wheelR: number): Mounts {
  const hw = sp.W / 2;
  const nose = sp.L / 2;
  const base: Mounts = {
    hw,
    front: { z: nose + 0.08, y: 0.48, hw: hw - 0.08 },
    rear: { z: -nose - 0.08, y: 0.48, hw: hw - 0.08 },
    side: { y0: sp.sill + 0.12, y1: sp.belt - 0.02, z0: -1.1, z1: Math.max(0.4, sp.wsBase - 0.2) },
    sill: sp.sill + 0.02,
    wheelR,
  };
  switch (sp.id) {
    case 'hatch':
      return {
        ...base,
        hood: { y: sp.hood, z0: sp.wsBase + 0.1, z1: nose - 0.15, hw: hw - 0.25 },
        roof: { y: sp.roof + 0.04, z0: sp.rwTop + 0.1, z1: sp.wsTop - 0.05, hw: hw - 0.3 },
        gun: { x: 0, y: sp.hood + 0.2, z: nose - 0.5 },
        side: { ...base.side, z0: -1.0 },
      };
    case 'sedan':
      return {
        ...base,
        hood: { y: sp.hood, z0: sp.wsBase + 0.1, z1: nose - 0.15, hw: hw - 0.25 },
        roof: { y: sp.roof + 0.04, z0: sp.rwTop + 0.1, z1: sp.wsTop - 0.05, hw: hw - 0.3 },
        trunk: { y: sp.belt + 0.06, z0: -nose + 0.15, z1: sp.rwBase - 0.05, hw: hw - 0.3 },
        gun: { x: 0, y: sp.hood + 0.2, z: nose - 0.6 },
      };
    case 'pickup':
      return {
        ...base,
        hood: { y: sp.hood, z0: sp.wsBase + 0.1, z1: nose - 0.15, hw: hw - 0.25 },
        roof: { y: sp.roof + 0.04, z0: sp.rwTop + 0.05, z1: sp.wsTop - 0.05, hw: hw - 0.3 },
        trunk: { y: 0.9, z0: -nose + 0.1, z1: -0.8, hw: hw - 0.12 },
        side: { ...base.side, z0: -0.5, z1: 0.9 },
      };
    default:
      return {
        ...base,
        hood: { y: sp.hood, z0: sp.wsBase + 0.1, z1: nose - 0.12, hw: hw - 0.25 },
        roof: { y: sp.roof + 0.04, z0: -nose + 0.2, z1: sp.wsTop - 0.05, hw: hw - 0.25 },
        gun: { x: 0, y: sp.hood + 0.2, z: nose - 0.5 },
        side: { ...base.side, z0: -1.8, z1: 0.4 },
      };
  }
}

/** Body panels with wheel openings: end caps, a core, and flank panels either side of each arch. */
function lowerBody(b: MeshBuilder, sp: Spec, d: VehicleDef, paint: ReturnType<typeof S.paint>, look: VehicleLook) {
  const hw = sp.W / 2;
  const nose = sp.L / 2;
  const R = d.physics.wheelRadius;
  const wx = Math.abs(d.physics.wheelsX[0]);
  const [wf, wr] = d.physics.wheelsZ;
  const gap = R + 0.1;
  const yc = (sp.sill + sp.belt) / 2;
  const h = sp.belt - sp.sill;
  const dark = S.metal(0x0e0e0e, 0.2);
  // Inner core (dark) so the wheel wells read as wells.
  b.rbox(0, yc, 0, (wx - 0.12) * 2, h, sp.L - 0.2, 0.05, dark);
  // End caps.
  b.rbox(0, yc, nose - 0.08, sp.W - 0.04, h, 0.16, 0.06, paint);
  b.rbox(0, yc, -nose + 0.08, sp.W - 0.04, h, 0.16, 0.06, paint);
  const zones: [number, number][] = [
    [nose - 0.1, wf + gap],
    [wf - gap, wr + gap],
    [wr - gap, -nose + 0.1],
  ];
  const archTop = R * 2 + 0.06;
  for (const sx of [1, -1]) {
    const x = sx * (hw - 0.07);
    for (const [a, c] of zones) b.rbox(x, yc, (a + c) / 2, 0.14, h, Math.abs(a - c), 0.04, paint);
    for (const wz of [wf, wr]) {
      // Fender above the arch, and the lip that rounds its opening.
      b.rbox(x, (archTop + sp.belt) / 2, wz, 0.14, Math.max(0.05, sp.belt - archTop), gap * 2, 0.04, paint);
      b.extrude(
        `carArch:${R.toFixed(2)}`,
        () => {
          const s = new THREE.Shape();
          s.absarc(0, 0, R + 0.16, 0.12, Math.PI - 0.12, false);
          s.absarc(0, 0, R + 0.06, Math.PI - 0.12, 0.12, true);
          s.closePath();
          return s;
        },
        0.16,
        0.012,
        sx * (hw - 0.03),
        R,
        wz,
        S.paint(look.paint, Math.min(1, look.wear + 0.1)),
        0,
        -Math.PI / 2,
        0,
      );
    }
  }
}

/** Interior visible through the open side windows: seats, a dash and a wheel. */
function interior(b: MeshBuilder, sp: Spec, d: VehicleDef, zSeat: number) {
  const hw = sp.W / 2;
  const fabric = S.leather(0x3a3228, 0.8);
  const plastic = S.plastic(0x1c1c1c, 0.5);
  const seatTop = sp.sill + 0.34;
  b.box(0, sp.sill + 0.04, zSeat, sp.W - 0.3, 0.04, 1.2, S.plastic(0x15130f, 0.6));
  for (const sx of [1, -1]) {
    const x = sx * (hw - 0.45);
    b.rbox(x, seatTop - 0.1, zSeat, 0.5, 0.16, 0.5, 0.05, fabric);
    b.rbox(x, seatTop + 0.22, zSeat - 0.25, 0.5, 0.58, 0.12, 0.05, fabric, 0.14, 0, 0);
    b.rbox(x, seatTop + 0.58, zSeat - 0.3, 0.26, 0.18, 0.1, 0.04, fabric, 0.14, 0, 0);
  }
  const dashZ = sp.wsBase - 0.2;
  b.rbox(0, sp.belt - 0.04, dashZ, sp.W - 0.3, 0.26, 0.34, 0.06, plastic);
  const sw = d.seat?.driver[0] ?? 0.38;
  b.torus(sw, sp.belt + 0.14, dashZ - 0.22, 0.17, 0.018, S.leather(0x111111), -1.0, 0, 0, 6, 16);
  b.rod(sw, sp.belt + 0.14, dashZ - 0.22, sw, sp.belt - 0.02, dashZ - 0.04, 0.02, plastic, 6);
}

function lights(b: MeshBuilder, rig: Rig, sp: Spec, big: boolean) {
  const hw = sp.W / 2;
  const nose = sp.L / 2;
  const r = big ? 0.115 : 0.1;
  const y = sp.hood - 0.2;
  for (const sx of [1, -1]) {
    rig.lamp(sx * (hw - 0.3), y, nose - 0.02, r, true);
    rig.tail(sx * (hw - 0.2), sp.belt - 0.12, -nose + 0.0, 0.22, 0.11);
    rig.tail(sx * (hw - 0.2), sp.belt - 0.26, -nose + 0.0, 0.22, 0.06, true);
  }
  // Grille.
  b.rbox(0, y - 0.04, nose + 0.0, sp.W * 0.46, 0.2, 0.05, 0.02, S.plastic(0x141414, 0.5));
  for (let i = 0; i < 5; i++) b.box(0, y - 0.1 + i * 0.045, nose + 0.03, sp.W * 0.44, 0.012, 0.012, S.chrome(0xbfc3c7));
  // Plates.
  b.box(0, 0.55, nose + 0.075, 0.42, 0.14, 0.01, S.paint(0xd8cf9a, 0.95));
  b.box(0, 0.62, -nose - 0.075, 0.42, 0.14, 0.01, S.paint(0xd8cf9a, 0.95));
}

function trim(b: MeshBuilder, sp: Spec, trimMat: ReturnType<typeof S.metal>) {
  const hw = sp.W / 2;
  const nose = sp.L / 2;
  b.rbox(0, 0.4, nose + 0.06, sp.W + 0.02, 0.17, 0.14, 0.05, trimMat);
  b.rbox(0, 0.4, -nose - 0.06, sp.W + 0.02, 0.17, 0.14, 0.05, trimMat);
  void hw;
}

/** Doors: seam lines and handles, mirrors. */
function doors(b: MeshBuilder, sp: Spec, zA: number, zB: number) {
  const hw = sp.W / 2;
  const seam = S.plastic(0x0e0e0e, 0.3);
  for (const sx of [1, -1]) {
    const x = sx * (hw + 0.004);
    for (const z of [zA, (zA + zB) / 2, zB]) b.box(x, (sp.sill + sp.belt) / 2 + 0.04, z, 0.006, sp.belt - sp.sill - 0.12, 0.01, seam);
    b.box(x + sx * 0.012, sp.belt - 0.12, zA - 0.16, 0.02, 0.025, 0.16, S.chrome(0xb4b8bc));
    b.box(x + sx * 0.012, sp.belt - 0.12, (zA + zB) / 2 - 0.16, 0.02, 0.025, 0.16, S.chrome(0xb4b8bc));
    // Mirror on a stalk.
    b.rod(sx * (hw - 0.04), sp.belt + 0.02, sp.wsBase + 0.04, sx * (hw + 0.1), sp.belt + 0.12, sp.wsBase + 0.1, 0.012, S.plastic(0x1a1a1a), 6);
    b.rbox(sx * (hw + 0.12), sp.belt + 0.14, sp.wsBase + 0.12, 0.05, 0.14, 0.2, 0.02, S.plastic(0x1a1a1a, 0.4));
  }
}

function weather(b: MeshBuilder, sp: Spec, look: VehicleLook) {
  const r = rnd(look.seed + 77);
  const hw = sp.W / 2;
  const n = Math.round(look.wear * 5 + (look.seed % 3));
  const rust = S.rust(0x7a3f22);
  for (let i = 0; i < n; i++) {
    const sx = r() > 0.5 ? 1 : -1;
    const z = (r() - 0.5) * (sp.L - 1.2);
    b.rbox(sx * (hw + 0.004), sp.sill + 0.12 + r() * 0.2, z, 0.012, 0.1 + r() * 0.14, 0.2 + r() * 0.4, 0.004, rust);
  }
  // A dent in the bonnet on some.
  if (look.seed % 4 === 0) b.rbox((r() - 0.5) * 0.6, sp.hood + 0.004, sp.L / 2 - 0.9, 0.5, 0.012, 0.4, 0.004, S.paint(look.paint, 1), 0.05, 0.3, 0.03);
  // Cracked screen: a few bright lines.
  for (let i = 0; i < 2; i++) {
    const t = r();
    const y = sp.belt + (sp.roof - sp.belt) * (0.3 + t * 0.4);
    const z = sp.wsBase + (sp.wsTop - sp.wsBase) * (0.3 + t * 0.4);
    b.box((r() - 0.5) * 0.9, y, z + 0.02, 0.4, 0.006, 0.004, S.paint(0xd0d6da, 0.1), 0, 0, r() * 3);
  }
}

// ------------------------------------------------------------------ the four bodies

function hatchBody(b: MeshBuilder, sp: Spec, paint: ReturnType<typeof S.paint>, roofMat: ReturnType<typeof S.paint>, glass: ReturnType<typeof S.glass>, d: VehicleDef) {
  const hw = sp.W / 2;
  const nose = sp.L / 2;
  // Bonnet and cowl.
  b.rbox(0, sp.hood - 0.04, (nose + sp.wsBase) / 2 - 0.02, sp.W - 0.1, 0.1, nose - sp.wsBase - 0.04, 0.05, paint, -0.02, 0, 0);
  // Windscreen and pillars.
  slab(b, [sp.belt + 0.02, sp.wsBase], [sp.roof, sp.wsTop], sp.W - 0.26, 0.016, glass);
  // Roof and tailgate.
  b.rbox(0, sp.roof + 0.015, (sp.wsTop + sp.rwTop) / 2, sp.W - 0.24, 0.07, sp.wsTop - sp.rwTop + 0.12, 0.04, roofMat);
  slab(b, [sp.belt + 0.06, sp.rwBase], [sp.roof, sp.rwTop], sp.W - 0.3, 0.016, glass);
  b.rbox(0, sp.belt + 0.01, -nose + 0.2, sp.W - 0.12, 0.1, 0.42, 0.05, paint);
  for (const sx of [1, -1]) {
    const xo = sx * (hw - 0.08);
    b.rod(xo, sp.belt, sp.wsBase, xo - sx * 0.05, sp.roof, sp.wsTop, 0.03, paint, 6);
    b.rod(xo, sp.belt, -0.3, xo - sx * 0.04, sp.roof, -0.3, 0.032, paint, 6);
    b.rod(xo, sp.belt + 0.04, sp.rwBase, xo - sx * 0.05, sp.roof, sp.rwTop, 0.04, paint, 6);
    b.rbox(sx * (hw - 0.07), sp.belt + 0.02, (sp.wsBase + sp.rwBase) / 2, 0.06, 0.06, sp.wsBase - sp.rwBase, 0.02, paint);
  }
  interior(b, sp, d, -0.2);
  doors(b, sp, 0.55, -0.55);
}

function sedanBody(b: MeshBuilder, sp: Spec, paint: ReturnType<typeof S.paint>, roofMat: ReturnType<typeof S.paint>, glass: ReturnType<typeof S.glass>, d: VehicleDef) {
  const hw = sp.W / 2;
  const nose = sp.L / 2;
  b.rbox(0, sp.hood - 0.04, (nose + sp.wsBase) / 2 - 0.02, sp.W - 0.1, 0.1, nose - sp.wsBase - 0.04, 0.05, paint, -0.02, 0, 0);
  slab(b, [sp.belt + 0.02, sp.wsBase], [sp.roof, sp.wsTop], sp.W - 0.26, 0.016, glass);
  b.rbox(0, sp.roof + 0.015, (sp.wsTop + sp.rwTop) / 2, sp.W - 0.24, 0.07, sp.wsTop - sp.rwTop + 0.12, 0.04, roofMat);
  slab(b, [sp.belt + 0.06, sp.rwBase], [sp.roof, sp.rwTop], sp.W - 0.3, 0.016, glass);
  // Boot lid.
  b.rbox(0, sp.belt + 0.02, (-nose + sp.rwBase) / 2 + 0.05, sp.W - 0.12, 0.1, sp.rwBase + nose - 0.1, 0.05, paint);
  for (const sx of [1, -1]) {
    const xo = sx * (hw - 0.08);
    b.rod(xo, sp.belt, sp.wsBase, xo - sx * 0.05, sp.roof, sp.wsTop, 0.03, paint, 6);
    b.rod(xo, sp.belt, -0.34, xo - sx * 0.04, sp.roof, -0.34, 0.034, paint, 6);
    b.rod(xo, sp.belt + 0.04, sp.rwBase, xo - sx * 0.05, sp.roof, sp.rwTop, 0.042, paint, 6);
    b.rbox(sx * (hw - 0.07), sp.belt + 0.02, (sp.wsBase + sp.rwBase) / 2, 0.06, 0.06, sp.wsBase - sp.rwBase, 0.02, paint);
  }
  interior(b, sp, d, -0.15);
  doors(b, sp, 0.62, -0.28);
}

function pickupBody(b: MeshBuilder, sp: Spec, paint: ReturnType<typeof S.paint>, roofMat: ReturnType<typeof S.paint>, glass: ReturnType<typeof S.glass>, d: VehicleDef, rust: ReturnType<typeof S.rust>) {
  const hw = sp.W / 2;
  const nose = sp.L / 2;
  b.rbox(0, sp.hood - 0.04, (nose + sp.wsBase) / 2 - 0.02, sp.W - 0.1, 0.12, nose - sp.wsBase - 0.04, 0.05, paint, -0.02, 0, 0);
  slab(b, [sp.belt + 0.02, sp.wsBase], [sp.roof, sp.wsTop], sp.W - 0.28, 0.016, glass);
  b.rbox(0, sp.roof + 0.015, (sp.wsTop + sp.rwTop) / 2 + 0.02, sp.W - 0.22, 0.08, sp.wsTop - sp.rwTop + 0.12, 0.04, roofMat);
  // Cab back wall with a small rear window.
  b.rbox(0, (sp.belt + sp.roof) / 2 - 0.1, sp.rwBase - 0.04, sp.W - 0.16, sp.roof - sp.belt - 0.2, 0.08, 0.03, paint);
  b.box(0, sp.belt + 0.55, sp.rwBase + 0.01, sp.W - 0.7, 0.36, 0.012, glass);
  for (const sx of [1, -1]) {
    const xo = sx * (hw - 0.08);
    b.rod(xo, sp.belt, sp.wsBase, xo - sx * 0.05, sp.roof, sp.wsTop, 0.034, paint, 6);
    b.rod(xo, sp.belt, sp.rwBase, xo - sx * 0.04, sp.roof, sp.rwBase, 0.04, paint, 6);
  }
  // Bed: floor, walls, tailgate.
  const floor = 0.9;
  const zf = sp.rwBase - 0.1;
  const zr = -nose + 0.06;
  b.box(0, floor - 0.04, (zf + zr) / 2, sp.W - 0.2, 0.06, zf - zr, S.steel(0x4a4c4e, 0.9));
  for (let i = 0; i < 7; i++) b.box(-0.7 + i * 0.233, floor - 0.005, (zf + zr) / 2, 0.05, 0.02, zf - zr - 0.06, S.steel(0x3a3c3e, 0.9));
  for (const sx of [1, -1]) {
    b.rbox(sx * (hw - 0.07), (floor + 1.2) / 2 - 0.04, (zf + zr) / 2, 0.12, 1.2 - floor + 0.04, zf - zr, 0.03, sx > 0 ? paint : rust);
    b.rbox(sx * (hw - 0.07), 1.2, (zf + zr) / 2, 0.16, 0.05, zf - zr, 0.02, S.steel(0x5a5d60, 0.7));
  }
  b.rbox(0, (floor + 1.18) / 2, zr, sp.W - 0.12, 1.18 - floor, 0.08, 0.03, paint);
  b.rbox(0, (floor + 1.12) / 2, zf, sp.W - 0.12, 1.12 - floor + 0.1, 0.08, 0.03, paint);
  interior(b, sp, d, 0.2);
  doors(b, sp, 0.9, 0.0);
}

function vanBody(b: MeshBuilder, sp: Spec, paint: ReturnType<typeof S.paint>, roofMat: ReturnType<typeof S.paint>, glass: ReturnType<typeof S.glass>, d: VehicleDef, rust: ReturnType<typeof S.rust>) {
  const hw = sp.W / 2;
  const nose = sp.L / 2;
  // Short bonnet and a tall box behind the cab.
  b.rbox(0, sp.hood - 0.04, (nose + sp.wsBase) / 2 - 0.02, sp.W - 0.1, 0.12, nose - sp.wsBase - 0.04, 0.05, paint, -0.03, 0, 0);
  slab(b, [sp.belt + 0.02, sp.wsBase], [sp.roof - 0.1, sp.wsTop], sp.W - 0.24, 0.016, glass);
  // Cargo box: solid sides and roof from behind the cab to the tail.
  const zf = sp.rwBase;
  const zr = -nose + 0.06;
  b.rbox(0, (sp.belt + sp.roof) / 2, (zf + zr) / 2, sp.W - 0.06, sp.roof - sp.belt + 0.1, zf - zr, 0.08, paint);
  // Cab roof, dropping from the box to the windscreen header.
  b.rbox(0, sp.roof - 0.1, (sp.wsTop + zf) / 2 + 0.02, sp.W - 0.16, 0.08, sp.wsTop - zf + 0.12, 0.04, roofMat);
  b.rbox(0, sp.roof + 0.04, (zf + zr) / 2, sp.W - 0.12, 0.06, zf - zr - 0.02, 0.04, roofMat);
  for (const sx of [1, -1]) {
    const xo = sx * (hw - 0.08);
    b.rod(xo, sp.belt, sp.wsBase, xo - sx * 0.05, sp.roof - 0.1, sp.wsTop, 0.036, paint, 6);
    // Sliding door seam, dents and a faded company stripe on the box.
    b.box(sx * (hw + 0.004), (sp.belt + sp.roof) / 2, -0.6, 0.006, sp.roof - sp.belt - 0.2, 0.012, S.plastic(0x0e0e0e, 0.3));
    b.box(sx * (hw + 0.006), sp.belt + 0.7, -1.4, 0.006, 0.18, 2.2, S.paint(0xe9dfc7, 0.8));
    b.rbox(sx * (hw + 0.006), sp.belt + 0.28, -1.7, 0.012, 0.3, 1.2, 0.004, rust);
  }
  b.box(0, (sp.belt + sp.roof) / 2, zr - 0.005, 0.02, sp.roof - sp.belt - 0.2, 0.012, S.plastic(0x0e0e0e, 0.3));
  interior(b, sp, d, 0.95);
  doors(b, sp, 1.05, 0.62);
}

// ------------------------------------------------------------------ assembly

function makeShell(def: VehicleDef, look: VehicleLook): Shell {
  const sp = SPECS[def.id as Spec['id']];
  const g0 = restHeight(def);
  const lamps: Shell['lamps'] = [];
  const tails: Shell['tails'] = [];
  let muzzle: Shell['muzzle'] = null;
  const b = new MeshBuilder();
  b.jitter = 0.03;
  b.roundSeg = 2;
  b.seed(look.seed + 5);
  const rig: Rig = {
    lamp: (x, y, z, r, bucket = true) => {
      lamps.push({ x, y: y - g0, z, r, bucket });
      if (bucket) {
        b.frustum(x, y, z - r * 0.45, r * 1.12, r * 0.7, r * 0.9, S.chrome(0xc8ccd0), Math.PI / 2, 0, 0, 16);
        b.torus(x, y, z, r * 1.08, r * 0.1, S.chrome(), 0, 0, 0, 6, 20);
      }
    },
    tail: (x, y, z, w, h, amber) => tails.push({ x, y: y - g0, z, w, h, amber }),
    muzzle: (x, y, z) => {
      muzzle = [x, y - g0, z];
    },
  };
  const wear = look.wear;
  const paint = S.paint(look.paint, wear);
  const roofMat = look.stripe === 2 ? S.paint(look.stripeColor, wear) : paint;
  const glass = S.glass(0x1a262e);
  const rust = S.rust(0x7a3f22);
  const trimMat = look.seed % 3 === 0 ? rust : S.metal(0x6a6c6e, 0.9);
  lowerBody(b, sp, def, paint, look);
  trim(b, sp, trimMat);
  if (sp.id === 'hatch') hatchBody(b, sp, paint, roofMat, glass, def);
  else if (sp.id === 'sedan') sedanBody(b, sp, paint, roofMat, glass, def);
  else if (sp.id === 'pickup') pickupBody(b, sp, paint, roofMat, glass, def, rust);
  else vanBody(b, sp, paint, roofMat, glass, def, rust);
  lights(b, rig, sp, sp.id === 'pickup' || sp.id === 'van');
  weather(b, sp, look);
  const nativeGun = false;
  const wpnPart = look.fit.weapon;
  const m = mountsFor(sp, def.physics.wheelRadius);
  // A pickup's gun is the pivoting bed gun built on the visual, not a fixed one.
  const fixedGun = !!wpnPart && def.weaponMount === 'front';
  const kitLook = look;
  addKit(b, rig, fixedGun ? m : { ...m, gun: undefined }, kitLook, { nativeGun });
  paintPanels(b, look.paint, look.panels, m);
  b.groundShade(0.0, 0.5, 0.35);
  const geo = b.build();
  geo.translate(0, -g0, 0);
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return { geo, lamps, tails, muzzle };
}

function shellKey(def: VehicleDef, look: VehicleLook): string {
  return `${def.id}|${look.paint}|${look.stripe}|${look.stripeColor}|${look.seed}|${Math.round(look.wear * 10)}|${fitSignature(look.fit)}|${panelSignature(look.panels)}`;
}

export function buildCar(def: VehicleDef, wheelLocal: [number, number, number][], steered: boolean[], look: VehicleLook): VehicleVisual {
  const v = blank(def);
  const g0 = restHeight(def);
  const key = shellKey(def, look);
  const shell = acquireShell(key, () => makeShell(def, look));
  v.body = new THREE.Mesh(shell.geo, bodyMat);
  v.body.castShadow = true;
  v.body.receiveShadow = true;
  v.inner.add(v.body);
  for (const l of shell.lamps) headlamp(v, new MeshBuilder(), l.x, l.y, l.z, l.r, false);
  for (const t of shell.tails) taillight(v, t.x, t.y, t.z, t.w, t.h, t.amber);
  if (shell.muzzle) v.muzzle.position.set(...shell.muzzle);
  v.setHeadlights = (on: boolean) => {
    for (const h of v.headlights) h.material = on ? lampOn : lampOff;
  };
  const wm = look.fit.wheels ? partDef(look.fit.wheels.id).mk : 0;
  const ws = wheelSpec(def, wm);
  addWheels(v, def, wheelLocal, steered, ws.width, ws.style);
  // Seats: occupants are built the first time someone sits down.
  const seat = def.seat!;
  const seatY = SPECS[def.id as Spec['id']].sill + 0.34 - g0 - 0.2;
  const color = look.paint;
  v.lazy = {
    driver: () => {
      const r = rider(color, color);
      r.root.position.set(seat.driver[0], seatY, seat.driver[2] - 0.05);
      return r;
    },
    passenger: () => {
      const r = rider(color, color);
      r.root.position.set(seat.passenger[0], seatY, seat.passenger[2] - 0.05);
      return r;
    },
  };
  v.gunSeat = [seat.passenger[0], seatY, seat.passenger[2] - 0.05];
  // A bed gun on a pickup: a pivoting heavy MG and a standing spot for the gunner.
  if (def.weaponMount === 'bed' && look.fit.weapon) {
    const bedZ = -1.55;
    const floor = 0.9 - g0;
    const gun = new THREE.Group();
    gun.position.set(0, floor + 0.85, bedZ + 0.2);
    const gb = new MeshBuilder();
    heavyGun(gb, 1.2, true);
    if (partDef(look.fit.weapon.id).mk >= 2) heavyGun(gb, 1.2, false);
    const gm = new THREE.Mesh(gb.build(), bodyMat);
    gm.castShadow = true;
    gun.add(gm);
    const mz = new THREE.Object3D();
    mz.position.set(0, 0, 1.22);
    gun.add(mz);
    v.inner.add(gun);
    v.gun = gun;
    v.muzzle = mz;
    v.gunSeat = [0, floor, bedZ];
  }
  v.smoke.position.set(-0.3, 0.3 - g0 + 0.4, -SPECS[def.id as Spec['id']].L / 2);
  v.inner.add(v.smoke);
  v.damageTint = () => {};
  v.dispose = () => releaseShell(key);
  return v;
}

