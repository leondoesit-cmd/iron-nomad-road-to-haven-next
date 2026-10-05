import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import {
  ATTITUDES,
  REQUEST_KINDS,
  TRAVELLERS,
  TRAVELLER_KINDS,
  STOCK_IDS,
  hasString,
  legById,
  t,
  validateData,
  type Stocks,
} from '../src/data';
import { Rng } from '../src/core/rng';
import { newStocks } from '../src/sim/resources';
import {
  Route,
  barkChance,
  barkKey,
  buyLot,
  censusOf,
  fleeAt,
  lootOf,
  makeStock,
  murderAxes,
  pickKind,
  requestCost,
  resolveRequest,
  rollTraveller,
  sectorKey,
  sellLot,
  spawnGap,
  suspicionRate,
  vehicleThreat,
  wantsRoom,
} from '../src/sim/travellers';
import { LegScene } from '../src/game/legScene';
import { WorldMemory } from '../src/game/worldMemory';
import { resolveTravellerRequest } from '../src/game/travellerFx';
import { roadX } from '../src/world/terrain';
import { fakeServices, run } from './helpers/sim';

vi.setConfig({ testTimeout: 120000 });

const R = TRAVELLERS.rules;

describe('traveller data', () => {
  it('passes the data checks, and every line of text exists', () => {
    expect(validateData().filter((e) => /travel|request|trade|bark/i.test(e))).toEqual([]);
  });

  it('keeps traders neutral and everyone else mostly neutral', () => {
    for (const k of TRAVELLER_KINDS) {
      const a = TRAVELLERS.archetypes[k].attitudes;
      if (TRAVELLERS.archetypes[k].trade) {
        expect(a.neutral).toBeGreaterThan(0);
        expect(a.rude + a.wary).toBe(0);
      } else expect(a.neutral).toBeGreaterThanOrEqual(a.rude);
    }
    // Across the whole road, neutral is the commonest attitude by a clear margin.
    const rng = new Rng(9);
    const seen = { neutral: 0, rude: 0, wary: 0 };
    for (let i = 0; i < 4000; i++) {
      const kind = pickKind(rng, { night: 0, census: {} })!;
      seen[rollTraveller(rng, kind).attitude]++;
    }
    expect(seen.neutral).toBeGreaterThan(seen.rude + seen.wary);
    expect(seen.rude).toBeGreaterThan(100);
    expect(seen.wary).toBeGreaterThan(100);
  });

  it('only some ask for help, and never a trader', () => {
    const rng = new Rng(21);
    let asked = 0;
    let n = 0;
    for (let i = 0; i < 3000; i++) {
      const kind = pickKind(rng, { night: 0, census: {} })!;
      const r = rollTraveller(rng, kind);
      n++;
      if (r.request) asked++;
      if (TRAVELLERS.archetypes[kind].trade) expect(r.request).toBeNull();
    }
    expect(asked / n).toBeGreaterThan(0.05);
    expect(asked / n).toBeLessThan(0.3);
  });
});

describe('who turns up and when', () => {
  it('respects the caps and thins out at night and in a storm', () => {
    const rng = new Rng(3);
    // A trader is capped at one: with one already on the road, none is picked.
    for (let i = 0; i < 300; i++) expect(pickKind(rng, { night: 0, census: { trader: 1 } })).not.toBe('trader');
    // Everything at its cap: nothing comes.
    const full = censusOf(TRAVELLER_KINDS.flatMap((k) => Array<typeof k>(TRAVELLERS.archetypes[k].cap).fill(k)));
    expect(pickKind(rng, { night: 0, census: full })).toBeNull();
    const day = Array.from({ length: 200 }, () => spawnGap(rng, { night: 0, storm: 0 })).reduce((a, b) => a + b) / 200;
    const night = Array.from({ length: 200 }, () => spawnGap(rng, { night: 1, storm: 0 })).reduce((a, b) => a + b) / 200;
    const storm = Array.from({ length: 200 }, () => spawnGap(rng, { night: 0, storm: 1 })).reduce((a, b) => a + b) / 200;
    expect(day).toBeGreaterThan(R.spawnEvery * 0.8);
    expect(night).toBeGreaterThan(day * 2);
    expect(storm).toBeGreaterThan(day * 2);
  });
});

