import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { WorldMemory } from '../src/game/worldMemory';
import { Btn } from '../src/input/intents';
import { ChunkSource } from '../src/world/chunkgen';
import { plantForage, forageCounts, type ForageSpot } from '../src/world/forage';
import { nearestRoad } from '../src/world/openWorld';
import { CHUNK, waterAt } from '../src/world/terrain';
import { newNeeds } from '../src/sim/needs';
import { DEATHCAP, FORAGE, handfulsLeft, newSickness, pickHandful, pickSeconds, shroomsUp, tickSickness, wantsToEat, type Shroom } from '../src/sim/forage';
import { fakeServices } from './helpers/sim';

vi.setConfig({ testTimeout: 120000 });

beforeAll(async () => {
  await initPhysics();
});

const DT = 1 / 60;

const fed = () => ({ ...newNeeds(), food: 0.95, water: 0.95 });
const hungry = () => ({ ...newNeeds(), food: 0.3, water: 0.3 });

describe('forage rules', () => {
  it('the hungry eat what they pick, the fed put it by', () => {
    const a = pickHandful('fig', { needs: hungry(), cover: 'full', bleeding: false, roll: 0.5 });
    expect(a.ate.food).toBeCloseTo(FORAGE.fig.food);
    expect(a.bank).toEqual({});
    const b = pickHandful('fig', { needs: fed(), cover: 'full', bleeding: false, roll: 0.5 });
    expect(b.ate.food).toBe(0);
    expect(b.bank.rations).toBeCloseTo(FORAGE.fig.bank.rations!);
    // Herbs are never eaten, only put by.
    expect(wantsToEat(hungry(), 'zaatar')).toBe(false);
    expect(pickHandful('zaatar', { needs: hungry(), cover: 'none', bleeding: false, roll: 0.5 }).bank.medicine).toBeGreaterThan(0);
  });

  it('thorns hurt bare hands; fingerless gloves do for brambles but not for prickly pear', () => {
    expect(pickHandful('bramble', { needs: fed(), cover: 'none', bleeding: false, roll: 0.5 }).hurt).toBeGreaterThan(0);
    expect(pickHandful('bramble', { needs: fed(), cover: 'fingerless', bleeding: false, roll: 0.5 }).hurt).toBe(0);
    expect(pickHandful('sabra', { needs: fed(), cover: 'fingerless', bleeding: false, roll: 0.5 }).hurt).toBeGreaterThan(0);
    expect(pickHandful('sabra', { needs: fed(), cover: 'full', bleeding: false, roll: 0.5 }).hurt).toBe(0);
    // Gloved is quicker in thorns, a blade quicker on what it cuts.
    expect(pickSeconds('bramble', false, 'full')).toBeLessThan(pickSeconds('bramble', false, 'none'));
    expect(pickSeconds('zaatar', true, 'none')).toBeLessThan(pickSeconds('zaatar', false, 'none'));
  });

  it('yarrow goes on a bleeding wound, or into the stores as a dressing', () => {
    expect(pickHandful('yarrow', { needs: fed(), cover: 'none', bleeding: true, roll: 0.5 }).bind).toBe(true);
    expect(pickHandful('yarrow', { needs: fed(), cover: 'none', bleeding: false, roll: 0.5 }).bank.bandage).toBe(1);
  });

  it('mushrooms: known death caps are left, unknown ones eaten hungry poison you, and looking them over teaches', () => {
    const known = new Set<Shroom>(['deathcap']);
    expect(pickHandful('mushroom', { needs: hungry(), cover: 'none', bleeding: false, roll: 0.5, shroom: 'deathcap', known }).took).toBe(false);
    const eat = pickHandful('mushroom', { needs: hungry(), cover: 'none', bleeding: false, roll: 0.5, shroom: 'deathcap', known: new Set() });
    expect(eat.poison).toBe(true);
    expect(eat.learn).toBe('deathcap');
    const trip = pickHandful('mushroom', { needs: hungry(), cover: 'none', bleeding: false, roll: 0.5, shroom: 'liberty', known: new Set() });
    expect(trip.trip).toBe(true);
    // Fed: study them. A lucky look teaches and picks; an unlucky one leaves them on the ground.
    const lucky = pickHandful('mushroom', { needs: fed(), cover: 'none', bleeding: false, roll: 0.1, shroom: 'liberty', known: new Set() });
    expect(lucky.learn).toBe('liberty');
    expect(lucky.bank.mushrooms).toBe(1);
    const unlucky = pickHandful('mushroom', { needs: fed(), cover: 'none', bleeding: false, roll: 0.9, shroom: 'field', known: new Set() });
    expect(unlucky.took).toBe(false);
    expect(unlucky.learn).toBeUndefined();
    // Known liberty caps go on the belt even when hungry: nobody trips by accident.
    const safe = pickHandful('mushroom', { needs: hungry(), cover: 'none', bleeding: false, roll: 0.5, shroom: 'liberty', known: new Set<Shroom>(['liberty']) });
    expect(safe.trip).toBe(false);
    expect(safe.bank.mushrooms).toBe(1);
  });

  it('a stripped plant comes back whole after its regrow days', () => {
    expect(handfulsLeft('fig', 0, 1, 1)).toBe(3);
    expect(handfulsLeft('fig', 2, 4, 4)).toBe(1);
    expect(handfulsLeft('fig', 3, 4, 6)).toBe(0);
    expect(handfulsLeft('fig', 3, 4, 4 + FORAGE.fig.regrow)).toBe(3);
  });

  it('mushrooms fruit in some patches on a dry day and all of them after rain', () => {
    let dry = 0;
    for (let i = 0; i < 1000; i++) if (shroomsUp(i / 1000, 0)) dry++;
    expect(dry).toBeGreaterThan(250);
    expect(dry).toBeLessThan(450);
    for (let i = 0; i < 100; i++) expect(shroomsUp(i / 100, 1)).toBe(true);
  });

  it('a death cap waits, then takes health down to a floor and the water with it, and passes', () => {
    const s = newSickness();
    let hp = 100;
    let water = 0;
    let retches = 0;
    let started = false;
    let over = false;
    for (let t = 0; t < DEATHCAP.onset + DEATHCAP.span + 5; t += 0.1) {
      const r = tickSickness(s, 0.1, hp, 100);
      if (t < DEATHCAP.onset - 0.2) expect(r.hp).toBe(0);
      hp -= r.hp;
      water += r.water;
      if (r.retch) retches++;
      started ||= r.started;
      over ||= r.over;
    }
    expect(started && over).toBe(true);
    expect(hp).toBeCloseTo(100 * DEATHCAP.floor, 3);
    expect(water).toBeCloseTo(DEATHCAP.water, 3);
    expect(retches).toBeGreaterThan(3);
  });
});

