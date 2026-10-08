import { M, shape, rrect, type P2, type WB, type WS } from './kit';

/**
 * Handguns: the polymer striker pistols (a full-size duty pistol, the subcompact, and the select-fire machine pistol with
 * its long magazine) and the double-action revolvers (a service .38 and the big-frame .44). Real proportions: a 186 mm
 * slide, 25 mm wide; a K-frame revolver with a 4-inch barrel; the .44 an N-frame with a 6.5-inch ribbed barrel.
 *
 * Grips rake back the way real ones do (the bottom of the grip behind its top), about 19 degrees on the pistols and 26 on
 * the revolvers' round butts. The hands in `viewmodel.ts` are laid on these numbers (`HANDGUN_GRIPS`).
 */

/** Rake of a pistol grip from the vertical (its bottom behind its top), as dz per metre of drop. */
export const PISTOL_RAKE = Math.tan((19 * Math.PI) / 180);
export const REVOLVER_RAKE = Math.tan((26 * Math.PI) / 180);

export interface PistolDims {
  key: string;
  /** Bore height, slide rear and front. */
  bore: number;
  z0: number;
  z1: number;
  /** Bottom of the grip (the magazine's base plate below it). */
  gripBottom: number;
  /** How far a magazine sticks out below the grip (the machine pistol's 33-rounder). */
  magOut?: number;
  /** A selector on the slide's back, a compensator cut in the slide's nose. */
  select?: boolean;
  comp?: boolean;
  /** The frame's colour (some are tan). */
  frame?: number;
}

/** The height of the line of sight over the slide's top. */
const SIGHT_H = 0.009;

export const PISTOL: PistolDims = { key: 'p17', bore: 0.035, z0: -0.004, z1: 0.182, gripBottom: -0.086 };
export const COMPACT: PistolDims = { key: 'p26', bore: 0.034, z0: -0.004, z1: 0.152, gripBottom: -0.052 };
export const MACHINE: PistolDims = { key: 'p18', bore: 0.035, z0: -0.004, z1: 0.182, gripBottom: -0.086, magOut: 0.085, select: true, comp: true };

/** Where a polymer pistol's sights are (notch and post), its muzzle and the bottom of its magazine. */
export function pistolPoints(d: PistolDims) {
  const yt = d.bore + 0.0165;
  const ys = yt + SIGHT_H;
  return { rear: [0, ys, d.z0 + 0.0095] as const, front: [0, ys, d.z1 - 0.011] as const, muzzle: [0, d.bore, d.z1 + 0.001] as const, top: yt, floor: d.gripBottom - 0.007 - (d.magOut ?? 0) };
}

