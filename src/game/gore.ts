import * as THREE from 'three';
import { G, groups } from '../physics/physics';
import { SURFACES, type Surface, type Zone } from '../sim/ballistics';
import { Brass, type MagKind, type ShellKind } from '../render/brass';
import { CELL, Decals } from '../render/decals';
import { roadLift } from '../render/chunkview';
import { Gibs } from '../render/gibs';
import type { ZombieKind } from '../data';
import type { Ctx } from './ctx';
import type { Zombie } from './zombies';

const RAY = groups(0xffff, G.STATIC | G.VEHICLE | G.BUILD | G.FURN);
const _c = new THREE.Color();

/** Skin of each kind, as the zombie shader draws it, so a thrown arm matches the body it came off. */
const SKIN: Record<ZombieKind, number> = { walker: 0x6f7660, runner: 0x7a7660, screamer: 0x8e889a, bloater: 0x87904e, brute: 0x7a5a4c, stalker: 0x5c6670 };
const CLOTH = [0x5a5446, 0x3e4a58, 0x6a3a32, 0x7a7262, 0x2e3a2c, 0x4a3a52];
const TROUSERS = [0x2e3036, 0x3a3a2e, 0x4a4238, 0x252830];

interface Bleeder {
  zb: Zombie;
  /** Stump position in the body's own frame (x to its left, z ahead). */
  lx: number;
  ly: number;
  lz: number;
  t: number;
  power: number;
  pulse: number;
  /** Which way the spray leans, a world direction. */
  dx: number;
  dz: number;
  /** An open neck sprays higher and harder than a limb. */
  head: boolean;
}

/**
 * Everything a fight leaves behind and everything that flies off in one: blood on walls and roads, limbs and meat thrown
 * clear, spent brass, bullet holes. It owns the pooled meshes and decides where each mark lands by casting into the world.
 */
export class Gore {
  /** Blood: wet, drying, recycled oldest first. */
  readonly decals = new Decals();
  /** What weapons do to the world: bullet holes, cracks, scorch. Their own pool, so a bloody fight does not wipe them. */
  readonly marks = new Decals(1100);
  readonly brass: Brass;
  readonly gibs: Gibs;
  private bleeders: Bleeder[] = [];
  /** Marks laid since the scene began, for tests. */
  placed = 0;

  constructor(private ctx: Ctx) {
    // Anything lying on the road rests on the drawn road, a few centimetres above the collider under it.
    const lift = (x: number, z: number) => (ctx.terrain ? roadLift(ctx.terrain, x, z) : 0);
    const floorAt = (x: number, y: number, z: number): number | null => {
      const r = ctx.P.raycast(x, y, z, 0, -1, 0, 3, RAY);
      return (r ? y - r.toi : ctx.groundAt(x, z)) + (!r || r.normal.y > 0.7 ? lift(x, z) : 0);
    };
    this.brass = new Brass({
      floorAt,
      ring: (x, _y, z, loud) => {
        if (loud > 0.06) ctx.audio.play('shell', x, z, 0.12 + loud * 0.2);
      },
      clunk: (x, _y, z, loud) => {
        if (loud > 0.08) {
          ctx.audio.play('thud', x, z, 0.1 + loud * 0.25);
          ctx.audio.play('tink', x, z, 0.08 + loud * 0.15);
        }
      },
    });
    this.gibs = new Gibs({
      floorAt,
      ring: () => {},
      trail: (x, y, z, vx, vy, vz) => {
        ctx.fx.bloodSpray(x, y, z, -vx * 0.03, 0.1, -vz * 0.03, 1, 1.2, 0.5);
        if (Math.random() < 0.3) this.groundSplat(x, z, 0.12 + Math.random() * 0.12, CELL.drops, 0.7, vx, vz);
      },
      splash: (x, y, z, speed) => {
        const s = Math.min(1, speed / 6);
        ctx.fx.bloodSpray(x, y + 0.05, z, 0, 1, 0, 3, 2 + s * 3, 0.9);
        this.groundSplat(x, z, 0.25 + s * 0.3, CELL.splat0 + Math.floor(Math.random() * 4), 0.85);
        if (speed > 3) ctx.audio.play('thud', x, z, 0.25);
      },
    });
  }

