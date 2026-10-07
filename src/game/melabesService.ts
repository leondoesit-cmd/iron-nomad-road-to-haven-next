import { DRUG_IDS } from '../sim/drugs';
import { eat } from '../sim/needs';
import { hashString, Rng } from '../core/rng';
import { MELABES, melabesFrame, melabesPhase } from '../world/melabes';
import type { InteractRegistry } from './interact';
import type { Player } from './player';
import type { Aabb } from '../world/layout';

/** Both players can collect one portion per serving round; each receives their own delayed dose. */
export class MelabesService {
  private taken = new Map<number, number>();
  constructor(registry: InteractRegistry, aabb: Aabb, private time: () => number, private players: () => readonly Player[], seed: number) {
    const at = melabesFrame(aabb).point(MELABES.service.x, 0.65);
    registry.add({
      id: 'melabes:serving', x: at.x, z: at.z, r: 1.45,
      prompt: 'Take fresh shawarma from the worker', dur: 0.55, priority: 4, direct: true,
      enabled: (p) => p.alive && p.state === 'foot' && !p.carry && this.available(p),
      onTick: (p) => this.available(p),
      run: (p) => {
        if (!this.available(p)) return;
        const { cycle } = melabesPhase(this.time());
        this.taken.set(p.index, cycle);
        const rng = new Rng(hashString(`melabes:${seed}:${cycle}:${p.index}`));
        p.drugs.scheduleDose(rng.pick(DRUG_IDS), MELABES.delay, 'Melabes shawarma');
        eat(p.needs, 1);
        p.ctx.audio.play('munch', p.pos.x, p.pos.z, 0.5);
        p.note('You take and eat the fresh shawarma', 'good');
      },
    });
  }
  private available(p: Player) {
    const { cycle, serving } = melabesPhase(this.time());
    return serving && this.taken.get(p.index) !== cycle;
  }
  get remaining() {
    const { cycle } = melabesPhase(this.time());
    return this.players().filter((p) => p.alive && this.taken.get(p.index) !== cycle).length;
  }
}
