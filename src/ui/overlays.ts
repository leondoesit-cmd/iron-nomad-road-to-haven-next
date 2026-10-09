import { ENCOUNTERS, HEROES, LEGS, STRUCTURES, encounterById, legById, nextHero, otherHero, seatHeroes, t, type HeroId, type LegDef } from '../data';
import { FocusUI, type FocusItem } from './focus';
import { LedgerPanel } from './ledger';
import { ControlsMenu } from './controls';
import type { Guide } from './guide';
import { PROMPT_ACTION, keyLabel, padLabel, padPhysical, type KeyMap } from '../input/bindings';
import { escapeHtml } from './hud';
import { hasSave, initSave, savedSolo } from '../save/save';
import { Btn, wasPressed } from '../input/intents';
import { resolveEffects, resolveVote, type ResolvedEffects } from '../sim/endings';
import { Rng } from '../core/rng';
import { MERCS } from '../data';
import { applyLoyalty, type Merc } from '../sim/loyalty';
import { selectEnding, leaning, type EndingId } from '../sim/endings';
import { PLAYER_CSS } from '../render/palette';
import { LABEL, canAfford, costText, whole } from '../sim/resources';
import { barkKey, buyLot, canHelp, sellLot, type TradeResult } from '../sim/travellers';
import { requestCostText } from '../game/travellerFx';
import type { Traveller } from '../game/travellers';
import type { Game } from '../game/game';
import type { CampScene } from '../game/campScene';
import type { QualityPreset } from '../render/renderer';
import { BENCHMARK_CASES, BENCHMARK_SCENARIOS } from '../game/benchmark';
import { initPhysics } from '../physics/physics';
import { DAY_MINUTES, TUNING, ZOMBIE_HITS } from '../sim/tuning';
import { RETICLE_COLORS, RETICLE_DOTS, RETICLE_LOOKS, RETICLE_MARKS, stepIn } from './reticle';

/** Settings steps for the fire's spread and the wind, as shares of the game as tuned. */
const FIRE_PACES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];
const WIND_STRENGTHS = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];

/** The next step up or down a list from the value nearest `cur`, stopping at the ends. */
function stepClamped(list: readonly number[], cur: number, dir: number): number {
  let i = 0;
  for (let k = 1; k < list.length; k++) if (Math.abs(list[k] - cur) < Math.abs(list[i] - cur)) i = k;
  return list[Math.min(list.length - 1, Math.max(0, i + dir))];
}

let guideClass: typeof Guide | null = null;
let guideLoading: Promise<typeof Guide> | null = null;
/** Fetch the illustrated guide's chunk (the title asks for it while idle, so it is there before anyone opens it). */
export function loadGuide(): Promise<typeof Guide> {
  return (guideLoading ??= import('./guide')
    .then((m) => (guideClass = m.Guide))
    .catch((error) => {
      guideLoading = null;
      throw error;
    }));
}

export class Overlays {
  root = document.getElementById('overlay')!;
  private pauseEl: HTMLElement | null = null;
  pauseFocus = new FocusUI();
  /** Who plays alone (Leo unless picked otherwise), and who sits in each split-screen seat (Chinsky and Leo unless picked otherwise). */
  private soloHero: HeroId = seatHeroes(true)[0];
  private pair: [HeroId, HeroId] = seatHeroes(false);
  private debugEl: HTMLElement | null = null;
  private titleReady = false;
  private tickers: ((dt: number) => void)[] = [];
  private ledger: LedgerPanel | null = null;
  private benchmarkDuration: 'quick' | 'standard' = 'standard';
  private benchmarkProgress: HTMLElement | null = null;
  private benchmarkPaint = 0;

  constructor(private game: Game) {
    this.pauseFocus.onCancel = () => {
      if (this.game.paused) this.game.setPause(false, -1);
    };
  }

