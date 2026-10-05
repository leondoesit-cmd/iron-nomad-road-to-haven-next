import { Btn, wasPressed } from '../input/intents';
import { keyLabel, padLabel, padPhysical, live, type ActionId, type KeyMap } from '../input/bindings';
import { artCamp, artCar, artDay, artHold, artHud, artNoise, artPad, artRoad, artSurvive, PAD_DRIVE, PAD_FOOT } from './guideArt';
import type { FocusItem, FocusUI } from './focus';
import type { Game } from '../game/game';

/** One page of the illustrated guide: a picture, a few lines, and optionally a block that follows the player's bindings. */
interface Page {
  title: string;
  kicker: string;
  art: () => string;
  /** Plain lines. HTML is allowed (key caps are written with <kbd>). A function reads the bindings when the page opens. */
  points: string[] | (() => string[]);
  extra?: (g: Game) => string;
}

const kb = (s: string) => `<kbd>${s}</kbd>`;

/** What an action is bound to right now: the pad button, then the Player 1 key, as key caps. */
function lab(id: ActionId): string {
  const b = live.bindings;
  const pad = padLabel(padPhysical(b.pad, id));
  const key = b.kb[0][id];
  return key ? `${kb(pad)}<span class="g-or">/</span>${kb(keyLabel(key))}` : kb(pad);
}

/** A block of key caps for one keyboard layout. */
function keyBlock(set: 0 | 1, rows: [string, (m: KeyMap) => string][]): string {
  const m = live.bindings.kb[set];
  return `<div class="g-kb"><h4>${set === 0 ? 'PLAYER 1 · WASD' : 'PLAYER 2 · ARROWS'}</h4>${rows
    .map(([name, f]) => `<div class="g-kbrow"><span>${f(m)}</span><em>${name}</em></div>`)
    .join('')}</div>`;
}
const caps = (...ks: (string | undefined)[]) => ks.map((k) => kb(keyLabel(k))).join('');

const FOOT_KEYS: [string, (m: KeyMap) => string][] = [
  ['move', (m) => caps(m.moveUp, m.moveLeft, m.moveDown, m.moveRight)],
  ['aim (or the mouse)', (m) => caps(m.turnLeft, m.turnRight)],
  ['fire', (m) => caps(m.fire)],
  ['interact: hold to loot, fix, fuel', (m) => caps(m.interact)],
  ['jump · crouch · sprint', (m) => caps(m.jump, m.crouch, m.sprint)],
  ['vehicle: hold to get in', (m) => caps(m.vehicle)],
  ['reload · swap tool', (m) => caps(m.reload, m.swap)],
  ['map · pack', (m) => caps(m.map, m.inventory)],
];
const DRIVE_KEYS: [string, (m: KeyMap) => string][] = [
  ['throttle · brake', (m) => caps(m.moveUp, m.moveDown)],
  ['steer', (m) => caps(m.moveLeft, m.moveRight)],
  ['handbrake', (m) => caps(m.sprint)],
  ['horn', (m) => caps(m.horn)],
  ['lights · engine off (hold)', (m) => caps(m.crouch)],
  ['exit: hold', (m) => caps(m.vehicle)],
  ['map', (m) => caps(m.map)],
];

