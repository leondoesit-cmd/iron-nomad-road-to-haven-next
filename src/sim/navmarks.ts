/**
 * The marks the players put on the map: one waypoint each, and a shared list of points of interest. Plain data that rides in
 * the campaign save, so a mark made on one day is still there the next. Coordinates are the leg's own, so every mark
 * remembers which leg it was made on and only shows there.
 */

export const POI_KINDS = ['camp', 'fuel', 'loot', 'danger', 'car', 'water', 'food', 'note', 'star'] as const;
export type PoiKind = (typeof POI_KINDS)[number];

/** Name and colour of each kind of mark (the glyph is drawn by the map, `ui/minimap.ts`). */
export const POI_DEF: Record<PoiKind, { name: string; color: string }> = {
  camp: { name: 'Camp', color: '#f2c26b' },
  fuel: { name: 'Fuel', color: '#ff9440' },
  loot: { name: 'Loot', color: '#e6cf5a' },
  danger: { name: 'Danger', color: '#ff5545' },
  car: { name: 'Car', color: '#8fc8ff' },
  water: { name: 'Water', color: '#4fb6ff' },
  food: { name: 'Food', color: '#9bd85e' },
  note: { name: 'Note', color: '#e9dfc7' },
  star: { name: 'Star', color: '#ffe45a' },
};

export interface Poi {
  id: number;
  /** The leg it was made on. */
  leg: string;
  x: number;
  z: number;
  kind: PoiKind;
  name: string;
  /** Shown on the compass however far away it is. */
  pin: boolean;
  /** Which seat made it. */
  by: number;
}

export interface Waypoint {
  leg: string;
  x: number;
  z: number;
}

export interface NavMarks {
  waypoints: [Waypoint | null, Waypoint | null];
  pois: Poi[];
  nextId: number;
}

/** The most marks kept: beyond this the oldest go. */
export const MAX_POIS = 120;
export const NAME_MAX = 24;

export const newNavMarks = (): NavMarks => ({ waypoints: [null, null], pois: [], nextId: 1 });

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Tidy a typed name: printable, single spaces, not too long. Empty means "use the kind's name". */
export function cleanName(s: string): string {
  return s
    .replace(/[^\p{L}\p{N} .,'!?&#:()/+-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
}

/** Read the marks back from a save, dropping whatever is malformed. Saves from before marks existed have none. */
export function restoreNavMarks(raw: unknown): NavMarks {
  const out = newNavMarks();
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as { waypoints?: unknown; pois?: unknown; nextId?: unknown };
  if (Array.isArray(r.waypoints)) {
    for (let i = 0; i < 2; i++) {
      const w = r.waypoints[i] as Partial<Waypoint> | null | undefined;
      if (w && typeof w.leg === 'string' && num(w.x) && num(w.z)) out.waypoints[i] = { leg: w.leg, x: w.x, z: w.z };
    }
  }
  let top = 0;
  if (Array.isArray(r.pois)) {
    for (const p of r.pois as Partial<Poi>[]) {
      if (!p || typeof p !== 'object' || typeof p.leg !== 'string' || !num(p.x) || !num(p.z)) continue;
      if (!POI_KINDS.includes(p.kind as PoiKind)) continue;
      const id = num(p.id) && p.id > 0 && !out.pois.some((q) => q.id === p.id) ? Math.floor(p.id) : 0;
      const poi: Poi = { id, leg: p.leg, x: p.x, z: p.z, kind: p.kind as PoiKind, name: typeof p.name === 'string' ? cleanName(p.name) : '', pin: !!p.pin, by: p.by === 1 ? 1 : 0 };
      out.pois.push(poi);
      top = Math.max(top, poi.id);
      if (out.pois.length >= MAX_POIS) break;
    }
  }
  // Marks that came without an id get fresh ones above every saved id.
  out.nextId = Math.max(num(r.nextId) ? Math.floor(r.nextId) : 1, top + 1);
  for (const p of out.pois) if (!p.id) p.id = out.nextId++;
  return out;
}

/** Set a seat's waypoint, or clear it when the new one lands on the old (within `again` metres). Returns whether one is set now. */
export function toggleWaypoint(m: NavMarks, seat: number, leg: string, x: number, z: number, again = 12): boolean {
  const w = m.waypoints[seat];
  if (w && w.leg === leg && Math.hypot(w.x - x, w.z - z) <= again) {
    m.waypoints[seat] = null;
    return false;
  }
  m.waypoints[seat] = { leg, x, z };
  return true;
}

export function addPoi(m: NavMarks, p: Omit<Poi, 'id' | 'name' | 'pin'> & { name?: string; pin?: boolean }): Poi {
  const poi: Poi = { id: m.nextId++, leg: p.leg, x: p.x, z: p.z, kind: p.kind, name: cleanName(p.name ?? ''), pin: !!p.pin, by: p.by };
  m.pois.push(poi);
  while (m.pois.length > MAX_POIS) m.pois.shift();
  return poi;
}

export function removePoi(m: NavMarks, id: number): boolean {
  const i = m.pois.findIndex((p) => p.id === id);
  if (i < 0) return false;
  m.pois.splice(i, 1);
  return true;
}

export function renamePoi(m: NavMarks, id: number, name: string): boolean {
  const p = m.pois.find((q) => q.id === id);
  if (!p) return false;
  p.name = cleanName(name);
  return true;
}

/** What a mark is called on the map: its own name, or the name of its kind. */
export const poiLabel = (p: Poi) => p.name || POI_DEF[p.kind].name;
