import * as THREE from 'three';
import { Btn, wasPressed, type PlayerIntent } from '../input/intents';
import { carryModelKey, carriedName, foodLines, inspectLines, partInspect, type Carried, type InspectLine } from '../sim/carry';
import { planLoad, sizeOf, surfacesOf, type Zone } from '../sim/cargo';
import { FOODS } from '../sim/food';
import { partDef } from '../data';
import { deckOfZone, pieceGeometry } from '../render/cargoLoad';
import { mountsOfChassis } from '../render/vehicleModels';
import { makeCarryModel } from '../render/props';
import { bodyMat } from '../render/vehicleKit';
import { promptLabel } from '../input/input';
import { keyLabel, live } from '../input/bindings';
import { isOwnRide } from './access';
import type { Cand, Player } from './player';
import type { Vehicle } from './vehicle';

/**
 * Hands-on carrying, the way a scrapyard is worked: what you lift is held out in front of you where you look, and you put it
 * exactly where you want it. The wheel brings it nearer or pushes it out, the swap button turns it, fire lets go of it (on the
 * ground, or on a deck of one of your vehicles: in the rickshaw's cab, in a pickup's bed, on a roof) and aim throws it. A part
 * held at its mount still goes on with the interact hold; X still stows or sets down as before.
 *
 * It also says what you are looking at: a white label under the crosshair with the thing's name, what it is good for and how
 * worn it is (`Player.lookInfo`), and the buttons that do something with it (`Player.handHints`).
 */

/** How far out in front of the chest something can be held, and where it starts. */
export const HOLD_MIN = 0.7;
export const HOLD_MAX = 2.4;
export const HOLD_START = 1.2;
/** One notch of the wheel moves it this far. */
const HOLD_STEP = 0.18;
/** A press of the swap button turns it this much. */
const TURN_STEP = Math.PI / 4;
/** How hard a throw goes, m/s along the aim, and how much it lifts. */
const THROW_SPEED = 7.5;
const THROW_LIFT = 2.4;
/** Eye height on foot, where the line something is held along starts. */
const EYE = 1.6;
/** How far from the aim line something can lie and still be the thing looked at, and how far away. */
const LOOK_RADIUS = 0.55;
const LOOK_REACH = 3.4;
/** With the crosshair on nothing: what lies in front of you, this close and within this cone (cosine), is what you look at. */
const FRONT_REACH = 2.3;
const FRONT_COS = 0.72;

export interface HoldState {
  /** Metres out in front of the chest. */
  dist: number;
  /** Turned this far about the vertical, on top of the way you face. */
  yaw: number;
  /** Where it is held now, in the world, and where it would come to rest if let go. */
  at: THREE.Vector3;
  spot: Spot | null;
  /** The model floating in the hands, and the carried thing it shows. */
  model: THREE.Group | null;
  key: string;
}

/** Where a held thing would come to rest: on the ground, or on a deck of one of your vehicles. */
export type Spot =
  | { kind: 'ground'; pos: THREE.Vector3 }
  | { kind: 'deck'; pos: THREE.Vector3; v: Vehicle; zone: Zone; local: [number, number, number]; ok: boolean; label: string };

/** What a player is looking at: the lines of its label, and its id when it is something lying about. */
export interface LookInfo {
  lines: InspectLine[];
  id?: string;
}

/** A control hint: the button as this seat has it bound, and what it does. */
export interface HandHint {
  key: string;
  text: string;
}

export function newHold(): HoldState {
  return { dist: HOLD_START, yaw: 0, at: new THREE.Vector3(), spot: null, model: null, key: '' };
}

const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _l = new THREE.Vector3();

/** The view's aim line: from the camera through the crosshair. */
function aimRay(p: Player): { o: THREE.Vector3; d: THREE.Vector3 } {
  const cam = p.ctx.R.views[p.index]?.camera;
  if (!cam) {
    _o.set(p.pos.x, p.pos.y + 1.6, p.pos.z);
    _d.set(Math.sin(p.aimYaw), Math.sin(p.aimPitch), Math.cos(p.aimYaw)).normalize();
    return { o: _o, d: _d };
  }
  cam.updateMatrixWorld();
  _o.copy(cam.position);
  cam.getWorldDirection(_d);
  return { o: _o, d: _d };
}

