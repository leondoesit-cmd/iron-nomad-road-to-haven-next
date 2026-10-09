import * as THREE from 'three';
import { G, RAPIER, groups } from '../physics/physics';
import { AMMO, SURFACES, type AmmoKind, type Surface, type Zone } from '../sim/ballistics';
import { Brass, type MagKind, type ShellKind } from '../render/brass';
import { CELL, PITS, PUNCHES, SPALLS, Decals, anyOf } from '../render/decals';
import { SOILS } from '../sim/soil';
import { clamp } from '../core/math';
import { roadLift } from '../render/chunkview';
import { Gibs } from '../render/gibs';
import { Timber } from './timber';
import { FleshFx } from './fleshFx';
import type { AnimalKind, ZombieKind } from '../data';
import type { Ctx } from './ctx';
import { BODY, type AnimalPart } from '../sim/anatomy';
import type { Zombie } from './zombies';
import type { Animal } from './wildlife';
import { MELEE_ENERGY, groundImpact, type GroundMaterial, type GroundWeapon } from '../sim/groundImpact';
import type { MeleeKind } from '../sim/weaponfx';

const RAY = groups(0xffff, G.STATIC | G.VEHICLE | G.BUILD | G.FURN);
const _c = new THREE.Color();

/** Skin of each kind, as the zombie shader draws it, so a thrown arm matches the body it came off. */
const SKIN: Record<ZombieKind, number> = { walker: 0x6f7660, runner: 0x7a7660, screamer: 0x8e889a, bloater: 0x87904e, brute: 0x7a5a4c, stalker: 0x5c6670 };
const CLOTH = [0x5a5446, 0x3e4a58, 0x6a3a32, 0x7a7262, 0x2e3a2c, 0x4a3a52];
const TROUSERS = [0x2e3036, 0x3a3a2e, 0x4a4238, 0x252830];
/** Coat of each animal, as the animal renderer draws it. */
const COAT: Record<AnimalKind, number> = {
  hare: 0x9a8460,
  deer: 0xa87e50,
  vulture: 0x2b2622,
  dog: 0x6a5846,
  wolf: 0x6e7174,
  boar: 0x54443a,
  bear: 0x4c443e,
  ibex: 0xa88a64,
  camel: 0xb8946a,
  fox: 0xb8642a,
  jackal: 0xa88a5e,
  buffalo: 0x34302e,
  heron: 0x8a9096,
  stork: 0xeae6dc,
  duck: 0x7a6248,
  crow: 0x5e5e60,
  egret: 0xf2f2ee,
};

/** Anything with a body that can bleed from a stump: where it stands, which way it faces, and whether it is down. */
interface Bleedable {
  x: number;
  y: number;
  z: number;
  yaw: number;
  dead: boolean;
  deadT: number;
  fall: number;
}

interface Bleeder {
  zb: Bleedable;
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
  /** Animals roll onto their side rather than toppling backward. */
  roll?: number;
  lift?: number;
}

/**
 * Everything a fight leaves behind and everything that flies off in one: blood on walls and roads, limbs and meat thrown
 * clear, spent brass, bullet holes. It owns the pooled meshes and decides where each mark lands by casting into the world.
 */
/** Bare steel where a round tore the paint off. */
const METAL = [0.7, 0.69, 0.66] as const;
/** Metals: holed, they throw sparks and no chips. */
const METALS = new Set<Surface>(['sheet', 'car', 'steel']);
/** What it costs to knock a cubic metre out of a hard brittle face, J (a rifle round takes 30-45 cm^3 out of stone or concrete). */
const SPALL_Q: Partial<Record<Surface, number>> = { stone: 4e7, concrete: 3e7, plaster: 1e7 };
const SPALL_ASPHALT = 3e7;

/** How many sparks a blow of `ke` joules strikes off a surface: steel most, sheet and a car body fewer, stone and concrete a rare few. */
function sparkCount(surface: Surface, ke: number): number {
  const per = surface === 'steel' ? 110 : surface === 'sheet' || surface === 'car' ? 220 : surface === 'stone' ? 900 : surface === 'concrete' ? 1300 : 0;
  if (!per) return 0;
  const n = ke / per;
  return Math.min(16, Math.floor(n) + (Math.random() < n - Math.floor(n) ? 1 : 0));
}

export class Gore {
  /** Blood: wet, drying, recycled oldest first. */
  readonly decals = new Decals();
  /** What weapons do to the world: bullet holes, cracks, scorch. Their own pool, so a bloody fight does not wipe them. */
  readonly marks = new Decals(1100);
  readonly brass: Brass;
  readonly gibs: Gibs;
  /** Gunfire in the trees: chips, bark, leaves, scars, and trees snapping and coming down (`game/timber.ts`). */
  readonly timber: Timber;
  /** What blows do under the skin of the dead: wounds, breaks, severed pieces, spilled gut (`fleshFx.ts`). */
  readonly anatomy: FleshFx;
  private bleeders: Bleeder[] = [];
  /** Marks laid since the scene began, for tests. */
  placed = 0;

