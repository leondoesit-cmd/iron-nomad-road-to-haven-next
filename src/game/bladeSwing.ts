import * as THREE from 'three';
import { clamp } from '../core/math';
import { G, groups } from '../physics/physics';
import { vegetationIn, type Vegetation, type VegetationPlant } from '../render/vegetation';
import { BODY, LEGS, PART_BIT, WINGED, type AnimalPart, type AnimalZone } from '../sim/anatomy';
import type { Zone } from '../sim/ballistics';
import {
  animalSection, BLADE, bladeWork, bodySection, chipSize, chopBits, chopGain, cutLine, DEAD_TOUGH, deepen, edgeAt, FLESH, sectionCost, STEMS, stemCost, stroke,
  STUBBLE, sweepCapsule, swingPlane, WAIST, workAt, type BladeKind, type Stroke, type BladeSpec, type Contact, type CutLine, type SwingPlane, type SwingStyle,
} from '../sim/blade';
import { BUSH_LEAF, WOOD } from '../sim/treeDamage';
import type { MeleeFeel, MeleeKind } from '../sim/weaponfx';
import type { Ctx } from './ctx';
import type { Player } from './player';
import type { Animal } from './wildlife';
import type { Zombie } from './zombies';

/**
 * A blade swung through the world, as it lands (`sim/blade.ts` has the rules). The swing turns in one plane about the
 * shoulder, through the point the swinger is looking at; everything the plane crosses inside the arc is struck where the
 * plane meets it, in the order the edge gets there, and each cut spends the edge's work. Grass and flowers hardly slow it
 * and their tops fly off; a bush's thin twigs go easily and its thick stems near the ground take strokes; one of the dead
 * loses an arm, a leg, its head or (at the waist, with a long blade and a few strokes) its top half, where the edge crossed
 * it; a beast loses a leg or its head; a tree takes a notch and throws chips; a wall, a car, a drum or the ground stops the
 * blade dead. A cut that is not finished stays where it is, and the next stroke there goes on from it.
 */

export interface SwingIn {
  kind: BladeKind;
  model: MeleeKind;
  style: SwingStyle;
  /** Damage a full blow does to a body's hit points (the weapon's, worn and boosted), and its limb-taking (`cutOf`). */
  dmg: number;
  cut: number;
  reach: number;
  feel: MeleeFeel;
  /** The way the swinger was looking when the swing began (unit), and how high its eyes are over its feet. */
  aim: [number, number, number];
  eyeH: number;
  /** 1 fresh, less when winded: a tired arm swings slower. */
  arm: number;
}

export interface SwingOut {
  /** Bodies struck (the dead, beasts) and plants cut. */
  bodies: number;
  plants: number;
  /** What stopped the blade, if anything did. */
  stopped: 'flesh' | 'wood' | 'stone' | 'metal' | 'ground' | null;
  /** Work (J) left in the edge at the end of the arc. */
  left: number;
}

/** What one stroke after another has done to each body and plant: the cuts in progress (`sim/blade.ts` `CutLine`). */
const CUTS = new WeakMap<object, CutLine[]>();
const cutsOf = (o: object) => {
  let l = CUTS.get(o);
  if (!l) CUTS.set(o, (l = []));
  return l;
};

/** Everything solid the edge can run into: the ground, the road, walls, cars, furniture, trunks and loose drums. */
const SOLID = groups(0xffff, G.STATIC | G.ROAD | G.VEHICLE | G.BUILD | G.FURN | G.LOOSE);

type Soft =
  | { kind: 'zombie'; c: Contact; zb: Zombie; zone: Zone; restY: number }
  | { kind: 'corpse'; c: Contact; zb: Zombie; zone: Zone; restY: number }
  | { kind: 'animal'; c: Contact; a: Animal; zone: AnimalZone; along: number }
  | { kind: 'plant'; c: Contact; p: VegetationPlant; veg: Vegetation; y: number }
  | { kind: 'crown'; c: Contact; p: VegetationPlant; veg: Vegetation };

/** How far out along the edge a point lies (its distance from the pivot in the plane, kept to the edge's span). */
function radiusAt(pl: SwingPlane, x: number, y: number, z: number): number {
  const dx = x - pl.pivot[0], dy = y - pl.pivot[1], dz = z - pl.pivot[2];
  return clamp(Math.hypot(dx * pl.u[0] + dy * pl.u[1] + dz * pl.u[2], dx * pl.v[0] + dy * pl.v[1] + dz * pl.v[2]), pl.rIn, pl.rOut);
}

/** The plane of a swing from where `p` stands and the way it was looking: through the shoulder and the point looked at. */
export function planeFor(p: Player, s: SwingIn): SwingPlane {
  const spec = BLADE[s.kind];
  const f = p.aimYaw;
  // The right shoulder (the blade's), then moved into the plane of the look so the cut goes where the crosshair is.
  const sh: [number, number, number] = [p.pos.x - Math.cos(f) * 0.18, p.pos.y + (p.crouch ? 1.0 : 1.42), p.pos.z + Math.sin(f) * 0.18];
  const reach = Math.min(s.reach * 0.8, 0.62 + spec.edge + 0.55);
  const pl = swingPlane(sh, s.aim, s.style, reach, spec.edge);
  // The eyes, a hair ahead of the neck: the plane is slid along its normal until the line of sight lies in it.
  const off = (sh[0] - p.pos.x - Math.sin(f) * 0.08) * pl.n[0] + (sh[1] - p.pos.y - s.eyeH) * pl.n[1] + (sh[2] - p.pos.z - Math.cos(f) * 0.08) * pl.n[2];
  return swingPlane([sh[0] - pl.n[0] * off, sh[1] - pl.n[1] * off, sh[2] - pl.n[2] * off], s.aim, s.style, reach, spec.edge);
}

