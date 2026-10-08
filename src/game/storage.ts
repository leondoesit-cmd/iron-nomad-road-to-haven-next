import * as THREE from 'three';
import { PARTS, chassisDef, gearDef, isGlassSlot, isInteriorSlot, mountsFor, partDef, type FuelType, type PartSlot } from '../data';
import { Btn, NAV, newIntent, wasPressed, type PlayerIntent } from '../input/intents';
import { FUEL_CAN, carriedName, carryModelKey, planFit, type Carried } from '../sim/carry';
import { cargoName, sizeOfPart, surfacesOf, ZONE_NAME, type CargoEntry, type Zone } from '../sim/cargo';
import { idInSlot, installPart, tyreFits, type VehicleBuild } from '../sim/garage';
import { partName, scrapValue, slotsOf, type PartItem } from '../sim/parts';
import { reserveOf, takeReserve, planPour } from '../sim/fuel';
import { OIL_CAN } from '../sim/oil';
import { WATER_CAN } from '../sim/fluids';
import { panelOfSpot, workFor, type Panel, type Spot } from '../sim/access';
import { socketFor } from '../render/sockets';
import { MK_CSS, bindHighlightViews } from '../render/workFx';
import { accessPointsOf } from '../render/accessPoints';
import { COMPONENT_GROUPS, carData, judgeSpare, markCss, markOf, showsWear, tyresFor, type OwnCar, type Verdict } from '../ui/carStats';
import { aLabel, anchorWorld, placeFor, pointPos } from './access';
import { loadPlace } from './hauling';
import type { Player } from './player';
import type { Vehicle } from './vehicle';

/**
 * A car's storage, the way a survival game does a container: walk up to the boot (or a back door, the bed, the roof) with
 * your hands free and press X. A small panel opens in your own half of the screen, beside the car, without stopping the game
 * or taking the other player's controls: everything the car carries (the spares in the boot, the reserve cans, the load on the
 * roof or in the bed) with what each one is, what it fits and whether it beats what is fitted. Up and down choose (the item is
 * picked out in the boot itself), A takes it into your hands (walk it to its mount), X fits it straight on when you have a
 * wrench and it goes on this car, left and right sort, B closes. A boot lid opens by itself as you reach in.
 *
 * The panel is drawn by `ui/trunk.ts`; the numbers and verdicts come from `ui/carStats.ts`.
 */

export type EntryKind = 'part' | 'fuel' | 'diesel' | 'oil' | 'water' | 'cargo';
export type SortMode = 'slot' | 'value';

export interface StorageEntry {
  /** Stable while the item stays: `p:<uid>`, `fuel`, `diesel`, `oil`, `water`, `c:<cargo id>`. */
  key: string;
  kind: EntryKind;
  /** Inside the car, or which outside place. */
  where: 'inside' | Zone;
  whereName: string;
  item?: PartItem;
  cargo?: CargoEntry;
  name: string;
  /** "Mk2", "Factory", or the amount for a can. */
  mark: string;
  css: string;
  slot?: PartSlot;
  /** What it is for: "Tyres", "Engine", "Fuel". */
  what: string;
  /** Group heading when sorted by slot. */
  group: string;
  cond: number | null;
  /** "12.0 FU", "1.5 L". */
  amount?: string;
  /** Footprint units it takes, and its weight when known (or estimated from its size). */
  units: number;
  kg: number;
  value: number;
  verdict?: Verdict;
  /** Held by a holder (outside). */
  secure?: boolean;
  /** Where it lies, in the world (null when it has no spot of its own). */
  spot: THREE.Vector3 | null;
}

/** Rough weight by footprint for parts the catalogue gives no weight for: a can, a door, an armour sheet. */
const SIZE_KG: Record<number, number> = { 1: 6, 2: 16, 4: 34 };
export const itemKg = (it: PartItem) => carData.partMass(partDef(it.id)) ?? SIZE_KG[sizeOfPart(it.id)] ?? 15;

/** The groups a stowed part sorts under, by its slot. */
function groupOf(slot: PartSlot): string {
  return COMPONENT_GROUPS.find((g) => g.slots.some((s) => mountsFor(slot).includes(s) || s === slot))?.name ?? 'Parts';
}

// ------------------------------------------------------------------------------------------------ the convoy's cars

/** A car's name for the lists: whose ride it is, or just what it is. */
export function carName(ctx: Player['ctx'], b: VehicleBuild): string {
  const c = ctx.campaign;
  const def = chassisOf(b);
  for (let i = 0; i < c.count; i++) if (c.players[i].vehicle === b.uid) return `${c.players[i].name}'s ${def.name}`;
  return def.name;
}

const chassisOf = (b: VehicleBuild) => chassisDef(b.chassis);

/** Every car the convoy owns, for judging spares, with the live wear of the ones on the road. */
export function ownCars(ctx: Player['ctx'], extra?: Vehicle | null): OwnCar[] {
  const live = new Map<string, Vehicle>();
  for (const v of ctx.vehicles) if (v.build) live.set(v.build.uid, v);
  const out: OwnCar[] = ctx.campaign.garage.map((b) => {
    const v = live.get(b.uid);
    return { uid: b.uid, name: carName(ctx, b), def: chassisOf(b), fit: b.fit, tyres: b.tyres, tyreCond: v ? v.health.comp.tires : b.comp.tires };
  });
  if (extra?.build && !out.some((c) => c.uid === extra.build!.uid)) out.push(carOf(ctx, extra));
  return out;
}

