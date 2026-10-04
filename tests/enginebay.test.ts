import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { initPhysics } from '../src/physics/physics';
import { PARTS, chassisDef, legById, partDef } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { Btn } from '../src/input/intents';
import { CUT_HOOD_ID, cutHood, installPart, newBuild, removePart, statsOf } from '../src/sim/garage';
import { newPart } from '../src/sim/parts';
import { BAY_TEXT, bayFit, bayText, engineSpec, hoodState } from '../src/sim/engines';
import { BAY_ENVELOPE, engineDims, envelopeOf } from '../src/sim/engineSize';
import { forecastSwap } from '../src/sim/forecast';
import { planFit } from '../src/sim/carry';
import { BAY_CLEAR, bayVolume, bulgeHeight, enginePlacement, type EngineLook } from '../src/render/attachments';
import { mountsOfChassis } from '../src/render/vehicleModels';
import { engineBounds, engineExtent, engineSignature } from '../src/render/engineModels';
import { socketFor } from '../src/render/sockets';
import { MARK_PX, compactLines, focusLines, markPx, pxToWorld, setMarkerUiScale, viewScale } from '../src/render/markers';
import { fakeServices } from './helpers/sim';
import { pose, standAt } from './helpers/access';

vi.setConfig({ testTimeout: 90000 });

beforeAll(async () => {
  await initPhysics();
});

const ENGINES = PARTS.parts.filter((p) => p.slot === 'engine' && p.engine && !p.empty);
const HOODED = ['hatch', 'sedan', 'pickup', 'van', 'buggy'];

describe('engines are really sized', () => {
  it('every engine fits the envelope of its class, and is longer than the class below', () => {
    for (const p of ENGINES) {
      const spec = p.engine!;
      const d = engineDims(spec);
      const env = envelopeOf(spec.size);
      expect(d.l, p.id).toBeLessThanOrEqual(env.l + 1e-9);
      expect(d.w, p.id).toBeLessThanOrEqual(env.w + 1e-9);
      expect(d.h, p.id).toBeLessThanOrEqual(env.h + 1e-9);
      if (spec.size >= 2) expect(d.l, p.id).toBeGreaterThan(BAY_ENVELOPE[spec.size - 1].l);
    }
  });

  it('size follows the spec: a scooter motor is tiny, a rig diesel is a wall, a V8 is wider than an inline four', () => {
    const dims = (id: string) => engineDims(partDef(id).engine!);
    expect(dims('eng_50cc').l).toBeLessThan(dims('eng_250').l + 0.1);
    expect(dims('eng_50cc').h).toBeLessThan(dims('eng_i4').h);
    expect(dims('eng_d145').h).toBeGreaterThan(dims('eng_v8').h);
    expect(dims('eng_d145').l).toBeGreaterThan(dims('eng_d66').l);
    expect(dims('eng_v8').w).toBeGreaterThan(dims('eng_i4').w);
    // A boxer is low and wide for its length.
    expect(dims('eng_b4').h).toBeLessThan(dims('eng_i4').h);
    expect(dims('eng_b4').w).toBeGreaterThan(dims('eng_i4').w);
  });

  it('the drawn model stays inside its dimensions, standing on its base', () => {
    for (const p of ENGINES) {
      const d = engineDims(p.engine!);
      const bb = engineBounds(p.id);
      const tol = 0.06;
      expect(bb.max.x - bb.min.x, `${p.id} width`).toBeLessThanOrEqual(d.w + tol);
      expect(bb.max.z - bb.min.z, `${p.id} length`).toBeLessThanOrEqual(d.l + tol);
      expect(bb.max.y, `${p.id} height`).toBeLessThanOrEqual(d.h + tol);
      expect(bb.min.y, `${p.id} base`).toBeGreaterThan(-0.05);
      expect(engineExtent(p.id).h).toBeGreaterThan(0.15);
    }
  });

  it('every engine id has its own geometry', () => {
    const sig = new Map<number, string>();
    for (const p of ENGINES) {
      const s = engineSignature(p.id);
      expect(sig.has(s.hash), `${p.id} looks like ${sig.get(s.hash)}`).toBe(false);
      sig.set(s.hash, p.id);
      expect(s.tris, p.id).toBeGreaterThan(300);
    }
    // And the empty bay is mounts only.
    expect(engineSignature('eng_none').tris).toBeLessThan(engineSignature('eng_50cc').tris);
    // Wear changes the surface, never the shape: same size, same triangles.
    expect(engineSignature('eng_v8', 0.9).size).toEqual(engineSignature('eng_v8', 0.1).size);
  });

  it('layouts and tops differ: an inline, a vee, a flat engine, a blown one and a diesel do not share a silhouette', () => {
    const size = (id: string) => engineSignature(id).size.join('x');
    const set = new Set(['eng_i4', 'eng_v6', 'eng_b4', 'eng_v8', 'eng_d4', 'eng_d145', 'eng_50cc', 'eng_650'].map(size));
    expect(set.size).toBe(8);
  });
});

