import { describe, expect, it } from 'vitest';
import './helpers/sim';
import * as THREE from 'three';
import { chassisDef } from '../src/data';
import { newBuild } from '../src/sim/garage';
import { newPart, type Fit } from '../src/sim/parts';
import { buildVehicleVisual, lookOf } from '../src/render/vehicleModels';
import { rollTrim } from '../src/sim/carTrim';
import { BodyMesh } from '../src/render/deform';
import { groupParts } from '../src/render/bodyParts';
import { applyKit } from '../src/render/materials';
import { patchSkin } from '../src/render/vehicleDirt';
import { TrackMarks } from '../src/render/trackMarks';
import {
  LOOSE_AT,
  SNAP_AT,
  blastDent,
  condAfterBreak,
  dentDepth,
  dentRadius,
  dirtStep,
  jointTol,
  markStyle,
  shockLoad,
  skidAmount,
  stateOf,
  stressFromShock,
  stressFromSpin,
  surfaceToward,
  type Dirt,
} from '../src/sim/bodywork';
import { planRepair } from '../src/sim/repair';
import { newHealth } from '../src/sim/damage';
import { newStocks } from '../src/sim/resources';

/** A model for a chassis, built the way a vehicle builds its own. */
function model(chassis: string, fit: Fit = {}, seed = 31) {
  const def = chassisDef(chassis);
  const p = def.physics;
  const wl: [number, number, number][] = [];
  const st: boolean[] = [];
  for (let a = 0; a < p.wheelsZ.length; a++) {
    const xs = p.wheelsX[0] === 0 ? [0] : p.wheelsX;
    for (const wx of xs) {
      if (wl.length >= p.wheelCount) break;
      wl.push([wx, p.hardY, p.wheelsZ[a]]);
      st.push(a < 1);
    }
  }
  const b = newBuild(chassis, { seed });
  b.fit = fit;
  return buildVehicleVisual(def, wl, st, lookOf(b));
}

const part = (id: string) => newPart(id, 1);

describe('crash rules', () => {
  it('dents grow with speed and mass, and a gentle bump leaves no mark', () => {
    expect(dentDepth(1.5)).toBe(0);
    expect(dentDepth(4)).toBeLessThan(0.05);
    expect(dentDepth(10)).toBeGreaterThan(dentDepth(6));
    expect(dentDepth(20)).toBeGreaterThan(0.4);
    expect(dentDepth(20)).toBeLessThanOrEqual(0.8);
    expect(dentDepth(10, 0.95)).toBeGreaterThan(dentDepth(10, 0.05));
    expect(dentRadius(20)).toBeGreaterThan(dentRadius(4));
    expect(blastDent(60, 1).depth).toBeGreaterThan(blastDent(60, 0.1).depth);
  });

  it('finds the body surface in the direction of what was hit', () => {
    const p = surfaceToward([0, 0, 1], [0.9, 0.4, 2], 0.1);
    expect(p[2]).toBeCloseTo(2, 5);
    expect(Math.abs(p[0])).toBeLessThan(0.01);
    const side = surfaceToward([-1, 0, 0], [0.9, 0.4, 2], 0.1);
    expect(side[0]).toBeCloseTo(-0.9, 5);
  });

  it('a joint takes ordinary rough driving, loosens under a hard knock and lets go at a crash', () => {
    const tol = 10;
    expect(stressFromShock(2, tol, true)).toBe(0);
    const hard = stressFromShock(8.5, tol, true);
    expect(stateOf(hard)).toBe('loose');
    const crash = stressFromShock(16, tol, true);
    expect(crash).toBeGreaterThanOrEqual(SNAP_AT);
    // The far side of the car is carried along by the body: it takes a hit the near side would not survive.
    expect(stateOf(stressFromShock(16, tol, false))).not.toBe('gone');
    expect(stateOf(0)).toBe('fixed');
    expect(stateOf(LOOSE_AT)).toBe('loose');
    // A part hit itself takes more of the same blow.
    expect(stressFromShock(8, tol, true)).toBeGreaterThan(stressFromShock(8, tol, false));
  });

  it('spin pulls the furthest parts hardest, and nothing at all in ordinary driving', () => {
    const rack: [number, number, number] = [0, 1.6, 0];
    const bumper: [number, number, number] = [0, 0.3, 1.8];
    // A roll about the car's own axis: the roof is far from it, the bumper is on it.
    const spinning: [number, number, number] = [0, 0, 5];
    expect(stressFromSpin([0, 1.7, 0], rack, 8, 1)).toBe(0);
    expect(stressFromSpin(spinning, rack, 8, 1)).toBeGreaterThan(stressFromSpin(spinning, bumper, 8, 1));
    expect(shockLoad([0, 0, 0], [0, 0, 3], rack)).toBeCloseTo(4.8, 5);
    expect(shockLoad([3, 0, 0], [0, 0, 0], rack)).toBeCloseTo(3, 5);
  });

  it('joint strength varies a little per car and part, deterministically', () => {
    const a = jointTol(10, 5, 'door:1');
    expect(jointTol(10, 5, 'door:1')).toBe(a);
    expect(jointTol(10, 6, 'door:1')).not.toBe(a);
    for (let s = 0; s < 40; s++) {
      const t = jointTol(10, s, 'slot:roof');
      expect(t).toBeGreaterThanOrEqual(8.6);
      expect(t).toBeLessThanOrEqual(11.4);
    }
    // A part torn off comes back worn.
    expect(condAfterBreak(1, 1)).toBeLessThan(0.75);
    expect(condAfterBreak(0.1, 1)).toBeGreaterThanOrEqual(0.12);
  });
});