/** A polymer striker pistol: nitrided slide with its port, serrations and sights; a stippled polymer frame. */
export function polymerPistol(w: WB, d: PistolDims) {
  const B = d.bore;
  const yb = B - 0.0155;
  const yt = B + 0.0165;
  const hw = 0.0127;
  const ys = yt + SIGHT_H;
  const { z0, z1 } = d;
  const slide = M.nitride(0x2a2b2d, 0.3);
  const frame = M.poly(d.frame ?? 0x1d1e20, 0.3);
  const grip = M.stipple(d.frame ?? 0x1c1d1f, 0.3);
  const steel = M.steel(0x5e6266, 0.3);
  const dark = M.blued(0x17181b, 0.2);
  const K = d.key;
  const zp0 = z0 + 0.06;
  const zp1 = zp0 + 0.047;

  // ---- slide: three sweeps (behind the port, the port, ahead of it), the ends overlapping so no seam shows.
  const full = (inset = 0) => (): ReturnType<typeof shape> =>
    shape([[-hw + inset, yb, 0.0012], [hw - inset, yb, 0.0012], [hw - inset, yt - 0.003, 0.0006], [hw - 0.0035, yt, 0.0012], [-hw + 0.0035, yt, 0.0012], [-hw + inset, yt - 0.003, 0.0006]]);
  w.sec(`${K}.slideR`, full(), z0, z0 + 0.004, 0.0012, slide);
  w.sec(`${K}.slideRs`, full(0.0006), z0 + 0.0035, z0 + 0.034, 0, slide);
  w.sec(`${K}.slideRb`, full(), z0 + 0.0335, zp0 + 0.0008, 0, slide);
  // The port: the top right cut away, the barrel's hood showing in it.
  w.sec(
    `${K}.slideP`,
    () => shape([[-hw, yb, 0.0012], [hw, yb, 0.0012], [hw, yt - 0.003, 0.0006], [hw - 0.0035, yt, 0.0012], [-0.0005, yt], [-0.0005, B + 0.002], [-hw, B + 0.002]]),
    zp0,
    zp1,
    0,
    slide,
  );
  const front = () =>
    shape(
      [[-hw, yb, 0.0012], [hw, yb, 0.0012], [hw, yt - 0.003, 0.0006], [hw - 0.0035, yt, 0.0012], [-hw + 0.0035, yt, 0.0012], [-hw, yt - 0.003, 0.0006]],
      [{ c: [0, B], r: 0.0069 }, { c: [0, yb + 0.0048], r: 0.0033 }],
    );
  w.sec(`${K}.slideF`, front, zp1 - 0.0008, z1, 0.0012, slide);
  if (d.comp) {
    // Compensator ports cut through the top of the slide's nose, over the barrel.
    for (let i = 0; i < 2; i++) w.box(0, yt + 0.0002, z1 - 0.022 + i * 0.008, 0.0045, 0.0006, 0.004, M.hole());
  }
  // Cocking serrations at the back of the slide (ribs proud of the slide where it is narrowed between them), and at the front.
  if (w.hi) {
    for (let i = 0; i < 8; i++) w.rbox(0, yb + 0.0125, z0 + 0.007 + i * 0.0036, 0.0254, 0.019, 0.0016, 0.0005, slide);
  }
  // The slide's back plate and the extractor at the back of the port.
  w.rbox(0, B + 0.0005, z0 - 0.0003, 0.0145, 0.019, 0.0012, 0.0005, dark);
  w.rbox(-hw - 0.0002, B + 0.006, zp0 - 0.008, 0.0012, 0.0045, 0.016, 0.0004, slide);
  // The barrel: its hood in the port, its crown in the slide's nose, the guide rod under it.
  w.rbox(-0.001, B + 0.006, (zp0 + zp1) / 2 - 0.001, 0.0146, 0.0105, zp1 - zp0 + 0.002, 0.0012, steel);
  w.box(-hw / 2 - 0.004, B + 0.0021, (zp0 + zp1) / 2, hw - 0.006, 0.0006, zp1 - zp0 - 0.002, M.hole());
  w.bored(0, B, z1 - 0.03, z1 - 0.0008, 0.0066, 0.0045, steel, 0.025);
  w.tube(0, yb + 0.0048, z1 - 0.02, z1 - 0.0012, 0.003, M.poly(0x2a2a2c));

  // ---- sights: a U-notch rear with a white outline, a post with a white dot.
  w.sec(
    `${K}.rearSight`,
    () => shape([[-0.0105, yt - 0.0006], [0.0105, yt - 0.0006], [0.0105, ys + 0.0026, 0.0012], [0.0019, ys + 0.0026, 0.0003], [0.0019, ys + 0.0005, 0.0004], [-0.0019, ys + 0.0005, 0.0004], [-0.0019, ys + 0.0026, 0.0003], [-0.0105, ys + 0.0026, 0.0012]]),
    z0 + 0.004,
    z0 + 0.015,
    0.0006,
    dark,
  );
  if (w.hi) {
    const zr = z0 + 0.0038;
    for (const s of [1, -1]) w.box(s * 0.0034, ys + 0.0006, zr, 0.0012, 0.0036, 0.0004, M.dot());
    w.box(0, ys - 0.0012, zr, 0.0074, 0.0011, 0.0004, M.dot());
  }
  w.rbox(0, (yt + ys) / 2, z1 - 0.011, 0.0034, ys - yt + 0.0006, 0.0072, 0.0006, dark);
  w.turn(`${K}.fdot`, [[0, 0], [0.00115, 0], [0.00115, 0.0003], [0, 0.0003]], 0, ys - 0.0019, M.dot(), 10, 0.7, z1 - 0.0151);

  // ---- frame: the dust cover with its rail slot, the rails under the slide, the trigger guard, the grip.
  const zd = zp1 - 0.008;
  w.side(`${K}.dust`, () => shape([[zd, yb], [z1 - 0.006, yb], [z1 - 0.006, yb - 0.0085, 0.003], [z1 - 0.016, yb - 0.0125, 0.0015], [zd, yb - 0.0125]]), 0, 0.0232, 0.0016, frame);
  if (w.hi) w.box(0, yb - 0.0127, z1 - 0.03, 0.0236, 0.0016, 0.004, M.hole());
  const zg = zd + 0.002;
  const yg = yb - 0.0125;
  // The guard: squared off at the front, hooked a little for a finger.
  w.side(
    `${K}.guard`,
    () =>
      shape(
        [[zg - 0.06, yg], [zg + 0.002, yg], [zg + 0.006, yg - 0.016, 0.003], [zg + 0.003, yg - 0.0265, 0.004], [zg - 0.052, yg - 0.025, 0.008], [zg - 0.06, yg - 0.012]],
        [[[zg - 0.053, yg - 0.002], [zg - 0.004, yg - 0.002], [zg - 0.001, yg - 0.016, 0.003], [zg - 0.005, yg - 0.021, 0.004], [zg - 0.047, yg - 0.0195, 0.007], [zg - 0.053, yg - 0.012, 0.002]]],
      ),
    0,
    0.0095,
    0.0018,
    frame,
  );
  // The frame under the slide's back, the beavertail tang reaching back over the web of the hand.
  const zf = zg - 0.06;
  w.side(`${K}.upper`, () => shape([[z0 - 0.008, yb - 0.004, 0.003], [z0 + 0.002, yb], [zd + 0.001, yb], [zd + 0.001, yg], [zf, yg], [zf - 0.004, yg - 0.01], [z0 + 0.004, yg - 0.012], [z0 - 0.009, yb - 0.012, 0.004]]), 0, 0.0232, 0.0015, frame);
  // The grip, raked back: the front strap straight, a swell in the back strap, a flared magazine well at the bottom.
  const R = PISTOL_RAKE;
  const yTop = yg - 0.004;
  const fz = (y: number) => zf - 0.001 + R * (y - (yg - 0.012));
  const bz = (y: number) => z0 + 0.003 + R * (y - yTop);
  const yB = d.gripBottom;
  // The outline of the grip's flat sides; its rounded edges stand out round it by `gb`.
  const gb = 0.0055;
  const gw = 0.0305;
  const gripPts: P2[] = [
    [bz(yTop) - 0.002 + gb, yTop + 0.001],
    [fz(yTop) + 0.004 - gb, yTop + 0.001],
    [fz(yg - 0.016) + 0.001 - gb, yg - 0.016, 0.006],
    [fz((yg + yB) / 2) + 0.0012 - gb, (yg + yB) / 2, 0.03],
    [fz(yB) + 0.003 - gb, yB + gb, 0.004],
    [bz(yB) - 0.003 + gb, yB + gb, 0.004],
    [bz((yTop + yB) / 2 - 0.008) - 0.0028 + gb, (yTop + yB) / 2 - 0.008, 0.04],
    [bz(yTop - 0.004) - 0.0008 + gb, yTop - 0.004, 0.006],
  ];
  w.side(`${K}.grip`, () => shape(gripPts), 0, gw, gb, grip);
  // The base plate under the magazine well, or the long magazine hanging out of it.
  const mo = d.magOut ?? 0;
  if (mo > 0) {
    const mt = yB + 0.004;
    const mb = yB - mo;
    w.side(`${K}.mag`, () => shape([[bz(mt) + 0.004, mt], [fz(mt) - 0.004, mt], [fz(mb) - 0.002, mb], [bz(mb) + 0.004, mb]]), 0, 0.0225, 0.0018, M.blued(0x1c1d20, 0.35));
    w.side(`${K}.magb`, () => shape([[bz(mb) + 0.0025, mb + 0.002, 0.001], [fz(mb) - 0.001, mb + 0.002, 0.001], [fz(mb) + 0.001, mb - 0.006, 0.002], [bz(mb) + 0.002, mb - 0.006, 0.002]]), 0, 0.026, 0.0015, frame);
  } else {
    w.side(`${K}.base`, () => shape([[bz(yB) - 0.001, yB + 0.001, 0.001], [fz(yB) + 0.0015, yB + 0.001, 0.001], [fz(yB) + 0.002, yB - 0.006, 0.002], [bz(yB) - 0.0015, yB - 0.006, 0.002]]), 0, 0.0275, 0.0016, frame);
  }
  // Trigger: a curved blade with the safety lever down its face; its pin above in the frame.
  const zt = zg - 0.03;
  w.side(`${K}.trig`, () => shape([[zt - 0.003, yg + 0.001], [zt + 0.003, yg + 0.001], [zt + 0.0065, yg - 0.008, 0.004], [zt + 0.005, yg - 0.0145, 0.003], [zt + 0.0025, yg - 0.0145, 0.001], [zt + 0.0032, yg - 0.008, 0.004], [zt - 0.001, yg - 0.002]]), 0, 0.0062, 0.0011, frame);
  w.side(`${K}.trigS`, () => shape([[zt + 0.0032, yg - 0.003], [zt + 0.0068, yg - 0.0085, 0.003], [zt + 0.0058, yg - 0.0125, 0.002], [zt + 0.0045, yg - 0.0085, 0.003]]), 0, 0.0018, 0.0004, M.poly(0x101012));
  // Controls on the left: the magazine catch behind the guard, the slide stop above the grip; the takedown tabs both sides.
  w.rbox(0.0151, yg - 0.009, zf - 0.0025, 0.0028, 0.0095, 0.0062, 0.0011, frame);
  w.rbox(0.0122, yb - 0.003, zf - 0.012, 0.0014, 0.0028, 0.024, 0.0006, dark);
  w.rbox(0.0127, yb - 0.0045, zf - 0.019, 0.0024, 0.0045, 0.006, 0.0008, dark);
  for (const s of [1, -1]) w.rbox(s * 0.0121, yb - 0.004, zt + 0.006, 0.0016, 0.0042, 0.0085, 0.0005, dark);
  w.pin(0.0116, yb - 0.0085, zt - 0.003, 0.0013, steel);
  w.pin(0.0116, yb - 0.0055, zt + 0.019, 0.0013, steel);
  w.pin(0.0116, yb - 0.008, z0 + 0.012, 0.0012, steel);
  if (d.select) {
    // The fire selector on the left of the slide's back plate.
    w.rbox(0.0072, B + 0.002, z0 - 0.0012, 0.0048, 0.0028, 0.0022, 0.0006, steel);
  }
  // A lanyard loop cut in the back strap's foot, and the frame's finger rest.
  if (w.hi) w.box(0, yB + 0.004, bz(yB + 0.004) + 0.001, 0.008, 0.003, 0.0006, M.hole());
}

