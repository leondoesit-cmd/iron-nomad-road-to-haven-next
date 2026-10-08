import type * as THREE from 'three';
import { PLAYER_CSS } from '../render/palette';
import { WaypointMarker, distLabel } from '../render/navMarkers';
import { POI_DEF, addPoi, poiLabel, removePoi, renamePoi, toggleWaypoint, type NavMarks, type Poi, type PoiKind, type Waypoint } from '../sim/navmarks';
import type { NavLayer } from '../ui/mapdata';
import { buildRoadGraph, findRoute, offRoute, type RoadGraph, type RoadLine, type Route } from './route';
import type { CompassPin } from './scene';
import type { Player } from './player';

/**
 * Waypoints and marks in a running leg: each seat's waypoint with its route along the roads, the shared points of interest,
 * the diamond over a waypoint in the world, and arriving at one. The marks themselves live in the campaign (`sim/navmarks.ts`)
 * so they are saved; this is what a leg does with them.
 */

/** What the map's cursor can do with marks (`ui/mapnav.ts`), whatever scene it is in. */
export interface NavActions {
  /** The leg the marks belong to: marks made here are saved with it. */
  readonly leg: string;
  waypoint(seat: number): Waypoint | null;
  /** Set a seat's waypoint, or clear it if it is set again on the same spot. True if one is set now. */
  toggleWaypoint(seat: number, x: number, z: number): boolean;
  pois(): Poi[];
  addPoi(seat: number, x: number, z: number, kind: PoiKind, name?: string): Poi;
  renamePoi(id: number, name: string): void;
  removePoi(id: number): void;
  togglePin(id: number): void;
}

/** Arriving this close (metres) clears the waypoint. */
export const ARRIVE = 15;
/** Marks within this range show on the compass even when not pinned. */
const NEAR_POI = 300;

export interface NavHost {
  players: Player[];
  campaign: { nav: NavMarks };
  root: THREE.Object3D;
  R: { views: { camera: THREE.Camera }[] };
  audio: { play(id: 'confirm' | 'click' | 'deny', x?: number, z?: number, vol?: number): void };
  groundAt(x: number, z: number): number;
  time: number;
}

interface RouteState {
  route: Route;
  /** Where the owner stood and where the waypoint was when it was found. */
  fx: number;
  fz: number;
  wx: number;
  wz: number;
  at: number;
}

const where = (p: Player) => (p.vehicle ? p.vehicle.position : p.pos);

export class Navigation implements NavActions {
  readonly graph: RoadGraph | null;
  private routes: (RouteState | null)[] = [null, null];
  private markers: (WaypointMarker | null)[] = [null, null];
  private labelT = 0;
  /** Bumped on every change to a mark, so the map's list knows to rebuild. */
  version = 0;

  constructor(
    private host: NavHost,
    readonly leg: string,
    roads: RoadLine[],
  ) {
    this.graph = roads.length ? buildRoadGraph(roads) : null;
  }

  private get marks(): NavMarks {
    return this.host.campaign.nav;
  }

  waypoint(seat: number): Waypoint | null {
    const w = this.marks.waypoints[seat];
    return w && w.leg === this.leg ? w : null;
  }

  toggleWaypoint(seat: number, x: number, z: number): boolean {
    const on = toggleWaypoint(this.marks, seat, this.leg, x, z);
    this.routes[seat] = null;
    this.version++;
    this.host.audio.play(on ? 'confirm' : 'click', undefined, undefined, 0.5);
    return on;
  }

  pois(): Poi[] {
    return this.marks.pois.filter((p) => p.leg === this.leg);
  }

  addPoi(seat: number, x: number, z: number, kind: PoiKind, name?: string): Poi {
    const p = addPoi(this.marks, { leg: this.leg, x, z, kind, name, by: seat });
    this.version++;
    this.host.audio.play('confirm', undefined, undefined, 0.45);
    return p;
  }

  renamePoi(id: number, name: string) {
    if (renamePoi(this.marks, id, name)) this.version++;
  }

  removePoi(id: number) {
    if (removePoi(this.marks, id)) {
      this.version++;
      this.host.audio.play('click', undefined, undefined, 0.5);
    }
  }

  togglePin(id: number) {
    const p = this.marks.pois.find((q) => q.id === id);
    if (!p) return;
    p.pin = !p.pin;
    this.version++;
  }

  /** The route a seat is following, if it has a waypoint here. */
  route(seat: number): Route | null {
    return this.routes[seat]?.route ?? null;
  }

