import { ATTACH_LABELS, GEAR, gearDef, type AttachSlot, type GearDef, type WearSlot } from '../data';
import { PLAYER_CSS } from '../render/palette';
import { Btn, wasPressed } from '../input/intents';
import { live } from '../input/bindings';
import { RARITY_NAMES } from '../sim/parts';
import {
  BELT_SIZE,
  UTILITY_SLOT,
  bagCap,
  compareStats,
  describeStats,
  describeWeapon,
  detachToBag,
  equipFromBag,
  findItem,
  fitFromBag,
  gunByUid,
  heldItem,
  itemAt,
  moveBelt,
  repairItem,
  repairPrice,
  scrapOf,
  sortBag,
  statsOf,
  unequipBelt,
  unequipWorn,
  type GearItem,
  type Loadout,
  type Result,
} from '../sim/gear';
import { canFit, compareKits, describeMod, fitted, kitOf, kitWith, newMod, slotsOfGun, type KitLine } from '../sim/gunmods';
import { DRUGS } from '../sim/drugs';
import { MEDKIT_HEAL, UTILITIES, utilityName, type Player, type QuickId } from '../game/player';
import { BLEED, STAMINA, wearLabel, wearOf } from '../sim/vitals';
import { whole } from '../sim/resources';
import { dressOther, drugWord } from '../game/consumables';
import type { Game } from '../game/game';
import type { Campaign } from '../game/campaign';
import type { Slot } from '../input/input';
import { btnLabel, escapeHtml } from './hud';
import type { FocusItem } from './focus';
import { dollSvg, gearIcon, itemIcon, slotGlyph } from './gearIcons';
import { defaultAction, loadPlan, menuFor, takeOut, targetName, type InvTarget, type MenuHost, type MenuItem, type Utility } from './invMenu';
import {
  drugFacts,
  isDrug,
  kicksInText,
  supplyBlurb,
  supplyCount,
  supplyCountText,
  supplyIcon,
  supplyIds,
  supplyName,
  systemLines,
  timelineText,
  toleranceLines,
  type FactLine,
  type SupplyId,
} from './supplies';
import './inventory.css';

type Act = (player: number) => void;

const KIND_LABEL: Record<GearDef['kind'], string> = { wear: 'Worn', gun: 'Firearm', melee: 'Melee', tool: 'Tool', mod: 'Add-on' };
const UTILITY_SHORT: Record<Utility, string> = { flare: 'Flare', molotov: 'Molotov', charge: 'Charge', horn: 'Horn' };
const UTILITY_ICON = { flare: 'flare', molotov: 'molotov', charge: 'charge', horn: 'horn' } as const;
const UTILITY_BLURB: Record<Utility, string> = {
  flare: 'Thrown: lights the dark around where it lands and pulls the dead toward its glare.',
  molotov: 'Thrown: bursts into fire where it lands. Dry grass carries it further.',
  charge: 'Set against a reinforced barricade to blow it open.',
  horn: 'Planted where you stand: it sounds off and draws the dead to it. Never runs out.',
};

// ------------------------------------------------------------------------------------------- picture caches

/**
 * The SVG strings are the heaviest part of the screen to build, and they only change with the item (and the add-ons on a
 * gun), so each is drawn once. Bounded, so a long session of god-mode looting cannot grow it without end.
 */
const iconCache = new Map<string, string>();
function cachedIcon(d: GearDef, index: number, att?: GearItem['att']): string {
  const key = `${d.id}|${index}|${att ? Object.entries(att).map(([k, v]) => `${k}=${v}`).join(',') : ''}`;
  let s = iconCache.get(key);
  if (s === undefined) {
    if (iconCache.size > 600) iconCache.clear();
    iconCache.set(key, (s = gearIcon(d, index, '', att)));
  }
  return s;
}
const dollCache = new Map<string, string>();
function cachedDoll(L: Loadout, index: number): string {
  const key = `${index}|${Object.values(L.worn).map((w) => w?.id ?? '').join(',')}|${Object.keys(L.worn).join(',')}`;
  let s = dollCache.get(key);
  if (s === undefined) {
    if (dollCache.size > 64) dollCache.clear();
    dollCache.set(key, (s = dollSvg(L.worn, index)));
  }
  return s;
}
const glyphCache = new Map<WearSlot, string>();
const cachedGlyph = (slot: WearSlot) => glyphCache.get(slot) ?? (glyphCache.set(slot, slotGlyph(slot)), glyphCache.get(slot)!);

/** What a view needs from whatever hosts it: the pause screen, or the Dawn Ledger's Gear tab. */
export interface InventoryHost {
  c: Campaign;
  audio: { play(id: string): void };
  /** The input slot of a seat, for naming its buttons. */
  slot(i: number): Slot | null;
  btn(id: string, inner: string, act: Act, enabled?: boolean, cls?: string, title?: string): string;
  rerender(): void;
  /** Over a running scene, where things can be put down on the ground. The Dawn Ledger leaves it out. */
  field?: boolean;
  /** Point the owner's cursor at an element the mouse is over, so the ring and the pointer agree. */
  hover?(el: HTMLElement): void;
}

/** The target a focus id names: a tile in the worn, belt, bag, supplies or throwables grid. */
function targetOf(L: Loadout, fid: string): InvTarget | null {
  const i = fid.indexOf(':');
  if (i < 0) return null;
  const zone = fid.slice(0, i);
  const key = fid.slice(i + 1);
  if (zone === 'bag') return L.bag.some((b) => b.uid === key) ? { kind: 'gear', uid: key } : null;
  if (zone === 'belt') {
    const it = L.belt[Number(key)];
    return it ? { kind: 'gear', uid: it.uid } : null;
  }
  if (zone === 'worn') {
    const it = L.worn[key as WearSlot];
    return it ? { kind: 'gear', uid: it.uid } : null;
  }
  if (zone === 'sup') return { kind: 'supply', id: key as SupplyId };
  if (zone === 'util') return (UTILITIES as string[]).includes(key) ? { kind: 'util', id: key as Utility } : null;
  return null;
}

/** The focus id of the tile that shows a target. */
function fidOf(L: Loadout, t: InvTarget): string | null {
  if (t.kind === 'supply') return `sup:${t.id}`;
  if (t.kind === 'util') return `util:${t.id}`;
  const s = findItem(L, t.uid);
  if (!s) return null;
  return s.zone === 'bag' ? `bag:${t.uid}` : s.zone === 'belt' ? `belt:${s.i}` : `worn:${s.slot}`;
}

const sameTarget = (a: InvTarget | null, b: InvTarget | null) =>
  !!a && !!b && a.kind === b.kind && (a.kind === 'gear' ? a.uid === (b as typeof a).uid : a.id === (b as { id: string }).id);

const factHtml = (l: FactLine) => `<div class="stat${l.tone === 'good' ? ' good' : l.tone === 'bad' ? ' badc' : l.tone === 'muted' ? ' mutedtxt' : ''}">${escapeHtml(l.text)}</div>`;

/**
 * One person's gear as three columns: what they wear (and what is in their blood), what is in hand, in the bag and in the
 * stores, and the item picked or pointed at with everything about it. Picking anything opens a small menu beside it with what
 * can be done to it. Pure HTML plus actions; the host owns focus and rendering.
 */
export class InventoryView {
  p: Player | null = null;
  /** The gear picked (a uid): shown in the detail column. The Ledger and tests set it directly. */
  sel: string | null = null;
  /** A supply or a throwable picked instead of gear. */
  other: InvTarget | null = null;
  /** What the cursor or the pointer rests on: the detail column shows it ahead of the pick. */
  peek: InvTarget | null = null;
  /** The gun whose customise panel is open (its uid), and the slot being looked at. */
  custom: string | null = null;
  cslot: AttachSlot | null = null;
  msg = '';
  /** The context menu: what it is for, and the focus id of the tile it opened beside. */
  menu: { t: InvTarget; key: string } | null = null;
  /** The menu's rows as last drawn, for the keyboard shortcuts and X. */
  menuItems: MenuItem[] = [];
  /** Set when the menu has just opened (the focus id its cursor should start on) or closed (the tile to go back to). */
  focusNext: string | null = null;
  /** Which seat opened the menu, whose cursor follows it. */
  menuBy = 0;
  /** The host draws the picked tile's highlight itself, so picking does not change the grid's HTML. */
  liveSel = false;