describe('mud, dust and blood', () => {
  const dirt = (): Dirt => ({ mud: 0, dust: 0, blood: 0 });
  const base = { dt: 1, speed: 18, wet: 0, wading: 0, storm: 0, grounded: true };

  it('builds up with the miles by surface', () => {
    const sand = dirt();
    const road = dirt();
    const mud = dirt();
    for (let i = 0; i < 20; i++) {
      dirtStep(sand, { ...base, surface: 'sand' });
      dirtStep(road, { ...base, surface: 'asphalt' });
      dirtStep(mud, { ...base, surface: 'mud' });
    }
    expect(sand.dust).toBeGreaterThan(0.15);
    expect(sand.mud).toBe(0);
    expect(road.dust).toBeLessThan(sand.dust / 5);
    expect(mud.mud).toBeGreaterThan(0.4);
  });

  it('wet earth turns to mud, a dust storm settles dust, and water washes it all off', () => {
    const d = dirt();
    for (let i = 0; i < 30; i++) dirtStep(d, { ...base, surface: 'hardpan', wet: 0.9 });
    expect(d.mud).toBeGreaterThan(0.2);
    const s = dirt();
    for (let i = 0; i < 30; i++) dirtStep(s, { ...base, speed: 0, surface: 'hardpan', storm: 1 });
    expect(s.dust).toBeGreaterThan(0.3);
    const w: Dirt = { mud: 0.8, dust: 0.5, blood: 0.6 };
    for (let i = 0; i < 6; i++) dirtStep(w, { ...base, speed: 2, surface: 'sand', wading: 1 });
    expect(w.mud).toBeLessThan(0.1);
    expect(w.dust).toBeLessThan(0.1);
    expect(w.blood).toBeLessThan(0.2);
  });

  it('stays inside 0..1', () => {
    const d: Dirt = { mud: 0.99, dust: 0.99, blood: 0.99 };
    for (let i = 0; i < 100; i++) dirtStep(d, { ...base, surface: 'mud', storm: 1 });
    expect(d.mud).toBeLessThanOrEqual(1);
    expect(d.dust).toBeLessThanOrEqual(1);
    expect(d.mud).toBeGreaterThanOrEqual(0);
  });
});