describe('how they react', () => {
  const calm = { dist: 20, onFoot: true, aimed: false, rushing: false, gunfire: false };

  it('are put out by a gun pointed at them, and wary people more than the rest', () => {
    for (const a of ATTITUDES) expect(suspicionRate(a, { ...calm, aimed: true })).toBeGreaterThan(0);
    expect(suspicionRate('wary', { ...calm, aimed: true })).toBeGreaterThan(suspicionRate('neutral', { ...calm, aimed: true }));
    expect(suspicionRate('neutral', { ...calm, aimed: true })).toBeGreaterThan(suspicionRate('rude', { ...calm, aimed: true }) * 1.1);
  });

  it('settle when nothing threatens them, a wary one slowest', () => {
    for (const a of ATTITUDES) expect(suspicionRate(a, calm)).toBeLessThan(0);
    expect(Math.abs(suspicionRate('wary', calm))).toBeLessThan(Math.abs(suspicionRate('neutral', calm)));
  });

  it('run before an armed person would, and an armed person does not run', () => {
    expect(fleeAt('wary', false)).toBeLessThan(fleeAt('neutral', false));
    expect(fleeAt('neutral', true)).toBe(Infinity);
  });

  it('only a wary person asks for room, and only once unsure', () => {
    expect(wantsRoom('wary', 0.5)).toBe(true);
    expect(wantsRoom('wary', 0.1)).toBe(false);
    expect(wantsRoom('neutral', 1)).toBe(false);
    expect(wantsRoom('rude', 1)).toBe(false);
  });

  it('step off the road for a vehicle coming at them, not one going away, parked, or well to the side', () => {
    expect(vehicleThreat(20, 15, 1, true)).toBe(true);
    expect(vehicleThreat(20, 15, 1, false)).toBe(false);
    expect(vehicleThreat(20, 2, 1, true)).toBe(false);
    expect(vehicleThreat(20, 15, 12, true)).toBe(false);
    // The faster it comes, the sooner they get out of its way.
    expect(vehicleThreat(R.yieldAhead + 10, 30, 0, true)).toBe(true);
    expect(vehicleThreat(R.yieldAhead + 10, 8, 0, true)).toBe(false);
  });

  it('the rude and the wary have more to say to traffic and strangers than the neutral', () => {
    expect(barkChance('rude', 'pass')).toBeGreaterThan(barkChance('neutral', 'pass'));
    expect(barkChance('wary', 'pass')).toBeGreaterThan(barkChance('neutral', 'pass'));
    expect(barkChance('rude', 'greet')).toBeGreaterThan(barkChance('neutral', 'greet'));
    // A gun in their face always gets an answer.
    for (const a of ATTITUDES) expect(barkChance(a, 'aimed')).toBe(1);
  });

  it('picks a line from every bark pool', () => {
    const rng = new Rng(1);
    for (const pool of Object.keys(TRAVELLERS.barks)) expect(hasString(barkKey(rng, pool))).toBe(true);
  });

  it('names the way to a place with the HUD compass: north is +z and west is +x', () => {
    expect(sectorKey(0, 100)).toBe('n');
    expect(sectorKey(100, 0)).toBe('w');
    expect(sectorKey(-100, 0)).toBe('e');
    expect(sectorKey(0, -100)).toBe('s');
    expect(sectorKey(100, 100)).toBe('nw');
    expect(sectorKey(-100, -100)).toBe('se');
    for (const k of ['n', 'nw', 'w', 'sw', 's', 'se', 'e', 'ne']) expect(hasString(`trav.dir.${k}`)).toBe(true);
  });
});

describe('asking for help', () => {
  it('costs what it says, pays Mercy, and thanks you in kind', () => {
    const rng = new Rng(5);
    const fx = resolveRequest(rng, 'food', true);
    expect(fx.stocks.rations).toBeLessThanOrEqual(-2 + (TRAVELLERS.requests.food.thanks.rations?.[1] ?? 0));
    expect(fx.stocks.scrap).toBeGreaterThanOrEqual(4);
    expect(fx.axes.mercy).toBe(1);
    expect(fx.ambush + fx.zombies).toBe(0);
    expect(fx.fragment).toBe(false);
  });

  it('turning down a fever costs Mercy, and turning down a meal does not', () => {
    const rng = new Rng(5);
    expect(resolveRequest(rng, 'medicine', false).axes.mercy).toBe(-1);
    expect(resolveRequest(rng, 'food', false).axes).toEqual({});
    expect(resolveRequest(rng, 'food', false).stocks).toEqual({});
  });

  it('pointing someone the right way is free', () => {
    expect(requestCost('directions')).toEqual({});
    const fx = resolveRequest(new Rng(2), 'directions', true);
    expect(Object.values(fx.stocks).every((v) => !v)).toBe(true);
    expect(fx.axes.trust).toBe(1);
  });

  it('has an ask, a title and a label for every kind and attitude', () => {
    for (const k of REQUEST_KINDS) {
      expect(hasString(`trav.ask.${k}.title`)).toBe(true);
      expect(hasString(`trav.ask.${k}.give`)).toBe(true);
      for (const a of ATTITUDES) expect(hasString(`trav.ask.${k}.${a}`)).toBe(true);
    }
  });
});

