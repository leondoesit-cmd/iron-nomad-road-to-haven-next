import vehiclesJson from './vehicles.json';
import enemiesJson from './enemies.json';
import mercsJson from './mercs.json';
import structuresJson from './structures.json';
import legsJson from './legs.json';
import encountersJson from './encounters.json';
import stringsJson from './strings.en.json';
import partsJson from './parts.json';
import boatsJson from './boats.json';
import wildlifeJson from './wildlife.json';
import travellersJson from './travellers.json';
import { validateGear } from './gear';

export * from './gear';
export * from './heroes';
export * from './gangs';

export type StockId = 'fuel' | 'rations' | 'scrap' | 'parts' | 'tech' | 'medicine';
export const STOCK_IDS: StockId[] = ['fuel', 'rations', 'scrap', 'parts', 'tech', 'medicine'];
export type Stocks = Record<StockId, number>;
export type Cost = Partial<Record<StockId | 'fu', number>>;

export type ModuleSlot = 'engine' | 'armor' | 'wheels' | 'weapon' | 'utility';
export const MODULE_SLOTS: ModuleSlot[] = ['engine', 'armor', 'wheels', 'weapon', 'utility'];

/** Every place a part can be bolted on. Engine and radiator are the powertrain, then the performance slots, then four mounts. */
export type PartSlot =
  | 'engine'
  | 'cooling'
  | 'gearbox'
  | 'exhaust'
  | 'wheels'
  | 'suspension'
  | 'brakes'
  | 'hood'
  | 'doorL'
  | 'doorR'
  | 'armor'
  | 'weapon'
  | 'utility'
  | 'front'
  | 'roof'
  | 'rear'
  | 'side'
  // The cabin: seats, steering wheel and dashboard are real parts that can be missing.
  | 'seatD'
  | 'seatP'
  | 'seatR'
  | 'steer'
  | 'dash';
/**
 * Every part category. `wheels` is the category of a tyre: tyres are fitted one per wheel (see `VehicleBuild.tyres`), never
 * as a slot of their own, `doorL` is the category of a door, which fits either side, and `seatD` is the category of a front
 * seat, which fits the driver's or the passenger's mount.
 */
export const PART_SLOTS: PartSlot[] = ['engine', 'cooling', 'gearbox', 'exhaust', 'wheels', 'suspension', 'brakes', 'hood', 'doorL', 'doorR', 'armor', 'weapon', 'utility', 'front', 'roof', 'rear', 'side', 'seatD', 'seatP', 'seatR', 'steer', 'dash'];
/** Slots that hold one part directly in `Fit`. Everything but the tyres, which are one per wheel. */
export const FIT_SLOTS: PartSlot[] = PART_SLOTS.filter((s) => s !== 'wheels');
/**
 * The cabin's mounts. A chassis lists the ones it has in `slots`; its factory seats, wheel and dash are `seat_std`,
 * `bench_std`, `steer_std` and `dash_std`, and each empty mount holds a `*_none` part (`seat_none`, `bench_none`,
 * `steer_none`, `dash_none`). The world and salvage code can strip or swap them like any other slot.
 */
export const INTERIOR_SLOTS: PartSlot[] = ['seatD', 'seatP', 'seatR', 'steer', 'dash'];
export const isInteriorSlot = (s: PartSlot): boolean => INTERIOR_SLOTS.includes(s);
/** The factory part of each cabin mount, and the placeholder that stands for a mount with nothing in it. */
export const INTERIOR_STOCK: Record<string, string> = { seatD: 'seat_std', seatP: 'seat_std', seatR: 'bench_std', steer: 'steer_std', dash: 'dash_std' };
export const INTERIOR_NONE: Record<string, string> = { seatD: 'seat_none', seatP: 'seat_none', seatR: 'bench_none', steer: 'steer_none', dash: 'dash_none' };
/** Which mounts a part of this category can be bolted to. A door fits either side, a front seat either front place; a tyre fits any wheel. */
export function mountsFor(category: PartSlot): PartSlot[] {
  if (category === 'doorL' || category === 'doorR') return ['doorL', 'doorR'];
  if (category === 'seatD' || category === 'seatP') return ['seatD', 'seatP'];
  return [category];
}
export const MOUNT_SLOTS: PartSlot[] = ['front', 'roof', 'rear', 'side'];
export type WeaponMount = 'none' | 'front' | 'bed';

export interface VehiclePhysicsDef {
  mass: number;
  wheelCount: number;
  maxSteerDeg: number;
  suspension: { stiffness: number; travel: number; rest: number };
  frictionSlip: number;
  sideFriction: number;
  engineForce: number;
  brake: number;
  wheelRadius: number;
  halfExtents: [number, number, number];
  hardY: number;
  wheelsZ: number[];
  wheelsX: number[];
  uprightGain: number;
  lean: boolean;
  /** 'boat': a hull that floats (see physics/boat.ts). The wheel fields are ignored. */
  kind?: 'boat';
  boat?: BoatPhysics;
}

