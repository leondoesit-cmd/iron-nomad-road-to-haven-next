import { describe, expect, it } from 'vitest';
import './helpers/sim';
import * as THREE from 'three';
import { chassisDef, wheelLayout } from '../src/data';
import { newBuild, type VehicleBuild } from '../src/sim/garage';
import { newPart } from '../src/sim/parts';
import { buildVehicleVisual, lookOf, mountsOfChassis } from '../src/render/vehicleModels';
import { MeshBuilder } from '../src/render/builder';
import { buildPartModel } from '../src/render/partModels';
import { TRIKE_MOUNTS } from '../src/render/trikeModel';
import type { VehicleVisual } from '../src/render/vehicleKit';

// The Rickshaw Trike's model: a chopper front end on a subframe with a tin cab, built from what is fitted.

const def = chassisDef('trike');
const layout = wheelLayout(def.physics);

/** The visual the game builds for a build: wheels at the physics' connection points, as `Vehicle.makeVisual` passes them. */
function visual(edit: (b: VehicleBuild) => void = () => {}) {
  const b = newBuild('trike', { seed: 7 });
  edit(b);
  const wl = layout.map((w) => [w.x, w.y, w.z] as [number, number, number]);
  return buildVehicleVisual(def, wl, layout.map((w) => w.steer), lookOf(b));
}
const full = () => visual((b) => (b.fit.rear = newPart('rr_rickshaw', 0.7)));
const stripped = () =>
  visual((b) => {
    b.fit.engine = newPart('eng_none', 1);
    b.tyres = b.tyres.map(() => newPart('tyre_none', 1));
    delete b.fit.rear;
  });

const tris = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.attributes.position.count) / 3;

/** Bounds of the machine itself, without the rider. */
function bounds(v: VehicleVisual) {
  v.driver?.root.removeFromParent();
  v.inner.updateMatrixWorld(true);
  const bb = new THREE.Box3();
  v.inner.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.computeBoundingBox();
    bb.union(m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld.clone().premultiply(v.inner.matrixWorld.clone().invert())));
  });
  return bb;
}

/** All triangles drawn for the vehicle (body, the steering front end, the wheels), without the rider. */
function allTris(v: VehicleVisual) {
  let n = 0;
  v.inner.traverse((o) => {
    if (v.driver && isUnder(o, v.driver.root)) return;
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry.attributes.surf) n += tris(m.geometry);
  });
  return n;
}
function isUnder(o: THREE.Object3D, root: THREE.Object3D) {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p === root) return true;
  return false;
}