// ---------------------------------------------------------------------------------------------------------- revolvers

export interface RevolverDims {
  key: string;
  bore: number;
  /** Cylinder: axis height, from and to (z), radius, how far the chambers are off the axis, the chamber's radius. */
  cy: number;
  c0: number;
  c1: number;
  cr: number;
  pitch: number;
  ch: number;
  /** Muzzle, barrel radius, and a full underlug and ventilated rib (the .44). */
  muzzle: number;
  br: number;
  lug?: boolean;
  rib?: boolean;
  /** Stocks: walnut service stocks or a rubber combat grip. */
  rubber?: boolean;
  finish: 'blued' | 'stainless';
}

export const REVOLVER: RevolverDims = { key: 'k38', bore: 0.04, cy: 0.0285, c0: 0.056, c1: 0.096, cr: 0.0181, pitch: 0.0115, ch: 0.0047, muzzle: 0.205, br: 0.0072, finish: 'blued' };
export const CANNON: RevolverDims = { key: 'n44', bore: 0.044, cy: 0.0302, c0: 0.054, c1: 0.1, cr: 0.0213, pitch: 0.0138, ch: 0.0057, muzzle: 0.275, br: 0.0095, lug: true, rib: true, rubber: true, finish: 'stainless' };

export function revolverPoints(d: RevolverDims) {
  const top = d.bore + (d.rib ? 0.017 : 0.0135);
  return { rear: [0, top, d.c0 - 0.006] as const, front: [0, top, d.muzzle - 0.008] as const, muzzle: [0, d.bore, d.muzzle + 0.001] as const };
}

