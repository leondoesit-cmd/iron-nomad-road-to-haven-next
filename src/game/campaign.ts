import { LEGS, MERCS, PARTS, VEHICLES, hasChassis, hasPart, partDef, type MercRole, type PartSlot, type Stocks } from '../data';
import { newAxes, type Axes } from '../sim/endings';
import { newStocks } from '../sim/resources';
import { newMerc, type Merc } from '../sim/loyalty';
import { GARAGE_MAX, PLAYER_PAINT, buildName, buildValue, dismantleYield, freshComp, inventoryCap, installPart, newBuild, type VehicleBuild } from '../sim/garage';
import { newPart, scrapValue, seedUids, type PartItem } from '../sim/parts';
import { addToBag, allItems, sanitizeLoadout, scrapOf, starterLoadout, type GearItem, type Loadout } from '../sim/gear';
import { DrugState, type DrugId, type DrugSave } from '../sim/drugs';

export interface PlayerSave {
  name: string;
  /** Uid of the build this player rolls out in. */
  vehicle: string;
  /** Convoy-owned kit counts are on the campaign; these are per-player toggles. */
  utility: 'flare' | 'charge' | 'molotov' | 'horn';
  alive: boolean;
  /** What this person wears, holds and carries. */
  gear: Loadout;
}

/** Convoy stores of single-use kit. Every drug is counted here by its id. */
export interface Items extends Record<DrugId, number> {
  medkit: number;
  molotov: number;
  flare: number;
  charge: number;
  /** Engine oil in the trucks, in sumps: one can is half a sump. */
  oil: number;
}

/** The most spare oil the convoy can stow. */
export const OIL_RESERVE_MAX = 4;

export interface Stats {
  zombiesKilled: number;
  raidersKilled: number;
  distance: number;
  downs: [number, number];
  revives: [number, number];
  vehiclesLost: number;
  nights: number;
  timeApart: number;
}

/** Everything that persists between scenes and into saves. */
export class Campaign {
  seed = 1;
  legId: string = LEGS.route.start;
  history: string[] = [];
  /** Which hub we are currently resting at (Ledger context). */
  hub: string | null = null;
  stocks: Stocks = newStocks(LEGS.start.stocks);
  ammo = LEGS.start.ammo;
  items: Items = { medkit: 1, molotov: 1, flare: 2, charge: 0, painkiller: 1, stim: 1, adrenaline: 0, alcohol: 1, weed: 0, haze: 0, mushrooms: 0, lsd: 0, ayahuasca: 0, oil: 1 };
  /** What each player has in their blood. Saved, so a trip survives a camp and a reload. */
  drugs: [DrugState, DrugState] = [new DrugState(), new DrugState()];
  chassis = 0;
  fragments = new Set<number>();
  crew: Merc[] = [];
  axes: Axes = newAxes();
  seenEncounters = new Set<string>();
  /** Alternates each Roadside Encounter. */
  lead: 0 | 1 = 0;
  day = 1;
  players: [PlayerSave, PlayerSave];
  /** One human seat: no second player, no split screen. players[1] is an unused placeholder. */
  solo = false;
  /** Every vehicle the convoy owns, whether it is rolling out or parked in the yard. */
  garage: VehicleBuild[] = [];
  /** Spare parts in the convoy's trucks. */
  inventory: PartItem[] = [];
  stats: Stats = { zombiesKilled: 0, raidersKilled: 0, distance: 0, downs: [0, 0], revives: [0, 0], vehiclesLost: 0, nights: 0, timeApart: 0 };
  flags: Record<string, boolean> = {};
  hotCamp = true;
  /** Difficulty sliders: Drain, Aggro and Damage (1 is baseline). */
  difficulty = { drain: 1, aggro: 1, damage: 1 };

  constructor(names: [string, string] = ['Ash', 'Rook'], solo = false) {
    this.solo = solo;
    const mopeds = Array.from({ length: solo ? 1 : 2 }, (_, i) => newBuild('moped', { paint: PLAYER_PAINT[i], seed: 11 + i }));
    this.garage.push(...mopeds);
    this.players = [0, 1].map((i) => ({
      name: names[i],
      vehicle: mopeds[i]?.uid ?? '',
      utility: i === 0 ? 'flare' : 'horn',
      alive: true,
      gear: starterLoadout(),
    })) as [PlayerSave, PlayerSave];
  }

