import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CHASSIS, PARTS, chassisDef, partDef } from '../src/data';
import { installPart, newBuild, removePart, removeTyre } from '../src/sim/garage';
import { newPart } from '../src/sim/parts';
import { buildVehicleVisual, lookOf } from '../src/render/vehicleModels';
import { wheelSpec, wheelSpecs } from '../src/render/vehicleKit';
import { makeCarryModel } from '../src/render/props';
import { partModelKey } from '../src/sim/carry';
import { wheelCentres } from '../src/render/sockets';

// The parts you fit show on the vehicle: a bare wheel is a rim, a missing door is a gap, an exposed engine bay has an
// engine in it.

function visual(chassis: string, edit: (b: ReturnType<typeof newBuild>) => void = () => {}) {
  const b = newBuild(chassis, { seed: 5 });
  edit(b);
  const def = chassisDef(chassis);
  const wl = wheelCentres(def);
  const v = buildVehicleVisual(def, wl, wl.map((_, i) => i < 2), lookOf(b));
  return { v, b, tris: (v.body.geometry.index?.count ?? v.body.geometry.attributes.position.count) / 3 };
}

describe('wheels, one tyre at a time', () => {
  it('the look carries a grade per wheel: factory 0, bare -1, aftermarket 1..3', () => {
    const b = newBuild('sedan', { seed: 1 });
    installPart(b, newPart('whl_bl', 1), 1);
    removeTyre(b, 3);
    expect(lookOf(b).tyres).toEqual([0, 3, 0, -1]);
    expect(lookOf(newBuild('sedan', { seed: 1 })).tyres).toBeUndefined();
  });

  it('a bare wheel is a rim: different geometry, no tyre to puncture, still spins', () => {
    const def = chassisDef('sedan');
    const bare = wheelSpec(def, -1);
    expect(bare.style.bare).toBe(true);
    const { v } = visual('sedan', (b) => removeTyre(b, 0));
    expect(v.wheels).toHaveLength(4);
    expect(v.wheels[0].bare).toBe(true);
    expect(v.wheels[1].bare).toBe(false);
    const tri = (i: number) => (v.wheels[i].spin.children[0] as THREE.Mesh).geometry.attributes.position.count;
    expect(tri(0)).not.toBe(tri(1));
  });

  it('a mixed set builds a different model per wheel', () => {
    const specs = wheelSpecs(chassisDef('pickup'), [3, 0, 2, 0], 0);
    expect(specs).toHaveLength(4);
    expect(specs[0].width).toBeGreaterThan(specs[1].width);
    expect(specs[2].style.tread).toBe('knobby');
  });

  it('better brakes show as painted calipers behind the rim, and stripped ones as no disc at all', () => {
    const def = chassisDef('sedan');
    expect(wheelSpec(def, 0, 3).style.caliper).toBeDefined();
    expect(wheelSpec(def, 0, 2).style.caliper).not.toBe(wheelSpec(def, 0, 3).style.caliper);
    expect(wheelSpec(def, 0, 0).style.caliper).toBeUndefined();
    expect(wheelSpec(def, 0, -1).style.noBrake).toBe(true);
  });
});

describe('body panels really come off', () => {
  it('a door off changes the shell; so does the bonnet; putting them back restores it', () => {
    const base = visual('sedan');
    const noDoor = visual('sedan', (b) => removePart(b, 'doorL'));
    const noHood = visual('sedan', (b) => removePart(b, 'hood'));
    expect(noDoor.tris).not.toBe(base.tris);
    expect(noHood.tris).not.toBe(base.tris);
    const back = visual('sedan', (b) => {
      removePart(b, 'doorL');
      installPart(b, newPart('door_std', 1), 'doorL');
    });
    expect(back.tris).toBe(base.tris);
  });

  it('with the bonnet off the engine is on show, bigger for a bigger engine, and nothing at all for an empty bay', () => {
    const small = visual('hatch', (b) => removePart(b, 'hood'));
    const big = visual('hatch', (b) => {
      installPart(b, newPart('eng_v8', 1));
      removePart(b, 'hood');
    });
    const empty = visual('hatch', (b) => {
      removePart(b, 'engine');
      removePart(b, 'hood');
    });
    expect(big.tris).toBeGreaterThan(small.tris);
    expect(small.tris).toBeGreaterThan(empty.tris);
  });

  it('every kind of bonnet and door looks different from the factory one', () => {
    const base = visual('pickup').tris;
    for (const id of ['hood_vent', 'hood_scoop', 'hood_armor']) {
      const t = visual('pickup', (b) => installPart(b, newPart(id, 1))).tris;
      expect(t, id).not.toBe(base);
    }
    for (const id of ['door_light', 'door_plate', 'door_armor']) {
      const t = visual('pickup', (b) => installPart(b, newPart(id, 1), 'doorL')).tris;
      expect(t, id).not.toBe(base);
    }
  });

  it('the buggy bonnet comes off too, leaving the bay', () => {
    const base = visual('buggy');
    const off = visual('buggy', (b) => removePart(b, 'hood'));
    expect(off.tris).not.toBe(base.tris);
  });
});

describe('the rest of the machine shows', () => {
  it('exhausts, springs and gearboxes add geometry; the factory ones add none', () => {
    const base = visual('sedan').tris;
    for (const id of ['exh_free', 'exh_quiet', 'exh_race', 'exh_stack']) expect(visual('sedan', (b) => installPart(b, newPart(id, 1))).tris, id).toBeGreaterThan(base);
    for (const id of ['sus_sport', 'sus_heavy', 'sus_long', 'sus_air']) expect(visual('sedan', (b) => installPart(b, newPart(id, 1))).tris, id).toBeGreaterThan(base);
    expect(visual('sedan', (b) => installPart(b, newPart('gbx_heavy', 1))).tris).toBeGreaterThan(base);
    expect(visual('sedan', (b) => installPart(b, newPart('gbx_sport', 1))).tris).toBe(base);
    expect(visual('sedan', (b) => installPart(b, newPart('exh_free', 1))).tris).toBeGreaterThan(base);
  });

  it('every chassis still builds with everything fitted', () => {
    for (const id of Object.keys(CHASSIS)) {
      const def = chassisDef(id);
      if (!def.seat) continue;
      expect(() =>
        visual(id, (b) => {
          for (const p of ['exh_stack', 'sus_long', 'brk_race', 'gbx_transfer', 'hood_scoop', 'door_armor']) installPart(b, newPart(p, 1));
        }),
      ).not.toThrow();
    }
  });
});

describe('carried parts have a model each', () => {
  it('every part in the catalogue maps to a model the pickup factory can build, and the kinds are told apart', () => {
    const keys = new Set<string>();
    for (const d of PARTS.parts) {
      const key = partModelKey(d.id);
      keys.add(key);
      const m = makeCarryModel(key);
      const mesh = m.children[0] as THREE.Mesh;
      expect(mesh.geometry.attributes.position.count, d.id).toBeGreaterThan(50);
    }
    // Every part has a model of its own now (render/gearParts.ts), keyed by its id.
    for (const k of ['part:gbx_', 'part:sus_', 'part:brk_', 'part:exh_', 'part:hood_', 'part:door_', 'part:eng_', 'part:rad_', 'part:whl_', 'part:tyre_']) expect([...keys].some((x) => x.startsWith(k)), k).toBe(true);
    expect(partDef('gbx_race').slot).toBe('gearbox');
  });
});
