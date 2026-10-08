import type { Held } from '../humanoid';
import { WB, type Lod } from './kit';
import { COMPACT, MACHINE, PISTOL, CANNON, REVOLVER, polymerPistol, revolver } from './handguns';

export { WB, type Lod } from './kit';
export { weaponMaterial } from './material';

type Kind = Exclude<Held, 'none'>;

/** The model for each weapon, drawn into a weapon builder. */
const MODELS: Partial<Record<Kind, (w: WB) => void>> = {
  pistol: (w) => polymerPistol(w, PISTOL),
  compact: (w) => polymerPistol(w, COMPACT),
  mp: (w) => polymerPistol(w, MACHINE),
  revolver: (w) => revolver(w, REVOLVER),
  cannon: (w) => revolver(w, CANNON),
};

/** Whether `kind` has a model of its own here. */
export const hasModel = (kind: Kind) => !!MODELS[kind];

/** Start a weapon's builder with its model drawn in, or null when it has none here. */
export function buildModel(kind: Kind, lod: Lod): WB | null {
  const f = MODELS[kind];
  if (!f) return null;
  const w = new WB(lod);
  f(w);
  return w;
}