/** One vehicle as a car to judge against. */
export function carOf(ctx: Player['ctx'], v: Vehicle): OwnCar {
  const b = v.build!;
  return { uid: b.uid, name: carName(ctx, b), def: v.def, fit: b.fit, tyres: b.tyres, tyreCond: v.health.comp.tires };
}

// ------------------------------------------------------------------------------------------------ the list

/** Everything a car carries, as rows: its spares inside, the convoy's reserve cans, then what rides outside. */
export function storageEntries(v: Vehicle): StorageEntry[] {
  const ctx = v.ctx;
  const camp = ctx.campaign;
  const out: StorageEntry[] = [];
  if (!v.build) return out;
  const here = carOf(ctx, v);
  const cars = ownCars(ctx, v);
  const inside = v.insideRoom().name;
  const spots = v.deckSpots();
  const spotOf = (pred: (s: (typeof spots)[number]) => boolean) => spots.find(pred)?.world ?? null;
  for (const it of v.stowedParts()) {
    const d = partDef(it.id);
    out.push({
      key: `p:${it.uid}`,
      kind: 'part',
      where: 'inside',
      whereName: inside,
      item: it,
      name: d.name,
      mark: markOf(d),
      css: markCss(d),
      slot: d.slot,
      what: PARTS.labels[d.slot],
      group: groupOf(d.slot),
      cond: showsWear(d) ? it.cond : null,
      units: sizeOfPart(it.id),
      kg: itemKg(it),
      value: scrapValue(it),
      verdict: judgeSpare(it, here, cars),
      spot: spotOf((s) => s.uid === it.uid),
    });
  }
  const fluid = (key: 'fuel' | 'diesel' | 'oil' | 'water', name: string, amount: string, css: string) =>
    out.push({ key, kind: key, where: 'inside', whereName: inside, name, mark: amount, css, what: key === 'oil' ? 'Engine oil' : key === 'water' ? 'Radiator water' : 'Fuel', group: 'Reserves', cond: null, amount, units: 1, kg: 0, value: 0, spot: spotOf((s) => s.kind === key) });
  const petrol = reserveOf(camp, 'petrol');
  const diesel = reserveOf(camp, 'diesel');
  if (petrol >= 0.1) fluid('fuel', 'Petrol cans', `${petrol.toFixed(1)} FU`, '#ff9a7a');
  if (diesel >= 0.1) fluid('diesel', 'Diesel cans', `${diesel.toFixed(1)} FU`, '#f0d050');
  if (camp.items.oil > 0.02) fluid('oil', 'Engine oil', `${(camp.items.oil * 3).toFixed(1)} L`, '#e6dcc0');
  if (camp.items.water > 0.2) fluid('water', 'Water cans', `${camp.items.water.toFixed(0)} L`, '#8ecbff');
  const surf = surfacesOf(v.def, v.build.fit);
  for (const e of v.cargoRig.entries) {
    const c = e.c;
    const s = surf.find((q) => q.zone === e.zone);
    const where = s?.name ?? ZONE_NAME[e.zone];
    const part = c.kind === 'part' ? c.item : null;
    const d = part ? partDef(part.id) : null;
    out.push({
      key: `c:${e.id}`,
      kind: 'cargo',
      where: e.zone,
      whereName: where,
      cargo: e,
      item: part ?? undefined,
      name: d ? d.name : cargoName(c),
      mark: d ? markOf(d) : c.kind === 'fuel' || c.kind === 'water' ? `${c.amount.toFixed(1)} ${c.kind === 'fuel' ? 'FU' : 'L'}` : '',
      css: d ? markCss(d) : '#e6dcc0',
      slot: d?.slot,
      what: d ? PARTS.labels[d.slot] : carriedName(c),
      group: `On the ${where}`,
      cond: d && showsWear(d) && part ? part.cond : null,
      units: part ? sizeOfPart(part.id) : 1,
      kg: part ? itemKg(part) : 8,
      value: part ? scrapValue(part) : 0,
      verdict: part ? judgeSpare(part, here, cars) : undefined,
      secure: v.cargoRig.isSecure(e),
      spot: v.cargoRig.worldOf(e),
    });
  }
  return out;
}

/** Slot order for sorting: the garage's groups, then the reserves, then what rides outside. */
const SLOT_ORDER = new Map<string, number>(COMPONENT_GROUPS.flatMap((g) => g.slots).map((s, i) => [s, i]));

/** The rows in the order asked for: by slot (grouped), or by value (best upgrade for this car first, then worth). */
export function sortEntries(list: StorageEntry[], mode: SortMode): StorageEntry[] {
  const rank = (e: StorageEntry) => (e.kind === 'part' ? 0 : e.kind === 'cargo' ? 2 : 1);
  const slotRank = (e: StorageEntry) => (e.slot ? SLOT_ORDER.get(mountsFor(e.slot)[0]) ?? SLOT_ORDER.get(e.slot) ?? 99 : 99);
  const gain = (e: StorageEntry) => (e.verdict?.fitsHere ? e.verdict.gain ?? -1 : -2) + (e.verdict?.junk ? -5 : 0);
  return list
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      if (mode === 'slot') return rank(a.e) - rank(b.e) || (a.e.kind === 'cargo' ? a.e.whereName.localeCompare(b.e.whereName) : 0) || slotRank(a.e) - slotRank(b.e) || a.i - b.i;
      return rank(a.e) === 1 || rank(b.e) === 1 ? rank(a.e) - rank(b.e) : gain(b.e) - gain(a.e) || b.e.value - a.e.value || a.i - b.i;
    })
    .map((x) => x.e);
}

