import type * as THREE from 'three';
import { TAU, clamp01, smoothstep } from '../core/math';
import { catchChance, Wildfire, type FireHooks } from './wildfire';
import { dayPlan, fireDanger, groundHeat, hydrograph, panFill, rainLabel, sampleHydro, skyAt, type DayPlan, type Hydrograph, type Sky } from '../sim/climate';
import { windAt } from '../sim/weather';
import { RainFx } from '../render/rain';
import { LightningFx } from '../render/lightning';
import { buildFloodWater, HYDRO, setHydroTexture, type FloodWater } from '../render/floodWater';
import { MAX_RIVERS, RIVER_RISE, riseTaper } from '../render/riverWater';
import { courseAt, lushAt } from '../world/hydro';
import { districtMask } from '../world/openWorld';
import { floodAt, floodStage, PAN_POOL, washAt } from '../world/washes';
import { heightAt, type TerrainDef } from '../world/terrain';
import { TREE_DIMS, TREE_SPECIES, type TreeSpot } from '../world/flora';
import type { WaterKind } from '../world/lakes';
import { weatherAudio } from '../audio/weatherAudio';
import type { Scene } from './scene';

/** Water at a point as the scene hands it out (`Ctx.waterAt`). */
export interface SceneWater {
  level: number;
  depth: number;
  flow?: [number, number];
  kind?: WaterKind;
  name?: string;
}

/** How far a river rises in a full flood, metres: a river more than a stream. */
export function riverFloodRise(kind: 'river' | 'stream'): number {
  return kind === 'river' ? 1.5 : 0.9;
}

/** The speed of sound, for the thunder that follows a flash. */
const SOUND = 343;
/** How much of the day a flood can still be running somewhere down a wash after it left the mountains. */
const FLOOD_TAIL = 0.45;

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
/** A bearing (atan2 of x and z: +z north, +x east) as a word. */
export function compassWord(bearing: number): string {
  const k = Math.round((((bearing % TAU) + TAU) % TAU) / (TAU / 8)) % 8;
  return COMPASS[k];
}

const CALM_SKY: Sky = { cover: 0, dark: 0, rain: 0, rainUp: 0, boltsNear: 0, boltsFar: 0, towerDir: 0, tower: 0, gust: 0 };

/**
 * The day's weather in a scene: rain, cloud and lightning from `sim/climate.ts`, played out. It eases the sky toward the
 * clock's (so a fresh scene or a loaded save still has a wind-up), throws lightning at the tall things near the convoy and
 * sends the thunder after it at the speed of sound, lets the strikes set the woods alight, runs the floods down the washes
 * and the rivers up their banks, and hands the renderer what it all looks like. The water it adds is real water to the
 * physics (`water`): a flooded wash sweeps a car away and a full pan wets the wheels.
 */
export class WeatherSystem {
  plan: DayPlan | null = null;
  hydro: Hydrograph | null = null;
  private dayKey = '';
  /** The sky the clock wants now, and the eased values that are shown and felt. */
  sky: Sky = CALM_SKY;
  rain = 0;
  cover = 0;
  dark = 0;
  tower = 0;
  towerDir = 0;
  gust = 0;
  /** From the day's hydrograph: wet hard ground, puddles, runoff into the washes, how far the rivers have risen (0..1). */
  wet = 0;
  puddle = 0;
  washQ = 0;
  riverK = 0;
  /** Lightning lighting things now (near strikes, far ones), a rainbow, and the wind the rain leans in (m/s, x and z). */
  flash = 0;
  farFlash = 0;
  bow = 0;
  wind: [number, number] = [0, 0];
  readonly fire: Wildfire;
  readonly rainFx = new RainFx();
  readonly bolts = new LightningFx();
  flood: FloodWater | null = null;
  private def: TerrainDef | null = null;
  /** Thunder on its way: when it arrives (scene time) and how far off it was. */
  private thunder: { at: number; dist: number }[] = [];
  /** Radio lines already said today, by key. */
  private told = new Set<string>();
  /** A flood is running somewhere, or a pan holds water: only then does `water` look for it. */
  private floodLive = false;
  private panLive = false;
  /** Rain over the last minute of the clock, for the rainbow. */
  private rainLately = 0;
  private dustAcc = 0;
  private splashAcc = 0;
  private sheltered: [number, number] = [0, 0];
  /** The last bolt to come down near the convoy, and the tree it hit (for the tests and the curious). */
  lastStrike: { x: number; y: number; z: number; tree: TreeSpot | null } | null = null;

