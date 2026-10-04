import { beforeAll, describe, expect, it } from 'vitest';
import { Btn } from '../src/input/intents';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { CampScene } from '../src/game/campScene';
import { Campaign } from '../src/game/campaign';
import { QUICK } from '../src/game/player';
import {
  NEEDS,
  canRelieve,
  drink,
  eat,
  intakeLevel,
  needChips,
  needMods,
  newNeeds,
  reliefSeconds,
  relieve,
  rest,
  restoreNeeds,
  serializeNeeds,
  tickNeeds,
  wash,
  wasteLevel,
  type NeedEvent,
  type Needs,
} from '../src/sim/needs';
import { fakeServices, run } from './helpers/sim';

beforeAll(async () => {
  await initPhysics();
});

const DT = 1 / 60;

function tickFor(n: Needs, seconds: number, o: Parameters<typeof tickNeeds>[2] = {}): NeedEvent[] {
  const out: NeedEvent[] = [];
  const steps = Math.round(seconds / 0.5);
  for (let i = 0; i < steps; i++) out.push(...tickNeeds(n, 0.5, o));
  return out;
}

describe('needs: draining and filling', () => {
  it('food and water fall with time, faster for water, and a sprint burns more', () => {
    const a = newNeeds();
    const b = newNeeds();
    tickFor(a, 300);
    tickFor(b, 300, { effort: 1 });
    expect(a.food).toBeLessThan(0.92);
    expect(a.water).toBeLessThan(0.9);
    expect(0.9 - a.water).toBeGreaterThan(0.92 - a.food);
    expect(b.water).toBeLessThan(a.water);
    expect(b.food).toBeLessThan(a.food);
  });

  it('the munchies make you hungrier faster', () => {
    const a = newNeeds();
    const b = newNeeds();
    tickFor(a, 300);
    tickFor(b, 300, { appetite: 1.8 });
    expect(b.food).toBeLessThan(a.food);
  });

  it('with no food on a normal day you are hungry by nightfall, starving the day after, and it never goes below zero', () => {
    const n = newNeeds();
    tickFor(n, 720);
    expect(intakeLevel(n.food)).toBe('low');
    tickFor(n, 720);
    expect(intakeLevel(n.food)).toBe('critical');
    tickFor(n, 5000);
    expect(n.food).toBe(0);
    expect(n.water).toBe(0);
  });

  it('what goes in comes out: the bladder and bowels fill behind eating and drinking', () => {
    const n = newNeeds();
    n.bladder = 0;
    n.bowel = 0;
    n.water = 0.3;
    const w = drink(n, 10);
    expect(w.ok).toBe(true);
    expect(n.bladder).toBeGreaterThan(0.05);
    const before = n.bowel;
    n.food = 0.3;
    eat(n, 3);
    expect(n.bowel).toBeGreaterThan(before);
    // Waste also builds up on its own through the day, but an empty stomach slows the bowels to a trickle.
    const full = newNeeds();
    const empty = newNeeds();
    full.bowel = empty.bowel = 0;
    empty.food = 0;
    tickFor(full, 600);
    tickFor(empty, 600);
    expect(empty.bowel).toBeLessThan(full.bowel * 0.6);
  });
});

