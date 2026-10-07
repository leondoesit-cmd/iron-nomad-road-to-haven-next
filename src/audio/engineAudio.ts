import { engineCharacter, vehicleLayers, audioGear, type AudioTire } from './vehicleAcoustics';
import { clamp, damp } from '../core/math';
import type { SampleLibrary } from './samples';
import type { SpatialAudioEngine, SpatialListener, SpatialRoute } from './spatial';

export interface EngineParams {
  id: number; x: number; z: number; rpm: number; throttle: number; tier: number; signature: number;
  speed?: number; lateralG?: number; boost?: number; model?: string;
  fuel?: 'petrol' | 'diesel'; litres?: number; layout?: string; boosted?: boolean;
  running?: boolean; engineCondition?: number; oil?: number; temperature?: number;
  radiatorCondition?: number; coolant?: number; coolingCapacity?: number;
  gearboxCondition?: number; gearing?: number; strain?: number; exhaustNoise?: number;
  topSpeed?: number; wheelRadius?: number; tires?: AudioTire[]; surface?: string;
  grounded?: boolean; slip?: number;
  /** 0..1 how much of the hull or wheels is in water, and whether this is a boat (which keeps lapping while it idles). */
  water?: number; boat?: boolean;

}
interface ActiveEngineVoice {
  idleSrc: AudioBufferSourceNode; loadSrc: AudioBufferSourceNode;
  idleGain: GainNode; loadGain: GainNode; mixGain: GainNode; tone: BiquadFilterNode;
  routes: Map<number, SpatialRoute>;
  lastSeen: number; lastRpm: number; smoothedOcc: number; creakCooldown: number;
  personality: number; previousDistances: Map<number, number>;
  characterKey: string; gear: number; shiftUntil: number; eventCooldown: number; nextTake: number;
  retiring: {source: AudioBufferSourceNode; gain: GainNode; ends: number}[];
  /** Firing-pulse tremolo: the chug of the cylinders, at the rate they fire. */
  pulse: GainNode; pulseOsc: OscillatorNode; pulseDepth: GainNode; wander: number; wanderTarget: number; nextWander: number; rpmLag: number; waterCooldown: number;
  layers: Map<string, { source: AudioBufferSourceNode; gain: GainNode; filter: BiquadFilterNode; zeroSince: number; nextTake: number }>;

}

