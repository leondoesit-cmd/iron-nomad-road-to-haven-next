import * as THREE from 'three';
import { shared } from './dispose';

/**
 * Photo-scanned surfaces (CC0 scans from Poly Haven, see `public/textures/sources.json`). Each set is an sRGB albedo, an
 * OpenGL normal map and a height map. They are decoded once at boot (`loadPhotoTextures`, from `Game.prepareWorld`) and
 * kept as pixels: the procedural texture builders (`proctex.ts`) pack them into the layouts the shaders already read, so a
 * real scan costs the same per frame as the noise it replaces. Without them (tests, a failed download) the builders fall
 * back to their procedural fields.
 */

export const PHOTO_SETS = ['sand', 'earth', 'rock', 'gravel', 'sand2', 'earth2', 'rock2', 'gravel2', 'grass', 'drygrass', 'litter', 'mud', 'asphalt', 'concrete', 'wallconcrete', 'wallplaster', 'wood', 'metal'] as const;
/** Sets that ship only an albedo. */
export const ALBEDO_ONLY: ReadonlySet<string> = new Set(['wallconcrete', 'wallplaster', 'wood', 'metal']);
export type PhotoSet = (typeof PHOTO_SETS)[number];
export type PhotoMap = 'albedo' | 'normal' | 'height';

/** RGBA pixels with row 0 at the bottom of the picture (v = 0), so "up" in the scan is +v like any texture coordinate. */
export interface Photo {
  w: number;
  h: number;
  data: Uint8ClampedArray;
}

const photos = new Map<string, Photo>();
const key = (set: string, map: PhotoMap) => `${set}:${map}`;

export function photo(set: string, map: PhotoMap): Photo | null {
  return photos.get(key(set, map)) ?? null;
}

/** All three maps of a set, or null if any is missing. */
export function photoSet(set: string): { albedo: Photo; normal: Photo; height: Photo } | null {
  const albedo = photo(set, 'albedo');
  const normal = photo(set, 'normal');
  const height = photo(set, 'height');
  return albedo && normal && height ? { albedo, normal, height } : null;
}

/** Tests and tools: hand in pixels directly. */
export function setPhoto(set: string, map: PhotoMap, p: Photo | null) {
  if (p) photos.set(key(set, map), p);
  else photos.delete(key(set, map));
}

async function decode(url: string): Promise<Photo> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const w = bmp.width;
  const h = bmp.height;
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const top = ctx.getImageData(0, 0, w, h).data;
  // Flip so row 0 is the bottom of the scan.
  const data = new Uint8ClampedArray(top.length);
  const row = w * 4;
  for (let y = 0; y < h; y++) data.set(top.subarray((h - 1 - y) * row, (h - y) * row), y * row);
  return { w, h, data };
}

let loading: Promise<void> | null = null;

/** Fetch and decode every set. Failures are logged and leave that set procedural. */
export function loadPhotoTextures(): Promise<void> {
  if (typeof fetch === 'undefined' || typeof createImageBitmap === 'undefined') return Promise.resolve();
  return (loading ??= (async () => {
    const base = `${import.meta.env.BASE_URL}textures/`;
    const jobs: Promise<void>[] = [];
    for (const set of PHOTO_SETS) {
      for (const map of ALBEDO_ONLY.has(set) ? (['albedo'] as const) : (['albedo', 'normal', 'height'] as const)) {
        jobs.push(decode(`${base}${set}-${map}.jpg`).then((p) => setPhoto(set, map, p), (e) => console.warn(`Photo texture ${set}-${map} unavailable`, e)));
      }
    }
    await Promise.all(jobs);
  })());
}

// ------------------------------------------------------------------------------------------ helpers for the packers

const SRGB_LIN = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
  return t;
})();

/**
 * Average one channel over each output texel (a box filter when shrinking, bilinear when growing), as floats.
 * `fn` maps the raw channel bytes of a source texel to the value averaged (default: the channel / 255).
 */
