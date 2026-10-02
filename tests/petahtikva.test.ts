import { beforeAll, describe, expect, it } from 'vitest';
import { LEGS, legById, validateData } from '../src/data';
import { initPhysics } from '../src/physics/physics';
import { LegScene } from '../src/game/legScene';
import { ChunkSource } from '../src/world/chunkgen';
import { surfaceAt } from '../src/world/terrain';
import { BOULEVARD_HALF, SIDEWALK } from '../src/world/layout';
import { CITY_PLANS, planById } from '../src/world/plans';
import { PT_BLOCK } from '../src/world/plans/petahTikva';
import { fakeServices, run } from './helpers/sim';

beforeAll(async () => {
  await initPhysics();
});

const leg = legById('L3P');
const plan = planById('petahTikva');
const src = new ChunkSource(leg);
const L = src.layout;
const lotAt = (side: -1 | 1, strip: number, block: number) => L.lots.find((l) => l.side === side && l.strip === strip && l.slot === block)!;

describe('Petah Tikva on the route', () => {
  it('is a city leg with a plan, and the data validates', () => {
    expect(leg.biome).toBe('city');
    expect(leg.plan).toBe('petahTikva');
    expect(validateData()).toEqual([]);
  });

  it('can be chosen at leg 3 from either leg 2 road, and every leg in the graph is still reachable and ends', () => {
    expect(LEGS.route.next.L2W).toContain('L3P');
    expect(LEGS.route.next.L2C).toContain('L3P');
    expect(LEGS.route.next.L3P).toEqual([]);
    const seen = new Set<string>();
    const walk = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      for (const n of LEGS.route.next[id] ?? []) walk(n);
    };
    walk(LEGS.route.start);
    for (const l of LEGS.legs) expect(seen.has(l.id), `${l.id} unreachable`).toBe(true);
  });

  it('only city legs carry a plan, and every plan named by a leg exists', () => {
    for (const l of LEGS.legs) {
      if (l.plan) {
        expect(l.biome).toBe('city');
        expect(CITY_PLANS[l.plan]).toBeDefined();
      }
    }
  });
});

describe('the plan', () => {
  it('lays blocks far enough to cover the leg and its run-off', () => {
    expect(L.slots[0].z0).toBe(plan.startZ);
    expect(L.slots[L.slots.length - 1].z1).toBeGreaterThanOrEqual(leg.length + 260);
    for (let i = 1; i < L.slots.length; i++) expect(L.slots[i].z0).toBeCloseTo(L.slots[i - 1].z1 + L.slots[i - 1].cross, 6);
  });

  it('keeps every building column inside the corridor and clear of the boulevard sidewalk', () => {
    for (const s of L.strips) {
      expect(Math.min(Math.abs(s.x0), Math.abs(s.x1))).toBeGreaterThanOrEqual(BOULEVARD_HALF + SIDEWALK - 1e-9);
      expect(Math.max(Math.abs(s.x0), Math.abs(s.x1))).toBeLessThanOrEqual(150);
    }
  });

  it('names every street it announces, and every named street is on the map', () => {
    const ids = new Set(plan.streets.map((s) => s.id));
    const onMap = new Set<string>([plan.spine]);
    for (const b of plan.blocks) if (b.street) onMap.add(b.street);
    for (const side of ['-1', '1'] as const) for (const s of plan.sides[side]) if (s.street) onMap.add(s.street);
    for (const id of onMap) expect(ids.has(id), `${id} is not described`).toBe(true);
    for (const id of ids) expect(onMap.has(id), `${id} is described but not drawn`).toBe(true);
    // The streets the real centre is known for are all there.
    for (const id of ['haimOzer', 'stampfer', 'baronHirsch', 'pinsker', 'ussishkin', 'hovevei', 'rothschild', 'histadrut']) expect(ids.has(id)).toBe(true);
  });

  it('points every lot override at a lot that exists', () => {
    for (const o of plan.lots) expect(lotAt(o.side, o.strip, o.block), `lot ${o.side}/${o.strip}/${o.block}`).toBeDefined();
    for (const p of plan.places) expect(L.places.some((q) => q.id === p.id)).toBe(true);
  });

  it('is deterministic', () => {
    const a = new ChunkSource(leg).layout;
    expect(JSON.stringify(a.lots)).toBe(JSON.stringify(L.lots));
    expect(JSON.stringify(a.streets)).toBe(JSON.stringify(L.streets));
    const noIds = (r: typeof L) => JSON.stringify(r.landmarks.map((l) => ({ ...l, aabb: { ...l.aabb, id: 0 } })));
    expect(noIds(a)).toBe(noIds(L));
  });
});

