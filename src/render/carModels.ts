import * as THREE from 'three';
import { MeshBuilder, S, type Surf } from './builder';
import { addKit, bodyPart, doorSkipsSteel, panelOff, type Mounts, type Rig } from './attachments';
import type { Fit } from '../sim/parts';
import { addWheelSet, blank, bodyMat, headlamp, lightMat as lampOn, lightOffMat as lampOff, rider, taillight, wheelSpecs, type VehicleVisual } from './vehicleKit';
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
import { trimKey, type CarTrim } from '../sim/carTrim';
import {
  baseTrim,
  bodyColor,
  bumpers,
  extras,
  flankZones,
  frontEnd,
  raiderKit,
  rnd,
  roofTop,
  rustBlooms,
  schemePanels,
  schemeWear,
  stencils,
  tails,
  taxiChecker,
  toneBands,
  type TrimCtx,
} from './carTrimKit';
import { applyRideLift } from './rideHeight';

/**
 * Drivable versions of the cars standing along the road: hatchback, sedan, pickup and van, each in the bodies, trims and
 * paint its seed rolls (see sim/carTrim.ts and carTrimKit.ts): a three- or five-door hatch or a hot hatch, a saloon, estate,
 * taxi or ex-patrol car, a pickup with a plain bed, a flatbed, a tilt or a work rack, a panel, windowed, ambulance or
 * utility van. The windscreen and rear glass are in place but the side windows are open, so whoever is driving can be seen.
 * Bodies are built in a frame where y = 0 is the ground, then shifted to the chassis centre. No variant moves a hard point:
 * the panes, cabin, bed and mounts are the chassis' own.
 */

/** A flat plate laid between two points of a side profile (each [y, z]), spanning `width` across the car. */
function slab(b: MeshBuilder, a: [number, number], c: [number, number], width: number, thick: number, color: Parameters<MeshBuilder['box']>[6], x = 0) {
  const dy = c[0] - a[0];
  const dz = c[1] - a[1];
  const n = Math.hypot(dy, dz);
  b.box(x, (a[0] + c[0]) / 2, (a[1] + c[1]) / 2, width, thick, n, color, Math.atan2(-dy, dz), 0, 0);
}
void slab;

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

/** Mount points per spec, in the ground frame. The same for every trim of the chassis. */
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

type Paint = ReturnType<typeof S.paint>;

/** Does this flank lose its panel on a burnt wreck: a front wing (0) or a rear quarter (2)? Seeded, so a wreck is always the same. */
function hulkGone(seed: number, zi: number, sx: number): boolean {
  const r = rnd(seed + 515 + zi * 7 + (sx > 0 ? 1 : 0))();
  return zi === 0 ? r < 0.45 : zi === 2 ? r < 0.35 : false;
}

/**
 * Body panels with wheel openings: end caps, a core, and flank panels either side of each arch. A flatbed's rear quarters
 * stop under its deck; a hot hatch has flares on its arches; a burnt wreck has lost a wing or a quarter panel, showing the
 * strut and the well behind.
 */
