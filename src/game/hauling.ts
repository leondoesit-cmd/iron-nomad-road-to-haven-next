import * as THREE from 'three';
import { PARTS, partDef, type PartSlot } from '../data';
import { MK_CSS, SLOT_SITE, modelKey, type Site } from '../render/workFx';
import { OIL_RESERVE_MAX } from './campaign';
import { carriedName, liftSecs, planFit, planStow, pourFuel, type Carried } from '../sim/carry';
import { installPart } from '../sim/garage';
import { pourOil } from '../sim/oil';
import { partName } from '../sim/parts';
import { deckCandidate, pickMount } from './carwork';
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
  const v = ownRideNear(p);
  if (!v) return null;
  const plan = planFit(c, { def: v.def, fitted: (slot) => v.build?.fit[slot as PartSlot], fuel: v.fuel, tankMax: v.tankMax, oil: v.health.comp.oil });
  const moving = Math.abs(v.speed) > 2;
  // A part goes on at its own mount: carry it there, and the mount rings. Hold it over the spot to bolt it on.
  const slot = c.kind === 'part' ? partDef(c.item.id).slot : null;
  const pick = slot ? pickMount(p, v, slot) : null;
  const away = !!pick && !pick.near;
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
    run: () => fit(p, v, c),
    tick: () => {
      if (c.kind === 'part') ctx.work.hold(p.index, c.item, handPos(p), pick?.mount.pos ?? sitePos(v, slotSite(c.item.id)), p.action ? p.action.t / p.action.dur : 0);
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
      const pick = pickMount(p, v, partDef(c.item.id).slot);
      const anchor = pick?.mount.pos.clone() ?? sitePos(v, slotSite(c.item.id));
      const mk = Math.min(3, Math.max(1, partDef(c.item.id).mk));
      // A set of tyres goes on at every wheel.
      if (pick && pick.mount.slot === 'wheels') for (const m of pick.all) if (m.slot === 'wheels' && m !== pick.mount) ctx.work.burst(m.pos, mk, 0.7);
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
      const r = pourFuel(v.fuel, v.tankMax, c.amount);
      v.fuel = r.fuel;
      ctx.work.pour(handPos(p), sitePos(v, 'rear'), [0.85, 0.7, 0.2]);
      ctx.work.label(`+${r.used.toFixed(1)} FU`, '#ffd27a', sitePos(v, 'rear').add(new THREE.Vector3(0, 0.8, 0)));
      p.carry = r.left > 0.05 ? { kind: 'fuel', amount: r.left } : null;
      p.note(`+${r.used.toFixed(1)} FU in the tank${p.carry ? ', some left in the can' : ''}`, 'good');
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
  if (near && !quiet) {
    // It flies to the spot on the car's deck it will sit in, and appears there as it lands.
    const spot = near.nextDeckSpot(c.kind === 'part' ? { part: { uid: c.item.uid, id: c.item.id } } : c.kind === 'fuel' ? { fuel: near.load.fuel + 1 } : { oil: near.load.oil + 1 }) ?? trunkPos(near);
    p.ctx.work.stow(c.kind === 'part' ? modelKey(c.item) : c.kind, handPos(p), spot, () => near.refreshLoadNow());
  }
  switch (c.kind) {
    case 'part':
      if (near?.build) c.item.on = near.build.uid;
      camp.stowPart(c.item);
      p.carry = null;
      if (!quiet) p.note(`${partName(c.item)} stowed in the trunk`, 'good');
      break;
    case 'fuel':
      camp.stowFuel(c.amount);
      p.carry = null;
      if (!quiet) p.note(`+${c.amount.toFixed(1)} FU in the reserve cans`, 'good');
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
  else if (c.kind === 'fuel') camp.stowFuel(c.amount);
  else if (camp.stowOil(c.amount) < c.amount - 0.02) camp.stocks.scrap += 1;
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
  if (ownRideNear(p)) stowCarry(p);
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
