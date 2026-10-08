import { FIT_SLOTS, FUEL_TYPES, GEAR, HEROES, LEGS, MERCS, PARTS, VEHICLES, hasChassis, hasPart, isHero, mountsFor, otherHero, partDef, seatHeroes, type FuelType, type HeroId, type MercRole, type PartSlot, type Stocks } from '../data';
import { newAxes, type Axes } from '../sim/endings';
import { newStocks } from '../sim/resources';
import { newMerc, type Merc } from '../sim/loyalty';
import { GARAGE_MAX, PLAYER_PAINT, buildName, buildValue, dismantleYield, freshComp, inventoryCap, installPart, newBuild, type VehicleBuild } from '../sim/garage';
import { newPart, newUid, scrapValue, seedUids, type PartItem, type Tyres } from '../sim/parts';
import { addToBag, allItems, isWeapon, newGear, sanitizeLoadout, scrapOf, starterLoadout, type GearItem, type Loadout } from '../sim/gear';
import { DrugState, type DrugId, type DrugSave } from '../sim/drugs';
import { newNeeds, restoreNeeds, rest as restNeed, serializeNeeds, type Needs, type NeedsSave } from '../sim/needs';
import type { WorldSave } from './worldMemory';
import { fuelOf } from '../sim/engines';
import { addReserve } from '../sim/fuel';
import { WATER_RESERVE_MAX } from '../sim/fluids';
import { cleanPanels } from '../sim/paint';
import { newNavMarks, restoreNavMarks, type NavMarks } from '../sim/navmarks';

export interface PlayerSave {
  /** Who this seat plays: Chinsky, Leo or Nar. Their face, build and name come with it. */
  hero: HeroId;
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
  /** Field dressings: stop a bleed and mend a little. Cheap, so they are the thing to reach for mid-fight. */
  bandage: number;
  /** Arrows for a bow: found with one, made at camp, and pulled back out of whatever they were shot into. */
  arrow: number;
  molotov: number;
  flare: number;
  charge: number;
  /** Engine oil in the trucks, in sumps: one can is half a sump. */
  oil: number;
  /** Diesel in the reserve cans, in FU. Petrol is `stocks.fuel`. */
  diesel: number;
  /** Water for the radiators, in litres. */
  water: number;
  /** Hides off butchered game: the Ledger buys them, or cuts them into leather wraps. */
  hides: number;
  /** Wild mushrooms picked by someone who did not know them, by what they really are (`sim/forage.ts` `WILD_ITEM`). */
  wildField: number;
  wildLiberty: number;
  wildDeathcap: number;
}

/** The most spare oil the convoy can stow. */
export const OIL_RESERVE_MAX = 4;

/**
 * What the heroes set out in: the starter kit, but bareheaded and bare-handed, so their faces and hands are seen. The
 * helmet and gloves ride in the bag, one swap away in the inventory.
 */
export function heroLoadout(hero?: HeroId): Loadout {
  const l = starterLoadout();
  for (const slot of ['hands', 'head'] as const) {
    const it = l.worn[slot];
    if (!it) continue;
    delete l.worn[slot];
    l.bag.unshift(it);
  }
  if (hero === 'iati' || hero === 'nuhat' || hero === 'udud') {
    // Their own shirts stay visible; starter protection remains available in the bag.
    for (const slot of ['body', 'face'] as const) {
      const it = l.worn[slot];
      if (it) l.bag.push(it);
      delete l.worn[slot];
    }
    if (hero === 'iati') l.worn.legs = newGear('l_iati');
  }
  return l;
}

/** God mode's bag room: enough for every weapon in the game on top of the usual kit. */
export const GOD_BAG_SLOTS = 32;

/**
 * God mode: every gun and blade in the game goes in each player's bag (only the ones they don't already carry, so it is
 * safe to run again on a loaded save), with ammunition and arrows to feed them. Needs `setExtraBagSlots(GOD_BAG_SLOTS)`.
 */
export function grantAllWeapons(c: Campaign) {
  for (const p of c.players) {
    const have = new Set(allItems(p.gear).map((it) => it.id));
    for (const d of GEAR.items) if (isWeapon(d) && !have.has(d.id)) p.gear.bag.push(newGear(d.id));
  }
  c.ammo = Math.max(c.ammo, 999);
  c.items.arrow = Math.max(c.items.arrow, 60);
}

