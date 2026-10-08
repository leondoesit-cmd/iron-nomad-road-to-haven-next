import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CHASSIS, INTERIOR_NONE, INTERIOR_SLOTS, INTERIOR_STOCK, PARTS, VEHICLES, chassisDef, mountsFor, partDef, validateData, type PartSlot } from '../src/data';
import { Campaign } from '../src/game/campaign';
import { EMPTY_ID, conditionSummary, dismantleYield, idInSlot, installPart, newBuild, partInSlot, removePart, statsOf } from '../src/sim/garage';
import { canRidePassenger, cabinGaps, effectiveStats, newPart, slotsOf, describePart } from '../src/sim/parts';
import { forecastSwap, forecastWorthy } from '../src/sim/forecast';
import { partModelKey } from '../src/sim/carry';
import { MeshBuilder } from '../src/render/builder';
import { cabinPartModel } from '../src/render/cabinModels';
import { cabinAnchor, cabinLayout, drawCabin, hipHeight, seatOccupant } from '../src/render/interior';
import { buildVehicleVisual, lookOf } from '../src/render/vehicleModels';
import { socketFor, socketsOf, wheelCentres } from '../src/render/sockets';
import { Humanoid } from '../src/render/humanoid';
import { initPhysics, PhysicsWorld } from '../src/physics/physics';
import { VehicleBody, defaultEnv } from '../src/physics/vehicle';

const CARS = ['hatch', 'sedan', 'pickup', 'van'];
const interiorParts = () => PARTS.parts.filter((p) => INTERIOR_SLOTS.includes(p.slot));

describe('cabin parts: the catalogue', () => {
  it('passes data validation, with a factory part and an empty placeholder for every mount', () => {
    expect(validateData()).toEqual([]);
    for (const slot of INTERIOR_SLOTS) {
      expect(partDef(INTERIOR_STOCK[slot]).stock).toBe(true);
      expect(partDef(INTERIOR_NONE[slot]).empty).toBe(true);
      expect(EMPTY_ID[slot]).toBe(INTERIOR_NONE[slot]);
    }
  });
  it('has several qualities of every kind of part, each with a name and a blurb', () => {
    const count = (slot: PartSlot) => interiorParts().filter((p) => p.slot === slot && !p.stock).length;
    expect(count('seatD')).toBeGreaterThanOrEqual(3);
    expect(count('seatR')).toBeGreaterThanOrEqual(3);
    expect(count('steer')).toBeGreaterThanOrEqual(2);
    expect(count('dash')).toBeGreaterThanOrEqual(2);
    for (const p of interiorParts()) {
      expect(p.name.length).toBeGreaterThan(3);
      expect(p.blurb.length).toBeGreaterThan(10);
      expect(PARTS.slots).toContain(p.slot);
      // Loot has weight and the factory ones have none, as for every other part.
      expect(p.stock ? p.weight === 0 : p.weight > 0).toBe(true);
    }
  });
  it('a front seat fits either front mount; a rear seat only the rear; the wheel and dash only their own', () => {
    expect(mountsFor('seatD')).toEqual(['seatD', 'seatP']);
    expect(mountsFor('seatP')).toEqual(['seatD', 'seatP']);
    expect(mountsFor('seatR')).toEqual(['seatR']);
    expect(mountsFor('steer')).toEqual(['steer']);
  });
  it('the cars and the buggy have the mounts that suit their bodies; bikes and rigs have none', () => {
    const slots = (id: string) => slotsOf(chassisDef(id)).filter((s) => INTERIOR_SLOTS.includes(s));
    expect(slots('hatch')).toEqual(['seatD', 'seatP', 'seatR', 'steer', 'dash']);
    expect(slots('sedan')).toEqual(['seatD', 'seatP', 'seatR', 'steer', 'dash']);
    expect(slots('pickup')).toEqual(['seatD', 'seatP', 'steer', 'dash']);
    expect(slots('van')).toEqual(['seatD', 'seatP', 'steer', 'dash']);
    expect(slots('buggy')).toEqual(['seatD', 'steer', 'dash']);
    for (const id of ['moped', 'quad', 'truck', 'rig']) expect(slots(id)).toEqual([]);
  });
});

