import * as THREE from 'three';
import { MeshBuilder, S, type Surf } from './builder';
import { chassisDef, partDef } from '../data';
import { plate, rivets, signPlate } from './parts';
import { wheelGeometry, wheelSpec } from './vehicleKit';

/**
 * The running gear and panels as loose parts, one model per part id and sized from the part's own numbers: a radiator's
 * core from its cooling rating, a gearbox from its mass, springs from the load they carry, a brake from the energy it
 * soaks, a tyre at the size of the chassis it came off. What tells the grades apart is the build: scrap is bent, rusty
 * and patched, workshop parts are clean steel and alloy, the best are race or military kit with their colours and
 * hardware. Origin is the middle of the base, +Z forward (the way the part faces on the car), real size in metres.
 */

const dark = (w = 0.6) => S.steel(0x2c2f31, w);
const steel = (c = 0x6a6e72, w = 0.6) => S.steel(c, w);
const alu = (w = 0.35) => S.metal(0xb8bcc0, w);
const rubber = () => S.rubber(0x1a1a1c);
const chrome = () => S.chrome(0xc8ccd0);

/** The chassis a stock part was built for (`gbx_sedan` is the sedan's), or null for an aftermarket one. */
const ownerOf = (id: string): string | null => {
  const m = /^[a-z]+_(moped|quad|buggy|truck|rig|hatch|sedan|pickup|van|trike)$/.exec(id);
  return m ? m[1] : null;
};

/** Copy a built geometry (its own colours and surfaces) into a builder under a matrix. */
function appendGeometry(b: MeshBuilder, g: THREE.BufferGeometry, m: THREE.Matrix4) {
  const t = new MeshBuilder();
  t.pos = Array.from(g.getAttribute('position').array as Float32Array);
  t.nor = Array.from(g.getAttribute('normal').array as Float32Array);
  t.col = Array.from(g.getAttribute('color').array as Float32Array);
  t.srf = Array.from(g.getAttribute('surf').array as Float32Array);
  t.uv = Array.from(g.getAttribute('uv').array as Float32Array);
  t.idx = g.index ? Array.from(g.index.array as Uint16Array | Uint32Array) : Array.from({ length: t.pos.length / 3 }, (_, i) => i);
  b.appendMatrix(t, m);
}

// ---------------------------------------------------------------- wheels

/**
 * A wheel and its tyre standing on its tread, exactly the wheel the car would run: the factory one at its chassis' size,
 * or the aftermarket grade (patched road tyre, mud-terrain, beadlock crawler) at a common fifteen-inch size.
 */
export function wheelPart(b: MeshBuilder, id: string) {
  const d = partDef(id);
  const owner = ownerOf(id);
  const def = chassisDef(owner && owner !== 'trike' ? owner : 'pickup');
  const R = owner ? def.physics.wheelRadius : 0.38;
  const spec = wheelSpec(def, d.stock ? 0 : d.mk, 0);
  const g = wheelGeometry(R, spec.width, spec.style);
  // Standing, turned a little so the face shows, on a pair of chocks.
  appendGeometry(b, g, new THREE.Matrix4().compose(new THREE.Vector3(0, R, 0), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.5, 0)), new THREE.Vector3(1, 1, 1)));
  for (const s of [1, -1]) b.box(Math.sin(0.5) * s * R * 0.75, 0.04, Math.cos(0.5) * s * R * 0.75, spec.width * 0.9, 0.08, 0.12, S.wood(0x6a5238, 0.8), 0, 0.5, 0);
}

// ---------------------------------------------------------------- radiators

/**
 * A radiator: a finned core between two end tanks, the filler neck, hose necks and mounting tabs, its size from the
 * rating. The factory cores have black plastic tanks; the scrap one is bent and leaking epoxy; alloy cores are bright;
 * race cores have coloured tanks and a fan shroud with electric fans; the desert cooler is two cores in series. A
 * scooter's or a twin's "radiator" is the finned alloy shroud round its cylinder.
 */
