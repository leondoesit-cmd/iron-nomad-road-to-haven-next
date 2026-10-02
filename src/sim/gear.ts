import {
  GEAR,
  STAT_KEYS,
  WEAR_SLOTS,
  gearDef,
  hasGear,
  type GearDef,
  type GearKind,
  type GearStats,
  type GunStats,
  type MeleeStats,
  type WearSlot,
} from '../data/gear';
import { clamp } from '../core/math';
import type { Rng } from '../core/rng';
import { newUid } from './parts';

/**
 * A person's kit, as pure data: what is worn, what is on the belt, and what is in the bag.
 * Everything here is deterministic and free of engine imports, so it can be tested and saved as-is.
 */
export interface GearItem {
  uid: string;
  id: string;
  /** Rounds in the magazine, for guns. Travels with the gun when it is swapped, dropped or handed over. */
  mag?: number;
}

export interface Loadout {
  worn: Partial<Record<WearSlot, GearItem>>;
  /** Hand slots, `GEAR.beltSize` of them. */
  belt: (GearItem | null)[];
  /** The hand in use: a belt index, or `UTILITY_SLOT` for the throwable (flare, molotov, charge, horn). */
  sel: number;
  bag: GearItem[];
}

export const BELT_SIZE = GEAR.beltSize;
/** The selection that means "the utility in hand", one past the last belt slot. */
export const UTILITY_SLOT = BELT_SIZE;

/** What a fresh scavenger carries in the bag, so there is something to try on and swap from the first minute. */
export const STARTER_BAG = ['h_cap', 'f_goggles', 'm_knife'];
const STARTER_BELT = ['w_pistol', 't_wrench', 't_crowbar', 't_jerrycan'];

export function newGear(id: string): GearItem {
  const d = gearDef(id);
  const it: GearItem = { uid: newUid('g'), id };
  if (d.gun) it.mag = d.gun.mag;
  return it;
}

/**
 * The kit every run starts in. It looks exactly like the survivor always did and plays almost the same: a pistol, the
 * three tools, and starter clothes that add up to a few percent of armour, a bandana's worth of spore guard and a bit of punch.
 */
export function starterLoadout(): Loadout {
  const worn: Loadout['worn'] = {};
  for (const slot of WEAR_SLOTS) {
    const d = GEAR.items.find((g) => g.starter && g.slot === slot);
    if (d) worn[slot] = newGear(d.id);
  }
  const belt: Loadout['belt'] = Array.from({ length: BELT_SIZE }, (_, i) => (STARTER_BELT[i] ? newGear(STARTER_BELT[i]) : null));
  return { worn, belt, sel: 0, bag: STARTER_BAG.map(newGear) };
}

// ------------------------------------------------------------------ lookup

export type Spot = { zone: 'worn'; slot: WearSlot } | { zone: 'belt'; i: number } | { zone: 'bag'; i: number };

export function itemAt(l: Loadout, s: Spot): GearItem | null {
  return s.zone === 'worn' ? (l.worn[s.slot] ?? null) : s.zone === 'belt' ? (l.belt[s.i] ?? null) : (l.bag[s.i] ?? null);
}

export function findItem(l: Loadout, uid: string): Spot | null {
  for (const slot of WEAR_SLOTS) if (l.worn[slot]?.uid === uid) return { zone: 'worn', slot };
  const b = l.belt.findIndex((x) => x?.uid === uid);
  if (b >= 0) return { zone: 'belt', i: b };
  const g = l.bag.findIndex((x) => x.uid === uid);
  return g >= 0 ? { zone: 'bag', i: g } : null;
}

export function allItems(l: Loadout): GearItem[] {
  const out: GearItem[] = [];
  for (const slot of WEAR_SLOTS) if (l.worn[slot]) out.push(l.worn[slot]!);
  for (const b of l.belt) if (b) out.push(b);
  return out.concat(l.bag);
}

/** What is in the hand right now, or null when the utility slot is selected (or the slot is empty). */
export function heldItem(l: Loadout): GearItem | null {
  return l.sel < BELT_SIZE ? (l.belt[l.sel] ?? null) : null;
}

export const isWeapon = (d: GearDef) => d.kind === 'gun' || d.kind === 'melee';

// ------------------------------------------------------------------ capacity and stats

function wornBag(worn: Loadout['worn']): number {
  let n = 0;
  for (const slot of WEAR_SLOTS) {
    const it = worn[slot];
    if (it) n += gearDef(it.id).stats?.bag ?? 0;
  }
  return n;
}

