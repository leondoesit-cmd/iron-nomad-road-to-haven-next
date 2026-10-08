import * as THREE from 'three';
import { mountsFor, partDef, t, type PartSlot } from '../data';
import { loadSpots, planLoad, surfacesOf, type CargoEntry, type LoadPlan, type Zone } from '../sim/cargo';
import { MK_CSS, SLOT_SITE, modelKey, type Site } from '../render/workFx';
import { panelAnchor, socketDistance, socketFor, type Anchor, type Socket } from '../render/sockets';
import { accessPointsOf } from '../render/accessPoints';
import { bootDeck, bootSpot } from '../render/bootDeck';
import { PANEL_NAME, colorName, panelColor, paintPanel, panelsOf, type PanelId } from '../sim/paint';
import { OIL_RESERVE_MAX } from './campaign';
import { FOODS, carriedName, carryModelKey, inspectLines, liftSecs, partInspect, planFit, planStow, pourFuel, type Carried, type FitPlan, type FitTarget } from '../sim/carry';
import { idInSlot, installPart, removePart, removeTyre } from '../sim/garage';
import { planPour } from '../sim/fuel';
import { pourOil } from '../sim/oil';
import { WATER_RESERVE_MAX, pourWater } from '../sim/fluids';
import { needText, spotName, workFor, type Panel, type Spot } from '../sim/access';
import { partName } from '../sim/parts';
import { lizardCandidate, lookedAt } from './grab';
import { PER_WHEEL, anchorWorld, carryTarget, fittedAt, ghostAnchors, isOwnRide, isWorkable, panelCand, placeFor, pointPos, reached, toLocal, toolHit, type Place, type Reach, type SocketHit } from './access';
import type { Cand, Player } from './player';
import type { Vehicle } from './vehicle';

export { fittedAt, type SocketHit };

/**
 * Carrying things by hand. Lift a part, a fuel can or an oil can off the ground, walk it to one of your own vehicles, and
 * take it to the right place on it: the engine goes in at the engine bay (bonnet open), fuel at the flap, a crate in the boot
 * (lid open). A bolts it on or pours it; X stows it where a boot or an open door lets you, or sets it down. The rules for
 * where and in what order are `sim/access.ts`; where you stand against a vehicle is `game/access.ts`.
 */

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
    case 'cabin': return at(0, 0.8, 0.1);
  }
}

const slotSite = (id: string): Site => SLOT_SITE[partDef(id).slot] ?? 'hood';
const handPos = (p: Player) => p.human.hand.getWorldPosition(new THREE.Vector3());
const trunkPos = (v: Vehicle) => sitePos(v, 'rear');

/** How close a loose item must be to lift it. */
export const LIFT_REACH = 1.9;

/** The car at hand to work on: one of ours, or an abandoned one (which working on makes ours). */
function ownRideNear(p: Player): Vehicle | null {
  return p.nearestVehicle(3.8, isWorkable);
}

/** Putting something in or on an abandoned car takes it for the convoy, as driving it would. */
function claimFor(p: Player, v: Vehicle) {
  if (v.faction === 'neutral') p.ctx.cars.claim(v, p);
}

// ---------------------------------------------------------------- sockets

/** How far away the outline of the place a carried part goes shows. */
export const SHOW_REACH = 11;

/**
 * The mount a hit means for `installPart`: the wheel number for a tyre, otherwise the slot. Springs and brakes are
 * fitted to the whole vehicle, so they name the slot.
 */
export function mountOf(hit: SocketHit): PartSlot | number {
  return hit.sock.slot === 'wheels' ? hit.index : hit.sock.slot;
}

/** The sockets a part of this category can go in on a chassis: a door fits either side, a tyre any wheel. */
function socketsFor(v: Vehicle, category: PartSlot): Socket[] {
  return mountsFor(category)
    .filter((m) => (v.def.slots ?? []).includes(m))
    .map((m) => socketFor(v.def, m))
    .filter((s): s is Socket => !!s);
}

