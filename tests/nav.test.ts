import { beforeAll, describe, expect, it } from 'vitest';
import { appendFileSync } from 'node:fs';
import { legById } from '../src/data';
import { buildLayout } from '../src/world/layout';
import { roadX } from '../src/world/terrain';
import { LegMapBaker, MapProjection, takeDirty } from '../src/ui/mapdata';
import { MapTiles } from '../src/ui/mapTiles';
import { MapNav } from '../src/ui/mapnav';
import { alongRoute, buildRoadGraph, findRoute, nearestRoads, offRoute, type RoadLine } from '../src/game/route';
import { Campaign } from '../src/game/campaign';
import { NAME_MAX, addPoi, cleanName, newNavMarks, restoreNavMarks, toggleWaypoint } from '../src/sim/navmarks';
import { ACTION_BY_ID, defaultBindings, exportBindings, importBindings } from '../src/input/bindings';
import { BTN_COUNT, Btn } from '../src/input/intents';

/** Timings go to a scratch file (vitest swallows console output); set NAV_LOG to a path to see them. */
const log = (s: string) => {
  const f = process.env.NAV_LOG;
  if (f) appendFileSync(f, `${s}\n`);
};

const alpha = (b: { data: Uint8ClampedArray; w: number; x0: number; z0: number; cell: number }, x: number, z: number) =>
  b.data[(Math.floor((z - b.z0) / b.cell) * b.w + Math.floor((x - b.x0) / b.cell)) * 4 + 3];

describe('the map bake', () => {
  const layout = buildLayout(legById('L1'));
  const T = layout.terrain;

  it('has a coarse picture first, then refines band by band, marking only the rows it changed', () => {
    const b = new LegMapBaker(T, layout);
    expect(b.usable).toBe(false);
    // The coarse pass: a usable picture covering the whole road, the whole image marked for upload.
    const t0 = performance.now();
    let n = 0;
    while (!b.usable && n++ < 10000) b.step(1);
    log(`L1 coarse pass ${(performance.now() - t0).toFixed(1)} ms over ${n} steps`);
    expect(b.usable).toBe(true);
    expect(b.base.done).toBe(false);
    // The coarse picture is a small image of its own, drawn under the real one, and it covers the whole road.
    const c = b.coarse!;
    expect(c.w * c.h).toBeLessThan(5000);
    for (let z = 20; z < T.length; z += 97) expect(alpha(c, roadX(T, z), z)).toBe(255);
    expect(takeDirty(c)).toEqual([0, c.h]);
    takeDirty(b.base);
    // Refining starts where it is told to look, and an upload after a step sends only the rows that step touched.
    const z = 1500;
    b.focus(z);
    const row = Math.floor((z - b.base.z0) / b.base.cell);
    let rows: [number, number] | null = null;
    for (let i = 0; i < 200 && !rows; i++) {
      b.step(0.5);
      rows = takeDirty(b.base);
    }
    expect(rows).not.toBeNull();
    expect(rows![1] - rows![0]).toBeLessThan(12);
    expect(Math.abs(rows![0] - row)).toBeLessThan(10);
    // The rest, in small slices: a slice stops soon after its budget (the median, since a loaded test machine stalls any
    // single slice now and then).
    const took: number[] = [];
    while (!b.base.done && took.length < 100000) {
      const s0 = performance.now();
      b.step(1);
      took.push(performance.now() - s0);
    }
    took.sort((p, q) => p - q);
    log(`L1 fine pass: ${took.length} steps of 1 ms, median ${took[took.length >> 1].toFixed(2)} ms, worst ${took[took.length - 1].toFixed(2)} ms`);
    expect(b.base.done).toBe(true);
    expect(took[took.length >> 1]).toBeLessThan(4);
    // The finished picture is the same as one baked in a single go: the order of the bands does not show.
    const again = new LegMapBaker(T, layout).finish();
    expect(Buffer.from(again.data).equals(Buffer.from(b.base.data))).toBe(true);
  });
});

describe('the open world bake and its close-up tiles', () => {
  const layout = buildLayout(legById('W'));
  const T = layout.terrain;

  it('is usable after a coarse pass of a few thousand samples, and tiles bake where they are asked for', () => {
    const b = new LegMapBaker(T, layout);
    const t0 = performance.now();
    while (!b.usable) b.step(5);
    const coarse = performance.now() - t0;
    log(`W coarse pass ${coarse.toFixed(1)} ms for ${b.base.w}x${b.base.h}`);
    // Generous for a loaded test machine: in a browser this is a frame or two.
    expect(coarse).toBeLessThan(600);
    const tiles = new MapTiles(T, () => b.shade, b.bounds, 6, 0.25);
    const x = roadX(T, 400);
    const r = { x0: x - 100, x1: x + 100, z0: 300, z1: 500 };
    let frames = 0;
    const t1 = performance.now();
    while (!tiles.doneAt(x, 400) && frames++ < 2000) {
      tiles.want(r);
      tiles.step(2);
    }
    log(`W tiles round (${x.toFixed(0)}, 400): ${frames} frames, ${(performance.now() - t1).toFixed(0)} ms, ${tiles.count} done`);
    expect(tiles.doneAt(x, 400)).toBe(true);
    const px = tiles.pixelAt(x, 400)!;
    expect(px[3]).toBe(255);
    // A view so wide it would want a hundred tiles or more gets none.
    const before = tiles.count;
    tiles.want({ x0: -2000, x1: 2000, z0: -1000, z1: 4000 });
    tiles.step(5);
    expect(tiles.count).toBe(before);
  }, 120000);
});

