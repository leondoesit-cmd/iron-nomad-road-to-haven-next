import * as THREE from 'three';
import { clamp, damp, smoothstep, wrapAngle } from '../core/math';
import type { HeroId } from '../data/heroes';
import { newGear } from '../sim/gear';
import { COFFEE_TOP, GARDEN_LAYOUT, PARTY, type PartyHeld, type PartySpot } from '../world/ududHouse';
import { MeshBuilder, S } from './builder';
import { BurgerEater, beerBottleGeometry } from './burger';
import { CakeEater } from './cake';
import { shared } from './dispose';
import { Humanoid } from './humanoid';
import { kitMaterial } from './materials';
import { identityOf, lookOf, type OutfitLook } from './outfit';
import { smokeTexture } from './proctex';
import { UdudLounger } from './udud';

/**
 * The people at the barbecue in Udud and Nuhat's garden (`world/ududHouse.ts` says where each sits and what they do), in
 * their own clothes: their own tops, jeans or dark trousers and trainers, bare-headed, nothing on their backs. They sit
 * round the crowded coffee table by the sofa with their takeaway in their hands and on their knees: Nuhat and Udud nearest
 * the house door, Nar on the end of the sofa nearest the way out with a glass of tea, Iati on the chair beside him smoking,
 * the Karab brothers across from the sofa (Lag with the cake on his knees and his big spoon, Ro with his burger and beer),
 * and Chinsky and Leo, when neither is out on the road, on the rest of the sofa with a pita each. Amirat at the grill out on
 * the lawn is the garden model's (`render/amiratGarden.ts`).
 *
 * Iati can `bless` someone: a long drag and a cloud of smoke blown across to them (`blessHit` says when it gets there).
 * `high` (0..1, whoever is watching) makes the party strange: Lag's spoon and cake grow, Ro's burger swells, people float
 * up off their seats and sway, Udud's glasses leave his face and circle his head, Nar's tea glass drifts up out of his hand.
 *
 * Everything is in the house's frame (`group` goes where the house's root is). Heroes in `absent` (the players) are left out
 * and their places stay empty. Call `update(dt, look)` every frame, `look` being where the nearest player's head is (house
 * frame) or null.
 */

/** Trouser and trainer colours for the party, per hero. */
const PARTY_CLOTHES: Partial<Record<HeroId, { legs: number; feet: number; sole: number }>> = {
  chinsky: { legs: 0x2f3a4f, feet: 0x2b2b2e, sole: 0xe6e2d6 },
  leo: { legs: 0x3d4b66, feet: 0xe9e6dd, sole: 0xf4f2ea },
  nar: { legs: 0x6a604e, feet: 0x5a4632, sole: 0x2a241e },
  lag: { legs: 0x24272c, feet: 0x1f2022, sole: 0xe8e4d8 },
  ro: { legs: 0x2c3646, feet: 0x3a3a3c, sole: 0xdedad0 },
  nuhat: { legs: 0x1f1e24, feet: 0xd9cbb4, sole: 0xc9b89a },
  udud: { legs: 0x3b4a5e, feet: 0x3b3328, sole: 0xd6d0c2 },
  iati: { legs: 0x8a7556, feet: 0x6b4b30, sole: 0x2a2018 },
};

/** What a hero wears to the barbecue. */
export function partyLook(hero: HeroId): OutfitLook {
  const worn = hero === 'iati' ? { legs: newGear('l_iati') } : {};
  const look = lookOf(worn);
  const c = PARTY_CLOTHES[hero] ?? { legs: 0x2f3a4f, feet: 0x2b2b2e, sole: 0xe6e2d6 };
  if (hero !== 'iati') look.legs = { style: 'trousers', c: c.legs };
  look.feet = { style: 'sneakers', c: c.feet, c2: c.sole };
  return look;
}

