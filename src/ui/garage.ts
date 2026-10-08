import { PARTS, PART_SLOTS, isGlassSlot, isInteriorSlot, mountsFor, partDef, type Cost, type PartSlot } from '../data';
import { BAY_SHORT, bayText, engineLine, engineSpec, hoodState } from '../sim/engines';
import { TANK_DREGS, addReserve, planDrain, reserveOf } from '../sim/fuel';
import { forecastSwap, forecastWorthy, currentFigures, type Forecast } from '../sim/forecast';
import { VERDICT_TEXT } from '../sim/thermal';
import { PANEL_NAME, SPRAY_CHARGES, colorName, panelColor, paintPanel, panelsOf, washPanels, type PanelId } from '../sim/paint';
import type { Campaign } from '../game/campaign';
import { PLAYER_CSS } from '../render/palette';
import { canAfford, costText, refund, spend } from '../sim/resources';
import { OIL_CAN, OIL_LOW, pourOil } from '../sim/oil';
import { COOLANT_LOW, WATER_CAN, pourWater } from '../sim/fluids';
import { type VehicleBuild, buildName, currentCond, defOf, idInSlot, installPart, maxHpOf, needsService, partInSlot, removePart, removeTyre, serviceBuild, serviceCost, statsOf, conditionSummary, dismantleYield, tyreAt, tyreIdAt, EMPTY_ID, GARAGE_MAX } from '../sim/garage';
import { RARITY_CSS, RARITY_NAMES, conditionLabel, describePart, isWorn, newPart, partName, scrapValue, slotsOf, type PartItem } from '../sim/parts';
import { escapeHtml } from './hud';
import type { FocusItem } from './focus';
import type { Game } from '../game/game';
import type { Vehicle } from '../game/vehicle';
import { placeFor } from '../game/access';
import { needText } from '../sim/access';
import { breakdownCar, breakdownHtml, type Focus } from './breakdown';

type Act = (player: number) => void;

/** The garage groups mounts by what they are part of. Tyres are drawn as a row of wheels, not one button. */
const SLOT_GROUPS: { name: string; slots: PartSlot[] }[] = [
  { name: 'Powertrain', slots: ['engine', 'cooling', 'gearbox', 'exhaust'] },
  { name: 'Running gear', slots: ['suspension', 'brakes', 'wheels'] },
  { name: 'Body', slots: ['hood', 'doorL', 'doorR', 'armor', 'side', 'front', 'rear', 'roof'] },
  { name: 'Fittings', slots: ['weapon', 'utility'] },
  { name: 'Cabin', slots: ['seatD', 'seatP', 'seatR', 'steer', 'dash'] },
  { name: 'Glass', slots: ['glassF', 'glassB', 'glassL', 'glassR'] },
];

/** What a wheel is called, by its place on the chassis: front or rear, left or right. */
function wheelName(n: number, count: number): string {
  if (count <= 2) return n === 0 ? 'Front' : 'Rear';
  const axle = Math.floor(n / 2);
  const axles = Math.ceil(count / 2);
  const end = axle === 0 ? 'Front' : axle === axles - 1 ? 'Rear' : `Axle ${axle + 1}`;
  return `${end} ${n % 2 === 0 ? 'left' : 'right'}`;
}

/** What a garage page needs from whatever hosts it: the Dawn Ledger tab, or the field workbench. */
export interface GarageHost {
  c: Campaign;
  /** The build shown for a player's column. */
  build(i: number): VehicleBuild;
  btn(id: string, label: string, act: Act, enabled?: boolean, title?: string): string;
  /** Rebuild the 3D vehicles after something changed. */
  refresh(): void;
  rerender(): void;
  say(msg: string, ok: boolean): void;
  /** Ledger: both players, fabrication, the yard and servicing. Workbench: one vehicle, fitting only. */
  mode: 'ledger' | 'field';
  /** Players whose vehicles are shown. */
  players: number[];
  /** The live vehicle behind a column, when the garage is open mid-leg: its tank is what gets drained. */
  vehicle?(i: number): Vehicle | null;
  /**
   * Field workbench only: the reason a job cannot be done from the bench right now, or null. Parts are fitted and pulled at
   * the car (`game/access.ts`), so `fit` is always blocked here; oil and water need the player at the engine bay with the
   * bonnet open. The Ledger leaves this out and everything works.
   */
  gate?(what: 'fit' | 'oil' | 'water'): string | null;
  /** Put a full spray can in the hands of whoever opened the bench, and let them out to use it. */
  takeCan?(i: number, color: number): void;
}

/**
 * The garage: fit parts, paint, fabricate, manage the yard. Pure HTML plus actions; the host owns rendering and focus.
 */
export class GarageView {
  /** The mount being worked on. For tyres `wheel` is the wheel number, or -1 for the whole set. */
  sel: { i: number; slot: PartSlot; wheel?: number } | null = null;
  /** A vehicle uid waiting for a second press to confirm breaking it down. */
  private armed: string | null = null;
  /** What the swatches paint, per column: the whole vehicle or one panel. */
  private target: Record<number, PanelId | 'all'> = {};
  /** The last colour picked, per column: what a spray can is filled with. */
  private lastColor: Record<number, number> = {};
  /** Another car of the convoy to measure each column's car against in the breakdown (a build uid), or none. */
  compare: Record<number, string | null> = {};
  /** The mount under the mouse or a cursor: what the breakdown opens up. */
  hover: { i: number; slot: PartSlot; wheel?: number } | null = null;

  constructor(private h: GarageHost) {}

  private get c() {
    return this.h.c;
  }
  private get field() {
    return this.h.mode === 'field';
  }

  html(): string {
    const cols = this.h.players.map((i) => this.vehicleCard(i)).join('');
    return `<div class="gtop">${cols}</div><div class="gfoot">${this.pickerHtml()}<div class="gpanel gdetail" data-gdetail>${this.detailHtml()}</div>${this.stockHtml()}${this.field ? '' : this.yardHtml()}</div>`;
  }

  // ------------------------------------------------------------------ breakdown

  /** The car of a column as the breakdown reads it: the live wear when it is on the road. */
  private bdCar(i: number) {
    const b = this.h.build(i);
    const live = this.h.vehicle?.(i);
    return breakdownCar(b, `${this.c.players[i]?.name ?? ''}'s ${defOf(b).name}`, live?.health.comp);
  }

