import { GEAR, gearDef } from '../data/gear';
import { Rng, hashString } from '../core/rng';
import { clamp } from '../core/math';
import { newGear, type GearItem } from './gear';
import { dressGun, newMod } from './gunmods';
import { foundCondition } from './vitals';

/**
 * Where the guns are. `rollGunLoot` is a seeded loot table keyed by a CONTEXT (the kind of place or person the loot belongs
 * to), so world placement can hang an arsenal on a gun shop, a police locker, a soldier's footlocker, a farmhouse drawer or a
 * raider's body without knowing anything about the catalogue:
 *
 *   rollGunLoot(context, seed, depth) -> GearItem[]
 *
 *   gun_shop  racks of civilian guns (pistols, hunting and lever rifles, shotguns, a crossbow) and a counter of add-ons: sights,
 *             scopes, magazines, chokes. Depth 0 the shop floor, 1 the back room, 2 the safe (more, better, rarer).
 *   police    sidearms, SMGs, pump and combat shotguns, with lights, lasers and red dots; the odd suppressor.
 *   military  assault and battle rifles, LMGs, marksman and sniper rifles, with scopes, suppressors, grips, drums.
 *   house     usually nothing; now and then a pistol, a shotgun, a hunting rifle or a blade. Never a scope.
 *   raider    one or two weapons off a body: scrap SMGs, machine pistols, shotguns, a carbine; a worn magazine or a laser.
 *   wreck     a car or a wreck's glovebox: a pistol, a sawn-off, a rifle, a crossbow, a loose add-on.
 *   bunker    the good stuff: sniper, marksman, LMG, hand cannon, combat shotgun, and rare add-ons.
 *   cache     a mixed hoard, add-ons heavy.
 *
 * `seed` is any number (a container id hashed, a chunk seed): the same seed, context and depth give the same items every time,
 * so reloading cannot reroll them. Only the `uid`s differ between calls (they are unique per save and drawn from a counter);
 * everything else, the ids, the add-ons fitted, the magazines and the wear, is a pure function of the arguments. Guns come
 * already dressed with plausible add-ons and worn as found. The caller decides what to do with the items (put them in a
 * container, on the ground, in a bag).
 */

export type GunLootContext = 'gun_shop' | 'police' | 'military' | 'house' | 'raider' | 'wreck' | 'bunker' | 'cache';
export const GUN_LOOT_CONTEXTS: GunLootContext[] = ['gun_shop', 'police', 'military', 'house', 'raider', 'wreck', 'bunker', 'cache'];

interface Table {
  /** Chance there is anything at all, by depth 0, 1, 2. */
  any: [number, number, number];
  /** Weapons that can turn up, by id, with weights. */
  weapons: Record<string, number>;
  /** How many weapons: [min, max] at depth 0, and extra maximum per depth. */
  guns: [number, number];
  gunsPerDepth: number;
  /** How worn the weapons are found, 0 as new to 1 anywhere from new to worn out: the lower, the better kept. */
  wear: number;
  /** Loose add-ons in the pile: [min, max] at depth 0 and the extra maximum per depth, and the rarest allowed by depth. */
  mods: [number, number];
  modsPerDepth: number;
  modR: [number, number, number];
  /** Weights for the families of loose add-ons. A family not listed never turns up loose. */
  fam: Record<string, number>;
  /** How well the weapons are dressed (see `dressGun`) and the rarest add-on on them, by depth. */
  dress: number;
  dressR: [number, number, number];
}

