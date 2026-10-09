import { ATTACH_LABELS, ATTACH_SLOTS, GEAR, gearDef, hasGear, type AttachSlot, type GearDef, type GunModel, type GunStats, type ModStats } from '../data/gear';
import { clamp } from '../core/math';
import type { Rng } from '../core/rng';
import { newUid } from './parts';
import type { GearItem } from './gear';

/**
 * Weapon customisation as pure rules. A gun declares its attachment slots and which add-on families fit each
 * (`GunStats.slots`); an add-on is an item in the bag (`kind: 'mod'`) that goes into one slot of one gun. What is fitted is
 * saved on the gun itself (`GearItem.att`: slot to add-on id), so it follows the weapon through every swap, hand-over and
 * save. Everything fitted is summed into a `GunKit`: the gun's own numbers with the add-ons applied, plus the handling
 * knobs the on-foot code reads (zoom, kick, sway, sight speed, muzzle velocity, flash, beam).
 */

export type Attached = Partial<Record<AttachSlot, string>>;

export const modOf = (id: string): ModStats | undefined => (hasGear(id) ? gearDef(id).mod : undefined);

/** The slots a gun has, in the order they are shown. */
export function slotsOfGun(d: GearDef): AttachSlot[] {
  const s = d.gun?.slots;
  return s ? ATTACH_SLOTS.filter((k) => !!s[k]?.length) : [];
}

/** Whether an add-on of this id goes on a gun of this id (its slot is there and takes the family). */
export function canFit(gunId: string, modId: string): boolean {
  if (!hasGear(gunId) || !hasGear(modId)) return false;
  const g = gearDef(gunId).gun;
  const m = gearDef(modId).mod;
  return !!g && !!m && !!g.slots?.[m.slot]?.includes(m.fam);
}

/** Every add-on in the catalogue that fits a gun in a slot. */
export function fittingMods(gunId: string, slot: AttachSlot): GearDef[] {
  return GEAR.items.filter((d) => d.mod?.slot === slot && canFit(gunId, d.id));
}

/** What is fitted on a gun, as definitions, in slot order. */
export function fitted(it: GearItem | null | undefined): { slot: AttachSlot; def: GearDef }[] {
  const out: { slot: AttachSlot; def: GearDef }[] = [];
  if (!it?.att) return out;
  for (const slot of ATTACH_SLOTS) {
    const id = it.att[slot];
    if (id && hasGear(id) && gearDef(id).mod) out.push({ slot, def: gearDef(id) });
  }
  return out;
}

// ------------------------------------------------------------------ the sum

export interface GunKit {
  /** The gun's own numbers with every add-on applied. */
  gun: GunStats;
  /**
   * Aim-down-sights magnification: the fitted optic's, else the gun's own scope's, else the iron sights' (`IRON_ZOOM`). A
   * red dot with no power of its own aims at the irons' zoom.
   */
  zoom: number;
  /** What the eye looks through with the sights up: the gun's iron sights, a red dot or holographic window, or a scope. */
  optic: 'iron' | 'dot' | 'scope';
  /** Which sight it is (the fitted optic's look, the built-in scope's, or 'iron'): what the eyepiece and its reticle are drawn as. */
  sight: string;
  /** Muzzle velocity, as a share of the round's. */
  vel: number;
  /** Kick and barrel wander, as shares of the model's. */
  recoil: number;
  sway: number;
  /** How fast the sights come up (the aim spring's stiffness): above 1 is quicker. */
  aimSpeed: number;
  /** Muzzle flash size. */
  flash: number;
  /** Loudness of a shot, as a share of the gun's own: what the audio and the muzzle flash are scaled by. */
  quiet: number;
  beam: 'laser' | 'torch' | 'both' | null;
  /** How many add-ons are on it. */
  count: number;
}

const SUMMED = ['dmg', 'spread', 'hip', 'ads', 'range', 'vel', 'noise', 'flash', 'recoil', 'sway', 'aimSpeed', 'mag', 'magAdd', 'reload', 'rate'] as const;

/**
 * How much the view closes in behind a gun's own iron sights. The eye settles on the front sight and what is beyond it
 * fills more of the view: a little with a handgun at arm's length, more with a long gun's sight radius at the cheek. A bow
 * aims by its own reticle, unmagnified.
 */
export const IRON_ZOOM: Record<GunModel, number> = {
  pistol: 1.35, compact: 1.35, mp: 1.35, revolver: 1.35, cannon: 1.35,
  smg: 1.4, smg2: 1.4, sawn: 1.4, coach: 1.4, pump: 1.4, combat: 1.4,
  carbine: 1.5, ar: 1.5, br: 1.5, dmr: 1.5, lmg: 1.5, lever: 1.5, crossbow: 1.5, rifle: 1.5, sniper: 1.5,
  bow: 1,
};