  /** Add the meshes to a scene root. */
  attach(root: THREE.Object3D) {
    root.add(this.decals.mesh);
    root.add(this.marks.mesh);
    for (const m of this.brass.meshes) root.add(m);
    root.add(this.gibs.group);
  }

  // ------------------------------------------------------------------ blood on surfaces

  private place(x: number, y: number, z: number, nx: number, ny: number, nz: number, w: number, h: number, cell: number, opacity: number, dx?: number, dy?: number, dz?: number) {
    const k = 0.75 + Math.random() * 0.4;
    // On level ground the mark lies on the road if there is one.
    if (ny > 0.7 && this.ctx.terrain) y += roadLift(this.ctx.terrain, x, z);
    this.decals.add(x, y, z, { cell, w, h, nx, ny, nz, dx, dy, dz, r: 0.4 * k, g: 0.02, b: 0.022, opacity });
    this.placed++;
  }

  /** A splat on the ground at a spot, dropped on whatever floor is there. */
  groundSplat(x: number, z: number, size: number, cell: number, opacity = 0.85, dirX?: number, dirZ?: number, fromY?: number) {
    const ctx = this.ctx;
    const y0 = (fromY ?? ctx.groundAt(x, z)) + 1;
    const r = ctx.P.raycast(x, y0, z, 0, -1, 0, 4, RAY);
    const gy = r ? y0 - r.toi : ctx.groundAt(x, z);
    const n = r?.normal ?? { x: 0, y: 1, z: 0 };
    const stretch = dirX !== undefined && dirZ !== undefined && Math.hypot(dirX, dirZ) > 0.2 ? 1.5 : 1;
    this.place(x, gy, z, n.x, n.y, n.z, size * stretch, size, cell, opacity, dirX, 0, dirZ);
  }

  /**
   * A body was hit and the round (or what is left of it) is heading along (dx, dy, dz): spray forward out of the exit, a
   * mist back at the shooter, and mark whatever the spray lands on, a wall behind the target or the road in front of it.
   * `power` is roughly how many times over the blow could have killed.
   */
  flesh(x: number, y: number, z: number, dx: number, dy: number, dz: number, power: number, color?: [number, number, number]) {
    const ctx = this.ctx;
    const p = Math.max(0.15, Math.min(3, power));
    // Forward out of the exit wound, in the direction of travel, widening as it goes.
    ctx.fx.bloodSpray(x + dx * 0.25, y + dy * 0.25, z + dz * 0.25, dx, dy * 0.8, dz, 2 + Math.round(p * 4), 3 + p * 4, 0.4, color);
    // A short mist back along the line the round came in on.
    ctx.fx.bloodSpray(x, y, z, -dx * 0.5, 0.15, -dz * 0.5, 2, 2, 0.8, color);
    const reach = 1.8 + p * 3.4;
    const r = ctx.P.raycast(x, y, z, dx, dy, dz, reach, RAY);
    if (r) {
      const hx = x + dx * r.toi;
      const hy = y + dy * r.toi;
      const hz = z + dz * r.toi;
      const near = 1 - r.toi / reach;
      // A big wet splat where the spray landed, streaked along the way it was going, and fine drops around it.
      this.place(hx, hy, hz, r.normal.x, r.normal.y, r.normal.z, 0.38 + p * 0.4 * (0.5 + near), 0.3 + p * 0.3 * (0.5 + near), CELL.splat0 + Math.floor(Math.random() * 4), 0.9, dx, dy, dz);
      this.place(hx, hy, hz, r.normal.x, r.normal.y, r.normal.z, 0.9 + p * 0.5, 0.9 + p * 0.5, CELL.drops, 0.7);
    } else {
      // Nothing behind it: the spray falls out on the ground ahead.
      const fx = x + dx * reach;
      const fz = z + dz * reach;
      this.groundSplat(fx, fz, 0.55 + p * 0.5, CELL.spray, 0.8, dx, dz, y);
    }
    // And the road right under the wound.
    if (p > 0.25 || Math.random() < 0.5) this.groundSplat(x + dx * 0.3, z + dz * 0.3, 0.25 + p * 0.3, CELL.splat0 + Math.floor(Math.random() * 4), 0.85, dx, dz, y);
  }