describe('needs: warnings and accidents', () => {
  it('each warning fires once as the band is crossed, not every tick', () => {
    const n = newNeeds();
    const ev = tickFor(n, 3000);
    const warns = ev.filter((e) => e.type === 'warn');
    const key = (e: NeedEvent) => (e.type === 'warn' ? `${e.need}:${e.level}` : e.type);
    const keys = warns.map(key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('food:low');
    expect(keys).toContain('water:critical');
  });

  it('a warning can fire again after you have dealt with it', () => {
    const n = newNeeds();
    n.bladder = 0.59;
    let warns = tickFor(n, 10).filter((e) => e.type === 'warn' && e.need === 'bladder');
    expect(warns).toHaveLength(1);
    relieve(n, 'piss', 1);
    tickNeeds(n, 0.5);
    n.bladder = 0.59;
    warns = tickFor(n, 10).filter((e) => e.type === 'warn' && e.need === 'bladder');
    expect(warns).toHaveLength(1);
  });

  it('a full bladder comes out on its own: wet, and most of it gone', () => {
    const n = newNeeds();
    n.bladder = 0.9995;
    const ev = tickFor(n, 3);
    expect(ev.some((e) => e.type === 'accident' && e.kind === 'piss')).toBe(true);
    expect(n.bladder).toBeCloseTo(NEEDS.afterAccident, 1);
    expect(n.wet).toBeGreaterThan(0);
    expect(n.soiled).toBe(0);
  });

  it('full bowels are the worse accident: soiled for longer, and the dead smell it further', () => {
    const wet = newNeeds();
    const soiled = newNeeds();
    wet.bladder = 0.9995;
    soiled.bowel = 0.9995;
    tickFor(wet, 3);
    const ev = tickFor(soiled, 3);
    expect(ev.some((e) => e.type === 'accident' && e.kind === 'shit')).toBe(true);
    expect(soiled.soiled).toBeGreaterThan(wet.wet);
    expect(needMods(soiled).aggro).toBeGreaterThan(needMods(wet).aggro);
    expect(needMods(wet).aggro).toBeGreaterThan(1);
  });

  it('nothing is soiled in the bedroll', () => {
    const n = newNeeds();
    n.bladder = 1;
    n.bowel = 1;
    expect(tickFor(n, 3, { asleep: true }).filter((e) => e.type === 'accident')).toHaveLength(0);
  });

  it('the smell fades, and a lake washes it off at once', () => {
    const n = newNeeds();
    n.soiled = NEEDS.soiledSeconds;
    n.wet = NEEDS.wetSeconds;
    tickFor(n, NEEDS.wetSeconds + 5);
    expect(n.wet).toBe(0);
    expect(n.soiled).toBeGreaterThan(0);
    expect(wash(n)).toBe(true);
    expect(n.soiled).toBe(0);
    expect(wash(n)).toBe(false);
    expect(needMods(n).aggro).toBe(1);
  });
});

describe('needs: doing something about it', () => {
  it('eating needs a whole ration and an appetite, and a ration fills you by half', () => {
    const n = newNeeds();
    n.food = 0.2;
    expect(eat(n, 0.9).ok).toBe(false);
    const r = eat(n, 1);
    expect(r).toMatchObject({ ok: true, spent: 1 });
    expect(n.food).toBeCloseTo(0.2 + NEEDS.rationFood, 5);
    n.food = 0.95;
    expect(eat(n, 5)).toMatchObject({ ok: false, reason: 'You are not hungry' });
    n.food = 0.7;
    eat(n, 5);
    expect(n.food).toBe(1);
  });

  it('a drink from the reserve costs litres, in proportion to what you could take', () => {
    const n = newNeeds();
    n.water = 0.2;
    expect(drink(n, 0).ok).toBe(false);
    const r = drink(n, 10);
    expect(r.spent).toBeCloseTo(NEEDS.drinkLitres, 5);
    expect(n.water).toBeCloseTo(0.2 + NEEDS.drinkWater, 5);
    // Nearly full: you only take what fits, and only pay for that.
    n.water = 0.85;
    const r2 = drink(n, 10);
    expect(n.water).toBe(1);
    expect(r2.spent!).toBeLessThan(NEEDS.drinkLitres * 0.7);
    // A dry reserve gives a part-drink at most.
    n.water = 0.1;
    const r3 = drink(n, 0.3);
    expect(r3.spent).toBeCloseTo(0.3, 5);
    expect(n.water).toBeLessThan(0.1 + NEEDS.drinkWater);
  });

  it('a lake is free, and raw water sometimes upsets the stomach', () => {
    const clean = newNeeds();
    const dirty = newNeeds();
    clean.water = dirty.water = 0.3;
    clean.bowel = dirty.bowel = 0;
    const a = drink(clean, 0, { lake: true, roll: 0.9 });
    const b = drink(dirty, 0, { lake: true, roll: 0.05 });
    expect(a).toMatchObject({ ok: true, spent: 0, dirty: false });
    expect(b).toMatchObject({ ok: true, spent: 0, dirty: true });
    expect(dirty.bowel).toBeGreaterThan(clean.bowel + 0.2);
  });

  it('you cannot go with nothing to go, and a bigger load takes longer to empty', () => {
    const n = newNeeds();
    n.bladder = n.bowel = 0.05;
    expect(canRelieve(n, 'piss').ok).toBe(false);
    expect(canRelieve(n, 'shit').ok).toBe(false);
    n.bladder = 0.3;
    const small = reliefSeconds(n, 'piss');
    n.bladder = 1;
    const big = reliefSeconds(n, 'piss');
    expect(canRelieve(n, 'piss').ok).toBe(true);
    expect(big).toBeGreaterThan(small);
    expect(big).toBe(NEEDS.pissSeconds);
    n.bowel = 1;
    expect(reliefSeconds(n, 'shit')).toBeGreaterThan(big);
    relieve(n, 'piss', 5);
    expect(n.bladder).toBe(0);
  });

  it('sleep brings you back up with supper and a drink, hollows you without, and leaves you needing a piss', () => {
    const fed = newNeeds();
    const hollow = newNeeds();
    fed.food = hollow.food = 0.4;
    fed.water = hollow.water = 0.4;
    fed.bladder = hollow.bladder = 0.3;
    fed.soiled = 100;
    rest(fed, { fed: true, watered: true });
    rest(hollow, { fed: false, watered: false });
    expect(fed.food).toBe(1);
    expect(fed.water).toBeGreaterThan(0.85);
    expect(hollow.food).toBeLessThan(0.4);
    expect(hollow.water).toBeLessThan(0.4);
    expect(fed.bladder).toBeGreaterThan(0.5);
    expect(fed.soiled).toBe(0);
    // It never wakes you with an accident already on it.
    const full = newNeeds();
    full.bladder = full.bowel = 1;
    rest(full, { fed: true, watered: true });
    expect(full.bladder).toBeLessThan(1);
    expect(full.bowel).toBeLessThan(1);
  });
});

describe('needs: what it does to you', () => {
  it('a comfortable body has no modifiers and no chips', () => {
    const n = newNeeds();
    expect(needMods(n)).toEqual({ speed: 1, drain: 1, regen: 1, spread: 1, aggro: 1, sway: 0, shake: 0, hurt: 0 });
    expect(needChips(n)).toEqual([]);
  });

  it('hungry slows your wind, starving also slows your legs and hurts', () => {
    const n = newNeeds();
    n.food = 0.25;
    const low = needMods(n);
    expect(low.regen).toBeLessThan(1);
    expect(low.hurt).toBe(0);
    n.food = 0.05;
    const crit = needMods(n);
    expect(crit.regen).toBeLessThan(low.regen);
    expect(crit.speed).toBeLessThan(1);
    expect(crit.hurt).toBeGreaterThan(0);
  });

  it('parched is worse than starving, and bone dry is worse again', () => {
    const a = newNeeds();
    const b = newNeeds();
    const c = newNeeds();
    a.food = 0.05;
    b.water = 0.05;
    c.water = 0;
    expect(needMods(b).hurt).toBeGreaterThan(needMods(a).hurt);
    expect(needMods(c).hurt).toBeGreaterThan(needMods(b).hurt);
    expect(needMods(b).drain).toBeGreaterThan(1);
    expect(needMods(b).sway).toBeGreaterThan(0);
  });

  it('being desperate for the toilet spoils your aim and your sprint', () => {
    const n = newNeeds();
    n.bladder = 0.7;
    expect(needMods(n)).toEqual(needMods(newNeeds()));
    n.bladder = 0.9;
    const m = needMods(n);
    expect(m.spread).toBeGreaterThan(1);
    expect(m.drain).toBeGreaterThan(1);
    n.bowel = 0.9;
    expect(needMods(n).speed).toBeLessThan(1);
  });

  it('the chips say what is wrong, in order of how bad it is', () => {
    const n = newNeeds();
    n.food = 0.2;
    n.water = 0.05;
    n.bladder = 0.7;
    n.bowel = 0.9;
    n.soiled = 50;
    const text = needChips(n).map((c) => c.text);
    expect(text).toEqual(['HUNGRY', 'PARCHED', 'NEED A PISS', 'CLENCHING', 'SOILED: THE DEAD CAN SMELL YOU']);
    expect(wasteLevel(0.6)).toBe('urge');
    expect(wasteLevel(0.85)).toBe('desperate');
  });
});

describe('needs: saving', () => {
  it('round-trips through a save, and a bad or missing one falls back to well fed', () => {
    const n = newNeeds();
    n.food = 0.33;
    n.soiled = 12;
    const back = restoreNeeds(JSON.parse(JSON.stringify(serializeNeeds(n))));
    expect(back).toEqual(n);
    expect(restoreNeeds(undefined)).toEqual(newNeeds());
    const junk = restoreNeeds({ food: Number.NaN, water: 7, bladder: -2 } as never);
    expect(junk.food).toBe(newNeeds().food);
    expect(junk.water).toBe(1);
    expect(junk.bladder).toBe(0);
  });

  it('the campaign keeps each body through serialize and deserialize, and an old save without needs still loads', () => {
    const c = new Campaign(['Ash', 'Rook'], false);
    c.needs[0].food = 0.1;
    c.needs[1].bowel = 0.77;
    const blob = JSON.parse(JSON.stringify(c.serialize()));
    const back = Campaign.deserialize(blob);
    expect(back.needs[0].food).toBeCloseTo(0.1, 5);
    expect(back.needs[1].bowel).toBeCloseTo(0.77, 5);
    delete blob.needs;
    const old = Campaign.deserialize(blob);
    expect(old.needs[0]).toEqual(newNeeds());
    expect(old.needs[1]).toEqual(newNeeds());
  });
});

// ------------------------------------------------------------------ on foot, in a real scene

function leg() {
  const h = fakeServices();
  const sc = new LegScene(h.svc, legById('L1'));
  for (const p of sc.players) p.exitVehicle(false);
  run(sc, 0.6);
  return { sc, ...h };
}
type H = ReturnType<typeof leg>;

/** Rest the belt on a slot, then tap the use button. */
function tapSlot(h: H, slot: (typeof QUICK)[number]) {
  const p = h.sc.players[0];
  (p as unknown as { dressingSel: string | null }).dressingSel = slot;
  const it = h.intents[0];
  it.pressed |= 1 << Btn.Down;
  it.held |= 1 << Btn.Down;
  h.sc.tick(DT);
  it.pressed &= ~(1 << Btn.Down);
  run(h.sc, 0.05);
  it.held &= ~(1 << Btn.Down);
  it.released |= 1 << Btn.Down;
  h.sc.tick(DT);
  it.released &= ~(1 << Btn.Down);
}

describe('the belt', () => {
  it('has the four chores after the drugs', () => {
    expect(QUICK.slice(-4)).toEqual(['eat', 'drink', 'piss', 'shit']);
  });

  it('left and right walk onto them and back off again', () => {
    const h = leg();
    const p = h.sc.players[0];
    h.campaign.drugs[0].selected = 'ayahuasca';
    const it = h.intents[0];
    it.pressed |= 1 << Btn.Down;
    it.held |= 1 << Btn.Down;
    h.sc.tick(DT);
    it.pressed = 0;
    run(h.sc, 0.5);
    expect(p.beltOpen).toBe(true);
    it.nav = 8;
    h.sc.tick(DT);
    it.nav = 0;
    h.sc.tick(DT);
    expect(p.quickSel).toBe('eat');
    it.nav = 4;
    h.sc.tick(DT);
    it.nav = 0;
    h.sc.tick(DT);
    expect(p.quickSel).toBe('ayahuasca');
    it.held = 0;
    h.sc.tick(DT);
    h.sc.dispose();
  }, 60000);
});

describe('eat and drink on foot', () => {
  it('eating takes a ration from the stores and fills you up, and your hands are busy for a moment', () => {
    const h = leg();
    const p = h.sc.players[0];
    h.campaign.stocks.rations = 3;
    h.campaign.needs[0].food = 0.2;
    tapSlot(h, 'eat');
    expect(h.campaign.stocks.rations).toBe(2);
    expect(h.campaign.needs[0].food).toBeGreaterThan(0.7);
    expect(p.fireCd).toBeGreaterThan(0.5);
    expect(h.sounds).toContain('munch');
    h.sc.dispose();
  }, 60000);

  it('eating with no rations, or on a full belly, takes nothing and says why', () => {
    const h = leg();
    const p = h.sc.players[0];
    h.campaign.stocks.rations = 0;
    h.campaign.needs[0].food = 0.2;
    tapSlot(h, 'eat');
    expect(h.campaign.needs[0].food).toBeLessThan(0.3);
    expect(p.notes.some((n) => /No rations/i.test(n.text))).toBe(true);
    h.campaign.stocks.rations = 4;
    h.campaign.needs[0].food = 0.97;
    tapSlot(h, 'eat');
    expect(h.campaign.stocks.rations).toBe(4);
    expect(p.notes.some((n) => /not hungry/i.test(n.text))).toBe(true);
    h.sc.dispose();
  }, 60000);

  it('only the one who pressed it eats', () => {
    const h = leg();
    h.campaign.stocks.rations = 3;
    h.campaign.needs[0].food = 0.2;
    h.campaign.needs[1].food = 0.2;
    tapSlot(h, 'eat');
    expect(h.campaign.needs[0].food).toBeGreaterThan(0.6);
    expect(h.campaign.needs[1].food).toBeLessThan(0.25);
    h.sc.dispose();
  }, 60000);

  it('drinking costs litres from the water reserve and slakes you', () => {
    const h = leg();
    h.campaign.items.water = 10;
    h.campaign.needs[0].water = 0.15;
    tapSlot(h, 'drink');
    expect(h.campaign.items.water).toBeCloseTo(10 - NEEDS.drinkLitres, 1);
    expect(h.campaign.needs[0].water).toBeGreaterThan(0.38);
    expect(h.sounds).toContain('gulp');
    h.sc.dispose();
  }, 60000);

  it('an empty reserve gives you nothing to drink', () => {
    const h = leg();
    const p = h.sc.players[0];
    h.campaign.items.water = 0;
    h.campaign.needs[0].water = 0.15;
    tapSlot(h, 'drink');
    expect(h.campaign.needs[0].water).toBeLessThan(0.2);
    expect(p.notes.some((n) => /No water/i.test(n.text))).toBe(true);
    h.sc.dispose();
  }, 60000);
});

describe('piss and shit on foot', () => {
  it('a piss roots you to the spot, empties the bladder, and leaves a puddle', () => {
    const h = leg();
    const p = h.sc.players[0];
    h.campaign.needs[0].bladder = 0.8;
    const marks = h.sc.gore.decals.count;
    tapSlot(h, 'piss');
    expect(p.relief?.kind).toBe('piss');
    const x = p.pos.x;
    const z = p.pos.z;
    run(h.sc, 1);
    expect(h.campaign.needs[0].bladder).toBeLessThan(0.7);
    expect(Math.hypot(p.pos.x - x, p.pos.z - z)).toBeLessThan(0.3);
    expect(p.prompt?.text).toMatch(/Pissing/);
    run(h.sc, NEEDS.pissSeconds);
    expect(p.relief).toBeNull();
    expect(h.campaign.needs[0].bladder).toBeLessThan(0.02);
    expect(h.sc.gore.decals.count).toBeGreaterThan(marks);
    expect(p.notes.some((n) => /better/i.test(n.text))).toBe(true);
    h.sc.dispose();
  }, 60000);

  it('a shit is a long squat, and you stand up out of it afterwards', () => {
    const h = leg();
    const p = h.sc.players[0];
    h.campaign.needs[0].bowel = 0.9;
    p.crouch = false;
    tapSlot(h, 'shit');
    expect(p.relief?.kind).toBe('shit');
    run(h.sc, 1);
    expect(p.crouch).toBe(true);
    run(h.sc, NEEDS.shitSeconds);
    expect(p.relief).toBeNull();
    expect(p.crouch).toBe(false);
    expect(h.campaign.needs[0].bowel).toBeLessThan(0.02);
    h.sc.dispose();
  }, 60000);

  it('walking off stops it part way, with what is left still in you', () => {
    const h = leg();
    const p = h.sc.players[0];
    h.campaign.needs[0].bladder = 0.95;
    tapSlot(h, 'piss');
    run(h.sc, 1);
    h.intents[0].move = [0, 1];
    run(h.sc, 0.2);
    h.intents[0].move = [0, 0];
    expect(p.relief).toBeNull();
    const left = h.campaign.needs[0].bladder;
    expect(left).toBeGreaterThan(0.4);
    expect(left).toBeLessThan(0.9);
    expect(p.notes.some((n) => /some left/i.test(n.text))).toBe(true);
    h.sc.dispose();
  }, 60000);

  it('a hit interrupts it, loudly', () => {
    const h = leg();
    const p = h.sc.players[0];
    h.campaign.needs[0].bowel = 0.95;
    tapSlot(h, 'shit');
    run(h.sc, 1);
    expect(p.relief).not.toBeNull();
    p.hurt(5, p.pos.x + 1, p.pos.z, 'melee');
    expect(p.relief).toBeNull();
    expect(p.crouch).toBe(false);
    expect(p.notes.some((n) => /interrupted/i.test(n.text))).toBe(true);
    h.sc.dispose();
  }, 60000);

  it('tapping the button again while it is going on stops it', () => {
    const h = leg();
    const p = h.sc.players[0];
    h.campaign.needs[0].bladder = 0.95;
    tapSlot(h, 'piss');
    expect(p.relief).not.toBeNull();
    tapSlot(h, 'piss');
    expect(p.relief).toBeNull();
    h.sc.dispose();
  }, 60000);

  it('with nothing to go, it says so and does not start', () => {
    const h = leg();
    const p = h.sc.players[0];
    h.campaign.needs[0].bladder = 0.02;
    tapSlot(h, 'piss');
    expect(p.relief).toBeNull();
    expect(p.notes.some((n) => /do not need/i.test(n.text))).toBe(true);
    h.sc.dispose();
  }, 60000);

  it('not from a vehicle seat, and not while carrying something', () => {
    const h = fakeServices();
    const sc = new LegScene(h.svc, legById('L1'));
    run(sc, 0.6);
    const p = sc.players[0];
    expect(p.state).toBe('driving');
    h.campaign.needs[0].bladder = 0.95;
    (p as unknown as { dressingSel: string }).dressingSel = 'piss';
    const it = h.intents[0];
    it.pressed |= 1 << Btn.Down;
    it.held |= 1 << Btn.Down;
    sc.tick(DT);
    it.pressed = 0;
    it.held = 0;
    it.released |= 1 << Btn.Down;
    sc.tick(DT);
    expect(p.relief).toBeNull();
    sc.dispose();
  }, 60000);
});

describe('what the body does to the player', () => {
  it('a full bladder that is ignored comes out by itself: you are stunned, wet, and the dead notice more', () => {
    const h = leg();
    const p = h.sc.players[0];
    h.campaign.needs[0].bladder = 0.9999;
    run(h.sc, 1);
    expect(h.campaign.needs[0].wet).toBeGreaterThan(0);
    expect(p.nm.aggro).toBeGreaterThan(1);
    expect(p.notes.some((n) => /wet yourself/i.test(n.text))).toBe(true);
    expect(h.sounds).toContain('trickle');
    // The partner is told.
    expect(h.sc.players[1].notes.some((n) => /wet themselves/i.test(n.text))).toBe(true);
    h.sc.dispose();
  }, 60000);

  it('soiling yourself stuns you for longer, and leaves a pile', () => {
    const h = leg();
    const p = h.sc.players[0];
    const marks = h.sc.gore.decals.count;
    h.campaign.needs[0].bowel = 0.9999;
    run(h.sc, 0.2);
    expect(p.stunT).toBeGreaterThan(0.6);
    expect(h.campaign.needs[0].soiled).toBeGreaterThan(0);
    expect(h.sc.gore.decals.count).toBeGreaterThan(marks);
    expect(p.notes.some((n) => /shit yourself/i.test(n.text))).toBe(true);
    h.sc.dispose();
  }, 60000);

  it('starving takes health but never the last of it', () => {
    const h = leg();
    const p = h.sc.players[0];
    h.campaign.needs[0].food = 0;
    h.campaign.needs[0].water = 0;
    p.hp = p.maxHp;
    run(h.sc, 90);
    expect(p.hp).toBeLessThan(p.maxHp);
    expect(p.hp).toBeGreaterThanOrEqual(p.maxHp * NEEDS.hpFloor - 0.01);
    expect(p.state).toBe('foot');
    h.sc.dispose();
  }, 60000);

  it('hunger shows up as chips and as a spoiled aim and a slower walk', () => {
    const h = leg();
    const p = h.sc.players[0];
    h.campaign.needs[0].food = 0.05;
    run(h.sc, 0.3);
    expect(needChips(p.needs).map((c) => c.text)).toContain('STARVING');
    expect(p.nm.speed).toBeLessThan(1);
    expect(p.nm.spread).toBeGreaterThan(1);
    h.sc.dispose();
  }, 60000);

  it('the first warning of a run brings up the tip, once', () => {
    const tips: string[] = [];
    const h = fakeServices();
    (h.svc as unknown as { onTip: (id: string) => void }).onTip = (id) => tips.push(id);
    const sc = new LegScene(h.svc, legById('L1'));
    for (const p of sc.players) p.exitVehicle(false);
    run(sc, 0.6);
    h.campaign.needs[0].food = 0.29;
    run(sc, 2);
    h.campaign.needs[0].water = 0.29;
    run(sc, 2);
    expect(tips.filter((t) => t === 'needs')).toHaveLength(1);
    sc.dispose();
  }, 60000);
});

describe('a night at camp', () => {
  function dawn(setup: (c: Campaign) => void) {
    const h = fakeServices({ solo: true });
    const leg = legById('L1');
    const sc = new CampScene(h.svc, leg, leg.campSites[0], true);
    run(sc, 1);
    setup(h.campaign);
    (sc as unknown as { dawn(): void }).dawn();
    return { h, sc, lines: (sc as unknown as { report: { lines: string[] } }).report.lines };
  }

  it('someone hungry eats supper from the rations and wakes fed', () => {
    const { h, sc } = dawn((c) => {
      c.stocks.rations = 3;
      c.needs[0].food = 0.3;
    });
    expect(h.campaign.stocks.rations).toBe(2);
    expect(h.campaign.needs[0].food).toBe(1);
    sc.dispose();
  }, 60000);

  it('someone who has been eating all day skips supper and keeps the ration', () => {
    const { h, lines, sc } = dawn((c) => {
      c.stocks.rations = 3;
      c.needs[0].food = 0.85;
    });
    expect(h.campaign.stocks.rations).toBe(3);
    expect(lines.some((l) => /already eaten and skipped supper/.test(l))).toBe(true);
    sc.dispose();
  }, 60000);

  it('with no rations you go hungry, wake hollow, and are patched up less', () => {
    const { h, lines, sc } = dawn((c) => {
      c.stocks.rations = 0;
      c.needs[0].food = 0.3;
    });
    expect(lines).toContain('No Rations. You went hungry.');
    expect(h.campaign.needs[0].food).toBeLessThan(0.3);
    const p = sc.players[0];
    expect(p.hp).toBe(Math.round(p.maxHp * 0.65));
    sc.dispose();
  }, 60000);

  it('the night drinks a litre from the reserve, or you wake parched when it is dry', () => {
    const wet = dawn((c) => {
      c.items.water = 5;
      c.needs[0].water = 0.3;
    });
    expect(wet.h.campaign.items.water).toBe(4);
    expect(wet.h.campaign.needs[0].water).toBeGreaterThan(0.85);
    wet.sc.dispose();
    const dry = dawn((c) => {
      c.items.water = 0;
      c.needs[0].water = 0.3;
    });
    expect(dry.lines.some((l) => /reserve is dry/.test(l))).toBe(true);
    expect(dry.h.campaign.needs[0].water).toBeLessThan(0.3);
    dry.sc.dispose();
  }, 60000);

  it('you wake with a fuller bladder and clean clothes', () => {
    const { h, sc } = dawn((c) => {
      c.needs[0].bladder = 0.2;
      c.needs[0].soiled = 200;
    });
    expect(h.campaign.needs[0].bladder).toBeGreaterThan(0.45);
    expect(h.campaign.needs[0].soiled).toBe(0);
    sc.dispose();
  }, 60000);
});
