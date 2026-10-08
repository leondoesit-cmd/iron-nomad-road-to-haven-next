import { angleDiff } from '../core/math';
import type { DriveInput } from '../physics/vehicle';
import { restHeight } from '../render/carSpecs';
import { distLabel } from '../render/navMarkers';
import { newSteerState, steerTo } from './aiDrive';
import type { ObstacleIndex } from './obstacles';
import type { Player } from './player';
import { alongRoute, findRoute, nearestRoads, type RoadGraph, type Route } from './route';
import type { CompassPin } from './scene';
import type { Pilot, Vehicle } from './vehicle';

/**
 * Calling your ride. The car you last drove (your own, or a convoy car you took) starts itself and drives to you along the
 * roads, honking when it pulls up a few metres off. When it cannot (too far, stuck for a while, you are indoors or down a
 * hole), it is instead found waiting somewhere you are not looking: a clear, dry, level spot 25 to 40 m behind you, on a
 * road if there is one. Press again to call it off. Never a boat, never into water, never popped into anyone's view.
 */

export const SUMMON = {
  /** Further than this and it does not drive: it is found waiting nearby instead. */
  driveRange: 350,
  /** It stops this far from you (car centre to you). */
  stop: 7,
  /** No progress for this long and it gives up driving and turns up waiting instead. */
  stuckSecs: 6,
  /** Seconds before the next call can start. */
  cooldown: 20,
  /** Where a car that cannot drive to you turns up: this far away, behind you. */
  near: 25,
  far: 40,
  /** Road speed and off-road speed, m/s. */
  roadSpeed: 13,
  offSpeed: 8,
  /** Give up driving after this long whatever happens. */
  timeout: 90,
} as const;

export interface SummonHost {
  players: Player[];
  vehicles: Vehicle[];
  obs: ObstacleIndex;
  time: number;
  readonly graph: RoadGraph | null;
  groundAt(x: number, z: number): number;
  waterAt(x: number, z: number): { depth: number } | null;
  colliderReady?(x: number, z: number): boolean;
  visibleToAnyView(x: number, y: number, z: number, margin?: number): boolean;
  interiorAt?(x: number, z: number, y: number): boolean;
  /** No building, tree or prop within `r` of a point. */
  clearAt(x: number, z: number, r: number): boolean;
  audio: { play(id: 'horn' | 'deny' | 'confirm', x?: number, z?: number, vol?: number): void };
}

/** Drives a called car to its owner: along the route the map would draw, slowing as it nears, stopping short. */
class SummonPilot implements Pilot {
  readonly isPlayer = false;
  readonly index = -3;
  private st = newSteerState();
  private route: Route | null = null;
  private routeAt = -99;
  private seg = 0;
  private rx = 0;
  private rz = 0;
  /** Where it is going: its owner, wherever they are now. */
  tx = 0;
  tz = 0;
  /** Set once it has pulled up and stopped. */
  stopped = false;

  constructor(
    private host: SummonHost,
    readonly seat: number,
  ) {}

  drive(v: Vehicle, dt: number): DriveInput {
    const p = v.position;
    const t = this.host.time;
    if (!this.route || t - this.routeAt > 2.5 || Math.hypot(this.tx - this.rx, this.tz - this.rz) > 12) {
      this.route = findRoute(this.host.graph, p.x, p.z, this.tx, this.tz, 160);
      this.routeAt = t;
      this.seg = 0;
      this.rx = this.tx;
      this.rz = this.tz;
    }
    const straight = Math.hypot(this.tx - p.x, this.tz - p.z);
    const look = 7 + Math.abs(v.speed) * 0.7;
    const a = alongRoute(this.route.pts, p.x, p.z, look, this.seg);
    this.seg = a.seg;
    const n = this.route.pts.length / 2;
    // On the road part of the route (not the off-road ends): full road pace.
    const onRoad = !this.route.direct && a.seg > 0 && a.seg < n - 2;
    let want: number = onRoad ? SUMMON.roadSpeed : SUMMON.offSpeed;
    const left = Math.min(a.left, straight * 1.6);
    if (left < 70) want = Math.min(want, 2.6 + left * 0.16);
    // Ease off for a sharp bend ahead.
    const bend = Math.abs(angleDiff(v.yaw, Math.atan2(a.x - p.x, a.z - p.z)));
    if (bend > 0.6) want = Math.min(want, 6);
    if (straight < SUMMON.stop) want = 0;
    const out = steerTo(v, a.x, a.z, want, this.st, this.host.obs, dt);
    if (want === 0) {
      out.throttle = 0;
      out.brake = Math.abs(v.speed) > 0.3 ? 1 : 0;
      out.handbrake = Math.abs(v.speed) < 2;
      if (Math.abs(v.speed) < 0.6) this.stopped = true;
    } else this.stopped = false;
    return out;
  }
}

