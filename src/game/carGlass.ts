import { carPanes } from '../render/carModels';
import { SPECS, restHeight } from '../render/carSpecs';
import { rotateByQuat } from '../physics/vehicle';
import { blastGlassDamage, crashGlassDamage, glassDamage, hitPane, newPane, shardCount, type CarPane, type GlassHow, type PaneStage, type PaneState } from '../sim/glass';
import type { Vehicle } from './vehicle';

type V3 = [number, number, number];

/** What a pane is called when it is fitted new. */
const NAMES: Record<CarPane['kind'], string> = { window: 'window', shop: 'window', screen: 'windscreen', side: 'side window', rear: 'rear window' };

/**
 * The windows of one car: how much each has taken, what it shows (the visual's `PaneSet` follows), and what breaks them.
 * Bullets are traced through the panes (the car's collider is a box, so the point it struck on says nothing about the
 * glass), a crash hurts the glass that faces it, a blast breaks the lot by how close it was.
 */
export class CarGlass {
  private specs: CarPane[] = [];
  private state = new Map<string, PaneState>();

  constructor(private v: Vehicle) {
    this.bind();
  }

  /** Bind to the vehicle's current model (after it was built or rebuilt): the panes keep the state they had. */
  bind() {
    const v = this.v;
    this.specs = v.visual.panes ? carPanes(v.def) : [];
    const saved = v.build?.body?.glass;
    const old = this.state;
    this.state = new Map();
    for (const sp of this.specs) {
      const was = old.get(sp.key);
      const p = was ?? newPane(sp.kind);
      if (!was && saved && saved[sp.key] !== undefined) this.restorePane(p, saved[sp.key] as PaneStage);
      this.state.set(sp.key, p);
      this.show(sp, p);
    }
    this.followPanels();
  }

  private restorePane(p: PaneState, stage: PaneStage) {
    // Mid-way into the stage it was saved in.
    p.stage = stage;
    p.hp = stage === 3 ? 0 : stage === 2 ? p.max * 0.2 : stage === 1 ? p.max * 0.5 : p.max;
  }

  /** Put what the visual shows in step with a pane's state, with no sound or spray. */
  private show(sp: CarPane, p: PaneState) {
    const set = this.v.visual.panes;
    if (!set || !set.has(sp.key)) return;
    if (p.stage === 3) set.shatter(sp.key);
    else if (p.stage > 0) set.crack(sp.key, p.stage, sp.c);
    else set.mend(sp.key);
  }

  /** A hatchback's rear glass is part of its tailgate: it swings open with the tailgate on the roof hinge. */
  followPanels() {
    const set = this.v.visual.panes;
    if (!set || this.v.def.id !== 'hatch') return;
    const torn = !!this.v.bodywork?.gonePanels().trunk;
    if (torn) {
      for (const sp of this.specs) if (sp.kind === 'rear') set.hide(sp.key, true);
      return;
    }
    const k = this.v.swing.trunk;
    const angle = this.v.def.id === 'hatch' ? 1.3 : 1.15;
    const e = k * k * (3 - 2 * k) * angle;
    const sp = SPECS.hatch;
    const g0 = restHeight(this.v.def);
    const pivot: V3 = [0, sp.roof + 0.02 - g0, sp.rwTop];
    for (const p of this.specs) {
      if (p.kind === 'rear') {
        set.hide(p.key, false);
        set.pose(p.key, pivot, e);
      }
    }
  }

  get count() {
    return this.specs.length;
  }

  /** Stage of each pane that is not whole, for the save. */
  stages(): Record<string, number> | null {
    const out: Record<string, number> = {};
    for (const [k, p] of this.state) if (p.stage > 0) out[k] = p.stage;
    return Object.keys(out).length ? out : null;
  }

  stageOf(key: string): PaneStage {
    return this.state.get(key)?.stage ?? 0;
  }

  /** Panes that have gone. */
  broken(): number {
    let n = 0;
    for (const p of this.state.values()) if (p.stage === 3) n++;
    return n;
  }

