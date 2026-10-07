import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { initPhysics } from '../src/physics/physics';
import { HEROES, HERO_IDS, legById, nextHero, otherHero } from '../src/data';
import { Campaign, heroLoadout } from '../src/game/campaign';
import { LegScene } from '../src/game/legScene';
import { Humanoid, type Palette, type PoseKind } from '../src/render/humanoid';
import { HERO_LOOKS, LAG_GAPE, RIG_HEIGHT } from '../src/render/heroLooks';
import { CakeEater, spoonBowl } from '../src/render/cake';
import { identityOf, lookOf } from '../src/render/outfit';
import { FacePainter, TEX_H, TEX_W, beardCover, paintPortraitNow, portraitGeometry, portraitMaterial, scalpCover } from '../src/render/portrait';
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
  it('the starter kit, bareheaded and bare-handed, with the helmet and gloves in the bag', () => {
    const l = heroLoadout();
    const stock = starterLoadout();
    expect(l.worn.head).toBeUndefined();
    expect(l.worn.hands).toBeUndefined();
    expect(l.bag[0].id).toBe(stock.worn.head!.id);
    expect(l.bag[1].id).toBe(stock.worn.hands!.id);
    for (const slot of ['face', 'body', 'legs', 'feet', 'back'] as const) expect(l.worn[slot]?.id).toBe(stock.worn[slot]?.id);
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
    for (const id of HERO_IDS) {
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
    const depth = (id: (typeof HERO_IDS)[number], mode: 'full' | 'covered') => thickest(portraitGeometry(HERO_LOOKS[id].portrait, mode));
    for (const id of HERO_IDS) {
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
  const at = (id: (typeof HERO_IDS)[number], x: number, y: number, z: number, ny = 0, nz = 1) => {
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
    for (const id of HERO_IDS) {
      const p = HERO_LOOKS[id].portrait;
      expect(scalpCover(p, 0, p.shape.eyeY + 0.03), id).toBe(0);
      const crown = scalpCover(p, 0, p.shape.top);
      if (p.hair.crownDensity === undefined) expect(crown, id).toBe(1);
      else {
        expect(crown, id).toBeGreaterThanOrEqual(0);
        expect(crown, id).toBeLessThanOrEqual(p.hair.crownDensity);
      }
    }
  });

  it('dark eyes and dark brows on a lighter face, for all of them', () => {
    for (const id of HERO_IDS) {
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

  it('Nar grins with his top teeth showing; a parted mouth without teeth stays dark', () => {
    const p = HERO_LOOKS.nar.portrait;
    const s = p.shape;
    const m = s.mouth;
    const lum = (c: Float32Array) => c[0] + c[1] + c[2];
    // A third of the way down the gap between the lips, beside the middle.
    const gap = (spec: typeof p) => {
      const out = new Float32Array(4);
      new FacePainter(spec).paint(0.004, s.eyeY + m.y + m.open! / 6, s.eyeZ + m.z - 0.004, 0, 1, out);
      return out;
    };
    expect(m.open).toBeGreaterThan(0.005);
    expect(lum(gap(p))).toBeGreaterThan(2);
    const toothless = { ...p, id: 'nar-toothless', shape: { ...s, mouth: { ...m, teeth: undefined } } };
    expect(lum(gap(toothless))).toBeLessThan(0.5);
  });

  it('Nar\'s beard is dark through the moustache and greys along the jaw', () => {
    const s = HERO_LOOKS.nar.portrait.shape;
    const m = s.mouth;
    const lum = (c: Float32Array) => c[0] + c[1] + c[2];
    // Average a patch round each spot (dx across, dy up and down): the grey is a mix of single hairs a few millimetres long.
    const mean = (x: number, y: number, z: number, dx: number, dy: number) => {
      let sum = 0;
      for (let i = 0; i < 144; i++) sum += lum(at('nar', x + ((i % 12) / 11 - 0.5) * dx, y + (Math.floor(i / 12) / 11 - 0.5) * dy, z));
      return sum / 144;
    };
    const tache = mean(0, s.eyeY + m.y + m.open! / 2 + m.upper + 0.004, s.eyeZ + m.z + 0.004, 0.03, 0.005);
    const jaw = mean(0.05, s.eyeY - 0.085, s.eyeZ - 0.035, 0.012, 0.03);
    expect(jaw).toBeGreaterThan(tache * 1.3);
  });
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

describe('Nar Divad', () => {
  it('is the third hero: 1.75 m and 82 kg, as broad as Chinsky and between him and Leo in height', () => {
    expect(HERO_IDS.slice(0, 3)).toEqual(['chinsky', 'leo', 'nar']);
    expect(HEROES.nar).toMatchObject({ name: 'Nar Divad', height: 1.75, weight: 82 });
    expect(HERO_LOOKS.nar.scale * RIG_HEIGHT).toBeCloseTo(1.75, 3);
    expect(HERO_LOOKS.nar.girth).toBeGreaterThan(1);
    expect(HERO_LOOKS.nar.belly).toBeGreaterThan(0);
    const top = (id: (typeof HERO_IDS)[number]) => new THREE.Box3().setFromObject(person({ hero: id }).root).max.y;
    expect(top('nar')).toBeGreaterThan(top('chinsky'));
    expect(top('nar')).toBeLessThan(top('leo'));
  });

  it('can take either seat, alone or with a partner, and a save keeps him there', () => {
    const c = new Campaign(['nar', 'leo']);
    expect(c.players.map((p) => p.name)).toEqual(['Nar Divad', 'Leo']);
    const back = Campaign.deserialize(JSON.parse(JSON.stringify(c.serialize())));
    expect(back.players.map((p) => p.hero)).toEqual(['nar', 'leo']);
    expect(new Campaign(['chinsky', 'nar']).players[1].hero).toBe('nar');
    expect(new Campaign(['nar', 'chinsky'], true).players[0].name).toBe('Nar Divad');
  });

  it('the title screen steps through everyone, and never seats the same person twice', () => {
    // Visit every roster entry once before wrapping, and skip any occupied seat.
    let selected = HERO_IDS[0];
    const visited = new Set<string>();
    for (let i = 0; i < HERO_IDS.length; i++) {
      expect(visited.has(selected)).toBe(false);
      visited.add(selected);
      selected = nextHero(selected);
    }
    expect(selected).toBe(HERO_IDS[0]);
    expect(visited.size).toBe(HERO_IDS.length);
    for (const h of HERO_IDS) {
      expect(otherHero(h)).not.toBe(h);
      for (const occupied of HERO_IDS) expect(nextHero(h, occupied)).not.toBe(occupied);
    }
    expect(otherHero('leo')).toBe('chinsky');
  });

  it('wears his own pale T-shirt with a dark print when nothing covers it', () => {
    const shirt = new Humanoid({ ...identityOf(0), look: lookOf({}), hero: 'nar' });
    const plain = new Humanoid({ ...identityOf(0), look: lookOf({}), hero: 'chinsky' });
    const n = (h: Humanoid) => (h.torso.children.find((o) => (o as THREE.Mesh).isMesh) as THREE.Mesh).geometry.getAttribute('position').count;
    // The print and the cord are drawn on top of the same T-shirt (Chinsky's is under a cardigan, so he has more still).
    const leo = new Humanoid({ ...identityOf(1), look: lookOf({}), hero: 'leo' });
    expect(n(shirt)).toBeGreaterThan(n(leo));
    expect(n(plain)).toBeGreaterThan(n(leo));
  });
});

describe('Lag Karab', () => {
  // The head part (ears, glasses, anything worn): the first mesh on the head, before the portrait face.
  const headCount = (h: Humanoid) => (h.head.children[0] as THREE.Mesh).geometry.getAttribute('position').count;

  it('is the fourth hero: 1.75 m and 75 kg, slighter than Nar at the same height', () => {
    expect(HERO_IDS.indexOf('lag')).toBe(3);
    expect(HEROES.lag).toMatchObject({ name: 'Lag Karab', height: 1.75, weight: 75 });
    expect(HERO_LOOKS.lag.scale * RIG_HEIGHT).toBeCloseTo(1.75, 3);
    expect(HERO_LOOKS.lag.girth).toBeGreaterThan(1);
    expect(HERO_LOOKS.lag.girth).toBeLessThan(HERO_LOOKS.nar.girth);
    expect(HERO_LOOKS.lag.belly).toBeLessThan(HERO_LOOKS.nar.belly);
    const c = new Campaign(['lag', 'nar']);
    expect(c.players.map((p) => p.name)).toEqual(['Lag Karab', 'Nar Divad']);
    expect(Campaign.deserialize(JSON.parse(JSON.stringify(c.serialize()))).players[0].hero).toBe('lag');
  });

  it('wears his wraparound sunglasses, unless goggles or a mask go over his eyes', () => {
    const lag = new Humanoid({ ...identityOf(0), look: lookOf({}), hero: 'lag' });
    const nar = new Humanoid({ ...identityOf(0), look: lookOf({}), hero: 'nar' });
    expect(headCount(lag)).toBeGreaterThan(headCount(nar) + 200);
    const l = heroLoadout();
    l.worn.face = newGear('f_gas');
    const maskedLag = new Humanoid({ ...identityOf(0), look: lookOf(l.worn), hero: 'lag' });
    const maskedNar = new Humanoid({ ...identityOf(0), look: lookOf(l.worn), hero: 'nar' });
    expect(headCount(maskedLag)).toBe(headCount(maskedNar));
  });

  it('wears a quilted down jacket open over a pale blue T-shirt, so his sleeves are long', () => {
    const lag = new Humanoid({ ...identityOf(0), look: lookOf({}), hero: 'lag' });
    const leo = new Humanoid({ ...identityOf(1), look: lookOf({}), hero: 'leo' });
    const part = (h: Humanoid, o: THREE.Object3D) => (o.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh).geometry.getAttribute('position').count;
    expect(part(lag, lag.torso)).toBeGreaterThan(part(leo, leo.torso));
    // Leo's T-shirt leaves the arm bare below the short sleeve; the jacket's sleeve runs to the elbow, in stitched bands.
    expect(part(lag, lag.armL)).not.toBe(part(leo, leo.armL));
  });

  it('opens wide for a bite: the upper teeth along the top of the gap and the tongue at the bottom', () => {
    const s = LAG_GAPE.shape;
    const m = s.mouth;
    const paint = (y: number) => {
      const out = new Float32Array(4);
      new FacePainter(LAG_GAPE).paint(0.003, s.eyeY + m.y + y, s.eyeZ + m.z, 0, 1, out);
      return out;
    };
    const teeth = paint(m.open! / 2 - 0.004);
    const tongue = paint(-m.open! / 2 + 0.005);
    const throat = paint(0);
    expect(teeth[0] + teeth[1] + teeth[2]).toBeGreaterThan(1.8);
    expect(tongue[0]).toBeGreaterThan(tongue[2] * 1.8);
    expect(throat[0] + throat[1] + throat[2]).toBeLessThan(teeth[0] + teeth[1] + teeth[2] - 1);
    expect(finite(portraitGeometry(LAG_GAPE, 'full'))).toBe(true);
  });
});

describe('eating cake', () => {
  type Peek = { t: number; band: number; scoopPoint: (v: THREE.Vector3) => THREE.Vector3; group: THREE.Group };
  const bowlAt = (e: CakeEater) => e.spoon.localToWorld(spoonBowl(e.spoonLen));
  const mouthAt = (h: Humanoid) => {
    const s = HERO_LOOKS.lag.portrait.shape;
    return h.head.localToWorld(new THREE.Vector3(0, s.eyeY + s.mouth.y, s.eyeZ + s.mouth.z));
  };

  it('sits on a crate, digs the spoon into the slice, and brings it up to his open mouth', () => {
    const h = new Humanoid({ ...identityOf(0), look: lookOf({}), hero: 'lag' });
    const e = new CakeEater(h);
    const p = e as unknown as Peek;
    // Sat: the hips at seat height, not standing.
    expect(h.hips.getWorldPosition(new THREE.Vector3()).y).toBeLessThan(0.5);
    const step = (to: number) => {
      while (p.t < to - 1e-6) e.update(Math.min(1 / 60, to - p.t));
      e.group.updateMatrixWorld(true);
    };
    step(1.0);
    expect(bowlAt(e).distanceTo(p.scoopPoint(new THREE.Vector3()))).toBeLessThan(0.03);
    expect(e.eaten).toBe(0);
    step(1.5);
    expect(e.eaten).toBe(1);
    step(2.3);
    // The bowl at the lips (it sits a little under them, so the lump in it is level with them), the mouth wide open.
    expect(bowlAt(e).distanceTo(mouthAt(h))).toBeLessThan(0.06);
    const face = h.head.children[1] as THREE.Mesh;
    expect(face.material).toBe(portraitMaterial(LAG_GAPE));
    step(3.0);
    expect(face.material).toBe(portraitMaterial(HERO_LOOKS.lag.portrait));
    for (const v of [h.hand, h.handL]) expect(Number.isFinite(v.getWorldPosition(new THREE.Vector3()).length())).toBe(true);
  });

  it('finishes the slice a band at a time, then a new one is cut', () => {
    const h = new Humanoid({ ...identityOf(0), look: lookOf({}), hero: 'lag' });
    const e = new CakeEater(h);
    // Four whole bites, then the fifth up to just past the scoop: the last band is gone.
    for (let i = 0; i < 60 * (4.3 * 4 + 1.5); i++) e.update(1 / 60);
    expect(e.eaten).toBe(5);
    // Into the sixth: a new slice, untouched until the spoon goes in, then one band down.
    for (let i = 0; i < 60 * 3.3; i++) e.update(1 / 60);
    expect(e.eaten).toBe(0);
    for (let i = 0; i < 60 * 1; i++) e.update(1 / 60);
    expect(e.eaten).toBe(1);
  });
});

describe('at rest', () => {
  const posed = (pose: PoseKind, yaw = 0, worn: Parameters<typeof lookOf>[0] = { legs: heroLoadout().worn.legs, feet: heroLoadout().worn.feet }) => {
    const h = new Humanoid({ ...identityOf(0), look: lookOf(worn), hero: 'nar' });
    h.root.rotation.y = yaw;
    h.update(0.016, pose, 0, 0, 0);
    h.root.updateMatrixWorld(true);
    return h;
  };
  const at = (o: THREE.Object3D, y = 0) => o.localToWorld(new THREE.Vector3(0, y, 0));
  const facing = (o: THREE.Object3D) => new THREE.Vector3(0, 0, 1).transformDirection(o.matrixWorld);

  it('sits on the ground: seat and heels on it, knees up, elbows on the knees, hands together in front', () => {
    const h = posed('sit');
    expect(at(h.hips).y).toBeLessThan(0.2);
    for (const knee of [h.kneeL, h.kneeR]) {
      expect(at(knee).y).toBeGreaterThan(0.3);
      expect(Math.abs(at(knee, -0.465).y)).toBeLessThan(0.04);
    }
    expect(at(h.elbowL).distanceTo(at(h.kneeL))).toBeLessThan(0.12);
    expect(at(h.elbowR).distanceTo(at(h.kneeR))).toBeLessThan(0.12);
    expect(at(h.handL).distanceTo(at(h.hand))).toBeLessThan(0.1);
    expect(at(h.handL).z).toBeGreaterThan(at(h.kneeL).z);
    const box = new THREE.Box3().setFromObject(h.root, true);
    expect(box.min.y).toBeGreaterThan(-0.06);
    expect(box.max.y).toBeLessThan(1.05);
  });

  it('lies on its back along the way it faced, whichever way that was', () => {
    for (const yaw of [0, 1.2, -2.5]) {
      const h = posed('lie', yaw);
      const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      const head = at(h.head, 0.1).sub(h.root.position);
      // The head a body length back from the feet, straight behind them, and the chest to the sky.
      expect(head.dot(fwd), `${yaw}`).toBeLessThan(-1.4);
      expect(Math.abs(head.x * fwd.z - head.z * fwd.x), `${yaw}`).toBeLessThan(0.15);
      expect(facing(h.torso).y, `${yaw}`).toBeGreaterThan(0.9);
      // On the ground: the back of the ribs and the head resting on it, nothing sunk into it, a knee up.
      const box = new THREE.Box3().setFromObject(h.root, true);
      expect(box.min.y, `${yaw}`).toBeGreaterThan(-0.02);
      expect(box.min.y, `${yaw}`).toBeLessThan(0.02);
      expect(box.max.y, `${yaw}`).toBeLessThan(0.7);
      // Elbows down on the ground, hands up on the belly.
      expect(at(h.elbowL).y).toBeLessThan(0.1);
      expect(at(h.handL).y).toBeGreaterThan(0.2);
    }
  });

  it('lying with a pack on, leans back against it', () => {
    const bare = posed('lie');
    const packed = posed('lie', 0, heroLoadout().worn);
    expect(facing(packed.torso).y).toBeLessThan(facing(bare.torso).y - 0.15);
    expect(at(packed.head, 0.1).y).toBeGreaterThan(at(bare.head, 0.1).y + 0.3);
  });

  it('a downed player lies on their back too, whichever way they faced', () => {
    for (const yaw of [0, 1.2, -2.5]) expect(facing(posed('downed', yaw).torso).y, `${yaw}`).toBeGreaterThan(0.9);
  });
});
