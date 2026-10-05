import { ENCOUNTERS, LEGS, STRUCTURES, encounterById, legById, t, type LegDef } from '../data';
import { FocusUI, type FocusItem } from './focus';
import { LedgerPanel } from './ledger';
import { ControlsMenu } from './controls';
import { Guide } from './guide';
import { PROMPT_ACTION, keyLabel, padLabel, padPhysical, viewSharesVehicle, type KeyMap } from '../input/bindings';
import { escapeHtml } from './hud';
import { hasSave, initSave, savedSolo } from '../save/save';
import { Btn, wasPressed } from '../input/intents';
import { resolveEffects, resolveVote, type ResolvedEffects } from '../sim/endings';
import { Rng } from '../core/rng';
import { MERCS } from '../data';
import { applyLoyalty, type Merc } from '../sim/loyalty';
import { selectEnding, leaning, type EndingId } from '../sim/endings';
import { PLAYER_CSS } from '../render/palette';
import type { Game } from '../game/game';
import type { CampScene } from '../game/campScene';
import type { QualityPreset } from '../render/renderer';

const CALLSIGNS = ['Ash', 'Rook', 'Wren', 'Pike', 'Juno', 'Cobb', 'Sparrow', 'Hollis', 'Dutch', 'Mags', 'Rafe', 'Tinker'];

export class Overlays {
  root = document.getElementById('overlay')!;
  private pauseEl: HTMLElement | null = null;
  pauseFocus = new FocusUI();
  private nameIdx: [number, number] = [0, 1];
  private debugEl: HTMLElement | null = null;
  private titleReady = false;
  private tickers: ((dt: number) => void)[] = [];
  private ledger: LedgerPanel | null = null;

  constructor(private game: Game) {
    this.pauseFocus.onCancel = () => {
      if (this.game.paused) this.game.setPause(false, -1);
    };
  }

  callsign(i: number) {
    return CALLSIGNS[this.nameIdx[i] % CALLSIGNS.length];
  }

  private clear() {
    this.game.focus.clear();
    this.game.focus.active = false;
    this.game.focus.onTick = null;
    this.game.focus.onCancel = () => {};
    this.root.innerHTML = '';
    this.root.classList.add('on');
    this.tickers = [];
    this.ledger = null;
  }

  hideAll() {
    this.game.focus.clear();
    this.game.focus.active = false;
    this.root.innerHTML = '';
    this.root.classList.remove('on');
    this.tickers = [];
    this.ledger = null;
  }

  tick(dt: number) {
    for (const f of this.tickers) f(dt);
  }

  debugLine(text: string) {
    if (!this.debugEl) {
      this.debugEl = document.createElement('div');
      this.debugEl.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:9;font:12px monospace;color:#9f9;background:#000a;padding:2px 8px;pointer-events:none';
      document.body.appendChild(this.debugEl);
    }
    this.debugEl.textContent = text;
  }

  // ------------------------------------------------------------------ title

  showTitle() {
    this.clear();
    void initSave().then(() => {
      if (this.game.phase === 'title') this.renderTitle();
    });
    this.renderTitle();
  }

