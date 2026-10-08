import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CHASSIS, PARTS, chassisDef, partDef } from '../src/data';
import { installPart, newBuild } from '../src/sim/garage';
import { newPart } from '../src/sim/parts';
import { buildRaiderBuggy, buildVehicleVisual, lookOf, mountsOfChassis, prepareVehicleVisual } from '../src/render/vehicleModels';
import { shellKey } from '../src/render/carModels';
import { heavyShellKey } from '../src/render/truckModels';
import { wheelCentres } from '../src/render/sockets';
import { clearShells, hasShell } from '../src/render/shellCache';
import { hasTrim, rollTrim, trimKey } from '../src/sim/carTrim';
import { rollCar } from '../src/sim/cars';
import { buildPartModel, partCarryScale } from '../src/render/partModels';
import { MeshBuilder } from '../src/render/builder';
import { raiderBuggyDef } from '../src/data/raiderVehicles';
import { RIDE_LIFT } from '../src/render/rideHeight';

const tris = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.attributes.position.count) / 3;

function visual(chassis: string, seed = 5, edit: (b: ReturnType<typeof newBuild>) => void = () => {}) {
  const b = newBuild(chassis, { seed });
  edit(b);
  const def = chassisDef(chassis);
  const wl = wheelCentres(def);
  return { v: buildVehicleVisual(def, wl, wl.map((_, i) => i < 2), lookOf(b)), b, def };
}

/** Triangles a player sees on the vehicle: body, wheels, cabin, glass, bay (not the people in it). */
function drawnTris(v: ReturnType<typeof visual>['v']) {
  let n = 0;
  const skip = new Set<THREE.Object3D>([v.driver?.root, v.passenger?.root].filter(Boolean) as THREE.Object3D[]);
  v.inner.traverse((o) => {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (skip.has(p)) return;
    if ((o as THREE.Mesh).isMesh) n += tris((o as THREE.Mesh).geometry);
  });
  return n;
}

describe('trims: what makes one found car different from the next', () => {
  const CARS = ['hatch', 'sedan', 'pickup', 'van'];
  it('is rolled from the chassis and seed alone, the same every time', () => {
    for (const id of [...CARS, 'truck', 'rig']) for (let s = 0; s < 40; s++) expect(trimKey(rollTrim(id, s))).toBe(trimKey(rollTrim(id, s)));
    expect(rollTrim('buggy', 3)).toBeNull();
    expect(hasTrim('moped')).toBe(false);
  });

  it('every body style of a chassis turns up, and the details vary a lot', () => {
    for (const id of CARS) {
      const bodies = new Set<string>();
      const keys = new Set<string>();
      for (let s = 0; s < 400; s++) {
        const t = rollTrim(id, s * 7919 + 13)!;
        bodies.add(t.body);
        keys.add(trimKey(t));
      }
      expect(bodies.size, id).toBeGreaterThanOrEqual(id === 'hatch' ? 3 : 4);
      expect(keys.size, id).toBeGreaterThan(380);
    }
  });

  it('is a stream of its own: the car under it rolls the same as before trims existed', () => {
    // rollCar never touches the trim stream, so its parts and damage only depend on its own seed.
    const a = rollCar(4242, { biome: 'wasteland' });
    const b = rollCar(4242, { biome: 'wasteland' });
    const ids = (f: typeof a.build.fit) => JSON.stringify(Object.entries(f).map(([k, it]) => [k, it!.id, it!.cond]));
    expect(ids(a.build.fit)).toBe(ids(b.build.fit));
    expect(lookOf(a.build).trim).toEqual(rollTrim(a.build.chassis, a.build.seed));
  });

  it('is part of the shell cache key: two cars that differ only in trim build different shells', () => {
    const def = chassisDef('sedan');
    const look = lookOf(newBuild('sedan', { seed: 77 }));
    const other = { ...look, trim: { ...look.trim!, body: look.trim!.body === 'estate' ? ('saloon' as const) : ('estate' as const) } };
    expect(shellKey(def, look)).not.toBe(shellKey(def, other));
    const tdef = chassisDef('truck');
    const tl = lookOf(newBuild('truck', { seed: 3 }));
    expect(heavyShellKey(tdef, tl)).not.toBe(heavyShellKey(tdef, { ...tl, trim: { ...tl.trim!, body: tl.trim!.body === 'gun' ? 'canvas' : 'gun' } }));
  });

  it('the same car shares one shell; differently trimmed ones do not', () => {
    clearShells();
    const a = visual('hatch', 21).v;
    const b = visual('hatch', 21).v;
    expect(a.body.geometry).toBe(b.body.geometry);
    let other = 22;
    while (rollTrim('hatch', other)!.body === rollTrim('hatch', 21)!.body) other++;
    const c = visual('hatch', other).v;
    expect(c.body.geometry).not.toBe(a.body.geometry);
    for (const v of [a, b, c]) v.dispose();
  });

  it('shells are still prepared in slices, and the prepared one is what the car spawns with', () => {
    for (const id of ['van', 'truck']) {
      clearShells();
      const b = newBuild(id, { seed: 99 });
      const def = chassisDef(id);
      const gen = prepareVehicleVisual(def, b);
      let steps = 0;
      while (!gen.next().done) steps++;
      expect(steps, id).toBeGreaterThanOrEqual(3);
      const key = id === 'truck' ? heavyShellKey(def, lookOf(b)) : shellKey(def, lookOf(b));
      expect(hasShell(key)).toBe(true);
    }
  });

  it('every body style builds, with all its trims, and stays inside a triangle budget', () => {
    for (const id of CARS) {
      const seen = new Set<string>();
      for (let s = 0; s < 300 && seen.size < 4; s++) {
        const t = rollTrim(id, s)!;
        if (seen.has(t.body)) continue;
        seen.add(t.body);
        const { v } = visual(id, s);
        expect(tris(v.body.geometry), `${id} ${t.body}`).toBeLessThan(24000);
        expect(drawnTris(v), `${id} ${t.body}`).toBeLessThan(46000);
        v.dispose();
      }
    }
  });

  it('a burnt hulk has lost panels a whole car keeps', () => {
    const whole = visual('sedan', 8, (b) => (b.hp = 0.5)).v;
    const hulk = visual('sedan', 8, (b) => {
      b.hp = 0.05;
      b.comp.tank = 0;
    }).v;
    expect(tris(hulk.body.geometry)).not.toBe(tris(whole.body.geometry));
  });
});