describe('every chassis has a real engine bay', () => {
  it('holds the biggest engine of its class under a closed bonnet, with clearance, in every dimension', () => {
    for (const id of HOODED) {
      const def = chassisDef(id);
      const mt = mountsOfChassis(def)!;
      const vol = bayVolume(mt.m)!;
      expect(vol, id).toBeTruthy();
      const env = envelopeOf(def.bay ?? 3);
      expect(env.h + BAY_CLEAR, `${id} height`).toBeLessThanOrEqual(vol.h + 1e-9);
      expect(env.w + BAY_CLEAR * 2, `${id} width`).toBeLessThanOrEqual(vol.w + 1e-9);
      // The radiator and fan stay clear of the front, the cowl is the back.
      expect(env.l + BAY_CLEAR, `${id} length`).toBeLessThanOrEqual(vol.l + 1e-9);
    }
  });

  it('every engine of the bay class or smaller sits entirely under the closed bonnet, and nothing shows above it', () => {
    for (const id of HOODED) {
      const def = chassisDef(id);
      const { m } = mountsOfChassis(def)!;
      const vol = bayVolume(m)!;
      for (const p of ENGINES.filter((q) => q.engine!.size <= (def.bay ?? 0))) {
        const look: EngineLook = { id: p.id, mk: 0, swapped: false, blown: !!p.engine!.blown, diesel: p.engine!.fuel === 'diesel', oversize: p.engine!.size - (def.bay ?? 0), size: p.engine!.size, empty: false, wear: 0, hood: 'closed' };
        const pl = enginePlacement(m, look)!;
        expect(pl, `${id}/${p.id}`).toBeTruthy();
        expect(pl.lift, `${id}/${p.id} lift`).toBe(0);
        expect(pl.y + pl.dims.h + BAY_CLEAR, `${id}/${p.id} under the bonnet`).toBeLessThanOrEqual(vol.top + 1e-9);
        expect(pl.z - pl.dims.l / 2, `${id}/${p.id} cowl`).toBeGreaterThanOrEqual(vol.z0 - 1e-9);
        expect(pl.z + pl.dims.l / 2, `${id}/${p.id} radiator`).toBeLessThanOrEqual(vol.z1 + 1e-9);
        expect(Math.abs(pl.x) + pl.dims.w / 2, `${id}/${p.id} wings`).toBeLessThanOrEqual(vol.w / 2 + 1e-9);
        expect(bulgeHeight(m, look), `${id}/${p.id} bulge`).toBe(0);
      }
    }
  });

  it('every engine of a bigger class does not fit under a closed bonnet: it is physically longer than the room the bay is rated for', () => {
    for (const id of HOODED) {
      const def = chassisDef(id);
      const room = envelopeOf(def.bay ?? 0);
      for (const p of ENGINES.filter((q) => q.engine!.size > (def.bay ?? 0))) {
        const fit = bayFit(def, p.engine!);
        expect(fit.fitsClosed, `${id}/${p.id}`).toBe(false);
        expect(engineDims(p.engine!).l, `${id}/${p.id}`).toBeGreaterThan(room.l);
        expect(fit.bonnet, `${id}/${p.id}`).not.toBe('flat');
      }
    }
  });

  it('the tiers by class: snug bulges the bonnet, tight props it, three or more cannot be closed over', () => {
    const hatch = chassisDef('hatch');
    expect(bayFit(hatch, partDef('eng_i3').engine!).bonnet).toBe('flat');
    expect(bayFit(hatch, partDef('eng_i4').engine!).bonnet).toBe('bulge');
    expect(bayFit(hatch, partDef('eng_v6').engine!).bonnet).toBe('prop');
    expect(bayFit(hatch, partDef('eng_v8').engine!).bonnet).toBe('blocked');
    expect(bayFit(hatch, partDef('eng_v8').engine!).label).toBe('cut');
  });

  it('a snug engine raises a bulge in the bonnet; the same engine through a cut bonnet stands up through the hole', () => {
    const def = chassisDef('sedan');
    const { m } = mountsOfChassis(def)!;
    const base: EngineLook = { id: 'eng_v6', mk: 2, swapped: true, blown: false, diesel: false, oversize: 1, size: 4, empty: false, wear: 0, hood: 'closed' };
    expect(bulgeHeight(m, base)).toBeGreaterThan(0.03);
    expect(bulgeHeight(m, { ...base, hood: 'cut' })).toBe(0);
    const closed = enginePlacement(m, base)!;
    const cut = enginePlacement(m, { ...base, hood: 'cut' })!;
    expect(cut.y + cut.dims.h).toBeGreaterThan(m.hood!.y + 0.01);
    expect(cut.y + cut.dims.h).toBeGreaterThan(closed.y + closed.dims.h - 1e-9);
  });

  it('the engine socket hugs the room of the bay, not the whole bonnet', () => {
    const def = chassisDef('sedan');
    const s = socketFor(def, 'engine')!;
    const env = envelopeOf(def.bay!);
    expect(s.anchors).toHaveLength(1);
    expect(s.anchors[0].sz).toBeLessThanOrEqual(env.l + 1e-9);
    expect(s.anchors[0].sx).toBeLessThanOrEqual(env.w + 1e-9);
    expect(s.anchors[0].sy).toBeLessThanOrEqual(env.h + 1e-9);
  });
});