/** Bag slots: the base, plus whatever the pack, pockets and vest add. */
export function bagCap(l: Loadout): number {
  return GEAR.bagBase + wornBag(l.worn);
}

export function bagRoom(l: Loadout): number {
  return Math.max(0, bagCap(l) - l.bag.length);
}

/** Every stat, resolved: the sum over what is worn, held to sane limits. */
export type Resolved = Record<keyof GearStats, number>;

export function statsOf(l: Loadout): Resolved {
  const r = Object.fromEntries(STAT_KEYS.map((k) => [k, 0])) as Resolved;
  for (const slot of WEAR_SLOTS) {
    const it = l.worn[slot];
    const st = it ? gearDef(it.id).stats : undefined;
    if (st) for (const k of STAT_KEYS) r[k] += st[k] ?? 0;
  }
  const c = GEAR.caps;
  r.armor = clamp(r.armor, 0, c.armor);
  r.spore = clamp(r.spore, 0, c.spore);
  r.fall = clamp(r.fall, 0, c.fall);
  r.speed = clamp(r.speed, c.speedLo, c.speedHi);
  r.noise = clamp(r.noise, c.noiseLo, c.noiseHi);
  r.reload = clamp(r.reload, -0.5, 0.5);
  r.steady = clamp(r.steady, -0.5, 0.5);
  r.melee = clamp(r.melee, -0.5, 1);
  return r;
}

export type HurtKind = 'bullet' | 'melee' | 'blast' | 'fall' | 'fire' | 'bite' | 'spore' | 'ram';

/** The share of a hit that gets through. Armour stops blows and blasts; boots and knees take falls; masks take spores. */
export function damageTaken(r: Pick<Resolved, 'armor' | 'spore' | 'fall'>, kind: HurtKind): number {
  switch (kind) {
    case 'spore':
      return 1 - r.spore;
    case 'fall':
      return 1 - r.fall;
    case 'fire':
      return 1;
    default:
      return 1 - r.armor;
  }
}

/** A gun's numbers once the wearer's gloves and goggles have had their say. */
export interface EffectiveGun extends GunStats {
  pellets: number;
  pierce: number;
}
export function effectiveGun(g: GunStats, r: Pick<Resolved, 'reload' | 'steady'>): EffectiveGun {
  return {
    ...g,
    pellets: g.pellets ?? 1,
    pierce: g.pierce ?? 0,
    reload: g.reload * (1 + r.reload),
    spread: g.spread * (1 + r.steady),
    adsSpread: g.adsSpread * (1 + r.steady),
  };
}

/** What a swing does with nothing better in hand: a rifle butt and a bad temper. */
export const FISTS: MeleeStats = { dmg: 35, cd: 0.55, reach: 1.9, noise: 12, model: 'bat' };

export function effectiveMelee(m: MeleeStats | null | undefined, r: Pick<Resolved, 'melee'>): MeleeStats {
  const base = m ?? FISTS;
  return { ...base, dmg: base.dmg * (1 + r.melee) };
}

// ------------------------------------------------------------------ changing the loadout

export type Result = { ok: true; note: string } | { ok: false; reason: string };
const ok = (note: string): Result => ({ ok: true, note });
const no = (reason: string): Result => ({ ok: false, reason });

/** Bag capacity if `slot` held `next` instead of what it holds now. */
function capIf(l: Loadout, slot: WearSlot, next: GearItem | null): number {
  const worn = { ...l.worn };
  if (next) worn[slot] = next;
  else delete worn[slot];
  return GEAR.bagBase + wornBag(worn);
}

/** True when the belt would still have something to fight with after taking `skip` off it. */
function armedWithout(l: Loadout, skip: number): boolean {
  return l.belt.some((b, i) => i !== skip && b && isWeapon(gearDef(b.id)));
}

/** Pick a sensible selection after the slot in hand was emptied. */
function settleSel(l: Loadout) {
  if (l.sel === UTILITY_SLOT || l.belt[l.sel]) return;
  const i = l.belt.findIndex((b) => !!b);
  l.sel = i >= 0 ? i : UTILITY_SLOT;
}

/**
 * Put something from the bag onto the body or the belt. A worn item swaps with whatever is in that slot and the old
 * one takes its place in the bag. Hand items go to `beltSlot`, else the first empty slot, else the slot in hand.
 */
