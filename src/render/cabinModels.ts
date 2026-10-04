import * as THREE from 'three';
import { MeshBuilder, S } from './builder';
import { plate, rivets, strap } from './parts';
import { partDef } from '../data';

/**
 * Models of the cabin parts, one per part id: the same mesh sits on the car, in the arms and on the ground. Local frame:
 * origin on the floor under the middle of the part, +Z forward (toward the windscreen), +Y up, drawn at the real size.
 * The seat's cushion top is `SEAT_TOP` above its origin; a steering wheel's hub is `STEER_HUB` above it, so a placement
 * only has to subtract that. Missing parts have models too (`seat_none` and the rest): the bare mounts, the stub of the
 * column, the beam behind a dash that is not there.
 */

/** Height of a seat's cushion top above the model origin. The occupant's hip joint sits `HIP_ABOVE_TOP` above that. */
export const SEAT_TOP = 0.28;
export const HIP_ABOVE_TOP = 0.09;
/** Height of a wheel's hub above the model origin when it is drawn as a carried part. */
export const STEER_HUB = 0.32;
/** Height of a dashboard model. */
export const DASH_H = 0.3;

const steel = (c = 0x4a4d50, w = 0.6) => S.steel(c, w);
const darkSteel = () => S.steel(0x2a2c2e, 0.7);
const chrome = () => S.chrome(0xc4c8cc);

interface SeatLook {
  cloth: ReturnType<typeof S.cloth>;
  trim: ReturnType<typeof S.cloth>;
  dark: ReturnType<typeof S.cloth>;
}

function seatFrame(b: MeshBuilder, w: number, depth: number) {
  // Runners and the pan the cushion sits on.
  for (const sx of [1, -1]) b.rbox(sx * (w / 2 - 0.08), 0.035, 0, 0.045, 0.05, depth * 0.95, 0.01, darkSteel());
  b.rbox(0, 0.1, 0, w - 0.05, 0.05, depth * 0.9, 0.01, steel(0x34373a, 0.7));
}

/** The seat everyone sits on: cushion, reclined back and a headrest. `w` is the width across the cushion. */
function seatCommon(b: MeshBuilder, w: number, look: SeatLook, o: { bolster?: number; head?: number; back?: number } = {}) {
  const depth = 0.52;
  seatFrame(b, w, depth);
  b.rbox(0, 0.205, 0, w, 0.15, depth, 0.05, look.cloth);
  // The back, leaning away from the driver.
  const bh = o.back ?? 0.6;
  b.rbox(0, 0.28 + bh / 2 - 0.02, -depth / 2 - 0.02, w, bh, 0.13, 0.05, look.cloth, -0.13, 0, 0);
  const hy = 0.28 + bh + 0.1;
  b.rbox(0, hy, -depth / 2 - 0.02 - (bh * Math.sin(0.13)), w * 0.46, o.head ?? 0.17, 0.09, 0.04, look.trim, -0.13, 0, 0);
  for (const sx of [1, -1]) b.rod(sx * w * 0.14, 0.28 + bh - 0.04, -depth / 2 - 0.02 - bh * 0.12, sx * w * 0.14, hy - 0.06, -depth / 2 - 0.02 - bh * 0.13, 0.012, S.metal(0x8a8e92, 0.4), 6);
  // Side bolsters, deeper on the racing seat.
  const bo = o.bolster ?? 0.04;
  for (const sx of [1, -1]) {
    b.rbox(sx * (w / 2 - 0.03), 0.275 + bo * 0.5, 0.02, 0.07, 0.04 + bo, depth * 0.84, 0.025, look.trim);
    b.rbox(sx * (w / 2 - 0.02), 0.28 + bh * 0.55, -depth / 2 + 0.01 - bh * 0.06, 0.07, bh * 0.7, 0.1 + bo * 1.2, 0.03, look.trim, -0.13, 0, 0);
  }
}