export function resampleField(p: Photo, size: number, fn: (d: Uint8ClampedArray, i: number) => number, sizeY = size): Float32Array {
  const out = new Float32Array(size * sizeY);
  const sx = p.w / size;
  const sy = p.h / sizeY;
  if (sx === 1 && sy === 1) {
    for (let i = 0; i < out.length; i++) out[i] = fn(p.data, i * 4);
    return out;
  }
  if (sx <= 1 && sy <= 1) {
    // Growing: bilinear on the mapped values, via a full-size field first.
    const src = new Float32Array(p.w * p.h);
    for (let i = 0; i < src.length; i++) src[i] = fn(p.data, i * 4);
    const at = (xx: number, yy: number) => src[(((yy % p.h) + p.h) % p.h) * p.w + (((xx % p.w) + p.w) % p.w)];
    for (let y = 0; y < sizeY; y++) {
      for (let x = 0; x < size; x++) {
        const fx = (x + 0.5) * sx - 0.5;
        const fy = (y + 0.5) * sy - 0.5;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const ax = fx - x0;
        const ay = fy - y0;
        out[y * size + x] = (at(x0, y0) * (1 - ax) + at(x0 + 1, y0) * ax) * (1 - ay) + (at(x0, y0 + 1) * (1 - ax) + at(x0 + 1, y0 + 1) * ax) * ay;
      }
    }
    return out;
  }
  const bx = Math.max(1, Math.round(sx));
  const by = Math.max(1, Math.round(sy));
  for (let y = 0; y < sizeY; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0;
      const x0 = Math.floor(x * sx);
      const y0 = Math.floor(y * sy);
      for (let j = 0; j < by; j++) {
        const yy = (y0 + j) % p.h;
        for (let k = 0; k < bx; k++) sum += fn(p.data, (yy * p.w + ((x0 + k) % p.w)) * 4);
      }
      out[y * size + x] = sum / (bx * by);
    }
  }
  return out;
}

/** Linear luminance of an sRGB albedo texel. */
export const linLum = (d: Uint8ClampedArray, i: number) => SRGB_LIN[d[i]] * 0.2126 + SRGB_LIN[d[i + 1]] * 0.7152 + SRGB_LIN[d[i + 2]] * 0.0722;
export const red = (d: Uint8ClampedArray, i: number) => d[i] / 255;
export const green = (d: Uint8ClampedArray, i: number) => d[i + 1] / 255;

/** The value below which `q` of the field lies (sampled, for speed). */
export function quantile(f: Float32Array, q: number): number {
  const n = Math.min(f.length, 16384);
  const step = f.length / n;
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = f[Math.floor(i * step)];
  s.sort();
  return s[Math.min(n - 1, Math.max(0, Math.floor(q * n)))];
}

export function mean(f: Float32Array): number {
  let s = 0;
  for (let i = 0; i < f.length; i++) s += f[i];
  return s / f.length;
}

/** Stretch a field so `lo`..`hi` quantiles land on 0..1 (clamped). */
export function stretch(f: Float32Array, lo = 0.01, hi = 0.99): Float32Array {
  const a = quantile(f, lo);
  const b = quantile(f, hi);
  const k = b > a ? 1 / (b - a) : 0;
  const out = new Float32Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = Math.min(1, Math.max(0, (f[i] - a) * k));
  return out;
}

/**
 * Albedo as a multiplier the shaders tint: linear luminance scaled so its brightest 0.5% just reach 1 (full use of the 8
 * bits). Returns the field and its mean, so a material can scale it back to the brightness its palette was tuned for.
 */
export function albedoField(p: Photo, size: number, sizeY = size): { field: Float32Array; mean: number } {
  const f = resampleField(p, size, linLum, sizeY);
  const top = quantile(f, 0.995) || 1;
  for (let i = 0; i < f.length; i++) f[i] = Math.min(1, f[i] / top);
  return { field: f, mean: mean(f) };
}

