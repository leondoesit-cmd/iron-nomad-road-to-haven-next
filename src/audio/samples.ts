import { RECORDINGS } from './recordings';
import { TakeDeck } from './dynamics';
import packedRecordings from './packedRecordings.json';

const packed: Record<string, string> = packedRecordings;

/**
 * Cues decoded first after the first click: the menus, the car under you, your feet and your gun. Everything else (the
 * long ambience beds, animals, weather, tools) follows in the background, two at a time, and any cue that is asked for
 * before its turn jumps the queue.
 */
const FIRST_CUES = new Set(['click', 'confirm', 'deny', 'pickup', 'loot', 'pill', 'chassis', 'carPanel', 'hotTick', 'exhaustOpen', 'starterFail', 'boostAir',
  'footGrass', 'footStone', 'footSand', 'footWood', 'pistol', 'shotgun', 'mg', 'sniper', 'reload', 'shell', 'shellInsert', 'hit', 'thud', 'crash',
  'tink', 'chip', 'thunk', 'glass', 'ricochet', 'slash', 'swing', 'wind', 'grassWind', 'radio', 'bell', 'horn']);
const FIRST_PREFIXES = ['engine', 'gear', 'tire', 'radiator', 'weapon', 'mag', 'rack', 'rifle'];
export const isFirstCue = (id: string) => FIRST_CUES.has(id) || FIRST_PREFIXES.some((p) => id.startsWith(p));
/** Downloads at once while the first cues load, and in the background after them. */
const FIRST_LANES = 4;
const BACKGROUND_LANES = 2;

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
  /** Files still to fetch and decode, most wanted first. Empty until `init` (the first click) starts the loading. */
  private queue: string[] = [];
  /** Files that load ahead of the background: the first cues, and whatever was asked for before its turn. */
  private urgent = new Set<string>();
  /** Files fetched or decoding right now, and files done with (decoded or failed). */
  private busy = new Set<string>();
  private done = new Set<string>();
  /** Banks asked for while still loading: moved up the queue once each. */
  private wanted = new Set<string>();
  /** Callbacks waiting on a bank, by bank and then by key (one per key: a cue asked for ten times plays once). */
  private waiters = new Map<string, Map<string, () => void>>();
  constructor(public ctx: AudioContext) {}

  /**
   * Start loading (from the first user gesture, with the audio context). Resolves when every recording has loaded or
   * failed; playback starts long before, as each bank arrives.
   */
  init(): Promise<void> {
    return this.loading ??= this.load();
  }
  private async load() {
    // Non-browser test hosts need an explicit fetch/decode mock; never manufacture samples.
    if (typeof this.ctx.decodeAudioData !== 'function') return;
    const files = [...new Set(Object.values(RECORDINGS).flat())];
    for (const [id, takes] of Object.entries(RECORDINGS)) if (isFirstCue(id)) for (const f of takes) this.urgent.add(f);
    // Asked for before the context existed: those go first of all.
    const asked = [...this.wanted].flatMap((id) => RECORDINGS[id] ?? []);
    for (const f of asked) this.urgent.add(f);
    this.queue = [...new Set([...asked, ...files.filter((f) => this.urgent.has(f)), ...files.filter((f) => !this.urgent.has(f))])];
    for (let i = 0; i < FIRST_LANES; i++) this.spawnLane();
    while (this.lanes.size) await Promise.all([...this.lanes]);
  }

  private lanes = new Set<Promise<void>>();
  /** Lanes running, counted as they decide (the set above only empties a microtask later). */
  private active = 0;
  private spawnLane() {
    const p: Promise<void> = this.lane().finally(() => this.lanes.delete(p));
    this.lanes.add(p);
  }

  /** One download lane. Past the background's two, a lane stops once only background files are left. */
  private async lane() {
    this.active++;
    try {
      await this.drain();
    } finally {
      this.active--;
    }
  }

  private async drain() {
    for (;;) {
      const file = this.queue[0];
      if (file === undefined) return;
      const urgent = this.urgent.has(file);
      if (!urgent && this.active > BACKGROUND_LANES) return;
      this.queue.shift();
      if (this.done.has(file) || this.busy.has(file)) continue;
      this.busy.add(file);
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}audio/${packed[file] ?? file}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = await this.ctx.decodeAudioData(await response.arrayBuffer());
        this.buffers.set(file, buffer);
        this.loaded++;
      } catch (error) { this.failures.set(file, String(error)); }
      this.busy.delete(file);
      this.done.add(file);
      this.arrived();
      // The background yields between files, so decoding never comes in one burst.
      if (!urgent) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  /** A file finished: refresh the shared shortcuts and run whoever was waiting on a bank that now has a take. */
  private arrived() {
    this.engineIdle = this.engineMid = this.engineHigh = this.all('engine')[0] ?? null;
    this.mechanicalClicks = [...this.all('click')];
    this.shellCasingBounces = [...this.all('shell')];
    this.chassisCreaks = [...this.all('chassis')];
    this.micClickIn = this.micClickOut = this.all('click')[0] ?? null;
    this.fleshCrunch = [...this.all('hit')];
    if (!this.waiters.size) return;
    for (const [id, waiting] of this.waiters) {
      const ready = this.all(id).length > 0;
      if (!ready && !(RECORDINGS[id] ?? []).every((f) => this.done.has(f))) continue;
      this.waiters.delete(id);
      if (ready) for (const run of waiting.values()) run();
    }
  }

  /** Move a bank's files to the front of the queue (once per bank). Before `init` it is remembered for the start. */
  request(id: string) {
    if (this.wanted.has(id)) return;
    this.wanted.add(id);
    if (!this.loading) return;
    const files = (RECORDINGS[id] ?? []).filter((f) => !this.done.has(f) && !this.busy.has(f));
    if (!files.length) return;
    for (const f of files) this.urgent.add(f);
    this.queue = [...files, ...this.queue.filter((f) => !files.includes(f))];
    // The extra lanes stop at the background: open one for this if there is room.
    if (this.active < FIRST_LANES) this.spawnLane();
  }

  /** Whether a bank has at least one take decoded. */
  ready(id: string): boolean {
    return this.all(id).length > 0;
  }

  /**
   * Run `run` as soon as a bank has a take (now, if it has one), asking for it to load first. A later call with the same
   * key replaces an earlier one still waiting, so a cue repeated while it loads plays once, not in a burst.
   */
  whenReady(id: string, key: string, run: () => void) {
    if (this.ready(id)) return run();
    if (!(RECORDINGS[id] ?? []).length) return;
    let waiting = this.waiters.get(id);
    if (!waiting) this.waiters.set(id, (waiting = new Map()));
    waiting.set(key, run);
    this.request(id);
  }
  /** Shared, read-only banks. Invalidate as takes arrive so early playback still sees new recordings. */
  all(id: string): readonly AudioBuffer[] {
    if (this.bankVersion !== this.loaded) {
      this.banks.clear();
      this.bankVersion = this.loaded;
    }
    let bank = this.banks.get(id);
    if (!bank) {
      const takes = RECORDINGS[id] ?? [];
      bank = takes.flatMap(file => { const buffer = this.buffers.get(file); return buffer ? [buffer] : []; });
      this.banks.set(id, bank);
      // Asked for while some of its takes are still to come: they load next.
      if (bank.length < takes.length && this.loading && !this.wanted.has(id)) this.request(id);
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
