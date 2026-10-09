import { Btn, BTN_COUNT, NAV, isHeld, wasPressed, wasReleased, type PlayerIntent } from '../input/intents';
import { gearDef } from '../data/gear';
import { BELT_SIZE, UTILITY_SLOT, equipFromBag, isWeapon, type Loadout } from '../sim/gear';
import { DRUG_IDS } from '../sim/drugs';
import { NEED_ACTS } from '../sim/needs';
import { wildLot } from './wildShrooms';
import { storageOf } from './storage';
import type { Player, QuickId, Utility } from './player';

/**
 * The quick select wheel: hold the swap key (Q) on a keyboard, or hold any D-pad direction on a pad, and a cross of four arms
 * opens: up the weapons, right the tools, down everything for the body (dressings, food, water, the chores), left the drugs.
 * The game keeps running. A pad opens it on the arm the held direction points at.
 *
 * Choosing: a direction picks an arm, the same direction again steps along it (the D-pad, the move keys, a flick of the right
 * stick, or the mouse pushed that way); LB / RB on a pad and the mouse wheel step back and forth. Letting go of the button
 * that opened it takes what it rests on, if anything was chosen while it was held. On a pad a hold let go without choosing
 * leaves the wheel open for the D-pad: A or RT takes, B puts it away. On keys, interact or fire take and crouch puts it away.
 *
 * Taps keep their old jobs: Q swaps the tool in hand, D-pad up pings, down takes what the quick belt rests on, left opens the
 * inventory, right the map. Those taps now land on release instead of the press, so a hold can become the wheel. On a pad
 * the crew orders wheel moved from holding D-pad up to holding LB (game.ts). A device of 'none' (tests, replays) keeps the
 * old behaviour of every button.
 */

export type ArmId = 'weapons' | 'tools' | 'health' | 'drugs';
/** Clockwise from the top, as the arms sit on screen. */
export const ARMS: ArmId[] = ['weapons', 'tools', 'health', 'drugs'];
export const ARM_NAME: Record<ArmId, string> = { weapons: 'Weapons', tools: 'Tools', health: 'Health', drugs: 'Drugs' };

export type WheelEntry =
  | { kind: 'belt'; key: string; slot: number; id: string }
  | { kind: 'bag'; key: string; uid: string; id: string }
  | { kind: 'util'; key: string; id: Utility }
  | { kind: 'quick'; key: string; id: QuickId };

export interface QuickWheel {
  open: boolean;
  /** The arm in use, an index into `ARMS`. */
  arm: number;
  /** What each arm rests on, by entry key, so a refill keeps the place. */
  pick: string[];
  /** Each arm's entries, refilled every tick while open. */
  rows: WheelEntry[][];
  /** The button whose hold opened it, or -1 once it was let go (the wheel then stays open on a pad). */
  opener: number;
  /** Something was chosen since it opened. */
  changed: boolean;
  /** Seconds without input while it stays open on its own. */
  idle: number;
  /** The mouse's push since the wheel opened (radians), to point at an arm. */
  cursor: [number, number];
  /** The right stick was out of the middle last tick, so a flick counts once. */
  flick: boolean;
  /** Seconds each watched button has been down (tests have no input manager to count it). */
  holdT: Float32Array;
  /** How long each watched button was down when it was last let go. */
  lastHeld: Float32Array;
  /** Watched buttons whose press became a wheel and must not act when let go. */
  spent: number;
  /** Bumped whenever what it shows changes. */
  ver: number;
}

/** Seconds a D-pad direction is held before it opens the wheel instead of doing its tap. */
export const WHEEL_HOLD = 0.3;
/** Seconds Q is held before it opens the wheel. LB on a pad holds this long for the crew orders. */
export const SWAP_HOLD = 0.25;
/** Seconds an untouched wheel stays open after its button was let go. */
const IDLE_CLOSE = 8;

/** The pad's D-pad actions and the arm each opens. Bits of the logical buttons, so a rebinding moves them along. */
const PAD_ARM: [number, number][] = [
  [Btn.Up, 0],
  [Btn.Map, 1],
  [Btn.Down, 2],
  [Btn.Inventory, 3],
];
const bit = (b: number) => 1 << b;
const WATCH_PAD = bit(Btn.Up) | bit(Btn.Down) | bit(Btn.Inventory) | bit(Btn.Map) | bit(Btn.LB);
/** What the open wheel takes from the intent so nothing else acts on it. */
const MASK =
  bit(Btn.A) | bit(Btn.B) | bit(Btn.RB) | bit(Btn.RT) | bit(Btn.LB) | bit(Btn.Up) | bit(Btn.Down) | bit(Btn.Inventory) | bit(Btn.Map) |
  bit(Btn.Jump) | bit(Btn.Drugs) | bit(Btn.Eat) | bit(Btn.Drink) | bit(Btn.Piss) | bit(Btn.Shit);

