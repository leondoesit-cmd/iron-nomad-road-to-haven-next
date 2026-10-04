import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CHASSIS, PARTS, chassisDef } from '../src/data';
import { Campaign } from '../src/game/campaign';
import { newBuild } from '../src/sim/garage';
import { PANELS, PANEL_NAME, SPRAY_CHARGES, cleanPanels, colorName, foundCan, paintPanel, panelColor, panelSignature, panelsOf, washPanels } from '../src/sim/paint';
import { salvageLoot } from '../src/sim/salvage';
import { inspectLines, carriedName, carryModelKey, planStow } from '../src/sim/carry';
import { buildCar } from '../src/render/carModels';
import { buildVehicleVisual, lookOf } from '../src/render/vehicleModels';
import { panelAnchor, wheelCentres } from '../src/render/sockets';
import { panelAt } from '../src/render/paintJob';
import { mountsOfChassis } from '../src/render/vehicleModels';

describe('panel paint rules', () => {
  it('cars have six panels, bikes two, and the colour of an unpainted panel is the vehicle\'s own', () => {
    expect(panelsOf(chassisDef('sedan'))).toEqual(PANELS);
    expect(panelsOf(chassisDef('buggy'))).toEqual(PANELS);
    expect(panelsOf(chassisDef('truck'))).toEqual([]);
    expect(panelsOf(chassisDef('moped'))).toEqual(['front', 'rear']);
    expect(panelsOf(chassisDef('quad'))).toEqual(['front', 'rear']);
    const b = newBuild('sedan', { seed: 1, paint: 0x336699 });
    expect(panelColor(b.paint, b.panels, 'hood')).toBe(0x336699);
  });
  it('spraying a panel records it; spraying it the vehicle\'s own colour clears it; washing clears all', () => {
    const b = newBuild('sedan', { seed: 1, paint: 0x336699 });
    paintPanel(b, 'doorL', 0xff0000);
    paintPanel(b, 'hood', 0x00ff00);
    expect(b.panels).toEqual({ doorL: 0xff0000, hood: 0x00ff00 });
    expect(panelColor(b.paint, b.panels, 'doorL')).toBe(0xff0000);
    paintPanel(b, 'hood', 0x336699);
    expect(b.panels).toEqual({ doorL: 0xff0000 });
    paintPanel(b, 'doorL', 0x336699);
    expect(b.panels).toBeUndefined();
    paintPanel(b, 'roof', 1);
    washPanels(b);
    expect(b.panels).toBeUndefined();
  });
  it('the signature changes with the paint job and is stable otherwise', () => {
    expect(panelSignature(undefined)).toBe('');
    const a = panelSignature({ doorL: 0xff0000 });
    expect(a).not.toBe(panelSignature({ doorL: 0x00ff00 }));
    expect(a).toBe(panelSignature({ doorL: 0xff0000 }));
  });
  it('a damaged save record is cleaned', () => {
    expect(cleanPanels({ hood: 0xabcdef, roof: 'red', mudguard: 5, doorL: -1, front: NaN })).toEqual({ hood: 0xabcdef });
    expect(cleanPanels(null)).toBeUndefined();
    expect(cleanPanels({})).toBeUndefined();
  });
  it('a painted vehicle survives a save, and a hand-edited one is repaired', () => {
    const c = new Campaign(undefined, false);
    paintPanel(c.garage[0], 'doorR', 0x123456);
    const raw = JSON.parse(JSON.stringify(c.serialize()));
    expect(Campaign.deserialize(raw).garage[0].panels).toEqual({ doorR: 0x123456 });
    raw.garage[0].panels = { doorR: 'bad', hood: 7 };
    expect(Campaign.deserialize(raw).garage[0].panels).toEqual({ hood: 7 });
  });
  it('colours have names, and a found can is a real swatch with a few sprays', () => {
    expect(colorName(PARTS.paints[0].c)).toBe(PARTS.paints[0].name);
    expect(colorName(0x010203)).toBe('#010203');
    let n = 0;
    const can = foundCan(() => (n = (n + 0.37) % 1));
    expect(PARTS.paints.some((p) => p.c === can.color)).toBe(true);
    expect(can.charges).toBeGreaterThanOrEqual(3);
    expect(can.charges).toBeLessThanOrEqual(6);
    expect(SPRAY_CHARGES).toBe(6);
  });
  it('a spray can is carried, named, shown and put down, never stowed', () => {
    const can = { kind: 'paint' as const, color: 0xe0be1a, charges: 4 };
    expect(carriedName(can)).toMatch(/Spray can \(.*, 4 left\)/);
    expect(carryModelKey(can)).toBe('paint:e0be1a');
    expect(inspectLines(can)[0].text).toBe('Spray can');
    expect(planStow(can, { parts: 10, oil: 2 }).ok).toBe(false);
  });
  it('searching a car\'s trunk sometimes turns up a spray can, never from a burnt-out hulk', () => {
    let found = 0;
    const n = 1500;
    for (let s = 1; s <= n; s++) {
      const loot = salvageLoot(3, { seed: s * 13, kind: 'car', chassis: 'sedan', burnt: false });
      if (loot.paint) found++;
      expect(salvageLoot(3, { seed: s * 13, kind: 'car', chassis: 'sedan', burnt: true }).paint).toBeUndefined();
    }
    expect(found / n).toBeGreaterThan(0.06);
    expect(found / n).toBeLessThan(0.2);
  });
});

