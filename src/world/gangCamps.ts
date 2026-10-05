import { GANG_IDS, type GangId } from '../data';
import { Rng, hash2 } from '../core/rng';
import { rollPartSpec } from '../sim/parts';
import { partDef } from '../data';
import { heightAt, waterAt, type TerrainDef } from './terrain';
import { districtAt, nearestRoadAny } from './openWorld';
import type { Aabb, PickupSpawn, PropSpawn } from './layout';

/**
 * Gang camps: a raider gang's holdout in the open world. A camp is a ring of tents, tarped wrecks, barrels and torn
 * fence round a fire, with the gang's banners flying over it, a stash of loot and a handful of sentries. This file is
 * pure geometry and data: where camps go (`planFreeCamps`), what is standing in one (`dressGangCamp`), and which gang
 * holds which ground (`gangAt`). The sentries themselves are `game/gangCamps.ts`.
 */

export interface GangGuardSpot {
  kind: 'gunman' | 'sniper';
  x: number;
  z: number;
  /** How far from its post a gunman wanders while nobody is about. */
  patrol: number;
}

export interface GangCampSpec {
  id: string;
  gang: GangId;
  x: number;
  z: number;
  /** The fence ring. Sentries notice you somewhat beyond it. */
  radius: number;
  /** 1 near the start, 3 deep in the country: more guards and a richer stash. */
  tier: 1 | 2 | 3;
  guards: GangGuardSpot[];
  /** The way in, as an angle from +z toward +x. */
  gate: number;
}

const REGION = 1400;

/** The gang that holds a stretch of country: the map is cut into squares and each belongs to one of them. */
export function gangAt(seed: number, x: number, z: number): GangId {
  const h = hash2(Math.floor(x / REGION), Math.floor(z / REGION), seed ^ 0x6a4e);
  return GANG_IDS[Math.min(GANG_IDS.length - 1, Math.floor(h * GANG_IDS.length))];
}

/** How far into the country a point is, which decides how strong the camp there is. */
export function campTier(x: number, z: number): 1 | 2 | 3 {
  const reach = Math.hypot(x, z - 12);
  return reach < 1500 ? 1 : reach < 3000 ? 2 : 3;
}

/** The most gunmen and snipers a camp of this tier keeps. */
export function guardCount(tier: 1 | 2 | 3): { gunmen: number; snipers: number } {
  return { gunmen: 2 + tier, snipers: tier - 1 };
}

export function newCampSpec(seed: number, id: string, x: number, z: number, rng: Rng): GangCampSpec {
  const tier = campTier(x, z);
  const radius = 15 + tier * 2;
  const n = guardCount(tier);
  const guards: GangGuardSpot[] = [];
  for (let i = 0; i < n.gunmen; i++) {
    const a = (i / n.gunmen) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const r = rng.range(3, 7);
    guards.push({ kind: 'gunman', x: x + Math.sin(a) * r, z: z + Math.cos(a) * r, patrol: rng.range(2, 5) });
  }
  const gate = rng.range(0, Math.PI * 2);
  for (let i = 0; i < n.snipers; i++) {
    // Away from the gate, on the rim, looking out.
    const a = gate + Math.PI + (i === 0 ? -0.9 : 0.9) + rng.range(-0.2, 0.2);
    guards.push({ kind: 'sniper', x: x + Math.sin(a) * (radius - 2), z: z + Math.cos(a) * (radius - 2), patrol: 0 });
  }
  return { id, gang: gangAt(seed, x, z), x, z, radius, tier, guards, gate };
}

interface Plan {
  seed: number;
  rng: Rng;
  T: TerrainDef;
  taken: { x: number; z: number }[];
}

/** Is this open ground fit for a camp: dry, off the roads and out of the cities, and not on a slope? */
export function fitSpot(T: TerrainDef, x: number, z: number): boolean {
  const o = T.open;
  if (!o) return false;
  if (x < o.x0 + 260 || x > o.x1 - 260 || z < o.z0 + 260 || z > o.z1 - 260) return false;
  if (districtAt(o, x, z)) return false;
  const h0 = heightAt(T, x, z);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const px = x + Math.sin(a) * 18;
    const pz = z + Math.cos(a) * 18;
    if (waterAt(T, px, pz) || Math.abs(heightAt(T, px, pz) - h0) > 2.6) return false;
  }
  if (waterAt(T, x, z)) return false;
  return nearestRoadAny(o, x, z).d > 140;
}

/**
 * Camps standing on their own in the open country (the ones at roadside places are placed from the site list).
 * Deterministic from the seed, spaced well apart, and kept away from the start, Haven, cities and every place.
 */
export function planFreeCamps(T: TerrainDef, seed: number, want: number, existing: { x: number; z: number }[]): { x: number; z: number }[] {
  const o = T.open;
  if (!o) return [];
  const p: Plan = { seed, rng: new Rng(seed ^ 0x5ca9), T, taken: [...existing] };
  const out: { x: number; z: number }[] = [];
  for (let tries = 0; tries < 600 && out.length < want; tries++) {
    const x = p.rng.range(o.x0, o.x1);
    const z = p.rng.range(o.z0, o.z1);
    if (Math.hypot(x, z - 12) < 700) continue;
    if (Math.hypot(x - o.haven.x, z - o.haven.z) < 600) continue;
    if (T.sites.some((s) => s.radius > 0 && Math.hypot(s.x - x, s.z - z) < 140)) continue;
    if (p.taken.some((c) => Math.hypot(c.x - x, c.z - z) < 650)) continue;
    if (!fitSpot(T, x, z)) continue;
    p.taken.push({ x, z });
    out.push({ x, z });
  }
  return out;
}