  constructor(private sc: Scene) {
    this.fire = new Wildfire(sc);
    this.fire.hooks.onIgnite = (f) => this.onIgnite(f.tree);
    sc.root.add(this.rainFx.mesh);
    sc.root.add(this.bolts.group);
  }

  /** True where there is weather at all: never underground. */
  get active(): boolean {
    return this.sc.mode !== 'delve';
  }

  /** The leg's ground: its washes get their flood water, its rivers their rise. */
  attachTerrain(def: TerrainDef) {
    this.def = def;
    this.flood?.dispose();
    this.flood = buildFloodWater(def);
    if (this.flood) this.sc.root.add(this.flood.group);
  }

  /** Where trees stand and how to darken them: the leg scene's chunks know. */
  setFireHooks(h: Pick<FireHooks, 'treesNear' | 'charTree'>) {
    this.fire.hooks.treesNear = h.treesNear;
    this.fire.hooks.charTree = h.charTree;
  }

  private ensureDay() {
    const c = this.sc.campaign;
    const key = `${c.seed}:${c.day}`;
    if (key === this.dayKey) return;
    this.dayKey = key;
    this.plan = dayPlan(c.seed, c.day);
    this.hydro = hydrograph(c.seed, c.day);
    this.told.clear();
    setHydroTexture(this.hydro, this.sc.clock.dayLength);
  }

  /** The clock line's word for the weather now, or ''. */
  label(): string {
    if (!this.active) return '';
    return rainLabel({ ...this.sky, rain: this.rain }, this.floodNearConvoy());
  }

  // ------------------------------------------------------------------ fixed tick

  tick(dt: number) {
    if (!this.active) return;
    this.ensureDay();
    const sc = this.sc;
    const t = sc.clock.t;
    const h = this.hydro!;
    const s = (this.sky = skyAt(this.plan!, t));
    // Ease toward the clock's sky: a few seconds to close in or clear.
    const k = Math.min(1, dt * 0.8);
    this.rain += (s.rain - this.rain) * k;
    this.cover += (s.cover - this.cover) * k * 0.6;
    this.dark += (s.dark - this.dark) * k * 0.6;
    this.tower += (s.tower - this.tower) * k * 0.5;
    this.towerDir = s.towerDir;
    this.gust += (s.gust - this.gust) * k * 2;
    this.wet = sampleHydro(h.wet, t) * (1 - sc.storm * 0.8);
    this.puddle = sampleHydro(h.puddle, t);
    this.washQ = sampleHydro(h.wash, t);
    this.riverK = sampleHydro(h.river, t);
    this.rainLately = Math.max(this.rain, this.rainLately - dt * 0.02);
    // Is any water in the washes or on the pans? A flood front can still be on its way down long after it left the hills.
    let live = false;
    for (let q = t; q > t - FLOOD_TAIL && !live; q -= 0.004) if (sampleHydro(h.wash, q) > 0.002) live = true;
    this.floodLive = live;
    this.panLive = sampleHydro(h.pan, t) > 0.004 || sampleHydro(h.pan, t - 0.2) > 0.004 || sampleHydro(h.pan, t - FLOOD_TAIL) > 0.004;
    // The wind: the day's breeze and dust, and the gust front a thunderstorm pushes out ahead of it.
    const w = windAt(sc.storm, sc.time);
    const out = this.gust * 15;
    this.wind = [w[0] - Math.sin(this.towerDir) * out, w[1] - Math.cos(this.towerDir) * out];
    this.lightning(dt, s);
    for (let i = this.thunder.length - 1; i >= 0; i--) {
      if (sc.time < this.thunder[i].at) continue;
      weatherAudio(sc.audio).thunder(this.thunder[i].dist);
      this.thunder.splice(i, 1);
    }
    this.fire.update(dt, this.rain, fireDanger(this.wet, this.rain, sc.heat), this.wind);
    if (this.gust > 0.15 && sc.biome === 'wasteland' && this.wet < 0.3) this.gustDust(dt);
    if (sc.mode === 'leg') this.radio(t, s);
  }

