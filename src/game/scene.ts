import * as THREE from 'three';
import { PhysicsWorld, G, groups } from '../physics/physics';
import { Particles, Tracers } from '../render/particles';
import { WorkFx } from '../render/workFx';
import { ZombieRenderer } from '../render/zombieRender';
import { AnimalRenderer } from '../render/animalRender';
import { QUALITY, type GameRenderer } from '../render/renderer';
import { SignatureGrid } from '../sim/signature';
import { splitLoot, whole } from '../sim/resources';
import { DayClock, lightMix } from '../sim/dayclock';
import { groundDamp, heatLevel, stormImminent, stormLevel, stormWindow, STORM_WIND, type StormWindow } from '../sim/weather';
import { TANK_DREGS, takeReserve } from '../sim/fuel';
import { Rng } from '../core/rng';
import { clamp, clamp01, smoothstep } from '../core/math';
import { LEGS, VEHICLES, STOCK_IDS, gearDef, t, type Stocks } from '../data';
import type { GearItem } from '../sim/gear';
import type { Surface, TerrainDef } from '../world/terrain';
import type { Aabb } from '../world/layout';
import type { InputManager } from '../input/input';
import type { AudioEngine, EngineState } from '../audio/audio';
import { Campaign } from './campaign';
import { Combat } from './combat';
import { Gore } from './gore';
import type { Ctx, NoteKind } from './ctx';
import { CrewSystem } from './crew';
import { CarField } from './cars';
import { DebrisField } from './debris';
import { TrackMarks } from '../render/trackMarks';
import { clearShells } from '../render/shellCache';
import { InteractRegistry } from './interact';
import { GroundGearField } from './groundGear';
import { ObstacleIndex } from './obstacles';
import { Player } from './player';
import { Projectiles } from './projectiles';
import { RaiderSystem } from './raiders';
import { Vehicle, type Faction } from './vehicle';
import type { VehicleBuild } from '../sim/garage';
import { ZombieSystem } from './zombies';
import { PhantomSystem } from './phantoms';
import { PlayerFx, type Mark } from '../render/playerFx';
import { NO_LOOK, senseSpec } from '../sim/drugs';
import { WildlifeSystem } from './wildlife';
import { LABEL } from '../sim/resources';
import { disposeTree } from '../render/dispose';
import type { DelveSite } from '../world/delveSites';
import { PLAYER_CSS } from '../render/palette';
import type { MapFrame } from '../ui/mapdata';

const _flashDir = new THREE.Vector3();

export interface SceneServices {
  R: GameRenderer;
  audio: AudioEngine;
  input: InputManager;
  campaign: Campaign;
  /** Called with radio subtitles (shown on both halves). */
  onRadio: (text: string) => void;
  onTip: (id: string) => void;
  onBanner?: (title: string, sub: string) => void;
}

/** Shared runtime for a leg or a camp. Implements Ctx so every entity talks to one interface. */
export abstract class Scene implements Ctx {
  P = new PhysicsWorld();
  R: GameRenderer;
  root = new THREE.Group();
  fx = new Particles();
  work = new WorkFx(this.fx);
  tracers = new Tracers();
  sig = new SignatureGrid();
  obs = new ObstacleIndex();
  abstract biome: 'wasteland' | 'city';
  /** 0 to 1: how far the convoy is into a city district of the open world. -1 means "whatever the biome says". */
  cityMix = -1;

  /** The mix the light uses: smooth in the open world, 0 or 1 everywhere else. */
  get lightCity(): number {
    return this.cityMix >= 0 ? this.cityMix : this.biome === 'city' ? 1 : 0;
  }
  abstract mode: 'leg' | 'camp' | 'delve';
  terrain: TerrainDef | null = null;
  /** The map button steps through this many views (minimap alone, then larger ones). */
  mapModes = 1;
  campaign: Campaign;
  audio: AudioEngine;
  input: InputManager;
  rng: Rng;
  combat: Combat;
  /** Blood, limbs, brass and bullet holes: what a fight leaves behind. */
  gore: Gore;
  world?: Ctx['world'];
  time = 0;
  night = 0;
  /** Dust storm strength, 0 clear to 1 the full wall. Smoothed, and always 0 away from a leg. */
  storm = 0;
  /** True while the storm is still building, false once it has peaked and is blowing out. */
  stormRising = true;
  /** Heat wave strength, 0 mild to 1 the full swelter. Smoothed, and always 0 away from a leg. */
  heat = 0;
  private heatTold = 0;
  private stormWin: StormWindow | null | undefined;
  private stormTold = 0;
  private stormForeTold = false;
  players: Player[] = [];
  vehicles: Vehicle[] = [];
  zombies: ZombieSystem;
  phantoms: PhantomSystem;
  wildlife: WildlifeSystem;
  raiders: RaiderSystem;
  crew: CrewSystem;
  cars: CarField;
  debris = new DebrisField(this);
  marks = new TrackMarks();
  vehicleByCollider = new Map<number, Vehicle>();
  interact = new InteractRegistry();
  /** Gear lying in the world, waiting to be taken. */
  groundGear: GroundGearField | null = null;
  projectiles: Projectiles;
  signatureMult = 1;
  bounds: Ctx['bounds'] = null;
  campHook?: Ctx['campHook'];
  openWorkbench?: Ctx['openWorkbench'];
  openInventory?: Ctx['openInventory'];
  loose?: Ctx['loose'];
  structureHit?: Ctx['structureHit'];
  clock = new DayClock(540, 0.02);
  protected zr = new ZombieRenderer();
  /** Phantoms are drawn with their own translucent copy of the body, into one player's view at a time. */
  protected ghosts = new ZombieRenderer({ ghost: true, max: 24 });
  /** Per-player world effects of a trip: spores, sense marks, giant mushrooms. */
  protected playerFx: PlayerFx;
  protected ar = new AnimalRenderer();
  protected spots: THREE.SpotLight[] = [];
  protected frustums = [new THREE.Frustum(), new THREE.Frustum()];
  private pm = new THREE.Matrix4();
  protected services: SceneServices;
  private sigDecayT = 0;
  protected lootFeed: { text: string; t: number }[] = [];
  private lootAcc: Partial<Stocks> = {};
  private lootAccT = 0;
  private engineT = 0;
  /** Set when the scene wants the Game to react (fail, camp, etc.). */
  onResult: (r: SceneResult) => void = () => {};
  paused = false;
  /** Whole-scene fixed tick count. */
  ticks = 0;
  protected disposed = false;

