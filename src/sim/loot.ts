import { PARTS, partDef, type FuelType, type PartSlot } from '../data';
import { Rng, hashString } from '../core/rng';
import { rollPartSpec } from '../sim/parts';
import { OIL_CAN } from '../sim/oil';
import { WATER_CAN } from '../sim/fluids';
import { foundCan } from '../sim/paint';

/**
 * What lies where. Every loose thing in the world is a specific, named object: a part with its wear, a can of fuel, oil
 * or water, a spray can, a ration tin, a bandage roll, a box of rounds. There is no abstract Scrap, Tech or "Parts"
 * to find: a thing is generated from the CONTEXT it is found in (a garage bench, a tyre shop rack, a pump island, a
 * wreck, a kitchen, a police locker...), and the world generator puts it on real furniture, or right beside the host
 * that justifies it (`PickupHost`).
 *
 * `rollItem` makes one item for one surface, `rollLoot` makes the contents of a container. Both are pure functions of
 * their random stream, so a place always holds the same things, and both scale with `progress` (how far from the start,
 * 0 to 1) and `depth` (0 front shelves, 1 back, 2 the deep stock), the way gear does.
 */

/** Where an item is found. The weapons table (`rollGunLoot`, see `GUN_HOOK`) reads the same names. */
export type LootContext =
  | 'garage'
  | 'dealership'
  | 'tyreshop'
  | 'warehouse'
  | 'depot'
  | 'gas_station'
  | 'wreck'
  | 'trunk'
  | 'farm'
  | 'kitchen'
  | 'bedroom'
  | 'bathroom'
  | 'house'
  | 'shop'
  | 'pharmacy'
  | 'clinic'
  | 'office'
  | 'police'
  | 'military'
  | 'gun_shop'
  | 'container'
  | 'bunker'
  | 'cache'
  | 'raider'
  | 'delve_cave'
  | 'delve_mine'
  | 'delve_bunker'
  | 'delve_metro';

export const LOOT_CONTEXTS: LootContext[] = [
  'garage', 'dealership', 'tyreshop', 'warehouse', 'depot', 'gas_station', 'wreck', 'trunk', 'farm', 'kitchen', 'bedroom', 'bathroom', 'house', 'shop', 'pharmacy', 'clinic', 'office', 'police', 'military', 'gun_shop', 'container', 'bunker', 'cache', 'raider', 'delve_cave', 'delve_mine', 'delve_bunker', 'delve_metro',
];

/** How big a thing is: what a shelf board, a bench or a rack bay can take. Heights are about what the models stand. */
export type ItemSize = 'tiny' | 'small' | 'medium' | 'large';
export const SIZE_H: Record<ItemSize, number> = { tiny: 0.34, small: 0.47, medium: 0.74, large: 0.82 };
const SIZE_ORDER: ItemSize[] = ['tiny', 'small', 'medium', 'large'];
export const fits = (size: ItemSize, cap: ItemSize) => SIZE_ORDER.indexOf(size) <= SIZE_ORDER.indexOf(cap);

/** One concrete, named find. */
export type LootSpec =
  /** A vehicle part with its wear. */
  | { kind: 'part'; id: string; cond: number }
  /** A jerrycan: `amount` FU of the given fuel. */
  | { kind: 'fuel'; amount: number; fuel: FuelType }
  /** An oil can (`amount` in sumps: a can is half of one). */
  | { kind: 'oil'; amount: number }
  /** A water can, in litres. */
  | { kind: 'water'; amount: number }
  /** A spray can in a colour with a few sprays left. */
  | { kind: 'paint'; color: number; charges: number }
  /** Ration tins. */
  | { kind: 'rations'; amount: number }
  /** A bottle of pills. */
  | { kind: 'medicine'; amount: number }
  | { kind: 'medkit'; amount: number }
  /** A roll of bandage: three dressings. */
  | { kind: 'bandage'; amount: number }
  /** A box of rounds. */
  | { kind: 'ammo'; amount: number };

export type LootKind = LootSpec['kind'];

