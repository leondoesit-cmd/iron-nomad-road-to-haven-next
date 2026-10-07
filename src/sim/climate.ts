import { clamp01, smoothstep } from '../core/math';
import { DAMP_CHANCE, hash01, heatLevel, stormWindow } from './weather';

/**
 * Rain, cloud and lightning, and what the land does with the water. Like the dust storms and heat waves of `weather.ts`, a
 * day's sky is fixed by the campaign seed and the day number, so it needs no save data and a reload lands in the same
 * weather.
 *
 * A day may bring rain cells: a thunderstorm overhead, a passing shower, a dry thunderstorm (lightning out of a cloud whose
 * rain dries before it lands, the kind that sets the woods alight), or a storm over the mountains that never comes near,
 * whose rain still comes down the dry washes as a flash flood an hour later under a blue sky.
 *
 * The water follows the land, not the sky:
 * - sand drinks the rain at once: it never stands wet or holds a puddle;
 * - rock, asphalt, packed earth and clay go dark and glossy while it rains and dry off within the hour once the sun is out;
 * - puddles stand in the flat hollows of hard ground, and the clay pans of the desert hold a sheet of water for a day or so;
 * - rain heavier than the ground can soak up runs off the mountains and down the washes as a flash flood, a muddy wall of
 *   water that comes and goes in minutes and fills the clay pan at the bottom;
 * - the rivers rise more slowly and stay high for the rest of the day.
 *
 * Everything is a function of (seed, day, clock). The slow parts (the wet ground, the floods, the pools) are integrated
 * once per day into a table (`hydrograph`) that starts from what the day before left behind.
 */

/** The first day rain can fall. Day one is for learning the road. */
export const RAIN_FIRST_DAY = 2;

export type CellKind = 'storm' | 'shower' | 'dry' | 'far';

export interface RainCell {
  kind: CellKind;
  /** Day-clock fractions: the first drops (on the mountains, for a far cell) and the last. */
  start: number;
  end: number;
  /** How hard it rains at the height of it, 0..1 (on the mountains, for a far cell). */
  peak: number;
  /** Lightning strikes a minute at the height of it. */
  bolts: number;
  /** The way it comes from: a bearing (atan2 of x and z), so +z is 0 and +x is a quarter turn. */
  from: number;
}

export interface DayPlan {
  seed: number;
  day: number;
  /** Fair-weather cloud: how much of the sky the little cumulus covers. */
  fair: number;
  cells: RainCell[];
  /** How hard it rained in the night before the day began, 0..1. */
  night: number;
}

/** The mountains that feed the washes stand to the east and the south. */
const UPSTREAM = Math.PI * 0.62;

const planCache = new Map<string, DayPlan>();

/** The day's rain cells, fair-weather cloud and night rain. Never rain on the first day. */
export function dayPlan(seed: number, day: number): DayPlan {
  const key = `${seed}:${day}`;
  const hit = planCache.get(key);
  if (hit) return hit;
  const h = (salt: number) => hash01(seed, day, salt);
  const cells: RainCell[] = [];
  const fair = 0.12 + h(21) * 0.38;
  if (day >= RAIN_FIRST_DAY) {
    const dust = stormWindow(seed, day);
    const hot = heatLevel(seed, day, 0.42) > 0;
    if (dust) {
      // A wall of dust is often the outflow running ahead of a thunderstorm: the rain follows it in.
      if (h(22) < 0.25) {
        const start = dust.end - (dust.end - dust.start) * 0.18;
        cells.push({ kind: 'storm', start, end: start + 0.07 + h(24) * 0.04, peak: 0.75 + h(25) * 0.25, bolts: 5 + h(26) * 5, from: Math.atan2(-18, 7) });
      }
    } else if (hot) {
      // A scorcher can end in a dry thunderstorm: towers of cloud, lightning, and a few drops that never reach the ground.
      if (h(27) < 0.35) {
        const start = 0.5 + h(28) * 0.1;
        cells.push({ kind: 'dry', start, end: start + 0.07 + h(29) * 0.04, peak: 0.12 + h(30) * 0.1, bolts: 5 + h(31) * 4, from: UPSTREAM + (h(32) - 0.5) * 1.2 });
      }
    } else {
      const r = h(23);
      if (r < 0.24) {
        const start = 0.22 + h(33) * 0.34;
        cells.push({ kind: 'storm', start, end: start + 0.08 + h(34) * 0.06, peak: 0.65 + h(35) * 0.35, bolts: 4 + h(36) * 8, from: UPSTREAM + (h(37) - 0.5) * 2 });
      } else if (r < 0.38) {
        const start = 0.15 + h(38) * 0.38;
        cells.push({ kind: 'far', start, end: start + 0.1 + h(39) * 0.06, peak: 0.8 + h(40) * 0.2, bolts: 6 + h(41) * 6, from: UPSTREAM + (h(42) - 0.5) * 0.9 });
      } else if (r < 0.5) {
        const n = h(43) < 0.5 ? 1 : 2;
        let start = 0.18 + h(44) * 0.25;
        for (let k = 0; k < n; k++) {
          const len = 0.035 + h(45 + k) * 0.035;
          cells.push({ kind: 'shower', start, end: start + len, peak: 0.25 + h(47 + k) * 0.3, bolts: 0, from: h(49 + k) * Math.PI * 2 });
          start += len + 0.08 + h(51 + k) * 0.12;
        }
      }
    }
  }
  const night = day >= RAIN_FIRST_DAY && h(5) < DAMP_CHANCE ? 0.5 + h(6) * 0.5 : 0;
  const plan: DayPlan = { seed, day, fair, cells, night };
  if (planCache.size > 64) planCache.clear();
  planCache.set(key, plan);
  return plan;
}