  constructor(svc: SceneServices) {
    this.services = svc;
    this.R = svc.R;
    this.audio = svc.audio;
    this.input = svc.input;
    this.campaign = svc.campaign;
    this.rng = new Rng(svc.campaign.seed * 977 + svc.campaign.day * 131);
    this.combat = new Combat(this);
    this.gore = new Gore(this);
    this.zombies = new ZombieSystem(this);
    this.phantoms = new PhantomSystem(this);
    this.playerFx = new PlayerFx(this.R);
    this.wildlife = new WildlifeSystem(this);
    this.raiders = new RaiderSystem(this);
    this.crew = new CrewSystem(this);
    this.cars = new CarField(this);
    this.projectiles = new Projectiles(this);
    this.R.scene.add(this.root);
    this.root.add(this.work.root);
    this.root.add(this.marks.mesh);
    this.gore.attach(this.root);
    this.R.scene.add(this.fx.smoke.points);
    this.R.scene.add(this.fx.glow.points);
    this.R.scene.add(this.tracers.mesh);
    this.root.add(this.zr.mesh);
    this.ghosts.mesh.visible = false;
    this.root.add(this.ghosts.mesh);
    this.root.add(this.playerFx.group);
    this.root.add(this.ar.group);
    this.installViewHooks();
    // Constant light count: two headlight spots always exist, off by default.
    for (let i = 0; i < 2; i++) {
      const s = new THREE.SpotLight(0xfff0c8, 0, 70, 0.5, 0.6, 1.4);
      s.castShadow = false;
      this.root.add(s);
      this.root.add(s.target);
      this.spots.push(s);
    }
    // Binaural HRTF Acoustic Diffraction & Obstacle Occlusion:
    // Uses multi-ray aperture testing (direct path, left/right diffraction flanks, and vertical clearance)
    // with 3D elevation, terrain heightfield filtering, and proximity falloff to prevent open-air obstacles
    // from causing abrupt on/off switch jumps or occluding sounds across open desert terrain.
    this.audio.setOcclusionTester?.((fx, fz, tx, tz) => {
      // 1. Calculate true 3D positions above local terrain
      const fy = this.groundAt(fx, fz) + 1.3; // Listener ear height
      const ty = this.groundAt(tx, tz) + 1.1; // Sound source height (engine / muzzle / torso)

      const dx = tx - fx;
      const dy = ty - fy;
      const dz = tz - fz;
      const len3D = Math.hypot(dx, dy, dz);
      if (len3D < 0.6) return 0; // Inside own vehicle or direct contact: zero occlusion

      // Total outdoor distance threshold: in open desert air, sound diffracts spherically
      // around isolated containers; beyond 65m in open air, an isolated container has no audible acoustic shadow.
      const isInterior =
        ('isInterior' in this && !!(this as unknown as { isInterior?: boolean }).isInterior) ||
        ('interiorAt' in this && typeof (this as unknown as { interiorAt: Function }).interiorAt === 'function' &&
          (!!(this as unknown as { interiorAt: Function }).interiorAt(fx, fz, fy) ||
           !!(this as unknown as { interiorAt: Function }).interiorAt(tx, tz, ty)));

      if (!isInterior && len3D > 70) return 0;

      const dirX = dx / len3D;
      const dirY = dy / len3D;
      const dirZ = dz / len3D;

      // Filter: ignore Rapier HeightField (shapeType 7).
      // Open desert dunes, gentle slopes, and terrain bumps must NEVER be treated as solid concrete bunker walls.
      const notGround = (c: any) => {
        if (!c || typeof c.shapeType !== 'function') return true;
        return c.shapeType() !== 7;
      };

      // 2. Direct line of sight raycast
      const centerHit = this.P.raycast(
        fx,
        fy,
        fz,
        dirX,
        dirY,
        dirZ,
        len3D - 0.2,
        groups(0xffff, G.STATIC | G.BUILD),
        undefined,
        notGround,
      );

      // 3. Diffraction flanks (left/right perpendicular to horizontal line-of-sight)
      const lenXZ = Math.hypot(dx, dz);
      const normX = -dz / (lenXZ || 1);
      const normZ = dx / (lenXZ || 1);

      // Flank spacing: 1.5m to test if sound can bend around the container/wall
      const flankW = 1.5;

      const leftDist = Math.hypot(tx - (fx + normX * flankW), dy, tz - (fz + normZ * flankW));
      const leftHit = this.P.raycast(
        fx + normX * flankW,
        fy,
        fz + normZ * flankW,
        (tx - (fx + normX * flankW)) / (leftDist || 1),
        dy / (leftDist || 1),
        (tz - (fz + normZ * flankW)) / (leftDist || 1),
        len3D - 0.2,
        groups(0xffff, G.STATIC | G.BUILD),
        undefined,
        notGround,
      );

      const rightDist = Math.hypot(tx - (fx - normX * flankW), dy, tz - (fz - normZ * flankW));
      const rightHit = this.P.raycast(
        fx - normX * flankW,
        fy,
        fz - normZ * flankW,
        (tx - (fx - normX * flankW)) / (rightDist || 1),
        dy / (rightDist || 1),
        (tz - (fz - normZ * flankW)) / (rightDist || 1),
        len3D - 0.2,
        groups(0xffff, G.STATIC | G.BUILD),
        undefined,
        notGround,
      );

      // Vertical clearance: test if sound spills over low barriers (like 2.4m shipping containers or fences)
      const topY = fy + 1.8;
      const topDist = Math.hypot(dx, ty - topY, dz);
      const overHit = this.P.raycast(
        fx,
        topY,
        fz,
        dx / (topDist || 1),
        (ty - topY) / (topDist || 1),
        dz / (topDist || 1),
        len3D - 0.2,
        groups(0xffff, G.STATIC | G.BUILD),
        undefined,
        notGround,
      );

      // If all rays are clear, sound propagates unimpeded
      if (!centerHit && !leftHit && !rightHit && !overHit) return 0;

      // 4. Acoustic shadow proximity weighting:
      // In open air, an obstacle far from both listener and source produces negligible acoustic shadowing.
      // Proximity is strongest when listener or source is close to the barrier (inside the shadow zone).
      let proximity = 1.0;
      if (!isInterior) {
        const toi = centerHit?.toi ?? leftHit?.toi ?? rightHit?.toi ?? overHit?.toi ?? len3D * 0.5;
        const distToBarrier = Math.min(toi, Math.max(0, len3D - toi));
        // Within 3m of the container/wall: full shadow (1.0).
        // Smoothly tapers to 0.0 at 14m in open air so distant obstacles never cause shadow pop.
        proximity = smoothstep(14.0, 3.0, distToBarrier);
        if (proximity <= 0.001) return 0;

        // Also scale with total distance in open air
        const distFade = clamp01(1 - (len3D - 30) / 35);
        proximity *= distFade;
        if (proximity <= 0.001) return 0;
      }

      // Continuous weighted blockage across the acoustic aperture:
      // Direct ray: 40%, Left flank: 20%, Right flank: 20%, Over-the-top: 20%
      let blockage = 0;
      if (centerHit) blockage += 0.4;
      if (leftHit) blockage += 0.2;
      if (rightHit) blockage += 0.2;
      if (overHit) blockage += 0.2;

      // Near field: anything within a few metres of the ear (own muzzle, mounted gun, crew mate) is not
      // "behind" the wall beside you, however the rays happen to graze it.
      return clamp(blockage * proximity * smoothstep(1.5, 6, len3D), 0, 1);
    });
  }