export function radiatorPart(b: MeshBuilder, id: string) {
  const d = partDef(id);
  const kw = d.cooling ?? 80;
  if (kw <= 20) {
    // Air-cooled fins: a ribbed alloy cowl and its cooling fan housing.
    const fin = alu(0.5);
    b.rbox(0, 0.06, 0, 0.26, 0.12, 0.2, 0.02, dark());
    for (let i = 0; i < 7; i++) b.cyl(0, 0.13 + i * 0.022, 0, 0.2 - i * 0.012, 0.008, 0.2 - i * 0.012, fin, 0, 0, 0, 14);
    b.cyl(0.14, 0.18, 0, 0.16, 0.05, 0.16, S.plastic(0x1c1c1c), 0, 0, Math.PI / 2, 14);
    return;
  }
  const w = THREE.MathUtils.clamp(0.25 + Math.sqrt(kw) / 30, 0.3, 1.3);
  const h = w * 0.62;
  const t = 0.04 + kw / 4000;
  const stock = !!d.stock;
  const scrap = id === 'rad_scrap';
  const race = id === 'rad_race_m' || id === 'rad_race_l' || id === 'rad_desert';
  const core = scrap ? S.steel(0x5a4a3a, 0.9) : race || id === 'rad_alu' ? alu(0.3) : S.steel(0x3a3d40, 0.7);
  const tankS: Surf = race ? S.paint(id === 'rad_race_m' ? 0xc23a1a : 0xe07a1a, 0.35) : id === 'rad_alu' ? alu(0.25) : scrap ? S.rust(0x6a3a22) : S.plastic(0x141414, 0.5);
  const cores = id === 'rad_desert' ? 2 : 1;
  const y0 = 0.06;
  for (let k = 0; k < cores; k++) {
    const z = -k * (t + 0.04);
    const yc = y0 + h / 2 + 0.03;
    b.rbox(0, yc, z, w, h, t, 0.01, core);
    // Fins and tubes on the face, the ones on a scrap core bent over in patches.
    const n = Math.max(10, Math.round(w / 0.022));
    for (let i = 0; i < n; i++) {
      const x = -w / 2 + ((i + 0.5) * w) / n;
      const bent = scrap && (i % 7 === 2 || i % 11 === 5);
      b.box(x, yc, z + t / 2 + 0.003, 0.006, h * (bent ? 0.6 : 0.96), 0.006, bent ? S.rust(0x5a3a22) : S.steel(0x1c1d1f, 0.6), 0, 0, bent ? 0.4 : 0);
    }
    for (const sx of [1, -1]) b.rbox(sx * (w / 2 + 0.035), yc, z, 0.07, h + 0.04, t + 0.02, 0.015, tankS);
  }
  // Filler neck and cap, hose necks, mounting tabs and rubber feet.
  const yc = y0 + h / 2 + 0.03;
  b.cyl(w / 2 + 0.035, yc + h / 2 + 0.05, 0, 0.06, 0.06, 0.06, steel(0x8a8e92), 0, 0, 0, 10);
  b.cyl(w / 2 + 0.035, yc + h / 2 + 0.085, 0, 0.08, 0.02, 0.08, stock ? S.steel(0x2a2a2a) : chrome(), 0, 0, 0, 12);
  b.cyl(w / 2 + 0.09, yc + h * 0.35, -0.02, 0.05, 0.1, 0.05, steel(), 0, 0, Math.PI / 2, 8);
  b.cyl(-w / 2 - 0.09, yc - h * 0.35, -0.02, 0.05, 0.1, 0.05, steel(), 0, 0, Math.PI / 2, 8);
  for (const sx of [1, -1]) {
    b.box(sx * (w / 2 + 0.035), y0, 0, 0.05, 0.04, 0.04, dark());
    b.cyl(sx * (w / 2 + 0.035), y0 - 0.03, 0, 0.04, 0.04, 0.04, rubber(), 0, 0, 0, 8);
  }
  if (scrap) {
    // Grey epoxy smeared over the leaks.
    b.rbox(-w * 0.2, yc + h * 0.15, t / 2 + 0.006, 0.12, 0.08, 0.012, 0.01, S.plastic(0x8a8a84, 0.8));
    b.rbox(w * 0.25, yc - h * 0.3, t / 2 + 0.006, 0.08, 0.05, 0.012, 0.01, S.plastic(0x8a8a84, 0.8));
  }
  if (race || kw >= 250) {
    // A shroud on the back with one or two electric fans in it.
    const fz = -(cores - 1) * (t + 0.04) - t / 2 - 0.04;
    b.rbox(0, yc, fz, w * 0.96, h * 0.92, 0.04, 0.01, S.plastic(0x141414, 0.5));
    const fans = w > 0.7 ? 2 : 1;
    for (let i = 0; i < fans; i++) {
      const fx = fans === 1 ? 0 : (i ? -1 : 1) * w * 0.24;
      const fr = Math.min(h * 0.42, w * (fans === 1 ? 0.4 : 0.22));
      b.cyl(fx, yc, fz - 0.03, fr * 2, 0.02, fr * 2, dark(), Math.PI / 2, 0, 0, 16);
      for (let k = 0; k < 7; k++) b.box(fx, yc, fz - 0.045, fr * 0.9, 0.006, fr * 0.36, S.plastic(0x202020, 0.5), Math.PI / 2, 0, (k / 7) * Math.PI);
      b.cyl(fx, yc, fz - 0.07, fr * 0.5, 0.06, fr * 0.5, S.steel(0x3a3c3e), Math.PI / 2, 0, 0, 12);
    }
  }
}

// ---------------------------------------------------------------- gearboxes

/**
 * A gearbox on its side as it comes out: the bell housing that bolts to the engine, a ribbed case, the tail housing with
 * the output yoke, the shifter tower and its stick, drain and fill plugs. Its size follows the mass. A close-ratio box is
 * light alloy; an overdrive has the extra unit on its tail; a heavy box is cast iron with a PTO cover; the sequential race
 * box is compact alloy with a gate-less lever and a coloured selector drum; the transfer box has a second case and two
 * outputs. A scooter's is its variator case.
 */
