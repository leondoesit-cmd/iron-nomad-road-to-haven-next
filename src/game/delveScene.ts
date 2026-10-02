import * as THREE from 'three';
import type { LegDef } from '../data';
import { GROUPS, type Collider } from '../physics/physics';
import { DayClock } from '../sim/dayclock';
import { kitMaterial } from '../render/materials';
import { makeBeam } from '../render/props';
import { DELVE_LOOK, DelveView, chestGeometry, keyGeometry } from '../render/delveView';
import { CELL, floorAt, generateDelve, wallColliders, type DelveChest, type DelveDecor, type DelveMap, type DelveSpawn } from '../world/delve';
import type { DelveSite } from '../world/delveSites';
import { newAabbId, type Aabb } from '../world/layout';
import { Scene, type CompassPin, type SceneServices } from './scene';
import { Player, type Equip, type Utility } from './player';
import type { Zombie } from './zombies';
import type { Infantry } from './raiders';
import { Rng, hashString } from '../core/rng';
import { gearDrop } from '../sim/gear';
import { delveBounds, known, newDelveBase, newFrame, revealDelve, type MapFrame } from '../ui/mapdata';
import { DRUGS, DRUG_IDS } from '../sim/drugs';

/** What a delve remembers between visits, so cleared rooms stay cleared and opened chests stay open. */
export interface DelveRecord {
  visits: number;
  chests: Set<string>;
  keyTaken: boolean;
  doors: Set<string>;
  killed: Set<number>;
  bossDead: boolean;
  cleared: boolean;
}

export const newDelveRecord = (): DelveRecord => ({ visits: 0, chests: new Set(), keyTaken: false, doors: new Set(), killed: new Set(), bossDead: false, cleared: false });

/** The bits of a player that cross the threshold with them. */
export interface PlayerCarry {
  hp: number;
  mag: number;
  equip: Equip;
  utility: Utility;
  /** The belt slot in hand. The gear itself lives in the campaign, so only the selection needs to cross over. */
  sel: number;
}

/** A tool in hand goes back to the gun on the way down, as it always has. */
export const carryOf = (p: Player): PlayerCarry => ({ hp: p.hp, mag: p.mag, equip: p.equip === 'gun' || p.equip === 'melee' || p.equip === 'utility' ? p.equip : 'gun', utility: p.utility, sel: p.gear.sel });

/** Footprints (width, depth, height) of decor that blocks the way. */
const FOOT: Partial<Record<DelveDecor, [number, number, number]>> = {
  crateStack: [1.5, 1.5, 1.8],
  barrel: [0.7, 0.7, 1.0],
  shelf: [2.0, 0.7, 2.0],
  locker: [1.0, 0.7, 2.0],
  dumpster: [2.4, 1.4, 1.4],
  rock: [1.3, 1.3, 1.0],
  generator: [1.5, 1.0, 1.2],
  bunk: [2.1, 1.0, 1.9],
  table: [1.7, 0.9, 0.9],
  stalagmite: [0.9, 0.9, 1.4],
  altar: [2.2, 1.2, 1.0],
  carriage: [12, 3, 3],
  pillar: [1.0, 1.0, 4],
};

interface ChestView {
  chest: DelveChest;
  closed: THREE.Mesh;
  open: THREE.Mesh;
  glint: THREE.Mesh;
  beam: THREE.Object3D;
}

const LAMPS = 6;
const GLINT_GEO = new THREE.OctahedronGeometry(0.2);

export class DelveScene extends Scene {
  biome: 'wasteland' | 'city';
  mode = 'delve' as const;
  map: DelveMap;
  view: DelveView;
  /** Called every tick with the delve's share of the day, so the surface clock keeps moving while you are below. */
  parentTick: (dt: number) => void = () => {};
  private chestViews = new Map<string, ChestView>();
  private keyMesh: THREE.Object3D | null = null;
  private doorColliders = new Map<string, { collider: Collider; aabb: Aabb }>();
  private bossZ: Zombie[] = [];
  private spawned: { idx: number; zb: Zombie }[] = [];
  private lazy: { idx: number; s: DelveSpawn; unit: Infantry | null }[] = [];
  private units: { idx: number; unit: Infantry }[] = [];
  private lamps: THREE.PointLight[] = [];
  private lampPick: number[] = [];
  private leaving = false;
  private downT = 0;
  private dripT = 2;
  private lockNote = 0;
  private doorIx: ReturnType<Scene['interact']['add']>[] = [];
  private exitIx: ReturnType<Scene['interact']['add']> | null = null;
  private liftIx: ReturnType<Scene['interact']['add']> | null = null;

