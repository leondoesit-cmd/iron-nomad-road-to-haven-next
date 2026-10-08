import * as THREE from 'three';
import { FACE_TRIP, faceStrength } from '../render/faceGums';
import { FaceGhosts, GHOSTS_MAX } from '../render/faceGhosts';
import type { Bend, OldGum } from '../world/millBend';
import type { TreeSpot } from '../world/flora';
import type { Ctx } from './ctx';
import type { Player } from './player';

/**
 * The faces on a trip, in play: what each player's view of the old gums' faces is (`render/faceGums.ts`, through the
 * shared `FACE_TRIP` uniforms, set per view before it is drawn), the faces that are not there on ordinary trunks near
 * whoever is at the peak (`render/faceGhosts.ts`, their own view only), the drone and the whispering near them, and the word
 * on the radio the first time someone walks in under the old gums.
 *
 * Nothing here touches the other player's view: a sober partner standing at the same tree sees bark.
 */

/** Strength at which ordinary trees start to look back. */
export const GHOST_FROM = 0.6;
/** How close (m) to an old gum the radio first says something about the caps round their feet. */
const HINT_R = 9;

export interface FaceView {
  /** How far the faces come out in this player's view (0 sober), the trip's clock, and their head (the eyes follow it). */
  k: number;
  ph: number;
  look: THREE.Vector3;
}

export class FaceTrip {
  readonly views: [FaceView, FaceView] = [
    { k: 0, ph: 0, look: new THREE.Vector3() },
    { k: 0, ph: 0, look: new THREE.Vector3() },
  ];
  readonly ghosts = new FaceGhosts();
  private gums: OldGum[];
  private before: (i: number) => void;
  private after: () => void;
  private spawnT = [1.5, 1.5];
  private whisperT = [4, 4];
  private drone: FaceDrone | null = null;
  private dice = 0x2545f491;

  constructor(
    private host: Ctx,
    bends: readonly Bend[],
  ) {
    this.gums = bends.flatMap((b) => b.gums);
    host.root.add(this.ghosts.group);
    // Per view: this player's faces, this player's ghosts, nobody else's.
    this.before = (i) => {
      const v = this.views[i];
      FACE_TRIP.k.value = v.k;
      FACE_TRIP.ph.value = v.ph;
      FACE_TRIP.look.value.copy(v.look);
      this.ghosts.showFor(i);
    };
    this.after = () => {
      FACE_TRIP.k.value = 0;
      this.ghosts.showFor(-1);
    };
    host.R.onBeforeView.push(this.before);
    host.R.onAfterView.push(this.after);
  }

  private rand(): number {
    this.dice = (Math.imul(this.dice, 1664525) + 1013904223) >>> 0;
    return this.dice / 4294967296;
  }

  /** The nearest old gum's face to a point, and how far (m, from the bark). */
  nearestFace(x: number, z: number): { g: OldGum; d: number; fx: number; fy: number; fz: number } | null {
    let best: { g: OldGum; d: number; fx: number; fy: number; fz: number } | null = null;
    for (const g of this.gums) {
      const d = Math.hypot(g.x - x, g.z - z) - g.r;
      if (best && d >= best.d) continue;
      const f = g.faces[0];
      if (!f) continue;
      best = { g, d, fx: g.x + Math.cos(f.az) * g.r * 1.05, fy: g.y + f.h, fz: g.z + Math.sin(f.az) * g.r * 1.05 };
    }
    return best;
  }

  update(dt: number) {
    const host = this.host;
    FACE_TRIP.night.value = host.night;
    let drone = 0;
    host.players.forEach((p, i) => {
      if (i > 1) return;
      const v = this.views[i];
      const k = p.alive ? faceStrength(p.drugs.look()) : 0;
      v.k = k;
      v.ph = host.R.trip[i]?.phase ?? 0;
      const at = p.vehicle && p.state !== 'foot' ? p.vehicle.position : p.pos;
      v.look.set(at.x, at.y + (p.state === 'foot' ? 1.62 : 1.3), at.z);
      const near = this.nearestFace(at.x, at.z);
      this.hint(p, near?.d ?? Infinity, near?.g.island ?? true);
      // The drone swells near a face as the trip peaks; the faces whisper.
      if (k > 0.3 && near) {
        const close = 1 - Math.min(1, Math.max(0, (near.d - 4) / 26));
        drone = Math.max(drone, close * Math.min(1, (k - 0.3) / 0.5));
        this.whisperT[i] -= dt;
        if (this.whisperT[i] <= 0 && k > 0.55 && near.d < 14) {
          this.whisperT[i] = 5 + this.rand() * 7;
          host.audio.play('whisper', near.fx, near.fz, 0.3 + 0.25 * k);
        }
      }
      this.updateGhosts(p, i, dt, k);
      if (k > GHOST_FROM && this.ghosts.count(i) > 0) drone = Math.max(drone, 0.35 * Math.min(1, (k - GHOST_FROM) / 0.3));
    });
    if (drone > 0.001 && !this.drone && host.audio.ctx && host.audio.sfx) this.drone = new FaceDrone(host.audio.ctx, host.audio.sfx);
    this.drone?.set(drone, dt);
    // Nobody near a face for a while: stop the oscillators altogether.
    if (this.drone && this.drone.quietFor > 10) {
      this.drone.dispose();
      this.drone = null;
    }
  }