  constructor(private host: InventoryHost) {}

  get c() {
    return this.host.c;
  }
  get field() {
    return !!this.host.field;
  }
  get partner(): Player | undefined {
    return this.p?.partner;
  }
  private get loadout() {
    return this.p!.gear;
  }
  /** This view as the menu sees it. */
  private get mh(): MenuHost {
    return this as unknown as MenuHost;
  }

  reset(p: Player) {
    this.p = p;
    this.sel = null;
    this.other = null;
    this.peek = null;
    this.custom = null;
    this.cslot = null;
    this.menu = null;
    this.menuItems = [];
    this.focusNext = null;
    this.msg = '';
  }

  /** What the detail column is about. */
  private shown(): InvTarget | null {
    if (this.peek && this.valid(this.peek)) return this.peek;
    if (this.sel && findItem(this.loadout, this.sel)) return { kind: 'gear', uid: this.sel };
    return this.other;
  }

  private valid(t: InvTarget): boolean {
    return t.kind !== 'gear' || !!findItem(this.loadout, t.uid);
  }

  /** The focus id of the picked tile, for a host that draws the highlight itself. */
  selFid(): string | null {
    if (this.sel && findItem(this.loadout, this.sel)) return fidOf(this.loadout, { kind: 'gear', uid: this.sel });
    return this.other ? fidOf(this.loadout, this.other) : null;
  }

  private pick(t: InvTarget) {
    if (t.kind === 'gear') {
      this.sel = t.uid;
      this.other = null;
    } else {
      this.sel = null;
      this.other = t;
    }
  }

  /** The cursor or the pointer moved onto a tile (or off the grid): the detail column follows it. Returns true if it changed. */
  setPeek(fid: string | null): boolean {
    if (this.custom || !fid) return false;
    // Off the grid (onto a button), the detail column keeps showing the last tile.
    const t = targetOf(this.loadout, fid);
    if (!t || sameTarget(t, this.peek)) return false;
    this.peek = t;
    return true;
  }

  // ------------------------------------------------------------------ the menu

  /** Open the menu for a target, beside the tile with focus id `key`. */
  openMenu(t: InvTarget, key = fidOf(this.loadout, t) ?? '', by = this.menuBy) {
    this.pick(t);
    this.peek = null;
    this.custom = null;
    this.cslot = null;
    this.menu = { t, key };
    this.menuBy = by;
    this.msg = '';
    this.menuItems = menuFor(this.mh, t);
    const first = this.menuItems.find((m) => m.enabled) ?? this.menuItems[0];
    this.focusNext = first ? `${first.id}` : null;
    this.host.audio.play('click');
    this.host.rerender();
  }

  closeMenu(rerender = true) {
    if (!this.menu) return;
    this.focusNext = this.menu.key;
    this.menu = null;
    this.menuItems = [];
    if (rerender) this.host.rerender();
  }

  /** A tile was pressed (A, Enter, a click): open its menu, or close it if it is the one already open. */
  private press(fid: string, by: number) {
    const t = targetOf(this.loadout, fid);
    if (!t) return;
    if (this.menu && this.menu.key === fid) return this.closeMenu();
    this.openMenu(t, fid, by);
  }

  /** X, or a double click: do the obvious thing with the item under the cursor (or the open menu's item). */
  quick(fid: string) {
    if (this.menu) {
      const a = defaultAction(this.menuItems);
      if (a) a.run();
      return;
    }
    const t = targetOf(this.loadout, fid);
    if (!t) return;
    const a = defaultAction(menuFor(this.mh, t));
    if (a) {
      this.pick(t);
      a.run();
    }
  }

  /** The default action's name for a tile, for the hint line. */
  quickLabel(fid: string | null): string {
    const t = this.menu?.t ?? (fid ? targetOf(this.loadout, fid) : null);
    if (!t) return '';
    const a = defaultAction(this.menu ? this.menuItems : menuFor(this.mh, t));
    return a ? a.label[0].toLowerCase() + a.label.slice(1) : '';
  }

  // ------------------------------------------------------------------ actions

  /** Run a loadout change, report it, and bring the survivor and the screen up to date. */
  private act(r: Result) {
    this.finish(r.ok, r.ok ? r.note : r.reason, true);
  }

  /** Say how something went without a loadout change. */
  private done(ok: boolean, note: string) {
    this.finish(ok, note, false);
  }

  /** After an action: say how it went, close the menu, and put the cursor back on the item, wherever it went. */
  private finish(ok: boolean, note: string, restat: boolean) {
    this.msg = note;
    this.host.audio.play(ok ? 'confirm' : 'deny');
    if (ok && restat) this.p!.refreshGear();
    const m = this.menu;
    if (m && !this.focusNext) this.focusNext = (this.valid(m.t) && fidOf(this.loadout, m.t)) || m.key;
    this.menu = null;
    this.menuItems = [];
    this.host.rerender();
  }

  equip(uid: string, slot?: number) {
    this.act(equipFromBag(this.loadout, uid, slot));
  }

  takeOff(slot: WearSlot) {
    this.act(unequipWorn(this.loadout, slot));
  }

  hold(i: number) {
    const L = this.loadout;
    if (!L.belt[i]) return;
    L.sel = i;
    this.p!.syncEquip();
    this.done(true, `${gearDef(L.belt[i]!.id).name} in hand`);
  }

  stow(i: number) {
    this.act(unequipBelt(this.loadout, i));
  }

  moveBelt(from: number, to: number) {
    this.focusNext = `belt:${to}`;
    this.act(moveBelt(this.loadout, from, to));
  }

  /** Top the magazine up from the stores. Nobody is shooting at you in here, so it is done by the time you look up. */
  load(uid: string) {
    const it = gunByUid(this.loadout, uid);
    if (!it) return;
    const lp = loadPlan(it, this.c.ammo);
    if (lp.why) return this.done(false, lp.why);
    it.mag = (it.mag ?? 0) + lp.add;
    this.c.ammo -= lp.add;
    this.done(true, `Loaded the ${gearDef(it.id).name}: ${it.mag}/${lp.cap} (${this.c.ammo} rounds left)`);
  }

  customise(uid: string) {
    this.menu = null;
    this.menuItems = [];
    this.peek = null;
    this.sel = uid;
    this.other = null;
    this.custom = uid;
    this.cslot = null;
    this.msg = '';
    this.focusNext = null;
    this.host.audio.play('confirm');
    this.host.rerender();
  }

  scrap(uid: string) {
    const L = this.loadout;
    const it = takeOut(L, uid);
    if (!it) return this.done(false, 'That cannot come out of your kit right now');
    // A gun's add-ons come off first and go back in the bag while there is room; only what will not fit is broken down with it.
    let kept = 0;
    for (const f of fitted(it)) {
      if (L.bag.length >= bagCap(L)) break;
      L.bag.push(newMod(f.def.id));
      delete it.att![f.slot];
      kept++;
    }
    const n = scrapOf(it);
    this.c.stocks.scrap += n;
    this.sel = null;
    this.custom = null;
    this.act({ ok: true, note: `Broke down the ${gearDef(it.id).name}: +${n} Scrap${kept ? ` (${kept} add-on${kept > 1 ? 's' : ''} kept)` : ''}` });
  }

  /** Fit an add-on to a gun. Rounds that no longer fit the magazine go back to the stock. */
  fit(gunUid: string, modUid: string) {
    const gun = gunByUid(this.loadout, gunUid);
    const before = gun?.mag ?? 0;
    const r = fitFromBag(this.loadout, gunUid, modUid);
    if (r.ok && gun) this.c.ammo += Math.max(0, before - (gun.mag ?? 0));
    this.act(r);
  }