  /** Lightning: strikes near the convoy at the cell's rate, flickers far off in a thunderhead on the horizon. */
  private lightning(dt: number, s: Sky) {
    if (s.boltsNear > 0 && Math.random() < (s.boltsNear / 60) * dt) this.strikeNear();
    if (s.boltsFar > 0 && Math.random() < (s.boltsFar / 60) * dt) this.strikeFar();
  }

  private anchor(): { x: number; z: number } | null {
    const live = this.sc.players.filter((p) => p.state !== 'dead');
    if (!live.length) return null;
    const p = live[Math.floor(Math.random() * live.length)];
    return { x: p.vehicle?.position.x ?? p.pos.x, z: p.vehicle?.position.z ?? p.pos.z };
  }

  private nearestPlayer(x: number, z: number): number {
    let d = Infinity;
    for (const p of this.sc.players) if (p.state !== 'dead') d = Math.min(d, Math.hypot((p.vehicle?.position.x ?? p.pos.x) - x, (p.vehicle?.position.z ?? p.pos.z) - z));
    return d;
  }

  /**
   * A strike within a kilometre or so of the convoy. Lightning goes for the tallest thing about: a tree near where it
   * comes down takes it, and may catch. It never comes down on a player, but it can be close enough to feel.
   */
  strikeNear(at?: { x: number; z: number }) {
    const sc = this.sc;
    const p = at ?? this.anchor();
    if (!p) return;
    let x = p.x;
    let z = p.z;
    if (!at) {
      const ang = Math.random() * TAU;
      const d = Math.random() < 0.1 ? 60 + Math.random() * 110 : 200 + Math.pow(Math.random(), 0.8) * 1100;
      x += Math.sin(ang) * d;
      z += Math.cos(ang) * d;
    }
    let y = sc.groundAt(x, z);
    let tree: TreeSpot | null = null;
    let best = 0;
    for (const t of this.fire.hooks.treesNear(x, z, 45)) {
      const hgt = TREE_DIMS[TREE_SPECIES[t.sp]].h * t.s;
      if (hgt > best) {
        best = hgt;
        tree = t;
      }
    }
    if (tree) {
      x = tree.x;
      z = tree.z;
      y = tree.y + best;
    }
    // Never on someone's head.
    const dp = this.nearestPlayer(x, z);
    if (dp < 25 && !tree) return;
    this.bolts.strike(x, y, z, 260 + Math.random() * 140 + (y - sc.groundAt(x, z)));
    this.lastStrike = { x, y, z, tree };
    this.thunder.push({ at: sc.time + dp / SOUND, dist: dp });
    for (const pl of sc.players) {
      const d = Math.hypot((pl.vehicle?.position.x ?? pl.pos.x) - x, (pl.vehicle?.position.z ?? pl.pos.z) - z);
      if (d < 120) pl.cam.addShake(0.5 * (1 - d / 120));
    }
    if (tree) this.fire.ignite(tree, catchChance(fireDanger(this.wet, this.rain, sc.heat)));
  }

