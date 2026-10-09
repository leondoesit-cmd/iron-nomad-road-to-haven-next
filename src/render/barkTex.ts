import * as THREE from 'three';
import { shared } from './dispose';
import { perlin, perm } from './proctex';

/**
 * Tree bark, painted on the CPU: one tileable layer per kind of bark in an array texture the 3D trees read with UVs in
 * metres (`TreeKit.tube`), so no trunk, limb or twig stretches its bark. RGB is the bark's own shading and relative colour
 * (each species' vertex colour gives its cast, `barkTint` each tree's), A its relief (0..1, for the bump and for blending a
 * rough layer over a smooth one: the rough layer's thickest flakes outlast the thin edges).
 *
 * A eucalyptus pairs its smooth shedding bark with a rough layer painted in the same palette, and the tree fades from one to
 * the other up its stem flake by flake (`BARK_ROUGH`), so the foot and the stem are one bark, not two textures.
 */

export const BARK = { furrow: 0, plate: 1, interlace: 2, smooth: 3, palm: 4, fibre: 5, silver: 6, gum: 7, gum2: 8, gumRough: 9 } as const;
export type BarkLayer = (typeof BARK)[keyof typeof BARK];
const LAYERS = 10;
/** Each layer's tile, metres square. A rough layer's tile divides its smooth partner's (`BARK_ROUGH`). */
export const BARK_TILE: readonly number[] = [0.7, 0.9, 0.8, 0.7, 0.9, 0.6, 0.8, 1.6, 1.6, 0.8 / 1.5];
/** Relief of each layer, metres from the deepest furrow to the highest ridge (the bump's strength). */
export const BARK_DEPTH: readonly number[] = [0.03, 0.025, 0.035, 0.003, 0.04, 0.014, 0.01, 0.003, 0.003, 0.012];
/** The rough layer each smooth one fades into near the foot, and how many of its tiles fit across one of the smooth tile. */
export const BARK_ROUGH: Partial<Record<number, { layer: number; scale: number }>> = {
  [BARK.gum]: { layer: BARK.gumRough, scale: 3 },
  [BARK.gum2]: { layer: BARK.gumRough, scale: 3 },
  [BARK.smooth]: { layer: BARK.furrow, scale: 1 },
};

/** Texels across a layer. */
export const BARK_SIZE = 512;
const S = BARK_SIZE;

