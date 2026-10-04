import * as THREE from 'three';
import { partDef } from '../data';
import { mountsOfChassis } from '../render/vehicleModels';
import { accessPointsOf } from '../render/accessPoints';
import { buildCargoMesh, deckOfZone, layoutEntries, pieceGeometry } from '../render/cargoLoad';
import { bodyMat } from '../render/vehicleKit';
import { disposeTree } from '../render/dispose';
import type { Carried } from '../sim/carry';
import {
  FALL_SPEED,
  WALLED_FACTOR,
  cargoName,
  fallLine,
  fallThreshold,
  fallWear,
  looseStress,
  securedSet,
  sizeOf,
  surfacesOf,
  walledStress,
  type CargoEntry,
  type Motion,
  type Surface,
  type Zone,
} from '../sim/cargo';
import { newUid } from '../sim/parts';
import type { Vehicle } from './vehicle';

/**
 * The load on the outside of one of the convoy's vehicles: what the player put on the roof, in the bed or in the rear cage.
 * It is drawn on the car, kept in the build (so it survives streaming, the garage and the save), and it behaves like a real
 * load: while the car is parked it stays, and once it moves anything that no holder secures slides and falls off, as a loose
 * part or can in the road that can be lifted again. The rules are `sim/cargo.ts`.
 */


/** Seconds without moving before a load's worn-in exposure is forgotten. */
const SETTLE = 2;

export class CargoRig {
  entries: CargoEntry[] = [];
  private mesh: THREE.Mesh | null = null;
  private seen = '';
  private exposure = new Map<string, number>();
  private prevVel: THREE.Vector3 | null = null;
  private smooth = { long: 0, lat: 0 };
  private still = 0;
  private secured = new Set<string>();
  /** Last measured motion, for tests and for the fall. */
  motion: Motion = { speed: 0, long: 0, lat: 0, vert: 0, airborne: false, upY: 1 };

  constructor(private v: Vehicle) {
    const saved = v.build?.cargo ?? [];
    this.entries = saved.filter((e) => e.c.kind !== 'part' || !!safePart(e.c.item.id)).map((e) => ({ ...e }));
    this.resecure();
  }

  /** Only the convoy's own cars carry cargo this way: raiders, crew and abandoned cars are untouched. */
  get active(): boolean {
    const v = this.v;
    return v.faction === 'convoy' && !!v.build && !v.wreck && v.kind !== 'crew';
  }

  private surfaces(): Surface[] {
    return this.v.build ? surfacesOf(this.v.def, this.v.build.fit) : [];
  }

  private surfaceOf(zone: Zone): Surface | undefined {
    return this.surfaces().find((s) => s.zone === zone);
  }

  /** Recompute which entries are held by a holder (call after the fit or the entries change). */
  resecure() {
    this.secured = this.v.build ? securedSet(this.v.def, this.v.build.fit, this.entries) : new Set();
  }

  isSecure(e: CargoEntry): boolean {
    return this.secured.has(e.id);
  }

  /** Put something on the outside. Returns the entry. */
  add(c: Carried, zone: Zone): CargoEntry {
    const id = c.kind === 'part' ? c.item.uid : newUid('c');
    const e: CargoEntry = { id, zone, c, thr: fallThreshold(this.v.build ? hash(this.v.build.uid + id) : Math.random() * 1000) };
    this.entries.push(e);
    this.changed();
    return e;
  }

  remove(id: string): CargoEntry | null {
    const i = this.entries.findIndex((e) => e.id === id);
    if (i < 0) return null;
    const [e] = this.entries.splice(i, 1);
    this.exposure.delete(id);
    this.changed();
    return e;
  }

  /** Write the entries to the build and redraw. */
  changed() {
    this.resecure();
    this.save();
    this.refreshNow();
  }

  save() {
    const b = this.v.build;
    if (!b) return;
    if (this.entries.length) b.cargo = this.entries.map((e) => ({ ...e }));
    else delete b.cargo;
  }

  /** The model was rebuilt (a part was fitted): the old mesh went with it. */
  reset() {
    this.mesh = null;
    this.seen = '';
    this.resecure();
  }

  // ------------------------------------------------------------------ drawing

