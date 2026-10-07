import type { SampleLibrary } from './samples';
export interface GunshotOptions { vol?: number; indoor?: boolean; canyon?: boolean }
/** Recorded firearm and impact transients, retaining their recorded acoustic tails. */
export class FoleyEngine {
  constructor(public ctx: AudioContext, public samples: SampleLibrary) {}
  playGunshot(caliber: 'pistol' | 'shotgun' | 'mg' | 'sniper', dest: AudioNode, time: number, opts: GunshotOptions = {}) {
    this.samples.play(caliber, dest, time, opts.vol ?? 1);
  }
  playExplosion(dest: AudioNode, time: number, vol = 1) { this.samples.play('boom', dest, time, vol); }
  playDuskBell(dest: AudioNode, time: number, vol = 1) { this.samples.play('bell', dest, time, vol); }
  playZombieDeath(dest: AudioNode, time: number, vol = 1) { this.samples.play('zdie', dest, time, vol); }
}
