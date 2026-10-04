import type { LegDef } from '../data';
import { Rng, fbm2, hash2, noise2 } from '../core/rng';
import { clamp, smoothstep, lerp } from '../core/math';
import { dockDeckAt, lakeAdjust, lakeWater, planLakeSites, planLakes, planOpenLakes, type Bay, type Lake, type WaterHit } from './lakes';
import { delveName, delveSiteKind, planMainlandDelve, snapYaw, type DelveSite, type DelveTheme } from './delveSites';
import { addRoad, districtAt, districtMask, makeOpenWorld, nearestRoad, nearestRoadAny, type OpenWorld, type RoadPath } from './openWorld';

export const CHUNK = 128;
export const CELL = 2; // heightfield resolution in metres
export const CELLS = CHUNK / CELL; // 64

export type Surface = 'asphalt' | 'hardpan' | 'sand' | 'mud';

export interface Ramp {
  z0: number;
  len: number;
  xOff: number;
  halfWidth: number;
  height: number;
  /** Gap between the lip and the plateau. */
  gap: number;
  plateauLen: number;
  plateauHalfWidth: number;
}

export interface Canyon {
  z0: number;
  z1: number;
  halfWidth: number;
}

export interface Minefield {
  z0: number;
  z1: number;
  halfWidth: number;
}

export type SiteKind =
  | 'gasStop'
  | 'hamlet'
  | 'motel'
  | 'farm'
  | 'depot'
  | 'overpass'
  | 'windfarm'
  | 'mastHill'
  // The two named hubs of the open world.
  | 'hubDustwell'
  | 'hubRustgate'
  | 'hubHaven'
  // A lot in a city turned into a trade (see `LegLayoutImpl.addZone`).
  | 'cityLot'
  // Lakeside places and the ways underground (see world/lakes.ts, world/delveSites.ts).
  | 'lakeDock'
  | 'islandShack'
  | 'islandWreck'
  | 'islandLighthouse'
  | 'islandRuin'
  | 'islandCave'
  | 'delveCave'
  | 'delveMine'
  | 'delveBunker';

/** A roadside place worth stopping at (wasteland only). The terrain flattens a pad under it. */
export interface Site {
  kind: SiteKind;
  z: number;
  /** Side of the road it sits on: -1 or 1. */
  side: -1 | 1;
  /** Distance of its centre from the road centre-line. */
  off: number;
  /** Radius of the flattened ground. 0 means the terrain is left alone. */
  radius: number;
  seed: number;
  x: number;
  /** Lake places: which lake, and which of its islands. Delve entrances: the delve's id. */
  lake?: number;
  island?: number;
  delve?: string;
  /** Ground height of the flattened pad. Highway sites leave it out and take the road's own height. */
  h?: number;
}

/** Level ground under a building, so its floor sits flush with the terrain. */
export interface Foundation {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  h: number;
}

export interface TerrainDef {
  biome: 'wasteland' | 'city';
  seed: number;
  length: number;
  /** The playable ground ends here along z (mountains beyond). A corridor leg is walled just outside its two ends. */
  zMin: number;
  zMax: number;
  roadHalf: number;
  /** Present on the open-world leg: its roads, districts and edges. */
  open?: OpenWorld;
  ramps: Ramp[];
  canyons: Canyon[];
  minefields: Minefield[];
  phase: [number, number, number, number];
  sites: Site[];
  foundations: Foundation[];
  /** Lakes (wasteland only) with their islands and docks, and the bays that widen the corridor around them. */
  lakes: Lake[];
  bays: Bay[];
  /** Ways underground in the open country and on lake islands. */
  delves: DelveSite[];
  theme: 'dust' | 'salt' | 'cinder';
  /** Planned city legs: the paved side and cross streets (rectangles) beyond the boulevard. */
  streets?: { x0: number; x1: number; z0: number; z1: number }[];
}