export function gearboxPart(b: MeshBuilder, id: string) {
  const d = partDef(id);
  const mass = d.gearbox?.mass ?? 60;
  if (mass <= 12) {
    // A scooter's or quad's CVT case: a flat teardrop of alloy with the variator cover and a chain sprocket.
    b.rbox(0, 0.12, 0, 0.12, 0.2, 0.42, 0.04, alu(0.5));
    b.cyl(0.07, 0.14, 0.1, 0.18, 0.02, 0.18, S.metal(0x3a3c3e, 0.5), 0, 0, Math.PI / 2, 16);
    b.cyl(0.07, 0.12, -0.13, 0.1, 0.03, 0.1, steel(0x2a2a2a), 0, 0, Math.PI / 2, 10);
    return;
  }
  const s = Math.cbrt(mass / 60);
  const L = 0.55 * s;
  const D = 0.36 * s;
  const iron = id === 'gbx_heavy' || id === 'gbx_truck' || id === 'gbx_rig' || id === 'gbx_transfer';
  const caseS = id === 'gbx_race' ? alu(0.25) : id === 'gbx_sport' ? alu(0.35) : iron ? S.steel(0x4a4d50, 0.75) : S.metal(0x8a8e92, 0.5);
  const yc = D * 0.62 + 0.04;
  // A cradle under it.
  b.rbox(0, 0.02, 0, D * 1.1, 0.04, L * 0.9, 0.01, dark());
  // Bell housing (front, +Z), the main case, the tail.
  b.frustum(0, yc, L / 2 - D * 0.15, D * 0.62, D * 0.42, D * 0.3, caseS, Math.PI / 2, 0, 0, 18);
  b.rbox(0, yc, L * 0.05, D * 0.8, D * 0.78, L * 0.5, 0.03, caseS);
  for (let i = 0; i < 5; i++) b.box(0, yc, L * 0.05 - L * 0.2 + i * L * 0.1, D * 0.84, D * 0.82, 0.012, caseS);
  b.cyl(0, yc - D * 0.05, -L * 0.32, D * 0.36, L * 0.3, D * 0.36, caseS, Math.PI / 2, 0, 0, 12);
  b.cyl(0, yc - D * 0.05, -L / 2 - 0.02, D * 0.3, 0.04, D * 0.3, steel(0x3a3c3e), Math.PI / 2, 0, 0, 10);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    b.cyl(Math.cos(a) * D * 0.12, yc - D * 0.05 + Math.sin(a) * D * 0.12, -L / 2 - 0.045, 0.02, 0.02, 0.02, steel(0x8a8e92), Math.PI / 2, 0, 0, 6);
  }
  // Bell-housing bolts round the rim.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    b.cyl(Math.cos(a) * D * 0.58, yc + Math.sin(a) * D * 0.58, L / 2 - D * 0.02, 0.022, 0.03, 0.022, steel(0x5a5d60), Math.PI / 2, 0, 0, 6);
  }
  // Shifter tower and stick (a sequential's straight lever with a knob; a transfer box has two).
  const sy = yc + D * 0.39;
  b.rbox(0, sy + 0.03, -L * 0.05, D * 0.3, 0.06, D * 0.34, 0.01, caseS);
  const sticks = id === 'gbx_transfer' ? 2 : 1;
  for (let i = 0; i < sticks; i++) {
    const x = sticks === 1 ? 0 : (i ? -1 : 1) * D * 0.08;
    b.rod(x, sy + 0.06, -L * 0.05, x - 0.02, sy + 0.06 + 0.22 * s, -L * 0.05 - 0.04, 0.012, steel(0x2a2a2a), 6);
    b.sphereAt(x - 0.02, sy + 0.08 + 0.22 * s, -L * 0.05 - 0.04, 0.03, id === 'gbx_race' ? S.paint(0xd62a1a, 0.3) : S.plastic(0x1a1a1a, 0.4), false);
  }
  // Drain and fill plugs.
  b.cyl(D * 0.41, yc - D * 0.15, L * 0.1, 0.035, 0.02, 0.035, chrome(), 0, 0, Math.PI / 2, 6);
  b.cyl(0, yc - D * 0.4, L * 0.0, 0.035, 0.02, 0.035, chrome(), 0, 0, 0, 6);
  if (id === 'gbx_overdrive') b.cyl(0, yc - D * 0.05, -L * 0.48, D * 0.48, L * 0.18, D * 0.48, S.metal(0x8a8e92, 0.5), Math.PI / 2, 0, 0, 14);
  if (id === 'gbx_heavy' || id === 'gbx_truck' || id === 'gbx_rig') b.rbox(D * 0.42, yc - D * 0.1, L * 0.05, 0.04, D * 0.4, L * 0.22, 0.008, steel(0x3a3c3e));
  if (id === 'gbx_race') b.cyl(-D * 0.36, yc + D * 0.15, L * 0.1, D * 0.24, L * 0.22, D * 0.24, S.paint(0xe0a01a, 0.3), Math.PI / 2, 0, 0, 12);
  if (id === 'gbx_transfer') {
    b.rbox(-D * 0.1, yc - D * 0.35, -L * 0.42, D * 0.9, D * 0.5, L * 0.22, 0.03, caseS);
    for (const z of [-L * 0.42 + L * 0.12, -L * 0.42 - L * 0.12]) b.cyl(-D * 0.35, yc - D * 0.4, z, D * 0.24, 0.05, D * 0.24, steel(0x3a3c3e), Math.PI / 2, 0, 0, 10);
  }
}