  /** A bolt on the horizon under a far thunderhead, and a rumble long after it. */
  private strikeFar() {
    const sc = this.sc;
    const p = this.anchor();
    if (!p) return;
    const ang = this.towerDir + (Math.random() - 0.5) * 0.6;
    const d = 900 + Math.random() * 250;
    const x = p.x + Math.sin(ang) * d;
    const z = p.z + Math.cos(ang) * d;
    this.bolts.strike(x, sc.groundAt(x, z), z, 420 + Math.random() * 220, true);
    const heard = 2000 + Math.random() * 2500;
    this.thunder.push({ at: sc.time + heard / SOUND, dist: heard });
  }

  /** The gust front out ahead of a thunderstorm: a hard cold wind that lifts the dust off dry ground. */
  private gustDust(dt: number) {
    const sc = this.sc;
    this.dustAcc += this.gust * 22 * dt;
    while (this.dustAcc >= 1) {
      this.dustAcc -= 1;
      const p = this.anchor();
      if (!p) return;
      const x = p.x - this.wind[0] * 1.2 + (Math.random() - 0.5) * 50;
      const z = p.z - this.wind[1] * 1.2 + (Math.random() - 0.5) * 50;
      sc.fx.dust(x, sc.groundAt(x, z) + Math.random() * 3, z, this.wind[0] * 4, this.wind[1] * 4, 0.5, [0.74, 0.6, 0.42]);
    }
  }

  private onIgnite(t: TreeSpot) {
    const sc = this.sc;
    if (sc.mode !== 'leg' || this.told.has('fire')) return;
    const p = this.anchor();
    if (!p || Math.hypot(t.x - p.x, t.z - p.z) > 900) return;
    this.told.add('fire');
    const dir = compassWord(Math.atan2(t.x - p.x, t.z - p.z));
    sc.radio(this.rain > 0.3 ? `Lightning hit a tree to the ${dir}. It's burning, but this rain should keep it from spreading.` : `Lightning's set a tree alight to the ${dir}! Everything's bone dry: the whole wood could go. Keep clear of the trees.`);
  }

  /** What the radio says about the weather, each line once a day. */
  private radio(t: number, s: Sky) {
    const sc = this.sc;
    const say = (key: string, text: string) => {
      if (this.told.has(key)) return;
      this.told.add(key);
      sc.radio(text);
    };
    const plan = this.plan!;
    const h = this.hydro!;
    for (const c of plan.cells) {
      const dir = compassWord(c.from);
      if (c.kind === 'far' && s.tower > 0.45) say('far', `Thunderheads standing over the mountains to the ${dir}. If it's raining up there, the washes will run: keep out of the dry beds.`);
      if ((c.kind === 'storm' || c.kind === 'dry') && t > c.start - 0.11 && t < c.start - 0.01) say(`come${c.start}`, `Storm coming in from the ${dir}. Lightning goes for the tall things: keep out from under the trees, and stay in the cars.`);
      if (c.kind === 'dry' && s.boltsNear > 1) say('dry', 'Dry lightning: all flash and no rain. Anything it sets alight will burn.');
    }
    if (this.rain > 0.2) say('rain', 'Rain! Asphalt gets slick, the clay turns to grease. The sand just drinks it.');
    // The flood is known before it leaves the mountains: whoever is up there calls it in.
    if (this.def?.washes?.washes.length && sampleHydro(h.wash, t + 0.012) > 0.15) {
      const p = this.anchor();
      let name = 'the washes';
      if (p) {
        let best = Infinity;
        for (const w of this.def.washes.washes) {
          for (let i = 0; i < w.n; i += 20) {
            const d = Math.hypot(w.x[i] - p.x, w.z[i] - p.z);
            if (d < best) {
              best = d;
              name = w.name;
            }
          }
        }
      }
      say('flood', `FLASH FLOOD! A wall of water is coming down out of the mountains, ${name} first. Get out of the dry washes and off the dips in the road, now!`);
    }
    if (this.riverK > 0.3 && this.def?.hydro?.rivers.length) say('river', 'The rivers are coming up brown and fast. A ford won’t be a ford for long: find a bridge.');
    if (this.bow > 0.35) say('bow', 'Will you look at that: a rainbow. The road will be dry again inside the hour.');
    if (this.def?.washes?.pans.length && this.panLive) {
      const pan = this.def.washes.pans.find((p) => !p.dry && panFill(h, t, p.travel) > 0.3);
      if (pan) say('pan', `The flood has run out onto ${pan.name}: there's standing water on the clay until the sun takes it back.`);
    }
    // Someone standing in a wash as the water comes: a warning of their own.
    const net = this.def?.washes;
    if (net && this.floodLive) {
      for (const p of sc.players) {
        if (p.state === 'dead') continue;
        const x = p.vehicle?.position.x ?? p.pos.x;
        const z = p.vehicle?.position.z ?? p.pos.z;
        const c = washAt(net, x, z, 4);
        if (!c) continue;
        const soon = floodStage(net, c.wash, c.s, t + 0.012, h);
        if (soon > 0.25 && !this.told.has(`in${p.index}`)) {
          this.told.add(`in${p.index}`);
          sc.notify(p.index, 'Water coming down the wash! Get up the bank!', 'bad');
        }
      }
    }
  }