export function makeTerrainDef(leg: LegDef): TerrainDef {
  const rng = new Rng(leg.seed);
  const def: TerrainDef = {
    biome: leg.biome,
    seed: leg.seed,
    length: leg.length,
    zMin: leg.open ? leg.open.zMin : -60,
    zMax: leg.open ? leg.open.zMax : leg.length + 160,
    roadHalf: leg.biome === 'city' ? 7 : leg.open ? 7 : 4.2,
    ramps: [],
    canyons: [],
    minefields: [],
    phase: [rng.range(0, 6.28), rng.range(0, 6.28), rng.range(0, 6.28), rng.range(0, 6.28)],
    sites: [],
    foundations: [],
    lakes: [],
    bays: [],
    delves: [],
    theme: leg.theme ?? 'dust',
  };
  if (leg.open) makeOpenWorld(def, leg);
  for (const s of leg.sets) {
    if (s.type === 'rampCache') {
      def.ramps.push({
        z0: s.at,
        len: 26,
        xOff: rng.range(-10, 10),
        halfWidth: 5.5,
        height: 2.7,
        gap: 12,
        plateauLen: 26,
        plateauHalfWidth: 10,
      });
    } else if (s.type === 'canyonAmbush') {
      def.canyons.push({ z0: s.at - 150, z1: s.at + 190, halfWidth: 38 });
    } else if (s.type === 'minefield') {
      def.minefields.push({ z0: s.at, z1: s.at + (s.length as number), halfWidth: 20 });
    }
  }
  if (leg.biome === 'wasteland') {
    if (def.open) def.sites = planHubs(def);
    def.sites.push(...planSites(def, leg));
    def.lakes = planLakes(def, leg).lakes;
    if (def.open) def.lakes.push(...planOpenLakes(def, leg, def.lakes));
    const open = def.open ? planOpenSites(def, leg) : null;
    if (open) {
      def.sites.push(...open.sites);
      def.delves.push(...open.delves);
    }
    const lakeSites = planLakeSites(def, leg);
    def.sites.push(...lakeSites.sites);
    def.delves.push(...lakeSites.delves);
    const main = planMainlandDelve(def, leg);
    if (main) {
      def.sites.push(main.site);
      def.delves.push(main.delve);
    }
  }
  return def;
}

const SITE_ROTATION: SiteKind[] = ['gasStop', 'hamlet', 'windfarm', 'motel', 'farm', 'overpass', 'depot', 'mastHill'];
const SITE_SPEC: Record<SiteKind, { off: [number, number]; radius: number }> = {
  gasStop: { off: [22, 28], radius: 36 },
  hamlet: { off: [48, 62], radius: 58 },
  motel: { off: [32, 38], radius: 46 },
  farm: { off: [66, 82], radius: 64 },
  depot: { off: [52, 64], radius: 62 },
  overpass: { off: [0, 0], radius: 34 },
  windfarm: { off: [90, 130], radius: 0 },
  mastHill: { off: [60, 90], radius: 26 },
  hubDustwell: { off: [0, 0], radius: 62 },
  hubRustgate: { off: [0, 0], radius: 72 },
  hubHaven: { off: [0, 0], radius: 84 },
  cityLot: { off: [0, 0], radius: 0 },
  lakeDock: { off: [0, 0], radius: 0 },
  islandShack: { off: [0, 0], radius: 0 },
  islandWreck: { off: [0, 0], radius: 0 },
  islandLighthouse: { off: [0, 0], radius: 0 },
  islandRuin: { off: [0, 0], radius: 0 },
  islandCave: { off: [0, 0], radius: 0 },
  delveCave: { off: [0, 0], radius: 26 },
  delveMine: { off: [0, 0], radius: 26 },
  delveBunker: { off: [0, 0], radius: 26 },
};

/** True where nothing authored (set pieces, canyons) claims the stretch of road around z. */
export function keepOutZ(def: TerrainDef, leg: LegDef): (z: number) => boolean {
  const keepOut: [number, number][] = [];
  const ext: Record<string, number> = { fuelCache: 60, scrapPile: 70, partsWreck: 100, rampCache: 130, encounter: 20, radioFragment: 20, chassisWreck: 20, ambush: 20 };
  for (const s of leg.sets) {
    const len = s.type === 'minefield' ? (s.length as number) : (ext[s.type] ?? 0);
    keepOut.push([s.at - 60, s.at + len + 60]);
  }
  const cities = def.open ? def.open.districts : [];
  for (const h of def.open?.hubs ?? []) keepOut.push([h.z - 130, h.z + 130]);
  if (def.open) keepOut.push([def.open.haven.z - 160, def.open.haven.z + 160]);
  return (z) => !keepOut.some(([a, b]) => z > a && z < b) && !def.canyons.some((c) => z > c.z0 - 90 && z < c.z1 + 90) && !cities.some((d) => z > d.z0 - 120 && z < d.z1 + 120);
}