/** Guns that come with a scope of their own (taken off when another optic goes on the rail): its look. */
const OWN_SCOPE: Partial<Record<GunModel, string>> = { rifle: 'hunt', sniper: 'tactical' };

/** Optic families by what the eye looks through. */
const OPTIC_KIND: Record<string, GunKit['optic']> = { dot: 'dot', pdot: 'dot', scope: 'scope', long: 'scope' };

/** A gun with nothing fitted, or with the add-ons named. `att` maps slots to add-on ids. */
export function kitFor(base: GunStats, att: Attached | undefined): GunKit {
  const sum = Object.fromEntries(SUMMED.map((k) => [k, 0])) as Record<(typeof SUMMED)[number], number>;
  const iron = IRON_ZOOM[base.model] ?? 1;
  const own = OWN_SCOPE[base.model];
  let zoom = base.zoom ?? iron;
  let optic: GunKit['optic'] = own ? 'scope' : 'iron';
  let sight = own ?? 'iron';
  let beam: GunKit['beam'] = null;
  let count = 0;
  for (const slot of ATTACH_SLOTS) {
    const m = att?.[slot] ? modOf(att[slot]!) : undefined;
    if (!m || m.slot !== slot) continue;
    count++;
    for (const k of SUMMED) sum[k] += m[k] ?? 0;
    if (slot === 'optic') {
      zoom = m.zoom ?? iron;
      optic = OPTIC_KIND[m.fam] ?? 'dot';
      sight = m.look;
    }
    if (m.beam) beam = beam && beam !== m.beam ? 'both' : m.beam;
  }
  const spread = base.spread * clamp(1 + sum.spread + sum.hip, 0.3, 1.8);
  const adsSpread = Math.min(spread, base.adsSpread * clamp(1 + sum.spread + sum.ads, 0.3, 1.8));
  const quiet = clamp(1 + sum.noise, 0.08, 1.4);
  const gun: GunStats = {
    ...base,
    dmg: base.dmg * clamp(1 + sum.dmg, 0.5, 1.5),
    cd: base.cd * clamp(1 + sum.rate, 0.6, 1.5),
    mag: Math.max(1, Math.round(base.mag * (1 + sum.mag)) + sum.magAdd),
    reload: base.reload * clamp(1 + sum.reload, 0.4, 1.8),
    spread,
    adsSpread,
    range: base.range * clamp(1 + sum.range, 0.5, 1.8),
    noise: base.noise * quiet,
  };
  return {
    gun,
    zoom,
    optic,
    sight,
    vel: clamp(1 + sum.vel, 0.6, 1.5),
    recoil: clamp(1 + sum.recoil, 0.35, 1.4),
    sway: clamp(1 + sum.sway, 0.4, 1.7),
    aimSpeed: clamp(1 + sum.aimSpeed, 0.5, 1.5),
    flash: clamp(1 + sum.flash, 0.1, 1.6),
    quiet,
    beam,
    count,
  };
}

/** The kit of a gun item (a bare kit for anything that is not a gun). */
export function kitOf(it: GearItem | null | undefined): GunKit {
  const g = it ? gearDef(it.id).gun : undefined;
  return kitFor(g ?? gearDef('w_pistol').gun!, g ? it!.att : undefined);
}

/** What the kit would be with one slot changed (a preview for the customise screen): `modId` null empties the slot. */
export function kitWith(it: GearItem, slot: AttachSlot, modId: string | null): GunKit {
  const att: Attached = { ...(it.att ?? {}) };
  if (modId) att[slot] = modId;
  else delete att[slot];
  return kitFor(gearDef(it.id).gun!, att);
}

// ------------------------------------------------------------------ fitting

export type ModResult = { ok: true; note: string; old: GearItem | null } | { ok: false; reason: string };

/** Why an add-on cannot go on a gun, or null if it can. */
export function whyNot(gun: GearItem, mod: GearItem): string | null {
  const gd = gearDef(gun.id);
  const md = gearDef(mod.id);
  if (!gd.gun) return 'Only firearms take add-ons';
  if (!md.mod) return `The ${md.name} is not an add-on`;
  if (!gd.gun.slots?.[md.mod.slot]?.length) return `The ${gd.name} has no ${ATTACH_LABELS[md.mod.slot].toLowerCase()} slot`;
  if (!gd.gun.slots[md.mod.slot]!.includes(md.mod.fam)) return `The ${md.name} does not fit the ${gd.name}`;
  return null;
}

/**
 * Put an add-on on a gun. Whatever was in that slot comes back as a new item for the caller to put in the bag; the add-on
 * item itself is consumed by the caller on success. Does not touch any bag.
 */
