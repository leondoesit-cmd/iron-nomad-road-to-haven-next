import { GEAR, WEAR_SLOTS, gearDef, type GearDef, type WearSlot } from '../data';
import { PLAYER_CSS } from '../render/palette';
import { Btn, wasPressed } from '../input/intents';
import { RARITY_NAMES } from '../sim/parts';
import {
  BELT_SIZE,
  UTILITY_SLOT,
  bagCap,
  compareStats,
  describeStats,
  describeWeapon,
  equipFromBag,
  findItem,
  giveItem,
  itemAt,
  moveBelt,
  repairItem,
  repairPrice,
  scrapOf,
  sortBag,
  statsOf,
  takeFromBag,
  unequipBelt,
  unequipWorn,
  type GearItem,
  type Result,
} from '../sim/gear';
import { MEDKIT_HEAL, UTILITIES, utilityName, type Player } from '../game/player';
import { BLEED, STAMINA, wearLabel, wearOf } from '../sim/vitals';
import type { Game } from '../game/game';
import type { Campaign } from '../game/campaign';
import type { Slot } from '../input/input';
import { btnLabel, escapeHtml } from './hud';
import type { FocusItem } from './focus';
import { dollSvg, gearIcon, itemIcon, slotGlyph } from './gearIcons';

type Act = (player: number) => void;

const KIND_LABEL: Record<GearDef['kind'], string> = { wear: 'Worn', gun: 'Firearm', melee: 'Melee', tool: 'Tool' };
const UTILITY_SHORT: Record<(typeof UTILITIES)[number], string> = { flare: 'Flare', molotov: 'Molotov', charge: 'Charge', horn: 'Horn' };

const UTILITY_ICON = { flare: 'flare', molotov: 'molotov', charge: 'charge', horn: 'horn' } as const;

/** What a view needs from whatever hosts it: the pause screen, or the Dawn Ledger's Gear tab. */
export interface InventoryHost {
  c: Campaign;
  audio: { play(id: string): void };
  /** The input slot of a seat, for naming its buttons. */
  slot(i: number): Slot | null;
  btn(id: string, inner: string, act: Act, enabled?: boolean, cls?: string, title?: string): string;
  rerender(): void;
}

/**
 * One person's gear as three columns: what they wear, what is in hand and in the bag, and the selected item with
 * what can be done to it. Pure HTML plus actions; the host owns focus and rendering.
 */
export class InventoryView {
  p: Player | null = null;
  /** The item shown in the detail column. */
  sel: string | null = null;
  msg = '';

  constructor(private host: InventoryHost) {}

  private get c() {
    return this.host.c;
  }
  private get loadout() {
    return this.p!.gear;
  }

  reset(p: Player) {
    this.p = p;
    this.sel = null;
    this.msg = '';
  }

  /** X: do the obvious thing with the item under the cursor, given its focus id. */
  quick(id: string) {
    const [zone, key] = id.split(':');
    if (zone === 'bag') this.act(equipFromBag(this.loadout, key));
    else if (zone === 'worn') this.act(unequipWorn(this.loadout, key as WearSlot));
    else if (zone === 'belt') this.act(unequipBelt(this.loadout, Number(key)));
  }

  // ------------------------------------------------------------------ actions

  /** Run a loadout change, report it, and bring the survivor and the screen up to date. */
  private act(r: Result) {
    this.msg = r.ok ? r.note : r.reason;
    this.host.audio.play(r.ok ? 'confirm' : 'deny');
    if (r.ok) this.p!.refreshGear();
    this.host.rerender();
  }

  private scrap(uid: string) {
    const it = takeFromBag(this.loadout, uid);
    if (!it) return;
    const n = scrapOf(it);
    this.c.stocks.scrap += n;
    this.sel = null;
    this.act({ ok: true, note: `Broke down the ${gearDef(it.id).name}: +${n} Scrap` });
  }