export function newQuickWheel(): QuickWheel {
  return { open: false, arm: 0, pick: ['', '', '', ''], rows: [[], [], [], []], opener: -1, changed: false, idle: 0, cursor: [0, 0], flick: false, holdT: new Float32Array(BTN_COUNT), lastHeld: new Float32Array(BTN_COUNT), spent: 0, ver: 0 };
}

const HEALTH: QuickId[] = ['bandage', 'medkit', ...NEED_ACTS];
const isTool = (id: string) => gearDef(id).kind === 'tool';

/** What each arm holds right now. */
export function wheelRows(p: Player): WheelEntry[][] {
  const g = p.gear;
  const items = p.ctx.campaign.items;
  const weapons: WheelEntry[] = [];
  const tools: WheelEntry[] = [];
  g.belt.forEach((b, slot) => {
    if (!b) return;
    const e: WheelEntry = { kind: 'belt', key: `belt:${b.uid}`, slot, id: b.id };
    if (isWeapon(gearDef(b.id))) weapons.push(e);
    else if (isTool(b.id)) tools.push(e);
  });
  // The throwables: the fire and the charge fight, the flare and the horn are tools. One in hand stays listed when it runs out.
  const util = (id: Utility) => id === 'horn' || items[id] > 0 || (g.sel === UTILITY_SLOT && p.utility === id);
  for (const id of ['molotov', 'charge'] as const) if (util(id)) weapons.push({ kind: 'util', key: `util:${id}`, id });
  for (const id of ['flare', 'horn'] as const) if (util(id)) tools.push({ kind: 'util', key: `util:${id}`, id });
  for (const b of g.bag) {
    const d = gearDef(b.id);
    if (isWeapon(d)) weapons.push({ kind: 'bag', key: `bag:${b.uid}`, uid: b.uid, id: b.id });
    else if (d.kind === 'tool') tools.push({ kind: 'bag', key: `bag:${b.uid}`, uid: b.uid, id: b.id });
  }
  const health: WheelEntry[] = HEALTH.map((id) => ({ kind: 'quick', key: `quick:${id}`, id }));
  const drugs: WheelEntry[] = DRUG_IDS.filter((id) => (items[id] ?? 0) > 0).map((id) => ({ kind: 'quick', key: `quick:${id}`, id }));
  if (wildLot(p)) drugs.push({ kind: 'quick', key: 'quick:wild', id: 'wild' });
  return [weapons, tools, health, drugs];
}

/** The entry an arm rests on, or null when the arm is empty. */
export function wheelSel(w: QuickWheel, arm = w.arm): WheelEntry | null {
  const row = w.rows[arm];
  return row.find((e) => e.key === w.pick[arm]) ?? row[0] ?? null;
}

/** Whether this person can reach for the wheel at all. */
function canWheel(p: Player): boolean {
  const living = p.state === 'foot' || p.state === 'driving' || p.state === 'gunner';
  return living && !p.buildMode && !p.drugs.passedOut && p.stunT <= 0 && !p.drugPick.open && p.mapMode === 0 && !storageOf(p);
}

/** Where each arm starts: what is in hand for weapons and tools, what the quick belt rests on for the rest. */
function homePicks(p: Player, w: QuickWheel) {
  const g = p.gear;
  const inHand = g.sel === UTILITY_SLOT ? `util:${p.utility}` : g.belt[g.sel] ? `belt:${g.belt[g.sel]!.uid}` : '';
  const quick = `quick:${p.quickSel}`;
  for (let a = 0; a < 4; a++) {
    const row = w.rows[a];
    w.pick[a] = row.some((e) => e.key === inHand) ? inHand : row.some((e) => e.key === quick) ? quick : (row[0]?.key ?? '');
  }
}

/** Open the wheel on an arm (`opener` is the button being held, or -1). */
export function openQuickWheel(p: Player, arm?: number, opener = -1): boolean {
  const w = p.quickWheel;
  if (w.open || !canWheel(p)) return false;
  w.rows = wheelRows(p);
  homePicks(p, w);
  // Q opens on what is in hand: a tool in hand opens the tools.
  w.arm = arm ?? (p.equip === 'gun' || p.equip === 'melee' || (p.equip === 'utility' && (p.utility === 'molotov' || p.utility === 'charge')) ? 0 : 1);
  w.open = true;
  w.opener = opener;
  w.changed = false;
  w.idle = 0;
  w.cursor[0] = w.cursor[1] = 0;
  w.flick = false;
  w.ver++;
  p.ctx.audio.play('weaponHandle', p.pos.x, p.pos.z, 0.08, { pitch: 1.4 });
  return true;
}

