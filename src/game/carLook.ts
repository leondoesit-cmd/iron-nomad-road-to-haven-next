import * as THREE from 'three';
import { PARTS, isGlassSlot, isInteriorSlot, mountsFor, partDef, type PartSlot, type VehicleDef } from '../data';
import { socketsOf, type Anchor, type Socket } from '../render/sockets';
import { accessPointsOf } from '../render/accessPoints';
import { bindHighlightViews, type GhostAnchor } from '../render/workFx';
import { panelsOf, spotName } from '../sim/access';
import { currentCond, idInSlot, tyreIdAt, factoryTyreId } from '../sim/garage';
import { factoryIdFor } from '../sim/drivetrain';
import { slotsOf, type PartItem } from '../sim/parts';
import { condIn, condInfo, markCss, markOf, partFacts, showsWear, swapDeltas, wheelName, type CondInfo, type Delta, type Fact } from '../ui/carStats';
import { needHints, roomOf, storageEntries, storageOf, type NeedHint, type StorageEntry } from './storage';
import { promptLabel } from '../input/input';
import { keyLabel, live } from '../input/bindings';
import type { Cand, Player } from './player';
import type { Vehicle } from './vehicle';

/**
 * Look at a car to read it. On foot, with free hands or any tool, put the crosshair on a part of a vehicle within reach and it
 * is picked out (corner brackets round it, in your own view only) and a small card beside the crosshair says what it is: its
 * name and mark, how worn, its key numbers with units, what it does for this car against the factory part or against the best
 * spare aboard, and what the buttons do with it. From further off, or with the crosshair on the body but no part, the HUD's
 * car card shows the whole car instead. Holding the sheet button turns either into the full breakdown (`ui/breakdown.ts`).
 *
 * The aim is a ray from the view's camera through the crosshair, tested against each mount's boxes (`render/sockets.ts`) in
 * the car's own frame. Mounts behind something shut (an engine under its bonnet, a seat behind its door) are not seen until
 * it is opened; the gearbox and exhaust are read from a crouch.
 */

/** How far a part can be from your chest and still be read, and how far the whole car can be glanced at. */
export const LOOK_REACH = 3.5;
export const GLANCE_REACH = 8;

/** What the crosshair is on: a mount of a car (the slot, which anchor: the wheel number for a tyre), or the boot. */
export interface LookPart {
  slot: PartSlot | 'boot';
  index: number;
  label: string;
  /** The boxes to bracket, chassis frame. */
  boxes: Anchor[];
}

/** A card's worth of words, rebuilt a few times a second while the crosshair stays on the same thing. */
export interface CardModel {
  title: string;
  name: string;
  mark: string;
  css: string;
  cond: CondInfo | null;
  facts: Fact[];
  /** What it does for this car: against the factory part, or the best spare aboard ("Mud-Terrain Tyre in the boot"). */
  vs: { head: string; items: Delta[] } | null;
  /** Further lines: what is under a bonnet, the brakes and springs at a wheel, what a boot holds. */
  more: string[];
  hint: NeedHint | null;
  actions: { key: string; text: string; ok: boolean }[];
}

export interface CarLook {
  v: Vehicle;
  part: LookPart | null;
  /** Seconds the crosshair has stayed on this target. */
  t: number;
  key: string;
  card: CardModel | null;
  cardT: number;
  /** The car's storage rows, kept a second at a time for the card's comparisons. */
  rows: StorageEntry[] | null;
  rowsT: number;
  /** The brackets' boxes in the world, reused tick to tick. */
  hl: GhostAnchor[];
  /**
   * Where the part is on this player's view, in normalised device coordinates (-1 to 1, y up): the card sits beside it, never
   * over it. Null when it is behind the camera.
   */
  screen: { x0: number; x1: number; y0: number; y1: number } | null;
}

const looks = new WeakMap<Player, CarLook>();

/** What a player is reading on a car right now, if anything. */
export function carLookOf(p: Player): CarLook | null {
  return looks.get(p) ?? null;
}

// ------------------------------------------------------------------------------------------------ the boxes

interface DefBoxes {
  socks: Socket[];
  /** The boot (or bed, or panniers) as a box at its access point: reading it shows what the car carries. */
  boot: Anchor | null;
  /** The whole body, for a glance. */
  body: Anchor;
}

const boxCache = new WeakMap<VehicleDef, DefBoxes>();