  constructor(
    svc: SceneServices,
    public leg: LegDef,
    public site: DelveSite,
    public record: DelveRecord,
    carry: PlayerCarry[],
  ) {
    super(svc);
    this.biome = leg.biome;
    this.clock = new DayClock(leg.dayLength, 0.3);
    this.clock.frozen = true;
    this.map = generateDelve(site.theme, site.seed, site.tier);
    this.view = new DelveView(this.map);
    this.root.add(this.view.group);
    this.buildPhysics();
    this.P.step();
    this.spawnPlayers(carry);
    this.spawnEnemies();
    this.placeLoot();
    this.placeDoors();
    this.placeExits();
    this.buildLamps();
    record.visits++;
    this.audio.setMusic('stealth');
    this.R.setInterior(this.look());
    this.services.onBanner?.(site.name.toUpperCase(), `${THEME_LABEL[site.theme]} · ${'I'.repeat(site.tier)}`);
    this.radio(record.visits > 1 ? 'Back below. The dark remembers you.' : THEME_RADIO[site.theme]);
  }

  private look() {
    const L = DELVE_LOOK[this.site.theme];
    const tune = (globalThis as { __delveTune?: Partial<Record<'ambient' | 'exposure', number>> }).__delveTune;
    return { fog: L.fog, near: L.fogNear, far: L.fogFar, sky: L.sky, ground: L.ground, ambient: tune?.ambient ?? L.ambient, exposure: tune?.exposure ?? L.exposure };
  }

  groundAt(): number {
    return 0;
  }

  surfaceAt(): { grip: number; drag: number; name: 'hardpan' } {
    return { grip: 1, drag: 0, name: 'hardpan' };
  }

  // ------------------------------------------------------------------ physics

  private buildPhysics() {
    const m = this.map;
    const half = (Math.max(m.w, m.h) / 2) * CELL + 4;
    this.P.addStaticBox(0, -0.5, 0, half, 0.5, half, 0, GROUPS.static);
    // A ceiling, so the camera is kept inside the room.
    this.P.addStaticBox(0, m.ceil + 0.6, 0, half, 0.5, half, 0, GROUPS.static);
    for (const a of wallColliders(m, m.ceil + 1)) this.addBox(a);
    for (const p of m.props) {
      const f = FOOT[p.kind];
      if (!f) continue;
      const turned = Math.abs(Math.sin(p.yaw)) > 0.7 && p.kind !== 'carriage';
      const w = (turned ? f[1] : f[0]) * p.scale * (p.kind === 'carriage' ? 1 : 0.9);
      const d = (turned ? f[0] : f[1]) * p.scale * (p.kind === 'carriage' ? 1 : 0.9);
      this.addBox({ id: newAabbId(), minX: p.x - w / 2, maxX: p.x + w / 2, minZ: p.z - d / 2, maxZ: p.z + d / 2, y0: 0, y1: f[2], kind: p.kind === 'rock' || p.kind === 'stalagmite' ? 'rock' : 'crate', hp: 99999 });
    }
  }

  private addBox(a: Aabb): Collider {
    this.obs.add(a);
    return this.P.addStaticBox((a.minX + a.maxX) / 2, (a.y0 + a.y1) / 2, (a.minZ + a.maxZ) / 2, (a.maxX - a.minX) / 2, (a.y1 - a.y0) / 2, (a.maxZ - a.minZ) / 2, 0, GROUPS.static);
  }

  // ------------------------------------------------------------------ people

