import * as THREE from 'three';
import { partDef, type PartSlot } from '../data';
import { MK_CSS, SLOT_SITE, modelKey, type GhostAnchor, type Site } from '../render/workFx';
import { panelAnchor, socketDistance, socketFor, type Anchor, type Socket } from '../render/sockets';
import { PANEL_NAME, colorName, panelColor, paintPanel, panelsOf, type PanelId } from '../sim/paint';
import { OIL_RESERVE_MAX } from './campaign';
import { carriedName, carryModelKey, inspectLines, liftSecs, partInspect, planFit, planStow, pourFuel, type Carried } from '../sim/carry';
import { currentCond, idInSlot, installPart } from '../sim/garage';
import { planPour } from '../sim/fuel';
import { pourOil } from '../sim/oil';
import { partName } from '../sim/parts';
import type { Cand, Player } from './player';
import type { Vehicle } from './vehicle';

/**
 * Carrying things by hand. Lift a part, a fuel can or an oil can off the ground, walk it to one of your own vehicles,
 * and either put it straight on (A: bolt it on, pour it in, top the sump up) or stow it in the trucks (X) for later.
 * X anywhere else sets it down.
 */

/** Vehicles that count as "our ride": the convoy's own cars with a build, standing still. */
const isOwnRide = (v: Vehicle) => v.faction === 'convoy' && !!v.build && !v.wreck && v.kind !== 'crew';

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

function ghostAnchors(v: Vehicle, sock: Socket): GhostAnchor[] {
  const r = v.body.body.rotation();
  return sock.anchors.map((a) => ({ pos: anchorWorld(v, a), quat: new THREE.Quaternion(r.x, r.y, r.z, r.w), size: [a.sx + 0.04, a.sy + 0.04, a.sz + 0.04] as [number, number, number] }));
}

export interface SocketHit {
  v: Vehicle;
  sock: Socket;
  anchor: Anchor;
  /** Metres from the player's hands to the closest anchor. */
  dist: number;
}

/** The socket for a slot that is closest to the player, across the convoy's own vehicles. */
export function nearestSocket(p: Player, slot: PartSlot, within = SHOW_REACH): SocketHit | null {
  let best: SocketHit | null = null;
  for (const v of p.ctx.vehicles) {
    if (!isOwnRide(v)) continue;
    const sock = socketFor(v.def, slot);
    if (!sock) continue;
    const [lx, ly, lz] = toLocal(v, p.pos.x, p.pos.y + 1.0, p.pos.z);
    const { dist, anchor } = socketDistance(sock, lx, ly, lz);
    if (dist <= within && (!best || dist < best.dist)) best = { v, sock, anchor, dist };
  }
  return best;
}