function boxesOf(def: VehicleDef): DefBoxes {
  let b = boxCache.get(def);
  if (b) return b;
  const socks = socketsOf(def);
  const min = new THREE.Vector3(-def.width / 2, Infinity, -def.length / 2);
  const max = new THREE.Vector3(def.width / 2, -Infinity, def.length / 2);
  for (const s of socks)
    for (const a of s.anchors) {
      min.y = Math.min(min.y, a.y - a.sy / 2);
      max.y = Math.max(max.y, a.y + a.sy / 2);
    }
  if (!Number.isFinite(min.y)) {
    min.y = -0.5;
    max.y = 1;
  }
  const pt = accessPointsOf(def).find((q) => q.spot === 'trunk');
  const boot = pt ? { x: pt.x, y: pt.y - 0.12, z: pt.z + 0.3, sx: Math.min(1.3, def.width * 0.62), sy: 0.42, sz: 0.62 } : null;
  const body: Anchor = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2, sx: max.x - min.x, sy: max.y - min.y, sz: max.z - min.z };
  b = { socks, boot, body };
  boxCache.set(def, b);
  return b;
}

const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _lo = new THREE.Vector3();
const _ld = new THREE.Vector3();
const _hit = new THREE.Vector3();

/** One slab of the ray-box test: narrows [lo, hi] to where the ray is between the two faces on one axis. */
const _span: [number, number] = [0, 0];
function slab(o: number, d: number, c: number, h: number): boolean {
  if (Math.abs(d) < 1e-9) return o >= c - h && o <= c + h;
  let ta = (c - h - o) / d;
  let tb = (c + h - o) / d;
  if (ta > tb) {
    const t = ta;
    ta = tb;
    tb = t;
  }
  if (ta > _span[0]) _span[0] = ta;
  if (tb < _span[1]) _span[1] = tb;
  return _span[0] <= _span[1];
}

/** Entry distance along a ray (chassis frame) into a box, or null when it misses. 0 when the origin is inside. */
function rayBox(o: THREE.Vector3, d: THREE.Vector3, a: Anchor, pad = 0): number | null {
  _span[0] = 0;
  _span[1] = Infinity;
  if (!slab(o.x, d.x, a.x, a.sx / 2 + pad) || !slab(o.y, d.y, a.y, a.sy / 2 + pad) || !slab(o.z, d.z, a.z, a.sz / 2 + pad)) return null;
  return _span[0];
}

/** The view's aim line: from the camera through the crosshair (or the eyes, when there is no camera). */
function aimRay(p: Player) {
  const cam = p.ctx.R.views[p.index]?.camera;
  if (!cam) {
    _o.set(p.pos.x, p.pos.y + 1.6, p.pos.z);
    _d.set(Math.sin(p.aimYaw) * Math.cos(p.aimPitch), Math.sin(p.aimPitch), Math.cos(p.aimYaw) * Math.cos(p.aimPitch)).normalize();
    return;
  }
  cam.updateMatrixWorld();
  _o.copy(cam.position);
  cam.getWorldDirection(_d);
}

/** Can this vehicle be read? Every car that is not a burnt-out wreck, a crew car or a raider still in the fight. */
const readable = (v: Vehicle) => !!v.build && !v.wreck && v.kind !== 'crew' && !v.hostile && v.def.physics.kind !== 'boat';

/** Slots under the body: seen only through something open. */
const UNDER: PartSlot[] = ['gearbox', 'exhaust'];
/** Mounts read as part of a wheel (the brakes and springs sit behind it). */
const BEHIND_WHEEL: PartSlot[] = ['suspension', 'brakes'];

/** Is this mount out of sight right now: under a shut bonnet, behind a shut door, under the car while standing? */
function hidden(p: Player, v: Vehicle, slot: PartSlot, index: number): boolean {
  const open = v.panelOpen();
  if (BEHIND_WHEEL.includes(slot)) return true;
  if (UNDER.includes(slot)) return !p.crouch;
  if (slot === 'engine' || slot === 'cooling') return !open.hood;
  // A swung-open bonnet or door is no longer where its box is: what is behind it is what you see.
  if (slot === 'hood') return v.hasPanel('hood') && !!v.open.hood;
  if (slot === 'doorL' || slot === 'glassL') return v.hasPanel('doorL') && !!v.open.doorL;
  if (slot === 'doorR' || slot === 'glassR') return v.hasPanel('doorR') && !!v.open.doorR;
  if (slot === 'armor' && slotsOf(v.def).includes('doorL')) return index === 0 ? !!v.open.doorL : !!v.open.doorR;
  if (isInteriorSlot(slot)) {
    // The cabin through an open door (or a frame that has none).
    const doors = panelsOf(v.def).filter((q) => q === 'doorL' || q === 'doorR');
    return doors.length > 0 && !doors.some((q) => open[q]);
  }
  return false;
}