describe('rickshaw trike model', () => {
  it('is the size of the chassis, with the cab on', () => {
    const v = full();
    const bb = bounds(v);
    const size = bb.getSize(new THREE.Vector3());
    expect(size.z).toBeGreaterThan(2.6);
    expect(size.z).toBeLessThan(3.3);
    expect(size.x).toBeGreaterThan(1.2);
    expect(size.x).toBeLessThan(1.6);
    // From the tyres on the ground (about -0.57 at rest, -0.67 on full droop) to the cab roof.
    expect(bb.min.y).toBeGreaterThan(-0.72);
    expect(bb.min.y).toBeLessThan(-0.6);
    expect(bb.max.y).toBeGreaterThan(1.05);
    expect(bb.max.y).toBeLessThan(1.3);
    expect(bb.max.z).toBeGreaterThan(1.25);
    expect(bb.min.z).toBeLessThan(-1.6);
  });

  it('has three wheels where the physics hangs them, the front one steering', () => {
    const v = full();
    expect(v.wheels).toHaveLength(3);
    const at = v.wheels.map((w) => w.pivot.position.toArray());
    expect(at[0][0]).toBeCloseTo(0, 3);
    expect(at[0][1]).toBeCloseTo(-0.34, 3);
    expect(at[0][2]).toBeCloseTo(0.98, 3);
    for (const [i, sx] of [[1, 1], [2, -1]] as const) {
      expect(at[i][0]).toBeCloseTo(sx * 0.6, 3);
      expect(at[i][1]).toBeCloseTo(-0.41, 3);
      expect(at[i][2]).toBeCloseTo(-0.8, 3);
      expect(v.wheels[i].radius).toBeCloseTo(0.26, 3);
      expect(v.wheels[i].steered).toBe(false);
    }
    expect(v.wheels[0].radius).toBeCloseTo(0.33, 3);
    expect(v.wheels[0].steered).toBe(true);
    // Every wheel has its model; the right-hand one is mirrored so its face looks out.
    for (const w of v.wheels) expect(w.spin.children).toHaveLength(1);
    expect((v.wheels[2].spin.children[0] as THREE.Mesh).scale.x).toBe(-1);
  });

  it('keeps the body under its triangle budget', () => {
    const v = full();
    expect(tris(v.body.geometry)).toBeLessThan(25000);
    expect(allTris(v)).toBeLessThan(34000);
    const bare = stripped();
    expect(tris(bare.body.geometry)).toBeLessThan(tris(v.body.geometry));
  });

  it('stripped (no engine, no wheels, no cab) is a frame on stands', () => {
    const v = stripped();
    expect(v.wheels).toHaveLength(3);
    for (const w of v.wheels) {
      expect(w.spin.children).toHaveLength(0);
      expect(w.bare).toBe(true);
    }
    // Still the length of the machine, but no roof: nothing much above the bars.
    const bb = bounds(v);
    expect(bb.max.y).toBeLessThan(1.0);
    expect(bb.getSize(new THREE.Vector3()).z).toBeGreaterThan(2.4);
    // The stands reach the ground under the corners.
    expect(bb.min.y).toBeLessThan(-0.56);
  });

  it('the engine shows in the cradle when there is one', () => {
    const withEngine = visual();
    const without = visual((b) => (b.fit.engine = newPart('eng_none', 1)));
    expect(tris(withEngine.body.geometry)).toBeGreaterThan(tris(without.body.geometry) + 500);
    // The cab adds a great deal.
    expect(tris(full().body.geometry)).toBeGreaterThan(tris(withEngine.body.geometry) + 2000);
  });

  it('mounts: the cab floor is the deck, and the chassis reports them', () => {
    expect(mountsOfChassis(def)?.m).toBe(TRIKE_MOUNTS);
    const t = TRIKE_MOUNTS.trunk!;
    expect(t.y).toBeCloseTo(-0.2, 2);
    expect(t.z1).toBeGreaterThan(t.z0);
    expect(TRIKE_MOUNTS.narrow).toBe(true);
  });

  it('the rider holds the grips, and they follow the bars round', () => {
    const v = full();
    const d = v.driver!;
    v.root.updateMatrixWorld(true);
    const hand = () => {
      v.root.updateMatrixWorld(true);
      return v.inner.worldToLocal(d.handL.getWorldPosition(new THREE.Vector3()));
    };
    d.update(0, 'ride', 0, 0, 0);
    v.seat!('driver', d, 0);
    const straight = hand();
    // The left grip is at about (0.41, 0.64, 0.42).
    expect(straight.distanceTo(new THREE.Vector3(0.405, 0.643, 0.424))).toBeLessThan(0.09);
    // Steer left: the game turns the wheel pivot; the bars swing and the hand goes with them.
    v.wheels[0].pivot.rotation.y = 0.45;
    d.update(0, 'ride', 0, 0, 0);
    v.seat!('driver', d, 0);
    const turned = hand();
    expect(turned.z).toBeLessThan(straight.z - 0.05);
    // The fork turned too: the front end is no longer where it was.
    const steerGroup = v.wheels[0].pivot.children[0];
    expect(steerGroup.quaternion.angleTo(new THREE.Quaternion())).toBeGreaterThan(0.01);
  });

  it('the passenger sits on the bench', () => {
    const v = full();
    const p = v.lazy!.passenger!();
    v.inner.add(p.root);
    v.passenger = p;
    p.update(0, 'gun', 0, 1, 0);
    v.seat!('passenger', p, 0);
    v.root.updateMatrixWorld(true);
    const hips = v.inner.worldToLocal(p.hips.getWorldPosition(new THREE.Vector3()));
    expect(hips.y).toBeGreaterThan(0.15);
    expect(hips.y).toBeLessThan(0.35);
    expect(hips.z).toBeLessThan(-1.2);
    expect(hips.z).toBeGreaterThan(-1.5);
    // The feet come down to the cab floor.
    const foot = v.inner.worldToLocal(p.kneeL.localToWorld(new THREE.Vector3(0, -0.43, 0)));
    expect(foot.y).toBeLessThan(-0.05);
    expect(foot.y).toBeGreaterThan(-0.2);
    expect(v.gunSeat[2]).toBeCloseTo(hips.z, 1);
  });
});

describe('rickshaw trike parts', () => {
  it.each(['rr_rickshaw', 'tyre_trike', 'tyre_trike_r', 'sus_lift'])('%s has a model of its own, standing on its base', (id) => {
    const b = new MeshBuilder();
    buildPartModel(b, id);
    expect(b.vertexCount).toBeGreaterThan(100);
    const g = b.build();
    const bb = g.boundingBox!;
    expect(bb.min.y).toBeGreaterThan(-0.03);
    expect(bb.min.y).toBeLessThan(0.03);
    const size = bb.getSize(new THREE.Vector3());
    expect(Math.max(size.x, size.z)).toBeGreaterThan(0.4);
    expect(Math.max(size.x, size.y, size.z)).toBeLessThan(1.6);
    expect(tris(g)).toBeLessThan(14000);
    for (let i = 0; i < g.attributes.position.count * 3; i++) expect(Number.isFinite((g.attributes.position.array as Float32Array)[i])).toBe(true);
  });

  it('the cab part is the same model as the cab on the trike', () => {
    const b = new MeshBuilder();
    buildPartModel(b, 'rr_rickshaw');
    const size = b.build().boundingBox!.getSize(new THREE.Vector3());
    expect(size.x).toBeGreaterThan(1.25);
    expect(size.x).toBeLessThan(1.45);
    expect(size.y).toBeGreaterThan(1.3);
    expect(size.z).toBeGreaterThan(1.3);
  });

  it('wheels lie flat: a laced one and a smaller pressed-steel one', () => {
    const f = new MeshBuilder();
    buildPartModel(f, 'tyre_trike');
    const r = new MeshBuilder();
    buildPartModel(r, 'tyre_trike_r');
    const fs = f.build().boundingBox!.getSize(new THREE.Vector3());
    const rs = r.build().boundingBox!.getSize(new THREE.Vector3());
    expect(fs.x).toBeCloseTo(0.66, 1);
    expect(rs.x).toBeCloseTo(0.52, 1);
    expect(fs.y).toBeLessThan(0.15);
    expect(rs.y).toBeLessThan(0.2);
  });
});