describe('engines too big for the bonnet: prompts, forecasts and the cut', () => {
  it('say so, with the way out', () => {
    const b = newBuild('hatch', { seed: 5 });
    const f = forecastSwap(b, 'engine', newPart('eng_v8', 1));
    expect(f.notes).toContain('Does not fit under the bonnet: cut the hood or remove it');
    expect(BAY_TEXT.cut).toMatch(/cut the hood or remove it/);
    const snug = forecastSwap(b, 'engine', newPart('eng_i4', 1));
    expect(snug.notes.join(' ')).toMatch(/bulges/);
    // An engine that fits says nothing about the bonnet.
    const ok = forecastSwap(b, 'engine', newPart('eng_i3', 1));
    expect(ok.notes.join(' ')).not.toMatch(/bonnet/);
    // The fit prompt carries it too.
    const plan = planFit({ kind: 'part', item: newPart('eng_v8', 1) }, { def: chassisDef('hatch'), fitted: () => undefined, fuel: 0, tankMax: 8, oil: 1 });
    expect(plan.label).toMatch(/cut the hood or remove it/);
  });

  it('cutting the bonnet is permanent and changes what it says: the engine pokes through, the radiator breathes a little easier', () => {
    const b = newBuild('hatch', { seed: 6 });
    installPart(b, newPart('eng_v8', 1));
    const before = statsOf(b);
    expect(before.bayLabel).toBe('cut');
    expect(hoodState(b.fit)).toBe('closed');
    const r = cutHood(b);
    expect(r.ok).toBe(true);
    expect(b.fit.hood!.id).toBe(CUT_HOOD_ID);
    expect(hoodState(b.fit)).toBe('cut');
    expect(bayText('cut', 'cut')).not.toBe(bayText('cut', 'closed'));
    const after = statsOf(b);
    expect(after.airflow).toBeGreaterThan(before.airflow);
    // A second cut does nothing, and a missing bonnet cannot be cut.
    expect(cutHood(b).ok).toBe(false);
    const naked = newBuild('hatch', { seed: 7 });
    removePart(naked, 'hood');
    expect(cutHood(naked).ok).toBe(false);
    expect(cutHood(newBuild('moped', { seed: 8 })).ok).toBe(false);
    // The part counts as a bonnet (and is never loot or on the fabricate list).
    expect(partDef(CUT_HOOD_ID).slot).toBe('hood');
    expect(partDef(CUT_HOOD_ID).stock).toBe(true);
  });

  it('a cut bonnet survives saving and loading', () => {
    const b = newBuild('sedan', { seed: 9 });
    installPart(b, newPart('eng_d8', 1));
    cutHood(b);
    const copy = JSON.parse(JSON.stringify(b)) as typeof b;
    expect(copy.fit.hood!.id).toBe(CUT_HOOD_ID);
    expect(hoodState(copy.fit)).toBe('cut');
    expect(engineSpec(chassisDef('sedan'), copy.fit).litres).toBeCloseTo(6.7);
    expect(bayFit(chassisDef('sedan'), partDef('eng_d8').engine!, hoodState(copy.fit)).hood).toBe('cut');
  });
});

