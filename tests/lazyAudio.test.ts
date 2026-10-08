import { afterEach, describe, expect, it, vi } from 'vitest';
import { RECORDINGS } from '../src/audio/recordings';
import { SampleLibrary, isFirstCue } from '../src/audio/samples';
import { AudioEngine } from '../src/audio/audio';
import packedRecordings from '../src/audio/packedRecordings.json';

// Recordings load by priority (`audio/samples.ts`): the cues of the first seconds first, the rest in the background, and a
// cue asked for early jumps the queue and still plays.

const packed: Record<string, string> = packedRecordings;
const urlOf = (file: string) => `/audio/${packed[file] ?? file}`;
afterEach(() => vi.unstubAllGlobals());

/** A fetch that answers only when told to, so a test can look at the queue between files. */
function gatedFetch() {
  const order: string[] = [];
  const pending: (() => void)[] = [];
  let active = 0;
  let most = 0;
  const fetcher = vi.fn((url: string) => {
    order.push(url);
    active++;
    most = Math.max(most, active);
    return new Promise((resolve) => {
      pending.push(() => {
        active--;
        resolve({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) });
      });
    });
  });
  /** Let `n` waiting downloads finish, then let their decodes and the lanes move on. */
  const release = async (n = 1) => {
    for (let i = 0; i < n; i++) pending.shift()?.();
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  };
  return { fetcher, order, release, pending, most: () => most };
}

const library = () => new SampleLibrary({ decodeAudioData: async () => ({ duration: 1 }) } as unknown as AudioContext);
const fileOf = (id: string) => RECORDINGS[id][0];

describe('prioritised recordings', () => {
  it('loads the cues of the first seconds before the ambience, four at a time, then two in the background', async () => {
    const g = gatedFetch();
    vi.stubGlobal('fetch', g.fetcher);
    const lib = library();
    const all = lib.init();
    await g.release(0);
    expect(g.pending.length).toBe(4);
    // Menu clicks and the engine are among the first; the crickets are not.
    const firstUrls = g.order.slice(0, 4);
    expect(firstUrls.some((u) => u.includes('crickets'))).toBe(false);
    let guard = 0;
    while (g.pending.length && guard++ < 2000) await g.release(1);
    await all;
    expect(lib.loaded).toBe(lib.total);
    expect(g.most()).toBeLessThanOrEqual(4);
    const at = (file: string) => g.order.indexOf(urlOf(file));
    expect(at(fileOf('click'))).toBeLessThan(at(fileOf('crickets')));
    expect(at(fileOf('engine'))).toBeLessThan(at(fileOf('frogs')));
  });

  it('never runs more than two downloads at once once only the background is left', async () => {
    const g = gatedFetch();
    vi.stubGlobal('fetch', g.fetcher);
    const lib = library();
    const all = lib.init();
    const first = new Set(Object.entries(RECORDINGS).filter(([id]) => isFirstCue(id)).flatMap(([, f]) => f));
    const background = lib.total - first.size;
    expect(background).toBeGreaterThan(40);
    let guard = 0;
    while (g.order.length < first.size + 20 && guard++ < 2000) await g.release(1);
    // Deep in the background now: two lanes.
    await g.release(0);
    expect(g.pending.length).toBeLessThanOrEqual(2);
    while (g.pending.length && guard++ < 4000) await g.release(1);
    await all;
  });

  it('puts a cue asked for before its turn at the front, and runs its waiter once when it lands', async () => {
    const g = gatedFetch();
    vi.stubGlobal('fetch', g.fetcher);
    const lib = library();
    const ran: string[] = [];
    const all = lib.init();
    await g.release(2);
    // The crickets are the last thing the queue would get to; asked for three times, they play once.
    for (let i = 0; i < 3; i++) lib.whenReady('crickets', 'night', () => ran.push('crickets'));
    expect(lib.ready('crickets')).toBe(false);
    let guard = 0;
    while (!lib.ready('crickets') && guard++ < 50) await g.release(1);
    expect(guard).toBeLessThan(12);
    expect(ran).toEqual(['crickets']);
    // Ready now: a waiter runs straight away.
    lib.whenReady('crickets', 'again', () => ran.push('now'));
    expect(ran).toEqual(['crickets', 'now']);
    while (g.pending.length && guard++ < 4000) await g.release(1);
    await all;
  });

  it('remembers what was asked for before the first click and loads it first', async () => {
    const g = gatedFetch();
    vi.stubGlobal('fetch', g.fetcher);
    const lib = library();
    let played = 0;
    lib.whenReady('frogs', 'pond', () => played++);
    const all = lib.init();
    await g.release(0);
    expect(g.order[0]).toBe(urlOf(fileOf('frogs')));
    let guard = 0;
    while (g.pending.length && guard++ < 4000) await g.release(1);
    await all;
    expect(played).toBe(1);
  });

  it('plays a cue asked for while its recording loads, once it lands, but drops it if it would come too late', async () => {
    const g = gatedFetch();
    vi.stubGlobal('fetch', g.fetcher);
    const lib = library();
    const engine = new AudioEngine();
    const ctx = { currentTime: 0 };
    Object.assign(engine, { ctx, samples: lib, muted: false });
    const voice = vi.fn();
    (engine as unknown as { voice: typeof voice }).voice = voice;
    void lib.init();
    await g.release(0);
    engine.play('owl');
    engine.play('owl');
    expect(voice).not.toHaveBeenCalled();
    let guard = 0;
    while (!lib.ready('owl') && guard++ < 50) await g.release(1);
    expect(voice).toHaveBeenCalledTimes(1);
    expect(voice.mock.calls[0][0]).toBe('owl');
    // Too late: a positional shot asked for long before its take arrives stays silent.
    engine.play('caw', 10, 10);
    ctx.currentTime = 5;
    while (!lib.ready('caw') && guard++ < 400) await g.release(1);
    expect(voice).toHaveBeenCalledTimes(1);
    while (g.pending.length && guard++ < 4000) await g.release(1);
  });
});