describe('map projection both ways', () => {
  it('turns a screen point back into the world point drawn there, at any heading', () => {
    for (const heading of [0, Math.PI / 2, 0.7]) {
      const P = new MapProjection().set(120, -40, heading, 1.7, 300, 200);
      for (const [x, z] of [[120, -40], [90, 10], [400, -300]]) {
        const sx = P.x(x, z);
        const sy = P.y(x, z);
        expect(P.worldX(sx, sy)).toBeCloseTo(x, 6);
        expect(P.worldZ(sx, sy)).toBeCloseTo(z, 6);
      }
    }
  });

  it('zooms about the cursor and pans when the cursor pushes on the edge', () => {
    const nav = new MapNav();
    nav.area = { w: 400, h: 300, listX: Infinity };
    nav.reset(1, 1000, 2000);
    nav.minScale = 0.01;
    nav.moveCursor(80, -50);
    const w0 = nav.cursorWorld();
    nav.zoomBy(2.5);
    const w1 = nav.cursorWorld();
    expect(w1.x).toBeCloseTo(w0.x, 6);
    expect(w1.z).toBeCloseTo(w0.z, 6);
    // North up: a cursor above the centre is north of it, and +X is to the left.
    nav.recentre(0, 0);
    nav.moveCursor(0, -100);
    expect(nav.cursorWorld().z).toBeGreaterThan(0);
    nav.recentre(0, 0);
    nav.moveCursor(-50, 0);
    expect(nav.cursorWorld().x).toBeGreaterThan(0);
    // Past the edge: the cursor stops, the map moves on.
    nav.recentre(0, 0);
    nav.moveCursor(1000, 0);
    expect(nav.sx).toBeLessThan(200);
    expect(nav.cx).toBeLessThan(0);
    expect(nav.follow).toBe(false);
  });
});

describe('routes over a road network', () => {
  // A highway north, a road branching west whose end stops just short of the highway, and a track crossing the highway.
  const roads: RoadLine[] = [
    { pts: [0, 0, 0, 250, 0, 500, 0, 750, 0, 1000], kind: 'highway' },
    { pts: [-3, 500, -200, 520, -400, 500], kind: 'road' },
    { pts: [200, 800, 0, 790, -200, 800], kind: 'track' },
  ];
  const g = buildRoadGraph(roads);

  it('joins a road that ends just short of another, and a track that crosses it', () => {
    // From the far end of the branch, the way north runs through the junction.
    const r = findRoute(g, -400, 515, 0, 990);
    expect(r.direct).toBe(false);
    let viaJunction = false;
    for (let i = 0; i < r.pts.length; i += 2) if (Math.hypot(r.pts[i], r.pts[i + 1] - 500) < 8) viaJunction = true;
    expect(viaJunction).toBe(true);
    expect(r.length).toBeGreaterThan(850);
    expect(r.length).toBeLessThan(950);
    // The track carries a route across the highway rather than over open ground.
    const t = findRoute(g, 190, 815, -190, 812);
    expect(t.direct).toBe(false);
    expect(offRoute(t.pts, 0, 790)).toBeLessThan(3);
  });

  it('goes straight when no road is near, and the ends join the road off-road', () => {
    expect(findRoute(g, 2000, 0, 2400, 300).direct).toBe(true);
    const r = findRoute(g, 30, 40, 25, 960);
    expect(r.pts[0]).toBe(30);
    expect(r.pts[r.pts.length - 1]).toBe(960);
    expect(r.offStart).toBe(1);
    expect(nearestRoads(g, 30, 40, 50)[0].d).toBeCloseTo(30, 0);
  });

  it('gives a point ahead along the way and what is left of it', () => {
    const pts = [0, 0, 0, 100, 100, 100];
    const a = alongRoute(pts, 0, 10, 20);
    expect(a.x).toBeCloseTo(0);
    expect(a.z).toBeCloseTo(30);
    expect(a.left).toBeCloseTo(190);
    const b = alongRoute(pts, 0, 95, 20, a.seg);
    expect(b.z).toBeCloseTo(100);
    expect(b.x).toBeCloseTo(15);
  });

  it('builds and searches the open world in a few milliseconds', () => {
    const T = buildLayout(legById('W')).terrain;
    const lines = T.open!.roads.map((r) => ({ pts: r.pts, kind: r.kind, half: r.half }));
    const t0 = performance.now();
    const og = buildRoadGraph(lines);
    const built = performance.now() - t0;
    const t1 = performance.now();
    let len = 0;
    for (let i = 0; i < 20; i++) len += findRoute(og, roadX(T, 0) + 300, i * 150, roadX(T, 3800) - 200, 3800 - i * 40).length;
    const each = (performance.now() - t1) / 20;
    log(`W road graph: ${og.n} nodes, built ${built.toFixed(1)} ms, route ${each.toFixed(2)} ms each`);
    expect(len).toBeGreaterThan(0);
    expect(each).toBeLessThan(40);
  }, 60000);
});

