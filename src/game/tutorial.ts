import * as THREE from 'three';
import { PROMPT_ACTION, keyLabel, live, padLabel, padPhysical, type ActionId } from '../input/bindings';
import { promptLabel, type Slot } from '../input/input';
import { makeBeam } from '../render/props';
import { disposeTree } from '../render/dispose';
import { wrapAngle } from '../core/math';
import { PLAYER_CSS } from '../render/palette';
import type { CoachUI, CoachView } from '../ui/coach';
import type { LegScene } from './legScene';
import type { Player } from './player';
import type { Zombie } from './zombies';
import type { ScavContainer } from '../world/layout';

/** Per player, per lesson scratch space for the goal tests. */
type Mem = Record<string, number>;

interface Ctx {
  sc: LegScene;
  p: Player;
  d: TutorialDirector;
  /** This player's scratch space for this goal. */
  m: Mem;
  dt: number;
}

interface Goal {
  id: string;
  label: string;
  test: (c: Ctx) => boolean;
  /** One person's doing it counts for everybody (a shared supply crate, a kill). */
  shared?: boolean;
}

interface Step {
  id: string;
  title: string;
  /** Lesson text. `{action}` becomes the key or button this seat has bound. */
  body: string;
  goals: Goal[];
  enter?: (d: TutorialDirector, sc: LegScene) => void;
  /** Where the lesson wants people to look: a beam in the world and a pin on the compass. */
  marks?: (d: TutorialDirector, sc: LegScene) => { x: number; z: number }[];
}

/** Seconds a finished lesson stays on screen before the next one. */
const LINGER = 1.6;
/** Seconds without finishing before the card offers a way out. */
const STUCK_AFTER = 45;

const dist = (ax: number, az: number, bx: number, bz: number) => Math.hypot(ax - bx, az - bz);

// ------------------------------------------------------------------ naming the controls

/** The prompt name (`A`, `RT`...) the HUD uses for each action, so a lesson says what the prompts say. */
const PROMPT_NAME = Object.fromEntries(Object.entries(PROMPT_ACTION).map(([name, id]) => [id, name]));

/** What this seat presses for an action, as a plain string. */
export function bindName(slot: Slot | null, id: ActionId): string {
  const prompt = PROMPT_NAME[id];
  if (prompt) return promptLabel(slot, prompt);
  const b = live.bindings;
  if (slot?.kind === 'kb') {
    const code = b.kb[slot.set - 1][id] ?? (id === 'aim' || id === 'melee' ? b.kb[slot.set - 1].fire : undefined);
    return code ? keyLabel(code) : id;
  }
  return padLabel(padPhysical(b.pad, id));
}

const cap = (s: string) => `<kbd>${s}</kbd>`;

/** Turns `{interact}` style tokens in a lesson into key caps for one seat. */
export function fillTokens(text: string, slot: Slot | null, seat: number): string {
  const b = live.bindings;
  const kbSet = slot?.kind === 'kb' ? b.kb[slot.set - 1] : null;
  const keys = (...ids: ActionId[]) => ids.map((i) => cap(kbSet ? keyLabel(kbSet[i]) : padLabel(padPhysical(b.pad, i)))).join('');
  const special: Record<string, () => string> = {
    move: () => (kbSet ? keys('moveUp', 'moveLeft', 'moveDown', 'moveRight') : cap('L-STICK')),
    look: () => (kbSet ? (live.mouseSeat === seat ? cap('MOUSE') : keys('turnLeft', 'turnRight')) : cap('R-STICK')),
    steer: () => (kbSet ? keys('moveLeft', 'moveRight') : cap('L-STICK')),
    throttle: () => (kbSet ? keys('moveUp') : cap(padLabel(padPhysical(b.pad, 'fire')))),
    brake: () => (kbSet ? keys('moveDown') : cap(padLabel(padPhysical(b.pad, 'aim')))),
    hold: () => 'hold',
  };
  return text.replace(/\{(\w+)\}/g, (_, k: string) => (special[k] ? special[k]() : cap(bindName(slot, k as ActionId))));
}

// ------------------------------------------------------------------ the lessons

