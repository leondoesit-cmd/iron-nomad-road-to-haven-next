import { hash2, hashString } from '../core/rng';
import { NEEDS } from '../sim/needs';
import { bind, openWound } from '../sim/vitals';
import { promptLabel } from '../input/input';
import { knowsShroom, learnShroom, selectWildLot, sortStash } from './wildShrooms';
import {
  DEATHCAP,
  FORAGE,
  FORAGE_RULES,
  SHROOMS,
  SHROOM_LOOK,
  WILD_ITEM,
  coverOf,
  handfulsLeft,
  handsSafe,
  newSickness,
  pickHandful,
  pickSeconds,
  shroomsUp,
  tickSickness,
  wantsToEat,
  type Shroom,
  type Sickness,
} from '../sim/forage';
import { plantForage, type ForageSpot } from '../world/forage';
import { ForageRender, type ForageView } from '../render/forageRender';
import type { ChunkData } from '../world/chunkgen';
import type { Ctx } from './ctx';
import type { Interactable } from './interact';
import type { Player } from './player';
import type { VegetationMemory } from '../sim/vegetation';

/** Blades that cut herbs and pads quicker when one is on the belt. */
const BLADES = new Set(['m_knife', 'm_machete', 'm_axe', 'm_katana']);

/** What a plant has given up: handfuls taken, and the day the last one was. Kept by the world's memory across nights. */
export interface Picked {
  n: number;
  day: number;
}

/** The host: the leg's shared world, plus how wet the ground is today (mushrooms come up after rain). */
export type ForageHost = Ctx & { weather: { wet: number } };

/**
 * Gathering in the open world: the wild plants of each loaded chunk (`world/forage.ts`), drawn by `ForageRender`, each one
 * a hold-A spot in the interact registry while someone on foot is near it. Picking follows `sim/forage.ts`: the hungry eat
 * there and then, the fed put it by; thorns hurt bare hands; yarrow binds a bleed; unknown mushrooms are a gamble.
 * What was picked is remembered (`picked`, shared with WorldMemory), and grows back over the days.
 */
export class Foraging {
  readonly render: ForageRender;
  private chunks = new Map<number, ForageSpot[]>();
  private byId = new Map<string, ForageSpot>();
  /** Spot ids registered with the interact registry right now (only those near someone on foot). */
  private live = new Map<string, Interactable>();
  private dirty = true;
  private scanT = 0;
  /** The wettest the ground has been today: once mushrooms are up after rain they stay up. */
  private wetToday = 0;
  private upCache = new Map<string, boolean>();
  /** Death cap poisonings working, by player index. A night's sleep sees one through (the scene is rebuilt at dawn). */
  readonly sick = new Map<number, Sickness>();
  private dice: number[] = [0x9e3779b9, 0x7f4a7c15];
  private brokenCount = 0;

  constructor(
    private host: ForageHost,
    /** What has been picked, by spot id. Pass the world memory's map to keep it across nights. */
    readonly picked: Map<string, Picked> = new Map(),
    private vegetationMemory: VegetationMemory = new Map(),
  ) {
    this.render = new ForageRender(host.P, vegetationMemory);
    host.root.add(this.render.group);
  }

  private get day(): number {
    return this.host.campaign.day;
  }

  // ------------------------------------------------------------------ chunks

  addChunk(key: number, data: ChunkData) {
    const T = this.host.terrain;
    if (!T || this.chunks.has(key)) return;
    const spots = plantForage(T, data.cx, data.cz, { heights: data.heights, aabbs: data.aabbs, props: data.props, trees: data.trees });
    this.chunks.set(key, spots);
    for (const s of spots) this.byId.set(s.id, s);
    if (spots.length) this.dirty = true;
  }

  removeChunk(key: number) {
    const spots = this.chunks.get(key);
    if (!spots) return;
    for (const s of spots) {
      this.byId.delete(s.id);
      this.unregister(s.id);
    }
    this.chunks.delete(key);
    if (spots.length) this.dirty = true;
  }