/** A double-action revolver: frame with top strap and recoil shield, fluted cylinder, barrel, hammer, wood or rubber grips. */
export function revolver(w: WB, d: RevolverDims) {
  const K = d.key;
  const B = d.bore;
  const metal: WS = d.finish === 'blued' ? M.blued(0x1a1d24, 0.32) : M.bright(0x9a9ea2, 0.25);
  const dark: WS = d.finish === 'blued' ? M.blued(0x121418, 0.25) : M.bright(0x7c8084, 0.25);
  const { c0, c1, cy, cr } = d;
  const fw = cr * 1.86;
  const top = B + (d.rib ? 0.0125 : 0.0105);
  const yb = cy - cr - 0.004;
  // ---- frame: the window the cylinder sits in, the top strap over it, the barrel shank and the recoil shield.
  const zr = c0 - 0.024;
  w.side(
    `${K}.frame`,
    () =>
      shape(
        [[zr, B + 0.004, 0.006], [zr + 0.01, top, 0.004], [c1 + 0.016, top, 0.002], [c1 + 0.017, B - 0.008], [c1 + 0.008, yb + 0.002, 0.004], [c1 - 0.004, yb - 0.006, 0.003], [c0 - 0.012, yb - 0.008], [zr - 0.005, yb - 0.012, 0.006], [zr - 0.009, B - 0.012, 0.008]],
        [[[c0 - 0.0015, cy + cr + 0.0015], [c1 + 0.0015, cy + cr + 0.0015], [c1 + 0.0015, cy - cr - 0.0015], [c0 - 0.0015, cy - cr - 0.0015]]],
      ),
    0,
    fw * 0.62,
    0.0018,
    metal,
  );
  // The side plate's seams and screws (right side), the cylinder latch (left side).
  w.screw(-fw * 0.31, yb - 0.004, c0 - 0.004, '-x', 0.0021, metal);
  w.screw(-fw * 0.31, B, zr + 0.004, '-x', 0.0021, metal);
  w.screw(-fw * 0.31, yb - 0.004, zr - 0.002, '-x', 0.0021, metal);
  w.side(`${K}.latch`, () => shape([[c0 - 0.016, B - 0.007, 0.002], [c0 - 0.004, B - 0.006, 0.002], [c0 - 0.004, B - 0.0135, 0.002], [c0 - 0.017, B - 0.013, 0.002]]), fw * 0.31 + 0.0012, 0.0024, 0.0006, M.knurl(d.finish === 'blued' ? 0x1a1d24 : 0x8c9094));
  // ---- cylinder: a plain band at each end, fluted between, chambers in its face.
  const flute = () => {
    const pts: P2[] = [];
    const n = 6;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2 + Math.PI / 6;
      // Between chambers the flute is a scallop; over each chamber the full radius.
      for (let k = 0; k <= 4; k++) {
        const a = a0 - 0.32 + (k / 4) * 0.64;
        pts.push([Math.cos(a) * cr, Math.sin(a) * cr]);
      }
      const am = a0 + Math.PI / 6;
      pts.push([Math.cos(am) * (cr - 0.0032), Math.sin(am) * (cr - 0.0032), 0.003]);
    }
    return shape(pts);
  };
  const cyl = M.blued(d.finish === 'blued' ? 0x1b1f26 : 0x8a8e92, 0.3);
  if (d.finish !== 'blued') cyl.f = M.bright().f;
  const holes = Array.from({ length: 6 }, (_, i) => {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 2;
    return { c: [Math.cos(a) * d.pitch, Math.sin(a) * d.pitch] as [number, number], r: d.ch };
  });
  w.sec(`${K}.cylR`, () => shape(Array.from({ length: 24 }, (_, i) => [Math.cos((i / 24) * Math.PI * 2) * cr, Math.sin((i / 24) * Math.PI * 2) * cr] as P2)), c0, c0 + 0.007, 0.0012, cyl, 0, cy);
  w.sec(`${K}.cylF`, flute, c0 + 0.0065, c1 - 0.0065, 0, cyl, 0, cy);
  w.sec(`${K}.cylN`, () => shape(Array.from({ length: 24 }, (_, i) => [Math.cos((i / 24) * Math.PI * 2) * cr, Math.sin((i / 24) * Math.PI * 2) * cr] as P2), holes), c1 - 0.007, c1, 0.0012, cyl, 0, cy);
  // The bullets' noses in the chambers, a little way in.
  for (const h of holes) w.turn(`${K}.nose`, [[0, -0.006], [d.ch * 0.98, -0.006], [d.ch * 0.9, -0.0035], [d.ch * 0.5, -0.0018], [0, -0.0014]], h.c[0], cy + h.c[1], M.brass(0x9a7a48, 0.3), 10, 0.7, c1);
  // The crane and the ejector rod's star at the front; the rod under the barrel.
  w.tube(0, cy, c1 - 0.001, c1 + 0.005, 0.0042, metal);
  // ---- barrel: a tapered tube from the frame, with the ejector rod and its lug (or a full underlug) below.
  const br = d.br;
  const bz0 = c1 + 0.002;
  w.turn(`${K}.barrel`, [[0, bz0], [br + 0.0028, bz0], [br + 0.0028, bz0 + 0.012], [br + 0.0004, bz0 + 0.02], [br, d.muzzle - 0.002], [br - 0.0008, d.muzzle], [0.0048, d.muzzle], [0.0046, d.muzzle - 0.0006], [0.0046, d.muzzle - 0.015], [0, d.muzzle - 0.015]], 0, B, metal);
  w.turn(`${K}.bore`, [[0.0045, 0], [0.0045, 0.0138], [0, 0.0138]], 0, B, M.hole(), 12, 0.7, d.muzzle - 0.0145);
  if (d.lug) {
    // A full-length underlug over the ejector rod.
    w.side(`${K}.lug`, () => shape([[bz0, B - br + 0.002], [d.muzzle - 0.0005, B - br + 0.002], [d.muzzle - 0.0005, cy - 0.006, 0.004], [bz0 + 0.004, cy - 0.006, 0.004]]), 0, br * 1.7, 0.0018, metal);
  } else {
    w.tube(0, cy, c1 + 0.004, bz0 + 0.07, 0.0026, metal);
    w.tube(0, cy, bz0 + 0.068, bz0 + 0.076, 0.0034, M.knurl(0x1d2026));
    w.side(`${K}.lug`, () => shape([[bz0 + 0.074, B - br + 0.001], [bz0 + 0.088, B - br + 0.001], [bz0 + 0.086, cy - 0.003, 0.002], [bz0 + 0.076, cy - 0.003, 0.002]]), 0, 0.0075, 0.001, metal);
  }
  // The rib along the top (the .44's is ventilated), and the front sight blade on it.
  const fy = revolverPoints(d).front[1];
  if (d.rib) {
    w.side(`${K}.rib`, () => shape([[bz0, B + br - 0.002], [d.muzzle - 0.001, B + br - 0.002], [d.muzzle - 0.001, top + 0.001, 0.001], [bz0, top + 0.001]]), 0, 0.0085, 0.0008, metal);
    if (w.hi) for (let z = bz0 + 0.02; z < d.muzzle - 0.04; z += 0.022) w.box(0, B + br + 0.0005, z, 0.0087, 0.0026, 0.011, M.hole());
    // An adjustable rear sight on the top strap, a ramped red-insert blade in front.
    w.rbox(0, top + 0.0022, c0 - 0.006, 0.012, 0.0048, 0.022, 0.0008, dark);
    w.box(0, top + 0.0042, c0 - 0.011, 0.0032, 0.0016, 0.0015, M.hole());
  } else {
    // The rear sight is a groove down the top strap.
    w.box(0, top + 0.0002, (zr + c1) / 2, 0.003, 0.0006, c1 - zr, M.hole());
  }
  w.side(`${K}.blade`, () => shape([[d.muzzle - 0.026, top - 0.002], [d.muzzle - 0.004, top - 0.002], [d.muzzle - 0.004, fy, 0.0005], [d.muzzle - 0.012, fy, 0.0008]]), 0, 0.0032, 0.0004, dark);
  if (d.rib) w.box(0, fy - 0.0035, d.muzzle - 0.008, 0.0034, 0.004, 0.0035, M.glow(0xd8301e, 0.6));
  // ---- hammer: the spur back over the web of the hand, chequered on top; the trigger.
  w.side(`${K}.hammer`, () => shape([[zr - 0.004, B - 0.006], [zr + 0.004, B - 0.004], [zr + 0.004, top - 0.001, 0.003], [zr - 0.006, top + 0.004, 0.004], [zr - 0.017, top + 0.008, 0.003], [zr - 0.02, top + 0.004, 0.002], [zr - 0.01, B + 0.002, 0.006]]), 0, 0.0062, 0.0012, dark);
  if (w.hi) w.side(`${K}.spur`, () => shape([[zr - 0.006, top + 0.0045], [zr - 0.0165, top + 0.0088], [zr - 0.0185, top + 0.006], [zr - 0.008, top + 0.002]]), 0, 0.0064, 0.0005, M.knurl(d.finish === 'blued' ? 0x15171c : 0x6e7276));
  const gz = c0 - 0.01;
  const gy = yb - 0.008;
  w.side(
    `${K}.guard`,
    () =>
      shape(
        [[gz - 0.03, gy + 0.002], [gz + 0.012, gy + 0.002], [gz + 0.014, gy - 0.012, 0.008], [gz + 0.002, gy - 0.024, 0.01], [gz - 0.032, gy - 0.02, 0.008]],
        [[[gz - 0.026, gy - 0.001], [gz + 0.008, gy - 0.001], [gz + 0.009, gy - 0.011, 0.006], [gz + 0.0, gy - 0.019, 0.008], [gz - 0.027, gy - 0.015, 0.006]]],
      ),
    0,
    0.0075,
    0.0015,
    metal,
  );
  w.side(`${K}.trig`, () => shape([[gz - 0.012, gy + 0.001], [gz - 0.004, gy + 0.001], [gz - 0.001, gy - 0.009, 0.005], [gz - 0.005, gy - 0.017, 0.003], [gz - 0.0075, gy - 0.0165, 0.001], [gz - 0.005, gy - 0.009, 0.005], [gz - 0.011, gy - 0.002]]), 0, 0.0072, 0.0012, dark);
  // ---- grip: the frame's round butt, and the stocks over it.
  const R = REVOLVER_RAKE;
  const gt = yb - 0.006;
  const gb = gt - 0.072;
  const fzz = (y: number) => gz - 0.031 + R * (y - gt);
  const bzz = (y: number) => zr - 0.012 + R * (y - gt);
  const stock: WS = d.rubber ? M.stipple(0x161618, 0.35) : M.checker(0x5a361e, 0.35);
  const sb = 0.0055;
  const gripPts: P2[] = [
    [bzz(gt + 0.012) + sb, gt + 0.012 - sb, 0.006],
    [fzz(gt) + 0.004 - sb, gt + 0.004 - sb, 0.004],
    [fzz(gt - 0.02) + 0.001 - sb, gt - 0.02, 0.01],
    [fzz(gb + 0.012) + 0.002 - sb, gb + 0.012, 0.012],
    [(fzz(gb) + bzz(gb)) / 2, gb - 0.004 + sb, 0.02],
    [bzz(gb + 0.01) - 0.003 + sb, gb + 0.01, 0.014],
    [bzz(gt - 0.03) - 0.002 + sb, gt - 0.03, 0.03],
  ];
  w.side(`${K}.stocks`, () => shape(gripPts), 0, d.rubber ? 0.034 : 0.031, sb, stock);
  if (!d.rubber && w.hi) {
    // Smooth borders round the chequering (the wood showing at the edges), and the silver medallions.
    const my = gt - 0.014;
    const mz = (fzz(my) + bzz(my)) / 2;
    for (const s of [1, -1]) w.raw(M.bright(0xb0b4b8), (b) => b.cyl(s * 0.0156, my, mz, 0.007, 0.0008, 0.007, M.bright(0xb0b4b8), 0, 0, Math.PI / 2, 12));
    w.screw(0.0157, (gt + gb) / 2 + 0.006, (fzz((gt + gb) / 2) + bzz((gt + gb) / 2)) / 2, 'x', 0.0025, M.bright(0x9a9ea2));
  }
  if (d.rubber && w.hi) {
    // Finger grooves moulded into the front of the rubber grip.
    for (let i = 0; i < 3; i++) {
      const y = gt - 0.016 - i * 0.017;
      w.rbox(0, y, fzz(y) + 0.001, 0.03, 0.004, 0.006, 0.0018, M.rubber(0x141416));
    }
  }
}

/** The machine pistol's long magazine is part of its silhouette; its other parts are the duty pistol's. */
export function machinePistol(w: WB) {
  polymerPistol(w, MACHINE);
}

export { rrect };
