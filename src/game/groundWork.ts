import * as THREE from 'three';
import { RAPIER } from '../physics/physics';
import { VehicleBody } from '../physics/vehicle';
import { GroundField, TILE, type GroundSnapshot, type Under } from '../sim/groundField';
import { CELLS, CHUNK } from '../world/terrain';
import { Ejecta } from '../sim/ejecta';
import {
  G,
  SOILS,
  blastCrater,
  crater,
  digVolume,
  landingSinkage,
  plateSinkage,
  platePressure,
  sinkDrag,
  wheelSinkage,
  type Soil,
  type SoilKind,
  type SoilPiece,
} from '../sim/soil';
import { AMMO, type AmmoKind } from '../sim/ballistics';
import { MELEE_ENERGY, type GroundWeapon } from '../sim/groundImpact';
import { windAt } from '../sim/weather';
import type { MeleeKind } from '../sim/weaponfx';
import { GroundDeform, type DeformHost } from '../render/groundDeform';
import { SandSpray } from '../render/sandSpray';
import { wheelSpec } from '../render/vehicleKit';
import { partDef } from '../data';
import { clamp } from '../core/math';
import type { Ctx } from './ctx';
import { HEFT } from './debris';
import type { Vehicle } from './vehicle';
import type { Zombie } from './zombies';

/**
 * The loose ground at work: tyres pressing ruts and pushing berms by their real load, spinning tyres digging and throwing
 * their soil behind them, sliding ones bulldozing it aside, rounds and blades digging craters by their energy and the angle
 * they came in at, blasts digging big ones, boots leaving prints by the weight on them. Everything dug comes down again
 * somewhere (`sim/ejecta.ts`). The rules are in `sim/soil.ts`, the field in `sim/groundField.ts`; this wires them to the
 * game and draws them (`render/groundDeform.ts`, `render/sandSpray.ts`).
 *
 * It feeds back as well: a wheel rides the field, not the collider under it, so it sits in its rut and drops into a
 * crater (`VehicleBody` lengthens or shortens its suspension by what the field says is under the tyre), the walls of a rut
 * or a hole lean on it, and a tyre following a rut already pressed has less ground to push through than one cutting fresh
 * sand (`dragFactor`).
 */

/** Tiles the field keeps (about 40 KB each). Beyond it the farthest from everyone are forgotten, down to those near them. */
const MAX_TILES = 1200;
/** Vertex visits the settling gets per tick. */
const RELAX_BUDGET = 9000;
/** Farther than this from every player, a vehicle's tyres are not worth pressing into the ground. */
const NEAR = 140;
/** Within this of a player, the dead and the animals leave prints (farther off nobody would see them). */
const FEET_NEAR = 45;

/**
 * How each kind of solid piece breaks out and flies: its usual volume (m^3: how many a crater makes), the most one throws,
 * its proportions, how much darker or paler than the ground it shows, its elevation (degrees) and speed against the throw.
 */
const PIECE: Record<SoilPiece, { vol: number; most: number; shape: () => [number, number, number]; shade: [number, number]; el: [number, number]; speed: number }> = {
  grain: { vol: 1, most: 0, shape: () => [1, 1, 1], shade: [1, 1], el: [45, 78], speed: 1 },
  crumb: { vol: 4e-6, most: 7, shape: () => [0.8 + 0.4 * Math.random(), 0.6 + 0.4 * Math.random(), 0.8 + 0.4 * Math.random()], shade: [0.72, 0.95], el: [25, 62], speed: 1 },
  clod: { vol: 1.5e-5, most: 6, shape: () => [0.9 + 0.3 * Math.random(), 0.75 + 0.3 * Math.random(), 0.9 + 0.3 * Math.random()], shade: [0.45, 0.6], el: [30, 65], speed: 0.8 },
  pebble: { vol: 5e-6, most: 8, shape: () => [0.8 + 0.3 * Math.random(), 0.65 + 0.25 * Math.random(), 0.8 + 0.3 * Math.random()], shade: [0.85, 1.1], el: [15, 52], speed: 1.2 },
  flake: { vol: 3e-6, most: 8, shape: () => [1 + 0.45 * Math.random(), 0.2 + 0.14 * Math.random(), 0.75 + 0.35 * Math.random()], shade: [0.9, 1.08], el: [20, 58], speed: 1.1 },
  chip: { vol: 1.2e-6, most: 8, shape: () => [1 + 0.5 * Math.random(), 0.3 + 0.25 * Math.random(), 0.6 + 0.4 * Math.random()], shade: [0.9, 1.1], el: [8, 45], speed: 1.3 },
};

/** Stones of a gravel pavement are not all one: most the ground's colour, some grey, dark, red or pale. */
const STONES: readonly (readonly number[] | null)[] = [null, null, null, [0.5, 0.48, 0.45], [0.27, 0.25, 0.23], [0.52, 0.32, 0.21], [0.7, 0.66, 0.6]];
function pebble(tint: readonly number[]): readonly number[] {
  return STONES[Math.floor(Math.random() * STONES.length)] ?? tint;
}
const _axis = new THREE.Vector3();
const _rot = new THREE.Quaternion();
const _pt = new THREE.Vector3();
/** Tempers that fly or swim and leave the ground to others. */
const AIRBORNE = new Set(['bird', 'wader', 'swimmer']);
/** Metres of a soil cache cell, and how long a cached answer holds, s. */
const SOIL_CELL = 1;
const SOIL_FRESH = 2;


interface WheelTrack {
  x: number;
  z: number;
  /** Id of its current unbroken run on soft ground. */
  pass: number;
  on: boolean;
  /** Load on the tyre last step, N. */
  W: number;
  /** Sinkage it is making in fresh ground, m. */
  fresh: number;
}

/** What a round or a blow dug (`GroundWork.strike`): its bowl's centre, size and the way it was going. */
export interface Strike {
  soil: Soil;
  x: number;
  z: number;
  along: number;
  across: number;
  depth: number;
  dx: number;
  dz: number;
  energy: number;
  /** The colour of the ground there as drawn (linear rgb): for its dust. */
  tint: [number, number, number];
}

export interface GroundHost extends DeformHost {
  /** The soil at a point, or null where the ground does not give (asphalt, concrete, water, a cliff face). */
  soilAt(x: number, z: number): Soil | null;
  /** The ground's palette (linear rgb of sand, earth, rock, gravel): with the mesh's tint, the colour a clod or chip takes. */
  palette?: { sand: readonly number[]; earth: readonly number[]; rock: readonly number[]; gravel: readonly number[] };
  /** How far the drawn road lies above the ground at a point (0 off the road). */
  roadLift?(x: number, z: number): number;
}