/**
 * Normal map x/y in the procedural encoding (0..1, x along +u, y along +v), resampled, with `gain` scaling the tilt.
 * Box-filtering a normal map shortens it, which is the right thing for a mip-like shrink: the bumps flatten.
 */
export function normalFields(p: Photo, size: number, gain = 1, sizeY = size): { x: Float32Array; y: Float32Array } {
  const x = resampleField(p, size, red, sizeY);
  const y = resampleField(p, size, green, sizeY);
  for (let i = 0; i < x.length; i++) {
    let nx = (x[i] * 2 - 1) * gain;
    let ny = (y[i] * 2 - 1) * gain;
    const l2 = nx * nx + ny * ny;
    if (l2 > 0.81) {
      const k = 0.9 / Math.sqrt(l2);
      nx *= k;
      ny *= k;
    }
    x[i] = nx * 0.5 + 0.5;
    y[i] = ny * 0.5 + 0.5;
  }
  return { x, y };
}

/**
 * A scan as a colour multiplier around its own mean, three fields of linear colour / mean colour * `REL` (so `REL` is the
 * mean, and a texel up to 1 / `REL` times as bright as the mean still fits a byte). `chroma` keeps that much of the scan's
 * own hue variation (0: brightness only, the same in all three). Also returns the mean linear colour.
 */
export function colourFields(p: Photo, size: number, chroma: number): { r: Float32Array; g: Float32Array; b: Float32Array; mean: [number, number, number] } {
  const r = resampleField(p, size, (d, i) => SRGB_LIN[d[i]]);
  const g = resampleField(p, size, (d, i) => SRGB_LIN[d[i + 1]]);
  const b = resampleField(p, size, (d, i) => SRGB_LIN[d[i + 2]]);
  const mr = mean(r) || 1e-3;
  const mg = mean(g) || 1e-3;
  const mb = mean(b) || 1e-3;
  const ml = mr * 0.2126 + mg * 0.7152 + mb * 0.0722;
  for (let i = 0; i < r.length; i++) {
    const l = (r[i] * 0.2126 + g[i] * 0.7152 + b[i] * 0.0722) / ml;
    r[i] = (l + (r[i] / mr - l) * chroma) * REL;
    g[i] = (l + (g[i] / mg - l) * chroma) * REL;
    b[i] = (l + (b[i] / mb - l) * chroma) * REL;
  }
  return { r, g, b, mean: [mr, mg, mb] };
}

/** The value a mean texel takes in `colourFields` (the shaders multiply by its inverse). */
export const REL = 0.4;

const b8 = (v: number) => Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * 255);

/** Four fields into one RGBA byte texture (linear data, repeating, mipmapped). */
export function packTexture(r: Float32Array, g: Float32Array, b: Float32Array, a: Float32Array, size: number, sizeY = size): THREE.DataTexture {
  const n = size * sizeY;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = b8(r[i]);
    out[i * 4 + 1] = b8(g[i]);
    out[i * 4 + 2] = b8(b[i]);
    out[i * 4 + 3] = b8(a[i]);
  }
  const t = new THREE.DataTexture(out, size, sizeY, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return shared(t);
}

/**
 * A close-up detail texture for a surface the game already colours: R albedo as a multiplier around 0.5 (0.5 = no
 * change), G height, B/A normal x/y. Sampled once per pixel at the scan's real size by the road and paving shaders.
 */
export function detailTexture(set: PhotoSet, size = 512, normalGain = 1): THREE.DataTexture | null {
  const s = photoSet(set);
  if (!s) return null;
  const { field, mean: m } = albedoField(s.albedo, size);
  for (let i = 0; i < field.length; i++) field[i] = Math.min(1, (field[i] / (m || 1)) * 0.5);
  const h = stretch(resampleField(s.height, size, red));
  const n = normalFields(s.normal, size, normalGain);
  return packTexture(field, h, n.x, n.y, size);
}

/**
 * Brightness grain of up to four scans in one texture, one per channel, each a multiplier around 0.5 (0.5 = no change).
 * The texture covers `metres` square; each scan is tiled a whole number of times to come near its real size, and `turn`
 * lays its grain along u instead of v. Missing scans stay flat.
 */