  /** A body goes down: a pool under it that is bigger the harder it was hit, and a smear thrown the way the shot went. */
  corpse(x: number, y: number, z: number, scale: number, power: number, dx: number, dz: number) {
    const ctx = this.ctx;
    const p = Math.max(0.3, Math.min(3, power));
    const size = (0.7 + p * 0.45) * scale;
    this.groundSplat(x, z, size, CELL.pool, 0.88, undefined, undefined, y);
    this.groundSplat(x + (Math.random() - 0.5) * 0.7, z + (Math.random() - 0.5) * 0.7, size * 0.55, CELL.splat0 + Math.floor(Math.random() * 4), 0.8, undefined, undefined, y);
    const l = Math.hypot(dx, dz);
    if (l > 0.2) {
      // The body slid and dragged: a long smear the way it went.
      const ux = dx / l;
      const uz = dz / l;
      this.groundSplat(x + ux * (0.6 + p * 0.4), z + uz * (0.6 + p * 0.4), (1.1 + p * 0.5) * scale, CELL.spray, 0.75, ux, uz, y);
    }
    if (p > 1.2) for (let i = 0; i < 4; i++) this.groundSplat(x + (Math.random() - 0.5) * 3.2, z + (Math.random() - 0.5) * 3.2, 0.3 + Math.random() * 0.35, CELL.drops, 0.75, undefined, undefined, y);
    void ctx;
  }

  // ------------------------------------------------------------------ what a round does to the world

  /** The colour of the exposed material around a hole: the surface, paler, as if the paint were blown off it. */
  private pale(surface: Surface, k = 1.3): [number, number, number] {
    const t = SURFACES[surface].tint;
    return [Math.min(1, t[0] * k), Math.min(1, t[1] * k), Math.min(1, t[2] * k)];
  }

  /** Chips of the surface thrown back out of a hit, or forward out of an exit. */
  private chips(surface: Surface, x: number, y: number, z: number, dx: number, dy: number, dz: number, n: number, speed: number) {
    const t = SURFACES[surface].tint;
    for (let i = 0; i < n; i++) {
      const k = 0.8 + Math.random() * 0.4;
      this.gibs.throw(
        'chunk',
        x,
        y,
        z,
        dx * speed * (0.5 + Math.random()) + (Math.random() - 0.5) * 2.4,
        dy * speed * (0.5 + Math.random()) + 0.8 + Math.random() * 1.8,
        dz * speed * (0.5 + Math.random()) + (Math.random() - 0.5) * 2.4,
        0.3 + Math.random() * 0.45,
        t[0] * k,
        t[1] * k,
        t[2] * k,
      );
    }
  }