/** A cell's strength at a clock value: a quick build, a hold, and a longer tail as it rains itself out. */
export function cellLevel(c: RainCell, t: number): number {
  if (t <= c.start || t >= c.end) return 0;
  const span = c.end - c.start;
  const rise = smoothstep(0, 1, (t - c.start) / (span * 0.22));
  const fall = smoothstep(0, 1, (c.end - t) / (span * 0.4));
  return Math.min(rise, fall);
}

/** What a cell drops here, as a share of its peak: a far cell drops nothing here, a dry one almost nothing. */
const HERE: Record<CellKind, number> = { storm: 1, shower: 1, dry: 0.35, far: 0 };
/** What it drops on the mountains that feed the washes and the rivers. */
const UP: Record<CellKind, number> = { storm: 0.9, shower: 0.55, dry: 0.15, far: 1 };
/** How much of the sky its cloud covers overhead, and how dark its base is. */
const COVER: Record<CellKind, number> = { storm: 0.97, shower: 0.8, dry: 0.72, far: 0.12 };
const DARK: Record<CellKind, number> = { storm: 1, shower: 0.45, dry: 0.75, far: 0 };

export interface Sky {
  /** Cloud over the convoy, 0 clear to 1 a lid of cloud. */
  cover: number;
  /** How dark and heavy that cloud is (a thunderhead's base), 0..1. */
  dark: number;
  /** Rain falling here, 0..1. */
  rain: number;
  /** Rain falling on the mountains upstream, 0..1: what feeds the washes and the rivers. */
  rainUp: number;
  /** Lightning strikes a minute overhead, and far off (flashes on the horizon, thunder that rumbles in late). */
  boltsNear: number;
  boltsFar: number;
  /** The bearing of the tallest cloud on the horizon (atan2 of x and z), and how much of the sky it fills there, 0..1. */
  towerDir: number;
  tower: number;
  /** The gust front that runs out ahead of a thunderstorm, 0..1: a hard cold wind that raises the dust. */
  gust: number;
}

/** The sky at a clock value. Cheap: call it every tick. */
export function skyAt(plan: DayPlan, t: number): Sky {
  let cover = plan.fair * (0.6 + 0.4 * smoothstep(0.15, 0.45, t)) * (1 - 0.5 * smoothstep(0.75, 1, t));
  let dark = 0;
  let rain = 0;
  let rainUp = 0;
  let boltsNear = 0;
  let boltsFar = 0;
  let towerDir = UPSTREAM;
  let tower = 0;
  let gust = 0;
  for (const c of plan.cells) {
    const lvl = cellLevel(c, t);
    // The cloud builds before the rain and lingers a little after it.
    const build = smoothstep(c.start - 0.1, c.start + 0.01, t) * (1 - smoothstep(c.end - 0.01, c.end + 0.06, t));
    cover = Math.max(cover, build * COVER[c.kind]);
    dark = Math.max(dark, build * DARK[c.kind]);
    rain = Math.max(rain, lvl * c.peak * HERE[c.kind]);
    rainUp = Math.max(rainUp, lvl * c.peak * UP[c.kind]);
    // On the horizon: the towers of an approaching cell, or a far one standing over the mountains all along.
    const approach = c.kind === 'far' ? build : smoothstep(c.start - 0.14, c.start - 0.05, t) * (1 - smoothstep(c.start - 0.01, c.start + 0.02, t));
    const tw = approach * (c.kind === 'shower' ? 0.45 : 1);
    if (tw > tower) {
      tower = tw;
      towerDir = c.from;
    }
    if (c.kind === 'storm' || c.kind === 'dry') {
      boltsNear = Math.max(boltsNear, lvl * c.bolts);
      // The first strikes are miles off as it comes in.
      boltsFar = Math.max(boltsFar, approach * c.bolts * 0.4);
      gust = Math.max(gust, Math.exp(-(((t - c.start - 0.008) / 0.012) ** 2)));
    } else if (c.kind === 'far') boltsFar = Math.max(boltsFar, lvl * c.bolts);
  }
  return { cover: clamp01(cover), dark: clamp01(dark), rain: clamp01(rain), rainUp: clamp01(rainUp), boltsNear, boltsFar, towerDir, tower: clamp01(tower), gust: clamp01(gust) };
}