/** How far below the line of sight something is held, radians: it sits at the chest when you look straight ahead. */
const HOLD_DIP = 0.32;

/**
 * Where something held at `dist` metres shows: out from the eyes along the way you look, dipped a little so it sits in front
 * of the chest, never under the ground. It follows the eyes, not the camera, so it is the same in either view: in first
 * person the view looks down that line, in third person it hangs in front of the body. Look down to lower it to the ground.
 */
export function holdPoint(p: Player, dist: number, out = new THREE.Vector3()): THREE.Vector3 {
  const pitch = Math.max(-1.25, Math.min(0.9, p.aimPitch - HOLD_DIP));
  const cp = Math.cos(pitch);
  const ey = p.pos.y + EYE;
  out.set(p.pos.x + Math.sin(p.aimYaw) * cp * dist, ey + Math.sin(pitch) * dist, p.pos.z + Math.cos(p.aimYaw) * cp * dist);
  const gy = p.ctx.groundAt(out.x, out.z) + 0.12;
  if (out.y < gy) out.y = gy;
  return out;
}

/** The deck of one of your own vehicles under a point, if any: the highest one it is over. */
function deckUnder(p: Player, c: Carried, at: THREE.Vector3): Spot | null {
  let best: Spot | null = null;
  for (const v of p.ctx.vehicles) {
    if (!isOwnRide(v) || !v.build) continue;
    if (Math.hypot(v.position.x - at.x, v.position.z - at.z) > v.def.length / 2 + 2.5) continue;
    const anchor = mountsOfChassis(v.def);
    if (!anchor) continue;
    v.visual.inner.updateWorldMatrix(true, false);
    _l.copy(at);
    v.visual.inner.worldToLocal(_l);
    for (const s of surfacesOf(v.def, v.build.fit)) {
      const deck = deckOfZone(anchor.m, anchor.g0, s.zone, !!s.holder);
      if (!deck) continue;
      const pad = 0.08;
      if (Math.abs(_l.x) > deck.hw + pad || _l.z < deck.z0 - pad || _l.z > deck.z1 + pad) continue;
      if (_l.y < deck.y - 0.35 || _l.y > deck.y + 1.8) continue;
      if (best && best.kind === 'deck' && best.local[1] >= deck.y) continue;
      const local: [number, number, number] = [Math.max(-deck.hw, Math.min(deck.hw, _l.x)), deck.y, Math.max(deck.z0, Math.min(deck.z1, _l.z))];
      const pos = v.visual.inner.localToWorld(new THREE.Vector3(local[0], local[1], local[2]));
      const plan = planLoad(v.def, v.build.fit, v.cargoRig.entries, s.spot, c);
      const moving = Math.abs(v.speed) > 2;
      const ok = plan.ok && plan.zone === s.zone && !moving;
      const label = moving ? `${v.def.name} is moving` : !plan.ok ? plan.label : plan.zone !== s.zone ? `No room in the ${s.name}` : plan.label;
      best = { kind: 'deck', pos, v, zone: s.zone, local, ok, label };
    }
  }
  return best;
}

/** Where what is held comes to rest if it is let go now. */
export function restSpot(p: Player, c: Carried, at: THREE.Vector3): Spot {
  return deckUnder(p, c, at) ?? { kind: 'ground', pos: new THREE.Vector3(at.x, p.ctx.groundAt(at.x, at.z), at.z) };
}

/**
 * Every tick on foot with something in your hands: wheel and swap move and turn it, fire sets it down where it is, aim
 * throws it. Returns true when the hands were emptied this tick (so nothing else acts on the same press).
 */