  /** How many people are playing: 1 solo, 2 in split screen. */
  get count(): 1 | 2 {
    return this.solo ? 1 : 2;
  }

  get crewLive() {
    return this.crew.filter((c) => c.alive && !c.deserted);
  }

  hire(role: MercRole, cut?: number): Merc | null {
    const name = MERCS.names[(this.crew.length + this.day * 3 + this.seed) % MERCS.names.length];
    const m = newMerc(role, name, cut);
    this.crew.push(m);
    return m;
  }

  // ------------------------------------------------------------------ garage

  buildByUid(uid: string): VehicleBuild | undefined {
    return this.garage.find((b) => b.uid === uid);
  }

  /** The build a player is rolling out in. Falls back to any vehicle nobody else is using. */
  buildOf(i: number): VehicleBuild {
    const found = this.buildByUid(this.players[i].vehicle);
    if (found) return found;
    const other = this.solo ? '' : this.players[1 - i].vehicle;
    const spare = this.garage.find((b) => b.uid !== other);
    if (spare) {
      this.players[i].vehicle = spare.uid;
      return spare;
    }
    const b = newBuild('moped', { paint: PLAYER_PAINT[i], seed: 31 + i + this.day });
    this.garage.push(b);
    this.players[i].vehicle = b.uid;
    return b;
  }

  activeBuilds(): VehicleBuild[] {
    return this.solo ? [this.buildOf(0)] : [this.buildOf(0), this.buildOf(1)];
  }

  /** Add a vehicle to the yard and, if asked, hand it to a player. Returns false when the yard is full. */
  addVehicle(b: VehicleBuild, to?: number): boolean {
    if (!this.garage.includes(b)) {
      if (this.garage.length >= GARAGE_MAX) return false;
      this.garage.push(b);
    }
    if (to !== undefined) this.players[to].vehicle = b.uid;
    return true;
  }

  removeVehicle(uid: string) {
    this.garage = this.garage.filter((b) => b.uid !== uid);
  }

  /** Take in a vehicle found on the road. The yard's limit is enforced at camp, not mid-leg. */
  adopt(b: VehicleBuild) {
    if (!this.garage.includes(b)) this.garage.push(b);
  }

  /**
   * Over the yard's limit, the convoy breaks down the least useful spare vehicles for scrap.
   * Returns what was broken down, for the dawn report.
   */
  trimGarage(): { name: string; scrap: number }[] {
    const out: { name: string; scrap: number }[] = [];
    const active = new Set(this.players.slice(0, this.count).map((p) => p.vehicle));
    while (this.garage.length > GARAGE_MAX) {
      const spare = this.garage.filter((b) => !active.has(b.uid));
      if (!spare.length) break;
      spare.sort((a, b) => buildValue(a) - buildValue(b));
      const worst = spare[0];
      const y = dismantleYield(worst);
      for (const k of Object.keys(y.stocks) as (keyof Stocks)[]) this.stocks[k] += y.stocks[k] ?? 0;
      for (const it of y.items) this.addPart(it);
      this.removeVehicle(worst.uid);
      out.push({ name: buildName(worst), scrap: y.stocks.scrap ?? 0 });
    }
    return out;
  }

  /** Two players can't roll out in the same vehicle: the second falls back to something else. */
  settleActives() {
    if (this.solo) return;
    if (this.players[0].vehicle === this.players[1].vehicle) {
      const spare = this.garage.find((b) => b.uid !== this.players[0].vehicle);
      if (spare) this.players[1].vehicle = spare.uid;
      else {
        const b = newBuild('moped', { paint: PLAYER_PAINT[1], seed: 77 + this.day });
        this.garage.push(b);
        this.players[1].vehicle = b.uid;
      }
    }
  }

  // ------------------------------------------------------------------ inventory

  get inventoryCap(): number {
    return inventoryCap(this.activeBuilds());
  }