/** Where the tip of the edge is `e` of the way through the arc (0 cocked, 1 followed through), for the streak it draws. */
export function tipAt(pl: SwingPlane, e: number): [number, number, number] {
  const a = pl.start - (pl.start + pl.end) * clamp(e, 0, 1);
  const d = edgeAt(pl, a).dir;
  return [pl.pivot[0] + d[0] * pl.rOut, pl.pivot[1] + d[1] * pl.rOut, pl.pivot[2] + d[2] * pl.rOut];
}

/** Land a swing: sweep it through the world and cut what it crosses. */
export function landSwing(p: Player, s: SwingIn, pl: SwingPlane): SwingOut {
  const ctx = p.ctx;
  const spec = BLADE[s.kind];
  const out: SwingOut = { bodies: 0, plants: 0, stopped: null, left: 0 };
  const P = pl.pivot;
  const range = pl.rOut + 1.5;

  // What solid the edge runs into first, stepping it through the arc.
  const solid = sweepSolid(ctx, pl);

  // Everything soft the plane crosses inside the arc.
  const soft: Soft[] = [];
  for (const zb of ctx.zombies.list) {
    if (zb.dead || Math.abs(zb.x - P[0]) > range + 1 || Math.abs(zb.z - P[2]) > range + 1) continue;
    soft.push(...zombieContact(ctx, pl, zb));
  }
  // The dead lying on the ground: hacked where the edge crosses them, like the standing.
  for (const { zb, segs } of ctx.zombies.lyingBodies()) {
    if (Math.abs(segs[3] - P[0]) > range + 1.5 || Math.abs(segs[5] - P[2]) > range + 1.5) continue;
    soft.push(...corpseContact(pl, zb, segs));
  }
  for (const a of ctx.wildlife.list) {
    if (a.dead || a.flying || Math.abs(a.x - P[0]) > range + 2 || Math.abs(a.z - P[2]) > range + 2) continue;
    soft.push(...animalContact(pl, a));
  }
  for (const veg of vegetationIn(ctx.P)) {
    veg.bladeNear(P[0], P[2], range, (pt) => {
      const hit = plantContact(veg, pl, pt);
      if (hit) soft.push(hit);
    });
  }
  soft.sort((x, y) => y.c.angle - x.c.angle);

  let work = bladeWork(spec) * s.arm * s.arm;
  // Bodies already struck this swing: the edge going on from an arm into the leg below it is the same blow.
  const struck = new Set<object>();
  for (const h of soft) {
    if (work <= 0.5) break;
    if (solid && h.c.angle < solid.c.angle) break;
    // A part this swing has already taken off is not there any more, and the dead stay dead.
    if (h.kind === 'zombie' && (h.zb.dead || (h.zone !== 'torso' && PART_IDS[h.zone].every((id) => h.zb.wounds.mask & (1 << id))))) continue;
    if (h.kind === 'animal' && (h.a.dead || (h.zone !== 'torso' && h.a.wounds.mask & PART_BIT[h.zone]))) continue;
    // The edge's speed where it meets it: the tip end has more in it than the hilt.
    const here = Math.min(work, workAt(spec, h.c.r, pl.rOut, s.arm));
    let left: number;
    switch (h.kind) {
      case 'zombie':
        left = cutZombie(p, s, spec, pl, h, here, struck.has(h.zb));
        if (!struck.has(h.zb)) out.bodies++;
        struck.add(h.zb);
        break;
      case 'corpse':
        left = cutCorpse(p, s, spec, pl, h, here);
        if (!struck.has(h.zb)) out.bodies++;
        struck.add(h.zb);
        break;
      case 'animal':
        left = cutAnimal(p, s, spec, pl, h, here, struck.has(h.a));
        if (!struck.has(h.a)) out.bodies++;
        struck.add(h.a);
        break;
      case 'plant':
        left = cutPlant(ctx, spec, pl, h, here);
        out.plants++;
        break;
      default:
        left = crownLeaves(ctx, pl, h, here);
    }
    // What the cut did not spend carries on; the share of the work it took is gone.
    work -= here - left;
    if (left <= 0.5 && h.kind !== 'crown') {
      out.stopped = h.kind === 'plant' ? 'wood' : 'flesh';
      out.left = 0;
      return out;
    }
  }
  if (solid && work > 0.5) {
    out.stopped = strikeSolid(p, s, spec, pl, solid, Math.min(work, workAt(spec, solid.c.r, pl.rOut, s.arm)));
    work = 0;
  }
  out.left = work;
  return out;
}

// ------------------------------------------------------------------ finding what is in the arc

interface SolidHit {
  c: Contact;
  handle: number;
  nx: number;
  ny: number;
  nz: number;
}

/** Step the edge through the arc and cast along it: the first solid thing it would run into, and where. */
function sweepSolid(ctx: Ctx, pl: SwingPlane, steps = 60): SolidHit | null {
  const P = pl.pivot;
  const len = pl.rOut - pl.rIn;
  for (let i = 0; i <= steps; i++) {
    const a = pl.start - ((pl.start + pl.end) * i) / steps;
    const d = edgeAt(pl, a).dir;
    const hit = ctx.P.raycast(P[0] + d[0] * pl.rIn, P[1] + d[1] * pl.rIn, P[2] + d[2] * pl.rIn, d[0], d[1], d[2], len, SOLID);
    if (!hit) continue;
    const r = pl.rIn + hit.toi;
    return { c: { angle: a, r, x: P[0] + d[0] * r, y: P[1] + d[1] * r, z: P[2] + d[2] * r }, handle: hit.collider.handle, nx: hit.normal.x, ny: hit.normal.y, nz: hit.normal.z };
  }
  return null;
}