export function closeQuickWheel(p: Player): boolean {
  const w = p.quickWheel;
  if (!w.open) return false;
  w.open = false;
  w.opener = -1;
  w.ver++;
  return true;
}

/** Point at an arm, or step along the one already pointed at. */
function point(w: QuickWheel, arm: number) {
  if (arm === w.arm) step(w, 1);
  else {
    w.arm = arm;
    w.changed = true;
    w.ver++;
  }
}

function step(w: QuickWheel, dir: number) {
  const row = w.rows[w.arm];
  if (!row.length) return;
  const i = Math.max(0, row.findIndex((e) => e.key === w.pick[w.arm]));
  w.pick[w.arm] = row[(i + dir + row.length) % row.length].key;
  w.changed = true;
  w.ver++;
}

/** An arm from a direction: x right, y up. */
function armAt(x: number, y: number): number {
  return Math.abs(y) >= Math.abs(x) ? (y > 0 ? 0 : 2) : x > 0 ? 1 : 3;
}

/** The belt slot a hand item from the bag goes to, or -1 when there is none it may take. */
function slotFor(l: Loadout, weapon: boolean): number {
  const fits = (i: number) => !!l.belt[i] && (weapon ? isWeapon(gearDef(l.belt[i]!.id)) : isTool(l.belt[i]!.id));
  if (l.sel < BELT_SIZE && fits(l.sel)) return l.sel;
  const empty = l.belt.findIndex((b) => !b);
  if (empty >= 0) return empty;
  for (let i = 0; i < BELT_SIZE; i++) if (fits(i)) return i;
  // A tool may push a weapon off only when the belt keeps another.
  const armed = l.belt.filter((b) => b && isWeapon(gearDef(b.id))).length;
  if (!weapon && armed > 1) return l.belt.findIndex((b) => !!b && isWeapon(gearDef(b.id)));
  return -1;
}

/** Take what the wheel rests on: put it in hand, or use it. */
export function takeWheel(p: Player, e: WheelEntry | null) {
  if (!e) return;
  if (e.kind === 'quick') {
    p.setQuick(e.id);
    p.useQuick();
    return;
  }
  if (p.state !== 'foot') return void p.note('Get out of the vehicle to change what you hold', 'info');
  if (p.carry) return void p.note('Your hands are full: put it down first', 'info');
  const g = p.gear;
  if (e.kind === 'belt') {
    if (g.sel !== e.slot) p.holdSlot(e.slot);
    return;
  }
  if (e.kind === 'util') {
    if (p.utility !== e.id) {
      p.utility = e.id;
      p.ctx.campaign.players[p.index].utility = e.id;
    }
    if (g.sel !== UTILITY_SLOT) p.holdSlot(UTILITY_SLOT);
    else p.syncEquip();
    return;
  }
  const at = slotFor(g, isWeapon(gearDef(e.id)));
  if (at < 0) return void p.note('No room on your belt for that: keep a weapon on it', 'warn');
  const res = equipFromBag(g, e.uid, at);
  p.refreshGear();
  p.note(res.ok ? res.note : res.reason, res.ok ? 'info' : 'warn');
}

/**
 * Once per tick, before the rest of the player reads its input: count the holds, open the wheel, move it, take from it, and
 * take its buttons out of the intent so nothing else acts on them.
 */
