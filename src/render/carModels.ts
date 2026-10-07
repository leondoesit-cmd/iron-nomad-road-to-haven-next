import * as THREE from 'three';
import { MeshBuilder, S, type Surf } from './builder';
import { addKit, bodyPart, doorSkipsSteel, panelOff, type Mounts, type Rig } from './attachments';
import type { Fit } from '../sim/parts';
import { addWheelSet, addWheels, blank, bodyMat, headlamp, lightMat as lampOn, lightOffMat as lampOff, rider, taillight, wheelSpec, wheelSpecs, type VehicleVisual } from './vehicleKit';
import { acquireShell, hasShell, releaseShell, type Shell } from './shellCache';
import { heavyGun } from './parts';
import { isInteriorSlot, partDef, type VehicleDef } from '../data';
import { SPECS, restHeight, type Spec } from './carSpecs';
export { restHeight };
import { PANEL_TAG, partMeta, partTag, type PartRange } from './bodyParts';
import { PaneSet } from './glass';
import { attachBay } from './bayMesh';
import type { VehicleLook } from './vehicleModels';
import type { CarPane } from '../sim/glass';
import { panesPresent } from '../sim/glassfit';
import { paintPanels } from './paintJob';
import { panelSignature } from '../sim/paint';
import { cabinGaps } from '../sim/cabin';
import { CABIN_FILL, cabinKey, cabinLayout, drawCabin, fillLight, hipHeight, rimGeometry, seatOccupant } from './interior';

/**
 * Drivable versions of the cars standing along the road: hatchback, sedan, pickup and van.
 * The windscreen and rear glass are in place but the side windows are open, so whoever is driving can be seen.
 * Bodies are built in a frame where y = 0 is the ground, then shifted to the chassis centre.
 */

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

/**
 * The windows of a car as panes of glass, in the chassis frame: the windscreen, the rear window (a van has none), and the
 * side windows either side of the pillar. They are not part of the shell, so they can crack and go while the body stays.
 * `fit` is what is bolted on: a frame with no glass in it, or a door that is off, has no pane.
 */
