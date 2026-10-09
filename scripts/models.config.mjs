// What `bake-models.mjs` makes, from which source, and how. Credits here are copied into `public/models/sources.json`.
//
// Skinned models: `clips` maps a game role to a source clip (`{ name, loop, from, to, speed }` or just the name), `parts`
// maps a part (a bit mask in `partBits`) to a regex on joint names, `rotate` turns the model to face +Z, `height`/`length`
// set its size in metres from the idle's first frame. `rig` auto-rigs a still model and makes its clips (`autorig.mjs`).
// Still models (`static: true`) are critters drawn by `render/lifeRender.ts`: 1 m long facing +Z, brightness only when
// `grey` is set (the game tints them per species).

const CC_BY_3 = 'CC-BY-3.0';
const CC0 = 'CC0-1.0';
const polyPizza = (id, title, author, license) => ({ title, author, license, source: `https://poly.pizza/m/${id}` });

// ------------------------------------------------------------------------------------------ parts (sim/anatomy PART_BIT)

const A = { legLF: 1, legRF: 2, legLB: 4, legRB: 8, head: 16, wingL: 32, wingR: 64 };
/** Quaternius Ultimate Animated Animals: FK legs plus IK foot controllers the hooves hang from. */
const QUAD_PARTS = {
  legLF: /^(FrontUpperLeg|FrontLowerLeg|IKFrontLeg|FF)\.L/, legRF: /^(FrontUpperLeg|FrontLowerLeg|IKFrontLeg|FF)\.R/,
  legLB: /^(BackLeg|BackUpperLeg|BackLowerLeg|IKBackLeg|FFB)\.L/, legRB: /^(BackLeg|BackUpperLeg|BackLowerLeg|IKBackLeg|FFB)\.R/,
  head: /^(Neck3|Head|Ear)/,
};
/** The auto-rigs' own bone names. */
const RIG_PARTS = { legLF: /^(upLF|loLF|upL|loL)$/, legRF: /^(upRF|loRF|upR|loR)$/, legLB: /^(upLB|loLB)$/, legRB: /^(upRB|loRB)$/, head: /^(neck2|head)$/, wingL: /^(wingL|handL)$/, wingR: /^(wingR|handR)$/ };

// The clips the game plays (`render/animalModels.ts`); the packs' others (jumps, hit reactions, alert idles) stay out.
// Several takes of a move are `role`, `role.1` ...: the pack's other idles (standing easy, head low) and its flinches from
// a hit on the left and on the right; the bull kicks as well as butts.
const HITS = { hit: { name: 'Idle_HitReact_Left', loop: false }, 'hit.1': { name: 'Idle_HitReact_Right', loop: false } };
const CANID = { idle: 'Idle', 'idle.1': 'Idle_2', 'idle.2': 'Idle_2_HeadLow', walk: 'Walk', run: 'Gallop', eat: 'Eating', attack: { name: 'Attack', loop: false }, death: { name: 'Death', loop: false }, ...HITS };
const UNGULATE = { idle: 'Idle', 'idle.1': 'Idle_2', 'idle.2': 'Idle_Headlow', walk: 'Walk', run: 'Gallop', eat: 'Eating', attack: { name: 'Attack_Headbutt', loop: false },
  'attack.1': { name: 'Attack_Kick', loop: false }, death: { name: 'Death', loop: false }, ...HITS };
const quaternius = (name, source, height, clips, id, title, extra = {}) => ({
  name, source, height, clips, parts: QUAD_PARTS, partBits: A, material: { roughness: 0.85 },
  credit: polyPizza(id, `${title} (Ultimate Animated Animal Pack)`, 'Quaternius', CC0), ...extra,
});
const rigged = (name, source, size, rig, id, title, author = 'Poly by Google', license = CC_BY_3, extra = {}) => ({
  name, source, ...size, rig, parts: RIG_PARTS, partBits: A, smooth: false, material: { roughness: 0.85 },
  credit: polyPizza(id, title, author, license), ...extra,
});

