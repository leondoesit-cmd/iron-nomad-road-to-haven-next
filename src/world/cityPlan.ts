/**
 * Authored city layouts.
 *
 * A procedural city leg is a boulevard down the middle of the world with randomly sized building strips on either side
 * and cross streets between the blocks. A city plan keeps that same skeleton (so physics, zombies, camps and set pieces
 * all keep working) but replaces the dice with a hand-drawn map: named streets, fixed block lengths, fixed strip widths
 * and landmark lots, so a real place can be recreated.
 *
 * Frame: the drivable spine runs north along +z at x = 0. `side` +1 is +x, which is on the driver's left when heading north
 * (three.js looks down -z, so with +z as forward, +x is to the left); `side` -1 is on the right. Everything is in metres.
 */

export type LandmarkKind = 'foundersSquare' | 'greatSynagogue' | 'cityHall' | 'busStation' | 'stadium' | 'grandMall' | 'mallPlaza';

/** The way a facade faces, as a compass-style letter on the engine's axes: w is -x, e is +x, s is -z, n is +z. */
export type Facing = 'w' | 'e' | 'n' | 's';

/** Which part of a landmark a building is, so the renderer can give it that part's roof, canopy or fins. */
export type BuildingRole =
  | 'synagogue'
  | 'hallTower'
  | 'hallWing'
  | 'hallSide'
  /** The Central Bus Station's terminal hall. */
  | 'busTerminal'
  /** HaMoshava Stadium: a grandstand along a touchline, a lower stand behind a goal. */
  | 'standSide'
  | 'standEnd'
  /** A plain glass office tower (Prima Link, across the road from the mall). */
  | 'officeTower';

/** One building standing inside a landmark lot. */
export interface PlanBuilding {
  role: BuildingRole;
  /** Footprint inside the lot as offsets [dx0, dx1, dz0, dz1] from the lot's own min-x, min-z corner. */
  rect: [number, number, number, number];
  floors: number;
  /** Facade style: 0 panel, 1 brick, 2 stucco, 3 curtain wall. */
  style: number;
  tint: number;
  /** The way its main facade faces. */
  front: Facing;
}

/** A named street. The label is what the HUD announces the first time a player drives into it. */
export interface PlanStreet {
  id: string;
  name: string;
  /** The Hebrew name and a line of history, shown under the title. */
  sub: string;
}

/** One block along the spine, followed by a cross street. */
export interface PlanBlock {
  /** Length along the spine. */
  len: number;
  /** Width of the cross street (the one running across the spine) after the block. */
  cross: number;
  /** Which named street that is, if it has a name. */
  street?: string;
}

/** A column of buildings, then the north-south street or alley that follows it going outward. */
export interface PlanStrip {
  w: number;
  gap: number;
  street?: string;
}

/** Overrides for one lot: where a column (`strip`, 0 nearest the spine) meets a block. */
export interface PlanLot {
  side: -1 | 1;
  strip: number;
  block: number;
  kind?: 'building' | 'open';
  floors?: number;
  /** Facade style: 0 panel, 1 brick, 2 stucco, 3 curtain wall. */
  style?: number;
  tint?: number;
  landmark?: LandmarkKind;
  /** A shopfront with its own drawn sign (see `render/shopFront.ts`), on the boulevard-facing wall of this lot's building. */
  shop?: 'malabes';
  /** Keep scavenge zones, the metro headhouse and other set pieces off this lot even though it is an ordinary building. */
  fixed?: boolean;
  /**
   * A landmark made of buildings that do not fill their lot: the rest of the lot is a forecourt, plaza or car park.
   * Such a lot is `open` and the buildings are listed here.
   */
  buildings?: PlanBuilding[];
}

/** A place worth announcing: it fires once, when a player gets within `r` of the lot's centre. */
export interface PlanPlace {
  id: string;
  name: string;
  sub: string;
  side: -1 | 1;
  strip: number;
  block: number;
  r: number;
}

/** One stop on the light-rail line. */
export interface PlanStation {
  id: string;
  /** Shown on the station's signs and announced when a player arrives; `he` is the Hebrew on the signs. */
  name: string;
  he: string;
  sub: string;
  /** Where the island platform starts and ends, in metres out from the spine's sidewalk edge. */
  from: number;
  to: number;
}

/**
 * The Red Line of the Tel Aviv light rail, which really does end at Petah Tikva Central Bus Station. It runs along one
 * east-west street (the cross street after block `block`), on the `side` the city's far edge is on, as a double track on
 * a concrete slab with an island platform at each station and overhead wire on masts. The westernmost metres of the real
 * line are all there is room for here: it comes in from the edge of the district and stops at a buffer by the spine.
 */
export interface PlanRail {
  block: number;
  side: -1 | 1;
  /** Metres out from the spine's sidewalk edge where the buffer stops stand, and where the slab runs out to. */
  from: number;
  to: number;
  stations: PlanStation[];
  /** Trams standing on the line: which track (-1 is the south one), where the middle of the tram is, and which way it faces (1 away from the spine). */
  trams: { track: -1 | 1; at: number; dir: -1 | 1 }[];
  /** Metres from the cross street's south kerb to the middle of the double track, and the slab width. */
  centre: number;
  width: number;
}

export interface CityPlan {
  id: string;
  /** Where the first block starts. */
  startZ: number;
  streets: PlanStreet[];
  /** The street the spine itself is. */
  spine: string;
  blocks: PlanBlock[];
  sides: Record<'-1' | '1', PlanStrip[]>;
  lots: PlanLot[];
  places: PlanPlace[];
  /** The light-rail line, if the place has one. */
  rail?: PlanRail;
  /** Dress the ordinary buildings as Israeli apartment blocks: balconies, roller shutters, solar water heaters, shop signs. */
  vernacular?: 'israeli';
  /** Chance that a lot with no override is a building rather than open ground. */
  buildingShare: number;
  /** Floor range for an ordinary lot nearest the spine (strip 0) and further out. */
  floors: { near: [number, number]; far: [number, number] };
}

/** Every street and place a plan resolves to once the blocks are laid out. */
export interface PlannedStreet {
  id: string;
  /** Pavement to draw, and the rectangle it covers. */
  kind: 'asphalt' | 'paving' | 'lawn' | 'tarmac' | 'rail' | 'platform' | 'pitch';
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** Named streets are announced on entry. */
  street?: string;
  /** Not drawn: the boulevard's own road mesh covers it. It still announces the street and counts as one. */
  silent?: boolean;
}

export interface PlannedPlace {
  id: string;
  name: string;
  sub: string;
  x: number;
  z: number;
  r: number;
}