export function stepQuickWheel(p: Player, it: PlayerIntent, dt: number) {
  const w = p.quickWheel;
  const pad = it.device === 'pad';
  const kb = it.device === 'keyboard';
  if ((!pad && !kb) || p.state === 'dead' || p.buildMode) {
    closeQuickWheel(p);
    w.holdT.fill(0);
    w.spent = 0;
    return;
  }
  const watch = pad ? WATCH_PAD : bit(Btn.LB);
  const raw = it.held;
  for (let b = 0; b < BTN_COUNT; b++) {
    if (!(watch & bit(b))) continue;
    if (raw & bit(b)) w.holdT[b] += dt;
    else if (w.holdT[b] > 0) {
      w.lastHeld[b] = w.holdT[b];
      w.holdT[b] = 0;
    }
  }
  const spentBefore = w.spent;
  const tapped = (b: number) => wasReleased(it, b) && !(spentBefore & bit(b)) && !w.open;
  // Taps land on the release: LB (swap) everywhere, the inventory on a pad. A long hold (the crew orders on a pad's LB) never taps.
  const tapLB = tapped(Btn.LB) && w.lastHeld[Btn.LB] < SWAP_HOLD;
  const tapInv = pad && tapped(Btn.Inventory) && w.lastHeld[Btn.Inventory] < WHEEL_HOLD;

  if (!w.open && canWheel(p)) {
    if (kb && isHeld(it, Btn.LB) && w.holdT[Btn.LB] >= SWAP_HOLD && !p.carry && !(w.spent & bit(Btn.LB))) openQuickWheel(p, undefined, Btn.LB);
    else if (pad) {
      for (const [b, arm] of PAD_ARM) {
        if (!isHeld(it, b) || w.holdT[b] < WHEEL_HOLD || w.spent & bit(b)) continue;
        // Held next to a friend, the map button still offers a high five.
        if (b === Btn.Map && p.fiveReach()) continue;
        if (openQuickWheel(p, arm, b)) break;
      }
    }
    if (w.open) w.spent |= bit(w.opener);
  }

  if (w.open) {
    if (!canWheel(p)) closeQuickWheel(p);
    else runOpen(p, w, it, dt, pad);
  }
  // A press spent on the wheel stays spent until the button is up again.
  w.spent &= raw;
  if (w.open) w.spent |= raw & watch;

  // The taps, put back as presses on the frame they are let go.
  it.pressed &= ~bit(Btn.LB);
  if (pad) it.pressed &= ~bit(Btn.Inventory);
  if (tapLB) it.pressed |= bit(Btn.LB);
  if (tapInv) it.pressed |= bit(Btn.Inventory);
  // A hold that became the wheel lets go quietly.
  it.released &= ~(spentBefore & watch);
}

function runOpen(p: Player, w: QuickWheel, it: PlayerIntent, dt: number, pad: boolean) {
  const rows = wheelRows(p);
  if (rows.some((r, a) => r.length !== w.rows[a].length || r.some((e, i) => e.key !== w.rows[a][i].key))) {
    w.rows = rows;
    w.ver++;
  }
  const was = `${w.arm}|${w.pick.join()}`;
  // Directions: the D-pad on a pad (its actions' presses), the move keys on a keyboard.
  if (pad) {
    for (const [b, arm] of PAD_ARM) if (wasPressed(it, b)) point(w, arm);
    if (wasPressed(it, Btn.LB)) step(w, -1);
    if (wasPressed(it, Btn.RB)) step(w, 1);
    // A flick of the right stick.
    const [x, y] = it.look;
    const out = Math.hypot(x, y) > 0.6;
    if (out && !w.flick) point(w, armAt(x, y));
    w.flick = Math.hypot(x, y) > 0.35 && (out || w.flick);
  } else {
    if (it.nav & NAV.up) point(w, 0);
    if (it.nav & NAV.right) point(w, 1);
    if (it.nav & NAV.down) point(w, 2);
    if (it.nav & NAV.left) point(w, 3);
    // The mouse pushed toward an arm picks it; keep pushing that way to walk along it.
    const c = w.cursor;
    c[0] += it.lookDelta[0];
    c[1] += it.lookDelta[1];
    const r = Math.hypot(c[0], c[1]);
    if (r > 0.09) {
      point(w, armAt(c[0], c[1]));
      c[0] = c[1] = 0;
    }
  }
  if (it.toolStep) step(w, it.toolStep > 0 ? 1 : -1);
  if (`${w.arm}|${w.pick.join()}` !== was) w.idle = 0;
  else w.idle += dt;

  const sel = wheelSel(w);
  let take = false;
  let close = false;
  if (w.opener >= 0 && !isHeld(it, w.opener)) {
    // Let go: take what was chosen. A pad that chose nothing keeps the wheel for the D-pad; keys just put it away.
    if (w.changed) take = true;
    else if (!pad) close = true;
    w.opener = -1;
    w.idle = 0;
  }
  if (wasPressed(it, Btn.A) || wasPressed(it, Btn.RT)) take = true;
  if (wasPressed(it, Btn.B)) close = true;
  if (w.opener < 0 && w.idle >= IDLE_CLOSE) close = true;

  it.held &= ~MASK;
  it.pressed &= ~MASK;
  it.released &= ~MASK;
  it.rt = 0;
  it.toolStep = 0;
  it.look[0] = it.look[1] = 0;
  it.lookDelta[0] = it.lookDelta[1] = 0;
  if (!pad) {
    // The move keys are choosing, so the feet stay put.
    it.move[0] = it.move[1] = 0;
    it.nav = 0;
  }
  if (take) {
    closeQuickWheel(p);
    takeWheel(p, sel);
  } else if (close) closeQuickWheel(p);
}
