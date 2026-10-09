import type { Held } from '../humanoid';
import { WB, type Lod, type Looks } from './kit';
import { drawBow } from '../bow';
import { COMPACT, MACHINE, PISTOL, CANNON, REVOLVER, polymerPistol, revolver } from './handguns';
import { ar, br, carbine, crossbow, dmr, lever, lmg, rifle, sniper } from './rifles';
import { policeSmg, scrapSmg } from './smgs';
import { coach, combat, pump, sawn } from './shotguns';
import { axe, bat, crowbar, flare, jerrycan, katana, knife, machete, pipe, sledge, wrench } from './melee';

export { WB, type Lod, type Looks } from './kit';
export { weaponMaterial, weaponShader } from './material';

type Kind = Exclude<Held, 'none'>;

/** The model for each weapon, drawn into a weapon builder. */
const MODELS: Partial<Record<Kind, (w: WB, looks: Looks) => void>> = {
  pistol: (w) => polymerPistol(w, PISTOL),
  compact: (w) => polymerPistol(w, COMPACT),
  mp: (w) => polymerPistol(w, MACHINE),
  revolver: (w) => revolver(w, REVOLVER),
  cannon: (w) => revolver(w, CANNON),
  ar: (w, l) => ar(w, l),
  dmr: (w, l) => dmr(w, l),
  br: (w, l) => br(w, l),
  rifle: (w, l) => rifle(w, !l.optic),
  sniper: (w, l) => sniper(w, !l.optic),
  carbine: (w, l) => carbine(w, l),
  lever,
  lmg: (w, l) => lmg(w, l),
  crossbow,
  smg: (w, l) => scrapSmg(w, l),
  smg2: (w, l) => policeSmg(w, l),
  sawn,
  coach,
  pump,
  combat,
  knife,
  machete,
  katana,
  bat,
  pipe,
  sledge,
  axe,
  wrench,
  crowbar,
  jerrycan,
  flare,
  // The bow is its own rig (`render/bow.ts`); this is its one-piece model for the ground and the third-person hand.
  bow: (w) => w.raw({ c: 0xffffff, f: 0 }, (b) => drawBow(b)),
};

/** Whether `kind` has a model of its own here. */
export const hasModel = (kind: Kind) => !!MODELS[kind];

/** Start a weapon's builder with its model drawn in, or null when it has none here. */
export function buildModel(kind: Kind, lod: Lod, looks: Looks = {}, split = false): WB | null {
  const f = MODELS[kind];
  if (!f) return null;
  const w = new WB(lod);
  w.split = split;
  f(w, looks);
  return w;
}
