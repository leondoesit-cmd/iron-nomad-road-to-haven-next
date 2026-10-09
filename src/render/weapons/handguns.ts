import { M, shape, rrect, type P2, type WB, type WS } from './kit';
import { cartridge } from './parts';
import { FRAMES } from '../../sim/gunFrames';
import { CYLINDER, chamberAt } from '../../sim/gunActions';

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
  const { z0, z1 } = d;
  const steel = M.steel(0x5e6266, 0.3);
  const zp0 = z0 + 0.06;
  const zp1 = zp0 + 0.047;

  // ---- slide: three sweeps (behind the port, the port, ahead of it), the ends overlapping so no seam shows. It runs back
  // on its own in the close-up model (`slide`): everything on it, sights and all, is drawn in that piece.
  w.piece('slide', () => pistolSlide(w, d));
  // The barrel: its hood in the port, its crown in the slide's nose, the guide rod under it; between them, under the slide,
  // the barrel runs on (only drawn where the slide can uncover it).
  w.rbox(-0.001, B + 0.006, (zp0 + zp1) / 2 - 0.001, 0.0146, 0.0105, zp1 - zp0 + 0.002, 0.0012, steel);
  w.inner(() => w.tube(0, B, zp1 - 0.002, z1 - 0.028, 0.0066, steel));
  w.bored(0, B, z1 - 0.03, z1 - 0.0008, 0.0066, 0.0045, steel, 0.025);
  w.tube(0, yb + 0.0048, z1 - 0.02, z1 - 0.0012, 0.003, M.poly(0x2a2a2c));
  w.inner(() => w.tube(0, yb + 0.0048, zp0, z1 - 0.02, 0.0028, M.steel(0x6a6e72, 0.3)));
  pistolFrame(w, d);
}

/** The duty pistol's slide: the sweeps, serrations, back plate, extractor, the port's dark, the sights. */
function pistolSlide(w: WB, d: PistolDims) {
  const B = d.bore;
  const yb = B - 0.0155;
  const yt = B + 0.0165;
  const hw = 0.0127;
  const ys = yt + SIGHT_H;
  const { z0, z1 } = d;
  const slide = M.nitride(0x2a2b2d, 0.3);
  const steel = M.steel(0x5e6266, 0.3);
  const dark = M.blued(0x17181b, 0.2);
  const K = d.key;
  const zp0 = z0 + 0.06;
  const zp1 = zp0 + 0.047;
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
  // The slide's back plate and the extractor at the back of the port; the dark of the port beside the barrel's hood.
  w.rbox(0, B + 0.0005, z0 - 0.0003, 0.0145, 0.019, 0.0012, 0.0005, dark);
  w.rbox(-hw - 0.0002, B + 0.006, zp0 - 0.008, 0.0012, 0.0045, 0.016, 0.0004, slide);
  w.box(-hw / 2 - 0.004, B + 0.0021, (zp0 + zp1) / 2, hw - 0.006, 0.0006, zp1 - zp0 - 0.002, M.hole());
  // Inside the slide, seen once it runs back: the dark of its insides behind the barrel's hood.
  w.inner(() => w.box(0, B + 0.004, z0 + 0.03, 0.02, 0.016, 0.05, M.hole()));

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
  if (d.select) {
    // The fire selector on the left of the slide's back plate.
    w.rbox(0.0072, B + 0.002, z0 - 0.0012, 0.0048, 0.0028, 0.0022, 0.0006, steel);
  }
}