// ---------------------------------------------------------------- springs

/** A coil-over: body, shaft, the coil, the eyes and (on some) a remote reservoir on a hose. */
function coilOver(b: MeshBuilder, x: number, z: number, len: number, r: number, col: Surf, o: { reservoir?: boolean; collar?: boolean } = {}) {
  const y0 = 0.05;
  b.cyl(x, y0 + len * 0.36, z, r * 0.9, len * 0.62, r * 0.9, S.metal(0x2a2c2e, 0.5), 0, 0, 0, 12);
  b.cyl(x, y0 + len * 0.78, z, r * 0.36, len * 0.34, r * 0.36, chrome(), 0, 0, 0, 8);
  const turns = Math.max(5, Math.round(len / 0.05));
  for (let i = 0; i < turns; i++) b.torus(x, y0 + 0.06 + (i / (turns - 1)) * (len - 0.14), z, r, r * 0.16, col, Math.PI / 2, 0, 0, 5, 14);
  for (const y of [y0, y0 + len]) b.torus(x, y, z, r * 0.42, r * 0.16, steel(0x3a3c3e), 0, Math.PI / 2, 0, 6, 12);
  if (o.collar) b.cyl(x, y0 + 0.07, z, r * 2.3, 0.025, r * 2.3, S.paint(0xd62a1a, 0.3), 0, 0, 0, 14);
  if (o.reservoir) {
    b.cyl(x + r * 2.4, y0 + len * 0.45, z, r * 0.9, len * 0.4, r * 0.9, col, 0, 0, 0, 12);
    b.pipe([[x + r * 0.5, y0 + len * 0.12, z], [x + r * 1.6, y0 + len * 0.08, z + 0.04], [x + r * 2.4, y0 + len * 0.25, z]], 0.008, rubber(), 5);
  }
}

/** A leaf spring pack: leaves stepping shorter, the eyes, the centre bolt and its U-bolts. */
function leafPack(b: MeshBuilder, x: number, len: number, leaves: number, w: number) {
  const st = steel(0x4a4d50, 0.75);
  for (let i = 0; i < leaves; i++) {
    const l = len * (1 - i * 0.14);
    b.box(x, 0.04 + i * 0.024 + (leaves - i) * 0.0, 0, w, 0.02, l, st, 0, 0, 0);
  }
  for (const s of [1, -1]) b.torus(x, 0.06 + leaves * 0.024, s * len * 0.5, 0.035, 0.012, st, 0, Math.PI / 2, 0, 5, 10);
  for (const dx of [-w * 0.6, w * 0.6]) b.rod(x + dx, 0.02, 0.05, x + dx, 0.08 + leaves * 0.024, 0.05, 0.008, steel(0x8a8e92), 5);
}

/**
 * Springs, as a pair: the factory struts, a lowered sport coil-over in blue with its adjuster collar, a heavy-duty set of
 * leaf packs with yellow dampers, a long-travel coil-over in green with a remote reservoir, an air bellows on a damper for
 * the big rigs. The truck's and rig's own are leaf packs. Sized from the load they are rated for.
 */
