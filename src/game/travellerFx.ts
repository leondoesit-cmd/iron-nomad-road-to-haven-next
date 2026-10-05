import { TRAVELLERS, t } from '../data';
import { canHelp, requestCost, resolveRequest, stockText } from '../sim/travellers';
import { LABEL } from '../sim/resources';
import { applyEncounterEffects } from './encounterFx';
import type { Traveller } from './travellers';
import type { LegScene } from './legScene';

/** The text of what a request costs, e.g. "2 Rations"; empty when it costs nothing. */
export function requestCostText(tv: Traveller): string {
  return tv.request ? stockText(requestCost(tv.request), LABEL) : '';
}

/**
 * The players have answered someone on the road who asked for help. Helping pays the cost and earns their thanks and some
 * Mercy; turning them away costs nothing except where it is a matter of life. Not having it to give counts as turning
 * them away, and says so. It is the same effect shape as a Roadside Encounter, but it does not hand the lead over.
 */
export function resolveTravellerRequest(sc: LegScene, tv: Traveller, helped: boolean, overridden: boolean) {
  const kind = tv.request;
  if (!kind) return;
  const ok = helped && canHelp(sc.campaign.stocks, kind);
  if (helped && !ok) sc.notify(-1, t('trav.note.cant', { cost: requestCostText(tv) }), 'warn');
  applyEncounterEffects(sc, resolveRequest(sc.rng, kind, ok), overridden, { keepLead: true });
  if (ok) sc.notify(-1, t('trav.note.helped', { who: tv.name.toLowerCase() }), 'good');
  sc.travellers.answer(tv, ok);
  // A lost traveller who was pointed the right way says what they saw on the road.
  if (ok && TRAVELLERS.requests[kind].rumour) sc.travellers.tellRumour(tv);
}
