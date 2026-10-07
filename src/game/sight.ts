import { G, groups, type Collider, type RigidBody } from '../physics/physics';
import type { Ctx } from './ctx';
import type { Player } from './player';
import type { Vehicle } from './vehicle';

/**
 * What a raider's eye can make out of someone: the engine half of `sim/enemySight.ts`. A line is drawn from the eye to the
 * person's head, chest and hips; each one counts for the share of them it is, if nothing solid crosses the line (the ground,
 * a wall, a rock, a trunk, a car) and as much of it as the leaves between let through (a bush, a reed bed, cane).
 */

/** What hides a person: the ground, buildings, rock, wood and cars. People, loose drums and sensors do not. */
const SIGHT_FILTER = groups(0xffff, G.STATIC | G.BUILD | G.FURN | G.VEHICLE);
/** A vehicle is hidden only by the world itself, not by another car beside it. */
const WORLD_FILTER = groups(0xffff, G.STATIC | G.BUILD | G.FURN);

/** Head, chest and hips: heights above the feet standing and crouched, and how much of a person each one is. */
const PARTS = [
  { stand: 1.6, crouch: 1.12, w: 0.3 },
  { stand: 1.22, crouch: 0.8, w: 0.45 },
  { stand: 0.85, crouch: 0.48, w: 0.25 },
] as const;
/** A swimmer afloat shows a head above the water (feet hang 1.2 m under it). */
const SWIM_HEAD = 1.4;
/** Inside this (m) leaves hide nobody; they hide fully from this far on. */
const LEAF_NEAR = 2;
const LEAF_FULL = 6;

export interface Showing {
  /** 0 hidden to 1 in the open. */
  show: number;
  /** Height to aim at: the most of them that shows. */
  aimY: number;
}

const clearTo = (ctx: Ctx, ex: number, ey: number, ez: number, x: number, y: number, z: number, filter: number, exclude?: RigidBody, slack = 0.3) => {
  const dx = x - ex;
  const dy = y - ey;
  const dz = z - ez;
  const l = Math.hypot(dx, dy, dz);
  if (l < 0.05) return true;
  const hit = ctx.P.raycast(ex, ey, ez, dx / l, dy / l, dz / l, l, filter, exclude, see);
  return !hit || hit.toi >= l - slack;
};

/** Glass and sensors are no cover. */
let surfaces: Map<number, string> | null = null;
const see = (c: Collider) => !c.isSensor() && surfaces?.get(c.handle) !== 'glass';

/** How much of a person on foot shows to an eye at (ex, ey, ez), and where to aim. `exclude` is the looker's own vehicle. */
export function playerShows(ctx: Ctx, ex: number, ey: number, ez: number, p: Player, exclude?: RigidBody): Showing {
  surfaces = ctx.P.surfaces;
  const d = Math.hypot(p.pos.x - ex, p.pos.z - ez);
  if (p.underwater) return { show: 0, aimY: p.pos.y + SWIM_HEAD };
  const leafK = Math.min(1, Math.max(0, (d - LEAF_NEAR) / (LEAF_FULL - LEAF_NEAR)));
  let show = 0;
  let aimY = p.pos.y + (p.crouch ? PARTS[1].crouch : PARTS[1].stand);
  let best = 0;
  const parts = p.swimming ? [{ y: SWIM_HEAD, w: 0.5 }] : PARTS.map((q) => ({ y: p.crouch ? q.crouch : q.stand, w: q.w }));
  for (const part of parts) {
    const y = p.pos.y + part.y;
    if (!clearTo(ctx, ex, ey, ez, p.pos.x, y, p.pos.z, SIGHT_FILTER, exclude)) continue;
    const leaves = leafK > 0 && ctx.leavesAlong ? ctx.leavesAlong(ex, ey, ez, p.pos.x, y, p.pos.z) * leafK : 0;
    const s = part.w * (1 - leaves);
    show += s;
    if (s > best) {
      best = s;
      aimY = y;
    }
  }
  return { show, aimY };
}

/** Is a vehicle in sight of an eye: a clear line to its cabin or its roof past the ground, walls and rock. */
export function vehicleShows(ctx: Ctx, ex: number, ey: number, ez: number, v: Vehicle): boolean {
  surfaces = ctx.P.surfaces;
  const p = v.position;
  for (const h of [0.8, 1.6]) if (clearTo(ctx, ex, ey, ez, p.x, p.y + h, p.z, WORLD_FILTER, undefined, v.def.length * 0.5 + 0.3)) return true;
  return false;
}
