import * as THREE from 'three';
import { PARTS, partDef, type PartSlot } from '../data';
import { MK_CSS, modelKey } from '../render/workFx';
import { mountsOfChassis } from '../render/vehicleModels';
import { FUEL_CAN, carriedName, type Carried } from '../sim/carry';
import { removePart, removeTyre, tyreAt } from '../sim/garage';
import { OIL_CAN } from '../sim/oil';
import { partName, slotsOf } from '../sim/parts';
import { planRepair, type RepairKind } from '../sim/repair';
import type { Cand, Player } from './player';
import type { Vehicle } from './vehicle';

/**
 * Working on a car with your hands, in the world. Every vehicle has mount points (the engine bay, each wheel, a flank,
 * the roof, the tail...). Walk up with the wrench or with a part in your arms and the mounts light up on the car; the one
 * you are standing at rings and names what is on it. Hold A to unbolt what is there, or to bolt on what you carry. Spares
 * stowed on the car sit on its deck where you can see them, and you lift them off by hand.
 */

/** Vehicles you can work on from the ground: the convoy's own cars, and abandoned ones (which join the convoy at the first job). */
export const isOwnRide = (v: Vehicle) => (v.faction === 'convoy' || v.faction === 'neutral') && !!v.build && !v.wreck && v.kind !== 'crew';

export interface Mount {
  slot: PartSlot;
  /** Which of several (wheels) this is. */
  index: number;
  pos: THREE.Vector3;
}

const SLOT_LABEL = (slot: PartSlot) => PARTS.labels[slot];

/** A point just in front of the player's chest: where their hands are reaching. */
export function reachPoint(p: Player): THREE.Vector3 {
  return new THREE.Vector3(p.pos.x + Math.sin(p.aimYaw) * 0.7, p.pos.y + 1.0, p.pos.z + Math.cos(p.aimYaw) * 0.7);
}

/** Closeness that counts height for half as much as ground distance: a wheel is low, a roof rack is high. */
const reachDist = (a: THREE.Vector3, b: THREE.Vector3) => Math.hypot(a.x - b.x, a.z - b.z) + Math.abs(a.y - b.y) * 0.5;

/** Where each of a vehicle's mounts is in the world, on the side nearest `from`. */
export function mountsOf(v: Vehicle, from: THREE.Vector3): Mount[] {
  const a = mountsOfChassis(v.def);
  if (!a || !v.build) return [];
  const { m, g0 } = a;
  const inner = v.visual.inner;
  inner.updateWorldMatrix(true, false);
  const world = (x: number, y: number, z: number) => inner.localToWorld(new THREE.Vector3(x, y, z));
  const at = (x: number, y: number, z: number) => world(x, y - g0, z);
  const side = inner.worldToLocal(from.clone()).x >= 0 ? 1 : -1;
  const allowed = slotsOf(v.def);
  const out: Mount[] = [];
  const add = (slot: PartSlot, pos: THREE.Vector3, index = 0) => {
    if (allowed.includes(slot)) out.push({ slot, index, pos });
  };
  const zMid = (side0: number, side1: number) => (side0 + side1) / 2;
  add('engine', m.hood ? at(0, m.hood.y + 0.12, zMid(m.hood.z0, m.hood.z1) + (m.hood.z1 - m.hood.z0) * 0.12) : at(m.hw * 0.9, m.sill + 0.16, 0));
  v.visual.wheels.forEach((w, i) => {
    const lp = w.pivot.position;
    const out_ = Math.abs(lp.x) < 0.05 ? side * 0.3 : Math.sign(lp.x) * 0.3;
    add('wheels', world(lp.x + out_, lp.y, lp.z), i);
  });
  add('armor', at(side * (m.hw + 0.1), (m.side.y0 + m.side.y1) / 2, zMid(m.side.z0, m.side.z1)));
  add('side', at(side * (m.hw + 0.14), m.sill + 0.05, zMid(m.side.z0, m.side.z1) - (m.side.z1 - m.side.z0) * 0.25));
  if (m.gun) add('weapon', at(m.gun.x, m.gun.y + 0.2, m.gun.z));
  add('utility', at(side * (m.hw + 0.2), m.sill + 0.3, m.rear.z + 0.45));
  add('front', at(0, m.front.y + 0.1, m.front.z + 0.2));
  if (m.roof) add('roof', at(0, m.roof.y + 0.22, zMid(m.roof.z0, m.roof.z1)));
  add('rear', at(0, m.rear.y + 0.3, m.rear.z - 0.2));
  return out;
}

export interface Pick {
  mount: Mount;
  /** The player is close enough to work on it. */
  near: boolean;
  all: Mount[];
}

/**
 * The mount a player is working at. With a slot given (they carry a part for it) that is the nearest mount of the
 * slot, and `near` says whether they have carried it close enough. Without one it is whatever their hands are over.
 */