  private detach(gunUid: string, slot: AttachSlot) {
    const r = detachToBag(this.loadout, gunUid, slot);
    if (r.ok && r.rounds) this.c.ammo += r.rounds;
    this.act(r);
  }

  give(uid: string) {
    const p = this.p!;
    if (this.c.solo) return;
    const them = this.c.players[1 - p.index];
    if (them.gear.bag.length >= bagCap(them.gear)) return this.act({ ok: false, reason: 'Their bag is full' });
    const it = takeOut(this.loadout, uid);
    if (!it) return this.act({ ok: false, reason: 'That cannot come out of your kit right now' });
    them.gear.bag.push(it);
    this.partner?.refreshGear();
    this.sel = null;
    this.act({ ok: true, note: `Handed the ${gearDef(it.id).name} to ${them.name}` });
  }

  /** Put it on the ground at your feet, as a find anyone can walk up to and take. */
  drop(uid: string) {
    const p = this.p!;
    if (!this.field || p.swimming) return;
    const it = takeOut(this.loadout, uid);
    if (!it) return this.act({ ok: false, reason: 'That cannot come out of your kit right now' });
    p.ctx.dropGear(it, p.pos.x, p.pos.z);
    this.sel = null;
    this.act({ ok: true, note: `Dropped the ${gearDef(it.id).name}` });
  }

  repair(uid: string) {
    const it = findItem(this.loadout, uid);
    const item = it ? itemAt(this.loadout, it) : null;
    if (!item) return;
    const cost = repairPrice(item);
    if (cost <= 0) return;
    if (this.c.stocks.scrap < cost) return this.act({ ok: false, reason: `Repairs need ${cost} Scrap` });
    this.c.stocks.scrap -= cost;
    repairItem(item);
    this.act({ ok: true, note: `Repaired the ${gearDef(item.id).name}: -${cost} Scrap` });
  }

  private sort() {
    sortBag(this.loadout);
    this.act({ ok: true, note: 'Bag sorted: guns, blades, tools, then clothes' });
  }

  pickUtility(u: Utility) {
    const p = this.p!;
    p.utility = u;
    this.c.players[p.index].utility = u;
    this.loadout.sel = UTILITY_SLOT;
    p.syncEquip();
    this.done(true, `${utilityName(u)} in hand`);
  }

  /** A dressing on yourself: the same rules as the quick belt, minus the busy hands (nobody is shooting at you in here). */
  useDressing(kind: 'bandage' | 'medkit') {
    const p = this.p!;
    const before = p.hp;
    const bled = p.bleed.level;
    if (!p.useDressing(kind)) return this.done(false, p.notes[p.notes.length - 1]?.text ?? 'Nothing to dress');
    p.fireCd = 0;
    p.meleeCd = 0;
    this.done(true, `${kind === 'medkit' ? 'Patched up' : 'Bandaged'}: +${Math.round(p.hp - before)} HP${bled ? ', bleeding stopped' : ''}`);
  }

  dressPartner(kind: 'bandage' | 'medkit') {
    const who = this.partner;
    if (!who || !dressOther(this.p!, who, kind)) return this.done(false, 'They are out of reach');
    this.done(true, `You dressed ${who.name}'s wounds`);
  }

  setQuick(id: QuickId) {
    this.p!.setQuick(id);
    this.done(true, `On the quick belt: ${btnLabel(this.host.slot(this.p!.index), 'Down')} takes it`);
  }

  /** A dose from the pack. It goes down now; the clock it comes on by starts when the game does. */
  takeDrug(id: SupplyId) {
    if (!isDrug(id)) return;
    const p = this.p!;
    if (!p.takeDrug(id)) return this.done(false, `No ${drugWord(id)} left`);
    this.done(true, `${DRUGS[id].name} taken. ${kicksInText(DRUGS[id])}`);
  }

  eat() {
    const p = this.p!;
    if (!p.eatRation()) return this.done(false, p.notes[p.notes.length - 1]?.text ?? 'You cannot eat now');
    p.fireCd = 0;
    p.meleeCd = 0;
    this.done(true, `You eat a ration (${whole(this.c.stocks.rations)} left)`);
  }

  drink() {
    const p = this.p!;
    if (!p.drinkUp()) return this.done(false, p.notes[p.notes.length - 1]?.text ?? 'You cannot drink now');
    p.fireCd = 0;
    p.meleeCd = 0;
    this.done(true, p.notes[p.notes.length - 1]?.text ?? 'You drink');
  }

  // ------------------------------------------------------------------ rendering

  private btn(id: string, inner: string, act: Act, enabled = true, cls = '', title = ''): string {
    return this.host.btn(id, inner, act, enabled, cls, title);
  }

  /** The name of a button as this person's own controller or keyboard calls it. */
  private key(btn: string): string {
    return btnLabel(this.host.slot(this.p!.index), btn);
  }

  /** One square of the grid: the item's picture, a caption, and a rarity-coloured edge. Empty squares show what goes there. */
  private itemBtn(zone: 'worn' | 'belt' | 'bag', key: string | number, it: GearItem | null, label: string, held = false, ghost: WearSlot | null = null): string {
    const id = `${zone}:${key}`;
    if (!it) {
      const g = ghost ? cachedGlyph(ghost) : '';
      return `<button class="tile empty ${zone}" disabled data-slot="${id}"><span class="ic">${g}</span><small>${label}</small></button>`;
    }
    const d = gearDef(it.id);
    const on = !this.liveSel && this.sel === it.uid ? ' sel' : '';
    const hl = held ? ' held' : '';
    const mag = d.gun && it.mag !== undefined ? `<em class="cnt">${it.mag}</em>` : '';
    const nmods = d.gun && it.att ? Object.keys(it.att).length : 0;
    const mods = nmods ? `<b class="modn" title="${nmods} add-on${nmods > 1 ? 's' : ''} fitted">+${nmods}</b>` : '';
    const w = wearOf(it.cond);
    const wear = (d.gun || d.melee) && w < 0.995 ? `<u class="wear ${w < 0.3 ? 'bad' : w < 0.6 ? 'mid' : ''}" style="--w:${Math.round(w * 100)}%"></u>` : '';
    return this.btn(
      id,
      `<span class="ic">${cachedIcon(d, this.p!.index, it.att)}</span><small>${label}</small>${mag}${mods}${wear}<i class="pip r${d.rarity}">${'◆'.repeat(d.rarity)}</i>`,
      (by) => this.press(id, by),
      true,
      `tile r${d.rarity} ${zone}${on}${hl}`,
      d.name,
    );
  }

