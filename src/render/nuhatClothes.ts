import { MeshBuilder, S } from './builder';

/** Fitted cream blouse, open collar, button placket and the two fine chains in the reference. */
export function drawNuhatBlouse(b: MeshBuilder, skin: number, color: number) {
  const cloth = S.cloth(color, 0.08);
  const at = (angle: number, y: number, lift = 0): [number, number, number] => {
    const waist = Math.exp(-(((y - 0.18) / 0.10) ** 2));
    const shoulder = Math.max(0, (y - 0.4) / 0.14);
    const rx = 0.192 - waist * 0.033 - shoulder * 0.025 + lift;
    const rz = 0.130 + Math.exp(-(((y - 0.34) / 0.10) ** 2)) * 0.018 + lift;
    return [Math.sin(angle) * rx, y - shoulder * Math.abs(Math.sin(angle)) * 0.05, Math.cos(angle) * rz];
  };
  // Bare upper chest stays inside the blouse; the front opening tapers into the collar.
  for (let i = 0; i < 48; i++) for (let j = 0; j < 16; j++) {
    const a = i / 48 * Math.PI * 2, c = (i + 1) / 48 * Math.PI * 2;
    if (Math.cos(a) <= 0 || Math.abs(Math.sin(a)) > 0.56) continue;
    const low = 0.28 + j / 16 * 0.21, high = 0.28 + (j + 1) / 16 * 0.21;
    b.quad(at(a, low, -0.009), at(c, low, -0.009), at(c, high, -0.009), at(a, high, -0.009), { ...S.skin(skin), w: 0 });
  }
  const neck = (a: number): [number, number, number] => [Math.sin(a) * 0.043, 0.525, -0.012 + Math.cos(a) * 0.043];
  for (let i = 0; i < 64; i++) {
    const a = i / 64 * Math.PI * 2, c = (i + 1) / 64 * Math.PI * 2;
    if (Math.cos(a) <= 0 || Math.abs(Math.sin(a)) > 0.56) continue;
    b.quad(at(a, 0.49, -0.009), at(c, 0.49, -0.009), neck(c), neck(a), { ...S.skin(skin), w: 0 });
  }
  const top = (a: number) => Math.cos(a) > 0 ? 0.365 + 0.15 * Math.min(1, Math.abs(Math.sin(a)) / 0.5) : 0.515;
  for (let i = 0; i < 64; i++) for (let j = 0; j < 20; j++) {
    const a = i / 64 * Math.PI * 2, c = (i + 1) / 64 * Math.PI * 2;
    const y = (angle: number, row: number) => 0.012 + row / 20 * (top(angle) - 0.012);
    b.quad(at(a, y(a, j)), at(c, y(c, j)), at(c, y(c, j + 1)), at(a, y(a, j + 1)), cloth);
  }
  for (let i = 0; i < 64; i++) {
    const a = i / 64 * Math.PI * 2, c = (i + 1) / 64 * Math.PI * 2;
    if (Math.cos(a) > 0 && Math.abs(Math.sin(a)) < 0.52) continue;
    const rim = (angle: number): [number, number, number] => [Math.sin(angle) * 0.062, 0.543, -0.012 + Math.cos(angle) * 0.060];
    b.quad(at(a, top(a)), at(c, top(c)), rim(c), rim(a), cloth);
  }
  for (const side of [-1, 1]) {
    const corners: [number, number, number][] = [[side * 0.031, 0.530, 0.060], [side * 0.080, 0.504, 0.110], [side * 0.084, 0.449, 0.147], [side * 0.025, 0.483, 0.139]];
    // Both collar leaves face out, despite being mirror images.
    const [a, c, d, e] = side > 0 ? corners.reverse() : corners;
    b.quad(a, c, d, e, S.cloth(0xfaf3e7, 0.03));
  }
  b.rbox(0, 0.183, 0.135, 0.018, 0.335, 0.007, 0.003, cloth);
  for (const y of [0.07, 0.145, 0.22, 0.295, 0.35]) b.sphereAt(0, y, at(0, y)[2] + 0.007, 0.0035, S.plastic(0xe2dbc9, 0.01));
  for (const [drop, chainColor] of [[0.075, 0xc5cad0], [0.117, 0xd6b35f]]) {
    const chain = Array.from({ length: 25 }, (_, i): [number, number, number] => {
      const t = i / 24 * Math.PI;
      return [Math.cos(t) * 0.062, 0.527 - Math.sin(t) * drop, 0.071 + Math.sin(t) * 0.078];
    });
    b.pipe(chain, 0.0016, S.metal(chainColor, 0.01), 5);
  }
}
