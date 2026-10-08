import * as THREE from 'three';
import { MeshBuilder, S, type Surf } from './builder';
import { isInteriorSlot, partDef, type VehicleDef } from '../data';
import { addKit, type Mounts, type Rig } from './attachments';
import { PANEL_TAG, partMeta, partTag, type PartRange } from './bodyParts';
import { acquireShell, hasShell, releaseShell, type Shell } from './shellCache';
import { addWheelSet, blank, bodyMat, headlamp, lightMat, lightOffMat, rider, taillight, wheelSpecs, type VehicleVisual } from './vehicleKit';
import { restHeight } from './carSpecs';
import { attachBay } from './bayMesh';
import { paintPanels } from './paintJob';
import { panelSignature } from '../sim/paint';
import { trimKey, type CarTrim } from '../sim/carTrim';
import { heavyGun, jerryCan, plate, rivets, spareTyre, strap } from './parts';
import { CABIN_FILL, seatOccupant, type CabinLayout } from './interior';
import type { VehicleLook } from './vehicleModels';
import { applyRideLift } from './rideHeight';
import { bodyColor, drawMark, rnd, schemeWear, sprayText, type Plane } from './carTrimKit';
import { shared } from './dispose';

/**
 * The two heavy chassis. The war truck is an ex-military 6x6: a long bonnet between flat-topped wings, a square cab with a
 * split screen behind a bar guard, a ladder frame on leaf-sprung beam axles, and a bed over the rear tandem with a gunner's
 * platform and a ring mount at its head, so the native heavy MG fires over the cab. Its bed is a drop-side, a tilt with
 * the canvas rolled up on its bows, or a gun truck's armoured box. The war rig is a twin-steer conventional tractor with a
 * long chrome-grilled nose, a day or sleeper cab and twin stacks, coupled for good to a trailer: a fuel tanker, a hauler
 * with a container, or a scavenger's flatbed stacked with crushed wrecks; a gunner's platform with twin autocannons stands
 * between the cab and the load, and every variant has the same rear deck for cargo.
 *
 * Built like the found cars: in a ground frame (y = 0 is the road) and shifted down by `restHeight`, in slices so a spawn
 * can be prepared ahead, cached by look. Mount points are the same for every variant of a chassis, so car work, cargo and
 * the bolt-on kit see one truck.
 */

// ---------------------------------------------------------------- mount points

/** The war truck's mount points, in its ground frame. */
export const TRUCK_MOUNTS: Mounts = {
  hw: 1.1,
  front: { z: 2.9, y: 0.8, hw: 1.2 },
  rear: { z: -2.88, y: 1.02, hw: 1.15 },
  hood: { y: 2.0, z0: 1.36, z1: 2.62, hw: 0.72 },
  roof: { y: 2.66, z0: 0.04, z1: 1.06, hw: 0.95 },
  trunk: { y: 1.33, z0: -2.74, z1: -1.4, hw: 1.15 },
  side: { y0: 1.3, y1: 1.95, z0: 0.14, z1: 1.1 },
  sill: 1.2,
  gun: { x: 0, y: 3.08, z: -0.9 },
  wheelR: 0.55,
  bayFloor: 1.3,
};

/** The war rig's mount points, in its ground frame. */
export const RIG_MOUNTS: Mounts = {
  hw: 1.22,
  front: { z: 4.66, y: 1.0, hw: 1.5 },
  rear: { z: -4.58, y: 1.36, hw: 1.45 },
  hood: { y: 2.56, z0: 3.08, z1: 4.36, hw: 0.84 },
  roof: { y: 3.4, z0: 1.7, z1: 2.82, hw: 1.0 },
  trunk: { y: 1.86, z0: -4.44, z1: -3.1, hw: 1.42 },
  side: { y0: 1.86, y1: 2.6, z0: 1.72, z1: 2.82 },
  sill: 1.76,
  gun: { x: 0, y: 3.92, z: 0.38 },
  wheelR: 0.7,
  bayFloor: 1.66,
};

/** Is this one of the heavy chassis drawn here? */
export const isHeavy = (id: string) => id === 'truck' || id === 'rig';

/** Mounts of a heavy chassis and the offset down to its chassis frame. */
export function heavyMounts(def: VehicleDef): { m: Mounts; g0: number } | null {
  if (def.id === 'truck') return { m: TRUCK_MOUNTS, g0: restHeight(def) };
  if (def.id === 'rig') return { m: RIG_MOUNTS, g0: restHeight(def) };
  return null;
}

// ---------------------------------------------------------------- shared heavy hardware

type V3 = [number, number, number];

interface Mats {
  paint: Surf;
  paintHex: number;
  dark: Surf;
  frame: Surf;
  steel: Surf;
  rust: Surf;
  chrome: Surf;
  rubber: Surf;
  glass: Surf;
  cab: Surf;
}

/** A ladder frame: two channel rails and crossmembers, with the rails' flanges picked out. */
function ladder(b: MeshBuilder, x: number, y0: number, y1: number, z0: number, z1: number, m: Mats, cross: number[]) {
  const h = y1 - y0;
  for (const sx of [1, -1]) {
    b.box(sx * x, (y0 + y1) / 2, (z0 + z1) / 2, 0.08, h, z1 - z0, m.frame);
    for (const y of [y0 + 0.012, y1 - 0.012]) b.box(sx * (x - 0.05), y, (z0 + z1) / 2, 0.1, 0.024, z1 - z0, m.frame);
  }
  for (const z of cross) b.box(0, (y0 + y1) / 2, z, x * 2, h * 0.7, 0.08, m.frame);
}

/** A beam axle with its differential, leaf springs on U-bolts to the frame, and an angled shock each side. */
function beamAxle(b: MeshBuilder, z: number, R: number, wx: number, frameX: number, frameY: number, m: Mats, steer: boolean) {
  b.cyl(0, R, z, 0.16, wx * 2 - 0.36, 0.16, m.dark, 0, 0, Math.PI / 2, 10);
  if (!steer) {
    b.sphereAt(0, R, z, 0.2, m.dark, false);
    b.cyl(0, R, z + 0.18, 0.12, 0.2, 0.12, m.dark, Math.PI / 2, 0, 0, 10);
  }
  for (const sx of [1, -1]) {
    // The leaf pack: four leaves stepping shorter, the top one curling into eyes at the hangers.
    const x = sx * frameX;
    const top = frameY - 0.02;
    for (let i = 0; i < 4; i++) {
      const len = 1.1 - i * 0.2;
      const y = R + 0.1 + (3 - i) * 0.03;
      b.box(x, Math.min(top - 0.03, y), z, 0.08, 0.025, len, m.steel);
    }
    for (const dz of [-0.55, 0.55]) b.box(x, (R + 0.2 + top) / 2, z + dz, 0.06, top - R - 0.2, 0.06, m.frame);
    for (const dx of [-0.05, 0.05]) b.rod(x + dx, R - 0.08, z, x + dx, R + 0.22, z, 0.012, m.steel, 6);
    b.rod(sx * (frameX + 0.12), R + 0.05, z - 0.2 * Math.sign(z || 1), sx * (frameX + 0.06), frameY + 0.1, z - 0.42 * Math.sign(z || 1), 0.035, m.dark, 8);
  }
  if (steer) {
    // Tie rod and drag link.
    b.rod(-wx + 0.25, R - 0.04, z - 0.2, wx - 0.25, R - 0.04, z - 0.2, 0.025, m.steel, 6);
    b.rod(frameX + 0.05, frameY - 0.05, z + 0.4, wx - 0.3, R + 0.05, z - 0.18, 0.022, m.steel, 6);
  }
}

/**
 * A square cab: floor, back wall with a small window, a roof with gutters, a split windscreen behind a bar guard, doors
 * with window openings (bars across them), the pillars, and inside a dash, two seats and the wheel. The seats and the
 * dash are lit a little so they do not read as a black hole through the openings.
 */
interface CabDims {
  x: number;
  floor: number;
  roof: number;
  /** Windscreen base (front wall, z) and its top, raked back by `rake`. */
  zF: number;
  belt: number;
  rake: number;
  zB: number;
  /** Door run along the flank (z, front to back). */
  door: [number, number];
  /** Driver's hip spot. */
  seat: V3;
}

