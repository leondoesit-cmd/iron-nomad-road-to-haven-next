import { clamp, damp } from '../core/math';
import type { ZombieKind } from '../data';
import type { ZombieRenderer } from '../render/zombieRender';
import type { Ctx } from './ctx';
import type { Player } from './player';

/**
 * Things that are not there. Each player who is tripping sees their own: they are drawn into that player's view only,
 * and nothing in the real world knows about them. They cannot hurt anyone, and shots go through them.
 *
 * What tells one from the real thing:
 *  - it shimmers and casts no shadow (less so the deeper the trip: at the top they look almost real);
 *  - it dissolves if you look straight at it for a moment, or walk into it, or hit it;
 *  - it never shows up on the compass, never growls, and the dead around you do not react to it.
 * What it costs you: every shot at one is a wasted round and a noise the real dead can hear, and the ones that creep up
 * on you are very good at making you do something stupid.
 */

export type PhantomKind = 'ghoul' | 'spirit' | 'dancer';

export interface Phantom {
  id: number;
  kind: PhantomKind;
  /** Which body to draw. */
  zk: ZombieKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  age: number;
  life: number;
  /** 0..1 how much of it is there. */
  alpha: number;
  /** Seconds spent looked at. */
  seen: number;
  phase: number;
  speed: number;
  scale: number;
  variant: number;
  /** Seconds left dissolving; 0 while solid. */
  popT: number;
  /** Orbit angle, for dancers. */
  orbit: number;
}

let pid = 1;
const GHOUL_BODIES: [ZombieKind, number][] = [
  ['walker', 0.55],
  ['runner', 0.2],
  ['stalker', 0.1],
  ['screamer', 0.08],
  ['brute', 0.07],
];

const POP_TIME = 0.5;

export class PhantomSystem {
  list: [Phantom[], Phantom[]] = [[], []];
  /** Where phantoms dissolved this frame, per player, for the world effects to puff spores at. */
  pops: [{ x: number; y: number; z: number; seed: number }[], { x: number; y: number; z: number; seed: number }[]] = [[], []];

  constructor(private ctx: Ctx) {}

  count(i: number) {
    return this.list[i]?.length ?? 0;
  }

  clear() {
    this.list[0].length = 0;
    this.list[1].length = 0;
    this.pops[0].length = 0;
    this.pops[1].length = 0;
  }

  update(dt: number) {
    const ctx = this.ctx;
    for (const p of ctx.players) {
      const i = p.index;
      const list = this.list[i];
      const living = p.state === 'foot' || p.state === 'driving' || p.state === 'gunner';
      const ph = living ? p.drugs.mods().phantoms : 0;
      const cap = Math.ceil(ph * 5);
      // Spawn.
      if (living && list.length < cap && Math.random() < ph * 0.07 * dt) this.spawn(p, false);
      // Live.
      for (let n = list.length - 1; n >= 0; n--) {
        const f = list[n];
        this.step(p, f, dt, ph);
        if (f.popT <= 0 && f.alpha <= 0 && f.age > f.life) list.splice(n, 1);
        else if (f.popT === -1) list.splice(n, 1);
      }
    }
  }

  /** A sudden one close behind you: paranoia. */
  startle(p: Player) {
    if (this.list[p.index].length >= 8) return;
    this.spawn(p, true);
    this.ctx.audio.play('whisper', p.pos.x, p.pos.z, 0.5);
  }