  private renderTitle() {
    const g = this.game;
    const solo = g.solo;
    const slotHtml = (i: number) => {
      const s = g.input.slots[i];
      const joined = !!s;
      const dev = s ? (s.kind === 'pad' ? `GAMEPAD ${s.index + 1}` : `KEYBOARD ${s.set === 1 ? 'WASD' : 'ARROWS'}`) : '';
      const join = i === 0 ? (solo ? t('title.joinSolo') : t('title.joinKb1')) : t('title.joinKb2');
      return `<div class="slot p${i + 1} ${joined ? 'joined' : ''}">
        <div class="who" style="color:${PLAYER_CSS[i]}">${solo ? 'SOLO' : `PLAYER ${i + 1}`}</div>
        ${joined ? `<div>${dev}</div>` : `<div class="blink">${t('title.join')}</div><div class="hint">${join}</div>`}
        <div style="margin-top:8px"><button data-fid="name${i}">‹ ${this.callsign(i)} ›</button></div>
      </div>`;
    };
    const saved = hasSave() ? ` <small>${savedSolo() ? 'solo' : '2P'}</small>` : '';
    this.root.innerHTML = `
      <div class="title-screen"><div>
        <h1>${t('title.name')}</h1><h2>${t('title.sub')}</h2>
        <p>${solo ? t('title.tagSolo') : t('title.tag')}</p>
        <div class="btnrow" style="margin-bottom:14px"><button data-fid="mode">Players: ${solo ? '‹ 1 · SOLO ›' : '‹ 2 · SPLIT SCREEN ›'}</button></div>
        <div class="slots">${slotHtml(0)}${solo ? '' : slotHtml(1)}</div>
        <div class="btnrow" style="margin-top:22px">
          <button data-fid="new">New convoy</button>
          <button data-fid="cont" ${hasSave() ? '' : 'disabled'}>Continue${saved}</button>
          <button data-fid="set">Settings</button>
          <button data-fid="ctl">Control settings</button>
          <button data-fid="how">Controls</button>
        </div>
        <div class="btnrow" style="margin-top:10px">
          <button data-fid="learn" class="g-go">How to play</button>
          <button data-fid="train" class="g-go">Training</button>
        </div>
        <p style="font-size:.78em;margin-top:18px">${solo ? 'One player, full screen. Plug in a gamepad and press A, or use the keyboard (WASD with F, or the arrow keys with Right Shift).' : 'Two players, one screen. Plug in two gamepads and press A, or share the keyboard.'} Chrome or Edge recommended; gamepads need localhost or HTTPS.</p>
        ${g.input.nonStandard.size ? '<p style="color:var(--amber)">A controller without the standard mapping was detected. Controls may be wrong.</p>' : ''}
      </div></div>`;
    const el = (k: string) => this.root.querySelector<HTMLElement>(`[data-fid="${k}"]`)!;
    const items: FocusItem[] = [
      { el: el('mode'), press: () => this.titleLock <= 0 && this.toggleSolo() },
      { el: el('name0'), press: () => this.titleLock <= 0 && this.cycleName(0) },
      ...(solo ? [] : [{ el: el('name1'), press: () => this.titleLock <= 0 && this.cycleName(1) }]),
      { el: el('new'), press: () => this.titleLock <= 0 && g.startNewGame() },
      { el: el('cont'), press: () => this.titleLock <= 0 && g.continueGame(), disabled: !hasSave() },
      { el: el('set'), press: () => this.titleLock <= 0 && this.showSettings(() => this.showTitle()) },
      { el: el('ctl'), press: () => this.titleLock <= 0 && this.showControlSettings(() => this.showTitle()) },
      { el: el('how'), press: () => this.titleLock <= 0 && this.showControls(() => this.showTitle()) },
      { el: el('learn'), press: () => this.titleLock <= 0 && this.showGuide(() => this.showTitle(), () => g.startTraining()) },
      { el: el('train'), press: () => this.titleLock <= 0 && g.startTraining() },
    ];
    g.focus.setItems(items);
    const start = items.findIndex((i) => i.el === el('new'));
    g.focus.cursor = [start, start];
    g.focus.active = true;
    this.titleReady = true;
    this.root.querySelectorAll<HTMLElement>('.title-screen button').forEach((b) => (b.style.pointerEvents = 'auto'));
  }

  /** Solo or split screen. The demo behind the menu restarts to match. */
  private toggleSolo() {
    const g = this.game;
    g.setSolo(!g.solo);
    g.saveSettings();
    g.audio.play('click');
    g.restartAttract();
    this.renderTitle();
    // Stay on the Players button.
    g.focus.cursor = [0, 0];
  }

  private cycleName(i: number) {
    this.nameIdx[i] = (this.nameIdx[i] + 1) % CALLSIGNS.length;
    if (this.nameIdx[0] === this.nameIdx[1]) this.nameIdx[i] = (this.nameIdx[i] + 1) % CALLSIGNS.length;
    this.renderTitle();
  }

  private lastJoined = 0;
  /** After a player joins, the same A press must not also confirm a menu item. */
  private titleLock = 0;
  tickTitle(dt: number) {
    if (!this.titleReady || this.game.phase !== 'title') return;
    this.titleLock = Math.max(0, this.titleLock - dt);
    const j = this.game.input.joined + (this.game.input.slots[0]?.kind === 'pad' ? 10 : 0) + (this.game.input.slots[1]?.kind === 'pad' ? 20 : 0);
    if (j !== this.lastJoined) {
      this.lastJoined = j;
      this.titleLock = 0.4;
      const keep = this.game.focus.cursor.slice() as [number, number];
      this.renderTitle();
      this.game.focus.cursor = keep;
      this.game.audio.play('click');
    }
    // Start button anywhere starts a new game.
    for (let p = 0; p < 2; p++) {
      if (this.titleLock <= 0 && wasPressed(this.game.input.intents[p], Btn.Start) && this.game.input.slots[p]) this.game.startNewGame();
    }
  }

  // ------------------------------------------------------------------ settings & controls

