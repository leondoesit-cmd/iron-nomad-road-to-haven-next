import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { initPhysics } from '../src/physics/physics';
import { HEROES, legById } from '../src/data';
import { Campaign, heroLoadout } from '../src/game/campaign';
import { LegScene } from '../src/game/legScene';
import { Humanoid, type Palette } from '../src/render/humanoid';
import { HERO_LOOKS, RIG_HEIGHT } from '../src/render/heroLooks';
import { identityOf, lookOf } from '../src/render/outfit';
import { FacePainter, TEX_H, TEX_W, beardCover, paintPortraitNow, portraitGeometry, scalpCover } from '../src/render/portrait';
import { newGear, starterLoadout } from '../src/sim/gear';
import { fakeServices } from './helpers/sim';

beforeAll(async () => {
  await initPhysics();
});

describe('who plays', () => {
  it('split screen seats Chinsky on the left as player 1 and Leo on the right as player 2', () => {
    const c = new Campaign();
    expect(c.players.map((p) => p.hero)).toEqual(['chinsky', 'leo']);
    expect(c.players.map((p) => p.name)).toEqual(['Chinsky', 'Leo']);
  });

  it('a solo run is Leo by default, and whoever the title screen picked otherwise', () => {
    expect(new Campaign(undefined, true).players[0].hero).toBe('leo');
    const picked = new Campaign(['chinsky', 'leo'], true);
    expect(picked.players[0].hero).toBe('chinsky');
    expect(picked.players[0].name).toBe('Chinsky');
  });

  it('a save keeps who sits where', () => {
    const c = new Campaign(['leo', 'chinsky']);
    const back = Campaign.deserialize(JSON.parse(JSON.stringify(c.serialize())));
    expect(back.players.map((p) => p.hero)).toEqual(['leo', 'chinsky']);
    expect(back.players.map((p) => p.name)).toEqual(['Leo', 'Chinsky']);
  });

  it('a save from the callsign days loads as the heroes, seated as usual', () => {
    const two = JSON.parse(JSON.stringify(new Campaign().serialize()));
    two.players[0].name = 'Ash';
    two.players[1].name = 'Rook';
    for (const p of two.players) delete p.hero;
    expect(Campaign.deserialize(two).players.map((p) => [p.hero, p.name])).toEqual([
      ['chinsky', 'Chinsky'],
      ['leo', 'Leo'],
    ]);
    const one = JSON.parse(JSON.stringify(new Campaign(undefined, true).serialize()));
    for (const p of one.players) delete p.hero;
    expect(Campaign.deserialize(one).players[0].hero).toBe('leo');
  });

  it('a save that names the same person twice gets both of them back', () => {
    const blob = JSON.parse(JSON.stringify(new Campaign().serialize()));
    blob.players[0].hero = 'leo';
    blob.players[1].hero = 'leo';
    expect(Campaign.deserialize(blob).players.map((p) => p.hero)).toEqual(['leo', 'chinsky']);
  });
});

describe('what they set out in', () => {
  it('the starter kit, bareheaded so their faces are seen, with the helmet in the bag', () => {
    const l = heroLoadout();
    const stock = starterLoadout();
    expect(l.worn.head).toBeUndefined();
    expect(l.bag[0].id).toBe(stock.worn.head!.id);
    for (const slot of ['face', 'body', 'hands', 'legs', 'feet', 'back'] as const) expect(l.worn[slot]?.id).toBe(stock.worn[slot]?.id);
    expect(new Campaign().players.every((p) => !p.gear.worn.head)).toBe(true);
  });
});

/** A hero (or the stock survivor) as the game dresses them, standing. */
function person(pal: Partial<Palette> = {}) {
  const l = heroLoadout();
  const h = new Humanoid({ ...identityOf(0), look: lookOf(l.worn), ...pal });
  h.update(0.016, 'stand', 0, 0, 0);
  h.root.updateMatrixWorld(true);
  return h;
}

const finite = (g: THREE.BufferGeometry) => Array.from(g.getAttribute('position').array).every(Number.isFinite);

