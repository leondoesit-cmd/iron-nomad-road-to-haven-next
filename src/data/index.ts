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
import { validateGear } from './gear';

export * from './gear';

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
  | 'side';
/**
 * Every part category. `wheels` is the category of a tyre: tyres are fitted one per wheel (see `VehicleBuild.tyres`), never
 * as a slot of their own, and `doorL` is the category of a door, which fits either side.
 */
export const PART_SLOTS: PartSlot[] = ['engine', 'cooling', 'gearbox', 'exhaust', 'wheels', 'suspension', 'brakes', 'hood', 'doorL', 'doorR', 'armor', 'weapon', 'utility', 'front', 'roof', 'rear', 'side'];
/** Slots that hold one part directly in `Fit`. Everything but the tyres, which are one per wheel. */
export const FIT_SLOTS: PartSlot[] = PART_SLOTS.filter((s) => s !== 'wheels');
/** Which mounts a part of this category can be bolted to. A door fits either side; a tyre fits any wheel. */
export function mountsFor(category: PartSlot): PartSlot[] {
  return category === 'doorL' || category === 'doorR' ? ['doorL', 'doorR'] : [category];
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
  campSites: string[];
  sets: SetPiece[];
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
  errs.push(...validateGear());
  return errs;
}
