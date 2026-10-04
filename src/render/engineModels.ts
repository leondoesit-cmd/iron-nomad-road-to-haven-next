import * as THREE from 'three';
import { MeshBuilder, S, type Surf } from './builder';
import { partDef } from '../data';
import { cylindersOf, engineDims, isBoxer, isVee, type Dims } from '../sim/engineSize';

/**
 * Engine models. One drawer for every engine, used on the ground, in the arms, on a stand and in the bay (`part:<id>` model
 * keys, `bayKit`). The model is drawn in real metres from the engine's own spec: length, width and height come from
 * `sim/engineSize.ts` (litres, cylinders, layout, size class), so a 50cc scooter motor is a fist-sized lump and a 14.5 L rig
 * diesel is a tall iron wall. Frame: origin at the middle of the base (the bottom of the sump), +Z forward (belt end), +Y up.
 *
 * What makes each one look like itself: the layout (single, inline, vee, boxer), the top end (cam cover or tall diesel rocker
 * cover, carbs or an air box or a roots blower), the plumbing (injection pump and fuel lines on a diesel, turbo and charge pipe),
 * and the family colours of its cast covers. Wear (grime and rust, from condition) goes in the surface values, so one geometry
 * does for every condition.
 */

export interface EngineDrawOpts {
  /** 0 clean to 1 wrecked: rust, grime and a dark film of oil. */
  wear?: number;
}

/** Brand and family: the colour of the block, the cam covers and the accent bits. */
interface Family {
  block: number;
  cover: number;
  accent: number;
  /** A bare iron engine, painted over or not: only shows in the metal. */
  iron?: boolean;
}

const FAMILY: Record<string, Family> = {
  eng_50cc: { block: 0xb4b8bc, cover: 0x232526, accent: 0xe0701a },
  eng_250: { block: 0x2a2c2e, cover: 0x7a2018, accent: 0xc4c8cc },
  eng_650: { block: 0x35383b, cover: 0xc8902a, accent: 0xc4c8cc },
  eng_i3: { block: 0xa8acb0, cover: 0x2a5a9a, accent: 0x15171a },
  eng_i4_18: { block: 0x7a7e82, cover: 0x232526, accent: 0xd0c8a8 },
  eng_buggy: { block: 0x2e3032, cover: 0xb0301e, accent: 0xc4c8cc },
  eng_i4: { block: 0x4a4e52, cover: 0xa8acb0, accent: 0xc4c8cc, iron: true },
  eng_b4: { block: 0x8a8e92, cover: 0xc8902a, accent: 0x2a4aa0 },
  eng_v6: { block: 0x5a5e62, cover: 0x2a7a3a, accent: 0xc4c8cc },
  eng_v8: { block: 0x2a2c2e, cover: 0xd62a1a, accent: 0xd9dde2 },
  eng_i3d: { block: 0x5a6a4a, cover: 0x8a9a7a, accent: 0xb89a52, iron: true },
  eng_d4: { block: 0x2a3a5a, cover: 0x9aa4b0, accent: 0xe0a01a },
  eng_d25: { block: 0x8a3a22, cover: 0x6a2a1a, accent: 0xb89a52, iron: true },
  eng_d30: { block: 0xb8bcb4, cover: 0x4a6a8a, accent: 0xb89a52 },
  eng_d6: { block: 0x3a6a2a, cover: 0x2a4a1e, accent: 0xe0c020, iron: true },
  eng_d66: { block: 0x9a2a1e, cover: 0x2c2e30, accent: 0xb89a52, iron: true },
  eng_d8: { block: 0x1e2022, cover: 0x4a4e52, accent: 0xe0701a },
  eng_d145: { block: 0x23458a, cover: 0x1a2c58, accent: 0xe0c020, iron: true },
};

const FALLBACK: Family = { block: 0x55595d, cover: 0x8a8e92, accent: 0xc4c8cc };

/** The engine part's id with its spec, or null for a bare bay. */
function specOf(id: string) {
  const d = partDef(id);
  return d.engine && !d.empty ? d.engine : null;
}

export function engineFamily(id: string): Family {
  return FAMILY[id] ?? FALLBACK;
}

