import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { GLASS_SLOTS, chassisDef, legById, partDef, validateData } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { dismantleYield, idInSlot, installPart, newBuild, partInSlot, removePart } from '../src/sim/garage';
import { CHASSIS_PANES, condStage, doorWindow, glassCond, panesPresent, stageCond } from '../src/sim/glassfit';
import { emptyBody } from '../src/sim/bodywork';
import { newPart } from '../src/sim/parts';
import { rollCar } from '../src/sim/cars';
import { salvageLoot, stripBuild } from '../src/sim/salvage';
import { carPanes } from '../src/render/carModels';
import { socketFor } from '../src/render/sockets';
import { accessPointsOf } from '../src/render/accessPoints';
import { workFor } from '../src/sim/access';
import { planFit } from '../src/sim/carry';
import { buildPartModel } from '../src/render/partModels';
import { MeshBuilder } from '../src/render/builder';
import { fakeServices } from './helpers/sim';
import type { Vehicle } from '../src/game/vehicle';

vi.setConfig({ testTimeout: 120000 });

beforeAll(async () => {
  await initPhysics();
});

const DT = 1 / 60;
const CARS = ['hatch', 'sedan', 'pickup', 'van'];

describe('glass as a part', () => {
  it('the data is sound and every car with windows has the mounts, a factory pane and an empty frame', () => {
    expect(validateData()).toEqual([]);
    for (const id of CARS) {
      const slots = chassisDef(id).slots ?? [];
      for (const s of ['glassF', 'glassL', 'glassR']) expect(slots, id).toContain(s);
      expect(slots.includes('glassB'), id).toBe(id !== 'van');
    }
    // The bikes and the buggy have no body to glaze.
    for (const id of ['moped', 'quad', 'buggy', 'truck', 'rig']) for (const s of GLASS_SLOTS) expect(chassisDef(id).slots ?? [], id).not.toContain(s);
  });

  it('the panes a chassis lists are the panes its model draws', () => {
    for (const id of CARS) expect(carPanes(chassisDef(id)).map((p) => p.key).sort(), id).toEqual([...CHASSIS_PANES[id]].sort());
  });

  it('a car with no windscreen part has no windscreen pane, and no rear window part no rear pane', () => {
    const b = newBuild('sedan', { seed: 1 });
    expect(carPanes(chassisDef('sedan'), b.fit).some((p) => p.key === 'ws')).toBe(true);
    removePart(b, 'glassF');
    expect(idInSlot(b, 'glassF')).toBeNull();
    expect(carPanes(chassisDef('sedan'), b.fit).some((p) => p.key === 'ws')).toBe(false);
    removePart(b, 'glassB');
    expect(carPanes(chassisDef('sedan'), b.fit).some((p) => p.key === 'rw')).toBe(false);
  });

  it('a door that is off, or has no window, shows no door glass; the quarter window behind the pillar stays', () => {
    const def = chassisDef('sedan');
    const b = newBuild('sedan', { seed: 2 });
    const keys = () => panesPresent(def, b.fit);
    expect(keys()).toEqual(expect.arrayContaining(['sL0', 'sL1', 'sR0', 'sR1']));
    removePart(b, 'doorL');
    expect(keys()).not.toContain('sL0');
    expect(keys()).toContain('sL1');
    expect(keys()).toContain('sR0');
    // A canvas flap and an armoured slit have no window in them either.
    b.fit.doorR = newPart('door_light', 1);
    expect(doorWindow(def, b.fit, -1)).toBe(false);
    expect(keys()).not.toContain('sR0');
    b.fit.doorR = newPart('door_armor', 1);
    expect(keys()).not.toContain('sR0');
    b.fit.doorR = newPart('door_plate', 1);
    expect(keys()).toContain('sR0');
    // A pickup has one run of side glass, and it is in the door.
    const p = newBuild('pickup', { seed: 3 });
    removePart(p, 'doorL');
    expect(panesPresent(chassisDef('pickup'), p.fit).filter((k) => k.startsWith('sL'))).toEqual([]);
  });

  it('glass comes off a car as a part wearing what the panes took, and goes back on as worn', () => {
    const b = newBuild('hatch', { seed: 4 });
    const whole = partInSlot(b, 'glassF')!;
    expect(whole.id).toBe('gls_ws_std');
    expect(whole.cond).toBe(1);
    b.body = emptyBody();
    b.body.glass = { ws: 1 };
    expect(partInSlot(b, 'glassF')!.cond).toBeCloseTo(stageCond(1), 5);
    const out = removePart(b, 'glassF')!;
    expect(out.cond).toBeCloseTo(0.6, 5);
    expect(idInSlot(b, 'glassF')).toBeNull();
    expect(b.body.glass?.ws).toBeUndefined();
    // Put back on another car, a cracked pane is still cracked.
    const o = newBuild('sedan', { seed: 5 });
    removePart(o, 'glassF');
    const r = installPart(o, out);
    expect(r.ok).toBe(true);
    expect(idInSlot(o, 'glassF')).toBe('gls_ws_std');
    expect(glassCond(o, chassisDef('sedan'), 'glassF')).toBeCloseTo(0.6, 5);
    expect(condStage(partInSlot(o, 'glassF')!.cond)).toBe(1);
  });

  it('a pane that has gone to pieces is nothing to take out, but the frame can take a new one', () => {
    const b = newBuild('van', { seed: 6 });
    b.body = emptyBody();
    b.body.glass = { ws: 3 };
    expect(partInSlot(b, 'glassF')).toBeNull();
    expect(removePart(b, 'glassF')).toBeNull();
    const fresh = newPart('gls_ws_lam', 1);
    expect(installPart(b, fresh).ok).toBe(true);
    expect(idInSlot(b, 'glassF')).toBe('gls_ws_lam');
    expect(partInSlot(b, 'glassF')!.cond).toBe(1);
  });

  it('a door window fits either side, and a windscreen fits nowhere but the front', () => {
    const b = newBuild('pickup', { seed: 7 });
    removePart(b, 'glassL');
    const side = newPart('gls_side_pane', 1);
    // Said to go left, it goes right when asked.
    expect(installPart(b, side, 'glassR').ok).toBe(true);
    expect(idInSlot(b, 'glassR')).toBe('gls_side_pane');
    expect(idInSlot(b, 'glassL')).toBeNull();
    const van = newBuild('van', { seed: 8 });
    expect(installPart(van, newPart('gls_rw_std', 1)).ok).toBe(false);
  });

  it('laminated and ballistic glass is tougher than plain', () => {
    expect(partDef('gls_ws_std').glass!.hp).toBe(1);
    expect(partDef('gls_ws_lam').glass!.hp).toBeGreaterThan(partDef('gls_ws_std').glass!.hp);
    expect(partDef('gls_ws_bullet').glass!.hp).toBeGreaterThan(partDef('gls_ws_lam').glass!.hp);
  });

  it('a factory pane is not hauled out of a breaker yard, but a better fitted one is', () => {
    const b = newBuild('sedan', { seed: 9 });
    expect(dismantleYield(b).items.some((i) => GLASS_SLOTS.includes(partDef(i.id).slot))).toBe(false);
    installPart(b, newPart('gls_ws_lam', 1));
    expect(dismantleYield(b).items.some((i) => i.id === 'gls_ws_lam')).toBe(true);
  });

  it('stripping the bodywork of a car takes its glass, and leaves the frames bare', () => {
    const b = newBuild('hatch', { seed: 10 });
    const loot = salvageLoot(2, { seed: 10, kind: 'car', chassis: 'hatch', burnt: false, build: b });
    const glass = loot.items.filter((i) => GLASS_SLOTS.includes(partDef(i.id).slot));
    expect(glass.map((i) => i.id).sort()).toEqual(['gls_rw_std', 'gls_side_std', 'gls_side_std', 'gls_ws_std']);
    stripBuild(2, b);
    for (const s of GLASS_SLOTS) expect(idInSlot(b, s), s).toBeNull();
    expect(panesPresent(chassisDef('hatch'), b.fit)).toEqual([]);
  });

  it('found cars: some have bare frames, a burnt-out one has no glass left, and none loses glass it never had', () => {
    let bare = 0;
    let n = 0;
    for (let seed = 1; seed < 160; seed++) {
      const r = rollCar(seed * 31, { biome: 'wasteland', chassis: CARS[seed % 4], reach: 0.5 });
      const have = chassisDef(r.build.chassis).slots ?? [];
      n++;
      for (const s of GLASS_SLOTS) {
        if (!have.includes(s)) expect(r.build.fit[s]).toBeUndefined();
        else if (idInSlot(r.build, s) === null) bare++;
      }
    }
    expect(bare).toBeGreaterThan(n * 0.2);
    const hulk = rollCar(77, { biome: 'wasteland', chassis: 'sedan', grade: 'hulk' }).build;
    for (const s of GLASS_SLOTS) expect(partInSlot(hulk, s), s).toBeNull();
  });

  it('can be found in a wreck, and a pane is one of the things you can lean against a wall', async () => {
    const { rollLoot, specFoot, specTag } = await import('../src/sim/loot');
    let seen = 0;
    for (let seed = 0; seed < 400; seed++) {
      for (const s of rollLoot('wreck', seed, 0, { progress: 0.5 })) {
        if (s.kind === 'part' && GLASS_SLOTS.includes(partDef(s.id).slot)) {
          seen++;
          expect(specTag(s)).toBe('panel');
          expect(specFoot(s).turn).toBe(true);
        }
      }
    }
    expect(seen).toBeGreaterThan(5);
  });

  it('every glass slot of every car has a place to stand and a socket on the glass itself', () => {
    for (const id of CARS) {
      const def = chassisDef(id);
      for (const s of def.slots!.filter((q) => GLASS_SLOTS.includes(q))) {
        const wk = workFor(def, s);
        expect(wk, `${id} ${s}`).toBeTruthy();
        expect(wk!.at.some((spot) => accessPointsOf(def).some((p) => p.spot === spot)), `${id} ${s}`).toBe(true);
        const sock = socketFor(def, s);
        expect(sock?.anchors.length, `${id} ${s}`).toBeGreaterThan(0);
      }
    }
    // The windscreen socket sits where the screen is.
    const ws = carPanes(chassisDef('sedan')).find((p) => p.key === 'ws')!;
    const a = socketFor(chassisDef('sedan'), 'glassF')!.anchors[0];
    expect(a.z).toBeCloseTo(ws.c[2], 4);
    expect(a.y).toBeCloseTo(ws.c[1], 4);
  });

  it('a door window will not go in a door that has none', () => {
    const def = chassisDef('sedan');
    const fitted = (door: string | null) => (slot: string) => (slot === 'doorL' && door ? { id: door } : undefined);
    const t = (door: string | null) => ({ def, fitted: fitted(door), fuel: 0, tankMax: 1, oil: 1, access: { at: 'doorL' as const, open: { hood: true, doorL: true, doorR: true, trunk: true }, mount: 'glassL' as const } });
    const c = { kind: 'part' as const, item: newPart('gls_side_pane', 1) };
    expect(planFit(c, t(null)).ok).toBe(false);
    expect(planFit(c, t('door_light')).ok).toBe(false);
    expect(planFit(c, t('door_std')).ok).toBe(true);
  });

  it('a pane of glass has a model of its own', () => {
    for (const id of ['gls_ws_std', 'gls_rw_lam', 'gls_side_bullet']) {
      const b = new MeshBuilder();
      buildPartModel(b, id);
      expect(b.empty, id).toBe(false);
    }
  });
});