  /** How hard the flood is running near the convoy (0..1), for the clock line and the sound. */
  private floodNearConvoy(): number {
    const net = this.def?.washes;
    if (!net || !this.floodLive || !this.hydro) return 0;
    let best = 0;
    for (const p of this.sc.players) {
      const x = p.vehicle?.position.x ?? p.pos.x;
      const z = p.vehicle?.position.z ?? p.pos.z;
      const c = washAt(net, x, z, 120);
      if (!c) continue;
      const st = floodStage(net, c.wash, c.s, this.sc.clock.t, this.hydro);
      best = Math.max(best, clamp01(st / Math.max(0.3, c.wash.flood)) * (1 - smoothstep(10, 160, c.d)));
    }
    return best;
  }

  // ------------------------------------------------------------------ water

  /** Flood water on top of what the ground holds: rivers risen over their banks, flash floods in the washes, pools on the pans. */
  water(x: number, z: number, base: SceneWater | null): SceneWater | null {
    const def = this.def;
    const h = this.hydro;
    if (!def || !h || !this.active) return base;
    const t = this.sc.clock.t;
    const hy = def.hydro;
    if (hy?.ready && this.riverK > 0.002 && (!base || base.kind === 'river' || base.kind === 'stream')) {
      const c = courseAt(hy, x, z, 10);
      if (c) {
        const r = c.river;
        const rise = this.riverK * riverFloodRise(r.kind) * riseTaper(hy, r, Math.min(r.n - 1, c.i + (c.t > 0.5 ? 1 : 0)));
        if (rise > 0.005) {
          if (base) {
            const k = 1 + rise * 0.9;
            return { ...base, level: base.level + rise, depth: base.depth + rise, flow: base.flow ? [base.flow[0] * k, base.flow[1] * k] : base.flow };
          }
          const level = c.level + rise;
          const depth = level - heightAt(def, x, z);
          if (depth > 0.02) {
            // Out over the floodplain the water still runs downstream, slower than in the channel.
            const sp = (r.speed[c.i] ?? 0.6) * 0.6 * (1 + rise);
            return { level, depth, flow: [r.dx[c.i] * sp, r.dz[c.i] * sp], kind: r.kind, name: r.name };
          }
        }
      }
    }
    if (base) return base;
    const net = def.washes;
    if (!net || (!this.floodLive && !this.panLive)) return null;
    const hit = floodAt(def, net, x, z, t, h, (p) => (this.panLive ? panFill(h, t, p.travel) : 0));
    if (!hit) return null;
    if (!this.floodLive && hit.kind === 'flood') return null;
    return { level: hit.level, depth: hit.depth, flow: hit.flow, kind: hit.kind, name: hit.name };
  }