  showSettings(back: () => void) {
    const g = this.game;
    const wasPausedOverlay = g.paused;
    const host = wasPausedOverlay ? this.pauseEl! : this.root;
    const solo = g.solo;
    const render = () => {
      const s = g.input.settings;
      const row = (id: string, label: string, val: string) =>
        `<div class="item"><span>${label}</span><span style="display:flex;gap:6px;align-items:center"><button data-fid="${id}-" style="padding:0 8px">-</button><span style="min-width:96px;text-align:center;font-family:var(--mono)">${val}</span><button data-fid="${id}+" style="padding:0 8px">+</button></span></div>`;
      const d = g.campaign.difficulty;
      host.innerHTML = `<div class="menu" style="min-width:640px"><h2>Settings</h2><div class="list">
        ${row('q', 'Graphics preset', g.R.quality.toUpperCase())}
        ${row('ui', 'UI scale', `${Math.round(g.hud.uiScale * 100)}%`)}
        ${solo ? '' : row('lay', 'Split screen', g.R.layout === 'horizontal' ? 'TOP / BOTTOM' : 'LEFT / RIGHT')}
        ${row('vol', 'Master volume', `${Math.round(g.audio.volume * 100)}%`)}
        ${row('mus', 'Music volume', `${Math.round(g.audio.musicVolume * 100)}%`)}
        ${row('tts', 'Radio TTS voice', g.audio.ttsEnabled ? 'ON' : 'OFF')}
        ${row('rm1', solo ? 'Rumble' : 'P1 rumble', s.rumble[0] ? 'ON' : 'OFF')}
        ${solo ? '' : row('rm2', 'P2 rumble', s.rumble[1] ? 'ON' : 'OFF')}
        ${row('aa1', solo ? 'Aim assist' : 'P1 aim assist', `${Math.round(s.aimAssist[0] * 100)}%`)}
        ${solo ? '' : row('aa2', 'P2 aim assist', `${Math.round(s.aimAssist[1] * 100)}%`)}
        ${row('ms', 'Mouse / trackpad sensitivity', `${Math.round(s.mouseSens * 100)}%`)}
        ${row('dr', 'Drain (fuel, food)', `${d.drain.toFixed(2)}×`)}
        ${row('ag', 'Aggro (enemy senses)', `${d.aggro.toFixed(2)}×`)}
        ${row('dm', 'Damage taken', `${d.damage.toFixed(2)}×`)}
        <div class="item"><button data-fid="back">Back</button><span class="mutedtxt" style="color:#c9bd9f">${solo ? '' : 'Per-player options apply to that seat.'}</span></div>
      </div></div>`;
      (host.querySelectorAll('.menu button') as NodeListOf<HTMLElement>).forEach((b) => (b.style.pointerEvents = 'auto'));
      const el = (k: string) => host.querySelector<HTMLElement>(`[data-fid="${k}"]`)!;
      const q: QualityPreset[] = ['low', 'medium', 'high'];
      const step = (id: string, dir: number) => {
        const st = g.input.settings;
        const dd = g.campaign.difficulty;
        const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
        switch (id) {
          case 'q':
            g.R.setQuality(q[(q.indexOf(g.R.quality) + dir + 3) % 3]);
            break;
          case 'ui':
            g.hud.setScale(clamp(Math.round((g.hud.uiScale + dir * 0.1) * 10) / 10, 0.8, 1.5));
            break;
          case 'lay':
            g.R.setLayout(g.R.layout === 'horizontal' ? 'vertical' : 'horizontal');
            g.layout();
            break;
          case 'vol':
            g.audio.setVolume(clamp(g.audio.volume + dir * 0.1, 0, 1));
            break;
          case 'mus':
            g.audio.setMusicVolume(clamp(g.audio.musicVolume + dir * 0.1, 0, 1));
            break;
          case 'tts':
            g.audio.setTtsEnabled(!g.audio.ttsEnabled);
            g.saveSettings();
            break;
          case 'rm1':
            st.rumble[0] = !st.rumble[0];
            break;
          case 'rm2':
            st.rumble[1] = !st.rumble[1];
            break;
          case 'aa1':
            st.aimAssist[0] = clamp(Math.round((st.aimAssist[0] + dir * 0.25) * 100) / 100, 0, 2);
            break;
          case 'aa2':
            st.aimAssist[1] = clamp(Math.round((st.aimAssist[1] + dir * 0.25) * 100) / 100, 0, 2);
            break;
          case 'ms':
            st.mouseSens = clamp(Math.round((st.mouseSens + dir * 0.1) * 100) / 100, 0.2, 3);
            break;
          case 'dr':
            dd.drain = clamp(Math.round((dd.drain + dir * 0.25) * 100) / 100, 0.25, 2);
            break;
          case 'ag':
            dd.aggro = clamp(Math.round((dd.aggro + dir * 0.25) * 100) / 100, 0.25, 2);
            break;
          case 'dm':
            dd.damage = clamp(Math.round((dd.damage + dir * 0.25) * 100) / 100, 0.25, 2);
            break;
        }
        g.saveSettings();
        g.audio.play('click');
        const keys = fc.keys();
        render();
        fc.setItems(makeItems(), keys);
      };
      const ids = ['q', 'ui', ...(solo ? [] : ['lay']), 'vol', 'mus', 'rm1', ...(solo ? [] : ['rm2']), 'aa1', ...(solo ? [] : ['aa2']), 'ms', 'dr', 'ag', 'dm'];
      const makeItems = (): FocusItem[] => [
        ...ids.flatMap((id) => [
          { el: el(`${id}-`), press: () => step(id, -1) },
          { el: el(`${id}+`), press: () => step(id, 1) },
        ]),
        { el: el('back'), press: () => done() },
      ];
      fc.setItems(makeItems());
    };
    const fc = wasPausedOverlay ? this.pauseFocus : g.focus;
    const prevActive = fc.active;
    const prevCancel = fc.onCancel;
    const done = () => {
      fc.onCancel = prevCancel;
      fc.active = prevActive;
      back();
    };
    fc.active = true;
    fc.onCancel = () => done();
    render();
  }

  private controlsMenu: ControlsMenu | null = null;
  private guide: Guide | null = null;

  /** The illustrated guide. From the title it can lead straight into training. */
  showGuide(back: () => void, onTrain?: () => void, page = 0) {
    const g = this.game;
    const paused = g.paused;
    (this.guide ??= new Guide(g)).show(paused ? this.pauseEl! : this.root, paused ? this.pauseFocus : g.focus, back, { onTrain, page });
  }