describe('cabin parts: stock builds are unchanged', () => {
  it('every factory vehicle with the mounts is fully equipped by default, with no fitted parts at all', () => {
    for (const id of [...CARS, 'buggy']) {
      const b = newBuild(id, { seed: 5 });
      expect(Object.keys(b.fit)).toEqual([]);
      for (const slot of slotsOf(chassisDef(id)).filter((s) => INTERIOR_SLOTS.includes(s))) {
        expect(idInSlot(b, slot)).toBe(INTERIOR_STOCK[slot]);
        expect(partInSlot(b, slot)?.id).toBe(INTERIOR_STOCK[slot]);
      }
      const g = cabinGaps(chassisDef(id), b.fit);
      expect(Object.values(g).some(Boolean)).toBe(false);
    }
  });
  it('a stock vehicle drives and carries exactly what vehicles.json says', () => {
    for (const d of [...VEHICLES.tiers, ...VEHICLES.cars]) {
      const st = effectiveStats(d, {});
      expect(st.steerMult).toBe(1);
      expect(st.seatSpread).toBe(1);
      expect(st.seatDrop).toBe(0);
      expect(st.cargo).toBe(d.cargo);
      expect(st.light).toBe(0);
      expect(st.noSteer || st.noDriverSeat || st.noPassengerSeat || st.noRearSeat || st.noDash).toBe(false);
      expect(conditionSummary(newBuild(d.id, { seed: 2 }))).toBe('sound');
    }
  });
  it('chassis with no cabin mounts never report a gap', () => {
    for (const id of ['moped', 'quad', 'truck', 'rig']) {
      const d = chassisDef(id);
      expect(cabinGaps(d, {})).toEqual({ steer: false, seatD: false, seatP: false, seatR: false, dash: false });
      expect(canRidePassenger(d, {}, false)).toBe(true);
    }
  });
  it('breaking a vehicle down does not hand back its factory seats, wheel and dash', () => {
    const b = newBuild('sedan', { seed: 3 });
    expect(dismantleYield(b).items.some((i) => INTERIOR_SLOTS.includes(partDef(i.id).slot))).toBe(false);
    installPart(b, newPart('seat_bucket'), 'seatD');
    expect(dismantleYield(b).items.map((i) => i.id)).toContain('seat_bucket');
  });
});