  /** The breakdown of the mount being looked at (or picked), against the car chosen to compare with. */
  detailHtml(): string {
    const f = this.hover ?? this.sel ?? { i: this.h.players[0], slot: undefined as unknown as PartSlot };
    const i = this.h.players.includes(f.i) ? f.i : this.h.players[0];
    const focus: Focus | null = f.slot ? { slot: f.slot, wheel: f.wheel } : null;
    const other = this.compare[i] ? this.c.buildByUid(this.compare[i]!) : undefined;
    const compare = other && other.uid !== this.h.build(i).uid ? breakdownCar(other, defOf(other).name) : null;
    return breakdownHtml(this.bdCar(i), { focus, compare, title: `Breakdown · ${defOf(this.h.build(i)).name}` });
  }

  /** The other cars of the convoy as chips: pick one to measure this car against. */
  private compareHtml(i: number): string {
    const me = this.h.build(i).uid;
    const others = this.c.garage.filter((b) => b.uid !== me);
    if (!others.length) return '';
    const cur = this.compare[i] ?? null;
    const chips = others.map((b) => this.h.btn(`cmp${i}-${b.uid}`, escapeHtml(defOf(b).name), () => this.setCompare(i, cur === b.uid ? null : b.uid), true, 'Compare in the breakdown').replace('<button', `<button class="chipbtn${cur === b.uid ? ' on' : ''}"`));
    return `<div class="compare-chips"><small class="gh">Compare with</small>${chips.join('')}</div>`;
  }

  private setCompare(i: number, uid: string | null) {
    this.compare[i] = uid;
    this.h.rerender();
  }

  /**
   * Keep the breakdown on the mount under the mouse or under a player's cursor, without rebuilding the page: hosts call
   * this once after each render with the element the page went into.
   */
  bindDetail(root: HTMLElement) {
    const pane = () => root.querySelector<HTMLElement>('[data-gdetail]');
    const show = (el: HTMLElement | null) => {
      const tag = el?.closest<HTMLElement>('[data-slot]')?.dataset.slot;
      if (!tag) return;
      const [i, slot, wheel] = tag.split(':');
      const next = { i: Number(i), slot: slot as PartSlot, wheel: wheel !== undefined ? Number(wheel) : undefined };
      if (this.hover && this.hover.i === next.i && this.hover.slot === next.slot && this.hover.wheel === next.wheel) return;
      this.hover = next;
      const p = pane();
      if (p) p.innerHTML = this.detailHtml();
    };
    const old = (root as { _gd?: { mo: MutationObserver; mv: (e: Event) => void } })._gd;
    if (old) {
      old.mo.disconnect();
      root.removeEventListener('mouseover', old.mv);
    }
    const mv = (e: Event) => show(e.target as HTMLElement);
    root.addEventListener('mouseover', mv);
    // A pad or keys move a focus ring (the f0 / f1 classes): follow it.
    const mo = new MutationObserver((list) => {
      for (const m of list) {
        const el = m.target as HTMLElement;
        if (el.classList?.contains('f0') || el.classList?.contains('f1')) show(el);
      }
    });
    mo.observe(root, { subtree: true, attributes: true, attributeFilter: ['class'] });
    (root as { _gd?: unknown })._gd = { mo, mv };
  }

  // ------------------------------------------------------------------ vehicle card

  private pips(mk: number) {
    return mk ? `<i style="color:${RARITY_CSS[mk]}">${'◆'.repeat(mk)}</i>` : '';
  }