  /** Rebind every action and set the look and camera options. */
  showControlSettings(back: () => void) {
    const g = this.game;
    const paused = g.paused;
    (this.controlsMenu ??= new ControlsMenu(g)).show(paused ? this.pauseEl! : this.root, paused ? this.pauseFocus : g.focus, back);
  }

  /** The controls reference, written from the bindings in force rather than the defaults. */
  showControls(back: () => void) {
    const g = this.game;
    const wasPausedOverlay = g.paused;
    const host = wasPausedOverlay ? this.pauseEl! : this.root;
    const b = g.input.settings.bindings;
    const pad = (id: keyof typeof PROMPT_ACTION | 'wheel' | 'sheet' | 'view' | 'map' | 'inventory') => {
      const action = id === 'wheel' || id === 'sheet' || id === 'view' || id === 'map' || id === 'inventory' ? id : PROMPT_ACTION[id];
      if (action === 'view' && b.pad.view === -2) return `${padLabel(b.pad.vehicle)} tap`;
      if (action === 'vehicle' && viewSharesVehicle(b.pad)) return `${padLabel(b.pad.vehicle)} hold`;
      return padLabel(padPhysical(b.pad, action));
    };
    const pair = (a: string, c: string) => `${pad(a as 'A')} / ${pad(c as 'A')}`;
    const rows: [string, string, string, string, string][] = [
      ['', 'On foot', 'Driving', 'Gunner / passenger', 'Camp build'],
      ['Left stick', 'Move', 'Steer', 'Lean', 'Move'],
      ['Right stick', 'Aim / look', 'Free look', 'Aim gun', 'Aim reticle'],
      [pair('RT', 'LT'), 'Fire / aim', 'Throttle / brake', 'Fire / zoom', 'Place / remove'],
      [pad('RB'), 'Tap melee · hold takedown', 'Fire front gun', 'Fire', 'Next element'],
      [pad('LB'), 'Swap what is in hand along your belt: weapons, wrench (repair), crowbar (strip parts), jerrycan (fuel)', '—', 'Swap weapon', 'Previous element'],
      [pad('A'), 'Tap jump (when nothing is in reach) · hold to loot, repair, strip, siphon, refuel, revive', 'Handbrake', 'Reload', 'Rotate'],
      [pad('B'), 'Crouch', 'Tap lights · hold engine off', 'Cancel', 'Cancel'],
      [pad('X'), 'Reload · hold swap utility · wrench: workbench', 'Tap horn · hold siren', 'Reload', 'Watch post'],
      [pad('Y'), 'Enter any vehicle (abandoned cars become yours) · hold bail out', 'Exit · hold to bail at speed', 'Exit', 'Build wheel'],
      [pad('view'), 'Switch first / third person', 'Same: look from the cab', 'Same: look along the gun', '—'],
      ['D-pad', 'Tap ping · hold command wheel', 'Same', 'Same', 'Same'],
      [pad('map'), 'Tap map: closer look, whole leg, close', 'Same', 'Same', 'Same'],
      [pad('inventory'), 'Inventory: change what you wear and hold (the game pauses)', 'Same', 'Same', 'Same'],
      [pair('L3', 'R3'), 'Sprint / reset cam', 'Camera distance / look back', 'Zoom', 'Snap grid'],
      [`Start / ${pad('sheet')}`, 'Pause · hold convoy sheet', 'Same', 'Same', 'Same'],
    ];
    const kbLine = (set: 0 | 1) => {
      const m: KeyMap = b.kb[set];
      const k = (id: keyof KeyMap) => keyLabel(m[id]);
      return `${set === 0 ? 'P1' : 'P2'}: ${k('moveUp')} ${k('moveLeft')} ${k('moveDown')} ${k('moveRight')} move, ${k('turnLeft')} / ${k('turnRight')} aim, ${k('fire')} fire, ${k('interact')} interact, ${k('jump')} jump, ${k('vehicle')} vehicle, ${k('view')} first / third person, ${k('crouch')} crouch / lights, ${k('sprint')} sprint / handbrake, ${k('wheel')} wheel, ${k('map')} map, ${k('inventory')} inventory, ${k('swap')} swap tool, ${k('prevBuild')} ${k('nextBuild')} cycle build, hold ${k('sheet')} for the convoy sheet`;
    };
    const mouse = `fire ${mouseWord(b.mouse.fire)}, aim ${mouseWord(b.mouse.aim)}, view ${mouseWord(b.mouse.view)}`;
    host.innerHTML = `<div class="menu" style="min-width:900px"><h2>Controls</h2>
      <div style="font-size:.74em;display:grid;grid-template-columns:110px 1.5fr 1.1fr 1fr 1fr;gap:3px 12px;text-transform:none;letter-spacing:.01em">
      ${rows.map((r, i) => r.map((c) => `<div style="${i === 0 ? 'color:var(--amber)' : ''}">${c}</div>`).join('')).join('')}
      </div>
      <p style="font-size:.74em;text-transform:none;letter-spacing:.01em;margin:10px 0">Mouse / trackpad (P1 keyboard seat): click the game to capture the pointer, move to aim, ${mouse}, Esc releases and pauses. Solo: either keyboard layout works. Keyboard · ${kbLine(0)}. ${kbLine(1)}. Esc pauses. Keyboard players get stronger aim assist. Everything here can be changed under Control settings.</p>
      <div class="item"><button data-fid="back">Back</button></div></div>`;
    (host.querySelectorAll('.menu button') as NodeListOf<HTMLElement>).forEach((b) => (b.style.pointerEvents = 'auto'));
    const fc = wasPausedOverlay ? this.pauseFocus : g.focus;
    const prevCancel = fc.onCancel;
    const done = () => {
      fc.onCancel = prevCancel;
      back();
    };
    fc.onCancel = () => done();
    fc.setItems([{ el: host.querySelector<HTMLElement>('[data-fid="back"]')!, press: () => done() }]);
    fc.active = true;
  }

