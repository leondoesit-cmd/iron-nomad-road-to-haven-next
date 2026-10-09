import { describe, expect, it, vi } from 'vitest';
import { Ejecta, GRAIN, dragOf } from '../src/sim/ejecta';

// What a hit throws flies by its weight: fine sand hangs and drifts with the wind, a crumb of earth or a pebble flies on
// as thrown, grit off concrete is gone where it lands.

const flat = () => 0;

function fly(kind: 'sand' | 'loam' | 'gravel' | 'grit', vx: number, vy: number, wind: number) {
  const e = new Ejecta(8);
  // A piece of the kind's middling grain (each piece's size otherwise varies at random).
  const r = vi.spyOn(Math, 'random').mockReturnValue(0.4);
  e.launch(0, 1, 0, vx, vy, 0, 1e-6, kind);
  r.mockRestore();
  let maxV = 0;
  let landedAt = NaN;
  for (let k = 0; k < 600 && e.n; k++) {
    e.step(1 / 60, wind, 0, flat, (x) => ((landedAt = x), true));
    if (e.n) maxV = Math.max(maxV, -e.vy[0]);
  }
  return { maxV, landedAt, lost: e.lost };
}

describe('pieces in the air', () => {
  it('fall at their terminal speed: sand slowly, a pebble fast', () => {
    expect(Math.sqrt(9.81 / dragOf(GRAIN.sand.d, GRAIN.sand.rho, GRAIN.sand.cd))).toBeLessThan(5);
    expect(Math.sqrt(9.81 / dragOf(GRAIN.gravel.d, GRAIN.gravel.rho, GRAIN.gravel.cd))).toBeGreaterThan(15);
    const e = new Ejecta(4);
    e.launch(0, 40, 0, 0, 0, 0, 1e-6, 'sand');
    for (let k = 0; k < 300; k++) e.step(1 / 60, 0, 0, () => -100, () => true);
    expect(-e.vy[0]).toBeLessThan(8);
  });

  it('go with the wind by how light they are', () => {
    const sand = fly('sand', 0, 3, 8);
    const earth = fly('loam', 0, 3, 8);
    const pebble = fly('gravel', 0, 3, 8);
    expect(sand.landedAt).toBeGreaterThan(earth.landedAt);
    expect(earth.landedAt).toBeGreaterThan(pebble.landedAt);
    expect(pebble.landedAt).toBeLessThan(0.7);
    expect(sand.landedAt).toBeGreaterThan(2);
  });

  it('a hard throw carries a pebble far and a puff of sand only a little way', () => {
    expect(fly('gravel', 8, 3, 0).landedAt).toBeGreaterThan(fly('sand', 8, 3, 0).landedAt * 2);
  });

  it('grit off concrete is not soil: nothing is handed to the ground', () => {
    const e = new Ejecta(4);
    e.launch(0, 1, 0, 1, 1, 0, 1e-7, 'grit', { tint: [0.6, 0.6, 0.6] });
    let handed = 0;
    for (let k = 0; k < 300 && e.n; k++) e.step(1 / 60, 0, 0, flat, () => (handed++, true));
    expect(handed).toBe(0);
    expect(e.lost).toBeGreaterThan(0);
  });
});
