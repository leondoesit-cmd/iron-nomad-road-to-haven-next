import {
  ATTITUDES,
  STOCK_IDS,
  TRAVELLERS,
  TRAVELLER_KINDS,
  type Attitude,
  type RequestKind,
  type Span,
  type StockId,
  type Stocks,
  type TravellerDef,
  type TravellerKind,
} from '../data';
import type { Rng } from '../core/rng';
import { clamp, lerp } from '../core/math';
import { canAfford, gain, spend } from './resources';
import type { ResolvedEffects } from './endings';

/**
 * Wayfarers: people walking the roads of the open world. Pure rules, nothing from the engine: who turns up and when,
 * how they carry themselves, what they ask for, what a trader has on the cart, and how a road is walked. The runtime is
 * `game/travellers.ts`; the numbers are `data/travellers.json`.
 *
 * They are neutral. A trader is only ever neutral; the rest mostly are too, but some are rude and some are wary, a few
 * need something, and most are just getting on with their walk.
 */

const R = TRAVELLERS.rules;

export const def = (k: TravellerKind): TravellerDef => TRAVELLERS.archetypes[k];

// ------------------------------------------------------------------------------------------------ who turns up

/** Weighted pick from a table, or null when nothing has weight. */
function weighted<T>(rng: Rng, opts: [T, number][]): T | null {
  let total = 0;
  for (const [, w] of opts) total += Math.max(0, w);
  if (total <= 0) return null;
  let r = rng.next() * total;
  for (const [v, w] of opts) {
    r -= Math.max(0, w);
    if (r <= 0) return v;
  }
  return opts[opts.length - 1][0];
}

/** How many of each kind are on the road, for the caps. */
export type Census = Partial<Record<TravellerKind, number>>;

/** Count a list of kinds into a census. */
export function censusOf(kinds: TravellerKind[]): Census {
  const out: Census = {};
  for (const k of kinds) out[k] = (out[k] ?? 0) + 1;
  return out;
}

/** Which kind turns up next. Night thins them out, and a kind that is already at its cap sits out. */
export function pickKind(rng: Rng, o: { night: number; census: Census }): TravellerKind | null {
  const opts: [TravellerKind, number][] = [];
  for (const k of TRAVELLER_KINDS) {
    const d = def(k);
    if ((o.census[k] ?? 0) >= d.cap) continue;
    opts.push([k, d.weight * lerp(1, d.night, clamp(o.night, 0, 1))]);
  }
  return weighted(rng, opts);
}

/** Seconds until the next traveller is due. The road is quieter in the dark and in a dust storm. */
export function spawnGap(rng: Rng, o: { night: number; storm: number }): number {
  const rate = lerp(1, R.nightFactor, clamp(o.night, 0, 1)) * lerp(1, R.stormFactor, clamp(o.storm, 0, 1));
  return (R.spawnEvery * rng.range(0.7, 1.4)) / Math.max(0.05, rate);
}

export function rollAttitude(rng: Rng, kind: TravellerKind): Attitude {
  const a = def(kind).attitudes;
  return weighted(rng, ATTITUDES.map((x) => [x, a[x]] as [Attitude, number])) ?? 'neutral';
}

/** Whether this one is asking for something, and what. A wary person asks less often; a rude one just demands. */
export function rollRequest(rng: Rng, kind: TravellerKind, attitude: Attitude): RequestKind | null {
  const d = def(kind);
  if (!d.asks.length) return null;
  const chance = d.request * (attitude === 'wary' ? 0.5 : 1);
  return rng.chance(chance) ? rng.pick(d.asks) : null;
}

export interface TravellerRoll {
  kind: TravellerKind;
  attitude: Attitude;
  request: RequestKind | null;
  /** How many walk together. */
  size: number;
  /** Walking pace, a little different for each party. */
  walk: number;
  /** Seeds the look and the cart's load. */
  seed: number;
}

export function rollTraveller(rng: Rng, kind: TravellerKind): TravellerRoll {
  const d = def(kind);
  const attitude = rollAttitude(rng, kind);
  return {
    kind,
    attitude,
    request: rollRequest(rng, kind, attitude),
    size: rng.int(d.group[0], d.group[1]),
    walk: d.walk * rng.range(0.92, 1.08),
    seed: rng.int(1, 999999),
  };
}

// ------------------------------------------------------------------------------------------------ how they react

export type BarkPool = string;

/** What a traveller is reacting to. */
export type Situation = 'greet' | 'pass' | 'aimed' | 'chat';