  /**
   * A round hit the world: dust, sparks and chips, and a mark that stays. A wall keeps a dark hole in a ring of pale
   * exposed material with splinters, as wide as the round made it; the ground and stone keep a scuffed pit. Nothing that
   * moves keeps a mark (it would stay behind in the air), and nor does a box that only roughly stands for something round.
   */
  impact(surface: Surface, x: number, y: number, z: number, nx: number, ny: number, nz: number, dx: number, dz: number, energy: number, o: { moving?: boolean; size?: number; heavy?: boolean; mark?: boolean } = {}) {
    const ctx = this.ctx;
    const s = SURFACES[surface];
    const e = Math.max(0.2, Math.min(1.5, energy));
    if (s.spark) ctx.fx.spark(x + nx * 0.05, y + ny * 0.05, z + nz * 0.05, Math.round(s.spark * e), 3 + e * 2);
    // Dust kicked back off the surface, or splinters for wood.
    ctx.fx.puff(x + nx * 0.08, y + ny * 0.08, z + nz * 0.08, s.tint[0], s.tint[1], s.tint[2], 0.5 + e * 0.5, 0.45);
    if (surface === 'dirt') ctx.fx.dust(x, y, z, nx * 2, nz * 2, 0.35, s.tint);
    if (o.moving) return;
    const size = (o.size ?? 0.1) * (0.9 + 0.2 * Math.min(1, e));
    if (surface !== 'glass') this.chips(surface, x + nx * 0.03, y + ny * 0.03, z + nz * 0.03, nx, ny, nz, 1 + Math.round(e * size * 14), 2.2);
    if (o.mark === false) return;
    if (ny > 0.7 && ctx.terrain) y += roadLift(ctx.terrain, x, z);
    if (s.hole) {
      const c = this.pale(surface);
      this.marks.add(x, y, z, { cell: o.heavy ? CELL.splinter : CELL.hole, w: size, h: size, nx, ny, nz, r: c[0], g: c[1], b: c[2], opacity: 0.97, hole: true });
      this.placed++;
    } else if (surface === 'dirt' || surface === 'stone') {
      const sc = size * 1.7;
      this.marks.add(x, y, z, { cell: CELL.scuff, w: sc, h: sc, nx, ny, nz, r: s.tint[0] * 0.45, g: s.tint[1] * 0.45, b: s.tint[2] * 0.45, opacity: 0.8, hole: true });
      this.placed++;
    }
  }

  /** Where a round came out the far side of a wall: a bigger, more ragged hole, and what it blew out thrown on ahead. */
  exitHole(surface: Surface, x: number, y: number, z: number, dx: number, dy: number, dz: number, energy: number, entrySize = 0.1) {
    const s = SURFACES[surface];
    if (!s.hole) return;
    const e = Math.max(0.25, Math.min(1.5, energy));
    const c = this.pale(surface, 1.15);
    let y2 = y;
    if (dy > 0.7 && this.ctx.terrain) y2 += roadLift(this.ctx.terrain, x, z);
    const size = entrySize * 1.8 * (0.9 + 0.2 * Math.min(1, e));
    this.marks.add(x, y2, z, { cell: CELL.splinter, w: size, h: size, nx: dx, ny: dy, nz: dz, r: c[0], g: c[1], b: c[2], opacity: 0.97, hole: true });
    this.placed++;
    this.chips(surface, x + dx * 0.04, y2 + dy * 0.04, z + dz * 0.04, dx, dy, dz, 2 + Math.round(e * size * 12), 3.4);
    this.ctx.fx.puff(x + dx * 0.15, y2, z + dz * 0.15, s.tint[0], s.tint[1], s.tint[2], 0.6, 0.5);
  }

  /** A pane of glass breaks: shards thrown both ways off the window, and a glitter of dust. */
  shards(x: number, y: number, z: number, nx: number, nz: number, count = 16) {
    const ctx = this.ctx;
    for (let i = 0; i < count; i++) {
      const side = Math.random() < 0.55 ? 1 : -1;
      const out = (0.8 + Math.random() * 2.6) * side;
      const k = 0.85 + Math.random() * 0.3;
      this.gibs.throw('shard', x + (Math.random() - 0.5) * 0.9, y + (Math.random() - 0.5) * 0.9, z + (Math.random() - 0.5) * 0.9, nx * out + (Math.random() - 0.5) * 1.5, 0.5 + Math.random() * 2, nz * out + (Math.random() - 0.5) * 1.5, 0.6 + Math.random() * 1.1, 0.78 * k, 0.9 * k, 0.95 * k);
    }
    ctx.fx.puff(x, y, z, 0.8, 0.9, 0.95, 0.9, 0.5);
    ctx.fx.spark(x, y, z, 6, 3);
  }