/**
 * The parts of one of the dead in its rest pose (metres at scale 1, feet at 0, facing +z, +x its left): each a capsule from
 * one end to the other, its radius, and the zone it is.
 */
const PARTS: { zone: Zone; a: [number, number, number]; b: [number, number, number]; r: number }[] = [
  // The head with its neck, down to where the neck meets the shoulders.
  { zone: 'head', a: [0, 1.46, 0.0], b: [0, 1.78, 0.02], r: 0.09 },
  { zone: 'torso', a: [0, 0.9, 0], b: [0, 1.46, -0.02], r: 0.15 },
  { zone: 'armL', a: [0.21, 1.42, -0.01], b: [0.23, 0.8, 0.04], r: 0.045 },
  { zone: 'armR', a: [-0.21, 1.42, -0.01], b: [-0.23, 0.8, 0.04], r: 0.045 },
  { zone: 'legL', a: [0.1, 0.94, 0], b: [0.11, 0.06, 0.03], r: 0.07 },
  { zone: 'legR', a: [-0.1, 0.94, 0], b: [-0.11, 0.06, 0.03], r: 0.07 },
];
/** The hidden-part ids of the zombie mesh each zone takes with it (`ballistics.LIMB_PARTS`). */
const PART_IDS: Record<Exclude<Zone, 'torso'>, number[]> = { head: [9], armL: [5, 7], armR: [6, 8], legL: [1, 3], legR: [2, 4] };
/** Height of the hips in the rest pose: a body that leans goes over from there. */
const HIPS = 0.94;

type V3 = [number, number, number];

/**
 * The parts of a body (capsules from `a` to `b`, world) the plane crosses, each with the angle the edge reaches it at and how
 * far along it (0 at `a`, 1 at `b`) the plane crosses its middle, which is where the cut goes. A plane that only grazes a
 * part's rounded end (the top of the chest under a cut at the neck) counts only when it crosses no part at all; one that
 * runs along a part (a chop straight down a standing arm) meets it where the edge first touches.
 */
function crossedParts<T extends { a: V3; b: V3; r: number }>(pl: SwingPlane, parts: T[]): { part: T; c: Contact; t: number }[] {
  const out: { part: T; c: Contact; t: number }[] = [];
  let graze: { part: T; c: Contact; t: number } | null = null;
  for (const part of parts) {
    const { a, b } = part;
    const c = sweepCapsule(pl, a, b, part.r, 10);
    if (!c) continue;
    const da = pl.n[0] * (a[0] - pl.pivot[0]) + pl.n[1] * (a[1] - pl.pivot[1]) + pl.n[2] * (a[2] - pl.pivot[2]);
    const dab = pl.n[0] * (b[0] - a[0]) + pl.n[1] * (b[1] - a[1]) + pl.n[2] * (b[2] - a[2]);
    let t = Math.abs(dab) > 1e-4 ? -da / dab : NaN;
    const crossed = (t >= 0 && t <= 1) || (Math.abs(dab) <= 1e-4 && Math.abs(da) <= part.r);
    if (!crossed && graze && c.angle <= graze.c.angle) continue;
    if (!(t >= 0 && t <= 1)) {
      const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      t = clamp(((c.x - a[0]) * ab[0] + (c.y - a[1]) * ab[1] + (c.z - a[2]) * ab[2]) / Math.max(1e-6, ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2]), 0, 1);
    }
    // The point the cut goes through: on the part's middle, where the plane crosses it, and how far out along the edge.
    const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t, z = a[2] + (b[2] - a[2]) * t;
    const hit = { part, c: { ...c, r: radiusAt(pl, x, y, z), x, y, z }, t };
    if (crossed) out.push(hit);
    else graze = hit;
  }
  if (!out.length && graze) out.push(graze);
  return out;
}

/** Where the plane crosses one of the dead: each of the parts it still has that the plane goes through, leaning as it leans. */
function zombieContact(ctx: Ctx, pl: SwingPlane, zb: Zombie): Soft[] {
  const pose = ctx.zombies.poseOf(zb);
  const sc = zb.def.scale;
  const lean = Math.min(1.3, pose.lean);
  const cl = Math.cos(lean), sl = Math.sin(lean);
  const rx = Math.cos(zb.yaw), rz = -Math.sin(zb.yaw);
  const fx = Math.sin(zb.yaw), fz = Math.cos(zb.yaw);
  const world = (q: V3): V3 => {
    let [x, y, z] = q;
    if (y > HIPS && lean > 0) {
      // Above the hips the body goes over forward.
      const up = y - HIPS;
      y = HIPS + up * cl - z * sl;
      z = z * cl + up * sl;
    }
    return [zb.x + (x * rx + z * fx) * sc, pose.y + y * sc, zb.z + (x * rz + z * fz) * sc];
  };
  const parts = PARTS.filter((q) => q.zone === 'torso' || !PART_IDS[q.zone].every((id) => zb.wounds.mask & (1 << id)))
    .map((q) => ({ zone: q.zone, restA: q.a[1], restB: q.b[1], a: world(q.a), b: world(q.b), r: q.r * sc }));
  return crossedParts(pl, parts).map((hit) => ({ kind: 'zombie', c: hit.c, zb, zone: hit.part.zone, restY: hit.part.restA + (hit.part.restB - hit.part.restA) * hit.t }));
}