/** The part in a mount right now, or null for an empty one. */
function idAt(v: Vehicle, slot: PartSlot, index: number): string | null {
  const b = v.build!;
  return slot === 'wheels' ? tyreIdAt(b, index) : idInSlot(b, slot);
}

/** Bolt-on mounts: with nothing on them there is nothing there to look at, and the aim goes straight through. */
const BOLT_ON: PartSlot[] = ['armor', 'weapon', 'utility', 'front', 'roof', 'rear', 'side'];

/** A fitted aftermarket part reads before the body panel it sits on; an empty mount after anything real. */
function bias(v: Vehicle, slot: PartSlot, index: number): number {
  const id = idAt(v, slot, index);
  if (!id) return 0.12;
  const d = partDef(id);
  return d.stock ? 0 : -0.06;
}

/** What the crosshair is on: the nearest readable mount within reach, else a car's body within a glance. */
function pick(p: Player): { v: Vehicle; part: LookPart | null } | null {
  aimRay(p);
  const chestY = p.pos.y + 1.1;
  let best: { v: Vehicle; part: LookPart; score: number } | null = null;
  let glance: { v: Vehicle; t: number } | null = null;
  for (const v of p.ctx.vehicles) {
    if (!readable(v)) continue;
    const pos = v.position;
    const far = Math.hypot(pos.x - p.pos.x, pos.z - p.pos.z) - v.def.length / 2;
    if (far > GLANCE_REACH + 3) continue;
    const tr = v.body.body.translation();
    const r = v.body.body.rotation();
    _q.set(r.x, r.y, r.z, r.w).invert();
    _lo.set(_o.x - tr.x, _o.y - tr.y, _o.z - tr.z).applyQuaternion(_q);
    _ld.copy(_d).applyQuaternion(_q);
    const B = boxesOf(v.def);
    const tb = rayBox(_lo, _ld, B.body, 0.05);
    if (tb === null) continue;
    _hit.copy(_d).multiplyScalar(tb).add(_o);
    const bodyDist = Math.hypot(_hit.x - p.pos.x, _hit.z - p.pos.z);
    if (bodyDist <= GLANCE_REACH && (!glance || tb < glance.t)) glance = { v, t: tb };
    if (far > LOOK_REACH + 0.5) continue;
    const consider = (slot: PartSlot | 'boot', index: number, a: Anchor, boxes: Anchor[], label: string, extra: number) => {
      const t = rayBox(_lo, _ld, a, 0.02);
      if (t === null) return;
      _hit.copy(_d).multiplyScalar(t).add(_o);
      if (Math.hypot(_hit.x - p.pos.x, _hit.y - chestY, _hit.z - p.pos.z) > LOOK_REACH) return;
      const score = t + extra;
      if (!best || score < best.score) best = { v, part: { slot, index, label, boxes }, score };
    };
    for (const s of B.socks) {
      s.anchors.forEach((a, i) => {
        const slot = s.slot;
        if (hidden(p, v, slot, i)) return;
        if (BOLT_ON.includes(slot) && !idAt(v, slot, i)) return;
        if (slot === 'wheels') consider(slot, i, a, [a], `${wheelName(i, s.anchors.length)} wheel`, bias(v, slot, i));
        else consider(slot, i, a, s.anchors, s.label, bias(v, slot, 0) + (isGlassSlot(slot) ? 0.02 : 0));
      });
    }
    if (B.boot) consider('boot', 0, B.boot, [B.boot], cap(spotName(v.def, 'trunk')), 0.08);
  }
  const found = best as { v: Vehicle; part: LookPart; score: number } | null;
  if (found) return { v: found.v, part: found.part };
  return glance ? { v: glance.v, part: null } : null;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ------------------------------------------------------------------------------------------------ every tick

/**
 * Every tick on foot: find what the crosshair is on, bracket it, and keep its card fresh. `cand` is what holding the interact
 * button would do this tick, so the card can show it when it is about the same car.
 */
export function carLookTick(p: Player, cand: Cand | null) {
  const busy = p.state !== 'foot' || !!p.carry || !!storageOf(p) || !!p.lookInfo || p.ads > 0.4 || p.buildMode;
  const hit = busy ? null : pick(p);
  if (!hit) {
    looks.delete(p);
    return;
  }
  const key = `${hit.v.id}:${hit.part ? `${hit.part.slot}:${hit.part.index}` : 'body'}`;
  let L = looks.get(p);
  if (!L || L.key !== key) {
    const rows = L && L.v === hit.v ? L.rows : null;
    const rowsT = L && L.v === hit.v ? L.rowsT : 0;
    const hl: GhostAnchor[] = (hit.part?.boxes ?? []).map((a) => ({ pos: new THREE.Vector3(), quat: new THREE.Quaternion(), size: [a.sx, a.sy, a.sz] as [number, number, number] }));
    L = { v: hit.v, part: hit.part, t: 0, key, card: null, cardT: 0, rows, rowsT, hl, screen: null };
    looks.set(p, L);
  }
  const dt = 1 / 60;
  L.t += dt;
  L.cardT -= dt;
  L.rowsT -= dt;
  if (!L.rows || L.rowsT <= 0) {
    L.rows = hit.v.faction === 'convoy' ? storageEntries(hit.v) : [];
    L.rowsT = 1;
  }
  if (L.part) {
    const v = L.v;
    const r = v.body.body.rotation();
    L.part.boxes.forEach((a, i) => {
      const h = L!.hl[i];
      const [x, y, z] = v.body.toWorld(a.x, a.y, a.z);
      h.pos.set(x, y, z);
      h.quat.set(r.x, r.y, r.z, r.w);
    });
    bindHighlightViews(p.ctx.R.views);
    p.ctx.work.highlight(p.index, L.hl, 'idle');
    L.screen = screenBounds(p, L);
    if (!L.card || L.cardT <= 0) {
      L.card = cardFor(p, L, cand);
      L.cardT = 0.25;
    } else L.card.actions = actionsFor(p, L, cand);
  } else L.card = null;
}

const _c = new THREE.Vector3();

/** The part's boxes as they fall on the player's view: the bounds of their corners, projected. */
function screenBounds(p: Player, L: CarLook): CarLook['screen'] {
  const cam = p.ctx.R.views[p.index]?.camera;
  if (!cam || !L.part) return null;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < L.part.boxes.length; i++) {
    const a = L.part.boxes[i];
    const h = L.hl[i];
    for (let k = 0; k < 8; k++) {
      _c.set((k & 1 ? 0.5 : -0.5) * a.sx, (k & 2 ? 0.5 : -0.5) * a.sy, (k & 4 ? 0.5 : -0.5) * a.sz).applyQuaternion(h.quat).add(h.pos).project(cam);
      if (_c.z > 1) continue;
      x0 = Math.min(x0, _c.x);
      x1 = Math.max(x1, _c.x);
      y0 = Math.min(y0, _c.y);
      y1 = Math.max(y1, _c.y);
    }
  }
  return Number.isFinite(x0) ? { x0, x1, y0, y1 } : null;
}