describe('where things grow', () => {
  const leg = legById('W');
  const src = new ChunkSource(leg);
  const T = src.layout.terrain;
  const st = src.layout.start;
  const all: ForageSpot[] = [];
  const treesBy = new Map<string, { x: number; z: number }[]>();
  const c0x = Math.floor(st.x / CHUNK);
  const c0z = Math.floor(st.z / CHUNK);
  for (let dx = -5; dx <= 5; dx++) {
    for (let dz = -5; dz <= 5; dz++) {
      const d = src.get(c0x + dx, c0z + dz);
      const f = plantForage(T, d.cx, d.cz, { heights: d.heights, aabbs: d.aabbs, props: d.props, trees: d.trees });
      for (const s of f) treesBy.set(s.id, d.trees);
      all.push(...f);
    }
  }

  it('every kind grows somewhere near the start, deterministically', () => {
    const c = forageCounts(all);
    for (const k of Object.keys(c) as (keyof typeof c)[]) expect(c[k], k).toBeGreaterThan(0);
    const d = src.get(c0x, c0z);
    const again = plantForage(T, d.cx, d.cz, { heights: d.heights, aabbs: d.aabbs, props: d.props, trees: d.trees });
    expect(again).toEqual(all.filter((s) => s.id.startsWith(`fg:${d.cx}:${d.cz}:`)));
  });

  it('nothing grows in water or on a road, and mushrooms only under trees', () => {
    for (const s of all) {
      expect(waterAt(T, s.x, s.z), s.id).toBeNull();
      const r = nearestRoad(T.open!, s.x, s.z);
      if (r.road) expect(r.edge, s.id).toBeGreaterThan(3);
      if (s.kind === 'mushroom') {
        const near = Math.min(...treesBy.get(s.id)!.map((t) => Math.hypot(t.x - s.x, t.z - s.z)));
        expect(near, s.id).toBeLessThan(7.01);
      }
    }
  });
});