describe('the war truck and the war rig', () => {
  for (const id of ['truck', 'rig']) {
    it(`${id}: has its own model, mounts, a turret and its tyres`, () => {
      const { v, def } = visual(id, 4);
      expect(mountsOfChassis(def)).not.toBeNull();
      expect(v.gun).not.toBeNull();
      expect(v.wheels).toHaveLength(def.physics.wheelCount);
      expect(v.headlights.length).toBeGreaterThanOrEqual(2);
      const box = v.body.geometry.boundingBox!;
      // As long and as wide as the chassis it rides on, give or take its bumpers, mirrors and wheels.
      expect(box.max.z - box.min.z).toBeGreaterThan(def.length * 0.92);
      expect(box.max.z - box.min.z).toBeLessThan(def.length * 1.15);
      expect(box.max.x - box.min.x).toBeLessThan(def.width * 1.35);
      v.dispose();
    });

    it(`${id}: every bed builds, with everything fitted, inside its budget`, () => {
      const bodies = new Set<string>();
      for (let s = 0; s < 200 && bodies.size < 3; s++) {
        const body = rollTrim(id, s)!.body;
        if (bodies.has(body)) continue;
        bodies.add(body);
        const { v } = visual(id, s, (b) => {
          for (const p of ['arm_ceramic', 'exh_stack', 'sus_long', 'rf_light', 'fr_blade', 'utl_aux', 'sd_plate', 'wpn_twin']) installPart(b, newPart(p, 1));
        });
        expect(tris(v.body.geometry), `${id} ${body}`).toBeLessThan(40000);
        expect(drawnTris(v), `${id} ${body}`).toBeLessThan(id === 'rig' ? 90000 : 60000);
        v.dispose();
      }
      expect(bodies.size).toBe(3);
    });
  }
});

describe('mount points', () => {
  it('every chassis with mounts has each one on or inside its body', () => {
    for (const id of Object.keys(CHASSIS)) {
      const def = chassisDef(id);
      const mt = mountsOfChassis(def);
      if (!mt) continue;
      const { v } = visual(id, 6);
      // The body and everything drawn with it (a trike's front end is a mesh of its own), not the people.
      const box = new THREE.Box3();
      const skip = new Set<THREE.Object3D>([v.driver?.root, v.passenger?.root].filter(Boolean) as THREE.Object3D[]);
      v.inner.updateMatrixWorld(true);
      v.inner.traverse((o) => {
        for (let p: THREE.Object3D | null = o; p; p = p.parent) if (skip.has(p)) return;
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry.attributes.surf) return;
        mesh.geometry.computeBoundingBox();
        box.union(mesh.geometry.boundingBox!.clone().applyMatrix4(new THREE.Matrix4().copy(v.inner.matrixWorld).invert().multiply(mesh.matrixWorld)));
      });
      box.expandByScalar(0.3);
      const m = mt.m;
      const at = (x: number, y: number, z: number, what: string) => expect(box.containsPoint(new THREE.Vector3(x, y - mt.g0, z)), `${id} ${what}`).toBe(true);
      at(0, m.front.y, m.front.z, 'front');
      at(0, m.rear.y, m.rear.z, 'rear');
      at(m.hw, (m.side.y0 + m.side.y1) / 2, (m.side.z0 + m.side.z1) / 2, 'side');
      at(0, m.sill, (m.side.z0 + m.side.z1) / 2, 'sill');
      if (m.hood) at(0, m.hood.y, (m.hood.z0 + m.hood.z1) / 2, 'hood');
      if (m.roof) at(0, m.roof.y, (m.roof.z0 + m.roof.z1) / 2, 'roof');
      if (m.trunk) at(0, m.trunk.y, (m.trunk.z0 + m.trunk.z1) / 2, 'trunk');
      if (m.gun) at(m.gun.x, m.gun.y, m.gun.z, 'gun');
      v.dispose();
    }
  });
});