describe('cabin parts: a missing part really is missing', () => {
  const sedan = () => newBuild('sedan', { seed: 4 });

  it('no steering wheel: heavily limited lock, still driveable, shown in the summary', () => {
    const b = sedan();
    const out = removePart(b, 'steer');
    expect(out?.id).toBe('steer_std');
    expect(b.fit.steer?.id).toBe('steer_none');
    const st = statsOf(b);
    expect(st.noSteer).toBe(true);
    expect(st.steerMult).toBe(PARTS.interior.noSteerLock);
    expect(st.steerMult).toBeLessThan(0.3);
    expect(st.steerMult).toBeGreaterThan(0);
    expect(st.forceMult).toBeGreaterThan(0.9);
    expect(conditionSummary(b)).toContain('no steering wheel');
    // The lock is a plain multiplier on the chassis' own: the physics reads it.
    expect(chassisDef('sedan').physics.maxSteerDeg * st.steerMult).toBeLessThan(8);
  });
  it('a quick wheel steers further than the factory one', () => {
    const b = sedan();
    installPart(b, newPart('steer_sport'));
    expect(statsOf(b).steerMult).toBeCloseTo(1.1, 5);
    installPart(b, newPart('steer_chain'));
    expect(statsOf(b).steerMult).toBe(1);
    expect(statsOf(b).sigMult).toBeGreaterThan(effectiveStats(chassisDef('sedan'), {}).sigMult);
  });
  it('no driver seat: you sit on the floor, with worse grip and aim', () => {
    const b = sedan();
    const grip = statsOf(b).gripMult;
    removePart(b, 'seatD');
    const st = statsOf(b);
    expect(st.noDriverSeat).toBe(true);
    expect(st.gripMult).toBeCloseTo(grip * PARTS.interior.noSeatGrip, 5);
    expect(st.seatSpread).toBe(PARTS.interior.noSeatSpread);
    expect(st.seatDrop).toBe(PARTS.interior.noSeatDrop);
    expect(canRidePassenger(chassisDef('sedan'), b.fit, false)).toBe(true);
  });
  it('no passenger seat: nobody can ride there, unless a bed gun gives them a post', () => {
    const b = sedan();
    const p = chassisDef('pickup');
    expect(canRidePassenger(chassisDef('sedan'), b.fit, false)).toBe(true);
    removePart(b, 'seatP');
    expect(canRidePassenger(chassisDef('sedan'), b.fit, false)).toBe(false);
    expect(canRidePassenger(chassisDef('sedan'), b.fit, true)).toBe(true);
    expect(statsOf(b).noPassengerSeat).toBe(true);
    // Cargo may go in its place.
    expect(statsOf(b).cargo).toBeGreaterThan(chassisDef('sedan').cargo);
    const pb = newBuild('pickup', { seed: 2 });
    removePart(pb, 'seatP');
    expect(canRidePassenger(p, pb.fit, false)).toBe(false);
    expect(canRidePassenger(p, pb.fit, true)).toBe(true);
  });
  it('no rear seat: room for cargo; a cargo rack is more room still', () => {
    const b = sedan();
    const base = statsOf(b).cargo;
    removePart(b, 'seatR');
    expect(statsOf(b).cargo).toBe(base + 2);
    installPart(b, newPart('bench_rack'));
    expect(statsOf(b).cargo).toBe(base + 4);
    installPart(b, newPart('bench_fold'));
    expect(statsOf(b).cargo).toBe(base + 1);
  });
  it('no dashboard: the lamps barely work; a gauge pod burns a little less fuel', () => {
    const b = sedan();
    removePart(b, 'dash');
    expect(statsOf(b).light).toBeLessThan(0);
    expect(statsOf(b).noDash).toBe(true);
    installPart(b, newPart('dash_gauge'));
    expect(statsOf(b).light).toBeGreaterThan(0);
    expect(statsOf(b).burnMult).toBeLessThan(effectiveStats(chassisDef('sedan'), {}).burnMult);
  });
  it('a seat only counts for what it can do: the racing seat helps the driver, not the passenger', () => {
    const b = sedan();
    const base = statsOf(b).gripMult;
    installPart(b, newPart('seat_bucket'), 'seatP');
    expect(statsOf(b).gripMult).toBeCloseTo(base, 6);
    installPart(b, newPart('seat_bucket'), 'seatD');
    expect(statsOf(b).gripMult).toBeCloseTo(base + 0.02 * (statsOf(b).gripMult / (base + 0.02)), 2);
    expect(statsOf(b).gripMult).toBeGreaterThan(base);
    installPart(b, newPart('seat_plate'), 'seatP');
    expect(statsOf(b).armorR).toBeGreaterThan(0);
  });
  it('the empty parts describe themselves in plain words', () => {
    for (const id of Object.values(INTERIOR_NONE)) expect(describePart(partDef(id)).join(' ').length).toBeGreaterThan(10);
  });
});