/** How full the inside is: units taken and the most it holds, and roughly how much it all weighs. */
export function roomOf(v: Vehicle, list: StorageEntry[]): { used: number; max: number; kg: number; outside: number; outsideMax: number } {
  const room = v.insideRoom();
  const own = v.build ? v.ctx.campaign.inventory.filter((it) => it.on === v.build!.uid) : [];
  const used = own.reduce((a, it) => a + sizeOfPart(it.id), 0);
  const surf = v.build ? surfacesOf(v.def, v.build.fit) : [];
  return {
    used,
    max: used + room.free,
    kg: list.reduce((a, e) => a + (e.kind === 'part' || e.kind === 'cargo' ? e.kg : 0), 0),
    outside: v.cargoRig.entries.length,
    outsideMax: surf.reduce((a, s) => a + s.units, 0),
  };
}

// ------------------------------------------------------------------------------------------------ smart hints

/** One thing worth saying about a car and what it carries, best first: a flat with a spare aboard, an upgrade in the boot. */
export interface NeedHint {
  text: string;
  tone: 'good' | 'warn' | 'bad';
  /** The slot it is about, so the inspect card shows it at that part. */
  slot?: PartSlot;
}

/**
 * What a mechanic would point out: something broken that a stowed part or the reserve fixes, a spare that is better than
 * what is fitted. Works off the same list the panel shows.
 */
export function needHints(v: Vehicle, list?: StorageEntry[], keyA = 'E'): NeedHint[] {
  if (!v.build || v.wreck) return [];
  const rows = list ?? storageEntries(v);
  const ctx = v.ctx;
  const camp = ctx.campaign;
  const out: NeedHint[] = [];
  const parts = rows.filter((e) => e.item && e.verdict?.fitsHere);
  const spareFor = (slot: PartSlot) => parts.find((e) => e.slot && mountsFor(e.slot).includes(slot));
  const comp = v.health.comp;
  const flats = comp.tires.filter((c) => c <= 0.001).length + v.stats.tyresGone;
  if (flats) {
    const s = spareFor('wheels');
    out.push(s ? { text: `Spare tyre in the ${s.whereName} · hold ${keyA} at the flat wheel`, tone: 'warn', slot: 'wheels' } : { text: `${flats} flat tyre${flats > 1 ? 's' : ''} · no spare aboard`, tone: 'bad', slot: 'wheels' });
  }
  if (v.convoyEngine && v.stats.noEngine) {
    const s = spareFor('engine');
    out.push(s ? { text: `${s.name} in the ${s.whereName} · fit it at the engine bay`, tone: 'warn', slot: 'engine' } : { text: 'No engine in the bay', tone: 'bad', slot: 'engine' });
  }
  if (v.convoyEngine && v.stats.noDrive && spareFor('gearbox')) out.push({ text: `Gearbox in the ${spareFor('gearbox')!.whereName} · fit it from underneath`, tone: 'warn', slot: 'gearbox' });
  for (const panel of ['hood', 'doorL', 'doorR'] as const) {
    if (!slotsOf(v.def).includes(panel) || idInSlot(v.build, panel)) continue;
    const s = spareFor(panel);
    if (s) out.push({ text: `${s.name} in the ${s.whereName} · ${panel === 'hood' ? 'the bonnet is off' : 'a door is off'}`, tone: 'warn', slot: panel });
  }
  if (v.convoyEngine && comp.oil < 0.3) out.push(camp.items.oil > 0.02 ? { text: 'Oil low · a can is in the reserve', tone: 'warn', slot: 'engine' } : { text: 'Oil low · none in the reserve', tone: 'bad', slot: 'engine' });
  if (v.convoyEngine && (comp.coolant ?? 1) < 0.3) out.push(camp.items.water > 0.2 ? { text: 'Radiator low · water is in the reserve', tone: 'warn', slot: 'cooling' } : { text: 'Radiator low · no water aboard', tone: 'bad', slot: 'cooling' });
  if (v.convoyEngine && !v.pedal && v.fuel / Math.max(0.01, v.tankMax) < 0.2) {
    const have = reserveOf(camp, v.fuelType);
    out.push(have >= 0.5 ? { text: `Fuel low · ${have.toFixed(0)} FU of ${v.fuelType} in the cans`, tone: 'warn' } : { text: `Fuel low · no ${v.fuelType} in the cans`, tone: 'bad' });
  }
  // The best upgrade aboard for this car.
  const up = parts.filter((e) => (e.verdict?.gain ?? 0) > 0.04).sort((a, b) => (b.verdict!.gain ?? 0) - (a.verdict!.gain ?? 0))[0];
  if (up) out.push({ text: `Upgrade in the ${up.whereName}: ${up.name} · +${Math.round(up.verdict!.gain! * 100)}% ${up.verdict!.word}`, tone: 'good', slot: up.slot });
  return out;
}

// ------------------------------------------------------------------------------------------------ where it can be opened

/** Vehicles whose storage a player may open: the convoy's own, and abandoned ones (opening it claims it, as driving would). */
export const canStore = (v: Vehicle) => !!v.build && !v.wreck && v.kind !== 'crew' && (v.faction === 'convoy' || v.faction === 'neutral') && v.def.physics.kind !== 'boat';

