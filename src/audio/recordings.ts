import customRecordings from '../../public/audio/custom-recordings.json';
import variations from '../../public/audio/variations.json';
/** Only licensed recordings belong here. A missing asset remains silent, never synthesized. */
const variants = (prefix: string, count = 5) => Array.from({ length: count }, (_, i) => `${prefix}_${String(i).padStart(3, '0')}.ogg`);
export const RECORDINGS: Record<string, string[]> = {
  pistol: ['pistol0.wav', 'pistol1.wav'], shotgun: ['shotgun0.wav', 'shotgun1.wav'],
  mg: ['mg0.wav', 'mg1.wav'], sniper: ['sniper0.wav', 'sniper1.wav'],
  crash: variants('impactMetal_heavy'), thud: variants('impactSoft_heavy'),
  glass: variants('impactGlass_heavy'), tink: variants('impactMetal_light'),
  chip: variants('impactWood_light'), thunk: variants('impactWood_medium'),
  shell: variants('impactMetal_light'), build: ['tools_01.ogg','tools_02.ogg','tools_03.ogg'],
  wrench: ['tools_04.ogg','tools_05.ogg','tools_06.ogg'],
  click: ['lock_open_01.ogg'], pickup: ['keys_01.ogg'], loot: ['keys_02.ogg'],
  confirm: ['keys_03.ogg'], deny: ['lock_open_01.ogg'],
  pill: ['keys_04.ogg'], treeHit: ['wood_hit_01.ogg','wood_hit_02.ogg'],
  treeCreak: ['wood_squeak_01.ogg','wood_squeak_02.ogg'],
  footGrass: variants('footstep_grass'), footStone: variants('footstep_concrete'),
  footSand: ['sand.wav', 'sand1.wav', 'sand2.wav', 'sand3.wav', 'sand4.wav'], footWood: variants('footstep_wood'),
  engine: ['engine.wav'], chassis: ['metal_spring_01.ogg', 'metal_spring_02.ogg'],
};
for (const id of ['waterfall','stream','boom','splash','plunge','drip','leaves','vegetation','grassWind','birds','owl','crickets','frogs','quack','caw','flutter','rain','thunder','fire','horn','bell','gasp','gulp','munch','laugh','retch','twang','creak','radio','whisper','slash','swing','hit','trickle','alarm','beep','siren','cicadas']) RECORDINGS[id] = [`${id}.wav`];
RECORDINGS.rustle = RECORDINGS.leaves;
RECORDINGS.plop = RECORDINGS.splash;
RECORDINGS.toke = RECORDINGS.gasp;
RECORDINGS.ricochet = RECORDINGS.tink;
RECORDINGS.chirp = ['chirp.wav'];
// The flesh engine's foley, from recordings already here, as a foley stage would: a bone snapping is wood cracking, meat
// tearing is a wet mouthful and a soft blow, the gut spilling out is a sloppy splash.
RECORDINGS.boneCrack = ['wood_cracking_01.ogg', 'wood_cracking_02.ogg', 'wood_cracking_03.ogg', 'wood_cracking_04.ogg'];
RECORDINGS.squelch = ['munch.wav', 'munch-take2.wav', 'munch-take3.wav', ...variants('impactSoft_medium')];
RECORDINGS.gutSpill = ['splash.wav', 'splash-take2.wav', 'splash-take3.wav'];

RECORDINGS.flood = RECORDINGS.waterfall;
RECORDINGS.wind = ['wind.wav'];

for (const id of ['growl','yelp','zdie','scream','sing','howl','bellow','hiss','hiccup','reload','branchBreak']) RECORDINGS[id] = [`${id}.wav`];

for (const [cue, takes] of Object.entries(variations))
  RECORDINGS[cue] = [...new Set([...(RECORDINGS[cue] ?? []), ...takes])];
// Aliases follow the expanded banks, including their anti-repeat decks.
for (const [alias, cue] of Object.entries({ rustle: 'leaves', plop: 'splash', toke: 'gasp', ricochet: 'tink', flood: 'waterfall', hullRush: 'stream', hullLap: 'trickle' }))
  RECORDINGS[alias] = RECORDINGS[cue];

for (const [cue, takes] of Object.entries(customRecordings)) RECORDINGS[cue] = takes;