function cab(b: MeshBuilder, c: CabDims, m: Mats, t: CarTrim) {
  const { x, floor, roof, zF, belt, rake, zB } = c;
  const zTop = zF - rake;
  const len = zF - zB;
  // Floor pan and back wall with its window.
  b.box(0, floor - 0.04, (zF + zB) / 2, x * 2, 0.08, len, m.dark);
  b.rbox(0, (floor + roof) / 2, zB + 0.03, x * 2, roof - floor, 0.06, 0.02, m.paint);
  b.box(0, belt + (roof - belt) * 0.45, zB - 0.004, x * 0.7, (roof - belt) * 0.4, 0.008, m.glass);
  // Roof, with rain gutters and a drip rail at the front.
  b.rbox(0, roof + 0.015, (zTop + zB) / 2 - 0.01, x * 2 + 0.06, 0.07, zTop - zB + 0.08, 0.03, m.paint);
  for (const sx of [1, -1]) b.box(sx * (x + 0.035), roof - 0.02, (zTop + zB) / 2, 0.025, 0.03, zTop - zB + 0.06, m.steel);
  b.box(0, roof - 0.03, zTop + 0.05, x * 2, 0.04, 0.03, m.steel);
  for (const sx of [1, -1] as const) {
    // Body side: the door (with its own skin, handle and hinges) and the panel behind it.
    const [d0, d1] = c.door;
    b.rbox(sx * (x - 0.03), (floor - 0.12 + belt) / 2, (d0 + d1) / 2, 0.06, belt - floor + 0.12, d0 - d1, 0.02, m.paint);
    if (d1 - zB > 0.05) b.rbox(sx * (x - 0.03), (floor - 0.12 + roof) / 2, (d1 + zB) / 2, 0.06, roof - floor + 0.12, d1 - zB, 0.02, m.paint);
    b.box(sx * (x + 0.002), belt - 0.12, d1 + 0.18, 0.02, 0.03, 0.16, m.chrome);
    for (const y of [floor + 0.15, belt - 0.15]) b.cyl(sx * (x + 0.01), y, d0 - 0.03, 0.04, 0.12, 0.04, m.steel, 0, 0, 0, 8);
    // Window frame: A pillar raked with the screen, the B post at the door's back edge, the sill rail.
    b.rod(sx * (x - 0.03), belt, zF, sx * (x - 0.03), roof, zTop, 0.04, m.paint, 6);
    b.rod(sx * (x - 0.03), belt, d1, sx * (x - 0.03), roof, d1, 0.035, m.paint, 6);
    b.rbox(sx * (x - 0.03), belt, (zF + d1) / 2, 0.07, 0.05, zF - d1, 0.015, m.paint);
    // Bars across the open window.
    for (let i = 1; i <= 3; i++) {
      const zz = d1 + ((zF - d1) * i) / 4;
      b.rod(sx * (x - 0.03), belt + 0.02, zz, sx * (x - 0.03), roof - 0.03, zz - rake * ((roof - belt) / (roof - belt)) * 0.3 * (i / 3), 0.009, m.dark, 4);
    }
  }
  // The split windscreen's frame: header, centre post, the cowl under it, and a bar guard over the glass line (no glass:
  // nothing opaque in the driver's view).
  b.rbox(0, belt - 0.02, zF + 0.02, x * 2, 0.08, 0.1, 0.02, m.paint);
  b.rod(0, belt, zF, 0, roof, zTop, 0.025, m.paint, 6);
  const P = (xx: number, f: number): V3 => [xx, belt + (roof - belt) * f, zF - rake * f + 0.06];
  for (let i = 0; i < 13; i++) {
    const xx = -x + 0.12 + (i / 12) * (x * 2 - 0.24);
    b.rod(...P(xx, 0.03), ...P(xx, 0.97), i % 3 === 0 ? 0.012 : 0.007, m.dark, 4);
  }
  for (const f of [0.03, 0.5, 0.97]) b.rod(...P(-x + 0.08, f), ...P(x - 0.08, f), 0.012, m.dark, 4);
  // Inside: dash, the wheel on its column, two seats and a bench for a third.
  const [sx0, sy0, sz0] = c.seat;
  b.rbox(0, belt - 0.12, zF - 0.22, x * 2 - 0.12, 0.22, 0.32, 0.03, m.cab);
  for (let i = 0; i < 4; i++) b.cyl(sx0 - 0.15 + i * 0.1, belt - 0.06, zF - 0.38, 0.07, 0.02, 0.07, S.glass(0x20262a), Math.PI / 2 - 0.4, 0, 0, 10);
  b.rod(sx0, belt - 0.15, zF - 0.3, sx0, sy0 + 0.4, sz0 + 0.42, 0.02, m.dark, 6);
  b.torus(sx0, sy0 + 0.42, sz0 + 0.42, 0.2, 0.018, m.dark, -0.95, 0, 0, 6, 18);
  for (const xx of [sx0, -sx0]) {
    b.rbox(xx, sy0 - 0.08, sz0 - 0.02, 0.5, 0.12, 0.48, 0.04, m.cab);
    b.rbox(xx, sy0 + 0.28, sz0 - 0.26, 0.5, 0.62, 0.1, 0.04, m.cab, -0.12, 0, 0);
  }
  b.rod(-0.05, floor, zF - 0.5, 0.05, floor + 0.55, zF - 0.62, 0.012, m.dark, 6);
  void t;
}

/** A tall west-coast mirror on a tube arm out from the A pillar. */
function mirrors(b: MeshBuilder, x: number, y: number, z: number, m: Mats) {
  for (const sx of [1, -1]) {
    b.pipe([[sx * (x - 0.02), y, z], [sx * (x + 0.22), y + 0.05, z + 0.05], [sx * (x + 0.24), y + 0.45, z + 0.05]], 0.016, m.steel, 6);
    b.rbox(sx * (x + 0.26), y + 0.25, z + 0.06, 0.06, 0.42, 0.2, 0.02, S.plastic(0x1a1a1a, 0.4));
    b.box(sx * (x + 0.26), y + 0.25, z + 0.06 - 0.105, 0.045, 0.38, 0.006, S.chrome(0xa8acb0));
  }
}

/** A vertical exhaust stack with a perforated heat shield and a rain flap. Returns the top. */
function stack(b: MeshBuilder, x: number, y0: number, y1: number, z: number, r: number, m: Mats): V3 {
  b.pipe([[x * 0.5, y0 - 0.15, z + 0.3], [x, y0, z], [x, y1, z]], r, m.chrome, 8);
  b.cyl(x, (y0 + y1) / 2 + 0.2, z, r * 3, (y1 - y0) * 0.45, r * 3, S.steel(0x8a8e92, 0.5), 0, 0, 0, 12);
  for (let i = 0; i < 5; i++) b.cyl(x, y0 + 0.4 + i * (y1 - y0) * 0.09, z, r * 3.08, 0.012, r * 3.08, S.steel(0x2a2c2e), 0, 0, 0, 12);
  b.cyl(x, y1 + 0.02, z - r * 0.4, r * 2.4, 0.01, r * 2.6, S.steel(0x2a2c2e, 0.8), 0.5, 0, 0, 10);
  return [x, y1, z];
}

/** Round headlamp in a bucket with a wire stone guard over it. */
function guardedLamp(b: MeshBuilder, rig: Rig, x: number, y: number, z: number, r: number, m: Mats) {
  rig.lamp(x, y, z, r, true);
  for (let i = -2; i <= 2; i++) b.rod(x + i * r * 0.42, y - r * 1.05, z + 0.06, x + i * r * 0.42, y + r * 1.05, z + 0.06, 0.005, m.dark, 4);
  b.torus(x, y, z + 0.06, r * 1.1, 0.008, m.dark, 0, 0, 0, 4, 18);
}

/** A cylindrical fuel or air tank on straps, axis along z. */
function tank(b: MeshBuilder, x: number, y: number, z: number, r: number, len: number, col: Surf, m: Mats) {
  b.cyl(x, y, z, r * 2, len, r * 2, col, Math.PI / 2, 0, 0, 16);
  for (const dz of [-len * 0.3, len * 0.3]) b.torus(x, y, z + dz, r + 0.006, 0.012, m.dark, 0, 0, 0, 4, 18);
  b.cyl(x, y + r, z + len * 0.25, 0.07, 0.04, 0.07, m.steel, 0, 0, 0, 8);
}

/** Paint a stencil on a flat panel facing `n`: a convoy number in a roundel, a mark, a word. */
function heavyStencil(b: MeshBuilder, t: CarTrim, pl: Plane, h: number, seed: number) {
  const r = rnd(seed + 404);
  const col = S.paint(t.stencilColor, 0.5);
  if (t.stencil === 'number') sprayText(b, pl, String(t.glyph), h, col, r, 0.006, 0.16);
  else if (t.stencil === 'mark' || t.stencil === 'tally') drawMark(b, pl, t.glyph, h * 1.2, col);
  else if (t.stencil === 'scrawl') sprayText(b, pl, ['KEEP OUT', 'NO GAS', 'HELP', 'DEAD', 'TAKEN'][t.glyph % 5], h * 0.45, col, r);
}