/** How a hull sits and moves in the water. */
export interface BoatPhysics {
  /** Metres of hull under the waterline at rest. */
  draft: number;
  /** Linear and quadratic drag along the keel, and the sideways drag that keeps a boat on its line. */
  forwardDrag: number;
  quadDrag: number;
  lateralDrag: number;
  /** Top turn rate in rad/s. */
  yawRate: number;
  /** Driven by a fan above the water: needs no propeller depth. */
  air: boolean;
}

export interface VehicleDef {
  tier: number;
  id: string;
  name: string;
  width: number;
  length: number;
  topSpeedKmh: number;
  hp: number;
  armor: number;
  cargo: number;
  seats: number;
  weapon: string | null;
  signature: { idle: number; moving: number };
  tank: number;
  burn: number;
  beta?: boolean;
  camera: { dist: number; height: number };
  physics: VehiclePhysicsDef;
  upgrade: { parts: number; scrap: number; tech: number; chassis: number; needsGarage?: boolean };
  /** 0..1: how well it copes with sand and mud. Missing means the baseline (0.45). */
  offroad?: number;
  /** What a weapon part gives this chassis: a fixed front gun, a bed gun with a gunner seat, or nothing. */
  weaponMount?: WeaponMount;
  /** Which slots accept parts. Missing means all of them. */
  slots?: PartSlot[];
  /** Where the gunner stands on a bed-gun chassis, in the chassis frame. Missing means the buggy's bed. */
  gunner?: [number, number, number];
  /** Seat positions in the chassis frame (x left, y up, z forward). */
  seat?: { driver: [number, number, number]; passenger: [number, number, number] };
  /** Can turn up abandoned on the road. */
  found?: boolean;
  lootWeight?: number;
  /** The engine and radiator it left the factory with (part ids). Missing on boats and raider rigs: they have no powertrain to swap. */
  stockEngine?: string;
  stockRadiator?: string;
  /** Size class of the engine bay, 1 (scooter frame) to 5 (truck). A bigger engine still goes in, but is forced. */
  bay?: number;
}

export type FuelType = 'petrol' | 'diesel';
export const FUEL_TYPES: FuelType[] = ['petrol', 'diesel'];

export interface GearboxSpec {
  rating: number;
  gearing: number;
  mass: number;
}
export interface SuspensionSpec {
  load: number;
  travel: number;
  mass: number;
}
export interface BrakeSpec {
  power: number;
  energy: number;
}
export interface ExhaustSpec {
  flow: number;
  noise: number;
}

/** What an engine is, whatever it is bolted into. */
export interface EngineSpec {
  /** Displacement, for display. */
  litres: number;
  /** Peak output. */
  kw: number;
  /** Dry weight in kg. */
  mass: number;
  /** Physical size class, 0 (nothing) to 5. Compare with a chassis' `bay`. */
  size: number;
  fuel: FuelType;
  layout?: string;
  /** Turbo or supercharger. */
  blown?: boolean;
}

export interface PartStats {
  force?: number;
  top?: number;
  burn?: number;
  sig?: number;
  grip?: number;
  travel?: number;
  offroad?: number;
  armor?: number;
  armorF?: number;
  armorS?: number;
  armorR?: number;
  hp?: number;
  dmg?: number;
  rate?: number;
  tank?: number;
  cargo?: number;
  plow?: number;
  ram?: number;
  light?: number;
  spare?: number;
  /** Extra air through the engine bay, as a share (a vented or missing bonnet). */
  airflow?: number;
  /** Steering lock, as a share (a quick wheel). */
  steer?: number;
}

/** What a missing cabin part does to the vehicle, in one table (`parts.json` `interior`). */
export interface InteriorRules {
  /** Steering lock left with no wheel on the column. Still drivable in a straight line. */
  noSteerLock: number;
  /** Driver sitting on the floor: grip multiplier, gun spread multiplier, how far the hips and eyes drop (m). */
  noSeatGrip: number;
  noSeatSpread: number;
  noSeatDrop: number;
}

/** Where a holder keeps things, how many footprint units it holds, the biggest single item it takes (1 small, 2 medium, 4 large) and any restriction. */
export interface PartHold {
  zone: 'roof' | 'bed' | 'carrier' | 'rack' | 'spare';
  units: number;
  max: 1 | 2 | 4;
  only?: 'cans' | 'tyres';
}