describe('Founders’ Square', () => {
  const sq = lotAt(1, 0, PT_BLOCK.square);
  const hovevei = L.passages.find((p) => p.street === 'hovevei')!;

  it('is an open lot on Haim Ozer, between Stampfer and HaBaron Hirsch, with Hovevei Zion on its far side', () => {
    expect(sq.kind).toBe('open');
    expect(sq.landmark).toBe('foundersSquare');
    expect(sq.fixed).toBe(true);
    expect(sq.x0).toBe(BOULEVARD_HALF + SIDEWALK);
    expect(L.slots[PT_BLOCK.square - 1].street).toBe('stampfer');
    expect(L.slots[PT_BLOCK.square].street).toBe('baronHirsch');
    expect(hovevei.x0).toBeCloseTo(sq.x1, 6);
  });

  it('has the fountain where the well was, five plaques, and a paved level with a raised lawn', () => {
    const inSq = (p: { x: number; z: number }) => p.x >= sq.x0 && p.x <= sq.x1 && p.z >= sq.z0 && p.z <= sq.z1;
    const fountains = L.props.filter((p) => p.kind === 'fountain' && inSq(p));
    expect(fountains).toHaveLength(1);
    expect(L.props.filter((p) => p.kind === 'plaque' && inSq(p))).toHaveLength(5);
    expect(L.props.filter((p) => p.kind === 'bench' && inSq(p)).length).toBeGreaterThanOrEqual(4);
    expect(L.streets.some((s) => s.kind === 'paving' && s.x0 === sq.x0 && s.x1 === sq.x1 && s.z0 === sq.z0 && s.z1 === sq.z1)).toBe(true);
    const lawn = L.streets.find((s) => s.kind === 'lawn' && s.x0 > sq.x0 && s.x1 < sq.x1 && s.z0 >= sq.z0 && s.z1 <= sq.z1);
    expect(lawn).toBeDefined();
    // The basin is solid, and the fountain does not sit on the lawn or the boulevard.
    const f = fountains[0];
    expect(L.blockedAt(f.x, f.z, 0)).toBe(true);
    expect(f.x).toBeGreaterThan(BOULEVARD_HALF + SIDEWALK);
    expect(f.x).toBeLessThan(lawn!.x0);
  });

  it('is announced, and has its encounter beside it', () => {
    const place = L.places.find((p) => p.id === 'foundersSquare')!;
    expect(place.name).toBe('FOUNDERS’ SQUARE');
    const enc = L.encounters.find((e) => e.encounter === 'founders_well')!;
    expect(Math.hypot(enc.x - place.x, enc.z - place.z)).toBeLessThan(place.r);
  });
});