// ------------------------------------------------------------------------------------------------ the card

/** The A-button job when it is about this car, and the X job, as the card's action lines. */
function actionsFor(p: Player, L: CarLook, cand: Cand | null): CardModel['actions'] {
  const v = L.v;
  const out: CardModel['actions'] = [];
  const key = (b: string) => keyName(p, b);
  const aboutCar = candAbout(cand, v, L.part);
  if (cand && aboutCar) out.push({ key: `Hold ${key('A')}`, text: shortPrompt(cand.prompt), ok: cand.ok });
  // What X does here (the storage, or stowing), wherever the prompts have put it.
  const x = p.promptAlt?.button === 'X' ? p.promptAlt : p.prompt?.button === 'X' ? { text: p.prompt.text, ok: true } : null;
  if (x) out.push({ key: key('X'), text: shortPrompt(x.text), ok: x.ok });
  // The wrench takes off what is bolted on: say so when it is on the belt but not in hand.
  const s = L.part?.slot;
  if (s && s !== 'boot' && p.equip !== 'wrench' && p.equip !== 'crowbar' && idAt(v, s, L.part!.index) && !aboutCar) out.push({ key: key('LB'), text: 'Wrench out to unbolt it', ok: true });
  out.push({ key: `Hold ${sheetKey(p)}`, text: 'Details', ok: true });
  return out;
}