/**
 * Where the plane crosses one of the dead lying on the ground (`ZombieSystem.lyingBodies`): its body from the head to the
 * hips and its legs from the hips to the feet, as they lie. The height on the body each crossing stands for (rest pose) is
 * reckoned along those lines; the flesh engine finds the real part from the point (`hackAt`).
 */
function corpseContact(pl: SwingPlane, zb: Zombie, segs: Float32Array): Soft[] {
  const sc = zb.def.scale;
  const head: V3 = [segs[0], segs[1], segs[2]];
  const hips: V3 = [segs[3], segs[4], segs[5]];
  const feet: V3 = [segs[6], segs[7], segs[8]];
  const parts = [
    { a: head, b: hips, r: 0.17 * sc, top: 1.72, bottom: HIPS, body: true },
    { a: hips, b: feet, r: 0.13 * sc, top: HIPS, bottom: 0.08, body: false },
  ];
  return crossedParts(pl, parts).map((hit) => {
    const restY = hit.part.top + (hit.part.bottom - hit.part.top) * hit.t;
    const zone: Zone = hit.part.body ? (restY > 1.46 ? 'head' : 'torso') : 'legL';
    return { kind: 'corpse', c: hit.c, zb, zone, restY };
  });
}

/** The parts of a beast as capsules: its body along its back, its neck up to its head, and its legs under it. */
function animalContact(pl: SwingPlane, a: Animal): Soft[] {
  const b = BODY[a.kind];
  const k = a.def.size;
  const fx = Math.sin(a.yaw), fz = Math.cos(a.yaw);
  const rx = Math.cos(a.yaw), rz = -Math.sin(a.yaw);
  const lying = a.state === 'bed';
  const leg = lying ? 0 : b.leg * k;
  const depth = Math.max(0.05, (b.height * k - leg) * 0.42);
  const mid = a.y + (lying ? depth : leg + depth);
  const half = (b.len * k) / 2;
  const parts: { zone: AnimalZone; a: V3; b: V3; r: number }[] = [];
  parts.push({ zone: 'torso', a: [a.x - fx * half * 0.75, mid, a.z - fz * half * 0.75], b: [a.x + fx * half * 0.75, mid, a.z + fz * half * 0.75], r: depth });
  if (!(a.wounds.mask & 16)) {
    // The neck, from the shoulders up to the head: where a blade takes the head.
    const head: V3 = [a.x + fx * b.headZ * k, a.y + (lying ? b.headY * k * 0.5 : b.headY * k), a.z + fz * b.headZ * k];
    parts.push({ zone: 'head', a: [a.x + fx * half * 0.8, mid + depth * 0.4, a.z + fz * half * 0.8], b: head, r: Math.max(0.03, animalSection(a.kind, 'head', k).width * 0.6) });
  }
  if (!lying && leg > 0) {
    const lr = Math.max(0.012, animalSection(a.kind, 'legLF', k).width * 0.5);
    const two = WINGED.has(a.kind);
    for (let i = 0; i < (two ? 2 : 4); i++) {
      if (a.wounds.mask & (1 << i)) continue;
      const side = i % 2 === 0 ? 1 : -1;
      const along = two ? 0 : i < 2 ? half * 0.7 : -half * 0.7;
      const x = a.x + rx * side * b.w * k * 0.8 + fx * along;
      const z = a.z + rz * side * b.w * k * 0.8 + fz * along;
      // Root at the body, foot at the ground: a cut is counted from where the leg leaves the body.
      parts.push({ zone: LEGS[i] as AnimalPart, a: [x, a.y + leg, z], b: [x, a.y + 0.02, z], r: lr });
    }
  }
  return crossedParts(pl, parts).map((hit) => ({ kind: 'animal', c: hit.c, a, zone: hit.part.zone, along: hit.t }));
}

/** A plant as the plane meets it: a soft plant's stems from its root to its top, a tree's crown (its trunk is solid). */
function plantContact(veg: Vegetation, pl: SwingPlane, p: VegetationPlant): Soft | null {
  const x = p.position.x, y = p.position.y, z = p.position.z;
  if (p.woodHulls) {
    const crown = veg.crownOf(p);
    if (!crown || p.record.broken) return null;
    const c = sweepCapsule(pl, [crown.x, crown.y - crown.h * 0.6, crown.z], [crown.x, crown.y + crown.h * 0.4, crown.z], crown.r * 0.8, 6);
    return c ? { kind: 'crown', c, p, veg } : null;
  }
  if (!STEMS[p.kind]) return null;
  const h = veg.standing(p);
  if (h <= p.height * STUBBLE * 1.2) return null;
  // The stems stand within the middle of the clump; the edge meets the clump's leaves first.
  const r = clamp(p.radius * 0.45, 0.04, 0.9);
  const c = sweepCapsule(pl, [x, y + 0.02, z], [x, y + h, z], r, 8);
  if (!c) return null;
  // The stems are cut where the plane crosses the middle of the clump, by the edge going as fast as it is out there. A chop
  // straight down into it (the plane upright, along the stems) is marked with NaN: it goes down through them as far as its
  // work takes it (`cutPlant`).
  const ny = pl.n[1];
  const yc = Math.abs(ny) > 0.15 ? pl.pivot[1] - (pl.n[0] * (x - pl.pivot[0]) + pl.n[2] * (z - pl.pivot[2])) / ny : NaN;
  const ym = Number.isNaN(yc) ? c.y : clamp(yc, y, y + h);
  return { kind: 'plant', c: { ...c, r: radiusAt(pl, x, ym, z) }, p, veg, y: Number.isNaN(yc) ? NaN : ym };
}

