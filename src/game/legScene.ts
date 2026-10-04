import { bind } from '../sim/vitals';
import * as THREE from 'three';
import { ENEMIES, VEHICLES, boatDef, partDef, t, type LegDef } from '../data';
import { ChunkSource, type ChunkData } from '../world/chunkgen';
import { CHUNK, groundHeight, heightAt, roadX, surfaceAt, waterAt as terrainWater, type Surface } from '../world/terrain';
import type { Aabb, PickupSpawn, ScavContainer, ScavZone } from '../world/layout';
import { chunkKey } from '../world/layout';
import { ChunkView, disposeChunkMaterials, makeChunkMaterials, type ChunkMaterials } from '../render/chunkview';
import { makeBeam, makePickup } from '../render/props';
import { Landscape } from '../render/landscape';
import { Destruction } from './destruction';
import { clamp, smoothstep } from '../core/math';
import { Scene, type CompassPin, type SceneServices } from './scene';
import { QUALITY } from '../render/renderer';
import { Vehicle } from './vehicle';
import type { Player } from './player';
import { DUSK_BELL_AT, DayClock } from '../sim/dayclock';
import { Rng, hashString } from '../core/rng';
import { gearDrop } from '../sim/gear';
import { disposeTree } from '../render/dispose';
import { PLAYER_PAINT, newBuild } from '../sim/garage';
import { RARITY_NAMES, newPart, partName } from '../sim/parts';
import { carriedName, partModelKey, planStow, type Carried, type Goods, type Loose } from '../sim/carry';
import { pickupFuel } from '../sim/fuel';
import { lakeCurrent } from '../world/lakes';
import { DRUGS, DRUG_IDS } from '../sim/drugs';
import type { DelveSite } from '../world/delveSites';
import { newDelveRecord, type DelveRecord, type PlayerCarry } from './delveScene';
import { districtMask } from '../world/openWorld';
import type { WorldMemory, WorldPose } from './worldMemory';
import { LegMapBaker, SITE_LABEL, minefieldOutline, newFrame, openRoadLines, roadLine, type MapFrame } from '../ui/mapdata';

interface PickupEntity {
  spawn: PickupSpawn;
  group: THREE.Group;
  baseY: number;
  phase: number;
  /** Set for parts, fuel cans and oil cans: things carried by hand. Everything else is banked on pickup. */
  loose?: Carried;
}

const GOODS_NAME: Record<string, string> = {
  scrap: 'Scrap',
  parts: 'Spare parts',
  tech: 'Tech',
  rations: 'Rations',
  medicine: 'Medicine',
  ammo: 'Ammo',
  chassis: 'Salvaged chassis',
  fragment: 'Radio fragment',
};
const goodsLabel = (p: PickupSpawn) => (p.kind === 'ammo' || p.amount <= 1 ? GOODS_NAME[p.kind] : `${GOODS_NAME[p.kind]} (${p.amount})`);

const partMk = (id: string) => partDef(id).mk;

/** How many set-down items may lie about at once before the oldest is tidied away. */
const MAX_DROPPED = 24;

interface AmbushState {
  spec: LegAmbush;
  state: 'idle' | 'pending' | 'done';
  tries: number;
  waiting: { kind: 'buggy' | 'wagon'; x: number; z: number; yaw: number }[];
  t: number;
}
type LegAmbush = ChunkSource['layout']['ambushes'][number];

interface MineView {
  x: number;
  z: number;
  alive: boolean;
}

interface ZoneState {
  zone: ScavZone;
  noise: number;
  horde: number; // seconds remaining, 0 = not started
  fired: boolean;
}

const STREAM_R = 2;
/** Milliseconds of chunk work a tick may start: for the look-ahead, and for a chunk next to a player. */
const STREAM_CALM_MS = 4;
const STREAM_URGENT_MS = 10;
const MINE_COLOR = new THREE.Color(0x1d1b19);

export class LegScene extends Scene {
  biome: 'wasteland' | 'city';
  mode = 'leg' as const;
  src: ChunkSource;
  mats: ChunkMaterials;
  /** City ground and roads for a district chunk of the open world (made on first use). */
  private cityMats: ChunkMaterials | null = null;
  chunks = new Map<number, ChunkView>();
  landscape: Landscape;
  pickups = new Map<string, PickupEntity>();
  takenPickups = new Set<string>();
  spawnedChunks = new Set<number>();
  brokenAabbs = new Set<number>();
  mines: MineView[] = [];
  mineMesh: THREE.InstancedMesh | null = null;
  ambushes: AmbushState[] = [];
  zones: ZoneState[] = [];
  activeContainers = new Map<string, { glint: THREE.Mesh; c: ScavContainer }>();
  doneEncounters = new Set<string>();
  shownTips = new Set<string>();
  /** Planned city legs: the places and streets already announced, and when the last announcement was. */
  private placesShown = new Set<string>();
  private placeAt = -99;
  bellBanner = 0;
  pendingResult = false;
  endReached = false;
  gap = 0;
  tetherWarn = false;
  minefieldWarned = new Set<number>();
  strandedT = new Map<string, number>();
  downBothT = 0;
  stuckNoVehicleT = new Map<number, number>();
  pings: { x: number; z: number; t: number; who: number }[] = [];
  private mineT = 0;
  private fuelTip = false;
  private fuelWarned = new Set<Vehicle>();
  private repairTip = false;
  /** When the last car or parts tip was shown, so they never talk over each other. */
  private carTipAt = -99;
  private legRng: Rng;
  distanceTravelled = 0;
  private lastLead = 0;
  private lastX = 0;
  /** Per-leg loot snapshot for the dawn report. */
  startStocks = { ...this.campaign.stocks };

  /** The world's memory, when this leg is the open world: adopted at start, filled in by `capture` at dusk. */
  memory: WorldMemory | null = null;
  /** Where the convoy decided to camp (the Dusk Bell's answer), once it has. */
  campPose: WorldPose | null = null;

  constructor(
    svc: SceneServices,
    public leg: LegDef,
    opts: { memory?: WorldMemory; start?: WorldPose } = {},
  ) {
    super(svc);
    this.biome = leg.biome;
    if (leg.open) this.cityMix = 0;
    this.clock = new DayClock(leg.dayLength, 0.1);
    this.src = opts.memory?.src ?? new ChunkSource(leg);
    if (opts.memory) this.adoptMemory(opts.memory);
    this.terrain = this.src.layout.terrain;
    this.legRng = new Rng(leg.seed + this.campaign.day * 17);
    this.mats = makeChunkMaterials(leg.biome, leg.theme);
    this.landscape = new Landscape(this.terrain, this.src.layout, leg.open ? this.src.cityBuildings() : undefined);
    this.obs.ground = (x, z) => heightAt(this.terrain!, x, z);
    // Doorways of every building, so the dead can find their way in and out.
    this.zombies.buildings = this.src.layout.rural.map((b) => {
      const doors: { x: number; z: number; nx: number; nz: number }[] = [];
      for (const w of b.plan.walls) {
        if (w.level !== 0) continue;
        for (const op of w.ops) {
          if (op.kind === 'window') continue;
          const mid = (op.a + op.b) / 2;
          doors.push(w.axis === 'z' ? { x: w.c, z: mid, nx: 1, nz: 0 } : { x: mid, z: w.c, nx: 0, nz: 1 });
        }
      }
      return { x0: b.plan.x0 - 1, x1: b.plan.x1 + 1, z0: b.plan.z0 - 1, z1: b.plan.z1 + 1, doors };
    });
    this.world = new Destruction(this, {
      buildings: () => this.landscape.buildings,
      chunk: (cx, cz) => {
        const view = this.chunks.get(chunkKey(cx, cz));
        return { data: this.src.get(cx, cz), view };
      },
      doorway: (bv, axis, c, mid) => {
        const i = this.src.layout.rural.indexOf(bv.rb);
        const b = this.zombies.buildings[i];
        if (b) b.doors.push(axis === 'z' ? { x: c, z: mid, nx: 1, nz: 0 } : { x: mid, z: c, nx: 0, nz: 1 });
      },
    });
    this.root.add(this.landscape.group);
    // Cut a building away for each viewer standing inside it (roof and upper floors), per view.
    this.R.onBeforeView[1] = (i, cam) => {
      const p = this.players[i];
      const v = p?.vehicle;
      const focus = p ? (v && p.state !== 'foot' ? { x: v.position.x, y: v.position.y, z: v.position.z } : { x: p.pos.x, y: p.pos.y, z: p.pos.z }) : null;
      this.landscape.updateView(focus, cam.position.x, cam.position.z);
    };
    this.wildlife.canStand = (x, z) => !this.src.layout.blockedAt(x, z, 1.2);
    this.zombies.onObstacleHit = (a, dmg, z) => {
      if (a.kind !== 'barricade' || a.breakable !== 'flimsy') return;
      a.hp -= dmg;
      if (a.hp <= 0 && z.kind === 'brute') this.breakBarricade(a, 'smash');
    };
    this.loose = {
      nearest: (x, z, r, prefer) => this.looseNearest(x, z, r, prefer),
      take: (id) => this.looseTake(id),
      nearestGoods: (x, z, r, prefer) => this.goodsNearest(x, z, r, prefer),
      takeGoods: (id, by) => this.goodsTake(id, by),
      drop: (x, z, c) => this.looseDrop(x, z, c),
    };
    this.src.layout.ambushes.forEach((spec) => this.ambushes.push({ spec, state: this.memory?.ambushDone.has(spec.id) ? 'done' : 'idle', tries: 0, waiting: [], t: 0 }));
    this.src.layout.zones.forEach((zone) => this.zones.push({ zone, noise: 0, horde: 0, fired: !!this.memory?.zoneFired.has(zone.id) }));
    this.buildMines();
    this.registerDelves();
    this.spawnBoats();
    for (const car of this.src.layout.cars) this.cars.add(car);
    // Preload the start so the world exists before anyone drives.
    const st = opts.start ? this.freeSpot(opts.start) : this.src.layout.start;
    this.loadAround([{ x: st.x, z: st.z }], 1, 99);
    this.P.step();
    this.spawnConvoy(st.x, st.z, st.yaw, 3.6, true);
    for (const m of this.campaign.crewLive) this.crew.spawn(m, st.x, st.z - 9, st.yaw);
    this.crew.mode = 'follow';
    this.lastLead = st.z;
    this.lastX = st.x;
    this.R.setLight(this.clockLight(), this.biome);
    if (leg.open) {
      this.updateBiome(0, true);
      this.R.setLight(this.clockLight(), this.biome, this.lightCity);
      this.startCampPrompt();
      for (const q of this.memory?.zombies ?? []) this.zombies.spawn(q.kind, q.x, q.z, q.dormant, q.cluster);
      // What the last day left on the road: tyre marks, and parts that were torn off and not picked up.
      if (this.memory?.tracks) this.marks.restore(this.memory.tracks);
      for (const d of this.memory?.drops ?? []) this.looseDrop(d.x, d.z, d.carried);
      this.radio(opts.start ? t('radio.open.again', { day: this.campaign.day }) : t('radio.open.start'));
      return;
    }
    this.radio(leg.index === 1 ? t('radio.intro1') : leg.index === 2 ? t('radio.l2.start') : t('radio.l3.start'));
    if (leg.index === 2) this.services.onRadio(t('radio.l2.voice2'));
  }

