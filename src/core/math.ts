export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number) => (a === b ? 0 : clamp01((v - a) / (b - a)));
export const remap = (v: number, a: number, b: number, c: number, d: number) => lerp(c, d, invLerp(a, b, v));
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
/** Frame-rate independent exponential smoothing. Clamped so non-positive or invalid dt never diverges. */
export const damp = (a: number, b: number, lambda: number, dt: number) =>
  dt <= 0 || !Number.isFinite(dt) ? a : lerp(a, b, 1 - Math.exp(-Math.max(0, lambda * dt)));

export function wrapAngle(a: number) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}
export const angleDiff = (from: number, to: number) => wrapAngle(to - from);
export function dampAngle(a: number, b: number, lambda: number, dt: number) {
  return dt <= 0 || !Number.isFinite(dt) ? a : a + angleDiff(a, b) * (1 - Math.exp(-Math.max(0, lambda * dt)));
}
export const dist2 = (ax: number, az: number, bx: number, bz: number) => Math.hypot(ax - bx, az - bz);
export const distSq = (ax: number, az: number, bx: number, bz: number) => (ax - bx) * (ax - bx) + (az - bz) * (az - bz);

/** Heading convention: yaw 0 faces +Z (north), positive yaw turns toward +X (left of a +Z-facing body). */
export const fwdX = (yaw: number) => Math.sin(yaw);
export const fwdZ = (yaw: number) => Math.cos(yaw);
export const yawOf = (dx: number, dz: number) => Math.atan2(dx, dz);

export function kmh(v: number) {
  return v * 3.6;
}
export function msFromKmh(v: number) {
  return v / 3.6;
}

/** Radial deadzone with rescale, per the doc: 0.15, then response curve exponent. */
export function radialDeadzone(x: number, y: number, dz: number, curve = 1): [number, number] {
  const m = Math.hypot(x, y);
  if (m < dz) return [0, 0];
  const s = Math.min(1, (m - dz) / (1 - dz));
  const k = Math.pow(s, curve) / m;
  return [x * k, y * k];
}

export function formatClock(sec: number) {
  sec = Math.max(0, Math.ceil(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
