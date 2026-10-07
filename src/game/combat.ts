import * as THREE from 'three';
import { G, groups } from '../physics/physics';
import {
  AMMO,
  SURFACES,
  damageFraction,
  stepBullet,
  surfaceOfBox,
  throughFlesh,
  throughSlab,
  zeroPitch,
  type AmmoKind,
  type AmmoSpec,
  type Surface,
} from '../sim/ballistics';
import { structuralMul } from '../sim/breach';
import { IMPACT_SOUND, MUZZLE_LIGHT_AHEAD, MUZZLE_LIGHT_LIFE, MUZZLE_LIGHT_POWER, SKIP_DAMAGE, TRACER, skipOf, tracerTint } from '../sim/weaponfx';
import { windAt } from '../sim/weather';
import { sticks } from '../sim/archery';
import type { ArrowHost } from './arrows';
import type { Ctx } from './ctx';
import type { Vehicle } from './vehicle';
import type { Player } from './player';
import type { Aabb } from '../world/layout';
import type { Zombie } from './zombies';
import type { Animal } from './wildlife';
import type { Infantry } from './raiders';
import type { Traveller } from './travellers';
import type { GroundMaterial } from '../sim/groundImpact';

export interface ShotOpts {
  side: 'convoy' | 'raider';
  /** Vehicle whose own body the ray must ignore. */
  ownVehicle?: Vehicle | null;
  owner?: Player | null;
  damage: number;
  range?: number;
  /** Half-angle of the cone the bullet may wander in, radians. */
  spread?: number;
  /** Fraction of target armor ignored. */
  pierce?: number;
  tracer?: boolean;
  incendiary?: boolean;
  /** Player aim assist multiplier (0 disables). */
  assist?: number;
  /** Loudness added to the Signature grid at the shooter. */
  noise?: number;
  headshots?: boolean;
  /** The round it fires. Default: a raider's for raiders, a mounted gun's from a vehicle, else a pistol's. */
  ammo?: AmmoKind;
  /** Muzzle velocity as a share of the round's: a suppressor or a short barrel slows it, a long barrel speeds it. */
  vel?: number;
  /**
   * Where the round is seen to leave from, when that is not where it is fired from: an arrow is drawn coming off the bow as
   * it is held, and eases onto its true path over the first few metres.
   */
  seen?: [number, number, number];
}

/** A round in the air. */
interface Bullet {
  x: number;
  y: number;
  z: number;
  /** Where it was a tick ago, for drawing it between ticks. */
  px: number;
  py: number;
  pz: number;
  /** How far the drawn round sits off its path as it leaves (see `ShotOpts.seen`). */
  seen?: [number, number, number];
  vx: number;
  vy: number;
  vz: number;
  spec: AmmoSpec;
  kind: AmmoKind;
  o: ShotOpts;
  /** Where it left the gun, for who a hit zombie turns toward. */
  ox: number;
  oz: number;
  range: number;
  travelled: number;
  dead: boolean;
  /** Whether this round gets a streak drawn for it (a share of them do, by ammo). */
  trace: boolean;
  /** Skipped off a hard surface already: it only does so once. */
  skipped: boolean;
  /** The car whose panel it has just come through: it is inside the cab now, and the car's box no longer stops it. */
  inside?: Vehicle;
  /** The car whose crew it has already gone through. */
  throughCrew?: Vehicle;
}

type Hit =
  | { t: 'static'; dist: number; x: number; y: number; z: number; nx: number; ny: number; nz: number; handle: number; vehicle: Vehicle | null }
  | { t: 'zombie'; dist: number; zombie: Zombie; head: boolean }
  | { t: 'infantry'; dist: number; unit: Infantry; head: boolean }
  | { t: 'animal'; dist: number; animal: Animal }
  | { t: 'traveller'; dist: number; unit: Traveller; head: boolean }
  | { t: 'crew'; dist: number; vehicle: Vehicle; head: boolean }
  | { t: 'player'; dist: number; player: Player };

const RAY_FILTER = groups(0xffff, G.STATIC | G.VEHICLE | G.BUILD | G.FURN | G.LOOSE);
/** The thickest slab a round is measured through. Anything more is a wall to the other side of the world. */
const MAX_SLAB = 2.5;
/** How far through a hollow box (a shipping container) a round is followed to find its far skin. */
const HOLLOW_SLAB = 7;
/** Boxes that stand in for something round: good for stopping a bullet, wrong for pinning a mark to. */
const ROUGH_KINDS = new Set(['rock', 'tower', 'pillar']);

