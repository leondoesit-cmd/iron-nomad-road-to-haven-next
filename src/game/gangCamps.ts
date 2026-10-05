import { GANGS } from '../data';
import { heightAt } from '../world/terrain';
import type { GangCampSpec } from '../world/gangCamps';
import { guardCount } from '../world/gangCamps';
import type { Ctx } from './ctx';
import type { Infantry } from './raiders';

/** Sentries are put on their posts once someone is this close, and not before, so a far camp costs nothing. */
const SPAWN_R = 170;
/** The radio names the gang the first time a camp comes within this distance. */
const WARN_R = 300;
/** A camp is drawn on the map once someone has come this close. */
const SEE_R = 420;
/** The fire burns for anyone this close. */
const FIRE_R = 110;

interface CampState {
  spec: GangCampSpec;
  /** Guard keys this camp keeps at the current difficulty. */
  keys: string[];
  units: Map<string, Infantry>;
  spawned: boolean;
  cleared: boolean;
  fireT: number;
}

/**
 * The runtime side of the gang camps (`world/gangCamps.ts` places them): sentries stand up when you come near, notice
 * you by sight and sound (`RaiderSystem.guardNotices`), raise the alarm together and call the camp's buggies, and
 * stay dead from one day to the next. A camp whose sentries are all dead is broken: the gang's pin leaves the map.
 */
export class GangCamps {
  readonly camps: CampState[] = [];

  constructor(
    private ctx: Ctx,
    specs: GangCampSpec[],
    /** Guards killed so far, by key. Lives in the world memory, so it outlasts the night. */
    private killed: Set<string>,
    /** Map and radio memory shared with the scene. */
    private seen: Set<string>,
  ) {
    const diff = ctx.campaign.difficulty.aggro;
    for (const spec of specs) {
      const n = guardCount(spec.tier);
      const keepGun = Math.max(1, Math.round(n.gunmen * (0.8 + 0.2 * diff)));
      const keys: string[] = [];
      let gun = 0;
      spec.guards.forEach((g, i) => {
        if (g.kind === 'gunman' && ++gun > keepGun) return;
        keys.push(`${spec.id}#${i}`);
      });
      this.camps.push({ spec, keys, units: new Map(), spawned: false, cleared: keys.every((k) => killed.has(k)), fireT: 0 });
    }
  }

  isCleared(id: string): boolean {
    return !!this.camps.find((c) => c.spec.id === id)?.cleared;
  }

  /**
   * A camp the convoy has not yet come near, for someone on the road to tell them about: the nearest unbroken one within
   * reach of (x, z). It goes on the map as though it had been seen.
   */
  rumour(x: number, z: number, reach = 1500): { gang: string; x: number; z: number } | null {
    let best: CampState | null = null;
    let bd = reach;
    for (const c of this.camps) {
      if (c.cleared || this.seen.has(`g${c.spec.id}`)) continue;
      const d = Math.hypot(c.spec.x - x, c.spec.z - z);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    if (!best) return null;
    this.seen.add(`g${best.spec.id}`);
    return { gang: GANGS[best.spec.gang].name, x: best.spec.x, z: best.spec.z };
  }

  /** Is (x, z) within `r` metres of a camp that still stands? */
  nearStanding(x: number, z: number, r: number): boolean {
    return this.camps.some((c) => !c.cleared && Math.hypot(c.spec.x - x, c.spec.z - z) < r);
  }

  /** Pins for the compass and map: camps the convoy has seen and not yet broken. */
  pins(): { x: number; z: number; label: string }[] {
    const out: { x: number; z: number; label: string }[] = [];
    for (const c of this.camps) {
      if (c.cleared || !this.seen.has(`g${c.spec.id}`)) continue;
      out.push({ x: c.spec.x, z: c.spec.z, label: GANGS[c.spec.gang].name.split(' ')[1].toUpperCase() });
    }
    return out;
  }

  update(dt: number) {
    const ctx = this.ctx;
    for (const c of this.camps) {
      if (c.cleared) continue;
      const s = c.spec;
      let near = Infinity;
      for (const p of ctx.players) {
        if (!p.alive) continue;
        const x = p.vehicle ? p.vehicle.position.x : p.pos.x;
        const z = p.vehicle ? p.vehicle.position.z : p.pos.z;
        near = Math.min(near, Math.hypot(x - s.x, z - s.z));
      }
      if (near < SEE_R) this.seen.add(`g${s.id}`);
      if (near < WARN_R && !this.seen.has(`w${s.id}`)) {
        this.seen.add(`w${s.id}`);
        // One warning per gang is enough: the next camp of theirs is not news.
        if (!this.seen.has(`wg${s.gang}`)) {
          this.seen.add(`wg${s.gang}`);
          ctx.radio(GANGS[s.gang].warning);
        }
      }
      if (!c.spawned && near < SPAWN_R) this.spawn(c);
      if (near < FIRE_R) this.burn(c, dt);
      if (c.spawned) this.track(c);
    }
  }

  private spawn(c: CampState) {
    c.spawned = true;
    const gang = GANGS[c.spec.gang];
    const look = { jacket: gang.jacket, trim: gang.trim, helmet: gang.helmet };
    for (const key of c.keys) {
      if (this.killed.has(key)) continue;
      const i = Number(key.slice(key.indexOf('#') + 1));
      const g = c.spec.guards[i];
      const u = this.ctx.raiders.spawnInfantry(g.kind, g.x, g.z, { post: { camp: c.spec.id, x: g.x, z: g.z, patrol: g.patrol }, look });
      c.units.set(key, u);
    }
  }

  /** Remember who has died, and call the camp broken when the last sentry goes. */
  private track(c: CampState) {
    for (const [key, u] of c.units) if (u.dead) this.killed.add(key);
    if (!c.keys.every((k) => this.killed.has(k))) return;
    c.cleared = true;
    const gang = GANGS[c.spec.gang];
    this.ctx.radio(`The ${gang.name} camp is broken. Whatever they were sitting on is yours for the taking.`);
    for (const p of this.ctx.players) p.note(`${gang.name} camp cleared`, 'good');
  }

  /** The fire in the middle of every camp, and the smoke over it. */
  private burn(c: CampState, dt: number) {
    c.fireT -= dt;
    if (c.fireT > 0) return;
    c.fireT = 0.07;
    const { x, z } = c.spec;
    const y = heightAt(this.ctx.terrain!, x, z) + 0.15;
    this.ctx.fx.fire(x, y, z, 1.1);
    if (Math.random() < 0.3) this.ctx.fx.smoke.emit(x + (Math.random() - 0.5) * 0.4, y + 1.2, z + (Math.random() - 0.5) * 0.4, 0.3, 1.6, 0.2, 3.2, 0.5, 2.6, 0.2, 0.19, 0.18, 0.5, -0.1, 0.8);
  }
}