// ------------------------------------------------------------------ cutting what it meets

/**
 * Hit points a stroke takes off a body: the weapon's blow, by the work the edge brought to it. Going on into another part of
 * a body it has just cut through, only by the work that part took.
 */
function hurt(s: SwingIn, spec: BladeSpec, work: number, st: Stroke, again: boolean): number {
  const w = bladeWork(spec);
  return again ? s.dmg * clamp((work - st.left) / w, 0.05, 1) : s.dmg * clamp(work / w, 0.2, 1.1);
}

/** One of the dead: the edge goes into the part it crossed, as far as its work pays for, and the body takes the blow. */
function cutZombie(p: Player, s: SwingIn, spec: BladeSpec, pl: SwingPlane, h: Extract<Soft, { kind: 'zombie' }>, work: number, again: boolean): number {
  const ctx = p.ctx;
  const zb = h.zb;
  const sc = zb.def.scale;
  const sec = bodySection(h.zone, h.restY, sc);
  const cost = sectionCost(sec, FLESH.rotten, DEAD_TOUGH[zb.kind] ?? 1);
  const line = cutLine(cutsOf(zb), h.zone, h.restY);
  const st = stroke(spec, work, cost, line.done, sec.width);
  // Through the chest or the hips the edge stops in the bone: only the waist parts.
  if (h.zone === 'torso' && (h.restY < WAIST[0] || h.restY > WAIST[1]) && st.through) {
    st.through = false;
    st.done = 0.95;
    st.left = 0;
  }
  deepen(line, h.restY, st);
  const m = edgeAt(pl, h.c.angle).motion;
  const pose = ctx.zombies.poseOf(zb);
  const dmg = hurt(s, spec, work, st, again);
  ctx.zombies.meleeHit(p, h.c.x, h.c.z, p.aimYaw, s.reach, dmg, s.feel, s.cut, s.model, (z) =>
    z === zb ? { x: h.c.x, y: pose.y + line.y * sc, z: h.c.z, dx: m[0], dy: m[1], dz: m[2], zone: h.zone, depth: line.done, through: st.through } : null);
  ctx.gore.flesh(h.c.x, h.c.y, h.c.z, m[0], m[1] + 0.2, m[2], clamp((st.gain * cost) / 40, 0.2, 1.3));
  ctx.audio.play('slash', h.c.x, h.c.z, clamp(0.35 + work / 200, 0.3, 0.8), { pitch: st.through ? 1.1 : 0.85 });
  if (st.through) line.done = 0;
  return st.left;
}

/** One of the dead lying on the ground: the edge goes in where it crossed it, and the flesh engine finds what it cut. */
function cutCorpse(p: Player, s: SwingIn, spec: BladeSpec, pl: SwingPlane, h: Extract<Soft, { kind: 'corpse' }>, work: number): number {
  const ctx = p.ctx;
  const zb = h.zb;
  const sec = bodySection(h.zone, h.restY, zb.def.scale);
  const cost = sectionCost(sec, FLESH.rotten, DEAD_TOUGH[zb.kind] ?? 1);
  const line = cutLine(cutsOf(zb), h.zone === 'legL' ? 'legs' : h.zone, h.restY);
  const st = stroke(spec, work, cost, line.done, sec.width);
  if (h.zone === 'torso' && (h.restY < WAIST[0] || h.restY > WAIST[1]) && st.through) {
    st.through = false;
    st.done = 0.95;
    st.left = 0;
  }
  deepen(line, h.restY, st);
  const m = edgeAt(pl, h.c.angle).motion;
  ctx.zombies.hackAt(p, zb, { x: h.c.x, y: h.c.y, z: h.c.z, dx: m[0], dy: m[1], dz: m[2], zone: h.zone, depth: line.done, through: st.through }, hurt(s, spec, work, st, false), s.cut, s.model);
  ctx.gore.flesh(h.c.x, h.c.y, h.c.z, m[0], m[1] + 0.3, m[2], clamp((st.gain * cost) / 40, 0.2, 1.1));
  ctx.audio.play('slash', h.c.x, h.c.z, clamp(0.3 + work / 220, 0.3, 0.7), { pitch: 0.8 });
  if (st.through) line.done = 0;
  return st.left;
}

/** A beast: its leg, its neck or its body, cut as far as the work pays for. */
function cutAnimal(p: Player, s: SwingIn, spec: BladeSpec, pl: SwingPlane, h: Extract<Soft, { kind: 'animal' }>, work: number, again: boolean): number {
  const ctx = p.ctx;
  const a = h.a;
  const sec = animalSection(a.kind, h.zone, a.def.size);
  const cost = sectionCost(sec, FLESH.living, 1 + a.def.armor * 2);
  const along = h.zone === 'torso' ? 0 : h.along;
  const line = cutLine(cutsOf(a), h.zone, along, 0.15);
  const st = stroke(spec, work, cost, line.done, sec.width);
  // The body is opened, never parted.
  if (h.zone === 'torso' && st.through) {
    st.through = false;
    st.done = 0.95;
    st.left = 0;
  }
  deepen(line, along, st);
  const m = edgeAt(pl, h.c.angle).motion;
  const dmg = hurt(s, spec, work, st, again) * (h.zone === 'head' ? 1.4 : h.zone === 'torso' ? 1 : 0.6);
  ctx.wildlife.meleeHit(p, h.c.x, h.c.z, p.aimYaw, s.reach, dmg, s.feel, s.cut, (b) =>
    b === a ? { x: h.c.x, y: h.c.y, z: h.c.z, dx: m[0], dy: m[1], dz: m[2], zone: h.zone, depth: line.done, through: st.through } : null);
  ctx.gore.flesh(h.c.x, h.c.y, h.c.z, m[0], m[1] + 0.2, m[2], clamp((st.gain * cost) / 50, 0.2, 1.1));
  ctx.audio.play('slash', h.c.x, h.c.z, clamp(0.3 + work / 220, 0.3, 0.75), { pitch: 0.95 });
  if (st.through) line.done = 0;
  return st.left;
}

