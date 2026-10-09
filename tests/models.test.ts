import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { parseBakedModel, registerBakedModel, type BakedModelData } from '../src/render/bakedModel';
import { ANIMAL_MODELS, ANIMAL_MODEL_NAMES } from '../src/render/animalModels';
import { CRITTER_MODEL_NAMES, LifeRenderer, dragonflyWings } from '../src/render/lifeRender';
import { AnimalRenderer } from '../src/render/animalRender';
import { ZombieRenderer, J } from '../src/render/zombieRender';
import { BODY } from '../src/sim/anatomy';
import { ZOMBIE_ACTION } from '../src/sim/zombieAnimation';
import type { AnimalKind } from '../src/data';

const root = resolve('public/models');
type Credit = { license: string; source: string; author: string; title: string };
const sources = JSON.parse(readFileSync(resolve(root, 'sources.json'), 'utf8')) as (Credit & { file: string; sha256: string; also?: Credit[] })[];
const bytes = (name: string) => {
  const b = readFileSync(resolve(root, `${name}.bin`));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const ALL = [...ANIMAL_MODEL_NAMES, ...CRITTER_MODEL_NAMES, 'zombie-anims'];

describe('licensed models', () => {
  it('ships every model with a permissive source, an author, a checksum and a credit', () => {
    const credits = readFileSync(resolve(root, 'CREDITS.txt'), 'utf8');
    for (const name of ALL) {
      const file = `${name}.bin`;
      expect(existsSync(resolve(root, file)), file).toBe(true);
      const e = sources.find((s) => s.file === file);
      expect(e, file).toBeDefined();
      expect(['CC0-1.0', 'CC-BY-3.0']).toContain(e!.license);
      expect(e!.source).toMatch(/^https:\/\//);
      expect(e!.author.length).toBeGreaterThan(0);
      expect(createHash('sha256').update(readFileSync(resolve(root, file))).digest('hex'), file).toBe(e!.sha256);
      // Attribution licences must be credited by title, author and source, a bank's further sources too.
      if (e!.license === 'CC-BY-3.0') expect(credits).toContain(`"${e!.title}" by ${e!.author}, ${e!.source}`);
      for (const a of e!.also ?? []) {
        expect(['CC0-1.0', 'CC-BY-3.0', 'CC-BY-4.0', 'CMU-mocap']).toContain(a.license);
        expect(credits).toContain(`"${a.title}" by ${a.author}, ${a.source}`);
      }
    }
  });

  it('bakes sound, skinned geometry and in-range clips', () => {
    for (const name of [...ANIMAL_MODEL_NAMES, ...CRITTER_MODEL_NAMES]) {
      const d = parseBakedModel(bytes(name));
      // A dragonfly's wing is a flat blade of a few triangles; everything else is a body.
      expect(d.verts, name).toBeGreaterThan(name === 'critter-dragonwing' ? 8 : 100);
      expect(d.position.length).toBe(d.verts * 3);
      expect(Array.from(d.position).every(Number.isFinite), name).toBe(true);
      expect(Math.max(...d.index)).toBeLessThan(d.verts);
      if (!d.bones) continue;
      for (let i = 0; i < d.verts; i++) {
        let w = 0;
        for (let c = 0; c < 4; c++) {
          expect(d.skinIndex[i * 4 + c]).toBeLessThan(d.bones);
          w += d.skinWeight[i * 4 + c];
        }
        expect(Math.abs(w - 255), `${name} weights at ${i}`).toBeLessThan(6);
      }
      expect(d.anim.length).toBe(d.frames * d.bones * 12);
      for (const c of Object.values(d.clips)) expect(c.start + c.frames).toBeLessThanOrEqual(d.frames);
    }
  });

  it('gives every species the clips the renderer plays, at the size its body is hit at', () => {
    for (const [kind, sp] of Object.entries(ANIMAL_MODELS) as [AnimalKind, (typeof ANIMAL_MODELS)[AnimalKind]][]) {
      const g = parseBakedModel(bytes(sp.ground));
      for (const role of ['idle', 'death']) expect(g.clips[role], `${kind} ${role}`).toBeDefined();
      if (!sp.flyer) {
        for (const role of ['walk', 'run', 'eat', 'attack']) expect(g.clips[role], `${kind} ${role}`).toBeDefined();
        // More than one way of standing about, and a flinch to either side.
        expect(g.clips['idle.1'], `${kind} idle.1`).toBeDefined();
        expect(g.clips['hit.1'], `${kind} hit.1`).toBeDefined();
        const h = g.bounds[1][1] - g.bounds[0][1];
        // Near the anatomy's standing height (the bounds cover every frame: a bounding hare or a rearing bear reaches higher,
        // and every auto-rigged beast has a rear clip, if only bears play it).
        expect(h, kind).toBeGreaterThan(BODY[kind].height * 0.75);
        expect(h, kind).toBeLessThan(BODY[kind].height * 2);
      } else {
        const f = parseBakedModel(bytes(sp.flyer));
        expect(f.clips.flap, kind).toBeDefined();
        expect(f.clips.glide, kind).toBeDefined();
      }
    }
  });

  it('splits the dragonfly into a body and one flat wing, with every wing hung where the model had it', () => {
    const body = parseBakedModel(bytes('critter-dragonfly'));
    const wing = parseBakedModel(bytes('critter-dragonwing'));
    // The wing: hinge at the origin, 1 long along +x, flat.
    const xs = Array.from(wing.position).filter((_, i) => i % 3 === 0);
    const ys = Array.from(wing.position).filter((_, i) => i % 3 === 1);
    expect(Math.min(...xs)).toBeCloseTo(0, 2);
    expect(Math.max(...xs)).toBeCloseTo(1, 2);
    expect(Math.max(...ys.map(Math.abs))).toBeLessThan(1e-6);
    // Fore wings ahead of the hind ones, near the midline, on the top of the thorax, each most of a body length.
    const { fore, hind } = body.mounts as unknown as Record<string, number[]>;
    expect(fore[2]).toBeGreaterThan(hind[2]);
    for (const m of [fore, hind]) {
      expect(Math.abs(m[0])).toBeLessThan(0.1);
      expect(m[3]).toBeGreaterThan(0.6);
      expect(m[3]).toBeLessThan(1.1);
    }
  });

  it('gives the heron and the egret their own bodies on the wing', () => {
    for (const kind of ['heron', 'egret'] as const) {
      const f = parseBakedModel(bytes(ANIMAL_MODELS[kind].flyer!));
      expect(f.clips.flap, kind).toBeDefined();
      // Spread wings: far wider than deep, its neck and trailing legs giving it length.
      const [mn, mx] = f.bounds;
      expect(mx[0] - mn[0], kind).toBeGreaterThan(0.95);
      expect(mx[2] - mn[2], kind).toBeGreaterThan(0.3);
      expect(mx[1] - mn[1], kind).toBeLessThan(0.6);
    }
  });

  it('retargets the zombie moves onto the bodies the game builds, at their own joints', () => {
    const d = parseBakedModel(bytes('zombie-anims'));
    expect(d.boneNames).toHaveLength(11);
    for (const role of ['idle', 'walk', 'jog', 'sprint', 'crouch', 'crawl', 'scratch', 'kneel', 'scream', 'punch', 'hit', 'death']) expect(d.clips[role], role).toBeDefined();
    // Several takes of the moves a horde shows most, the captures among them cut to loops that close on themselves.
    const count = (move: string) => Object.keys(d.clips).filter((k) => k.split('.')[0] === move).length;
    expect(count('walk')).toBeGreaterThanOrEqual(4);
    expect(count('idle')).toBeGreaterThanOrEqual(2);
    for (const move of ['jog', 'punch', 'hit', 'death', 'scream']) expect(count(move), move).toBeGreaterThanOrEqual(2);
    const jt = d.joints!;
    expect(jt.thighL).toEqual(J.hipL);
    expect(jt.shinL).toEqual(J.kneeL);
    expect(jt.upperArmL).toEqual(J.shL);
    expect(jt.foreArmL).toEqual(J.elL);
    expect(jt.head).toEqual(J.neck);
    // Gaits keep a foot on the ground; the death clip ends lying down (its pelvis low).
    const pelvisY = (frame: number) => {
      const o = frame * 11 * 12; // bone 0, row 1, column 3 is the y translation of v' = P + G (v - J)
      const m = new THREE.Matrix4();
      const e: number[] = [];
      for (let i = 0; i < 12; i++) e.push(THREE.DataUtils.fromHalfFloat(d.anim[o + i]));
      m.set(e[0], e[1], e[2], e[3], e[4], e[5], e[6], e[7], e[8], e[9], e[10], e[11], 0, 0, 0, 1);
      return new THREE.Vector3(0, 0.94, 0).applyMatrix4(m).y;
    };
    expect(pelvisY(d.clips.walk.start)).toBeGreaterThan(0.8);
    expect(pelvisY(d.clips.death.start + d.clips.death.frames - 1)).toBeLessThan(0.35);
    // Many deaths, each ending flat on the ground (not held up off it, not sunk into it), on the back and on the face.
    const joint = (frame: number, bone: number, j: readonly number[]) => {
      const o = (frame * 11 + bone) * 12;
      const e: number[] = [];
      for (let i = 0; i < 12; i++) e.push(THREE.DataUtils.fromHalfFloat(d.anim[o + i]));
      return new THREE.Vector3(e[0] * j[0] + e[1] * j[1] + e[2] * j[2] + e[3], e[4] * j[0] + e[5] * j[1] + e[6] * j[2] + e[7], e[8] * j[0] + e[9] * j[1] + e[10] * j[2] + e[11]);
    };
    const deaths = Object.entries(d.clips).filter(([k]) => k.split('.')[0] === 'death');
    expect(deaths.length).toBeGreaterThanOrEqual(8);
    let back = 0;
    const ends: number[][] = [];
    for (const [name, c] of deaths) {
      const last = c.start + c.frames - 1;
      const pelvis = joint(last, 0, [0, 0.94, 0]);
      const chest = joint(last, 1, [0, 1.2, -0.01]);
      const head = joint(last, 2, J.neck);
      expect(pelvis.y, name).toBeLessThan(0.2);
      expect(chest.y, name).toBeLessThan(0.25);
      for (let f = c.start; f <= last; f++) expect(joint(f, 0, [0, 0.94, 0]).y, name).toBeGreaterThan(0.05);
      if (head.z < pelvis.z) back++;
      const ankle = joint(last, 4, [0.11, 0.12, 0.01]);
      const hand = joint(last, 8, [0.23, 0.9, 0.02]);
      ends.push([head.x, head.y, head.z, ankle.x, ankle.y, ankle.z, hand.x, hand.y, hand.z]);
    }
    expect(back).toBeGreaterThanOrEqual(3);
    expect(deaths.length - back).toBeGreaterThanOrEqual(3);
    // No two end the same.
    for (let a = 0; a < ends.length; a++) for (let b = a + 1; b < ends.length; b++) {
      expect(Math.hypot(...ends[a].map((v, i) => v - ends[b][i])), `${deaths[a][0]} ${deaths[b][0]}`).toBeGreaterThan(0.08);
    }
  });
});

/** Register the shipped files as if the browser had loaded them (textures are not needed in Node). */
function registerAll() {
  const out: Record<string, BakedModelData> = {};
  for (const name of ALL) out[name] = registerBakedModel(name, bytes(name)).data;
  return out;
}

describe('rendering from the models', () => {
  it('draws a herd from its model: walking blends idle into walk on the legs phase, a dead one plays its death', () => {
    const models = registerAll();
    const ar = new AnimalRenderer();
    ar.begin();
    ar.push('wolf', 1, 0, 0, 0, 0, Math.PI, 0.3, 0, 0, 0, 1);
    ar.push('wolf', 1, 2, 0, 0, 0, 0, 0, 1.2, 0, 0, 1, { dying: 0.8 });
    ar.push('vulture', 1, 4, 5, 0, 0, 0, 0.5, 0, Math.PI, 0.2, 1, { fold: 0, glide: 0 });
    ar.end();
    const meshes: THREE.InstancedMesh[] = [];
    ar.group.traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh) meshes.push(o as THREE.InstancedMesh); });
    const wolf = meshes.find((m) => m.geometry.getAttribute('position').count === models['animal-wolf'].verts)!;
    expect(wolf.count).toBe(2);
    const A = wolf.geometry.getAttribute('iClipA');
    const B = wolf.geometry.getAttribute('iClipB');
    const c = models['animal-wolf'].clips;
    expect(A.getX(0)).toBe(c.idle.start);
    expect(B.getX(0)).toBe(c.walk.start);
    expect(B.getZ(0)).toBeCloseTo(0.5);
    expect(B.getW(0)).toBeGreaterThan(0.3);
    expect(A.getX(1)).toBe(c.death.start);
    expect(A.getZ(1)).toBeCloseTo(0.8);
    // A vulture on the wing uses its flyer, flapping on its wing-beat phase.
    const flyer = meshes.find((m) => m.geometry.getAttribute('position').count === models['flyer-brown'].verts && m.count > 0)!;
    expect(flyer.geometry.getAttribute('iClipA').getX(0)).toBe(models['flyer-brown'].clips.flap.start);
    ar.dispose();
  });

  it('gives each animal its own takes: idles that wander between moves, deaths, flinches toward the side of a hit', () => {
    const models = registerAll();
    const ar = new AnimalRenderer();
    ar.begin();
    // Standing wolves of different seeds, over a stretch of time: more than one idle shows.
    const idleStarts = new Set<number>();
    for (let seed = 0; seed < 12; seed++) ar.push('wolf', 1, seed * 2, 0, 0, 0, 0, 0, 0, 0, 0, 1, { seed });
    // A wolf hit from its left and one from its right flinch with different takes.
    ar.push('wolf', 1, 30, 0, 0, 0, 0, 0, 0, 0, 0, 1, { seed: 1, hit: 0.3 });
    ar.push('wolf', 1, 32, 0, 0, 0, 0, 0, 0, 0, 0, 1, { seed: 1, hit: -0.3 });
    ar.end();
    const meshes: THREE.InstancedMesh[] = [];
    ar.group.traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh) meshes.push(o as THREE.InstancedMesh); });
    const wolf = meshes.find((m) => m.geometry.getAttribute('position').count === models['animal-wolf'].verts)!;
    const A = wolf.geometry.getAttribute('iClipA');
    const B = wolf.geometry.getAttribute('iClipB');
    for (let i = 0; i < 12; i++) idleStarts.add(A.getX(i));
    expect(idleStarts.size).toBeGreaterThan(1);
    const c = models['animal-wolf'].clips;
    expect(B.getX(12)).toBe(c.hit.start);
    expect(B.getX(13)).toBe(c['hit.1'].start);
    expect(B.getW(12)).toBeGreaterThan(0.5);
    ar.dispose();
  });

  it('draws small birds and bats from their models, standing or on the wing, and the dragonfly from its own', () => {
    const models = registerAll();
    expect(dragonflyWings().fore).toEqual(models['critter-dragonfly'].mounts!.fore);
    const lr = new LifeRenderer();
    lr.begin();
    const pose = { fly: false, beat: 0, glide: 0, peck: 0.7, time: 1 };
    expect(lr.putBird('songbird', 0, 0, 0, 0, 0, 0, 0.15, 0.6, 0.5, 0.4, pose)).toBe(true);
    expect(lr.putBird('perched', 1, 0, 0, 0, 0, 0, 0.15, 0.6, 0.5, 0.4, { ...pose, fly: true, beat: 1 })).toBe(true);
    // A bat has no standing model: it is always drawn on the wing.
    expect(lr.putBird('bat', 2, 2, 0, 0, 0, 0, 0.08, 0.2, 0.2, 0.2, pose)).toBe(true);
    lr.end();
    const herds: THREE.InstancedMesh[] = [];
    lr.group.traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh && (o as THREE.InstancedMesh).geometry.getAttribute('iClipA')) herds.push(o as THREE.InstancedMesh); });
    const by = (name: string) => herds.find((m) => m.geometry.getAttribute('position').count === models[name].verts)!;
    expect(by('bird-sparrow').count).toBe(1);
    // Pecking blends the feeding clip over the idle.
    const A = by('bird-sparrow').geometry.getAttribute('iClipB');
    expect(A.getX(0)).toBe(models['bird-sparrow'].clips.eat.start);
    expect(A.getW(0)).toBeCloseTo(0.7);
    expect(by('flyer-small').count).toBe(1);
    expect(by('flyer-bat').count).toBe(1);
    lr.dispose();
  });

  it('drives the zombie bodies with the motion library inside the attribute budget', () => {
    const models = registerAll();
    const c = models['zombie-anims'].clips;
    const zr = new ZombieRenderer({ max: 16 });
    zr.begin();
    zr.push('walker', 1, 0, 0, 0, 0, Math.PI, 0, 0, 0, 3, 1, 0, 0, 0, { move: 1, action: ZOMBIE_ACTION.idle, weight: 0 });
    zr.push('stalker', 1, 1, 0, 0, 0, 0, 0, 0, 0, 4, 1, 0, 0, 0, { move: 1, action: ZOMBIE_ACTION.grab, weight: 1 });
    zr.push('walker', 1, 2, 0, 0, 0, 0, 0, 0, 0.6, 5, 1, 0, 0, 0, { move: 0, action: 0, weight: 0 });
    // Bodies of different looks keep different takes of the same walk.
    for (let v = 0; v < 12; v++) zr.push('walker', 1, 4 + v, 0, 0, 0, 0, 0, 0, 0, v, 1, 0, 0, 0, { move: 1, action: ZOMBIE_ACTION.idle, weight: 0 });
    zr.end(1);
    const geo = zr.mesh.geometry;
    const walks = new Set<number>();
    for (let k = 3; k < 15; k++) walks.add(geo.getAttribute('aAnim').getX(k));
    expect(walks.size).toBeGreaterThan(2);
    const A = geo.getAttribute('aAnim');
    const M = geo.getAttribute('aMotion');
    // Every take of a move: a body plays one of them (its own, by its looks).
    const takes = (move: string) => Object.entries(c).filter(([k]) => k.split('.')[0] === move).map(([, v]) => v);
    expect(takes('walk').map((x) => x.start)).toContain(A.getX(0));
    expect(A.getZ(0)).toBeCloseTo(0.5);
    expect(takes('crouch').map((x) => x.start)).toContain(A.getX(1));
    expect(M.getX(1)).toBe(c.scratch.start);
    const death = takes('death').find((x) => x.start === A.getX(2))!;
    expect(death).toBeDefined();
    expect(A.getY(2)).toBe(-death.frames);
    expect(Object.keys(geo.attributes).length + 4).toBeLessThanOrEqual(16);
    // The shader takes the baked path.
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
    const mat = zr.mesh.material as THREE.MeshStandardMaterial;
    mat.onBeforeCompile(shader as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader.startsWith('#define Z_BAKED')).toBe(true);
    geo.dispose();
    mat.dispose();
  });
});