// ------------------------------------------------------------------------------------------ zombies

const Z = { thighL: 2, thighR: 4, shinL: 8, shinR: 16, upperArmL: 32, upperArmR: 64, foreArmL: 128, foreArmR: 256, head: 512, footL: 2 | 8, footR: 4 | 16 };
/** Zombie Apocalypse Kit "CharacterArmature": a lost leg takes thigh, shin and the foot (which hangs from Root). */
const ZOMBIE_PARTS = {
  head: /^(Neck|Head|Tongue|Eyelid|TopMouth|BottomMouth)/,
  upperArmL: /^UpperArm\.L/, upperArmR: /^UpperArm\.R/,
  foreArmL: /^(LowerArm|Wrist|Pinky\d|Middle\d|Index\d|Thumb\d|Ring\d)\.L/, foreArmR: /^(LowerArm|Wrist|Pinky\d|Middle\d|Index\d|Thumb\d|Ring\d)\.R/,
  thighL: /^UpperLeg\.L/, thighR: /^UpperLeg\.R/, shinL: /^LowerLeg\.L/, shinR: /^LowerLeg\.R/, footL: /^Foot\.L/, footR: /^Foot\.R/,
};
const ZOMBIE_CLIPS = {
  idle: 'Idle', walk: 'Walk', run: 'Run_Arms', grab: 'Idle_Attack', crawl: 'Crawl',
  attack: { name: 'Punch', loop: false }, hit: { name: 'HitReact', loop: false }, death: { name: 'Death', loop: false },
};
const zombie = (name, source, id, title, license, extra = {}) => ({
  name, source, height: 1.8, clips: ZOMBIE_CLIPS, parts: ZOMBIE_PARTS, partBits: Z, bakeTexture: true, material: { roughness: 0.9 },
  credit: { ...polyPizza(id, `${title} (Zombie Apocalypse Kit)`, 'Quaternius', license), note: 'quaternius.com lists the kit as CC0' }, ...extra,
});