export function holdTick(p: Player, it: PlayerIntent): boolean {
  const c = p.carry;
  const h = p.hold;
  if (!c || p.state !== 'foot') return false;
  if (h.key !== carryModelKey(c)) {
    // Something new in the hands: it starts at the usual reach, square to you.
    h.key = carryModelKey(c);
    h.dist = HOLD_START;
    h.yaw = 0;
  }
  if (it.toolStep) h.dist = Math.max(HOLD_MIN, Math.min(HOLD_MAX, h.dist - it.toolStep * HOLD_STEP));
  if (wasPressed(it, Btn.LB)) h.yaw = (h.yaw + TURN_STEP) % (Math.PI * 2);
  holdPoint(p, h.dist, h.at);
  const spot = restSpot(p, c, h.at);
  h.spot = spot;
  const busy = !!p.action;
  if (!busy && wasPressed(it, Btn.RT)) return letGo(p, c, spot);
  if (!busy && wasPressed(it, Btn.LT)) return throwIt(p, c);
  // Show where it would land.
  const sz = sizeOf(c) >= 4 ? 0.7 : sizeOf(c) >= 2 ? 0.45 : 0.28;
  p.ctx.work.ghost(`h${p.index}`, [{ pos: spot.pos.clone().add(new THREE.Vector3(0, 0.02, 0)), quat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.aimYaw + h.yaw), size: [sz, 0.04, sz] }], spot.kind === 'deck' ? (spot.ok ? 'aimed' : 'blocked') : 'idle');
  return false;
}

/** Let go: it comes to rest where it is held, on the deck under it or on the ground. */
function letGo(p: Player, c: Carried, spot: Spot): boolean {
  const ctx = p.ctx;
  const yaw = p.aimYaw + p.hold.yaw;
  if (spot.kind === 'deck') {
    if (!spot.ok) {
      p.note(spot.label, 'warn');
      return false;
    }
    const v = spot.v;
    // The heading on the deck is the heading in the world less the vehicle's own.
    v.cargoRig.add(c, spot.zone, spot.local, yaw - v.yaw);
    p.carry = null;
    ctx.audio.play('pickup', spot.pos.x, spot.pos.z, 0.5);
    p.note(`${carriedName(c)}: ${spot.label.charAt(0).toLowerCase()}${spot.label.slice(1)}`, 'good');
    return true;
  }
  if (!ctx.loose) return false;
  p.carry = null;
  if (ctx.loose.place) ctx.loose.place(c, spot.pos.x, spot.pos.z, undefined, yaw);
  else ctx.loose.drop(spot.pos.x, spot.pos.z, c);
  ctx.audio.play('pickup', spot.pos.x, spot.pos.z, 0.4);
  return true;
}


/** Throw it: it flies off along the aim, tumbles, and can be lifted again once it lies still. */
function throwIt(p: Player, c: Carried): boolean {
  const ctx = p.ctx;
  if (!ctx.loose) return false;
  const { d } = aimRay(p);
  const geo = pieceGeometry(c);
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const size = sizeOf(c);
  const heavy = size === 4 ? 0.45 : size === 2 ? 0.75 : 1;
  const vel = new THREE.Vector3(d.x * THROW_SPEED * heavy, d.y * THROW_SPEED * heavy + THROW_LIFT * heavy, d.z * THROW_SPEED * heavy);
  ctx.debris.spawn({
    geo,
    material: bodyMat,
    pos: p.hold.at.clone(),
    quat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.aimYaw + p.hold.yaw),
    vel,
    spin: new THREE.Vector3((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6),
    centre: [(bb.max.x + bb.min.x) / 2, (bb.max.y + bb.min.y) / 2, (bb.max.z + bb.min.z) / 2],
    half: [Math.max(0.04, (bb.max.x - bb.min.x) / 2), Math.max(0.04, (bb.max.y - bb.min.y) / 2), Math.max(0.04, (bb.max.z - bb.min.z) / 2)],
    mass: size === 4 ? 30 : size === 2 ? 10 : 3,
    round: c.kind === 'part' && c.item.id.startsWith('tyre'),
    item: c.kind === 'part' ? c.item : null,
    carried: c.kind === 'part' ? null : c,
    tag: 'thrown',
  });
  p.carry = null;
  ctx.audio.play('pickup', p.pos.x, p.pos.z, 0.6);
  return true;
}

// ------------------------------------------------------------------------------------------------ looking at things

/**
 * The thing lying about that the aim line passes closest to, within reach. `Player.lookInfo` names it, and holding interact
 * lifts this one rather than whatever happens to be nearest your feet.
 */