  private spawnPlayers(carry: PlayerCarry[]) {
    const m = this.map;
    const names = this.campaign.players.map((p) => p.name);
    for (let i = 0; i < this.campaign.count; i++) {
      const p = new Player(this, i as 0 | 1, names[i]);
      this.players.push(p);
      p.placeAt(m.start.x + (i === 0 ? -1.2 : 1.2), m.start.z + 0.4, m.start.yaw);
      const c = carry[i];
      if (c) {
        p.hp = Math.max(c.hp, 1);
        p.utility = c.utility;
        p.gear.sel = c.sel;
        p.syncEquip();
        if (c.equip === 'gun') p.equipGun();
      }
      p.ownVehicle = null;
    }
  }

  private spawnEnemies() {
    const m = this.map;
    m.spawns.forEach((s, idx) => {
      if (this.record.killed.has(idx)) return;
      if (s.kind === 'gunman' || s.kind === 'sniper') {
        this.lazy.push({ idx, s, unit: null });
        return;
      }
      const zb = this.zombies.spawn(s.kind, s.x, s.z, s.dormant, s.cluster);
      if (s.boss) {
        // The things that guard a hoard are bigger than their kind.
        zb.hp *= 1.7 + this.site.tier * 0.25;
        this.bossZ.push(zb);
      }
      this.spawned.push({ idx, zb });
    });
    if (this.record.bossDead) this.bossZ = [];
  }

  // ------------------------------------------------------------------ loot, keys, doors, exits

  private placeLoot() {
    const m = this.map;
    const kit = kitMaterial();
    const rng = new Rng(m.seed + 77);
    for (const c of m.chests) {
      const taken = this.record.chests.has(c.id);
      const closed = new THREE.Mesh(chestGeometry(false, !!c.boss, m.theme), kit);
      const open = new THREE.Mesh(chestGeometry(true, !!c.boss, m.theme), kit);
      const yaw = rng.range(0, Math.PI * 2);
      for (const mesh of [closed, open]) {
        mesh.position.set(c.x, 0, c.z);
        mesh.rotation.y = yaw;
        mesh.castShadow = false;
        this.root.add(mesh);
      }
      closed.visible = !taken;
      open.visible = taken;
      const glint = new THREE.Mesh(GLINT_GEO, new THREE.MeshBasicMaterial({ color: c.boss ? 0xffc14a : 0xffd48a }));
      glint.position.set(c.x, 1.3, c.z);
      glint.visible = !taken;
      this.root.add(glint);
      const beam = makeBeam(c.boss ? 0xffc14a : 0xffe9a0, c.boss ? 6 : 3);
      beam.position.set(c.x, 0, c.z);
      beam.visible = !taken;
      this.root.add(beam);
      this.chestViews.set(c.id, { chest: c, closed, open, glint, beam });
      this.interact.add({
        id: `chest:${c.id}`,
        x: c.x,
        z: c.z,
        r: 2.3,
        prompt: `Hold to search ${c.label}`,
        dur: [1.4, 2.4, 3.6][c.depth],
        priority: 1,
        enabled: () => !this.record.chests.has(c.id),
        onTick: () => {
          this.sig.emit(c.x, c.z, 14 + c.depth * 10, 'noise');
          return true;
        },
        run: (p) => this.openChest(c, p),
      });
    }
    // The key.
    const k = m.keys[0];
    if (k && !this.record.keyTaken) {
      const g = new THREE.Group();
      const mesh = new THREE.Mesh(keyGeometry(m.theme), kit);
      mesh.position.y = 0.9;
      g.add(mesh);
      const beam = makeBeam(0x7dffb0, 5);
      g.add(beam);
      g.position.set(k.x, 0, k.z);
      this.root.add(g);
      this.keyMesh = g;
      this.interact.add({
        id: 'key',
        x: k.x,
        z: k.z,
        r: 2.2,
        prompt: `Hold to take ${k.label}`,
        dur: 0.7,
        priority: 2,
        enabled: () => !this.record.keyTaken,
        run: (p) => {
          this.record.keyTaken = true;
          this.keyMesh?.removeFromParent();
          this.keyMesh = null;
          this.audio.play('pickup', k.x, k.z, 0.9);
          p.note(`Took ${k.label}`, 'good');
          this.radio('A way forward. Something big is behind that door.');
        },
      });
    }
  }

