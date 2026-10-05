import type { ChunkSource } from '../world/chunkgen';
import type { ZombieKind } from '../data';
import type { DelveRecord } from './delveScene';
import type { CarField } from './cars';
import type { TrackSnapshot } from '../render/trackMarks';
import type { Carried } from '../sim/carry';

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
  /** Parts and cans lying on the ground (torn off a vehicle, or set down) when the convoy made camp. */
  drops: { x: number; z: number; carried: Carried }[] = [];
  zombies: SavedZombie[] = [];
  camp: WorldPose | null = null;

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
    m.ambushDone = new Set(s.ambush ?? []);
    m.gangKilled = new Set(s.gang ?? []);
    m.camp = s.camp ?? null;
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
}