// ---------------------------------------------------------------- the war truck

function truckBody(b: MeshBuilder, rig: Rig, def: VehicleDef, look: VehicleLook, t: CarTrim, m: Mats) {
  const R = def.physics.wheelRadius;
  const wx = Math.abs(def.physics.wheelsX[0]);
  const [zA, zB, zC] = def.physics.wheelsZ;
  const fx = 0.5;
  const fy0 = 0.78;
  const fy1 = 0.98;
  ladder(b, fx, fy0, fy1, -2.82, 2.7, m, [2.6, 1.3, 0.6, -0.5, -1.4, -2.75]);
  beamAxle(b, zA, R, wx, fx, fy0, m, true);
  beamAxle(b, zB, R, wx, fx, fy0, m, false);
  beamAxle(b, zC, R, wx, fx, fy0, m, false);
  // Prop shafts down the middle.
  b.rod(0, 0.82, 1.4, 0, R + 0.06, zB + 0.2, 0.04, m.dark, 8);
  b.rod(0, R + 0.06, zB - 0.2, 0, R + 0.06, zC + 0.2, 0.04, m.dark, 8);
  b.rod(0, 0.85, 1.4, 0, R + 0.02, zA - 0.2, 0.035, m.dark, 8);
  // Front bumper with a winch and tow shackles (or a push bar), steps and tanks under the cab.
  const by = 0.8;
  const bz = 2.8;
  if (t.bumperF === 'bull' && !look.fit.front) {
    b.mark(partTag('bullbar'), partMeta({ kind: 'bullbar', pivot: [0, by, bz] }));
    plate(b, 0, by, bz + 0.05, 2.4, 0.3, 0.05, m.steel, 0, 0, 0, true);
    for (const sx of [1, -1]) b.pipe([[sx * 1.05, by + 0.1, bz + 0.1], [sx * 1.05, 1.55, bz + 0.12], [sx * 0.55, 1.75, bz + 0.05]], 0.05, m.dark, 8);
    b.rod(-0.55, 1.75, bz + 0.05, 0.55, 1.75, bz + 0.05, 0.05, m.dark, 8);
    for (let i = 0; i < 5; i++) b.rod(-0.6 + i * 0.3, by + 0.12, bz + 0.12, -0.6 + i * 0.3, 1.7, bz + 0.08, 0.025, m.dark, 6);
    b.end();
  } else {
    b.mark(partTag('bumper', 'front'), partMeta({ kind: 'bumper', pivot: [0, by, bz] }));
    b.rbox(0, by, bz, 2.5, 0.26, 0.18, 0.02, m.dark);
    for (const sx of [1, -1]) b.torus(sx * 0.7, by - 0.02, bz + 0.12, 0.07, 0.022, S.paint(0xc8321e, 0.5), 0, Math.PI / 2, 0, 5, 12);
    b.end();
  }
  // Winch drum and hook in the bumper's middle.
  b.cyl(0, by + 0.02, bz + 0.02, 0.22, 0.6, 0.22, m.steel, 0, 0, Math.PI / 2, 12);
  b.cyl(0, by + 0.02, bz + 0.02, 0.26, 0.04, 0.26, m.dark, 0, 0, Math.PI / 2, 12);
  b.torus(0, by - 0.08, bz + 0.16, 0.05, 0.012, m.steel, 0, 0, 0, 4, 10);
  // The nose: a vertical grille of bars in a guard, the lamps on the wing fronts.
  const gz = 2.68;
  b.rbox(0, 1.45, gz - 0.04, 1.36, 1.0, 0.08, 0.02, m.paint);
  b.box(0, 1.42, gz + 0.005, 1.08, 0.76, 0.02, S.metal(0x0a0a0a, 0.2));
  for (let i = 0; i < 11; i++) b.box(-0.5 + i * 0.1, 1.42, gz + 0.02, 0.035, 0.74, 0.03, t.grille === 'bars' || t.grille === 'egg' ? m.chrome : m.paint);
  if (t.grille === 'mesh' || t.grille === 'egg') for (let i = 0; i < 4; i++) b.box(0, 1.14 + i * 0.19, gz + 0.03, 1.06, 0.02, 0.02, m.dark);
  // Hood: an alligator bonnet hinged at the cowl, its top and louvred sides in one piece.
  const hz0 = 1.24;
  const hz1 = 2.66;
  const hy = 2.0;
  b.mark(PANEL_TAG.hood, partMeta({ kind: 'hood', pivot: [0, hy - 0.02, hz0] }));
  b.rbox(0, hy - 0.03, (hz0 + hz1) / 2, 1.5, 0.06, hz1 - hz0, 0.025, m.paint, -0.03, 0, 0);
  for (const sx of [1, -1]) {
    b.rbox(sx * 0.73, 1.6, (hz0 + hz1) / 2, 0.05, 0.74, hz1 - hz0 - 0.04, 0.015, m.paint);
    for (let i = 0; i < 6; i++) b.box(sx * 0.758, 1.72, hz0 + 0.35 + i * 0.13, 0.006, 0.3, 0.04, S.metal(0x0a0a0a, 0.2), 0, 0, sx * 0.25);
  }
  // Hood latches and a centre seam.
  b.box(0, hy + 0.005, (hz0 + hz1) / 2, 0.03, 0.012, hz1 - hz0 - 0.1, m.steel);
  b.end();
  // Flat-topped wings over the front wheels, with the inner wells dark.
  for (const sx of [1, -1]) {
    const x0 = 0.76;
    const x1 = 1.5;
    const zf0 = 1.3;
    const zf1 = 2.72;
    b.rbox(sx * ((x0 + x1) / 2), 1.25, (zf0 + zf1) / 2, x1 - x0, 0.05, zf1 - zf0, 0.02, m.paint);
    b.rbox(sx * ((x0 + x1) / 2), 1.08, zf1 - 0.03, x1 - x0, 0.36, 0.05, 0.02, m.paint);
    b.rbox(sx * (x1 - 0.02), 1.12, (zf0 + zf1) / 2, 0.04, 0.26, zf1 - zf0, 0.015, m.paint);
    b.rbox(sx * (x0 + 0.02), 1.0, (zf0 + zf1) / 2, 0.04, 0.5, zf1 - zf0, 0.015, m.dark);
    // Lamps on the wing fronts, in stone guards; a blackout lamp beside the left one.
    guardedLamp(b, rig, sx * 1.12, 1.4, zf1 + 0.06, t.lamps === 'twin' ? 0.085 : 0.11, m);
    if (t.lamps === 'twin') guardedLamp(b, rig, sx * 0.9, 1.4, zf1 + 0.06, 0.085, m);
    b.rbox(sx * 1.32, 1.33, zf1 + 0.04, 0.1, 0.07, 0.05, 0.01, S.plastic(0xd88a1a, 0.3));
  }
  b.rbox(1.3, 1.5, 2.72, 0.1, 0.06, 0.06, 0.01, m.dark);
  // The cab.
  const C: CabDims = { x: 1.1, floor: 1.26, roof: 2.62, zF: 1.24, belt: 1.98, rake: 0.12, zB: -0.08, door: [1.12, 0.12], seat: [0.5, 1.72, 0.48] };
  cab(b, C, m, t);
  mirrors(b, 1.1, 1.98, 1.15, m);
  // Steps up to the doors, a battery box on the left, the fuel tank on the right.
  for (const sx of [1, -1]) {
    for (const y of [0.62, 0.95]) b.box(sx * 1.0, y, 0.75, 0.26, 0.03, 0.42, S.steel(0x5a5d60, 0.8));
    b.box(sx * 1.12, 0.8, 0.75, 0.02, 0.4, 0.42, m.dark);
  }
  b.rbox(0.72, 0.84, 1.05, 0.34, 0.3, 0.42, 0.02, m.dark);
  tank(b, -0.78, 0.84, 1.0, 0.22, 0.8, S.paint(m.paintHex, 0.75), m);
  // An air intake standing up beside the left of the cowl, the exhaust stack behind the cab on the right.
  b.cyl(1.0, 2.1, 1.18, 0.2, 0.4, 0.2, m.dark, 0, 0, 0, 12);
  b.cyl(1.0, 2.34, 1.18, 0.26, 0.08, 0.26, m.dark, 0, 0, 0, 12);
  b.pipe([[1.0, 1.9, 1.18], [0.84, 1.75, 1.3]], 0.06, S.rubber(0x1a1a1a), 6);
  const top = stack(b, -0.98, 1.2, 3.0, -0.2, 0.055, m);
  // The bed: deck, sills, the front wall, and the body the trim calls for.
  const bz0 = -2.84;
  const bz1 = -0.42;
  const bf = 1.33;
  const bw = 1.24;
  const deck = t.body === 'gun' ? S.steel(0x4a4c4e, 0.85) : S.wood(0x6a5238, 0.8);
  b.box(0, bf - 0.035, (bz0 + bz1) / 2, bw * 2, 0.07, bz1 - bz0, deck);
  if (t.body !== 'gun') for (let i = 0; i < 9; i++) b.box(-bw + 0.14 + i * 0.29, bf + 0.002, (bz0 + bz1) / 2, 0.012, 0.006, bz1 - bz0 - 0.04, S.wood(0x4a3a28, 0.8));
  for (let i = 0; i < 7; i++) b.box(0, bf - 0.11, bz0 + 0.1 + i * 0.37, bw * 2 - 0.1, 0.08, 0.07, m.frame);
  for (const sx of [1, -1]) b.box(sx * fx, bf - 0.19, (bz0 + bz1) / 2, 0.12, 0.1, bz1 - bz0, m.frame);
  const wallH = t.body === 'gun' ? 1.05 : t.body === 'canvas' ? 0.45 : 0.55;
  // Front wall (headboard), with a mesh window over the low ones.
  b.rbox(0, bf + 0.4, bz1 - 0.03, bw * 2, 0.8, 0.06, 0.015, m.paint);
  if (t.body !== 'gun') {
    for (let i = 0; i < 9; i++) b.rod(-bw + 0.2 + i * 0.26, bf + 0.8, bz1 - 0.03, -bw + 0.2 + i * 0.26, bf + 1.15, bz1 - 0.03, 0.01, m.dark, 4);
    b.rod(-bw, bf + 1.15, bz1 - 0.03, bw, bf + 1.15, bz1 - 0.03, 0.025, m.dark, 6);
    for (const sx of [1, -1]) b.rod(sx * bw, bf + 0.8, bz1 - 0.03, sx * bw, bf + 1.15, bz1 - 0.03, 0.025, m.dark, 6);
  }
  if (t.body === 'gun') {
    // A gun truck's box: double-skinned steel walls with firing slits, plates of all ages welded on.
    const r = rnd(look.seed + 61);
    for (const sx of [1, -1]) {
      const n = 4;
      for (let i = 0; i < n; i++) {
        const z = bz1 - 0.3 - i * ((bz1 - bz0 - 0.6) / (n - 1));
        const col = r() > 0.6 ? m.rust : r() > 0.5 ? S.steel(0x5a5e60, 0.8) : m.paint;
        plate(b, sx * (bw - 0.03), bf + wallH / 2, z, 0.66, wallH, 0.05, col, 0, sx * Math.PI / 2, 0);
        b.box(sx * (bw + 0.005), bf + wallH * 0.72, z, 0.01, 0.06, 0.28, S.metal(0x050505, 0.2));
      }
      b.rbox(sx * (bw - 0.05), bf + wallH + 0.02, (bz0 + bz1) / 2, 0.12, 0.04, bz1 - bz0, 0.01, m.steel);
    }
    b.mark(PANEL_TAG.trunk, partMeta({ kind: 'trunk', pivot: [0, bf, bz0] }));
    plate(b, 0, bf + wallH / 2, bz0 + 0.03, bw * 2, wallH, 0.05, m.paint, 0, Math.PI, 0);
    b.box(0, bf + wallH * 0.72, bz0 - 0.005, 0.5, 0.06, 0.01, S.metal(0x050505, 0.2));
    b.end();
  } else {
    // Drop sides: ribbed panels hinged at the deck, latched at the posts; the tailgate on chains.
    for (const sx of [1, -1]) {
      b.rbox(sx * (bw - 0.03), bf + wallH / 2, (bz0 + bz1) / 2, 0.05, wallH, bz1 - bz0 - 0.06, 0.012, m.paint);
      for (let i = 0; i < 6; i++) b.box(sx * (bw + 0.0), bf + wallH / 2, bz1 - 0.2 - i * ((bz1 - bz0 - 0.4) / 5), 0.03, wallH - 0.04, 0.05, m.paint);
      b.box(sx * (bw - 0.02), bf + wallH - 0.02, (bz0 + bz1) / 2, 0.07, 0.04, bz1 - bz0 - 0.04, m.steel);
      for (const z of [bz1 - 0.6, bz0 + 0.6]) b.cyl(sx * (bw + 0.02), bf + 0.03, z, 0.05, 0.16, 0.05, m.steel, Math.PI / 2, 0, 0, 8);
    }
    b.mark(PANEL_TAG.trunk, partMeta({ kind: 'trunk', pivot: [0, bf, bz0] }));
    b.rbox(0, bf + wallH / 2, bz0 + 0.03, bw * 2 - 0.08, wallH, 0.05, 0.012, m.paint);
    for (let i = 0; i < 2; i++) b.box(0, bf + 0.12 + i * (wallH - 0.24), bz0 + 0.0, bw * 2 - 0.12, 0.04, 0.02, m.steel);
    b.end();
    for (const sx of [1, -1]) b.rod(sx * (bw - 0.06), bf + wallH, bz0 + 0.05, sx * (bw - 0.06), bf + wallH - 0.2, bz0 - 0.02, 0.008, m.steel, 4);
    if (t.body === 'canvas') {
      // Bows over the bed, the canvas rolled to the front and the side curtains rolled up along the top rails.
      const canvas = S.cloth(0x5e5a3e, 0.85);
      const ty = 2.62;
      for (let i = 0; i < 4; i++) {
        const z = bz1 - 0.35 - i * ((bz1 - bz0 - 0.5) / 3);
        b.pipe([[bw - 0.04, bf + wallH, z], [bw - 0.06, ty - 0.12, z], [bw - 0.3, ty, z], [-(bw - 0.3), ty, z], [-(bw - 0.06), ty - 0.12, z], [-(bw - 0.04), bf + wallH, z]], 0.022, m.dark, 6);
      }
      for (const sx of [1, -1]) b.capsule(sx * (bw - 0.06), ty - 0.16, bz1 - 0.35, sx * (bw - 0.06), ty - 0.16, bz0 + 0.15, 0.07, canvas, 8);
      b.capsule(-(bw - 0.2), ty + 0.06, bz1 - 0.2, bw - 0.2, ty + 0.06, bz1 - 0.2, 0.14, canvas, 10);
      for (const x of [-0.6, 0, 0.6]) b.torus(x, ty + 0.06, bz1 - 0.2, 0.145, 0.014, S.cloth(0x2a2a20, 0.6), 0, Math.PI / 2, 0, 4, 12);
    }
  }
  // The gunner's platform and ring mount at the head of the bed: grating on four legs, a step, a ring on posts.
  const ringZ = TRUCK_MOUNTS.gun!.z;
  const py = 1.92;
  b.box(0, py, ringZ - 0.12, 1.1, 0.05, 0.86, S.steel(0x3a3c3e, 0.8));
  for (let i = 0; i < 8; i++) b.box(-0.48 + i * 0.137, py + 0.028, ringZ - 0.12, 0.02, 0.006, 0.82, m.dark);
  for (const sx of [1, -1]) for (const dz of [-0.5, 0.26]) b.rod(sx * 0.48, bf, ringZ + dz, sx * 0.48, py - 0.02, ringZ + dz, 0.03, m.dark, 6);
  b.box(0, (bf + py) / 2, ringZ - 0.62, 0.6, 0.03, 0.2, S.steel(0x5a5d60, 0.8));
  b.torus(0, py + 0.95, ringZ, 0.46, 0.035, m.dark, Math.PI / 2, 0, 0, 6, 28);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.5;
    b.rod(Math.cos(a) * 0.46, py + 0.95, ringZ + Math.sin(a) * 0.46, Math.cos(a) * 0.4, py + 0.03, ringZ + Math.sin(a) * 0.4 - 0.1, 0.022, m.dark, 6);
  }
  // A spare wheel on the back of the cab, cans in racks on the bed's front corners.
  if (t.spare !== 'none' && !look.fit.rear) {
    b.mark(partTag('spare'), partMeta({ kind: 'spare', pivot: [0.62, 1.95, -0.27] }));
    spareTyre(b, 0.62, 1.95, -0.27, R * 0.98, 0.36, Math.PI / 2, 0);
    b.end();
  }
  const cols = [0x55603e, 0x3a3c3e, 0xb0301e];
  for (let i = 0; i < Math.max(1, t.cans); i++) {
    const sx = i ? -1 : 1;
    b.box(sx * (bw + 0.12), bf + 0.02, bz1 - 0.35, 0.22, 0.03, 0.3, m.dark);
    jerryCan(b, sx * (bw + 0.12), bf + 0.035, bz1 - 0.35, cols[(look.seed + i) % cols.length], Math.PI / 2);
    strap(b, [[sx * (bw + 0.02), bf + 0.38, bz1 - 0.2], [sx * (bw + 0.24), bf + 0.38, bz1 - 0.2]]);
  }
  // Rear: crossmember with the lamps, a pintle hook, mud flaps.
  b.box(0, 0.98, -2.84, 2.3, 0.18, 0.1, m.dark);
  b.cyl(0, 0.95, -2.95, 0.1, 0.12, 0.1, m.steel, Math.PI / 2, 0, 0, 8);
  b.torus(0, 0.95, -3.03, 0.06, 0.018, m.steel, 0, Math.PI / 2, 0, 5, 10);
  for (const sx of [1, -1]) {
    rig.tail(sx * 1.0, 0.98, -2.9, 0.16, 0.1);
    rig.tail(sx * 0.82, 0.98, -2.9, 0.1, 0.08, true);
    b.box(sx * 1.25, 0.62, zC - R - 0.14, 0.42, 0.56, 0.014, m.rubber);
  }
  // Stencils: the convoy number on the doors and the bonnet sides.
  if (t.stencil !== 'none') {
    for (const sx of [1, -1] as const) {
      heavyStencil(b, t, { o: new THREE.Vector3(sx * (1.1 + 0.012), 1.62, 0.62), right: new THREE.Vector3(0, 0, -sx), up: new THREE.Vector3(0, 1, 0) }, 0.28, look.seed + sx);
    }
  }
  return { smoke: top, wallH };
}

