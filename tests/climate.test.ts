import { describe, expect, it } from 'vitest';
import { DUSK_BELL_AT } from '../src/sim/dayclock';
import {
  HYDRO_DT,
  RAIN_FIRST_DAY,
  cellLevel,
  dayPlan,
  fireDanger,
  groundHeat,
  hydrograph,
  panFill,
  rainLabel,
  rainSight,
  sampleHydro,
  skyAt,
  type CellKind,
} from '../src/sim/climate';
import { heatLevel, stormWindow } from '../src/sim/weather';

/** Every (seed, day) pair worth looking at, and the first that has a cell of a kind. */
function* days(seeds = 40, n = 30) {
  for (let seed = 1; seed <= seeds; seed++) for (let day = 1; day <= n; day++) yield { seed, day, plan: dayPlan(seed, day) };
}
function firstWith(kind: CellKind) {
  for (const d of days()) if (d.plan.cells.some((c) => c.kind === kind)) return d;
  throw new Error(`no ${kind} day`);
}
const peakOf = (a: Float32Array) => {
  let m = 0;
  let at = 0;
  a.forEach((v, i) => {
    if (v > m) {
      m = v;
      at = i * HYDRO_DT;
    }
  });
  return { m, at };
};

describe('the day plan', () => {
  it('is fixed by the seed and the day', () => {
    for (let day = 1; day < 30; day++) expect(dayPlan(7, day)).toEqual(dayPlan(7, day));
  });

  it('keeps the first day dry, and every cell inside the day', () => {
    for (let seed = 1; seed < 200; seed++) {
      expect(dayPlan(seed, RAIN_FIRST_DAY - 1).cells).toEqual([]);
      expect(dayPlan(seed, RAIN_FIRST_DAY - 1).night).toBe(0);
    }
    for (const { plan } of days()) {
      for (const c of plan.cells) {
        expect(c.start).toBeGreaterThan(0.1);
        expect(c.end).toBeLessThan(0.9);
        expect(c.end).toBeGreaterThan(c.start);
        expect(c.peak).toBeGreaterThan(0);
        expect(c.peak).toBeLessThanOrEqual(1);
      }
    }
  });

  it('brings every kind of rain, on a minority of days as a desert should', () => {
    const seen = new Set<CellKind>();
    let wet = 0;
    let all = 0;
    for (const { day, plan } of days(60, 30)) {
      if (day < RAIN_FIRST_DAY) continue;
      all++;
      if (plan.cells.length) wet++;
      for (const c of plan.cells) seen.add(c.kind);
    }
    expect([...seen].sort()).toEqual(['dry', 'far', 'shower', 'storm']);
    expect(wet / all).toBeGreaterThan(0.2);
    expect(wet / all).toBeLessThan(0.5);
  });

  it('never rains on a heat wave, which can only end in dry lightning', () => {
    for (const { seed, day, plan } of days()) {
      if (heatLevel(seed, day, 0.42) <= 0) continue;
      for (const c of plan.cells) expect(c.kind).toBe('dry');
    }
  });

  it('lets a thunderstorm follow a wall of dust in, never come before it', () => {
    let after = 0;
    for (const { seed, day, plan } of days()) {
      const w = stormWindow(seed, day);
      if (!w) continue;
      for (const c of plan.cells) {
        expect(c.kind).toBe('storm');
        expect(c.start).toBeGreaterThan(w.start + (w.end - w.start) * 0.5);
        after++;
      }
    }
    expect(after).toBeGreaterThan(5);
  });
});

describe('the sky', () => {
  it('is clear of rain outside the cells, and a cell builds and dies smoothly', () => {
    const { plan } = firstWith('storm');
    const c = plan.cells.find((q) => q.kind === 'storm')!;
    expect(skyAt(plan, c.start - 0.001).rain).toBe(0);
    expect(skyAt(plan, c.end + 0.001).rain).toBe(0);
    let peak = 0;
    let last = 0;
    for (let t = c.start; t < c.end; t += 0.0005) {
      const r = skyAt(plan, t).rain;
      expect(Math.abs(r - last)).toBeLessThan(0.08);
      last = r;
      peak = Math.max(peak, r);
    }
    expect(peak).toBeCloseTo(c.peak, 1);
    expect(cellLevel(c, (c.start + c.end) / 2)).toBe(1);
  });

  it('builds the thunderhead before the first drop, and darkens it', () => {
    const { plan } = firstWith('storm');
    const c = plan.cells.find((q) => q.kind === 'storm')!;
    const before = skyAt(plan, c.start - 0.07);
    expect(before.rain).toBe(0);
    expect(before.tower).toBeGreaterThan(0.3);
    expect(before.boltsFar).toBeGreaterThan(0);
    const mid = skyAt(plan, (c.start + c.end) / 2);
    expect(mid.cover).toBeGreaterThan(0.9);
    expect(mid.dark).toBeGreaterThan(0.9);
    expect(mid.boltsNear).toBeGreaterThan(1);
  });

  it('a storm over the mountains drops nothing here but floods the hills', () => {
    const { plan } = firstWith('far');
    const c = plan.cells.find((q) => q.kind === 'far')!;
    const s = skyAt(plan, (c.start + c.end) / 2);
    expect(s.rain).toBe(0);
    expect(s.rainUp).toBeGreaterThan(0.7);
    expect(s.cover).toBeLessThan(0.5);
    expect(s.tower).toBeGreaterThan(0.8);
    expect(s.boltsNear).toBe(0);
    expect(s.boltsFar).toBeGreaterThan(3);
  });

  it('dry lightning is all flash and next to no rain', () => {
    const { plan } = firstWith('dry');
    const c = plan.cells.find((q) => q.kind === 'dry')!;
    const s = skyAt(plan, (c.start + c.end) / 2);
    expect(s.rain).toBeLessThan(0.1);
    expect(s.boltsNear).toBeGreaterThan(3);
  });

  it('names the weather for the clock line', () => {
    const calm = skyAt(dayPlan(1, 1), 0.4);
    expect(rainLabel(calm, 0)).toBe('');
    expect(rainLabel({ ...calm, rain: 0.8, boltsNear: 6 }, 0)).toBe('THUNDERSTORM');
    expect(rainLabel({ ...calm, rain: 0.04, boltsNear: 6 }, 0)).toBe('DRY LIGHTNING');
    expect(rainLabel({ ...calm, rain: 0.3 }, 0)).toBe('RAIN');
    expect(rainLabel(calm, 0.6)).toBe('FLASH FLOOD');
  });
});