  /** Every plant in the loaded chunks. */
  spots(): ForageSpot[] {
    return [...this.byId.values()];
  }

  spot(id: string): ForageSpot | undefined {
    return this.byId.get(id);
  }

  // ------------------------------------------------------------------ state

  /** Handfuls on a plant now: none on a mushroom patch that is not fruiting today. */
  left(s: ForageSpot): number {
    if (this.vegetationMemory.get(`forage:${s.id}`)?.broken) return 0;
    if (s.kind === 'mushroom' && !this.shroomsUp(s)) return 0;
    const p = this.picked.get(s.id);
    return p ? handfulsLeft(s.kind, p.n, p.day, this.day) : FORAGE[s.kind].handfuls;
  }

  private shroomsUp(s: ForageSpot): boolean {
    if (s.always) return true;
    let up = this.upCache.get(s.id);
    if (up === undefined) {
      up = shroomsUp(hash2(Math.floor(s.h * 1e6), this.day, 7741), this.wetToday);
      this.upCache.set(s.id, up);
    }
    return up;
  }

  /** What one person knows of the mushrooms. Kept on the campaign's flags, so it is saved, and it is theirs alone. */
  known(p: Player): Set<Shroom> {
    const out = new Set<Shroom>();
    for (const sp of SHROOMS) if (knowsShroom(this.host.campaign, p.hero, sp)) out.add(sp);
    return out;
  }

  private learn(p: Player, sp: Shroom) {
    learnShroom(this.host.campaign, p.hero, sp);
    sortStash(this.host.campaign, this.host.players);
  }

  private blade(p: Player): boolean {
    return p.gear.belt.some((it) => !!it && BLADES.has(it.id));
  }

  /** The words on the prompt for one person at one plant. */
  promptFor(p: Player, s: ForageSpot): string {
    const d = FORAGE[s.kind];
    const n = this.left(s);
    const cover = coverOf(p.gear.worn.hands?.id);
    const thorny = d.thorns && !handsSafe(s.kind, cover) ? (s.kind === 'sabra' ? ' (bare hands: spines)' : ' (bare hands: thorns)') : '';
    const count = d.handfuls > 1 ? ` · ${n} left` : '';
    if (s.kind === 'mushroom') {
      const sp = s.shroom ?? 'field';
      if (this.known(p).has(sp)) {
        if (sp === 'deathcap') return 'Death caps: poisonous';
        if (sp === 'liberty') return `Pick liberty caps${count}`;
        return `${wantsToEat(p.needs, 'mushroom') ? 'Eat' : 'Pick'} field mushrooms${count}`;
      }
      return `Pick ${SHROOM_LOOK[sp]} (unknown)${count}`;
    }
    if (s.kind === 'yarrow') return p.bleed.level > 0 ? 'Pack the wound with yarrow' : 'Pick yarrow (a field dressing)';
    if (s.kind === 'zaatar') return `Cut za'atar (medicine)${count}`;
    return `${wantsToEat(p.needs, s.kind) ? 'Eat' : 'Pick'} ${d.crop}${count}${thorny}`;
  }

  // ------------------------------------------------------------------ the interact registry

  private register(s: ForageSpot) {
    if (this.live.has(s.id)) return;
    const self = this;
    const big = s.kind === 'fig' ? 1 : s.kind === 'bramble' || s.kind === 'sabra' ? 0.6 : 0;
    const it: Interactable = {
      id: s.id,
      x: s.x,
      z: s.z,
      r: FORAGE_RULES.reach + big * s.s,
      prompt: '',
      dur: FORAGE[s.kind].pick,
      priority: 0,
      // Asked of each person in reach before the prompt is read: so the words and the time are theirs (hungry or fed,
      // gloved or not, what they know).
      enabled(p) {
        if (p.state !== 'foot' || p.carry || self.left(s) <= 0) return false;
        it.prompt = self.promptFor(p, s);
        const known = s.kind === 'mushroom' && self.known(p).has(s.shroom ?? 'field');
        it.dur = known && s.shroom === 'deathcap' ? 0.4 : pickSeconds(s.kind, self.blade(p), coverOf(p.gear.worn.hands?.id));
        return true;
      },
      onTick(p) {
        self.host.sig.emit(s.x, s.z, FORAGE[s.kind].noise, 'noise');
        void p;
        return self.left(s) > 0;
      },
      run(p) {
        self.pick(p, s);
      },
    };
    this.live.set(s.id, it);
    this.host.interact.add(it);
  }