export interface PartDef {
  id: string;
  slot: PartSlot;
  /** Quality, 1 to 3. Also the rarity. */
  mk: 1 | 2 | 3;
  name: string;
  blurb: string;
  stats: PartStats;
  /** Cost to fabricate at the Ledger. */
  cost: Cost;
  /** Relative chance to turn up in salvage. */
  weight: number;
  /** Engines only: what the motor is. Its power, weight, fuel and size replace the old flat percentages. */
  engine?: EngineSpec;
  /** Radiators only: heat the core can reject at full airflow, in kW. */
  cooling?: number;
  /** Gearboxes: the output they can carry before they wear, how short the gearing is (-1 tall .. 1 short), and their weight. */
  gearbox?: GearboxSpec;
  /** Springs: the weight they carry, how far they travel (1 is stock), and their weight. */
  suspension?: SuspensionSpec;
  /** Brakes: stopping power against the stock chassis (1 is stock) and the energy they can shed in one stop, in kJ. */
  brakes?: BrakeSpec;
  /** Exhausts: extra power as a share, and noise against the stock pipe. */
  exhaust?: ExhaustSpec;
  /** Cargo holders (baskets, racks, nets, cages, the jerrycan rack, the spare-wheel carrier): where loads on the outside stay put. See `sim/cargo.ts`. */
  hold?: PartHold;
  /** A factory fitting. It can be pulled out and carried, but never turns up as random loot or on the fabricate list. */
  stock?: boolean;
  /** The "nothing there" placeholder for a bay that has been stripped. Not a real part. */
  empty?: boolean;
}

export type ZombieKind = 'walker' | 'runner' | 'screamer' | 'bloater' | 'brute' | 'stalker';
export interface ZombieDef {
  name: string;
  hp: number;
  armor: number;
  wander: number;
  chase: number;
  damage: number;
  radius: number;
  weight: number;
  scale: number;
  shriek?: number;
  sporeRadius?: number;
  sporeDps?: number;
  sporeTime?: number;
  vehicleDamage?: number;
  hesitateRadius?: number;
}

export type RaiderKind = 'buggy' | 'wagon' | 'gunman' | 'sniper' | 'saboteur';
export interface RaiderDef {
  name: string;
  hp: number;
  armor: number;
  speed: number;
  dps: number;
  range: number;
  weight: number;
  mass?: number;
  ramDamage?: number;
  rearTireHp?: number;
}

export type MercRole = 'mechanic' | 'scout' | 'scavenger' | 'vanguard';
export interface MercDef {
  name: string;
  available: boolean;
  signOn: Cost;
  upkeep: { rations: number; fu: number };
  defaultCut: number;
  stars: number;
  blurb: string;
  repairHalted?: number;
  repairMoving?: number;
}

export interface BuildElementDef {
  id: string;
  name: string;
  cost: Cost;
  size: [number, number, number];
  hp: number;
  blocks: boolean;
  blurb: string;
  slow?: number;
  dps?: number;
  coneRange?: number;
  signature?: number;
  range?: number;
  radius?: number;
  damage?: number;
}

export interface SetPiece {
  at: number;
  type: string;
  [k: string]: unknown;
}

export interface LegDef {
  id: string;
  index: number;
  act: number;
  name: string;
  subtitle: string;
  biome: 'wasteland' | 'city';
  length: number;
  seed: number;
  baseThreat: number;
  dayLength: number;
  tutorial?: boolean;
  /** Ground palette for wasteland legs. */
  theme?: 'dust' | 'salt' | 'cinder';
  endHub?: string;
  /** City legs only: the id of an authored city plan (`world/plans`) that replaces the random block grid. */
  plan?: string;
  /**
   * Present on the open-world leg: instead of one road between cliffs, the whole map is a basin you can drive across in
   * any direction. `length` is then the highway's length (south end at 0, Haven at the north end).
   */
  open?: OpenWorldSpec;
  campSites: string[];
  sets: SetPiece[];
}

/** Hand-set parameters of the open world. Everything else (roads, places, lakes) is rolled from the leg's seed. */
export interface OpenWorldSpec {
  /** The playable ground runs from -halfWidth to +halfWidth in x, and from zMin to zMax in z. Mountains close it in. */
  halfWidth: number;
  zMin: number;
  zMax: number;
  /** City districts: an authored city leg dropped into the world. `at` is the world z its local z = 0 lands on. */
  districts: { id: string; legId: string; at: number }[];
  /** Named places that work as hubs (hire, trade, garage, safe nights): z on the highway, or a free x, z. */
  hubs: { id: string; x: number; z: number }[];
  /** Where the road ends: reaching it ends the slice. */
  haven: { x: number; z: number; radius: number };
  /** The water of the country: big lakes, springs, swamps, rivers and streams, and the green land around them. */
  water?: OpenWaterSpec;
}

/** A point in world metres. */
export type XZ = [number, number];

/**
 * Hand-set water of the open world (`world/hydro.ts` turns it into ground and water). Places are anchors: a river's course
 * winds between its `via` points, its level is worked out from the ground it crosses, and everything else (islands, piers,
 * the country's roads and places) is planned around it.
 */
