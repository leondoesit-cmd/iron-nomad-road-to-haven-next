import type { ZombieKind } from '../data';
import type { SiteBuilder } from './settlements';
import type { PropKind, ScavContainer, ScavZone } from './layout';
import { rollLoot, type LootContext, type LootTag } from '../sim/loot';
import { ENTRANCE_PROP, type DelveSite } from './delveSites';
import { lakeQ, lakeWater, type Island, type Lake } from './lakes';

/**
 * What stands on the shore and out in the water: the pier with its boathouse and flotsam, and the island places
 * (a castaway's shack, a wrecked trawler, a lighthouse, ruins, a cave). Built through the same `SiteBuilder` as the
 * roadside places, so shacks get real interiors and loot, and everything is deterministic from the leg seed.
 */

const WALKER: ZombieKind[] = ['walker', 'walker', 'runner'];
const TINTS = [0xb8b6ae, 0xa8a8a2, 0x9ea4a6, 0xa89880, 0x9aa8a0];

/** The lake and (for island sites) the island a site belongs to. */
function where(sb: SiteBuilder): { lake: Lake; isl: Island | null } {
  const lake = sb.def.lakes[sb.site.lake ?? 0];
  const isl = sb.site.island !== undefined ? lake.islands[sb.site.island] : null;
  return { lake, isl };
}

const onLand = (sb: SiteBuilder, x: number, z: number) => !lakeWater(sb.def.lakes, x, z);

/**
 * A scavenge zone with a few searchable containers, for loot that is not in a building. Each is a real thing standing
 * there (a locker, a stack of crates, a drum) holding named finds rolled from the context it is in.
 */
function lootZone(sb: SiteBuilder, tag: string, x: number, z: number, items: { dx: number; dz: number; label: string; context: LootContext; depth?: 0 | 1 | 2; prop?: PropKind; only?: LootTag[] }[], kind: ScavZone['kind'] = 'depot') {
  const base = `${sb.def.seed}:${sb.site.kind}${sb.site.lake ?? 0}${sb.site.island ?? ''}:${tag}`;
  const containers: ScavContainer[] = items.map((it, i) => {
    const cx = x + it.dx;
    const cz = z + it.dz;
    sb.prop(it.prop ?? 'crateStack', cx, cz, (i * 1.7 + sb.site.seed) % 6.28, 1, 2);
    const depth = it.depth ?? 0;
    return {
      id: `${base}:${i}`,
      x: cx,
      z: cz,
      depth,
      items: rollLoot(it.context, sb.site.seed * 31 + i * 977 + depth, depth, { progress: sb.reach, only: it.only }),
      taken: false,
      label: it.label,
      y: sb.g(cx, cz) + 0.9,
    };
  });
  sb.out.zones.push({ id: `${base}:z`, kind, x, z, w: 6, d: 6, open: 1, containers, pin: true });
}

/** Guard the dead: a cluster, with a brute on the harder legs. */
function guards(sb: SiteBuilder, x: number, z: number, n: number, spread: number, tier: number) {
  sb.zombies(x, z, n, spread, WALKER);
  if (tier >= 2 && sb.rng.chance(0.5 + tier * 0.1)) sb.zombies(x, z, 1, 2, ['brute']);
}

/** Debris along a shoreline ring: dead trees, rocks, bones, a washed-up tyre or barrel. Never in the water. */
function shoreClutter(sb: SiteBuilder, lake: Lake, n: number, qLo: number, qHi: number, avoid: { x: number; z: number; r: number }[] = []) {
  for (let i = 0; i < n * 3 && n > 0; i++) {
    const a = sb.rng.range(0, Math.PI * 2);
    const rr = lake.r * sb.rng.range(qLo, qHi) * (1 + 0.15 * sb.rng.next());
    const x = lake.x + Math.cos(a) * rr * lake.ax;
    const z = lake.z + Math.sin(a) * rr / lake.ax;
    const q = lakeQ(lake, x, z);
    if (q < qLo || q > qHi + 0.2 || !onLand(sb, x, z)) continue;
    if (avoid.some((v) => Math.hypot(v.x - x, v.z - z) < v.r)) continue;
    if (!sb.clearRoad(x - 2, x + 2, z - 2, z + 2, 8)) continue;
    sb.prop(sb.rng.pick(['deadTree', 'deadTree', 'rock', 'rock', 'bones', 'tires', 'barrel', 'cairn'] as const), x, z, sb.rng.range(0, 6.28), sb.rng.range(0.8, 1.3));
    n--;
  }
}