/** What a spec weighs in the world: which shelf can take it. */
export function specSize(s: LootSpec): ItemSize {
  switch (s.kind) {
    case 'part': {
      const d = partDef(s.id);
      if (d.slot === 'engine') return 'large';
      if (d.slot === 'exhaust') return 'small';
      return 'medium';
    }
    case 'fuel':
    case 'oil':
    case 'water':
    case 'paint':
    case 'rations':
      return 'small';
    default:
      return 'tiny';
  }
}

/** How much floor or board a spec takes, as its model stands: width along the model's own x, depth along z. `turn`: the long side is z, so turn it a quarter to lie along a shelf. */
export function specFoot(s: LootSpec): { w: number; d: number; turn?: boolean } {
  switch (s.kind) {
    case 'part':
      switch (partDef(s.id).slot) {
        case 'engine':
          return { w: 0.72, d: 0.46 };
        case 'cooling':
          return { w: 0.68, d: 0.14 };
        case 'gearbox':
          return { w: 0.64, d: 0.38 };
        case 'wheels':
          return { w: 0.66, d: 0.16 };
        case 'suspension':
          return { w: 0.46, d: 0.16 };
        case 'brakes':
          return { w: 0.54, d: 0.14 };
        case 'exhaust':
          return { w: 0.84, d: 0.24 };
        case 'hood':
          return { w: 0.82, d: 0.58 };
        case 'doorL':
        case 'doorR':
          return { w: 0.8, d: 0.12, turn: true };
        default:
          return { w: 0.64, d: 0.44 };
      }
    case 'fuel':
    case 'oil':
    case 'water':
      return { w: 0.3, d: 0.28 };
    case 'paint':
      return { w: 0.24, d: 0.24 };
    case 'rations':
      return { w: 0.5, d: 0.4 };
    case 'medicine':
      return { w: 0.16, d: 0.16 };
    case 'medkit':
      return { w: 0.46, d: 0.32 };
    case 'bandage':
      return { w: 0.2, d: 0.2 };
    case 'ammo':
      return { w: 0.42, d: 0.22 };
  }
}

/** The tag that says what sort of thing a spec is, for asking a surface for the sort it wants. */
export type LootTag = 'cabin' | 'engine' | 'radiator' | 'gearbox' | 'tyre' | 'spring' | 'brake' | 'exhaust' | 'panel' | 'mount' | 'fuel' | 'oil' | 'water' | 'paint' | 'food' | 'med' | 'ammo' | 'gun';

export function specTag(s: LootSpec): LootTag {
  switch (s.kind) {
    case 'part':
      switch (partDef(s.id).slot) {
        case 'engine':
          return 'engine';
        case 'cooling':
          return 'radiator';
        case 'gearbox':
          return 'gearbox';
        case 'wheels':
          return 'tyre';
        case 'suspension':
          return 'spring';
        case 'brakes':
          return 'brake';
        case 'exhaust':
          return 'exhaust';
        case 'hood':
        case 'doorL':
        case 'doorR':
          return 'panel';
        case 'seatD':
        case 'seatP':
        case 'seatR':
        case 'steer':
        case 'dash':
          return 'cabin';
        default:
          return 'mount';
      }
    case 'fuel':
      return 'fuel';
    case 'oil':
      return 'oil';
    case 'water':
      return 'water';
    case 'paint':
      return 'paint';
    case 'rations':
      return 'food';
    case 'medicine':
    case 'medkit':
    case 'bandage':
      return 'med';
    case 'ammo':
      return 'ammo';
  }
}

export interface LootOpts {
  /** How far the convoy is from where it started, 0 to 1: better kit turns up further out. */
  progress?: number;
  /** 0 front shelves, 1 back shelves, 2 the deep stock. */
  depth?: 0 | 1 | 2;
  /** Only these sorts of thing (a tyre rack wants tyres, an engine stand an engine). */
  only?: LootTag[];
  /** The biggest thing the surface can take. */
  cap?: ItemSize;
}

interface Entry {
  w: number;
  tag: LootTag;
  make: (r: Rng, o: Required<Pick<LootOpts, 'progress' | 'depth'>>) => LootSpec;
}

/** Quality ceiling of what is found: common near the start, better with distance and in the deep stock. */
function mkCeil(o: { progress: number; depth: number }): number {
  return o.progress > 0.55 || o.depth >= 2 ? 3 : o.progress > 0.2 || o.depth >= 1 ? 2 : 1;
}

