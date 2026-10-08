import { DRUGS, TOL_MAX_CUT, type DrugId, type DrugState } from '../sim/drugs';
import type { Campaign } from '../game/campaign';
import type { Player } from '../game/player';
import { digitsOk } from '../game/drugPick';
import type { Slot } from '../input/input';
import { keyLabel, live } from '../input/bindings';
import { btnLabel, escapeHtml } from './hud';
import { drugFacts, supplyIcon } from './supplies';
import './drugStrip.css';

/**
 * The drugs quick pick on the HUD: a short list in the player's own half of the screen, one row per drug carried, each with its
 * number key, picture, count and what it does in a line. It never pauses anything, and it is drawn only when what it shows
 * changes (the pick's `ver`).
 */

interface Strip {
  el: HTMLElement;
  /** The player it last drew, for clicks. */
  p: Player | null;
  ver: number;
  shown: boolean;
  key: string;
}

const strips = new WeakMap<HTMLElement, Strip>();

/** One line of what a drug does, short enough for the strip: its strongest effects and when it comes on. */
export function quickLine(id: DrugId, s: DrugState | null): string {
  const def = DRUGS[id];
  const f = drugFacts(id, s);
  // The two strongest effects (a heal counts as the strongest of all), then when and how long.
  const fx = [...f.effects].sort((a, b) => (b.weight ?? 9) - (a.weight ?? 9)).slice(0, 2).map((l) => l.text);
  const tol = s?.tolerance[id] ?? 0;
  const timing = def.onset >= 15 ? `slow: ${Math.round(def.onset)} s to come on` : `${Math.round(def.duration)} s`;
  return [...fx, timing, tol > 0.02 ? `${Math.round(tol * TOL_MAX_CUT * 100)}% weaker (tolerance)` : ''].filter(Boolean).join(' · ');
}

function make(host: HTMLElement): Strip {
  const el = document.createElement('div');
  el.className = 'drugstrip';
  el.style.display = 'none';
  host.appendChild(el);
  const s: Strip = { el, p: null, ver: -1, shown: false, key: '' };
  // A click on a row takes it on the next tick (the HUD is drawn between ticks, the dose belongs to the sim).
  el.addEventListener('mousedown', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-drug]');
    if (!row || !s.p || !s.p.drugPick.open) return;
    e.preventDefault();
    e.stopPropagation();
    s.p.drugPick.clicked = row.dataset.drug as DrugId;
  });
  return s;
}

/** Draw (or hide) one player's strip. Cheap when nothing changed: a version check and out. */
export function updateDrugStrip(host: HTMLElement, p: Player, c: Campaign, slot: Slot | null) {
  let s = strips.get(host);
  const pk = p.drugPick;
  if (!pk.open) {
    if (s?.shown) {
      s.el.style.display = 'none';
      s.shown = false;
    }
    return;
  }
  if (!s) strips.set(host, (s = make(host)));
  s.p = p;
  const key = `${slot ? `${slot.kind}${slot.kind === 'kb' ? slot.set : slot.index}` : ''}|${live.mouseSeat}|${p.state}`;
  if (s.shown && s.ver === pk.ver && s.key === key) return;
  s.ver = pk.ver;
  s.key = key;
  const digits = digitsOk(p);
  const rows = pk.rows
    .map((id, i) => {
      const def = DRUGS[id];
      const on = id === pk.sel ? ' on' : '';
      return `<div class="dsrow${on}" data-drug="${id}" style="--dc:${def.color}">${digits && i < 9 ? `<kbd>${i + 1}</kbd>` : ''}<span class="dsic">${supplyIcon(id)}</span><b>${escapeHtml(def.name)}</b><em>×${c.items[id] ?? 0}</em><small>${escapeHtml(quickLine(id, p.drugs))}</small></div>`;
    })
    .join('');
  const take = btnLabel(slot, 'A');
  const close = btnLabel(slot, 'Drugs');
  // Forward and back choose on foot (never the throttle), as this layout has them bound.
  const kb = slot?.kind === 'kb' ? live.bindings.kb[slot.set - 1] : null;
  const fb = kb ? `${keyLabel(kb.moveUp)}/${keyLabel(kb.moveDown)}` : '';
  const choose = [digits ? '1-9' : '', p.state === 'foot' ? fb : '', live.mouseSeat === p.index ? 'wheel' : ''].filter(Boolean).join(' · ');
  s.el.className = digits ? 'drugstrip dig' : 'drugstrip';
  s.el.innerHTML = `<div class="dshead">Drugs<span>the game keeps running</span></div>${rows}<div class="dshint">${escapeHtml(choose)} to choose · ${escapeHtml(take)} or click to take · ${escapeHtml(close)} to close</div>`;
  if (!s.shown) {
    s.el.style.display = 'flex';
    s.shown = true;
  }
}