// ---------------------------------------------------------------- the war rig

function rigBody(b: MeshBuilder, rig: Rig, def: VehicleDef, look: VehicleLook, t: CarTrim, m: Mats) {
  const R = def.physics.wheelRadius;
  const wx = Math.abs(def.physics.wheelsX[0]);
  const zs = def.physics.wheelsZ;
  const fx = 0.52;
  // Tractor frame, and the trailer's deeper frame above the rear tandems.
  ladder(b, fx, 1.0, 1.26, -1.35, 4.42, m, [4.3, 3.0, 1.5, 0.4, -1.2]);
  zs.forEach((z, i) => beamAxle(b, z, R, wx, fx, i < 4 ? 1.0 : 1.52, m, i < 2));
  for (let i = 2; i < 4; i++) b.rod(0, R + 0.06, zs[i] + 0.3, 0, 1.02, zs[i] + 0.9, 0.05, m.dark, 8);
  // Air bags over the drive and trailer axles.
  for (let i = 2; i < 6; i++) for (const sx of [1, -1]) b.cyl(sx * (fx + 0.06), (i < 4 ? 1.0 : 1.52) - 0.12, zs[i] - 0.3, 0.24, 0.22, 0.24, m.rubber, 0, 0, 0, 12);
  // Front bumper: a deep chrome or steel bumper, or a push bar over it.
  const by = 1.0;
  const bz = 4.56;
  const chrome = t.bumperF === 'chrome';
  b.mark(partTag('bumper', 'front'), partMeta({ kind: 'bumper', pivot: [0, by, bz] }));
  b.rbox(0, by, bz, 3.1, 0.34, 0.2, 0.04, chrome ? m.chrome : m.dark);
  for (const sx of [1, -1]) b.rbox(sx * 1.45, by, bz - 0.2, 0.2, 0.34, 0.4, 0.04, chrome ? m.chrome : m.dark);
  for (const sx of [1, -1]) b.torus(sx * 0.62, by - 0.1, bz + 0.12, 0.08, 0.025, S.paint(0xe0be1a, 0.5), 0, Math.PI / 2, 0, 5, 12);
  b.end();
  if (t.bumperF === 'bull' && !look.fit.front) {
    b.mark(partTag('bullbar'), partMeta({ kind: 'bullbar', pivot: [0, by, bz + 0.15] }));
    const tube = m.dark;
    for (const sx of [1, -1]) b.pipe([[sx * 1.25, by - 0.1, bz + 0.15], [sx * 1.3, by + 0.2, bz + 0.3], [sx * 1.2, 2.3, bz + 0.25], [sx * 0.6, 2.5, bz + 0.12]], 0.06, tube, 8);
    b.rod(-0.6, 2.5, bz + 0.12, 0.6, 2.5, bz + 0.12, 0.06, tube, 8);
    b.rod(-1.3, by + 0.2, bz + 0.3, 1.3, by + 0.2, bz + 0.3, 0.06, tube, 8);
    for (let i = 0; i < 7; i++) b.rod(-0.9 + i * 0.3, by + 0.2, bz + 0.3, -0.9 + i * 0.3, 2.3, bz + 0.22, 0.03, tube, 6);
    b.end();
  }
  // The nose: a big chrome grille in its surround, the hood sloping to it.
  const gz = 4.46;
  b.rbox(0, 1.84, gz - 0.03, 1.62, 1.2, 0.1, 0.03, m.chrome);
  b.box(0, 1.82, gz + 0.025, 1.4, 1.02, 0.02, S.metal(0x0a0a0a, 0.2));
  for (let i = 0; i < 13; i++) b.box(-0.66 + i * 0.11, 1.82, gz + 0.04, 0.03, 1.0, 0.03, t.grille === 'mesh' ? m.dark : m.chrome);
  if (t.grille === 'egg' || t.grille === 'slats') for (let i = 0; i < 6; i++) b.box(0, 1.36 + i * 0.18, gz + 0.045, 1.38, 0.025, 0.025, m.chrome);
  const hz0 = 2.98;
  const hz1 = 4.42;
  b.mark(PANEL_TAG.hood, partMeta({ kind: 'hood', pivot: [0, 2.54, hz0] }));
  b.rbox(0, 2.52, (hz0 + hz1) / 2, 1.76, 0.08, hz1 - hz0, 0.04, m.paint, -0.05, 0, 0);
  for (const sx of [1, -1]) b.rbox(sx * 0.86, 2.05, (hz0 + hz1) / 2, 0.06, 0.94, hz1 - hz0 - 0.04, 0.02, m.paint);
  // A hood ornament on some, louvres on the sides.
  if (look.seed % 3 === 0) b.add('cone6', 0, 2.62, hz1 - 0.08, 0.06, 0.14, 0.12, m.chrome, -1.2, 0, 0);
  for (const sx of [1, -1]) for (let i = 0; i < 7; i++) b.box(sx * 0.895, 2.25, hz0 + 0.3 + i * 0.13, 0.006, 0.36, 0.04, S.metal(0x0a0a0a, 0.2), 0, 0, sx * 0.25);
  b.end();
  // Swept wings over the front steer axle, flat ones over the second; lamps in the wings.
  for (const sx of [1, -1]) {
    b.extrude(
      'rigWing',
      () => {
        const s = new THREE.Shape();
        s.absarc(0, 0, R + 0.24, 0.05, Math.PI - 0.15, false);
        s.absarc(0, 0, R + 0.14, Math.PI - 0.15, 0.05, true);
        s.closePath();
        return s;
      },
      0.78,
      0.02,
      sx * (wx - 0.02),
      R + 0.02,
      zs[0],
      m.paint,
      0,
      Math.PI / 2,
      0,
    );
    b.rbox(sx * 1.25, 1.55, zs[1], 0.62, 0.04, R * 2 + 0.3, 0.015, m.paint);
    b.rbox(sx * 1.55, 1.42, zs[1], 0.04, 0.24, R * 2 + 0.3, 0.012, m.paint);
    const lx = sx * 1.25;
    if (t.lamps === 'square') {
      b.rbox(lx, 1.62, 4.36, 0.36, 0.2, 0.08, 0.02, m.chrome);
      rig.lamp(lx, 1.62, 4.41, 0.08, false, 0.32, 0.16);
    } else {
      rig.lamp(lx, 1.62, 4.38, 0.12, true);
      if (t.lamps === 'twin') rig.lamp(lx - sx * 0.3, 1.62, 4.38, 0.1, true);
    }
    b.rbox(sx * 1.5, 1.38, 4.32, 0.12, 0.08, 0.06, 0.01, S.plastic(0xd88a1a, 0.3));
  }
  // The cab, a sleeper behind it on some, mirrors, steps and grab handles.
  const zCabB = 1.62;
  const C: CabDims = { x: 1.22, floor: 1.8, roof: 3.36, zF: 2.96, belt: 2.62, rake: 0.14, zB: zCabB, door: [2.86, 1.74], seat: [0.55, 2.28, 2.24] };
  cab(b, C, m, t);
  mirrors(b, 1.22, 2.62, 2.86, m);
  if (t.sleeper) {
    b.rbox(0, 2.71, 1.29, 2.36, 1.82, 0.66, 0.04, m.paint);
    b.rbox(0, 3.62, 1.36, 2.3, 0.08, 0.72, 0.03, m.paint);
    // The air dam over the cab roof up to the sleeper's height.
    b.box(0, 3.5, 1.92, 2.2, 0.26, 0.5, m.paint, 0.4, 0, 0);
    for (const sx of [1, -1]) b.box(sx * 1.183, 2.95, 1.29, 0.01, 0.3, 0.4, m.glass);
  }
  for (const sx of [1, -1]) {
    for (const y of [1.18, 1.5]) b.box(sx * 1.12, y, 2.35, 0.3, 0.03, 0.4, S.steel(0x8a8e92, 0.5));
    b.rod(sx * 1.25, 1.9, 2.92, sx * 1.25, 2.55, 2.92, 0.018, m.chrome, 6);
  }
  // Air cleaners on the cowl, twin stacks behind the cab.
  for (const sx of [1, -1]) {
    b.cyl(sx * 1.02, 2.3, 3.05, 0.34, 0.62, 0.34, m.chrome, 0, 0, 0, 14);
    b.cyl(sx * 1.02, 2.64, 3.05, 0.38, 0.06, 0.38, m.dark, 0, 0, 0, 14);
  }
  const zs0 = t.sleeper ? 0.86 : 1.5;
  const top = stack(b, 1.08, 1.3, 4.15, zs0, 0.075, m);
  stack(b, -1.08, 1.3, 4.15, zs0, 0.075, m);
  // Fifth wheel under the trailer's nose, batteries and air tanks on the frame.
  b.cyl(0, 1.38, 0.1, 1.2, 0.08, 1.0, m.dark, 0, 0, 0, 16);
  b.rbox(0.7, 1.15, -0.95, 0.4, 0.34, 0.5, 0.02, m.dark);
  for (const sx of [1, -1]) tank(b, sx * 0.7, 0.88, -0.95, 0.13, 0.7, S.steel(0x7a7e82, 0.6), m);
  // The trailer: frame and deck, landing gear, the gunner's platform, then the load.
  const tf = 1.86;
  const tw = 1.42;
  const tz0 = -4.5;
  const tz1 = 0.92;
  for (const sx of [1, -1]) b.box(sx * 0.55, 1.62, (tz0 + tz1) / 2, 0.1, 0.36, tz1 - tz0, m.frame);
  b.box(0, tf - 0.04, (tz0 + tz1) / 2, tw * 2, 0.08, tz1 - tz0, S.steel(0x4a4c4e, 0.85));
  for (const sx of [1, -1]) b.box(sx * (tw - 0.02), tf - 0.1, (tz0 + tz1) / 2, 0.06, 0.16, tz1 - tz0, m.paint);
  for (const sx of [1, -1]) {
    b.box(sx * 0.6, 1.2, -1.45, 0.1, 0.8, 0.1, m.dark);
    b.box(sx * 0.6, 0.82, -1.45, 0.3, 0.04, 0.3, m.dark);
  }
  const gzz = RIG_MOUNTS.gun!.z;
  const py = 2.78;
  b.box(0, py, gzz - 0.1, 1.3, 0.06, 1.0, S.steel(0x3a3c3e, 0.8));
  for (const sx of [1, -1]) for (const dz of [-0.55, 0.35]) b.rod(sx * 0.58, tf, gzz + dz, sx * 0.58, py - 0.03, gzz + dz, 0.035, m.dark, 6);
  for (const sx of [1, -1]) b.pipe([[sx * 0.65, py, gzz + 0.38], [sx * 0.65, py + 0.85, gzz + 0.38], [sx * 0.65, py + 0.85, gzz - 0.58], [sx * 0.65, py, gzz - 0.58]], 0.02, m.dark, 6);
  b.torus(0, py + 0.95, gzz, 0.52, 0.04, m.dark, Math.PI / 2, 0, 0, 6, 28);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    b.rod(Math.cos(a) * 0.52, py + 0.95, gzz + Math.sin(a) * 0.52, Math.cos(a) * 0.45, py + 0.04, gzz + Math.sin(a) * 0.45, 0.025, m.dark, 6);
  }
  for (let i = 0; i < 5; i++) b.box(-0.4 + i * 0.2, tf + 0.1 + i * 0.18, gzz - 0.75, 0.6, 0.03, 0.18, S.steel(0x5a5d60, 0.8), 0, 0, 0);
  const lz0 = -3.0;
  const lz1 = -0.08;
  if (t.body === 'tanker') {
    // The tank: an oval drum with dished ends, bands, a catwalk and hatches on top, valves and a hose underneath.
    const tr = 1.02;
    const ty = tf + tr + 0.06;
    const tl = lz1 - lz0;
    const tc = (lz0 + lz1) / 2;
    const tankSurf = look.seed % 2 ? S.metal(0xb8bcc0, 0.55) : m.paint;
    b.cyl(0, ty, tc, tr * 2.3, tl - 0.3, tr * 2, tankSurf, Math.PI / 2, 0, 0, 24);
    for (const e of [1, -1]) b.add('dome', 0, ty, tc + e * (tl / 2 - 0.15), tr * 2.3, 0.4, tr * 2, tankSurf, e > 0 ? Math.PI / 2 : -Math.PI / 2, 0, 0);
    for (let i = 0; i < 5; i++) b.torus(0, ty, lz0 + 0.4 + i * ((tl - 0.8) / 4), 1, 0.025, m.dark, 0, 0, 0, 4, 24);
    b.box(0, ty + tr + 0.03, tc, 0.5, 0.04, tl - 0.6, S.steel(0x3a3c3e, 0.8));
    for (const sx of [1, -1]) b.rod(sx * 0.3, ty + tr + 0.42, lz0 + 0.4, sx * 0.3, ty + tr + 0.42, lz1 - 0.4, 0.018, m.steel, 6);
    for (let i = 0; i < 3; i++) b.cyl(0, ty + tr + 0.09, lz0 + 0.7 + i * 0.9, 0.42, 0.1, 0.42, m.steel, 0, 0, 0, 14);
    for (let i = 0; i < 2; i++) b.cyl(0.4, tf - 0.15, lz0 + 0.6 + i * 1.5, 0.16, 0.25, 0.16, S.paint(0xc8321e, 0.5), 0, 0, 0, 10);
    b.pipe([[0.4, tf - 0.25, lz0 + 0.6], [1.0, tf - 0.35, lz0 + 1.2], [1.2, tf - 0.2, -1.6]], 0.04, m.rubber, 6);
    // Hazard diamonds on the ends and flanks.
    for (const sx of [1, -1]) b.box(sx * (tr * 1.15 + 0.005), ty, tc, 0.006, 0.36, 0.36, S.paint(0xd8321e, 0.45), Math.PI / 4, 0, 0);
    b.box(0, ty, lz0 + 0.02, 0.36, 0.36, 0.006, S.paint(0xd8321e, 0.45), 0, 0, Math.PI / 4);
    // A ladder up the back to the catwalk.
    for (const sx of [1, -1]) b.rod(sx * 0.22, tf, lz0 - 0.05, sx * 0.22, ty + tr + 0.4, lz0 + 0.25, 0.018, m.steel, 6);
    for (let i = 0; i < 7; i++) b.rod(-0.22, tf + 0.25 + i * 0.3, lz0 - 0.03 + i * 0.04, 0.22, tf + 0.25 + i * 0.3, lz0 - 0.03 + i * 0.04, 0.012, m.steel, 6);
  } else if (t.body === 'hauler') {
    // A shipping container chained down, ribbed and rusting, its doors facing the rear deck.
    const ch = 2.2;
    const cw = 2.34;
    const cy = tf + ch / 2 + 0.02;
    const cc = look.seed % 3 === 0 ? 0x2a5a8a : look.seed % 3 === 1 ? 0x8a3a22 : 0x4a6a3a;
    b.box(0, cy, (lz0 + lz1) / 2, cw, ch, lz1 - lz0, S.paint(cc, 0.75));
    for (const sx of [1, -1]) for (let i = 0; i < 15; i++) b.box(sx * (cw / 2 + 0.012), cy, lz0 + 0.1 + i * ((lz1 - lz0 - 0.2) / 14), 0.024, ch - 0.12, 0.05, S.paint(cc, 0.75));
    for (const y of [tf + 0.05, tf + ch]) for (const sx of [1, -1]) b.box(sx * (cw / 2 - 0.02), y, (lz0 + lz1) / 2, 0.08, 0.08, lz1 - lz0 + 0.02, m.dark);
    for (const sx of [1, -1]) {
      b.box(sx * 0.58, cy, lz0 - 0.012, 1.12, ch - 0.1, 0.02, S.paint(cc, 0.7));
      for (const dx of [0.2, 0.45]) b.rod(sx * dx, tf + 0.15, lz0 - 0.04, sx * dx, tf + ch - 0.15, lz0 - 0.04, 0.02, m.steel, 6);
    }
    b.rbox(0.9, tf + 0.9, (lz0 + lz1) / 2 + 0.3, 0.02, 0.8, 1.2, 0.01, m.rust);
    for (const z of [lz1 - 0.3, lz0 + 0.3]) strap(b, [[-tw, tf, z], [-cw / 2, tf + ch, z], [cw / 2, tf + ch, z], [tw, tf, z]], 0x7a7e82);
    sprayText(b, { o: new THREE.Vector3(cw / 2 + 0.03, cy + 0.3, (lz0 + lz1) / 2), right: new THREE.Vector3(0, 0, -1), up: new THREE.Vector3(0, 1, 0) }, ['SCRAP', 'NO GAS', 'KEEP OUT'][look.seed % 3] ?? 'SCRAP', 0.3, S.paint(0xf0ece0, 0.5), rnd(look.seed), 0.03);
  } else {
    // A scavenger's flatbed: stake sides and a load of crushed wrecks, tyres and drums under chains.
    const stake = m.dark;
    for (const sx of [1, -1]) {
      for (let i = 0; i < 6; i++) b.rod(sx * (tw - 0.04), tf, lz1 - 0.2 - i * 0.55, sx * (tw - 0.04), tf + 1.0, lz1 - 0.2 - i * 0.55, 0.035, stake, 6);
      b.rod(sx * (tw - 0.04), tf + 0.95, lz1 - 0.2, sx * (tw - 0.04), tf + 0.95, lz0 + 0.1, 0.03, stake, 6);
    }
    const hulk = S.paint(0x2a2622, 0.95);
    const r = rnd(look.seed + 7);
    for (let i = 0; i < 2; i++) {
      const y = tf + 0.3 + i * 0.58;
      const zc = -0.9 - i * 0.2 - r() * 0.2;
      b.rbox(0, y, zc - 0.65, 1.9, 0.52, 1.6, 0.08, i ? S.paint(0x6a4a2a, 0.95) : hulk, 0, r() * 0.2 - 0.1, (r() - 0.5) * 0.08);
      b.rbox(0, y + 0.3, zc - 0.5, 1.5, 0.2, 0.8, 0.06, S.rust(0x5a3a22), 0, 0, 0.05);
    }
    for (let i = 0; i < 3; i++) spareTyre(b, -0.75 + (i % 2) * 0.12, tf + 0.12 + i * 0.22, -2.55, 0.42, 0.24, 0, 0);
    for (let i = 0; i < 2; i++) b.cyl(0.65, tf + 0.45, -2.35 - i * 0.6, 0.56, 0.86, 0.56, S.paint([0x3a5f8a, 0x8a3a22][i], 0.85), 0, 0, 0, 14);
    for (const z of [-0.6, -1.9]) strap(b, [[-tw, tf, z], [-0.9, tf + 1.5, z], [0.9, tf + 1.5, z], [tw, tf, z]], 0x7a7e82);
  }
  // Rear: the deck's tail with lamps and a bumper bar, mud flaps behind the last axle.
  b.box(0, tf - 0.25, tz0 + 0.05, tw * 2, 0.3, 0.1, m.dark);
  b.mark(partTag('bumper', 'rear'), partMeta({ kind: 'bumper', pivot: [0, 1.25, tz0] }));
  b.box(0, 1.25, tz0 - 0.08, 2.6, 0.14, 0.12, S.steel(0x3a3c3e, 0.8));
  for (const sx of [1, -1]) b.box(sx * 1.0, 1.45, tz0 - 0.02, 0.1, 0.4, 0.1, m.dark);
  b.end();
  for (const sx of [1, -1]) {
    rig.tail(sx * 1.2, tf - 0.25, tz0 - 0.005, 0.2, 0.12);
    rig.tail(sx * 0.95, tf - 0.25, tz0 - 0.005, 0.12, 0.1, true);
    b.box(sx * 1.6, 0.75, zs[5] - R - 0.12, 0.62, 0.7, 0.014, m.rubber);
  }
  if (t.stencil !== 'none') {
    for (const sx of [1, -1] as const) heavyStencil(b, t, { o: new THREE.Vector3(sx * (1.22 + 0.012), 2.22, 2.3), right: new THREE.Vector3(0, 0, -sx), up: new THREE.Vector3(0, 1, 0) }, 0.32, look.seed + sx);
  }
  return { smoke: top };
}