/** The named hubs sit beside the highway where the cross roads meet it. */
function planHubs(def: TerrainDef): Site[] {
  const out: Site[] = [];
  const rng = new Rng(def.seed * 17 + 5);
  for (const h of def.open!.hubs) {
    const kind: SiteKind = h.id === 'dustwell' ? 'hubDustwell' : 'hubRustgate';
    const rx = roadX(def, h.z);
    out.push({ kind, z: h.z, side: h.x > rx ? 1 : -1, off: Math.abs(h.x - rx), radius: SITE_SPEC[kind].radius, seed: rng.int(1, 99999), x: h.x });
  }
  const hv = def.open!.haven;
  const rx = roadX(def, hv.z);
  out.push({ kind: 'hubHaven', z: hv.z, side: hv.x > rx ? 1 : -1, off: Math.abs(hv.x - rx), radius: SITE_SPEC.hubHaven.radius, seed: rng.int(1, 99999), x: hv.x });
  return out;
}

const FAR_ROTATION: SiteKind[] = ['hamlet', 'farm', 'depot', 'mastHill', 'farm', 'motel', 'hamlet', 'gasStop', 'depot'];

/**
 * Places scattered over the whole map, away from the highway: one candidate per 400 m square. Each gets a dirt track
 * to the nearest road. A few of them are ways underground instead.
 */
function planOpenSites(def: TerrainDef, leg: LegDef): { sites: Site[]; delves: DelveSite[] } {
  const o = def.open!;
  const rng = new Rng(leg.seed * 43 + 11);
  const sites: Site[] = [];
  const delves: DelveSite[] = [];
  const STEP = 400;
  let k = Math.floor(rng.range(0, FAR_ROTATION.length));
  let nd = 0;
  const near = (x: number, z: number, d: number) => (s: { x: number; z: number; radius?: number }) => Math.hypot(s.x - x, s.z - z) < d + (s.radius ?? 0);
  for (let i = Math.floor((o.x0 + 260) / STEP); i <= Math.floor((o.x1 - 260) / STEP); i++) {
    for (let j = Math.floor((o.z0 + 260) / STEP); j <= Math.floor((o.z1 - 360) / STEP); j++) {
      if (rng.next() > 0.46) continue;
      const x = (i + rng.range(0.15, 0.85)) * STEP;
      const z = (j + rng.range(0.15, 0.85)) * STEP;
      if (Math.abs(x) > o.x1 - 260 || z < o.z0 + 260 || z > o.z1 - 360 || Math.abs(x - roadX(def, z)) < 150 || Math.hypot(x, z - 12) < 260 || Math.hypot(x - o.haven.x, z - o.haven.z) < 320) continue;
      // Well clear of every district's rectangle.
      if (o.districts.some((d) => Math.hypot(Math.max(d.x0 - x, 0, x - d.x1), Math.max(d.z0 - z, 0, z - d.z1)) < 150)) continue;
      const wantDelve = rng.next() < 0.16;
      const kind: SiteKind = wantDelve ? 'delveMine' : FAR_ROTATION[k++ % FAR_ROTATION.length];
      const radius = SITE_SPEC[kind].radius;
      if (def.sites.some(near(x, z, radius + 90)) || sites.some(near(x, z, radius + 160))) continue;
      if (def.lakes.some((l) => Math.hypot(l.x - x, l.z - z) < l.reach + radius + 50)) continue;
      if (buttes(def, x, z) > 0.5 || buttes(def, x + radius, z) > 0.5 || buttes(def, x - radius, z) > 0.5) continue;
      // The track to the nearest road must not run through a lake.
      const hit = nearestRoadAny(o, x, z);
      const tx = hit.px;
      const tz = hit.pz;
      const reach = hit.d;
      if (reach > 1500) continue;
      let wet = false;
      for (let u = 0; u <= 1 && !wet; u += 0.04) wet = def.lakes.some((l) => Math.hypot(l.x - (x + (tx - x) * u), l.z - (z + (tz - z) * u)) < l.reach + 12);
      if (wet) continue;
      const h = baseHeight(def, x, z);
      const seed = rng.int(1, 99999);
      if (wantDelve) {
        const theme: DelveTheme = (['mine', 'cave', 'bunker'] as const)[nd % 3];
        const id = `${leg.id}:m${nd++}`;
        const yaw = snapYaw(Math.atan2(tx - x, tz - z));
        delves.push({ id, theme, x, z, yaw, seed, name: delveName(theme, seed), tier: Math.min(3, leg.index + 1), island: false });
        sites.push({ kind: delveSiteKind(theme), z, side: x > tx ? 1 : -1, off: reach, radius: 26, seed, x, delve: id, h });
      } else sites.push({ kind, z, side: x > tx ? 1 : -1, off: reach, radius, seed, x, h });
      // A winding track, from the edge of the pad to the road.
      const len = Math.hypot(tx - x, tz - z);
      const n = Math.max(2, Math.ceil(len / 12));
      const p1 = rng.range(0, 6.28);
      const nxn = -(tz - z) / len;
      const nzn = (tx - x) / len;
      const pts: number[] = [];
      for (let q = 0; q <= n; q++) {
        const u = q / n;
        const off = Math.sin(Math.PI * u) ** 0.7 * Math.min(60, len * 0.2) * Math.sin(u * len / 150 + p1);
        pts.push(x + (tx - x) * u + nxn * off, z + (tz - z) * u + nzn * off);
      }
      addRoad(o, { id: `track${sites.length}`, kind: 'track', half: 2.6, pts });
    }
  }
  return { sites, delves };
}

