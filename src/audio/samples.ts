import { RECORDINGS } from './recordings';
import { TakeDeck } from './dynamics';
import packedRecordings from './packedRecordings.json';

const packed: Record<string, string> = packedRecordings;

/** Locally bundled, licensed field recordings and foley. No generated fallback buffers. */
export class SampleLibrary {
  mechanicalClicks: AudioBuffer[] = [];
  subBassBody: AudioBuffer[] = [];
  shellCasingBounces: AudioBuffer[] = [];
  indoorImpulse: AudioBuffer | null = null;
  canyonImpulse: AudioBuffer | null = null;
  engineIdle: AudioBuffer | null = null;
  engineMid: AudioBuffer | null = null;
  engineHigh: AudioBuffer | null = null;
  turboSpool: AudioBuffer | null = null;
  turboBov: AudioBuffer | null = null;
  backfirePops: AudioBuffer[] = [];
  chassisCreaks: AudioBuffer[] = [];
  micClickIn: AudioBuffer | null = null;
  micClickOut: AudioBuffer | null = null;
  fleshCrunch: AudioBuffer[] = [];
  readonly failures = new Map<string, string>();
  private buffers = new Map<string, AudioBuffer>();
  private decks = new Map<string, TakeDeck>();
  private banks = new Map<string, AudioBuffer[]>();
  private bankVersion = -1;
  private deckKeys = new Map<string, string>();
  private loading?: Promise<void>;
  loaded = 0;
  total = new Set(Object.values(RECORDINGS).flat()).size;
  constructor(public ctx: AudioContext) {}

  init(): Promise<void> {
    return this.loading ??= this.load();
  }
  private async load() {
    const files = [...new Set(Object.values(RECORDINGS).flat())];
    // Non-browser test hosts need an explicit fetch/decode mock; never manufacture samples.
    if (typeof this.ctx.decodeAudioData !== 'function') return;
    let next = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (next < files.length) {
        const file = files[next++];
        try {
          const response = await fetch(`${import.meta.env.BASE_URL}audio/${packed[file] ?? file}`);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const buffer = await this.ctx.decodeAudioData(await response.arrayBuffer());
          this.buffers.set(file, buffer);
          this.loaded++;
        } catch (error) { this.failures.set(file, String(error)); }
      }
    }));
    this.engineIdle = this.engineMid = this.engineHigh = this.get('engine');
    this.mechanicalClicks = [...this.all('click')];
    this.shellCasingBounces = [...this.all('shell')];
    this.chassisCreaks = [...this.all('chassis')];
    this.micClickIn = this.get('click');
    this.micClickOut = this.get('click');
    this.fleshCrunch = [...this.all('hit')];
  }
  /** Shared, read-only banks. Invalidate as takes arrive so early playback still sees new recordings. */
  all(id: string): readonly AudioBuffer[] {
    if (this.bankVersion !== this.loaded) {
      this.banks.clear();
      this.bankVersion = this.loaded;
    }
    let bank = this.banks.get(id);
    if (!bank) {
      bank = (RECORDINGS[id] ?? []).flatMap(file => { const buffer = this.buffers.get(file); return buffer ? [buffer] : []; });
      this.banks.set(id, bank);
    }
    return bank;
  }
  get(id: string): AudioBuffer | null {
    const buffers = this.all(id);
    if (!buffers.length) return null;
    let deckKey = this.deckKeys.get(id);
    if (deckKey === undefined) {
      deckKey = (RECORDINGS[id] ?? []).join('|');
      this.deckKeys.set(id, deckKey);
    }
    let deck = this.decks.get(deckKey);
    if (!deck) { deck = new TakeDeck(); this.decks.set(deckKey, deck); }
    return buffers[deck.next(buffers.length)];
  }

  play(id: string, dest: AudioNode, time = this.ctx.currentTime, volume = 1, pitch = 1): AudioBufferSourceNode | null {
    const buffer = this.get(id);
    return buffer ? this.playBuffer(buffer, dest, time, volume, pitch) : null;
  }
  playBuffer(buffer: AudioBuffer, dest: AudioNode, time = this.ctx.currentTime, volume = 1, pitch = 1): AudioBufferSourceNode {
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = Math.max(0.65, Math.min(1.5, pitch));
    const gain = this.ctx.createGain();
    gain.gain.value = Math.max(0, Math.min(1.8, volume));
    source.connect(gain).connect(dest);
    source.onended = () => { source.disconnect(); gain.disconnect(); };
    source.start(time);
    return source;
  }
}