export function lookedAt(p: Player): { id: string; carried: Carried; x: number; y: number; z: number } | null {
  const ctx = p.ctx;
  const all = ctx.loose?.around?.(p.pos.x, p.pos.z, LOOK_REACH) ?? [];
  if (!all.length) return null;
  const { o, d } = aimRay(p);
  let best: (typeof all)[number] | null = null;
  let bs = Infinity;
  for (const q of all) {
    const cy = q.y + 0.2;
    const vx = q.x - o.x;
    const vy = cy - o.y;
    const vz = q.z - o.z;
    const t = vx * d.x + vy * d.y + vz * d.z;
    if (t < 0) continue;
    const off = Math.hypot(vx - d.x * t, vy - d.y * t, vz - d.z * t);
    if (off > LOOK_RADIUS + 0.15 * Math.max(0, Math.hypot(q.x - p.pos.x, q.z - p.pos.z) - 1)) continue;
    const score = off + Math.hypot(q.x - p.pos.x, q.z - p.pos.z) * 0.05;
    if (score < bs) {
      bs = score;
      best = q;
    }
  }
  if (best) return best;
  // The crosshair is on nothing (a level third-person view looks over things lying at your feet, and keys and a pad do not
  // pitch it down): then it is whatever lies in front of you within arm's reach, the squarest first.
  const fx = Math.sin(p.aimYaw);
  const fz = Math.cos(p.aimYaw);
  for (const q of all) {
    const dx = q.x - p.pos.x;
    const dz = q.z - p.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist > FRONT_REACH) continue;
    const facing = dist < 0.35 ? 1 : (dx * fx + dz * fz) / dist;
    if (facing < FRONT_COS) continue;
    const score = dist * 0.6 + (1 - facing) * 2;
    if (score < bs) {
      bs = score;
      best = q;
    }
  }
  return best;
}

/** Peak revs of an engine, for its torque on the label: bike twins rev, diesels lug. */
function peakRpm(litres: number, diesel: boolean): number {
  if (diesel) return 3200;
  return litres < 1 ? 4200 : litres < 3 ? 5200 : 4800;
}

/**
 * The label's lines for a carried thing, the way a mechanic reads it: an engine as size, layout, power, torque and fuel; a
 * wheel by its grip; then how worn it is.
 */
export function lookLines(c: Carried): InspectLine[] {
  if (c.kind !== 'part') return inspectLines(c);
  const d = partDef(c.item.id);
  const pct = Math.round(c.item.cond * 100);
  const cond: InspectLine = { text: `${pct} %`, css: pct < 35 ? '#ff8a6a' : pct < 70 ? '#ffe2a0' : '#d8f4cc' };
  if (d.engine && !d.empty) {
    const e = d.engine;
    const hp = Math.round(e.kw * 1.341);
    const nm = Math.round((e.kw * 1000) / ((2 * Math.PI * peakRpm(e.litres, e.fuel === 'diesel')) / 60));
    const size = e.litres < 1 ? `${Math.round(e.litres * 1000)}CC` : `${e.litres.toFixed(1)}L`;
    const fuel = e.fuel === 'diesel' ? 'DIESEL' : 'GASOLINE';
    const burn = Math.max(0.1, e.litres * (e.fuel === 'diesel' ? 0.8 : 1)).toFixed(1);
    return [{ text: `${size} ${e.layout ?? ''} ${hp}HP ${nm}NM ${fuel}`.replace(/\s+/g, ' ') }, cond, { text: `Fuel consumption: ${burn}` }];
  }
  if (d.slot === 'wheels' && !d.empty) {
    const grip = (0.9 + (d.stats.grip ?? 0)).toFixed(1);
    return [{ text: `${d.name} / Grip: ${grip}` }, cond];
  }
  return partInspect(c.item);
}

/**
 * The label for what is held or looked at, and the buttons that do something with it, for the HUD. `attach` is true when
 * holding interact now would bolt what is held onto the mount in front of you.
 */
