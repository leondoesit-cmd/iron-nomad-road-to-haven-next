import { CONTACT, swingArc } from '../src/sim/weaponfx';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GEAR, WEAR_SLOTS, gearDef } from '../src/data';
import { Humanoid, type Held } from '../src/render/humanoid';
import { DEFAULT_LOOK, STYLES, identityOf, lookOf } from '../src/render/outfit';
import { newGear, starterLoadout } from '../src/sim/gear';
import './helpers/sim'; // installs the fake canvas the material textures draw on

const SLOT_KEY = { head: 'head', face: 'face', body: 'body', hands: 'hands', legs: 'legs', feet: 'feet', back: 'pack' } as const;

/** Every vertex of every body part is a real number, and there is something to draw. */
function sound(h: Humanoid) {
  for (const m of h.meshes) {
    const pos = m.geometry.getAttribute('position');
    expect(pos.count).toBeGreaterThan(0);
    for (let i = 0; i < pos.array.length; i++) if (!Number.isFinite(pos.array[i])) return false;
  }
  return true;
}

describe('outfits', () => {
  it('the starter kit looks the way the survivor always did', () => {
    // Same styles and, once the palette's own fallbacks are applied, the same colours. (The pixel-for-pixel check against the
    // original character was done in a browser; this keeps the data from drifting away from it.)
    const look = lookOf(starterLoadout().worn);
    for (const k of Object.keys(DEFAULT_LOOK) as (keyof typeof DEFAULT_LOOK)[]) {
      expect(look[k].style, k).toBe(DEFAULT_LOOK[k].style);
      expect(look[k].c ?? (k === 'legs' ? 0x3d3f3a : undefined), k).toBe(DEFAULT_LOOK[k].c ?? (k === 'legs' ? 0x3d3f3a : undefined));
      expect(look[k].c2, k).toBe(DEFAULT_LOOK[k].c2);
    }
    // The identity-coloured pieces carry no colour of their own, so they take the survivor's.
    expect([look.head.c, look.face.c, look.body.c]).toEqual([undefined, undefined, undefined]);
  });

  it('every wearable names a style the drawing code knows', () => {
    for (const g of GEAR.items.filter((i) => i.kind === 'wear')) {
      const key = SLOT_KEY[g.slot!];
      expect(STYLES[key], `${g.id}: style ${g.look!.style} for ${key}`).toContain(g.look!.style);
    }
  });

  it('every wearable draws a sound body, alone and with the rest of the kit', () => {
    for (const g of GEAR.items.filter((i) => i.kind === 'wear')) {
      const l = starterLoadout();
      l.worn[g.slot!] = newGear(g.id);
      const h = new Humanoid({ ...identityOf(1), look: lookOf(l.worn), band: 0x2f9bff });
      expect(sound(h), g.id).toBe(true);
    }
  });

  it('a stripped survivor still draws, so taking things off never leaves a hole', () => {
    const h = new Humanoid({ ...identityOf(0), look: lookOf({}), band: 0xff8a1f });
    expect(sound(h)).toBe(true);
  });

  it('each slot with something different on is drawn differently from the starter', () => {
    const base = starterLoadout();
    const geo = (worn: typeof base.worn) => new Humanoid({ ...identityOf(0), look: lookOf(worn) }).meshes.map((m) => m.geometry.getAttribute('position').array.length + ':' + m.geometry.getAttribute('position').array[7]);
    const ref = geo(base.worn);
    for (const slot of WEAR_SLOTS) {
      const alt = GEAR.items.find((g) => g.slot === slot && !g.starter)!;
      const w = { ...base.worn, [slot]: newGear(alt.id) };
      expect(geo(w), `${slot} ${alt.id}`).not.toEqual(ref);
    }
  });

  it('dressing swaps the geometry on the existing rig and is cheap to repeat', () => {
    const l = starterLoadout();
    const h = new Humanoid({ ...identityOf(0), look: lookOf(l.worn) });
    const before = h.meshes.map((m) => m.geometry);
    l.worn.head = newGear('h_hardhat');
    h.dress({ ...identityOf(0), look: lookOf(l.worn), band: 0xff8a1f });
    const after = h.meshes.map((m) => m.geometry);
    expect(after).toHaveLength(before.length);
    expect(after.filter((g, i) => g !== before[i]).length).toBeGreaterThan(0);
    // The same outfit again hands back the cached pieces.
    h.dress({ ...identityOf(0), look: lookOf(l.worn), band: 0xff8a1f });
    expect(h.meshes.map((m) => m.geometry)).toEqual(after);
  });
});