export interface OpenWaterSpec {
  /** Big lakes at fixed places: built like the rolled ones (islands, a pier, boats), only larger. */
  lakes: { id: string; name: string; x: number; z: number; r: number; ax?: number; rot?: number }[];
  /** Spring pools. `oasis` ones stand alone in the dust with palms round them; the rest feed a stream. */
  springs: { id: string; name: string; x: number; z: number; r: number; oasis?: boolean }[];
  /** Swamps: low ground that is half shallow water, half sodden hummocks. */
  swamps: { id: string; name: string; x: number; z: number; r: number; ax?: number; rot?: number }[];
  /** Rivers and streams in planning order: one may end in a river listed before it. */
  rivers: WaterCourseSpec[];
  /** Green country beyond what the water greens by itself, and the kind of wood that grows there. */
  greens: { id: string; x: number; z: number; r: number; lush: number; woods: 'broadleaf' | 'pine' | 'fen' }[];
}

export interface WaterCourseSpec {
  id: string;
  name: string;
  kind: 'river' | 'stream';
  /** A spring by id, or a waterfall off the mountains at the edge of the map (`at` is x on the north rim, z on the others). */
  from: { spring: string } | { rim: 'west' | 'east' | 'north'; at: number; name: string };
  via: XZ[];
  to: { lake: string } | { swamp: string } | { river: string };
  /** Half the width of the water and the depth in mid-channel, at the source and at the mouth. */
  half: [number, number];
  depth: [number, number];
  /** Cascades along the course: where (0 source, 1 mouth) and how far it drops, in metres. */
  falls?: { at: number; h: number; name?: string }[];
  /** Sideways wander of the course between its anchors, in metres. */
  meander?: number;
}

export interface HubDef {
  name: string;
  features: string[];
  safeNight: boolean;
  blurb: string;
}

export interface CampSiteDef {
  name: string;
  exposure: number;
  cover: number;
  room: number;
  blurb: string;
}

export interface EncounterEffects {
  stocks?: Partial<Record<StockId, number>>;
  /** Named finds handed over: `n` things from a loot context (see `sim/loot.ts`), never abstract Scrap, Parts or Tech. */
  loot?: { from: string; n: number };
  axes?: Partial<Record<'mercy' | 'trust' | 'notoriety', number>>;
  loyalty?: number;
  ambush?: number;
  zombies?: number;
  fragment?: boolean;
  chance?: { p: number; fail: EncounterEffects };
}
export interface EncounterDef {
  id: string;
  biome: 'wasteland' | 'city';
  choices: { id: string; effects: EncounterEffects }[];
}

export const VEHICLES = vehiclesJson as unknown as {
  armorFacing: { front: number; side: number; rear: number };
  tiers: VehicleDef[];
  /** Abandoned-car chassis that can turn up in the world. */
  cars: VehicleDef[];
  surfaces: Record<string, { grip: number; drag: number }>;
};
export const PARTS = partsJson as unknown as {
  slots: PartSlot[];
  labels: Record<PartSlot, string>;
  rarity: Record<string, string>;
  /** Condition a stock component drops to when its upgrade part is pulled out. */
  stockCondition: number;
  interior: InteriorRules;
  parts: PartDef[];
  paints: { id: string; name: string; c: number }[];
  stripes: { id: string; name: string }[];
};
const PART_BY_ID = new Map(PARTS.parts.map((p) => [p.id, p]));
export function partDef(id: string): PartDef {
  const p = PART_BY_ID.get(id);
  if (!p) throw new Error(`Unknown part ${id}`);
  return p;
}
export function hasPart(id: string) {
  return PART_BY_ID.has(id);
}

/** Boats found at the docks. They are not part of the garage: nobody builds or upgrades one. */
export const BOATS = (boatsJson as unknown as { boats: VehicleDef[] }).boats;
export function boatDef(id: string): VehicleDef {
  const d = BOATS.find((b) => b.id === id);
  if (!d) throw new Error(`Unknown boat ${id}`);
  return d;
}