  /** The first column: the survivor and what they wear, what it adds up to, and what is in their blood. */
  wearHtml(): string {
    const p = this.p!;
    const L = this.loadout;
    const stats = statsOf(L);
    const slotTile = (slot: WearSlot) => this.itemBtn('worn', slot, L.worn[slot] ?? null, GEAR.labels[slot], false, slot);
    const doll = `<div class="doll">
        <div class="dollcol">${(['head', 'body', 'hands', 'feet'] as const).map(slotTile).join('')}</div>
        <div class="dollfig">${cachedDoll(L, p.index)}</div>
        <div class="dollcol">${(['face', 'back', 'legs'] as const).map(slotTile).join('')}</div>
      </div>`;
    const eff: string[] = [];
    const pc = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`;
    const add = (label: string, v: number, goodWhenHigh: boolean) => {
      if (Math.abs(v) < 0.005) return;
      eff.push(`<span class="pill ${(v > 0) === goodWhenHigh ? 'good' : 'badc'}">${label} ${pc(v)}</span>`);
    };
    add('Armour', stats.armor, true);
    add('Spore guard', stats.spore, true);
    add('Fall', stats.fall, true);
    add('Speed', stats.speed, true);
    add('Noise', stats.noise, false);
    add('Reload', stats.reload, false);
    add('Melee', stats.melee, true);
    add('Spread', stats.steady, false);
    return `<h3>Wearing</h3>${doll}
      <div class="effects">${eff.length ? eff.join('') : '<span class="mutedtxt">No bonuses or penalties</span>'}</div>
      ${this.systemHtml()}`;
  }

  /** The drugs at work in this body, what is still in the stomach, and the tolerance it has built. */
  private systemHtml(): string {
    const s = this.p!.drugs;
    const lines = systemLines(s);
    const tol = toleranceLines(s);
    const tox = s.toxicity;
    const bar = tox > 0.02 ? `<div class="toxbar${tox > 0.7 ? ' hot' : ''}" title="Toxicity: past full you are overdosing"><i style="width:${Math.min(100, Math.round(tox * 100))}%"></i><span>Toxicity ${Math.round(tox * 100)}%</span></div>` : '';
    const body = lines.length || tol.length || bar ? `${lines.map(factHtml).join('')}${bar}${tol.length ? `<div class="stat mutedtxt">Tolerance: ${tol.map((t) => escapeHtml(t.text)).join(' · ')}</div>` : ''}` : '<div class="stat mutedtxt">Clean: nothing in your blood</div>';
    return `<h3 class="sysh">In your system</h3><div class="system">${body}</div>`;
  }

  /**
   * The second column: in hand, the stores' supplies, and the bag. Three parts, so the screen can redraw one without the
   * others (taking a dose never rebuilds the bag grid). Supplies sit above the bag: they are reached for far more often, and a
   * big bag would push them out of sight.
   */
  packHtml(): string {
    return this.handHtml() + this.supHtml() + this.bagHtml();
  }

  handHtml(): string {
    const p = this.p!;
    const L = this.loadout;
    const belt = Array.from({ length: BELT_SIZE }, (_, i) => {
      const it = L.belt[i] ?? null;
      const t = this.itemBtn('belt', i, it, it ? (gearDef(it.id).short ?? gearDef(it.id).name) : 'Free', L.sel === i);
      return t.replace('class="', `data-n="${i + 1}" class="`);
    }).join('');
    const util = UTILITIES.map((u) => {
      const n = u === 'horn' ? '∞' : String(this.c.items[u]);
      const fid = `util:${u}`;
      return this.btn(fid, `<span class="ic">${itemIcon(UTILITY_ICON[u])}</span><small>${UTILITY_SHORT[u]}</small><em class="cnt">${n}</em>`, (by) => this.press(fid, by), true, `tile util${L.sel === UTILITY_SLOT && p.utility === u ? ' held' : ''}${!this.liveSel && this.other?.kind === 'util' && this.other.id === u ? ' sel' : ''}`, utilityName(u));
    }).join('');
    return `<h3>In hand <small>${escapeHtml(this.key('LB'))} swaps</small></h3>
      <div class="invbelt">${belt}</div>
      <div class="invutil">${util}</div>`;
  }

  supHtml(): string {
    return `<h3>Supplies <small>shared stores</small></h3>
      <div class="invsup">${this.suppliesHtml()}</div>
      <div class="invsupply">${this.pillsHtml()}</div>`;
  }

  bagHtml(): string {
    const L = this.loadout;
    const cap = bagCap(L);
    const cells: string[] = [];
    for (let i = 0; i < Math.max(cap, L.bag.length); i++) {
      const it = L.bag[i] ?? null;
      cells.push(this.itemBtn('bag', it?.uid ?? `e${i}`, it, it ? (gearDef(it.id).short ?? gearDef(it.id).name) : i < cap ? '' : 'Over'));
    }
    const over = L.bag.length > cap ? ' bad' : '';
    return `<h3>Bag <small class="${over}">${L.bag.length}/${cap}</small>${this.btn('sortbag', 'Sort', () => this.sort(), L.bag.length > 1, 'chipbtn sortbtn', 'Guns, blades, tools, then clothes')}</h3>
      <div class="invbag">${cells.join('')}</div>`;
  }

  /** Dressings, food, water, and every drug the stores hold, as small tiles with their counts. */
  private suppliesHtml(): string {
    const p = this.p!;
    const out: string[] = [];
    let drugs = 0;
    for (const id of supplyIds()) {
      const n = supplyCount(this.c, id);
      if (isDrug(id)) {
        if (n <= 0) continue;
        drugs++;
      }
      const fid = `sup:${id}`;
      const want = (id === 'bandage' && p.bleed.level > 0) || (id === 'medkit' && p.hp < p.maxHp * 0.4);
      const quick = p.quickSel === (id === 'ration' ? 'eat' : id === 'water' ? 'drink' : id) ? '<b class="qk" title="On the quick belt">Q</b>' : '';
      const color = isDrug(id) ? ` style="--dc:${DRUGS[id].color}"` : '';
      const tile = this.btn(
        fid,
        `<span class="ic">${supplyIcon(id)}</span><small>${escapeHtml(supplyName(id))}</small><em class="cnt">${supplyCountText(this.c, id)}</em>${quick}`,
        (by) => this.press(fid, by),
        true,
        `tile sup${isDrug(id) ? ' drug' : ''}${n <= 0 ? ' none' : ''}${want ? ' want' : ''}${!this.liveSel && this.other?.kind === 'supply' && this.other.id === id ? ' sel' : ''}`,
        supplyBlurb(id),
      );
      out.push(color ? tile.replace('<button ', `<button${color} `) : tile);
    }
    if (!drugs) out.push(`<span class="mutedtxt nodrugs">No drugs. The still and apothecary at camp make them.</span>`);
    return out.join('');
  }

  /** Ammunition and how the body is doing: the numbers a fight turns on. */
  private pillsHtml(): string {
    const p = this.p!;
    const it = this.c.items;
    const chip = (label: string, v: string, cls = '') => `<span class="pill ${cls}">${label} ${v}</span>`;
    const wounds = p.bleed.level > 0 ? chip('Bleeding', `×${p.bleed.level}`, 'badc') : '';
    const bite = p.venom.dose > 0 ? chip('Venom', p.venom.bound ? 'bound' : 'spreading', 'badc') : '';
    // Arrows show once there is a bow to shoot them from, or arrows to shoot.
    const bow = it.arrow > 0 || [...p.gear.belt, ...p.gear.bag].some((g) => !!g && !!gearDef(g.id).gun?.draw);
    const n = p.needs;
    return [
      chip('Rounds', String(this.c.ammo), this.c.ammo < 20 ? 'badc' : 'good'),
      bow ? chip('Arrows', String(it.arrow), it.arrow < 4 ? 'badc' : 'good') : '',
      chip('Health', `${Math.round(p.hp)}/${p.maxHp}`, p.hp < p.maxHp * 0.5 ? 'badc' : 'good'),
      chip('Wind', `${Math.round((p.stamina.value / STAMINA.max) * 100)}%`, p.stamina.winded ? 'badc' : 'good'),
      chip('Fed', `${Math.round(n.food * 100)}%`, n.food < 0.3 ? 'badc' : 'good'),
      chip('Water', `${Math.round(n.water * 100)}%`, n.water < 0.3 ? 'badc' : 'good'),
      wounds,
      bite,
    ].join('');
  }

  /** The right-hand column: what the item pointed at or picked is, how it compares, and what is fitted to it. */
  detailHtml(): string {
    const t = this.shown();
    if (this.custom) {
      const it = findItem(this.loadout, this.custom) ? itemAt(this.loadout, findItem(this.loadout, this.custom)!) : null;
      if (it && gearDef(it.id).gun) return this.customHtml(it);
      this.custom = null;
    }
    if (!t) {
      return `<h3>Details</h3><div class="mutedtxt pad">Point at anything to see what it does. Pick it (${escapeHtml(this.key('A'))}, or a click) for what you can do with it; ${escapeHtml(this.key('X'))} or a double click does the obvious thing.<br><br>Wear things on your body for armour, stealth and room in the bag. Put weapons and tools on the belt: whatever is in hand is what the buttons use.</div>`;
    }
    if (t.kind === 'supply') return this.supplyDetail(t.id);
    if (t.kind === 'util') return this.utilDetail(t.id);
    return this.gearDetail(t.uid);
  }

  private gearDetail(uid: string): string {
    const p = this.p!;
    const L = this.loadout;
    const spot = findItem(L, uid);
    const it = spot ? itemAt(L, spot) : null;
    if (!it || !spot) return '<h3>Details</h3>';
    const d = gearDef(it.id);
    const lines: string[] = [];
    lines.push(`<div class="bigcard r${d.rarity}"><div class="bigic">${cachedIcon(d, p.index, it.att)}</div><div><h3 class="rname r${d.rarity}">${escapeHtml(d.name)}</h3>`);
    lines.push(`<div class="sub2">${RARITY_NAMES[d.rarity].toUpperCase()} · ${d.slot ? GEAR.labels[d.slot].toUpperCase() : KIND_LABEL[d.kind].toUpperCase()}${spot.zone === 'bag' ? '' : ' · ' + (spot.zone === 'worn' ? 'WORN' : L.sel === spot.i ? 'IN HAND' : 'ON THE BELT')}</div></div></div>`);
    lines.push(`<p class="blurb">${escapeHtml(d.blurb)}</p>`);
    for (const l of describeStats(d.stats)) lines.push(`<div class="stat ${l.good ? 'good' : 'badc'}">${escapeHtml(l.text)}</div>`);
    for (const l of describeWeapon(d, it)) lines.push(`<div class="stat">${escapeHtml(l)}</div>`);
    if (d.mod) {
      for (const l of describeMod(d.mod)) lines.push(`<div class="stat ${l.good ? 'good' : 'badc'}">${escapeHtml(l.text)}</div>`);
      const takers = GEAR.items.filter((g) => canFit(g.id, d.id)).map((g) => g.name);
      lines.push(`<div class="gh">${escapeHtml(ATTACH_LABELS[d.mod.slot])} add-on · fits</div><div class="stat mutedtxt">${escapeHtml(takers.join(', '))}</div>`);
    }
    if (d.gun) {
      const k = kitOf(it);
      if (k.zoom > 1.01) lines.push(`<div class="stat">${k.zoom.toFixed(1)}x zoom when aiming</div>`);
      if (!d.gun.draw) lines.push(`<div class="stat">${it.mag ?? k.gun.mag}/${k.gun.mag} loaded · ${this.c.ammo} rounds in the stores</div>`);
      const on = fitted(it);
      if (on.length) lines.push(`<div class="gh">Fitted</div>` + on.map((f) => `<div class="stat">${escapeHtml(ATTACH_LABELS[f.slot])}: ${escapeHtml(f.def.name)}</div>`).join(''));
      lines.push(this.gunCompare(it));
    }
    if (d.gun || d.melee) {
      const c = wearOf(it.cond);
      lines.push(`<div class="stat ${c >= 0.6 ? 'good' : 'badc'}">${wearLabel(it.cond)} · ${Math.round(c * 100)}% condition${c < 0.3 && d.gun ? ' · jams' : c < 0.6 ? (d.gun ? ' · loose spread' : ' · dull edge') : ''}</div>`);
    }
    // Against what is on the body in that slot already.
    if (spot.zone === 'bag' && d.slot) {
      const cur = L.worn[d.slot];
      const diff = compareStats(cur ? gearDef(cur.id) : null, d);
      lines.push(`<div class="gh">${cur ? `Instead of the ${escapeHtml(gearDef(cur.id).name)}` : 'You have nothing there'}</div>`);
      for (const l of diff) lines.push(`<div class="stat ${l.good ? 'good' : 'badc'}">${escapeHtml(l.text)}</div>`);
      if (!diff.length) lines.push(`<div class="stat mutedtxt">No difference</div>`);
    }
    if (!this.menu) lines.push(`<div class="mutedtxt pad hintline">${escapeHtml(this.key('A'))} or a click: what you can do with it</div>`);
    return lines.join('');
  }

  /** A gun not in hand, against the one that is: the numbers that decide which to carry. */
  private gunCompare(it: GearItem): string {
    const L = this.loadout;
    const held = heldItem(L);
    if (!held || held.uid === it.uid || !gearDef(held.id).gun) return '';
    const a = kitOf(held).gun;
    const b = kitOf(it).gun;
    const hd = gearDef(held.id);
    if (hd.gun?.draw || gearDef(it.id).gun?.draw) return '';
    const rows: [string, number, number, boolean, (v: number) => string][] = [
      ['damage a shot', a.dmg * (a.pellets ?? 1), b.dmg * (b.pellets ?? 1), true, (v) => String(Math.round(v))],
      ['shots a second', 1 / a.cd, 1 / b.cd, true, (v) => v.toFixed(1)],
      ['rounds', a.mag, b.mag, true, (v) => String(Math.round(v))],
      ['reload', a.reload, b.reload, false, (v) => `${v.toFixed(1)} s`],
      ['range', a.range, b.range, true, (v) => `${Math.round(v)} m`],
      ['noise', a.noise, b.noise, false, (v) => String(Math.round(v))],
    ];
    const out = rows
      .filter(([, x, y]) => Math.abs(y - x) > 1e-6 * Math.max(1, Math.abs(x)))
      .map(([label, x, y, up, f]) => `<div class="stat ${(y > x) === up ? 'good' : 'badc'}">${f(y)} ${label} <span class="mutedtxt">(${f(x)})</span></div>`);
    return `<div class="gh">Against your ${escapeHtml(hd.name)}</div>${out.length ? out.join('') : '<div class="stat mutedtxt">No difference</div>'}`;
  }

  private supplyDetail(id: SupplyId): string {
    const p = this.p!;
    const n = supplyCountText(this.c, id);
    const drug = isDrug(id) ? DRUGS[id] : null;
    const kind = drug ? `DRUG · ${drug.cls.toUpperCase()}` : id === 'bandage' || id === 'medkit' ? 'MEDICINE' : 'FOOD AND WATER';
    const out: string[] = [];
    out.push(`<div class="bigcard sup"${drug ? ` style="--dc:${drug.color}"` : ''}><div class="bigic">${supplyIcon(id)}</div><div><h3 class="rname">${escapeHtml(supplyName(id))}</h3><div class="sub2">${kind} · ${escapeHtml(n)} IN THE STORES</div></div></div>`);
    out.push(`<p class="blurb">${escapeHtml(supplyBlurb(id))}</p>`);
    if (drug && isDrug(id)) {
      const f = drugFacts(id, p.drugs);
      out.push(`<div class="stat">${escapeHtml(timelineText(drug))}</div>`);
      out.push(`<div class="stat mutedtxt">${escapeHtml(kicksInText(drug))}</div>`);
      if (f.effects.length) out.push(`<div class="gh">What it does</div>${f.effects.map(factHtml).join('')}`);
      if (f.risks.length) out.push(`<div class="gh">Risks</div>${f.risks.map(factHtml).join('')}`);
      if (f.now.length) out.push(`<div class="gh">For you, now</div>${f.now.map(factHtml).join('')}`);
    } else if (id === 'bandage' || id === 'medkit') {
      out.push(`<div class="stat good">${id === 'bandage' ? `Stops bleeding · +${BLEED.bandageHeal} HP` : `Stops bleeding · +${MEDKIT_HEAL} HP · draws venom`}</div>`);
      out.push(`<div class="gh">Who needs it</div>${this.woundLine(p, 'You')}`);
      const who = this.partner;
      if (who && !this.c.solo) out.push(this.woundLine(who, who.name, Math.hypot(who.pos.x - p.pos.x, who.pos.z - p.pos.z)));
    } else if (id === 'ration') {
      out.push(`<div class="stat ${p.needs.food < 0.4 ? 'badc' : ''}">You are ${Math.round(p.needs.food * 100)}% fed</div>`);
    } else if (id === 'water') {
      out.push(`<div class="stat ${p.needs.water < 0.4 ? 'badc' : ''}">You are ${Math.round(p.needs.water * 100)}% watered</div>`);
    }
    if (!this.menu) out.push(`<div class="mutedtxt pad hintline">${escapeHtml(this.key('A'))} or a click: take it, or put it on the quick belt</div>`);
    return out.join('');
  }

  private woundLine(who: Player, name: string, dist?: number): string {
    const parts: string[] = [`${Math.round(who.hp)}/${who.maxHp} HP`];
    if (who.bleed.level > 0) parts.push(`bleeding ×${who.bleed.level}`);
    if (who.venom.dose > 0) parts.push(who.venom.bound ? 'venom, bound' : 'venom spreading');
    if (who.state === 'downed') parts.push('down');
    if (dist !== undefined) parts.push(`${Math.round(dist)} m away`);
    const bad = who.bleed.level > 0 || who.venom.dose > 0 || who.hp < who.maxHp * 0.5;
    return `<div class="stat ${bad ? 'badc' : 'mutedtxt'}">${escapeHtml(name)}: ${escapeHtml(parts.join(' · '))}</div>`;
  }

  private utilDetail(u: Utility): string {
    const n = u === 'horn' ? 'NEVER RUNS OUT' : `${this.c.items[u]} IN THE STORES`;
    const held = this.loadout.sel === UTILITY_SLOT && this.p!.utility === u;
    return `<div class="bigcard"><div class="bigic">${itemIcon(UTILITY_ICON[u])}</div><div><h3 class="rname">${escapeHtml(utilityName(u))}</h3><div class="sub2">THROWABLE · ${n}${held ? ' · IN HAND' : ''}</div></div></div><p class="blurb">${escapeHtml(UTILITY_BLURB[u])}</p>`;
  }

  /** The context menu beside the picked tile: a heading, its rows (greyed with the reason when they cannot be done), the belt slots as one row of squares. */
  menuHtml(): string {
    if (!this.menu || !this.p) return '';
    const t = this.menu.t;
    if (!this.valid(t)) {
      this.menu = null;
      return '';
    }
    const items = (this.menuItems = menuFor(this.mh, t));
    const slot = this.host.slot(this.p.index);
    const kb = slot?.kind === 'kb';
    const reserved = kb ? reservedKeys(slot.set) : null;
    const keyCap = (k: string) => (kb && k && !reserved!.has(k.length === 1 && k >= '0' && k <= '9' ? `Digit${k}` : `Key${k}`) ? `<kbd>${k}</kbd>` : '');
    const rows: string[] = [];
    let chips: string[] = [];
    let chipHead = '';
    const flush = () => {
      if (!chips.length) return;
      rows.push(`<div class="mchips"><span class="mcl">${chipHead}</span>${chips.join('')}</div>`);
      chips = [];
    };
    const dflt = defaultAction(items);
    for (const m of items) {
      if (m.chip) {
        if (!chips.length) chipHead = m.id.startsWith('a-mv') ? 'Move to slot' : 'Or belt slot';
        chips.push(this.btn(m.id, `${m.label}<small>${escapeHtml(m.note ?? '')}</small>`, () => m.run(), m.enabled, 'mchip', m.reason ?? `Belt slot ${m.label}`));
        continue;
      }
      flush();
      const note = m.note ? `<em>${escapeHtml(m.note)}</em>` : '';
      const why = !m.enabled && m.reason ? `<small class="why">${escapeHtml(m.reason)}</small>` : '';
      const pad = !kb && m === dflt ? `<kbd class="pad">${escapeHtml(this.key('X'))}</kbd>` : '';
      rows.push(this.btn(m.id, `<span class="ml">${escapeHtml(m.label)}${why}</span>${note}${keyCap(m.key)}${pad}`, () => m.run(), m.enabled, `mrow${m.danger ? ' danger' : ''}`, m.reason ?? ''));
    }
    flush();
    const icon = t.kind === 'gear' ? (() => {
      const s = findItem(this.loadout, t.uid);
      const it = s ? itemAt(this.loadout, s) : null;
      return it ? cachedIcon(gearDef(it.id), this.p!.index, it.att) : '';
    })() : t.kind === 'supply' ? supplyIcon(t.id) : itemIcon(UTILITY_ICON[t.id]);
    const foot = kb ? `${escapeHtml(this.key('A'))} or a key · ${escapeHtml(this.key('B'))} back` : `${escapeHtml(this.key('A'))} choose · ${escapeHtml(this.key('B'))} back`;
    return `<div class="mhead"><span class="mic">${icon}</span><b>${escapeHtml(targetName(this.mh, t))}</b></div>${rows.join('')}<div class="mfoot">${foot}</div>`;
  }

  /** The three columns, and the menu when one is open (as one string, for the Dawn Ledger's full redraw). */
  columnsHtml(): string {
    const menu = this.menuHtml();
    return `
        <section class="invcol wearcol${this.custom ? ' hidewear' : ''}">${this.wearHtml()}</section>
        <section class="invcol packcol">${this.packHtml()}</section>
        <section class="invcol detail">${this.detailHtml()}</section>${menu ? `<div class="invmenu">${menu}</div>` : ''}`;
  }

  /** The line under the panel: the last result, else what the buttons do here. */
  hintText(fid: string | null): string {
    if (this.msg) return this.msg;
    const s = (b: string) => this.key(b);
    if (this.menu) return `${s('A')} choose · ${s('B')} back · right click elsewhere closes`;
    if (this.custom) return `${s('A')} pick a slot or an add-on · ${s('B')} close`;
    const q = this.quickLabel(fid);
    return `${s('A')} or click: actions${q ? ` · ${s('X')} or double click: ${q}` : ''} · right click: actions · ${s('B')} close`;
  }

  /** Put the menu beside the tile it belongs to, inside the panel and clear of its edges. */
  placeMenu(panel: HTMLElement) {
    const m = panel.querySelector<HTMLElement>('.invmenu');
    if (!m) return;
    if (!this.menu) {
      m.hidden = true;
      return;
    }
    m.hidden = false;
    const anchor = panel.querySelector<HTMLElement>(`[data-fid="${CSS.escape(this.menu.key)}"]`);
    // A tile picked by a key press can sit scrolled out of its column: bring it into view so the menu has something to stand by.
    anchor?.scrollIntoView?.({ block: 'nearest' });
    const pr = panel.getBoundingClientRect();
    const mr = m.getBoundingClientRect();
    const ar = anchor?.getBoundingClientRect() ?? { left: pr.left + pr.width / 2, right: pr.left + pr.width / 2, top: pr.top + pr.height / 3 };
    let x = ar.right - pr.left + 6;
    if (x + mr.width > pr.width - 6) x = ar.left - pr.left - mr.width - 6;
    x = Math.max(6, Math.min(x, pr.width - mr.width - 6));
    const y = Math.max(6, Math.min(ar.top - pr.top - 4, pr.height - mr.height - 6));
    m.style.left = `${Math.round(x)}px`;
    m.style.top = `${Math.round(y)}px`;
  }

  /**
   * The mouse on the panel: a right click opens a tile's menu (or closes the open one), a double click does the obvious thing,
   * hovering moves the cursor, and a click outside an open menu closes it. Returns a function that takes it all off again.
   */
  bindEvents(panel: HTMLElement): () => void {
    const fidAt = (e: Event) => (e.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-fid]') ?? null;
    const isTile = (fid: string) => !!targetOf(this.loadout, fid);
    const ctx = (e: MouseEvent) => {
      e.preventDefault();
      if (!this.p) return;
      const el = fidAt(e);
      const fid = el?.dataset.fid;
      if (fid && isTile(fid)) {
        const t = targetOf(this.loadout, fid)!;
        this.openMenu(t, fid, this.p.index);
      } else if (this.menu && !(e.target as HTMLElement).closest('.invmenu')) this.closeMenu();
    };
    const dbl = (e: MouseEvent) => {
      if (!this.p) return;
      const fid = fidAt(e)?.dataset.fid;
      if (!fid || !isTile(fid)) return;
      this.menu = null;
      this.quick(fid);
    };
    const down = (e: PointerEvent) => {
      if (!this.menu || e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest('.invmenu')) return;
      const fid = fidAt(e)?.dataset.fid;
      // Another tile: its own click opens its menu in place of this one.
      if (fid && isTile(fid)) return;
      this.closeMenu();
    };
    let lastOver: HTMLElement | null = null;
    const over = (e: MouseEvent) => {
      const el = fidAt(e);
      if (!el || el === lastOver) return;
      lastOver = el;
      this.host.hover?.(el);
    };
    panel.addEventListener('contextmenu', ctx);
    panel.addEventListener('dblclick', dbl);
    panel.addEventListener('pointerdown', down, true);
    panel.addEventListener('mouseover', over);
    return () => {
      panel.removeEventListener('contextmenu', ctx);
      panel.removeEventListener('dblclick', dbl);
      panel.removeEventListener('pointerdown', down, true);
      panel.removeEventListener('mouseover', over);
    };
  }

  // ------------------------------------------------------------------ customise

  /** What a list of changes reads like: green for good, red for bad. */
  private lines(ls: KitLine[]): string {
    return `<span class="deltas">${ls.map((l) => `<span class="stat ${l.good ? 'good' : 'badc'}">${escapeHtml(l.text)}</span>`).join('')}</span>`;
  }

  /**
   * The customise panel: the gun's slots, and for the one chosen, what is fitted and every add-on in the bag that fits it with
   * what it would change. Every choice is a button, so the controller walks it like the rest of the screen.
   */
  private customHtml(it: GearItem): string {
    const p = this.p!;
    const L = this.loadout;
    const d = gearDef(it.id);
    const kit = kitOf(it);
    const out: string[] = [];
    out.push(`<h3>Customise ${this.btn('c-back', 'Done', () => this.closeCustom(), true, 'chipbtn sortbtn', 'Back to the details')}</h3>`);
    out.push(`<div class="bigcard r${d.rarity}"><div class="bigic">${cachedIcon(d, p.index, it.att)}</div><div><h3 class="rname r${d.rarity}">${escapeHtml(d.name)}</h3><div class="sub2">${kit.count} OF ${slotsOfGun(d).length} SLOTS FITTED</div></div></div>`);
    for (const l of describeWeapon(d, it)) out.push(`<div class="stat">${escapeHtml(l)}</div>`);
    if (kit.zoom > 1.01) out.push(`<div class="stat">${kit.zoom.toFixed(1)}x zoom when aiming</div>`);
    out.push(`<div class="gh">Slots</div><div class="slotlist">`);
    for (const slot of slotsOfGun(d)) {
      const f = it.att?.[slot];
      const fd = f ? gearDef(f) : null;
      const on = this.cslot === slot ? ' on' : '';
      out.push(
        this.btn(
          `cs:${slot}`,
          `<span class="mini">${fd ? cachedIcon(fd, p.index) : ''}</span><b>${escapeHtml(ATTACH_LABELS[slot])}</b><em>${fd ? escapeHtml(fd.name) : 'empty'}</em>`,
          () => {
            this.cslot = slot;
            this.msg = '';
            this.host.rerender();
          },
          true,
          `slotrow${on}${fd ? ` r${fd.rarity}` : ''}`,
        ),
      );
    }
    out.push('</div>');

    const slot = this.cslot && slotsOfGun(d).includes(this.cslot) ? this.cslot : null;
    if (slot) {
      const fid = it.att?.[slot];
      out.push(`<div class="gh">${escapeHtml(ATTACH_LABELS[slot])}</div>`);
      if (fid) {
        const fd = gearDef(fid);
        out.push(`<div class="stat">${escapeHtml(fd.name)}: ${this.lines(describeMod(fd.mod!))}</div>`);
        const room = L.bag.length < bagCap(L);
        const off = compareKits(kit, kitWith(it, slot, null));
        out.push(`<div class="invacts">${this.btn('c-remove', `Take it off <em>to the bag</em>`, () => this.detach(it.uid, slot), room, '', room ? 'Back to the bag' : 'Your bag has no room')}</div>`);
        if (off.length) out.push(`<div class="mutedtxt">Without it: ${this.lines(off)}</div>`);
      }
      const cands = L.bag.filter((b) => gearDef(b.id).mod?.slot === slot && canFit(it.id, b.id));
      if (!cands.length) out.push(`<div class="mutedtxt pad">${fid ? 'Nothing else in your bag fits this slot.' : 'Nothing in your bag fits this slot. Add-ons turn up in gun shops, police and army caches, raiders kit and the odd locker.'}</div>`);
      else {
        out.push(`<div class="invacts cands">`);
        for (const c of cands) {
          const cd = gearDef(c.id);
          const diff = compareKits(kit, kitWith(it, slot, c.id));
          out.push(
            this.btn(
              `cand:${c.uid}`,
              `<span class="mini">${cachedIcon(cd, p.index)}</span><b>${escapeHtml(cd.name)}</b><i class="pip r${cd.rarity}">${'◆'.repeat(cd.rarity)}</i>${diff.length ? this.lines(diff) : '<span class="deltas"><span class="stat mutedtxt">no change</span></span>'}`,
              () => this.fit(it.uid, c.uid),
              true,
              `cand r${cd.rarity}`,
              fid ? `Swap for the ${gearDef(fid).name}` : 'Fit it',
            ),
          );
        }
        out.push('</div>');
      }
    } else out.push(`<div class="mutedtxt pad">Pick a slot to see what is fitted and what could go there. Each add-on lists what it changes before you fit it.</div>`);
    return out.join('');
  }

  closeCustom() {
    if (!this.custom) return;
    this.focusNext = fidOf(this.loadout, { kind: 'gear', uid: this.custom });
    this.custom = null;
    this.cslot = null;
    this.host.audio.play('confirm');
    this.host.rerender();
  }
}

