import { carLookOf, type CardModel } from '../game/carLook';
import { needHints, roomOf, storageEntries, storageOf, carName } from '../game/storage';
import type { Player } from '../game/player';
import type { Vehicle } from '../game/vehicle';
import { breakdownCar, breakdownHtml, esc, type Focus } from './breakdown';
import { bindTrunk, trunkHtml } from './trunk';
import { slotIcon } from './partIcons';
import type { PartSlot } from '../data';

/**
 * The car screens on the HUD, for one player's half: the card beside the crosshair for the part being looked at, the storage
 * panel at the side, and the breakdown while the details (sheet) button is held. `hud.ts` calls `updateCarHud` once per HUD
 * update and hides what these replace (the car readout under a part card, the convoy sheet under the breakdown).
 */

/** The card beside the crosshair. */
export function cardHtml(c: CardModel): string {
  const cond = c.cond ? `<div class="cc-cond"><div class="cc-bar"><i class="${c.cond.tone}" style="width:${c.cond.pct}%"></i></div><span class="${c.cond.tone}">${c.cond.pct}% · ${esc(c.cond.label)}</span></div>` : '';
  const facts = c.facts.length ? `<div class="cc-facts">${c.facts.map((f) => `<div><span>${esc(f.label)}</span><b class="${f.tone ?? ''}">${esc(f.text)}</b></div>`).join('')}</div>` : '';
  const vs = c.vs && c.vs.items.length ? `<div class="cc-vs"><small>${esc(c.vs.head)}</small>${c.vs.items.map((d) => `<b class="${d.good ? 'good' : 'bad'}">${esc(d.text)}</b>`).join('')}</div>` : '';
  const more = c.more.length ? `<div class="cc-more">${c.more.map((m) => `<div>${esc(m)}</div>`).join('')}</div>` : '';
  const hint = c.hint ? `<div class="cc-hint ${c.hint.tone}">${esc(c.hint.text)}</div>` : '';
  const acts = c.actions.length ? `<div class="cc-act">${c.actions.map((a) => `<div class="${a.ok ? '' : 'off'}"><kbd>${esc(a.key)}</kbd>${esc(a.text)}</div>`).join('')}</div>` : '';
  return `<div class="cc-t">${esc(c.title)}</div><div class="cc-n" style="color:${c.css}">${esc(c.name)}${c.mark ? `<em>${esc(c.mark)}</em>` : ''}</div>${cond}${facts}${vs}${more}${hint}${acts}`;
}

/**
 * The car under the crosshair from further off (or with the crosshair on the body between parts): the car readout takes it
 * instead of the nearest one, so looking at a car across the yard reads that car.
 */
export function glanceVehicle(p: Player): Vehicle | null {
  const L = carLookOf(p);
  return L && !L.part ? L.v : null;
}

/** True while a part card is showing: the car readout gives way to it. */
export const partCardShowing = (p: Player) => !!carLookOf(p)?.part;

/** Rows kept per car for the readout's extra line, a second at a time. */
const glanceRows = new WeakMap<Vehicle, { t: number; html: string }>();

/**
 * The car readout's extra line: what the car carries and the one thing a mechanic would point out (a spare for a flat, an
 * upgrade in the boot). Empty for a car that is not the convoy's.
 */
export function glanceExtras(p: Player, v: Vehicle): string {
  if (!v.build || v.faction !== 'convoy' || v.wreck) return '';
  const now = p.ctx.time;
  const hit = glanceRows.get(v);
  if (hit && now - hit.t < 1) return hit.html;
  const rows = storageEntries(v);
  const room = roomOf(v, rows);
  const parts = rows.filter((e) => e.kind === 'part').length;
  const hint = needHints(v, rows, 'E')[0];
  const chips: string[] = [];
  chips.push(`<span class="chip">${esc(v.insideRoom().name.toUpperCase())} ${room.used}/${room.max}${parts ? ` · ${parts} SPARE${parts > 1 ? 'S' : ''}` : ''}</span>`);
  if (room.outside) chips.push(`<span class="chip">${room.outside} ON THE OUTSIDE</span>`);
  if (hint) chips.push(`<span class="chip ${hint.tone === 'good' ? 'good' : hint.tone === 'bad' ? 'bad' : 'warn'}">${esc(hint.text.toUpperCase())}</span>`);
  const html = `<div class="chips">${chips.join('')}</div>`;
  glanceRows.set(v, { t: now, html });
  return html;
}

/** The car the details button would break down: the one in the storage panel, or the one being looked at. */
function detailsCar(p: Player): { v: Vehicle; focus: Focus | null } | null {
  const s = storageOf(p);
  if (s) {
    const e = s.current;
    return { v: s.v, focus: e?.slot ? { slot: e.slot as PartSlot } : null };
  }
  const L = carLookOf(p);
  if (!L) return null;
  const part = L.part;
  return { v: L.v, focus: part && part.slot !== 'boot' ? { slot: part.slot, wheel: part.slot === 'wheels' ? part.index : undefined } : null };
}

/** The part of a player's HUD these screens draw into: the same helpers `hud.ts` uses, so redraws only happen on change. */
export interface HudHalf {
  setHtml(k: string, v: string): void;
  setStyle(k: string, prop: string, v: string): void;
  el(k: string): HTMLElement;
}

/** What the car screens took over this update, so the HUD can hide what they replace. */
export interface CarHudState {
  /** A part card is showing: the car readout under the prompts hides. */
  card: boolean;
  /** The storage panel is open: the bottom prompts hide (the panel lists its own buttons). */
  panel: boolean;
  /** The breakdown is showing instead of the convoy sheet. */
  details: boolean;
}

/** Draw a player's car screens. Call from the HUD's per-player update. */
export function updateCarHud(h: HudHalf, p: Player): CarHudState {
  const foot = p.state === 'foot';
  // The storage panel.
  const panel = foot && !!storageOf(p);
  h.setStyle('trunk', 'display', panel ? 'block' : 'none');
  if (panel) {
    bindTrunk(h.el('trunk'), () => p);
    h.setHtml('trunk', trunkHtml(p));
  }
  // The breakdown, while the sheet button is held over a car.
  const det = foot && p.sheet ? detailsCar(p) : null;
  h.setStyle('carbk', 'display', det ? 'block' : 'none');
  if (det?.v.build) {
    const camp = p.ctx.campaign;
    const own = camp.buildOf(p.index);
    const mine = det.v.build.uid === own.uid;
    const ownLive = p.ctx.vehicles.find((q) => q.build?.uid === own.uid);
    const car = breakdownCar(det.v.build, carName(p.ctx, det.v.build), det.v.health.comp);
    const compare = mine ? null : breakdownCar(own, carName(p.ctx, own), ownLive?.health.comp);
    h.setHtml('carbk', breakdownHtml(car, { focus: det.focus, compare, title: `${car.name}${det.v.faction !== 'convoy' ? ' · not yours yet' : ''}` }));
  }
  // The card beside the crosshair.
  const L = foot && !panel && !det ? carLookOf(p) : null;
  const card = !!L?.card && !!L.part && L.t > 0.08;
  h.setStyle('carcard', 'display', card ? 'block' : 'none');
  if (card) h.setHtml('carcard', cardHtml(L!.card!));
  return { card: card || (!!L?.part && L.t <= 0.08), panel, details: !!det };
}

export { slotIcon };
