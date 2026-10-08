import type { PartSlot } from '../data';

/**
 * Small line pictures of car parts and cans for the storage panel and the breakdown: an engine block, a radiator core, a tyre,
 * a jerrycan. One 20 x 20 box each, drawn in `currentColor` so a row tints its icon with the part's mark colour.
 */

const S = (body: string) => `<svg class="pi" viewBox="0 0 20 20" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</g></svg>`;

const ICONS: Record<string, string> = {
  engine: S('<rect x="4" y="7" width="11" height="8" rx="1"/><path d="M6 7V5h5v2M15 9h2v4h-2M4 10H2.5v3H4M7 15v2M12 15v2"/>'),
  cooling: S('<rect x="3" y="4" width="14" height="12" rx="1"/><path d="M6 4v12M9 4v12M12 4v12M15 4v12"/>'),
  gearbox: S('<circle cx="7" cy="8" r="3.2"/><circle cx="13.5" cy="12.5" r="2.4"/><path d="M7 3.5v1.3M7 11.2v1.3M2.5 8h1.3M10.2 8h1.3"/>'),
  exhaust: S('<path d="M2 12h9l2-2h3"/><rect x="11" y="8.5" width="6" height="5" rx="2.5"/><path d="M17 11h1.5"/>'),
  suspension: S('<path d="M10 2v2M10 16v2M6 4h8M6 16h8M7 6l6 1.6-6 1.6 6 1.6-6 1.6 6 1.6"/>'),
  brakes: S('<circle cx="10" cy="10" r="6.5"/><circle cx="10" cy="10" r="2"/><path d="M14.5 5.5l2-1.5v5"/>'),
  wheels: S('<circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="3"/><path d="M10 3v4M10 13v4M3 10h4M13 10h4"/>'),
  hood: S('<path d="M3 13l2-6h10l2 6z"/><path d="M8 10h4"/>'),
  door: S('<path d="M5 3h9v14H5zM5 9h9"/><path d="M11 12h2"/>'),
  armor: S('<path d="M10 2l6 2.5v5c0 4-3 6.5-6 8.5-3-2-6-4.5-6-8.5v-5z"/><path d="M10 6v8"/>'),
  weapon: S('<path d="M2 9h11l2-2h3v4h-3l-1 1H8l-1 4H5l1-4H2z"/>'),
  utility: S('<rect x="3" y="6" width="14" height="9" rx="1"/><path d="M3 9h14M7 6V4h6v2"/>'),
  front: S('<path d="M2 12h16M3 9h14M4 9v6M16 9v6"/>'),
  rear: S('<path d="M3 13h14v3H3zM5 13V8h10v5"/>'),
  roof: S('<path d="M3 11h14M5 11V8M10 11V8M15 11V8M2 8h16"/>'),
  side: S('<path d="M2 12h16M2 15h16"/>'),
  seat: S('<path d="M6 3h4l1 9h4v3H6z"/><path d="M8 15v2M13 15v2"/>'),
  steer: S('<circle cx="10" cy="10" r="6.5"/><circle cx="10" cy="10" r="1.6"/><path d="M3.8 9h4.6M11.6 9h4.6M10 11.6V16"/>'),
  dash: S('<path d="M2 13c0-4 3.5-7 8-7s8 3 8 7z"/><path d="M10 13l3-4"/>'),
  glass: S('<path d="M4 15l2-10h8l2 10z"/><path d="M8 8l-1 3M11 7l-2 6"/>'),
  fuel: S('<path d="M5 4h7l3 3v10H5z"/><path d="M12 4v3h3M8 2h3v2M8 10h4M8 13h4"/>'),
  oil: S('<path d="M5 8h9v9H5z"/><path d="M14 10l3-2M8 8V5h3v3"/><path d="M9.5 11.5c-1 1.3-1 2.5 0 2.8s1-1.5 0-2.8z"/>'),
  water: S('<path d="M10 3c-3 4-5 6.5-5 9a5 5 0 0 0 10 0c0-2.5-2-5-5-9z"/>'),
  crate: S('<rect x="3" y="6" width="14" height="10"/><path d="M3 6l7-3 7 3M10 3v13"/>'),
};

const SLOT_ICON: Partial<Record<PartSlot, string>> = {
  engine: 'engine',
  cooling: 'cooling',
  gearbox: 'gearbox',
  exhaust: 'exhaust',
  suspension: 'suspension',
  brakes: 'brakes',
  wheels: 'wheels',
  hood: 'hood',
  doorL: 'door',
  doorR: 'door',
  armor: 'armor',
  weapon: 'weapon',
  utility: 'utility',
  front: 'front',
  rear: 'rear',
  roof: 'roof',
  side: 'side',
  seatD: 'seat',
  seatP: 'seat',
  seatR: 'seat',
  steer: 'steer',
  dash: 'dash',
  glassF: 'glass',
  glassB: 'glass',
  glassL: 'glass',
  glassR: 'glass',
};

/** The picture for a part's slot. */
export const slotIcon = (slot: PartSlot | undefined) => ICONS[(slot && SLOT_ICON[slot]) || 'crate'];

/** The picture for a can or a load: fuel, oil, water, a crate. */
export const kindIcon = (kind: 'fuel' | 'diesel' | 'oil' | 'water' | 'crate') => ICONS[kind === 'diesel' ? 'fuel' : kind];