  private give(uid: string) {
    const p = this.p!;
    if (this.c.solo) return;
    const r = giveItem(this.loadout, this.c.players[1 - p.index].gear, uid);
    if (r.ok) this.sel = null;
    this.act(r);
  }

  private heal(kind: 'medkit' | 'bandage' = 'medkit') {
    const p = this.p!;
    if (this.c.items[kind] <= 0 || (p.hp >= p.maxHp - 0.5 && p.bleed.level <= 0)) return;
    const before = p.hp;
    // The same rules as the quick belt, minus the busy hands: nobody is shooting at you in here.
    if (!p.useDressing(kind)) return;
    p.fireCd = 0;
    p.meleeCd = 0;
    this.msg = `${kind === 'medkit' ? 'Patched up' : 'Bandaged'}: +${Math.round(p.hp - before)} HP`;
    this.host.audio.play('confirm');
    this.host.rerender();
  }

  private repair(uid: string) {
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

  private pickUtility(u: (typeof UTILITIES)[number]) {
    const p = this.p!;
    p.utility = u;
    this.c.players[p.index].utility = u;
    this.loadout.sel = UTILITY_SLOT;
    p.syncEquip();
    this.msg = `${utilityName(u)} in hand`;
    this.host.audio.play('confirm');
    this.host.rerender();
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
      const g = ghost ? slotGlyph(ghost) : '';
      return `<button class="tile empty ${zone}" disabled data-slot="${id}"><span class="ic">${g}</span><small>${label}</small></button>`;
    }
    const d = gearDef(it.id);
    const on = this.sel === it.uid ? ' sel' : '';
    const hl = held ? ' held' : '';
    const mag = d.gun && it.mag !== undefined ? `<em class="cnt">${it.mag}</em>` : '';
    const wear = (d.gun || d.melee) && wearOf(it.cond) < 0.995 ? `<u class="wear ${wearOf(it.cond) < 0.3 ? 'bad' : wearOf(it.cond) < 0.6 ? 'mid' : ''}" style="--w:${Math.round(wearOf(it.cond) * 100)}%"></u>` : '';
    return this.btn(
      id,
      `<span class="ic">${gearIcon(d, this.p!.index)}</span><small>${label}</small>${mag}${wear}<i class="pip r${d.rarity}">${'◆'.repeat(d.rarity)}</i>`,
      () => {
        this.sel = it.uid;
        this.msg = '';
        this.host.rerender();
      },
      true,
      `tile r${d.rarity} ${zone}${on}${hl}`,
      d.name,
    );
  }