const PAGES: Page[] = [
  {
    title: 'The road to Haven',
    kicker: 'What this is',
    art: artRoad,
    points: [
      'You are a <b>scavenger</b>. Your vehicle is your character: every upgrade changes where you can go, how loud you are and who wants to kill you.',
      'You start on a scrap <b>50cc moped</b>. Grow into a war convoy and drive <b>north</b> to a sanctuary called <b>Haven</b>.',
      'Share the screen with a partner (<b>split screen</b>) or play <b>solo</b> with the whole screen. Fuel and Rations are one pool for the convoy.',
      'The world is one open basin. There is no one road: the highway runs north through Petah Tikva to Rustgate and Haven, and the dirt tracks lead to everything else.',
    ],
  },
  {
    title: 'A day in the wasteland',
    kicker: 'The loop',
    art: artDay,
    points: [
      '<b>1 · Dawn Ledger.</b> A shared clipboard: repair, rebuild a vehicle into the next tier, upgrade, craft, hire crew, then roll out.',
      '<b>2 · Roam.</b> Drive anywhere. Dismount at scavenge zones, work through buildings, handle ambushes and the Roadside Encounters.',
      '<b>3 · Dusk Bell.</b> The clock rings. Step out wherever you like and <b>hold A</b> to make camp. Past full dark the convoy stops where it is.',
      '<b>4 · Camp.</b> Three minutes to build defences, then <b>5 · a three-wave night raid</b>. Dawn leads straight back to the Ledger.',
    ],
  },
  {
    title: 'Reading your screen',
    kicker: 'The HUD',
    art: artHud,
    points: [
      '<b>1 Noise meter.</b> What you give off right now. Engines, horns, shots and sprinting push it up.',
      '<b>2 Compass, minimap and clock.</b> The minimap turns so up is where you look. The clock counts to the Dusk Bell.',
      '<b>3 Vitals.</b> Health (green), stamina (the thin blue bar, shown only when low), fuel and speed.',
      '<b>4 Weapon.</b> Rounds in the magazine over what you carry.',
      '<b>5 Prompt.</b> Names the button and what it will do. A bar fills while you hold.',
      '<b>6 Reticle</b> and <b>7 tips</b>. A tip is shown once, the first time it matters.',
    ],
  },
  {
    title: 'On foot',
    kicker: 'Controls: gamepad and keyboard',
    art: () => artPad(PAD_FOOT, 'ON FOOT · DEFAULT GAMEPAD LAYOUT'),
    points: () => [
      `<b>Hold</b> ${lab('interact')} for anything that takes a moment. <b>Tap</b> it to jump when nothing is in reach.`,
      `${lab('swap')} walks your belt: pistol, wrench, crowbar, jerrycan. What is in your hands decides what ${lab('interact')} and ${lab('reload')} do.`,
      'Every control can be rebound under <b>Control settings</b>; the key caps below follow your bindings.',
    ],
    extra: () => `<div class="g-kbs">${keyBlock(0, FOOT_KEYS)}${keyBlock(1, FOOT_KEYS)}</div>`,
  },
  {
    title: 'Behind the wheel',
    kicker: 'Controls: driving',
    art: () => artPad(PAD_DRIVE, 'DRIVING · DEFAULT GAMEPAD LAYOUT'),
    points: () => [
      `<b>Hold</b> ${lab('vehicle')} beside any vehicle to climb in. Abandoned cars become yours the moment you do.`,
      `Tap ${lab('view')} to switch between chase view and the eyes of the driver. Each player has their own view.`,
      `Hold ${lab('vehicle')} at speed to <b>bail out</b>. It costs health, so it is for emergencies.`,
      'Engines are loud, and the dust they throw is visible. Park and walk when quiet matters.',
    ],
    extra: () => `<div class="g-kbs">${keyBlock(0, DRIVE_KEYS)}${keyBlock(1, DRIVE_KEYS)}</div>`,
  },
  {
    title: 'Tap or hold',
    kicker: 'How actions work',
    art: artHold,
    points: () => [
      `Nothing is picked up by walking over it. Stand next to it and hold ${lab('interact')}.`,
      'Searching shelves, taking items, repairing a car, pouring fuel, stripping a wreck, reviving your partner and making camp are all <b>holds</b>: keep the button down until the bar fills.',
      'Searching and wrenching are <b>loud</b>. Deeper shelves are better and louder.',
      `Scrap, rations and ammo go straight into your stock. Parts, fuel cans and oil cans are <b>carried</b>: ${lab('interact')} bolts one on or pours it in at your car, ${lab('reload')} stows it in the trunk or sets it down.`,
    ],
  },
  {
    title: 'Noise and dust',
    kicker: 'Signature: the one aggro rule',
    art: artNoise,
    points: [
      'Your engine gives off <b>Noise</b>, heard by the infected in cities, and <b>Dust</b>, seen by raiders on the road.',
      'Horns, gunshots, sprinting and night headlights make it worse. Parking and walking is quiet.',
      '<b>Dust storms</b> hide you from raiders (about 40% as far) but they also hide everything else, and they burn engine oil faster.',
      'The meter in your top-left corner is always telling you the truth.',
    ],
  },
  {
    title: 'Wrench, crowbar, can',
    kicker: 'Looking after the machine',
    art: artCar,
    points: [
      '<b>1 Engine.</b> Mind the oil and the heat. Engines can be swapped, and they burn different fuels.',
      '<b>2 Tank.</b> Low on fuel: get out, equip the jerrycan, pick up a can, then hold A at the vehicle to pour.',
      '<b>3 Tyres</b> and <b>4 bodywork</b> wear and tear. Take hits, lose panels, repair them with the wrench.',
      'Parts fit any vehicle. Equip the wrench and press X to open the field workbench, or use the Garage at camp.',
    ],
  },
  {
    title: 'Camp and the night',
    kicker: 'Surviving until dawn',
    art: artCamp,
    points: [
      'Hold A on foot after the Dusk Bell, vote on a site and a hot or cold camp.',
      '<b>Build</b> for three minutes. RT places a piece, LB and RB change it, A rotates it. <b>1 Walls</b> and barricades block the way in.',
      '<b>2 Watch posts</b> (X) give early warning of where each wave is coming from.',
      '<b>3 Park your vehicles</b> in the perimeter: they are part of the wall.',
      '<b>4 Raids</b> come in three waves, from more than one side. Hold B when you are ready for the night; after the third it is dawn, and the Ledger.',
    ],
  },
  {
    title: 'Staying alive',
    kicker: 'Health, wounds, partners',
    art: artSurvive,
    points: [
      'Bites, blades and bullets open <b>wounds</b>. Bandages bind them all; a Medkit binds and heals.',
      'At 0 HP you are <b>downed, not dead</b>: crawl for 20 seconds. Your partner can revive you. Solo, hold A to use a Medkit on yourself.',
      'Stay within about <b>300 m</b> of your partner. Everyone eats one Ration a night.',
      'The run ends only when both of you are down, or the last vehicle is lost.',
    ],
  },
];