  private spawn(p: Player, behind: boolean) {
    const ctx = this.ctx;
    const d = p.drugs;
    const friendly = d.friendly;
    // Mostly in front, where you will see it; sometimes where you cannot.
    const f = p.cam.fwd;
    const base = Math.atan2(f.x, f.z);
    const ang = behind ? base + Math.PI + (Math.random() - 0.5) * 1.2 : base + (Math.random() - 0.5) * (Math.random() < 0.75 ? 1.7 : Math.PI * 2);
    const dist = behind ? 5 + Math.random() * 3 : 14 + Math.random() * 18;
    const cx = p.vehicle ? p.vehicle.position.x : p.pos.x;
    const cz = p.vehicle ? p.vehicle.position.z : p.pos.z;
    const x = cx + Math.sin(ang) * dist;
    const z = cz + Math.cos(ang) * dist;
    if (ctx.waterAt(x, z)) return;
    if (ctx.bounds && (x < ctx.bounds.minX || x > ctx.bounds.maxX || z < ctx.bounds.minZ || z > ctx.bounds.maxZ)) return;
    const spirit = d.intensity('ayahuasca') > 0.3 && Math.random() < 0.5;
    const kind: PhantomKind = friendly ? 'dancer' : spirit ? 'spirit' : 'ghoul';
    let zk: ZombieKind = 'walker';
    if (kind === 'ghoul') {
      let r = Math.random();
      for (const [k, w] of GHOUL_BODIES) {
        r -= w;
        if (r <= 0) {
          zk = k;
          break;
        }
      }
    } else if (kind === 'spirit') zk = 'stalker';
    const life = kind === 'dancer' ? 20 + Math.random() * 20 : kind === 'spirit' ? 12 + Math.random() * 10 : 9 + Math.random() * 12;
    this.list[p.index].push({
      id: pid++,
      kind,
      zk,
      x,
      y: ctx.groundAt(x, z),
      z,
      yaw: Math.atan2(cx - x, cz - z),
      age: 0,
      life,
      alpha: 0,
      seen: 0,
      phase: Math.random() * 6.28,
      speed: kind === 'ghoul' ? (zk === 'runner' ? 3.2 : 1.2 + Math.random() * 1.1) : kind === 'dancer' ? 1.2 : 0.4,
      scale: kind === 'spirit' ? 1.5 : kind === 'dancer' ? 0.9 + Math.random() * 0.2 : ctx_scale(zk),
      variant: Math.floor(Math.random() * 5),
      popT: 0,
      orbit: Math.random() * Math.PI * 2,
    });
  }

  private step(p: Player, f: Phantom, dt: number, ph: number) {
    const ctx = this.ctx;
    f.age += dt;
    f.phase += dt * 2;
    // Dissolving.
    if (f.popT > 0) {
      f.popT -= dt;
      f.alpha = Math.max(0, f.popT / POP_TIME);
      if (f.popT <= 0) f.popT = -1;
      return;
    }
    const cx = p.vehicle ? p.vehicle.position.x : p.pos.x;
    const cz = p.vehicle ? p.vehicle.position.z : p.pos.z;
    const dx = cx - f.x;
    const dz = cz - f.z;
    const d = Math.hypot(dx, dz);
    // The trip is wearing off: they fade first.
    const ending = ph <= 0.01;
    const fadeIn = clamp(f.age / 1.2, 0, 1);
    const fadeOut = ending ? 0 : clamp((f.life - f.age) / 1.5, 0, 1);
    const target = Math.min(fadeIn, fadeOut);
    f.alpha = damp(f.alpha, target, 6, dt);
    if (ending && f.alpha < 0.02) {
      f.alpha = 0;
      f.popT = -1;
      return;
    }
    if (f.age > f.life) {
      if (f.alpha < 0.02) f.popT = -1;
      return;
    }
    // Being looked at: they cannot take it.
    const fw = p.cam.fwd;
    const look = d > 0.01 ? (fw.x * -dx + fw.z * -dz) / d : 0;
    if (look > 0.94 && d > 5 && f.kind !== 'dancer') f.seen += dt;
    else f.seen = Math.max(0, f.seen - dt * 0.5);
    if (f.seen > 1.6) return this.pop(p, f, false);
    switch (f.kind) {
      case 'ghoul': {
        // Creep closer, in the way that makes your skin crawl: faster when you are not looking.
        const sp = f.speed * (look > 0.5 ? 0.5 : 1.15);
        const nx = dx / (d || 1);
        const nz = dz / (d || 1);
        f.x += nx * sp * dt;
        f.z += nz * sp * dt;
        f.yaw = Math.atan2(nx, nz);
        if (d < 4.2) return this.pop(p, f, true);
        break;
      }
      case 'spirit': {
        // Stands and watches. Edges away if you come near.
        f.yaw = Math.atan2(dx, dz);
        if (d < 7) {
          f.x -= (dx / (d || 1)) * 1.2 * dt;
          f.z -= (dz / (d || 1)) * 1.2 * dt;
        }
        break;
      }
      case 'dancer': {
        // Circle you, dancing.
        f.orbit += dt * 0.5;
        const r = 5 + Math.sin(f.phase * 0.3) * 1.2;
        const tx = cx + Math.cos(f.orbit) * r;
        const tz = cz + Math.sin(f.orbit) * r;
        f.x = damp(f.x, tx, 1.5, dt);
        f.z = damp(f.z, tz, 1.5, dt);
        f.yaw += dt * 2.2;
        break;
      }
    }
    f.y = ctx.groundAt(f.x, f.z);
  }