export class GroundWork {
  readonly field: GroundField;
  readonly ejecta = new Ejecta(4096);
  readonly deform: GroundDeform;
  readonly spray: SandSpray;
  readonly group = new THREE.Group();
  private wheels = new Map<number, WheelTrack[]>();
  private drags = new Map<number, number>();
  private passes = 1;
  private soilCache = new Map<number, Soil | null>();
  private soilT = 0;
  private trimT = 0;
  private under: Under = { h: 0, hi: 0, gx: 0, gz: 0 };
  private cams: { x: number; z: number }[] = [];
  /** Clods in the air, and when and where their soil comes down. */
  private landings: { t: number; x: number; z: number; vol: number; soil: Soil }[] = [];
  /** Where each walker (the dead, the animals) last put a foot down, and which side is next. */
  private walkers = new Map<number, { x: number; z: number; side: number }>();
  /** Each loose piece of debris's fall speed last tick (by id), to catch the tick it hits the ground. */
  private falling = new Map<number, number>();
  /** Which players were down last tick, to press the ground once as each goes down. */
  private downed: boolean[] = [];
  /** Volume pressed and dug (m^3), craters and prints made, since the scene began: for tests and tuning. */
  readonly stats = { pressed: 0, dug: 0, craters: 0, prints: 0, laid: 0 };

  constructor(
    private ctx: Ctx,
    private host: GroundHost,
  ) {
    this.field = new GroundField({ soilAt: (x, z) => this.soilAt(x, z) });
    this.deform = new GroundDeform(this.field, host);
    this.spray = new SandSpray(this.ejecta);
    this.group.name = 'ground';
    this.group.add(this.deform.group);
    this.group.add(this.spray.points);
    // Its program compiles with the world's, not on the first shot: a compile passes over hidden things, and the gate
    // holds back a draw whose program is not ready (`compileGate.ts`), so the first spray would fly unseen.
    if (host.compile) {
      this.spray.points.visible = true;
      void host.compile([this.spray.points]);
      this.spray.points.visible = false;
    }
  }

  /** The soil at a point (cached by the metre for a couple of seconds: the weather can turn clay to mud). */
  soilAt(x: number, z: number): Soil | null {
    const cx = Math.floor(x / SOIL_CELL);
    const cz = Math.floor(z / SOIL_CELL);
    const k = (cx + 0x8000) * 0x10000 + (cz + 0x8000);
    const hit = this.soilCache.get(k);
    if (hit !== undefined) return hit;
    const s = this.host.soilAt(x, z);
    this.soilCache.set(k, s);
    return s;
  }

  /** How much the ground drags at a vehicle against its surface's tuned drag (`sim/soil.ts` `sinkDrag`). */
  dragFactor(v: Vehicle): number {
    return this.drags.get(v.id) ?? 1;
  }

  /** The field's height at a point, m (negative in a rut or a crater). */
  heightAt(x: number, z: number): number {
    return this.field.heightAt(x, z);
  }

  private slope: [number, number] = [0, 0];

  /** The field's rise per metre along x and z at a point, over a stride's span (so a print or a dish is no slope). */
  slopeAt(x: number, z: number): [number, number] {
    const f = this.field;
    const d = 0.3;
    this.slope[0] = (f.heightAt(x + d, z) - f.heightAt(x - d, z)) / (2 * d);
    this.slope[1] = (f.heightAt(x, z + d) - f.heightAt(x, z - d)) / (2 * d);
    return this.slope;
  }

  // ------------------------------------------------------------------ wheels

  /**
   * What a wheel of this vehicle rests on at (x, z), heading (fx, fz): the field under its tread, or the floor of the rut it
   * pressed last step if that is lower (at speed the tread runs onto ground it has not pressed yet), and the slope of the
   * field there. Called by `VehicleBody.update` before the wheels are cast.
   */
  wheelGround(v: Vehicle): NonNullable<import('../physics/vehicle').DriveEnv['ground']> {
    return (i, x, z, fx, fz, out) => {
      out.h = out.gx = out.gz = 0;
      const soil = this.soilAt(x, z);
      if (!soil) return;
      const b = v.body as VehicleBody;
      const tr = this.wheels.get(v.id)?.[i];
      const halfW = this.tyreHalf(v);
      const u = this.field.under(x, z, fx, fz, halfW, Math.min(0.15, 0.4 * b.radii[i]), this.under);
      let h = 0.5 * (u.h + u.hi);
      if (tr?.on && Math.hypot(tr.x - x, tr.z - z) < 0.8) h = Math.min(h, this.field.heightAt(tr.x, tr.z));
      out.h = h;
      out.gx = u.gx;
      out.gz = u.gz;
    };
  }

  private tyreHalf(v: Vehicle): number {
    const mk = v.build?.fit.wheels ? partDef(v.build.fit.wheels.id).mk : 0;
    return wheelSpec(v.def, mk).width / 2;
  }