/**
 * Is what holding interact would do about the part being read? A job on that very mount (one wheel of four, or all of them
 * for a set of tyres), the panel in front of it (the bonnet over the engine, a door before a seat), or the whole car.
 */
function candAbout(cand: Cand | null, v: Vehicle, part: LookPart | null): boolean {
  if (!cand || !part) return false;
  const t = cand.target;
  if (t === v) return true;
  if (typeof t !== 'string' || !t.startsWith(`${v.id}:`)) return false;
  const [, what, idx] = t.split(':');
  if (part.slot === 'boot') return what === 'trunk';
  if (what === part.slot) return part.slot !== 'wheels' || idx === undefined || Number(idx) === part.index || cand.kind === 'unbolt';
  if (cand.kind === 'panel' || cand.kind === 'cuthood') return ((what === 'hood' || what === 'cuthood') && (part.slot === 'engine' || part.slot === 'cooling' || part.slot === 'hood')) || ((what === 'doorL' || what === 'doorR') && (isInteriorSlot(part.slot) || part.slot === `glass${what.slice(4)}`));
  return false;
}

/** The first clause of a prompt, for a short action line. */
const shortPrompt = (s: string) => s.split('  ·  ')[0];

/** The button name as this seat has it bound. */
function keyName(p: Player, b: string): string {
  return promptLabel(p.ctx.input.slots?.[p.index] ?? null, b);
}

/** The sheet button (held for the breakdown): a key on the keyboard, Back on a pad. */
export function sheetKey(p: Player): string {
  const s = p.ctx.input.slots?.[p.index] ?? null;
  if (s?.kind === 'kb') return keyLabel(live.bindings.kb[s.set - 1]?.sheet);
  return 'Back';
}

/** What is in the mount the card is about: the part (as an item with its live wear) and its catalogue entry. */
function mountItem(v: Vehicle, slot: PartSlot, index: number): { item: PartItem | null; id: string | null; cond: number | null } {
  const b = v.build!;
  const id = idAt(v, slot, index);
  if (!id) return { item: null, id: null, cond: null };
  const fitted = slot === 'wheels' ? b.tyres[index] ?? undefined : b.fit[slot];
  const cond = condIn(slot, fitted, v.health.comp, index, (s) => currentCond(b, s));
  return { item: { uid: fitted?.uid ?? 'x', id, cond: cond ?? 1 }, id, cond };
}

/** The factory part for a mount, as an item: what an aftermarket part is measured against. */
function factoryItem(def: VehicleDef, slot: PartSlot, index: number): PartItem | null {
  const id = slot === 'wheels' ? factoryTyreId(def, index) : slot === 'engine' ? def.stockEngine : slot === 'cooling' ? def.stockRadiator : factoryIdFor(def, slot);
  return id ? { uid: 'f', id, cond: 1 } : null;
}