  /** The wall is giving way: a web of cracks round the spot that took the blow. */
  crack(x: number, y: number, z: number, nx: number, ny: number, nz: number, size: number) {
    this.marks.add(x, y, z, { cell: CELL.crack, w: size, h: size, nx, ny, nz, r: 0.12, g: 0.1, b: 0.09, opacity: 0.85, hole: true });
    this.placed++;
  }

  /** Marks on a stretch of wall that has been knocked out go with it. */
  clearBox(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) {
    this.marks.removeInBox(x0, x1, y0, y1, z0, z1);
    this.decals.removeInBox(x0, x1, y0, y1, z0, z1);
  }

  // ------------------------------------------------------------------ the world breaking

  /** A wall came down or a box split: splinters, plaster and sheet flung both ways off it, and dust. (nx, nz) is the wall's normal. */
  debris(x: number, y: number, z: number, surface: Surface, power: number, nx: number, nz: number) {
    const ctx = this.ctx;
    const tint = SURFACES[surface].tint;
    const n = Math.min(26, 6 + Math.round(power * 7));
    // Whole planks and strips of sheet come off with the dust and chips.
    if (surface === 'wood' || surface === 'sheet') {
      for (let i = 0; i < Math.min(8, 2 + Math.round(power * 2)); i++) {
        const side = Math.random() < 0.5 ? 1 : -1;
        const out = (1 + Math.random() * 3) * side;
        const k = 0.75 + Math.random() * 0.4;
        this.gibs.throw('plank', x + (Math.random() - 0.5) * 1.4, y + (Math.random() - 0.5) * 1.4, z + (Math.random() - 0.5) * 1.4, nx * out + (Math.random() - 0.5) * 1.5, 1 + Math.random() * 2.5, nz * out + (Math.random() - 0.5) * 1.5, 0.7 + Math.random() * 0.8, tint[0] * k, tint[1] * k, tint[2] * k);
      }
    }
    for (let i = 0; i < n; i++) {
      const side = Math.random() < 0.5 ? 1 : -1;
      const out = (1.5 + Math.random() * 3.5) * side;
      const k = 0.85 + Math.random() * 0.3;
      this.gibs.throw(
        'chunk',
        x + (Math.random() - 0.5) * 1.2 * (1 - Math.abs(nx)) + (Math.random() - 0.5) * 1.2 * Math.abs(nx),
        y + (Math.random() - 0.5) * 1.6,
        z + (Math.random() - 0.5) * 1.2 * Math.abs(nx) + (Math.random() - 0.5) * 1.2 * (1 - Math.abs(nx)),
        nx * out + (Math.random() - 0.5) * 2,
        1 + Math.random() * 3.5,
        nz * out + (Math.random() - 0.5) * 2,
        surface === 'wood' ? 0.8 + Math.random() * 1.6 : 0.6 + Math.random() * 1.1,
        tint[0] * k,
        tint[1] * k,
        tint[2] * k,
      );
    }
    for (let i = 0; i < 10; i++) ctx.fx.puff(x + (Math.random() - 0.5) * 2.4, y + (Math.random() - 0.5) * 1.8, z + (Math.random() - 0.5) * 2.4, tint[0], tint[1], tint[2], 1.8 + Math.random() * 1.4, 1.4);
    if (SURFACES[surface].spark) ctx.fx.spark(x, y, z, 8, 6);
  }

  /** A charred ring where something blew up. */
  scorch(x: number, z: number, radius: number) {
    const ctx = this.ctx;
    const y0 = ctx.groundAt(x, z) + 1.5;
    const r = ctx.P.raycast(x, y0, z, 0, -1, 0, 5, RAY);
    const gy = (r ? y0 - r.toi : ctx.groundAt(x, z)) + (ctx.terrain ? roadLift(ctx.terrain, x, z) : 0);
    const n = r?.normal ?? { x: 0, y: 1, z: 0 };
    this.marks.add(x, gy, z, { cell: CELL.pool, w: radius * 1.7, h: radius * 1.7, nx: n.x, ny: n.y, nz: n.z, r: 0.04, g: 0.036, b: 0.032, opacity: 0.8, hole: true });
    this.marks.add(x, gy, z, { cell: CELL.drops, w: radius * 3.2, h: radius * 3.2, nx: n.x, ny: n.y, nz: n.z, r: 0.05, g: 0.045, b: 0.04, opacity: 0.55, hole: true });
    this.placed += 2;
  }

