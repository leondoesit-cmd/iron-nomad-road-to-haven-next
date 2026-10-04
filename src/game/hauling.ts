import * as THREE from 'three';
import { PARTS, mountsFor, partDef, type PartSlot } from '../data';
import { MK_CSS, SLOT_SITE, modelKey, type GhostAnchor, type Site } from '../render/workFx';
import { panelAnchor, socketDistance, socketFor, type Anchor, type Socket } from '../render/sockets';
import { PANEL_NAME, colorName, panelColor, paintPanel, panelsOf, type PanelId } from '../sim/paint';
import { OIL_RESERVE_MAX } from './campaign';
import { carriedName, carryModelKey, inspectLines, liftSecs, partInspect, planFit, planStow, pourFuel, type Carried } from '../sim/carry';
import { idInSlot, installPart, removePart, removeTyre, tyreIdAt } from '../sim/garage';
import { currentCond } from '../sim/garage';
import { planPour } from '../sim/fuel';
import { pourOil } from '../sim/oil';
import { WATER_RESERVE_MAX, pourWater } from '../sim/fluids';
import { partName } from '../sim/parts';
import { deckCandidate, pickMount } from './carwork';
import type { Cand, Player } from './player';
import type { Vehicle } from './vehicle';

/**
 * Carrying things by hand. Lift a part, a fuel can or an oil can off the ground, walk it to one of your own vehicles,
 * and either put it straight on (A: bolt it on, pour it in, top the sump up) or stow it in the trucks (X) for later.
 * X anywhere else sets it down.
 */

/** Vehicles that count as "our ride": the convoy's own cars with a build, and abandoned ones (claimed at the first job). */
const isOwnRide = (v: Vehicle) => (v.faction === 'convoy' || v.faction === 'neutral') && !!v.build && !v.wreck && v.kind !== 'crew';

/** Where on a vehicle a job at `site` happens, in the world. */
export function sitePos(v: Vehicle, site: Site): THREE.Vector3 {
  const w = v.def.width / 2;
  const l = v.def.length / 2;
  const at = (x: number, y: number, z: number) => {
    const [px, py, pz] = v.body.toWorld(x, y, z);
    return new THREE.Vector3(px, py, pz);
  };
  switch (site) {
    case 'hood': return at(0, 1.0, l * 0.55);
    case 'wheel': return at(w + 0.1, 0.4, l * 0.5);
    case 'flank': return at(w + 0.15, 0.9, 0);
    case 'roof': return at(0, 1.7, 0);
    case 'rear': return at(0, 0.9, -l - 0.1);
    case 'front': return at(0, 0.7, l + 0.1);
    case 'gun': return at(0, 1.5, -0.3);
    case 'under': return at(0, 0.25, 0);
  }
}

const slotSite = (id: string): Site => SLOT_SITE[partDef(id).slot] ?? 'hood';
const handPos = (p: Player) => p.human.hand.getWorldPosition(new THREE.Vector3());
const trunkPos = (v: Vehicle) => sitePos(v, 'rear');

/** How close a loose item must be to lift it. */
export const LIFT_REACH = 1.9;

function ownRideNear(p: Player): Vehicle | null {
  return p.nearestVehicle(3.8, isOwnRide);
}

// ---------------------------------------------------------------- sockets

/** How close your hands must be to a socket to work on it, and how far away its outline shows. */
export const FIT_REACH = 3.6;
export const SHOW_REACH = 11;

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

/** A world point in a vehicle's own frame. */
function toLocal(v: Vehicle, x: number, y: number, z: number): [number, number, number] {
  const t = v.body.body.translation();
  const r = v.body.body.rotation();
  _q.set(r.x, r.y, r.z, r.w).invert();
  _v.set(x - t.x, y - t.y, z - t.z).applyQuaternion(_q);
  return [_v.x, _v.y, _v.z];
}

function anchorWorld(v: Vehicle, a: Anchor): THREE.Vector3 {
  const [x, y, z] = v.body.toWorld(a.x, a.y, a.z);
  return new THREE.Vector3(x, y, z);
}

function ghostAnchors(v: Vehicle, sock: Socket, only?: number): GhostAnchor[] {
  const r = v.body.body.rotation();
  const list = only === undefined ? sock.anchors : [sock.anchors[only]];
  return list.map((a) => ({ pos: anchorWorld(v, a), quat: new THREE.Quaternion(r.x, r.y, r.z, r.w), size: [a.sx + 0.04, a.sy + 0.04, a.sz + 0.04] as [number, number, number] }));
}

