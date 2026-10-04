import type { EngineSpec } from '../data';

/**
 * How big an engine really is. Every engine's drawn model scales from its spec (litres, cylinders, layout, size class), and every
 * size class has a bay envelope: the largest box an engine of that class occupies. A chassis' bay class says how big an envelope
 * its engine bay holds, and `render/attachments.ts` checks that the real bay of every model (hood height, wing width, bay length)
 * holds its own envelope under a closed bonnet with clearance. Pure maths, so the garage and the tests can use it too.
 */

/** Length (front to back), width and height of an engine with its manifolds, belts and intake, in metres. */
export interface Dims {
  l: number;
  w: number;
  h: number;
}

/** The largest engine each size class holds. Index is the class, 0 being an empty bay. */
export const BAY_ENVELOPE: readonly Dims[] = [
  { l: 0, w: 0, h: 0 },
  { l: 0.44, w: 0.46, h: 0.42 },
  { l: 0.6, w: 0.5, h: 0.44 },
  { l: 0.74, w: 0.56, h: 0.48 },
  { l: 0.88, w: 0.62, h: 0.52 },
  { l: 1.4, w: 0.84, h: 0.74 },
];

export const envelopeOf = (size: number): Dims => BAY_ENVELOPE[Math.max(0, Math.min(5, Math.round(size)))];

const CYL: Record<string, number> = { I1: 1, I2: 2, I3: 3, I4: 4, B4: 4, I6: 6, V6: 6, V8: 8 };

/** Cylinder count of a layout string ("I4", "V8", "B4"...). */
export function cylindersOf(spec: EngineSpec): number {
  return CYL[spec.layout ?? ''] ?? 4;
}

export const isVee = (spec: EngineSpec) => /^V/.test(spec.layout ?? '');
export const isBoxer = (spec: EngineSpec) => /^B/.test(spec.layout ?? '');

/**
 * The size of an engine. A cylinder of half a litre is the yardstick; bigger cylinders mean a bigger bore pitch, a taller block,
 * a wider head. A vee is shorter and wider than an inline of the same count, a boxer is long, wide and low, a blown engine
 * is taller (the blower or turbo) and a diesel is heavier in the head. The result never exceeds the class envelope, and an
 * engine is always longer than the previous class' envelope, so a class really is a bigger engine.
 */
export function engineDims(spec: EngineSpec): Dims {
  if (spec.kw <= 0 || spec.size <= 0) return { l: 0, w: 0, h: 0 };
  const n = cylindersOf(spec);
  const k = Math.cbrt(Math.max(0.02, spec.litres / n) / 0.5);
  const per = isVee(spec) || isBoxer(spec) ? n / 2 : n;
  const pitch = 0.088 * k;
  let l = per * pitch + 0.17;
  let w = 0.3 * k + 0.12;
  let h = 0.3 * k + 0.16;
  if (isVee(spec)) {
    w = 0.42 * k + 0.2;
    h = 0.26 * k + 0.2;
  } else if (isBoxer(spec)) {
    w = 0.38 * k + 0.16;
    h = 0.26 * k + 0.1;
    l += 0.12;
  }
  if (spec.blown) h += 0.05;
  if (spec.fuel === 'diesel') {
    w += 0.04;
    h += 0.02;
  }
  const env = envelopeOf(spec.size);
  const prev = envelopeOf(spec.size - 1);
  l = Math.min(env.l, Math.max(l, prev.l * 1.04));
  w = Math.min(env.w, w);
  h = Math.min(env.h, h);
  return { l: round2(l), w: round2(w), h: round2(h) };
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** True when `d` fits inside `room` (with `clear` metres to spare on every side). */
export function fitsIn(d: Dims, room: Dims, clear = 0): boolean {
  return d.l + clear * 2 <= room.l + 1e-9 && d.w + clear * 2 <= room.w + 1e-9 && d.h + clear <= room.h + 1e-9;
}
