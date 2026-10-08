import { BLENDS, DRUGS, DRUG_IDS, INTERACTIONS, MULT_KEYS, TOL_MAX_CUT, TOX_OVERDOSE, type DrugDef, type DrugId, type DrugMods, type DrugState } from '../sim/drugs';
import { BLEED } from '../sim/vitals';
import { NEEDS } from '../sim/needs';
import { whole } from '../sim/resources';
import type { Campaign } from '../game/campaign';
import { itemIcon } from './gearIcons';
import { drugWord } from '../game/consumables';
import { wildTotal } from '../game/wildShrooms';

/**
 * The things a survivor uses up rather than wears or holds: dressings, food, water and every drug in the pharmacy. They are
 * counts in the convoy's shared stores (`campaign.items` and `campaign.stocks`), not items in a bag, so they get a strip of
 * their own in the inventory with what each one does, and the body's current state for the drugs.
 */

/** `wild`: the mushrooms picked without knowing them (`game/wildShrooms.ts`), one tile for every lot. */
export type SupplyId = 'bandage' | 'medkit' | 'ration' | 'water' | DrugId | 'wild';

/** In the order the strip shows them: medicine, then food and water, then the pharmacy as `sim/drugs.ts` lists it. */
export const supplyIds = (): SupplyId[] => ['bandage', 'medkit', 'ration', 'water', ...DRUG_IDS, 'wild'];

export const isDrug = (id: string): id is DrugId => id in DRUGS;

/** What the stores hold of it: doses, rations, or litres of water. */
export function supplyCount(c: Campaign, id: SupplyId): number {
  if (id === 'ration') return whole(c.stocks.rations);
  if (id === 'water') return Math.max(0, c.items.water);
  if (id === 'wild') return wildTotal(c);
  return c.items[id] ?? 0;
}

/** The count as the tile shows it. */
export function supplyCountText(c: Campaign, id: SupplyId): string {
  return id === 'water' ? `${supplyCount(c, id).toFixed(0)} L` : String(supplyCount(c, id));
}

export function supplyName(id: SupplyId): string {
  switch (id) {
    case 'bandage':
      return 'Bandage';
    case 'medkit':
      return 'Medkit';
    case 'ration':
      return 'Ration';
    case 'water':
      return 'Water';
    case 'wild':
      return 'Unknown mushrooms';
    default:
      return DRUGS[id]?.name ?? id;
  }
}

/** One line for a tile's tooltip and the quick pick. */
export function supplyBlurb(id: SupplyId): string {
  switch (id) {
    case 'bandage':
      return `Stops bleeding and mends ${BLEED.bandageHeal} HP. A pressure bandage slows snake venom. Under a second's work.`;
    case 'medkit':
      return 'Stops bleeding, heals 60 and draws most of a snake bite. Over a second with your hands busy.';
    case 'ration':
      return `Fills you up by ${Math.round(NEEDS.rationFood * 100)}%. Hunger slows your recovery; starving hurts.`;
    case 'water':
      return 'Three quarters of a litre from the reserve, or free from the water you stand at (raw water can upset your stomach).';
    case 'wild':
      return 'Mushrooms you picked without knowing them, kept by their look. Eating one is how you learn them: food, a trip, or a very bad day.';
    default:
      return DRUGS[id]?.blurb ?? '';
  }
}

// ------------------------------------------------------------------------------------------- what a drug does

export interface FactLine {
  text: string;
  tone?: 'good' | 'bad' | 'muted';
  /** How big the effect is (a multiplier's distance from 1, an additive term's size), for picking the ones worth a short line. */
  weight?: number;
}