describe('the Great Synagogue and City Hall', () => {
  it('the synagogue stands on Hovevei Zion Street, across from the square, and faces it', () => {
    const lot = lotAt(1, 1, PT_BLOCK.square);
    const lm = L.landmarks.find((l) => l.role === 'synagogue')!;
    const hovevei = L.passages.find((p) => p.street === 'hovevei')!;
    expect(lot.landmark).toBe('greatSynagogue');
    expect(hovevei.x1).toBeCloseTo(lot.x0, 6);
    expect(lm.aabb.minX).toBeGreaterThanOrEqual(lot.x0);
    expect(lm.aabb.maxX).toBeLessThanOrEqual(lot.x1);
    expect(lm.aabb.minZ).toBeGreaterThanOrEqual(lot.z0);
    expect(lm.aabb.maxZ).toBeLessThanOrEqual(lot.z1);
    // Its front is towards the street (-x), and it is a solid you cannot walk through.
    expect(lm.front).toBe('w');
    expect(L.blockedAt((lm.aabb.minX + lm.aabb.maxX) / 2, (lm.aabb.minZ + lm.aabb.maxZ) / 2, 0)).toBe(true);
    expect(lm.aabb.y1).toBeGreaterThan(8);
  });

  it('City Hall is a tower, a four-storey wing and a six-storey wing round a car park that opens onto Haim Ozer', () => {
    const lot = lotAt(-1, 0, PT_BLOCK.cityHall);
    const parts = L.landmarks.filter((l) => ['hallTower', 'hallWing', 'hallSide'].includes(l.role));
    expect(parts.map((p) => p.role).sort()).toEqual(['hallSide', 'hallTower', 'hallWing']);
    expect(lot.x1).toBe(-(BOULEVARD_HALF + SIDEWALK));
    const by = (r: string) => parts.find((p) => p.role === r)!;
    expect(by('hallTower').floors).toBeGreaterThan(by('hallSide').floors);
    expect(by('hallSide').floors).toBeGreaterThan(by('hallWing').floors);
    // The two wings meet at right angles and the tower caps the end of the long wing.
    const wing = by('hallWing').aabb;
    const side = by('hallSide').aabb;
    const tower = by('hallTower').aabb;
    expect(wing.maxZ - wing.minZ).toBeGreaterThan(wing.maxX - wing.minX);
    expect(side.maxX - side.minX).toBeGreaterThan(side.maxZ - side.minZ);
    expect(side.minX).toBeCloseTo(wing.maxX, 6);
    expect(tower.minZ).toBeCloseTo(wing.maxZ, 6);
    for (const p of parts) {
      expect(p.aabb.minX).toBeGreaterThanOrEqual(lot.x0 - 1e-9);
      expect(p.aabb.maxX).toBeLessThanOrEqual(lot.x1 + 1e-9);
      expect(p.aabb.minZ).toBeGreaterThanOrEqual(lot.z0 - 1e-9);
      expect(p.aabb.maxZ).toBeLessThanOrEqual(lot.z1 + 1e-9);
    }
    // The car park: tarmac, painted bays, parked cars, and a way in from the road.
    const park = L.streets.find((s) => s.kind === 'tarmac')!;
    expect(park.x1).toBeCloseTo(lot.x1, 6);
    expect(L.props.filter((p) => p.kind === 'parkBays').length).toBeGreaterThanOrEqual(6);
    const inPark = (c: { x: number; z: number }) => c.x > park.x0 && c.x < park.x1 && c.z > park.z0 && c.z < park.z1;
    expect(L.cars.filter(inPark).length).toBeGreaterThanOrEqual(3);
    expect(L.blockedAt(lot.x1 - 2, park.z0 + 3, 0.5)).toBe(false);
    expect(surfaceAt(L.terrain, (park.x0 + park.x1) / 2, (park.z0 + park.z1) / 2)).toBe('asphalt');
  });

  it('Shawarma Malabes is directly across Haim Ozer Street from City Hall, on the boulevard wall', () => {
    const hall = lotAt(-1, 0, PT_BLOCK.cityHall);
    const shop = lotAt(1, 0, PT_BLOCK.cityHall);
    expect(shop.shop).toBe('malabes');
    expect(shop.kind).toBe('building');
    expect(shop.fixed).toBe(true);
    expect(shop.z0).toBe(hall.z0);
    expect(shop.z1).toBe(hall.z1);
    expect(shop.x0).toBe(-hall.x1);
    // The building carries the shop to the renderer, and the sidewalk in front has tables and chairs.
    const spec = src.get(0, Math.floor(((shop.z0 + shop.z1) / 2) / 128)).buildings.find((b) => b.shop === 'malabes')!;
    expect(spec).toBeDefined();
    expect(spec.aabb.minX).toBe(shop.x0);
    const onWalk = (p: { x: number; z: number }) => p.x > BOULEVARD_HALF && p.x < BOULEVARD_HALF + SIDEWALK && p.z > shop.z0 && p.z < shop.z1;
    expect(L.props.filter((p) => p.kind === 'cafeTable' && onWalk(p))).toHaveLength(3);
    expect(L.props.filter((p) => p.kind === 'cafeChair' && onWalk(p))).toHaveLength(6);
    expect(L.places.some((p) => p.id === 'malabes')).toBe(true);
  });

  it('landmark lots are never given to a scavenge zone or the metro headhouse', () => {
    for (const l of L.lots.filter((q) => q.fixed)) expect(l.kind).not.toBe('zone');
    for (const d of L.delves) {
      const lot = L.lots.find((l) => d.z > l.z0 && d.z < l.z1 && Math.abs(d.x) >= BOULEVARD_HALF && d.x > l.x0 - 4 && d.x < l.x1 + 4)!;
      expect(lot.fixed).toBeFalsy();
    }
  });
});

describe('streets', () => {
  const paved = L.streets.filter((s) => s.kind === 'asphalt' && !s.silent);

  it('are paved asphalt, and the ground inside a forecourt is not', () => {
    const stampfer = L.slots[PT_BLOCK.stampfer];
    expect(surfaceAt(L.terrain, 30, stampfer.z1 + stampfer.cross / 2)).toBe('asphalt');
    const hovevei = L.passages.find((p) => p.street === 'hovevei')!;
    expect(surfaceAt(L.terrain, (hovevei.x0 + hovevei.x1) / 2, 450)).toBe('asphalt');
    const hall = lotAt(-1, 0, PT_BLOCK.cityHall);
    expect(surfaceAt(L.terrain, hall.x0 + 5, hall.z0 + 20)).toBe('hardpan');
  });

  it('are open: no building stands on a paved street', () => {
    const buildings = src.allAabbs().filter((a) => a.kind === 'building');
    for (const s of paved) {
      for (const b of buildings) {
        const overlap = b.minX < s.x1 - 0.01 && b.maxX > s.x0 + 0.01 && b.minZ < s.z1 - 0.01 && b.maxZ > s.z0 + 0.01;
        expect(overlap, `building at ${b.minX},${b.minZ} on street ${s.street ?? s.id}`).toBe(false);
      }
    }
  });

  it('chunks only carry the patches that touch them', () => {
    const c = src.get(0, 3);
    expect(c.patches.length).toBeGreaterThan(0);
    for (const p of c.patches) {
      expect(p.x1).toBeGreaterThan(0);
      expect(p.x0).toBeLessThan(128);
      expect(p.z1).toBeGreaterThan(384);
      expect(p.z0).toBeLessThan(512);
      expect(p.silent).toBeFalsy();
    }
  });

  it('the old procedural cities are untouched', () => {
    const old = new ChunkSource(legById('L2C')).layout;
    expect(old.plan).toBeNull();
    expect(old.streets).toHaveLength(0);
    expect(old.landmarks).toHaveLength(0);
    expect(old.terrain.streets).toBeUndefined();
  });
});