/** The car a player standing here would open the storage of with X: at its boot, a back door, its bed, roof, rack or cage. */
export function storageTarget(p: Player): Vehicle | null {
  if (p.carry || p.state !== 'foot') return null;
  const v = p.nearestVehicle(3.8, canStore);
  if (!v?.build) return null;
  if (placeFor(p, v, 'stow').at) return v;
  if (loadPlace(p, v)) return v;
  return null;
}

/** X would reload the gun in hand rather than open the car: a gun short of a full magazine, with rounds to put in it. */
function wantsReload(p: Player): boolean {
  if (p.equip !== 'gun') return false;
  return p.mag < p.gun().mag && p.ctx.campaign.ammo > 0;
}

/** The prompt under the main one: X opens the storage, and what is in it. */
export function storagePrompt(p: Player) {
  const v = storageTarget(p);
  if (!v || wantsReload(p) || p.equip === 'wrench' || storageOf(p)) return;
  const own = v.faction === 'convoy' ? v.stowedParts().length + v.cargoRig.entries.length : 0;
  let text = own ? `Storage · ${own} item${own > 1 ? 's' : ''} in the ${v.def.name}` : `Storage · the ${v.def.name}`;
  // At the roof, the bed or a rack (not a way inside): name what rides there, and whether it is held.
  const out = v.cargoRig.entries;
  if (out.length && !placeFor(p, v, 'stow').at && loadPlace(p, v)) {
    const e = out[0];
    const where = surfacesOf(v.def, v.build!.fit).find((q) => q.zone === e.zone)?.name ?? ZONE_NAME[e.zone];
    text = `Storage · ${carriedName(e.c)} on the ${where}, ${v.cargoRig.isSecure(e) ? 'secure' : 'loose'}${out.length > 1 ? ` (+${out.length - 1} more)` : ''}`;
  }
  if (p.prompt) p.promptAlt = { text, button: 'X', ok: true };
  else p.prompt = { text, progress: -1, button: 'X' };
}

/** X with free hands at a car: open its storage. Returns true when it opened. */
export function storageKey(p: Player): boolean {
  if (wantsReload(p) || p.reloadT > 0) return false;
  const v = storageTarget(p);
  if (!v) return false;
  return openStorage(p, v);
}

// ------------------------------------------------------------------------------------------------ the session

/** What the last pick on each car was, per player, so reopening lands on it. */
const lastPick = new Map<string, string>();
/** How each player last sorted. */
const lastSort: SortMode[] = ['slot', 'slot'];

/** A part being bolted on from the boot: what, where, and how far along. */
interface FitJob {
  item: PartItem;
  mount: PartSlot | number;
  anchor: THREE.Vector3;
  from: THREE.Vector3;
  t: number;
  dur: number;
  name: string;
}

export class StorageSession {
  entries: StorageEntry[] = [];
  sel = 0;
  sort: SortMode;
  /** A line under the list: what just happened, or why it could not. */
  msg = '';
  msgOk = true;
  job: FitJob | null = null;
  /** Seconds to the next rebuild of the list (it follows the reserves and what others take). */
  private refreshT = 0;
  /** The intent the rest of the game sees while the panel has the controls: looking only. */
  readonly masked: PlayerIntent = newIntent();
  /** Bumped whenever what the panel shows changes, so the HUD only redraws then. */
  version = 0;
  private openedAt: number;

  constructor(
    readonly p: Player,
    readonly v: Vehicle,
  ) {
    this.sort = lastSort[p.index];
    this.openedAt = p.ctx.time;
    this.refresh();
    const want = lastPick.get(this.pickKey());
    const at = want ? this.entries.findIndex((e) => e.key === want) : -1;
    // Nothing remembered: start on what this car needs most (a spare for a flat), else the first row.
    if (at >= 0) this.sel = at;
    else {
      const hint = needHints(v, this.entries).find((h) => h.slot);
      const i = hint ? this.entries.findIndex((e) => e.kind === 'part' && e.verdict?.fitsHere && !!e.slot && mountsFor(e.slot).includes(hint.slot!)) : -1;
      this.sel = Math.max(0, i);
    }
  }

  private pickKey() {
    return `${this.p.index}:${this.v.build?.uid ?? this.v.id}`;
  }

  get current(): StorageEntry | null {
    return this.entries[this.sel] ?? null;
  }

  /** Rebuild the rows, keeping the cursor on the same item where it is still there. */
  refresh() {
    const keep = this.current?.key;
    this.entries = sortEntries(storageEntries(this.v), this.sort);
    const i = keep ? this.entries.findIndex((e) => e.key === keep) : -1;
    this.sel = i >= 0 ? i : Math.min(this.sel, Math.max(0, this.entries.length - 1));
    this.refreshT = 0.5;
    this.version++;
  }

  select(i: number) {
    if (!this.entries.length) return;
    const n = this.entries.length;
    this.sel = ((i % n) + n) % n;
    lastPick.set(this.pickKey(), this.entries[this.sel].key);
    this.p.ctx.audio.play('click', this.p.pos.x, this.p.pos.z, 0.15);
    this.version++;
  }

  setSort(mode: SortMode) {
    if (mode === this.sort) return;
    this.sort = mode;
    lastSort[this.p.index] = mode;
    this.refresh();
  }

  private say(msg: string, ok: boolean) {
    this.msg = msg;
    this.msgOk = ok;
    this.version++;
    if (!ok) this.p.ctx.audio.play('deny', this.p.pos.x, this.p.pos.z, 0.4);
  }