  /** The three columns. */
  columnsHtml(): string {
    const p = this.p!;
    const L = this.loadout;
    const stats = statsOf(L);

    // ---- wearing: the survivor in the middle, a square for each place on the body around them
    const slotTile = (slot: WearSlot) => this.itemBtn('worn', slot, L.worn[slot] ?? null, GEAR.labels[slot], false, slot);
    const doll = `<div class="doll">
        <div class="dollcol">${(['head', 'body', 'hands', 'feet'] as const).map(slotTile).join('')}</div>
        <div class="dollfig">${dollSvg(L.worn, p.index)}</div>
        <div class="dollcol">${(['face', 'back', 'legs'] as const).map(slotTile).join('')}</div>
      </div>`;

    // ---- belt and utility
    const belt = Array.from({ length: BELT_SIZE }, (_, i) => {
      const it = L.belt[i] ?? null;
      const t = this.itemBtn('belt', i, it, it ? gearDef(it.id).short ?? gearDef(it.id).name : 'Free', L.sel === i);
      return t.replace('class="', `data-n="${i + 1}" class="`);
    }).join('');
    const util = UTILITIES.map((u) => {
      const n = u === 'horn' ? '∞' : String(this.c.items[u]);
      return this.btn(`util:${u}`, `<span class="ic">${itemIcon(UTILITY_ICON[u])}</span><small>${UTILITY_SHORT[u]}</small><em class="cnt">${n}</em>`, () => this.pickUtility(u), true, `tile util${p.utility === u ? ' held' : ''}`, UTILITY_SHORT[u]);
    }).join('');

    // ---- bag
    const cap = bagCap(L);
    const cells: string[] = [];
    for (let i = 0; i < Math.max(cap, L.bag.length); i++) {
      const it = L.bag[i] ?? null;
      cells.push(this.itemBtn('bag', it?.uid ?? `e${i}`, it, it ? gearDef(it.id).short ?? gearDef(it.id).name : i < cap ? '' : 'Over'));
    }
    const over = L.bag.length > cap ? ' bad' : '';

    // ---- effects, in words
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


    return `
        <section class="invcol">
          <h3>Wearing</h3>
          ${doll}
          <div class="effects">${eff.length ? eff.join('') : '<span class="mutedtxt">No bonuses or penalties</span>'}</div>
        </section>
        <section class="invcol">
          <h3>In hand <small>${escapeHtml(this.key('LB'))} swaps</small></h3>
          <div class="invbelt">${belt}</div>
          <div class="invutil">${util}</div>
          <h3>Bag <small class="${over}">${L.bag.length}/${cap}</small>${this.btn('sortbag', 'Sort', () => this.sort(), L.bag.length > 1, 'chipbtn sortbtn', 'Guns, blades, tools, then clothes')}</h3>
          <div class="invbag">${cells.join('')}</div>
          <div class="invsupply">${this.supplyHtml()}</div>
        </section>
        <section class="invcol detail">${this.detailHtml()}</section>`;
  }

  /** The medkit button, for the footer. */
  footHtml(): string {
    const p = this.p!;
    const hurt = p.hp < p.maxHp - 0.5 || p.bleed.level > 0;
    const meds = this.c.items.medkit;
    const bands = this.c.items.bandage;
    const bandage = this.btn('heal-b', `<span class="mini">${itemIcon('medkit')}</span>Bandage <em>×${bands}</em>`, () => this.heal('bandage'), bands > 0 && hurt, '', hurt ? (bands > 0 ? `Stops bleeding, +${BLEED.bandageHeal} HP` : 'No bandages: craft some at camp') : 'You are not hurt');
    const kit = this.btn('heal', `<span class="mini">${itemIcon('medkit')}</span>Medkit <em>×${meds}</em>`, () => this.heal('medkit'), meds > 0 && hurt, '', hurt ? (meds > 0 ? `Patch yourself up: +${MEDKIT_HEAL} HP and stop any bleeding` : 'No medkits: craft some at camp') : 'You are not hurt');
    return bandage + kit;
  }

  /** Ammunition, dressings and how the body is doing: the numbers a fight turns on. */
  private supplyHtml(): string {
    const p = this.p!;
    const it = this.c.items;
    const chip = (label: string, v: string, cls = '') => `<span class="pill ${cls}">${label} ${v}</span>`;
    const wounds = p.bleed.level > 0 ? chip('Bleeding', `×${p.bleed.level}`, 'badc') : '';
    return [
      chip('Rounds', String(this.c.ammo), this.c.ammo < 20 ? 'badc' : 'good'),
      chip('Bandages', String(it.bandage), it.bandage ? 'good' : 'badc'),
      chip('Medkits', String(it.medkit), it.medkit ? 'good' : 'badc'),
      chip('Health', `${Math.round(p.hp)}/${p.maxHp}`, p.hp < p.maxHp * 0.5 ? 'badc' : 'good'),
      chip('Wind', `${Math.round((p.stamina.value / STAMINA.max) * 100)}%`, p.stamina.winded ? 'badc' : 'good'),
      wounds,
    ].join('');
  }

