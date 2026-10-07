import * as THREE from 'three';
import type { Aabb } from '../world/layout';
import type { Ctx } from './ctx';
import type { Player } from './player';
import { MOLOTOV_CONTACT, THROW_LIFE } from '../sim/weaponfx';

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
  /** The thing in the air, so a thrown bottle can be seen turning over. */
  mesh: THREE.Group | null;
}
interface Burner {
  kind: 'flare' | 'fire';
  x: number;
  z: number;
  r: number;
  t: number;
  tick: number;
  owner: Player | null;
  /** Burning on the water: a flare goes on under it, spilt fuel floats and drifts on the current. */
  water?: boolean;
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
  /** Meshes for things in the air, made on first use and kept hidden between throws (the scene's teardown frees them with its root). */
  private pool: Record<Throw['kind'], THREE.Group[]> = { flare: [], molotov: [] };

  constructor(private ctx: Ctx) {}

  private makeMesh(kind: Throw['kind']): THREE.Group {
    const g = new THREE.Group();
    if (kind === 'molotov') {
      const glass = new THREE.MeshLambertMaterial({ color: 0x4e7a52, transparent: true, opacity: 0.8 });
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.2, 8), glass);
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.03, 0.1, 8), glass);
      neck.position.y = 0.15;
      const rag = new THREE.Mesh(new THREE.SphereGeometry(0.03, 6, 5), new THREE.MeshBasicMaterial({ color: 0xffa040 }));
      rag.position.y = 0.23;
      g.add(body, neck, rag);
    } else {
      const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.24, 6), new THREE.MeshLambertMaterial({ color: 0xa8281c }));
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.03, 6, 5), new THREE.MeshBasicMaterial({ color: 0xffe0b0 }));
      tip.position.y = 0.13;
      g.add(stick, tip);
    }
    g.visible = false;
    this.ctx.root.add(g);
    return g;
  }

  private takeMesh(kind: Throw['kind']): THREE.Group {
    const free = this.pool[kind].find((m) => !m.visible) ?? this.makeMesh(kind);
    if (!this.pool[kind].includes(free)) this.pool[kind].push(free);
    free.visible = true;
    return free;
  }

  throw(kind: 'flare' | 'molotov', x: number, y: number, z: number, vx: number, vy: number, vz: number, owner: Player | null) {
    this.flying.push({ kind, x, y, z, vx, vy, vz, owner, t: 0, mesh: this.takeMesh(kind) });
    this.ctx.audio.play('swing', x, z, 0.4);
  }

  /** Whether a bottle in the air has reached somebody it should burst on. */
  private contact(f: Throw): boolean {
    const ctx = this.ctx;
    if (f.kind !== 'molotov' || f.t < 0.08) return false;
    let hit = false;
    ctx.zombies.forEachNear(f.x, f.z, MOLOTOV_CONTACT, (zb) => {
      if (Math.abs(zb.y + 0.9 * zb.def.scale - f.y) < 1.2) hit = true;
    });
    if (!hit) ctx.raiders.forEachTarget(f.x, f.z, MOLOTOV_CONTACT, (_x, y) => {
      if (Math.abs(y - f.y) < 1.3) hit = true;
    });
    return hit;
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
      if (f.mesh) {
        // The bottle or stick tumbles end over end as it flies.
        f.mesh.position.set(f.x, f.y, f.z);
        f.mesh.rotation.set(f.t * (f.kind === 'molotov' ? 13 : 7), f.t * 3, f.t * 5);
      }
      // The flame streams back off whatever is burning as it flies, and lights the ground it passes over.
      if (f.kind === 'flare') {
        ctx.fires?.hold(f, { x: f.x, y: f.y - 0.04, z: f.z, r: 0.07, fuel: 'flare', shape: 'point', heat: 0.85, light: 0.7, bed: false, vx: f.vx, vz: f.vz });
        ctx.fx.spark(f.x, f.y, f.z, 1, 2.5);
        if (Math.random() < 0.5) ctx.fx.puff(f.x, f.y, f.z, 0.75, 0.7, 0.68, 0.5, 0.7);
      } else {
        // A burning rag streams flame and smoke behind the bottle.
        ctx.fires?.hold(f, { x: f.x, y: f.y + 0.12, z: f.z, r: 0.07, fuel: 'petrol', shape: 'point', heat: 0.75, light: 0.4, bed: false, vx: f.vx, vz: f.vz });
        if (Math.random() < 0.4) ctx.fx.blackSmoke(f.x, f.y + 0.2, f.z);
      }
      const gy = ctx.groundAt(f.x, f.z);
      const water = ctx.waterAt(f.x, f.z);
      const submerged = water && water.depth > 0.1 && f.y <= water.level;
      const hitWall = ctx.obs.pointInside(f.x, f.z, f.y);
      if (f.y <= gy + 0.1 || submerged || hitWall || f.t > THROW_LIFE || this.contact(f)) {
        this.flying.splice(i, 1);
        ctx.fires?.release(f);
        if (f.mesh) f.mesh.visible = false;
        if (submerged) {
          ctx.fx.puff(f.x, water.level, f.z, 0.75, 0.78, 0.8, 0.3, 0.4);
          ctx.audio.play('splash', f.x, f.z, 0.3);
          // A flare burns on under water; a bottle bursts and its fuel spreads over the surface, still burning.
          if (f.kind === 'flare') this.burners.push({ kind: 'flare', x: f.x, z: f.z, r: 1, t: 28, tick: 0, owner: f.owner, water: true });
          else {
            this.burners.push({ kind: 'fire', x: f.x, z: f.z, r: 2.6, t: 6, tick: 0, owner: f.owner, water: true });
            ctx.fx.fireSplash(f.x, water.level + 0.1, f.z, 2.6);
          }
          continue;
        }
        if (f.kind === 'flare') {
          this.burners.push({ kind: 'flare', x: f.x, z: f.z, r: 1, t: 28, tick: 0, owner: f.owner });
          ctx.audio.play('thunk', f.x, f.z, 0.14);
        }
        else {
          this.burners.push({ kind: 'fire', x: f.x, z: f.z, r: 3.6, t: 7, tick: 0, owner: f.owner });
          // A bottle breaks and spreads burning fuel. It does not detonate or excavate a crater.
          for (let shard = 0; shard < 8; shard++) ctx.gore.gibs.throw('shard', f.x, Math.max(gy + 0.05, f.y), f.z,
            (Math.random() - 0.5) * 3, 0.5 + Math.random() * 2, (Math.random() - 0.5) * 3, 0.15 + Math.random() * 0.2, 0.3, 0.5, 0.32);
          ctx.fx.fireSplash(f.x, gy + 0.2, f.z, 3.6);
          ctx.gore.scorch(f.x, f.z, 1.8);
          ctx.audio.play('glass', f.x, f.z, 0.4);
          ctx.sig.emit(f.x, f.z, 70, 'noise');
        }
      }
    }
    for (let i = this.burners.length - 1; i >= 0; i--) {
      const b = this.burners[i];
      b.t -= dt;
      b.tick -= dt;
      // On the water it rides the surface, and spilt fuel drifts off on the current.
      const w = b.water ? ctx.waterAt(b.x, b.z) : null;
      if (b.water && b.kind === 'fire' && w?.flow) {
        b.x += w.flow[0] * dt * 0.8;
        b.z += w.flow[1] * dt * 0.8;
      }
      const gy = w ? w.level : ctx.groundAt(b.x, b.z);
      if (b.kind === 'flare') {
        // The fire engine draws it, lights the ground red round it, and smokes it.
        ctx.fires?.hold(b, { x: b.x, y: gy + 0.05, z: b.z, r: 0.08, fuel: 'flare', shape: 'point', heat: Math.min(1, b.t / 4), bed: false });
        // A flare is a lure: zombies investigate the glow.
        if (b.tick <= 0) {
          b.tick = 0.4;
          ctx.sig.emit(b.x, b.z, 75, 'noise');
        }
      } else {
        // A pool of burning fuel: flames, a black bed, smoke, light, and dry grass round it catching.
        ctx.fires?.hold(b, { x: b.x, y: gy + 0.02, z: b.z, r: b.r * 0.8, fuel: 'petrol', heat: Math.min(1, b.t / 2), bed: !b.water, spreads: !b.water, owner: b.owner?.index ?? -1 });
        ctx.zombies.burnArea(b.x, b.z, b.r, 24, dt, b.owner?.index ?? -1);
        ctx.wildlife.burnArea(b.x, b.z, b.r, 24, dt, b.owner?.index ?? -1);
        ctx.raiders.burnArea(b.x, b.z, b.r, 18, dt);
        ctx.travellers.burnArea(b.x, b.z, b.r, 18, dt, b.owner?.index ?? -1);
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
      if (b.t <= 0) {
        this.burners.splice(i, 1);
        ctx.fires?.release(b);
      }
    }
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
    for (const list of Object.values(this.pool)) for (const m of list) m.visible = false;
  }
}