  /** Why the panel has to close now, or null to keep it. */
  private closeReason(): string | null {
    const p = this.p;
    const v = this.v;
    if (p.state !== 'foot') return 'gone';
    if (!v.build || v.wreck || !p.ctx.vehicles.includes(v)) return `The ${v.def.name} is gone`;
    if (Math.abs(v.speed) > 2) return `The ${v.def.name} is moving`;
    if (Math.hypot(v.position.x - p.pos.x, v.position.z - p.pos.z) > v.def.length / 2 + 4.5) return 'gone';
    if (p.sinceHit < 0.05 && p.ctx.time - this.openedAt > 0.1) return 'hit';
    return null;
  }

  /**
   * One tick with the panel open: read this player's controls, run a fit in progress, and keep the pick lit in the boot.
   * Returns the intent the rest of the player's tick should see (look only), or null once the panel has closed.
   */
  tick(it: PlayerIntent, dt: number): PlayerIntent | null {
    const why = this.closeReason();
    if (why) {
      this.close(why === 'gone' || why === 'hit' ? undefined : why);
      return null;
    }
    this.refreshT -= dt;
    if (this.refreshT <= 0 && !this.job) this.refresh();
    if (this.job) this.stepJob(dt);
    else {
      if (it.nav & NAV.up) this.select(this.sel - 1);
      if (it.nav & NAV.down) this.select(this.sel + 1);
      if (it.toolStep) this.select(this.sel + (it.toolStep > 0 ? 1 : -1));
      if (it.nav & (NAV.left | NAV.right)) this.setSort(this.sort === 'slot' ? 'value' : 'slot');
      if (wasPressed(it, Btn.A) || wasPressed(it, Btn.RT)) this.take();
      else if (wasPressed(it, Btn.X)) this.second();
      if (wasPressed(it, Btn.B) || wasPressed(it, Btn.LB) || wasPressed(it, Btn.Y)) return this.close(), null;
    }
    if (storageOf(this.p) !== this) return null;
    this.highlight();
    return this.mask(it);
  }

  /** The player's intent with everything but looking taken out. */
  private mask(it: PlayerIntent): PlayerIntent {
    const m = this.masked;
    m.device = it.device;
    m.look[0] = it.look[0];
    m.look[1] = it.look[1];
    m.lookDelta[0] = it.lookDelta[0];
    m.lookDelta[1] = it.lookDelta[1];
    m.mouse = it.mouse;
    m.aimAssist = it.aimAssist;
    m.heldTime = it.heldTime;
    m.releasedAfter = it.releasedAfter;
    // The sheet stays on its button, so holding it shows the breakdown while the panel is open.
    m.held = it.held & (1 << Btn.Back);
    m.pressed = it.pressed & (1 << Btn.Back);
    m.released = it.released & (1 << Btn.Back);
    return m;
  }

  /** The pick lit up where it lies: in the boot, or on the roof. Only in this player's view. */
  private highlight() {
    const e = this.current;
    const w = this.p.ctx.work;
    if (!e?.spot || this.job) return;
    bindHighlightViews(this.p.ctx.R.views);
    const big = e.units >= 4 ? 0.5 : e.units >= 2 ? 0.36 : 0.24;
    w.highlight(this.p.index, [{ pos: e.spot, quat: quatOf(this.v), size: [big, big * 0.8, big] }], e.verdict?.junk ? 'blocked' : 'aimed');
  }

  close(why?: string) {
    if (this.job) this.cancelJob();
    if (why) this.p.note(why, 'info');
    sessions.delete(this.p);
  }

  // ---------------------------------------------------------------- taking out

  /** A: the pick into your hands. */
  take(i = this.sel) {
    const e = this.entries[i];
    const p = this.p;
    if (!e) return;
    if (p.carry) return this.say('Your hands are full', false);
    const v = this.v;
    const ctx = p.ctx;
    const camp = ctx.campaign;
    const hand = handPos(p);
    let carried: Carried | null = null;
    if (e.where === 'inside') this.reachIn();
    const from = e.spot ?? anchorWorld(v, { x: 0, y: 0.8, z: -v.def.length * 0.4, sx: 0, sy: 0, sz: 0 });
    if (e.kind === 'part' && e.item) {
      const it = camp.takePart(e.item.uid);
      if (!it) return this.refresh(), this.say('That one is gone', false);
      delete it.on;
      carried = { kind: 'part', item: it };
      ctx.work.eject(p.index, it, from, hand);
    } else if (e.kind === 'fuel' || e.kind === 'diesel') {
      const type: FuelType = e.kind === 'diesel' ? 'diesel' : 'petrol';
      const amt = takeReserve(camp, type, Math.min(FUEL_CAN, reserveOf(camp, type)));
      if (amt <= 0.05) return this.say('The cans are dry', false);
      carried = { kind: 'fuel', amount: amt, fuel: type };
    } else if (e.kind === 'oil') {
      const amt = Math.min(OIL_CAN, camp.items.oil);
      if (amt <= 0.02) return this.say('No oil left', false);
      camp.items.oil -= amt;
      carried = { kind: 'oil', amount: amt };
    } else if (e.kind === 'water') {
      const amt = Math.min(WATER_CAN, camp.items.water);
      if (amt <= 0.2) return this.say('No water left', false);
      camp.items.water -= amt;
      carried = { kind: 'water', amount: amt };
    } else if (e.kind === 'cargo' && e.cargo) {
      const got = v.cargoRig.remove(e.cargo.id);
      if (!got) return this.refresh(), this.say('That one is gone', false);
      carried = got.c;
    }
    if (!carried) return;
    if (carried.kind !== 'part') ctx.work.stow(carryModelKey(carried), from, hand);
    p.carry = carried;
    v.refreshLoadNow();
    ctx.audio.play('pickup', v.position.x, v.position.z, 0.7);
    p.note(`${carriedName(carried)}: ${whereTo(v, carried, aLabel(p))}`, 'good');
    lastPick.delete(this.pickKey());
    this.close();
  }