  // ------------------------------------------------------------------ pause

  showPause(by: number) {
    const g = this.game;
    if (this.pauseEl) this.pauseEl.remove();
    const el = document.createElement('div');
    el.style.cssText = 'position:absolute;inset:0;background:rgba(5,4,3,.55);pointer-events:none';
    document.getElementById('ui')!.appendChild(el);
    this.pauseEl = el;
    this.renderPause(by);
    void g;
  }

  private renderPause(by: number) {
    const g = this.game;
    const el = this.pauseEl!;
    const who = by >= 0 && !g.solo ? `Paused by Player ${by + 1}` : 'Paused';
    const dis = g.hud.disconnected;
    const reconnect = dis[0] || dis[1] ? `<p style="color:var(--amber)">${dis[0] ? 'Player 1' : 'Player 2'}'s controller disconnected. Reconnect it or press a key.</p>` : '';
    el.innerHTML = `<div class="menu"><h2>${who}</h2>${reconnect}<div class="list">
      <div class="item"><button data-fid="res">Resume</button></div>
      <div class="item"><button data-fid="set">Settings</button></div>
      <div class="item"><button data-fid="ctl">Control settings</button></div>
      <div class="item"><button data-fid="how">Controls</button></div>
      <div class="item"><button data-fid="learn">How to play</button></div>
      ${g.tutorial ? '<div class="item"><button data-fid="skip">Skip this lesson</button></div>' : ''}
      ${g.solo ? '' : '<div class="item"><button data-fid="swap">Swap player seats</button></div>'}
      <div class="item"><button data-fid="quit">${g.tutorial ? 'Leave training' : 'Quit to title'}</button></div></div></div>`;
    (el.querySelectorAll('.menu button') as NodeListOf<HTMLElement>).forEach((b) => (b.style.pointerEvents = 'auto'));
    const q = (k: string) => el.querySelector<HTMLElement>(`[data-fid="${k}"]`)!;
    this.pauseFocus.setItems([
      { el: q('res'), press: () => g.setPause(false, -1) },
      { el: q('set'), press: () => this.showSettings(() => this.renderPause(by)) },
      { el: q('ctl'), press: () => this.showControlSettings(() => this.renderPause(by)) },
      { el: q('how'), press: () => this.showControls(() => this.renderPause(by)) },
      { el: q('learn'), press: () => this.showGuide(() => this.renderPause(by)) },
      ...(g.tutorial ? [{ el: q('skip'), press: () => (g.tutorial?.skip(), g.setPause(false, -1)) }] : []),
      ...(g.solo
        ? []
        : [
            {
              el: q('swap'),
              press: () => {
                g.input.swapSeats();
                g.audio.play('confirm');
              },
            },
          ]),
      { el: q('quit'), press: () => (g.setPause(false, -1), g.toTitle()) },
    ]);
    this.pauseFocus.active = true;
    this.pauseFocus.onCancel = () => g.setPause(false, -1);
  }

  hidePause() {
    this.pauseEl?.remove();
    this.pauseEl = null;
    this.pauseFocus.clear();
    this.pauseFocus.active = false;
  }

  tickPause(_dt: number) {
    if (this.pauseFocus.active) this.pauseFocus.update(this.game.input);
    // Reconnect: any key or pad press resumes after a disconnect pause.
    const g = this.game;
    if ((g.hud.disconnected[0] || g.hud.disconnected[1]) && g.input.pads().some((p) => p && p.buttons.some((b) => b.pressed))) {
      for (let p = 0; p < 2; p++) g.hud.disconnected[p] = false;
    }
  }

  // ------------------------------------------------------------------ votes

