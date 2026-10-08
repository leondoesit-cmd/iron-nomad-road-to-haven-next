import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GUN_MODELS, type GunModel } from '../src/data/gear';
import { weaponGeometry, type Held } from '../src/render/humanoid';
import { ANCHORS, muzzleAt, sightLine } from '../src/render/gunMods';
import { buildModel } from '../src/render/weapons';
import { FRAMES } from '../src/sim/gunFrames';
import { GUN_POINTS } from '../src/sim/weaponanim';

const MELEE: Exclude<Held, 'none'>[] = ['knife', 'bat', 'machete', 'axe', 'pipe', 'sledge', 'katana', 'wrench', 'crowbar', 'jerrycan', 'flare'];
const ALL: Exclude<Held, 'none'>[] = [...GUN_MODELS, ...MELEE];
const tris = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.attributes.position.count) / 3;
const box = (g: THREE.BufferGeometry) => {
  g.computeBoundingBox();
  return g.boundingBox!.clone();
};

describe('the weapon models', () => {
  it('every weapon builds in both levels of detail, within its triangle budget, with its finish attribute', () => {
    for (const k of ALL) {
      const hi = weaponGeometry(k, '', 'hi');
      const lo = weaponGeometry(k, '', 'lo');
      expect(tris(hi), k).toBeGreaterThan(400);
      // The close-up model: detailed but bounded; the light one for other hands and the street.
      expect(tris(hi), k).toBeLessThan(13000);
      // (The bow's one-piece model is the rig's own, the same in both.)
      if (k !== 'bow') {
        expect(tris(lo), k).toBeLessThan(2000);
        expect(tris(lo), k).toBeLessThan(tris(hi));
      }
      for (const g of [hi, lo]) {
        expect(g.attributes.wpn?.count, k).toBe(g.attributes.position.count);
        const p = g.attributes.position.array as Float32Array;
        for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i])) throw new Error(`${k}: non-finite position`);
      }
      // The two levels are the same object: their bounds agree to a centimetre or so.
      const a = box(hi);
      const b = box(lo);
      expect(a.min.distanceTo(b.min), k).toBeLessThan(0.02);
      expect(a.max.distanceTo(b.max), k).toBeLessThan(0.02);
    }
  });

  it('geometry is cached per weapon, add-ons and level of detail', () => {
    expect(weaponGeometry('ar', '', 'hi')).toBe(weaponGeometry('ar', '', 'hi'));
    expect(weaponGeometry('ar', '', 'hi')).not.toBe(weaponGeometry('ar', '', 'lo'));
    expect(weaponGeometry('ar', 'optic:dot', 'hi')).not.toBe(weaponGeometry('ar', '', 'hi'));
  });

  it('every gun is drawn to its frame: the muzzle at the front, the sights on top, grips and anchors on the gun', () => {
    for (const m of GUN_MODELS) {
      if (m === 'bow') continue;
      const g = weaponGeometry(m, '', 'hi');
      const bb = box(g).expandByScalar(0.006);
      const f = FRAMES[m];
      const pts = GUN_POINTS[m];
      // The muzzle is the front of the gun (a crossbow's bolt tip; a stirrup may stand a little beyond it).
      expect(Math.abs(bb.max.z - 0.006 - pts.muzzle[2]), m).toBeLessThan(m === 'crossbow' ? 0.08 : 0.012);
      // The sights (or a built-in scope's axis) are within the gun's bounds, near its top.
      for (const p of [pts.rear, pts.front]) expect(bb.containsPoint(new THREE.Vector3(...p)), `${m} sight`).toBe(true);
      expect(bb.max.y - pts.rear[1], m).toBeLessThan(0.05);
      // The grip, the support hand, the port and the well are on the gun.
      for (const [n, p] of [['grip', f.grip.p], ['support', f.support], ['port', pts.port], ['well', pts.well]] as const) if (p) expect(bb.containsPoint(new THREE.Vector3(...p)), `${m} ${n}`).toBe(true);
      // The add-on anchors are on the gun too.
      const A = ANCHORS[m];
      for (const [n, p] of [['top', [0, A.top.y, A.top.z]], ['under', [0, A.under.y, A.under.z]], ['mag', [0, A.mag.y, A.mag.z]], ['stock', [0, A.stock.y, A.stock.z]], ['side', [A.side.x, A.side.y, A.side.z]]] as const) expect(bb.containsPoint(new THREE.Vector3(...(p as [number, number, number]))), `${m} anchor ${n}`).toBe(true);
      expect(muzzleAt(m, {}).z, m).toBeCloseTo(pts.muzzle[2], 6);
    }
  });

  it('grips rake back the way real ones do: the bottom of the grip behind its top', () => {
    for (const m of GUN_MODELS) {
      if (m === 'bow') continue;
      const a = FRAMES[m].grip.a;
      expect(a[1], m).toBeGreaterThan(0.6);
      // Going up the grip leads forward (+z).
      expect(a[2], m).toBeGreaterThan(0.1);
    }
  });

  it('a fitted optic is aimed through: the sight line moves onto its axis, above the rail, and the gun grows its solids', () => {
    for (const [m, optic] of [['ar', 'dot'], ['ar', 'holo'], ['pistol', 'pdot'], ['rifle', 'scope4'], ['sniper', 'scope8'], ['dmr', 'reflex']] as [GunModel, string][]) {
      const s = sightLine(m, { optic });
      expect(s.rear[1], `${m} ${optic}`).toBeGreaterThan(ANCHORS[m].top.y);
      expect(s.front[2], `${m} ${optic}`).toBeGreaterThan(s.rear[2]);
      expect(Math.abs(s.front[1] - s.rear[1])).toBeLessThan(1e-9);
      const bb = box(weaponGeometry(m, `optic:${optic}`, 'hi')).expandByScalar(0.005);
      expect(bb.containsPoint(new THREE.Vector3(...s.rear)), `${m} ${optic}`).toBe(true);
    }
    expect(sightLine('ar', {})).toEqual({ rear: GUN_POINTS.ar.rear, front: GUN_POINTS.ar.front });
  });

  it('nothing solid sits on an optic\'s axis between its ends, so the eye can see through it', () => {
    for (const [m, optic] of [['ar', 'dot'], ['ar', 'holo'], ['ar', 'scope4'], ['pistol', 'pdot'], ['dmr', 'reflex']] as [GunModel, string][]) {
      const g = weaponGeometry(m, `optic:${optic}`, 'hi');
      const s = sightLine(m, { optic });
      const ray = new THREE.Raycaster(new THREE.Vector3(s.rear[0], s.rear[1], s.rear[2] - 0.3), new THREE.Vector3(0, 0, 1), 0, 0.3 + (s.front[2] - s.rear[2]) - 0.012);
      const P = g.attributes.position;
      const t = new THREE.Triangle();
      // The lit reticle (a dot of a millimetre or two, a hairline) is meant to be on the axis: anything bigger is not.
      const hits = ray.intersectObject(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))).filter((h) => {
        t.setFromAttributeAndIndices(P, h.face!.a, h.face!.b, h.face!.c);
        return t.getArea() > 4e-6;
      });
      expect(hits.length, `${m} ${optic}`).toBe(0);
    }
  });

  it('the built-in scopes come off when another optic goes on, and a whole stock replaces the gun\'s own', () => {
    const bare = tris(weaponGeometry('rifle', '', 'lo'));
    const withDot = buildModel('rifle', 'lo', { optic: 'dot' })!.build();
    expect(tris(withDot)).toBeLessThan(bare);
    const own = buildModel('ar', 'hi', {})!.build();
    const swapped = buildModel('ar', 'hi', { stock: 'stock_h' })!.build();
    expect(tris(swapped)).toBeLessThan(tris(own));
  });

  it('a suppressor moves the muzzle out to its end', () => {
    expect(muzzleAt('pistol', { muzzle: 'supp_s' }).z).toBeGreaterThan(muzzleAt('pistol', {}).z + 0.1);
    // The same add-on on two guns is drawn at each one's own muzzle (its parts are not shared between them).
    for (const m of ['ar', 'sniper', 'dmr'] as GunModel[]) {
      const g = box(weaponGeometry(m, 'muzzle:supp_l', 'hi'));
      expect(Math.abs(g.max.z - muzzleAt(m, { muzzle: 'supp_l' }).z), m).toBeLessThan(0.01);
    }
  });
});