/** Every chassis by id: the five signature tiers plus the abandoned cars. */
export const CHASSIS: Record<string, VehicleDef> = Object.fromEntries([...VEHICLES.tiers, ...VEHICLES.cars].map((d) => [d.id, d]));
export function chassisDef(id: string): VehicleDef {
  const d = CHASSIS[id];
  if (!d) throw new Error(`Unknown chassis ${id}`);
  return d;
}
export function hasChassis(id: string) {
  return id in CHASSIS;
}
export type AnimalKind = 'hare' | 'deer' | 'vulture' | 'dog' | 'wolf' | 'boar' | 'bear';
/** prey: bolts from danger. bird: wheels overhead. pack: hunts people on foot. charger: bolts, then rams what upset it. brute: leaves you be until provoked. */
export type AnimalTemper = 'prey' | 'bird' | 'pack' | 'charger' | 'brute';
export interface AnimalDef {
  name: string;
  temper: AnimalTemper;
  hp: number;
  armor: number;
  walk: number;
  run: number;
  radius: number;
  size: number;
  sight: number;
  damage?: number;
  vehicleDamage?: number;
  /** Rations dropped when it is killed and a player reaches the carcass. */
  meat: number;
  group: [number, number];
  /** Most of this species alive in the world at once. */
  cap: number;
  /** Leg index from which it turns up. */
  legs: number;
  biomes: ('wasteland' | 'city')[];
  themes: ('dust' | 'salt' | 'cinder')[];
  weight: number;
  altitude?: number;
}
export const WILDLIFE = wildlifeJson as unknown as {
  rules: { activeRadius: number; spawnMin: number; spawnMax: number; despawnRadius: number; maxAlive: number; spawnEvery: number; corpseSeconds: number };
  species: Record<AnimalKind, AnimalDef>;
};

// ------------------------------------------------------------------------------------------ road travellers

/** How a traveller carries itself toward you. Traders are always `neutral`; the rest are mostly neutral too, but some are rude or wary. */
export type Attitude = 'neutral' | 'rude' | 'wary';
export const ATTITUDES: Attitude[] = ['neutral', 'rude', 'wary'];
export type TravellerKind = 'trader' | 'pilgrim' | 'drifter' | 'scavenger' | 'courier' | 'hunter';
export type RequestKind = 'food' | 'medicine' | 'fuel' | 'directions';
/** A [min, max] range of whole units. */
export type Span = [number, number];

export interface TravellerDef {
  name: string;
  /** Relative chance of turning up when a traveller is due. */
  weight: number;
  /** Most of this kind on the road at once. */
  cap: number;
  hp: number;
  /** Walking pace, m/s. */
  walk: number;
  group: Span;
  /** Relative weights of each attitude. */
  attitudes: Record<Attitude, number>;
  /** Chance that an individual is asking for help, and what they might ask for. */
  request: number;
  asks: RequestKind[];
  /** What is in their hand (a `Held` name from the humanoid renderer). */
  held: string;
  /** Shoots back when shot at. Everyone else runs. */
  armed: boolean;
  /** Pulls a handcart. */
  cart?: boolean;
  /** Opens a trade panel instead of making small talk. */
  trade?: boolean;
  /** Always in a hurry: barely stops to talk. */
  hurry?: boolean;
  /** Multiplier on their spawn weight at deep night. */
  night: number;
  /** What a body is worth, per stock, as [min, max]. */
  loot: Partial<Record<StockId, Span>>;
}
export interface RequestDef {
  cost: Cost;
  /** What they press into your hand in thanks. */
  thanks: Partial<Record<StockId, Span>>;
  axes: Partial<Record<'mercy' | 'trust' | 'notoriety', number>>;
  loyalty: number;
  /** Axes moved by turning them away. */
  refuse: Partial<Record<'mercy' | 'trust' | 'notoriety', number>>;
  /** They tell you where a camp is. */
  rumour?: boolean;
}
export interface BuyOfferDef {
  id: string;
  give: Partial<Record<StockId, number>>;
  cost: Partial<Record<StockId, number>>;
  qty: Span;
}
export interface SellOfferDef {
  id: string;
  take: Partial<Record<StockId, number>>;
  pay: Partial<Record<StockId, number>>;
}
export const TRAVELLERS = travellersJson as unknown as {
  rules: {
    firstAfter: number;
    spawnEvery: number;
    maxAlive: number;
    spawnMin: number;
    spawnMax: number;
    despawnRadius: number;
    nightFactor: number;
    stormFactor: number;
    campClear: number;
    noticeRadius: number;
    talkReach: number;
    wardRadius: number;
    yieldAhead: number;
    yieldSpeed: number;
    shoulder: number;
    corpseSeconds: number;
    fleeSeconds: number;
    barkGap: number;
    rumourChance: number;
    murder: Partial<Record<'mercy' | 'trust' | 'notoriety', number>>;
    murderTrader: Partial<Record<'mercy' | 'trust' | 'notoriety', number>>;
    witnessRadius: number;
  };
  archetypes: Record<TravellerKind, TravellerDef>;
  requests: Record<RequestKind, RequestDef>;
  trade: { buyCount: number; sellCount: number; priceSpread: number; purse: Span; buy: BuyOfferDef[]; sell: SellOfferDef[] };
  barks: Record<string, number>;
};
export const TRAVELLER_KINDS = Object.keys(TRAVELLERS.archetypes) as TravellerKind[];
export const REQUEST_KINDS = Object.keys(TRAVELLERS.requests) as RequestKind[];