  private unregister(id: string) {
    if (!this.live.delete(id)) return;
    this.host.interact.remove(id);
  }

  // ------------------------------------------------------------------ picking

  /** The forager's own dice, so a handful never shifts the world's. */
  private roll(p: Player): number {
    const i = p.index & 1;
    this.dice[i] = (Math.imul(this.dice[i] ^ hashString(p.hero), 1664525) + 1013904223) >>> 0;
    return this.dice[i] / 4294967296;
  }

  /** One handful off a plant, applied: belly, stores, hands, wounds, the gamble. */
  pick(p: Player, s: ForageSpot) {
    const ctx = this.host;
    if (this.left(s) <= 0) return;
    const o = pickHandful(s.kind, {
      needs: p.needs,
      cover: coverOf(p.gear.worn.hands?.id),
      bleeding: p.bleed.level > 0,
      shroom: s.shroom,
      known: this.known(p),
      roll: this.roll(p),
    });
    const n = p.needs;
    if (o.ate.food > 0 || o.ate.water > 0) {
      n.food = Math.min(1, n.food + o.ate.food);
      n.water = Math.min(1, n.water + o.ate.water);
      n.bowel = Math.min(1, n.bowel + o.ate.food * NEEDS.bowelPerFood * 0.45);
      n.bladder = Math.min(1, n.bladder + o.ate.water * NEEDS.bladderPerWater);
      ctx.audio.play('munch', s.x, s.z, 0.5);
    }
    const b = o.bank;
    if (b.rations || b.medicine) ctx.addLoot({ ...(b.rations ? { rations: b.rations } : {}), ...(b.medicine ? { medicine: b.medicine } : {}) }, 'forage');
    if (b.bandage) ctx.campaign.items.bandage += b.bandage;
    if (b.mushrooms) ctx.campaign.items.mushrooms += b.mushrooms;
    if (b.rations || b.medicine || b.bandage || b.mushrooms) ctx.audio.play('pickup', s.x, s.z, 0.4);
    if (o.hurt > 0) {
      p.hp = Math.max(1, p.hp - o.hurt);
      if (o.scratch && openWound(p.bleed)) p.note('A thorn opened a deep scratch: it is bleeding', 'bad');
    }
    if (o.bind) bind(p.bleed);
    if (o.trip) {
      ctx.campaign.items.mushrooms++;
      p.takeDrug('mushrooms');
    }
    if (o.poison && !this.sick.has(p.index)) this.sick.set(p.index, newSickness());
    if (o.took) {
      const was = this.picked.get(s.id);
      const fresh = !was || this.day - was.day >= FORAGE[s.kind].regrow;
      this.picked.set(s.id, { n: fresh ? 1 : was.n + 1, day: this.day });
      this.dirty = true;
      if (this.left(s) <= 0) this.unregister(s.id);
    }
    // Unknown ones go in the stash by their look, the quick belt's mushroom slot pointing at them: eating one is the gamble.
    if (b.wild) this.stashWild(p, b.wild);
    else p.note(o.note, o.tone);
    if (o.learn) this.learn(p, o.learn);
  }

  private stashWild(p: Player, sp: Shroom) {
    const c = this.host.campaign;
    c.items[WILD_ITEM[sp]]++;
    this.host.audio.play('pickup', p.pos.x, p.pos.z, 0.4);
    selectWildLot(p, sp);
    const key = promptLabel(this.host.input.slots?.[p.index] ?? null, 'Down');
    const look = SHROOM_LOOK[sp];
    const first = !c.flags[`tip.wild.${p.hero}`];
    if (first) {
      c.flags[`tip.wild.${p.hero}`] = true;
      p.selectQuick('wild');
      p.note(`Picked ${look} you don't know, kept by their look. Tap ${key} to eat one and find out: food, a trip, or poison`, 'info');
    } else p.note(`Picked ${look} (unknown): ×${c.items[WILD_ITEM[sp]]} in the stash, ${key} on the quick belt`, 'info');
  }