  /** The first time anyone on foot walks in under the old gums, a word on the radio about what grows round their feet. */
  private hint(p: Player, d: number, island: boolean) {
    const c = this.host.campaign;
    if (c.flags['tip.faceGums'] || p.state !== 'foot' || island || d > HINT_R) return;
    c.flags['tip.faceGums'] = true;
    this.host.radio(
      "Little brown caps in the grass under the old gums, pointed like a nipple on top. Somebody told me once those show you things. Pick a few: the belt keeps them by their look. And these trunks... I'd swear they're looking back.",
    );
  }

  /** At the peak, faces come up on the trunks of the trees round the tripper, where they are looking; they go when it ebbs. */
  private updateGhosts(p: Player, i: number, dt: number, k: number) {
    const at = p.vehicle && p.state !== 'foot' ? p.vehicle.position : p.pos;
    const cam = p.cam;
    const fx = cam.look.x - cam.pos.x;
    const fz = cam.look.z - cam.pos.z;
    const fl = Math.hypot(fx, fz) || 1;
    const inView = (x: number, z: number) => {
      const dx = x - at.x;
      const dz = z - at.z;
      const d = Math.hypot(dx, dz);
      return d < 30 && (dx * fx + dz * fz) / (fl * (d || 1)) > -0.2;
    };
    this.ghosts.update(i, dt, k, this.host.night, inView);
    if (k < GHOST_FROM || !p.alive || !this.host.treesNear) {
      this.spawnT[i] = Math.min(this.spawnT[i], 2);
      return;
    }
    this.spawnT[i] -= dt;
    if (this.spawnT[i] > 0 || this.ghosts.count(i) >= GHOSTS_MAX) return;
    this.spawnT[i] = 1.8 + this.rand() * 3.2;
    // A trunk 5 to 22 m off, in front of them, that is not an old gum's own stem.
    const trees = this.host.treesNear(at.x, at.z, 22);
    let pick: TreeSpot | null = null;
    let score = -Infinity;
    for (const t of trees) {
      if (!FaceGhosts.takes(t) || this.ghosts.haunted(i, t)) continue;
      const dx = t.x - at.x;
      const dz = t.z - at.z;
      const d = Math.hypot(dx, dz);
      if (d < 5) continue;
      const ahead = (dx * fx + dz * fz) / (fl * d);
      if (ahead < 0.45) continue;
      if (this.gums.some((g) => Math.hypot(g.x - t.x, g.z - t.z) < g.r + 1.5)) continue;
      const sc = ahead * 2 - Math.abs(d - 11) / 8 + this.rand() * 0.8;
      if (sc > score) {
        score = sc;
        pick = t;
      }
    }
    if (pick && this.ghosts.spawn(i, pick, at.x, at.z, this.rand())) this.host.audio.play('whisper', pick.x, pick.z, 0.22);
  }

  dispose() {
    const R = this.host.R;
    const a = R.onBeforeView.indexOf(this.before);
    if (a >= 0) R.onBeforeView.splice(a, 1);
    const b = R.onAfterView.indexOf(this.after);
    if (b >= 0) R.onAfterView.splice(b, 1);
    FACE_TRIP.k.value = 0;
    this.ghosts.dispose();
    this.drone?.dispose();
    this.drone = null;
  }
}

/**
 * A low drone under a trip near the faces: two detuned saws a fifth apart and a sine an octave down, through a slow-swept
 * low-pass. Built the first time it is needed, silent (and stopped) when nobody is near a face.
 */
class FaceDrone {
  private gain: GainNode;
  private filter: BiquadFilterNode;
  private oscs: OscillatorNode[] = [];
  private lfo: OscillatorNode;
  private level = 0;
  /** Seconds it has been silent. */
  quietFor = 0;

  constructor(
    private ctx: AudioContext,
    out: AudioNode,
  ) {
    const now = ctx.currentTime;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 260;
    this.filter.Q.value = 3;
    this.filter.connect(this.gain).connect(out);
    for (const [type, f, det, g] of [
      ['sawtooth', 55, -6, 0.32],
      ['sawtooth', 82.4, 5, 0.22],
      ['sine', 27.5, 0, 0.6],
    ] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.detune.value = det;
      const og = ctx.createGain();
      og.gain.value = g;
      o.connect(og).connect(this.filter);
      o.start(now);
      this.oscs.push(o);
    }
    this.lfo = ctx.createOscillator();
    this.lfo.frequency.value = 0.07;
    const lg = ctx.createGain();
    lg.gain.value = 140;
    this.lfo.connect(lg).connect(this.filter.frequency);
    this.lfo.start(now);
  }

  set(level: number, dt: number) {
    if (Math.abs(level - this.level) > 0.01) {
      this.level = level;
      this.gain.gain.setTargetAtTime(level * 0.09, this.ctx.currentTime, 0.8);
    }
    this.quietFor = level < 0.01 ? this.quietFor + dt : 0;
  }

  dispose() {
    const now = this.ctx.currentTime;
    this.gain.gain.setTargetAtTime(0, now, 0.2);
    for (const o of [...this.oscs, this.lfo]) o.stop(now + 1);
    setTimeout(() => this.gain.disconnect(), 1200);
  }
}
