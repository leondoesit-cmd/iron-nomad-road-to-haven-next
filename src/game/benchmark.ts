import type { QualityPreset, SplitLayout } from '../render/renderer';

export const BENCHMARK_SCENARIOS = [
  { id: 'road', name: 'Desert driving', leg: 'L1', speed: 17, night: false, effects: false },
  { id: 'country', name: 'Open-country streaming', leg: 'W', speed: 22, night: false, effects: false },
  { id: 'city', name: 'Dense city streets', leg: 'L3P', speed: 10, night: false, effects: false },
  { id: 'effects', name: 'Night crowds & effects', leg: 'L2C', speed: 0, night: true, effects: true },
] as const;
export type BenchmarkScenario = (typeof BENCHMARK_SCENARIOS)[number];
export interface BenchmarkCase { scenario: BenchmarkScenario; seats: 1 | 2; layout: SplitLayout; name: string }
export const BENCHMARK_CASES: BenchmarkCase[] = BENCHMARK_SCENARIOS.flatMap(scenario => [
  { scenario, seats: 1, layout: 'horizontal', name: 'Single screen' },
  { scenario, seats: 2, layout: 'horizontal', name: 'Split · top / bottom' },
  { scenario, seats: 2, layout: 'vertical', name: 'Split · left / right' },
] as BenchmarkCase[]);

export interface BenchmarkSample {
  frameMs: number; simulationMs: number; renderCpuMs: number;
  calls: number; triangles: number; steps: number; droppedSteps: number;
}
export interface BenchmarkResult {
  scenario: string; mode: string; frames: number; elapsedMs: number;
  fps: number; low1Fps: number; p95Ms: number; p99Ms: number;
  simulationMs: number; renderCpuMs: number; calls: number; triangles: number;
  over33Frames: number; over33Percent: number; steps: number; droppedSteps: number;
}
export interface BenchmarkReport {
  version: 1; createdAt: string; duration: 'quick' | 'standard'; seed: number;
  quality: QualityPreset; width: number; height: number; pixelRatio: number;
  renderScale: number; post: boolean; browser: string; renderer: string;
  warmupMs: number; measureMs: number; results: BenchmarkResult[];
}

function mean(xs: number[]) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
export function summarizeBenchmark(test: BenchmarkCase, samples: BenchmarkSample[]): BenchmarkResult {
  if (!samples.length) throw new Error('No benchmark frames were measured');
  const times = samples.map(s => s.frameMs).sort((a, b) => a - b);
  const percentile = (p: number) => times[Math.max(0, Math.ceil(times.length * p) - 1)];
  const over33Frames = times.filter(t => t > 1000 / 30).length;
  return {
    scenario: test.scenario.name, mode: test.name, frames: samples.length,
    elapsedMs: times.reduce((a, b) => a + b, 0), fps: 1000 / mean(times),
    low1Fps: 1000 / mean(times.slice(-Math.max(1, Math.ceil(times.length * 0.01)))),
    p95Ms: percentile(0.95), p99Ms: percentile(0.99),
    simulationMs: mean(samples.map(s => s.simulationMs)), renderCpuMs: mean(samples.map(s => s.renderCpuMs)),
    calls: mean(samples.map(s => s.calls)), triangles: mean(samples.map(s => s.triangles)),
    over33Frames, over33Percent: 100 * over33Frames / times.length,
    steps: samples.reduce((n, s) => n + s.steps, 0), droppedSteps: samples.reduce((n, s) => n + s.droppedSteps, 0),
  };
}

/** One completed browser frame at a time. Loading and warm-up never enter the results. */
export class BenchmarkRun {
  index = 0;
  stage: 'loading' | 'warming' | 'measuring' | 'complete' = 'loading';
  elapsed = 0;
  results: BenchmarkResult[] = [];
  private samples: BenchmarkSample[] = [];
  readonly warmupMs: number;
  readonly measureMs: number;
  constructor(public duration: 'quick' | 'standard' = 'standard', timing?: { warmupMs: number; measureMs: number }) {
    this.warmupMs = timing?.warmupMs ?? (duration === 'quick' ? 1000 : 3000);
    this.measureMs = timing?.measureMs ?? (duration === 'quick' ? 3000 : 8000);
  }
  get current() { return BENCHMARK_CASES[this.index]; }
  loaded() { this.stage = 'warming'; this.elapsed = 0; this.samples = []; }
  /** A visibility, resize or context interruption invalidates only the current case. */
  restartCurrent() { this.stage = 'loading'; this.elapsed = 0; this.samples = []; }
  record(sample: BenchmarkSample) {
    if (this.stage === 'loading' || this.stage === 'complete') return;
    if (!Number.isFinite(sample.frameMs) || sample.frameMs <= 0) return;
    this.elapsed += sample.frameMs;
    if (this.stage === 'warming') {
      if (this.elapsed >= this.warmupMs) { this.stage = 'measuring'; this.elapsed = 0; }
      return;
    }
    this.samples.push(sample);
    if (this.elapsed < this.measureMs) return;
    this.results.push(summarizeBenchmark(this.current, this.samples));
    this.index++;
    this.stage = this.index === BENCHMARK_CASES.length ? 'complete' : 'loading';
    this.elapsed = 0;
    this.samples = [];
  }
}