  /**
   * A shared decision. Each player picks in their own half of the screen by moving their cursor and pressing A.
   * If they agree it resolves. If they disagree, the Lead decides and overriding costs one point of Trust.
   */
  vote(o: {
    kind: string;
    title: string;
    text: string;
    choices: { label: string; sub?: string }[];
    lead: 0 | 1;
    result?: (choice: number) => string;
    onDone: (choice: number, overridden: boolean) => void;
    foot?: string;
    wide?: boolean;
  }) {
    const g = this.game;
    this.clear();
    const solo = g.campaign.solo;
    const votes: [number, number] = [-1, -1];
    const names = [g.campaign.players[0].name, g.campaign.players[1].name];
    let resolved = false;
    const draw = () => {
      this.root.innerHTML = `<div class="enc panel paper" style="${o.wide ? 'width:min(1100px,95%)' : ''}">
        <h2>${escapeHtml(o.title)}</h2><p>${escapeHtml(o.text)}</p>
        <div class="choices" style="${o.wide ? `grid-template-columns:repeat(${o.choices.length},1fr)` : ''}">${o.choices
          .map(
            (c, i) => `<button class="choice" data-fid="c${i}"><span>${escapeHtml(c.label)}${c.sub ? `<br><span class="mutedtxt">${c.sub}</span>` : ''}</span><span class="votes">${votes
              .map((v, p) => (v === i && !(solo && p === 1) ? `<span class="vote p${p + 1}">${names[p].toUpperCase()}</span>` : ''))
              .join('')}</span></button>`,
          )
          .join('')}</div>
        <div class="mutedtxt" style="margin-top:10px">${solo ? t('enc.voteSolo') : `${t('enc.vote')}<br>${t('enc.lead')}: <b style="color:${PLAYER_CSS[o.lead]}">${names[o.lead].toUpperCase()}</b>`}${o.foot ? `<br>${o.foot}` : ''}</div></div>`;
      this.root.querySelectorAll<HTMLElement>('button').forEach((b) => (b.style.pointerEvents = 'auto'));
    };
    const bind = () => {
      const items: FocusItem[] = o.choices.map((_, i) => ({
        el: this.root.querySelector<HTMLElement>(`[data-fid="c${i}"]`)!,
        press: (p) => {
          if (resolved) return;
          votes[p] = i;
          // Solo: the one vote is the whole vote.
          if (solo) votes[1] = i;
          g.audio.play('click');
          const keys = g.focus.keys();
          draw();
          g.focus.setItems(rebuild(), keys);
          if (votes[0] >= 0 && votes[1] >= 0) finish();
        },
      }));
      return items;
    };
    const rebuild = bind;
    const finish = () => {
      resolved = true;
      const r = resolveVote(votes, o.lead);
      g.audio.play('confirm');
      const resText = o.result?.(r.choice) ?? '';
      this.root.innerHTML = `<div class="enc panel paper"><h2>${escapeHtml(o.title)}</h2>
        <div class="choices"><div class="choice mute" style="justify-content:flex-start">${escapeHtml(o.choices[r.choice].label)}</div></div>
        ${solo ? '' : r.overridden ? `<div class="mutedtxt" style="margin-top:8px"><b style="color:${PLAYER_CSS[o.lead]}">${names[o.lead].toUpperCase()}</b> overrode ${names[1 - o.lead]}: -1 Trust.</div>` : '<div class="mutedtxt" style="margin-top:8px">You agreed.</div>'}
        ${resText ? `<div class="result">${escapeHtml(resText)}</div>` : ''}
        <div class="btnrow" style="margin-top:12px"><button data-fid="go">Continue</button></div></div>`;
      this.root.querySelectorAll<HTMLElement>('button').forEach((b) => (b.style.pointerEvents = 'auto'));
      g.focus.setItems([{ el: this.root.querySelector<HTMLElement>('[data-fid="go"]')!, press: () => o.onDone(r.choice, r.overridden) }]);
    };
    draw();
    g.focus.setItems(bind());
    g.focus.cursor = [0, Math.min(1, o.choices.length - 1)];
    g.focus.active = true;
  }

  showEncounter(id: string, done: (fx: ResolvedEffects, overridden: boolean) => void) {
    const g = this.game;
    const enc = encounterById(id);
    g.campaign.seenEncounters.add(id);
    const rng = new Rng(g.campaign.seed + g.campaign.history.length * 31 + id.length);
    this.vote({
      kind: 'encounter',
      title: t(`enc.${id}.title`),
      text: t(`enc.${id}.text`),
      choices: enc.choices.map((c) => ({ label: t(`enc.${id}.${c.id}`) })),
      lead: g.campaign.lead,
      result: (i) => t(`enc.${id}.${enc.choices[i].id}.result`),
      onDone: (choice, overridden) => done(resolveEffects(enc.choices[choice].effects, rng), overridden),
    });
    void ENCOUNTERS;
  }

  /** `siteIds` and `hubId` are given in the open world, where the choices depend on where the convoy stopped. */
  showCampDecision(leg: LegDef, done: (siteId: string, hot: boolean) => void, siteIds?: string[], hubId?: string | null) {
    const g = this.game;
    const bars = (v: number) => '▮'.repeat(Math.round(v * 5)) + '▯'.repeat(5 - Math.round(v * 5));
    const sites = (siteIds ?? leg.campSites).map((s) => ({ id: s, ...STRUCTURES.sites[s] }));
    const hubKey = siteIds ? hubId : leg.endHub;
    const hub = hubKey ? LEGS.hubs[hubKey] : null;
    this.vote({
      kind: 'site',
      title: 'The Dusk Bell',
      text: `${hub ? hub.name + ': ' + hub.blurb + ' ' : ''}Pick a place to make camp. Exposure is how far dust and light carry; cover is what you can hide behind; room is how many vehicles fit.`,
      choices: sites.map((s) => ({
        label: s.name,
        sub: `Exposure ${bars(s.exposure)} · Cover ${bars(s.cover)} · Room ${bars(s.room)}<br>${s.blurb}`,
      })),
      wide: true,
      lead: g.campaign.lead,
      onDone: (siteIdx, ov1) => {
        if (ov1) g.campaign.axes.trust -= 1;
        this.vote({
          kind: 'hot',
          title: 'Hot camp or cold camp?',
          text: 'Lights, a generator and a fire keep morale up and make repairs faster, but carry further. A cold camp is dark and quiet.',
          choices: [
            { label: 'Hot camp', sub: '+3 Loyalty, faster repairs, turrets can see. Higher Signature: more and larger raids.' },
            { label: 'Cold camp', sub: 'Signature 25% lower, fewer raids. No spotlights, slower repairs, no Loyalty bonus.' },
          ],
          wide: true,
          lead: g.campaign.lead,
          onDone: (hotIdx, ov2) => {
            if (ov2) g.campaign.axes.trust -= 1;
            done(sites[siteIdx].id, hotIdx === 0);
          },
        });
      },
    });
  }

