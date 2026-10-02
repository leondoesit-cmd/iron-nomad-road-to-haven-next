import * as THREE from 'three';
import { RAPIER, GROUPS, groups, G, type Collider } from '../physics/physics';
import { ENEMIES, LEGS, MERCS, STRUCTURES, VEHICLES, t, type BuildElementDef, type LegDef, type ZombieKind, type RaiderKind } from '../data';
import { MeshBuilder, S } from '../render/builder';
import { drum, heavyGun, plate, spareTyre } from '../render/parts';
import { appendProp } from '../render/props';
import { kitMaterial } from '../render/materials';
import { CampArena } from '../render/campArena';
import { QUALITY } from '../render/renderer';
import { C } from '../render/palette';
import { Btn, heldFor, isHeld, wasPressed, type PlayerIntent } from '../input/intents';
import { campVerdict, nightlyUpkeep, type Merc } from '../sim/loyalty';
import { canAfford, spend, whole } from '../sim/resources';
import { modsOf } from '../sim/parts';
import { convoyPower, pickRaidKind, planRaid } from '../sim/threat';
import { DayClock, lightAt } from '../sim/dayclock';
import { clamp, wrapAngle } from '../core/math';
import { Rng } from '../core/rng';
import type { Aabb, CarSpawn } from '../world/layout';
import { newAabbId } from '../world/layout';
import { Scene, type CompassPin, type SceneServices } from './scene';
import type { Player } from './player';
import type { Vehicle } from './vehicle';
import type { Zombie } from './zombies';
import { escapeHtml, btnLabel } from '../ui/hud';
import { disposeTree } from '../render/dispose';
import { newFrame, type MapFrame } from '../ui/mapdata';

const ARENA = 46;
const SPAWN_R = 98;

interface Structure {
  id: number;
  def: BuildElementDef;
  x: number;
  z: number;
  yaw: number;
  hp: number;
  mesh: THREE.Object3D;
  aabb: Aabb | null;
  collider: Collider | null;
  owner: number;
  cd: number;
  aim: number;
  lit: boolean;
  spent: boolean;
  /** pre-built by the site */
  free: boolean;
}

export interface Report {
  lines: string[];
  crew: string[];
}

type Phase = 'build' | 'night' | 'dawn' | 'ledger';

const SECTOR_NAMES = ['n', 'nw', 'w', 'sw', 's', 'se', 'e', 'ne'];

/** Sector k is centred at angle k * 45 deg. 0 is north (+Z); angles grow toward +X, which is west when facing north. */
export const sectorAngle = (k: number) => (k * Math.PI) / 4;
export function sectorOf(dx: number, dz: number) {
  const a = (Math.atan2(dx, dz) + Math.PI * 2) % (Math.PI * 2);
  return Math.round(a / (Math.PI / 4)) % 8;
}

export class CampScene extends Scene {
  biome: 'wasteland' | 'city';
  mode = 'camp' as const;
  phase: Phase = 'build';
  buildT = STRUCTURES.build.buildSeconds;
  structures: Structure[] = [];
  selected: [number, number] = [0, 0];
  ghost: THREE.Mesh[] = [];
  ghostYaw: [number, number] = [0, 0];
  ghostOk: [boolean, boolean] = [false, false];
  ghostPos: [{ x: number; z: number }, { x: number; z: number }] = [{ x: 0, z: 0 }, { x: 0, z: 0 }];
  watchers: (Player | 'crew' | null)[] = new Array(8).fill(null);
  ready: [boolean, boolean] = [false, false];
  siteName: string;
  report: Report = { lines: [], crew: [] };
  plan!: ReturnType<typeof planRaid>;
  raidKind: 'infected' | 'marauders' | 'both' = 'infected';
  signatureS = 0;
  waveIdx = -1;
  waveT = 0;
  waveActive = false;
  nightT = 0;
  private breakT = 8;
  private alerted = new Set<number>();
  private waveUnits = { zombies: [] as Zombie[], total: 0 };
  private structureByCollider = new Map<number, Structure>();
  private fireT = 0;
  private lostStructures = 0;
  private waveBanner = '';
  private openSectors: number[] = [0, 1, 2, 3, 4, 5, 6, 7];
  private spotlightsOn = 0;
  private arena: CampArena | null = null;
  private rng2: Rng;
  private safeNight = false;
  private legRngSeed: number;
  private raidRng: Rng;
  private vehiclesAtStart = 0;
  private structuresBuilt = 0;
  private waveCleared = 0;
  private kills0 = 0;
  private fires: { x: number; z: number }[] = [];
  private nightStartedAt = 0;
  private idleYaw = 0;
  /** Cars standing in the camp arena: real vehicles you can strip or claim. */
  private campCars: CarSpawn[] = [];
  /** True while the Ledger's garage tab is open: cameras frame each vehicle for a narrow strip. */
  preview = false;
  private ammoCrafted = 0;
  private downBothT = 0;
  private spotCones: THREE.Mesh[] = [];