/** The heroes for each seat from a save: what it names, or the usual seating for anything it does not. */
function savedHeroes(players: readonly object[], solo: boolean): [HeroId, HeroId] {
  const dflt = seatHeroes(solo);
  const [a, b] = players.map((p) => (p as { hero?: unknown }).hero);
  const first = isHero(a) ? a : dflt[0];
  return [first, isHero(b) && b !== first ? b : otherHero(first)];
}

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
  items: Items = { medkit: 1, bandage: 2, arrow: 0, molotov: 1, flare: 2, charge: 0, painkiller: 1, stim: 1, adrenaline: 0, alcohol: 1, weed: 0, haze: 0, mushrooms: 0, lsd: 0, ayahuasca: 0, oil: 1, diesel: 0, water: 30, hides: 0, wildField: 0, wildLiberty: 0, wildDeathcap: 0 };
  /** What each player has in their blood. Saved, so a trip survives a camp and a reload. */
  drugs: [DrugState, DrugState] = [new DrugState(), new DrugState()];
  /** Hunger, thirst, bladder and bowels, one body each. Carried across camps and legs and saved. */
  needs: [Needs, Needs] = [newNeeds(), newNeeds()];
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
  /** The open world as the last Ledger left it (see WorldMemory). */
  worldSave?: WorldSave;
  /** Each seat's waypoint and the shared points of interest marked on the map (`sim/navmarks.ts`). */
  nav: NavMarks = newNavMarks();

  /** `heroes` picks who sits in each seat; by default Chinsky left and Leo right, or Leo alone. */
  constructor(heroes?: readonly [HeroId, HeroId], solo = false) {
    this.solo = solo;
    const who = heroes ?? seatHeroes(solo);
    const mopeds = Array.from({ length: solo ? 1 : 2 }, (_, i) => newBuild('moped', { paint: PLAYER_PAINT[i], seed: 11 + i }));
    this.garage.push(...mopeds);
    this.players = [0, 1].map((i) => ({
      hero: who[i],
      name: HEROES[who[i]].name,
      vehicle: mopeds[i]?.uid ?? '',
      utility: i === 0 ? 'flare' : 'horn',
      alive: true,
      gear: heroLoadout(who[i]),
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

  /** Pour spare fuel into the convoy's reserve cans. Petrol and diesel are kept apart. */
  stowFuel(amount: number, type: FuelType = 'petrol') {
    addReserve(this, type, amount);
  }

  /** Stow loose oil cans. Returns how much fitted; the rest has nowhere to go. */
  stowOil(amount: number): number {
    const take = Math.max(0, Math.min(amount, OIL_RESERVE_MAX - this.items.oil));
    this.items.oil += take;
    return take;
  }

  /** Stow water cans. Returns how much fitted; the rest has nowhere to go. */
  stowWater(amount: number): number {
    const take = Math.max(0, Math.min(amount, WATER_RESERVE_MAX - this.items.water));
    this.items.water += take;
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
      needs: this.needs.map(serializeNeeds) as [NeedsSave, NeedsSave],
      world: this.worldSave,
      nav: this.nav,
    };
  }

  /** A night's sleep: whatever was in the blood is gone, and the body half forgets. */
  restDrugs() {
    for (const d of this.drugs) d.rest();
  }

  /** The same night, for the belly: who had supper and a drink, and who wakes hollow. */
  restNeeds(fed: boolean[], watered: boolean[]) {
    this.needs.forEach((n, i) => restNeed(n, { fed: fed[i] ?? true, watered: watered[i] ?? true }));
  }

  static deserialize(d: ReturnType<Campaign['serialize']> | LegacySave): Campaign {
    // Saves from before the heroes had callsigns instead: each seat becomes whoever plays it now.
    const heroes = savedHeroes(d.players, !!d.solo);
    const c = new Campaign(heroes, !!d.solo);
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
    c.worldSave = (d as { world?: WorldSave }).world;
    // Saves from before map marks have none.
    c.nav = restoreNavMarks((d as { nav?: unknown }).nav);
    if (Array.isArray(d.drugs)) c.drugs = [DrugState.restore(d.drugs[0]), DrugState.restore(d.drugs[1])];
    // Saves from before the body had chores have no needs: they start well fed.
    const nd = (d as { needs?: NeedsSave[] }).needs;
    c.needs = [restoreNeeds(nd?.[0]), restoreNeeds(nd?.[1])];
    if ('garage' in d && Array.isArray(d.garage)) {
      const m = d as ReturnType<Campaign['serialize']>;
      // Reserve every stored id before sanitizing can mint new ones (an old tyre set becomes four tyres), so a repaired item never collides with a saved one.
      seedUids([...uidsIn(m.garage), ...uidsIn(m.inventory)]);
      c.garage = m.garage.filter((b) => hasChassis(b.chassis)).map(sanitizeBuild);
      c.inventory = (m.inventory ?? []).filter((p) => hasPart(p.id));
      // Reserve every stored id before sanitizing can mint new ones, so a repaired item never collides with a saved one.
      seedUids(m.players.flatMap((p) => uidsIn((p as Partial<PlayerSave>).gear)));
      // Saves from before gear existed have no loadout: sanitizing hands out the starter kit.
      c.players = m.players.map((p, i) => ({ ...p, hero: heroes[i], name: HEROES[heroes[i]].name, gear: sanitizeLoadout((p as Partial<PlayerSave>).gear) })) as [PlayerSave, PlayerSave];
    } else {
      migrateV1(c, d as LegacySave);
    }
    seedUids([
      ...c.garage.map((b) => b.uid),
      ...c.inventory.map((p) => p.uid),
      ...c.garage.flatMap((b) => [...Object.values(b.fit).map((p) => p!.uid), ...b.tyres.flatMap((t) => (t ? [t.uid] : []))]),
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
      const def = PARTS.parts.find((x) => !x.stock && x.slot === slot && x.mk === Math.min(3, mk));
      if (def) installPart(b, newPart(def.id, 1));
    }
    c.garage.push(b);
    const hero = c.players[i].hero;
    return { hero, name: HEROES[hero].name, vehicle: b.uid, utility: p.utility, alive: p.alive, gear: heroLoadout(hero) };
  }) as [PlayerSave, PlayerSave];
}

/** Defend against a hand-edited or older save: drop parts that no longer exist and repair missing fields. */
function sanitizeBuild(b: VehicleBuild): VehicleBuild {
  const def = VEHICLES.tiers.concat(VEHICLES.cars).find((x) => x.id === b.chassis)!;
  const fit: VehicleBuild['fit'] = {};
  for (const slot of Object.keys(b.fit ?? {}) as PartSlot[]) {
    const it = b.fit[slot];
    // Tyres are one per wheel now; a fitted door may sit on either side.
    if (it && hasPart(it.id) && FIT_SLOTS.includes(slot) && mountsFor(partDef(it.id).slot).includes(slot)) fit[slot] = it;
  }
  const fresh = freshComp(def);
  const comp = { ...fresh, ...(b.comp ?? {}) };
  const unit = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1);
  comp.oil = unit(comp.oil);
  comp.radiator = unit(comp.radiator);
  comp.gearbox = unit(comp.gearbox);
  comp.coolant = unit(comp.coolant);
  if (!Array.isArray(comp.tires) || comp.tires.length !== def.physics.wheelCount) comp.tires = fresh.tires;
  // Tyres: keep what is there; an old save fitted one set to every wheel, which becomes a tyre on each.
  const wheels = def.physics.wheelCount;
  const saved = Array.isArray(b.tyres) ? b.tyres : [];
  const isTyre = (t: PartItem | null | undefined): t is PartItem => !!t && hasPart(t.id) && partDef(t.id).slot === 'wheels';
  let tyres: Tyres = Array.from({ length: wheels }, (_, i) => (isTyre(saved[i]) ? saved[i] : null));
  const legacy = (b.fit as Record<string, PartItem | undefined> | undefined)?.wheels;
  if (isTyre(legacy) && !tyres.some(Boolean)) tyres = tyres.map((_, i) => ({ uid: newUid('p'), id: legacy.id, cond: comp.tires[i] ?? legacy.cond }));
  // Saves from before engines had a fuel: the tank holds whatever the engine in the bay burns.
  const tank: FuelType = FUEL_TYPES.includes(b.tank) ? b.tank : fuelOf(def, fit);
  // Cargo on the outside: drop what no longer exists or has no zone on this chassis, keep the rest (a save never loses a load).
  const cargo = Array.isArray(b.cargo) ? b.cargo.filter((e) => e && typeof e.id === 'string' && e.c && (e.c.kind !== 'part' || hasPart(e.c.item.id))).map((e) => ({ ...e, thr: Number.isFinite(e.thr) ? e.thr : 1 })) : undefined;
  return { ...b, ...(cargo?.length ? { cargo } : { cargo: undefined }), fit, tyres, comp, tank, panels: cleanPanels(b.panels), stripe: b.stripe ?? 0, stripeColor: b.stripeColor ?? 0xe9dfc7, fuel: b.fuel ?? 1, hp: Math.max(0.01, b.hp ?? 1) };
}
