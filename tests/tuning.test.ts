import { afterEach, describe, expect, it } from 'vitest';
import { hitsToDrop, TUNING, walkerPistolHits, ZOMBIE_HITS, zombieToughness } from '../src/sim/tuning';
import { newWounds, wound } from '../src/sim/ballistics';
import { windAt } from '../src/sim/weather';
import { DEFAULT_RETICLE, readReticle } from '../src/ui/reticle';

describe('play tuning', () => {
  afterEach(() => {
    TUNING.zombieHits = 2;
    TUNING.wind = 1;
  });

  it('every step of the zombie setting takes that many pistol rounds to drop a walker', () => {
    expect(zombieToughness(2)).toBe(1);
    for (const n of ZOMBIE_HITS) expect(walkerPistolHits(n)).toBe(n);
    // A rifle round still drops them faster than a pistol's.
    expect(hitsToDrop(45, 80, 10)).toBeLessThan(10);
  });

  it('a tough zombie keeps its head through hits that would take it off a plain one', () => {
    const plain = newWounds();
    const tough = newWounds();
    expect(wound(plain, 'head', 27, 1, 45, false, 0.3).off).toContain('head');
    expect(wound(tough, 'head', 27, 1, 45, false, 0.3, 45 * zombieToughness(10)).off).not.toContain('head');
    // Limbs still count against the body itself, so it comes apart along the way.
    expect(wound(tough, 'armL', 27, 1, 45, false, 0.3, 45 * zombieToughness(10)).off).toContain('armL');
  });

  it('the wind setting scales the air, and calm is still', () => {
    const [x1, z1] = windAt(0.5, 10);
    TUNING.wind = 2;
    const [x2, z2] = windAt(0.5, 10);
    expect(x2).toBeCloseTo(x1 * 2);
    expect(z2).toBeCloseTo(z1 * 2);
    TUNING.wind = 0;
    expect(Math.hypot(...windAt(0.5, 10))).toBe(0);
  });

  it('a saved crosshair is checked', () => {
    expect(readReticle({ look: 'ringdot', dot: 8, color: 'green' })).toEqual({ look: 'ringdot', dot: 8, color: 'green' });
    expect(readReticle({ look: 'nope', dot: 7, color: 1 })).toEqual(DEFAULT_RETICLE);
    expect(readReticle(undefined)).toEqual(DEFAULT_RETICLE);
  });
});