  constructor(
    svc: SceneServices,
    public leg: LegDef,
    public siteId: string,
    public hot: boolean,
    private ledgerOnly = false,
  ) {
    super(svc);
    this.biome = leg.biome;
    this.siteName = STRUCTURES.sites[siteId]?.name ?? 'Camp';
    this.rng2 = new Rng(leg.seed + svc.campaign.day * 101 + siteId.length);
    this.legRngSeed = leg.seed * 13 + svc.campaign.day;
    this.raidRng = new Rng(this.legRngSeed);
    this.clock = new DayClock(leg.dayLength, ledgerOnly ? 0.04 : 0.8);
    this.clock.frozen = true;
    this.bounds = { minX: -ARENA - 8, maxX: ARENA + 8, minZ: -ARENA - 8, maxZ: ARENA + 8 };
    this.campHook = (p, it, dt) => this.buildInput(p, it, dt);
    this.structureHit = (h, dmg) => this.damageStructureByHandle(h, dmg);
    this.zombies.onObstacleHit = (a, dmg, z) => {
      const s = this.structures.find((q) => q.aabb === a);
      if (s) this.damageStructure(s, dmg * (z.kind === 'brute' ? 1 : 1));
    };
    this.buildArena();
    this.P.step();
    this.spawnConvoyCamp();
    this.cars.everything = true;
    for (const c of this.campCars) this.cars.add(c);
    const hub = leg.endHub ? LEGS.hubs[leg.endHub] : null;
    this.safeNight = !!hub?.safeNight && !ledgerOnly;
    this.planRaid();
    if (ledgerOnly) {
      this.phase = 'ledger';
      this.buildT = 0;
    }
    // Hot camp: a fire with a glow.
    if (hot || ledgerOnly) this.fires.push({ x: 0, z: 1.5 });
    this.R.setLight(lightAt(this.clock.t, this.biome), this.biome);
    for (let i = 0; i < 2; i++) {
      const g = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x66ff88, transparent: true, opacity: 0.4, depthWrite: false }));
      g.visible = false;
      this.root.add(g);
      this.ghost.push(g);
    }
    this.audio.setMusic('camp');
    if (!ledgerOnly) {
      this.radio('Dusk settles. You have three minutes to dig in.');
      this.tip('camp');
      this.assignCrewWatch();
    }
    this.vehiclesAtStart = this.vehicles.filter((v) => v.faction === 'convoy' && !v.wreck).length;
    this.kills0 = this.campaign.stats.zombiesKilled + this.campaign.stats.raidersKilled;
  }

  // ------------------------------------------------------------------ world

  groundAt(): number {
    return 0;
  }

  surfaceAt(): { grip: number; drag: number; name: 'asphalt' | 'hardpan' } {
    const name = this.biome === 'city' ? 'asphalt' : 'hardpan';
    return { ...VEHICLES.surfaces[name], name };
  }

  private box(x: number, z: number, w: number, d: number, h: number, kind: Aabb['kind'] = 'wall', y0 = 0, tint = 2): Aabb {
    const a: Aabb = { id: newAabbId(), minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, y0, y1: y0 + h, kind, hp: 9999, tint };
    this.obs.add(a);
    this.P.addStaticBox(x, y0 + h / 2, z, w / 2, h / 2, d / 2, 0, GROUPS.static);
    return a;
  }

  private buildArena() {
    const city = this.biome === 'city';
    // One flat collider for the ground; the visual ground rises into a basin beyond the raid spawn ring.
    this.P.addStaticBox(0, -0.5, 0, 260, 0.5, 260, 0, GROUPS.static);
    const r = this.rng2;
    const arena = new CampArena(this.biome, r.int(0, 99999));
    this.arena = arena;
    this.root.add(arena.group);
    const decor = new MeshBuilder();
    const site = this.siteId;
    const wall = (x: number, z: number, w: number, d: number, h = 1.5) => {
      this.box(x, z, w, d, h);
      arena.barrier(x, z, w, d, h);
    };
    if (site === 'gasStation') {
      // Station building and canopy with pre-built walls.
      this.box(-20, 14, 14, 8, 4.4);
      for (const px of [-4, 4]) this.box(px, 1, 1.1, 1.1, 1.4, 'crate');
      arena.gasStation();
      wall(-14, -16, 14, 1, 1.4);
      wall(14, -16, 14, 1, 1.4);
      wall(26, -4, 1, 16, 1.4);
      wall(-30, -2, 1, 14, 1.4);
      for (const [x, z] of [[18, 16], [-26, -14]]) this.campCars.push({ id: `camp:car${this.campCars.length}`, x, y: 0, z, yaw: r.range(0, 6), seed: 1 + this.campCars.length * 3 + this.leg.seed });
      this.openSectors = [0, 1, 2, 3, 4, 5, 6, 7];
    } else if (site === 'canyonMouth') {
      // Rock walls east and west, with a choke at the north mouth and a dead end to the south.
      for (const sx of [-1, 1]) {
        this.box(sx * 30, 0, 14, 90, 11, 'rock');
        arena.addRise({ x: sx * 30, z: 0, w: 14, d: 90, h: 11 });
      }
      this.box(0, -50, 80, 14, 11, 'rock');
      arena.addRise({ x: 0, z: -50, w: 80, d: 14, h: 11 });
      for (const sx of [-1, 1]) {
        this.box(sx * 20, 44, 22, 8, 8, 'rock');
        arena.addRise({ x: sx * 20, z: 44, w: 22, d: 8, h: 8 });
      }
      // Boulders fallen from the walls.
      for (let i = 0; i < 16; i++) {
        const sx = i % 2 ? 1 : -1;
        arena.boulder(sx * r.range(22.5, 24), r.range(-40, 38), r.range(1.6, 3.4), i, r.range(0, 6));
      }
      // Open ground: raids come through north, north-east and north-west only.
      this.openSectors = [0, 1, 7];
      this.bounds = { minX: -ARENA + 6, maxX: ARENA - 6, minZ: -ARENA + 4, maxZ: ARENA + 6 };
    } else if (site === 'carPark') {
      for (let ix = -2; ix <= 2; ix++) for (let iz = -2; iz <= 2; iz++) {
        if (ix === 0 && iz === 0) continue;
        this.box(ix * 11, iz * 11, 2, 2, 5, 'pillar');
      }
      // Perimeter wall with three ramps (N, E, S) left open.
      const edge = 30;
      for (const sx of [-1, 1]) {
        wall(sx * (edge - 8), edge, 16, 1.2, 2.2);
        wall(sx * (edge - 8), -edge, 16, 1.2, 2.2);
      }
      wall(-edge, 0, 1.2, 40, 2.2);
      wall(edge, -22, 1.2, 12, 2.2);
      wall(edge, 22, 1.2, 12, 2.2);
      arena.carPark();
      this.openSectors = [0, 1, 4, 5, 6, 7, 3];
    } else if (site === 'plaza') {
      const ringR = 32;
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const sec = sectorOf(Math.sin(a), Math.cos(a));
        if ([0, 2, 4, 6].includes(sec) && k % 2 === 0 && Math.abs(Math.round(a / (Math.PI / 2)) * (Math.PI / 2) - a) < 0.3) continue; // gaps N,E,S,W
        wall(Math.sin(a) * ringR, Math.cos(a) * ringR, 7.5, 1.2, 1.4);
      }
      arena.plaza();
      for (const [x, z] of [[-10, 12], [12, -10]]) this.campCars.push({ id: `camp:car${this.campCars.length}`, x, y: 0, z, yaw: r.range(0, 6), seed: 2 + this.campCars.length * 3 + this.leg.seed });
      this.openSectors = [0, 1, 2, 3, 4, 5, 6, 7];
    } else {
      // Flats: open ground, a few rocks to hide behind.
      for (const [x, z, s] of [[-22, 18, 3], [24, -16, 3.4], [-14, -26, 2.6]]) {
        this.box(x, z, s * 1.6, s * 1.6, 3.4, 'rock');
        arena.boulder(x, z, s * 1.25, Math.round(s * 3), s);
      }
    }
    arena.buildGround();
    // Debris strewn across the camp, clear of anything solid.
    const solid = (x: number, z: number, rad: number) => {
      let hit = false;
      this.obs.near(x, z, rad, (a) => {
        if (x > a.minX - rad && x < a.maxX + rad && z > a.minZ - rad && z < a.maxZ + rad) hit = true;
      });
      return hit || Math.hypot(x, z - 1.5) < 4;
    };
    for (let i = 0; i < 70; i++) {
      const a = r.range(0, Math.PI * 2);
      const d = r.range(9, 108);
      const x = Math.cos(a) * d;
      const z = Math.sin(a) * d;
      if (solid(x, z, 2)) continue;
      if (city) appendProp(decor, { kind: r.pick(['rubble', 'barrel', 'tires', 'dumpster']), x, y: 0, z, yaw: r.range(0, 6), scale: 1, seed: r.int(0, 99) });
      else appendProp(decor, { kind: r.pick(['rock', 'rock', 'bones', 'deadTree', 'tires']), x, y: 0, z, yaw: r.range(0, 6), scale: r.range(0.8, 1.8), seed: r.int(0, 99) });
    }
    const dm = new THREE.Mesh(decor.build(), kitMaterial());
    dm.castShadow = true;
    dm.receiveShadow = true;
    this.root.add(dm);
    // A fire ring for the hot camp, and ground cover everywhere else.
    arena.fireRing(0, 1.5);
    arena.scatter(solid, QUALITY[this.R.quality].scatter);
    arena.finish();
  }

  private spawnConvoyCamp() {
    const slots: [number, number, number][] = [[-9, -4, 0.5], [9, -4, -0.5]];
    const names = this.campaign.players.map((p) => p.name);
    void names;
    this.spawnConvoy(0, 0, 0, 1, false);
    // Park each player's vehicle at its perimeter slot and place the player beside it.
    this.players.forEach((p, i) => {
      const [x, z, yaw] = slots[i];
      const v = p.ownVehicle;
      if (v) {
        v.body.setPose(x, 1.2, z, yaw);
        v.setEngine(false);
      }
      p.placeAt(x + (i === 0 ? 3 : -3), z + 1.5, yaw);
      p.buildMode = !this.ledgerOnly;
    });
    for (const m of this.campaign.crewLive) {
      const u = this.crew.spawn(m, 0, -12, 0);
      if (u) {
        u.vehicle.body.setPose(0, 1.2, -12, 0);
        u.vehicle.setEngine(true);
      }
    }
    this.crew.anchor = { x: 0, z: -9 };
  }

  private assignCrewWatch() {
    if (this.crew.units.length) this.watchers[4] = 'crew';
  }

  /** Called by the Ledger after upgrades: rebuild each player's vehicle from the campaign data. */
  refreshVehicles() {
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      const old = p.ownVehicle;
      let x = -9 + i * 18;
      let z = -4;
      let yaw = i === 0 ? 0.5 : -0.5;
      if (old) {
        x = old.position.x;
        z = old.position.z;
        yaw = old.yaw;
        const k = this.vehicles.indexOf(old);
        if (k >= 0) this.vehicles.splice(k, 1);
        old.destroy();
      }
      const v = this.spawnVehicle({ build: this.campaign.buildOf(i), x, z, yaw, ownerIndex: i });
      v.setEngine(false);
      p.ownVehicle = v;
    }
  }

  enterLedgerMode() {
    this.phase = 'ledger';
    this.clock.elapsed = 0.04 * this.clock.dayLength;
    this.zombies.list.length = 0;
    this.raiders.clearAll();
    for (const p of this.players) p.buildMode = false;
    for (const g of this.ghost) g.visible = false;
    this.paused = false;
    this.audio.setMusic('camp');
    for (const p of this.players) {
      p.hp = p.maxHp;
      if (p.state === 'downed' || p.state === 'dead') {
        p.state = 'foot';
        p.hp = p.maxHp;
      }
    }
  }

  /** Ledger backdrop: the camp at dawn, with a slow orbit around each player's vehicle. */
  tickIdle(dt: number) {
    this.idleCam = true;
    this.time += dt;
    this.idleYaw += dt * 0.12;
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      const v = p.ownVehicle;
      const px = v ? v.position.x : p.pos.x;
      const pz = v ? v.position.z : p.pos.z;
      // The garage preview is a narrow strip, so the camera backs off far enough to fit the whole vehicle.
      p.cam.update(dt, { x: px, y: 0, z: pz, yaw: this.idleYaw + i * Math.PI, speed: 0, topSpeed: 10 }, 'camp', {
        dist: this.preview ? (v ? v.def.length * 2.9 + 2 : 12) : v ? v.def.camera.dist * 1.1 : 6,
        height: this.preview ? (v ? v.def.camera.height * 1.1 : 3) : v ? v.def.camera.height : 3,
        aimYaw: 0,
        aimPitch: 0,
        lookYaw: 0,
        lookPitch: 0,
        shoulder: 0,
        lookBack: false,
        zoom: 0,
      });
      p.prevPos.copy(p.pos);
    }
    for (const v of this.vehicles) v.snapshotPrev();
    // Parked vehicles still run their suspension, so cars with real ground clearance sit at the right height.
    for (const v of this.vehicles) v.update(dt);
    this.cars.update(dt);
    this.P.step();
    this.fx.fire(0, 0.3, 1.5, 0.9);
    if (Math.random() < 0.2) this.fx.blackSmoke(0, 0.9, 1.5);
  }

  // ------------------------------------------------------------------ raid planning

  private campSignature(): number {
    const site = STRUCTURES.sites[this.siteId];
    let s = site.exposure * 52;
    s += this.hot ? 28 : 6;
    s += this.spotlightsOn * STRUCTURES.build.elements.find((e) => e.id === 'spotlight')!.signature!;
    s *= this.hot ? STRUCTURES.raids.hot.signatureMult : STRUCTURES.raids.cold.signatureMult;
    return clamp(s, 0, 100);
  }

  private planRaid() {
    this.signatureS = this.campSignature();
    const veh = this.vehicles.filter((v) => v.faction === 'convoy' && v.kind === 'player').map((v) => ({ tier: v.def.tier, moduleLevels: v.build ? Object.values(modsOf(v.build.fit)).reduce((a, b) => a + b, 0) : 0 }));
    const power = convoyPower(veh, this.campaign.crewLive.length, this.structures.filter((s) => s.def.id === 'turret').length);
    this.raidKind = pickRaidKind(this.biome, this.signatureS, this.raidRng);
    this.plan = planRaid({
      base: this.leg.baseThreat,
      signature: this.signatureS,
      notoriety: clamp(this.campaign.axes.notoriety * 3.5, 0, 100),
      power,
      kind: this.raidKind,
      seed: this.legRngSeed,
    });
    // Only open sectors can be raided (canyon walls close the others).
    for (const w of this.plan.waves) {
      w.sectors = w.sectors.map((s) => (this.openSectors.includes(s) ? s : this.openSectors[(s + this.raidRng.int(0, 7)) % this.openSectors.length]));
    }
  }

  // ------------------------------------------------------------------ structures

  private elements() {
    return STRUCTURES.build.elements;
  }

  private groundPoint(p: Player): { x: number; z: number } {
    const cam = this.R.views[p.index].camera;
    cam.updateMatrixWorld();
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    const o = cam.position;
    let x: number;
    let z: number;
    if (dir.y < -0.05) {
      const tt = -o.y / dir.y;
      x = o.x + dir.x * tt;
      z = o.z + dir.z * tt;
    } else {
      x = p.pos.x + Math.sin(p.aimYaw) * 7;
      z = p.pos.z + Math.cos(p.aimYaw) * 7;
    }
    // Reach limit
    const dx = x - p.pos.x;
    const dz = z - p.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > 14) {
      x = p.pos.x + (dx / d) * 14;
      z = p.pos.z + (dz / d) * 14;
    }
    const snap = STRUCTURES.build.snap;
    return { x: Math.round(x / snap) * snap, z: Math.round(z / snap) * snap };
  }

  private canPlace(def: BuildElementDef, x: number, z: number, yaw: number): boolean {
    if (Math.hypot(x, z) > ARENA) return false;
    const [sx, , sz] = def.size;
    const rot = Math.round(yaw / (Math.PI / 2)) % 2 !== 0;
    const hx = (rot ? sz : sx) / 2;
    const hz = (rot ? sx : sz) / 2;
    for (const s of this.structures) {
      const [ax, , az] = s.def.size;
      const r2 = Math.round(s.yaw / (Math.PI / 2)) % 2 !== 0;
      const shx = (r2 ? az : ax) / 2;
      const shz = (r2 ? ax : az) / 2;
      if (Math.abs(s.x - x) < hx + shx - 0.05 && Math.abs(s.z - z) < hz + shz - 0.05) return false;
    }
    for (const v of this.vehicles) {
      if (Math.hypot(v.position.x - x, v.position.z - z) < v.def.length * 0.5 + Math.max(hx, hz) + 0.2) return false;
    }
    let blocked = false;
    this.obs.near(x, z, Math.max(hx, hz) + 1, (a) => {
      if (x + hx > a.minX && x - hx < a.maxX && z + hz > a.minZ && z - hz < a.maxZ) blocked = true;
    });
    if (blocked) return false;
    for (const p of this.players) if (Math.hypot(p.pos.x - x, p.pos.z - z) < Math.max(hx, hz) + 0.6) return false;
    return canAfford(this.campaign.stocks, def.cost);
  }

  private place(def: BuildElementDef, x: number, z: number, yaw: number, owner: number, free = false): Structure | null {
    if (!free && !spend(this.campaign.stocks, def.cost)) return null;
    const [sx, sy, sz] = def.size;
    const rot = Math.round(yaw / (Math.PI / 2)) % 2 !== 0;
    const hx = (rot ? sz : sx) / 2;
    const hz = (rot ? sx : sz) / 2;
    const b = new MeshBuilder();
    b.jitter = 0.06;
    buildElementMesh(b, def, sx, sy, sz);
    const mesh = new THREE.Mesh(b.build(), kitMaterial());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.set(x, 0, z);
    mesh.rotation.y = rot ? Math.PI / 2 : 0;
    this.root.add(mesh);
    let aabb: Aabb | null = null;
    let collider: Collider | null = null;
    if (def.blocks) {
      aabb = { id: newAabbId(), minX: x - hx, maxX: x + hx, minZ: z - hz, maxZ: z + hz, y0: 0, y1: sy, kind: 'barricade', breakable: 'flimsy', hp: def.hp, tint: 0 };
      this.obs.add(aabb);
      collider = this.P.addStaticBox(x, sy / 2, z, hx, sy / 2, hz, 0, groups(G.BUILD, G.VEHICLE | G.PLAYER));
    }
    const s: Structure = { id: newAabbId(), def, x, z, yaw, hp: def.hp, mesh, aabb, collider, owner, cd: 0, aim: 0, lit: false, spent: false, free };
    this.structures.push(s);
    if (collider) this.structureByCollider.set(collider.handle, s);
    this.structuresBuilt++;
    this.audio.play('build', x, z, 0.8);
    return s;
  }

  private removeStructure(s: Structure, refund: boolean) {
    const i = this.structures.indexOf(s);
    if (i < 0) return;
    this.structures.splice(i, 1);
    if (s.aabb) this.obs.remove(s.aabb);
    if (s.collider) {
      this.structureByCollider.delete(s.collider.handle);
      this.P.removeCollider(s.collider);
    }
    disposeTree(s.mesh);
    s.mesh.removeFromParent();
    if (refund && !s.free) {
      for (const [k, v] of Object.entries(s.def.cost)) {
        const id = (k === 'fu' ? 'fuel' : k) as keyof typeof this.campaign.stocks;
        this.campaign.stocks[id] += Math.floor((v ?? 0) * 0.5);
      }
    }
  }

  private damageStructureByHandle(handle: number, dmg: number) {
    const s = this.structureByCollider.get(handle);
    if (s) this.damageStructure(s, dmg);
  }

  private damageStructure(s: Structure, dmg: number) {
    s.hp -= dmg;
    if (s.hp <= 0) {
      this.lostStructures++;
      this.fx.explosion(s.x, 0.8, s.z, 0.4);
      this.audio.play('crash', s.x, s.z, 0.7);
      this.removeStructure(s, false);
    }
  }

  breakBarricade(a: Aabb) {
    const s = this.structures.find((q) => q.aabb === a);
    if (s) this.damageStructure(s, 9999);
  }

  /** Build-mode controls: RT place, LT remove, RB/LB cycle, A rotate, X watch post, hold B to be ready. */
  private buildInput(p: Player, it: PlayerIntent, dt: number): boolean {
    if (this.phase !== 'build' && this.phase !== 'night') return false;
    const i = p.index;
    const els = this.elements();
    if (this.phase === 'build') {
      // Pads cycle with RB/LB. On the keyboard the single fire key is also RB, so it uses the dedicated Z/X (or ;/') keys.
      const kb = it.device === 'keyboard';
      if (wasPressed(it, kb ? Btn.Right : Btn.RB)) this.selected[i] = (this.selected[i] + 1) % els.length;
      if (wasPressed(it, kb ? Btn.Left : Btn.LB)) this.selected[i] = (this.selected[i] + els.length - 1) % els.length;
      if (wasPressed(it, Btn.A) && !p.prompt) this.ghostYaw[i] = (this.ghostYaw[i] + Math.PI / 2) % (Math.PI * 2);
      const pt = this.groundPoint(p);
      this.ghostPos[i] = pt;
      const def = els[this.selected[i]];
      this.ghostOk[i] = this.canPlace(def, pt.x, pt.z, this.ghostYaw[i]);
      if (wasPressed(it, Btn.RT) || (it.device === 'keyboard' && wasPressed(it, Btn.RB) && false)) {
        if (this.ghostOk[i]) {
          const s = this.place(def, pt.x, pt.z, this.ghostYaw[i], i);
          if (s) this.afterPlace(s);
        } else if (!canAfford(this.campaign.stocks, def.cost)) {
          p.note('Not enough stock', 'warn');
          this.audio.play('deny');
        } else this.audio.play('deny');
      }
      if (wasPressed(it, Btn.LT)) {
        // Remove the nearest structure near the reticle.
        let best: Structure | null = null;
        let bd = 3.2;
        for (const s of this.structures) {
          const d = Math.hypot(s.x - pt.x, s.z - pt.z);
          if (d < bd) {
            bd = d;
            best = s;
          }
        }
        if (best && !best.free) {
          this.removeStructure(best, true);
          this.audio.play('build', pt.x, pt.z, 0.6);
          p.note('Removed (50% refunded)', 'info');
        }
      }
      // Hold B to be ready.
      if (isHeld(it, Btn.B) && heldFor(it, Btn.B) > 1.1 && !this.ready[i]) {
        this.ready[i] = true;
        p.note(this.campaign.solo ? 'Ready for nightfall' : 'Ready for nightfall: waiting for your partner', 'good');
      }
    }
    // X: assign a watch post in the sector you are standing in.
    if (wasPressed(it, Btn.X)) {
      const sec = sectorOf(-p.pos.x, p.pos.z);
      // sectorOf treats +X as sector 'w' consistently with the compass (north is +Z, left is +X)
      const s2 = sectorOf(p.pos.x, p.pos.z);
      void sec;
      const idx = this.watchers.findIndex((w) => w === p);
      if (idx === s2) {
        this.watchers[s2] = null;
        p.note('Watch post cleared', 'info');
      } else {
        if (idx >= 0) this.watchers[idx] = null;
        this.watchers[s2] = p;
        p.note(`Watching ${SECTOR_NAMES[s2].toUpperCase()}: you will hear raids at ${STRUCTURES.watchDetect} m`, 'good');
        this.audio.play('confirm');
      }
    }
    void dt;
    return true;
  }

  private afterPlace(s: Structure) {
    if (s.def.id === 'spotlight') this.spotlightsOn = this.structures.filter((q) => q.def.id === 'spotlight').length;
    this.planRaid();
  }

  buildHud(p: Player): string {
    if (this.phase !== 'build') {
      if (this.phase === 'night') {
        const w = this.waveIdx >= 0 ? STRUCTURES.raids.waves[Math.min(this.waveIdx, 2)] : 'Quiet';
        return `<div class="el on">NIGHT · ${w.toUpperCase()}</div><div class="el">${this.waveActive ? this.enemiesLeft() + ' LEFT' : 'NEXT WAVE SOON'}</div>`;
      }
      return '';
    }
    const els = this.elements();
    const sel = this.selected[p.index];
    const def = els[sel];
    const cost = Object.entries(def.cost).map(([k, v]) => `${v} ${k === 'fu' ? 'FU' : k.toUpperCase()}`).join(' · ');
    const ok = this.ghostOk[p.index];
    const w = this.watchers.findIndex((q) => q === p);
    const slot = this.input.slots[p.index];
    const prevK = slot?.kind === 'kb' ? (slot.set === 1 ? 'Z' : ';') : 'LB';
    const nextK = slot?.kind === 'kb' ? (slot.set === 1 ? 'X' : "'") : 'RB';
    return `<div class="el">◀ ${prevK}</div><div class="el on">${escapeHtml(def.name.toUpperCase())}</div><div class="el">${nextK} ▶</div><div class="el">${escapeHtml(cost)}</div><div class="el" style="color:${ok ? '#7ddc7a' : '#ff8a7a'}">${ok ? 'CAN PLACE' : 'BLOCKED'}</div><div class="el">${w >= 0 ? 'WATCH ' + SECTOR_NAMES[w].toUpperCase() : btnLabel(slot, 'X') + ': WATCH POST'}</div>`;
  }

  private enemiesLeft() {
    return this.zombies.aliveCount + this.raiders.totalAlive;
  }

  // ------------------------------------------------------------------ night

  private startNight() {
    this.phase = 'night';
    this.nightT = 0;
    this.nightStartedAt = this.time;
    for (const g of this.ghost) g.visible = false;
    for (const p of this.players) {
      p.buildMode = false;
      p.equip = 'pistol';
    }
    this.clock.frozen = false;
    this.clock.elapsed = 0.9 * this.clock.dayLength;
    this.planRaid();
    this.spotlightsOn = this.structures.filter((s) => s.def.id === 'spotlight').length;
    // Spotlights burn fuel at night.
    const fuelNeed = this.spotlightsOn;
    const hasFuel = this.campaign.stocks.fuel >= fuelNeed;
    if (this.hot && hasFuel) this.campaign.stocks.fuel -= fuelNeed;
    for (const s of this.structures) s.lit = s.def.id === 'spotlight' && this.hot && hasFuel;
    // The Mechanic crafts ammo for the night.
    const mech = this.crew.units[0];
    if (mech && this.campaign.stocks.scrap >= 20 && this.campaign.ammo < 250) {
      this.campaign.stocks.scrap -= 10;
      this.campaign.ammo += 60;
      this.ammoCrafted = 60;
      this.radio('Mechanic: "Ran off some ammo while you were building."');
    }
    this.audio.setMusic('raid');
    this.audio.play('alarm');
    if (this.safeNight) {
      this.radio('Rustgate has walls and guards. The night is quiet.');
      this.plan.waves.forEach((w) => {
        w.zombies = [];
        w.raiders = [];
      });
    } else this.radio(`Nightfall. ${this.raidKind === 'infected' ? 'The infected are coming' : this.raidKind === 'marauders' ? 'Marauders on the horizon' : 'Both the dead and the raiders are out there'}.`);
    this.waveIdx = -1;
    this.breakT = 6;
  }

  private spawnWave(idx: number) {
    const wave = this.plan.waves[idx];
    this.waveIdx = idx;
    this.waveT = 0;
    this.waveActive = true;
    this.alerted.clear();
    this.waveBanner = `WAVE ${idx + 1}: ${wave.name.toUpperCase()}`;
    const r = this.raidRng;
    const sectors = wave.sectors;
    const place = (sector: number) => {
      const a = sectorAngle(sector) + r.range(-0.3, 0.3);
      // Sector angle runs toward -X, matching sectorOf.
      const d = SPAWN_R + r.range(-6, 10);
      return { x: Math.sin(a) * d, z: Math.cos(a) * d };
    };
    let n = 0;
    for (const kind of wave.zombies) {
      const sec = sectors[n++ % sectors.length];
      const p = place(sec);
      const zb = this.zombies.spawn(kind as ZombieKind, p.x, p.z, false, 9000 + idx);
      zb.state = 'swarm';
      zb.raid = true;
      zb.hasTarget = true;
      zb.tx = 0;
      zb.tz = 0;
      this.waveUnits.zombies.push(zb);
    }
    for (const kind of wave.raiders) {
      const sec = sectors[n++ % sectors.length];
      const p = place(sec);
      const yaw = Math.atan2(-p.x, -p.z);
      this.spawnRaider(kind, p.x, p.z, yaw);
    }
    this.waveUnits.total = wave.zombies.length + wave.raiders.length;
    this.zombies.raidTarget = { x: 0, z: 0 };
    this.audio.play('alarm');
    this.hudBanner(this.waveBanner);
    // Watchers call the direction.
    for (const sec of sectors) {
      if (this.watchers[sec]) {
        this.radio(t(`radio.contact.${SECTOR_NAMES[sec]}`));
        this.alerted.add(sec);
      }
    }
  }

  private spawnRaider(kind: RaiderKind, x: number, z: number, yaw: number) {
    if (kind === 'buggy') this.raiders.spawnBuggy(x, z, yaw);
    else if (kind === 'wagon') this.raiders.spawnWagon(x, z, yaw);
    else this.raiders.spawnInfantry(kind, x, z);
  }

  private hudBanner(text: string) {
    const [a, b] = text.split(': ');
    this.services.onBanner?.(a, b ?? '');
  }

  // ------------------------------------------------------------------ tick

  protected modeTick(dt: number) {
    if (this.phase === 'ledger') return;
    // Camp Signature shown on every HUD.
    this.signatureS = this.campSignature();
    for (const p of this.players) p.signatureShown = Math.round(this.signatureS);
    // Camp noise lets enemies find the camp.
    this.sig.emit(0, 0, this.signatureS * 0.9, 'noise');
    this.sig.emit(0, 0, this.signatureS, 'dust');
    this.updateStructures(dt);
    this.updateFire(dt);
    if (this.phase === 'build') {
      this.buildT -= dt;
      this.clock.frozen = true;
      // Clock sinks toward dark through the build phase.
      this.clock.elapsed = (0.8 + 0.1 * (1 - this.buildT / STRUCTURES.build.buildSeconds)) * this.clock.dayLength;
      const live = this.players.filter((p) => p.state !== 'dead');
      const allReady = live.every((p) => this.ready[p.index]);
      if (this.buildT <= 0 || (allReady && live.length)) this.startNight();
      this.updateGhosts();
    } else if (this.phase === 'night') {
      this.updateNight(dt);
    }
    // Camp failure: both down.
    const down = this.everyoneDown;
    this.downBothT = down ? this.downBothT + dt : 0;
    if (this.downBothT > 1.5) {
      this.downBothT = -999;
      this.onResult({ type: 'fail', reason: this.campaign.solo ? 'You bled out defending the camp.' : 'You both went down defending the camp.' });
    }
  }

  private updateGhosts() {
    for (const p of this.players) {
      const g = this.ghost[p.index];
      const els = this.elements();
      const def = els[this.selected[p.index]];
      const [sx, sy, sz] = def.size;
      const rot = Math.round(this.ghostYaw[p.index] / (Math.PI / 2)) % 2 !== 0;
      g.visible = p.buildMode && p.state === 'foot';
      g.scale.set(rot ? sz : sx, sy, rot ? sx : sz);
      const pt = this.ghostPos[p.index];
      g.position.set(pt.x, sy / 2, pt.z);
      (g.material as THREE.MeshBasicMaterial).color.setHex(this.ghostOk[p.index] ? 0x66ff88 : 0xff6655);
    }
  }

  private updateNight(dt: number) {
    this.nightT += dt;
    if (this.waveIdx < 0) {
      this.breakT -= dt;
      if (this.breakT <= 0) {
        if (this.safeNight) return this.dawn();
        this.spawnWave(0);
      }
      return;
    }
    this.waveT += dt;
    this.detectRaids();
    const left = this.enemiesLeft();
    if (this.waveActive && (left === 0 || this.waveT > STRUCTURES.raids.waveSeconds * 2.2)) {
      this.waveActive = false;
      this.breakT = 6;
      this.waveCleared++;
      if (this.waveIdx >= 2) {
        // Dawn follows the final wave once the camp is quiet.
        if (left === 0) this.dawn();
        else if (this.waveT > STRUCTURES.raids.waveSeconds * 2.6) this.dawn();
        this.waveActive = left > 0;
      } else this.radio(`Wave ${this.waveIdx + 1} is down. Reload and repair.`);
    } else if (!this.waveActive) {
      this.breakT -= dt;
      if (this.breakT <= 0 && this.waveIdx < 2) this.spawnWave(this.waveIdx + 1);
    } else if (this.waveIdx >= 2 && this.waveT > STRUCTURES.raids.waveSeconds * 2.6) {
      this.dawn();
    }
  }

  /** Watched sectors hear raids at 80 m; unwatched ones get no warning until enemies are at 25 m. */
  private detectRaids() {
    const check = (x: number, z: number) => {
      const d = Math.hypot(x, z);
      const sec = sectorOf(x, z);
      if (this.alerted.has(sec)) return;
      const watched = !!this.watchers[sec];
      if (watched && d < STRUCTURES.watchDetect) {
        this.alerted.add(sec);
        this.radio(t(`radio.contact.${SECTOR_NAMES[sec]}`));
        this.fx.puff(x, 3, z, 1, 0.9, 0.3, 2, 1);
      } else if (!watched && d < STRUCTURES.unwatchedDetect) {
        this.alerted.add(sec);
        this.radio(t('radio.inside'));
        this.audio.play('alarm');
      }
    };
    this.zombies.forEachNear(0, 0, 110, (z) => check(z.x, z.z));
    for (const u of this.raiders.units) if (!u.dead) check(u.x, u.z);
    for (const v of this.vehicles) if (v.faction === 'raider' && !v.wreck) check(v.position.x, v.position.z);
  }

  private updateStructures(dt: number) {
    const night = this.phase === 'night';
    for (const s of this.structures.slice()) {
      s.cd -= dt;
      switch (s.def.id) {
        case 'wire':
          this.updateWire(s, dt);
          break;
        case 'spikes':
          this.updateSpikes(s);
          break;
        case 'drum':
        case 'mine':
          if (night) this.updateTrap(s);
          break;
        case 'turret':
          if (night) this.updateTurret(s, dt);
          break;
        case 'spotlight':
          this.updateSpot(s);
          break;
      }
    }
    // Destroyed barricade panels leave no collider; nothing more to do.
  }

  private rectOf(s: Structure) {
    const [sx, , sz] = s.def.size;
    const rot = Math.round(s.yaw / (Math.PI / 2)) % 2 !== 0;
    return { hx: (rot ? sz : sx) / 2, hz: (rot ? sx : sz) / 2 };
  }

  private updateWire(s: Structure, dt: number) {
    const { hx, hz } = this.rectOf(s);
    const def = s.def;
    this.zombies.forEachNear(s.x, s.z, 4, (z) => {
      if (Math.abs(z.x - s.x) < hx + 0.3 && Math.abs(z.z - s.z) < hz + 0.3) {
        z.slow = Math.min(z.slow, 1 - (def.slow ?? 0.6));
        this.zombies.damage(z, (def.dps ?? 5) * dt, { fromX: s.x, fromZ: s.z, fire: false });
      }
    });
  }

  private updateSpikes(s: Structure) {
    const { hx, hz } = this.rectOf(s);
    for (const v of this.vehicles) {
      if (v.faction !== 'raider' || v.wreck || s.spent) continue;
      if (Math.abs(v.position.x - s.x) < hx + v.def.width / 2 && Math.abs(v.position.z - s.z) < hz + v.def.length / 2) {
        const idx = this.raidRng.int(0, v.body.wheelCount - 1);
        v.health.comp.tires[idx] = 0;
        v.takeHit(4, s.x, s.z, { silent: true, wheel: idx });
        this.fx.spark(s.x, 0.3, s.z, 8, 5);
        this.audio.play('crash', s.x, s.z, 0.6);
        this.radio('Spike strip got one!');
        s.spent = true;
        this.damageStructure(s, 9999);
      }
    }
  }

  private updateTrap(s: Structure) {
    const trigger = s.def.id === 'mine' ? 1.1 : 2.0;
    let go = false;
    this.zombies.forEachNear(s.x, s.z, trigger + 0.5, (z) => {
      if (Math.hypot(z.x - s.x, z.z - s.z) < trigger) go = true;
    });
    for (const u of this.raiders.units) if (!u.dead && Math.hypot(u.x - s.x, u.z - s.z) < trigger) go = true;
    for (const v of this.vehicles) if (v.faction === 'raider' && !v.wreck && Math.hypot(v.position.x - s.x, v.position.z - s.z) < trigger + v.def.width / 2) go = true;
    if (!go) return;
    const def = s.def;
    this.combat.explode(s.x, 0.6, s.z, def.radius ?? 5, def.damage ?? 150, { side: 'convoy', owner: null });
    if (s.def.id === 'drum') this.projectiles.burners.push({ kind: 'fire', x: s.x, z: s.z, r: 3.6, t: 6, tick: 0, owner: null });
    this.removeStructure(s, false);
  }

  private updateTurret(s: Structure, dt: number) {
    const def = s.def;
    const lit = this.structures.some((q) => q.def.id === 'spotlight' && q.lit && Math.hypot(q.x - s.x, q.z - s.z) < 24);
    const range = this.night > 0.5 && !lit && this.hot === false ? 22 : (def.range ?? 42) * (this.night > 0.5 && !lit ? 0.6 : 1);
    let best: { x: number; y: number; z: number; d: number } | null = null;
    const consider = (x: number, y: number, z: number) => {
      const d = Math.hypot(x - s.x, z - s.z);
      if (d < range && (!best || d < best.d)) best = { x, y, z, d };
    };
    this.zombies.forEachNear(s.x, s.z, range, (z) => consider(z.x, z.y + 1.2, z.z));
    this.raiders.forEachTarget(s.x, s.z, range, (x, y, z) => consider(x, y, z));
    const tgt = best as { x: number; y: number; z: number; d: number } | null;
    if (!tgt) return;
    s.aim = Math.atan2(tgt.x - s.x, tgt.z - s.z);
    s.mesh.children.forEach((c) => {
      if (c.name === 'barrel') c.rotation.y = s.aim - s.mesh.rotation.y;
    });
    if (s.cd > 0 || this.campaign.ammo <= 0) return;
    s.cd = 0.24;
    if (this.raidRng.chance(0.08)) this.campaign.ammo--;
    const oy = 1.2;
    const dx = tgt.x - s.x;
    const dy = tgt.y - oy;
    const dz = tgt.z - s.z;
    const l = Math.hypot(dx, dy, dz);
    this.combat.shoot(s.x, oy, s.z, dx / l, dy / l, dz / l, { side: 'convoy', damage: (def.dps ?? 38) * 0.24, spread: 0.03, range: range + 6, tracer: true, noise: 55 });
    this.fx.flash(s.x + Math.sin(s.aim) * 0.9, oy, s.z + Math.cos(s.aim) * 0.9, 1);
    this.audio.play('mg', s.x, s.z, 0.5);
    void dt;
  }

  private updateSpot(s: Structure) {
    const cone = s.mesh.children.find((c) => c.name === 'cone');
    if (cone) cone.visible = s.lit && this.night > 0.3;
    // Sweep slowly.
    if (s.lit) {
      s.aim += 0.004;
      s.mesh.rotation.y = s.aim;
    }
  }

  private updateFire(dt: number) {
    this.fireT += dt;
    if (!this.hot) return;
    for (const f of this.fires) {
      this.fx.fire(f.x, 0.3, f.z, 0.9);
      if (this.fireT > 0.2 && Math.random() < 0.3) this.fx.blackSmoke(f.x, 1.0, f.z);
    }
    if (this.fireT > 0.2) this.fireT = 0;
  }

  // ------------------------------------------------------------------ dawn

  private dawn() {
    if (this.phase === 'dawn') return;
    this.phase = 'dawn';
    this.waveActive = false;
    this.clock.frozen = true;
    this.clock.elapsed = 0.04 * this.clock.dayLength;
    this.raiders.clearAll();
    for (const z of this.zombies.list) z.dead = true;
    this.zombies.list.length = 0;
    this.projectiles.clear();
    const c = this.campaign;
    c.stats.nights++;
    const lines: string[] = [];
    const crew: string[] = [];
    const hub = this.leg.endHub ? LEGS.hubs[this.leg.endHub] : null;
    lines.push(`${hub?.safeNight ? 'A safe night at ' + hub.name : 'Night ' + c.day + ' at the ' + this.siteName}. ${this.safeNight ? 'No raid came.' : `Raid type: ${this.raidKind}. Threat ${this.plan.threat}.`}`);
    if (!this.safeNight) lines.push(`Camp Signature ${Math.round(this.signatureS)} (${this.hot ? 'hot' : 'cold'} camp). Waves faced: ${Math.min(3, this.waveCleared + (this.waveActive ? 1 : 0))}/3.`);
    const kills = c.stats.zombiesKilled + c.stats.raidersKilled - this.kills0;
    if (!this.safeNight) lines.push(`${kills} enemies put down. ${this.lostStructures} structures lost. ${this.vehiclesAtStart - this.vehicles.filter((v) => v.faction === 'convoy' && v.kind === 'player' && !v.wreck).length} vehicles lost.`);
    if (this.ammoCrafted) lines.push(`The Mechanic crafted ${this.ammoCrafted} rounds.`);
    // Fatigue from watch duty.
    for (const w of this.watchers) if (w && w !== 'crew') w.fatigue = 0.12;
    for (const p of this.players) if (!this.watchers.includes(p)) p.fatigue = 0;
    // Rations: one per person per night.
    const eaters = this.players.length;
    const eat = Math.min(c.stocks.rations, eaters);
    c.stocks.rations -= eat;
    if (eat < eaters) lines.push('Not enough Rations for both of you. You went hungry.');
    // Crew upkeep, loyalty bands, desertions and disputes.
    for (const m of c.crewLive) {
      const def = MERCS.roles[m.role];
      const res = nightlyUpkeep(m, c.stocks, def);
      if (res.ok) crew.push(`${m.name} was fed and paid upkeep (+${MERCS.loyalty.paidInFull} loyalty).`);
      else crew.push(`${m.name} went without: -${Math.abs(MERCS.loyalty.missedUpkeep)} loyalty.`);
      if (res.events.includes('warn1')) crew.push(`${m.name}: "Pay me what I'm owed, or I'm done riding with you."`);
      if (res.events.includes('warn2')) crew.push(`${m.name}: "One more missed meal and I walk. Last warning."`);
      let delta = 0;
      if (this.hot) delta += STRUCTURES.raids.hot.loyalty;
      if (hub?.safeNight) delta += MERCS.loyalty.restDay;
      else if (!this.safeNight && this.waveCleared >= 2) delta += MERCS.loyalty.wonRaid;
      if (!this.watchers.includes('crew') || true) delta += 2; // sleeping crew regain loyalty
      m.loyalty = clamp(m.loyalty + delta, 0, 100);
      m.fatigue = this.watchers.includes('crew') ? 0.1 : 0;
      const v = campVerdict(m);
      if (v.desert) {
        m.deserted = true;
        m.alive = false;
        const steal = Math.min(c.stocks.fuel, 4);
        const food = Math.min(c.stocks.rations, 2);
        c.stocks.fuel -= steal;
        c.stocks.rations -= food;
        crew.push(t('radio.crew.desert', { name: m.name }));
        c.axes.trust -= 2;
      } else if (v.dispute) {
        m.dispute = v.dispute;
        crew.push(`${m.name} is mutinous: a ${v.dispute} dispute is brewing.`);
      }
    }
    // Spotlights burned fuel at night: already deducted. Save vehicle HP for the Ledger.
    const lost = this.commitFleet();
    for (const name of lost) lines.push(`${name} was wrecked in the raid and is lost.`);
    this.report = { lines, crew };
    // Rest the players.
    for (const p of this.players) {
      p.hp = p.maxHp;
      if (p.state === 'downed' || p.state === 'dead') p.state = 'foot';
      p.vehicle = null;
    }
    this.audio.setMusic('camp');
    this.paused = true;
    this.onResult({ type: 'campDone' });
  }

  pendingDisputes(): Merc[] {
    return this.campaign.crew.filter((m) => m.alive && !m.deserted && m.dispute);
  }

  // ------------------------------------------------------------------ rendering hooks

  protected applyLighting() {
    super.applyLighting();
    // Camp spotlights borrow the two headlight lights.
    const spots = this.structures.filter((s) => s.def.id === 'spotlight' && s.lit);
    for (let i = 0; i < 2; i++) {
      const sp = this.spots[i];
      const s = spots[i];
      if (s && this.night > 0.3) {
        sp.position.set(s.x, 3.2, s.z);
        sp.target.position.set(s.x + Math.sin(s.aim) * 20, 0, s.z + Math.cos(s.aim) * 20);
        sp.target.updateMatrixWorld();
        sp.intensity = 160;
        sp.angle = 0.6;
        sp.distance = 60;
      } else if (this.phase !== 'build' || true) {
        // keep whatever the base class set for vehicles
        if (!this.players.some((p) => p.vehicle?.lights)) sp.intensity = 0;
      }
    }
    void wrapAngle;
  }

  protected syncExtra(alpha: number, dt: number) {
    void alpha;
    void dt;
  }

  protected updateMusicState() {
    if (this.phase === 'night' && this.waveActive) this.audio.setMusic('raid');
    else if (this.phase === 'build' || this.phase === 'ledger' || this.phase === 'dawn') this.audio.setMusic('camp');
  }

  /** Camp has no ground map: a radar of the ring around the fire, the watch posts and what is coming. */
  mapModes = 2;
  private frame: MapFrame | null = null;

  mapFrame(pins: CompassPin[]): MapFrame | null {
    let f = this.frame;
    if (!f) {
      f = this.frame = newFrame('camp');
      f.title = this.siteName;
      f.bounds = { x0: -70, x1: 70, z0: -70, z1: 70 };
      f.radiusMin = 62;
      f.radiusMax = 62;
    }
    this.fillMapActors(f, false);
    f.pins.length = 0;
    for (const p of pins) f.pins.push({ x: p.x, z: p.z, kind: p.kind, label: p.label });
    return f;
  }

  compassPins(): CompassPin[] {
    const pins: CompassPin[] = [];
    for (let k = 0; k < 8; k++) {
      const a = sectorAngle(k);
      const watched = !!this.watchers[k];
      if (watched || this.phase === 'build') {
        pins.push({ x: Math.sin(a) * 40, z: Math.cos(a) * 40, kind: watched ? 'watch' : 'sector', label: watched ? SECTOR_NAMES[k].toUpperCase() : '' });
      }
    }
    if (this.phase === 'night') {
      for (const z of this.zombies.list) if (!z.dead && z.chasing && this.watchers[sectorOf(z.x, z.z)]) pins.push({ x: z.x, z: z.z, kind: 'ambush', label: '' });
      for (const v of this.vehicles) if (v.faction === 'raider' && !v.wreck && this.watchers[sectorOf(v.position.x, v.position.z)]) pins.push({ x: v.position.x, z: v.position.z, kind: 'ambush', label: '' });
    }
    return pins;
  }

  dispose() {
    for (const s of this.structures) {
      disposeTree(s.mesh);
      s.mesh.removeFromParent();
    }
    this.structures.length = 0;
    this.arena?.dispose();
    super.dispose();
  }

  get buildSecondsLeft() {
    return Math.max(0, Math.ceil(this.buildT));
  }
}

