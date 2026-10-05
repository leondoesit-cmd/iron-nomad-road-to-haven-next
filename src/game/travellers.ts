import { TRAVELLERS, t, type Attitude, type RequestKind, type TravellerDef, type TravellerKind } from '../data';
import { Humanoid, type Held, type Palette } from '../render/humanoid';
import { makeHandcart, HANDLE_Z, type Handcart } from '../render/handcart';
import { disposeTree } from '../render/dispose';
import { Rng } from '../core/rng';
import { clamp, damp, dampAngle, wrapAngle } from '../core/math';
import { applyAxes } from '../sim/endings';
import { MELEE, type MeleeFeel } from '../sim/weaponfx';
import { nearestRoadAny, districtAt, type RoadPath } from '../world/openWorld';
import {
  TALK_LIMIT,
  Route,
  barkChance,
  barkKey,
  censusOf,
  fleeAt,
  lootOf,
  makeStock,
  murderAxes,
  pickKind,
  poolOf,
  rightOf,
  rollTraveller,
  sectorKey,
  spawnGap,
  suspicionRate,
  vehicleThreat,
  wantsRoom,
  type BarkPool,
  type TraderStock,
  type TravellerRoll,
} from '../sim/travellers';
import type { Ctx } from './ctx';
import type { Interactable } from './interact';
import type { Player } from './player';
import type { Vehicle } from './vehicle';

const R = TRAVELLERS.rules;

type TState = 'walk' | 'yield' | 'watch' | 'back' | 'talk' | 'flee' | 'fight';

/** A conversation that needs the game's own screen: a vote on a request, or the trader's cart. */
export interface TalkOffer {
  mode: 'trade' | 'request';
  id: number;
}

/** Where a gang camp is, for a rumour. */
export interface Rumour {
  gang: string;
  x: number;
  z: number;
}

/** How many different looks each kind has. Every distinct palette is a set of body meshes built once and kept, so there are few. */
const LOOKS = 3;
const SKIN = [0xd0a07c, 0x8a5a3c, 0xe0b894];

/** One of a kind's looks: the coat, the lid and a little extra. */
interface Variant {
  coat: number;
  lid: number;
  cloth: number;
  head?: 'cap' | 'hood' | 'bare';
  face?: 'bandana' | 'none';
}

const VARIANTS: Record<TravellerKind, Variant[]> = {
  trader: [
    { coat: 0x7d6a48, lid: 0x6b5a3a, cloth: 0xb8a37a },
    { coat: 0x6a5a3e, lid: 0x4a4a50, cloth: 0xa8433a },
    { coat: 0x8a7650, lid: 0x7a5a3a, cloth: 0x7a8a6a },
  ],
  pilgrim: [
    { coat: 0xcfc7b0, lid: 0xcfc7b0, cloth: 0xe8e2d0 },
    { coat: 0xc4bca4, lid: 0xc4bca4, cloth: 0xb8b090 },
    { coat: 0xd8d2c2, lid: 0xd8d2c2, cloth: 0xd8c8a0 },
  ],
  drifter: [
    { coat: 0x56624a, lid: 0x4a4a50, cloth: 0x6a4a3a, head: 'cap', face: 'bandana' },
    { coat: 0x4a4f5a, lid: 0x3a3a40, cloth: 0x5a5a60, head: 'hood', face: 'none' },
    { coat: 0x5a4a44, lid: 0x4a3a2a, cloth: 0x6a4a3a, head: 'bare', face: 'bandana' },
  ],
  scavenger: [
    { coat: 0x6b5b43, lid: 0xd9a21a, cloth: 0x8a7a5a },
    { coat: 0x5a5648, lid: 0xc9c4b4, cloth: 0x8a7a5a },
    { coat: 0x6a5040, lid: 0xb85a2a, cloth: 0x8a7a5a },
  ],
  courier: [
    { coat: 0x2a4a6a, lid: 0xb23a2a, cloth: 0xb23a2a },
    { coat: 0x3a5a40, lid: 0x2a5a8a, cloth: 0x2a5a8a },
    { coat: 0x4a3a5a, lid: 0xd9a21a, cloth: 0xd9a21a },
  ],
  hunter: [
    { coat: 0x5c5240, lid: 0x4a5a3a, cloth: 0x6a5a3a },
    { coat: 0x4a5a3a, lid: 0x5c5240, cloth: 0x5a4a30 },
    { coat: 0x6a5a44, lid: 0x3e4a3a, cloth: 0x6a5a3a },
  ],
};