  constructor(private ctx: Ctx) {
    // Anything lying on the road rests on the drawn road, a few centimetres above the collider under it.
    const lift = (x: number, z: number) => (ctx.terrain ? roadLift(ctx.terrain, x, z) : 0);
    const floorAt = (x: number, y: number, z: number): number | null => {
      const r = ctx.P.raycast(x, y, z, 0, -1, 0, 3, RAY);
      // On the ground itself, the loose ground's dents and heaps: a clod lies in the crater it came out of.
      const loose = ctx.ground && (!r || r.collider.shapeType() === RAPIER.ShapeType.HeightField) ? ctx.ground.heightAt(x, z) : 0;
      return (r ? y - r.toi : ctx.groundAt(x, z)) + (!r || r.normal.y > 0.7 ? lift(x, z) : 0) + loose;
    };
    this.brass = new Brass({
      floorAt,
      ring: (x, y, z, loud) => {
        if (loud <= 0.06) return;
        // What it fell on decides what it sounds like: brass on stone is a dry tick, in sand a hush, on a car roof a short metal tap.
        const r = ctx.P.raycast(x, y + 0.3, z, 0, -1, 0, 1, RAY);
        const hard = r ? ctx.P.surfaces.get(r.collider.handle) : undefined;
        const ground = ctx.surfaceAt(x, z).name;
        const v = (0.12 + loud * 0.2) * 0.7;
        // Only the dry foot-step recordings are used: the metal and wood impact takes ring like a chime when pitched up.
        switch (hard ?? ground) {
          case 'car': case 'steel': case 'sheet': ctx.audio.play('footStone', x, z, v * 0.8, { pitch: 1.5 }); break;
          case 'wood': ctx.audio.play('footWood', x, z, v * 0.7, { pitch: 1.5 }); break;
          case 'glass': ctx.audio.play('footStone', x, z, v * 0.6, { pitch: 1.7 }); break;
          case 'sand': case 'dirt': case 'mud': ctx.audio.play('footSand', x, z, v * 0.7, { pitch: 1.4 }); break;
          default: ctx.audio.play('footStone', x, z, v * 0.7, { pitch: 1.6 });
        }
      },
      clunk: (x, _y, z, loud) => {
        if (loud > 0.08) {
          ctx.audio.play('thud', x, z, 0.1 + loud * 0.25);
        }
      },
    });
    this.gibs = new Gibs({
      floorAt,
      // Sand and mud swallow what falls on them; asphalt, concrete and rock let it bounce and skitter.
      give: (x, z) => ctx.ground?.soilAt(x, z)?.give ?? 0,
      thud: (x, z, r, mass, vy) => ctx.ground?.lay(x, z, 1, 0, r, r, mass, vy, 0.4),
      ring: () => {},
      trail: (x, y, z, vx, vy, vz) => {
        ctx.fx.bloodSpray(x, y, z, -vx * 0.03, 0.1, -vz * 0.03, 1, 1.2, 0.5);
        if (Math.random() < 0.3) this.groundSplat(x, z, 0.12 + Math.random() * 0.12, CELL.drops, 0.7, vx, vz);
      },
      splash: (x, y, z, speed) => {
        const s = Math.min(1, speed / 6);
        ctx.fx.bloodSpray(x, y + 0.05, z, 0, 1, 0, 3, 2 + s * 3, 0.9);
        this.groundSplat(x, z, 0.25 + s * 0.3, CELL.splat0 + Math.floor(Math.random() * 4), 0.85, undefined, undefined, y);
        if (speed > 3) ctx.audio.play('thud', x, z, 0.25);
      },
    });
    this.timber = new Timber(ctx, this);
    this.anatomy = new FleshFx(ctx, this);
  }

  /** Add the meshes to a scene root. */
  attach(root: THREE.Object3D) {
    root.add(this.decals.mesh);
    root.add(this.marks.mesh);
    for (const m of this.brass.meshes) root.add(m);
    root.add(this.gibs.group);
    root.add(this.timber.chips.group);
    this.anatomy.attach(root);
  }

  // ------------------------------------------------------------------ blood on surfaces

  private place(x: number, y: number, z: number, nx: number, ny: number, nz: number, w: number, h: number, cell: number, opacity: number, dx?: number, dy?: number, dz?: number, tint?: [number, number, number]) {
    const k = 0.75 + Math.random() * 0.4;
    // On level ground the mark lies on the road if there is one.
    if (ny > 0.7 && this.ctx.terrain) y += roadLift(this.ctx.terrain, x, z);
    this.decals.add(x, y, z, tint ? { cell, w, h, nx, ny, nz, dx, dy, dz, r: tint[0] * k, g: tint[1] * k, b: tint[2] * k, opacity } : { cell, w, h, nx, ny, nz, dx, dy, dz, r: 0.4 * k, g: 0.02, b: 0.022, opacity });
    this.placed++;
  }