// ------------------------------------------------------------------------------------------------- the pier

function lakeDock(sb: SiteBuilder) {
  const { lake } = where(sb);
  const d = lake.dock;
  if (!d) return;
  const rng = sb.rng;
  const yaw = Math.atan2(d.dx, d.dz);
  sb.out.props.push({ kind: 'dock', x: d.shoreX, y: d.deckY, z: d.shoreZ, yaw, scale: 1, seed: lake.seed, tag: Math.round(d.len) });
  // The deck is physics only: people and vehicles stand on it, the dead and bullets pay it no mind.
  const deck = sb.solid('dock', (d.x0 + d.x1) / 2, (d.z0 + d.z1) / 2, d.x1 - d.x0, d.z1 - d.z0, 0.4);
  deck.y0 = d.deckY - 0.5;
  deck.y1 = d.deckY;
  deck.physOnly = true;
  // A boathouse on the beach, door toward the road, with its own floor plan, furniture and dead.
  const px = -d.dz;
  const pz = d.dx;
  const toRoad: 1 | -1 = sb.site.side > 0 ? -1 : 1;
  let placed = null as ReturnType<SiteBuilder['building']>;
  for (const back of [13, 17, 21, 26, 32]) {
    for (const lat of [8.5, -8.5, 12, -12]) {
      const cx = d.shoreX - d.dx * back + px * lat;
      const cz = d.shoreZ - d.dz * back + pz * lat;
      if (lakeQ(lake, cx, cz) < 1.22) continue;
      placed = sb.building(cx, cz, 7.5, 9, 1, 'shack', 0, rng.pick(TINTS), 'gable', { door: toRoad, margin: 3 });
      if (placed) break;
    }
    if (placed) break;
  }
  const avoid = [{ x: d.shoreX + d.dx * (d.len / 2), z: d.shoreZ + d.dz * (d.len / 2), r: d.len / 2 + 5 }];
  if (placed) avoid.push({ x: (placed.aabb.minX + placed.aabb.maxX) / 2, z: (placed.aabb.minZ + placed.aabb.maxZ) / 2, r: 8 });
  // A noticeboard, the odd barrel and a stack of crates at the root of the pier, with fuel and food stood beside them.
  sb.prop('sign', d.shoreX - d.dx * 4.5 + px * 4.2, d.shoreZ - d.dz * 4.5 + pz * 4.2, yaw + Math.PI, 1, 2);
  sb.prop('barrel', d.shoreX - d.dx * 5 - px * 3.4, d.shoreZ - d.dz * 5 - pz * 3.4, 0);
  sb.prop('crateStack', d.shoreX - d.dx * 1.6 + px * 2.6, d.shoreZ - d.dz * 1.6 + pz * 2.6, rng.range(0, 6), 1, 2);
  sb.besideProp('crateStack', 'cache', { only: ['fuel'] });
  if (rng.chance(0.6)) sb.besideProp('crateStack', 'shop', { only: ['food', 'water'] });
  sb.besideProp('barrel', 'garage', { only: ['oil', 'fuel'] });
  shoreClutter(sb, lake, 14, 1.12, 1.6, avoid);
  guards(sb, d.shoreX - d.dx * 12 + px * 6, d.shoreZ - d.dz * 12 + pz * 6, rng.int(2, 3), 6, 1);
  // Cargo left on the deck itself: a stack of crates, and what came off the boats stood beside it (never off the planking).
  for (const t of [0.35, 0.7]) {
    const x = d.shoreX + d.dx * d.len * t;
    const z = d.shoreZ + d.dz * d.len * t;
    sb.out.props.push({ kind: 'crateStack', x, y: d.deckY, z, yaw: rng.range(0, 6), scale: 0.9, seed: lake.seed + Math.round(t * 10), tag: 2 });
    sb.beside('crateStack', x, z, 1.4, 'cache', { y: d.deckY, within: { x0: d.x0, x1: d.x1, z0: d.z0, z1: d.z1 } });
  }
}