// ---------------------------------------------------------------- assembly

function mats(look: VehicleLook, t: CarTrim | null): Mats {
  const wear = Math.min(1, look.wear + schemeWear(t));
  const paintHex = bodyColor(look.paint, t);
  return {
    paint: S.paint(paintHex, wear),
    paintHex,
    dark: S.steel(0x232527, 0.7),
    frame: S.paint(0x1e1f20, 0.8),
    steel: S.steel(0x5a5e62, 0.7),
    rust: S.rust(0x6e3a22),
    chrome: S.chrome(0xc8ccd0),
    rubber: S.rubber(0x1a1a1a),
    glass: S.glass(0x10171c),
    cab: { ...S.plastic(0x3a3630, 0.5), e: CABIN_FILL },
  };
}

function* makeHeavySteps(def: VehicleDef, look: VehicleLook): Generator<void, Shell> {
  const g0 = restHeight(def);
  const lamps: Shell['lamps'] = [];
  const tails: Shell['tails'] = [];
  let muzzle: Shell['muzzle'] = null;
  const b = new MeshBuilder();
  b.jitter = 0.03;
  b.roundSeg = 1;
  b.seed(look.seed + 5);
  const rig: Rig = {
    lamp: (x, y, z, r, bucket = true, w, h) => {
      lamps.push({ x, y: y - g0, z, r, bucket, w, h });
      if (bucket && !w) {
        b.frustum(x, y, z - r * 0.45, r * 1.12, r * 0.7, r * 0.9, S.chrome(0xc8ccd0), Math.PI / 2, 0, 0, 16);
        b.torus(x, y, z, r * 1.08, r * 0.1, S.chrome(), 0, 0, 0, 6, 20);
      }
    },
    tail: (x, y, z, w, h, amber) => tails.push({ x, y: y - g0, z, w, h, amber }),
    muzzle: (x, y, z) => {
      muzzle = [x, y - g0, z];
    },
  };
  const t = look.trim ?? defaultHeavyTrim(def.id);
  const m = mats(look, look.trim ?? null);
  const truck = def.id === 'truck';
  const mt = truck ? TRUCK_MOUNTS : RIG_MOUNTS;
  yield;
  const out = truck ? truckBody(b, rig, def, look, t, m) : rigBody(b, rig, def, look, t, m);
  yield;
  // The bolt-on kit: armour on the cab doors, cooling, exhaust, springs, utility, the front/roof/rear modules. The native
  // gun is the turret on the visual, so the kit draws no fixed gun.
  const wheels = wheelXZ(def);
  addKit(b, rig, { ...mt, gun: undefined }, look, { nativeGun: false, wheels, bayFloor: mt.bayFloor });
  paintPanels(b, m.paintHex, look.panels, mt);
  b.groundShade(0, 0.6, 0.3);
  yield;
  const geo = b.build();
  geo.translate(0, -g0, 0);
  for (const r of (geo.userData.parts ?? []) as PartRange[]) if (r.meta.pivot) r.meta = { ...r.meta, pivot: [r.meta.pivot[0], r.meta.pivot[1] - g0, r.meta.pivot[2]] };
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return { geo, lamps, tails, muzzle, smoke: [out.smoke[0], out.smoke[1] - g0, out.smoke[2]] } as Shell & { smoke: V3 };
}