const TABLES: Record<GunLootContext, Table> = {
  gun_shop: {
    any: [1, 1, 1],
    weapons: { w_pistol: 5, w_compact: 5, w_revolver: 4, w_cannon: 0.8, w_pump: 3, w_sawn: 1, w_coach: 3, w_combat: 0.8, w_rifle: 4, w_lever: 4, w_carbine: 1.2, w_crossbow: 3, w_bow: 2.5, w_smg2: 0.8, w_dmr: 0.4, m_knife: 2, m_machete: 1 },
    guns: [2, 3],
    gunsPerDepth: 1,
    wear: 0.15,
    mods: [2, 4],
    modsPerDepth: 1,
    modR: [2, 2, 3],
    fam: { dot: 4, pdot: 4, scope: 4, long: 1, sup_h: 1, comp: 2, brake: 1.5, choke: 3, mag_h: 3, mag_s: 1, mag_r: 2, mag_b: 2, loader: 3, tube: 2, saddle: 3, mag_x: 1.5, butt: 3, grip: 2, bipod: 1, rail: 3, bar_h: 1, bar_r: 1, bar_g: 1.5, bar_x: 1 },
    dress: 0.35,
    dressR: [1, 2, 2],
  },
  police: {
    any: [0.9, 1, 1],
    weapons: { w_pistol: 6, w_compact: 4, w_revolver: 2, w_smg2: 3.5, w_pump: 4, w_combat: 1.2, w_carbine: 1, w_ar: 0.4 },
    guns: [1, 2],
    gunsPerDepth: 1,
    wear: 0.25,
    mods: [0, 2],
    modsPerDepth: 1,
    modR: [1, 2, 2],
    fam: { rail: 5, dot: 3, pdot: 3, sup_h: 1, comp: 1, mag_h: 3, mag_s: 2, grip: 2, tube: 1, saddle: 2, stock_p: 1 },
    dress: 0.7,
    dressR: [1, 2, 2],
  },
  military: {
    any: [1, 1, 1],
    weapons: { w_ar: 6, w_br: 3, w_lmg: 2, w_dmr: 2, w_sniper: 1, w_smg2: 2, w_combat: 2, w_carbine: 2, w_pistol: 3, w_compact: 1 },
    guns: [2, 3],
    gunsPerDepth: 1,
    wear: 0.15,
    mods: [1, 3],
    modsPerDepth: 1,
    modR: [2, 3, 3],
    fam: { scope: 4, long: 2, dot: 3, sup_r: 2.5, sup_h: 1.5, brake: 2, grip: 3, bipod: 2, mag_r: 3, mag_s: 1, stock_l: 2, rail: 2, bar_r: 1, bar_c: 1 },
    dress: 1,
    dressR: [2, 3, 3],
  },
  house: {
    any: [0.22, 0.34, 0.5],
    weapons: { w_pistol: 6, w_compact: 4, w_revolver: 3, w_sawn: 2.5, w_coach: 2, w_pump: 1.2, w_rifle: 2.2, w_lever: 1.6, w_crossbow: 1, w_bow: 1.4, m_knife: 4, m_bat: 3, m_pipe: 3, m_machete: 1, m_katana: 0.15 },
    guns: [1, 1],
    gunsPerDepth: 1,
    wear: 0.5,
    mods: [0, 0],
    modsPerDepth: 0,
    modR: [1, 1, 1],
    fam: {},
    dress: 0.1,
    dressR: [1, 1, 1],
  },
  raider: {
    any: [0.35, 0.5, 0.6],
    weapons: { w_mp: 4, w_smg: 3, w_revolver: 3, w_sawn: 3, w_pistol: 3, w_carbine: 2, w_coach: 1, w_lever: 1, w_bow: 1.5, w_ar: 0.7, w_cannon: 0.5, m_machete: 2, m_pipe: 2, m_axe: 0.8 },
    guns: [1, 1],
    gunsPerDepth: 1,
    wear: 0.6,
    mods: [0, 1],
    modsPerDepth: 0,
    modR: [1, 2, 2],
    fam: { mag_h: 2, mag_s: 2, mag_r: 1, rail: 2, comp: 1, saddle: 1, loader: 1, butt: 1 },
    dress: 0.5,
    dressR: [1, 2, 2],
  },
  wreck: {
    any: [0.4, 0.55, 0.7],
    weapons: { w_pistol: 4, w_compact: 3, w_sawn: 2, w_smg: 2, w_mp: 2, w_rifle: 1.2, w_lever: 1, w_carbine: 1, w_crossbow: 1, w_bow: 0.6, w_revolver: 2, m_pipe: 2, m_bat: 2, m_knife: 2 },
    guns: [1, 1],
    gunsPerDepth: 1,
    wear: 0.7,
    mods: [0, 1],
    modsPerDepth: 1,
    modR: [1, 2, 2],
    fam: { mag_h: 2, mag_s: 2, rail: 2, dot: 1.5, pdot: 1.5, comp: 1, grip: 1, butt: 1, saddle: 1, loader: 1 },
    dress: 0.4,
    dressR: [1, 2, 2],
  },
  bunker: {
    any: [1, 1, 1],
    weapons: { w_ar: 3, w_br: 3, w_dmr: 3, w_sniper: 2, w_lmg: 3, w_cannon: 2, w_combat: 2, w_smg2: 1, w_pump: 1, w_carbine: 1 },
    guns: [2, 3],
    gunsPerDepth: 1,
    wear: 0.08,
    mods: [2, 3],
    modsPerDepth: 1,
    modR: [2, 3, 3],
    fam: { scope: 3, long: 3, sup_r: 3, sup_h: 2, brake: 1.5, grip: 2, bipod: 2, mag_r: 3, mag_s: 2, mag_b: 1, stock_l: 2, rail: 2, bar_r: 2, bar_c: 2, bar_h: 1.5, dot: 2 },
    dress: 1.3,
    dressR: [2, 3, 3],
  },
  cache: {
    any: [0.8, 1, 1],
    weapons: { w_pistol: 3, w_revolver: 2, w_smg: 2, w_mp: 1.5, w_carbine: 1.5, w_ar: 1, w_rifle: 1.5, w_lever: 1.5, w_pump: 1.5, w_crossbow: 1, w_bow: 1, w_cannon: 0.6 },
    guns: [1, 2],
    gunsPerDepth: 0,
    wear: 0.4,
    mods: [1, 3],
    modsPerDepth: 1,
    modR: [2, 3, 3],
    fam: { dot: 2, pdot: 2, scope: 2, long: 1, sup_h: 1.5, sup_r: 1.5, comp: 1.5, brake: 1.5, choke: 1.5, grip: 2, bipod: 1, mag_h: 2, mag_s: 2, mag_r: 2, mag_b: 1, loader: 1, tube: 1, saddle: 1, stock_p: 1, stock_l: 1, butt: 1.5, rail: 2, bar_h: 1, bar_c: 1, bar_r: 1, bar_g: 1, bar_x: 0.5 },
    dress: 0.6,
    dressR: [2, 3, 3],
  },
};