function lowerBody(b: MeshBuilder, sp: Spec, d: VehicleDef, paint: Paint, look: VehicleLook, t: CarTrim, paintHex: number) {
  const hw = sp.W / 2;
  const nose = sp.L / 2;
  const R = d.physics.wheelRadius;
  const wx = Math.abs(d.physics.wheelsX[0]);
  const [wf, wr] = d.physics.wheelsZ;
  const gap = R + 0.1;
  const yc = (sp.sill + sp.belt) / 2;
  const h = sp.belt - sp.sill;
  const dark = S.metal(0x0e0e0e, 0.2);
  const hulk = !!look.hulk;
  const flat = t.body === 'flatbed';
  // A flatbed's rear end only reaches up to the underside of its deck.
  const rearTop = flat ? 0.84 : sp.belt;
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
  b.rbox(0, (sp.sill + rearTop) / 2, -nose + 0.08, sp.W - 0.04, rearTop - sp.sill, 0.16, 0.06, paint);
  if (sp.id === 'hatch') b.end();
  const zones: [number, number][] = [
    [nose - 0.1, wf + gap],
    [wf - gap, wr + gap],
    [wr - gap, -nose + 0.1],
  ];
  const archTop = R * 2 + 0.06;
  const lip = S.paint(paintHex, Math.min(1, look.wear + 0.1));
  for (const sx of [1, -1]) {
    const x = sx * (hw - 0.07);
    const doorSlot = sx > 0 ? 'doorL' : 'doorR';
    zones.forEach(([a, c], zi) => {
      // The middle panel is the door; if the door is off the mount shows through, and a canvas one is drawn by the kit.
      if (zi === 1 && doorSkipsSteel(look.fit, doorSlot)) return;
      const top = zi === 2 ? rearTop : sp.belt;
      if (hulk && zi === 2 && hulkGone(look.seed, 2, sx)) {
        // The quarter panel has burnt through above the sill: a ragged lower edge and the dark well behind it.
        b.rbox(x, sp.sill + 0.08, (a + c) / 2, 0.14, 0.16, Math.abs(a - c), 0.03, paint);
        b.rbox(sx * (hw - 0.22), (sp.sill + top) / 2, (a + c) / 2, 0.04, top - sp.sill, Math.abs(a - c), 0.02, dark);
        for (let i = 0; i < 5; i++) b.rbox(x, sp.sill + 0.17, a + ((c - a) * (i + 0.5)) / 5, 0.1, 0.05, 0.07, 0.01, paint, 0.6 * (i % 2 ? 1 : -1), 0, 0);
        return;
      }
      if (zi === 1) b.mark(partTag('door', sx), partMeta({ kind: 'door', side: sx as 1 | -1, pivot: [x, yc, Math.max(a, c)] }));
      b.rbox(x, (sp.sill + top) / 2, (a + c) / 2, 0.14, top - sp.sill, Math.abs(a - c), 0.04, paint);
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
    for (const [wi, wz] of [wf, wr].entries()) {
      const top = wi === 1 ? rearTop : sp.belt;
      const gone = hulk && wi === 0 && hulkGone(look.seed, 0, sx);
      if (gone) {
        // The wing has gone: the inner well, the strut and its spring stand bare.
        b.rbox(sx * (hw - 0.3), (archTop + sp.belt) / 2 - 0.06, wz, 0.04, sp.belt - archTop + 0.2, gap * 2, 0.02, dark);
        b.rod(sx * (wx - 0.16), R * 1.25, wz, sx * (hw - 0.34), sp.belt - 0.06, wz - 0.04, 0.03, S.steel(0x2a2c2e), 8);
        for (let i = 0; i < 5; i++) b.torus(sx * (wx - 0.16 + ((hw - 0.34 - wx + 0.16) * (i + 1)) / 6), R * 1.25 + ((sp.belt - 0.06 - R * 1.25) * (i + 1)) / 6, wz, 0.06, 0.01, S.rust(0x5a3a22), Math.PI / 2, 0, -sx * 0.6, 4, 10);
        continue;
      }
      // Fender above the arch, and the lip that rounds its opening.
      if (top - archTop > 0.02) b.rbox(x, (archTop + top) / 2, wz, 0.14, Math.max(0.05, top - archTop), gap * 2, 0.04, paint);
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
        lip,
        0,
        -Math.PI / 2,
        0,
      );
      if (t.body === 'hot') {
        // Bolted flares, the arch widened over the bigger wheels.
        b.extrude(
          `hotFlare:${R.toFixed(2)}`,
          () => {
            const s = new THREE.Shape();
            s.absarc(0, 0, R + 0.2, 0.1, Math.PI - 0.1, false);
            s.absarc(0, 0, R + 0.1, Math.PI - 0.1, 0.1, true);
            s.closePath();
            return s;
          },
          0.07,
          0.012,
          sx * (hw + 0.035),
          R,
          wz,
          lip,
          0,
          -Math.PI / 2,
          0,
        );
      }
    }
  }
}

/** The bonnet: a pressed panel, or vented, scooped or armoured. With it off, `addKit` draws the bay. */
function bonnet(b: MeshBuilder, sp: Spec, paint: Paint, look: VehicleLook, thick: number, tilt: number, t: CarTrim) {
  const part = bodyPart(look.fit, 'hood');
  if (part?.off) return;
  const nose = sp.L / 2;
  const armored = part?.id === 'hood_armor';
  const pan = armored ? S.steel(0x5a5d60, 0.8) : paint;
  // The bonnet hinges at the cowl and swings up (`Bodywork` poses it when someone opens it).
  b.mark(PANEL_TAG.hood, partMeta({ kind: 'hood', pivot: [0, sp.hood - 0.04, sp.wsBase] }));
  b.rbox(0, sp.hood - 0.04, (nose + sp.wsBase) / 2 - 0.02, sp.W - 0.1, thick + (armored ? 0.03 : 0), nose - sp.wsBase - 0.04, 0.05, pan, tilt, 0, 0);
  // A hot hatch's factory bonnet has two vents over the turbo.
  if (t.body === 'hot' && (!part || part.stock)) {
    for (const sx of [1, -1]) b.rbox(sx * 0.22, sp.hood + 0.015, (nose + sp.wsBase) / 2 + 0.05, 0.22, 0.02, 0.32, 0.008, S.plastic(0x0c0c0c, 0.4), tilt, 0, 0);
  }
  // A dent in the bonnet on some.
  if (look.seed % 4 === 0 && !armored) {
    const r = rnd(look.seed + 77);
    b.rbox((r() - 0.5) * 0.6, sp.hood + 0.004, sp.L / 2 - 0.9, 0.5, 0.012, 0.4, 0.004, paint, 0.05, 0.3, 0.03);
  }
  b.end();
}

/**
 * Doors: seam lines and handles at `seams` (z, front to back) with a handle behind each listed in `handles`, and the
 * mirrors. A three-door has one long door, a five-door two.
 */
function doors(b: MeshBuilder, sp: Spec, seams: number[], handles: number[], fit: Fit, t: CarTrim) {
  const hw = sp.W / 2;
  const seam = S.plastic(0x0e0e0e, 0.3);
  const mirror = t.mirrors === 'chrome' ? S.chrome(0xb4b8bc) : S.plastic(0x1a1a1a, 0.4);
  for (const sx of [1, -1]) {
    // No door, no seams, handles or mirror.
    if (panelOff(fit, sx > 0 ? 'doorL' : 'doorR')) continue;
    const x = sx * (hw + 0.004);
    b.mark(partTag('door', sx), partMeta({ kind: 'door', side: sx as 1 | -1 }));
    for (const z of seams) b.box(x, (sp.sill + sp.belt) / 2 + 0.04, z, 0.006, sp.belt - sp.sill - 0.12, 0.01, seam);
    for (const z of handles) b.box(x + sx * 0.012, sp.belt - 0.12, z, 0.02, 0.025, 0.16, S.chrome(0xb4b8bc));
    b.end();
    // Mirror on a stalk.
    b.mark(partTag('mirror', sx), partMeta({ kind: 'mirror', side: sx as 1 | -1, pivot: [sx * (hw - 0.04), sp.belt + 0.02, sp.wsBase + 0.04] }));
    b.rod(sx * (hw - 0.04), sp.belt + 0.02, sp.wsBase + 0.04, sx * (hw + 0.1), sp.belt + 0.12, sp.wsBase + 0.1, 0.012, S.plastic(0x1a1a1a), 6);
    if (sp.id === 'van' || sp.id === 'pickup') {
      // A tall commercial mirror.
      b.rbox(sx * (hw + 0.13), sp.belt + 0.2, sp.wsBase + 0.12, 0.05, 0.26, 0.16, 0.02, mirror);
    } else b.rbox(sx * (hw + 0.12), sp.belt + 0.14, sp.wsBase + 0.12, 0.05, 0.14, 0.2, 0.02, mirror);
    b.end();
  }
}

/** A sloped window glass drawn into the shell, flush in its frame: for the glass of a body variant that has no pane of its own. */
const shellGlass = () => S.glass(0x10171c);

// ------------------------------------------------------------------ the four bodies

function hatchBody(b: MeshBuilder, sp: Spec, paint: Paint, roofMat: Paint, d: VehicleDef, look: VehicleLook, t: CarTrim) {
  const hw = sp.W / 2;
  const nose = sp.L / 2;
  // Bonnet and cowl.
  bonnet(b, sp, paint, look, 0.1, -0.02, t);
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
  if (t.body === 'hot') {
    // A roof spoiler over the rear glass, on the tailgate so it lifts with it.
    b.rbox(0, sp.roof - 0.005, sp.rwTop - 0.1, sp.W - 0.34, 0.035, 0.2, 0.012, paint, -0.22, 0, 0);
    for (const sx of [1, -1]) b.rbox(sx * (hw - 0.19), sp.roof - 0.03, sp.rwTop - 0.12, 0.025, 0.07, 0.18, 0.008, paint);
  }
  b.end();
  for (const sx of [1, -1]) {
    const xo = sx * (hw - 0.08);
    // A-pillar
    b.rod(xo, sp.belt, sp.wsBase, xo - sx * 0.05, sp.roof, sp.wsTop, 0.03, paint, 6);
    // B-pillar (a three-door's is the thick one at the end of its long door)
    b.rod(xo, sp.belt, -0.3, xo - sx * 0.04, sp.roof, -0.3, t.body === 'hatch5' ? 0.032 : 0.04, paint, 6);
    // Rear cabin post at the C-pillar supporting the roof corner when tailgate is open
    b.rod(xo, sp.belt + 0.02, sp.rwTop, xo - sx * 0.04, sp.roof, sp.rwTop, 0.034, paint, 6);
    // Flank waist rail under the side windows
    b.rbox(sx * (hw - 0.07), sp.belt + 0.02, (sp.wsBase + sp.rwTop) / 2, 0.06, 0.06, sp.wsBase - sp.rwTop, 0.02, paint);
  }
  if (t.body === 'hatch5') doors(b, sp, [0.55, 0.0, -0.55], [0.39, -0.16], look.fit, t);
  else doors(b, sp, [0.55, -0.42], [-0.27], look.fit, t);
  if (t.body === 'hot') {
    const z = flankZones(sp, d);
    // Side skirts between the arches, a splitter under the nose, and twin tailpipes when the exhaust is the factory one.
    for (const sx of [1, -1]) b.rbox(sx * (hw + 0.012), sp.sill + 0.03, (z.door[0] + z.door[1]) / 2, 0.05, 0.08, Math.abs(z.door[0] - z.door[1]) - 0.06, 0.02, paint);
    b.box(0, 0.25, nose + 0.1, sp.W - 0.24, 0.02, 0.14, S.plastic(0x141414, 0.4));
    const exh = look.fit.exhaust ? partDef(look.fit.exhaust.id) : null;
    if (!exh || exh.stock) for (const dx of [-0.07, 0.07]) b.cyl(hw * 0.45 + dx, 0.25, -nose - 0.03, 0.075, 0.16, 0.075, S.chrome(0xc4c8cc), Math.PI / 2, 0, 0, 12);
  }
}

/** Can this sedan be drawn as an estate? Not with a box or a wing on its boot lid: they would stand inside the load bay. */
const estateOk = (fit: Fit) => fit.rear?.id !== 'rr_box' && fit.rear?.id !== 'rr_wing';

function sedanBody(b: MeshBuilder, sp: Spec, paint: Paint, roofMat: Paint, d: VehicleDef, look: VehicleLook, t: CarTrim) {
  const hw = sp.W / 2;
  const nose = sp.L / 2;
  const estate = t.body === 'estate' && estateOk(look.fit);
  bonnet(b, sp, paint, look, 0.1, -0.02, t);
  const zTail = -nose + 0.2;
  if (estate) {
    // The roof runs on to the tail over a load bay; its quarter glass and the tailgate's glass are tinted dark.
    b.rbox(0, sp.roof + 0.015, (sp.wsTop + zTail) / 2, sp.W - 0.24, 0.07, sp.wsTop - zTail + 0.04, 0.04, roofMat);
    b.mark(PANEL_TAG.trunk, partMeta({ kind: 'trunk', pivot: [0, sp.roof + 0.02, zTail] }));
    const h = sp.roof - sp.belt;
    b.rbox(0, sp.belt + h / 2, zTail + 0.02, sp.W - 0.14, h, 0.06, 0.02, paint, 0.06, 0, 0);
    b.box(0, sp.belt + h * 0.58, zTail - 0.02, sp.W - 0.46, h * 0.62, 0.012, shellGlass(), 0.06, 0, 0);
    b.box(0, sp.belt - 0.02, zTail - 0.02, 0.22, 0.03, 0.03, S.chrome(0xb4b8bc));
    b.end();
    for (const sx of [1, -1]) {
      const xo = sx * (hw - 0.08);
      b.rod(xo, sp.belt, sp.wsBase, xo - sx * 0.05, sp.roof, sp.wsTop, 0.03, paint, 6);
      b.rod(xo, sp.belt, -0.34, xo - sx * 0.04, sp.roof, -0.34, 0.034, paint, 6);
      // C and D pillars, and the quarter glass between them.
      b.rod(xo, sp.belt, sp.rwTop - 0.06, xo - sx * 0.04, sp.roof, sp.rwTop - 0.06, 0.04, paint, 6);
      b.rod(xo, sp.belt, zTail + 0.06, xo - sx * 0.04, sp.roof, zTail + 0.06, 0.05, paint, 6);
      b.box(sx * (hw - 0.07), sp.belt + h * 0.48, (sp.rwTop - 0.06 + zTail + 0.06) / 2, 0.012, h * 0.78, Math.abs(sp.rwTop - zTail - 0.12) - 0.08, shellGlass());
      b.rbox(sx * (hw - 0.07), sp.belt + 0.02, (sp.wsBase + zTail) / 2, 0.06, 0.06, sp.wsBase - zTail, 0.02, paint);
    }
  } else {
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
  }
  doors(b, sp, [0.62, 0.17, -0.28], [0.46, 0.01], look.fit, t);
  if (t.body === 'patrol') {
    // A spotlight on the driver's A-pillar.
    b.cyl(hw - 0.02, sp.belt + 0.1, sp.wsBase - 0.02, 0.025, 0.12, 0.025, S.steel(0x1a1a1a), 0, 0, 0, 6);
    b.cyl(hw - 0.02, sp.belt + 0.18, sp.wsBase + 0.02, 0.12, 0.1, 0.12, S.chrome(0xc4c8cc), Math.PI / 2, 0, 0, 12);
  }
}

function pickupBody(b: MeshBuilder, sp: Spec, paint: Paint, roofMat: Paint, d: VehicleDef, rust: ReturnType<typeof S.rust>, look: VehicleLook, t: CarTrim) {
  const hw = sp.W / 2;
  const nose = sp.L / 2;
  bonnet(b, sp, paint, look, 0.12, -0.02, t);
  b.rbox(0, sp.roof + 0.015, (sp.wsTop + sp.rwTop) / 2 + 0.02, sp.W - 0.22, 0.08, sp.wsTop - sp.rwTop + 0.12, 0.04, roofMat);
  // Cab back wall with a small rear window.
  b.rbox(0, (sp.belt + sp.roof) / 2 - 0.1, sp.rwBase - 0.04, sp.W - 0.16, sp.roof - sp.belt - 0.2, 0.08, 0.03, paint);
  for (const sx of [1, -1]) {
    const xo = sx * (hw - 0.08);
    b.rod(xo, sp.belt, sp.wsBase, xo - sx * 0.05, sp.roof, sp.wsTop, 0.034, paint, 6);
    b.rod(xo, sp.belt, sp.rwBase, xo - sx * 0.04, sp.roof, sp.rwBase, 0.04, paint, 6);
  }
  // Bed: floor, walls, tailgate; a flatbed is a deck on stake posts with a cab guard.
  const floor = 0.9;
  const zf = sp.rwBase - 0.1;
  const zr = -nose + 0.06;
  const steel = S.steel(0x4a4c4e, 0.9);
  const tube = S.steel(0x26282a, 0.65);
  if (t.body === 'flatbed') {
    b.box(0, floor - 0.035, (zf + zr) / 2, sp.W - 0.02, 0.07, zf - zr + 0.04, steel);
    for (let i = 0; i < 9; i++) b.box(-0.8 + i * 0.2, floor + 0.002, (zf + zr) / 2, 0.03, 0.006, zf - zr - 0.06, S.steel(0x5a5d60, 0.8));
    for (const sx of [1, -1]) {
      // Stake pockets and a low rail on posts down each side.
      const n = 4;
      for (let i = 0; i < n; i++) {
        const z = zf - 0.12 - (i / (n - 1)) * (zf - zr - 0.24);
        b.box(sx * (hw - 0.03), floor - 0.04, z, 0.05, 0.08, 0.07, S.steel(0x2a2c2e));
        b.rod(sx * (hw - 0.03), floor, z, sx * (hw - 0.03), floor + 0.3, z, 0.016, tube, 6);
      }
      b.rod(sx * (hw - 0.03), floor + 0.3, zf - 0.12, sx * (hw - 0.03), floor + 0.3, zr + 0.12, 0.016, tube, 6);
    }
    // Cab guard: a tube frame with bars, the height of the cab.
    for (const sx of [1, -1]) b.rod(sx * (hw - 0.12), floor, zf - 0.03, sx * (hw - 0.12), sp.roof - 0.02, zf - 0.03, 0.025, tube, 8);
    b.rod(-(hw - 0.12), sp.roof - 0.02, zf - 0.03, hw - 0.12, sp.roof - 0.02, zf - 0.03, 0.025, tube, 8);
    for (let i = 0; i < 7; i++) {
      const x = -(hw - 0.2) + (i / 6) * (hw - 0.2) * 2;
      b.rod(x, floor, zf - 0.03, x, sp.roof - 0.02, zf - 0.03, 0.008, tube, 6);
    }
    // Light steel tyre guards over the rear wheels under the deck edge.
    const R = d.physics.wheelRadius;
    for (const sx of [1, -1]) b.rbox(sx * (hw - 0.14), floor - 0.09, d.physics.wheelsZ[1], 0.3, 0.02, R * 2.2, 0.01, S.steel(0x2a2c2e, 0.7));
  } else {
    b.box(0, floor - 0.04, (zf + zr) / 2, sp.W - 0.2, 0.06, zf - zr, steel);
    for (let i = 0; i < 7; i++) b.box(-0.7 + i * 0.233, floor - 0.005, (zf + zr) / 2, 0.05, 0.02, zf - zr - 0.06, S.steel(0x3a3c3e, 0.9));
    for (const sx of [1, -1]) {
      b.rbox(sx * (hw - 0.07), (floor + 1.2) / 2 - 0.04, (zf + zr) / 2, 0.12, 1.2 - floor + 0.04, zf - zr, 0.03, sx > 0 ? paint : rust);
      b.rbox(sx * (hw - 0.07), 1.2, (zf + zr) / 2, 0.16, 0.05, zf - zr, 0.02, S.steel(0x5a5d60, 0.7));
    }
    b.rbox(0, (floor + 1.18) / 2, zr, sp.W - 0.12, 1.18 - floor, 0.08, 0.03, paint);
    b.rbox(0, (floor + 1.12) / 2, zf, sp.W - 0.12, 1.12 - floor + 0.1, 0.08, 0.03, paint);
    if (t.body === 'tilt') {
      // Tilt bows over the bed with the canvas rolled up against the cab, tied off.
      const canvas = S.cloth(0x6e6448, 0.85);
      for (const z of [zf - 0.12, (zf + zr) / 2, zr + 0.12]) {
        b.pipe([[hw - 0.07, 1.2, z], [hw - 0.12, 1.72, z], [hw - 0.3, 1.82, z], [-(hw - 0.3), 1.82, z], [-(hw - 0.12), 1.72, z], [-(hw - 0.07), 1.2, z]], 0.018, tube, 6);
      }
      b.capsule(-(hw - 0.2), 1.86, zf - 0.2, hw - 0.2, 1.86, zf - 0.2, 0.1, canvas, 10);
      for (const x of [-(hw - 0.5), hw - 0.5]) b.torus(x, 1.86, zf - 0.2, 0.105, 0.012, S.cloth(0xd6a21e, 0.6), 0, Math.PI / 2, 0, 4, 12);
    } else if (t.body === 'work') {
      // A headache rack behind the cab with two work lamps, and a ladder rack over the bed.
      const top = sp.roof + 0.1;
      for (const sx of [1, -1]) b.rod(sx * (hw - 0.07), 1.2, zf - 0.08, sx * (hw - 0.07), top, zf - 0.08, 0.026, tube, 8);
      b.rod(-(hw - 0.07), top, zf - 0.08, hw - 0.07, top, zf - 0.08, 0.026, tube, 8);
      for (let i = 0; i < 6; i++) {
        const x = -(hw - 0.2) + (i / 5) * (hw - 0.2) * 2;
        b.rod(x, 1.2, zf - 0.08, x, top, zf - 0.08, 0.01, tube, 6);
      }
      for (const sx of [1, -1]) {
        b.rbox(sx * 0.3, top + 0.08, zf - 0.08, 0.16, 0.1, 0.08, 0.02, S.plastic(0x1a1a1a));
        b.box(sx * 0.3, top + 0.08, zf - 0.125, 0.13, 0.07, 0.008, S.glass(0x8a8a7a));
      }
      for (const sx of [1, -1]) {
        b.rod(sx * (hw - 0.07), 1.2, zr + 0.1, sx * (hw - 0.07), top - 0.12, zr + 0.1, 0.022, tube, 8);
        b.rod(sx * (hw - 0.07), top - 0.12, zf - 0.08, sx * (hw - 0.07), top - 0.12, zr + 0.1, 0.022, tube, 8);
      }
      b.rod(-(hw - 0.07), top - 0.12, zr + 0.1, hw - 0.07, top - 0.12, zr + 0.1, 0.022, tube, 8);
    }
  }
  doors(b, sp, [0.9, -0.22], [-0.06], look.fit, t);
}

function vanBody(b: MeshBuilder, sp: Spec, paint: Paint, roofMat: Paint, d: VehicleDef, rust: ReturnType<typeof S.rust>, look: VehicleLook, t: CarTrim) {
  const hw = sp.W / 2;
  const nose = sp.L / 2;
  // Short bonnet and a tall box behind the cab.
  bonnet(b, sp, paint, look, 0.12, -0.03, t);
  // Cargo box: solid sides and roof from behind the cab to the tail.
  const zf = sp.rwBase;
  const zr = -nose + 0.06;
  const boxX = hw - 0.03;
  b.rbox(0, (sp.belt + sp.roof) / 2, (zf + zr) / 2, sp.W - 0.06, sp.roof - sp.belt + 0.1, zf - zr, 0.08, paint);
  // Cab roof, dropping from the box to the windscreen header.
  b.rbox(0, sp.roof - 0.1, (sp.wsTop + zf) / 2 + 0.02, sp.W - 0.16, 0.08, sp.wsTop - zf + 0.12, 0.04, roofMat);
  b.rbox(0, sp.roof + 0.04, (zf + zr) / 2, sp.W - 0.12, 0.06, zf - zr - 0.02, 0.04, roofMat);
  const glass = shellGlass();
  const rubber = S.rubber(0x141414);
  for (const sx of [1, -1]) {
    const xo = sx * (hw - 0.08);
    b.rod(xo, sp.belt, sp.wsBase, xo - sx * 0.05, sp.roof - 0.1, sp.wsTop, 0.036, paint, 6);
    // Sliding door seam on the box.
    b.box(sx * (boxX + 0.003), (sp.belt + sp.roof) / 2, -0.6, 0.006, sp.roof - sp.belt - 0.2, 0.012, S.plastic(0x0e0e0e, 0.3));
    if (t.body === 'windowed') {
      // Two windows down each side of the box, in rubber.
      for (const [z0, z1] of [[0.32, -0.5], [-0.72, -2.2]] as [number, number][]) {
        const zc = (z0 + z1) / 2;
        const y0 = sp.belt + 0.14;
        const y1 = sp.roof - 0.22;
        b.box(sx * (boxX + 0.004), (y0 + y1) / 2, zc, 0.008, y1 - y0 + 0.05, Math.abs(z0 - z1) + 0.05, rubber);
        b.box(sx * (boxX + 0.007), (y0 + y1) / 2, zc, 0.006, y1 - y0, Math.abs(z0 - z1), glass);
      }
    } else if (t.body === 'ambulance') {
      // A white box, a red stripe round it and a cross on each side.
      b.box(sx * (boxX + 0.003), (sp.belt + sp.roof) / 2, (zf + zr) / 2 - 0.02, 0.004, sp.roof - sp.belt - 0.06, zf - zr - 0.12, S.paint(t.second, 0.4));
      b.box(sx * (boxX + 0.006), sp.belt + 0.32, (zf + zr) / 2 - 0.02, 0.004, 0.16, zf - zr - 0.12, S.paint(0xc8321e, 0.4));
      const cz = (zf + zr) / 2 - 0.3;
      const cy = sp.belt + 0.85;
      b.box(sx * (boxX + 0.008), cy, cz, 0.004, 0.5, 0.16, S.paint(0xc8321e, 0.4));
      b.box(sx * (boxX + 0.009), cy, cz, 0.004, 0.16, 0.5, S.paint(0xc8321e, 0.4));
    } else if (t.body === 'utility') {
      // A ladder racked along the left side of the box on stand-offs.
      if (sx > 0) {
        const lx = boxX + 0.07;
        const y0 = sp.belt + 0.4;
        const y1 = sp.belt + 0.78;
        const steel = S.metal(0xa8acb0, 0.4);
        for (const y of [y0, y1]) b.rod(lx, y, 0.3, lx, y, -2.3, 0.018, steel, 6);
        for (let i = 0; i < 9; i++) b.rod(lx, y0, 0.2 - i * 0.3, lx, y1, 0.2 - i * 0.3, 0.012, steel, 6);
        for (const z of [0.1, -1.1, -2.2]) b.box(boxX + 0.035, (y0 + y1) / 2, z, 0.07, y1 - y0 + 0.08, 0.04, S.steel(0x2a2c2e));
      }
    } else {
      // A faded company stripe on the box.
      b.box(sx * (boxX + 0.004), sp.belt + 0.7, -1.4, 0.006, 0.18, 2.2, S.paint(0xe9dfc7, 0.8));
    }
    b.rbox(sx * (boxX + 0.004), sp.belt + 0.28, -1.7, 0.012, 0.3, 1.2, 0.004, rust);
  }
  b.box(0, (sp.belt + sp.roof) / 2, zr - 0.005, 0.02, sp.roof - sp.belt - 0.2, 0.012, S.plastic(0x0e0e0e, 0.3));
  // The rear door lifts on a hinge along the roof; the opening behind it is a dark cargo bay.
  const yMid = (sp.belt + sp.roof) / 2;
  const doorH = sp.roof - sp.belt - 0.04;
  b.rbox(0, yMid, zr - 0.006, sp.W - 0.34, doorH - 0.16, 0.012, 0.004, S.metal(0x0e0e0e, 0.2));
  b.mark(PANEL_TAG.trunk, partMeta({ kind: 'trunk', pivot: [0, sp.roof + 0.03, zr] }));
  b.rbox(0, yMid + 0.02, zr - 0.012, sp.W - 0.12, doorH, 0.034, 0.012, paint);
  b.box(0, yMid - 0.1, zr - 0.034, 0.16, 0.03, 0.012, S.chrome(0xb4b8bc));
  if (t.body === 'windowed' || t.body === 'ambulance') {
    for (const sx of [1, -1]) b.box(sx * 0.4, yMid + 0.35, zr - 0.032, 0.6, 0.42, 0.008, glass);
  }
  if (t.body === 'ambulance') {
    b.box(0, yMid - 0.25, zr - 0.033, 0.4, 0.12, 0.006, S.paint(0xc8321e, 0.4));
    b.box(0, yMid - 0.25, zr - 0.034, 0.12, 0.4, 0.006, S.paint(0xc8321e, 0.4));
  }
  b.end();
  if (t.body === 'utility' && !look.fit.roof) {
    // An amber beacon on the front of the roof.
    b.cyl(-(hw - 0.35), sp.roof - 0.02, sp.wsTop - 0.25, 0.14, 0.04, 0.14, S.plastic(0x1a1a1a), 0, 0, 0, 12);
    b.cyl(-(hw - 0.35), sp.roof + 0.05, sp.wsTop - 0.25, 0.12, 0.1, 0.12, S.plastic(0xe08a1a, 0.25), 0, 0, 0, 12);
  }
  doors(b, sp, [1.24, 0.52], [0.68], look.fit, t);
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
  const tailsOut: Shell['tails'] = [];
  let muzzle: Shell['muzzle'] = null;
  const b = new MeshBuilder();
  b.jitter = 0.03;
  b.roundSeg = 2;
  b.seed(look.seed + 5);
  const rig: Rig = {
    lamp: (x, y, z, r, bucket = true, w, h) => {
      lamps.push({ x, y: y - g0, z, r, bucket, w, h });
      if (bucket && !w) {
        b.frustum(x, y, z - r * 0.45, r * 1.12, r * 0.7, r * 0.9, S.chrome(0xc8ccd0), Math.PI / 2, 0, 0, 16);
        b.torus(x, y, z, r * 1.08, r * 0.1, S.chrome(), 0, 0, 0, 6, 20);
      }
    },
    tail: (x, y, z, w, h, amber) => tailsOut.push({ x, y: y - g0, z, w, h, amber }),
    muzzle: (x, y, z) => {
      muzzle = [x, y - g0, z];
    },
  };
  const t = look.trim ?? baseTrim(sp.id);
  const hulk = !!look.hulk;
  const wear = Math.min(1, look.wear + schemeWear(look.trim ?? null));
  const paintHex = bodyColor(look.paint, look.trim ?? null);
  const paint = S.paint(paintHex, wear);
  const roofMat = look.stripe === 2 ? S.paint(look.stripeColor, wear) : t.scheme === 'twoTone' && t.tone === 'roof' ? S.paint(t.second, Math.max(0.2, wear - 0.1)) : paint;
  const rust = S.rust(0x7a3f22);
  const c: TrimCtx = { b, rig, sp, def, fit: look.fit, t, paint, paintHex, wear, seed: look.seed, hulk, panels: look.panels };
  lowerBody(b, sp, def, paint, look, t, paintHex);
  bumpers(c);
  yield;
  if (sp.id === 'hatch') hatchBody(b, sp, paint, roofMat, def, look, t);
  else if (sp.id === 'sedan') sedanBody(b, sp, paint, roofMat, def, look, t);
  else if (sp.id === 'pickup') pickupBody(b, sp, paint, roofMat, def, rust, look, t);
  else vanBody(b, sp, paint, roofMat, def, rust, look, t);
  yield;
  frontEnd(c);
  tails(c);
  rustBlooms(c);
  toneBands(c);
  taxiChecker(c);
  yield;
  const nativeGun = false;
  const wpnPart = look.fit.weapon;
  const m = mountsFor(sp, def.physics.wheelRadius);
  // A pickup's gun is the pivoting bed gun built on the visual, not a fixed one.
  const fixedGun = !!wpnPart && def.weaponMount === 'front';
  const wheels = wheelXZ(def).map(([x, z]) => [x, z] as [number, number]);
  // The kit's own painted bits (a bonnet bulge, a scoop, a wing) take the paint as it is on this car, faded or not.
  addKit(b, rig, fixedGun ? m : { ...m, gun: undefined }, { ...look, paint: paintHex, wear }, { nativeGun, wheels, bayFloor: sp.belt - 0.03 });
  extras(c, m);
  roofTop(c, m);
  stencils(c);
  raiderKit(c);
  paintPanels(b, paintHex, look.panels, m);
  schemePanels(c, m);
  b.groundShade(0.0, 0.5, 0.35);
  yield;
  const geo = b.build();
  geo.translate(0, -g0, 0);
  // The body was built on the ground and is shifted to the chassis centre: the joints move with it.
  for (const r of (geo.userData.parts ?? []) as PartRange[]) if (r.meta.pivot) r.meta = { ...r.meta, pivot: [r.meta.pivot[0], r.meta.pivot[1] - g0, r.meta.pivot[2]] };
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return { geo, lamps, tails: tailsOut, muzzle };
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

/** The shell's cache key: chassis, paint, the parts that show on the body, the panel colours, the trim and the burn. */
export function shellKey(def: VehicleDef, look: VehicleLook): string {
  return `${def.id}|${look.paint}|${look.stripe}|${look.stripeColor}|${look.seed}|${Math.round(look.wear * 10)}|${bodySignature(look.fit)}|${panelSignature(look.panels)}|${trimKey(look.trim)}|${look.hulk ? 'H' : ''}`;
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
  for (const l of shell.lamps) headlamp(v, new MeshBuilder(), l.x, l.y, l.z, l.r, false, l.w, l.h);
  for (const t of shell.tails) taillight(v, t.x, t.y, t.z, t.w, t.h, t.amber);
  if (shell.muzzle) v.muzzle.position.set(...shell.muzzle);
  v.setHeadlights = (on: boolean) => {
    for (const h of v.headlights) h.material = on ? lampOn : lampOff;
  };
  addWheelSet(v, def, wheelLocal, steered, wheelSpecs(def, look.tyres, look.brakeMk ?? 0, look.trim ?? undefined));
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
  applyRideLift(v, look.lift ?? 0);
  return v;
}