describe('map marks in the save', () => {
  it('keeps each seat waypoint and the shared marks through a save and load', () => {
    const c = new Campaign();
    toggleWaypoint(c.nav, 0, 'W', 120, 340);
    toggleWaypoint(c.nav, 1, 'W', -50, 800);
    addPoi(c.nav, { leg: 'W', x: 10, z: 20, kind: 'fuel', by: 0, name: 'Gas  by the  bend' });
    addPoi(c.nav, { leg: 'W', x: 30, z: 40, kind: 'danger', by: 1, pin: true });
    const back = Campaign.deserialize(JSON.parse(JSON.stringify(c.serialize())));
    expect(back.nav.waypoints[0]).toEqual({ leg: 'W', x: 120, z: 340 });
    expect(back.nav.waypoints[1]).toEqual({ leg: 'W', x: -50, z: 800 });
    expect(back.nav.pois.map((p) => [p.kind, p.name, p.pin, p.by])).toEqual([
      ['fuel', 'Gas by the bend', false, 0],
      ['danger', '', true, 1],
    ]);
    // New marks never reuse a saved id.
    const fresh = addPoi(back.nav, { leg: 'W', x: 0, z: 0, kind: 'star', by: 0 });
    expect(back.nav.pois.filter((p) => p.id === fresh.id)).toHaveLength(1);
  });

  it('loads a save from before marks with none, and drops what is malformed', () => {
    const c = new Campaign();
    const raw = JSON.parse(JSON.stringify(c.serialize()));
    delete raw.nav;
    expect(Campaign.deserialize(raw).nav).toEqual(newNavMarks());
    const m = restoreNavMarks({ waypoints: [{ leg: 'W', x: 'a', z: 1 }, null], pois: [{ leg: 'W', x: 1, z: 2, kind: 'unicorn' }, { leg: 'W', x: 1, z: 2, kind: 'water', name: 'x'.repeat(80) }, 7], nextId: -4 });
    expect(m.waypoints).toEqual([null, null]);
    expect(m.pois).toHaveLength(1);
    expect(m.pois[0].name.length).toBe(NAME_MAX);
    expect(m.pois[0].id).toBeGreaterThan(0);
  });

  it('sets a waypoint, and setting it again on the same spot clears it', () => {
    const m = newNavMarks();
    expect(toggleWaypoint(m, 0, 'W', 100, 100)).toBe(true);
    expect(toggleWaypoint(m, 0, 'W', 104, 98)).toBe(false);
    expect(m.waypoints[0]).toBeNull();
    expect(cleanName('  Camp\n  two!!<> ')).toBe('Camp two!!');
  });
});

describe('the call-your-ride key', () => {
  it('is 9 on the first layout and Page Up on the second, and no key is shared between the two layouts', () => {
    expect(Btn.Summon).toBe(24);
    expect(BTN_COUNT).toBe(26);
    expect(ACTION_BY_ID.summon.btn).toEqual([Btn.Summon]);
    const b = defaultBindings();
    expect(b.kb[0].summon).toBe('Digit9');
    expect(b.kb[1].summon).toBe('PageUp');
    expect(b.kb[1].eat).toBe('Home');
    expect(b.kb[1].drink).toBe('End');
    const all = [...Object.values(b.kb[0]), ...Object.values(b.kb[1])];
    expect(new Set(all).size).toBe(all.length);
  });

  it('moves an old save\'s second-layout eat and drink off 9 and 0', () => {
    const old = exportBindings(defaultBindings()) as { kb: Record<string, unknown>[] };
    for (const k of old.kb) delete k.summon;
    old.kb[1].eat = 'Digit9';
    old.kb[1].drink = 'Digit0';
    const b = importBindings(old);
    expect(b.kb[0].summon).toBe('Digit9');
    expect(b.kb[1].eat).toBe('Home');
    expect(b.kb[1].drink).toBe('End');
    // A save that already knows the ride keeps whatever was chosen.
    const now = exportBindings(defaultBindings()) as { kb: Record<string, unknown>[] };
    now.kb[1].eat = 'KeyZ';
    expect(importBindings(now).kb[1].eat).toBe('KeyZ');
  });
});
