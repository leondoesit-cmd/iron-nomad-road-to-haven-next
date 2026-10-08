import { crossedHandlingEvents, reloadSounds, weaponHandling, type HandlingEvent } from '../audio/weaponAcoustics';
import * as THREE from 'three';
import { RAPIER, GROUPS, G, groups, type Collider, type RigidBody } from '../physics/physics';
import { Btn, NAV, heldFor, isHeld, wasPressed, wasReleased, type PlayerIntent } from '../input/intents';
import { promptLabel } from '../input/input';
import { ChaseCamera, type CamMode } from '../render/camera';
import { Humanoid, type Held, type Palette } from '../render/humanoid';
import { ViewModel } from '../render/viewmodel';
import { identityOf, lookOf } from '../render/outfit';
import { HERO_LOOKS } from '../render/heroLooks';
import { makeCarryModel } from '../render/props';
import { PLAYER_COLORS } from '../render/palette';
import { angleDiff, clamp, damp, dampAngle, lerp, wrapAngle } from '../core/math';
import type { Aabb } from '../world/layout';
import { ENEMIES, gearDef, partDef, t, type HeroId } from '../data';
import { roadX } from '../world/terrain';
import { steerTo, newSteerState } from './aiDrive';
import { applyRepair, planRepair } from '../sim/repair';
import { STRAIGHT } from '../sim/bodywork';
import { SALVAGE_STAGES } from '../sim/salvage';
import { costText, spend, whole } from '../sim/resources';
import { DRUGS, DRUG_IDS, type DrugEvent, type DrugId, type DrugState } from '../sim/drugs';
import { BLEED, STAMINA, bind, bleedLabel, canSprint, jamChance, newBleed, newStamina, openWound, spendStamina, tickBleed, tickStamina, wearBy, WEAR, wearDamage, wearSpread, woundChance } from '../sim/vitals';
import { VENOM, bindVenom, cureVenom, drawVenom, envenom, newVenom, tickVenom, venomLabel, venomSlow, type SnakeBite } from '../sim/venom';
import { NEEDS, NEUTRAL_NEEDS, NEED_ACTS, canRelieve, isNeedAct, drink as drinkWater, eat as eatFood, needMods, reliefSeconds, relieve, tickNeeds, warnText, type NeedAct, type NeedEvent, type NeedMods, type Needs } from '../sim/needs';
import { ammoForGun, cutOf } from '../sim/ballistics';
import { canLoose, holdCost, holdShake, loosePower, newDraw, slack, stepDraw } from '../sim/archery';
import { HANDLING, kickVelocity, spring, stepSpring, swayAt, type Handling, type Spring } from '../sim/handling';
import { ACCEL, READY, SPRINT_IN, SPRINT_OUT, WALL_BLOCK, REACH, approachVelocity, carryOf, drawLow, drawOf, landGait, leanTarget, newGait, newGaitOut, newLean, stepBlend, stepGait, stepLean, wallBlend } from '../sim/gait';
import { DROPS_MAG, RELOAD_KIND, curve, cycleRack, cycleTime, dropAt, newGunPose, reloadPose } from '../sim/weaponanim';
import { HABIT, pickFault, pickHabit, type Cue, type Drill, type Fault } from '../sim/gunDrills';
import { FLASH_SECS, MUZZLE, bloomAfterShot, bloomSettle, meleeFeel, reloadPlan, swingArc, type MeleeFeel, type MeleeKind } from '../sim/weaponfx';
import type { ShellKind } from '../render/brass';
import { GunBeam } from '../render/gunBeam';
import { kitOf, lookKey, type GunKit } from '../sim/gunmods';
import type { DriveInput } from '../physics/vehicle';
import type { Ctx } from './ctx';
import type { WaterKind } from '../world/lakes';
import type { WaterSource } from '../sim/needs';
import type { Pilot, Vehicle } from './vehicle';
import type { Interactable } from './interact';
import { carryModelKey, carrySlow, type Carried } from '../sim/carry';
import { canRidePassenger } from '../sim/cabin';
import { SWIM, diveRate, newBreath, stepBreath, swimSpeed } from '../sim/swim';
import { UTILITY_SLOT, damageTaken, effectiveGun, effectiveMelee, heldItem, statsOf, stepSel, type EffectiveGun, type GearItem, type HurtKind, type Loadout, type Resolved } from '../sim/gear';
import type { GunModel, MeleeStats } from '../data';
import { OIL_LOW, pourOil } from '../sim/oil';
import { wrenchCandidate } from './carwork';
import { storageInput, storageKey, storagePrompt } from './storage';
import { carLookTick } from './carLook';
import { goLine, panelCand, panelCandidate, placeFor, pointPos, toLocal } from './access';
import { accessPointsOf } from '../render/accessPoints';
import { COOLANT_LOW, WATER_CAN, WATER_RESERVE_MAX, pourWater } from '../sim/fluids';
import { TANK_DREGS, addReserve, planDrain, reserveOf, takeReserve } from '../sim/fuel';
import { dropCarry, guide, sitePos, haulCandidate, haulKey, haulPrompt, pryCandidate, returnCarry, stashBeforeEntering } from './hauling';
import { disposeHold, eatCarried, holdFloats, holdFrame, holdTick, lookTick, newHold, type HandHint, type LookInfo } from './grab';
import { eatWildShroom, stepWildLot, wildLot } from './wildShrooms';

/** Jobs done by hand on a car's own parts: doing one to an abandoned car makes it the convoy's. */
const HANDS_ON = new Set(['unbolt', 'fit', 'lift', 'liftdeck', 'oil', 'fuel', 'pry', 'water', 'spray']);

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
  /** Where in the world the hands are at work while this runs, so the body can reach for it. */
  at?: THREE.Vector3;
}

/** Eye height above the feet on foot: standing, crouched, and treading water. */
const EYE_STAND = 1.62;
/** Seconds a shot holds the gun up in the aim and shows the muzzle flash at its start. */
const MUZZLE_T = 0.12;
/** Share of the way through nocking at which the new arrow is on the string. */
const NOCK_SHOWS = 0.65;
const EYE_CROUCH = 1.18;

/** Solo: how long a downed player holds A to patch themselves up. */
const SELF_REVIVE_SECONDS = 3.4;

export type PState = 'foot' | 'entering' | 'driving' | 'gunner' | 'downed' | 'dead';
/** What the hands are doing: a firearm, a melee weapon, one of the three tools, or the throwable. Set from the belt. */
export type Equip = 'gun' | 'melee' | 'wrench' | 'crowbar' | 'jerrycan' | 'utility';
export type Utility = 'flare' | 'charge' | 'molotov' | 'horn';
export const UTILITIES: Utility[] = ['flare', 'molotov', 'charge', 'horn'];
/**
 * What the quick belt (hold the use button) holds: field dressings first, then the drugs, the wild mushrooms nobody knows yet
 * (`wildShrooms.ts`), then the body's own chores.
 */
export type QuickId = 'bandage' | 'medkit' | DrugId | 'wild' | NeedAct;
export const QUICK: QuickId[] = ['bandage', 'medkit', ...DRUG_IDS, 'wild', ...NEED_ACTS];
const isDrugId = (id: QuickId): id is DrugId => (DRUG_IDS as string[]).includes(id);
/** Medkits heal this much, from the belt or the inventory. */
export const MEDKIT_HEAL = 60;

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
  button: 'X' | 'Y';
  ok: boolean;
}

/** Seconds to climb into a vehicle: reach, step up, duck, sit. */
const ENTER_SECS = 0.8;
/** Pace of the walk to a car's door before the climb starts (m/s). */
const ENTER_WALK = 2.6;
/** How far the camera's glide into the eyes has to come before the body is hidden from its owner and the arms take over. */
const EYES_IN = 0.86;
/** Seats that have been told, this session, that the third-person view is for vehicles only. */
const viewTold = [false, false];
/** Seconds to climb out, a high five, and how long the map button is held to offer one. */
const EXIT_SECS = 0.55;
const FIVE_SECS = 1.3;
const FIVE_HOLD = 0.5;
const MAP_TAP = 0.45;
const WALK = 3.4;
const SPRINT = 5.9;
const CROUCH = 1.7;
const BODY_H = 1.7;
/** Jump: take-off speed (about 1 m of height at gravity 22), the grace after leaving a ledge, and how early a press still counts. */
const JUMP_V = 6.6;
const COYOTE = 0.1;
const JUMP_BUFFER = 0.12;
const BODY_R = 0.3;
/** Still water. */
const NO_DRIFT: readonly [number, number] = [0, 0];
/** Seconds the use button is held before the drug belt opens. */
const BELT_HOLD = 0.35;
const RAY_STATIC = groups(0xffff, G.STATIC | G.ROAD | G.VEHICLE | G.BUILD | G.FURN | G.LOOSE);
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _v6 = new THREE.Vector3();
const _camE = new THREE.Euler();