/** True when a day has any rain cell at all (the dawn radio and the clock line use this). */
export function isWetDay(seed: number, day: number): boolean {
  return dayPlan(seed, day).cells.length > 0;
}

// ------------------------------------------------------------------------------------------------ the water on the ground

/** The hydrograph runs over this span of the day clock (past 1, into the night), in steps of `HYDRO_DT`. */
export const HYDRO_T1 = 1.25;
export const HYDRO_DT = 0.001;
const HYDRO_N = Math.round(HYDRO_T1 / HYDRO_DT) + 1;
/** The clock gap between one day's end of the table and the next day's dawn. */
const NIGHT_GAP = 0.15;

/** Rain heavier than this soaks into the mountain ground; only the rest runs off. A shower never floods a wash. */
export const SOAK_UP = 0.3;
/** Seconds of the clock (as a share of the day) the runoff takes to gather in the gullies and reach the head of a wash. */
const GATHER = 0.006;
/** The catchment's time constant: how quickly runoff drains out of it. */
const TAU_WASH = 0.011;
/** The rivers' time constant: slow to rise, slower to fall. */
const TAU_RIVER = 0.12;
/** The pans drink and dry their water over about half a day. */
const TAU_PAN = 0.42;

export interface Hydrograph {
  /** Hard ground (rock, asphalt, packed earth, clay) wet from rain, 0 dry to 1 streaming. Sand is never wet. */
  wet: Float32Array;
  /** Puddles in the flat hollows of hard ground, 0..1. */
  puddle: Float32Array;
  /** Runoff leaving the mountains into the heads of the washes, 0 dry to 1 the biggest flood. */
  wash: Float32Array;
  /** How far the rivers have risen toward their full flood rise, 0..1. */
  river: Float32Array;
  /** How full a clay pan at the foot of a wash is, 0..1, before the wash's own travel time (see `panFill`). */
  pan: Float32Array;
}

interface Stores {
  wet: number;
  puddle: number;
  catchment: number;
  river: number;
  pan: number;
}

/** How quickly wet ground and puddles give their water back to the air: fast in the sun, slow at night or under cloud. */
function evaporation(t: number, cover: number, heat: number): number {
  const tt = ((t % 1) + 1) % 1;
  const sun = smoothstep(0.02, 0.15, tt) * (1 - smoothstep(0.84, 0.98, tt));
  return (0.2 + 0.8 * sun) * (1 - 0.6 * cover) * (1 + 0.6 * heat);
}

function integrate(seed: number, day: number, s: Stores, out: Hydrograph | null) {
  const plan = dayPlan(seed, day);
  const gatherSteps = Math.round(GATHER / HYDRO_DT);
  const lag: number[] = new Array(gatherSteps + 1).fill(s.catchment / TAU_WASH);
  for (let i = 0; i < HYDRO_N; i++) {
    const t = i * HYDRO_DT;
    const sky = skyAt(plan, t);
    const ev = evaporation(t, sky.cover, heatLevel(seed, day, t));
    const dt = HYDRO_DT;
    // Hard ground darkens in seconds and dries in a quarter of an hour of sun.
    s.wet += (Math.pow(sky.rain, 1.3) * 160 * (1 - s.wet) - s.wet * ev * 27) * dt;
    // Puddles need rain that keeps coming faster than the ground drinks it.
    s.puddle += (Math.max(0, sky.rain - 0.22) * 14 * (1 - s.puddle) - s.puddle * ev * 4.5) * dt;
    // The mountains shed what they cannot soak up.
    const excess = Math.max(0, sky.rainUp - SOAK_UP) / (1 - SOAK_UP);
    const q = s.catchment / TAU_WASH;
    s.catchment += (excess - q) * dt;
    lag.push(q);
    const wash = lag.shift()!;
    // The rivers: fed by the whole catchment, the washes that run into them included.
    const inflow = (Math.max(0, sky.rainUp - 0.12) / 0.88) * 0.55 + wash * 0.45;
    s.river += (inflow - s.river / TAU_RIVER) * dt;
    // A pan: what the wash brings, and the rain that falls straight on it. It only drinks and dries.
    s.pan += (wash * 11 * (1 - s.pan * 0.6) + sky.rain * 0.6 - (s.pan / TAU_PAN) * (0.5 + 0.5 * ev)) * dt;
    s.wet = clamp01(s.wet);
    s.puddle = clamp01(s.puddle);
    s.pan = Math.max(0, s.pan);
    if (out) {
      out.wet[i] = s.wet;
      out.puddle[i] = s.puddle;
      out.wash[i] = clamp01(wash);
      out.river[i] = clamp01(s.river / TAU_RIVER);
      out.pan[i] = clamp01(s.pan);
    }
  }
}