  /** Fit new glass in the first pane that has gone, or failing that mend one that is only cracked. Returns its name. */
  mendOne(): string | null {
    let pick: [string, PaneState] | null = null;
    for (const e of this.state) if (e[1].stage === 3) pick = pick ?? e;
    if (!pick) for (const e of this.state) if (e[1].stage > 0) pick = pick ?? e;
    if (!pick) return null;
    const [key, p] = pick;
    p.hp = p.max;
    p.stage = 0;
    this.v.visual.panes?.mend(key);
    const sp = this.specs.find((s) => s.key === key);
    return sp ? NAMES[sp.kind] : 'glass';
  }

  // ------------------------------------------------------------------ frames

  private world(sp: CarPane): { c: V3; n: V3; u: V3; w: V3 } {
    const v = this.v;
    let localC = sp.c;
    let localN = sp.n;
    if (sp.kind === 'rear' && v.def.id === 'hatch' && v.swing.trunk > 0.001) {
      const k = v.swing.trunk;
      const angle = 1.3;
      const e = k * k * (3 - 2 * k) * angle;
      const spec = SPECS.hatch;
      const g0 = restHeight(v.def);
      const py = spec.roof + 0.02 - g0;
      const pz = spec.rwTop;
      const dy = sp.c[1] - py;
      const dz = sp.c[2] - pz;
      const cos = Math.cos(e);
      const sin = Math.sin(e);
      localC = [sp.c[0], py + dy * cos - dz * sin, pz + dy * sin + dz * cos];
      localN = [sp.n[0], sp.n[1] * cos - sp.n[2] * sin, sp.n[1] * sin + sp.n[2] * cos];
    }
    const c = v.body.toWorld(localC[0], localC[1], localC[2]);
    const q = v.body.body.rotation();
    const n = rotateByQuat(q, localN[0], localN[1], localN[2]);
    // Across the glass (level) and up it, the way PaneSet lays them out.
    let ux = sp.n[2];
    let uz = -sp.n[0];
    const ul = Math.hypot(ux, uz);
    const u: V3 = ul < 1e-4 ? [1, 0, 0] : [ux / ul, 0, uz / ul];
    ux = u[0];
    uz = u[2];
    const wv: V3 = [sp.n[1] * u[2] - sp.n[2] * u[1], sp.n[2] * u[0] - sp.n[0] * u[2], sp.n[0] * u[1] - sp.n[1] * u[0]];
    const wl = Math.hypot(wv[0], wv[1], wv[2]) || 1;
    return { c, n, u: rotateByQuat(q, u[0], u[1], u[2]), w: rotateByQuat(q, wv[0] / wl, wv[1] / wl, wv[2] / wl) };
  }