describe('the water on the ground', () => {
  it('nothing on the first day, ever', () => {
    const h = hydrograph(1, 1);
    for (const a of [h.wet, h.puddle, h.wash, h.river, h.pan]) expect(peakOf(a).m).toBe(0);
  });

  it('hard ground goes dark in seconds of rain and dries within the hour of sun after it', () => {
    const { seed, day, plan } = firstWith('storm');
    const c = plan.cells.find((q) => q.kind === 'storm')!;
    const h = hydrograph(seed, day);
    expect(sampleHydro(h.wet, c.start + (c.end - c.start) * 0.35)).toBeGreaterThan(0.8);
    // A game hour is about 0.07 of the clock.
    expect(sampleHydro(h.wet, c.end + 0.09)).toBeLessThan(0.15);
  });

  it('a shower wets the road but never runs down a wash', () => {
    for (const { seed, day, plan } of days(15, 30)) {
      if (!plan.cells.length || plan.cells.some((c) => c.kind !== 'shower') || plan.night > 0) continue;
      const h = hydrograph(seed, day);
      // Yesterday's leftovers aside, today's showers make no flood of their own.
      for (const c of plan.cells) expect(sampleHydro(h.wash, c.end + 0.02)).toBeLessThan(0.02);
      expect(peakOf(h.wet).m).toBeGreaterThan(0.4);
    }
  });

  it('a far storm sends a flash flood down the washes under a dry sky, the rivers rise after it, the pans fill and hold', () => {
    const { seed, day, plan } = firstWith('far');
    const h = hydrograph(seed, day);
    const c = plan.cells.find((q) => q.kind === 'far')!;
    const wash = peakOf(h.wash);
    const river = peakOf(h.river);
    const pan = peakOf(h.pan);
    expect(wash.m).toBeGreaterThan(0.5);
    expect(wash.at).toBeGreaterThan(c.start);
    // Nothing fell here: the ground stays dry while the wash runs.
    expect(sampleHydro(h.wet, wash.at)).toBeLessThan(0.05);
    expect(river.m).toBeGreaterThan(0.25);
    expect(river.at).toBeGreaterThan(wash.at);
    expect(pan.m).toBeGreaterThan(0.3);
    // A flash flood is over in minutes; the river stays up for hours; the pan holds its sheet into the night.
    expect(sampleHydro(h.wash, wash.at + 0.08)).toBeLessThan(wash.m * 0.2);
    expect(sampleHydro(h.river, river.at + 0.08)).toBeGreaterThan(river.m * 0.4);
    expect(panFill(h, Math.min(1.1, pan.at + 0.3), 0)).toBeGreaterThan(pan.m * 0.35);
  });

  it('a night of rain leaves the morning wet, and the sun dries it by midday', () => {
    let checked = 0;
    for (const { seed, day, plan } of days(20, 30)) {
      if (plan.night < 0.6 || plan.cells.length) continue;
      const h = hydrograph(seed, day);
      expect(sampleHydro(h.wet, 0.1)).toBeGreaterThan(0.2);
      expect(sampleHydro(h.puddle, 0.1)).toBeGreaterThan(0.2);
      expect(sampleHydro(h.wet, 0.45)).toBeLessThan(0.05);
      checked++;
    }
    expect(checked).toBeGreaterThan(3);
  });

  it('keeps every series inside 0..1', () => {
    for (const { seed, day } of days(10, 20)) {
      const h = hydrograph(seed, day);
      for (const a of [h.wet, h.puddle, h.wash, h.river, h.pan]) for (const v of a) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('heat and fire', () => {
  it('the ground throws heat back under a high sun in a clear sky, not at night, under cloud or when wet', () => {
    expect(groundHeat(0.42, 0, 0, 0)).toBeGreaterThan(0.45);
    expect(groundHeat(0.42, 0, 0, 1)).toBeGreaterThan(0.95);
    expect(groundHeat(0.95, 0, 0, 1)).toBe(0);
    expect(groundHeat(0.05, 0, 0, 1)).toBe(0);
    expect(groundHeat(0.42, 1, 0, 1)).toBeLessThan(0.2);
    expect(groundHeat(0.42, 0, 1, 1)).toBeLessThan(0.15);
    expect(groundHeat(DUSK_BELL_AT, 0, 0, 0)).toBeLessThan(groundHeat(0.42, 0, 0, 0));
  });

  it('dry heat is tinder; a downpour on wet ground is not', () => {
    expect(fireDanger(0, 0, 1)).toBe(1);
    expect(fireDanger(1, 1, 0)).toBeLessThan(0.05);
    expect(fireDanger(0, 0.1, 0.5)).toBeGreaterThan(fireDanger(0.8, 0.8, 0.5));
  });

  it('heavy rain hides the convoy a little from raiders', () => {
    expect(rainSight(0)).toBe(1);
    expect(rainSight(1)).toBeGreaterThan(0.5);
    expect(rainSight(1)).toBeLessThan(0.8);
  });
});
