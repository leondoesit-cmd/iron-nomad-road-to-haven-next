import { partDef, t, type PartSlot, type VehicleDef } from '../data';
import { slotsOf, type Fit } from './parts';

/**
 * Working on a vehicle: where you stand and in what order. Every job on a vehicle (bolting a part on, pouring fuel, stowing
 * a crate) happens at one **access point** of the vehicle, and some of those points are behind a **panel** that has to be
 * open first: the engine is under the bonnet, the back seat is behind a door, the boot is behind its lid. This file is the
 * rules table and nothing else (no three.js, no scene): where the points are is `render/accessPoints.ts`, how a player is
 * placed against them is `game/access.ts`.
 */

/** Panels that swing open and shut. */
export type Panel = 'hood' | 'doorL' | 'doorR' | 'trunk';
export const PANELS: Panel[] = ['hood', 'doorL', 'doorR', 'trunk'];

/** The places on a vehicle a job is done at. Doors, the bonnet and the boot are panels; the rest are just places. */
export type Spot = 'hood' | 'doorL' | 'doorR' | 'trunk' | 'flap' | 'wheel' | 'under' | 'roof' | 'front' | 'rear' | 'flank' | 'gun';
export const SPOTS: Spot[] = ['hood', 'doorL', 'doorR', 'trunk', 'flap', 'wheel', 'under', 'roof', 'front', 'rear', 'flank', 'gun'];

/** Open (or missing, or never there) per panel. */
export type PanelOpen = Record<Panel, boolean>;

/** The panel a spot is behind, if it is one. */
export const panelOfSpot = (s: Spot): Panel | null => (s === 'hood' || s === 'doorL' || s === 'doorR' || s === 'trunk' ? s : null);

/** Boot lids: a sedan's, a hatchback's tailgate, a van's rear door. A pickup's bed, a buggy's bed and a bike's rack have none. */
const LIDS = new Set(['hatch', 'sedan', 'van']);

/** The panels this chassis has. One it lacks counts as permanently open. */
export function panelsOf(def: VehicleDef): Panel[] {
  const s = slotsOf(def);
  const out: Panel[] = [];
  if (s.includes('hood')) out.push('hood');
  if (s.includes('doorL')) out.push('doorL');
  if (s.includes('doorR')) out.push('doorR');
  if (LIDS.has(def.id)) out.push('trunk');
  return out;
}

/** Has the part that makes this panel been taken off (the bonnet or a door stripped, a canvas flap in place of a door)? */
export function panelStripped(def: VehicleDef, fit: Fit, p: Panel): boolean {
  if (p === 'trunk') return false;
  const it = fit[p];
  if (!it) return false;
  const d = partDef(it.id);
  // A roll-up canvas door is always rolled up: open to everything.
  return !!d.empty || it.id === 'door_light';
}

/**
 * What is open right now. `flags` is what the player has opened; `gone` says which panels have been torn or shot off.
 * A panel the chassis does not have, one that is stripped and one that is gone all count as open.
 */
export function effectiveOpen(def: VehicleDef, fit: Fit, flags: Partial<Record<Panel, boolean>>, gone: Partial<Record<Panel, boolean>> = {}): PanelOpen {
  const has = panelsOf(def);
  const out = {} as PanelOpen;
  for (const p of PANELS) out[p] = !has.includes(p) || panelStripped(def, fit, p) || !!gone[p] || !!flags[p];
  return out;
}

/** The side of the driver's seat: +1 is the left (+x) door. */
export const driverSide = (def: VehicleDef): 1 | -1 => ((def.seat?.driver[0] ?? 1) >= 0 ? 1 : -1);
/** The driver's door and the passenger's. */
export const driverDoor = (def: VehicleDef): Spot => (driverSide(def) > 0 ? 'doorL' : 'doorR');
export const passengerDoor = (def: VehicleDef): Spot => (driverSide(def) > 0 ? 'doorR' : 'doorL');

// ------------------------------------------------------------------------------------------------ the table

/** Jobs that are not a part in a slot. */
export type Chore = 'fuel' | 'oil' | 'water' | 'stow' | 'spray';
export type Job = PartSlot | Chore;

export interface Work {
  /** Stand at one of these. */
  at: Spot[];
  /** The panel at the spot you stand at must be open (or missing). */
  open: boolean;
  /** A new part may replace a fitted one in the same go. Panels first have to come off. */
  swap: boolean;
}

const w = (at: Spot[], open = false, swap = true): Work => ({ at, open, swap });

/**
 * Where each slot is worked on and what has to be open, for this chassis. Null when it has no such mount.
 *  - engine bay (engine, radiator, oil, water): at the bonnet, bonnet open.
 *  - the bonnet and the doors themselves: at their own panel, open or shut (they lift off their hinge pins), and a new one
 *    only goes where the old one has been taken off first.
 *  - tyres, springs and brakes: at the wheel. Gearbox and exhaust: underneath, from beside the sill.
 *  - the cabin: through the door on that side, open (the rear seat through either door; the wheel and dash via the driver's).
 *  - fuel: at the flap. Stowing (inside, secure): the boot with its lid open, or the back seat through an open door (a pickup's
 *    cab and a buggy's seat well too). Loads on the outside are set down at the roof, the bed, the rack or the rear cage (`sim/cargo.ts`).
 *  - bolt-ons outside (armour, mounts, rack, gun post): proximity only.
 */