const part = (slots: PartSlot[], tag: LootTag, w: number, extra: { diesel?: boolean; petrol?: boolean } = {}): Entry => ({
  w,
  tag,
  make: (r, o) => {
    const mk = mkCeil(o);
    // The better kit is rarer: a roll at the ceiling, otherwise one grade down.
    const maxMk = r.chance(0.35 + o.progress * 0.3) ? mk : Math.max(1, mk - 1);
    for (let i = 0; i < 6; i++) {
      const s = rollPartSpec(r, { slots, minMk: 1, maxMk, bias: o.progress * 0.8 + o.depth * 0.25, condLo: 0.4 + o.depth * 0.04, condHi: 0.9 });
      if (extra.diesel || extra.petrol) {
        const f = partDef(s.id).engine?.fuel;
        if (f && (extra.diesel ? f !== 'diesel' : f !== 'petrol')) continue;
      }
      return { kind: 'part', ...s };
    }
    const s = rollPartSpec(r, { slots, minMk: 1, maxMk, condLo: 0.4, condHi: 0.9 });
    return { kind: 'part', ...s };
  },
});

const fuel = (w: number, diesel = 0.33): Entry => ({ w, tag: 'fuel', make: (r) => ({ kind: 'fuel', amount: 5, fuel: r.chance(diesel) ? 'diesel' : 'petrol' }) });
const oil = (w: number): Entry => ({ w, tag: 'oil', make: () => ({ kind: 'oil', amount: OIL_CAN }) });
const water = (w: number): Entry => ({ w, tag: 'water', make: () => ({ kind: 'water', amount: WATER_CAN }) });
const paint = (w: number): Entry => ({ w, tag: 'paint', make: (r) => ({ kind: 'paint', ...foundCan(() => r.next()) }) });
const food = (w: number, lo = 1, hi = 2): Entry => ({ w, tag: 'food', make: (r) => ({ kind: 'rations', amount: r.int(lo, hi) }) });
const pills = (w: number): Entry => ({ w, tag: 'med', make: () => ({ kind: 'medicine', amount: 1 }) });
const bandage = (w: number): Entry => ({ w, tag: 'med', make: () => ({ kind: 'bandage', amount: 1 }) });
const medkit = (w: number): Entry => ({ w, tag: 'med', make: () => ({ kind: 'medkit', amount: 1 }) });
const ammo = (w: number, lo = 12, hi = 30): Entry => ({ w, tag: 'ammo', make: (r, o) => ({ kind: 'ammo', amount: r.int(lo, hi) + Math.round(o.progress * 10) }) });

const ENGINE: PartSlot[] = ['engine'];
const RADIATOR: PartSlot[] = ['cooling'];
const GEARBOX: PartSlot[] = ['gearbox'];
const TYRE: PartSlot[] = ['wheels'];
const SPRING: PartSlot[] = ['suspension'];
const BRAKE: PartSlot[] = ['brakes'];
const EXHAUST: PartSlot[] = ['exhaust'];
const PANEL: PartSlot[] = ['hood', 'doorL', 'doorR'];
/** The cabin: seats, the wheel, the dash. */
const CABIN: PartSlot[] = ['seatD', 'seatP', 'seatR', 'steer', 'dash'];
const MOUNT: PartSlot[] = ['armor', 'weapon', 'utility', 'front', 'roof', 'rear', 'side'];