  /** Death caps eaten from the stash (anywhere) leave a flag; here it becomes the poisoning. */
  private pickUpSickness() {
    const c = this.host.campaign;
    for (const p of this.host.players) {
      const key = `forage.sick.${p.hero}`;
      if (!c.flags[key]) continue;
      delete c.flags[key];
      if (!this.sick.has(p.index)) this.sick.set(p.index, newSickness());
    }
  }

  // ------------------------------------------------------------------ tick

  update(dt: number) {
    const ctx = this.host;
    // A flush of mushrooms after rain.
    const wet = ctx.weather.wet;
    if (wet > this.wetToday + 0.15 || (wet > 0.5 && this.wetToday <= 0.5)) {
      this.wetToday = Math.max(this.wetToday, wet);
      this.upCache.clear();
      this.dirty = true;
    }
    this.scanT -= dt;
    if (this.scanT <= 0) {
      this.scanT = 0.25;
      this.scan();
    }
    if (this.dirty) {
      this.dirty = false;
      const views: ForageView[] = [];
      for (const s of this.byId.values()) views.push({ spot: s, left: this.left(s) });
      this.render.set(views);
    }
    this.tickSick(dt);
  }

  /** Register the plants near anyone on foot, drop the rest; and the first time someone comes close to one, say what it is. */
  private scan() {
    this.pickUpSickness();
    sortStash(this.host.campaign, this.host.players);
    let broken = 0;
    for (const s of this.byId.values()) if (this.vegetationMemory.get(`forage:${s.id}`)?.broken) broken++;
    if (broken !== this.brokenCount) { this.brokenCount = broken; this.dirty = true; }
    const ctx = this.host;
    const feet = ctx.players.filter((p) => p.state === 'foot');
    const R = 12;
    for (const s of this.byId.values()) {
      let near = Infinity;
      let who: Player | null = null;
      for (const p of feet) {
        const d = Math.hypot(p.pos.x - s.x, p.pos.z - s.z);
        if (d < near) {
          near = d;
          who = p;
        }
      }
      if (near < R && this.left(s) > 0) {
        this.register(s);
        if (who && near < 5 && !ctx.campaign.flags['tip.forage']) {
          ctx.campaign.flags['tip.forage'] = true;
          who.note('Wild food: hold the action button to pick it. Hungry, you eat it; fed, it goes in the stores', 'info');
        }
      } else this.unregister(s.id);
    }
  }

  private tickSick(dt: number) {
    for (const [i, s] of this.sick) {
      const p = this.host.players[i];
      if (!p || p.state === 'dead') {
        this.sick.delete(i);
        continue;
      }
      const t = tickSickness(s, dt, p.hp, p.maxHp);
      if (t.started) {
        p.note('Cramps, then the sweats. Those mushrooms were death caps', 'bad');
        this.learn(p, 'deathcap');
      }
      if (t.hp > 0) p.hp = Math.max(1, p.hp - t.hp);
      p.needs.water = Math.max(0, p.needs.water - t.water);
      p.needs.food = Math.max(0, p.needs.food - t.food);
      if (t.retch && s.t > DEATHCAP.onset) {
        if (p.state === 'foot') p.stunT = Math.max(p.stunT, 1.6);
        this.host.audio.play('retch', p.pos.x, p.pos.z, 0.6);
        p.note('You double over and retch', 'warn');
      }
      if (t.over) {
        p.note('The worst of the poisoning has passed. Drink something', 'info');
        this.sick.delete(i);
      }
    }
  }

  dispose() {
    for (const id of [...this.live.keys()]) this.unregister(id);
    this.render.dispose();
  }
}