export class Combat {
  /** Rounds in the air. */
  bullets: Bullet[] = [];
  /** Wind this tick, m/s (x, z). */
  wind: [number, number] = [0, 0];
  /** Called when a round lands on something, for tests and the audio. */
  onImpact: ((e: { surface: Surface | 'flesh'; x: number; y: number; z: number; speed: number; penetrated: boolean }) => void) | null = null;

  /** One shared light that flashes at the latest muzzle, so night fights light the people in them without a light per gun. */
  light = new THREE.PointLight(0xffb468, 0, 14, 2);
  private lightT = 0;
  private lightPeak = 0;

  constructor(private ctx: Ctx) {
    ctx.root.add(this.light);
  }

  /**
   * A gun went off here, pointing along (dx, dy, dz): flash the shared light, brightest at the moment of the shot. The light
   * sits a little out in front of the muzzle, where the flame is, so it lights the scene rather than blinding the shooter's
   * own hands and face a hand's length behind it.
   */
  muzzleLight(x: number, y: number, z: number, strength: number, dx = 0, dy = 0, dz = 0) {
    this.light.position.set(x + dx * MUZZLE_LIGHT_AHEAD, y + dy * MUZZLE_LIGHT_AHEAD, z + dz * MUZZLE_LIGHT_AHEAD);
    this.lightPeak = Math.max(strength * MUZZLE_LIGHT_POWER, this.lightT > 0 ? this.light.intensity : 0);
    this.lightT = MUZZLE_LIGHT_LIFE;
    this.light.intensity = this.lightPeak;
  }

  /** Nudge a shot direction toward the nearest enemy in a narrow cone, leading a target that is moving. Stronger assist on keyboard. */
  assist(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, strength: number, speed = 300): [number, number, number] {
    if (strength <= 0) return [dx, dy, dz];
    const cone = Math.cos((5.5 * strength * Math.PI) / 180);
    let best: { x: number; y: number; z: number; score: number } | null = null;
    const consider = (x: number, y: number, z: number, vx = 0, vz = 0) => {
      const vx0 = x - ox;
      const vy0 = y - oy;
      const vz0 = z - oz;
      const len = Math.hypot(vx0, vy0, vz0);
      if (len < 2 || len > 70) return;
      // The round takes time to get there: aim where a moving body will be, not where it is.
      const lead = (len / speed) * Math.min(1, strength) * 0.85;
      const lx = vx0 + vx * lead;
      const lz = vz0 + vz * lead;
      const c = (vx0 * dx + vy0 * dy + vz0 * dz) / len;
      if (c < cone) return;
      const score = c * 100 - len * 0.1;
      if (!best || score > best.score) best = { x: ox + lx, y, z: oz + lz, score };
    };
    this.ctx.zombies.forEachNear(ox, oz, 70, (zb) => {
      if (zb.dead) return;
      consider(zb.x, zb.y + 1.2 * zb.def.scale, zb.z, zb.vx, zb.vz);
    });
    // Hunters that have turned on someone are worth aiming at; grazing deer are not.
    this.ctx.wildlife.forEachNear(ox, oz, 70, (a) => {
      if (a.chasing && !a.flying) consider(a.x, a.y + a.height * 0.6, a.z);
    });
    this.ctx.raiders.forEachTarget(ox, oz, 80, (x, y, z) => consider(x, y, z));
    if (!best) return [dx, dy, dz];
    const b = best as { x: number; y: number; z: number };
    let tx = b.x - ox;
    let ty = b.y - oy;
    let tz = b.z - oz;
    const tl = Math.hypot(tx, ty, tz);
    tx /= tl;
    ty /= tl;
    tz /= tl;
    const k = Math.min(0.75, 0.55 * strength);
    let nx = dx + (tx - dx) * k;
    let ny = dy + (ty - dy) * k;
    let nz = dz + (tz - dz) * k;
    const nl = Math.hypot(nx, ny, nz);
    nx /= nl;
    ny /= nl;
    nz /= nl;
    return [nx, ny, nz];
  }