function seatModel(b: MeshBuilder, id: string, w = 0.54) {
  switch (id) {
    case 'seat_torn': {
      const cloth = S.cloth(0x5d594f, 0.8);
      const look = { cloth, trim: S.cloth(0x4a463e, 0.85), dark: S.cloth(0x2a2824) };
      seatCommon(b, w, look);
      // Gashes with the foam showing, and a spring through the back.
      const foam = S.cloth(0xcbb47c, 0.9);
      b.rbox(0.1, 0.285, 0.05, 0.2, 0.012, 0.16, 0.004, S.cloth(0x2a2420), 0, 0.3, 0);
      b.rbox(0.1, 0.292, 0.05, 0.14, 0.014, 0.1, 0.005, foam, 0, 0.3, 0);
      b.rbox(-0.12, 0.54, -0.33, 0.14, 0.2, 0.012, 0.004, foam, -0.13, 0, 0.5);
      b.torus(0.04, 0.8, -0.38, 0.03, 0.006, S.metal(0x8a8e92, 0.8), 0.2, 0, 0, 5, 12);
      b.torus(0.04, 0.83, -0.385, 0.026, 0.006, S.metal(0x8a8e92, 0.8), 0.2, 0, 0, 5, 12);
      b.rbox(-0.14, 0.26, -0.12, 0.12, 0.02, 0.04, 0.005, S.cloth(0x2a2420), 0, 0.8, 0);
      break;
    }
    case 'seat_bucket': {
      const black = S.cloth(0x202022, 0.7);
      const red = S.cloth(0xb0301e, 0.6);
      const look = { cloth: black, trim: red, dark: black };
      seatCommon(b, w * 0.9, look, { bolster: 0.1, head: 0.22, back: 0.62 });
      // Harness: two shoulder belts over the back and a lap belt, with a chrome buckle.
      for (const sx of [1, -1]) b.rbox(sx * 0.1, 0.62, -0.31, 0.05, 0.62, 0.012, 0.004, S.cloth(0x1c1c1c, 0.6), -0.13, 0, sx * 0.04);
      b.box(0, 0.3, 0.14, 0.4, 0.012, 0.05, S.cloth(0x1c1c1c, 0.6));
      b.rbox(0, 0.3, 0.17, 0.07, 0.02, 0.05, 0.006, chrome());
      // A headrest wing and a racing stripe down the middle.
      b.box(0, 0.285, 0.0, 0.05, 0.01, 0.5, S.cloth(0xe8e2d0, 0.7));
      break;
    }
    case 'seat_leather': {
      const tan = S.leather(0x8a5a32, 0.45);
      const look = { cloth: tan, trim: S.leather(0x6f4524, 0.5), dark: tan };
      seatCommon(b, w, look, { head: 0.2, back: 0.64 });
      const thread = S.cloth(0xe2d4a8, 0.5);
      for (const sx of [1, -1]) {
        b.box(sx * (w / 2 - 0.1), 0.283, 0.0, 0.006, 0.004, 0.5, thread);
        b.box(sx * (w / 2 - 0.1), 0.62, -0.31, 0.006, 0.5, 0.004, thread, -0.13, 0, 0);
      }
      b.box(0, 0.45, -0.3, w * 0.5, 0.006, 0.006, thread, -0.13, 0, 0);
      // An armrest on the inside edge.
      b.rbox(-w / 2 - 0.02, 0.4, -0.05, 0.05, 0.08, 0.28, 0.02, S.leather(0x6f4524, 0.5));
      break;
    }
    case 'seat_plate': {
      const cloth = S.cloth(0x4a4d48, 0.8);
      const look = { cloth, trim: S.cloth(0x3a3d3a, 0.85), dark: cloth };
      seatCommon(b, w * 0.96, look, { back: 0.56 });
      // A steel plate welded behind the back, riveted at the edge.
      plate(b, 0, 0.62, -0.4, w * 0.96, 0.6, 0.03, S.steel(0x5a5d60, 0.8), -0.13, 0, 0);
      rivets(b, [-0.2, 0.9, -0.43], [0.2, 0.9, -0.43], 4);
      b.rod(-0.22, 0.3, -0.34, -0.22, 0.88, -0.44, 0.014, darkSteel(), 6);
      b.rod(0.22, 0.3, -0.34, 0.22, 0.88, -0.44, 0.014, darkSteel(), 6);
      break;
    }
    default: {
      // Factory: cloth in a dull brown with a stained patch worn on the cushion and a seam down the back.
      const cloth = S.cloth(0x6e5f48, 0.75);
      const look = { cloth, trim: S.cloth(0x594c39, 0.8), dark: cloth };
      seatCommon(b, w, look);
      b.rbox(0.08, 0.283, 0.05, 0.2, 0.01, 0.2, 0.004, S.cloth(0x4a3f30, 0.9), 0, 0.2, 0);
      b.box(0, 0.6, -0.325, 0.006, 0.52, 0.006, S.cloth(0x3a3126, 0.9), -0.13, 0, 0);
    }
  }
}
/** A rear bench `w` wide: three places, belts, and a folding back. */
function benchModel(b: MeshBuilder, id: string, w = 1.2) {
  const depth = 0.5;
  if (id === 'bench_rack') {
    // Where the seat was: a steel frame with a plank floor, two ratchet straps and tie-down rings.
    const tube = S.steel(0x3a3d40, 0.7);
    const frame = [
      [w / 2 - 0.03, 0.2, depth / 2 - 0.03],
      [-w / 2 + 0.03, 0.2, depth / 2 - 0.03],
      [-w / 2 + 0.03, 0.2, -depth / 2 + 0.03],
      [w / 2 - 0.03, 0.2, -depth / 2 + 0.03],
      [w / 2 - 0.03, 0.2, depth / 2 - 0.03],
    ] as [number, number, number][];
    b.pipe(frame, 0.018, tube, 6);
    for (const [x, , z] of frame.slice(0, 4)) b.rod(x, 0.0, z, x, 0.2, z, 0.018, tube, 6);
    const n = Math.max(4, Math.round(w / 0.12));
    for (let i = 0; i < n; i++) b.box(-w / 2 + 0.05 + (i + 0.5) * ((w - 0.1) / n), 0.2, 0, (w - 0.1) / n - 0.012, 0.025, depth - 0.05, S.wood(i % 2 ? 0x6a5638 : 0x5a4830, 0.8));
    b.pipe([[-w / 2 + 0.03, 0.2, -depth / 2 + 0.03], [-w / 2 + 0.03, 0.62, -depth / 2 + 0.03], [w / 2 - 0.03, 0.62, -depth / 2 + 0.03], [w / 2 - 0.03, 0.2, -depth / 2 + 0.03]], 0.018, tube, 6);
    strap(b, [[-w * 0.2, 0.215, 0.2], [-w * 0.2, 0.215, -0.2], [-w * 0.2, 0.55, -depth / 2 + 0.03]]);
    strap(b, [[w * 0.2, 0.215, 0.2], [w * 0.2, 0.215, -0.2], [w * 0.2, 0.55, -depth / 2 + 0.03]]);
    for (const sx of [1, -1]) b.torus(sx * (w / 2 - 0.03), 0.3, depth / 2 - 0.03, 0.025, 0.006, steel(0x9a9ea2), 0, Math.PI / 2, 0, 5, 10);
    return;
  }
  const torn = id === 'bench_torn';
  const fold = id === 'bench_fold';
  const cloth = torn ? S.cloth(0x5d594f, 0.8) : fold ? S.cloth(0x2f3a45, 0.55) : S.cloth(0x6e5f48, 0.75);
  const trim = torn ? S.cloth(0x4a463e, 0.85) : fold ? S.cloth(0x24303a, 0.6) : S.cloth(0x594c39, 0.8);
  for (const sx of [1, -1]) b.rbox(sx * (w / 2 - 0.1), 0.035, 0, 0.05, 0.05, depth * 0.9, 0.01, darkSteel());
  b.rbox(0, 0.1, 0, w - 0.06, 0.05, depth * 0.9, 0.01, steel(0x34373a, 0.7));
  b.rbox(0, 0.2, 0, w, 0.14, depth, 0.05, cloth);
  b.rbox(0, 0.57, -depth / 2 - 0.02, w, 0.58, 0.12, 0.05, cloth, -0.13, 0, 0);
  // Seams between the three places, and headrests on the outer two.
  for (const sx of [1, -1]) {
    b.box(sx * w * 0.17, 0.205, 0.0, 0.006, 0.145, depth + 0.002, trim);
    b.box(sx * w * 0.17, 0.57, -depth / 2 + 0.045, 0.006, 0.55, 0.006, trim, -0.13, 0, 0);
    b.rbox(sx * w * 0.3, 0.94, -depth / 2 - 0.1, w * 0.18, 0.15, 0.08, 0.035, trim, -0.13, 0, 0);
    b.rod(sx * w * 0.3, 0.86, -depth / 2 - 0.08, sx * w * 0.3, 0.92, -depth / 2 - 0.095, 0.01, S.metal(0x8a8e92, 0.4), 6);
  }
  // Belt buckles in the gap behind the cushion.
  for (const sx of [1, -1]) b.rbox(sx * w * 0.17, 0.3, -depth / 2 + 0.03, 0.04, 0.025, 0.06, 0.008, S.plastic(0x1c1c1c, 0.5));
  if (torn) {
    // Stuffing spilling from a split seam, and a rip across the back.
    const foam = S.cloth(0xd8d0b8, 0.95);
    b.sphereAt(w * 0.28, 0.29, 0.1, 0.07, foam);
    b.sphereAt(w * 0.32, 0.285, 0.04, 0.05, foam);
    b.rbox(w * 0.1, 0.285, 0.1, 0.3, 0.012, 0.03, 0.004, S.cloth(0x2a2420), 0, 0.2, 0);
    b.rbox(-w * 0.2, 0.55, -depth / 2 + 0.05, 0.22, 0.012, 0.18, 0.004, S.cloth(0x2a2420), -0.13, 0, 0.7);
    b.rbox(-w * 0.2, 0.55, -depth / 2 + 0.056, 0.14, 0.012, 0.1, 0.004, foam, -0.13, 0, 0.7);
  } else if (fold) {
    // The fold-flat mechanism: two hinge brackets, a release strap and a load-floor lip.
    for (const sx of [1, -1]) {
      b.box(sx * (w / 2 - 0.05), 0.3, -depth / 2 + 0.02, 0.05, 0.1, 0.04, steel(0x7a7e82, 0.5));
      b.cyl(sx * (w / 2 - 0.05), 0.3, -depth / 2 + 0.04, 0.035, 0.07, 0.035, chrome(), 0, 0, Math.PI / 2, 8);
    }
    b.box(0, 0.78, -depth / 2 - 0.02, 0.05, 0.14, 0.008, S.cloth(0xd6a21e, 0.5), -0.13, 0, 0);
    b.box(0, 0.285, depth / 2 - 0.01, w - 0.1, 0.01, 0.02, steel(0xb4b8bc, 0.4));
  }
}