export function pickMount(p: Player, v: Vehicle, only?: PartSlot): Pick | null {
  const reach = reachPoint(p);
  const all = mountsOf(v, reach);
  if (!all.length) return null;
  let best: Mount | null = null;
  let bd = Infinity;
  for (const mt of all) {
    if (only && mt.slot !== only) continue;
    const d = only ? reachDist(new THREE.Vector3(p.pos.x, p.pos.y + 1.0, p.pos.z), mt.pos) : reachDist(reach, mt.pos);
    if (d < bd) {
      bd = d;
      best = mt;
    }
  }
  if (!best) return null;
  return { mount: best, near: bd < (only ? 2.1 : 1.35), all: all };
}

/** The repair a job needs maps to the slot it is done at. */
const REPAIR_SLOT: Record<RepairKind, PartSlot> = { fire: 'engine', leak: 'utility', tire: 'wheels', engine: 'engine', radiator: 'cooling', gearbox: 'gearbox', mount: 'weapon', body: 'armor' };

const handPos = (p: Player) => p.human.hand.getWorldPosition(new THREE.Vector3());

/** Seconds to unbolt something. */
const unboltSecs = (slot: PartSlot) => (slot === 'engine' ? 3.4 : slot === 'wheels' ? 2.8 : slot === 'weapon' ? 2.2 : 1.8);

/**
 * Wrench in hand, standing at one of your cars. Lights the mounts; returns the job at the one you are over: the repair
 * if that stock part is what is broken, otherwise unbolting what is fitted. Null when your hands are not over a mount, so the
 * caller can fall back to a whole-car repair.
 */
export function wrenchCandidate(p: Player, repair: () => Cand | null): Cand | null {
  const v = p.nearestVehicle(5, isOwnRide);
  if (!v || !v.build) return null;
  const ctx = p.ctx;
  const pick = pickMount(p, v);
  const dots = (pick?.all ?? mountsOf(v, reachPoint(p))).map((m) => m.pos);
  if (!pick || !pick.near) {
    ctx.work.focus(p.index, dots, null);
    return null;
  }
  const { slot, index, pos } = pick.mount;
  const wheelTyre = slot === 'wheels' ? (v.build.tyres[index] && !partDef(v.build.tyres[index]!.id).empty ? tyreAt(v.build, index) : null) : null;
  const fitted = slot === 'wheels' ? wheelTyre : (v.build.fit[slot] && !partDef(v.build.fit[slot]!.id).empty ? v.build.fit[slot] : undefined);
  const moving = Math.abs(v.speed) > 2;
  const head = `${SLOT_LABEL(slot)}`;
  const job = planRepair(v.health, ctx.campaign.stocks, { spare: v.stats.spare, weapon: !!v.weapon, dents: v.bodywork.dentLevel(), missing: v.bodywork.missing() });
  // What is fitted comes off first; a repair at a bare mount, or from anywhere else on the car, uses the wrench's other job.
  if (!fitted && job && REPAIR_SLOT[job.kind] === slot) {
    const rep = repair();
    if (rep) {
      ctx.work.focus(p.index, dots, { pos, text: `${head}: ${rep.prompt.split('  ·')[0]}`, css: '#7ddc7a', ok: rep.ok });
      return rep;
    }
  }
  if (!fitted) {
    ctx.work.focus(p.index, dots, { pos, text: `${head}: stock fitting`, css: '#bdb4a0', ok: true });
    return null;
  }
  const mk = Math.min(3, Math.max(1, partDef(fitted.id).mk));
  ctx.work.focus(p.index, dots, { pos, text: `${head}: ${partName(fitted)}`, css: MK_CSS[mk], ok: !moving });
  return {
    kind: 'unbolt',
    prompt: moving ? `${v.def.name} is moving` : `Unbolt ${partName(fitted)}`,
    dur: unboltSecs(slot),
    at: pos,
    target: `${v.id}:${slot}:${index}`,
    ok: !moving,
    label: 'unbolt',
    noise: 22,
    run: () => unbolt(p, v, slot, pick.all),
    tick: () => {
      // Sparks and the ring of a spanner turning on the bolts.
      if (Math.random() < 0.35) ctx.fx.spark(pos.x + (Math.random() - 0.5) * 0.3, pos.y + (Math.random() - 0.5) * 0.2, pos.z + (Math.random() - 0.5) * 0.3, 2, 3);
      if (Math.random() < 0.08) ctx.audio.play('wrench', pos.x, pos.z, 0.5);
      return true;
    },
  };
}

