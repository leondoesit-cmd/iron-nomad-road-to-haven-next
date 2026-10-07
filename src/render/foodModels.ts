import { MeshBuilder, S } from './builder';
import type { FoodId } from '../sim/carry';

/**
 * Things to eat that are carried by hand: a dented tin of dog food with a torn label, and a lizard caught on the hot
 * ground. Origin at the middle of the base, +Z forward, metres.
 */

/** A tin of dog food: dented, the label half torn off, the lid rusted at the rim. */
function dogfood(b: MeshBuilder) {
  const tin = S.metal(0xb4b0a6, 0.55);
  b.cyl(0, 0.065, 0, 0.055, 0.13, 0.055, tin, 0, 0, 0, 16);
  // Rolled rims top and bottom.
  b.torus(0, 0.128, 0, 0.054, 0.006, S.metal(0x8a8478, 0.7), Math.PI / 2, 0, 0, 5, 18);
  b.torus(0, 0.004, 0, 0.054, 0.006, S.metal(0x8a8478, 0.7), Math.PI / 2, 0, 0, 5, 18);
  // The label: a red band with a cream panel and a brown dog's head, torn at the back.
  b.cyl(0, 0.065, 0, 0.0565, 0.085, 0.0565, S.paint(0xa8321e, 0.55), 0, 0, 0, 16);
  b.box(0, 0.068, 0.054, 0.05, 0.05, 0.006, S.paint(0xe6d8b0, 0.5));
  b.add('sphere', 0, 0.07, 0.058, 0.014, 0.012, 0.006, S.paint(0x6a4428, 0.5));
  b.box(-0.022, 0.03, -0.05, 0.04, 0.02, 0.008, tin, 0, 0.6, 0);
  // A dent in the side.
  b.add('sphere', 0.05, 0.05, 0.012, 0.012, 0.02, 0.02, S.metal(0x8e8a80, 0.7));
}

/** A lizard as it is held: a flat brown-orange body, a long tapering tail and four splayed legs. */
function lizard(b: MeshBuilder) {
  const skin = S.leather(0xb4602a, 0.5);
  const belly = S.leather(0xd8a060, 0.4);
  b.capsule(0, 0.03, 0.09, 0, 0.03, -0.05, 0.026, skin);
  b.capsule(0, 0.025, 0.09, 0, 0.02, -0.04, 0.02, belly);
  // Head: a blunt wedge with dark eyes.
  b.capsule(0, 0.035, 0.11, 0, 0.032, 0.15, 0.018, skin);
  for (const sx of [1, -1]) b.add('sphere', sx * 0.012, 0.045, 0.135, 0.004, 0.004, 0.004, S.gloss(0x101010));
  // Tail: tapering segments that curl a little to one side.
  let x = 0;
  let z = -0.05;
  let r = 0.016;
  for (let i = 0; i < 6; i++) {
    const nx = x + Math.sin(i * 0.35) * 0.02;
    const nz = z - 0.045;
    b.rod(x, 0.025, z, nx, 0.022, nz, r, skin, 6);
    x = nx;
    z = nz;
    r *= 0.75;
  }
  // Legs splayed out flat, front and back.
  for (const [lz, sx] of [[0.07, 1], [0.07, -1], [-0.03, 1], [-0.03, -1]] as const) {
    b.rod(sx * 0.02, 0.025, lz, sx * 0.055, 0.008, lz + 0.015, 0.006, skin, 5);
    b.rod(sx * 0.055, 0.008, lz + 0.015, sx * 0.065, 0.004, lz + 0.03, 0.004, skin, 5);
  }
}

/** Fill `b` with a food's model. */
export function drawFood(b: MeshBuilder, food: FoodId) {
  if (food === 'lizard') lizard(b);
  else dogfood(b);
}