  /**
   * One vehicle's tyres on the ground for one step (after its wheels have been cast): each tyre on soft ground presses its
   * rut by its load, spins soil out behind it if it is spinning, bulldozes a heap if it is sliding. Runs inside
   * `Vehicle.update`, so its tyre marks are laid on the rut it has just pressed.
   */
  vehicleStep(v: Vehicle, dt: number) {
    if (!(v.body instanceof VehicleBody)) return;
    const b = v.body;
    const ctx = this.ctx;
    const p0 = b.position;
    let near = ctx.players.length === 0;
    for (const pl of ctx.players) {
      const at = pl.vehicle ? pl.vehicle.position : pl.pos;
      if (Math.abs(at.x - p0.x) < NEAR && Math.abs(at.z - p0.z) < NEAR) near = true;
    }
    const n = b.wheelCount;
    let tr = this.wheels.get(v.id);
    if (!tr) {
      tr = [];
      for (let i = 0; i < n; i++) tr.push({ x: 0, z: 0, pass: 0, on: false, W: (b.mass * G) / n, fresh: 0 });
      this.wheels.set(v.id, tr);
    }
    if (!near) {
      for (const w of tr) w.on = false;
      return;
    }
    const halfW = this.tyreHalf(v);
    const f = b.forward();
    const yaw = Math.atan2(f[0], f[2]);
    const lv = b.body.linvel();
    const av = b.body.angvel();
    const t = b.body.translation();
    const it = v.lastIntent;
    const spin = b.unit.spin;
    const asked = b.driveAsked;
    let freshMax = 0;
    let soft: Soil | null = null;
    for (let i = 0; i < n; i++) {
      const w = tr[i];
      w.W = Math.max(0, b.ctl.wheelSuspensionForce(i) ?? 0);
      const g = b.ctl.wheelIsInContact(i) ? b.ctl.wheelGroundObject(i) : null;
      // Only the ground itself gives: a road, a ramp, a crate under the tyre does not.
      if (!g || g.shapeType() !== RAPIER.ShapeType.HeightField) {
        w.on = false;
        continue;
      }
      const cp = b.ctl.wheelContactPoint(i);
      if (!cp) continue;
      const soil = this.soilAt(cp.x, cp.z);
      // Bare rock takes nothing from a tyre: it rides its chips and pits, it does not press or dig it.
      if (!soil || soil.brittle || w.W < 30) {
        w.on = false;
        continue;
      }
      soft = soil;
      const wy = yaw + (b.steered[i] ? b.steerAngle : 0);
      const fx = Math.sin(wy);
      const fz = Math.cos(wy);
      const lx = fz;
      const lz = -fx;
      // The tread's velocity over the ground at the contact.
      const rx = cp.x - t.x;
      const ry = cp.y - t.y;
      const rz = cp.z - t.z;
      const vx = lv.x + av.y * rz - av.z * ry;
      const vz = lv.z + av.x * ry - av.y * rx;
      const vLong = vx * fx + vz * fz;
      const vLat = vx * lx + vz * lz;
      const r = b.radii[i];
      const { z, p } = wheelSinkage(soil, w.W, 2 * halfW, r, vLong);
      const halfL = clamp(Math.sqrt(3 * r * Math.max(z, 0.004)), 0.06, 0.18);
      if (!w.on || Math.hypot(cp.x - w.x, cp.z - w.z) > 1.5) {
        w.x = cp.x;
        w.z = cp.z;
        w.pass = ++this.passes;
      }
      // Locked and skidding (the handbrake on a back wheel, a hard stop): it ploughs rather than rolls.
      const lock = (it.handbrake && b.rear[i] && Math.abs(vLong) > 1.5 ? 0.8 : 0) + (it.brake > 0.85 && vLong > 6 ? 0.4 : 0);
      const res = this.field.press({
        ax: w.x,
        az: w.z,
        bx: cp.x,
        bz: cp.z,
        fx,
        fz,
        halfW,
        halfL,
        p,
        soil,
        pass: w.pass,
        // A tyre sliding sideways throws its berm out on the side it is sliding to.
        left: 0.5 + 0.4 * clamp(vLat / 1.5, -1, 1),
        ahead: 0.05 + 0.25 * lock + 0.15 * clamp(z / 0.1, 0, 1),
        turn: 0.6,
      });
      this.stats.pressed += res.volume;
      w.fresh = res.fresh;
      freshMax = Math.max(freshMax, res.fresh);
      w.x = cp.x;
      w.z = cp.z;
      w.on = true;
      // Wheelspin: the tread digs and flings what it digs out behind it.
      if (b.driven[i] && spin > 0.03 && Math.abs(asked) > 1) {
        const slip = (spin / (1 - spin)) * Math.max(Math.abs(vLong), 3);
        const got = this.field.dig(cp.x, cp.z, fx, fz, halfW, halfL, digVolume(soil, 2 * halfW, slip, dt), soil);
        if (got > 0) {
          this.stats.dug += got;
          this.fling(cp.x, cp.y, cp.z, fx, fz, lx, lz, r, vLong, slip * Math.sign(asked), got, soil);
        }
      }
      // Sliding sideways: the side of the tyre bulldozes the soil it is sliding into.
      if (Math.abs(vLat) > 0.6 && z > 0.002) {
        const vol = 2 * halfL * z * (Math.abs(vLat) - 0.4) * dt * 0.6;
        const s = Math.sign(vLat);
        this.field.shove(cp.x, cp.z, fx, fz, halfW, halfL, s * lx, s * lz, vol, soil);
      }
      if (lock > 0 && z > 0.002) {
        const s = Math.sign(vLong);
        this.field.shove(cp.x, cp.z, fx, fz, halfW, halfL, s * fx, s * fz, 2 * halfW * z * Math.abs(vLong) * lock * dt * 0.35, soil);
      }
    }
    // The drag of soft ground scales with the fresh ground the leading tyres are cutting (eased: it is felt, not seen).
    const target = soft ? sinkDrag(soft, freshMax, Math.abs(b.speed)) : 1;
    const d0 = this.drags.get(v.id) ?? 1;
    this.drags.set(v.id, d0 + (target - d0) * Math.min(1, dt * 3));
  }

  /**
   * Soil flung off a spinning tread: it leaves the tyre a little way up its back, carried round by the tread (`slip` is
   * how much faster the tread runs than the ground, signed with the way the wheel turns) and slowed as it slides off.
   */
  private fling(x: number, y: number, z: number, fx: number, fz: number, lx: number, lz: number, r: number, vLong: number, slip: number, vol: number, soil: Soil) {
    const turn = vLong + slip;
    const dir = Math.sign(turn) || 1;
    const n = clamp(Math.round(vol / 1e-5), 2, 8);
    const onFull = (px: number, pz: number, v: number) => this.field.deposit(px, pz, v, 0.05, soil);
    for (let k = 0; k < n; k++) {
      const phi = (0.3 + Math.random() * 0.9) * dir;
      const c = Math.cos(phi);
      const s = Math.sin(Math.abs(phi));
      const off = 0.65 + Math.random() * 0.35;
      // Ground-frame velocity of the tread at that angle, scaled down as the soil slides off it.
      const vf = (vLong - turn * c) * off;
      const vu = Math.abs(turn) * s * off;
      const vs = (Math.random() - 0.5) * 0.5 * Math.abs(turn);
      const px = x - fx * r * Math.sin(phi) * 0.9;
      const pz = z - fz * r * Math.sin(phi) * 0.9;
      const py = y + r * (1 - c) * 0.9 + 0.02;
      this.ejecta.launch(px, py, pz, fx * vf + lx * vs, vu, fz * vf + lz * vs, vol / n, soil.kind, { onFull });
    }
    if (soil.dust > 0.1 && Math.random() < 0.35) this.ctx.fx.dust(x - fx * r * dir, y + 0.1, z - fz * r * dir, -fx * Math.abs(turn) * dir, -fz * Math.abs(turn) * dir, 0.35 * soil.dust, [soil.tint[0], soil.tint[1], soil.tint[2]]);
  }

  // ------------------------------------------------------------------ rounds and blows

