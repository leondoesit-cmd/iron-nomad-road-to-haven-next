import type { PortraitSpec } from './portraitPaint';

/** Nuhat's supplied portrait: oval face, warm brown skin, almond eyes and berry lips. */
export const NUHAT: PortraitSpec = {
  id: 'nuhat',
  shape: {
    eyeY: 0.108, eyeX: 0.0315, eyeZ: 0.091,
    eyeW: 0.015, eyeOpen: 0.0088, eyeTilt: 0.0014, eyeSmile: 0.0008,
    irisY: 0.0007, irisR: 0.006,
    top: 0.221, halfW: 0.073, back: -0.103, brow: 0.0065,
    cheekbone: [0.052, -0.015, -0.015, 0.024],
    cheek: [0.037, -0.039, -0.001, 0.024],
    nose: { tipY: -0.041, tipZ: 0.026, tipR: 0.0118, baseY: -0.052, halfW: 0.0195, bridge: 0.006, bridgeR: 0.0056 },
    mouth: { y: -0.074, halfW: 0.0275, z: 0.012, upper: 0.0056, lower: 0.008, lift: [0.0015, 0.002], open: 0.0015, teeth: 0xf0e7dc },
    jaw: [0.040, -0.078, -0.095],
    chin: { y: -0.114, z: 0.002, halfW: 0.020, r: 0.012 },
    neck: { r: 0.044, z: -0.015 },
    ear: { top: 0.010, h: 0.059, w: 0.028, z: -0.091, flare: 0.27 },
  },
  // A close scalp beneath individually modelled long box braids (NuhatRig).
  hair: {
    line: [[0, 0.073], [20, 0.077], [38, 0.080], [55, 0.061], [70, 0.024], [80, -0.008], [90, 0.012], [110, 0.004], [130, -0.042], [180, -0.059]],
    top: 0.006, side: 0.004, back: 0.005, taper: 0.008,
    groove: 0.0007, sweep: -0.6, strand: 2.5,
    color: 0x151315, tip: 0x302b2d, rough: 0.7,
  },
  beard: { line: [[0, -0.080], [90, -0.08]], color: 0x171214, tip: 0x171214, depth: 0, chin: 0, jaw: 0, cheek: 0, grey: 0 },
  paint: {
    skin: 0x945e43, flush: 0x985445, rosy: 0.12, shade: 0x573529,
    lip: 0x863744, iris: 0x291c16,
    brow: { color: 0x302019, head: [0.012, 0.013], peak: [0.036, 0.019], tail: [0.058, 0.010], thick: [0.0055, 0.0048, 0.0025] },
    crease: 0.0028, lash: 1.1, forehead: 0.04, crows: 0.08, folds: 0.22,
    skinRoughness: 0.52, lipRoughness: 0.35,
  },
};

export const NUHAT_SMILE: PortraitSpec = {
  ...NUHAT, id: 'nuhat-smile',
  shape: {
    ...NUHAT.shape, eyeOpen: 0.0075, eyeSmile: 0.002,
    cheek: [0.039, -0.035, 0.001, 0.025],
    mouth: { ...NUHAT.shape.mouth, halfW: 0.031, lift: [0.0055, 0.006], open: 0.009 },
  },
};

export const NUHAT_TALK: PortraitSpec = {
  ...NUHAT, id: 'nuhat-talk',
  shape: {
    ...NUHAT.shape,
    mouth: { ...NUHAT.shape.mouth, y: -0.078, halfW: 0.025, lift: [0.002, 0.0025], open: 0.024, lowerTeeth: true, hollow: 0.003 },
    jaw: [0.040, -0.085, -0.095],
    chin: { ...NUHAT.shape.chin, y: -0.128 },
  },
};

export const NUHAT_WONDER: PortraitSpec = {
  ...NUHAT, id: 'nuhat-wonder',
  shape: {
    ...NUHAT.shape, eyeOpen: 0.0105, eyeSmile: 0,
    mouth: { ...NUHAT.shape.mouth, halfW: 0.024, lift: [0.0005, 0.001], open: 0.002 },
  },
  paint: {
    ...NUHAT.paint,
    brow: { ...NUHAT.paint.brow, head: [0.012, 0.017], peak: [0.036, 0.025], tail: [0.058, 0.013] },
  },
};