/** The steering wheel's rim and spokes, in the wheel's own frame: the plane is XY and the axis is Z, facing -Z. */
export function steerRim(b: MeshBuilder, id: string) {
  const R = id === 'steer_sport' ? 0.135 : 0.175;
  const hub = S.plastic(0x1c1c1c, 0.4);
  if (id === 'steer_sport') {
    b.torus(0, 0, 0, R, 0.017, S.leather(0x2a2724, 0.6), 0, 0, 0, 8, 28);
    // A flat bottom, three drilled alloy spokes and a stripe at the top.
    b.box(0, -R + 0.002, 0, R * 1.0, 0.012, 0.03, S.leather(0x2a2724, 0.6));
    for (const a of [0, 2.2, -2.2]) b.box(Math.sin(a) * R * 0.52, Math.cos(a) * R * 0.52, 0, 0.022, R * 1.0, 0.012, S.metal(0xa4a8ac, 0.35), 0, 0, -a);
    b.box(0, R, -0.016, 0.02, 0.016, 0.004, S.paint(0xd62a1a, 0.4));
    b.cyl(0, 0, -0.005, 0.07, 0.04, 0.07, hub, Math.PI / 2, 0, 0, 12);
    b.cyl(0, 0, -0.026, 0.045, 0.006, 0.045, S.paint(0xd62a1a, 0.4), Math.PI / 2, 0, 0, 12);
    return;
  }
  if (id === 'steer_chain') {
    // A plain rim wound with chain: a ring of links, alternating flat and edge on.
    b.torus(0, 0, 0, R, 0.02, S.rubber(0x1c1c1e), 0, 0, 0, 7, 24);
    const n = 30;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      b.torus(Math.cos(a) * R, Math.sin(a) * R, 0, 0.016, 0.0045, S.metal(0x9a9ea2, 0.5), i % 2 ? 0 : Math.PI / 2, a + (i % 2 ? Math.PI / 2 : 0), 0, 4, 8);
    }
    for (const a of [Math.PI / 2, Math.PI * 1.5, 0]) b.box(Math.cos(a) * R * 0.5, Math.sin(a) * R * 0.5, 0, 0.026, R * 1.0, 0.014, S.plastic(0x242424, 0.5), 0, 0, a + Math.PI / 2);
    b.cyl(0, 0, -0.005, 0.08, 0.05, 0.08, hub, Math.PI / 2, 0, 0, 10);
    return;
  }
  // Factory: a thick plastic rim, three spokes and a horn pad.
  b.torus(0, 0, 0, R, 0.021, S.plastic(0x1e1e1e, 0.5), 0, 0, 0, 8, 28);
  for (const a of [Math.PI / 2, Math.PI * 1.5, Math.PI]) b.box(Math.cos(a) * R * 0.5, Math.sin(a) * R * 0.5, 0, 0.034, R * 1.0, 0.016, S.plastic(0x242424, 0.5), 0, 0, a + Math.PI / 2);
  b.cyl(0, 0, -0.005, 0.1, 0.055, 0.1, hub, Math.PI / 2, 0, 0, 12);
  b.cyl(0, 0, -0.034, 0.04, 0.008, 0.04, chrome(), Math.PI / 2, 0, 0, 10);
}