  private local(x: number, y: number, z: number): V3 {
    const t = this.v.body.body.translation();
    const q = this.v.body.body.rotation();
    return rotateByQuat({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, x - t.x, y - t.y, z - t.z);
  }

  // ------------------------------------------------------------------ blows

  /**
   * A round (or anything that travels a line) struck the car at (x, y, z) heading (dx, dy, dz): the first pane that line
   * crosses inside the car takes it. Returns the pane's key if one was hit.
   */
  hitRay(x: number, y: number, z: number, dx: number, dy: number, dz: number, amount: number, how: GlassHow = 'bullet'): string | null {
    let best: { sp: CarPane; t: number; at: V3 } | null = null;
    for (const sp of this.specs) {
      const p = this.state.get(sp.key)!;
      if (p.stage === 3) continue;
      const w = this.world(sp);
      const denom = dx * w.n[0] + dy * w.n[1] + dz * w.n[2];
      if (Math.abs(denom) < 1e-4) continue;
      const t = ((w.c[0] - x) * w.n[0] + (w.c[1] - y) * w.n[1] + (w.c[2] - z) * w.n[2]) / denom;
      if (t < -0.15 || t > 7.5) continue;
      const hx = x + dx * t - w.c[0];
      const hy = y + dy * t - w.c[1];
      const hz = z + dz * t - w.c[2];
      const a = hx * w.u[0] + hy * w.u[1] + hz * w.u[2];
      const b = hx * w.w[0] + hy * w.w[1] + hz * w.w[2];
      if (Math.abs(a) > sp.hw + 0.04 || Math.abs(b) > sp.hh + 0.04) continue;
      if (!best || t < best.t) best = { sp, t, at: [x + dx * t, y + dy * t, z + dz * t] };
    }
    if (!best) return null;
    this.damage(best.sp, glassDamage(how, amount, best.sp.kind), how, best.at, [dx, dy, dz]);
    return best.sp.key;
  }

  /** Something hit the car at a point (a fist, a pipe, a shoulder): the nearest pane within reach takes it. */
  hitNear(x: number, y: number, z: number, amount: number, how: GlassHow, reach = 0.8): string | null {
    let best: { sp: CarPane; d: number } | null = null;
    for (const sp of this.specs) {
      if (this.state.get(sp.key)!.stage === 3) continue;
      const w = this.world(sp);
      const d = Math.hypot(w.c[0] - x, w.c[1] - y, w.c[2] - z) - Math.max(sp.hw, sp.hh) * 0.5;
      if (d < reach && (!best || d < best.d)) best = { sp, d };
    }
    if (!best) return null;
    const w = this.world(best.sp);
    this.damage(best.sp, glassDamage(how, amount, best.sp.kind), how, [x, y, z], [-w.n[0], -w.n[1], -w.n[2]]);
    return best.sp.key;
  }

  /** A crash. `dirX/dirZ` point from the car toward what it hit (as the physics reports it). */
  crash(impact: number, dirX: number, dirZ: number) {
    const l = Math.hypot(dirX, dirZ) || 1;
    for (const sp of this.specs) {
      const p = this.state.get(sp.key)!;
      if (p.stage === 3) continue;
      const w = this.world(sp);
      const facing = (w.n[0] * dirX + w.n[2] * dirZ) / l;
      const dmg = crashGlassDamage(impact, facing);
      if (dmg > 0) this.damage(sp, dmg, 'crash', w.c, [w.n[0], w.n[1], w.n[2]]);
    }
  }

  /** A blast (`f` is 1 at the car, 0 at the edge of the blast). */
  blast(f: number) {
    for (const sp of this.specs) {
      const p = this.state.get(sp.key)!;
      if (p.stage === 3) continue;
      const w = this.world(sp);
      this.damage(sp, blastGlassDamage(f, sp.kind), 'blast', w.c, [w.n[0], w.n[1], w.n[2]]);
    }
  }

  /** Every pane goes (the car burns out). */
  shatterAll(quiet = false) {
    for (const sp of this.specs) {
      const p = this.state.get(sp.key)!;
      if (p.stage === 3) continue;
      p.hp = 0;
      p.stage = 3;
      this.v.visual.panes?.shatter(sp.key);
      if (!quiet) this.spray(sp, this.world(sp).c, this.world(sp).n, 8);
    }
  }

  // ------------------------------------------------------------------ one pane

  private damage(sp: CarPane, amount: number, how: GlassHow, at: V3, dir: V3) {
    const p = this.state.get(sp.key)!;
    const r = hitPane(p, amount);
    const set = this.v.visual.panes;
    const lp = this.local(at[0], at[1], at[2]);
    const w = this.world(sp);
    // Glass flies the way the blow went, and a little back at the one who hit it.
    const flipped = dir[0] * w.n[0] + dir[1] * w.n[1] + dir[2] * w.n[2] > 0 ? 1 : -1;
    if (r.broke) {
      set?.shatter(sp.key);
      this.spray(sp, at, [w.n[0] * flipped, w.n[1], w.n[2] * flipped], shardCount(sp.hw * sp.hh * 4));
    } else if (r.to > r.from || how === 'bullet') {
      // A round leaves its web even when it does not change the stage.
      set?.crack(sp.key, r.to, how === 'bullet' ? lp : undefined);
      if (r.to > r.from) this.v.ctx.audio.play('hit', at[0], at[2], 0.35);
    }
  }

  private spray(sp: CarPane, at: V3, n: V3, count: number) {
    const ctx = this.v.ctx;
    ctx.gore.shards(at[0], at[1], at[2], n[0], n[2], count);
    ctx.audio.play('glass', at[0], at[2], 0.8);
    ctx.sig.emit(at[0], at[2], 35, 'noise');
  }

  /** Hit points left in a pane, for tests. */
  hpOf(key: string): number {
    return this.state.get(key)?.hp ?? 0;
  }

  /** Pane keys, for tests. */
  keys(): string[] {
    return this.specs.map((s) => s.key);
  }

  kindOf(key: string) {
    return this.specs.find((s) => s.key === key)?.kind;
  }
}