  /** Who sits in each seat for the next run: Chinsky left and Leo right in split screen, Leo alone, unless picked otherwise. */
  heroes(): [HeroId, HeroId] {
    if (this.game.solo) return [this.soloHero, otherHero(this.soloHero)];
    return [this.pair[0], this.pair[1]];
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
      if (this.game.phase === 'title' && this.root.querySelector('.title-screen')) this.renderTitle();
    });
    this.renderTitle();
  }

  private renderTitle() {
    const g = this.game;
    const pads = g.input.connectedPads();
    const solo = g.solo;
    const slotHtml = (i: number) => {
      const s = g.input.slots[i];
      const joined = !!s;
      const dev = s ? (s.kind === 'pad' ? `GAMEPAD ${s.index + 1}` : `KEYBOARD ${s.set === 1 ? 'WASD' : 'ARROWS'}`) : '';
      const join = i === 0 ? (solo ? t('title.joinSolo') : t('title.joinKb1')) : t('title.joinKb2');
      return `<div class="slot p${i + 1} ${joined ? 'joined' : ''}">
        <div class="who" style="color:${PLAYER_CSS[i]}">${solo ? 'SOLO' : `PLAYER ${i + 1}`}</div>
        ${joined ? `<div>${dev}</div>` : `<div class="blink">${t('title.join')}</div><div class="hint">${join}</div>`}
        <div style="margin-top:8px"><button data-fid="name${i}">‹ ${HEROES[this.heroes()[i]].name.toUpperCase()} ›</button></div>
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
          <button data-fid="story" class="g-go">Story</button>
          <button data-fid="new">New convoy</button>
          <button data-fid="cont" ${hasSave() ? '' : 'disabled'}>Continue${saved}</button>
          <button data-fid="set">Settings</button>
          <button data-fid="ctl">Control settings</button>
          <button data-fid="how">Controls</button>
        </div>
        <div class="btnrow" style="margin-top:10px">
          <button data-fid="learn" class="g-go">How to play</button>
          <button data-fid="train" class="g-go">Training</button>
          <button data-fid="garden">Amirat's garden</button>
          <button data-fid="bench">Benchmark</button>
        </div>
        <p style="font-size:.78em;margin-top:18px">${solo ? 'One player, full screen. Plug in a gamepad and press A, or use the keyboard (WASD with F, or the arrow keys with Right Shift).' : 'Two players, one screen. Plug in two gamepads and press A, or share the keyboard.'} Chrome or Edge recommended; gamepads need localhost or HTTPS.</p>
        <p style="font-size:.78em">${pads.length ? `Controllers found: ${pads.map((p) => escapeHtml(padName(p))).join(' · ')}` : 'No controller found yet. Connect one and press any button on it: the browser only shows a controller after a press.'}</p>
        ${g.input.nonStandard.size ? '<p style="color:var(--amber)">A controller without the standard mapping was detected. Controls may be wrong.</p>' : ''}
      </div></div>`;
    const el = (k: string) => this.root.querySelector<HTMLElement>(`[data-fid="${k}"]`)!;
    const items: FocusItem[] = [
      { el: el('mode'), press: () => this.titleLock <= 0 && this.toggleSolo() },
      { el: el('name0'), press: () => this.titleLock <= 0 && this.cycleName(0) },
      ...(solo ? [] : [{ el: el('name1'), press: () => this.titleLock <= 0 && this.cycleName(1) }]),
      // Each starts behind a loading veil, so the press answers at once (`Game.load`).
      { el: el('story'), press: () => this.titleLock <= 0 && g.load('Story', () => g.startStory()) },
      { el: el('new'), press: () => this.titleLock <= 0 && g.load('New convoy', () => g.startNewGame()) },
      { el: el('cont'), press: () => this.titleLock <= 0 && g.load('Continue', () => g.continueGame()), disabled: !hasSave() },
      { el: el('set'), press: () => this.titleLock <= 0 && this.showSettings(() => this.showTitle()) },
      { el: el('ctl'), press: () => this.titleLock <= 0 && this.showControlSettings(() => this.showTitle()) },
      { el: el('how'), press: () => this.titleLock <= 0 && this.showControls(() => this.showTitle()) },
      { el: el('learn'), press: () => this.titleLock <= 0 && this.showGuide(() => this.showTitle(), () => g.load('Training', () => g.startTraining())) },
      { el: el('train'), press: () => this.titleLock <= 0 && g.load('Training', () => g.startTraining()) },
      { el: el('garden'), press: () => { if (this.titleLock <= 0) location.href = '/garden.html'; } },
      { el: el('bench'), press: () => this.titleLock <= 0 && this.showBenchmark() },
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

  /** Pick the next hero for a seat. In split screen the two always differ, so a seat passes over whoever has the other. */
  private cycleName(i: number) {
    if (this.game.solo) this.soloHero = nextHero(this.soloHero);
    else this.pair[i] = nextHero(this.pair[i], this.pair[1 - i]);
    this.game.audio.play('click');
    // The demo behind the menu restarts so whoever was picked rides in it.
    this.game.restartAttract();
    this.renderTitle();
    this.game.focus.cursor = [i + 1, i + 1];
  }

  private lastJoined = 0;
  /** After a player joins, the same A press must not also confirm a menu item. */
  private titleLock = 0;
  tickTitle(dt: number) {
    if (!this.titleReady || this.game.phase !== 'title' || !this.root.querySelector('.title-screen')) return;
    this.titleLock = Math.max(0, this.titleLock - dt);
    const j = this.game.input.joined + (this.game.input.slots[0]?.kind === 'pad' ? 10 : 0) + (this.game.input.slots[1]?.kind === 'pad' ? 20 : 0) + this.game.input.connectedPads().length * 100;
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
      if (this.titleLock <= 0 && wasPressed(this.game.input.intents[p], Btn.Start) && this.game.input.slots[p]) this.game.load('New convoy', () => this.game.startNewGame());
    }
  }

  // ------------------------------------------------------------------ settings & controls

  showBenchmark(message?: string) {
    this.clear();
    this.benchmarkProgress = null;
    const g = this.game, report = g.benchmarkReport;
    const results = report ? `<h3>Last completed run</h3>
      <p>${escapeHtml(report.quality.toUpperCase())} · ${report.width} × ${report.height} · ${report.pixelRatio.toFixed(2)} render pixels / CSS pixel · ${report.duration} run</p>
      <div class="benchmark-table"><table><thead><tr><th>Scenario / view</th><th>FPS</th><th>1% low</th><th>95% frame</th><th>CPU sim</th><th>CPU draw</th><th>Calls</th><th>Triangles</th></tr></thead><tbody>
      ${report.results.map(r => `<tr><td>${escapeHtml(r.scenario)}<small>${escapeHtml(r.mode)}</small></td><td>${r.fps.toFixed(1)}</td><td>${r.low1Fps.toFixed(1)}</td><td>${r.p95Ms.toFixed(1)} ms</td><td>${r.simulationMs.toFixed(1)} ms</td><td>${r.renderCpuMs.toFixed(1)} ms</td><td>${Math.round(r.calls)}</td><td>${(r.triangles / 1000).toFixed(0)}k</td></tr>`).join('')}
      </tbody></table></div>
      <p class="benchmark-note">FPS includes browser frame pacing and may be capped by your display. 1% low uses the slowest 1% of frames; 95% of frames finish within the listed frame time. CPU draw is submission time, not GPU execution. JSON includes 99% frame time, slow-frame counts and discarded simulation steps.</p>` : '';
    this.root.innerHTML = `<div class="menu benchmark-menu"><h2>Performance benchmark</h2>
      <p>Runs ${BENCHMARK_SCENARIOS.length} scenarios in single screen, top / bottom split, and left / right split: ${BENCHMARK_CASES.length} tests.</p>
      <p>${BENCHMARK_SCENARIOS.map(s => escapeHtml(s.name)).join(' · ')}</p>
      <p class="benchmark-note">Uses your current <b>${g.R.quality.toUpperCase()}</b> graphics preset at fixed resolution. Each scene warms up before measurement. Audio is muted; your settings and joined controllers return afterwards. Keep this tab visible and the window size steady.</p>
      ${message ? `<p role="status">${escapeHtml(message)}</p>` : ''}
      <div class="btnrow"><button data-fid="duration">${this.benchmarkDuration === 'standard' ? 'Standard · about 3 minutes' : 'Quick · about 1 minute'}</button><button data-fid="run">${report ? 'Run again' : 'Run benchmark'}</button>${report ? '<button data-fid="download">Download results</button>' : ''}<button data-fid="back">Back</button></div>
      ${results}</div>`;
    const el = (id: string) => this.root.querySelector<HTMLElement>(`[data-fid="${id}"]`)!;
    g.focus.setItems([
      { el: el('duration'), press: () => { this.benchmarkDuration = this.benchmarkDuration === 'standard' ? 'quick' : 'standard'; this.showBenchmark(); } },
      // The title is up before Rapier has loaded; a run needs it.
      { el: el('run'), press: () => void initPhysics().then(() => g.startBenchmark(this.benchmarkDuration)) },
      ...(report ? [{ el: el('download'), press: () => {
        const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url; a.download = `iron-nomad-benchmark-${report.createdAt.slice(0, 19).replace(/:/g, '-')}.json`;
        a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      } }] : []),
      { el: el('back'), press: () => this.showTitle() },
    ]);
    g.focus.cursor = [1, 1];
    g.focus.active = true;
    g.focus.onCancel = () => this.showTitle();
  }

  showBenchmarkRunning() {
    this.clear();
    this.root.innerHTML = `<div class="benchmark-live"><strong>Benchmark</strong><div data-benchmark-progress role="status"></div><button data-fid="cancel">Cancel · Esc</button></div>`;
    this.benchmarkProgress = this.root.querySelector('[data-benchmark-progress]');
    this.benchmarkPaint = 0;
    this.game.focus.setItems([{ el: this.root.querySelector('[data-fid="cancel"]')!, press: () => this.game.stopBenchmark() }]);
    this.game.focus.active = true;
    this.game.focus.onCancel = () => this.game.stopBenchmark();
    this.updateBenchmarkProgress();
  }

  updateBenchmarkProgress(hidden = false) {
    const run = this.game.benchmark, el = this.benchmarkProgress;
    if (!run || !el) return;
    const now = performance.now();
    if (!hidden && now - this.benchmarkPaint < 200) return;
    this.benchmarkPaint = now;
    const test = run.current;
    if (!test) return;
    const limit = run.stage === 'warming' ? run.warmupMs : run.measureMs;
    const stage = hidden ? 'Paused while tab is hidden · this test will restart' : run.stage === 'loading' ? 'Loading' : `${run.stage === 'warming' ? 'Warming up' : 'Measuring'} · ${(Math.max(0, limit - run.elapsed) / 1000).toFixed(0)} s`;
    el.textContent = `${run.index + 1} / ${BENCHMARK_CASES.length} · ${test.scenario.name} · ${test.name} · ${stage}`;
  }

  showSettings(back: () => void) {
    const g = this.game;
    const wasPausedOverlay = g.paused;
    const host = wasPausedOverlay ? this.pauseEl! : this.root;
    const solo = g.solo;
    let musicBusy = false;
    let audioStatusTimer: ReturnType<typeof setInterval> | undefined;
    const recordingStatus = () => g.audio.samples ? `${g.audio.samples.loaded}/${g.audio.samples.total} loaded${g.audio.samples.failures.size ? ` · ${g.audio.samples.failures.size} unavailable` : ''}` : 'Start audio with a key or click';
    const render = () => {
      if (audioStatusTimer) clearInterval(audioStatusTimer);
      const s = g.input.settings;
      const row = (id: string, label: string, val: string) =>
        `<div class="item"><span>${label}</span><span style="display:flex;gap:6px;align-items:center"><button data-fid="${id}-" style="padding:0 8px">-</button><span style="min-width:96px;text-align:center;font-family:var(--mono)">${val}</span><button data-fid="${id}+" style="padding:0 8px">+</button></span></div>`;
      const d = g.campaign.difficulty;
      const ret = g.hud.reticle;
      const retLook = RETICLE_LOOKS.find((l) => l.id === ret.look)!;
      const retColor = RETICLE_COLORS.find((c) => c.id === ret.color)!;
      host.innerHTML = `<div class="menu" style="min-width:min(640px,92vw);max-height:90vh;overflow-y:auto;pointer-events:auto"><h2>Settings</h2><div class="list">
        ${row('q', 'Graphics preset', g.R.quality.toUpperCase())}
        ${row('ui', 'UI scale', `${Math.round(g.hud.uiScale * 100)}%`)}
        ${solo ? '' : row('lay', 'Split screen', g.R.layout === 'horizontal' ? 'TOP / BOTTOM' : 'LEFT / RIGHT')}
        ${row('vol', 'Master volume', `${Math.round(g.audio.volume * 100)}%`)}
        ${row('user-mus', 'User music in vehicles', g.audio.userMusicEnabled ? 'ON' : 'OFF')}
        ${row('user-vol', 'User music volume', `${Math.round(g.audio.userMusicVolume * 100)}%`)}
        ${row('tts', 'Optional synthesized radio voice', g.audio.ttsEnabled ? 'ON' : 'OFF')}
        ${row('voice', 'Read story lines aloud (browser voice)', g.storyVoice.enabled ? 'ON' : 'OFF')}
        <div style="font-size:.7em;text-transform:none;letter-spacing:0">Recorded effects: <span data-audio-status>${recordingStatus()}</span> · <a href="audio/CREDITS.txt" target="_blank" rel="noopener">Sound credits and licenses</a> · <a href="models/CREDITS.txt" target="_blank" rel="noopener">Model credits</a> · <a href="textures/CREDITS.txt" target="_blank" rel="noopener">Texture credits</a></div>
        <div class="item"><span>User music folder</span><span style="display:flex;gap:6px"><button data-fid="music-folder" ${musicBusy ? 'disabled' : ''}>Choose music folder</button><button data-fid="music-game" ${musicBusy ? 'disabled' : ''}>Default music folder</button></span></div>
        <div style="font-size:.7em;text-transform:none;letter-spacing:0;max-width:620px;overflow-wrap:anywhere">${escapeHtml(g.audio.userMusic.label)} · ${escapeHtml(g.audio.userMusic.status)}<br>Drop tracks into public/music, or choose a folder on your device. Imports stay in this browser; reselect to refresh. Music pauses for radio speech and resumes where it left off.</div>
        ${row('rm1', solo ? 'Rumble' : 'P1 rumble', s.rumble[0] ? 'ON' : 'OFF')}
        ${solo ? '' : row('rm2', 'P2 rumble', s.rumble[1] ? 'ON' : 'OFF')}
        ${row('aa1', solo ? 'Aim assist' : 'P1 aim assist', `${Math.round(s.aimAssist[0] * 100)}%`)}
        ${solo ? '' : row('aa2', 'P2 aim assist', `${Math.round(s.aimAssist[1] * 100)}%`)}
        ${row('ms', 'Mouse / trackpad sensitivity', `${Math.round(s.mouseSens * 100)}%`)}
        ${row('dr', 'Drain (fuel, food)', `${d.drain.toFixed(2)}×`)}
        ${row('ag', 'Aggro (enemy senses)', `${d.aggro.toFixed(2)}×`)}
        ${row('dm', 'Damage taken', `${d.damage.toFixed(2)}×`)}
        ${row('god', 'God mode (every weapon from the start, +50% health)', g.godMode ? 'ON' : 'OFF')}
        ${row('zt', 'Zombie toughness (pistol hits to drop one)', `${TUNING.zombieHits} ${TUNING.zombieHits === 1 ? 'HIT' : 'HITS'}`)}
        <div style="font-size:.7em;text-transform:none;letter-spacing:0;max-width:620px">Counted for a walker shot in the body; big ones take more, heavy guns fewer. The wounds add up, so a tough one loses limbs, bones and guts before it drops. New zombies take the change.</div>
        ${row('fs', 'Fire spread speed', `${TUNING.fire.toFixed(2)}×`)}
        ${row('ws', 'Wind strength', TUNING.wind === 0 ? 'CALM' : `${TUNING.wind.toFixed(2)}×`)}
        ${row('dl', 'Day length (first light to dark)', `<input type="range" data-fid="dl-slider" min="${DAY_MINUTES.min}" max="${DAY_MINUTES.max}" step="${DAY_MINUTES.step}" value="${TUNING.dayLength / 60}" style="width:110px;vertical-align:middle;pointer-events:auto"> <span data-fid="dl-val">${TUNING.dayLength / 60} MIN</span>`)}
        ${row('xs', 'Crosshair', `<span style="display:inline-flex;gap:8px;align-items:center"><span class="retprev"><span class="reticle" data-look="${ret.look}" style="--rd:${ret.dot}px;--rc:${retColor.css}">${RETICLE_MARKS}</span></span>${retLook.name.toUpperCase()}</span>`)}
        ${row('xd', 'Crosshair dot size', `${ret.dot}px`)}
        ${row('xc', 'Crosshair colour', retColor.name.toUpperCase())}
        ${row('nc', 'Night camp (every night: a camp and a raid)', g.nightCamp ? 'ON' : 'OFF')}
        <div style="font-size:.7em;text-transform:none;letter-spacing:0;max-width:620px">${g.nightCamp ? 'The Dusk Bell calls a camp: build defences and hold off a three-wave night raid.' : 'After the Dusk Bell, rest until dawn, push on through the dark, or make camp and hold it through a raid for the night\'s haul: ammunition, a rare part and medicine.'}</div>
        <div class="item"><button data-fid="back">Back</button><span class="mutedtxt" style="color:#c9bd9f">${solo ? '' : 'Per-player options apply to that seat.'}</span></div>
      </div></div>`;
      (host.querySelectorAll('.menu button') as NodeListOf<HTMLElement>).forEach((b) => (b.style.pointerEvents = 'auto'));
      const el = (k: string) => host.querySelector<HTMLElement>(`[data-fid="${k}"]`)!;
      // The day-length slider: dragging retimes the day as it goes, letting go saves it.
      const daySlider = host.querySelector<HTMLInputElement>('[data-fid="dl-slider"]')!;
      daySlider.addEventListener('input', () => {
        g.setDayLength(Number(daySlider.value) * 60);
        el('dl-val').textContent = `${TUNING.dayLength / 60} MIN`;
      });
      daySlider.addEventListener('change', () => g.saveSettings());
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
          case 'game-mus':
            g.audio.setGameMusicEnabled(!g.audio.gameMusicEnabled);
            break;
          case 'user-mus':
            g.audio.setUserMusicEnabled(!g.audio.userMusicEnabled);
            break;
          case 'user-vol':
            g.audio.setUserMusicVolume(clamp(g.audio.userMusicVolume + dir * 0.1, 0, 1));
            break;
          case 'mus':
            g.audio.setMusicVolume(clamp(g.audio.musicVolume + dir * 0.1, 0, 1));
            break;
          case 'tts':
            g.audio.setTtsEnabled(!g.audio.ttsEnabled);
            g.saveSettings();
            break;
          case 'voice':
            g.storyVoice.enabled = !g.storyVoice.enabled;
            if (!g.storyVoice.enabled) g.storyVoice.stop();
            break;
          case 'god':
            g.setGodMode(!g.godMode);
            break;
          case 'zt':
            TUNING.zombieHits = stepClamped(ZOMBIE_HITS, TUNING.zombieHits, dir);
            break;
          case 'fs':
            TUNING.fire = stepClamped(FIRE_PACES, TUNING.fire, dir);
            break;
          case 'ws':
            TUNING.wind = stepClamped(WIND_STRENGTHS, TUNING.wind, dir);
            break;
          case 'dl':
            g.setDayLength(TUNING.dayLength + dir * DAY_MINUTES.step * 60);
            break;
          case 'xs': {
            const r = g.hud.reticle;
            g.hud.setReticle({ ...r, look: stepIn(RETICLE_LOOKS.map((l) => l.id), r.look, dir) });
            break;
          }
          case 'xd': {
            const r = g.hud.reticle;
            g.hud.setReticle({ ...r, dot: stepClamped(RETICLE_DOTS, r.dot, dir) });
            break;
          }
          case 'xc': {
            const r = g.hud.reticle;
            g.hud.setReticle({ ...r, color: stepIn(RETICLE_COLORS.map((c) => c.id), r.color, dir) });
            break;
          }
          case 'nc':
            g.nightCamp = !g.nightCamp;
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
        // The sliders belong to the player, not to whichever campaign is up (on the title that is only the demo's).
        g.difficulty = { ...dd };
        g.saveSettings();
        g.audio.play('click');
        const keys = fc.keys();
        render();
        fc.setItems(makeItems(), keys);
      };
      const ids = ['q', 'ui', ...(solo ? [] : ['lay']), 'vol', 'user-mus', 'user-vol', 'tts', 'voice', 'rm1', ...(solo ? [] : ['rm2']), 'aa1', ...(solo ? [] : ['aa2']), 'ms', 'dr', 'ag', 'dm', 'god', 'zt', 'fs', 'ws', 'dl', 'xs', 'xd', 'xc', 'nc'];
      const makeItems = (): FocusItem[] => [
        ...ids.flatMap((id) => [
          { el: el(`${id}-`), press: () => step(id, -1) },
          { el: el(`${id}+`), press: () => step(id, 1) },
        ]),
        { el: el('music-folder'), press: () => {
          if (musicBusy) return;
          const picker = document.createElement('input');
          picker.type = 'file';
          picker.multiple = true;
          picker.setAttribute('webkitdirectory', '');
          picker.accept = 'audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac,.opus,.webm';
          picker.onchange = async () => {
            const files = Array.from(picker.files ?? []);
            if (!files.length) return;
            musicBusy = true;
            const label = files[0].webkitRelativePath.split('/')[0] || 'Selected music';
            const pending = g.audio.userMusic.selectFiles(files, label);
            render();
            await pending;
            musicBusy = false;
            if (host.querySelector('[data-fid="music-folder"]')) render();
          };
          picker.click();
        } },
        { el: el('music-game'), press: async () => {
          if (musicBusy) return;
          musicBusy = true;
          const pending = g.audio.userMusic.useGameFolder();
          render();
          await pending;
          musicBusy = false;
          if (host.querySelector('[data-fid="music-game"]')) render();
        } },
        { el: el('back'), press: () => done() },
      ];
      fc.setItems(makeItems());
      const status = host.querySelector<HTMLElement>('[data-audio-status]');
      audioStatusTimer = setInterval(() => {
        if (!status?.isConnected) { clearInterval(audioStatusTimer); return; }
        status.textContent = recordingStatus();
      }, 500);
    };
    const fc = wasPausedOverlay ? this.pauseFocus : g.focus;
    const prevActive = fc.active;
    const prevCancel = fc.onCancel;
    const done = () => {
      if (audioStatusTimer) clearInterval(audioStatusTimer);
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

  /**
   * The illustrated guide. From the title it can lead straight into training. Its pictures come in a chunk of their own
   * (`loadGuide`, fetched while the title is idle); opened before that lands, it shows as soon as it does, unless the
   * menu has moved on meanwhile.
   */
  showGuide(back: () => void, onTrain?: () => void, page = 0) {
    const g = this.game;
    const open = (G: typeof Guide) => {
      const paused = g.paused;
      (this.guide ??= new G(g)).show(paused ? this.pauseEl! : this.root, paused ? this.pauseFocus : g.focus, back, { onTrain, page });
    };
    if (guideClass) return open(guideClass);
    const host = g.paused ? this.pauseEl : this.root;
    const shown = host?.firstElementChild;
    void loadGuide().then((G) => {
      if ((g.paused ? this.pauseEl : this.root) === host && host?.firstElementChild === shown) open(G);
    });
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
      if (action === 'view' && b.pad.view === -2) return `${padLabel(b.pad.sheet)} tap`;
      return padLabel(padPhysical(b.pad, action));
    };
    const pair = (a: string, c: string) => `${pad(a as 'A')} / ${pad(c as 'A')}`;
    const rows: [string, string, string, string, string][] = [
      ['', 'On foot', 'Driving', 'Gunner / passenger', 'Camp build'],
      ['Left stick', 'Move', 'Steer', 'Lean', 'Move'],
      ['Right stick', 'Aim / look', 'Free look', 'Aim gun', 'Aim reticle'],
      [pair('RT', 'LT'), 'Fire / aim', 'Throttle / brake', 'Fire / zoom', 'Place / remove'],
      [pad('RB'), 'Tap melee · hold takedown', 'Fire front gun', 'Fire', 'Next element'],
      [pad('LB'), 'Tap: swap what is in hand along your belt: weapons, wrench (repair), crowbar (strip parts), jerrycan (fuel) · hold: crew orders', 'Hold: crew orders', 'Swap weapon', 'Previous element'],
      [pad('A'), 'Tap jump (when nothing is in reach) · hold to loot, repair, strip, siphon, refuel, revive', 'Handbrake', 'Reload', 'Rotate'],
      [pad('B'), 'Crouch', 'Tap lights · hold engine off', 'Cancel', 'Cancel'],
      [pad('X'), 'Reload · hold swap utility · wrench: workbench', 'Tap horn · hold siren', 'Reload', 'Watch post'],
      [pad('Y'), 'Get in any vehicle (abandoned cars become yours)', 'Get out · hold to bail at speed', 'Get out', 'Build wheel'],
      [pad('view'), 'Always first person on foot', 'Vehicle camera: chase / the eyes in the cab', 'Same: chase / along the gun', '—'],
      ['D-pad', 'Tap ↑ ping · hold any way for the quick select wheel: ↑ weapons, → tools, ↓ health, ← drugs', 'Same', 'Same', 'Same'],
      [pad('map'), 'Tap map: closer look, whole leg, close', 'Same', 'Same', 'Same'],
      [pad('inventory'), 'Inventory: change what you wear and hold (the game pauses)', 'Same', 'Same', 'Same'],
      [pair('L3', 'R3'), 'Click to sprint (stays on until you stop) / reset cam', 'Camera distance / look back', 'Zoom', 'Snap grid'],
      [`Start / ${pad('sheet')}`, 'Pause · hold for the convoy sheet', 'Same', 'Same', 'Same'],
    ];
    const kbLine = (set: 0 | 1) => {
      const m: KeyMap = b.kb[set];
      const k = (id: keyof KeyMap) => keyLabel(m[id]);
      return `${set === 0 ? 'P1' : 'P2'}: ${k('moveUp')} ${k('moveLeft')} ${k('moveDown')} ${k('moveRight')} move, ${k('turnLeft')} / ${k('turnRight')} aim, ${k('fire')} fire, ${k('interact')} interact, ${k('jump')} jump, ${k('vehicle')} vehicle, ${k('view')} vehicle camera, ${k('crouch')} crouch / lights, ${k('sprint')} sprint / handbrake, ${k('wheel')} wheel, ${k('map')} map, ${k('inventory')} inventory, ${k('swap')} swap tool, ${k('prevBuild')} ${k('nextBuild')} cycle build, hold ${k('sheet')} for the convoy sheet`;
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
    const night = g.scene?.mode === 'camp' && (g.scene as CampScene).canSkipNight;
    el.innerHTML = `<div class="menu"><h2>${who}</h2>${reconnect}<div class="list">
      <div class="item"><button data-fid="res">Resume</button></div>
      <div class="item"><button data-fid="set">Settings</button></div>
      <div class="item"><button data-fid="ctl">Control settings</button></div>
      <div class="item"><button data-fid="how">Controls</button></div>
      <div class="item"><button data-fid="learn">How to play</button></div>
      ${g.tutorial ? '<div class="item"><button data-fid="skip">Skip this lesson</button></div>' : ''}
      ${night ? '<div class="item"><button data-fid="night">Skip the night</button></div>' : ''}
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
      ...(night ? [{ el: q('night'), press: () => (g.setPause(false, -1), (g.scene as CampScene).skipNight()) }] : []),
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
    // A sub-screen left by Esc never ran its own teardown: its handlers would drive the next pause menu's removed page.
    this.pauseFocus.onTick = null;
    this.pauseFocus.onCancel = () => {};
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

  /**
   * Someone on the road is asking for help. It is the same shared vote as a Roadside Encounter (agree, or the Lead decides),
   * with the traveller's own words in it.
   */
  showRequest(tv: Traveller, done: (helped: boolean, overridden: boolean) => void) {
    const g = this.game;
    const kind = tv.request;
    if (!kind) return done(false, false);
    const cost = requestCostText(tv);
    const can = canHelp(g.campaign.stocks, kind);
    const rng = new Rng(g.campaign.seed + tv.id * 17);
    this.vote({
      kind: 'encounter',
      title: t(`trav.ask.${kind}.title`),
      text: t('trav.say', { who: tv.name, line: t(`trav.ask.${kind}.${tv.attitude}`) }),
      choices: [{ label: t(`trav.ask.${kind}.give`, { cost }), sub: can ? undefined : escapeHtml(t('trav.note.cant', { cost })) }, { label: t('trav.ask.no') }],
      lead: g.campaign.lead,
      result: (i) => t('trav.say', { who: tv.name, line: t(barkKey(rng, i === 0 && can ? 'thanks' : `refused.${tv.attitude}`)) }),
      onDone: (choice, overridden) => done(choice === 0, overridden),
    });
  }

  /**
   * A trader's cart. Either player can buy and sell with the shared stores, in Scrap; every press is one lot, and the
   * panel stays open until someone walks on.
   */
  showTrade(tv: Traveller, done: () => void) {
    const g = this.game;
    const stock = tv.stock;
    if (!stock) return done();
    this.clear();
    const c = g.campaign;
    const rng = new Rng(g.campaign.seed + tv.id * 29);
    let msg = t(barkKey(rng, 'trade.open'));
    const acts = new Map<string, () => void>();
    const btn = (id: string, label: string, act: () => void, enabled: boolean) => {
      acts.set(id, act);
      return `<button data-fid="${id}" ${enabled ? '' : 'disabled'}>${label}</button>`;
    };
    const verdict = (r: TradeResult, ok: string) => {
      if (r === 'ok') {
        g.audio.play('confirm');
        msg = ok;
      } else {
        g.audio.play('deny');
        msg = t(r === 'poor' ? 'trav.trade.poor' : r === 'sold' ? 'trav.trade.sold' : r === 'broke' ? 'trav.trade.broke' : 'trav.trade.short');
      }
      render();
    };
    const leave = () => {
      g.audio.play('click');
      done();
    };
    const render = () => {
      const keys = g.focus.keys();
      acts.clear();
      const buys = stock.buy
        .map((o, i) => {
          const what = t(`trav.offer.${o.id}`);
          return btn(`b${i}`, `${escapeHtml(what)} <span class="cost">${o.left > 0 ? costText(o.cost) : escapeHtml(t('trav.trade.sold'))}</span>`, () => verdict(buyLot(stock, c.stocks, i), t('trav.trade.bought', { what })), o.left > 0 && canAfford(c.stocks, o.cost));
        })
        .join('');
      const sells = stock.sell
        .map((o, i) => {
          const what = t(`trav.offer.sell.${o.id}`);
          const pay = o.pay.scrap ?? 0;
          return btn(`s${i}`, `${escapeHtml(what)} <span class="cost">+${costText(o.pay)}</span>`, () => verdict(sellLot(stock, c.stocks, i), t('trav.trade.sellDone', { what, pay })), canAfford(c.stocks, o.take) && stock.purse >= pay);
        })
        .join('');
      const have = (['scrap', 'rations', 'fuel', 'medicine', 'parts', 'tech'] as const).map((k) => `${LABEL[k]} ${k === 'fuel' ? c.stocks[k].toFixed(1) : whole(c.stocks[k])}`).join(' · ');
      this.root.innerHTML = `<div class="enc panel paper" style="width:min(820px,95%)"><h2>${escapeHtml(t('trav.trade.title', { who: tv.name }))}</h2>
        <p>${escapeHtml(t('trav.trade.text', { line: msg }))}</p>
        <div class="mutedtxt">${escapeHtml(have)}</div>
        <h3 style="margin-top:8px">${escapeHtml(t('trav.trade.buy'))}</h3><div class="card"><div class="btns">${buys}</div></div>
        <h3 style="margin-top:8px">${escapeHtml(t('trav.trade.sell'))}</h3><div class="card"><div class="btns">${sells}</div><div class="mutedtxt" style="margin-top:4px">${escapeHtml(t('trav.trade.purse', { n: stock.purse }))}</div></div>
        <div class="btnrow" style="margin-top:12px"><button data-fid="walk">${escapeHtml(t('trav.trade.walk'))}</button></div></div>`;
      this.root.querySelectorAll<HTMLElement>('button').forEach((b) => (b.style.pointerEvents = 'auto'));
      const items: FocusItem[] = [];
      this.root.querySelectorAll<HTMLElement>('[data-fid]').forEach((el) => {
        const id = el.dataset.fid!;
        if (id === 'walk') return items.push({ el, press: leave });
        const act = acts.get(id);
        if (act) items.push({ el, press: () => act(), disabled: (el as HTMLButtonElement).disabled });
      });
      g.focus.setItems(items, keys);
    };
    render();
    g.focus.onCancel = leave;
    g.focus.cursor = [0, 0];
    g.focus.active = true;
  }

  /**
   * Night camp off: someone has stopped for the night, and the convoy decides what kind of night it is. Resting goes to dawn
   * and the Ledger; a camp is the old night (a site, the build and a raid) with the night's haul for holding it; carrying on
   * goes back to the road (`canGo`: not at the end of a single road, which has nowhere further to go).
   */
  showNightChoice(done: (choice: 'rest' | 'camp' | 'go') => void, canGo = true, hubId?: string | null) {
    const g = this.game;
    const hub = hubId ? LEGS.hubs[hubId] : null;
    const choices: { id: 'rest' | 'camp' | 'go'; label: string; sub: string }[] = [
      { id: 'rest', label: 'Rest until dawn', sub: 'Sleep by the vehicles. No raid. Supper, the dawn report and the Ledger, then roll out from here.' },
      { id: 'camp', label: 'Make camp', sub: 'Pick a site, build for three minutes, hold off a three-wave night raid. Hold out for the night\'s haul: ammunition, a rare part, medicine.' },
    ];
    if (canGo) choices.push({ id: 'go', label: 'Keep moving', sub: 'Not yet. Back on the road: the night can be driven through, and dawn comes on its own.' });
    this.vote({
      kind: 'night',
      title: (g.scene?.night ?? 0) > 0.5 ? 'Nightfall' : 'The Dusk Bell',
      text: `${hub ? hub.name + ': ' + hub.blurb + ' ' : ''}Stop here for the night?`,
      choices: choices.map((c) => ({ label: c.label, sub: c.sub })),
      wide: true,
      lead: g.campaign.lead,
      onDone: (i, overridden) => {
        if (overridden) g.campaign.axes.trust -= 1;
        done(choices[i].id);
      },
    });
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
        ${rep.haul?.length ? `<h3 style="margin-top:10px;color:#7a4a14">The night's haul</h3><div class="lines">${rep.haul.map((l) => `<div>${escapeHtml(l)}</div>`).join('')}</div>` : ''}
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
      <p>${escapeHtml(reason)} The road north is long, and it does not forgive. Pick up from the last save?</p>
      <div class="btnrow"><button data-fid="retry" ${hasSave() ? '' : 'disabled'}>Retry from the last save</button><button data-fid="new">New convoy</button><button data-fid="quit">Quit to title</button></div></div>`;
    this.root.querySelectorAll<HTMLElement>('button').forEach((b) => (b.style.pointerEvents = 'auto'));
    const q = (k: string) => this.root.querySelector<HTMLElement>(`[data-fid="${k}"]`)!;
    g.focus.setItems([
      { el: q('retry'), press: () => retry(), disabled: !hasSave() },
      { el: q('new'), press: () => g.load('New convoy', () => g.startNewGame()) },
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
      <p style="text-transform:none;letter-spacing:.01em">${lessons} lessons done: on foot, shooting, scavenging, driving, noise and dust, repairs and fuel, the map, your pack, and making camp. Out in the world, the night after the Dusk Bell is yours: rest until dawn, push on through the dark, or make camp, build for three minutes and hold off a three-wave raid for the night's haul (Settings can make the camp the rule). The illustrated guide covers that part, and the rest of the survival rules.</p>
      <div class="btnrow"><button data-fid="new">Start a new convoy</button><button data-fid="guide">Illustrated guide</button><button data-fid="again">Train again</button><button data-fid="quit">Title</button></div></div>`;
    this.root.querySelectorAll<HTMLElement>('button').forEach((b) => (b.style.pointerEvents = 'auto'));
    const q = (k: string) => this.root.querySelector<HTMLElement>(`[data-fid="${k}"]`)!;
    g.focus.setItems([
      { el: q('new'), press: () => g.load('New convoy', () => g.startNewGame()) },
      { el: q('guide'), press: () => this.showGuide(() => this.showTrainingDone(lessons), undefined, 7) },
      { el: q('again'), press: () => g.load('Training', () => g.startTraining()) },
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
      { el: q('led'), press: () => camp && this.showLedger(camp, (next) => (legById(c.legId).open ? this.game.load(legById(next).name, () => this.game.rollOut(next)) : undefined)) },
      { el: q('new'), press: () => g.load('New convoy', () => g.startNewGame()) },
      { el: q('quit'), press: () => g.toTitle() },
    ]);
    g.focus.active = true;
  }
}

function selectEndingTitle(e: EndingId) {
  return { openGate: 'an open gate', toll: 'a toll', twoWalked: 'a long walk', warlord: 'a throne', hollow: 'an empty city' }[e];
}

const mouseWord = (b: number | undefined) => (b === undefined ? 'unbound' : ['left click', 'middle click', 'right click', 'side button 1', 'side button 2'][b] ?? `button ${b + 1}`);

/** A controller's name without the vendor/product codes browsers add ("Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e ...)"). */
function padName(p: Gamepad): string {
  const name = p.id.replace(/\s*\(.*\)\s*$/, '').replace(/^[0-9a-f]{4}-[0-9a-f]{4}-/i, '').trim();
  return name || `Controller ${p.index + 1}`;
}