  /** A first-person camera sits inside its own player, so that player is hidden from that view only. */
  private beforeViewHook = (i: number) => {
    this.players[i]?.beginOwnView();
    // Whatever this player is seeing that is not there goes in just for their view.
    this.ghosts.mesh.visible = this.players[i] ? this.phantoms.render(i, this.ghosts, this.time) > 0 : false;
    if (this.players[i]) this.playerFx.beginView(i, this.R.views[i].camera);
  };
  private afterViewHook = (i: number) => {
    this.players[i]?.endOwnView();
    this.ghosts.mesh.visible = false;
    this.playerFx.endView();
  };

  protected installViewHooks() {
    this.R.onBeforeView[2] = this.beforeViewHook;
    this.R.onAfterView[0] = this.afterViewHook;
  }

  // ------------------------------------------------------------------ Ctx

  abstract groundAt(x: number, z: number): number;
  abstract surfaceAt(x: number, z: number): { grip: number; drag: number; name: Surface };

  /** Water over the ground at a point (lakes), or null on dry land. */
  waterAt(x: number, z: number): { level: number; depth: number; flow?: [number, number]; kind?: import('../world/lakes').WaterKind } | null {
    void x;
    void z;
    return null;
  }

  /** True while another scene (a delve) has the screen: nothing of this one is drawn, ticked or heard. */
  suspended = false;

  suspend() {
    this.suspended = true;
    this.root.visible = false;
    this.fx.smoke.points.visible = false;
    this.fx.glow.points.visible = false;
    this.tracers.mesh.visible = false;
    this.audio.silenceEngines();
  }

  resume() {
    this.suspended = false;
    this.installViewHooks();
    this.root.visible = true;
    this.fx.smoke.points.visible = true;
    this.fx.glow.points.visible = true;
    this.tracers.mesh.visible = true;
  }

  notify(player: number, text: string, kind: NoteKind = 'info') {
    if (player < 0) {
      for (const p of this.players) p.note(text, kind);
      return;
    }
    this.players[player]?.note(text, kind);
  }

  radio(text: string) {
    this.services.onRadio(text);
    if ('playRadioChatter' in this.audio && typeof this.audio.playRadioChatter === 'function') {
      this.audio.playRadioChatter(text);
    } else {
      this.audio.play('radio');
    }
  }

  tip(id: string) {
    this.services.onTip(id);
  }

  /** Loot reaches the convoy minus each crew member's cut, held in escrow. Night scavenging pays a bonus. */
  addLoot(gross: Partial<Stocks>, label = '') {
    const bonus = this.clock.night && this.mode === 'leg' ? 1.5 : 1;
    const g: Partial<Stocks> = {};
    for (const id of STOCK_IDS) if (gross[id]) g[id] = (gross[id] as number) * bonus;
    const crew = this.campaign.crewLive.map((c) => ({ id: c.id, cut: c.cut }));
    const { net, owed } = splitLoot(g, crew);
    for (const id of STOCK_IDS) {
      if (net[id]) this.campaign.stocks[id] += net[id] as number;
    }
    for (const c of this.campaign.crewLive) {
      const o = owed[c.id];
      if (!o) continue;
      for (const id of STOCK_IDS) if (o[id]) c.owed[id] = (c.owed[id] ?? 0) + (o[id] as number);
    }
    for (const id of STOCK_IDS) if (net[id]) this.lootAcc[id] = (this.lootAcc[id] ?? 0) + (net[id] as number);
    this.lootAccT = 0.5;
    void label;
  }

  /** How far the convoy has come, 0 to 1. Later finds are better. */
  get gearProgress(): number {
    return clamp(this.campaign.history.length / Math.max(1, LEGS.legs.length - 1), 0, 1);
  }