/** Every context's table: what it holds, by weight. */
const TABLES: Record<LootContext, Entry[]> = {
  garage: [part(ENGINE, 'engine', 3), part(RADIATOR, 'radiator', 2.2), part(GEARBOX, 'gearbox', 2.2), part(TYRE, 'tyre', 2), part(SPRING, 'spring', 1.5), part(BRAKE, 'brake', 2), part(EXHAUST, 'exhaust', 1.6), part(PANEL, 'panel', 1.2), part(MOUNT, 'mount', 0.6), part(CABIN, 'cabin', 1.3), oil(2), fuel(0.8), water(0.8), paint(0.7)],
  tyreshop: [part(TYRE, 'tyre', 12), oil(1), part(BRAKE, 'brake', 0.8), paint(0.3)],
  dealership: [part(TYRE, 'tyre', 2), part(BRAKE, 'brake', 1.5), part(EXHAUST, 'exhaust', 1), part(PANEL, 'panel', 1.5), part(CABIN, 'cabin', 1.6), paint(2), oil(1.5), part(RADIATOR, 'radiator', 1), part(GEARBOX, 'gearbox', 0.8), part(ENGINE, 'engine', 0.5)],
  warehouse: [part(ENGINE, 'engine', 1.5), part(RADIATOR, 'radiator', 1.5), part(GEARBOX, 'gearbox', 1.5), part(TYRE, 'tyre', 1.5), part(SPRING, 'spring', 1.5), part(BRAKE, 'brake', 1.5), part(EXHAUST, 'exhaust', 1.2), part(PANEL, 'panel', 1), part(MOUNT, 'mount', 2), part(CABIN, 'cabin', 1.2), fuel(1.5), oil(1.5), water(1), food(1)],
  depot: [part(ENGINE, 'engine', 1.2), part(RADIATOR, 'radiator', 1.5), part(GEARBOX, 'gearbox', 1.5), part(TYRE, 'tyre', 2), part(SPRING, 'spring', 1.5), part(BRAKE, 'brake', 1.5), part(EXHAUST, 'exhaust', 1.2), part(MOUNT, 'mount', 1.5), fuel(2), oil(1.5), water(0.8)],
  gas_station: [fuel(6), oil(4), water(1.5), paint(0.5), food(1.5), part(TYRE, 'tyre', 0.6), part(BRAKE, 'brake', 0.25)],
  wreck: [part(CABIN, 'cabin', 1.1), part(PANEL, 'panel', 1.2), part(TYRE, 'tyre', 1.4), part(RADIATOR, 'radiator', 1), part(GEARBOX, 'gearbox', 0.8), part(BRAKE, 'brake', 1), part(EXHAUST, 'exhaust', 1), part(SPRING, 'spring', 0.8), part(MOUNT, 'mount', 0.5), fuel(1), oil(1), water(0.5), food(0.6), pills(0.2)],
  trunk: [food(2), water(1), oil(1.2), fuel(0.8), pills(0.5), bandage(0.6), ammo(0.8), paint(0.8), part(BRAKE, 'brake', 0.5), part(TYRE, 'tyre', 0.5), part(CABIN, 'cabin', 0.3)],
  farm: [part(ENGINE, 'engine', 2, { diesel: true }), part(GEARBOX, 'gearbox', 1.2), part(RADIATOR, 'radiator', 1.5), part(TYRE, 'tyre', 1.5), part(SPRING, 'spring', 1), fuel(3, 0.8), oil(2), water(2), food(1.5)],
  kitchen: [food(8), water(1.5)],
  bedroom: [pills(1.2), bandage(1.2), ammo(0.4), food(1)],
  bathroom: [pills(4), bandage(3), medkit(0.8)],
  house: [food(3), water(1), pills(1), ammo(0.5), oil(0.5), bandage(0.5)],
  shop: [food(5), water(3), pills(1.5), oil(2), paint(1), fuel(0.6), ammo(0.3), bandage(0.8)],
  pharmacy: [pills(6), bandage(4), medkit(1.5)],
  clinic: [pills(4), bandage(4), medkit(2.5)],
  office: [ammo(0.3), pills(0.4), food(0.5)],
  police: [ammo(5), medkit(1.5), bandage(1.5), fuel(1)],
  military: [ammo(6), medkit(2), bandage(2), fuel(1.5), part(MOUNT, 'mount', 1)],
  gun_shop: [ammo(6)],
  container: [part(ENGINE, 'engine', 0.6), part(RADIATOR, 'radiator', 1), part(GEARBOX, 'gearbox', 1), part(TYRE, 'tyre', 1), part(SPRING, 'spring', 1), part(BRAKE, 'brake', 1), part(EXHAUST, 'exhaust', 1), part(PANEL, 'panel', 0.8), part(MOUNT, 'mount', 0.8), fuel(1.5), oil(1), food(1), pills(0.5)],
  bunker: [ammo(3), medkit(2), bandage(2), pills(2), food(2), part(MOUNT, 'mount', 1)],
  cache: [fuel(3), oil(2), part(RADIATOR, 'radiator', 1), part(GEARBOX, 'gearbox', 1), part(TYRE, 'tyre', 1), part(BRAKE, 'brake', 1), part(MOUNT, 'mount', 0.8), food(1)],
  raider: [ammo(4), fuel(2), part(MOUNT, 'mount', 1.5), part(BRAKE, 'brake', 0.8), part(TYRE, 'tyre', 0.8), food(1), bandage(0.8)],
  delve_cave: [food(2), pills(1), bandage(1), ammo(1), paint(0.6), part(BRAKE, 'brake', 0.8), part(TYRE, 'tyre', 0.5), part(RADIATOR, 'radiator', 0.5), fuel(0.5)],
  delve_mine: [part(ENGINE, 'engine', 1), part(GEARBOX, 'gearbox', 1.4), part(SPRING, 'spring', 1.4), part(RADIATOR, 'radiator', 1), part(BRAKE, 'brake', 1), part(EXHAUST, 'exhaust', 1), fuel(1.5), oil(2), ammo(0.4)],
  delve_bunker: [ammo(3), medkit(2), bandage(2), pills(2), food(2), part(MOUNT, 'mount', 1), part(RADIATOR, 'radiator', 0.6), fuel(0.6)],
  delve_metro: [food(3), water(2), pills(1), oil(1), part(GEARBOX, 'gearbox', 0.8), part(BRAKE, 'brake', 1.2), part(EXHAUST, 'exhaust', 0.8), paint(1), part(PANEL, 'panel', 0.5)],
};