export const GUIDE_PAGES = PAGES.length;

/**
 * The illustrated guide: one picture and a few lines per page, with the key caps taken from the bindings in force.
 * Opened from the title and the pause menu. LB and RB turn the pages.
 */
export class Guide {
  private page = 0;

  constructor(private game: Game) {}

  show(host: HTMLElement, fc: FocusUI, back: () => void, opts: { onTrain?: () => void; page?: number } = {}) {
    const g = this.game;
    this.page = Math.max(0, Math.min(PAGES.length - 1, opts.page ?? 0));
    const prevCancel = fc.onCancel;
    const prevActive = fc.active;
    const prevTick = fc.onTick;
    const done = () => {
      fc.onCancel = prevCancel;
      fc.onTick = prevTick;
      fc.active = prevActive;
      back();
    };
    const go = (d: number, keep = true) => {
      const n = Math.max(0, Math.min(PAGES.length - 1, this.page + d));
      if (n === this.page) return;
      this.page = n;
      g.audio.play('click');
      render(keep ? fc.keys() : undefined);
    };
    const render = (keys?: (string | null)[]) => {
      const p = PAGES[this.page];
      const last = this.page === PAGES.length - 1;
      host.innerHTML = `<div class="guide">
        <div class="g-head"><h2>How to play</h2><span class="g-kick">${p.kicker}</span><span class="g-count">${this.page + 1} / ${PAGES.length}</span></div>
        <div class="g-body">
          <div class="g-art">${p.art()}</div>
          <div class="g-text"><h3>${p.title}</h3><ul>${(typeof p.points === 'function' ? p.points() : p.points).map((s) => `<li>${s}</li>`).join('')}</ul>${p.extra ? p.extra(g) : ''}</div>
        </div>
        <div class="g-dots">${PAGES.map((_, i) => `<i class="${i === this.page ? 'on' : ''}"></i>`).join('')}</div>
        <div class="g-foot">
          <button data-fid="prev" ${this.page === 0 ? 'disabled' : ''}>‹ Back</button>
          <button data-fid="next" ${last ? 'disabled' : ''}>Next ›</button>
          ${opts.onTrain ? '<button data-fid="train" class="g-go">Try it: training</button>' : ''}
          <button data-fid="close">Close</button>
          <span class="g-hint">LB / RB turn the page</span>
        </div>
      </div>`;
      host.querySelectorAll<HTMLElement>('.guide button').forEach((b) => (b.style.pointerEvents = 'auto'));
      const el = (k: string) => host.querySelector<HTMLElement>(`[data-fid="${k}"]`);
      const items: FocusItem[] = [
        { el: el('prev')!, press: () => go(-1), disabled: this.page === 0 },
        { el: el('next')!, press: () => go(1), disabled: last },
        ...(opts.onTrain ? [{ el: el('train')!, press: () => opts.onTrain!() }] : []),
        { el: el('close')!, press: () => done() },
      ];
      fc.setItems(items, keys);
      // A disabled button is no place to rest the cursor: move on to the one that does something.
      for (let s = 0; s < 2; s++) {
        const cur = fc.items[fc.cursor[s]];
        if (cur?.disabled) fc.cursor[s] = fc.items.findIndex((i) => i.el === el(last ? 'close' : 'next'));
      }
      fc.paint();
    };
    fc.onCancel = () => done();
    fc.onTick = (input) => {
      for (let s = 0; s < (g.solo ? 1 : 2); s++) {
        const it = input.intents[s];
        if (wasPressed(it, Btn.LB)) go(-1);
        else if (wasPressed(it, Btn.RB)) go(1);
      }
    };
    fc.active = true;
    render();
    // First paint: rest on Next, which is what most people want.
    const next = fc.items.findIndex((i) => i.el.dataset.fid === 'next');
    if (next >= 0) fc.cursor = [next, next];
    fc.paint();
  }
}