  /** Stash a part. When the trucks are full it is broken down for Scrap instead. */
  addPart(item: PartItem): { stored: boolean; scrap: number } {
    if (this.inventory.length >= this.inventoryCap) {
      const scrap = Math.max(1, scrapValue(item));
      this.stocks.scrap += scrap;
      return { stored: false, scrap };
    }
    this.inventory.push(item);
    return { stored: true, scrap: 0 };
  }

  /** Spare-part slots still free in the trucks. */
  get inventoryRoom(): number {
    return Math.max(0, this.inventoryCap - this.inventory.length);
  }

  /** Stow a part in the trunk. Unlike addPart, a full trunk refuses it instead of scrapping it. */
  stowPart(item: PartItem): boolean {
    if (this.inventory.length >= this.inventoryCap) return false;
    this.inventory.push(item);
    return true;
  }

  /** Pour spare fuel into the convoy's reserve cans. */
  stowFuel(amount: number) {
    this.stocks.fuel += amount;
  }

  /** Stow loose oil cans. Returns how much fitted; the rest has nowhere to go. */
  stowOil(amount: number): number {
    const take = Math.max(0, Math.min(amount, OIL_RESERVE_MAX - this.items.oil));
    this.items.oil += take;
    return take;
  }

  takePart(uid: string): PartItem | null {
    const i = this.inventory.findIndex((p) => p.uid === uid);
    if (i < 0) return null;
    return this.inventory.splice(i, 1)[0];
  }

  // ------------------------------------------------------------------ personal gear

  /**
   * A find for one person's bag. If theirs is full it goes to their partner's, and if that is full too (or nobody is
   * there) it is broken down for Scrap, the same way a full trunk breaks down a spare part.
   */
  giveGear(to: number, item: GearItem): { to: 'self' | 'partner' | 'scrap'; scrap: number } {
    if (addToBag(this.players[to].gear, item)) return { to: 'self', scrap: 0 };
    const other = 1 - to;
    if (!this.solo && addToBag(this.players[other].gear, item)) return { to: 'partner', scrap: 0 };
    const scrap = Math.max(1, scrapOf(item));
    this.stocks.scrap += scrap;
    return { to: 'scrap', scrap };
  }

  // ------------------------------------------------------------------ save

  serialize() {
    return {
      v: 2,
      seed: this.seed,
      legId: this.legId,
      history: this.history,
      hub: this.hub,
      stocks: this.stocks,
      ammo: this.ammo,
      items: this.items,
      chassis: this.chassis,
      fragments: [...this.fragments],
      crew: this.crew,
      axes: this.axes,
      seen: [...this.seenEncounters],
      lead: this.lead,
      day: this.day,
      players: this.players,
      solo: this.solo,
      garage: this.garage,
      inventory: this.inventory,
      stats: this.stats,
      flags: this.flags,
      hotCamp: this.hotCamp,
      difficulty: this.difficulty,
      drugs: this.drugs.map((d) => d.serialize()) as [DrugSave, DrugSave],
    };
  }

  /** A night's sleep: whatever was in the blood is gone, and the body half forgets. */
  restDrugs() {
    for (const d of this.drugs) d.rest();
  }

  static deserialize(d: ReturnType<Campaign['serialize']> | LegacySave): Campaign {
    const c = new Campaign([d.players[0].name, d.players[1].name], !!d.solo);
    c.seed = d.seed;
    c.legId = d.legId;
    c.history = d.history;
    c.hub = d.hub;
    c.stocks = d.stocks;
    c.ammo = d.ammo;
    c.items = { ...c.items, ...d.items };
    c.chassis = d.chassis;
    c.fragments = new Set(d.fragments);
    c.crew = d.crew;
    c.axes = d.axes;
    c.seenEncounters = new Set(d.seen);
    c.lead = d.lead;
    c.day = d.day;
    c.stats = d.stats;
    c.flags = d.flags;
    c.hotCamp = d.hotCamp;
    c.difficulty = d.difficulty;
    if (Array.isArray(d.drugs)) c.drugs = [DrugState.restore(d.drugs[0]), DrugState.restore(d.drugs[1])];
    if ('garage' in d && Array.isArray(d.garage)) {
      const m = d as ReturnType<Campaign['serialize']>;
      c.garage = m.garage.filter((b) => hasChassis(b.chassis)).map(sanitizeBuild);
      c.inventory = (m.inventory ?? []).filter((p) => hasPart(p.id));
      // Reserve every stored id before sanitizing can mint new ones, so a repaired item never collides with a saved one.
      seedUids(m.players.flatMap((p) => uidsIn((p as Partial<PlayerSave>).gear)));
      // Saves from before gear existed have no loadout: sanitizing hands out the starter kit.
      c.players = m.players.map((p) => ({ ...p, gear: sanitizeLoadout((p as Partial<PlayerSave>).gear) })) as [PlayerSave, PlayerSave];
    } else {
      migrateV1(c, d as LegacySave);
    }
    seedUids([
      ...c.garage.map((b) => b.uid),
      ...c.inventory.map((p) => p.uid),
      ...c.garage.flatMap((b) => Object.values(b.fit).map((p) => p!.uid)),
      ...c.players.flatMap((p) => allItems(p.gear).map((g) => g.uid)),
    ]);
    c.settleActives();
    for (let i = 0; i < c.count; i++) c.buildOf(i);
    return c;
  }
}