const STEPS: Step[] = [
  {
    id: 'walk',
    title: 'Walk and look',
    body: 'Welcome to training. You are on foot, next to your moped. Move with {move} and look around with {look}.',
    goals: [
      {
        id: 'move',
        label: 'Walk about eight metres',
        test: ({ p, m }) => {
          if (p.state !== 'foot') return false;
          if (m.lx !== undefined) m.d = (m.d ?? 0) + dist(p.pos.x, p.pos.z, m.lx, m.lz);
          m.lx = p.pos.x;
          m.lz = p.pos.z;
          return (m.d ?? 0) >= 8;
        },
      },
      {
        id: 'look',
        label: 'Turn right round',
        test: ({ p, m }) => {
          if (m.ly !== undefined) m.t = (m.t ?? 0) + Math.abs(wrapAngle(p.aimYaw - m.ly));
          m.ly = p.aimYaw;
          return (m.t ?? 0) >= 2.4;
        },
      },
    ],
  },
  {
    id: 'moves',
    title: 'Sprint, jump, crouch',
    body: 'Hold {sprint} while moving to sprint, tap {jump} to jump (when nothing is in reach), and {crouch} to crouch. Sprinting and jumping spend stamina, and noise gives you away.',
    goals: [
      { id: 'sprint', label: 'Sprint for a second', test: ({ p, m, dt }) => (p.state === 'foot' && p.moveSpeed > 4.6 ? (m.s = (m.s ?? 0) + dt) : (m.s ?? 0)) >= 0.8 },
      { id: 'jump', label: 'Jump', test: ({ p }) => p.state === 'foot' && !p.grounded },
      { id: 'crouch', label: 'Crouch', test: ({ p }) => p.state === 'foot' && p.crouch },
    ],
  },
  {
    id: 'shoot',
    title: 'Aim, shoot, reload',
    body: 'Two of the infected stand ahead, asleep. Hold {aim} to look down the sights, {fire} to shoot, {reload} to reload. Shots are loud: that is what wakes them.',
    enter: (d, sc) => {
      const at = d.ahead(sc, 26);
      d.targets = [d.zombie(sc, at.x - 2.5, at.z), d.zombie(sc, at.x + 2.5, at.z + 3)];
    },
    marks: (d) => d.targets.filter((z) => !z.dead).map((z) => ({ x: z.x, z: z.z })),
    goals: [
      { id: 'aim', label: 'Aim down the sights', test: ({ p }) => p.state === 'foot' && p.ads > 0.6 },
      {
        id: 'fire',
        label: 'Fire the pistol',
        test: ({ p, m }) => {
          if (m.mag !== undefined && p.mag < m.mag) m.shot = 1;
          m.mag = p.mag;
          return !!m.shot;
        },
      },
      { id: 'reload', label: 'Reload', test: ({ p, m }) => (p.reloadT > 0 ? (m.r = 1) : (m.r ?? 0)) > 0 },
      { id: 'kill', label: 'Put both of them down', shared: true, test: ({ d }) => d.targets.length > 0 && d.targets.every((z) => z.dead) },
    ],
  },
  {
    id: 'loot',
    title: 'Take what you find',
    body: 'Nothing is picked up by walking over it. Stand beside it and {hold} {interact}. Search the crate the same way: searching is loud, so be quick.',
    enter: (d, sc) => {
      const at = d.ahead(sc, 9);
      const right = d.right();
      d.loot = [sc.trainingGoods('ammo', 20, at.x + right.x * 2, at.z + right.z * 2), sc.trainingGoods('rations', 2, at.x - right.x * 2, at.z - right.z * 2)];
      d.crate = sc.trainingCrate(at.x + 8, at.z + 4);
    },
    marks: (d, sc) => d.lootSpots(sc),
    goals: [
      { id: 'take', label: 'Take the ammo and the rations', shared: true, test: ({ sc, d }) => d.loot.length > 0 && d.loot.every((id) => !sc.hasPickup(id)) },
      { id: 'search', label: 'Search the supply crate', shared: true, test: ({ d }) => !!d.crate?.taken },
    ],
  },
  {
    id: 'enter',
    title: 'Get in your moped',
    body: 'Walk to your moped (it is marked) and {hold} {vehicle} to climb in. Abandoned cars on the road work the same way, and become yours.',
    marks: (_d, sc) => sc.players.flatMap((p) => (p.ownVehicle && p.state === 'foot' ? [{ x: p.ownVehicle.position.x, z: p.ownVehicle.position.z }] : [])),
    goals: [{ id: 'in', label: 'Get in and start the engine', test: ({ p }) => p.state === 'driving' }],
  },
  {
    id: 'drive',
    title: 'Drive',
    body: '{throttle} to go, {brake} to brake, {steer} to steer. Tap {crouch} for the headlights. {interact} is the handbrake. Keep it on the road and put a hundred metres behind you.',
    goals: [
      {
        id: 'go',
        label: 'Drive about a hundred metres',
        test: ({ p, m, dt }) => {
          if (p.vehicle) m.d = (m.d ?? 0) + Math.abs(p.vehicle.speed) * dt;
          return (m.d ?? 0) >= 100;
        },
      },
      { id: 'lights', label: 'Switch the headlights on', test: ({ p }) => !!p.vehicle?.lights },
    ],
  },
  {
    id: 'noise',
    title: 'Noise and dust',
    body: 'Look at the meter in your top-left corner. Engines throw <b>dust</b>, which raiders see, and <b>noise</b>, which the infected hear. It climbs with your speed. Open the throttle, then tap {horn}: a horn sends it through the roof.',
    goals: [
      { id: 'fast', label: 'Get up to about 35 km/h', test: ({ p }) => !!p.vehicle && Math.abs(p.vehicle.speed) > 9.5 },
      { id: 'meter', label: 'Honk and watch the meter spike', test: ({ p }) => p.signatureShown >= 30 },
    ],
  },
  {
    id: 'exit',
    title: 'Park and get out',
    body: 'Ease off, then {hold} {vehicle} to climb out. Parking and walking is quiet: the meter falls straight back down. (Hold it at speed and you bail out, which hurts.)',
    goals: [{ id: 'out', label: 'Get out of the moped', test: ({ p }) => p.state === 'foot' }],
  },
  {
    id: 'fix',
    title: 'Wrench and can',
    body: 'Your moped is hurt and nearly dry. Press {swap} until you hold the wrench, stand at the moped and {hold} {interact} to repair. Then {hold} {interact} beside your fuel can (it is marked) to lift it, carry it over, and {hold} {interact} again to pour.',
    enter: (d, sc) => {
      for (const p of sc.players) {
        const v = p.ownVehicle;
        if (!v) continue;
        v.health.hp = v.health.maxHp * 0.45;
        v.fuel = v.tankMax * 0.08;
        // Set well off, outward from the pair, so the can is not reached for before the wrench.
        const r = d.right();
        const side = sc.players.length > 1 && p.index === 1 ? -1 : 1;
        d.cans.set(p.index, sc.trainingCan(v.position.x + r.x * 7 * side, v.position.z + r.z * 7 * side));
      }
    },
    marks: (d, sc) => [
      ...sc.players.flatMap((p) => (p.ownVehicle ? [{ x: p.ownVehicle.position.x, z: p.ownVehicle.position.z }] : [])),
      ...[...d.cans.values()].flatMap((id) => {
        const at = sc.pickupAt(id);
        return at ? [at] : [];
      }),
    ],
    goals: [
      { id: 'wrench', label: 'Hold the wrench', test: ({ p, m }) => (p.equip === 'wrench' ? (m.w = 1) : (m.w ?? 0)) > 0 },
      {
        id: 'repair',
        label: 'Repair the moped',
        test: ({ p, m }) => {
          const v = p.ownVehicle;
          if (!v) return true;
          m.hp ??= v.health.hp;
          return v.health.hp > m.hp + v.health.maxHp * 0.08;
        },
      },
      { id: 'lift', label: 'Lift the fuel can', test: ({ p, m }) => (p.carry?.kind === 'fuel' ? (m.c = 1) : (m.c ?? 0)) > 0 },
      {
        id: 'pour',
        label: 'Pour it into the tank',
        test: ({ p, m }) => {
          const v = p.ownVehicle;
          if (!v) return true;
          m.f ??= v.fuel;
          return v.fuel > m.f + 0.5;
        },
      },
    ],
  },
  {
    id: 'map',
    title: 'Map and pings',
    body: 'Tap {map} to open the map: tap again for the whole country, once more to close. Tap {wheel} to ping the spot you are aiming at for your partner.',
    goals: [
      { id: 'map', label: 'Open the map', test: ({ p, m }) => (p.mapMode > 0 ? (m.o = 1) : (m.o ?? 0)) > 0 },
      {
        id: 'ping',
        label: 'Ping somewhere',
        test: ({ sc, p, m }) => {
          const n = sc.pings.filter((q) => q.who === p.index).length;
          if (m.n !== undefined && n > m.n) m.pinged = 1;
          m.n = n;
          return !!m.pinged;
        },
      },
    ],
  },
  {
    id: 'pack',
    title: 'Your pack',
    body: 'Press {inventory} to open your inventory. Armour, masks and boots change what hurts you; guns and tools sit on the four-slot belt. The game waits while it is open.',
    goals: [{ id: 'open', label: 'Open the inventory', test: ({ p, d }) => d.seen('inventory', p.index) }],
  },
  {
    id: 'camp',
    title: 'Make camp',
    body: 'The Dusk Bell is ringing. Step well away from your moped, and {hold} {interact} where you stand to make camp. (In a real run you then vote on a camp and build defences for the night.)',
    enter: (_d, sc) => {
      sc.clock.frozen = false;
      sc.clock.skipToDusk();
    },
    goals: [{ id: 'camp', label: 'Hold to make camp', shared: true, test: ({ d }) => d.seen('camp', 0) }],
  },
];

