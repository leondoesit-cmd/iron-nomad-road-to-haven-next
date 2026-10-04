import { MeshBuilder, S } from './builder';
import { strap } from './parts';
import { partDef } from '../data';
import type { Mounts } from './attachments';

/**
 * Cargo holders you can see: roof baskets and the rack with its net, the rear carrier cage, and the bed tie-downs and net.
 * One set of drawing functions serves the car (`attachments.ts` calls `basketOn`, `cageOn` and `bedKitOn` with the chassis'
 * mount numbers) and the part in your arms or on the ground (`holderPartModel`, called from `partModels.ts`).
 */

const rail = () => S.steel(0x2e3032, 0.65);
const wire = () => S.steel(0x4a4e50, 0.7);
const cord = () => S.cloth(0xd6a21e, 0.6);
const netCol = () => S.cloth(0x3b4a2a, 0.9);

/** Is this part one of the holders drawn here (basket, net rack, cage, bed kit)? The jerrycan rack and spare carrier have their own models. */
export const isHolderModel = (id: string): boolean => /^(rf_basket|rf_net|rr_cage|utl_tie|utl_net)/.test(id);

interface Box {
  y: number;
  z0: number;
  z1: number;
  hw: number;
}

/** A wire basket on legs: floor grid, rim, posts, and a net over the top for the better ones. */
function basket(b: MeshBuilder, r: Box, o: { h: number; nx: number; nz: number; net: boolean; strapped: boolean; legs: boolean; col: ReturnType<typeof wire> }) {
  const { y, z0, z1, hw } = r;
  const L = z1 - z0;
  if (o.legs) for (const sx of [1, -1]) for (const z of [z0 + 0.04, z1 - 0.04]) b.rod(sx * hw, y - 0.16, z, sx * hw, y, z, 0.016, rail(), 6);
  // Floor.
  for (let i = 0; i < o.nz; i++) {
    const z = z0 + (i / (o.nz - 1)) * L;
    b.rod(-hw, y, z, hw, y, z, 0.008, o.col, 5);
  }
  for (let i = 0; i < o.nx; i++) {
    const x = -hw + (i / (o.nx - 1)) * hw * 2;
    b.rod(x, y, z0, x, y, z1, 0.008, o.col, 5);
  }
  // Rim at the top and one wire part way up.
  const top = y + o.h;
  const ring = (yy: number, rr: number) => b.pipe([[hw, yy, z0], [hw, yy, z1], [-hw, yy, z1], [-hw, yy, z0], [hw, yy, z0]], rr, rail(), 6);
  ring(top, 0.014);
  ring(y + o.h * 0.5, 0.008);
  ring(y + 0.01, 0.012);
  // Posts.
  const nzp = Math.max(2, Math.round(L / 0.3));
  for (let i = 0; i < nzp; i++) {
    const z = z0 + (i / (nzp - 1)) * L;
    for (const sx of [1, -1]) b.rod(sx * hw, y, z, sx * hw, top, z, 0.01, o.col, 5);
  }
  for (const z of [z0, z1]) for (let i = 0; i < 4; i++) {
    const x = -hw + (i / 3) * hw * 2;
    b.rod(x, y, z, x, top, z, 0.008, o.col, 5);
  }
  if (o.net) {
    // Net across the top: crossed cords, tied at the rim.
    const n = 6;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      b.rod(-hw, top + 0.012, z0 + t * L, hw, top + 0.012, z0 + t * L, 0.005, netCol(), 4);
      b.rod(-hw + t * hw * 2, top + 0.014, z0, -hw + t * hw * 2, top + 0.014, z1, 0.005, netCol(), 4);
    }
  }
  if (o.strapped) {
    const zc = (z0 + z1) / 2;
    strap(b, [[-hw, top, zc - 0.1], [-hw, top + 0.1, zc - 0.1], [hw, top + 0.1, zc - 0.1], [hw, top, zc - 0.1]]);
    strap(b, [[-hw, top, zc + 0.12], [-hw, top + 0.1, zc + 0.12], [hw, top + 0.1, zc + 0.12], [hw, top, zc + 0.12]]);
  }
}