/** The trim of a heavy chassis built without one. */
function defaultHeavyTrim(id: string): CarTrim {
  return {
    body: id === 'truck' ? 'dropside' : 'tanker',
    sleeper: true,
    bumperF: 'steel',
    bumperR: 'steel',
    grille: 'bars',
    lamps: 'round',
    rims: 'steel',
    rimColor: 0x4a5236,
    oddWheel: -1,
    rails: false,
    mirrors: 'black',
    flaps: true,
    antenna: 0,
    spare: 'tail',
    cans: 1,
    scheme: 'solid',
    tone: 'roof',
    second: 0xe9e4d6,
    patch: 'hood',
    stencil: 'none',
    glyph: 0,
    stencilColor: 0xf0ece0,
    raider: false,
  };
}

function wheelXZ(def: VehicleDef): [number, number][] {
  const p = def.physics;
  const out: [number, number][] = [];
  for (const z of p.wheelsZ) for (const x of p.wheelsX) if (out.length < p.wheelCount) out.push([x, z]);
  return out;
}

function bodySignature(fit: VehicleLook['fit']): string {
  return Object.keys(fit)
    .filter((k) => !isInteriorSlot(k as never))
    .sort()
    .map((k) => `${k}:${fit[k as keyof typeof fit]!.id}`)
    .join(',');
}