/** A soft plant: the stems part where the plane crosses them; once through, the top flies off in pieces. */
function cutPlant(ctx: Ctx, spec: BladeSpec, pl: SwingPlane, h: Extract<Soft, { kind: 'plant' }>, work: number): number {
  const p = h.p;
  const base = p.position.y;
  const s = Math.max(p.scale.x, p.scale.y, p.scale.z);
  if (Number.isNaN(h.y)) {
    // Straight down into it: through the twigs to where the stems get too thick for what the edge has left (a clump of
    // grass all the way to the stubble), and that is where it is cut.
    const top = h.veg.standing(p) / p.height;
    let lo = STUBBLE;
    let hi = top;
    if (stemCost(p.kind, lo, s) > work * spec.sharp) {
      for (let i = 0; i < 14; i++) {
        const mid = (lo + hi) / 2;
        if (stemCost(p.kind, mid, s) > work * spec.sharp) lo = mid;
        else hi = mid;
      }
      lo = hi;
    }
    h.y = base + Math.min(top, lo) * p.height;
  }
  const share = clamp((h.y - base) / Math.max(0.05, p.height), 0, 1);
  const cost = stemCost(p.kind, share, s);
  const line = cutLine(cutsOf(p), 'stem', share, 0.12);
  // The edge sweeps through the stems one after another: what it has to get through is their own thickness, not the clump's.
  const st = stroke(spec, work, cost, line.done, 2 * Math.sqrt(cost / STEMS[p.kind].tough / Math.PI));
  deepen(line, share, st);
  const m = edgeAt(pl, h.c.angle).motion;
  if (st.through) {
    // What stood above the cut comes off.
    const fell = Math.max(0.05, h.veg.standing(p) - (h.y - base));
    h.veg.trimPlant(p, h.y, STUBBLE);
    plantBits(ctx, p, h.c.x, h.y, h.c.z, m, fell, work, true);
    line.done = 0;
  } else plantBits(ctx, p, h.c.x, h.c.y, h.c.z, m, 0, work * st.gain, false);
  // The stems give a little as the edge goes through: the plant sways after it.
  p.bend.vx += m[2] * Math.min(2, work / 40);
  p.bend.vz -= m[0] * Math.min(2, work / 40);
  ctx.audio.play('rustle', h.c.x, h.c.z, clamp(0.12 + cost / 150, 0.12, 0.5), { pitch: 1.1 });
  return st.left;
}

/** Through a tree's crown up among its limbs: leaves and twigs come down, and the edge loses a little. */
function crownLeaves(ctx: Ctx, pl: SwingPlane, h: Extract<Soft, { kind: 'crown' }>, work: number): number {
  const leaf = h.p.wood ? WOOD[h.p.wood].leaf : null;
  if (leaf) ctx.gore.timber.leaves(h.c.x, h.c.y, h.c.z, 3 + Math.round(work / 30), leaf, 0.7);
  const m = edgeAt(pl, h.c.angle).motion;
  const floor = ctx.drawnGroundAt ? ctx.drawnGroundAt(h.c.x, h.c.z) : ctx.groundAt(h.c.x, h.c.z);
  const bark = WOOD[h.p.wood ?? 'snag'].bark;
  for (let i = 0; i < 2; i++) {
    const k = 0.8 + Math.random() * 0.4;
    ctx.gore.timber.chips.throw('chip', h.c.x, h.c.y, h.c.z, m[0] * 2 + rnd(0.8), 0.5 + Math.random(), m[2] * 2 + rnd(0.8), 3 + Math.random() * 3, 1.2, 0.5, bark[0] * k, bark[1] * k, bark[2] * k, floor);
  }
  ctx.audio.play('rustle', h.c.x, h.c.z, 0.35);
  return work * 0.85;
}

const rnd = (k: number) => (Math.random() - 0.5) * 2 * k;

/**
 * Linear RGB of a soft plant's leaves as its card draws them, before the plant's own tint (`instanceColor`): a dry clump of
 * grass is all tint, a desert shrub's sage leaves and dark twigs are tinted sage to dead brown, or green in the green
 * country. The flowers wear the instance's colour on their petals.
 */
const LEAF: Record<string, [number, number, number]> = {
  grass: [0.62, 0.6, 0.55], shrubs: [0.32, 0.37, 0.2], flowers: [0.08, 0.18, 0.04], blooms: [0.08, 0.2, 0.05], yarrow: [0.1, 0.18, 0.05], iris: [0.1, 0.22, 0.06],
  zaatar: [0.16, 0.2, 0.1], ferns: [0.08, 0.22, 0.04], weed: [0.1, 0.18, 0.04], pads: [0.07, 0.2, 0.04], reeds: [0.25, 0.28, 0.08],
  papyrus: [0.12, 0.26, 0.05], cane: [0.28, 0.32, 0.09], sabra: [0.14, 0.24, 0.07], mushroom: [0.55, 0.45, 0.32],
};
const _c = new THREE.Color();