  private vehicleCard(i: number) {
    const c = this.c;
    const b = this.h.build(i);
    const def = defOf(b);
    const st = statsOf(b);
    const allowed = slotsOf(def);
    const lines: string[] = [];
    lines.push(
      `<h4><span class="pcolor" style="background:${PLAYER_CSS[i]}"></span>${escapeHtml(c.players[i].name.toUpperCase())} · ${escapeHtml(buildName(b))}</h4>`,
      `<div class="sub2">HP ${Math.round(b.hp * maxHpOf(b))}/${Math.round(maxHpOf(b))} · ARMOUR ${Math.round(st.armor * 100)}% · TANK ${st.tank.toFixed(0)} FU · TOP ${Math.round(def.topSpeedKmh * st.topSpeedMult)} km/h · CARGO ${Math.round(st.cargo)} · <span class="${b.comp.oil < OIL_LOW ? 'bad' : ''}">OIL ${Math.round(b.comp.oil * 100)}%</span></div>`,
      `<div class="sub2">${escapeHtml(conditionSummary(b)).toUpperCase()}${st.weapon ? ' · ARMED' : ''}</div>`,
    );
    lines.push(this.compareHtml(i));
    lines.push(...this.powertrainLines(i, b));
    const slotBtn = (slot: PartSlot) => {
      const it = b.fit[slot];
      const sel = this.sel?.i === i && this.sel.slot === slot;
      // What is actually in the mount: a fitted part, the factory one, or nothing at all.
      const id = idInSlot(b, slot);
      const factory = !it && !!id;
      const empty = !id && !!EMPTY_ID[slot];
      const main = empty ? 'Empty' : id ? escapeHtml(partDef(id).name) : 'Stock';
      let note = '';
      if (id && isWorn(slot)) {
        const cond = currentCond(b, slot);
        if (it || cond < 0.999) note = ` <em class="${cond < 0.35 ? 'bad' : cond < 0.7 ? 'mid' : ''}">${Math.round(cond * 100)}%</em>`;
      } else if (id && isGlassSlot(slot)) {
        // Glass shows what it has taken: whole is not worth a word.
        const cond = currentCond(b, slot);
        if (cond < 0.8) note = ` <em class="${cond < 0.1 ? 'bad' : 'mid'}">${cond < 0.1 ? 'smashed' : cond < 0.4 ? 'crazed' : 'cracked'}</em>`;
      }
      const mk = it && !partDef(it.id).stock ? partDef(it.id).mk : 0;
      return this.h
        .btn(`slot${i}-${slot}`, `<small>${PARTS.labels[slot]}${mk ? this.pips(mk) : ''}</small><b>${main}</b>${note}`, () => this.pick(i, slot), true)
        .replace('<button', `<button data-slot="${i}:${slot}" class="slotbtn${sel ? ' sel' : ''}${it && !factory && !empty ? ' fitted' : ''}${empty ? ' emptymount' : ''}"`);
    };
    // Slots in groups, so an engine is not lost among forty buttons. A chassis only shows the mounts it has.
    for (const grp of SLOT_GROUPS) {
      const here = grp.slots.filter((s) => allowed.includes(s));
      if (!here.length) continue;
      const cells = here.filter((s) => s !== 'wheels').map(slotBtn);
      lines.push(`<div class="slotgroup"><small class="gh">${grp.name}</small><div class="slotgrid">${cells.join('')}</div></div>`);
      if (here.includes('wheels')) lines.push(this.tyreRow(i, b));
    }
    // Paint: the whole vehicle or one panel, then a swatch.
    const panels = panelsOf(def);
    const tgt = this.targetOf(i, panels);
    if (panels.length) {
      const chips = (['all', ...panels] as (PanelId | 'all')[]).map((pid) =>
        this.h.btn(`ptgt${i}-${pid}`, pid === 'all' ? 'Whole vehicle' : PANEL_NAME[pid], () => this.setTarget(i, pid), true).replace('<button', `<button class="chipbtn${tgt === pid ? ' on' : ''}"`),
      );
      lines.push(`<div class="stripes">${chips.join('')}</div>`);
    }
    const current = tgt === 'all' ? b.paint : panelColor(b.paint, b.panels, tgt);
    const sw = PARTS.paints.map((pn) =>
      this.h
        .btn(`paint${i}-${pn.id}`, `<span class="sw${current === pn.c ? ' on' : ''}" style="background:#${pn.c.toString(16).padStart(6, '0')}"></span>`, () => this.paint(i, pn.c), true, pn.name)
        .replace('<button', '<button class="swbtn"'),
    );
    lines.push(`<div class="swatches">${sw.join('')}</div>`);
    if (b.panels) lines.push(`<div class="btns">${this.h.btn(`wash${i}`, 'Wash the panels back to one colour', () => this.wash(i), true)}</div>`);
    if (this.field && this.h.takeCan) {
      const col = this.lastColor[i] ?? b.paint;
      lines.push(`<div class="btns">${this.h.btn(`can${i}`, `Take a spray can <span class="cost">${escapeHtml(colorName(col))} · ${SPRAY_CHARGES} panels</span>`, () => this.h.takeCan!(i, col), true, 'Leaves the bench with a can in your hands: walk up to a panel and hold the button')}</div>`);
    }
    const stripes = PARTS.stripes.map((s, idx) => this.h.btn(`stripe${i}-${idx}`, s.name, () => this.stripe(i, idx), true).replace('<button', `<button class="chipbtn${b.stripe === idx ? ' on' : ''}"`));
    lines.push(`<div class="stripes">${stripes.join('')}</div>`);
    if (b.stripe > 0) {
      const cols = [0xe9dfc7, 0x1c1c1c, 0xc2402e, 0xe0be1a].map((col) =>
        this.h.btn(`scol${i}-${col}`, `<span class="sw${b.stripeColor === col ? ' on' : ''}" style="background:#${col.toString(16).padStart(6, '0')}"></span>`, () => this.stripeColor(i, col), true).replace('<button', '<button class="swbtn"'),
      );
      lines.push(`<div class="swatches small">${cols.join('')}</div>`);
    }
    if (def.physics.kind !== 'boat') {
      const bay = this.field ? this.h.gate?.('oil') ?? null : null;
      const need = b.comp.oil < 0.95;
      const wet = (b.comp.coolant ?? 1) < 0.95;
      lines.push(
        `<div class="btns">${this.h.btn(`oil${i}`, `Top up oil <span class="cost">${need ? `${(c.items.oil * 3).toFixed(1)} L in reserve` : 'full'}</span>`, () => this.topUpOil(i), need && c.items.oil > 0.02 && !bay, bay ?? (need ? (c.items.oil > 0.02 ? '' : 'No oil in reserve: find cans along the road') : ''))}${this.h.btn(`water${i}`, `Top up water <span class="cost">${wet ? `${c.items.water.toFixed(0)} L in reserve` : 'full'}</span>`, () => this.topUpWater(i), wet && c.items.water > 0.2 && !bay, bay ?? (wet ? (c.items.water > 0.2 ? `A can is ${WATER_CAN} L` : 'No water in reserve: fill cans at a lake or a well') : ''))}</div>`,
      );
    }
    if (!this.field) {
      const cost = serviceCost(b);
      lines.push(
        `<div class="btns">${this.h.btn(`svc${i}`, `Full service <span class="cost">${needsService(b) ? costText(cost) : 'not needed'}</span>`, () => this.service(i, cost), needsService(b) && canAfford(c.stocks, cost))}</div>`,
      );
    }
    return `<div class="card gcard p${i + 1}">${lines.join('')}</div>`;
  }

  /** One button per wheel, each with the tyre on it: a mixed set is a real thing. */
  private tyreRow(i: number, b: VehicleBuild): string {
    const count = b.tyres.length;
    const cells = b.tyres.map((_, n) => {
      const id = tyreIdAt(b, n);
      const cond = b.comp.tires[n] ?? 1;
      const sel = this.sel?.i === i && this.sel.slot === 'wheels' && this.sel.wheel === n;
      const fitted = !!b.tyres[n] && !!id && !partDef(id).stock;
      const mk = fitted ? partDef(id!).mk : 0;
      const main = id ? escapeHtml(partDef(id).name) : 'Bare rim';
      const note = id ? ` <em class="${cond < 0.35 ? 'bad' : cond < 0.7 ? 'mid' : ''}">${Math.round(cond * 100)}%</em>` : '';
      return this.h
        .btn(`slot${i}-wheels${n}`, `<small>${wheelName(n, count)}${mk ? this.pips(mk) : ''}</small><b>${main}</b>${note}`, () => this.pickWheel(i, n), true)
        .replace('<button', `<button data-slot="${i}:wheels:${n}" class="slotbtn${sel ? ' sel' : ''}${fitted ? ' fitted' : ''}${id ? '' : ' emptymount'}"`);
    });
    const all = this.sel?.i === i && this.sel.slot === 'wheels' && this.sel.wheel === -1;
    const set = this.h.btn(`slot${i}-wheelsall`, '<small>Tyres</small><b>Whole set</b>', () => this.pickWheel(i, -1), true).replace('<button', `<button class="slotbtn${all ? ' sel' : ''}"`);
    return `<div class="slotgroup"><small class="gh">Tyres, one per wheel</small><div class="slotgrid tyres">${cells.join('')}${set}</div></div>`;
  }

  // ------------------------------------------------------------------ powertrain

