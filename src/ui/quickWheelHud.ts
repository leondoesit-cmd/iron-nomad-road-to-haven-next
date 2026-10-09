import type { Campaign } from '../game/campaign';
import { utilityName, type Player } from '../game/player';
import { ARMS, ARM_NAME, wheelSel, type WheelEntry } from '../game/quickWheel';
import { gearDef } from '../data/gear';
import { UTILITY_SLOT } from '../sim/gear';
import type { Slot } from '../input/input';
import { live } from '../input/bindings';
import { btnLabel, escapeHtml, quickCount, quickDef } from './hud';
import { gearIcon, itemIcon } from './gearIcons';
import { UTILITY_BLURB } from './inventory';
import { supplyIcon, type SupplyId } from './supplies';
import './quickWheel.css';

/**
 * The quick select wheel on the HUD, in the middle of the owner's half: a cross of the four arms (each showing what it rests
 * on), the arm in use laid out as a row under it, and the name and use of the pick. Redrawn only when what it shows changes.
 */

interface View {
  el: HTMLElement;
  shown: boolean;
  key: string;
  /** The layout and size picked when it opened, kept while it stays open so it does not jump as the arms change. */
  fitted: Fit | null;
}

interface Fit {
  cls: string[];
  s: number;
  cy: number;
  /** The half's size it was fitted to. */
  size: string;
  /** The news lines step aside while it is open (there was no room for both). */
  hideNews: boolean;
}

const views = new WeakMap<HTMLElement, View>();

/** Each arm's colour, matching the drugs' purple and the dressings' red elsewhere on the HUD. */
const ARM_COLOR = { weapons: '#ffb454', tools: '#9fc3d8', health: '#ff6f5f', drugs: '#c39bff' } as const;
/** Where each arm sits in the cross. */
const ARM_POS = ['up', 'right', 'down', 'left'] as const;
/** Tiles shown on the row at once; a longer arm scrolls around its pick. */
const ROW_MAX = 9;
/** Tiles on the row when the wheel lies on its side. */
const ROW_NARROW = 5;

interface Info {
  name: string;
  icon: string;
  count: string;
  blurb: string;
  none: boolean;
}

function info(p: Player, c: Campaign, e: WheelEntry): Info {
  if (e.kind === 'quick') {
    const d = quickDef(e.id, p);
    const n = quickCount(e.id, p, c);
    const sup: SupplyId | null = e.id === 'eat' ? 'ration' : e.id === 'drink' ? 'water' : e.id === 'piss' || e.id === 'shit' ? null : e.id;
    const icon = sup ? supplyIcon(sup) : `<span class="qwglyph" style="color:${d.color}">${d.glyph}</span>`;
    return { name: d.name, icon, count: n.label, blurb: d.blurb, none: n.none };
  }
  if (e.kind === 'util') {
    const n = e.id === 'horn' ? '∞' : `×${c.items[e.id]}`;
    const held = p.gear.sel === UTILITY_SLOT && p.utility === e.id;
    return { name: utilityName(e.id), icon: itemIcon(e.id), count: held ? `${n} · in hand` : n, blurb: UTILITY_BLURB[e.id], none: e.id !== 'horn' && c.items[e.id] <= 0 };
  }
  const d = gearDef(e.id);
  const item = e.kind === 'belt' ? p.gear.belt[e.slot] : p.gear.bag.find((b) => b.uid === e.uid);
  const where = e.kind === 'bag' ? 'in the bag' : p.gear.sel === e.slot ? 'in hand' : `belt ${e.slot + 1}`;
  return { name: d.name, icon: gearIcon(d, p.index, '', item?.att), count: where, blurb: d.blurb, none: false };
}

function make(host: HTMLElement): View {
  const el = document.createElement('div');
  el.className = 'qwheel';
  el.style.display = 'none';
  host.appendChild(el);
  return { el, shown: false, key: '', fitted: null };
}