describe("a trader's cart", () => {
  const stocks = (o: Partial<Stocks>) => newStocks(o);

  it('has a handful of lots, priced near the listed price', () => {
    const rng = new Rng(11);
    for (let i = 0; i < 40; i++) {
      const s = makeStock(rng);
      expect(s.buy).toHaveLength(TRAVELLERS.trade.buyCount);
      expect(s.sell).toHaveLength(TRAVELLERS.trade.sellCount);
      expect(s.purse).toBeGreaterThanOrEqual(TRAVELLERS.trade.purse[0]);
      expect(s.purse).toBeLessThanOrEqual(TRAVELLERS.trade.purse[1]);
      for (const o of s.buy) {
        const base = TRAVELLERS.trade.buy.find((b) => b.id === o.id)!;
        const ratio = (o.cost.scrap ?? 0) / (base.cost.scrap ?? 1);
        expect(ratio).toBeGreaterThan(1 - TRAVELLERS.trade.priceSpread - 0.08);
        expect(ratio).toBeLessThan(1 + TRAVELLERS.trade.priceSpread + 0.08);
        expect(o.left).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('sells for Scrap, runs out, and refuses a customer who is short', () => {
    const s = makeStock(new Rng(4));
    const lot = s.buy[0];
    const price = lot.cost.scrap ?? 0;
    const mine = stocks({ scrap: price * 10 });
    const left = lot.left;
    let sold = 0;
    while (buyLot(s, mine, 0) === 'ok') sold++;
    expect(sold).toBe(left);
    expect(buyLot(s, mine, 0)).toBe('sold');
    const poor = stocks({ scrap: 0 });
    const fresh = makeStock(new Rng(4));
    expect(buyLot(fresh, poor, 0)).toBe('poor');
    expect(poor.scrap).toBe(0);
  });

  it('pays out of a purse that runs dry, and takes only what you hold', () => {
    const s = makeStock(new Rng(8));
    s.purse = 10;
    const o = s.sell[0];
    const pay = o.pay.scrap ?? 0;
    const mine = stocks({ rations: 50, parts: 50, tech: 50, medicine: 50, fuel: 50 });
    let n = 0;
    while (sellLot(s, mine, 0) === 'ok') n++;
    expect(n).toBe(Math.floor(10 / pay));
    expect(sellLot(s, mine, 0)).toBe('broke');
    const empty = stocks({});
    const rich = makeStock(new Rng(8));
    rich.purse = 999;
    expect(sellLot(rich, empty, 0)).toBe('short');
  });

  it('never makes Scrap out of thin air: buying back what you sold costs more than it paid', () => {
    for (const sell of TRAVELLERS.trade.sell) {
      const buy = TRAVELLERS.trade.buy.filter((b) => Object.keys(sell.take).every((k) => (b.give as Record<string, number>)[k]));
      for (const b of buy) {
        const unitBuy = (b.cost.scrap ?? 0) / Object.values(b.give)[0]!;
        const unitSell = (sell.pay.scrap ?? 0) / Object.values(sell.take)[0]!;
        expect(unitSell * (1 + TRAVELLERS.trade.priceSpread)).toBeLessThan(unitBuy * (1 - TRAVELLERS.trade.priceSpread) + 1e-9);
      }
    }
  });

  it('has a label for every lot', () => {
    for (const o of TRAVELLERS.trade.buy) expect(t(`trav.offer.${o.id}`)).not.toBe(`trav.offer.${o.id}`);
    for (const o of TRAVELLERS.trade.sell) expect(t(`trav.offer.sell.${o.id}`)).not.toBe(`trav.offer.sell.${o.id}`);
  });
});

describe('what a death costs', () => {
  it('is Mercy and Notoriety, worse for a trader', () => {
    const plain = murderAxes('pilgrim');
    const trader = murderAxes('trader');
    expect(plain.mercy).toBeLessThan(0);
    expect(plain.notoriety).toBeGreaterThan(0);
    expect(trader.mercy).toBeLessThan(plain.mercy!);
    expect(trader.notoriety).toBeGreaterThan(plain.notoriety!);
  });

  it('finds something on the body, in whole numbers', () => {
    const rng = new Rng(2);
    for (const k of TRAVELLER_KINDS) {
      const loot = lootOf(rng, k);
      for (const id of STOCK_IDS) if (loot[id]) expect(Number.isInteger(loot[id])).toBe(true);
    }
  });
});

describe('walking a road', () => {
  const pts = [0, 0, 0, 10, 0, 20, 10, 20]; // north 10, north 10, then east 10

  it('follows the bends and stops at the end', () => {
    const r = new Route(pts, 0, 0, 1);
    expect(r.advance(15)).toBe(true);
    expect(r.x).toBeCloseTo(0);
    expect(r.z).toBeCloseTo(15);
    expect(r.advance(10)).toBe(true);
    expect(r.x).toBeCloseTo(5);
    expect(r.z).toBeCloseTo(20);
    expect(r.tx).toBeCloseTo(1);
    expect(r.advance(100)).toBe(false);
    expect(r.done).toBe(true);
    expect(r.x).toBeCloseTo(10);
  });

  it('walks the other way too, and turns round at the end', () => {
    const r = new Route(pts, 1, 0, -1);
    expect(r.x).toBeCloseTo(0);
    expect(r.z).toBeCloseTo(10);
    r.advance(4);
    expect(r.z).toBeCloseTo(6);
    expect(r.tz).toBeCloseTo(-1);
    expect(r.advance(50)).toBe(false);
    r.reverse();
    expect(r.done).toBe(false);
    expect(r.advance(3)).toBe(true);
    expect(r.z).toBeCloseTo(3);
  });

  it('measures the road ahead, and starts on the nearest point heading away', () => {
    expect(new Route(pts, 0, 0, 1).room(500)).toBeCloseTo(30);
    expect(new Route(pts, 0, 0, 1).room(12)).toBeCloseTo(12);
    expect(new Route(pts, 0, 0, -1).room(500)).toBeCloseTo(0);
    const r = Route.nearest(pts, 1, 5, 0, -30);
    expect(r.z).toBeCloseTo(5);
    expect(r.tz).toBeGreaterThan(0.9);
    const back = Route.nearest(pts, 1, 5, 0, 60);
    expect(back.tz).toBeLessThan(-0.9);
  });
});

// -------------------------------------------------------------------------------------------- the world

beforeAll(async () => {
  await initPhysics();
});

const leg = legById('W');

function open() {
  const h = fakeServices();
  const results: { type: string; [k: string]: unknown }[] = [];
  const sc = new LegScene(h.svc, leg, { memory: new WorldMemory() });
  sc.onResult = (r) => results.push(r as { type: string });
  return { h, sc, results, c: h.campaign };
}

/** One world for the tests that only need people to stand on a road: building it is most of the cost. */
let shared: ReturnType<typeof open> | null = null;
function world() {
  shared ??= open();
  const w = shared;
  const { sc, h } = w;
  sc.travellers.clearAll();
  sc.travellers.busy = false;
  sc.pendingResult = false;
  w.results.length = 0;
  for (const p of sc.players) p.notes.length = 0;
  h.intents[0].lt = 0;
  h.radio.length = 0;
  const st = sc.src.layout.start;
  for (const seat of [0, 1]) put(sc, ride(sc, seat), st.x + (seat ? -3 : 3), st.z);
  for (const p of sc.players) if (!p.vehicle) p.placeAt(st.x, st.z - 6, 0);
  run(sc, 0.1);
  return w;
}

/** Put a party on the highway some way up from where the convoy started. */
function spawnAhead(sc: LegScene, kind: Parameters<LegScene['travellers']['trySpawn']>[0], ahead = 140) {
  const T = sc.terrain!;
  const z = sc.src.layout.start.z + ahead;
  const party = sc.travellers.trySpawn(kind, { x: roadX(T, z), z });
  expect(party).toBeTruthy();
  return party!;
}

/** Set a ride down on the ground at a point, facing a way, going a speed along it. */
function put(sc: LegScene, v: ReturnType<typeof ride>, x: number, z: number, yaw = 0, speed = 0) {
  v.body.setPose(x, sc.groundAt(x, z) + 1.0, z, yaw);
  v.body.body.setLinvel({ x: Math.sin(yaw) * speed, y: 0, z: Math.cos(yaw) * speed }, true);
  v.body.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
}

/** A seat's own ride, whether or not they are sitting in it. */
function ride(sc: LegScene, seat = 0) {
  const v = sc.vehicles.find((q) => q.faction === 'convoy' && q.kind === 'player' && q.ownerIndex === seat);
  expect(v).toBeTruthy();
  return v!;
}

/** Hold the aim button on the first seat, as a pad would. */
function aimPad(h: { intents: { device: string; lt: number }[] }) {
  h.intents[0].device = 'pad';
  h.intents[0].lt = 1;
}

/** Move everyone to a point, so no one is near whatever was there. */
function moveAll(sc: LegScene, x: number, z: number) {
  for (const seat of [0, 1]) put(sc, ride(sc, seat), x + seat * 4, z);
  for (const p of sc.players) if (!p.vehicle) p.placeAt(x, z, 0);
}

/** Make someone rude, wary or neutral, whatever they were rolled. */
function setAttitude(tv: { attitude: unknown }, a: 'neutral' | 'rude' | 'wary') {
  (tv as { attitude: string }).attitude = a;
}

/** Get the first player out of their ride and standing at a point. */
function onFoot(sc: LegScene, x: number, z: number) {
  const p = sc.players[0];
  if (p.vehicle) {
    p.vehicle.driver = null;
    p.vehicle = null;
  }
  p.state = 'foot';
  p.placeAt(x, z, 0);
  return p;
}

describe('travellers in the open world', () => {
  it('walk a road: a party turns up on it, moves along it and stays on the shoulder', () => {
    const { sc } = world();
    const T = sc.terrain!;
    const party = spawnAhead(sc, 'pilgrim');
    const lead = party[0];
    const x0 = lead.x;
    const z0 = lead.z;
    expect(sc.travellers.alive).toBe(party.length);
    run(sc, 12);
    const moved = Math.hypot(lead.x - x0, lead.z - z0);
    expect(moved).toBeGreaterThan(8);
    expect(moved).toBeLessThan(30);
    for (const tv of party) {
      const off = Math.abs(tv.x - roadX(T, tv.z));
      expect(off).toBeGreaterThan(tv.half - 0.5);
      expect(off).toBeLessThan(tv.half + 6);
    }
    expect(party[0].human.root.parent).toBe(sc.root);
  });

  it('are quiet on a fresh road: no one before the first spawn is due, and never more than the cap', () => {
    const { sc } = open();
    run(sc, R.firstAfter - 8);
    expect(sc.travellers.alive).toBe(0);
    // Many days of road: the cap holds.
    for (let i = 0; i < 40; i++) {
      sc.travellers.ambient(R.spawnEvery * 3);
      sc.travellers.update(0.1);
      const parties = new Set(sc.travellers.list.filter((q) => !q.dead).map((q) => q.group));
      expect(parties.size).toBeLessThanOrEqual(R.maxAlive);
    }
  });

  it('offer to talk to someone on foot, and the prompt says who', () => {
    const { sc } = world();
    const [tv] = spawnAhead(sc, 'drifter');
    const p = onFoot(sc, tv.x + 1.5, tv.z - 1.0);
    run(sc, 0.6);
    const reg = sc.interact.list.find((i) => i.id === `trav:${tv.id}`)!;
    expect(reg).toBeTruthy();
    expect(reg.prompt.toLowerCase()).toContain('drifter');
    expect(reg.enabled(p)).toBe(true);
    // Not while you are pointing a gun at them.
    p.equip = 'gun';
    p.ads = 1;
    expect(reg.enabled(p)).toBe(false);
  });

  it('a trader trades: talking opens the cart, and the cart is neutral', () => {
    const { sc, results } = world();
    const party = spawnAhead(sc, 'trader');
    const tv = party[0];
    expect(tv.attitude).toBe('neutral');
    expect(tv.stock).toBeTruthy();
    expect(tv.cart).toBeTruthy();
    expect(tv.request).toBeNull();
    const p = onFoot(sc, tv.x + 1, tv.z - 1);
    run(sc, 0.5);
    const reg = sc.interact.list.find((i) => i.id === `trav:${tv.id}`)!;
    expect(reg.prompt.toLowerCase()).toContain('trade');
    reg.run(p);
    expect(results.at(-1)).toMatchObject({ type: 'traveller', mode: 'trade', id: tv.id });
    expect(sc.travellers.busy).toBe(true);
    // Nothing else can open while this is up.
    expect(reg.enabled(p)).toBe(false);
    sc.travellers.endTalk(tv);
    sc.resumeAfterTalk();
    expect(sc.travellers.busy).toBe(false);
  });

  it('someone who asks for help gets answered: helping costs stock and earns Mercy, refusing does not', () => {
    for (const helped of [true, false]) {
      const { sc, c, results } = world();
      const [tv] = spawnAhead(sc, 'pilgrim');
      tv.request = 'food';
      c.stocks.rations = 10;
      c.stocks.scrap = 0;
      const mercy = c.axes.mercy;
      const p = onFoot(sc, tv.x + 1, tv.z - 1);
      run(sc, 0.3);
      sc.interact.list.find((i) => i.id === `trav:${tv.id}`)!.run(p);
      expect(results.at(-1)).toMatchObject({ type: 'traveller', mode: 'request' });
      const lead = c.lead;
      resolveTravellerRequest(sc, tv, helped, false);
      sc.resumeAfterTalk();
      expect(c.lead).toBe(lead);
      expect(tv.helped).toBe(true);
      expect(tv.request).toBeNull();
      if (helped) {
        expect(c.stocks.rations).toBeLessThan(10);
        expect(c.stocks.scrap).toBeGreaterThan(0);
        expect(c.axes.mercy).toBe(mercy + 1);
      } else {
        expect(c.stocks.rations).toBe(10);
        expect(c.axes.mercy).toBe(mercy);
      }
      // Once answered, the next word is only small talk.
      run(sc, 4);
      expect(sc.interact.list.find((i) => i.id === `trav:${tv.id}`)!.prompt.toLowerCase()).toContain('talk');
    }
  });

  it("can't give what you haven't got: it counts as turning them away", () => {
    const { sc, c } = world();
    const [tv] = spawnAhead(sc, 'pilgrim');
    tv.request = 'medicine';
    c.stocks.medicine = 0;
    const mercy = c.axes.mercy;
    resolveTravellerRequest(sc, tv, true, false);
    expect(c.stocks.medicine).toBe(0);
    // Turned away from a fever, without having had the medicine to give.
    expect(c.axes.mercy).toBe(mercy - 1);
  });

  it('a lost traveller who was pointed the right way tells you where a camp is', () => {
    const { sc, c } = world();
    const [tv] = spawnAhead(sc, 'drifter');
    tv.request = 'directions';
    const before = sc.gangCamps.pins().length;
    const trust = c.axes.trust;
    resolveTravellerRequest(sc, tv, true, false);
    expect(c.axes.trust).toBe(trust + 1);
    expect(sc.players[0].notes.some((n) => n.text.startsWith('Drifter:'))).toBe(true);
    expect(sc.gangCamps.pins().length).toBeGreaterThanOrEqual(before);
  });

  it('the rude shout at traffic going by', () => {
    // Needs the convoy's own driver, so a world of its own.
    const { sc } = open();
    run(sc, 1);
    const [tv] = spawnAhead(sc, 'drifter', 80);
    setAttitude(tv, 'rude');
    // Let the dice come up: how often they do is a rule of its own (`barkChance`).
    (sc.travellers as unknown as { rng: { chance(p: number): boolean } }).rng.chance = () => true;
    put(sc, ride(sc, 0), tv.x + 9, tv.z - 40, 0, 16);
    sc.players[0].notes.length = 0;
    run(sc, 3);
    const said = sc.players[0].notes.map((n) => n.text).filter((x) => x.startsWith('Drifter:'));
    expect(said).toHaveLength(1);
    const rude = Array.from({ length: TRAVELLERS.barks['rude.pass'] }, (_, k) => t('trav.say', { who: 'Drifter', line: t(`trav.bark.rude.pass.${k + 1}`) }));
    expect(rude).toContain(said[0]);
  });

  it('step off the road for a vehicle coming at them, then go back to it', () => {
    // Needs the convoy's own driver, so a world of its own.
    const { sc } = open();
    run(sc, 1);
    const T = sc.terrain!;
    const [tv] = spawnAhead(sc, 'drifter', 160);
    setAttitude(tv, 'neutral');
    run(sc, 0.5);
    const base = Math.abs(tv.x - roadX(T, tv.z));
    // A car comes along the shoulder at speed, straight at them.
    const car = ride(sc, 0);
    const dir = tv.z > car.position.z ? 1 : -1;
    put(sc, car, tv.x, tv.z - dir * 40, dir > 0 ? 0 : Math.PI, 16);
    let off = 0;
    for (let i = 0; i < 100; i++) {
      sc.tick(1 / 60);
      off = Math.max(off, Math.abs(tv.x - roadX(T, tv.z)));
    }
    expect(off).toBeGreaterThan(base + 3);
    // Once it is gone they walk back onto the shoulder.
    moveAll(sc, tv.x + 120, tv.z - 100);
    run(sc, 8);
    expect(tv.dead).toBe(false);
    expect(tv.state).toBe('walk');
    expect(Math.abs(tv.x - roadX(T, tv.z))).toBeLessThan(base + 2.5);
  });

  it('a vehicle ploughing into someone hurts them, and a bullet along a ray finds them', () => {
    // Needs the convoy's own driver, so a world of its own.
    const { sc } = open();
    run(sc, 1);
    const [tv] = spawnAhead(sc, 'scavenger', 60);
    const oy = tv.y + 1.2;
    const hit = sc.travellers.rayTest(tv.x - 5, oy, tv.z, 1, 0, 0, 30);
    expect(hit?.unit).toBe(tv);
    expect(sc.travellers.rayTest(tv.x - 5, oy + 3, tv.z, 1, 0, 0, 30)).toBeNull();
    expect(sc.travellers.rayTest(tv.x - 5, oy, tv.z + 4, 1, 0, 0, 30)).toBeNull();
    const hp = tv.hp;
    const car = ride(sc, 0);
    // Stunned, so there is no dodging it.
    tv.stun = 5;
    put(sc, car, tv.x, tv.z - 6, 0, 14);
    for (let i = 0; i < 60 && tv.hp === hp; i++) {
      tv.stun = 5;
      sc.tick(1 / 60);
    }
    expect(tv.hp).toBeLessThan(hp);
  });

  it('a gun pointed at an unarmed person makes them run, and a hit makes the whole party run', () => {
    const { sc, h } = world();
    const party = spawnAhead(sc, 'pilgrim');
    const first = party[0];
    const p = onFoot(sc, first.x + 12, first.z);
    p.equip = 'gun';
    aimPad(h);
    // Point it at them for a while.
    let barked = false;
    for (let i = 0; i < 900 && first.state !== 'flee'; i++) {
      p.aimYaw = Math.atan2(first.x - p.pos.x, first.z - p.pos.z);
      sc.tick(1 / 60);
      if (p.notes.some((n) => n.text.startsWith('Pilgrim:'))) barked = true;
    }
    expect(barked).toBe(true);
    expect(first.state).toBe('flee');
    expect(first.dead).toBe(false);
    // Anyone hit takes the others with them.
    const rest = party.slice(1);
    sc.travellers.damage(first, 1, 0, { x: p.pos.x, z: p.pos.z });
    for (const q of rest) expect(q.state).toBe('flee');
  });

  it('a gun held low does not bother anyone', () => {
    const { sc } = world();
    const [tv] = spawnAhead(sc, 'pilgrim');
    const p = onFoot(sc, tv.x + 6, tv.z);
    p.equip = 'gun';
    run(sc, 10);
    expect(tv.state).not.toBe('flee');
    expect(tv.suspicion).toBeLessThan(0.3);
  });

  it('gunfire nearby sends an unarmed person running', () => {
    const { sc } = world();
    const [tv] = spawnAhead(sc, 'drifter');
    setAttitude(tv, 'neutral');
    const p = onFoot(sc, tv.x + 20, tv.z);
    run(sc, 0.4);
    for (let i = 0; i < 400 && tv.state !== 'flee'; i++) {
      if (i % 10 === 0) sc.combat.shoot(p.pos.x, p.pos.y + 1.4, p.pos.z, 0, 0, 1, { side: 'convoy', owner: p, damage: 1, range: 20, noise: 60 });
      sc.tick(1 / 60);
    }
    expect(tv.state).toBe('flee');
  });

  it('a wary person keeps their distance from someone who walks up, then settles', () => {
    const { sc } = world();
    const [tv] = spawnAhead(sc, 'scavenger');
    setAttitude(tv, 'wary');
    const p = onFoot(sc, tv.x + 1.5, tv.z + 2.0);
    let backed = false;
    for (let i = 0; i < 180; i++) {
      sc.tick(1 / 60);
      if (tv.state === 'back') backed = true;
    }
    expect(backed).toBe(true);
    expect(Math.hypot(tv.x - p.pos.x, tv.z - p.pos.z)).toBeGreaterThan(2.2);
    // Stood quietly for a good while, they stop backing away.
    run(sc, 16);
    expect(tv.suspicion).toBeLessThan(0.3);
    expect(tv.state).not.toBe('back');
  });

  it('an armed person warns, then fights back if a gun stays on them', () => {
    const { sc, h } = world();
    const [tv] = spawnAhead(sc, 'hunter');
    const p = onFoot(sc, tv.x + 14, tv.z);
    p.equip = 'gun';
    aimPad(h);
    let warned = false;
    for (let i = 0; i < 1200 && tv.state !== 'fight'; i++) {
      p.aimYaw = Math.atan2(tv.x - p.pos.x, tv.z - p.pos.z);
      sc.tick(1 / 60);
      if (p.notes.some((n) => n.text.startsWith('Hunter:'))) warned = true;
    }
    expect(warned).toBe(true);
    expect(tv.state).toBe('fight');
    run(sc, 6);
    expect(tv.hostile).toBe(true);
  });

  it('killing someone who was only walking costs Mercy and Notoriety, and a trader costs more', () => {
    for (const kind of ['pilgrim', 'trader'] as const) {
      const { sc, c, h } = world();
      const [tv] = spawnAhead(sc, kind);
      const m0 = c.axes.mercy;
      const n0 = c.axes.notoriety;
      const stock0 = { ...c.stocks };
      sc.travellers.damage(tv, 1000, 0, { x: sc.players[0].pos.x, z: sc.players[0].pos.z });
      expect(tv.dead).toBe(true);
      const ax = TRAVELLERS.rules[kind === 'trader' ? 'murderTrader' : 'murder'];
      expect(c.axes.mercy).toBe(m0 + (ax.mercy ?? 0));
      expect(c.axes.notoriety).toBe(n0 + (ax.notoriety ?? 0));
      // They had a little on them.
      expect(STOCK_IDS.some((id) => c.stocks[id] > stock0[id])).toBe(true);
      expect(h.radio.length).toBeGreaterThan(0);
      // The dead cannot be talked to.
      expect(sc.interact.list.some((i) => i.id === `trav:${tv.id}`)).toBe(false);
    }
  });

  it('shooting back at someone who shot first is no crime', () => {
    const { sc, c } = world();
    const [tv] = spawnAhead(sc, 'hunter');
    const m0 = c.axes.mercy;
    const n0 = c.axes.notoriety;
    tv.hostile = true;
    sc.travellers.damage(tv, 1000, 0, { x: sc.players[0].pos.x, z: sc.players[0].pos.z });
    expect(tv.dead).toBe(true);
    expect(c.axes.mercy).toBe(m0);
    expect(c.axes.notoriety).toBe(n0);
  });

  it('those who saw a killing run from it', () => {
    const { sc } = world();
    const a = spawnAhead(sc, 'pilgrim', 140)[0];
    const b = spawnAhead(sc, 'drifter', 150)[0];
    b.suspicion = 0;
    sc.travellers.damage(a, 1000, 0, { x: a.x - 30, z: a.z });
    expect(b.state).toBe('flee');
  });

  it('are on the map and the compass when they are near and asking', () => {
    const { sc } = world();
    const [tv] = spawnAhead(sc, 'pilgrim', 90);
    tv.request = 'food';
    run(sc, 0.2);
    expect(sc.compassPins().some((p) => p.kind === 'encounter' && p.label === '?')).toBe(true);
    const frame = sc.mapFrame(sc.compassPins());
    expect(frame?.blips.some((b) => b.kind === 'folk')).toBe(true);
    tv.helped = true;
    tv.request = null;
    expect(sc.compassPins().some((p) => p.kind === 'encounter' && p.label === '?')).toBe(false);
  });

  it('a rumour from a stranger puts a camp on the map, once', () => {
    const { sc } = world();
    const [tv] = spawnAhead(sc, 'pilgrim');
    const before = sc.gangCamps.pins().length;
    const camp = sc.gangCamps.rumour(tv.x, tv.z, 1e6);
    expect(camp).toBeTruthy();
    expect(sc.gangCamps.pins().length).toBe(before + 1);
    expect(sc.gangCamps.rumour(tv.x, tv.z, 1e6)?.x).not.toBe(camp!.x);
  });

  it('go when they are far behind, and the scene lets go of them', () => {
    const { sc } = open();
    run(sc, 1);
    const party = spawnAhead(sc, 'pilgrim');
    moveAll(sc, party[0].x + R.despawnRadius + 60, party[0].z);
    run(sc, 1);
    expect(sc.travellers.list.length).toBe(0);
    expect(sc.interact.list.some((i) => i.id.startsWith('trav:'))).toBe(false);
    moveAll(sc, party[0].x, party[0].z - 200);
    run(sc, 1);
    const n = sc.root.children.length;
    spawnAhead(sc, 'trader');
    expect(sc.root.children.length).toBeGreaterThan(n);
    sc.dispose();
    expect(sc.travellers.list.length).toBe(0);
  });
});

describe('the quiet places', () => {
  it('keep travellers out of training, and out of a city', () => {
    const h = fakeServices();
    const sc = new LegScene(h.svc, leg, { memory: new WorldMemory(), training: true });
    run(sc, R.firstAfter + R.spawnEvery * 2);
    expect(sc.travellers.list.length).toBe(0);
    sc.dispose();
    const { sc: s2 } = world();
    const T = s2.terrain!;
    const d = T.open!.districts[0];
    const z = (d.z0 + d.z1) / 2;
    expect(s2.travellers.trySpawn('pilgrim', { x: roadX(T, z), z })).toBeNull();
  });
});