/** Fill `b` with the model of engine part `id`. Returns its dimensions (the box the model stays inside). */
export function drawEngine(b: MeshBuilder, id: string, o: EngineDrawOpts = {}): Dims {
  const d = partDef(id);
  const spec = specOf(id);
  const wear = Math.max(0, Math.min(1, o.wear ?? (d.stock ? 0.55 : 0.3)));
  const fam = engineFamily(id);
  if (!spec) {
    emptyMounts(b, wear);
    return { l: 0.5, w: 0.5, h: 0.12 };
  }
  const dims = engineDims(spec);
  const E = new Engine(b, id, spec, fam, dims, wear);
  E.draw();
  return dims;
}

/** The mounts left behind by a stripped bay: two rubber-and-steel feet and a rusty cross-brace. */
function emptyMounts(b: MeshBuilder, wear: number) {
  const st = S.steel(0x4a4d50, wear);
  for (const sx of [1, -1]) {
    b.rbox(sx * 0.2, 0.05, 0, 0.1, 0.1, 0.16, 0.02, st);
    b.cyl(sx * 0.2, 0.12, 0, 0.07, 0.06, 0.07, S.rubber(0x1c1c1e), 0, 0, 0, 8);
  }
  b.rbox(0, 0.03, 0, 0.5, 0.04, 0.06, 0.01, S.rust(0x6a3a22));
}

type EngineSpecT = NonNullable<ReturnType<typeof specOf>>;

class Engine {
  private readonly W: number;
  private readonly L: number;
  private readonly H: number;
  private readonly n: number;
  private readonly diesel: boolean;
  private readonly big: boolean;
  private readonly tiny: boolean;
  private readonly cover: Surf;
  private readonly block: Surf;
  private readonly accent: Surf;
  private readonly steel: Surf;
  private readonly dark: Surf;
  private readonly alu: Surf;
  private readonly hose: Surf;
  private readonly exh: Surf;
  private readonly rust: Surf;
  private readonly chrome: Surf;

  constructor(
    private readonly b: MeshBuilder,
    private readonly id: string,
    private readonly spec: EngineSpecT,
    private readonly fam: Family,
    dims: Dims,
    private readonly wear: number,
  ) {
    this.W = dims.w;
    this.L = dims.l;
    this.H = dims.h;
    this.n = cylindersOf(spec);
    this.diesel = spec.fuel === 'diesel';
    this.big = spec.litres >= 4;
    this.tiny = spec.litres < 0.7;
    const w = wear;
    this.block = fam.iron ? S.paint(fam.block, Math.min(1, w + 0.15)) : S.metal(fam.block, w);
    this.cover = fam.iron ? S.paint(fam.cover, Math.min(1, w + 0.1)) : S.paint(fam.cover, w);
    this.accent = S.metal(fam.accent, w);
    this.steel = S.steel(0x5a5d60, w);
    this.dark = S.steel(0x25272a, w * 0.6);
    this.alu = S.metal(0xaeb2b6, w);
    this.hose = S.rubber(0x1c1c1e);
    // Exhaust iron gets hot and rusty first; the more worn the engine the browner it gets.
    this.exh = w > 0.45 ? S.rust(0x7a4a2c) : S.metal(0x6e4a34, Math.min(1, w + 0.3));
    this.rust = S.rust(0x7a3f22);
    this.chrome = S.chrome(0xc4c8cc);
  }

  draw() {
    const { spec } = this;
    if (this.tiny && this.n === 1) this.single();
    else if (isVee(spec)) this.vee();
    else if (isBoxer(spec)) this.boxer();
    else this.inline();
    this.wearMarks();
  }

  // ---------------------------------------------------------------- shared pieces

  /** Oil pan under the block, with its drain bolt. */
  private sump(widthK = 0.56, lenK = 0.7) {
    const { b, W, L, H } = this;
    const hh = H * (this.diesel ? 0.2 : 0.15);
    b.rbox(0, hh / 2, 0, W * widthK, hh, L * lenK, 0.02, S.steel(0x34373a, this.wear));
    b.cyl(0, 0.004, -L * lenK * 0.25, 0.03, 0.012, 0.03, this.accent, 0, 0, 0, 6);
  }