describe('gathering in a real scene', () => {
  function scene(memory = new WorldMemory()) {
    const h = fakeServices();
    const sc = new LegScene(h.svc, legById('W'), { memory, start: { x: 0, z: 10, yaw: 0 } });
    sc.pendingResult = true;
    for (const p of sc.players) if (p.vehicle) p.exitVehicle(false);
    for (let i = 0; i < 30; i++) sc.tick(DT);
    return { h, sc, memory };
  }

  function hold(h: ReturnType<typeof fakeServices>, sc: LegScene, secs: number) {
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

  /** The nearest plant of a kind to the start, with the player standing at it, the other far off. */
  function standAt(sc: LegScene, kind: ForageSpot['kind']): ForageSpot {
    const f = sc.forage!;
    const s = f
      .spots()
      .filter((q) => q.kind === kind && f.left(q) > 0)
      .sort((a, b) => Math.hypot(a.x, a.z - 10) - Math.hypot(b.x, b.z - 10))[0];
    expect(s, kind).toBeTruthy();
    const p = sc.players[0];
    p.placeAt(s.x + 0.9, s.z, 0);
    sc.players[1]?.placeAt(s.x + 40, s.z + 40, 0);
    for (let i = 0; i < 20; i++) sc.tick(DT);
    return s;
  }

  it('holding the button at a prickly pear picks it: into the stores when fed, and it is remembered across nights', () => {
    const { h, sc, memory } = scene();
    const p = sc.players[0];
    const s = standAt(sc, 'sabra');
    Object.assign(p.needs, { food: 0.95, water: 0.95 });
    p.gear.worn.hands = { uid: 'g-test', id: 'g_work' };
    const rations = sc.campaign.stocks.rations;
    const left = sc.forage!.left(s);
    expect(p.prompt?.text ?? '').toMatch(/prickly pears/);
    hold(h, sc, FORAGE.sabra.pick + 0.4);
    expect(sc.forage!.left(s)).toBe(left - 1);
    expect(sc.campaign.stocks.rations).toBeGreaterThan(rations);
    expect(memory.forage.get(s.id)?.n).toBe(1);
    // A save and a reload keep it picked.
    const back = WorldMemory.restore(JSON.parse(JSON.stringify(memory.serialize())));
    expect(back.forage.get(s.id)).toEqual(memory.forage.get(s.id));
    sc.dispose();
    // The next day it is still short a handful; after it has regrown, it is whole again.
    const next = scene(memory);
    const s2 = next.sc.forage!.spot(s.id)!;
    expect(next.sc.forage!.left(s2)).toBe(left - 1);
    next.sc.campaign.day += FORAGE.sabra.regrow;
    expect(next.sc.forage!.left(s2)).toBe(FORAGE.sabra.handfuls);
    next.sc.dispose();
  });

  it('bare-handed in the spines it hurts; hungry, you eat the fruit', () => {
    const { h, sc } = scene();
    const p = sc.players[0];
    standAt(sc, 'sabra');
    delete p.gear.worn.hands;
    Object.assign(p.needs, { food: 0.3, water: 0.3 });
    const hp = p.hp;
    const food = p.needs.food;
    hold(h, sc, pickSeconds('sabra', false, 'none') + 0.4);
    expect(p.needs.food).toBeGreaterThan(food + 0.1);
    expect(p.hp).toBeLessThan(hp);
    sc.dispose();
  });

  it('a hungry stranger to death caps eats them and is very sick for a while, then learns them', () => {
    const { sc } = scene();
    const p = sc.players[0];
    const f = sc.forage!;
    Object.assign(p.needs, { food: 0.3, water: 0.9 });
    const spot: ForageSpot = { id: 'fg:test', kind: 'mushroom', x: p.pos.x, y: 0, z: p.pos.z, yaw: 0, s: 1, v: 0, h: 0, shroom: 'deathcap' };
    // A patch that is fruiting today.
    for (let k = 0; f.left(spot) === 0; k++) Object.assign(spot, { id: `fg:test${k}`, h: k * 0.013 });
    f.pick(p, spot);
    expect(f.sick.has(0)).toBe(true);
    expect(f.known(p).has('deathcap')).toBe(true);
    const hp = p.hp;
    for (let i = 0; i < Math.round((DEATHCAP.onset + 40) / DT); i++) sc.tick(DT);
    expect(p.hp).toBeLessThan(hp - 10);
    expect(p.needs.water).toBeLessThan(0.9);
    // Now known, the next patch of death caps is left alone.
    const before = p.hp;
    f.pick(p, { ...spot });
    expect(f.sick.get(0)?.t ?? 0).toBeGreaterThan(DEATHCAP.onset);
    expect(p.hp).toBeCloseTo(before, 0);
    sc.dispose();
  });
});