  /** Reaching into the inside: a shut boot lid (or the door you stand at) comes up first. */
  private reachIn() {
    const p = this.p;
    const v = this.v;
    const place = placeFor(p, v, 'stow');
    if (place.gate.ok) return;
    const need = place.gate.need;
    const panel = need?.kind === 'open' ? need.panel : (workFor(v.def, 'stow')?.at.map(panelOfSpot).find((q): q is Panel => !!q && v.hasPanel(q)) ?? null);
    if (panel && !v.panelOpen()[panel]) v.setPanel(panel, true);
  }

  /** X: the row's second job. A part goes straight on (with a wrench on the belt); a fuel can fills the tank. */
  second(i = this.sel) {
    const e = this.entries[i];
    if (!e) return;
    if (e.item && (e.kind === 'part' || e.kind === 'cargo')) return this.fitNow(i);
    if (e.kind === 'fuel' || e.kind === 'diesel') return this.fillTank(e.kind === 'diesel' ? 'diesel' : 'petrol');
    this.say(e.kind === 'oil' ? 'Carry a can to the engine bay to top up the oil' : e.kind === 'water' ? 'Carry a can to the engine bay to top up the radiator' : 'Nothing to do with that here', false);
  }

  /** What X would do on a row, for the hint under it. Null when nothing. */
  secondLabel(e: StorageEntry | null): { text: string; ok: boolean } | null {
    if (!e) return null;
    if (e.item) {
      const why = this.fitBlock(e);
      return { text: why ? why : `Fit now${e.slot === 'wheels' ? ` · ${wheelWord(this.v, this.mountFor(e.item))}` : ''}`, ok: !why };
    }
    if (e.kind === 'fuel' || e.kind === 'diesel') {
      const type: FuelType = e.kind === 'diesel' ? 'diesel' : 'petrol';
      const space = this.v.tankMax - this.v.fuel;
      const plan = planPour(this.v.fuelType, this.v.fuel, type);
      if (!plan.ok) return { text: plan.note, ok: false };
      if (space < 0.3) return { text: 'Tank is full', ok: false };
      return { text: `Fill the tank · +${Math.min(space, reserveOf(this.p.ctx.campaign, type)).toFixed(1)} FU`, ok: true };
    }
    return null;
  }

  /** Pour from the reserve cans straight into the tank (the flap is a step from the boot). */
  fillTank(type: FuelType) {
    const v = this.v;
    const p = this.p;
    const camp = p.ctx.campaign;
    const plan = planPour(v.fuelType, v.fuel, type);
    if (!plan.ok) return this.say(plan.note, false);
    if (plan.tank !== v.fuelType) {
      v.fuelType = plan.tank;
      v.fuel = 0;
    }
    const space = v.tankMax - v.fuel;
    if (space < 0.3) return this.say('The tank is full', false);
    const got = takeReserve(camp, type, Math.min(space, reserveOf(camp, type)));
    if (got <= 0.05) return this.say(`No ${type} in the cans`, false);
    v.fuel += got;
    const flap = accessPointsOf(v.def).find((q) => q.spot === 'flap');
    const to = flap ? pointPos(v, flap) : anchorWorld(v, { x: 0, y: 0.8, z: -v.def.length * 0.4, sx: 0, sy: 0, sz: 0 });
    p.ctx.work.pour(handPos(p), to, type === 'diesel' ? [0.9, 0.8, 0.3] : [0.85, 0.7, 0.2]);
    p.ctx.work.label(`+${got.toFixed(1)} FU`, '#ffd27a', to.clone().add(new THREE.Vector3(0, 0.8, 0)));
    p.ctx.audio.play('pickup', v.position.x, v.position.z, 0.5);
    if (v.fuelType !== v.stats.fuel) p.note(`The engine runs ${v.stats.fuel}: drain the tank with the jerrycan`, 'warn');
    this.say(`+${got.toFixed(1)} FU of ${type} in the tank`, true);
    this.refresh();
  }

  // ---------------------------------------------------------------- fitting straight from the boot

  /** The mount a part would go on: the worst tyre it fits, the free side for a door or a front seat, else its slot. */
  mountFor(item: PartItem): PartSlot | number {
    const v = this.v;
    const d = partDef(item.id);
    const b = v.build!;
    if (d.slot === 'wheels') {
      const ok = tyresFor(v.def, item.id);
      const comp = v.health.comp.tires;
      // A flat or bare wheel first, then the most worn.
      return ok.sort((a, z) => (comp[a] ?? 1) - (comp[z] ?? 1))[0] ?? 0;
    }
    const opts = mountsFor(d.slot).filter((m) => slotsOf(v.def).includes(m));
    return opts.find((m) => !idInSlot(b, m)) ?? opts[0] ?? d.slot;
  }