const sat = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, v: number) => {
  const t = sat((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
/** A stable random number in [0, 1) for integers. */
function hash(a: number, b = 0, c = 0): number {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

type N2 = (x: number, y: number) => number;

/**
 * Tileable fractal noise over the unit tile, about [-1, 1] (mostly within +-0.5): `px` x `py` lattice cells across it on
 * the first octave (integers, so it wraps). More cells one way than the other stretch its features the other way.
 */
function fractal(seed: number, px: number, py: number, octaves = 4, gain = 0.5): N2 {
  const ps = Array.from({ length: octaves }, (_, k) => perm(seed * 131 + k * 977));
  let total = 0;
  for (let k = 0, a = 1; k < octaves; k++, a *= gain) total += a;
  return (x, y) => {
    let s = 0;
    let a = 1;
    let f = 1;
    for (let k = 0; k < octaves; k++) {
      const qx = Math.min(256, px * f);
      const qy = Math.min(256, py * f);
      s += perlin(x * qx, y * qy, qx, qy, ps[k]) * a;
      a *= gain;
      f *= 2;
    }
    return (s / total) * 1.45;
  };
}

interface Cell {
  /** Distance from the nearest point's border with the next nearest, in tiles. */
  edge: number;
  /** The nearest point's random number and its lattice cell. */
  id: number;
  cx: number;
  cy: number;
  /** Offset from the nearest point, in tiles. */
  dx: number;
  dy: number;
  /** Unit direction from the nearest point toward the next nearest (across the border between them). */
  nx: number;
  ny: number;
}

/** Tileable Voronoi over `nx` x `ny` cells of the unit tile (stretched cells where they differ), distances in tiles. */
function cells(seed: number, nx: number, ny: number, jitter = 0.85) {
  const px = new Float32Array(nx * ny);
  const py = new Float32Array(nx * ny);
  const pid = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      px[k] = 0.5 + (hash(i, j, seed) - 0.5) * jitter;
      py[k] = 0.5 + (hash(i, j, seed + 1) - 0.5) * jitter;
      pid[k] = hash(i, j, seed + 2);
    }
  }
  const out: Cell = { edge: 0, id: 0, cx: 0, cy: 0, dx: 0, dy: 0, nx: 0, ny: 0 };
  return (x: number, y: number): Cell => {
    const ix = Math.floor(x * nx);
    const iy = Math.floor(y * ny);
    let d1 = 1e9;
    let d2 = 1e9;
    let ax = 0;
    let ay = 0;
    let bx = 0;
    let by = 0;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const cx = ix + ox;
        const cy = iy + oy;
        const wx = ((cx % nx) + nx) % nx;
        const wy = ((cy % ny) + ny) % ny;
        const k = wy * nx + wx;
        const qx = (cx + px[k]) / nx;
        const qy = (cy + py[k]) / ny;
        const d = (qx - x) ** 2 + (qy - y) ** 2;
        if (d < d1) {
          d2 = d1;
          bx = ax;
          by = ay;
          d1 = d;
          ax = qx;
          ay = qy;
          out.id = pid[k];
          out.cx = wx;
          out.cy = wy;
        } else if (d < d2) {
          d2 = d;
          bx = qx;
          by = qy;
        }
      }
    }
    const l = Math.hypot(bx - ax, by - ay) || 1;
    out.edge = Math.abs(((x - (ax + bx) / 2) * (bx - ax) + (y - (ay + by) / 2) * (by - ay)) / l);
    out.dx = x - ax;
    out.dy = y - ay;
    out.nx = (bx - ax) / l;
    out.ny = (by - ay) / l;
    return out;
  };
}

/** One texel: sRGB colour 0..1 into o[0..2], relief 0..1 into o[3]. `v` runs up the stem. */
type Paint = (u: number, v: number, o: Float32Array) => void;
interface Painter {
  paint: Paint;
  /** Marks laid over the painted tile afterwards (scars, lenticels): RGBA floats, row-major, wrapping. */
  post?: (img: Float32Array) => void;
}

/**
 * An elliptical mark centred at (`cx`, `cy`) (tiles), `rx` x `ry` tiles, wrapping: `fn` gets each covered texel's index into
 * `img` (times 4) and its squared ellipse distance (1 on the rim).
 */
function splat(cx: number, cy: number, rx: number, ry: number, fn: (j: number, q: number, dx: number, dy: number) => void) {
  const x0 = Math.floor((cx - rx * 1.3) * S);
  const x1 = Math.ceil((cx + rx * 1.3) * S);
  const y0 = Math.floor((cy - ry * 1.3) * S);
  const y1 = Math.ceil((cy + ry * 1.3) * S);
  for (let y = y0; y <= y1; y++) {
    const dy = ((y + 0.5) / S - cy) / ry;
    for (let x = x0; x <= x1; x++) {
      const dx = ((x + 0.5) / S - cx) / rx;
      const q = dx * dx + dy * dy;
      if (q < 1.7) fn(((((y % S) + S) % S) * S + (((x % S) + S) % S)) * 4, q, dx, dy);
    }
  }
}

/**
 * Fissured bark: furrows where a vertically stretched noise crosses zero, so they wander, split and join as real ones do,
 * shallower minor fissures between them and short cracks across the ridges here and there. Shading follows the relief:
 * ridge tops weathered grey, the furrows dark and warm. Oak, terebinth and acacia (`furrow`), willow deeper and coarser.
 */