/** The column behind the wheel: shroud, stalks and the ignition. Runs from the hub along +Z. */
export function steerColumn(b: MeshBuilder, len = 0.42) {
  b.cyl(0, 0, len / 2 + 0.03, 0.065, len, 0.065, S.plastic(0x1e1e1e, 0.5), Math.PI / 2, 0, 0, 10);
  b.cyl(0.0, -0.02, 0.09, 0.09, 0.1, 0.1, S.plastic(0x2a2a2a, 0.5), Math.PI / 2, 0, 0, 10);
  // Indicator and wiper stalks and the key barrel.
  b.rod(0.06, 0.0, 0.1, 0.15, -0.01, 0.07, 0.008, S.plastic(0x1a1a1a, 0.4), 5);
  b.rod(-0.06, 0.0, 0.1, -0.15, -0.01, 0.07, 0.008, S.plastic(0x1a1a1a, 0.4), 5);
  b.cyl(0.02, -0.075, 0.12, 0.028, 0.03, 0.028, S.metal(0xb4b8bc, 0.4), 0, 0, 0, 8);
}

/** A steering wheel as a whole part (carried or on the ground): wheel on its column, leaning on a stand. */
function steerModel(b: MeshBuilder, id: string) {
  const tilt = 0.95;
  const m = new THREE.Matrix4().compose(new THREE.Vector3(0, STEER_HUB, 0), new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt, 0, 0)), new THREE.Vector3(1, 1, 1));
  const rim = new MeshBuilder();
  steerRim(rim, id);
  steerColumn(rim, 0.3);
  b.appendMatrix(rim, m);
  b.rbox(0, 0.04, 0.12, 0.3, 0.05, 0.3, 0.01, darkSteel());
  b.rod(0, STEER_HUB - 0.12, 0.11, 0, 0.05, 0.12, 0.018, darkSteel(), 6);
}