  /** Engine, bay, cooling and tank at a glance, plus the one-tap fix when the tank holds the wrong fuel. */
  private powertrainLines(i: number, b: VehicleBuild): string[] {
    const def = defOf(b);
    const st = statsOf(b);
    if (!def.stockEngine) return [];
    const fig = currentFigures(b);
    const spec = engineSpec(def, b.fit);
    const tankFU = this.tankFU(i, b);
    const wrong = !st.noEngine && b.tank !== st.fuel && tankFU >= TANK_DREGS;
    const hot = fig.heat.verdict === 'overheats' ? 'bad' : fig.heat.verdict === 'hot' ? 'mid' : '';
    const out: string[] = [
      `<div class="sub2">ENGINE ${escapeHtml(engineLine(spec).toUpperCase())} · ${st.noEngine ? '<span class="bad">NO ENGINE</span>' : `<span class="${st.bayLabel === 'cut' || st.bayLabel === 'tight' ? 'mid' : ''}" title="${escapeHtml(bayText(st.bayLabel, hoodState(b.fit)))}">${escapeHtml(BAY_SHORT[st.bayLabel].toUpperCase())}</span>`}</div>`,
      `<div class="sub2">COOLING ${Math.round(st.coolKw)} kW · <span class="${hot}">${escapeHtml(VERDICT_TEXT[fig.heat.verdict].toUpperCase())}</span> · RANGE ${fig.rangeKm.toFixed(0)} km</div>`,
      `<div class="sub2">TANK ${tankFU.toFixed(1)}/${st.tank.toFixed(0)} FU ${b.tank.toUpperCase()}${wrong ? ` · <span class="bad">ENGINE BURNS ${st.fuel.toUpperCase()}</span>` : ''}</div>`,
    ];
    // The rest of the machine, judged against the engine: a gearbox that must carry it, springs under it, brakes to stop it.
    const strain = st.noDrive ? 'bad' : st.strain > 1.05 ? 'bad' : st.strain > 0.85 ? 'mid' : '';
    const gbx = st.noDrive ? 'NO GEARBOX' : `${Math.round(st.gearboxRating)} kW BOX · ${st.strain > 1.05 ? `OVERSTRAINED ${st.strain.toFixed(1)}x` : st.strain > 0.85 ? 'AT ITS LIMIT' : 'COPES'}`;
    const load = st.overload > 1.08 ? 'bad' : st.overload > 0.95 ? 'mid' : '';
    const stop = st.brakeMult < 0.75 ? 'bad' : st.brakeMult < 0.95 ? 'mid' : '';
    out.push(
      `<div class="sub2">GEARBOX <span class="${strain}">${gbx}</span> · SPRINGS <span class="${load}">${st.overload > 1.08 ? `SAGGING ${st.overload.toFixed(1)}x` : st.overload > 0.95 ? 'FULL LOAD' : 'OK'}</span> · BRAKES <span class="${stop}">${st.brakeMult < 0.95 ? `${Math.round(st.brakeMult * 100)}% OF STOCK` : 'OK'}</span></div>`,
      `<div class="sub2">WEIGHT ${Math.round(st.mass)} KG · OIL ${st.sumpL.toFixed(1)} L ${Math.round(b.comp.oil * 100)}% · WATER ${st.coolantL.toFixed(1)} L <span class="${(b.comp.coolant ?? 1) < COOLANT_LOW ? 'bad' : ''}">${Math.round((b.comp.coolant ?? 1) * 100)}%</span>${st.hoodOff ? ' · <span class="mid">NO BONNET</span>' : ''}${st.doorsOff ? ` · <span class="mid">${st.doorsOff} DOOR${st.doorsOff > 1 ? 'S' : ''} OFF</span>` : ''}${st.tyresGone ? ` · <span class="bad">${st.tyresGone} BARE WHEEL${st.tyresGone > 1 ? 'S' : ''}</span>` : ''}</div>`,
    );
    if (wrong) {
      const plan = planDrain(b.tank, tankFU, st.fuel);
      out.push(`<div class="btns">${this.h.btn(`drain${i}`, `Drain tank <span class="cost">${tankFU.toFixed(1)} FU → ${b.tank} reserve</span>`, () => this.drain(i), plan.ok, plan.ok ? 'Empty the tank into the convoy reserve' : plan.label)}</div>`);
    }
    return out;
  }

  /** Fuel in the tank, in FU: live when the vehicle is on the road, otherwise the build's fraction. */
  private tankFU(i: number, b: VehicleBuild): number {
    const live = this.h.vehicle?.(i);
    return live ? live.fuel : b.fuel * statsOf(b).tank;
  }

  // ------------------------------------------------------------------ picker