  private openChest(c: DelveChest, by: Player) {
    const v = this.chestViews.get(c.id);
    this.record.chests.add(c.id);
    if (v) {
      v.closed.visible = false;
      v.open.visible = true;
      v.glint.visible = false;
      v.beam.visible = false;
    }
    this.addLoot(c.loot.stocks, 'delve');
    const camp = this.campaign;
    const bits: string[] = [];
    if (c.loot.ammo) {
      camp.ammo += c.loot.ammo;
      bits.push(`+${c.loot.ammo} rounds`);
    }
    for (const k of ['medkit', 'charge', 'molotov', 'flare'] as const) {
      const n = c.loot[k];
      if (n) {
        camp.items[k] += n;
        bits.push(`+${n} ${k}`);
      }
    }
    for (const id of DRUG_IDS) {
      const n = c.loot[id];
      if (n) {
        camp.items[id] += n;
        bits.push(`+${n} ${DRUGS[id].name.toLowerCase()}`);
      }
    }
    if (bits.length) by.note(bits.join('  '), 'good');
    // The hoard always pays in gear; a chest sometimes does. Seeded by the chest, so it cannot be rerolled by reloading.
    const find = gearDrop(new Rng(hashString(c.id) ^ this.site.seed), c.boss ? 'hoard' : 'chest', { tier: this.site.tier, progress: this.gearProgress });
    if (find) this.addGear(by, find);
    this.audio.play('loot', c.x, c.z, 0.9);
    this.fx.spark(c.x, 0.8, c.z, 6, 4);
    this.sig.emit(c.x, c.z, 40, 'noise');
    this.checkCleared();
  }

  private placeDoors() {
    for (const d of this.map.doors) {
      if (this.record.doors.has(d.id)) {
        this.view.openDoor(d.id);
        continue;
      }
      const a: Aabb = { id: newAabbId(), minX: d.x - d.w / 2, maxX: d.x + d.w / 2, minZ: d.z - d.d / 2, maxZ: d.z + d.d / 2, y0: 0, y1: this.map.ceil, kind: 'barricade', hp: 99999 };
      this.doorColliders.set(d.id, { collider: this.addBox(a), aabb: a });
      const ix = this.interact.add({
        id: `door:${d.id}`,
        x: d.x,
        z: d.z,
        r: Math.max(d.w, d.d) / 2 + 2.4,
        prompt: `${d.label}: find the key`,
        dur: 0.9,
        priority: 2,
        enabled: () => !this.record.doors.has(d.id),
        onTick: (p) => {
          if (this.record.keyTaken) return true;
          if (this.time - this.lockNote > 2.5) {
            this.lockNote = this.time;
            p.note('Locked. The key is somewhere in here.', 'warn');
            this.audio.play('deny', d.x, d.z, 0.7);
          }
          return false;
        },
        run: () => this.unlockDoors(),
      });
      this.doorIx.push(ix);
    }
  }

  private unlockDoors() {
    for (const d of this.map.doors) {
      if (this.record.doors.has(d.id)) continue;
      this.record.doors.add(d.id);
      const dc = this.doorColliders.get(d.id);
      if (dc) {
        this.obs.remove(dc.aabb);
        this.P.removeCollider(dc.collider);
        this.doorColliders.delete(d.id);
      }
      this.view.openDoor(d.id);
      this.audio.play('build', d.x, d.z, 1);
      for (let i = 0; i < 8; i++) this.fx.puff(d.x + (Math.random() - 0.5) * d.w, 1.2, d.z + (Math.random() - 0.5) * d.d, 0.5, 0.48, 0.42, 2, 1.2);
    }
    this.radio('The way to the heart of the place is open.');
    this.sig.emit(this.map.boss.x, this.map.boss.z, 60, 'noise');
  }

