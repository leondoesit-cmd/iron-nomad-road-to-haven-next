import * as THREE from 'three';
import { INTERIOR_SLOTS, mountsFor, partDef, t, type PartSlot } from '../data';
import { accessPointsOf, type AccessPoint } from '../render/accessPoints';
import { socketDistance, socketFor, type Anchor, type Socket } from '../render/sockets';
import { currentCond, idInSlot, tyreIdAt } from '../sim/garage';
import { MK_CSS, type GhostAnchor } from '../render/workFx';
import { promptLabel } from '../input/input';
import { gate, needText, panelName, panelOfSpot, workFor, type Gate, type Job, type Panel, type PanelOpen, type Spot } from '../sim/access';
import type { Cand, Player } from './player';
import type { Vehicle } from './vehicle';

/**
 * Where a player stands against a vehicle. A job is done at one access point (`render/accessPoints.ts`): within about a
 * metre and a half of it, facing it. Which jobs go to which point, and what has to be open first, is `sim/access.ts`; this
 * file turns that into a person standing next to a car: which point they have reached, the prompts that say where to go, and
 * the open and close job for the bonnet, the doors and the boot lid.
 */

/** Vehicles that count as "our ride": the convoy's own cars with a build. */
export const isOwnRide = (v: Vehicle) => v.faction === 'convoy' && !!v.build && !v.wreck && v.kind !== 'crew';

/**
 * Vehicles that can be worked on by hand: our own, and any abandoned car with a build. A found car is treated as if it were
 * already ours (a part bolted on or off, something stowed in it, makes it the convoy's, as driving it would).
 */
export const isWorkable = (v: Vehicle) => !!v.build && !v.wreck && v.kind !== 'crew' && (v.faction === 'convoy' || v.faction === 'neutral') && v.def.physics.kind !== 'boat';

/** How far (m) a person reaches to each kind of point: the engine bay and the roof are big. */
export const REACH: Record<Spot, number> = { hood: 1.8, doorL: 1.5, doorR: 1.5, trunk: 1.5, flap: 1.5, wheel: 1.5, under: 1.5, roof: 2.3, front: 1.5, rear: 1.5, flank: 1.5, gun: 1.8, screen: 1.7, back: 1.7 };

/** How squarely a point has to be in front of you (dot of the way you face and the way it lies). */
const FACING = 0.2;

export interface Reach {
  v: Vehicle;
  pt: AccessPoint;
  pos: THREE.Vector3;
  /** Metres from the hands to the point, height counting a third as much as ground. */
  dist: number;
  /** 1 when it is straight ahead, 0 when it is off to the side. */
  facing: number;
}

/** A point of a vehicle in the world. */
export function pointPos(v: Vehicle, pt: AccessPoint, out = new THREE.Vector3()): THREE.Vector3 {
  const [x, y, z] = v.body.toWorld(pt.x, pt.y, pt.z);
  return out.set(x, y, z);
}

/** Distance from a person to a point in the world. */
export const reachDist = (p: Player, pos: THREE.Vector3) => Math.hypot(pos.x - p.pos.x, pos.z - p.pos.z) + Math.abs(pos.y - (p.pos.y + 1.0)) * 0.35;

function measure(p: Player, v: Vehicle, pt: AccessPoint): Reach {
  const pos = pointPos(v, pt);
  const dx = pos.x - p.pos.x;
  const dz = pos.z - p.pos.z;
  const l = Math.hypot(dx, dz);
  const facing = l < 0.45 ? 1 : (dx * Math.sin(p.aimYaw) + dz * Math.cos(p.aimYaw)) / l;
  return { v, pt, pos, dist: reachDist(p, pos), facing };
}

/** Every point of the given kinds (all, if none are named) that the player has reached on this vehicle, best first. */
export function reachedAll(p: Player, v: Vehicle, spots?: readonly Spot[]): Reach[] {
  const out: Reach[] = [];
  for (const pt of accessPointsOf(v.def)) {
    if (spots && !spots.includes(pt.spot)) continue;
    const r = measure(p, v, pt);
    if (r.dist <= REACH[pt.spot] && r.facing >= FACING) out.push(r);
  }
  return out.sort((a, b) => a.dist - 1.2 * a.facing - (b.dist - 1.2 * b.facing));
}