export const ENEMIES = enemiesJson as unknown as {
  zombies: Record<ZombieKind, ZombieDef>;
  zombieRules: {
    senseRadiusPerPoint: number;
    indoorFactor: number;
    cascadeChasers: number;
    cascadeRadius: number;
    grabDps: number;
    pinDps: number;
    pinAt: number;
    pinBreakRotations: number;
    plowSpeedLoss: number;
    tierSpeedLoss: number[];
    bleedOut: number;
  };
  raiders: Record<RaiderKind, RaiderDef>;
};
export const MERCS = mercsJson as unknown as {
  roles: Record<MercRole, MercDef>;
  names: string[];
  loyalty: {
    paidInFull: number;
    missedUpkeep: number;
    cutShorted: number;
    stranded: number;
    savedByPlayer: number;
    riskyNoPay: number;
    wonRaid: number;
    restDay: number;
    bands: { loyal: number; steady: number; resentful: number; mutinous: number };
    warn1: number;
    refuse: number;
  };
};
export const STRUCTURES = structuresJson as unknown as {
  build: { buildSeconds: number; snap: number; elements: BuildElementDef[] };
  sectors: number;
  watchDetect: number;
  unwatchedDetect: number;
  sites: Record<string, CampSiteDef>;
  raids: {
    waves: string[];
    waveSeconds: number;
    hot: { loyalty: number; signatureMult: number };
    cold: { loyalty: number; signatureMult: number };
  };
};
export const LEGS = legsJson as unknown as {
  start: { stocks: Stocks; ammo: number };
  route: { start: string; next: Record<string, string[]> };
  hubs: Record<string, HubDef>;
  legs: LegDef[];
};
export const ENCOUNTERS = (encountersJson as unknown as { encounters: EncounterDef[] }).encounters;
const STRINGS = stringsJson as Record<string, string>;

/** Localized string lookup. All story text is a key into the per-language table. */
export function t(key: string, params?: Record<string, string | number>): string {
  let s = STRINGS[key] ?? key;
  if (params) for (const k in params) s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(params[k]));
  return s;
}
export function hasString(key: string) {
  return key in STRINGS;
}

export function legById(id: string): LegDef {
  const l = LEGS.legs.find((x) => x.id === id);
  if (!l) throw new Error(`Unknown leg ${id}`);
  return l;
}
export function vehicleDef(tier: number): VehicleDef {
  const v = VEHICLES.tiers[tier - 1];
  if (!v) throw new Error(`Unknown tier ${tier}`);
  return v;
}
export function encounterById(id: string): EncounterDef {
  const e = ENCOUNTERS.find((x) => x.id === id);
  if (!e) throw new Error(`Unknown encounter ${id}`);
  return e;
}