  /** A splat on the ground at a spot, dropped on whatever floor is there. */
  groundSplat(x: number, z: number, size: number, cell: number, opacity = 0.85, dirX?: number, dirZ?: number, fromY?: number, tint?: [number, number, number]) {
    const ctx = this.ctx;
    const y0 = (fromY ?? ctx.groundAt(x, z)) + 1;
    const r = ctx.P.raycast(x, y0, z, 0, -1, 0, 4, RAY);
    const gy = r ? y0 - r.toi : ctx.groundAt(x, z);
    const n = r?.normal ?? { x: 0, y: 1, z: 0 };
    const stretch = dirX !== undefined && dirZ !== undefined && Math.hypot(dirX, dirZ) > 0.2 ? 1.5 : 1;
    this.place(x, gy, z, n.x, n.y, n.z, size * stretch, size, cell, opacity, dirX, 0, dirZ, tint);
  }

  /** What the body leaves on the ground: a dark yellow puddle, or a brown pile. */
  waste(x: number, z: number, kind: 'piss' | 'shit') {
    if (kind === 'piss') this.groundSplat(x, z, 0.5 + Math.random() * 0.25, CELL.pool, 0.6, undefined, undefined, undefined, [0.62, 0.52, 0.1]);
    else this.groundSplat(x, z, 0.26 + Math.random() * 0.08, CELL.splat0 + Math.floor(Math.random() * 4), 0.95, undefined, undefined, undefined, [0.3, 0.19, 0.08]);
  }