export interface CampSink {
  props: PropSpawn[];
  pickups: PickupSpawn[];
  aabbs: Aabb[];
  id(prefix: string): string;
  aabbId(): number;
}

/** What is standing in a camp: tents, fire, stash, banners, fence, and the loot that lies by the stash. */
export function dressGangCamp(T: TerrainDef, spec: GangCampSpec, gangTag: number, out: CampSink) {
  const rng = new Rng(hash2(Math.round(spec.x), Math.round(spec.z), 0x9a17) * 4294967296);
  const R = spec.radius;
  const at = (a: number, r: number) => ({ x: spec.x + Math.sin(a) * r, z: spec.z + Math.cos(a) * r });
  const prop = (kind: PropSpawn['kind'], x: number, z: number, yaw: number, scale = 1, tag?: number, box?: number) => {
    const y = heightAt(T, x, z);
    out.props.push({ kind, x, y, z, yaw, scale, seed: rng.int(0, 9999), tag });
    if (box) out.aabbs.push({ id: out.aabbId(), minX: x - box, maxX: x + box, minZ: z - box, maxZ: z + box, y0: y - 0.5, y1: y + 1.4, kind: 'crate', hp: 99999 });
  };

  // The fire, with bones and a log seat or two beside it.
  prop('campfire', spec.x, spec.z, rng.range(0, 6.28));
  prop('bones', spec.x + 2.2, spec.z - 1.4, rng.range(0, 6.28));

  // Tents ring the fire; the stash sits on the far side from the gate.
  const stashA = spec.gate + Math.PI;
  const tents = 2 + spec.tier;
  for (let i = 0; i < tents; i++) {
    // Spread over the two arcs between the gate and the stash, none in the way of either.
    const side = i % 2 ? -1 : 1;
    const k = Math.floor(i / 2);
    const a = spec.gate + side * (0.9 + k * 0.75 + (i === tents - 1 && tents % 2 ? 0.2 : 0)) * (1 + k * 0.1);
    if (Math.abs(Math.sin((a - stashA) / 2)) < 0.38) continue;
    const p = at(a, R * 0.52);
    prop('tent', p.x, p.z, a + Math.PI, 1, gangTag, 1.7);
  }
  const stash = at(stashA, R * 0.3);
  prop('crateStack', stash.x, stash.z, stashA, 1.2, 2, 1.5);

  // A tarped wreck or two, barrels, tyres.
  for (let i = 0; i < spec.tier; i++) {
    const a = spec.gate + 2.2 + i * 1.9 + rng.range(-0.2, 0.2);
    const p = at(a, R * 0.8);
    prop('tarp', p.x, p.z, a + Math.PI / 2, 1, i % 2 ? 1 : 0, 1.7);
  }
  for (let i = 0; i < 4 + spec.tier; i++) {
    const a = rng.range(0, Math.PI * 2);
    const p = at(a, rng.range(R * 0.25, R * 0.7));
    prop(i % 3 === 2 ? 'tires' : 'barrel', p.x, p.z, rng.range(0, 6.28));
  }

  // The torn fence, with a gap at the gate, and the banners.
  const segs = 7 + spec.tier;
  for (let i = 0; i < segs; i++) {
    const a = spec.gate + ((i + 0.5) / segs) * Math.PI * 2;
    if (Math.abs(Math.sin((a - spec.gate) / 2)) < 0.2) continue;
    if (rng.chance(0.15)) continue;
    const p = at(a, R);
    prop('fence', p.x, p.z, a, 1);
  }
  for (const side of [-1, 1]) {
    const a = spec.gate + side * 0.34;
    const p = at(a, R + 0.5);
    prop('banner', p.x, p.z, spec.gate + Math.PI, 1.5, gangTag);
  }
  const back = at(stashA + 0.4, R * 0.9);
  prop('banner', back.x, back.z, stashA, 2, gangTag);

  // The stash: what the gang has been taking off the road. Hold A to take it, once the sentries are dealt with.
  const t = spec.tier;
  // Laid out in a ring round the crates, on open ground between them and the fire.
  const lootAt = (k: number) => {
    const a = (k / 8) * Math.PI * 2;
    return { x: stash.x + Math.sin(a) * 2.9, z: stash.z + Math.cos(a) * 2.9 };
  };
  const drop = (k: number, kind: PickupSpawn['kind'], amount: number, part?: PickupSpawn['part']) => {
    const p = lootAt(k);
    out.pickups.push({ id: out.id('gc'), kind, amount, part, x: p.x, z: p.z, y: heightAt(T, p.x, p.z), yaw: (k / 8) * Math.PI * 2, host: { kind: 'crateStack', mode: 'beside', context: 'gangStash' } });
  };
  drop(0, 'ammo', rng.int(14, 20) + t * 6);
  drop(1, 'medicine', rng.int(1, 2));
  drop(2, 'ammo', rng.int(8, 14) + t * 4);
  drop(3, 'rations', rng.int(3, 5) + t);
  drop(4, 'fuel', 5 + t * 2);
  if (t >= 2 || rng.chance(0.4)) drop(5, 'medicine', rng.int(1, 2) + (t >= 3 ? 1 : 0));
  if (t >= 2) drop(6, 'ammo', rng.int(8, 14) + t * 4);
  if (t >= 2 || rng.chance(0.35)) {
    const spec2 = rollPartSpec(rng, { minMk: t >= 3 ? 2 : 1, maxMk: t >= 3 ? 3 : 2 });
    drop(7, 'part', partDef(spec2.id).mk, spec2);
  }
}