// ------------------------------------------------------------------------------------------------- islands

/** Unit vector from the island toward the end of the pier: the side a boat lands on. */
function beachDir(lake: Lake, isl: Island): [number, number] {
  const d = lake.dock;
  const tx = d ? d.shoreX + d.dx * d.len : lake.x;
  const tz = d ? d.shoreZ + d.dz * d.len : lake.z;
  const m = Math.hypot(tx - isl.x, tz - isl.z) || 1;
  return [(tx - isl.x) / m, (tz - isl.z) / m];
}

function islandShack(sb: SiteBuilder) {
  const { lake, isl } = where(sb);
  if (!isl) return;
  const rng = sb.rng;
  const [bx, bz] = beachDir(lake, isl);
  const door: 1 | -1 = bx >= 0 ? 1 : -1;
  let ok = null as ReturnType<SiteBuilder['building']>;
  for (const [ox, oz] of [[0, 0], [1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5]]) {
    const cx = isl.x + ox;
    const cz = isl.z + oz;
    if (![[-3, -3.5], [3, -3.5], [-3, 3.5], [3, 3.5]].every(([dx, dz]) => onLand(sb, cx + dx, cz + dz))) continue;
    ok = sb.building(cx, cz, 6, 7, 1, 'shack', 0, rng.pick(TINTS), 'gable', { door, margin: 1 });
    if (ok) break;
  }
  const lx = isl.x + bx * (isl.r * 0.55);
  const lz = isl.z + bz * (isl.r * 0.55);
  if (onLand(sb, lx, lz)) {
    sb.prop('barrel', lx + 2.4, lz - 1.6, 0);
    sb.besideProp('barrel', 'cache', { only: ['fuel', 'oil'] });
  }
  lootZone(sb, 'stash', isl.x - bx * (isl.r * 0.45), isl.z - bz * (isl.r * 0.45), [
    { dx: 0, dz: 0, label: 'the castaway’s stash', context: 'cache', depth: 1, prop: 'crateStack' },
  ]);
  sb.prop('bones', isl.x + bz * 3, isl.z - bx * 3, rng.range(0, 6));
  sb.prop('deadTree', isl.x - bx * 5, isl.z - bz * 5, rng.range(0, 6), 1.2);
  guards(sb, isl.x, isl.z, rng.int(2, 3), isl.r * 0.5, 1);
  void ok;
}

function islandWreck(sb: SiteBuilder) {
  const { lake, isl } = where(sb);
  if (!isl) return;
  const rng = sb.rng;
  const [bx, bz] = beachDir(lake, isl);
  // Lay the hull along the beach, on a cardinal axis so its collider is exact.
  const alongX = Math.abs(bz) > Math.abs(bx);
  const yaw = alongX ? Math.PI / 2 : 0;
  const cx = isl.x - bx * 1.5;
  const cz = isl.z - bz * 1.5;
  sb.out.props.push({ kind: 'shipwreck', x: cx, y: sb.g(cx, cz), z: cz, yaw, scale: 1, seed: sb.site.seed });
  sb.solid('rock', cx + (alongX ? 2 : 0), cz + (alongX ? 0 : 2), alongX ? 12 : 4.6, alongX ? 4.6 : 12, 3.5);
  const lx = alongX ? 1 : 0;
  const lz = alongX ? 0 : 1;
  lootZone(sb, 'hold', cx, cz, [
    { dx: -lx * 0 + lz * 3.4, dz: lx * 3.4, label: 'the hold', context: 'container', depth: 1, prop: 'crateStack' },
    { dx: -lz * 3.4 + lx * 3, dz: -lx * 3.4 + lz * 3, label: 'the captain’s locker', context: 'bunker', depth: 2, prop: 'locker' },
    { dx: lx * 5, dz: lz * 5, label: 'a fish crate', context: 'shop', depth: 0, prop: 'crateStack', only: ['food', 'water', 'fuel'] },
  ]);
  const px = isl.x + bx * (isl.r * 0.6);
  const pz = isl.z + bz * (isl.r * 0.6);
  if (onLand(sb, px, pz)) {
    sb.prop('crateStack', px + 2, pz + 1, rng.range(0, 6), 1, 2);
    sb.besideProp('crateStack', 'container');
  }
  sb.prop('bones', cx + bz * 6, cz - bx * 6, rng.range(0, 6));
  guards(sb, cx, cz, rng.int(3, 4), 5, 2);
}