export function lookTick(p: Player, attach = false, detach = false) {
  p.lookInfo = null;
  p.handHints = [];
  if (p.state !== 'foot') return;
  const slot = p.ctx.input.slots[p.index] ?? null;
  const key = (name: string) => promptLabel(slot, name).toUpperCase();
  const mouse = slot?.kind === 'kb' && slot.set === 1;
  const c = p.carry;
  if (c) {
    p.lookInfo = { lines: lookLines(c) };
    const hints: HandHint[] = [{ key: key('RT'), text: 'Release' }];
    // Keys alone have no aim of their own unless one is bound; the mouse throws with its aim button.
    const canThrow = slot?.kind !== 'kb' || live.mouseLocked || !!live.bindings.kb[slot.set - 1]?.aim;
    if (canThrow) hints.push({ key: key('LT'), text: 'Throw' });
    hints.push({ key: key('LB'), text: 'Rotate' });
    if (mouse) hints.push({ key: 'SCROLL', text: 'Move' });
    if (attach) hints.push({ key: key('A'), text: c.kind === 'part' ? 'Attach' : 'Pour in' });
    if (c.kind === 'food') hints.push({ key: eatKey(p), text: 'Eat' });
    hints.push({ key: key('X'), text: 'Stow' });
    p.handHints = hints;
    return;
  }
  if (detach) p.handHints.push({ key: key('A'), text: 'Detach' });
  // Someone lying there (Nar on his pallet) is named first when the crosshair or your front is on him.
  const who = lookedAtBody(p);
  if (who) {
    p.lookInfo = { lines: who.lines };
    if (who.act) p.handHints.push({ key: key('A'), text: who.act });
    return;
  }
  const q = lookedAt(p);
  if (q) {
    p.lookInfo = { lines: lookLines(q.carried), id: q.id };
    p.handHints = [{ key: key('A'), text: 'Grab' }];
    if (q.carried.kind === 'food') p.handHints.push({ key: eatKey(p), text: 'Eat' });
    return;
  }
  if (lizardInReach(p)) {
    p.lookInfo = { lines: foodLines('lizard') };
    p.handHints = [{ key: key('A'), text: 'Grab' }];
  }
}

/** Distance from point (px, py, pz) to the segment a-b. */
function segDist(px: number, py: number, pz: number, a: [number, number, number], b: [number, number, number]): number {
  const ex = b[0] - a[0];
  const ey = b[1] - a[1];
  const ez = b[2] - a[2];
  const l2 = ex * ex + ey * ey + ez * ez || 1;
  const t = Math.max(0, Math.min(1, ((px - a[0]) * ex + (py - a[1]) * ey + (pz - a[2]) * ez) / l2));
  return Math.hypot(px - a[0] - ex * t, py - a[1] - ey * t, pz - a[2] - ez * t);
}

/**
 * The person or thing that cannot be lifted (`Ctx.lookables`) that you are looking at: the aim line passing through its
 * capsule within reach, or, with the crosshair on nothing, it lying right in front of you.
 */
function lookedAtBody(p: Player) {
  const list = p.ctx.lookables;
  if (!list?.length) return null;
  const { o, d } = aimRay(p);
  for (const l of list) {
    // March the aim line through the reach in short steps: a body is big, a few centimetres either way does not matter.
    for (let t = 0; t < LOOK_REACH + 6; t += 0.08) {
      const x = o.x + d.x * t;
      const y = o.y + d.y * t;
      const z = o.z + d.z * t;
      if (Math.hypot(x - p.pos.x, z - p.pos.z) > LOOK_REACH) continue;
      if (segDist(x, y, z, l.a, l.b) < l.r + 0.12) return l;
    }
  }
  const fx = Math.sin(p.aimYaw);
  const fz = Math.cos(p.aimYaw);
  for (const l of list) {
    const mx = (l.a[0] + l.b[0]) / 2;
    const mz = (l.a[2] + l.b[2]) / 2;
    const near = segDist(p.pos.x, l.a[1], p.pos.z, l.a, l.b);
    const dx = mx - p.pos.x;
    const dz = mz - p.pos.z;
    const dist = Math.hypot(dx, dz) || 1;
    if (near < FRONT_REACH && (dx * fx + dz * fz) / dist > FRONT_COS - 0.15) return l;
  }
  return null;
}

/** How close a lizard has to be to your hands to snatch at it. */
const LIZARD_REACH = 1.9;

