import type { PartSlot, VehicleDef } from '../data';
import { chassisDef } from '../data';
import { currentCond, idInSlot, tyreIdAt, type VehicleBuild } from '../sim/garage';
import type { Fit, Tyres } from '../sim/parts';
import { carFigures, componentRows, condInfo, figureRows, stockFigures, type CompLike, type ComponentRow } from './carStats';
import { slotIcon } from './partIcons';

/**
 * The full breakdown of a car: every component with its mark, its wear and its own numbers, then the car's totals against the
 * factory car (and, to compare two cars, against another one). Plain HTML strings, no DOM: the HUD shows it while the details
 * button is held, the storage panel beside its list, and the garage and the workbench beside the mount being looked at.
 */

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Everything the breakdown needs of one car. */
export interface BreakdownCar {
  name: string;
  def: VehicleDef;
  fit: Fit;
  tyres: Tyres;
  comp: CompLike;
  idIn: (slot: PartSlot) => string | null;
  tyreId: (i: number) => string | null;
  glass?: (slot: PartSlot) => number;
}

/** A build as a breakdown car. `comp` is the live wear when the car is on the road (its health), else the build's own. */
export function breakdownCar(b: VehicleBuild, name: string, comp?: CompLike): BreakdownCar {
  return { name, def: chassisDef(b.chassis), fit: b.fit, tyres: b.tyres, comp: comp ?? b.comp, idIn: (s) => idInSlot(b, s), tyreId: (i) => tyreIdAt(b, i), glass: (s) => currentCond(b, s) };
}

/** Which component to open up: a slot (and a wheel, for a tyre). */
export interface Focus {
  slot: PartSlot;
  wheel?: number;
}

const isFocus = (r: ComponentRow, f?: Focus | null) => !!f && r.slot === f.slot && (r.slot !== 'wheels' || f.wheel === undefined || f.wheel < 0 || r.wheel === f.wheel);

/** The component list, grouped, with the focused one opened up to its numbers. */
export function componentsHtml(car: BreakdownCar, focus?: Focus | null, max = 99): string {
  const rows = componentRows(car.def, car.fit, car.tyres, car.comp, car.idIn, car.tyreId, car.glass);
  let group = '';
  const out: string[] = [];
  let n = 0;
  for (const r of rows) {
    if (n++ >= max) break;
    if (r.group !== group) {
      group = r.group;
      out.push(`<div class="bk-g">${esc(group)}</div>`);
    }
    const ci = r.cond !== null ? condInfo(r.cond) : null;
    const on = isFocus(r, focus);
    const cond = ci ? `<span class="bk-c ${ci.tone}">${ci.pct}%</span>` : '';
    const facts = on && r.facts.length ? `<div class="bk-f">${r.facts.map((f) => `<span class="${f.tone ?? ''}">${esc(f.label)} <b>${esc(f.text)}</b></span>`).join('')}</div>` : '';
    out.push(
      `<div class="bk-r${on ? ' on' : ''}${r.state === 'empty' ? ' empty' : ''}" data-bk="${r.slot}${r.wheel !== undefined ? `:${r.wheel}` : ''}"><span class="bk-i" style="color:${r.css}">${slotIcon(r.slot)}</span><span class="bk-l">${esc(r.label)}</span><span class="bk-n" style="color:${r.css}">${esc(r.name)}</span><span class="bk-m">${esc(r.state === 'factory' ? 'factory' : r.mark)}</span>${cond}${facts}</div>`,
    );
  }
  return `<div class="bk-list">${out.join('')}</div>`;
}

/** The totals table: this car, the factory car, and another for comparison. */
export function totalsHtml(car: BreakdownCar, other?: BreakdownCar | null): string {
  const now = carFigures(car.def, car.fit, car.tyres);
  const stock = stockFigures(car.def);
  const o = other ? carFigures(other.def, other.fit, other.tyres) : undefined;
  const rows = figureRows(now, stock, o);
  const tone = (c: -1 | 0 | 1 | undefined) => (c === 1 ? 'good' : c === -1 ? 'bad' : '');
  const head = `<tr><th></th><th>${esc(shortName(car.name))}</th><th>Factory</th>${other ? `<th>${esc(shortName(other.name))}</th>` : ''}</tr>`;
  const body = rows
    .map((r) => `<tr><td>${esc(r.label)}</td><td class="${tone(r.vsStock)}">${esc(r.now)}</td><td class="dim">${esc(r.stock)}</td>${other ? `<td class="${tone(r.vsOther === undefined ? 0 : (-r.vsOther as -1 | 0 | 1))}">${esc(r.other ?? '—')}</td>` : ''}</tr>`)
    .join('');
  return `<table class="bk-t">${head}${body}</table>`;
}

const shortName = (s: string) => (s.length > 18 ? `${s.slice(0, 17)}…` : s);

/** The whole breakdown: a title, the components and the totals. `compact` drops the component numbers except the focused one's. */
export function breakdownHtml(car: BreakdownCar, opts: { focus?: Focus | null; compare?: BreakdownCar | null; title?: string } = {}): string {
  return `<div class="bk"><div class="bk-h">${esc(opts.title ?? car.name)}${opts.compare ? `<small> vs ${esc(opts.compare.name)}</small>` : ''}</div><div class="bk-cols">${componentsHtml(car, opts.focus)}${totalsHtml(car, opts.compare)}</div></div>`;
}
