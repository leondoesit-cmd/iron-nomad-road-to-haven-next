import './helpers/sim';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Game } from '../src/game/game';
import { Campaign } from '../src/game/campaign';
import type { Slot } from '../src/input/input';

afterEach(() => vi.unstubAllGlobals());

function titleGame() {
  vi.stubGlobal('navigator', { userAgent: 'Benchmark test browser' });
  const writeSettings = vi.fn();
  vi.stubGlobal('localStorage', { setItem: writeSettings });
  const slots: [Slot | null, Slot | null] = [{ kind: 'kb', set: 1 }, { kind: 'pad', index: 2 }];
  const campaign = new Campaign();
  const g = Object.assign(Object.create(Game.prototype), {
    phase: 'title', solo: false, benchmark: null, benchmarkReport: null, campaign, slowMo: 0.75,
    R: {
      layout: 'vertical', renderScale: 0.75, quality: 'medium', width: 1280, height: 720, usePost: true,
      renderPixelRatio: () => 1.5,
      gl: { getContext: () => ({ RENDERER: 123, getParameter: () => 'Test renderer' }) },
      setRenderScale(scale: number) { this.renderScale = scale; },
      setLayout(layout: string) { this.layout = layout; },
    },
    input: { slots: [...slots], release: vi.fn() },
    audio: { volume: 0.65, setVolume(v: number) { this.volume = v; }, setMusic: vi.fn() },
    hud: { setVisible: vi.fn() },
    overlays: { showBenchmarkRunning: vi.fn(), showBenchmark: vi.fn() },
    disposeScene: vi.fn(),
    setSolo(solo: boolean) { this.solo = solo; if (solo) this.input.slots[1] = null; },
    toTitle() {
      this.phase = 'title';
      // Rebuilding an attract scene can touch seats. The controller must restore devices afterwards.
      this.input.slots = [null, null];
    },
  }) as Game;
  return { g, campaign, slots, writeSettings };
}

describe('benchmark game flow', () => {
  it('restores both devices, player mode, layout, volume and resolution after cancellation without saving', () => {
    const { g, slots, writeSettings } = titleGame();
    g.startBenchmark('quick');
    expect(g.phase).toBe('benchmark');
    expect(g.R.renderScale).toBe(1);
    expect(g.audio.volume).toBe(0);
    expect(g.slowMo).toBe(1);
    g.setSolo(true); g.R.setLayout('horizontal');
    g.saveSettings(); // Any settings callback during temporary benchmark state must be ignored.
    g.stopBenchmark();
    expect(g.phase).toBe('title');
    expect(g.solo).toBe(false);
    expect(g.input.slots).toEqual(slots);
    expect(g.R.layout).toBe('vertical');
    expect(g.R.renderScale).toBe(0.75);
    expect(g.audio.volume).toBe(0.65);
    expect(g.slowMo).toBe(0.75);
    expect(g.benchmark).toBeNull();
    expect(g.benchmarkReport).toBeNull();
    expect(writeSettings).not.toHaveBeenCalled();
    expect(g.overlays.showBenchmark).toHaveBeenCalledWith('Run cancelled.');
  });

  it('creates a report only after completion and preserves it across an interrupted retry', () => {
    const { g } = titleGame();
    g.startBenchmark();
    g.benchmark!.stage = 'complete';
    g.stopBenchmark();
    const report = g.benchmarkReport;
    expect(report).toMatchObject({ version: 1, duration: 'standard', seed: 4242, width: 1280, height: 720, renderScale: 1 });
    g.startBenchmark();
    g.stopBenchmark('Window size changed.');
    expect(g.benchmarkReport).toBe(report);
    expect(g.overlays.showBenchmark).toHaveBeenLastCalledWith('Window size changed.');
  });

  it('cannot replace a live campaign and ignores repeated start/cancel commands', () => {
    const { g, campaign } = titleGame();
    g.phase = 'leg';
    g.startBenchmark();
    expect(g.benchmark).toBeNull();
    expect(g.campaign).toBe(campaign);
    g.phase = 'title';
    g.startBenchmark();
    const run = g.benchmark;
    g.startBenchmark('quick');
    expect(g.benchmark).toBe(run);
    g.stopBenchmark(); g.stopBenchmark();
    expect(g.overlays.showBenchmark).toHaveBeenCalledTimes(1);
  });
});
