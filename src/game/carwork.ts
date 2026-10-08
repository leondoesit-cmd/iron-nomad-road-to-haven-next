import * as THREE from 'three';
import { GLASS_SLOTS, INTERIOR_SLOTS, PARTS, isGlassSlot, partDef, type PartSlot } from '../data';
import { MK_CSS, modelKey } from '../render/workFx';
import { accessPointsOf } from '../render/accessPoints';
import { cutHood, idInSlot, removePart, removeTyre, tyreAt } from '../sim/garage';
import { bayFit, bayText, engineSpec, hoodState } from '../sim/engines';
import { partName } from '../sim/parts';
import { planRepair, type RepairKind } from '../sim/repair';
import { workFor, type Spot } from '../sim/access';
import { isOwnRide, panelCand, pointPos, toolHit } from './access';
import { panelClose } from './hauling';
import type { Cand, Player } from './player';
import type { Vehicle } from './vehicle';

export { isOwnRide };

/**
 * Working on a car with your hands, in the world. Every job on a vehicle is done at one of its access points (the engine
 * bay at the front, each wheel, the driver's door, the boot...), within a stride of it and facing it, and some are behind a
 * panel that has to be open first: see `game/access.ts` for where you stand and `sim/access.ts` for the rules. With the wrench
 * out, the points that have something bolted on light up; the one you are at rings and names what is on it. Hold A to unbolt it
 * (a set of tyres comes off all four wheels), or to open the bonnet first if that is what stands in the way. Carry a part to its
 * own point and hold A to bolt it on. Spares stowed on the car come out through its storage panel (`storage.ts`, X at the boot).
 */

const SLOT_LABEL = (slot: PartSlot) => PARTS.labels[slot];

/** What the wrench works on by hand: the bolt-ons and the cabin. The gearbox, the panels and the rest need the crowbar. */
export const WRENCH_SLOTS: PartSlot[] = ['engine', 'wheels', 'armor', 'side', 'weapon', 'utility', 'front', 'roof', 'rear', ...INTERIOR_SLOTS, ...GLASS_SLOTS];

/** The repair a job needs maps to the slot it is done at. */
const REPAIR_SLOT: Record<RepairKind, PartSlot> = { fire: 'engine', leak: 'utility', tire: 'wheels', engine: 'engine', radiator: 'cooling', gearbox: 'gearbox', mount: 'weapon', body: 'armor' };

const handPos = (p: Player) => p.human.hand.getWorldPosition(new THREE.Vector3());

/** Seconds to unbolt something. */
const unboltSecs = (slot: PartSlot) => (slot === 'engine' ? 3.4 : slot === 'wheels' ? 2.8 : slot === 'weapon' ? 2.2 : isGlassSlot(slot) ? 2.4 : 1.8);

/** Is there a part (or a tyre) on this mount that the wrench would take off? */
function fittedOn(v: Vehicle, slot: PartSlot, index: number) {
  const b = v.build!;
  if (slot === 'wheels') return b.tyres[index] && !partDef(b.tyres[index]!.id).empty ? tyreAt(b, index) : null;
  return b.fit[slot] && !partDef(b.fit[slot]!.id).empty ? b.fit[slot] : null;
}

/** The access points that have something the wrench could take off, in the world. */
function wrenchDots(v: Vehicle): THREE.Vector3[] {
  const spots = new Set<Spot>();
  for (const slot of WRENCH_SLOTS) {
    const wk = workFor(v.def, slot);
    if (!wk) continue;
    const has = slot === 'wheels' ? v.build!.tyres.some((_, i) => fittedOn(v, 'wheels', i)) : !!fittedOn(v, slot, 0);
    if (has) for (const s of wk.at) spots.add(s);
  }
  return accessPointsOf(v.def)
    .filter((pt) => spots.has(pt.spot))
    .map((pt) => pointPos(v, pt));
}

/**
 * Wrench in hand, standing at one of your cars. Lights the points that have something on them; returns the job at the one
 * you are at: the repair if that stock part is what is broken, unbolting what is fitted, or opening the bonnet (or door) that
 * is in the way. Null when there is nothing to do here, so the caller can fall back to a whole-car repair.
 */