  /** A find lands on the ground near (x, z) as a visible pickup. */
  dropGear(item: GearItem, x: number, z: number) {
    (this.groundGear ??= new GroundGearField(this)).add(item, x, z);
  }

  /**
   * A piece of gear found by one person. It goes in their bag; if that is full, their partner's; and if there is
   * nowhere to put it, it is broken down for Scrap so nothing is ever lost on the floor.
   */
  addGear(by: Player, item: GearItem) {
    const d = gearDef(item.id);
    const tag = '◆'.repeat(d.rarity);
    const r = this.campaign.giveGear(by.index, item);
    if (r.to === 'self') by.note(`Found: ${d.name} ${tag}`, 'good');
    else if (r.to === 'partner') {
      const other = by.partner;
      by.note(`Found: ${d.name} ${tag} (your bag is full, ${other?.name ?? 'your partner'} took it)`, 'info');
      other?.note(`${by.name} found a ${d.name} ${tag} for you`, 'good');
    } else by.note(`Found: ${d.name}, but there is no room: +${r.scrap} Scrap`, 'warn');
    this.audio.play('pickup', by.pos.x, by.pos.z, 0.7);
    // The first find of a run says where to wear it.
    if (!this.campaign.flags.gearTip) {
      this.campaign.flags.gearTip = true;
      this.tip('gear');
    }
    // Anything better than common is worth the radio.
    if (d.rarity >= 3) this.radio(`${by.name} found something good: ${d.name}.`);
  }

  onVehicleDestroyed(v: Vehicle) {
    this.raiders.onVehicleDestroyed(v);
    if (v.faction !== 'convoy') return;
    // Eject anyone aboard, hurt.
    for (const p of this.players) {
      if (p.vehicle === v) {
        const wasDriver = p.state === 'driving';
        p.vehicle = null;
        p.state = 'foot';
        const spot = v.exitSpot();
        p.pos.set(spot.x, this.groundAt(spot.x, spot.z) + 0.2, spot.z);
        p.body.setTranslation({ x: spot.x, y: p.pos.y + 0.85, z: spot.z }, true);
        p.prevPos.copy(p.pos);
        p.hurt(wasDriver ? 28 : 18, v.position.x, v.position.z, 'blast');
        p.cam.snap();
      }
    }
    v.driver = null;
    v.passenger = null;
    if (v.kind === 'player') {
      this.campaign.stats.vehiclesLost++;
      const owner = this.players[v.ownerIndex];
      if (owner) {
        this.radio(`${owner.name}'s ride is wrecked.`);
        this.campaign.players[v.ownerIndex].alive = false;
      }
    }
    this.audio.play('boom', v.position.x, v.position.z, 1);
  }

  visibleToAnyView(x: number, y: number, z: number, margin = 6): boolean {
    const p = new THREE.Vector3(x, y, z);
    for (let i = 0; i < this.players.length; i++) {
      const f = this.frustums[i];
      if (f.containsPoint(p)) return true;
      // Margin: test points around.
      for (const [dx, dz] of [[margin, 0], [-margin, 0], [0, margin], [0, -margin]]) {
        p.set(x + dx, y, z + dz);
        if (f.containsPoint(p)) return true;
      }
      p.set(x, y, z);
    }
    return false;
  }

  breakBarricade(a: Aabb, how: 'ram' | 'charge' | 'smash') {
    void a;
    void how;
  }

  // ------------------------------------------------------------------ vehicles & players

  /** A vehicle from a build: its parts, paint, condition and fuel come with it. */
  spawnVehicle(opts: { build: VehicleBuild; x: number; z: number; yaw: number; ownerIndex: number; faction?: Faction; y?: number; hulk?: boolean }): Vehicle {
    const v = new Vehicle(this, {
      build: opts.build,
      x: opts.x,
      z: opts.z,
      y: opts.y,
      yaw: opts.yaw,
      faction: opts.faction ?? 'convoy',
      kind: 'player',
      ownerIndex: opts.ownerIndex,
      hulk: opts.hulk,
    });
    this.vehicles.push(v);
    return v;
  }

  /** Create the players (one when solo) and (optionally) seat them in their vehicles. */
  spawnConvoy(x: number, z: number, yaw: number, spacing = 3.4, seat = true) {
    const names = this.campaign.players.map((p) => p.name);
    for (let i = 0; i < this.campaign.count; i++) {
      const p = new Player(this, i as 0 | 1, names[i]);
      this.players.push(p);
      const side = this.campaign.solo ? 0 : i === 0 ? 1 : -1;
      const px = x + Math.cos(yaw) * side * spacing;
      const pz = z - Math.sin(yaw) * side * spacing;
      p.placeAt(px, pz, yaw);
      {
        const v = this.spawnVehicle({ build: this.campaign.buildOf(i), x: px, z: pz, yaw, ownerIndex: i });
        p.ownVehicle = v;
        if (seat) {
          v.driver = p;
          p.vehicle = v;
          p.state = 'driving';
          p.aimYaw = yaw;
          v.setEngine(true);
          p.pos.set(px, v.position.y, pz);
          p.body.setTranslation({ x: px, y: v.position.y + 1, z: pz }, true);
        }
      }
    }
    // Pull each vehicle's tank from the convoy reserve (up to its capacity) so the HUD gauge reflects supplies.
    this.fillTanksFromReserve();
  }

  /**
   * Write every convoy vehicle's condition back to its build and settle who rolls out in what.
   * Wrecked vehicles are lost from the yard. Returns the names of the lost ones.
   */
  commitFleet(): string[] {
    const c = this.campaign;
    const lost: string[] = [];
    for (const v of this.vehicles) {
      if (v.faction !== 'convoy' || !v.build) continue;
      if (v.wreck) {
        lost.push(v.def.name);
        c.removeVehicle(v.build.uid);
      } else v.commit();
    }
    for (const p of this.players) {
      // Whatever you were driving when the leg ended is what you roll out in; a passenger keeps their own.
      const driving = p.state === 'driving' ? p.vehicle?.build : null;
      const own = driving ?? (p.ownVehicle && !p.ownVehicle.wreck ? p.ownVehicle.build : null);
      if (own && c.buildByUid(own.uid)) c.players[p.index].vehicle = own.uid;
    }
    c.settleActives();
    return lost;
  }