export function grainTexture(sets: { set: string; real: number; turn?: boolean }[], metres: number, size = 1024): THREE.DataTexture | null {
  if (!sets.some((s) => photo(s.set, 'albedo'))) return null;
  const ch = sets.map(({ set, real, turn }) => {
    const p = photo(set, 'albedo');
    const f = new Float32Array(size * size).fill(0.5);
    if (!p) return f;
    // A power of two, so the tiles fit the texture exactly and it still wraps seamlessly.
    const tiles = 2 ** Math.max(0, Math.round(Math.log2(metres / real)));
    const src = resampleField(p, Math.round(size / tiles), linLum);
    const n = Math.round(size / tiles);
    const m = mean(src) || 1;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const sx = (turn ? y : x) % n;
        const sy = (turn ? x : y) % n;
        f[y * size + x] = Math.min(1, (src[sy * n + sx] / m) * 0.5);
      }
    }
    return f;
  });
  while (ch.length < 4) ch.push(new Float32Array(size * size).fill(0.5));
  return packTexture(ch[0], ch[1], ch[2], ch[3], size);
}

/** Neutral stand-in for a detail texture: multiplier 1, flat. */
let flat: THREE.DataTexture | null = null;
export function flatDetail(): THREE.DataTexture {
  if (!flat) {
    flat = new THREE.DataTexture(new Uint8Array([128, 128, 128, 128]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    flat.wrapS = flat.wrapT = THREE.RepeatWrapping;
    flat.needsUpdate = true;
    shared(flat);
  }
  return flat;
}

/**
 * A scan tiled `tilesU` x `tilesV` times into a `size` square cell of sRGB bytes (opaque), box-filtered. `tint` keeps
 * only the brightness and gives it that tint (a cell the vertex colours colour, like the plain bark); without it the
 * scan keeps its own colours. Either way the brightness is scaled so its mean lands on `meanTarget` (sRGB 0..1).
 */
export function photoCell(p: Photo, size: number, tilesU: number, tilesV: number, meanTarget: number, tint?: [number, number, number]): Uint8Array {
  const bx = Math.max(1, Math.round((p.w * tilesU) / size));
  const by = Math.max(1, Math.round((p.h * tilesV) / size));
  const rgb = new Float32Array(size * size * 3);
  let sum = 0;
  for (let y = 0; y < size; y++) {
    const y0 = Math.floor((y * p.h * tilesV) / size);
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor((x * p.w * tilesU) / size);
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < by; j++) {
        const row = ((y0 + j) % p.h) * p.w;
        for (let k = 0; k < bx; k++) {
          const i = (row + ((x0 + k) % p.w)) * 4;
          r += p.data[i];
          g += p.data[i + 1];
          b += p.data[i + 2];
        }
      }
      const n = 255 * bx * by;
      const o = (y * size + x) * 3;
      rgb[o] = r / n;
      rgb[o + 1] = g / n;
      rgb[o + 2] = b / n;
      sum += rgb[o] * 0.2126 + rgb[o + 1] * 0.7152 + rgb[o + 2] * 0.0722;
    }
  }
  const k = meanTarget / (sum / (size * size) || 1);
  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    if (tint) {
      const l = (rgb[i * 3] * 0.2126 + rgb[i * 3 + 1] * 0.7152 + rgb[i * 3 + 2] * 0.0722) * k;
      out[i * 4] = b8(l * tint[0]);
      out[i * 4 + 1] = b8(l * tint[1]);
      out[i * 4 + 2] = b8(l * tint[2]);
    } else {
      out[i * 4] = b8(rgb[i * 3] * k);
      out[i * 4 + 1] = b8(rgb[i * 3 + 1] * k);
      out[i * 4 + 2] = b8(rgb[i * 3 + 2] * k);
    }
    out[i * 4 + 3] = 255;
  }
  return out;
}
