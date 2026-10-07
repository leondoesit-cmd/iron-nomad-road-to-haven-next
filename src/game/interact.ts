import type { Player } from './player';

export interface Interactable {
  id: string;
  x: number;
  z: number;
  r: number;
  prompt: string;
  /** Hold time in seconds. */
  dur: number;
  priority: number;
  /** A direct handoff takes precedence over loose ground pickups and vehicle tools. */
  direct?: boolean;
  enabled(p: Player): boolean;
  /** Called every tick while the hold progresses. Return false to cancel. */
  onTick?(p: Player, t: number): boolean | void;
  run(p: Player): void;
}

/** Things players can hold A on: loot containers, camp workbench, watch posts, and so on. */
export class InteractRegistry {
  list: Interactable[] = [];

  add(i: Interactable) {
    this.list.push(i);
    return i;
  }

  remove(id: string) {
    this.list = this.list.filter((i) => i.id !== id);
  }

  removeWhere(fn: (i: Interactable) => boolean) {
    this.list = this.list.filter((i) => !fn(i));
  }

  nearest(p: Player): Interactable | null {
    let best: Interactable | null = null;
    let bd = Infinity;
    for (const i of this.list) {
      const d = Math.hypot(i.x - p.pos.x, i.z - p.pos.z);
      if (d > i.r) continue;
      if (!i.enabled(p)) continue;
      const score = d - i.priority * 2;
      if (score < bd) {
        bd = score;
        best = i;
      }
    }
    return best;
  }

  clear() {
    this.list = [];
  }
}
