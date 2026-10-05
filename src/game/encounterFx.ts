import { STOCK_IDS } from '../data';
import { applyAxes, type ResolvedEffects } from '../sim/endings';
import { applyLoyalty } from '../sim/loyalty';
import type { LegScene } from './legScene';

/** Apply the outcome of a Roadside Encounter to the campaign and the running leg. */
export function applyEncounterEffects(sc: LegScene, fx: ResolvedEffects, overridden: boolean, opts: { keepLead?: boolean } = {}) {
  const c = sc.campaign;
  for (const id of STOCK_IDS) {
    const d = fx.stocks[id];
    if (!d) continue;
    c.stocks[id] = Math.max(0, c.stocks[id] + d);
  }
  applyAxes(c.axes, fx.axes);
  if (overridden) c.axes.trust -= 1; // overriding your partner costs one point of Trust
  if (fx.loyalty) {
    for (const m of c.crewLive) applyLoyalty(m, fx.loyalty * 3, fx.loyalty < 0 ? 'Disliked a choice' : undefined);
  }
  if (fx.fragment) {
    let n = 1;
    while (c.fragments.has(n) && n <= 4) n++;
    if (n <= 4) {
      c.fragments.add(n);
      sc.notify(-1, `Radio fragment ${c.fragments.size}/4`, 'good');
    }
  }
  if (fx.ambush > 0) sc.spawnAmbush(fx.ambush);
  if (fx.zombies > 0) sc.spawnZombieGroup(fx.zombies);
  // The lead alternates each encounter. A word with someone on the road is not one.
  if (!opts.keepLead) c.lead = c.lead === 0 ? 1 : 0;
  const parts: string[] = [];
  for (const id of STOCK_IDS) {
    const d = fx.stocks[id];
    if (d) parts.push(`${d > 0 ? '+' : ''}${Math.round(d)} ${id}`);
  }
  if (parts.length) sc.notify(-1, parts.join('  '), parts.some((p) => p.startsWith('-')) ? 'warn' : 'good');
}
