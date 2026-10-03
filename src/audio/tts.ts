/**
 * In-browser Text-to-Speech (TTS) Engine using Web Speech API (speechSynthesis).
 * Replaces synthetic procedural formant buzzes with authentic browser speech synthesis.
 * Handles voice selection, text normalization, pitch/rate modulation for characters,
 * lifecycle event management, and browser quirks (Chromium garbage collection bug,
 * paused queue stalls, and asynchronous voice list loading).
 */

export interface TTSOptions {
  volume?: number;
  rate?: number;
  pitch?: number;
  speaker?: string;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (err?: unknown) => void;
}

/**
 * Normalizes game text into clean, natural phrases suitable for TTS engines.
 * Strips ellipses, handles fractions like "(1/4)" -> "1 of 4", removes quotes,
 * and fixes erratic punctuation that could cause speech synthesis hiccups.
 */
export function cleanTextForTTS(text: string): string {
  if (!text) return '';
  let cleaned = text;

  // 1. Remove radio fragment placeholders or formatting like "(1/4)" -> "1 of 4"
  cleaned = cleaned.replace(/\((\d+)\s*\/\s*(\d+)\)/g, '$1 of $2');

  // 2. Remove leading/trailing ellipsis or multiple dots
  cleaned = cleaned.replace(/^\s*\.{2,}\s*/, '');
  cleaned = cleaned.replace(/\.{2,}\s*$/, '.');
  cleaned = cleaned.replace(/\.{2,}/g, ', ');

  // 3. Remove quotation marks & brackets
  cleaned = cleaned.replace(/["“”'‘’]/g, '');
  cleaned = cleaned.replace(/\[.*?\]/g, '');

  // 4. Clean up duplicate punctuation and spacing
  cleaned = cleaned.replace(/,\s*,/g, ',');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned;
}

export class TTSEngine {
  enabled = true;
  private voices: SpeechSynthesisVoice[] = [];
  private activeUtterance: SpeechSynthesisUtterance | null = null;

  constructor() {
    this.initVoices();
  }

  get hasSupport(): boolean {
    return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  }

  initVoices() {
    if (!this.hasSupport) return;
    const synth = window.speechSynthesis;
    const load = () => {
      try {
        this.voices = synth.getVoices() || [];
      } catch {
        this.voices = [];
      }
    };
    load();
    if (typeof synth.onvoiceschanged !== 'undefined') {
      synth.onvoiceschanged = load;
    }
    synth.addEventListener?.('voiceschanged', load);
  }

  getVoices(): SpeechSynthesisVoice[] {
    if (this.voices.length === 0 && this.hasSupport) {
      try {
        this.voices = window.speechSynthesis.getVoices() || [];
      } catch {
        this.voices = [];
      }
    }
    return this.voices;
  }

  /**
   * Pick an appropriate voice based on speaker identity or preferred natural voice.
   */
  getVoiceForSpeaker(speaker?: string): SpeechSynthesisVoice | null {
    const list = this.getVoices();
    if (list.length === 0) return null;

    // Filter to English voices if available
    const en = list.filter((v) => v.lang && v.lang.toLowerCase().startsWith('en'));
    const pool = en.length > 0 ? en : list;

    if (!speaker || pool.length === 1) {
      // Pick best default voice: preferred natural or local
      const natural = pool.find((v) =>
        /natural|google|daniel|alex|samantha|david|george|arthur|guy|richard/i.test(v.name)
      );
      if (natural) return natural;
      const local = pool.find((v) => v.localService);
      if (local) return local;
      return pool.find((v) => v.default) || pool[0] || null;
    }

    // Select distinct voice by speaker name hash for character variety
    let h = 0;
    const lower = speaker.toLowerCase().trim();
    for (let i = 0; i < lower.length; i++) h = (h * 31 + lower.charCodeAt(i)) & 0xffff;
    return pool[h % pool.length] || pool[0] || null;
  }

  /**
   * Speaks the given text with authentic radio pacing, mood-based inflection,
   * and speaker-derived pitch.
   */
  speak(text: string, options: TTSOptions = {}): boolean {
    if (!this.enabled || !this.hasSupport) {
      options.onEnd?.();
      return false;
    }

    const synth = window.speechSynthesis;

    // Cancel active speech to avoid queuing stale tactical radio chatter
    this.cancel();

    // Chrome bugfix: if synth is paused, resume it
    if (synth.paused) {
      try {
        synth.resume();
      } catch {}
    }

    const cleaned = cleanTextForTTS(text);
    if (!cleaned) {
      options.onEnd?.();
      return false;
    }

    // Detect speaker if text has "Speaker: ..." format
    let speaker = options.speaker;
    const speakerMatch = cleaned.match(/^([A-Za-z0-9\s_-]+):\s*(.*)$/);
    if (!speaker && speakerMatch) {
      speaker = speakerMatch[1];
    }

    const Utterance =
      (typeof window !== 'undefined' && window.SpeechSynthesisUtterance) ||
      (typeof globalThis !== 'undefined' && (globalThis as unknown as { SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance }).SpeechSynthesisUtterance);
    if (!Utterance) {
      options.onEnd?.();
      return false;
    }

    const utterance = new Utterance(cleaned);

    // Keep reference on instance to prevent Chromium GC bug from cutting speech off early
    this.activeUtterance = utterance;

    // Select voice
    const voice = this.getVoiceForSpeaker(speaker);
    if (voice) utterance.voice = voice;
    utterance.lang = voice?.lang || 'en-US';

    // Rate & Pitch calculation
    const isUrgent = text.includes('!') || /horde|seiz|run|wall|strike|ambush|mines|contact|inside|down/i.test(text);

    let defaultPitch = 1.0;
    if (speaker) {
      const spk = speaker.toLowerCase();
      if (spk === 'mechanic') defaultPitch = 0.92;
      else {
        let h = 0;
        for (let i = 0; i < spk.length; i++) h = (h * 31 + spk.charCodeAt(i)) & 0xffff;
        defaultPitch = 0.88 + ((h % 100) / 100) * 0.24;
      }
    } else if (isUrgent) {
      defaultPitch = 1.08;
    }

    const defaultRate = isUrgent ? 1.15 : 1.05;

    utterance.pitch = options.pitch ?? defaultPitch;
    utterance.rate = options.rate ?? defaultRate;
    utterance.volume = options.volume !== undefined ? Math.max(0, Math.min(1, options.volume)) : 1.0;

    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      if (this.activeUtterance === utterance) {
        this.activeUtterance = null;
      }
    };

    utterance.onstart = () => {
      options.onStart?.();
    };

    utterance.onend = () => {
      cleanup();
      options.onEnd?.();
    };

    utterance.onerror = (e) => {
      cleanup();
      // 'interrupted' or 'canceled' are normal when radio calls interrupt old ones
      options.onError?.(e);
      options.onEnd?.();
    };

    try {
      synth.speak(utterance);
      return true;
    } catch (err) {
      cleanup();
      options.onError?.(err);
      options.onEnd?.();
      return false;
    }
  }

  cancel() {
    if (!this.hasSupport) return;
    this.activeUtterance = null;
    try {
      window.speechSynthesis.cancel();
    } catch {}
  }

  pause() {
    if (!this.hasSupport) return;
    try {
      window.speechSynthesis.pause();
    } catch {}
  }

  resume() {
    if (!this.hasSupport) return;
    try {
      window.speechSynthesis.resume();
    } catch {}
  }

  isSpeaking(): boolean {
    if (!this.hasSupport) return false;
    return window.speechSynthesis.speaking;
  }
}