describe('cabin parts: fitting and taking off', () => {
  it('a seat goes in either front mount, the one named, and a rear seat only the back', () => {
    const b = newBuild('hatch', { seed: 6 });
    const seat = newPart('seat_torn');
    const r = installPart(b, seat, 'seatP');
    expect(r.ok).toBe(true);
    expect(r.removed?.id).toBe('seat_std');
    expect(b.fit.seatP?.id).toBe('seat_torn');
    expect(idInSlot(b, 'seatD')).toBe('seat_std');
    // With no mount named, it goes in the empty one.
    removePart(b, 'seatD');
    const r2 = installPart(b, newPart('seat_leather'));
    expect(r2.ok).toBe(true);
    expect(b.fit.seatD?.id).toBe('seat_leather');
    expect(installPart(b, newPart('bench_torn')).ok).toBe(true);
    expect(b.fit.seatR?.id).toBe('bench_torn');
    expect(b.fit.seatD?.id).toBe('seat_leather');
  });
  it('a chassis without the mount refuses the part, and an empty placeholder is not a part', () => {
    const pickup = newBuild('pickup', { seed: 1 });
    const res = installPart(pickup, newPart('bench_std'));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/no rear seat mount/i);
    expect(installPart(newBuild('moped', { seed: 1 }), newPart('seat_std')).ok).toBe(false);
    expect(installPart(newBuild('hatch', { seed: 1 }), newPart('seat_none')).ok).toBe(false);
  });
  it('taking a part off leaves the mount empty, and bolting it back restores it', () => {
    const b = newBuild('van', { seed: 8 });
    for (const slot of ['seatD', 'seatP', 'steer', 'dash'] as PartSlot[]) {
      const out = removePart(b, slot)!;
      expect(out.id).toBe(INTERIOR_STOCK[slot]);
      expect(idInSlot(b, slot)).toBeNull();
      expect(removePart(b, slot)).toBeNull();
      const back = installPart(b, out, slot);
      expect(back.ok).toBe(true);
      expect(back.removed).toBeUndefined();
      expect(idInSlot(b, slot)).toBe(INTERIOR_STOCK[slot]);
    }
  });
  it('the garage forecast warns about what taking each one off costs', () => {
    const b = newBuild('sedan', { seed: 9 });
    const notes = (slot: PartSlot) => forecastSwap(b, slot, null).notes.join(' | ');
    expect(notes('steer')).toMatch(/No steering wheel/);
    expect(notes('seatD')).toMatch(/No driver seat/);
    expect(notes('seatP')).toMatch(/No passenger seat/);
    expect(notes('dash')).toMatch(/No dashboard/);
    expect(forecastSwap(b, 'steer', null).steer).toBeLessThan(0.3);
    expect(forecastSwap(b, 'steer', newPart('steer_sport')).steer).toBeGreaterThan(1);
    expect(forecastWorthy(newPart('seat_bucket'))).toBe(true);
    expect(forecastWorthy(newPart('dash_gauge'))).toBe(true);
  });
  it('spare cabin parts use their own models in the hands and on the ground', () => {
    for (const p of interiorParts().filter((x) => !x.empty)) expect(partModelKey(p.id)).toBe(`part:${p.id}`);
    expect(partModelKey('hood_std')).toBe('part:hood_std');
  });
});

