import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { legById, chassisDef } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { newBuild } from '../src/sim/garage';
import { planRepair } from '../src/sim/repair';
import { GLASS_HP, blastGlassDamage, crashGlassDamage, glassDamage, hitPane, newPane, shardCount, stageOf } from '../src/sim/glass';
import { PaneSet } from '../src/render/glass';
import { carPanes } from '../src/render/carModels';
import { fakeServices } from './helpers/sim';
import type { Vehicle } from '../src/game/vehicle';

vi.setConfig({ testTimeout: 120000 });

beforeAll(async () => {
  await initPhysics();
});

const DT = 1 / 60;

describe('the rules of glass', () => {
  it('goes through whole, cracked, crazed and gone as its hit points run out', () => {
    expect(stageOf(12, 12)).toBe(0);
    expect(stageOf(7, 12)).toBe(1);
    expect(stageOf(3, 12)).toBe(2);
    expect(stageOf(0, 12)).toBe(3);
    const p = newPane('shop');
    expect(p.hp).toBe(GLASS_HP.shop);
    expect(hitPane(p, 10)).toMatchObject({ from: 0, to: 0, broke: false });
    expect(hitPane(p, 10)).toMatchObject({ from: 0, to: 1, broke: false });
    expect(hitPane(p, 8)).toMatchObject({ from: 1, to: 2, broke: false });
    expect(hitPane(p, 9)).toMatchObject({ from: 2, to: 3, broke: true });
    // A pane that has gone cannot break again.
    expect(hitPane(p, 50)).toMatchObject({ from: 3, to: 3, broke: false });
  });

  it('a window gives to one round where a shop front takes a few and a screen more', () => {
    expect(hitPane(newPane('window'), 12).broke).toBe(true);
    const shop = newPane('shop');
    expect(hitPane(shop, 14).broke).toBe(false);
    expect(hitPane(shop, 14).broke).toBe(false);
    expect(hitPane(shop, 14).broke).toBe(true);
    const screen = newPane('screen');
    for (let i = 0; i < 3; i++) expect(hitPane(screen, 11).broke).toBe(false);
    expect(hitPane(screen, 11).broke).toBe(true);
  });

  it('a blast does more than a bullet, and a laminated screen shrugs off a blunt blow', () => {
    expect(glassDamage('blast', 10, 'window')).toBeGreaterThan(glassDamage('bullet', 10, 'window'));
    expect(glassDamage('melee', 10, 'screen')).toBeLessThan(glassDamage('melee', 10, 'side'));
  });

  it('a crash hurts the glass that faces it and barely touches the rest', () => {
    expect(crashGlassDamage(4, 1)).toBe(0);
    const front = crashGlassDamage(20, 1);
    const side = crashGlassDamage(20, 0);
    const rear = crashGlassDamage(20, -1);
    expect(front).toBeGreaterThan(side * 5);
    expect(side).toBeCloseTo(rear, 6);
    // A crash that is hard enough takes the side glass out when the side is what was struck.
    expect(front).toBeGreaterThan(GLASS_HP.side);
  });

  it('a blast breaks every window of a car close to it and spares one at the edge', () => {
    for (const k of ['side', 'rear', 'screen'] as const) expect(blastGlassDamage(0.5, k)).toBeGreaterThanOrEqual(GLASS_HP[k]);
    expect(blastGlassDamage(0.05, 'screen')).toBeLessThan(GLASS_HP.screen);
    expect(blastGlassDamage(0, 'side')).toBe(0);
  });

  it('a larger pane throws more glass, within bounds', () => {
    expect(shardCount(0.2)).toBeLessThan(shardCount(3));
    expect(shardCount(100)).toBeLessThanOrEqual(26);
    expect(shardCount(0)).toBeGreaterThanOrEqual(10);
  });
});

describe('the windows of a car', () => {
  it('each body has a windscreen that faces forward and up, and the van has no rear window', () => {
    for (const id of ['hatch', 'sedan', 'pickup', 'van']) {
      const panes = carPanes(chassisDef(id));
      const ws = panes.find((p) => p.key === 'ws')!;
      expect(ws, id).toBeDefined();
      expect(ws.n[2]).toBeGreaterThan(0.4);
      expect(ws.n[1]).toBeGreaterThan(0.2);
      expect(Math.hypot(...ws.n)).toBeCloseTo(1, 5);
      expect(panes.some((p) => p.key === 'rw')).toBe(id !== 'van');
      for (const p of panes) {
        expect(p.hw).toBeGreaterThan(0.1);
        expect(p.hh).toBeGreaterThan(0.1);
        // Inside the width of the body, and not below the sills.
        expect(Math.abs(p.c[0])).toBeLessThan(chassisDef(id).width / 2 + 0.05);
      }
    }
  });

  it('a two-door has two side windows a side and a pickup one', () => {
    const sides = (id: string) => carPanes(chassisDef(id)).filter((p) => p.kind === 'side');
    expect(sides('sedan')).toHaveLength(4);
    expect(sides('hatch')).toHaveLength(4);
    expect(sides('pickup')).toHaveLength(2);
    expect(sides('van')).toHaveLength(2);
    for (const p of sides('sedan')) expect(Math.abs(p.n[0])).toBe(1);
  });

  it('a chassis that is not a found car has no windows', () => {
    expect(carPanes(chassisDef('buggy'))).toHaveLength(0);
  });
});