  /** The forecast under a candidate part: power, speed, range, and everything that will bite. */
  private forecastHtml(f: Forecast): string {
    const d = (now: number, was: number, unit: string, digits = 0, lowerIsBetter = false) => {
      const delta = (now - was) * (lowerIsBetter ? -1 : 1);
      const cls = Math.abs(now - was) < 0.5 * Math.pow(10, -digits) ? '' : delta > 0 ? 'good' : 'bad';
      return `<b class="${cls}">${now.toFixed(digits)}${unit}</b>`;
    };
    const bits: string[] = [];
    if (f.slot === 'engine') {
      bits.push(`${d(f.powerKw, f.powerBefore, ' kW')}`);
      bits.push(`top ${d(f.topKmh, f.topBefore, ' km/h')}`);
      bits.push(`range ${d(f.rangeKm, f.rangeBefore, ' km')}`);
      if (Math.abs(f.massDelta) > 20) bits.push(`${f.massDelta > 0 ? '+' : ''}${Math.round(f.massDelta)} kg`);
      bits.push(`oil ${d(f.sumpL, f.sumpBefore, ' L', 1, true)} · water ${d(f.coolantL, f.coolantBefore, ' L', 1, true)}`);
      if (f.strain > 0.85 || f.strainBefore > 0.85) bits.push(`gearbox ${d(f.strain, f.strainBefore, 'x', 1, true)}`);
    } else if (f.slot === 'cooling') {
      bits.push(`runs ${f.heatBefore.verdict} → <b class="${f.heat.verdict === 'overheats' ? 'bad' : f.heat.verdict === 'cool' ? 'good' : 'mid'}">${f.heat.verdict}</b>`);
      bits.push(`water ${d(f.coolantL, f.coolantBefore, ' L', 1, true)}`);
    } else if (f.slot === 'gearbox') {
      bits.push(`strain ${d(f.strain, f.strainBefore, 'x', 1, true)}`);
      bits.push(`top ${d(f.topKmh, f.topBefore, ' km/h')}`);
      bits.push(`power ${d(f.powerKw, f.powerBefore, ' kW')}`);
    } else if (f.slot === 'suspension') {
      bits.push(`load ${d(f.overload, f.overloadBefore, 'x', 2, true)}`);
      bits.push(`grip ${d(f.grip * 100, f.gripBefore * 100, '%')}`);
    } else if (f.slot === 'brakes') {
      bits.push(`braking ${d(f.brake * 100, f.brakeBefore * 100, '%')}`);
    } else if (f.slot === 'exhaust') {
      bits.push(`power ${d(f.powerKw, f.powerBefore, ' kW')}`);
      bits.push(`top ${d(f.topKmh, f.topBefore, ' km/h')}`);
    } else if (f.slot === 'wheels') {
      bits.push(`grip ${d(f.grip * 100, f.gripBefore * 100, '%')}`);
      bits.push(`top ${d(f.topKmh, f.topBefore, ' km/h')}`);
    } else if (f.slot === 'hood' || f.slot === 'doorL' || f.slot === 'doorR') {
      bits.push(`armour ${d(f.armor * 100, f.armorBefore * 100, '%')}`);
      bits.push(`top ${d(f.topKmh, f.topBefore, ' km/h')}`);
    } else if (f.slot === 'steer') {
      bits.push(`steering lock ${d(f.steer * 100, f.steerBefore * 100, '%')}`);
    } else if (isInteriorSlot(f.slot)) {
      bits.push(`grip ${d(f.grip * 100, f.gripBefore * 100, '%')}`);
      bits.push(`armour ${d(f.armor * 100, f.armorBefore * 100, '%')}`);
    } else bits.push(`top ${d(f.topKmh, f.topBefore, ' km/h')}`);
    const notes = f.notes.map((n) => `<span class="${/overheat|wrong|drain|No engine|No gearbox|overstrained|overloaded|not up to it|bare wheel|No steering|No driver seat|No passenger seat/i.test(n) ? 'bad' : 'mid'}">${escapeHtml(n)}</span>`).join(' · ');
    return `<div class="fcast">${bits.join(' · ')}${notes ? `<br>${notes}` : ''}</div>`;
  }

  private partLine(it: PartItem): string {
    const d = partDef(it.id);
    return `<b style="color:${RARITY_CSS[d.stock ? 1 : d.mk]}">${escapeHtml(d.name)}</b> <span class="cost">${d.stock ? 'Factory' : `Mk${d.mk}`}${isWorn(d.slot) ? ` · ${Math.round(it.cond * 100)}%` : isGlassSlot(d.slot) && !d.empty ? ` · ${it.cond >= 0.8 ? 'whole' : it.cond >= 0.4 ? 'cracked' : 'crazed'}` : ''}</span>`;
  }

  private pickerHtml(): string {
    if (!this.sel) {
      return `<div class="gpanel"><h3>Fit a part</h3><div class="mutedtxt">Choose a mount on a vehicle to fit, replace or fabricate a part. Any engine goes in any vehicle, petrol or diesel, big or small, and the gearbox, springs, brakes and exhaust are judged against it: the forecast shows what it will cost you. Doors, bonnet, seats, the steering wheel, the dash, the glass and every tyre come off. Paint is free.</div></div>`;
    }
    const { i, slot, wheel } = this.sel;
    const c = this.c;
    const b = this.h.build(i);
    const def = defOf(b);
    const tyre = slot === 'wheels' && wheel !== undefined && wheel >= 0;
    const set = slot === 'wheels' && wheel === -1;
    const cur = tyre ? tyreAt(b, wheel!) : set ? null : partInSlot(b, slot);
    const rows: string[] = [];
    const lock = this.field ? this.h.gate?.('fit') ?? null : null;
    const where = tyre ? ` · ${wheelName(wheel!, b.tyres.length).toLowerCase()} wheel` : set ? ' · whole set' : '';
    rows.push(`<h3>${escapeHtml(PARTS.labels[slot])}${escapeHtml(where)} · ${escapeHtml(c.players[i].name)}'s ${escapeHtml(def.name)}</h3>`);
    if (cur) {
      const d = partDef(cur.id);
      rows.push(
        `<div class="partrow now">${this.partLine(cur)}<div class="mutedtxt">${escapeHtml(describePart(d).join(' · '))}</div>${this.h.btn(`rm${i}`, 'Take it off', () => this.remove(i, slot, wheel), !lock, lock ?? '')}</div>`,
      );
    } else if (set) {
      rows.push(`<div class="partrow now"><div class="mutedtxt">Every wheel at once.</div>${this.h.btn(`rm${i}`, 'Take all the tyres off', () => this.remove(i, slot, wheel), !lock, lock ?? '')}</div>`);
    } else rows.push(`<div class="mutedtxt">${EMPTY_ID[slot] ? 'Empty mount.' : 'Stock fittings.'}</div>`);
    // Spare tyres go on one wheel at a time; a spare in the trucks is one tyre, not a set.
    const stock = set
      ? []
      : c.inventory.filter((it) => mountsFor(partDef(it.id).slot).includes(slot)).sort((a, z) => Number(!!partDef(a.id).stock) - Number(!!partDef(z.id).stock) || partDef(z.id).mk - partDef(a.id).mk || z.cond - a.cond);
    rows.push(`<div class="mutedtxt gh">In the trucks</div>`);
    if (set) rows.push(`<div class="mutedtxt">Pick a single wheel to fit a spare. A tyre built here fits all of them.</div>`);
    else if (!stock.length) rows.push(`<div class="mutedtxt">Nothing for this slot.</div>`);
    const wheelArg = tyre ? wheel : undefined;
    for (const it of stock) {
      const d = partDef(it.id);
      const fc = forecastWorthy(it) ? this.forecastHtml(forecastSwap(b, slot, it, wheelArg)) : `<small>${escapeHtml(describePart(d).join(' · '))}</small>`;
      rows.push(`<div class="partrow">${this.h.btn(`fit${i}-${it.uid}`, `${this.partLine(it)}<br><small>${escapeHtml(describePart(d).join(' · '))}</small>${forecastWorthy(it) ? fc : ''}`, () => this.fit(i, it), !lock, lock ?? '').replace('<button', '<button class="wide"')}</div>`);
    }
    if (!this.field) {
      rows.push(`<div class="mutedtxt gh">Fabricate (needs the workshop)${slot === 'wheels' ? ' · a full set' : ''}</div>`);
      const ofSlot = (d: { slot: PartSlot }) => mountsFor(d.slot).includes(slot);
      for (const d of PARTS.parts.filter((p) => ofSlot(p) && !p.stock && !p.empty).sort((a, z) => a.mk - z.mk)) {
        const ok = canAfford(c.stocks, d.cost);
        const fc = forecastWorthy({ uid: 'f', id: d.id, cond: 1 }) ? this.forecastHtml(forecastSwap(b, slot, { uid: 'f', id: d.id, cond: 1 })) : '';
        rows.push(
          `<div class="partrow">${this.h.btn(`mk${i}-${d.id}`, `<b style="color:${RARITY_CSS[d.mk]}">${escapeHtml(d.name)}</b> <span class="cost">${costText(d.cost)}</span><br><small>${escapeHtml(describePart(d).join(' · '))}</small>${fc}`, () => this.fabricate(i, d.id, d.cost), ok).replace('<button', '<button class="wide"')}</div>`,
        );
      }
    }
    rows.push(`<div class="btns">${this.h.btn('closepick', 'Done', () => this.close(), true)}</div>`);
    return `<div class="gpanel picker">${rows.join('')}</div>`;
  }