export function workFor(def: VehicleDef, job: Job): Work | null {
  const slots = slotsOf(def);
  if (!['fuel', 'oil', 'water', 'stow', 'spray'].includes(job) && !slots.includes(job as PartSlot)) return null;
  const drv = driverDoor(def);
  const pas = passengerDoor(def);
  switch (job) {
    case 'engine':
    case 'cooling':
    case 'oil':
    case 'water':
      return w(['hood'], true);
    case 'hood':
      return w(['hood'], false, false);
    case 'doorL':
      return w(['doorL'], false, false);
    case 'doorR':
      return w(['doorR'], false, false);
    case 'wheels':
    case 'suspension':
    case 'brakes':
      return w(['wheel']);
    case 'gearbox':
    case 'exhaust':
      return w(['under']);
    case 'seatD':
    case 'steer':
    case 'dash':
      return w([drv], true);
    case 'seatP':
      return w([pas], true);
    case 'seatR':
      return w([drv, pas], true);
    case 'fuel':
      return w(['flap']);
    case 'stow':
      // Inside the vehicle: the boot, or the back seat through a door. A pickup and a buggy have no boot (the bed is an open
      // surface, `sim/cargo.ts`): what is stowed there goes behind the seats, through either door.
      return w(def.id === 'pickup' || def.id === 'buggy' ? [drv, pas] : slots.includes('seatR') ? ['trunk', drv, pas] : ['trunk'], true);
    case 'spray':
      return w(['doorL', 'doorR', 'hood', 'roof', 'front', 'rear']);
    case 'armor':
    case 'side':
    case 'utility':
      return w(['flank']);
    case 'weapon':
      return w(['gun']);
    case 'front':
      return w(['front']);
    case 'roof':
      return w(['roof']);
    case 'rear':
      return w(['rear']);
  }
  return null;
}

/** What stands between you and the job: go somewhere, open something, or take the old part off first. */
export type Need = { kind: 'go'; spots: Spot[] } | { kind: 'open'; panel: Panel } | { kind: 'free'; panel: Panel };

export interface Gate {
  ok: boolean;
  need?: Need;
}

/** Can this job be done standing at `at` with the panels as they are? */
export function gate(def: VehicleDef, job: Job, at: Spot | null, open: PanelOpen): Gate {
  const wk = workFor(def, job);
  if (!wk) return { ok: false, need: { kind: 'go', spots: [] } };
  if (!at || !wk.at.includes(at)) return { ok: false, need: { kind: 'go', spots: wk.at } };
  const p = panelOfSpot(at);
  if (wk.open && p && !open[p]) return { ok: false, need: { kind: 'open', panel: p } };
  return { ok: true };
}

/** Which slots are worked on at a spot, for one chassis (the dots that light up at a point). */
export function slotsAt(def: VehicleDef, spot: Spot): PartSlot[] {
  return slotsOf(def).filter((s) => workFor(def, s)?.at.includes(spot));
}

// ------------------------------------------------------------------------------------------------ words

/** What a spot is called in a prompt ("Walk to the engine bay"), and roughly where it is on the vehicle. */
export const SPOT_NAME: Record<Spot, { name: string; where: string }> = {
  hood: { name: 'engine bay', where: 'at the front' },
  doorL: { name: 'left door', where: 'on the left' },
  doorR: { name: 'right door', where: 'on the right' },
  trunk: { name: 'boot', where: 'at the back' },
  flap: { name: 'fuel flap', where: 'at the back (right side)' },
  wheel: { name: 'wheel', where: 'at a wheel' },
  under: { name: 'underbody', where: 'beside the sill' },
  roof: { name: 'roof rack', where: 'by the roof' },
  front: { name: 'front bumper', where: 'at the front' },
  rear: { name: 'rear mount', where: 'at the back' },
  flank: { name: 'side mounts', where: 'on the side' },
  gun: { name: 'gun post', where: 'by the gun' },
};

/** The spot's name on this chassis: the driver's and passenger's doors, a hatchback's tailgate, a van's rear door. */
export function spotName(def: VehicleDef, spot: Spot): string {
  if (spot === 'doorL' || spot === 'doorR') return spot === driverDoor(def) ? "driver's door" : 'passenger door';
  if (spot === 'trunk') return def.id === 'hatch' ? 'tailgate' : def.id === 'van' ? 'rear doors' : def.id === 'pickup' || def.id === 'buggy' ? 'bed' : 'boot';
  if (spot === 'hood' && !slotsOf(def).includes('hood')) return 'engine';
  return SPOT_NAME[spot].name;
}

/** The panel's name for open and close prompts ("bonnet", "driver's door"). */
export function panelName(def: VehicleDef, p: Panel): string {
  return p === 'hood' ? 'bonnet' : spotName(def, p);
}

/**
 * The line that says what stands in the way, in the order a mechanic would say it: where to go, what to open, what to
 * take off first. `verb` is the job, for "Go to the engine bay at the front to fit Tuned V6".
 */
export function needText(def: VehicleDef, need: Need, verb?: string): string {
  switch (need.kind) {
    case 'go': {
      const spot = need.spots.slice(0, 2).map((s) => `${spotName(def, s)} ${SPOT_NAME[s].where}`).join(' or the ');
      return verb ? t('access.goTo', { spot, verb }) : t('access.go', { spot });
    }
    case 'open':
      return t('access.needOpen', { name: panelName(def, need.panel) });
    case 'free':
      return t('access.needFree', { name: panelName(def, need.panel) });
  }
}