  update(dt: number) {
    this.labelT -= dt;
    const labels = this.labelT <= 0;
    if (labels) this.labelT = 0.25;
    for (let seat = 0; seat < 2; seat++) {
      const w = this.waypoint(seat);
      const owner = this.host.players[seat];
      if (!w || !owner) {
        this.routes[seat] = null;
        this.marker(seat, null);
        continue;
      }
      const at = where(owner);
      // Arriving: the waypoint has done its job.
      if (owner.state !== 'dead' && Math.hypot(at.x - w.x, at.z - w.z) < ARRIVE) {
        this.marks.waypoints[seat] = null;
        this.routes[seat] = null;
        this.version++;
        this.marker(seat, null);
        owner.note('Waypoint reached', 'good');
        this.host.audio.play('confirm', undefined, undefined, 0.35);
        continue;
      }
      this.refreshRoute(seat, at.x, at.z, w);
      const m = this.marker(seat, w);
      if (m && labels) {
        for (let v = 0; v < this.host.players.length; v++) {
          const p = this.host.players[v];
          const q = where(p);
          m.setLabel(v, distLabel(Math.hypot(q.x - w.x, q.z - w.z)));
        }
      }
    }
  }

  /** Find the way again when the waypoint moved, the owner strayed from the line, or a second has passed on the move. */
  private refreshRoute(seat: number, x: number, z: number, w: Waypoint) {
    const r = this.routes[seat];
    const t = this.host.time;
    if (r && r.wx === w.x && r.wz === w.z) {
      const moved = Math.hypot(x - r.fx, z - r.fz);
      if (moved < 8) return;
      if (t - r.at < 1 && offRoute(r.route.pts, x, z) < 25) return;
    }
    this.routes[seat] = { route: findRoute(this.graph, x, z, w.x, w.z), fx: x, fz: z, wx: w.x, wz: w.z, at: t };
  }

  private marker(seat: number, w: Waypoint | null): WaypointMarker | null {
    let m = this.markers[seat];
    if (!w) {
      if (m) {
        m.dispose();
        this.markers[seat] = null;
      }
      return null;
    }
    if (!m) {
      m = this.markers[seat] = new WaypointMarker(PLAYER_CSS[seat], (s) => this.host.R.views[s]?.camera);
      this.host.root.add(m.group);
    }
    m.setPos(w.x, this.host.groundAt(w.x, w.z) + 2.6, w.z);
    return m;
  }

  /** Compass pins: both waypoints (in their owners' colours), and the marks that are near or pinned. */
  compassPins(out: CompassPin[]) {
    for (let seat = 0; seat < 2; seat++) {
      const w = this.waypoint(seat);
      if (w && this.host.players[seat]) out.push({ x: w.x, z: w.z, kind: 'waypoint', label: seat === 0 ? 'WP' : 'WP', color: PLAYER_CSS[seat], dist: true });
    }
    const near = (x: number, z: number) => this.host.players.some((p) => {
      const q = where(p);
      return Math.hypot(q.x - x, q.z - z) < NEAR_POI;
    });
    for (const p of this.marks.pois) {
      if (p.leg !== this.leg || !(p.pin || near(p.x, p.z))) continue;
      out.push({ x: p.x, z: p.z, kind: 'poi', label: poiLabel(p).toUpperCase(), color: POI_DEF[p.kind].color, poi: p.kind, dist: p.pin });
    }
  }

  /** What the maps draw: the waypoints, their routes and every mark made on this leg. */
  fill(layer: NavLayer) {
    layer.waypoints.length = 0;
    layer.routes.length = 0;
    layer.pois.length = 0;
    for (let seat = 0; seat < 2; seat++) {
      const w = this.waypoint(seat);
      if (!w || !this.host.players[seat]) continue;
      layer.waypoints.push({ seat, x: w.x, z: w.z, color: PLAYER_CSS[seat] });
      const r = this.routes[seat];
      if (r) {
        // The line starts where the owner is now, not where they stood when it was found.
        const at = where(this.host.players[seat]);
        const pts = r.route.pts.slice();
        pts[0] = at.x;
        pts[1] = at.z;
        layer.routes.push({ seat, pts, color: PLAYER_CSS[seat], length: r.route.length, direct: r.route.direct });
      }
    }
    for (const p of this.marks.pois) {
      if (p.leg !== this.leg) continue;
      layer.pois.push({ id: p.id, x: p.x, z: p.z, kind: p.kind, label: poiLabel(p), pin: p.pin, color: POI_DEF[p.kind].color });
    }
    layer.version = this.version;
  }

  dispose() {
    for (let s = 0; s < 2; s++) this.marker(s, null);
  }
}
