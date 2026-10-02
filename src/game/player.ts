import * as THREE from 'three';
import { RAPIER, GROUPS, G, groups, type Collider, type RigidBody } from '../physics/physics';
import { Btn, heldFor, isHeld, wasPressed, type PlayerIntent } from '../input/intents';
import { promptLabel } from '../input/input';
import { ChaseCamera, type CamMode } from '../render/camera';
import { Humanoid } from '../render/humanoid';
import { makeCarryModel } from '../render/props';
import { PLAYER_COLORS } from '../render/palette';
import { clamp, damp, dampAngle, lerp } from '../core/math';
import { ENEMIES, partDef, t } from '../data';
import { roadX } from '../world/terrain';
import { steerTo, newSteerState } from './aiDrive';
import { applyRepair, planRepair } from '../sim/repair';
import { SALVAGE_STAGES } from '../sim/salvage';
import { costText, spend } from '../sim/resources';
import type { DriveInput } from '../physics/vehicle';
import type { Ctx } from './ctx';
import type { Pilot, Vehicle } from './vehicle';
import type { Interactable } from './interact';
import { carrySlow, type Carried } from '../sim/carry';
import { OIL_LOW, pourOil } from '../sim/oil';
import { dropCarry, haulCandidate, haulKey, haulPrompt, returnCarry, stashBeforeEntering } from './hauling';

export interface Cand {
  kind: string;
  prompt: string;
  dur: number;
  target: unknown;
  ok: boolean;
  run: () => void;
  label: string;
  tick?: () => boolean;
  /** Signature the finished action emits. */
  noise?: number;
}

/** Eye height above the feet on foot: standing, crouched, and treading water. */
const EYE_STAND = 1.62;
const EYE_CROUCH = 1.18;
const EYE_SWIM = 1.0;

/** Solo: how long a downed player holds A to patch themselves up. */
const SELF_REVIVE_SECONDS = 3.4;

export type PState = 'foot' | 'entering' | 'driving' | 'gunner' | 'downed' | 'dead';
export type Equip = 'pistol' | 'wrench' | 'crowbar' | 'jerrycan' | 'utility';
export type Utility = 'flare' | 'charge' | 'molotov' | 'horn';
export const UTILITIES: Utility[] = ['flare', 'molotov', 'charge', 'horn'];

export interface Note {
  text: string;
  kind: 'info' | 'good' | 'warn' | 'bad';
  t: number;
}

export interface Prompt {
  text: string;
  /** 0..1 hold progress, or -1 for tap prompts. */
  progress: number;
  button: 'A' | 'Y' | 'X' | 'RT' | 'RB';
}

/** A second line under the prompt for the other thing a button can do. */
export interface PromptAlt {
  text: string;
  button: 'X';
  ok: boolean;
}

const WALK = 3.4;
const SPRINT = 5.9;
const CROUCH = 1.7;
const BODY_H = 1.7;
const BODY_R = 0.3;
const RAY_STATIC = groups(0xffff, G.STATIC | G.VEHICLE | G.BUILD | G.FURN);
const _v = new THREE.Vector3();
const _camE = new THREE.Euler();

export class Player implements Pilot {
  readonly isPlayer = true;
  state: PState = 'foot';
  pos = new THREE.Vector3();
  prevPos = new THREE.Vector3();
  vy = 0;
  yaw = 0;
  aimYaw = 0;
  aimPitch = 0;
  ads = 0;
  crouch = false;
  grounded = true;
  moveSpeed = 0;
  hp = 100;
  maxHp = 100;
  vehicle: Vehicle | null = null;
  ownVehicle: Vehicle | null = null;
  human: Humanoid;
  cam = new ChaseCamera();
  equip: Equip = 'pistol';
  utility: Utility;
  mag = 12;
  reloadT = 0;
  fireCd = 0;
  meleeCd = 0;
  notes: Note[] = [];
  prompt: Prompt | null = null;
  /** What X does while the hands are full: stow at the car, or set down. */
  promptAlt: PromptAlt | null = null;
  /** What is in your hands: a part, a fuel can or an oil can. */
  carry: Carried | null = null;
  commandWheel = false;
  private lookIn: [number, number] = [0, 0];
  sheet = false;
  /** The map view: 0 is the minimap alone, 1 a larger local map, 2 the whole leg. Each tap of the map button steps on. */
  mapMode = 0;
  // state timers
  downT = 0;
  reviveProgress = 0;
  /** Solo: seconds of holding A to use a medkit on yourself while downed. */
  private selfReviveT = 0;
  respawnT = 0;
  pinned = 0;
  pinBreak = 0;
  enterT = 0;
  private enterFrom = new THREE.Vector3();
  private enterTo: Vehicle | null = null;
  private enterSeat: 'driver' | 'gunner' = 'driver';
  bailHold = 0;
  private startNoteAt = -99;
  lookBack = false;
  camFar = false;
  /** First-person view wanted on this seat. See `firstPerson` for whether it applies right now. */
  viewFirst = false;
  /** Smoothed eye height above the feet, so crouching and swimming ease the first-person camera. */
  private eyeH = EYE_STAND;
  /** Free look while driving in first person: yaw and pitch offsets from the heading. */
  private driveLook: [number, number] = [0, 0];
  /** What the first-person camera hid for the owner's view, to put back after it draws. */
  private hiddenOcc: Humanoid | null = null;
  private hiddenOccWas = true;
  shoulder = 0.6;
  /** Seconds since last hit, for regen delay and Mechanic checks. */
  sinceHit = 99;
  /** Hold-action in progress. */
  action: { kind: string; t: number; dur: number; target?: unknown; label: string } | null = null;
  takedownT = 0;
  body: RigidBody;
  collider: Collider;
  kcc: RAPIER.KinematicCharacterController;
  /** Convoy tether state for the HUD. */
  tetherWarn = 0;
  signatureShown = 0;
  invuln = 0;
  muzzleT = 0;
  throwHeld = 0;
  fatigue = 0;
  /** Where the aim ray currently lands (for the reticle and the gun). */
  aimPoint = new THREE.Vector3();
  aimDist = 60;
  lastKnownVehicleSpeed = 0;
  private hitCooldown = 0;
  private lastHurtDir = 0;
  watchSector = -1;
  /** Water: metres over the feet, the surface height, whether afloat, and the splash timer. */
  waterDepth = 0;
  waterLevel = 0;
  swimming = false;
  private splashT = 0;
  /** Camp build phase: input drives the placement reticle instead of weapons. */
  buildMode = false;
  private colliderOn = true;
  /** Debug and tooling: follow the road automatically. */
  autopilot: { speed: number; lane?: number } | null = null;
  private apState = newSteerState();