/** Real running recordings blend by engine load; each vehicle reaches both listeners independently. */
export class VehicleAudioEngine {
  private voices = new Map<number, ActiveEngineVoice>();
  private now = 0;
  /** Per listener 0..1, set by the mixer: how far inside a running vehicle they sit. */
  cabin: number[] = [0, 0];
  constructor(public ctx: AudioContext, public samples: SampleLibrary, public spatial: SpatialAudioEngine) {}
  updateEngines(list: EngineParams[], dt: number, listeners: SpatialListener[], buses: GainNode[], muted: boolean) {
    this.now += dt;
    const seen = new Set<number>();
    const nearest = (e: EngineParams) => Math.min(...listeners.slice(0, this.spatial.solo ? 1 : 2).map(l => Math.hypot(e.x-l.x,e.z-l.z)));
    for (const e of [...list].filter(e => nearest(e)<150).sort((a,b)=>nearest(a)-nearest(b)).slice(0,6)) {
      seen.add(e.id);
      let v = this.voices.get(e.id);
      const character = engineCharacter(e);
      if (v && v.characterKey !== character.key) { this.destroy(v); this.voices.delete(e.id); v = undefined; }
      if (!v) {
        const idle = this.samples.get(`engine-${character.family}-idle`) ?? this.samples.engineIdle;
        const load = this.samples.get(`engine-${character.family}-load`) ?? this.samples.engineMid;
        if (!idle || !load) continue;
        v = this.makeVoice(e, idle, load); this.voices.set(e.id,v);
      }
      v.lastSeen = this.now;
      v.retiring = v.retiring.filter(old => {
        if (this.ctx.currentTime < old.ends) return true;
        old.source.disconnect();old.gain.disconnect();return false;
      });
      if (this.now >= v.nextTake) {
        for (const kind of ['idle','load'] as const) {
          const bank = `engine-${character.family}-${kind}`;
          if (this.samples.all(bank).length<2) continue;
          const oldSource = kind==='idle' ? v.idleSrc : v.loadSrc;
          const oldGain = kind==='idle' ? v.idleGain : v.loadGain;
          const replacement = this.rotateTake(v,bank,oldSource,oldGain,v.tone);
          if (replacement) {
            if (kind==='idle') {v.idleSrc=replacement.source;v.idleGain=replacement.gain;}
            else {v.loadSrc=replacement.source;v.loadGain=replacement.gain;}
          }
        }
        v.nextTake=this.now+6+Math.random()*6;
      }
      const t = this.ctx.currentTime, rpm = clamp(e.rpm,0,1), throttle = clamp(e.throttle,0,1);
      const gear = audioGear(e,v.gear);
      if (gear !== v.gear && this.now > v.shiftUntil && e.running !== false) {
        this.samples.play('gearShift',v.mixGain,t,.12,1+(e.gearing ?? 0)*.07);
        if ((e.gearboxCondition ?? 1)<.4) this.samples.play('gearGrind',v.mixGain,t,.12, .8);
        v.gear = gear; v.shiftUntil = this.now+.24;
      }
      const shifted = this.now < v.shiftUntil;
      const bandRpm = clamp((Math.abs(e.speed ?? 0)/Math.max(8,e.topSpeed ?? 28)*4.5 - Math.max(0,Math.abs(v.gear)-1))*.7+.22+throttle*.18, .2, 1);
      // The motor has inertia and a hand on the throttle: revs chase the target, drift a little at idle and dip across a shift.
      if (this.now >= v.nextWander) { v.wanderTarget = (Math.random()*2-1); v.nextWander = this.now+.25+Math.random()*.9; }
      v.wander = damp(v.wander,v.wanderTarget,2.5,dt);
      const bike = character.family === 'bike';
      // A scooter's belt drive slips: with the throttle held the motor sits high in its power band whatever the road speed.
      const held = bike && e.running !== false ? Math.pow(throttle,.6)*.9 : 0;
      const targetRpm = Math.max(e.topSpeed === undefined ? rpm : bandRpm, held) - (shifted && !bike ? .16 : 0);
      v.rpmLag = damp(v.rpmLag,targetRpm,throttle>.05 || Math.abs(e.speed ?? 0)>2 ? 8 : 2.2,dt);
      const acousticRpm = clamp(v.rpmLag + v.wander*(bike ? .05 : .025)*(1.2-throttle*.9),.08,1);
      const load = clamp(throttle * .78 + acousticRpm * .22,0,1);
      const running = e.running === false ? 0 : 1;
      const engineLoud = character.body * running * (shifted ? .68 : 1);
      const layers = vehicleLayers(e);
      this.updateLayer(v,'boostAir',e.boosted && running ? Math.pow(throttle*acousticRpm,2)*.07 : 0,.8+acousticRpm*.4,4500);
      this.updateLayer(v,'exhaustOpen',layers.exhaust, .8+acousticRpm*.7,1800+(e.exhaustNoise ?? 1)*1800);
      this.updateLayer(v,'radiatorFan',layers.fan,(.8+clamp(e.temperature ?? .2,0,1.4)*.3)*Math.pow(100/Math.max(20,e.coolingCapacity ?? 100),.08),6000);
      this.updateLayer(v,'radiatorSteam',layers.steam,1,11000);
      this.updateLayer(v,'gearWhine',layers.gear,(e.speed ?? 0)<0 ? 1.2 : .7+acousticRpm*.6,3500);
      this.updateLayer(v,'tireRoad',layers.road ? layers.rolling : 0,.65+Math.abs(e.speed ?? 0)/25,5000-layers.lug*2200);
      this.updateLayer(v,'tireGravel',layers.road ? 0 : layers.rolling,.8+Math.abs(e.speed ?? 0)/30,e.surface==='mud' ? 1800 : 5500);
      this.updateLayer(v,'tireSqueal',layers.road ? layers.skid*.22 : 0,.88+layers.skid*.15,8000);
      // Water on the hull: a rushing bed of it along the sides, lapping while afloat, and slaps as the bow meets the chop.
      const wet = clamp(e.water ?? 0,0,1), spd = Math.abs(e.speed ?? 0);
      this.updateLayer(v,'hullRush',wet*clamp((spd-.4)/16,0,1)*(e.boat ? .55 : .3),.75+spd/28,2200+spd*260);
      this.updateLayer(v,'hullLap',e.boat ? wet*.16*(1-clamp(spd/12,0,.6)) : wet*clamp(spd/4,0,1)*.1,.9+Math.sin(this.now*.7+e.id)*.05,3000);
      v.waterCooldown = Math.max(0,v.waterCooldown-dt);
      if (wet>.15 && spd>1.5 && v.waterCooldown===0) {
        this.samples.play('splash',v.mixGain,t,clamp(.12+spd/40,.12,.55)*wet,(.85+Math.random()*.3)*(e.boat ? .85 : 1));
        v.waterCooldown = clamp(1.4/Math.max(1,spd/3),.18,1.2)*(.6+Math.random()*.8);
      }
      v.eventCooldown = Math.max(0,v.eventCooldown-dt);
      if (v.eventCooldown===0) {
        if (layers.flat>.005 || layers.rim>.005) {
          this.samples.play(layers.rim>layers.flat ? 'tink' : 'tireFlat',v.mixGain,t,.13+Math.max(layers.flat,layers.rim)*.4,.65+Math.abs(e.speed ?? 0)/70);
          v.eventCooldown = clamp(2*Math.PI*(e.wheelRadius ?? .32)/Math.max(1,Math.abs(e.speed ?? 0)),.09,.65);
        } else if (layers.rattle>.025) {
          this.samples.play('gearGrind',v.mixGain,t,layers.rattle,.75+acousticRpm*.35);v.eventCooldown=.45+Math.random()*.45;
        } else if (layers.ticking>.015) {
          this.samples.play('hotTick',v.mixGain,t,layers.ticking,1.3);v.eventCooldown=1+Math.random()*2;
        } else if (!layers.road && layers.skid>.15) {
          this.samples.play('tireSkidGravel',v.mixGain,t,layers.skid*.3);v.eventCooldown=.65;
        }
      }

      // Equal-power blend between different recorded running sections, smoothed through throttle changes.
      v.idleGain.gain.setTargetAtTime(Math.cos(load*Math.PI/2)*.65*engineLoud,t,.12);
      v.loadGain.gain.setTargetAtTime(Math.sin(load*Math.PI/2)*.65*engineLoud,t,.12);
      v.tone.frequency.setTargetAtTime(Math.min(character.cutoff,1600+acousticRpm*6000+throttle*5500)*(e.exhaustNoise ?? 1),t,.12);
      // Cylinders fire every other turn: a moped single thumps at 10-60 Hz, a V8 blurs into a burble.
      const cyl = character.cylinders, crank = (bike ? 1500 : 800)+acousticRpm*(bike ? 7000 : 5200);
      const fireHz = clamp(crank/60*cyl/2,6,90);
      const depth = running*(bike ? .42 : character.family==='diesel' ? .26 : .12)*clamp(1.15-fireHz/110,.25,1)*(.6+(1-throttle)*.4);
      v.pulseOsc.frequency.setTargetAtTime(fireHz,t,.05);
      v.pulseDepth.gain.setTargetAtTime(depth/2,t,.1);
      v.pulse.gain.setTargetAtTime(1-depth/2,t,.1);
      const roughness = (1-clamp(e.engineCondition ?? 1,0,1))*.025;
      const rate = (bike ? .62+acousticRpm*1.05 : .72+acousticRpm*.8)*v.personality*character.pitch*(1+Math.sin(this.now*19+e.id)*roughness);
      // Doppler uses actual relative source/listener displacement, with bounded teleports.
      const radialSpeeds: number[] = [];
      const desiredOcc: number[] = [];
      listeners.forEach((l,i)=> {
        if ((this.spatial.solo && i>0) || !buses[i]) return;
        const distance = Math.hypot(e.x-l.x,e.z-l.z);
        const previous = v!.previousDistances.get(i);
        v!.previousDistances.set(i,distance);
        radialSpeeds.push(previous === undefined || dt<=0 ? 0 : clamp((distance-previous)/dt,-45,45));
        const own = (this.cabin[i] ?? 0) > .05 && distance < 6;
        const occ = own ? 0 : this.spatial.occlusionTester?.(l.x,l.z,e.x,e.z) ?? 0;
        desiredOcc.push(typeof occ === 'boolean' ? Number(occ) : clamp(occ,0,1));
        let route = v!.routes.get(i);
        if (!route) {
          route = this.spatial.createSpatialRoute(e.x,e.z,l,i,buses[i],undefined,{range:150}) ?? undefined;
          if (!route) return;
          v!.mixGain.connect(route.filter); v!.routes.set(i,route);
        }
        this.spatial.updateSpatialRoute(route,e.x,e.z,l,undefined,{range:150});
        // Running recordings pass through both the motor blend and this spatial gain.
        // Keep a clear idle floor even for quiet, small engines such as the moped.
        const level = (.28 + clamp(e.signature/100,0,1)*.35) * (.8+throttle*.2);
        route.gain.gain.setTargetAtTime(muted ? 0 : level*route.attenuation*(own ? 1+1.6*this.cabin[i] : 1),t,.12);
      });
      // Engine loops are a shared physical source. Use the closest listener's Doppler shift.
      let closest = 0;
      listeners.slice(0, this.spatial.solo ? 1 : 2).forEach((l,i)=> { if (v!.previousDistances.get(i)! < v!.previousDistances.get(closest)!) closest=i; });
      const doppler = clamp(343/(343+(radialSpeeds[closest] ?? 0)),.88,1.15);
      v.idleSrc.playbackRate.setTargetAtTime(rate*doppler,t,.09);
      v.loadSrc.playbackRate.setTargetAtTime((bike ? .75+acousticRpm*.8 : .82+acousticRpm*.55)*v.personality*character.pitch*doppler,t,.09);
      const targetOcc = desiredOcc[closest] ?? 0;
      v.smoothedOcc = damp(v.smoothedOcc,targetOcc,4,dt);
      v.creakCooldown -= dt;
      if (Math.abs(e.lateralG ?? 0)>.42 && v.creakCooldown<=0) {
        this.samples.play('chassis',v.mixGain,t,clamp(Math.abs(e.lateralG!)*.3,.1,.4),v.personality);
        v.creakCooldown = 1+Math.random();
      }
      v.lastRpm=rpm;
      for (const [i,route] of v.routes) if (!listeners[i] || (this.spatial.solo && i>0)) {
        v.mixGain.disconnect(route.filter);route.filter.disconnect();route.gain.disconnect();route.panner.disconnect();v.routes.delete(i);
      }
    }
    for (const [id,v] of this.voices) if (!seen.has(id)) {
      for (const route of v.routes.values()) route.gain.gain.setTargetAtTime(0,this.ctx.currentTime,.1);
      if (this.now-v.lastSeen>1.2) {this.destroy(v);this.voices.delete(id);}
    }
  }
  private makeVoice(e: EngineParams,idle: AudioBuffer,load: AudioBuffer): ActiveEngineVoice {
    const ctx=this.ctx;
    const idleSrc=ctx.createBufferSource(),loadSrc=ctx.createBufferSource();
    idleSrc.buffer=idle;loadSrc.buffer=load;idleSrc.loop=loadSrc.loop=true;
    const idleGain=ctx.createGain(),loadGain=ctx.createGain(),mixGain=ctx.createGain();
    idleGain.gain.value=loadGain.gain.value=0;
    const tone=ctx.createBiquadFilter();tone.type='lowpass';const pulse=ctx.createGain();
    idleSrc.connect(idleGain).connect(tone);loadSrc.connect(loadGain).connect(tone);tone.connect(pulse).connect(mixGain);
    const pulseOsc=ctx.createOscillator(),pulseDepth=ctx.createGain();
    pulse.gain.value=1;pulseDepth.gain.value=0;pulseOsc.frequency.value=20;pulseOsc.connect(pulseDepth).connect(pulse.gain);pulseOsc.start();
    idleSrc.start(ctx.currentTime,Math.random()*idle.duration);loadSrc.start(ctx.currentTime,Math.random()*load.duration);
    return {idleSrc,loadSrc,idleGain,loadGain,mixGain,tone,routes:new Map(),lastSeen:this.now,lastRpm:e.rpm,smoothedOcc:0,creakCooldown:0,personality:.96+(Math.abs(e.id*17)%9)*.01,previousDistances:new Map(),characterKey:engineCharacter(e).key,gear:audioGear(e),shiftUntil:0,eventCooldown:0,nextTake:this.now+6+Math.random()*6,retiring:[],pulse,pulseOsc,pulseDepth,wander:0,wanderTarget:0,nextWander:0,rpmLag:e.rpm,waterCooldown:0,layers:new Map()};
  }
  private rotateTake(v: ActiveEngineVoice, bank: string, oldSource: AudioBufferSourceNode, oldGain: GainNode, target: AudioNode) {
    const buffer=this.samples.get(bank);if (!buffer) return;
    const now=this.ctx.currentTime, source=this.ctx.createBufferSource(), gain=this.ctx.createGain();
    source.buffer=buffer;source.loop=true;source.playbackRate.value=oldSource.playbackRate.value;
    gain.gain.value=0;source.connect(gain).connect(target);
    source.start(now,Math.random()*buffer.duration);
    gain.gain.setTargetAtTime(oldGain.gain.value,now,.15);oldGain.gain.setTargetAtTime(0,now,.15);
    oldSource.stop(now+.7);v.retiring.push({source:oldSource,gain:oldGain,ends:now+.7});
    return {source,gain};
  }
  private updateLayer(v: ActiveEngineVoice, id: string, volume: number, rate: number, cutoff: number) {
    const now=this.ctx.currentTime;
    let layer=v.layers.get(id);
    if (!layer && volume>.001) {
      const buffer=this.samples.get(id);if (!buffer) return;
      const source=this.ctx.createBufferSource();source.buffer=buffer;source.loop=true;
      const filter=this.ctx.createBiquadFilter();filter.type='lowpass';
      const gain=this.ctx.createGain();gain.gain.value=0;
      source.connect(gain).connect(filter).connect(v.mixGain);
      source.start(now,Math.random()*buffer.duration);
      layer={source,filter,gain,zeroSince:this.now,nextTake:this.now+8+Math.random()*8};v.layers.set(id,layer);
    }
    if (!layer) return;
    if (volume>.001 && this.now>=layer.nextTake && this.samples.all(id).length>1) {
      // Put the replacement gain before the existing filter, preserving component tone.
      const replacement=this.rotateTake(v,id,layer.source,layer.gain,layer.filter);
      if (replacement) {
        layer.source=replacement.source;layer.gain=replacement.gain;
      }
      layer.nextTake=this.now+8+Math.random()*8;
    }
    layer.gain.gain.setTargetAtTime(volume,now,.15);
    layer.filter.frequency.setTargetAtTime(cutoff,now,.15);
    layer.source.playbackRate.setTargetAtTime(clamp(rate,.5,2),now,.1);
    if (volume>.001) layer.zeroSince=this.now;
    else if (this.now-layer.zeroSince>1) {
      layer.source.stop();layer.source.disconnect();layer.filter.disconnect();layer.gain.disconnect();v.layers.delete(id);
    }
  }
  private destroy(v: ActiveEngineVoice) {
    v.idleSrc.stop();v.loadSrc.stop();
    for (const old of v.retiring) {old.source.stop();old.source.disconnect();old.gain.disconnect();}
    for (const layer of v.layers.values()) {layer.source.stop();layer.source.disconnect();layer.gain.disconnect();layer.filter.disconnect();}
    v.pulseOsc.stop();v.pulseOsc.disconnect();v.pulseDepth.disconnect();v.pulse.disconnect();
    for (const node of [v.idleSrc,v.loadSrc,v.idleGain,v.loadGain,v.mixGain,v.tone]) node.disconnect();
    for (const route of v.routes.values()) {route.filter.disconnect();route.gain.disconnect();route.panner.disconnect();}
  }
  silenceEngines() {for (const voice of this.voices.values()) this.destroy(voice);this.voices.clear();}
}