  private placeExits() {
    const m = this.map;
    this.exitIx = this.interact.add({
      id: 'exit',
      x: m.exit.x,
      z: m.exit.z,
      r: 2.6,
      prompt: 'Hold to climb out (you both leave)',
      dur: 1.2,
      priority: 0,
      enabled: () => !this.leaving,
      run: () => this.leave('climb'),
    });
    this.liftIx = this.interact.add({
      id: 'lift',
      x: m.lift.x,
      z: m.lift.z,
      r: 2.6,
      prompt: 'Hold to ride the service lift up',
      dur: 1.5,
      priority: 1,
      enabled: () => this.record.bossDead && !this.leaving,
      run: () => this.leave('lift'),
    });
    if (this.record.bossDead) this.view.lift.visible = true;
  }

  private leave(reason: 'climb' | 'lift' | 'rescue') {
    if (this.leaving) return;
    this.leaving = true;
    this.onResult({ type: 'delveExit', reason });
  }

  private checkCleared() {
    const r = this.record;
    if (r.cleared || !r.bossDead || r.chests.size < this.map.total) return;
    r.cleared = true;
    this.radio(`${this.site.name} is cleared out. Nothing left but echoes.`);
    this.notify(-1, 'Cleared: every cache found, the guardian down', 'good');
    this.addLoot({ parts: 8 + this.site.tier * 4, tech: 1 + (this.site.tier > 1 ? 1 : 0) }, 'delve');
  }

  // ------------------------------------------------------------------ lights

  private buildLamps() {
    for (let i = 0; i < LAMPS; i++) {
      const l = new THREE.PointLight(0xffd8a0, 0, 24, 2);
      l.castShadow = false;
      this.root.add(l);
      this.lamps.push(l);
    }
  }

  protected applyLighting() {
    this.R.setInterior(this.look());
    const m = this.map;
    // Flashlights: from the shoulder, along the view.
    for (let i = 0; i < 2; i++) {
      const s = this.spots[i];
      const p = this.players[i];
      if (!p || p.state === 'dead' || p.state === 'downed') {
        s.intensity = 0;
        continue;
      }
      const cam = this.R.views[i].camera;
      const d = cam.getWorldDirection(_dir);
      s.position.set(p.pos.x + d.x * 0.5, p.pos.y + 1.5, p.pos.z + d.z * 0.5);
      s.target.position.set(s.position.x + d.x * 20, s.position.y + d.y * 20 - 1.2, s.position.z + d.z * 20);
      s.target.updateMatrixWorld();
      s.angle = 0.68;
      s.penumbra = 0.8;
      s.distance = 48;
      s.decay = 1.2;
      s.color.set(0xfff2d4);
      s.intensity = TUNE().flash ?? 260;
    }
    // The nearest few real lamps to each player; the rest are just glowing fittings.
    this.lampPick.length = 0;
    for (const p of this.players) {
      if (!p.alive) continue;
      const near: { k: number; d: number }[] = [];
      m.lights.forEach((l, k) => {
        if (l.dead || this.lampPick.includes(k)) return;
        near.push({ k, d: (l.x - p.pos.x) ** 2 + (l.z - p.pos.z) ** 2 });
      });
      near.sort((a, b) => a.d - b.d);
      for (const n of near.slice(0, LAMPS / 2)) this.lampPick.push(n.k);
    }
    for (let i = 0; i < LAMPS; i++) {
      const lamp = this.lamps[i];
      const k = this.lampPick[i];
      const l = k === undefined ? null : m.lights[k];
      if (!l) {
        lamp.intensity = 0;
        continue;
      }
      const flick = l.flicker > 0 ? 1 - l.flicker * 0.55 * (0.5 + 0.5 * Math.sin(this.time * 17 + k * 3.1) * Math.sin(this.time * 7.3 + k)) : 1;
      lamp.position.set(l.x, l.y, l.z);
      lamp.color.set(l.color);
      lamp.intensity = l.intensity * flick * (TUNE().lamp ?? 0.4);
    }
  }