  /**
   * Something struck soft ground at (x, z): a round of `weapon` at `speed` along (dx, dy, dz), or a blow of a melee weapon.
   * Digs its crater (bigger for more energy; in sand a round shallow dish, in packed earth a hole that a glancing round
   * stretches into a gouge) and throws its soil: sand as a spray of grains, earth, clay and gravel mostly as solid clods
   * that tumble out downrange and lie where they stop. Returns what it dug, or null where the ground does not give (the
   * caller marks it as hard ground).
   */
  strike(weapon: GroundWeapon, x: number, z: number, nx: number, ny: number, nz: number, dx: number, dy: number, dz: number, speed: number): Strike | null {
    if (weapon === 'arrow' || weapon === 'bolt') return null;
    const soil = this.soilAt(x, z);
    if (!soil) return null;
    const ammo = weapon in AMMO ? AMMO[weapon as AmmoKind] : null;
    const energy = ammo ? 0.5 * ammo.mass * speed * speed : (MELEE_ENERGY[weapon as MeleeKind] ?? 30) * Math.max(0, speed) ** 2;
    const dl = Math.hypot(dx, dy, dz) || 1;
    const sinT = Math.abs(dx * nx + dy * ny + dz * nz) / dl;
    const c = crater(soil, energy, sinT);
    const hl = Math.hypot(dx, dz);
    const hx = hl > 1e-6 ? dx / hl : 0;
    const hz = hl > 1e-6 ? dz / hl : 1;
    const thrown = this.field.crater(x, z, hx, hz, c, soil);
    this.stats.craters++;
    const cx = x + hx * c.shift;
    const cz = z + hz * c.shift;
    const y = this.surfaceY(cx, cz);
    const g = this.groundTint(cx, cz, soil);
    const tint: [number, number, number] = [g[0], g[1], g[2]];
    // A dry crust breaks round the hole: farther for a harder blow, long along a glancing one (drawn where it looks crusted).
    if (soil.crack > 0) this.field.crack(cx, cz, hx, hz, c.along * soil.crack, c.across * soil.crack, soil);
    // Solid ground throws its clods, crumbs, pebbles or chips; what is left (and all of sand) goes up as grains and dust.
    const lumps = thrown * soil.clods;
    const grains = thrown - lumps;
    // Sand as a crown of grains; earth as a plume (dense enough to read as one), rock as a spit of grit.
    const count = soil.piece === 'grain' ? clamp(Math.round(40 + energy / 8), 40, 260) : soil.brittle ? clamp(Math.round(6 + energy / 60), 6, 24) : clamp(Math.round(24 + energy / 18), 24, 120);
    this.spew(cx, y, cz, hx, hz, c.along, c.across, grains, count, c.throwSpeed, c.skew, soil.brittle ? 20 : 58, 84, soil, tint);
    if (lumps > 0) this.clods(cx, y, cz, hx, hz, c.along, c.across, lumps, c.throwSpeed, c.skew, soil, tint, 1 - sinT, energy);
    // Rock breaks into dust and grit too fine to see once it is down, as well as its chips.
    if (soil.brittle) {
      const f = this.fresh(tint);
      this.grit(cx, y + 0.01, cz, nx, ny, nz, hx * (1 - sinT), 0, hz * (1 - sinT), clamp(Math.round(4 + energy / 400), 4, 14), 3 + c.throwSpeed, f, 0.0025);
    }
    return { soil, x: cx, z: cz, along: c.along, across: c.across, depth: c.depth, dx: hx, dz: hz, energy, tint };
  }

  private tintOut: [number, number, number] = [0, 0, 0];
  private mixBuf = new Float32Array(9);

  /**
   * The colour of the ground as drawn at a point (linear rgb): its materials' palette in the shares the mesh draws them in,
   * times the mesh's own tint there; the soil's own colour where no ground mesh is loaded. Clods, chips and dust take it,
   * so what flies out of red ground is red.
   */
  groundTint(x: number, z: number, soil: Soil): [number, number, number] {
    const out = this.tintOut;
    const P = this.host.palette;
    const tx = Math.floor(x / TILE);
    const tz = Math.floor(z / TILE);
    const view = P ? this.host.view(tx, tz) : null;
    const cx = Math.floor(tx / CELLS);
    const cz = Math.floor(tz / CELLS);
    if (P && view?.groundAt(x - cx * CHUNK, z - cz * CHUNK, this.mixBuf)) {
      const m = this.mixBuf;
      for (let q = 0; q < 3; q++) out[q] = (m[0] * P.sand[q] + m[1] * P.earth[q] + m[2] * P.rock[q] + m[3] * P.gravel[q]) * m[4 + q];
      return out;
    }
    out[0] = soil.tint[0];
    out[1] = soil.tint[1];
    out[2] = soil.tint[2];
    return out;
  }

  /**
   * Whether the ground at a point is drawn as bare rock (no grass or woodland floor over it): a round that strikes it there
   * meets stone, even on a face too steep for the field to hold.
   */
  bareRock(x: number, z: number): boolean {
    const tx = Math.floor(x / TILE);
    const tz = Math.floor(z / TILE);
    const view = this.host.view(tx, tz);
    const cx = Math.floor(tx / CELLS);
    const cz = Math.floor(tz / CELLS);
    const m = this.mixBuf;
    return !!view?.groundAt(x - cx * CHUNK, z - cz * CHUNK, m) && m[2] > 0.5 && m[7] < 0.25 && m[8] < 0.25;
  }

  /** Stone broken fresh out of a weathered face: paler and greyer than it. */
  private fresh(t: readonly number[]): [number, number, number] {
    const l = (t[0] + t[1] + t[2]) / 3;
    return [Math.min(1, (t[0] * 0.65 + l * 0.35) * 1.3), Math.min(1, (t[1] * 0.65 + l * 0.35) * 1.3), Math.min(1, (t[2] * 0.65 + l * 0.35) * 1.3)];
  }

  /**
   * The solid part of a crater, each piece a real tumbling lump (`Gibs`) shaped, coloured and thrown as its ground breaks:
   * crumbs of packed earth (small, many, a shade damp inside), flat flakes of a dry crust, pebbles out of a gravel pavement
   * (each its own stone), angular chips of rock (fresh and pale, flat and fast), wet clods of mud (dark, heavy, slow). Few
   * big ones, more small: a share falling off by size. The soil of all but rock comes back to the field where each lands.
   */
  private clods(x: number, y: number, z: number, hx: number, hz: number, A: number, B: number, vol: number, speed: number, skew: number, soil: Soil, tint: readonly number[], glance = 0.5, energy = 1000) {
    const gibs = this.ctx.gore?.gibs;
    const P = PIECE[soil.piece];
    // Chips of rock and flakes of crust are as big as the blow and its angle make them: crushed small square on, flaked off
    // big by a glancing one.
    const unit = soil.piece === 'chip' || soil.piece === 'flake' ? P.vol * (0.4 + 3 * glance * glance) * clamp(Math.cbrt(energy / 1300), 0.4, 1.4) : P.vol;
    // As many as the volume makes of pieces this size, and a small blow throws one at most some of the time.
    let n = Math.min(P.most, Math.floor(vol / unit));
    if (n === 0 && Math.random() < vol / unit) n = 1;
    if (n === 0) return;
    let total = 0;
    for (let k = 0; k < n; k++) total += 1 / (k + 1);
    const bx = -hz;
    const bz = hx;
    const spread = Math.PI * (0.85 - 0.6 * skew);
    const deg = Math.PI / 180;
    const fresh = soil.brittle ? this.fresh(tint) : null;
    for (let k = 0; k < n; k++) {
      const v = (vol * (1 / (k + 1))) / total;
      const rr = Math.sqrt(Math.random()) * 0.6;
      const ang = Math.random() * Math.PI * 2;
      const px = x + (hx * Math.cos(ang) * A + bx * Math.sin(ang) * B) * rr;
      const pz = z + (hz * Math.cos(ang) * A + bz * Math.sin(ang) * B) * rr;
      const az = Math.atan2(hz, hx) + (Math.random() * 2 - 1) * spread;
      const el = (P.el[0] + Math.random() * (P.el[1] - P.el[0])) * deg;
      // Bigger pieces leave slower.
      const sp = speed * P.speed * (0.6 + 0.9 * Math.random()) * (k === 0 ? 0.75 : 1);
      const vx = Math.cos(az) * Math.cos(el) * sp + hx * speed * 1.1 * skew;
      const vz = Math.sin(az) * Math.cos(el) * sp + hz * speed * 1.1 * skew;
      const vy = Math.sin(el) * sp;
      const py = y + 0.02;
      const c = fresh ?? (soil.piece === 'pebble' ? pebble(tint) : tint);
      const shade = P.shade[0] + Math.random() * (P.shade[1] - P.shade[0]);
      const sh = P.shape();
      // The rubble mesh is about 10 cm across at size 1.
      const size = clamp((Math.cbrt(v / (sh[0] * sh[1] * sh[2])) * 1.6) / 0.1, 0.08, 2.2);
      gibs?.throw('chunk', px, py, pz, vx, vy, vz, size, c[0] * shade, c[1] * shade, c[2] * shade, false, sh);
      if (soil.brittle) continue;
      // Where it first comes down (flat ground is near enough): its soil lands there then.
      const tl = (vy + Math.sqrt(vy * vy + 2 * G * 0.02)) / G;
      this.landings.push({ t: this.ctx.time + tl, x: px + vx * tl, z: pz + vz * tl, vol: v, soil });
    }
  }