export const TRAINING_STEPS = STEPS.length;

// ------------------------------------------------------------------ the director

/**
 * Runs the training lessons inside an ordinary open-world scene: sets each lesson up (a few sleepers to shoot, a crate,
 * a damaged moped), watches the players for what the lesson asks, and tells the coach cards what to show. Nothing here
 * changes how the game plays; it only reads, spawns and points.
 */
export class TutorialDirector {
  index = 0;
  finished = false;
  /** Set when the last lesson is done; the Game then ends training. */
  onFinish: () => void = () => {};
  targets: Zombie[] = [];
  loot: string[] = [];
  crate: ScavContainer | null = null;
  cans = new Map<number, string>();

  private entered = -1;
  private done: boolean[][] = [];
  private mem: Mem[][] = [];
  private lingerT = 0;
  private stuckT = 0;
  private events = new Set<string>();
  private beams: THREE.Mesh[] = [];
  private origin: { x: number; z: number; yaw: number } | null = null;
  private time = 0;

  constructor(private ui: CoachUI) {}

  /** A person did something the director cannot see from game state alone (opened a menu, made camp). */
  note(kind: string, seat = 0) {
    this.events.add(`${kind}:${seat}`);
  }
  seen(kind: string, seat: number) {
    return this.events.has(`${kind}:${seat}`);
  }