export function wrenchCandidate(p: Player, repair: () => Cand | null): Cand | null {
  const v = p.nearestVehicle(5, isOwnRide);
  if (!v || !v.build) return null;
  const ctx = p.ctx;
  const dots = wrenchDots(v);
  const cut = cutHoodCandidate(p, v, dots);
  if (cut) return cut;
  // What has something on it comes first; failing that, whatever mount you are at (to repair it, or say it is stock).
  const th = toolHit(p, v, WRENCH_SLOTS, (h) => !!fittedOn(v, h.sock.slot, h.index)) ?? toolHit(p, v, WRENCH_SLOTS);
  if (!th) {
    ctx.work.focus(p.index, dots, null);
    return panelClose(p);
  }
  const { hit, gate, reach } = th;
  const slot = hit.sock.slot;
  const index = hit.index;
  const pos = reach.pos;
  const fitted = fittedOn(v, slot, index);
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
    return panelClose(p);
  }
  const mk = Math.min(3, Math.max(1, partDef(fitted.id).mk));
  if (gate.need?.kind === 'open') {
    // The part is behind a panel that is shut: the first step is to open it.
    const c = panelCand(p, v, gate.need.panel, true, `then unbolt ${partName(fitted)}`);
    ctx.work.focus(p.index, dots, { pos, text: `${head}: ${partName(fitted)} - ${c.prompt.split('  ·')[0].toLowerCase()}`, css: MK_CSS[mk], ok: c.ok });
    return c;
  }
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
    run: () => unbolt(p, v, slot, pos),
    tick: () => {
      // Sparks and the ring of a spanner turning on the bolts.
      if (Math.random() < 0.35) ctx.fx.spark(pos.x + (Math.random() - 0.5) * 0.3, pos.y + (Math.random() - 0.5) * 0.2, pos.z + (Math.random() - 0.5) * 0.3, 2, 3);
      if (Math.random() < 0.08) ctx.audio.play('wrench', pos.x, pos.z, 0.5);
      return true;
    },
  };
}

/**
 * The wrench at a shut bonnet over an engine too big to go under it: cut the bonnet open for it. The cut is permanent
 * (`sim/garage.ts` `cutHood`). The other ways out are to pry the bonnet off with the crowbar, or fit a smaller engine.
 */
function cutHoodCandidate(p: Player, v: Vehicle, dots: THREE.Vector3[]): Cand | null {
  const b = v.build;
  if (!b || !v.hasPanel('hood') || v.open.hood || hoodState(b.fit) !== 'closed') return null;
  const spec = engineSpec(v.def, b.fit);
  const bay = bayFit(v.def, spec);
  // A snug engine only bulges the bonnet; the cut is for one that props it or cannot be closed over at all.
  if (bay.bonnet === 'flat' || bay.bonnet === 'bulge' || b.fit.engine === undefined) return null;
  const th = toolHit(p, v, ['hood']);
  if (!th) return null;
  const ctx = p.ctx;
  const pos = th.reach.pos;
  const moving = Math.abs(v.speed) > 2;
  const name = partName(b.fit.engine);
  ctx.work.focus(p.index, dots, { pos, text: `Bonnet: ${bayText(bay.label)}`, css: '#ffb454', ok: !moving });
  return {
    kind: 'cuthood',
    prompt: moving ? `${v.def.name} is moving` : `Cut a hole in the bonnet for ${name} (permanent)`,
    dur: 4.5,
    target: `${v.id}:cuthood`,
    ok: !moving,
    label: 'cut',
    noise: 38,
    run: () => {
      v.commit();
      const r = cutHood(b);
      if (!r.ok) return p.note(r.reason ?? 'It will not cut', 'warn');
      v.syncFromBuild();
      ctx.work.burst(pos, 3, 1);
      ctx.work.label('BONNET  CUT', '#ffb454', pos.clone().add(new THREE.Vector3(0, 0.8, 0)));
      ctx.audio.play('wrench', v.position.x, v.position.z, 0.9);
      p.note(`The bonnet is cut open: ${name} stands through it`, 'good');
    },
    tick: () => {
      if (Math.random() < 0.5) ctx.fx.spark(pos.x + (Math.random() - 0.5) * 0.5, pos.y + 0.1, pos.z + (Math.random() - 0.5) * 0.5, 3, 4);
      if (Math.random() < 0.1) ctx.audio.play('wrench', pos.x, pos.z, 0.6);
      return true;
    },
  };
}

/** Take the part in `slot` off the vehicle and into the player's arms. */
function unbolt(p: Player, v: Vehicle, slot: PartSlot, at: THREE.Vector3) {
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
  // A set of tyres comes off every wheel at once.
  const mine = slot === 'wheels' ? accessPointsOf(v.def).filter((pt) => pt.spot === 'wheel').map((pt) => pointPos(v, pt)) : [at];
  const hand = handPos(p);
  p.carry = { kind: 'part', item: out };
  const mk = Math.min(3, Math.max(1, partDef(out.id).mk));
  ctx.work.eject(p.index, out, mine[0], hand);
  for (const m of mine.slice(1)) ctx.work.stow(modelKey(out), m, hand);
  for (const m of mine) ctx.work.burst(m, mk, 0.7);
  ctx.work.label(`${SLOT_LABEL(slot).toUpperCase()}  ${partName(out)}  OFF`, '#e6dcc0', mine[0].clone().add(new THREE.Vector3(0, 0.8, 0)));
  ctx.audio.play('wrench', v.position.x, v.position.z, 0.8);
  p.note(`${partName(out)} off: carry it to a car or stow it`, 'good');
}

// ---------------------------------------------------------------------- the deck

/*
 * What is stowed on a car is taken out through its storage panel (`game/storage.ts`): X with free hands at the boot, a back
 * door, the bed or the roof opens it, and the pick comes out of its own spot on the boot floor (`render/bootDeck.ts`).
 */