describe('what they hold', () => {
  it('every gun and melee weapon has a model that builds', () => {
    for (const g of GEAR.items) {
      const model = (g.gun?.model ?? g.melee?.model ?? g.tool) as Held | undefined;
      if (!model) continue;
      const h = new Humanoid(identityOf(0));
      h.setWeapon(model);
      const mesh = h.hand.children.find((c): c is THREE.Mesh => (c as THREE.Mesh).isMesh);
      expect(mesh, g.id).toBeDefined();
      expect(mesh!.geometry.getAttribute('position').count, g.id).toBeGreaterThan(0);
    }
  });

  it('a raised weapon points where the arm does, not at the sky', () => {
    const h = new Humanoid(identityOf(0));
    h.setWeapon('rifle');
    h.update(0.016, 'stand', 0, 1, 0, 0);
    h.root.updateMatrixWorld(true);
    // The weapon's local +z, taken into the world, should be level and forward.
    const dir = new THREE.Vector3(0, 0, 1).transformDirection(h.hand.matrixWorld);
    expect(dir.z).toBeGreaterThan(0.9);
    expect(Math.abs(dir.y)).toBeLessThan(0.2);
  });

  it('a swing raises the arm overhead and brings it down', () => {
    const h = new Humanoid(identityOf(0));
    h.setWeapon('bat');
    h.swing = 0.95;
    h.update(0.016, 'stand', 0, 0, 0, 0);
    const up = h.armR.rotation.x;
    h.swing = 0.05;
    h.update(0.016, 'stand', 0, 0, 0, 0);
    expect(up).toBeLessThan(-2);
    expect(h.armR.rotation.x).toBeGreaterThan(up + 1.5);
  });
});

describe('a melee swing', () => {
  const weaponDir = (swing: number) => {
    const h = new Humanoid(identityOf(0));
    h.setWeapon('axe');
    h.swing = swing;
    h.update(0.016, 'stand', 0, 0, 0, 0);
    h.root.updateMatrixWorld(true);
    return new THREE.Vector3(0, 0, 1).transformDirection(h.hand.matrixWorld);
  };

  it('starts with the weapon cocked back and up, and brings its head down in front', () => {
    const start = weaponDir(0.99);
    const contact = weaponDir(1 - CONTACT);
    const end = weaponDir(0.01);
    // Back and up at the start.
    expect(start.z).toBeLessThan(-0.5);
    expect(start.y).toBeGreaterThan(0);
    // Forward and level or a little down as it lands.
    expect(contact.z).toBeGreaterThan(0.8);
    expect(contact.y).toBeLessThan(0.2);
    // Chopped down at the end, not held up in the air.
    expect(end.z).toBeGreaterThan(0.3);
    expect(end.y).toBeLessThan(-0.5);
  });

  it('the streak is drawn from the same pose: the tip is behind the body at the start and ahead of it at contact', () => {
    expect(swingArc(0, 0.86).r).toBeLessThan(0);
    expect(swingArc(CONTACT, 0.86).r).toBeGreaterThan(1);
  });
});

describe('every item in the catalogue is wearable, holdable or a tool', () => {
  it('and the data agrees with itself', () => {
    for (const g of GEAR.items) expect(['wear', 'gun', 'melee', 'tool', 'mod']).toContain(gearDef(g.id).kind);
  });
});
