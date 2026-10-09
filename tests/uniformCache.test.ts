import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { cacheArrayUniform, cacheArrayUniforms } from '../src/render/uniformCache';

/** A stand-in for three's PureArrayUniform: its setter records what it would send to GL. */
function arrayUniform(type: number, size: number, block: number) {
  const sent: number[][] = [];
  const u = {
    id: 'u', type, size,
    setValue(_gl: unknown, value: unknown) {
      const v = value as ArrayLike<number> | { toArray(o: number[], k: number): void }[];
      const out: number[] = [];
      if (typeof (v as ArrayLike<number>)[0] === 'number') out.push(...Array.from(v as ArrayLike<number>));
      else for (let i = 0; i < size; i++) (v as { toArray(o: number[], k: number): void }[])[i].toArray(out, i * block);
      sent.push(out);
    },
  };
  return { u, sent };
}
const gl = {} as WebGL2RenderingContext;

describe('array uniform cache', () => {
  it('sends a typed array again only when a number in it changed, even when it is the same array changed in place', () => {
    const { u, sent } = arrayUniform(0x8b52, 8, 4);
    cacheArrayUniform(u);
    const fire = new Float32Array(32);
    u.setValue(gl, fire);
    u.setValue(gl, fire);
    u.setValue(gl, fire);
    expect(sent.length).toBe(1);
    fire[5] = 2.5;
    u.setValue(gl, fire);
    expect(sent.length).toBe(2);
    expect(sent[1][5]).toBe(2.5);
    u.setValue(gl, fire);
    expect(sent.length).toBe(2);
    fire[5] = 0;
    u.setValue(gl, fire);
    expect(sent.length).toBe(3);
  });

  it('compares matrix arrays by their numbers, as three flattens them', () => {
    const { u, sent } = arrayUniform(0x8b5c, 1, 16);
    cacheArrayUniform(u);
    const m = [new THREE.Matrix4().makeTranslation(1, 2, 3)];
    u.setValue(gl, m);
    u.setValue(gl, [m[0].clone()]);
    expect(sent.length).toBe(1);
    m[0].makeTranslation(1, 2, 3.5);
    u.setValue(gl, m);
    expect(sent.length).toBe(2);
    expect(sent[1][14]).toBe(3.5);
  });

  it('leaves single uniforms, samplers and struct members alone and patches a program once', () => {
    const single = { id: 'diffuse', type: 0x8b51, setValue: () => {} };
    const sampler = { id: 'maps', type: 0x8b5e, size: 4, setValue: () => {} };
    const { u: arr } = arrayUniform(0x8b52, 2, 4);
    const member = arrayUniform(0x8b5c, 1, 16).u;
    const program = { getUniforms: () => ({ seq: [single, sampler, arr, { id: 'lights', seq: [member] }] }) };
    const before = [single.setValue, sampler.setValue, arr.setValue, member.setValue];
    cacheArrayUniforms(program);
    expect(single.setValue).toBe(before[0]);
    expect(sampler.setValue).toBe(before[1]);
    expect(arr.setValue).not.toBe(before[2]);
    expect(member.setValue).not.toBe(before[3]);
    const once = arr.setValue;
    cacheArrayUniforms(program);
    expect(arr.setValue).toBe(once);
  });
});