/** Draw (or hide) one player's wheel. */
export function updateQuickWheel(host: HTMLElement, p: Player, c: Campaign, slot: Slot | null) {
  let v = views.get(host);
  const w = p.quickWheel;
  if (!w.open) {
    if (v?.shown) {
      v.el.style.display = 'none';
      v.shown = false;
      v.fitted = null;
      delete host.dataset.qw;
      delete host.dataset.qwnews;
    }
    return;
  }
  if (!v) views.set(host, (v = make(host)));
  const arm = ARMS[w.arm];
  const sel = wheelSel(w);
  const row = w.rows[w.arm];
  const infos = row.map((e) => info(p, c, e));
  const pad = slot?.kind === 'pad';
  const around = clearOf(host, [...CORNERS, ...NEWS]).map((r) => `${Math.round(r.top)},${Math.round(r.bottom)},${Math.round(r.left)}`).join(';');
  const key = `${w.ver}|${pad}|${w.opener}|${live.mouseSeat}|${host.clientWidth}x${host.clientHeight}|${around}|${infos.map((i) => i.count).join()}`;
  if (v.shown && v.key === key) return;
  v.key = key;

  const arms = ARMS.map((a, i) => {
    const s = wheelSel(w, i);
    const si = s ? info(p, c, s) : null;
    return `<div class="qwarm ${ARM_POS[i]}${i === w.arm ? ' on' : ''}${s ? '' : ' empty'}" style="--ac:${ARM_COLOR[a]}"><span class="qwic">${si ? si.icon : ''}</span><b>${ARM_NAME[a]}</b><em>${si ? escapeHtml(si.name) : 'none'}</em></div>`;
  }).join('');

  // The row: a window of the arm around the pick, nine tiles wide, or five when the wheel lies on its side (`.wide`).
  const at = Math.max(0, row.findIndex((e) => e === sel));
  const win = (n: number) => {
    const from = row.length <= n ? 0 : Math.min(Math.max(0, at - (n >> 1)), row.length - n);
    return [from, Math.min(row.length, from + n)];
  };
  const [from, to] = win(ROW_MAX);
  const [from5, to5] = win(ROW_NARROW);
  let tiles = '';
  for (let i = from; i < to; i++) {
    const f = infos[i];
    tiles += `<div class="qwtile${row[i] === sel ? ' sel' : ''}${f.none ? ' none' : ''}${i < from5 || i >= to5 ? ' far' : ''}">${f.icon}</div>`;
  }
  const more = (n: number, cls: string) => (n > 0 ? `<span class="qwmore ${cls}">+${n}</span>` : '');
  const s = sel ? infos[at] : null;
  const name = s ? `<b>${escapeHtml(s.name)}</b><em>${escapeHtml(s.count)}</em>` : `<b>Nothing here</b><em>${arm === 'drugs' ? 'the pharmacy at camp makes them' : ''}</em>`;

  const take = btnLabel(slot, 'A');
  const shut = btnLabel(slot, 'B');
  const hint = pad
    ? w.opener >= 0
      ? 'right stick or LB / RB to choose · let go to take'
      : `D-pad to choose (again to step along) · LB / RB step · ${take} take · ${shut} close`
    : `${live.mouseSeat === p.index ? 'mouse or ' : ''}move keys to choose (again to step along)${live.mouseSeat === p.index ? ' · wheel steps' : ''} · let go of ${btnLabel(slot, 'LB')} to take · ${shut} close`;

  v.el.innerHTML =
    `<div class="qwcross">${arms}<div class="qwhub" style="--ac:${ARM_COLOR[arm]}">${s ? s.icon : ''}</div></div>` +
    `<div class="qwside"><div class="qwrow" style="--ac:${ARM_COLOR[arm]}">${more(from, 'l n9')}${more(from5, 'l n5')}${tiles || '<span class="qwnone">empty</span>'}${more(row.length - to, 'r n9')}${more(row.length - to5, 'r n5')}</div>` +
    `<div class="qwtext"><div class="qwname" style="--ac:${ARM_COLOR[arm]}">${name}</div>` +
    (s ? `<div class="qwblurb">${escapeHtml(s.blurb)}</div>` : '') +
    `<div class="qwhint">${escapeHtml(hint)}</div></div></div>`;
  if (!v.shown) {
    host.dataset.qw = '1';
    v.el.style.display = 'flex';
    v.shown = true;
  }
  v.fitted = fit(host, v.el, v.fitted);
}

/** What the wheel must never cover: the four corners, with the clock, minimap, vitals and gun box in them. */
const CORNERS = ['.corner.tl', '.corner.tc', '.corner.tr', '.corner.bl', '.corner.br'];
/**
 * The lines that bring news while they show (subtitles, tips, the banner, the tether warning): kept clear too, unless that
 * would leave the wheel too small to read, when they step aside until it closes. What sits under the sights (the crosshair,
 * the look label, the prompts) always hides while it is open (quickWheel.css).
 */
const NEWS = ['.msgs .sub', '.msgs .tipbox', '.banner', '.tether'];
/** Smallest scale worth keeping the news lines in view for. */
const NEWS_MIN = 0.55;