interface Job {
  v: Vehicle;
  pilot: SummonPilot;
  start: number;
  best: number;
  bestAt: number;
}

export class Summoner {
  private jobs: (Job | null)[] = [null, null];
  private lastStart = [-1e9, -1e9];
  /** The convoy car each seat drove last, for someone whose own ride is gone. */
  private lastDriven: (Vehicle | null)[] = [null, null];

  constructor(private host: SummonHost) {}

  /** The call button: call your ride, or call it off if it is already coming. */
  request(p: Player) {
    const seat = p.index;
    if (this.jobs[seat]) {
      this.release(seat);
      p.note('Ride called off', 'info');
      return;
    }
    const v = this.pick(p);
    const why = this.refuse(p, v);
    if (why) {
      p.note(why, 'warn');
      this.host.audio.play('deny', undefined, undefined, 0.5);
      return;
    }
    const wait = SUMMON.cooldown - (this.host.time - this.lastStart[seat]);
    if (wait > 0) {
      p.note(`Your ride needs a moment: ${Math.ceil(wait)} s`, 'info');
      return;
    }
    const car = v!;
    const me = p.pos;
    const d = Math.hypot(car.position.x - me.x, car.position.z - me.z);
    if (d < SUMMON.stop + 5) {
      p.note('Your ride is right here', 'info');
      return;
    }
    this.lastStart[seat] = this.host.time;
    const indoors = !!this.host.interiorAt?.(me.x, me.z, me.y + 1);
    const drowned = this.wet(car.position.x, car.position.z, 0.5);
    if (d > SUMMON.driveRange || indoors || drowned) {
      this.appear(p, car, d > SUMMON.driveRange ? 'Your ride was too far to drive' : indoors ? '' : 'Your ride could not get out of the water');
      return;
    }
    if (!car.engineOn) car.setEngine(true);
    if (!car.engineOn && !car.pedal) {
      p.note(car.startFail || 'Your ride will not start', 'warn');
      return;
    }
    const pilot = new SummonPilot(this.host, seat);
    pilot.tx = me.x;
    pilot.tz = me.z;
    car.driver = pilot;
    this.jobs[seat] = { v: car, pilot, start: this.host.time, best: d, bestAt: this.host.time };
    p.note(`Ride on its way · ${distLabel(d)}`, 'good');
  }

  /** Is a ride on its way to this seat? */
  coming(seat: number): Vehicle | null {
    return this.jobs[seat]?.v ?? null;
  }

  /** The car this player would call: their own, else the convoy car they drove last. */
  pick(p: Player): Vehicle | null {
    const own = p.ownVehicle;
    const ok = (v: Vehicle | null): v is Vehicle => !!v && !v.wreck && this.host.vehicles.includes(v);
    if (ok(own)) return own;
    const last = this.lastDriven[p.index];
    if (ok(last) && last.faction === 'convoy') return last;
    return own ?? null;
  }

  /** Why this car cannot be called, or '' if it can. */
  private refuse(p: Player, v: Vehicle | null): string {
    if (p.state === 'dead' || p.state === 'downed') return 'Not now';
    if (!v) return 'You have no ride to call';
    if (p.vehicle) return p.vehicle === v ? 'You are already in your ride' : 'Get out first: your ride comes to you on foot';
    if (v.wreck) return 'Your ride is wrecked';
    if (v.def.physics.kind === 'boat') return 'A boat cannot come to you';
    if (v.driver) return 'Someone else is driving your ride';
    if (!v.pedal && v.fuel <= 0.001) return 'Your ride is out of fuel';
    if (!v.engineOn) {
      const why = v.cantStart();
      if (why) return `Your ride will not start: ${why.charAt(0).toLowerCase()}${why.slice(1)}`;
    }
    return '';
  }

  private wet(x: number, z: number, depth: number) {
    const w = this.host.waterAt(x, z);
    return !!w && w.depth > depth;
  }