  /** Why a part cannot go straight on from here, or null when it can. */
  fitBlock(e: StorageEntry): string | null {
    const v = this.v;
    const p = this.p;
    const item = e.item;
    if (!item) return 'Not a part';
    if (!e.verdict?.fitsHere) return `It does not go on a ${v.def.name}`;
    if (!hasWrench(p)) return 'Fit it by hand: carry it to its mount (or take a wrench)';
    if (Math.abs(v.speed) > 1) return `The ${v.def.name} is moving`;
    const d = partDef(item.id);
    if (d.slot === 'wheels' && !tyreFits(v.def, Number(this.mountFor(item)), item.id)) return `${d.name} does not go on that hub`;
    const mount = this.mountFor(item);
    const slot = typeof mount === 'number' ? 'wheels' : mount;
    const cur = typeof mount === 'number' ? null : idInSlot(v.build!, slot);
    const plan = planFit({ kind: 'part', item }, { def: v.def, fitted: (s) => { const id = idInSlot(v.build!, s as PartSlot); return id ? { id } : undefined; }, current: cur ? { id: cur } : null, fuel: v.fuel, tankMax: v.tankMax, oil: v.health.comp.oil, access: undefined });
    if (!plan.ok) return plan.label;
    if (!socketFor(v.def, slot)) return 'No mount for it on this frame';
    return null;
  }

  /** X on a part: bolt it straight on with the wrench, from the boot to its mount, the bonnet or door opening as needed. */
  fitNow(i = this.sel) {
    const e = this.entries[i];
    if (!e?.item) return;
    const why = this.fitBlock(e);
    if (why) return this.say(why, false);
    const p = this.p;
    const v = this.v;
    const ctx = p.ctx;
    const item = e.item;
    const mount = this.mountFor(item);
    const slot: PartSlot = typeof mount === 'number' ? 'wheels' : mount;
    // Out of the boot (or off the roof) and onto the mount: it leaves the list now and comes back if the job is dropped.
    if (e.kind === 'cargo' && e.cargo) {
      if (!v.cargoRig.remove(e.cargo.id)) return this.refresh();
    } else if (!ctx.campaign.takePart(item.uid)) return this.refresh();
    v.refreshLoadNow();
    if (e.where === 'inside') this.reachIn();
    // What is in the way opens: the bonnet over an engine bay, the door in front of a seat.
    const wk = workFor(v.def, slot);
    if (wk?.open) {
      const panel = wk.at.map(panelOfSpot).find((q): q is Panel => !!q && v.hasPanel(q) && !v.panelOpen()[q]);
      if (panel && !wk.at.some((s) => { const q = panelOfSpot(s); return !q || !v.hasPanel(q) || v.panelOpen()[q]; })) v.setPanel(panel, true);
    }
    equipWrench(p);
    const sock = socketFor(v.def, slot)!;
    const idx = typeof mount === 'number' ? Math.min(mount, sock.anchors.length - 1) : 0;
    const anchor = anchorWorld(v, sock.anchors[idx]);
    const from = e.spot?.clone() ?? anchor.clone().add(new THREE.Vector3(0, 1, 0));
    const secs = slot === 'engine' ? 4 : slot === 'wheels' ? 2.6 : slot === 'gearbox' ? 3.6 : slot === 'cooling' ? 3 : 2.4;
    this.job = { item, mount, anchor, from, t: 0, dur: secs, name: partName(item) };
    this.say(`Fitting ${partName(item)}…`, true);
  }

  private stepJob(dt: number) {
    const j = this.job!;
    const p = this.p;
    const v = this.v;
    const ctx = p.ctx;
    if (Math.abs(v.speed) > 1) return this.cancelJob(`The ${v.def.name} moved`);
    j.t += dt;
    // The part floats up out of the boot, over to the mount, and spins down onto it as the bolts go in.
    ctx.work.hold(p.index, j.item, j.from, j.anchor, Math.min(1, j.t / j.dur));
    if (Math.random() < 0.3) ctx.fx.spark(j.anchor.x + (Math.random() - 0.5) * 0.3, j.anchor.y + (Math.random() - 0.5) * 0.2, j.anchor.z + (Math.random() - 0.5) * 0.3, 2, 3);
    if (Math.random() < 0.07) ctx.audio.play('wrench', j.anchor.x, j.anchor.z, 0.5);
    if (j.t >= j.dur) this.finishJob();
    else this.version++;
  }

  /** The job is done: the part is on, what came off goes in the boot (or at your feet if there is no room). */
  private finishJob() {
    const j = this.job!;
    this.job = null;
    const p = this.p;
    const v = this.v;
    const ctx = p.ctx;
    const b = v.build!;
    v.commit();
    const res = installPart(b, j.item, j.mount);
    if (!res.ok) {
      this.putBack(j.item);
      return this.say(res.reason ?? 'It does not fit', false);
    }
    v.syncFromBuild();
    const mk = Math.min(3, Math.max(1, partDef(j.item.id).mk));
    const out = v.deckSpots()[0]?.world ?? j.from;
    ctx.work.swap({
      key: p.index,
      anchor: j.anchor,
      out,
      fresh: j.item,
      old: res.removed,
      hit: () => {
        ctx.work.label(`${PARTS.labels[partDef(j.item.id).slot].toUpperCase()}  ${j.name}`, MK_CSS[mk], j.anchor.clone().add(new THREE.Vector3(0, 0.8, 0)));
        ctx.audio.play('wrench', v.position.x, v.position.z, 0.6);
      },
    });
    ctx.audio.play('wrench', v.position.x, v.position.z, 0.8);
    let tail = '';
    if (res.removed) {
      res.removed.on = b.uid;
      if (ctx.campaign.stowPart(res.removed)) tail = `; the old ${partName(res.removed)} is in the ${v.insideRoom().name}`;
      else {
        delete res.removed.on;
        const at = j.from;
        ctx.loose?.drop(at.x, at.z, { kind: 'part', item: res.removed });
        tail = `; no room for the old ${partName(res.removed)}: it is on the ground`;
      }
    }
    // Working on an abandoned car makes it the convoy's, as with any other job on it.
    if (v.faction === 'neutral') ctx.cars.claim(v, p);
    if (res.note) p.note(res.note, 'warn');
    this.say(`${j.name} fitted${tail}`, true);
    p.note(`${j.name} fitted${tail}`, 'good');
    ctx.sig.emit(p.pos.x, p.pos.z, 22, 'noise');
    v.refreshLoadNow();
    this.refresh();
  }

