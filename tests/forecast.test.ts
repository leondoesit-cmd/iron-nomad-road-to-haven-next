import { describe, expect, it } from 'vitest';
import { DayClock, DUSK_BELL_AT, DUSK_WARN_AT } from '../src/sim/dayclock';
import { STORM_FORE_WARN, STORM_FIRST_DAY, HEAT_FIRST_DAY, heatCoolingMult, heatLabel, heatLevel, isHeatDay, stormImminent, stormWindow } from '../src/sim/weather';
import { steadyTemp } from '../src/sim/thermal';
import { planRaid, spendBudgetLeft, WAVE_SCALE, WAVE_SHARE } from '../src/sim/threat';
import { Rng } from '../src/core/rng';

describe('Dusk Bell heads-up', () => {
  it('warns once, before the Bell', () => {
    const c = new DayClock(100, 0.5);
    let warns = 0;
    let bells = 0;
    let warnAt = 0;
    for (let i = 0; i < 80; i++) {
      const r = c.tick(1);
      if (r.warn) {
        warns++;
        warnAt = c.t;
      }
      if (r.bell) bells++;
    }
    expect(warns).toBe(1);
    expect(bells).toBe(1);
    expect(warnAt).toBeGreaterThanOrEqual(DUSK_WARN_AT);
    expect(warnAt).toBeLessThan(DUSK_BELL_AT);
  });

  it('stays quiet when the clock jumps past the warning in one step, or skips to dusk', () => {
    const c = new DayClock(100, 0.5);
    expect(c.tick(40).warn).toBe(false);
    const d = new DayClock(100, 0.1);
    d.skipToDusk();
    expect(d.tick(0.1).warn).toBe(false);
  });

  it('stays quiet while frozen', () => {
    const c = new DayClock(100, 0.61);
    c.frozen = true;
    expect(c.tick(5)).toEqual({ bell: false, warn: false });
  });
});

describe('storm forecast', () => {
  it('fires only in the stretch before the first gust', () => {
    let found = 0;
    for (let seed = 1; seed < 40 && found < 5; seed++) {
      const w = stormWindow(seed, STORM_FIRST_DAY + 1);
      if (!w) continue;
      found++;
      expect(stormImminent(w.start - STORM_FORE_WARN - 0.01, w)).toBe(false);
      expect(stormImminent(w.start - STORM_FORE_WARN / 2, w)).toBe(true);
      expect(stormImminent(w.start + 0.01, w)).toBe(false);
    }
    expect(found).toBeGreaterThan(0);
    expect(stormImminent(0.3, null)).toBe(false);
  });
});

describe('heat waves', () => {
  it('are fixed by the seed and day, and absent early', () => {
    for (let day = 1; day < 30; day++) expect(heatLevel(5, day, 0.4)).toBe(heatLevel(5, day, 0.4));
    for (let seed = 1; seed < 100; seed++) expect(heatLevel(seed, HEAT_FIRST_DAY - 1, 0.4)).toBe(0);
  });

  it('never share a day with a dust storm', () => {
    for (let seed = 1; seed < 80; seed++) {
      for (let day = HEAT_FIRST_DAY; day < HEAT_FIRST_DAY + 20; day++) {
        if (stormWindow(seed, day)) expect(heatLevel(seed, day, 0.4)).toBe(0);
      }
    }
  });

  it('come on some later days, peak near noon and ease before the Bell', () => {
    let hot = 0;
    let days = 0;
    for (let seed = 1; seed <= 60; seed++) {
      for (let day = HEAT_FIRST_DAY; day < HEAT_FIRST_DAY + 20; day++) {
        days++;
        if (!isHeatDay(seed, day)) continue;
        hot++;
        const noon = heatLevel(seed, day, 0.42);
        expect(noon).toBeGreaterThan(0.9);
        expect(heatLevel(seed, day, 0.05)).toBeLessThan(noon);
        expect(heatLevel(seed, day, DUSK_BELL_AT)).toBeLessThan(0.25);
        for (let t = 0; t <= 1; t += 0.05) {
          const l = heatLevel(seed, day, t);
          expect(l).toBeGreaterThanOrEqual(0);
          expect(l).toBeLessThanOrEqual(1);
        }
      }
    }
    expect(hot / days).toBeGreaterThan(0.1);
    expect(hot / days).toBeLessThan(0.4);
  });

  it('cut cooling, so the same engine settles hotter', () => {
    expect(heatCoolingMult(0)).toBe(1);
    expect(heatCoolingMult(1)).toBeLessThan(0.85);
    const base = { heat: 60, cooling: 50, radiator: 1, airflow: 1, load: 0.7, speed: 15, running: true };
    expect(steadyTemp({ ...base, ambient: heatCoolingMult(1) })).toBeGreaterThan(steadyTemp(base));
    expect(steadyTemp({ ...base, ambient: 1 })).toBe(steadyTemp(base));
  });

  it('label the clock line only once it bites', () => {
    expect(heatLabel(0.05)).toBe('');
    expect(heatLabel(0.3)).toBe('HEAT BUILDING');
    expect(heatLabel(0.9)).toBe('HEAT WAVE');
  });
});

describe('raid budget carry-over', () => {
  it('reports what a wave could not spend', () => {
    for (let seed = 1; seed < 30; seed++) {
      const budget = 9;
      const { spec, left } = spendBudgetLeft(budget, 'infected', 0.2, 1, new Rng(seed));
      expect(spec.zombies.length).toBeGreaterThan(0);
      expect(left).toBeGreaterThanOrEqual(0);
      expect(left).toBeLessThan(budget);
    }
  });

  it('rolls the remainder into the next wave without changing wave one', () => {
    const p = planRaid({ base: 30, signature: 50, notoriety: 20, power: 6, kind: 'infected', seed: 17 });
    const first = p.threat * WAVE_SHARE[0] * WAVE_SCALE;
    expect(p.waves[0].budget).toBeCloseTo(first, 6);
    expect(p.waves[1].budget).toBeGreaterThanOrEqual(p.threat * WAVE_SHARE[1] * WAVE_SCALE - 1e-9);
    expect(p.waves[2].budget).toBeGreaterThanOrEqual(p.threat * WAVE_SHARE[2] * WAVE_SCALE - 1e-9);
  });

  it('is still deterministic per seed', () => {
    const a = planRaid({ base: 20, signature: 40, notoriety: 0, power: 5, kind: 'both', seed: 123 });
    const b = planRaid({ base: 20, signature: 40, notoriety: 0, power: 5, kind: 'both', seed: 123 });
    expect(a).toEqual(b);
  });
});