describe('getting around', () => {
  it('everything on the route can be reached on foot from the start, treating barricades as breakable', () => {
    const cell = 2;
    const x0 = -150;
    const z0 = -40;
    const w = Math.ceil(300 / cell);
    const h = Math.ceil((leg.length + 80 - z0) / cell);
    const free = (i: number, j: number) => {
      const x = x0 + (i + 0.5) * cell;
      const z = z0 + (j + 0.5) * cell;
      if (L.blockedAt(x, z, 0.6)) {
        // A barricade is a wall until it is rammed.
        return L.aabbs.some((a) => a.kind === 'barricade' && x > a.minX && x < a.maxX && z > a.minZ && z < a.maxZ);
      }
      return true;
    };
    const seen = new Uint8Array(w * h);
    const start = [Math.floor((0 - x0) / cell), Math.floor((12 - z0) / cell)];
    const stack = [start[1] * w + start[0]];
    seen[stack[0]] = 1;
    while (stack.length) {
      const k = stack.pop()!;
      const i = k % w;
      const j = (k - i) / w;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= w || nj >= h || seen[nj * w + ni] || !free(ni, nj)) continue;
        seen[nj * w + ni] = 1;
        stack.push(nj * w + ni);
      }
    }
    const reached = (x: number, z: number) => seen[Math.floor((z - z0) / cell) * w + Math.floor((x - x0) / cell)] === 1;
    const sq = lotAt(1, 0, PT_BLOCK.square);
    expect(reached((sq.x0 + sq.x1) / 2 + 12, (sq.z0 + sq.z1) / 2)).toBe(true);
    const hall = lotAt(-1, 0, PT_BLOCK.cityHall);
    expect(reached(hall.x1 - 4, hall.z0 + 40)).toBe(true);
    expect(reached(L.end.x, L.end.z)).toBe(true);
    const shop = lotAt(1, 0, PT_BLOCK.cityHall);
    expect(reached(9, (shop.z0 + shop.z1) / 2)).toBe(true);
  });
});

describe('arriving in the places', () => {
  it('names Haim Ozer Street, then Founders’ Square, the Great Synagogue and a cross street, once each', () => {
    const h = fakeServices();
    const sc = new LegScene(h.svc, leg);
    for (const p of sc.players) p.exitVehicle(false);
    run(sc, 7);
    expect(h.banners.some((b) => b.startsWith('HAIM OZER STREET'))).toBe(true);
    const sq = L.places.find((p) => p.id === 'foundersSquare')!;
    sc.players[0].placeAt(sq.x, sq.z, 0);
    run(sc, 4);
    expect(h.banners.some((b) => b.startsWith('FOUNDERS’ SQUARE'))).toBe(true);
    const syn = L.places.find((p) => p.id === 'greatSynagogue')!;
    sc.players[0].placeAt(syn.x, syn.z, 0);
    run(sc, 4);
    expect(h.banners.some((b) => b.startsWith('THE GREAT SYNAGOGUE'))).toBe(true);
    const s = L.slots[PT_BLOCK.stampfer];
    sc.players[0].placeAt(0, s.z1 + s.cross / 2, 0);
    run(sc, 4);
    expect(h.banners.some((b) => b.startsWith('STAMPFER STREET'))).toBe(true);
    const shop = L.places.find((p) => p.id === 'malabes')!;
    sc.players[0].placeAt(shop.x, shop.z, 0);
    run(sc, 4);
    expect(h.banners.some((b) => b.startsWith('SHAWARMA MALABES'))).toBe(true);
    // Back again: nothing is announced twice.
    const before = h.banners.length;
    sc.players[0].placeAt(sq.x, sq.z, 0);
    run(sc, 4);
    expect(h.banners.length).toBe(before);
    sc.dispose();
  }, 60000);
});
