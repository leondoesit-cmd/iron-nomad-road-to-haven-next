import { describe, it, expect } from 'vitest';
import { engineCharacter, audioGear, vehicleLayers } from '../src/audio/vehicleAcoustics';
import { reloadSounds, crossedHandlingEvents, weaponHandling } from '../src/audio/weaponAcoustics';
import type { EngineParams } from '../src/audio/engineAudio';
const motor: EngineParams = {id:1,x:0,z:0,tier:3,signature:40,rpm:.5,throttle:.7,topSpeed:30};
describe('customized vehicle acoustics', () => {
  it('uses the fitted motor and displacement independently of chassis identity', () => {
    const small=engineCharacter({...motor,model:'truck',layout:'I3',litres:1});
    const large=engineCharacter({...motor,model:'moped',layout:'V8',litres:6});
    expect(small.family).toBe('car');expect(large.family).toBe('v8');
    expect(engineCharacter({...motor,litres:2,fuel:'diesel'}).family).toBe('diesel');
    expect(engineCharacter({...motor,litres:.25}).family).toBe('bike');
    expect(engineCharacter({...motor,litres:2,layout:'I4'}).pitch).toBeLessThan(small.pitch);
    expect(large.body).toBeGreaterThan(small.body);expect(large.key).not.toBe(small.key);
  });
  it('keeps shifts stable near boundaries and handles reversing', () => {
    expect(audioGear({...motor,speed:7},1)).toBe(1);
    expect(audioGear({...motor,speed:8},1)).toBe(2);
    expect(audioGear({...motor,speed:6.5},2)).toBe(2);
    expect(audioGear({...motor,speed:5},2)).toBe(1);
    expect(audioGear({...motor,speed:-2},2)).toBe(-1);
  });
  it('averages mixed fitted tires, and silences contact layers in the air', () => {
    const tires: EngineParams['tires']=[{tread:'road',condition:0},{tread:'rim',condition:0},{tread:'mud',condition:1},{tread:'crawler',condition:1}];
    const ground=vehicleLayers({...motor,speed:20,tires,surface:'asphalt',slip:1});
    expect(ground.flat).toBeGreaterThan(0);expect(ground.rim).toBe(ground.flat);
    expect(ground.lug).toBeCloseTo(.4125);expect(ground.skid).toBeGreaterThan(0);
    const air=vehicleLayers({...motor,speed:20,tires,grounded:false,slip:1});
    expect([air.rolling,air.flat,air.rim,air.skid]).toEqual([0,0,0,0]);
  });
  it('responds to heat, coolant, exhaust changes and drivetrain wear even while cooling after shutdown', () => {
    expect(vehicleLayers(motor).fan).toBe(0);
    const hot=vehicleLayers({...motor,temperature:1.2,speed:15,exhaustNoise:2,gearboxCondition:.1,engineCondition:.2});
    expect(hot.fan).toBeGreaterThan(0);expect(hot.steam).toBeGreaterThan(0);
    expect(hot.gear).toBeGreaterThan(vehicleLayers({...motor,speed:15}).gear);
    expect(hot.rattle).toBeGreaterThan(0);expect(hot.exhaust).toBeGreaterThan(vehicleLayers(motor).exhaust);
    const stopped=vehicleLayers({...motor,temperature:1.2,running:false});
    expect(stopped.steam).toBeGreaterThan(0);expect(stopped.ticking).toBeGreaterThan(0);
    expect(stopped.exhaust).toBe(0);expect(stopped.rattle).toBe(0);
    expect(vehicleLayers({...motor,temperature:1.2,coolant:0}).steam).toBe(0);
  });
});
describe('recorded weapon action timing', () => {
  it('distinguishes empty and tactical magazine reloads, shell loading and cylinders', () => {
    expect(reloadSounds('pistol',false,false).map(e=>e.cue)).toEqual(['magOut','magIn']);
    expect(reloadSounds('pistol',false,true).map(e=>e.cue)).toEqual(['magOut','magIn','weaponRack']);
    expect(reloadSounds('pump',true,true).map(e=>e.cue)).toEqual(['weaponHandle']);
    expect(reloadSounds('revolver').map(e=>e.cue)).toEqual(['weaponClick','shellInsert','weaponClick']);
    expect(weaponHandling('pump').rack).toBe('weaponPump');
    expect(weaponHandling('rifle').rack).toBe('weaponBolt');
    expect(weaponHandling('lmg').pitch).toBeLessThan(weaponHandling('compact').pitch);
  });
  it('emits crossed landmarks once, including coarse frames, without queuing later actions', () => {
    const events=reloadSounds('pistol',false,true);
    expect(crossedHandlingEvents(events,0,.8).map(e=>e.cue)).toEqual(['magOut','magIn']);
    expect(crossedHandlingEvents(events,.8,1).map(e=>e.cue)).toEqual(['weaponRack']);
    expect(crossedHandlingEvents(events,.88,1)).toEqual([]);
    expect(crossedHandlingEvents([],0,1)).toEqual([]);
  });
});