export const MODELS = [
  // ---------------------------------------------------------------------------------------- wild animals, animated
  quaternius('animal-dog', 'shiba-quaternius.glb', 0.7, CANID, 'y4wdQpg767', 'Shiba Inu'),
  quaternius('animal-wolf', 'wolf-quaternius.glb', 0.9, CANID, 'P1gU3Qkr9r', 'Wolf'),
  quaternius('animal-fox', 'fox-quaternius.glb', 0.45, CANID, 'Bc97C66HKi', 'Fox'),
  // A golden jackal: the wolf, smaller, in tawny gold with a darker saddle.
  quaternius('animal-jackal', 'wolf-quaternius.glb', 0.6, CANID, 'P1gU3Qkr9r', 'Wolf', { tint: { Main: [0.32, 0.2, 0.09, 1], Main_Light: [0.62, 0.5, 0.33, 1] } }),
  quaternius('animal-buffalo', 'bull-quaternius.glb', 1.55, UNGULATE, 'a8PIIYwF7r', 'Bull'),

  // ---------------------------------------------------------------------------------------- wild animals, auto-rigged
  rigged('animal-deer', 'gazelle-poly.glb', { height: 1.3 }, { type: 'quad', stride: 0.42, runAmp: 1.7, runFlex: 2.2 }, 'bPYIQ_XQbrj', 'Gazelle'),
  rigged('animal-camel', 'camel-poly.glb', { height: 2.1 }, { type: 'quad', stride: 0.34, walkT: 1.3, runT: 0.7, runAmp: 1.3, runFlex: 1.6, graze: 1.25 }, '7XeLogrxLad', 'Camel'),
  rigged('animal-bear', 'bear-poly.glb', { height: 1.25 }, { type: 'quad', stride: 0.32, walkT: 1.2, runT: 0.6, attack: 'swipe', graze: 0.9, rear: 1.1 }, '0PXWfxfb0Hu', 'Bear'),
  rigged('animal-boar', 'boar-poly.glb', { height: 0.85 }, { type: 'quad', stride: 0.4, walkT: 0.8, runT: 0.42, attack: 'butt', graze: 0.6, headLen: 0.18 }, '57fSWum6F1P', 'Boar',
    'Poly by Google', CC_BY_3, { colorize: { color: [0.2, 0.15, 0.11], gain: 1.6, keepBelow: 0.004 } }),
  // A Nubian ibex from a goat: the coat turned sandy tan and lightened; the horns and hooves keep their dark.
  rigged('animal-ibex', 'goat-poly.glb', { height: 1.1 }, { type: 'quad', stride: 0.4, runAmp: 1.6, attack: 'butt' }, 'd7dImmjtF8E', 'Goat',
    'Poly by Google', CC_BY_3, { colorize: { color: [0.42, 0.27, 0.14], gain: 3.2, keepBelow: 0.006 } }),
  rigged('animal-hare', 'jackrabbit-poly.glb', { height: 0.42 }, { type: 'quad', gait: 'bound', stride: 0.45, walkT: 0.6, runT: 0.36, runAmp: 1.8, runFlex: 2.2, headLen: 0.2, belly: 0.3 }, 'biNOm96olTH', 'Jackrabbit'),

  // ---------------------------------------------------------------------------------------- birds: on the ground
  rigged('bird-heron', 'heron-poly.glb', { height: 1.0 }, { type: 'bird', belly: 0.42 }, '74guNhJR5Ij', 'Heron'),
  rigged('bird-egret', 'egret-poly.glb', { height: 0.75 }, { type: 'bird', belly: 0.36 }, '8VTUh9niy9k', 'Snowy egret'),
  rigged('bird-stork', 'stork-gwym.glb', { height: 1.05 }, { type: 'bird', belly: 0.45 }, 'aRlrdbGgvQC', 'White stork', 'Gwym Hendawyr', CC_BY_3, { rotate: [0, -Math.PI / 2, 0] }),
  rigged('bird-duck', 'mallard-poly.glb', { height: 0.32 }, { type: 'bird', belly: 0.2, reach: 0.9, walkT: 0.5 }, 'frSLi6b6Vid', 'Mallard duck'),
  rigged('bird-crow', 'crow-poly.glb', { height: 0.32 }, { type: 'bird', belly: 0.18, walkT: 0.45, headLen: 0.3 }, '1MIvWQ5Q3R9', 'Crow'),
  rigged('bird-vulture', 'vulture-poly.glb', { height: 0.62 }, { type: 'bird', belly: 0.2, walkT: 0.9, headLen: 0.3 }, 'fvAgunyr1kd', 'Turkey vulture'),

  // ---------------------------------------------------------------------------------------- birds: in the air
  rigged('flyer-gull', 'flyer-gull-poly.glb', { width: 1.0 }, { type: 'flyer', rest: -0.6 }, '6Tpj_vcWP3f', 'Flying seagull', 'Poly by Google', CC_BY_3, { rotate: [0, -Math.PI / 2, 0] }),
  rigged('flyer-dark', 'flyer-black-poly.glb', { width: 1.0 }, { type: 'flyer', rest: 0 }, '8Ph79kHbt9s', 'Bird', 'Poly by Google', CC_BY_3,
    { rotate: [-Math.PI / 2, -Math.PI / 2, 0, 'YXZ'] }),
  // The same soaring bird lighter, for a vulture's brown (the instance colour tints it).
  rigged('flyer-brown', 'flyer-black-poly.glb', { width: 1.0 }, { type: 'flyer', rest: 0, dihedral: 0.18, flapT: 0.8 }, '8Ph79kHbt9s', 'Bird', 'Poly by Google', CC_BY_3,
    { rotate: [-Math.PI / 2, -Math.PI / 2, 0, 'YXZ'], tintAll: [0.36, 0.3, 0.24] }),
  // A heron and an egret on the wing, from their own standing models (`flightPose.mjs`): levelled, legs trailing, the neck
  // folded back onto the shoulders, on the flying gull's wings (greyed for the heron). The stork's model, its folded wings as
  // tall as its neck, does not pose cleanly: it keeps the gull's shape, in its own white and black.
  rigged('flyer-heron', 'heron-poly.glb', { width: 1.0 }, { type: 'flyer', rest: 0, flap: 0.55, flapT: 0.9, body: 0.1 }, '74guNhJR5Ij', 'Heron', 'Poly by Google', CC_BY_3, {
    flight: { wings: 'flyer-gull-poly.glb', wingsRotate: [0, -Math.PI / 2, 0], belly: 0.27, neckBase: 0.64, headY: 0.87, neck: 'tuck', span: 1.85, wingTint: [0.58, 0.63, 0.68] },
    credit: { ...polyPizza('74guNhJR5Ij', 'Heron', 'Poly by Google', CC_BY_3), edit: 'Posed for flight (levelled, legs trailing, neck folded) and given the wings of "Flying seagull" by Poly by Google, https://poly.pizza/m/6Tpj_vcWP3f (CC BY 3.0), greyed; auto-rigged (flyer) with generated flap and glide clips, baked to bone matrices' },
  }),
  rigged('flyer-egret', 'egret-poly.glb', { width: 1.0 }, { type: 'flyer', rest: 0, flap: 0.6, flapT: 0.7, body: 0.1 }, '8VTUh9niy9k', 'Snowy egret', 'Poly by Google', CC_BY_3, {
    flight: { wings: 'flyer-gull-poly.glb', wingsRotate: [0, -Math.PI / 2, 0], belly: 0.3, neckBase: 0.62, headY: 0.86, neck: 'tuck', span: 1.9, wingTint: [0.97, 0.97, 0.95] },
    credit: { ...polyPizza('8VTUh9niy9k', 'Snowy egret', 'Poly by Google', CC_BY_3), edit: 'Posed for flight (levelled, legs trailing, neck folded) and given the wings of "Flying seagull" by Poly by Google, https://poly.pizza/m/6Tpj_vcWP3f (CC BY 3.0); auto-rigged (flyer) with generated flap and glide clips, baked to bone matrices' },
  }),

  // ---------------------------------------------------------------------------------------- small birds and bats (ambient life)
  // Brightness only (`grey`): the game tints each bird for its kind, the model's own pale breast, dark crown and streaked
  // back showing through. 1 long, like the procedural bodies they replace; one standing model and one on the wing.
  rigged('bird-sparrow', 'sparrow-poly.glb', { length: 1 }, { type: 'bird', belly: 0.22, walkT: 0.35, headLen: 0.3 }, 'eVTHotZ9Bc_', 'Sparrow',
    'Poly by Google', CC_BY_3, { grey: 0.6 }),
  rigged('bird-dove', 'dove-poly.glb', { length: 1 }, { type: 'bird', belly: 0.14, walkT: 0.5, headLen: 0.3, reach: 0.9 }, '1cF8DTp2sAi', 'Mourning dove',
    'Poly by Google', CC_BY_3, { grey: 0.6 }),
  rigged('bird-swallow', 'swallow-poly.glb', { length: 1 }, { type: 'bird', belly: 0.14, walkT: 0.4, headLen: 0.28 }, '5dl4UWhvuTW', 'Cliffswallow',
    'Poly by Google', CC_BY_3, { grey: 0.58 }),
  rigged('flyer-small', 'flyer-small-madtroll.glb', { width: 1.0 }, { type: 'flyer', rest: 0, flap: 0.9, flapT: 0.25 }, 'F3km1zKccq', 'Bird',
    'madtrollstudio', CC_BY_3, { grey: 0.6 }),
  rigged('flyer-bat', 'bat-poly.glb', { width: 1.0 }, { type: 'flyer', rest: 0, flap: 0.95, flapT: 0.2, body: 0.07 }, 'a6ZmdFKog_u', 'Bat',
    'Poly by Google', CC_BY_3, { grey: 0.5 }),

  // ---------------------------------------------------------------------------------------- the infected
  // The game keeps its own zombie bodies (proportions, clothes, gore, the six kinds) and takes its moves from a motion
  // library, retargeted onto their eleven joints (`retarget.mjs`).
  {
    name: 'zombie-anims',
    // Several takes per move: each zombie keeps its own (by its looks), so a horde does not walk, stand, swing or fall in step.
    // A role's variants are `role`, `role.1`, `role.2` ... (`zombieRender.ts`). Captures are cut from long takes: a gait to
    // the one step cycle that best closes on itself, an idle to a few seconds that do.
    retarget: {
      sources: {
        ual1: 'ual1-quaternius.glb', ual2: 'ual2-quaternius.glb',
        kkGeneral: { file: 'kaykit-general.glb', rig: 'kaykit' }, kkMove: { file: 'kaykit-movement-advanced.glb', rig: 'kaykit' },
        kkSpecial: { file: 'kaykit-special.glb', rig: 'kaykit' }, kkMelee: { file: 'kaykit-combat-melee.glb', rig: 'kaykit' },
        styleWalk: { file: '100style-zombie-fw.bvh', rig: 'style100' }, styleRun: { file: '100style-zombie-fr.bvh', rig: 'style100' },
        styleIdle: { file: '100style-zombie-id.bvh', rig: 'style100' },
        cmuWalk: { file: 'cmu-104_41.bvh', rig: 'cmu' }, cmuWalk8: { file: 'cmu-104_42.bvh', rig: 'cmu' }, cmuShamble: { file: 'cmu-120_22.bvh', rig: 'cmu' },
      },
      clips: {
        idle: { src: 'ual2', name: 'Zombie_Idle_Loop', ground: true },
        'idle.1': { src: 'styleIdle', from: 10, to: 26, span: [3, 6], ground: true },
        walk: { src: 'ual2', name: 'Zombie_Walk_Fwd_Loop', ground: true },
        'walk.1': { src: 'styleWalk', from: 20, to: 90, cycle: true, period: [0.8, 2.4], ground: true },
        'walk.2': { src: 'cmuWalk', from: 1, to: 12, cycle: true, period: [0.8, 2.6], ground: true },
        'walk.3': { src: 'cmuWalk8', from: 1, to: 20, cycle: true, period: [0.8, 2.6], ground: true },
        'walk.4': { src: 'cmuShamble', from: 0.5, to: 10.5, cycle: true, period: [0.8, 2.6], ground: true },
        jog: { src: 'ual1', name: 'Jog_Fwd_Loop', ground: true },
        'jog.1': { src: 'styleRun', from: 15, to: 60, cycle: true, period: [0.45, 1.4], ground: true },
        sprint: { src: 'ual1', name: 'Sprint_Loop', ground: true },
        crouch: { src: 'ual1', name: 'Crouch_Fwd_Loop', ground: true },
        'crouch.1': { src: 'kkMove', name: 'Sneaking', ground: true },
        crawl: { src: 'kkMove', name: 'Crawling' },
        scratch: { src: 'ual2', name: 'Zombie_Scratch', ground: true },
        kneel: { src: 'ual1', name: 'Fixing_Kneeling' },
        scream: { src: 'ual2', name: 'Chest_Open', ground: true },
        'scream.1': { src: 'kkSpecial', name: 'Skeletons_Taunt', ground: true },
        punch: { src: 'ual1', name: 'Punch_Cross', loop: false, ground: true },
        'punch.1': { src: 'ual2', name: 'Melee_Hook', loop: false, ground: true },
        'punch.2': { src: 'kkMelee', name: 'Melee_Unarmed_Attack_Punch_A', loop: false, ground: true },
        hit: { src: 'ual1', name: 'Hit_Chest', loop: false, ground: true },
        'hit.1': { src: 'ual1', name: 'Hit_Head', loop: false, ground: true },
        'hit.2': { src: 'kkGeneral', name: 'Hit_A', loop: false, ground: true },
        // Deaths: each laid on the ground every frame (`retarget.mjs` lieDown) and ending in a pose of its own, on its back,
        // its face or a side, limbs where they fell. Which way a body goes down follows the shot (`zombieRender.ts`).
        death: { src: 'ual1', name: 'Death01', loop: false, lie: {} },
        'death.1': { src: 'kkGeneral', name: 'Death_B', loop: false, lie: {} },
        'death.2': { src: 'ual1', name: 'Death01', loop: false, lie: { head: 35, top: { arm: [95, 0, 15], leg: [16, 0, 5] }, bottom: { arm: [70, 10, 40], leg: [10, 0, 12] } } },
        'death.3': { src: 'kkGeneral', name: 'Death_A', loop: false, lie: { head: -30, top: { arm: [160, 0, 30], leg: [8, 55, 105], limp: false }, bottom: { arm: [25, 10, 70], leg: [5, 0, 5] } } },
        'death.4': { src: 'ual2', name: 'Hit_Knockback', loop: false, lie: { roll: 80, twist: 15, head: 10, top: { arm: [60, 70, 50], leg: [5, 60, 80] }, bottom: { arm: [80, 80, 30], leg: [0, 25, 30] } } },
        'death.5': { src: 'kkGeneral', name: 'Death_B', loop: false, lie: { head: 60, top: { arm: [150, 0, 20], leg: [10, 0, 0] }, bottom: { arm: [135, 0, 45], leg: [16, 0, 10] } } },
        'death.6': { src: 'ual1', name: 'Death01', loop: false, lie: { roll: -45, head: 40, top: { arm: [30, 40, 95], leg: [0, 30, 60] }, bottom: { arm: [110, 0, 20], leg: [8, 0, 10] } } },
        'death.7': { src: 'kkGeneral', name: 'Death_A', loop: false, lie: { roll: -85, twist: -10, head: -15, top: { arm: [40, 90, 110], leg: [0, 95, 120] }, bottom: { arm: [60, 95, 100], leg: [0, 75, 105] } } },
        'death.8': { src: 'kkGeneral', name: 'Death_B', loop: false, lie: { roll: 60, head: 30, top: { arm: [40, 60, 60], leg: [10, 60, 90] }, bottom: { arm: [100, 40, 30], leg: [0, 10, 15] } } },
        'death.9': { src: 'ual2', name: 'Hit_Knockback', loop: false, lie: { head: -45, top: { arm: [95, 0, 0, 85], leg: [12, 0, 0] }, bottom: { arm: [90, 0, 0, 70], leg: [-4, 0, 8] } } },
        'death.10': { src: 'kkSpecial', name: 'Skeletons_Death', loop: false, lie: {} },
        'death.11': { src: 'kkGeneral', name: 'Death_B', loop: false, lie: { head: -50, top: { arm: [20, 0, 10], leg: [40, 0, 0, 80] }, bottom: { arm: [120, 0, 0, 60], leg: [6, 0, 5] } } },
      },
    },
    credit: {
      title: 'Universal Animation Library 1 & 2 (Standard)', author: 'Quaternius', license: CC0,
      source: 'https://quaternius.itch.io/universal-animation-library', note: 'also https://quaternius.itch.io/universal-animation-library-2',
      edit: 'Clips retargeted by joint direction onto the game\'s eleven-joint zombie body and baked to bone matrices',
    },
    // The other sources in the same bank, credited each in its own right.
    alsoCredits: [
      { title: 'KayKit Character Animations 1.1', author: 'Kay Lousberg', license: CC0, source: 'https://kaylousberg.itch.io/kaykit-character-animations',
        edit: 'Clips retargeted by joint direction onto the game\'s eleven-joint zombie body and baked to bone matrices' },
      { title: 'The 100STYLE Dataset (Zombie style: idle, forward walk, forward run)', author: 'Ian Mason, Sebastian Starke, Taku Komura', license: 'CC-BY-4.0',
        source: 'https://www.ianxmason.com/100style/', note: 'Zenodo record 8127870',
        edit: 'Single step cycles and an idle stretch cut from the takes, turned to face ahead and walk on the spot, retargeted by joint direction onto the game\'s zombie body, looped and baked to bone matrices' },
      { title: 'CMU Graphics Lab Motion Capture Database (subject 104 trials 41 and 42, subject 120 trial 22)', author: 'Carnegie Mellon University', license: 'CMU-mocap',
        source: 'http://mocap.cs.cmu.edu/', note: 'The data used in this project was obtained from mocap.cs.cmu.edu. The database was created with funding from NSF EIA-0196217.',
        edit: 'Single step cycles cut from the takes, turned to face ahead and walk on the spot, retargeted by joint direction onto the game\'s zombie body, looped and baked to bone matrices' },
    ],
  },

  // ---------------------------------------------------------------------------------------- small life (still)
  {
    name: 'critter-fish', static: true, source: 'fish-quaternius.glb', length: 1, grey: 0.78, smooth: true,
    credit: polyPizza('XWl86YFtpF', 'Fish (Animated Fish Pack)', 'Quaternius', CC0),
  },
  {
    name: 'critter-snake', static: true, source: 'snake-poly.glb', length: 1, grey: 0.8, smooth: true, bakeTexture: true,
    credit: polyPizza('2ovwPNrRijL', 'Snake', 'Poly by Google', CC_BY_3),
  },
  {
    name: 'critter-frog', static: true, source: 'frog-assetquest.glb', length: 1, grey: 0.8, bakeTexture: true, smooth: true,
    credit: polyPizza('yK6MyLkuob', 'Green Frog', 'AssetQuest', CC0),
  },
  {
    name: 'critter-turtle', static: true, source: 'terrapin-poly.glb', length: 1, bakeTexture: true, smooth: true,
    credit: polyPizza('c6n73UnGEP4', 'Turtle', 'Poly by Google', CC_BY_3),
  },
  {
    name: 'critter-lizard', static: true, source: 'salamander-poly.glb', length: 1, grey: 0.8, bakeTexture: true, smooth: true,
    credit: polyPizza('eqjMAgmr-pM', 'Salamander', 'Poly by Google', CC_BY_3),
  },
  {
    // The body only: its four wings come out as one flat wing the game hangs and beats four times over, in a veined, clear
    // membrane of its own (the source's are opaque cards).
    name: 'critter-dragonfly', static: true, source: 'dragonfly-assetquest.glb', length: 1, grey: 0.8, bakeTexture: true, smooth: true,
    rotate: [0, Math.PI, 0], wings: { name: 'critter-dragonwing' },
    credit: { ...polyPizza('de6jep5Fq5', 'Dragonfly', 'AssetQuest', CC0), edit: 'Body merged, reoriented and scaled to 1 m; palette colours baked into vertex colours and reduced to brightness for in-game tinting; wings split off: the right fore wing laid flat as its own model, every wing\'s hinge, span and sweep recorded' },
  },
  {
    name: 'critter-crab', static: true, source: 'crab-poly.glb', width: 1.9, grey: 0.8, bakeTexture: true, smooth: true,
    credit: polyPizza('2DgM36qZW2u', 'Crab', 'Poly by Google', CC_BY_3),
  },

];