/** Schema checks. Run in the test suite (build-time) and in debug mode at boot. */
export function validateData(): string[] {
  const errs: string[] = [];
  const need = (cond: boolean, msg: string) => {
    if (!cond) errs.push(msg);
  };
  VEHICLES.tiers.forEach((v, i) => {
    need(v.tier === i + 1, `vehicle ${v.id}: tier index mismatch`);
    need(v.physics.wheelsZ.length * v.physics.wheelsX.length >= v.physics.wheelCount - 0, `vehicle ${v.id}: wheel layout too small for wheelCount`);
    need(v.hp > 0 && v.tank > 0, `vehicle ${v.id}: hp/tank must be positive`);
    need(v.armor >= 0 && v.armor < 1, `vehicle ${v.id}: armor range`);
  });
  VEHICLES.cars.forEach((v) => {
    need(!!v.found && !!v.seat, `car ${v.id}: found cars need a seat layout`);
    need(v.physics.wheelsZ.length * v.physics.wheelsX.length >= v.physics.wheelCount, `car ${v.id}: wheel layout too small for wheelCount`);
    need(!VEHICLES.tiers.some((t) => t.id === v.id), `car ${v.id}: id clashes with a tier`);
  });
  for (const b of BOATS) {
    need(b.physics.kind === 'boat' && !!b.physics.boat, `boat ${b.id}: needs physics.kind and physics.boat`);
    need(!CHASSIS[b.id], `boat ${b.id}: id clashes with a chassis`);
    need(!!b.seat && b.hp > 0 && b.tank > 0, `boat ${b.id}: seats, hp and tank`);
    need((b.physics.boat?.draft ?? 0) > 0 && (b.physics.boat?.draft ?? 9) < b.physics.halfExtents[1] * 2, `boat ${b.id}: draft must be inside the hull`);
  }
  for (const p of PARTS.parts) {
    need(PARTS.slots.includes(p.slot), `part ${p.id}: unknown slot ${p.slot}`);
    need(p.mk >= 1 && p.mk <= 3, `part ${p.id}: mk range`);
    // Factory fittings are never random loot, so they carry no weight.
    need(p.stock ? p.weight === 0 : p.weight > 0, `part ${p.id}: weight`);
    if (INTERIOR_SLOTS.includes(p.slot)) need(!p.empty || Object.values(INTERIOR_NONE).includes(p.id), `part ${p.id}: an empty cabin part must be ${Object.values(INTERIOR_NONE).join(' or ')}`);
    if (p.slot === 'engine') {
      const e = p.engine;
      need(!!e, `part ${p.id}: an engine needs an engine spec`);
      if (e) {
        need(p.empty ? e.kw === 0 : e.kw > 0 && e.litres > 0 && e.mass > 0, `part ${p.id}: engine numbers`);
        need(e.size >= (p.empty ? 0 : 1) && e.size <= 5, `part ${p.id}: engine size class`);
        need(FUEL_TYPES.includes(e.fuel), `part ${p.id}: engine fuel`);
      }
    } else need(!p.engine, `part ${p.id}: only engines have an engine spec`);
    const specOk = (slot: PartSlot, key: 'gearbox' | 'suspension' | 'brakes' | 'exhaust') => (p.slot === slot ? need(!!p[key], `part ${p.id}: a ${slot} part needs a ${key} spec`) : need(p[key] === undefined, `part ${p.id}: only ${slot} parts have a ${key} spec`));
    specOk('gearbox', 'gearbox');
    specOk('suspension', 'suspension');
    specOk('brakes', 'brakes');
    specOk('exhaust', 'exhaust');
    if (p.gearbox) need(p.gearbox.rating >= 0 && p.gearbox.gearing >= -1 && p.gearbox.gearing <= 1 && (p.empty || p.gearbox.rating > 0), `part ${p.id}: gearbox numbers`);
    if (p.suspension) need(p.suspension.load >= 0 && p.suspension.travel > 0 && (p.empty || p.suspension.load > 0), `part ${p.id}: suspension numbers`);
    if (p.brakes) need(p.brakes.power > 0 && p.brakes.energy >= 0 && (p.empty || p.brakes.energy > 0), `part ${p.id}: brake numbers`);
    if (p.exhaust) need(p.exhaust.noise > 0, `part ${p.id}: exhaust numbers`);
    if (p.slot === 'cooling') need(typeof p.cooling === 'number' && p.cooling >= 0 && (p.empty ? p.cooling === 0 : p.cooling > 0), `part ${p.id}: radiator needs a cooling rating`);
    else need(p.cooling === undefined, `part ${p.id}: only radiators have a cooling rating`);
  }
  for (const v of [...VEHICLES.tiers, ...VEHICLES.cars]) {
    need(!!v.stockEngine && PART_BY_ID.get(v.stockEngine)?.slot === 'engine' && !!PART_BY_ID.get(v.stockEngine)?.stock, `vehicle ${v.id}: needs a stock engine`);
    need(!!v.stockRadiator && PART_BY_ID.get(v.stockRadiator)?.slot === 'cooling' && !!PART_BY_ID.get(v.stockRadiator)?.stock, `vehicle ${v.id}: needs a stock radiator`);
    need((v.bay ?? 0) >= 1 && (v.bay ?? 9) <= 5, `vehicle ${v.id}: bay size class`);
    need((v.slots ?? PART_SLOTS).includes('engine') && (v.slots ?? PART_SLOTS).includes('cooling'), `vehicle ${v.id}: engine and radiator slots`);
    for (const pre of ['tyre', 'gbx', 'sus', 'brk', 'exh']) {
      const f = PART_BY_ID.get(`${pre}_${v.id}`);
      need(!!f?.stock, `vehicle ${v.id}: needs a factory ${pre} part (${pre}_${v.id})`);
    }
    for (const slot of INTERIOR_SLOTS) {
      if (!(v.slots ?? []).includes(slot)) continue;
      need(!!PART_BY_ID.get(INTERIOR_STOCK[slot])?.stock && !PART_BY_ID.get(INTERIOR_STOCK[slot])?.empty, `vehicle ${v.id}: ${slot} needs the factory part ${INTERIOR_STOCK[slot]}`);
      need(!!PART_BY_ID.get(INTERIOR_NONE[slot])?.empty, `vehicle ${v.id}: ${slot} needs the placeholder ${INTERIOR_NONE[slot]}`);
    }
  }
  need(new Set(PARTS.parts.map((p) => p.id)).size === PARTS.parts.length, 'parts: duplicate ids');
  for (const leg of LEGS.legs) {
    need(leg.length > 500, `leg ${leg.id}: too short`);
    let last = -1;
    for (const s of leg.sets) {
      need(s.at >= last, `leg ${leg.id}: set pieces must be ordered`);
      need(s.at >= 0 && s.at <= leg.length, `leg ${leg.id}: set piece beyond end`);
      last = s.at;
      if (s.type === 'encounter') need(ENCOUNTERS.some((e) => e.id === s.id), `leg ${leg.id}: unknown encounter ${String(s.id)}`);
    }
    for (const c of leg.campSites) need(c in STRUCTURES.sites, `leg ${leg.id}: unknown camp site ${c}`);
    if (leg.endHub) need(leg.endHub in LEGS.hubs, `leg ${leg.id}: unknown hub ${leg.endHub}`);
  }
  for (const [from, tos] of Object.entries(LEGS.route.next)) {
    need(LEGS.legs.some((l) => l.id === from), `route: unknown leg ${from}`);
    for (const to of tos) need(LEGS.legs.some((l) => l.id === to), `route: unknown target ${to}`);
  }
  for (const e of ENCOUNTERS) {
    need(hasString(`enc.${e.id}.title`) && hasString(`enc.${e.id}.text`), `encounter ${e.id}: missing title/text strings`);
    need(e.choices.length >= 2, `encounter ${e.id}: needs at least 2 choices`);
    for (const c of e.choices) {
      need(hasString(`enc.${e.id}.${c.id}`), `encounter ${e.id}.${c.id}: missing label`);
      need(hasString(`enc.${e.id}.${c.id}.result`), `encounter ${e.id}.${c.id}: missing result`);
    }
  }
  for (const el of STRUCTURES.build.elements) need(el.size.length === 3, `build element ${el.id}: size`);
  errs.push(...validateTravellers());
  errs.push(...validateGear());
  return errs;
}

