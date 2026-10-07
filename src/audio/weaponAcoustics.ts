import type { GunModel } from '../data/gear';
import { GUN_BASE, RELOAD_KIND, dropAt } from '../sim/weaponanim';
import type { SoundId } from './audio';

export interface HandlingEvent { phase: number; cue: SoundId; bank?: string; volume: number; pitch: number }
export function weaponHandling(model: GunModel) {
  const base = GUN_BASE[model];
  const long = base === 'rifle' || base === 'smg' || base === 'pump' || base === 'sawn';
  return { pitch: model === 'cannon' || model === 'lmg' ? .84 : model === 'compact' ? 1.12 : long ? .94 : 1,
    rack: base === 'pump' ? 'weaponPump' as const : base === 'rifle' ? 'weaponBolt' as const : 'weaponRack' as const,
    magazineBank: long ? 'magInRifle' : 'magInPistol' };
}

/** Event phases follow reload pose landmarks; no delayed sounds survive a cancelled reload. */
export function reloadSounds(model: GunModel, each = false, empty = false): HandlingEvent[] {
  const handling = weaponHandling(model);
  const event = (phase: number, cue: SoundId, volume: number, bank?: string): HandlingEvent => ({phase,cue,volume,bank,pitch:handling.pitch});
  if (model === 'bow' || model === 'crossbow') return [event(.2,'weaponHandle',.13),event(.78,'weaponHandle',.18)];
  if (each || RELOAD_KIND[model] === 'shell') return [event(.22,'weaponHandle',.12)];
  if (RELOAD_KIND[model] === 'cylinder') return [event(.14,'weaponClick',.2),event(.6,'shellInsert',.2),event(.88,'weaponClick',.23)];
  return [event(Math.max(.1,dropAt(RELOAD_KIND[model])),'magOut',.22),event(.67,'magIn',.25,handling.magazineBank),
    ...(empty || RELOAD_KIND[model] === 'bolt' ? [event(.88,handling.rack,.27)] : [])];
}

export function crossedHandlingEvents(events: HandlingEvent[], from: number, to: number) {
  return events.filter(event => from < event.phase && to >= event.phase);
}