/**
 * One item for one surface, from the context's table. Asks for a sort (`only`) and a size limit (`cap`); null if the
 * context holds nothing like that.
 */
export function rollItem(context: LootContext, rng: Rng, o: LootOpts = {}): LootSpec | null {
  const opts = { progress: o.progress ?? 0.3, depth: (o.depth ?? 0) as 0 | 1 | 2 };
  const table = TABLES[context].filter((e) => !o.only || o.only.includes(e.tag));
  if (!table.length) return null;
  // Rolled and checked against the size limit: a shelf that cannot take an engine does not get one.
  for (let tries = 0; tries < 8; tries++) {
    let r = rng.next() * table.reduce((a, e) => a + e.w, 0);
    let pick = table[table.length - 1];
    for (const e of table) {
      r -= e.w;
      if (r <= 0) {
        pick = e;
        break;
      }
    }
    const spec = pick.make(rng, opts);
    if (!o.cap || fits(specSize(spec), o.cap)) return spec;
  }
  return null;
}

/**
 * The contents of a container (a locker, a fridge, a chest): a handful of named items, more the deeper the stock. A pure
 * function of `seed`, so a search always finds the same things.
 */
export function rollLoot(context: LootContext, seed: number, depth: 0 | 1 | 2, o: { progress?: number; only?: LootTag[] } = {}): LootSpec[] {
  const rng = new Rng((Math.imul(seed | 0, 2654435761) ^ hashString(context)) >>> 0);
  const n = depth === 0 ? (rng.chance(0.55) ? 1 : 2) : depth === 1 ? rng.int(1, 3) : rng.int(2, 4);
  const out: LootSpec[] = [];
  for (let i = 0; i < n; i++) {
    const s = rollItem(context, rng, { progress: o.progress, depth, only: o.only });
    if (s) out.push(s);
  }
  return out;
}

// ------------------------------------------------------------------------------------------ weapons

/**
 * Where the guns are: `rollGunLoot(context, seed, depth)` (sim/gunLoot.ts) is keyed by the same contexts. A closed container
 * that holds guns carries a `GunStash` (just the context, seed and depth, so a search always finds the same guns); the scene
 * rolls it when the container is searched and lays the guns on the ground.
 */
export interface GunStash {
  context: 'gun_shop' | 'police' | 'military' | 'house' | 'raider' | 'wreck' | 'bunker' | 'cache';
  seed: number;
  depth: 0 | 1 | 2;
}