  // ------------------------------------------------------------------ dawn report

  showReport(camp: CampScene, done: () => void) {
    const g = this.game;
    this.clear();
    const rep = camp.report;
    const disputes = camp.pendingDisputes();
    const draw = () => {
      this.root.innerHTML = `<div class="report panel paper"><h2>Dawn report · Day ${g.campaign.day}</h2>
        <div class="lines">${rep.lines.map((l) => `<div>${escapeHtml(l)}</div>`).join('')}</div>
        ${rep.crew.length ? `<h3 style="margin-top:10px;color:#7a4a14">Crew</h3><div class="lines">${rep.crew.map((l) => `<div>${escapeHtml(l)}</div>`).join('')}</div>` : ''}
        <div class="btnrow" style="margin-top:14px"><button data-fid="go">${disputes.length ? 'Settle the dispute' : 'To the Ledger'}</button></div></div>`;
      this.root.querySelectorAll<HTMLElement>('button').forEach((b) => (b.style.pointerEvents = 'auto'));
      g.focus.setItems([{ el: this.root.querySelector<HTMLElement>('[data-fid="go"]')!, press: () => next() }]);
      g.focus.active = true;
    };
    const next = () => {
      const d = disputes.shift();
      if (!d) return done();
      this.showDispute(d, () => draw2());
    };
    const draw2 = () => {
      if (disputes.length) next();
      else {
        this.clear();
        done();
      }
    };
    draw();
  }

  private showDispute(m: Merc, done: () => void) {
    const g = this.game;
    const kind = m.dispute ?? 'pay';
    const sc = g.scene as CampScene | null;
    const opts =
      kind === 'pay'
        ? ['raise', 'refuse', 'dismiss']
        : ['back', 'punish', 'dismiss'];
    this.vote({
      kind: 'dispute',
      title: t(`camp.dispute.${kind}`),
      text: t(`camp.dispute.${kind}.text`, { name: m.name }),
      choices: opts.map((o) => ({ label: t(`camp.dispute.${kind}.${o}`) })),
      lead: g.campaign.lead,
      result: (i) => ({ raise: `${m.name} takes the deal.`, refuse: `${m.name} stews.`, dismiss: `${m.name} packs up and walks.`, back: `${m.name} nods once.`, punish: `${m.name} says nothing. That's worse.` })[opts[i]] ?? '',
      onDone: (i, ov) => {
        const o = opts[i];
        if (ov) g.campaign.axes.trust -= 1;
        if (o === 'raise') {
          m.cut = Math.min(0.3, m.cut + 0.05);
          applyLoyalty(m, 25);
          g.campaign.axes.trust += 1;
        } else if (o === 'refuse') {
          applyLoyalty(m, -8, 'Refused a raise');
        } else if (o === 'back') {
          applyLoyalty(m, 20);
          g.campaign.axes.trust += 1;
          g.campaign.axes.mercy += 1;
        } else if (o === 'punish') {
          applyLoyalty(m, -12, 'Docked pay');
          g.campaign.axes.notoriety += 1;
        } else {
          m.alive = false;
          m.deserted = true;
          g.campaign.axes.notoriety += 1;
        }
        m.dispute = null;
        void sc;
        done();
      },
    });
  }

  // ------------------------------------------------------------------ ledger

  showLedger(camp: CampScene, depart: (nextLeg: string) => void) {
    this.clear();
    this.ledger = new LedgerPanel(this.game, this.root, camp, depart, () => this.showSliceEnd(camp));
    this.ledger.open();
  }

  // ------------------------------------------------------------------ fail & end

  showFail(reason: string, retry: () => void, quit: () => void) {
    const g = this.game;
    this.clear();
    this.root.innerHTML = `<div class="enc panel paper" style="width:min(640px,92%)"><h2>The convoy is lost</h2>
      <p>${escapeHtml(reason)} The road north is long, and it does not forgive. Pick up from the last Dawn Ledger?</p>
      <div class="btnrow"><button data-fid="retry" ${hasSave() ? '' : 'disabled'}>Retry from the last Ledger</button><button data-fid="new">New convoy</button><button data-fid="quit">Quit to title</button></div></div>`;
    this.root.querySelectorAll<HTMLElement>('button').forEach((b) => (b.style.pointerEvents = 'auto'));
    const q = (k: string) => this.root.querySelector<HTMLElement>(`[data-fid="${k}"]`)!;
    g.focus.setItems([
      { el: q('retry'), press: () => retry(), disabled: !hasSave() },
      { el: q('new'), press: () => g.startNewGame() },
      { el: q('quit'), press: () => quit() },
    ]);
    g.focus.cursor = [hasSave() ? 0 : 1, hasSave() ? 0 : 1];
    g.focus.active = true;
    g.audio.setMusic('none');
  }