/** One round dial on a dash: bezel, face, needle. Faces -Z. */
function dial(b: MeshBuilder, x: number, y: number, z: number, r: number, face = 0xd8dcd0, warn = false) {
  b.cyl(x, y, z, r * 2.2, 0.03, r * 2.2, S.plastic(0x0e0e0e, 0.4), Math.PI / 2, 0, 0, 14);
  b.cyl(x, y, z - 0.012, r * 1.9, 0.01, r * 1.9, S.plastic(face, 0.3), Math.PI / 2, 0, 0, 14);
  b.box(x + r * 0.2, y + r * 0.15, z - 0.02, r * 0.12, r * 1.2, 0.004, S.paint(warn ? 0xe0a01a : 0xd62a1a, 0.4), 0, 0, -0.7);
}

/** The dashboard `w` wide, base on the floor line of the model, `driverX` the side the instruments face. */
function dashModel(b: MeshBuilder, id: string, w = 1.4, driverX = 1) {
  const D = 0.34;
  const hw = w / 2;
  const x0 = driverX * hw * 0.5;
  if (id === 'dash_gauge') {
    const alu = S.metal(0x8a8e92, 0.45);
    const matt = S.plastic(0x1e1f20, 0.55);
    b.rbox(0, 0.13, 0, w, 0.2, D, 0.03, matt);
    b.rbox(0, 0.26, 0.02, w, 0.06, D + 0.04, 0.025, matt);
    // A brushed panel with a pod of race gauges in front of the driver and toggles along the centre.
    b.rbox(0, 0.17, -D / 2 + 0.003, w * 0.8, 0.14, 0.012, 0.004, alu);
    b.rbox(x0, 0.31, -0.02, 0.5, 0.11, 0.2, 0.04, matt);
    dial(b, x0 + 0.16, 0.31, -0.125, 0.045, 0xe8e2d0);
    dial(b, x0, 0.31, -0.125, 0.06, 0xe8e2d0);
    dial(b, x0 - 0.16, 0.31, -0.125, 0.045, 0xe8e2d0, true);
    dial(b, x0 - 0.1, 0.19, -D / 2 - 0.01, 0.035, 0xe8e2d0);
    dial(b, x0 + 0.1, 0.19, -D / 2 - 0.01, 0.035, 0xe8e2d0, true);
    for (let i = 0; i < 6; i++) {
      b.cyl(-driverX * 0.12 + i * 0.07 * -driverX, 0.2, -D / 2 - 0.012, 0.02, 0.03, 0.02, S.metal(0xc4c8cc, 0.3), Math.PI / 2, 0, 0, 6);
      b.rbox(-driverX * 0.12 + i * 0.07 * -driverX, 0.16, -D / 2 - 0.008, 0.032, 0.012, 0.016, 0.004, i === 2 ? S.paint(0xd62a1a, 0.4) : S.plastic(0x2a2a2a, 0.4));
    }
    rivets(b, [-hw * 0.78, 0.235, -D / 2 - 0.005], [hw * 0.78, 0.235, -D / 2 - 0.005], 14, 0.008, steel(0xc4c8cc, 0.4));
    return;
  }
  const cracked = id === 'dash_cracked';
  const body = S.plastic(cracked ? 0x4b4943 : 0x2b2926, cracked ? 0.7 : 0.45);
  const top = S.plastic(cracked ? 0x5c5951 : 0x34312e, 0.55);
  b.rbox(0, 0.12, 0, w, 0.2, D, 0.04, body);
  b.rbox(0, 0.245, 0.025, w, 0.07, D + 0.05, 0.035, top);
  // The cluster hood over the instruments and the glovebox on the far side.
  b.rbox(x0, 0.3, -0.08, 0.46, 0.1, 0.22, 0.04, body);
  dial(b, x0 + 0.1, 0.285, -0.19, 0.055);
  dial(b, x0 - 0.1, 0.285, -0.19, 0.045, 0xd8dcd0, true);
  if (!cracked) dial(b, x0 + 0.0, 0.215, -D / 2 - 0.012, 0.03);
  b.rbox(-driverX * hw * 0.5, 0.15, -D / 2 - 0.005, w * 0.3, 0.12, 0.014, 0.01, S.plastic(cracked ? 0x3a3935 : 0x23211f, 0.5));
  b.rbox(-driverX * hw * 0.5, 0.155, -D / 2 - 0.016, 0.04, 0.012, 0.01, 0.003, steel(0x7a7e82, 0.4));
  // Vents, and a radio where one is fitted.
  for (let i = 0; i < 4; i++) b.box(-driverX * hw * 0.06, 0.21 - i * 0, -D / 2 - 0.008, 0.02, 0.05, 0.008, S.plastic(0x141414, 0.4), 0, 0, 0);
  for (const dx of [-0.07, 0.07]) for (let i = 0; i < 3; i++) b.box(dx - driverX * hw * 0.06 + dx * 0.4, 0.2 + i * 0.016 - 0.016, -D / 2 - 0.008, 0.09, 0.006, 0.006, S.plastic(0x141414, 0.4));
  if (!cracked) {
    b.rbox(0, 0.1, -D / 2 - 0.005, 0.28, 0.07, 0.016, 0.006, S.plastic(0x161616, 0.4));
    for (const dx of [-0.1, 0.1]) b.cyl(dx, 0.1, -D / 2 - 0.02, 0.025, 0.014, 0.025, S.metal(0x9a9ea2, 0.4), Math.PI / 2, 0, 0, 8);
  } else {
    // Cracks running from a missing corner, a hole where the radio was, and tape.
    const dk = S.plastic(0x0e0d0c, 0.5);
    b.rbox(0, 0.1, -D / 2 - 0.004, 0.22, 0.07, 0.012, 0.004, dk);
    for (let i = 0; i < 7; i++) b.box(-driverX * (0.12 + i * 0.07), 0.27 - (i % 3) * 0.015, -D / 2 - 0.02 + (i % 2) * 0.03, 0.14 + (i % 3) * 0.04, 0.004, 0.006, dk, 0, 0, (i - 3) * 0.45);
    b.rbox(-driverX * hw * 0.78, 0.275, -0.06, 0.18, 0.05, 0.22, 0.01, dk);
    b.box(-driverX * hw * 0.5, 0.23, -0.02, 0.5, 0.012, 0.3, S.cloth(0x8a8f94, 0.5), 0, 0.1, 0);
  }
}

