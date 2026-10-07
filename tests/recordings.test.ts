import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { RECORDINGS } from '../src/audio/recordings';
import { SampleLibrary } from '../src/audio/samples';
import packedRecordings from '../src/audio/packedRecordings.json';

const packed: Record<string, string> = packedRecordings;

const root = resolve('public/audio');
const credits = JSON.parse(readFileSync(resolve(root, 'sources.json'), 'utf8')) as { file: string; license: string; source: string; sha256: string }[];
afterEach(() => vi.unstubAllGlobals());
describe('commercially reusable recording bank', () => {
  it('ships every cue and ambience recording with a source, permissive license and checksum', () => {
    const soundTypes = readFileSync(resolve('src/audio/audio.ts'), 'utf8').split('export type SoundId =')[1].split(';')[0];
    for (const match of soundTypes.matchAll(/'([^']+)'/g)) {
      expect(RECORDINGS[match[1]], match[1]).toBeDefined();
      expect(new Set(RECORDINGS[match[1]]).size, `${match[1]} variations`).toBeGreaterThanOrEqual(3);
    }
    for (const file of new Set(Object.values(RECORDINGS).flat())) {
      expect(existsSync(resolve(root, file)), file).toBe(true);
      const entry = credits.find(item => item.file === file);
      expect(entry, file).toBeDefined();
      expect(['CC0-1.0', 'CC-BY-4.0']).toContain(entry!.license);
      expect(entry!.source).toMatch(/^https:\/\//);
      expect(createHash('sha256').update(readFileSync(resolve(root, file))).digest('hex')).toBe(entry!.sha256);
    }
  });
  it('fetches and decodes recordings once, bounds concurrent downloads and reports missing files without synthesis', async () => {
    let active = 0; let maximum = 0;
    const fetcher = vi.fn(async (url: string) => {
      active++; maximum = Math.max(maximum, active);
      await Promise.resolve(); active--;
      return { ok: !url.endsWith(packed['pistol0.wav'] ?? 'pistol0.wav'), status: 404, arrayBuffer: async () => new ArrayBuffer(8) };
    });
    vi.stubGlobal('fetch', fetcher);
    const decoded = { duration: 1 } as AudioBuffer;
    const decodeAudioData = vi.fn(async () => decoded);
    const createBuffer = vi.fn();
    const lib = new SampleLibrary({ decodeAudioData, createBuffer } as unknown as AudioContext);
    await Promise.all([lib.init(), lib.init()]);
    expect(fetcher).toHaveBeenCalledTimes(lib.total);
    expect(maximum).toBeLessThanOrEqual(6);
    expect(lib.failures.has('pistol0.wav')).toBe(true);
    expect(lib.loaded).toBe(lib.total - 1);
    expect(lib.get('pistol')).toBe(decoded);
    expect(lib.get('not-a-recording')).toBeNull();
    expect(createBuffer).not.toHaveBeenCalled();
  });
  it('reuses decoded banks during playback and refreshes them as new takes finish loading', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })));
    const lib = new SampleLibrary({ decodeAudioData: async () => ({ duration: 1 }) } as unknown as AudioContext);
    const empty = lib.all('pistol');
    expect(empty).toHaveLength(0);
    await lib.init();
    const bank = lib.all('pistol');
    expect(bank).not.toBe(empty);
    expect(bank).toHaveLength(RECORDINGS.pistol.length);
    for (let i = 0; i < 50; i++) {
      expect(lib.all('pistol')).toBe(bank);
      expect(bank).toContain(lib.get('pistol'));
    }
    expect(lib.all('unknown')).toBe(lib.all('unknown'));
  });
  it('ships smaller Opus derivatives with checksums and the original recording attribution', () => {
    const entries: { file: string; originalFile: string; sha256: string; sourceSha256: string; codec: string; channels: number; duration: number; originalBytes: number; bytes: number }[] = JSON.parse(readFileSync(resolve(root, 'packed/sources.json'), 'utf8'));
    expect(Object.keys(packed).length).toBeGreaterThan(0);
    for (const [original, file] of Object.entries(packed)) {
      const entry = entries.find(e => e.originalFile === original && e.file === file)!;
      expect(entry, original).toBeDefined();
      const credit = credits.find(c => c.file === original)!;
      expect(credit, original).toBeDefined();
      expect(entry.sourceSha256).toBe(credit.sha256);
      expect(entry.codec).toBe('opus');
      expect(entry.channels).toBeGreaterThan(0);
      expect(entry.duration).toBeGreaterThan(0);
      expect(entry.bytes).toBeLessThan(entry.originalBytes);
      expect(createHash('sha256').update(readFileSync(resolve(root, file))).digest('hex')).toBe(entry.sha256);
    }
  });
});