/** Where roadside places go: spaced along the leg, clear of the authored set pieces. */
function planSites(def: TerrainDef, leg: LegDef): Site[] {
  const rng = new Rng(leg.seed * 31 + 5);
  const free = keepOutZ(def, leg);
  const sites: Site[] = [];
  let z = rng.range(240, 340);
  let k = Math.floor(rng.range(0, SITE_ROTATION.length));
  while (z < leg.length - 220) {
    let zz = z;
    for (let t = 0; t < 8 && !free(zz); t++) zz += 55;
    if (free(zz) && zz < leg.length - 220) {
      const kind = SITE_ROTATION[k % SITE_ROTATION.length];
      k++;
      const spec = SITE_SPEC[kind];
      const side = rng.sign();
      const ch = corridorHalf(def, zz);
      const off = Math.min(rng.range(spec.off[0], spec.off[1]), ch - spec.radius - (spec.radius ? 25 : 30));
      if (off >= spec.off[0] * 0.6) {
        const x = roadX(def, zz) + side * off;
        sites.push({ kind, z: zz, side, off, radius: spec.radius, seed: rng.int(1, 99999), x });
      }
    }
    z = zz + rng.range(260, 400);
  }
  return sites;
}

/** 0 in the narrow, craggy stretches, 1 in the wide basins where the cliffs stand back and the horizon opens. */
export function openness(def: TerrainDef, z: number): number {
  if (def.biome === 'city') return 0;
  if (def.open) return 1;
  const [p1, p2] = def.phase;
  return smoothstep(-0.45, 0.4, 0.62 * Math.sin(z / 260 + p1 * 3) + 0.38 * Math.sin(z / 131 + p2 * 5));
}

/** 0 on the hard flats, 1 in the rolling dune seas. */
export function duneness(def: TerrainDef, z: number, x?: number): number {
  if (def.biome === 'city') return 0;
  const [, , p3, p4] = def.phase;
  // In the open world dune seas are patches on the map, not bands across the road.
  if (def.open && x !== undefined) return smoothstep(0.05, 0.62, noise2(x / 520 + 31, z / 520 - 17, def.seed + 211) * 0.75 + noise2(x / 190, z / 190 + 9, def.seed + 212) * 0.25);
  return smoothstep(-0.05, 0.6, 0.62 * Math.sin(z / 250 + p3 * 2) + 0.38 * Math.sin(z / 97 + p4 * 3));
}

/** Road centre-line x for a given z. Straight in cities, winding in the wastelands. */
export function roadX(def: TerrainDef, z: number): number {
  if (def.biome === 'city') return 0;
  const lead = smoothstep(0, 260, z);
  const [p1, p2] = def.phase;
  return (1 - cityBump(def, z)) * lead * (46 * Math.sin(z / 330 + p1) + 20 * Math.sin(z / 141 + p2));
}

