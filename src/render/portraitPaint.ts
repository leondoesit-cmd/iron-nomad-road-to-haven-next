import { valueNoise2, valueNoise3 } from '../core/noise';
import { clamp01, lerp, smoothstep } from '../core/math';

/**
 * The plain-arithmetic half of the portrait heads (see `portrait.ts`): what a head is described by, the grid its surface is
 * sampled on, where hair grows, and the painter that colours the texture texel by texel. No engine imports, so a worker can
 * paint while the game runs.
 *
 * Everything is in head-local metres: origin on the neck pivot, +Y up, +Z out of the face, +X the person's own left.
 * Heights are given against the eye line and depths against the front of the eyes, so a spec reads like the measurements
 * taken off a photograph.
 */

export type V2 = readonly [number, number];
export type V3 = readonly [number, number, number];

export interface HeadShape {
  /** Eye line height, half the distance between the pupils, and the front of the eyes. Absolute, head-local. */
  eyeY: number;
  eyeX: number;
  eyeZ: number;
  /** Half the width of the eye opening, how far it is open, and how much higher the outer corner sits. */
  eyeW: number;
  eyeOpen: number;
  eyeTilt: number;
  /** How far a smile pushes the lower lids up (the eyes narrow into crescents), metres. */
  eyeSmile: number;
  /** Where the iris sits against the eye line (the upper lid covers its top), and its radius. */
  irisY: number;
  irisR: number;
  /** Top of the skull, half its breadth, and the back of it. Absolute. */
  top: number;
  halfW: number;
  back: number;
  /** How far the brow ridge stands out in front of the eyes. */
  brow: number;
  /** Cheekbones and cheeks: [half width, height, depth, size] against the eye line and the eye front. */
  cheekbone: [number, number, number, number];
  cheek: [number, number, number, number];
  /** Soft tissue beside the lower jaw: [half width, height, depth, radius] relative to the eye line/front. */
  jowl?: [number, number, number, number];
  /** Fullness of the lower eyelids, in metres. */
  eyeBag?: number;
  /** Soft tissue below the chin, in metres. */
  underChin?: number;
  nose: {
    /** Tip: height against the eye line, how far in front of the eyes, roundness. */
    tipY: number;
    tipZ: number;
    tipR: number;
    /** Under the nostrils, against the eye line; half the width across the wings. */
    baseY: number;
    halfW: number;
    /** Bridge: how far in front of the eyes at the top, and its thickness. */
    bridge: number;
    bridgeR: number;
  };
  mouth: {
    /** Lip line against the eye line, half the width, how far in front of the eyes. */
    y: number;
    halfW: number;
    z: number;
    /** Heights of the red of the lips. */
    upper: number;
    lower: number;
    /** How much each corner (the person's right, then left) is lifted: a smile, or a smirk when they differ. */
    lift: [number, number];
    /** Gap between the lips at the centre (0 is closed). */
    open?: number;
    /** Colour of the upper teeth showing in that gap (a grin); without it the gap is dark. */
    teeth?: number;
    /** Depth of the hollow below the lower lip; defaults to 6 mm. */
    hollow?: number;
    /** The lower teeth showing along the bottom of the gap too (a laugh), in the same colour. */
    lowerTeeth?: boolean;
  };
  /** Jaw angle: [half width, height, depth] against the eye line and the eye front. */
  jaw: [number, number, number];
  /** Chin: bottom against the eye line, front against the eye front, half width, roundness. */
  chin: { y: number; z: number; halfW: number; r: number };
  /** Neck: radius and how far forward its axis runs (absolute). */
  neck: { r: number; z: number };
  /** Ear: top against the eye line, height, width, front edge against the eye front, how far it stands out (radians). */
  ear: { top: number; h: number; w: number; z: number; flare: number };
}

export interface HairSpec {
  /** The hairline, as [azimuth in degrees from the front, height against the eye line], front to back, mirrored. */
  line: V2[];
  /** A lock that comes lower than the rest of the hairline: [azimuth deg (+ is the person's left), width deg, drop]. */
  lock?: [number, number, number];
  /** Thickness on top, at the sides and at the back, and the climb from the hairline to full thickness. */
  top: number;
  side: number;
  back: number;
  taper: number;
  /** A quiff: [azimuth deg, elevation deg, half width deg, half height deg, extra thickness]. */
  quiff?: [number, number, number, number, number];
  /** Groove depth of the clumps; how far the strands sweep round (radians of azimuth over the head); strand length (1 is long). */
  groove: number;
  sweep: number;
  strand: number;
  color: number;
  tip: number;
  rough: number;
  /** Density above the upper forehead; the side fringe stays full. Defaults to 1. */
  crownDensity?: number;
  /** Tight curls: the height of the little knots the hair stands up in (metres), painted as coils instead of strands. */
  curl?: number;
}

export interface FacialHair {
  /** Top edge of the hair on the cheek, as [azimuth deg, height against the eye line], from the middle out to the sideburn. */
  line: V2[];
  color: number;
  tip: number;
  /** Full beard thickness (0 for stubble), and how dense it is at the chin and moustache, along the jaw, and on the cheek. */
  depth: number;
  chin: number;
  jaw: number;
  cheek: number;
  /** The share of hairs that are grey. */
  grey: number;
  /**
   * A full beard going grey unevenly: the share of grey hairs through the moustache and the middle of the chin, and along
   * the jaw and up the cheeks. Each hair is dark or grey, finely mixed. Without it the full beard is mottled in clumps.
   */
  salt?: [number, number];
}