/** The socket for a part's category that is closest to the player, across the convoy's own vehicles: its outline, from afar. */
export function nearestSocket(p: Player, category: PartSlot, within = SHOW_REACH): SocketHit | null {
  let best: SocketHit | null = null;
  for (const v of p.ctx.vehicles) {
    if (!isWorkable(v)) continue;
    const [lx, ly, lz] = toLocal(v, p.pos.x, p.pos.y + 1.0, p.pos.z);
    for (const sock of socketsFor(v, category)) {
      const { dist, anchor, index } = socketDistance(sock, lx, ly, lz);
      if (dist <= within && (!best || dist < best.dist)) best = { v, sock, anchor, index, dist };
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

function panelGhost(v: Vehicle, a: Anchor) {
  const r = v.body.body.rotation();
  return [{ pos: anchorWorld(v, a), quat: new THREE.Quaternion(r.x, r.y, r.z, r.w), size: [a.sx + 0.05, a.sy + 0.05, a.sz + 0.05] as [number, number, number] }];
}

type Can = Extract<Carried, { kind: 'paint' }>;

/** Hold A with a spray can: paint the panel you are facing. A bonnet or door has to be on the car; it need not be shut. */
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
  // A panel that is not there (a stripped bonnet, a door torn off) has nothing to spray.
  const swing = hit.panel === 'hood' || hit.panel === 'doorL' || hit.panel === 'doorR' ? hit.panel : null;
  const missing = !!swing && v.def.slots?.includes(swing) === true && !v.hasPanel(swing);
  const rgb: [number, number, number] = [((c.color >> 16) & 255) / 255, ((c.color >> 8) & 255) / 255, (c.color & 255) / 255];
  return {
    kind: 'spray',
    prompt: moving ? `${v.def.name} is moving` : missing ? `There is no ${name} to spray` : already ? `The ${name} is already ${colorName(c.color)}` : `Spray the ${name} ${colorName(c.color)} (${c.charges} left)`,
    dur: 2,
    target: `${v.id}:${hit.panel}`,
    ok: !already && !moving && !missing,
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

// ---------------------------------------------------------------- what carrying means at a vehicle

/** The game's view of fitting what you carry to this vehicle: the plan, where it is done, and where you stand against it. */
interface CarryInfo {
  v: Vehicle;
  plan: FitPlan;
  /** The mount a part goes in, when you are at it. */
  hit: SocketHit | null;
  /** Where the job happens, in the world (the point you stand at, or the nearest one when you are not at any). */
  at: THREE.Vector3 | null;
  /** The place you stand at for the job. */
  place: Place | null;
  /** Points to light up. */
  spots: Spot[];
}

/** What a fit needs to know of a vehicle. */
function fitTarget(v: Vehicle, hit: SocketHit | null): FitTarget {
  return {
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
  };
}

/** What holding A with this in hand does at this vehicle, and what stands in the way. */
function carryInfo(p: Player, v: Vehicle, c: Carried): CarryInfo {
  const open = v.panelOpen();
  if (c.kind === 'part') {
    const slot = partDef(c.item.id).slot;
    const tgt = carryTarget(p, v, slot);
    if (!tgt.hit) {
      if (!tgt.spots.length) return { v, plan: planFit(c, fitTarget(v, null)), hit: null, at: null, place: null, spots: [] };
      return {
        v,
        plan: { ok: false, label: needText(v.def, { kind: 'go', spots: tgt.spots }, `fit ${partName(c.item)}`), secs: 1, need: { kind: 'go', spots: tgt.spots } },
        hit: null,
        at: nearestOf(p, v, tgt.spots),
        place: null,
        spots: tgt.spots,
      };
    }
    const plan = planFit(c, { ...fitTarget(v, tgt.hit), access: { at: tgt.reach.pt.spot, open, mount: tgt.mount } });
    return { v, plan, hit: tgt.hit, at: tgt.reach.pos, place: { v, job: tgt.mount, at: tgt.reach, open, gate: tgt.gate }, spots: workFor(v.def, tgt.mount)?.at ?? [] };
  }
  const job = c.kind === 'fuel' ? 'fuel' : c.kind === 'oil' ? 'oil' : 'water';
  const place = placeFor(p, v, job);
  const plan = planFit(c, { ...fitTarget(v, null), access: { at: place.at?.pt.spot ?? null, open } });
  const spots = workFor(v.def, job)?.at ?? [];
  return { v, plan, hit: null, at: place.at?.pos ?? nearestOf(p, v, spots), place, spots };
}

/** The world position of the nearest point of any of these kinds. */
function nearestOf(p: Player, v: Vehicle, spots: Spot[]): THREE.Vector3 | null {
  let best: THREE.Vector3 | null = null;
  let bd = Infinity;
  for (const pt of accessPointsOf(v.def)) {
    if (!spots.includes(pt.spot)) continue;
    const pos = pointPos(v, pt);
    const d = Math.hypot(pos.x - p.pos.x, pos.z - p.pos.z);
    if (d < bd) {
      bd = d;
      best = pos;
    }
  }
  return best;
}

/** The job in a few words, for "Open the bonnet · then fit ...". */
function thenOf(c: Carried): string {
  switch (c.kind) {
    case 'part':
      return `then fit ${partName(c.item)}`;
    case 'fuel':
      return 'then pour the fuel in';
    case 'oil':
      return 'then top up the oil';
    case 'water':
      return 'then top up the radiator';
    case 'paint':
    case 'food':
      return '';
  }
}

/** Light up the points this job could be done at, and call out the one you are at. */
function focusCarry(p: Player, info: CarryInfo, c: Carried, moving: boolean) {
  const v = info.v;
  const dots = accessPointsOf(v.def)
    .filter((pt) => info.spots.includes(pt.spot))
    .map((pt) => pointPos(v, pt));
  if (!info.at) {
    p.ctx.work.focus(p.index, dots, null);
    return;
  }
  const mk = c.kind === 'part' ? Math.min(3, Math.max(1, partDef(c.item.id).mk)) : 1;
  const here = !!info.place?.at;
  const need = info.plan.need;
  let text: string;
  let ok = info.plan.ok && !moving;
  if (!here) {
    text = c.kind === 'part' ? `Bring ${partName(c.item)} here` : `${carriedName(c)}: bring it here`;
    ok = false;
  } else if (need?.kind === 'open') {
    const name = needText(v.def, need).replace(/ first$/, '').replace(/^Open the /, '');
    text = `${name.charAt(0).toUpperCase()}${name.slice(1)} closed - hold to open`;
    ok = !moving;
  } else text = info.plan.label;
  p.ctx.work.focus(p.index, dots, { pos: info.at, text, css: MK_CSS[mk], ok });
}

/**
 * Every tick: outlines where a carried part goes (white from afar, green and filled when you are at the place and it is
 * open, red when the place is right but the job is not), a tag on the spot, and tags over loose parts and fitted ones you
 * inspect with a tool.
 */
export function guide(p: Player) {
  const ctx = p.ctx;
  if (p.state !== 'foot') return;
  if (p.carry?.kind === 'part') {
    const item = p.carry.item;
    const slot = partDef(item.id).slot;
    const v = p.nearestVehicle(SHOW_REACH, isWorkable);
    if (!v?.build) return;
    const tgt = carryTarget(p, v, slot);
    const moving = Math.abs(v.speed) > 2;
    if (!tgt.hit) {
      // From afar every place it could go shows.
      const far = nearestSocket(p, slot, SHOW_REACH);
      if (far) ctx.work.ghost(`g${p.index}`, ghostAnchors(far.v, far.sock), 'idle');
      return;
    }
    const { hit, gate } = tgt;
    const { v: tv, sock, anchor } = hit;
    // Up close only the one you would fit it to (one wheel of four).
    ctx.work.ghost(`g${p.index}`, ghostAnchors(tv, sock, PER_WHEEL.includes(sock.slot) ? hit.index : undefined), gate.ok && !moving ? 'aimed' : 'blocked');
    // The part itself snaps onto the mount as a see-through copy, so you see where it will sit before you bolt it.
    if (!ctx.work.holding(p.index)) ctx.work.preview(p.index, item, handPos(p), [anchorWorld(tv, anchor)], gate.ok && !moving ? 'aimed' : 'blocked');
    if (!ctx.work.holding(p.index)) {
      const info = carryInfo(p, tv, p.carry);
      const cur = fittedAt(hit);
      const act = moving ? 'Wait for it to stop' : info.plan.ok ? `Attach ${partDef(item.id).name}` : info.plan.label;
      const lines = [{ text: sock.label, css: '#cfc8b4' }, { text: cur ? `Now: ${partDef(cur.id).name} ${Math.round(cur.cond * 100)}%` : 'Empty mount', css: '#e6dcc0' }, { text: act, css: moving || !info.plan.ok ? '#ff8a6a' : '#8cf08c' }];
      ctx.work.tag(`t${p.index}`, lines, anchorWorld(tv, anchor).add(new THREE.Vector3(0, 0.9, 0)));
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
  // Looking at something on the ground: the label under the crosshair names it (`grab.ts`), so no tag hangs over it.
  const near = p.lookInfo || lookedAt(p) ? null : ctx.loose?.nearest(p.pos.x, p.pos.z, LIFT_REACH + 2.4);
  if (near) {
    ctx.work.tag(`i${p.index}`, inspectLines(near.carried), new THREE.Vector3(near.x, near.y + 1.15, near.z));
    return;
  }
  // The wrench or crowbar in hand at your own car: look at what is bolted to the point you are at.
  if (p.equip === 'wrench' || p.equip === 'crowbar') {
    const v = ownRideNear(p);
    if (!v?.build) return;
    const th = toolHit(p, v, null);
    if (!th) return;
    const { hit, gate } = th;
    const cur = fittedAt(hit);
    ctx.work.ghost(`g${p.index}`, ghostAnchors(v, hit.sock, PER_WHEEL.includes(hit.sock.slot) ? hit.index : undefined), gate.ok ? 'aimed' : 'blocked');
    const lines = cur ? [{ text: hit.sock.label, css: '#cfc8b4' }, ...partInspect({ uid: '', id: cur.id, cond: cur.cond })] : [{ text: hit.sock.label, css: '#cfc8b4' }, { text: 'Empty mount', css: '#ff8a6a' }];
    if (gate.need) lines.push({ text: needText(v.def, gate.need), css: '#ff8a6a' });
    ctx.work.tag(`t${p.index}`, lines, anchorWorld(v, hit.anchor).add(new THREE.Vector3(0, 0.9, 0)));
  }
}

/** The hold-A candidate: lift what is at your feet, or take what is in your hands to the right place on the car beside you. */
export function haulCandidate(p: Player, deck?: () => Cand | null): Cand | null {
  const ctx = p.ctx;
  if (!p.carry) {
    const lifting = p.action?.kind === 'lift' ? String(p.action.target) : undefined;
    // What you are looking at, if it is in reach, is what you lift; otherwise whatever is nearest your feet.
    const look = lookedAt(p);
    const aimed = look && Math.hypot(look.x - p.pos.x, look.z - p.pos.z) <= LIFT_REACH + 0.8 && (!lifting || look.id === lifting) ? look : null;
    const near = aimed ?? ctx.loose?.nearest(p.pos.x, p.pos.z, LIFT_REACH, lifting);
    const goods = ctx.loose?.nearestGoods(p.pos.x, p.pos.z, LIFT_REACH, lifting);
    // Whichever lies closer; the one already being lifted keeps the hold.
    const dist = (o: { id: string; x: number; z: number }) => Math.hypot(o.x - p.pos.x, o.z - p.pos.z) - (o.id === lifting ? 0.3 : 0);
    if (goods && (!near || (!aimed && dist(goods) < dist(near)))) {
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
    if (!near) return deck?.() ?? lizardCandidate(p);
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
  const v = p.nearestVehicle(c.kind === 'part' ? 9 : 4.5, isWorkable);
  if (!v?.build) return null;
  const info = carryInfo(p, v, c);
  const moving = Math.abs(v.speed) > 2;
  focusCarry(p, info, c, moving);
  // Standing at a panel that is shut and in the way: the next step is to open it.
  const need = info.plan.need;
  if (need?.kind === 'open' && info.place?.at) return panelCand(p, v, need.panel, true, thenOf(c));
  // Hands full at a shut boot or door that you could stow through: open it first.
  if (need?.kind === 'go') {
    const stow = stowPlace(p, v);
    const sn = stow.gate.need;
    if (stow.at && sn?.kind === 'open' && planStow(c, stowRoom(p)).ok) return panelCand(p, v, sn.panel, true, 'then X to stow it');
  }
  const hit = info.hit;
  return {
    kind: 'fit',
    prompt: moving ? `${v.def.name} is moving` : info.plan.label,
    dur: info.plan.secs,
    target: v,
    ok: info.plan.ok && !moving && !!info.place?.at,
    label: 'fit',
    noise: c.kind === 'part' ? 22 : 14,
    run: () => fit(p, v, c, hit, info.at),
    tick: () => {
      if (c.kind === 'part') ctx.work.hold(p.index, c.item, handPos(p), hit ? anchorWorld(v, hit.anchor) : (info.at ?? sitePos(v, slotSite(c.item.id))), p.action ? p.action.t / p.action.dur : 0);
      if (c.kind === 'part' && Math.random() < 0.18) ctx.fx.spark(v.position.x + (Math.random() - 0.5), v.position.y + 0.8, v.position.z + (Math.random() - 0.5), 2, 3);
      return true;
    },
  };
}

/**
 * Crowbar at your own vehicle: pry the part you are facing off its mount and carry it away. A door, the bonnet, a tyre,
 * the engine, the gearbox: anything bolted on comes off, and the mount shows bare until something else goes on. Behind a shut
 * panel the next step is to open it; with a panel open it is what is behind it that you work on.
 */
export function pryCandidate(p: Player): Cand | null {
  const ctx = p.ctx;
  const v = ownRideNear(p);
  if (!v?.build) return null;
  const th = toolHit(p, v, null, (h) => !!fittedAt(h)) ?? toolHit(p, v, null);
  if (!th) return panelClose(p);
  const { hit, gate } = th;
  const cur = fittedAt(hit);
  const label = hit.sock.label;
  const moving = Math.abs(v.speed) > 2;
  if (!cur) return panelClose(p) ?? { kind: 'pry', prompt: `${label}: nothing to pry off`, dur: 1, target: `${v.id}:${label}`, ok: false, label: 'pry', run: () => {} };
  const name = partDef(cur.id).name;
  if (gate.need?.kind === 'open') return panelCand(p, v, gate.need.panel, true, `then pry off the ${name.toLowerCase()}`);
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

/** A tool with nothing to do at a panel that is open: the job is to close it. */
export function panelClose(p: Player): Cand | null {
  const v = ownRideNear(p);
  if (!v?.build) return null;
  const open = v.panelOpen();
  const spots = (['hood', 'doorL', 'doorR', 'trunk'] as const).filter((s) => v.hasPanel(s) && open[s]);
  if (!spots.length) return null;
  let best: { panel: Panel; d: number } | null = null;
  for (const pt of accessPointsOf(v.def)) {
    if (!(spots as readonly Spot[]).includes(pt.spot)) continue;
    const pos = pointPos(v, pt);
    const dx = pos.x - p.pos.x;
    const dz = pos.z - p.pos.z;
    const d = Math.hypot(dx, dz);
    const f = d < 0.45 ? 1 : (dx * Math.sin(p.aimYaw) + dz * Math.cos(p.aimYaw)) / d;
    if (d <= 1.8 && f >= 0.2 && (!best || d < best.d)) best = { panel: pt.spot as Panel, d };
  }
  return best ? panelCand(p, v, best.panel, false) : null;
}

/** Put what is in your hands onto the vehicle. `at` is where the job is, for the pour. */
function fit(p: Player, v: Vehicle, c: Carried, hit: SocketHit | null, at: THREE.Vector3 | null) {
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
      const anchor = hit ? anchorWorld(v, hit.anchor) : (at?.clone() ?? sitePos(v, slotSite(c.item.id)));
      const mk = Math.min(3, Math.max(1, partDef(c.item.id).mk));
      // A set of tyres goes on at every wheel.
      if (hit && hit.sock.slot === 'wheels') for (const pt of accessPointsOf(v.def)) if (pt.spot === 'wheel' && pt.index !== hit.index) ctx.work.burst(pointPos(v, pt), mk, 0.7);
      ctx.work.swap({
        key: p.index,
        anchor,
        from: p.human.carryWorld(new THREE.Vector3()) ?? handPos(p),
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
      const to = at ?? sitePos(v, 'rear');
      ctx.work.pour(handPos(p), to, [0.85, 0.7, 0.2]);
      ctx.work.label(`+${r.used.toFixed(1)} FU`, '#ffd27a', to.clone().add(new THREE.Vector3(0, 0.8, 0)));
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
      const to = at ?? sitePos(v, 'hood');
      ctx.work.pour(handPos(p), to, [0.4, 0.65, 0.9]);
      ctx.work.label(`WATER ${Math.round(r.coolant * 100)}%`, '#8ecbff', to.clone().add(new THREE.Vector3(0, 0.8, 0)));
      p.carry = r.left > 0.2 ? { kind: 'water', amount: r.left } : null;
      p.note(`The radiator is at ${Math.round(r.coolant * 100)}% (${r.used.toFixed(1)} L in)`, 'good');
      ctx.audio.play('pickup', v.position.x, v.position.z, 0.5);
      break;
    }
    case 'oil': {
      const r = pourOil(v.health.comp.oil, c.amount, v.stats.sumpL);
      v.health.comp.oil = r.oil;
      v.commit();
      const to = at ?? sitePos(v, 'hood');
      ctx.work.pour(handPos(p), to, [0.12, 0.1, 0.08]);
      ctx.work.label(`OIL ${Math.round(r.oil * 100)}%`, '#e6dcc0', to.clone().add(new THREE.Vector3(0, 0.8, 0)));
      p.carry = r.left > 0.02 ? { kind: 'oil', amount: r.left } : null;
      p.note(`Oil topped up to ${Math.round(r.oil * 100)}%`, 'good');
      ctx.audio.play('pickup', v.position.x, v.position.z, 0.5);
      break;
    }
  }
}

// ---------------------------------------------------------------- stowing

/** What the trucks have room for. */
function stowRoom(p: Player, v?: Vehicle | null) {
  const camp = p.ctx.campaign;
  return { parts: camp.inventoryRoom, oil: OIL_RESERVE_MAX - camp.items.oil, water: WATER_RESERVE_MAX - camp.items.water, inside: v?.build ? v.insideRoom() : undefined };
}

/** Where the player stands against a vehicle for putting something in: the boot with its lid up, or the back seat through an open door. */
export function stowPlace(p: Player, v: Vehicle): Place {
  return placeFor(p, v, 'stow');
}

/**
 * Stow what is in your hands in the trucks, through the boot (lid open) or an open door to the back seat. Returns true if the
 * hands are now empty. Standing anywhere else, or at a shut boot, it is refused and says why.
 */
export function stowCarry(p: Player, quiet = false): boolean {
  const c = p.carry;
  if (!c) return true;
  const near = ownRideNear(p);
  const plan = planStow(c, stowRoom(p, near), near ? { def: near.def, at: stowPlace(p, near).at?.pt.spot ?? null, open: near.panelOpen() } : undefined);
  if (!plan.ok) {
    if (!quiet) p.note(plan.label, 'warn');
    return false;
  }
  const camp = p.ctx.campaign;
  if (near) claimFor(p, near);
  if (near && !quiet) {
    // It flies into the boot (or the cab), onto the spot of the floor it will lie on (`render/bootDeck.ts`).
    const [lx, ly, lz] = bootSpot(bootDeck(near.def), near.stowedParts().length);
    const [bx, by, bz] = near.body.toWorld(lx, ly, lz);
    p.ctx.work.stow(c.kind === 'part' ? modelKey(c.item) : carryModelKey(c), handPos(p), new THREE.Vector3(bx, by, bz), () => near.refreshLoadNow());
  }
  switch (c.kind) {
    case 'part':
      if (near?.build) c.item.on = near.build.uid;
      camp.stowPart(c.item);
      p.carry = null;
      if (!quiet) p.note(`${partName(c.item)} stowed in the ${near?.insideRoom().name ?? 'trunk'}: secure at any speed`, 'good');
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
  else if (c.kind === 'food') camp.stocks.rations += FOODS[c.food].rations;
  // A spray can has no place in the trucks: it is simply left behind.
}

/** Climbing in with full hands: it goes in the trunk if you are at an open one and it fits, otherwise it is set down beside the car. */
export function stashBeforeEntering(p: Player) {
  if (!p.carry) return;
  // Only your own convoy's trunk takes it; a found car has no trunk of yours to teleport things into.
  if (!ownRideNear(p) || !stowCarry(p, true)) dropCarry(p);
  else p.note('Stowed in the trunk', 'info');
}

// ---------------------------------------------------------------- loads on the outside

/** Vehicles that have been warned about a loose load this session (the long warning is shown once per car). */
const warned = new Set<string>();

/** Where the player stands against a vehicle for putting something on the outside: the roof, the bed, the rack, the rear cage. */
export function loadPlace(p: Player, v: Vehicle): Reach | null {
  if (!v.build) return null;
  return reached(p, v, loadSpots(v.def, v.build.fit));
}

/** What setting `c` down at `spot` would do. */
export function loadPlan(v: Vehicle, spot: Spot, c: Carried): LoadPlan {
  return planLoad(v.def, v.build!.fit, v.cargoRig.entries, spot, c);
}

function surfaceNameOf(v: Vehicle, zone: Zone): string {
  return surfacesOf(v.def, v.build!.fit).find((s) => s.zone === zone)?.name ?? zone;
}

/** X at the roof, the bed or a rack: set what you carry on the outside of the car. It is secure only if a holder takes it. */
export function loadCarry(p: Player): boolean {
  const c = p.carry;
  const v = ownRideNear(p);
  if (!c || !v?.build) return false;
  const at = loadPlace(p, v);
  if (!at) return false;
  const plan = loadPlan(v, at.pt.spot, c);
  if (!plan.ok || !plan.zone) {
    p.note(plan.label, 'warn');
    return false;
  }
  if (Math.abs(v.speed) > 2) {
    p.note(t('access.moving', { name: v.def.name }), 'warn');
    return false;
  }
  claimFor(p, v);
  const spot = v.cargoRig.nextSpot(c, plan.zone);
  p.ctx.work.stow(c.kind === 'part' ? modelKey(c.item) : carryModelKey(c), handPos(p), spot, () => v.refreshLoadNow());
  v.cargoRig.add(c, plan.zone);
  p.carry = null;
  p.note(t('cargo.putOn', { name: carriedName(c), where: surfaceNameOf(v, plan.zone), state: plan.label }), plan.secure ? 'good' : 'warn');
  if (!plan.secure && !warned.has(v.build.uid)) {
    warned.add(v.build.uid);
    p.note(t('cargo.warnOnce'), 'warn');
  }
  p.ctx.audio.play('pickup', p.pos.x, p.pos.z, 0.5);
  return true;
}

/** X with empty hands at the roof, the bed, the rack or the cage: the thing nearest your hands that rides there. */
export function cargoTakeTarget(p: Player): { v: Vehicle; entry: CargoEntry } | null {
  if (p.carry) return null;
  const v = p.nearestVehicle(3.8, isOwnRide);
  if (!v?.build || !v.cargoRig.entries.length) return null;
  const at = loadPlace(p, v);
  if (!at) return null;
  const zones = surfacesOf(v.def, v.build.fit).filter((s) => s.spot === at.pt.spot).map((s) => s.zone);
  const hands = new THREE.Vector3(p.pos.x, p.pos.y + 1.0, p.pos.z);
  let best: CargoEntry | null = null;
  let bd = Infinity;
  for (const e of v.cargoRig.entries) {
    if (!zones.includes(e.zone)) continue;
    const d = hands.distanceTo(v.cargoRig.worldOf(e));
    if (d < bd) {
      bd = d;
      best = e;
    }
  }
  return best ? { v, entry: best } : null;
}

/** Take a load off the outside of the car into your arms. */
export function cargoTakeKey(p: Player): boolean {
  const target = cargoTakeTarget(p);
  if (!target) return false;
  const { v, entry } = target;
  const from = v.cargoRig.worldOf(entry);
  const e = v.cargoRig.remove(entry.id);
  if (!e) return false;
  p.carry = e.c;
  p.ctx.work.stow(carryModelKey(e.c), from, handPos(p));
  p.ctx.audio.play('pickup', v.position.x, v.position.z, 0.7);
  p.note(`Took ${carriedName(e.c)} off the ${surfaceNameOf(v, e.zone)}`, 'good');
  return true;
}

/** The prompt under the main one for empty hands at a loaded roof or bed. */
export function cargoTakePrompt(p: Player) {
  const target = cargoTakeTarget(p);
  if (!target) return;
  const text = `${t('cargo.takeOff', { name: carriedName(target.entry.c), where: surfaceNameOf(target.v, target.entry.zone) })}  ·  ${target.v.cargoRig.isSecure(target.entry) ? 'secure' : 'loose'}`;
  if (p.prompt) p.promptAlt = { text, button: 'X', ok: true };
  else p.prompt = { text, progress: -1, button: 'X' };
}

/**
 * Where X puts what you carry: inside (the boot, or through a door) or on the outside (roof, bed, rack, cage). At a boot or door
 * you stow, or are told to open it first (a shut door never turns into a loose load on the roof by accident); with both in reach
 * and the way in open, the nearer one you face wins. Step back from the doors to reach the roof.
 */
function xPlace(p: Player, v: Vehicle): 'stow' | 'load' | null {
  const place = stowPlace(p, v);
  const st = place.at;
  const ld = loadPlace(p, v);
  if (st && place.gate.ok && ld) return st.dist - 1.2 * st.facing <= ld.dist - 1.2 * ld.facing ? 'stow' : 'load';
  if (st) return 'stow';
  return ld ? 'load' : null;
}

/** X while carrying: stow it inside your car (boot or door open), put it on the roof or in the bed, or set it down. A shut boot you are standing at says so first. */
export function haulKey(p: Player) {
  if (!p.carry) return;
  const v = p.carry.kind !== 'paint' ? ownRideNear(p) : null;
  if (!v) return dropCarry(p);
  const x = xPlace(p, v);
  if (x === 'stow') return void stowCarry(p);
  if (x === 'load') return void loadCarry(p);
  // Not at a place to put it: set it down.
  dropCarry(p);
}

/** The prompt for a player whose hands are full: A does the fit (already in `p.prompt`), X stows it or sets it down. */
export function haulPrompt(p: Player) {
  const c = p.carry;
  if (!c) return;
  const v = c.kind !== 'paint' ? ownRideNear(p) : null;
  let x: { ok: boolean; label: string };
  if (!v) x = { ok: true, label: `Put down ${carriedName(c)}  ·  walk it to your car to fit or stow it` };
  else {
    const place = stowPlace(p, v);
    const where = xPlace(p, v);
    const lp = where === 'load' ? loadPlace(p, v) : null;
    if (where === 'stow' && place.at) {
      x = planStow(c, stowRoom(p, v), { def: v.def, at: place.at.pt.spot, open: v.panelOpen() });
      if (!x.ok && loadPlace(p, v)) x = { ...x, label: `${x.label}  ·  or step back from the door to put it on the roof` };
    }
    else if (lp) {
      const plan = loadPlan(v, lp.pt.spot, c);
      x = { ok: plan.ok, label: plan.ok ? `Put it on the ${surfaceNameOf(v, plan.zone!)}  ·  ${plan.label}` : plan.label };
    } else {
      const inside = v.def.id === 'pickup' || v.def.id === 'buggy' ? 'stow it through a door' : `stow it at the ${spotName(v.def, 'trunk')}${v.def.slots?.includes('seatR') ? ' or a back door' : ''}`;
      const outside = loadSpots(v.def, v.build!.fit).includes('roof') ? ' (or put it on the roof)' : '';
      x = { ok: true, label: `Put down ${carriedName(c)}  ·  ${inside}${outside}` };
    }
  }
  // Another prompt (a fit in progress, "enter the car") keeps the main slot; X rides underneath it.
  if (p.prompt) p.promptAlt = { text: x.label, button: 'X', ok: x.ok };
  else p.prompt = { text: x.label, progress: -1, button: 'X' };
}