  /** How dry ground under a wheel behaves now: clay turns to grease in the wet, sand firms up a little. */
  surface<T extends { grip: number; drag: number; name: string }>(s: T, clay: boolean): T {
    if (!this.active) return s;
    const wet = Math.max(this.wet, this.puddle);
    if (clay) return wet > 0.35 ? { ...s, name: 'mud', grip: Math.min(s.grip, 0.5), drag: Math.max(s.drag, 0.2) } : { ...s, name: 'hardpan', grip: Math.max(s.grip, 1), drag: Math.min(s.drag, 0) };
    if (wet < 0.05) return s;
    if (s.name === 'asphalt') return { ...s, grip: s.grip * (1 - 0.18 * wet - 0.12 * this.puddle) };
    if (s.name === 'hardpan') return { ...s, grip: s.grip * (1 - 0.1 * wet) };
    if (s.name === 'sand') return { ...s, grip: s.grip * (1 + 0.15 * wet), drag: s.drag * (1 - 0.3 * wet) };
    return s;
  }

  // ------------------------------------------------------------------ frame

  /** Once per rendered frame, before the light is set: what the renderer, the rain, the floods and the sound show. */
  frame(dt: number) {
    const sc = this.sc;
    const R = sc.R;
    const wx = R.wx;
    if (!wx) return;
    if (!this.active) {
      wx.cover = wx.dark = wx.rain = wx.flash = wx.farFlash = wx.tower = wx.bow = 0;
      wx.heat[0] = wx.heat[1] = 0;
      this.rainFx.update(0, 0, 0, 0, dt);
      return;
    }
    this.ensureDay();
    const t = sc.clock.t;
    const fl = this.bolts.update(dt);
    this.flash = fl.near * (0.45 + 0.55 * this.cover);
    this.farFlash = fl.far;
    // A rainbow wants the rain just passed over, the sun out behind you and not too high.
    const l = R.sunDir;
    const sunOk = smoothstep(0.03, 0.12, l.y) * (1 - smoothstep(0.62, 0.78, l.y));
    this.bow = clamp01((this.rainLately - this.rain * 0.7) * 2.2) * (1 - smoothstep(0.55, 0.85, this.cover)) * (1 - this.dark) * sunOk;
    wx.cover = this.cover;
    wx.dark = this.dark;
    wx.rain = this.rain;
    wx.flash = this.flash;
    wx.farFlash = this.farFlash;
    wx.towerDir = this.towerDir;
    wx.tower = this.tower;
    wx.bow = this.bow;
    for (let i = 0; i < 2; i++) {
      const p = sc.players[i];
      if (!p) {
        wx.heat[i] = 0;
        continue;
      }
      const x = p.vehicle?.position.x ?? p.pos.x;
      const z = p.vehicle?.position.z ?? p.pos.z;
      wx.heat[i] = groundHeat(t, this.cover, this.wet, sc.heat) * this.desert(x, z);
      // Under a roof the rain stops at the roof.
      const io = sc as unknown as { interiorAt?: (x: number, z: number, y: number) => boolean };
      const cam = R.views[i]?.camera;
      this.sheltered[i] = this.rain > 0.01 && cam && io.interiorAt?.(cam.position.x, cam.position.z, cam.position.y) ? 1 : 0;
      this.rainFx.sheltered[i] = this.sheltered[i] > 0;
    }
    this.rainFx.update(this.rain, this.wind[0], this.wind[1], this.flash, dt);
    this.splashes(dt);
    // The rivers and the floods.
    HYDRO.uDayT.value = t;
    const hy = this.def?.hydro;
    const rise = RIVER_RISE.uRise.value;
    rise.fill(0);
    if (hy) for (const r of hy.rivers) if (r.id < MAX_RIVERS) rise[r.id] = this.riverK * riverFloodRise(r.kind);
    RIVER_RISE.uMurk.value = smoothstep(0.04, 0.35, this.riverK);
    if (this.flood && this.hydro) {
      const h = this.hydro;
      this.flood.setPools((p) => (this.panLive ? PAN_POOL * panFill(h, t, p.travel) : 0), this.rain);
    }
    // The sound: rain (duller under a roof or in a cab), the flood, the nearest fire.
    let roof = 0;
    for (let i = 0; i < sc.players.length; i++) roof = Math.max(roof, this.sheltered[i], sc.players[i]?.vehicle && !sc.players[i].firstPerson ? 0.3 : sc.players[i]?.vehicle ? 0.8 : 0);
    let fire = 0;
    for (const f of this.fire.fires) {
      const d = this.nearestPlayer(f.tree.x, f.tree.z);
      fire = Math.max(fire, f.heat * (1 - smoothstep(10, 140, d)));
    }
    // Every other fire crackles too: a campfire close by, a burning car, a grass fire coming.
    for (const p of sc.players) if (p.state !== 'dead') fire = Math.max(fire, sc.fires.loudness(p.vehicle?.position.x ?? p.pos.x, p.vehicle?.position.z ?? p.pos.z));
    weatherAudio(sc.audio).set(sc.suspended ? 0 : this.rain, roof, sc.suspended ? 0 : this.floodNearConvoy(), sc.suspended ? 0 : fire, dt);
  }