  /** Stop driving a called car: it stays where it is, its engine idling. */
  private release(seat: number) {
    const j = this.jobs[seat];
    if (!j) return;
    if (j.v.driver === j.pilot) j.v.driver = null;
    this.jobs[seat] = null;
  }

  update(dt: number) {
    void dt;
    const t = this.host.time;
    for (const p of this.host.players) {
      const v = p.vehicle;
      if (p.state === 'driving' && v && v.faction === 'convoy' && v.kind === 'player') this.lastDriven[p.index] = v;
    }
    for (let seat = 0; seat < 2; seat++) {
      const j = this.jobs[seat];
      if (!j) continue;
      const p = this.host.players[seat];
      const v = j.v;
      // Taken over, lost, or nobody left to drive to.
      if (!p || p.state === 'dead' || v.wreck || v.driver !== j.pilot || !this.host.vehicles.includes(v)) {
        this.release(seat);
        continue;
      }
      if (p.vehicle) {
        this.release(seat);
        continue;
      }
      j.pilot.tx = p.pos.x;
      j.pilot.tz = p.pos.z;
      const d = Math.hypot(v.position.x - p.pos.x, v.position.z - p.pos.z);
      if (j.pilot.stopped && d < SUMMON.stop + 4) {
        this.release(seat);
        this.honk(v);
        p.note('Your ride is here', 'good');
        continue;
      }
      if (d < j.best - 2) {
        j.best = d;
        j.bestAt = t;
      }
      const stuck = t - j.bestAt > SUMMON.stuckSecs;
      const drowning = this.wet(v.position.x, v.position.z, 0.55);
      if (stuck || drowning || t - j.start > SUMMON.timeout || d > SUMMON.driveRange * 1.6) {
        this.release(seat);
        this.appear(p, v, drowning ? 'Your ride hit deep water' : 'Your ride got stuck');
      }
    }
  }

  /**
   * The car turns up waiting near the player instead of driving: behind them, out of every view. Returns whether a spot
   * was found. `why` is said first, if anything.
   */
  appear(p: Player, v: Vehicle, why: string): boolean {
    const cam = p.cam;
    const lx = cam.look.x - cam.pos.x;
    const lz = cam.look.z - cam.pos.z;
    const view = Math.hypot(lx, lz) > 1e-3 ? Math.atan2(lx, lz) : p.yaw;
    const spot = this.findSpot(v, p.pos.x, p.pos.z, view + Math.PI, true);
    if (!spot) {
      p.note(`${why ? `${why}: ` : ''}no clear spot for it nearby`, 'warn');
      return false;
    }
    this.place(v, spot.x, spot.z, spot.yaw);
    this.honk(v);
    const d = Math.hypot(spot.x - p.pos.x, spot.z - p.pos.z);
    p.note(`${why ? `${why}. ` : ''}It is waiting behind you · ${distLabel(d)}`, 'good');
    return true;
  }

  /** For a delve: leave the car waiting by the way back up, wherever it is now. */
  waitAt(seat: number, x: number, z: number, yaw: number): string {
    const p = this.host.players[seat];
    const v = p ? this.pick(p) : null;
    if (!p || !v) return 'You have no ride to call';
    if (v.wreck) return 'Your ride is wrecked';
    if (v.def.physics.kind === 'boat') return 'A boat cannot come to you';
    if (v.driver) return 'Someone else is driving your ride';
    if (Math.hypot(v.position.x - x, v.position.z - z) < SUMMON.far + 10) return 'Your ride is already by the way out';
    const wait = SUMMON.cooldown - (this.host.time - this.lastStart[seat]);
    if (wait > 0) return `Your ride needs a moment: ${Math.ceil(wait)} s`;
    const spot = this.findSpot(v, x, z, yaw, false, 12);
    if (!spot) return 'No clear spot by the way out for your ride';
    this.lastStart[seat] = this.host.time;
    this.place(v, spot.x, spot.z, spot.yaw);
    return '';
  }

  private place(v: Vehicle, x: number, z: number, yaw: number) {
    v.body.setPose(x, this.host.groundAt(x, z) + restHeight(v.def) + 0.06, z, yaw);
    v.snapshotPrev();
    v.moored = null;
  }

  private honk(v: Vehicle) {
    v.hornT = 0.6;
    this.host.audio.play('horn', v.position.x, v.position.z, 0.8);
  }

