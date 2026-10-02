import gearJson from './gear.json';

/**
 * Personal gear: what a scavenger wears and holds. (Vehicle parts live in `parts.json`; this is the person.)
 * Worn items sit in one of seven body slots and change stats and looks. Held items go on the belt, and the belt
 * slot in your hand decides what the on-foot buttons do.
 */
export type WearSlot = 'head' | 'face' | 'body' | 'hands' | 'legs' | 'feet' | 'back';
export const WEAR_SLOTS: WearSlot[] = ['head', 'face', 'body', 'hands', 'legs', 'feet', 'back'];

export type GearKind = 'wear' | 'gun' | 'melee' | 'tool';

/** Every number is a fraction unless it says otherwise: `armor: 0.08` is 8% less damage taken. Bag is whole slots. */
export interface GearStats {
  /** Damage cut from bullets, claws, blasts and rams. */
  armor?: number;
  /** Damage cut from bloater spores. */
  spore?: number;
  /** Damage cut from falls. */
  fall?: number;
  /** Walking and sprinting speed. */
  speed?: number;
  /** Footstep Signature: negative is quieter. */
  noise?: number;
  /** Extra bag slots. */
  bag?: number;
  /** Reload time: negative is faster. */
  reload?: number;
  /** Melee damage. */
  melee?: number;
  /** Gun spread: negative is steadier. */
  steady?: number;
}
export const STAT_KEYS: (keyof GearStats)[] = ['armor', 'spore', 'fall', 'speed', 'noise', 'bag', 'reload', 'melee', 'steady'];

export type GunModel = 'pistol' | 'revolver' | 'smg' | 'sawn' | 'pump' | 'rifle';
export type MeleeModel = 'knife' | 'bat' | 'machete' | 'axe';
export type ToolId = 'wrench' | 'crowbar' | 'jerrycan';

export interface GunStats {
  /** Damage per bullet or pellet. */
  dmg: number;
  /** Seconds between shots. */
  cd: number;
  /** Rounds per magazine. */
  mag: number;
  /** Reload seconds. */
  reload: number;
  /** Hip and aimed-down-sights spread, radians. */
  spread: number;
  adsSpread: number;
  pellets?: number;
  range: number;
  /** Loudness added to the Signature grid per shot. */
  noise: number;
  /** Fraction of a target's armour that is ignored. */
  pierce?: number;
  model: GunModel;
  sound: 'pistol' | 'mg' | 'sniper' | 'shotgun';
}

export interface MeleeStats {
  dmg: number;
  /** Seconds between swings. */
  cd: number;
  reach: number;
  noise: number;
  model: MeleeModel;
}

/** How a worn item looks. `style` names a shape in `render/outfit.ts`; colours are `#rrggbb`. */
export interface GearLook {
  style: string;
  c?: string;
  c2?: string;
  /** Use the survivor's own identity colours instead of `c`, so the starter kit looks like it always did. */
  tint?: boolean;
}

export interface GearDef {
  id: string;
  name: string;
  kind: GearKind;
  rarity: 1 | 2 | 3;
  /** Relative chance in a loot roll. */
  weight: number;
  /** Scrap it is worth when broken down. */
  scrap: number;
  blurb: string;
  /** Four or five letters for the belt on the HUD. */
  short?: string;
  slot?: WearSlot;
  stats?: GearStats;
  gun?: GunStats;
  melee?: MeleeStats;
  tool?: ToolId;
  look?: GearLook;
  /** Where it tends to turn up: city, waste, raider, vault. */
  tags?: string[];
  /** Part of the kit every scavenger starts in. */
  starter?: boolean;
}

export const GEAR = gearJson as unknown as {
  labels: Record<WearSlot, string>;
  /** Slots in a fresh bag, before a pack or pockets add any. */
  bagBase: number;
  /** Hand slots on the belt. The utility slot sits after them. */
  beltSize: number;
  caps: { armor: number; spore: number; fall: number; speedLo: number; speedHi: number; noiseLo: number; noiseHi: number };
  items: GearDef[];
};

const BY_ID = new Map(GEAR.items.map((g) => [g.id, g]));

export function gearDef(id: string): GearDef {
  const g = BY_ID.get(id);
  if (!g) throw new Error(`Unknown gear ${id}`);
  return g;
}
export function hasGear(id: string) {
  return BY_ID.has(id);
}

/** `#rrggbb` to a number, falling back when it is missing or malformed. */
export function hexColor(s: string | undefined, fallback: number): number {
  return s && /^#[0-9a-f]{6}$/i.test(s) ? parseInt(s.slice(1), 16) : fallback;
}

/** Schema checks, folded into `validateData`. */
export function validateGear(): string[] {
  const errs: string[] = [];
  const need = (cond: boolean, msg: string) => {
    if (!cond) errs.push(msg);
  };
  need(new Set(GEAR.items.map((g) => g.id)).size === GEAR.items.length, 'gear: duplicate ids');
  need(GEAR.beltSize >= 2 && GEAR.bagBase >= 1, 'gear: belt and bag sizes');
  for (const g of GEAR.items) {
    need(g.rarity >= 1 && g.rarity <= 3, `gear ${g.id}: rarity range`);
    need(g.weight > 0 && g.scrap >= 0, `gear ${g.id}: weight and scrap`);
    if (g.kind === 'wear') {
      need(!!g.slot && WEAR_SLOTS.includes(g.slot), `gear ${g.id}: wearable needs a slot`);
      need(!!g.look?.style, `gear ${g.id}: wearable needs a look`);
      for (const k of [g.look?.c, g.look?.c2]) need(k === undefined || /^#[0-9a-f]{6}$/i.test(k), `gear ${g.id}: bad colour ${String(k)}`);
    } else need(!g.slot && !g.look, `gear ${g.id}: only wearables take a slot or a look`);
    need(g.kind !== 'gun' || (!!g.gun && g.gun.mag > 0 && g.gun.cd > 0 && g.gun.dmg > 0), `gear ${g.id}: gun stats`);
    need(g.kind !== 'melee' || (!!g.melee && g.melee.dmg > 0 && g.melee.cd > 0 && g.melee.reach > 0), `gear ${g.id}: melee stats`);
    need(g.kind !== 'tool' || !!g.tool, `gear ${g.id}: tool needs an id`);
    need(g.kind === 'wear' || !!g.short, `gear ${g.id}: held items need a short name`);
    for (const k of Object.keys(g.stats ?? {})) need(STAT_KEYS.includes(k as keyof GearStats), `gear ${g.id}: unknown stat ${k}`);
  }
  // A fresh start must be able to fill every slot and still fight.
  for (const s of WEAR_SLOTS) need(GEAR.items.some((g) => g.starter && g.slot === s), `gear: no starter for ${s}`);
  need(GEAR.items.some((g) => g.starter && g.kind === 'gun'), 'gear: no starter gun');
  return errs;
}
