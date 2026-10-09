import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EYEPIECE, dofActive, dofFor, eyepiece, newSightView, type SightView } from '../src/render/sights';
import { DepthOfField } from '../src/render/dof';
import { kitFor } from '../src/sim/gunmods';
import { gearDef } from '../src/data';

const sight = (o: Partial<SightView>): SightView => ({ ...newSightView(), ...o });

describe('depth of field behind the sights', () => {
  it('the hip view is never blurred, and the setting turns it off', () => {
    expect(dofActive(dofFor(sight({ ads: 0 }), 1.78, 1))).toBe(false);
    expect(dofActive(dofFor(null, 1.78, 1))).toBe(false);
    expect(dofActive(dofFor(sight({ ads: 1, optic: 'scope', sight: 'scope4' }), 1.78, 0))).toBe(false);
  });

  it('behind iron sights the near gun softens and the front sight stays sharp', () => {
    const d = dofFor(sight({ ads: 1 }), 1.78, 1);
    expect(d.nearCoc).toBeGreaterThan(0.005);
    // A long gun's front sight is half a metre and more out: sharp from there on.
    expect(d.near1).toBeLessThanOrEqual(0.55);
    expect(d.near0).toBeLessThan(d.near1);
    // The rear aperture's hole in the middle is kept clear.
    expect(d.keep).toBeGreaterThan(0);
    expect(d.scopeCoc).toBe(0);
    // A handgun is held out past where the blur ends; only the arms reaching to it soften.
    const h = dofFor(sight({ ads: 1, handgun: true }), 1.78, 1);
    expect(h.near1).toBeLessThan(0.55);
    expect(h.nearCoc).toBeGreaterThan(0);
  });

  it('through a red dot the eye is on the target: the whole gun softens, the dot does not', () => {
    const d = dofFor(sight({ ads: 1, optic: 'dot', sight: 'holo' }), 1.78, 1);
    const iron = dofFor(sight({ ads: 1 }), 1.78, 1);
    expect(d.near1).toBeGreaterThan(iron.near1);
    expect(d.keep).toBeGreaterThan(0);
  });

  it('with a scope up, everything round its eyepiece is out of focus', () => {
    const d = dofFor(sight({ ads: 1, optic: 'scope', sight: 'scope8' }), 1.78, 1);
    expect(d.scopeCoc).toBeGreaterThan(d.nearCoc);
    expect(d.scopeR).toBeCloseTo(EYEPIECE.scope8.r, 5);
  });

  it('the blur fades in as the sights come up', () => {
    const a = dofFor(sight({ ads: 0.5 }), 1.78, 1).nearCoc;
    const b = dofFor(sight({ ads: 1 }), 1.78, 1).nearCoc;
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(b);
  });

  it('runs no passes on a frame where nobody aims', () => {
    const rects = { uRectA: { value: new THREE.Vector4(0, 0, 1, 1) }, uRectB: { value: new THREE.Vector4(0, 0, 1, 1) } };
    const dof = new DepthOfField(rects, new THREE.DepthTexture(4, 4));
    const gl = { getRenderTarget: () => { throw new Error('drew'); } } as unknown as THREE.WebGLRenderer;
    dof.run(gl, new THREE.Texture(), 100, 100, 0.2, 1000, [100, 100]);
    expect(dof.ran).toBe(false);
    dofFor(sight({ ads: 1 }), 1.78, 1, dof.views[0]);
    expect(dof.wanted).toBe(true);
    dof.dispose();
  });
});

describe('a scope\'s eyepiece', () => {
  it('fills a large part of the view with the scope up, and nothing with irons or a dot', () => {
    for (const s of ['scope', 'scope4', 'scope8', 'hunt', 'tactical']) {
      const e = eyepiece(sight({ ads: 1, optic: 'scope', sight: s }), 1.78);
      // Radius in NDC height: 0.7 is a window 70% of the view's height across.
      expect(e.r, s).toBeGreaterThan(0.65);
      expect(e.reticle, s).toBeGreaterThan(0);
    }
    expect(eyepiece(sight({ ads: 1, optic: 'iron' }), 1.78).r).toBe(0);
    expect(eyepiece(sight({ ads: 1, optic: 'dot', sight: 'holo' }), 1.78).r).toBe(0);
    // The long scopes have a lit dot in the middle of the reticle.
    expect(eyepiece(sight({ ads: 1, optic: 'scope', sight: 'scope8' }), 1.78).lit).toBe(true);
  });

  it('opens up as the scope comes to the eye, and stays inside a narrow split-screen half', () => {
    const half = eyepiece(sight({ ads: 0.8, optic: 'scope', sight: 'scope4' }), 1.78);
    const full = eyepiece(sight({ ads: 1, optic: 'scope', sight: 'scope4' }), 1.78);
    expect(half.k).toBeGreaterThan(0);
    expect(half.k).toBeLessThan(1);
    expect(half.r).toBeLessThan(full.r);
    expect(eyepiece(sight({ ads: 0.4, optic: 'scope', sight: 'scope4' }), 1.78).r).toBe(0);
    // A tall half (left/right split): the window's width (r / aspect in NDC x) stays inside it.
    const tall = eyepiece(sight({ ads: 1, optic: 'scope', sight: 'scope' }), 0.8);
    expect(tall.r / 0.8).toBeLessThan(1);
  });

  it('every scope the game has knows its eyepiece', () => {
    for (const id of ['a_scope2', 'a_scope4', 'a_scope8']) {
      const k = kitFor(gearDef('w_dmr').gun!, { optic: id });
      expect(k.optic, id).toBe('scope');
      expect(EYEPIECE[k.sight], id).toBeDefined();
    }
    for (const id of ['w_rifle', 'w_sniper']) {
      const k = kitFor(gearDef(id).gun!, undefined);
      expect(k.optic, id).toBe('scope');
      expect(EYEPIECE[k.sight], id).toBeDefined();
    }
  });
});