  // ------------------------------------------------------------------ tick

  protected modeTick(dt: number) {
    if (this.paused) return;
    this.parentTick(dt * 0.5);
    const rec = this.record;
    // Remember who has died, so they stay dead on the next visit.
    for (const s of this.spawned) if (s.zb.dead) rec.killed.add(s.idx);
    // Gunmen only turn up once someone is close enough to see them.
    for (const l of this.lazy) {
      if (l.unit) {
        if (l.unit.dead) rec.killed.add(l.idx);
        continue;
      }
      if (rec.killed.has(l.idx)) continue;
      for (const p of this.players) {
        if (p.alive && Math.hypot(p.pos.x - l.s.x, p.pos.z - l.s.z) < 20) {
          l.unit = this.raiders.spawnInfantry(l.s.kind === 'sniper' ? 'sniper' : 'gunman', l.s.x, l.s.z);
          break;
        }
      }
    }
    // The guardian.
    if (!rec.bossDead && this.bossZ.length && this.bossZ.every((z) => z.dead)) {
      rec.bossDead = true;
      this.view.lift.visible = true;
      this.radio('The guardian is down. A service lift hums to life somewhere nearby.');
      this.notify(-1, 'Guardian defeated: the service lift is running', 'good');
      this.audio.play('bell', this.map.boss.x, this.map.boss.z, 0.8);
      this.checkCleared();
    }
    // Water dripping somewhere in the dark: close to a player, more often in caves and mines than in concrete.
    this.dripT -= dt;
    if (this.dripT <= 0) {
      const wet = this.map.theme === 'cave' || this.map.theme === 'mine';
      this.dripT = (wet ? 1.6 : 4.5) + Math.random() * (wet ? 3.5 : 7);
      const near = this.players.filter((p) => p.alive);
      const p = near[Math.floor(Math.random() * near.length)];
      if (p) {
        const a = Math.random() * Math.PI * 2;
        const r = 4 + Math.random() * 10;
        this.audio.play('drip', p.pos.x + Math.cos(a) * r, p.pos.z + Math.sin(a) * r, 0.45 + Math.random() * 0.4);
      }
    }
    // Spin the loose glints.
    for (const v of this.chestViews.values()) if (v.glint.visible) v.glint.rotation.y += dt * 2.4;
    if (this.keyMesh) this.keyMesh.rotation.y += dt * 1.8;
    // Prompts follow the state of the key.
    for (const ix of this.doorIx) ix.prompt = rec.keyTaken ? 'Hold to unlock the way ahead' : 'Locked: find the key';
    // Both down: carried out, a little poorer.
    const down = this.everyoneDown;
    this.downT = down ? this.downT + dt : 0;
    if (this.downT > 1.8) this.leave('rescue');
  }

  /** The HUD's two lines: loot found and what to do next. */
  hudLine(): { clock: string; tag: string } {
    const rec = this.record;
    const m = this.map;
    const tag = !rec.bossDead
      ? m.doors.length && !rec.keyTaken
        ? 'FIND THE KEY'
        : m.doors.length && rec.doors.size === 0
          ? 'UNLOCK THE DOOR'
          : 'FACE THE GUARDIAN'
      : rec.cleared
        ? 'CLEARED'
        : 'LOOT THE REST';
    return { clock: `${rec.chests.size}/${m.total}`, tag };
  }

  protected updateMusicState() {
    let combat = false;
    for (const p of this.players) {
      this.zombies.forEachNear(p.pos.x, p.pos.z, 22, (z) => {
        if (z.chasing) combat = true;
      });
      for (const u of this.raiders.units) if (!u.dead && Math.hypot(u.x - p.pos.x, u.z - p.pos.z) < 24) combat = true;
    }
    this.audio.setMusic(combat ? 'combat' : 'stealth');
  }

  /** The delve's map: only the ground the party has walked near, so a cave is drawn as it is found. */
  mapModes = 2;
  private frame: MapFrame | null = null;

