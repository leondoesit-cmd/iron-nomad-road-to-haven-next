import * as THREE from 'three';
import type { Aabb } from '../world/layout';
import type { Ctx } from './ctx';
import type { Player } from './player';

interface Throw {
  kind: 'flare' | 'molotov';
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  owner: Player | null;
  t: number;
}
interface Burner {
  kind: 'flare' | 'fire';
  x: number;
  z: number;
  r: number;
  t: number;
  tick: number;
  owner: Player | null;
}
interface Charge {
  aabb: Aabb;
  x: number;
  z: number;
  t: number;
  owner: Player | null;
}
interface Decoy {
  x: number;
  z: number;
  t: number;
  tick: number;
}

/** Thrown items and placed devices: flares, molotovs, breaching charges and the decoy horn. */
export class Projectiles {
  flying: Throw[] = [];
  burners: Burner[] = [];
  charges: Charge[] = [];
  decoys: Decoy[] = [];
  /** One shared light follows the freshest flare so night camps get a real glow without a light per flare. */
  light = new THREE.PointLight(0xff4a2a, 0, 55, 1.6);

  constructor(private ctx: Ctx) {
    ctx.root.add(this.light);
  }

  throw(kind: 'flare' | 'molotov', x: number, y: number, z: number, vx: number, vy: number, vz: number, owner: Player | null) {
    this.flying.push({ kind, x, y, z, vx, vy, vz, owner, t: 0 });
    this.ctx.audio.play('swing', x, z, 0.4);
  }

  decoy(x: number, z: number) {
    this.decoys.push({ x, z, t: 8, tick: 0 });
    this.ctx.audio.play('horn', x, z, 1);
  }

  nearestBreachable(x: number, z: number, r: number): Aabb | null {
    let best: Aabb | null = null;
    let bd = r;
    this.ctx.obs.near(x, z, r + 6, (a) => {
      if (a.kind !== 'barricade' || a.breakable !== 'reinforced') return;
      const cx = Math.max(a.minX, Math.min(x, a.maxX));
      const cz = Math.max(a.minZ, Math.min(z, a.maxZ));
      const d = Math.hypot(cx - x, cz - z);
      if (d < bd) {
        bd = d;
        best = a;
      }
    });
    return best;
  }

  placeCharge(a: Aabb, owner: Player | null) {
    this.charges.push({ aabb: a, x: (a.minX + a.maxX) / 2, z: (a.minZ + a.maxZ) / 2, t: 4, owner });
    this.ctx.audio.play('beep', owner?.pos.x ?? a.minX, owner?.pos.z ?? a.minZ, 0.8);
    owner?.note('Charge placed: clear the blast zone (4 s)', 'warn');
  }

  update(dt: number) {
    const ctx = this.ctx;
    for (let i = this.flying.length - 1; i >= 0; i--) {
      const f = this.flying[i];
      f.t += dt;
      f.vy -= 18 * dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.z += f.vz * dt;
      if (f.kind === 'flare') ctx.fx.fire(f.x, f.y, f.z, 0.3);
      const gy = ctx.groundAt(f.x, f.z);
      const hitWall = ctx.obs.pointInside(f.x, f.z, f.y);
      if (f.y <= gy + 0.1 || hitWall || f.t > 4) {
        this.flying.splice(i, 1);
        if (f.kind === 'flare') this.burners.push({ kind: 'flare', x: f.x, z: f.z, r: 1, t: 28, tick: 0, owner: f.owner });
        else {
          this.burners.push({ kind: 'fire', x: f.x, z: f.z, r: 3.6, t: 7, tick: 0, owner: f.owner });
          ctx.fx.explosion(f.x, gy + 0.3, f.z, 0.5);
          ctx.audio.play('boom', f.x, f.z, 0.6);
          ctx.sig.emit(f.x, f.z, 70, 'noise');
        }
      }
    }
    let flareLight = 0;
    for (let i = this.burners.length - 1; i >= 0; i--) {
      const b = this.burners[i];
      b.t -= dt;
      b.tick -= dt;
      const gy = ctx.groundAt(b.x, b.z);
      if (b.kind === 'flare') {
        ctx.fx.fire(b.x + (Math.random() - 0.5) * 0.2, gy + 0.2, b.z + (Math.random() - 0.5) * 0.2, 0.6);
        if (Math.random() < 0.3) ctx.fx.blackSmoke(b.x, gy + 0.6, b.z);
        // A flare is a lure: zombies investigate the glow.
        if (b.tick <= 0) {
          b.tick = 0.4;
          ctx.sig.emit(b.x, b.z, 75, 'noise');
        }
        flareLight = Math.max(flareLight, Math.min(1, b.t / 4));
        this.light.position.set(b.x, gy + 2.2, b.z);
      } else {
        for (let k = 0; k < 3; k++) ctx.fx.fire(b.x + (Math.random() - 0.5) * b.r * 1.6, gy + 0.2, b.z + (Math.random() - 0.5) * b.r * 1.6, 1.2);
        ctx.zombies.burnArea(b.x, b.z, b.r, 24, dt, b.owner?.index ?? -1);
        ctx.wildlife.burnArea(b.x, b.z, b.r, 24, dt, b.owner?.index ?? -1);
        ctx.raiders.burnArea(b.x, b.z, b.r, 18, dt);
        if (b.tick <= 0) {
          b.tick = 0.5;
          for (const pl of ctx.players) {
            if (pl.state === 'foot' && pl.invuln <= 0 && Math.hypot(pl.pos.x - b.x, pl.pos.z - b.z) < b.r) pl.hurt(7, b.x, b.z, 'fire');
          }
        }
        for (const v of ctx.vehicles) {
          if (v.faction === 'raider' && Math.hypot(v.position.x - b.x, v.position.z - b.z) < b.r + 1.5) v.takeHit(10 * dt, b.x, b.z, { incendiary: true, silent: true });
        }
      }
      if (b.t <= 0) this.burners.splice(i, 1);
    }
    this.light.intensity = flareLight * 45;
    for (let i = this.charges.length - 1; i >= 0; i--) {
      const c = this.charges[i];
      c.t -= dt;
      if (Math.floor(c.t * 3) !== Math.floor((c.t + dt) * 3)) ctx.audio.play('beep', c.x, c.z, 0.5);
      ctx.fx.glow.emit(c.x, ctx.groundAt(c.x, c.z) + 1.2, c.z, 0, 0.2, 0, 0.25, 0.25, 0.2, 1, 0.2, 0.1, 0.9, 0, 0);
      if (c.t <= 0) {
        this.charges.splice(i, 1);
        ctx.combat.explode(c.x, ctx.groundAt(c.x, c.z) + 1, c.z, 7, 420, { side: 'convoy', owner: c.owner });
        ctx.breakBarricade(c.aabb, 'charge');
      }
    }
    for (let i = this.decoys.length - 1; i >= 0; i--) {
      const d = this.decoys[i];
      d.t -= dt;
      d.tick -= dt;
      if (d.tick <= 0) {
        d.tick = 0.3;
        ctx.sig.emit(d.x, d.z, 100, 'noise');
        ctx.fx.puff(d.x, ctx.groundAt(d.x, d.z) + 1.4, d.z, 1, 0.9, 0.3, 1.2, 0.4);
      }
      if (d.t <= 0) this.decoys.splice(i, 1);
    }
  }

  clear() {
    this.flying.length = 0;
    this.burners.length = 0;
    this.charges.length = 0;
    this.decoys.length = 0;
    this.light.intensity = 0;
  }
}