  /** The right-hand column: what the selected item is, how it compares with what is worn, and what can be done with it. */
  private detailHtml(): string {
    const p = this.p!;
    const L = this.loadout;
    const spot = this.sel ? findItem(L, this.sel) : null;
    const it = spot ? itemAt(L, spot) : null;
    if (!it || !spot) {
      return `<h3>Details</h3><div class="mutedtxt pad">Pick something to see what it does, and what you can do with it.<br><br>Wear things on your body for armour, stealth and room in the bag. Put weapons and tools on the belt: whatever is in hand is what the buttons use.</div>`;
    }
    const d = gearDef(it.id);
    const lines: string[] = [];
    lines.push(`<div class="bigcard r${d.rarity}"><div class="bigic">${gearIcon(d, p.index)}</div><div><h3 class="rname r${d.rarity}">${escapeHtml(d.name)}</h3>`);
    lines.push(`<div class="sub2">${RARITY_NAMES[d.rarity].toUpperCase()} · ${d.slot ? GEAR.labels[d.slot].toUpperCase() : KIND_LABEL[d.kind].toUpperCase()}${spot.zone === 'bag' ? '' : ' · ' + (spot.zone === 'worn' ? 'WORN' : 'ON THE BELT')}</div></div></div>`);
    lines.push(`<p class="blurb">${escapeHtml(d.blurb)}</p>`);
    for (const l of describeStats(d.stats)) lines.push(`<div class="stat ${l.good ? 'good' : 'badc'}">${escapeHtml(l.text)}</div>`);
    for (const l of describeWeapon(d)) lines.push(`<div class="stat">${escapeHtml(l)}</div>`);
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

    const acts: string[] = [];
    const fix = repairPrice(it);
    if (fix > 0) acts.push(this.btn('a-repair', `Repair <em>${fix} Scrap</em>`, () => this.repair(it.uid), this.c.stocks.scrap >= fix, '', this.c.stocks.scrap >= fix ? 'Back to like-new' : `You have ${Math.floor(this.c.stocks.scrap)} Scrap`));
    if (spot.zone === 'bag') {
      if (d.kind === 'wear') acts.push(this.btn('a-equip', `Wear it`, () => this.act(equipFromBag(L, it.uid))));
      else {
        acts.push(this.btn('a-equip', `Put it in hand`, () => this.act(equipFromBag(L, it.uid))));
        const slots = Array.from({ length: BELT_SIZE }, (_, i) => {
          const o = L.belt[i];
          return this.btn(`a-slot${i}`, `${i + 1}<small>${o ? escapeHtml(gearDef(o.id).short ?? '') : 'free'}</small>`, () => this.act(equipFromBag(L, it.uid, i)), true, 'chipbtn');
        }).join('');
        acts.push(`<div class="mutedtxt">…or into a belt slot:</div><div class="chips">${slots}</div>`);
      }
      if (!this.c.solo) {
        const them = this.c.players[1 - p.index];
        const room = this.c.players[1 - p.index].gear.bag.length < bagCap(them.gear);
        acts.push(this.btn('a-give', `Give to ${escapeHtml(them.name)}`, () => this.give(it.uid), room, '', room ? '' : 'Their bag is full'));
      }
      acts.push(this.btn('a-scrap', `Break down <em>+${scrapOf(it)} Scrap</em>`, () => this.scrap(it.uid)));
    } else if (spot.zone === 'worn') {
      acts.push(this.btn('a-off', 'Take it off', () => this.act(unequipWorn(L, spot.slot))));
    } else if (spot.zone === 'belt') {
      acts.push(this.btn('a-hold', 'Hold it', () => {
        L.sel = spot.i;
        p.syncEquip();
        this.msg = `${d.name} in hand`;
        this.host.audio.play('confirm');
        this.host.rerender();
      }, L.sel !== spot.i));
      acts.push(this.btn('a-stow', 'Stow it in the bag', () => this.act(unequipBelt(L, spot.i))));
      const others = Array.from({ length: BELT_SIZE }, (_, i) => i).filter((i) => i !== spot.i);
      const mv = others
        .map((i) => this.btn(`a-mv${i}`, `${i + 1}<small>${L.belt[i] ? escapeHtml(gearDef(L.belt[i]!.id).short ?? '') : 'free'}</small>`, () => this.act(moveBelt(L, spot.i, i)), true, 'chipbtn'))
        .join('');
      acts.push(`<div class="mutedtxt">Move to belt slot:</div><div class="chips">${mv}</div>`);
    }
    return `${lines.join('')}<div class="invacts">${acts.join('')}</div>`;
  }
}


