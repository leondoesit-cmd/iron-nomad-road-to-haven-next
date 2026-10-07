import { describe, expect, it } from 'vitest';
import { BENCHMARK_CASES, BENCHMARK_SCENARIOS, BenchmarkRun, summarizeBenchmark, type BenchmarkSample } from '../src/game/benchmark';

const frame = (frameMs = 10): BenchmarkSample => ({ frameMs, simulationMs: 2, renderCpuMs: 3, calls: 100, triangles: 1200, steps: 1, droppedSteps: 0 });

describe('opening-screen benchmark', () => {
  it('covers each workload in full screen and both real two-player layouts', () => {
    expect(BENCHMARK_SCENARIOS).toHaveLength(4);
    expect(BENCHMARK_CASES).toHaveLength(12);
    for (const scenario of BENCHMARK_SCENARIOS) {
      expect(BENCHMARK_CASES.filter(c => c.scenario === scenario).map(c => [c.seats, c.layout])).toEqual([
        [1, 'horizontal'], [2, 'horizontal'], [2, 'vertical'],
      ]);
    }
  });

  it('excludes setup and warm-up frames, advances every case, and completes once', () => {
    const run = new BenchmarkRun('quick', { warmupMs: 20, measureMs: 30 });
    for (let i = 0; i < BENCHMARK_CASES.length; i++) {
      expect(run.index).toBe(i);
      run.record(frame(1000)); // Loading must never turn into a measured hitch.
      expect(run.stage).toBe('loading');
      run.loaded();
      run.record(frame(15));
      run.record(frame(15));
      expect(run.stage).toBe('measuring');
      run.record(frame()); run.record(frame()); run.record(frame());
      expect(run.results[i].frames).toBe(3);
      expect(run.results[i].elapsedMs).toBe(30);
      expect(run.results[i].fps).toBe(100);
    }
    expect(run.stage).toBe('complete');
    run.record(frame());
    expect(run.results).toHaveLength(12);
  });

  it('discards interrupted measurements and repeats warm-up while retaining completed cases', () => {
    const run = new BenchmarkRun('quick', { warmupMs: 10, measureMs: 20 });
    run.loaded(); run.record(frame()); run.record(frame(20));
    run.loaded(); run.record(frame()); run.record(frame());
    run.restartCurrent();
    expect(run.index).toBe(1);
    expect(run.results).toHaveLength(1);
    run.record(frame(5000));
    run.loaded(); run.record(frame()); run.record(frame(20));
    expect(run.results[1].frames).toBe(1);
    expect(run.results[1].fps).toBe(50);
  });

  it('uses elapsed time for FPS and includes long frames and catch-up work in the result', () => {
    const samples = Array.from({ length: 100 }, () => frame());
    samples[99] = { ...frame(100), simulationMs: 20, renderCpuMs: 30, steps: 5, droppedSteps: 1 };
    const result = summarizeBenchmark(BENCHMARK_CASES[0], samples);
    expect(result.fps).toBeCloseTo(100000 / 1090);
    expect(result.low1Fps).toBe(10);
    expect(result.p95Ms).toBe(10);
    expect(result.p99Ms).toBe(10);
    expect(result.over33Percent).toBe(1);
    expect(result.over33Frames).toBe(1);
    expect(result.simulationMs).toBeCloseTo(2.18);
    expect(result.renderCpuMs).toBeCloseTo(3.27);
    expect(result.steps).toBe(104);
    expect(result.droppedSteps).toBe(1);
    expect(samples[99].frameMs).toBe(100); // Summary must not reorder callers' samples.
    expect(() => summarizeBenchmark(BENCHMARK_CASES[0], [])).toThrow('No benchmark frames');
  });

  it('ignores invalid timestamps without masking finite frame hitches', () => {
    const run = new BenchmarkRun('quick', { warmupMs: 10, measureMs: 10 });
    run.loaded();
    for (const ms of [NaN, Infinity, -1, 0]) run.record(frame(ms));
    expect(run.elapsed).toBe(0);
    run.record(frame(10)); run.record(frame(1000));
    expect(run.results[0].p95Ms).toBe(1000);
    expect(run.results[0].fps).toBe(1);
  });
});
