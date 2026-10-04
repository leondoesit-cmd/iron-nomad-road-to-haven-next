/**
 * The pictures for the illustrated guide: small inline SVG scenes drawn from a handful of shapes, all in the game's own
 * colours (CSS variables, so they follow the theme). Every builder returns one `<svg>` string at a fixed viewBox.
 */

const AMBER = 'var(--amber)';
const PAPER = 'var(--paper)';
const DIM = 'var(--paper-dim)';
const INK = '#15110d';
const P1 = 'var(--p1)';
const P2 = 'var(--p2)';
const RED = 'var(--red)';
const GREEN = 'var(--green)';

const svg = (w: number, h: number, body: string, label: string) =>
  `<svg class="gart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${label}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;

const text = (x: number, y: number, s: string, o: { size?: number; fill?: string; anchor?: 'start' | 'middle' | 'end'; weight?: number; spacing?: number; mono?: boolean } = {}) =>
  `<text x="${x}" y="${y}" font-size="${o.size ?? 13}" fill="${o.fill ?? PAPER}" text-anchor="${o.anchor ?? 'start'}" font-weight="${o.weight ?? 500}" letter-spacing="${o.spacing ?? 0.6}"${o.mono ? ' font-family="var(--mono)"' : ''}>${s}</text>`;

const defs = `<defs>
  <linearGradient id="gsky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a1d12"/><stop offset="0.6" stop-color="#7a4a22"/><stop offset="1" stop-color="#d98a3a"/></linearGradient>
  <linearGradient id="gnight" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a0b18"/><stop offset="1" stop-color="#2b2236"/></linearGradient>
  <marker id="garrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${AMBER}"/></marker>
  <marker id="garrowr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${RED}"/></marker>