  /** The nearest clear dry ground to a pose: a camp may have been made at the foot of a wall, and the morning's vehicles need room. */
  private freeSpot(p: WorldPose): WorldPose {
    const L = this.src.layout;
    const T = this.terrain!;
    for (let r = 0; r <= 90; r += 6) {
      for (let k = 0; k < (r === 0 ? 1 : 12); k++) {
        const a = (k / 12) * Math.PI * 2;
        const x = p.x + Math.cos(a) * r;
        const z = p.z + Math.sin(a) * r;
        if (!L.blockedAt(x, z, 7) && !terrainWater(T, x, z)) return { x, z, yaw: p.yaw };
      }
    }
    return p;
  }

  private adoptMemory(m: WorldMemory) {
    this.memory = m;
    m.src = this.src;
    this.takenPickups = m.takenPickups;
    this.doneEncounters = m.doneEncounters;
    this.shownTips = m.shownTips;
    this.placesShown = m.placesShown;
    this.brokenAabbs = m.brokenAabbs;
    this.spawnedChunks = m.spawnedChunks;
    this.mapSeen = m.mapSeen;
    this.delveRecords = m.delveRecords;
    if (m.cars) this.cars.states = m.cars;
    // After a reload the layout is new: containers that were searched are marked on it again.
    if (m.searched.size) for (const z of this.src.layout.zones) for (const c of z.containers) if (m.searched.has(c.id)) c.taken = true;
  }

  /** Writes what the world should remember into its memory, just before this scene is torn down for the night. */
  capture(m: WorldMemory) {
    this.cars.clear();
    m.cars = this.cars.states;
    m.zombies = this.zombies.list.filter((z) => !z.dead && !z.raid).slice(0, 700).map((z) => ({ kind: z.kind, x: z.x, z: z.z, dormant: z.state === 'dormant', cluster: z.cluster }));
    m.ambushDone = new Set(this.ambushes.filter((a) => a.state === 'done').map((a) => a.spec.id));
    m.zoneFired = new Set(this.zones.filter((z) => z.fired).map((z) => z.zone.id));
    m.camp = this.campPose;
    for (const z of this.zones) for (const c of z.zone.containers) if (c.taken) m.searched.add(c.id);
    m.tracks = this.marks.snapshot();
    // Pieces still lying in the road with a part in them are kept as pickups; so is anything set down on the ground.
    const drops: WorldMemory['drops'] = [];
    for (const p of this.debris.pieces) {
      if (!p.item) continue;
      const t = p.body.translation();
      drops.push({ x: t.x, z: t.z, carried: { kind: 'part', item: p.item } });
    }
    for (const [id, e] of this.pickups) if (id.startsWith('drop') && e.loose) drops.push({ x: e.spawn.x, z: e.spawn.z, carried: e.loose });
    m.drops = drops;
  }

  // ------------------------------------------------------------------ making camp (open world)

  /** After the Dusk Bell, anyone on foot can hold to call the camp wherever they are. */
  private startCampPrompt() {
    for (const p of this.players) {
      this.interact.add({
        id: `camp:${p.index}`,
        x: p.pos.x,
        z: p.pos.z,
        r: 1.6,
        prompt: 'Hold to make camp here',
        dur: 2.2,
        priority: -4,
        enabled: (q) => q === p && this.clock.bellRung && q.state === 'foot' && !this.pendingResult,
        run: () => this.callCamp(),
      });
    }
  }

  /** Keeps each camp prompt under its player's feet. */
  private moveCampPrompts() {
    for (const i of this.interact.list) {
      if (!i.id.startsWith('camp:')) continue;
      const p = this.players[Number(i.id.slice(5))];
      if (!p) continue;
      i.x = p.pos.x;
      i.z = p.pos.z;
    }
  }

  /** The convoy stops here for the night: remember where, and ask which kind of camp. */
  private callCamp() {
    if (this.pendingResult) return;
    const lead = this.players.find((q) => q.alive) ?? this.players[0];
    const v = lead.vehicle ?? lead.ownVehicle;
    const x = v ? v.position.x : lead.pos.x;
    const z = v ? v.position.z : lead.pos.z;
    this.campPose = { x, z, yaw: v ? v.yaw : lead.yaw };
    this.pendingResult = true;
    this.endReached = true;
    this.onResult({ type: 'dusk' });
  }

  /** Where the camp is, for the place-name on the Ledger and for the camp's own rules: a hub if one is close. */
  hubNearby(): string | null {
    const o = this.terrain?.open;
    const p = this.campPose;
    if (!o || !p) return null;
    for (const h of o.hubs) if (Math.hypot(h.x - p.x, h.z - p.z) < 170) return h.id;
    if (Math.hypot(o.haven.x - p.x, o.haven.z - p.z) < 170) return 'haven';
    return null;
  }

  /** The camps this ground offers: the city's own in a district, a gas stop's if one is close, otherwise open flats and rock. */
  campOptions(): string[] {
    const o = this.terrain?.open;
    const p = this.campPose;
    if (!o || !p) return this.leg.campSites;
    if (districtMask(o, p.x, p.z) > 0.5) return ['carPark', 'plaza'];
    const out = ['flats', 'canyonMouth'];
    if (this.terrain!.sites.some((s) => (s.kind === 'gasStop' || s.kind === 'depot' || s.kind.startsWith('hub')) && Math.hypot(s.x - p.x, s.z - p.z) < 240)) out.unshift('gasStation');
    return out;
  }

  private clockLight() {
    return lightAtClock(this.clock, this.biome);
  }

  groundAt(x: number, z: number): number {
    return groundHeight(this.terrain!, x, z);
  }

  interiorAt(x: number, z: number, y: number) {
    for (const b of this.landscape.buildings) {
      const p = b.plan;
      if (b.contains(x, z, 0.1) && y > p.floorY - 1.5 && y < p.floorY + p.levels * p.levelH + 0.5) return true;
    }
    return false;
  }

  waterAt(x: number, z: number) {
    const w = terrainWater(this.terrain!, x, z);
    return w ? { level: w.level, depth: w.depth, flow: lakeCurrent(w.lake, x, z) } : null;
  }

  // ------------------------------------------------------------------ ways underground

  /** What each delve of this leg remembers: opened chests, dead guards, the key. */
  delveRecords = new Map<string, DelveRecord>();
  private delveNote = 0;

  delveRecord(id: string) {
    let r = this.delveRecords.get(id);
    if (!r) this.delveRecords.set(id, (r = newDelveRecord()));
    return r;
  }

  /** Boats tied up at each lake's pier: a skiff at the tip, and an airboat further in when there is room. */
  private spawnBoats() {
    for (const l of this.terrain!.lakes) {
      l.dock?.boats.forEach((m, i) => {
        const def = boatDef(i === 0 ? 'skiff' : 'airboat');
        const bp = def.physics.boat!;
        const v = new Vehicle(this, { def, x: m.x, z: m.z, yaw: m.yaw, y: l.level + def.physics.halfExtents[1] - bp.draft + 0.1, faction: 'convoy', kind: 'boat', color: def.id === 'skiff' ? 0x3a6a78 : 0xb8962a });
        v.fuel = v.tankMax * (0.55 + 0.25 * ((l.seed + i) % 3) / 2);
        this.vehicles.push(v);
      });
    }
  }

  private registerDelves() {
    for (const d of this.src.layout.delves) {
      this.interact.add({
        id: `delve:${d.id}`,
        x: d.x,
        z: d.z,
        r: 3.6,
        prompt: `Hold to go down into ${d.name}`,
        dur: 1.0,
        priority: 2,
        enabled: (p) => p.state === 'foot',
        onTick: (p) => this.delveReady(p, d),
        run: () => {
          this.pendingResult = false;
          this.onResult({ type: 'delveEnter', site: d });
        },
      });
    }
  }

  /** Both of you go down together: the partner has to be on foot and close. */
  private delveReady(p: Player, d: DelveSite): boolean {
    const o = this.players[1 - p.index];
    if (!o || (o.state === 'foot' && Math.hypot(o.pos.x - d.x, o.pos.z - d.z) < 45)) return true;
    if (this.time - this.delveNote > 3) {
      this.delveNote = this.time;
      p.note('Wait for your partner: you go down together, on foot', 'warn');
    }
    return false;
  }

  /** While a delve has the screen, a share of the day still passes up here. */
  advanceOffscreen(dt: number) {
    this.clock.tick(dt);
  }

  /** Back on the surface at the way in. */
  returnFromDelve(site: DelveSite, carry: PlayerCarry[], reason: 'climb' | 'lift' | 'rescue') {
    this.resume();
    const fx = Math.sin(site.yaw);
    const fz = Math.cos(site.yaw);
    this.players.forEach((p, i) => {
      const side = i === 0 ? -1.4 : 1.4;
      const x = site.x + fx * 3.2 - fz * side;
      const z = site.z + fz * 3.2 + fx * side;
      p.vehicle = null;
      p.action = null;
      p.state = 'foot';
      p.placeAt(x, z, site.yaw);
      const c = carry[i];
      if (c) {
        p.hp = Math.max(c.hp, reason === 'rescue' ? p.maxHp * 0.35 : 1);
        p.utility = c.utility;
        p.gear.sel = c.sel;
        p.syncEquip();
        if (c.equip === 'gun') p.equipGun();
      }
      if (reason === 'rescue') bind(p.bleed);
      p.invuln = 1.5;
    });
    if (reason === 'rescue') {
      const fee = Math.min(15, this.campaign.stocks.scrap);
      this.campaign.stocks.scrap -= fee;
      this.radio(`You were dragged out, half dead. Somebody paid a toll (-${fee} Scrap).`);
    } else this.radio('Daylight. It never looked so good.');
    this.cam0();
  }