/**
 * What flies off a plant the edge went through (`through`) or into: clippings of grass, petals and the flower's head, a
 * bush's leaves and twigs, a reed's or a cane's top as a whole stalk, a cactus pad in chunks. They go the way the edge was
 * going and fall; `fell` is the length (m) of what was cut off the top.
 */
function plantBits(ctx: Ctx, p: VegetationPlant, x: number, y: number, z: number, m: number[], fell: number, work: number, through: boolean) {
  const chips = ctx.gore.timber.chips;
  const spec = STEMS[p.kind];
  const floor = ctx.drawnGroundAt ? ctx.drawnGroundAt(x, z) : ctx.groundAt(x, z);
  // The plant's own tint, which its card's colours are drawn under.
  const ref = p.refs[0];
  const tinted = !!ref?.mesh.instanceColor && p.kind !== 'flowers' && p.kind !== 'blooms' && p.kind !== 'oleander';
  if (tinted) ref.mesh.getColorAt(ref.index, _c);
  const tint = tinted ? [_c.r, _c.g, _c.b] : [1, 1, 1];
  const base = LEAF[p.kind] ?? (BUSH_LEAF[p.kind] as [number, number, number] | undefined) ?? [0.12, 0.22, 0.05];
  const leaf = [base[0] * tint[0], base[1] * tint[1], base[2] * tint[2]];
  const twig = [0.07 * tint[0], 0.055 * tint[1], 0.036 * tint[2]];
  const fling = clamp(2.5 + work / 12, 2.5, 8);
  const toss = (kind: 'chip' | 'bark' | 'leaf', sx: number, sy: number, sz: number, rgb: readonly number[], up = 0.4, speed = fling, from = 0) => {
    const k = 0.8 + Math.random() * 0.4;
    const s = speed * (0.4 + Math.random() * 0.7);
    chips.throw(kind, x + rnd(0.1), y + from * Math.random() + rnd(0.04), z + rnd(0.1), m[0] * s + rnd(0.8), Math.max(0.2, m[1] * s * 0.5) + up + Math.random(), m[2] * s + rnd(0.8), sx, sy, sz, rgb[0] * k, rgb[1] * k, rgb[2] * k, floor);
  };
  const n = (a: number, b: number) => Math.round(a + Math.random() * (b - a));
  switch (spec?.bits) {
    case 'clip':
      for (let i = n(3, 6) * (through ? 1 : 0.4); i > 0; i--) toss('chip', 2 + Math.random() * 2.5, 0.25, 0.3, leaf, 0.6, fling, fell * 0.5);
      break;
    case 'flower': {
      // The petals in the plant's own colour (the instance's), the head and a stalk with it.
      if (ref?.mesh.instanceColor) ref.mesh.getColorAt(ref.index, _c);
      else _c.setRGB(0.8, 0.75, 0.2);
      const petal = [_c.r, _c.g, _c.b];
      for (let i = n(4, 8) * (through ? 1 : 0.5); i > 0; i--) toss('leaf', 0.35, 0.35, 0.35, petal, 0.8, fling * 0.8, fell);
      if (through) {
        toss('chip', 1.5 + fell * 8, 0.4, 0.35, leaf, 0.5, fling * 0.6, fell * 0.5);
        for (let i = n(1, 3); i > 0; i--) toss('leaf', 0.6, 0.6, 0.6, leaf, 0.6);
      }
      if (p.kind === 'oleander' || p.kind === 'iris') for (let i = n(2, 6); i > 0; i--) toss('leaf', 0.9, 0.9, 0.9, leaf, 0.5, fling, fell);
      break;
    }
    case 'leafy':
      // A bush: a burst of leaves however the stroke went, twigs and the lopped top when it went through.
      for (let i = n(4, 9) + Math.round(work / 20); i > 0; i--) toss('leaf', 0.8 + Math.random() * 0.4, 1, 1, leaf, 0.6, fling * 0.8, through ? fell : 0.2);
      for (let i = through ? n(2, 4) + Math.round(fell * 4) : n(0, 2); i > 0; i--) toss('chip', 3 + Math.random() * 5, 1.4, 0.7, twig, 0.4, fling * 0.7, fell);
      break;
    case 'stalk':
      // A reed's or a cane's top comes away as a whole stalk, with its leaves.
      if (through) {
        for (let i = n(1, 3); i > 0; i--) toss('chip', Math.max(2, fell * 18), 1.6, 0.8, leaf, 0.3, fling * 0.5, fell * 0.3);
        for (let i = n(2, 5); i > 0; i--) toss('leaf', 1.3, 0.8, 1, leaf, 0.6, fling * 0.6, fell);
      } else for (let i = n(1, 3); i > 0; i--) toss('chip', 1.5, 1, 0.6, [0.6, 0.55, 0.35], 0.4);
      break;
    case 'pad':
      // A cactus pad or a lily pad in chunks, green skin and pale flesh.
      for (let i = n(3, 6) * (through ? 1 : 0.6); i > 0; i--) toss('bark', 2 + Math.random() * 2, 2, 2, Math.random() < 0.6 ? leaf : [0.45, 0.55, 0.3], 0.5, fling * 0.7, fell * 0.5);
      if (through && fell > 0.2) for (let i = n(1, 2); i > 0; i--) toss('bark', 5, 3, 4, leaf, 0.4, fling * 0.4, fell * 0.5);
      break;
    case 'frond':
      for (let i = n(3, 6); i > 0; i--) toss('leaf', 1.8, 0.8, 1.4, leaf, 0.6, fling * 0.7, fell);
      break;
    case 'cap':
      for (let i = n(2, 4); i > 0; i--) toss('bark', 0.8, 0.6, 0.8, leaf, 0.7, fling * 0.6, fell * 0.5);
      break;
  }
}