/** The boxes among `sels` that show right now. */
function clearOf(host: HTMLElement, sels: string[]): DOMRect[] {
  const out: DOMRect[] = [];
  for (const k of sels) {
    const e = host.querySelector<HTMLElement>(k);
    if (!e || (!e.textContent?.trim() && !e.querySelector('canvas'))) continue;
    const r = e.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) out.push(r);
  }
  return out;
}

/** Ways to lay the wheel out, best first: upright with the description, upright without it, then on its side. */
const LAYOUTS = [[], ['tight'], ['wide'], ['wide', 'tight']];
const GAP = 6;

/**
 * Fit the wheel in its half without covering anything: for each layout, the largest scale at which it fits centred across the
 * half in a free gap between the panels, as near the middle as it can sit. The layout that can be drawn biggest wins; an
 * earlier one keeps a near tie. While it stays open the layout and size are kept as long as the content still fits.
 */
function fit(host: HTMLElement, el: HTMLElement, was: Fit | null): Fit | null {
  const hr = host.getBoundingClientRect();
  if (hr.width < 10 || hr.height < 10) return was;
  const size = `${Math.round(hr.width)}x${Math.round(hr.height)}`;
  const corners = clearOf(host, CORNERS);
  const withNews = [...corners, ...clearOf(host, NEWS)];
  const cx = hr.left + hr.width / 2;
  const mid = hr.top + hr.height / 2;
  /** Where a box of this size can sit clear of `keep` (its centre y), or null. */
  const spot = (keep: DOMRect[], bw: number, bh: number): number | null => {
    if (bw > hr.width - 2 * GAP) return null;
    const x0 = cx - bw / 2 - GAP;
    const x1 = cx + bw / 2 + GAP;
    const blocks = keep.filter((r) => r.right > x0 && r.left < x1).map((r) => [r.top - GAP, r.bottom + GAP]).sort((a, b) => a[0] - b[0]);
    let y = hr.top + 4;
    let best: number | null = null;
    const gap = (g0: number, g1: number) => {
      if (g1 - g0 < bh) return;
      const c = Math.min(Math.max(mid, g0 + bh / 2), g1 - bh / 2);
      if (best === null || Math.abs(c - mid) < Math.abs(best - mid)) best = c;
    };
    for (const [t, b] of blocks) {
      gap(y, t);
      y = Math.max(y, b);
    }
    gap(y, hr.bottom - 4);
    return best;
  };
  const setCls = (cls: string[]) => {
    el.classList.remove('tight', 'wide');
    for (const c of cls) el.classList.add(c);
  };
  const apply = (f: Fit) => {
    setCls(f.cls);
    el.style.setProperty('--qs', f.s.toFixed(3));
    el.style.top = `${Math.round(f.cy - hr.top)}px`;
    if (f.hideNews) host.dataset.qwnews = '1';
    else delete host.dataset.qwnews;
    return f;
  };
  // Still open in the same half: keep the layout and size while the new content fits in them.
  if (was && was.size === size) {
    setCls(was.cls);
    const cy = spot(was.hideNews ? corners : withNews, el.offsetWidth * was.s, el.offsetHeight * was.s);
    if (cy !== null) return apply({ ...was, cy });
  }
  /** The best layout clear of `keep`. */
  const solve = (keep: DOMRect[], hideNews: boolean): Fit | null => {
    let pick: Fit | null = null;
    for (const cls of LAYOUTS) {
      setCls(cls);
      el.style.setProperty('--qs', '1');
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      let lo = 0;
      let hi = 1;
      let cy = spot(keep, w, h);
      if (cy !== null) lo = 1;
      else
        for (let k = 0; k < 10; k++) {
          const m = (lo + hi) / 2;
          const c = spot(keep, w * m, h * m);
          if (c !== null) {
            lo = m;
            cy = c;
          } else hi = m;
        }
      if (cy !== null && (!pick || lo > pick.s + 0.06)) pick = { cls, s: lo, cy, size, hideNews };
      if (pick?.s === 1) break;
    }
    return pick;
  };
  let pick = solve(withNews, false);
  if (!pick || pick.s < NEWS_MIN) {
    const bare = solve(corners, true);
    if (bare && (!pick || bare.s > pick.s)) pick = bare;
  }
  // Nowhere clear at all (a tiny window): the upright wheel, small, in the middle.
  return apply(pick ?? { cls: ['tight'], s: 0.5, cy: mid, size, hideNews: true });
}