/** Of one vehicle's sockets, the one the player is facing and standing nearest to. */
function aimedSocket(p: Player, v: Vehicle, within: number): SocketHit | null {
  const [lx, ly, lz] = toLocal(v, p.pos.x, p.pos.y + 1.0, p.pos.z);
  const fx = Math.sin(p.aimYaw);
  const fz = Math.cos(p.aimYaw);
  let best: SocketHit | null = null;
  let bs = Infinity;
  for (const slot of v.def.slots ?? []) {
    const sock = socketFor(v.def, slot);
    if (!sock) continue;
    const { dist, anchor } = socketDistance(sock, lx, ly, lz);
    if (dist > within) continue;
    const w = anchorWorld(v, anchor);
    const dx = w.x - p.pos.x;
    const dz = w.z - p.pos.z;
    const l = Math.hypot(dx, dz) || 1;
    const score = dist - 1.4 * Math.max(0, (dx * fx + dz * fz) / l);
    if (score < bs) {
      bs = score;
      best = { v, sock, anchor, dist };
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
    const slot = partDef(item.id).slot;
    const hit = nearestSocket(p, slot);
    if (!hit) return;
    const { v, sock, anchor } = hit;
    const inReach = hit.dist <= FIT_REACH;
    const moving = Math.abs(v.speed) > 2;
    ctx.work.ghost(`g${p.index}`, ghostAnchors(v, sock), !inReach ? 'idle' : moving ? 'blocked' : 'aimed');
    if (inReach && !ctx.work.holding(p.index)) {
      const cur = v.build ? idInSlot(v.build, slot) : null;
      const lines = [{ text: sock.label, css: '#cfc8b4' }, { text: cur ? `Now: ${partDef(cur).name}${v.build && cur ? ` ${Math.round(currentCond(v.build, slot) * 100)}%` : ''}` : 'Empty mount', css: '#e6dcc0' }, { text: moving ? 'Wait for it to stop' : `Attach ${partDef(item.id).name}`, css: moving ? '#ff8a6a' : '#8cf08c' }];
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
  // The wrench in hand next to your own car: look at what is bolted to it.
  if (p.equip === 'wrench') {
    const v = ownRideNear(p);
    if (!v?.build) return;
    const hit = aimedSocket(p, v, FIT_REACH);
    if (!hit) return;
    const b = v.build;
    const id = idInSlot(b, hit.sock.slot);
    ctx.work.ghost(`g${p.index}`, ghostAnchors(v, hit.sock), 'aimed');
    const lines = id ? [{ text: hit.sock.label, css: '#cfc8b4' }, ...partInspect({ uid: '', id, cond: currentCond(b, hit.sock.slot) })] : [{ text: hit.sock.label, css: '#cfc8b4' }, { text: 'Empty mount', css: '#ff8a6a' }];
    ctx.work.tag(`t${p.index}`, lines, anchorWorld(v, hit.anchor).add(new THREE.Vector3(0, 0.9, 0)));
  }
}

/** The hold-A candidate: lift what is at your feet, or fit what is in your hands to the car beside you. */
export function haulCandidate(p: Player): Cand | null {
  const ctx = p.ctx;
  if (!p.carry) {
    const lifting = p.action?.kind === 'lift' ? String(p.action.target) : undefined;
    const near = ctx.loose?.nearest(p.pos.x, p.pos.z, LIFT_REACH, lifting);
    if (!near) return null;
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
    fuel: v.fuel,
    tankMax: v.tankMax,
    oil: v.health.comp.oil,
    tank: v.fuelType,
    engine: v.stats.fuel,
  });
  const moving = Math.abs(v.speed) > 2;
  return {
    kind: 'fit',
    prompt: moving ? `${v.def.name} is moving` : plan.label,
    dur: plan.secs,
    target: v,
    ok: plan.ok && !moving,
    label: 'fit',
    noise: c.kind === 'part' ? 22 : 14,
    run: () => fit(p, v, c),
    tick: () => {
      if (c.kind === 'part') ctx.work.hold(p.index, c.item, handPos(p), hit ? anchorWorld(v, hit.anchor) : sitePos(v, slotSite(c.item.id)), p.action ? p.action.t / p.action.dur : 0);
      if (c.kind === 'part' && Math.random() < 0.18) ctx.fx.spark(v.position.x + (Math.random() - 0.5), v.position.y + 0.8, v.position.z + (Math.random() - 0.5), 2, 3);
      return true;
    },
  };
}

/** Put what is in your hands onto the vehicle. */
function fit(p: Player, v: Vehicle, c: Carried) {
  const camp = p.ctx.campaign;
  const ctx = p.ctx;
  if (p.carry !== c) return;
  switch (c.kind) {
    case 'part': {
      const b = v.build!;
      // Write the live wear into the build first, so what comes off carries the condition it really had.
      v.commit();
      const res = installPart(b, c.item);
      if (!res.ok) return p.note(res.reason ?? 'It does not fit', 'warn');
      v.syncFromBuild();
      p.carry = null;
      ctx.audio.play('wrench', v.position.x, v.position.z, 0.8);
      const name = partName(c.item);
      const sock = socketFor(v.def, partDef(c.item.id).slot);
      const anchor = sock ? anchorWorld(v, socketDistance(sock, ...toLocal(v, p.pos.x, p.pos.y + 1.0, p.pos.z)).anchor) : sitePos(v, slotSite(c.item.id));
      const mk = Math.min(3, Math.max(1, partDef(c.item.id).mk));
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
    case 'oil': {
      const r = pourOil(v.health.comp.oil, c.amount);
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
  const plan = planStow(c, { parts: camp.inventoryRoom, oil: OIL_RESERVE_MAX - camp.items.oil });
  if (!plan.ok) {
    if (!quiet) p.note(plan.label, 'warn');
    return false;
  }
  const near = ownRideNear(p);
  if (near && !quiet) p.ctx.work.stow(c.kind === 'part' ? modelKey(c.item) : carryModelKey(c), handPos(p), trunkPos(near));
  switch (c.kind) {
    case 'part':
      camp.stowPart(c.item);
      p.carry = null;
      if (!quiet) p.note(`${partName(c.item)} stowed in the trunk`, 'good');
      break;
    case 'fuel':
      camp.stowFuel(c.amount, c.fuel ?? 'petrol');
      p.carry = null;
      if (!quiet) p.note(`+${c.amount.toFixed(1)} FU of ${c.fuel ?? 'petrol'} in the reserve cans`, 'good');
      break;
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
  }
  // A spray can has no place in the trucks: it is simply left behind.
}

/** Climbing in with full hands: it goes in the trunk if it fits, otherwise it is set down beside the car. */
export function stashBeforeEntering(p: Player) {
  if (!p.carry) return;
  if (!stowCarry(p, true)) dropCarry(p);
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
    ? planStow(c, { parts: camp.inventoryRoom, oil: OIL_RESERVE_MAX - camp.items.oil })
    : { ok: true, label: `Put down ${carriedName(c)}  ·  walk it to your car to fit or stow it` };
  // Another prompt (a fit in progress, "enter the car") keeps the main slot; X rides underneath it.
  if (p.prompt) p.promptAlt = { text: x.label, button: 'X', ok: x.ok };
  else p.prompt = { text: x.label, progress: -1, button: 'X' };
}