/** The point the player is working at, or null when they stand at none of the kinds named. */
export function reached(p: Player, v: Vehicle, spots?: readonly Spot[]): Reach | null {
  return reachedAll(p, v, spots)[0] ?? null;
}

/** The nearest point of those kinds however far off it is: where to send a player who is in the wrong place. */
export function nearestPoint(p: Player, v: Vehicle, spots: readonly Spot[]): Reach | null {
  let best: Reach | null = null;
  for (const pt of accessPointsOf(v.def)) {
    if (!spots.includes(pt.spot)) continue;
    const r = measure(p, v, pt);
    if (!best || r.dist < best.dist) best = r;
  }
  return best;
}

/** Where a job stands for this player: the point they are at, whether they may go ahead, and if not why. */
export interface Place {
  v: Vehicle;
  job: Job;
  at: Reach | null;
  open: PanelOpen;
  gate: Gate;
}

export function placeFor(p: Player, v: Vehicle, job: Job): Place {
  const wk = workFor(v.def, job);
  const at = wk ? reached(p, v, wk.at) : null;
  const open = v.panelOpen();
  return { v, job, at, open, gate: gate(v.def, job, at?.pt.spot ?? null, open) };
}

/** The word for the player's A button, as their seat has it bound. */
export const aLabel = (p: Player): string => promptLabel(p.ctx.input.slots?.[p.index] ?? null, 'A');

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** What the bonnet, a door or the boot is, as a callout above it: shut or open, and what is behind it. */
export function panelCallout(p: Player, v: Vehicle, panel: Panel): { text: string; css: string } {
  const name = cap(panelName(v.def, panel));
  const open = v.panelOpen()[panel];
  if (!open) return { text: t('access.closed', { Name: name, btn: aLabel(p) }), css: '#cfc8b4' };
  let what = '';
  if (panel === 'hood') {
    const id = v.build ? idInSlot(v.build, 'engine') : null;
    what = id && !partDef(id).empty ? partDef(id).name : 'bay empty';
  }
  return { text: what ? `${t('access.opened', { Name: name })}: ${what}` : t('access.opened', { Name: name }), css: MK_CSS[1] };
}

/** The spots that have a real panel on this vehicle right now (not stripped, not torn off). */
export function panelSpots(v: Vehicle): Spot[] {
  return (['hood', 'doorL', 'doorR', 'trunk'] as const).filter((s) => v.hasPanel(s));
}

/** The job of swinging one panel: a short hold, then it swings. */
export function panelCand(p: Player, v: Vehicle, panel: Panel, open: boolean, then?: string): Cand {
  const moving = Math.abs(v.speed) > 1;
  const name = panelName(v.def, panel);
  const base = t(open ? 'access.open' : 'access.close', { name });
  return {
    kind: 'panel',
    prompt: moving ? t('access.moving', { name: v.def.name }) : then ? `${base}  ·  ${then}` : base,
    dur: 0.5,
    target: `${v.id}:${panel}`,
    ok: !moving,
    label: open ? 'open' : 'close',
    noise: 4,
    run: () => {
      v.setPanel(panel, open);
    },
  };
}

/** Light up the panel points of a vehicle, and call out the one in reach. */
export function focusPanels(p: Player, v: Vehicle, at: Reach | null) {
  const dots = panelSpots(v)
    .flatMap((s) => accessPointsOf(v.def).filter((q) => q.spot === s))
    .map((q) => pointPos(v, q));
  let target = null;
  if (at) {
    const panel = panelOfSpot(at.pt.spot);
    if (panel) {
      const c = panelCallout(p, v, panel);
      target = { pos: at.pos, text: c.text, css: c.css, ok: true };
    }
  }
  p.ctx.work.focus(p.index, dots, target);
}