/** Keyboard codes a keyboard layout steers menus with (move, confirm, cancel, the quick action, the inventory key): never menu shortcuts. */
export function reservedKeys(set: 1 | 2): Set<string> {
  const k = live.bindings.kb[set - 1];
  const out = new Set<string>(['Escape', 'Tab']);
  for (const a of ['moveUp', 'moveDown', 'moveLeft', 'moveRight', 'interact', 'fire', 'crouch', 'reload', 'inventory'] as const) {
    const c = k[a];
    if (c) out.add(c);
  }
  return out;
}

/** Where a seat's panel goes: always within that seat's own half of a split screen. */
function sideFor(seats: number, layout: 'horizontal' | 'vertical', index: number): string {
  if (seats === 1) return 'right';
  if (layout === 'vertical') return index === 0 ? 'left' : 'right';
  return index === 0 ? 'top' : 'bottom';
}

/**
 * The inventory screen: opens over the game, pauses it, and puts the owner's camera into a slow orbit of their survivor
 * so every change shows. The owner alone has a cursor. The panel is drawn once and each part of it (the three columns, the
 * menu, the hint) is redrawn only when its own HTML changes, so moving the cursor or picking an item touches a column at most.
 */
export class InventoryScreen implements InventoryHost {
  private acts = new Map<string, Act>();
  private view = new InventoryView(this);
  private p: Player | null = null;
  private side = 'right';
  private prevTick: typeof this.game.focus.onTick = null;
  private panel: HTMLElement | null = null;
  private parts: { el: HTMLElement; html: string }[] = [];
  private hintEl: HTMLElement | null = null;
  private menuEl: HTMLElement | null = null;
  private wearEl: HTMLElement | null = null;
  private unbind: (() => void) | null = null;
  private lastFid: string | null = null;
  private selEl: HTMLElement | null = null;
  readonly field = true;
  /** Milliseconds the last redraw took (building the strings, the DOM changes and re-pointing focus). */
  lastMs = 0;
  /** Parts replaced by the last redraw, for a profiler. */
  lastReplaced = 0;

