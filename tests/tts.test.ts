import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { cleanTextForTTS, TTSEngine } from '../src/audio/tts';
import { RadioAudioEngine } from '../src/audio/radio';
import { SampleLibrary } from '../src/audio/samples';

// Minimal Web Audio mocks for RadioAudioEngine
class MockAudioParam {
  value = 0;
  constructor(val = 0) {
    this.value = val;
  }
  setValueAtTime(v: number) {
    this.value = v;
  }
  linearRampToValueAtTime(v: number) {
    this.value = v;
  }
  exponentialRampToValueAtTime(v: number) {
    this.value = v;
  }
  setTargetAtTime(v: number) {
    this.value = v;
  }
  cancelScheduledValues() {}
}

class MockAudioNode {
  connect(dest: any) {
    return dest;
  }
  disconnect() {}
}

class MockBufferSource extends MockAudioNode {
  buffer: any = null;
  loop = false;
  started = false;
  stopped = false;
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
}

class MockGain extends MockAudioNode {
  gain = new MockAudioParam(1);
}

class MockBiquadFilter extends MockAudioNode {
  type = 'bandpass';
  frequency = new MockAudioParam(1000);
  Q = new MockAudioParam(1);
  gain = new MockAudioParam(0);
}

class MockWaveShaper extends MockAudioNode {
  curve: any = null;
  oversample = 'none';
}

class MockCompressor extends MockAudioNode {
  threshold = new MockAudioParam(-24);
  knee = new MockAudioParam(4);
  ratio = new MockAudioParam(12);
  attack = new MockAudioParam(0.003);
  release = new MockAudioParam(0.045);
}

class MockAudioContext {
  currentTime = 0;
  sampleRate = 44100;
  createGain() {
    return new MockGain();
  }
  createBuffer(channels: number, length: number, rate: number) {
    return {
      numberOfChannels: channels,
      length,
      sampleRate: rate,
      getChannelData: () => new Float32Array(length),
    };
  }
  createBufferSource() {
    return new MockBufferSource();
  }
  createBiquadFilter() {
    return new MockBiquadFilter();
  }
  createWaveShaper() {
    return new MockWaveShaper();
  }
  createDynamicsCompressor() {
    return new MockCompressor();
  }
  createOscillator() {
    return {
      type: 'sawtooth',
      frequency: new MockAudioParam(100),
      connect: (n: any) => n,
      start: () => {},
      stop: () => {},
    };
  }
}