/** What each kind wears: survivors' clothes in the road's own colours, one of a few looks each. */
function paletteFor(kind: TravellerKind, n: number): Palette {
  const v = ((n % LOOKS) + LOOKS) % LOOKS;
  const o = VARIANTS[kind][v];
  const skin = SKIN[(v + kind.length) % SKIN.length];
  const base = { jacket: o.coat, skin, helmet: o.lid, scarf: o.cloth };
  switch (kind) {
    case 'trader':
      return {
        ...base,
        trim: 0x4a3a28,
        pants: 0x4a4636,
        look: {
          head: { style: 'cap', c: o.lid },
          face: { style: 'bandana', c: o.cloth },
          body: { style: 'duster', c: o.coat },
          hands: { style: 'work', c: 0x3a2c20 },
          legs: { style: 'cargo' },
          feet: { style: 'boots', c: 0x2a211b },
          pack: { style: 'satchel', c: 0x5a4a30, c2: 0x7a6a4a },
        },
      };
    case 'pilgrim':
      return {
        ...base,
        trim: 0x8a7e66,
        pants: 0x6a604c,
        look: {
          head: { style: 'hood', c: o.lid },
          face: { style: 'bandana', c: o.cloth },
          body: { style: 'duster', c: o.coat },
          hands: { style: 'bare' },
          legs: { style: 'work' },
          feet: { style: 'boots', c: 0x4a3c2c },
          pack: { style: 'satchel', c: 0x7a6a4a, c2: 0x8a7a5a },
        },
      };
    case 'drifter':
      return {
        ...base,
        trim: 0x2f2f33,
        pants: 0x3d3f3a,
        look: {
          head: { style: o.head ?? 'cap', c: o.lid },
          face: { style: o.face ?? 'bandana', c: o.cloth },
          body: { style: 'jacket', c: o.coat },
          hands: { style: 'fingerless', c: 0x2b2622 },
          legs: { style: 'work' },
          feet: { style: 'boots', c: 0x2a211b },
          pack: { style: 'ruck', c: 0x4a4636, c2: 0x5d5a40 },
        },
      };
    case 'scavenger':
      return {
        ...base,
        trim: 0x2f2f33,
        pants: 0x4a4636,
        look: {
          head: { style: 'hardhat', c: o.lid },
          face: { style: 'goggles', c: 0x3a3a3a },
          body: { style: 'vest', c: o.coat },
          hands: { style: 'work', c: 0x3a2c20 },
          legs: { style: 'cargo' },
          feet: { style: 'steel', c: 0x2a211b },
          pack: { style: 'frame', c: 0x5a5648, c2: 0x7a6a4a },
        },
      };
    case 'courier':
      return {
        ...base,
        trim: 0x151515,
        pants: 0x2f3338,
        look: {
          head: { style: 'moto', c: o.lid },
          face: { style: 'goggles', c: 0x222222 },
          body: { style: 'jacket', c: o.coat },
          hands: { style: 'padded', c: 0x2b2622 },
          legs: { style: 'work' },
          feet: { style: 'runners', c: 0x3a3a3a },
          pack: { style: 'satchel', c: 0x3a3a3f, c2: 0x5a5a60 },
        },
      };
    case 'hunter':
      return {
        ...base,
        trim: 0x2f2a20,
        pants: 0x4a4636,
        look: {
          head: { style: 'hood', c: o.lid },
          face: { style: 'bandana', c: o.cloth },
          body: { style: 'duster', c: o.coat },
          hands: { style: 'fingerless', c: 0x2b2622 },
          legs: { style: 'cargo' },
          feet: { style: 'boots', c: 0x2a211b },
          pack: { style: 'ruck', c: 0x4a4636, c2: 0x5d5a40 },
        },
      };
  }
}

/** One person on the road. */
export class Traveller {
  x = 0;
  y = 0;
  z = 0;
  yaw = 0;
  hp: number;
  dead = false;
  deadT = 0;
  state: TState = 'walk';
  stateT = 0;
  /** The road they are walking, and where along it. */
  route!: Route;
  half = 4;
  lat = 0;
  latTo = 0;
  moveSpeed = 0;
  stun = 0;
  kx = 0;
  kz = 0;
  suspicion = 0;
  aimedT = 0;
  watchT = 0;
  yieldHold = 0;
  talkEnd = 3;
  barkT = 0;
  brainT = Math.random() * 0.2;
  greeted = false;
  saidAimed = false;
  warned = false;
  /** A vehicle is going by close, and they have had their say about it. */
  passed = false;
  /** Someone has hurt them (or a friend of theirs). */
  provoked = false;
  /** They have fired on a player: killing them is self-defence. */
  hostile = false;
  /** What they asked for has been answered. */
  helped = false;
  fireCd = 1;
  /** Where a threat is: what they run from and what an armed one shoots at. */
  threatX = 0;
  threatZ = 0;
  threat: Player | null = null;
  near: Player | null = null;
  nearD = Infinity;
  nearX = 0;
  nearZ = 0;
  faceX = 0;
  faceZ = 0;
  stock: TraderStock | null = null;
  human: Humanoid;
  cart: Handcart | null = null;
  interact: Interactable | null = null;
  /** True once the road has run out under them. */
  finished = false;

  constructor(
    readonly id: number,
    readonly group: number,
    readonly kind: TravellerKind,
    readonly def: TravellerDef,
    readonly attitude: Attitude,
    public request: RequestKind | null,
    public walk: number,
    palette: Palette,
  ) {
    this.hp = def.hp;
    this.human = new Humanoid(palette);
    this.human.setWeapon(def.held as Held);
  }

  get name() {
    return t(`trav.name.${this.kind}`);
  }
}

/**
 * People on the roads of the open world. Every so often one turns up out of sight and walks a road: a pilgrim bound
 * north, a drifter, a scavenger with a sack, a courier at a run, a hunter with a rifle, and now and then a trader with a
 * cart. They are neutral. Walk up and hold A to talk; some will ask for help, the trader will trade, the rude will say so
 * and the wary will keep their distance. A gun pointed at them makes everything worse, and a bullet makes it worse than
 * that. The rules are in `sim/travellers.ts`, the numbers in `data/travellers.json`.
 */
export class TravellerSystem {
  list: Traveller[] = [];
  private nextId = 1;
  private nextGroup = 1;
  private spawnT = R.firstAfter;
  private rng: Rng;
  private shots: { x: number; z: number; t: number }[] = [];
  private barkAt = -99;
  /** When the radio last remarked on a killing: [anyone, a trader]. */
  private murderAt: [number, number] = [-99, -99];
  private tipped = false;
  /** Whether a conversation is on screen. The scene sets and clears it. */
  busy = false;
  /** People killed, and requests answered, this run of the scene. */
  killed = 0;
  helped = 0;
  /** The scene says where a person may not walk (a gang camp's yard, a city). */
  canWalk: (x: number, z: number) => boolean = () => true;
  /** The scene opens the game's screen for a conversation. Returns false if it cannot right now. */
  onOffer: ((o: TalkOffer) => boolean) | null = null;
  /** The scene finds a camp to tell a rumour about, and marks it on the map. */
  onRumour: ((x: number, z: number) => Rumour | null) | null = null;

  constructor(private ctx: Ctx) {
    this.rng = new Rng(((ctx.campaign.seed ^ 0x7ac3) + ctx.campaign.day * 131) >>> 0);
  }

  get alive() {
    return this.list.filter((q) => !q.dead).length;
  }

  byId(id: number): Traveller | null {
    return this.list.find((q) => q.id === id) ?? null;
  }

  // ------------------------------------------------------------------ the road fills up

