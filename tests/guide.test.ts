import { describe, expect, it } from 'vitest';
import { PAD_DRIVE, PAD_FOOT, artCamp, artCar, artDay, artHold, artHud, artNoise, artPad, artRoad, artSurvive, moped } from '../src/ui/guideArt';

// The illustrated guide's pictures are built from template strings: a typo shows up as a broken drawing, not an error.
const arts: [string, () => string][] = [
  ['road', artRoad],
  ['day', artDay],
  ['hud', artHud],
  ['foot pad', () => artPad(PAD_FOOT, 'ON FOOT')],
  ['drive pad', () => artPad(PAD_DRIVE, 'DRIVING')],
  ['hold', artHold],
  ['noise', artNoise],
  ['car', artCar],
  ['camp', artCamp],
  ['survive', artSurvive],
];

const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

describe('guide art', () => {
  for (const [name, make] of arts) {
    it(`draws the ${name} picture as one well-formed svg`, () => {
      const svg = make();
      expect(svg.startsWith('<svg ')).toBe(true);
      expect(svg.endsWith('</svg>')).toBe(true);
      expect(svg).not.toMatch(/NaN|undefined|\[object|Infinity/);
      // Every group and text element that opens also closes.
      expect(count(svg, /<g[ >]/g)).toBe(count(svg, /<\/g>/g));
      expect(count(svg, /<text[ >]/g)).toBe(count(svg, /<\/text>/g));
      // It says what it shows, for a screen reader.
      expect(svg).toMatch(/aria-label="[^"]{20,}"/);
    });
  }

  it('names every pad part once, so no label is drawn on top of another', () => {
    for (const labels of [PAD_FOOT, PAD_DRIVE]) {
      const parts = labels.map((l) => l.part);
      expect(new Set(parts).size).toBe(parts.length);
    }
  });

  it('flips a moped by scaling it, not by drawing a second one', () => {
    expect(moped(0, 0, 1, 'red', true)).toContain('scale(-1 1)');
    expect(moped(0, 0, 1, 'red')).toContain('scale(1 1)');
  });
});
