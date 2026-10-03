import { paneKey, wallAabbs } from '../world/interiors';
import { newAabbId, type Aabb } from '../world/layout';
import type { ChunkData } from '../world/chunkgen';
import { CHUNK } from '../world/terrain';
import type { BuildingView } from '../render/buildingView';
import type { ChunkView } from '../render/chunkview';
import { breachWall, breachWidth, wallDamage, wallHp } from '../sim/breach';
import type { Surface } from '../sim/ballistics';
import { GLASS_HP, glassDamage, shardCount, stageOf } from '../sim/glass';
import type { PaneSet } from '../render/glass';
import type { Ctx } from './ctx';

export type DamageHow = 'bullet' | 'blast' | 'ram';

/** Where a blow landed, and the way the face it hit looks (for cracks). */
export interface HitAt {
  x: number;
  y: number;
  z: number;
  nx?: number;
  ny?: number;
  nz?: number;
}

/** What a scene exposes to weapons that can break the world. Absent where nothing can be (camp, caves). */
export interface WorldDamage {
  /** Walls breached so far. */
  readonly breaches: number;
  /** Panes of glass broken so far. */
  readonly panes: number;
  /** Hurt a box. Returns true if it broke. */
  hit(a: Aabb, dmg: number, how: DamageHow, at: HitAt, radius?: number): boolean;
  /** Everything breakable within reach of a blast takes damage by distance. */
  blast(x: number, y: number, z: number, radius: number, damage: number): void;
}

/** What the leg scene gives the rules that break things: where the chunks and building views are. */
export interface DestructionHost {
  buildings(): BuildingView[];
  /** The chunk's own cached data (what a reload builds from), and the view if it is streamed in. */
  chunk(cx: number, cz: number): { data: ChunkData; view?: ChunkView } | null;
  /** A doorway the dead can use now exists in a ground-floor wall. */
  doorway(building: BuildingView, axis: 'x' | 'z', c: number, mid: number): void;
}

/**
 * Basic destruction of the wasteland: wall pieces of the roadside buildings take damage from bullets, blasts and rams, and
 * a piece that has had enough opens a breach. A breach is made in the building's plan, so everything that reads the plan
 * follows: the mesh is rebuilt with the gap and its ragged edge, the colliders are swapped, and the dead and the player can
 * walk through. The chunk data is edited in place, so a reload of the chunk keeps the hole. Flimsy barricades break on
 * damage too, by the same call.
 */
export class Destruction implements WorldDamage {
  /** Hit points left on a wall piece that has been hurt. */
  private hp = new Map<number, number>();
  /** Breaches made, for tests and the HUD. */
  breaches = 0;
  /** Panes of glass broken so far. */
  panes = 0;

  constructor(
    private ctx: Ctx,
    private host: DestructionHost,
  ) {}

  hit(a: Aabb, dmg: number, how: DamageHow, at: HitAt, radius = 0): boolean {
    const ctx = this.ctx;
    if (a.kind === 'barricade') {
      if (a.breakable !== 'flimsy' || how === 'ram') return false;
      a.hp -= dmg * (how === 'blast' ? 1.4 : 1);
      if (a.hp > 0) return false;
      ctx.breakBarricade(a, 'smash');
      return true;
    }
    if (a.mat === 'glass' && a.kind === 'partition') return this.glassHit(a, dmg, how, at);
    if (a.kind !== 'partition' || a.wall === undefined) return false;
    const mat: Surface = a.mat ?? 'wood';
    const max = wallHp(mat);
    if (max === null) return false;
    const left = (this.hp.get(a.id) ?? max) - wallDamage(how, dmg);
    if (left <= 0 && mat === 'glass') return this.shatter(a, at);
    if (left > 0) {
      const was = this.hp.get(a.id) ?? max;
      this.hp.set(a.id, left);
      // Crossing two thirds and one third of its strength, the wall cracks round the spot.
      if (how !== 'blast' && at.nx !== undefined && ((was > max * 0.66 && left <= max * 0.66) || (was > max * 0.33 && left <= max * 0.33))) {
        ctx.gore.crack(at.x, at.y, at.z, at.nx, at.ny ?? 0, at.nz ?? 0, 0.8 + (1 - left / max) * 0.7);
        ctx.audio.play('thud', at.x, at.z, 0.35);
      }
      return false;
    }
    return this.breach(a, at, how, radius);
  }