export function fitMod(gun: GearItem, mod: GearItem): ModResult {
  const why = whyNot(gun, mod);
  if (why) return { ok: false, reason: why };
  const slot = gearDef(mod.id).mod!.slot;
  const prev = gun.att?.[slot];
  const old: GearItem | null = prev && hasGear(prev) ? { uid: newUid('g'), id: prev } : null;
  gun.att = { ...(gun.att ?? {}), [slot]: mod.id };
  return { ok: true, note: `Fitted the ${gearDef(mod.id).name} to the ${gearDef(gun.id).name}`, old };
}

/** Take what is in a slot off. The caller puts the returned item in the bag. A magazine that no longer fits is trimmed. */
export function stripMod(gun: GearItem, slot: AttachSlot): GearItem | null {
  const id = gun.att?.[slot];
  if (!id) return null;
  const rest: Attached = { ...gun.att };
  delete rest[slot];
  if (Object.keys(rest).length) gun.att = rest;
  else delete gun.att;
  if (gun.mag !== undefined) gun.mag = Math.min(gun.mag, kitOf(gun).gun.mag);
  return hasGear(id) ? { uid: newUid('g'), id } : null;
}

/** The loaded rounds a gun carries over its capacity, which are returned to the stock when a big magazine comes off. */
export const roundsOver = (gun: GearItem, before: number) => Math.max(0, before - (gun.mag ?? 0));

/** The picture key of everything fitted, for caching a model: slot and look, in slot order. Empty for a bare gun. */
export function lookKey(att: Attached | undefined): string {
  const parts: string[] = [];
  for (const slot of ATTACH_SLOTS) {
    const m = att?.[slot] ? modOf(att[slot]!) : undefined;
    if (m && m.slot === slot) parts.push(`${slot}:${m.look}`);
  }
  return parts.join('|');
}

/** Read the key back into slot to look pairs. */
export function parseLooks(key: string): Partial<Record<AttachSlot, string>> {
  const out: Partial<Record<AttachSlot, string>> = {};
  for (const part of key ? key.split('|') : []) {
    const [slot, look] = part.split(':');
    if (ATTACH_SLOTS.includes(slot as AttachSlot) && look) out[slot as AttachSlot] = look;
  }
  return out;
}

// ------------------------------------------------------------------ saving

/** Keep only add-ons that exist, sit in their own slot and fit this gun. Anything else goes to `stray` (as a bag item), so nothing is lost to a rule change. */
export function cleanAtt(gunId: string, raw: unknown, stray: GearItem[]): Attached | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !gearDef(gunId).gun) return undefined;
  const out: Attached = {};
  for (const slot of ATTACH_SLOTS) {
    const id = (raw as Record<string, unknown>)[slot];
    if (typeof id !== 'string' || !hasGear(id) || !gearDef(id).mod) continue;
    if (gearDef(id).mod!.slot === slot && canFit(gunId, id)) out[slot] = id;
    else stray.push({ uid: newUid('g'), id });
  }
  return Object.keys(out).length ? out : undefined;
}

// ------------------------------------------------------------------ words

export interface KitLine {
  key: string;
  text: string;
  /** Whether the change is good news, for colouring. */
  good: boolean;
}