export interface FacePaint {
  skin: number;
  /** The redder tone of cheeks, nose and ears, and how rosy the cheeks are. */
  flush: number;
  rosy: number;
  /** Creases, sockets and the darker skin under the eyes. */
  shade: number;
  lip: number;
  iris: number;
  /** Brow: [distance out from the middle, height against the eye line] of its head, peak and tail; thickness at each. */
  brow: { color: number; head: V2; peak: V2; tail: V2; thick: V3 };
  /** Upper lid crease above the lid (0 for none, hidden under a smile); how dark the lash line is. */
  crease: number;
  lash: number;
  /** Lines: across the forehead, crow's feet, and the folds from the nose to the mouth. */
  forehead: number;
  crows: number;
  folds: number;
  skinRoughness?: number;
  lipRoughness?: number;
  /** Extra gloss on the exposed upper forehead and crown, 0 to 1. */
  scalpGloss?: number;
  /** Lower-eyelid folds and small age spots, 0 to 1. */
  age?: number;
}

export interface PortraitSpec {
  id: string;
  shape: HeadShape;
  hair: HairSpec;
  beard: FacialHair;
  paint: FacePaint;
}

// ------------------------------------------------------------------------------------------ surface grid

/**
 * Columns round the head and rows from the bottom to the top. Columns crowd round the front and rows round the level of
 * the ray origin (just under the eyes), where the face is; the texture follows the grid, so it is sharpest there too.
 */
export const GRID_U = 128;
export const GRID_V = 96;
const FRONT_DENSITY = 0.5;
const LEVEL_DENSITY = 0.55;
/** The rays start on this vertical line, a little behind the eyes, at a height just under the eye line. */
export const RAY_Z = -0.006;
export const rayY = (s: HeadShape) => s.eyeY - 0.01;

/** Azimuth of a column: 0 straight ahead, positive toward +X (the person's left). */
export function thetaAt(u: number) {
  const t = 2 * u - 1;
  return Math.PI * (FRONT_DENSITY * t + (1 - FRONT_DENSITY) * t * t * t);
}

/** Elevation of a row: 0 level with the ray origin, rows closest together there. */
export function phiAt(v: number) {
  const w = 2 * v - 1;
  return (Math.PI / 2) * (LEVEL_DENSITY * w + (1 - LEVEL_DENSITY) * w * w * w);
}

/** Azimuth of a head-local point round the line the rays start from: what the texture's u measures. */
export function azimuthOf(x: number, z: number) {
  return Math.atan2(x, z - RAY_Z);
}

// ------------------------------------------------------------------------------------------ regions

/** Piecewise-linear lookup in a list of [x, y] points sorted by x, held flat past the ends. */
function curve(pts: readonly V2[], x: number): number {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return pts[pts.length - 1][1];
}

export const DEG = 180 / Math.PI;

/** Hairline heights round the head, one per tenth of a degree, worked out once per person. */
const hairlines = new WeakMap<PortraitSpec, Float32Array>();
const HAIRLINE_STEPS = 3600;

/** Height of the hairline (absolute) at an azimuth in radians: the spec's line, a lock, and a little natural unevenness. */
export function hairlineAt(spec: PortraitSpec, th: number): number {
  let t = hairlines.get(spec);
  if (!t) {
    t = new Float32Array(HAIRLINE_STEPS + 1);
    const h = spec.hair;
    for (let i = 0; i <= HAIRLINE_STEPS; i++) {
      const a = -Math.PI + (i / HAIRLINE_STEPS) * Math.PI * 2;
      let y = spec.shape.eyeY + curve(h.line, Math.abs(a) * DEG);
      if (h.lock) {
        const [at, w, drop] = h.lock;
        const d = (a * DEG - at) / w;
        y -= drop * Math.exp(-d * d);
      }
      t[i] = y + (valueNoise2(a * 9, 0.5, 91) - 0.5) * 0.006 + (valueNoise2(a * 31, 1.5, 92) - 0.5) * 0.0025;
    }
    hairlines.set(spec, t);
  }
  const f = ((th + Math.PI) / (Math.PI * 2)) * HAIRLINE_STEPS;
  const i = Math.max(0, Math.min(HAIRLINE_STEPS - 1, Math.floor(f)));
  return t[i] + (t[i + 1] - t[i]) * (f - i);
}

/** 0 to 1: how much hair grows on the scalp here, with a soft hairline. */
export function scalpCover(spec: PortraitSpec, th: number, y: number): number {
  return smoothstep(-0.002, 0.004, y - hairlineAt(spec, th)) * scalpDensity(spec, y);
}

/** Thinning above a full side fringe, shared by the painter and hair shell. */
export function scalpDensity(spec: PortraitSpec, y: number): number {
  return lerp(1, spec.hair.crownDensity ?? 1, smoothstep(spec.shape.eyeY + 0.05, spec.shape.eyeY + 0.10, y));
}

/**
 * 0 to 1: how much facial hair grows at a point, from the cheek line down, round the jaw and under the chin to the neck.
 * Used both to grow a beard's volume (`volume`, which keeps the lips clear so they are not buried) and to paint it (the
 * lips are painted over it afterwards, so the hair meets them without a gap).
 */
export function beardCover(spec: PortraitSpec, x: number, y: number, z: number, volume = false): number {
  const s = spec.shape;
  const b = spec.beard;
  const E = s.eyeY;
  const a = Math.abs(azimuthOf(x, z)) * DEG;
  if (a > 100) return 0;
  // Down from the cheek line, thinning out over the last centimetre; in front of the ear the sideburn joins the scalp hair.
  const top = E + curve(b.line, a);
  let c = smoothstep(top + 0.004, top - 0.01, y);
  if (c <= 0) return 0;
  // Under the jaw it stops a little short of the neck; a full beard comes closer.
  const nr = Math.hypot(x, z - s.neck.z);
  const under = smoothstep(E + s.jaw[1] + 0.01, E + s.jaw[1] - 0.012, y);
  const keep = b.depth > 0 ? smoothstep(s.neck.r - 0.002, s.neck.r + 0.01, nr) : smoothstep(s.neck.r + 0.003, s.neck.r + 0.016, nr);
  c *= 1 - under * (1 - keep);
  if (volume) {
    // The beard thins to nothing round the lips, so they are not sunk in it.
    const m = s.mouth;
    const lx = Math.abs(x) / (m.halfW + 0.004);
    if (lx < 1.2 && z > s.eyeZ - 0.04) {
      const lift = m.lift[x < 0 ? 0 : 1] * Math.pow(Math.min(lx, 1), 2.2);
      const ly = y - (E + m.y + lift);
      const lip = smoothstep(m.upper + 0.006, m.upper * 0.4, ly) * smoothstep(-m.lower - 0.008, -m.lower * 0.4, ly);
      c *= 1 - lip * smoothstep(1.2, 0.85, lx);
    }
  }
  // Behind the jaw, back toward the ear, it fades out.
  return c * smoothstep(100, 88, a);
}