  /** Move fuel from the convoy reserve into vehicle tanks, at halts and at the Ledger. */
  fillTanksFromReserve() {
    const own = this.vehicles.filter((v) => v.faction === 'convoy' && v.kind === 'player');
    for (const v of own) {
      // The pump gives an engine what it burns. A tank still holding the other fuel is left alone: it has to be drained.
      const want = v.stats.fuel;
      if (v.fuelType !== want) {
        if (v.fuel >= TANK_DREGS) continue;
        v.fuelType = want;
        v.fuel = 0;
      }
      v.fuel += takeReserve(this.campaign, want, v.tankMax - v.fuel);
    }
  }

  /** True while a scene drives the cameras itself from tickIdle (camp ledger) instead of the players' render-time chase cameras. */
  protected idleCam = false;

  // ------------------------------------------------------------------ fixed tick

  /** Runs after the mode's own pre-tick work. Order follows the blueprint's game loop. */
  tick(dt: number) {
    this.ticks++;
    this.idleCam = false;
    this.time += dt;
    for (const v of this.vehicles) v.snapshotPrev();
    for (const p of this.players) p.update(dt);
    this.phantoms.update(dt);
    // Vehicles (convoy and raiders) apply driver intent and step wheel models.
    for (const v of this.vehicles) v.update(dt);
    this.cars.update(dt);
    this.raiders.update(dt);
    this.zombies.update(dt);
    this.wildlife.update(dt);
    this.crew.update(dt);
    this.projectiles.update(dt);
    this.combat.update(dt);
    this.gore.update(dt);
    this.groundGear?.update(dt);
    this.debris.update(dt);
    this.P.step();
    // Post-step gameplay systems.
    for (const v of this.vehicles) if (v.faction === 'convoy' || v.kind !== 'wagon') {
        this.zombies.plow(v, dt);
        this.wildlife.plow(v);
      }
    this.updateVehiclePlayerHits(dt);
    this.sigDecayT += dt;
    this.sig.decay(dt);
    this.modeTick(dt);
    const tick = this.clock.tick(dt);
    if (tick.warn && this.mode === 'leg') this.radio(t('radio.duskWarn'));
    this.tickWeather(dt);
    // Loot popups
    if (this.lootAccT > 0) {
      this.lootAccT -= dt;
      if (this.lootAccT <= 0) this.flushLoot();
    }
    this.tickNight();
  }

  protected abstract modeTick(dt: number): void;

  private flushLoot() {
    const parts: string[] = [];
    for (const id of STOCK_IDS) {
      const v = this.lootAcc[id];
      if (v && whole(v * 10) > 0) parts.push(`+${v >= 10 || id !== 'fuel' ? Math.round(v) : v.toFixed(1)} ${LABEL[id]}`);
    }
    this.lootAcc = {};
    if (parts.length) this.notify(-1, parts.join('  '), 'good');
  }

  /** Follow the day's storm window, say so on the radio as it arrives and clears, and stir up the air around each player. */
  private tickWeather(dt: number) {
    if (this.stormWin === undefined) this.stormWin = stormWindow(this.campaign.seed, this.campaign.day);
    const win = this.stormWin;
    const target = this.mode === 'leg' ? stormLevel(this.clock.t, win) : 0;
    const prev = this.storm;
    // Ease toward the target so a jump (a loaded save, a fresh scene) still has a wind-up.
    this.storm += (target - this.storm) * Math.min(1, dt * 1.4);
    if (Math.abs(this.storm - target) < 0.002) this.storm = target;
    if (win) this.stormRising = this.clock.t < (win.start + win.end) / 2;
    if (this.storm > 0.2 && this.stormTold === 0) {
      this.stormTold = 1;
      this.radio('Dust wall rolling in from the south! A wall of dust is rolling in. Raiders will lose you in it, and you will lose everything else. Watch your oil.');
    } else if (this.storm < 0.05 && prev >= 0.05 && this.stormTold === 1) {
      this.stormTold = 2;
      this.radio('The dust is settling. Visibility is coming back.');
    }
    if (this.storm > 0.15) this.stirDust(dt);
    // The sky gives a storm away a little before the first gust.
    if (this.mode === 'leg' && !this.stormForeTold && stormImminent(this.clock.t, win)) {
      this.stormForeTold = true;
      this.radio(t('radio.stormSoon'));
    }
    // Heat waves: the day's level follows the clock, smoothed like the storm.
    const heatTarget = this.mode === 'leg' ? heatLevel(this.campaign.seed, this.campaign.day, this.clock.t) : 0;
    this.heat += (heatTarget - this.heat) * Math.min(1, dt * 0.8);
    if (Math.abs(this.heat - heatTarget) < 0.002) this.heat = heatTarget;
    if (this.heat > 0.4 && this.heatTold === 0) {
      this.heatTold = 1;
      this.radio(t('radio.heat'));
    } else if (this.heat < 0.15 && this.heatTold === 1 && this.clock.t > 0.45) {
      this.heatTold = 2;
      this.radio(t('radio.heatEasing'));
    }
  }

  private stirDust(dt: number) {
    // Wind runs one way across the day so the streaks all lean together.
    const [wx, wz] = STORM_WIND;
    for (const p of this.players) {
      if (p.state === 'dead') continue;
      const px = p.vehicle?.position.x ?? p.pos.x;
      const pz = p.vehicle?.position.z ?? p.pos.z;
      const n = this.storm * 26 * dt;
      let k = Math.floor(n) + (Math.random() < n - Math.floor(n) ? 1 : 0);
      while (k-- > 0) {
        const x = px - wx * 1.1 + (Math.random() - 0.5) * 46;
        const z = pz - wz * 1.1 + (Math.random() - 0.5) * 46;
        this.fx.dust(x, this.groundAt(x, z) + Math.random() * 3.5, z, wx * 5, wz * 5, 0.55, [0.78, 0.6, 0.38]);
      }
    }
  }