function validateTravellers(): string[] {
  const errs: string[] = [];
  const need = (cond: boolean, msg: string) => {
    if (!cond) errs.push(msg);
  };
  const T = TRAVELLERS;
  const spanOk = (s: Span) => Array.isArray(s) && s.length === 2 && s[0] >= 0 && s[1] >= s[0];
  const stockOk = (o: Partial<Record<StockId, unknown>>) => Object.keys(o).every((k) => (STOCK_IDS as string[]).includes(k));
  for (const k of TRAVELLER_KINDS) {
    const a = T.archetypes[k];
    need(hasString(`trav.name.${k}`), `traveller ${k}: missing name string`);
    need(a.weight > 0 && a.cap >= 1 && a.hp > 0 && a.walk > 0, `traveller ${k}: numbers`);
    need(spanOk(a.group) && a.group[0] >= 1, `traveller ${k}: group span`);
    need(ATTITUDES.every((x) => typeof a.attitudes[x] === 'number' && a.attitudes[x] >= 0) && ATTITUDES.some((x) => a.attitudes[x] > 0), `traveller ${k}: attitude weights`);
    need(a.request >= 0 && a.request <= 1, `traveller ${k}: request chance`);
    need(a.request === 0 || a.asks.length > 0, `traveller ${k}: asks for help but names nothing to ask for`);
    need(a.asks.every((r) => r in T.requests), `traveller ${k}: unknown request`);
    need(!a.trade || (a.attitudes.rude === 0 && a.attitudes.wary === 0), `traveller ${k}: a trader is neutral`);
    need(a.night >= 0, `traveller ${k}: night factor`);
    need(stockOk(a.loot) && Object.values(a.loot).every((s) => spanOk(s as Span)), `traveller ${k}: loot`);
    need(!a.trade || !a.armed, `traveller ${k}: a trader carries no gun`);
  }
  for (const r of REQUEST_KINDS) {
    const q = T.requests[r];
    need(stockOk(q.cost) && stockOk(q.thanks) && Object.values(q.thanks).every((s) => spanOk(s as Span)), `request ${r}: stocks`);
    for (const a of ATTITUDES) need(hasString(`trav.ask.${r}.${a}`), `request ${r}: missing ask for ${a}`);
    need(hasString(`trav.ask.${r}.title`) && hasString(`trav.ask.${r}.give`), `request ${r}: missing title or label`);
  }
  for (const o of T.trade.buy) need(stockOk(o.give) && stockOk(o.cost) && spanOk(o.qty) && o.qty[0] >= 1 && hasString(`trav.offer.${o.id}`), `trade buy ${o.id}: shape or label`);
  for (const o of T.trade.sell) need(stockOk(o.take) && stockOk(o.pay) && hasString(`trav.offer.sell.${o.id}`), `trade sell ${o.id}: shape or label`);
  need(T.trade.buy.length >= T.trade.buyCount && T.trade.sell.length >= T.trade.sellCount, 'trade: not enough offers for the counts');
  for (const [pool, n] of Object.entries(T.barks)) {
    need(n >= 1, `bark ${pool}: empty`);
    for (let i = 1; i <= n; i++) need(hasString(`trav.bark.${pool}.${i}`), `bark ${pool}.${i}: missing string`);
  }
  return errs;
}
