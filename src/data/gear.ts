import gearJson from './gear.json';

/**
 * Personal gear: what a scavenger wears and holds. (Vehicle parts live in `parts.json`; this is the person.)
 * Worn items sit in one of seven body slots and change stats and looks. Held items go on the belt, and the belt
 * slot in your hand decides what the on-foot buttons do.
 */
export type WearSlot = 'head' | 'face' | 'body' | 'hands' | 'legs' | 'feet' | 'back';
export const WEAR_SLOTS: WearSlot[] = ['head', 'face', 'body', 'hands', 'legs', 'feet', 'back'];

export type GearKind = 'wear' | 'gun' | 'melee' | 'tool' | 'mod';

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

/** The shape a gun is drawn in and handled as: its model, icon, kick table and the round it fires all key off this. */
export type GunModel =
  | 'pistol'
  | 'revolver'
  | 'smg'
  | 'sawn'
  | 'pump'
  | 'rifle'
  | 'compact'
  | 'cannon'
  | 'mp'
  | 'smg2'
  | 'carbine'
  | 'ar'
  | 'br'
  | 'dmr'
  | 'sniper'
  | 'lever'
  | 'crossbow'
  | 'bow'
  | 'combat'
  | 'coach'
  | 'lmg';
export const GUN_MODELS: GunModel[] = ['pistol', 'revolver', 'smg', 'sawn', 'pump', 'rifle', 'compact', 'cannon', 'mp', 'smg2', 'carbine', 'ar', 'br', 'dmr', 'sniper', 'lever', 'crossbow', 'bow', 'combat', 'coach', 'lmg'];
export type MeleeModel = 'knife' | 'bat' | 'machete' | 'axe' | 'pipe' | 'sledge' | 'katana';

/**
 * Where an add-on bolts onto a gun. Each weapon lists the slots it has and, for each, which attachment families fit
 * (`GunStats.slots`), so a suppressor made for a pistol never goes on a rifle and a shotgun has no magazine to swap.
 */
export type AttachSlot = 'optic' | 'muzzle' | 'barrel' | 'under' | 'mag' | 'stock' | 'rail';
export const ATTACH_SLOTS: AttachSlot[] = ['optic', 'muzzle', 'barrel', 'under', 'mag', 'stock', 'rail'];
export const ATTACH_LABELS: Record<AttachSlot, string> = { optic: 'Optic', muzzle: 'Muzzle', barrel: 'Barrel', under: 'Underbarrel', mag: 'Magazine', stock: 'Stock', rail: 'Side rail' };

/**
 * What a fitted attachment does. Every number is a fraction of the gun's own (so `-0.5` is half), except `zoom` (a
 * magnification, 1 is none), `magAdd` (whole rounds) and `beam`. The sum over everything fitted is applied in `sim/gunmods.ts`.
 */
export interface ModStats {
  slot: AttachSlot;
  /** The family it belongs to. A weapon accepts a family in a slot when its `slots` list names it. */
  fam: string;
  /** Which picture to draw, on the model and the icon. */
  look: string;
  /** Damage per shot. */
  dmg?: number;
  /** Spread, hip and aimed. Negative is steadier. */
  spread?: number;
  /** Extra change to the hip-fire spread only (a laser), and to the aimed spread only (a sight). */
  hip?: number;
  ads?: number;
  /** Range. */
  range?: number;
  /** Muzzle velocity: slower rounds fall more and arrive softer. */
  vel?: number;
  /** Loudness of a shot: negative is quieter. */
  noise?: number;
  /** Muzzle flash size. */
  flash?: number;
  /** Kick: negative is gentler. */
  recoil?: number;
  /** Barrel wander: negative is steadier. */
  sway?: number;
  /** How fast the sights come up: positive is quicker. */
  aimSpeed?: number;
  /** Magazine size, as a fraction and as whole rounds. */
  mag?: number;
  magAdd?: number;
  /** Reload time: negative is faster. */
  reload?: number;
  /** Seconds between shots: negative is faster. */
  rate?: number;
  /** Aim-down-sights magnification. */
  zoom?: number;
  /** A light on the rail: a laser puts a dot where the shot goes, a torch lights what is ahead. */
  beam?: 'laser' | 'torch' | 'both';
}
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
  /** Aim-down-sights magnification the gun has on its own (a fixed scope). An optic that is fitted replaces it. Missing is 1. */
  zoom?: number;
  model: GunModel;
  sound: 'pistol' | 'mg' | 'sniper' | 'shotgun' | 'bolt' | 'bow';
  /**
   * Seconds to full draw, for a bow: it is drawn by holding the trigger and loosed by letting go, and the arrow flies as hard
   * as it was drawn. It shoots arrows (the convoy's `items.arrow`), not rounds. Missing for everything else.
   */
  draw?: number;
  /** The slots this gun has, and the attachment families each takes. Missing means a bare gun. */
  slots?: Partial<Record<AttachSlot, string[]>>;
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
  /** An add-on for a gun: it sits in the bag until it is fitted to a weapon's slot. */
  mod?: ModStats;
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
    need(g.kind !== 'mod' || (!!g.mod && ATTACH_SLOTS.includes(g.mod.slot) && !!g.mod.fam && !!g.mod.look), `gear ${g.id}: add-on needs a slot, family and look`);
    need(g.kind === 'mod' || !g.mod, `gear ${g.id}: only add-ons carry mod stats`);
    if (g.mod) need(g.mod.zoom === undefined || (g.mod.slot === 'optic' && g.mod.zoom >= 1 && g.mod.zoom <= 12), `gear ${g.id}: zoom belongs to optics and runs 1 to 12`);
    if (g.gun) {
      need(GUN_MODELS.includes(g.gun.model), `gear ${g.id}: unknown gun model ${g.gun.model}`);
      need(g.gun.draw === undefined || (g.gun.draw > 0.1 && g.gun.draw < 3 && g.gun.mag === 1), `gear ${g.id}: a bow draws in 0.1 to 3 s and holds one arrow`);
      for (const [slot, fams] of Object.entries(g.gun.slots ?? {})) need(ATTACH_SLOTS.includes(slot as AttachSlot) && Array.isArray(fams) && fams.length > 0, `gear ${g.id}: bad attachment slot ${slot}`);
    }
    need(g.kind === 'wear' || !!g.short, `gear ${g.id}: held items need a short name`);
    for (const k of Object.keys(g.stats ?? {})) need(STAT_KEYS.includes(k as keyof GearStats), `gear ${g.id}: unknown stat ${k}`);
  }
  // A fresh start must be able to fill every slot and still fight.
  for (const s of WEAR_SLOTS) need(GEAR.items.some((g) => g.starter && g.slot === s), `gear: no starter for ${s}`);
  need(GEAR.items.some((g) => g.starter && g.kind === 'gun'), 'gear: no starter gun');
  // An add-on nothing can take is dead weight in the bag.
  for (const m of GEAR.items.filter((g) => g.mod)) {
    need(GEAR.items.some((g) => g.gun?.slots?.[m.mod!.slot]?.includes(m.mod!.fam)), `gear ${m.id}: no weapon takes the ${m.mod!.fam} family in the ${m.mod!.slot} slot`);
  }
  return errs;
}