/**
 * Hands free, or a tool with nothing to do here: the panel in front of you. Hold the button to swing it open or shut. With
 * `closeOnly` (a tool in hand) it only offers to shut something that is open, so a wrench next to a door still repairs the car.
 */
export function panelCandidate(p: Player, closeOnly = false): Cand | null {
  const v = p.nearestVehicle(5, isWorkable);
  if (!v?.build) return null;
  const spots = panelSpots(v);
  if (!spots.length) return null;
  const at = reached(p, v, spots);
  if (!at) return null;
  const panel = panelOfSpot(at.pt.spot)!;
  const open = !!v.open[panel];
  if (closeOnly && !open) return null;
  focusPanels(p, v, at);
  return panelCand(p, v, panel, !open);
}

/** The cabin and cargo panels at a point, if the player stands at one that is shut: for "open it first" steps. */
export function openStep(p: Player, v: Vehicle, g: Place, then?: string): Cand | null {
  if (g.gate.need?.kind !== 'open' || !g.at) return null;
  return panelCand(p, v, g.gate.need.panel, true, then);
}

/** The guidance line for a job the player is not at: "Go to the fuel flap at the back to ...". */
export function goLine(v: Vehicle, g: Place, verb?: string): string {
  return g.gate.need ? needText(v.def, g.gate.need, verb) : '';
}


// ------------------------------------------------------------------------------------------------ sockets at the points you stand at

/** Slots that count as one place per wheel. */
export const PER_WHEEL: PartSlot[] = ['wheels', 'suspension', 'brakes'];

export interface SocketHit {
  v: Vehicle;
  sock: Socket;
  anchor: Anchor;
  /** Which anchor of the socket: for wheels, brakes and springs this is the wheel number. */
  index: number;
  /** Metres from the player's hands to the point they stand at for it. */
  dist: number;
}

/** A point of the vehicle's own frame in the world. */
export function anchorWorld(v: Vehicle, a: Anchor): THREE.Vector3 {
  const [x, y, z] = v.body.toWorld(a.x, a.y, a.z);
  return new THREE.Vector3(x, y, z);
}

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

/** A world point in a vehicle's own frame. */
export function toLocal(v: Vehicle, x: number, y: number, z: number): [number, number, number] {
  const tr = v.body.body.translation();
  const r = v.body.body.rotation();
  _q.set(r.x, r.y, r.z, r.w).invert();
  _v.set(x - tr.x, y - tr.y, z - tr.z).applyQuaternion(_q);
  return [_v.x, _v.y, _v.z];
}

/** The part fitted at a hit, with how worn it is: the tyre on that wheel, or whatever is in the slot. Null for an empty mount. */
export function fittedAt(hit: SocketHit): { id: string; cond: number } | null {
  const b = hit.v.build;
  if (!b) return null;
  if (hit.sock.slot === 'wheels') {
    const id = tyreIdAt(b, hit.index);
    return id ? { id, cond: b.comp.tires[hit.index] ?? 1 } : null;
  }
  const id = idInSlot(b, hit.sock.slot);
  return id ? { id, cond: currentCond(b, hit.sock.slot) } : null;
}

/** Parts that sit under the body panels: with a panel shut, the panel is what you work on. */
const INTERNAL: PartSlot[] = ['engine', 'cooling', 'gearbox', 'exhaust', 'suspension', 'brakes', ...INTERIOR_SLOTS];
/** Big panels: with one open, what is behind it is what you work on. */
const PANEL_SLOTS: PartSlot[] = ['hood', 'doorL', 'doorR'];

/** The socket for `slot` at the point the player has reached for it, with the anchor nearest them. */
function hitAt(p: Player, v: Vehicle, slot: PartSlot, r: Reach): SocketHit | null {
  const sock = socketFor(v.def, slot);
  if (!sock) return null;
  let index = 0;
  if (PER_WHEEL.includes(slot)) index = Math.min(r.pt.index, sock.anchors.length - 1);
  else {
    const [lx, ly, lz] = toLocal(v, p.pos.x, p.pos.y + 1.0, p.pos.z);
    index = socketDistance(sock, lx, ly, lz).index;
  }
  return { v, sock, anchor: sock.anchors[index], index, dist: r.dist };
}