  /** Called from the leg scene: keep the road occasionally alive, out of sight, ahead of whoever is leading. */
  ambient(dt: number) {
    const ctx = this.ctx;
    const open = ctx.terrain?.open;
    if (!open) return;
    this.spawnT -= dt;
    if (this.spawnT > 0) return;
    this.spawnT = spawnGap(this.rng, { night: ctx.night, storm: ctx.storm });
    if (ctx.biome !== 'wasteland') return;
    const parties = new Set<number>();
    for (const q of this.list) if (!q.dead) parties.add(q.group);
    if (parties.size >= R.maxAlive) return;
    const kind = pickKind(this.rng, { night: ctx.night, census: censusOf(this.list.filter((q) => !q.dead).map((q) => q.kind)) });
    if (kind) this.trySpawn(kind);
  }

  /** Put a party on a road near the lead player, out of everyone's view. */
  trySpawn(kind: TravellerKind, near?: { x: number; z: number }): Traveller[] | null {
    const ctx = this.ctx;
    const open = ctx.terrain?.open;
    if (!open) return null;
    const players = ctx.players.filter((p) => p.alive);
    if (!players.length) return null;
    const lead = this.rng.pick(players);
    const v = lead.vehicle;
    const px = v ? v.position.x : lead.pos.x;
    const pz = v ? v.position.z : lead.pos.z;
    let heading = this.rng.range(0, Math.PI * 2);
    let spread = Math.PI;
    if (v && v.speed > 4) {
      const [fx, , fz] = v.body.forward();
      heading = Math.atan2(fx, fz);
      spread = 1.2;
    }
    for (let tries = 0; tries < 10; tries++) {
      let x: number;
      let z: number;
      if (near) {
        x = near.x;
        z = near.z;
      } else {
        const a = heading + this.rng.range(-spread, spread);
        const r = this.rng.range(R.spawnMin, R.spawnMax);
        x = px + Math.sin(a) * r;
        z = pz + Math.cos(a) * r;
      }
      const hit = nearestRoadAny(open, x, z);
      if (!hit.road || hit.d > 90) continue;
      const rx = hit.px;
      const rz = hit.pz;
      if (!near) {
        if (players.some((p) => Math.hypot((p.vehicle?.position.x ?? p.pos.x) - rx, (p.vehicle?.position.z ?? p.pos.z) - rz) < R.spawnMin * 0.7)) continue;
        if (ctx.visibleToAnyView(rx, ctx.groundAt(rx, rz) + 1, rz, 8)) continue;
      }
      if (districtAt(open, rx, rz) || !this.canWalk(rx, rz)) continue;
      const w = ctx.waterAt(rx, rz);
      if (w && w.depth > 0.1) continue;
      const route = Route.nearest(hit.road.pts, rx, rz, px, pz);
      // Mostly they come toward whoever is leading, so there is a chance to meet; sometimes they are walking away.
      if (this.rng.chance(0.65)) route.reverse();
      if (route.room(70) < 70) {
        route.reverse();
        if (route.room(70) < 70) continue;
      }
      return this.spawnParty(kind, hit.road, route);
    }
    return null;
  }

  private spawnParty(kind: TravellerKind, road: RoadPath, lead: Route): Traveller[] {
    const ctx = this.ctx;
    const roll: TravellerRoll = rollTraveller(this.rng, kind);
    const def = TRAVELLERS.archetypes[kind];
    const gid = this.nextGroup++;
    const party: Traveller[] = [];
    for (let k = 0; k < roll.size; k++) {
      // Followers a few paces behind the leader, on the same heading.
      const r = new Route(road.pts, lead.seg, lead.u, lead.dir === 1 ? -1 : 1);
      r.advance(k * 2.4);
      r.reverse();
      const tv = new Traveller(this.nextId++, gid, kind, def, roll.attitude, k === 0 ? roll.request : null, roll.walk * (1 + (k ? 0.01 * k : 0)), paletteFor(kind, roll.seed + k));
      tv.route = r;
      tv.half = road.half;
      tv.latTo = road.half + 1.7 + (k % 2 ? 0.9 : 0);
      tv.lat = tv.latTo;
      const [nx, nz] = rightOf(r.tx, r.tz);
      tv.x = r.x + nx * tv.lat;
      tv.z = r.z + nz * tv.lat;
      tv.y = ctx.groundAt(tv.x, tv.z);
      tv.yaw = Math.atan2(r.tx, r.tz);
      if (def.trade && k === 0) tv.stock = makeStock(this.rng);
      if (def.cart) tv.cart = makeHandcart(roll.seed);
      ctx.root.add(tv.human.root);
      if (tv.cart) ctx.root.add(tv.cart.root);
      this.register(tv);
      this.list.push(tv);
      party.push(tv);
    }
    return party;
  }

  private register(tv: Traveller) {
    const it: Interactable = {
      id: `trav:${tv.id}`,
      x: tv.x,
      z: tv.z,
      r: R.talkReach,
      prompt: this.promptFor(tv),
      dur: 0.3,
      priority: 2,
      enabled: (p) => this.canTalk(tv, p),
      run: (p) => this.talk(tv, p),
    };
    tv.interact = it;
    this.ctx.interact.add(it);
  }

  private promptFor(tv: Traveller) {
    const who = tv.name.toLowerCase();
    if (tv.def.trade) return t('trav.prompt.trade', { who });
    if (tv.request && !tv.helped) return t('trav.prompt.listen', { who });
    return t('trav.prompt.talk', { who });
  }

  // ------------------------------------------------------------------ talking

  private canTalk(tv: Traveller, p: Player): boolean {
    if (tv.dead || this.busy) return false;
    if (tv.state === 'flee' || tv.state === 'fight' || tv.state === 'talk') return false;
    if (tv.suspicion >= TALK_LIMIT || tv.provoked) return false;
    if (p.state !== 'foot' || p.carry) return false;
    // Not while pointing a gun at them.
    if (p.equip === 'gun' && p.ads > 0.4) return false;
    return true;
  }