  refreshNow() {
    this.seen = '';
    this.refresh();
  }

  refresh() {
    const v = this.v;
    const fitKey = v.build ? Object.values(v.build.fit).map((p) => p?.id).join(',') : '';
    const key = `${this.entries.map((e) => `${e.id}:${e.zone}`).join('|')}#${fitKey}`;
    if (key === this.seen) return;
    this.seen = key;
    if (this.mesh) {
      v.visual.inner.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    const decks = this.decks();
    const mesh = buildCargoMesh(decks);
    if (mesh) {
      v.visual.inner.add(mesh);
      this.mesh = mesh;
    }
  }

  private decks() {
    const anchor = mountsOfChassis(this.v.def);
    if (!anchor) return [];
    const out: { zone: Zone; deck: NonNullable<ReturnType<typeof deckOfZone>>; entries: CargoEntry[] }[] = [];
    for (const s of this.surfaces()) {
      const deck = deckOfZone(anchor.m, anchor.g0, s.zone, !!s.holder);
      const entries = this.entries.filter((e) => e.zone === s.zone);
      if (deck && entries.length) out.push({ zone: s.zone, deck, entries });
    }
    return out;
  }

  /** Where an entry is in the world: on its deck, or at its holder's point when the holder draws its own load. */
  worldOf(e: CargoEntry): THREE.Vector3 {
    const v = this.v;
    const anchor = mountsOfChassis(v.def);
    const s = this.surfaceOf(e.zone);
    if (anchor && s) {
      const deck = deckOfZone(anchor.m, anchor.g0, s.zone, !!s.holder);
      if (deck) {
        const list = this.entries.filter((q) => q.zone === s.zone);
        const placed = layoutEntries(deck, list).find((t) => t.id === e.id);
        if (placed) {
          v.visual.inner.updateWorldMatrix(true, false);
          return v.visual.inner.localToWorld(new THREE.Vector3(placed.x, placed.y + 0.15, placed.z));
        }
      }
    }
    const pt = accessPointsOf(v.def).find((p) => p.spot === (s?.spot ?? 'trunk'));
    const [x, y, z] = pt ? v.body.toWorld(pt.x, pt.y + 0.2, pt.z) : v.body.toWorld(0, 1, 0);
    return new THREE.Vector3(x, y, z);
  }

  /** The world position the next thing put in `zone` will land on. */
  nextSpot(c: Carried, zone: Zone): THREE.Vector3 {
    const probe: CargoEntry = { id: '_next', zone, c, thr: 1 };
    this.entries.push(probe);
    const at = this.worldOf(probe);
    this.entries.pop();
    return at;
  }

  // ------------------------------------------------------------------ driving

  /** Once per fixed tick. Measures what the car does and lets whatever is not held work loose. */
  step(dt: number) {
    const v = this.v;
    if (!this.active) return;
    const lv = v.body.body.linvel();
    const vel = new THREE.Vector3(lv.x, lv.y, lv.z);
    const q = v.body.body.rotation();
    const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
    const m = this.motion;
    m.speed = v.speed;
    m.upY = upY;
    m.airborne = !v.onGround;
    if (this.prevVel && dt > 0) {
      const ax = (vel.x - this.prevVel.x) / dt;
      const ay = (vel.y - this.prevVel.y) / dt;
      const az = (vel.z - this.prevVel.z) / dt;
      const [fx, , fz] = v.body.forward();
      const long = ax * fx + az * fz;
      const lat = ax * fz - az * fx;
      const a = 0.2;
      this.smooth.long += (long - this.smooth.long) * a;
      this.smooth.lat += (lat - this.smooth.lat) * a;
      m.long = this.smooth.long;
      m.lat = this.smooth.lat;
      m.vert = v.onGround ? ay : 0;
    }
    this.prevVel = vel;
    if (!this.entries.length) return;
    if (Math.abs(m.speed) <= FALL_SPEED && upY > 0.4) {
      this.still += dt;
      if (this.still > SETTLE) this.exposure.clear();
      return;
    }
    this.still = 0;
    const gone = v.bodywork.gonePanels();
    for (const e of [...this.entries]) {
      if (this.secured.has(e.id)) continue;
      const s = this.surfaceOf(e.zone);
      const walled = !!s?.walled;
      const tailgateOpen = v.def.id === 'buggy' || !!gone.trunk || !!v.open.trunk;
      const stress = walled ? walledStress(m, dt, tailgateOpen) : looseStress(m, dt);
      if (stress <= 0) continue;
      const tot = (this.exposure.get(e.id) ?? 0) + stress;
      this.exposure.set(e.id, tot);
      const limit = e.thr * (walled && !tailgateOpen ? WALLED_FACTOR : 1);
      if (tot >= limit) this.fall(e);
    }
  }

  /** Throw an entry off the car: it tumbles away behind and aside and lands as a thing you can lift. */
  fall(e: CargoEntry, impulse = 1) {
    const v = this.v;
    const ctx = v.ctx;
    const at = this.worldOf(e);
    const s = this.surfaceOf(e.zone);
    this.remove(e.id);
    let c = e.c;
    // Fragile working parts take a knock.
    const wear = fallWear(c, Math.random());
    if (wear !== null && c.kind === 'part') c = { kind: 'part', item: { ...c.item, cond: wear } };
    const lv = v.body.body.linvel();
    const [fx, , fz] = v.body.forward();
    const sp = Math.abs(v.speed);
    const side = (Math.random() < 0.5 ? -1 : 1) * (0.8 + Math.random() * 1.8);
    const back = (1.2 + sp * 0.18) * impulse;
    const vel = new THREE.Vector3(lv.x - fx * back + fz * side, lv.y + 1.4 + Math.random() * 1.6, lv.z - fz * back - fx * side);
    const spin = new THREE.Vector3((Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9);
    const geo = pieceGeometry(c);
    geo.computeBoundingBox();
    const bb = geo.boundingBox!;
    const rot = v.body.body.rotation();
    const quat = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w);
    const size = sizeOf(c);
    if (ctx.loose) {
      ctx.debris.spawn({
        geo,
        material: bodyMat,
        pos: at,
        quat,
        vel,
        spin,
        centre: [(bb.max.x + bb.min.x) / 2, (bb.max.y + bb.min.y) / 2, (bb.max.z + bb.min.z) / 2],
        half: [(bb.max.x - bb.min.x) / 2, (bb.max.y - bb.min.y) / 2, (bb.max.z - bb.min.z) / 2],
        mass: size === 4 ? 40 : size === 2 ? 14 : 5,
        round: c.kind === 'part' && partDef(c.item.id).slot === 'wheels',
        item: c.kind === 'part' ? c.item : null,
        carried: c.kind === 'part' ? null : c,
        tag: 'cargo',
      });
    } else {
      // Nowhere to lie in the road (the camp arena): it goes back to the trucks instead of being lost.
      geo.dispose();
      const camp = ctx.campaign;
      if (c.kind === 'part') camp.addPart(c.item);
      else if (c.kind === 'fuel') camp.stowFuel(c.amount, c.fuel ?? 'petrol');
      else if (c.kind === 'oil') camp.stowOil(c.amount);
      else if (c.kind === 'water') camp.stowWater(c.amount);
    }
    ctx.fx.spark(at.x, at.y, at.z, 4, 3);
    ctx.audio.play('crash', at.x, at.z, 0.35);
    const who = v.driver?.isPlayer ? v.driver.index : v.ownerIndex;
    if (who >= 0) ctx.notify(who, fallLine(c, e.zone, s?.name ?? e.zone), 'warn');
  }

  /** Everything on the outside lets go at once (a roll-over, a wreck): used by the wreck and by tests. */
  spillAll(impulse = 1) {
    for (const e of [...this.entries]) this.fall(e, impulse);
  }

  dispose() {
    if (this.mesh) {
      this.v.visual.inner.remove(this.mesh);
      disposeTree(this.mesh);
      this.mesh = null;
    }
  }

  /** For prompts: a line of what is on the outside. */
  describe(e: CargoEntry): string {
    return `${cargoName(e.c)} (${this.isSecure(e) ? 'secure' : 'loose'})`;
  }
}

function safePart(id: string) {
  try {
    return partDef(id);
  } catch {
    return null;
  }
}

function hash(s: string): number {
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h % 100000) + 1;
}