export function springPart(b: MeshBuilder, id: string) {
  const d = partDef(id);
  const load = d.suspension?.load ?? 1700;
  const s = THREE.MathUtils.clamp(Math.cbrt(load / 1700), 0.55, 2.2);
  if (id === 'sus_truck' || id === 'sus_rig' || id === 'sus_heavy') {
    const len = id === 'sus_heavy' ? 0.9 : 0.75 * s;
    for (const x of [-0.16 * s, 0.16 * s]) leafPack(b, x, len, id === 'sus_heavy' ? 7 : 6, 0.07 * s);
    if (id === 'sus_heavy') for (const x of [-0.42, 0.42]) coilOver(b, x, 0, 0.42, 0.04, S.paint(0xe0a01a, 0.35));
    return;
  }
  if (id === 'sus_air') {
    for (const x of [-0.2, 0.2]) {
      b.cyl(x, 0.04, 0, 0.26, 0.04, 0.26, steel(0x3a3c3e), 0, 0, 0, 14);
      for (let i = 0; i < 2; i++) b.add('sphere16', x, 0.14 + i * 0.13, 0, 0.3, 0.16, 0.3, S.rubber(0x1c1c1e));
      b.cyl(x, 0.36, 0, 0.26, 0.04, 0.26, steel(0x3a3c3e), 0, 0, 0, 14);
      b.cyl(x + 0.18, 0.2, 0.04, 0.012, 0.3, 0.012, S.paint(0x1e4a8a, 0.4), 0, 0, 0.6, 6);
    }
    coilOver(b, 0, 0.18, 0.4, 0.035, S.paint(0x1c1c1e, 0.4));
    return;
  }
  const len = id === 'sus_long' ? 0.62 : id === 'sus_sport' ? 0.34 : 0.42 * s;
  const r = (id === 'sus_long' ? 0.055 : 0.045) * Math.min(1.3, s);
  const col = id === 'sus_sport' ? S.paint(0x3a6ab8, 0.35) : id === 'sus_long' ? S.paint(0x2a7a3a, 0.35) : d.stock ? S.paint(0x2a2a2a, 0.6) : S.paint(0xb8321e, 0.4);
  for (const x of [-0.14, 0.14]) {
    coilOver(b, x, 0, len, r, col, { reservoir: id === 'sus_long', collar: id === 'sus_sport' });
    if (d.stock) b.cyl(x, 0.05 + len + 0.02, 0, r * 2.6, 0.03, r * 2.6, rubber(), 0, 0, 0, 12);
  }
}

// ---------------------------------------------------------------- brakes

/**
 * A brake standing on its edge: the disc (vented, drilled and slotted at the better grades) with its hat, and the caliper
 * over the top: a single-piston sliding caliper in bare iron, a four-pot in yellow, a six-pot race caliper in red. A truck's
 * air brake is a drum with its air chamber and slack adjuster. Sized from the energy it is rated to soak.
 */
export function brakePart(b: MeshBuilder, id: string) {
  const d = partDef(id);
  const energy = d.brakes?.energy ?? 800;
  const r = THREE.MathUtils.clamp(0.06 + 0.04 * Math.cbrt(energy / 100), 0.08, 0.24);
  const yc = r + 0.03;
  b.rbox(0, 0.015, 0, 0.12, 0.03, r * 1.6, 0.01, dark());
  if (id === 'brk_air' || id === 'brk_truck' || id === 'brk_rig') {
    b.cyl(0, yc, 0, r * 2, r * 0.8, r * 2, S.steel(0x4a4d50, 0.8), 0, 0, Math.PI / 2, 20);
    for (let i = 0; i < 6; i++) b.box(0, yc, 0, r * 0.82, 0.012, r * 2.02, S.steel(0x3a3c3e), (i / 6) * Math.PI, 0, 0);
    b.cyl(r * 0.5, yc + r * 0.9, -r * 0.6, r * 0.7, r * 0.5, r * 0.7, S.paint(0x2a2a2a, 0.5), 0, 0, Math.PI / 2, 14);
    b.rod(r * 0.3, yc + r * 0.9, -r * 0.6, r * 0.2, yc + r * 0.3, -r * 0.2, 0.012, steel(), 5);
    b.pipe([[r * 0.6, yc + r * 1.2, -r * 0.6], [r * 0.6, yc + r * 1.5, -r * 0.2]], 0.01, rubber(), 5);
    return;
  }
  const mk = d.stock ? 0 : d.mk;
  const disc = mk >= 2 ? S.metal(0x9a9ea2, 0.35) : S.metal(0x7a7e82, 0.6);
  b.cyl(0, yc, 0, r * 2, 0.026 * (r / 0.14), r * 2, disc, 0, 0, Math.PI / 2, 26);
  b.cyl(0, yc, 0, r * 0.95, 0.06, r * 0.95, steel(0x3a3d40, 0.7), 0, 0, Math.PI / 2, 16);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    b.cyl(0.03, yc + Math.sin(a) * r * 0.32, Math.cos(a) * r * 0.32, 0.024, 0.02, 0.024, chrome(), 0, 0, Math.PI / 2, 6);
  }
  if (mk >= 2) {
    // Cross-drilled holes in rings, and slots on the race disc.
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      const rr = r * (i % 2 ? 0.66 : 0.8);
      b.cyl(0.014, yc + Math.sin(a) * rr, Math.cos(a) * rr, 0.016, 0.006, 0.016, S.metal(0x0a0a0a, 0.2), 0, 0, Math.PI / 2, 6);
    }
    if (mk >= 3) for (let i = 0; i < 6; i++) b.box(0.014, yc, 0, 0.004, r * 0.3, 0.006, S.metal(0x0a0a0a, 0.2), (i / 6) * Math.PI * 2, 0, 0);
  }
  // The caliper, straddling the top of the disc.
  const pots = mk >= 3 ? 6 : mk === 2 ? 4 : 1;
  const cw = r * (pots >= 4 ? 1.1 : 0.7);
  const col = mk >= 3 ? S.paint(0xd62a1a, 0.3) : mk === 2 ? S.paint(0xe0a01a, 0.3) : S.steel(0x5a5d60, 0.8);
  b.rbox(0, yc + r * 0.86, 0, 0.09 + pots * 0.008, r * 0.36, cw, 0.015, col);
  if (pots >= 4) for (const s of [1, -1]) b.box(s * 0.05, yc + r * 0.86, 0, 0.004, r * 0.08, cw * 0.6, S.paint(0xf0ece0, 0.4));
  if (id === 'brk_sport') b.pipe([[0.05, yc + r, 0], [0.08, yc + r * 1.25, -r * 0.4], [0.1, yc + r * 1.1, -r * 0.8]], 0.007, S.metal(0xa8acb0, 0.3), 5);
}