  /**
   * An explosion at (x, y, z): if it went off on soft ground or close over it, it digs a crater by the energy that reaches
   * the ground, throws its soil all round and chars the ground black. Returns whether the ground took it (then the caller
   * leaves out its own scorch mark and clods).
   */
  blast(x: number, y: number, z: number, radius: number, damage: number): boolean {
    const soil = this.soilAt(x, z);
    if (!soil) return false;
    const ground = this.surfaceY(x, z);
    const over = y - ground;
    const reach = radius * 0.6;
    if (over > reach) return false;
    const k = 1 - Math.max(0, over) / reach;
    const energy = damage * radius * 1000 * k;
    const c = blastCrater(soil, energy);
    const thrown = this.field.crater(x, z, 1, 0, c, soil);
    this.stats.craters++;
    this.field.char(x, z, Math.max(c.across * 1.6, radius * 0.55 * k), 0.95 * k, soil);
    // A dry crust cracks out round the bowl.
    if (soil.crack > 0) {
      const w = c.across * (1.4 + 0.25 * soil.crack);
      this.field.crack(x, z, 1, 0, w, w, soil);
    }
    const g = this.groundTint(x, z, soil);
    const tint: [number, number, number] = [g[0], g[1], g[2]];
    const lumps = thrown * soil.clods * 0.5;
    const count = clamp(Math.round(thrown / 4e-4), 40, 220);
    this.spew(x, ground, z, 1, 0, c.across, c.across, thrown - lumps, count, c.throwSpeed, 0, 30, 80, soil, tint);
    if (lumps > 0) this.clods(x, ground, z, 1, 0, c.across, c.across, lumps, c.throwSpeed * 0.8, 0, soil, tint);
    return true;
  }

  /**
   * Where a ray that met the ground's collider at (x, y, z) going along (dx, dy, dz) really meets the loose ground: further
   * on, down in a rut or a crater, or a little short of it on a heap. Returns the point (into `out`), or false if the field
   * is flat there.
   */
  refine(x: number, y: number, z: number, dx: number, dy: number, dz: number, out: [number, number, number]): boolean {
    const f = this.field;
    const l = Math.hypot(dx, dy, dz) || 1;
    const ux = dx / l;
    const uy = dy / l;
    const uz = dz / l;
    if (uy > -0.02) return false;
    // Nothing to refine on untouched ground.
    let any = false;
    for (let k = -1; k <= 1 && !any; k++) if (Math.abs(f.heightAt(x + ux * k * 0.3, z + uz * k * 0.3)) > 1e-4) any = true;
    if (!any) return false;
    const c = this.ctx;
    const surf = (px: number, pz: number) => (c.drawnGroundAt ? c.drawnGroundAt(px, pz) : c.groundAt(px, pz) + f.heightAt(px, pz));
    // Back up along the ray to above the surface, then march on until below it.
    let t = -0.5;
    const step = 0.015;
    let above = y + uy * t > surf(x + ux * t, z + uz * t);
    if (!above) return false;
    for (; t < 1.5; t += step) {
      const px = x + ux * t;
      const py = y + uy * t;
      const pz = z + uz * t;
      if (py <= surf(px, pz)) {
        out[0] = px;
        out[1] = py;
        out[2] = pz;
        return true;
      }
    }
    return false;
  }

  /**
   * Throw `vol` of soil out of a crater in `count` clumps, leaning downrange by `skew`. Loose sand leaves from the crater's
   * rim as a thin crown, a cone of a sheet all at much the same angle and speed, most of it along a handful of rays (where
   * it lands it streaks out from the hole). Packed earth goes up as a dense plume of its darker subsoil, narrower the more
   * the round glanced, from all over the hole.
   */
  private spew(x: number, y: number, z: number, hx: number, hz: number, A: number, B: number, vol: number, count: number, speed: number, skew: number, elo: number, ehi: number, soil: Soil, tint?: readonly number[]) {
    if (vol <= 0) return;
    const bx = -hz;
    const bz = hx;
    const crown = soil.piece === 'grain';
    const spread = Math.PI * (crown ? 1 - 0.72 * skew : 0.75 * (1 - 0.85 * skew) ** 2 + 0.08);
    const onFull = (px: number, pz: number, v: number) => this.field.deposit(px, pz, v, 0.06, soil);
    const deg = Math.PI / 180;
    const head = Math.atan2(hz, hx);
    // Rays: the few ways most of it goes.
    const rays = 7 + Math.floor(Math.random() * 5);
    const ray0 = Math.random() * Math.PI * 2;
    // Earth thrown up from under its dry skin is darker than the face of the ground.
    const dk = crown || soil.brittle ? 1 : 0.72;
    for (let k = 0; k < count; k++) {
      let az = head + (Math.random() * 2 - 1) * spread;
      if (Math.random() < 0.65) az = ray0 + (Math.round(((az - ray0) / (Math.PI * 2)) * rays) / rays) * Math.PI * 2 + (Math.random() - 0.5) * 0.12;
      let px: number;
      let pz: number;
      let el: number;
      let sp: number;
      if (crown) {
        // From the rim, outward.
        const rr = 0.75 + 0.25 * Math.random();
        const ca = Math.cos(az - head);
        const sa = Math.sin(az - head);
        px = x + (hx * ca * A + bx * sa * B) * rr;
        pz = z + (hz * ca * A + bz * sa * B) * rr;
        el = (52 + Math.random() * 14) * deg;
        sp = speed * (0.8 + 0.45 * Math.random());
      } else {
        const rr = Math.sqrt(Math.random()) * 0.7;
        const ang = Math.random() * Math.PI * 2;
        px = x + (hx * Math.cos(ang) * A + bx * Math.sin(ang) * B) * rr;
        pz = z + (hz * Math.cos(ang) * A + bz * Math.sin(ang) * B) * rr;
        el = (elo + Math.random() * (ehi - elo)) * deg;
        const u = Math.random();
        // Earth leaves as one dense fountain, most of it at much the same speed; a blast's curtain flies wider.
        sp = soil.brittle || ehi < 82 ? speed * (0.45 + 1.7 * u * u * u) : speed * (0.5 + 0.75 * u * u);
      }
      const h = Math.cos(el) * sp;
      const vx = Math.cos(az) * h + hx * speed * 1.2 * skew;
      const vz = Math.sin(az) * h + hz * speed * 1.2 * skew;
      const kk = (0.88 + 0.24 * Math.random()) * dk;
      this.ejecta.launch(px, y + 0.015, pz, vx, Math.sin(el) * sp, vz, vol / count, soil.kind, tint ? { onFull, tint: [tint[0] * kk, tint[1] * kk, tint[2] * kk] } : { onFull });
    }
  }

