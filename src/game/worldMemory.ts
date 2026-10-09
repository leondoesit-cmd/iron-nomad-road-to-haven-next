import type { ChunkSource } from '../world/chunkgen';
import type { ZombieKind } from '../data';
import type { DelveRecord } from './delveScene';
import type { CarField } from './cars';
import type { TrackSnapshot } from '../render/trackMarks';
import type { GroundSnapshot } from '../sim/groundField';
import type { Carried } from '../sim/carry';
import type { Picked } from './foraging';
import type { VegetationMemory, VegetationRecord } from '../sim/vegetation';
import { newUid } from '../sim/parts';

/** Where the convoy stands, for rolling out again from the same spot. */
export interface WorldPose {
  x: number;
  z: number;
  yaw: number;
}

export interface SavedZombie {
  kind: ZombieKind;
  x: number;
  z: number;
  dormant: boolean;
  cluster: number;
}

/**
 * What the open world remembers between one day and the next. A leg scene is torn down for the night (camp, report,
 * Ledger) and built again at dawn; this object is handed to the new one, which adopts its sets and maps as its own, so
 * a looted house stays looted, a dead horde stays dead, and a car you stripped stays stripped.
 *
 * The layout itself is deterministic from the leg's seed, so it is kept as the same object while the page is open
 * (rebuilding it costs half a second) and rebuilt from the seed after a reload, with the ids below applied on top.
 */
export class WorldMemory {
  src: ChunkSource | null = null;
  takenPickups = new Set<string>();
  doneEncounters = new Set<string>();
  shownTips = new Set<string>();
  placesShown = new Set<string>();
  brokenAabbs = new Set<number>();
  spawnedChunks = new Set<number>();
  mapSeen = new Set<string>();
  delveRecords = new Map<string, DelveRecord>();
  ambushDone = new Set<string>();
  /** Gang camp sentries that are dead, by key (`campId#index`). */
  gangKilled = new Set<string>();
  zoneFired = new Set<string>();
  /** Containers searched, by id. The layout object carries the flag; this is what survives a reload. */
  searched = new Set<string>();
  cars: CarField['states'] | null = null;
  /** Tyre grooves and skid marks laid so far, so a road stays marked from one day to the next. */
  tracks: TrackSnapshot | null = null;
  /** The loose ground's ruts, prints and craters (`sim/groundField.ts`), kept with the tracks. */
  ground: GroundSnapshot | null = null;
  /** Parts and cans lying on the ground (torn off a vehicle, or set down) when the convoy made camp. */
  drops: { x: number; z: number; carried: Carried }[] = [];
  zombies: SavedZombie[] = [];
  camp: WorldPose | null = null;
  /** Trees fire has burned, by key (`wildfire.treeKey`): how charred each is, 0..1. */
  burnt = new Map<string, number>();
  /** Ground a grass fire went over, by its cell on the burning grid (`game/fires.ts`): it stays black. */
  scorched: number[] = [];
  /** Crushed plants, weakened wood and fallen poses, by deterministic vegetation position. */
  vegetation: VegetationMemory = new Map();
  /** Wild plants picked, by spot id (`world/forage.ts`): handfuls taken and the day of the last. They grow back over the days. */
  forage = new Map<string, Picked>();

  /** The part that goes in a save file. Cars and live zombies are not kept across a reload. */
  serialize(): WorldSave {
    const src = this.src;
    if (src) for (const z of src.layout.zones) for (const c of z.containers) if (c.taken) this.searched.add(c.id);
    return {
      taken: [...this.takenPickups],
      done: [...this.doneEncounters],
      tips: [...this.shownTips],
      places: [...this.placesShown],
      seen: [...this.mapSeen],
      searched: [...this.searched],
      ambush: [...this.ambushDone],
      gang: [...this.gangKilled],
      camp: this.camp,
      burnt: [...this.burnt],
      scorched: this.scorched,
      vegetation: [...this.vegetation],
      forage: [...this.forage].map(([id, p]) => [id, p.n, p.day]),
      drops: this.drops,
    };
  }

  static restore(s: WorldSave | undefined): WorldMemory {
    const m = new WorldMemory();
    if (!s) return m;
    m.takenPickups = new Set(s.taken ?? []);
    m.doneEncounters = new Set(s.done ?? []);
    m.shownTips = new Set(s.tips ?? []);
    m.placesShown = new Set(s.places ?? []);
    m.mapSeen = new Set(s.seen ?? []);
    m.searched = new Set(s.searched ?? []);
    m.burnt = new Map(s.burnt ?? []);
    m.scorched = s.scorched ?? [];
    m.vegetation = new Map(s.vegetation ?? []);
    m.forage = new Map((s.forage ?? []).map(([id, n, day]) => [id, { n, day }]));
    m.ambushDone = new Set(s.ambush ?? []);
    m.gangKilled = new Set(s.gang ?? []);
    m.camp = s.camp ?? null;
    // A part left lying (a haul crate the full trucks could not take, a door torn off) gets a fresh id: the run's ids were
    // reseeded from the campaign alone, and this one must not meet a new part with the same.
    m.drops = (s.drops ?? []).map((d) => (d.carried.kind === 'part' ? { ...d, carried: { kind: 'part', item: { ...d.carried.item, uid: newUid('p') } } } : d));
    return m;
  }
}

export interface WorldSave {
  taken: string[];
  done: string[];
  tips: string[];
  places: string[];
  seen: string[];
  searched: string[];
  ambush: string[];
  /** Absent in saves from before gang camps. */
  gang?: string[];
  camp: WorldPose | null;
  /** Trees burned by fire: key and char. Absent in saves from before the weather. */
  burnt?: [string, number][];
  /** Burnt ground, by grid cell. Absent in saves from before grass fires. */
  scorched?: number[];
  vegetation?: [string, VegetationRecord][];
  /** Wild plants picked: id, handfuls taken, day. Absent in saves from before foraging. */
  forage?: [string, number, number][];
  /** Parts and cans lying on the ground. Absent in saves from before they were kept. */
  drops?: { x: number; z: number; carried: Carried }[];
}