/** 1 while the highway runs through a city district (dead straight and level), easing in and out over 200 m. */
function cityBump(def: TerrainDef, z: number): number {
  const o = def.open;
  if (!o || !o.districts.length) return 0;
  let b = 0;
  for (const d of o.districts) b = Math.max(b, smoothstep(d.z0 - 200, d.z0, z) * (1 - smoothstep(d.z1, d.z1 + 200, z)));
  return b;
}

/** dx/dz of the road, for heading. */
export function roadSlope(def: TerrainDef, z: number): number {
  return (roadX(def, z + 1) - roadX(def, z - 1)) / 2;
}

export function roadElev(def: TerrainDef, z: number): number {
  if (def.biome === 'city') return 0;
  const lead = smoothstep(0, 200, z);
  const [, , p3, p4] = def.phase;
  return (1 - cityBump(def, z)) * lead * (6 * Math.sin(z / 470 + p3) + 1.8 * Math.sin(z / 173 + p4));
}

/** Half-width of the open corridor at z: the wasteland is wide, canyons squeeze it. */
export function corridorHalf(def: TerrainDef, z: number): number {
  // The open world has no corridor: the mountains stand at the edge of the map.
  if (def.open) return def.open.x1;
  let w = def.biome === 'city' ? 150 : lerp(190, 460, openness(def, z));
  for (const c of def.canyons) {
    const t = smoothstep(c.z0, c.z0 + 70, z) * (1 - smoothstep(c.z1 - 70, c.z1, z));
    if (t > 0) w = lerp(w, c.halfWidth + 6 * Math.sin(z / 23) + 4 * Math.sin(z / 9.7), t);
  }
  // Bays stand the cliffs back around a lake.
  for (const b of def.bays) {
    const t = smoothstep(b.z0, b.z0 + 90, z) * (1 - smoothstep(b.z1 - 90, b.z1, z));
    if (t > 0 && b.half > w) w = lerp(w, b.half, t);
  }
  return w;
}

/** Flat-topped mesas standing in the open country. They keep clear of the road and of any roadside site. */
export function buttes(def: TerrainDef, x: number, z: number): number {
  if (def.biome === 'city') return 0;
  if (def.open) return openButtes(def, x, z);
  const STEP = 190;
  const i0 = Math.floor(z / STEP);
  let out = 0;
  for (let i = i0 - 1; i <= i0 + 1; i++) {
    const k = hash2(i, 1, def.seed + 95);
    if (k > 0.62) continue;
    const zc = (i + 0.2 + hash2(i, 2, def.seed + 96) * 0.6) * STEP;
    const ch = corridorHalf(def, zc);
    if (ch < 220) continue;
    const r = 16 + hash2(i, 3, def.seed + 97) * 26;
    const side = hash2(i, 4, def.seed + 98) < 0.5 ? -1 : 1;
    const off = 120 + hash2(i, 5, def.seed + 99) * Math.max(0, ch - 120 - r - 25);
    const xc = roadX(def, zc) + side * off;
    const dd = Math.hypot(x - xc, z - zc);
    if (dd > r * 1.1) continue;
    if (def.sites.some((s) => Math.hypot(s.x - xc, s.z - zc) < s.radius + r + 20)) continue;
    const H = 10 + hash2(i, 6, def.seed + 100) * 30;
    const t = smoothstep(r, r * 0.6, dd);
    out = Math.max(out, H * t * (1 - 0.1 * noise2(x / 6, z / 6, def.seed + 101)));
  }
  return out;
}