describe('tyre marks', () => {
  it('asphalt takes rubber only from a scrubbing tyre; soft ground takes a groove from a rolling one', () => {
    const rolling = { lateral: 0.2, speed: 20, throttle: 0.5, brake: 0, handbrake: false, rear: false };
    expect(skidAmount(rolling)).toBe(0);
    expect(skidAmount({ ...rolling, brake: 1 })).toBeGreaterThan(0.5);
    expect(skidAmount({ ...rolling, lateral: 6 })).toBeGreaterThan(0.6);
    expect(skidAmount({ ...rolling, handbrake: true, rear: true })).toBeGreaterThan(0.7);
    expect(skidAmount({ ...rolling, handbrake: true, rear: false, speed: 6 })).toBe(0);
    expect(markStyle('asphalt', 0, 20, 0)).toBeNull();
    const skid = markStyle('asphalt', 0.9, 20, 0)!;
    expect(skid.kind).toBe('skid');
    expect(skid.alpha).toBeGreaterThan(0.6);
    expect(markStyle('sand', 0, 8, 0)!.kind).toBe('groove');
    expect(markStyle('sand', 0, 0.2, 0)).toBeNull();
    // Mud holds its groove deeper and darker than hard earth does.
    expect(markStyle('mud', 0, 8, 0)!.depth).toBeGreaterThan(markStyle('hardpan', 0, 8, 0)!.depth);
    expect(markStyle('mud', 0, 8, 0)!.alpha).toBeGreaterThan(markStyle('hardpan', 0, 8, 0)!.alpha);
  });

  it('lays a continuous ribbon of segments as a wheel travels and stops when it leaves the ground', () => {
    const marks = new TrackMarks();
    const style = markStyle('sand', 0, 10, 0)!;
    const ground = () => 3;
    for (let i = 0; i <= 40; i++) marks.lay(1, 10, i * 0.3, 0.12, style, ground);
    // 12 m, a segment each time the wheel has moved a step: the first contact only starts the ribbon.
    expect(marks.count).toBeGreaterThan(15);
    expect(marks.count).toBeLessThan(32);
    const before = marks.count;
    marks.lift(1);
    marks.lay(1, 50, 0, 0.12, style, ground);
    marks.lay(1, 50, 0.1, 0.12, style, ground);
    expect(marks.count).toBe(before);
    // Everything laid sits just above the ground and carries the style's opacity.
    marks.update(1 / 60);
    const pos = marks.mesh.geometry.attributes.position.array as Float32Array;
    expect(pos[1]).toBeGreaterThan(2.99);
    expect(pos[1]).toBeLessThan(3.12);
    const col = marks.mesh.geometry.attributes.color.array as Float32Array;
    expect(col[3]).toBe(0);
    expect(col[7]).toBeGreaterThan(0);
    // A jump (a respawn) does not stretch a ribbon across the map.
    marks.lay(2, 0, 0, 0.12, style, ground);
    marks.lay(2, 0.5, 0, 0.12, style, ground);
    const n = marks.count;
    marks.lay(2, 400, 0, 0.12, style, ground);
    expect(marks.count).toBe(n);
  });

  it('overwrites the oldest marks once the buffer is full, and clears', () => {
    const marks = new TrackMarks();
    const style = markStyle('mud', 0, 10, 0)!;
    let z = 0;
    for (let i = 0; i < 9000; i++) marks.lay(3, 0, (z += 0.5), 0.12, style, () => 0);
    expect(marks.count).toBe(7000);
    marks.clear();
    expect(marks.count).toBe(0);
  });
});

describe('repair knows about dents', () => {
  it('a bent car with full hit points still gets a bodywork job, and a missing panel a welding one', () => {
    const h = newHealth(100, 0, 4);
    const rich = newStocks({ parts: 9, scrap: 9 });
    expect(planRepair(h, rich)).toBeNull();
    expect(planRepair(h, rich, { dents: 0.5 })!.kind).toBe('body');
    expect(planRepair(h, rich, { dents: 0.02 })).toBeNull();
    const weld = planRepair(h, rich, { missing: 1 })!;
    expect(weld.kind).toBe('body');
    expect(weld.label).toMatch(/panel/i);
  });
});