describe('in the world: the propped bonnet and the cut', () => {
  const DT = 1 / 60;
  const run = (sc: LegScene, secs: number) => {
    for (let i = 0; i < Math.round(secs / DT); i++) {
      sc.tick(DT);
      pose(sc);
    }
  };
  function car(chassis: string, setup: (b: ReturnType<typeof newBuild>) => void) {
    const h = fakeServices();
    const sc = new LegScene(h.svc, legById('L1'));
    sc.pendingResult = true;
    const p = sc.players[0];
    p.exitVehicle(false);
    const st = sc.src.layout.start;
    const x = st.x + 30;
    const z = st.z + 8;
    const b = newBuild(chassis, { seed: 31, fuel: 0.2 });
    setup(b);
    const v = sc.spawnVehicle({ build: b, x, z, y: sc.groundAt(x, z), yaw: 0, ownerIndex: 0, faction: 'convoy' });
    sc.campaign.adopt(b);
    run(sc, 1.5);
    return { h, sc, v, p };
  }

  it('an engine that fits leaves the bonnet shut; a tight one props it; one that cannot go under it holds it well up', () => {
    const fits = car('sedan', (b) => installPart(b, newPart('eng_i4', 1)));
    expect(fits.v.hoodProp()).toBe(0);
    expect(fits.v.swing.hood).toBe(0);
    const tight = car('sedan', (b) => installPart(b, newPart('eng_v8', 1)));
    expect(tight.v.hoodProp()).toBeGreaterThan(0.2);
    expect(tight.v.swing.hood).toBeGreaterThan(0.2);
    expect(tight.v.panelOpen().hood).toBe(false);
    const blocked = car('hatch', (b) => installPart(b, newPart('eng_v8', 1)));
    expect(blocked.v.hoodProp()).toBeGreaterThan(tight.v.hoodProp());
    expect(blocked.v.swing.hood).toBeGreaterThan(0.5);
    // The same engine with the bonnet off or cut needs no prop.
    const off = car('hatch', (b) => {
      installPart(b, newPart('eng_v8', 1));
      removePart(b, 'hood');
    });
    expect(off.v.hoodProp()).toBe(0);
  });

  it('the wrench at a shut bonnet over an engine that does not fit offers to cut it, and cutting takes the prop away for good', () => {
    const { h, sc, v, p } = car('hatch', (b) => installPart(b, newPart('eng_v8', 1)));
    p.equip = 'wrench';
    standAt(sc, v, 'hood');
    run(sc, 0.3);
    expect(p.prompt?.text).toMatch(/^Cut a hole in the bonnet for Supercharged V8/);
    const it = h.intents[0];
    it.device = 'keyboard';
    for (let i = 0; i < Math.round(6 / DT); i++) {
      it.held |= 1 << Btn.A;
      it.pressed = i === 0 ? 1 << Btn.A : 0;
      it.heldTime[Btn.A] += DT;
      sc.tick(DT);
      pose(sc);
    }
    it.held &= ~(1 << Btn.A);
    it.pressed = 0;
    it.released = 1 << Btn.A;
    it.heldTime[Btn.A] = 0;
    sc.tick(DT);
    it.released = 0;
    expect(v.build!.fit.hood!.id).toBe(CUT_HOOD_ID);
    expect(v.hoodProp()).toBe(0);
    run(sc, 1.2);
    expect(v.swing.hood).toBeLessThan(0.05);
    // Nothing more to cut now.
    run(sc, 0.3);
    expect(p.prompt?.text ?? '').not.toMatch(/Cut a hole/);
  });
});