/** The bare mounts where a seat was: runner stubs, studs, a loose belt and a cut loom. */
function seatGap(b: MeshBuilder, w = 0.54) {
  const rust = S.rust(0x5a3a22);
  for (const sx of [1, -1]) {
    b.rbox(sx * (w / 2 - 0.08), 0.03, 0, 0.045, 0.045, 0.5, 0.008, rust);
    for (const z of [-0.2, 0.2]) b.cyl(sx * (w / 2 - 0.08), 0.065, z, 0.022, 0.05, 0.022, S.metal(0x9a9ea2, 0.4), 0, 0, 0, 6);
  }
  b.box(0, 0.012, 0, w * 0.7, 0.012, 0.55, S.rust(0x3e2a1c));
  // A seat belt lying on the floor, and the cut seat wiring.
  b.box(0.04, 0.02, 0.12, 0.04, 0.008, 0.4, S.cloth(0x2a2a2a, 0.6), 0, 0.3, 0);
  b.rbox(0.1, 0.03, 0.3, 0.04, 0.025, 0.06, 0.008, S.plastic(0x1c1c1c, 0.5), 0, 0.3, 0);
  b.pipe([[-0.1, 0.04, -0.1], [-0.16, 0.06, -0.02], [-0.14, 0.03, 0.08]], 0.007, S.rubber(0xb0301e), 4);
  b.pipe([[-0.1, 0.04, -0.1], [-0.2, 0.05, -0.05], [-0.22, 0.03, 0.04]], 0.007, S.rubber(0xd8c050), 4);
}