/** Take the part in `slot` off the vehicle and into the player's arms. */
function unbolt(p: Player, v: Vehicle, slot: PartSlot, mounts: Mount[]) {
  const ctx = p.ctx;
  if (p.carry || !v.build) return;
  v.commit();
  let out: ReturnType<typeof removePart> = null;
  if (slot === 'wheels') {
    out = removeTyre(v.build, 0);
    for (let i = 1; i < v.build.tyres.length; i++) removeTyre(v.build, i);
  } else {
    out = removePart(v.build, slot);
  }
  if (!out) return;
  v.syncFromBuild();
  const mine = mounts.filter((m) => m.slot === slot);
  const hand = handPos(p);
  p.carry = { kind: 'part', item: out };
  const mk = Math.min(3, Math.max(1, partDef(out.id).mk));
  ctx.work.eject(p.index, out, mine[0].pos, hand);
  // A set of tyres comes off every wheel at once.
  for (const m of mine.slice(1)) ctx.work.stow(modelKey(out), m.pos, hand);
  for (const m of mine) ctx.work.burst(m.pos, mk, 0.7);
  ctx.work.label(`${SLOT_LABEL(slot).toUpperCase()}  ${partName(out)}  OFF`, '#e6dcc0', mine[0].pos.clone().add(new THREE.Vector3(0, 0.8, 0)));
  ctx.audio.play('wrench', v.position.x, v.position.z, 0.8);
  p.note(`${partName(out)} off: carry it to a car or stow it`, 'good');
}

// ---------------------------------------------------------------------- the deck

/** The things riding on the deck of your car, as a hands-on candidate for lifting one off. */
export function deckCandidate(p: Player): Cand | null {
  if (p.carry) return null;
  const v = p.nearestVehicle(3.4, isOwnRide);
  if (!v) return null;
  const ctx = p.ctx;
  const reach = reachPoint(p);
  const spots = v.deckSpots();
  let best: (typeof spots)[number] | null = null;
  let bd = 1.0;
  for (const s of spots) {
    const d = reachDist(reach, s.world);
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  if (!best) return null;
  // With the wrench out, a mount you are nearer to takes the hold.
  if (p.equip === 'wrench') {
    const pick = pickMount(p, v);
    if (pick?.near && reachDist(reach, pick.mount.pos) < bd) return null;
  }
  const spot = best;
  const camp = ctx.campaign;
  let carried: Carried | null = null;
  let name = '';
  if (spot.kind === 'part') {
    const it = camp.inventory.find((q) => q.uid === spot.uid);
    if (!it) return null;
    carried = { kind: 'part', item: it };
    name = partName(it);
  } else if (spot.kind === 'fuel') {
    carried = { kind: 'fuel', amount: Math.min(FUEL_CAN, camp.stocks.fuel) };
    name = carriedName(carried);
  } else if (spot.kind === 'oil') {
    carried = { kind: 'oil', amount: Math.min(OIL_CAN, camp.items.oil) };
    name = carriedName(carried);
  } else {
    ctx.work.focus(p.index, [], { pos: spot.world, text: 'Spare parts heaped on the car', css: '#bdb4a0', ok: true });
    return null;
  }
  ctx.work.focus(p.index, [], { pos: spot.world, text: `Take ${name} off`, css: '#ffd27a', ok: true });
  const key = `${v.id}:${spot.kind}:${spot.uid ?? 'x'}:${spot.x.toFixed(2)}:${spot.z.toFixed(2)}`;
  return {
    kind: 'liftdeck',
    prompt: `Take ${name} off the ${v.def.name}`,
    dur: spot.kind === 'part' ? 0.9 : 0.55,
    at: spot.world,
    target: key,
    ok: true,
    label: 'lift',
    noise: 6,
    run: () => liftOff(p, v, spot.kind, spot.uid, spot.world),
  };
}

function liftOff(p: Player, v: Vehicle, kind: string, uid: string | undefined, from: THREE.Vector3) {
  const ctx = p.ctx;
  const camp = ctx.campaign;
  if (p.carry) return;
  const hand = handPos(p);
  if (kind === 'part') {
    const it = camp.takePart(uid ?? '');
    if (!it) return p.note('That one is gone', 'info');
    delete it.on;
    p.carry = { kind: 'part', item: it };
    ctx.work.eject(p.index, it, from, hand);
  } else if (kind === 'fuel') {
    const amt = Math.min(FUEL_CAN, camp.stocks.fuel);
    if (amt <= 0.05) return;
    camp.stocks.fuel -= amt;
    p.carry = { kind: 'fuel', amount: amt };
    ctx.work.stow('fuel', from, hand);
  } else if (kind === 'oil') {
    const amt = Math.min(OIL_CAN, camp.items.oil);
    if (amt <= 0.02) return;
    camp.items.oil -= amt;
    p.carry = { kind: 'oil', amount: amt };
    ctx.work.stow('oil', from, hand);
  } else return;
  v.refreshLoadNow();
  ctx.audio.play('pickup', v.position.x, v.position.z, 0.7);
  p.note(`Took ${carriedName(p.carry!)} off the ${v.def.name}`, 'good');
}