function fissured(seed: number, px: number, py: number, o: { width: number; minor: number; cross: number; lichen: number }): Painter {
  const warp = fractal(seed, 2, 3, 3);
  const main = fractal(seed + 1, px, py, 4);
  const minor = fractal(seed + 2, px * 2, py * 2, 3);
  const across = fractal(seed + 3, 2, px + 2, 3);
  const crossAt = fractal(seed + 4, 3, 4, 2);
  const widthN = fractal(seed + 5, 3, 5, 2);
  const cork = fractal(seed + 6, 26, 34, 3);
  const blot = fractal(seed + 7, 3, 4, 3);
  const lichen = fractal(seed + 8, 9, 9, 3);
  return {
    paint: (u, v, out) => {
      const uw = u + warp(u, v) * 0.035;
      const fw = o.width * (0.75 + 0.5 * (widthN(u, v) * 0.5 + 0.5));
      // A V-shaped furrow either side of the zero line, its floor rounded.
      let h = smooth(0, fw, Math.abs(main(uw, v)));
      h = Math.sqrt(h);
      h *= 1 - (1 - smooth(0, fw * 0.8, Math.abs(minor(uw, v)))) * o.minor;
      h *= 1 - (1 - smooth(0, 0.2, Math.abs(across(uw, v)))) * o.cross * smooth(0.15, 0.4, crossAt(u, v));
      const k = cork(u, v);
      h *= 0.86 + 0.14 * k;
      const l = mix(0.25, 0.78, Math.pow(h, 1.4)) + blot(u, v) * 0.045 + k * 0.04;
      const warm = 1 - smooth(0.1, 0.55, h);
      out[0] = l * (1 + warm * 0.06);
      out[1] = l * (0.96 - warm * 0.03);
      out[2] = l * (0.9 - warm * 0.08);
      const li = smooth(0.38, 0.55, lichen(u, v)) * smooth(0.6, 0.9, h) * o.lichen;
      out[0] = mix(out[0], 0.78, li);
      out[1] = mix(out[1], 0.82, li);
      out[2] = mix(out[2], 0.72, li);
      out[3] = 0.06 + h * 0.88;
    },
  };
}

/** Pine: broad scaly plates parted by wandering dark fissures, their faces flaking in soft terraces, warmer underneath. */
function plate(seed: number): Painter {
  const warp = fractal(seed, 3, 3, 3);
  const jag = fractal(seed + 1, 14, 14, 2);
  const plates = cells(seed + 2, 5, 2, 0.8);
  const widthN = fractal(seed + 3, 4, 4, 2);
  const flake = fractal(seed + 4, 6, 5, 4);
  const grain = fractal(seed + 5, 34, 10, 2);
  const blot = fractal(seed + 6, 3, 3, 3);
  return {
    paint: (u, v, o) => {
      const wu = u + warp(u, v) * 0.05 + jag(u, v) * 0.008;
      const wv = v + warp(v + 0.5, u) * 0.06 + jag(v, u) * 0.008;
      const c = plates(wu, wv);
      const fw = 0.006 + (widthN(u, v) * 0.5 + 0.5) * 0.02;
      const body = smooth(fw * 0.3, fw + 0.012, c.edge);
      // Soft terraces: each step down is a younger, warmer layer of the plate.
      const f = (flake(u + c.id * 0.31, v) * 0.5 + 0.5) * 2.4 + c.id * 0.7;
      const step = Math.floor(f);
      const t = f - step;
      const terrace = (step + smooth(0.75, 1, t)) / 3;
      const young = 1 - (terrace % 1);
      const h = body * (0.5 + 0.35 * (1 - young) + grain(u, v) * 0.03);
      const g = grain(u, v);
      const l = mix(0.3, 0.74 + g * 0.05 + blot(u, v) * 0.05, Math.pow(body, 0.7)) * (1 - 0.08 * smooth(0.8, 1, t) * body);
      o[0] = l * (1 + young * 0.1 * body);
      o[1] = l * (0.94 - young * 0.03 * body);
      o[2] = l * (0.88 - young * 0.09 * body);
      o[3] = 0.06 + h * 0.88;
    },
  };
}