/** The pistol's polymer frame, its grip and controls, and the magazine in the grip (its own piece, `mag`). */
function pistolFrame(w: WB, d: PistolDims) {
  const B = d.bore;
  const yb = B - 0.0155;
  const { z0, z1 } = d;
  const frame = M.poly(d.frame ?? 0x1d1e20, 0.3);
  const grip = M.stipple(d.frame ?? 0x1c1d1f, 0.3);
  const steel = M.steel(0x5e6266, 0.3);
  const dark = M.blued(0x17181b, 0.2);
  const K = d.key;
  const zp0 = z0 + 0.06;
  const zp1 = zp0 + 0.047;

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
  // The base plate under the magazine well, or the long magazine hanging out of it; in the close-up model the whole
  // magazine, its body up the grip and the top round at its lips, comes out with it.
  const mo = d.magOut ?? 0;
  w.piece('mag', () => {
    if (mo > 0) {
      const mt = yB + 0.004;
      const mb = yB - mo;
      w.side(`${K}.mag`, () => shape([[bz(mt) + 0.004, mt], [fz(mt) - 0.004, mt], [fz(mb) - 0.002, mb], [bz(mb) + 0.004, mb]]), 0, 0.0225, 0.0018, M.blued(0x1c1d20, 0.35));
      w.side(`${K}.magb`, () => shape([[bz(mb) + 0.0025, mb + 0.002, 0.001], [fz(mb) - 0.001, mb + 0.002, 0.001], [fz(mb) + 0.001, mb - 0.006, 0.002], [bz(mb) + 0.002, mb - 0.006, 0.002]]), 0, 0.026, 0.0015, frame);
    } else {
      w.side(`${K}.base`, () => shape([[bz(yB) - 0.001, yB + 0.001, 0.001], [fz(yB) + 0.0015, yB + 0.001, 0.001], [fz(yB) + 0.002, yB - 0.006, 0.002], [bz(yB) - 0.0015, yB - 0.006, 0.002]]), 0, 0.0275, 0.0016, frame);
    }
    w.inner(() => {
      const top = yTop - 0.01;
      const bot = yB + 0.002;
      w.side(`${K}.magBody`, () => shape([[bz(top) + 0.007, top, 0.002], [fz(top) - 0.006, top, 0.002], [fz(bot) - 0.004, bot], [bz(bot) + 0.006, bot]]), 0, 0.021, 0.0012, M.blued(0x1c1d20, 0.35));
      // The lips, and the top round held in them, its nose forward.
      const zc = (fz(top) + bz(top)) / 2 + 0.002;
      w.side(`${K}.lips`, () => shape([[bz(top) + 0.008, top + 0.004, 0.001], [zc + 0.006, top + 0.004, 0.001], [zc + 0.006, top - 0.002], [bz(top) + 0.008, top - 0.002]]), 0, 0.0215, 0.0006, M.blued(0x1c1d20, 0.35));
      cartridge(w, `${K}.top`, [0, top + 0.006, zc - 0.014], 0.0049, 0.019, 0.0105);
    });
  });
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
  void zp1;
  void z1;
  // A lanyard loop cut in the back strap's foot, and the frame's finger rest.
  if (w.hi) w.box(0, yB + 0.004, bz(yB + 0.004) + 0.001, 0.008, 0.003, 0.0006, M.hole());
}

// ---------------------------------------------------------------------------------------------------------- revolvers

export interface RevolverDims {
  key: 'revolver' | 'cannon';
  /** Cylinder: axis height, from and to (z), radius, how far the chambers are off the axis, the chamber's radius. */
  cy: number;
  c0: number;
  c1: number;
  cr: number;
  pitch: number;
  ch: number;
  /** Barrel radius; a full underlug and a ventilated rib (the .44). */
  br: number;
  lug?: boolean;
  rib?: boolean;
  /** Stocks: walnut service stocks or a rubber combat grip. */
  rubber?: boolean;
  finish: 'blued' | 'stainless';
  /** Size of the frame and grip against the K-frame's. */
  k: number;
}

export const REVOLVER: RevolverDims = { key: 'revolver', cy: 0.0285, c0: 0.056, c1: 0.096, cr: 0.0181, pitch: 0.0115, ch: 0.0047, br: 0.0072, finish: 'blued', k: 1 };
export const CANNON: RevolverDims = { key: 'cannon', cy: 0.0302, c0: 0.054, c1: 0.1, cr: 0.0213, pitch: 0.0138, ch: 0.0057, br: 0.0095, lug: true, rib: true, rubber: true, finish: 'stainless', k: 1.1 };