  // ------------------------------------------------------------------ feet

  /** A step taken at (x, z) facing `yaw` by a body of `mass` kg, `k` times its weight coming down on the foot. */
  step(x: number, z: number, yaw: number, mass: number, k: number) {
    const soil = this.soilAt(x, z);
    if (!soil) return;
    const area = 0.1 * 0.26 * 0.85;
    const p = (mass * G * k) / area;
    if (p <= soil.crust) return;
    this.field.press({ ax: x, az: z, bx: x, bz: z, fx: Math.sin(yaw), fz: Math.cos(yaw), halfW: 0.05, halfL: 0.13, p, soil, pass: ++this.passes, ahead: 0.2, behind: 0.2, turn: 0.85 });
    this.stats.prints++;
  }

  /** A body landing on its feet from a fall at `vy` (m/s, down): both feet pressed by what the landing puts on them. */
  landing(x: number, z: number, yaw: number, mass: number, vy: number) {
    const soil = this.soilAt(x, z);
    if (!soil) return;
    const zz = landingSinkage(soil, mass / 2, vy, 0.1, 0.26);
    const p = platePressure(soil, zz, 0.1);
    const sx = Math.cos(yaw) * 0.13;
    const sz = -Math.sin(yaw) * 0.13;
    for (const s of [-1, 1]) {
      const fx = x + sx * s;
      const fz = z + sz * s;
      this.field.press({ ax: fx, az: fz, bx: fx, bz: fz, fx: Math.sin(yaw), fz: Math.cos(yaw), halfW: 0.05, halfL: 0.13, p, soil, pass: ++this.passes, ahead: 0.25, behind: 0.25, turn: 0.6 });
    }
  }

  /**
   * Something coming down to lie on soft ground: a footprint `halfW` across and `halfL` along (fx, fz) round (x, z), `mass`
   * kg landing at `vy` m/s (0: only its weight). It sinks by Bekker's plate law for its size, or by what the landing's
   * energy drives it to, whichever is deeper (`landingSinkage`); the soil it pushes out goes to the sides. A body, a carcass,
   * a dropped door, a limb or a clod.
   */
  lay(x: number, z: number, fx: number, fz: number, halfW: number, halfL: number, mass: number, vy: number, turn = 0.5) {
    const soil = this.soilAt(x, z);
    if (!soil || mass <= 0) return;
    const b = 2 * Math.min(halfW, halfL);
    const zz = landingSinkage(soil, mass, vy, b, 2 * Math.max(halfW, halfL));
    // Under a millimetre and a half it is no mark anyone would see: no tile for it (gibs bounce about a lot).
    if (zz < 0.0015) return;
    const p = platePressure(soil, zz, b);
    if (p <= soil.crust) return;
    this.field.press({ ax: x, az: z, bx: x, bz: z, fx, fz, halfW, halfL, p, soil, pass: ++this.passes, ahead: 0.15, behind: 0.15, turn });
    this.stats.laid++;
  }

  /** A person fallen on their back where they stood (`yaw` their facing): legs out from the feet, back and head behind. */
  private person(x: number, z: number, yaw: number, mass: number, k: number) {
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    // The legs carry a third of the weight; the back and the head the rest, and they come down harder.
    this.lay(x - fx * 0.42 * k, z - fz * 0.42 * k, fx, fz, 0.17 * k, 0.42 * k, mass * 0.35, 2.5, 0.9);
    this.lay(x - fx * 1.2 * k, z - fz * 1.2 * k, fx, fz, 0.22 * k, 0.4 * k, mass * 0.65, 3.5, 0.9);
  }

  /**
   * One of the dead come down: pressed where its body lies as drawn (head, middle and feet from its death take, which may
   * fall it on its face or its back, `FleshRenderer.worldPoint`), or on its back behind its feet without the drawing.
   */
  private corpse(zb: Zombie) {
    const k = zb.def.scale ?? 1;
    const mass = 72 * k * k * k;
    const r = this.ctx.gore?.anatomy?.renderer;
    if (!r) {
      this.person(zb.x, zb.z, zb.yaw, mass, k);
      return;
    }
    const pose = this.ctx.zombies.poseOf(zb);
    const h = r.worldPoint(pose, 9, 0, 1.7, 0.02, _pt);
    const hx = h.x;
    const hz = h.z;
    const m = r.worldPoint(pose, 0, 0, 1.0, 0, _pt);
    const mx = m.x;
    const mz = m.z;
    const a = r.worldPoint(pose, 3, 0.11, 0.12, 0, _pt);
    const ax = a.x;
    const az = a.z;
    const b = r.worldPoint(pose, 4, -0.11, 0.12, 0, _pt);
    // Each leg from the hip to its foot, the back from the hips to the shoulders, the head on its own: a body's shape in the
    // sand rather than a box.
    const sx = mx + (hx - mx) * 0.72;
    const sz = mz + (hz - mz) * 0.72;
    this.limb(mx, mz, ax, az, 0.075 * k, mass * 0.17, 2.5);
    this.limb(mx, mz, b.x, b.z, 0.075 * k, mass * 0.17, 2.5);
    this.limb(mx, mz, sx, sz, 0.18 * k, mass * 0.58, 3.5);
    this.lay(hx, hz, 1, 0, 0.1 * k, 0.1 * k, mass * 0.08, 4, 0.9);
  }