/** Poplar: smooth pale grey-green with horizontal lenticels and a few dark diamond scars where branches fell. */
function smoothBark(seed: number): Painter {
  const mott = fractal(seed, 3, 4, 4);
  const streak = fractal(seed + 1, 30, 3, 2);
  const T = BARK_TILE[BARK.smooth];
  return {
    paint: (u, v, o) => {
      const m = mott(u, v);
      const l = 0.8 + m * 0.06 + streak(u, v) * 0.025;
      o[0] = l * 0.98;
      o[1] = l;
      o[2] = l * 0.95;
      o[3] = 0.45 + m * 0.05;
    },
    post: (img) => {
      for (let i = 0; i < 110; i++) {
        // Lenticels: short dark dashes across the stem, a little raised.
        const rx = (0.004 + hash(i, 3, seed) * 0.012) / T;
        const ry = (0.0012 + hash(i, 4, seed) * 0.0018) / T;
        splat(hash(i, 1, seed), hash(i, 2, seed), rx, ry, (j, q) => {
          const k = smooth(1.6, 0.5, q);
          for (let c = 0; c < 3; c++) img[j + c] *= 1 - 0.3 * k;
          img[j + 3] += 0.06 * k;
        });
      }
      for (let i = 0; i < 3; i++) {
        // Diamond scars, darker toward the middle, the arms trailing down.
        const rx = (0.02 + hash(i, 7, seed) * 0.025) / T;
        const ry = (0.035 + hash(i, 8, seed) * 0.035) / T;
        splat(hash(i, 5, seed), hash(i, 6, seed), rx, ry, (j, _q, dx, dy) => {
          const d = Math.abs(dx) + Math.abs(dy);
          const k = smooth(1.25, 0.5, d);
          for (let c = 0; c < 3; c++) img[j + c] *= 1 - 0.45 * k;
          img[j + 3] -= 0.22 * k;
        });
      }
    },
  };
}

/** Date palm: the trunk clad in the cut bases of old fronds, rows of overlapping scales, each rising to its cut lip. */
function palmBark(seed: number): Painter {
  const ROWS = 6;
  const COLS = 4;
  const warp = fractal(seed, 3, 3, 3);
  const fibre = fractal(seed + 1, 48, 6, 2);
  const weather = fractal(seed + 2, 6, 6, 3);
  const grain = fractal(seed + 3, 40, 12, 2);
  return {
    paint: (u, v, o) => {
      const wu = u + warp(u, v) * 0.02;
      const wv = v + warp(v + 0.3, u) * 0.012;
      let best = -Infinity;
      let rise = 0;
      let across = 0;
      let jid = 0;
      const gy = wv * ROWS;
      const r0 = Math.floor(gy);
      for (let rr = r0 - 1; rr <= r0 + 1; rr++) {
        const row = ((rr % ROWS) + ROWS) % ROWS;
        const gx = wu * COLS - (row % 2) * 0.5;
        const c0 = Math.floor(gx);
        for (let cc = c0 - 1; cc <= c0 + 1; cc++) {
          const col = ((cc % COLS) + COLS) % COLS;
          const j = hash(col, row, seed);
          // Each base is a broad shield from its foot (y 0) to its cut lip (y 1), overlapping the row above by a third.
          const y = (gy - rr) / 1.35 + (j - 0.5) * 0.06;
          const x = (gx - cc - 0.5 - (j - 0.5) * 0.12) * 2;
          if (y < 0 || y > 1) continue;
          const half = mix(0.22, 1.02, smooth(0, 0.62, y)) - 0.12 * smooth(0.82, 1, y);
          const ax = Math.abs(x) / half;
          if (ax >= 1) continue;
          // Each base's cut lip lies over the foot of the one above it.
          const z = -rr - y * 0.01;
          if (z > best) {
            best = z;
            rise = y;
            across = ax;
            jid = hash(col, row, seed + 9);
          }
        }
      }
      const f = fibre(u, v) * 0.5 + 0.5;
      if (best === -Infinity) {
        const l = 0.22 + f * 0.1;
        o[0] = l * 1.06;
        o[1] = l * 0.9;
        o[2] = l * 0.74;
        o[3] = 0.06 + f * 0.06;
        return;
      }
      // Relief rises toward the lip and falls off round the edges; the lip itself is the cut face, pale and grey.
      const edge = smooth(1, 0.72, across);
      const lip = smooth(0.86, 0.97, rise);
      const h = (0.25 + 0.6 * Math.pow(rise, 0.8)) * Math.sqrt(edge);
      const w = weather(u, v);
      let l = (0.62 + w * 0.06 + (jid - 0.5) * 0.12 + grain(u, v) * 0.04) * mix(0.55, 1, edge) * mix(0.8, 1, rise);
      l = mix(l, 0.78 + w * 0.04, lip * edge);
      o[0] = l * (1.03 - lip * 0.04);
      o[1] = l * 0.95;
      o[2] = l * (0.85 + lip * 0.06);
      o[3] = 0.08 + h * 0.86;
    },
  };
}