  blast(x: number, y: number, z: number, radius: number, damage: number) {
    const hits: { a: Aabb; d: number; px: number; pz: number }[] = [];
    this.ctx.obs.near(x, z, radius + 2, (a) => {
      if ((a.kind !== 'partition' && a.kind !== 'barricade') || y < a.y0 - 1.5 || y > a.y1 + 1.5) return;
      const px = Math.max(a.minX, Math.min(x, a.maxX));
      const pz = Math.max(a.minZ, Math.min(z, a.maxZ));
      const d = Math.hypot(px - x, pz - z);
      if (d < radius) hits.push({ a, d, px, pz });
    });
    // Nearest first, so the breach the blast makes is where it was strongest.
    hits.sort((p, q) => p.d - q.d);
    for (const h of hits) {
      // An earlier breach in the same wall may already have replaced this piece.
      if (!this.ctx.obs.byId(h.a.id)) continue;
      this.hit(h.a, damage * (1 - h.d / radius), 'blast', { x: h.px, y: Math.min(Math.max(y, h.a.y0 + 0.5), h.a.y1 - 0.3), z: h.pz }, radius);
    }
  }

  // ------------------------------------------------------------------ breaching

  private buildingOf(a: Aabb): BuildingView | null {
    const cx = (a.minX + a.maxX) / 2;
    const cz = (a.minZ + a.maxZ) / 2;
    for (const b of this.host.buildings()) {
      const p = b.plan;
      if (cx > p.x0 - 0.5 && cx < p.x1 + 0.5 && cz > p.z0 - 0.5 && cz < p.z1 + 0.5) return b;
    }
    return null;
  }

  private chunkOf(a: Aabb) {
    return this.host.chunk(Math.floor((a.minX + a.maxX) / 2 / CHUNK), Math.floor((a.minZ + a.maxZ) / 2 / CHUNK));
  }

  private breach(a: Aabb, at: HitAt, how: DamageHow, radius: number): boolean {
    const ctx = this.ctx;
    const bv = this.buildingOf(a);
    const wi = a.wall!;
    const w = bv?.plan.walls[wi];
    if (!bv || !w) return false;
    const plan = bv.plan;
    // Along the wall, where the hit was, kept inside the piece that took it.
    const lo = w.axis === 'x' ? a.minX : a.minZ;
    const hi = w.axis === 'x' ? a.maxX : a.maxZ;
    const along = Math.max(lo, Math.min(hi, w.axis === 'x' ? at.x : at.z));
    const op = breachWall(w, along, breachWidth(how, radius));
    if (!op) {
      // Too short a wall to open: it just stands, battered.
      this.hp.delete(a.id);
      return false;
    }
    // Every collider of this wall goes, and the wall's new pieces take their place.
    const old: Aabb[] = [];
    ctx.obs.near((plan.x0 + plan.x1) / 2, (plan.z0 + plan.z1) / 2, Math.hypot(plan.x1 - plan.x0, plan.z1 - plan.z0) / 2 + 2, (q) => {
      if (q.kind === 'partition' && q.wall === wi && (q.minX + q.maxX) / 2 > plan.x0 - 0.5 && (q.minX + q.maxX) / 2 < plan.x1 + 0.5 && (q.minZ + q.maxZ) / 2 > plan.z0 - 0.5 && (q.minZ + q.maxZ) / 2 < plan.z1 + 0.5) old.push(q);
    });
    if (!old.includes(a)) old.push(a);
    const fresh = wallAabbs(plan, w, wi, newAabbId);
    for (const q of old) this.swapOut(q);
    for (const q of fresh) this.swapIn(q);
    bv.rebuild();
    // Marks on the stretch that has gone go with it.
    const lvlBase = plan.floorY + w.level * plan.levelH;
    if (w.axis === 'x') ctx.gore.clearBox(op.a, op.b, lvlBase - 0.2, lvlBase + op.head, w.c - w.t / 2 - 0.12, w.c + w.t / 2 + 0.12);
    else ctx.gore.clearBox(w.c - w.t / 2 - 0.12, w.c + w.t / 2 + 0.12, lvlBase - 0.2, lvlBase + op.head, op.a, op.b);
    if (w.level === 0) this.host.doorway(bv, w.axis, w.c, (op.a + op.b) / 2);
    this.breaches++;
    // The wall comes down: dust, splinters, the crash of it, and anyone nearby hears.
    const mid = (op.a + op.b) / 2;
    const x = w.axis === 'x' ? mid : w.c;
    const z = w.axis === 'x' ? w.c : mid;
    const y = plan.floorY + 1.1;
    ctx.gore.debris(x, y, z, a.mat ?? 'wood', 1 + (op.b - op.a) / 2, w.axis === 'x' ? 0 : 1, w.axis === 'x' ? 1 : 0);
    ctx.audio.play('crash', x, z, 0.9);
    ctx.sig.emit(x, z, how === 'bullet' ? 55 : 85, 'noise');
    return true;
  }