  /** The belt end: crank pulley, alternator and water pump pulleys, and the belt itself. */
  private frontDrive(yCrank: number, x2 = -0.2) {
    const { b, W, L, H } = this;
    const z = L / 2 - 0.02;
    const pr = Math.min(0.11, H * 0.17);
    const px = W * x2;
    const py = yCrank + H * 0.25;
    b.cyl(0, yCrank, z, pr * 2, 0.03, pr * 2, this.dark, Math.PI / 2, 0, 0, 14);
    b.cyl(px, py, z, pr * 1.3, 0.03, pr * 1.3, this.accent, Math.PI / 2, 0, 0, 12);
    b.cyl(-px * 0.9, yCrank + H * 0.2, z, pr * 1.1, 0.03, pr * 1.1, this.steel, Math.PI / 2, 0, 0, 10);
    b.rod(0, yCrank + pr, z, px, py + pr * 0.65, z, 0.007, this.hose, 5);
    b.rod(0, yCrank - pr, z, -px * 0.9, yCrank + H * 0.2 - pr * 0.5, z, 0.007, this.hose, 5);
    b.rod(px, py + pr * 0.65, z, -px * 0.9, yCrank + H * 0.2 + pr * 0.5, z, 0.007, this.hose, 5);
    // The alternator hangs off the belt, a finned drum with a pulley.
    const ar = Math.min(0.06, W * 0.12);
    b.cyl(px, py, z - 0.07, ar * 2, 0.1, ar * 2, S.metal(0x8a8e92, this.wear), Math.PI / 2, 0, 0, 10);
    for (let i = 0; i < 3; i++) b.cyl(px, py, z - 0.04 - i * 0.03, ar * 2.15, 0.006, ar * 2.15, this.dark, Math.PI / 2, 0, 0, 10);
  }