void whole;

/** Procedural meshes for each defensive element. */
function buildElementMesh(b: MeshBuilder, def: BuildElementDef, sx: number, sy: number, sz: number) {
  switch (def.id) {
    case 'barricade': {
      // Welded panel: a car door, sheet steel and planks over a frame, tyres stacked at the foot.
      b.box(0, sy / 2, -0.05, sx, sy, 0.12, S.wood(C.woodDark, 0.8));
      for (let i = -1; i <= 1; i++) plate(b, i * (sx / 3), sy / 2 + (i === 0 ? 0.05 : -0.04), sz * 0.25, sx / 3 - 0.04, sy - 0.15, 0.04, i === 0 ? S.rust(C.rust) : S.steel(0x5c6064, 0.85), 0, 0, i * 0.02);
      b.box(0, sy - 0.1, sz * 0.36, sx, 0.12, 0.04, S.paint(C.signYellow, 0.7));
      for (const x of [-sx / 2 + 0.1, sx / 2 - 0.1]) b.rod(x, 0, -0.25, x, sy + 0.1, -0.25, 0.05, S.steel(0x3a3c3e), 8);
      for (let i = -1; i <= 1; i++) spareTyre(b, i * 0.95, 0.15, -0.55, 0.32, 0.2, 0, i);
      break;
    }
    case 'wire': {
      // Pickets with a coil of razor wire.
      for (let i = 0; i < 4; i++) b.rod(-sx / 2 + (i * sx) / 3, 0, 0, -sx / 2 + (i * sx) / 3 + 0.05, sy + 0.1, 0, 0.025, S.steel(0x4a4c4e, 0.8), 6);
      const pts: [number, number, number][] = [];
      for (let i = 0; i <= 80; i++) {
        const t = i / 80;
        const a = t * 22 * Math.PI;
        pts.push([-sx / 2 + t * sx, sy * 0.5 + Math.sin(a) * sy * 0.45, Math.cos(a) * sz * 0.4]);
      }
      b.pipe(pts, 0.008, S.steel(0xa0a4a8, 0.4), 4);
      for (const y of [0.15, sy * 0.85]) b.rod(-sx / 2, y, 0, sx / 2, y, 0, 0.006, S.steel(0x8a8e92), 4);
      break;
    }
    case 'spikes': {
      b.rbox(0, 0.04, 0, sx, 0.08, sz, 0.02, S.steel(0x3a3c3e, 0.8));
      for (let i = 0; i < 12; i++) for (let j = 0; j < 3; j++) b.add('cone6', -sx / 2 + (i + 0.5) * (sx / 12), 0.17, -sz * 0.3 + j * sz * 0.3, 0.07, 0.2, 0.07, S.steel(0xa0a4a8, 0.4), (j - 1) * 0.3, 0, 0);
      break;
    }
    case 'spotlight': {
      // Tripod with a big lamp head, a cable and a jerry-can generator.
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        b.rod(Math.cos(a) * 0.45, 0, Math.sin(a) * 0.45, 0, sy - 0.4, 0, 0.03, S.metal(0x3a3c3e), 6);
      }
      b.rod(0, sy - 0.5, 0, 0, sy - 0.15, 0, 0.04, S.metal(0x3a3c3e), 8);
      b.frustum(0, sy - 0.05, -0.05, 0.3, 0.22, 0.5, S.paint(0x2c2e30, 0.7), Math.PI / 2, 0, 0, 16);
      b.cyl(0, sy - 0.05, 0.21, 0.56, 0.04, 0.56, S.glow(0xfff4c8, 3), Math.PI / 2, 0, 0, 16);
      b.torus(0, sy - 0.05, 0.22, 0.29, 0.025, S.chrome(), 0, 0, 0, 6, 20);
      b.rbox(0.45, 0.25, -0.4, 0.5, 0.45, 0.35, 0.04, S.paint(0xc89a2a, 0.7));
      b.pipe([[0, sy - 0.4, 0], [0.2, 0.4, -0.2], [0.45, 0.3, -0.3]], 0.015, S.rubber(), 5);
      break;
    }
    case 'turret': {
      // Sandbagged nest with a pintle gun.
      for (let ring = 0; ring < 3; ring++) {
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * Math.PI * 2 + ring * 0.3;
          b.rbox(Math.cos(a) * sx * 0.42, 0.13 + ring * 0.25, Math.sin(a) * sz * 0.42, 0.55, 0.26, 0.34, 0.1, S.cloth(ring % 2 ? 0x8a7a5a : 0x7a6c50, 0.7), 0, -a, 0);
        }
      }
      b.cyl(0, 0.85, 0, 0.16, 0.6, 0.16, S.steel(0x3a3c3e), 0, 0, 0, 10);
      const g = new MeshBuilder();
      heavyGun(g, 1.1, true);
      b.appendMatrix(g, new THREE.Matrix4().compose(new THREE.Vector3(0, 1.3, 0), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1)));
      break;
    }
    case 'drum': {
      drum(b, 0, 0, 0, C.fuel, 0.95, 0.33);
      b.box(0, 0.6, 0.34, 0.36, 0.28, 0.01, S.paint(0xf0d070, 0.6));
      b.add('cone6', 0, 0.62, 0.35, 0.1, 0.16, 0.01, S.paint(0x1a1a1a, 0.5), 0, 0, Math.PI);
      b.pipe([[0.2, 0.95, 0], [0.4, 1.05, 0.1], [0.6, 0.1, 0.4]], 0.006, S.paint(0xd23a3a, 0.4), 4);
      break;
    }
    case 'mine': {
      b.cyl(0, 0.05, 0, 0.6, 0.1, 0.6, S.paint(0x3e4a2e, 0.7), 0, 0, 0, 16);
      b.cyl(0, 0.11, 0, 0.42, 0.04, 0.42, S.paint(0x2e3824, 0.6), 0, 0, 0, 16);
      b.cyl(0, 0.15, 0, 0.12, 0.05, 0.12, S.metal(0x5a5a5a), 0, 0, 0, 10);
      b.sphereAt(0.12, 0.14, 0.12, 0.025, S.glow(0xff3a2a, 2.5), false);
      break;
    }
    default:
      b.box(0, sy / 2, 0, sx, sy, sz, C.metal);
  }
}
