import type * as THREE from 'three';
import type { PhysicsWorld } from '../physics/physics';
import type { GameRenderer } from '../render/renderer';
import type { Particles, Tracers } from '../render/particles';
import type { WorkFx } from '../render/workFx';
import type { SignatureGrid } from '../sim/signature';
import type { ObstacleIndex } from './obstacles';
import type { TerrainDef, Surface } from '../world/terrain';
import type { Campaign } from './campaign';
import type { InputManager } from '../input/input';
import type { Rng } from '../core/rng';
import type { Stocks } from '../data';
import type { Player } from './player';
import type { Vehicle } from './vehicle';
import type { ZombieSystem } from './zombies';
import type { PhantomSystem } from './phantoms';
import type { WildlifeSystem } from './wildlife';
import type { RaiderSystem } from './raiders';
import type { CrewSystem } from './crew';
import type { Combat } from './combat';
import type { Gore } from './gore';
import type { WorldDamage } from './destruction';
import type { AudioEngine } from '../audio/audio';
import type { InteractRegistry } from './interact';
import type { Projectiles } from './projectiles';
import type { Aabb } from '../world/layout';
import type { CarField } from './cars';
import type { DebrisField } from './debris';
import type { TrackMarks } from '../render/trackMarks';
import type { Faction } from './vehicle';
import type { VehicleBuild } from '../sim/garage';
import type { Carried, Goods, Loose } from '../sim/carry';

export type NoteKind = 'info' | 'good' | 'warn' | 'bad';

/** Parts, fuel cans and oil cans lying about that a player can lift, carry and put down. */
export interface LooseWorld {
  /** The nearest liftable thing within `r` metres of a point. `prefer` keeps a hold on one item while it stays in reach. */
  nearest(x: number, z: number, r: number, prefer?: string): Loose | null;
  /** Take it out of the world and hand it over. */
  take(id: string): Carried | null;
  /** The nearest item that goes straight into the stockpile when picked up. */
  nearestGoods(x: number, z: number, r: number, prefer?: string): Goods | null;
  /** Pick it up: banks it and removes it from the world. */
  takeGoods(id: string, by: Player): boolean;
  /** Set something down on the ground. */
  drop(x: number, z: number, c: Carried): void;
}

/** The shared world a running scene (a leg or a camp) exposes to every entity and system. */
export interface Ctx {
  P: PhysicsWorld;
  R: GameRenderer;
  root: THREE.Group;
  fx: Particles;
  /** Cosmetic staging of work on vehicles: parts flying, bursts, callouts. */
  work: WorkFx;
  tracers: Tracers;
  sig: SignatureGrid;
  obs: ObstacleIndex;
  biome: 'wasteland' | 'city';
  mode: 'leg' | 'camp' | 'delve';
  terrain: TerrainDef | null;
  /** How many views the map button steps through: 1 is the minimap alone. */
  mapModes: number;
  campaign: Campaign;
  audio: AudioEngine;
  input: InputManager;
  rng: Rng;
  combat: Combat;
  /** Blood decals, thrown limbs, spent brass and bullet holes. */
  gore: Gore;
  /** Things that break when hurt (a plank wall, a barricade). Absent where nothing does. */
  world?: WorldDamage;
  /** Simulation seconds since the scene started. */
  time: number;
  /** 0 by day, 1 deep night. */
  night: number;
  /** Dust storm strength, 0 clear to 1 the full wall. */
  storm: number;
  /** Heat wave strength, 0 mild to 1 the full swelter. Engines shed heat badly in it. */
  heat: number;
  players: Player[];
  vehicles: Vehicle[];
  zombies: ZombieSystem;
  /** What the tripping see that is not there: drawn only for them, and never real. */
  phantoms: PhantomSystem;
  /** Herds, packs and flocks of wild animals. */
  wildlife: WildlifeSystem;
  raiders: RaiderSystem;
  crew: CrewSystem;
  vehicleByCollider: Map<number, Vehicle>;
  interact: InteractRegistry;
  projectiles: Projectiles;
  /** Abandoned cars and everything that can be done to them. */
  cars: CarField;
  /** What has come off vehicles and lies in the road. */
  debris: DebrisField;
  /** Tyre grooves and skid marks. */
  marks: TrackMarks;
  /** A vehicle from a build, added to the scene. */
  spawnVehicle(opts: { build: VehicleBuild; x: number; z: number; yaw: number; ownerIndex: number; faction?: Faction; y?: number; hulk?: boolean }): Vehicle;
  /** True once the physics ground under a point exists (chunks stream in), so a car can safely be dropped there. */
  colliderReady?(x: number, z: number): boolean;
  /** True if a point is inside a building (under its roof line): the camera closes in and rises there. */
  interiorAt?(x: number, z: number, y: number): boolean;
  /** Things on the ground that can be carried. Absent where there are none (camp, caves). */
  loose?: LooseWorld;
  /** Open the field workbench for a vehicle (set by the game when a UI is available). */
  openWorkbench?: (p: Player, v: Vehicle) => void;
  /** Open a player's inventory: what they wear, hold and carry (set by the game when a UI is available). */
  openInventory?: (p: Player) => void;
  /** Remove a barricade (rammed, breached or smashed). */
  breakBarricade(a: Aabb, how: 'ram' | 'charge' | 'smash'): void;
  groundAt(x: number, z: number): number;
  surfaceAt(x: number, z: number): { grip: number; drag: number; name: Surface };
  /** How much dust the ground gives up under wheels, 0..1: grass holds it down. Absent means all of it. */
  groundDust?(x: number, z: number): number;
  /** Water over the ground at a point, or null on dry land: its current (metres per second), what kind it is, and its name if it has one. */
  waterAt(x: number, z: number): { level: number; depth: number; flow?: [number, number]; kind?: import('../world/lakes').WaterKind; name?: string } | null;
  notify(player: number, text: string, kind?: NoteKind): void;
  radio(text: string): void;
  tip(id: string): void;
  /** Loot gained by the convoy. Crew cuts are withheld automatically. */
  addLoot(gross: Partial<Stocks>, label?: string): void;
  /** A piece of gear found by one person: their bag, else their partner's, else Scrap. */
  addGear(by: Player, item: import('../sim/gear').GearItem): void;
  /** A find that lands on the ground near (x, z) for someone to walk up to and take. */
  dropGear(item: import('../sim/gear').GearItem, x: number, z: number): void;
  /** How far the convoy has come, 0 to 1. */
  readonly gearProgress: number;
  onVehicleDestroyed(v: Vehicle): void;
  /** Is a world point inside any player's view frustum (with margin)? Used so spawns never pop in view. */
  visibleToAnyView(x: number, y: number, z: number, margin?: number): boolean;
  /** Extra Signature added by the scene (night headlights, camp lights). */
  signatureMult: number;
  /** Camp: handle a player's build-mode input. Returns true if the input was consumed. */
  campHook?: (p: Player, it: import('../input/intents').PlayerIntent, dt: number) => boolean;
  /** Camp: a bullet or blast hit a static collider that may be a built structure. */
  structureHit?: (colliderHandle: number, dmg: number) => void;
  /** Axis-aligned world bounds the convoy should stay inside (camp arena). */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number } | null;
}