export function equipFromBag(l: Loadout, uid: string, beltSlot?: number): Result {
  const i = l.bag.findIndex((b) => b.uid === uid);
  if (i < 0) return no('That is not in your bag');
  const item = l.bag[i];
  const d = gearDef(item.id);
  if (d.kind === 'wear') {
    const slot = d.slot!;
    const old = l.worn[slot] ?? null;
    const after = l.bag.length - (old ? 0 : 1);
    if (after > capIf(l, slot, item)) return no(`Your bag is too full to swap out the ${old ? gearDef(old.id).name.toLowerCase() : 'pack'}: empty it first`);
    l.bag.splice(i, 1);
    if (old) l.bag.splice(i, 0, old);
    l.worn[slot] = item;
    return ok(`Wearing the ${d.name}`);
  }
  let target = beltSlot ?? l.belt.findIndex((b) => !b);
  if (target < 0) target = l.sel < BELT_SIZE ? l.sel : 0;
  if (target < 0 || target >= BELT_SIZE) return no('No such belt slot');
  const old = l.belt[target];
  l.bag.splice(i, 1);
  if (old) l.bag.splice(i, 0, old);
  l.belt[target] = item;
  l.sel = target;
  return ok(`${d.name} in hand`);
}

/** Take a worn item off into the bag. Refused when the bag is full, or when its pockets are holding the bag's contents. */
export function unequipWorn(l: Loadout, slot: WearSlot): Result {
  const it = l.worn[slot];
  if (!it) return no('Nothing there');
  if (l.bag.length + 1 > capIf(l, slot, null)) return no('Your bag has no room for that');
  delete l.worn[slot];
  l.bag.push(it);
  return ok(`Took off the ${gearDef(it.id).name}`);
}

/** Stow a belt item in the bag. The belt must keep a weapon. */
export function unequipBelt(l: Loadout, i: number): Result {
  const it = l.belt[i];
  if (!it) return no('Nothing there');
  if (l.bag.length >= bagCap(l)) return no('Your bag has no room for that');
  if (isWeapon(gearDef(it.id)) && !armedWithout(l, i)) return no('Keep a weapon on your belt');
  l.belt[i] = null;
  l.bag.push(it);
  settleSel(l);
  return ok(`Stowed the ${gearDef(it.id).name}`);
}

/** Swap two belt slots. */
export function moveBelt(l: Loadout, from: number, to: number): Result {
  if (from === to || from < 0 || to < 0 || from >= BELT_SIZE || to >= BELT_SIZE) return no('Nothing to move');
  const a = l.belt[from];
  l.belt[from] = l.belt[to];
  l.belt[to] = a;
  if (l.sel === from) l.sel = to;
  else if (l.sel === to) l.sel = from;
  return ok('Moved');
}

/** Take an item out of the bag for good (scrapped, or handed on). */
export function takeFromBag(l: Loadout, uid: string): GearItem | null {
  const i = l.bag.findIndex((b) => b.uid === uid);
  return i < 0 ? null : l.bag.splice(i, 1)[0];
}

/** Put something in the bag if there is room. */
export function addToBag(l: Loadout, item: GearItem): boolean {
  if (l.bag.length >= bagCap(l)) return false;
  l.bag.push(item);
  return true;
}

/** Hand a bag item to another person's bag. */
export function giveItem(from: Loadout, to: Loadout, uid: string): Result {
  const it = from.bag.find((b) => b.uid === uid);
  if (!it) return no('That is not in your bag');
  if (to.bag.length >= bagCap(to)) return no('Their bag is full');
  takeFromBag(from, uid);
  to.bag.push(it);
  return ok(`Handed over the ${gearDef(it.id).name}`);
}

/** Next hand slot in a direction, skipping empty ones. The utility slot counts only when `utilityOk`. */
export function stepSel(l: Loadout, dir: 1 | -1, utilityOk: boolean): number {
  const n = BELT_SIZE + 1;
  let i = l.sel;
  for (let k = 0; k < n; k++) {
    i = (i + dir + n) % n;
    if (i === UTILITY_SLOT ? utilityOk : !!l.belt[i]) return i;
  }
  return l.sel;
}

/** Slots whose items can be taken off for scrap, and what that is worth. */
export function scrapOf(it: GearItem): number {
  return gearDef(it.id).scrap;
}

// ------------------------------------------------------------------ saving

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';