/** The weapons context a loot context maps to, and the chance a closed container of that kind holds guns at all. */
export function gunStashFor(context: LootContext, kind: string, depth: 0 | 1 | 2): Omit<GunStash, 'seed'> | null {
  const closed = kind === 'locker' || kind === 'safe' || kind === 'footlocker' || kind === 'crate' || kind === 'wardrobe' || kind === 'dresser' || kind === 'toolchest' || kind === 'workbench';
  switch (context) {
    case 'gun_shop':
    case 'police':
    case 'military':
      return closed && (kind === 'locker' || kind === 'safe' || kind === 'footlocker' || kind === 'crate') ? { context, depth } : null;
    case 'bunker':
    case 'delve_bunker':
      return closed ? { context: 'bunker', depth } : null;
    case 'cache':
    case 'delve_cave':
      return kind === 'safe' || kind === 'footlocker' || kind === 'crate' ? { context: 'cache', depth } : null;
    case 'house':
    case 'bedroom':
      return kind === 'wardrobe' || kind === 'dresser' || kind === 'footlocker' || kind === 'safe' ? { context: 'house', depth } : null;
    case 'raider':
      return closed ? { context: 'raider', depth } : null;
    default:
      return null;
  }
}

/** How likely such a container really holds a gun: shops and armouries always, homes now and then. */
export const GUN_ODDS: Partial<Record<GunStash['context'], number>> = { gun_shop: 1, police: 0.85, military: 0.9, bunker: 0.5, cache: 0.3, raider: 0.4, house: 0.1, wreck: 0.15 };

// ------------------------------------------------------------------------------------------ naming

const MK_NAME = ['', 'Common', 'Uncommon', 'Rare'];

/** What a spec is called in a toast or a prompt. */
export function specName(s: LootSpec): string {
  switch (s.kind) {
    case 'part':
      return partDef(s.id).name;
    case 'fuel':
      return `${s.fuel === 'diesel' ? 'Diesel' : 'Petrol'} can`;
    case 'oil':
      return 'Oil can';
    case 'water':
      return 'Water can';
    case 'paint':
      return 'Spray can';
    case 'rations':
      return s.amount > 1 ? `Ration tins (${s.amount})` : 'Ration tin';
    case 'medicine':
      return 'Pill bottle';
    case 'medkit':
      return 'Medkit';
    case 'bandage':
      return 'Bandage roll';
    case 'ammo':
      return `Box of 9mm rounds (${s.amount})`;
  }
}

/** The rarity of a spec, 1 to 3: parts by quality, everything else common. */
export function specRarity(s: LootSpec): number {
  if (s.kind !== 'part') return 1;
  const d = partDef(s.id);
  return d.stock ? 1 : Math.min(3, d.mk);
}

/** Part ids that exist as loot, for tests and for tables that name them. */
export const LOOT_PART_IDS = PARTS.parts.filter((p) => !p.stock && !p.empty).map((p) => p.id);
void MK_NAME;

// ------------------------------------------------------------------------------------------ in the world

/** The fields a world pickup needs to be this spec. Null for a spec that is not a loose item (gear lands as a card). */
export function pickupOf(s: LootSpec): { kind: 'part' | 'fuel' | 'oil' | 'water' | 'paint' | 'rations' | 'medicine' | 'medkit' | 'bandage' | 'ammo'; amount: number; part?: { id: string; cond: number }; fuel?: FuelType; color?: number } | null {
  switch (s.kind) {
    case 'part':
      return { kind: 'part', amount: partDef(s.id).mk, part: { id: s.id, cond: s.cond } };
    case 'fuel':
      return { kind: 'fuel', amount: s.amount, fuel: s.fuel };
    case 'paint':
      return { kind: 'paint', amount: s.charges, color: s.color };
    default:
      return { kind: s.kind, amount: s.amount };
  }
}

/** What a thing of each kind of prop counts as a host for, and how far from its middle a loose thing may lie beside it (metres). */
export const HOST_PROPS: Record<string, number> = {
  pump: 0.9,
  barrel: 0.7,
  tires: 1.3,
  crateStack: 1.6,
  container: 3.4,
  fuelTank: 5,
  dumpster: 1.7,
  tarp: 2,
  pylon: 1,
  bench: 1.3,
  bus: 6.5,
  canopy: 3,
  waterTower: 3.5,
  silo: 3.5,
  mast: 2.5,
  floodlight: 1.2,
  windpump: 1.5,
};
/** A loose thing lies within this much of the edge of its host. */
export const HOST_REACH = 2.6;