  /** A pane takes a blow: it cracks as it weakens, and goes when it has had enough. */
  private glassHit(a: Aabb, dmg: number, how: DamageHow, at: HitAt): boolean {
    const kind = a.pane ?? 'window';
    const max = GLASS_HP[kind];
    const was = this.hp.get(a.id) ?? max;
    const left = was - glassDamage(how, dmg, kind);
    if (left <= 0) return a.wall !== undefined ? this.shatter(a, at) : this.shatterFront(a, at);
    this.hp.set(a.id, left);
    const stage = stageOf(left, max);
    const ref = this.paneRef(a);
    ref?.set.crack(ref.key, stage, [at.x, at.y, at.z]);
    if (stage > stageOf(was, max)) this.ctx.audio.play('hit', at.x, at.z, 0.3);
    return false;
  }

  /** The set of panes a pane's collider stands for, and the key it goes by there. */
  private paneRef(a: Aabb): { set: PaneSet; key: string } | null {
    if (a.wall !== undefined) {
      const bv = this.buildingOf(a);
      const w = bv?.plan.walls[a.wall];
      if (!bv || !w) return null;
      const lo = w.axis === 'x' ? a.minX : a.minZ;
      const op = w.ops.find((o) => o.kind === 'window' && o.glass === 'intact' && Math.abs(o.a - lo) < 0.05);
      if (!op) return null;
      const key = paneKey(a.wall, op);
      const set = bv.pane(key);
      return set ? { set, key } : null;
    }
    const set = this.chunkOf(a)?.view?.panes;
    return set?.has(String(a.id)) ? { set, key: String(a.id) } : null;
  }

  /** A pane in a street front goes: its collider is gone, a few teeth of glass stay in the frame, and the rest is on the pavement. */
  private shatterFront(a: Aabb, at: HitAt): boolean {
    const ctx = this.ctx;
    const ref = this.paneRef(a);
    ref?.set.shatter(ref.key);
    this.swapOut(a);
    const [nx, nz] = a.paneN ?? [0, 1];
    ctx.gore.shards(at.x, at.y, at.z, nx, nz, shardCount(Math.max(a.maxX - a.minX, a.maxZ - a.minZ) * (a.y1 - a.y0)));
    ctx.audio.play('glass', at.x, at.z, 0.9);
    ctx.sig.emit(at.x, at.z, 55, 'noise');
    this.panes++;
    return true;
  }

  /** A pane breaks: the window becomes a broken one in the plan, the pane's collider goes, glass flies. */
  private shatter(a: Aabb, at: HitAt): boolean {
    const ctx = this.ctx;
    const bv = this.buildingOf(a);
    const w = bv?.plan.walls[a.wall!];
    if (!bv || !w) return false;
    const lo = w.axis === 'x' ? a.minX : a.minZ;
    const op = w.ops.find((o) => o.kind === 'window' && o.glass === 'intact' && Math.abs(o.a - lo) < 0.05);
    this.swapOut(a);
    if (!op) return false;
    op.glass = 'broken';
    bv.rebuild();
    const nz = w.axis === 'x' ? 1 : 0;
    const nx = w.axis === 'x' ? 0 : 1;
    ctx.gore.shards(at.x, at.y, at.z, nx, nz);
    ctx.audio.play('glass', at.x, at.z, 0.8);
    ctx.sig.emit(at.x, at.z, 45, 'noise');
    this.panes++;
    return true;
  }

  private swapOut(q: Aabb) {
    this.hp.delete(q.id);
    this.ctx.obs.remove(q);
    const c = this.chunkOf(q);
    if (!c) return;
    for (const list of this.lists(c)) {
      const i = list.indexOf(q);
      if (i >= 0) list.splice(i, 1);
    }
    c.view?.removeAabb(q.id);
  }

  private swapIn(q: Aabb) {
    if (!q.physOnly) this.ctx.obs.add(q);
    const c = this.chunkOf(q);
    if (!c) return;
    for (const list of this.lists(c)) list.push(q);
    c.view?.addAabb(q);
  }

  /** The cache's box list and, if the streamed view was handed a filtered copy, that one too. */
  private lists(c: { data: ChunkData; view?: ChunkView }): Aabb[][] {
    const out = [c.data.aabbs];
    if (c.view && c.view.data.aabbs !== c.data.aabbs) out.push(c.view.data.aabbs);
    return out;
  }
}