  constructor(
    private game: Game,
    private root: HTMLElement,
    private onClose: () => void,
  ) {}

  get c() {
    return this.game.campaign;
  }
  get audio() {
    return this.game.audio;
  }
  slot(i: number) {
    return this.game.input.slots[i];
  }
  btn(id: string, inner: string, act: Act, enabled = true, cls = '', title = ''): string {
    this.acts.set(id, act);
    return `<button data-fid="${id}" class="${cls}" ${enabled ? '' : 'disabled'} title="${escapeHtml(title)}">${inner}</button>`;
  }
  rerender() {
    this.render();
  }
  hover(el: HTMLElement) {
    const f = this.game.focus;
    if (!this.p) return;
    const i = f.items.findIndex((it) => it.el === el);
    if (i >= 0 && i !== f.cursor[this.p.index]) {
      f.cursor[this.p.index] = i;
      f.paint();
    }
  }

  open(p: Player) {
    this.p = p;
    this.view.reset(p);
    this.view.liveSel = true;
    p.moveSpeed = 0;
    const R = this.game.R;
    // In split screen the panel stays in the owner's half; solo, it takes the right and the survivor stands in the left.
    this.side = sideFor(R.seats, R.layout, p.index);
    p.showcase = { a: p.yaw + 0.55, side: R.seats === 1 ? 1.0 : 0 };
    const f = this.game.focus;
    f.active = true;
    f.owner = p.index;
    f.cursor[p.index] = 0;
    f.onCancel = () => this.close();
    this.prevTick = f.onTick;
    f.onTick = (input) => this.tick(input);
    const name = escapeHtml(this.c.players[p.index].name.toUpperCase());
    this.root.classList.add('on');
    this.root.innerHTML = `<div class="ledger panel paper inv ${this.side}">
      <h2><span><span class="pcolor" style="background:${PLAYER_CSS[p.index]}"></span>Inventory · ${name}</span><small>THE GAME IS PAUSED</small></h2>
      <div class="invbody"><section class="invcol wearcol"></section><section class="invcol packcol"><div class="pk"></div><div class="pk"></div><div class="pk"></div></section><section class="invcol detail"></section></div>
      <div class="benchfoot"><span class="mutedtxt invhint"></span><span class="invfoot"></span></div>
      <div class="invmenu" hidden></div>
    </div>`;
    const panel = (this.panel = this.root.firstElementChild as HTMLElement);
    const q = (s: string) => panel.querySelector<HTMLElement>(s)!;
    this.wearEl = q('.wearcol');
    this.menuEl = q('.invmenu');
    this.hintEl = q('.invhint');
    const [hand, sup, bag] = panel.querySelectorAll<HTMLElement>('.packcol > .pk');
    this.parts = [this.wearEl, hand, sup, bag, q('.detail'), this.menuEl, q('.invfoot')].map((el) => ({ el, html: '' }));
    this.unbind = this.view.bindEvents(panel);
    window.addEventListener('resize', this.onResize);
    this.lastFid = null;
    this.render();
  }