  talk(tv: Traveller, p: Player) {
    if (tv.dead) return;
    tv.faceX = p.pos.x;
    tv.faceZ = p.pos.z;
    tv.state = 'talk';
    tv.stateT = 0;
    tv.talkEnd = 3;
    tv.moveSpeed = 0;
    if (tv.def.trade && tv.stock) {
      if (this.offer({ mode: 'trade', id: tv.id })) {
        this.say(tv, 'trade.open', true);
        return;
      }
    } else if (tv.request && !tv.helped) {
      if (this.offer({ mode: 'request', id: tv.id })) return;
    } else if (tv.def.hurry) {
      this.say(tv, 'hurry', true);
      tv.talkEnd = 1.4;
      return;
    } else {
      this.say(tv, poolOf(tv.attitude, 'chat'), true);
      if (tv.attitude === 'neutral' && this.rng.chance(R.rumourChance)) this.tellRumour(tv);
      tv.talkEnd = 3.5;
      return;
    }
    // The game could not open a screen: nothing happened, carry on.
    tv.state = 'walk';
  }

  private offer(o: TalkOffer): boolean {
    if (this.busy || !this.onOffer) return false;
    return this.onOffer(o);
  }

  /** Tell the players where a camp is, and mark it on their map. */
  tellRumour(tv: Traveller) {
    const r = this.onRumour?.(tv.x, tv.z);
    const ctx = this.ctx;
    let from = ctx.players.find((p) => p.alive);
    for (const p of ctx.players) if (p.alive && from && Math.hypot(p.pos.x - tv.x, p.pos.z - tv.z) < Math.hypot(from.pos.x - tv.x, from.pos.z - tv.z)) from = p;
    if (!r || !from) {
      this.line(tv, t('trav.rumour.none'), true);
      return;
    }
    const dx = r.x - from.pos.x;
    const dz = r.z - from.pos.z;
    const km = Math.max(0.1, Math.round((Math.hypot(dx, dz) / 1000) * 10) / 10);
    this.line(tv, t('trav.rumour.camp', { gang: r.gang, dir: t(`trav.dir.${sectorKey(dx, dz)}`), km: km.toFixed(1) }), true);
    ctx.notify(-1, t('trav.rumour.pin'), 'good');
  }

  /** The conversation on screen is over: the traveller turns back to the road. */
  endTalk(tv: Traveller, held = 1.2) {
    tv.talkEnd = held;
    tv.stateT = 0;
    if (tv.interact) tv.interact.prompt = this.promptFor(tv);
  }

  /** Whatever was asked has been answered. */
  answer(tv: Traveller, helped: boolean) {
    tv.helped = true;
    tv.request = null;
    if (helped) this.helped++;
    this.endTalk(tv, 2.5);
  }

  // ------------------------------------------------------------------ speech

  private line(tv: Traveller, text: string, everyone = false) {
    const ctx = this.ctx;
    const msg = t('trav.say', { who: tv.name, line: text });
    for (const p of ctx.players) {
      if (!p.alive) continue;
      const v = p.vehicle;
      const d = Math.hypot((v ? v.position.x : p.pos.x) - tv.x, (v ? v.position.z : p.pos.z) - tv.z);
      // A word on the road carries a few dozen metres; what you are told face to face is told to the whole convoy.
      if (everyone || d < 45) p.note(msg, 'info');
    }
  }

  /** A line from a pool, rate-limited so a road never turns into a wall of text. */
  say(tv: Traveller, pool: BarkPool, force = false) {
    const ctx = this.ctx;
    if (!force && (tv.barkT > 0 || ctx.time - this.barkAt < 2.5)) return;
    tv.barkT = R.barkGap;
    this.barkAt = ctx.time;
    this.line(tv, t(barkKey(this.rng, pool)));
  }

  // ------------------------------------------------------------------ sounds in the world

  /** A shot was fired somewhere: everyone who hears it is startled. */
  heardShot(x: number, z: number) {
    this.shots.push({ x, z, t: this.ctx.time });
    if (this.shots.length > 12) this.shots.shift();
  }

  // ------------------------------------------------------------------ the tick