describe('part tags in the models', () => {
  const tags = (v: ReturnType<typeof model>) => groupParts(v.body.geometry.userData.parts).map((g) => g.tag);

  it.each(['hatch', 'sedan', 'pickup', 'van'])('a %s has doors, mirrors and bumpers that can come off', (id) => {
    // Bumpers are part of the trim now (some cars lost theirs long ago): take a car of this model that still has both.
    let seed = 31;
    while (rollTrim(id, seed)!.bumperF === 'none' || rollTrim(id, seed)!.bumperR === 'none' || rollTrim(id, seed)!.bumperF === 'bull') seed++;
    const t = tags(model(id, {}, seed));
    for (const want of ['door:1', 'door:-1', 'mirror:1', 'mirror:-1', 'bumper:front', 'bumper:rear']) expect(t).toContain(want);
  });

  it('every fitted module is tagged with its slot, per side where it has two', () => {
    const fit: Fit = { front: part('fr_bull'), roof: part('rf_rack'), rear: part('rr_spare'), side: part('sd_plate'), armor: part('arm_weld'), utility: part('utl_rack') };
    const v = model('sedan', fit);
    const groups = groupParts(v.body.geometry.userData.parts);
    const slots = new Set(groups.map((g) => g.meta.slot).filter(Boolean));
    for (const s of ['front', 'roof', 'rear', 'side', 'armor', 'utility']) expect(slots.has(s)).toBe(true);
    expect(groups.filter((g) => g.meta.slot === 'side').map((g) => g.meta.side).sort()).toEqual([-1, 1]);
    // A spare wheel rolls; a bull bar does not.
    expect(groups.find((g) => g.tag === 'slot:rear')!.meta.round).toBe(true);
    expect(groups.find((g) => g.tag === 'slot:front')!.meta.round).toBeFalsy();
  });

  it('a heavier-duty part has a tougher joint than the light one', () => {
    const a = groupParts(model('sedan', { front: part('fr_bull') }).body.geometry.userData.parts).find((g) => g.tag === 'slot:front')!;
    const b = groupParts(model('sedan', { front: part('fr_blade') }).body.geometry.userData.parts).find((g) => g.tag === 'slot:front')!;
    expect(b.meta.tol).toBeGreaterThan(a.meta.tol);
    expect(b.meta.mass).toBeGreaterThan(a.meta.mass);
  });

  it('the tier vehicles carry their own detachable bits', () => {
    expect(tags(model('buggy'))).toEqual(expect.arrayContaining(['door:1', 'door:-1', 'spare', 'bullbar', 'lightbar']));
    expect(tags(model('quad'))).toEqual(expect.arrayContaining(['sign:1', 'sign:-1', 'spare']));
    expect(tags(model('moped'))).toContain('crate');
  });

  it('ranges are well-formed: each part owns a contiguous run and its indices stay inside it', () => {
    const v = model('pickup', { front: part('fr_bull'), side: part('sd_skirt'), roof: part('rf_cage') });
    const geo = v.body.geometry;
    const idx = geo.index!;
    for (const g of groupParts(geo.userData.parts)) {
      for (const r of g.ranges) {
        expect(r.v1).toBeGreaterThan(r.v0);
        for (let i = r.i0; i < r.i1; i++) {
          const k = idx.getX(i);
          expect(k).toBeGreaterThanOrEqual(r.v0);
          expect(k).toBeLessThan(r.v1);
        }
      }
    }
  });
});

