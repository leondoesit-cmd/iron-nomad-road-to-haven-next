import { describe, it, expect } from 'vitest';
import { TakeDeck, performance, soundProfile, RoomAcoustics } from '../src/audio/dynamics';
import { SpatialAudioEngine } from '../src/audio/spatial';

class Param {
  value = 0;
  setValueAtTime(value: number) { this.value = value; }
  setTargetAtTime(value: number) { this.value = value; }
}
class Node {
  gain = new Param(); frequency = new Param(); Q = new Param(); pan = new Param(); delayTime = new Param();
  connect(dest: Node) { return dest; }
  disconnect() {}
}
const context = () => ({ currentTime: 1, createGain: () => new Node(), createDelay: () => new Node(),
  createBiquadFilter: () => new Node(), createStereoPanner: () => new Node() }) as unknown as AudioContext;

describe('dynamic recorded playback', () => {
  it('exhausts every take before reusing it, without immediate repeats between decks', () => {
    const deck = new TakeDeck();
    const takes = Array.from({ length: 40 }, () => deck.next(5, () => 0.31));
    for (let i = 0; i < takes.length; i += 5) expect(new Set(takes.slice(i,i+5)).size).toBe(5);
    for (let i = 1; i < takes.length; i++) expect(takes[i]).not.toBe(takes[i-1]);
    expect(deck.next(1)).toBe(0); expect(deck.next(0)).toBe(-1);
  });
  it('soft actions become quieter and duller while playback variation preserves animal pitch', () => {
    const soft = performance('splash', .1, 1, () => .5);
    const hard = performance('splash', 1, 1, () => .5);
    expect(hard.gain).toBeGreaterThan(soft.gain);
    expect(hard.cutoff).toBeGreaterThan(soft.cutoff);
    expect(performance('howl',1,1,()=>1).pitch).toBeLessThan(1.02);
    expect(soundProfile('footSand').range).toBeLessThan(soundProfile('pistol').range);
  });
  it('moves an existing sound with listener position and heading, fades at range, and muffles obstacles', () => {
    const spatial = new SpatialAudioEngine(context());
    const route = spatial.createSpatialRoute(10,0,{x:0,z:0},0,new Node() as unknown as AudioNode)!;
    expect((route.panner as StereoPannerNode).pan.value).toBe(1);
    const near = route.attenuation, bright = route.filter.frequency.value;
    spatial.setOcclusionTester(() => .8);
    spatial.updateSpatialRoute(route,10,0,{x:0,z:0,yaw:Math.PI});
    expect((route.panner as StereoPannerNode).pan.value).toBe(-1);
    expect(route.filter.frequency.value).toBeLessThan(bright);
    expect(route.attenuation).toBeLessThan(near);
    spatial.updateSpatialRoute(route,10,0,{x:200,z:0});
    expect(route.attenuation).toBe(0);
    expect(spatial.createSpatialRoute(30,0,{x:0,z:0},0,new Node() as unknown as AudioNode,0,{range:24})).toBeNull();
  });
  it('keeps room reflections independent for players in separate spaces', () => {
    const outside = new RoomAcoustics(context(), new Node() as unknown as AudioNode);
    const inside = new RoomAcoustics(context(), new Node() as unknown as AudioNode);
    outside.update(0); inside.update(1);
    const levels = (room: RoomAcoustics) => (room as unknown as { sends: { gain: GainNode }[] }).sends.map(tap => tap.gain.gain.value);
    expect(levels(outside).every(value => value === 0)).toBe(true);
    expect(levels(inside).every(value => value > 0)).toBe(true);
    inside.update(0);
    expect(levels(inside).every(value => value === 0)).toBe(true);
  });
});