  private tickNight() {
    const light = lightMix(this.clock.t, this.lightCity);
    this.night = light.night;
  }

  /** Moving vehicles can run over players on foot. */
  private updateVehiclePlayerHits(dt: number) {
    for (const v of this.vehicles) {
      if (v.wreck || Math.abs(v.speed) < 4.5) continue;
      const [fx, , fz] = v.body.forward();
      for (const p of this.players) {
        if (p.state !== 'foot' && p.state !== 'downed') continue;
        if (p.vehicle === v) continue;
        const rx = p.pos.x - v.position.x;
        const rz = p.pos.z - v.position.z;
        const lz = rx * fx + rz * fz;
        const lx = rx * fz - rz * fx;
        const half = v.def.length / 2 + 0.3;
        if (Math.abs(lz) < half && Math.abs(lx) < v.def.width / 2 + 0.4 && p.invuln <= 0) {
          p.hurt(Math.min(70, Math.abs(v.speed) * 4.5) * (v.faction === 'convoy' ? 0.6 : 1), v.position.x, v.position.z, 'ram');
          p.invuln = 0.6;
          const k = Math.sign(lx) || 1;
          p.vy = 4;
          void k;
        }
      }
    }
    void dt;
  }

  // ------------------------------------------------------------------ rendering

  /** Called once per rendered frame with the interpolation alpha. */
  renderFrame(alpha: number, dt: number) {
    const R = this.R;
    // Visual sync
    for (const v of this.vehicles) v.syncVisual(alpha, dt);
    for (const p of this.players) p.syncVisual(alpha, dt);
    this.syncExtra(alpha, dt);
    this.debris.sync(alpha);
    this.marks.update(dt);
    if (!this.idleCam) for (const p of this.players) p.renderCamera(alpha, dt);
    this.fx.setBudget(QUALITY[R.quality].particles);
    this.fx.update(dt);
    this.work.update(dt);
    this.tracers.update(dt);
    // Cameras
    for (let i = 0; i < 2; i++) {
      const p = this.players[i];
      const v = R.views[i];
      if (!p) {
        v.active = false;
        continue;
      }
      v.active = true;
      p.cam.apply(v.camera);
      R.setViewMode(i, p.firstPerson, this.input.settings.fpFov, this.input.settings.chaseFov);
      this.syncTrip(i, p, dt);
      v.focus.set(p.pos.x, p.pos.y, p.pos.z);
      if (p.vehicle) v.focus.set(p.vehicle.position.x, p.vehicle.position.y, p.vehicle.position.z);
      v.camera.updateMatrixWorld();
      this.pm.multiplyMatrices(v.camera.projectionMatrix, v.camera.matrixWorldInverse);
      this.frustums[i].setFromProjectionMatrix(this.pm);
    }
    // Light and headlights
    this.applyLighting();
    // Only the views that are drawn count: an unused view's frustum is still the default one.
    const n = this.players.length;
    this.wildlife.render(this.ar, this.frustums.slice(0, n), QUALITY[R.quality].zombies / 2, R.views.slice(0, n).map((v) => v.camera.position));
    this.zombies.render(this.zr, this.time, this.frustums.slice(0, n), QUALITY[R.quality].zombies, R.views.slice(0, n).map((v) => v.camera.position));
  }

  /**
   * One player's trip, for this frame: the renderer bends their picture and their sky, and their world effects
   * (spores, auras, mushrooms) move. Nothing here touches anyone else's view.
   */
  protected syncTrip(i: number, p: Player, dt: number) {
    const R = this.R;
    const look = p.drugs.look();
    R.setTrip(i, look, dt);
    R.applyTripCamera(i);
    const at = p.vehicle ? p.vehicle.position : p.pos;
    const sight = p.drugs.mods().sight;
    const marks = sight > 0.05 && p.alive ? this.senseMarks(p, sight) : NO_MARKS;
    this.sensed[i] = marks;
    this.playerFx.update(
      i,
      dt,
      look,
      R.trip[i].phase,
      at,
      (x, z) => this.groundAt(x, z),
      (x, z) => this.noMushroomAt(x, z),
      marks,
    );
    for (const pop of this.phantoms.pops[i]) this.playerFx.burst(i, pop.x, pop.y, pop.z, pop.seed);
    this.phantoms.pops[i].length = 0;
  }

  /** What each player's sense showed this frame. */
  private sensed: [Mark[], Mark[]] = [NO_MARKS, NO_MARKS];

  /** Deep sense (the vine) also marks the compass: everything it can see, including what the map never shows. */
  revealPins(p: Player): CompassPin[] {
    if (p.drugs.mods().sight < 0.85) return [];
    const pins: CompassPin[] = [];
    for (const m of this.sensed[p.index]) {
      if (m.kind === 'zombie' || m.kind === 'hunter') pins.push({ x: m.x, z: m.z, kind: 'threat', label: '' });
      else if (m.kind === 'raider') pins.push({ x: m.x, z: m.z, kind: 'ambush', label: '' });
      else if (m.kind === 'chest') pins.push({ x: m.x, z: m.z, kind: 'chest', label: '$' });
      else if (m.kind === 'loot') pins.push({ x: m.x, z: m.z, kind: 'part', label: '·' });
    }
    return pins;
  }

  /** Mushrooms stay off the road and out of the water. */
  protected noMushroomAt(x: number, z: number): boolean {
    return !!this.waterAt(x, z);
  }

