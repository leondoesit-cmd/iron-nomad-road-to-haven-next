import type { GunModel } from '../data/gear';

/**
 * Where things are on each gun, in its own frame (+z down the barrel, +y up, +x to the gun's LEFT; metres): the one table
 * the models in `render/weapons` are drawn to and everything else reads off them. `GUN_POINTS` (sights, muzzle, ejection
 * port, magazine well), the add-ons' anchors in `render/gunMods.ts`, the first-person hands in `render/viewmodel.ts` and
 * the drills' spots in `gunDrills.ts` all come from here, so a gun cannot be modelled one way and handled another.
 *
 * The guns are drawn at their real sizes: a duty pistol's 186 mm slide, a 4-inch .38, an M4-pattern carbine with a 14.5-inch
 * barrel, a FAL with its 21-inch one. Grips rake back the way real grips do (their bottoms behind their tops).
 */

export type V3 = [number, number, number];

export interface GunFrame {
  /** The bore's height, and the z of the crown (or the muzzle device's face). */
  bore: number;
  muzzle: number;
  /** The rear sight's notch or aperture and the front sight's tip: the line the eye looks along (a built-in scope's axis). */
  rear: V3;
  front: V3;
  /** The ejection port (on the gun's right), and the mouth of the magazine well (or the breech, the loading gate). */
  port: V3;
  well: V3;
  /** The firing hand: the middle of the grip it closes round, and the grip's line (raked: its bottom behind its top). */
  grip: { p: V3; a: V3 };
  /** The support hand, under the fore-end from the left (absent: the free hand stays off the gun). */
  support?: V3;
  /** Add-on anchors: the top of the rail or receiver (an optic's base) and the middle of it, the underside of the fore-end,
   * the bottom of the magazine, the back of the gun where a stock begins, a spot on the left for a light, and the barrel's
   * radius at the muzzle. */
  top: { y: number; z: number };
  under: { y: number; z: number };
  mag: { y: number; z: number };
  stock: { y: number; z: number };
  side: V3;
  r: number;
  /** Two barrels side by side, `dbl` apart. */
  dbl?: number;
  /** Named spots on the action the drills work: a slide, a charging handle, a bolt knob, a lever's loop, a feed cover. */
  spots?: Record<string, V3>;
}

const rake = (deg: number): V3 => {
  const r = (deg * Math.PI) / 180;
  return [0, Math.cos(r), Math.sin(r)];
};

/** Rake of the pistols' grips (19 degrees) and the other grips by kind. */
export const RAKE = { pistol: rake(19), revolver: rake(26), ar: rake(25), sporter: rake(32), shotgun: rake(34), lever: rake(41), polymer: rake(20) };