/** Pick from weights; the entries are sorted by id first so the draw never depends on object key order. */
function pickWeighted(rng: Rng, w: Record<string, number>): string | null {
  const keys = Object.keys(w).filter((k) => w[k] > 0 && k in idSet).sort();
  const total = keys.reduce((a, k) => a + w[k], 0);
  if (!keys.length || total <= 0) return null;
  let r = rng.next() * total;
  for (const k of keys) {
    r -= w[k];
    if (r <= 0) return k;
  }
  return keys[keys.length - 1];
}

const idSet: Record<string, true> = Object.fromEntries(GEAR.items.map((g) => [g.id, true as const]));

/** A loose add-on for a source: a family by weight, then one of that family's slots' items, rarity capped. */
function looseMod(rng: Rng, t: Table, maxR: number): GearItem | null {
  const mods = GEAR.items.filter((g) => g.mod && g.rarity <= maxR && (t.fam[g.mod.fam] ?? 0) > 0);
  if (!mods.length) return null;
  const w = mods.map((g) => g.weight * t.fam[g.mod!.fam]);
  const total = w.reduce((a, b) => a + b, 0);
  let r = rng.next() * total;
  for (let i = 0; i < mods.length; i++) {
    r -= w[i];
    if (r <= 0) return newMod(mods[i].id);
  }
  return newMod(mods[mods.length - 1].id);
}

/**
 * The guns, blades and add-ons a place of this kind holds. See the header: deterministic in `(context, seed, depth)` except for
 * the item uids. `depth` is 0 to 2 (a shelf, a back room, a vault) and moves the odds, the count and the rarity up.
 */
export function rollGunLoot(context: GunLootContext, seed: number, depth = 0): GearItem[] {
  const t = TABLES[context];
  if (!t) return [];
  const d = clamp(Math.round(depth), 0, 2);
  const rng = new Rng((Math.imul(seed | 0, 2654435761) ^ hashString(`${context}:${d}`)) >>> 0);
  const out: GearItem[] = [];
  if (!rng.chance(t.any[d])) return out;

  const nGuns = rng.int(t.guns[0], t.guns[1] + t.gunsPerDepth * d);
  for (let i = 0; i < nGuns; i++) {
    const id = pickWeighted(rng, t.weapons);
    if (!id) continue;
    const it = newGear(id);
    const def = gearDef(id);
    // Weapons come out of a drawer or off a body with some miles on them; a shop's stock is kept better.
    it.cond = foundCondition(1 - t.wear + t.wear * rng.next(), def.rarity);
    if (def.gun) dressGun(it, rng, { odds: t.dress * (1 + d * 0.25), maxR: t.dressR[d], fam: t.fam });
    out.push(it);
  }
  const nMods = t.mods[1] > 0 ? rng.int(t.mods[0], t.mods[1] + t.modsPerDepth * d) : 0;
  for (let i = 0; i < nMods; i++) {
    const m = looseMod(rng, t, t.modR[d]);
    if (m) out.push(m);
  }
  return out;
}