export interface ToolHit {
  hit: SocketHit;
  reach: Reach;
  gate: Gate;
}

/**
 * The mount a player is working at with a tool or their hands: of the slots (`only`, or all the vehicle has) worked on at the
 * points they have reached, the one they are facing. A mount whose panel is shut comes second to one they can work on now, and
 * a shut panel is what you work on rather than what is behind it; an open one the other way round. `keep` can drop mounts
 * (the crowbar skips the empty ones).
 */
export function toolHit(p: Player, v: Vehicle, only: readonly PartSlot[] | null, keep?: (hit: SocketHit) => boolean): ToolHit | null {
  const reach = reachedAll(p, v);
  if (!reach.length) return null;
  const open = v.panelOpen();
  let best: ToolHit | null = null;
  let bs = Infinity;
  for (const slot of v.def.slots ?? []) {
    if (only && !only.includes(slot)) continue;
    const wk = workFor(v.def, slot);
    if (!wk) continue;
    const r = reach.find((q) => wk.at.includes(q.pt.spot));
    if (!r) continue;
    const hit = hitAt(p, v, slot, r);
    if (!hit || (keep && !keep(hit))) continue;
    const g = gate(v.def, slot, r.pt.spot, open);
    const panelOpen = PANEL_SLOTS.includes(slot) && open[slot as Panel];
    // A door's window is outside work while the door is shut; with it open, the cabin behind it comes first.
    const windowOpen = (slot === 'glassL' && open.doorL) || (slot === 'glassR' && open.doorR);
    const score = r.dist - 1.2 * r.facing + (g.ok ? 0 : 5) + (INTERNAL.includes(slot) ? 0.35 : 0) + (PANEL_SLOTS.includes(slot) ? (panelOpen ? 2 : -0.3) : 0) + (windowOpen ? 0.6 : 0) + (slot === 'glassF' || slot === 'glassB' ? 0.6 : 0);
    if (score < bs) {
      bs = score;
      best = { hit, reach: r, gate: g };
    }
  }
  return best;
}

/** Where a carried part (of `category`) would go: the mount it is at, or null with the places it could go. */
export function carryTarget(p: Player, v: Vehicle, category: PartSlot): { hit: SocketHit; reach: Reach; gate: Gate; mount: PartSlot } | { hit: null; spots: Spot[] } {
  const open = v.panelOpen();
  const mounts = mountsFor(category).filter((m) => (v.def.slots ?? []).includes(m));
  const spots: Spot[] = [];
  let best: { hit: SocketHit; reach: Reach; gate: Gate; mount: PartSlot } | null = null;
  for (const m of mounts) {
    const wk = workFor(v.def, m);
    if (!wk) continue;
    for (const s of wk.at) if (!spots.includes(s)) spots.push(s);
    const r = reached(p, v, wk.at);
    if (!r) continue;
    const hit = hitAt(p, v, m, r);
    if (!hit) continue;
    const c = { hit, reach: r, gate: gate(v.def, m, r.pt.spot, open), mount: m };
    if (!best || r.dist - r.facing < best.reach.dist - best.reach.facing) best = c;
  }
  return best ?? { hit: null, spots };
}

/** The outline boxes of a socket in the world, for the ghost the workshop draws. `only` picks one anchor (one wheel of four). */
export function ghostAnchors(v: Vehicle, sock: Socket, only?: number): GhostAnchor[] {
  const r = v.body.body.rotation();
  const list = only === undefined ? sock.anchors : [sock.anchors[only]];
  return list.map((a) => ({ pos: anchorWorld(v, a), quat: new THREE.Quaternion(r.x, r.y, r.z, r.w), size: [a.sx + 0.04, a.sy + 0.04, a.sz + 0.04] as [number, number, number], shape: sock.slot === 'wheels' ? ('drum' as const) : ('box' as const) }));
}