  /** Bell housing flange at the gearbox end. */
  private bell(yc: number, wFrac = 0.8) {
    const { b, W, L } = this;
    // The flange never reaches below the base of the engine.
    const dia = Math.max(0.08, Math.min(W * wFrac * 0.8, yc * 2 - 0.012));
    b.cyl(0, yc, -L / 2 + 0.03, dia, 0.06, dia, S.steel(0x4a4d50, this.wear), Math.PI / 2, 0, 0, 14);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      b.cyl(Math.cos(a) * dia * 0.45, yc + Math.sin(a) * dia * 0.45, -L / 2 + 0.005, 0.02, 0.02, 0.02, this.chrome, Math.PI / 2, 0, 0, 6);
    }
  }

  /** Oil filter canister and a dipstick. */
  private filterAndStick(x: number, y: number, z: number) {
    const { b, H } = this;
    b.cyl(x, y, z, 0.07, 0.1, 0.07, S.paint(0x1e4a8a, this.wear), 0, 0, 0, 10);
    b.rod(-x * 0.4, y + H * 0.2, z + 0.05, -x * 0.4, y + H * 0.42, z + 0.03, 0.005, this.accent, 4);
  }

  /** A row of spark plug leads or coil packs on a petrol head; injector lines on a diesel. */
  private plugs(y: number, xs: number[], zs: number[]) {
    const { b } = this;
    for (const z of zs) {
      for (const x of xs) {
        b.cyl(x, y, z, 0.03, 0.05, 0.03, S.plastic(0x15171a), 0, 0, 0, 6);
        b.rod(x, y + 0.02, z, x * 1.3, y + 0.06, z, 0.004, S.plastic(0x15171a), 4);
      }
    }
  }

  /** Zs along the engine for `count` cylinders, centred, within `span`. */
  private zs(count: number, span: number): number[] {
    if (count === 1) return [0];
    const out: number[] = [];
    for (let i = 0; i < count; i++) out.push(-span / 2 + (i / (count - 1)) * span);
    return out;
  }

  // ---------------------------------------------------------------- scooter and single

  /** One cylinder: a finned barrel on a crankcase, a belt-drive cover on the side, a pod filter and a stub exhaust. */
  private single() {
    const { b, W, L, H } = this;
    const quad = this.spec.litres >= 0.2;
    // Crankcase halves.
    b.rbox(0, H * 0.28, -L * 0.06, W * 0.64, H * 0.5, L * 0.62, 0.025, this.block);
    b.cyl(0, H * 0.28, -L * 0.06, W * 0.5, W * 0.7, W * 0.5, S.steel(0x3a3d40, this.wear), 0, 0, Math.PI / 2, 12);
    // The barrel leans forward, fins on it, and a head with a plug.
    const by = H * 0.62;
    const bz = L * 0.18;
    b.cyl(0, by, bz, W * 0.38, H * 0.34, W * 0.38, this.block, Math.PI * 0.12, 0, 0, 12);
    const fins = quad ? 6 : 5;
    for (let i = 0; i < fins; i++) b.cyl(0, by - H * 0.14 + (i / (fins - 1)) * H * 0.28, bz + (i / (fins - 1)) * L * 0.04 - L * 0.02, W * 0.48, 0.006, W * 0.48, this.alu, Math.PI * 0.12, 0, 0, 12);
    b.rbox(0, H * 0.85, bz + L * 0.04, W * 0.4, H * 0.14, W * 0.42, 0.02, this.cover, Math.PI * 0.12, 0, 0);
    b.cyl(0, H * 0.96, bz + L * 0.05, 0.02, 0.04, 0.02, this.chrome, 0, 0, 0, 6);
    // Belt-drive (variator) cover along the side, or a chain case on the quad.
    b.cyl(W * 0.36, H * 0.3, -L * 0.1, H * 0.62, 0.05, H * 0.62, this.cover, 0, 0, Math.PI / 2, 14);
    b.cyl(W * 0.39, H * 0.3, -L * 0.1, H * 0.18, 0.02, H * 0.18, this.chrome, 0, 0, Math.PI / 2, 8);
    // Carb and pod filter above, stub exhaust below.
    b.cyl(-W * 0.2, H * 0.78, -L * 0.2, W * 0.3, H * 0.16, W * 0.3, quad ? this.dark : S.plastic(0x3a3d40), 0, 0, 0, 10);
    b.pipe([[W * 0.1, H * 0.7, L * 0.3], [W * 0.38, H * 0.3, L * 0.38], [W * 0.38, H * 0.18, -L * 0.45]], 0.014, this.exh, 6);
    b.cyl(W * 0.38, H * 0.18, -L * 0.45, 0.05, 0.06, 0.05, this.dark, Math.PI / 2, 0, 0, 8);
    // Kick-start lever or a pull-start on a quad.
    if (quad) b.rod(-W * 0.36, H * 0.3, -L * 0.25, -W * 0.46, H * 0.18, -L * 0.36, 0.008, this.chrome, 5);
    else b.rod(-W * 0.36, H * 0.32, 0, -W * 0.48, H * 0.2, -L * 0.1, 0.007, this.accent, 5);
  }

  // ---------------------------------------------------------------- inline

  private inline() {
    const { b, W, L, H, n, spec } = this;
    const id = this.id;
    const diesel = this.diesel;
    this.sump(0.58, 0.72);
    const bw = W * (diesel ? 0.6 : 0.56);
    const blockTop = H * (diesel ? 0.6 : 0.5);
    const yb = H * (diesel ? 0.18 : 0.14);
    // Block with a lower skirt, and a gasket line between block and head.
    b.rbox(0, (yb + blockTop) / 2, 0, bw, blockTop - yb, L * 0.84, 0.02, this.block);
    b.box(0, blockTop, 0, bw * 1.02, 0.008, L * 0.85, this.dark);
    // Head and cam cover: low and wide on a petrol engine, tall and narrow on a diesel (rocker cover).
    const headTop = blockTop + H * (diesel ? 0.14 : 0.1);
    b.rbox(0, (blockTop + headTop) / 2, 0, bw * 0.96, headTop - blockTop, L * 0.82, 0.015, this.block);
    const covTop = headTop + H * (diesel ? 0.14 : 0.12);
    const covW = bw * (diesel ? 0.62 : 0.74);
    b.rbox(0, (headTop + covTop) / 2, 0, covW, covTop - headTop, L * 0.74, 0.02, this.cover);
    for (let i = 0; i < 5; i++) b.box(0, covTop + 0.003, -L * 0.28 + i * L * 0.14, covW * 0.9, 0.006, 0.012, this.dark);
    b.cyl(covW * 0.25, covTop + 0.01, L * 0.26, 0.04, 0.025, 0.04, this.accent, 0, 0, 0, 8);
    this.bell(blockTop * 0.55);
    this.frontDrive(blockTop * 0.4);
    this.filterAndStick(bw * 0.5 + 0.02, yb + 0.07, L * 0.12);
    const zs = this.zs(n, L * 0.6);
    // Ribs down the side of the block.
    for (let i = 0; i < 6; i++) b.box(bw * 0.5 + 0.004, (yb + blockTop) / 2, -L * 0.34 + i * L * 0.136, 0.012, (blockTop - yb) * 0.8, 0.02, this.dark);
    if (diesel) this.dieselTop(bw, headTop, covTop, zs);
    else this.petrolTop(bw, headTop, covTop, zs);
    // Exhaust: a cast manifold on the +X side, a turbo on it when blown.
    this.exhaustSide(1, bw, (blockTop + headTop) / 2, zs, spec.blown ? 'turbo' : 'plain');
    void id;
  }

  /** Intake and ignition on a petrol inline. The id picks which of the family's tops it wears. */
  private petrolTop(bw: number, headTop: number, covTop: number, zs: number[]) {
    const { b, W, L, H, id } = this;
    const side = -1;
    const xi = side * (bw * 0.5 + W * 0.05);
    const yi = headTop - H * 0.02;
    if (id === 'eng_buggy') {
      // Twin carbs on a short manifold, each with two chrome velocity stacks.
      for (const z of [-L * 0.14, L * 0.14]) {
        b.cyl(xi, yi + H * 0.04, z, W * 0.22, H * 0.16, W * 0.22, S.metal(0x8a8e92, this.wear), 0, 0, 0, 10);
        for (const dz of [-0.03, 0.03]) b.cyl(xi, yi + H * 0.17, z + dz, W * 0.12, H * 0.08, W * 0.12, this.chrome, 0, 0, 0, 8);
      }
      b.rbox(xi + W * 0.02, yi - H * 0.02, 0, W * 0.16, H * 0.08, L * 0.5, 0.02, this.alu);
    } else if (id === 'eng_i4') {
      // A big chrome air cleaner pot on a single carb, chrome breather on the cover.
      b.cyl(xi * 0.5, covTop + H * 0.04, 0, W * 0.46, H * 0.1, W * 0.46, this.chrome, 0, 0, 0, 18);
      b.cyl(xi * 0.5, covTop + H * 0.1, 0, W * 0.4, H * 0.025, W * 0.4, S.steel(0x2a2a2a, this.wear), 0, 0, 0, 18);
      b.rbox(xi, yi, 0, W * 0.12, H * 0.07, L * 0.4, 0.015, this.alu);
    } else if (id === 'eng_i3' || id === 'eng_i4_18' || id === 'eng_b4') {
      // A plastic plenum with runners down to each port, and a round air box nearby.
      b.rbox(xi + W * 0.01, yi + H * 0.07, 0, W * 0.15, H * 0.1, L * 0.5, 0.025, S.plastic(0x1a1c1e));
      for (const z of zs) b.rod(xi + W * 0.01, yi + H * 0.06, z, xi + W * 0.07, yi - H * 0.03, z, 0.012, S.plastic(0x1a1c1e), 6);
      b.cyl(xi * 0.4, covTop + H * 0.04, -L * 0.18, W * 0.3, H * 0.1, W * 0.3, S.plastic(0x2a2c2e), 0, 0, 0, 12);
    } else {
      b.rbox(xi, yi + H * 0.05, 0, W * 0.14, H * 0.09, L * 0.5, 0.02, S.metal(0x6a6e72, this.wear));
    }
    this.plugs(headTop + 0.01, [bw * 0.3, -bw * 0.3], zs);
  }

  /** The diesel top end: an injection pump, a fuel line to each cylinder, a filter and a glow plug rail. */
  private dieselTop(bw: number, headTop: number, covTop: number, zs: number[]) {
    const { b, W, L, H } = this;
    const px = -(bw * 0.5 + W * 0.075);
    const py = H * 0.4;
    // Injection pump: a squat body with a governor cap, bolted to the side of the block.
    b.rbox(px, py, L * 0.12, W * 0.16, H * 0.16, L * 0.26, 0.02, S.metal(0xb89a52, this.wear));
    b.cyl(px, py + H * 0.1, L * 0.12, W * 0.12, H * 0.06, W * 0.12, this.dark, 0, 0, 0, 10);
    b.cyl(px - W * 0.05, py, L * 0.28, W * 0.1, 0.06, W * 0.1, this.dark, Math.PI / 2, 0, 0, 10);
    // A line from the pump to every injector.
    zs.forEach((z) => {
      b.pipe([[px, py + H * 0.08, L * 0.12], [px * 0.9, headTop + H * 0.06, z * 0.6 + L * 0.04], [bw * -0.12, covTop - H * 0.03, z]], 0.007, S.metal(0xd0d4d8, 0.3), 5);
      b.cyl(-bw * 0.12, covTop + 0.015, z, 0.035, 0.05, 0.035, this.accent, 0, 0, 0, 6);
    });
    // Fuel filter canister and its feed pipe.
    b.cyl(px, headTop - H * 0.1, -L * 0.28, W * 0.12, H * 0.2, W * 0.12, S.paint(0x2a6aa8, this.wear), 0, 0, 0, 10);
    b.pipe([[px, headTop - H * 0.1, -L * 0.28], [px, py + H * 0.04, -L * 0.05]], 0.008, S.rubber(0x1c1c1e), 5);
    // A small intake manifold on the exhaust-free side keeps the top clear for the lines.
    b.rbox(-bw * 0.3, headTop + 0.01, -L * 0.4, W * 0.14, H * 0.05, L * 0.2, 0.015, this.alu);
  }

  /** Exhaust manifold along one side, with a turbo on it when asked. */
  private exhaustSide(sx: number, bw: number, y: number, zs: number[], kind: 'plain' | 'turbo') {
    const { b, W, L, H } = this;
    const x = sx * (bw * 0.5 + W * 0.045);
    const r = Math.max(0.014, W * 0.04);
    b.rbox(x, y, 0, W * 0.07, r * 2.4, Math.max(0.1, (zs[zs.length - 1] - zs[0]) + L * 0.15), 0.012, this.exh);
    for (const z of zs) b.rod(x * 0.7, y + H * 0.02, z, x, y, z, r, this.exh, 6);
    if (kind === 'turbo') this.turbo(x + sx * W * 0.03, y, -L * 0.22 + (this.big ? 0 : 0));
    else b.pipe([[x, y, -L * 0.3], [x + sx * 0.02, y - H * 0.08, -L * 0.42]], r * 1.1, this.exh, 6);
  }

  /** A turbocharger: hot-side snail, compressor snail, and the pipe that carries the charge to the intake. */
  private turbo(x: number, y: number, z: number, scale = 1) {
    const { b, W, L, H } = this;
    const r = Math.min(W * 0.18, H * 0.13) * scale;
    b.cyl(x, y, z, r * 2, r * 1.3, r * 2, this.exh, 0, 0, Math.PI / 2, 12);
    b.cyl(x - Math.sign(x) * r * 1.1, y, z, r * 1.5, r * 1.1, r * 1.5, S.metal(0x8a8e92, this.wear), 0, 0, Math.PI / 2, 12);
    b.cyl(x + Math.sign(x) * r * 0.2, y + r * 0.3, z + r * 0.9, r * 0.7, r * 0.8, r * 0.7, this.exh, Math.PI / 2, 0, 0, 8);
    // The charge pipe runs up and forward to the inlet manifold.
    b.pipe([[x - Math.sign(x) * r * 1.5, y, z], [x * 0.4, y + H * 0.2, z + L * 0.1], [-W * 0.18, y + H * 0.28, z + L * 0.18]], r * 0.28, S.metal(0xc4c8cc, 0.4), 6);
  }

  // ---------------------------------------------------------------- vee

  private vee() {
    const { b, W, L, H, n, spec, diesel } = this;
    const per = n / 2;
    this.sump(0.5, 0.7);
    const blockTop = H * (diesel ? 0.5 : 0.46);
    const yb = H * (diesel ? 0.16 : 0.12);
    // A cast block in the middle, banks angled out above it.
    b.rbox(0, (yb + blockTop) / 2, 0, W * 0.5, blockTop - yb, L * 0.86, 0.025, this.block);
    const zs = this.zs(per, L * 0.58);
    const ang = 0.5;
    for (const sx of [1, -1]) {
      // Each bank: cylinder block cheek, head and cam cover, all tilted.
      const cx = sx * W * 0.26;
      b.rbox(cx, blockTop + H * 0.05, 0, W * 0.3, H * 0.12, L * 0.8, 0.02, this.block, 0, 0, -sx * ang);
      b.rbox(sx * W * 0.31, blockTop + H * 0.17, 0, W * 0.26, H * 0.08, L * 0.8, 0.02, this.cover, 0, 0, -sx * ang);
      for (let i = 0; i < 4; i++) b.box(sx * W * 0.31, blockTop + H * 0.215, -L * 0.28 + i * L * 0.19, W * 0.22, 0.005, 0.012, this.dark, 0, 0, -sx * ang);
      // Plug leads and the exhaust manifold down the outside of each bank.
      this.plugs(blockTop + H * 0.2, [sx * W * 0.36], zs);
      const ex = sx * (W * 0.5 - 0.02);
      for (const z of zs) b.rod(sx * W * 0.4, blockTop + H * 0.09, z, ex, blockTop - H * 0.06, z, Math.max(0.012, W * 0.03), this.exh, 6);
      b.rbox(ex, blockTop - H * 0.06, 0, W * 0.05, Math.max(0.03, W * 0.08), L * 0.7, 0.012, this.exh);
      if (spec.blown && diesel) this.turbo(ex, blockTop - H * 0.06, -L * 0.34, 0.9);
      else b.pipe([[ex, blockTop - H * 0.06, -L * 0.3], [ex, blockTop - H * 0.16, -L * 0.42]], Math.max(0.016, W * 0.035), this.exh, 6);
    }
    // Top of the vee: an intake plenum with runners, or a roots blower and its scoop.
    if (spec.blown && !diesel) {
      b.rbox(0, blockTop + H * 0.2, 0, W * 0.34, H * 0.2, L * 0.46, 0.04, S.metal(0xc4c8cc, 0.3));
      b.cyl(0, blockTop + H * 0.34, -L * 0.02, W * 0.28, H * 0.12, W * 0.28, S.steel(0x1c1e20, this.wear), 0, 0, 0, 14);
      b.cyl(0, blockTop + H * 0.34, -L * 0.02, W * 0.2, H * 0.016, W * 0.2, this.chrome, 0, 0, 0, 14);
      // The blower belt, down the front, and four stacks of chrome headers' worth of velocity pipes.
      for (let i = 0; i < 4; i++) b.cyl(-W * 0.12 + (i % 2) * W * 0.24, blockTop + H * 0.3, L * 0.16 + Math.floor(i / 2) * L * 0.1, 0.035, 0.06, 0.035, this.chrome, 0, 0, 0, 8);
      b.rod(0, blockTop + H * 0.2, L * 0.28, 0, blockTop - H * 0.12, L * 0.42, 0.008, this.hose, 5);
    } else if (diesel) {
      b.rbox(0, blockTop + H * 0.12, 0, W * 0.2, H * 0.09, L * 0.5, 0.02, this.alu);
      for (const z of zs) b.cyl(0, blockTop + H * 0.2, z, 0.03, 0.04, 0.03, this.accent, 0, 0, 0, 6);
      // A pump in the vee, and a line to each injector on both banks.
      b.rbox(0, blockTop + H * 0.18, L * 0.12, W * 0.18, H * 0.12, L * 0.2, 0.02, S.metal(0xb89a52, this.wear));
    } else {
      b.rbox(0, blockTop + H * 0.18, 0, W * 0.3, H * 0.1, L * 0.52, 0.03, S.plastic(0x1a1c1e));
      for (const z of zs) for (const sx of [1, -1]) b.rod(sx * W * 0.08, blockTop + H * 0.17, z, sx * W * 0.2, blockTop + H * 0.13, z, 0.012, S.plastic(0x1a1c1e), 5);
      b.cyl(0, blockTop + H * 0.3, -L * 0.1, W * 0.3, H * 0.08, W * 0.3, this.chrome, 0, 0, 0, 14);
    }
    this.bell(blockTop * 0.6);
    this.frontDrive(blockTop * 0.45, -0.18);
    this.filterAndStick(W * 0.26, yb + 0.07, L * 0.1);
  }

  // ---------------------------------------------------------------- boxer

  private boxer() {
    const { b, W, L, H, n } = this;
    this.sump(0.42, 0.66);
    const per = n / 2;
    // Crankcase down the centre; a flat cylinder and head pointing out each side.
    b.rbox(0, H * 0.46, 0, W * 0.34, H * 0.52, L * 0.8, 0.025, this.block);
    const zs = this.zs(per, L * 0.5);
    for (const sx of [1, -1]) {
      b.rbox(sx * W * 0.31, H * 0.46, 0, W * 0.22, H * 0.4, L * 0.74, 0.02, this.block);
      for (let i = 0; i < 4; i++) b.box(sx * W * 0.31, H * 0.46, -L * 0.28 + i * L * 0.18, W * 0.22, H * 0.4, 0.012, this.alu);
      b.rbox(sx * (W * 0.45), H * 0.46, 0, W * 0.09, H * 0.42, L * 0.76, 0.02, this.cover);
      b.cyl(sx * (W * 0.45), H * 0.7, L * 0.2, 0.04, 0.03, 0.04, this.accent, 0, 0, 0, 8);
      // Each head has its own exhaust header curling back under the engine.
      for (const z of zs) b.rod(sx * W * 0.4, H * 0.3, z, sx * W * 0.28, H * 0.12, z - L * 0.04, Math.max(0.012, W * 0.03), this.exh, 6);
      b.pipe([[sx * W * 0.28, H * 0.12, zs[0] - L * 0.04], [sx * W * 0.1, H * 0.08, -L * 0.36], [sx * W * 0.1, H * 0.1, -L * 0.45]], Math.max(0.018, W * 0.04), this.exh, 6);
    }
    // Intake plenum on top, air box beside it.
    b.rbox(0, H * 0.84, 0, W * 0.3, H * 0.12, L * 0.5, 0.03, S.plastic(0x1a1c1e));
    for (const z of zs) for (const sx of [1, -1]) b.rod(sx * W * 0.1, H * 0.84, z, sx * W * 0.32, H * 0.66, z, 0.012, S.plastic(0x1a1c1e), 5);
    b.cyl(0, H * 0.93, -L * 0.14, W * 0.26, H * 0.08, W * 0.26, S.plastic(0x2a2c2e), 0, 0, 0, 12);
    this.bell(H * 0.42);
    this.frontDrive(H * 0.4, -0.18);
    this.filterAndStick(W * 0.14, H * 0.12, L * 0.2);
  }

  // ---------------------------------------------------------------- age

  /** Rust blooms and an oil film in proportion to wear. Patches only, so a new engine is clean. */
  private wearMarks() {
    const { b, W, L, H, wear } = this;
    if (wear < 0.35) return;
    const n = Math.round((wear - 0.3) * 9);
    let s = this.id.length * 977 + Math.round(wear * 100);
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < n; i++) {
      const x = (rnd() - 0.5) * W * 0.5;
      const z = (rnd() - 0.5) * L * 0.6;
      b.rbox(x, H * (0.2 + rnd() * 0.45), z + 0.0, 0.05 + rnd() * 0.06, 0.004, 0.05 + rnd() * 0.08, 0.002, this.rust, 0, rnd() * 3, rnd() * 0.2);
    }
    // An oil weep under a worn engine's head gasket.
    if (wear > 0.6) b.rbox(0, H * 0.18, 0, W * 0.56, 0.006, L * 0.5, 0.003, S.rubber(0x0c0c0c));
  }
}