  /**
   * Fire a round. It leaves the muzzle at its own speed and is flown a tick at a time by `update`: gravity pulls it down,
   * the air (and a storm's wind) pushes it, and it can punch through thin cover on the way to whatever it finally hits.
   */
  shoot(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, o: ShotOpts): void {
    const ctx = this.ctx;
    const range = o.range ?? 90;
    const kind: AmmoKind = o.ammo ?? (o.side === 'raider' ? 'raider' : o.ownVehicle ? 'turret' : 'pistol');
    const spec = AMMO[kind];
    const speed = spec.speed * (o.vel ?? 1);
    if (o.assist) [dx, dy, dz] = this.assist(ox, oy, oz, dx, dy, dz, o.assist, speed);
    if (o.spread) {
      const s = o.spread;
      const rx = (ctx.rng.next() - 0.5) * 2 * s;
      const ry = (ctx.rng.next() - 0.5) * 2 * s;
      const rz = (ctx.rng.next() - 0.5) * 2 * s;
      dx += rx;
      dy += ry;
      dz += rz;
      const l = Math.hypot(dx, dy, dz);
      dx /= l;
      dy /= l;
      dz /= l;
    }
    // Sights are set for a range: tip the barrel up a hair so the round crosses the line of sight there.
    dy += zeroPitch(spec, range);
    const l = Math.hypot(dx, dy, dz);
    dx /= l;
    dy /= l;
    dz /= l;
    const trace = o.tracer !== false && Math.random() < TRACER[kind].chance;
    const seen: [number, number, number] | undefined = o.seen ? [o.seen[0] - ox, o.seen[1] - oy, o.seen[2] - oz] : undefined;
    this.bullets.push({ x: ox, y: oy, z: oz, px: ox, py: oy, pz: oz, seen, vx: dx * speed, vy: dy * speed, vz: dz * speed, spec, kind, o, ox, oz, range, travelled: 0, dead: false, trace, skipped: false });
    if (o.noise) ctx.sig.emit(ox, oz, o.noise * ctx.signatureMult, 'noise');
    // Everyone within earshot on the road heard that. A bow is not heard.
    if (kind !== 'arrow') ctx.travellers.heardShot(ox, oz);
  }