let teaGeometry: THREE.BufferGeometry | undefined;
/** A small glass of tea with mint. Origin at the bottom of the glass. */
function teaGlass() {
  if (teaGeometry) return teaGeometry;
  const b = new MeshBuilder();
  b.jitter = 0;
  b.lathe('tea-glass', [[0, 0], [0.026, 0], [0.028, 0.004], [0.031, 0.06], [0.034, 0.095], [0.032, 0.095], [0.029, 0.06], [0.026, 0.006], [0, 0.006]], 0, 0, 0, { c: 0xe8eef0, r: 0.08, m: 0, w: 0 }, 0, 0, 0, 16);
  b.cyl(0, 0.04, 0, 0.027, 0.065, 0.027, { c: 0x9a4a12, r: 0.1, m: 0, w: 0 }, 0, 0, 0, 14);
  for (let i = 0; i < 3; i++) b.add('sphere', Math.cos(i * 2.1) * 0.012, 0.074, Math.sin(i * 2.1) * 0.012, 0.012, 0.004, 0.009, S.cloth(0x3f7a35, 0), 0, i, 0);
  return (teaGeometry = shared(b.build()));
}

let pitaGeometry: THREE.BufferGeometry | undefined;
/**
 * A pita stuffed with falafel and salad, the bottom half still in its paper. Origin in the middle of the pita; it stands up
 * along +Y with its open top toward +Y.
 */
function pitaSandwich() {
  if (pitaGeometry) return pitaGeometry;
  const b = new MeshBuilder();
  b.jitter = 0.01;
  b.add('sphere16', 0, 0, 0, 0.16, 0.15, 0.06, S.cloth(0xe2bd82, 0.05));
  // Paper wrapped round the bottom.
  b.rbox(0, -0.035, 0, 0.17, 0.08, 0.065, 0.02, S.cloth(0xf2eee4, 0.04));
  // The filling at the open top: falafel, tomato, cucumber, a smear of tahini.
  for (let k = 0; k < 4; k++) b.add('sphere', -0.045 + k * 0.03, 0.062, (k % 2 - 0.5) * 0.012, 0.028, 0.026, 0.028, S.cloth(0x6d4a22, 0.05));
  b.add('sphere', -0.02, 0.07, 0.012, 0.03, 0.012, 0.022, { c: 0xc8301e, r: 0.4, m: 0, w: 0 });
  b.add('sphere', 0.035, 0.07, -0.01, 0.026, 0.01, 0.02, { c: 0x5f8f32, r: 0.4, m: 0, w: 0 });
  b.add('sphere', 0.005, 0.074, 0, 0.05, 0.008, 0.03, { c: 0xe8dcbc, r: 0.5, m: 0, w: 0 });
  return (pitaGeometry = shared(b.build()));
}

