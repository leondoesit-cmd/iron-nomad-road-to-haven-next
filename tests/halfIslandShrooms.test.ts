import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { WorldMemory } from '../src/game/worldMemory';
import { Btn } from '../src/input/intents';
import { newNeeds } from '../src/sim/needs';
import { DrugState, NO_LOOK } from '../src/sim/drugs';
import { DEATHCAP, FORAGE_RULES, SHROOM_LOOK, eatWild, pickHandful, sortWild, type Shroom } from '../src/sim/forage';
import { EYES_FROM, FACE_TRIP, faceStrength, gumFootGeometry } from '../src/render/faceGums';
import { GHOST_FROM } from '../src/game/faceTrip';
import { wildLot, wildTotal } from '../src/game/wildShrooms';
import { ChunkSource } from '../src/world/chunkgen';
import { fakeServices, run } from './helpers/sim';

vi.setConfig({ testTimeout: 180000 });

beforeAll(async () => {
  await initPhysics();
});

const DT = 1 / 60;
/** The Half Island as the world plans it (the same numbers every scene builds). */
const BEND = new ChunkSource(legById('W')).layout.terrain.bends![0];
const fed = () => ({ ...newNeeds(), food: 0.95, water: 0.95 });
const hungry = () => ({ ...newNeeds(), food: 0.3, water: 0.3 });
const NOBODY = new Set<Shroom>();
/** A roll that never studies (looking them over teaches nothing this time). */
const BLIND = FORAGE_RULES.studyChance + 0.05;

describe('wild mushroom rules', () => {
  it('unknown mushrooms are always picked and kept by their look, hungry or not, never eaten on the spot', () => {
    for (const needs of [fed(), hungry()]) {
      for (const s of ['field', 'liberty', 'deathcap'] as Shroom[]) {
        const o = pickHandful('mushroom', { needs, cover: 'none', bleeding: false, roll: BLIND, shroom: s, known: NOBODY });
        expect(o.took).toBe(true);
        expect(o.bank.wild).toBe(s);
        expect(o.trip || o.poison).toBe(false);
        expect(o.ate.food).toBe(0);
        expect(o.learn).toBeUndefined();
        expect(o.note).toContain(SHROOM_LOOK[s]);
      }
    }
  });

  it('a careful look sometimes tells you what they are, and then they go where they belong', () => {
    const lib = pickHandful('mushroom', { needs: fed(), cover: 'none', bleeding: false, roll: 0.01, shroom: 'liberty', known: NOBODY });
    expect(lib.learn).toBe('liberty');
    expect(lib.bank).toEqual({ mushrooms: 1 });
    const dc = pickHandful('mushroom', { needs: fed(), cover: 'none', bleeding: false, roll: 0.01, shroom: 'deathcap', known: NOBODY });
    expect(dc.learn).toBe('deathcap');
    expect(dc.took).toBe(false);
  });

  it('known liberty caps go on the belt as the mushrooms drug', () => {
    const o = pickHandful('mushroom', { needs: hungry(), cover: 'none', bleeding: false, roll: BLIND, shroom: 'liberty', known: new Set<Shroom>(['liberty']) });
    expect(o.bank).toEqual({ mushrooms: 1 });
    expect(o.trip).toBe(false);
  });

  it('eating from the stash is the gamble: a trip, a meal, or a poisoning that only shows itself later', () => {
    const lib = eatWild('liberty', fed());
    expect(lib.trip).toBe(true);
    expect(lib.learn).toBe('liberty');
    const field = eatWild('field', hungry());
    expect(field.food).toBeGreaterThan(0);
    expect(field.learn).toBe('field');
    const dc = eatWild('deathcap', hungry());
    expect(dc.poison).toBe(true);
    expect(dc.learn).toBeUndefined();
    // Sorted once known.
    expect(sortWild('liberty', 3)).toEqual({ mushrooms: 3, rations: 0, dropped: 0 });
    expect(sortWild('field', 2).rations).toBeGreaterThan(0);
    expect(sortWild('deathcap', 2).dropped).toBe(2);
  });
});