  /** The window changed size: the menu follows its tile. */
  private onResize = () => {
    if (this.panel) this.view.placeMenu(this.panel);
  };

  /** Step back: Escape and B close an open menu first, then the screen. */
  close() {
    if (this.view.menu) return this.view.closeMenu();
    if (this.view.custom) return this.view.closeCustom();
    this.shut();
  }

  /** Close the screen, whatever is open on it. */
  shut() {
    const f = this.game.focus;
    f.clear();
    f.active = false;
    f.owner = null;
    f.onCancel = () => {};
    f.onTick = this.prevTick;
    if (this.p) this.p.showcase = null;
    this.unbind?.();
    this.unbind = null;
    window.removeEventListener('resize', this.onResize);
    this.root.innerHTML = '';
    this.root.classList.remove('on');
    this.panel = null;
    this.parts = [];
    this.p = null;
    this.onClose();
  }

  /** Every fixed tick while open: the inventory key closes, X does the obvious thing, keys run menu rows, and the detail follows the cursor. */
  private tick(input: Game['input']) {
    const p = this.p;
    if (!p) return;
    const f = this.game.focus;
    const it = input.intents[p.index];
    if (wasPressed(it, Btn.Inventory)) return this.shut();
    const fid = f.items[f.cursor[p.index]]?.el.dataset.fid ?? null;
    const slot = this.slot(p.index);
    // Menu shortcuts first: a letter can also be bound to something that drives X (the horn key), and the row it names wins.
    if (this.view.menu && slot?.kind === 'kb') {
      const reserved = reservedKeys(slot.set);
      for (const m of this.view.menuItems) {
        if (!m.key || !m.enabled) continue;
        const code = m.key >= '0' && m.key <= '9' ? `Digit${m.key}` : `Key${m.key}`;
        if (!reserved.has(code) && input.wasKeyPressed(code)) return void m.run();
      }
    }
    // X on a pad; on keys only the reload key itself, not another key that happens to drive the same button.
    const x = slot?.kind === 'kb' ? input.wasKeyPressed(live.bindings.kb[slot.set - 1].reload ?? '') : wasPressed(it, Btn.X);
    if (x) return this.view.quick(fid ?? '');
    if (fid !== this.lastFid) {
      this.lastFid = fid;
      if (!this.view.menu && this.view.setPeek(fid)) this.render();
      else this.setHint(fid);
    }
  }