describe('how they look', () => {
  it('stand as tall as they are, built as heavy as they are', () => {
    expect(HERO_LOOKS.chinsky.scale * RIG_HEIGHT).toBeCloseTo(HEROES.chinsky.height, 3);
    expect(HERO_LOOKS.leo.scale * RIG_HEIGHT).toBeCloseTo(HEROES.leo.height, 3);
    // 80 kg on 1.72 m against 66 kg on 1.80 m: one stockier than the stock rig, the other slighter.
    expect(HERO_LOOKS.chinsky.girth).toBeGreaterThan(1);
    expect(HERO_LOOKS.leo.girth).toBeLessThan(1);
    expect(HERO_LOOKS.chinsky.belly).toBeGreaterThan(0);
    expect(HERO_LOOKS.leo.belly).toBe(0);
    const c = person({ hero: 'chinsky' });
    const l = person({ hero: 'leo' });
    expect(c.root.scale.y).toBeCloseTo(HERO_LOOKS.chinsky.scale, 6);
    expect(l.root.scale.y).toBeCloseTo(HERO_LOOKS.leo.scale, 6);
    const torso = (h: Humanoid) => new THREE.Box3().setFromObject(h.torso.children.find((o) => (o as THREE.Mesh).isMesh)!);
    const width = (b: THREE.Box3) => b.max.x - b.min.x;
    expect(width(torso(c))).toBeGreaterThan(width(torso(l)) * 1.1);
  });

  it('each has a sculpted, textured head of their own, and the stock survivor has none', () => {
    for (const id of ['chinsky', 'leo'] as const) {
      const h = person({ hero: id });
      const face = h.head.children.find((o) => (o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry.getAttribute('uv') && (o as THREE.Mesh).geometry.index!.count > 20000) as THREE.Mesh;
      expect(face, id).toBeDefined();
      expect(finite(face.geometry), id).toBe(true);
      expect(h.meshes).toContain(face);
    }
    const stock = person();
    expect(stock.meshes).toHaveLength(11);
    expect(stock.root.scale.y).toBe(1);
  });

  it('dressing a hero as somebody else takes their face and their height away again', () => {
    const h = person({ hero: 'leo' });
    expect(h.meshes).toHaveLength(12);
    h.dress({ ...identityOf(1), look: lookOf(heroLoadout().worn) });
    expect(h.meshes).toHaveLength(11);
    expect(h.root.scale.y).toBe(1);
    expect(h.head.children.filter((o) => (o as THREE.Mesh).isMesh)).toHaveLength(1);
  });

  it('hair stands up bare and lies flat under a hat', () => {
    // The geometry is the skin's grid followed by the hair shell grown off it, vertex for vertex.
    const thickest = (g: THREE.BufferGeometry) => {
      const p = g.getAttribute('position');
      const n = p.count / 2;
      let most = 0;
      for (let i = 0; i < n; i++) most = Math.max(most, Math.hypot(p.getX(n + i) - p.getX(i), p.getY(n + i) - p.getY(i), p.getZ(n + i) - p.getZ(i)));
      return most;
    };
    const depth = (id: 'chinsky' | 'leo', mode: 'full' | 'covered') => thickest(portraitGeometry(HERO_LOOKS[id].portrait, mode));
    for (const id of ['chinsky', 'leo'] as const) {
      expect(finite(portraitGeometry(HERO_LOOKS[id].portrait, 'full')) && finite(portraitGeometry(HERO_LOOKS[id].portrait, 'covered')), id).toBe(true);
      expect(depth(id, 'covered'), id).toBeLessThan(0.005);
      expect(depth(id, 'full'), id).toBeGreaterThan(depth(id, 'covered') * 2);
    }
    // Leo's quiff: centimetres more hair than Chinsky's crop.
    expect(depth('leo', 'full')).toBeGreaterThan(0.03);
    expect(depth('chinsky', 'full')).toBeLessThan(0.02);
  });

  it('wear the bandana down round the neck, so nothing is drawn over the mouth', () => {
    const head = (pal: Partial<Palette>, face: 'f_bandana' | null) => {
      const l = heroLoadout();
      if (face) l.worn.face = newGear(face);
      else delete l.worn.face;
      const h = new Humanoid({ ...identityOf(0), look: lookOf(l.worn), ...pal });
      return h.head.children.map((o) => (o as THREE.Mesh).geometry.getAttribute('position').count);
    };
    expect(head({ hero: 'chinsky' }, 'f_bandana')).toEqual(head({ hero: 'chinsky' }, null));
    expect(head({}, 'f_bandana')).not.toEqual(head({}, null));
  });

  it('a gas mask still goes over a hero\'s face', () => {
    const l = heroLoadout();
    const plain = new Humanoid({ ...identityOf(0), look: lookOf(l.worn), hero: 'leo' });
    l.worn.face = newGear('f_gas');
    const masked = new Humanoid({ ...identityOf(0), look: lookOf(l.worn), hero: 'leo' });
    const n = (h: Humanoid) => (h.head.children[0] as THREE.Mesh).geometry.getAttribute('position').count;
    expect(n(masked)).toBeGreaterThan(n(plain));
  });
});

describe('their faces, painted', () => {
  const at = (id: 'chinsky' | 'leo', x: number, y: number, z: number, ny = 0, nz = 1) => {
    const out = new Float32Array(4);
    new FacePainter(HERO_LOOKS[id].portrait).paint(x, y, z, ny, nz, out);
    return out;
  };

  it('Chinsky has a full gingery beard; Leo has light, dark stubble', () => {
    const c = HERO_LOOKS.chinsky.portrait.shape;
    const l = HERO_LOOKS.leo.portrait.shape;
    const chin = (s: typeof c) => [0, s.eyeY + s.chin.y + 0.012, s.eyeZ + s.chin.z] as const;
    expect(beardCover(HERO_LOOKS.chinsky.portrait, ...chin(c))).toBeGreaterThan(0.9);
    const cb = at('chinsky', ...chin(c));
    const lb = at('leo', ...chin(l));
    // Ginger: red well over blue. Stubble: a shade darker than the skin round it, but only a shade.
    expect(cb[0] - cb[2]).toBeGreaterThan(0.2);
    const lSkin = at('leo', 0.035, l.eyeY - 0.02, l.eyeZ - 0.005);
    const lum = (c: Float32Array) => c[0] + c[1] + c[2];
    expect(lum(lb)).toBeLessThan(lum(lSkin));
    expect(lum(lb)).toBeGreaterThan(lum(lSkin) * 0.7);
  });

  it('the lips stay clear of the beard\'s bulk, and the forehead of hair', () => {
    const s = HERO_LOOKS.chinsky.portrait;
    const m = s.shape.mouth;
    expect(beardCover(s, 0, s.shape.eyeY + m.y - m.lower * 0.5, s.shape.eyeZ + m.z, true)).toBeLessThan(0.1);
    for (const id of ['chinsky', 'leo'] as const) {
      const p = HERO_LOOKS[id].portrait;
      expect(scalpCover(p, 0, p.shape.eyeY + 0.03), id).toBe(0);
      expect(scalpCover(p, 0, p.shape.top), id).toBe(1);
    }
  });

  it('dark eyes and dark brows on a lighter face, for both', () => {
    for (const id of ['chinsky', 'leo'] as const) {
      const s = HERO_LOOKS[id].portrait.shape;
      const p = HERO_LOOKS[id].portrait.paint;
      const lum = (c: Float32Array) => c[0] + c[1] + c[2];
      const cheek = at(id, s.eyeX, s.eyeY - 0.025, s.eyeZ);
      const iris = at(id, s.eyeX, s.eyeY + s.irisY * 0.5, s.eyeZ);
      const brow = at(id, p.brow.peak[0], s.eyeY + p.brow.peak[1], s.eyeZ);
      expect(lum(iris), id).toBeLessThan(lum(cheek) * 0.5);
      expect(lum(brow), id).toBeLessThan(lum(cheek) * 0.6);
    }
  });

  it('paints a whole texture with no gaps', () => {
    const data = paintPortraitNow(HERO_LOOKS.leo.portrait);
    expect(data.length).toBe(TEX_W * TEX_H * 4);
    // Every texel got a roughness, and the face is not one flat colour.
    let rough = 0;
    const seen = new Set<number>();
    for (let i = 0; i < data.length; i += 4 * 97) {
      if (data[i + 3] > 0) rough++;
      seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
    }
    expect(rough).toBe(Math.ceil(data.length / (4 * 97)));
    expect(seen.size).toBeGreaterThan(500);
  }, 30000);
});

describe('in a seat', () => {
  it('a player at the wheel is drawn as themselves: their hero, their height', () => {
    const h = fakeServices();
    const sc = new LegScene(h.svc, legById('L1'));
    sc.tick(1 / 60);
    sc.renderFrame(1, 1 / 60);
    for (const p of sc.players) {
      const rider = p.vehicle!.visual.driver!;
      expect(rider.worn.hero, p.name).toBe(p.hero);
      expect(rider.root.scale.y, p.name).toBeCloseTo(HERO_LOOKS[p.hero].scale, 6);
    }
    sc.dispose();
  }, 60000);
});