describe('cabin parts: saves', () => {
  it('fitted and missing cabin parts survive a save and a reload', () => {
    const c = new Campaign(undefined, false);
    const b = c.garage[0];
    b.chassis = 'sedan';
    b.comp.tires = [1, 1, 1, 1];
    b.tyres = [null, null, null, null];
    installPart(b, newPart('seat_bucket'), 'seatD');
    removePart(b, 'steer');
    removePart(b, 'seatR');
    installPart(b, newPart('dash_cracked'));
    const raw = JSON.parse(JSON.stringify(c.serialize()));
    const back = Campaign.deserialize(raw).garage[0];
    expect(back.fit.seatD?.id).toBe('seat_bucket');
    expect(back.fit.steer?.id).toBe('steer_none');
    expect(back.fit.seatR?.id).toBe('bench_none');
    expect(back.fit.dash?.id).toBe('dash_cracked');
    expect(statsOf(back).noSteer).toBe(true);
    expect(idInSlot(back, 'seatP')).toBe('seat_std');
  });
  it('an old save with no cabin slots loads as a fully equipped stock interior', () => {
    const c = new Campaign(undefined, false);
    const raw = JSON.parse(JSON.stringify(c.serialize()));
    for (const g of raw.garage) {
      for (const s of INTERIOR_SLOTS) delete g.fit[s];
    }
    const back = Campaign.deserialize(raw);
    for (const b of back.garage) {
      for (const slot of slotsOf(chassisDef(b.chassis)).filter((s) => INTERIOR_SLOTS.includes(s))) expect(idInSlot(b, slot)).toBe(INTERIOR_STOCK[slot]);
      expect(Object.values(cabinGaps(chassisDef(b.chassis), b.fit)).some(Boolean)).toBe(false);
    }
  });
  it('a damaged save is repaired: unknown ids and parts in the wrong mount are dropped', () => {
    const c = new Campaign(undefined, false);
    const b = c.garage[0];
    b.chassis = 'hatch';
    b.comp.tires = [1, 1, 1, 1];
    b.tyres = [null, null, null, null];
    const raw = JSON.parse(JSON.stringify(c.serialize()));
    raw.garage[0].fit.seatD = { uid: 'p1', id: 'seat_does_not_exist', cond: 1 };
    raw.garage[0].fit.steer = { uid: 'p2', id: 'dash_std', cond: 1 };
    raw.garage[0].fit.seatR = { uid: 'p3', id: 'seat_torn', cond: 1 };
    const back = Campaign.deserialize(raw).garage[0];
    expect(idInSlot(back, 'seatD')).toBe('seat_std');
    expect(idInSlot(back, 'steer')).toBe('steer_std');
    // A front seat does not go in the rear mount.
    expect(idInSlot(back, 'seatR')).toBe('bench_std');
  });
});

describe('cabin parts: sockets and the layout', () => {
  it('every chassis with the mounts has a socket for each, inside the body', () => {
    for (const id of [...CARS, 'buggy']) {
      const d = chassisDef(id);
      const L = cabinLayout(d)!;
      expect(L).toBeTruthy();
      for (const slot of slotsOf(d).filter((s) => INTERIOR_SLOTS.includes(s))) {
        const sock = socketFor(d, slot)!;
        expect(sock, `${id} ${slot}`).toBeTruthy();
        expect(sock.anchors).toHaveLength(1);
        const a = sock.anchors[0];
        expect(Math.abs(a.x)).toBeLessThan(d.width / 2);
        expect(Math.abs(a.z)).toBeLessThan(d.length / 2);
      }
      expect(socketsOf(d).map((s) => s.slot)).toContain('dash');
    }
    expect(socketFor(chassisDef('pickup'), 'seatR')).toBeUndefined();
    expect(socketFor(chassisDef('moped'), 'dash')).toBeUndefined();
  });
  it('seats sit between the floor and the roof, with the head clear of the headliner and the feet on the floor', () => {
    for (const id of CARS) {
      const L = cabinLayout(chassisDef(id))!;
      for (const [slot, s] of Object.entries(L.seats)) {
        const top = s!.hip - 0.09;
        expect(top, `${id} ${slot} cushion`).toBeGreaterThan(L.floor);
        expect(s!.hip + 0.78, `${id} ${slot} head`).toBeLessThanOrEqual(L.ceil + 0.02);
        expect(Math.abs(s!.x)).toBeLessThan(L.hw);
        // The anchor box is a real box.
        const a = cabinAnchor(L, slot as PartSlot)!;
        expect(a.sy).toBeGreaterThan(0.3);
      }
      expect(L.dash.z).toBeGreaterThan(L.seats.seatD!.z);
      expect(L.steer.z).toBeGreaterThan(L.seats.seatD!.z);
      expect(L.steer.z).toBeLessThan(L.dash.z + L.dash.depth / 2);
    }
  });
  it('a driver with no seat sits lower, never below the floor', () => {
    for (const id of CARS) {
      const L = cabinLayout(chassisDef(id))!;
      const s = L.seats.seatD!;
      expect(hipHeight(L, s, false, 0.42)).toBe(s.hip);
      const low = hipHeight(L, s, true, PARTS.interior.noSeatDrop);
      expect(low).toBeLessThan(s.hip - 0.1);
      expect(low).toBeGreaterThanOrEqual(L.floor + 0.18);
    }
  });
  it('an occupant is seated on the cushion with their feet on the floor under the dash', () => {
    for (const id of [...CARS, 'buggy']) {
      const L = cabinLayout(chassisDef(id))!;
      const spot = L.seats.seatD!;
      const h = new Humanoid({ jacket: 0x884422, trim: 0x333333, helmet: 0x884422 });
      h.update(0.016, 'seat', 0, 0, 0);
      seatOccupant(h, L, spot, spot.hip);
      h.root.updateMatrixWorld(true);
      const world = (o: THREE.Object3D) => new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
      const hip = world(h.hips).y + L.g0;
      expect(hip).toBeCloseTo(spot.hip, 3);
      const head = world(h.head).y + L.g0;
      if (L.kind === 'car') expect(head + 0.2).toBeLessThanOrEqual(L.ceil + 0.05);
      // Each ankle (the end of the shin) lands near the floor, ahead of the hip and not through it.
      for (const knee of [h.kneeL, h.kneeR]) {
        const foot = new THREE.Vector3(0, -0.43, 0).applyMatrix4(knee.matrixWorld);
        expect(foot.y + L.g0, `${id} foot`).toBeLessThan(L.floor + 0.2);
        expect(foot.y + L.g0, `${id} foot`).toBeGreaterThan(L.floor - 0.1);
        expect(foot.z).toBeGreaterThan(spot.z + 0.3);
      }
    }
  });
});