// ---------------------------------------------------------------- exhausts

/**
 * An exhaust as it comes off: the factory system's pipe and silencer box (a truck's vertical stack and guard), a free-flow
 * pipe with a big chrome tip, a silenced one's fat oval box, a race header's four primaries into a collector in blued steel,
 * a pair of straight-pipe stacks with their rain caps. Rusty and patched on the factory ones.
 */
export function exhaustPart(b: MeshBuilder, id: string) {
  const owner = ownerOf(id);
  const tube = (c: number, w = 0.75) => S.metal(c, w);
  if (owner === 'truck' || owner === 'rig') {
    const h = owner === 'rig' ? 1.6 : 1.2;
    b.rbox(0, 0.03, 0, 0.3, 0.06, 0.3, 0.01, dark());
    b.cyl(0, h / 2, 0, 0.12, h, 0.12, chrome(), 0, 0, 0, 12);
    b.cyl(0, h * 0.55, 0, 0.2, h * 0.5, 0.2, S.steel(0x8a8e92, 0.5), 0, 0, 0, 14);
    for (let i = 0; i < 5; i++) b.cyl(0, h * 0.32 + i * h * 0.11, 0, 0.205, 0.01, 0.205, dark(), 0, 0, 0, 14);
    b.cyl(0, h + 0.02, -0.03, 0.16, 0.01, 0.17, dark(), 0.5, 0, 0, 12);
    return;
  }
  if (id === 'exh_race') {
    const blue = S.metal(0x4a5a7a, 0.3);
    for (let i = 0; i < 4; i++) {
      const x = -0.27 + i * 0.18;
      b.pipe([[x, 0.42, 0.3], [x, 0.36, 0.18], [x * 0.5, 0.22, 0.02], [0, 0.16, -0.16]], 0.022, blue, 8);
      b.box(x, 0.44, 0.3, 0.12, 0.08, 0.02, S.steel(0x6a6e72, 0.5));
    }
    b.cyl(0, 0.15, -0.3, 0.09, 0.3, 0.09, blue, Math.PI / 2, 0, 0, 12);
    b.cyl(0, 0.15, -0.47, 0.11, 0.04, 0.11, S.steel(0x3a3c3e), Math.PI / 2, 0, 0, 12);
    return;
  }
  if (id === 'exh_stack') {
    for (const x of [-0.18, 0.18]) {
      b.pipe([[x, 0.08, 0.2], [x, 0.1, 0.0], [x, 0.9, -0.05]], 0.045, chrome(), 10);
      b.cyl(x, 0.6, -0.05, 0.12, 0.42, 0.12, S.steel(0x8a8e92, 0.5), 0, 0, 0, 12);
      b.cyl(x, 0.93, -0.08, 0.1, 0.008, 0.11, dark(), 0.6, 0, 0, 10);
    }
    b.rod(-0.18, 0.4, -0.05, 0.18, 0.4, -0.05, 0.015, dark(), 6);
    return;
  }
  // A pipe and a box along Z: front pipe with its flange, a box, a tail pipe and tip.
  const quiet = id === 'exh_quiet';
  const free = id === 'exh_free';
  const small = owner === 'moped' || owner === 'quad' || owner === 'trike';
  // Each chassis' own system is its own size: a hatch's is a tin can, a van's a long box, a scooter's a stub.
  const k = ({ moped: 0.7, quad: 0.85, trike: 1, hatch: 0.82, sedan: 1, pickup: 1.18, van: 1.1, buggy: 1.08 } as Record<string, number>)[owner ?? ''] ?? 1;
  const pr = (small ? 0.016 : 0.026) * Math.sqrt(k);
  const pipe = free ? tube(0x8a8e92, 0.5) : tube(0x6e5a4a, 0.85);
  b.pipe([[0, 0.12, 0.42], [0, 0.1, 0.2], [0, 0.1, 0.0]], pr, pipe, 8);
  b.cyl(0, 0.12, 0.44, pr * 4, 0.012, pr * 4, steel(0x5a5d60), Math.PI / 2, 0, 0, 10);
  if (quiet) b.add('sphere16', 0, 0.13, -0.15, 0.32, 0.2, 0.48, S.steel(0x4a4d50, 0.8));
  else if (free) b.cyl(0, 0.11, -0.1, 0.1, 0.22, 0.1, alu(0.4), Math.PI / 2, 0, 0, 14);
  else b.rbox(0, 0.12, -0.12, (small ? 0.12 : 0.24) * k, (small ? 0.1 : 0.14) * k, (small ? 0.22 : 0.36) * k, 0.04, S.steel(0x5a5050, 0.85));
  if (owner === 'buggy') b.cyl(0.06, 0.11, -0.46, pr * 2.4, 0.06, pr * 2.4, chrome(), Math.PI / 2, 0, 0, 10);
  b.pipe([[0, 0.11, -0.3], [0, 0.11, -0.44]], pr, pipe, 8);
  if (free) b.cyl(0, 0.11, -0.5, pr * 4.4, 0.14, pr * 4.4, chrome(), Math.PI / 2, 0, 0, 14);
  else b.cyl(0, 0.11, -0.46, pr * 2.4, 0.04, pr * 2.4, S.metal(0x1a1612, 0.9), Math.PI / 2, 0, 0, 10);
  if (owner && !small) {
    // Rust and a bandage of exhaust tape on the old ones.
    b.rbox(0.05, 0.16, -0.12, 0.06, 0.04, 0.12, 0.01, S.rust(0x6a3a22));
    b.cyl(0, 0.1, 0.1, pr * 2.6, 0.06, pr * 2.6, S.cloth(0xc8c0a8, 0.8), Math.PI / 2, 0, 0, 10);
  }
  for (const s of [1, -1]) b.box(0, 0.03, s * 0.25, 0.06, 0.06, 0.04, S.wood(0x6a5238, 0.8));
}