  private setHint(fid: string | null) {
    const t = this.view.hintText(fid);
    if (this.hintEl && this.hintEl.textContent !== t) this.hintEl.textContent = t;
  }

  render() {
    const g = this.game;
    const p = this.p;
    const panel = this.panel;
    if (!p || !panel) return;
    const t0 = performance.now();
    const v = this.view;
    this.acts.clear();
    // The strings first: building them registers the buttons' actions.
    const html = [v.wearHtml(), v.handHtml(), v.supHtml(), v.bagHtml(), v.detailHtml(), v.menuHtml(), this.btn('invdone', 'Back to the road', () => this.shut())];
    let replaced = 0;
    for (let i = 0; i < html.length; i++) {
      const part = this.parts[i];
      if (part.html === html[i]) continue;
      part.html = html[i];
      part.el.innerHTML = html[i];
      replaced++;
    }
    this.wearEl!.classList.toggle('hidewear', !!v.custom);
    // The picked tile's highlight, moved by hand so picking never redraws a grid.
    const sf = v.selFid();
    const sel = sf ? panel.querySelector<HTMLElement>(`[data-fid="${CSS.escape(sf)}"]`) : null;
    if (sel !== this.selEl) {
      this.selEl?.classList.remove('sel');
      this.selEl = sel;
    }
    sel?.classList.add('sel');
    const f = g.focus;
    if (replaced) {
      // (The panel takes the pointer in the stylesheet, buttons and all, so nothing here touches every button's style.)
      v.placeMenu(panel);
      // With a menu open, only its rows take the cursor: it is modal until it closes.
      const scope = v.menu ? this.menuEl! : panel;
      const keys = f.keys();
      if (v.focusNext) keys[p.index] = v.focusNext;
      v.focusNext = null;
      const items: FocusItem[] = [];
      for (const el of scope.querySelectorAll<HTMLElement>('[data-fid]')) {
        const id = el.dataset.fid!;
        if (!this.acts.has(id)) continue;
        items.push({ el, press: (pl) => this.acts.get(id)?.(pl), disabled: (el as HTMLButtonElement).disabled });
      }
      f.setItems(items, keys);
      f.active = true;
    }
    this.lastFid = f.items[f.cursor[p.index]]?.el.dataset.fid ?? null;
    this.setHint(this.lastFid);
    this.lastReplaced = replaced;
    this.lastMs = performance.now() - t0;
  }
}