export const FRAMES: Record<GunModel, GunFrame> = {
  // ------------------------------------------------------------------ handguns
  pistol: {
    bore: 0.035, muzzle: 0.183, rear: [0, 0.0605, 0.0055], front: [0, 0.0605, 0.171], port: [-0.013, 0.046, 0.08], well: [0, -0.088, -0.012],
    grip: { p: [0, -0.0306, 0.0069], a: RAKE.pistol }, support: [0.013, -0.044, 0.002],
    top: { y: 0.0515, z: 0.11 }, under: { y: 0.007, z: 0.15 }, mag: { y: -0.093, z: -0.012 }, stock: { y: 0.0, z: -0.012 }, side: [0.013, 0.0, 0.15], r: 0.0066,
    spots: { slide: [0, 0.035, 0.03], floor: [0, -0.094, -0.012] },
  },
  compact: {
    bore: 0.034, muzzle: 0.153, rear: [0, 0.0595, 0.0055], front: [0, 0.0595, 0.141], port: [-0.013, 0.045, 0.08], well: [0, -0.054, 0],
    grip: { p: [0, -0.0296, 0.0069], a: RAKE.pistol }, support: [0.013, -0.043, 0.002],
    top: { y: 0.0505, z: 0.1 }, under: { y: 0.006, z: 0.13 }, mag: { y: -0.059, z: 0.0 }, stock: { y: 0.0, z: -0.012 }, side: [0.013, 0.0, 0.13], r: 0.0066,
    spots: { slide: [0, 0.034, 0.03], floor: [0, -0.06, 0.0] },
  },
  mp: {
    bore: 0.035, muzzle: 0.183, rear: [0, 0.0605, 0.0055], front: [0, 0.0605, 0.171], port: [-0.013, 0.046, 0.08], well: [0, -0.125, -0.024],
    grip: { p: [0, -0.0306, 0.0069], a: RAKE.pistol }, support: [0.013, -0.044, 0.002],
    top: { y: 0.0515, z: 0.11 }, under: { y: 0.007, z: 0.15 }, mag: { y: -0.178, z: -0.04 }, stock: { y: 0.0, z: -0.012 }, side: [0.013, 0.0, 0.15], r: 0.0066,
    spots: { slide: [0, 0.035, 0.03], floor: [0, -0.18, -0.042] },
  },
  revolver: {
    bore: 0.04, muzzle: 0.205, rear: [0, 0.0505, 0.05], front: [0, 0.0505, 0.197], port: [0.02, 0.0285, 0.076], well: [0.02, 0.0285, 0.076],
    grip: { p: [0, -0.032, -0.02], a: RAKE.revolver }, support: [0.013, -0.045, -0.022],
    top: { y: 0.0505, z: 0.13 }, under: { y: 0.026, z: 0.16 }, mag: { y: 0.0285, z: 0.076 }, stock: { y: 0.0, z: -0.02 }, side: [0.012, 0.03, 0.15], r: 0.0072,
    spots: { cyl: [0.018, 0.0285, 0.076] },
  },
  cannon: {
    bore: 0.044, muzzle: 0.275, rear: [0, 0.061, 0.048], front: [0, 0.061, 0.267], port: [0.023, 0.0302, 0.077], well: [0.023, 0.0302, 0.077],
    grip: { p: [0, -0.035, -0.026], a: RAKE.revolver }, support: [0.014, -0.048, -0.03],
    top: { y: 0.061, z: 0.17 }, under: { y: 0.02, z: 0.2 }, mag: { y: 0.0302, z: 0.077 }, stock: { y: 0.0, z: -0.022 }, side: [0.012, 0.03, 0.2], r: 0.0095,
    spots: { cyl: [0.021, 0.0302, 0.077] },
  },
  // ------------------------------------------------------------------ submachine guns
  smg: {
    bore: 0.035, muzzle: 0.335, rear: [0, 0.071, -0.07], front: [0, 0.071, 0.292], port: [-0.019, 0.042, 0.09], well: [0, -0.012, 0.118],
    grip: { p: [0, -0.04, -0.021], a: RAKE.polymer }, support: [0.02, 0.012, 0.225],
    top: { y: 0.056, z: -0.01 }, under: { y: 0.018, z: 0.24 }, mag: { y: -0.184, z: 0.118 }, stock: { y: 0.0, z: -0.33 }, side: [0.02, 0.035, 0.25], r: 0.008,
    spots: { handle: [0.03, 0.035, 0.07], handleBack: [0.03, 0.035, -0.015], floor: [0, -0.188, 0.118] },
  },
  smg2: {
    bore: 0.023, muzzle: 0.34, rear: [0, 0.081, -0.058], front: [0, 0.081, 0.316], port: [-0.021, 0.035, 0.075], well: [0, 0.0, 0.103],
    grip: { p: [0, -0.042, -0.026], a: RAKE.polymer }, support: [0.026, -0.012, 0.23],
    top: { y: 0.0705, z: 0.03 }, under: { y: -0.012, z: 0.245 }, mag: { y: -0.172, z: 0.136 }, stock: { y: 0.03, z: -0.335 }, side: [0.027, 0.016, 0.25], r: 0.0075,
    spots: { tube: [0.034, 0.05, 0.245], floor: [0, -0.176, 0.136] },
  },
  // ------------------------------------------------------------------ shotguns
  sawn: {
    bore: 0.035, muzzle: 0.335, rear: [0, 0.0535, 0.04], front: [0, 0.0535, 0.325], port: [-0.01, 0.04, 0.03], well: [0, 0.04, 0.03],
    grip: { p: [0, -0.034, -0.086], a: RAKE.shotgun }, support: [0.024, -0.008, 0.11],
    top: { y: 0.05, z: 0.0 }, under: { y: 0.0, z: 0.13 }, mag: { y: 0.03, z: 0.0 }, stock: { y: -0.075, z: -0.125 }, side: [0.03, 0.03, 0.15], r: 0.0105, dbl: 0.0214,
    spots: { breech: [0.0107, 0.04, 0.035] },
  },
  coach: {
    bore: 0.035, muzzle: 0.545, rear: [0, 0.0535, 0.04], front: [0, 0.0535, 0.535], port: [-0.01, 0.04, 0.03], well: [0, 0.04, 0.03],
    grip: { p: [0, -0.034, -0.086], a: RAKE.shotgun }, support: [0.024, -0.008, 0.16],
    top: { y: 0.05, z: 0.0 }, under: { y: 0.0, z: 0.17 }, mag: { y: 0.03, z: 0.0 }, stock: { y: -0.065, z: -0.39 }, side: [0.03, 0.03, 0.3], r: 0.0105, dbl: 0.0214,
    spots: { breech: [0.0107, 0.04, 0.035] },
  },
  pump: {
    bore: 0.038, muzzle: 0.66, rear: [0, 0.0555, -0.03], front: [0, 0.0515, 0.65], port: [-0.017, 0.038, 0.09], well: [0, -0.012, 0.08],
    grip: { p: [0, -0.05, -0.077], a: RAKE.shotgun }, support: [0.026, -0.022, 0.3],
    top: { y: 0.0555, z: 0.05 }, under: { y: -0.014, z: 0.3 }, mag: { y: 0.012, z: 0.56 }, stock: { y: -0.05, z: -0.36 }, side: [0.03, 0.012, 0.46], r: 0.0105,
    spots: { port: [-0.017, 0.038, 0.09] },
  },
  combat: {
    bore: 0.038, muzzle: 0.645, rear: [0, 0.0845, -0.02], front: [0, 0.0845, 0.62], port: [-0.018, 0.038, 0.08], well: [0, -0.01, 0.08],
    grip: { p: [0, -0.055, -0.06], a: RAKE.ar }, support: [0.026, -0.012, 0.31],
    top: { y: 0.0675, z: 0.07 }, under: { y: -0.012, z: 0.32 }, mag: { y: 0.012, z: 0.58 }, stock: { y: -0.02, z: -0.36 }, side: [0.03, 0.012, 0.46], r: 0.0105,
    spots: { port: [-0.018, 0.038, 0.08], handle: [-0.03, 0.03, 0.075] },
  },
  // ------------------------------------------------------------------ rifles
  rifle: {
    bore: 0.035, muzzle: 0.775, rear: [0, 0.074, 0.0], front: [0, 0.074, 0.29], port: [-0.018, 0.045, 0.1], well: [0, -0.03, 0.11],
    grip: { p: [0, -0.056, -0.02], a: RAKE.sporter }, support: [0.024, -0.022, 0.28],
    top: { y: 0.0525, z: 0.12 }, under: { y: -0.005, z: 0.36 }, mag: { y: -0.032, z: 0.11 }, stock: { y: -0.05, z: -0.29 }, side: [0.024, 0.02, 0.4], r: 0.0085,
    spots: { knob: [-0.062, 0.002, 0.034] },
  },
  sniper: {
    bore: 0.035, muzzle: 0.92, rear: [0, 0.1, 0.0], front: [0, 0.1, 0.355], port: [-0.02, 0.045, 0.11], well: [0, -0.058, 0.11],
    grip: { p: [0, -0.047, -0.018], a: RAKE.polymer }, support: [0.026, -0.003, 0.32],
    top: { y: 0.064, z: 0.15 }, under: { y: 0.008, z: 0.42 }, mag: { y: -0.072, z: 0.112 }, stock: { y: 0.0, z: -0.37 }, side: [0.028, 0.032, 0.42], r: 0.0115,
    spots: { knob: [-0.066, 0.0, 0.034] },
  },
  lever: {
    bore: 0.035, muzzle: 0.665, rear: [0, 0.0555, 0.22], front: [0, 0.0555, 0.65], port: [0, 0.05, 0.06], well: [-0.016, 0.006, 0.085],
    grip: { p: [0, -0.055, -0.033], a: RAKE.lever }, support: [0.023, -0.008, 0.33],
    top: { y: 0.053, z: 0.07 }, under: { y: 0.0, z: 0.35 }, mag: { y: 0.017, z: 0.64 }, stock: { y: -0.05, z: -0.32 }, side: [0.022, 0.02, 0.4], r: 0.011,
    spots: { loop: [0, -0.055, 0.0] },
  },
  carbine: {
    bore: 0.035, muzzle: 0.645, rear: [0, 0.068, 0.012], front: [0, 0.068, 0.585], port: [-0.018, 0.045, 0.12], well: [0, -0.012, 0.115],
    grip: { p: [0, -0.056, -0.02], a: RAKE.sporter }, support: [0.025, 0.004, 0.32],
    top: { y: 0.0525, z: 0.1 }, under: { y: 0.012, z: 0.33 }, mag: { y: -0.19, z: 0.185 }, stock: { y: -0.05, z: -0.29 }, side: [0.022, 0.035, 0.34], r: 0.0095,
    spots: { handle: [-0.036, 0.035, 0.17], handleBack: [-0.036, 0.035, 0.09], floor: [0, -0.195, 0.185] },
  },
  ar: {
    bore: 0.03, muzzle: 0.525, rear: [0, 0.093, -0.012], front: [0, 0.093, 0.43], port: [-0.015, 0.032, 0.065], well: [0, -0.04, 0.1],
    grip: { p: [0, -0.041, -0.021], a: RAKE.ar }, support: [0.026, 0.0, 0.3],
    top: { y: 0.06, z: 0.03 }, under: { y: 0.009, z: 0.33 }, mag: { y: -0.186, z: 0.13 }, stock: { y: 0.01, z: -0.285 }, side: [0.026, 0.03, 0.35], r: 0.011,
    spots: { handle: [0, 0.046, -0.054], handleBack: [0, 0.046, -0.11], floor: [0, -0.19, 0.13] },
  },
  br: {
    bore: 0.035, muzzle: 0.8, rear: [0, 0.095, -0.03], front: [0, 0.095, 0.48], port: [-0.018, 0.035, 0.08], well: [0, -0.03, 0.12],
    grip: { p: [0, -0.038, -0.002], a: RAKE.polymer }, support: [0.025, -0.016, 0.33],
    top: { y: 0.062, z: 0.05 }, under: { y: 0.007, z: 0.35 }, mag: { y: -0.145, z: 0.127 }, stock: { y: 0.0, z: -0.4 }, side: [0.025, 0.03, 0.38], r: 0.011,
    spots: { handle: [0.03, 0.046, 0.29], handleBack: [0.03, 0.046, 0.17], floor: [0, -0.148, 0.127] },
  },
  dmr: {
    bore: 0.032, muzzle: 0.69, rear: [0, 0.098, -0.02], front: [0, 0.098, 0.51], port: [-0.017, 0.034, 0.07], well: [0, -0.042, 0.115],
    grip: { p: [0, -0.043, -0.017], a: RAKE.ar }, support: [0.026, 0.0, 0.33],
    top: { y: 0.0635, z: 0.04 }, under: { y: 0.009, z: 0.36 }, mag: { y: -0.155, z: 0.125 }, stock: { y: 0.01, z: -0.36 }, side: [0.027, 0.032, 0.4], r: 0.0132,
    spots: { handle: [0, 0.049, -0.06], handleBack: [0, 0.049, -0.115], floor: [0, -0.158, 0.13] },
  },
  lmg: {
    bore: 0.035, muzzle: 0.73, rear: [0, 0.105, -0.01], front: [0, 0.105, 0.56], port: [-0.018, -0.005, 0.1], well: [0.03, 0.04, 0.115],
    grip: { p: [0, -0.052, -0.021], a: RAKE.polymer }, support: [0.026, -0.044, 0.26],
    top: { y: 0.0795, z: 0.06 }, under: { y: -0.008, z: 0.3 }, mag: { y: -0.13, z: 0.115 }, stock: { y: 0.0, z: -0.4 }, side: [0.03, 0.035, 0.42], r: 0.012,
    spots: { handle: [-0.04, 0.022, 0.24], handleBack: [-0.04, 0.022, 0.11], cover: [0, 0.07, 0.08], box: [0.064, -0.07, 0.115] },
  },
  crossbow: {
    bore: 0.045, muzzle: 0.55, rear: [0, 0.09, 0.08], front: [0, 0.09, 0.47], port: [0, 0.05, 0.1], well: [0, 0.05, 0.1],
    grip: { p: [0, -0.023, -0.021], a: RAKE.polymer }, support: [0.022, -0.012, 0.3],
    top: { y: 0.07, z: 0.05 }, under: { y: -0.015, z: 0.3 }, mag: { y: 0.04, z: 0.55 }, stock: { y: 0.0, z: -0.36 }, side: [0.025, 0.03, 0.3], r: 0.01,
    spots: { railFront: [0, 0.05, 0.3], latch: [0, 0.05, 0.09] },
  },
  // The bow's frame is its own (see `render/bow.ts`): only its add-on anchors are used, to place the arrow's departure.
  bow: {
    bore: 0.035, muzzle: 0.06, rear: [0.016, 0.035, -0.62], front: [0.016, 0.035, 0.04], port: [0.016, 0.035, -0.18], well: [0, -0.1, 0],
    grip: { p: [0, 0, 0], a: [0, 1, 0] },
    top: { y: 0.05, z: 0.0 }, under: { y: -0.08, z: 0.0 }, mag: { y: 0.0, z: 0.0 }, stock: { y: 0.0, z: -0.04 }, side: [0.03, 0.0, 0.0], r: 0.01,
  },
};