// ------------------------------------------------------------------ in a scene

function leg() {
  const h = fakeServices();
  const sc = new LegScene(h.svc, legById('L1'));
  sc.pendingResult = true;
  return { h, sc, c: h.campaign };
}

function run(sc: LegScene, secs: number) {
  for (let i = 0; i < Math.round(secs / DT); i++) {
    sc.tick(DT);
    for (const v of sc.vehicles) v.syncVisual(1, DT);
  }
}

function car(sc: LegScene, build = newBuild('sedan', { seed: 3 }), dx = 14, dz = 6): Vehicle {
  const st = sc.src.layout.start;
  const x = st.x + dx;
  const z = st.z + dz;
  const v = sc.spawnVehicle({ build, x, z, y: sc.groundAt(x, z), yaw: 0, ownerIndex: -1, faction: 'neutral' });
  run(sc, 1.5);
  return v;
}

describe('glass on a live car', () => {
  it('a car with no windscreen part comes out of the garage with no windscreen pane to shoot', () => {
    const { sc } = leg();
    const b = newBuild('sedan', { seed: 3 });
    removePart(b, 'glassF');
    const v = car(sc, b);
    expect(v.visual.panes!.has('ws')).toBe(false);
    expect(v.glass.keys()).not.toContain('ws');
    expect(v.glass.keys()).toContain('rw');
  });

  it('taking the windscreen out of a standing car removes the pane, and what is carried keeps the cracks', () => {
    const { sc } = leg();
    const v = car(sc);
    expect(v.glass.keys()).toContain('ws');
    // The screen takes a hit and cracks.
    v.glass.hitNear(...(v.body.toWorld(0, 1.1, 0.7) as [number, number, number]), 6, 'melee', 3);
    v.commit();
    const was = v.glass.stageOf('ws');
    const out = removePart(v.build!, 'glassF');
    if (was < 3) expect(out).not.toBeNull();
    v.syncFromBuild();
    expect(v.visual.panes!.has('ws')).toBe(false);
    expect(v.glass.keys()).not.toContain('ws');
    // And a new pane goes in whole, whatever the old one had taken.
    expect(installPart(v.build!, newPart('gls_ws_lam', 1)).ok).toBe(true);
    v.syncFromBuild();
    expect(v.visual.panes!.has('ws')).toBe(true);
    expect(v.glass.stageOf('ws')).toBe(0);
    expect(v.glass.hpOf('ws')).toBeGreaterThan(40);
  });

  it('a cracked pane fitted from a wreck is cracked on the car', () => {
    const { sc } = leg();
    const v = car(sc);
    removePart(v.build!, 'glassB');
    v.syncFromBuild();
    expect(v.glass.keys()).not.toContain('rw');
    installPart(v.build!, newPart('gls_rw_pane', 0.55));
    v.syncFromBuild();
    expect(v.glass.stageOf('rw')).toBe(1);
    expect(v.visual.panes!.stageOf('rw')).toBe(1);
  });

  it('tougher glass takes more before it goes', () => {
    const { sc } = leg();
    const a = car(sc, newBuild('sedan', { seed: 11 }), 14, 6);
    const b = newBuild('sedan', { seed: 12 });
    installPart(b, newPart('gls_ws_bullet', 1));
    const w = car(sc, b, 24, 6);
    expect(w.glass.hpOf('ws')).toBeGreaterThan(a.glass.hpOf('ws') * 4);
  });

  it('a door torn off takes its window with it, and a door put back brings it back', () => {
    const { sc } = leg();
    const b = newBuild('sedan', { seed: 13 });
    const v = car(sc, b);
    expect(v.visual.panes!.has('sL0')).toBe(true);
    removePart(v.build!, 'doorL');
    v.syncFromBuild();
    expect(v.visual.panes!.has('sL0')).toBe(false);
    expect(v.visual.panes!.has('sL1')).toBe(true);
    expect(v.glass.keys()).not.toContain('sL0');
    installPart(v.build!, newPart('door_std', 1));
    v.syncFromBuild();
    expect(v.visual.panes!.has('sL0')).toBe(true);
    // A pane that had cracked before the door came off is cracked when it goes back.
    v.glass.hitNear(...(v.body.toWorld(0.9, 1.1, 0.0) as [number, number, number]), 5, 'melee', 3);
    v.commit();
    const st = v.glass.stageOf('sL0');
    removePart(v.build!, 'doorL');
    v.syncFromBuild();
    v.commit();
    installPart(v.build!, newPart('door_std', 1));
    v.syncFromBuild();
    expect(v.glass.stageOf('sL0')).toBe(st);
  });

  it('a door that is knocked off in a crash takes its window with it: a shot through the gap meets no glass', () => {
    const { sc } = leg();
    const v = car(sc, newBuild('sedan', { seed: 16 }));
    const sl0 = carPanes(v.def).find((p) => p.key === 'sL0')!;
    const shoot = () => v.glass.hitRay(...(v.body.toWorld(sl0.c[0] + 3, sl0.c[1], sl0.c[2]) as [number, number, number]), -1, 0, 0, 0.01);
    expect(shoot()).toBe('sL0');
    expect(v.bodywork.strainPart('door:1', 50, [0, 0, 0])).toBe(true);
    run(sc, 0.5);
    expect(v.bodywork.gonePanels().doorL).toBe(true);
    // Through the empty door the round finds the far side's glass, not this one's.
    expect(shoot()).not.toBe('sL0');
  });

  it('a mended window is whole after the car is saved and brought back', () => {
    const { sc } = leg();
    const b = newBuild('sedan', { seed: 14 });
    installPart(b, newPart('gls_ws_pane', 0.55));
    const v = car(sc, b);
    expect(v.glass.stageOf('ws')).toBe(1);
    v.glass.mendOne();
    v.commit();
    expect(b.fit.glassF!.cond).toBe(1);
    const w = car(sc, b, 24, 6);
    expect(w.glass.stageOf('ws')).toBe(0);
  });

  it('stripping a car in the world takes its glass and leaves the frames bare', () => {
    const { sc } = leg();
    const v = car(sc, newBuild('hatch', { seed: 15 }));
    expect(v.glass.count).toBeGreaterThan(4);
    v.commit();
    stripBuild(2, v.build!);
    v.refit(true);
    expect(v.glass.count).toBe(0);
    expect(v.visual.panes!.size).toBe(0);
  });
});