  /** What a player's sense shows: the living through the walls, the loot, and (deep in) the road ahead. */
  protected senseMarks(p: Player, sight: number): Mark[] {
    const spec = senseSpec(sight);
    const out: Mark[] = [];
    if (spec.radius <= 0) return out;
    const cx = p.vehicle ? p.vehicle.position.x : p.pos.x;
    const cz = p.vehicle ? p.vehicle.position.z : p.pos.z;
    const gain = 0.35 + 0.65 * sight;
    const fade = (x: number, z: number) => gain * clamp(1 - Math.hypot(x - cx, z - cz) / spec.radius, 0.12, 1);
    if (spec.zombies) {
      this.zombies.forEachNear(cx, cz, spec.radius, (z) => {
        if (out.length < 100) out.push({ x: z.x, y: z.y + 1.1 * z.def.scale, z: z.z, kind: z.chasing ? 'hunter' : 'zombie', strength: fade(z.x, z.z) });
      });
    }
    if (spec.animals) {
      this.wildlife.forEachNear(cx, cz, spec.radius, (a) => {
        if (out.length < 110) out.push({ x: a.x, y: a.y + a.height * 0.5, z: a.z, kind: 'animal', strength: fade(a.x, a.z) });
      });
    }
    if (spec.raiders) {
      for (const u of this.raiders.units) {
        if (u.dead || out.length >= 120) continue;
        if (Math.hypot(u.x - cx, u.z - cz) <= spec.radius) out.push({ x: u.x, y: u.y + 1.1, z: u.z, kind: 'raider', strength: fade(u.x, u.z) });
      }
    }
    if (spec.loot) this.senseLoot(p, spec.radius, (x, y, z, kind) => out.length < 132 && out.push({ x, y, z, kind, strength: fade(x, z) }));
    if (spec.guide) {
      for (const g of this.guidePath(p)) {
        if (out.length >= 140) break;
        out.push({ x: g.x, y: g.y, z: g.z, kind: 'path', strength: gain });
      }
    }
    return out;
  }

  /** Loot within sense range, for the scene that has some. */
  protected senseLoot(p: Player, radius: number, add: (x: number, y: number, z: number, kind: 'loot' | 'chest') => void) {
    void p;
    void radius;
    void add;
  }

  /** A line of points along the way forward, for the vine to light up. Scenes with a road give one. */
  protected guidePath(p: Player): { x: number; y: number; z: number }[] {
    void p;
    return NO_PATH;
  }

  /** Nobody left standing, so the run is over. With a partner that is both of you down; solo it is bleeding out. */
  protected get everyoneDown(): boolean {
    if (this.campaign.solo) return this.players.every((p) => p.state === 'dead');
    return this.players.every((p) => p.state === 'downed' || p.state === 'dead');
  }

  protected syncExtra(alpha: number, dt: number) {
    void alpha;
    void dt;
  }

  protected applyLighting() {
    const light = lightMix(this.clock.t, this.lightCity);
    // A dust storm dries the ground out; otherwise some mornings start wet from rain in the night.
    const wet = this.mode === 'leg' ? groundDamp(this.campaign.seed, this.campaign.day, this.clock.t) * (1 - this.storm) : 0;
    this.R.setLight(light, this.biome, this.lightCity, this.storm, wet);
    // Window glow at night comes from the facade shader (it follows KIT.uGlow, set in setLight).
    // Headlights: one spot per player vehicle with lights on.
    for (let i = 0; i < 2; i++) {
      const s = this.spots[i];
      const p = this.players[i];
      const v = p?.vehicle ?? p?.ownVehicle ?? null;
      if (v && v.lights && !v.wreck && v.faction === 'convoy') {
        const [x, y, z] = v.body.toWorld(0, 0.5, v.def.length / 2 - 0.1);
        const [tx, ty, tz] = v.body.toWorld(0, -0.2, v.def.length / 2 + 25);
        s.position.set(x, y, z);
        s.target.position.set(tx, ty, tz);
        s.target.updateMatrixWorld();
        // A roof light bar throws further and brighter.
        s.intensity = 480 * (0.35 + light.night) * (1 + v.stats.light);
        s.distance = 70 * (1 + 0.5 * v.stats.light);
      } else if (p && p.state === 'foot' && light.night > 0.15) {
        // Head flashlight: from the shoulder along the view, fading in with dusk.
        const d = this.R.views[i].camera.getWorldDirection(_flashDir);
        s.position.set(p.pos.x + d.x * 0.5, p.pos.y + 1.5, p.pos.z + d.z * 0.5);
        s.target.position.set(s.position.x + d.x * 20, s.position.y + d.y * 20 - 1.2, s.position.z + d.z * 20);
        s.target.updateMatrixWorld();
        s.angle = 0.6;
        s.penumbra = 0.8;
        s.distance = 40;
        s.color.set(0xfff2d4);
        s.intensity = 160 * light.night;
      } else s.intensity = 0;
    }
  }

