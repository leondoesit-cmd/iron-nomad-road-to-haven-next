import { HEROES, type HeroId } from '../data/heroes';
import type { PortraitSpec } from './portrait';
import { NUHAT } from './nuhatLook';
import { UDUD, UDUD_GLASSES } from './ududLook';

/**
 * How Chinsky, Leo, Nar Divad, Lag Karab and the rest look: their heads (measured off their photographs, see `portrait.ts` for the frame the
 * numbers are in), their build from their real height and weight, and the clothes they wear under whatever kit they find.
 *
 * All three photos are phone selfies, which swell the nose and mouth and, for Leo's and Nar's (taken from below and to one
 * side), shorten the forehead and lengthen the chin. The numbers here are the photographs' proportions pulled back to what
 * the same faces measure at arm's length.
 */

export interface HeroLook {
  portrait: PortraitSpec;
  /** Skin of the neck, hands and anything else bare that the body parts draw. */
  skin: number;
  /** Their own clothes, worn when the body slot is empty: a shirt, and a knit cardigan over it when they have one. */
  shirt: number;
  /** Open cream blouse with a fitted waist and small necklaces. */
  blouse?: boolean;
  over?: number;
  /** A dark print on the T-shirt's front, and a cord worn round the neck. */
  print?: number;
  cord?: number;
  /** A quilted down jacket worn open over the T-shirt, in this colour (instead of a cardigan). */
  puffer?: number;
  /** Wraparound sunglasses, frame in this colour, worn whenever nothing else covers the eyes. */
  shades?: number;
  /** A pullover hoodie, hood down, with the sleeves pushed up to the elbows. */
  hoodie?: number;
  /** The hoodie's drawstrings: this colour (orange when not given), or none at all with null. */
  drawstrings?: number | null;
  rolledSleeves?: boolean;
  /** Open tropical overshirt with purple edging. */
  tropical?: number;
  /** Clear rectangular prescription glasses, frame in this colour. */
  glasses?: number;
  pants?: number;
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

const NAR: PortraitSpec = {
  id: 'nar',
  shape: {
    eyeY: 0.108,
    eyeX: 0.0325,
    eyeZ: 0.092,
    // Warm brown eyes nearly shut by a big grin: the cheeks push the lower lids up, the lids puff under them.
    eyeW: 0.0148,
    eyeOpen: 0.008,
    eyeTilt: 0.0004,
    eyeSmile: 0.0013,
    irisY: 0.0008,
    irisR: 0.0058,
    top: 0.228,
    halfW: 0.077,
    back: -0.106,
    brow: 0.012,
    eyeBag: 0.0035,
    // Broad cheekbones, the cheeks below them bunched up and round with the grin.
    cheekbone: [0.058, -0.012, -0.013, 0.024],
    cheek: [0.043, -0.035, 0.001, 0.027],
    // A strong nose, broad at the wings, the tip round and a little low.
    nose: { tipY: -0.043, tipZ: 0.035, tipR: 0.0128, baseY: -0.053, halfW: 0.0195, bridge: 0.011, bridgeR: 0.0064 },
    // A wide open grin: both corners well up, the upper lip thin and stretched under the moustache, the top teeth showing.
    mouth: { y: -0.07, halfW: 0.032, z: 0.01, upper: 0.0034, lower: 0.0074, lift: [0.0056, 0.006], open: 0.0085, teeth: 0xe9e2d4 },
    jaw: [0.05, -0.078, -0.09],
    chin: { y: -0.118, z: 0.006, halfW: 0.024, r: 0.015 },
    neck: { r: 0.06, z: -0.014 },
    // Big ears that stand well out.
    ear: { top: 0.016, h: 0.066, w: 0.035, z: -0.095, flare: 0.52 },
  },
  hair: {
    // Salt and pepper, short at the sides and fuller on top, brushed up and back off a forehead that is just starting to
    // go at the temples, a wave lifting at the front.
    line: [
      [0, 0.071],
      [14, 0.073],
      [27, 0.078],
      [37, 0.076],
      [47, 0.06],
      [57, 0.04],
      [67, 0.018],
      [75, 0.0],
      [80, -0.014],
      [85, 0.018],
      [100, 0.024],
      [114, 0.006],
      [124, -0.03],
      [136, -0.052],
      [180, -0.06],
    ],
    top: 0.018,
    side: 0.006,
    back: 0.007,
    taper: 0.01,
    quiff: [6, 46, 36, 15, 0.016],
    groove: 0.003,
    sweep: 0.25,
    strand: 1.4,
    color: 0x6e6a66,
    tip: 0xdedad4,
    rough: 0.7,
  },
  beard: {
    // A full beard kept fairly short, dark through the moustache and the middle of the chin and going grey along the jaw,
    // up the cheeks to the sideburns.
    line: [
      [0, -0.0535],
      [10, -0.0535],
      [18, -0.057],
      [26, -0.06],
      [36, -0.056],
      [48, -0.046],
      [60, -0.032],
      [70, -0.016],
      [80, 0.002],
      [90, 0.016],
    ],
    color: 0x262120,
    tip: 0xb8b3ab,
    depth: 0.008,
    chin: 1,
    jaw: 0.95,
    cheek: 0.75,
    grey: 0.42,
    salt: [0.25, 0.65],
  },
  paint: {
    // Sun-reddened: a ruddy forehead, nose and cheeks.
    skin: 0xc47c64,
    flush: 0xc85a4a,
    rosy: 0.7,
    shade: 0x84503f,
    lip: 0xb8625e,
    iris: 0x3a2214,
    brow: { color: 0x2e2420, head: [0.012, 0.0125], peak: [0.035, 0.0165], tail: [0.058, 0.0095], thick: [0.0105, 0.009, 0.0045] },
    crease: 0.0015,
    lash: 0.8,
    forehead: 0.55,
    crows: 0.85,
    folds: 0.65,
    age: 0.35,
    skinRoughness: 0.5,
  },
};

const LAG: PortraitSpec = {
  id: 'lag',
  shape: {
    eyeY: 0.108,
    eyeX: 0.032,
    eyeZ: 0.092,
    // Behind the sunglasses: dark eyes, narrowed by the grin.
    eyeW: 0.015,
    eyeOpen: 0.0072,
    eyeTilt: 0.0006,
    eyeSmile: 0.0012,
    irisY: 0.001,
    irisR: 0.0058,
    top: 0.227,
    halfW: 0.079,
    back: -0.105,
    brow: 0.0115,
    // A full oval face: round cheeks bunched up by the grin, filling out down to a soft jaw.
    cheekbone: [0.057, -0.012, -0.014, 0.024],
    cheek: [0.045, -0.036, 0.002, 0.03],
    jowl: [0.045, -0.072, -0.02, 0.02],
    // A big nose, long and straight, broad and round at the tip.
    nose: { tipY: -0.046, tipZ: 0.037, tipR: 0.0132, baseY: -0.056, halfW: 0.0205, bridge: 0.0115, bridgeR: 0.0064 },
    // A broad toothy grin, both corners up.
    mouth: { y: -0.073, halfW: 0.031, z: 0.011, upper: 0.0036, lower: 0.0078, lift: [0.005, 0.0052], open: 0.0075, teeth: 0xe6dcc6 },
    jaw: [0.05, -0.08, -0.09],
    chin: { y: -0.121, z: 0.006, halfW: 0.023, r: 0.015 },
    neck: { r: 0.058, z: -0.014 },
    ear: { top: 0.016, h: 0.064, w: 0.033, z: -0.095, flare: 0.42 },
  },
  hair: {
    // Near black and tightly curled, cropped short. The front has gone back a long way at the temples and the middle is
    // thin, so the forehead runs high; the sides are full down to the ears.
    line: [
      [0, 0.083],
      [10, 0.085],
      [20, 0.092],
      [30, 0.1],
      [40, 0.092],
      [48, 0.068],
      [55, 0.04],
      [62, 0.018],
      [72, 0.004],
      [79, -0.01],
      [85, 0.022],
      [100, 0.026],
      [114, 0.01],
      [124, -0.03],
      [136, -0.054],
      [180, -0.062],
    ],
    top: 0.018,
    side: 0.012,
    back: 0.011,
    taper: 0.007,
    groove: 0.0015,
    sweep: 0,
    strand: 0.6,
    curl: 0.005,
    color: 0x1c1512,
    tip: 0x4a3b32,
    rough: 0.85,
  },
  beard: {
    // Two or three days of stubble, dark with grey through it, over the chin, the lip and the jaw and thin on the cheeks.
    line: [
      [0, -0.056],
      [12, -0.055],
      [18, -0.061],
      [26, -0.063],
      [36, -0.057],
      [48, -0.046],
      [60, -0.034],
      [70, -0.022],
      [78, -0.01],
      [84, -0.002],
    ],
    color: 0x231c18,
    tip: 0xa49c92,
    depth: 0,
    chin: 0.5,
    jaw: 0.42,
    cheek: 0.24,
    grey: 0.3,
  },
  paint: {
    // Light olive, warm across the nose and cheeks.
    skin: 0xbc8664,
    flush: 0xb86a54,
    rosy: 0.35,
    shade: 0x80523f,
    lip: 0xb46c66,
    iris: 0x2a1a10,
    brow: { color: 0x1a1310, head: [0.012, 0.0135], peak: [0.034, 0.0172], tail: [0.058, 0.0105], thick: [0.0115, 0.01, 0.0048] },
    crease: 0.002,
    lash: 0.85,
    forehead: 0.6,
    crows: 0.5,
    folds: 0.6,
    age: 0.15,
    scalpGloss: 0.35,
  },
};

/**
 * Lag Karab with his mouth wide open for a bite: the jaw dropped, the lips pulled round the gap, the upper teeth along its
 * top and the tongue at the bottom. Swapped in for the head while he eats (`render/cake.ts`).
 */
export const LAG_GAPE: PortraitSpec = {
  ...LAG,
  id: 'lag-gape',
  shape: {
    ...LAG.shape,
    mouth: { y: -0.079, halfW: 0.026, z: 0.01, upper: 0.0042, lower: 0.0062, lift: [0.0015, 0.0015], open: 0.034, teeth: 0xe6dcc6, hollow: 0.004 },
    jaw: [0.049, -0.092, -0.09],
    chin: { y: -0.142, z: 0.003, halfW: 0.022, r: 0.015 },
  },
  beard: {
    ...LAG.beard,
    line: LAG.beard.line.map(([a, y]) => [a, a < 50 ? y - 0.008 : y] as const),
  },
};

/** Amirat from the doughnut and barbecue references: a full, broad face and a dense rounded cap of curls. */
const AMIRAT: PortraitSpec = {
  id: 'amirat',
  shape: {
    eyeY: 0.108, eyeX: 0.034, eyeZ: 0.093,
    eyeW: 0.014, eyeOpen: 0.0085, eyeTilt: 0.0004, eyeSmile: 0.0018, irisY: 0.001, irisR: 0.0058,
    top: 0.224, halfW: 0.083, back: -0.106, brow: 0.014,
    cheekbone: [0.059, -0.016, -0.013, 0.026],
    cheek: [0.046, -0.038, 0.003, 0.030],
    jowl: [0.049, -0.073, -0.012, 0.019],
    nose: { tipY: -0.038, tipZ: 0.030, tipR: 0.0155, baseY: -0.050, halfW: 0.023, bridge: 0.008, bridgeR: 0.007 },
    mouth: { y: -0.069, halfW: 0.032, z: 0.012, upper: 0.0038, lower: 0.0075, lift: [0.006, 0.0065], open: 0.008, teeth: 0xece3d2 },
    jaw: [0.055, -0.075, -0.084],
    chin: { y: -0.109, z: 0.006, halfW: 0.027, r: 0.017 },
    neck: { r: 0.060, z: -0.014 },
    ear: { top: 0.015, h: 0.060, w: 0.031, z: -0.092, flare: 0.32 },
  },
  hair: {
    line: [[0, 0.063], [14, 0.065], [28, 0.077], [40, 0.071], [50, 0.045], [65, 0.014], [78, -0.016], [86, 0.017], [106, 0.017], [122, -0.030], [140, -0.055], [180, -0.062]],
    top: 0.034, side: 0.012, back: 0.013, taper: 0.009,
    groove: 0.0008, sweep: 0, strand: 0.65, curl: 0.006,
    color: 0x101213, tip: 0x353433, rough: 0.82,
  },
  beard: {
    line: [[0, -0.053], [12, -0.055], [24, -0.062], [36, -0.058], [50, -0.045], [65, -0.030], [80, -0.008]],
    color: 0x29251f, tip: 0x635a4f, depth: 0, chin: 0.6, jaw: 0.48, cheek: 0.24, grey: 0.05,
  },
  paint: {
    skin: 0xbf9370, flush: 0xbf7960, rosy: 0.28, shade: 0x79513b, lip: 0xa96659, iris: 0x302219,
    brow: { color: 0x211d19, head: [0.012, 0.013], peak: [0.036, 0.015], tail: [0.062, 0.008], thick: [0.012, 0.011, 0.005] },
    crease: 0.0018, lash: 0.8, forehead: 0.3, crows: 0.45, folds: 0.6, age: 0.12, skinRoughness: 0.48,
  },
};

/** Iati from the front and side photographs: a high bare crown, dark side hair, a long full beard and clear spectacles. */
const IATI: PortraitSpec = {
  id: 'iati',
  shape: {
    eyeY: 0.108, eyeX: 0.033, eyeZ: 0.092,
    eyeW: 0.015, eyeOpen: 0.0077, eyeTilt: 0.0003, eyeSmile: 0.0003, irisY: 0.0005, irisR: 0.0057,
    top: 0.232, halfW: 0.079, back: -0.109, brow: 0.010, eyeBag: 0.003,
    cheekbone: [0.058, -0.013, -0.016, 0.023],
    cheek: [0.044, -0.036, -0.001, 0.027],
    jowl: [0.047, -0.077, -0.016, 0.018],
    nose: { tipY: -0.044, tipZ: 0.036, tipR: 0.013, baseY: -0.054, halfW: 0.021, bridge: 0.012, bridgeR: 0.0066 },
    mouth: { y: -0.074, halfW: 0.027, z: 0.01, upper: 0.0038, lower: 0.0074, lift: [0.0004, 0.0006] },
    jaw: [0.052, -0.082, -0.094],
    chin: { y: -0.126, z: 0.009, halfW: 0.025, r: 0.017 },
    neck: { r: 0.062, z: -0.017 },
    ear: { top: 0.017, h: 0.065, w: 0.032, z: -0.099, flare: 0.4 },
  },
  hair: {
    // The front hairline has receded almost to the crown; hair remains at the temples, sides and back.
    line: [[0, 0.145], [25, 0.14], [40, 0.12], [52, 0.085], [64, 0.035], [75, 0.001], [80, -0.012], [86, 0.02], [105, 0.026], [120, -0.022], [140, -0.055], [180, -0.065]],
    top: 0.009, side: 0.012, back: 0.013, taper: 0.01,
    groove: 0.002, sweep: -0.25, strand: 1.7,
    color: 0x211e1b, tip: 0x57534e, rough: 0.72, crownDensity: 0.035,
  },
  beard: {
    line: [[0, -0.057], [12, -0.056], [24, -0.06], [36, -0.052], [50, -0.039], [64, -0.023], [78, -0.002], [90, 0.014]],
    // The side view shows the beard standing well away from the chin, with thinner curls over the cheeks.
    color: 0x211c18, tip: 0x77736a, depth: 0.031,
    chin: 1, jaw: 0.97, cheek: 0.48, grey: 0.12, salt: [0.06, 0.18],
  },
  paint: {
    // Neutral skin colour: the reference's strong cyan light is lighting, not skin pigment.
    skin: 0xc89c7c, flush: 0xb87b67, rosy: 0.25, shade: 0x845b45, lip: 0xae7165, iris: 0x3b2b1e,
    brow: { color: 0x28211b, head: [0.012, 0.013], peak: [0.035, 0.016], tail: [0.058, 0.009], thick: [0.01, 0.009, 0.0045] },
    crease: 0.002, lash: 0.8, forehead: 0.65, crows: 0.6, folds: 0.55,
    age: 0.3, scalpGloss: 0.45, skinRoughness: 0.48,
  },
};

/**
 * Ro Karab, Lag's younger brother, from two photos: biting into a burger (squinting, the jaw wide) and laughing. A long,
 * straight nose, heavy dark brows, ears that stand out, and short wavy hair, near black with a lot of grey through it.
 * Clean-shaven: he usually is, though both photos have a beard. His own face grins with the top teeth showing; `RO_BITE` and `RO_LAUGH` are swapped in while he eats.
 */
const RO: PortraitSpec = {
  id: 'ro',
  shape: {
    eyeY: 0.108, eyeX: 0.0325, eyeZ: 0.092,
    // Dark eyes, crinkled by the grin.
    eyeW: 0.0145, eyeOpen: 0.0094, eyeTilt: 0.0005, eyeSmile: 0.001, irisY: 0.0008, irisR: 0.0058,
    top: 0.226, halfW: 0.077, back: -0.105, brow: 0.0125, eyeBag: 0.0028,
    // A longish oval face: cheeks bunched up by the grin, a squarish jaw.
    cheekbone: [0.056, -0.012, -0.014, 0.023],
    cheek: [0.043, -0.035, 0.001, 0.027],
    jowl: [0.045, -0.074, -0.018, 0.019],
    // A long, straight, prominent nose, the tip a little full.
    nose: { tipY: -0.048, tipZ: 0.038, tipR: 0.0126, baseY: -0.058, halfW: 0.019, bridge: 0.0125, bridgeR: 0.0062 },
    // A broad grin with the top teeth showing.
    mouth: { y: -0.075, halfW: 0.03, z: 0.011, upper: 0.0034, lower: 0.0074, lift: [0.0048, 0.0052], open: 0.0062, teeth: 0xe2d6b8 },
    jaw: [0.05, -0.082, -0.09],
    chin: { y: -0.124, z: 0.006, halfW: 0.023, r: 0.015 },
    neck: { r: 0.061, z: -0.014 },
    // Ears that stand well out from the head.
    ear: { top: 0.016, h: 0.064, w: 0.034, z: -0.095, flare: 0.5 },
  },
  hair: {
    // Short, thick and wavy, near black with grey strands all through it; a full front, just going at the temples, worn
    // a little forward.
    line: [
      [0, 0.074], [12, 0.076], [24, 0.083], [34, 0.088], [44, 0.072], [54, 0.046], [63, 0.022], [72, 0.004], [79, -0.012],
      [85, 0.02], [100, 0.024], [114, 0.008], [124, -0.03], [136, -0.053], [180, -0.061],
    ],
    top: 0.024, side: 0.009, back: 0.009, taper: 0.009,
    groove: 0.0032, sweep: -0.12, strand: 1.0, curl: 0.0025,
    color: 0x2a2421, tip: 0xd2cec6, rough: 0.76,
  },
  beard: {
    // Clean-shaven as he usually is: only the faint shadow of dark hair shaved, over the lip, chin and jaw.
    line: [[0, -0.0545], [10, -0.0545], [18, -0.058], [26, -0.061], [36, -0.057], [48, -0.047], [60, -0.034], [70, -0.019], [80, -0.002], [88, 0.014]],
    color: 0x2a2220, tip: 0x6a625a, depth: 0,
    chin: 0.1, jaw: 0.07, cheek: 0.03, grey: 0.05,
  },
  paint: {
    // Light olive, warmer across the nose and the ears.
    skin: 0xc48a66, flush: 0xc0664f, rosy: 0.42, shade: 0x83563f, lip: 0xb06a62, iris: 0x2c1c12,
    brow: { color: 0x16100e, head: [0.011, 0.0132], peak: [0.034, 0.0176], tail: [0.059, 0.0108], thick: [0.0122, 0.0108, 0.005] },
    crease: 0.0016, lash: 0.85, forehead: 0.6, crows: 0.8, folds: 0.62, age: 0.12, skinRoughness: 0.5,
  },
};

/** The chin and the beard on it dropped by `d`, for a mouth hanging open. */
const dropJaw = (s: PortraitSpec, d: number) => ({
  jaw: [s.shape.jaw[0], s.shape.jaw[1] - d * 0.35, s.shape.jaw[2]] as [number, number, number],
  chin: { ...s.shape.chin, y: s.shape.chin.y - d, z: s.shape.chin.z - 0.003 },
  beardLine: s.beard.line.map(([a, y]) => [a, a < 50 ? y - d * 0.5 : y] as const),
});

const RO_BITE_JAW = dropJaw(RO, 0.019);
/** Ro Karab with his jaw wide round a burger, squinting with the effort, as in the photo. */
export const RO_BITE: PortraitSpec = {
  ...RO,
  id: 'ro-bite',
  shape: {
    ...RO.shape,
    eyeOpen: 0.0062, eyeSmile: 0.0018,
    mouth: { y: -0.081, halfW: 0.027, z: 0.01, upper: 0.0042, lower: 0.0062, lift: [0.002, 0.002], open: 0.032, teeth: 0xe2d6b8, hollow: 0.004 },
    jaw: RO_BITE_JAW.jaw,
    chin: RO_BITE_JAW.chin,
  },
  beard: { ...RO.beard, line: RO_BITE_JAW.beardLine },
};

const RO_LAUGH_JAW = dropJaw(RO, 0.016);
/** Ro Karab laughing: mouth wide open and the corners pulled right up, top and bottom teeth, eyes crinkled nearly shut. */
export const RO_LAUGH: PortraitSpec = {
  ...RO,
  id: 'ro-laugh',
  shape: {
    ...RO.shape,
    eyeOpen: 0.0068, eyeSmile: 0.0022,
    cheek: [0.044, -0.032, 0.003, 0.028],
    mouth: { y: -0.08, halfW: 0.034, z: 0.011, upper: 0.0032, lower: 0.0064, lift: [0.0062, 0.0066], open: 0.036, teeth: 0xe2d6b8, lowerTeeth: true },
    jaw: RO_LAUGH_JAW.jaw,
    chin: RO_LAUGH_JAW.chin,
  },
  beard: { ...RO.beard, line: RO_LAUGH_JAW.beardLine },
  paint: { ...RO.paint, crows: 0.95, folds: 0.8 },
};

export const HERO_LOOKS: Record<HeroId, HeroLook> = {
  udud: {
    portrait: UDUD, skin: UDUD.paint.skin, shirt: 0x9a9c9d, pants: 0x343941,
    glasses: UDUD_GLASSES,
    ...build('udud'), neck: 0.025,
    head: (RIG_HEIGHT - 0.92 - 0.6 + 0.025) / UDUD.shape.top,
    hat: { y: 0.012, z: -0.001, s: 1.06 },
    mask: { y: -0.007, z: -0.004 },
  },
  nuhat: {
    portrait: NUHAT, skin: NUHAT.paint.skin, shirt: 0xf0e9db, blouse: true, pants: 0x292e38,
    ...build('nuhat'), neck: 0.009,
    head: (RIG_HEIGHT - 0.92 - 0.6 + 0.009) / NUHAT.shape.top,
    hat: { y: 0.008, z: -0.002, s: 1.04 },
    mask: { y: -0.009, z: -0.005 },
  },
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
  nar: {
    portrait: NAR,
    skin: NAR.paint.skin,
    // A pale mint T-shirt with a big dark print down the right of its front, and a dark cord round the neck.
    shirt: 0xc2d4c4,
    print: 0x1d2522,
    cord: 0x1a1614,
    ...build('nar'),
    neck: 0.034,
    hat: { y: 0.014, z: -0.001, s: 1.07 },
    mask: { y: -0.007, z: -0.004 },
  },
  lag: {
    portrait: LAG,
    skin: LAG.paint.skin,
    // A navy quilted down jacket worn open over a pale blue T-shirt, and black wraparound sunglasses.
    shirt: 0x9db3cc,
    puffer: 0x1b2337,
    shades: 0x0c0c0e,
    ...build('lag'),
    neck: 0.03,
    hat: { y: 0.013, z: -0.001, s: 1.065 },
    mask: { y: -0.007, z: -0.004 },
  },
  amirat: {
    portrait: AMIRAT, skin: AMIRAT.paint.skin,
    shirt: 0xc65b17, hoodie: 0xc65b17, rolledSleeves: true,
    ...build('amirat'), neck: 0.025,
    hat: { y: 0.013, z: -0.001, s: 1.06 },
    mask: { y: -0.007, z: -0.004 },
  },
  iati: {
    portrait: IATI, skin: IATI.paint.skin,
    shirt: 0x143f50, tropical: 0x67305e, rolledSleeves: true,
    glasses: 0x272c2e, pants: 0x806346,
    ...build('iati'), neck: 0.033,
    // Keep the bare crown at the supplied standing height despite this portrait's taller forehead.
    head: (RIG_HEIGHT - 0.6 + 0.033 - 0.92) / IATI.shape.top,
    hat: { y: 0.017, z: -0.004, s: 1.08 },
    mask: { y: -0.01, z: -0.004 },
  },
  ro: {
    portrait: RO, skin: RO.paint.skin,
    // A charcoal marl pullover hoodie, hood down, no drawstrings, the sleeves down to the wrists.
    shirt: 0x3c3e41, hoodie: 0x3c3e41, drawstrings: null,
    ...build('ro'), neck: 0.032,
    hat: { y: 0.013, z: -0.001, s: 1.065 },
    mask: { y: -0.007, z: -0.004 },
  },
};