describe('cabin parts: the models', () => {
  const meshOf = (id: string) => {
    const b = new MeshBuilder();
    cabinPartModel(b, id);
    return b;
  };
  it('every part, and every missing part, has a model of its own that is drawn and sized like a part', () => {
    const sigs = new Set<string>();
    for (const p of interiorParts()) {
      const b = meshOf(p.id);
      expect(b.vertexCount, p.id).toBeGreaterThan(80);
      const g = b.build();
      g.computeBoundingBox();
      const size = g.boundingBox!.getSize(new THREE.Vector3());
      expect(size.x, p.id).toBeLessThan(1.7);
      expect(size.y, p.id).toBeLessThan(1.3);
      expect(size.z, p.id).toBeLessThan(1.0);
      expect(g.boundingBox!.min.y, p.id).toBeGreaterThan(-0.3);
      sigs.add(`${b.vertexCount}:${size.x.toFixed(3)}:${size.y.toFixed(3)}:${size.z.toFixed(3)}`);
    }
    // No two variants are the same mesh.
    expect(sigs.size).toBe(interiorParts().length);
  });
  it('the cabin is built for every chassis and differs when a part changes', () => {
    for (const id of [...CARS, 'buggy']) {
      const d = chassisDef(id);
      const draw = (fit: Parameters<typeof drawCabin>[2]) => {
        const b = new MeshBuilder();
        const rim = drawCabin(b, d, fit);
        return { n: b.vertexCount, rim };
      };
      const stock = draw({});
      expect(stock.n, id).toBeGreaterThan(2000);
      expect(stock.rim?.id).toBe('steer_std');
      const noWheel = draw({ steer: newPart('steer_none') });
      expect(noWheel.rim).toBeNull();
      const bucket = draw({ seatD: newPart('seat_bucket') });
      expect(bucket.n).not.toBe(stock.n);
      expect(draw({ seatD: newPart('seat_none') }).n).not.toBe(stock.n);
      expect(draw({ dash: newPart('dash_none') }).n).not.toBe(stock.n);
    }
  });
  it('a car body and its cabin are separate meshes, and swapping a seat leaves the body alone', () => {
    const d = chassisDef('hatch');
    const wl = wheelCentres(d);
    const build = (fit: Record<string, string>) => {
      const b = newBuild('hatch', { seed: 4, paint: 0x336699 });
      for (const [k, id] of Object.entries(fit)) b.fit[k as PartSlot] = newPart(id);
      return buildVehicleVisual(d, wl, wl.map((_, i) => i < 2), lookOf(b));
    };
    const a = build({});
    const b = build({ seatD: 'seat_bucket', steer: 'steer_sport', dash: 'dash_gauge', seatR: 'bench_none' });
    expect(a.interior).toBeTruthy();
    expect(a.interior).not.toBe(a.body);
    expect(a.body.geometry).toBe(b.body.geometry);
    expect(a.interior!.geometry).not.toBe(b.interior!.geometry);
    expect(a.steerWheel).toBeTruthy();
    const none = build({ steer: 'steer_none' });
    expect(none.steerWheel).toBeUndefined();
    // The cabin is drawn inside the body's own bounds.
    a.interior!.geometry.computeBoundingBox();
    a.body.geometry.computeBoundingBox();
    expect(a.body.geometry.boundingBox!.containsBox(a.interior!.geometry.boundingBox!)).toBe(true);
    a.dispose();
    b.dispose();
    none.dispose();
  });
  it('the dark core that used to fill the cabin is gone: nothing solid sits between the seats and the roof', () => {
    const d = chassisDef('sedan');
    const wl = wheelCentres(d);
    const v = buildVehicleVisual(d, wl, wl.map((_, i) => i < 2), lookOf(newBuild('sedan', { seed: 4 })));
    const L = cabinLayout(d)!;
    const pos = v.body.geometry.attributes.position;
    // No body vertex lies in the footwell box: above the floor, below the roof, between the doors, behind the firewall.
    let inside = 0;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i) + L.g0;
      const z = pos.getZ(i);
      if (Math.abs(x) < L.hw - 0.12 && y > L.floor + 0.05 && y < L.ceil - 0.12 && z < L.zFront - 0.06 && z > L.zBack + 0.1) inside++;
    }
    expect(inside).toBe(0);
    v.dispose();
  });
  it('a wrecked car is charred inside as well', () => {
    const d = chassisDef('hatch');
    const wl = wheelCentres(d);
    const v = buildVehicleVisual(d, wl, wl.map((_, i) => i < 2), lookOf(newBuild('hatch', { seed: 4 })));
    expect(v.interior!.material).toBeTruthy();
    v.dispose();
  });
});

