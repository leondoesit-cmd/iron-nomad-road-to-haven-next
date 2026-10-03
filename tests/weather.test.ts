import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { acquire } from '../src/game/raiders';
import { WorldMemory } from '../src/game/worldMemory';
import { DUSK_BELL_AT } from '../src/sim/dayclock';
import {
  STORM_FIRST_DAY,
  groundDamp,
  stormFogScale,
  stormLabel,
  stormLevel,
  stormMapRadius,
  stormOilMult,
  stormSight,
  stormWindow,
} from '../src/sim/weather';
import { fakeServices, run } from './helpers/sim';

vi.setConfig({ testTimeout: 120000 });

beforeAll(async () => {
  await initPhysics();
});

describe('storm windows', () => {
  it('are fixed by the seed and the day', () => {
    for (let day = 1; day < 40; day++) expect(stormWindow(7, day)).toEqual(stormWindow(7, day));
  });

  it('leave the first day clear', () => {
    for (let seed = 1; seed < 200; seed++) expect(stormWindow(seed, STORM_FIRST_DAY - 1)).toBeNull();
  });

  it('come on roughly half the later days, and always end before the Dusk Bell', () => {
    let storms = 0;
    let days = 0;
    for (let seed = 1; seed <= 60; seed++) {
      for (let day = STORM_FIRST_DAY; day < STORM_FIRST_DAY + 20; day++) {
        days++;
        const w = stormWindow(seed, day);
        if (!w) continue;
        storms++;
        expect(w.start).toBeGreaterThan(0.1);
        expect(w.end).toBeLessThan(DUSK_BELL_AT);
        expect(w.end - w.start).toBeGreaterThan(0.15);
      }
    }
    expect(storms / days).toBeGreaterThan(0.3);
    expect(storms / days).toBeLessThan(0.6);
  });

  it('differ between days and between campaigns', () => {
    const starts = new Set<number>();
    for (let seed = 1; seed <= 12; seed++) for (let day = 2; day < 12; day++) starts.add(stormWindow(seed, day)?.start ?? -1);
    expect(starts.size).toBeGreaterThan(20);
  });
});

describe('storm level', () => {
  const w = { start: 0.2, end: 0.4 };
  it('is zero outside the window and full in the middle', () => {
    expect(stormLevel(0.1, w)).toBe(0);
    expect(stormLevel(0.5, w)).toBe(0);
    expect(stormLevel(0.3, w)).toBe(1);
    expect(stormLevel(0.3, null)).toBe(0);
  });

  it('rises and falls smoothly and never leaves 0 to 1', () => {
    let last = 0;
    let peak = 0;
    for (let t = 0.19; t < 0.41; t += 0.001) {
      const l = stormLevel(t, w);
      expect(l).toBeGreaterThanOrEqual(0);
      expect(l).toBeLessThanOrEqual(1);
      if (t < 0.3) expect(l).toBeGreaterThanOrEqual(last - 1e-9);
      last = l;
      peak = Math.max(peak, l);
    }
    expect(peak).toBe(1);
  });
});

describe('what a storm does', () => {
  it('is nothing at level 0', () => {
    expect(stormSight(0)).toBe(1);
    expect(stormOilMult(0)).toBe(1);
    expect(stormMapRadius(0)).toBe(1);
    expect(stormFogScale(0)).toBe(1);
    expect(stormLabel(0, true)).toBe('');
  });

  it('blinds raiders, burns oil, shrinks the map and the view at full strength', () => {
    expect(stormSight(1)).toBeLessThan(0.5);
    expect(stormSight(1)).toBeGreaterThan(0.2);
    expect(stormOilMult(1)).toBeGreaterThan(2);
    expect(stormMapRadius(1)).toBe(0.5);
    expect(stormFogScale(1)).toBeLessThan(0.2);
  });

  it('names the stage of the storm', () => {
    expect(stormLabel(0.3, true)).toBe('DUST WALL');
    expect(stormLabel(0.3, false)).toBe('DUST CLEARING');
    expect(stormLabel(0.9, false)).toBe('DUST STORM');
  });
});