  mapFrame(pins: CompassPin[]): MapFrame | null {
    let f = this.frame;
    if (!f) {
      f = this.frame = newFrame('delve');
      f.title = this.site.name;
      f.base = newDelveBase(this.map);
      f.bounds = delveBounds(this.map);
      f.radiusMin = 26;
      f.radiusMax = 44;
    }
    for (const p of this.players) if (p.alive) revealDelve(f.base!, this.map, p.pos.x, p.pos.z, 9);
    this.fillMapActors(f, true, 60);
    for (const u of this.units) if (!u.unit.dead && f.blips.length < 80 && this.players.some((p) => p.alive && Math.hypot(u.unit.x - p.pos.x, u.unit.z - p.pos.z) < 40)) f.blips.push({ x: u.unit.x, z: u.unit.z, kind: 'foe' });
    f.pins.length = 0;
    // The way out is always known; everything else shows once the ground under it has been seen.
    for (const p of pins) if (p.kind === 'exit' || known(f.base!, p.x, p.z)) f.pins.push({ x: p.x, z: p.z, kind: p.kind, label: p.label });
    return f;
  }

  /** Chests still shut and the key, felt through the rock. */
  protected senseLoot(p: Player, radius: number, add: (x: number, y: number, z: number, kind: 'loot' | 'chest') => void) {
    const m = this.map;
    const rec = this.record;
    for (const c of m.chests) {
      if (!rec.chests.has(c.id) && Math.hypot(c.x - p.pos.x, c.z - p.pos.z) <= radius) add(c.x, 0.9, c.z, 'chest');
    }
    const k = m.keys[0];
    if (k && !rec.keyTaken && Math.hypot(k.x - p.pos.x, k.z - p.pos.z) <= radius) add(k.x, 0.9, k.z, 'chest');
  }

  compassPins(): CompassPin[] {
    const m = this.map;
    const rec = this.record;
    const pins: CompassPin[] = [{ x: m.exit.x, z: m.exit.z, kind: 'exit', label: 'EXIT' }];
    const near = (x: number, z: number, r: number) => this.players.some((p) => p.alive && Math.hypot(p.pos.x - x, p.pos.z - z) < r);
    for (const c of m.chests) if (!rec.chests.has(c.id) && near(c.x, c.z, 30)) pins.push({ x: c.x, z: c.z, kind: 'chest', label: '$' });
    const k = m.keys[0];
    if (k && !rec.keyTaken && near(k.x, k.z, 48)) pins.push({ x: k.x, z: k.z, kind: 'key', label: 'KEY' });
    for (const d of m.doors) if (!rec.doors.has(d.id)) pins.push({ x: d.x, z: d.z, kind: 'lock', label: 'LOCK' });
    if (rec.bossDead) pins.push({ x: m.lift.x, z: m.lift.z, kind: 'exit', label: 'LIFT' });
    return pins;
  }

  /** The players' state as they leave, to carry back up. */
  carry(): PlayerCarry[] {
    return this.players.map(carryOf);
  }

  dispose() {
    for (const v of this.chestViews.values()) {
      (v.glint.material as THREE.Material).dispose();
    }
    this.view.dispose();
    for (const l of this.lamps) l.dispose();
    super.dispose();
    // The surface goes back to its own light on the next setLight; make sure the sky is on again right away.
    this.R.sky.mesh.visible = true;
  }
}

const _dir = new THREE.Vector3();
/** Dev knobs: set window.__delveTune = { flash, lamp, ambient, exposure } to try other light levels live. */
const TUNE = () => (globalThis as { __delveTune?: Partial<Record<'flash' | 'lamp', number>> }).__delveTune ?? {};

export const THEME_LABEL = { cave: 'Cave', mine: 'Mine', bunker: 'Bunker', metro: 'Metro' } as const;
const THEME_RADIO = {
  cave: 'Cold air from below. Keep your lights low and your voices lower.',
  mine: 'Old timbers, old tunnels. Watch the gates, and listen for the dead.',
  bunker: 'Sealed doors, stale air. Somebody dug in down here and never came out.',
  metro: 'The last train left years ago. Not everyone got off it.',
} as const;

void floorAt;