const pct = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`;
/** A multiplier too close to 1 to be worth a line. */
const SMALL = 0.025;

/** A multiplier or an additive effect, in words, and whether it is good for you. Null for what is not worth a line. */
function effectLine(key: keyof DrugMods, v: number): FactLine | null {
  switch (key) {
    case 'speed':
      return Math.abs(v - 1) < SMALL ? null : { text: `${pct(v - 1)} speed`, tone: v > 1 ? 'good' : 'bad' };
    case 'damage':
      return Math.abs(v - 1) < SMALL ? null : { text: v < 1 ? `takes ${Math.round((1 - v) * 100)}% less damage` : `takes ${Math.round((v - 1) * 100)}% more damage`, tone: v < 1 ? 'good' : 'bad' };
    case 'noise':
      return Math.abs(v - 1) < SMALL ? null : { text: `${pct(v - 1)} noise`, tone: v < 1 ? 'good' : 'bad' };
    case 'spread':
      return Math.abs(v - 1) < SMALL ? null : { text: `${pct(v - 1)} weapon spread`, tone: v < 1 ? 'good' : 'bad' };
    case 'aggro':
      return Math.abs(v - 1) < SMALL ? null : { text: v < 1 ? `the dead notice you ${Math.round((1 - v) * 100)}% later` : `the dead notice you ${Math.round((v - 1) * 100)}% sooner`, tone: v < 1 ? 'good' : 'bad' };
    case 'appetite':
      return Math.abs(v - 1) < SMALL ? null : { text: v > 1 ? `${pct(v - 1)} hunger` : `${pct(v - 1)} hunger`, tone: v > 1 ? 'bad' : 'good' };
    case 'melee':
      return Math.abs(v - 1) < SMALL ? null : { text: `${pct(v - 1)} melee damage`, tone: v > 1 ? 'good' : 'bad' };
    case 'shake':
      return v > 0.04 ? { text: 'shaky hands', tone: 'bad' } : v < -0.04 ? { text: 'steadier hands', tone: 'good' } : null;
    case 'regen':
      return v > 0.04 ? { text: `heals ${v.toFixed(1)} HP a second`, tone: 'good' } : null;
    case 'sway':
      return v > 0.04 ? { text: 'unsteady on your feet', tone: 'bad' } : v < -0.04 ? { text: 'steadier on your feet', tone: 'good' } : null;
    case 'nausea':
      return v > 0.04 ? { text: 'nausea: you may throw up', tone: 'bad' } : v < -0.04 ? { text: 'settles the stomach', tone: 'good' } : null;
    case 'outburst':
      return v > 0.04 ? { text: 'laughing fits: loud at the wrong moment', tone: 'bad' } : null;
    case 'phantoms':
      return v > 0.04 ? { text: 'sees things that are not there', tone: 'bad' } : null;
    case 'sight':
      return v > 0.04 ? { text: v >= 0.5 ? 'senses the living through walls' : 'a feel for the living nearby', tone: 'good' } : null;
    case 'trip':
      return v >= 0.5 ? { text: 'strong hallucinations', tone: 'muted' } : v > 0.04 ? { text: 'the world shifts a little', tone: 'muted' } : null;
    case 'poison':
      return v > 0 ? { text: 'poisonous', tone: 'bad' } : null;
  }
  return null;
}

/** Every effect of a set of mods, in words. */
export function effectLines(m: Partial<DrugMods> | undefined): FactLine[] {
  const out: FactLine[] = [];
  if (!m) return out;
  for (const k of Object.keys(m) as (keyof DrugMods)[]) {
    const v = m[k]!;
    const l = effectLine(k, v);
    if (l) out.push({ ...l, weight: (MULT_KEYS as readonly string[]).includes(k) ? Math.abs(v - 1) : Math.abs(v) });
  }
  return out;
}

const secs = (s: number) => (s >= 90 ? `${Math.floor(s / 60)} min ${Math.round(s % 60) ? `${Math.round(s % 60)} s` : ''}`.trim() : `${Math.round(s)} s`);

/** The timeline in one line: when it comes on and how long it lasts. */
export function timelineText(def: DrugDef): string {
  const stack = def.stack === 'stack' ? `, stacks up to ${def.maxStack} doses` : '';
  return `Comes on over ${secs(def.onset)} · lasts ${secs(def.duration)}${stack}${def.crash > 0 ? ` · ${secs(def.crash)} comedown` : ''}`;
}

/** When a dose taken from the paused pack starts working: the clock only runs once you are back on the road. */
export function kicksInText(def: DrugDef): string {
  return def.onset <= 2 ? 'Works the moment you are back on the road' : `Kicks in over ~${secs(def.onset)} once you close the pack`;
}

/**
 * Everything worth knowing before taking a drug: the timeline, what it does while it works and on the way up and down, what it
 * costs the body, and how it would land on top of what this person already has in them.
 */
export function drugFacts(id: DrugId, s: DrugState | null): { effects: FactLine[]; risks: FactLine[]; now: FactLine[] } {
  const def = DRUGS[id];
  const effects: FactLine[] = [];
  if (def.heal > 0) effects.push({ text: `heals ${def.heal} at once`, tone: 'good' });
  effects.push(...effectLines(def.on));
  // What only shows while it comes on counts for less in a short summary than what lasts.
  for (const l of effectLines(def.front)) effects.push({ text: `coming on: ${l.text}`, tone: l.tone, weight: (l.weight ?? 0) * 0.3 });
  if (def.amplifies) effects.push({ text: `everything else you take lands ${Math.round(def.amplifies * 100)}% harder`, tone: 'bad' });
  const down = effectLines(def.down);
  const risks: FactLine[] = [];
  if (down.length) risks.push({ text: `Comedown: ${down.map((l) => l.text).join(', ')}`, tone: 'bad' });
  risks.push({ text: `Toxicity ${Math.round((def.tox / TOX_OVERDOSE) * 100)}% of an overdose per dose`, tone: def.tox >= 0.3 ? 'bad' : 'muted' });
  if (def.dep >= 0.1) risks.push({ text: def.dep >= 0.25 ? 'Habit-forming: go without and you will crave it' : 'Mildly habit-forming', tone: 'bad' });
  if (def.tol >= 0.25) risks.push({ text: `Tolerance builds fast: each dose ${Math.round(def.tol * TOL_MAX_CUT * 100)}% weaker than the last`, tone: 'bad' });
  else if (def.tol > 0) risks.push({ text: `Each dose builds a little tolerance (${Math.round(def.tol * TOL_MAX_CUT * 100)}%)`, tone: 'muted' });
  for (const it of INTERACTIONS) if (it.a === id || it.b === id) risks.push({ text: `With ${drugWord(it.a === id ? it.b : it.a)}: ${Math.round((it.tox - 1) * 100)}% more toxic`, tone: 'bad' });

  // How it would land on this body, now.
  const now: FactLine[] = [];
  if (s) {
    const tol = s.tolerance[id] ?? 0;
    if (tol > 0.01) now.push({ text: `Your tolerance: it hits ${Math.round(tol * TOL_MAX_CUT * 100)}% softer`, tone: 'bad' });
    const working = (d: DrugId) => s.active.some((a) => a.id === d && a.left > 0);
    const mine = s.active.find((a) => a.id === id && a.left > 0);
    if (mine) now.push({ text: def.stack === 'stack' ? 'Already in you: another adds to it' : 'Already in you: another only restarts the clock', tone: 'muted' });
    for (const it of INTERACTIONS) {
      const other = it.a === id ? it.b : it.b === id ? it.a : null;
      if (other && working(other)) now.push({ text: `${it.note} (×${it.tox} toxicity now)`, tone: 'bad' });
    }
    for (const b of BLENDS) {
      if (!b.needs.includes(id)) continue;
      const rest = b.needs.filter((d) => d !== id);
      if (rest.length && rest.every(working)) now.push({ text: `Blends into ${b.name}: ${b.blurb}`, tone: b.toxRate ? 'bad' : 'good' });
    }
    if (s.toxicity > 0.05) now.push({ text: `Toxicity in you: ${Math.round((s.toxicity / TOX_OVERDOSE) * 100)}%${s.toxicity + def.tox > TOX_OVERDOSE ? ': this one could be too many' : ''}`, tone: s.toxicity + def.tox > TOX_OVERDOSE * 0.85 ? 'bad' : 'muted' });
    if (s.withdrawal > 0.2 && def.dep > 0) now.push({ text: 'It would take the edge off the craving', tone: 'good' });
  }
  return { effects, risks, now };
}

/** What is in someone's blood right now, for the inventory: each drug's phase and clock, what is still to come, the blends. */
export function systemLines(s: DrugState): FactLine[] {
  const out: FactLine[] = [];
  for (const a of s.active) {
    const def = DRUGS[a.id];
    if (!def) continue;
    const ph = s.phase(a.id);
    const t = ph === 'comedown' ? `comedown, ${Math.ceil(a.crash)} s` : ph === 'onset' ? `coming on (${Math.max(0, Math.ceil(def.onset - a.age))} s)` : `${ph === 'taper' ? 'wearing off' : 'working'}, ${Math.ceil(a.left)} s left`;
    out.push({ text: `${def.name}: ${t}`, tone: ph === 'comedown' ? 'bad' : 'good' });
  }
  for (const d of s.delayed) {
    const def = DRUGS[d.id];
    if (def) out.push({ text: `${def.name}: in your stomach, starts in ${Math.ceil(d.left)} s`, tone: 'muted' });
  }
  for (const b of s.blends()) out.push({ text: `${b.name}: ${b.blurb}`, tone: b.toxRate ? 'bad' : 'good' });
  if (s.passedOut) out.push({ text: 'Passed out', tone: 'bad' });
  else if (s.overdosing) out.push({ text: 'Overdosing: take nothing else', tone: 'bad' });
  if (s.withdrawal > 0.2) out.push({ text: 'Withdrawal: you are craving', tone: 'bad' });
  return out;
}

/** Tolerance left from earlier doses, worst first. */
export function toleranceLines(s: DrugState): FactLine[] {
  return (Object.entries(s.tolerance) as [DrugId, number][])
    .filter(([id, v]) => v > 0.02 && DRUGS[id])
    .sort((a, b) => b[1] - a[1])
    .map(([id, v]) => ({ text: `${DRUGS[id].name} ${Math.round(v * TOL_MAX_CUT * 100)}% softer`, tone: 'muted' as const }));
}

// ------------------------------------------------------------------------------------------- pictures

const INK = '#1b140c';
const P = (d: string, fill: string, extra = '') => `<path d="${d}" fill="${fill}" stroke="${INK}" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round" ${extra}/>`;
const L = (d: string, stroke: string, w = 1.4) => `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
const R = (x: number, y: number, w: number, h: number, fill: string, rx = 1.5) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${INK}" stroke-width="1.4" stroke-linejoin="round"/>`;
const C = (x: number, y: number, r: number, fill: string) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${INK}" stroke-width="1.4"/>`;
const E = (x: number, y: number, rx: number, ry: number, fill: string) => `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="${fill}" stroke="${INK}" stroke-width="1.4"/>`;
const svg = (inner: string) => `<svg class="gi" viewBox="0 0 48 48" aria-hidden="true">${inner}</svg>`;