/** Swamp cypress (and a palm's crown shaft): long fibrous strips running up the stem, shredding, the outer ones greyed. */
function fibreBark(seed: number): Painter {
  const wave = fractal(seed, 3, 2, 3);
  const strand = fractal(seed + 1, 56, 4, 3);
  const strip = fractal(seed + 2, 8, 2, 3);
  const grey = fractal(seed + 3, 4, 3, 3);
  return {
    paint: (u, v, o) => {
      const uw = u + wave(u, v) * 0.035;
      const s = 1 - smooth(0, 0.35, Math.abs(strand(uw, v)));
      const band = smooth(-0.05, 0.2, strip(uw, v));
      const h = band * (0.6 + 0.3 * (1 - s)) + (1 - band) * 0.22 * (1 - s);
      const g = smooth(0.05, 0.45, grey(u, v)) * band;
      const l = mix(0.4, 0.7, smooth(0.1, 0.8, h)) * (1 - s * 0.18);
      o[0] = mix(l * 1.04, l * 0.98, g);
      o[1] = mix(l * 0.94, l * 0.96, g);
      o[2] = mix(l * 0.84, l * 0.92, g);
      o[3] = 0.06 + h * 0.88;
    },
  };
}

/** A dead tree's bare wood: silvered, the grain flowing round a couple of knots, long checks split along it. */
function silver(seed: number): Painter {
  const knots: [number, number, number][] = [];
  for (let i = 0; i < 2; i++) knots.push([hash(i, 1, seed), hash(i, 2, seed), 0.025 + hash(i, 3, seed) * 0.03]);
  const wave = fractal(seed, 2, 3, 3);
  const grainN = fractal(seed + 1, 7, 2, 3);
  const check = fractal(seed + 2, 9, 1, 3);
  const stain = fractal(seed + 3, 3, 4, 3);
  const T = BARK_TILE[BARK.silver];
  return {
    paint: (u, v, o) => {
      let du = wave(u, v) * 0.03;
      let knot = 0;
      for (const [kx, ky, kr] of knots) {
        let dx = u - kx;
        let dy = v - ky;
        dx -= Math.round(dx);
        dy -= Math.round(dy);
        const r = Math.hypot(dx * T, dy * T * 0.6);
        // The grain bends round the knot.
        du += (Math.sign(dx) * kr * 0.9 * Math.exp(-((r / (kr * 2.2)) ** 2))) / T;
        knot = Math.max(knot, smooth(kr, kr * 0.45, r) * 0.85);
      }
      const g = 1 - Math.abs(Math.sin(((u + du) * 40 + grainN(u, v) * 1.2) * Math.PI));
      const c = 1 - smooth(0, 0.022, Math.abs(check(u + du * 0.5, v)));
      const s = stain(u, v);
      let l = 0.72 + g * 0.06 + s * 0.04;
      l *= 1 - c * 0.42;
      const brown = smooth(0.1, 0.5, s) * 0.5;
      o[0] = mix(l * 0.99, l * 1.02, brown);
      o[1] = mix(l * 0.98, l * 0.92, brown);
      o[2] = mix(l * 0.95, l * 0.8, brown);
      if (knot > 0) {
        const kl = 0.46 + 0.06 * Math.sin(knot * 14);
        o[0] = mix(o[0], kl * 1.05, knot);
        o[1] = mix(o[1], kl * 0.9, knot);
        o[2] = mix(o[2], kl * 0.75, knot);
      }
      o[3] = sat(0.55 + g * 0.08 - c * 0.45 + knot * 0.15);
    },
  };
}

