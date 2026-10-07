import { clamp } from '../core/math';
import type { SampleLibrary } from './samples';
import { TTSEngine } from './tts';

/** Recorded radio clicks and receiver noise. Browser TTS is an explicit optional setting. */
export class RadioAudioEngine {
  ctx: AudioContext;
  samples: SampleLibrary;
  tts: TTSEngine;
  private masterVolume = 0.7;
  private muted = false;
  ttsEnabled = false;
  voiceMode: 'tts' | 'synth' | 'off' = 'off';

  private synthSpeechUntil = 0;
  private synthChain: { output: GainNode; carrierStatic: AudioBufferSourceNode } | null = null;
  get speechActive() { return !!this.activeTransmission || this.ctx.currentTime < this.synthSpeechUntil; }

  private activeTransmission: {
    finish: () => void;
    timeoutId?: ReturnType<typeof setTimeout> | undefined;
    chain: { input: GainNode; output: GainNode; carrierStatic: AudioBufferSourceNode };
  } | null = null;

  constructor(ctx: AudioContext, samples: SampleLibrary, tts?: TTSEngine) {
    this.ctx = ctx;
    this.samples = samples;
    this.tts = tts || new TTSEngine();

  }

  setVolume(v: number) {
    this.masterVolume = v;
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (m) {
      this.cancelActiveTransmission();
    }
  }

  setTtsEnabled(enabled: boolean) {
    this.ttsEnabled = enabled;
    this.tts.enabled = enabled;
    this.voiceMode = enabled ? 'tts' : 'off';
    if (!enabled) {
      this.cancelActiveTransmission();
    }
  }

  cancelActiveTransmission() {
    this.synthSpeechUntil = 0;
    if (this.synthChain) {
      this.synthChain.output.gain.cancelScheduledValues(this.ctx.currentTime);
      this.synthChain.output.gain.value = 0;
      try { this.synthChain.carrierStatic.stop(); } catch {}
      this.synthChain = null;
    }
    if (this.activeTransmission) {
      this.activeTransmission.finish();
      this.activeTransmission = null;
    }
    this.tts.cancel();
  }

  estimateDuration(text: string): number {
    const words = text.split(/\s+/).filter((w) => w.length > 0);
    // Average speech rate with radio PTT switch overhead
    return Math.max(0.8, words.length * 0.35 + 0.5);
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
    carrier.buffer = this.samples.get('radio');
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
   * optional browser speech, recorded receiver noise and switch clicks.
   */
  playRadioChatter(text: string, dest: AudioNode, vol = 1): number {
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    if (this.muted) return 0;

    // Cancel active transmission to avoid overlapping comms
    this.cancelActiveTransmission();

    const chain = this.createRadioChain(dest);
    chain.output.gain.setValueAtTime(vol * 0.9, t0);

    // Start RF carrier
    chain.carrierStatic.start(t0);

    // 1. PTT Mic Click-In (Tactical switch + squelch chirp)
    if (this.samples.micClickIn) {
      const pttIn = ctx.createBufferSource();
      pttIn.buffer = this.samples.micClickIn;
      const g = ctx.createGain();
      g.gain.value = 0.85;
      pttIn.connect(g).connect(chain.input);
      pttIn.start(t0);
    }

    const estDuration = this.estimateDuration(text);
    const useTTS = this.voiceMode === 'tts' && this.tts.hasSupport && this.ttsEnabled && !this.muted;

    if (useTTS) {
      let finished = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const finishTransmission = () => {
        if (finished) return;
        finished = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = undefined;
        }

        const tTail = ctx.currentTime;
        // PTT Mic Click-Out & Squelch Tail (Roger Beep + Static Tail)
        if (this.samples.micClickOut) {
          const pttOut = ctx.createBufferSource();
          pttOut.buffer = this.samples.micClickOut;
          const g = ctx.createGain();
          g.gain.value = 0.9;
          pttOut.connect(g).connect(chain.input);
          pttOut.start(tTail);
        }

        const stopTime = tTail + 0.12;
        try {
          chain.carrierStatic.stop(stopTime);
        } catch {}

        chain.output.gain.setValueAtTime(vol * 0.9, stopTime - 0.02);
        chain.output.gain.linearRampToValueAtTime(0.0001, stopTime);

        if (this.activeTransmission === current) {
          this.activeTransmission = null;
        }
      };

      timeoutId = setTimeout(() => { this.tts.cancel(); finishTransmission(); }, Math.max(30000, (estDuration * 3 + 10) * 1000));
      const current = { finish: finishTransmission, timeoutId, chain };
      this.activeTransmission = current;

      const effectiveVol = clamp(vol * (this.muted ? 0 : this.masterVolume), 0, 1);
      this.tts.speak(text, {
        volume: effectiveVol,
        onEnd: () => finishTransmission(),
        onError: () => finishTransmission(),
      });

      return estDuration;
    }

    // Recorded switch and carrier only; dialogue remains in captions.
    const tailStart = t0 + 0.22;
    if (this.samples.micClickOut) {
      const pttOut = ctx.createBufferSource();
      pttOut.buffer = this.samples.micClickOut;
      const g = ctx.createGain();
      g.gain.value = 0.9;
      pttOut.connect(g).connect(chain.input);
      pttOut.start(tailStart);
    }

    const totalDur = tailStart - t0 + 0.12;
    try {
      chain.carrierStatic.stop(t0 + totalDur);
    } catch {}

    chain.output.gain.setValueAtTime(vol * 0.9, t0 + totalDur - 0.02);
    chain.output.gain.linearRampToValueAtTime(0.0001, t0 + totalDur);

    this.synthChain = chain;
    this.synthSpeechUntil = 0;
    chain.carrierStatic.onended = () => { chain.carrierStatic.disconnect(); chain.input.disconnect(); chain.output.disconnect(); };
    return totalDur;
  }

  /** Legacy API: no unintelligible generated speech; dialogue stays in captions. */
  playSynthSyllables(_text: string, chain: { input: GainNode; output: GainNode; carrierStatic: AudioBufferSourceNode }, t0: number, _vol = 1): number {
    chain.carrierStatic.stop(t0);
    chain.output.gain.value = 0;
    return 0;
  }
}
