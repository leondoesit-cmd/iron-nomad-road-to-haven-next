import { HEROES, type HeroId } from '../data/heroes';
import type { PortraitSpec } from './portrait';

/**
 * How Chinsky and Leo look: their heads (measured off their photographs, see `portrait.ts` for the frame the numbers are
 * in), their build from their real height and weight, and the clothes they wear under whatever kit they find.
 *
 * Both photos are phone selfies, which swell the nose and mouth and, for Leo's (taken from below and to one side),
 * shorten the forehead and lengthen the chin. The numbers here are the photographs' proportions pulled back to what the
 * same faces measure at arm's length.
 */

export interface HeroLook {
  portrait: PortraitSpec;
  /** Skin of the neck, hands and anything else bare that the body parts draw. */
  skin: number;
  /** Their own clothes, worn when the body slot is empty: a shirt, and a knit cardigan over it when they have one. */
  shirt: number;
  over?: number;
  /** Uniform scale of the rig (from the height), girth of torso and limbs (from the weight), and how far the belly sits out. */
  scale: number;
  girth: number;
  belly: number;
  /**
   * The head is measured life size; the game draws everyone with a slightly big head on a bulky body, so it is scaled up
   * by this much to sit right among them.
   */
  head: number;
  /** How much lower than the stock rig's the head sits on the shoulders: a short, thick neck. */
  neck: number;
  /** Head gear drawn for the stock head: lifted and enlarged to sit on this skull. Face gear: moved to these eyes and mouth. */
  hat: { y: number; z: number; s: number };
  mask: { y: number; z: number };
}

/** The rig's own standing height, top of the skull, before any scale: hips 0.92, head 0.6 above them, crown 0.215 above that. */
export const RIG_HEIGHT = 1.735;
/** Weight per height of the stock rig, the build every survivor was drawn at. */
const RIG_BUILD = 70 / RIG_HEIGHT;

function build(id: HeroId) {
  const h = HEROES[id];
  // Cross-section grows with weight per unit height; the difference is pushed a little past life so it reads at a distance.
  const raw = Math.sqrt(h.weight / h.height / RIG_BUILD);
  const bmi = h.weight / (h.height * h.height);
  return {
    scale: h.height / RIG_HEIGHT,
    girth: 1 + (raw - 1) * 1.4,
    belly: Math.max(0, Math.min(0.2, (bmi - 23) * 0.03)),
    head: 1.1,
  };
}

const CHINSKY: PortraitSpec = {
  id: 'chinsky',
  shape: {
    eyeY: 0.108,
    eyeX: 0.0315,
    eyeZ: 0.093,
    // Narrow and smiling: the cheeks push the lower lids up into crescents.
    eyeW: 0.014,
    eyeOpen: 0.0058,
    eyeTilt: 0.0012,
    eyeSmile: 0.0017,
    irisY: 0.0006,
    irisR: 0.0056,
    top: 0.225,
    halfW: 0.0775,
    back: -0.103,
    brow: 0.009,
    // A broad, round face, the cheeks full and lifted by the smile, staying wide down to the jaw.
    cheekbone: [0.056, -0.012, -0.014, 0.023],
    cheek: [0.04, -0.034, 0.002, 0.028],
    // A broad nose with a round tip.
    nose: { tipY: -0.04, tipZ: 0.032, tipR: 0.013, baseY: -0.05, halfW: 0.02, bridge: 0.0075, bridgeR: 0.0066 },
    // A wide, closed smile: both corners up, the upper lip lost under the moustache, a full lower one.
    mouth: { y: -0.068, halfW: 0.029, z: 0.011, upper: 0.0026, lower: 0.0086, lift: [0.0042, 0.0046] },
    jaw: [0.05, -0.073, -0.093],
    chin: { y: -0.111, z: 0.003, halfW: 0.023, r: 0.0145 },
    neck: { r: 0.062, z: -0.012 },
    ear: { top: 0.017, h: 0.06, w: 0.031, z: -0.097, flare: 0.38 },
  },
  hair: {
    // Short and mid brown, well back off the forehead and deep into the temples, a small lock left of centre, and the
    // sides down to the ears.
    line: [
      [0, 0.08],
      [12, 0.086],
      [22, 0.104],
      [32, 0.112],
      [40, 0.094],
      [47, 0.062],
      [53, 0.036],
      [60, 0.018],
      [70, 0.004],
      [78, -0.008],
      [84, 0.024],
      [100, 0.026],
      [112, 0.012],
      [122, -0.03],
      [135, -0.055],
      [180, -0.064],
    ],
    lock: [6, 8, 0.006],
    top: 0.012,
    side: 0.006,
    back: 0.006,
    taper: 0.008,
    groove: 0.0018,
    sweep: 0.15,
    strand: 2.2,
    color: 0x5a4030,
    tip: 0x8e6c50,
    rough: 0.72,
  },
  beard: {
    // A full, short beard, gingery against the brown of his hair, joined to the moustache and up into the sideburns, thin
    // high on the cheeks.
    line: [
      [0, -0.0505],
      [10, -0.05],
      [16, -0.054],
      [22, -0.058],
      [32, -0.053],
      [45, -0.045],
      [58, -0.03],
      [70, -0.012],
      [80, 0.008],
      [90, 0.02],
    ],
    color: 0x8a5632,
    tip: 0xb88250,
    depth: 0.0045,
    chin: 1,
    jaw: 0.92,
    cheek: 0.6,
    grey: 0.02,
  },
  paint: {
    skin: 0xcc947a,
    flush: 0xc87060,
    rosy: 0.55,
    shade: 0x8a5a48,
    lip: 0xc0706c,
    iris: 0x3a2618,
    brow: { color: 0x3a2a1e, head: [0.013, 0.0095], peak: [0.036, 0.0125], tail: [0.058, 0.007], thick: [0.0105, 0.0095, 0.005] },
    crease: 0,
    lash: 0.75,
    forehead: 0.2,
    crows: 0.6,
    folds: 0.45,
  },
};