/** How long the finger stays up, and the chance of it once a fight is over. */
const FLIP_SECS = 2.2;
const FLIP_CHANCE = 0.35;
/** The sound each cue of a hand drill makes, for the gun in hand. */
const CUE_SOUND: Record<Cue, (h: ReturnType<typeof weaponHandling>) => { cue: HandlingEvent['cue']; bank?: string }> = {
  rack: (h) => ({ cue: h.rack }),
  click: () => ({ cue: 'weaponClick' }),
  handle: () => ({ cue: 'weaponHandle' }),
  slap: (h) => ({ cue: 'magIn', bank: h.magazineBank }),
  magOut: () => ({ cue: 'magOut' }),
  shell: () => ({ cue: 'shellInsert' }),
};
const habitGap = () => HABIT.gapMin + Math.random() * (HABIT.gapMax - HABIT.gapMin);

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
  /** Magnification of the view right now: 1 unless aiming through a scope. */
  zoomNow = 1;
  /** Laser dot and torch cone for the gun in hand, made when a light is first fitted. */
  private beam: GunBeam | null = null;
  /** The rude salute after a fight (see `stepFlip`): kills seen, time since the last, quiet so far, time left up, cooldown. */
  private flipKills = -1;
  private sinceKill = 99;
  private quietT = 0;
  private flipT = 0;
  private flipCd = 0;
  /**
   * The fault being cleared, while it is (it runs on the reload clock, so a fault blocks the trigger and the reload as a
   * reload does). And the habit the hands are playing at rest (see `stepHabit`): how far in, how much of it shows (it fades
   * out fast when something needs the hands), seconds to the next one and the last one played, and how long it has been calm.
   */
  private fault: Fault | null = null;
  private habit: Drill | null = null;
  private habitT = 0;
  private habitW = 0;
  habitIn = habitGap();
  private habitLast = '';
  private calmT = 0;
  /** Aim-down-sights as a spring: it comes up with the weight of the gun and can overshoot a hair. */
  private adsS: Spring = spring();
  /** What the last shots threw at the view. Each channel is its own spring, so it snaps up fast and settles. */
  readonly kick = { pitch: spring(), yaw: spring(), roll: spring(), back: spring() };
  /** Barrel wander this tick, radians (yaw, pitch). */
  readonly sway: [number, number] = [0, 0];
  /** Empty cases waiting to leave the gun: a bolt or pump cycling, or a revolver or break-action opened at the reload. */
  private brassQ: { t: number; kind: ShellKind }[] = [];
  /** Rounds fired since the last reload, for guns that keep their empties until they are opened. */
  private spent = 0;
  crouch = false;
  grounded = true;
  /** Seconds since the feet last touched ground, and the time left on a buffered jump press. */
  private airT = 0;
  private jumpBuf = 0;
  /** Horizontal velocity carried through the air (steering only nudges it). */
  private hvx = 0;
  private hvz = 0;
  /** 0 on the ground, 1 in the air; eased so the tuck in the pose does not snap. */
  private airVis = 0;
  moveSpeed = 0;
  hp = 100;
  maxHp = 100;
  vehicle: Vehicle | null = null;
  ownVehicle: Vehicle | null = null;
  human: Humanoid;
  /** How this person looks right now: their hero and what they wear. Seats in vehicles draw them from it too. */
  palette: Palette;
  cam = new ChaseCamera();
  equip: Equip = 'gun';
  utility: Utility;
  /** What the gear adds up to: armour, speed, noise, reload and so on. Recomputed whenever the loadout changes. */
  stats: Resolved = statsOf({ worn: {}, belt: [], sel: 0, bag: [] });
  /** Seconds left in a melee swing animation, 1 to 0. */
  swingT = 0;
  /**
   * The inventory camera: a slow orbit round the survivor, so what they put on can be seen. `a` is the angle round them
   * and `side` shifts them off-centre, clear of the panel. The vectors are the eased camera, so it swings in smoothly.
   */
  showcase: { a: number; side: number; pos?: THREE.Vector3; look?: THREE.Vector3 } | null = null;
  /** Which item was in hand at the last `syncEquip`, so swapping one gun for another also cancels a reload. */
  private heldUid = '';
  /** Rounds when no gun is on the belt at all. Otherwise the rounds live on the gun, so each keeps its own magazine. */
  private looseMag = 12;
  reloadT = 0;
  /** The view's bob in time with the steps, and the dip of a landing. */
  readonly gait = newGait();
  private gaitOut = newGaitOut();
  /** Speed to the right of where the view faces (m/s), for leaning into a sidestep. */
  private strafeV = 0;
  /** The body leans into a sidestep and a turn: the first-person view rolls with it and the rig tilts. */
  readonly lean = newLean();
  private leanYaw = 0;
  private _vel: [number, number] = [0, 0];
  /** How far the gun is carried low for a sprint (0 to 1), and how far a wall in front has pushed it up. `wallRaw` is the unsmoothed reading the trigger goes by. */
  sprintBlend = 0;
  wallBlend = 0;
  private wallRaw = 0;
  /** A bow's string: how far it is drawn and how long full draw has been held. Letting go of a draw looses the arrow. */
  readonly bowString = newDraw();
  /** The trigger was drawing the string last tick; the arm gave out on this pull (the string stays down until it is let go). */
  private pulling = false;
  private armGave = false;
  /** A draw in progress: seconds left and how long it takes. */
  drawT = 0;
  private drawDur = 0.3;
  /** The gun lags behind a turn of the view, as springs. */
  private lag = { yaw: spring(), pitch: spring() };
  private prevAim: [number, number] | null = null;
  /** The reload's length, and how much of the reload pose is showing (eased in and out). */
  private reloadDur = 1;
  private reloadSoundEvents: HandlingEvent[] = [];
  private reloadBlend = 0;
  /** A pump or bolt being worked after a shot: seconds left, and the stroke's length. */
  private cycleT = 0;
  private cycleDur = 1;
  private pose = newGunPose();
  /** Whether this reload's empty magazine has dropped yet, and seconds of smoke still curling off the gun. */
  private magDropped = false;
  private smokeT = 0;
  private leisureIdle = 0;
  private doseLeisure: 'drink' | 'smoke' | null = null;
  private doseLeisureT = 0;
  /** Seconds per round while a gun is being loaded a round at a time (a pump); 0 when the reload takes the lot at once. */
  private loadEach = 0;
  /** How far sustained fire has opened the spread, as a share of the gun's own. It closes up between shots. */
  bloom = 0;
  /** A swing that has started but has not landed yet: the weapon is still coming round. */
  /** The fire trigger was down while RB was (keys and mouse press both for one shot). */
  private rbWithTrigger = false;
  private swingPend: { t: number; dmg: number; reach: number; yaw: number; feel: MeleeFeel; cut: number; model: MeleeKind } | null = null;
  /** The weapon of the swing in progress, for its streak, and how far it reaches. */
  private swingFeel: MeleeFeel | null = null;
  /** Seconds the swing animation runs, which is the weapon's own. */
  private swingDur = 0.28;
  /** Seconds the arm hangs on a blow that landed. */
  private hitStop = 0;
  fireCd = 0;
  meleeCd = 0;
  notes: Note[] = [];
  prompt: Prompt | null = null;
  /** What X does while the hands are full: stow at the car, or set down. */
  promptAlt: PromptAlt | null = null;
  /** What is in your hands: a part, a fuel can or an oil can. */
  carry: Carried | null = null;
  /** How what is in your hands is held out: how far, turned how, and where it would land (`game/grab.ts`). */
  hold = newHold();
  /** The label under the crosshair: what you hold, or what you are looking at. */
  lookInfo: LookInfo | null = null;
  /** The buttons that do something with it, listed down the side of the screen. */
  handHints: HandHint[] = [];
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
  /** Where the hands are working while a hold-action runs (null otherwise): the body reaches for it. */
  private workAt: THREE.Vector3 | null = null;
  /** A high five under way with a friend: who, which style, how far along. */
  private five: { t: number; style: 1 | 2 | 3; partner: Player; hit: boolean; lead: boolean } | null = null;
  private fiveSent = false;
  /** Visual only: climbing out of a vehicle. The player is already on foot; the body is eased from the seat to the ground. */
  private exitT = 0;
  private exitSeat = new THREE.Vector3();
  private enterFrom = new THREE.Vector3();
  /** Seconds of walking to the door before the climb proper starts. */
  private enterWalk = 0;
  private enterYaw = 0;
  private enterOpened = false;
  /** The climb in or out is onto a bike (astride) rather than into a cab. */
  private rideEnter = false;
  /** The door swung open for a climb out, shut again when the climb is done. */
  private exitDoor: { v: Vehicle; panel: 'doorL' | 'doorR' } | null = null;
  private exitYaw = 0;
  private enterTo: Vehicle | null = null;
  private enterSeat: 'driver' | 'gunner' = 'driver';
  bailHold = 0;
  private startNoteAt = -99;
  lookBack = false;
  camFar = false;
  /**
   * First person wanted in a vehicle (driving, at a gun, riding along); off, the chase camera. On foot the view is always
   * the eyes. See `firstPerson` for whether it applies right now.
   */
  viewFirst = false;
  /**
   * The scene is staging this player (the dawn report and the Ledger behind it, a photo): the camera is the scene's, and
   * the body is seen, so first person is off.
   */
  staged = false;
  /** Smoothed eye height above the feet, so crouching and swimming ease the first-person camera. */
  private eyeH = EYE_STAND;
  /** How much taller (or shorter) this hero stands than the stock rig: their eyes are that much higher in first person. */
  private get tall(): number {
    return HERO_LOOKS[this.hero].scale;
  }
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
  /** Wind for sprinting, jumping and swinging. Not saved: a night's rest always refills it. */
  stamina = newStamina();
  /** Open wounds. They drain health until they clot or are bound. */
  bleed = newBleed();
  /** Snake venom working in you (`sim/venom.ts`). */
  venom = newVenom();
  /** Set while the quick belt rests on anything but a drug; null means it rests on `drugs.selected`. */
  private dressingSel: Exclude<QuickId, DrugId> | null = null;
  /** What hunger, thirst and a full bladder are doing to you right now, refreshed every tick. */
  nm: NeedMods = { ...NEUTRAL_NEEDS };
  /** A piss or a shit in progress. It runs on its own clock and walking off, firing or being hit cuts it short. */
  relief: { kind: 'piss' | 'shit'; t: number; dur: number; from: number; stained: boolean; wasCrouch: boolean } | null = null;
  private needSeed = 0x2545f491;
  private sprintingNow = false;
  /** A pad sprint click is a toggle (unless the control settings say hold): it stays on until you stop, aim, or run out of wind. */
  private sprintLatch = false;
  private sprintWas = false;
  private woundSeed = 0x9e3779b9;
  /** Seconds the use button has been down, to tell a tap (take) from a hold (open the belt). */
  private useHold = 0;
  /** The drug belt is open: the hands are in the pockets, and the feet stay put. */
  beltOpen = false;
  private poisonT = 0;
  /** Seconds left retching, or otherwise out of it. No moving, no shooting. */
  stunT = 0;
  /** A stumble in progress: sideways lurch, and which way. */
  private lurchT = 0;
  private lurchDir = 1;
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
  /** Swimming: whether a duck under is wanted, how far under the afloat height the body is (m), and how far under that is (0..1). */
  private diveWant = false;
  private swimLie = 0;
  diveY = 0;
  diveK = 0;
  /** Afloat with the head under: the view drowns in water, and the lungs run down. */
  underwater = false;
  /** The air in the lungs (see `sim/swim`). */
  readonly breath = newBreath();
  private breathNote = 0;
  private splashT = 0;
  /** The water's own current where you are (m/s), and what kind of water it is. */
  private waterFlow: [number, number] | null = null;
  private waterKind: WaterKind | null = null;
  /** The highest running water under you lately, and when: a sudden drop below it is a waterfall gone over. */
  private riverTop = -Infinity;
  private riverTopT = -99;
  private plungeT = -99;
  private currentWarnT = -99;
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
    this.viewFirst = ctx.input.settings.vehicleView?.[index] === 'first';
    this.palette = this.outfit();
    this.human = new Humanoid(this.palette);
    this.eyeH = EYE_STAND * this.tall;
    ctx.root.add(this.human.root);
    this.view = new ViewModel(this.outfit());
    ctx.root.add(this.view.root);
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
    // Walking into a loose prop (a tyre, a drum) shoves it, with a person's weight behind it.
    this.kcc.setApplyImpulsesToDynamicBodies(true);
    this.kcc.setCharacterMass(70);
    this.cam.occlude = (from, dir, maxDist) => {
      const r = ctx.P.raycast(from.x, from.y, from.z, dir.x, dir.y, dir.z, maxDist, groups(0xffff, G.STATIC | G.BUILD));
      return r ? r.toi : Infinity;
    };
    this.cam.groundAt = (x, z) => ctx.groundAt(x, z);
    this.refreshGear();
  }

  // ------------------------------------------------------------------ gear

  /** What this person wears, holds and carries. It lives in the campaign so it is saved and survives scene changes. */
  get gear(): Loadout {
    return this.ctx.campaign.players[this.index].gear;
  }

  /** Rounds in the gun in hand. */
  get mag(): number {
    const it = this.gunItem();
    if (!it) return this.looseMag;
    if (it.mag === undefined) it.mag = gearDef(it.id).gun!.mag;
    return it.mag;
  }
  set mag(v: number) {
    const it = this.gunItem();
    if (it) it.mag = v;
    else this.looseMag = v;
  }

  /** Who this seat plays: Chinsky, Leo or Nar. */
  get hero(): HeroId {
    return this.ctx.campaign.players[this.index].hero;
  }

  /** The palette for what is being worn right now. Anyone not in their own colours wears an armband in them. */
  private outfit(): Palette {
    const body = this.gear.worn.body;
    const own = !!body && !!gearDef(body.id).look?.tint;
    return { ...identityOf(this.index), look: lookOf(this.gear.worn), band: own ? undefined : PLAYER_COLORS[this.index], hero: this.hero };
  }

  /** Call after the loadout changes: restat, change clothes, and re-read what is in hand. */
  refreshGear() {
    this.stats = statsOf(this.gear);
    this.palette = this.outfit();
    this.human.dress(this.palette);
    this.view.dress(this.palette);
    this.syncEquip();
  }

  /** What the hands do follows the belt slot in hand. */
  syncEquip() {
    const g = this.gear;
    const it = heldItem(g);
    if (g.sel >= UTILITY_SLOT || !it) this.equip = 'utility';
    else {
      const d = gearDef(it.id);
      this.equip = d.kind === 'gun' ? 'gun' : d.kind === 'melee' ? 'melee' : d.tool!;
    }
    const uid = it?.uid ?? 'utility';
    if (uid !== this.heldUid) {
      const had = this.heldUid !== '';
      this.heldUid = uid;
      this.reloadT = 0;
      this.cycleT = 0;
      this.action = null;
      slack(this.bowString);
      this.pulling = false;
      // Bringing a new weapon up takes a moment, longer for a long gun; a gun cannot be fired until it is out.
      if (had) {
        this.drawDur = drawOf(this.heldModel());
        this.drawT = this.drawDur;
        this.ctx.audio.play('weaponHandle',this.pos.x,this.pos.z,.16,{pitch:this.equip==='gun' ? weaponHandling(this.gunModel()).pitch : 1});
        if (this.equip === 'gun') this.fireCd = Math.max(this.fireCd, this.drawDur);
      }
    }
  }

  /** Put a firearm in hand: the one already held if it is one, else the first on the belt. */
  equipGun() {
    const g = this.gear;
    const isGun = (b: GearItem | null | undefined) => !!b && gearDef(b.id).kind === 'gun';
    if (!(g.sel < UTILITY_SLOT && isGun(g.belt[g.sel]))) {
      const i = g.belt.findIndex(isGun);
      if (i >= 0) g.sel = i;
    }
    this.syncEquip();
  }

  /** The gun that `equip === 'gun'` fires: the one in hand, else the first on the belt. */
  private gunItem(): GearItem | null {
    const g = this.gear;
    const cur = g.sel < UTILITY_SLOT ? g.belt[g.sel] : null;
    if (cur && gearDef(cur.id).kind === 'gun') return cur;
    return g.belt.find((b) => !!b && gearDef(b.id).kind === 'gun') ?? null;
  }

  /** The gun in hand with its add-ons summed (zoom, kick, sway and the rest), cached until the gun or what is fitted changes. */
  private kitCache: { key: string; kit: GunKit; hd: Handling } | null = null;
  kit(): GunKit {
    return this.kitState().kit;
  }
  private kitState() {
    const it = this.gunItem();
    const key = `${it?.uid ?? ''}|${it?.id ?? ''}|${it?.att ? Object.values(it.att).join(',') : ''}`;
    if (this.kitCache?.key === key) return this.kitCache;
    const kit = kitOf(it);
    const base = HANDLING[gearDef(it?.id ?? 'w_pistol').gun!.model];
    // The stiffness of the aim spring is how fast the sights come up; the sway is the barrel's own wander.
    const hd: Handling = kit.count ? { ...base, adsK: base.adsK * kit.aimSpeed * kit.aimSpeed, sway: base.sway * kit.sway } : base;
    return (this.kitCache = { key, kit, hd });
  }

  /** Its numbers with this person's gloves and goggles and the fitted add-ons applied. With no gun at all, the starter pistol. */
  gun(): EffectiveGun {
    return effectiveGun(this.kitState().kit.gun, this.stats);
  }

  /** The melee weapon in hand, or null for bare hands. */
  private meleeWeapon(): MeleeStats | null {
    if (this.equip !== 'melee') return null;
    const it = heldItem(this.gear);
    return it ? (gearDef(it.id).melee ?? null) : null;
  }

  /** Damage of a swing with what is in hand, gloves included. */
  meleeDamage(): number {
    return effectiveMelee(this.meleeWeapon(), this.stats).dmg;
  }

  /** The model shown in the hand. */
  private heldModel(): Held {
    switch (this.equip) {
      case 'gun': {
        const it = this.gunItem();
        return gearDef(it?.id ?? 'w_pistol').gun!.model;
      }
      case 'melee':
        return this.meleeWeapon()?.model ?? 'none';
      case 'utility':
        return this.utility === 'charge' || this.utility === 'horn' ? 'none' : 'flare';
      default:
        return this.equip;
    }
  }

  /** The fitted add-ons of the gun in hand, as the key the model is drawn from. Empty for anything but a gun. */
  private heldMods(): string {
    return this.equip === 'gun' ? lookKey(this.gunItem()?.att) : '';
  }

  /** What is in hand, by name, for the HUD. */
  heldName(): string {
    if (this.equip === 'utility') return utilityName(this.utility);
    const it = heldItem(this.gear) ?? this.gunItem();
    return it ? gearDef(it.id).name : 'Bare hands';
  }

  /** What this body has taken, and what it is doing about it. It lives on the campaign, so it outlasts the scene. */
  get drugs(): DrugState {
    return this.ctx.campaign.drugs[this.index];
  }

  get needs(): Needs {
    return this.ctx.campaign.needs[this.index];
  }
  get targetable() {
    return (this.state === 'foot' || this.state === 'entering' || this.state === 'downed') && this.invuln <= 0;
  }
  get intent(): PlayerIntent {
    return this.ctx.input.intents[this.index];
  }
  /**
   * Whether this seat's camera is in first person right now. On foot it always is, except where the game frames the body
   * on purpose: the inventory's turntable, camp building, the title demo (autopilot), a staged scene, and lying out cold
   * (downed is its own low camera). In a seat it is the seat's choice (`viewFirst`). Climbing in and out is seen from behind.
   */
  get firstPerson(): boolean {
    if (this.showcase || this.autopilot || this.buildMode || this.staged) return false;
    if (this.state === 'foot') return !this.drugs.passedOut;
    return this.viewFirst && (this.state === 'driving' || this.state === 'gunner');
  }

  /**
   * First person and the camera has arrived at the eyes: the body is hidden from its owner and the arms and bodycam lens are
   * on. False for the moment the camera is still gliding in from a chase view, so the person is seen climbing out.
   */
  get viewEyes(): boolean {
    return this.firstPerson && this.cam.eyeBlend >= EYES_IN;
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
    // Slumped over the wheel, or heaving out of the window: no hands on anything.
    if (this.drugs.passedOut || this.stunT > 0) return { steer: 0, throttle: 0, brake: 0.25, handbrake: false };
    // Drunk driving: the wheel wanders.
    let steer = it.move[0];
    const sway = this.drugs.mods().sway + this.nm.sway;
    if (sway > 0.02) {
      const t = this.ctx.time + this.index * 7.3;
      steer = clamp(steer + (Math.sin(t * 1.1) + 0.6 * Math.sin(t * 2.7 + 0.9)) * 0.3 * sway, -1, 1);
    }
    return { steer, throttle, brake, handbrake: it.handbrake };
  }

  // ------------------------------------------------------------------ damage

  hurt(amount: number, fromX: number, fromZ: number, kind: HurtKind) {
    if (this.state === 'dead' || this.invuln > 0) return;
    const ctx = this.ctx;
    // What you wear takes a share of the hit: armour for blows, masks for spores, boots and knees for falls.
    const dmg = amount * ctx.campaign.difficulty.damage * damageTaken(this.stats, kind) * this.drugs.mods().damage;
    // Something hurts enough to wake you.
    if (dmg > 6 && this.drugs.passedOut) this.drugs.wake();
    this.sinceHit = 0;
    this.lastHurtDir = Math.atan2(fromX - this.pos.x, fromZ - this.pos.z);
    // Taking a hit interrupts hold actions such as repairs.
    if (this.action && this.action.kind !== 'revive' && kind !== 'spore') {
      this.action = null;
    }
    if (this.relief) this.endRelief('hit');
    if (this.state === 'downed') {
      // Hits on a downed player speed up the bleed-out.
      this.downT += dmg * 0.04;
      return;
    }
    if (this.inVehicle) return; // vehicle takes hits instead
    this.hp = Math.max(0, this.hp - dmg);
    if (this.hp > 0) this.maybeWound(dmg, kind);
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
    bind(this.bleed);
    cureVenom(this.venom);
    this.beltOpen = false;
    this.stunT = 0;
    this.state = 'downed';
    this.downT = 0;
    this.pinned = 0;
    this.action = null;
    this.equipGun();
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
    bind(this.bleed);
    cureVenom(this.venom);
    this.stamina.value = STAMINA.max * 0.5;
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
      } else if (v.driver !== this && v.faction === 'convoy' && v.def.seats >= 2 && !v.passenger && canRidePassenger(v.def, v.build?.fit ?? {}, v.weapon === 'bedMG')) {
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
    // A cab is entered by its door, on the side the player is on; anything else (a bike, a bed) is climbed onto from where they stand.
    const gate = this.doorGate(door.v, door.seat);
    this.enterYaw = this.yaw;
    this.rideEnter = door.v.def.tier === 1;
    this.enterOpened = false;
    this.enterWalk = gate ? Math.hypot(gate[0] - this.pos.x, gate[2] - this.pos.z) / ENTER_WALK : 0;
    this.action = null;
    return true;
  }

  /** The spot beside the door on the player's side that a cab is entered from, or null where there is no cab door to go to. */
  private doorGate(v: Vehicle, seat: 'driver' | 'gunner'): [number, number, number] | null {
    if (!v.seatFeet(seat)) return null;
    const side = toLocal(v, this.enterFrom.x, this.enterFrom.y, this.enterFrom.z)[0] >= 0 ? 1 : -1;
    const [x, , z] = v.doorPos(side);
    return [x, this.enterFrom.y, z];
  }

  /** The door on the side the player came in from. */
  private enterDoor(v: Vehicle): 'doorL' | 'doorR' {
    return toLocal(v, this.enterFrom.x, this.enterFrom.y, this.enterFrom.z)[0] >= 0 ? 'doorL' : 'doorR';
  }

  private finishEnter() {
    const v = this.enterTo;
    if (!v) {
      this.state = 'foot';
      return;
    }
    this.vehicle = v;
    // The door you climbed through swings shut behind you.
    if (v.build) v.setPanel(this.enterDoor(v), false);
    if (this.enterSeat === 'driver') {
      // Climbing into an abandoned car claims it for the convoy.
      if (v.faction === 'neutral') this.ctx.cars.claim(v, this);
      v.driver = this;
      this.ownVehicle = v.ownerIndex === this.index ? v : this.ownVehicle;
      this.state = 'driving';
      v.setEngine(true);
      if (v.startFail) this.note(v.startFail + (v.startFail.startsWith('Engine seized') ? ': equip the wrench' : ''), 'warn');
      if (v.stats.noSteer) this.note(t('car.noSteer'), 'warn');
      else if (v.stats.noDriverSeat) this.note(t('car.noSeat'), 'warn');
      if (this.ctx.night > 0.45) v.lights = true;
    } else {
      v.passenger = this;
      this.state = 'gunner';
    }
    this.equipGun();
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
    // Where the body sat, so it can be eased out of the seat rather than popping to the kerb.
    const who = this.state === 'driving' ? 'driver' : 'gunner';
    const feet = v.riderFeet(who);
    const seatW = feet ?? (who === 'driver' ? v.body.toWorld(0, -0.4, -0.1) : v.gunnerPos());
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
    this.exitDoor = null;
    this.rideEnter = v.def.tier === 1;
    if (!bail && !boat) {
      this.exitYaw = v.yaw;
      // Out of the door, facing away from the car.
      const ox = spot.x - seatW[0];
      const oz = spot.z - seatW[2];
      if (Math.hypot(ox, oz) > 0.3) this.yaw = Math.atan2(ox, oz);
      if (v.build && feet) {
        const panel = v.doorPos(1)[0] === spot.x && v.doorPos(1)[2] === spot.z ? 'doorL' : 'doorR';
        if (v.setPanel(panel, true)) this.exitDoor = { v, panel };
      }
      this.exitT = EXIT_SECS;
      this.exitSeat.set(seatW[0], feet ? seatW[1] : seatW[1] - 0.6, seatW[2]);
    } else this.exitT = 0;
    if (bail && speed > 3 && !boat) {
      const dmg = 10 + clamp(speed / 20, 0, 1) * 20;
      this.hurt(dmg, spot.x, spot.z, 'fall');
      this.note(`Bailed out at ${(speed * 3.6).toFixed(0)} km/h`, 'warn');
    }
  }

  // ------------------------------------------------------------------ high five

  private canFive() {
    return this.state === 'foot' && !this.five && !this.carry && !this.action && !this.drugs.passedOut && !this.swimming && this.grounded && this.ads < 0.3 && this.swingT <= 0 && !this.buildMode && !this.beltOpen && this.stunT <= 0;
  }

  /** Hold the map button next to a friend: the two turn to face each other and slap hands, in one of three styles. */
  private offerFive() {
    const others = this.ctx.players.filter((q) => q !== this && q.state !== 'dead');
    if (!others.length) return;
    if (!this.canFive()) return;
    let best: Player | null = null;
    let bd = 4.5;
    for (const q of others) {
      const d = Math.hypot(q.pos.x - this.pos.x, q.pos.z - this.pos.z);
      if (d < bd && Math.abs(q.pos.y - this.pos.y) < 1.2 && q.canFive()) {
        bd = d;
        best = q;
      }
    }
    if (!best) {
      this.note('No friend close enough for a high five', 'info');
      return;
    }
    const style = (1 + Math.floor(Math.random() * 3)) as 1 | 2 | 3;
    this.five = { t: 0, style, partner: best, hit: false, lead: true };
    best.five = { t: 0, style, partner: this, hit: false, lead: false };
    const name = style === 1 ? 'High five!' : style === 2 ? 'Fist bump!' : 'Double slap!';
    this.note(name, 'good');
    best.note(name, 'good');
  }

  private updateFive(dt: number) {
    const f = this.five;
    if (!f) return;
    const q = f.partner;
    const d = Math.hypot(q.pos.x - this.pos.x, q.pos.z - this.pos.z);
    // Over if either is hurt, driving off, or the two are pulled apart.
    if (this.state !== 'foot' || q.state !== 'foot' || q.five?.partner !== this || d > 6 || this.sinceHit < 0.15 || this.swimming) {
      this.five = null;
      return;
    }
    f.t += dt;
    const p = f.t / FIVE_SECS;
    // Square up to the friend, and close the gap to arm's length (each takes half).
    const toward = Math.atan2(q.pos.x - this.pos.x, q.pos.z - this.pos.z);
    this.yaw = dampAngle(this.yaw, toward, 14, dt);
    this.aimYaw = dampAngle(this.aimYaw, toward, 10, dt);
    if (d > 1.15 && p < 0.5) {
      const step = Math.min(d - 1.15, 2.4 * dt) * 0.5;
      this.pos.x += ((q.pos.x - this.pos.x) / d) * step;
      this.pos.z += ((q.pos.z - this.pos.z) / d) * step;
      this.body.setTranslation({ x: this.pos.x, y: this.pos.y + BODY_H / 2, z: this.pos.z }, true);
    }
    if (!f.hit && p >= 0.5) {
      f.hit = true;
      if (f.lead) {
        const ctx = this.ctx;
        const hx = (this.pos.x + q.pos.x) / 2;
        const hy = this.pos.y + (f.style === 2 ? 1.25 : 1.65);
        const hz = (this.pos.z + q.pos.z) / 2;
        ctx.fx.spark(hx, hy, hz, f.style === 2 ? 8 : 14, 3);
        ctx.fx.puff(hx, hy, hz, 0.9, 0.85, 0.7, 0.5, 0.4);
        ctx.audio.play(f.style === 2 ? 'thud' : 'hit', hx, hz, 0.35);
      }
    }
    if (f.t >= FIVE_SECS) this.five = null;
  }

  // ------------------------------------------------------------------ tick

  update(dt: number) {
    const ctx = this.ctx;
    // With a car's storage open (`storage.ts`) the panel has this seat's controls; the rest of the tick only sees looking.
    const it = storageInput(this, this.intent, dt);
    this.prevPos.copy(this.pos);
    if (this.hitCooldown > 0) this.hitCooldown -= dt;
    if (this.invuln > 0) this.invuln -= dt;
    this.sinceHit += dt;
    // The open big map takes the cursor's input before anything reads it (and, on foot, keeps the feet still): ui/mapnav.ts.
    if (this.mapMode > 0 && this.state !== 'dead') this.ctx.mapInput?.(this, it, dt);
    this.updateDrugs(dt, it);
    if (this.relief && this.state !== 'foot') this.endRelief('quiet');
    this.sprintingNow = false;
    for (const n of this.notes) n.t -= dt;
    while (this.notes.length && this.notes[0].t <= 0) this.notes.shift();
    this.commandWheel = isHeld(it, Btn.Up) && this.state !== 'dead';
    // On a pad the sheet shares its button with the view toggle, whose tap time has already been waited out by the hold.
    this.sheet = isHeld(it, Btn.Back) && (heldFor(it, Btn.Back) > 0.25 || !!this.ctx.input.sheetIsHold?.(this.index));
    const beltBusy = this.useHold > 0 || this.beltOpen;
    // The map button: a short tap steps the map; holding it offers a high five to a friend standing close.
    if (wasReleased(it, Btn.Map)) {
      if (!this.fiveSent && it.releasedAfter[Btn.Map] < MAP_TAP && !beltBusy && this.state !== 'dead') this.mapMode = (this.mapMode + 1) % this.ctx.mapModes;
      this.fiveSent = false;
    } else if (isHeld(it, Btn.Map) && !this.fiveSent && heldFor(it, Btn.Map) >= FIVE_HOLD) {
      this.fiveSent = true;
      if (!beltBusy) this.offerFive();
    }
    if (this.mapMode >= this.ctx.mapModes) this.mapMode = 0;
    if (wasPressed(it, Btn.Summon) && this.state !== 'dead') {
      if (this.ctx.summon) this.ctx.summon(this);
      else this.note('No ride to call here', 'info');
    }
    this.updateFive(dt);
    if (this.exitT > 0) {
      this.exitT = Math.max(0, this.exitT - dt);
      if (this.exitT <= 0 && this.exitDoor) {
        this.exitDoor.v.setPanel(this.exitDoor.panel, false);
        this.exitDoor = null;
      }
    }
    if (this.fireCd > 0) this.fireCd -= dt;
    if (this.meleeCd > 0) this.meleeCd -= dt;
    if (this.muzzleT > 0) this.muzzleT -= dt;
    if (this.hitStop > 0) this.hitStop -= dt;
    else if (this.swingT > 0) this.swingT = Math.max(0, this.swingT - dt / this.swingDur);
    this.updateSwing(dt);
    if (this.reloadT > 0) {
      const duration = this.loadEach>0 && this.reloadT<=this.loadEach ? this.loadEach : this.reloadDur;
      for (const event of crossedHandlingEvents(this.reloadSoundEvents,1-this.reloadT/duration,1-Math.max(0,this.reloadT-dt)/duration))
        this.ctx.audio.play(event.cue,this.pos.x,this.pos.z,event.volume,{bank:event.bank,pitch:event.pitch,intensity:.7});
      if (this.fault) this.faultEvents(1 - this.reloadT / duration, 1 - Math.max(0, this.reloadT - dt) / duration);
      this.reloadT -= dt;
      if (this.reloadT <= 0) this.finishReload();
    }
    this.updateHandling(dt);
    this.prompt = null;
    // A seated player must not collide: a kinematic capsule inside the cab would shove the chassis into the ground.
    const wantBody = this.state === 'foot' || this.state === 'downed';
    if (wantBody !== this.colliderOn) {
      this.body.setEnabled(wantBody);
      this.colliderOn = wantBody;
    }

    if (wasPressed(it, Btn.View) && !this.buildMode) {
      if (this.state === 'driving' || this.state === 'gunner') this.toggleView();
      else if (this.state === 'foot' && !viewTold[this.index]) {
        // On foot the view is always the eyes: say so once, the first time someone reaches for the switch.
        viewTold[this.index] = true;
        this.note('On foot you see through your own eyes. The view switches in a vehicle', 'info');
      }
    }
    if (wasPressed(it, Btn.Inventory) && !beltBusy) {
      if (this.state === 'foot') {
        this.action = null;
        this.ctx.openInventory?.(this);
      } else if (this.state === 'driving' || this.state === 'gunner') this.note('Get out of the vehicle to change your gear', 'info');
    }

    switch (this.state) {
      case 'foot':
        // Mid high five the feet stay put.
        this.updateFoot(dt, this.five ? { ...it, move: [0, 0] as [number, number], pressed: 0 } : it);
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
    this.updateVitals(dt);
    // The camera itself runs per render frame (renderCamera) so it follows the interpolated pose, not the 60 Hz physics one.
    this.lookIn[0] = it.look[0];
    this.lookIn[1] = it.look[1];

    // Signature meter for the HUD.
    this.signatureShown = this.currentSignature();
    if (this.state === 'foot' || this.state === 'downed') {
      const s = this.footSignature();
      if (s > 0) ctx.sig.emit(this.pos.x, this.pos.z, s * ctx.signatureMult * this.drugs.mods().noise, 'noise');
    }
  }

  /** Wind and wounds. Stims take the edge off a sprint, a heavy pack makes it worse. */
  private updateVitals(dt: number) {
    const living = this.state === 'foot' || this.state === 'driving' || this.state === 'gunner' || this.state === 'entering';
    if (!living) {
      this.stamina.value = STAMINA.max;
      this.stamina.winded = false;
      return;
    }
    const dm = this.drugs.mods();
    this.updateNeeds(dt, dm.appetite);
    const nm = this.nm;
    tickStamina(this.stamina, dt, {
      sprinting: this.sprintingNow,
      resting: this.moveSpeed < 0.5,
      drain: ((this.carry ? 1.4 : 1) / Math.max(0.7, dm.speed)) * nm.drain * (this.swimming ? 0.45 : 1),
      regen: (dm.speed > 1.05 ? 1.2 : 1) * nm.regen,
    });
    if (this.bleed.level > 0) {
      const loss = tickBleed(this.bleed, dt);
      // Bleeding hurts, but it never lands the killing blow on its own: you fall to 1 HP and the cut clots.
      this.hp = Math.max(1, this.hp - loss);
      if (this.hp <= 1.01) this.bleed.t += dt * 2;
    }
    // Venom can: it works on until it is drawn or spent, and it puts you down if there is not enough of you left.
    if (this.venom.dose > 0) {
      const pace = this.moveSpeed < 0.5 ? 0 : this.sprintingNow ? 2 : 1;
      this.hp = Math.max(0, this.hp - tickVenom(this.venom, dt, pace));
      if (this.hp <= 0) this.goDown();
    }
  }

  /**
   * A snake's bite: the fangs (an ordinary bite through whatever is on your legs), then the venom (none from a whip snake,
   * which only bites). The note says what to do.
   */
  snakeBite(kind: SnakeBite | 'whip', fromX: number, fromZ: number) {
    if (this.state !== 'foot' || this.invuln > 0) return;
    const fangs = kind === 'whip' ? 3 : VENOM[kind].bite;
    this.hurt(fangs, fromX, fromZ, 'bite');
    this.ctx.audio.play('yelp', this.pos.x, this.pos.z, 0.5);
    if (kind === 'whip') {
      this.note('Bitten by a whip snake: it hurts, but there is no venom', 'warn');
      return;
    }
    if (this.state !== 'foot') return;
    envenom(this.venom, kind);
    this.note(`Bitten by a ${VENOM[kind].name}! ${venomLabel(this.venom)}: keep still, bandage it, a medkit draws it`, 'bad');
  }

  /** A hit may open a wound. Armour turns some of them. Uses its own stream so it never shifts the world's dice. */
  private maybeWound(dmg: number, kind: HurtKind) {
    const chance = woundChance(kind, dmg, this.stats.armor);
    if (chance <= 0) return;
    this.woundSeed = (Math.imul(this.woundSeed, 1664525) + 1013904223) >>> 0;
    if (this.woundSeed / 4294967296 >= chance) return;
    if (openWound(this.bleed)) this.note(`${bleedLabel(this.bleed.level)}: bind it (${this.quickHint()})`, 'bad');
  }

  private quickHint(): string {
    return this.ctx.campaign.items.bandage > 0 ? 'bandage on the belt' : this.ctx.campaign.items.medkit > 0 ? 'use a medkit' : 'it will clot on its own';
  }

  /** The slot the quick belt rests on. */
  get quickSel(): QuickId {
    return this.dressingSel ?? this.drugs.selected;
  }

  /** Walk the quick belt a slot. Drugs stay in `drugs.selected`, so everything that reads it still agrees. */
  private stepQuick(dir: 1 | -1) {
    // The wild mushrooms' slot walks through its kinds before the belt moves on.
    if (this.quickSel === 'wild' && stepWildLot(this, dir)) return;
    let i = QUICK.indexOf(this.quickSel);
    let next = QUICK[(i = (i + dir + QUICK.length) % QUICK.length)];
    // The wild mushrooms' slot only stands on the belt while there are unknown mushrooms to eat.
    if (next === 'wild' && !wildLot(this)) next = QUICK[(i + dir + QUICK.length) % QUICK.length];
    if (!isDrugId(next)) this.dressingSel = next;
    else {
      this.dressingSel = null;
      this.drugs.selected = next;
    }
  }

  /** Bandage or medkit from the stores, in the field. Returns false when it did nothing. */
  useDressing(kind: 'bandage' | 'medkit'): boolean {
    const items = this.ctx.campaign.items;
    const hurt = this.hp < this.maxHp - 0.5;
    if (items[kind] <= 0) {
      this.note(`No ${kind}s left`, 'warn');
      this.ctx.audio.play('deny');
      return false;
    }
    const venom = this.venom.dose > 0;
    if (kind === 'bandage' && this.bleed.level <= 0 && !hurt && !venom) return this.note('You are not hurt', 'info'), false;
    if (kind === 'medkit' && !hurt && this.bleed.level <= 0 && !venom) return this.note('You are not hurt', 'info'), false;
    items[kind]--;
    // A pressure bandage over a bite slows the venom; a medkit draws most of it.
    if (venom) {
      if (kind === 'medkit') drawVenom(this.venom);
      else bindVenom(this.venom);
    }
    const closed = bind(this.bleed);
    const heal = kind === 'medkit' ? MEDKIT_HEAL : BLEED.bandageHeal;
    this.heal(heal);
    // Hands are busy for a moment, so dressing a wound mid-fight costs you the next shot.
    this.reloadT = 0;
    this.fireCd = Math.max(this.fireCd, kind === 'medkit' ? 1.2 : 0.7);
    this.meleeCd = Math.max(this.meleeCd, kind === 'medkit' ? 1.2 : 0.7);
    this.ctx.audio.play('pill', this.pos.x, this.pos.z, 0.5);
    if (venom) this.note(kind === 'medkit' ? `Medkit: venom drawn${this.venom.dose > 0 ? ` (${venomLabel(this.venom).toLowerCase()} still)` : ''}` : 'Pressure bandage: the venom spreads slower', 'good');
    else this.note(kind === 'medkit' ? `Medkit: +${heal} HP${closed ? ', bleeding stopped' : ''}` : closed ? 'Bandaged: bleeding stopped' : `Bandaged: +${heal} HP`, 'good');
    return true;
  }

  /** Tap on the quick belt: take whatever it rests on. */
  private useQuick() {
    const sel = this.quickSel;
    if (sel === 'bandage' || sel === 'medkit') this.useDressing(sel);
    else if (isNeedAct(sel)) this.doNeed(sel);
    else if (sel === 'wild') eatWildShroom(this);
    else this.takeDrug(sel);
  }

  /** Rest the quick belt on a slot (as if walked there), e.g. the wild mushrooms just picked. */
  selectQuick(id: QuickId) {
    if (!isDrugId(id)) this.dressingSel = id;
    else {
      this.dressingSel = null;
      this.drugs.selected = id;
    }
  }

  /** Eat, drink, piss or shit, from the belt or from its own key. Pressing piss or shit again stops one under way. */
  private doNeed(act: NeedAct) {
    if (this.relief) return void this.endRelief('moved');
    if (act === 'eat') this.eatRation();
    else if (act === 'drink') this.drinkUp();
    else this.startRelief(act);
  }

  /**
   * Taking drugs. Tap the use button to take the selected one; hold it to open the belt, then lean left or right to pick
   * (the feet stay put while the hands are in the pockets). Then the body does what the blood tells it to.
   */
  private updateDrugs(dt: number, it: PlayerIntent) {
    this.doseLeisureT = Math.max(0, this.doseLeisureT - dt);
    const d = this.drugs;
    const items = this.ctx.campaign.items;
    const living = this.state === 'foot' || this.state === 'driving' || this.state === 'gunner';
    const can = living && !this.buildMode && !d.passedOut && this.stunT <= 0;
    if (can) {
      // Food in hand (or lying where you look) is eaten first; otherwise a ration from the stores.
      if (wasPressed(it, Btn.Eat) && !eatCarried(this)) this.doNeed('eat');
      if (wasPressed(it, Btn.Drink)) this.doNeed('drink');
      if (wasPressed(it, Btn.Piss)) this.doNeed('piss');
      if (wasPressed(it, Btn.Shit)) this.doNeed('shit');
    }
    const down = can && isHeld(it, Btn.Down);
    if (down) {
      const was = this.useHold;
      this.useHold += dt;
      if (this.state === 'driving') {
        // The stick is steering, so a held button just walks the belt, a slot at a time.
        this.beltOpen = this.useHold >= BELT_HOLD;
        if (this.useHold >= 0.6 && Math.floor(this.useHold / 0.6) > Math.floor(was / 0.6)) this.stepQuick(1);
      } else if (this.useHold >= BELT_HOLD) this.beltOpen = true;
      if (this.beltOpen && this.state !== 'driving') {
        if (it.nav & NAV.left) this.stepQuick(-1);
        if (it.nav & NAV.right) this.stepQuick(1);
      }
    } else {
      if (can && this.useHold > 0 && !this.beltOpen && wasReleased(it, Btn.Down)) this.useQuick();
      this.useHold = 0;
      this.beltOpen = false;
    }
    d.update(dt);
    for (const e of d.takeEvents()) this.onDrugEvent(e);
    if (this.stunT > 0) this.stunT -= dt;
    if (this.lurchT > 0) this.lurchT -= dt;
    if (this.state === 'dead' || this.state === 'downed') return;
    const m = d.mods();
    if (m.regen > 0 && this.hp < this.maxHp && this.state === 'foot') this.heal(m.regen * dt);
    const shake = m.shake + this.nm.shake;
    if (shake > 0.05) this.cam.addShake(shake * 0.02 * dt * 60);
    if (m.poison > 0) {
      this.poisonT -= dt;
      if (this.poisonT <= 0) {
        this.poisonT = 0.5;
        this.hp = Math.max(0, this.hp - m.poison * 0.5);
        if (this.hp <= 0) this.goDown();
      }
    } else this.poisonT = 0;
  }

  /** Take one dose from the convoy's stores. */
  takeDrug(id: DrugId) {
    const items = this.ctx.campaign.items;
    const def = DRUGS[id];
    if (items[id] <= 0) {
      this.note(`No ${def.name.toLowerCase()} left`, 'warn');
      this.ctx.audio.play('deny');
      return false;
    }
    items[id]--;
    const r = this.drugs.dose(id);
    if (this.hero === 'iati' && (id === 'alcohol' || id === 'weed' || id === 'haze')) {
      this.doseLeisure = id === 'alcohol' ? 'drink' : 'smoke';
      this.doseLeisureT = id === 'alcohol' ? 3.6 : 4.4;
    }
    if (r.heal) this.heal(r.heal);
    this.ctx.audio.play(id === 'alcohol' || id === 'ayahuasca' ? 'gulp' : id === 'weed' || id === 'haze' ? 'toke' : 'pill', this.pos.x, this.pos.z, 0.5);
    this.note(`${def.name}: ${def.blurb}`, 'good');
    for (const n of r.notes) this.note(n, 'warn');
    if (r.relieved) this.note('The shakes ease off', 'info');
    if (!r.overdose && this.drugs.toxicity > 0.7) this.note('Your hands are shaking: one more could be too many', 'warn');
    return true;
  }

  // ------------------------------------------------------------------ eat, drink, piss, shit

  /** A uniform [0,1) from the body's own dice, so a bad mouthful never shifts the world's. */
  private rollNeed(): number {
    this.needSeed = (Math.imul(this.needSeed, 1664525) + 1013904223) >>> 0;
    return this.needSeed / 4294967296;
  }

  /** Hunger, thirst and the rest of it: tick the body, say what it wants, and work out what it does to you. */
  private updateNeeds(dt: number, appetite: number) {
    const n = this.needs;
    const effort = this.sprintingNow ? 1 : this.moveSpeed > 2.2 ? 0.25 : 0;
    for (const e of tickNeeds(n, dt, { appetite, effort, asleep: this.drugs.passedOut })) this.onNeedEvent(e);
    const nm = (this.nm = needMods(n));
    // Starving and parched hurt, but like a wound they never land the killing blow: health stops falling at a floor.
    if (nm.hurt > 0) {
      const floor = this.maxHp * NEEDS.hpFloor;
      if (this.hp > floor) this.hp = Math.max(floor, this.hp - nm.hurt * dt);
    }
  }

  private onNeedEvent(e: NeedEvent) {
    const ctx = this.ctx;
    const urgent = e.level === 'critical' || e.level === 'desperate';
    this.note(warnText(e.need, e.level), urgent ? 'bad' : 'warn');
    if (!ctx.campaign.flags['tip.needs']) {
      ctx.campaign.flags['tip.needs'] = true;
      ctx.tip('needs');
    }
  }

  /** Eat a ration from the convoy's stores. Your hands are busy for a moment, as with a dressing. */
  eatRation(): boolean {
    const ctx = this.ctx;
    const c = ctx.campaign;
    const r = eatFood(this.needs, whole(c.stocks.rations));
    if (!r.ok) {
      this.note(r.reason!, 'warn');
      ctx.audio.play('deny');
      return false;
    }
    c.stocks.rations = Math.max(0, c.stocks.rations - (r.spent ?? 1));
    this.reloadT = 0;
    this.fireCd = Math.max(this.fireCd, 1.1);
    this.meleeCd = Math.max(this.meleeCd, 1.1);
    ctx.audio.play('munch', this.pos.x, this.pos.z, 0.5);
    this.note(`You eat a ration (${whole(c.stocks.rations)} left)`, 'good');
    return true;
  }

  /**
   * Drink: from the water you are standing at if there is any (free, and not always clean: a spring always is, a swamp
   * seldom), else from the convoy's water reserve.
   */
  drinkUp(): boolean {
    const ctx = this.ctx;
    const c = ctx.campaign;
    const lake = this.state === 'foot' ? (ctx.waterAt(this.pos.x + Math.sin(this.aimYaw) * 1.2, this.pos.z + Math.cos(this.aimYaw) * 1.2) ?? ctx.waterAt(this.pos.x, this.pos.z)) : null;
    const source: WaterSource = lake?.kind ?? 'lake';
    const r = drinkWater(this.needs, c.items.water, { lake: !!lake, source, roll: this.rollNeed() });
    if (!r.ok) {
      this.note(r.reason!, 'warn');
      ctx.audio.play('deny');
      return false;
    }
    if (!lake) c.items.water = Math.max(0, c.items.water - (r.spent ?? 0));
    this.reloadT = 0;
    this.fireCd = Math.max(this.fireCd, 0.7);
    this.meleeCd = Math.max(this.meleeCd, 0.7);
    ctx.audio.play('gulp', this.pos.x, this.pos.z, 0.5);
    if (lake) this.note(rawDrinkText(source, lake.name, !!r.dirty), r.dirty ? 'warn' : 'good');
    else this.note(`You drink (${c.items.water.toFixed(0)} L left in the reserve)`, 'good');
    return true;
  }

  /** Stop and go. Takes a few seconds standing still (a squat for a shit), cut short by walking off, firing or being hit. */
  private startRelief(kind: 'piss' | 'shit'): boolean {
    const ctx = this.ctx;
    const deny = (why: string) => (this.note(why, 'info'), ctx.audio.play('deny'), false);
    if (this.state !== 'foot') return deny('Get out of the vehicle first');
    if (this.carry) return deny('Put down what you are carrying first');
    if (this.swimming) return deny('Not while you are swimming');
    const can = canRelieve(this.needs, kind);
    if (!can.ok) return deny(can.reason!);
    this.action = null;
    this.reloadT = 0;
    this.ads = 0;
    this.relief = { kind, t: 0, dur: reliefSeconds(this.needs, kind), from: kind === 'piss' ? this.needs.bladder : this.needs.bowel, stained: false, wasCrouch: this.crouch };
    if (kind === 'shit') this.crouch = true;
    ctx.audio.play('trickle', this.pos.x, this.pos.z, kind === 'piss' ? 0.4 : 0.15);
    ctx.sig.emit(this.pos.x, this.pos.z, kind === 'piss' ? 5 : 7, 'noise');
    this.note(kind === 'piss' ? 'You take a piss (walk away to stop)' : 'You squat and take a shit (walk away to stop)', 'info');
    return true;
  }

  private endRelief(why: 'done' | 'moved' | 'hit' | 'quiet') {
    const r = this.relief;
    if (!r) return;
    this.relief = null;
    if (r.kind === 'shit') this.crouch = r.wasCrouch;
    // Cut short after the first moment still leaves its mark.
    if (!r.stained && r.t > r.dur * 0.2) this.dropWaste(r.kind);
    if (why === 'quiet') return;
    const left = r.kind === 'piss' ? this.needs.bladder : this.needs.bowel;
    if (why === 'done') this.note(r.kind === 'piss' ? 'Ahh. That is better' : 'You feel lighter', 'good');
    else if (why === 'hit') {
      this.note('You are interrupted', 'bad');
      this.ctx.sig.emit(this.pos.x, this.pos.z, 14 * this.drugs.mods().noise, 'noise');
    } else if (left > 0.1) this.note(`You stop with some left (${Math.round(left * 100)}%)`, 'info');
  }

  /** The mark it leaves: ahead of you for a piss, just behind for a shit. Nothing in the water. */
  private dropWaste(kind: 'piss' | 'shit') {
    if (this.waterDepth > 0.15) return;
    const k = kind === 'piss' ? 0.8 : -0.4;
    this.ctx.gore.waste(this.pos.x + Math.sin(this.yaw) * k, this.pos.z + Math.cos(this.yaw) * k, kind);
    if (kind === 'shit') this.ctx.audio.play('plop', this.pos.x, this.pos.z, 0.3);
    if (this.relief) this.relief.stained = true;
  }

  /** One tick of a piss or a shit under way. Returns whether it still has the player rooted. */
  private updateRelief(dt: number, it: PlayerIntent): boolean {
    const r = this.relief;
    if (!r) return false;
    if (this.drugs.passedOut) {
      this.endRelief('quiet');
      return false;
    }
    if (Math.hypot(it.move[0], it.move[1]) > 0.55 || it.rt > 0.3 || it.lt > 0.3) {
      this.endRelief('moved');
      return false;
    }
    r.t += dt;
    relieve(this.needs, r.kind, (r.from / r.dur) * dt);
    this.moveSpeed = damp(this.moveSpeed, 0, 12, dt);
    if (!r.stained && r.t >= r.dur * 0.4) this.dropWaste(r.kind);
    if (r.kind === 'piss' && this.waterDepth < 0.6 && Math.floor(r.t * 14) > Math.floor((r.t - dt) * 14)) {
      const fx = Math.sin(this.yaw);
      const fz = Math.cos(this.yaw);
      this.ctx.fx.bloodSpray(this.pos.x + fx * 0.3, this.pos.y + 0.85, this.pos.z + fz * 0.3, fx, -0.35, fz, 1, 2.2, 0.08, [0.95, 0.85, 0.25]);
    }
    this.prompt = { text: `${r.kind === 'piss' ? 'Pissing' : 'Shitting'}… walk away to stop`, progress: clamp(r.t / r.dur, 0, 1), button: 'A' };
    if (r.t >= r.dur) {
      this.endRelief('done');
      return false;
    }
    return true;
  }

  /** Things the blood makes happen. */
  private onDrugEvent(e: DrugEvent) {
    switch (e.type) {
      case 'delayedDose':
        if (e.result.heal) this.heal(e.result.heal);
        this.note(`${e.source}: ${DRUGS[e.id].name} starts taking effect`, 'warn');
        for (const note of e.result.notes) this.note(note, 'warn');
        break;
      case 'vomit':
        this.vomit(e.purge);
        break;
      case 'stumble':
        this.lurchT = 0.45;
        this.lurchDir = e.dir;
        this.cam.addShake(0.25);
        this.ctx.sig.emit(this.pos.x, this.pos.z, 8 * this.drugs.mods().noise, 'noise');
        break;
      case 'outburst':
        this.outburst(e.kind, e.loud);
        break;
      case 'blackout':
        this.passOut();
        break;
      case 'wake':
        this.note('You come to', 'info');
        break;
      case 'surge':
        this.note('Everything turns up', 'warn');
        break;
      case 'paranoia':
        this.ctx.phantoms.startle(this);
        break;
      case 'blend':
        this.note(e.on ? `${e.name}: ${e.blurb}` : `${e.name} fades`, e.on ? 'good' : 'info');
        break;
      case 'overdose':
        this.note('Overdose: your body is shutting down', 'bad');
        break;
      case 'warn':
        this.note(e.text, 'warn');
        break;
    }
  }

  private vomit(purge: boolean) {
    if (this.state !== 'foot' && this.state !== 'driving' && this.state !== 'gunner') return;
    const ctx = this.ctx;
    if (this.relief) this.endRelief('quiet');
    this.stunT = purge ? 3 : 2.2;
    this.action = null;
    this.crouch = false;
    ctx.fx.blood(this.pos.x + Math.sin(this.yaw) * 0.5, this.pos.y + 1.2, this.pos.z + Math.cos(this.yaw) * 0.5, 7, [0.5, 0.58, 0.16]);
    ctx.audio.play('retch', this.pos.x, this.pos.z, 0.7);
    ctx.sig.emit(this.pos.x, this.pos.z, 26 * this.drugs.mods().noise, 'noise');
    this.cam.addShake(0.3);
    this.note(purge ? 'The vine takes it out of you' : 'You throw up', purge ? 'info' : 'warn');
  }

  private outburst(kind: 'laugh' | 'hiccup' | 'sing', loud: number) {
    const ctx = this.ctx;
    ctx.audio.play(kind, this.pos.x, this.pos.z, 0.6);
    ctx.sig.emit(this.pos.x, this.pos.z, loud * this.drugs.mods().noise, 'noise');
    this.cam.addShake(0.12);
    this.note(kind === 'laugh' ? 'You burst out laughing' : kind === 'hiccup' ? 'Hic' : 'You are singing. Loudly', 'warn');
  }

  private passOut() {
    if (this.relief) this.endRelief('quiet');
    this.action = null;
    this.crouch = false;
    this.stunT = 0;
    dropCarry(this);
    this.note('The floor comes up to meet you', 'bad');
  }

  /**
   * In a vehicle: switch between the chase camera and the eyes in the seat, and remember the choice (the vehicle camera
   * setting) for the next ride and the next run. On foot there is nothing to switch: it is always the eyes.
   */
  toggleView() {
    if (this.state !== 'driving' && this.state !== 'gunner') return;
    this.viewFirst = !this.viewFirst;
    const vv = this.ctx.input.settings.vehicleView;
    if (vv) vv[this.index] = this.viewFirst ? 'first' : 'third';
    this.ctx.input.onChange?.();
    this.driveLook[0] = this.driveLook[1] = 0;
    this.note(this.viewFirst ? 'Vehicle camera: first person' : 'Vehicle camera: third person', 'info');
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
    // Soft soles and a hood hush every step; plate and steel toes make more of it.
    const q = 1 + this.stats.noise;
    if (this.underwater) return (this.moveSpeed > 0.5 ? 4 : 1) * q;
    if (this.swimming) return (this.moveSpeed > 0.5 ? 16 : 5) * q;
    if (this.waterDepth > 0.3 && this.moveSpeed > 0.5) return 12 * q;
    if (this.moveSpeed > 4.5) return 20 * q;
    if (this.moveSpeed > 0.5) return (this.crouch ? 3 : 8) * q;
    return (this.crouch ? 2 : 3) * q;
  }

  currentSignature(): number {
    if (this.vehicle && (this.state === 'driving' || this.state === 'gunner')) return Math.round(this.vehicle.signature());
    return this.footSignature() + (this.muzzleT > 0 ? 60 * (this.equip === 'gun' ? this.kit().quiet : 1) : 0);
  }

  // ------------------------------------------------------------------ on foot

  /** Passed out cold: nothing works until you come round, or something hurts enough to wake you. */
  private updateAsleep(dt: number) {
    this.moveSpeed = damp(this.moveSpeed, 0, 10, dt);
    this.senseWater();
    this.moveBody(dt, 0, 0);
    this.prompt = { text: `Passed out… ${Math.ceil(this.drugs.blackout)}s`, progress: clamp(1 - this.drugs.blackout / 9, 0, 1), button: 'A' };
  }

  private updateFoot(dt: number, it: PlayerIntent) {
    const ctx = this.ctx;
    if (this.drugs.passedOut) return this.updateAsleep(dt);
    const dm = this.drugs.mods();
    // Retching, rummaging through the pockets for the next dose, or squatting: the hands and feet are busy.
    const busy = this.stunT > 0 || this.updateRelief(dt, it);
    this.updateAim(dt, it);
    // Movement relative to the camera.
    let mx = busy || this.beltOpen ? 0 : it.move[0];
    let my = busy || this.beltOpen ? 0 : it.move[1];
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
    // A drawn bow is held up like sights: no sprinting, a slow walk.
    const aiming = this.ads > 0.35 || this.bowString.k > 0.3;
    // Drunk: the body drifts sideways of where it is going, and a stumble throws it further.
    const swayNow = dm.sway + this.nm.sway;
    if (swayNow > 0.02 || this.lurchT > 0) {
      const t = ctx.time + this.index * 7.3;
      const drift = (Math.sin(t * 1.3) + 0.6 * Math.sin(t * 2.9 + 1.7)) * 0.55 * swayNow * Math.max(1, Math.hypot(wx, wz) * 3.4);
      const lurch = this.lurchT > 0 ? this.lurchDir * 3.2 * (this.lurchT / 0.45) : 0;
      wx += rx * (drift + lurch) * 0.3;
      wz += rz * (drift + lurch) * 0.3;
    }
    // On a pad one click of the sprint stick starts a sprint that lasts until you stop, so nobody has to hold a stick down
    // while steering with it. Keys keep the held shift.
    let sprintIn = it.sprint;
    if (it.device === 'pad' && this.ctx.input.settings.toggleSprint?.[this.index] !== false) {
      if (it.sprint && !this.sprintWas) this.sprintLatch = !this.sprintLatch;
      sprintIn = this.sprintLatch;
    }
    this.sprintWas = it.sprint;
    const wantSprint = !busy && sprintIn && my > 0.3 && !aiming && !this.crouch && this.equip !== 'jerrycan' && !this.carry && canSprint(this.stamina);
    // Crouch is a toggle on B (or hold, per the control settings), cancelled by sprint.
    if (this.ctx.input.settings.toggleCrouch?.[this.index] === false) this.crouch = isHeld(it, Btn.B);
    else if (wasPressed(it, Btn.B)) this.crouch = !this.crouch;
    if (wantSprint) this.crouch = false;
    else this.sprintLatch = false;
    if (this.relief?.kind === 'shit') this.crouch = true;
    // Water: wading drags at the legs, deep water means swimming (slow, no sprint, no crouch).
    this.senseWater();
    this.updateSwim(dt, it);
    if (this.swimming) this.crouch = false;
    const sprinting = wantSprint && this.waterDepth < 0.6;
    if (sprinting) this.sprintingNow = true;
    // A hard crawl at the surface costs stamina like a sprint does.
    const swimFast = this.swimming && wantSprint && this.diveK < 0.3;
    if (swimFast) this.sprintingNow = true;
    let speed = sprinting ? SPRINT : this.crouch ? CROUCH : WALK;
    // Out of breath, even a walk drags.
    if (this.stamina.winded) speed *= 0.82;
    if (this.waterDepth > 0.25) speed *= 1 - 0.42 * clamp((this.waterDepth - 0.25) / 0.9, 0, 1);
    if (this.swimming) speed = swimSpeed({ fast: swimFast, under: this.diveK > 0.5, winded: this.stamina.winded });
    speed *= venomSlow(this.venom);
    if (aiming) speed = Math.min(speed, 2.3);
    if (this.equip === 'jerrycan') speed *= 0.82;
    // A rifle is heavy to carry about, a knife is not.
    speed *= carryOf(this.heldModel());
    if (this.carry) speed *= carrySlow(this.carry);
    if (this.pinned >= ENEMIES.zombieRules.pinAt) speed = 0;
    // Fatigue from watch duty slows the next day; heavy gear slows you and light shoes quicken you.
    speed *= 1 - clamp(this.fatigue, 0, 0.2);
    speed *= 1 + this.stats.speed;
    speed *= dm.speed * this.nm.speed;
    // Tripping is floaty: the feet take longer to agree with the stick.
    this.moveSpeed = damp(this.moveSpeed, Math.hypot(wx, wz) * speed, 14 / (1 + dm.trip * 1.2), dt);
    const targetVx = wx * speed;
    const targetVz = wz * speed;
    // Facing: toward the aim when aiming or shooting, otherwise toward travel.
    // In first person the body always faces where the eyes look, so the arms stay in front of the camera.
    if (this.firstPerson) this.yaw = dampAngle(this.yaw, this.aimYaw, 20, dt);
    else if (aiming || this.muzzleT > 0 || isHeld(it, Btn.RT)) this.yaw = dampAngle(this.yaw, this.aimYaw, 16, dt);
    else if (mag > 0.15 && speed > 0) this.yaw = dampAngle(this.yaw, Math.atan2(targetVx, targetVz), 12, dt);
    // The body has weight: it takes a moment to get up to speed and a moment to stop, a sprint longest of all.
    let mvx = targetVx;
    let mvz = targetVz;
    if (this.grounded || this.swimming) {
      const o = approachVelocity(this.hvx, this.hvz, targetVx, targetVz, dt, sprinting ? ACCEL.sprint : this.crouch ? ACCEL.crouch : ACCEL.walk, ACCEL.brake, this._vel);
      mvx = o[0];
      mvz = o[1];
    }
    this.moveBody(dt, mvx, mvz);
    this.updateFeel(dt, sprinting);

    // Pin: break free with five left-stick rotations.
    if (this.pinned >= ENEMIES.zombieRules.pinAt) {
      this.pinBreak += it.stickLoops;
      if (this.pinBreak >= ENEMIES.zombieRules.pinBreakRotations) {
        this.pinBreak = 0;
        ctx.zombies.breakGrab(this);
        this.note('Broke free!', 'good');
      }
    } else this.pinBreak = Math.max(0, this.pinBreak - dt * 0.3);

    if (!busy) {
      this.updateTools(dt, it);
      this.updateInteractions(dt, it);
      this.updateJump(dt, it);
    }

    // Pick up swap: LB cycles equipment. With your hands full the wheel and LB move and turn what you hold (grab.ts).
    const toolStep = wasPressed(it, Btn.LB) ? 1 : it.toolStep;
    if (!busy && !this.buildMode && toolStep !== 0 && !this.carry) this.cycleEquip(toolStep > 0 ? 1 : -1);
    if (!this.carry && heldFor(it, Btn.X) > 0.6 && isHeld(it, Btn.X) && !this.action) {
      // hold X: swap utility item
      if (it.heldTime[Btn.X] < 0.6 + dt * 1.5 && it.heldTime[Btn.X] >= 0.6) this.cycleUtility();
    }
    if (wasPressed(it, Btn.R3)) this.cam.snap();
    // Y: enter / exit.
    if (!busy && wasPressed(it, Btn.Y)) {
      if (!this.tryEnter()) this.note('No vehicle in reach', 'info');
    }
    // Ground hazards: spore clouds are handled by the zombie system.
  }

  /**
   * What walking does to the view and the gun: the bob in time with the feet, the lean into a sidestep, the gun carried low
   * for a sprint, and a wall in front of the muzzle pushing it up. Runs on foot every tick.
   */
  private updateFeel(dt: number, sprinting: boolean) {
    const ctx = this.ctx;
    const speed = Math.hypot(this.hvx, this.hvz);
    const oldStep = Math.floor(this.gait.phase / Math.PI);
    stepGait(this.gait, dt, speed, sprinting, this.crouch, this.ads, this.grounded, this.gaitOut);
    if (this.grounded && !this.swimming && speed > 0.35 && Math.floor(this.gait.phase / Math.PI) !== oldStep) {
      const trees = ctx.treesNear?.(this.pos.x, this.pos.z, 3) ?? [];
      const floor = ctx.P.raycast(this.pos.x, this.pos.y + 0.3, this.pos.z, 0, -1, 0, 1, RAY_STATIC);
      const mat = floor ? ctx.P.surfaces.get(floor.collider.handle) : undefined;
      const cue = mat === 'wood' ? 'footWood' : mat === 'concrete' || mat === 'stone' ? 'footStone' : trees.length ? 'footGrass' : 'footSand';
      ctx.audio.play(cue, this.pos.x, this.pos.z, this.crouch ? 0.1 : sprinting ? 0.42 : 0.25, { intensity: this.crouch ? 0.15 : sprinting ? 1 : 0.45 });
      if (trees.length) ctx.audio.play('rustle', this.pos.x, this.pos.z, sprinting ? 0.25 : 0.12);
    }
    this.strafeV = this.hvx * -Math.cos(this.aimYaw) + this.hvz * Math.sin(this.aimYaw);
    // The body leans into a sidestep and into a turn of the view; in the air it carries on as it was.
    const turn = clamp(wrapAngle(this.aimYaw - this.leanYaw) / Math.max(dt, 1e-4), -8, 8);
    this.leanYaw = this.aimYaw;
    stepLean(this.lean, this.grounded || this.swimming ? leanTarget(this.strafeV, turn, speed, sprinting, this.ads) : this.lean.roll, dt);
    const gun = this.equip === 'gun' && !this.carry;
    this.sprintBlend = stepBlend(this.sprintBlend, sprinting && gun ? 1 : 0, SPRINT_IN, SPRINT_OUT, dt);
    if (!gun) {
      this.wallRaw = 0;
      this.wallBlend = damp(this.wallBlend, 0, 6, dt);
      return;
    }
    // A wall within the gun's length: the muzzle comes up and in, and with it against the wall the gun cannot be fired.
    const reach = REACH[this.gunModel()] ?? 0.8;
    const cp = Math.cos(clamp(this.aimPitch, -0.4, 0.4));
    const ex = this.pos.x;
    const ey = this.pos.y + (this.crouch ? EYE_CROUCH : EYE_STAND);
    const ez = this.pos.z;
    const hit = ctx.P.raycast(ex, ey, ez, Math.sin(this.aimYaw) * cp, Math.sin(clamp(this.aimPitch, -0.4, 0.4)), Math.cos(this.aimYaw) * cp, reach + 0.6, RAY_STATIC);
    this.wallRaw = hit ? wallBlend(hit.toi, reach) : 0;
    this.wallBlend = stepBlend(this.wallBlend, this.wallRaw, 10, 6, dt);
  }

  /**
   * Jump. A press is remembered for a moment and a ledge walked off still allows one, so it feels forgiving. On a pad the
   * button is shared with interact, so a press that has something to interact with is left to that.
   */
  private updateJump(dt: number, it: PlayerIntent) {
    this.jumpBuf = wasPressed(it, Btn.Jump) ? JUMP_BUFFER : Math.max(0, this.jumpBuf - dt);
    if (this.jumpBuf <= 0 || this.airT > COYOTE || this.vy > 1) return;
    if (this.swimming || this.carry || this.action || this.buildMode || this.pinned >= ENEMIES.zombieRules.pinAt) return;
    if (wasPressed(it, Btn.A) && this.prompt?.button === 'A') {
      this.jumpBuf = 0;
      return;
    }
    if (this.stamina.winded) {
      this.jumpBuf = 0;
      return;
    }
    this.jumpBuf = 0;
    spendStamina(this.stamina, STAMINA.jump);
    this.vy = JUMP_V;
    this.airT = COYOTE + 1;
    this.grounded = false;
    this.crouch = false;
    this.ctx.audio.play('swing', this.pos.x, this.pos.z, 0.25);
  }

  /**
   * Swimming's own controls and lungs. The crouch button ducks under (a toggle, or a hold when crouch is set to hold) and jump
   * kicks for the surface. Ducked, looking down takes the swimmer deeper and up brings them back, at the speed they are going;
   * level, they hold their depth. Under, the air runs out in about half a minute and then the water hurts, though it never
   * finishes you off: it stops at a few health.
   */
  private updateSwim(dt: number, it: PlayerIntent) {
    const ctx = this.ctx;
    if (!this.swimming) {
      this.diveWant = false;
      this.diveY = Math.max(0, this.diveY - SWIM.rise * dt);
    } else {
      if (ctx.input.settings.toggleCrouch?.[this.index] === false) this.diveWant = isHeld(it, Btn.B);
      else if (wasPressed(it, Btn.B)) this.diveWant = !this.diveWant;
      if (wasPressed(it, Btn.Jump) && this.diveWant) this.diveWant = false;
      const reach = Math.max(0, this.waterDepth - 1.35);
      if (this.diveWant && reach < 0.3) {
        this.diveWant = false;
        this.note('Too shallow to dive', 'info');
      }
      if (this.diveWant) {
        this.diveY = clamp(this.diveY - diveRate(this.aimPitch, this.moveSpeed, this.diveY) * dt, 0, reach);
        // Looking up all the way back to the surface ends the dive.
        if (this.diveY < 0.02 && this.aimPitch > SWIM.dead) this.diveWant = false;
      } else this.diveY = Math.max(0, this.diveY - SWIM.rise * dt);
      this.diveY = Math.min(this.diveY, reach);
    }
    this.diveK = clamp(this.diveY / 0.5, 0, 1);
    const wasUnder = this.underwater;
    this.underwater = this.swimming && this.diveY > 0.3;
    if (this.underwater && !wasUnder) {
      ctx.audio.play('plunge', this.pos.x, this.pos.z, 0.25);
      ctx.fx.puff(this.pos.x, this.waterLevel + 0.05, this.pos.z, 0.92, 0.96, 1, 1.1, 0.8);
    }
    // The air: working hard empties the lungs quicker.
    const ev = stepBreath(this.breath, dt, this.underwater, 1 + clamp(this.moveSpeed / 4, 0, 0.6));
    if (ev.gasped) ctx.audio.play('gasp', this.pos.x, this.pos.z, 0.5);
    if (this.underwater) {
      this.breathNote -= dt;
      if (this.breath.air < 0.3 && this.breathNote <= 0) {
        this.breathNote = 4;
        this.note(this.breath.air <= 0 ? 'Out of air: surface now!' : 'Running out of air', 'bad');
      }
    }
    if (ev.hurt > 0 && this.state === 'foot') {
      const floor = this.maxHp * SWIM.drownFloor;
      if (this.hp > floor) this.hp = Math.max(floor, this.hp - ev.hurt * ctx.campaign.difficulty.damage);
      this.sinceHit = Math.min(this.sinceHit, 0.3);
    }
  }

  /**
   * What the water is doing where you are: how deep, where its surface is, which way it runs, and whether you are afloat.
   * In running water it also keeps the highest level under you of the last few seconds: come down more than a body's
   * height below it all at once and you have gone over a waterfall.
   */
  private senseWater() {
    const ctx = this.ctx;
    const wet = ctx.waterAt(this.pos.x, this.pos.z);
    this.waterDepth = wet ? wet.depth : 0;
    this.waterLevel = wet ? wet.level : 0;
    this.waterFlow = wet?.flow ?? null;
    this.waterKind = wet?.kind ?? null;
    this.swimming = this.waterDepth > (this.swimming ? 1.1 : 1.3);
    if (!wet || (wet.kind !== 'river' && wet.kind !== 'stream')) return;
    if (ctx.time - this.riverTopT > 3 || wet.level >= this.riverTop) {
      this.riverTop = wet.level;
      this.riverTopT = ctx.time;
    }
    // Only once the body has come down into the water: falling past the face of a tall one does not count yet.
    const drop = this.riverTop - wet.level;
    if (drop > 1.4 && this.pos.y < wet.level + 0.4 && (this.swimming || this.grounded)) {
      this.riverTop = wet.level;
      this.riverTopT = ctx.time;
      this.plunge(drop, ctx.time - this.plungeT < 3);
      this.plungeT = ctx.time;
    }
    // In the pull above a drop: say so while there is still a chance of the bank.
    const f = this.waterFlow;
    if (f && this.swimming && this.state === 'foot' && Math.hypot(f[0], f[1]) > 2.1 && ctx.time - this.currentWarnT > 8) {
      this.currentWarnT = ctx.time;
      this.note('The current has you: swim hard for the bank!', 'warn');
    }
  }

  /**
   * How the water moves you, in m/s. Running water carries a swimmer bodily and leans on a wader's legs, harder the deeper
   * and quicker it is; over a lip it takes the feet from under you. A lake only drifts a swimmer slowly toward its shore.
   */
  private currentDrift(): readonly [number, number] {
    const f = this.waterFlow;
    if (!f || this.waterDepth < 0.25 || this.inVehicle) return NO_DRIFT;
    const sp = Math.hypot(f[0], f[1]);
    let k: number;
    if (this.waterKind === 'lake') k = this.swimming ? 0.15 : 0;
    else if (this.swimming) k = 1;
    else {
      const lean = clamp((this.waterDepth - 0.3) / 0.9, 0, 1) * 0.45 * clamp((sp - 0.4) / 1.2, 0, 1);
      const swept = sp > 2.4 ? 0.55 * clamp((this.waterDepth - 0.2) / 0.4, 0, 1) : 0;
      k = Math.min(0.85, lean + swept);
    }
    return k > 0 ? [f[0] * k, f[1] * k] : NO_DRIFT;
  }

  /**
   * Over a waterfall. A short drop is a dunking and a fright; a tall one knocks the wind out of you and hurts. The pool under
   * a fall is deep, so it never kills: the blow stops well short of the last fifth of your health.
   */
  private plunge(drop: number, again: boolean) {
    const ctx = this.ctx;
    const x = this.pos.x;
    const z = this.pos.z;
    const k = clamp(drop / 30, 0, 1);
    for (let i = 0; i < 8 + 14 * k; i++) ctx.fx.puff(x + (Math.random() - 0.5) * 3, this.waterLevel + 0.1, z + (Math.random() - 0.5) * 3, 0.92, 0.96, 1, 1.4 + 2.6 * k, 1.1 + k);
    ctx.audio.play('plunge', x, z, 0.6 + 0.5 * k);
    ctx.sig.emit(x, z, 30 + 30 * k, 'noise');
    this.cam.addShake(0.2 + 0.5 * k);
    ctx.input.rumble(this.index, 0.4 + 0.6 * k, 0.7, 300);
    // A tall fall can be met in two stages (a ledge of water partway down): the second is the same fall, not a new one.
    const hard = again ? drop : drop - 4;
    if (hard > 0 && this.state === 'foot') {
      const dmg = Math.min(hard * 1.5, 40, Math.max(0, this.hp - this.maxHp * 0.2) * 0.5);
      if (dmg > 0.5) this.hurt(dmg, x, z, 'fall');
      this.stunT = Math.max(this.stunT, 0.5 + Math.min(1.5, drop * 0.05));
    }
    if (again) return;
    let name = '';
    for (const f of ctx.terrain?.hydro?.falls ?? []) if (Math.hypot(f.x - x, f.z - z) < 30) name = f.name;
    this.note(name ? `Over ${name}!` : 'Over the falls!', drop > 4 ? 'bad' : 'warn');
  }

  private moveBody(dt: number, vx: number, vz: number) {
    const ctx = this.ctx;
    // Airborne, the feet cannot push: the take-off velocity carries, and the stick only bends it.
    if (this.grounded || this.swimming) {
      this.hvx = vx;
      this.hvz = vz;
    } else {
      this.hvx = damp(this.hvx, vx, 4, dt);
      this.hvz = damp(this.hvz, vz, 4, dt);
      vx = this.hvx;
      vz = this.hvz;
    }
    this.vy -= 22 * dt;
    if (this.vy < -30) this.vy = -30;
    const fallV = this.vy;
    let desired = { x: vx * dt, y: this.vy * dt, z: vz * dt };
    if (this.swimming) {
      // Afloat: no gravity, ease toward the surface so the head stays out and the body bobs a little. Ducked under, it holds
      // the depth the dive has taken it to instead.
      this.vy = 0;
      const target = this.waterLevel - 1.2 - this.diveY + Math.sin(ctx.time * 2.2 + this.index) * 0.04 * (1 - this.diveK);
      desired = { x: vx * dt, y: clamp((target - this.pos.y) * 9 * dt, -0.35, 0.35), z: vz * dt };
    }
    // The water's own way: on top of where the legs and arms take you, not instead of it.
    const [cx, cz] = this.currentDrift();
    desired.x += cx * dt;
    desired.z += cz * dt;
    this.splashT -= dt;
    if (this.waterDepth > 0.15 && Math.hypot(vx, vz) > 0.8 && this.splashT <= 0 && !this.underwater) {
      // A crawl slaps the water at every stroke; an easy paddle, less often.
      const fast = this.swimming && Math.hypot(vx, vz) > 2.6;
      this.splashT = this.swimming ? (fast ? 0.15 : 0.22) : 0.3;
      ctx.fx.puff(this.pos.x, this.waterLevel + 0.04, this.pos.z, 0.92, 0.96, 1.0, this.swimming ? (fast ? 1.2 : 0.9) : 0.6, 0.7);
      ctx.audio.play('splash', this.pos.x, this.pos.z, clamp(Math.hypot(vx, vz) / 6, 0.12, 0.6), { intensity: clamp(Math.hypot(vx, vz) / 6, 0, 1) });
    }
    this.kcc.computeColliderMovement(this.collider, desired, undefined, RAY_STATIC);
    const m = this.kcc.computedMovement();
    const wasGrounded = this.grounded;
    this.grounded = this.kcc.computedGrounded();
    if (this.vy > 0 && m.y < desired.y - 1e-3) this.vy = 0; // head against a ceiling
    if (this.grounded && this.vy < 0) this.vy = 0;
    if (this.swimming) this.grounded = false;
    if (this.grounded) {
      if (!wasGrounded && fallV < -5 && !this.swimming) {
        // Landing: a thud and a puff of dust, louder the harder it came down.
        const k = clamp((-fallV - 5) / 12, 0, 1);
        landGait(this.gait, -fallV);
        ctx.audio.play('thud', this.pos.x, this.pos.z, 0.15 + 0.3 * k);
        ctx.fx.puff(this.pos.x, this.pos.y + 0.05, this.pos.z, 0.62, 0.55, 0.44, 0.5 + 0.5 * k, 0.5);
        ctx.sig.emit(this.pos.x, this.pos.z, 6 + 8 * k, 'noise');
      }
      this.airT = 0;
    } else this.airT += dt;
    // The body is the capsule centre: update our feet position from it.
    const t = this.body.translation();
    const nx = t.x + m.x;
    const ny = t.y + m.y;
    const nz = t.z + m.z;
    // Placed, not driven: tell the world how fast we really went, so growth bends and breaks under a sprinting body.
    ctx.P.kinematicVelocity.set(this.body.handle, { x: m.x / dt, y: 0, z: m.z / dt });
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
    // A scope magnifies the view, so the same stick or mouse movement has to turn it less.
    this.zoomNow = this.equip === 'gun' ? 1 + (this.kit().zoom - 1) * clamp(this.ads, 0, 1) : 1;
    const sens = (lerp(2.9, 1.55, this.ads) * (it.device === 'keyboard' ? 0.9 : 1) * this.lookGain(it)) / this.zoomNow;
    const [pLo, pHi] = this.pitchRange();
    this.aimYaw -= it.look[0] * sens * dt;
    this.aimPitch = clamp(this.aimPitch + it.look[1] * sens * 0.7 * dt, pLo, pHi);
    if (it.mouse) {
      this.aimYaw -= it.lookDelta[0] * this.mouseScale();
      this.aimPitch = clamp(this.aimPitch + it.lookDelta[1] * this.mouseScale(), pLo, pHi);
    }
    // With a mouse, right-click aims and left-click only fires; with Q/E the fire key doubles as aim.
    const kbAds = it.device === 'keyboard' && !it.mouse && isHeld(it, Btn.RT) && !this.carry;
    const wantAds = (it.lt > 0.3 && this.equip === 'gun' && !this.carry ? 1 : kbAds ? 1 : 0) * (this.swimming ? 0 : 1);
    const hd = this.handling();
    stepSpring(this.adsS, wantAds, hd.adsK, hd.adsZeta, dt);
    this.ads = clamp(this.adsS.x, 0, 1.05);
    if (it.device === 'keyboard' && !it.mouse) this.aimPitch = damp(this.aimPitch, 0.04, 3, dt);
  }

  /** Mouse look is slowed while aiming down sights. */
  private mouseScale() {
    return lerp(1, 0.6, this.ads) / this.zoomNow;
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
    const tr = ctx.travellers.rayTest(ox, oy, oz, _v.x, _v.y, _v.z, dist);
    if (tr) dist = Math.min(dist, tr.dist);
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

  /** LB: the next hand on the belt, then the utility, skipping empty slots and a throwable that has run out. */
  private cycleEquip(dir: 1 | -1 = 1) {
    const g = this.gear;
    this.action = null;
    const throwable = this.utility === 'horn' || this.ctx.campaign.items[this.utility] > 0;
    g.sel = stepSel(g, dir, throwable);
    this.syncEquip();
    this.reloadT = 0;
  }

  private cycleUtility() {
    const i = UTILITIES.indexOf(this.utility);
    this.utility = UTILITIES[(i + 1) % UTILITIES.length];
    this.ctx.campaign.players[this.index].utility = this.utility;
    this.note(`Utility: ${utilityName(this.utility)}`, 'info');
  }

  /** Begin a reload for `t` seconds; `each` > 0 loads the gun a round at a time. Every reload starts here. */
  private setReload(t: number, each = 0) {
    this.reloadT = t;
    this.reloadDur = Math.max(0.01, t);
    this.loadEach = each;
    this.magDropped = false;
    this.fault = null;
    this.reloadSoundEvents = t>0 ? reloadSounds(this.gunModel(),each>0,this.mag===0) : [];
  }

  /** The reload the gun in hand needs: quicker with a round still in it, a shell at a time for a pump. */
  private startReload(gun: EffectiveGun) {
    const plan = reloadPlan(gun.model, gun.reload, gun.mag, this.mag);
    this.setReload(plan.first, plan.each);
    this.dumpCases();
    this.ctx.audio.play('weaponHandle',this.pos.x,this.pos.z,.13,{pitch:weaponHandling(gun.model).pitch});
  }

  private finishReload() {
    const camp = this.ctx.campaign;
    if (this.fault) {
      // A fault cleared: the gun is back in action with what was left in it.
      this.fault = null;
      return;
    }
    if (this.bowInHand()) {
      // The next arrow out of the quiver and onto the string.
      if (this.mag < 1 && camp.items.arrow > 0) {
        this.mag = 1;
        camp.items.arrow--;
      }
      return;
    }
    if (this.loadEach > 0) {
      // One shell goes in; the next follows until the gun is full or the pouch is empty. The trigger cuts it short.
      const gun = this.gun();
      if (this.mag < gun.mag && camp.ammo > 0) {
        this.mag++;
        camp.ammo--;
        this.ctx.audio.play('shellInsert',this.pos.x,this.pos.z,.22,{pitch:weaponHandling(gun.model).pitch});
      }
      if (this.mag < gun.mag && camp.ammo > 0) {
        this.reloadT = this.loadEach;
        return;
      }
      this.loadEach = 0;
      if (this.mag === 0) this.note('Out of ammo: craft more at camp', 'warn');
      return;
    }
    const need = this.gun().mag - this.mag;
    const take = Math.min(need, camp.ammo);
    this.mag += take;
    camp.ammo -= take;
    if (take === 0 && this.mag === 0) this.note('Out of ammo: craft more at camp', 'warn');
  }

  /** Whether this trigger pull fails, from how worn the gun is. Its own dice, like wounds. */
  private jams(): boolean {
    const c = jamChance(this.gunItem()?.cond);
    if (c <= 0) return false;
    return this.dice() < c;
  }

  /** The next of this player's own dice, 0 to 1: never the scene's, so a fault or a wound does not shift what else is rolled. */
  private dice(): number {
    this.woundSeed = (Math.imul(this.woundSeed, 1664525) + 1013904223) >>> 0;
    return this.woundSeed / 4294967296;
  }

  /**
   * The trigger is pulled and nothing happens: a dud, or a jam as the gun wears out. The hands clear it with the drill its
   * action needs (see `sim/gunDrills`), on the reload clock; the round in the chamber is lost with it.
   */
  private startFault(gun: EffectiveGun): boolean {
    const f = pickFault(gun.model, this.gunItem()?.cond, this.dice(), this.dice());
    if (!f) return false;
    const ctx = this.ctx;
    this.setReload(f.drill.secs);
    this.fault = f;
    const handling = weaponHandling(gun.model);
    this.reloadSoundEvents = (f.drill.cues ?? []).map(([phase, cue, volume]) => ({ ...CUE_SOUND[cue](handling), phase, volume, pitch: handling.pitch }));
    this.mag = Math.max(0, this.mag - f.cost);
    this.fireCd = 0.3;
    this.habit = null;
    this.note(f.note, 'warn');
    ctx.audio.play('weaponClick', this.pos.x, this.pos.z, 0.24, { pitch: handling.pitch });
    return true;
  }

  /** A fault's drill throws the dud or the live round out of the port when it gets there. */
  private faultEvents(from: number, to: number) {
    const f = this.fault;
    if (!f?.drill.eject) return;
    for (const at of f.drill.eject) if (from < at && to >= at) this.ejectCase(this.handling().shell);
  }

  private updateTools(dt: number, it: PlayerIntent) {
    const ctx = this.ctx;
    if (this.buildMode) {
      ctx.campHook?.(this, it, dt);
      return;
    }
    // Hands full: no gun, no tools, until it is stowed or put down. Nor can a swimmer use them: both hands are swimming.
    if (this.carry || this.swimming) return;
    if (this.equip === 'gun' && this.bowInHand()) {
      this.updateBow(this.gun(), it, dt);
      this.updateMelee(dt, it);
    } else if (this.equip === 'gun') {
      const gun = this.gun();
      if (wasPressed(it, Btn.X) && this.mag < gun.mag && this.reloadT <= 0 && ctx.campaign.ammo > 0) this.startReload(gun);
      const wantFire = it.rt > 0.5;
      // Shells going in one at a time: pulling the trigger stops the loading and fires what is in.
      if (wantFire && this.fireCd <= 0 && this.reloadT > 0 && this.loadEach > 0 && this.mag > 0) this.setReload(0);
      // The gun is carried low in a sprint and cannot be fired until it is back up; nor with the muzzle in a wall.
      const handsReady = this.sprintBlend < READY && this.wallRaw < WALL_BLOCK;
      if (wantFire && this.fireCd <= 0 && this.reloadT <= 0 && handsReady) {
        if (this.mag > 0 && this.jams() && this.startFault(gun)) {
          // A dud or a jam: the hands clear it, and the next pull fires.
        } else if (this.mag > 0) this.fireGun(gun);
        else if (ctx.campaign.ammo > 0) {
          this.startReload(gun);
        } else if (this.fireCd <= 0) {
          this.fireCd = 0.4;
          ctx.audio.play('weaponClick',this.pos.x,this.pos.z,.2,{pitch:weaponHandling(gun.model).pitch});
          this.note('Out of ammo: craft more at camp', 'warn');
        }
      }
      // RB: melee tap, takedown hold.
      this.updateMelee(dt, it);
    } else if (this.equip === 'melee') {
      // A melee weapon swings on the fire trigger as well as on RB.
      if (it.rt > 0.5 && this.meleeCd <= 0) this.melee();
      this.updateMelee(dt, it);
    } else if (this.equip === 'utility') {
      if (wasPressed(it, Btn.RT)) this.useUtility();
      this.updateMelee(dt, it);
    } else {
      this.updateMelee(dt, it);
    }
  }

  /** Seat x offset on the chassis: the cab seats when the model has them, else the moped's centreline. */
  private seatSide(v: Vehicle, seat: 'driver' | 'passenger'): number {
    return v.def.seat ? v.def.seat[seat][0] : seat === 'driver' ? 0 : 0.2;
  }

  /** Drive-by: fire the sidearm from a moving vehicle, sharing the pistol's magazine and reload. */
  private fireFromSeat(v: Vehicle, muzzle: [number, number, number]) {
    const ctx = this.ctx;
    if (this.fireCd > 0 || this.reloadT > 0) return;
    if (this.bowInHand()) {
      // There is no room to draw a bow in a seat.
      this.fireCd = 1;
      this.note('No room to draw a bow from the seat', 'info');
      return;
    }
    if (this.mag <= 0) {
      if (ctx.campaign.ammo > 0) {
        this.setReload(1.3);
        ctx.audio.play('reload', this.pos.x, this.pos.z, 0.5);
      } else {
        this.fireCd = 0.4;
        this.note('Out of ammo: craft more at camp', 'warn');
      }
      return;
    }
    const a = this.computeAim(v);
    const [mx, my, mz] = muzzle;
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
    this.fireCd = 0.22;
    this.mag--;
    this.muzzleT = MUZZLE_T;
    const gi = this.gunItem();
    if (gi) gi.cond = wearBy(gi.cond, WEAR.shot);
    this.throwKick(HANDLING.pistol, 0.5);
    this.ejectCase('pistol');
    ctx.combat.shoot(mx, my, mz, dx, dy, dz, {
      side: 'convoy',
      ammo: 'pistol',
      damage: 24,
      // Shooting off a bouncing seat is loose, and worse the faster the ride goes.
      // A driver sitting on the floor of a seatless car shoots worse still.
      spread: (0.05 + Math.min(0.05, Math.abs(v.speed) * 0.003)) * (this.state === 'driving' ? v.stats.seatSpread : 1),
      assist: it0(this.intent.aimAssist) * 0.8,
      noise: 60,
      range: 65,
      headshots: true,
      owner: this,
    });
    ctx.fx.flash(mx, my, mz, 0.9);
    ctx.audio.play('pistol', mx, mz, 0.8, { occluded: 0 });
    ctx.phantoms.onShot(this, a.ox, a.oy, a.oz, a.dx, a.dy, a.dz);
    this.cam.addShake(0.04);
    ctx.input.rumble(this.index, 0.12, 0.25, 50);
  }

  /** Whether the gun in hand is a bow: drawn and loosed rather than fired, and loaded from the arrows. */
  private bowInHand(): boolean {
    return !!gearDef(this.gunItem()?.id ?? 'w_pistol').gun!.draw;
  }

  /** How far the bow in hand is drawn, 0 to 1 (0 with anything else in hand). */
  get bowDraw(): number {
    return this.equip === 'gun' ? this.bowString.k : 0;
  }

  /**
   * A bow: holding the trigger draws the string, letting it go looses the arrow, as hard as it was drawn. Too little draw
   * and the string is only eased back down. Full draw can be held a moment before the arm starts to shake and tire; when
   * the stamina is gone, the string comes down. The next arrow goes on by itself after a shot; X puts one on by hand.
   */
  private updateBow(gun: EffectiveGun, it: PlayerIntent, dt: number) {
    const ctx = this.ctx;
    const camp = ctx.campaign;
    const d = this.bowString;
    const hold = it.rt > 0.5;
    const handsReady = this.sprintBlend < READY && this.wallRaw < WALL_BLOCK;
    if (wasPressed(it, Btn.X) && this.mag < 1 && this.reloadT <= 0 && camp.items.arrow > 0) this.startNock(gun);
    const canPull = hold && !this.armGave && this.mag > 0 && this.reloadT <= 0 && this.fireCd <= 0 && handsReady;
    if (canPull) {
      if (!this.pulling) ctx.audio.play('creak', this.pos.x, this.pos.z, 0.35);
      this.pulling = true;
      stepDraw(d, true, gun.draw! * (this.stamina.winded ? 1.5 : 1), dt);
      const cost = holdCost(d.held, dt);
      if (cost > 0) {
        spendStamina(this.stamina, cost);
        if (this.stamina.winded) {
          this.armGave = true;
          this.note('Your arm gives out: the string comes down', 'warn');
        }
      }
    } else {
      if (this.pulling && !hold && canLoose(d.k) && this.mag > 0 && handsReady) this.loose(gun, d.k);
      this.pulling = false;
      stepDraw(d, false, gun.draw!, dt);
    }
    if (!hold) this.armGave = false;
    // The string is bare: the next arrow, if there is one.
    if (this.mag < 1 && this.reloadT <= 0 && this.fireCd <= 0) {
      if (camp.items.arrow > 0) this.startNock(gun);
      else if (wasPressed(it, Btn.RT)) this.note('No arrows: pick yours back up, or make more at camp', 'warn');
    }
  }

  /** An arrow out of the quiver and onto the string: the bow's reload. */
  private startNock(gun: EffectiveGun) {
    this.setReload(gun.reload);
    this.ctx.audio.play('click', this.pos.x, this.pos.z, 0.2);
  }

  /** Let the string go at draw `k`: the arrow leaves the shelf for where the reticle is, slower and softer the less it was drawn. */
  private loose(gun: EffectiveGun, k: number) {
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
    const pw = loosePower(k);
    this.fireCd = gun.cd;
    this.mag--;
    slack(this.bowString);
    this.muzzleT = MUZZLE_T;
    const gi = this.gunItem();
    if (gi) gi.cond = wearBy(gi.cond, WEAR.shot);
    // A snatched half draw is a wild shot.
    const spread = lerp(gun.spread, gun.adsSpread, Math.min(1, this.ads)) * (1.6 - 0.6 * k) * (this.crouch ? 0.7 : 1) * (this.moveSpeed > 3 ? 1.6 : 1) * this.drugs.mods().spread * this.nm.spread * wearSpread(gi?.cond);
    // The arrow is seen leaving the bow as it is drawn, and eases onto its path.
    const seen = this.gunPoint('muzzle', [mx, my, mz]);
    ctx.combat.shoot(mx, my, mz, dx, dy, dz, {
      side: 'convoy',
      ammo: 'arrow',
      vel: pw.vel,
      damage: gun.dmg * pw.dmg,
      spread,
      pierce: gun.pierce || undefined,
      assist: it0(this.intent.aimAssist),
      noise: gun.noise * this.drugs.mods().noise,
      range: gun.range,
      headshots: true,
      owner: this,
      seen,
    });
    ctx.audio.play('twang', mx, mz, 0.45 + 0.35 * k, { occluded: 0 });
    this.throwKick(this.handling(), 0.5 + 0.5 * k);
    ctx.phantoms.onShot(this, a.ox, a.oy, a.oz, a.dx, a.dy, a.dz);
    ctx.input.rumble(this.index, 0.08 + 0.1 * k, 0.12, 40);
  }

  private fireGun(gun: EffectiveGun) {
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
    this.fireCd = gun.cd;
    this.mag--;
    this.muzzleT = MUZZLE_T;
    const gi = this.gunItem();
    const spread =
      lerp(gun.spread, gun.adsSpread, Math.min(1, this.ads)) * (this.crouch ? 0.7 : 1) * (this.moveSpeed > 3 ? 1.6 : 1) * this.drugs.mods().spread * this.nm.spread * wearSpread(gi?.cond) * (this.stamina.winded ? 1.3 : 1) * (1 + this.bloom);
    this.bloom = bloomAfterShot(gun.model, this.bloom, this.ads);
    if (gi) gi.cond = wearBy(gi.cond, WEAR.shot);
    const kit = this.kit();
    // A shotgun throws a handful of pellets from one shot. The first carries the noise and the aim assist.
    for (let n = 0; n < gun.pellets; n++) {
      ctx.combat.shoot(mx, my, mz, dx, dy, dz, {
        side: 'convoy',
        ammo: ammoForGun(gun.model),
        vel: kit.vel !== 1 ? kit.vel : undefined,
        damage: gun.dmg,
        spread,
        pierce: gun.pierce || undefined,
        assist: n === 0 ? it0(this.intent.aimAssist) : 0,
        noise: n === 0 ? gun.noise * this.drugs.mods().noise : 0,
        range: gun.range,
        headshots: true,
        owner: this,
      });
    }
    const mfx = MUZZLE[gun.model];
    // The flash, the smoke and the light come from the gun itself as it is drawn, not from where the body thinks it is.
    const [vx, vy, vz] = this.gunPoint('muzzle', [mx, my, mz]);
    // A suppressed shot is dimmer, quieter and duller to the ear as well as to the Signature grid. A crossbow has no flash.
    if (mfx.flash > 0) {
      ctx.fx.muzzle(vx, vy, vz, dx, dy, dz, mfx);
      ctx.combat.muzzleLight(vx, vy, vz, mfx.light * Math.min(1, kit.flash), dx, dy, dz);
      this.smokeT = Math.min(3.5, this.smokeT + 1.2 + (gun.pellets > 1 ? 0.8 : 0));
    }
    this.human.flashK = kit.flash;
    ctx.audio.play(gun.sound === 'bolt' || gun.sound === 'bow' ? 'twang' : gun.sound, mx, mz, 0.8 * (0.3 + 0.7 * Math.min(1.2, kit.quiet)), { occluded: 0, intensity: 1, muffle: kit.quiet < 0.95 ? clamp((1 - kit.quiet) * 1.1, 0, 0.95) : 0 });
    const kick = Math.min(0.14, (gun.dmg * gun.pellets) / 700) * kit.recoil;
    const hd = this.handling();
    this.throwKick(hd, kit.recoil);
    if (hd.eject === 'shot') {
      ctx.audio.play('weaponClick',mx,mz,.08,{pitch:weaponHandling(gun.model).pitch});
      this.ejectCase(hd.shell);
    }
    else if (hd.eject === 'cycle') {
      this.brassQ.push({ t: hd.cycleDelay, kind: hd.shell });
      this.cycleDur = cycleTime(hd.cycleDelay);
      this.cycleT = this.cycleDur;
    } else if (hd.eject === 'reload') this.spent++;
    ctx.phantoms.onShot(this, a.ox, a.oy, a.oz, a.dx, a.dy, a.dz);
    this.cam.addShake(0.02 + kick * 0.6);
    ctx.input.rumble(this.index, 0.15 + kick * 2, 0.3, 50);
  }

  // ------------------------------------------------------------------ handling

  /** The model of the gun in hand: the pistol's if there is none. */
  private gunModel(): GunModel {
    return gearDef(this.gunItem()?.id ?? 'w_pistol').gun!.model;
  }

  /** How the gun in hand feels: the pistol's if there is none. */
  private handling(): Handling {
    return this.kitState().hd;
  }

  /**
   * Kick the view: the muzzle climbs, twitches sideways and the camera rolls and rocks back, all at once as velocity into
   * springs, so it snaps up and settles. Braced behind the sights it is gentler; winded it is worse.
   */
  private throwKick(hd: Handling, scale = 1) {
    const m = (1 - 0.28 * clamp(this.ads, 0, 1)) * (this.crouch ? 0.88 : 1) * (this.stamina.winded ? 1.25 : 1) * scale;
    const j = () => 0.82 + Math.random() * 0.36;
    const side = () => (Math.random() - 0.5) * 2;
    const k = this.kick;
    k.pitch.v += kickVelocity(hd, hd.kick * m * j());
    k.yaw.v += kickVelocity(hd, hd.kickYaw * m * side());
    k.roll.v += kickVelocity(hd, hd.kickRoll * m * side());
    k.back.v += kickVelocity(hd, hd.kickBack * m * j());
  }

  /** Settle the kick, wander the barrel, and let the queued empties go. */
  private updateHandling(dt: number) {
    const ctx = this.ctx;
    const hd = this.handling();
    const k = this.kick;
    if (this.drawT > 0) this.drawT -= dt;
    this.updateGunEffects(dt);
    if (this.cycleT > 0) this.cycleT -= dt;
    // The gun lags behind a turn of the view and swings back: heavy things do not follow the eye exactly.
    if (this.prevAim) {
      const dy = wrapAngle(this.aimYaw - this.prevAim[0]);
      const dp = this.aimPitch - this.prevAim[1];
      this.lag.yaw.v -= clamp(dy, -0.3, 0.3) * 1.5;
      this.lag.pitch.v += clamp(dp, -0.3, 0.3) * 1.2;
    } else this.prevAim = [this.aimYaw, this.aimPitch];
    this.prevAim[0] = this.aimYaw;
    this.prevAim[1] = this.aimPitch;
    stepSpring(this.lag.yaw, 0, 90, 0.55, dt);
    stepSpring(this.lag.pitch, 0, 90, 0.55, dt);
    if (this.state !== 'foot') {
      stepLean(this.lean, 0, dt);
      this.leanYaw = this.aimYaw;
      this.sprintBlend = damp(this.sprintBlend, 0, SPRINT_OUT, dt);
      this.wallBlend = damp(this.wallBlend, 0, 6, dt);
      this.wallRaw = 0;
    }
    stepSpring(k.pitch, 0, hd.settleK, hd.settleZeta, dt);
    stepSpring(k.yaw, 0, hd.settleK, hd.settleZeta, dt);
    stepSpring(k.roll, 0, hd.settleK * 0.8, hd.settleZeta, dt);
    stepSpring(k.back, 0, hd.settleK * 1.3, 0.8, dt);
    if (this.bloom > 0) this.bloom = bloomSettle(this.gunModel(), this.bloom, dt);
    const armed = this.equip === 'gun' && !this.carry && (this.state === 'foot' || this.state === 'gunner') && !this.drugs.passedOut;
    if (armed) {
      // A bow held at full draw too long shakes; drawn at all, it is braced like a gun behind its sights.
      const bow = this.bowString.k > 0 ? holdShake(this.bowString.held) : 1;
      const [sx, sy] = swayAt(hd, ctx.time, this.index * 3.7, this.moveSpeed, Math.max(this.ads, this.bowString.k * 0.7), this.crouch, this.stamina.winded);
      this.sway[0] = sx * bow;
      this.sway[1] = sy * bow;
      // A laser needs to know where the barrel points: the aim ray, cast once a tick while it is lit.
      const bm = this.kit().beam;
      if (bm === 'laser' || bm === 'both') this.computeAim();
    } else {
      this.sway[0] = 0;
      this.sway[1] = 0;
    }
    for (let i = this.brassQ.length - 1; i >= 0; i--) {
      const q = this.brassQ[i];
      q.t -= dt;
      if (q.t > 0) continue;
      this.brassQ.splice(i, 1);
      if (this.state === 'foot' || this.state === 'gunner' || this.state === 'driving') {
        this.ctx.audio.play(q.kind==='hull' ? 'weaponPump' : 'weaponBolt',this.pos.x,this.pos.z,.23,{pitch:weaponHandling(this.gunModel()).pitch});
        this.ejectCase(q.kind);
      }
    }
  }

  /** One empty case leaves the ejection port, to the right and up. */
  private ejectCase(kind: ShellKind) {
    const [mx, my, mz] = this.muzzlePos();
    const f = this.aimYaw;
    // Out of the ejection port on the gun, with a wisp of smoke from the breech and the shooter's own motion carried over.
    const [px, py, pz] = this.gunPoint('port', [mx - Math.sin(f) * 0.32, my - 0.06, mz - Math.cos(f) * 0.32]);
    this.ctx.gore.eject(kind, px, py, pz, f, this.hvx, this.hvz);
    this.ctx.fx.wisp(px, py, pz, 1);
  }

  /**
   * A point on the gun in the world: read off the rig as it was last drawn (the owner's own first-person pose included), or
   * `fallback` where the body thinks it is when the gun has not been drawn.
   */
  private gunPoint(which: 'muzzle' | 'port' | 'well', fallback: [number, number, number]): [number, number, number] {
    const pts = this.human.points;
    if (!pts.valid || !this.human.root.visible) return fallback;
    const v = pts[which];
    return [v.x, v.y, v.z];
  }

  /** The empty magazine falls out of the gun at the right moment of a reload, and the barrel keeps smoking for a while after a shot. */
  private updateGunEffects(dt: number) {
    const ctx = this.ctx;
    if (this.reloadT > 0 && !this.magDropped && this.loadEach === 0 && this.equip === 'gun' && !this.fault) {
      const model = this.gunModel();
      const mag = DROPS_MAG[model];
      const at = dropAt(RELOAD_KIND[model]);
      if (mag && 1 - this.reloadT / this.reloadDur >= at) {
        this.magDropped = true;
        const [wx, wy, wz] = this.gunPoint('well', [this.pos.x, this.pos.y + 1.0, this.pos.z]);
        ctx.gore.dropMag(mag, wx, wy, wz, this.hvx, this.hvz);
        // Extraction sound follows the same pose phase in the reload event track.
      }
    }
    if (this.smokeT > 0) {
      this.smokeT -= dt;
      if (this.equip === 'gun' && this.state === 'foot' && Math.random() < dt * 14 * Math.min(1, this.smokeT)) {
        const [mx, my, mz] = this.muzzlePos();
        const [wx, wy, wz] = this.gunPoint('muzzle', [mx, my, mz]);
        ctx.fx.wisp(wx, wy, wz, Math.min(1, this.smokeT));
      }
    }
  }

  /** The gun is opened to reload: a revolver or a break-action drops what it fired. */
  private dumpCases() {
    const hd = this.handling();
    if (hd.eject !== 'reload' || this.spent <= 0) return;
    for (let i = 0; i < this.spent; i++) this.brassQ.push({ t: 0.3 + i * 0.07, kind: hd.shell });
    this.spent = 0;
  }

  private updateMelee(dt: number, it: PlayerIntent) {
    const ctx = this.ctx;
    const heldRB = isHeld(it, Btn.RB);
    const rbTime = heldFor(it, Btn.RB);
    // On keys and mouse the fire button also presses RB: a shot is not a rifle butt. Remember that the trigger was down
    // while RB was, so letting go of it never reads as a melee tap (and a takedown hold still needs RB alone).
    if (!heldRB && !(it.released & (1 << Btn.RB))) this.rbWithTrigger = false;
    else if (heldRB && it.rt > 0.5 && this.equip === 'gun') this.rbWithTrigger = true;
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
    if (it.released & (1 << Btn.RB) && it.releasedAfter[Btn.RB] < 0.3 && this.meleeCd <= 0 && !this.rbWithTrigger) this.melee();
    else if (tk && !heldRB) this.prompt = { text: `Hold RB: ${t('prompt.takedown')}`, progress: -1, button: 'RB' };
  }

  /** A swing at glass: the pane in front of the blow takes it, and so does the window of a car beside it. Walls are left alone. */
  private smashGlass(hx: number, hz: number, reach: number, dmg: number) {
    const ctx = this.ctx;
    const r = Math.max(1.1, reach);
    const found: Aabb[] = [];
    let bd = r;
    ctx.obs.near(hx, hz, r + 1, (a) => {
      if (a.mat !== 'glass' || a.kind !== 'partition') return;
      if (a.y1 < this.pos.y + 0.3 || a.y0 > this.pos.y + 1.9) return;
      const d = Math.hypot(clamp(hx, a.minX, a.maxX) - hx, clamp(hz, a.minZ, a.maxZ) - hz);
      if (d < bd) {
        bd = d;
        found[0] = a;
      }
    });
    const a = found[0];
    if (a && ctx.world) ctx.world.hit(a, dmg * 1.2, 'ram', { x: clamp(hx, a.minX, a.maxX), y: clamp(this.pos.y + 1.1, a.y0 + 0.1, a.y1 - 0.1), z: clamp(hz, a.minZ, a.maxZ) });
    for (const v of ctx.vehicles) {
      if (v.wreck || Math.hypot(v.position.x - hx, v.position.z - hz) > v.def.length / 2 + 1) continue;
      v.glass.hitNear(hx, this.pos.y + 1.0, hz, dmg, 'melee', 1.3);
    }
  }

  private melee() {
    const ctx = this.ctx;
    // The weapon in hand sets the damage, reach and pace; gloves add to it. Bare hands are a rifle butt and a bad temper.
    const held = this.equip === 'melee' ? heldItem(this.gear) : null;
    const base = effectiveMelee(this.meleeWeapon(), this.stats);
    const w = { ...base, dmg: base.dmg * wearDamage(held?.cond) };
    // Swinging tires the arm; winded, every blow comes slower and lands lighter.
    const winded = this.stamina.winded;
    this.meleeCd = w.cd * (winded ? 1.5 : 1);
    if (winded) w.dmg *= 0.75;
    spendStamina(this.stamina, STAMINA.swing);
    if (held) held.cond = wearBy(held.cond, WEAR.swing);
    this.swingT = 1;
    this.hitStop = 0;
    const feel = meleeFeel(this.meleeWeapon()?.model);
    const dm = this.drugs.mods();
    ctx.audio.play('swing', this.pos.x, this.pos.z, 0.5, { pitch: feel.pitch });
    // The weapon has to come round before it lands: the blow resolves part-way through the swing, as the arm comes down.
    this.swingFeel = feel;
    this.swingDur = feel.swing;
    this.swingPend = { t: feel.windup, dmg: w.dmg * dm.melee, reach: w.reach, yaw: this.aimYaw, feel, cut: cutOf(w.model), model: this.meleeWeapon()?.model ?? 'fist' };
    ctx.sig.emit(this.pos.x, this.pos.z, w.noise * dm.noise, 'noise');
    this.cam.addShake(0.03);
  }

  /** The swing in progress: the streak the weapon draws through the air, and the blow landing when the weapon gets there. */
  private updateSwing(dt: number) {
    const feel = this.swingFeel;
    if (feel && this.swingT > 0 && this.state === 'foot') {
      const e = 1 - this.swingT;
      // Several samples a tick, so the streak is a ribbon and not a string of beads.
      for (const back of [0, 0.025, 0.05, 0.075]) {
        const a = swingArc(e - back, feel.blade);
        const yaw = this.aimYaw + a.yaw;
        const r = a.r;
        this.ctx.fx.glow.emit(this.pos.x + Math.sin(yaw) * r, this.pos.y + a.y, this.pos.z + Math.cos(yaw) * r, 0, 0, 0, 0.17, 0.16, 0.04, feel.trail[0], feel.trail[1], feel.trail[2], feel.trailAlpha, 0, 0);
      }
    }
    const s = this.swingPend;
    if (!s) return;
    s.t -= dt;
    if (s.t > 0) return;
    this.swingPend = null;
    if (this.state !== 'foot') return;
    const ctx = this.ctx;
    const f = s.yaw;
    const hx = this.pos.x + Math.sin(f) * 1.0;
    const hz = this.pos.z + Math.cos(f) * 1.0;
    const hits = (ctx.zombies.meleeHit(this, hx, hz, f, s.reach, s.dmg, s.feel, s.cut) ?? 0) + (ctx.wildlife.meleeHit(this, hx, hz, f, s.reach, s.dmg, s.feel, s.cut) ?? 0) + (ctx.raiders.meleeHit(this, hx, hz, f, s.reach, s.dmg, s.feel) ?? 0) + (ctx.travellers.meleeHit(this, hx, hz, f, s.reach, s.dmg, s.feel) ?? 0) + (ctx.life?.meleeHit(hx, hz, s.reach) ?? 0);
    this.smashGlass(hx, hz, s.reach, s.dmg);
    ctx.P.hitArea({ x: hx, y: this.pos.y + 1.1, z: hz, dx: Math.sin(f), dy: 0, dz: Math.cos(f),
      impulse: s.dmg * 1.5, energy: s.dmg * (s.cut <= 0 ? 25 : 1200), kind: s.cut <= 0 ? 'blunt' : 'cut', radius: Math.max(0.6, s.reach * 0.5) });
    for (const tree of ctx.treesNear?.(hx, hz, s.reach) ?? []) {
      if (Math.hypot(tree.x - hx, tree.z - hz) > s.reach) continue;
      ctx.audio.play('treeHit', tree.x, tree.z, clamp(s.dmg / 90, 0.2, 0.8));
      ctx.audio.play('rustle', tree.x, tree.z, 0.3);
      break;
    }
    ctx.phantoms.onSwing(this, hx, hz);
    if (hits <= 0) {
      // Looking down brings the blow onto reachable ground; swinging level never kicks up earth at a distance.
      const aim = this.computeAim();
      if (aim.dy < -0.45) {
        const hit = ctx.P.raycast(this.pos.x, this.pos.y + 1.1, this.pos.z, aim.dx, aim.dy, aim.dz, s.reach, groups(0xffff, G.STATIC));
        if (hit) {
          const x = this.pos.x + aim.dx * hit.toi, y = this.pos.y + 1.1 + aim.dy * hit.toi, z = this.pos.z + aim.dz * hit.toi;
          if (!ctx.P.surfaces.has(hit.collider.handle) && Math.abs(y - ctx.groundAt(x, z)) < 0.4) {
            const n = hit.normal;
            ctx.gore.groundStrike(s.model, ctx.surfaceAt(x, z).name, x, y, z, n.x, n.y, n.z, aim.dx, aim.dy, aim.dz, 1);
            this.hitStop = s.feel.hitStop;
            this.cam.addShake(s.feel.shake * 0.5);
          }
        }
      }
      return;
    }
    // A blow that lands: the arm hangs on it a moment, the view jolts, and what it hit sprays back along the swing.
    this.hitStop = s.feel.hitStop;
    this.cam.addShake(s.feel.shake);
    ctx.input.rumble(this.index, 0.2 + s.feel.shake, 0.3 + s.feel.shake, 60);
    ctx.gore.flesh(hx, this.pos.y + 1.1, hz, Math.sin(f), 0.15, Math.cos(f), clamp(s.dmg / 70, 0.15, 1.2));
    ctx.audio.play(s.feel.hit, hx, hz, 0.6);
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
    // Hands-on: move, turn, set down or throw what you hold. Something let go of this tick is done with.
    if (this.carry) holdTick(this, it);

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
    const fromRegistry = (r: Interactable): Cand => ({
      kind: 'reg:' + r.id, prompt: r.prompt, dur: r.dur, target: r, ok: true, label: r.id,
      run: () => r.run(this),
      tick: () => r.onTick?.(this, this.action?.t ?? 0) !== false,
    });
    const handoff = ctx.interact.nearest(this);
    if (!cand && handoff?.direct) cand = fromRegistry(handoff);
    // 2. Hands: lift a part, fuel can or oil can off the ground, or fit what you carry to your car.
    this.promptAlt = null;
    if (!cand) cand = haulCandidate(this);
    if (this.carry && wasPressed(it, Btn.X) && !this.action) haulKey(this);
    // X with free hands at a car's boot, back door, bed or roof opens its storage (with the wrench out, X is the workbench).
    else if (!this.carry && this.equip !== 'wrench' && wasPressed(it, Btn.X) && !this.action) storageKey(this);
    // 3. Tools on vehicles: the wrench repairs, the crowbar strips, the jerrycan fills and siphons.
    if (!cand && !this.carry && this.equip === 'wrench') cand = wrenchCandidate(this, () => this.repairCandidate()) ?? this.repairCandidate();
    else if (!cand && !this.carry && this.equip === 'crowbar') cand = this.salvageCandidate() ?? pryCandidate(this);
    else if (!cand && !this.carry && this.equip === 'jerrycan') cand = this.fuelCandidate();
    // A quick tap of A with the wrench (not a hold) moves to the next mount stacked under your hands: engine, then the gun on top.
    // X with the wrench: open the field workbench for a convoy vehicle.
    if (this.equip === 'wrench' && !this.carry && wasPressed(it, Btn.X) && !this.action) {
      const bv = this.nearestVehicle(3.8, (q) => (q.faction === 'convoy' || q.faction === 'neutral') && !!q.build && !q.wreck && q.kind !== 'crew');
      if (bv) {
        ctx.cars.claim(bv, this);
        ctx.openWorkbench?.(this, bv);
      }
      else this.note('Stand next to one of your vehicles to use the workbench', 'info');
    }
    // 4. Registry items (loot containers, camp posts).
    if (!cand) {
      const r = ctx.interact.nearest(this);
      if (r) cand = fromRegistry(r);
    }

    // Bare hands, or a tool with nothing to do: the bonnet, door or boot in front of you opens and shuts with a short hold.
    if (!cand && !this.carry) cand = panelCandidate(this, this.equip === 'wrench' || this.equip === 'crowbar' || this.equip === 'jerrycan');
    // Enter prompt when nothing else is going on and a vehicle is near.
    if (!cand) {
      const door = this.nearestDoor();
      if (door) {
        this.prompt = { text: door.seat === 'gunner' ? 'Ride gunner seat' : t('prompt.enter'), progress: -1, button: 'Y' };
      }
    }

    this.workAt = null;
    if (cand) {
      if (this.action && this.action.kind === cand.kind && this.action.target === cand.target) {
        if (!heldA || !cand.ok) {
          this.action = null;
        } else {
          this.action.t += dt;
          this.workAt = cand.at ?? null;
          this.moveSpeed = Math.min(this.moveSpeed, 0.5);
          if (cand.tick && cand.tick() === false) this.action = null;
          else if (this.action.t >= this.action.dur) {
            const run = cand.run;
            this.action = null;
            // Working on an abandoned car from the ground claims it, as sitting in it would.
            if (HANDS_ON.has(cand.kind)) {
              const ab = this.nearestVehicle(5, (q) => q.faction === 'neutral' && !!q.build && !q.wreck && q.kind !== 'crew');
              if (ab) ctx.cars.claim(ab, this);
            }
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
    else {
      storagePrompt(this);
      // The panel prompt has the main slot; getting in is still Y.
      if (cand?.kind === 'panel' && !this.promptAlt && this.nearestDoor()) this.promptAlt = { text: t('prompt.enter'), button: 'Y', ok: true };
    }
    guide(this);
    lookTick(this, cand?.kind === 'fit' && cand.ok, !this.carry && !!cand?.ok && (cand.kind === 'unbolt' || cand.kind === 'pry'));
    // A part of a car under the crosshair: picked out, with its card beside the crosshair (`carLook.ts`).
    carLookTick(this, cand);
    // Something held close is held in the hands: the arms reach for it.
    if (!this.workAt && holdFloats(this) && this.hold.dist < 1.35) this.workAt = this.hold.at.clone();
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
    const bench = (v.faction === 'convoy' || v.faction === 'neutral') && v.build ? '  ·  X: paint & oil bench' : '';
    const job = planRepair(v.health, ctx.campaign.stocks, { spare: v.stats.spare, weapon: !!v.weapon, dents: v.bodywork.dentLevel(), missing: v.bodywork.missing(), glass: v.glass.broken() });
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
        let msg = applyRepair(v.health, job);
        if (job.kind === 'body') {
          // The hammer straightens the panels first; once they are true, a missing door or mirror goes back on.
          const bw = v.bodywork;
          if (bw.dentLevel() > STRAIGHT) {
            bw.straighten();
            msg = bw.dentLevel() > STRAIGHT ? 'Dents hammered out (some left)' : 'Bodywork straightened';
          } else {
            const name = bw.restoreOne();
            if (name) msg = `${name} welded back on`;
            else {
              const pane = v.glass.mendOne();
              if (pane) msg = `New ${pane} fitted`;
            }
          }
        }
        this.note(msg, 'good');
        if (job.kind === 'engine' && v.health.comp.engine >= 0.1) v.startFail = '';
        ctx.audio.play('wrench', v.position.x, v.position.z, 0.7);
        const at = sitePos(v, job.kind === 'engine' ? 'hood' : job.kind === 'tire' ? 'wheel' : 'flank');
        ctx.work.burst(at, 1, 0.8);
        ctx.work.label(msg, '#7ddc7a', at.add(new THREE.Vector3(0, 0.8, 0)));
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

  /**
   * Jerrycan: top up a convoy vehicle from the reserve (the fuel its engine burns, or oil when the sump is low), drain a
   * tank that holds the wrong fuel for its engine back into the reserve, or siphon an abandoned one.
   */
  private fuelCandidate(): Cand | null {
    const ctx = this.ctx;
    const camp = ctx.campaign;
    const own = this.nearestVehicle(3.8, (q) => q.faction === 'convoy' && !q.wreck && q.kind !== 'crew');
    if (own) {
      const engineFuel = own.stats.fuel;
      // A tank holding the other fuel can't be topped up: it has to come out first.
      if (own.convoyEngine && own.fuelType !== engineFuel && own.fuel >= TANK_DREGS) {
        const drain = planDrain(own.fuelType, own.fuel, engineFuel);
        const fuelPlace = placeFor(this, own, 'fuel');
        if (!fuelPlace.gate.ok) return { kind: 'drain', prompt: goLine(own, fuelPlace, 'drain the tank'), dur: 4, target: own, ok: false, label: 'drain', run: () => {} };
        return {
          kind: 'drain',
          prompt: drain.label,
          dur: 4,
          target: own,
          ok: true,
          label: 'drain',
          run: () => {
            const amt = own.fuel;
            addReserve(camp, own.fuelType, amt);
            this.note(`${amt.toFixed(1)} FU of ${own.fuelType} drained into the reserve; the tank is ready for ${engineFuel}`, 'good');
            own.fuel = 0;
            own.fuelType = engineFuel;
            own.startFail = '';
            own.commit();
          },
          tick: () => {
            if (Math.random() < 0.2) ctx.work.pour(this.human.hand.getWorldPosition(new THREE.Vector3()), sitePos(own, 'rear'), own.fuelType === 'diesel' ? [0.85, 0.7, 0.15] : [0.9, 0.5, 0.2]);
            return true;
          },
        };
      }
      const space = own.tankMax - (own.fuelType === engineFuel ? own.fuel : 0);
      const stock = reserveOf(camp, engineFuel);
      const takesOil = own.build !== null && own.def.physics.kind !== 'boat';
      const oil = own.health.comp.oil;
      const sump = own.stats.sumpL;
      const cool = own.health.comp.coolant ?? 1;
      const takesWater = own.convoyEngine;
      const needsFuel = space > 0.4 && stock > 0.4;
      const oilUrgent = takesOil && oil < OIL_LOW && camp.items.oil > 0.02;
      const oilWanted = takesOil && oil < 0.9 && camp.items.oil > 0.02;
      const coolUrgent = takesWater && cool < COOLANT_LOW && camp.items.water > 0.2;
      const coolWanted = takesWater && cool < 0.9 && camp.items.water > 0.2;
      const topOil = (): Cand => {
        const r = pourOil(oil, camp.items.oil, sump);
        return {
          kind: 'topoil',
          prompt: `Top up the oil from the reserve (${Math.round(oil * 100)}% → ${Math.round((oil + (r.used * 3) / sump) * 100)}%)`,
          dur: 2.4,
          target: own,
          ok: true,
          label: 'topoil',
          run: () => {
            const o = pourOil(own.health.comp.oil, camp.items.oil, sump);
            own.health.comp.oil = o.oil;
            camp.items.oil = Math.max(0, camp.items.oil - o.used);
            own.commit();
            this.note(`Oil topped up to ${Math.round(o.oil * 100)}%`, 'good');
          },
        };
      };
      const topWater = (): Cand => {
        const r = pourWater(cool, camp.items.water, own.stats.coolantL);
        return {
          kind: 'topwater',
          prompt: `Top up the radiator from the reserve (${Math.round(cool * 100)}% → ${Math.round(r.coolant * 100)}%, ${r.used.toFixed(1)} L)`,
          dur: 2.8,
          target: own,
          ok: true,
          label: 'topwater',
          run: () => {
            const w = pourWater(own.health.comp.coolant ?? 1, camp.items.water, own.stats.coolantL);
            own.health.comp.coolant = w.coolant;
            camp.items.water = Math.max(0, camp.items.water - w.used);
            own.commit();
            this.note(`The radiator is at ${Math.round(w.coolant * 100)}% (${w.used.toFixed(1)} L of water)`, 'good');
          },
          tick: () => {
            if (Math.random() < 0.2) ctx.work.pour(this.human.hand.getWorldPosition(new THREE.Vector3()), sitePos(own, 'hood'), [0.4, 0.65, 0.9]);
            return true;
          },
        };
      };
      // The oil and the water go in at the engine bay (bonnet open), the fuel at the flap: where you stand picks the job.
      const flap = placeFor(this, own, 'fuel');
      const bay = placeFor(this, own, 'oil');
      const bayJob = (c: Cand, verb: string): Cand => {
        if (bay.gate.ok) return c;
        const need = bay.gate.need;
        if (need?.kind === 'open' && bay.at) return panelCand(this, own, need.panel, true, verb);
        return { ...c, prompt: goLine(own, bay, verb), ok: false, run: () => {}, tick: undefined };
      };
      const dots = [...accessPointsOf(own.def).filter((q) => q.spot === 'flap' || q.spot === 'hood').map((q) => pointPos(own, q))];
      ctx.work.focus(this.index, dots, null);
      const atBay = !!bay.at && !flap.at;
      // What is running out comes first; then fuel; then the things that merely want a top-up.
      if (atBay && (oilWanted || coolWanted) && !(flap.at && needsFuel)) return oilUrgent || (oilWanted && !coolUrgent && oil <= cool) ? bayJob(topOil(), 'top up the oil') : bayJob(topWater(), 'top up the radiator');
      if (!flap.at || !needsFuel) {
        if (oilUrgent) return bayJob(topOil(), 'top up the oil');
        if (coolUrgent) return bayJob(topWater(), 'top up the radiator');
        if (!needsFuel && oilWanted) return bayJob(topOil(), 'top up the oil');
        if (!needsFuel && coolWanted) return bayJob(topWater(), 'top up the radiator');
      }
      const c: Cand = {
        kind: 'refuel',
        prompt: space > 0.4 ? `${t('prompt.refuel')} (${engineFuel})` : 'Tank is full',
        dur: 4,
        target: own,
        ok: needsFuel,
        label: 'refuel',
        run: () => {
          if (own.fuelType !== engineFuel) {
            own.fuelType = engineFuel;
            own.fuel = 0;
          }
          const amt = takeReserve(camp, engineFuel, Math.min(5, own.tankMax - own.fuel));
          own.fuel += amt;
          this.note(`+${amt.toFixed(1)} FU of ${engineFuel}`, 'good');
        },
      };
      if (space > 0.4 && stock <= 0.4) c.prompt = engineFuel === 'diesel' ? 'The convoy has no diesel: find some, or swap in a petrol engine' : 'Convoy reserve is empty';
      if (c.ok && !flap.gate.ok) return { ...c, prompt: goLine(own, flap, 'refuel'), ok: false, run: () => {} };
      return c;
    }
    const donor = this.nearestVehicle(3.8, (q) => (q.faction === 'neutral' || q.wreck) && q.fuel > 0.4);
    if (!donor) {
      // Standing at a lake with the can out: scoop water for the radiators.
      const w = ctx.waterAt(this.pos.x + Math.sin(this.aimYaw) * 1.5, this.pos.z + Math.cos(this.aimYaw) * 1.5) ?? ctx.waterAt(this.pos.x, this.pos.z);
      if (!w || w.depth < 0.15) return null;
      const room = WATER_RESERVE_MAX - camp.items.water;
      return {
        kind: 'scoop',
        prompt: room > 0.5 ? `Fill the water can from the lake (+${Math.min(WATER_CAN, room).toFixed(0)} L)` : 'The water reserve is full',
        dur: 3,
        target: 'lake',
        ok: room > 0.5,
        label: 'scoop',
        run: () => {
          const took = camp.stowWater(WATER_CAN);
          this.note(`+${took.toFixed(0)} L of water`, 'good');
        },
      };
    }
    const hot = donor.wreck && donor.burnT > 0;
    // The hose goes in at the donor's fuel flap.
    const donorFlap = placeFor(this, donor, 'fuel');
    return {
      kind: 'siphon',
      prompt: hot ? 'Still burning: too hot to touch' : !donorFlap.gate.ok ? goLine(donor, donorFlap, 'siphon the tank') : `Siphon the ${donor.fuelType} tank (${Math.min(5, donor.fuel).toFixed(1)} FU)`,
      dur: 3,
      target: donor,
      ok: !hot && donorFlap.gate.ok,
      label: 'siphon',
      run: () => {
        const amt = Math.min(5, donor.fuel);
        donor.fuel -= amt;
        addReserve(camp, donor.fuelType, amt);
        this.note(`+${amt.toFixed(1)} FU of ${donor.fuelType} siphoned`, 'good');
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
    // Phase one: walk up to the door. Phase two: reach, step over the sill and drop onto the cabin's own seat, so the driver
    // model takes over exactly where the body is.
    const walking = this.enterT < this.enterWalk;
    const k = clamp((this.enterT - this.enterWalk) / ENTER_SECS, 0, 1);
    const feet = v.riderFeet(this.enterSeat);
    const seat = feet ?? (this.enterSeat === 'driver' ? v.body.toWorld(0, -0.4, -0.1) : v.gunnerPos());
    const sy = feet ? seat[1] : seat[1] - 0.6;
    const gate = this.doorGate(v, this.enterSeat) ?? [this.enterFrom.x, this.enterFrom.y, this.enterFrom.z];
    let tx = seat[0];
    let tz = seat[2];
    if (walking) {
      const w = this.enterT / this.enterWalk;
      const m = w * w * (3 - 2 * w);
      this.pos.set(lerp(this.enterFrom.x, gate[0], m), this.enterFrom.y, lerp(this.enterFrom.z, gate[2], m));
      tx = gate[0];
      tz = gate[2];
    } else {
      // Along the door line first, then in: the height only changes once the body is at the frame.
      const mx = k * k * (3 - 2 * k);
      const my = clamp((k - 0.35) / 0.65, 0, 1);
      this.pos.set(lerp(gate[0], seat[0], mx), lerp(this.enterFrom.y, sy, my * my * (3 - 2 * my)), lerp(gate[2], seat[2], mx));
    }
    // Face the door on the way up, side-on to the car at the frame, then turn in to the seat: a quarter turn to face the way the car points.
    const dx = tx - this.pos.x;
    const dz = tz - this.pos.z;
    if (walking) {
      if (Math.hypot(dx, dz) > 0.3) this.yaw = dampAngle(this.yaw, Math.atan2(dx, dz), 10, dt);
    } else {
      if (!this.enterOpened) {
        this.enterOpened = true;
        if (v.build) v.setPanel(this.enterDoor(v), true);
      }
      const sx = seat[0] - gate[0];
      const sz = seat[2] - gate[2];
      const sideYaw = Math.hypot(sx, sz) > 0.3 ? Math.atan2(sx, sz) : this.enterYaw;
      const turn = clamp((k - 0.3) / 0.55, 0, 1);
      this.yaw = sideYaw + angleDiff(sideYaw, v.yaw) * (turn * turn * (3 - 2 * turn));
    }
    this.body.setTranslation({ x: this.pos.x, y: this.pos.y + BODY_H / 2, z: this.pos.z }, false);
    this.moveSpeed = walking ? ENTER_WALK : 0;
    if (!walking && k >= 1) this.finishEnter();
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
    // Slumped over the wheel or heaving out of the window: no horn, no gun, no getting out.
    if (this.drugs.passedOut || this.stunT > 0) {
      this.lookBack = false;
      return;
    }
    // Horn / siren
    if (wasPressed(it, Btn.X)) {
      v.hornT = 0.6;
      ctx.audio.play('horn', p.x, p.z, 1);
    }
    if (heldFor(it, Btn.X) > 0.5 && isHeld(it, Btn.X)) {
      v.sirenT = 0.3;
    }
    if (it.released & (1 << Btn.B) && it.releasedAfter[Btn.B] < 0.45) {
      v.lights = !v.lights;
    }
    // Fire the vehicle gun. T2 fires along the nose; T3's gun belongs to the gunner.
    if (v.weapon === 'frontLMG' && isHeld(it, Btn.RB)) v.fireGun(dt);
    // No mounted gun on this ride: RB is a drive-by with the sidearm, aimed where the camera looks.
    else if (!v.weapon && isHeld(it, Btn.RB)) this.fireFromSeat(v, v.body.toWorld(this.seatSide(v, 'driver'), 1.1, 0.2));
    // Camera toggles
    if (wasPressed(it, Btn.L3)) this.camFar = !this.camFar;
    this.lookBack = isHeld(it, Btn.R3);
    // Exit: tap Y when slow; hold Y to bail at speed.
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
    if (this.drugs.passedOut || this.stunT > 0) return;
    // Aim the bed gun with the right stick (keyboard turns with Q/E).
    this.ads = damp(this.ads, it.lt > 0.3 ? 1 : 0, 10, dt);
    this.adsS.x = this.ads;
    this.adsS.v = 0;
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
    if (firing && !v.weapon) this.fireFromSeat(v, v.body.toWorld(this.seatSide(v, 'passenger'), 1.1, 0.2));
    else if (firing) {
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
    const exit = promptLabel(slot, 'Y');
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
    this.senseWater();
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
    } else if (this.state === 'downed' || this.state === 'dead' || (this.state === 'foot' && this.drugs.passedOut)) {
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
    // Drunk and tripping hands: the aim wanders, a little less when braced against the sights.
    const sway = this.drugs.mods().sway + this.nm.sway;
    if (sway > 0.02 && (this.state === 'foot' || this.state === 'gunner')) {
      const t = this.ctx.time + this.index * 7.3;
      const k = sway * (1 - 0.35 * this.ads);
      aimYaw += (Math.sin(t * 0.9) * 0.04 + Math.sin(t * 2.3 + 1.1) * 0.015) * k;
      aimPitch = clamp(aimPitch + (Math.sin(t * 1.1 + 1.3) * 0.025 + Math.sin(t * 2.9) * 0.01) * k, first ? -1.3 : -0.55, first ? 1.3 : 0.8);
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
      kick: { pitch: this.kick.pitch.x + this.sway[1], yaw: this.kick.yaw.x + this.sway[0], roll: this.kick.roll.x + (first && this.state === 'foot' ? this.gaitOut.roll + this.lean.roll : 0), back: this.kick.back.x },
    });
    // Through a scope the view narrows: only on foot with a gun up, and back to normal the moment the sights come down.
    this.ctx.R.setZoom?.(this.index, this.state === 'foot' && this.equip === 'gun' && !this.showcase ? this.zoomNow : 1);
    if (this.showcase) this.orbitShowcase(dt, target);
  }

  /** Inventory camera: circle the survivor at arm's length and a little above, looking at the chest. */
  private orbitShowcase(dt: number, at: { x: number; y: number; z: number }) {
    const sc = this.showcase!;
    sc.a += dt * 0.45;
    const R = 2.7;
    const want = _v.set(at.x + Math.sin(sc.a) * R, at.y + 1.5, at.z + Math.cos(sc.a) * R);
    // Indoors or in an alley the orbit can pass through a wall: pull the camera in to what is solid, as the chase camera does.
    const chest = _v3.set(at.x, at.y + 1.2, at.z);
    const dir = _v4.copy(want).sub(chest);
    const len = dir.length();
    if (len > 0.01) {
      dir.divideScalar(len);
      const hit = this.cam.occlude(chest, dir, len);
      if (hit < len) want.copy(chest).addScaledVector(dir, Math.max(0.9, hit - 0.3));
    }
    // The camera's right-hand side, so the survivor can sit off to the left of the frame.
    const fx = -Math.sin(sc.a);
    const fz = -Math.cos(sc.a);
    const look = _v2.set(at.x - fz * sc.side, at.y + 1.0, at.z + fx * sc.side);
    if (!sc.pos || !sc.look) {
      sc.pos = this.cam.pos.clone();
      sc.look = this.cam.look.clone();
    }
    const k = 1 - Math.exp(-6 * dt);
    sc.pos.lerp(want, k);
    sc.look.lerp(look, k);
    this.cam.pos.copy(sc.pos);
    this.cam.look.copy(sc.look);
  }

  private _eye = new THREE.Vector3();
  /** The owner's own first-person arms and weapon, and whether they are drawn this frame. */
  readonly view: ViewModel;
  private viewOn = false;
  private _ownCam: THREE.PerspectiveCamera | null = null;

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
    const want = (this.swimming ? lerp(SWIM.eyeAfloat, SWIM.eyeUnder, this.diveK) : this.crouch ? EYE_CROUCH : EYE_STAND) * this.tall;
    // Standing up and crouching take a moment: the head does not snap between heights.
    this.eyeH = damp(this.eyeH, want, 8, dt);
    // A hair forward of the neck so the near plane stays clear of the shoulders. The head bobs and sways with the steps,
    // and goes over to the side the body leans to.
    const g = this.gaitOut;
    const side = g.x - this.lean.roll * 0.35;
    // Lying flat in a crawl the head is well ahead of the hips: the eyes go with it, so the arms swing by behind the view
    // and only the hands reaching out and pulling show.
    this.swimLie = damp(this.swimLie, this.swimming && this.moveSpeed > 0.6 ? 1 : 0, 5, dt);
    const lead = SWIM.lead * this.swimLie * (1 - this.diveK * 0.4);
    if (lead > 0.001) {
      return e.set(target.x + Math.sin(this.aimYaw) * (0.08 + lead), target.y + this.eyeH + g.y, target.z + Math.cos(this.aimYaw) * (0.08 + lead));
    }
    return e.set(target.x + Math.sin(this.aimYaw) * 0.08 - Math.cos(this.aimYaw) * side, target.y + this.eyeH + g.y, target.z + Math.cos(this.aimYaw) * 0.08 + Math.sin(this.aimYaw) * side);
  }

  /**
   * Hide what this seat's own first-person camera sits inside: the body on foot, the occupant in a seat.
   * Called just before the owner's view draws; `endOwnView` puts it back for the partner's view and the next frame.
   */
  beginOwnView(cam?: THREE.Camera) {
    if (!this.viewEyes) return;
    if (this.state === 'foot') {
      const arms = this.viewOn;
      this.human.setFirstPerson(true, arms);
      if (arms) {
        if (!cam) {
          // Not handed the view's camera: put one where this player's camera puts it.
          cam = this._ownCam ??= new THREE.PerspectiveCamera();
          this.cam.apply(this._ownCam);
          cam.updateMatrixWorld();
        }
        this.view.place(cam);
        this.view.root.visible = true;
        this.view.muzzle(this.human.flash.amount);
        // The gun as this view draws it: where its muzzle, port and magazine well really are.
        this.view.capturePoints(this.human.points);
      } else this.human.capturePoints();
    }
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
    this.view.root.visible = false;
    if (this.hiddenOcc) {
      this.hiddenOcc.root.visible = this.hiddenOccWas;
      this.hiddenOcc = null;
    }
  }

  /** Called every render frame. */
  syncVisual(alpha: number, dt: number) {
    const h = this.human;
    const showOnFoot = this.state === 'foot' || this.state === 'downed' || this.state === 'entering';
    const lying = this.state === 'downed' || (this.state === 'foot' && this.drugs.passedOut);
    h.root.visible = showOnFoot;
    if (!showOnFoot) {
      if (this.hold.model) this.hold.model.visible = false;
      return;
    }
    const x = lerp(this.prevPos.x, this.pos.x, alpha);
    const y = lerp(this.prevPos.y, this.pos.y, alpha);
    const z = lerp(this.prevPos.z, this.pos.z, alpha);
    h.root.position.set(x, y, z);
    h.root.rotation.y = this.yaw;
    let aim = this.equip === 'gun' ? clamp(this.ads + (this.muzzleT > 0 ? 0.7 : 0), 0, 1) : 0;
    const weapon = this.heldModel();
    // A swimmer has both hands in the water: the weapon is slung.
    const slung = this.swimming && this.state === 'foot';
    const free = this.state === 'foot' && !lying && !this.carry && !slung && !this.five && !this.action && !this.workAt &&
      !this.buildMode && !this.beltOpen && this.stunT <= 0 && this.moveSpeed < 0.15 && !this.crouch && this.grounded &&
      this.ads < 0.05 && this.intent.rt < 0.1 && this.reloadT <= 0 && this.drawT <= 0 && this.swingT <= 0 && this.muzzleT <= 0;
    this.leisureIdle = this.hero === 'iati' && free ? this.leisureIdle + dt : 0;
    h.leisure = free && this.doseLeisureT > 0 ? this.doseLeisure :
      this.leisureIdle > 3 && !this.firstPerson && !this.hostileNear(28) ? 'relax' : null;
    h.setWeapon(lying || this.carry || slung || h.leisure ? 'none' : weapon, this.heldMods());
    this.syncBeam(lying || !!this.carry || slung || !!h.leisure);
    // A bow comes up as it is drawn, and the arrow is on the string unless the next is still on its way from the quiver.
    h.bowDraw = this.bowDraw;
    h.nocked = this.mag > 0 || (this.reloadT > 0 && 1 - this.reloadT / this.reloadDur > NOCK_SHOWS);
    if (h.bowDraw > 0.02) aim = Math.max(aim, 1);
    h.swing = this.swingT;
    // The barrel wanders, the gun lags behind a turn of the view and rocks with the steps.
    h.gunSway[0] = this.sway[0] + clamp(this.lag.yaw.x, -0.08, 0.08) + this.gaitOut.armX;
    h.gunSway[1] = this.sway[1] + clamp(this.lag.pitch.x, -0.08, 0.08) + this.gaitOut.armY;
    if (this.syncGunPose(h, dt)) aim = Math.max(aim, 0.75);
    this.syncDrill(h, dt, lying || !!this.carry || slung);
    h.gunKick = clamp(this.kick.pitch.x / 0.05, -0.4, 1.6);
    // First person with the rig's own forearms in view (no first-person arms drawn): whatever is in hand is held up in front,
    // where the camera can see it. With the first-person arms drawn the body carries it as anyone would, as the partner sees.
    if (this.firstPerson && !this.viewOn && !this.carry && weapon !== 'none') aim = Math.max(aim, 1);
    if (slung) aim = 0;
    this.syncCarryModel();
    holdFrame(this, x, y, z);
    this.airVis = damp(this.airVis, this.state === 'foot' && !this.grounded && !this.swimming && this.airT > 0.06 ? 1 : 0, 16, dt);
    h.enterRide = this.rideEnter;
    h.enter = this.state === 'entering' ? clamp((this.enterT - this.enterWalk) / ENTER_SECS, 0.001, 1) : 0;
    h.fiveStyle = this.five && this.state === 'foot' ? this.five.style : 0;
    h.five = this.five ? clamp(this.five.t / FIVE_SECS, 0, 1) : 0;
    // Climbing out: the body leaves the seat and settles on the ground, the climb-in pose played backwards.
    if (this.exitT > 0 && this.state === 'foot') {
      const k = this.exitT / EXIT_SECS;
      const w = k * k * (3 - 2 * k);
      const ey = lerp(y, this.exitSeat.y, w);
      h.root.position.set(lerp(x, this.exitSeat.x, w * w), ey, lerp(z, this.exitSeat.z, w * w));
      h.enter = Math.max(0.001, k);
      // Turning out of the seat: from the car's heading to facing away from the door.
      h.root.rotation.y = this.yaw + angleDiff(this.yaw, this.exitYaw) * w;
    } else this.exitT = 0;
    this.syncWork(h, lying);
    h.lean = this.lean.roll;
    h.swim = slung && !lying ? 1 : 0;
    h.swimDive = this.diveK;
    h.swimPitch = this.diveK * clamp(-this.aimPitch * 0.9, -0.6, 1.0);
    h.update(dt, lying ? 'downed' : 'stand', this.moveSpeed, aim, this.crouch ? 1 : 0, this.aimPitch, this.airVis);
    h.viewPitch = this.aimPitch;
    // The flame is there for the first couple of frames after a shot.
    h.muzzle(clamp((this.muzzleT - (MUZZLE_T - FLASH_SECS)) / FLASH_SECS, 0, 1));
    h.capturePoints();
    if (h.leisure) this.viewOn = false;
    else this.syncViewArms(dt, lying);
    if (this.invuln > 0) h.root.visible = Math.floor(this.invuln * 12) % 2 === 0;
  }

  /** The laser dot and torch cone of a light on the gun in hand, shown only while the gun is up and the person is on their feet. */
  private syncBeam(hidden: boolean) {
    const bm = this.equip === 'gun' && !hidden && this.state === 'foot' ? this.kit().beam : null;
    if (!bm) return void this.beam?.hide();
    const b = (this.beam ??= new GunBeam(this.ctx.root));
    const [mx, my, mz] = this.muzzlePos();
    const from = _v5.set(mx, my, mz);
    if (bm === 'laser' || bm === 'both') b.laser(true, from, this.aimPoint);
    else b.laser(false);
    if (bm === 'torch' || bm === 'both') {
      const dir = _v6.copy(this.aimPoint).sub(from);
      if (dir.lengthSq() < 4) dir.set(Math.sin(this.aimYaw), 0, Math.cos(this.aimYaw));
      b.torch(true, from, dir.normalize(), 0.12 + 0.88 * this.ctx.night, this.aimPoint);
    } else b.torch(false);
  }

  /**
   * First person: pose the owner's own arms and weapon for this frame (see `ViewModel`). They are drawn whenever something is
   * in hand, or a punch is thrown; a load in the arms, hands at work on a car and a greeting keep the rig's forearms instead.
   */
  private syncViewArms(dt: number, lying: boolean) {
    const h = this.human;
    this.viewOn = false;
    if (!this.firstPerson || this.state !== 'foot' || lying || this.carry || this.five || this.workAt || this.swimming) return;
    const m = this.view.motion;
    const gp = h.gunPose;
    // Sights come down for a sprint, a draw, a wall and a reload.
    m.ads = this.equip === 'gun' ? clamp(this.ads, 0, 1) * (1 - gp.low) * (1 - gp.high) * (1 - this.reloadBlend) : 0;
    m.lagYaw = clamp(this.lag.yaw.x, -0.12, 0.12);
    m.lagPitch = clamp(this.lag.pitch.x, -0.12, 0.12);
    m.bobX = this.gaitOut.armX;
    m.bobY = this.gaitOut.armY;
    m.dip = this.gait.dip;
    m.strafe = this.strafeV;
    m.fwd = this.hvx * Math.sin(this.aimYaw) + this.hvz * Math.cos(this.aimYaw);
    m.air = this.airVis;
    m.crouch = this.crouch;
    m.lean = this.lean.roll;
    m.back = this.kick.back.x;
    m.flip = this.stepFlip(dt);
    this.view.pose(dt, h);
    this.viewOn = this.view.active;
  }

  /**
   * Now and then, when the last of the enemies near this player has gone down by their hand and the ground is quiet for a
   * moment, the free hand comes off the weapon to give the dead the finger. Returns how far up the hand is, 0 to 1.
   */
  private stepFlip(dt: number): number {
    const ctx = this.ctx;
    const kills = ctx.zombies.killedByPlayer[this.index] + ctx.raiders.killedByPlayer[this.index];
    if (this.flipKills >= 0 && kills > this.flipKills) this.sinceKill = 0;
    this.flipKills = kills;
    this.sinceKill += dt;
    this.flipCd = Math.max(0, this.flipCd - dt);
    if (this.flipT > 0) {
      this.flipT = Math.max(0, this.flipT - dt);
      // Up quickly, held, then down a little slower.
      const age = FLIP_SECS - this.flipT;
      return Math.min(1, age / 0.3, this.flipT / 0.45);
    }
    const busy = this.ads > 0.2 || this.reloadT > 0 || this.sprintBlend > 0.2 || this.drawT > 0;
    if (this.sinceKill > 6 || this.flipCd > 0 || busy || this.hostileNear(28)) {
      this.quietT = 0;
      return 0;
    }
    this.quietT += dt;
    if (this.quietT > 0.9) {
      // One roll per quiet spell after a kill.
      this.sinceKill = 99;
      if (Math.random() < FLIP_CHANCE) {
        this.flipT = FLIP_SECS;
        this.flipCd = 40;
      }
    }
    return 0;
  }

  /** Whether anything still fighting is within `r` metres: infected that are up, raiders on foot or in a car. */
  private hostileNear(r: number): boolean {
    const ctx = this.ctx;
    const x = this.pos.x;
    const z = this.pos.z;
    for (const zb of ctx.zombies.list) if (!zb.dead && (zb.x - x) ** 2 + (zb.z - z) ** 2 < r * r && (zb.chasing || (zb.x - x) ** 2 + (zb.z - z) ** 2 < 100)) return true;
    for (const u of ctx.raiders.units) if (!u.dead && (u.x - x) ** 2 + (u.z - z) ** 2 < r * r * 2.25) return true;
    for (const v of ctx.vehicles) if (v.hostile && (v.position.x - x) ** 2 + (v.position.z - z) ** 2 < r * r * 4) return true;
    return false;
  }

  /**
   * Hand the rig the drill the hands are playing (see `sim/gunDrills`): a fault being cleared, or now and then at rest a
   * habit: a hand re-gripping, a long gun hiked into the shoulder, a magazine patted home, a knife rolled in the fingers.
   */
  private syncDrill(h: Humanoid, dt: number, handsFull: boolean) {
    const d = h.drill;
    if (this.fault && this.reloadT > 0 && this.equip === 'gun' && !handsFull) {
      d.r = this.fault.drill;
      d.t = 1 - this.reloadT / this.reloadDur;
      d.w = 1;
      this.habit = null;
      this.calmT = 0;
      return;
    }
    this.stepHabit(dt, handsFull);
    d.r = this.habit;
    d.t = this.habit ? this.habitT / this.habit.secs : 0;
    d.w = this.habit ? this.habitW : 0;
  }

  /**
   * A habit only starts once the hands have been idle a moment (no shot, no sights, no reload, no swing, no sprint) and
   * stops the instant they are needed, fading out in a few frames, so it never costs a shot.
   */
  private stepHabit(dt: number, handsFull: boolean) {
    const held = this.heldModel();
    const calm =
      !handsFull && held !== 'none' && this.state === 'foot' && !this.five && !this.workAt && !this.action && !this.drugs.passedOut &&
      this.ads < 0.05 && this.reloadT <= 0 && this.swingT <= 0 && this.drawT <= 0 && this.cycleT <= 0 && this.muzzleT <= 0 && this.takedownT <= 0 &&
      this.sprintBlend < 0.1 && this.wallBlend < 0.1 && this.bowString.k < 0.01 && this.flipT <= 0 && this.intent.rt < 0.3;
    this.calmT = calm ? this.calmT + dt : 0;
    const hb = this.habit;
    if (hb) {
      const from = this.habitT / hb.secs;
      this.habitT += dt;
      const to = this.habitT / hb.secs;
      if (calm && hb.cues) {
        const handling = weaponHandling(this.gunModel());
        for (const [at, cue, volume] of hb.cues) {
          if (from >= at || to < at) continue;
          const s = CUE_SOUND[cue](handling);
          this.ctx.audio.play(s.cue, this.pos.x, this.pos.z, volume, { bank: s.bank, pitch: handling.pitch });
        }
      }
      this.habitW = calm ? 1 : damp(this.habitW, 0, 24, dt);
      if (to >= 1 || this.habitW < 0.02) {
        this.habitLast = hb.id;
        this.habit = null;
        this.habitW = 0;
        this.habitIn = habitGap();
      }
      return;
    }
    if (this.calmT < HABIT.settle) return;
    this.habitIn -= dt;
    if (this.habitIn > 0) return;
    this.habit = pickHabit(held, Math.random(), this.habitLast);
    this.habitT = 0;
    this.habitW = 1;
    this.habitIn = habitGap();
  }

  /** Hand the rig how the gun is being handled this frame. Returns whether the gun must be up in front of the body. */
  private syncGunPose(h: Humanoid, dt: number): boolean {
    const gp = h.gunPose;
    const gun = this.equip === 'gun' && !this.carry && this.state === 'foot';
    if (!gun) {
      gp.low = gp.high = gp.tilt = gp.pitch = gp.down = gp.rack = 0;
      this.reloadBlend = 0;
      return false;
    }
    const model = this.gunModel();
    const kind = RELOAD_KIND[model];
    const reloading = this.reloadT > 0;
    this.reloadBlend = damp(this.reloadBlend, reloading ? 1 : 0, 14, dt);
    const p = this.pose;
    p.tilt = p.pitch = p.down = p.rack = 0;
    if (reloading && model === 'bow') {
      // Nocking: the draw hand goes to the quiver at the hip and brings the next arrow back to the string.
      p.down = curve([[0, 0], [0.3, 1], [0.45, 1], [NOCK_SHOWS, 0.15], [1, 0]], 1 - this.reloadT / this.reloadDur);
    } else if (reloading && this.fault) {
      // Clearing a fault: the hands play its own drill (`syncDrill`), not a reload.
    } else if (reloading) {
      // A pump is loaded a shell at a time, the routine repeating for each; the rest take the reload through once.
      const t = this.loadEach > 0 ? (this.reloadT > this.loadEach ? 0 : 1 - this.reloadT / this.loadEach) : 1 - this.reloadT / this.reloadDur;
      reloadPose(kind, t, p);
    } else if (this.cycleT > 0) p.rack = cycleRack(1 - this.cycleT / this.cycleDur);
    const rb = reloading ? this.reloadBlend : 1;
    gp.low = Math.max(this.sprintBlend, drawLow(this.drawT, this.drawDur)) * (1 - this.reloadBlend);
    gp.high = this.wallBlend * (1 - gp.low) * (1 - this.reloadBlend);
    gp.tilt = p.tilt * rb;
    gp.pitch = p.pitch * rb;
    gp.down = p.down * rb;
    gp.rack = p.rack * rb;
    gp.bolt = model === 'rifle';
    return reloading;
  }

  private carryKey = '';

  /** Tell the body where its hands are working, in its own frame, while a job on a car runs. */
  private syncWork(h: Humanoid, lying: boolean) {
    const at = this.workAt;
    if (!at || lying || this.state !== 'foot') {
      h.workAmt = 0;
      return;
    }
    h.workAmt = 1;
    const dx = at.x - this.pos.x;
    const dz = at.z - this.pos.z;
    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);
    h.workAt.set(dx * cy - dz * sy, at.y - this.pos.y, dx * sy + dz * cy);
  }

  /** Show what is in the arms, rebuilding the model only when it changes kind. */
  private syncCarryModel() {
    const c = this.ctx.work.holding(this.index) || holdFloats(this) ? null : this.carry;
    const key = !c ? '' : carryModelKey(c);
    if (key === this.carryKey) return;
    this.carryKey = key;
    this.human.setCarry(key ? makeCarryModel(key) : null);
  }

  destroy() {
    returnCarry(this);
    disposeHold(this);
    this.ctx.P.world.removeCollider(this.collider, false);
    this.ctx.P.kinematicVelocity.delete(this.body.handle);
    this.ctx.P.world.removeRigidBody(this.body);
    this.ctx.P.world.removeCharacterController(this.kcc);
    this.human.root.removeFromParent();
    this.human.dispose();
    this.beam?.dispose();
    this.view.dispose();
  }
}

function it0(v: number) {
  return v;
}

/** What raw water tastes like, by where it came from (and its name, where it has one), and whether it sat badly. */
function rawDrinkText(kind: WaterSource, name: string | undefined, dirty: boolean): string {
  switch (kind) {
    case 'spring':
      return `You drink from ${name ?? 'the spring'}: cold and clean`;
    case 'river':
    case 'stream': {
      const from = name ?? `the ${kind}`;
      return dirty ? `You drink from ${from}. Something upstream died in it: your stomach turns` : `You drink from ${from}: cold, and it tastes of stone`;
    }
    case 'swamp':
      return dirty ? 'You drink swamp water. It tastes of rot: your stomach turns' : 'You drink swamp water. Brown and warm, but it stays down';
    case 'flood':
    case 'pool':
      return dirty ? 'You drink flood water. Half of it is silt: your stomach turns' : 'You drink flood water. Gritty and warm, but it stays down';
    default:
      return dirty ? `You drink from ${name ?? 'the lake'}. It tastes of mud: your stomach turns` : `You drink from ${name ?? 'the lake'}`;
  }
}

function wasPressedOrFresh(it: PlayerIntent) {
  return (it.pressed & (1 << Btn.A)) !== 0 || it.heldTime[Btn.A] < 0.4;
}

export function utilityName(u: Utility) {
  return u === 'flare' ? 'Flare' : u === 'molotov' ? 'Molotov' : u === 'charge' ? 'Breaching charge' : 'Decoy horn';
}

export type InteractableLike = Interactable;