/**
 * Eucalyptus, smooth and shedding: a pale cream stem, faintly streaked, mottled in layers the way the bark falls: broad soft
 * grey clouds, sharper patches of the old bark still to fall (tan, ochre, grey-brown, drifting from one to the next) with
 * a thin lip at their edge, a salmon flush of fresh bark round them, a few long grey strips and small dark scars. `cover`
 * raises the share of old bark, `warmth` the fresh flush.
 */
function gumBark(seed: number, cover: number, warmth: number): Painter {
  const warp = fractal(seed, 3, 4, 3);
  const cloud = fractal(seed + 1, 4, 3, 5);
  const patch = fractal(seed + 2, 6, 4, 5);
  const fleck = fractal(seed + 3, 14, 10, 3);
  const hueN = fractal(seed + 4, 3, 3, 3);
  const tone = fractal(seed + 5, 7, 2, 3);
  const streak = fractal(seed + 6, 40, 3, 2);
  const flush = fractal(seed + 7, 3, 4, 3);
  const strip = fractal(seed + 8, 12, 2, 3);
  const stripAt = fractal(seed + 9, 3, 2, 2);
  const inner = fractal(seed + 10, 18, 16, 3);
  const T = BARK_TILE[BARK.gum];
  return {
    paint: (u, v, o) => {
      const wu = u + warp(u, v) * 0.05;
      const wv = v + warp(v + 0.41, u) * 0.04;
      const t = tone(u, v);
      // Fresh bark: cream to white, faintly streaked.
      let r = 0.88 + t * 0.03 + streak(u, v) * 0.014;
      let g = r * 0.975;
      let b = r * 0.93;
      let h = 0.34 + t * 0.02;
      // Broad soft clouds of grey where a thin old skin still lies over it.
      const cl = smooth(0.05 - cover, 0.35 - cover, cloud(wu, wv)) * 0.75;
      r = mix(r, 0.75, cl);
      g = mix(g, 0.745, cl);
      b = mix(b, 0.72, cl);
      // Patches of the old bark, sharp-edged, each drifting in colour across the stem.
      const p = patch(wu, wv) + fleck(wu, wv) * 0.28;
      const th = 0.3 - cover;
      const inP = smooth(th, th + 0.02, p);
      // Fresh salmon bark just round where a patch has lately fallen.
      const fl = smooth(th - 0.16, th - 0.02, p) * (1 - inP) * warmth * (0.5 + 0.5 * smooth(-0.2, 0.3, flush(u, v)));
      r = mix(r, 0.92, fl * 0.6);
      g = mix(g, 0.8, fl * 0.6);
      b = mix(b, 0.7, fl * 0.6);
      if (inP > 0) {
        const hue = hueN(u, v) * 0.6 + 0.5;
        const n = inner(u, v);
        const pr = (hue < 0.5 ? mix(0.74, 0.8, hue * 2) : mix(0.8, 0.8, hue * 2 - 1)) * (0.97 + n * 0.04);
        const pg = (hue < 0.5 ? mix(0.73, 0.74, hue * 2) : mix(0.74, 0.69, hue * 2 - 1)) * (0.97 + n * 0.04);
        const pb = (hue < 0.5 ? mix(0.7, 0.64, hue * 2) : mix(0.64, 0.56, hue * 2 - 1)) * (0.97 + n * 0.04);
        // The lip: a thin darker rim where the old layer stands proud of the new.
        const lip = smooth(th + 0.045, th + 0.008, p) * inP;
        r = mix(r, pr, inP) * (1 - lip * 0.14);
        g = mix(g, pg, inP) * (1 - lip * 0.14);
        b = mix(b, pb, inP) * (1 - lip * 0.15);
        h = mix(h, 0.56 + n * 0.04, inP) + lip * 0.06;
      }
      // A few long strips of shed bark, grey.
      const st = smooth(0.82, 0.93, 1 - Math.abs(strip(wu, v)) * 2.5) * smooth(0.15, 0.45, stripAt(u, v));
      r = mix(r, 0.66, st * 0.6);
      g = mix(g, 0.66, st * 0.6);
      b = mix(b, 0.64, st * 0.6);
      h = mix(h, 0.6, st);
      o[0] = r;
      o[1] = g;
      o[2] = b;
      o[3] = sat(h);
    },
    post: (img) => {
      for (let i = 0; i < 80; i++) {
        // Small dark scars, longer than wide.
        const rx = (0.0015 + hash(i, 3, seed) * 0.0035) / T;
        const ry = rx * (1.3 + hash(i, 4, seed) * 1.2);
        splat(hash(i, 1, seed), hash(i, 2, seed), rx, ry, (j, q) => {
          const k = smooth(1.5, 0.4, q);
          for (let c = 0; c < 3; c++) img[j + c] *= 1 - 0.5 * k;
          img[j + 3] -= 0.08 * k;
        });
      }
    },
  };
}