export function poolOf(attitude: Attitude, situation: Situation): BarkPool {
  return `${attitude}.${situation}`;
}

/** The string key of a random line from a pool. */
export function barkKey(rng: Rng, pool: BarkPool): string {
  const n = TRAVELLERS.barks[pool] ?? 0;
  return `trav.bark.${pool}.${n > 0 ? rng.int(1, n) : 1}`;
}

/** Chance to say something when a situation comes up. A rude person shouts at traffic; a neutral one mostly does not. */
export function barkChance(attitude: Attitude, situation: Situation): number {
  const table: Record<Attitude, Record<Situation, number>> = {
    neutral: { greet: 0.35, pass: 0.15, aimed: 1, chat: 1 },
    rude: { greet: 0.6, pass: 0.7, aimed: 1, chat: 1 },
    wary: { greet: 0.6, pass: 0.4, aimed: 1, chat: 1 },
  };
  return table[attitude][situation];
}

/** Everything a traveller can notice about the people near it in one glance. */
export interface Glance {
  /** Metres to the nearest player (a vehicle counts where it is). */
  dist: number;
  /** A player on foot, rather than a vehicle. */
  onFoot: boolean;
  /** A gun is up and pointed this way. */
  aimed: boolean;
  /** Running at them. */
  rushing: boolean;
  /** A shot has just gone off nearby. */
  gunfire: boolean;
}

/**
 * How suspicion changes in a second. It rises when a gun is pointed their way, when someone runs at them, and at gunfire,
 * and it drains when nothing threatening is going on. Wary people take offence fastest and forgive slowest.
 */
export function suspicionRate(attitude: Attitude, g: Glance): number {
  const k = attitude === 'wary' ? 1.7 : attitude === 'rude' ? 0.8 : 1;
  let up = 0;
  if (g.aimed && g.dist < 40) up += 0.45;
  if (g.rushing && g.dist < 10) up += 0.3;
  if (g.gunfire) up += 0.5;
  if (up > 0) return up * k;
  const calm = attitude === 'wary' ? 0.07 : 0.14;
  // Someone standing quietly close by is easier to trust than someone watching from afar.
  return -calm * (g.onFoot && g.dist < 12 ? 1.6 : 1);
}

/** Past this, they will not stand and talk. */
export const TALK_LIMIT = 0.6;

/** At this a person who cannot fight runs for it. An armed one stands and warns, then fights when hurt. */
export function fleeAt(attitude: Attitude, armed: boolean): number {
  if (armed) return Infinity;
  return attitude === 'wary' ? 0.8 : attitude === 'rude' ? 1.1 : 0.95;
}

/** A wary person keeps their distance until they have made up their mind about you. */
export function wantsRoom(attitude: Attitude, suspicion: number): boolean {
  return attitude === 'wary' && suspicion > 0.25;
}

/** True if a vehicle at `vd` metres with `speed` m/s is on course for a walker `lateral` metres off its line. */
export function vehicleThreat(vd: number, speed: number, lateral: number, closing: boolean): boolean {
  if (!closing || speed < R.yieldSpeed) return false;
  return vd < R.yieldAhead + speed * 0.6 && Math.abs(lateral) < 5.5;
}

// ------------------------------------------------------------------------------------------------ help

/** What a stock block looks like as text, e.g. "2 Rations", for a button. */
export function stockText(s: Partial<Record<StockId, number>>, label: Record<StockId, string>): string {
  const parts: string[] = [];
  for (const id of STOCK_IDS) if (s[id]) parts.push(`${s[id]} ${label[id]}`);
  return parts.join(' · ');
}

const roll = (rng: Rng, s: Span) => rng.int(s[0], s[1]);

/** What a request costs to answer. */
export function requestCost(kind: RequestKind): Partial<Stocks> {
  return { ...(TRAVELLERS.requests[kind].cost as Partial<Stocks>) };
}

export function canHelp(stocks: Stocks, kind: RequestKind): boolean {
  return canAfford(stocks, requestCost(kind));
}

/**
 * The outcome of a request: helping pays the cost and earns thanks, Mercy and sometimes a little Trust; turning them away
 * moves nothing, or costs some Mercy where it is a matter of life. Uses the same effect shape as a Roadside Encounter.
 */
