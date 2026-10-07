import type { PortraitSpec } from './portrait';

export const UDUD_GLASSES = 0x252c49;

/** Udud's reference: dark curls, a broad smiling face, short beard and blue rectangular spectacles. */
export const UDUD: PortraitSpec = {
  id: 'udud',
  shape: {
    eyeY: 0.108, eyeX: 0.033, eyeZ: 0.092,
    eyeW: 0.015, eyeOpen: 0.0065, eyeTilt: 0.0005, eyeSmile: 0.0018,
    irisY: 0.0008, irisR: 0.0058,
    top: 0.224, halfW: 0.079, back: -0.106, brow: 0.010,
    cheekbone: [0.058, -0.014, -0.014, 0.024],
    cheek: [0.044, -0.035, 0.002, 0.029],
    jowl: [0.046, -0.074, -0.015, 0.018],
    nose: { tipY: -0.043, tipZ: 0.034, tipR: 0.0138, baseY: -0.053, halfW: 0.021, bridge: 0.010, bridgeR: 0.0068 },
    mouth: { y: -0.072, halfW: 0.030, z: 0.011, upper: 0.0035, lower: 0.0078, lift: [0.004, 0.0055], open: 0.003, teeth: 0xece3d7 },
    jaw: [0.051, -0.080, -0.091],
    chin: { y: -0.118, z: 0.005, halfW: 0.025, r: 0.016 },
    neck: { r: 0.059, z: -0.014 },
    ear: { top: 0.016, h: 0.064, w: 0.032, z: -0.095, flare: 0.4 },
  },
  hair: {
    line: [[0, 0.074], [12, 0.069], [26, 0.079], [38, 0.086], [48, 0.065], [58, 0.035], [70, 0.009], [79, -0.012], [86, 0.020], [104, 0.024], [118, -0.019], [136, -0.052], [180, -0.062]],
    lock: [7, 9, 0.006],
    top: 0.028, side: 0.009, back: 0.010, taper: 0.008,
    groove: 0.0015, sweep: 0.08, strand: 0.7, curl: 0.008,
    color: 0x191613, tip: 0x493c31, rough: 0.8,
  },
  beard: {
    line: [[0, -0.054], [12, -0.054], [24, -0.061], [36, -0.056], [49, -0.045], [62, -0.029], [78, -0.007], [90, 0.016]],
    color: 0x30231c, tip: 0x70513a, depth: 0.006,
    chin: 1, jaw: 0.95, cheek: 0.50, grey: 0.025,
  },
  paint: {
    skin: 0xcba087, flush: 0xc78473, rosy: 0.25, shade: 0x865d48,
    lip: 0xb7756b, iris: 0x37271b,
    brow: { color: 0x29201b, head: [0.012, 0.013], peak: [0.035, 0.016], tail: [0.059, 0.009], thick: [0.010, 0.009, 0.004] },
    crease: 0.0018, lash: 0.8, forehead: 0.25, crows: 0.5, folds: 0.5,
    skinRoughness: 0.52,
  },
};