const LEO: PortraitSpec = {
  id: 'leo',
  shape: {
    eyeY: 0.108,
    eyeX: 0.032,
    eyeZ: 0.091,
    // Dark almond eyes set deep under a heavy brow, a visible crease above them, narrowed a little by the smirk.
    eyeW: 0.0152,
    eyeOpen: 0.0086,
    eyeTilt: 0.0008,
    eyeSmile: 0.0008,
    irisY: 0.0012,
    irisR: 0.006,
    top: 0.226,
    halfW: 0.0745,
    back: -0.108,
    brow: 0.0135,
    // A long face: cheekbones that stand out over lean cheeks.
    cheekbone: [0.056, -0.01, -0.017, 0.021],
    cheek: [0.04, -0.036, -0.011, 0.024],
    // A long, straight, prominent nose, broad across the wings.
    nose: { tipY: -0.043, tipZ: 0.037, tipR: 0.0108, baseY: -0.053, halfW: 0.0185, bridge: 0.012, bridgeR: 0.0058 },
    // Full lips in a smirk: the left corner (his own left) lifted more than the right.
    mouth: { y: -0.071, halfW: 0.0285, z: 0.012, upper: 0.0058, lower: 0.0084, lift: [0.001, 0.0045] },
    // A strong, square jaw and a long chin.
    jaw: [0.047, -0.077, -0.091],
    chin: { y: -0.117, z: 0.007, halfW: 0.021, r: 0.0135 },
    neck: { r: 0.0515, z: -0.016 },
    ear: { top: 0.014, h: 0.066, w: 0.034, z: -0.096, flare: 0.42 },
  },
  hair: {
    // Near black, a high quiff swept up off his right side and over to the left, short at the sides.
    line: [
      [0, 0.074],
      [15, 0.075],
      [28, 0.081],
      [38, 0.08],
      [50, 0.062],
      [62, 0.036],
      [72, 0.008],
      [78, -0.012],
      [82, -0.012],
      [86, 0.02],
      [102, 0.024],
      [114, 0.008],
      [124, -0.03],
      [136, -0.052],
      [180, -0.058],
    ],
    top: 0.009,
    side: 0.005,
    back: 0.008,
    taper: 0.012,
    quiff: [-24, 58, 24, 11, 0.03],
    groove: 0.005,
    sweep: 0.6,
    strand: 1,
    color: 0x2a201c,
    tip: 0x5c4a40,
    rough: 0.78,
  },
  beard: {
    // Light dark stubble, a shadow more than a beard: most on the chin and over the lip, with some grey in it.
    line: [
      [0, -0.0535],
      [12, -0.053],
      [18, -0.06],
      [26, -0.062],
      [36, -0.056],
      [48, -0.045],
      [60, -0.034],
      [70, -0.024],
      [78, -0.012],
      [84, -0.004],
    ],
    color: 0x2a201e,
    tip: 0x9a948c,
    depth: 0,
    chin: 0.28,
    jaw: 0.19,
    cheek: 0.1,
    grey: 0.12,
  },
  paint: {
    skin: 0xc8936f,
    flush: 0xc27e68,
    rosy: 0.12,
    shade: 0x7a4e40,
    lip: 0xb46a68,
    iris: 0x2a180c,
    brow: { color: 0x1d1512, head: [0.011, 0.0145], peak: [0.032, 0.0188], tail: [0.058, 0.011], thick: [0.011, 0.0095, 0.0042] },
    crease: 0.0034,
    lash: 0.9,
    forehead: 0.75,
    crows: 0.35,
    folds: 0.3,
  },
};

export const HERO_LOOKS: Record<HeroId, HeroLook> = {
  chinsky: {
    portrait: CHINSKY,
    skin: CHINSKY.paint.skin,
    // A black knit cardigan over a grey T-shirt.
    shirt: 0x8a8986,
    over: 0x1b1b1d,
    ...build('chinsky'),
    neck: 0.024,
    hat: { y: 0.012, z: 0, s: 1.06 },
    mask: { y: -0.007, z: -0.004 },
  },
  leo: {
    portrait: LEO,
    skin: LEO.paint.skin,
    // A navy T-shirt.
    shirt: 0x1f2944,
    ...build('leo'),
    neck: 0,
    hat: { y: 0.013, z: -0.002, s: 1.06 },
    mask: { y: -0.007, z: -0.005 },
  },
};