function drawSupply(id: SupplyId): string {
  switch (id) {
    case 'bandage':
      return svg(P('M20 14 H41 Q43 14 43 16 V24 Q43 26 41 26 H20Z', '#efe8d6') + L('M27 14 V26 M34 14 V26', '#cfc6b0', 1) + C(19, 26, 12, '#f4eee0') + C(19, 26, 4.5, '#d8cfb8') + L('M11 20 Q14 16 19 15', '#ffffff', 1.6));
    case 'medkit':
      return itemIcon('medkit');
    case 'ration':
      return svg(E(24, 13, 12, 4, '#d6dadd') + P('M12 13 V37 Q24 43 36 37 V13', '#b8bec4') + P('M12 19 Q24 24 36 19 V31 Q24 36 12 31Z', '#c8823a') + L('M17 25 H31', '#f3e6c8', 1.6) + E(24, 13, 7, 2, '#9aa0a6'));
    case 'water':
      return svg(P('M17 13 Q24 9 31 13', 'none') + E(24, 29, 14, 14, '#5f9ab8') + L('M15 22 Q24 18 33 22', '#9fd0ea', 1.6) + R(20, 8, 8, 7, '#3a3226', 1.5) + L('M10 22 Q6 10 18 9 M38 22 Q42 10 30 9', '#6a5638', 1.8));
    case 'painkiller':
      return svg(R(13, 15, 22, 27, '#ece8dc', 3) + R(11, 8, 26, 8, '#5a8ad0', 2) + R(15, 22, 18, 12, '#9ad0ff', 1) + L('M24 24 V32 M20 28 H28', '#2a5a9a', 2) + E(40, 41, 4, 2.4, '#ffffff') + E(6, 40, 4, 2.4, '#ffffff'));
    case 'stim':
      return svg(`<g transform="rotate(-35 24 24)">${R(19, 9, 10, 24, '#ffd24a', 2)}${R(21, 3, 6, 7, '#8a9096', 1)}${L('M16 9 H32', INK, 1.6)}${L('M21 18 H27 M21 24 H27', '#a07a10', 1.2)}${L('M24 33 V45', '#cfd4d8', 1.4)}</g>`);
    case 'adrenaline':
      return svg(`<g transform="rotate(35 24 24)">${R(18, 5, 12, 30, '#ff6a5a', 5)}${R(18, 29, 12, 9, '#f2e8d0', 2)}${R(20, 38, 8, 5, '#ff9a3a', 1.5)}${L('M21 12 H27 M21 17 H27', '#ffffff', 1.4)}</g>`);
    case 'alcohol':
      return svg(P('M15 14 H33 Q37 18 37 26 V40 Q37 44 33 44 H15 Q11 44 11 40 V26 Q11 18 15 14Z', 'rgba(220,226,214,0.85)') + P('M12 27 H36 V40 Q36 43 33 43 H15 Q12 43 12 40Z', '#e8a24a') + R(14, 7, 20, 7, '#8a6a42', 1.5) + L('M16 31 Q18 29 20 31', '#ffe0a0', 1.2));
    case 'weed': {
      const leaf = [-62, -32, 0, 32, 62].map((a, i) => `<g transform="rotate(${a} 24 36)">${E(24, 36 - (i === 2 ? 15 : 12), i === 2 ? 4 : 3.4, i === 2 ? 15 : 12, '#5cb85a')}</g>`).join('');
      return svg(leaf + L('M24 36 V46', '#3d7a34', 2) + L('M24 23 V34', '#2f6a2a', 1));
    }
    case 'haze':
      return svg(P('M19 8 H29 V14 Q36 18 36 30 Q36 42 24 42 Q12 42 12 30 Q12 18 19 14Z', 'rgba(197,138,255,0.75)') + R(18, 4, 12, 5, '#5a4a6a', 1.5) + C(20, 28, 3, '#e8d4ff') + C(28, 33, 2.4, '#e8d4ff') + C(27, 23, 1.8, '#e8d4ff') + C(38, 10, 2, '#c58aff') + C(42, 17, 1.4, '#c58aff'));
    case 'mushrooms':
      return svg(P('M19 25 Q18 36 16 42 H30 Q28 36 27 25Z', '#efe4cc') + P('M5 27 Q8 8 24 7 Q40 8 43 27 Q24 31 5 27Z', '#a8743e') + C(17, 16, 2.4, '#f2dcae') + C(29, 13, 2, '#f2dcae') + C(34, 21, 1.8, '#f2dcae') + L('M16 33 Q23 35 30 33', '#cdbf9e', 1));
    case 'lsd':
      return svg(`<g transform="rotate(-8 24 24)">${R(8, 8, 32, 32, '#f4f0e4', 1)}${C(24, 24, 11, '#5ad6ff')}${C(24, 24, 7, '#ff7ae0')}${C(24, 24, 3, '#ffe25a')}${L('M8 19 H40 M8 29 H40 M19 8 V40 M29 8 V40', 'rgba(27,20,12,0.35)', 0.8)}</g>`);
    case 'wild':
      return svg(P('M14 26 Q13 36 11 42 H22 Q20 36 20 26Z', '#e6dcc4') + P('M3 27 Q6 12 17 11 Q28 12 31 27 Q17 30 3 27Z', '#8a6a4a') + P('M27 30 Q27 38 26 43 H34 Q33 38 33 30Z', '#dcd2b8') + P('M21 31 Q24 18 30 15 Q37 18 41 31 Q30 34 21 31Z', '#b39466') + `<text x="36" y="13" font-size="13" font-family="monospace" font-weight="bold" fill="${INK}">?</text>`);
    case 'ayahuasca':
      return svg(P('M7 22 H41 Q40 38 24 41 Q8 38 7 22Z', '#7a4a2a') + E(24, 22, 17, 4, '#3a2016') + L('M33 21 Q38 10 30 6 Q24 4 26 12 Q28 17 22 16', '#4a9a3a', 2) + E(36, 11, 3, 1.8, '#5cb85a') + E(23, 9, 2.6, 1.6, '#5cb85a'));
  }
  // A drug added to the data without a picture of its own: a bottle with its letter, in its colour.
  const def = DRUGS[id as DrugId];
  return svg(R(13, 14, 22, 28, '#ece8dc', 3) + R(11, 7, 26, 8, def?.color ?? '#999999', 2) + `<text x="24" y="35" text-anchor="middle" font-size="15" font-family="monospace" fill="${def?.color ?? INK}" stroke="${INK}" stroke-width="0.6">${def?.glyph ?? '?'}</text>`);
}

const iconCache = new Map<SupplyId, string>();
/** The picture for a supply. Drawn once and kept: the strings never change. */
export function supplyIcon(id: SupplyId): string {
  let s = iconCache.get(id);
  if (!s) iconCache.set(id, (s = drawSupply(id)));
  return s;
}