  update(dt: number) {
    const ctx = this.ctx;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const tv = this.list[i];
      if (tv.dead) {
        tv.deadT += dt;
        tv.human.update(dt, 'downed', 0, 0, 0);
        if (tv.deadT > R.corpseSeconds && !this.seen(tv)) this.remove(i);
        continue;
      }
      // Too far from everyone to matter, or the road has run out where no one can see.
      let nearest = Infinity;
      for (const p of ctx.players) nearest = Math.min(nearest, Math.hypot((p.vehicle?.position.x ?? p.pos.x) - tv.x, (p.vehicle?.position.z ?? p.pos.z) - tv.z));
      if (nearest > R.despawnRadius || (tv.finished && !this.seen(tv))) {
        this.remove(i);
        continue;
      }
      tv.stateT += dt;
      tv.barkT -= dt;
      tv.fireCd -= dt;
      tv.brainT -= dt;
      tv.stun -= dt;
      if (tv.brainT <= 0) {
        tv.brainT = 0.2;
        this.think(tv);
      }
      this.move(tv, dt);
      this.present(tv, dt);
    }
    this.shots = this.shots.filter((s) => ctx.time - s.t < 3);
  }

  private seen(tv: Traveller) {
    return this.ctx.visibleToAnyView(tv.x, tv.y + 1, tv.z, 8);
  }

  private remove(i: number) {
    const tv = this.list[i];
    if (tv.interact) this.ctx.interact.remove(tv.interact.id);
    disposeTree(tv.human.root);
    tv.human.root.removeFromParent();
    if (tv.cart) {
      disposeTree(tv.cart.root);
      tv.cart.root.removeFromParent();
    }
    this.list.splice(i, 1);
  }

  clearAll() {
    for (let i = this.list.length - 1; i >= 0; i--) this.remove(i);
  }

  // ------------------------------------------------------------------ minds

  private think(tv: Traveller) {
    const ctx = this.ctx;
    const def = tv.def;
    // The nearest player, wherever they are riding.
    let near: Player | null = null;
    let nd = Infinity;
    for (const p of ctx.players) {
      if (!p.alive) continue;
      const v = p.vehicle;
      const x = v ? v.position.x : p.pos.x;
      const z = v ? v.position.z : p.pos.z;
      const d = Math.hypot(x - tv.x, z - tv.z);
      if (d < nd) {
        nd = d;
        near = p;
        tv.nearX = x;
        tv.nearZ = z;
      }
    }
    tv.near = near;
    tv.nearD = nd;
    if (!near) return;
    const foot = near.state === 'foot';

    // What they can make of the people nearby.
    let aimed = false;
    for (const p of ctx.players) {
      if (!p.alive || p.state !== 'foot' || p.equip !== 'gun' || p.carry || p.ads < 0.4) continue;
      const d = Math.hypot(tv.x - p.pos.x, tv.z - p.pos.z);
      if (d > 40) continue;
      const off = Math.abs(wrapAngle(Math.atan2(tv.x - p.pos.x, tv.z - p.pos.z) - p.aimYaw));
      if (off < 0.16 + 1.4 / Math.max(2, d)) {
        aimed = true;
        tv.threat = p;
        tv.threatX = p.pos.x;
        tv.threatZ = p.pos.z;
      }
    }
    const rushing = foot && near.moveSpeed > 4.2 && nd < 10 && Math.abs(wrapAngle(Math.atan2(tv.x - near.pos.x, tv.z - near.pos.z) - near.yaw)) < 0.5;
    const gunfire = this.shots.some((s) => ctx.time - s.t < 1.2 && Math.hypot(s.x - tv.x, s.z - tv.z) < 70);
    tv.aimedT = aimed ? tv.aimedT + 0.2 : Math.max(0, tv.aimedT - 0.3);
    tv.suspicion = clamp(tv.suspicion + suspicionRate(tv.attitude, { dist: nd, onFoot: foot, aimed, rushing, gunfire }) * 0.2, 0, 1.5);

    // Say something.
    if (!this.tipped && foot && nd < R.noticeRadius + 6) {
      this.tipped = true;
      ctx.tip('traveller');
    }
    if (foot && nd < R.noticeRadius && !tv.greeted) {
      tv.greeted = true;
      // A wary person starts out guarded.
      if (tv.attitude === 'wary') tv.suspicion = Math.max(tv.suspicion, 0.5);
      if (this.rng.chance(barkChance(tv.attitude, 'greet'))) this.say(tv, poolOf(tv.attitude, 'greet'));
    }
    if (aimed && tv.aimedT >= 0.4 && !tv.saidAimed) {
      tv.saidAimed = true;
      this.say(tv, poolOf(tv.attitude, 'aimed'), true);
    } else if (!aimed && tv.aimedT <= 0) tv.saidAimed = false;
    if (def.armed && tv.suspicion > 0.55 && !tv.warned && tv.state !== 'fight') {
      tv.warned = true;
      this.say(tv, 'armed.warn', true);
    } else if (tv.suspicion < 0.3) tv.warned = false;
    if (gunfire && !def.armed && tv.state !== 'flee') this.say(tv, 'startle');

    // Talking is the player's to end.
    if (tv.state === 'talk') {
      if (!this.busy && tv.stateT > tv.talkEnd) this.resume(tv, near);
      return;
    }

    // A fight, or running from one.
    if (def.armed && tv.state !== 'fight' && (tv.aimedT >= 3.2 || tv.provoked)) {
      this.startFight(tv, tv.threat ?? near);
      return;
    }
    if (tv.state === 'fight') {
      const target = tv.threat;
      if (!target || !target.alive || Math.hypot(target.pos.x - tv.x, target.pos.z - tv.z) > 90 || tv.hp < def.hp * 0.3) {
        if (tv.hp < def.hp * 0.3 || !target?.alive) this.flee(tv, tv.threatX, tv.threatZ);
        else this.calm(tv, near);
      }
      return;
    }
    if (tv.state === 'flee') {
      const far = Math.hypot(tv.threatX - tv.x, tv.threatZ - tv.z) > 45;
      if (tv.stateT > R.fleeSeconds && (far || (!tv.provoked && tv.stateT > R.fleeSeconds * 1.6))) this.resume(tv, near);
      return;
    }
    if (!def.armed && tv.suspicion >= fleeAt(tv.attitude, def.armed)) {
      this.flee(tv, tv.nearX, tv.nearZ);
      return;
    }

    // Traffic going by close: the rude shout at it, the wary eye it.
    if (this.fastVehicleWithin(tv, 14)) {
      if (!tv.passed) {
        tv.passed = true;
        if (this.rng.chance(barkChance(tv.attitude, 'pass'))) this.say(tv, poolOf(tv.attitude, 'pass'));
      }
    } else tv.passed = false;

    // Step off the road for a vehicle coming their way.
    const car = this.vehicleOnCourse(tv);
    if (car) {
      if (tv.state !== 'yield') {
        tv.state = 'yield';
        tv.stateT = 0;
      }
      tv.yieldHold = 1.6;
      tv.latTo = tv.half + 7.5;
      return;
    }
    if (tv.state === 'yield') {
      tv.yieldHold -= 0.2;
      if (tv.yieldHold <= 0) {
        tv.state = 'walk';
        tv.stateT = 0;
        tv.latTo = tv.half + 1.7;
      }
      return;
    }

    // A person on foot nearby: a wary one stops to watch and keeps their distance until they are satisfied.
    let want: TState = 'walk';
    if (tv.attitude === 'wary' && foot && nd < R.noticeRadius && tv.watchT < 14 && !def.hurry) want = wantsRoom(tv.attitude, tv.suspicion) && nd < R.wardRadius ? 'back' : 'watch';
    else if (foot && nd < 2.4 && Math.abs(wrapAngle(Math.atan2(tv.nearX - tv.x, tv.nearZ - tv.z) - tv.yaw)) < 1.0) want = 'watch';
    if (want !== tv.state) {
      const was = tv.state;
      tv.state = want;
      tv.stateT = 0;
      if (want === 'walk' && (was === 'back' || was === 'watch')) this.reanchor(tv, tv.nearX, tv.nearZ);
    }
    if (tv.state === 'watch' || tv.state === 'back') {
      tv.watchT += 0.2;
      tv.faceX = tv.nearX;
      tv.faceZ = tv.nearZ;
    } else if (nd > 30) tv.watchT = 0;
  }

  /** Is anything moving at speed within `r` metres? */
  private fastVehicleWithin(tv: Traveller, r: number): boolean {
    for (const v of this.ctx.vehicles) {
      if (v.wreck || Math.abs(v.speed) < R.yieldSpeed) continue;
      if (Math.hypot(tv.x - v.position.x, tv.z - v.position.z) < r) return true;
    }
    return false;
  }

  /** The nearest vehicle on a course to run them down, or null. */
  private vehicleOnCourse(tv: Traveller): Vehicle | null {
    let hit: Vehicle | null = null;
    for (const v of this.ctx.vehicles) {
      if (v.wreck) continue;
      const sp = Math.abs(v.speed);
      if (sp < R.yieldSpeed) continue;
      const dx = tv.x - v.position.x;
      const dz = tv.z - v.position.z;
      if (Math.hypot(dx, dz) > R.yieldAhead + sp * 0.6 + 6) continue;
      const [fx, , fz] = v.body.forward();
      const s = v.speed >= 0 ? 1 : -1;
      const along = (dx * fx + dz * fz) * s;
      const lateral = dx * fz - dz * fx;
      if (vehicleThreat(along, sp, lateral, along > 0)) hit = v;
    }
    return hit;
  }

  private startFight(tv: Traveller, target: Player) {
    tv.state = 'fight';
    tv.stateT = 0;
    tv.threat = target;
    tv.threatX = target.pos.x;
    tv.threatZ = target.pos.z;
    tv.fireCd = 0.6;
  }

  private flee(tv: Traveller, fromX: number, fromZ: number) {
    if (tv.state !== 'flee') this.say(tv, 'startle');
    tv.state = 'flee';
    tv.stateT = 0;
    tv.threatX = fromX;
    tv.threatZ = fromZ;
    tv.moveSpeed = Math.max(tv.moveSpeed, 1);
  }

  /** Back to the road. */
  private resume(tv: Traveller, from: Player | null) {
    tv.state = 'walk';
    tv.stateT = 0;
    tv.watchT = 0;
    tv.latTo = tv.half + 1.7;
    this.reanchor(tv, from ? tv.nearX : tv.threatX, from ? tv.nearZ : tv.threatZ);
    if (tv.interact) tv.interact.prompt = this.promptFor(tv);
  }

  /** An armed one that was only warning has seen the gun go down. */
  private calm(tv: Traveller, from: Player | null) {
    tv.threat = null;
    tv.aimedT = 0;
    tv.suspicion = Math.min(tv.suspicion, 0.4);
    if (!tv.provoked) this.resume(tv, from);
    else this.flee(tv, tv.threatX, tv.threatZ);
  }

  /** Find the road again from wherever they have got to, and head away from `(x, z)`. */
  private reanchor(tv: Traveller, fromX: number, fromZ: number) {
    const r = Route.nearest(tv.route.pts, tv.x, tv.z, fromX, fromZ);
    tv.route = r;
    const [nx, nz] = rightOf(r.tx, r.tz);
    tv.lat = clamp((tv.x - r.x) * nx + (tv.z - r.z) * nz, -14, 14);
    tv.finished = false;
  }

  // ------------------------------------------------------------------ movement

  private move(tv: Traveller, dt: number) {
    const ctx = this.ctx;
    // A shove from a hit or a car carries on a little.
    if (tv.kx || tv.kz) {
      const p = { x: tv.x + tv.kx * dt, z: tv.z + tv.kz * dt };
      ctx.obs.resolveCircle(p, 0.4);
      tv.x = p.x;
      tv.z = p.z;
      tv.kx = damp(tv.kx, 0, 5, dt);
      tv.kz = damp(tv.kz, 0, 5, dt);
      if (Math.abs(tv.kx) + Math.abs(tv.kz) < 0.05) tv.kx = tv.kz = 0;
    }
    if (tv.stun > 0) {
      tv.moveSpeed = damp(tv.moveSpeed, 0, 10, dt);
      return;
    }
    switch (tv.state) {
      case 'walk':
      case 'yield': {
        const pace = tv.state === 'yield' ? tv.walk * 0.55 : tv.walk;
        this.walkRoad(tv, pace, dt);
        break;
      }
      case 'watch':
      case 'talk':
        tv.moveSpeed = damp(tv.moveSpeed, 0, 8, dt);
        this.face(tv, Math.atan2(tv.faceX - tv.x, tv.faceZ - tv.z), dt);
        break;
      case 'back': {
        // Keep room: step away from them, still watching.
        const dx = tv.x - tv.nearX;
        const dz = tv.z - tv.nearZ;
        const l = Math.hypot(dx, dz) || 1;
        this.step(tv, dx / l, dz / l, 1.1, dt);
        this.face(tv, Math.atan2(tv.faceX - tv.x, tv.faceZ - tv.z), dt);
        break;
      }
      case 'flee': {
        const dx = tv.x - tv.threatX;
        const dz = tv.z - tv.threatZ;
        const l = Math.hypot(dx, dz) || 1;
        // Run, bending toward the road if it is the way away.
        this.step(tv, dx / l, dz / l, clamp(tv.walk * 2.4, 3.2, 4.4), dt);
        this.face(tv, Math.atan2(dx, dz), dt);
        break;
      }
      case 'fight': {
        tv.moveSpeed = damp(tv.moveSpeed, 0, 8, dt);
        const target = tv.threat;
        if (!target) break;
        tv.threatX = target.pos.x;
        tv.threatZ = target.pos.z;
        const dx = tv.threatX - tv.x;
        const dz = tv.threatZ - tv.z;
        const d = Math.hypot(dx, dz) || 1;
        this.face(tv, Math.atan2(dx, dz), dt);
        // Hold at a distance: close in if far, give ground if close.
        if (d > 32) this.step(tv, dx / d, dz / d, tv.walk, dt);
        else if (d < 14) this.step(tv, -dx / d, -dz / d, tv.walk, dt);
        if (d < 60 && tv.fireCd <= 0 && Math.abs(wrapAngle(Math.atan2(dx, dz) - tv.yaw)) < 0.3 && !ctx.obs.segmentBlocked(tv.x, tv.z, tv.threatX, tv.threatZ, 1.4)) {
          tv.fireCd = 1.1 + this.rng.next() * 0.9;
          this.shootAt(tv, target, d);
        }
        break;
      }
    }
  }

  private walkRoad(tv: Traveller, pace: number, dt: number) {
    const ctx = this.ctx;
    // Hold the route's pace to the walker's: if they are pinned behind something, the route waits for them.
    const [nx, nz] = rightOf(tv.route.tx, tv.route.tz);
    tv.lat = damp(tv.lat, tv.latTo, 3, dt);
    const wantX = tv.route.x + nx * tv.lat;
    const wantZ = tv.route.z + nz * tv.lat;
    const gap = Math.hypot(wantX - tv.x, wantZ - tv.z);
    // A courier does not wait for anyone.
    if (gap < 3.5 && pace > 0 && !tv.route.advance(pace * dt)) {
      // The road ends here. Out of sight they are gone; in sight they turn round.
      tv.finished = true;
      if (this.seen(tv)) {
        tv.route.reverse();
        tv.finished = false;
      }
    }
    const [mx, mz] = rightOf(tv.route.tx, tv.route.tz);
    const tx = tv.route.x + mx * tv.lat;
    const tz = tv.route.z + mz * tv.lat;
    const px = tv.x;
    const pz = tv.z;
    const p = { x: damp(tv.x, tx, 8, dt), z: damp(tv.z, tz, 8, dt) };
    ctx.obs.resolveCircle(p, 0.4);
    tv.x = p.x;
    tv.z = p.z;
    const moved = Math.hypot(tv.x - px, tv.z - pz) / Math.max(dt, 1e-4);
    tv.moveSpeed = damp(tv.moveSpeed, Math.min(moved, pace * 1.6), 10, dt);
    this.face(tv, Math.atan2(tv.route.tx, tv.route.tz), dt);
  }

  /** Free movement in a direction. */
  private step(tv: Traveller, dx: number, dz: number, speed: number, dt: number) {
    const p = { x: tv.x + dx * speed * dt, z: tv.z + dz * speed * dt };
    this.ctx.obs.resolveCircle(p, 0.4);
    const moved = Math.hypot(p.x - tv.x, p.z - tv.z) / Math.max(dt, 1e-4);
    tv.x = p.x;
    tv.z = p.z;
    tv.moveSpeed = damp(tv.moveSpeed, moved, 10, dt);
  }

  private face(tv: Traveller, yaw: number, dt: number) {
    tv.yaw = dampAngle(tv.yaw, yaw, 9, dt);
  }

  // ------------------------------------------------------------------ on screen

  private present(tv: Traveller, dt: number) {
    const ctx = this.ctx;
    tv.y = ctx.groundAt(tv.x, tv.z);
    const h = tv.human;
    h.root.position.set(tv.x, tv.y, tv.z);
    h.root.rotation.y = tv.yaw;
    const aim = tv.state === 'fight' ? 1 : tv.def.armed && tv.suspicion > 0.55 ? 0.7 : 0;
    h.update(dt, 'stand', tv.moveSpeed, aim, 0);
    h.muzzle(false);
    if (tv.cart) {
      const back = HANDLE_Z - 0.55;
      const cx = tv.x - Math.sin(tv.yaw) * back;
      const cz = tv.z - Math.cos(tv.yaw) * back;
      const cart = tv.cart;
      cart.root.position.set(cx, ctx.groundAt(cx, cz), cz);
      cart.root.rotation.y = tv.yaw;
      cart.roll(tv.moveSpeed * dt);
    }
    const it = tv.interact;
    if (it) {
      it.x = tv.x;
      it.z = tv.z;
    }
  }

  // ------------------------------------------------------------------ fighting back

  private shootAt(tv: Traveller, target: Player, d: number) {
    const ctx = this.ctx;
    tv.hostile = true;
    const ox = tv.x + Math.sin(tv.yaw) * 0.5;
    const oy = tv.y + 1.4;
    const oz = tv.z + Math.cos(tv.yaw) * 0.5;
    let dx = target.pos.x - ox;
    let dy = target.pos.y + 1.1 - oy;
    let dz = target.pos.z - oz;
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l;
    dy /= l;
    dz /= l;
    ctx.combat.shoot(ox, oy, oz, dx, dy, dz, { side: 'raider', ammo: 'raider', damage: 8, spread: 0.02 + d * 0.0008, range: 80, tracer: true });
    ctx.audio.play('pistol', ox, oz, 0.5);
  }

  // ------------------------------------------------------------------ being hit

  /** The nearest person a bullet along a ray would hit. */
  rayTest(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxD: number): { unit: Traveller; dist: number; head: boolean } | null {
    let best: { unit: Traveller; dist: number; head: boolean } | null = null;
    const dh = Math.hypot(dx, dz);
    if (dh < 1e-6) return null;
    const ux = dx / dh;
    const uz = dz / dh;
    for (const u of this.list) {
      if (u.dead) continue;
      const vx = u.x - ox;
      const vz = u.z - oz;
      const t0 = vx * ux + vz * uz;
      if (t0 < 0 || t0 > maxD * dh) continue;
      if (Math.hypot(ox + ux * t0 - u.x, oz + uz * t0 - u.z) > 0.45) continue;
      const tt = t0 / dh;
      const yy = oy + dy * tt;
      if (yy < u.y - 0.1 || yy > u.y + 1.85) continue;
      if (!best || tt < best.dist) best = { unit: u, dist: tt, head: yy > u.y + 1.5 };
    }
    return best;
  }

  /** Hurt someone. Returns true if it killed them. `killer` is a player's seat, or -1. */
  damage(tv: Traveller, amount: number, killer: number, from?: { x: number; z: number }): boolean {
    if (tv.dead) return false;
    tv.hp -= amount;
    const ctx = this.ctx;
    ctx.fx.blood(tv.x, tv.y + 1.2, tv.z, 3);
    const by = killer >= 0 ? ctx.players[killer] : undefined;
    if (tv.hp <= 0) {
      this.kill(tv, killer);
      return true;
    }
    this.provoke(tv, by ?? null, from?.x ?? by?.pos.x ?? tv.x, from?.z ?? by?.pos.z ?? tv.z);
    this.say(tv, 'hurt', true);
    return false;
  }

  /** Someone has attacked this person: they and their party take it badly. */
  private provoke(tv: Traveller, by: Player | null, fromX: number, fromZ: number) {
    for (const q of this.list) {
      if (q.dead || q.group !== tv.group) continue;
      q.provoked = true;
      q.threat = by ?? q.threat;
      q.threatX = fromX;
      q.threatZ = fromZ;
      if (q.interact) q.interact.prompt = this.promptFor(q);
      if (q.def.armed && by) this.startFight(q, by);
      else this.flee(q, fromX, fromZ);
    }
  }

  private kill(tv: Traveller, killer: number) {
    const ctx = this.ctx;
    tv.dead = true;
    tv.deadT = 0;
    tv.state = 'flee';
    if (tv.interact) {
      ctx.interact.remove(tv.interact.id);
      tv.interact = null;
    }
    ctx.fx.blood(tv.x, tv.y + 1, tv.z, 8);
    ctx.audio.play('zdie', tv.x, tv.z, 0.6);
    this.killed++;
    const loot = lootOf(this.rng, tv.kind);
    if (Object.keys(loot).length) ctx.addLoot(loot, 'raider');
    // Everyone near saw it.
    for (const q of this.list) {
      if (q.dead || q === tv || q.group === tv.group) continue;
      if (Math.hypot(q.x - tv.x, q.z - tv.z) > R.witnessRadius) continue;
      // They saw it: they run, or an armed one steps up, and they will not be easy to talk round for a while.
      q.suspicion = 1.5;
      const by = killer >= 0 ? ctx.players[killer] : undefined;
      if (q.def.armed && by) this.startFight(q, by);
      else this.flee(q, tv.x, tv.z);
    }
    for (const q of this.list) if (!q.dead && q.group === tv.group) this.provoke(q, killer >= 0 ? ctx.players[killer] ?? null : null, tv.x, tv.z);
    if (killer < 0) return;
    if (tv.hostile) {
      ctx.players[killer]?.note(t('trav.note.self', { who: tv.name.toLowerCase() }), 'info');
      return;
    }
    // Shooting someone who was only walking the road.
    applyAxes(ctx.campaign.axes, murderAxes(tv.kind));
    ctx.players[killer]?.note(t('trav.note.murder', { who: tv.name.toLowerCase() }), 'bad');
    const slot = tv.def.trade ? 1 : 0;
    if (ctx.time - this.murderAt[slot] > 30) {
      this.murderAt[slot] = ctx.time;
      ctx.radio(t(tv.def.trade ? 'trav.radio.trader.dead' : 'trav.radio.murder'));
    }
  }

  meleeHit(p: Player, hx: number, hz: number, yaw: number, reach: number, dmg: number, feel: MeleeFeel = MELEE.fist): number {
    let hit = 0;
    for (const u of this.list) {
      if (u.dead) continue;
      const dx = u.x - p.pos.x;
      const dz = u.z - p.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > reach + 0.4) continue;
      if (Math.abs(wrapAngle(Math.atan2(dx, dz) - yaw)) > 1.0) continue;
      this.damage(u, dmg, p.index, { x: p.pos.x, z: p.pos.z });
      u.kx += (dx / (d || 1)) * 2.2;
      u.kz += (dz / (d || 1)) * 2.2;
      u.stun = Math.max(u.stun, 0.3);
      hit++;
      if (hit >= Math.min(2, Math.max(1, feel.cleave - 1))) break;
    }
    void hx;
    void hz;
    return hit;
  }

  blast(x: number, z: number, r: number, dmg: number, killer: number) {
    for (const u of this.list) {
      if (u.dead) continue;
      const d = Math.hypot(u.x - x, u.z - z);
      if (d < r) {
        this.damage(u, dmg * (1 - (d / r) * 0.6), killer, { x, z });
        u.kx += ((u.x - x) / (d || 1)) * 5;
        u.kz += ((u.z - z) / (d || 1)) * 5;
        u.stun = Math.max(u.stun, 0.6);
      }
    }
  }

  burnArea(x: number, z: number, r: number, dps: number, dt: number, killer: number) {
    for (const u of this.list) if (!u.dead && Math.hypot(u.x - x, u.z - z) < r) this.damage(u, dps * dt, killer, { x, z });
  }

  /** A vehicle ploughing into people on foot. */
  plow(v: Vehicle) {
    const sp = v.speed;
    if (sp < 3 || v.wreck || !this.list.length) return;
    const [fx, , fz] = v.body.forward();
    const p = v.position;
    const w = v.def.width / 2 + 0.3;
    const front = v.def.length / 2;
    const killer = v.driver?.isPlayer ? v.driver.index : -1;
    for (const a of this.list) {
      if (a.dead) continue;
      const rx = a.x - p.x;
      const rz = a.z - p.z;
      if (Math.abs(rx) > 8 || Math.abs(rz) > 8) continue;
      const lz = rx * fx + rz * fz;
      const lx = rx * fz - rz * fx;
      if (lz < front - 1.1 || lz > front + 1.3 || Math.abs(lx) > w + 0.45) continue;
      const dmg = (14 + sp * 9) * (v.def.tier >= 3 ? 1.5 : v.def.tier === 2 ? 1.1 : 0.8);
      const killed = this.damage(a, dmg, killer, { x: p.x, z: p.z });
      a.kx += fx * sp * 0.6 - fz * lx * 0.2;
      a.kz += fz * sp * 0.6 + fx * lx * 0.2;
      a.stun = Math.max(a.stun, 0.8);
      v.bodywork.splat(killed ? 0.05 : 0.025);
      this.ctx.audio.play('thud', a.x, a.z, 0.8);
      if (v.driver?.isPlayer) this.ctx.input.rumble(v.driver.index, 0.2, 0.3, 60);
    }
  }

  // ------------------------------------------------------------------ the map

  /** Pins for the compass: someone close by who is asking for help. */
  helpPins(): { x: number; z: number; label: string }[] {
    const out: { x: number; z: number; label: string }[] = [];
    for (const q of this.list) {
      if (q.dead || !q.request || q.helped) continue;
      let near = Infinity;
      for (const p of this.ctx.players) near = Math.min(near, Math.hypot((p.vehicle?.position.x ?? p.pos.x) - q.x, (p.vehicle?.position.z ?? p.pos.z) - q.z));
      if (near < 160) out.push({ x: q.x, z: q.z, label: t('trav.pin.help') });
    }
    return out;
  }

  /** Where everyone alive is, for the minimap. */
  forEachAlive(fn: (x: number, z: number) => void) {
    for (const q of this.list) if (!q.dead) fn(q.x, q.z);
  }
}