  /** How much a place throws heat back: bare sand and rock full, grass and woods hardly, a city's concrete in between. */
  private desert(x: number, z: number): number {
    const sc = this.sc;
    const def = this.def;
    if (sc.mode === 'camp') return sc.biome === 'city' ? 0.5 : 0.9;
    if (!def) return sc.biome === 'city' ? 0.5 : 1;
    const lush = def.hydro ? lushAt(def, x, z) : 0;
    const city = def.open ? districtMask(def.open, x, z) : def.biome === 'city' ? 1 : 0;
    return (1 - 0.9 * lush) * (1 - 0.5 * city);
  }

  /** Drops bursting on the ground round each player. */
  private splashes(dt: number) {
    if (this.rain < 0.05) return;
    const sc = this.sc;
    this.splashAcc += this.rain * 70 * dt;
    while (this.splashAcc >= 1) {
      this.splashAcc -= 1;
      const p = sc.players[Math.floor(Math.random() * sc.players.length)];
      if (!p || p.state === 'dead') continue;
      const cx = p.vehicle?.position.x ?? p.pos.x;
      const cz = p.vehicle?.position.z ?? p.pos.z;
      const a = Math.random() * TAU;
      const r = 1.5 + Math.random() * 14;
      const x = cx + Math.sin(a) * r;
      const z = cz + Math.cos(a) * r;
      const w = sc.waterAt(x, z);
      const y = w ? w.level : sc.groundAt(x, z);
      sc.fx.smoke.emit(x, y + 0.03, z, (Math.random() - 0.5) * 0.6, 0.9 + Math.random() * 0.8, (Math.random() - 0.5) * 0.6, 0.22, 0.05, 0.22, 0.82, 0.84, 0.88, 0.45, 7, 0.6);
    }
  }

  /** Every view hook: the box of rain follows the camera being drawn. */
  beforeView = (i: number, cam: THREE.Camera) => {
    this.rainFx.beforeView(i, cam);
  };

  /** Hide it all while another scene has the screen. */
  setVisible(on: boolean) {
    this.rainFx.mesh.visible = on && this.rain > 0.01;
    this.bolts.group.visible = on;
    if (!on) weatherAudio(this.sc.audio).silence();
  }

  dispose() {
    this.rainFx.dispose();
    this.bolts.dispose();
    this.flood?.dispose();
    this.fire.clear();
    weatherAudio(this.sc.audio).silence();
    RIVER_RISE.uRise.value.fill(0);
    RIVER_RISE.uMurk.value = 0;
  }
}

