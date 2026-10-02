/**
 * Drugs: single-dose consumables with a timed upside, a comedown, and a body that keeps score.
 * Pure simulation (no rendering, no input) so the numbers can be tested. One `DrugState` lives on each player.
 *
 *  - Each drug adds `toxicity` (decays slowly). Past 1 the body is overdosing and takes damage until it drops back.
 *  - Each drug adds `dependence` (decays very slowly). A dependent body that has gone without for a while is in
 *    withdrawal: slower, shaky, seeing things.
 *  - Effects are modifiers, folded into one `DrugMods` the player and HUD read each frame.
 */

export type DrugId = 'stim' | 'painkiller' | 'adrenaline' | 'haze';
export const DRUG_IDS: DrugId[] = ['stim', 'painkiller', 'adrenaline', 'haze'];

export interface DrugDef {
  id: DrugId;
  name: string;
  /** Short line for prompts and the ledger. */
  blurb: string;
  /** Seconds the main effect lasts. */
  duration: number;
  /** Seconds of comedown after the main effect ends (0 for none). */
  crash: number;
  /** Instant health restored on use. */
  heal: number;
  tox: number;
  dep: number;
  /** Multipliers while the main effect runs. */
  on: Partial<DrugMods>;
  /** Multipliers during the comedown. */
  down: Partial<DrugMods>;
}

export interface DrugMods {
  /** Walk / sprint speed multiplier. */
  speed: number;
  /** Damage taken multiplier (lower is tougher). */
  damage: number;
  /** Noise (signature) multiplier. */
  noise: number;
  /** Extra camera shake / aim wobble, 0..1. */
  shake: number;
  /** Health regained per second. */
  regen: number;
  /** Screen distortion strength, 0..1. */
  haze: number;
  /** Health lost per second to overdose. */
  poison: number;
}

export const NEUTRAL: DrugMods = { speed: 1, damage: 1, noise: 1, shake: 0, regen: 0, haze: 0, poison: 0 };

export const DRUGS: Record<DrugId, DrugDef> = {
  stim: {
    id: 'stim',
    name: 'Stim',
    blurb: 'Run faster for 40s. The crash costs you.',
    duration: 40,
    crash: 25,
    heal: 0,
    tox: 0.35,
    dep: 0.15,
    on: { speed: 1.25, shake: 0.12 },
    down: { speed: 0.86 },
  },
  painkiller: {
    id: 'painkiller',
    name: 'Painkillers',
    blurb: 'Halves damage for 90s. You feel nothing, then everything.',
    duration: 90,
    crash: 20,
    heal: 0,
    tox: 0.2,
    dep: 0.1,
    on: { damage: 0.5 },
    down: { speed: 0.92, shake: 0.1 },
  },
  adrenaline: {
    id: 'adrenaline',
    name: 'Adrenaline',
    blurb: 'Heal 30, near-immunity for 12s, then a hard crash.',
    duration: 12,
    crash: 30,
    heal: 30,
    tox: 0.45,
    dep: 0.1,
    on: { speed: 1.15, damage: 0.3, shake: 0.2 },
    down: { speed: 0.78, shake: 0.2 },
  },
  haze: {
    id: 'haze',
    name: 'Spore haze',
    blurb: 'Quiet and slow-healing for 60s. The world swims.',
    duration: 60,
    crash: 15,
    heal: 0,
    tox: 0.15,
    dep: 0.3,
    on: { noise: 0.7, regen: 0.6, haze: 0.8, shake: 0.3, speed: 0.95 },
    down: { haze: 0.25 },
  },
};

export const TOX_OVERDOSE = 1;
export const TOX_DECAY = 0.012;
export const DEP_DECAY = 0.002;
/** Seconds without a dose before a dependent body starts to withdraw, and how long it takes to reach the worst of it. */
export const WITHDRAW_AFTER = 90;
export const WITHDRAW_RAMP = 60;
const OVERDOSE_DPS = 5;

export interface ActiveDrug {
  id: DrugId;
  /** Seconds left of the main effect. */
  left: number;
  /** Seconds left of the comedown once the effect is over. */
  crash: number;
}

export interface DoseResult {
  heal: number;
  /** Set when the dose pushed the body over the line. */
  overdose: boolean;
  /** Set when this dose took the edge off a withdrawal. */
  relieved: boolean;
}