/**
 * A eucalyptus's rough foot: the old bark in short fibrous flakes, longer than wide, each split along the stem into fibres,
 * grey-brown in the smooth bark's own palette, a soft shadow in the cracks between them. A is each flake's thickness, the
 * same over the whole flake: where the rough bark thins out up the stem whole flakes drop away, the thinnest first, leaving
 * a ragged edge and islands of flakes on the smooth bark.
 */
function gumRough(seed: number): Painter {
  const warp = fractal(seed, 2, 3, 3);
  const jag = fractal(seed + 1, 18, 12, 2);
  const flakes = cells(seed + 2, 10, 3, 0.75);
  const main = fractal(seed + 3, 12, 2, 4);
  const fib = fractal(seed + 4, 64, 6, 3);
  const tone = fractal(seed + 5, 4, 5, 3);
  const thickN = fractal(seed + 6, 3, 3, 3);
  const widthN = fractal(seed + 7, 4, 5, 2);
  return {
    paint: (u, v, o) => {
      const wu = u + warp(u, v) * 0.03;
      const c = flakes(wu + jag(u, v) * 0.012, v + warp(v + 0.6, u) * 0.03 + jag(v, u) * 0.02);
      // Fissures run up the stem, wandering; the flakes are the pieces between the cross breaks.
      const fw = 0.12 + 0.1 * (widthN(u, v) * 0.5 + 0.5);
      const ridge = smooth(0, fw, Math.abs(main(wu, v)));
      const across = Math.abs(c.ny);
      // A flake lifts at its lower edge: a shadow under it, a pale lip on the flake below. Side borders barely show.
      const lowerEdge = (c.ny < 0 ? 1 : 0) * smooth(0.45, 0.85, across) * (1 - smooth(0.002, 0.02, c.edge));
      const upperLip = (c.ny > 0 ? 1 : 0) * smooth(0.45, 0.85, across) * (1 - smooth(0.004, 0.014, c.edge));
      const side = (1 - smooth(0.4, 0.8, across)) * (1 - smooth(0.001, 0.004, c.edge)) * 0.5;
      const f = fib(wu, v);
      const fibre = 1 - smooth(0, 0.3, Math.abs(f));
      const thick = sat(0.3 + 0.55 * c.id + thickN(u, v) * 0.3);
      const h = sat(0.1 + thick * (0.55 + 0.35 * ridge) - lowerEdge * 0.25 - side * 0.1 - fibre * 0.03);
      const tn = tone(u, v);
      const pick = hash(c.cx, c.cy, seed + 5);
      let l = 0.68 + tn * 0.05 + (pick - 0.5) * 0.08 - fibre * 0.05;
      l *= mix(0.66, 1, ridge) * (1 - lowerEdge * 0.35) * (1 - side * 0.15) * (1 + upperLip * 0.08);
      const grey = smooth(-0.25, 0.25, tn + (pick - 0.5) * 0.4);
      o[0] = l * mix(1.04, 0.99, grey);
      o[1] = l * mix(0.95, 0.97, grey);
      o[2] = l * mix(0.85, 0.93, grey);
      o[3] = h;
    },
  };
}