function islandLighthouse(sb: SiteBuilder) {
  const { lake, isl } = where(sb);
  if (!isl) return;
  const rng = sb.rng;
  const [bx, bz] = beachDir(lake, isl);
  const yaw = Math.atan2(bx, bz);
  sb.out.props.push({ kind: 'lighthouse', x: isl.x, y: sb.g(isl.x, isl.z), z: isl.z, yaw, scale: 1, seed: sb.site.seed });
  sb.solid('tower', isl.x, isl.z, 7, 7, 26);
  const dx = isl.x + bx * 5;
  const dz = isl.z + bz * 5;
  lootZone(sb, 'keeper', dx, dz, [
    { dx: bz * 1.8, dz: -bx * 1.8, label: 'the keeper’s locker', context: 'bunker', depth: 2, prop: 'locker' },
    { dx: -bz * 1.8, dz: bx * 1.8, label: 'the oil store', context: 'garage', depth: 1, prop: 'barrel', only: ['oil', 'fuel'] },
  ]);
  sb.prop('crateStack', isl.x - bx * 6, isl.z - bz * 6, rng.range(0, 6), 1, 2);
  sb.besideProp('crateStack', 'garage', { only: ['radiator', 'gearbox', 'brake', 'exhaust'] });
  sb.prop('rock', isl.x + bz * 6, isl.z - bx * 6, rng.range(0, 6), 1.4);
  guards(sb, isl.x + bx * 7, isl.z + bz * 7, rng.int(2, 3), 4, 2);
}

function islandRuin(sb: SiteBuilder) {
  const { lake, isl } = where(sb);
  if (!isl) return;
  const rng = sb.rng;
  const [bx, bz] = beachDir(lake, isl);
  // A square of broken walls with a gap in the side that faces the landing.
  const h = 4.6;
  const t = 0.7;
  const wall = (x: number, z: number, w: number, d: number) => {
    if (onLand(sb, x, z) && onLand(sb, x + w / 2, z) && onLand(sb, x - w / 2, z)) sb.solid('wall', x, z, w, d, 2.6 + rng.range(0, 1.2));
  };
  for (const [nx, nz] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
    const along = nx === 0; // wall runs along x when its normal is z
    const landing = nx * bx + nz * bz > 0.7;
    const cx = isl.x + nx * h;
    const cz = isl.z + nz * h;
    if (landing) {
      for (const s of [-1, 1]) {
        const off = s * (h * 0.55 + 1.2);
        wall(cx + (along ? off : 0), cz + (along ? 0 : off), along ? h * 0.9 : t, along ? t : h * 0.9);
      }
    } else wall(cx, cz, along ? 2 * h : t, along ? t : 2 * h);
  }
  lootZone(sb, 'strongbox', isl.x, isl.z, [
    { dx: -1.2, dz: 0, label: 'the strongbox', context: 'warehouse', depth: 2, prop: 'crateStack' },
    { dx: 1.5, dz: 1.2, label: 'a sealed case', context: 'bunker', depth: 1, prop: 'locker' },
  ]);
  for (let i = 0; i < 4; i++) sb.prop(i % 2 ? 'bones' : 'rubble', isl.x + rng.range(-3.5, 3.5), isl.z + rng.range(-3.5, 3.5), rng.range(0, 6));
  sb.prop('cairn', isl.x + bx * 8, isl.z + bz * 8, 0);
  guards(sb, isl.x, isl.z, rng.int(3, 4), 3.5, 3);
  sb.zombies(isl.x, isl.z, 1, 2, ['bloater']);
}

// ------------------------------------------------------------------------------------------------- entrances