  /** A length of a body from (ax, az) to (bx, bz), `halfW` either side of it, coming down on the ground. */
  private limb(ax: number, az: number, bx: number, bz: number, halfW: number, mass: number, vy: number) {
    const dx = bx - ax;
    const dz = bz - az;
    const l = Math.hypot(dx, dz);
    if (l < 0.05) this.lay(ax, az, 1, 0, halfW, halfW, mass, vy, 0.9);
    else this.lay((ax + bx) / 2, (az + bz) / 2, dx / l, dz / l, halfW, Math.max(halfW, l / 2 + halfW * 0.4), mass, vy, 0.9);
  }

  /**
   * Bodies coming down near a player press themselves into soft ground the moment they hit it: a player going down, the
   * dead, raiders and travellers on their backs, an animal on its flank (its weight from its size, as for its hooves).
   */
  private bodies(dt: number) {
    const ctx = this.ctx;
    if (!ctx.players.length) return;
    const fell = (t: number, at: number) => t >= at && t - dt < at;
    for (let i = 0; i < ctx.players.length; i++) {
      const p = ctx.players[i];
      const down = p.state === 'downed';
      if (down && !this.downed[i]) this.person(p.pos.x, p.pos.z, p.yaw, p.carry ? 105 : 80, 1);
      this.downed[i] = down;
    }
    // At the end of its fall (`fall` runs out at 0.55 s), with the pose it lies in.
    for (const zb of ctx.zombies?.list ?? []) if (zb.dead && fell(zb.deadT, 0.6) && this.nearPlayer(zb.x, zb.z)) this.corpse(zb);
    for (const u of ctx.raiders?.units ?? []) if (u.dead && fell(u.deadT, 0.6) && this.nearPlayer(u.x, u.z)) this.person(u.x, u.z, u.yaw, 80, 1);
    for (const tv of ctx.travellers?.list ?? []) if (tv.dead && fell(tv.deadT, 0.6) && this.nearPlayer(tv.x, tv.z)) this.person(tv.x, tv.z, tv.yaw, 75, 1);
    for (const a of ctx.wildlife?.list ?? []) {
      if (!a.dead || AIRBORNE.has(a.def.temper) || !fell(a.deadT, 0.4) || !this.nearPlayer(a.x, a.z)) continue;
      const r = a.def.radius * (a.def.size ?? 1);
      this.lay(a.x, a.z, Math.sin(a.yaw), Math.cos(a.yaw), 0.6 * r, 1.7 * r, 1000 * r * r * r, 3, 0.9);
    }
  }

  /**
   * Loose debris (a door, a bonnet, a wheel torn off a car, a can off a roof) hitting soft ground dents it by its weight,
   * lying on its broadest face. Caught the tick its fall stops short.
   */
  private drops() {
    const list = this.ctx.debris?.pieces;
    if (!list?.length) {
      if (this.falling.size) this.falling.clear();
      return;
    }
    if (this.falling.size > list.length * 2 + 8) this.falling.clear();
    for (const p of list) {
      const vy = p.body.linvel().y;
      const was = this.falling.get(p.id) ?? 0;
      this.falling.set(p.id, vy);
      if (was > -1.2 || vy < was * 0.4) continue;
      const t = p.body.translation();
      // A box, or a wheel's cylinder (lying on its side when it has fallen over).
      const he = p.collider.halfExtents() ?? { x: p.collider.radius(), y: p.collider.halfHeight(), z: p.collider.radius() };
      // Lying on its broadest face: the two longer halves are its footprint, the shortest how high it stands.
      const h = [he.x, he.y, he.z];
      const lo = h.indexOf(Math.min(he.x, he.y, he.z));
      const long = h.indexOf(Math.max(he.x, he.y, he.z));
      if (t.y - h[lo] - this.surfaceY(t.x, t.z) > 0.25) continue;
      const mid = 3 - lo - long;
      const r = p.body.rotation();
      _axis.set(long === 0 ? 1 : 0, long === 1 ? 1 : 0, long === 2 ? 1 : 0).applyQuaternion(_rot.set(r.x, r.y, r.z, r.w));
      const l = Math.hypot(_axis.x, _axis.z);
      this.lay(t.x, t.z, l > 1e-3 ? _axis.x / l : 1, l > 1e-3 ? _axis.z / l : 0, h[mid], h[long], p.body.mass() / HEFT, -was, 0.4);
    }
  }

  /**
   * The dead and the animals near a player print the ground as they go: a foot (or, for an animal, a fore and a hind hoof
   * or paw) every half stride, pressed by the share of the body's weight on it. An animal's weight is reckoned from its
   * size (a deer some 60 kg, a camel 340, a buffalo 500): hooves are small, so a heavy one sinks deep into sand.
   */
  private feet() {
    const ctx = this.ctx;
    if (!ctx.players.length) return;
    const near = (x: number, z: number) => this.nearPlayer(x, z);
    for (const zb of ctx.zombies.list) {
      if (zb.dead || !near(zb.x, zb.z)) continue;
      const k = zb.def.scale ?? 1;
      this.walker(zb.id, zb.x, zb.z, zb.yaw, Math.hypot(zb.vx, zb.vz), 72 * k * k * k, 0.62 * k, 0.11 * k, 0.05 * k, 0.13 * k, false);
    }
    for (const a of ctx.wildlife.list) {
      if (a.dead || AIRBORNE.has(a.def.temper) || !near(a.x, a.z)) continue;
      const r = a.def.radius * (a.def.size ?? 1);
      this.walker(-1 - a.id, a.x, a.z, a.yaw, Math.hypot(a.vx, a.vz), 1000 * r * r * r, 0.5 + r, 0.12 + 0.25 * r, 0.025 + 0.06 * r, 0.03 + 0.07 * r, true);
    }
  }

  private nearPlayer(x: number, z: number): boolean {
    for (const p of this.ctx.players) {
      const at = p.vehicle ? p.vehicle.position : p.pos;
      if (Math.abs(at.x - x) < FEET_NEAR && Math.abs(at.z - z) < FEET_NEAR) return true;
    }
    return false;
  }