export class DrugState {
  active: ActiveDrug[] = [];
  toxicity = 0;
  dependence = 0;
  /** Seconds since the last dose. */
  since = 999;
  /** Which drug the use button takes. */
  selected: DrugId = 'stim';

  dose(id: DrugId): DoseResult {
    const def = DRUGS[id];
    const relieved = this.withdrawal > 0.2;
    const cur = this.active.find((a) => a.id === id);
    if (cur) {
      cur.left = Math.max(cur.left, def.duration);
      cur.crash = def.crash;
    } else this.active.push({ id, left: def.duration, crash: def.crash });
    this.toxicity += def.tox;
    this.dependence = Math.min(1, this.dependence + def.dep);
    this.since = 0;
    return { heal: def.heal, overdose: this.toxicity >= TOX_OVERDOSE, relieved };
  }

  /** 0..1: how hard the body is craving. Only a dependent body that has gone without a while. */
  get withdrawal(): number {
    if (this.dependence < 0.25) return 0;
    const ramp = Math.min(1, Math.max(0, (this.since - WITHDRAW_AFTER) / WITHDRAW_RAMP));
    return this.dependence * ramp;
  }

  get overdosing() {
    return this.toxicity >= TOX_OVERDOSE;
  }

  /** True while any dose is running or coming down. */
  get high() {
    return this.active.length > 0;
  }

  cycle(owned: (id: DrugId) => number) {
    const start = DRUG_IDS.indexOf(this.selected);
    for (let i = 1; i <= DRUG_IDS.length; i++) {
      const id = DRUG_IDS[(start + i) % DRUG_IDS.length];
      if (owned(id) > 0) {
        this.selected = id;
        return id;
      }
    }
    this.selected = DRUG_IDS[(start + 1) % DRUG_IDS.length];
    return this.selected;
  }

  update(dt: number) {
    this.since += dt;
    this.toxicity = Math.max(0, this.toxicity - TOX_DECAY * dt);
    this.dependence = Math.max(0, this.dependence - DEP_DECAY * dt);
    for (const a of this.active) {
      if (a.left > 0) a.left -= dt;
      else a.crash -= dt;
    }
    this.active = this.active.filter((a) => a.left > 0 || a.crash > 0);
  }

  /** Everything the body is doing right now, folded into one set of multipliers. */
  mods(): DrugMods {
    const m: DrugMods = { ...NEUTRAL };
    for (const a of this.active) {
      const src = a.left > 0 ? DRUGS[a.id].on : DRUGS[a.id].down;
      m.speed *= src.speed ?? 1;
      m.damage *= src.damage ?? 1;
      m.noise *= src.noise ?? 1;
      m.shake = Math.min(1, m.shake + (src.shake ?? 0));
      m.regen += src.regen ?? 0;
      m.haze = Math.min(1, m.haze + (src.haze ?? 0));
    }
    const w = this.withdrawal;
    if (w > 0) {
      m.speed *= 1 - 0.14 * w;
      m.shake = Math.min(1, m.shake + 0.35 * w);
      m.haze = Math.min(1, m.haze + 0.3 * w);
    }
    if (this.overdosing) {
      m.poison = OVERDOSE_DPS * (this.toxicity - TOX_OVERDOSE + 0.4);
      m.speed *= 0.7;
      m.shake = 1;
      m.haze = Math.min(1, m.haze + 0.5);
    }
    return m;
  }

  /** Short labels for the HUD: what is active and what is coming. */
  status(): { text: string; kind: 'good' | 'warn' | 'bad' }[] {
    const out: { text: string; kind: 'good' | 'warn' | 'bad' }[] = [];
    for (const a of this.active) {
      const def = DRUGS[a.id];
      if (a.left > 0) out.push({ text: `${def.name.toUpperCase()} ${Math.ceil(a.left)}s`, kind: 'good' });
      else out.push({ text: `${def.name.toUpperCase()} COMEDOWN ${Math.ceil(a.crash)}s`, kind: 'warn' });
    }
    if (this.overdosing) out.push({ text: 'OVERDOSE', kind: 'bad' });
    else if (this.withdrawal > 0.3) out.push({ text: 'WITHDRAWAL', kind: 'bad' });
    return out;
  }
}