/** The lizard in front of you, in reach of a snatch, if there is one. */
function lizardInReach(p: Player) {
  const life = p.ctx.life;
  if (!life || p.state !== 'foot') return null;
  const hx = p.pos.x + Math.sin(p.aimYaw) * 0.6;
  const hz = p.pos.z + Math.cos(p.aimYaw) * 0.6;
  return life.lizardNear(hx, hz, LIZARD_REACH);
}

/**
 * Empty hands, a lizard on the ground in front of you: a quick hold snatches at it. One basking holds still long enough to be
 * caught most times; one already darting off usually gets away. Caught, it is something to eat in your hand.
 */
export function lizardCandidate(p: Player): Cand | null {
  const c = lizardInReach(p);
  if (!c || p.carry) return null;
  return {
    kind: 'snatch',
    prompt: 'Grab the lizard',
    dur: 0.3,
    target: c,
    ok: true,
    label: 'snatch',
    noise: 2,
    run: () => {
      const life = p.ctx.life;
      const still = c.state === 0;
      const near = Math.hypot(c.x - p.pos.x, c.z - p.pos.z) < LIZARD_REACH + 0.6;
      if (!life || !near || Math.random() > (still ? 0.85 : 0.35) || !life.catchLizard(c)) {
        p.note('It got away', 'info');
        return;
      }
      p.carry = { kind: 'food', food: 'lizard' };
      p.ctx.audio.play('pickup', p.pos.x, p.pos.z, 0.4);
      p.note('Got it: a lizard. Eat it, or keep it for later', 'good');
    },
  };
}

/** The key that eats, as this seat has it. */
function eatKey(p: Player): string {
  const slot = p.ctx.input.slots[p.index] ?? null;
  if (slot?.kind === 'kb') {
    const code = live.bindings.kb[slot.set - 1]?.eat;
    if (code) return keyLabel(code).toUpperCase();
  }
  return promptLabel(slot, 'Down').toUpperCase();
}

/** Eat what is in your hands, or what lies where you are looking. Returns true when something was eaten. */
export function eatCarried(p: Player): boolean {
  const ctx = p.ctx;
  let c = p.carry;
  let fromGround: string | null = null;
  if (!c || c.kind !== 'food') {
    if (c) return false;
    const q = lookedAt(p);
    if (!q || q.carried.kind !== 'food') return false;
    fromGround = q.id;
    c = q.carried;
  }
  if (c.kind !== 'food') return false;
  if (fromGround && !ctx.loose?.take(fromGround)) return false;
  const f = FOODS[c.food];
  const needs = p.needs;
  needs.food = Math.min(1, needs.food + f.hunger / 100);
  p.heal(f.health);
  if (!fromGround) p.carry = null;
  ctx.audio.play('munch', p.pos.x, p.pos.z, 0.6);
  p.note(`You eat the ${f.name.toLowerCase()}: hunger -${f.hunger}, health +${f.health}`, 'good');
  return true;
}

// ------------------------------------------------------------------------------------------------ drawing

/** Is the held thing drawn out in front (true), or in the arms (false: a hand job at a mount has it)? */
export function holdFloats(p: Player): boolean {
  return !!p.carry && p.state === 'foot' && !p.action && !p.ctx.work.holding(p.index);
}

/** Pose the floating model where it is held, every drawn frame. `x, y, z` are the player's drawn feet. */
export function holdFrame(p: Player, x: number, y: number, z: number) {
  const h = p.hold;
  const show = holdFloats(p);
  const c = p.carry;
  if (!show || !c) {
    if (h.model) h.model.visible = false;
    return;
  }
  const key = carryModelKey(c);
  if (!h.model || h.model.userData.key !== key) {
    h.model?.removeFromParent();
    h.model = makeCarryModel(key);
    h.model.userData.key = key;
    h.model.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
    });
    p.ctx.root.add(h.model);
  }
  h.model.visible = true;
  // Held from its middle: the models stand on their base, so drop them by about half their height.
  h.model.position.set(h.at.x + (x - p.pos.x), h.at.y + (y - p.pos.y) - 0.18, h.at.z + (z - p.pos.z));
  h.model.rotation.set(0, p.aimYaw + h.yaw, 0);
}

/** Take the floating model out of the world (the player is going away). */
export function disposeHold(p: Player) {
  p.hold.model?.removeFromParent();
  p.hold.model = null;
}

export type { InspectLine };