  // ------------------------------------------------------------------ dismemberment

  /** Where a part joins the body, in the body's own frame (x to its left, z ahead). */
  private joint(zone: Exclude<Zone, 'torso'>, sc: number): [number, number, number] {
    switch (zone) {
      case 'head':
        return [0, 1.54 * sc, 0.03 * sc];
      case 'armL':
        return [0.21 * sc, 1.4 * sc, 0];
      case 'armR':
        return [-0.21 * sc, 1.4 * sc, 0];
      case 'legL':
        return [0.1 * sc, 0.94 * sc, 0];
      case 'legR':
        return [-0.1 * sc, 0.94 * sc, 0];
    }
  }

  /** Something came off a body. Throw it, spray the stump, and leave the stump bleeding. */
  sever(zb: Zombie, zone: Exclude<Zone, 'torso'>, dx: number, dy: number, dz: number, power: number) {
    const ctx = this.ctx;
    const sc = zb.def.scale;
    const [lx, ly, lz] = this.joint(zone, sc);
    const rx = Math.cos(zb.yaw);
    const rz = -Math.sin(zb.yaw);
    const fx = Math.sin(zb.yaw);
    const fz = Math.cos(zb.yaw);
    const x = zb.x + rx * lx + fx * lz;
    const z = zb.z + rz * lx + fz * lz;
    const y = zb.y + ly;
    const p = Math.max(0.4, Math.min(3, power));
    const skin = SKIN[zb.kind];
    const throwSpeed = 3 + p * 2.6;
    const side = zone === 'armL' || zone === 'legL' ? 1 : zone === 'armR' || zone === 'legR' ? -1 : 0;
    const vx = dx * throwSpeed + rx * side * 1.6 + (Math.random() - 0.5) * 1.6;
    const vz = dz * throwSpeed + rz * side * 1.6 + (Math.random() - 0.5) * 1.6;
    const vy = 2.2 + Math.random() * 2.4 + dy * throwSpeed * 0.5;
    if (zone === 'head') {
      _c.setHex(skin);
      this.gibs.throw('head', x, y + 0.12 * sc, z, vx, vy + 1, vz, sc, _c.r, _c.g, _c.b);
    } else {
      const arm = zone === 'armL' || zone === 'armR';
      _c.setHex(arm ? CLOTH[zb.variant % CLOTH.length] : TROUSERS[zb.variant % TROUSERS.length]);
      const cloth = _c.clone();
      _c.setHex(skin);
      // An arm is half sleeve, half skin; a leg is trousers.
      const c = arm ? cloth.lerp(_c, 0.45) : cloth;
      this.gibs.throw('limb', x, y - (arm ? 0.15 : 0.2) * sc, z, vx, vy, vz, sc * (arm ? 0.9 : 1.15), c.r, c.g, c.b);
    }
    // Meat and bone thrown with it.
    const chunks = 3 + Math.round(p * 2);
    for (let i = 0; i < chunks; i++) {
      _c.setRGB(0.3 + Math.random() * 0.15, 0.02, 0.02);
      this.gibs.throw('chunk', x, y, z, vx * (0.5 + Math.random()) + (Math.random() - 0.5) * 3, vy * (0.4 + Math.random() * 0.8), vz * (0.5 + Math.random()) + (Math.random() - 0.5) * 3, 0.6 + Math.random() * 0.8, _c.r, _c.g, _c.b);
    }
    ctx.fx.bloodSpray(x, y, z, dx, 0.6, dz, 8 + Math.round(p * 5), 5 + p * 2, 0.8);
    ctx.fx.bloodSpray(x, y, z, 0, 1, 0, 4, 3, 0.7);
    ctx.audio.play('thud', x, z, 0.4);
    // Mark the ground and the nearest wall behind the blow.
    this.groundSplat(x, z, 0.9 + p * 0.3, CELL.splat0 + Math.floor(Math.random() * 4), 0.9, dx, dz, y);
    this.bleeders.push({ zb, lx, ly, lz, t: zone === 'head' ? 3.2 : 2.4, power: p, pulse: 0, dx, dz, head: zone === 'head' });
  }

