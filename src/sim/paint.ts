import { PARTS, type VehicleDef } from '../data';

/**
 * Painting a vehicle panel by panel. The whole-vehicle colour is still `build.paint`; a panel can be sprayed a different
 * colour, which covers its rust and grime too. In the field you do it with a spray can in your hands, aiming at the panel;
 * in the garage you pick the panel and a swatch.
 */

export type PanelId = 'hood' | 'roof' | 'doorL' | 'doorR' | 'front' | 'rear';

export const PANELS: PanelId[] = ['hood', 'roof', 'doorL', 'doorR', 'front', 'rear'];

export const PANEL_NAME: Record<PanelId, string> = {
  hood: 'Bonnet',
  roof: 'Roof',
  doorL: 'Left door',
  doorR: 'Right door',
  front: 'Front end',
  rear: 'Rear end',
};

/** Panel colours by panel. A panel that is missing wears the vehicle's own paint. */
export type PanelPaint = Partial<Record<PanelId, number>>;

/** One can covers this many panels. */
export const SPRAY_CHARGES = 6;

/** Which panels a chassis has: a bike or quad has a front and a rear; everything with a cab has all six. */
export function panelsOf(def: VehicleDef): PanelId[] {
  // Boats have no panels to spray. (The war truck and rig have body models now: their cab, bonnet and bed take paint.)
  if (def.physics.kind === 'boat') return [];
  return (def.slots ?? []).includes('roof') ? PANELS : ['front', 'rear'];
}

/** The colour a panel shows right now. */
export function panelColor(paint: number, panels: PanelPaint | undefined, panel: PanelId): number {
  return panels?.[panel] ?? paint;
}

/** Spray a panel. Spraying it the vehicle's own colour just removes the override. */
export function paintPanel(b: { paint: number; panels?: PanelPaint }, panel: PanelId, color: number) {
  const next: PanelPaint = { ...(b.panels ?? {}) };
  if (color === b.paint) delete next[panel];
  else next[panel] = color;
  if (Object.keys(next).length) b.panels = next;
  else delete b.panels;
}

/** Back to one colour all over. */
export function washPanels(b: { panels?: PanelPaint }) {
  delete b.panels;
}

/** A stable string for cache keys and change checks. */
export function panelSignature(panels: PanelPaint | undefined): string {
  if (!panels) return '';
  return PANELS.filter((p) => panels[p] !== undefined)
    .map((p) => `${p}:${panels[p]!.toString(16)}`)
    .join(',');
}

/** Drop anything in a saved panel record that is not a panel or not a colour. */
export function cleanPanels(raw: unknown): PanelPaint | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: PanelPaint = {};
  for (const p of PANELS) {
    const v = (raw as Record<string, unknown>)[p];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 0xffffff) out[p] = Math.floor(v);
  }
  return Object.keys(out).length ? out : undefined;
}

export function colorName(c: number): string {
  return PARTS.paints.find((p) => p.c === c)?.name ?? `#${c.toString(16).padStart(6, '0')}`;
}

/** The can found in a trunk: a random swatch with a few sprays in it. */
export function foundCan(roll: () => number): { color: number; charges: number } {
  const swatch = PARTS.paints[Math.floor(roll() * PARTS.paints.length)];
  return { color: swatch.c, charges: 3 + Math.floor(roll() * 4) };
}