function cardFor(p: Player, L: CarLook, cand: Cand | null): CardModel {
  const v = L.v;
  const b = v.build!;
  const part = L.part!;
  const rows = L.rows ?? [];
  const hints = v.faction === 'convoy' ? needHints(v, rows, keyName(p, 'A')) : [];
  if (part.slot === 'boot') {
    const room = roomOf(v, rows);
    const parts = rows.filter((e) => e.kind === 'part');
    const more = parts.slice(0, 3).map((e) => `${e.name}${e.verdict?.junk ? ' · junk' : e.verdict?.fitsHere && (e.verdict.gain ?? 0) > 0.03 ? ` · +${Math.round(e.verdict.gain! * 100)}% ${e.verdict.word}` : ''}`);
    if (parts.length > 3) more.push(`+${parts.length - 3} more`);
    const fluids = rows.filter((e) => e.kind !== 'part' && e.kind !== 'cargo').map((e) => `${e.name} ${e.amount}`);
    if (fluids.length) more.push(fluids.join(' · '));
    return {
      title: part.label,
      name: v.faction === 'convoy' ? `${parts.length} spare${parts.length === 1 ? '' : 's'} inside` : 'Not yours yet',
      mark: '',
      css: '#e6dcc0',
      cond: null,
      facts: [
        { label: 'Space', text: `${room.used}/${room.max} inside` },
        ...(room.outside ? [{ label: 'Outside', text: `${room.outside} item${room.outside === 1 ? '' : 's'}` }] : []),
        ...(room.kg > 0 ? [{ label: 'Load', text: `≈${Math.round(room.kg)} kg` }] : []),
      ],
      vs: null,
      more,
      hint: hints.find((h) => h.tone === 'good') ?? hints[0] ?? null,
      actions: actionsFor(p, L, cand),
    };
  }
  const slot = part.slot;
  const m = mountItem(v, slot, part.index);
  const d = m.id ? partDef(m.id) : null;
  const facts = d ? partFacts(d).slice(0, 4) : [{ label: 'Empty', text: 'nothing in this mount', tone: 'bad' as const }];
  const more: string[] = [];
  if (slot === 'hood' && !v.open.hood) {
    const e = idInSlot(b, 'engine');
    if (e) more.push(`Under it: ${partDef(e).name} · ${partFacts(partDef(e))[0]?.text ?? ''}`);
    else more.push('Under it: an empty engine bay');
  }
  if (slot === 'wheels') {
    for (const s of BEHIND_WHEEL) {
      if (!slotsOf(v.def).includes(s)) continue;
      const id = idInSlot(b, s);
      more.push(`${PARTS.labels[s]}: ${id ? `${partDef(id).name} · ${partFacts(partDef(id))[0]?.text ?? ''}` : 'none'}`);
    }
  }
  // What it does for the car: an aftermarket part against the factory one; a factory or empty mount against the best spare aboard.
  let vs: CardModel['vs'] = null;
  const at = slot === 'wheels' ? part.index : slot;
  const best = bestSpare(v, rows, slot, part.index);
  if (best && best.gain > 0.01) {
    vs = { head: `${best.entry.name} in the ${best.entry.whereName}`, items: swapDeltas(v.def, b.fit, b.tyres, best.entry.item!, at, 2) };
  } else if (d && !d.stock && m.item) {
    const f = factoryItem(v.def, slot, part.index);
    if (f) {
      const s = swapDeltas(v.def, b.fit, b.tyres, f, at, 3);
      // The factory part's change, turned round: what this one gives over it.
      const items = s.map((x) => ({ text: flip(x.text), good: !x.good, w: x.w }));
      if (items.length) vs = { head: 'Over the factory part', items };
    } else if (slot !== 'wheels') {
      // A bolt-on with no factory part under it: what it adds over a bare mount.
      const bare = { ...b.fit };
      delete bare[slot];
      const items = swapDeltas(v.def, bare, b.tyres, m.item, slot, 3);
      if (items.length) vs = { head: 'What it adds', items };
    }
  }
  const hint = hints.find((h) => h.slot && mountsFor(h.slot).includes(slot)) ?? null;
  return {
    title: part.label,
    name: d ? d.name : 'Empty mount',
    mark: d ? markOf(d) : '',
    css: d ? markCss(d) : '#8a8172',
    cond: d && showsWear(d) && m.cond !== null ? condInfo(m.cond, d) : null,
    facts,
    vs,
    more,
    hint,
    actions: actionsFor(p, L, cand),
  };
}

/** "+8% grip" ⇄ "−8% grip": a change seen from the other side. */
function flip(text: string): string {
  return text.replace(/^([+−])/, (s) => (s === '+' ? '−' : '+'));
}

/** The spare aboard (in this car, or with no car of its own) that would do most for this mount. */
function bestSpare(v: Vehicle, rows: StorageEntry[], slot: PartSlot, index: number): { entry: StorageEntry; gain: number } | null {
  let best: { entry: StorageEntry; gain: number } | null = null;
  for (const e of rows) {
    if (!e.item || !e.slot || !e.verdict?.fitsHere) continue;
    if (!mountsFor(e.slot).includes(slot)) continue;
    // A tyre's verdict is against the worst wheel; at a given wheel, the gain is against that one.
    const g = e.verdict.gain ?? 0;
    if (slot === 'wheels' && index >= 0 && !tyreIdAt(v.build!, index)) {
      if (!best || g > best.gain) best = { entry: e, gain: Math.max(g, 0.5) };
      continue;
    }
    if (!best || g > best.gain) best = { entry: e, gain: g };
  }
  return best;
}

export type { Delta, Fact };
