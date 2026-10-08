import * as THREE from 'three';
import { AMMO, type AmmoKind } from '../sim/ballistics';
import { crushDamage, WOOD, WOOD_BITE, woodFx, type WoodKind } from '../sim/treeDamage';
import { CELL } from '../render/decals';
import { WoodChips } from '../render/woodChips';
import type { TreeEvents, TreeFall, TreeShot, TreeTarget } from '../physics/physics';
import type { Ctx } from './ctx';
import type { Gore } from './gore';

/**
 * Gunfire in the trees, as it is seen and heard: chips of pale wood and flakes of bark knocked back out of the entry and
 * blown out of the exit, a puff of sawdust, a scar where the bark came off, leaves shaken down out of the crown, and the
 * knock of the round in the wood. Then, when a tree snaps (`render/vegetation.ts` decides that), the crack and groan of the
 * break, the top coming down on whoever is under it, and the crash, the leaves and the dust where it lands.
 *
 * Owned by `Gore`; it is also the physics world's `treeEvents`. All pieces come from fixed pools (`WoodChips`).
 */

/** A top on its way down, followed so it can strike whoever is under it (each only once). */
interface Falling {
  f: TreeFall;
  t: number;
  struck: Set<object>;
  groaned: boolean;
  landed: boolean;
}

