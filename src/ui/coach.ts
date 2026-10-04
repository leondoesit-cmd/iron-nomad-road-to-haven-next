/** What one seat's coach card shows: the lesson, its goals, and where this seat stands. */
export interface CoachView {
  n: number;
  of: number;
  title: string;
  /** HTML: key caps are `<kbd>`. */
  body: string;
  goals: { label: string; done: boolean; others: number }[];
  color: string;
  /** Every seat has finished: the card shows its tick for a moment before the next lesson. */
  complete: boolean;
  /** Set when this seat is done and the partner is not. */
  waiting: string;
  stuck: boolean;
}

/**
 * The training cards: one per half of the screen, each in its own seat's key names and colour. They are plain DOM laid
 * over the HUD, and only change when the text does.
 */
export class CoachUI {
  private els: HTMLElement[] = [];
  private last: string[] = ['', ''];

  constructor(halves: HTMLElement[]) {
    this.els = halves.map((h) => {
      const el = document.createElement('div');
      el.className = 'coach';
      el.style.display = 'none';
      h.appendChild(el);
      return el;
    });
  }

  render(seat: number, v: CoachView) {
    const el = this.els[seat];
    if (!el) return;
    const goals = v.goals
      .map((g) => `<li class="${g.done ? 'done' : ''}"><i>${g.done ? '✔' : ''}</i>${g.label}</li>`)
      .join('');
    const html = `<div class="c-top"><span class="c-step">Lesson ${v.n} / ${v.of}</span><span class="c-bar"><i style="width:${Math.round(((v.n - 1 + (v.complete ? 1 : 0)) / v.of) * 100)}%"></i></span></div>
      <div class="c-title">${v.complete ? '✔ ' : ''}${v.title}</div>
      <div class="c-body">${v.body}</div>
      <ul class="c-goals">${goals}</ul>
      ${v.waiting ? `<div class="c-wait">${v.waiting}</div>` : ''}
      ${v.stuck ? '<div class="c-stuck">Stuck? Pause and choose <b>Skip this lesson</b>.</div>' : ''}`;
    const key = html + v.color + v.complete;
    if (this.last[seat] === key) return;
    this.last[seat] = key;
    el.style.setProperty('--pc', v.color);
    el.className = `coach${v.complete ? ' ok' : ''}`;
    el.innerHTML = html;
    el.style.display = '';
  }

  hide(seat?: number) {
    for (let i = 0; i < this.els.length; i++) {
      if (seat !== undefined && seat !== i) continue;
      this.els[i].style.display = 'none';
      this.last[i] = '';
    }
  }

  dispose() {
    for (const el of this.els) el.remove();
    this.els = [];
  }
}
