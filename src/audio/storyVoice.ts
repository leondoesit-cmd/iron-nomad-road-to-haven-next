import { TTSEngine, cleanTextForTTS } from './tts';

/**
 * Reads the story's subtitles aloud with the browser's speech synthesis (Web Speech API). Lines queue rather than cut
 * each other off, the "Nar:" in front picks the voice and is not read out, and speech pauses with the game.
 */
export class StoryVoice {
  enabled = true;
  volume = 0.7;
  private tts = new TTSEngine();
  /** Held so Chromium does not garbage-collect an utterance mid-sentence. */
  private queued = new Set<SpeechSynthesisUtterance>();
  private paused = false;

  speak(text: string) {
    if (!this.enabled || !this.tts.hasSupport) return;
    const m = text.match(/^([A-Z][\w'. -]{0,24}):\s+(.+)$/s);
    const speaker = m?.[1];
    const line = cleanTextForTTS(m ? m[2] : text);
    if (!line) return;
    const synth = window.speechSynthesis;
    // Far behind (a burst of lines, or a long pause): drop what is stale and read the newest.
    if (this.queued.size >= 3) this.stop();
    const u = new SpeechSynthesisUtterance(line);
    const voice = this.tts.getVoiceForSpeaker(speaker);
    if (voice) u.voice = voice;
    u.lang = voice?.lang || 'en-US';
    u.pitch = speaker ? pitchOf(speaker) : 1;
    u.rate = 1;
    u.volume = Math.max(0, Math.min(1, this.volume));
    const done = () => this.queued.delete(u);
    u.onend = done;
    u.onerror = done;
    this.queued.add(u);
    try {
      synth.speak(u);
      if (this.paused) synth.pause();
    } catch {
      done();
    }
  }

  setPaused(p: boolean) {
    if (p === this.paused || !this.tts.hasSupport) return;
    this.paused = p;
    try {
      if (p) window.speechSynthesis.pause();
      else window.speechSynthesis.resume();
    } catch {
      /* ignore */
    }
  }

  stop() {
    // Lines go straight to the browser's queue (not through the TTS engine), so cancel it here, and only when a line of
    // ours is queued: the queue is shared with the radio voice.
    if (!this.queued.size || !this.tts.hasSupport) return;
    this.queued.clear();
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
  }
}

/** A steady pitch per speaker, so each person keeps their voice from line to line. */
function pitchOf(speaker: string): number {
  let h = 0;
  const s = speaker.toLowerCase().trim();
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffff;
  return 0.85 + ((h % 100) / 100) * 0.3;
}