// ---------------------------------------------------------------- body panels

/** A bonnet lying face up on two chocks: pressed with a crease, hinge tabs and the latch, and its variant on top. */
export function hoodPart(b: MeshBuilder, id: string) {
  const r = (n: number) => (Math.sin(n * 91.7 + id.length * 13.1) + 1) / 2;
  const pan = id === 'hood_armor' ? S.steel(0x4a4d50, 0.8) : S.paint([0x7a8a98, 0xb85f2e, 0x5c6b3e, 0xc9b084][Math.floor(r(1) * 4)], 0.65);
  const W = 1.2;
  const L = 0.95;
  for (const s of [1, -1]) b.box(s * W * 0.32, 0.03, 0, 0.12, 0.06, L * 0.7, S.wood(0x6a5238, 0.8));
  b.rbox(0, 0.09, 0, W, 0.04, L, 0.02, pan, 0.02, 0, 0);
  b.rbox(0, 0.11, 0, W * 0.5, 0.02, L * 0.86, 0.01, pan);
  b.box(0, 0.067, 0, W * 0.92, 0.008, L * 0.9, S.plastic(0x2a2622, 0.9));
  for (const s of [1, -1]) b.box(s * W * 0.4, 0.07, -L / 2 + 0.03, 0.08, 0.03, 0.06, dark());
  b.box(0, 0.07, L / 2 - 0.04, 0.06, 0.03, 0.05, steel(0x8a8e92));
  if (id === 'hood_vent') {
    for (let i = 0; i < 6; i++) for (const s of [1, -1]) b.box(s * 0.28, 0.122, -0.28 + i * 0.11, 0.3, 0.016, 0.03, S.plastic(0x0c0c0c), 0, 0, s * 0.08);
  } else if (id === 'hood_scoop') {
    b.rbox(0, 0.17, 0.05, 0.4, 0.12, 0.42, 0.04, pan, -0.08, 0, 0);
    b.box(0, 0.17, 0.27, 0.32, 0.08, 0.02, S.plastic(0x0c0c0c));
  } else if (id === 'hood_armor') {
    plate(b, 0, 0.13, 0, W * 0.98, L * 0.94, 0.03, S.steel(0x4a4d50, 0.85), -Math.PI / 2, 0, 0);
    b.rbox(0, 0.16, L / 2 - 0.08, W * 0.9, 0.05, 0.06, 0.015, dark());
  } else if (id === 'hood_cut') {
    b.box(0, 0.115, 0.05, 0.56, 0.006, 0.46, S.metal(0x0a0a0a, 0.2));
    for (let i = 0; i < 10; i++) b.rbox(-0.25 + (i % 5) * 0.125, 0.14, i < 5 ? 0.28 : -0.18, 0.06, 0.006, 0.08, 0.002, i % 3 ? S.steel(0x8a8e92, 0.9) : S.rust(0x7a3f22), 0.6 * (i < 5 ? -1 : 1), 0, 0);
  }
}