</defs>`;

// ------------------------------------------------------------------ small parts

/** A moped seen from the side, rider on it, `s` scale, centred on the ground contact line. */
export function moped(x: number, y: number, s: number, color: string, flip = false): string {
  return `<g transform="translate(${x} ${y}) scale(${flip ? -s : s} ${s})">
    <circle cx="-22" cy="-9" r="9" fill="${INK}" stroke="${PAPER}" stroke-width="2.5"/>
    <circle cx="22" cy="-9" r="9" fill="${INK}" stroke="${PAPER}" stroke-width="2.5"/>
    <path d="M-22 -9 L-12 -24 H6 L22 -9 M-2 -24 L-5 -34 H-13" fill="none" stroke="${color}" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="-14" y="-30" width="20" height="6" rx="3" fill="${PAPER}"/>
    <circle cx="-6" cy="-52" r="6.5" fill="${PAPER}"/>
    <path d="M-6 -45 L-8 -31 M-6 -44 L6 -36" stroke="${color}" stroke-width="6" stroke-linecap="round"/>
  </g>`;
}

/** A buggy from the side: roll cage, big tyres, a gun on the back. */
export function buggy(x: number, y: number, s: number, color: string, flip = false): string {
  return `<g transform="translate(${x} ${y}) scale(${flip ? -s : s} ${s})">
    <rect x="-46" y="-30" width="92" height="16" rx="5" fill="${color}"/>
    <path d="M-30 -30 L-22 -52 H12 L26 -30" fill="none" stroke="${PAPER}" stroke-width="3.5" stroke-linejoin="round"/>
    <path d="M-22 -52 L-22 -30 M-6 -52 L-6 -30" stroke="${PAPER}" stroke-width="2"/>
    <rect x="30" y="-40" width="22" height="4" fill="${DIM}"/>
    <circle cx="-30" cy="-12" r="13" fill="${INK}" stroke="${PAPER}" stroke-width="3"/>
    <circle cx="30" cy="-12" r="13" fill="${INK}" stroke="${PAPER}" stroke-width="3"/>
    <circle cx="-30" cy="-12" r="4" fill="${PAPER}"/><circle cx="30" cy="-12" r="4" fill="${PAPER}"/>
  </g>`;
}

/** An infected walker, arms out. */
export function walker(x: number, y: number, s = 1, color = '#7a8f58'): string {
  return `<g transform="translate(${x} ${y}) scale(${s})" stroke-linecap="round">
    <circle cx="0" cy="-58" r="7" fill="${color}"/>
    <path d="M0 -50 L0 -26 M0 -26 L-7 0 M0 -26 L8 0 M0 -46 L-16 -42 M0 -46 L16 -40" stroke="${color}" stroke-width="5" fill="none"/>
  </g>`;
}

/** A survivor, standing. */
export function person(x: number, y: number, s: number, color: string, pose: 'stand' | 'down' | 'aim' = 'stand'): string {
  if (pose === 'down')
    return `<g transform="translate(${x} ${y}) scale(${s})" stroke-linecap="round"><circle cx="-26" cy="-8" r="7" fill="${PAPER}"/><path d="M-18 -7 L22 -7 M22 -7 L36 -2 M22 -7 L34 -14" stroke="${color}" stroke-width="6" fill="none"/></g>`;
  return `<g transform="translate(${x} ${y}) scale(${s})" stroke-linecap="round">
    <circle cx="0" cy="-58" r="7" fill="${PAPER}"/>
    <path d="M0 -50 L0 -26 M0 -26 L-7 0 M0 -26 L8 0" stroke="${color}" stroke-width="6" fill="none"/>
    ${pose === 'aim' ? `<path d="M0 -44 L22 -44 L38 -44" stroke="${color}" stroke-width="5" fill="none"/><rect x="22" y="-48" width="22" height="5" fill="${DIM}"/>` : `<path d="M0 -44 L-10 -30 M0 -44 L10 -30" stroke="${color}" stroke-width="5" fill="none"/>`}
  </g>`;
}

/** A keycap or button face. */
export function cap(x: number, y: number, label: string, o: { fill?: string; w?: number } = {}): string {
  const w = o.w ?? Math.max(30, label.length * 9 + 16);
  return `<g><rect x="${x - w / 2}" y="${y - 15}" width="${w}" height="30" rx="6" fill="${o.fill ?? 'rgba(0,0,0,.55)'}" stroke="${AMBER}" stroke-width="2"/>${text(x, y + 5, label, { anchor: 'middle', size: 15, fill: PAPER, weight: 600 })}</g>`;
}

const crate = (x: number, y: number, s = 1) =>
  `<g transform="translate(${x} ${y}) scale(${s})"><rect x="-22" y="-30" width="44" height="30" fill="#7a5a34" stroke="${INK}" stroke-width="2"/><path d="M-22 -30 L22 0 M22 -30 L-22 0" stroke="#4a3520" stroke-width="3"/><rect x="-22" y="-30" width="44" height="6" fill="#9a7444"/></g>`;

const wrench = (x: number, y: number, s = 1, c = PAPER) =>
  `<g transform="translate(${x} ${y}) scale(${s}) rotate(-35)" fill="none" stroke="${c}" stroke-width="5" stroke-linecap="round"><path d="M0 18 L0 -10"/><path d="M-9 -22 A11 11 0 1 0 9 -22 L5 -14 H-5 Z" fill="${c}" stroke="none"/></g>`;

const jerrycan = (x: number, y: number, s = 1, c = '#c2452d') =>
  `<g transform="translate(${x} ${y}) scale(${s})"><rect x="-14" y="-24" width="28" height="30" rx="4" fill="${c}" stroke="${INK}" stroke-width="2"/><path d="M-6 -24 L-6 -32 H6 L6 -24" fill="none" stroke="${c}" stroke-width="4"/><path d="M-14 -16 L14 2 M-14 -4 L14 -4" stroke="${INK}" stroke-width="2" opacity=".5"/></g>`;

const crowbar = (x: number, y: number, s = 1) =>
  `<g transform="translate(${x} ${y}) scale(${s})" fill="none" stroke="${PAPER}" stroke-width="5" stroke-linecap="round"><path d="M-16 14 L12 -14 Q18 -22 8 -26"/></g>`;

const cross = (x: number, y: number, s = 1, c = GREEN) =>
  `<g transform="translate(${x} ${y}) scale(${s})"><rect x="-6" y="-18" width="12" height="36" rx="3" fill="${c}"/><rect x="-18" y="-6" width="36" height="12" rx="3" fill="${c}"/></g>`;

const tent = (x: number, y: number, s = 1) =>
  `<g transform="translate(${x} ${y}) scale(${s})"><path d="M-26 0 L0 -34 L26 0 Z" fill="#6a4a2a" stroke="${INK}" stroke-width="2"/><path d="M0 -34 L0 0" stroke="${INK}" stroke-width="2"/><path d="M-10 0 L0 -14 L10 0" fill="${INK}"/></g>`;

/** A numbered pin used to tie a picture to the text beside it. */
export const pin = (x: number, y: number, n: number | string) =>
  `<g><circle cx="${x}" cy="${y}" r="13" fill="${AMBER}" stroke="${INK}" stroke-width="2"/>${text(x, y + 5, String(n), { anchor: 'middle', size: 15, fill: INK, weight: 700, spacing: 0 })}</g>`;

/** A progress ring, `frac` of the way round. */
function ring(x: number, y: number, r: number, frac: number, color = AMBER): string {
  const a = Math.PI * 2 * Math.min(0.999, frac);
  const ex = x + Math.sin(a) * r;
  const ey = y - Math.cos(a) * r;
  return `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="rgba(0,0,0,.6)" stroke-width="7"/>${
    frac > 0 ? `<path d="M ${x} ${y - r} A ${r} ${r} 0 ${a > Math.PI ? 1 : 0} 1 ${ex.toFixed(1)} ${ey.toFixed(1)}" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round"/>` : ''
  }`;
}

// ------------------------------------------------------------------ 1. the road to Haven

export function artRoad(): string {
  let skyline = '';
  const blocks = [
    [250, 42, 36],
    [284, 58, 30],
    [312, 34, 44],
    [354, 70, 28],
    [380, 46, 34],
    [412, 62, 30],
  ];
  for (const [x, h, w] of blocks) {
    skyline += `<rect x="${x}" y="${150 - h}" width="${w}" height="${h}" fill="#241a12" stroke="${AMBER}" stroke-width="1.2"/>`;
    for (let wy = 150 - h + 8; wy < 142; wy += 12) for (let wx = x + 6; wx < x + w - 6; wx += 10) skyline += `<rect x="${wx}" y="${wy}" width="4" height="5" fill="${(wx + wy) % 3 ? '#ffd48a' : '#493626'}"/>`;
  }
  const body = `${defs}
    <rect width="640" height="400" fill="url(#gsky)"/>
    <circle cx="470" cy="118" r="44" fill="#ffcf7a" opacity=".85"/>
    <path d="M0 150 L120 128 L200 146 L290 120 L360 150 L470 126 L560 148 L640 132 L640 400 L0 400 Z" fill="#3a2616"/>
    ${skyline}
    ${text(333, 62, 'HAVEN', { anchor: 'middle', size: 22, fill: AMBER, weight: 700, spacing: 7 })}
    <path d="M333 70 L333 82" stroke="${AMBER}" stroke-width="2"/>
    <path d="M0 400 L270 152 L396 152 L640 400 Z" fill="#2a2018"/>
    <path d="M333 154 L333 400" stroke="${AMBER}" stroke-width="5" stroke-dasharray="14 18" opacity=".7"/>
    ${moped(206, 330, 2.1, P1)}
    ${moped(430, 352, 2.3, P2)}
    <path d="M520 260 L520 180" stroke="${AMBER}" stroke-width="5" marker-end="url(#garrow)"/>
    ${text(536, 226, 'NORTH', { fill: AMBER, size: 15, weight: 600, spacing: 3 })}
    ${text(24, 36, 'THE ROAD TO HAVEN', { size: 15, fill: PAPER, spacing: 4, weight: 600 })}`;
  return svg(640, 400, body, 'Two scavengers on mopeds drive a ruined highway toward the city of Haven.');
}

// ------------------------------------------------------------------ 2. a day

export function artDay(): string {
  const cx = 320;
  const cy = 205;
  const R = 130;
  const nodes = [
    { n: '1', t: 'DAWN LEDGER', s: 'repair · build · hire' },
    { n: '2', t: 'ROAM', s: 'drive · scavenge' },
    { n: '3', t: 'DUSK BELL', s: 'find a place' },
    { n: '4', t: 'CAMP', s: 'build defences' },
    { n: '5', t: 'NIGHT RAID', s: 'three waves' },
  ];
  let g = '';
  const pos = nodes.map((_, i) => {
    const a = ((-90 + i * 72) * Math.PI) / 180;
    return [cx + Math.cos(a) * R * 1.55, cy + Math.sin(a) * R];
  });
  pos.forEach(([x, y], i) => {
    const [nx, ny] = pos[(i + 1) % pos.length];
    const mx = (x + nx) / 2 + (x - cx) * 0.0;
    const my = (y + ny) / 2;
    // Pull the arc toward the middle of the ring, then trim it to leave room for the discs.
    const dx = nx - x;
    const dy = ny - y;
    const len = Math.hypot(dx, dy);
    const ux = dx / len;
    const uy = dy / len;
    const sx = x + ux * 46;
    const sy = y + uy * 46;
    const ex = nx - ux * 50;
    const ey = ny - uy * 50;
    const qx = mx + (cx - mx) * 0.22;
    const qy = my + (cy - my) * 0.22;
    g += `<path d="M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${qx.toFixed(1)} ${qy.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}" fill="none" stroke="${AMBER}" stroke-width="3" marker-end="url(#garrow)"/>`;
  });
  pos.forEach(([x, y], i) => {
    const night = i >= 3;
    g += `<circle cx="${x}" cy="${y}" r="38" fill="${night ? '#16162a' : '#2a1d12'}" stroke="${AMBER}" stroke-width="2.5"/>`;
    g += pin(x, y - 8, nodes[i].n);
    g += text(x, y + 20, nodes[i].t, { anchor: 'middle', size: 10.5, weight: 600, spacing: 0.8 });
    g += text(x, y + 58, nodes[i].s, { anchor: 'middle', size: 11.5, fill: DIM, spacing: 0.2 });
  });
  const body = `${defs}<rect width="640" height="400" fill="#17110c"/>
    <circle cx="${cx}" cy="${cy}" r="58" fill="url(#gsky)" opacity=".9"/>
    <path d="M${cx - 58} ${cy + 20} Q${cx} ${cy - 40} ${cx + 58} ${cy + 20}" fill="none" stroke="#ffd48a" stroke-width="3" stroke-dasharray="4 5"/>
    ${text(cx, cy - 4, 'ONE DAY', { anchor: 'middle', size: 16, weight: 700, spacing: 3 })}
    ${text(cx, cy + 16, 'then again', { anchor: 'middle', size: 12, fill: DIM })}
    ${g}`;
  return svg(640, 400, body, 'The daily loop: Dawn Ledger, roam, Dusk Bell, camp, night raid, and back to the Ledger.');
}

// ------------------------------------------------------------------ 3. the screen

export function artHud(): string {
  const body = `${defs}
    <rect width="640" height="400" fill="url(#gsky)"/>
    <path d="M0 210 L90 190 L170 206 L260 184 L330 208 L430 188 L520 206 L640 192 L640 400 L0 400 Z" fill="#3a2616"/>
    <path d="M250 400 L300 214 L346 214 L420 400 Z" fill="#2a2018"/>
    ${moped(318, 336, 1.9, P1)}
    ${walker(470, 262, 1)}
    <rect x="0" y="0" width="640" height="400" fill="none" stroke="${INK}" stroke-width="6"/>
    <!-- 1 noise meter -->
    <g><rect x="16" y="16" width="120" height="10" fill="rgba(0,0,0,.6)" stroke="${AMBER}" stroke-width="1.5"/><rect x="17" y="17" width="64" height="8" fill="${AMBER}"/>${text(144, 26, '41', { size: 13, mono: true })}${text(16, 42, 'NOISE', { size: 11, spacing: 2 })}</g>
    ${pin(188, 22, 1)}
    <!-- 2 compass + minimap + clock -->
    <g><rect x="436" y="14" width="190" height="20" fill="rgba(0,0,0,.55)" stroke="${AMBER}" stroke-width="1.2"/>${text(531, 29, 'W    NW    N    NE    E', { anchor: 'middle', size: 11, mono: true })}<path d="M531 14 L531 34" stroke="${AMBER}" stroke-width="2"/>
      <circle cx="592" cy="88" r="42" fill="rgba(0,0,0,.6)" stroke="${AMBER}" stroke-width="2"/><path d="M592 88 L592 60" stroke="${AMBER}" stroke-width="3"/><circle cx="592" cy="88" r="4" fill="${P1}"/><circle cx="574" cy="110" r="3" fill="${GREEN}"/><circle cx="612" cy="70" r="3" fill="${RED}"/>
      ${text(530, 56, '10:42', { anchor: 'middle', size: 14, mono: true })}</g>
    ${pin(420, 24, 2)}
    <!-- 3 vitals -->
    <g><rect x="16" y="298" width="130" height="10" fill="rgba(0,0,0,.6)" stroke="${GREEN}" stroke-width="1.5"/><rect x="17" y="299" width="96" height="8" fill="${GREEN}"/>
      <rect x="16" y="314" width="130" height="5" fill="rgba(0,0,0,.6)"/><rect x="16" y="314" width="84" height="5" fill="#4aa8ff"/>
      <rect x="16" y="326" width="130" height="8" fill="rgba(0,0,0,.6)" stroke="${AMBER}" stroke-width="1.2"/><rect x="17" y="327" width="52" height="6" fill="${AMBER}"/>
      ${text(16, 354, '24', { size: 26, mono: true, weight: 700 })}${text(52, 354, 'km/h', { size: 12, fill: DIM })}${text(16, 290, 'MOPED', { size: 11, spacing: 2 })}</g>
    ${pin(166, 312, 3)}
    <!-- 4 weapon -->
    <g>${text(626, 330, '9MM PISTOL', { anchor: 'end', size: 11, spacing: 2 })}${text(626, 362, '12', { anchor: 'end', size: 30, mono: true, weight: 700 })}${text(626, 378, '/ 90', { anchor: 'end', size: 12, mono: true, fill: DIM })}</g>
    ${pin(540, 346, 4)}
    <!-- 5 prompt -->
    <g><rect x="206" y="352" width="228" height="30" rx="4" fill="rgba(0,0,0,.65)" stroke="${AMBER}" stroke-width="1.5"/>${cap(228, 367, 'A', { w: 26 })}${text(246, 372, 'Hold to search the shelves', { size: 12 })}<rect x="206" y="379" width="130" height="3" fill="${AMBER}"/></g>
    ${pin(190, 367, 5)}
    <!-- 6 reticle -->
    <g stroke="${PAPER}" stroke-width="2" fill="none"><circle cx="400" cy="226" r="9"/><path d="M400 210 V216 M400 236 V242 M384 226 H390 M410 226 H416"/></g>
    ${pin(428, 212, 6)}
    <!-- 7 tip -->
    <g><rect x="16" y="150" width="170" height="38" fill="#e9dfc7" stroke="${AMBER}" stroke-width="2"/><rect x="16" y="150" width="5" height="38" fill="${AMBER}"/>${text(28, 166, 'Dust is Signature:', { size: 11, fill: '#261c10' })}${text(28, 180, 'faster means a longer plume.', { size: 11, fill: '#261c10' })}</g>
    ${pin(198, 169, 7)}`;
  return svg(640, 400, body, 'A mock of one player’s screen with the noise meter, compass and minimap, vitals, weapon, prompt, reticle and tips numbered 1 to 7.');
}

// ------------------------------------------------------------------ 4 and 5. the gamepad

export type PadPart = 'LT' | 'RT' | 'LB' | 'RB' | 'LS' | 'RS' | 'DP' | 'A' | 'B' | 'X' | 'Y';

/** Where each part of the pad sits, in the pad's own drawing space, and which margin its label goes in. */
const PAD_AT: Record<PadPart, { x: number; y: number; side: 'l' | 'r' }> = {
  LT: { x: 234, y: 70, side: 'l' },
  LB: { x: 232, y: 100, side: 'l' },
  LS: { x: 232, y: 170, side: 'l' },
  DP: { x: 284, y: 228, side: 'l' },
  RT: { x: 406, y: 70, side: 'r' },
  RB: { x: 412, y: 100, side: 'r' },
  Y: { x: 410, y: 148, side: 'r' },
  X: { x: 386, y: 172, side: 'r' },
  B: { x: 434, y: 172, side: 'r' },
  A: { x: 410, y: 196, side: 'r' },
  RS: { x: 366, y: 236, side: 'r' },
};
/** The pad is drawn at 0.72 round the middle of the picture, leaving room for labels on both sides. */
const PAD_SCALE = 0.72;
const padPoint = (x: number, y: number): [number, number] => [320 + (x - 320) * PAD_SCALE, 196 + (y - 196) * PAD_SCALE];

export interface PadLabel {
  part: PadPart;
  title: string;
  /** Second line; `\n` breaks it further. */
  sub?: string;
}

/** The controller with the used buttons lit and each one named in the margins. */
export function artPad(labels: PadLabel[], caption: string): string {
  const used = new Set(labels.map((l) => l.part));
  const lit = (p: PadPart) => (used.has(p) ? AMBER : 'rgba(233,223,199,.22)');
  const fill = (p: PadPart) => (used.has(p) ? 'rgba(255,180,84,.28)' : 'rgba(0,0,0,.35)');
  let pad = `<g transform="translate(320 196) scale(${PAD_SCALE}) translate(-320 -196)">
    <path d="M205 112 C250 96 390 96 435 112 C480 128 508 215 504 285 C501 322 458 330 436 298 C420 275 405 262 380 262 L260 262 C235 262 220 275 204 298 C182 330 139 322 136 285 C132 215 160 128 205 112 Z" fill="#241c14" stroke="${PAPER}" stroke-width="3.5"/>
    <rect x="202" y="62" width="64" height="16" rx="7" fill="${fill('LT')}" stroke="${lit('LT')}" stroke-width="3"/>
    <rect x="374" y="62" width="64" height="16" rx="7" fill="${fill('RT')}" stroke="${lit('RT')}" stroke-width="3"/>
    <rect x="200" y="94" width="64" height="12" rx="5" fill="${fill('LB')}" stroke="${lit('LB')}" stroke-width="3"/>
    <rect x="380" y="94" width="64" height="12" rx="5" fill="${fill('RB')}" stroke="${lit('RB')}" stroke-width="3"/>
    <circle cx="232" cy="170" r="24" fill="${fill('LS')}" stroke="${lit('LS')}" stroke-width="3.5"/><circle cx="232" cy="170" r="11" fill="${lit('LS')}"/>
    <circle cx="366" cy="236" r="24" fill="${fill('RS')}" stroke="${lit('RS')}" stroke-width="3.5"/><circle cx="366" cy="236" r="11" fill="${lit('RS')}"/>
    <path d="M276 208 h16 v-16 h16 v16 h16 v16 h-16 v16 h-16 v-16 h-16 Z" fill="${fill('DP')}" stroke="${lit('DP')}" stroke-width="3"/>`;
  for (const p of ['Y', 'X', 'B', 'A'] as const) {
    const { x, y } = PAD_AT[p];
    pad += `<circle cx="${x}" cy="${y}" r="14" fill="${fill(p)}" stroke="${lit(p)}" stroke-width="3"/>${text(x, y + 5, p, { anchor: 'middle', size: 15, weight: 700, fill: used.has(p) ? AMBER : DIM, spacing: 0 })}`;
  }
  pad += '</g>';
  // Labels in two columns, top to bottom by where their part sits, each with a leader to the part.
  let out = '';
  for (const side of ['l', 'r'] as const) {
    const col = labels.filter((l) => PAD_AT[l.part].side === side).sort((a, b) => PAD_AT[a.part].y - PAD_AT[b.part].y || PAD_AT[a.part].x - PAD_AT[b.part].x);
    const heights = col.map((l) => 20 + (l.sub ? l.sub.split('\n').length * 14 : 0));
    const gap = 9;
    const total = heights.reduce((a, b) => a + b, 0) + gap * Math.max(0, col.length - 1);
    let y = Math.max(34, 190 - total / 2);
    col.forEach((l, i) => {
      const [ax, ay] = padPoint(PAD_AT[l.part].x, PAD_AT[l.part].y);
      const tx = side === 'l' ? 178 : 462;
      const anchor = side === 'l' ? 'end' : 'start';
      const ly = y + 14;
      out += `<path d="M${tx + (side === 'l' ? 6 : -6)} ${ly - 5} L${tx + (side === 'l' ? 16 : -16)} ${ly - 5} L${ax.toFixed(1)} ${ay.toFixed(1)}" fill="none" stroke="${AMBER}" stroke-width="1.5" opacity=".75"/><circle cx="${ax.toFixed(1)}" cy="${ay.toFixed(1)}" r="3" fill="${AMBER}"/>`;
      out += text(tx, ly, l.title, { anchor, size: 14, weight: 600 });
      (l.sub ?? '')
        .split('\n')
        .filter(Boolean)
        .forEach((line, k) => (out += text(tx, ly + 14 + k * 14, line, { anchor, size: 11.5, fill: DIM, spacing: 0.1 })));
      y += heights[i] + gap;
    });
  }
  return svg(640, 400, `${defs}<rect width="640" height="400" fill="#17110c"/>${text(320, 386, caption, { anchor: 'middle', size: 12, fill: DIM, spacing: 2 })}${pad}${out}`, caption);
}

export const PAD_FOOT: PadLabel[] = [
  { part: 'LT', title: 'AIM', sub: 'hold: down the sights' },
  { part: 'LB', title: 'SWAP', sub: 'gun · wrench\ncrowbar · can' },
  { part: 'LS', title: 'MOVE' },
  { part: 'DP', title: 'D-PAD', sub: '↑ ping · → map\n← pack · ↓ drugs' },
  { part: 'RT', title: 'FIRE' },
  { part: 'RB', title: 'MELEE', sub: 'hold: takedown' },
  { part: 'Y', title: 'VEHICLE', sub: 'hold: get in\ntap: switch view' },
  { part: 'X', title: 'RELOAD', sub: 'at a car: stow a part' },
  { part: 'B', title: 'CROUCH' },
  { part: 'A', title: 'INTERACT', sub: 'hold: loot, fix, fuel\ntap: jump' },
  { part: 'RS', title: 'LOOK', sub: 'press: reset camera' },
];

export const PAD_DRIVE: PadLabel[] = [
  { part: 'LT', title: 'BRAKE', sub: 'then reverse' },
    { part: 'LS', title: 'STEER' },
  { part: 'DP', title: 'D-PAD', sub: '→ map · ↑ ping' },
  { part: 'RT', title: 'THROTTLE' },
  { part: 'RB', title: 'FIRE', sub: 'front gun, or sidearm' },
  { part: 'Y', title: 'EXIT', sub: 'hold · at speed: bail' },
  { part: 'X', title: 'HORN', sub: 'hold: siren' },
  { part: 'B', title: 'LIGHTS', sub: 'hold: engine off' },
  { part: 'A', title: 'HANDBRAKE' },
  { part: 'RS', title: 'LOOK', sub: 'stick: free look\npress: look back' },
];

// ------------------------------------------------------------------ 6. hold to do

export function artHold(): string {
  const icons: [string, string][] = [
    [crate(0, 0, 0.9), 'Search'],
    [wrench(0, -10, 1.1), 'Repair'],
    [jerrycan(0, 6, 1), 'Refuel'],
    [crowbar(0, -8, 1.2), 'Strip'],
    [cross(0, -8, 0.8), 'Revive'],
    [tent(0, 10, 1), 'Camp'],
  ];
  let row = '';
  icons.forEach(([ic, label], i) => {
    const x = 70 + i * 100;
    row += `<g transform="translate(${x} 318)"><rect x="-38" y="-48" width="76" height="86" rx="6" fill="rgba(0,0,0,.4)" stroke="${AMBER}" stroke-width="1.5"/><g transform="translate(0 4)">${ic}</g>${text(0, 30, label.toUpperCase(), { anchor: 'middle', size: 11, spacing: 1.5 })}</g>`;
  });
  const body = `${defs}<rect width="640" height="400" fill="#17110c"/>
    ${text(160, 36, 'TAP', { anchor: 'middle', size: 18, weight: 700, spacing: 5, fill: DIM })}
    ${cap(160, 100, 'A', { w: 52 })}
    <path d="M160 130 Q200 154 240 130" fill="none" stroke="${DIM}" stroke-width="2.5" stroke-dasharray="3 5"/>
    <path d="M90 190 q70 -70 140 0" fill="none" stroke="${PAPER}" stroke-width="2" opacity="0"/>
    ${person(160, 196, 0.9, P1)}
    <path d="M160 126 L160 150" stroke="${DIM}" stroke-width="0"/>
    ${text(160, 224, 'a hop · nothing in reach', { anchor: 'middle', size: 12, fill: DIM })}
    <path d="M320 24 L320 232" stroke="${AMBER}" stroke-width="1.5" stroke-dasharray="4 6" opacity=".6"/>
    ${text(480, 36, 'HOLD', { anchor: 'middle', size: 18, weight: 700, spacing: 5, fill: AMBER })}
    ${[0.25, 0.5, 0.75, 1]
      .map((f, i) => `<g>${ring(386 + i * 62, 102, 22, f)}${cap(386 + i * 62, 102, 'A', { w: 28 })}</g>`)
      .join('')}
    <path d="M370 142 L580 142" stroke="${AMBER}" stroke-width="3" marker-end="url(#garrow)"/>
    ${text(480, 164, 'keep holding until the ring closes', { anchor: 'middle', size: 12, fill: DIM })}
    ${crate(480, 226, 1.4)}
    ${text(480, 246, 'search · fix · pour · strip · revive · camp', { anchor: 'middle', size: 12 })}
    <path d="M24 262 H616" stroke="${PANEL_LINE}" stroke-width="1"/>
    ${row}`;
  return svg(640, 400, body, 'Tap A to jump; hold A until the ring fills to search, repair, refuel, strip a car, revive a partner or make camp.');
}
const PANEL_LINE = 'rgba(255,180,84,.32)';

// ------------------------------------------------------------------ 7. noise and dust

export function artNoise(): string {
  const bars: [string, number, string][] = [
    ['Walking, crouching', 0.12, GREEN],
    ['Engine, slow', 0.3, '#c8d14a'],
    ['Sprinting · searching', 0.5, AMBER],
    ['Engine, fast (plume)', 0.66, '#ff8a3a'],
    ['Horn · night headlights', 0.82, '#ff6a3a'],
    ['Gunshots · siren', 1, RED],
  ];
  const meter = bars
    .map(([label, v, c], i) => {
      const y = 244 + i * 22;
      return `${text(24, y + 11, label, { size: 12.5 })}<rect x="214" y="${y}" width="210" height="13" fill="rgba(0,0,0,.55)" stroke="${PANEL_LINE}"/><rect x="214" y="${y}" width="${210 * v}" height="13" fill="${c}"/>`;
    })
    .join('');
  const body = `${defs}<rect width="640" height="400" fill="#17110c"/>
    <rect x="0" y="0" width="640" height="224" fill="url(#gsky)" opacity=".55"/>
    <path d="M0 224 H640" stroke="${AMBER}" stroke-width="2"/>
    <!-- dust, seen by raiders -->
    ${moped(120, 190, 1.6, P1)}
    <path d="M70 176 Q10 160 6 150 Q40 120 90 150 Z" fill="#c9a36a" opacity=".55"/>
    <path d="M70 172 Q20 150 18 140 Q56 110 84 146 Z" fill="#c9a36a" opacity=".5"/>
    ${buggy(310, 190, 1.2, '#7a2a22', true)}
    <path d="M230 176 L262 160" stroke="${RED}" stroke-width="2" stroke-dasharray="4 4"/>
    ${text(210, 80, 'DUST', { anchor: 'middle', size: 18, weight: 700, spacing: 5, fill: '#e0b36a' })}
    ${text(210, 100, 'raiders see it from far away', { anchor: 'middle', size: 12.5, fill: DIM })}
    <!-- noise, heard by the dead -->
    <g fill="none" stroke="${RED}" stroke-width="2" opacity=".75"><circle cx="540" cy="150" r="22"/><circle cx="540" cy="150" r="42" opacity=".6"/><circle cx="540" cy="150" r="64" opacity=".35"/></g>
    ${person(540, 196, 0.9, P2, 'aim')}
    ${walker(436, 200, 0.95)}${walker(468, 205, 0.85)}
    ${text(530, 52, 'NOISE', { anchor: 'middle', size: 18, weight: 700, spacing: 5, fill: '#ff8a6a' })}
    ${text(530, 72, 'the infected hear it in cities', { anchor: 'middle', size: 12.5, fill: DIM })}
    ${meter}
    ${text(446, 262, 'The meter in your', { size: 12.5, fill: DIM })}
    ${text(446, 278, 'top-left corner shows', { size: 12.5, fill: DIM })}
    ${text(446, 294, 'what you give off right', { size: 12.5, fill: DIM })}
    ${text(446, 310, 'now. Park and walk to', { size: 12.5, fill: DIM })}
    ${text(446, 326, 'stay quiet.', { size: 12.5, fill: DIM })}`;
  return svg(640, 400, body, 'Engines leave dust that raiders see; gunshots, horns and sprinting make noise that the infected hear. A scale ranks how loud each action is.');
}

// ------------------------------------------------------------------ 8. car care

export function artCar(): string {
  const body = `${defs}<rect width="640" height="400" fill="#17110c"/>
    <path d="M0 214 H640" stroke="${AMBER}" stroke-width="2"/>
    ${buggy(320, 214, 3.1, P1)}
    <rect x="390" y="130" width="58" height="34" rx="5" fill="#2c2018" stroke="${AMBER}" stroke-width="2"/>${[0, 1, 2, 3, 4].map((i) => `<path d="M${398 + i * 11} 134 V160" stroke="${AMBER}" stroke-width="2" opacity=".7"/>`).join('')}
    <rect x="186" y="132" width="56" height="30" rx="5" fill="#8a3322" stroke="${PAPER}" stroke-width="2"/><rect x="204" y="124" width="18" height="8" fill="${PAPER}"/>
    <path d="M424 130 L456 84" stroke="${AMBER}" stroke-width="1.6"/>${pin(462,76,1)}
    <path d="M214 132 L176 86" stroke="${AMBER}" stroke-width="1.6"/>${pin(170,76,2)}
    <path d="M230 202 L150 244" stroke="${AMBER}" stroke-width="1.6"/>${pin(142, 250, 3)}
    <path d="M300 160 L322 76" stroke="${AMBER}" stroke-width="1.6"/>${pin(324, 66, 4)}
    <path d="M24 258 H616" stroke="${PANEL_LINE}"/>
    <g transform="translate(110 338)"><rect x="-56" y="-48" width="112" height="96" rx="6" fill="rgba(0,0,0,.4)" stroke="${AMBER}" stroke-width="1.5"/>${wrench(0, -6, 1.5)}${text(0, 34, 'WRENCH', { anchor: 'middle', size: 13, weight: 600, spacing: 2 })}${text(0, 44, '', {})}</g>
    <g transform="translate(320 338)"><rect x="-56" y="-48" width="112" height="96" rx="6" fill="rgba(0,0,0,.4)" stroke="${AMBER}" stroke-width="1.5"/>${crowbar(0, -6, 1.7)}${text(0, 34, 'CROWBAR', { anchor: 'middle', size: 13, weight: 600, spacing: 2 })}</g>
    <g transform="translate(530 338)"><rect x="-56" y="-48" width="112" height="96" rx="6" fill="rgba(0,0,0,.4)" stroke="${AMBER}" stroke-width="1.5"/>${jerrycan(0, 10, 1.5)}${text(0, 34, 'JERRYCAN', { anchor: 'middle', size: 13, weight: 600, spacing: 2 })}</g>
    ${text(110, 280, 'hold A at the car: repair', { anchor: 'middle', size: 11.5, fill: DIM })}
    ${text(320, 280, 'hold A on a wreck: strip parts', { anchor: 'middle', size: 11.5, fill: DIM })}
    ${text(530, 280, 'hold A: siphon · pour', { anchor: 'middle', size: 11.5, fill: DIM })}`;
  return svg(640, 400, body, 'A buggy with four numbered parts, and the three belt tools: wrench, crowbar and jerrycan.');
}

// ------------------------------------------------------------------ 9. camp

export function artCamp(): string {
  const post = (x: number, y: number, a: number) =>
    `<g transform="translate(${x} ${y})"><path d="M0 0 L${Math.cos(a - 0.5) * 70} ${Math.sin(a - 0.5) * 70} L${Math.cos(a + 0.5) * 70} ${Math.sin(a + 0.5) * 70} Z" fill="rgba(255,180,84,.16)"/><path d="M0 -9 L8 6 H-8 Z" fill="${AMBER}" stroke="${INK}" stroke-width="1.5"/></g>`;
  const wall = (x1: number, y1: number, x2: number, y2: number) => `<path d="M${x1} ${y1} L${x2} ${y2}" stroke="#9a7444" stroke-width="7" stroke-linecap="round"/><path d="M${x1} ${y1} L${x2} ${y2}" stroke="${INK}" stroke-width="2" stroke-dasharray="3 7" stroke-linecap="round"/>`;
  const car = (x: number, y: number, w: number, h: number, c: string) => `<rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="6" fill="${c}" stroke="${INK}" stroke-width="2"/><rect x="${x - w / 2 + 5}" y="${y - h / 2 + 5}" width="${w - 10}" height="${h / 3}" rx="3" fill="rgba(0,0,0,.35)"/>`;
  const raid = (x1: number, y1: number, x2: number, y2: number) => `<path d="M${x1} ${y1} L${x2} ${y2}" stroke="${RED}" stroke-width="3.5" stroke-dasharray="9 7" marker-end="url(#garrowr)"/>`;
  const stages = ['BUILD · 3:00', 'WAVE 1', 'WAVE 2', 'WAVE 3', 'DAWN'];
  const tl = stages
    .map((s, i) => `<g><rect x="${28 + i * 118}" y="344" width="108" height="30" rx="4" fill="${i === 0 ? 'rgba(255,180,84,.3)' : i === 4 ? 'rgba(125,220,122,.25)' : 'rgba(255,90,74,.22)'}" stroke="${i === 0 ? AMBER : i === 4 ? GREEN : RED}" stroke-width="1.5"/>${text(82 + i * 118, 364, s, { anchor: 'middle', size: 12, weight: 600, spacing: 1 })}</g>`)
    .join('');
  const body = `${defs}<rect width="640" height="400" fill="#17110c"/>
    <circle cx="320" cy="168" r="140" fill="#241a12" stroke="${PANEL_LINE}" stroke-width="1.5" stroke-dasharray="6 8"/>
    ${wall(212, 96, 278, 66)}${wall(362, 66, 428, 96)}${wall(212, 242, 262, 266)}${wall(378, 266, 428, 242)}
    ${car(320, 70, 64, 28, '#5a6a8a')}${car(236, 168, 28, 56, P1)}${car(404, 168, 28, 56, P2)}
    <circle cx="320" cy="168" r="14" fill="#ff8a3a" opacity=".85"/><circle cx="320" cy="168" r="7" fill="#ffd48a"/>
    ${tent(300, 204, 0.8)}${tent(342, 204, 0.8)}
    ${post(268, 108, -Math.PI * 0.62)}${post(372, 108, -Math.PI * 0.38)}${post(320, 262, Math.PI / 2)}
    ${raid(300, 8, 320, 38)}${raid(70, 120, 192, 150)}${raid(570, 120, 448, 150)}${raid(560, 250, 440, 214)}
    ${text(40, 190, 'raiders · the dead', { size: 12, fill: '#ff8a6a' })}
    ${pin(232, 70, 1)}${pin(268, 128, 2)}${pin(432, 142, 3)}${pin(560, 108, 4)}
    ${tl}
    <path d="M28 334 H590" stroke="${DIM}" stroke-width="0"/>`;
  return svg(640, 400, body, 'A top-down camp: parked vehicles and walls ring a fire, watch posts cover the approaches, and raids arrive in three waves after a three-minute build phase.');
}

// ------------------------------------------------------------------ 10. staying alive

export function artSurvive(): string {
  const panel = (x: number, y: number, title: string, inner: string) =>
    `<g transform="translate(${x} ${y})"><rect width="296" height="176" rx="6" fill="rgba(0,0,0,.4)" stroke="${AMBER}" stroke-width="1.5"/>${text(12, 22, title, { size: 13, weight: 700, spacing: 2.5, fill: AMBER })}${inner}</g>`;
  const wounds = `<rect x="14" y="40" width="150" height="12" fill="rgba(0,0,0,.6)" stroke="${GREEN}"/><rect x="15" y="41" width="104" height="10" fill="${GREEN}"/>
    ${text(14, 78, 'Bleeding drains it,', { size: 12, fill: DIM })}${text(14, 94, 'but never kills: it', { size: 12, fill: DIM })}${text(14, 110, 'leaves you at 1 HP.', { size: 12, fill: DIM })}
    <g transform="translate(228 100)"><rect x="-32" y="-14" width="64" height="28" rx="14" fill="#e6d4a8" stroke="${INK}" stroke-width="2" transform="rotate(-20)"/><rect x="-8" y="-14" width="16" height="28" fill="#cfb67e" transform="rotate(-20)"/><path d="M-4 -4 h8 M0 -8 v8" stroke="${RED}" stroke-width="3" transform="rotate(-20)"/></g>
    ${text(14, 140, 'Bandage: binds every wound.', { size: 12 })}${text(14, 158, 'Medkit: binds and heals 60.', { size: 12 })}`;
  const stam = `<rect x="14" y="44" width="150" height="8" fill="rgba(0,0,0,.6)"/><rect x="14" y="44" width="38" height="8" fill="#4aa8ff"/>
    ${text(172, 53, 'low', { size: 12, fill: '#4aa8ff' })}
    ${person(240, 124, 0.85, P1)}<g stroke="${PAPER}" stroke-width="2" fill="none" opacity=".7"><path d="M268 84 q10 -8 18 0 M270 96 q10 -8 18 0"/></g>
    ${text(14, 82, 'Sprint, jump and swing', { size: 12, fill: DIM })}${text(14, 98, 'spend stamina.', { size: 12, fill: DIM })}
    ${text(14, 132, 'Run dry and you are WINDED:', { size: 12 })}${text(14, 148, 'no sprint, slower, shaky aim.', { size: 12 })}`;
  const down = `${person(70, 128, 1.1, P1, 'down')}${person(170, 128, 1.1, P2)}
    <path d="M150 86 q-30 -14 -60 6" fill="none" stroke="${GREEN}" stroke-width="2.5" marker-end="url(#garrow)"/>
    ${cross(112, 68, 0.5)}
    ${text(14, 156, '0 HP: crawl for 20 s. Hold A', { size: 12 })}${text(14, 170, 'on them to revive.', { size: 12 })}
    ${text(262, 52, '20s', { size: 16, anchor: 'middle', fill: RED, mono: true, weight: 700 })}`;
  const tether = `${moped(70, 126, 1.2, P1)}${moped(226, 126, 1.2, P2, true)}
    <path d="M44 56 H252" stroke="${AMBER}" stroke-width="2" marker-end="url(#garrow)" marker-start="url(#garrow)"/>
    ${text(148, 48, '≈ 300 m', { anchor: 'middle', size: 13, mono: true, fill: AMBER })}
    ${text(14, 156, 'Stay within about 300 m. The one', { size: 12 })}${text(14, 170, 'behind slipstreams; the lead slows.', { size: 12 })}`;
  const body = `${defs}<rect width="640" height="400" fill="#17110c"/>
    ${panel(16, 16, 'HEALTH & WOUNDS', wounds)}${panel(328, 16, 'STAMINA', stam)}${panel(16, 208, 'DOWNED, NOT DEAD', down)}${panel(328, 208, 'THE TETHER', tether)}`;
  return svg(640, 400, body, 'Four panels: health and wounds, stamina, being downed and revived, and the tether between two players.');
}
