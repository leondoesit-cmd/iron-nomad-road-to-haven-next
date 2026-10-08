import { promptLabel } from '../input/input';
import { partDef } from '../data';
import { condInfo, partFacts, swapDeltas } from './carStats';
import { esc } from './breakdown';
import { kindIcon, slotIcon } from './partIcons';
import { needHints, roomOf, storageOf, type StorageEntry, type StorageSession } from '../game/storage';
import type { Player } from '../game/player';

/**
 * The storage panel: a narrow column at the side of the opener's half of the screen, over the world but beside the car, with
 * everything the car carries. Rows are grouped by what they are (or sorted by what they would do for the car); the picked one
 * opens up with its numbers and what it would change. The buttons are listed at the foot in this seat's own bindings. A mouse
 * can hover and click the rows when the pointer is free; with it captured the wheel moves the pick and a click takes.
 */

const ROWS_MAX = 9;

/** The bindings this seat sees for the panel's buttons. */
function keys(p: Player) {
  const slot = p.ctx.input.slots?.[p.index] ?? null;
  const k = (b: string) => promptLabel(slot, b);
  const kb = slot?.kind === 'kb';
  return { take: k('A'), second: k('X'), close: kb ? `${k('LB')} / Esc` : k('B'), nav: kb ? (slot.set === 1 ? 'W/S' : '↑/↓') : 'D-pad', sort: kb ? (slot.set === 1 ? 'A/D' : '←/→') : '←/→' };
}

/** One row of the list. */
function rowHtml(s: StorageSession, e: StorageEntry, i: number): string {
  const on = i === s.sel;
  const icon = e.kind === 'part' || (e.kind === 'cargo' && e.item) ? slotIcon(e.slot) : kindIcon(e.kind === 'cargo' ? 'crate' : e.kind);
  const ci = e.cond !== null ? condInfo(e.cond) : null;
  const v = e.verdict;
  let tag = '';
  if (v?.junk) tag = '<span class="tk-v bad">junk</span>';
  else if (v?.fitsHere && v.gain !== null && v.gain > 0.01) tag = `<span class="tk-v good">+${Math.round(v.gain * 100)}% ${esc(v.word)}</span>`;
  else if (v?.fitsHere && v.gain !== null && v.gain < -0.01) tag = `<span class="tk-v dim">${Math.round(v.gain * 100)}% ${esc(v.word)}</span>`;
  else if (v && !v.fitsHere && v.fits.length) tag = `<span class="tk-v dim">other car</span>`;
  const mark = e.kind === 'part' || e.item ? e.mark : e.amount ?? e.mark;
  const cond = ci ? `<span class="tk-c ${ci.tone}">${ci.pct}%</span>` : '';
  const out = e.where !== 'inside' ? `<span class="tk-w">${esc(e.whereName)}${e.secure === false ? ' · loose' : ''}</span>` : '';
  const job = on && s.job ? `<div class="tk-job"><i style="width:${Math.round(Math.min(1, s.job.t / s.job.dur) * 100)}%"></i></div>` : '';
  return `<div class="tk-r${on ? ' on' : ''}${v?.junk ? ' junk' : ''}" data-i="${i}"><span class="tk-i" style="color:${e.css}">${icon}</span><span class="tk-n">${esc(e.name)}</span><span class="tk-m" style="color:${e.css}">${esc(mark)}</span>${cond}${tag}${out}${job}</div>`;
}

/** The open-up under the list: what the pick is, what it fits, and what it would change on this car. */
function detailHtml(s: StorageSession, e: StorageEntry): string {
  const lines: string[] = [];
  if (e.item) {
    const d = partDef(e.item.id);
    const facts = partFacts(d).slice(0, 4);
    lines.push(`<div class="tk-facts">${facts.map((f) => `<span class="${f.tone ?? ''}">${esc(f.label)} <b>${esc(f.text)}</b></span>`).join('')}</div>`);
    const v = e.verdict;
    if (v) {
      const fits = v.fitsHere ? `Fits this ${s.v.def.name}` : v.fits.length ? `Fits ${v.fits.slice(0, 2).join(', ')}` : 'Fits nothing you own';
      const others = v.fitsHere && v.fits.length > 1 ? ` · also ${v.fits.filter((n) => !n.endsWith(s.v.def.name)).slice(0, 2).join(', ')}` : '';
      lines.push(`<div class="tk-fit ${v.fitsHere ? 'good' : v.fits.length ? '' : 'bad'}">${esc(e.what)} · ${esc(fits)}${esc(others)}</div>`);
      if (v.fitsHere && s.v.build) {
        const at = s.mountFor(e.item);
        const ds = swapDeltas(s.v.def, s.v.build.fit, s.v.build.tyres, e.item, at, 3);
        if (ds.length) lines.push(`<div class="tk-delta">${ds.map((x) => `<b class="${x.good ? 'good' : 'bad'}">${esc(x.text)}</b>`).join(' · ')}</div>`);
      } else if (!v.fitsHere && v.gainOn && v.gain !== null && v.gain > 0.01) lines.push(`<div class="tk-delta"><b class="good">+${Math.round(v.gain * 100)}% ${esc(v.word)}</b> on ${esc(v.gainOn)}</div>`);
      if (v.junk) lines.push(`<div class="tk-fit bad">Junk: break it down for Scrap at camp</div>`);
    }
    lines.push(`<div class="tk-sub">${e.units} space · ${e.kg ? `≈${Math.round(e.kg)} kg` : ''}${e.where !== 'inside' ? ` · on the ${esc(e.whereName)}${e.secure === false ? ' (loose)' : ''}` : ''}</div>`);
  } else if (e.kind !== 'cargo') {
    const what = e.kind === 'oil' ? 'One can is half a sump: carry it to the engine bay' : e.kind === 'water' ? 'Ten litres a can, for the radiator' : `A can holds 5 FU · the ${s.v.def.name} burns ${s.v.stats.fuel}, the tank has ${s.v.fuel.toFixed(1)}/${s.v.tankMax.toFixed(0)} FU of ${s.v.fuelType}`;
    lines.push(`<div class="tk-sub">${esc(what)}</div>`);
  } else lines.push(`<div class="tk-sub">On the ${esc(e.whereName)}${e.secure === false ? ': loose, it will fall off on the move' : ': held fast'}</div>`);
  return `<div class="tk-d">${lines.join('')}</div>`;
}