  private pop(p: Player, f: Phantom, scare: boolean) {
    f.popT = POP_TIME;
    this.pops[p.index].push({ x: f.x, y: f.y + 1, z: f.z, seed: f.variant / 5 });
    this.ctx.audio.play('whisper', f.x, f.z, 0.35);
    // Walking into one is a shock even when you know.
    if (scare) {
      p.cam.addShake(0.3);
      p.note('It was not there', 'info');
    }
  }

  // ------------------------------------------------------------------ the world poking back

  /** A shot passes through them: the nearest one in line dissolves. The round is gone, and so is the quiet. */
  onShot(p: Player, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number) {
    const list = this.list[p.index];
    if (!list.length) return;
    const dh = Math.hypot(dx, dz);
    if (dh < 1e-6) return;
    const ux = dx / dh;
    const uz = dz / dh;
    let best: Phantom | null = null;
    let bt = Infinity;
    for (const f of list) {
      if (f.popT !== 0 || f.alpha < 0.2) continue;
      const vx = f.x - ox;
      const vz = f.z - oz;
      const t0 = vx * ux + vz * uz;
      if (t0 < 0 || t0 > 80) continue;
      const cx = ox + ux * t0;
      const cz = oz + uz * t0;
      if (Math.hypot(cx - f.x, cz - f.z) > 0.55 * f.scale + 0.15) continue;
      const yy = oy + dy * (t0 / dh);
      if (yy < f.y - 0.1 || yy > f.y + 1.9 * f.scale) continue;
      if (t0 < bt) {
        bt = t0;
        best = f;
      }
    }
    if (best) this.pop(p, best, false);
  }

  /** A swing at one dissolves it too. */
  onSwing(p: Player, hx: number, hz: number) {
    for (const f of this.list[p.index]) {
      if (f.popT !== 0 || f.alpha < 0.2) continue;
      if (Math.hypot(f.x - hx, f.z - hz) < 1.6) this.pop(p, f, false);
    }
  }

  // ------------------------------------------------------------------ drawing

  /** Put one player's phantoms into the ghost renderer, ready for that player's view. */
  render(i: number, zr: ZombieRenderer, time: number) {
    zr.begin();
    const list = this.list[i];
    const p = this.ctx.players[i];
    // The deeper the trip, the more real they look.
    const ph = p ? p.drugs.mods().phantoms : 0;
    zr.setGhostTint(1 - 0.65 * clamp(ph, 0, 1));
    for (const f of list) {
      if (f.alpha <= 0.01) continue;
      const moving = f.kind === 'ghoul' ? f.speed : f.kind === 'dancer' ? 5 : 0.4;
      const hover = f.kind === 'spirit' ? 0.25 + Math.sin(f.phase * 0.7) * 0.15 : 0;
      zr.push(f.zk, f.scale, f.x, f.y + hover, f.z, f.yaw, f.phase, moving * 2.2, f.kind === 'ghoul' ? 0.6 : 0, 0, f.variant, f.alpha * (0.8 + 0.2 * Math.sin(time * 13 + f.phase)));
    }
    zr.end(time);
    return zr.count;
  }
}

const SCALES: Partial<Record<ZombieKind, number>> = { brute: 1.2, bloater: 1.15 };
function ctx_scale(k: ZombieKind) {
  return SCALES[k] ?? 1;
}
