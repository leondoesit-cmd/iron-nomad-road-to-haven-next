import { clamp } from '../core/math';
import type { SampleLibrary } from './samples';

/**
 * Procedural Voice Barks & Walkie-Talkie Radio Chatter Engine.
 * Features:
 * - Authentic walkie-talkie bandpass filtering (420Hz HP - 2900Hz LP, 1.8kHz presence peak)
 * - Analog transistor diode saturation (WaveShaper)
 * - Heavy RF dynamics compression (12:1, fast attack)
 * - Tactical PTT mic clicks, CTCSS chirps, Roger beeps, and squelch tail static bursts
 * - Procedural formant-synthesized voice chatter syllables matching text cadence
 */
export class RadioAudioEngine {
  ctx: AudioContext;
  samples: SampleLibrary;
  private noiseBuf: AudioBuffer;

  constructor(ctx: AudioContext, samples: SampleLibrary) {
    this.ctx = ctx;
    this.samples = samples;
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
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
   * Plays a procedural contextual radio bark with authentic PTT key-in,
   * procedural speech cadence formant synthesis, compression, and squelch tail.
   */
  playRadioChatter(text: string, dest: AudioNode, vol = 1): number {
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
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

    // 2. Procedural Formant Voice Chatter Syllables
    const speechStart = t0 + 0.06;
    const words = text.split(/\s+/).filter((w) => w.length > 0);
    let curTime = speechStart;

    // Determine voice pitch based on text mood (urgent, warning, or calm)
    const isUrgent = text.includes('!') || /horde|seiz|run|wall|strike|ambush/i.test(text);
    const baseF0 = isUrgent ? 135 : 110;

    // Syllable formant map (F1, F2, F3 frequencies)
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

      // Break into rough syllables by vowel clusters
      const syllables = word.match(/[^aeiouy]*[aeiouy]+(?:[^aeiouy]*$|[^aeiouy](?=[^aeiouy]))?/gi) || [word];

      for (let sIdx = 0; sIdx < syllables.length; sIdx++) {
        const syl = syllables[sIdx];
        const sylDur = clamp(0.09 + syl.length * 0.025, 0.08, 0.2);

        // Pick dominant vowel for formant resonances
        const vowelMatch = syl.match(/[aeiou]/);
        const vKey = vowelMatch ? vowelMatch[0] : 'a';
        const [f1, f2, f3] = formants[vKey] || formants.a;

        // Glottal excitation pulse (buzz with pitch modulation)
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        const inflection = isUrgent ? Math.sin((sIdx / Math.max(1, syllables.length)) * Math.PI) * 20 : 0;
        osc.frequency.setValueAtTime(baseF0 + inflection, curTime);
        osc.frequency.linearRampToValueAtTime(baseF0 * 0.9 + inflection, curTime + sylDur);

        // Formant filters in parallel
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

        // Fricative consonant noise (for 's', 't', 'k', 'sh')
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
      curTime += 0.04; // Micro-pause between words
    }

    // 3. PTT Mic Click-Out & Squelch Tail (Roger Beep + Static Tail)
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

    // Fade out and cleanup
    chain.output.gain.setValueAtTime(vol * 0.9, t0 + totalDur - 0.02);
    chain.output.gain.linearRampToValueAtTime(0.0001, t0 + totalDur);

    return totalDur;
  }
}