let jointGeometry: THREE.BufferGeometry | undefined;
/** A fat joint: the paper cone along +Z, the roach at the origin, the lit end out at +Z glowing. */
function joint() {
  if (jointGeometry) return jointGeometry;
  const b = new MeshBuilder();
  b.jitter = 0.01;
  b.limb(0, 0, 0, 0, 0, 0.085, 0.0042, 0.0068, S.cloth(0xe9e0c8, 0.01), 10);
  b.cyl(0, 0, 0.008, 0.009, 0.016, 0.009, S.cloth(0xbda77c, 0.01), Math.PI / 2, 0, 0, 10);
  b.cyl(0, 0, 0.086, 0.0135, 0.006, 0.0135, S.glow(0xe35b22, 1.8), Math.PI / 2, 0, 0, 10);
  b.cyl(0, 0, 0.091, 0.012, 0.004, 0.012, S.cloth(0x777367, 0.01), Math.PI / 2, 0, 0, 10);
  return (jointGeometry = shared(b.build()));
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _m = new THREE.Vector3();

/** One person at the party: their rig, what holds it (an eater, a lounger or just a group), and what they're up to. */
export interface PartyPerson {
  hero: HeroId;
  spot: PartySpot;
  h: Humanoid;
  /** The object placed at the spot (the eater's or lounger's group, or a group with the rig and what's in its hand). */
  root: THREE.Object3D;
  /** What is in the right hand, for those who hold something. */
  prop?: THREE.Mesh;
}

/** A puff of smoke: where it is and drifts (house frame), how old, how long it lasts, how big it ends up. */
interface Puff {
  s: THREE.Sprite;
  v: THREE.Vector3;
  age: number;
  life: number;
  size0: number;
  size1: number;
  alpha: number;
  /** Blown at someone: it slows as it reaches them and hangs round their head. */
  to?: THREE.Vector3;
}

/** Where the talk is: Nuhat, telling a story by the house door, and the sofa she tells it to. */
const STORYTELLER: [number, number] = [GARDEN_LAYOUT.chairs[0][0], GARDEN_LAYOUT.chairs[0][1]];
const AUDIENCE: [number, number] = [GARDEN_LAYOUT.sofa[0], GARDEN_LAYOUT.sofa[1] + 0.3];

/** The blessing, seconds from its start: turn, the long drag, the cloud blown across, and when it reaches them. */
const BLESS = { turn: 0.6, drag: [0.5, 2.3] as const, blow: [2.4, 3.9] as const, hit: 3.6, end: 6 };

export class PartyCast {
  readonly group = new THREE.Group();
  readonly people: PartyPerson[] = [];
  /** How high whoever is watching is, 0..1. Set it every frame. */
  high = 0;
  private cake: CakeEater | null = null;
  private burger: BurgerEater | null = null;
  private lounger: UdudLounger | null = null;
  private time = 0;
  /** A wave hello, counting down, per person. */
  private wave = new Map<HeroId, number>();
  private headY = new Map<HeroId, number>();
  private puffs: Puff[] = [];
  private nextPuff = 0;
  private blessAt = -1;
  private blessTo = new THREE.Vector3();
  private blessHitDone = true;

  constructor(absent: ReadonlySet<HeroId>) {
    this.group.name = 'party-cast';
    for (const spot of PARTY) {
      if (spot.activity === 'grill' || absent.has(spot.hero)) continue;
      const h = new Humanoid({ ...identityOf(spot.hero === 'leo' ? 1 : 0), look: partyLook(spot.hero), hero: spot.hero });
      h.setWeapon('none');
      h.root.name = `party-${spot.hero}`;
      let root: THREE.Object3D;
      let prop: THREE.Mesh | undefined;
      const seat = spot.seat ?? 0.45;
      if (spot.activity === 'cake') {
        // The plate on his knees.
        this.cake = new CakeEater(h, { furniture: false, seatTop: seat, tableH: seat + 0.15, plateZ: 0.3 });
        root = this.cake.group;
      } else if (spot.activity === 'burger') {
        // The plate and the beer on the crowded coffee table in front of him.
        this.burger = new BurgerEater(h, { furniture: false, seatTop: seat, tableH: COFFEE_TOP + 0.005, plateZ: 0.72 });
        root = this.burger.group;
      } else if (spot.activity === 'lounge') {
        this.lounger = new UdudLounger(h);
        root = this.lounger.group;
      } else {
        const g = new THREE.Group();
        g.add(h.root);
        if (spot.held) {
          const geo = spot.held === 'tea' ? teaGlass() : spot.held === 'bottle' ? beerBottleGeometry() : spot.held === 'joint' ? joint() : pitaSandwich();
          prop = new THREE.Mesh(geo, kitMaterial({ detail: false }));
          prop.name = `party-${spot.held}`;
          g.add(prop);
        }
        root = g;
      }
      root.name = `party-spot-${spot.hero}`;
      root.position.set(spot.x, 0, spot.z);
      root.rotation.y = spot.yaw;
      root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      this.group.add(root);
      this.people.push({ hero: spot.hero, spot, h, root, prop });
      this.headY.set(spot.hero, 0);
    }
    // A pool of smoke puffs for Iati's joint.
    const tex = smokeTexture();
    for (let i = 0; i < 90; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: 0xd8ddd6, transparent: true, opacity: 0, depthWrite: false }));
      s.name = 'party-smoke';
      s.visible = false;
      this.group.add(s);
      this.puffs.push({ s, v: new THREE.Vector3(), age: 1, life: 1, size0: 0.1, size1: 0.5, alpha: 0 });
    }
    this.update(0, null);
  }

  /** Everyone who can turns and waves. */
  greet() {
    for (const p of this.people) if (p.spot.activity === 'chat' || p.spot.activity === 'talk' || p.spot.activity === 'drink' || p.spot.activity === 'smoke' || p.spot.activity === 'lounge') this.wave.set(p.hero, 2.4 + Math.random() * 0.6);
  }

  /** Is this hero at the party? */
  has(hero: HeroId) {
    return this.people.some((p) => p.hero === hero);
  }

  /** Is Iati in the middle of blessing someone? */
  get blessing() {
    return this.blessAt >= 0;
  }

  /**
   * Iati turns to `target` (a head, house frame), takes a long drag and blows the smoke across at it. Returns false if he
   * isn't here or is already at it.
   */
  bless(target: THREE.Vector3): boolean {
    if (!this.has('iati') || this.blessAt >= 0) return false;
    this.blessAt = 0;
    this.blessTo.copy(target);
    this.blessHitDone = false;
    return true;
  }

  /** Follow whoever is being blessed as they move. */
  blessTarget(target: THREE.Vector3) {
    if (this.blessAt >= 0) this.blessTo.copy(target);
  }

  /** True once, on the frame the blessing's cloud reaches whoever it was blown at. */
  blessHit = false;

  update(dt: number, look: THREE.Vector3 | null) {
    this.time += dt;
    this.blessHit = false;
    if (this.blessAt >= 0) {
      this.blessAt += dt;
      if (!this.blessHitDone && this.blessAt >= BLESS.hit) {
        this.blessHitDone = true;
        this.blessHit = true;
      }
      if (this.blessAt > BLESS.end) this.blessAt = -1;
    }
    const k = this.high;
    if (this.cake) {
      this.cake.spoonScale = 1 + 2.2 * k;
      this.cake.cakeScale = 1 + 0.9 * k;
    }
    this.cake?.update(dt);
    this.burger?.update(dt);
    if (this.burger) this.burger.burger.scale.setScalar(1 + 1.6 * k);
    this.lounger?.update(dt);
    for (const p of this.people) {
      const a = p.spot.activity;
      if (a === 'chat' || a === 'talk' || a === 'drink' || a === 'smoke') this.sitStill(p, dt);
      if (a === 'talk') this.talk(p);
      this.lookAround(p, dt, look);
      if (p.prop) this.handToMouth(p, dt);
      this.waving(p, dt);
      this.strange(p);
    }
    this.updatePuffs(dt);
  }

  /** Sat on the sofa or a chair, hands on the knees, breathing, leaning in a little. */
  private sitStill(p: PartyPerson, dt: number) {
    const h = p.h;
    h.update(dt, 'seat', 0, 0, 0);
    const s = h.root.scale.y;
    h.hips.position.y = ((p.spot.seat ?? 0.45) + 0.09 * s) / s;
    const k = this.time + p.spot.x * 3.1;
    h.torso.rotation.x = 0.06 + Math.sin(k * 1.3) * 0.008 + (p.spot.activity === 'chat' ? 0.06 : 0);
    h.root.updateMatrixWorld(true);
    for (const side of ['L', 'R'] as const) {
      const knee = side === 'L' ? h.kneeL : h.kneeR;
      const leg = side === 'L' ? h.legL : h.legR;
      knee.getWorldPosition(_v);
      leg.getWorldPosition(_v3);
      _v.lerp(_v3, 0.3).add(_v2.set(0, 0.06, 0));
      h.torso.worldToLocal(_v);
      h.reach(side, _v, _v2.set(side === 'L' ? 0.8 : -0.8, -0.5, -0.2).normalize());
    }
  }

  /** Nuhat in the middle of a story: talking, a smile at the good part, a wondering look, and on again; high, she never stops. */
  private talk(p: PartyPerson) {
    const t = (this.time + 3) % 16;
    p.h.expression = this.high > 0.5 ? (t % 5 < 4 ? 'talking' : 'smiling') : t < 7 ? 'talking' : t < 10.5 ? 'smiling' : t < 12.5 ? 'wondering' : 'talking';
  }

  /**
   * What's in the right hand rests on the right knee and comes up to the mouth every so often: a sip of tea, a pull on the
   * beer (tipped right up), a bite of the pita, a drag on the joint (and the smoke let out after it).
   */
  private handToMouth(p: PartyPerson, dt: number) {
    const h = p.h;
    const held = p.spot.held as PartyHeld;
    const period = held === 'pita' ? 9 : held === 'bottle' ? 12 : held === 'joint' ? 10 : 11;
    let t = (this.time + p.spot.x * 2.3 + p.spot.z) % period;
    // Blessing: the joint goes up for a long drag, then comes down for the blow.
    const blessing = held === 'joint' && this.blessAt >= 0;
    let lift = smoothstep(0, 1.1, t) * (1 - smoothstep(2.8, 3.8, t));
    if (blessing) {
      const b = this.blessAt;
      lift = smoothstep(BLESS.drag[0], BLESS.drag[0] + 0.6, b) * (1 - smoothstep(BLESS.drag[1], BLESS.drag[1] + 0.4, b));
      t = 1.5;
    }
    h.root.updateMatrixWorld(true);
    // The mouth, a little below and in front of it.
    _m.set(0, 0.04, 0.13);
    h.head.localToWorld(_m);
    _v.copy(_m);
    // Resting: on the right thigh, near the knee.
    h.kneeR.getWorldPosition(_v2);
    h.legR.getWorldPosition(_v3);
    _v2.lerp(_v3, 0.35).add(_v3.set(0, 0.1, 0));
    _v2.lerp(_v.add(_v3.set(0, held === 'bottle' ? -0.02 : held === 'joint' ? -0.02 : -0.06, 0)), lift);
    h.head.rotation.x -= (held === 'bottle' ? 0.4 : held === 'joint' ? 0.12 : 0.25) * lift;
    h.torso.worldToLocal(_v2);
    h.reach('R', _v2, _v3.set(-0.8, -0.5, -0.1).normalize());
    h.root.updateMatrixWorld(true);
    const prop = p.prop!;
    h.hand.getWorldPosition(_v);
    p.root.worldToLocal(_v);
    const tip = smoothstep(0.6, 1.1, t) * (1 - smoothstep(2.6, 3.2, t));
    if (held === 'pita') {
      prop.position.copy(_v).add(_v2.set(-0.01, 0.06, 0.03));
      prop.rotation.set(-0.35 - 0.5 * tip, 0.2, 0);
    } else if (held === 'bottle') {
      prop.position.copy(_v).add(_v2.set(0, -0.09 + 0.06 * tip, 0.015));
      prop.rotation.set(-1.9 * tip, 0, 0.1);
    } else if (held === 'joint') {
      // Between the fingers, the lit end out; at the lips the roach goes in.
      prop.position.copy(_v).add(_v2.set(-0.01, 0.01, 0.04));
      prop.rotation.set(-0.3 - 0.9 * lift, -0.6 + 0.5 * lift, 0);
      prop.updateMatrixWorld(true);
      // The smoke: a thread off the lit end, and a mouthful let out after each drag (a cloud, when he blesses someone).
      this.group.worldToLocal(_v3.set(0, 0, 0.088).applyMatrix4(prop.matrixWorld));
      if (Math.random() < dt * 3) this.puff(_v3, _v2.set(0.02, 0.18, 0.01), 2.2, 0.02, 0.22, 0.22);
      this.group.worldToLocal(_m);
      const exhale = blessing ? 0 : smoothstep(3.6, 3.9, t) * (1 - smoothstep(5.4, 6.4, t));
      if (exhale > 0 && Math.random() < dt * 14 * exhale) {
        const f = _v2.set(0, 0, 1).applyAxisAngle(_v3.set(0, 1, 0), p.spot.yaw).multiplyScalar(0.35).add(_v3.set(0, 0.12, 0));
        this.puff(_m, f, 3.2, 0.08, 0.75, 0.38);
      }
      if (blessing && this.blessAt > BLESS.blow[0] && this.blessAt < BLESS.blow[1]) {
        // A great billow across at whoever he is blessing, spreading as it goes, getting there in about a second and a half.
        for (let n = Math.floor(dt * 45 + Math.random()); n > 0; n--) {
          const d = _v2.copy(this.blessTo).sub(_m);
          const v = d.multiplyScalar(1 / 1.3).add(_v3.set((Math.random() - 0.5) * 0.6, 0.05 + Math.random() * 0.25, (Math.random() - 0.5) * 0.6));
          this.puff(_m, v, 6.5 + Math.random() * 1.5, 0.15, 2.0 + Math.random() * 0.8, 0.62, this.blessTo);
        }
      }
    } else {
      prop.position.copy(_v).add(_v2.set(0, -0.045, 0.01));
      prop.rotation.set(-0.9 * tip, 0, 0);
    }
  }

  /** Let out one puff of smoke at `at` (house frame), drifting at `v`. */
  private puff(at: THREE.Vector3, v: THREE.Vector3, life: number, size0: number, size1: number, alpha: number, to?: THREE.Vector3) {
    const p = this.puffs[this.nextPuff];
    this.nextPuff = (this.nextPuff + 1) % this.puffs.length;
    p.s.position.copy(at);
    p.v.copy(v);
    p.age = 0;
    p.life = life;
    p.size0 = size0;
    p.size1 = size1;
    p.alpha = alpha;
    p.to = to;
    p.s.visible = true;
  }

  private updatePuffs(dt: number) {
    for (const p of this.puffs) {
      if (!p.s.visible) continue;
      p.age += dt;
      const u = p.age / p.life;
      if (u >= 1) {
        p.s.visible = false;
        continue;
      }
      if (p.to) {
        // Slow down on arrival and hang round the head, curling.
        const d = _v.copy(p.to).sub(p.s.position);
        if (d.length() < 0.6) p.v.multiplyScalar(Math.exp(-dt * 3)).add(_v2.set(Math.sin(p.age * 3) * 0.1, 0.05, Math.cos(p.age * 2.6) * 0.1).multiplyScalar(dt * 4));
      } else p.v.multiplyScalar(Math.exp(-dt * 0.8));
      p.v.y += dt * 0.05;
      p.s.position.addScaledVector(p.v, dt);
      p.s.scale.setScalar(p.size0 + (p.size1 - p.size0) * Math.sqrt(u));
      (p.s.material as THREE.SpriteMaterial).opacity = p.alpha * Math.min(1, u * 6) * (1 - u) * (1 - u);
      (p.s.material as THREE.SpriteMaterial).color.setHSL(this.high > 0.05 ? (this.time * 0.05 + p.age * 0.2) % 1 : 0.3, this.high * 0.5, 0.85);
    }
  }

  /** Turn the head toward whoever came in, if they are near; otherwise toward the talk. Blessing, Iati turns to them. */
  private lookAround(p: PartyPerson, dt: number, look: THREE.Vector3 | null) {
    const a = p.spot.activity;
    if (a === 'cake' || a === 'burger') return;
    const h = p.h;
    const near = look && Math.hypot(look.x - p.spot.x, look.z - p.spot.z) < 6.5;
    const [fx, fz] = a === 'talk' ? AUDIENCE : STORYTELLER;
    const blessing = a === 'smoke' && this.blessAt >= 0;
    const tx = blessing ? this.blessTo.x : near ? look!.x : fx;
    const tz = blessing ? this.blessTo.z : near ? look!.z : fz;
    let want = wrapAngle(Math.atan2(tx - p.spot.x, tz - p.spot.z) - p.spot.yaw);
    // Now and then a look somewhere else.
    if (!blessing) want += Math.sin(this.time * 0.23 + p.spot.x) * 0.25 * (near ? 0.2 : 1);
    want = clamp(want, -1.2, 1.2);
    const cur = damp(this.headY.get(p.hero) ?? 0, want, blessing ? 5 : 2.5, dt);
    this.headY.set(p.hero, cur);
    // Most of the turn in the neck, a little in the shoulders.
    h.head.rotation.y = cur * 0.75;
    h.torso.rotation.y = cur * 0.25;
  }

  /** A hand up and a wave, then back to what they were doing. */
  private waving(p: PartyPerson, dt: number) {
    const left = this.wave.get(p.hero);
    if (left === undefined) return;
    const t = left - dt;
    if (t <= 0) {
      this.wave.delete(p.hero);
      return;
    }
    this.wave.set(p.hero, t);
    const k = smoothstep(0, 0.4, t) * smoothstep(2.6, 2.1, t);
    // Up beside the head (torso frame), the hand going side to side; whoever has something in the right hand waves with the left.
    const sx = p.prop ? 1 : -1;
    const sway = Math.sin(t * 11);
    p.h.reach(sx > 0 ? 'L' : 'R', _v.set(sx * (0.28 + sway * 0.04), 0.62 + sway * 0.02, 0.12 + sway * 0.05), _v2.set(sx * 0.6, -0.6, -0.3).normalize(), k);
  }

  /**
   * Seen high: everyone floats a hand's width up off their seat and sways, Udud's glasses leave his face to circle his
   * head, Nar's tea glass drifts up out of his hand and turns over in the air.
   */
  private strange(p: PartyPerson) {
    const k = this.high;
    const ph = p.spot.x * 1.7 + p.spot.z;
    p.root.position.y = k * (0.22 + 0.12 * Math.sin(this.time * 1.6 + ph));
    if (k < 0.001) return;
    const h = p.h;
    h.torso.rotation.z += Math.sin(this.time * 1.9 + ph) * 0.16 * k;
    h.head.rotation.z += Math.sin(this.time * 2.4 + ph + 1) * 0.22 * k;
    if (p.hero === 'udud') {
      const g = h.head.getObjectByName('udud-prescription-glasses');
      if (g) {
        const a = this.time * 1.8;
        g.position.set(Math.sin(a) * 0.22 * k, 0.1 + 0.05 * Math.sin(a * 2) * k, Math.cos(a) * 0.22 * k);
        g.rotation.set(0, a * k, Math.sin(a * 1.3) * 0.4 * k);
      }
    }
    if (p.hero === 'nar' && p.prop) {
      p.prop.position.y += k * (0.3 + 0.1 * Math.sin(this.time * 1.4));
      p.prop.rotation.z += this.time * 1.2 * k;
    }
  }

  /** Where a hero's face is (house frame), for anyone talking to them. */
  faceOf(hero: HeroId, out = new THREE.Vector3()) {
    const p = this.people.find((q) => q.hero === hero);
    if (!p) return null;
    p.h.head.getWorldPosition(out);
    return this.group.worldToLocal(out);
  }

  dispose() {
    for (const p of this.people) p.h.dispose();
    for (const p of this.puffs) (p.s.material as THREE.Material).dispose();
    this.group.removeFromParent();
    this.people.length = 0;
  }
}