  /** Fly every round in the air one tick. */
  update(dt: number) {
    if (this.lightT > 0) {
      this.lightT -= dt;
      this.light.intensity = this.lightT > 0 ? this.lightPeak * (this.lightT / MUZZLE_LIGHT_LIFE) : 0;
    }
    if (!this.bullets.length) return;
    const ctx = this.ctx;
    this.wind = windAt(ctx.storm, ctx.time);
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      this.advance(b, dt);
      if (b.dead) {
        this.bullets[i] = this.bullets[this.bullets.length - 1];
        this.bullets.pop();
      }
    }
  }

  clear() {
    this.bullets.length = 0;
    this.lightT = 0;
    this.light.intensity = 0;
  }

  private advance(b: Bullet, dt: number) {
    const ctx = this.ctx;
    const x0 = (b.px = b.x);
    const y0 = (b.py = b.y);
    const z0 = (b.pz = b.z);
    const [wx, wz] = this.wind;
    stepBullet(b, dt / 2, b.spec.drag, wx, wz);
    stepBullet(b, dt / 2, b.spec.drag, wx, wz);
    let dx = b.x - x0;
    let dy = b.y - y0;
    let dz = b.z - z0;
    let len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) {
      b.dead = true;
      return;
    }
    dx /= len;
    dy /= len;
    dz /= len;
    // The range limit ends it mid-tick if it runs out.
    if (b.travelled + len > b.range) len = Math.max(0, b.range - b.travelled);
    let cx = x0;
    let cy = y0;
    let cz = z0;
    let left = len;
    for (let stage = 0; stage < 6 && left > 1e-4 && !b.dead; stage++) {
      const h = this.firstHit(b, cx, cy, cz, dx, dy, dz, left);
      const speed = Math.hypot(b.vx, b.vy, b.vz);
      ctx.P.hitAlongRay({ x: cx, y: cy, z: cz, dx, dy, dz, impulse: b.spec.mass * speed,
        energy: 0.5 * b.spec.mass * speed * speed, kind: 'bullet' }, h?.dist ?? left);
      if (!h) {
        cx += dx * left;
        cy += dy * left;
        cz += dz * left;
        left = 0;
        break;
      }
      const used = h.dist;
      cx += dx * used;
      cy += dy * used;
      cz += dz * used;
      left -= used;
      const adv = this.land(b, h, cx, cy, cz, dx, dy, dz);
      if (adv) {
        // Through the far side: carry on from there along the new heading.
        cx = adv.x;
        cy = adv.y;
        cz = adv.z;
        left = Math.max(0, left - adv.run);
        dx = adv.dx;
        dy = adv.dy;
        dz = adv.dz;
      }
    }
    b.travelled += len;
    if (b.trace) {
      const style = TRACER[b.kind];
      const [tr, tg, tb] = tracerTint(style, b.o.side === 'raider');
      ctx.tracers.add(x0, y0, z0, cx, cy, cz, tr, tg, tb, style.life);
    }
    if (!b.dead) {
      b.x = cx;
      b.y = cy;
      b.z = cz;
      if (b.travelled >= b.range - 1e-3) b.dead = true;
      else if (cy < ctx.groundAt(cx, cz) - 2) b.dead = true;
    }
  }

  /** Nearest thing along a segment: the world, or anyone the round can hurt. */
  private firstHit(b: Bullet, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxD: number): Hit | null {
    const ctx = this.ctx;
    const o = b.o;
    let best: Hit | null = null;
    let bestD = maxD;
    // Static geometry and vehicles through Rapier. Friendly vehicles never stop friendly bullets.
    const own = o.ownVehicle?.body.body;
    const friendly = (v: Vehicle) => (o.side === 'convoy' && v.faction === 'convoy') || (o.side === 'raider' && v.faction === 'raider');
    const rh = ctx.P.raycast(ox, oy, oz, dx, dy, dz, maxD, RAY_FILTER, own, (c) => {
      const v = ctx.vehicleByCollider.get(c.handle);
      return !(v && (v === b.inside || (!v.wreck && friendly(v))));
    });
    if (rh) {
      const v = ctx.vehicleByCollider.get(rh.collider.handle) ?? null;
      best = { t: 'static', dist: rh.toi, x: ox + dx * rh.toi, y: oy + dy * rh.toi, z: oz + dz * rh.toi, nx: rh.normal.x, ny: rh.normal.y, nz: rh.normal.z, handle: rh.collider.handle, vehicle: v && !v.wreck ? v : null };
      bestD = rh.toi;
    }
    if (o.side === 'convoy') {
      // A round passing over a snake kills it (and goes on).
      ctx.life?.shootThrough(ox, oy, oz, dx, dy, dz, bestD);
      const an = ctx.wildlife.rayTest(ox, oy, oz, dx, dy, dz, bestD);
      if (an && an.dist < bestD) {
        best = { t: 'animal', dist: an.dist, animal: an.animal };
        bestD = an.dist;
      }
      const z = ctx.zombies.rayTest(ox, oy, oz, dx, dy, dz, bestD);
      if (z && z.dist < bestD) {
        best = { t: 'zombie', dist: z.dist, zombie: z.zombie, head: z.head };
        bestD = z.dist;
      }
      const inf = ctx.raiders.infantryRayTest(ox, oy, oz, dx, dy, dz, bestD);
      if (inf && inf.dist < bestD) {
        best = { t: 'infantry', dist: inf.dist, unit: inf.unit, head: inf.head };
        bestD = inf.dist;
      }
      const trv = ctx.travellers.rayTest(ox, oy, oz, dx, dy, dz, bestD);
      if (trv && trv.dist < bestD) {
        best = { t: 'traveller', dist: trv.dist, unit: trv.unit, head: trv.head };
        bestD = trv.dist;
      }
      // The crew of a raider car: up in a buggy's open frame, or behind a wagon's visor slits.
      const cr = ctx.raiders.crewRayTest(ox, oy, oz, dx, dy, dz, bestD, null, b.throughCrew);
      if (cr && cr.dist < bestD) {
        best = { t: 'crew', dist: cr.dist, vehicle: cr.vehicle, head: cr.head };
        bestD = cr.dist;
      }
    } else {
      const pl = this.playerRay(ox, oy, oz, dx, dy, dz, bestD);
      if (pl && pl.dist < bestD) best = { t: 'player', dist: pl.dist, player: pl.player };
    }
    return best;
  }

  /**
   * A round arrived at a hit. Do what it does there. Returns where it comes out and how it is heading if it went through
   * (flesh, a wall, a car door), or null if it stopped.
   */
  private land(b: Bullet, h: Hit, x: number, y: number, z: number, dx: number, dy: number, dz: number): { x: number; y: number; z: number; dx: number; dy: number; dz: number; run: number } | null {
    const ctx = this.ctx;
    const o = b.o;
    const spec = b.spec;
    const speed = Math.hypot(b.vx, b.vy, b.vz);
    const frac = damageFraction(speed / spec.speed);
    const owner = o.owner?.index ?? -1;
    let after = 0;
    let thickRun = 0;
    switch (h.t) {
      case 'zombie': {
        const zb = h.zombie;
        const head = !!o.headshots && h.head;
        const dmg = o.damage * frac * (head ? 2 : 1) * (1 - zb.def.armor * (1 - (o.pierce ?? 0)));
        const res = ctx.zombies.bulletHit(zb, { dmg, dx, dy, dz, x, y, z, head, spec, speed, fromX: b.ox, fromZ: b.oz, killer: owner });
        const power = dmg / zb.def.hp;
        ctx.gore.flesh(x, y, z, dx, dy, dz, power * (head ? 1.3 : 1));
        for (const zone of res.off) ctx.gore.sever(zb, zone, dx, dy, dz, power * Math.max(0.5, spec.gore));
        this.onImpact?.({ surface: 'flesh', x, y, z, speed, penetrated: false });
        after = throughFlesh(spec, speed);
        thickRun = zb.def.radius * 1.7;
        if (b.kind === 'arrow') this.arrowIn(zb, x, y, z, dx, dy, dz, speed);
        break;
      }
      case 'infantry': {
        const dmg = o.damage * frac * (h.head && o.headshots ? 2 : 1);
        ctx.raiders.damageInfantry(h.unit, dmg, owner);
        ctx.gore.flesh(x, y, z, dx, dy, dz, dmg / Math.max(1, h.unit.def.hp));
        this.onImpact?.({ surface: 'flesh', x, y, z, speed, penetrated: false });
        after = throughFlesh(spec, speed);
        thickRun = 0.7;
        if (b.kind === 'arrow') this.arrowIn(h.unit, x, y, z, dx, dy, dz, speed);
        break;
      }
      case 'traveller': {
        const dmg = o.damage * frac * (h.head && o.headshots ? 2 : 1);
        ctx.travellers.damage(h.unit, dmg, owner, { x: b.ox, z: b.oz });
        ctx.gore.flesh(x, y, z, dx, dy, dz, dmg / Math.max(1, h.unit.def.hp));
        this.onImpact?.({ surface: 'flesh', x, y, z, speed, penetrated: false });
        after = throughFlesh(spec, speed);
        thickRun = 0.7;
        if (b.kind === 'arrow') this.arrowIn(h.unit, x, y, z, dx, dy, dz, speed);
        break;
      }
      case 'animal': {
        const a = h.animal;
        const dmg = o.damage * frac * (1 - a.def.armor * (1 - (o.pierce ?? 0)));
        const res = ctx.wildlife.bulletHit(a, { dmg, dx, dy, dz, x, y, z, spec, speed, fromX: b.ox, fromZ: b.oz, killer: owner });
        const power = dmg / Math.max(1, a.def.hp);
        ctx.gore.flesh(x, y, z, dx, dy, dz, power);
        for (const part of res.off) ctx.gore.severAnimal(a, part, dx, dy, dz, power * Math.max(0.5, spec.gore));
        this.onImpact?.({ surface: 'flesh', x, y, z, speed, penetrated: false });
        after = throughFlesh(spec, speed);
        thickRun = 0.6;
        if (b.kind === 'arrow') this.arrowIn(a, x, y, z, dx, dy, dz, speed);
        break;
      }
      case 'crew': {
        // Shot in the seat. The car is not touched: only whoever is sitting in it.
        const dmg = o.damage * frac * (h.head && o.headshots ? 2 : 1);
        ctx.raiders.hurtCrew(h.vehicle, dmg, owner);
        ctx.gore.flesh(x, y, z, dx, dy, dz, dmg / 60);
        this.onImpact?.({ surface: 'flesh', x, y, z, speed, penetrated: false });
        b.throughCrew = h.vehicle;
        if (b.kind !== 'arrow' && b.kind !== 'bolt') {
          after = throughFlesh(spec, speed);
          thickRun = 0.6;
        }
        break;
      }
      case 'player': {
        // Raider rounds are tuned to chew vehicles; people on foot take a reduced share.
        h.player.hurt(o.damage * frac * 0.55, b.ox, b.oz, 'bullet');
        ctx.gore.flesh(x, y, z, dx, dy, dz, 0.3);
        this.onImpact?.({ surface: 'flesh', x, y, z, speed, penetrated: false });
        after = 0;
        break;
      }
      case 'static': {
        const v = h.vehicle;
        if (v) {
          // An arrow barely marks a car.
          const dmg = o.damage * frac * (o.side === 'raider' ? ctx.campaign.difficulty.damage : 1) * (b.kind === 'arrow' ? 0.1 : 1);
          v.takeHit(dmg, b.ox, b.oz, { incendiary: o.incendiary, pierce: o.pierce, at: [h.x, h.y, h.z], bullet: structuralMul(b.kind, 'sheet') });
          // The car is boxed roughly: follow the round on through it to see whether it crossed a window.
          v.glass.hitRay(h.x, h.y, h.z, dx, dy, dz, o.damage * frac * structuralMul(b.kind, 'glass'));
          ctx.fx.spark(h.x, h.y, h.z, 3, 4);
        } else if (o.side === 'raider') {
          ctx.structureHit?.(h.handle, o.damage * frac * ctx.campaign.difficulty.damage);
        }
        const tagged = v ? undefined : (ctx.P.surfaces.get(h.handle) as Surface | undefined);
        // A tagged collider (a prop, a stone) is its own thing: not the box of the world that happens to stand beside it.
        const box = v || tagged ? null : this.boxAt(h.x, h.y, h.z);
        const boxThin = box ? Math.min(box.maxX - box.minX, box.maxZ - box.minZ) : 0;
        const ground = !v && !tagged && !box && Math.abs(h.y - ctx.groundAt(h.x, h.z)) < 0.7;
        const groundMaterial: GroundMaterial = ctx.surfaceAt(h.x, h.z).name;
        const terrainSurface: Surface = groundMaterial === 'asphalt' ? 'concrete' : 'dirt';
        const surface: Surface = v ? 'car' : tagged ? tagged : box ? surfaceOfBox(box.kind, boxThin, box.mat) : ground ? terrainSurface : h.ny > 0.6 ? 'dirt' : 'stone';
        const info = SURFACES[surface];
        // Round things (rocks, tanks, pillars) are boxed roughly, so a mark put on the box would hang in the air beside them.
        const exact = tagged ? true : !box || !ROUGH_KINDS.has(box.kind);
        // A loose prop (a drum, a tyre) is shoved by the round's momentum.
        if (!v) {
          const body = ctx.P.world.getCollider(h.handle)?.parent();
          if (body && body.isDynamic()) body.applyImpulseAtPoint({ x: dx * spec.mass * speed, y: dy * spec.mass * speed, z: dz * spec.mass * speed }, { x: h.x, y: h.y, z: h.z }, true);
        }
        const floorImpact = ground || (!v && exact && h.ny > 0.6 && (surface === 'stone' || surface === 'concrete' || surface === 'dirt'));
        const floorMaterial: GroundMaterial = ground || surface === 'dirt' ? groundMaterial : surface === 'stone' ? 'stone' : 'concrete';
        if (floorImpact) ctx.gore.groundStrike(b.kind, floorMaterial, h.x, h.y, h.z, h.nx, h.ny, h.nz, dx, dy, dz, speed);
        else ctx.gore.impact(surface, h.x, h.y, h.z, h.nx, h.ny, h.nz, dx, dz, (speed / spec.speed) * (o.damage / 30), { moving: !!v, size: spec.hole, heavy: spec.hole >= 0.15, mark: exact, shaft: b.kind === 'arrow' || b.kind === 'bolt' });
        // How far through it goes is worked out before the blow is dealt: a pane that breaks or a wall that gives way is
        // not there to be measured afterwards, and the round should carry on through it.
        let exit = 0;
        let geo = 0;
        // A raider's crew sitting behind the panel it holed: the round goes on into the cab after them.
        const cab = v && o.side === 'convoy' && b.kind !== 'arrow' && b.kind !== 'bolt' && ctx.raiders.crewRayTest(h.x, h.y, h.z, dx, dy, dz, MAX_SLAB, v, b.throughCrew);
        if (cab) {
          geo = 0.02;
          exit = throughSlab(spec, speed, 'sheet', SURFACES.sheet.ref);
          if (exit > 0) b.inside = v;
        } else if (!ground && info.stop < 9) {
          const thinPlate = surface === 'sheet' || surface === 'glass';
          // A container or a tank is hollow: two skins with air between, however deep the box is.
          const hollow = surface === 'sheet' && boxThin > 0.6;
          const probe = hollow ? HOLLOW_SLAB : MAX_SLAB;
          const back = ctx.P.raycast(h.x + dx * probe, h.y + dy * probe, h.z + dz * probe, -dx, -dy, -dz, probe, RAY_FILTER, undefined, (c) => c.handle === h.handle);
          geo = back && back.toi > 1e-4 ? probe - back.toi : Infinity;
          if (geo < probe) {
            if (thinPlate) {
              let sp = speed;
              for (let k = 0; k < (hollow ? 2 : 1) && sp > 0; k++) sp = throughSlab(spec, sp, surface, info.ref);
              exit = sp;
            } else if (geo < MAX_SLAB) exit = throughSlab(spec, speed, surface, geo);
          }
        }
        this.onImpact?.({ surface, x: h.x, y: h.y, z: h.z, speed, penetrated: exit > 0 });
        const sound = floorImpact ? undefined : b.kind === 'arrow' || b.kind === 'bolt' ? (sticks(surface) ? 'thunk' : 'tink') : IMPACT_SOUND[surface];
        if (box?.kind === 'tree') ctx.audio.play('rustle', h.x, h.z, 0.25);
        if (sound && (speed > 60 || b.kind === 'arrow')) ctx.audio.play(sound, h.x, h.z, 0.2 + 0.3 * Math.min(1, o.damage / 60), { intensity: Math.min(1, o.damage / 60) });
        // Whatever it hit may give way: glass breaks, a plank wall opens, a barricade splinters. A pistol cannot bring down a
        // wall, but it shatters a pane and chews sheet metal. Done after the round's own marks are laid, so a wall that falls
        // takes them with it.
        const strike = () => {
          ctx.P.hitCollider(h.handle, { x: h.x, y: h.y, z: h.z, dx, dy, dz,
            impulse: spec.mass * Math.max(0, speed - exit), energy: 0.5 * spec.mass * Math.max(0, speed * speed - exit * exit), kind: 'bullet' });
          if (!box || !ctx.world) return;
          const mul = box.kind === 'barricade' ? 1 : structuralMul(b.kind, surface);
          if (mul > 0) ctx.world.hit(box, o.damage * frac * mul, 'bullet', { x: h.x, y: h.y, z: h.z, nx: h.nx, ny: h.ny, nz: h.nz });
        };
        if (exit > 0) {
          // Out the far side, slower and a little off true, with a puff where it leaves.
          const loss = 1 - exit / speed;
          const jit = 0.01 + 0.05 * loss;
          let ndx = dx + (ctx.rng.next() - 0.5) * 2 * jit;
          let ndy = dy + (ctx.rng.next() - 0.5) * 2 * jit;
          let ndz = dz + (ctx.rng.next() - 0.5) * 2 * jit;
          const nl = Math.hypot(ndx, ndy, ndz);
          ndx /= nl;
          ndy /= nl;
          ndz /= nl;
          b.vx = ndx * exit;
          b.vy = ndy * exit;
          b.vz = ndz * exit;
          const run = geo + 0.04;
          // The hole it leaves on the far face.
          if (!v && exact) ctx.gore.exitHole(surface, h.x + dx * geo, h.y + dy * geo, h.z + dz * geo, dx, dy, dz, (exit / spec.speed) * (o.damage / 30), spec.hole);
          const px = h.x + dx * run;
          const py = h.y + dy * run;
          const pz = h.z + dz * run;
          ctx.fx.puff(px, py, pz, info.tint[0], info.tint[1], info.tint[2], 0.5, 0.4);
          if (info.spark) ctx.fx.spark(px, py, pz, info.spark, 3);
          strike();
          return { x: px, y: py, z: pz, dx: ndx, dy: ndy, dz: ndz, run };
        }
        strike();
        // A glancing blow on something hard skips off it, weaker and flying wide, with a spark and a whine. Only once. An
        // arrow does not: it goes in, or glances off and falls.
        if (b.kind === 'arrow' || b.kind === 'bolt') {
          b.dead = true;
          ctx.arrows?.landed(surface, h.x, h.y, h.z, h.nx, h.ny, h.nz, dx, dy, dz, speed / spec.speed, !!v, b.kind === 'bolt');
          return null;
        }
        if (!v && !b.skipped && exact) {
          const jit: [number, number, number] = [ctx.rng.next() * 2 - 1, ctx.rng.next() * 2 - 1, ctx.rng.next() * 2 - 1];
          const sk = skipOf(b.kind, surface, speed, [dx, dy, dz], [h.nx, h.ny, h.nz], ctx.rng.next(), jit);
          if (sk) {
            b.skipped = true;
            b.vx = sk.dx * sk.speed;
            b.vy = sk.dy * sk.speed;
            b.vz = sk.dz * sk.speed;
            b.o = { ...o, damage: o.damage * SKIP_DAMAGE, pierce: 0, noise: 0 };
            ctx.fx.spark(h.x, h.y, h.z, 7, 5);
            ctx.audio.play('ricochet', h.x, h.z, 0.35);
            return { x: h.x + sk.dx * 0.06, y: h.y + sk.dy * 0.06, z: h.z + sk.dz * 0.06, dx: sk.dx, dy: sk.dy, dz: sk.dz, run: 0.06 };
          }
        }
        b.dead = true;
        return null;
      }
    }
    if (after > 0) {
      // Out the other side of the body, slower, still on its way.
      b.vx = dx * after;
      b.vy = dy * after;
      b.vz = dz * after;
      return { x: x + dx * thickRun, y: y + dy * thickRun, z: z + dz * thickRun, dx, dy, dz, run: thickRun };
    }
    b.dead = true;
    return null;
  }

  /** An arrow went into a body: unless it carries on through, it stays in, riding with it. */
  private arrowIn(host: ArrowHost, x: number, y: number, z: number, dx: number, dy: number, dz: number, speed: number) {
    const spec = AMMO.arrow;
    if (throughFlesh(spec, speed) > 0) return;
    this.ctx.audio.play('thunk', x, z, 0.35);
    this.ctx.arrows?.inBody(host, x, y, z, dx, dy, dz, speed / spec.speed);
  }

  /**
   * The box of the world at a point on a surface, if there is one: the one the point is nearest (inside counts as nearest),
   * and of those the thinnest. Nearest first matters for a pane of glass standing a few centimetres off a wall: a round that
   * has just come through the glass and struck the wall must find the wall, not the glass beside it.
   */
  private boxAt(x: number, y: number, z: number): Aabb | null {
    let found: Aabb | null = null;
    let best = Infinity;
    let thin = Infinity;
    this.ctx.obs.near(x, z, 0.6, (a) => {
      if (x < a.minX - 0.25 || x > a.maxX + 0.25 || z < a.minZ - 0.25 || z > a.maxZ + 0.25) return;
      if (y < a.y0 - 0.25 || y > a.y1 + 0.25) return;
      const d = Math.hypot(Math.max(a.minX - x, 0, x - a.maxX), Math.max(a.minZ - z, 0, z - a.maxZ), Math.max(a.y0 - y, 0, y - a.y1));
      const t = Math.min(a.maxX - a.minX, a.maxZ - a.minZ);
      // Within a millimetre counts as the same distance.
      if (d < best - 1e-3 || (d < best + 1e-3 && t < thin)) {
        best = d;
        thin = t;
        found = a;
      }
    });
    return found;
  }

  private playerRay(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxD: number): { player: Player; dist: number } | null {
    let best: { player: Player; dist: number } | null = null;
    for (const p of this.ctx.players) {
      if (!p.targetable) continue;
      const px = p.pos.x;
      const pz = p.pos.z;
      const py = p.pos.y;
      const vx = px - ox;
      const vz = pz - oz;
      // closest approach in XZ along the ray
      const dh = Math.hypot(dx, dz) || 1;
      const t = (vx * dx + vz * dz) / dh;
      if (t < 0 || t > maxD) continue;
      const cx = ox + (dx / dh) * t;
      const cz = oz + (dz / dh) * t;
      if (Math.hypot(cx - px, cz - pz) > 0.45) continue;
      const ty = oy + (dy / dh) * t;
      if (ty < py - 0.1 || ty > py + 1.9) continue;
      // The ray parameter is along the unit 3D direction, like the other ray tests; `t` is only the horizontal run.
      const tt = t / dh;
      if (!best || tt < best.dist) best = { player: p, dist: tt };
    }
    return best;
  }

  /** Area damage. Zombies and raiders take full damage, vehicles are reduced by armor, players take half. */
  explode(x: number, y: number, z: number, radius: number, damage: number, o: { side: 'convoy' | 'raider' | 'neutral'; owner?: Player | null; incendiary?: boolean }) {
    const ctx = this.ctx;
    ctx.fx.explosion(x, y, z, Math.max(0.6, radius / 5));
    // The fireball lights everything round it for a moment, and dry grass under it catches.
    if (ctx.fires) {
      ctx.fires.flash(x, y + 0.5, z, 900 * Math.max(0.6, radius / 5) ** 2, 0.45);
      for (let k = 0; k < 4; k++) ctx.fires.igniteGround(x + (Math.random() - 0.5) * radius, z + (Math.random() - 0.5) * radius, 0.6, o.owner?.index ?? -1);
    }
    ctx.audio.play('boom', x, z, 1);
    ctx.sig.emit(x, z, 100, 'noise');
    // A real blast breaks what it can and chars the ground.
    ctx.gore.groundBlast(x, y, z, radius, damage);
    ctx.world?.blast(x, y, z, radius, damage);
    for (const p of ctx.players) p.cam.addShake(Math.max(0, 0.9 - Math.hypot(p.pos.x - x, p.pos.z - z) / (radius * 4)));
    ctx.zombies.blast(x, z, radius, damage, o.owner?.index ?? -1);
    ctx.wildlife.blast(x, z, radius, damage, o.owner?.index ?? -1);
    ctx.raiders.blast(x, z, radius, damage, o.owner?.index ?? -1, o.side !== 'raider');
    ctx.travellers.blast(x, z, radius, damage, o.owner?.index ?? -1);
    for (const v of ctx.vehicles) {
      if (v.wreck) continue;
      const d = Math.hypot(v.position.x - x, v.position.z - z);
      if (d > radius + v.def.length * 0.5) continue;
      const f = 1 - Math.min(1, d / (radius + v.def.length * 0.5));
      if (o.side === 'convoy' && v.faction === 'convoy' && !o.owner) continue;
      v.takeHit(damage * f * 0.8, x, z, { incendiary: !!o.incendiary, ram: true, blast: f });
      const k = f * v.mass * 2;
      const dx = v.position.x - x;
      const dz = v.position.z - z;
      const l = Math.hypot(dx, dz) || 1;
      v.shove((dx / l) * k, (dz / l) * k);
    }
    for (const p of ctx.players) {
      const d = Math.hypot(p.pos.x - x, p.pos.z - z);
      if (d < radius) p.hurt(damage * 0.5 * (1 - d / radius), x, z, 'blast');
    }
  }
}