  // ------------------------------------------------------------------ brass

  /** Throw an empty case out of a gun held at (x, y, z) facing `yaw`, with the shooter's own motion carried over. */
  eject(kind: ShellKind, x: number, y: number, z: number, yaw: number, vx = 0, vz = 0) {
    // Out to the right of the gun, up and a little back.
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const out = 1.6 + Math.random() * 1.4;
    const back = -0.3 - Math.random() * 0.7;
    this.brass.eject(
      x + rx * 0.1,
      y,
      z + rz * 0.1,
      rx * out + fx * back + vx * 0.5 + (Math.random() - 0.5) * 0.6,
      2 + Math.random() * 1.2,
      rz * out + fz * back + vz * 0.5 + (Math.random() - 0.5) * 0.6,
      kind,
    );
  }

  /** An empty magazine falls out of a gun at (x, y, z): it drops with a little of the hand's push and tumbles to the floor. */
  dropMag(kind: MagKind, x: number, y: number, z: number, vx = 0, vz = 0) {
    this.brass.dropMag(x, y, z, vx * 0.5 + (Math.random() - 0.5) * 0.5, -0.3 - Math.random() * 0.4, vz * 0.5 + (Math.random() - 0.5) * 0.5, kind);
  }

  // ------------------------------------------------------------------ per tick

  update(dt: number) {
    const ctx = this.ctx;
    this.decals.update(ctx.time);
    this.marks.update(ctx.time);
    this.brass.update(dt);
    this.gibs.update(dt);
    for (let i = this.bleeders.length - 1; i >= 0; i--) {
      const b = this.bleeders[i];
      b.t -= dt;
      b.pulse -= dt;
      if (b.t <= 0 || (b.zb.dead && b.zb.deadT > 3)) {
        this.bleeders.splice(i, 1);
        continue;
      }
      if (b.pulse > 0) continue;
      // Pumping: each beat is weaker than the last.
      b.pulse = 0.22 + (1 - b.t / 3.2) * 0.35;
      const zb = b.zb;
      const rx = Math.cos(zb.yaw);
      const rz = -Math.sin(zb.yaw);
      const fx = Math.sin(zb.yaw);
      const fz = Math.cos(zb.yaw);
      const x = zb.x + rx * b.lx + fx * b.lz;
      const z = zb.z + rz * b.lx + fz * b.lz;
      const y = zb.y + b.ly - (zb.dead ? Math.min(1, zb.fall) * b.ly * 0.8 : 0);
      const up = b.head ? 1 : 0.35;
      const a = Math.random() * 6.28;
      const out = b.head ? 0.25 : 0.7;
      ctx.fx.bloodSpray(x, y, z, Math.cos(a) * out + b.dx * 0.3, up, Math.sin(a) * out + b.dz * 0.3, b.head ? 7 : 4, (b.head ? 5.5 : 3.4) * Math.min(1, 0.35 + b.t / 2), 0.4);
      // Where it lands.
      const d = 0.5 + Math.random() * (b.head ? 2.2 : 1.4);
      this.groundSplat(x + Math.cos(a) * d, z + Math.sin(a) * d, 0.18 + Math.random() * 0.22, CELL.splat0 + Math.floor(Math.random() * 4), 0.85, Math.cos(a), Math.sin(a), y);
    }
  }

  clear() {
    this.bleeders.length = 0;
    this.decals.clear();
    this.marks.clear();
    this.brass.clear();
    this.gibs.clear();
  }

  dispose() {
    this.bleeders.length = 0;
    this.decals.dispose();
    this.marks.dispose();
    this.brass.dispose();
    this.gibs.dispose();
  }
}