  /** Jump past the lesson in progress (the pause menu offers it when somebody is stuck). */
  skip() {
    if (this.finished) return;
    this.advance();
  }

  private get step(): Step {
    return STEPS[this.index];
  }

  // ---- helpers for the lessons

  private centre(sc: LegScene) {
    let x = 0;
    let z = 0;
    let n = 0;
    for (const p of sc.players) {
      x += p.vehicle ? p.vehicle.position.x : p.pos.x;
      z += p.vehicle ? p.vehicle.position.z : p.pos.z;
      n++;
    }
    return { x: x / Math.max(1, n), z: z / Math.max(1, n) };
  }

  /** A point `m` metres from the players along the road they started on. */
  ahead(sc: LegScene, m: number) {
    const c = this.centre(sc);
    const yaw = this.origin?.yaw ?? 0;
    return { x: c.x + Math.sin(yaw) * m, z: c.z + Math.cos(yaw) * m };
  }
  right() {
    const yaw = this.origin?.yaw ?? 0;
    return { x: Math.cos(yaw), z: -Math.sin(yaw) };
  }
  zombie(sc: LegScene, x: number, z: number) {
    return sc.zombies.spawn('walker', x, z, true);
  }

  // ---- marks

  private clearMarks(sc: LegScene) {
    for (const b of this.beams) {
      b.removeFromParent();
      disposeTree(b);
    }
    this.beams = [];
    sc.trainingPins = [];
  }

  private placeMarks(sc: LegScene) {
    const spots = this.step.marks?.(this, sc) ?? [];
    while (this.beams.length > spots.length) {
      const b = this.beams.pop()!;
      b.removeFromParent();
      disposeTree(b);
    }
    while (this.beams.length < spots.length) {
      const b = makeBeam(0xffb454, 40);
      b.renderOrder = 4;
      sc.root.add(b);
      this.beams.push(b);
    }
    spots.forEach((s, i) => {
      this.beams[i].position.set(s.x, sc.groundAt(s.x, s.z) + 20, s.z);
    });
    sc.trainingPins = spots.map((s) => ({ x: s.x, z: s.z, kind: 'exit' as const, label: 'HERE' }));
  }