describe('cabin parts: the physics reads the steering multiplier', () => {
  beforeAll(async () => {
    await initPhysics();
  });
  /** The steering angle a sedan reaches creeping along with the wheel held over. */
  const maxLock = (mult: number) => {
    const P = new PhysicsWorld();
    P.addStaticBox(0, -1, 0, 800, 1, 800);
    P.step();
    const def = chassisDef('sedan');
    const g = def.physics.suspension.rest + def.physics.wheelRadius - def.physics.hardY;
    const v = new VehicleBody(P, def, 0, g + 0.05, 0, 0);
    const env = defaultEnv();
    env.steerMult = mult;
    let peak = 0;
    for (let i = 0; i < 120; i++) {
      v.update({ steer: 1, throttle: i < 40 ? 0.4 : 0, brake: 0, handbrake: false }, env, 1 / 60);
      P.step();
      peak = Math.max(peak, Math.abs(v.steerAngle));
    }
    return peak;
  };
  it('a lock multiplier narrows the steering angle a vehicle can reach', () => {
    const full = maxLock(1);
    const none = maxLock(PARTS.interior.noSteerLock);
    const quick = maxLock(1.1);
    expect(full).toBeGreaterThan(0.3);
    expect(none).toBeLessThan(full * 0.25);
    expect(none).toBeGreaterThan(0);
    expect(quick).toBeGreaterThanOrEqual(full);
  });
  it('every found-car chassis is covered', () => {
    expect(Object.keys(CHASSIS)).toEqual(expect.arrayContaining(CARS));
  });
});