// ------------------------------------------------------------------------------------------ painting

type RGB = [number, number, number];
const rgb = (hex: number): RGB => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];

/** Distance from a point to a segment in out[0], and how far along it the closest point is in out[1]. */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number, out: Float64Array) {
  const vx = bx - ax;
  const vy = by - ay;
  const t = clamp01(((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy));
  const dx = px - (ax + vx * t);
  const dy = py - (ay + vy * t);
  out[0] = Math.sqrt(dx * dx + dy * dy);
  out[1] = t;
}

const N = valueNoise3;
const vn2 = valueNoise2;

/**
 * Paints the texture one texel at a time from the surface point under it. Colours are sRGB in 0 to 1; the fourth
 * channel is roughness. Each feature writes its colour into `tmp` and returns how much of it covers the texel.
 */
export class FacePainter {
  private c: Record<'skin' | 'flush' | 'shade' | 'lip' | 'iris' | 'brow' | 'hair' | 'hairTip' | 'beard' | 'beardTip' | 'teeth', RGB>;
  private seg = new Float64Array(2);
  private tmp = new Float32Array(4);
  private r = 0;
  private g = 0;
  private b = 0;

  constructor(private s: PortraitSpec) {
    const p = s.paint;
    this.c = {
      skin: rgb(p.skin),
      flush: rgb(p.flush),
      shade: rgb(p.shade),
      lip: rgb(p.lip),
      iris: rgb(p.iris),
      brow: rgb(p.brow.color),
      hair: rgb(s.hair.color),
      hairTip: rgb(s.hair.tip),
      beard: rgb(s.beard.color),
      beardTip: rgb(s.beard.tip),
      teeth: rgb(s.shape.mouth.teeth ?? 0x211311),
    };
  }

  private mix(col: ArrayLike<number>, k: number) {
    if (k <= 0) return;
    const t = k > 1 ? 1 : k;
    this.r += (col[0] - this.r) * t;
    this.g += (col[1] - this.g) * t;
    this.b += (col[2] - this.b) * t;
  }

  private darken(k: number) {
    const t = 1 - (k > 1 ? 1 : k);
    this.r *= t;
    this.g *= t;
    this.b *= t;
  }

  paint(x: number, y: number, z: number, ny: number, nz: number, out: Float32Array) {
    const s = this.s.shape;
    const p = this.s.paint;
    const C = this.c;
    const tmp = this.tmp;
    const E = s.eyeY;
    const Z = s.eyeZ;
    const ax = Math.abs(x);
    const side = x < 0 ? 0 : 1;
    const front = z > Z - 0.06 && nz > -0.2;
    // Skin: blotchy at a centimetre, grainy at a millimetre, redder in the blotches.
    const blotch = N(x * 90, y * 90, z * 90, 3) - 0.5;
    const grain = N(x * 1100, y * 1100, z * 1100, 4) - 0.5;
    this.r = C.skin[0] * (1 + blotch * 0.08 + grain * 0.05);
    this.g = C.skin[1] * (1 + blotch * 0.03 + grain * 0.05);
    this.b = C.skin[2] * (1 + blotch * 0.04 + grain * 0.055);
    let rough = p.skinRoughness ?? 0.55;
    if (p.scalpGloss) rough -= p.scalpGloss * smoothstep(E + 0.045, E + 0.10, y) * smoothstep(-0.2, 0.7, ny);
    if (front) {
      // Flush on the cheeks and the nose.
      const cx = (ax - s.cheek[0] - 0.006) / 0.024;
      const cy = (y - (E + s.cheek[1] + 0.012)) / 0.02;
      const nose = (ax / 0.013) ** 2 + ((y - (E + s.nose.tipY)) / 0.012) ** 2;
      this.mix(C.flush, p.rosy * Math.exp(-cx * cx - cy * cy) + 0.5 * Math.exp(-nose) * Math.max(p.rosy, 0.35));
      // Shiny where the skin is tight: the nose and the middle of the forehead.
      rough -= 0.1 * Math.exp(-nose) + 0.07 * Math.exp(-((ax / 0.03) ** 2) - ((y - E - 0.04) / 0.025) ** 2);
    }
    // Under the jaw and down the neck the skin is in the jaw's shadow.
    if (y < E + s.jaw[1] + 0.01) {
      const throat = smoothstep(E + s.jaw[1], E + s.chin.y - 0.008, y) * smoothstep(E + s.chin.y - 0.075, E + s.chin.y - 0.02, y);
      const underJaw = smoothstep(E + s.jaw[1] + 0.01, E + s.jaw[1] - 0.012, y);
      this.darken(underJaw * (0.12 * smoothstep(0.2, -0.6, ny) + 0.2 * throat));
    }

    if (front && z > Z - 0.04) this.creases(x, ax, y);
    if (p.age) {
      // Faint, irregular freckles on the temples and scalp; avoid a uniform spotted overlay.
      const spots = smoothstep(0.73, 0.88, N(x * 590, y * 590, z * 590, 109));
      const region = Math.max(smoothstep(0.037, 0.072, ax), smoothstep(E + 0.05, E + 0.11, y));
      this.mix(C.shade, p.age * spots * region * 0.19);
    }

    // Facial hair: a painted beard (with volume from the field) or stubble.
    const bc = beardCover(this.s, x, y, z);
    if (bc > 0.001) {
      const k = this.facialHair(x, y, z, ny, bc);
      this.mix(tmp, k);
      rough = lerp(rough, 0.82, k);
    }

    if (front && z > Z - 0.03) {
      const brow = this.brow(ax, y);
      if (brow > 0) {
        this.mix(tmp, brow);
        rough = lerp(rough, 0.75, brow);
      }
      const eye = this.eye(ax, y);
      if (eye > 0) {
        this.mix(tmp, eye);
        rough = lerp(rough, tmp[3], eye);
      }
      this.nostrils(ax, y, z, ny);
      const lip = this.lips(x, ax, y, side);
      if (lip > 0) {
        this.mix(tmp, lip);
        rough = lerp(rough, p.lipRoughness ?? 0.38, lip);
        // A moustache hangs over the top of the upper lip (above the gap, when the lips are parted).
        if (this.s.beard.depth > 0 && bc > 0.001) {
          const top = E + s.mouth.y + (s.mouth.open ?? 0) / 2;
          const over = smoothstep(top + 0.0015, top + s.mouth.upper, y) * smoothstep(s.mouth.halfW, s.mouth.halfW * 0.4, ax);
          if (over > 0) {
            this.facialHair(x, y, z, ny, 1);
            this.mix(tmp, over * 0.85);
          }
        }
      }
    }

    // Scalp: painted hair under the shell, and the soft hairline the shell grows from.
    const th = azimuthOf(x, z);
    const sc = scalpCover(this.s, th, y);
    if (sc > 0.001) {
      const hk = this.scalp(x, y, z, th, sc);
      this.mix(tmp, hk);
      rough = lerp(rough, this.s.hair.rough, hk);
    }

    out[0] = clamp01(this.r);
    out[1] = clamp01(this.g);
    out[2] = clamp01(this.b);
    out[3] = clamp01(rough);
  }

  /** Sockets, the folds beside the mouth, the shadow under the nose and lip; forehead lines and crow's feet. */
  private creases(x: number, ax: number, y: number) {
    const s = this.s.shape;
    const p = this.s.paint;
    const C = this.c;
    const E = s.eyeY;
    const ex = (ax - s.eyeX) / 0.02;
    const eyU = (y - E - 0.007) / 0.008;
    const eyD = (y - E + 0.011) / 0.006;
    this.mix(C.shade, 0.32 * Math.exp(-(((ax - s.eyeX + 0.016) / 0.007) ** 2) - ((y - E - 0.002) / 0.008) ** 2));
    this.mix(C.shade, 0.18 * Math.exp(-ex * ex - eyU * eyU));
    this.mix(C.shade, 0.16 * Math.exp(-(((ax - s.eyeX + 0.002) / 0.014) ** 2) - eyD * eyD));
    if (p.age) {
      const u = (ax - s.eyeX) / (s.eyeW * 1.4);
      const span = Math.exp(-u * u * 1.8);
      const arc = E - 0.014 - 0.003 * (1 - u * u);
      const fold = Math.exp(-(((y - arc) / 0.0012) ** 2));
      const bag = Math.exp(-(((y - arc - 0.003) / 0.003) ** 2));
      this.mix(C.shade, p.age * span * (0.23 * fold + 0.08 * bag));
    }
    const ny0 = E + s.nose.baseY;
    this.darken(0.12 * Math.exp(-((ax / 0.014) ** 2) - ((y - ny0 + 0.002) / 0.004) ** 2));
    this.darken(0.12 * Math.exp(-((ax / 0.016) ** 2) - ((y - (E + s.mouth.y - s.mouth.lower - 0.006)) / 0.004) ** 2));
    // The sides of the nose turn away from the light; the bridge and the tip catch it.
    if (y < E + 0.006 && y > ny0 - 0.002) {
      const t = clamp01((E + 0.006 - y) / (E + 0.006 - ny0));
      const w = lerp(0.0065, s.nose.halfW * 0.92, t * t);
      const fade = smoothstep(E + 0.006, E - 0.006, y);
      this.mix(C.shade, 0.22 * fade * smoothstep(w * 0.35, w * 0.95, ax) * smoothstep(w + 0.007, w, ax));
    }
    if (p.folds > 0) {
      // From beside the nose wing down and out past the corner of the mouth.
      segDist(ax, y, s.nose.halfW + 0.004, ny0 + 0.006, s.mouth.halfW + 0.009, E + s.mouth.y - 0.008, this.seg);
      const t = this.seg[1];
      this.mix(C.shade, p.folds * Math.exp(-((this.seg[0] / 0.0022) ** 2)) * smoothstep(0, 0.2, t) * smoothstep(1, 0.75, t));
    }
    if (p.forehead > 0) {
      // Soft lines across the forehead, broken up so they read as skin folding rather than drawn lines.
      const fy = (y - E - 0.03) / 0.032;
      if (fy > 0 && fy < 1 && ax < 0.05) {
        const lines = Math.sin((y - E) * 650 + Math.sin(x * 70) * 1.2);
        const broken = smoothstep(0.25, 0.65, vn2(x * 160, y * 40, 11));
        this.darken(p.forehead * 0.12 * smoothstep(0.55, 0.95, lines) * Math.sin(fy * Math.PI) * smoothstep(0.05, 0.022, ax) * broken);
      }
    }
    if (s.eyeSmile > 0) {
      // A smile bunches the cheek up under the eye: lit on the bulge, a soft fold under it.
      const dx = (ax - s.eyeX) / (s.eyeW * 1.1);
      if (Math.abs(dx) < 1.2) {
        const arc = E - s.eyeOpen * 0.3 - 0.0045 - 0.0025 * (1 - dx * dx);
        const fold = Math.exp(-(((y - arc) / 0.0011) ** 2)) * smoothstep(1.2, 0.5, Math.abs(dx));
        this.mix(C.shade, 0.3 * fold * clamp01(s.eyeSmile / 0.0015));
      }
    }
    if (p.crows > 0) {
      const ox = ax - (s.eyeX + s.eyeW + 0.002);
      if (ox > 0 && ox < 0.016 && Math.abs(y - E) < 0.012) {
        const ang = Math.atan2(y - E, ox);
        this.darken(p.crows * 0.07 * smoothstep(0.55, 0.95, Math.sin(ang * 9)) * smoothstep(0.014, 0.004, ox) * smoothstep(0, 0.003, ox));
      }
    }
  }

  /** Beard or stubble: colour in tmp, coverage returned. */
  private facialHair(x: number, y: number, z: number, ny: number, cover: number): number {
    const s = this.s.shape;
    const h = this.s.beard;
    const C = this.c;
    const tmp = this.tmp;
    const E = s.eyeY;
    // Density by area: thickest at the chin and the moustache, then the jaw, thinnest on the cheek.
    const chinK = Math.exp(-((x / 0.03) ** 2) - ((y - (E + s.chin.y + 0.02)) / 0.03) ** 2);
    const mous = Math.exp(-((x / 0.024) ** 2) - ((y - (E + s.mouth.y + 0.01)) / 0.008) ** 2);
    const jawK = smoothstep(E + s.mouth.y + 0.01, E + s.jaw[1], y);
    let dens = Math.max(lerp(h.cheek, h.jaw, jawK), h.chin * Math.max(chinK, mous)) * cover;
    if (ny < -0.3) dens *= lerp(1, h.jaw, smoothstep(-0.3, -0.8, ny));
    if (h.depth > 0) {
      // A full, short beard: a fine mottle of hairs falling down and out, lighter where they catch the light.
      const strand = N(x * 1900, y * 700, z * 1900, 21);
      const fine = N(x * 4200, y * 2600, z * 4200, 24);
      const clump = N(x * 340, y * 220, z * 340, 22);
      const k = 0.8 + 0.22 * (strand - 0.5) + 0.14 * (fine - 0.5);
      let tipK = smoothstep(0.3, 0.9, strand * 0.45 + clump * 0.65);
      if (h.salt) {
        const share = lerp(h.salt[0], h.salt[1], smoothstep(0.005, 0.035, Math.abs(x)) * (1 - mous));
        const hair = N(x * 950, y * 260, z * 950, 25) * 0.6 + N(x * 2400, y * 700, z * 2400, 26) * 0.2 + clump * 0.2;
        tipK = smoothstep(0.42 + share * 0.4, 0.08 + share * 0.4, hair);
      }
      tmp[0] = lerp(C.beard[0], C.beardTip[0], tipK) * k;
      tmp[1] = lerp(C.beard[1], C.beardTip[1], tipK) * k;
      tmp[2] = lerp(C.beard[2], C.beardTip[2], tipK) * k;
      // Thick where it is dense; toward its edges single hairs with skin between them.
      const sparse = smoothstep(0.75, 0.15, dens);
      return clamp01(smoothstep(0, 0.45, dens) * (1 - sparse * smoothstep(0.35, 0.75, 1 - fine * 0.6 - strand * 0.4)));
    }
    // Stubble: the cool shadow of hair under the skin, and the hairs themselves as fine dark points, some of them grey.
    const dot = N(x * 2300, y * 2300, z * 2300, 31) * 0.65 + N(x * 4100, y * 4100, z * 4100, 33) * 0.35;
    const grey = N(x * 1500, y * 1500, z * 1500, 32) < h.grey;
    const hair = 0.85 * smoothstep(0.6 - dens * 0.3, 0.72 - dens * 0.24, dot);
    const col = grey ? C.beardTip : C.beard;
    const sh = 1 - 0.32 * dens;
    tmp[0] = lerp(C.skin[0] * sh * 0.95, col[0], hair);
    tmp[1] = lerp(C.skin[1] * sh * 0.95, col[1], hair);
    tmp[2] = lerp(C.skin[2] * sh * 1.02, col[2], hair);
    return clamp01(dens * 1.15);
  }

  /** Brow: colour in tmp, coverage returned. */
  private brow(ax: number, y: number): number {
    const s = this.s.shape;
    const p = this.s.paint.brow;
    const E = s.eyeY;
    const [hx, hy] = p.head;
    const [px, py] = p.peak;
    const [tx, ty] = p.tail;
    if (ax < hx - 0.006 || ax > tx + 0.006 || y < E + Math.min(hy, ty) - 0.008 || y > E + py + 0.01) return 0;
    // Distance to the brow's spine, head to peak to tail.
    segDist(ax, y, hx, E + hy, px, E + py, this.seg);
    let d = this.seg[0];
    let t = this.seg[1] * 0.45;
    let w = lerp(p.thick[0], p.thick[1], this.seg[1]);
    let dirx = px - hx;
    let diry = py - hy;
    segDist(ax, y, px, E + py, tx, E + ty, this.seg);
    if (this.seg[0] < d) {
      d = this.seg[0];
      t = 0.45 + this.seg[1] * 0.55;
      w = lerp(p.thick[1], p.thick[2], this.seg[1]);
      dirx = tx - px;
      diry = ty - py;
    }
    // The hairs grow up at the head of the brow and along it after that.
    const l = Math.hypot(dirx, diry) || 1;
    dirx /= l;
    diry /= l;
    const up = smoothstep(0.18, 0, t);
    const ux = lerp(dirx, 0.25, up);
    const uy = lerp(diry, 1, up);
    const along = ax * ux + y * uy;
    const across = ax * uy - y * ux;
    const strand = vn2(along * 520, across * 2400, 41);
    const half = w * 0.5;
    const body = smoothstep(half * 1.08, half * 0.55, d);
    const ends = smoothstep(0, 0.12, t) * smoothstep(1.02, 0.85, t);
    const c = this.c.brow;
    const shade = 0.75 + 0.5 * strand;
    this.tmp[0] = c[0] * shade;
    this.tmp[1] = c[1] * shade;
    this.tmp[2] = c[2] * shade;
    return clamp01(body * ends * (0.62 + 0.55 * strand));
  }

  /** Eye: white, iris, pupil, lash line, lid crease. Colour and roughness in tmp, coverage returned. */
  private eye(ax: number, y: number): number {
    const s = this.s.shape;
    const p = this.s.paint;
    const C = this.c;
    const tmp = this.tmp;
    const E = s.eyeY;
    const ex = ax - s.eyeX;
    if (Math.abs(ex) > s.eyeW + 0.006 || Math.abs(y - E) > s.eyeOpen + 0.008) return 0;
    // Across the opening from the inner corner (u 0) to the outer (u 1); the line between the corners tilts up outward.
    const u = (ex + s.eyeW) / (2 * s.eyeW);
    const base = E + (u - 0.5) * s.eyeTilt;
    // Upper lid peaks a little inward of the middle, the lower lid's lowest point a little outward; a smile lifts the
    // lower lid most toward the outer corner.
    const cu = clamp01(u);
    const yu = base + s.eyeOpen * 0.68 * Math.pow(Math.sin(Math.PI * cu ** 0.85), 0.85);
    const lower = s.eyeOpen * 0.32 * Math.pow(Math.sin(Math.PI * cu ** 1.15), 0.9);
    const yl = base - Math.max(lower * 0.2, lower - s.eyeSmile * Math.sin(Math.PI * cu ** 0.75));
    if (!(u > 0 && u < 1 && y < yu && y > yl)) {
      // Round the opening: the lash lines, the lid above them in its own shadow, the crease above that.
      if (u < -0.02 || u > 1.06) return 0;
      const along = smoothstep(-0.02, 0.06, u) * smoothstep(1.06, 0.97, u);
      const dyu = y - yu;
      // The upper lashes: a solid dark line, heavier toward the outer corner.
      const lashW = 0.0011 + 0.0005 * smoothstep(0.4, 0.9, u);
      let k = 0;
      if (dyu > -0.0003 && dyu < lashW + 0.0008) k = p.lash * along * smoothstep(lashW + 0.0008, lashW * 0.5, dyu);
      const dyl = yl - y;
      if (dyl > -0.0003 && dyl < 0.0012 && u > 0.06) {
        // The lower lid: a pale wet rim, then a faint lash line under it.
        const rim = Math.exp(-(((dyl - 0.0003) / 0.00035) ** 2));
        const lash = 0.35 * p.lash * smoothstep(0.0012, 0.0006, dyl) * smoothstep(0.0003, 0.0006, dyl);
        if (lash > rim * 0.3) k = Math.max(k, lash * along);
        else if (k <= 0) {
          tmp[0] = lerp(C.skin[0], C.flush[0], 0.6);
          tmp[1] = lerp(C.skin[1], C.flush[1], 0.6) * 0.92;
          tmp[2] = lerp(C.skin[2], C.flush[2], 0.6) * 0.92;
          tmp[3] = 0.45;
          return rim * 0.25 * along;
        }
      }
      if (k > 0) {
        tmp[0] = 0.07;
        tmp[1] = 0.05;
        tmp[2] = 0.045;
        tmp[3] = 0.6;
        return k;
      }
      tmp[0] = C.shade[0];
      tmp[1] = C.shade[1];
      tmp[2] = C.shade[2];
      tmp[3] = 0.55;
      if (dyu > 0) {
        // The lid above the lashes in its own shadow, and the fold where it tucks under the brow.
        const lid = 0.35 * along * smoothstep(0.004, 0, dyu);
        if (p.crease > 0) {
          const dc = Math.abs(dyu - p.crease);
          const span = Math.sin(Math.PI * clamp01(u * 1.15 - 0.08));
          return Math.max(lid, 0.6 * Math.exp(-((dc / 0.0011) ** 2)) * span, 0.3 * smoothstep(p.crease + 0.002, p.crease, dyu) * span);
        }
        return lid;
      }
      return 0;
    }
    // The white: never brighter than the skin round it, shadowed under the upper lid, darker toward the corners, and the
    // narrower the eye the less light gets in at all.
    const depth = clamp01((yu - y) / (yu - yl));
    const corner = Math.min(u, 1 - u);
    const shadow = 0.7 * smoothstep(0.6, 0, depth) + 0.35 * smoothstep(0.22, 0, corner);
    const lit = 0.35 + 0.65 * smoothstep(0.004, 0.009, s.eyeOpen - s.eyeSmile);
    let r = 0.52 * lit * (1 - shadow * 0.6);
    let g = 0.47 * lit * (1 - shadow * 0.66);
    let bl = 0.43 * lit * (1 - shadow * 0.64);
    if (u < 0.12) {
      // The pink caruncle in the inner corner.
      const t = smoothstep(0.12, 0.02, u);
      r = lerp(r, 0.72, t);
      g = lerp(g, 0.45, t);
      bl = lerp(bl, 0.42, t);
    }
    // Iris and pupil, looking straight ahead.
    const iy = y - (E + s.irisY);
    const id = Math.hypot(ex, iy);
    if (id < s.irisR + 0.0003) {
      // Fibres radiating from the pupil, a dark ring at the rim, a lighter collar round the pupil.
      const ang = Math.atan2(iy, ex);
      const fib = N(Math.cos(ang) * 11, Math.sin(ang) * 11, id * 700, 51);
      const ring = smoothstep(s.irisR * 0.72, s.irisR, id);
      const inner = smoothstep(s.irisR * 0.62, s.irisR * 0.38, id);
      const lum = (0.7 + 0.6 * fib) * (1 - 0.55 * ring) * (1 + 0.45 * inner);
      const edge = smoothstep(s.irisR + 0.0003, s.irisR - 0.0002, id);
      r = lerp(r, C.iris[0] * lum, edge);
      g = lerp(g, C.iris[1] * lum, edge);
      bl = lerp(bl, C.iris[2] * lum, edge);
      const pupil = smoothstep(s.irisR * 0.4, s.irisR * 0.32, id);
      r = lerp(r, 0.025, pupil);
      g = lerp(g, 0.02, pupil);
      bl = lerp(bl, 0.022, pupil);
      // The lid's shadow falls on the top of the iris too.
      const sh = 0.5 * smoothstep(0.45, 0, depth);
      r *= 1 - sh;
      g *= 1 - sh;
      bl *= 1 - sh;
    }
    tmp[0] = r;
    tmp[1] = g;
    tmp[2] = bl;
    // Not glossy: a dark eye only a few pixels across, sheened over by the whole sky, reads as a blank grey stare.
    tmp[3] = 0.62;
    // Soft edge where the lids close over the eye.
    return smoothstep(0, 0.0004, Math.min(yu - y, y - yl, u * 2 * s.eyeW, (1 - u) * 2 * s.eyeW));
  }

  /** Nostrils, on the underside of the nose where only a view from below finds them, and the crease round each wing. */
  private nostrils(ax: number, y: number, z: number, ny: number) {
    const s = this.s.shape;
    const ny0 = s.eyeY + s.nose.baseY;
    if (y > ny0 + 0.012 || y < ny0 - 0.006 || ax > s.nose.halfW + 0.004) return;
    const tz = s.eyeZ + s.nose.tipZ;
    const nd = ((ax - 0.0068) / 0.0042) ** 2 + ((y - ny0 - 0.0026) / 0.0026) ** 2 + ((z - (tz - 0.0185)) / 0.0062) ** 2;
    this.darken(0.5 * smoothstep(2.4, 0.4, nd) * smoothstep(0.1, -0.4, ny));
    const wing = Math.hypot((ax - (s.nose.halfW - 0.009)) / 0.0098, (y - ny0 - 0.0064) / 0.0088);
    this.darken(0.34 * Math.exp(-(((wing - 1) / 0.14) ** 2)) * smoothstep(ny0 + 0.014, ny0 + 0.004, y) * smoothstep(0.004, 0.009, ax));
  }

  /** The red of the lips and the line between them: colour in tmp, coverage returned. */
  private lips(x: number, ax: number, y: number, side: number): number {
    const s = this.s.shape;
    const m = s.mouth;
    const E = s.eyeY;
    const t = ax / m.halfW;
    const opening = m.open ?? 0;
    if (t > 1.15 || y > E + m.y + m.upper + opening / 2 + 0.004 + m.lift[side] || y < E + m.y - m.lower - opening / 2 - 0.004) return 0;
    const yl = E + m.y + m.lift[side] * Math.pow(Math.min(t, 1.2), 2.2);
    // Upper lip: a cupid's bow in the middle; lower lip: fuller, rounder.
    const bow = 1 - 0.22 * Math.exp(-((x / 0.0032) ** 2)) + 0.12 * Math.exp(-(((ax - 0.0065) / 0.003) ** 2));
    const hu = m.upper * Math.sqrt(clamp01(1 - t * t)) * bow;
    const hl = m.lower * Math.pow(clamp01(1 - (t / 0.97) ** 2), 0.6);
    const gap = opening / 2 * Math.sqrt(clamp01(1 - t * t));
    const centreDy = y - yl;
    if (gap > 0 && Math.abs(centreDy) < gap) {
      this.tmp[0] = 0.13;
      this.tmp[1] = 0.055;
      this.tmp[2] = 0.045;
      const v = (gap - centreDy) / (2 * gap);
      // A mouth open wide: the tongue fills the bottom of it, darker toward the throat.
      if (opening > 0.016) {
        const tongue = smoothstep(0.55, 0.8, v) * smoothstep(1.05, 0.6, t);
        this.tmp[0] = lerp(this.tmp[0], 0.5, tongue * 0.85);
        this.tmp[1] = lerp(this.tmp[1], 0.2, tongue * 0.85);
        this.tmp[2] = lerp(this.tmp[2], 0.2, tongue * 0.85);
      }
      if (m.teeth !== undefined) this.teeth(ax, t, v, opening);
      if (m.teeth !== undefined && m.lowerTeeth) this.teeth(ax, t, 1 - v, opening, 0.0075, 0.85);
      return smoothstep(0, 0.0005, gap - Math.abs(centreDy));
    }
    const dy = centreDy - Math.sign(centreDy) * gap;
    const C = this.c;
    let k = dy >= 0 ? smoothstep(0, 0.0005, hu - dy) : smoothstep(0, 0.0005, hl + dy);
    // Darker toward the line where the lips meet, lit along the middle of the lower lip.
    const nearLine = Math.exp(-((dy / (dy > 0 ? m.upper * 0.45 : m.lower * 0.4)) ** 2));
    const shine = dy < 0 ? Math.exp(-(((dy + hl * 0.5) / (hl * 0.35 + 1e-4)) ** 2)) : 0;
    const lines = 0.94 + 0.06 * vn2(x * 3000, y * 200, 61);
    let r = C.lip[0] * (1 - 0.25 * nearLine + 0.08 * shine) * lines;
    let g = C.lip[1] * (1 - 0.28 * nearLine + 0.08 * shine) * lines;
    let b = C.lip[2] * (1 - 0.25 * nearLine + 0.08 * shine) * lines;
    // The line itself, deepest in the corners.
    const lineK = Math.exp(-((dy / 0.00055) ** 2)) * smoothstep(1.12, 0.95, t);
    const cornerK = Math.exp(-(((t - 1) / 0.06) ** 2)) * Math.exp(-((dy / 0.0016) ** 2));
    const dark = Math.max(lineK * 0.85, cornerK * 0.7);
    r = lerp(r, 0.18, dark);
    g = lerp(g, 0.08, dark);
    b = lerp(b, 0.07, dark);
    k = Math.max(k, dark);
    this.tmp[0] = r;
    this.tmp[1] = g;
    this.tmp[2] = b;
    return k;
  }

  /**
   * Upper teeth in a grin, over the dark of the mouth already in tmp: `t` across the mouth (0 middle, 1 corner) and `v` down
   * the gap (0 under the upper lip, 1 on the lower). The teeth fill the top three quarters, a little shadow under the lip,
   * a grey line between each, and the side teeth sink into the dark toward the corners.
   */
  private teeth(ax: number, t: number, v: number, opening: number, long = 0.0105, light = 1) {
    const T = this.c.teeth;
    // The upper teeth are about a centimetre long: in a grin they fill most of the gap, in a wide-open mouth only its top.
    // Called again with `v` flipped for the lower teeth, which are shorter, narrower and in the shadow of the upper lip.
    const edge = Math.min(0.74, long / opening) + 0.05 * Math.cos(ax * 420) * Math.min(1, long / opening);
    const k = smoothstep(edge + 0.03, edge - 0.04, v) * smoothstep(1.02, 0.7, t);
    if (k <= 0) return;
    // Centrals 8.5 mm, laterals 6.5, canines 7, then the premolars, narrower as the arch turns away.
    let gapK = 0;
    for (const at of [0, 0.0085, 0.015, 0.022, 0.0275]) gapK = Math.max(gapK, Math.exp(-(((ax - at) / 0.0006) ** 2)));
    const shade = (1 - 0.32 * smoothstep(0.25, 0.95, t)) * (1 - 0.3 * smoothstep(0.22, 0, v)) * (1 - 0.35 * gapK);
    // The biting edge is a touch translucent.
    const tip = 1 - 0.12 * smoothstep(edge - 0.18, edge, v);
    const f = shade * tip * light;
    this.tmp[0] = lerp(this.tmp[0], T[0] * f, k);
    this.tmp[1] = lerp(this.tmp[1], T[1] * f, k);
    this.tmp[2] = lerp(this.tmp[2], T[2] * f, k);
  }

  /** Hair painted on the scalp, strands running along its sweep: colour in tmp, coverage returned. */
  private scalp(x: number, y: number, z: number, th: number, cover: number): number {
    const h = this.s.hair;
    const C = this.c;
    // Strands run over the head from the hairline toward the crown: along the elevation of the ray, across the azimuth,
    // a couple of millimetres across (finer would only alias) and as long as the style.
    const ph = Math.atan2(y - rayY(this.s.shape), Math.hypot(x, z - RAY_Z));
    const along = ph * 14 * h.strand;
    const across = (th + h.sweep * clamp01(ph)) * 42;
    let strand = vn2(across, along, 81) * 0.6 + vn2(across * 2.7, along * 2.2, 82) * 0.4;
    if (h.curl) {
      // Coils: little rings a few millimetres across, each lit on its top and dark in its middle.
      const c = vn2(th * 45, ph * 45, 84) * 0.65 + vn2(th * 95, ph * 95, 85) * 0.35;
      const ring = Math.abs(Math.sin(c * 7));
      strand = lerp(strand, ring * 0.85 + 0.1, 0.75);
    }
    const tipK = 0.6 * smoothstep(0.6, 0.95, strand);
    const k = 0.84 + 0.22 * (strand - 0.5);
    this.tmp[0] = lerp(C.hair[0], C.hairTip[0], tipK) * k;
    this.tmp[1] = lerp(C.hair[1], C.hairTip[1], tipK) * k;
    this.tmp[2] = lerp(C.hair[2], C.hairTip[2], tipK) * k;
    if (cover >= 1) return 1;
    // At the hairline single hairs thin out into skin.
    const fine = vn2(th * 900, y * 1400, 83);
    return clamp01(cover * 1.4 - (1 - cover) * fine * 0.8);
  }
}

/**
 * Paint a w x h texture for a head: each texel finds the surface point under it on the grid (bilinear between the four
 * grid points round it) and is painted from there. RGBA, sRGB colour and roughness in alpha.
 */
export function paintTexels(spec: PortraitSpec, pos: Float32Array, nor: Float32Array, w: number, h: number): Uint8Array {
  const data = new Uint8Array(w * h * 4);
  const painter = new FacePainter(spec);
  const out = new Float32Array(4);
  const W = GRID_U + 1;
  for (let ty = 0; ty < h; ty++) {
    const fv = ((ty + 0.5) / h) * GRID_V;
    const j = Math.min(GRID_V - 1, Math.floor(fv));
    const tv = fv - j;
    for (let tx = 0; tx < w; tx++) {
      const fu = ((tx + 0.5) / w) * GRID_U;
      const i = Math.min(GRID_U - 1, Math.floor(fu));
      const tu = fu - i;
      const k00 = (j * W + i) * 3;
      const k10 = k00 + 3;
      const k01 = k00 + W * 3;
      const k11 = k01 + 3;
      const w00 = (1 - tu) * (1 - tv);
      const w10 = tu * (1 - tv);
      const w01 = (1 - tu) * tv;
      const w11 = tu * tv;
      const x = pos[k00] * w00 + pos[k10] * w10 + pos[k01] * w01 + pos[k11] * w11;
      const y = pos[k00 + 1] * w00 + pos[k10 + 1] * w10 + pos[k01 + 1] * w01 + pos[k11 + 1] * w11;
      const z = pos[k00 + 2] * w00 + pos[k10 + 2] * w10 + pos[k01 + 2] * w01 + pos[k11 + 2] * w11;
      const nx = nor[k00] * w00 + nor[k10] * w10 + nor[k01] * w01 + nor[k11] * w11;
      const ny = nor[k00 + 1] * w00 + nor[k10 + 1] * w10 + nor[k01 + 1] * w01 + nor[k11 + 1] * w11;
      const nz = nor[k00 + 2] * w00 + nor[k10 + 2] * w10 + nor[k01 + 2] * w01 + nor[k11 + 2] * w11;
      const nl = Math.hypot(nx, ny, nz) || 1;
      painter.paint(x, y, z, ny / nl, nz / nl, out);
      const o = (ty * w + tx) * 4;
      data[o] = out[0] * 255 + 0.5;
      data[o + 1] = out[1] * 255 + 0.5;
      data[o + 2] = out[2] * 255 + 0.5;
      data[o + 3] = out[3] * 255 + 0.5;
    }
  }
  return data;
}