export function carPanes(def: VehicleDef, fit: Fit = {}): CarPane[] {
  const sp = SPECS[def.id as Spec['id']];
  if (!sp) return [];
  const g0 = restHeight(def);
  const hw = sp.W / 2;
  const out: CarPane[] = [];
  // A sloped pane laid between two points of the side profile ([y, z]); `out` is +1 for glass that faces forward, -1 backward.
  const sloped = (key: string, kind: CarPane['kind'], a: [number, number], c: [number, number], width: number, facing: 1 | -1) => {
    const dy = c[0] - a[0];
    const dz = c[1] - a[1];
    const len = Math.hypot(dy, dz);
    const n: [number, number, number] = facing > 0 ? [0, -dz / len, dy / len] : [0, dz / len, -dy / len];
    out.push({ key, kind, c: [0, (a[0] + c[0]) / 2 - g0, (a[1] + c[1]) / 2], n, hw: width / 2, hh: len / 2 });
  };
  sloped('ws', 'screen', [sp.belt + 0.02, sp.wsBase], [sp.roof - (sp.id === 'van' ? 0.1 : 0), sp.wsTop], sp.W - (sp.id === 'van' ? 0.3 : 0.32), 1);
  if (sp.id === 'hatch' || sp.id === 'sedan') sloped('rw', 'rear', [sp.belt + 0.06, sp.rwBase], [sp.roof, sp.rwTop], sp.W - 0.38, -1);
  else if (sp.id === 'pickup') out.push({ key: 'rw', kind: 'rear', c: [0, sp.belt + 0.55 - g0, sp.rwBase], n: [0, 0, -1], hw: (sp.W - 0.7) / 2, hh: 0.18 });
  // Side windows: between the screen's top and the rear glass's top, split at the centre pillar of a two-door.
  const y0 = sp.belt + 0.05;
  const y1 = (sp.id === 'van' ? sp.roof - 0.12 : sp.roof - 0.04);
  const z1 = sp.wsTop - 0.06;
  const z0 = sp.id === 'hatch' || sp.id === 'sedan' ? sp.rwTop + 0.06 : sp.rwBase + 0.06;
  const split = sp.id === 'hatch' ? -0.3 : sp.id === 'sedan' ? -0.34 : null;
  const runs: [number, number][] = split === null ? [[z0, z1]] : [[split + 0.04, z1], [z0, split - 0.04]];
  for (const sx of [1, -1] as const) {
    runs.forEach(([za, zb], i) => {
      if (zb - za < 0.2) return;
      out.push({ key: `s${sx > 0 ? 'L' : 'R'}${i}`, kind: 'side', c: [sx * (hw - 0.08), (y0 + y1) / 2 - g0, (za + zb) / 2], n: [sx, 0, 0], hw: (zb - za) / 2, hh: (y1 - y0) / 2 });
    });
  }
  // Only the panes the fitted parts leave: no windscreen, no pane. A door with no window (or none at all) has no glass in it.
  const have = new Set(panesPresent(def, fit));
  return out.filter((p) => have.has(p.key));
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
    doors: true,
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
  // Dark cores so the wheel wells read as wells: the engine bay up front, and the boot, bed or cargo box at the back. The
  // cabin between them is hollow (its floor, seats and dash are in the cabin mesh, see `interior.ts`).
  const cw = (wx - 0.12) * 2;
  const lay = cabinLayout(d)!;
  const zF = lay.zFront;
  // The engine bay is hollow: a floor tray, two wing walls and the firewall, so a real engine stands in it (see `bayKit`).
  const bayL = nose - 0.1 - zF;
  const bayZ = (zF + nose - 0.1) / 2;
  b.rbox(0, sp.sill + 0.03, bayZ, cw, 0.06, bayL, 0.02, dark);
  for (const sx of [1, -1]) b.rbox(sx * (cw / 2 - 0.03), yc, bayZ, 0.06, h, bayL, 0.02, dark);
  b.rbox(0, yc, zF + 0.03, cw, h, 0.06, 0.02, dark);
  const zR = -nose + 0.1;
  const topR = sp.id === 'pickup' ? 0.84 : sp.belt;
  if (lay.zBack - zR > 0.15) b.rbox(0, (sp.sill + topR) / 2, (lay.zBack + zR) / 2, cw, topR - sp.sill, lay.zBack - zR, 0.05, dark);
  // End caps.
  b.rbox(0, yc, nose - 0.08, sp.W - 0.04, h, 0.16, 0.06, paint);
  // A hatchback's tailgate reaches down to the bumper; every other rear end stays put.
  if (sp.id === 'hatch') b.mark(PANEL_TAG.trunk, partMeta({ kind: 'trunk', pivot: [0, sp.roof + 0.02, sp.rwTop] }));
  b.rbox(0, yc, -nose + 0.08, sp.W - 0.04, h, 0.16, 0.06, paint);
  if (sp.id === 'hatch') b.end();
  const zones: [number, number][] = [
    [nose - 0.1, wf + gap],
    [wf - gap, wr + gap],
    [wr - gap, -nose + 0.1],
  ];
  const archTop = R * 2 + 0.06;
  for (const sx of [1, -1]) {
    const x = sx * (hw - 0.07);
    const doorSlot = sx > 0 ? 'doorL' : 'doorR';
    zones.forEach(([a, c], zi) => {
      // The middle panel is the door; if the door is off the mount shows through, and a canvas one is drawn by the kit.
      if (zi === 1 && doorSkipsSteel(look.fit, doorSlot)) return;
      if (zi === 1) b.mark(partTag('door', sx), partMeta({ kind: 'door', side: sx as 1 | -1, pivot: [x, yc, Math.max(a, c)] }));
      b.rbox(x, yc, (a + c) / 2, 0.14, h, Math.abs(a - c), 0.04, paint);
      if (zi === 1) {
        // The door's inside: a trim card with an armrest and a pull, so the cab is not walled in body paint. It is part of
        // the door, so it goes when the door does.
        const ix = sx * (hw - 0.152);
        const zc = (a + c) / 2;
        const card: Surf = { ...S.plastic(0x4a4439, 0.5), e: CABIN_FILL };
        b.rbox(ix, yc - 0.01, zc, 0.02, h - 0.06, Math.abs(a - c) - 0.08, 0.008, card);
        b.rbox(ix - sx * 0.025, sp.belt - 0.15, zc - 0.05, 0.05, 0.05, Math.abs(a - c) * 0.45, 0.015, { ...S.plastic(0x2e2b27, 0.5), e: CABIN_FILL });
        b.rbox(ix - sx * 0.015, sp.belt - 0.08, zc + Math.abs(a - c) * 0.3, 0.03, 0.03, 0.12, 0.01, S.chrome(0xb4b8bc));
      }
      if (zi === 1) b.end();
    });
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
  if (sp.id === 'hatch') b.mark(PANEL_TAG.trunk, partMeta({ kind: 'trunk', pivot: [0, sp.roof + 0.02, sp.rwTop] }));
  b.box(0, 0.62, -nose - 0.075, 0.42, 0.14, 0.01, S.paint(0xd8cf9a, 0.95));
  if (sp.id === 'hatch') b.end();
}

function trim(b: MeshBuilder, sp: Spec, trimMat: ReturnType<typeof S.metal>) {
  const hw = sp.W / 2;
  const nose = sp.L / 2;
  b.mark(partTag('bumper', 'front'), partMeta({ kind: 'bumper', pivot: [0, 0.4, nose - 0.08] }));
  b.rbox(0, 0.4, nose + 0.06, sp.W + 0.02, 0.17, 0.14, 0.05, trimMat);
  b.end();
  b.mark(partTag('bumper', 'rear'), partMeta({ kind: 'bumper', pivot: [0, 0.4, -nose + 0.08] }));
  b.rbox(0, 0.4, -nose - 0.06, sp.W + 0.02, 0.17, 0.14, 0.05, trimMat);
  b.end();
  void hw;
}

/** The bonnet: a pressed panel, or vented, scooped or armoured. With it off, `addKit` draws the bay. */
function bonnet(b: MeshBuilder, sp: Spec, paint: ReturnType<typeof S.paint>, look: VehicleLook, thick: number, tilt: number) {
  const part = bodyPart(look.fit, 'hood');
  if (part?.off) return;
  const nose = sp.L / 2;
  const armored = part?.id === 'hood_armor';
  const pan = armored ? S.steel(0x5a5d60, 0.8) : paint;
  // The bonnet hinges at the cowl and swings up (`Bodywork` poses it when someone opens it).
  b.mark(PANEL_TAG.hood, partMeta({ kind: 'hood', pivot: [0, sp.hood - 0.04, sp.wsBase] }));
  b.rbox(0, sp.hood - 0.04, (nose + sp.wsBase) / 2 - 0.02, sp.W - 0.1, thick + (armored ? 0.03 : 0), nose - sp.wsBase - 0.04, 0.05, pan, tilt, 0, 0);
  b.end();
}

/** Doors: seam lines and handles, mirrors. */
function doors(b: MeshBuilder, sp: Spec, zA: number, zB: number, fit: Fit) {
  const hw = sp.W / 2;
  const seam = S.plastic(0x0e0e0e, 0.3);
  for (const sx of [1, -1]) {
    // No door, no seams, handles or mirror.
    if (panelOff(fit, sx > 0 ? 'doorL' : 'doorR')) continue;
    const x = sx * (hw + 0.004);
    b.mark(partTag('door', sx), partMeta({ kind: 'door', side: sx as 1 | -1 }));
    for (const z of [zA, (zA + zB) / 2, zB]) b.box(x, (sp.sill + sp.belt) / 2 + 0.04, z, 0.006, sp.belt - sp.sill - 0.12, 0.01, seam);
    b.box(x + sx * 0.012, sp.belt - 0.12, zA - 0.16, 0.02, 0.025, 0.16, S.chrome(0xb4b8bc));
    b.box(x + sx * 0.012, sp.belt - 0.12, (zA + zB) / 2 - 0.16, 0.02, 0.025, 0.16, S.chrome(0xb4b8bc));
    b.end();
    // Mirror on a stalk.
    b.mark(partTag('mirror', sx), partMeta({ kind: 'mirror', side: sx as 1 | -1, pivot: [sx * (hw - 0.04), sp.belt + 0.02, sp.wsBase + 0.04] }));
    b.rod(sx * (hw - 0.04), sp.belt + 0.02, sp.wsBase + 0.04, sx * (hw + 0.1), sp.belt + 0.12, sp.wsBase + 0.1, 0.012, S.plastic(0x1a1a1a), 6);
    b.rbox(sx * (hw + 0.12), sp.belt + 0.14, sp.wsBase + 0.12, 0.05, 0.14, 0.2, 0.02, S.plastic(0x1a1a1a, 0.4));
    b.end();
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
}

// ------------------------------------------------------------------ the four bodies

function hatchBody(b: MeshBuilder, sp: Spec, paint: ReturnType<typeof S.paint>, roofMat: ReturnType<typeof S.paint>, glass: ReturnType<typeof S.glass>, d: VehicleDef, look: VehicleLook) {
  const hw = sp.W / 2;
  const nose = sp.L / 2;
  // Bonnet and cowl.
  bonnet(b, sp, paint, look, 0.1, -0.02);
  // Pillars; the windows are panes of their own (see carPanes).
  // Roof.
  b.rbox(0, sp.roof + 0.015, (sp.wsTop + sp.rwTop) / 2, sp.W - 0.24, 0.07, sp.wsTop - sp.rwTop + 0.04, 0.04, roofMat);
  // The tailgate: roof hinge header, slanted frame rails framing the rear window, waist bar, and handle.
  // The entire rear assembly lifts together on a roof hinge.
  const hinge: [number, number, number] = [0, sp.roof + 0.02, sp.rwTop];
  b.mark(PANEL_TAG.trunk, partMeta({ kind: 'trunk', pivot: hinge }));
  // Top header along the roof edge
  b.rbox(0, sp.roof + 0.015, sp.rwTop - 0.01, sp.W - 0.24, 0.06, 0.06, 0.02, paint);
  // Slanted side frame rails framing the rear window
  for (const sx of [1, -1]) {
    const tx = sx * (hw - 0.08);
    b.rod(tx, sp.belt + 0.04, sp.rwBase, tx - sx * 0.05, sp.roof, sp.rwTop, 0.04, paint, 6);
  }
  // Waist bar under the rear window joining the window frame to the lower panel
  b.rbox(0, sp.belt + 0.04, (sp.rwBase + (-nose + 0.08)) / 2, sp.W - 0.12, 0.08, Math.abs(-nose + 0.08 - sp.rwBase) + 0.08, 0.03, paint);
  // Tailgate handle
  b.box(0, sp.belt + 0.02, -nose + 0.01, 0.22, 0.03, 0.03, S.chrome(0xb4b8bc));
  b.end();
  for (const sx of [1, -1]) {
    const xo = sx * (hw - 0.08);
    // A-pillar
    b.rod(xo, sp.belt, sp.wsBase, xo - sx * 0.05, sp.roof, sp.wsTop, 0.03, paint, 6);
    // B-pillar
    b.rod(xo, sp.belt, -0.3, xo - sx * 0.04, sp.roof, -0.3, 0.032, paint, 6);
    // Rear cabin post at the C-pillar supporting the roof corner when tailgate is open
    b.rod(xo, sp.belt + 0.02, sp.rwTop, xo - sx * 0.04, sp.roof, sp.rwTop, 0.034, paint, 6);
    // Flank waist rail under the side windows
    b.rbox(sx * (hw - 0.07), sp.belt + 0.02, (sp.wsBase + sp.rwTop) / 2, 0.06, 0.06, sp.wsBase - sp.rwTop, 0.02, paint);
  }
  doors(b, sp, 0.55, -0.55, look.fit);
}

function sedanBody(b: MeshBuilder, sp: Spec, paint: ReturnType<typeof S.paint>, roofMat: ReturnType<typeof S.paint>, glass: ReturnType<typeof S.glass>, d: VehicleDef, look: VehicleLook) {
  const hw = sp.W / 2;
  const nose = sp.L / 2;
  bonnet(b, sp, paint, look, 0.1, -0.02);
  b.rbox(0, sp.roof + 0.015, (sp.wsTop + sp.rwTop) / 2, sp.W - 0.24, 0.07, sp.wsTop - sp.rwTop + 0.12, 0.04, roofMat);
  // Boot lid.
  b.mark(PANEL_TAG.trunk, partMeta({ kind: 'trunk', pivot: [0, sp.belt + 0.02, sp.rwBase] }));
  b.rbox(0, sp.belt + 0.02, (-nose + sp.rwBase) / 2 + 0.05, sp.W - 0.12, 0.1, sp.rwBase + nose - 0.1, 0.05, paint);
  b.end();
  for (const sx of [1, -1]) {
    const xo = sx * (hw - 0.08);
    b.rod(xo, sp.belt, sp.wsBase, xo - sx * 0.05, sp.roof, sp.wsTop, 0.03, paint, 6);
    b.rod(xo, sp.belt, -0.34, xo - sx * 0.04, sp.roof, -0.34, 0.034, paint, 6);
    b.rod(xo, sp.belt + 0.04, sp.rwBase, xo - sx * 0.05, sp.roof, sp.rwTop, 0.042, paint, 6);
    b.rbox(sx * (hw - 0.07), sp.belt + 0.02, (sp.wsBase + sp.rwBase) / 2, 0.06, 0.06, sp.wsBase - sp.rwBase, 0.02, paint);
  }
  doors(b, sp, 0.62, -0.28, look.fit);
}

function pickupBody(b: MeshBuilder, sp: Spec, paint: ReturnType<typeof S.paint>, roofMat: ReturnType<typeof S.paint>, glass: ReturnType<typeof S.glass>, d: VehicleDef, rust: ReturnType<typeof S.rust>, look: VehicleLook) {
  const hw = sp.W / 2;
  const nose = sp.L / 2;
  bonnet(b, sp, paint, look, 0.12, -0.02);
  b.rbox(0, sp.roof + 0.015, (sp.wsTop + sp.rwTop) / 2 + 0.02, sp.W - 0.22, 0.08, sp.wsTop - sp.rwTop + 0.12, 0.04, roofMat);
  // Cab back wall with a small rear window.
  b.rbox(0, (sp.belt + sp.roof) / 2 - 0.1, sp.rwBase - 0.04, sp.W - 0.16, sp.roof - sp.belt - 0.2, 0.08, 0.03, paint);
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
  doors(b, sp, 0.9, 0.0, look.fit);
}

function vanBody(b: MeshBuilder, sp: Spec, paint: ReturnType<typeof S.paint>, roofMat: ReturnType<typeof S.paint>, glass: ReturnType<typeof S.glass>, d: VehicleDef, rust: ReturnType<typeof S.rust>, look: VehicleLook) {
  const hw = sp.W / 2;
  const nose = sp.L / 2;
  // Short bonnet and a tall box behind the cab.
  bonnet(b, sp, paint, look, 0.12, -0.03);
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
  // The rear door lifts on a hinge along the roof; the opening behind it is a dark cargo bay.
  const yMid = (sp.belt + sp.roof) / 2;
  const doorH = sp.roof - sp.belt - 0.04;
  b.rbox(0, yMid, zr - 0.006, sp.W - 0.34, doorH - 0.16, 0.012, 0.004, S.metal(0x0e0e0e, 0.2));
  b.mark(PANEL_TAG.trunk, partMeta({ kind: 'trunk', pivot: [0, sp.roof + 0.03, zr] }));
  b.rbox(0, yMid + 0.02, zr - 0.012, sp.W - 0.12, doorH, 0.034, 0.012, paint);
  b.box(0, yMid - 0.1, zr - 0.034, 0.16, 0.03, 0.012, S.chrome(0xb4b8bc));
  b.end();
  doors(b, sp, 1.05, 0.62, look.fit);
}

// ------------------------------------------------------------------ assembly

function makeShell(def: VehicleDef, look: VehicleLook): Shell {
  const g = makeShellSteps(def, look);
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

/** `makeShell` in slices: it yields between the big parts of the body, so a car can be built over a few ticks. */
function* makeShellSteps(def: VehicleDef, look: VehicleLook): Generator<void, Shell> {
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
  yield;
  if (sp.id === 'hatch') hatchBody(b, sp, paint, roofMat, glass, def, look);
  else if (sp.id === 'sedan') sedanBody(b, sp, paint, roofMat, glass, def, look);
  else if (sp.id === 'pickup') pickupBody(b, sp, paint, roofMat, glass, def, rust, look);
  else vanBody(b, sp, paint, roofMat, glass, def, rust, look);
  yield;
  lights(b, rig, sp, sp.id === 'pickup' || sp.id === 'van');
  weather(b, sp, look);
  yield;
  const nativeGun = false;
  const wpnPart = look.fit.weapon;
  const m = mountsFor(sp, def.physics.wheelRadius);
  // A pickup's gun is the pivoting bed gun built on the visual, not a fixed one.
  const fixedGun = !!wpnPart && def.weaponMount === 'front';
  const kitLook = look;
  const wheels = wheelXZ(def).map(([x, z]) => [x, z] as [number, number]);
  addKit(b, rig, fixedGun ? m : { ...m, gun: undefined }, kitLook, { nativeGun, wheels, bayFloor: sp.belt - 0.03 });
  paintPanels(b, look.paint, look.panels, m);
  b.groundShade(0.0, 0.5, 0.35);
  yield;
  const geo = b.build();
  geo.translate(0, -g0, 0);
  // The body was built on the ground and is shifted to the chassis centre: the joints move with it.
  for (const r of (geo.userData.parts ?? []) as PartRange[]) if (r.meta.pivot) r.meta = { ...r.meta, pivot: [r.meta.pivot[0], r.meta.pivot[1] - g0, r.meta.pivot[2]] };
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return { geo, lamps, tails, muzzle };
}

/** Wheel centres (x, z) in the chassis frame, in wheel order. */
function wheelXZ(def: VehicleDef): [number, number][] {
  const p = def.physics;
  const out: [number, number][] = [];
  const xs = p.wheelsX[0] === 0 ? [0] : p.wheelsX;
  for (const z of p.wheelsZ) for (const x of xs) if (out.length < p.wheelCount) out.push([x, z]);
  return out;
}

/** The fitted parts that change the body shell. The cabin's seats, wheel and dash are their own mesh and are not in it. */
function bodySignature(fit: VehicleLook['fit']): string {
  return Object.keys(fit)
    .filter((k) => !isInteriorSlot(k as never))
    .sort()
    .map((k) => `${k}:${fit[k as keyof typeof fit]!.id}`)
    .join(',');
}

function shellKey(def: VehicleDef, look: VehicleLook): string {
  return `${def.id}|${look.paint}|${look.stripe}|${look.stripeColor}|${look.seed}|${Math.round(look.wear * 10)}|${bodySignature(look.fit)}|${panelSignature(look.panels)}`;
}

/** The cabin mesh: floor, headliner, seats, dash and the wheel's column, each part as fitted. Shared between identical cars. */
function makeCabin(def: VehicleDef, look: VehicleLook): Shell & { rim?: { id: string; x: number; y: number; z: number; tilt: number } | null } {
  const g0 = restHeight(def);
  const b = new MeshBuilder();
  b.jitter = 0.03;
  b.roundSeg = 2;
  b.seed(look.seed + 9);
  const rim = drawCabin(b, def, look.fit);
  fillLight(b, 0, CABIN_FILL);
  const geo = b.build();
  geo.translate(0, -g0, 0);
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return { geo, lamps: [], tails: [], muzzle: null, rim: rim ? { ...rim, y: rim.y - g0 } : null };
}

const cabinShellKey = (def: VehicleDef, look: VehicleLook) => `cab|${def.id}|${cabinKey(def, look.fit)}`;

/** Build a car's shell ahead of the car itself, a slice per step, so spawning it later is a cache hit and not a dropped frame. */
export function* prepareCarShell(def: VehicleDef, look: VehicleLook): Generator<void> {
  const key = shellKey(def, look);
  if (hasShell(key) || !SPECS[def.id as Spec['id']]) return;
  const shell = yield* makeShellSteps(def, look);
  acquireShell(key, () => shell);
  releaseShell(key);
  const ckey = cabinShellKey(def, look);
  if (!hasShell(ckey)) {
    yield;
    acquireShell(ckey, () => makeCabin(def, look));
    releaseShell(ckey);
  }
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
  // The windows: panes of their own over the open shell. A beaten-up car comes with its screen already cracked.
  const panes = new PaneSet();
  for (const p of carPanes(def, look.fit)) panes.add(p);
  v.inner.add(panes.group);
  v.panes = panes;
  const screen = panes.spec('ws');
  if (screen && look.wear > 0.55) panes.crack('ws', look.wear > 0.8 ? 2 : 1, [screen.c[0] + ((look.seed % 7) - 3) * 0.12, screen.c[1], screen.c[2]]);
  for (const l of shell.lamps) headlamp(v, new MeshBuilder(), l.x, l.y, l.z, l.r, false);
  for (const t of shell.tails) taillight(v, t.x, t.y, t.z, t.w, t.h, t.amber);
  if (shell.muzzle) v.muzzle.position.set(...shell.muzzle);
  v.setHeadlights = (on: boolean) => {
    for (const h of v.headlights) h.material = on ? lampOn : lampOff;
  };
  addWheelSet(v, def, wheelLocal, steered, wheelSpecs(def, look.tyres, look.brakeMk ?? 0));
  // The cabin is a mesh of its own under the roof, so it shows through an open door or a broken window.
  const ckey = cabinShellKey(def, look);
  const cab = acquireShell(ckey, () => makeCabin(def, look)) as ReturnType<typeof makeCabin>;
  v.interior = new THREE.Mesh(cab.geo, bodyMat);
  v.interior.receiveShadow = true;
  v.inner.add(v.interior);
  // The wheel's rim turns with the steering.
  if (cab.rim) {
    const pivot = new THREE.Group();
    pivot.position.set(cab.rim.x, cab.rim.y, cab.rim.z);
    pivot.rotation.x = cab.rim.tilt;
    const rim = new THREE.Mesh(rimGeometry(cab.rim.id), bodyMat);
    rim.receiveShadow = true;
    pivot.add(rim);
    v.inner.add(pivot);
    v.steerWheel = rim;
  }
  // Seats: occupants are built the first time someone sits down, and sat in the cabin's seats every frame.
  const L = cabinLayout(def)!;
  const color = look.paint;
  v.lazy = { driver: () => rider(color, color), passenger: () => rider(color, color) };
  const gaps = cabinGaps(def, look.fit);
  v.seat = (who, h, drop) => {
    const spot = who === 'driver' ? L.seats.seatD! : L.seats.seatP!;
    seatOccupant(h, L, spot, hipHeight(L, spot, who === 'driver' ? gaps.seatD : gaps.seatP, drop), who === 'driver' ? -0.06 : -0.02);
  };
  const ps = L.seats.seatP!;
  v.gunSeat = [ps.x, L.floor - g0, ps.z];
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
  v.dispose = () => {
    panes.dispose();
    releaseShell(key);
    releaseShell(ckey);
  };
  // The engine bay under the bonnet, for when someone lifts it.
  attachBay(v, def.id, mountsFor(SPECS[def.id as Spec['id']], def.physics.wheelRadius), look, SPECS[def.id as Spec['id']].belt - 0.03, g0);
  return v;
}