  /** A drop of blood on the ground where something hurt walked. */
  drip(x: number, z: number, size = 0.2) {
    this.groundSplat(x, z, size, CELL.drops, 0.8);
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

  /** Local soil displacement: a short directional plume, small falling fragments, and a shallow persistent strike. */
  groundStrike(weapon: GroundWeapon, material: GroundMaterial, x: number, y: number, z: number, nx: number, ny: number, nz: number, dx: number, dy: number, dz: number, speed: number) {
    const ctx = this.ctx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    const incidence = Math.abs(dx * nx + dy * ny + dz * nz);
    // Soft ground gives: the round or the blow digs its crater and throws real soil, crumbs, pebbles or chips (groundWork.ts),
    // so it needs no chips of its own. Bare rock is struck as stone: it rings and sparks, and it is chipped, not dug.
    const hit = ctx.ground?.strike(weapon, x, z, nx, ny, nz, dx, dy, dz, speed) ?? null;
    const dug = !!hit;
    // Bare rock too steep for the field to hold is still stone, and its own colour.
    const rock = !hit && material !== 'asphalt' && material !== 'concrete' && !!ctx.ground?.bareRock(x, z);
    if (rock) material = 'stone';
    const f = groundImpact(weapon, hit?.soil.brittle ? 'stone' : material, speed, incidence, ctx.groundDust?.(x, z) ?? 1);
    // Its dust is the colour of the ground it came out of.
    const [r, g, b] = hit ? hit.tint : rock ? ctx.ground!.groundTint(x, z, SOILS.rock) : f.tint;
    // Ground normals face out; shallow shots throw material ahead along the surface.
    const along = dx * nx + dy * ny + dz * nz;
    const tx = dx - along * nx, ty = dy - along * ny, tz = dz - along * nz;
    const lift = ctx.terrain && Math.abs(y - ctx.groundAt(x, z)) < 0.7 ? roadLift(ctx.terrain, x, z) : 0;
    y += lift;
    const px = x + nx * 0.025, py = y + ny * 0.025, pz = z + nz * 0.025;
    if (f.dust > 0.02) {
      // Sand is heavy: it goes up as grains and comes down, with only a little dust off it.
      const count = Math.min(5, Math.ceil(f.dust * (hit?.soil.kind === 'sand' ? 0.8 : 2)));
      for (let i = 0; i < count; i++) {
        const out = f.eject * (0.3 + Math.random() * 0.35);
        // Dust is the finest of what is thrown: it hangs and goes with the wind.
        ctx.fx.smoke.emit(px, py, pz, nx * out + tx * f.eject * 0.5, ny * out + ty * f.eject * 0.5, nz * out + tz * f.eject * 0.5,
          f.life, f.plume * 0.35, f.plume, r, g, b, 0.35, 0.5, 2, false, 0.9);
      }
    }
    // Hard ground (asphalt, concrete, stone) loses a cone of itself in chips as big as the blow and its angle make them, and
    // strikes a few sparks off its stone; soft ground with no field to dig keeps its little chips.
    const hard = !dug && f.hard && !f.shaft;
    const ke = weapon in AMMO ? 0.5 * AMMO[weapon as AmmoKind].mass * speed * speed : (MELEE_ENERGY[weapon as MeleeKind] ?? 30) * speed * speed;
    let spallW = 0;
    if (hard) {
      const face = material === 'asphalt' ? 'asphalt' : material === 'stone' ? 'stone' : 'concrete';
      const fresh: [number, number, number] = material === 'asphalt' ? [r * 0.55, g * 0.55, b * 0.55] : [Math.min(1, r * 1.1), Math.min(1, g * 1.1), Math.min(1, b * 1.1)];
      spallW = this.spall(face, fresh, px, py, pz, nx, ny, nz, dx, dy, dz, ke);
      const sc = sparkCount(material === 'stone' ? 'stone' : 'concrete', ke);
      if (sc) ctx.fx.sparkOff(px, py, pz, nx, ny, nz, dx, dy, dz, sc, 5 + Math.min(6, ke / 300));
    } else {
      for (let i = 0; i < (dug ? 0 : f.chips); i++) {
        const rx = Math.random() - 0.5, ry = Math.random() - 0.5, rz = Math.random() - 0.5;
        const dot = rx * nx + ry * ny + rz * nz;
        const out = f.eject * (0.5 + Math.random() * 0.5);
        this.gibs.throw('chunk', px, py, pz, nx * out + (tx + rx - dot * nx) * f.eject * 0.5,
          ny * out + (ty + ry - dot * ny) * f.eject * 0.5, nz * out + (tz + rz - dot * nz) * f.eject * 0.5,
          f.chipSize * (0.65 + Math.random() * 0.6), r, g, b);
      }
    }
    if (!dug) {
      // Hard ground loses a chip of itself: a spall of fresh material, asphalt darker where its skin of dust is knocked off,
      // concrete and stone paler. A shaft only scuffs it.
      const spall = f.hard && !f.shaft;
      // Stone takes a small round pit; asphalt and concrete a ragged spall, asphalt dark where its dusty skin is knocked off.
      const pit = material === 'stone';
      const k = material === 'asphalt' ? 0.5 : pit ? 1 : 1.15;
      // A chip a few centimetres across, not the round's whole disturbance.
      const sw = spall ? (spallW > 0 ? spallW * (pit ? 0.7 : 1) : Math.min(pit ? 0.05 : 0.12, Math.max(pit ? 0.015 : 0.035, f.size * (pit ? 0.25 : 0.55)))) * (0.85 + 0.3 * Math.random()) : f.size;
      this.marks.add(x, y, z, { cell: spall ? anyOf(pit ? PITS : SPALLS) : CELL.scuff, w: sw * (pit ? 1 : f.stretch), h: sw,
        nx, ny, nz, dx, dy, dz, r: spall ? Math.min(1, r * k) : r * 0.6, g: spall ? Math.min(1, g * k) : g * 0.6, b: spall ? Math.min(1, b * k) : b * 0.6, opacity: f.shaft ? 0.45 : 0.92, hole: true });
      this.placed++;
    } else if (hit.soil.brittle) {
      // Bare rock: the field holds the chip's volume, but its cone is finer than the field's grid. A pit shows it: small,
      // round, smooth-walled and shading darker to its bottom.
      const w = Math.max(0.02, 2.2 * Math.max(hit.along, hit.across)) * (0.85 + 0.3 * Math.random());
      this.marks.add(hit.x, y, hit.z, { cell: anyOf(PITS), w, h: w * Math.max(0.7, hit.across / Math.max(1e-3, hit.along)),
        nx, ny, nz, dx: hit.dx, dy: 0, dz: hit.dz, r: r * 0.9, g: g * 0.9, b: b * 0.9, opacity: 0.95, hole: true });
      this.placed++;
    }
    ctx.audio.play(f.sound, x, z, f.volume, { intensity: Math.min(1, f.power / 2), pitch: f.shaft ? 1.1 : 1.15 - Math.min(0.3, f.power * 0.1) });
  }

  /**
   * A blow knocks a cone out of a hard brittle face (stone, concrete, plaster, asphalt): its volume is the blow's energy
   * over what the material costs to break, less for a glancing one. Square on, it is crushed: many small chips splash back
   * off the face, and dust. Glancing, it flakes: a few bigger, flat pieces skate off along the way the blow was going. Each
   * chip is a real tumbling piece; the finest grit flies by its weight. Returns how wide the spall it leaves is, m.
   */
  spall(surface: Surface | 'asphalt', tint: readonly number[], x: number, y: number, z: number, nx: number, ny: number, nz: number, dx: number, dy: number, dz: number, ke: number): number {
    const q = SPALL_Q[surface as Surface] ?? SPALL_ASPHALT;
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl;
    dy /= dl;
    dz /= dl;
    const dn = dx * nx + dy * ny + dz * nz;
    const square = Math.min(1, Math.abs(dn));
    const glance = 1 - square;
    const vol = (Math.max(0, ke) * (0.3 + 0.7 * square)) / q;
    const r = Math.cbrt(vol);
    // Square on, crushed small; glancing, flaked big.
    const mean = r * (0.3 + 0.55 * glance * glance);
    const n = clamp(Math.round((0.45 * vol) / (mean * mean * mean)), 1, 12);
    // Where they go: back off the face, or on along the glance.
    const ox = dx - 1.7 * dn * nx;
    const oy = dy - 1.7 * dn * ny;
    const oz = dz - 1.7 * dn * nz;
    const spread = 0.3 + 1.0 * square;
    for (let k = 0; k < n; k++) {
      const sz = mean * (0.45 + 1.1 * Math.random());
      const t = spread * Math.sqrt(Math.random());
      const p = Math.random() * Math.PI * 2;
      // A random direction about the throw: tilt it off by t round a random axis.
      const jx = Math.cos(p) * Math.sin(t);
      const jz = Math.sin(p) * Math.sin(t);
      const ax = ox * Math.cos(t) + jx;
      const ay = oy * Math.cos(t) + (Math.random() - 0.3) * Math.sin(t);
      const az = oz * Math.cos(t) + jz;
      const al = Math.hypot(ax, ay, az) || 1;
      // Small ones leave faster.
      const sp = clamp(2.5 + 0.035 / Math.max(0.002, sz), 2.5, 13) * (0.6 + 0.6 * Math.random());
      const k2 = 0.85 + 0.3 * Math.random();
      const shape: [number, number, number] = [1 + 0.6 * Math.random(), 0.25 + 0.35 * Math.random() * (1 - 0.5 * glance), 0.6 + 0.5 * Math.random()];
      this.gibs.throw('chunk', x + nx * 0.02, y + ny * 0.02, z + nz * 0.02, (ax / al) * sp, (ay / al) * sp, (az / al) * sp, clamp(sz / 0.1, 0.02, 2.2), tint[0] * k2, tint[1] * k2, tint[2] * k2, false, shape);
    }
    // The crushed rest: grit and powder.
    this.ctx.ground?.grit(x + nx * 0.02, y + ny * 0.02, z + nz * 0.02, nx, ny, nz, ox * glance, oy * glance, oz * glance, clamp(Math.round(3 + ke / 200), 3, 14), 2.5 + 3 * square, [tint[0], tint[1], tint[2]], Math.max(0.0015, mean * 0.3));
    this.ctx.fx.puff(x + nx * 0.05, y + ny * 0.05, z + nz * 0.05, tint[0], tint[1], tint[2], 0.1 + Math.min(0.35, r * 7), 0.45);
    return clamp(r * (2.2 + 1.2 * glance), 0.015, 0.4);
  }

  /**
   * The mark a round leaves in a surface, by what it is made of: stone a small round pit, darker to its bottom; concrete and
   * plaster a ragged spall of fresh, paler material round a deep dark hole; metal a punched hole with bright torn petals of
   * bare steel; wood a dark hole, or splinters where a heavy round or an exit tore it. `size` is the round's own mark size.
   */
  private holeMark(surface: Surface, size: number, heavy: boolean, exit: boolean): { cell: number; w: number; c: readonly number[] } {
    const jitter = 0.85 + 0.3 * Math.random();
    switch (surface) {
      case 'stone':
        return { cell: anyOf(PITS), w: size * (exit ? 0.45 : 0.25) * jitter, c: SURFACES.stone.tint };
      case 'concrete':
      case 'plaster':
        return { cell: anyOf(SPALLS), w: size * (exit ? 1.1 : 0.7) * jitter, c: this.pale(surface, 1.08) };
      case 'sheet':
      case 'car':
      case 'steel':
        return { cell: anyOf(PUNCHES), w: size * (exit ? 0.42 : 0.32) * jitter, c: METAL };
      default:
        return { cell: heavy || exit ? CELL.splinter : CELL.hole, w: size, c: this.pale(surface) };
    }
  }

  /** The colour of the exposed material around a hole: the surface, paler, as if the paint were blown off it. */
  private pale(surface: Surface, k = 1.3): [number, number, number] {
    const t = SURFACES[surface].tint;
    return [Math.min(1, t[0] * k), Math.min(1, t[1] * k), Math.min(1, t[2] * k)];
  }

  /**
   * Chips of the surface thrown back out of a hit, or forward out of an exit. Stone, concrete and plaster break off in flat
   * angular flakes of fresh material, paler than the weathered face.
   */
  private chips(surface: Surface, x: number, y: number, z: number, dx: number, dy: number, dz: number, n: number, speed: number) {
    const masonry = surface === 'stone' || surface === 'concrete' || surface === 'plaster';
    const t = masonry ? this.pale(surface, 1.05) : SURFACES[surface].tint;
    const wood = surface === 'wood';
    for (let i = 0; i < n; i++) {
      const k = 0.8 + Math.random() * 0.4;
      // Masonry in flat angular flakes, wood in long splinters.
      const shape: [number, number, number] | undefined = masonry ? [1 + 0.5 * Math.random(), 0.3 + 0.3 * Math.random(), 0.6 + 0.4 * Math.random()] : wood ? [0.3, 0.25, 1.6 + Math.random()] : undefined;
      this.gibs.throw(
        'chunk',
        x,
        y,
        z,
        dx * speed * (0.5 + Math.random()) + (Math.random() - 0.5) * 2.4,
        dy * speed * (0.5 + Math.random()) + 0.8 + Math.random() * 1.8,
        dz * speed * (0.5 + Math.random()) + (Math.random() - 0.5) * 2.4,
        // Masonry breaks into chips a centimetre or two across.
        masonry ? 0.1 + Math.random() * 0.22 : 0.3 + Math.random() * 0.45,
        t[0] * k,
        t[1] * k,
        t[2] * k,
        false,
        shape,
      );
    }
  }

  /**
   * A round hit the world: dust, sparks and chips, and a mark that stays. A wall keeps a dark hole in a ring of pale
   * exposed material with splinters, as wide as the round made it; the ground and stone keep a scuffed pit. Nothing that
   * moves keeps a mark (it would stay behind in the air), and nor does a box that only roughly stands for something round.
   */
  impact(surface: Surface, x: number, y: number, z: number, nx: number, ny: number, nz: number, dx: number, dz: number, energy: number, o: { moving?: boolean; size?: number; heavy?: boolean; mark?: boolean; shaft?: boolean; dy?: number; ke?: number; tint?: readonly number[] } = {}) {
    const ctx = this.ctx;
    const s = SURFACES[surface];
    const e = Math.max(0.2, Math.min(1.5, energy));
    if (o.shaft) {
      // A shaft punctures soft material or taps a hard surface without firearm sparks or a blast of masonry.
      if (surface === 'wood' || surface === 'plaster') ctx.fx.puff(x, y, z, ...s.tint, 0.08, 0.2);
      return;
    }
    const dy = o.dy ?? 0;
    // The round's kinetic energy, J (callers that do not know it give a rough one from its share of a rifle round's).
    const ke = o.ke ?? 1300 * e;
    const metal = METALS.has(surface);
    // Sparks off metal (and a few off stone and the grit in concrete): how many by the blow, which way by its angle.
    const sparks = sparkCount(surface, ke);
    if (sparks) ctx.fx.sparkOff(x, y, z, nx, ny, nz, dx, dy, dz, sparks, 5 + Math.min(6, ke / 300));
    // Dust kicked back off the surface: paint and lead off metal is a little grey puff.
    const pk = metal ? 0.55 : 1;
    // As big as the blow: a pellet's is a wisp, a rifle round's a small cloud.
    const pz = clamp(Math.cbrt(ke / 1300), 0.3, 1.3);
    ctx.fx.puff(x + nx * 0.08, y + ny * 0.08, z + nz * 0.08, s.tint[0] * pk, s.tint[1] * pk, s.tint[2] * pk, metal ? 0.08 + e * 0.05 : 0.15 + 0.35 * pz, metal ? 0.25 : 0.4);
    if (surface === 'dirt') ctx.fx.dust(x, y, z, nx * 2, nz * 2, 0.35, s.tint);
    if (o.moving) return;
    const size = (o.size ?? 0.1) * (0.9 + 0.2 * Math.min(1, e));
    // Stone, concrete and plaster lose a cone of themselves, in chips as big as the blow and its angle make them; wood
    // splinters; metal is holed and loses nothing that flies but sparks.
    let spallW = 0;
    // A stone of its own colour (`o.tint`) breaks paler inside.
    const own = o.tint ? [Math.min(1, o.tint[0] * 1.15), Math.min(1, o.tint[1] * 1.15), Math.min(1, o.tint[2] * 1.15)] : null;
    if (SPALL_Q[surface]) spallW = this.spall(surface, own ?? this.pale(surface, 1.05), x, y, z, nx, ny, nz, dx, dy, dz, ke);
    else if (surface === 'wood') this.chips(surface, x + nx * 0.03, y + ny * 0.03, z + nz * 0.03, nx, ny, nz, 1 + Math.round(e * size * 14), 2.2);
    if (o.mark === false) return;
    if (ny > 0.7 && ctx.terrain) y += roadLift(ctx.terrain, x, z);
    if (s.hole) {
      const m = this.holeMark(surface, size, o.heavy ?? false, false);
      const w = spallW > 0 ? spallW * (surface === 'stone' ? 0.7 : 1) : m.w;
      const mc = o.tint ?? m.c;
      this.marks.add(x, y, z, { cell: m.cell, w, h: w, nx, ny, nz, r: mc[0], g: mc[1], b: mc[2], opacity: 0.97, hole: true });
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
    let y2 = y;
    if (dy > 0.7 && this.ctx.terrain) y2 += roadLift(this.ctx.terrain, x, z);
    const size = entrySize * 1.8 * (0.9 + 0.2 * Math.min(1, e));
    // Out the back masonry blows a wider cone and metal tears its petals outward; wood splinters.
    const m = this.holeMark(surface, size, true, true);
    let w = m.w;
    // What comes out the back flies on with the round: masonry blows a wide cone of chips, metal sprays sparks on ahead.
    if (SPALL_Q[surface]) w = Math.max(w, 1.3 * this.spall(surface, this.pale(surface, 1.05), x, y2, z, dx, dy, dz, -dx, -dy, -dz, 1300 * e * 0.6));
    else if (METALS.has(surface)) this.ctx.fx.sparks.shower(x + dx * 0.02, y2 + dy * 0.02, z + dz * 0.02, dx, dy, dz, sparkCount(surface, 1300 * e), 7, 0.5);
    else this.chips(surface, x + dx * 0.04, y2 + dy * 0.04, z + dz * 0.04, dx, dy, dz, 2 + Math.round(e * size * 12), 3.4);
    this.marks.add(x, y2, z, { cell: m.cell, w, h: w, nx: dx, ny: dy, nz: dz, r: m.c[0], g: m.c[1], b: m.c[2], opacity: 0.97, hole: true });
    this.placed++;
    const mk = METALS.has(surface) ? 0.55 : 1;
    this.ctx.fx.puff(x + dx * 0.15, y2, z + dz * 0.15, s.tint[0] * mk, s.tint[1] * mk, s.tint[2] * mk, METALS.has(surface) ? 0.12 : 0.6, 0.5);
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
  /** `soft`: the loose ground took the blast (a crater dug, its soil thrown, the ground charred), so no clods or scorch mark here. */
  groundBlast(x: number, y: number, z: number, radius: number, damage: number, soft = false) {
    const ctx = this.ctx;
    const gy = ctx.groundAt(x, z);
    // Airbursts disturb the ground less; explosions high overhead leave no ground mark.
    const coupling = Math.max(0, 1 - Math.abs(y - gy) / Math.max(1, radius));
    if (coupling <= 0 || ctx.waterAt(x, z)) return;
    const material = ctx.surfaceAt(x, z).name;
    const f = groundImpact('rifle', material, Math.sqrt(Math.max(0, damage) * 600), 1, ctx.groundDust?.(x, z) ?? 1);
    const n = Math.min(24, Math.ceil(radius * 2 * coupling));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const reach = Math.sqrt(Math.random()) * radius * 0.45;
      const px = x + Math.sin(a) * reach, pz = z + Math.cos(a) * reach;
      const py = (ctx.drawnGroundAt?.(px, pz) ?? ctx.groundAt(px, pz)) + 0.04;
      const out = (1 + Math.random() * 3) * coupling;
      if (f.dust > 0.02) ctx.fx.smoke.emit(px, py, pz, Math.sin(a) * out, 1 + out, Math.cos(a) * out,
        0.6 + coupling, 0.12, Math.min(2, radius * 0.25) * coupling, ...f.tint, 0.35, 1, 1);
      if (!soft) this.gibs.throw('chunk', px, py, pz, Math.sin(a) * out, 1 + out, Math.cos(a) * out,
        (0.12 + Math.random() * 0.22) * coupling, ...f.tint);
    }
    if (radius >= 3 && !soft) this.scorch(x, z, radius * 0.6 * coupling);
  }

  /** A charred ring where something burned. */
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
    // The dead come apart as themselves: the piece that was cut, at the height it was cut (`fleshFx.ts`).
    if (this.anatomy) {
      this.anatomy.sever(zb, zone, dx, dy, dz, power);
      return;
    }
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
      this.gibs.throw('chunk', x, y, z, vx * (0.5 + Math.random()) + (Math.random() - 0.5) * 3, vy * (0.4 + Math.random() * 0.8), vz * (0.5 + Math.random()) + (Math.random() - 0.5) * 3, 0.6 + Math.random() * 0.8, _c.r, _c.g, _c.b, true);
    }
    ctx.fx.bloodSpray(x, y, z, dx, 0.6, dz, 8 + Math.round(p * 5), 5 + p * 2, 0.8);
    ctx.fx.bloodSpray(x, y, z, 0, 1, 0, 4, 3, 0.7);
    ctx.audio.play('thud', x, z, 0.4);
    // Mark the ground and the nearest wall behind the blow.
    this.groundSplat(x, z, 0.9 + p * 0.3, CELL.splat0 + Math.floor(Math.random() * 4), 0.9, dx, dz, y);
    this.bleeders.push({ zb, lx, ly, lz, t: zone === 'head' ? 3.2 : 2.4, power: p, pulse: 0, dx, dz, head: zone === 'head' });
  }