describe('the selection markers are small, crisp and clamped', () => {
  it('text keeps a screen size: never above its design size, never below four fifths of it, whatever the distance', () => {
    setMarkerUiScale(1);
    for (const d of [0.5, 2, 6, 9, 15, 40, 400]) {
      const px = markPx(MARK_PX.text, d, 1080);
      expect(px, `d=${d}`).toBeLessThanOrEqual(MARK_PX.text + 1e-9);
      expect(px, `d=${d}`).toBeGreaterThanOrEqual(MARK_PX.text * 0.8 - 1e-9);
    }
    expect(MARK_PX.text).toBeLessThanOrEqual(16);
    expect(MARK_PX.dot).toBeLessThanOrEqual(10);
  });

  it('follows the UI scale setting, and a half-height split-screen view gets smaller markers', () => {
    setMarkerUiScale(1);
    const base = markPx(MARK_PX.text, 4, 1080);
    setMarkerUiScale(1.5);
    expect(markPx(MARK_PX.text, 4, 1080)).toBeCloseTo(base * 1.5);
    setMarkerUiScale(1);
    expect(viewScale(540)).toBeLessThan(viewScale(1080));
    expect(markPx(MARK_PX.text, 4, 540)).toBeLessThan(base);
    expect(markPx(MARK_PX.text, 4, 540)).toBeGreaterThan(base * 0.7);
  });

  it('world size is the pixel size over the view: more distant, bigger in metres, same on screen', () => {
    const near = pxToWorld(14, 3, 45, 1080);
    const far = pxToWorld(14, 12, 45, 1080);
    expect(far / near).toBeCloseTo(4);
    // At 3 m a 14 px label is a few centimetres tall, not the size of the part.
    expect(near).toBeLessThan(0.06);
  });

  it('a tag is two short lines at most', () => {
    const lines = compactLines([
      { text: 'Radiator', css: '#cfc8b4' },
      { text: 'Now: Medium Race Radiator very long name 38%' },
      { text: 'Attach Medium Race Radiator', css: '#8cf08c' },
      { text: 'Open the bonnet first', css: '#ff8a6a' },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0].text).toBe('Radiator');
    expect(lines[1].text).toBe('Open the bonnet first');
    for (const l of lines) expect(l.text.length).toBeLessThanOrEqual(36);
    expect(compactLines([{ text: 'Engine' }])).toHaveLength(1);
    expect(compactLines([])).toEqual([]);
  });

  it('a callout is the name and the one thing about it', () => {
    const a = focusLines('Engine bay: Tuned V6 - unbolt tuned v6', '#fff');
    expect(a.map((l) => l.text)).toEqual(['Engine bay', 'Tuned V6']);
    const b = focusLines('Swap in Tuned V6 (replaces 50cc Scooter Motor)  ·  3.5 L V6 · 150 kW · petrol', '#fff');
    expect(b).toHaveLength(2);
    expect(b[0].text).toBe('Swap in Tuned V6');
    expect(b[1].text).toBe('3.5 L V6');
    expect(focusLines('Bonnet closed - hold to open', '#fff')).toHaveLength(2);
  });

  it('the mark has two sprites, in view and behind, both screen sized', async () => {
    const { Mark } = await import('../src/render/markers');
    const m = new Mark('dot', MARK_PX.dot, 0xffffff, 40);
    expect(m.group.children).toHaveLength(2);
    const [front, behind] = m.group.children as THREE.Sprite[];
    expect((front.material as THREE.SpriteMaterial).depthTest).toBe(true);
    expect((behind.material as THREE.SpriteMaterial).depthTest).toBe(false);
    m.setAlpha(1);
    expect((behind.material as THREE.SpriteMaterial).opacity).toBeLessThan((front.material as THREE.SpriteMaterial).opacity);
    m.dispose();
  });
});
