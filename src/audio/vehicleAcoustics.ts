import { clamp } from '../core/math';
import type { EngineParams } from './engineAudio';

export type TireTread = 'road' | 'mud' | 'crawler' | 'rim';
export interface AudioTire { tread: TireTread; condition: number }

/** Audio follows the fitted motor rather than the badge on the chassis. */
export function engineCharacter(e: EngineParams) {
  const litres = e.litres ?? (e.tier <= 2 ? .25 : e.tier >= 4 ? 4.5 : 1.8);
  const family = e.fuel === 'diesel' ? 'diesel' : e.layout === 'V8' || litres >= 4 ? 'v8' : litres <= .7 ? 'bike' : 'car';
  const cylinders = Number(e.layout?.match(/\d+/)?.[0] ?? (family === 'bike' ? 1 : family === 'v8' ? 8 : 4));
  return {
    family, cylinders,
    key: `${family}:${e.layout ?? ''}:${litres}`,
    pitch: clamp(Math.pow((family === 'bike' ? .25 : family === 'diesel' ? 3 : family === 'v8' ? 7 : 1.2) / Math.max(.05, litres), .11), .73, 1.28),
    body: clamp(.6 + Math.log2(1 + litres) * .15, .6, 1.2),
    cutoff: clamp(9000 - litres * 450 + cylinders * 180, 4500, 12000),
  };
}

/** Automatic audio gear bands; simulation has gearing ratios but no discrete gear selector. */
export function audioGear(e: EngineParams, previous = 1) {
  if (e.gear !== undefined) return e.gear;
  if ((e.speed ?? 0) < -.6) return -1;
  const normalized = Math.abs(e.speed ?? 0) / Math.max(8, e.topSpeed ?? 28);
  const previousForward = Math.max(1, previous);
  const proposed = clamp(1 + Math.floor(normalized * 4.5), 1, 5);
  // Hysteresis prevents repeated shift clicks around a speed boundary.
  if (proposed > previousForward && normalized < previousForward / 4.5 + .025) return previousForward;
  if (proposed < previousForward && normalized > (previousForward - 1) / 4.5 - .025) return previousForward;
  return proposed;
}

/** Gains are physical state, before listener attenuation and master volume. */
export function vehicleLayers(e: EngineParams) {
  const speed = Math.abs(e.speed ?? 0), moving = clamp((speed - .3) / 22, 0, 1);
  const grounded = e.grounded === false ? 0 : 1;
  const tires = e.tires ?? [];
  const wheelMean = (fn: (t: AudioTire) => number) => tires.length ? tires.reduce((n,t) => n+fn(t),0)/tires.length : 0;
  const lug = wheelMean(t => t.tread === 'mud' ? .65 : t.tread === 'crawler' ? 1 : 0);
  const flat = wheelMean(t => t.condition <= .001 && t.tread !== 'rim' ? 1 : 0);
  const rim = wheelMean(t => t.tread === 'rim' ? 1 : 0);
  const damage = 1 - clamp(e.engineCondition ?? 1, 0, 1);
  const heat = clamp(((e.temperature ?? .2) - .72) / .5, 0, 1);
  const gearWear = 1 - clamp(e.gearboxCondition ?? 1,0,1);
  const running = e.running !== false;
  const load = clamp(e.throttle,0,1);
  return {
    rolling: grounded * moving * (e.surface === 'asphalt' ? .1 + lug*.15 : .16 + lug*.05),
    road: e.surface === 'asphalt', lug, flat: grounded * flat * moving, rim: grounded * rim * moving,
    skid: grounded * moving * clamp((e.slip ?? Math.abs(e.lateralG ?? 0)) - .42,0,1) * (1-flat*.7-rim*.8),
    fan: running ? heat * .16 * clamp((e.radiatorCondition ?? 1) + .15,0,1) : 0,
    steam: clamp(((e.temperature ?? .2) - .9) / .35,0,1) * clamp(e.coolant ?? 1,0,1) * .24,
    exhaust: running ? clamp(((e.exhaustNoise ?? 1)-.8)/1.2,0,1) * (.08+load*.22) : 0,
    gear: moving * (.02 + gearWear*.15 + Math.max(0,(e.strain ?? 1)-1)*.02),
    rattle: running ? damage * (.03+load*.12) + heat * .035 + (1-clamp(e.oil ?? 1,0,1))*.05 : 0,
    ticking: !running ? heat*.1 : 0,
  };
}