  /** Where an animal's part joins it, in its own frame (x to its left, z ahead), already scaled to the animal. */
  private animalJoint(a: Animal, part: AnimalPart): [number, number, number] {
    const b = BODY[a.kind];
    const k = a.def.size;
    switch (part) {
      case 'head':
        return [0, b.headY * k, b.headZ * k];
      case 'wingL':
        return [0.12 * k, 0.06 * k, 0.05 * k];
      case 'wingR':
        return [-0.12 * k, 0.06 * k, 0.05 * k];
      default: {
        const lx = b.w * 0.62 * k;
        const lz = b.len * 0.5 * 0.66 * k;
        return [part === 'legLF' || part === 'legLB' ? lx : -lx, (b.leg + 0.02) * k * 0.75, part === 'legLF' || part === 'legRF' ? lz : -lz];
      }
    }
  }

  /**
   * Something came off an animal. The part is thrown (a leg or a head in the colour of its coat, a wing as feathers), the
   * stump sprays, and it goes on bleeding for as long as it is alive.
   */
  severAnimal(a: Animal, part: AnimalPart, dx: number, dy: number, dz: number, power: number) {
    const ctx = this.ctx;
    const [lx, ly, lz] = this.animalJoint(a, part);
    const rx = Math.cos(a.yaw);
    const rz = -Math.sin(a.yaw);
    const fx = Math.sin(a.yaw);
    const fz = Math.cos(a.yaw);
    const x = a.x + rx * lx + fx * lz;
    const z = a.z + rz * lx + fz * lz;
    const y = a.y + ly;
    const p = Math.max(0.4, Math.min(3, power));
    const size = a.def.size * Math.max(0.35, Math.min(1.5, (a.def.radius + 0.1) * 1.9));
    const throwSpeed = 2.4 + p * 2.2;
    const vx = dx * throwSpeed + (Math.random() - 0.5) * 1.4;
    const vz = dz * throwSpeed + (Math.random() - 0.5) * 1.4;
    const vy = 1.8 + Math.random() * 2 + dy * throwSpeed * 0.4;
    // The coat colour of each species, a shade darker for the leg.
    const c = COAT[a.kind];
    _c.setHex(c).multiplyScalar(a.tint);
    if (part === 'head') this.gibs.throw('animalHead', x, y + 0.05, z, vx, vy + 0.8, vz, size, _c.r, _c.g, _c.b);
    else if (part === 'wingL' || part === 'wingR') {
      for (let i = 0; i < 6; i++) this.gibs.throw('shard', x, y, z, vx * 0.5 + (Math.random() - 0.5) * 2.4, vy * 0.6 + Math.random(), vz * 0.5 + (Math.random() - 0.5) * 2.4, 1.4 + Math.random(), _c.r, _c.g, _c.b);
    } else this.gibs.throw('limb', x, y - 0.1 * a.def.size, z, vx, vy, vz, size * 0.8, _c.r * 0.85, _c.g * 0.85, _c.b * 0.85);
    const chunks = 2 + Math.round(p * 2);
    for (let i = 0; i < chunks; i++) {
      _c.setRGB(0.3 + Math.random() * 0.15, 0.02, 0.02);
      this.gibs.throw('chunk', x, y, z, vx * (0.5 + Math.random()) + (Math.random() - 0.5) * 3, vy * (0.4 + Math.random() * 0.8), vz * (0.5 + Math.random()) + (Math.random() - 0.5) * 3, 0.5 + Math.random() * 0.6, _c.r, _c.g, _c.b, true);
    }
    ctx.fx.bloodSpray(x, y, z, dx, 0.6, dz, 6 + Math.round(p * 4), 4 + p * 2, 0.8);
    ctx.audio.play('thud', x, z, 0.3);
    this.groundSplat(x, z, 0.5 + p * 0.25, CELL.splat0 + Math.floor(Math.random() * 4), 0.9, dx, dz, y);
    this.bleeders.push({ zb: a, lx, ly, lz, t: part === 'head' ? 3 : 4.5, power: p, pulse: 0, dx, dz, head: part === 'head', roll: Math.PI * 0.475 * (a.id % 2 ? 1 : -1), lift: a.flying ? 0 : 0.04 });
  }