/** A double-action revolver: frame with top strap and recoil shield, fluted cylinder, barrel, hammer, wood or rubber grips. */
export function revolver(w: WB, d: RevolverDims) {
  const K = d.key;
  const fr = FRAMES[K];
  const B = fr.bore;
  const MZ = fr.muzzle;
  const metal: WS = d.finish === 'blued' ? M.blued(0x1a1d24, 0.32) : M.bright(0x9ca0a4, 0.25);
  const dark: WS = d.finish === 'blued' ? M.blued(0x121418, 0.25) : M.bright(0x7c8084, 0.25);
  const { c0, c1, cy, cr, k } = d;
  const fw = cr * 1.2;
  // The top strap's top, and the frame's bottom under the cylinder.
  const top = B + (d.rib ? 0.0125 : 0.0105);
  const yb = cy - cr - 0.004;
  const zr = c0 - 0.024 * k;
  // ---- grip line (round butt, raked): the front strap behind the trigger guard, the back strap under the hammer.
  const R = REVOLVER_RAKE;
  const fTop: [number, number] = [c0 - 0.039 * k, yb - 0.009];
  const bTop: [number, number] = [zr - 0.05 * k, yb + 0.014];
  const fz = (y: number) => fTop[0] + R * (y - fTop[1]);
  const bz = (y: number) => bTop[0] + R * (y - bTop[1]);
  const yBot = fTop[1] - 0.068 * k;
  // ---- frame: recoil shield and hump, top strap, frame front, the bottom, and the grip frame; the cylinder's window.
  w.side(
    `${K}.frame`,
    () =>
      shape(
        [
          [bTop[0] + 0.002, bTop[1] + 0.006, 0.006],
          [zr - 0.012, top - 0.006, 0.008],
          [zr + 0.006, top, 0.004],
          [c1 + 0.015, top, 0.002],
          [c1 + 0.016, cy - 0.012 * k, 0.003],
          [c1 + 0.006, yb, 0.004],
          [fTop[0] + 0.055 * k, yb - 0.001],
          [fTop[0] + 0.004, fTop[1] + 0.004, 0.004],
          [fz(yBot + 0.012), yBot + 0.012],
          [bz(yBot + 0.014), yBot + 0.014],
          [bTop[0] - 0.001, bTop[1] - 0.004, 0.004],
        ],
        [[[c0 - 0.0012, cy + cr + 0.0028], [c1 + 0.0012, cy + cr + 0.0028], [c1 + 0.0012, cy - cr - 0.0028], [c0 - 0.0012, cy - cr - 0.0028]]],
      ),
    0,
    fw,
    0.0013,
    metal,
  );
  // The side plate's screws on the right, the cylinder latch on the left behind the cylinder.
  w.screw(-fw / 2 - 0.0013, yb - 0.004, c0 - 0.006, '-x', 0.0021, metal);
  w.screw(-fw / 2 - 0.0013, cy + 0.006, zr + 0.003, '-x', 0.0021, metal);
  w.screw(-fw / 2 - 0.0013, yb + 0.004, zr - 0.012, '-x', 0.0021, metal);
  w.side(`${K}.latch`, () => shape([[c0 - 0.018, cy + 0.004, 0.002], [c0 - 0.005, cy + 0.0045, 0.002], [c0 - 0.005, cy - 0.003, 0.002], [c0 - 0.019, cy - 0.003, 0.002]]), fw / 2 + 0.0026, 0.0026, 0.0006, M.knurl(d.finish === 'blued' ? 0x1a1d24 : 0x8c9094));
  // ---- cylinder: a plain band at the back, fluted, and a band at the front with the chambers' mouths in it.
  const flute = () => {
    const pts: P2[] = [];
    for (let i = 0; i < 6; i++) {
      const a0 = (i / 6) * Math.PI * 2 + Math.PI / 2;
      for (let n = 0; n <= 4; n++) {
        const a = a0 - 0.3 + (n / 4) * 0.6;
        pts.push([Math.cos(a) * cr, Math.sin(a) * cr]);
      }
      const am = a0 + Math.PI / 6;
      pts.push([Math.cos(am) * (cr - 0.0034 * k), Math.sin(am) * (cr - 0.0034 * k), 0.0034]);
    }
    return shape(pts);
  };
  const cyl: WS = d.finish === 'blued' ? M.blued(0x1b1f26, 0.3) : M.bright(0x8c9094, 0.25);
  const ring = (holes: { c: [number, number]; r: number }[] = []) => () => shape(Array.from({ length: 28 }, (_, i) => [Math.cos((i / 28) * Math.PI * 2) * (cr - 0.001), Math.sin((i / 28) * Math.PI * 2) * (cr - 0.001)] as P2), holes);
  const holes = Array.from({ length: 6 }, (_, i) => {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 2;
    return { c: [Math.cos(a) * d.pitch, Math.sin(a) * d.pitch] as [number, number], r: d.ch };
  });
  // The cylinder swings out on its crane in the close-up model (`cyl`), the ejector rod and the star riding on it (`star`).
  w.piece('cyl', () => {
    w.sec(`${K}.cylR`, ring(), c0, c0 + 0.008, 0.001, cyl, 0, cy);
    w.sec(`${K}.cylF`, flute, c0 + 0.0075, c1 - 0.0075, 0, cyl, 0, cy);
    w.sec(`${K}.cylN`, ring(holes), c1 - 0.008, c1, 0.001, cyl, 0, cy);
    // The bullets' noses a little way into the chambers (in the close-up model they are the rounds' own, see below).
    if (w.hi && !w.split) for (const h of holes) w.turn(`${K}.nose`, [[0, -0.007], [d.ch * 0.96, -0.007], [d.ch * 0.88, -0.0042], [d.ch * 0.45, -0.0022], [0, -0.0018]], h.c[0], cy + h.c[1], M.brass(0x9a7a48, 0.3), 10, 0.7, c1);
    // The crane's hub, and under the frame where only a swung-out cylinder shows it, the crane's arm down to its hinge.
    w.tube(0, cy, c1 - 0.001, c1 + 0.005, 0.0045 * k, metal);
    w.inner(() => {
      const hy = cy - cr - 0.002;
      w.rod([0, cy - 0.003, c1 + 0.003], [0.0105 * k, hy, c1 + 0.003], 0.0032 * k, metal);
      w.tube(0.0105 * k, hy, c0 + 0.006, c1 + 0.006, 0.0028 * k, metal);
      // The chambers' mouths at the back, dark, for when they are empty.
      for (const h of holes) w.turn(`${K}.chamb`, [[0, 0], [d.ch * 1.04, 0], [d.ch * 1.04, 0.0006], [0, 0.0006]], h.c[0], cy + h.c[1], M.hole(), 10, 0.7, c0 - 0.0004);
    });
  });
  w.piece('star', () => {
    w.inner(() => {
      // The extractor star, flush in the cylinder's back face; pushed back it lifts the cases out.
      const star = () => shape(Array.from({ length: 12 }, (_, i) => {
        const a = (i / 12) * Math.PI * 2 + Math.PI / 2 + Math.PI / 6;
        const r = i % 2 === 0 ? d.pitch * 0.62 : d.pitch + d.ch * 0.2;
        return [Math.cos(a) * r, Math.sin(a) * r, 0.0008] as P2;
      }));
      w.sec(`${K}.star`, star, c0 - 0.0016, c0 + 0.0004, 0.0003, cyl, 0, cy);
    });
  });
  // ---- barrel: a heavy shank in the frame, tapering to the crown.
  const br = d.br;
  const bz0 = c1 + 0.002;
  w.turn(`${K}.barrel`, [[0, bz0], [br + 0.0028, bz0], [br + 0.0028, bz0 + 0.013], [br + 0.0005, bz0 + 0.019], [br, MZ - 0.002], [br - 0.0008, MZ], [0.0052 * k, MZ], [0.0048 * k, MZ - 0.0006], [0.0047 * k, MZ - 0.016], [0, MZ - 0.016]], 0, B, metal);
  if (w.hi) w.turn(`${K}.bore`, [[0.0046 * k, 0], [0.0046 * k, 0.0148], [0, 0.0148]], 0, B, M.hole(), 12, 0.7, MZ - 0.0155);
  if (d.lug) {
    w.side(`${K}.lug`, () => shape([[c1 + 0.016, B - br + 0.001], [MZ - 0.0008, B - br + 0.001], [MZ - 0.0008, cy - 0.0045, 0.005], [c1 + 0.02, cy - 0.0045, 0.004]]), 0, br * 1.55, 0.0016, metal);
    w.piece('star', () => w.tube(0, cy - 0.0005, c1 + 0.003, c1 + 0.018, 0.0028 * k, metal));
  } else {
    w.piece('star', () => {
      w.tube(0, cy, c1 + 0.004, bz0 + 0.07, 0.0026, metal);
      w.tube(0, cy, bz0 + 0.068, bz0 + 0.077, 0.0034, M.knurl(0x1d2026));
    });
    w.side(`${K}.lug`, () => shape([[bz0 + 0.075, B - br + 0.001], [bz0 + 0.09, B - br + 0.001], [bz0 + 0.088, cy - 0.003, 0.002], [bz0 + 0.077, cy - 0.003, 0.002]]), 0, 0.0075, 0.001, metal);
  }
  revolverProps(w, d);
  // ---- sights: a groove down the top strap and a ramped blade (the .44: an adjustable rear and a ventilated rib).
  const fy = fr.front[1];
  if (d.rib) {
    w.side(`${K}.rib`, () => shape([[bz0, B + br - 0.002], [MZ - 0.001, B + br - 0.002], [MZ - 0.001, top + 0.0008, 0.001], [bz0, top + 0.0008]]), 0, 0.0085, 0.0007, metal);
    if (w.hi) for (let z = bz0 + 0.02; z < MZ - 0.04; z += 0.022) w.box(0, B + br + 0.0008, z, 0.0089, 0.0028, 0.011, M.hole());
    w.rbox(0, fr.rear[1] - 0.0018, c0 - 0.006, 0.013, 0.0052, 0.024, 0.0009, M.blued(0x111214));
    w.box(0, fr.rear[1] + 0.0002, c0 - 0.0115, 0.0034, 0.0022, 0.0016, M.hole());
    w.box(0, fr.rear[1] + 0.0004, c0 + 0.006, 0.0012, 0.0014, 0.0012, M.dot());
  } else {
    w.box(0, top + 0.0001, (zr + c1) / 2 + 0.01, 0.0032, 0.0006, c1 - zr - 0.01, M.hole());
  }
  w.side(`${K}.blade`, () => shape([[MZ - 0.024, top - 0.002], [MZ - 0.004, top - 0.002], [MZ - 0.004, fy, 0.0006], [MZ - 0.011, fy, 0.0009]]), 0, 0.0032, 0.0004, dark);
  if (d.rib) w.box(0, fy - 0.0035, MZ - 0.0075, 0.0034, 0.0045, 0.004, M.glow(0xd8301e, 0.6));
  // ---- hammer: the spur back over the web of the hand, chequered on top.
  w.side(`${K}.hammer`, () => shape([[zr - 0.002, cy - 0.004], [zr + 0.003, cy + 0.002], [zr + 0.002, top - 0.002, 0.003], [zr - 0.008, top + 0.004, 0.004], [zr - 0.02 * k, top + 0.0035, 0.004], [zr - 0.022 * k, top - 0.0015, 0.003], [zr - 0.012, top - 0.004, 0.004], [zr - 0.008, cy + 0.002, 0.004]]), 0, 0.0064, 0.0011, dark);
  if (w.hi) w.side(`${K}.spur`, () => shape([[zr - 0.009, top + 0.0042], [zr - 0.02 * k, top + 0.0038], [zr - 0.021 * k, top + 0.0012], [zr - 0.01, top + 0.0012]]), 0, 0.0066, 0.0004, M.knurl(d.finish === 'blued' ? 0x15171c : 0x6e7276));
  // ---- trigger guard and the wide, smooth double-action trigger.
  const gz0 = fTop[0] + 0.004;
  const gz1 = fTop[0] + 0.058 * k;
  const gyB = yb - 0.03 * k;
  w.side(
    `${K}.guard`,
    () =>
      shape(
        [[gz0, yb + 0.001], [gz1, yb + 0.001], [gz1 + 0.004, yb - 0.012 * k, 0.008], [gz1 - 0.01, gyB, 0.012], [gz0 + 0.004, gyB + 0.006, 0.01]],
        [[[gz0 + 0.004, yb - 0.002], [gz1 - 0.004, yb - 0.002], [gz1 - 0.002, yb - 0.011 * k, 0.006], [gz1 - 0.012, gyB + 0.0045, 0.009], [gz0 + 0.007, gyB + 0.009, 0.007]]],
      ),
    0,
    0.0072,
    0.0012,
    metal,
  );
  const tz = fTop[0] + 0.033 * k;
  w.side(`${K}.trig`, () => shape([[tz - 0.004, yb + 0.001], [tz + 0.004, yb + 0.001], [tz + 0.006, yb - 0.01, 0.006], [tz + 0.002, yb - 0.02 * k, 0.003], [tz - 0.0005, yb - 0.019 * k, 0.001], [tz + 0.0015, yb - 0.01, 0.006], [tz - 0.005, yb - 0.003]]), 0, 0.0085, 0.0013, dark);
  // ---- stocks: walnut panels with chequering inside a smooth border (or a rubber grip with finger grooves) over the frame.
  const sb = 0.005;
  const gb = yBot - 0.004;
  const pts: P2[] = [
    [bz(bTop[1] - 0.006) + sb, bTop[1] - 0.006, 0.004],
    [fz(fTop[1] + 0.001) - sb + 0.002, fTop[1] + 0.001 - sb, 0.004],
    [fz((fTop[1] + gb) / 2) - sb + 0.0015, (fTop[1] + gb) / 2, 0.03],
    [fz(gb) - sb + 0.004, gb + sb, 0.01],
    [bz(gb + 0.006) + sb - 0.002, gb + sb, 0.014],
    [bz((bTop[1] + gb) / 2) + sb - 0.003, (bTop[1] + gb) / 2, 0.04],
  ];
  const stock: WS = d.rubber ? M.stipple(0x161618, 0.35) : M.wood(0x5a361e, 0.35);
  w.side(`${K}.stocks`, () => shape(pts), 0, d.rubber ? 0.036 : 0.032, sb, stock);
  if (!d.rubber) {
    // Chequered panels inset in the smooth border, the silver medallions, the grip screw.
    const my = (fTop[1] + gb) / 2 + 0.006;
    const mz = (fz(my) + bz(my)) / 2;
    for (const s of [1, -1]) {
      w.side(`${K}.chq${s}`, () => shape([[bz(my + 0.022) + 0.005, my + 0.02, 0.004], [fz(my + 0.02) - 0.004, my + 0.02, 0.003], [fz(my - 0.03) - 0.004, my - 0.03, 0.004], [bz(my - 0.03) + 0.007, my - 0.03, 0.006]]), s * 0.0152, 0.0012, 0.0004, M.checker(0x4e2e18, 0.35));
      if (w.hi) w.raw(M.bright(0xb0b4b8), (b) => b.cyl(s * 0.0158, my + 0.026, (fz(my + 0.026) + bz(my + 0.026)) / 2 + 0.002, 0.007, 0.0008, 0.007, M.bright(0xb0b4b8), 0, 0, Math.PI / 2, 12));
    }
    w.screw(0.0155, my - 0.008, mz, 'x', 0.0024, M.bright(0x9a9ea2));
  } else if (w.hi) {
    // Finger grooves moulded into the front of the rubber grip.
    for (let i = 0; i < 3; i++) {
      const y = fTop[1] - 0.017 - i * 0.017 * k;
      w.rbox(0, y, fz(y) - 0.0005, 0.032, 0.0045, 0.006, 0.002, M.rubber(0x121214));
    }
  }
}