  constructor(
    public ctx: Ctx,
    public index: 0 | 1,
    public name: string,
  ) {
    this.utility = ctx.campaign.players[index].utility;
    this.viewFirst = !!ctx.input.settings.firstPerson?.[index];
    const col = PLAYER_COLORS[index];
    this.human = new Humanoid({ jacket: col, trim: 0x4a4636, helmet: index === 0 ? 0x3b2a1a : 0x1c2a3a, scarf: index === 0 ? 0x6a3a1c : 0x223448 });
    ctx.root.add(this.human.root);
    this.body = ctx.P.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 1, 0));
    this.collider = ctx.P.world.createCollider(
      RAPIER.ColliderDesc.capsule((BODY_H - BODY_R * 2) / 2, BODY_R).setCollisionGroups(GROUPS.player).setTranslation(0, 0, 0),
      this.body,
    );
    this.kcc = ctx.P.world.createCharacterController(0.03);
    this.kcc.enableAutostep(0.45, 0.2, false);
    this.kcc.setMaxSlopeClimbAngle((55 * Math.PI) / 180);
    this.kcc.setMinSlopeSlideAngle((60 * Math.PI) / 180);
    this.kcc.enableSnapToGround(0.35);
    this.kcc.setApplyImpulsesToDynamicBodies(false);
    this.cam.occlude = (from, dir, maxDist) => {
      const r = ctx.P.raycast(from.x, from.y, from.z, dir.x, dir.y, dir.z, maxDist, groups(0xffff, G.STATIC | G.BUILD));
      return r ? r.toi : Infinity;
    };
    this.cam.groundAt = (x, z) => ctx.groundAt(x, z);
  }

  get targetable() {
    return (this.state === 'foot' || this.state === 'entering' || this.state === 'downed') && this.invuln <= 0;
  }
  get intent(): PlayerIntent {
    return this.ctx.input.intents[this.index];
  }
  /** Whether this seat's camera is in first person right now: wanted, and in a state that has eyes to look through. */
  get firstPerson(): boolean {
    // The title-screen demo (autopilot) always runs on the chase camera, whatever the seat last chose.
    return this.viewFirst && !this.autopilot && !this.buildMode && (this.state === 'foot' || this.state === 'driving' || this.state === 'gunner');
  }
  get partner(): Player | undefined {
    return this.ctx.players[1 - this.index];
  }
  get alive() {
    return this.state !== 'dead';
  }
  get inVehicle() {
    return this.state === 'driving' || this.state === 'gunner';
  }

  /** Place the player on foot at a point (feet position). */
  placeAt(x: number, z: number, yaw = 0) {
    const y = this.ctx.groundAt(x, z);
    this.pos.set(x, y + 0.05, z);
    this.prevPos.copy(this.pos);
    this.yaw = yaw;
    this.aimYaw = yaw;
    this.body.setTranslation({ x, y: y + BODY_H / 2 + 0.05, z }, true);
    this.cam.snap();
  }

  note(text: string, kind: Note['kind'] = 'info') {
    this.notes.push({ text, kind, t: 3.6 });
    if (this.notes.length > 4) this.notes.shift();
  }

  // ------------------------------------------------------------------ Pilot

  /** Convert controller input to vehicle controls while driving. */
  drive(v: Vehicle, dt: number): DriveInput {
    if (this.autopilot && this.ctx.terrain) {
      const T = this.ctx.terrain;
      const z = v.position.z + 28;
      if (!v.engineOn && v.fuel > 0.001) v.setEngine(true);
      return steerTo(v, roadX(T, z) + (this.autopilot.lane ?? (this.index === 0 ? 2.2 : -2.2)), z, this.autopilot.speed, this.apState, this.ctx.obs, dt);
    }
    const it = this.intent;
    const kb = it.device === 'keyboard';
    let throttle: number;
    let brake: number;
    if (kb) {
      throttle = Math.max(0, it.move[1]);
      brake = Math.max(0, -it.move[1]);
    } else {
      throttle = it.rt;
      brake = it.lt;
    }
    // Hold B to kill the engine for a silent coast; tap toggles headlights.
    if (isHeld(it, Btn.B) && heldFor(it, Btn.B) > 0.45) {
      if (v.engineOn) {
        v.setEngine(false);
        this.note('Engine off: silent coast', 'info');
      }
    }
    if (!v.engineOn && throttle > 0.2 && !(isHeld(it, Btn.B) && heldFor(it, Btn.B) > 0.45)) {
      v.setEngine(true);
      if (v.startFail && this.ctx.time - this.startNoteAt > 3) {
        this.startNoteAt = this.ctx.time;
        this.note(v.startFail, 'warn');
      }
    }
    void dt;
    return { steer: it.move[0], throttle, brake, handbrake: it.handbrake };
  }

  // ------------------------------------------------------------------ damage

  hurt(amount: number, fromX: number, fromZ: number, kind: 'bullet' | 'melee' | 'blast' | 'fall' | 'fire' | 'bite' | 'spore' | 'ram') {
    if (this.state === 'dead' || this.invuln > 0) return;
    const ctx = this.ctx;
    const dmg = amount * (kind === 'bite' || kind === 'melee' ? 1 : 1) * ctx.campaign.difficulty.damage;
    this.sinceHit = 0;
    this.lastHurtDir = Math.atan2(fromX - this.pos.x, fromZ - this.pos.z);
    // Taking a hit interrupts hold actions such as repairs.
    if (this.action && this.action.kind !== 'revive' && kind !== 'spore') {
      this.action = null;
    }
    if (this.state === 'downed') {
      // Hits on a downed player speed up the bleed-out.
      this.downT += dmg * 0.04;
      return;
    }
    if (this.inVehicle) return; // vehicle takes hits instead
    this.hp = Math.max(0, this.hp - dmg);
    if (kind !== 'bite' || this.hitCooldown <= 0) {
      this.cam.addShake(Math.min(0.6, dmg / 60));
      ctx.input.rumble(this.index, Math.min(1, dmg / 30), 0.5, 100);
      this.hitCooldown = 0.25;
      if (kind === 'bullet') ctx.audio.play('hit', this.pos.x, this.pos.z, 0.6);
    }
    if (this.hp <= 0) this.goDown();
  }

  private goDown() {
    dropCarry(this);
    this.state = 'downed';
    this.downT = 0;
    this.pinned = 0;
    this.action = null;
    this.equip = 'pistol';
    this.ctx.campaign.stats.downs[this.index]++;
    this.ctx.radio(t('radio.downed', { name: this.name }));
    if (this.partner) this.note('You are down! Wait for your partner to revive you.', 'bad');
    else this.note(this.ctx.campaign.items.medkit > 0 ? 'You are down! Hold A to patch yourself up with a medkit.' : 'You are down, and there is no medkit. Nobody is coming.', 'bad');
    this.partner?.note(`${this.name} is down: hold A near them to revive`, 'warn');
  }

  heal(amount: number) {
    this.hp = Math.min(this.maxHp, this.hp + amount);
  }

  /** Back on your feet. `by` is the seat that did it: the partner, or yourself with a medkit when playing solo. */
  revive(by = 1 - this.index) {
    this.state = 'foot';
    this.hp = this.maxHp * 0.4;
    this.downT = 0;
    this.selfReviveT = 0;
    this.invuln = 1.2;
    this.ctx.radio(t('radio.revived', { name: this.name }));
    this.ctx.campaign.stats.revives[by]++;
  }

  // ------------------------------------------------------------------ enter / exit

  nearestDoor(): { v: Vehicle; seat: 'driver' | 'gunner'; d: number } | null {
    let best: { v: Vehicle; seat: 'driver' | 'gunner'; d: number } | null = null;
    for (const v of this.ctx.vehicles) {
      // Abandoned cars are fair game; raiders' and crew vehicles are not.
      if (v.wreck || v.faction === 'raider' || v.kind === 'crew') continue;
      const pos = v.position;
      const dc = Math.hypot(pos.x - this.pos.x, pos.z - this.pos.z);
      const reach = v.def.length * 0.5 + 1.6;
      if (dc > reach) continue;
      if (Math.abs(v.speed) > 2.2) continue;
      if (!v.driver) {
        const d1 = Math.min(...[1, -1].map((s) => Math.hypot(v.doorPos(s as 1 | -1)[0] - this.pos.x, v.doorPos(s as 1 | -1)[2] - this.pos.z)));
        if (!best || d1 < best.d) best = { v, seat: 'driver', d: d1 };
      } else if (v.driver !== this && v.faction === 'convoy' && v.def.seats >= 2 && !v.passenger) {
        // Second seat: the gun post in a bed, or the passenger seat in a cab.
        const g = v.gunnerPos();
        const d2 = Math.hypot(g[0] - this.pos.x, g[2] - this.pos.z);
        if (d2 < 3.2 && (!best || d2 < best.d)) best = { v, seat: 'gunner', d: d2 };
      }
    }
    return best;
  }

  tryEnter(): boolean {
    const door = this.nearestDoor();
    if (!door) return false;
    stashBeforeEntering(this);
    this.state = 'entering';
    this.enterT = 0;
    this.enterFrom.copy(this.pos);
    this.enterTo = door.v;
    this.enterSeat = door.seat;
    this.action = null;
    return true;
  }

  private finishEnter() {
    const v = this.enterTo;
    if (!v) {
      this.state = 'foot';
      return;
    }
    this.vehicle = v;
    if (this.enterSeat === 'driver') {
      // Climbing into an abandoned car claims it for the convoy.
      if (v.faction === 'neutral') this.ctx.cars.claim(v, this);
      v.driver = this;
      this.ownVehicle = v.ownerIndex === this.index ? v : this.ownVehicle;
      this.state = 'driving';
      v.setEngine(true);
      if (v.startFail) this.note(v.startFail + (v.startFail.startsWith('Engine') ? ': equip the wrench' : ''), 'warn');
      if (this.ctx.night > 0.45) v.lights = true;
    } else {
      v.passenger = { index: this.index };
      this.state = 'gunner';
    }
    this.equip = 'pistol';
    this.cam.snap();
    this.aimYaw = v.yaw;
    this.aimPitch = 0.05;
    this.enterTo = null;
    if (this.ctx.biome === 'city' && this.ctx.night < 0.4) this.note('Engines are Noise in the city: park and walk to stay quiet', 'info');
  }

  /** Leave the vehicle. `bail` is a tuck-and-roll at speed. */
  exitVehicle(bail: boolean) {
    const v = this.vehicle;
    if (!v) return;
    let spot = v.exitSpot();
    const boat = v.def.physics.kind === 'boat';
    if (boat) {
      // Step out onto the dock or the beach if there is one close by; otherwise over the side and into the water.
      const L = v.def.length / 2 + 1.3;
      const tries = [v.doorPos(1), v.doorPos(-1), v.body.toWorld(0, 0, L), v.body.toWorld(0, 0, -L), v.body.toWorld(1.8, 0, 0), v.body.toWorld(-1.8, 0, 0)];
      for (const [x, , z] of tries) {
        const w = this.ctx.waterAt(x, z);
        if ((!w || w.depth < 0.9 || this.ctx.groundAt(x, z) > (w?.level ?? 0) - 0.2) && !this.ctx.obs.pointInside(x, z, 1)) {
          spot = { x, z };
          break;
        }
      }
    }
    const speed = Math.abs(v.speed);
    if (this.state === 'driving') {
      v.driver = null;
      v.setEngine(false);
      v.lights = false;
    } else v.passenger = null;
    this.vehicle = null;
    this.state = 'foot';
    const ground = this.ctx.groundAt(spot.x, spot.z);
    const sw = this.ctx.waterAt(spot.x, spot.z);
    // Over the side into deep water: you start afloat, head above the surface.
    const y = sw && sw.depth > 1.1 && ground < sw.level ? sw.level - 1.2 : ground + 0.1;
    this.pos.set(spot.x, y, spot.z);
    this.prevPos.copy(this.pos);
    this.body.setTranslation({ x: spot.x, y: this.pos.y + BODY_H / 2, z: spot.z }, true);
    this.vy = 0;
    this.yaw = v.yaw;
    this.aimYaw = v.yaw;
    this.cam.snap();
    if (bail && speed > 3 && !boat) {
      const dmg = 10 + clamp(speed / 20, 0, 1) * 20;
      this.hurt(dmg, spot.x, spot.z, 'fall');
      this.note(`Bailed out at ${(speed * 3.6).toFixed(0)} km/h`, 'warn');
    }
  }

  // ------------------------------------------------------------------ tick

  update(dt: number) {
    const ctx = this.ctx;
    const it = this.intent;
    this.prevPos.copy(this.pos);
    if (this.hitCooldown > 0) this.hitCooldown -= dt;
    if (this.invuln > 0) this.invuln -= dt;
    this.sinceHit += dt;
    for (const n of this.notes) n.t -= dt;
    while (this.notes.length && this.notes[0].t <= 0) this.notes.shift();
    this.commandWheel = isHeld(it, Btn.Up) && this.state !== 'dead';
    this.sheet = isHeld(it, Btn.Back) && heldFor(it, Btn.Back) > 0.25;
    if (wasPressed(it, Btn.Down) && this.state !== 'dead') this.mapMode = (this.mapMode + 1) % this.ctx.mapModes;
    else if (this.mapMode >= this.ctx.mapModes) this.mapMode = 0;
    if (this.fireCd > 0) this.fireCd -= dt;
    if (this.meleeCd > 0) this.meleeCd -= dt;
    if (this.muzzleT > 0) this.muzzleT -= dt;
    if (this.reloadT > 0) {
      this.reloadT -= dt;
      if (this.reloadT <= 0) this.finishReload();
    }
    this.prompt = null;
    // A seated player must not collide: a kinematic capsule inside the cab would shove the chassis into the ground.
    const wantBody = this.state === 'foot' || this.state === 'downed';
    if (wantBody !== this.colliderOn) {
      this.body.setEnabled(wantBody);
      this.colliderOn = wantBody;
    }

    if (wasPressed(it, Btn.View) && (this.state === 'foot' || this.state === 'driving' || this.state === 'gunner') && !this.buildMode) this.toggleView();

    switch (this.state) {
      case 'foot':
        this.updateFoot(dt, it);
        break;
      case 'entering':
        this.updateEntering(dt);
        break;
      case 'driving':
        this.updateDriving(dt, it);
        break;
      case 'gunner':
        this.updateGunner(dt, it);
        break;
      case 'downed':
        this.updateDowned(dt, it);
        break;
      case 'dead':
        this.updateDead(dt);
        break;
    }
    // The camera itself runs per render frame (renderCamera) so it follows the interpolated pose, not the 60 Hz physics one.
    this.lookIn[0] = it.look[0];
    this.lookIn[1] = it.look[1];

    // Signature meter for the HUD.
    this.signatureShown = this.currentSignature();
    if (this.state === 'foot' || this.state === 'downed') {
      const s = this.footSignature();
      if (s > 0) ctx.sig.emit(this.pos.x, this.pos.z, s * ctx.signatureMult, 'noise');
    }
  }

  /** Switch between the chase camera and the eyes, and remember the choice for the next leg. */
  toggleView() {
    this.viewFirst = !this.viewFirst;
    const fp = this.ctx.input.settings.firstPerson;
    if (fp) fp[this.index] = this.viewFirst;
    this.ctx.input.onChange?.();
    this.driveLook[0] = this.driveLook[1] = 0;
    this.note(this.viewFirst ? 'First person view' : 'Third person view', 'info');
  }

  /** Right-stick and look-key speed for this seat, from the control settings. */
  private lookGain(it: PlayerIntent): number {
    const s = this.ctx.input.settings;
    return (s.lookSens?.[this.index] ?? 1) * (it.device === 'keyboard' ? (s.keyTurn ?? 1) : 1);
  }

  /** Pitch limits: first person can look nearly straight up and down. */
  private pitchRange(): [number, number] {
    return this.firstPerson ? [-1.3, 1.3] : [-0.55, 0.75];
  }

  footSignature(): number {
    if (this.state === 'downed') return 8;
    if (this.state !== 'foot') return 0;
    if (this.swimming) return this.moveSpeed > 0.5 ? 16 : 5;
    if (this.waterDepth > 0.3 && this.moveSpeed > 0.5) return 12;
    if (this.moveSpeed > 4.5) return 20;
    if (this.moveSpeed > 0.5) return this.crouch ? 3 : 8;
    return this.crouch ? 2 : 3;
  }

  currentSignature(): number {
    if (this.vehicle && (this.state === 'driving' || this.state === 'gunner')) return Math.round(this.vehicle.signature());
    return this.footSignature() + (this.muzzleT > 0 ? 60 : 0);
  }

  // ------------------------------------------------------------------ on foot

  private updateFoot(dt: number, it: PlayerIntent) {
    const ctx = this.ctx;
    this.updateAim(dt, it);
    // Movement relative to the camera.
    let mx = it.move[0];
    let my = it.move[1];
    const mag = Math.hypot(mx, my);
    if (mag > 1) {
      mx /= mag;
      my /= mag;
    }
    if (it.device !== 'pad' && it.move[1] === 0 && it.move[0] === 0) {
      // keep idle
    }
    const fx = Math.sin(this.aimYaw);
    const fz = Math.cos(this.aimYaw);
    const rx = -Math.cos(this.aimYaw);
    const rz = Math.sin(this.aimYaw);
    let wx = fx * my + rx * mx;
    let wz = fz * my + rz * mx;
    const aiming = this.ads > 0.35;
    const wantSprint = it.sprint && my > 0.3 && !aiming && !this.crouch && this.equip !== 'jerrycan' && !this.carry;
    // Crouch is a toggle on B (or hold, per the control settings), cancelled by sprint.
    if (this.ctx.input.settings.toggleCrouch?.[this.index] === false) this.crouch = isHeld(it, Btn.B);
    else if (wasPressed(it, Btn.B)) this.crouch = !this.crouch;
    if (wantSprint) this.crouch = false;
    // Water: wading drags at the legs, deep water means swimming (slow, no sprint, no crouch).
    const wet = ctx.waterAt(this.pos.x, this.pos.z);
    this.waterDepth = wet ? wet.depth : 0;
    this.waterLevel = wet ? wet.level : 0;
    this.swimming = this.waterDepth > (this.swimming ? 1.1 : 1.3);
    if (this.swimming) this.crouch = false;
    let speed = wantSprint && this.waterDepth < 0.6 ? SPRINT : this.crouch ? CROUCH : WALK;
    if (this.waterDepth > 0.25) speed *= 1 - 0.42 * clamp((this.waterDepth - 0.25) / 0.9, 0, 1);
    if (this.swimming) speed = Math.min(speed, 2.0);
    if (aiming) speed = Math.min(speed, 2.3);
    if (this.equip === 'jerrycan') speed *= 0.82;
    if (this.carry) speed *= carrySlow(this.carry);
    if (this.pinned >= ENEMIES.zombieRules.pinAt) speed = 0;
    // Fatigue from watch duty slows the next day.
    speed *= 1 - clamp(this.fatigue, 0, 0.2);
    this.moveSpeed = damp(this.moveSpeed, Math.hypot(wx, wz) * speed, 14, dt);
    const targetVx = wx * speed;
    const targetVz = wz * speed;
    // Facing: toward the aim when aiming or shooting, otherwise toward travel.
    // In first person the body always faces where the eyes look, so the arms stay in front of the camera.
    if (this.firstPerson) this.yaw = dampAngle(this.yaw, this.aimYaw, 20, dt);
    else if (aiming || this.muzzleT > 0 || isHeld(it, Btn.RT)) this.yaw = dampAngle(this.yaw, this.aimYaw, 16, dt);
    else if (mag > 0.15 && speed > 0) this.yaw = dampAngle(this.yaw, Math.atan2(targetVx, targetVz), 12, dt);
    this.moveBody(dt, targetVx, targetVz);

    // Pin: break free with five left-stick rotations.
    if (this.pinned >= ENEMIES.zombieRules.pinAt) {
      this.pinBreak += it.stickLoops;
      if (this.pinBreak >= ENEMIES.zombieRules.pinBreakRotations) {
        this.pinBreak = 0;
        ctx.zombies.breakGrab(this);
        this.note('Broke free!', 'good');
      }
    } else this.pinBreak = Math.max(0, this.pinBreak - dt * 0.3);

    this.updateTools(dt, it);
    this.updateInteractions(dt, it);

    // Pick up swap: LB cycles equipment.
    if (!this.buildMode && wasPressed(it, Btn.LB)) {
      if (this.carry) this.note('Hands full: stow it or put it down first', 'info');
      else this.cycleEquip();
    }
    if (!this.carry && heldFor(it, Btn.X) > 0.6 && isHeld(it, Btn.X) && !this.action) {
      // hold X: swap utility item
      if (it.heldTime[Btn.X] < 0.6 + dt * 1.5 && it.heldTime[Btn.X] >= 0.6) this.cycleUtility();
    }
    if (wasPressed(it, Btn.R3)) this.cam.snap();
    // Y: enter / exit.
    if (wasPressed(it, Btn.Y)) {
      if (!this.tryEnter()) this.note('No vehicle in reach', 'info');
    }
    // Ground hazards: spore clouds are handled by the zombie system.
  }

  private moveBody(dt: number, vx: number, vz: number) {
    const ctx = this.ctx;
    this.vy -= 22 * dt;
    if (this.vy < -30) this.vy = -30;
    let desired = { x: vx * dt, y: this.vy * dt, z: vz * dt };
    if (this.swimming) {
      // Afloat: no gravity, ease toward the surface so the head stays out and the body bobs a little.
      this.vy = 0;
      const target = this.waterLevel - 1.2 + Math.sin(ctx.time * 2.2 + this.index) * 0.04;
      desired = { x: vx * dt, y: clamp((target - this.pos.y) * 7 * dt, -0.35, 0.35), z: vz * dt };
    }
    this.splashT -= dt;
    if (this.waterDepth > 0.15 && Math.hypot(vx, vz) > 0.8 && this.splashT <= 0) {
      this.splashT = this.swimming ? 0.22 : 0.3;
      ctx.fx.puff(this.pos.x, this.waterLevel + 0.04, this.pos.z, 0.92, 0.96, 1.0, this.swimming ? 0.9 : 0.6, 0.7);
      if (Math.random() < 0.5) ctx.audio.play('splash', this.pos.x, this.pos.z, this.swimming ? 0.4 : 0.25);
    }
    this.kcc.computeColliderMovement(this.collider, desired, undefined, RAY_STATIC);
    const m = this.kcc.computedMovement();
    this.grounded = this.kcc.computedGrounded();
    if (this.grounded && this.vy < 0) this.vy = 0;
    if (this.swimming) this.grounded = false;
    // The body is the capsule centre: update our feet position from it.
    const t = this.body.translation();
    const nx = t.x + m.x;
    const ny = t.y + m.y;
    const nz = t.z + m.z;
    this.body.setNextKinematicTranslation({ x: nx, y: ny, z: nz });
    this.body.setTranslation({ x: nx, y: ny, z: nz }, false);
    this.pos.set(nx, ny - BODY_H / 2, nz);
    // Hard floor in case a heightfield seam lets us fall.
    const gy = ctx.groundAt(nx, nz);
    if (this.pos.y < gy - 2) {
      this.pos.y = gy + 0.5;
      this.body.setTranslation({ x: nx, y: gy + 0.5 + BODY_H / 2, z: nz }, true);
      this.vy = 0;
    }
    if (ctx.bounds) {
      const b = ctx.bounds;
      const cx = clamp(this.pos.x, b.minX, b.maxX);
      const cz = clamp(this.pos.z, b.minZ, b.maxZ);
      if (cx !== this.pos.x || cz !== this.pos.z) {
        this.pos.x = cx;
        this.pos.z = cz;
        this.body.setTranslation({ x: cx, y: this.pos.y + BODY_H / 2, z: cz }, true);
      }
    }
  }

  private updateAim(dt: number, it: PlayerIntent) {
    const sens = lerp(2.9, 1.55, this.ads) * (it.device === 'keyboard' ? 0.9 : 1) * this.lookGain(it);
    const [pLo, pHi] = this.pitchRange();
    this.aimYaw -= it.look[0] * sens * dt;
    this.aimPitch = clamp(this.aimPitch + it.look[1] * sens * 0.7 * dt, pLo, pHi);
    if (it.mouse) {
      this.aimYaw -= it.lookDelta[0] * this.mouseScale();
      this.aimPitch = clamp(this.aimPitch + it.lookDelta[1] * this.mouseScale(), pLo, pHi);
    }
    // With a mouse, right-click aims and left-click only fires; with Q/E the fire key doubles as aim.
    const kbAds = it.device === 'keyboard' && !it.mouse && isHeld(it, Btn.RT) && !this.carry;
    this.ads = damp(this.ads, it.lt > 0.3 && this.equip === 'pistol' && !this.carry ? 1 : kbAds ? 1 : 0, 12, dt);
    if (it.device === 'keyboard' && !it.mouse) this.aimPitch = damp(this.aimPitch, 0.04, 3, dt);
  }

  /** Mouse look is slowed while aiming down sights. */
  private mouseScale() {
    return lerp(1, 0.6, this.ads);
  }

  /** Raycast from the camera through the reticle and find where the shot lands. */
  computeAim(ignoreVehicle?: Vehicle | null) {
    const ctx = this.ctx;
    const cam = this.ctx.R.views[this.index].camera;
    cam.updateMatrixWorld();
    cam.getWorldDirection(_v);
    const ox = cam.position.x;
    const oy = cam.position.y;
    const oz = cam.position.z;
    let dist = 80;
    const r = ctx.P.raycast(ox, oy, oz, _v.x, _v.y, _v.z, 80, RAY_STATIC, ignoreVehicle?.body.body);
    if (r) dist = Math.min(dist, r.toi);
    const zr = ctx.zombies.rayTest(ox, oy, oz, _v.x, _v.y, _v.z, dist);
    if (zr) dist = Math.min(dist, zr.dist);
    const ar = ctx.wildlife.rayTest(ox, oy, oz, _v.x, _v.y, _v.z, dist);
    if (ar) dist = Math.min(dist, ar.dist);
    const ir = ctx.raiders.infantryRayTest(ox, oy, oz, _v.x, _v.y, _v.z, dist);
    if (ir) dist = Math.min(dist, ir.dist);
    // Ignore the player's own body: skip hits closer than the camera-to-player distance.
    const toPlayer = Math.hypot(this.pos.x - ox, this.pos.z - oz);
    if (dist < toPlayer * 0.9 && dist < 80) dist = Math.max(dist, toPlayer + 1);
    this.aimDist = dist;
    this.aimPoint.set(ox + _v.x * dist, oy + _v.y * dist, oz + _v.z * dist);
    return { ox, oy, oz, dx: _v.x, dy: _v.y, dz: _v.z };
  }

  private muzzlePos(): [number, number, number] {
    const f = this.aimYaw;
    return [this.pos.x + Math.sin(f) * 0.45 - Math.cos(f) * 0.18, this.pos.y + (this.crouch ? 0.95 : 1.4), this.pos.z + Math.cos(f) * 0.45 + Math.sin(f) * 0.18];
  }

  private cycleEquip() {
    const order: Equip[] = ['pistol', 'wrench', 'crowbar', 'jerrycan', 'utility'];
    let i = order.indexOf(this.equip);
    this.action = null;
    for (let n = 0; n < order.length; n++) {
      i = (i + 1) % order.length;
      if (order[i] === 'utility' && this.ctx.campaign.items[this.utility === 'horn' ? 'flare' : (this.utility as 'flare' | 'molotov' | 'charge')] <= 0 && this.utility !== 'horn') continue;
      break;
    }
    this.equip = order[i];
    this.reloadT = 0;
  }

  private cycleUtility() {
    const i = UTILITIES.indexOf(this.utility);
    this.utility = UTILITIES[(i + 1) % UTILITIES.length];
    this.ctx.campaign.players[this.index].utility = this.utility;
    this.note(`Utility: ${utilityName(this.utility)}`, 'info');
  }

  private finishReload() {
    const camp = this.ctx.campaign;
    const need = 12 - this.mag;
    const take = Math.min(need, camp.ammo);
    this.mag += take;
    camp.ammo -= take;
    if (take === 0 && this.mag === 0) this.note('Out of ammo: craft more at camp', 'warn');
  }

  private updateTools(dt: number, it: PlayerIntent) {
    const ctx = this.ctx;
    if (this.buildMode) {
      ctx.campHook?.(this, it, dt);
      return;
    }
    // Hands full: no gun, no tools, until it is stowed or put down.
    if (this.carry) return;
    if (this.equip === 'pistol') {
      if (wasPressed(it, Btn.X) && this.mag < 12 && this.reloadT <= 0 && ctx.campaign.ammo > 0) {
        this.reloadT = 1.3;
        ctx.audio.play('reload', this.pos.x, this.pos.z, 0.5);
      }
      const wantFire = it.rt > 0.5 && (it.device !== 'pad' || this.ads > 0.0 || true);
      if (wantFire && this.fireCd <= 0 && this.reloadT <= 0) {
        if (this.mag > 0) this.firePistol();
        else if (ctx.campaign.ammo > 0) {
          this.reloadT = 1.3;
        } else if (this.fireCd <= 0) {
          this.fireCd = 0.4;
          this.note('Out of ammo: craft more at camp', 'warn');
        }
      }
      // RB: melee tap, takedown hold.
      this.updateMelee(dt, it);
    } else if (this.equip === 'utility') {
      if (wasPressed(it, Btn.RT)) this.useUtility();
      this.updateMelee(dt, it);
    } else {
      this.updateMelee(dt, it);
    }
  }

  private firePistol() {
    const ctx = this.ctx;
    const a = this.computeAim();
    const [mx, my, mz] = this.muzzlePos();
    let dx = this.aimPoint.x - mx;
    let dy = this.aimPoint.y - my;
    let dz = this.aimPoint.z - mz;
    const l = Math.hypot(dx, dy, dz);
    if (l < 2.5) {
      dx = a.dx;
      dy = a.dy;
      dz = a.dz;
    } else {
      dx /= l;
      dy /= l;
      dz /= l;
    }
    this.fireCd = 0.2;
    this.mag--;
    this.muzzleT = 0.12;
    ctx.combat.shoot(mx, my, mz, dx, dy, dz, {
      side: 'convoy',
      damage: 27,
      spread: lerp(0.03, 0.008, this.ads) * (this.crouch ? 0.7 : 1) * (this.moveSpeed > 3 ? 1.6 : 1),
      assist: it0(this.intent.aimAssist),
      noise: 60,
      range: 75,
      headshots: true,
      owner: this,
    });
    ctx.fx.flash(mx, my, mz, 0.9);
    ctx.audio.play('pistol', mx, mz, 0.8);
    this.cam.addShake(0.05);
    ctx.input.rumble(this.index, 0.15, 0.3, 50);
  }

  private updateMelee(dt: number, it: PlayerIntent) {
    const ctx = this.ctx;
    const heldRB = isHeld(it, Btn.RB);
    const rbTime = heldFor(it, Btn.RB);
    const tk = ctx.zombies.takedownTarget(this);
    if (heldRB && rbTime > 0.22 && tk) {
      this.takedownT += dt;
      this.prompt = { text: t('prompt.takedown'), progress: this.takedownT / 1.2, button: 'RB' };
      this.moveSpeed = 0.3;
      if (this.takedownT >= 1.2) {
        this.takedownT = 0;
        ctx.zombies.takedown(tk, this.index);
        ctx.sig.emit(this.pos.x, this.pos.z, 4, 'noise');
        this.note('Silent takedown', 'good');
      }
      return;
    }
    this.takedownT = 0;
    if (it.released & (1 << Btn.RB) && rbTime < 0.3 && this.meleeCd <= 0) this.melee();
    else if (wasPressed(it, Btn.RB) && !tk && this.meleeCd <= 0 && false) this.melee();
    else if (tk && !heldRB) this.prompt = { text: `Hold RB: ${t('prompt.takedown')}`, progress: -1, button: 'RB' };
  }

  private melee() {
    const ctx = this.ctx;
    this.meleeCd = 0.55;
    const f = this.aimYaw;
    const hx = this.pos.x + Math.sin(f) * 1.0;
    const hz = this.pos.z + Math.cos(f) * 1.0;
    ctx.audio.play('swing', this.pos.x, this.pos.z, 0.5);
    ctx.zombies.meleeHit(this, hx, hz, f, 1.9, 35);
    ctx.wildlife.meleeHit(this, hx, hz, f, 1.9, 35);
    ctx.raiders.meleeHit(this, hx, hz, f, 1.9, 35);
    ctx.sig.emit(this.pos.x, this.pos.z, 12, 'noise');
    this.cam.addShake(0.08);
  }

  private useUtility() {
    const ctx = this.ctx;
    const camp = ctx.campaign;
    const a = this.computeAim();
    const [mx, my, mz] = this.muzzlePos();
    const dir = [a.dx, Math.max(a.dy, 0) + 0.35, a.dz] as const;
    const dl = Math.hypot(dir[0], dir[1], dir[2]);
    switch (this.utility) {
      case 'flare':
        if (camp.items.flare <= 0) return this.note('No flares left: craft some at camp', 'warn');
        camp.items.flare--;
        ctx.projectiles.throw('flare', mx, my, mz, (dir[0] / dl) * 16, (dir[1] / dl) * 16, (dir[2] / dl) * 16, this);
        break;
      case 'molotov':
        if (camp.items.molotov <= 0) return this.note('No molotovs left: craft some at camp', 'warn');
        camp.items.molotov--;
        ctx.projectiles.throw('molotov', mx, my, mz, (dir[0] / dl) * 15, (dir[1] / dl) * 15, (dir[2] / dl) * 15, this);
        break;
      case 'charge': {
        if (camp.items.charge <= 0) return this.note('No breaching charges: craft one at camp', 'warn');
        const target = ctx.projectiles.nearestBreachable(this.pos.x, this.pos.z, 4.5);
        if (!target) return this.note('Stand next to a reinforced barricade to place a charge', 'info');
        camp.items.charge--;
        ctx.projectiles.placeCharge(target, this);
        break;
      }
      case 'horn':
        ctx.projectiles.decoy(this.pos.x + Math.sin(this.aimYaw) * 1.2, this.pos.z + Math.cos(this.aimYaw) * 1.2);
        this.note('Decoy horn planted', 'info');
        break;
    }
  }

  // ------------------------------------------------------------------ interactions

  private updateInteractions(dt: number, it: PlayerIntent) {
    const ctx = this.ctx;
    const heldA = isHeld(it, Btn.A);
    let cand: Cand | null = null;

    // 1. Revive the partner.
    const pt = this.partner;
    if (pt && pt.state === 'downed' && Math.hypot(pt.pos.x - this.pos.x, pt.pos.z - this.pos.z) < 2.4) {
      const med = ctx.campaign.items.medkit > 0;
      cand = {
        kind: 'revive',
        prompt: t('prompt.revive') + (med ? ' (medkit)' : ''),
        dur: med ? 3.4 : 6.5,
        target: pt,
        ok: true,
        label: 'revive',
        run: () => {
          if (med) ctx.campaign.items.medkit--;
          pt.revive();
          this.note(`${pt.name} is up`, 'good');
        },
      };
    }
    // 2. Hands: lift a part, fuel can or oil can off the ground, or fit what you carry to your car.
    this.promptAlt = null;
    if (!cand) cand = haulCandidate(this);
    if (this.carry && wasPressed(it, Btn.X) && !this.action) haulKey(this);
    // 3. Tools on vehicles: the wrench repairs, the crowbar strips, the jerrycan fills and siphons.
    if (!cand && !this.carry && this.equip === 'wrench') cand = this.repairCandidate();
    else if (!cand && !this.carry && this.equip === 'crowbar') cand = this.salvageCandidate();
    else if (!cand && !this.carry && this.equip === 'jerrycan') cand = this.fuelCandidate();
    // X with the wrench: open the field workbench for a convoy vehicle.
    if (this.equip === 'wrench' && !this.carry && wasPressed(it, Btn.X) && !this.action) {
      const bv = this.nearestVehicle(3.8, (q) => q.faction === 'convoy' && !!q.build && !q.wreck);
      if (bv) ctx.openWorkbench?.(this, bv);
      else this.note('Stand next to one of your vehicles to use the workbench', 'info');
    }
    // 4. Registry items (loot containers, camp posts).
    if (!cand) {
      const r = ctx.interact.nearest(this);
      if (r) {
        cand = {
          kind: 'reg:' + r.id,
          prompt: r.prompt,
          dur: r.dur,
          target: r,
          ok: true,
          label: r.id,
          run: () => r.run(this),
          tick: () => r.onTick?.(this, this.action?.t ?? 0) !== false,
        };
      }
    }

    // Enter prompt when nothing else is going on and a vehicle is near.
    if (!cand) {
      const door = this.nearestDoor();
      if (door) {
        const hold = this.ctx.input.vehicleIsHold?.(this.index) ? 'Hold: ' : '';
        this.prompt = { text: hold + (door.seat === 'gunner' ? 'Ride gunner seat' : t('prompt.enter')), progress: -1, button: 'Y' };
      }
    }

    if (cand) {
      if (this.action && this.action.kind === cand.kind && this.action.target === cand.target) {
        if (!heldA || !cand.ok) {
          this.action = null;
        } else {
          this.action.t += dt;
          this.moveSpeed = Math.min(this.moveSpeed, 0.5);
          if (cand.tick && cand.tick() === false) this.action = null;
          else if (this.action.t >= this.action.dur) {
            const run = cand.run;
            this.action = null;
            run();
            ctx.sig.emit(this.pos.x, this.pos.z, cand.noise ?? (cand.kind === 'repair' ? 22 : 12), 'noise');
          }
        }
      } else if (heldA && cand.ok && wasPressedOrFresh(it)) {
        this.action = { kind: cand.kind, t: 0, dur: cand.dur, target: cand.target, label: cand.label };
      } else if (this.action) {
        this.action = null;
      }
      this.prompt = {
        text: cand.prompt,
        progress: this.action && this.action.kind === cand.kind ? this.action.t / this.action.dur : -1,
        button: 'A',
      };
      if (!cand.ok && !this.action) this.prompt.progress = -1;
    } else if (this.action) {
      this.action = null;
    }
    if (this.action) this.speedPenalty();
    if (this.carry) haulPrompt(this);
  }

  private speedPenalty() {
    this.moveSpeed *= 0.2;
  }

  /** Closest vehicle matching `ok` within reach of the player's feet. */
  nearestVehicle(r: number, ok: (v: Vehicle) => boolean): Vehicle | null {
    let best: Vehicle | null = null;
    let bd = Infinity;
    for (const v of this.ctx.vehicles) {
      if (!ok(v)) continue;
      const d = Math.hypot(v.position.x - this.pos.x, v.position.z - this.pos.z) - v.def.length * 0.4;
      if (d < r && d < bd) {
        bd = d;
        best = v;
      }
    }
    return best;
  }

  /** Wrench: do the most urgent job on the nearest convoy or abandoned vehicle, paying for it with real stock. */
  private repairCandidate(): Cand | null {
    const ctx = this.ctx;
    const v = this.nearestVehicle(3.8, (q) => !q.wreck && q.faction !== 'raider' && q.kind !== 'crew');
    if (!v) return null;
    const bench = v.faction === 'convoy' && v.build ? '  ·  X: workbench' : '';
    const job = planRepair(v.health, ctx.campaign.stocks, { spare: v.stats.spare, weapon: !!v.weapon });
    if (!job) return { kind: 'repair', prompt: `${v.def.name} is in good shape${bench}`, dur: 1, target: v, ok: false, label: 'repair', run: () => {} };
    const cost = Object.keys(job.cost).length ? ` (${costText(job.cost)})` : '';
    return {
      kind: 'repair',
      prompt: job.ok ? `${job.label}${cost}${bench}` : `${job.why}${bench}`,
      dur: job.secs,
      target: v,
      ok: job.ok,
      label: 'repair',
      run: () => {
        if (!spend(ctx.campaign.stocks, job.cost)) return this.note('Not enough stock', 'warn');
        const msg = applyRepair(v.health, job);
        this.note(msg, 'good');
        if (job.kind === 'engine' && v.health.comp.engine >= 0.1) v.startFail = '';
        ctx.audio.play('wrench', v.position.x, v.position.z, 0.7);
      },
      tick: () => {
        if (Math.random() < 0.15) ctx.fx.spark(v.position.x, v.position.y + 0.8, v.position.z, 2, 3);
        return true;
      },
    };
  }

  /** Crowbar: strip the next stage off an abandoned car or a wreck. */
  private salvageCandidate(): Cand | null {
    const ctx = this.ctx;
    const v = this.nearestVehicle(3.8, (q) => ctx.cars.canSalvage(q));
    if (!v) return null;
    const stage = ctx.cars.nextStage(v);
    if (!stage) return null;
    const hot = v.wreck && v.burnT > 0;
    const live = !v.wreck && v.faction === 'neutral';
    return {
      kind: 'salvage',
      prompt: hot ? 'Still burning: too hot to touch' : `${stage.prompt}${live && v.salvaged < 3 ? ' (it will no longer run)' : ''} · ${v.salvaged + 1}/${SALVAGE_STAGES.length}`,
      dur: stage.secs,
      target: v,
      ok: !hot,
      label: 'salvage',
      noise: stage.noise,
      run: () => {
        ctx.cars.salvage(v, this);
      },
      tick: () => {
        if (Math.random() < 0.2) ctx.fx.spark(v.position.x + (Math.random() - 0.5) * 2, v.position.y + 0.7, v.position.z + (Math.random() - 0.5) * 2, 2, 3);
        if (Math.random() < 0.05) ctx.audio.play('wrench', v.position.x, v.position.z, 0.5);
        return true;
      },
    };
  }

  /** Jerrycan: top up a convoy vehicle from the reserve (fuel, or oil when the sump is low), or siphon an abandoned one. */
  private fuelCandidate(): Cand | null {
    const ctx = this.ctx;
    const own = this.nearestVehicle(3.8, (q) => q.faction === 'convoy' && !q.wreck && q.kind !== 'crew');
    if (own) {
      const space = own.tankMax - own.fuel;
      const takesOil = own.build !== null && own.def.physics.kind !== 'boat';
      const oil = own.health.comp.oil;
      const oilUrgent = takesOil && oil < OIL_LOW && ctx.campaign.items.oil > 0.02;
      const oilWanted = takesOil && oil < 0.9 && ctx.campaign.items.oil > 0.02;
      if (oilUrgent || (oilWanted && !(space > 0.4 && ctx.campaign.stocks.fuel > 0.4))) {
        const r = pourOil(oil, ctx.campaign.items.oil);
        return {
          kind: 'topoil',
          prompt: `Top up the oil from the reserve (${Math.round(oil * 100)}% → ${Math.round((oil + r.used) * 100)}%)`,
          dur: 2.4,
          target: own,
          ok: true,
          label: 'topoil',
          run: () => {
            const o = pourOil(own.health.comp.oil, ctx.campaign.items.oil);
            own.health.comp.oil = o.oil;
            ctx.campaign.items.oil = Math.max(0, ctx.campaign.items.oil - o.used);
            own.commit();
            this.note(`Oil topped up to ${Math.round(o.oil * 100)}%`, 'good');
          },
        };
      }
      const c: Cand = {
        kind: 'refuel',
        prompt: space > 0.4 ? t('prompt.refuel') : 'Tank is full',
        dur: 4,
        target: own,
        ok: space > 0.4 && ctx.campaign.stocks.fuel > 0.4,
        label: 'refuel',
        run: () => {
          const amt = Math.min(5, space, ctx.campaign.stocks.fuel);
          own.fuel += amt;
          ctx.campaign.stocks.fuel -= amt;
          this.note(`+${amt.toFixed(1)} FU`, 'good');
        },
      };
      if (space > 0.4 && ctx.campaign.stocks.fuel <= 0.4) c.prompt = 'Convoy reserve is empty';
      return c;
    }
    const donor = this.nearestVehicle(3.8, (q) => (q.faction === 'neutral' || q.wreck) && q.fuel > 0.4);
    if (!donor) return null;
    const hot = donor.wreck && donor.burnT > 0;
    return {
      kind: 'siphon',
      prompt: hot ? 'Still burning: too hot to touch' : `Siphon the tank (${Math.min(5, donor.fuel).toFixed(1)} FU)`,
      dur: 3,
      target: donor,
      ok: !hot,
      label: 'siphon',
      run: () => {
        const amt = Math.min(5, donor.fuel);
        donor.fuel -= amt;
        ctx.campaign.stocks.fuel += amt;
        this.note(`+${amt.toFixed(1)} FU siphoned`, 'good');
      },
    };
  }

  // ------------------------------------------------------------------ entering / driving / gunner

  private updateEntering(dt: number) {
    this.enterT += dt;
    const v = this.enterTo;
    if (!v || v.wreck) {
      this.state = 'foot';
      return;
    }
    const k = clamp(this.enterT / 0.45, 0, 1);
    const seat = this.enterSeat === 'driver' ? v.body.toWorld(0, -0.4, -0.1) : v.gunnerPos();
    this.pos.set(lerp(this.enterFrom.x, seat[0], k), lerp(this.enterFrom.y, seat[1] - 0.6, k), lerp(this.enterFrom.z, seat[2], k));
    this.body.setTranslation({ x: this.pos.x, y: this.pos.y + BODY_H / 2, z: this.pos.z }, false);
    this.moveSpeed = 0;
    if (k >= 1) this.finishEnter();
  }

  private updateDriving(dt: number, it: PlayerIntent) {
    const v = this.vehicle;
    const ctx = this.ctx;
    if (!v || v.wreck) {
      this.vehicle = null;
      this.state = 'foot';
      return;
    }
    this.lastKnownVehicleSpeed = v.speed;
    const p = v.position;
    this.pos.set(p.x, p.y, p.z);
    this.body.setTranslation({ x: p.x, y: p.y + 1.0, z: p.z }, false);
    // Horn / siren
    if (wasPressed(it, Btn.X)) {
      v.hornT = 0.6;
      ctx.audio.play('horn', p.x, p.z, 1);
    }
    if (heldFor(it, Btn.X) > 0.5 && isHeld(it, Btn.X)) {
      v.sirenT = 0.3;
    }
    if (it.released & (1 << Btn.B) && heldFor(it, Btn.B) < 0.45 && it.heldTime[Btn.B] < 0.45) {
      v.lights = !v.lights;
    }
    // Fire the vehicle gun. T2 fires along the nose; T3's gun belongs to the gunner.
    if (v.def.weapon === 'frontLMG' && (isHeld(it, Btn.RB) || (it.device === 'pad' && false))) v.fireGun(dt);
    // Camera toggles
    if (wasPressed(it, Btn.L3)) this.camFar = !this.camFar;
    this.lookBack = isHeld(it, Btn.R3);
    // Exit: tap Y when slow; hold Y to bail at speed. On a pad Y is also the view button, so there "tap" means a short hold.
    if (isHeld(it, Btn.Y)) {
      const slow = Math.abs(v.speed) < 2.2;
      if (slow && wasPressed(it, Btn.Y)) this.exitVehicle(false);
      else if (!slow && heldFor(it, Btn.Y) > 0.45) this.exitVehicle(true);
    }
    this.updateDriveLook(dt, it);
    // Low fuel / fire warnings.
    if (v.fuel < v.tankMax * 0.15 && v.fuel > 0.001 && Math.random() < dt * 0.05) this.note('Fuel is low', 'warn');
    if (this.ctx.biome === 'city' && ctx.night < 0.4 && Math.abs(v.speed) > 5) {
      /* noise tip handled elsewhere */
    }
  }

  /** First-person driving: the stick looks around and springs back, the mouse looks around and eases back to the road. */
  private updateDriveLook(dt: number, it: PlayerIntent) {
    if (!this.firstPerson) return;
    const gain = this.lookGain(it);
    const L = this.driveLook;
    const stick = Math.hypot(it.look[0], it.look[1]);
    if (it.mouse && (it.lookDelta[0] !== 0 || it.lookDelta[1] !== 0)) {
      L[0] = clamp(L[0] - it.lookDelta[0], -2.4, 2.4);
      L[1] = clamp(L[1] + it.lookDelta[1], -0.75, 0.75);
    } else if (stick > 0.05) {
      L[0] = damp(L[0], -it.look[0] * 1.6 * Math.min(1.5, gain), 10, dt);
      L[1] = damp(L[1], it.look[1] * 0.7 * Math.min(1.5, gain), 10, dt);
    } else {
      L[0] = damp(L[0], 0, it.mouse ? 0.9 : 8, dt);
      L[1] = damp(L[1], 0, it.mouse ? 0.9 : 8, dt);
    }
  }

  private updateGunner(dt: number, it: PlayerIntent) {
    const v = this.vehicle;
    if (!v || v.wreck) {
      this.vehicle = null;
      this.state = 'foot';
      return;
    }
    const p = v.gunnerPos();
    this.pos.set(p[0], p[1] - 0.2, p[2]);
    this.body.setTranslation({ x: p[0], y: p[1], z: p[2] }, false);
    // Aim the bed gun with the right stick (keyboard turns with Q/E).
    this.ads = damp(this.ads, it.lt > 0.3 ? 1 : 0, 10, dt);
    const sens = lerp(2.6, 1.4, this.ads) * this.lookGain(it);
    this.aimYaw -= it.look[0] * sens * dt;
    this.aimPitch = clamp(this.aimPitch + it.look[1] * sens * 0.7 * dt, -0.35, 0.8);
    if (it.mouse) {
      this.aimYaw -= it.lookDelta[0] * this.mouseScale();
      this.aimPitch = clamp(this.aimPitch + it.lookDelta[1] * this.mouseScale(), -0.35, 0.8);
    } else if (it.device === 'keyboard') this.aimPitch = damp(this.aimPitch, 0.08, 3, dt);
    const a = this.computeAim(v);
    v.gunAim = { x: this.aimPoint.x, y: this.aimPoint.y, z: this.aimPoint.z };
    const firing = it.rt > 0.5 || isHeld(it, Btn.RB);
    if (firing) {
      // Direction from the muzzle to where the reticle lands.
      const m = new THREE.Vector3();
      v.visual.muzzle.updateWorldMatrix(true, false);
      m.setFromMatrixPosition(v.visual.muzzle.matrixWorld);
      let dx = this.aimPoint.x - m.x;
      let dy = this.aimPoint.y - m.y;
      let dz = this.aimPoint.z - m.z;
      const l = Math.hypot(dx, dy, dz);
      if (l < 3) {
        dx = a.dx;
        dy = a.dy;
        dz = a.dz;
      } else {
        dx /= l;
        dy /= l;
        dz /= l;
      }
      if (v.fireGun(dt, [dx, dy, dz])) {
        this.cam.addShake(0.04);
        this.ctx.input.rumble(this.index, 0.1, 0.35, 40);
      }
    }
    if (wasPressed(it, Btn.Y)) this.exitVehicle(false);
    const slot = this.ctx.input.slots?.[this.index] ?? null;
    const exit = `${this.ctx.input.vehicleIsHold?.(this.index) ? 'hold ' : ''}${promptLabel(slot, 'Y')}`;
    this.prompt = { text: v.weapon ? `Gunner: ${promptLabel(slot, 'RT')} to fire, ${exit} to exit` : `Passenger: ${exit} to exit`, progress: -1, button: 'RT' };
    // Only show the hint briefly.
    if (this.ctx.time > 14) this.prompt = null;
  }

  // ------------------------------------------------------------------ downed / dead

  private updateDowned(dt: number, it: PlayerIntent) {
    const ctx = this.ctx;
    const bleed = ENEMIES.zombieRules.bleedOut * (ctx.campaign.stocks.medicine <= 0 ? 0.7 : 1);
    this.downT += dt;
    // Crawl slowly.
    const fx = Math.sin(this.aimYaw);
    const fz = Math.cos(this.aimYaw);
    const rx = -Math.cos(this.aimYaw);
    const rz = Math.sin(this.aimYaw);
    const vx = fx * it.move[1] + rx * it.move[0];
    const vz = fz * it.move[1] + rz * it.move[0];
    this.aimYaw -= it.look[0] * 1.6 * dt + it.lookDelta[0];
    this.moveSpeed = damp(this.moveSpeed, Math.hypot(vx, vz) * 0.9, 8, dt);
    if (this.moveSpeed > 0.1) this.yaw = dampAngle(this.yaw, Math.atan2(vx, vz), 6, dt);
    this.moveBody(dt, vx * 0.9, vz * 0.9);
    if (this.downT >= bleed) {
      this.state = 'dead';
      this.respawnT = 8;
      this.ctx.radio(`${this.name} bled out.`);
      this.note(this.partner ? 'You bled out. Respawning at the convoy for a Scrap fee…' : 'You bled out.', 'bad');
      return;
    }
    const left = Math.max(0, Math.ceil(bleed - this.downT));
    // Nobody can revive a lone player, so they get one chance: a medkit from the convoy's stores, applied by hand.
    if (!this.partner && ctx.campaign.items.medkit > 0) {
      this.selfReviveT = isHeld(it, Btn.A) ? this.selfReviveT + dt : Math.max(0, this.selfReviveT - dt * 2);
      if (this.selfReviveT >= SELF_REVIVE_SECONDS) {
        ctx.campaign.items.medkit--;
        this.revive(this.index);
        this.note('Medkit used. Get moving', 'good');
        return;
      }
      this.prompt = { text: `Hold to use a medkit (${ctx.campaign.items.medkit}) · bleeding out ${left}s`, progress: this.selfReviveT / SELF_REVIVE_SECONDS, button: 'A' };
      return;
    }
    this.prompt = { text: `Bleeding out: ${left}s`, progress: clamp(this.downT / bleed, 0, 1), button: 'A' };
  }

  private updateDead(dt: number) {
    this.respawnT -= dt;
    this.human.root.visible = false;
    const pt = this.partner;
    this.prompt = { text: `Respawn in ${Math.max(0, Math.ceil(this.respawnT))}s`, progress: -1, button: 'A' };
    if (this.respawnT <= 0) {
      // Respawn at the convoy: near the partner or the nearest convoy vehicle.
      const ref = pt && pt.alive ? pt.pos : this.ownVehicle ? this.ownVehicle.position : this.pos;
      const ang = Math.random() * Math.PI * 2;
      this.placeAt(ref.x + Math.cos(ang) * 3, ref.z + Math.sin(ang) * 3, this.yaw);
      this.state = 'foot';
      this.hp = this.maxHp * 0.5;
      this.invuln = 2;
      const fee = Math.min(10, this.ctx.campaign.stocks.scrap);
      this.ctx.campaign.stocks.scrap -= fee;
      this.note(`Back on your feet (-${fee} Scrap)`, 'warn');
    }
  }

  // ------------------------------------------------------------------ camera & visuals

  /** Called every render frame, after the visuals are synced, with the same interpolation alpha. */
  renderCamera(alpha: number, dt: number) {
    const v = this.vehicle;
    let mode: CamMode = 'foot';
    let target = {
      x: lerp(this.prevPos.x, this.pos.x, alpha),
      y: lerp(this.prevPos.y, this.pos.y, alpha),
      z: lerp(this.prevPos.z, this.pos.z, alpha),
      yaw: this.yaw,
      speed: 0,
      topSpeed: 10,
    };
    // The blueprint says 3.2 m / 1.6 m, but on a 3.5:1 strip that fills most of the height. Pulled back so it reads.
    let dist = 4.9;
    let height = 2.15;
    // Under a roof line the camera closes in and rises, so the room can be seen into over the walls.
    if (this.state === 'foot' && this.ctx.interiorAt?.(target.x, target.z, target.y)) {
      dist = 3.3;
      height = 3.0;
    }
    if (this.state === 'driving' && v) {
      mode = 'vehicle';
      // Follow the interpolated mesh so the camera and the vehicle share one pose.
      const p = v.visual.root.position;
      _camE.setFromQuaternion(v.visual.root.quaternion, 'YXZ');
      target = { x: p.x, y: p.y, z: p.z, yaw: _camE.y, speed: Math.abs(v.speed), topSpeed: v.topSpeed };
      dist = v.def.camera.dist * (this.camFar ? 1.35 : 1);
      height = v.def.camera.height * (this.camFar ? 1.3 : 1);
    } else if (this.state === 'gunner' && v) {
      mode = 'gunner';
      v.visual.root.updateMatrix();
      const gp = v.def.gunner ?? [0, 0.2, -0.95];
      _v.set(gp[0], gp[1], gp[2]).applyMatrix4(v.visual.root.matrix);
      target = { x: _v.x, y: _v.y - 1.0, z: _v.z, yaw: v.yaw, speed: Math.abs(v.speed), topSpeed: v.topSpeed };
      dist = 4.4;
      height = 1.9;
    } else if (this.state === 'downed' || this.state === 'dead') {
      mode = 'downed';
    }
    // Mouse movement not yet consumed by a 60 Hz tick is applied here so the view turns every frame.
    let aimYaw = this.aimYaw;
    let aimPitch = this.aimPitch;
    const first = this.firstPerson;
    const mouseAim = this.intent.mouse && (this.state === 'foot' || this.state === 'gunner');
    const pend = this.intent.mouse && (mouseAim || (first && this.state === 'driving')) ? this.ctx.input.pendingLook(this.index) : null;
    if (mouseAim && pend) {
      const k = this.mouseScale();
      aimYaw -= pend[0] * k;
      aimPitch = clamp(aimPitch + pend[1] * k, first ? -1.3 : -0.55, first ? 1.3 : 0.8);
    }
    let lookYaw = -this.lookIn[0] * 1.1;
    let lookPitch = this.lookIn[1];
    let eye: THREE.Vector3 | null = null;
    if (first) {
      eye = this.eyePosition(alpha, dt, target);
      if (this.state === 'driving') {
        lookYaw = this.driveLook[0] - (pend ? pend[0] : 0);
        lookPitch = clamp(this.driveLook[1] + (pend ? pend[1] : 0), -0.75, 0.75);
      }
    }
    this.cam.update(dt, target, mode, {
      dist,
      height,
      crisp: mouseAim,
      aimYaw,
      aimPitch,
      lookYaw,
      lookPitch,
      shoulder: this.shoulder,
      lookBack: this.lookBack,
      zoom: this.ads,
      eye,
    });
  }

  private _eye = new THREE.Vector3();

  /**
   * Where the first-person camera sits. On foot it is a fixed height over the feet, eased for crouching and swimming,
   * so it does not bob with the walk cycle. Seated, it is the actual head of the driver or gunner, so it sits where
   * the cab or the saddle puts it.
   */
  private eyePosition(alpha: number, dt: number, target: { x: number; y: number; z: number }): THREE.Vector3 {
    void alpha;
    const e = this._eye;
    const v = this.vehicle;
    const head = this.state === 'driving' ? v?.visual.driver?.head : this.state === 'gunner' ? v?.visual.passenger?.head : null;
    if (head && v) {
      head.updateWorldMatrix(true, false);
      e.setFromMatrixPosition(head.matrixWorld);
      // Eyes sit a little above and in front of the head's pivot.
      e.y += 0.1;
      return e;
    }
    if (this.state !== 'foot') return e.set(target.x, target.y + 1.5, target.z);
    const want = this.swimming ? EYE_SWIM : this.crouch ? EYE_CROUCH : EYE_STAND;
    this.eyeH = damp(this.eyeH, want, 14, dt);
    // A hair forward of the neck so the near plane stays clear of the shoulders.
    return e.set(target.x + Math.sin(this.aimYaw) * 0.08, target.y + this.eyeH, target.z + Math.cos(this.aimYaw) * 0.08);
  }

  /**
   * Hide what this seat's own first-person camera sits inside: the body on foot, the occupant in a seat.
   * Called just before the owner's view draws; `endOwnView` puts it back for the partner's view and the next frame.
   */
  beginOwnView() {
    if (!this.firstPerson) return;
    if (this.state === 'foot') this.human.setFirstPerson(true);
    const v = this.vehicle;
    const occ = this.state === 'driving' ? v?.visual.driver : this.state === 'gunner' ? v?.visual.passenger : null;
    if (occ) {
      this.hiddenOcc = occ;
      this.hiddenOccWas = occ.root.visible;
      occ.root.visible = false;
    }
  }

  endOwnView() {
    this.human.setFirstPerson(false);
    if (this.hiddenOcc) {
      this.hiddenOcc.root.visible = this.hiddenOccWas;
      this.hiddenOcc = null;
    }
  }

  /** Called every render frame. */
  syncVisual(alpha: number, dt: number) {
    const h = this.human;
    const showOnFoot = this.state === 'foot' || this.state === 'downed' || this.state === 'entering';
    h.root.visible = showOnFoot;
    if (!showOnFoot) return;
    const x = lerp(this.prevPos.x, this.pos.x, alpha);
    const y = lerp(this.prevPos.y, this.pos.y, alpha);
    const z = lerp(this.prevPos.z, this.pos.z, alpha);
    h.root.position.set(x, y, z);
    h.root.rotation.y = this.yaw;
    let aim = this.equip === 'pistol' ? clamp(this.ads + (this.muzzleT > 0 ? 0.7 : 0), 0, 1) : 0;
    const weapon = this.equip === 'pistol' ? 'pistol' : this.equip === 'wrench' ? 'wrench' : this.equip === 'crowbar' ? 'crowbar' : this.equip === 'jerrycan' ? 'jerrycan' : this.utility === 'charge' ? 'none' : this.utility === 'horn' ? 'none' : 'flare';
    h.setWeapon(this.state === 'downed' || this.carry ? 'none' : (weapon as 'pistol'));
    // First person: whatever is in hand is held up in front, where the camera can see it.
    if (this.firstPerson && !this.carry && weapon !== 'none') aim = Math.max(aim, 0.75);
    this.syncCarryModel();
    h.update(dt, this.state === 'downed' ? 'downed' : 'stand', this.moveSpeed, aim, this.crouch ? 1 : 0, this.aimPitch);
    h.muzzle(this.muzzleT > 0.05);
    if (this.invuln > 0) h.root.visible = Math.floor(this.invuln * 12) % 2 === 0;
  }

  private carryKey = '';

  /** Show what is in the arms, rebuilding the model only when it changes kind. */
  private syncCarryModel() {
    const c = this.carry;
    const key = !c ? '' : c.kind === 'part' ? `part${partDef(c.item.id).mk}` : c.kind;
    if (key === this.carryKey) return;
    this.carryKey = key;
    this.human.setCarry(key ? makeCarryModel(key) : null);
  }

  destroy() {
    returnCarry(this);
    this.ctx.P.world.removeCollider(this.collider, false);
    this.ctx.P.world.removeRigidBody(this.body);
    this.ctx.P.world.removeCharacterController(this.kcc);
    this.human.root.removeFromParent();
    this.human.dispose();
  }
}

function it0(v: number) {
  return v;
}

function wasPressedOrFresh(it: PlayerIntent) {
  return (it.pressed & (1 << Btn.A)) !== 0 || it.heldTime[Btn.A] < 0.4;
}

export function utilityName(u: Utility) {
  return u === 'flare' ? 'Flare' : u === 'molotov' ? 'Molotov' : u === 'charge' ? 'Breaching charge' : 'Decoy horn';
}

export type InteractableLike = Interactable;
