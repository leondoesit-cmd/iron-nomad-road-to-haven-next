import { MERCS } from '../data';
import { nightlyUpkeep } from '../sim/loyalty';
import type { Scene } from './scene';

/**
 * Nights without a camp (night camp off, the default). After the Dusk Bell the convoy can stop wherever it stands and pick
 * between resting until dawn (no raid, the dawn report and the Ledger) and making camp (the build, the raid, and the night's
 * haul for holding out); or it can carry on through the dark and greet the next morning on the road. The scene keeps the
 * clock and the prompts (`LegScene`); this file holds the rules that are not about the leg itself.
 */

/** Nobody stops for the night with anything hunting them closer than this (m): a raider on foot counts from further. */
export const REST_CLEAR = 45;

/** The prompt under the feet of anyone on foot after the Bell, by what it would do. */
export const STOP_PROMPT = {
  camp: 'Hold to make camp here',
  stop: 'Hold to stop for the night',
  hostile: 'Something is hunting you: shake it before you stop',
} as const;

/**
 * Something is after the convoy close to (x, z): one of the dead chasing (or up and about within a few steps), a raider on
 * foot, or a hostile vehicle (those are fast, so they count from twice as far). The same rule as a player's own sense of
 * danger, at camping range.
 */
export function hostilesNear(sc: Scene, x: number, z: number, r = REST_CLEAR): boolean {
  const r2 = r * r;
  for (const zb of sc.zombies.list) {
    if (zb.dead) continue;
    const d2 = (zb.x - x) ** 2 + (zb.z - z) ** 2;
    if (d2 < r2 && (zb.chasing || d2 < 144)) return true;
  }
  for (const u of sc.raiders.units) if (!u.dead && (u.x - x) ** 2 + (u.z - z) ** 2 < r2 * 2.25) return true;
  for (const v of sc.vehicles) if (v.hostile && !v.wreck && (v.position.x - x) ** 2 + (v.position.z - z) ** 2 < r2 * 4) return true;
  return false;
}

/**
 * The crew's morning after a night on the road: each is fed and paid from the stores, or goes without, as at a camp. Their
 * verdict (a dispute, a desertion) waits for the next time the convoy stops for a night. Returns radio lines worth saying.
 */
export function crewMorning(sc: Scene): string[] {
  const c = sc.campaign;
  const out: string[] = [];
  for (const m of c.crewLive) {
    const res = nightlyUpkeep(m, c.stocks, MERCS.roles[m.role]);
    if (!res.ok) out.push(`${m.name} went without last night: -${Math.abs(MERCS.loyalty.missedUpkeep)} loyalty.`);
    if (res.events.includes('warn2')) out.push(`${m.name}: "One more missed meal and I walk. Last warning."`);
    else if (res.events.includes('warn1')) out.push(`${m.name}: "Pay me what I'm owed, or I'm done riding with you."`);
  }
  return out;
}