  /** Training is over: the lessons covered, and where to go from here. */
  showTrainingDone(lessons: number) {
    const g = this.game;
    this.clear();
    this.root.innerHTML = `<div class="enc panel paper" style="width:min(640px,92%)"><h2>Training complete</h2>
      <p style="text-transform:none;letter-spacing:.01em">${lessons} lessons done: on foot, shooting, scavenging, driving, noise and dust, repairs and fuel, the map, your pack, and making camp. Out in the world the Dusk Bell is followed by a vote on a camp, three minutes to build, and a three-wave night raid. The illustrated guide covers that part, and the rest of the survival rules.</p>
      <div class="btnrow"><button data-fid="new">Start a new convoy</button><button data-fid="guide">Illustrated guide</button><button data-fid="again">Train again</button><button data-fid="quit">Title</button></div></div>`;
    this.root.querySelectorAll<HTMLElement>('button').forEach((b) => (b.style.pointerEvents = 'auto'));
    const q = (k: string) => this.root.querySelector<HTMLElement>(`[data-fid="${k}"]`)!;
    g.focus.setItems([
      { el: q('new'), press: () => g.startNewGame() },
      { el: q('guide'), press: () => this.showGuide(() => this.showTrainingDone(lessons), undefined, 7) },
      { el: q('again'), press: () => g.startTraining() },
      { el: q('quit'), press: () => g.toTitle() },
    ]);
    g.focus.cursor = [0, 0];
    g.focus.active = true;
    g.audio.setMusic('none');
  }

  showSliceEnd(camp: CampScene | null) {
    const g = this.game;
    this.clear();
    const c = g.campaign;
    const loyalCrew = c.crewLive.filter((m) => m.loyalty >= MERCS.loyalty.bands.loyal).length;
    const lean = leaning(c.axes);
    const ending: EndingId = selectEnding({ axes: c.axes, loyalCrewAlive: loyalCrew, crewAlive: c.crewLive.length, fragments: c.fragments.size });
    const leanText = t(`lean.${lean === 'neutral' ? 'neutral' : lean}`);
    const s = c.stats;
    this.root.innerHTML = `<div class="report panel paper" style="width:min(820px,94%)"><h2>${legById(c.legId).open ? 'Haven' : 'Rustgate'}: end of the vertical slice</h2>
      <p style="text-transform:none;letter-spacing:.01em">${legById(c.legId).open ? 'The gate stood open. Whatever the broadcast was, it was true enough to get you here. The road ends at Haven; the country around it does not, and the broadcast has started again, from further away.' : 'You made it to the first real settlement. The broadcast crackles again, and somewhere to the north a gate waits to find out what kind of convoy you turned out to be.'}</p>
      <div class="grid2"><div>Distance driven <b>${(s.distance / 1000).toFixed(1)} km</b></div><div>Nights survived <b>${s.nights}</b></div>
      <div>Infected put down <b>${s.zombiesKilled}</b></div><div>Raiders put down <b>${s.raidersKilled}</b></div>
      <div>Vehicles lost <b>${s.vehiclesLost}</b></div><div>Radio fragments <b>${c.fragments.size}/4</b></div>
      <div>Crew standing <b>${c.crewLive.length}</b></div><div>Time apart <b>${Math.round(s.timeApart / 60)} min</b></div></div>
      <div class="result">${escapeHtml(leanText)}</div>
      <p class="mutedtxt">The road ahead holds ${selectEndingTitle(ending)} for convoys like yours. Tiers 4 and 5, the Scout, Scavenger and Heavy Vanguard, the remaining legs and endings arrive in the Beta.</p>
      <div class="btnrow" style="margin-top:12px"><button data-fid="led">Back to the Ledger</button><button data-fid="new">New convoy</button><button data-fid="quit">Title</button></div></div>`;
    this.root.querySelectorAll<HTMLElement>('button').forEach((b) => (b.style.pointerEvents = 'auto'));
    const q = (k: string) => this.root.querySelector<HTMLElement>(`[data-fid="${k}"]`)!;
    g.focus.setItems([
      { el: q('led'), press: () => camp && this.showLedger(camp, (next) => (legById(c.legId).open ? this.game.rollOut(next) : undefined)) },
      { el: q('new'), press: () => g.startNewGame() },
      { el: q('quit'), press: () => g.toTitle() },
    ]);
    g.focus.active = true;
  }
}

function selectEndingTitle(e: EndingId) {
  return { openGate: 'an open gate', toll: 'a toll', twoWalked: 'a long walk', warlord: 'a throne', hollow: 'an empty city' }[e];
}

const mouseWord = (b: number | undefined) => (b === undefined ? 'unbound' : ['left click', 'middle click', 'right click', 'side button 1', 'side button 2'][b] ?? `button ${b + 1}`);