  private walker(key: number, x: number, z: number, yaw: number, speed: number, mass: number, stride: number, gauge: number, halfW: number, halfL: number, four: boolean) {
    const w = this.walkers.get(key);
    if (!w) {
      this.walkers.set(key, { x, z, side: 1 });
      return;
    }
    const d = Math.hypot(x - w.x, z - w.z);
    if (d < stride * 0.5) return;
    w.x = x;
    w.z = z;
    if (d > 3) return;
    w.side = -w.side;
    const soil = this.soilAt(x, z);
    if (!soil) return;
    // Faster is harder on the foot; on four legs two carry the weight at a time.
    const k = 1.2 + 0.7 * Math.min(1, speed / 5);
    const p = (mass * G * k) / (four ? 2 : 1) / (4 * halfW * halfL * 0.85);
    if (p <= soil.crust) return;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const ox = fz * gauge * w.side;
    const oz = -fx * gauge * w.side;
    const put = (px: number, pz: number) =>
      this.field.press({ ax: px, az: pz, bx: px, bz: pz, fx, fz, halfW, halfL, p, soil, pass: ++this.passes, ahead: 0.25, behind: 0.25, turn: 0.8 });
    put(x + ox + fx * 0.15 * stride, z + oz + fz * 0.15 * stride);
    // The hind foot on the other side, a body's length back.
    if (four) put(x - ox - fx * 1.6 * gauge * 2, z - oz - fz * 1.6 * gauge * 2);
    this.stats.prints++;
  }

  // ------------------------------------------------------------------ ticking

  /** The ground's surface as drawn at a point (the field included, and the road over it). */
  private surfaceY(x: number, z: number): number {
    const c = this.ctx;
    return (c.drawnGroundAt ? c.drawnGroundAt(x, z) : c.groundAt(x, z) + this.field.heightAt(x, z)) + (this.host.roadLift?.(x, z) ?? 0);
  }

  /** Once per fixed tick, after the physics step: soil in the air comes down, walls too steep slump, far tiles go. */
  tick(dt: number) {
    const f = this.field;
    f.time = this.ctx.time;
    // The air the pieces fly through: the day's breeze or storm, and the draught of any fire close by.
    const e = this.ejecta;
    if (e.n) {
      const w = this.windAt(e.px[0], e.pz[0]);
      e.step(
        dt,
        w[0],
        w[1],
        (x, z) => this.surfaceY(x, z),
        (x, z, vol, kind) => this.settle(x, z, vol, kind as SoilKind),
      );
    }
    if (this.landings.length) {
      const now = this.ctx.time;
      let keep = 0;
      for (const l of this.landings) {
        if (l.t > now) this.landings[keep++] = l;
        else {
          // On rock, asphalt or water it is gone (the clod lies there; its soil does not join the field).
          const soil = this.soilAt(l.x, l.z);
          if (soil && !soil.brittle) this.field.deposit(l.x, l.z, l.vol, clamp(Math.cbrt(l.vol) * 0.9, 0.03, 0.2), soil, 0.9);
        }
      }
      this.landings.length = keep;
    }
    this.feet();
    this.bodies(dt);
    this.drops();
    f.relax(RELAX_BUDGET);
    this.soilT += dt;
    if (this.soilT > SOIL_FRESH) {
      this.soilT = 0;
      this.soilCache.clear();
    }
    this.trimT += dt;
    if (this.trimT > 3) {
      this.trimT = 0;
      const focus = this.ctx.players.map((p) => (p.vehicle ? { x: p.vehicle.position.x, z: p.vehicle.position.z } : { x: p.pos.x, z: p.pos.z }));
      f.trim(focus, MAX_TILES, 70);
      for (const id of this.wheels.keys()) if (!this.ctx.vehicles.some((v) => v.id === id)) {
        this.wheels.delete(id);
        this.drags.delete(id);
      }
      if (this.walkers.size) {
        const live = new Set<number>();
        for (const zb of this.ctx.zombies.list) if (!zb.dead) live.add(zb.id);
        for (const a of this.ctx.wildlife.list) if (!a.dead) live.add(-1 - a.id);
        for (const key of this.walkers.keys()) if (!live.has(key)) this.walkers.delete(key);
      }
    }
  }

  private wind: [number, number] = [0, 0];

  /** The wind near the ground at a point, m/s. */
  windAt(x: number, z: number): [number, number] {
    const c = this.ctx;
    if (c.fires) return c.fires.windAt(x, z, this.wind);
    const w = windAt(c.storm ?? 0, c.time);
    this.wind[0] = w[0];
    this.wind[1] = w[1];
    return this.wind;
  }

  /**
   * Grit knocked off hard ground (asphalt, concrete, stone) or a wall by a round: little chips that fly by their weight, too
   * small to see once they are down (the bigger chips the caller throws lie where they stop). `n` pieces of about `size` metres, tinted as the surface, thrown out along (nx, ny, nz) and on
   * along (tx, ty, tz).
   */
  grit(x: number, y: number, z: number, nx: number, ny: number, nz: number, tx: number, ty: number, tz: number, n: number, speed: number, tint: readonly [number, number, number], size = 0.004) {
    for (let k = 0; k < n; k++) {
      const rx = Math.random() - 0.5;
      const ry = Math.random() - 0.5;
      const rz = Math.random() - 0.5;
      const out = speed * (0.5 + Math.random());
      const v = size * size * size * (0.4 + 1.2 * Math.random());
      const shade = 0.8 + 0.4 * Math.random();
      this.ejecta.launch(x, y, z, nx * out + (tx * 0.6 + rx) * speed, ny * out + (ty * 0.6 + ry) * speed + 0.5, nz * out + (tz * 0.6 + rz) * speed, v, 'grit', {
        tint: [tint[0] * shade, tint[1] * shade, tint[2] * shade],
        coarse: size / 0.003,
      });
    }
  }

  /** A clump coming down: the field takes it where the ground gives; on rock, asphalt or water it is gone. */
  private settle(x: number, z: number, vol: number, kind: SoilKind): boolean {
    const soil = this.soilAt(x, z);
    if (!soil || soil.brittle) return false;
    this.field.deposit(x, z, vol, clamp(Math.cbrt(vol) * 1.2, 0.03, 0.35), soil);
    // A big clod lands with a puff.
    if (vol > 3e-4 && SOILS[kind].dust > 0.2 && Math.random() < 0.5) {
      const t = SOILS[kind].tint;
      this.ctx.fx.puff(x, this.surfaceY(x, z) + 0.05, z, t[0], t[1], t[2], 0.35 + Math.cbrt(vol) * 2, 0.6);
    }
    return true;
  }

  /** Once per rendered frame, with the cameras placed. */
  frame(cams: THREE.Vector3[], lead: number) {
    this.cams.length = cams.length;
    for (let i = 0; i < cams.length; i++) this.cams[i] = { x: cams[i].x, z: cams[i].z };
    this.deform.update(this.cams, this.ctx.R?.sunDir);
    this.spray.update(lead);
  }

  /** Point sprites are sized per view. */
  setViewScale(h: number, fov: number) {
    this.spray.setViewScale(h, fov);
  }

  snapshot(): GroundSnapshot {
    return this.field.snapshot();
  }

  restore(s: GroundSnapshot, nights = 1) {
    this.deform.reset();
    this.field.restore(s, nights);
  }

  dispose() {
    this.deform.dispose();
    this.spray.dispose();
    this.group.removeFromParent();
    this.field.clear();
    this.ejecta.clear();
  }
}