describe('lattice deformation', () => {
  const car = () => model('sedan', { front: part('fr_bull') });
  const posOf = (g: THREE.BufferGeometry) => g.attributes.position.array as Float32Array;

  it('folds the nose back where it was hit and leaves the tail alone', () => {
    const v = car();
    const rest = Float32Array.from(posOf(v.body.geometry));
    const hull = new BodyMesh(v.body.geometry);
    // The original geometry is shared with the car's identical siblings: it must not change.
    hull.dent([0, 0, 2.3], [0, 0, -1], 0.4, 0.9);
    hull.update(Infinity);
    const p = posOf(hull.geo);
    const orig = posOf(v.body.geometry);
    expect(Array.from(orig.slice(0, 300))).toEqual(Array.from(rest.slice(0, 300)));
    let frontShift = 0;
    let frontN = 0;
    let tailMoved = 0;
    for (let i = 0; i < p.length / 3; i++) {
      const z = rest[i * 3 + 2];
      const dz = p[i * 3 + 2] - z;
      if (z > 2.0) {
        frontShift += dz;
        frontN++;
      }
      if (z < -1.5) tailMoved += Math.abs(p[i * 3 + 2] - z) + Math.abs(p[i * 3] - rest[i * 3]);
    }
    expect(frontN).toBeGreaterThan(50);
    expect(frontShift / frontN).toBeLessThan(-0.08);
    expect(tailMoved).toBeLessThan(0.5);
  });

  it('keeps normals unit length and finite, and a dent changes the shading of what it bends', () => {
    const v = car();
    const hull = new BodyMesh(v.body.geometry);
    hull.dent([0.7, 0.1, 2.2], [-0.4, 0, -0.9], 0.45, 0.8);
    hull.update(Infinity);
    const n = hull.geo.attributes.normal.array as Float32Array;
    const rn = v.body.geometry.attributes.normal.array as Float32Array;
    let changed = 0;
    for (let i = 0; i < n.length / 3; i++) {
      const l = Math.hypot(n[i * 3], n[i * 3 + 1], n[i * 3 + 2]);
      expect(Number.isFinite(l)).toBe(true);
      expect(l).toBeCloseTo(1, 3);
      if (Math.abs(n[i * 3] - rn[i * 3]) + Math.abs(n[i * 3 + 2] - rn[i * 3 + 2]) > 0.15) changed++;
    }
    expect(changed).toBeGreaterThan(20);
    const pos = hull.geo.attributes.position.array as Float32Array;
    for (let i = 0; i < pos.length; i++) expect(Number.isFinite(pos[i])).toBe(true);
  });

  it('a crash caps out: more hits do not fold the car through itself', () => {
    const v = car();
    const hull = new BodyMesh(v.body.geometry);
    for (let i = 0; i < 12; i++) hull.dent([0, 0, 2.3], [0, 0, -1], 0.6, 1);
    hull.update(Infinity);
    const rest = v.body.geometry.attributes.position.array as Float32Array;
    const p = posOf(hull.geo);
    let worst = 0;
    for (let i = 0; i < p.length / 3; i++) worst = Math.max(worst, Math.abs(p[i * 3 + 2] - rest[i * 3 + 2]));
    expect(worst).toBeGreaterThan(0.3);
    // Fold limit, plus the crumple noise on top.
    expect(worst).toBeLessThan(1.2);
    expect(hull.level()).toBeGreaterThan(0.2);
  });

  it('re-skins in budgeted slices so a big crash costs frames, not one long frame', () => {
    const v = car();
    const hull = new BodyMesh(v.body.geometry);
    hull.dent([0, 0.2, 0], [1, 0, 0], 0.5, 3);
    let slices = 0;
    while (hull.pending) {
      hull.update(2500);
      slices++;
      expect(slices).toBeLessThan(200);
    }
    expect(slices).toBeGreaterThan(2);
  });

  it('lets a part be lifted out with its dents, and hides it in the body', () => {
    const v = car();
    const hull = new BodyMesh(v.body.geometry);
    const door = hull.parts.find((g) => g.tag === 'door:1')!;
    expect(door).toBeDefined();
    const b = hull.bounds(door);
    hull.dent([b.centre[0], b.centre[1], b.centre[2]], [-1, 0, 0], 0.25, 0.7);
    hull.update(Infinity);
    const pivot = door.meta.pivot ?? b.centre;
    const geo = hull.extract(door, pivot);
    let nv = 0;
    let ni = 0;
    for (const r of door.ranges) {
      nv += r.v1 - r.v0;
      ni += r.i1 - r.i0;
    }
    expect(geo.attributes.position.count).toBe(nv);
    expect(geo.index!.count).toBe(ni);
    for (let i = 0; i < geo.index!.count; i++) expect(geo.index!.getX(i)).toBeLessThan(nv);
    // The extracted door is bent: its inner face has been pushed in.
    expect(geo.boundingBox).not.toBeNull();
    hull.hide(door, pivot);
    const p = posOf(hull.geo);
    for (const r of door.ranges) {
      for (let i = r.v0; i < Math.min(r.v1, r.v0 + 10); i++) {
        expect(p[i * 3]).toBeCloseTo(pivot[0], 5);
        expect(p[i * 3 + 2]).toBeCloseTo(pivot[2], 5);
      }
    }
    // Hidden vertices stay hidden through later skinning, and come back when it is shown again.
    hull.dent([0, 0, 0], [1, 0, 0], 0.2, 2);
    hull.update(Infinity);
    expect(posOf(hull.geo)[door.ranges[0].v0 * 3]).toBeCloseTo(pivot[0], 5);
    hull.show(door);
    expect(Math.abs(posOf(hull.geo)[door.ranges[0].v0 * 3] - pivot[0])).toBeGreaterThan(0.01);
  });

  it('replays saved crashes onto a rebuilt model to the same shape, and straightens when hammered', () => {
    const v = car();
    const hull = new BodyMesh(v.body.geometry);
    hull.dent([0.5, 0.1, 2.2], [-0.2, 0, -1], 0.35, 0.8);
    hull.dent([-0.9, 0.2, 0.3], [1, 0, 0], 0.2, 0.7);
    hull.dent([0.55, 0.12, 2.15], [-0.2, 0, -1], 0.1, 0.8);
    hull.update(Infinity);
    // Two of the three overlapped and were merged.
    expect(hull.events.length).toBe(2);
    const again = new BodyMesh(v.body.geometry);
    again.replay(hull.events);
    const a = posOf(hull.geo);
    const b = posOf(again.geo);
    // Two of the crashes overlapped and were merged, so the replay is the same shape to within a couple of centimetres.
    for (let i = 0; i < a.length; i += 17) expect(Math.abs(b[i] - a[i])).toBeLessThan(0.03);
    const rest = v.body.geometry.attributes.position.array as Float32Array;
    hull.straighten(1);
    hull.update(Infinity);
    const s = posOf(hull.geo);
    for (let i = 0; i < s.length; i += 13) expect(s[i]).toBeCloseTo(rest[i], 4);
    expect(hull.level()).toBe(0);
    expect(hull.events.length).toBe(0);
  });

  it('carries a lamp along with the panel it sits in', () => {
    const v = car();
    const hull = new BodyMesh(v.body.geometry);
    const lamp = v.headlights[0].position;
    const at: [number, number, number] = [lamp.x, lamp.y, lamp.z];
    const out = { x: 0, y: 0, z: 0, crush: 0 };
    expect(hull.sample(at, out).crush).toBe(0);
    hull.dent(at, [0, 0, -1], 0.4, 0.8);
    hull.sample(at, out);
    expect(out.z).toBeLessThan(-0.1);
    expect(out.crush).toBeGreaterThan(0.3);
  });
});

describe('the dirt shader hooks', () => {
  it('splices into the kit shader where it expects to (a change to the kit shader breaks this, not the paint)', () => {
    const shader = {
      uniforms: {},
      vertexShader: '#include <common>\nvoid main() {\n#include <project_vertex>\n}',
      fragmentShader:
        '#include <common>\nvoid main() {\n#include <color_fragment>\n#include <roughnessmap_fragment>\n#include <metalnessmap_fragment>\n#include <normal_fragment_maps>\n#include <emissivemap_fragment>\n}',
    };
    applyKit(shader as unknown as Parameters<typeof applyKit>[0], true);
    expect(patchSkin(shader)).toBe(true);
    expect(shader.fragmentShader).toContain('dirtCover');
    expect(shader.fragmentShader).toContain('dirtRough');
    expect(shader.vertexShader).toContain('vDirtP');
  });
});