/** Mesas scattered over the map on a jittered grid, clear of roads, places and the cities. */
function openButtes(def: TerrainDef, x: number, z: number): number {
  const o = def.open!;
  const STEP = 340;
  const i0 = Math.floor(x / STEP);
  const j0 = Math.floor(z / STEP);
  let out = 0;
  for (let i = i0 - 1; i <= i0 + 1; i++) {
    for (let j = j0 - 1; j <= j0 + 1; j++) {
      if (hash2(i, j, def.seed + 95) > 0.34) continue;
      const xc = (i + 0.2 + hash2(i, j, def.seed + 96) * 0.6) * STEP;
      const zc = (j + 0.2 + hash2(i, j, def.seed + 97) * 0.6) * STEP;
      const r = 16 + hash2(i, j, def.seed + 98) * 28;
      const dd = Math.hypot(x - xc, z - zc);
      if (dd > r * 1.1) continue;
      if (Math.abs(xc - roadX(def, zc)) < 110 || districtMask(o, xc, zc) > 0 || zc < o.z0 + 200 || zc > o.z1 - 200 || Math.abs(xc) > o.x1 - 300) continue;
      if (Math.hypot(xc, zc - 12) < 160) continue;
      if (nearestRoad(o, xc, zc).d < 70) continue;
      if (def.sites.some((s) => Math.hypot(s.x - xc, s.z - zc) < s.radius + r + 20)) continue;
      const H = 10 + hash2(i, j, def.seed + 100) * 30;
      const t = smoothstep(r, r * 0.6, dd);
      out = Math.max(out, H * t * (1 - 0.1 * noise2(x / 6, z / 6, def.seed + 101)));
    }
  }
  return out;
}

function rampHeight(r: Ramp, rx: number, z: number, xc: number): number {
  const u = (z - r.z0) / r.len;
  const dx = Math.abs(rx - xc);
  let h = 0;
  if (u >= 0 && u <= 1) {
    const s = smoothstep(r.halfWidth, r.halfWidth * 0.55, dx);
    h = r.height * Math.pow(u, 1.15) * s;
  } else if (u > 1) {
    // Sharp lip drop over about 6 m.
    const s = smoothstep(r.halfWidth, r.halfWidth * 0.55, dx);
    h = r.height * s * Math.max(0, 1 - ((u - 1) * r.len) / 6);
  }
  // Raised plateau holding the cache. It slopes down gently at the back so slower vehicles can still reach it.
  const pz0 = r.z0 + r.len + r.gap;
  const pz1 = pz0 + r.plateauLen;
  const pz2 = pz1 + 30;
  if (z >= pz0 - 3 && z <= pz2) {
    const lat = smoothstep(r.plateauHalfWidth + 3, r.plateauHalfWidth - 2, dx);
    const front = smoothstep(pz0 - 3, pz0 + 2, z);
    const back = 1 - smoothstep(pz1, pz2, z);
    h = Math.max(h, (r.height - 0.2) * lat * front * back);
  }
  return h;
}

/** Terrain height under (x, z). The same function drives meshes, colliders, props and AI. */
export function heightAt(def: TerrainDef, x: number, z: number): number {
  const h = baseHeight(def, x, z);
  if (def.lakes.length === 0) return h;
  for (const l of def.lakes) {
    // Lakes are far apart, so at most one of them reshapes any given point.
    const a = lakeAdjust(l, x, z, h);
    if (a === h) continue;
    // A building on a lake island still gets its level pad (the lake replaced the ground the pad was cut into).
    let out = a;
    for (const f of def.foundations) {
      if (z < f.z0 - 3.5 || z > f.z1 + 3.5 || x < f.x0 - 3.5 || x > f.x1 + 3.5) continue;
      const d = Math.hypot(Math.max(f.x0 - x, 0, x - f.x1), Math.max(f.z0 - z, 0, z - f.z1));
      out += (f.h - out) * (1 - smoothstep(0, 3.5, d));
    }
    return out;
  }
  return h;
}