  // ------------------------------------------------------------------ spare parts

  private stockHtml(): string {
    const c = this.c;
    const cap = c.inventoryCap;
    const rows = c.inventory
      .slice()
      .sort((a, z) => partDef(a.id).slot.localeCompare(partDef(z.id).slot) || partDef(z.id).mk - partDef(a.id).mk)
      .map((it) => {
        const d = partDef(it.id);
        const scrap = scrapValue(it);
        const spec = d.engine ? ` · ${engineLine(d.engine)}` : d.cooling !== undefined ? ` · ${Math.round(d.cooling)} kW` : describePart(d).length && !d.empty && (d.gearbox || d.suspension || d.brakes || d.exhaust) ? ` · ${describePart(d)[0]}` : '';
        return `<div class="stockline"><span><b style="color:${RARITY_CSS[d.stock ? 1 : d.mk]}">${escapeHtml(d.name)}</b> <small>${PARTS.labels[d.slot]}${isWorn(d.slot) ? ` · ${Math.round(it.cond * 100)}%` : ''}${escapeHtml(spec)}</small></span>${this.field ? '' : this.h.btn(`brk${it.uid}`, `Scrap <span class="cost">+${scrap}</span>`, () => this.breakDown(it, scrap), true)}</div>`;
      });
    return `<div class="gpanel"><h3>Spare parts <small>${c.inventory.length}/${cap}</small></h3>${rows.length ? `<div class="stocklist">${rows.join('')}</div>` : '<div class="mutedtxt">No spare parts. Strip wrecks with the crowbar, or pick them up along the road.</div>'}<div class="mutedtxt">Reserve cans: ${reserveOf(c, 'petrol').toFixed(1)} FU petrol · ${reserveOf(c, 'diesel').toFixed(1)} FU diesel · ${(c.items.oil * 3).toFixed(1)} L oil (${(c.items.oil / OIL_CAN).toFixed(1)} cans) · ${c.items.water.toFixed(0)} L water. Cargo space on your vehicles sets how much the convoy can carry.</div></div>`;
  }

  // ------------------------------------------------------------------ yard

  private yardHtml(): string {
    const c = this.c;
    const rows = c.garage.map((b) => {
      const seats = this.h.players;
      const owner = seats.find((i) => c.players[i].vehicle === b.uid);
      const y = dismantleYield(b);
      const armed = this.armed === b.uid;
      const assign = seats.map((i) =>
        this.h.btn(`as${i}-${b.uid}`, escapeHtml(c.players[i].name.toUpperCase()), () => this.assign(i, b.uid), owner !== i && (c.solo || c.players[1 - i].vehicle !== b.uid), owner === i ? 'Already rolling out in this one' : '').replace('<button', `<button class="pbtn p${i + 1}${owner === i ? ' on' : ''}"`),
      );
      return `<div class="yardrow"><div><b>${escapeHtml(buildName(b))}</b> <small>${escapeHtml(conditionSummary(b))}${Object.keys(b.fit).length ? ` · ${Object.keys(b.fit).length} parts` : ''}</small></div><div class="btns">${assign.join('')}${this.h.btn(`strip${b.uid}`, armed ? 'Confirm?' : `Break down <span class="cost">+${y.stocks.scrap ?? 0}S +${y.stocks.parts ?? 0}P</span>`, () => this.dismantle(b.uid), owner === undefined, owner !== undefined ? 'Rolling out in this one' : 'Parts come back to the trucks')}</div></div>`;
    });
    return `<div class="gpanel"><h3>The yard <small>${c.garage.length}/${GARAGE_MAX}</small></h3>${rows.join('')}<div class="mutedtxt">Vehicles you drive up to are added here. Past ${GARAGE_MAX}, the convoy breaks the least useful spare down for scrap.</div></div>`;
  }

  // ------------------------------------------------------------------ actions

  private pick(i: number, slot: PartSlot) {
    this.sel = this.sel?.i === i && this.sel.slot === slot ? null : { i, slot };
    this.h.rerender();
  }

  private pickWheel(i: number, wheel: number) {
    const same = this.sel?.i === i && this.sel.slot === 'wheels' && this.sel.wheel === wheel;
    this.sel = same ? null : { i, slot: 'wheels', wheel };
    this.h.rerender();
  }

  close() {
    this.sel = null;
    this.h.rerender();
  }

  private fit(i: number, it: PartItem) {
    const c = this.c;
    const b = this.h.build(i);
    const taken = c.takePart(it.uid);
    if (!taken) return;
    // A tyre goes on the wheel being worked on; a door or a front seat on the side that was picked.
    const at = this.sel?.slot === 'wheels' && (this.sel.wheel ?? -1) >= 0 ? this.sel.wheel : this.sel && this.sel.slot !== 'wheels' ? this.sel.slot : undefined;
    const res = installPart(b, taken, at);
    if (!res.ok) {
      c.inventory.push(taken);
      return this.h.say(res.reason ?? 'It does not fit', false);
    }
    if (res.removed) c.addPart(res.removed);
    this.h.refresh();
    this.h.say(`${partName(taken)} fitted${res.removed ? `; ${partName(res.removed)} goes back in the trucks` : ''}.${res.note ? ' ' + res.note : ''}`, !res.note);
  }

