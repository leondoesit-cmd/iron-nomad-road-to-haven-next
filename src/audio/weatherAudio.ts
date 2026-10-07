import type { AudioEngine } from './audio';
/** Weather recordings follow the existing rain, shelter, flood and fire simulation. */
export class WeatherAudio {
  constructor(private a: AudioEngine) {}
  set(rain: number, roof: number, flood: number, fire: number, _dt: number) {
    this.a.setRecordedAmbience?.('rain', rain * (0.25 + roof * 0.08), 16000 - roof * 13500);
    this.a.setRecordedAmbience?.('flood', flood * 0.4);
    this.a.setRecordedAmbience?.('fire', fire * 0.22);
  }
  thunder(dist: number) { this.a.play('thunder', undefined, undefined, Math.min(1, 900 / (dist + 250))); }
  silence() { this.set(0, 0, 0, 0, 0); }
}
const per = new WeakMap<AudioEngine, WeatherAudio>();
export function weatherAudio(a: AudioEngine) {
  let w = per.get(a);
  if (!w) per.set(a, (w = new WeatherAudio(a)));
  return w;
}