/**
 * What the hands carry to a revolver, drawn where it sits in the closed cylinder: the six cases on the star (fired, to be
 * thrown out), six fresh rounds, the speedloader's ring and knob behind them, and the rounds by twos.
 */
function revolverProps(w: WB, d: RevolverDims) {
  const K = d.key;
  const cy = d.cy;
  const { c0, c1 } = CYLINDER[K];
  const r = d.ch * 0.94;
  const len = (c1 - c0) * 0.72;
  const round = (key: string, i: number, live: boolean) => {
    const [x, y] = chamberAt(K, i);
    if (live) cartridge(w, `${K}.${key}`, [x, cy + y, c0 - 0.0012], r, len, c1 - c0 - len - 0.0035, true);
    else w.turnAlong(`${K}.${key}`, [[0, 0], [r * 1.12, 0], [r * 1.12, 0.05], [r * 0.95, 0.08], [r, 0.12], [r, 1], [r * 0.8, 1], [r * 0.8, 0.96], [0, 0.96]], [x, cy + y, c0 - 0.0012], [x, cy + y, c0 - 0.0012 + len], M.brass(0xa07e3e, 0.45));
  };
  w.prop('cases', () => {
    for (let i = 0; i < 6; i++) round('spent', i, false);
  });
  w.prop('rounds', () => {
    for (let i = 0; i < 6; i++) round('live', i, true);
  });
  for (let p = 0; p < 3; p++)
    w.prop(`pair${p}`, () => {
      round('live', p * 2, true);
      round('live', p * 2 + 1, true);
    });
  // The speedloader: a black ring holding the rounds by their rims, and the knurled knob behind it that lets them go.
  w.prop('loader', () => {
    w.turn(`${K}.ldr`, [[0, c0 - 0.0115], [d.pitch + d.ch * 1.35, c0 - 0.0115], [d.pitch + d.ch * 1.45, c0 - 0.008], [d.pitch + d.ch * 1.35, c0 - 0.0018], [0, c0 - 0.0018]], 0, cy, M.poly(0x161718, 0.3));
    w.turn(`${K}.ldk`, [[0, c0 - 0.031], [0.0062, c0 - 0.031], [0.0068, c0 - 0.027], [0.0068, c0 - 0.016], [0.0048, c0 - 0.0112], [0, c0 - 0.0112]], 0, cy, M.knurl(0x2a2b2d, 0.3));
  });
}

/** The machine pistol's long magazine is part of its silhouette; its other parts are the duty pistol's. */
export function machinePistol(w: WB) {
  polymerPistol(w, MACHINE);
}

export { rrect };