/** The whole panel, for one player's half. */
export function trunkHtml(p: Player): string {
  const s = storageOf(p);
  if (!s) return '';
  const v = s.v;
  const K = keys(p);
  const room = roomOf(v, s.entries);
  const hint = needHints(v, s.entries, K.take)[0];
  const head = `<div class="tk-h"><b>${esc(v.def.name)} · ${esc(v.insideRoom().name)}</b><span>${room.used}/${room.max} space${room.kg > 0 ? ` · ≈${Math.round(room.kg)} kg` : ''}${room.outsideMax ? ` · ${room.outside} outside` : ''}</span></div>`;
  const sort = `<div class="tk-sort"><span class="${s.sort === 'slot' ? 'on' : ''}" data-act="sort-slot">By slot</span><span class="${s.sort === 'value' ? 'on' : ''}" data-act="sort-value">By value</span><kbd>${esc(K.sort)}</kbd></div>`;
  const hintHtml = hint ? `<div class="tk-hint ${hint.tone}">${esc(hint.text)}</div>` : '';
  let list = '';
  if (!s.entries.length) list = '<div class="tk-empty">Empty. Carry a part here and press X to stow it.</div>';
  else {
    // A window of rows round the pick, so a long list scrolls with it.
    const n = s.entries.length;
    const start = Math.max(0, Math.min(n - ROWS_MAX, s.sel - Math.floor(ROWS_MAX / 2)));
    const end = Math.min(n, start + ROWS_MAX);
    let group = '';
    const out: string[] = [];
    if (start > 0) out.push(`<div class="tk-more">▲ ${start} more</div>`);
    for (let i = start; i < end; i++) {
      const e = s.entries[i];
      const g = s.sort === 'slot' ? e.group : '';
      if (g && g !== group) {
        group = g;
        out.push(`<div class="tk-g">${esc(g)}</div>`);
      }
      out.push(rowHtml(s, e, i));
    }
    if (end < n) out.push(`<div class="tk-more">▼ ${n - end} more</div>`);
    list = out.join('');
  }
  const cur = s.current;
  const second = s.secondLabel(cur);
  const act = s.job
    ? `<span data-act="close"><kbd>${esc(K.close)}</kbd> Stop</span>`
    : `<span data-act="take" class="${cur ? '' : 'off'}"><kbd>${esc(K.take)}</kbd> Take</span>${second ? `<span data-act="second" class="${second.ok ? '' : 'off'}"><kbd>${esc(K.second)}</kbd> ${esc(second.text)}</span>` : ''}<span data-act="close"><kbd>${esc(K.close)}</kbd> Close</span>`;
  const msg = s.msg ? `<div class="tk-msg ${s.msgOk ? '' : 'bad'}">${esc(s.msg)}</div>` : '';
  return `<div class="tk">${head}${hintHtml}${sort}<div class="tk-list">${list}</div>${cur ? detailHtml(s, cur) : ''}${msg}<div class="tk-f">${act}<span class="dim"><kbd>${esc(K.nav)}</kbd> Choose</span></div></div>`;
}

/** Who each panel element belongs to, for the mouse. */
const owners = new WeakMap<HTMLElement, () => Player | null>();

/**
 * Hook the mouse up to a panel element once: hovering a row picks it, clicking it takes it, the foot's buttons do their job.
 * The press is kept from the page so it does not capture the pointer.
 */
export function bindTrunk(el: HTMLElement, who: () => Player | null) {
  if (owners.has(el)) {
    owners.set(el, who);
    return;
  }
  owners.set(el, who);
  const session = () => {
    const p = owners.get(el)?.();
    return p ? storageOf(p) : null;
  };
  el.addEventListener('mousedown', (e) => e.stopPropagation());
  el.addEventListener('mousemove', (e) => {
    const s = session();
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
    if (!s || !row || s.job) return;
    const i = Number(row.dataset.i);
    if (i !== s.sel) s.select(i);
  });
  el.addEventListener('click', (e) => {
    const s = session();
    if (!s) return;
    const t = e.target as HTMLElement;
    const row = t.closest<HTMLElement>('[data-i]');
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'close') s.close();
    else if (act === 'take') s.take();
    else if (act === 'second') s.second();
    else if (act === 'sort-slot') s.setSort('slot');
    else if (act === 'sort-value') s.setSort('value');
    else if (row && !s.job) s.take(Number(row.dataset.i));
  });
}