  /** Where the lesson's goods and crate lie, for as long as they are still there. */
  lootSpots(sc: LegScene) {
    const out: { x: number; z: number }[] = [];
    for (const id of this.loot) {
      const e = sc.pickupAt(id);
      if (e) out.push(e);
    }
    if (this.crate && !this.crate.taken) out.push({ x: this.crate.x, z: this.crate.z });
    return out;
  }

  // ---- the tick

  tick(sc: LegScene, dt: number) {
    if (this.finished || sc.paused) return;
    this.time += dt;
    this.origin ??= { x: sc.players[0].pos.x, z: sc.players[0].pos.z, yaw: sc.players[0].yaw };
    this.keepSafe(sc, dt);
    if (this.entered !== this.index) this.enter(sc);
    const step = this.step;
    const seats = sc.players.length;
    let all = true;
    for (let gi = 0; gi < step.goals.length; gi++) {
      const goal = step.goals[gi];
      for (let i = 0; i < seats; i++) {
        if (this.done[gi][i]) continue;
        const p = sc.players[i];
        if (goal.test({ sc, p, d: this, m: this.mem[gi][i], dt })) {
          this.done[gi][i] = true;
          if (goal.shared) this.done[gi].fill(true);
          sc.audio.play('click');
        }
      }
      if (!this.done[gi].slice(0, seats).every(Boolean)) all = false;
    }
    if (all) {
      if (this.lingerT === 0) sc.audio.play('confirm');
      this.lingerT += dt;
      if (this.lingerT > LINGER) {
        this.advance();
        return;
      }
    } else {
      this.lingerT = 0;
      this.stuckT += dt;
    }
    this.placeMarks(sc);
    this.paint(sc, all);
  }

  private enter(sc: LegScene) {
    this.entered = this.index;
    this.lingerT = 0;
    this.stuckT = 0;
    const step = this.step;
    const seats = sc.players.length;
    this.done = step.goals.map(() => new Array(seats).fill(false));
    this.mem = step.goals.map(() => Array.from({ length: seats }, () => ({}) as Mem));
    step.enter?.(this, sc);
    if (step.id !== 'walk') sc.audio.play('beep', undefined, undefined, 0.5);
  }

  private advance() {
    this.index++;
    if (this.index >= STEPS.length) {
      this.finished = true;
      this.ui.hide();
      if (this.scene) this.clearMarks(this.scene);
      this.onFinish();
    }
  }

  private scene: LegScene | null = null;
  private downFor = [0, 0];

  /** Training is forgiving: nobody bleeds out. A player who goes down is back on their feet after a couple of seconds. */
  private keepSafe(sc: LegScene, dt: number) {
    this.scene = sc;
    for (const p of sc.players) {
      this.downFor[p.index] = p.state === 'downed' ? this.downFor[p.index] + dt : 0;
      if (this.downFor[p.index] > 2.5) {
        p.revive(1 - p.index);
        this.downFor[p.index] = 0;
      }
    }
  }

  private paint(sc: LegScene, all: boolean) {
    const step = this.step;
    const seats = sc.players.length;
    for (let i = 0; i < seats; i++) {
      const slot = sc.input.slots[i] ?? null;
      const goals = step.goals.map((g, gi) => ({ label: g.label, done: this.done[gi][i], others: this.done[gi].slice(0, seats).filter((x, k) => k !== i && x).length }));
      const mine = goals.every((g) => g.done);
      const view: CoachView = {
        n: this.index + 1,
        of: STEPS.length,
        title: step.title,
        body: fillTokens(step.body, slot, i),
        goals,
        color: PLAYER_CSS[i],
        complete: all,
        waiting: mine && !all && seats > 1 ? `Done. Waiting for ${sc.players[1 - i]?.name ?? 'your partner'}…` : '',
        stuck: this.stuckT > STUCK_AFTER && !all,
      };
      this.ui.render(i, view);
    }
    for (let i = seats; i < 2; i++) this.ui.hide(i);
  }

  dispose(sc?: LegScene | null) {
    if (sc) this.clearMarks(sc);
    else for (const b of this.beams) b.removeFromParent();
    this.ui.dispose();
  }
}