  private remove(i: number, slot: PartSlot, wheel?: number) {
    const c = this.c;
    const b = this.h.build(i);
    let out: PartItem | null;
    if (slot === 'wheels') {
      // One wheel, or every wheel for the whole set.
      const list = wheel !== undefined && wheel >= 0 ? [wheel] : b.tyres.map((_, n) => n);
      const pulled = list.map((n) => removeTyre(b, n)).filter((t): t is PartItem => !!t);
      for (const t of pulled.slice(1)) c.addPart(t);
      out = pulled[0] ?? null;
    } else out = removePart(b, slot);
    if (!out) return;
    const r = c.addPart(out);
    this.h.refresh();
    this.h.say(r.stored ? `${partName(out)} taken off.` : `${partName(out)} taken off and scrapped: the trucks are full.`, r.stored);
  }

  private fabricate(i: number, id: string, cost: Cost) {
    const c = this.c;
    const b = this.h.build(i);
    if (!spend(c.stocks, cost)) return this.h.say('Not enough stock', false);
    // Fabricated tyres come as a full set; a door or a seat goes on the mount that was picked.
    const at = this.sel && this.sel.slot !== 'wheels' ? this.sel.slot : undefined;
    const res = installPart(b, newPart(id, 1), at);
    if (!res.ok) {
      // Nothing was built: give back what the bench took.
      refund(c.stocks, cost);
      this.h.say(res.reason ?? 'It does not fit', false);
      return;
    }
    if (res.removed) c.addPart(res.removed);
    this.h.refresh();
    this.h.say(`${partDef(id).name} built and fitted.${res.note ? ' ' + res.note : ''}`, !res.note);
  }

  private breakDown(it: PartItem, scrap: number) {
    const c = this.c;
    if (!c.takePart(it.uid)) return;
    c.stocks.scrap += scrap;
    this.h.say(`${partName(it)} broken down for ${scrap} Scrap.`, true);
  }

  /** Empty a tank into the reserve, so the engine can be fed what it actually burns. */
  private drain(i: number) {
    const c = this.c;
    const b = this.h.build(i);
    const st = statsOf(b);
    const live = this.h.vehicle?.(i) ?? null;
    const fu = this.tankFU(i, b);
    const plan = planDrain(b.tank, fu, st.fuel);
    if (!plan.ok) return this.h.say(plan.label, false);
    const type = live ? live.fuelType : b.tank;
    addReserve(c, type, fu);
    if (live) {
      live.fuel = 0;
      live.fuelType = st.fuel;
      live.startFail = '';
      live.commit();
    } else {
      b.fuel = 0;
      b.tank = st.fuel;
    }
    this.h.refresh();
    this.h.say(`${fu.toFixed(1)} FU of ${type} drained into the reserve. The tank will take ${st.fuel} now.`, true);
  }

  private topUpOil(i: number) {
    const c = this.c;
    const b = this.h.build(i);
    const r = pourOil(b.comp.oil, c.items.oil, statsOf(b).sumpL);
    if (r.used <= 0) return;
    b.comp.oil = r.oil;
    c.items.oil = Math.max(0, c.items.oil - r.used);
    this.h.refresh();
    this.h.say(`Oil topped up to ${Math.round(r.oil * 100)}%.`, true);
  }

  private topUpWater(i: number) {
    const c = this.c;
    const b = this.h.build(i);
    const r = pourWater(b.comp.coolant ?? 1, c.items.water, statsOf(b).coolantL);
    if (r.used <= 0) return;
    b.comp.coolant = r.coolant;
    c.items.water = Math.max(0, c.items.water - r.used);
    this.h.refresh();
    this.h.say(`The cooling system is topped up to ${Math.round(r.coolant * 100)}% (${r.used.toFixed(1)} L).`, true);
  }

  private targetOf(i: number, panels: PanelId[]): PanelId | 'all' {
    const t = this.target[i] ?? 'all';
    return t === 'all' || panels.includes(t) ? t : 'all';
  }
  private setTarget(i: number, t: PanelId | 'all') {
    this.target[i] = t;
    this.h.rerender();
  }
  private paint(i: number, col: number) {
    const b = this.h.build(i);
    const t = this.targetOf(i, panelsOf(defOf(b)));
    this.lastColor[i] = col;
    if (t === 'all') {
      // Painting the whole vehicle starts it again from one colour.
      b.paint = col;
      washPanels(b);
    } else paintPanel(b, t, col);
    this.h.refresh();
  }
  private wash(i: number) {
    washPanels(this.h.build(i));
    this.h.refresh();
  }
  private stripe(i: number, idx: number) {
    this.h.build(i).stripe = idx;
    this.h.refresh();
  }
  private stripeColor(i: number, col: number) {
    this.h.build(i).stripeColor = col;
    this.h.refresh();
  }

  private service(i: number, cost: Cost) {
    const c = this.c;
    if (!spend(c.stocks, cost)) return this.h.say('Not enough stock', false);
    serviceBuild(this.h.build(i));
    this.h.refresh();
    this.h.say(`${c.players[i].name}'s ride is serviced.`, true);
  }

  private assign(i: number, uid: string) {
    const c = this.c;
    c.players[i].vehicle = uid;
    c.settleActives();
    this.sel = null;
    this.h.refresh();
    this.h.say(`${c.players[i].name} will roll out in the ${buildName(this.h.build(i))}.`, true);
  }

  private dismantle(uid: string) {
    const c = this.c;
    if (this.armed !== uid) {
      this.armed = uid;
      return this.h.rerender();
    }
    this.armed = null;
    const b = c.buildByUid(uid);
    if (!b) return;
    const y = dismantleYield(b);
    for (const k of Object.keys(y.stocks) as (keyof typeof y.stocks)[]) c.stocks[k] += y.stocks[k] ?? 0;
    for (const it of y.items) c.addPart(it);
    c.removeVehicle(uid);
    this.h.say(`${buildName(b)} broken down: ${y.stocks.scrap ?? 0} Scrap, ${y.stocks.parts ?? 0} Parts and ${y.items.length} fitted parts recovered.`, true);
  }
}

/**
 * The field workbench: opens next to one of your vehicles mid-leg, pauses the game, and lets you fit and paint it.
 * Fabrication, the yard and full services wait for camp. It docks to one side of the opener's half and their view shrinks to
 * the other side, so the car stays in sight beside the bench; the breakdown follows the mount under the cursor.
 */