/** A door standing on its bottom edge: the skin, the window frame (glass, canvas or a slit), handle and hinges. */
export function doorPart(b: MeshBuilder, id: string) {
  const L = 0.95;
  const H = 0.62;
  const skin = id === 'door_armor' ? S.steel(0x3a3d40, 0.85) : id === 'door_plate' ? S.steel(0x5a5d60, 0.8) : S.paint(0x7a8a98, 0.6);
  for (const s of [1, -1]) b.box(0, 0.03, s * L * 0.35, 0.16, 0.06, 0.1, S.wood(0x6a5238, 0.8));
  if (id === 'door_light') {
    // A roll-up canvas door on a bent-tube frame.
    const tube = steel(0x2a2c2e, 0.6);
    b.pipe([[0, 0.06, L / 2], [0, H + 0.4, L / 2 - 0.1], [0, H + 0.42, -L / 2 + 0.05], [0, 0.06, -L / 2], [0, 0.06, L / 2]], 0.016, tube, 6);
    b.rbox(0.01, (H + 0.1) / 2 + 0.03, 0, 0.02, H, L * 0.9, 0.01, S.cloth(0x8a7a52, 0.9));
    b.capsule(0.02, H + 0.36, -L * 0.42, 0.02, H + 0.36, L * 0.38, 0.04, S.cloth(0x8a7a52, 0.9), 8);
    return;
  }
  b.rbox(0, H / 2 + 0.06, 0, 0.09, H, L, 0.02, skin);
  // The window frame over the skin, with its glass or a vision slit on the armoured one.
  b.pipe([[0, H + 0.06, L / 2 - 0.04], [0, H + 0.44, L / 2 - 0.22], [0, H + 0.46, -L / 2 + 0.06], [0, H + 0.06, -L / 2 + 0.04]], 0.02, skin, 6);
  if (id === 'door_armor') {
    plate(b, 0.03, H / 2 + 0.08, 0, L * 0.94, H * 1.02, 0.04, skin, 0, Math.PI / 2, 0);
    b.box(0.055, H * 0.78, 0, 0.01, 0.04, L * 0.6, S.glass(0x10181c));
  } else {
    b.box(0, H + 0.24, -0.04, 0.012, 0.32, L * 0.78, S.glass(0x2a3e4c));
    if (id === 'door_plate') {
      plate(b, 0.035, H / 2 + 0.06, 0, L * 0.84, H * 0.82, 0.025, skin, 0, Math.PI / 2, 0);
      rivets(b, [0.055, H * 0.86, -L * 0.36], [0.055, H * 0.86, L * 0.36], 6);
    }
  }
  b.box(0.05, H * 0.82, -L * 0.3, 0.02, 0.03, 0.14, chrome());
  for (const y of [H * 0.25, H * 0.8]) b.cyl(-0.02, y, L / 2, 0.04, 0.1, 0.04, steel(0x5a5d60), 0, 0, 0, 8);
}

// ---------------------------------------------------------------- armour

/**
 * Armour as it comes in its bundle: scrap is a pile of whatever it was cut from (rusty sheet, a road sign, a car panel) wired
 * together; a workshop kit is a stack of square-cut plates in primer with the weld bead already on their edges; the ceramic
 * kit is a palletised panel of composite tiles bolted to a backing plate.
 */
export function armourPart(b: MeshBuilder, id: string) {
  if (id === 'arm_ceramic') {
    b.rbox(0, 0.04, 0, 0.9, 0.08, 0.7, 0.01, S.wood(0x6a5238, 0.8));
    b.box(0, 0.11, 0, 0.84, 0.05, 0.64, S.steel(0x2a2c2e, 0.7));
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 3; j++) {
        const x = -0.31 + i * 0.207;
        const z = -0.2 + j * 0.2;
        b.box(x, 0.155, z, 0.195, 0.04, 0.19, (i + j) % 2 ? S.paint(0xb4ac90, 0.4) : S.paint(0xa49c80, 0.45));
        b.add('ico', x + 0.08, 0.18, z + 0.08, 0.022, 0.022, 0.022, S.steel(0x3a3c3e));
      }
    }
    return;
  }
  if (id === 'arm_weld') {
    for (let i = 0; i < 3; i++) {
      const y = 0.05 + i * 0.045;
      b.box(0.02 * (i - 1), y, 0.015 * i, 0.82, 0.03, 0.6, S.paint(0x6a6c68, 0.5));
      for (const s of [1, -1]) b.box(0.02 * (i - 1) + s * 0.405, y, 0.015 * i, 0.012, 0.034, 0.58, S.metal(0x5a524a, 0.7));
    }
    for (const s of [1, -1]) b.rod(s * 0.3, 0.02, -0.32, s * 0.3, 0.2, -0.32, 0.012, dark(), 5);
    return;
  }
  // Scrap: three odd sheets leaning together, one of them a road sign, tied with wire.
  plate(b, 0, 0.32, 0.02, 0.78, 0.55, 0.025, S.rust(0x6a3a22), -0.2, 0.05, 0.04, false);
  signPlate(b, 0.04, 0.3, -0.06, 0.72, 0.5, 0xe8c030, -0.12, -0.06, -0.03);
  plate(b, -0.02, 0.28, -0.14, 0.7, 0.46, 0.025, S.paint(0x4d6a82, 0.85), -0.06, 0.04, 0.02, false);
  for (const s of [1, -1]) b.rod(s * 0.3, 0.05, -0.2, s * 0.3, 0.55, 0.1, 0.004, steel(0x8a8e92, 0.5), 4);
}
