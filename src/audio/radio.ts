import { clamp } from '../core/math';
import type { SampleLibrary } from './samples';

/**
 * Checks whether the browser's built-in Web Speech API (speechSynthesis)
 * is available in the current environment.
 */
export function isBrowserTtsSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    Boolean(window.speechSynthesis) &&
    typeof (window as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance !== 'undefined' &&
    typeof window.speechSynthesis.speak === 'function'
  );
}

/**
 * Normalizes game text strings for speech synthesis:
 * - Expands (-40 Scrap) to "minus 40 Scrap"
 * - Expands (+10 Fuel) to "plus 10 Fuel"
 * - Cleans typographical quotes and formatting marks
 */
export function cleanTextForSpeech(raw: string): string {
  return raw
    .replace(/\(-(\d+)\s*([^)]*)\)/gi, 'minus $1 $2')
    .replace(/\(\+(\d+)\s*([^)]*)\)/gi, 'plus $1 $2')
    .replace(/[«»"“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Procedural Voice Barks & Walkie-Talkie Radio Chatter Engine.
 * Features:
 * - Built-in browser Text-To-Speech (Web Speech API) integration for authentic spoken dialogue
 * - Authentic walkie-talkie bandpass filtering (420Hz HP - 2900Hz LP, 1.8kHz presence peak)
 * - Analog transistor diode saturation (WaveShaper)
 * - Heavy RF dynamics compression (12:1, fast attack)
 * - Tactical PTT mic clicks, CTCSS chirps, Roger beeps, and squelch tail static bursts
 * - Procedural formant-synthesized voice chatter fallback when TTS is unavailable or disabled
 */
export class RadioAudioEngine {
  ctx: AudioContext;
  samples: SampleLibrary;
  ttsEnabled = true;
  masterVolume = 1;
  private noiseBuf: AudioBuffer;
  private voices: SpeechSynthesisVoice[] = [];
  private voicesLoaded = false;
  private activeUtterances = new Set<SpeechSynthesisUtterance>();
  private activeChains = new Set<{
    carrierStatic: AudioBufferSourceNode;
    output: GainNode;
  }>();

  constructor(ctx: AudioContext, samples: SampleLibrary) {
    this.ctx = ctx;
    this.samples = samples;
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    this.initVoices();
  }

  setTtsEnabled(enabled: boolean) {
    this.ttsEnabled = enabled;
    if (!enabled) this.stop();
  }

  setVolume(vol: number) {
    this.masterVolume = clamp(vol, 0, 1);
    if (this.masterVolume <= 0) this.stop();
  }

  /**
   * Immediately stops any active TTS utterances and active radio carrier hiss.
   */
  stop() {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        /* ignore */
      }
    }
    this.activeUtterances.clear();
    for (const chain of this.activeChains) {
      try {
        chain.output.gain.setValueAtTime(0.0001, this.ctx.currentTime);
        chain.carrierStatic.stop(this.ctx.currentTime);
      } catch {
        /* ignore */
      }
    }
    this.activeChains.clear();
  }

  private initVoices() {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const load = () => {
      try {
        const v = window.speechSynthesis.getVoices();
        if (v && v.length > 0) {
          this.voices = v;
          this.voicesLoaded = true;
        }
      } catch {
        /* ignore */
      }
    };
    load();
    if (typeof window.speechSynthesis.addEventListener === 'function') {
      window.speechSynthesis.addEventListener('voiceschanged', load);
    } else if ('onvoiceschanged' in window.speechSynthesis) {
      (window.speechSynthesis as unknown as { onvoiceschanged: () => void }).onvoiceschanged = load;
    }
  }

  private pickVoice(): SpeechSynthesisVoice | null {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
    if (!this.voicesLoaded || this.voices.length === 0) {
      try {
        this.voices = window.speechSynthesis.getVoices() || [];
        if (this.voices.length > 0) this.voicesLoaded = true;
      } catch {
        /* ignore */
      }
    }
    if (this.voices.length === 0) return null;

    // Filter English voices
    const en = this.voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith('en'));
    const pool = en.length > 0 ? en : this.voices;

    // Prefer clear tactical/dispatcher voices
    const match = pool.find((v) => /guy|david|daniel|mark|george|alex|male|natural/i.test(v.name));
    if (match) return match;

    const def = pool.find((v) => v.default);
    return def || pool[0] || null;
  }

  /** Builds the authentic walkie-talkie / CB radio DSP filter chain. */
  createRadioChain(dest: AudioNode): {
    input: GainNode;
    output: GainNode;
    carrierStatic: AudioBufferSourceNode;
  } {
    const ctx = this.ctx;
    const input = ctx.createGain();
    const output = ctx.createGain();

    // 1. Walkie-talkie highpass: strips off chest bass and rumble below 420 Hz
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 420;
    hp.Q.value = 0.9;

    // 2. Presence peak: boosts 1800 Hz speech intelligibility (+4.5 dB)
    const peak = ctx.createBiquadFilter();
    peak.type = 'peaking';
    peak.frequency.value = 1800;
    peak.gain.value = 4.5;
    peak.Q.value = 1.3;

    // 3. Steep lowpass: strips everything above 2900 Hz for classic carbon mic bandwidth
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2900;
    lp.Q.value = 1.2;

    // 4. Overdrive wave shaper: analog diode saturation
    const shaper = ctx.createWaveShaper();
    const n = 256;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * 1.8);
    }
    shaper.curve = curve;
    shaper.oversample = '2x';

    // 5. Tactical RF Dynamics Compressor: smashes dynamic range
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -24;
    comp.knee.value = 4;
    comp.ratio.value = 12;
    comp.attack.value = 0.003;
    comp.release.value = 0.045;

    // 6. Low-level RF carrier hiss
    const carrier = ctx.createBufferSource();
    carrier.buffer = this.noiseBuf;
    carrier.loop = true;
    const carrierFilt = ctx.createBiquadFilter();
    carrierFilt.type = 'bandpass';
    carrierFilt.frequency.value = 1600;
    carrierFilt.Q.value = 1.0;
    const carrierGain = ctx.createGain();
    carrierGain.gain.value = 0.028;

    carrier.connect(carrierFilt).connect(carrierGain).connect(comp);

    // Chain wiring: input -> hp -> peak -> lp -> shaper -> comp -> output -> dest
    input.connect(hp);
    hp.connect(peak);
    peak.connect(lp);
    lp.connect(shaper);
    shaper.connect(comp);
    comp.connect(output);
    output.connect(dest);

    return { input, output, carrierStatic: carrier };
  }

  /**
   * Plays a contextual radio bark with authentic PTT key-in,
   * built-in browser speech synthesis (or procedural fallback), compression, and squelch tail.
   */
  playRadioChatter(text: string, dest: AudioNode, vol = 1): number {
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const chain = this.createRadioChain(dest);
    chain.output.gain.setValueAtTime(vol * 0.9, t0);

    // Start RF carrier
    chain.carrierStatic.start(t0);
    const chainRef = { carrierStatic: chain.carrierStatic, output: chain.output };
    this.activeChains.add(chainRef);

    // 1. PTT Mic Click-In (Tactical switch + squelch chirp)
    if (this.samples.micClickIn) {
      const pttIn = ctx.createBufferSource();
      pttIn.buffer = this.samples.micClickIn;
      const g = ctx.createGain();
      g.gain.value = 0.85;
      pttIn.connect(g).connect(chain.input);
      pttIn.start(t0);
    }

    const words = text.split(/\s+/).filter((w) => w.length > 0);
    const isUrgent = text.includes('!') || /horde|seiz|run|wall|strike|ambush/i.test(text);

    if (this.ttsEnabled && isBrowserTtsSupported()) {
      return this.speakWithBrowserTts(text, chain, chainRef, t0, vol, words, isUrgent);
    } else {
      return this.playProceduralChatter(text, chain, chainRef, t0, vol, words, isUrgent);
    }
  }

  /** Built-in browser TTS speech synthesis with authentic radio squelch framing. */
  private speakWithBrowserTts(
    text: string,
    chain: { input: GainNode; output: GainNode; carrierStatic: AudioBufferSourceNode },
    chainRef: { carrierStatic: AudioBufferSourceNode; output: GainNode },
    t0: number,
    vol: number,
    words: string[],
    isUrgent: boolean,
  ): number {
    const ctx = this.ctx;
    const cleanText = cleanTextForSpeech(text);
    const speechSec = Math.max(0.8, words.length * 0.32);
    const totalEstDur = speechSec + 0.35;

    // Stop previous utterance
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
    this.activeUtterances.clear();

    const UtteranceClass =
      (typeof window !== 'undefined' && (window as unknown as { SpeechSynthesisUtterance?: new (text: string) => SpeechSynthesisUtterance }).SpeechSynthesisUtterance) ||
      (typeof globalThis !== 'undefined' && (globalThis as unknown as { SpeechSynthesisUtterance?: new (text: string) => SpeechSynthesisUtterance }).SpeechSynthesisUtterance);
    if (!UtteranceClass) return 0;

    const utter = new UtteranceClass(cleanText);
    const voice = this.pickVoice();
    if (voice) utter.voice = voice;

    utter.rate = isUrgent ? 1.12 : 1.05;
    utter.pitch = isUrgent ? 1.06 : /mechanic/i.test(text) ? 0.92 : 0.98;
    utter.volume = clamp(vol * this.masterVolume, 0, 1);

    let ended = false;
    let safetyTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      if (ended) return;
      ended = true;
      if (safetyTimer) {
        clearTimeout(safetyTimer);
        safetyTimer = null;
      }
      this.activeUtterances.delete(utter);
      this.activeChains.delete(chainRef);

      const tailStart = ctx.currentTime + 0.04;
      if (this.samples.micClickOut) {
        const pttOut = ctx.createBufferSource();
        pttOut.buffer = this.samples.micClickOut;
        const g = ctx.createGain();
        g.gain.value = 0.9;
        pttOut.connect(g).connect(chain.input);
        pttOut.start(tailStart);
      }

      const tailDur = 0.16;
      chain.output.gain.setValueAtTime(vol * 0.9, tailStart + tailDur - 0.04);
      chain.output.gain.linearRampToValueAtTime(0.0001, tailStart + tailDur);
      try {
        chain.carrierStatic.stop(tailStart + tailDur);
      } catch {
        /* already stopped */
      }
    };

    utter.onend = () => finish();
    utter.onerror = () => finish();

    // Prevent Chromium garbage-collection bug
    this.activeUtterances.add(utter);

    // Speak after brief 60ms delay so mic click-in begins first
    setTimeout(() => {
      if (ended) return;
      try {
        window.speechSynthesis.speak(utter);
      } catch {
        finish();
      }
    }, 60);

    // Safety timeout in case browser drops onend
    safetyTimer = setTimeout(() => {
      finish();
    }, Math.max(3000, (speechSec + 2.5) * 1000));

    return totalEstDur;
  }

  /** Procedural formant-synthesized voice chatter syllables matching text cadence. */
  private playProceduralChatter(
    _text: string,
    chain: { input: GainNode; output: GainNode; carrierStatic: AudioBufferSourceNode },
    chainRef: { carrierStatic: AudioBufferSourceNode; output: GainNode },
    t0: number,
    vol: number,
    words: string[],
    isUrgent: boolean,
  ): number {
    const ctx = this.ctx;
    const speechStart = t0 + 0.06;
    let curTime = speechStart;

    const baseF0 = isUrgent ? 135 : 110;
    const formants: Record<string, [number, number, number]> = {
      a: [730, 1250, 2450],
      e: [530, 1840, 2550],
      i: [320, 2250, 2800],
      o: [500, 950, 2400],
      u: [350, 900, 2300],
    };

    for (let wIdx = 0; wIdx < words.length; wIdx++) {
      const word = words[wIdx].toLowerCase().replace(/[^a-z]/g, '');
      if (!word) continue;

      const syllables = word.match(/[^aeiouy]*[aeiouy]+(?:[^aeiouy]*$|[^aeiouy](?=[^aeiouy]))?/gi) || [word];

      for (let sIdx = 0; sIdx < syllables.length; sIdx++) {
        const syl = syllables[sIdx];
        const sylDur = clamp(0.09 + syl.length * 0.025, 0.08, 0.2);

        const vowelMatch = syl.match(/[aeiou]/);
        const vKey = vowelMatch ? vowelMatch[0] : 'a';
        const [f1, f2, f3] = formants[vKey] || formants.a;

        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        const inflection = isUrgent ? Math.sin((sIdx / Math.max(1, syllables.length)) * Math.PI) * 20 : 0;
        osc.frequency.setValueAtTime(baseF0 + inflection, curTime);
        osc.frequency.linearRampToValueAtTime(baseF0 * 0.9 + inflection, curTime + sylDur);

        const gSyl = ctx.createGain();
        gSyl.gain.setValueAtTime(0.0001, curTime);
        gSyl.gain.linearRampToValueAtTime(0.35, curTime + 0.012);
        gSyl.gain.exponentialRampToValueAtTime(0.0001, curTime + sylDur);

        for (const f of [f1, f2, f3]) {
          const filt = ctx.createBiquadFilter();
          filt.type = 'bandpass';
          filt.frequency.value = f;
          filt.Q.value = 4.2;
          osc.connect(filt).connect(gSyl);
        }

        if (/[stkpfch]/i.test(syl)) {
          const noiseSrc = ctx.createBufferSource();
          noiseSrc.buffer = this.noiseBuf;
          const nFilt = ctx.createBiquadFilter();
          nFilt.type = 'bandpass';
          nFilt.frequency.value = 2400;
          nFilt.Q.value = 2.0;
          const nGain = ctx.createGain();
          nGain.gain.setValueAtTime(0.12, curTime);
          nGain.gain.exponentialRampToValueAtTime(0.0001, curTime + 0.04);
          noiseSrc.connect(nFilt).connect(nGain).connect(gSyl);
          noiseSrc.start(curTime);
          noiseSrc.stop(curTime + 0.05);
        }

        gSyl.connect(chain.input);
        osc.start(curTime);
        osc.stop(curTime + sylDur + 0.02);

        curTime += sylDur + 0.015;
      }
      curTime += 0.04;
    }

    const tailStart = curTime + 0.05;
    if (this.samples.micClickOut) {
      const pttOut = ctx.createBufferSource();
      pttOut.buffer = this.samples.micClickOut;
      const g = ctx.createGain();
      g.gain.value = 0.9;
      pttOut.connect(g).connect(chain.input);
      pttOut.start(tailStart);
    }

    const totalDur = tailStart - t0 + 0.12;
    chain.carrierStatic.stop(t0 + totalDur);

    chain.output.gain.setValueAtTime(vol * 0.9, t0 + totalDur - 0.02);
    chain.output.gain.linearRampToValueAtTime(0.0001, t0 + totalDur);

    setTimeout(() => {
      this.activeChains.delete(chainRef);
    }, (totalDur + 0.1) * 1000);

    return totalDur;
  }
}