/** The pre-garage save shape: a tier and five module levels per player. */
export interface LegacySave extends Omit<ReturnType<Campaign['serialize']>, 'players' | 'garage' | 'inventory' | 'v' | 'solo' | 'drugs'> {
  drugs?: undefined;
  v: 1;
  solo?: undefined;
  players: { name: string; tier: number; mods: Record<'engine' | 'armor' | 'wheels' | 'weapon' | 'utility', number>; hpFrac: number; utility: PlayerSave['utility']; alive: boolean }[];
  garage?: undefined;
}

/** Every `uid` string found anywhere inside a piece of raw save data. */
function uidsIn(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.flatMap(uidsIn);
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw).flatMap(([k, v]) => (k === 'uid' && typeof v === 'string' ? [v] : uidsIn(v)));
}

const TIER_CHASSIS = ['moped', 'quad', 'buggy', 'truck', 'rig'];

/** Turn an old tier and module levels into a build with the equivalent parts fitted. */
function migrateV1(c: Campaign, d: LegacySave) {
  c.garage = [];
  c.inventory = [];
  c.players = d.players.map((p, i) => {
    const chassis = TIER_CHASSIS[Math.max(0, Math.min(2, (p.tier ?? 1) - 1))];
    const b = newBuild(chassis, { paint: PLAYER_PAINT[i], seed: 11 + i, hp: Math.max(0.05, p.hpFrac ?? 1) });
    for (const slot of ['engine', 'armor', 'wheels', 'weapon', 'utility'] as const) {
      const mk = p.mods?.[slot] ?? 0;
      if (mk <= 0) continue;
      const def = PARTS.parts.find((x) => x.slot === slot && x.mk === Math.min(3, mk));
      if (def) installPart(b, newPart(def.id, 1));
    }
    c.garage.push(b);
    return { name: p.name, vehicle: b.uid, utility: p.utility, alive: p.alive, gear: starterLoadout() };
  }) as [PlayerSave, PlayerSave];
}

/** Defend against a hand-edited or older save: drop parts that no longer exist and repair missing fields. */
function sanitizeBuild(b: VehicleBuild): VehicleBuild {
  const def = VEHICLES.tiers.concat(VEHICLES.cars).find((x) => x.id === b.chassis)!;
  const fit: VehicleBuild['fit'] = {};
  for (const slot of Object.keys(b.fit ?? {}) as PartSlot[]) {
    const it = b.fit[slot];
    if (it && hasPart(it.id) && partDef(it.id).slot === slot) fit[slot] = it;
  }
  const fresh = freshComp(def);
  const comp = { ...fresh, ...(b.comp ?? {}) };
  comp.oil = Number.isFinite(comp.oil) ? Math.min(1, Math.max(0, comp.oil)) : 1;
  if (!Array.isArray(comp.tires) || comp.tires.length !== def.physics.wheelCount) comp.tires = fresh.tires;
  return { ...b, fit, comp, stripe: b.stripe ?? 0, stripeColor: b.stripeColor ?? 0xe9dfc7, fuel: b.fuel ?? 1, hp: Math.max(0.01, b.hp ?? 1) };
}