/** The edge runs into something solid: what it is decides what it does to it and what flies, and the blade stops there. */
function strikeSolid(p: Player, s: SwingIn, spec: BladeSpec, pl: SwingPlane, h: SolidHit, work: number): SwingOut['stopped'] {
  const ctx = p.ctx;
  const { x, y, z } = h.c;
  const m = edgeAt(pl, h.c.angle).motion;
  // A tree's trunk or its stump: a chop.
  for (const veg of vegetationIn(ctx.P)) {
    const pt = veg.plantByCollider(h.handle);
    if (!pt || !pt.wood) continue;
    const wood = pt.wood;
    if (!pt.record.broken) veg.chopTree(pt, { x, y, z, dx: m[0], dz: m[2], by: p.index, gain: (section, diameter, done, hard) => chopGain(spec, work, section, diameter, done, hard) });
    const bits = chopBits(work, wood);
    ctx.gore.timber.chop(veg.woodOf(pt), wood, x, y, z, h.nx, h.ny, h.nz, m[0], m[1], m[2], work, bits.chips, bits.bark, chipSize(work));
    return 'wood';
  }
  // A car: the edge skids off the panel with a spark.
  const car = ctx.vehicleByCollider.get(h.handle);
  if (car) {
    ctx.fx.spark(x, y, z, 5, 4);
    ctx.audio.play('tink', x, z, 0.5, { pitch: 1.2 });
    return 'metal';
  }
  // Something loose (a drum, a stack of tyres, a fallen top): it takes the edge's momentum where it was struck.
  const body = ctx.P.world.getCollider(h.handle)?.parent();
  if (body && body.isDynamic()) {
    const imp = spec.mass * spec.speed * Math.sqrt(work / bladeWork(spec)) * 0.7;
    body.applyImpulseAtPoint({ x: m[0] * imp, y: m[1] * imp, z: m[2] * imp }, { x, y, z }, true);
    const mat = ctx.P.surfaces.get(h.handle);
    if (mat === 'wood') ctx.gore.timber.chop(null, 'snag', x, y, z, h.nx, h.ny, h.nz, m[0], m[1], m[2], work, 3, 1, chipSize(work) * 0.8);
    else {
      ctx.fx.spark(x, y, z, 4, 3);
      ctx.audio.play('tink', x, z, 0.45, { pitch: 1.1 });
    }
    return mat === 'wood' ? 'wood' : 'metal';
  }
  // A box of the world: a barricade or a crate splinters, a wooden wall takes the blow, stone and steel throw sparks.
  let box: import('../world/layout').Aabb | null = null;
  ctx.obs.near(x, z, 0.8, (a) => {
    if (box || a.physOnly) return;
    if (x < a.minX - 0.1 || x > a.maxX + 0.1 || z < a.minZ - 0.1 || z > a.maxZ + 0.1 || y < a.y0 - 0.1 || y > a.y1 + 0.1) return;
    box = a;
  });
  const a = box as import('../world/layout').Aabb | null;
  if (a) {
    const wooden = a.kind === 'barricade' || a.kind === 'crate' || a.kind === 'furniture' || a.kind === 'dock' || a.mat === 'wood';
    if (wooden) {
      ctx.gore.timber.chop(null, 'snag', x, y, z, h.nx, h.ny, h.nz, m[0], m[1], m[2], work, 2 + Math.round(work / 25), 1, chipSize(work) * 0.9);
      if (ctx.world && (a.kind === 'barricade' || a.kind === 'partition')) ctx.world.hit(a, s.dmg * 0.6 * clamp(work / bladeWork(spec), 0.3, 1), 'bullet', { x, y, z, nx: h.nx, ny: h.ny, nz: h.nz });
      return 'wood';
    }
    if (a.mat === 'glass') return 'stone';
    ctx.fx.spark(x, y, z, 6, 4);
    ctx.fx.dust(x, y, z, h.nx * 0.6, h.nz * 0.6, 0.5);
    ctx.audio.play(a.kind === 'car' || a.mat === 'steel' || a.mat === 'sheet' ? 'tink' : 'chip', x, z, 0.5);
    return a.mat === 'steel' || a.mat === 'sheet' ? 'metal' : 'stone';
  }
  // The ground: the edge bites into it and throws up what it is made of.
  const g = ctx.groundAt(x, z);
  if (Math.abs(y - g) < 0.5 || h.ny > 0.6) {
    ctx.gore.groundStrike(s.model, ctx.surfaceAt(x, z).name, x, y, z, h.nx, h.ny, h.nz, m[0], m[1], m[2], 1);
    return 'ground';
  }
  ctx.fx.spark(x, y, z, 4, 3);
  ctx.audio.play('chip', x, z, 0.4);
  return 'stone';
}

/** For tests: forget every cut in progress on a body or a plant. */
export function forgetCuts(o: object) {
  CUTS.delete(o);
}

/** For tests and tools: the cuts in progress on a body or a plant. */
export const cutsOn = (o: object): readonly CutLine[] => CUTS.get(o) ?? [];