  /** A stump left pumping blood for `t` seconds: `lx, ly, lz` in the body's own frame (x to its left, z ahead), scaled. */
  bleed(zb: Bleedable, lx: number, ly: number, lz: number, t: number, power: number, dx: number, dz: number, head: boolean) {
    this.bleeders.push({ zb, lx, ly, lz, t, power, pulse: 0, dx, dz, head });
  }

  // ------------------------------------------------------------------ brass

  /** Throw an empty case out of a gun held at (x, y, z) facing `yaw`, with the shooter's own motion carried over. */
  eject(kind: ShellKind, x: number, y: number, z: number, yaw: number, vx = 0, vz = 0) {
    // Out to the right of the gun (the ports are on its right), up and a little back.
    const rx = -Math.cos(yaw);
    const rz = Math.sin(yaw);
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
    this.timber.update(dt);
    this.anatomy.update(dt);
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
      b.pulse = Math.max(0.18, 0.22 + (1 - b.t / 3.2) * 0.35);
      const zb = b.zb;
      const rx = Math.cos(zb.yaw);
      const rz = -Math.sin(zb.yaw);
      const fx = Math.sin(zb.yaw);
      const fz = Math.cos(zb.yaw);
      // Match the renderer's death rotation so the spray remains attached to its stump.
      const fall = zb.dead ? Math.min(1, zb.fall) : 0;
      const tilt = fall * (b.roll ?? Math.PI * 0.475);
      const cs = Math.cos(tilt);
      const sn = Math.sin(tilt);
      const lx = b.roll === undefined ? b.lx : b.lx * cs - b.ly * sn;
      const ly = b.roll === undefined ? b.ly * cs + b.lz * sn : b.lx * sn + b.ly * cs;
      const lz = b.roll === undefined ? -b.ly * sn + b.lz * cs : b.lz;
      const sink = zb.dead && b.roll === undefined ? Math.max(0, zb.deadT - 2.2) * 0.8 : 0;
      const x = zb.x + rx * lx + fx * lz;
      const z = zb.z + rz * lx + fz * lz;
      const y = zb.y + ly - sink + (zb.dead ? b.roll === undefined ? 0.1 : fall * (b.lift ?? 0) : 0);
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
    this.timber.clear();
    this.anatomy.clear();
  }

  dispose() {
    this.bleeders.length = 0;
    this.decals.dispose();
    this.marks.dispose();
    this.brass.dispose();
    this.gibs.dispose();
    this.timber.dispose();
    this.anatomy.dispose();
  }
}