export function resolveRequest(rng: Rng, kind: RequestKind, helped: boolean): ResolvedEffects {
  const q = TRAVELLERS.requests[kind];
  const out: ResolvedEffects = { stocks: {}, axes: {}, loyalty: 0, ambush: 0, zombies: 0, fragment: false, loot: [] };
  if (!helped) {
    out.axes = { ...q.refuse };
    return out;
  }
  const cost = requestCost(kind);
  for (const id of STOCK_IDS) if (cost[id]) out.stocks[id] = -(cost[id] as number);
  for (const id of STOCK_IDS) {
    const span = q.thanks[id];
    if (span) out.stocks[id] = (out.stocks[id] ?? 0) + roll(rng, span);
  }
  out.axes = { ...q.axes };
  out.loyalty = q.loyalty;
  return out;
}

// ------------------------------------------------------------------------------------------------ the cart

export interface BuyOffer {
  id: string;
  give: Partial<Stocks>;
  cost: Partial<Stocks>;
  /** How many he has of it. */
  left: number;
}
export interface SellOffer {
  id: string;
  take: Partial<Stocks>;
  pay: Partial<Stocks>;
}
export interface TraderStock {
  buy: BuyOffer[];
  sell: SellOffer[];
  /** Scrap he has to pay with. */
  purse: number;
}

const priced = (s: Partial<Stocks>, k: number): Partial<Stocks> => {
  const out: Partial<Stocks> = {};
  for (const id of STOCK_IDS) if (s[id]) out[id] = Math.max(1, Math.round((s[id] as number) * k));
  return out;
};

/** What a trader has on the cart today, with prices that wobble from one to the next. */
export function makeStock(rng: Rng): TraderStock {
  const T = TRAVELLERS.trade;
  const spread = T.priceSpread;
  const buy = rng
    .shuffle(T.buy.slice())
    .slice(0, T.buyCount)
    .map((o) => ({
      id: o.id,
      give: { ...o.give } as Partial<Stocks>,
      cost: priced(o.cost as Partial<Stocks>, 1 + rng.range(-spread, spread)),
      left: roll(rng, o.qty),
    }));
  const sell = rng
    .shuffle(T.sell.slice())
    .slice(0, T.sellCount)
    .map((o) => ({ id: o.id, take: { ...o.take } as Partial<Stocks>, pay: priced(o.pay as Partial<Stocks>, 1 + rng.range(-spread, spread)) }));
  return { buy, sell, purse: roll(rng, T.purse) };
}

export type TradeResult = 'ok' | 'poor' | 'sold' | 'short' | 'broke';

/** Buy one lot off the cart, paying in Scrap (or whatever the offer asks). */
export function buyLot(stock: TraderStock, stocks: Stocks, idx: number): TradeResult {
  const o = stock.buy[idx];
  if (!o) return 'sold';
  if (o.left <= 0) return 'sold';
  if (!spend(stocks, o.cost)) return 'poor';
  gain(stocks, o.give);
  o.left--;
  stock.purse += o.cost.scrap ?? 0;
  return 'ok';
}

/** Sell one lot to him, if he has the coin and you have the goods. */
export function sellLot(stock: TraderStock, stocks: Stocks, idx: number): TradeResult {
  const o = stock.sell[idx];
  if (!o) return 'short';
  const pay = o.pay.scrap ?? 0;
  if (stock.purse < pay) return 'broke';
  if (!spend(stocks, o.take)) return 'short';
  gain(stocks, o.pay);
  stock.purse -= pay;
  return 'ok';
}

// ------------------------------------------------------------------------------------------------ what a body is worth

/** What is found on someone who was killed. */
export function lootOf(rng: Rng, kind: TravellerKind): Partial<Stocks> {
  const out: Partial<Stocks> = {};
  const l = def(kind).loot;
  for (const id of STOCK_IDS) {
    const span = l[id];
    if (span) {
      const n = roll(rng, span);
      if (n > 0) out[id] = n;
    }
  }
  return out;
}

/** Mercy and Notoriety for shooting someone who was only walking. */
export function murderAxes(kind: TravellerKind) {
  return { ...(def(kind).cart ? R.murderTrader : R.murder) };
}

// ------------------------------------------------------------------------------------------------ direction

const SECTORS = ['n', 'nw', 'w', 'sw', 's', 'se', 'e', 'ne'];

/** A compass word for the way from one point to another. North is +z and west is +x, as on the HUD compass. */
export function sectorKey(dx: number, dz: number): string {
  const a = Math.atan2(dx, dz);
  const i = Math.round(a / (Math.PI / 4));
  return SECTORS[((i % 8) + 8) % 8];
}