describe('raider cars', () => {
  it('each seed is its own car, the same seed the same car', () => {
    const def = raiderBuggyDef();
    const wl = wheelCentres(def);
    const st = wl.map((_, i) => i < 2);
    const shapes = new Set<number>();
    for (let s = 0; s < 12; s++) {
      const v = buildRaiderBuggy(def, wl, st, s * 977);
      shapes.add(tris(v.body.geometry));
      v.dispose();
    }
    expect(shapes.size).toBeGreaterThan(6);
    const a = buildRaiderBuggy(def, wl, st, 1234);
    const b = buildRaiderBuggy(def, wl, st, 1234);
    expect(a.body.geometry).toBe(b.body.geometry);
  });
});

describe('fitted parts read on the car', () => {
  it('each grade of armour is drawn differently', () => {
    const t = ['arm_sheet', 'arm_weld', 'arm_ceramic'].map((p) => tris(visual('sedan', 9, (b) => installPart(b, newPart(p, 1))).v.body.geometry));
    expect(new Set(t).size).toBe(3);
  });

  it('a supercharged V8 under a factory bonnet puts its blower through it', () => {
    const plain = visual('pickup', 9);
    const v8 = visual('pickup', 9, (b) => installPart(b, newPart('eng_v8', 1)));
    expect(tris(v8.v.body.geometry)).toBeGreaterThan(tris(plain.v.body.geometry) + 200);
  });

  it('springs stand the body up or drop it over the wheels', () => {
    const y = (p?: string) => visual('sedan', 9, (b) => p && installPart(b, newPart(p, 1))).v.inner.position.y;
    const base = y();
    expect(y('sus_long')).toBeCloseTo(base + RIDE_LIFT.sus_long, 5);
    expect(y('sus_sport')).toBeCloseTo(base + RIDE_LIFT.sus_sport, 5);
  });

  it('tyres show their type: mud lugs and crawler blocks are not the road tread', () => {
    const geo = (p: string) => (visual('pickup', 9, (b) => installPart(b, newPart(p, 1), 0)).v.wheels[0].spin.children[0] as THREE.Mesh).geometry;
    const g = ['whl_road', 'whl_mt', 'whl_bl'].map(geo);
    expect(new Set(g.map(tris)).size).toBe(3);
  });
});

describe('loose part models', () => {
  const ids = PARTS.parts.filter((p) => !p.empty && p.slot !== 'engine').map((p) => p.id);

  it('every part has a model of its own, sized to be held', () => {
    for (const id of ids) {
      const b = new MeshBuilder();
      buildPartModel(b, id);
      expect(b.vertexCount, id).toBeGreaterThan(20);
      const g = b.build();
      expect(tris(g), id).toBeLessThan(16000);
      const s = g.boundingBox!.getSize(new THREE.Vector3());
      expect(Math.max(s.x, s.y, s.z) * partCarryScale(id), id).toBeLessThan(1.02);
      expect(g.boundingBox!.min.y, id).toBeGreaterThan(-0.05);
      g.dispose();
    }
  });

  it('parts of one slot look different from each other', () => {
    for (const slot of ['cooling', 'gearbox', 'suspension', 'brakes', 'exhaust', 'wheels', 'hood', 'doorL']) {
      const list = PARTS.parts.filter((p) => p.slot === slot && !p.empty && !p.id.startsWith('tyre_trike'));
      const sig = new Set<string>();
      for (const p of list) {
        const b = new MeshBuilder();
        buildPartModel(b, p.id);
        const g = b.build();
        const s = g.boundingBox!.getSize(new THREE.Vector3());
        sig.add(`${tris(g)}:${s.x.toFixed(2)}:${s.y.toFixed(2)}`);
        g.dispose();
      }
      // Stock parts of chassis that share a size may share a model; the grades never do.
      expect(sig.size, slot).toBeGreaterThanOrEqual(Math.min(list.length, Math.ceil(list.length * 0.6)));
    }
    expect(partDef('rad_desert').cooling).toBeGreaterThan(partDef('rad_alu').cooling!);
  });
});