const hydroCache = new Map<string, Hydrograph>();

/** What the day before left on the ground at dawn, with the night's own rain on top. */
function dawnStores(seed: number, day: number): Stores {
  const s: Stores = { wet: 0, puddle: 0, catchment: 0, river: 0, pan: 0 };
  if (day > 1) {
    integrate(seed, day - 1, s, null);
    s.wet *= Math.exp(-NIGHT_GAP * 3);
    s.puddle *= Math.exp(-NIGHT_GAP * 1.2);
    s.catchment *= Math.exp(-NIGHT_GAP / TAU_WASH);
    s.river *= Math.exp(-NIGHT_GAP / TAU_RIVER);
    s.pan *= Math.exp(-NIGHT_GAP / TAU_PAN);
  }
  const n = dayPlan(seed, day).night;
  if (n > 0) {
    s.wet = Math.max(s.wet, n);
    s.puddle = Math.max(s.puddle, n * 0.8);
    s.river += n * 0.35 * TAU_RIVER;
    s.pan = Math.max(s.pan, n * 0.3);
  }
  return s;
}

/** The day's water on the ground, sampled every `HYDRO_DT` of the clock. Cached. */
export function hydrograph(seed: number, day: number): Hydrograph {
  const key = `${seed}:${day}`;
  const hit = hydroCache.get(key);
  if (hit) return hit;
  const out: Hydrograph = {
    wet: new Float32Array(HYDRO_N),
    puddle: new Float32Array(HYDRO_N),
    wash: new Float32Array(HYDRO_N),
    river: new Float32Array(HYDRO_N),
    pan: new Float32Array(HYDRO_N),
  };
  integrate(seed, day, dawnStores(seed, day), out);
  if (hydroCache.size > 16) hydroCache.clear();
  hydroCache.set(key, out);
  return out;
}

/** A hydrograph series at a clock value (linear between samples, held at the ends). */
export function sampleHydro(series: Float32Array, t: number): number {
  const f = t / HYDRO_DT;
  if (f <= 0) return series[0];
  const i = Math.floor(f);
  if (i >= series.length - 1) return series[series.length - 1];
  const k = f - i;
  return series[i] + (series[i + 1] - series[i]) * k;
}

/** How full a pan is, given how long (as a share of the day) its wash takes to bring the flood down to it. */
export function panFill(h: Hydrograph, t: number, travel: number): number {
  return sampleHydro(h.pan, t - travel);
}

// ------------------------------------------------------------------------------------------------ heat off the ground

/**
 * How hard the ground throws heat back up, 0..1: what makes the air shimmer and the far road turn to water. It takes a high
 * sun in a clear sky over dry ground, and a heat wave doubles it. Wet ground stays cool while it dries.
 */
export function groundHeat(t: number, cover: number, wet: number, heat: number): number {
  const sun = smoothstep(0.13, 0.32, t) * (1 - smoothstep(0.6, 0.78, t));
  return clamp01(sun * (1 - cover * 0.85) * (1 - wet * 0.9) * (0.5 + 0.5 * heat));
}

/**
 * How ready the land is to burn, 0 soaked to 1 tinder: dry ground, a hot day, and no rain falling. A dry thunderstorm is
 * the danger: lightning with nothing to put the fire out.
 */
export function fireDanger(wet: number, rain: number, heat: number): number {
  return clamp01((1 - wet * 0.85) * (1 - rain * 0.9) * (0.55 + 0.45 * heat));
}

/** Share of its normal sight range a raider keeps in the rain. */
export function rainSight(rain: number): number {
  return 1 - 0.35 * clamp01(rain);
}

/** The label for the clock line: nothing in fair weather. */
export function rainLabel(sky: Sky, flood: number): string {
  if (flood > 0.15) return 'FLASH FLOOD';
  if (sky.rain > 0.08 && sky.boltsNear > 0.5) return 'THUNDERSTORM';
  if (sky.boltsNear > 0.5) return 'DRY LIGHTNING';
  if (sky.rain > 0.5) return 'HEAVY RAIN';
  if (sky.rain > 0.08) return 'RAIN';
  if (sky.boltsFar > 0.5 && sky.tower > 0.3) return 'THUNDER OFF';
  return '';
}