/** The bare floor where a rear seat was. */
function benchGap(b: MeshBuilder, w = 1.2) {
  const rust = S.rust(0x5a3a22);
  b.box(0, 0.012, 0, w * 0.9, 0.012, 0.5, S.rust(0x3e2a1c));
  for (const z of [-0.18, 0.18]) {
    b.rbox(0, 0.03, z, w * 0.82, 0.03, 0.045, 0.008, rust);
    for (const sx of [1, -1]) b.cyl(sx * w * 0.36, 0.06, z, 0.025, 0.04, 0.025, S.metal(0x9a9ea2, 0.4), 0, 0, 0, 6);
  }
  for (const sx of [1, -1]) b.rbox(sx * (w / 2 - 0.06), 0.06, -0.24, 0.06, 0.12, 0.05, 0.01, S.metal(0x7a7e82, 0.5));
  b.box(0.1, 0.02, 0.0, 0.04, 0.008, 0.45, S.cloth(0x2a2a2a, 0.6), 0, 0.2, 0);
}

/** What is left of the column where the wheel was, in the wheel's frame: the shroud, a bare splined shaft and loose horn wires. */
export function steerStub(b: MeshBuilder) {
  steerColumn(b, 0.3);
  b.cyl(0, 0, 0.0, 0.032, 0.06, 0.032, S.metal(0xb4b8bc, 0.5), Math.PI / 2, 0, 0, 8);
  b.pipe([[0.02, 0.01, 0.02], [0.08, 0.06, -0.04], [0.12, 0.02, -0.1]], 0.006, S.rubber(0xd8c050), 4);
  b.pipe([[-0.02, 0.01, 0.02], [-0.07, 0.07, -0.05], [-0.1, 0.0, -0.11]], 0.006, S.rubber(0xb0301e), 4);
  b.pipe([[0.0, -0.02, 0.02], [0.0, -0.08, -0.06], [0.04, -0.14, -0.09]], 0.006, S.rubber(0x2a6ab8), 4);
}

