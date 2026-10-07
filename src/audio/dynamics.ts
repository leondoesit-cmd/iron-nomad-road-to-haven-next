import { clamp } from '../core/math';

/** A shuffled deck plays every take before reusing one, including across deck boundaries. */
export class TakeDeck {
  private remaining: number[] = [];
  private last = -1;
  private size = 0;
  next(count: number, random = Math.random): number {
    if (!count) return -1;
    if (count !== this.size) { this.remaining = []; this.size = count; }
    if (!this.remaining.length) {
      this.remaining = Array.from({ length: count }, (_, i) => i);
      for (let i = count - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [this.remaining[i], this.remaining[j]] = [this.remaining[j], this.remaining[i]];
      }
      if (count > 1 && this.remaining[count - 1] === this.last)
        [this.remaining[0], this.remaining[count - 1]] = [this.remaining[count - 1], this.remaining[0]];
    }
    return this.last = this.remaining.pop()!;
  }
}

export interface SoundProfile { range: number; reference: number; pitchSpread: number; gainSpread: number; brightness: number }
const quiet: SoundProfile = { range: 24, reference: 1.5, pitchSpread: 0.025, gainSpread: 0.06, brightness: 14000 };
const impact: SoundProfile = { range: 95, reference: 2, pitchSpread: 0.055, gainSpread: 0.08, brightness: 19000 };
const gun: SoundProfile = { range: 260, reference: 5, pitchSpread: 0.012, gainSpread: 0.035, brightness: 22000 };
export function soundProfile(id: string): SoundProfile {
  if (['pistol','shotgun','mg','sniper'].includes(id)) return gun;
  if (['boom','thunder'].includes(id)) return { ...impact, range: 380, reference: 8, pitchSpread: 0.025 };
  if (['horn','alarm','siren','bell','howl','scream'].includes(id)) return { ...impact, range: 210, pitchSpread: 0.008 };
  if (id.startsWith('weapon') || ['magOut','magIn','shellInsert'].includes(id)) return quiet;
  if (id.startsWith('engine') || id === 'starterFail') return { ...impact, range: 80, pitchSpread: 0.01 };
  if (id.startsWith('foot') || ['click','pickup','loot','pill','gulp','munch','toke','reload','wrench','build','whisper','hiccup'].includes(id)) return quiet;
  if (id === 'flutter') return { ...impact, range: 40, reference: 1.2, pitchSpread: 0.05 };
  if (['chirp','quack','caw','hiss','bellow','growl','yelp'].includes(id)) return { ...impact, range: 80, pitchSpread: 0.015 };
  return impact;
}

export function performance(id: string, intensity: number, pitch = 1, random = Math.random) {
  const profile = soundProfile(id);
  const strength = clamp(intensity, 0, 1);
  return {
    pitch: clamp(pitch * (1 + (random() * 2 - 1) * profile.pitchSpread), 0.65, 1.5),
    gain: (0.35 + 0.65 * Math.sqrt(strength)) * (1 + (random() * 2 - 1) * profile.gainSpread),
    cutoff: 1800 + (profile.brightness - 1800) * (0.25 + 0.75 * strength),
  };
}

/** Finite early reflections transform recorded sound; they do not manufacture an audio source. */
export class RoomAcoustics {
  readonly input: GainNode;
  private sends: { delay: DelayNode; filter: BiquadFilterNode; gain: GainNode }[] = [];
  constructor(private ctx: AudioContext, dest: AudioNode) {
    this.input = ctx.createGain();
    this.input.connect(dest);
    for (const seconds of [0.027, 0.049, 0.087, 0.143, 0.229, 0.367]) {
      const delay = ctx.createDelay(1); delay.delayTime.value = seconds;
      const filter = ctx.createBiquadFilter(); filter.type = 'lowpass';
      const gain = ctx.createGain(); gain.gain.value = 0;
      this.input.connect(delay).connect(filter).connect(gain).connect(dest);
      this.sends.push({ delay, filter, gain });
    }
  }
  update(enclosure: number, size = 0.5) {
    const enclosed = clamp(enclosure, 0, 1);
    this.sends.forEach((tap, i) => {
      tap.gain.gain.setTargetAtTime(enclosed * 0.24 * Math.pow(0.63 + size * 0.08, i), this.ctx.currentTime, 0.18);
      tap.filter.frequency.setTargetAtTime(7000 - i * 750 - enclosed * 1800, this.ctx.currentTime, 0.18);
    });
  }
}