// ---------------------------------------------------------------- signatures

/** A stable fingerprint of an engine model's geometry: triangle count, size and a hash of the vertices. Used by tests. */
export function engineSignature(id: string, wear = 0.3): { tris: number; size: [number, number, number]; hash: number } {
  const b = new MeshBuilder();
  b.jitter = 0;
  drawEngine(b, id, { wear });
  const g = b.build();
  g.computeBoundingBox();
  const box = g.boundingBox!;
  const sz = box.getSize(new THREE.Vector3());
  const pos = g.getAttribute('position');
  let h = 2166136261;
  for (let i = 0; i < pos.count; i++) {
    h = Math.imul(h ^ Math.round(pos.getX(i) * 1000), 16777619);
    h = Math.imul(h ^ Math.round(pos.getY(i) * 1000), 16777619);
    h = Math.imul(h ^ Math.round(pos.getZ(i) * 1000), 16777619);
  }
  const tris = g.index ? g.index.count / 3 : pos.count / 3;
  g.dispose();
  return { tris, size: [round(sz.x), round(sz.y), round(sz.z)], hash: h >>> 0 };
}

const round = (v: number) => Math.round(v * 1000) / 1000;

/** The bounding box of an engine model, to check against its dims. */
export function engineBounds(id: string): THREE.Box3 {
  const b = new MeshBuilder();
  b.jitter = 0;
  drawEngine(b, id, {});
  const g = b.build();
  g.computeBoundingBox();
  const out = g.boundingBox!.clone();
  g.dispose();
  return out;
}

const EXTENT = new Map<string, { l: number; w: number; h: number; z: number }>();

/**
 * The real extent of the drawn model, from its geometry: length, width, and the height of its top above the base. A model
 * never exceeds `engineDims` but rarely fills it, so anything that places an engine against a bonnet uses this one.
 */
export function engineExtent(id: string): { l: number; w: number; h: number; z: number } {
  let e = EXTENT.get(id);
  if (!e) {
    const bb = engineBounds(id);
    // `z` is where the middle of the model is, so the box can be centred on the mounts.
    e = { l: round(bb.max.z - bb.min.z), w: round(bb.max.x - bb.min.x), h: round(bb.max.y), z: round((bb.max.z + bb.min.z) / 2) };
    EXTENT.set(id, e);
  }
  return e;
}