describe('every paintable panel has a place on the vehicle', () => {
  it('each chassis offers an anchor box for each of its panels, inside the vehicle\'s footprint', () => {
    for (const id of Object.keys(CHASSIS)) {
      const def = chassisDef(id);
      for (const p of panelsOf(def)) {
        const a = panelAnchor(def, p);
        if (!a) {
          // Only a doorless or roofless body may lack one.
          expect(['hood', 'roof', 'doorL', 'doorR']).toContain(p);
          continue;
        }
        expect(Math.abs(a.x)).toBeLessThan(def.width / 2 + 0.5);
        expect(Math.abs(a.z)).toBeLessThan(def.length / 2 + 0.8);
      }
    }
    expect(Object.keys(PANEL_NAME).sort()).toEqual([...PANELS].sort());
  });
  it('a car\'s panels sit on the right ends and sides', () => {
    const def = chassisDef('sedan');
    expect(panelAnchor(def, 'doorL')!.x).toBeGreaterThan(0);
    expect(panelAnchor(def, 'doorR')!.x).toBeLessThan(0);
    expect(panelAnchor(def, 'front')!.z).toBeGreaterThan(0);
    expect(panelAnchor(def, 'rear')!.z).toBeLessThan(0);
    expect(panelAnchor(def, 'roof')!.y).toBeGreaterThan(panelAnchor(def, 'hood')!.y);
  });
});

/** Vertex colours of a built body whose position passes `pick`, averaged. */
function averageColour(geo: THREE.BufferGeometry, pick: (x: number, y: number, z: number) => boolean) {
  const pos = geo.getAttribute('position');
  const col = geo.getAttribute('color');
  const srf = geo.getAttribute('surf');
  let r = 0;
  let g = 0;
  let b = 0;
  let w = 0;
  let n = 0;
  for (let i = 0; i < pos.count; i++) {
    if (!pick(pos.getX(i), pos.getY(i), pos.getZ(i))) continue;
    // Paint surfaces only.
    const rough = srf.getX(i);
    const metal = srf.getY(i);
    if (!((rough > 0.45 && rough < 0.51 && metal > 0.1 && metal < 0.14) || (rough > 0.26 && rough < 0.3 && metal > 0.08 && metal < 0.12))) continue;
    r += col.getX(i);
    g += col.getY(i);
    b += col.getZ(i);
    w += srf.getZ(i);
    n++;
  }
  return { n, r: r / n, g: g / n, b: b / n, wear: w / n };
}

describe('the painted model', () => {
  const def = chassisDef('sedan');
  const wl = wheelCentres(def);
  const steered = wl.map((_, i) => i < 2);
  const build = (panels?: Record<string, number>) => {
    const b = newBuild('sedan', { seed: 4, paint: 0x4a6a8a, hp: 0.5 });
    if (panels) b.panels = panels;
    return buildCar(def, wl, steered, lookOf(b));
  };
  // Ground-frame to chassis-frame: the shell is shifted down by the rest height.
  const mt = mountsOfChassis(def)!;
  const inZone = (zone: string) => (x: number, y: number, z: number) => panelAt(mt.m, x, y + mt.g0, z) === zone;

  it('a sprayed door takes the colour and loses its rust; the other door does not', () => {
    const plain = build();
    const painted = build({ doorL: 0xe0be1a });
    const was = averageColour(plain.body.geometry, inZone('doorL'));
    const now = averageColour(painted.body.geometry, inZone('doorL'));
    expect(was.n).toBeGreaterThan(20);
    expect(now.n).toBe(was.n);
    // Yellow: red and green high, blue low; the blue-grey original is the opposite.
    expect(now.r).toBeGreaterThan(was.r * 2);
    expect(now.b).toBeLessThan(now.r);
    expect(was.b).toBeGreaterThan(was.r);
    expect(now.wear).toBeLessThan(was.wear * 0.4);
    const otherPlain = averageColour(plain.body.geometry, inZone('doorR'));
    const otherNow = averageColour(painted.body.geometry, inZone('doorR'));
    expect(otherNow.r).toBeCloseTo(otherPlain.r, 5);
    expect(otherNow.wear).toBeCloseTo(otherPlain.wear, 5);
    plain.dispose();
    painted.dispose();
  });

  it('different paint jobs make different models; the same one shares', () => {
    const a = build({ hood: 0xff0000 });
    const b = build({ hood: 0xff0000 });
    const c = build({ hood: 0x00ff00 });
    expect(a.body.geometry).toBe(b.body.geometry);
    expect(a.body.geometry).not.toBe(c.body.geometry);
    a.dispose();
    b.dispose();
    c.dispose();
  });

  it('bikes and the buggy take panel paint too', () => {
    for (const id of ['moped', 'quad', 'buggy']) {
      const d = chassisDef(id);
      const centres = wheelCentres(d);
      const b = newBuild(id, { seed: 2, paint: 0x4a6a8a });
      b.panels = { front: 0xff2020, rear: 0x20ff20 };
      const v = buildVehicleVisual(d, centres, centres.map((_, i) => i < 1), lookOf(b));
      const plain = buildVehicleVisual(d, centres, centres.map((_, i) => i < 1), lookOf(newBuild(id, { seed: 2, paint: 0x4a6a8a })));
      const m = mountsOfChassis(d)!;
      const pick = (zone: string) => (x: number, y: number, z: number) => panelAt(m.m, x, y + m.g0, z) === zone;
      const was = averageColour(plain.body.geometry, pick('front'));
      const now = averageColour(v.body.geometry, pick('front'));
      expect(was.n).toBeGreaterThan(0);
      expect(now.r).toBeGreaterThan(was.r);
      v.dispose();
      plain.dispose();
    }
  });
});