/** One add-on's own effects, in plain words. */
export function describeMod(m: ModStats): KitLine[] {
  const out: KitLine[] = [];
  const pct = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`;
  const add = (key: string, v: number | undefined, label: string, lowerBetter: boolean) => {
    if (!v) return;
    out.push({ key, text: `${pct(v)} ${label}`, good: lowerBetter ? v < 0 : v > 0 });
  };
  if (m.zoom !== undefined && m.zoom > 1) out.push({ key: 'zoom', text: `${m.zoom.toFixed(1)}x zoom`, good: true });
  add('dmg', m.dmg, 'damage', false);
  add('spread', m.spread, 'spread', true);
  add('hip', m.hip, 'hip-fire spread', true);
  add('ads', m.ads, 'aimed spread', true);
  add('range', m.range, 'range', false);
  add('vel', m.vel, 'bullet speed', false);
  add('noise', m.noise, 'shot noise', true);
  add('recoil', m.recoil, 'kick', true);
  add('sway', m.sway, 'sway', true);
  add('aimSpeed', m.aimSpeed, 'aim speed', false);
  add('mag', m.mag, 'magazine', false);
  if (m.magAdd) out.push({ key: 'magAdd', text: `${m.magAdd > 0 ? '+' : ''}${m.magAdd} rounds`, good: m.magAdd > 0 });
  add('reload', m.reload, 'reload time', true);
  add('rate', m.rate, 'time between shots', true);
  if (m.flash) out.push({ key: 'flash', text: `${pct(m.flash)} muzzle flash`, good: m.flash < 0 });
  if (m.beam) out.push({ key: 'beam', text: m.beam === 'laser' ? 'Laser dot' : m.beam === 'torch' ? 'Torch' : 'Laser dot and torch', good: true });
  return out;
}

/** What a change of kit does, stat by stat: the numbers a player decides on. Only what moved is listed. */
export function compareKits(a: GunKit, b: GunKit): KitLine[] {
  const out: KitLine[] = [];
  const rel = (key: string, label: string, x: number, y: number, lowerBetter: boolean, min = 0.005) => {
    if (x <= 0) return;
    const d = y / x - 1;
    if (Math.abs(d) < min) return;
    const p = Math.round(d * 100);
    out.push({ key, text: `${p > 0 ? '+' : ''}${p}% ${label}`, good: lowerBetter ? d < 0 : d > 0 });
  };
  if (Math.abs(b.zoom - a.zoom) > 0.01) out.push({ key: 'zoom', text: `${b.zoom.toFixed(1)}x zoom (was ${a.zoom.toFixed(1)}x)`, good: b.zoom > a.zoom });
  rel('dmg', 'damage', a.gun.dmg, b.gun.dmg, false);
  rel('spread', 'hip-fire spread', a.gun.spread, b.gun.spread, true);
  rel('ads', 'aimed spread', a.gun.adsSpread, b.gun.adsSpread, true);
  rel('range', 'range', a.gun.range, b.gun.range, false);
  rel('vel', 'bullet speed', a.vel, b.vel, false);
  rel('noise', 'shot noise', a.gun.noise, b.gun.noise, true);
  rel('recoil', 'kick', a.recoil, b.recoil, true);
  rel('sway', 'sway', a.sway, b.sway, true);
  rel('aimSpeed', 'aim speed', a.aimSpeed, b.aimSpeed, false);
  if (b.gun.mag !== a.gun.mag) out.push({ key: 'mag', text: `${b.gun.mag} round magazine (was ${a.gun.mag})`, good: b.gun.mag > a.gun.mag });
  rel('reload', 'reload time', a.gun.reload, b.gun.reload, true);
  rel('rate', 'time between shots', a.gun.cd, b.gun.cd, true);
  rel('flash', 'muzzle flash', a.flash, b.flash, true);
  if (b.beam !== a.beam) out.push({ key: 'beam', text: b.beam ? (b.beam === 'laser' ? 'Laser dot' : b.beam === 'torch' ? 'Torch' : 'Laser dot and torch') : 'No light on the rail', good: !!b.beam });
  return out;
}

// ------------------------------------------------------------------ loot: dressing a gun

/** How likely each slot is to hold something on a gun found in the wild, before the source's own odds. */
const SLOT_ODDS: Record<AttachSlot, number> = { optic: 0.5, muzzle: 0.3, barrel: 0.12, under: 0.22, mag: 0.35, stock: 0.2, rail: 0.15 };

export interface DressOpts {
  /** Multiplies every slot's odds: 0 leaves the gun bare, above 1 fills it. */
  odds: number;
  /** The rarest add-on it may carry. */
  maxR: number;
  /** The most add-ons it may carry. */
  most?: number;
  /** Weight multipliers by family, to flavour a source (a police rack runs to lights and red dots). Others weigh 1. */
  fam?: Record<string, number>;
}

/** Pick one fitting add-on for a slot, weighted by the catalogue's weights and the source's flavour. */
export function rollFitting(rng: Rng, gunId: string, slot: AttachSlot, maxR: number, fam?: Record<string, number>, minR = 1): GearDef | null {
  const pool = fittingMods(gunId, slot).filter((d) => d.rarity <= maxR && d.rarity >= minR);
  if (!pool.length) return null;
  const w = pool.map((d) => d.weight * (fam?.[d.mod!.fam] ?? 1));
  const total = w.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  let r = rng.next() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= w[i];
    if (r <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

/**
 * Fit a found gun with plausible add-ons: each slot is tried in turn against its odds, up to a limit. The magazine is topped up
 * for a big one. Draws from `rng`, so a seeded caller always dresses the same gun the same way.
 */
export function dressGun(it: GearItem, rng: Rng, o: DressOpts): GearItem {
  const d = gearDef(it.id);
  if (!d.gun) return it;
  const att: Attached = {};
  let n = 0;
  for (const slot of slotsOfGun(d)) {
    const hit = rng.chance(Math.min(0.95, SLOT_ODDS[slot] * o.odds));
    if (!hit || n >= (o.most ?? 3)) continue;
    const m = rollFitting(rng, it.id, slot, o.maxR, o.fam);
    if (!m) continue;
    att[slot] = m.id;
    n++;
  }
  if (n) {
    it.att = att;
    if (it.mag !== undefined) it.mag = kitOf(it).gun.mag;
  }
  return it;
}

/** A loose add-on as a bag item. */
export function newMod(id: string): GearItem {
  return { uid: newUid('g'), id };
}
