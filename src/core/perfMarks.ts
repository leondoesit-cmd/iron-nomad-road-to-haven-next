/**
 * Load and responsiveness timings: thin wrappers over `performance.mark` / `performance.measure`, a log of the main
 * thread's long tasks, frame-time windows after a mark (the first seconds of play), and menu open latencies.
 *
 * Cheap enough to stay on in a release build: a mark is a map write, a frame is a few compares. Read it from the console
 * as `__perf.report()` (also `__perf.table()`); `?perf` in the URL adds forced layouts after menu changes so their style
 * and layout cost is counted too, and prints the boot summary once the title is ready.
 */

export interface PerfSpan {
  name: string;
  /** Milliseconds since the page started (`performance.now()` at the span's start). */
  at: number;
  ms: number;
}

export interface FrameWindow {
  name: string;
  /** Seconds of frames to collect, counted in rendered frame time. */
  seconds: number;
  elapsed: number;
  frames: number;
  worst: number;
  /** Frames slower than 33 ms (a missed 30 fps frame), 50 ms, and 100 ms (a visible hitch). */
  over33: number;
  over50: number;
  over100: number;
  /** Sum of frame times over 16.7 ms, beyond the 16.7: the time the player saw as stutter. */
  jank: number;
  done: boolean;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const SPAN_CAP = 400;

export class PerfMarks {
  /** First time each mark was reached, in ms since the page started. */
  readonly marks = new Map<string, number>();
  readonly spans: PerfSpan[] = [];
  /** Main-thread tasks over 50 ms (Chromium only), with the last mark before each, so a hitch can be put to a phase. */
  readonly longTasks: { at: number; ms: number; after: string }[] = [];
  readonly windows: FrameWindow[] = [];
  /** `?perf`: force a layout after a menu change so the latency includes style and layout, and log the boot summary. */
  readonly detail: boolean;
  private last = 'start';
  private menus: { name: string; t0: number }[] = [];
  private open: Map<string, number> = new Map();

  constructor() {
    this.detail = typeof location !== 'undefined' && new URLSearchParams(location.search).has('perf');
    if (typeof PerformanceObserver === 'undefined') return;
    try {
      if (!PerformanceObserver.supportedEntryTypes?.includes('longtask')) return;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (this.longTasks.length >= SPAN_CAP) this.longTasks.shift();
          this.longTasks.push({ at: Math.round(e.startTime), ms: Math.round(e.duration), after: this.last });
        }
      }).observe({ type: 'longtask', buffered: true });
    } catch {
      /* not supported */
    }
  }

  /** Note that a point was reached. Only the first time counts for `marks`; every time moves the long-task label. */
  mark(name: string): number {
    const t = now();
    if (!this.marks.has(name)) {
      this.marks.set(name, t);
      try {
        performance.mark(name);
      } catch {
        /* no user timing here */
      }
    }
    this.last = name;
    return t;
  }

  /** Record a span from a mark (or a time) to now (or `to`). Returns its length in ms. */
  measure(name: string, from: string | number, to = now()): number {
    const t0 = typeof from === 'number' ? from : (this.marks.get(from) ?? 0);
    const ms = to - t0;
    if (this.spans.length >= SPAN_CAP) this.spans.shift();
    this.spans.push({ name, at: t0, ms });
    try {
      performance.measure(name, { start: t0, end: to });
    } catch {
      /* no user timing here */
    }
    return ms;
  }

  /** Time a synchronous piece of work as a span. */
  time<T>(name: string, fn: () => T): T {
    const t0 = now();
    this.last = name;
    try {
      return fn();
    } finally {
      this.measure(name, t0);
    }
  }

  /** Open a span to be closed later with `end` (one per name at a time). */
  begin(name: string) {
    this.open.set(name, now());
    this.last = name;
  }

  end(name: string): number {
    const t0 = this.open.get(name);
    if (t0 === undefined) return 0;
    this.open.delete(name);
    return this.measure(name, t0);
  }

  /** Collect frame times for the next `seconds` of frames under `name` (replaces an unfinished window of that name). */
  watchFrames(name: string, seconds: number) {
    const i = this.windows.findIndex((w) => w.name === name && !w.done);
    if (i >= 0) this.windows.splice(i, 1);
    if (this.windows.length >= 40) this.windows.shift();
    this.windows.push({ name, seconds, elapsed: 0, frames: 0, worst: 0, over33: 0, over50: 0, over100: 0, jank: 0, done: false });
  }

  /** A menu, screen or overlay was asked for: its latency runs until the end of the next rendered frame. */
  menu(name: string) {
    this.menus.push({ name, t0: now() });
    this.last = `menu:${name}`;
  }

  /** Called once per rendered frame, after the draw, with the frame's wall time. Allocation-free when nothing is open. */
  frame(ms: number) {
    if (this.menus.length) {
      // `?perf` forces style and layout now, so their cost lands in the number instead of after it.
      if (this.detail && typeof document !== 'undefined') void document.body?.offsetHeight;
      const t = now();
      for (const m of this.menus) this.measure(`menu:${m.name}`, m.t0, t);
      this.menus.length = 0;
    }
    for (let i = 0; i < this.windows.length; i++) {
      const w = this.windows[i];
      if (w.done) continue;
      w.frames++;
      w.elapsed += ms / 1000;
      if (ms > w.worst) w.worst = ms;
      if (ms > 33.4) w.over33++;
      if (ms > 50) w.over50++;
      if (ms > 100) w.over100++;
      if (ms > 16.7) w.jank += ms - 16.7;
      if (w.elapsed >= w.seconds) w.done = true;
    }
  }

  /** Everything so far, rounded, for the console or a test. */
  report() {
    const r = (v: number) => Math.round(v * 10) / 10;
    const byName = new Map<string, { n: number; total: number; worst: number; last: number }>();
    for (const s of this.spans) {
      const e = byName.get(s.name) ?? { n: 0, total: 0, worst: 0, last: 0 };
      e.n++;
      e.total += s.ms;
      e.worst = Math.max(e.worst, s.ms);
      e.last = s.ms;
      byName.set(s.name, e);
    }
    return {
      marks: Object.fromEntries([...this.marks].map(([k, v]) => [k, Math.round(v)])),
      spans: Object.fromEntries([...byName].map(([k, e]) => [k, { n: e.n, avg: r(e.total / e.n), worst: r(e.worst), last: r(e.last) }])),
      longTasks: [...this.longTasks].sort((a, b) => b.ms - a.ms).slice(0, 15),
      frames: this.windows.map((w) => ({ name: w.name, frames: w.frames, seconds: r(w.elapsed), worst: r(w.worst), over33: w.over33, over50: w.over50, over100: w.over100, jankMs: Math.round(w.jank), done: w.done })),
    };
  }

  /** The spans as a console table. */
  table() {
    const rep = this.report();
    console.table(rep.marks);
    console.table(rep.spans);
    console.table(rep.longTasks);
    console.table(rep.frames);
    return rep;
  }
}

/** The page's one set of marks. */
export const perf = new PerfMarks();

declare global {
  interface Window {
    __perf?: PerfMarks;
  }
}
if (typeof window !== 'undefined') window.__perf = perf;