/** The ground before any lake is carved into it. */
export function baseHeight(def: TerrainDef, x: number, z: number): number {
  const rx = roadX(def, z);
  const re = roadElev(def, z);
  if (def.biome === 'city') {
    // Flat, with tall outer walls of rubble beyond the corridor.
    const d = Math.abs(x - rx);
    const wall = smoothstep(corridorHalf(def, z), corridorHalf(def, z) + 10, d);
    return wall * 40;
  }
  const dx = x - rx;
  const d = Math.abs(dx);
  let h: number;
  if (def.open) h = openGround(def, x, z, re, d);
  else {
    const w = smoothstep(def.roadHalf + 1, def.roadHalf + 18, d);
    const dn = duneness(def, z);
    const dunes = lerp(0.9, 8.6, dn) * fbm2(x / lerp(120, 70, dn), z / lerp(120, 70, dn), def.seed, 3) + lerp(0.35, 1.4, dn) * fbm2(x / 19, z / 19, def.seed + 7, 2);
    h = re + w * dunes;
  }
  for (const s of def.sites) {
    if (s.radius <= 0 || Math.abs(z - s.z) > s.radius * 1.4) continue;
    const p = 1 - smoothstep(s.radius * 0.78, s.radius * 1.3, Math.hypot(x - s.x, z - s.z));
    if (p > 0) h += ((s.h ?? re) - h) * p;
  }
  for (const f of def.foundations) {
    if (z < f.z0 - 3.5 || z > f.z1 + 3.5 || x < f.x0 - 3.5 || x > f.x1 + 3.5) continue;
    const out = Math.hypot(Math.max(f.x0 - x, 0, x - f.x1), Math.max(f.z0 - z, 0, z - f.z1));
    h += (f.h - h) * (1 - smoothstep(0, 3.5, out));
  }
  h += buttes(def, x, z);
  for (const r of def.ramps) {
    const xc = roadX(def, r.z0 + r.len) + r.xOff;
    const rh = rampHeight(r, x, z, xc);
    if (rh > 0) h = Math.max(h, re + rh);
  }
  // A city district is level ground, and fades back into the desert beyond its edge.
  if (def.open) {
    const m = districtMask(def.open, x, z);
    if (m > 0) h -= h * m;
  }
  // Cliff walls bound the corridor (in the open world, the whole map). They rise too steeply to climb.
  const ch = corridorHalf(def, z);
  const cliff = smoothstep(ch, ch + 11, d);
  h += cliff * (30 + 14 * noise2(x / 37, z / 37, def.seed + 3)) + Math.max(0, d - ch - 11) * 0.5;
  // Dead ends beyond the first and last ground.
  const endWall = smoothstep(def.zMax - 10, def.zMax + 10, z);
  const startWall = 1 - smoothstep(def.zMin - 10, def.zMin + 10, z);
  h += (endWall + startWall) * 36;
  return h;
}

/** The open world's ground: dunes in patches, gentle hills away from the highway, flat beside every road. */
function openGround(def: TerrainDef, x: number, z: number, re: number, dHighway: number): number {
  const o = def.open!;
  const hit = nearestRoad(o, x, z);
  const w = hit.edge === Infinity ? 1 : smoothstep(1, 18, hit.edge);
  const dn = duneness(def, z, x);
  const dunes = lerp(0.9, 8.6, dn) * fbm2(x / lerp(120, 70, dn), z / lerp(120, 70, dn), def.seed, 3) + lerp(0.35, 1.4, dn) * fbm2(x / 19, z / 19, def.seed + 7, 2);
  // Long swells of ground, standing back from the highway so it stays easy to drive.
  const far = smoothstep(60, 240, dHighway);
  const swell = far * (13 * fbm2(x / 760 + 5, z / 760 - 3, def.seed + 201, 3) + 5 * fbm2(x / 230 - 8, z / 230 + 2, def.seed + 202, 2));
  return re + w * dunes + swell;
}

export function surfaceAt(def: TerrainDef, x: number, z: number): Surface {
  if (def.open) return openSurface(def, x, z);
  const rx = roadX(def, z);
  const d = Math.abs(x - rx);
  if (def.biome === 'city') {
    if (d < def.roadHalf) return 'asphalt';
    if (def.streets) {
      for (const s of def.streets) if (x >= s.x0 && x <= s.x1 && z >= s.z0 && z <= s.z1) return 'asphalt';
      return 'hardpan';
    }
    return Math.abs(Math.floor(z / 7)) % 9 === 0 ? 'asphalt' : 'hardpan';
  }
  if (d < def.roadHalf) return 'asphalt';
  if (d < def.roadHalf + 3) return 'hardpan';
  if (def.lakes.length && lakeWater(def.lakes, x, z)) return 'mud';
  const sand = noise2(x / 65 + 40, z / 65 - 11, def.seed + 21);
  if (sand > lerp(0.7, 0.5, duneness(def, z))) return 'sand';
  const mud = noise2(x / 48 - 90, z / 48 + 33, def.seed + 45);
  if (mud > 0.76 && heightAt(def, x, z) < roadElev(def, z) + 0.8) return 'mud';
  return 'hardpan';
}