describe('a storm in a real leg', () => {
  const leg = legById('W');
  function open(day: number) {
    const h = fakeServices();
    h.campaign.day = day;
    const sc = new LegScene(h.svc, leg, { memory: new WorldMemory() });
    return { h, sc };
  }
  const setStorm = (sc: LegScene, w: { start: number; end: number } | null) => {
    (sc as unknown as { stormWin: unknown }).stormWin = w;
  };

  it('builds, is announced once, and clears again', () => {
    const { h, sc } = open(3);
    setStorm(sc, { start: 0.05, end: 0.3 });
    sc.clock.frozen = true;
    sc.clock.elapsed = 0.15 * sc.clock.dayLength;
    run(sc, 6);
    expect(sc.storm).toBeGreaterThan(0.95);
    expect(h.radio.filter((r) => /wall of dust/i.test(r)).length).toBe(1);
    sc.clock.elapsed = 0.5 * sc.clock.dayLength;
    run(sc, 8);
    expect(sc.storm).toBe(0);
    expect(h.radio.filter((r) => /wall of dust/i.test(r)).length).toBe(1);
    expect(h.radio.filter((r) => /settling/i.test(r)).length).toBe(1);
  });

  it('blinds raiders: a gunman 120 m off finds the convoy on a clear day and loses it in a storm', () => {
    const { sc } = open(3);
    const v = sc.players[0].vehicle!;
    const z = v.position.z;
    sc.storm = 0;
    expect(acquire(sc, v.position.x + 120, z, 160)).not.toBeNull();
    sc.storm = 1;
    expect(acquire(sc, v.position.x + 120, z, 160)).toBeNull();
    // Close in, he still sees you.
    expect(acquire(sc, v.position.x + 40, z, 160)).not.toBeNull();
  });

  it('burns oil faster in the dust', () => {
    const burnPerKm = (storm: boolean) => {
      const { sc } = open(3);
      setStorm(sc, storm ? { start: 0.0, end: 0.6 } : null);
      sc.clock.frozen = true;
      sc.clock.elapsed = 0.3 * sc.clock.dayLength;
      run(sc, 6);
      const v = sc.players[0].vehicle!;
      v.health.comp.oil = 1;
      v.setEngine(true);
      const start = v.position.z;
      run(sc, 8, () => {
        v.body.body.setLinvel({ x: 0, y: v.body.body.linvel().y, z: 14 }, true);
      });
      const km = Math.abs(v.position.z - start) / 1000;
      return (1 - v.health.comp.oil) / Math.max(km, 1e-6);
    };
    const clear = burnPerKm(false);
    const dusty = burnPerKm(true);
    expect(clear).toBeGreaterThan(0);
    expect(dusty / clear).toBeGreaterThan(1.8);
    expect(dusty / clear).toBeLessThan(2.4);
  });

  it('never storms at night, whatever the window says', () => {
    const { sc } = open(3);
    setStorm(sc, { start: 0.05, end: 0.3 });
    sc.clock.frozen = true;
    sc.clock.elapsed = 0.8 * sc.clock.dayLength;
    run(sc, 8);
    expect(sc.storm).toBe(0);
  });
});

describe('ground damp', () => {
  it('is fixed by the seed and the day, and always within 0..1', () => {
    for (let day = 1; day < 40; day++) {
      for (let t = 0; t <= 1; t += 0.1) {
        const w = groundDamp(7, day, t);
        expect(w).toBe(groundDamp(7, day, t));
        expect(w).toBeGreaterThanOrEqual(0);
        expect(w).toBeLessThanOrEqual(1);
      }
    }
  });
  it('some mornings start soaked and all of them dry out', () => {
    let wet = 0;
    for (let day = 1; day < 60; day++) {
      const dawn = groundDamp(3, day, 0.04);
      if (dawn > 0.5) wet++;
      expect(groundDamp(3, day, 0.8)).toBe(0);
      expect(groundDamp(3, day, 0.3)).toBeLessThanOrEqual(dawn);
    }
    expect(wet).toBeGreaterThan(5);
    expect(wet).toBeLessThan(35);
  });
});