function cleanItem(raw: unknown, seen: Set<string>): GearItem | null {
  if (!isObj(raw) || typeof raw.id !== 'string' || !hasGear(raw.id)) return null;
  const d = gearDef(raw.id);
  let uid = typeof raw.uid === 'string' && raw.uid ? raw.uid : '';
  if (!uid || seen.has(uid)) uid = newUid('g');
  seen.add(uid);
  const it: GearItem = { uid, id: raw.id };
  if (d.gun) it.mag = typeof raw.mag === 'number' && Number.isFinite(raw.mag) ? clamp(Math.round(raw.mag), 0, d.gun.mag) : d.gun.mag;
  return it;
}

/**
 * Read a saved loadout defensively: drop unknown items, put things back where they belong, and guarantee a weapon.
 * A save from before gear existed (or nothing at all) gets the starter kit.
 */
export function sanitizeLoadout(raw: unknown): Loadout {
  if (!isObj(raw) || Array.isArray(raw) || !('worn' in raw || 'belt' in raw || 'bag' in raw)) return starterLoadout();
  const seen = new Set<string>();
  const l: Loadout = { worn: {}, belt: Array.from({ length: BELT_SIZE }, () => null), sel: 0, bag: [] };
  const w = isObj(raw.worn) ? raw.worn : {};
  for (const slot of WEAR_SLOTS) {
    const it = cleanItem(w[slot], seen);
    if (!it) continue;
    const d = gearDef(it.id);
    if (d.kind === 'wear' && d.slot === slot) l.worn[slot] = it;
    else l.bag.push(it);
  }
  const strays: GearItem[] = [];
  const belt = Array.isArray(raw.belt) ? raw.belt : [];
  for (let i = 0; i < BELT_SIZE; i++) {
    const it = cleanItem(belt[i], seen);
    if (!it) continue;
    if (gearDef(it.id).kind === 'wear') strays.push(it);
    else l.belt[i] = it;
  }
  for (const b of Array.isArray(raw.bag) ? raw.bag : []) {
    const it = cleanItem(b, seen);
    if (it) l.bag.push(it);
  }
  l.bag.push(...strays);
  // Never leave somebody unarmed: pull a weapon off the bag, or hand out the starter pistol.
  if (!l.belt.some((b) => b && isWeapon(gearDef(b.id)))) {
    const spare = l.bag.findIndex((b) => isWeapon(gearDef(b.id)));
    const it = spare >= 0 ? l.bag.splice(spare, 1)[0] : newGear('w_pistol');
    const free = l.belt.findIndex((b) => !b);
    const at = free >= 0 ? free : BELT_SIZE - 1;
    const bumped = l.belt[at];
    l.belt[at] = it;
    if (bumped) l.bag.push(bumped);
  }
  const sel = typeof raw.sel === 'number' && Number.isInteger(raw.sel) ? raw.sel : 0;
  l.sel = clamp(sel, 0, UTILITY_SLOT);
  settleSel(l);
  return l;
}

// ------------------------------------------------------------------ words

export const STAT_LABELS: Record<keyof GearStats, string> = {
  armor: 'Armour',
  spore: 'Spore guard',
  fall: 'Fall protection',
  speed: 'Move speed',
  noise: 'Footstep noise',
  bag: 'Bag slots',
  reload: 'Reload time',
  melee: 'Melee damage',
  steady: 'Gun spread',
};

/** For these a smaller number is the better one. */
const LOWER_IS_BETTER = new Set<keyof GearStats>(['noise', 'reload', 'steady']);

export interface StatLine {
  key: keyof GearStats;
  text: string;
  /** Whether the change is good news, for colouring. */
  good: boolean;
}

function statText(k: keyof GearStats, v: number): string {
  if (k === 'bag') return `${v > 0 ? '+' : ''}${v} bag slots`;
  const p = Math.round(v * 100);
  return `${p > 0 ? '+' : ''}${p}% ${STAT_LABELS[k].toLowerCase()}`;
}

/** A wearable's effects in plain words, one line per stat. */
export function describeStats(st: GearStats | undefined): StatLine[] {
  const out: StatLine[] = [];
  for (const k of STAT_KEYS) {
    const v = st?.[k];
    if (!v) continue;
    out.push({ key: k, text: statText(k, v), good: LOWER_IS_BETTER.has(k) ? v < 0 : v > 0 });
  }
  return out;
}

/** What swapping `to` in for `from` changes, per stat: the gain is `to` minus `from`. */
export function compareStats(from: GearDef | null, to: GearDef | null): StatLine[] {
  const out: StatLine[] = [];
  for (const k of STAT_KEYS) {
    const d = (to?.stats?.[k] ?? 0) - (from?.stats?.[k] ?? 0);
    if (Math.abs(d) < 1e-9) continue;
    out.push({ key: k, text: statText(k, d), good: LOWER_IS_BETTER.has(k) ? d < 0 : d > 0 });
  }
  return out;
}