export interface SocketHit {
  v: Vehicle;
  sock: Socket;
  anchor: Anchor;
  /** Which anchor of the socket: for wheels, brakes and springs this is the wheel number. */
  index: number;
  /** Metres from the player's hands to the closest anchor. */
  dist: number;
}

/** Sockets that count as one place per wheel. */
const PER_WHEEL: PartSlot[] = ['wheels', 'suspension', 'brakes'];

/**
 * The mount a hit means for `installPart`: the wheel number for a tyre, otherwise the slot. Springs and brakes are
 * fitted to the whole vehicle, so they name the slot.
 */
export function mountOf(hit: SocketHit): PartSlot | number {
  return hit.sock.slot === 'wheels' ? hit.index : hit.sock.slot;
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

/** The sockets a part of this category can go in on a chassis: a door fits either side, a tyre any wheel. */
function socketsFor(v: Vehicle, category: PartSlot): Socket[] {
  return mountsFor(category)
    .filter((m) => (v.def.slots ?? []).includes(m))
    .map((m) => socketFor(v.def, m))
    .filter((s): s is Socket => !!s);
}

/** The socket for a part's category that is closest to the player, across the convoy's own vehicles. */
export function nearestSocket(p: Player, category: PartSlot, within = SHOW_REACH): SocketHit | null {
  let best: SocketHit | null = null;
  for (const v of p.ctx.vehicles) {
    if (!isOwnRide(v)) continue;
    const [lx, ly, lz] = toLocal(v, p.pos.x, p.pos.y + 1.0, p.pos.z);
    for (const sock of socketsFor(v, category)) {
      const { dist, anchor, index } = socketDistance(sock, lx, ly, lz);
      if (dist <= within && (!best || dist < best.dist)) best = { v, sock, anchor, index, dist };
    }
  }
  return best;
}

/** Parts that sit under the body panels: a panel wins when both are in reach, until the panel is off. */
const INTERNAL: PartSlot[] = ['engine', 'cooling', 'gearbox', 'exhaust', 'suspension', 'brakes'];
/** Big panels: easy to mean when you are looking at them, so they win a close call against small parts beside them. */
const PANELS: PartSlot[] = ['hood', 'roof', 'doorL', 'doorR'];

/**
 * Of one vehicle's sockets, the one the player is facing and standing nearest to. With `occupied`, a mount with nothing
 * in it does not count, so a crowbar never stops at an empty mount with a part right behind it.
 */
function aimedSocket(p: Player, v: Vehicle, within: number, occupied = false): SocketHit | null {
  const [lx, ly, lz] = toLocal(v, p.pos.x, p.pos.y + 1.0, p.pos.z);
  const fx = Math.sin(p.aimYaw);
  const fz = Math.cos(p.aimYaw);
  let best: SocketHit | null = null;
  let bs = Infinity;
  for (const slot of v.def.slots ?? []) {
    const sock = socketFor(v.def, slot);
    if (!sock) continue;
    const { dist, anchor, index } = socketDistance(sock, lx, ly, lz);
    if (dist > within) continue;
    const hit: SocketHit = { v, sock, anchor, index, dist };
    if (occupied && !fittedAt(hit)) continue;
    const w = anchorWorld(v, anchor);
    const dx = w.x - p.pos.x;
    const dz = w.z - p.pos.z;
    const l = Math.hypot(dx, dz) || 1;
    const score = dist - 1.4 * Math.max(0, (dx * fx + dz * fz) / l) + (INTERNAL.includes(slot) ? 0.35 : 0) - (PANELS.includes(slot) ? 0.3 : 0);
    if (score < bs) {
      bs = score;
      best = hit;
    }
  }
  return best;
}

export interface PanelHit {
  panel: PanelId;
  anchor: Anchor;
  dist: number;
}

/** Of one vehicle's panels, the one the player is standing nearest and facing. */
function aimedPanel(p: Player, v: Vehicle, within = 3.4): PanelHit | null {
  const [lx, ly, lz] = toLocal(v, p.pos.x, p.pos.y + 1.0, p.pos.z);
  const fx = Math.sin(p.aimYaw);
  const fz = Math.cos(p.aimYaw);
  let best: PanelHit | null = null;
  let bs = Infinity;
  for (const panel of panelsOf(v.def)) {
    const a = panelAnchor(v.def, panel);
    if (!a) continue;
    const dist = Math.hypot(a.x - lx, (a.y - ly) * 0.5, a.z - lz);
    if (dist > within) continue;
    const w = anchorWorld(v, a);
    const dx = w.x - p.pos.x;
    const dz = w.z - p.pos.z;
    const l = Math.hypot(dx, dz) || 1;
    const score = dist - 1.4 * Math.max(0, (dx * fx + dz * fz) / l);
    if (score < bs) {
      bs = score;
      best = { panel, anchor: a, dist };
    }
  }
  return best;
}

function panelGhost(v: Vehicle, a: Anchor): GhostAnchor[] {
  const r = v.body.body.rotation();
  return [{ pos: anchorWorld(v, a), quat: new THREE.Quaternion(r.x, r.y, r.z, r.w), size: [a.sx + 0.05, a.sy + 0.05, a.sz + 0.05] }];
}

type Can = Extract<Carried, { kind: 'paint' }>;

/** Hold A with a spray can: paint the panel you are facing. */
function sprayCandidate(p: Player, c: Can): Cand | null {
  const ctx = p.ctx;
  const v = ownRideNear(p);
  if (!v?.build) return null;
  const hit = aimedPanel(p, v);
  if (!hit) {
    return { kind: 'spray', prompt: 'Step up to a panel to spray it', dur: 1, target: v, ok: false, label: 'spray', run: () => {} };
  }
  const b = v.build;
  const name = PANEL_NAME[hit.panel].toLowerCase();
  const already = panelColor(b.paint, b.panels, hit.panel) === c.color;
  const moving = Math.abs(v.speed) > 2;
  const rgb: [number, number, number] = [((c.color >> 16) & 255) / 255, ((c.color >> 8) & 255) / 255, (c.color & 255) / 255];
  return {
    kind: 'spray',
    prompt: moving ? `${v.def.name} is moving` : already ? `The ${name} is already ${colorName(c.color)}` : `Spray the ${name} ${colorName(c.color)} (${c.charges} left)`,
    dur: 2,
    target: `${v.id}:${hit.panel}`,
    ok: !already && !moving,
    label: 'spray',
    noise: 14,
    run: () => {
      if (p.carry !== c) return;
      v.commit();
      paintPanel(b, hit.panel, c.color);
      v.syncFromBuild();
      c.charges--;
      if (c.charges <= 0) {
        p.carry = null;
        p.note('The can is empty', 'info');
      }
      const at = anchorWorld(v, hit.anchor);
      ctx.audio.play('pickup', v.position.x, v.position.z, 0.6);
      ctx.work.label(`${PANEL_NAME[hit.panel]}  ${colorName(c.color)}`, `#${c.color.toString(16).padStart(6, '0')}`, at.clone().add(new THREE.Vector3(0, 0.9, 0)));
      ctx.work.burst(at, 1, 0.5);
      p.note(`${PANEL_NAME[hit.panel]} sprayed ${colorName(c.color)}${p.carry ? `: ${c.charges} left in the can` : ''}`, 'good');
    },
    tick: () => {
      const from = handPos(p);
      const to = anchorWorld(v, hit.anchor);
      // A spray of paint from the nozzle to the panel, thickening as the hold fills.
      const k = p.action ? p.action.t / p.action.dur : 0;
      for (let i = 0; i < 2; i++) {
        const t = Math.random();
        ctx.fx.puff(from.x + (to.x - from.x) * t + (Math.random() - 0.5) * 0.15, from.y + (to.y - from.y) * t + (Math.random() - 0.5) * 0.15, from.z + (to.z - from.z) * t + (Math.random() - 0.5) * 0.15, rgb[0], rgb[1], rgb[2], 0.12 + 0.25 * k, 0.5);
      }
      ctx.work.ghost(`g${p.index}`, panelGhost(v, hit.anchor), 'aimed');
      return true;
    },
  };
}

/**
 * Every tick: outlines where a carried part goes (white from afar, green and filled when you are in reach, red when
 * the place is right but the job is not), a tag on the spot, and tags over loose parts and fitted ones you inspect.
 */
export function guide(p: Player) {
  const ctx = p.ctx;
  if (p.state !== 'foot') return;
  if (p.carry?.kind === 'part') {
    const item = p.carry.item;
    const hit = nearestSocket(p, partDef(item.id).slot);
    if (!hit) return;
    const { v, sock, anchor } = hit;
    const inReach = hit.dist <= FIT_REACH;
    const moving = Math.abs(v.speed) > 2;
    // From afar every place it could go shows; up close only the one you would fit it to (one wheel of four).
    const focus = inReach && PER_WHEEL.includes(sock.slot) ? hit.index : undefined;
    ctx.work.ghost(`g${p.index}`, ghostAnchors(v, sock, focus), !inReach ? 'idle' : moving ? 'blocked' : 'aimed');
    // The part itself snaps onto the mount as a see-through copy, so you see where it will sit before you bolt it.
    if (inReach && !ctx.work.holding(p.index)) ctx.work.preview(p.index, item, handPos(p), [anchorWorld(v, anchor)], moving ? 'blocked' : 'aimed');
    if (inReach && !ctx.work.holding(p.index)) {
      const cur = fittedAt(hit);
      const lines = [{ text: sock.label, css: '#cfc8b4' }, { text: cur ? `Now: ${partDef(cur.id).name} ${Math.round(cur.cond * 100)}%` : 'Empty mount', css: '#e6dcc0' }, { text: moving ? 'Wait for it to stop' : `Attach ${partDef(item.id).name}`, css: moving ? '#ff8a6a' : '#8cf08c' }];
      ctx.work.tag(`t${p.index}`, lines, anchorWorld(v, anchor).add(new THREE.Vector3(0, 0.9, 0)));
    }
    return;
  }
  if (p.carry?.kind === 'paint') {
    const v = ownRideNear(p);
    const hit = v ? aimedPanel(p, v) : null;
    if (v && hit && !p.action) ctx.work.ghost(`g${p.index}`, panelGhost(v, hit.anchor), 'aimed');
    return;
  }
  if (p.carry) return;
  // Looking at something on the ground.
  const near = ctx.loose?.nearest(p.pos.x, p.pos.z, LIFT_REACH + 2.4);
  if (near) {
    ctx.work.tag(`i${p.index}`, inspectLines(near.carried), new THREE.Vector3(near.x, near.y + 1.15, near.z));
    return;
  }
  // The wrench or crowbar in hand next to your own car: look at what is bolted to it.
  if (p.equip === 'wrench' || p.equip === 'crowbar') {
    const v = ownRideNear(p);
    if (!v?.build) return;
    const hit = aimedSocket(p, v, FIT_REACH);
    if (!hit) return;
    const cur = fittedAt(hit);
    ctx.work.ghost(`g${p.index}`, ghostAnchors(v, hit.sock, PER_WHEEL.includes(hit.sock.slot) ? hit.index : undefined), 'aimed');
    const lines = cur ? [{ text: hit.sock.label, css: '#cfc8b4' }, ...partInspect({ uid: '', id: cur.id, cond: cur.cond })] : [{ text: hit.sock.label, css: '#cfc8b4' }, { text: 'Empty mount', css: '#ff8a6a' }];
    ctx.work.tag(`t${p.index}`, lines, anchorWorld(v, hit.anchor).add(new THREE.Vector3(0, 0.9, 0)));
  }
}

/** The hold-A candidate: lift what is at your feet, or fit what is in your hands to the car beside you. */
export function haulCandidate(p: Player): Cand | null {
  const ctx = p.ctx;
  if (!p.carry) {
    const lifting = p.action?.kind === 'lift' ? String(p.action.target) : undefined;
    const near = ctx.loose?.nearest(p.pos.x, p.pos.z, LIFT_REACH, lifting);
    const goods = ctx.loose?.nearestGoods(p.pos.x, p.pos.z, LIFT_REACH, lifting);
    // Whichever lies closer; the one already being lifted keeps the hold.
    const dist = (o: { id: string; x: number; z: number }) => Math.hypot(o.x - p.pos.x, o.z - p.pos.z) - (o.id === lifting ? 0.3 : 0);
    if (goods && (!near || dist(goods) < dist(near))) {
      return {
        kind: 'lift',
        prompt: `Pick up ${goods.label}`,
        dur: 0.55,
        target: goods.id,
        ok: true,
        label: 'lift',
        noise: 6,
        run: () => {
          if (!ctx.loose?.takeGoods(goods.id, p)) p.note('Someone got there first', 'info');
        },
      };
    }
    if (!near) return deckCandidate(p);
    const label = carriedName(near.carried);
    return {
      kind: 'lift',
      prompt: `Pick up ${label}`,
      dur: liftSecs(near.carried),
      target: near.id,
      ok: true,
      label: 'lift',
      noise: 6,
      run: () => {
        const c = ctx.loose?.take(near.id);
        if (!c) return p.note('Someone got there first', 'info');
        p.carry = c;
        ctx.audio.play('pickup', near.x, near.z, 0.8);
        p.note(`Carrying ${carriedName(c)}: walk it to your car`, 'good');
      },
    };
  }
  const c = p.carry;
  if (c.kind === 'paint') return sprayCandidate(p, c);
  let v = ownRideNear(p);
  let hit: SocketHit | null = null;
  if (c.kind === 'part') {
    // Parts go where they belong: stand at the socket, not just somewhere near the car.
    hit = nearestSocket(p, partDef(c.item.id).slot);
    if (hit) v = hit.v;
    if (hit && hit.dist > FIT_REACH) {
      return {
        kind: 'fit',
        prompt: `Walk to the ${hit.sock.label.toLowerCase()} to fit ${partName(c.item)}`,
        dur: 1,
        target: hit.v,
        ok: false,
        label: 'fit',
        run: () => {},
      };
    }
  }
  if (!v) return null;
  const plan = planFit(c, {
    def: v.def,
    fitted: (slot) => {
      const id = v.build ? idInSlot(v.build, slot as PartSlot) : null;
      return id ? { id } : undefined;
    },
    current: hit ? fittedAt(hit) ?? null : undefined,
    fuel: v.fuel,
    tankMax: v.tankMax,
    oil: v.health.comp.oil,
    tank: v.fuelType,
    engine: v.stats.fuel,
    coolant: v.health.comp.coolant ?? 1,
    coolantL: v.stats.coolantL,
    sumpL: v.stats.sumpL,
  });
  const moving = Math.abs(v.speed) > 2;
  // A part goes on at its own mount: carry it there, and the mount rings. Hold it over the spot to bolt it on.
  const slot = c.kind === 'part' ? partDef(c.item.id).slot : null;
  const pick = slot && !hit ? pickMount(p, v, slot) : null;
  const away = hit ? false : (!!pick && !pick.near);
  const where = slot ? PARTS.labels[slot].toLowerCase() : '';
  if (pick && c.kind === 'part') {
    const mk = Math.min(3, Math.max(1, partDef(c.item.id).mk));
    ctx.work.focus(p.index, pick.all.map((m) => m.pos), { pos: pick.mount.pos, text: away ? `Bring ${partName(c.item)} to the ${where}` : plan.label, css: MK_CSS[mk], ok: plan.ok && !moving && !away });
  }
  return {
    kind: 'fit',
    prompt: moving ? `${v.def.name} is moving` : away ? `Carry it to the ${where} (the ringed spot)` : plan.label,
    dur: plan.secs,
    target: v,
    ok: plan.ok && !moving && !away,
    label: 'fit',
    noise: c.kind === 'part' ? 22 : 14,
    run: () => fit(p, v, c, hit),
    tick: () => {
      if (c.kind === 'part') ctx.work.hold(p.index, c.item, handPos(p), hit ? anchorWorld(v, hit.anchor) : (pick?.mount.pos ?? sitePos(v, slotSite(c.item.id))), p.action ? p.action.t / p.action.dur : 0);
      if (c.kind === 'part' && Math.random() < 0.18) ctx.fx.spark(v.position.x + (Math.random() - 0.5), v.position.y + 0.8, v.position.z + (Math.random() - 0.5), 2, 3);
      return true;
    },
  };
}

/**
 * Crowbar at your own vehicle: pry the part you are facing off its mount and carry it away. A door, the bonnet, a tyre,
 * the engine, the gearbox: anything bolted on comes off, and the mount shows bare until something else goes on.
 */
export function pryCandidate(p: Player): Cand | null {
  const ctx = p.ctx;
  const v = ownRideNear(p);
  if (!v?.build) return null;
  const hit = aimedSocket(p, v, FIT_REACH, true) ?? aimedSocket(p, v, FIT_REACH);
  if (!hit) return null;
  const cur = fittedAt(hit);
  const label = hit.sock.label;
  const moving = Math.abs(v.speed) > 2;
  if (!cur) return { kind: 'pry', prompt: `${label}: nothing to pry off`, dur: 1, target: `${v.id}:${label}`, ok: false, label: 'pry', run: () => {} };
  const name = partDef(cur.id).name;
  const wheel = hit.sock.slot === 'wheels';
  return {
    kind: 'pry',
    prompt: moving ? `${v.def.name} is moving` : `Pry off the ${name.toLowerCase()} (${label.toLowerCase()})`,
    dur: wheel ? 2.2 : hit.sock.slot === 'engine' ? 4.5 : hit.sock.slot === 'gearbox' ? 3.6 : 2.4,
    target: `${v.id}:${hit.sock.slot}:${hit.index}`,
    ok: !moving,
    label: 'pry',
    noise: 20,
    run: () => {
      const b = v.build;
      if (!b) return;
      // Write the live wear into the build first, so the part comes off carrying the condition it really had.
      v.commit();
      const out = hit.sock.slot === 'wheels' ? removeTyre(b, hit.index) : removePart(b, hit.sock.slot);
      if (!out) return p.note('It will not come off', 'warn');
      v.syncFromBuild();
      const at = anchorWorld(v, hit.anchor);
      ctx.audio.play('wrench', v.position.x, v.position.z, 0.8);
      ctx.work.burst(at, 2, 0.8);
      ctx.work.label(`${label.toUpperCase()}  OFF`, '#ffb454', at.add(new THREE.Vector3(0, 0.8, 0)));
      if (p.carry) {
        // Hands are full: the part drops at your feet.
        ctx.loose?.drop(p.pos.x + Math.sin(p.aimYaw) * 0.8, p.pos.z + Math.cos(p.aimYaw) * 0.8, { kind: 'part', item: out });
        p.note(`${partName(out)} is off; it is on the ground`, 'info');
      } else {
        p.carry = { kind: 'part', item: out };
        p.note(`${partName(out)} is off: carry it away, or X to stow it`, 'good');
      }
    },
    tick: () => {
      if (Math.random() < 0.2) ctx.fx.spark(v.position.x + (Math.random() - 0.5), v.position.y + 0.8, v.position.z + (Math.random() - 0.5), 2, 3);
      ctx.work.ghost(`g${p.index}`, ghostAnchors(v, hit.sock, PER_WHEEL.includes(hit.sock.slot) ? hit.index : undefined), 'aimed');
      return true;
    },
  };
}

/** Put what is in your hands onto the vehicle. */
function fit(p: Player, v: Vehicle, c: Carried, hit: SocketHit | null) {
  const camp = p.ctx.campaign;
  const ctx = p.ctx;
  if (p.carry !== c) return;
  switch (c.kind) {
    case 'part': {
      const b = v.build!;
      // Write the live wear into the build first, so what comes off carries the condition it really had.
      v.commit();
      const res = installPart(b, c.item, hit ? mountOf(hit) : undefined);
      if (!res.ok) return p.note(res.reason ?? 'It does not fit', 'warn');
      v.syncFromBuild();
      p.carry = null;
      ctx.audio.play('wrench', v.position.x, v.position.z, 0.8);
      const name = partName(c.item);
      const pick = pickMount(p, v, partDef(c.item.id).slot);
      // Where it lands is where the preview was showing: the socket you fitted it to.
      const anchor = hit ? anchorWorld(v, hit.anchor) : (pick?.mount.pos.clone() ?? sitePos(v, slotSite(c.item.id)));
      const mk = Math.min(3, Math.max(1, partDef(c.item.id).mk));
      // A set of tyres goes on at every wheel.
      if (!hit && pick && pick.mount.slot === 'wheels') for (const m of pick.all) if (m.slot === 'wheels' && m !== pick.mount) ctx.work.burst(m.pos, mk, 0.7);
      ctx.work.swap({
        key: p.index,
        anchor,
        from: handPos(p),
        out: trunkPos(v),
        fresh: c.item,
        old: res.removed,
        hit: () => {
          ctx.work.label(`${partDef(c.item.id).slot.toUpperCase()}  ${name}`, MK_CSS[mk], anchor.clone().add(new THREE.Vector3(0, 0.8, 0)));
          ctx.audio.play('wrench', v.position.x, v.position.z, 0.6);
        },
      });
      if (res.note) p.note(res.note, 'warn');
      if (!res.removed) {
        p.note(`${name} fitted`, 'good');
      } else if (camp.stowPart(res.removed)) {
        p.note(`${name} fitted; ${partName(res.removed)} stowed in the trunk`, 'good');
      } else {
        p.carry = { kind: 'part', item: res.removed };
        p.note(`${name} fitted; trunk is full, so you are holding the old ${partName(res.removed)}`, 'warn');
      }
      break;
    }
    case 'fuel': {
      // A dry tank takes the can's fuel whatever it held; one with fuel in it only takes the same kind.
      const kind = c.fuel ?? 'petrol';
      const plan = planPour(v.fuelType, v.fuel, kind);
      if (!plan.ok) return p.note(plan.note, 'warn');
      if (plan.tank !== v.fuelType) {
        v.fuelType = plan.tank;
        v.fuel = 0;
      }
      const r = pourFuel(v.fuel, v.tankMax, c.amount);
      v.fuel = r.fuel;
      ctx.work.pour(handPos(p), sitePos(v, 'rear'), [0.85, 0.7, 0.2]);
      ctx.work.label(`+${r.used.toFixed(1)} FU`, '#ffd27a', sitePos(v, 'rear').add(new THREE.Vector3(0, 0.8, 0)));
      p.carry = r.left > 0.05 ? { kind: 'fuel', amount: r.left, fuel: kind } : null;
      p.note(`+${r.used.toFixed(1)} FU of ${kind} in the tank${p.carry ? ', some left in the can' : ''}`, 'good');
      if (v.fuelType !== v.stats.fuel) p.note(`The engine runs ${v.stats.fuel}: drain the tank with the jerrycan`, 'warn');
      ctx.audio.play('pickup', v.position.x, v.position.z, 0.5);
      break;
    }
    case 'water': {
      const r = pourWater(v.health.comp.coolant ?? 1, c.amount, v.stats.coolantL);
      v.health.comp.coolant = r.coolant;
      v.commit();
      ctx.work.pour(handPos(p), sitePos(v, 'hood'), [0.4, 0.65, 0.9]);
      ctx.work.label(`WATER ${Math.round(r.coolant * 100)}%`, '#8ecbff', sitePos(v, 'hood').add(new THREE.Vector3(0, 0.8, 0)));
      p.carry = r.left > 0.2 ? { kind: 'water', amount: r.left } : null;
      p.note(`The radiator is at ${Math.round(r.coolant * 100)}% (${r.used.toFixed(1)} L in)`, 'good');
      ctx.audio.play('pickup', v.position.x, v.position.z, 0.5);
      break;
    }
    case 'oil': {
      const r = pourOil(v.health.comp.oil, c.amount, v.stats.sumpL);
      v.health.comp.oil = r.oil;
      v.commit();
      ctx.work.pour(handPos(p), sitePos(v, 'hood'), [0.12, 0.1, 0.08]);
      ctx.work.label(`OIL ${Math.round(r.oil * 100)}%`, '#e6dcc0', sitePos(v, 'hood').add(new THREE.Vector3(0, 0.8, 0)));
      p.carry = r.left > 0.02 ? { kind: 'oil', amount: r.left } : null;
      p.note(`Oil topped up to ${Math.round(r.oil * 100)}%`, 'good');
      ctx.audio.play('pickup', v.position.x, v.position.z, 0.5);
      break;
    }
  }
}

/** Stow what is in your hands in the trucks. Returns true if the hands are now empty. */
export function stowCarry(p: Player, quiet = false): boolean {
  const c = p.carry;
  if (!c) return true;
  const camp = p.ctx.campaign;
  const plan = planStow(c, { parts: camp.inventoryRoom, oil: OIL_RESERVE_MAX - camp.items.oil, water: WATER_RESERVE_MAX - camp.items.water });
  if (!plan.ok) {
    if (!quiet) p.note(plan.label, 'warn');
    return false;
  }
  const near = ownRideNear(p);
  if (near && !quiet) {
    // It flies to the spot on the car's deck it will sit in, and appears there as it lands.
    const spot = near.nextDeckSpot(c.kind === 'part' ? { part: { uid: c.item.uid, id: c.item.id } } : c.kind === 'fuel' ? { fuel: near.load.fuel + 1 } : { oil: near.load.oil + 1 }) ?? trunkPos(near);
    p.ctx.work.stow(c.kind === 'part' ? modelKey(c.item) : carryModelKey(c), handPos(p), spot, () => near.refreshLoadNow());
  }
  switch (c.kind) {
    case 'part':
      if (near?.build) c.item.on = near.build.uid;
      camp.stowPart(c.item);
      p.carry = null;
      if (!quiet) p.note(`${partName(c.item)} stowed in the trunk`, 'good');
      break;
    case 'fuel':
      camp.stowFuel(c.amount, c.fuel ?? 'petrol');
      p.carry = null;
      if (!quiet) p.note(`+${c.amount.toFixed(1)} FU of ${c.fuel ?? 'petrol'} in the reserve cans`, 'good');
      break;
    case 'water': {
      const took = camp.stowWater(c.amount);
      p.carry = c.amount - took > 0.2 ? { kind: 'water', amount: c.amount - took } : null;
      if (!quiet) p.note(p.carry ? 'The water reserve is full: some is left in the can' : `+${took.toFixed(0)} L of water in the reserve`, p.carry ? 'warn' : 'good');
      break;
    }
    case 'oil': {
      const took = camp.stowOil(c.amount);
      p.carry = c.amount - took > 0.02 ? { kind: 'oil', amount: c.amount - took } : null;
      if (!quiet) p.note(p.carry ? 'Reserve is full: some oil is left in the can' : 'Oil stowed', p.carry ? 'warn' : 'good');
      break;
    }
  }
  p.ctx.audio.play('pickup', p.pos.x, p.pos.z, 0.5);
  return !p.carry;
}

/** Set what is in your hands down in front of you. With nowhere to put it, it goes to the trucks instead. */
export function dropCarry(p: Player) {
  const c = p.carry;
  if (!c) return;
  if (!p.ctx.loose) return void returnCarry(p);
  p.carry = null;
  const x = p.pos.x + Math.sin(p.yaw) * 0.9;
  const z = p.pos.z + Math.cos(p.yaw) * 0.9;
  p.ctx.loose.drop(x, z, c);
  p.note(`Put down ${carriedName(c)}`, 'info');
}

/** Hand it back to the convoy whatever the room: used when the scene ends. A full trunk scraps parts. */
export function returnCarry(p: Player) {
  const c = p.carry;
  if (!c) return;
  const camp = p.ctx.campaign;
  p.carry = null;
  if (c.kind === 'part') camp.addPart(c.item);
  else if (c.kind === 'fuel') camp.stowFuel(c.amount, c.fuel ?? 'petrol');
  else if (c.kind === 'oil') {
    if (camp.stowOil(c.amount) < c.amount - 0.02) camp.stocks.scrap += 1;
  } else if (c.kind === 'water') camp.stowWater(c.amount);
  // A spray can has no place in the trucks: it is simply left behind.
}

/** Climbing in with full hands: it goes in the trunk if it fits, otherwise it is set down beside the car. */
export function stashBeforeEntering(p: Player) {
  if (!p.carry) return;
  // Only your own convoy's trunk takes it; a found car has no trunk of yours to teleport things into.
  if (!ownRideNear(p) || !stowCarry(p, true)) dropCarry(p);
  else p.note('Stowed in the trunk', 'info');
}

/** X while carrying: stow it at your car, or set it down anywhere else. */
export function haulKey(p: Player) {
  if (!p.carry) return;
  if (p.carry.kind !== 'paint' && ownRideNear(p)) stowCarry(p);
  else dropCarry(p);
}

/** The prompt for a player whose hands are full: A does the fit (already in `p.prompt`), X stows or sets it down. */
export function haulPrompt(p: Player) {
  const c = p.carry;
  if (!c) return;
  const camp = p.ctx.campaign;
  const near = ownRideNear(p);
  const x = near
    ? planStow(c, { parts: camp.inventoryRoom, oil: OIL_RESERVE_MAX - camp.items.oil, water: WATER_RESERVE_MAX - camp.items.water })
    : { ok: true, label: `Put down ${carriedName(c)}  ·  walk it to your car to fit or stow it` };
  // Another prompt (a fit in progress, "enter the car") keeps the main slot; X rides underneath it.
  if (p.prompt) p.promptAlt = { text: x.label, button: 'X', ok: x.ok };
  else p.prompt = { text: x.label, progress: -1, button: 'X' };
}