describe('a set of panes', () => {
  const spec = (key: string) => ({ key, kind: 'shop' as const, c: [0, 1.5, 0] as [number, number, number], n: [0, 0, 1] as [number, number, number], hw: 1, hh: 1 });

  it('merges whole panes into one mesh and gives a hurt one a mesh of its own', () => {
    const set = new PaneSet();
    set.add(spec('a'));
    set.add({ ...spec('b'), c: [4, 1.5, 0] });
    expect(set.group.children).toHaveLength(1);
    set.crack('a', 1, [0.2, 1.6, 0.1]);
    expect(set.stageOf('a')).toBe(1);
    expect(set.count()).toEqual({ whole: 1, hurt: 1, gone: 0 });
    // The merged mesh (b), the frosted pane (a) and a web of cracks.
    expect(set.group.children).toHaveLength(3);
    set.crack('a', 2);
    expect(set.stageOf('a')).toBe(2);
    set.crack('a', 1);
    expect(set.stageOf('a')).toBe(2);
  });

  it('a pane that goes leaves teeth in the frame and can be fitted again', () => {
    const set = new PaneSet();
    set.add(spec('a'));
    set.shatter('a');
    expect(set.stageOf('a')).toBe(3);
    expect(set.count().gone).toBe(1);
    // Nothing whole is left to merge; the teeth are what is there.
    expect(set.group.children).toHaveLength(1);
    set.mend('a');
    expect(set.stageOf('a')).toBe(0);
    expect(set.count().whole).toBe(1);
    set.remove('a');
    expect(set.size).toBe(0);
    expect(set.group.children).toHaveLength(0);
  });

  it('puts the web inside the pane even when the blow was beside it', () => {
    const set = new PaneSet();
    set.add(spec('a'));
    set.crack('a', 1, [9, 9, 3]);
    const web = set.group.children.find((c) => c.position.x !== 0 || c.position.y !== 0)!;
    expect(Math.abs(web.position.x)).toBeLessThanOrEqual(1.001);
    expect(web.position.y).toBeLessThanOrEqual(2.501);
    // Just off the face, on the side the pane faces.
    expect(web.position.z).toBeGreaterThan(0);
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
  for (let i = 0; i < Math.round(secs / DT); i++) sc.tick(DT);
}

function car(sc: LegScene, id = 'sedan', seed = 3, dx = 14, dz = 6): Vehicle {
  const st = sc.src.layout.start;
  const x = st.x + dx;
  const z = st.z + dz;
  const v = sc.spawnVehicle({ build: newBuild(id, { seed }), x, z, y: sc.groundAt(x, z), yaw: 0, ownerIndex: -1, faction: 'neutral' });
  run(sc, 1.5);
  return v;
}

/** Fire a line at a car's windscreen from in front of it, level with the glass. */
function atScreen(v: Vehicle, dmg: number) {
  const ws = carPanes(v.def).find((p) => p.key === 'ws')!;
  const [x, y, z] = v.body.toWorld(ws.c[0], ws.c[1], ws.c[2]);
  return v.glass.hitRay(x, y, z + 3, 0, 0, -1, dmg);
}

describe('a car in the world', () => {
  it('has panes on the model, one per window, and starts with its glass whole when it is in good shape', () => {
    const { sc } = leg();
    const v = car(sc);
    expect(v.visual.panes).toBeDefined();
    expect(v.glass.count).toBe(carPanes(v.def).length);
    expect(v.glass.broken()).toBe(0);
    expect(v.visual.panes!.stageOf('ws')).toBe(0);
  });

  it('a round through the windscreen cracks it, then crazes it, then takes it out', () => {
    const { sc } = leg();
    const v = car(sc);
    expect(atScreen(v, 11)).toBe('ws');
    expect(v.glass.stageOf('ws')).toBe(0);
    expect(atScreen(v, 11)).toBe('ws');
    expect(v.glass.stageOf('ws')).toBe(1);
    expect(v.visual.panes!.stageOf('ws')).toBe(1);
    atScreen(v, 11);
    expect(v.glass.stageOf('ws')).toBe(2);
    atScreen(v, 11);
    expect(v.glass.stageOf('ws')).toBe(3);
    expect(v.visual.panes!.stageOf('ws')).toBe(3);
    // A pane that has gone lets the next round through to the rear glass behind it.
    expect(atScreen(v, 11)).toBe('rw');
  });

  it('a round that comes in from the side meets the side glass, and one that passes under the roof line meets nothing', () => {
    const { sc } = leg();
    const v = car(sc);
    const side = carPanes(v.def).find((p) => p.key === 'sL0')!;
    const [x, y, z] = v.body.toWorld(side.c[0], side.c[1], side.c[2]);
    expect(v.glass.hitRay(x + 3, y, z, -1, 0, 0, 40)).toBe('sL0');
    expect(v.glass.stageOf('sL0')).toBe(3);
    // Below the belt line there is only door.
    expect(v.glass.hitRay(x + 3, v.position.y - 0.4, z, -1, 0, 0, 40)).toBeNull();
  });

  it('the pane a round crosses is the one at the point of the line, not the one near where the box was struck', () => {
    const { sc } = leg();
    const v = car(sc);
    // Struck on the nose, travelling back along the bonnet's height: that is under the screen, so it should miss the glass.
    const [x, y, z] = v.body.toWorld(0, -0.2, 2.2);
    expect(v.glass.hitRay(x, y, z, 0, 0, -1, 40)).toBeNull();
  });

  it('a crash from the front hurts the screen and spares the side glass; a blast takes the lot', () => {
    const { sc } = leg();
    const v = car(sc);
    v.glass.crash(26, 0, 1);
    expect(v.glass.stageOf('ws')).toBeGreaterThan(0);
    expect(v.glass.stageOf('sL0')).toBe(0);
    expect(v.glass.stageOf('ws')).toBeGreaterThan(v.glass.stageOf('sL0'));
    v.glass.blast(0.8);
    expect(v.glass.broken()).toBe(v.glass.count);
    expect(v.visual.panes!.count().gone).toBe(v.glass.count);
  });

  it('a car that burns out loses every window', () => {
    const { sc } = leg();
    const v = car(sc);
    v.takeHit(99999, v.position.x + 3, v.position.z, { silent: true });
    run(sc, 0.3);
    expect(v.wreck).toBe(true);
    expect(v.glass.broken()).toBe(v.glass.count);
  });

  it('broken glass stays broken when the car is put away and brought out again', () => {
    const { sc } = leg();
    const b = newBuild('sedan', { seed: 5 });
    const st = sc.src.layout.start;
    const v = sc.spawnVehicle({ build: b, x: st.x + 14, z: st.z + 6, y: sc.groundAt(st.x + 14, st.z + 6), yaw: 0, ownerIndex: 0, faction: 'convoy' });
    run(sc, 1.5);
    atScreen(v, 99);
    v.glass.hitRay(...(v.body.toWorld(carPanes(v.def).find((p) => p.key === 'sL0')!.c[0] + 3, 0.1, 0) as [number, number, number]), -1, 0, 0, 5);
    expect(v.glass.stageOf('ws')).toBe(3);
    v.commit();
    expect(b.body?.glass?.ws).toBe(3);
    const w = sc.spawnVehicle({ build: b, x: st.x + 24, z: st.z + 6, y: sc.groundAt(st.x + 24, st.z + 6), yaw: 0, ownerIndex: 0, faction: 'convoy' });
    run(sc, 1);
    expect(w.glass.stageOf('ws')).toBe(3);
    expect(w.visual.panes!.stageOf('ws')).toBe(3);
  });

  it('a wrench job fits new glass once the body is straight', () => {
    const { sc, c } = leg();
    const v = car(sc);
    v.glass.blast(1);
    expect(planRepair(v.health, c.stocks, { glass: v.glass.broken() })?.label).toMatch(/glass/i);
    expect(planRepair(v.health, c.stocks, { glass: 0 })).toBeNull();
    const before = v.glass.broken();
    expect(v.glass.mendOne()).toMatch(/window|screen/);
    expect(v.glass.broken()).toBe(before - 1);
    // Fitted new, it is whole again.
    const fixed = v.glass.keys().find((k) => v.glass.stageOf(k) === 0)!;
    expect(v.visual.panes!.stageOf(fixed)).toBe(0);
  });
});