const PAINTERS: (() => Painter)[] = [
  () => fissured(11, 12, 2, { width: 0.2, minor: 0.22, cross: 0.35, lichen: 0.5 }),
  () => plate(23),
  () => fissured(37, 6, 2, { width: 0.2, minor: 0.25, cross: 0.25, lichen: 0.2 }),
  () => smoothBark(41),
  () => palmBark(53),
  () => fibreBark(67),
  () => silver(71),
  () => gumBark(83, 0, 0.7),
  () => gumBark(97, 0.12, 1),
  () => gumRough(101),
];

/** One layer's RGBA bytes (sRGB colour, linear relief), row 0 the foot of the tile. */
export function barkLayer(i: number): Uint8Array {
  const { paint, post } = PAINTERS[i]();
  const img = new Float32Array(S * S * 4);
  const o = new Float32Array(4);
  for (let y = 0; y < S; y++) {
    const v = (y + 0.5) / S;
    for (let x = 0; x < S; x++) {
      paint((x + 0.5) / S, v, o);
      img.set(o, (y * S + x) * 4);
    }
  }
  post?.(img);
  const out = new Uint8Array(S * S * 4);
  for (let j = 0; j < out.length; j++) out[j] = Math.round(sat(img[j]) * 255);
  return out;
}

let data: Uint8Array | null = null;
let done = 0;
let tex: THREE.DataArrayTexture | null = null;
const stats: [number, number][] = [];

/**
 * Per layer, the mean and spread of its relief seen very blurred (16-texel blocks, about the mip the trees' broad tone reads),
 * so the shader can turn that into the same broad variation whatever the layer.
 */
export function barkStats(): readonly [number, number][] {
  barkTextures();
  return stats;
}

function blurredStats(layer: Uint8Array): [number, number] {
  const B = 16;
  const n = S / B;
  let sum = 0;
  let sq = 0;
  for (let by = 0; by < n; by++) {
    for (let bx = 0; bx < n; bx++) {
      let a = 0;
      for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) a += layer[((by * B + y) * S + bx * B + x) * 4 + 3];
      a /= B * B * 255;
      sum += a;
      sq += a * a;
    }
  }
  const mean = sum / (n * n);
  return [mean, Math.max(0.01, Math.sqrt(Math.max(0, sq / (n * n) - mean * mean)))];
}

/** Paint the next bark layer (about 60-150 ms): false once all are painted. For the warm-up's idle slices. */
export function barkTexturesStep(): boolean {
  if (done >= LAYERS) return false;
  data ??= new Uint8Array(S * S * 4 * LAYERS);
  const layer = barkLayer(done);
  data.set(layer, done * S * S * 4);
  stats[done] = blurredStats(layer);
  done++;
  return done < LAYERS;
}

/** Every bark layer as one sRGB array texture, repeating, mipmapped (painting whatever the warm-up has not). */
export function barkTextures(): THREE.DataArrayTexture {
  if (tex) return tex;
  while (barkTexturesStep());
  const t = new THREE.DataArrayTexture(data!, S, S, LAYERS);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return (tex = shared(t));
}