/** A weapon's headline numbers. */
export function describeWeapon(d: GearDef): string[] {
  if (d.gun) {
    const g = d.gun;
    const per = g.pellets && g.pellets > 1 ? `${g.dmg} × ${g.pellets}` : `${g.dmg}`;
    return [`${per} damage`, `${(1 / g.cd).toFixed(1)} shots/s`, `${g.mag} rounds · ${g.reload.toFixed(1)}s reload`, `${g.range} m range`];
  }
  if (d.melee) return [`${d.melee.dmg} damage`, `${(1 / d.melee.cd).toFixed(1)} swings/s`, `${d.melee.reach.toFixed(1)} m reach`];
  return [];
}

// ------------------------------------------------------------------ loot

export interface GearRoll {
  minR?: number;
  maxR?: number;
  /** Each point multiplies the weight of rarity n by (1 + bias × (n − 1)). */
  bias?: number;
  kinds?: GearKind[];
  slots?: WearSlot[];
  /** Items with one of these tags are three times as likely. */
  tags?: string[];
}

export function rollGearId(rng: Rng, o: GearRoll = {}): string {
  const pool = GEAR.items.filter((g) => g.rarity >= (o.minR ?? 1) && g.rarity <= (o.maxR ?? 3) && (!o.kinds || o.kinds.includes(g.kind)) && (!o.slots || (g.slot && o.slots.includes(g.slot))));
  const list = pool.length ? pool : GEAR.items;
  const w = list.map((g) => g.weight * (1 + (o.bias ?? 0) * (g.rarity - 1)) * (o.tags?.some((t) => g.tags?.includes(t)) ? 3 : 1));
  const total = w.reduce((a, b) => a + b, 0);
  let r = rng.next() * total;
  for (let i = 0; i < list.length; i++) {
    r -= w[i];
    if (r <= 0) return list[i].id;
  }
  return list[list.length - 1].id;
}

export function rollGear(rng: Rng, o: GearRoll = {}): GearItem {
  return newGear(rollGearId(rng, o));
}

/** Where a find came from. Each source has its own odds. */
export type GearSource = 'search' | 'chest' | 'hoard' | 'trunk' | 'raider' | 'wreck';

export interface DropCtx {
  /** Searched shelf depth: 0 loose, 1 cupboard, 2 safe or locker. */
  depth?: number;
  /** Delve tier, 1 to 3. */
  tier?: number;
  /** How far the campaign has come, 0 to 1: later finds skew better. */
  progress?: number;
  /** Biome flavour: 'city' or 'waste'. */
  biome?: string;
}

/**
 * Whether a source yields a piece of gear this time, and which. Seeded by the caller from something that never
 * changes (a container's id), so reloading a chunk cannot reroll a find.
 */
export function gearDrop(rng: Rng, src: GearSource, c: DropCtx = {}): GearItem | null {
  const depth = c.depth ?? 0;
  const tier = c.tier ?? 1;
  const prog = clamp(c.progress ?? 0, 0, 1);
  const tags = [c.biome ?? ''].filter(Boolean);
  switch (src) {
    case 'search':
      if (!rng.chance([0.05, 0.1, 0.2][clamp(depth, 0, 2)] * (1 + prog * 0.5))) return null;
      return rollGear(rng, { maxR: depth >= 2 ? 3 : 2, bias: prog, tags });
    case 'chest':
      if (!rng.chance(0.6)) return null;
      return rollGear(rng, { maxR: tier >= 2 ? 3 : 2, bias: 0.5 + prog, tags: ['vault', ...tags] });
    case 'hoard':
      return rollGear(rng, { minR: 2, bias: 1.2 + prog, tags: ['vault'] });
    case 'trunk':
      return rng.chance(0.07 + prog * 0.05) ? rollGear(rng, { maxR: 2, bias: prog, tags }) : null;
    case 'raider':
      return rng.chance(0.1 + prog * 0.06) ? rollGear(rng, { maxR: 2, bias: 0.3 + prog, tags: ['raider'] }) : null;
    case 'wreck':
      return rng.chance(0.6) ? rollGear(rng, { minR: 2, bias: 0.5 + prog, tags: ['raider'] }) : null;
  }
}