function openSurface(def: TerrainDef, x: number, z: number): Surface {
  const o = def.open!;
  const dist = districtAt(o, x, z);
  if (dist) {
    // The boulevard is the highway; streets are rectangles; everything else in the district is packed earth.
    if (Math.abs(x - roadX(def, z)) < 7) return 'asphalt';
    if (def.streets) for (const s of def.streets) if (x >= s.x0 && x <= s.x1 && z >= s.z0 && z <= s.z1) return 'asphalt';
    return 'hardpan';
  }
  const hit = nearestRoad(o, x, z);
  if (hit.road) {
    if (hit.edge < 0) return hit.road.kind === 'track' ? 'hardpan' : 'asphalt';
    if (hit.edge < 3) return 'hardpan';
  }
  if (def.lakes.length && lakeWater(def.lakes, x, z)) return 'mud';
  const sand = noise2(x / 65 + 40, z / 65 - 11, def.seed + 21);
  if (sand > lerp(0.7, 0.5, duneness(def, z, x))) return 'sand';
  const mud = noise2(x / 48 - 90, z / 48 + 33, def.seed + 45);
  if (mud > 0.76 && heightAt(def, x, z) < roadElev(def, z) + 0.8) return 'mud';
  return 'hardpan';
}

/** Terrain normal by central differences. */
export function normalAt(def: TerrainDef, x: number, z: number, out: [number, number, number] = [0, 1, 0]) {
  const e = 1.2;
  const hl = heightAt(def, x - e, z);
  const hr = heightAt(def, x + e, z);
  const hd = heightAt(def, x, z - e);
  const hu = heightAt(def, x, z + e);
  const nx = hl - hr;
  const nz = hd - hu;
  const ny = 2 * e;
  const m = Math.hypot(nx, ny, nz);
  out[0] = nx / m;
  out[1] = ny / m;
  out[2] = nz / m;
  return out;
}

/** Heights for one chunk in Rapier's column-major layout: index = col*(n+1)+row, col along x and row along z. */
export function chunkHeights(def: TerrainDef, cx: number, cz: number): Float32Array {
  const n = CELLS;
  const out = new Float32Array((n + 1) * (n + 1));
  const x0 = cx * CHUNK;
  const z0 = cz * CHUNK;
  for (let c = 0; c <= n; c++) {
    for (let r = 0; r <= n; r++) out[c * (n + 1) + r] = heightAt(def, x0 + c * CELL, z0 + r * CELL);
  }
  return out;
}

/** `chunkHeights` in slices: yields after every `perSlice` columns, and returns the finished heights. */
export function* chunkHeightsSteps(def: TerrainDef, cx: number, cz: number, perSlice = 5): Generator<void, Float32Array> {
  const n = CELLS;
  const out = new Float32Array((n + 1) * (n + 1));
  const x0 = cx * CHUNK;
  const z0 = cz * CHUNK;
  for (let c = 0; c <= n; c++) {
    for (let r = 0; r <= n; r++) out[c * (n + 1) + r] = heightAt(def, x0 + c * CELL, z0 + r * CELL);
    if (c % perSlice === perSlice - 1) yield;
  }
  return out;
}

export function inMinefield(def: TerrainDef, x: number, z: number): Minefield | null {
  for (const m of def.minefields) {
    if (z >= m.z0 && z <= m.z1 && Math.abs(x - roadX(def, z)) <= m.halfWidth) return m;
  }
  return null;
}

export const clampToCorridor = (def: TerrainDef, x: number, z: number) => {
  const rx = roadX(def, z);
  const h = corridorHalf(def, z) - 2;
  return clamp(x, rx - h, rx + h);
};

/** Water over the ground at a point, or null on dry land. */
export function waterAt(def: TerrainDef, x: number, z: number): WaterHit | null {
  return def.lakes.length ? lakeWater(def.lakes, x, z) : null;
}

/** Where a person stands: the terrain, or a dock deck standing over it. */
export function groundHeight(def: TerrainDef, x: number, z: number): number {
  const h = heightAt(def, x, z);
  if (def.lakes.length === 0) return h;
  const deck = dockDeckAt(def.lakes, x, z);
  return deck > h ? deck : h;
}
