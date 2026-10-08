import { Btn, NAV, wasPressed, type PlayerIntent } from '../input/intents';
import { DRUG_IDS, type DrugId } from '../sim/drugs';
import type { Campaign } from './campaign';
import type { Player } from './player';

/**
 * The drugs quick pick: a key (`Btn.Drugs`) opens a small strip of the drugs this person carries, without pausing and without
 * putting the feet down. Only the keys that choose take a break from their usual jobs while it is open: the number row, the
 * move-forward and move-back keys on foot (never the throttle), the mouse wheel, interact and fire (which take the dose) and
 * crouch (which closes it). Strafing, turning, aiming and jumping carry on as normal.
 */

export interface DrugPick {
  open: boolean;
  /** The drug the strip rests on. */
  sel: DrugId | null;
  /** The drugs on the strip, refilled in place: the ones in the stores. */
  rows: DrugId[];
  /** Seconds since the last input while open: an idle strip folds itself away. */
  idle: number;
  /** A row clicked on the HUD, taken on the next tick. */
  clicked: DrugId | null;
  /** Bumped whenever what the strip shows changes, so the HUD redraws only then. */
  ver: number;
}

/** Seconds an untouched strip stays open. */
export const PICK_IDLE = 8;

export function newDrugPick(): DrugPick {
  return { open: false, sel: null, rows: [], idle: 0, clicked: null, ver: 0 };
}

/** The buttons the strip takes over while it is open (the bits of a `PlayerIntent`), so a press that picks never also acts. */
const MASK =
  (1 << Btn.A) | (1 << Btn.B) | (1 << Btn.RB) | (1 << Btn.RT) | (1 << Btn.Down) | (1 << Btn.Left) | (1 << Btn.Right) | (1 << Btn.Back) |
  (1 << Btn.Eat) | (1 << Btn.Drink) | (1 << Btn.Piss) | (1 << Btn.Shit) | (1 << Btn.Drugs) |
  // 24 is the summon button on the number row (Digit9 for the first keyboard), a pick key here.
  (1 << 24);

const DIGITS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9'];

/** Refill `rows` with what the stores hold. Returns true if it changed. */
function refill(pk: DrugPick, c: Campaign): boolean {
  let n = 0;
  let changed = false;
  for (const id of DRUG_IDS) {
    if ((c.items[id] ?? 0) <= 0) continue;
    if (pk.rows[n] !== id) {
      pk.rows[n] = id;
      changed = true;
    }
    n++;
  }
  if (pk.rows.length !== n) {
    pk.rows.length = n;
    changed = true;
  }
  return changed;
}

/** Whether this person is in a state to reach into their pockets. */
function canPick(p: Player): boolean {
  const living = p.state === 'foot' || p.state === 'driving' || p.state === 'gunner';
  return living && !p.buildMode && !p.drugs.passedOut && p.stunT <= 0 && !p.beltOpen;
}

export function openDrugPick(p: Player): boolean {
  const pk = p.drugPick;
  if (pk.open || !canPick(p)) return false;
  refill(pk, p.ctx.campaign);
  if (!pk.rows.length) {
    p.note('You carry no drugs: the pharmacy at camp makes them', 'info');
    p.ctx.audio.play('deny');
    return false;
  }
  pk.open = true;
  pk.idle = 0;
  pk.clicked = null;
  // Start on the drug the quick belt rests on when there is one, so a habit is one key away.
  pk.sel = pk.rows.includes(p.drugs.selected) ? p.drugs.selected : pk.rows[0];
  pk.ver++;
  return true;
}

export function closeDrugPick(p: Player): boolean {
  const pk = p.drugPick;
  if (!pk.open) return false;
  pk.open = false;
  pk.clicked = null;
  pk.ver++;
  return true;
}

function step(pk: DrugPick, dir: number) {
  if (!pk.rows.length) return;
  const i = pk.sel ? pk.rows.indexOf(pk.sel) : -1;
  pk.sel = pk.rows[(Math.max(0, i) + dir + pk.rows.length) % pk.rows.length];
  pk.idle = 0;
  pk.ver++;
}

/** Whether this seat may use the number row to pick: its own keyboard, and not a key its partner's layout needs. */
export function digitsOk(p: Player): boolean {
  const slots = p.ctx.input.slots;
  const me = slots?.[p.index];
  if (me?.kind !== 'kb') return false;
  if (me.set === 1) return true;
  const other = slots?.[1 - p.index];
  return other?.kind !== 'kb';
}

/**
 * Once per tick, before the rest of the player reads its input: open or close the strip, move the pick, take a dose, and
 * take the picking keys out of the intent so nothing else acts on them.
 */
export function stepDrugPick(p: Player, it: PlayerIntent, dt: number) {
  const pk = p.drugPick;
  if (!pk.open) {
    if (wasPressed(it, Btn.Drugs)) openDrugPick(p);
    if (!pk.open) return;
    // The press that opened it is spent.
    it.pressed &= ~MASK;
    return;
  }
  const c = p.ctx.campaign;
  if (refill(pk, c)) {
    if (!pk.sel || !pk.rows.includes(pk.sel)) pk.sel = pk.rows[0] ?? null;
    pk.ver++;
  }
  // Put away: the key again, crouch, opening the pack, or the body no longer up to it.
  if (wasPressed(it, Btn.Drugs) || wasPressed(it, Btn.B) || wasPressed(it, Btn.Inventory) || !canPick(p) || !pk.rows.length) {
    closeDrugPick(p);
    it.pressed &= ~MASK;
    it.held &= ~MASK;
    return;
  }
  pk.idle += dt;
  // Choose: the number row, forward and back on foot (never the throttle), the mouse wheel.
  if (digitsOk(p)) {
    for (let i = 0; i < DIGITS.length && i < pk.rows.length; i++) {
      if (p.ctx.input.wasKeyPressed?.(DIGITS[i]) && pk.sel !== pk.rows[i]) {
        pk.sel = pk.rows[i];
        pk.idle = 0;
        pk.ver++;
      }
    }
  }
  if (p.state === 'foot') {
    if (it.nav & NAV.up) step(pk, -1);
    if (it.nav & NAV.down) step(pk, 1);
    it.move[1] = 0;
  }
  if (it.toolStep) {
    step(pk, it.toolStep > 0 ? 1 : -1);
    it.toolStep = 0;
  }
  // Take: interact, fire, or a click on the row.
  const take = pk.clicked ?? (wasPressed(it, Btn.A) || wasPressed(it, Btn.RT) ? pk.sel : null);
  pk.clicked = null;
  it.pressed &= ~MASK;
  it.held &= ~MASK;
  it.rt = 0;
  if (take) {
    pk.sel = take;
    if (p.takeDrug(take)) closeDrugPick(p);
    else pk.ver++;
    return;
  }
  if (pk.idle >= PICK_IDLE) closeDrugPick(p);
}