// ------------------------------------------------------------------------------------------------ walking a road

/**
 * A walker's place on a road: a segment of its centre-line and how far along it, going one way or the other. The road is
 * a flat `[x, z, x, z, ...]` list, as in `RoadPath`.
 */
export class Route {
  seg = 0;
  u = 0;
  dir: 1 | -1;
  /** Set when the walker has come to the end of the road. */
  done = false;
  /** The tangent at the current place (unit, pointing the way they are going) and the point itself. */
  x = 0;
  z = 0;
  tx = 0;
  tz = 1;

  constructor(
    public pts: number[],
    seg: number,
    u: number,
    dir: 1 | -1,
  ) {
    this.seg = clamp(seg, 0, this.segs - 1);
    this.u = clamp(u, 0, 1);
    this.dir = dir;
    this.refresh();
  }

  get segs() {
    return Math.max(1, this.pts.length / 2 - 1);
  }

  private len(seg: number) {
    const i = seg * 2;
    return Math.hypot(this.pts[i + 2] - this.pts[i], this.pts[i + 3] - this.pts[i + 1]);
  }

  refresh() {
    const i = this.seg * 2;
    const ax = this.pts[i];
    const az = this.pts[i + 1];
    const bx = this.pts[i + 2];
    const bz = this.pts[i + 3];
    this.x = ax + (bx - ax) * this.u;
    this.z = az + (bz - az) * this.u;
    const l = Math.hypot(bx - ax, bz - az) || 1;
    this.tx = ((bx - ax) / l) * this.dir;
    this.tz = ((bz - az) / l) * this.dir;
  }

  /** Walk `d` metres along the road. Returns false once the end has been reached. */
  advance(d: number): boolean {
    let left = d;
    for (let guard = 0; guard < 64 && left > 1e-6 && !this.done; guard++) {
      const L = this.len(this.seg);
      const room = L * (this.dir === 1 ? 1 - this.u : this.u);
      if (left <= room || L < 1e-6) {
        this.u += (L < 1e-6 ? 0 : (left / L)) * this.dir;
        left = 0;
        break;
      }
      left -= room;
      const next = this.seg + this.dir;
      if (next < 0 || next >= this.segs) {
        this.u = this.dir === 1 ? 1 : 0;
        this.done = true;
        break;
      }
      this.seg = next;
      this.u = this.dir === 1 ? 0 : 1;
    }
    this.u = clamp(this.u, 0, 1);
    this.refresh();
    return !this.done;
  }

  /** How much road lies ahead of them, in metres, counted up to `limit`. */
  room(limit: number): number {
    let total = this.len(this.seg) * (this.dir === 1 ? 1 - this.u : this.u);
    let seg = this.seg + this.dir;
    while (total < limit && seg >= 0 && seg < this.segs) {
      total += this.len(seg);
      seg += this.dir;
    }
    return Math.min(total, limit);
  }

  /** Turn round and walk back the way they came. */
  reverse() {
    this.dir = this.dir === 1 ? -1 : 1;
    this.done = false;
    this.refresh();
  }

  /** Put the walker on the nearest point of the road to (x, z), heading whichever way takes it away from there. */
  static nearest(pts: number[], x: number, z: number, awayX: number, awayZ: number): Route {
    let best = Infinity;
    let bs = 0;
    let bu = 0;
    for (let s = 0; s + 3 < pts.length; s += 2) {
      const dx = pts[s + 2] - pts[s];
      const dz = pts[s + 3] - pts[s + 1];
      const l2 = dx * dx + dz * dz;
      const u = l2 > 0 ? clamp(((x - pts[s]) * dx + (z - pts[s + 1]) * dz) / l2, 0, 1) : 0;
      const d = Math.hypot(x - (pts[s] + dx * u), z - (pts[s + 1] + dz * u));
      if (d < best) {
        best = d;
        bs = s / 2;
        bu = u;
      }
    }
    const r = new Route(pts, bs, bu, 1);
    // Whichever way is more nearly away from the point they are leaving.
    const away = r.tx * (r.x - awayX) + r.tz * (r.z - awayZ);
    if (away < 0) {
      r.dir = -1;
      r.refresh();
    }
    return r;
  }
}

/** The right-hand side of a heading, on the ground: where a walker keeps to on the shoulder. */
export function rightOf(tx: number, tz: number): [number, number] {
  return [-tz, tx];
}