/**
 * The inventory screen: opens over the game, pauses it, and puts the owner's camera into a slow orbit of their
 * survivor so every change shows. The owner alone has a cursor.
 */
export class InventoryScreen implements InventoryHost {
  private acts = new Map<string, Act>();
  private view = new InventoryView(this);
  private p: Player | null = null;
  private side: 'left' | 'right' | 'center' = 'right';
  private prevTick: typeof this.game.focus.onTick = null;

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

  open(p: Player) {
    this.p = p;
    this.view.reset(p);
    p.moveSpeed = 0;
    const R = this.game.R;
    // Put the panel on the other half of the screen, so the survivor stays in view in their own.
    this.side = R.seats === 1 ? 'right' : R.layout === 'vertical' ? (p.index === 0 ? 'right' : 'left') : 'center';
    p.showcase = { a: p.yaw + 0.55, side: R.seats === 1 ? 1.0 : 0 };
    const f = this.game.focus;
    f.active = true;
    f.owner = p.index;
    f.cursor[p.index] = 0;
    f.onCancel = () => this.close();
    this.prevTick = f.onTick;
    f.onTick = (input) => {
      if (wasPressed(input.intents[p.index], Btn.Inventory)) return this.close();
      if (wasPressed(input.intents[p.index], Btn.X)) this.view.quick(f.items[f.cursor[p.index]]?.el.dataset.fid ?? '');
    };
    this.render();
  }

  close() {
    const f = this.game.focus;
    f.clear();
    f.active = false;
    f.owner = null;
    f.onCancel = () => {};
    f.onTick = this.prevTick;
    if (this.p) this.p.showcase = null;
    this.root.innerHTML = '';
    this.root.classList.remove('on');
    this.p = null;
    this.onClose();
  }

  render() {
    const g = this.game;
    const p = this.p;
    if (!p) return;
    const keys = g.focus.keys();
    this.acts.clear();
    const name = escapeHtml(this.c.players[p.index].name.toUpperCase());
    const v = this.view;
    const hint = v.msg || `${btnLabel(this.slot(p.index), 'A')} select · ${btnLabel(this.slot(p.index), 'X')} wear or take off · ${btnLabel(this.slot(p.index), 'B')} close`;
    // The columns first: building them registers the buttons' actions.
    const cols = v.columnsHtml();
    this.root.classList.add('on');
    this.root.innerHTML = `<div class="ledger panel paper inv ${this.side}">
      <h2><span><span class="pcolor" style="background:${PLAYER_CSS[p.index]}"></span>Inventory · ${name}</span><small>THE GAME IS PAUSED</small></h2>
      <div class="invbody">${cols}</div>
      <div class="benchfoot"><span class="mutedtxt">${escapeHtml(hint)}</span><span class="invfoot">${v.footHtml()}${this.btn('invdone', 'Back to the road', () => this.close())}</span></div>
    </div>`;
    this.root.querySelectorAll<HTMLElement>('button').forEach((b) => (b.style.pointerEvents = 'auto'));
    const items: FocusItem[] = [];
    this.root.querySelectorAll<HTMLElement>('[data-fid]').forEach((el) => {
      const act = this.acts.get(el.dataset.fid!);
      if (act) items.push({ el, press: (pl) => act(pl), disabled: (el as HTMLButtonElement).disabled });
    });
    g.focus.setItems(items, keys);
    g.focus.active = true;
  }
}