const _q = new THREE.Quaternion();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _t = new THREE.Vector3();
/** The round handed to a tree: one object, reused, so a burst into a trunk allocates nothing. */
const SHOT: TreeShot = { ammo: 'pistol', speed: 0, exit: 0, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 1, by: -1 };

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class Timber implements TreeEvents {
  readonly chips: WoodChips;
  private falls: Falling[] = [];
  /** Where and when the wood last knocked, so a shell of buckshot is one knock and not nine. */
  private knock = { x: 0, z: 0, t: -1 };
  /** Snaps and landings since the scene began, for tests. */
  snaps = 0;
  landings = 0;

  constructor(private ctx: Ctx, private gore: Gore) {
    this.chips = new WoodChips((x, z) => (ctx.drawnGroundAt ? ctx.drawnGroundAt(x, z) : ctx.groundAt(x, z)));
    ctx.P.treeEvents = this;
  }

  private floor(x: number, z: number) {
    const ctx = this.ctx;
    return ctx.drawnGroundAt ? ctx.drawnGroundAt(x, z) : ctx.groundAt(x, z);
  }

  /** How big the pieces a round knocks out are: a full rifle round's bigger than a pistol's, buckshot's small. */
  private chipSize(ammo: AmmoKind, left: number) {
    return (ammo === 'pellet' ? 0.55 : 0.6 + 0.4 * Math.min(1.8, WOOD_BITE[ammo])) * (0.7 + 0.3 * Math.min(1, left));
  }

  /** Throw `n` chips and `bark` flakes from a point, in a cone round (cx, cy, cz) (need not be unit) `fling` m/s fast. */
  private burst(wood: WoodKind, x: number, y: number, z: number, cx: number, cy: number, cz: number, n: number, bark: number, fling: number, size: number, floor: number) {
    const w = WOOD[wood];
    const cl = Math.hypot(cx, cy, cz) || 1;
    cx /= cl;
    cy /= cl;
    cz /= cl;
    for (let i = 0; i < n + bark; i++) {
      const flake = i >= n;
      let dx = cx + rand(-0.55, 0.55);
      let dy = cy + rand(-0.3, 0.6);
      let dz = cz + rand(-0.55, 0.55);
      const l = Math.hypot(dx, dy, dz) || 1;
      const sp = fling * rand(0.45, 1.15) * (flake ? 0.6 : 1);
      dx = (dx / l) * sp;
      dy = (dy / l) * sp + rand(0.4, 1.6);
      dz = (dz / l) * sp;
      const s = size * rand(0.6, 1.4);
      if (flake) {
        const k = rand(0.75, 1.2);
        this.chips.throw('bark', x, y, z, dx, dy, dz, s, s, s * rand(0.7, 1.3), w.bark[0] * k, w.bark[1] * k, w.bark[2] * k, floor);
      } else {
        // Most are pale wood, one in four keeps its skin of bark.
        const c = Math.random() < 0.25 ? w.bark : w.sap;
        const k = rand(0.8, 1.15);
        this.chips.throw('chip', x, y, z, dx, dy, dz, s * rand(0.7, 1.6), s, s, c[0] * k, c[1] * k, c[2] * k, floor);
      }
    }
  }

  /** Sawdust and bark dust kicked out of a hit along (dx, dy, dz). */
  private dust(wood: WoodKind, x: number, y: number, z: number, dx: number, dy: number, dz: number, amount: number) {
    const w = WOOD[wood];
    const smoke = this.ctx.fx.smoke;
    for (let i = 0; i < 2 + Math.round(amount * 3); i++) {
      const s = rand(1, 3) * (0.6 + amount * 0.6);
      smoke.emit(x, y, z, dx * s + rand(-0.6, 0.6), dy * s + rand(0, 0.8), dz * s + rand(-0.6, 0.6), rand(0.5, 0.9), 0.05, 0.28 + amount * 0.25,
        w.sap[0] * 1.15, w.sap[1] * 1.12, w.sap[2] * 1.1, 0.45, 1.6, 2.2);
    }
    smoke.emit(x, y, z, dx * 0.6, 0.35, dz * 0.6, 1.1, 0.12, 0.6 + amount * 0.4, w.bark[0] * 1.6, w.bark[1] * 1.5, w.bark[2] * 1.4, 0.3, 0.1, 1.2);
  }

  /** Leaves out of a tree's crown, `n` of them, falling from all over its underside; a hard blow brings a twig down too. */
  private shake(t: TreeTarget, n: number) {
    const c = t.crown();
    const leaf = WOOD[t.wood].leaf;
    if (!c || !leaf || n <= 0) return;
    const floor = this.floor(c.x, c.z);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * c.r;
      this.leaf(c.x + Math.cos(a) * d, c.y + rand(-0.6, 0.2) * c.h, c.z + Math.sin(a) * d, leaf, floor, 0.4);
    }
    if (n >= 3 && Math.random() < 0.3) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * c.r * 0.8;
      const b = WOOD[t.wood].bark;
      const s = rand(0.8, 1.4);
      this.chips.throw('chip', c.x + Math.cos(a) * d, c.y - c.h * 0.3, c.z + Math.sin(a) * d, rand(-0.5, 0.5), 0, rand(-0.5, 0.5), s * 5, s * 1.6, s * 0.4, b[0], b[1], b[2], floor);
    }
  }

  private leaf(x: number, y: number, z: number, rgb: readonly [number, number, number], floor: number, kick: number) {
    // A few are yellowed or dry.
    const dry = Math.random() < 0.18;
    const k = rand(0.8, 1.2);
    const r = dry ? 0.42 * k : rgb[0] * k, g = dry ? 0.33 * k : rgb[1] * k, b = dry ? 0.08 * k : rgb[2] * k;
    const s = rand(0.7, 1.3);
    this.chips.throw('leaf', x, y, z, rand(-kick, kick), rand(0, kick), rand(-kick, kick), s, s, s, r, g, b, floor);
  }

  // ------------------------------------------------------------------ a round in the wood

  /**
   * A round has struck a tree at (x, y, z), on a face looking along (nx, ny, nz), going along (dx, dy, dz) at `speed`: the
   * chips come back out round the face and its reflection, with the dust; the bark comes off in a scar; the crown sheds.
   */
  impact(t: TreeTarget, ammo: AmmoKind, x: number, y: number, z: number, nx: number, ny: number, nz: number, dx: number, dy: number, dz: number, speed: number) {
    const ctx = this.ctx;
    const spec = AMMO[ammo];
    const left = (speed / spec.speed) ** 2;
    const fx = woodFx(ammo, left, t.wood);
    const dn = dx * nx + dy * ny + dz * nz;
    const rx = dx - 2 * dn * nx, ry = dy - 2 * dn * ny, rz = dz - 2 * dn * nz;
    const floor = this.floor(x, z);
    this.burst(t.wood, x + nx * 0.04, y + ny * 0.04, z + nz * 0.04, nx * 0.65 + rx * 0.45, ny * 0.65 + ry * 0.45 + 0.2, nz * 0.65 + rz * 0.45, fx.chips, fx.bark, fx.fling, this.chipSize(ammo, left), floor);
    this.dust(t.wood, x + nx * 0.06, y + ny * 0.06, z + nz * 0.06, nx, ny, nz, Math.min(1, left * WOOD_BITE[ammo]));
    if (!t.moving()) this.scar(t, x, y, z, nx, ny, nz, fx.scar * rand(0.9, 1.25));
    if (t.standing) this.shake(t, fx.leaves);
    const k = this.knock;
    if (ctx.time - k.t > 0.035 || Math.abs(x - k.x) + Math.abs(z - k.z) > 2) {
      ctx.audio.play('treeHit', x, z, fx.loud, { pitch: fx.pitch * rand(0.92, 1.08), intensity: Math.min(1, left) });
      k.x = x;
      k.z = z;
      k.t = ctx.time;
    }
  }

  /** Where it came out the far side: splinters blown on ahead with it, and a ragged scar. */
  exit(t: TreeTarget, ammo: AmmoKind, x: number, y: number, z: number, dx: number, dy: number, dz: number, exitSpeed: number) {
    const spec = AMMO[ammo];
    const left = (exitSpeed / spec.speed) ** 2;
    const fx = woodFx(ammo, Math.max(0.3, left), t.wood);
    const floor = this.floor(x, z);
    this.burst(t.wood, x + dx * 0.04, y + dy * 0.04, z + dz * 0.04, dx, dy + 0.15, dz, Math.ceil(fx.chips * 0.8), Math.ceil(fx.bark * 0.5), fx.fling * 1.3, this.chipSize(ammo, 1) * 1.15, floor);
    this.dust(t.wood, x + dx * 0.1, y + dy * 0.1, z + dz * 0.1, dx, dy, dz, 0.6);
    if (!t.moving()) this.scar(t, x, y, z, dx, dy, dz, fx.scar * 1.4);
  }

  /** Pale wood where the bark came off: sized by the round, never wider than the stem it is on. */
  private scar(t: TreeTarget, x: number, y: number, z: number, nx: number, ny: number, nz: number, size: number) {
    const r = t.stemRadius(x, y, z);
    const w = WOOD[t.wood];
    const k = rand(0.85, 1.05);
    const s = r > 0 ? Math.min(size, r * 1.3) : size;
    this.gore.marks.add(x, y, z, { cell: CELL.scar, w: s * 1.5, h: s, nx, ny, nz, dx: 0, dy: 1, dz: 0, r: w.sap[0] * k, g: w.sap[1] * k, b: w.sap[2] * k, opacity: 0.96, hole: true });
    this.gore.placed++;
  }

  /**
   * Hand the round to the tree (it cuts its notch, and may snap it). As the notch deepens the tree shakes more and the
   * wood starts to groan.
   */
  shot(t: TreeTarget, ammo: AmmoKind, speed: number, exit: number, x: number, y: number, z: number, dx: number, dy: number, dz: number, by: number): number {
    SHOT.ammo = ammo;
    SHOT.speed = speed;
    SHOT.exit = exit;
    SHOT.x = x; SHOT.y = y; SHOT.z = z;
    SHOT.dx = dx; SHOT.dy = dy; SHOT.dz = dz;
    SHOT.by = by;
    const share = t.shot(SHOT);
    if (share > 0.3 && share < 1 && t.standing && Math.random() < share * 0.35) {
      this.ctx.audio.play('treeCreak', x, z, 0.15 + share * 0.3, { pitch: rand(0.85, 1.1) });
      this.shake(t, 1 + Math.round(share * 3));
    }
    return share;
  }

  // ------------------------------------------------------------------ TreeEvents

  snapped(f: TreeFall) {
    const ctx = this.ctx;
    this.snaps++;
    // The crack of the hinge giving, splinters off all round the break, and a cloud of dust and leaves.
    ctx.audio.play('treeCreak', f.x, f.z, 0.9, { pitch: rand(0.7, 0.85), intensity: 1 });
    ctx.audio.play('chip', f.x, f.z, 0.7, { pitch: 0.6, intensity: 1 });
    ctx.audio.play('treeHit', f.x, f.z, 0.8, { pitch: 0.55, intensity: 1 });
    const floor = this.floor(f.x, f.z);
    const size = Math.min(2, 0.9 + f.radius * 1.5);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.random();
      this.burst(f.wood, f.x + Math.cos(a) * f.radius, f.y, f.z + Math.sin(a) * f.radius, Math.cos(a), 0.4, Math.sin(a), 4, 2, 4.5, size, floor);
    }
    this.dust(f.wood, f.x, f.y, f.z, f.dx, 0.3, f.dz, 1);
    ctx.sig.emit(f.x, f.z, 40, 'noise');
    this.falls.push({ f, t: 0, struck: new Set(), groaned: false, landed: false });
  }

  landed(f: TreeFall, x: number, y: number, z: number, speed: number) {
    const ctx = this.ctx;
    this.landings++;
    const heavy = Math.min(1, f.mass / 2500);
    ctx.audio.play('crash', x, z, 0.5 + 0.5 * heavy, { pitch: 0.55 + 0.2 * (1 - heavy), intensity: 1 });
    ctx.audio.play('thud', x, z, 0.6 + 0.4 * heavy, { pitch: 0.6 });
    ctx.audio.play('treeHit', x, z, 0.7, { pitch: 0.5 });
    ctx.audio.play('rustle', x, z, 0.8);
    // Dust kicked up all along the trunk where it hit, and a burst of leaves and twigs off the crown.
    const b = f.body;
    if (b.isValid()) {
      const tr = b.translation(), r = b.rotation();
      _q.set(r.x, r.y, r.z, r.w);
      _t.set(tr.x, tr.y, tr.z);
      _a.set(f.butt[0], f.butt[1], f.butt[2]).applyQuaternion(_q).add(_t);
      _b.set(f.tip[0], f.tip[1], f.tip[2]).applyQuaternion(_q).add(_t);
      for (let i = 0; i <= 6; i++) {
        const k = i / 6;
        const px = _a.x + (_b.x - _a.x) * k, pz = _a.z + (_b.z - _a.z) * k;
        ctx.fx.dust(px, this.floor(px, pz), pz, (_b.x - _a.x) * 0.2, (_b.z - _a.z) * 0.2, 0.6 + heavy, [0.62, 0.55, 0.43]);
      }
    }
    const leaf = WOOD[f.wood].leaf;
    const floor = this.floor(x, z);
    if (leaf) {
      const n = Math.min(40, 12 + Math.round(f.crown * 4));
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const d = Math.sqrt(Math.random()) * f.crown;
        this.leaf(x + Math.cos(a) * d, y + rand(0.5, 2.5), z + Math.sin(a) * d, leaf, floor, 1.6);
      }
    }
    // Twigs snapped off as the crown hit.
    const w = WOOD[f.wood];
    for (let i = 0; i < 8; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rand(0.8, 1.5);
      this.chips.throw('chip', x + Math.cos(a) * f.crown * 0.5, y + 0.5, z + Math.sin(a) * f.crown * 0.5, Math.cos(a) * rand(1, 3), rand(1.5, 4), Math.sin(a) * rand(1, 3), s * 5, s * 1.8, s * 0.4, w.bark[0], w.bark[1], w.bark[2], floor);
    }
    for (const p of ctx.players) {
      const d = Math.hypot(p.pos.x - x, p.pos.z - z);
      if (d < 45) p.cam.addShake(Math.max(0, 0.55 - d / 60) * (0.4 + heavy));
    }
    ctx.sig.emit(x, z, 55 + 30 * heavy, 'noise');
    // Whoever stood where the crown came down is caught under it.
    const by = f.by;
    const dmg = crushDamage(f.mass * 0.5, Math.max(3, speed));
    ctx.raiders.blast(x, z, f.crown * 0.7, dmg * 0.6, by, true);
    ctx.travellers.blast(x, z, f.crown * 0.7, dmg * 0.6, by);
  }

  leaves(x: number, y: number, z: number, n: number, rgb: readonly [number, number, number], spread: number) {
    const floor = this.floor(x, z);
    for (let i = 0; i < n; i++) this.leaf(x + rand(-spread, spread), y + rand(-spread, spread) * 0.5, z + rand(-spread, spread), rgb, floor, 1.2);
  }

  // ------------------------------------------------------------------ per tick

  update(dt: number) {
    this.chips.update(dt);
    for (let i = this.falls.length - 1; i >= 0; i--) {
      const fl = this.falls[i];
      fl.t += dt;
      const b = fl.f.body;
      if (!b.isValid() || fl.t > 12 || (fl.t > 1 && b.isSleeping())) {
        this.falls.splice(i, 1);
        continue;
      }
      // The wood groans as the hinge tears.
      if (!fl.groaned && fl.t > 0.5) {
        fl.groaned = true;
        this.ctx.audio.play('treeCreak', fl.f.x, fl.f.z, 0.7, { pitch: rand(0.6, 0.75) });
        this.ctx.audio.play('creak', fl.f.x, fl.f.z, 0.5, { pitch: 0.7 });
      }
      this.strike(fl);
    }
  }

  /** Anyone the falling trunk or its crown passes through, while it moves fast enough to hurt: crushed and thrown aside. */
  private strike(fl: Falling) {
    const ctx = this.ctx;
    const f = fl.f, b = f.body;
    const tr = b.translation(), r = b.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    _t.set(tr.x, tr.y, tr.z);
    _a.set(f.butt[0], f.butt[1], f.butt[2]).applyQuaternion(_q).add(_t);
    _b.set(f.tip[0], f.tip[1], f.tip[2]).applyQuaternion(_q).add(_t);
    const ax = _a.x, ay = _a.y, az = _a.z;
    const ex = _b.x - ax, ey = _b.y - ay, ez = _b.z - az;
    const L2 = ex * ex + ey * ey + ez * ez || 1;
    const mx = ax + ex / 2, mz = az + ez / 2;
    const reach = Math.sqrt(L2) / 2 + f.crown + 1;
    /** How close a point is to the trunk (less the trunk's and crown's thickness there), and how fast that part moves. */
    const near = (x: number, y: number, z: number, body: number): { speed: number; s: number } | null => {
      const s = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey + (z - az) * ez) / L2));
      const px = ax + ex * s, py = ay + ey * s, pz = az + ez * s;
      const thick = f.radius + f.crown * 0.75 * Math.max(0, (s - 0.45) / 0.55) + body;
      if ((x - px) ** 2 + (y - py) ** 2 + (z - pz) ** 2 > thick * thick) return null;
      const v = b.velocityAtPoint({ x: px, y: py, z: pz });
      return { speed: Math.hypot(v.x, v.y, v.z), s };
    };
    const by = f.by;
    // Damage by how much of the tree comes down on them there: the crown end carries the most.
    const hurt = (speed: number, s: number) => crushDamage(f.mass * (0.35 + 0.65 * s), speed);
    ctx.zombies.forEachNear(mx, mz, reach, (zb) => {
      if (zb.dead || fl.struck.has(zb)) return;
      const h = near(zb.x, zb.y + 0.9 * zb.def.scale, zb.z, zb.def.radius);
      if (!h) return;
      const dmg = hurt(h.speed, h.s);
      if (dmg <= 0) return;
      fl.struck.add(zb);
      ctx.zombies.damage(zb, dmg, { fromX: ax, fromZ: az, killer: by, explosive: true });
      ctx.zombies.knock(zb, f.dx, f.dz, Math.min(7, h.speed * 0.6));
      ctx.audio.play('thud', zb.x, zb.z, 0.5);
    });
    ctx.wildlife.forEachNear(mx, mz, reach, (an) => {
      if (an.dead || fl.struck.has(an)) return;
      const h = near(an.x, an.y + an.height * 0.5, an.z, an.def.radius);
      if (!h) return;
      const dmg = hurt(h.speed, h.s);
      if (dmg <= 0) return;
      fl.struck.add(an);
      ctx.wildlife.damage(an, dmg, { fromX: ax, fromZ: az, killer: by, explosive: true });
    });
    for (const p of ctx.players) {
      if (p.state !== 'foot' || fl.struck.has(p)) continue;
      const h = near(p.pos.x, p.pos.y + 0.9, p.pos.z, 0.35);
      if (!h) continue;
      const dmg = hurt(h.speed, h.s);
      if (dmg <= 0) continue;
      fl.struck.add(p);
      p.hurt(dmg * 0.5, ax, az, 'blast');
      p.cam.addShake(0.8);
    }
  }

  clear() {
    this.chips.clear();
    this.falls.length = 0;
  }

  dispose() {
    if (this.ctx.P.treeEvents === this) this.ctx.P.treeEvents = null;
    this.chips.dispose();
    this.falls.length = 0;
  }
}