/** The column stub where the wheel was, standing on its stand. */
function steerGap(b: MeshBuilder) {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(0, STEER_HUB, 0), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.95, 0, 0)), new THREE.Vector3(1, 1, 1));
  const col = new MeshBuilder();
  steerStub(col);
  b.appendMatrix(col, m);
  b.rbox(0, 0.04, 0.12, 0.3, 0.05, 0.3, 0.01, darkSteel());
}

/** The cross-car beam and loose wiring where a dashboard was. */
function dashGap(b: MeshBuilder, w = 1.4, driverX = 1) {
  const hw = w / 2;
  const beam = S.steel(0x3a3d40, 0.7);
  b.rod(-hw + 0.05, 0.24, 0.05, hw - 0.05, 0.24, 0.05, 0.035, beam, 8);
  for (const x of [-hw * 0.8, -hw * 0.3, hw * 0.3, hw * 0.8]) {
    b.rbox(x, 0.12, 0.08, 0.04, 0.24, 0.05, 0.008, S.rust(0x4a3626));
  }
  // The column bracket on the driver's side, with its cut stub.
  b.rbox(driverX * hw * 0.5, 0.2, 0.0, 0.14, 0.12, 0.12, 0.02, steel(0x5a5d60, 0.6));
  // A loom of coloured wire hanging in loops, and the heater box behind.
  const cols = [0xb0301e, 0xd8c050, 0x2a6ab8, 0x2a2a2a, 0x3a8a4a];
  cols.forEach((c, i) => {
    const x = -hw * 0.7 + i * (w * 0.2);
    b.pipe([[x, 0.25, 0.04], [x + 0.05, 0.14, -0.04], [x + 0.02, 0.06, -0.1], [x + 0.09, 0.03, -0.07]], 0.008, S.rubber(c), 4);
  });
  b.rbox(-driverX * hw * 0.3, 0.14, 0.12, 0.36, 0.22, 0.14, 0.03, S.plastic(0x1c1c1c, 0.6));
  for (let i = 0; i < 3; i++) b.cyl(driverX * hw * 0.1 + i * 0.07, 0.3, 0.0, 0.03, 0.03, 0.03, S.metal(0xc0a040, 0.3), 0, 0, 0, 6);
}

export interface CabinSize {
  /** Width across the cushion of a seat, or the whole bench or dash. */
  w?: number;
  /** Which side the instruments face: +1 for a driver on the +X side. */
  driverX?: number;
}

/**
 * Draw one cabin part, or the gap where it is not. Local frame as above; `o.w` sizes a bench or a dash to its car.
 * Used for the car's interior, the arms, the ground and the cargo deck.
 */
export function cabinPartModel(b: MeshBuilder, id: string, o: CabinSize = {}) {
  const d = partDef(id);
  switch (d.slot) {
    case 'seatD':
    case 'seatP':
      return d.empty ? seatGap(b, o.w ?? 0.54) : seatModel(b, id, o.w ?? 0.54);
    case 'seatR':
      return d.empty ? benchGap(b, o.w ?? 1.2) : benchModel(b, id, o.w ?? 1.2);
    case 'steer':
      return d.empty ? steerGap(b) : steerModel(b, id);
    case 'dash':
      return d.empty ? dashGap(b, o.w ?? 1.4, o.driverX ?? 1) : dashModel(b, id, o.w ?? 1.4, o.driverX ?? 1);
  }
}