  /**
   * A clear, dry, level spot for a car on loaded ground, `near`..`far` metres from (x, z), as close as it can be to the
   * direction `toward`, on a road if one passes. With `hidden`, nowhere any player's camera can see.
   */
  findSpot(v: Vehicle, x: number, z: number, toward: number, hidden: boolean, near: number = SUMMON.near): { x: number; z: number; yaw: number } | null {
    const H = this.host;
    const half = Math.max(1.6, v.def.length * 0.5);
    let best: { x: number; z: number; yaw: number; score: number } | null = null;
    const offsets = [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.4, -1.4, 1.8, -1.8, 2.3, -2.3, Math.PI];
    const radii = [near, near + 5, near + 10, SUMMON.far, SUMMON.far + 10, SUMMON.far + 22];
    for (const r of radii) {
      for (const off of offsets) {
        const a = toward + off;
        let cx = x + Math.sin(a) * r;
        let cz = z + Math.cos(a) * r;
        let yaw = Math.atan2(x - cx, z - cz);
        let road = 0;
        // Onto a road close by: a car waits on the tarmac where it can.
        const g = H.graph;
        if (g) {
          const hit = nearestRoads(g, cx, cz, 9, 1)[0];
          if (hit && Math.abs(Math.hypot(hit.x - x, hit.z - z) - r) < 8) {
            cx = hit.x;
            cz = hit.z;
            const ax = g.x[g.segA[hit.seg]];
            const az = g.z[g.segA[hit.seg]];
            const bx = g.x[g.segB[hit.seg]];
            const bz = g.z[g.segB[hit.seg]];
            const along = Math.atan2(bx - ax, bz - az);
            // Along the road, nose toward the player.
            yaw = Math.abs(angleDiff(along, Math.atan2(x - cx, z - cz))) < Math.PI / 2 ? along : along + Math.PI;
            road = 1;
          }
        }
        if (!this.spotOk(v, cx, cz, yaw, half, hidden)) continue;
        const score = Math.abs(off) * 6 + Math.abs(r - (near + SUMMON.far) / 2) * 0.4 - road * 10 + (r > SUMMON.far ? 30 : 0);
        if (!best || score < best.score) best = { x: cx, z: cz, yaw, score };
      }
      // A good spot in the nearest ring is good enough.
      if (best && r >= SUMMON.far && best.score < 25) break;
    }
    return best ? { x: best.x, z: best.z, yaw: best.yaw } : null;
  }

  private spotOk(v: Vehicle, x: number, z: number, yaw: number, half: number, hidden: boolean): boolean {
    const H = this.host;
    const fx = Math.sin(yaw) * half;
    const fz = Math.cos(yaw) * half;
    const sx = Math.cos(yaw) * 1.1;
    const sz = -Math.sin(yaw) * 1.1;
    const pts = [
      [x, z],
      [x + fx + sx, z + fz + sz],
      [x + fx - sx, z + fz - sz],
      [x - fx + sx, z - fz + sz],
      [x - fx - sx, z - fz - sz],
    ];
    const g0 = H.groundAt(x, z);
    for (const [px, pz] of pts) {
      if (H.colliderReady && !H.colliderReady(px, pz)) return false;
      const w = H.waterAt(px, pz);
      if (w && w.depth > 0.08) return false;
      if (Math.abs(H.groundAt(px, pz) - g0) > 1.1) return false;
      if (H.obs.pointInside(px, pz, 1)) return false;
    }
    if (!H.clearAt(x, z, half + 0.8)) return false;
    if (H.interiorAt?.(x, z, g0 + 1)) return false;
    for (const o of H.vehicles) if (o !== v && Math.hypot(o.position.x - x, o.position.z - z) < half + 4) return false;
    for (const p of H.players) if (Math.hypot(p.pos.x - x, p.pos.z - z) < half + 2.5) return false;
    if (hidden && H.visibleToAnyView(x, g0 + 1.2, z, half + 1.5)) return false;
    return true;
  }

  /** A pin for each called car on its way, so it can be watched coming. */
  pins(out: CompassPin[]) {
    for (let seat = 0; seat < 2; seat++) {
      const j = this.jobs[seat];
      if (j) out.push({ x: j.v.position.x, z: j.v.position.z, kind: 'ride', label: 'RIDE', dist: true });
    }
  }

  dispose() {
    for (let s = 0; s < 2; s++) this.release(s);
  }
}