  /** A fit given up: the part goes back where it was. */
  private cancelJob(why?: string) {
    const j = this.job;
    if (!j) return;
    this.job = null;
    this.putBack(j.item);
    if (why) this.say(why, false);
    this.refresh();
  }

  private putBack(item: PartItem) {
    const camp = this.p.ctx.campaign;
    item.on = this.v.build?.uid;
    if (!camp.stowPart(item)) {
      delete item.on;
      camp.addPart(item);
    }
  }
}

/** One session per player at most. */
const sessions = new WeakMap<Player, StorageSession>();

/** The storage panel a player has open, if any. */
export function storageOf(p: Player): StorageSession | null {
  return sessions.get(p) ?? null;
}

/** Open a car's storage for a player. An abandoned car is claimed: reaching into it is taking it, as driving it would be. */
export function openStorage(p: Player, v: Vehicle): boolean {
  if (!v.build || p.carry) return false;
  if (v.faction === 'neutral') p.ctx.cars.claim(v, p);
  if (v.faction !== 'convoy') return false;
  const place = placeFor(p, v, 'stow');
  // At the boot or a back door: the lid comes up as you reach in.
  if (place.at && place.gate.need?.kind === 'open') v.setPanel(place.gate.need.panel, true);
  p.action = null;
  sessions.set(p, new StorageSession(p, v));
  p.ctx.audio.play('pickup', v.position.x, v.position.z, 0.3);
  return true;
}

/** Close a player's panel (the scene is ending, the pause menu, Esc). */
export function closeStorage(p: Player) {
  sessions.get(p)?.close();
}

/**
 * The player's controls this tick: with a panel open it takes them (looking still works) and the rest of the tick sees nothing
 * pressed; otherwise they pass through untouched.
 */
export function storageInput(p: Player, it: PlayerIntent, dt: number): PlayerIntent {
  const s = sessions.get(p);
  if (!s) return it;
  return s.tick(it, dt) ?? it;
}

// ------------------------------------------------------------------------------------------------ helpers

const handPos = (p: Player) => p.human.hand.getWorldPosition(new THREE.Vector3());

const quatOf = (v: Vehicle) => {
  const r = v.body.body.rotation();
  return new THREE.Quaternion(r.x, r.y, r.z, r.w);
};

/** Is there a wrench on this person's belt? */
export function hasWrench(p: Player): boolean {
  return p.gear.belt.some((it) => !!it && gearDef(it.id).tool === 'wrench');
}

/** Put the wrench in hand for a job (the arms show it). */
function equipWrench(p: Player) {
  const g = p.gear;
  const i = g.belt.findIndex((it) => !!it && gearDef(it.id).tool === 'wrench');
  if (i < 0 || g.sel === i) return;
  g.sel = i;
  p.syncEquip();
}

/** Where a wheel is, in a word, for "Fit now · front left". */
function wheelWord(v: Vehicle, mount: PartSlot | number): string {
  if (typeof mount !== 'number') return '';
  const n = v.def.physics.wheelCount;
  if (n <= 2) return mount === 0 ? 'front wheel' : 'rear wheel';
  const axle = Math.floor(mount / 2);
  return `${axle === 0 ? 'front' : 'rear'} ${mount % 2 === 0 ? 'left' : 'right'}`;
}

/** Where to take what was just lifted out, in a few words. */
function whereTo(v: Vehicle, c: Carried, keyA: string): string {
  if (c.kind === 'fuel') return 'pour it in at the fuel flap, or carry it on';
  if (c.kind === 'oil' || c.kind === 'water') return `top up at the engine bay${v.hasPanel('hood') ? ' (bonnet open)' : ''}`;
  if (c.kind !== 'part') return 'carry it, or X to put it back';
  const d = partDef(c.item.id);
  if (!slotsOf(v.def).some((m) => mountsFor(d.slot).includes(m))) return 'it does not go on this car: take it to one it fits';
  const wk = workFor(v.def, mountsFor(d.slot).find((m) => slotsOf(v.def).includes(m)) ?? d.slot);
  const spot = wk?.at[0] as Spot | undefined;
  const label = isInteriorSlot(d.slot) ? 'through the door' : isGlassSlot(d.slot) ? 'at the window' : spot === 'wheel' ? 'at a wheel' : spot === 'hood' ? 'at the engine bay' : spot === 'under' ? 'from underneath' : `at the ${PARTS.labels[d.slot].toLowerCase()}`;
  return `hold ${keyA} ${label} to fit it`;
}