/** World rectangle of a local box under the entrance's cardinal yaw. */
function rect(ox: number, oz: number, yaw: number, lx0: number, lx1: number, lz0: number, lz1: number): { x: number; z: number; w: number; d: number } {
  const cs = Math.round(Math.cos(yaw));
  const sn = Math.round(Math.sin(yaw));
  // world.x = lx*cs + lz*sn ; world.z = -lx*sn + lz*cs
  const corner = (lx: number, lz: number): [number, number] => [ox + lx * cs + lz * sn, oz - lx * sn + lz * cs];
  const a = corner(lx0, lz0);
  const b = corner(lx1, lz1);
  return { x: (a[0] + b[0]) / 2, z: (a[1] + b[1]) / 2, w: Math.abs(a[0] - b[0]), d: Math.abs(a[1] - b[1]) };
}

const MASSES: Record<DelveSite['theme'], { boxes: [number, number, number, number, number][]; origin: number }> = {
  cave: { origin: 2.5, boxes: [[-8, -1.85, -9, 1.5, 7], [1.85, 8, -9, 1.5, 7], [-1.9, 1.9, -9, -1.5, 7]] },
  mine: { origin: 2.5, boxes: [[-9.6, -2.1, -9, 0.8, 7], [2.1, 9.6, -9, 0.8, 7], [-2.1, 2.1, -9, -1.9, 7]] },
  bunker: { origin: 3.0, boxes: [[-4.4, -1.45, -1, 0.9, 4.2], [1.45, 4.4, -1, 0.9, 4.2], [-8, 8, -10, -1, 4.5], [-1.45, 1.45, -10, -0.4, 4.2]] },
  metro: { origin: 3.0, boxes: [[-2.9, -1.4, -5, 0.4, 3.6], [1.4, 2.9, -5, 0.4, 3.6], [-1.4, 1.4, -5, -1.6, 3.6]] },
};

/** A way underground: the entrance model, its rock or concrete as colliders, a ration cache and the dead who guard it. */
export function delveEntrance(sb: SiteBuilder, delve: DelveSite) {
  const rng = sb.rng;
  const m = MASSES[delve.theme];
  const fx = Math.round(Math.sin(delve.yaw));
  const fz = Math.round(Math.cos(delve.yaw));
  const ox = delve.x - fx * m.origin;
  const oz = delve.z - fz * m.origin;
  sb.out.props.push({ kind: ENTRANCE_PROP[delve.theme], x: ox, y: sb.g(ox, oz), z: oz, yaw: delve.yaw, scale: 1, seed: delve.seed });
  for (const [x0, x1, z0, z1, h] of m.boxes) {
    const r = rect(ox, oz, delve.yaw, x0, x1, z0, z1);
    // 'rock', not 'wall': walls are drawn as ruined brick by the chunk view, and the entrance prop is the model here.
    sb.solid('rock', r.x, r.z, r.w, r.d, h);
  }
  // Provisions left at the threshold, and the dead who followed the last party in.
  const px = -fz;
  const pz = fx;
  const gx = delve.x + fx * 4;
  const gz = delve.z + fz * 4;
  sb.prop('barrel', gx + px * 4, gz + pz * 4, 0);
  sb.prop('crateStack', gx - px * 3, gz - pz * 3, rng.range(0, 6), 1, 2);
  sb.besideProp('crateStack', delve.theme === 'bunker' ? 'bunker' : 'cache', { only: ['ammo', 'med'] });
  if (rng.chance(0.7)) sb.besideProp('barrel', 'cache', { only: ['fuel', 'oil', 'water'] });
  sb.prop('bones', gx - px * 3.5, gz - pz * 3.5, rng.range(0, 6));
  guards(sb, delve.x + fx * 11, delve.z + fz * 11, 2 + delve.tier, 6, delve.tier);
}

export function lakeSite(sb: SiteBuilder) {
  switch (sb.site.kind) {
    case 'lakeDock':
      return lakeDock(sb);
    case 'islandShack':
      return islandShack(sb);
    case 'islandWreck':
      return islandWreck(sb);
    case 'islandLighthouse':
      return islandLighthouse(sb);
    case 'islandRuin':
      return islandRuin(sb);
    case 'islandCave':
    case 'delveCave':
    case 'delveMine':
    case 'delveBunker': {
      const delve = sb.def.delves.find((v) => v.id === sb.site.delve);
      if (delve) delveEntrance(sb, delve);
      return;
    }
  }
}