export class Workbench {
  private acts = new Map<string, Act>();
  private view: GarageView;
  private msg = '';
  private v: Vehicle | null = null;
  private owner = 0;

  constructor(
    private game: Game,
    private root: HTMLElement,
    private onClose: () => void,
  ) {
    const self = this;
    this.view = new GarageView({
      c: game.campaign,
      mode: 'field',
      get players() {
        return [self.owner];
      },
      build: () => self.v!.build!,
      vehicle: () => self.v,
      gate: (what) => {
        if (what === 'fit') return 'Parts are fitted and pulled at the car: walk to the mount with the wrench or crowbar (or carry the part to it)';
        const pl = self.game.scene?.players[self.owner];
        const v = self.v;
        if (!pl || !v) return null;
        const place = placeFor(pl, v, 'oil');
        return place.gate.ok ? null : needText(v.def, place.gate.need!, 'top up');
      },
      takeCan: (_i, color) => {
        const pl = self.game.scene?.players[self.owner];
        if (!pl) return;
        if (pl.carry) {
          self.msg = 'Your hands are full: put it down first';
          self.game.audio.play('deny');
          return self.render();
        }
        pl.carry = { kind: 'paint', color, charges: SPRAY_CHARGES };
        pl.note(`Spray can (${colorName(color)}): walk up to a panel and hold the button`, 'good');
        self.close();
      },
      btn: (id, label, act, enabled = true, title = '') => {
        this.acts.set(id, act);
        return `<button data-fid="${id}" ${enabled ? '' : 'disabled'} title="${escapeHtml(title)}">${label}</button>`;
      },
      refresh: () => this.refresh(),
      rerender: () => this.render(),
      say: (m, ok) => {
        this.msg = m;
        this.game.audio.play(ok ? 'confirm' : 'deny');
        this.render();
      },
    });
  }

  open(v: Vehicle, owner: number) {
    this.v = v;
    this.owner = owner;
    // Edit the build directly, starting from the vehicle's live condition.
    v.commit();
    // The bench remembers where you were on this car.
    const last = v.build ? Workbench.last.get(v.build.uid) : undefined;
    this.view.sel = last ? { ...last, i: owner } : null;
    this.view.hover = null;
    this.msg = '';
    this.dock(true);
    this.game.focus.active = true;
    this.game.focus.owner = owner;
    this.game.focus.onCancel = () => this.close();
    this.render();
  }

  private refresh() {
    this.v?.syncFromBuild();
    this.render();
  }

  /** Which mount was last picked on each car, so reopening the bench lands on it. */
  private static last = new Map<string, { i: number; slot: PartSlot; wheel?: number }>();

  /**
   * Beside the car: the opener's view shrinks to the outer part of their own half (the whole screen's left half when solo)
   * and the bench takes the rest, so the car stays in sight. `false` puts the views back.
   */
  private dock(on: boolean) {
    const R = this.game.R;
    if (!on) return R.resize?.();
    const W = R.width;
    const H = R.height;
    if (!W || !H || !R.views) return;
    const d = 4;
    const solo = this.game.campaign.solo;
    const first = this.owner === 0;
    let rect: { x: number; y: number; w: number; h: number };
    if (solo) rect = { x: 0, y: 0, w: Math.floor(W * 0.5), h: H };
    else if (R.layout === 'horizontal') {
      const hh = Math.floor((H - d) / 2);
      rect = first ? { x: 0, y: 0, w: Math.floor(W * 0.45), h: hh } : { x: 0, y: hh + d, w: Math.floor(W * 0.45), h: H - hh - d };
    } else {
      const sw = Math.floor(W * 0.22);
      rect = first ? { x: 0, y: 0, w: sw, h: H } : { x: W - sw, y: 0, w: sw, h: H };
    }
    const view = R.views[this.owner];
    view.rect = rect;
    view.camera.aspect = rect.w / rect.h;
    view.camera.updateProjectionMatrix();
  }

  /** Where the docked bench sits, as a CSS inset: the part of the opener's half their view gave up. */
  private placeCss(): string {
    const g = this.game;
    if (g.campaign.solo) return 'inset:2% 1.2% 2% 50.6%';
    const first = this.owner === 0;
    if (g.R.layout === 'horizontal') return first ? 'inset:1% 1% 50.6% 45.4%' : 'inset:50.6% 1% 1% 45.4%';
    return first ? 'inset:2% 50.4% 2% 22.4%' : 'inset:2% 22.4% 2% 50.4%';
  }

  close() {
    if (this.v?.build && this.view.sel) Workbench.last.set(this.v.build.uid, this.view.sel);
    this.dock(false);
    this.game.focus.clear();
    this.game.focus.active = false;
    this.game.focus.owner = null;
    this.game.focus.onCancel = () => {};
    this.root.innerHTML = '';
    this.root.classList.remove('on');
    this.onClose();
  }

  render() {
    const g = this.game;
    const v = this.v;
    if (!v) return;
    const keys = g.focus.keys();
    this.acts.clear();
    const body = this.view.html();
    this.root.classList.add('on');
    // Docked beside the car, inside the opener's own half, so the other player's view stays visible too.
    const place = this.placeCss();
    this.root.innerHTML = `<div class="ledger panel paper bench docked" style="${place}">
      <h2><span>Workbench · ${escapeHtml(v.def.name)}</span><small>${escapeHtml(g.campaign.players[this.owner].name.toUpperCase())} · THE GAME IS PAUSED</small></h2>
      <div class="gbody">${body}</div>
      <div class="benchfoot"><span class="mutedtxt">${escapeHtml(this.msg)}</span>${this.btnHtml('benchdone', 'Back to the road', () => this.close())}</div>
    </div>`;
    this.root.querySelectorAll<HTMLElement>('button').forEach((b) => (b.style.pointerEvents = 'auto'));
    const items: FocusItem[] = [];
    this.root.querySelectorAll<HTMLElement>('[data-fid]').forEach((el) => {
      const act = this.acts.get(el.dataset.fid!);
      if (act) items.push({ el, press: (p) => act(p), disabled: (el as HTMLButtonElement).disabled });
    });
    g.focus.setItems(items, keys);
    g.focus.active = true;
    this.view.bindDetail(this.root);
  }

  private btnHtml(id: string, label: string, act: Act) {
    this.acts.set(id, act);
    return `<button data-fid="${id}">${label}</button>`;
  }
}