  private cam0() {
    for (const p of this.players) p.cam.snap();
  }

  /** True once the chunk under a point has its physics ground, so a car can be dropped there. */
  colliderReady(x: number, z: number): boolean {
    return this.chunks.has(chunkKey(Math.floor(x / CHUNK), Math.floor(z / CHUNK)));
  }

  surfaceAt(x: number, z: number) {
    const name: Surface = surfaceAt(this.terrain!, x, z);
    const s = VEHICLES.surfaces[name];
    return { grip: s.grip, drag: s.drag, name };
  }

  // ------------------------------------------------------------------ chunk streaming

  private loadAround(points: { x: number; z: number }[], radius: number, maxPerCall: number) {
    const want: { cx: number; cz: number; d: number }[] = [];
    for (const p of points) {
      const pcx = Math.floor(p.x / CHUNK);
      const pcz = Math.floor(p.z / CHUNK);
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          const cx = pcx + dx;
          const cz = pcz + dz;
          if (this.chunks.has(chunkKey(cx, cz))) continue;
          // Only chunks overlapping the playable corridor are worth loading.
          want.push({ cx, cz, d: dx * dx + dz * dz });
        }
      }
    }
    want.sort((a, b) => a.d - b.d);
    let n = 0;
    for (const w of want) {
      if (n >= maxPerCall) break;
      if (this.chunks.has(chunkKey(w.cx, w.cz))) continue;
      this.loadChunk(w.cx, w.cz);
      n++;
    }
  }

  private loadChunk(cx: number, cz: number, staged = false) {
    const key = chunkKey(cx, cz);
    const data0 = this.src.get(cx, cz);
    // Barricades already broken stay broken.
    const data: ChunkData = this.brokenAabbs.size ? { ...data0, aabbs: data0.aabbs.filter((a) => !this.brokenAabbs.has(a.id)) } : data0;
    const mats = data.city && this.leg.biome !== 'city' ? (this.cityMats ??= makeChunkMaterials('city', this.leg.theme)) : this.mats;
    const view = new ChunkView(data, this.terrain!, mats, this.P, { scatter: QUALITY[this.R.quality].scatter, staged, onGround: () => this.landscape.setLoaded(cx, cz, true) });
    this.root.add(view.group);
    view.group.updateMatrixWorld(true);
    this.chunks.set(key, view);
    for (const a of data.aabbs) if (!a.physOnly) this.obs.add(a);
    // Pickups
    for (const p of data.pickups) {
      if (this.takenPickups.has(p.id) || this.pickups.has(p.id)) continue;
      this.spawnPickup(p);
    }
    // Zombies spawn the first time a chunk loads.
    if (!this.spawnedChunks.has(key)) {
      this.spawnedChunks.add(key);
      const scale = this.campaign.difficulty.aggro;
      for (const z of data.zombies) {
        if (z.kind === 'stalker' && this.leg.index < 2) continue;
        this.zombies.spawn(z.kind, z.x, z.z, z.dormant, z.cluster);
      }
      void scale;
    }
    // Scavenge containers
    for (const zone of data.zones) {
      for (const c of zone.containers) if (!c.taken) this.addContainer(zone, c);
    }
  }

  private unloadChunk(key: number) {
    const view = this.chunks.get(key);
    if (!view) return;
    for (const a of view.data.aabbs) this.obs.remove(a);
    for (const p of view.data.pickups) {
      const e = this.pickups.get(p.id);
      if (e) {
        disposeTree(e.group);
        e.group.removeFromParent();
        this.pickups.delete(p.id);
      }
    }
    for (const zone of view.data.zones) {
      for (const c of zone.containers) this.removeContainerView(c.id);
    }
    view.dispose();
    this.chunks.delete(key);
    this.landscape.setLoaded(view.data.cx, view.data.cz, false);
  }

  /**
   * Streaming is paced, not bursty. A chunk is made in small steps (its data, then its ground and colliders, then its
   * buildings, props and ground cover), and a tick does steps only while it is inside a small time budget: a few
   * milliseconds when the work is the look-ahead, which has all the time in the world, and a few more when a chunk next
   * to someone is missing. A slow machine does fewer steps a tick, never a whole chunk at once.
   */
  private streamWork(points: { x: number; z: number }[], here: { x: number; z: number }[]) {
    const dist = (list: { x: number; z: number }[], cx: number, cz: number) => {
      let best = Infinity;
      for (const p of list) {
        const dx = cx - Math.floor(p.x / CHUNK);
        const dz = cz - Math.floor(p.z / CHUNK);
        best = Math.min(best, dx * dx + dz * dz);
      }
      return best;
    };
    const t0 = performance.now();
    for (let unit = 0; unit < 6; unit++) {
      // Finish the nearest staged chunk, if there is one.
      let pendView: ChunkView | null = null;
      let pendD = Infinity;
      for (const v of this.chunks.values()) {
        if (!v.pending) continue;
        const d = dist(points, v.data.cx, v.data.cz);
        if (d < pendD) {
          pendD = d;
          pendView = v;
        }
      }
      // The nearest chunk that is wanted and not in.
      let wantD = Infinity;
      let wx = 0;
      let wz = 0;
      for (const p of points) {
        const pcx = Math.floor(p.x / CHUNK);
        const pcz = Math.floor(p.z / CHUNK);
        for (let dx = -STREAM_R; dx <= STREAM_R; dx++) {
          for (let dz = -STREAM_R; dz <= STREAM_R; dz++) {
            if (this.chunks.has(chunkKey(pcx + dx, pcz + dz))) continue;
            const d = dx * dx + dz * dz;
            if (d < wantD) {
              wantD = d;
              wx = pcx + dx;
              wz = pcz + dz;
            }
          }
        }
      }
      if (!pendView && wantD === Infinity) return;
      // A staged chunk is finished before the next one is started, unless the next one is much closer.
      let cx: number;
      let cz: number;
      if (pendView && pendD <= wantD + 2) {
        pendView.buildNext();
        cx = pendView.data.cx;
        cz = pendView.data.cz;
      } else {
        cx = wx;
        cz = wz;
        if (this.src.step(wx, wz)) this.loadChunk(wx, wz, true);
      }
      // Only a chunk next to someone is worth hurrying; the look-ahead has all the time it needs.
      if (performance.now() - t0 >= (dist(here, cx, cz) > 2 ? STREAM_CALM_MS : STREAM_URGENT_MS)) return;
    }
  }

  private stream(dt: number) {
    void dt;
    const pts: { x: number; z: number }[] = [];
    for (const p of this.players) {
      const v = p.vehicle;
      pts.push({ x: v ? v.position.x : p.pos.x, z: v ? v.position.z : p.pos.z });
    }
    // Look ahead of a fast vehicle so the road is there before it arrives.
    for (const p of this.players) {
      if (p.vehicle && Math.abs(p.vehicle.speed) > 12) {
        const [fx, , fz] = p.vehicle.body.forward();
        pts.push({ x: p.vehicle.position.x + fx * 120, z: p.vehicle.position.z + fz * 120 });
      }
    }
    this.streamWork(pts, pts.slice(0, this.players.length));
    // Unload far chunks (hysteresis of one chunk).
    for (const [key, view] of this.chunks) {
      let near = false;
      for (const p of pts) {
        if (Math.abs(view.data.cx - Math.floor(p.x / CHUNK)) <= STREAM_R + 1 && Math.abs(view.data.cz - Math.floor(p.z / CHUNK)) <= STREAM_R + 1) {
          near = true;
          break;
        }
      }
      if (!near) this.unloadChunk(key);
    }
  }

  // ------------------------------------------------------------------ scavenging

  /** Drugs found in a search go to the convoy's stores. */
  private giveDrugs(found: ScavContainer['drugs'], by: Player) {
    if (!found) return;
    const bits: string[] = [];
    for (const id of DRUG_IDS) {
      const n = found[id];
      if (!n) continue;
      this.campaign.items[id] += n;
      bits.push(`+${n} ${DRUGS[id].name.toLowerCase()}`);
    }
    if (bits.length) by.note(bits.join('  '), 'good');
  }

  private addContainer(zone: ScavZone, c: ScavContainer) {
    const depthName = c.label ?? ['front shelves', 'back shelves', 'the deep stock'][c.depth];
    const glint = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.22),
      new THREE.MeshBasicMaterial({ color: c.depth === 0 ? 0xffd48a : c.depth === 1 ? 0xffb347 : 0xff8a3a }),
    );
    glint.position.set(c.x, c.y ?? this.groundAt(c.x, c.z) + 2.4, c.z);
    this.root.add(glint);
    this.activeContainers.set(c.id, { glint, c });
    const dur = [1.6, 2.6, 4.0][c.depth];
    const zs = this.zones.find((z) => z.zone === zone)!;
    this.interact.add({
      id: c.id,
      x: c.x,
      z: c.z,
      r: 2.4,
      prompt: `Hold to search ${depthName}`,
      dur,
      priority: 1,
      enabled: () => !c.taken,
      onTick: (p) => {
        // Searching is loud, and deeper shelves are louder.
        this.sig.emit(c.x, c.z, 28 + c.depth * 14, 'noise');
        void p;
        return true;
      },
      run: (p) => {
        c.taken = true;
        this.addLoot(c.loot, 'search');
        // Seeded by the container, so reloading a chunk never rerolls a find.
        const find = gearDrop(new Rng(hashString(c.id) ^ Math.imul(this.campaign.seed, 2654435761)), 'search', { depth: c.depth, progress: this.gearProgress, biome: this.biome === 'city' ? 'city' : 'waste' });
        if (find) this.dropGear(find, c.x, c.z);
        this.giveDrugs(c.drugs, p);
        this.audio.play('loot', c.x, c.z, 0.8);
        this.removeContainerView(c.id);
        const n = [10, 16, 26][c.depth];
        zs.noise += n;
        this.sig.emit(c.x, c.z, 55 + c.depth * 14, 'noise');
        p.note(`Searched: noise ${Math.round(zs.noise)}`, 'info');
        if (zs.noise >= 55 && zs.horde <= 0 && !zs.fired) {
          zs.horde = 40;
          this.radio('The racket is carrying. A horde is coming for the exit!');
          this.zombies.hordeAlert(c.x, c.z, 70, c.x, c.z);
        }
      },
    });
  }

  private removeContainerView(id: string) {
    const e = this.activeContainers.get(id);
    if (e) {
      e.glint.removeFromParent();
      e.glint.geometry.dispose();
      this.activeContainers.delete(id);
    }
    this.interact.remove(id);
  }

  private updateZones(dt: number) {
    for (const zs of this.zones) {
      // Noise settles slowly.
      zs.noise = Math.max(0, zs.noise - dt * 0.8);
      if (zs.horde > 0) {
        zs.horde -= dt;
        if (zs.horde <= 0 && !zs.fired) {
          zs.fired = true;
          this.spawnHorde(zs.zone);
        }
      }
    }
  }

  private spawnHorde(zone: ScavZone) {
    // A horde converges from beyond the cameras. Spawns happen out of sight and at least 60 m away.
    const kinds = ['walker', 'walker', 'runner', 'runner', 'walker'] as const;
    let n = 0;
    for (let tries = 0; tries < 140 && n < 16 + this.leg.index * 3; tries++) {
      const a = this.legRng.range(0, Math.PI * 2);
      const r = this.legRng.range(70, 120);
      const x = zone.x + Math.cos(a) * r;
      const z = zone.z + Math.sin(a) * r;
      if (this.src.layout.blockedAt(x, z, 1)) continue;
      if (this.visibleToAnyView(x, 1, z, 4)) continue;
      const zb = this.zombies.spawn(this.legRng.pick(kinds), x, z, false, 7000);
      zb.state = 'swarm';
      zb.tx = zone.x;
      zb.tz = zone.z;
      zb.hasTarget = true;
      n++;
    }
    if (this.legRng.chance(0.5 + this.leg.index * 0.1)) {
      for (const d of [0, 1]) {
        const a = this.legRng.range(0, Math.PI * 2);
        const x = zone.x + Math.cos(a) * 85;
        const z = zone.z + Math.sin(a) * 85;
        if (!this.src.layout.blockedAt(x, z, 1) && !this.visibleToAnyView(x, 1, z, 4)) {
          const zb = this.zombies.spawn(d ? 'brute' : 'screamer', x, z, false, 7001);
          zb.state = 'swarm';
          zb.tx = zone.x;
          zb.tz = zone.z;
          zb.hasTarget = true;
        }
      }
    }
    this.radio(t('radio.horde'));
    this.audio.play('alarm');
  }

  // ------------------------------------------------------------------ mines

  private buildMines() {
    const ms = this.src.layout.mines;
    if (!ms.length) return;
    const geo = new THREE.CylinderGeometry(0.42, 0.5, 0.12, 10);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0.4 });
    this.mineMesh = new THREE.InstancedMesh(geo, mat, ms.length);
    this.mineMesh.frustumCulled = false;
    const m = new THREE.Matrix4();
    ms.forEach((mine, i) => {
      m.makeTranslation(mine.x, this.groundAt(mine.x, mine.z) + 0.04, mine.z);
      this.mineMesh!.setMatrixAt(i, m);
      this.mineMesh!.setColorAt(i, MINE_COLOR);
      this.mines.push({ x: mine.x, z: mine.z, alive: true });
    });
    this.root.add(this.mineMesh);
  }

  private updateMines(dt: number) {
    if (!this.mineMesh) return;
    this.mineT -= dt;
    const doVisual = this.mineT <= 0;
    if (doVisual) this.mineT = 0.25;
    let dirty = false;
    const m = new THREE.Matrix4();
    for (let i = 0; i < this.mines.length; i++) {
      const mine = this.mines[i];
      if (!mine.alive) continue;
      let minD = Infinity;
      for (const v of this.vehicles) {
        if (v.faction === 'raider' && v.wreck) continue;
        if (v.wreck) continue;
        const d = Math.hypot(v.position.x - mine.x, v.position.z - mine.z);
        minD = Math.min(minD, d);
        if (d < v.def.width / 2 + 0.55 && v.onGround) {
          this.detonateMine(i, v);
          dirty = true;
          break;
        }
      }
      if (!mine.alive) continue;
      for (const p of this.players) {
        if (p.state !== 'foot') continue;
        const d = Math.hypot(p.pos.x - mine.x, p.pos.z - mine.z);
        minD = Math.min(minD, d);
        if (d < 0.8) {
          this.detonateMine(i, null);
          dirty = true;
          break;
        }
      }
      if (doVisual && mine.alive) {
        // Mines become visible up close: faint glint within 35 m.
        const lit = minD < 35;
        this.mineMesh.setColorAt(i, lit ? (Math.sin(this.time * 6 + i) > 0 ? WARN_A : WARN_B) : MINE_COLOR);
        dirty = true;
      }
    }
    if (dirty) {
      this.mineMesh.instanceMatrix.needsUpdate = true;
      if (this.mineMesh.instanceColor) this.mineMesh.instanceColor.needsUpdate = true;
    }
    void m;
  }

  private detonateMine(i: number, v: Vehicle | null) {
    const mine = this.mines[i];
    mine.alive = false;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    this.mineMesh!.setMatrixAt(i, zero);
    const y = this.groundAt(mine.x, mine.z);
    this.combat.explode(mine.x, y + 0.3, mine.z, 4.5, 180, { side: 'neutral' });
    if (v && v.driver?.isPlayer) this.notify(v.driver.index, 'Mine!', 'bad');
    this.mineMesh!.instanceMatrix.needsUpdate = true;
  }

  // ------------------------------------------------------------------ barricades

  breakBarricade(a: Aabb, how: 'ram' | 'charge' | 'smash') {
    if (this.brokenAabbs.has(a.id)) return;
    this.brokenAabbs.add(a.id);
    this.obs.remove(a);
    const cx = Math.floor(((a.minX + a.maxX) / 2) / CHUNK);
    const cz = Math.floor(((a.minZ + a.maxZ) / 2) / CHUNK);
    const view = this.chunks.get(chunkKey(cx, cz));
    view?.removeAabb(a.id);
    const x = (a.minX + a.maxX) / 2;
    const z = (a.minZ + a.maxZ) / 2;
    const y = this.groundAt(x, z);
    for (let i = 0; i < 14; i++) {
      this.fx.puff(a.minX + Math.random() * (a.maxX - a.minX), y + 0.8, a.minZ + Math.random() * (a.maxZ - a.minZ), 0.5, 0.42, 0.32, 2.2, 1.2);
    }
    this.fx.spark(x, y + 1, z, 8, 6);
    this.audio.play('crash', x, z, 1);
    this.sig.emit(x, z, 80, 'noise');
    if (how === 'charge') this.radio('Barricade down. That was loud.');
  }

  /** A moving vehicle through a pane of glass: a shopfront or a window gives to a car at a walking-pace-and-more. */
  private ramGlass() {
    for (const v of this.vehicles) {
      if (v.wreck || v.mass < 300 || v.speed < 3.5) continue;
      const [fx, , fz] = v.body.forward();
      const reach = v.def.length / 2 + 0.8;
      const px = v.position.x + fx * reach;
      const pz = v.position.z + fz * reach;
      const panes: Aabb[] = [];
      this.obs.near(px, pz, v.def.width / 2 + 1.4, (a) => {
        if (a.mat !== 'glass' || a.kind !== 'partition') return;
        const cx = Math.max(a.minX, Math.min(px, a.maxX));
        const cz = Math.max(a.minZ, Math.min(pz, a.maxZ));
        // In the way of the nose, and low enough for the car to reach it.
        if (Math.hypot(cx - px, cz - pz) < v.def.width / 2 + 0.4 && a.y0 < v.position.y + 1.6 && a.y1 > v.position.y - 0.3) panes.push(a);
      });
      for (const a of panes) {
        if (!this.obs.byId(a.id)) continue;
        // Enough to take a pane out at a crawl, and a good many at speed.
        if (this.world!.hit(a, 14 + v.speed * 6, 'ram', { x: Math.max(a.minX, Math.min(px, a.maxX)), y: Math.min(a.y1 - 0.2, Math.max(a.y0 + 0.2, v.position.y + 0.6)), z: Math.max(a.minZ, Math.min(pz, a.maxZ)) })) {
          v.glass.hitNear(px, v.position.y + 0.5, pz, 6 + v.speed, 'ram', 2.2);
          if (v.driver?.isPlayer) this.players[v.driver.index].cam.addShake(0.25);
        }
      }
    }
  }

  private updateRamming() {
    this.ramGlass();
    for (const v of this.vehicles) {
      if (v.wreck || v.mass < 800 || v.speed < 6.5) continue;
      const [fx, , fz] = v.body.forward();
      const reach = v.def.length / 2 + 1.4 + v.speed * 0.05;
      const px = v.position.x + fx * reach;
      const pz = v.position.z + fz * reach;
      // A heavy vehicle at speed goes through a thin wall: the blow is its kinetic energy, spent on the wall.
      if (v.speed >= 7.5) {
        const walls: Aabb[] = [];
        this.obs.near(px, pz, v.def.width / 2 + 1.2, (a) => {
          if (a.kind !== 'partition' || a.wall === undefined) return;
          const cx = Math.max(a.minX, Math.min(px, a.maxX));
          const cz = Math.max(a.minZ, Math.min(pz, a.maxZ));
          if (Math.hypot(cx - px, cz - pz) < 1.1) walls.push(a);
        });
        for (const a of walls) {
          if (!this.obs.byId(a.id)) continue;
          const broke = this.world!.hit(a, (0.5 * v.mass * v.speed * v.speed) / 150, 'ram', { x: px, y: v.position.y + 0.8, z: pz });
          if (broke) {
            v.takeHit(8 + v.speed, px, pz, { ram: true, silent: true });
            const lv = v.body.body.linvel();
            v.body.body.setLinvel({ x: lv.x * 0.6, y: lv.y, z: lv.z * 0.6 }, true);
            if (v.driver?.isPlayer) this.players[v.driver.index].cam.addShake(0.5);
          }
        }
      }
      this.obs.near(px, pz, v.def.width / 2 + 1.5, (a) => {
        if (a.kind !== 'barricade' || a.breakable !== 'flimsy') return;
        const cx = Math.max(a.minX - 0.5, Math.min(px, a.maxX + 0.5));
        const cz = Math.max(a.minZ - 0.5, Math.min(pz, a.maxZ + 0.5));
        if (Math.hypot(cx - px, cz - pz) < 0.9) {
          this.breakBarricade(a, 'ram');
          v.takeHit(10 + v.speed, px, pz, { ram: true, silent: true });
          const lv = v.body.body.linvel();
          v.body.body.setLinvel({ x: lv.x * 0.7, y: lv.y, z: lv.z * 0.7 }, true);
          if (v.driver?.isPlayer) {
            v.driver && this.notify(v.driver.index, 'Barricade smashed', 'good');
            this.players[v.driver.index].cam.addShake(0.5);
          }
        }
      });
    }
  }

  // ------------------------------------------------------------------ pickups

  /** Build the floating model for a pickup and register it. Nothing is picked up on touch: every item is taken by hand. */
  private spawnPickup(p: PickupSpawn) {
    const fuelKind = p.kind === 'fuel' ? (p.fuel ?? pickupFuel(p.id)) : undefined;
    const m = makePickup(p.kind === 'part' ? (p.part ? partModelKey(p.part.id) : `part${p.amount}`) : p.kind === 'paint' ? `paint:${(p.color ?? 0xffffff).toString(16)}` : fuelKind === 'diesel' ? 'diesel' : p.kind);
    m.group.position.set(p.x, p.y, p.z);
    if (p.kind === 'part') {
      // Good parts show from a distance, in their rarity colour.
      if (p.amount >= 2) m.group.add(makeBeam(p.amount >= 3 ? 0xffb454 : 0x7ddc7a, p.amount >= 3 ? 14 : 8));
    } else if (p.kind === 'fragment' || p.kind === 'chassis') {
      const col = p.kind === 'fragment' ? 0x3ad0ff : 0x3aa0ff;
      m.group.add(makeBeam(col, 22));
    } else if (p.amount >= 14 && p.kind !== 'fuel' && p.kind !== 'oil') {
      m.group.add(makeBeam(0xffe9a0, 9));
    } else if (p.kind === 'fuel') m.group.add(makeBeam(fuelKind === 'diesel' ? 0xe8c020 : 0xff6a3a, 7));
    else if (p.kind === 'oil') m.group.add(makeBeam(0xe0b030, 6));
    else if (p.kind === 'water') m.group.add(makeBeam(0x6ab4ff, 6));
    this.root.add(m.group);
    let loose: Carried | undefined;
    if (p.kind === 'part' && p.part) loose = { kind: 'part', item: newPart(p.part.id, p.part.cond) };
    else if (p.kind === 'fuel') loose = { kind: 'fuel', amount: p.amount, fuel: fuelKind };
    else if (p.kind === 'oil') loose = { kind: 'oil', amount: p.amount };
    else if (p.kind === 'water') loose = { kind: 'water', amount: p.amount };
    else if (p.kind === 'paint') loose = { kind: 'paint', color: p.color ?? 0xffffff, charges: p.amount };
    this.pickups.set(p.id, { spawn: p, group: m.group, baseY: p.y, phase: Math.random() * 6.28, loose });
  }

  private removePickup(id: string) {
    const e = this.pickups.get(id);
    if (!e) return;
    disposeTree(e.group);
    e.group.removeFromParent();
    this.pickups.delete(id);
  }

  private dropSeq = 0;

  // The world as players see it for carrying: lift, set down, look about.
  private looseNearest(x: number, z: number, r: number, prefer?: string): Loose | null {
    let best: Loose | null = null;
    let bd = r;
    for (const [id, e] of this.pickups) {
      if (!e.loose) continue;
      // Two things at nearly the same distance must not trade places while a lift is in progress.
      const d = Math.hypot(e.spawn.x - x, e.spawn.z - z) - (id === prefer ? 0.3 : 0);
      if (d < bd) {
        bd = d;
        best = { id, carried: e.loose, x: e.spawn.x, y: e.spawn.y, z: e.spawn.z };
      }
    }
    // A part that tore off a vehicle and has settled in the road can be lifted like any other.
    return this.debris.nearestLoose(x, z, bd, prefer) ?? best;
  }

  private looseTake(id: string): Carried | null {
    if (id.startsWith('debris:')) return this.debris.take(id);
    const e = this.pickups.get(id);
    if (!e?.loose) return null;
    const c = e.loose;
    this.takenPickups.add(id);
    this.removePickup(id);
    return c;
  }

  /** The nearest banked-on-pickup item (scrap, rations, ammo and the like) within `r`. */
  private goodsNearest(x: number, z: number, r: number, prefer?: string): Goods | null {
    let best: Goods | null = null;
    let bd = r;
    for (const [id, e] of this.pickups) {
      if (e.loose || !GOODS_NAME[e.spawn.kind]) continue;
      const d = Math.hypot(e.spawn.x - x, e.spawn.z - z) - (id === prefer ? 0.3 : 0);
      if (d < bd) {
        bd = d;
        best = { id, label: goodsLabel(e.spawn), x: e.spawn.x, y: e.spawn.y, z: e.spawn.z };
      }
    }
    return best;
  }

  private goodsTake(id: string, by: Player): boolean {
    const e = this.pickups.get(id);
    if (!e || e.loose) return false;
    this.collect(e.spawn, by);
    this.takenPickups.add(id);
    this.removePickup(id);
    return true;
  }

  private looseDrop(x: number, z: number, c: Carried) {
    const id = `drop${this.dropSeq++}`;
    const y = this.groundAt(x, z);
    const kind = c.kind === 'part' ? 'part' : c.kind;
    const amount = c.kind === 'part' ? (c.item.id ? partMk(c.item.id) : 1) : c.kind === 'paint' ? c.charges : c.amount;
    const spawn: PickupSpawn = { id, kind, amount, x, y, z, part: c.kind === 'part' ? { id: c.item.id, cond: c.item.cond } : undefined, fuel: c.kind === 'fuel' ? (c.fuel ?? 'petrol') : undefined, color: c.kind === 'paint' ? c.color : undefined };
    this.spawnPickup(spawn);
    // Keep the very item that was dropped, so its wear survives being put down.
    const e = this.pickups.get(id);
    if (e) e.loose = c;
    // Tidy the oldest set-down item once too many lie about.
    const dropped = [...this.pickups.keys()].filter((k) => k.startsWith('drop'));
    while (dropped.length > MAX_DROPPED) this.removePickup(dropped.shift()!);
  }

  private updatePickups(dt: number) {
    const time = this.time;
    for (const e of this.pickups.values()) {
      e.group.position.y = e.baseY + 0.2 + Math.sin(time * 2 + e.phase) * 0.08;
      e.group.rotation.y += dt * 1.4;
    }

  }

  private collect(p: PickupSpawn, by: Player) {
    const camp = this.campaign;
    this.audio.play('pickup', p.x, p.z, 0.8);
    this.fx.spark(p.x, p.y + 0.6, p.z, 4, 3);
    switch (p.kind) {
      case 'fuel': {
        const kind = p.fuel ?? pickupFuel(p.id);
        if (kind === 'diesel') {
          camp.stowFuel(p.amount, 'diesel');
          this.notify(-1, `+${p.amount.toFixed(0)} FU diesel`, 'good');
        } else this.addLoot({ fuel: p.amount }, 'fuel');
        if (!this.fuelTip) this.fuelTip = true;
        break;
      }
      case 'oil':
        break;
      case 'scrap':
      case 'parts':
      case 'tech':
      case 'rations':
      case 'medicine':
        this.addLoot({ [p.kind]: p.amount }, p.kind);
        break;
      case 'ammo':
        camp.ammo += p.amount;
        this.notify(-1, `+${p.amount} rounds`, 'good');
        break;
      case 'chassis':
        camp.chassis++;
        this.notify(-1, 'Salvaged chassis recovered: Tier 3 upgrade unlocked', 'good');
        this.radio('Salvaged chassis: enough frame to build a buggy around.');
        break;
      case 'fragment': {
        const n = p.amount;
        if (camp.fragments.has(n)) this.radio(t('radio.fragment.dup'));
        else {
          camp.fragments.add(n);
          this.radio(t('radio.fragment', { n: camp.fragments.size }));
          this.notify(-1, `Radio fragment ${camp.fragments.size}/4`, 'good');
        }
        this.audio.play('radio');
        break;
      }
    }
    void by;
  }

  // ------------------------------------------------------------------ ambushes

  private updateAmbushes(dt: number) {
    for (const a of this.ambushes) {
      if (a.state === 'done') continue;
      if (a.state === 'idle') {
        let trig = false;
        for (const p of this.players) {
          if (!p.alive) continue;
          const dz = a.spec.z - p.pos.z;
          const dx = a.spec.x - p.pos.x;
          // Raiders read Dust: they notice a convoy approaching from the south.
          // On a corridor leg that means from the south; in the open world raiders see you from any side.
          if ((this.terrain!.open || dz > -40) && Math.hypot(dx, dz) < a.spec.triggerRadius) trig = true;
        }
        if (!trig) continue;
        a.state = 'pending';
        a.tries = 0;
        a.t = 0;
        this.prepareAmbush(a);
        this.radio(t('radio.ambush'));
        for (const p of this.players) p.note('Raiders spotted your Dust!', 'warn');
        if (a.spec.canyon) this.tip('ambush');
      } else if (a.state === 'pending') {
        a.t += dt;
        // Spawn units out of camera view, at least 60 m from both players.
        for (let i = a.waiting.length - 1; i >= 0; i--) {
          const w = a.waiting[i];
          let tooClose = false;
          for (const p of this.players) if (Math.hypot(p.pos.x - w.x, p.pos.z - w.z) < 60) tooClose = true;
          const vis = this.visibleToAnyView(w.x, this.groundAt(w.x, w.z) + 1.2, w.z, 8);
          if ((!vis && !tooClose) || a.t > 3.5) {
            if (w.kind === 'wagon') this.raiders.spawnWagon(w.x, w.z, w.yaw);
            else this.raiders.spawnBuggy(w.x, w.z, w.yaw);
            a.waiting.splice(i, 1);
          }
        }
        if (!a.waiting.length) a.state = 'done';
      }
    }
  }

  private prepareAmbush(a: AmbushState) {
    const T = this.terrain!;
    const lead = this.leadPlayerPos();
    const diff = this.campaign.difficulty.aggro;
    const nB = Math.max(1, Math.round(a.spec.buggies * (0.8 + 0.2 * diff)));
    const open = !!T.open;
    // The way the convoy is heading, so raiders come out ahead of it wherever it is going.
    const lp = this.players.find((q) => q.alive) ?? this.players[0];
    const lv = lp.vehicle;
    let hx = 0;
    let hz = 1;
    if (open) {
      if (lv && Math.abs(lv.speed) > 2) {
        const [fx, , fz] = lv.body.forward();
        const s = lv.speed >= 0 ? 1 : -1;
        hx = fx * s;
        hz = fz * s;
      } else {
        hx = a.spec.x - lead.x;
        hz = a.spec.z - lead.z;
      }
      const hl = Math.hypot(hx, hz) || 1;
      hx /= hl;
      hz /= hl;
    }
    const spawn = (kind: 'buggy' | 'wagon', i: number) => {
      if (open) {
        const ahead = this.legRng.range(110, 170) + (a.spec.canyon ? 30 : 0);
        const side = i % 2 === 0 ? 1 : -1;
        const off = this.legRng.range(28, 62) * side;
        const x = lead.x + hx * ahead - hz * off;
        const zz = lead.z + hz * ahead + hx * off;
        a.waiting.push({ kind, x, z: zz, yaw: Math.atan2(lead.x - x, lead.z - zz) });
        return;
      }
      // Ahead of the convoy, off the road, facing it.
      const zz = lead.z + this.legRng.range(110, 170) + (a.spec.canyon ? 30 : 0);
      const rx = roadX(T, zz);
      const side = i % 2 === 0 ? 1 : -1;
      const off = a.spec.canyon ? this.legRng.range(10, 24) : this.legRng.range(28, 62);
      const x = rx + side * off;
      const yaw = Math.atan2(rx - x, -30 + this.legRng.range(-10, 10));
      a.waiting.push({ kind, x, z: zz, yaw });
    };
    for (let i = 0; i < nB; i++) spawn('buggy', i);
    for (let i = 0; i < a.spec.wagon; i++) spawn('wagon', i + 1);
  }

  private leadPlayerPos() {
    let best = this.players[0];
    if (this.terrain?.open) best = this.players.find((q) => q.alive) ?? best;
    else for (const p of this.players) if (p.pos.z > best.pos.z) best = p;
    const v = best.vehicle;
    return { x: v ? v.position.x : best.pos.x, z: v ? v.position.z : best.pos.z };
  }

  /** Spawn raiders from an encounter or other triggers. */
  spawnAmbush(buggies: number) {
    const spec = { id: `enc${this.time}`, x: 0, z: 0, buggies, wagon: 0, triggerRadius: 0, canyon: false };
    const st: AmbushState = { spec, state: 'pending', tries: 0, waiting: [], t: 0 };
    this.prepareAmbush(st);
    this.ambushes.push(st);
    this.radio(t('radio.ambush'));
  }

  spawnZombieGroup(n: number) {
    const lead = this.leadPlayerPos();
    let spawned = 0;
    for (let i = 0; i < 80 && spawned < n; i++) {
      const a = this.legRng.range(0, Math.PI * 2);
      const r = this.legRng.range(45, 80);
      const x = lead.x + Math.cos(a) * r;
      const z = lead.z + Math.sin(a) * r;
      if (this.src.layout.blockedAt(x, z, 1) || this.visibleToAnyView(x, 1, z, 3)) continue;
      const zb = this.zombies.spawn(this.legRng.pick(['walker', 'walker', 'runner']), x, z, false, 7100);
      zb.state = 'swarm';
      zb.tx = lead.x;
      zb.tz = lead.z;
      zb.hasTarget = true;
      spawned++;
    }
  }

  // ------------------------------------------------------------------ encounters, tips

  private updateEncounters() {
    if (this.pendingResult) return;
    for (const e of this.src.layout.encounters) {
      if (this.doneEncounters.has(e.id)) continue;
      for (const p of this.players) {
        if (!p.alive) continue;
        const v = p.vehicle;
        const px = v ? v.position.x : p.pos.x;
        const pz = v ? v.position.z : p.pos.z;
        if (Math.hypot(px - e.x, pz - e.z) < 12) {
          this.doneEncounters.add(e.id);
          this.pendingResult = true;
          this.onResult({ type: 'encounter', id: e.encounter, spotId: e.id });
          return;
        }
      }
    }
  }

  resumeAfterEncounter() {
    this.pendingResult = false;
  }

  /** Planned city legs: name Founders' Square, the Great Synagogue and each named street the first time a player is in it. */
  private updatePlaces() {
    const L = this.src.layout;
    const plan = L.plan;
    if (!plan || this.time < 6 || this.time - this.placeAt < 3.5) return;
    for (const p of this.players) {
      if (p.state === 'dead') continue;
      const x = p.vehicle?.position.x ?? p.pos.x;
      const z = p.vehicle?.position.z ?? p.pos.z;
      for (const pl of L.places) {
        if (this.placesShown.has(pl.id) || Math.hypot(x - pl.x, z - pl.z) > pl.r) continue;
        this.placesShown.add(pl.id);
        this.placeAt = this.time;
        this.services.onBanner?.(pl.name, pl.sub);
        return;
      }
      for (const st of L.streets) {
        if (!st.street || this.placesShown.has(st.street)) continue;
        if (x < st.x0 || x > st.x1 || z < st.z0 || z > st.z1) continue;
        const named = plan.streets.find((q) => q.id === st.street);
        if (!named) continue;
        this.placesShown.add(st.street);
        this.placeAt = this.time;
        this.services.onBanner?.(named.name, named.sub);
        return;
      }
    }
  }

  private updateTips() {
    this.updatePlaces();
    let maxZ = -Infinity;
    for (const p of this.players) maxZ = Math.max(maxZ, p.pos.z);
    for (const tp of this.src.layout.tips) {
      if (this.shownTips.has(tp.id)) continue;
      if (maxZ >= tp.z) {
        this.shownTips.add(tp.id);
        this.tip(tp.tip);
      }
    }
    // Contextual tips.
    for (const p of this.players) {
      const v = p.vehicle ?? p.ownVehicle;
      if (v && v.fuel < v.tankMax * 0.2 && !this.shownTips.has('tip-fuel')) {
        this.shownTips.add('tip-fuel');
        this.tip('fuel');
      }
      // Nearly dry: say so over the radio, once per tank (it re-arms once the tank is refilled past a quarter).
      if (v) {
        const frac = v.tankMax > 0 ? v.fuel / v.tankMax : 1;
        if (frac > 0.25) this.fuelWarned.delete(v);
        else if (frac < 0.07 && v.engineOn && !this.fuelWarned.has(v)) {
          this.fuelWarned.add(v);
          this.radio(t('radio.fuelCritical', { name: p.index === 0 ? 'Player 1' : 'Player 2' }));
        }
      }
      if (v && v.hpFrac < 0.5 && !this.shownTips.has('tip-repair')) {
        this.shownTips.add('tip-repair');
        this.tip('repair');
      }
    }
    // Cars and parts: introduce the loop the first time it is in reach, one tip at a time.
    if (this.time - this.carTipAt > 14) {
      for (const p of this.players) {
        if (p.state === 'downed' || p.state === 'dead') continue;
        const near = (pred: (v: Vehicle) => boolean) => p.nearestVehicle(14, pred);
        let id: string | null = null;
        if (!this.shownTips.has('tip-car') && near((v) => v.faction === 'neutral' && !v.wreck)) id = 'car';
        else if (this.shownTips.has('tip-car') && !this.shownTips.has('tip-salvage') && near((v) => this.cars.canSalvage(v))) id = 'salvage';
        else if (this.campaign.inventory.length && !this.shownTips.has('tip-parts') && this.shownTips.has('tip-car')) id = 'parts';
        else if (!this.shownTips.has('tip-haul') && p.state === 'foot' && (this.looseNearest(p.pos.x, p.pos.z, 5) || this.goodsNearest(p.pos.x, p.pos.z, 5))) id = 'haul';
        if (id) {
          this.shownTips.add(`tip-${id}`);
          this.carTipAt = this.time;
          this.tip(id);
          break;
        }
      }
    }
    // Lakes, boats and the ways down: each introduced once, when it is close, sharing the car tips' spacing.
    if (this.time - this.carTipAt > 14) {
      for (const p of this.players) {
        if (p.state === 'downed' || p.state === 'dead') continue;
        const x = p.vehicle?.position.x ?? p.pos.x;
        const z = p.vehicle?.position.z ?? p.pos.z;
        let id: string | null = null;
        if (!this.shownTips.has('tip-boat') && p.vehicle?.def.physics.kind === 'boat') id = 'boat';
        else if (!this.shownTips.has('tip-swim') && p.swimming) id = 'swim';
        else if (!this.shownTips.has('tip-lake') && this.terrain!.lakes.some((l) => l.dock && Math.hypot(l.dock.shoreX - x, l.dock.shoreZ - z) < 120)) id = 'lake';
        else if (!this.shownTips.has('tip-delve') && this.src.layout.delves.some((d) => Math.hypot(d.x - x, d.z - z) < 45)) id = 'delve';
        if (id) {
          this.shownTips.add(`tip-${id}`);
          this.carTipAt = this.time;
          this.tip(id);
          break;
        }
      }
    }
    if (this.activeContainers.size && !this.shownTips.has('tip-loot')) {
      for (const p of this.players) {
        for (const c of this.activeContainers.values()) {
          if (Math.hypot(p.pos.x - c.c.x, p.pos.z - c.c.z) < 14) {
            this.shownTips.add('tip-loot');
            this.tip('loot');
          }
        }
      }
    }
  }

  // ------------------------------------------------------------------ tether, crew

  private updateTether(dt: number) {
    const [a, b = a] = this.players;
    if (!a) return;
    // Solo: b defaults to a, so there is never a gap and nobody trails.
    const pa = a.vehicle ? a.vehicle.position : a.pos;
    const pb = b.vehicle ? b.vehicle.position : b.pos;
    const gap = Math.hypot(pa.x - pb.x, pa.z - pb.z);
    this.gap = gap;
    const leader = pa.z >= pb.z ? a : b;
    const trailer = a === b ? null : leader === a ? b : a;
    const slip = clamp((gap - 60) / 180, 0, 1);
    const pull = smoothstep(240, 330, gap);
    for (const p of this.players) {
      const v = p.vehicle ?? p.ownVehicle;
      if (!v) continue;
      if (trailer && p === trailer) {
        // Slipstream: the trailing player gets a speed bonus to catch up.
        v.tetherPower = 1 + 0.28 * slip;
        v.tetherTop = 1 + 0.12 * slip;
      } else {
        // Soft tether: the leader slows once the partner is far behind.
        v.tetherPower = 1 - 0.55 * pull;
        v.tetherTop = 1 - 0.5 * pull;
      }
    }
    const warn = gap > 250;
    if (warn && !this.tetherWarn) this.radio(t('radio.stranded'));
    this.tetherWarn = warn;
    for (const p of this.players) p.tetherWarn = warn ? 1 : 0;
    this.campaign.stats.timeApart += gap > 120 ? dt : 0;
    // Crew left behind for too long lose loyalty.
    for (const u of this.crew.units) {
      const d = Math.hypot(u.vehicle.position.x - leader.pos.x, u.vehicle.position.z - leader.pos.z);
      const k = u.merc.id;
      if (d > 300) {
        const tt = (this.strandedT.get(k) ?? 0) + dt;
        this.strandedT.set(k, tt);
        if (tt > 60) {
          this.strandedT.set(k, 0);
          u.merc.loyalty = Math.max(0, u.merc.loyalty - 20);
          u.merc.grievances.unshift('Stranded');
          this.radio(`${u.merc.name}: "You left me out here!"`);
        }
      } else this.strandedT.set(k, 0);
    }
  }

  // ------------------------------------------------------------------ end of leg, failure

  private updateEnd(dt: number) {
    if (this.terrain?.open) return this.updateOpenEnd(dt);
    const end = this.src.layout.end;
    // Dusk Bell
    if (this.bellBanner > 0) this.bellBanner -= dt;
    // Reaching the end of the road with everyone present triggers the camp decision.
    if (this.endReached || this.pendingResult) return;
    const live = this.players.filter((p) => p.alive && p.state !== 'downed');
    if (!live.length) return;
    let all = true;
    for (const p of live) {
      const v = p.vehicle;
      const x = v ? v.position.x : p.pos.x;
      const z = v ? v.position.z : p.pos.z;
      if (Math.hypot(x - end.x, z - end.z) > end.radius) all = false;
    }
    if (all) {
      this.endReached = true;
      this.pendingResult = true;
      if (this.clock.t < DUSK_BELL_AT) this.clock.skipToDusk();
      this.radio(t('radio.legDone'));
      this.onResult({ type: 'dusk' });
    }
    void dt;
  }

  /** The open world has no end of the road for the day: night, or Haven, ends it. */
  private updateOpenEnd(dt: number) {
    if (this.bellBanner > 0) this.bellBanner -= dt;
    if (this.pendingResult) return;
    const live = this.players.filter((p) => p.alive && p.state !== 'downed');
    if (!live.length) return;
    const end = this.src.layout.end;
    let all = true;
    for (const p of live) {
      const v = p.vehicle;
      if (Math.hypot((v ? v.position.x : p.pos.x) - end.x, (v ? v.position.z : p.pos.z) - end.z) > end.radius) all = false;
    }
    if (all) {
      this.campPose = { x: end.x, z: end.z, yaw: 0 };
      this.pendingResult = true;
      this.endReached = true;
      this.campaign.flags.haven = true;
      if (this.clock.t < DUSK_BELL_AT) this.clock.skipToDusk();
      this.radio(t('radio.haven'));
      this.onResult({ type: 'haven' });
      return;
    }
    // Past dark with nobody having called it, the convoy stops where it is.
    if (this.clock.t > 1.06) {
      this.radio(t('radio.forcedCamp'));
      this.callCamp();
    }
  }

  private updateFail(dt: number) {
    const down = this.everyoneDown;
    this.downBothT = down ? this.downBothT + dt : 0;
    if (this.downBothT > 1.5) {
      this.onResult({ type: 'fail', reason: this.campaign.solo ? 'You bled out on the road.' : 'You both went down.' });
      this.downBothT = -999;
      return;
    }
    // Emergency rides: a player whose vehicle was lost gets a scrap moped after a while.
    for (const p of this.players) {
      const own = p.ownVehicle;
      const noRide = (!own || own.wreck) && !p.vehicle && p.state === 'foot';
      const tt = noRide ? (this.stuckNoVehicleT.get(p.index) ?? 0) + dt : 0;
      this.stuckNoVehicleT.set(p.index, tt);
      if (noRide && tt > 8) {
        this.stuckNoVehicleT.set(p.index, 0);
        if (this.campaign.stocks.scrap >= 20) {
          this.campaign.stocks.scrap -= 20;
          const spare = newBuild('moped', { paint: PLAYER_PAINT[p.index], seed: 91 + p.index + this.campaign.day, hp: 0.7, fuel: 0.5 });
          this.campaign.adopt(spare);
          this.campaign.players[p.index].vehicle = spare.uid;
          const v = this.spawnVehicle({ build: spare, x: p.pos.x + 2.5, z: p.pos.z + 1.5, yaw: p.yaw, ownerIndex: p.index });
          p.ownVehicle = v;
          this.campaign.players[p.index].alive = true;
          p.note('The convoy cobbled together a spare moped (-20 Scrap)', 'warn');
        } else if (this.players.every((q) => !q.vehicle && (!q.ownVehicle || q.ownVehicle.wreck) && this.campaign.stocks.scrap < 20)) {
          this.onResult({ type: 'fail', reason: 'The last vehicle was lost.' });
          this.stuckNoVehicleT.set(p.index, -999);
        }
      }
    }
  }

  // ------------------------------------------------------------------ pings

  addPing(x: number, z: number, who: number) {
    this.pings.push({ x, z, t: 10, who });
    this.audio.play('beep', x, z, 0.6);
  }

  // ------------------------------------------------------------------ tick

  protected modeTick(dt: number) {
    if (this.paused) return;
    this.stream(dt);
    this.updateBiome(dt);
    this.moveCampPrompts();
    this.updatePickups(dt);
    this.updateMines(dt);
    this.updateRamming();
    this.updateZones(dt);
    this.wildlife.ambient(dt, this.biome, this.leg.theme ?? 'dust', this.leg.index);
    this.updateAmbushes(dt);
    this.updateEncounters();
    this.updateTips();
    this.updateTether(dt);
    this.updateEnd(dt);
    this.updateFail(dt);
    for (let i = this.pings.length - 1; i >= 0; i--) {
      this.pings[i].t -= dt;
      if (this.pings[i].t <= 0) this.pings.splice(i, 1);
    }
    // Dusk Bell rings once.
    if (this.clock.bellRung && !this.bellDone) {
      this.bellDone = true;
      this.bellBanner = 7;
      this.audio.play('bell');
      this.radio(t(this.leg.open ? 'radio.dusk.open' : 'radio.dusk'));
    }
    if (this.clock.night && !this.nightTold) {
      this.nightTold = true;
      this.radio(t('radio.night'));
    }
    // Minefield warning.
    this.terrain!.minefields.forEach((m, i) => {
      if (this.minefieldWarned.has(i)) return;
      for (const p of this.players) {
        if (p.pos.z > m.z0 - 150 && p.pos.z < m.z1 && Math.abs(p.pos.x - roadX(this.terrain!, p.pos.z)) < 40) {
          this.minefieldWarned.add(i);
          this.radio(t('radio.mines'));
        }
      }
    });
    // Distance stat.
    if (this.terrain?.open) {
      // No "up the road" in the open world: distance is however far the lead player has actually gone.
      const at = this.leadPlayerPos();
      const step = Math.hypot(at.x - this.lastX, at.z - this.lastLead);
      if (step < 40) {
        this.campaign.stats.distance += step;
        this.distanceTravelled += step;
      }
      this.lastX = at.x;
      this.lastLead = at.z;
      return;
    }
    const lead = this.leadPlayerPos().z;
    if (lead > this.lastLead) {
      this.campaign.stats.distance += lead - this.lastLead;
      this.distanceTravelled += lead - this.lastLead;
      this.lastLead = lead;
    }
  }

  private bellDone = false;
  private nightTold = false;

  /** Open world: crossing into a city district eases the light, and swaps the rules (noise, wildlife, cars) once well inside. */
  private updateBiome(dt: number, snap = false) {
    const o = this.terrain?.open;
    if (!o || !o.districts.length) return;
    let m = 0;
    for (const p of this.players) m += districtMask(o, p.vehicle ? p.vehicle.position.x : p.pos.x, p.vehicle ? p.vehicle.position.z : p.pos.z);
    m /= Math.max(1, this.players.length);
    this.cityMix = snap ? m : this.cityMix + (m - this.cityMix) * Math.min(1, dt * 1.5);
    if (this.cityMix > 0.6) this.biome = 'city';
    else if (this.cityMix < 0.4) this.biome = 'wasteland';
  }

  protected syncExtra(alpha: number, dt: number) {
    for (const e of this.activeContainers.values()) {
      e.glint.rotation.y += dt * 2.4;
      e.glint.position.y += Math.sin(this.time * 3 + e.c.x) * 0.002;
    }
    // Ground cover only exists near a player: hide it on chunks too far away for anyone to see it.
    const pts = this.players.map((p) => (p.vehicle ? p.vehicle.position : p.pos));
    for (const view of this.chunks.values()) {
      const cx = (view.data.cx + 0.5) * CHUNK;
      const cz = (view.data.cz + 0.5) * CHUNK;
      let d = Infinity;
      for (const p of pts) d = Math.min(d, Math.hypot(p.x - cx, p.z - cz));
      view.setDetailDistance(Math.max(0, d - CHUNK * 0.71));
    }
    void alpha;
  }

  /** The road is kept clear of mushrooms. */
  protected noMushroomAt(x: number, z: number): boolean {
    if (super.noMushroomAt(x, z)) return true;
    const T = this.terrain;
    return !!T && Math.abs(x - roadX(T, z)) < 5;
  }

  /** What the tripping can feel through the ground: loose pickups, the good ones in a stronger colour, and unlooted containers. */
  protected senseLoot(p: Player, radius: number, add: (x: number, y: number, z: number, kind: 'loot' | 'chest') => void) {
    const cx = p.vehicle ? p.vehicle.position.x : p.pos.x;
    const cz = p.vehicle ? p.vehicle.position.z : p.pos.z;
    for (const [, e] of this.pickups) {
      const s = e.spawn;
      if (Math.hypot(s.x - cx, s.z - cz) > radius) continue;
      const rare = s.kind === 'fragment' || s.kind === 'chassis' || (s.kind === 'part' && s.amount >= 2);
      add(s.x, s.y + 0.6, s.z, rare ? 'chest' : 'loot');
    }
    for (const [, ac] of this.activeContainers) {
      const c = ac.c;
      if (c.taken || Math.hypot(c.x - cx, c.z - cz) > radius) continue;
      add(c.x, (c.y ?? this.groundAt(c.x, c.z)) + 0.8, c.z, 'chest');
    }
  }

  /** The road ahead, lit: a line of points from just in front of the player to the end of the leg. */
  protected guidePath(p: Player): { x: number; y: number; z: number }[] {
    const T = this.terrain;
    if (!T) return [];
    const z0 = p.vehicle ? p.vehicle.position.z : p.pos.z;
    const end = this.src.layout.end.z + 4;
    const out: { x: number; y: number; z: number }[] = [];
    for (let k = 0; k < 64; k++) {
      const z = z0 + 6 + k * 2.6;
      if (z > end) break;
      const x = roadX(T, z);
      out.push({ x, y: this.groundAt(x, z) + 0.35, z });
    }
    return out;
  }

  protected updateMusicState() {
    let combat = false;
    let stealth = false;
    for (const p of this.players) {
      const x = p.vehicle ? p.vehicle.position.x : p.pos.x;
      const z = p.vehicle ? p.vehicle.position.z : p.pos.z;
      for (const v of this.vehicles) if (v.faction === 'raider' && !v.wreck && Math.hypot(v.position.x - x, v.position.z - z) < 140) combat = true;
      for (const u of this.raiders.units) if (!u.dead && Math.hypot(u.x - x, u.z - z) < 90) combat = true;
      this.zombies.forEachNear(x, z, 45, (zb) => {
        if (zb.chasing) combat = true;
        else if (this.biome === 'city' && zb.state === 'investigate') stealth = true;
      });
      if (this.biome === 'city' && p.signatureShown > 18) stealth = true;
    }
    this.audio.setMusic(combat ? 'combat' : stealth ? 'stealth' : 'travel');
  }

  compassPins(): CompassPin[] {
    const pins: CompassPin[] = [];
    const L = this.src.layout;
    pins.push({ x: L.end.x, z: L.end.z, kind: 'end', label: this.terrain?.open ? 'HAVEN' : 'CAMP' });
    for (const e of L.encounters) if (!this.doneEncounters.has(e.id)) pins.push({ x: e.x, z: e.z, kind: 'encounter', label: '!' });
    for (const zs of this.zones) {
      if (zs.zone.pin !== false && zs.zone.containers.some((c) => !c.taken)) pins.push({ x: zs.zone.x, z: zs.zone.z, kind: 'zone', label: zs.zone.kind.slice(0, 1).toUpperCase() });
    }
    for (const [, e] of this.pickups) {
      if (e.spawn.kind === 'fragment') pins.push({ x: e.spawn.x, z: e.spawn.z, kind: 'fragment', label: 'R' });
      if (e.spawn.kind === 'chassis') pins.push({ x: e.spawn.x, z: e.spawn.z, kind: 'chassis', label: 'C' });
    }
    // Your own vehicles left standing, so an old ride is easy to find again.
    for (const v of this.vehicles) {
      if (v.faction === 'convoy' && v.kind === 'player' && !v.wreck && !v.driver && !v.passenger) pins.push({ x: v.position.x, z: v.position.z, kind: 'ride', label: 'RIDE' });
    }
    for (const m of this.terrain!.minefields) {
      const z = (m.z0 + m.z1) / 2;
      pins.push({ x: roadX(this.terrain!, z), z, kind: 'threat', label: 'MINES' });
    }
    for (const v of this.vehicles) if (v.faction === 'raider' && !v.wreck) pins.push({ x: v.position.x, z: v.position.z, kind: 'ambush', label: '' });
    for (const p of this.pings) pins.push({ x: p.x, z: p.z, kind: 'ping', label: '' });
    // Lakes and ways down only show once you are within a few hundred metres.
    const nearAny = (x: number, z: number, r: number) => this.players.some((p) => Math.hypot((p.vehicle?.position.x ?? p.pos.x) - x, (p.vehicle?.position.z ?? p.pos.z) - z) < r);
    for (const l of this.terrain!.lakes) if (l.dock && nearAny(l.dock.shoreX, l.dock.shoreZ, 420)) pins.push({ x: l.dock.shoreX, z: l.dock.shoreZ, kind: 'dock', label: 'DOCK' });
    for (const d of this.src.layout.delves) if (nearAny(d.x, d.z, 420)) pins.push({ x: d.x, z: d.z, kind: 'delve', label: d.theme === 'cave' ? 'CAVE' : d.theme === 'mine' ? 'MINE' : d.theme === 'bunker' ? 'BUNKER' : 'METRO' });
    return pins;
  }

  // ------------------------------------------------------------------ map

  /** The map button steps through: minimap alone, a larger local map, the whole leg. */
  mapModes = 3;
  private mapBaker: LegMapBaker | null = null;
  private frame: MapFrame | null = null;
  /** Places the convoy has come within sight of: they stay on the map once seen. */
  private mapSeen = new Set<string>();

  mapFrame(pins: CompassPin[]): MapFrame | null {
    const T = this.terrain!;
    let f = this.frame;
    if (!f) {
      const baker = (this.mapBaker = new LegMapBaker(T, this.src.layout));
      f = this.frame = newFrame('leg');
      f.title = this.leg.name;
      f.base = baker.base;
      f.bounds = baker.bounds;
      if (T.open) f.roads = openRoadLines(T);
      else f.road = roadLine(T);
      f.roadHalf = T.roadHalf;
      f.hazards = T.minefields.map((m) => minefieldOutline(T, m.z0, m.z1, m.halfWidth));
      f.overview = true;
    }
    // In the open world the same map is a city one block over and a desert one block back.
    f.radiusMin = this.biome === 'city' ? 80 : 150;
    f.radiusMax = this.biome === 'city' ? 170 : 320;
    // A few milliseconds a frame until the ground is baked.
    if (this.mapBaker && !this.mapBaker.base.done) this.mapBaker.step(3);
    this.fillMapActors(f, true, f.radiusMax);
    // Places show once someone has been near enough to see them, and stay.
    const nearAny = (x: number, z: number, r: number) => this.players.some((p) => Math.hypot((p.vehicle?.position.x ?? p.pos.x) - x, (p.vehicle?.position.z ?? p.pos.z) - z) < r);
    for (const s of T.sites) if (SITE_LABEL[s.kind] && !this.mapSeen.has(`s${s.x}:${s.z}`) && nearAny(s.x, s.z, 480)) this.mapSeen.add(`s${s.x}:${s.z}`);
    for (const d of this.src.layout.delves) if (!this.mapSeen.has(`d${d.id}`) && nearAny(d.x, d.z, 420)) this.mapSeen.add(`d${d.id}`);
    for (const l of T.lakes) if (l.dock && !this.mapSeen.has(`l${l.id}`) && nearAny(l.dock.shoreX, l.dock.shoreZ, 420)) this.mapSeen.add(`l${l.id}`);
    f.pins.length = 0;
    for (const p of pins) if (p.kind !== 'dock' && p.kind !== 'delve') f.pins.push({ x: p.x, z: p.z, kind: p.kind, label: p.label });
    for (const s of T.sites) if (this.mapSeen.has(`s${s.x}:${s.z}`)) f.pins.push({ x: s.x, z: s.z, kind: 'site', label: SITE_LABEL[s.kind] });
    for (const l of T.lakes) if (l.dock && this.mapSeen.has(`l${l.id}`)) f.pins.push({ x: l.dock.shoreX, z: l.dock.shoreZ, kind: 'dock', label: 'DOCK' });
    for (const d of this.src.layout.delves) {
      if (this.mapSeen.has(`d${d.id}`)) f.pins.push({ x: d.x, z: d.z, kind: 'delve', label: d.theme === 'cave' ? 'CAVE' : d.theme === 'mine' ? 'MINE' : d.theme === 'bunker' ? 'BUNKER' : 'METRO' });
    }
    return f;
  }

  /** HUD helper: nearest active scavenge zone horde countdown affecting a player. */
  hordeCountdown(p: Player): number {
    for (const zs of this.zones) {
      if (zs.horde > 0 && Math.hypot(p.pos.x - zs.zone.x, p.pos.z - zs.zone.z) < 90) return zs.horde;
    }
    return 0;
  }

  dispose() {
    for (const [k] of this.chunks) this.unloadChunk(k);
    for (const e of this.pickups.values()) {
      disposeTree(e.group);
      e.group.removeFromParent();
    }
    this.pickups.clear();
    for (const id of [...this.activeContainers.keys()]) this.removeContainerView(id);
    if (this.mineMesh) {
      disposeTree(this.mineMesh);
      this.mineMesh.dispose();
      this.mineMesh.removeFromParent();
    }
    // Materials and textures are made per leg.
    disposeChunkMaterials(this.mats);
    if (this.cityMats) disposeChunkMaterials(this.cityMats);
    this.R.onBeforeView[1] = () => {};
    this.landscape.dispose();
    super.dispose();
  }
}

import { lightAt } from '../sim/dayclock';
function lightAtClock(clock: DayClock, biome: 'wasteland' | 'city') {
  return lightAt(clock.t, biome);
}

const WARN_A = new THREE.Color(0xff3a2a);
const WARN_B = new THREE.Color(0x4a1a14);
void ENEMIES;