/** What each roof holder looks like (the chassis' roof numbers in, the model out). */
export function basketOn(b: MeshBuilder, ro: Box, id: string) {
  const r: Box = { y: ro.y + 0.14, z0: ro.z0 + 0.04, z1: ro.z1 - 0.04, hw: ro.hw };
  if (id === 'rf_rack') basket(b, r, { h: 0.04, nx: 2, nz: 5, net: false, strapped: true, legs: true, col: rail() });
  else if (id === 'rf_net') basket(b, r, { h: 0.1, nx: 3, nz: 5, net: true, strapped: false, legs: true, col: rail() });
  else if (id === 'rf_basket') basket(b, r, { h: 0.2, nx: 4, nz: 6, net: false, strapped: false, legs: true, col: wire() });
  else if (id === 'rf_basket2') basket(b, r, { h: 0.3, nx: 5, nz: 7, net: false, strapped: true, legs: true, col: S.steel(0x3a3e40, 0.6) });
  else basket(b, { ...r, y: r.y + 0.01 }, { h: 0.36, nx: 6, nz: 8, net: true, strapped: true, legs: true, col: S.paint(0x2a2c2e, 0.55) });
}

/** The rear cage behind the bumper. `rear` is the chassis' tail. */
export function cageOn(b: MeshBuilder, m: Pick<Mounts, 'rear'>, id: string) {
  const heavy = id === 'rr_cage2';
  const z1 = m.rear.z - 0.04;
  const z0 = z1 - (heavy ? 0.6 : 0.46);
  const hw = Math.max(0.12, m.rear.hw * 0.78);
  const y = m.rear.y + 0.06;
  // A carrier arm from each side of the bumper.
  for (const sx of [1, -1]) b.rod(sx * hw * 0.9, y + 0.02, z1 + 0.06, sx * hw * 0.9, y + 0.02, z0, 0.02, rail(), 6);
  basket(b, { y, z0, z1, hw }, { h: heavy ? 0.34 : 0.24, nx: heavy ? 5 : 4, nz: heavy ? 6 : 5, net: false, strapped: heavy, legs: false, col: heavy ? S.steel(0x3a3e40, 0.6) : wire() });
}

/** Tie-down eyes along the bed's walls, straps across the bed, and a net for the better kit. */
export function bedKitOn(b: MeshBuilder, m: Pick<Mounts, 'trunk'>, id: string) {
  const t = m.trunk;
  if (!t) return;
  const y = t.y;
  const net = id === 'utl_net';
  const hw = t.hw * 0.96;
  const n = net ? 5 : 3;
  for (let i = 0; i < n; i++) {
    const z = t.z0 + 0.12 + (i / (n - 1)) * (t.z1 - t.z0 - 0.24);
    for (const sx of [1, -1]) b.box(sx * hw, y + 0.06, z, 0.04, 0.04, 0.04, rail());
  }
  if (net) {
    const top = y + 0.46;
    const k = 7;
    for (let i = 0; i <= k; i++) {
      const f = i / k;
      b.rod(-hw, top, t.z0 + 0.1 + f * (t.z1 - t.z0 - 0.2), hw, top, t.z0 + 0.1 + f * (t.z1 - t.z0 - 0.2), 0.006, netCol(), 4);
      b.rod(-hw + f * hw * 2, top, t.z0 + 0.1, -hw + f * hw * 2, top, t.z1 - 0.1, 0.006, netCol(), 4);
    }
    for (const sx of [1, -1]) b.rod(sx * hw, y + 0.06, t.z0 + 0.1, sx * hw, top, t.z0 + 0.1, 0.006, netCol(), 4);
  } else {
    for (const z of [t.z0 + 0.35, t.z1 - 0.35]) strap(b, [[-hw, y + 0.06, z], [-hw, y + 0.34, z], [hw, y + 0.34, z], [hw, y + 0.06, z]]);
  }
}

/** The part off the car: in the arms and on the ground. Origin is the middle of the base, about 0.8 m across. */
export function holderPartModel(b: MeshBuilder, id: string) {
  const d = partDef(id);
  if (d.hold?.zone === 'roof') {
    basketOn(b, { y: 0.04, z0: -0.4, z1: 0.4, hw: 0.4 }, id);
  } else if (d.hold?.zone === 'carrier') {
    cageOn(b, { rear: { z: 0.3, y: 0, hw: 0.4 } }, id);
  } else {
    // Bed kit: a folded net or a coil of straps with ratchets and hooks.
    const net = id === 'utl_net';
    b.rbox(0, 0.06, 0, 0.5, 0.1, 0.38, 0.04, net ? netCol() : cord());
    for (let i = 0; i < 4; i++) b.rod(-0.2 + i * 0.13, 0.12, -0.15, -0.2 + i * 0.13, 0.12, 0.15, 0.006, net ? S.cloth(0x2a3820, 0.9) : S.cloth(0xb08818, 0.6), 4);
    for (const sx of [1, -1]) {
      b.cyl(sx * 0.2, 0.14, 0.16, 0.06, 0.03, 0.06, S.steel(0x7a7e82, 0.4), Math.PI / 2, 0, 0, 8);
      b.box(sx * 0.2, 0.09, 0.2, 0.04, 0.05, 0.03, rail());
    }
  }
}