describe('the old gums\' faces', () => {
  it('come forward with the trip and are nothing sober; LSD and ayahuasca bring them out too', () => {
    expect(faceStrength(NO_LOOK)).toBe(0);
    const peak = (id: 'mushrooms' | 'lsd' | 'ayahuasca') => {
      const d = new DrugState(() => 0.5);
      d.dose(id);
      let best = 0;
      for (let i = 0; i < 60 * 90; i++) {
        d.update(1 / 60);
        best = Math.max(best, faceStrength(d.look()));
      }
      return best;
    };
    expect(peak('mushrooms')).toBeGreaterThan(0.9);
    expect(peak('lsd')).toBeGreaterThan(EYES_FROM);
    expect(peak('ayahuasca')).toBeGreaterThan(0.9);
  });
});

describe('at the Half Island', () => {
  function scene(solo = false) {
    const h = fakeServices({ solo });
    const bend = BEND;
    const g = bend.gums.find((q) => !q.island)!;
    const f = g.faces[0];
    const start = { x: g.x + Math.cos(f.az) * (g.r + 3), z: g.z + Math.sin(f.az) * (g.r + 3), yaw: 0 };
    const sc = new LegScene(h.svc, legById('W'), { memory: new WorldMemory(), start });
    sc.pendingResult = true;
    (sc as unknown as { updateTether: () => void }).updateTether = () => {};
    for (const p of sc.players) if (p.vehicle) p.exitVehicle(false);
    sc.players[0].placeAt(start.x, start.z, 0);
    sc.players[1]?.placeAt(start.x + 60, start.z + 60, 0);
    run(sc, 0.6);
    return { h, sc, bend, g };
  }

  function holdA(h: ReturnType<typeof fakeServices>, sc: LegScene, secs: number) {
    const it = h.intents[0];
    it.device = 'keyboard';
    for (let i = 0; i < Math.round(secs / DT); i++) {
      it.held |= 1 << Btn.A;
      it.pressed = i === 0 ? 1 << Btn.A : 0;
      it.heldTime[Btn.A] += DT;
      sc.tick(DT);
    }
    it.held &= ~(1 << Btn.A);
    it.pressed = 0;
    it.released = 1 << Btn.A;
    it.heldTime[Btn.A] = 0;
    sc.tick(DT);
    it.released = 0;
  }

  /** A tap on the quick belt's button. */
  function tapDown(h: ReturnType<typeof fakeServices>, sc: LegScene) {
    const it = h.intents[0];
    it.pressed |= 1 << Btn.Down;
    it.held |= 1 << Btn.Down;
    sc.tick(DT);
    it.pressed &= ~(1 << Btn.Down);
    sc.tick(DT);
    it.held &= ~(1 << Btn.Down);
    it.released |= 1 << Btn.Down;
    sc.tick(DT);
    it.released &= ~(1 << Btn.Down);
  }

  it('has liberty caps fruiting under the old gums on day one, a troop at the foot of every face', () => {
    const { sc, bend } = scene(true);
    const f = sc.forage!;
    expect(sc.campaign.day).toBe(1);
    const caps = bend.shrooms.length;
    expect(caps).toBeGreaterThanOrEqual(14);
    // Every one of them loaded near the gums is a liberty cap patch, up today.
    const near = f.spots().filter((s) => s.always);
    expect(near.length).toBeGreaterThan(0);
    for (const s of near) {
      expect(s.shroom).toBe('liberty');
      expect(f.left(s)).toBeGreaterThan(0);
    }
    // A troop within a few steps in front of every face on the meadow.
    for (const g of bend.gums.filter((q) => !q.island)) {
      for (const fc of g.faces) {
        const fx = g.x + Math.cos(fc.az) * g.r;
        const fz = g.z + Math.sin(fc.az) * g.r;
        expect(bend.shrooms.some((s) => Math.hypot(s.x - fx, s.z - fz) < 2.2)).toBe(true);
      }
    }
    sc.dispose();
  });

  it('a stranger to them picks the caps into the stash, eats one from the quick belt, trips, and the rest are sorted', () => {
    const { h, sc } = scene(true);
    const p = sc.players[0];
    const f = sc.forage!;
    Object.assign(p.needs, { food: 0.95, water: 0.95 });
    // Never learns them by looking: this one has to find out.
    (f as unknown as { roll: () => number }).roll = () => 0.99;
    const s = f
      .spots()
      .filter((q) => q.always && f.left(q) > 0)
      .sort((a, b) => Math.hypot(a.x - p.pos.x, a.z - p.pos.z) - Math.hypot(b.x - p.pos.x, b.z - p.pos.z))[0];
    p.placeAt(s.x + 0.8, s.z, 0);
    run(sc, 0.4);
    expect(p.prompt?.text ?? '').toContain(SHROOM_LOOK.liberty);
    holdA(h, sc, 2.2);
    expect(sc.campaign.items.wildLiberty).toBe(1);
    expect(wildTotal(sc.campaign)).toBe(1);
    expect(sc.campaign.items.mushrooms).toBe(0);
    // The first pick points the quick belt at them and says how to eat one.
    expect(p.quickSel).toBe('wild');
    expect(wildLot(p)).toBe('liberty');
    expect(p.notes.some((n) => /Tap .* to eat one/.test(n.text))).toBe(true);
    // A second handful into the stash, then eat one.
    holdA(h, sc, 2.2);
    expect(sc.campaign.items.wildLiberty).toBe(2);
    tapDown(h, sc);
    expect(sc.campaign.flags[`forage.${p.hero}.liberty`]).toBe(true);
    expect(p.drugs.active.some((a) => a.id === 'mushrooms')).toBe(true);
    // Now known, the other handful in the stash went on the belt as the drug.
    run(sc, 0.5);
    expect(sc.campaign.items.wildLiberty).toBe(0);
    expect(sc.campaign.items.mushrooms).toBe(1);
    sc.dispose();
  });

  it('picking known liberty caps adds to the mushrooms on the belt', () => {
    const { h, sc } = scene(true);
    const p = sc.players[0];
    const f = sc.forage!;
    sc.campaign.flags[`forage.${p.hero}.liberty`] = true;
    const s = f
      .spots()
      .filter((q) => q.always && f.left(q) > 0)
      .sort((a, b) => Math.hypot(a.x - p.pos.x, a.z - p.pos.z) - Math.hypot(b.x - p.pos.x, b.z - p.pos.z))[0];
    p.placeAt(s.x + 0.8, s.z, 0);
    run(sc, 0.4);
    expect(p.prompt?.text ?? '').toMatch(/Pick liberty caps/);
    const before = sc.campaign.items.mushrooms;
    holdA(h, sc, 2.2);
    expect(sc.campaign.items.mushrooms).toBe(before + 1);
    expect(sc.campaign.items.wildLiberty).toBe(0);
    sc.dispose();
  });

  it('death caps eaten from the stash poison you once they start, and then you know them', () => {
    const { h, sc } = scene(true);
    const p = sc.players[0];
    sc.campaign.items.wildDeathcap = 2;
    p.selectQuick('wild');
    tapDown(h, sc);
    expect(sc.campaign.items.wildDeathcap).toBe(1);
    run(sc, 0.5);
    expect(sc.forage!.sick.has(0)).toBe(true);
    expect(sc.campaign.flags[`forage.${p.hero}.deathcap`]).toBeFalsy();
    const hp = p.hp;
    run(sc, DEATHCAP.onset + 20);
    expect(p.hp).toBeLessThan(hp - 5);
    expect(sc.campaign.flags[`forage.${p.hero}.deathcap`]).toBe(true);
    // The other one was thrown away when it was known.
    expect(sc.campaign.items.wildDeathcap).toBe(0);
    sc.dispose();
  });

  it('the faces come forward only in the tripping player\'s own view; the partner sees bark', () => {
    const { h, sc, g } = scene(false);
    const [p0, p1] = sc.players;
    // Both stand by the same face; only the first one has eaten.
    const f = g.faces[0];
    p1.placeAt(g.x + Math.cos(f.az) * (g.r + 4), g.z + Math.sin(f.az) * (g.r + 4), 0);
    p0.drugs.dose('mushrooms');
    run(sc, 55);
    const ft = sc.faceTrip!;
    expect(ft.views[0].k).toBeGreaterThan(0.9);
    expect(ft.views[1].k).toBe(0);
    // The renderer's per-view hooks, as it calls them before drawing each half (the headless one leaves gaps).
    const hooks = h.R.onBeforeView as (((i: number, cam: unknown) => void) | undefined)[];
    const after = h.R.onAfterView as (((i: number) => void) | undefined)[];
    const draw = (i: number) => {
      for (const cb of hooks) cb?.(i, h.R.views[i].camera);
      const k = FACE_TRIP.k.value;
      for (const cb of after) cb?.(i);
      return k;
    };
    expect(draw(0)).toBeGreaterThan(0.9);
    expect(draw(1)).toBe(0);
    expect(draw(0)).toBeGreaterThan(0.9);
    // Between views nothing is left set for anything else that draws.
    expect(FACE_TRIP.k.value).toBe(0);
    // The faces follow the tripper's own head.
    for (const cb of hooks) cb?.(0, h.R.views[0].camera);
    expect(Math.hypot(FACE_TRIP.look.value.x - p0.pos.x, FACE_TRIP.look.value.z - p0.pos.z)).toBeLessThan(0.01);
    for (const cb of after) cb?.(0);
    // Sober again, nothing.
    p0.drugs.active.length = 0;
    run(sc, 0.5);
    expect(ft.views[0].k).toBe(0);
    expect(draw(0)).toBe(0);
    sc.dispose();
  });

  it('at the peak, ordinary trunks round the tripper look back, in their own view only', () => {
    const { h, sc } = scene(false);
    const [p0] = sc.players;
    const ft = sc.faceTrip!;
    // Somewhere with trunks that can take a face.
    const trees = sc.treesNear(p0.pos.x, p0.pos.z, 120).filter((t) => [0, 1, 3, 7, 8].includes(t.sp) && t.s >= 0.6);
    expect(trees.length).toBeGreaterThan(3);
    p0.drugs.dose('mushrooms');
    run(sc, 45);
    expect(ft.views[0].k).toBeGreaterThan(GHOST_FROM);
    // Spawn straight onto the nearest few, facing the tripper (as the timer would).
    let made = 0;
    for (const t of trees.slice(0, 6)) if (ft.ghosts.spawn(0, t, p0.pos.x, p0.pos.z, 0.4)) made++;
    expect(made).toBeGreaterThan(0);
    // The renderer's per-view hooks, as it calls them before drawing each half (the headless one leaves gaps).
    const hooks = h.R.onBeforeView as (((i: number, cam: unknown) => void) | undefined)[];
    const mine = ft.ghosts.group.children as { visible: boolean }[];
    for (const cb of hooks) cb?.(0, h.R.views[0].camera);
    expect(mine[0].visible).toBe(true);
    expect(mine[1].visible).toBe(false);
    for (const cb of hooks) cb?.(1, h.R.views[1].camera);
    expect(mine[0].visible).toBe(false);
    // Sober, they fade and go.
    p0.drugs.active.length = 0;
    run(sc, 5);
    expect(ft.ghosts.count(0)).toBe(0);
    sc.dispose();
  });
});

describe('face geometry', () => {
  it('carries the eyes and motion on the near mesh only', () => {
    const g = BEND.gums.find((q) => !q.island)!;
    const fine = gumFootGeometry(g, true);
    const coarse = gumFootGeometry(g, false);
    const eye = fine.getAttribute('aEye');
    const morph = fine.getAttribute('aMorph');
    let inEye = 0;
    let lid = 0;
    let brow = 0;
    for (let i = 0; i < eye.count; i++) {
      if (Math.hypot(eye.getX(i), eye.getY(i)) < 0.5) inEye++;
      lid = Math.max(lid, eye.getW(i));
      brow = Math.max(brow, morph.getX(i));
    }
    // Some points in every eye of every face (two to a face).
    expect(inEye).toBeGreaterThanOrEqual(g.faces.length * 2 * 3);
    expect(lid).toBeGreaterThan(0.1);
    expect(brow).toBeGreaterThan(0.02);
    const ce = coarse.getAttribute('aEye');
    for (let i = 0; i < ce.count; i++) {
      expect(ce.getX(i)).toBe(9);
      expect(ce.getW(i)).toBe(0);
    }
  });
});