describe('In-Browser Text-to-Speech (TTS) Engine', () => {
  describe('cleanTextForTTS', () => {
    it('removes leading and trailing ellipses', () => {
      const res = cleanTextForTTS('...Haven holds. Clean water, walls. Follow the north road...');
      expect(res).toBe('Haven holds. Clean water, walls. Follow the north road.');
    });

    it('converts fraction counters like (1/4) to "1 of 4"', () => {
      const res = cleanTextForTTS('Radio fragment recovered (1/4). The static resolves.');
      expect(res).toBe('Radio fragment recovered 1 of 4. The static resolves.');
    });

    it('strips quotation marks from dialogue', () => {
      const res = cleanTextForTTS('Mechanic: "Hold still, I\'ll patch her up."');
      expect(res).toBe('Mechanic: Hold still, Ill patch her up.');
    });

    it('strips bracketed tags and excess whitespace', () => {
      const res = cleanTextForTTS('  [radio chirp]  Warning:  raiders spotted!  ');
      expect(res).toBe('Warning: raiders spotted!');
    });

    it('returns empty string for empty input', () => {
      expect(cleanTextForTTS('')).toBe('');
    });
  });

  describe('TTSEngine with Web Speech API Mocks', () => {
    let mockVoices: any[];
    let mockSynth: any;
    let spokenUtterances: any[];
    let originalWindow: any;

    beforeEach(() => {
      spokenUtterances = [];
      mockVoices = [
        { name: 'Google US English', lang: 'en-US', default: true, localService: false },
        { name: 'Daniel', lang: 'en-GB', default: false, localService: true },
        { name: 'Samantha', lang: 'en-US', default: false, localService: true },
        { name: 'Amelie', lang: 'fr-FR', default: false, localService: true },
      ];

      mockSynth = {
        speaking: false,
        paused: false,
        getVoices: vi.fn(() => mockVoices),
        speak: vi.fn((utterance) => {
          spokenUtterances.push(utterance);
          mockSynth.speaking = true;
          // Simulate start and end
          utterance.onstart?.();
          setTimeout(() => {
            mockSynth.speaking = false;
            utterance.onend?.();
          }, 10);
        }),
        cancel: vi.fn(() => {
          mockSynth.speaking = false;
        }),
        pause: vi.fn(() => {
          mockSynth.paused = true;
        }),
        resume: vi.fn(() => {
          mockSynth.paused = false;
        }),
        addEventListener: vi.fn(),
        onvoiceschanged: null,
      };

      class MockSpeechSynthesisUtterance {
        text: string;
        lang = 'en-US';
        voice: any = null;
        volume = 1;
        rate = 1;
        pitch = 1;
        onstart: any = null;
        onend: any = null;
        onerror: any = null;

        constructor(text: string) {
          this.text = text;
        }
      }

      originalWindow = (globalThis as any).window;
      (globalThis as any).window = {
        speechSynthesis: mockSynth,
        SpeechSynthesisUtterance: MockSpeechSynthesisUtterance,
      };
    });

    afterEach(() => {
      (globalThis as any).window = originalWindow;
    });

    it('detects Web Speech API support', () => {
      const tts = new TTSEngine();
      expect(tts.hasSupport).toBe(true);
    });

    it('loads voices and selects natural/local English voice by default', () => {
      const tts = new TTSEngine();
      const voices = tts.getVoices();
      expect(voices.length).toBe(4);

      const voice = tts.getVoiceForSpeaker();
      expect(voice).toBeDefined();
      expect(voice?.lang).toMatch(/^en/i);
    });

    it('picks distinct voices or pitch modulation for different characters', () => {
      const tts = new TTSEngine();
      const v1 = tts.getVoiceForSpeaker('Mechanic');
      const v2 = tts.getVoiceForSpeaker('Tariq');
      expect(v1).toBeDefined();
      expect(v2).toBeDefined();
    });

    it('speaks cleaned text and cancels its own transmission (never anyone else\'s) before speaking', () => {
      const tts = new TTSEngine();
      const onStart = vi.fn();
      const onEnd = vi.fn();

      // Nothing of its own is speaking: the page's shared queue (a story line, say) is left alone.
      const success = tts.speak('...Haven holds. Follow north...', { onStart, onEnd });
      expect(success).toBe(true);
      expect(mockSynth.cancel).not.toHaveBeenCalled();
      expect(mockSynth.speak).toHaveBeenCalled();
      expect(spokenUtterances.length).toBe(1);
      expect(spokenUtterances[0].text).toBe('Haven holds. Follow north.');
      expect(onStart).toHaveBeenCalled();
      // A newer transmission cuts off its own stale one.
      tts.speak('Contact north!');
      expect(mockSynth.cancel).toHaveBeenCalledTimes(1);
    });

    it('adjusts rate and pitch upward for urgent messages', () => {
      const tts = new TTSEngine();
      tts.speak('Contact north! Horde incoming!');
      expect(spokenUtterances.length).toBe(1);
      expect(spokenUtterances[0].pitch).toBeGreaterThan(1.0);
      expect(spokenUtterances[0].rate).toBeGreaterThan(1.1);
    });

    it('lowers pitch for Mechanic dialogue', () => {
      const tts = new TTSEngine();
      tts.speak('Mechanic: "Hold still, I will patch her up."');
      expect(spokenUtterances.length).toBe(1);
      expect(spokenUtterances[0].pitch).toBeLessThan(1.0);
    });

    it('handles cancellation, pausing, and resuming cleanly', () => {
      const tts = new TTSEngine();
      tts.speak('Some radio line');
      expect(tts.isSpeaking()).toBe(true);

      tts.pause();
      expect(mockSynth.pause).toHaveBeenCalled();

      tts.resume();
      expect(mockSynth.resume).toHaveBeenCalled();

      tts.cancel();
      expect(mockSynth.cancel).toHaveBeenCalled();
    });

    it('resumes paused speech synth before speaking', () => {
      mockSynth.paused = true;
      const tts = new TTSEngine();
      tts.speak('Test line');
      expect(mockSynth.resume).toHaveBeenCalled();
    });
  });

  describe('RadioAudioEngine with In-Browser TTS', () => {
    let mockVoices: any[];
    let mockSynth: any;
    let spokenUtterances: any[];
    let originalWindow: any;

    beforeEach(() => {
      spokenUtterances = [];
      mockVoices = [
        { name: 'Google US English', lang: 'en-US', default: true, localService: false },
        { name: 'Daniel', lang: 'en-GB', default: false, localService: true },
      ];

      mockSynth = {
        speaking: false,
        paused: false,
        getVoices: vi.fn(() => mockVoices),
        speak: vi.fn((utterance) => {
          spokenUtterances.push(utterance);
          mockSynth.speaking = true;
          utterance.onstart?.();
        }),
        cancel: vi.fn(() => {
          mockSynth.speaking = false;
        }),
        pause: vi.fn(),
        resume: vi.fn(),
        addEventListener: vi.fn(),
        onvoiceschanged: null,
      };

      class MockSpeechSynthesisUtterance {
        text: string;
        lang = 'en-US';
        voice: any = null;
        volume = 1;
        rate = 1;
        pitch = 1;
        onstart: any = null;
        onend: any = null;
        onerror: any = null;

        constructor(text: string) {
          this.text = text;
        }
      }

      originalWindow = (globalThis as any).window;
      (globalThis as any).window = {
        speechSynthesis: mockSynth,
        SpeechSynthesisUtterance: MockSpeechSynthesisUtterance,
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
      };
    });

    afterEach(() => {
      (globalThis as any).window = originalWindow;
    });

    it('plays authentic radio chatter with browser TTS voice and RF carrier hiss', () => {
      const mockCtx = new MockAudioContext() as any;
      const lib = new SampleLibrary(mockCtx);
      lib.init();
      const radio = new RadioAudioEngine(mockCtx, lib);
      radio.setTtsEnabled(true);
      const dest = mockCtx.createGain();

      const duration = radio.playRadioChatter('Dust wall rolling in from the south!', dest);
      expect(duration).toBeGreaterThan(0.5);
      expect(mockSynth.speak).toHaveBeenCalled();
      expect(spokenUtterances.length).toBe(1);
      expect(spokenUtterances[0].text).toContain('Dust wall rolling in from the south!');
    });

    it('triggers squelch tail and stops carrier static when TTS utterance ends', () => {
      const mockCtx = new MockAudioContext() as any;
      const lib = new SampleLibrary(mockCtx);
      lib.init();
      const radio = new RadioAudioEngine(mockCtx, lib);
      radio.setTtsEnabled(true);
      const dest = mockCtx.createGain();

      radio.playRadioChatter('Contact north!', dest);
      expect(spokenUtterances.length).toBe(1);
      expect(radio.speechActive).toBe(true);

      // Trigger utterance onend
      const active = spokenUtterances[0];
      active.onend?.();
      expect(radio.speechActive).toBe(false);
      // Verified no throws and cleanly handled
    });

    it('scales TTS volume with radio setVolume and respects setMuted', () => {
      const mockCtx = new MockAudioContext() as any;
      const lib = new SampleLibrary(mockCtx);
      lib.init();
      const radio = new RadioAudioEngine(mockCtx, lib);
      radio.setTtsEnabled(true);
      const dest = mockCtx.createGain();

      radio.setVolume(0.4);
      radio.playRadioChatter('First message', dest, 0.8);
      expect(spokenUtterances[0].volume).toBeCloseTo(0.32, 2);

      radio.setMuted(true);
      expect(mockSynth.cancel).toHaveBeenCalled();

      radio.playRadioChatter('Second message when muted', dest);
      // Muted radio should not speak TTS
      expect(spokenUtterances.length).toBe(1);
    });

    it('can toggle TTS off and fallback to silent radio carrier / mic clicks', () => {
      const mockCtx = new MockAudioContext() as any;
      const lib = new SampleLibrary(mockCtx);
      lib.init();
      const radio = new RadioAudioEngine(mockCtx, lib);
      radio.setTtsEnabled(true);
      const dest = mockCtx.createGain();

      radio.setTtsEnabled(false);
      const duration = radio.playRadioChatter('Test message with TTS disabled', dest);
      expect(duration).toBeGreaterThan(0);
      // No TTS utterance created when ttsEnabled is false
      expect(spokenUtterances.length).toBe(0);
      expect(radio.speechActive).toBe(false);
    });
  });
});
