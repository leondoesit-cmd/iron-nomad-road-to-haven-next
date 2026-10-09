import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Particles } from '../src/render/particles';
import { MUZZLE } from '../src/sim/weaponfx';
import './helpers/sim';

/** Summed opacity of every smoke sprite a spy saw thrown: how much smoke went into the air. */
const alphaOf = (calls: unknown[][]) => calls.reduce((s, c) => s + (c[12] as number), 0);

function dispose(fx: Particles) {
  for (const layer of [fx.smoke, fx.glow]) {
    layer.points.geometry.dispose();
    (layer.points.material as THREE.Material).dispose();
  }
}

describe('powder smoke', () => {
  it('a long burst into the same air adds far less smoke per shot than a first shot into clean air', () => {
    const fx = new Particles();
    const emit = vi.spyOn(fx.smoke, 'emit');
    // First shots, each far from the last.
    for (let i = 0; i < 100; i++) fx.muzzle(i * 10, 1.5, 0, 1, 0, 0, MUZZLE.rifle);
    const first = alphaOf(emit.mock.calls) / 100;
    expect(first).toBeGreaterThan(0);
    // Ten rounds a second from one spot for six seconds: the last two seconds are twenty shots.
    for (let i = 0; i < 60; i++) {
      if (i === 40) emit.mockClear();
      fx.muzzle(2000, 1.5, 0, 1, 0, 0, MUZZLE.rifle);
      fx.update(0.1);
    }
    expect(alphaOf(emit.mock.calls)).toBeLessThan(first * 7);
    dispose(fx);
  });

  it('a shot is a few uneven knots, not a run of matching puffs', () => {
    const fx = new Particles();
    const emit = vi.spyOn(fx.smoke, 'emit');
    for (let i = 0; i < 100; i++) fx.muzzle(i * 10, 1.5, 0, 1, 0, 0, MUZZLE.sawn);
    const alphas = emit.mock.calls.map(c => c[12] as number);
    const sizes = emit.mock.calls.map(c => c[8] as number);
    expect(Math.max(...alphas)).toBeGreaterThan(Math.min(...alphas) * 3);
    expect(Math.max(...sizes)).toBeGreaterThan(Math.min(...sizes) * 2);
    // Faint all the same: nothing as thick as the old two-thirds-opaque puffs.
    expect(Math.max(...alphas)).toBeLessThan(0.45);
    dispose(fx);
  });

  it('the wind carries the smoke off', () => {
    const fx = new Particles();
    fx.wind = [3, 0];
    // Fired along z, so any drift along x is the wind's.
    fx.muzzle(0, 1.5, 0, 0, 0, 1, MUZZLE.rifle);
    for (let i = 0; i < 7; i++) fx.update(0.1);
    expect(fx.smoke.points.geometry.getAttribute('aVelocity').getX(0)).toBeGreaterThan(1);
    dispose(fx);
  });
});