export function heavyShellKey(def: VehicleDef, look: VehicleLook): string {
  return `${def.id}|${look.paint}|${look.seed}|${Math.round(look.wear * 10)}|${bodySignature(look.fit)}|${panelSignature(look.panels)}|${trimKey(look.trim)}`;
}

/** Build a heavy chassis' shell ahead of spawning it, a slice per step. */
export function* prepareHeavyShell(def: VehicleDef, look: VehicleLook): Generator<void> {
  const key = heavyShellKey(def, look);
  if (hasShell(key)) return;
  const shell = yield* makeHeavySteps(def, look);
  acquireShell(key, () => shell);
  releaseShell(key);
}

function makeHeavy(def: VehicleDef, look: VehicleLook): Shell {
  const g = makeHeavySteps(def, look);
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

// ---------------------------------------------------------------- turrets

const turretCache = new Map<string, THREE.BufferGeometry>();

/**
 * The gun on the ring: the truck's shielded heavy MG (two with a better weapon part fitted), or the rig's twin autocannons
 * with their long barrels, muzzle brakes and ammo drums behind a wide shield. Shared geometry per kind and grade.
 */
function turretGeometry(kind: 'truck' | 'rig', mk: number): THREE.BufferGeometry {
  const key = `${kind}:${mk}`;
  let g = turretCache.get(key);
  if (g) return g;
  const b = new MeshBuilder();
  b.jitter = 0.02;
  if (kind === 'truck') {
    heavyGun(b, 1.25, true);
    if (mk >= 2) {
      const twin = new MeshBuilder();
      heavyGun(twin, 1.25, false);
      b.appendMatrix(twin, new THREE.Matrix4().makeTranslation(0.24, 0, 0));
    }
    // The cradle and its yoke on the ring.
    b.box(0, -0.26, -0.05, 0.1, 0.22, 0.1, S.steel(0x2a2c2e, 0.6));
  } else {
    const dark = S.steel(0x2a2c2e, 0.5);
    const olive = S.paint(0x4a5236, 0.7);
    // Receiver block, two long barrels with muzzle brakes, ammo drums, a wide angled shield.
    b.rbox(0, 0, -0.05, 0.62, 0.32, 0.8, 0.03, olive);
    for (const sx of [1, -1]) {
      b.cyl(sx * 0.2, 0.02, 0.95, 0.07, 1.4, 0.07, dark, Math.PI / 2, 0, 0, 10);
      b.cyl(sx * 0.2, 0.02, 0.45, 0.12, 0.4, 0.12, dark, Math.PI / 2, 0, 0, 12);
      b.cyl(sx * 0.2, 0.02, 1.68, 0.12, 0.16, 0.12, dark, Math.PI / 2, 0, 0, 10);
      for (const dz of [1.64, 1.72]) b.box(sx * 0.2, 0.02, dz, 0.15, 0.03, 0.02, S.metal(0x050505, 0.2));
      b.cyl(sx * 0.42, -0.02, -0.15, 0.32, 0.22, 0.32, olive, 0, 0, Math.PI / 2, 14);
    }
    plate(b, 0, 0.12, 0.32, 1.2, 0.62, 0.04, olive, -0.18, 0, 0);
    for (const sx of [1, -1]) plate(b, sx * 0.62, 0.08, 0.15, 0.4, 0.55, 0.035, olive, 0, sx * 0.7, 0);
    for (const sx of [1, -1]) b.capsule(sx * 0.12, -0.05, -0.5, sx * 0.12, -0.14, -0.58, 0.025, S.rubber(0x202020));
    b.box(0, -0.28, -0.05, 0.14, 0.26, 0.14, dark);
  }
  g = shared(b.build());
  turretCache.set(key, g);
  return g;
}

// ---------------------------------------------------------------- the visual

/** The war truck or war rig as a live visual. */
export function buildHeavy(def: VehicleDef, wheelLocal: [number, number, number][], steered: boolean[], look: VehicleLook): VehicleVisual {
  const v = blank(def);
  const g0 = restHeight(def);
  const truck = def.id === 'truck';
  const mt = truck ? TRUCK_MOUNTS : RIG_MOUNTS;
  const key = heavyShellKey(def, look);
  const shell = acquireShell(key, () => makeHeavy(def, look)) as Shell & { smoke?: V3 };
  v.body = new THREE.Mesh(shell.geo, bodyMat);
  v.body.castShadow = true;
  v.body.receiveShadow = true;
  v.inner.add(v.body);
  for (const l of shell.lamps) headlamp(v, new MeshBuilder(), l.x, l.y, l.z, l.r, false, l.w, l.h);
  for (const t of shell.tails) taillight(v, t.x, t.y, t.z, t.w, t.h, t.amber);
  v.setHeadlights = (on: boolean) => {
    for (const h of v.headlights) h.material = on ? lightMat : lightOffMat;
  };
  addWheelSet(v, def, wheelLocal, steered, wheelSpecs(def, look.tyres, look.brakeMk ?? 0, look.trim ?? undefined));
  // The driver in the cab, sat on the seat the cab draws.
  const seat: V3 = truck ? [0.5, 1.72, 0.48] : [0.55, 2.28, 2.24];
  const floor = truck ? 1.26 : 1.8;
  const L: CabinLayout = {
    kind: 'car',
    g0,
    floor,
    ceil: truck ? 2.58 : 3.32,
    hw: truck ? 1.0 : 1.1,
    zFront: truck ? 1.24 : 2.96,
    zBack: truck ? -0.05 : 1.65,
    seats: { seatD: { x: seat[0], z: seat[2], hip: seat[1], w: 0.5 } },
    steer: { x: seat[0], y: seat[1] + 0.42, z: seat[2] + 0.42, tilt: 0.95 },
    dash: { z: (truck ? 1.24 : 2.96) - 0.22, top: (truck ? 1.98 : 2.62) - 0.01, w: 2, depth: 0.32, driverX: 1 },
  };
  const color = look.paint;
  const driver = rider(color, color);
  v.inner.add(driver.root);
  v.driver = driver;
  v.seat = (who, h) => {
    if (who === 'driver') seatOccupant(h, L, L.seats.seatD!, L.seats.seatD!.hip);
  };
  // The turret: a pivot over the ring, the gunner standing on the platform behind it.
  const gp = mt.gun!;
  const gun = new THREE.Group();
  gun.position.set(gp.x, gp.y - g0, gp.z);
  const mk = look.fit.weapon ? partDef(look.fit.weapon.id).mk : 1;
  const gm = new THREE.Mesh(turretGeometry(truck ? 'truck' : 'rig', mk), bodyMat);
  gm.castShadow = true;
  gun.add(gm);
  const mz = new THREE.Object3D();
  mz.position.set(0, 0.02, truck ? 1.27 : 1.78);
  gun.add(mz);
  v.inner.add(gun);
  v.gun = gun;
  v.muzzle = mz;
  v.gunSeat = truck ? [0, 1.945 - g0, gp.z - 0.32] : [0, 2.81 - g0, gp.z - 0.4];
  const pass = rider(color, color);
  pass.root.position.set(...v.gunSeat);
  v.passenger = pass;
  const sm = shell.smoke ?? [0, 3, 0];
  v.smoke.position.set(sm[0], sm[1], sm[2]);
  v.inner.add(v.smoke);
  v.damageTint = () => {};
  v.dispose = () => {
    releaseShell(key);
  };
  attachBay(v, def.id, mt, look, mt.bayFloor!, g0);
  applyRideLift(v, look.lift ?? 0);
  return v;
}