  /** Engines for the audio mix. */
  updateAudio(dt: number) {
    const list: EngineState[] = [];
    for (const v of this.vehicles) {
      if (v.wreck || !v.engineOn) continue;
      const rpm = clamp(Math.abs(v.speed) / Math.max(6, v.topSpeed), 0, 1);
      const throttle = clamp(v.lastIntent.throttle, 0, 1);
      const lateralG = clamp((v.body.steerAngle * v.speed) / 5, -1.5, 1.5);
      list.push({
        id: v.id,
        x: v.position.x,
        z: v.position.z,
        rpm,
        throttle,
        tier: v.def.tier,
        signature: Math.max(15, v.signature()),
        speed: v.speed,
        lateralG,
        boost: clamp(throttle * (0.35 + 0.65 * rpm), 0, 1),
      });
    }
    this.audio.setListeners(
      this.players.map((p) => ({
        x: p.vehicle?.position.x ?? p.pos.x,
        z: p.vehicle?.position.z ?? p.pos.z,
        yaw: p.vehicle ? p.vehicle.yaw : p.aimYaw,
      })),
    );
    // Indoor means a player is physically inside a building (or the scene is an interior), never the biome label:
    // that flips as the city blend crosses a threshold, which swapped every gunshot's reverb in open desert.
    const inside = this.players.some((p) => {
      const px = p.vehicle?.position.x ?? p.pos.x;
      const pz = p.vehicle?.position.z ?? p.pos.z;
      const io = this as unknown as { interiorAt?: (x: number, z: number, y: number) => boolean };
      return !!io.interiorAt?.(px, pz, this.groundAt(px, pz) + 1);
    });
    this.audio.setIndoor?.(inside || ('isInterior' in this && !!(this as unknown as { isInterior?: boolean }).isInterior));
    // Being high changes what you hear: cotton wool for the mellow, a warbling echo for the rest.
    this.players.forEach((p, i) => {
      const l = p.drugs.look();
      const drunk = Math.min(1, p.drugs.drinks / 6);
      this.audio.setTrip(i, clamp(l.blur * 1.1 + l.dark * 0.8 + drunk * 0.45 + l.glow * 0.2, 0, 0.85), clamp(l.trail * 0.7 + l.kaleido * 0.5 + l.warp * 0.3 + l.dbl * 0.3, 0, 0.9));
    });
    this.audio.updateEngines(list, dt);
    this.audio.updateMusic(dt);
    this.audio.setWind(this.storm);
    this.updateMusicState();
  }

  protected abstract updateMusicState(): void;

  // ------------------------------------------------------------------ HUD helpers

  /** Pins for the HUD compass: world markers other than the partner. */
  abstract compassPins(): CompassPin[];

  /** What the HUD needs to draw this scene's minimap and map, refreshed in place; null where a scene has no map. */
  mapFrame(pins: CompassPin[]): MapFrame | null {
    void pins;
    return null;
  }

  /**
   * The moving parts every map shows: both players, the crew, and (when `foes`) the dead who are on to you and raiders
   * on foot. Foes are shown only once they are chasing, so a map never gives away a sleeping horde.
   */
  protected fillMapActors(f: MapFrame, foes: boolean, reach = 160) {
    f.movers.length = 0;
    f.blips.length = 0;
    for (const p of this.players) {
      const v = p.vehicle;
      f.movers.push({ seat: p.index, x: v ? v.position.x : p.pos.x, z: v ? v.position.z : p.pos.z, yaw: v ? v.yaw : p.yaw, color: PLAYER_CSS[p.index] });
    }
    for (const v of this.vehicles) if (v.kind === 'crew' && !v.wreck) f.blips.push({ x: v.position.x, z: v.position.z, kind: 'crew' });
    if (!foes) return;
    const r2 = reach * reach;
    const near = (x: number, z: number) => this.players.some((p) => p.state !== 'dead' && (x - (p.vehicle ? p.vehicle.position.x : p.pos.x)) ** 2 + (z - (p.vehicle ? p.vehicle.position.z : p.pos.z)) ** 2 <= r2);
    // Each of them once, however many of us are close.
    for (const zb of this.zombies.list) if (zb.chasing && !zb.dead && f.blips.length < 80 && near(zb.x, zb.z)) f.blips.push({ x: zb.x, z: zb.z, kind: 'foe' });
    for (const u of this.raiders.units) if (!u.dead && f.blips.length < 80 && near(u.x, u.z)) f.blips.push({ x: u.x, z: u.z, kind: 'foe' });
  }

  dispose() {
    this.disposed = true;
    if ('stopRadioChatter' in this.audio && typeof this.audio.stopRadioChatter === 'function') {
      this.audio.stopRadioChatter();
    }
    // Only clear the hooks if a newer scene has not already taken them over.
    if (this.R.onBeforeView[2] === this.beforeViewHook) this.R.onBeforeView[2] = () => {};
    if (this.R.onAfterView[0] === this.afterViewHook) this.R.onAfterView[0] = () => {};
    this.cars.clear();
    this.crew.clear();
    this.raiders.clearAll();
    this.projectiles.clear();
    this.combat.clear();
    this.gore.dispose();
    for (const p of this.players) p.destroy();
    for (const v of this.vehicles) v.destroy();
    this.vehicles.length = 0;
    this.debris.clear();
    this.marks.dispose();
    clearShells();
    this.players.length = 0;
    this.work.dispose();
    this.groundGear?.dispose();
    this.root.removeFromParent();
    disposeTree(this.root);
    this.R.scene.remove(this.fx.smoke.points);
    this.R.scene.remove(this.fx.glow.points);
    this.R.scene.remove(this.tracers.mesh);
    disposeTree(this.fx.smoke.points);
    disposeTree(this.fx.glow.points);
    disposeTree(this.tracers.mesh);
    for (const s of this.spots) s.dispose();
    this.zr.mesh.dispose();
    this.ghosts.mesh.dispose();
    this.phantoms.clear();
    this.playerFx.dispose();
    this.R.setTrip(0, NO_LOOK, 0);
    this.R.setTrip(1, NO_LOOK, 0);
    this.audio.setWind(0);
    this.ar.dispose();
    this.audio.silenceEngines();
  }
}

const NO_MARKS: Mark[] = [];
const NO_PATH: { x: number; y: number; z: number }[] = [];

export interface CompassPin {
  x: number;
  z: number;
  kind: 'end' | 'encounter' | 'zone' | 'ping' | 'ambush' | 'camp' | 'fragment' | 'chassis' | 'threat' | 'watch' | 'sector' | 'hub' | 'dock' | 'delve' | 'chest' | 'key' | 'lock' | 'exit' | 'part' | 'ride';
  label?: string;
  color?: string;
}

export type SceneResult =
  | { type: 'fail'; reason: string }
  | { type: 'legEnd' }
  | { type: 'campDone' }
  | { type: 'encounter'; id: string; spotId: string }
  | { type: 'dusk' }
  | { type: 'haven' }
  | { type: 'delveEnter'; site: DelveSite }
  | { type: 'delveExit'; reason: 'climb' | 'lift' | 'rescue' };

void VEHICLES;
