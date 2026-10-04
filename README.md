# Iron Nomad: Road to Haven

A shared-screen survival-convoy game for the browser, for two players or one. Two scavengers (or one) start on matching 50cc scrap mopeds and
grow into a war convoy, driving north toward a sanctuary called Haven. The vehicle is the character: every upgrade changes
where you can go, how loud you are, and who wants to kill you.

This is the **vertical slice** defined in section 2 of the *Game Design & Technical Blueprint*: Tiers 1 to 3, wasteland and
city legs, a Dusk Bell, one camp night per leg, the Mechanic mercenary, full split-screen and two-gamepad play. Everything
the blueprint puts in "Beta" and "Final" is listed under [What is not in the slice](#what-is-not-in-the-slice).

## Run it

```bash
npm install
npm run dev          # http://127.0.0.1:5174  (or $PORT)
npm run build        # typecheck + production bundle in dist/
npm test             # about 840 unit and simulation tests (Vitest)
```

`?training` starts the training lessons (see [Learning the game](#learning-the-game)). `?leg=W` starts a fresh run in the open world (it is what New Convoy does). Any other leg id (`?leg=L3P`, `?leg=L2C`...) starts a fresh run
straight on one of the older single-road legs, which is how a map is checked without playing up to it.

Chrome or Edge are the reference browsers. Gamepads are only exposed to secure contexts, so use `localhost`, `127.0.0.1`
or HTTPS. Add `?debug` to the URL for a frame-time and draw-call readout and data validation at boot.

## Play

Plug in two Xbox-layout pads and press **A** to join, or share the keyboard. Anyone can press **Start** to begin. A seat
without a pad falls back to the keyboard, so you can also play on one keyboard (Player 1 on the left side, Player 2 on the
right).

### The loop

The game is one **open world**: a basin about 4.6 km across and 5.7 km long that you can drive across in any direction. The
Dusk Bell turns each day into the same loop, and every decision is shared:

1. **Dawn Ledger** (shared clipboard, two coloured cursors): repair, rebuild a vehicle into the next tier, upgrade five
   module slots, craft ammo and gear, hire crew (at a hub), pay or short their loot cut, then roll out from wherever camp was.
2. **Roam**: drive anywhere. The highway runs north through Petah Tikva to Rustgate and Haven; cross roads and dirt tracks lead
   to the places off it. Dismount at scavenge zones, work through buildings, handle ambushes and the Roadside Encounters.
3. **Dusk Bell**: a visible clock. When it rings, find somewhere you like, step out, and **hold A where you stand** to make
   camp (past full dark the convoy stops where it is). Then vote on a camp site and hot or cold camp. The sites on offer depend
   on the ground: the city's car parks and plazas in a city, open flats and rock in the desert, a gas station if one is near.
4. **Camp**: three minutes to build defenses, then a three-wave night raid. Dawn leads straight back to the Ledger.
5. **Haven**: the highway ends at Haven, far to the north. Drive in and the radio says so; the camp there is a safe night and a
   hub, and the Ledger offers *See how it went* (the ending) or *Roll out* (the country does not stop at Haven).

### Rules worth knowing

- **Signature** is the one aggro rule. Engines are **Noise** (heard by the infected in cities) and **Dust** (seen by raiders on
  the road). The meter in the top-left shows your current level. Horns, gunshots, sprinting and night headlights make it worse.
  Parking and walking is quiet.
- **Dust storms**: from the second day, about half the days bring one, somewhere in the morning and midday (never past the Dusk Bell). The sky browns over, the fog closes to about a hundred metres, the minimap halves its reach and the wind rises. Raiders see about 40% as far, so a storm is cover for a run past them, but your engine's oil burns more than twice as fast in the grit and you cannot see them either. The clock line says `DUST WALL`, `DUST STORM` or `DUST CLEARING`, and the radio announces both ends. A storm is fixed by the campaign seed and the day (`sim/weather.ts`), so a reload gives the same weather.
- **Hunting**: a kill leaves a carcass. Hold A on it to butcher: meat becomes Rations and big game also pays Scrap from the hide. Carcasses keep for a minute. Everyone eats one Ration per night; whoever goes unfed wakes at 65% health.
- **Shared stocks**: Fuel, Rations, Scrap, Parts, Tech, Medicine. Fuel and Rations are one pool for both players.
- **Tether**: stay within about 300 m of your partner. The trailing player gets a slipstream bonus; the leader slows when the
  gap grows.
- **Downed, not dead**: at 0 HP you crawl for 20 s. Your partner can revive you (hold A, faster with a medkit). The run ends
  only when both of you are down, or the last vehicle is lost.
- **Gear**: you wear, hold and carry a personal kit. Armour, masks and boots change what hurts you; guns, melee weapons and tools sit on a four-slot belt (LB swaps); the bag holds the rest. D-pad ← (or `3` / `I`) opens the inventory.
- **Wind, wounds and wear**: sprinting, jumping and swinging spend **stamina** (the thin blue bar under your health, shown only while it is low). Run it dry and you are *winded*: no sprint, a slower walk, weaker and slower swings, a shakier aim, until a third has come back. Bites, blades and bullets can open a **wound** (up to three at once; armour turns some away). Each drains health until it clots on its own after about 15 s or is bound, and bleeding alone never kills: it leaves you at 1 HP. **Bandages** (3 for 3 Scrap at the Ledger, also found in bunkers) bind every wound and mend 8; a **Medkit** binds and heals 60. Both sit first on the quick belt (hold the use button, lean to choose, tap to use) and busy your hands for under a second and a bit over one, so dressing a wound mid-fight costs you a shot. Weapons **wear** with use: found ones are already worn (a bar on the tile in the inventory, and a label on the HUD when low). Below 60% a gun wanders and a blade dulls; below 30% a gun can **jam** (clearing it takes about a reload). **Repair** it from the inventory for Scrap, sort the bag with **Sort**, and see rounds, dressings and health at a glance under the bag.
- **Crew** have a Loyalty meter and a loot cut that is withheld from every pickup. Betrayal is telegraphed by two radio
  warnings and a camp dispute before anyone deserts.
- **Roadside Encounters** are decided by both players voting in their own half. If you disagree the Encounter Lead decides, and
  overriding your partner costs a point of Trust. Three hidden axes (Mercy, Trust, Notoriety) decide the ending.

### Solo or split screen

The title screen has a **Players** switch: `2 · SPLIT SCREEN` (the default) or `1 · SOLO`. Solo gives you one scavenger,
one vehicle and the whole screen. Press A on a pad, or `T` (WASD) or `Right Shift` (arrows) on the keyboard, to take the seat.
The choice is remembered, and a run keeps the mode it started in: Continue loads a solo save as solo.

What changes when you are alone: there is no partner, so no tether, no revives and no votes. The one vote is yours, with no
Lead or Trust override. A downed player can hold `A` to use a convoy Medkit on themselves; without one, bleeding out ends
the run (there is nobody to revive you, so the "you both went down" rule becomes "you went down and could not get up").
The garage and Ledger show one vehicle, and Settings drops the Player 2 and split-screen rows.

### Learning the game

Two things on the title screen (and **How to play** also in the pause menu) teach the game without a manual:

- **How to play** is an illustrated guide: ten pages, each a picture and a few lines. The road to Haven, the daily loop, a numbered
  mock-up of your screen, the gamepad drawn with each button named (on foot, then driving), tap versus hold, noise and dust, the
  wrench, crowbar and jerrycan, camp and the night raid, and health, wounds, the downed rule and the tether. The key caps on the
  control pages are read from your bindings, so rebinding changes the guide. LB and RB turn pages; its last button, *Try it:
  training*, goes straight into the lessons.
- **Training** is a guided run in a quiet copy of the open world (`?training` in the URL goes straight there). You start on foot beside your moped at midday, with
  no raiders, hordes, wildlife or Dusk Bell until the end. Each seat gets its own lesson card in its own half of the screen, in its
  own key names, with a checklist; a lesson ends when everyone has done everything on it, and a world beam and compass pin point at
  what to go to. The twelve lessons: walk and look; sprint, jump and crouch; aim, shoot and reload (two sleeping infected to wake);
  take goods and search a crate; get into the moped; drive; noise and dust (the meter, and what a horn does to it); park and get
  out; the wrench and a fuel can (the moped is hurt and nearly dry); the map and pings; the pack; and the Dusk Bell and making camp.
  Nobody can bleed out in training (a downed player is back up after a couple of seconds), it never touches a save or the run's own
  world, and it works solo or in split screen. Stuck on one? Pause and choose *Skip this lesson*.

The lessons are `game/tutorial.ts` (one data table of steps, each with goals that read game state, and the director that runs
them; the scene itself only gains a `training` flag that mutes the hostile systems), the cards are `ui/coach.ts`, and the guide is
`ui/guide.ts` with its pictures in `ui/guideArt.ts`.

### Controls

| | On foot | Driving | Gunner (Tier 3 bed) | Camp build |
|---|---|---|---|---|
| Left stick | Move | Steer | | Move |
| Right stick | Aim / look | Free look | Aim gun | Aim reticle |
| RT / LT | Fire / aim | Throttle / brake | Fire / zoom | Place / remove |
| RB | Tap melee, hold takedown | Fire front gun, or the sidearm if the ride has none (drive-by) | Fire | Next element |
| LB | Swap what is in hand along your belt | | | Previous element |
| A | Tap: jump (when nothing is in reach). Hold: loot, repair, refuel, revive | Handbrake | | Rotate |
| B | Crouch | Tap lights, hold engine off | | Hold: ready for night |
| X | Reload (hold: swap utility) | Tap horn, hold siren | | Assign watch post |
| Y | Tap: switch first / third person. Hold: enter a vehicle | Tap: switch view. Hold: exit, or bail at speed | Tap: switch view. Hold: exit | |
| D-pad ↑ | Tap ping, hold command wheel | | | |
| D-pad ↓ | Tap to take the selected drug, hold to open the belt | Same | Same | Same |
| D-pad → | Tap map: closer look, whole leg, close | Same | Same | Same |
| D-pad ← | Inventory: change what you wear and hold (the game pauses) | Same | Same | Same |
| L3 / R3 | Sprint / reset camera | Camera distance / look back | | |
| Start / Back | Pause / hold for convoy sheet | | | |

**First and third person**: tap **Y** on a pad to switch the camera between the chase view and the eyes. It works on foot (the
camera sits at head height, you see your arms and what they hold), in the driver's seat (the camera is the driver's head: the
right stick or the mouse looks around and springs back to the road) and at a bed gun or passenger seat. Each player has their
own view, so one can drive from the cab while the other watches the road from behind. The choice is remembered. On a pad, view
and the vehicle action share Y: a quick tap switches the view, holding it (about a third of a second) gets you in or out, and
the prompt says *Hold*. Rebind either one and the share goes away. On the keyboard the view keys are `B` (Player 1) and `P`
(Player 2), and the middle mouse button.

**Jumping**: on foot you can jump about a metre. The take-off speed carries through the air (a sprint jump goes furthest) and the
stick only bends it, a press just before landing or just after walking off a ledge still counts, and a ceiling stops the rise.
You cannot jump while swimming, carrying a load, mid-action or pinned, and jumping from a crouch stands you up. On a pad, jump
shares A with interact: a press with something to interact with is left to the interact prompt, otherwise it jumps. Landing
hard is noisy. Jump is a normal rebindable action (Control settings, Move group).

**Drugs**: nine consumables, taken with the use button (D-pad ↓ on a pad, `4` for player 1, `U` for player 2). Tap it to take
the selected one. Hold it to open the belt, then lean left or right to pick (the feet stay put while your hands are in your pockets);
let go to close it. The belt is also where the counts are. Each player's blood is saved with the campaign, so a trip carries on across
a camp, a delve and a reload; a night's sleep clears it, and half-clears the habit.

| Drug | Works for | Good | Bad |
|---|---|---|---|
| **Painkillers** | 90 s | half damage | a sore comedown |
| **Stim** | 40 s | 25% faster | worse aim; a slow, shaky crash |
| **Adrenaline** | 12 s | heals 30, takes 70% less damage, **wakes you from anything** | a hard crash; very toxic |
| **Moonshine** | 70 s *a drink*, stacks to six | liquid courage: tougher, hits harder | sway, double vision, a worse shot, loud, and past four drinks you **pass out** (a hard hit wakes you). A hangover scales with how much you had |
| **Weed** | 80 s, stacks to three | slow and quiet: the dead lose interest; settles the stomach | slower, hungry (**the munchies cost an extra ration at camp**) |
| **Spore haze** | 60 s | quiet, slow regeneration | hard to put down |
| **Mushrooms** | 110 s | feel the living through the walls (about 50 m of mycelium: the dead, animals, raiders, loot) | the stomach turns on the way up; the giggles; things in the corner of your eye |
| **LSD** | 150 s | auras on the dead, a little faster | phantoms, flashbacks, floaty feet, worse aim; tolerance builds fast |
| **Ayahuasca** | 210 s | the vine purges you (clears toxicity and booze), then shows you **everything** within about 85 m: the dead, the loot, the pins the map never shows and the road ahead lit up | helpless while it purges; slow; amplifies everything else in you |

Effects come on over an onset, peak, taper and comedown, not a switch. Every dose adds **toxicity** (past 1 you are overdosing and
bleeding health until it fades), a little **dependence** (go without for ~90 s and the shakes, slowdown and visual swim of withdrawal set
in until you take another) and **tolerance** (the same dose lands softer next time). Drinking steadily is fine; six at once is not.

**Mixing is the game inside the game.** Some pairs do something on their own while both are working: *Couchlock* (alcohol + weed: a
stealthy slug), *Zen Focus* (stim + weed: steady hands), *Dreamscape* (weed + LSD: the things that are not there turn friendly and dance
round you), *Giggle Fit* (weed + mushrooms), *Deep Trip* (LSD + mushrooms), *Spirit Walk* (mushrooms + ayahuasca), *Wired* (alcohol +
stim: the stim hides the drunk, the drunk does not care), *Overdrive*, *Purge Fest*. Some are dangerous: alcohol and painkillers
(*Liver Roulette*), two stimulants (*Heart Race*), and anything stimulating on top of the vine. Ayahuasca makes everything else in you
hit harder and cost more, and its purge can undo a drink problem. Adrenaline sobers you up. The HUD names each blend as it starts.

**What you see and what changes**, only in the tripping player's own half of the screen: hue swim and swirl, wavy warp, chromatic
aberration, double vision, neon outlines, kaleidoscope folds toward the edges, motion trails that slide round the colour wheel (a
feedback buffer), a breathing heartbeat, tunnel vision, eyelids closing as you pass out, a rolling camera when drunk. In the world: the
ground and every wall swell and sink, the sky grows an aurora, mandala rings and (for the vine) an eye with a pupil that breathes and
a slow blink, stars come out in daylight, the light and fog drift round the colour wheel, spores and smoke float round you, giant glowing
mushrooms grow up out of the ground, and the road ahead lights up under the vine. Sound goes to cotton wool for the mellow and a warbling
echo for the rest. The HUD itself loses its footing. (Without the post chain, on Low quality, the lens effects fall back to a CSS filter.)

**Phantoms** are things that are not there. They are drawn only into your own view, shimmer and cast no shadow (less the deeper you
are in: at the top they look almost real), never appear on the compass, and the real dead do not react to them. They cannot hurt you,
and shots go through them: every round spent on one is wasted and **noisy**, and the real dead hear it. They dissolve if you look
straight at them for a moment, walk into them or swing at them. Under the vine they come as tall spirits; with weed and LSD they dance.

The body also does things on its own: vomiting (a few seconds helpless, and loud), stumbling, a hiccup, a song or a laugh at the wrong
moment (all noise the dead can hear), flashbacks that turn the visuals up, a paranoid something-behind-you. Drunk driving wanders the
wheel; pass out behind it and the car coasts to a stop.

Find them in delve chests (caves keep mushrooms and sometimes the vine; metros keep LSD; bunkers keep pills), in pharmacy and hospital
shelves, depot stock, medicine cabinets, coolers and safes; buy a few at a trader; make them at the Ledger's still. The numbers
(durations, strengths, toxicity, dependence, tolerance, every blend) are all in `src/sim/drugs.ts`.

**Keyboard**: solo play can use either layout below. Player 1 uses `W A S D` to move, the mouse to look (`Z X` to aim without it), left click or `T` to fire, right click to aim, `E` to interact, `Space` to jump, `F` for vehicles, `C` for
crouch and lights, `Shift` for sprint and handbrake, `G` for the command wheel, `Q` to swap tools, `R` to reload, `H` to honk,
`1 2` to cycle build elements, `V` for the map, `3` for the inventory, `4` to take a drug, hold `Tab` for the convoy sheet. Player 2 uses the arrow keys, `[ ]` to aim, `Right
Shift` to fire, `/` to interact, `O` to jump, `Enter` for vehicles, `.` for crouch and lights, `Right Ctrl` for sprint and handbrake,
`Backspace` for the wheel, `N` to swap tools, `,` to reload, `; '` to cycle build elements, `K` for the map, `I` for the inventory, `U` to take a drug, hold `\` for the convoy sheet. Keyboard players get stronger
aim assist. `Esc` pauses.

**Map and minimap**: each half has a round minimap under the clock, turned so up is where your camera looks and zoomed
out as you speed up. It shows the road, the ground, both convoys and the places worth a trip: camp, Encounters, scavenge
zones, roadside places, docks, ways underground, parked rides of yours, mined ground and any pings. Targets that are out of
range stay on the rim as small markers so the way to them is never lost. The dead appear on it only once they are chasing and
raiders only once they are on the road, so a map never gives away a sleeping horde. Tap the map button (D-pad right, `V` or
`K`) to open the larger map over your half, tap again for the whole leg, and once more to close it. The whole-leg view runs
north up in a tall half and turns to run along the screen in a wide one. Roadside places, docks and ways underground are
drawn once the convoy has come within sight of them and stay on the map after that. Underground the map is drawn only where
the party has walked, and at camp it is a radar of the watch posts. The map button is rebindable like the rest.

**Control settings** (title and pause menu, between Settings and Controls). Every action can be rebound for the gamepad, each
keyboard layout and the mouse, in separate tabs: pick a row, press the new button, key or mouse button. Binding something that is
already taken swaps the two, so nothing is ever double-bound by accident and nobody loses a control they need. Optional actions
on the keyboard and mouse can be unbound with `Del` while binding; `Esc` (or `Start` on a pad) cancels, and `Esc`, `F1` to `F12`
and the Alt and Meta keys are kept. Each tab has its look options (stick deadzone, look sensitivity, key turn speed, mouse
sensitivity, invert look Y), and a *Camera & play* tab holds the view per seat, the first-person field of view (70 to 120
degrees) and crouch as toggle or hold. Reset a tab to its defaults at any time. Everything is saved with the other settings,
and the in-game Controls screen and the button prompts follow whatever you bind. The sticks and the D-pad menu navigation stay fixed.

**Mouse / trackpad** (the Player 1 keyboard seat): click the game to capture the pointer, then move to aim with free
yaw and pitch. Left click fires (a tap on a trackpad), right click (two-finger click) aims down sights. `Esc` releases the
pointer and pauses; click again to resume aiming. Sensitivity is under Settings. Q/E still work. The in-game Controls screen has the full table.

## How it is built

TypeScript, Vite, three.js (WebGL2) and Rapier (WASM). Pinned versions are in `package.json`; the three.js and Rapier APIs
move between releases, so check any call against the pinned versions before reusing it.

```
src/
  core/      math, seeded RNG and noise, event bus
  data/      JSON tables (vehicles, enemies, mercs, structures, legs, encounters, strings) + typed access + validation
  sim/       pure rules with no engine imports: resources, loyalty, signature grid, raid threat, endings, damage, day clock,
             personal gear (`gear.ts`: wear, belt and bag rules, stats, loot)
  physics/   Rapier world wrapper and the data-driven raycast vehicle controller
  world/     deterministic terrain, leg layout (city grid, set pieces) and per-chunk content; `plans/` has authored city layouts
  render/    renderer and HDR post chain, sky and atmosphere, materials and procedural textures, terrain and road shaders,
             facades, chunk meshes, far landscape, ground cover, models (vehicles, people and their outfits, zombies, props), particles, camera
  game/      scene runtime, entities (player, vehicle, zombies, raiders, crew), combat, leg scene, camp scene, game loop,
             the training director (`tutorial.ts`)
  ui/        HUD, shared-cursor focus UI, overlays (title, votes, report), the Dawn Ledger, the inventory, the illustrated guide
             and training cards (`guide.ts`, `guideArt.ts`, `coach.ts`), styles
  input/     gamepad, keyboard and mouse sampling into per-player intents; `bindings.ts` holds the rebindable action table
  audio/     procedural Web Audio: engines, weapons, stems that crossfade by state
  save/      IndexedDB (with a localStorage mirror), written at every Dawn Ledger
tests/       Vitest suites for the sim, vehicle physics, world generation and game logic
```

Decisions that follow the blueprint:

- **Fixed 60 Hz simulation** with an accumulator clamped to five steps, rendering with interpolation. Input is sampled into
  one `PlayerIntent` per player; the sim never reads devices.
- **One renderer, one scene, two cameras** with a viewport and scissor per player. The screen splits left and right by
  default; Settings switches to the blueprint's top/bottom strips. Horizontal FOV is fixed at 100 degrees and the vertical
  FOV is derived (37 degrees for a 1920x540 strip), with a 32 degree floor. A 4 px divider separates the halves.
  Shadows are re-aimed at each player before each render, centred ahead of them and snapped to whole texels so they don't
  shimmer. Resolution adapts to hold frame time, using one shared scale so the halves always match.
- **Rapier raycast vehicle controller** for every vehicle, parameterised from `vehicles.json`. Two-wheelers are held upright
  by a PD torque about the roll axis. Terrain is a heightfield per 128 m chunk, streamed around both players.
- **Zombies are logical, not rigid bodies**: a 20 Hz AI with Dormant, Wander, Investigate, Chase and Swarm states, hearing by
  lookup in a 16 m Signature grid, and a horde cascade at five chasers. They render as one instanced, animated mesh. Vehicles
  plow them through a volume in front of the chassis (about 3% speed lost per zombie on Tier 3).
- **Wild animals** (`game/wildlife.ts`, tuned in `data/wildlife.json`) are logical like zombies and share one instanced
  renderer (`render/animalRender.ts`, a body mesh and a limb mesh per species, legs swung from the hip by matrix). Seven
  species with five temperaments: *prey* (dust hare, scrub antelope) graze, then bolt from people, engines and gunfire, the
  whole herd together; *birds* (carrion vultures) wheel overhead and sink lower over fresh carcasses; *packs* (feral dogs,
  cinder wolves) hunt people on foot, wolves circling before they spring, and break off when badly hurt; *chargers* (tusker
  hogs) wind up and rush in a straight line, then stand winded; *brutes* (ash bears) ignore you until you walk into their
  space, then maul people and vehicles. The leg scene keeps the population topped up out of sight ahead of the lead
  vehicle (`ambient`), weighted by biome, theme, leg and time of night, with a cap per species. Meat animals pay rations
  when killed. They take bullets, blasts, fire, melee and vehicle plows; big ones cost the plowing vehicle real health.
- **Data first**: rules live in JSON and are checked by `validateData()` in the test suite.
- **All text is a key** into `strings.en.json`.
- **Accessibility**: player colours are an orange/blue pair that stays distinct for colour-blind players; the Signature meter
  uses hatching and block width as well as colour; UI scale 80 to 150%; per-player rumble and aim assist; Drain, Aggro and
  Damage sliders; pause on controller disconnect.

### Deliberate deviations

- The on-foot camera sits 4.9 m back and 2.15 m up rather than the blueprint's 3.2 m and 1.6 m. On a 3.5:1 strip the
  character filled most of the height at 3.2 m.
- Vehicle braking and the speed-sensitive steering limit are applied as controlled decelerations and lateral-acceleration caps
  rather than raw wheel brake force, because Rapier's wheel brake units vary several times between vehicles and a full-lock
  steer at speed spins a raycast vehicle out. A small yaw-rate assist catches slides.
- bitECS and recast-navigation are not used: the slice's crowd size and open streets are handled by plain arrays, a spatial
  hash and steering with obstacle push-out. They are a drop-in for the Beta if crowds and interiors demand them.
- Rapier stays on the main thread (the blueprint's stretch goal is a Worker).
- Assets are procedural, so the project has no binary files. See [Rendering](#rendering).

### Wasteland variety

The wasteland legs are no longer one empty canyon. Along each leg the corridor swings between narrow stretches and wide basins (`openness`), and between hard flats and rolling dune seas (`duneness`); flat-topped buttes stand in the open country. Every leg has its own ground palette (`theme` in `legs.json`: dust, salt, cinder).

Roadside places (`world/terrain.ts` plans the sites, `world/settlements.ts` fills them): gas stop, hamlet, motel, farm, depot yard, broken overpass, wind farm and radio hill, spaced every few hundred metres and clear of the authored set pieces. Between them run power lines, billboards and lone water towers and windpumps. Each place has loot and a dormant cluster of the dead. The terrain flattens a pad under each one.

Buildings and landmarks are drawn by the far landscape for the whole leg (`render/landscape.ts`, `render/ruralView.ts`, `render/landmarks.ts`), so a gas station or a wind farm shows on the horizon long before its chunk streams in. Only their colliders stream.

### Interiors

Every roadside building can be entered. `world/interiors.ts` generates a floor plan from the building's seed: exterior and interior walls with doorways, gates and windows, rooms with a role (living room, kitchen, bedrooms, bathroom, shop floor, back office, motel rooms, a barn's stalls, warehouse racking) and a floor, stairs and an upstairs for some houses, furniture, searchable containers and damage (breached walls, a collapsed or missing roof, rubble). Layouts differ with the seed, and every room is reachable from a door to the outside. Furniture placement is rejected if it would cut a doorway or the stairs off.

The plan becomes colliders (`planAabbs`: wall pieces with the doorways left open, window sills, furniture, a sloped collider for each stair, upper-floor slabs) and geometry (`render/buildingView.ts`, `render/furniture.ts`; walls are facade-shader quads on both faces with no painted windows, so the openings are real). The terrain is levelled under each building (`TerrainDef.foundations`), so the ground inside is the floor.

When a player or vehicle is inside, that viewer's roof and all upper storeys are hidden (`BuildingView.setView`, called per view from `LegScene`), so the room can be seen from the chase camera. Furniture is only drawn near the camera. Searchable furniture (fridge, wardrobe, filing cabinet, till, workbench, safe, ...) is a loot container in a per-building `ScavZone`, using the same search-and-noise rules as the city shops. The dead are placed inside some buildings, and zombies route through doorways when a wall is in the way.

Tests: `tests/interiors.test.ts` (reachability, door clearance, walkability by flood fill) and `tests/walk.test.ts` (a Rapier player capsule with the game's character-controller settings walks from the doorstep to every room and up the stairs).

### Gear and the inventory

Each scavenger has a personal kit (`data/gear.json`, `sim/gear.ts`) in three parts, and the inventory screen is where you change it. Press **D-pad ←** (keyboard: `3` for Player 1, `I` for Player 2; rebindable under Control settings) on foot. The game pauses, the panel opens over the *other* half of the screen, and your own camera swings into a slow orbit of your survivor so every change shows on the model.

- **Wearing** (seven slots: head, face, body, hands, legs, feet, back). Every piece changes both stats and looks. **Armour** cuts the damage from bullets, claws, blasts and rams; **spore guard** (masks) cuts bloater clouds; **fall protection** (boots, knee pads) cuts falls; **speed** and **footstep noise** trade against each other (plate is slow and loud, sneakers are quiet, trail runners are quick); **reload** and **gun spread** come from gloves and goggles; **melee** from gauntlets; and a pack, vest or cargo trousers add **bag slots**. Fire ignores armour. Clothing is built in `render/outfit.ts` from a style and two colours per slot: 31 wearable pieces across the seven slots, in three rarities. Starter pieces use your own colours; any other body armour puts an armband in your colour on the sleeve so you are still recognisable in a split screen.
- **In hand** (the belt: four slots, plus the utility). The slot in hand decides what the on-foot buttons do, and **LB** steps along the belt, then to the throwable (flare, molotov, charge or decoy horn, chosen with hold-X as before, or in the inventory). The belt holds firearms, melee weapons and the three tools (wrench, crowbar, jerrycan), so carrying a shotgun means leaving the crowbar at home. The belt always keeps one weapon. **Guns** each have their own damage, fire rate, magazine, reload, spread, range, noise and pierce: the 9mm pistol you start with, a .38 revolver (slow, hard-hitting, punches through plate), a scrap SMG, a sawn-off and a pump shotgun (eight pellets a shot, only the first is loud), and a hunting rifle. Every gun keeps its own magazine when you swap. **Melee weapons** (knife, bat, machete, fire axe) swing on RT as well as RB, each with its own damage, reach and pace; bare hands are still the old 35. Hold RB for the silent takedown as before.
- **The bag.** Four slots plus whatever the pack, vest and pockets add (rucksack +6, duffel +10, frame pack +14). You can't take off a pack whose pockets are holding what's in your bag. From the bag: **wear** (swapping with what is worn), **put in hand** (into a chosen belt slot), **give to your partner**, or **break down** for Scrap. Selecting an item shows what it does and how it compares with what you have on. A medkit button heals you (+60 HP) from the convoy's stock.

The Dawn Ledger has a **Gear** tab with the same screen (switch between the two scavengers at the top), so you can reorganise before you roll out. The screen itself is `InventoryView` in `ui/inventory.ts`, shared by the in-game pause screen and the Ledger tab.

Gear is found, not crafted. A searched shelf or locker (deeper is better), a delve chest (a hoard always pays in rare gear), a car's cabin and trunk (a raider's wagon most often) and a fallen raider's kit can each turn one up. Finds are seeded by the container or car, so reloading can't reroll them, they skew better the further the convoy has come, and they go to your bag, then your partner's, then become Scrap, so nothing is lost on the floor. The loadout is saved with the campaign (`PlayerSave.gear`); older saves get the starter kit, and a damaged save is repaired rather than trusted (`sanitizeLoadout`).

Tests: `tests/gear.test.ts` (the catalogue, capacity and stat rules, equip and unequip, sharing, save repair, loot odds) and `tests/gearplay.test.ts` (real leg scenes: armour, speed and noise, the belt and LB, each gun's numbers and magazine, melee weapons, the inventory key, saves, finds and the inventory camera).

### Ballistics, weapon handling and gore

Shots are real objects now. `Combat.shoot` still takes the same arguments, but instead of an instant ray it launches a round that `Combat.update` flies one tick at a time (`game/combat.ts`, rules in `sim/ballistics.ts`).

- **Flight.** Each round has its own muzzle speed, drag and mass (pistol, .38, SMG, shotgun pellet, hunting rifle, the raiders' sniper, vehicle guns). Gravity pulls it down and quadratic drag against the *air* slows it, so a **dust storm's wind** (`windAt` in `sim/weather.ts`, the same direction the dust leans) pushes it sideways: light, slow pellets drift most, a rifle round hardly at all. Sights are zeroed per round, so the drop only shows past that range. Pad aim assist now leads a moving target by the flight time. Speeds are game-scaled, slow enough that a long shot has real flight time, fast enough that a street is still near-instant.
- **Penetration.** A round that arrives at a wall measures the slab with a second ray from the far side and compares its remaining energy with what the material asks for (`SURFACES`): planks and plaster stop pellets but not a pistol, corrugated sheet and car bodies need a .38 or better, and nothing in the kit goes through concrete or the ground. What gets through leaves slower (so it hits softer), a little off true, with a puff and a hole on the way in. Buildings carry a `mat` on their wall boxes by look (barn and house wood, shack and warehouse sheet, shops plaster). Only the heavy rounds come out of a body, into whoever is behind it.
- **Handling** (`sim/handling.ts`, per gun model). Each shot kicks the view through four springs (muzzle climb, twitch, camera roll, push back) that snap up and settle; the shot follows the kicked view, so a long burst climbs. Aim-down-sights is a spring too: a pistol is up in about 0.13 s, the rifle takes 0.33 s and rings slightly past the mark. The barrel wanders (breathing and tremor), less behind the sights or crouched, more when moving or winded, and the arms in the model take the sway and the buck. Brass leaves the gun as it should: a pistol or SMG throws a case with each shot, a bolt rifle or pump after the action cycles, a revolver and the sawn-off hold their empties until the reload opens them. Cases (`render/brass.ts`) tumble, bounce off the floor with a ring, roll to a stop and stay.
- **Gore** (`game/gore.ts`, `render/decals.ts`, `render/gibs.ts`). Every hit sprays blood along the bullet's path and mists back at the shooter, then casts forward: the spray lands as a streaked, persistent **decal on the wall or road behind the target** (a ring buffer of 720 marks in one draw call; blood is wet red when it lands and dries to brown over a minute; bullet holes stay). Bodies leave pools and smears thrown the way the shot went, and drop facing the shooter. A round's *momentum* shoves a zombie back (a blast of pellets throws a walker about a metre, a brute barely moves) and the body reels. Heavy rounds (pellets, the rifle, vehicle guns, a .38 a little) accumulate damage per limb and take it off (`wound`): arms and legs fly as gibs with a trail of blood and a bleeding stump, a head shot takes the head, a far-overkill blow tears an arm off the body it hit, and a blast that kills tears one to three pieces off. A body without legs drags itself at a fifth of its speed, one leg is a limp, no arms halves its claws. The zombie shader hides the part and caps the stump raw red; the cut limb is a pooled instanced gib.

- **Breaking things** (`game/destruction.ts`, `sim/breach.ts`). Wall pieces of the roadside buildings have hit points by material (glass 12, plaster 150, wood 220, corrugated sheet 260; concrete and brick are untouched) and take damage from bullets, blasts and fast heavy vehicles (a ram spends its kinetic energy on the wall). **What hurts what** (`structuralMul`): a pistol, SMG or raider round does nothing to a wood or plaster wall (it leaves a small hole) but shatters glass at once and chews sheet metal slowly; a .38, shotgun pellets, a rifle and mounted guns do real harm, and blasts (charges, mines) are all damage. Intact windows are real panes (a collider that stops people), and any bullet breaks one and carries on through it. Every hit first leaves a bullet hole and dust; a piece that has had enough opens a **breach** in the building's *plan* (folding any door or window it reaches into one gap, a person wide for bullets, up to 3.8 m for a blast). Everything that reads the plan follows: the building mesh is rebuilt with the ragged opening and rubble, the wall's colliders are swapped (`wallAabbs`) so you can walk through, the dead get a new doorway, and the cached chunk data is edited in place, so streaming the chunk back keeps the hole. Splinters, plaster and sheet fly off as debris, the crash carries (noise). Flimsy barricades break under fire; reinforced ones still need a charge. Explosions (`Combat.explode` at radius 3 or more) also char the ground. A hit on a moving thing (a vehicle) leaves a spark but no hole, since a decal would stay behind in the air.
- **Marks that stay** (`render/decals.ts`, own 1100-slot pool apart from blood). A hit on a wall leaves a hole as wide as the round made it (about 9 cm of mark for a pistol, 16 cm splintered for a rifle, 21 for a mounted gun, 5 for a pellet): a black pit in a ragged ring of pale exposed material with splinters, plus chips thrown back; a heavy round leaves a bigger splintered one. A round that goes through leaves a second, ragged exit hole on the far face with debris blown on ahead. Earth and stone keep a scuffed pit. A shipping container is hollow sheet steel: a pistol round goes through one skin but not both, a rifle round goes through both. Boxes that only stand for something round (rocks, tanks, pillars) keep no mark, so none hangs in the air beside them. A wall that is wearing down cracks round the spot at two thirds and one third strength. Wood and sheet breaches throw whole planks. Marks on a stretch of wall that comes down are removed with it.

Tests: `tests/destruction.test.ts` (the breach rules, and real scenes breaching a building by gunfire, blast and ram-sized damage, barricades) and `tests/ballistics.test.ts` (flight, drop, wind, penetration, the wound rules, kick and ADS springs, and real leg scenes: time of flight, a plank fence, a thick wall, a round through two bodies, a shotgun's shove, dismemberment, wall splatter, brass and kick).

### Cars, parts and the garage

Every car standing in the world is a real vehicle. Hatchbacks, sedans, pickups and vans (`vehicles.json` `cars`) are streamed in as the convoy approaches and put away, with their state, once it moves on (`game/cars.ts`). Each car rolls its condition from its seed: a **burnt-out hulk** (strip it for parts), a **rough runner** with at least two real faults (flat tyres, a seized engine, a leaking tank), or one **sound enough to drive**. Roadside wastelands also have stalled-traffic jams on the shoulder, and city boulevards are full of them.

- **Take any car.** Walk up and press Y. Climbing into an abandoned car claims it for the convoy and adds it to the **yard** (six vehicles). Whatever you drove last rolls out with you. A second player can ride along as passenger, or as bed gunner in a pickup with a gun mount.
- **Repair is real work.** With the wrench, hold A: the most urgent fault is fixed in turn (fire, leak, tyre, engine, weapon mount, bodywork). Each job names its cost, such as a tyre patch for 2 Scrap or an engine rebuild for 3 Parts. With no Parts, an improvised Scrap job still works so nobody is stranded. A convoy engine below 10% will not start until rebuilt.
- **Strip what you can't drive.** With the crowbar, hold A on a hulk or an abandoned car to take four stages: tyres, engine, bodywork, cabin and trunk. Raider wrecks carry better kit. The loot is fixed by the car's seed, so leaving and coming back can't reroll it. The jerrycan siphons fuel from abandoned tanks into the convoy reserve.
- **Parts are items** (`data/parts.json`, `sim/parts.ts`): aftermarket parts across seventeen slots (engine, radiator, gearbox, exhaust, springs, brakes, tyres, bonnet, both doors, armour, weapon mount, fuel and cargo, plus front, roof, rear and side mounts), in three qualities with a wear value. Every car's factory engine, radiator, gearbox, exhaust, springs, brakes, tyres, bonnet and doors are parts too. An engine, radiator, tyre set or armour kit replaces a damaged component, so swapping in a good one repairs it. Parts turn up in salvage, in yards and settlements, beside parts wrecks, and can be fabricated at camp.
- **Everything is picked up by hand.** Nothing is collected by walking or driving over it: stand next to scrap, rations, ammo, tech, medicine, spare parts, radio fragments or a salvaged chassis and hold A to take it straight into your stock.
- **Carry things by hand.** Loose parts, fuel cans, water cans and oil cans lie along the road, in settlements, gas stops and beside wrecks. On foot, hold A to lift one (you walk slower, can't sprint, and your gun and tools are out of reach). At one of your own vehicles, **A** puts it straight on (bolt the part on, pour the fuel in, top the oil up) and **X** stows it in the trunk for later; **X** anywhere else sets it down. Climbing in with full hands stows the load, or sets it beside the car if the trunk is full. Spare fuel, oil and crates of spare parts are visible, strapped to the boot, bed, roof or carrier (`render/cargoLoad.ts`). Code: `sim/carry.ts` (what a fit or stow does), `game/hauling.ts` (the input, prompts and carried-item state on `Player`), `LegScene` (`loose`: lifting, dropping and taking goods).
- **Work on the car with your hands.** Every car has mount points: the engine bay, each wheel, a flank, the tail, the roof, the front bumper, the gun post. Stand beside one of your cars with the wrench out (or a part in your arms) and a glowing dot marks each mount; the one your hands are over gets a ring and a callout naming what is on it. With the wrench, hold **A** to unbolt it (a set of tyres comes off all four wheels): the part leaves the car, which visibly loses it, and flies into your arms. Carry a part to its own mount (the ringed spot) and hold A to bolt it on; the old one is stowed. A worn stock part is repaired by hovering it, and anything fitted is repaired from anywhere else on the car. Every part has its own model (engine block, tyres, plate stack, gun mount, tank, roll cage...), the same in the hands, on the ground and on the car. **X** at a car puts what you carry on that car's deck, where it sits, drawn as itself, and stays on that car; stand at one on the deck and hold A to lift it off again. The wrench menu on **X** (`paint & oil bench`) is only for paint and oil. Code: `game/carwork.ts` (mounts, targeting, unbolting, deck lifting), `render/partModels.ts`, `render/cargoLoad.ts` (per-item deck layout), `render/workFx.ts` (`focus` markers, `eject`).
- **Engines burn oil.** Every convoy engine has a sump (`comp.oil`, 0 to 1; `sim/oil.ts`): a full one lasts about 14 km at baseline Drain, a shot-up engine bleeds it, and a worn engine burns it faster. Below 25% the engine loses power; run dry and it wrecks itself until it seizes. Cans (half a sump each) come from the roadside, settlements, and from draining an engine with the crowbar. Top up from a can in your hands, from the convoy's reserve with the jerrycan tool, or with the **Top up oil** button in the garage and workbench. A full service and an engine rebuild both put fresh oil in.
- **Fit them anywhere.** At camp the Ledger has a **Garage** tab with both players' vehicles live in side strips: fit and remove parts, fabricate, paint (twelve colours, stripes), service, assign who rolls out in what, or break a spare vehicle down. Mid-leg, wrench + X opens the **workbench** for one of your own vehicles (fitting only). Every part is visible on the model: bull bars, dozer blades, roof racks, light bars, spare wheels, side plates, fuel cans, fixed or bed-mounted guns.
- **Parts change driving.** Power, top speed, grip, suspension, off-road ability (a road car loses far more speed in sand than a buggy), armour by side, fuel capacity and burn, noise, zombie plough width, ram damage and headlight reach all come from what is fitted. Cargo space sets how many spare parts the convoy can carry.

#### Engine swaps, fuels and heat

Any engine goes in any vehicle: a V8 in a hatchback, a scooter motor in a van, a petrol engine in a diesel van. Nothing is refused; the numbers decide whether it is a good idea.

- **Engines are real** (`EngineSpec` in `data/parts.json`, maths in `sim/engines.ts`): litres, kW, kilograms, a size class 1 to 5 and a fuel. 17 engines from a 50cc scooter motor to a 14.5 L rig diesel; the first three tune-up ids (`eng_i4`, `eng_v6`, `eng_v8`) are unchanged so old saves load. Each chassis is balanced around its **factory engine**, so a stock vehicle is exactly what `vehicles.json` says, and fitting another engine scales the chassis by how the two compare: output with diminishing returns (a tyre can only put so much down), weight that sags the suspension and costs grip, fuel burn, and noise (so Signature).
- **The engine bay.** Each chassis has a bay size. An engine bigger than the bay is *forced in*: snug, tight, or the bonnet is cut, and every step starves the radiator of airflow. It shows on the model: a raised block and chrome stacks through the bonnet, a diesel stack, a car engine hanging out of a bike frame.
- **Factory fittings are parts.** Pull an engine and it comes out as an item that keeps its wear, and goes back in. Strip the bay and the vehicle is simply empty and will not run. Stripping a car with the crowbar usually hands you its own engine, and some found cars are hot rods that someone already swapped.
- **Petrol and diesel.** An engine burns the fuel it was built for and a tank holds one fuel. Petrol is the convoy's `Fuel` (everything that already spent Fuel still does); **diesel is a reserve of its own**, a third of the cans found on the road. Cans, siphoning and the roll-out pump all respect the type. Swap a petrol engine into a diesel van and the tank still holds diesel: it will not start (*"Wrong fuel: the tank holds diesel, the engine runs on petrol"*) until you drain it with the jerrycan (the fuel goes back to the diesel reserve) and fill with the right fuel. A dry tank takes whatever you pour; one with fuel in it only takes more of the same. If there is no diesel to be found, swapping to a petrol engine is the way out. Rules in `sim/fuel.ts`.
- **The radiator** is its own slot (`rad_*`, cooling in kW) with a condition percentage. Engine temperature is simulated (`sim/thermal.ts`): the engine makes heat in proportion to output and load, the radiator sheds it in proportion to its rating, condition, speed and how much airflow the bay leaves it. Past the redline you lose power and wear the engine, steam rolls out from under the bonnet, and left to cook it blows its gasket. A stock vehicle never gets near it; a big engine on the factory radiator will. The HUD has a temperature bar, shot-up radiators are repaired with the wrench, and the Mechanic fixes them too.
- **Forecasts.** In the garage every engine, radiator and tyre candidate shows what it would do before you fit it (`sim/forecast.ts`): power, top speed, range on a tank, extra weight, how the bay takes it, whether it overheats, whether it leaves the wrong fuel in the tank.

#### The whole machine, not just the engine

An engine is only the start of it. Every other component has a rating and is judged against what the engine in front of it asks. Nothing is refused and nothing is balanced for you: a V8 on a moped will run, and then the gearbox will grind itself up, the springs will sag and the brakes will not stop it.

- **Gearbox** (`gbx_*`, `sim/drivetrain.ts`). Rated in kW. Output over rating is the *strain*; above 1 at full throttle the gearbox wears (`comp.gearbox`), and a worn one first carries less, then slips and loses power. Close-ratio boxes launch harder and run out of speed sooner; overdrive boxes do the opposite; heavy and race boxes carry far more at a cost in weight. No gearbox, and the engine runs while nothing reaches the wheels.
- **Springs** (`sus_*`). Rated in kilograms against the vehicle's real weight (the engine and gearbox are part of it). Overloaded springs sag: less travel, less grip. Long-travel kits soak up rough ground, air-ride carries a rig's worth.
- **Brakes** (`brk_*`). Rated in kJ against the energy of a stop from top speed. A faster, heavier vehicle has more to shed; if the brakes are not up to it, stops get much longer, and a race caliper set makes up for it. Stripped brakes barely work.
- **Exhaust** (`exh_*`). Free-flow pipes and headers add power and noise (the dead hear it too, so it raises Signature); a silencer takes both away. Straight-pipe stacks stand up behind the cab.
- **Tyres are per wheel** (`VehicleBuild.tyres`). Fit a different tyre on each corner or none at all: a bare rim is a steel wheel on a brake disc that barely grips. Carry a tyre up to a wheel and that wheel is outlined and fitted; the old one comes back as a part with its wear. Old saves that had one tyre set per vehicle load as that set on every wheel.
- **Bonnet and doors come off.** `hood_*` and `door_*` are parts too: pull them and the vehicle really is missing them. A bonnet off exposes the whole engine, sized for what it is (a V8 stands up tall, a diesel has its injector pump, a blown engine its supercharger), and shots from the front find it far more often. A door off leaves a gap showing the seat and takes the armour off that side. Replacements are vented, scooped or armoured bonnets and canvas, plated or armoured doors (armour counts); a door fits either side.
- **Bigger engines drink more of everything** (`sim/fluids.ts`). Fuel burn rises steeply with output. The **sump** holds litres by engine size (`0.5 + 1.15 L`), and a big engine burns more litres per kilometre (a blown or diesel one more again), so a spare oil can goes less far. The **cooling system** holds litres by radiator and engine size, loses water slowly to evaporation, quickly through a holed radiator, and boils it away when the engine cooks; with the water gone the radiator sheds a tenth of what it should. Oil stays in cans (half of a standard three-litre sump each) and **water is carried in litres**: a can is ten litres, the convoy stows up to eighty, scoop more from any lake with the jerrycan tool, and pour a can into the radiator by hand or with **Top up water** in the garage. A small can goes a short way into a big engine's cooling system.
- **Taking things off.** In the garage every mount has a *Take it off* button. In the field, the **crowbar** pries the part you face off your own vehicle (hold A) and you carry it away or stow it with X; panels win a close call against the small parts beside them, internals wait until the panel over them is off. Parts come off carrying their wear.
- **Forecasts** (`sim/forecast.ts`) cover all of it: before you fit anything the garage says what it does to power, top speed, range, heat, gearbox strain, spring load, braking, oil and water volumes, and what no bonnet, no door or a bare wheel costs.

#### Attach points and inspecting parts

- **Sockets** (`render/sockets.ts`). Every slot is a physical place on every chassis, derived from the model's own mount data: the engine under the bonnet, the radiator behind the grille, tyres at each wheel, plates on the doors, the bonnet, each door, the gearbox under the floor, the exhaust at the back. Carry a part up to a vehicle of yours and its sockets are outlined; when you are within reach the outline turns green and fills, with a tag at the spot (*"Radiator / Now: Sedan Radiator 100% / Attach Medium Race Radiator"*). Stand too far away and the prompt tells you to walk to the engine bay. Hold the button to bolt it on. From afar a tyre shows an outline at every wheel; up close only the wheel it would go on.
- **Inspect tags.** Looking at a loose part (or holding the wrench or crowbar by your own car, which aims at the socket in front of you) shows a tag with its name, condition and the one number that matters (*"Medium Race Radiator / 38 % / Cooling - 190 kW"*). Held and loose engines, radiators and tyres have models of their own.

#### Spray paint

Panels (bonnet, roof, both doors, front and rear end; a bike or quad has front and rear) can each be a different colour from the rest of the vehicle (`sim/paint.ts`, baked into the model by `render/paintJob.ts`). Fresh paint covers the rust on that panel. In the garage pick *Whole vehicle* or a panel, then a swatch. In the field, a **spray can** is carried by hand like a part: you find them in car trunks, or take one from the workbench (wrench + X) in the colour you last picked; face a panel of your own vehicle, hold the button, and it is rebuilt in the new colour. Each can covers six panels and cannot be stowed, only put down.


The moped to quad to buggy chain is still the guaranteed path (rebuild at a Waypoint garage). Found cars are a faster, luckier one, with their own strengths: hatchbacks are light and quick, sedans fast and fragile off the road, pickups sturdy with a bed for a gun, vans carry the most.

### Bodywork: crumpling, torn-off parts, mud and tyre tracks

A vehicle's body is no longer a rigid prop. Four systems sit on top of the car models, each with its rules in `sim/bodywork.ts` (pure numbers, tested in Node) and its look in `render/`. One `Bodywork` object per vehicle (`game/bodywork.ts`, never on boats) ties them to the physics.

- **Crumpling** (`render/deform.ts`). Each body is wrapped in a free-form lattice (control points about every 0.4 m). A crash pushes the control points near the contact along the impact direction and every vertex of the merged body follows the points around it, so a bumper folds back, the bonnet buckles up, a fender caves in and a flank warps, whatever the model is made of. The contact point and direction are the real ones: `VehicleBody.contacts()` reads Rapier's narrow-phase manifold in the chassis frame (ground contacts under the car are skipped), and falls back to the direction of the velocity change when there is none. Depth comes from the closing speed and the mass of what was hit (`dentDepth`: a 4 m/s bump marks nothing, 20 m/s folds the nose about half a metre) and is capped so a body cannot fold through itself. Normals are carried through the lattice's inverse-transpose Jacobian, and a vector noise scaled by how crushed the metal is crinkles it and scrapes the paint back to dark bare steel (the kit shader's wear then rusts it). Headlamps and tail lenses ride the lattice with their panel and go dark once it is crushed. Bullets leave small dents, blasts big ones (`Combat.explode` passes how near the centre the car was), a brute's fist a medium one; sideswipes scuff and throw sparks. The first dent copies the vehicle's body out of the shared shell cache (a car nobody has hit still shares one mesh with its twins), and re-skinning is sliced (9000 vertices a frame), so a full-body crash costs a few milliseconds spread over a few frames (the 71k-vertex buggy is the worst case).
- **Parts that come off** (`render/bodyParts.ts`, `game/debris.ts`). Model builders wrap the primitives of a part in `b.mark(tag, meta)` / `b.end()`; the merged body keeps each part's vertex range, so no model is built in pieces. Tagged: doors, mirrors and bumpers on every car; the buggy's doors, bull bar, light bar, spare and crate; the quad's sign plates; every fitted module (front, roof, rear, side, armour, utility, per side where there are two). Each joint has a rating (`tol`, in m/s of sudden speed change: a mirror 3.6, a door 10, a bull bar 12, a roll cage 15; tougher at higher part quality, varied a little per car). A knock adds strain: the car's own change of speed, plus the spin's swing out at the end of the arm, fully if the contact was near the part and a third as much if the body only carries it along; whirling (a roll, a spin-out) adds strain continuously by the centripetal pull, so a roof rack goes first. At 55% a part starts to work loose: it becomes its own mesh on a spring joint, rattles with the car's acceleration and throws sparks; at 100% it tears off with the car's speed at that point plus the knock behind it, and becomes a **real Rapier body** (a cylinder if it is a wheel, so it rolls). It is solid to vehicles once it has cleared the chassis it came off, and wheel rays stand on it, so a door in the road is a bump and a bull bar standing on end is a wall. A fitted module takes its part with it: it leaves the build's `fit` (the stats go too), the far side's half of a two-sided module follows a moment later, and the piece carries the worn part. Once it has lain still it can be lifted like any loose part and bolted back on; far-culled or capped pieces become ordinary pickups, a camp or cave (where nothing can be lifted off the ground) stows the part in the trunk, and in the open world both the pickups and the pieces persist overnight (`WorldMemory.drops`). A wreck throws up to five parts clear. Doors, mirrors and bumpers are not parts you can carry: they stay gone until a **weld job** (wrench: "Weld a missing panel back on", 3 Scrap) puts one back, and a bent car gets a **"Hammer out the dents"** job even with full hit points (each job takes half the dents out). The HUD's vehicle card shows DENTED / CRUMPLED / N PANELS OFF.
- **Mud, dust and blood** (`render/vehicleDirt.ts`). Every vehicle has its own copy of the kit material with three uniforms. The fragment shader works the coats out from where each pixel is (height above the ground, distance from the axles, which way it faces) and the kit's grunge texture: mud climbs from the sills up the flanks and highest round the wheel arches, dust settles on what faces the sky, blood spatters the nose and lower front. Nothing is rewritten per vertex as the dirt builds. The rules (`dirtStep`) fill it with the miles (sand and hard earth raise dust, mud and wet ground raise mud, a dust storm settles dust), running down a zombie or an animal adds blood, and wading or rain washes it. Mud, dust, blood, dents, loose joints and missing panels live in `VehicleBuild.body`, so they survive the night, the garage and the save file.
- **Tyre tracks and skid marks** (`render/trackMarks.ts`). Every wheel in contact lays a ribbon behind it into one ring buffer of 7000 segments, drawn as one mesh (so its cost does not grow with the number of tracks). Soft ground (sand, hard earth, mud) takes a groove with raised edges and a printed tread, darker and deeper in mud; asphalt takes only black rubber, and only from a tyre being scrubbed across it (locked under braking, handbrake, sliding sideways: `skidAmount`). Marks are lit decals a few centimetres off the ground with a berm-wall-floor profile, so the sun catches a groove's edge; they fade slowly with age (minutes, longer for mud and rubber) and dissolve with distance from the camera. Only wheels near a player lay marks. In the open world the whole buffer is carried over to the next day (`WorldMemory.tracks`).

Tuning is in `sim/bodywork.ts` (dent depth and width, joint strain, the dirt rates, which surface takes which mark) and the tables in `render/bodyParts.ts` (each module's mass and joint). Not done: the physics collider stays a box (a crushed nose still collides as a whole one), a lamp's glass does not shatter, the lattice does not move the wheels, and debris does not push zombies or raiders on foot.

### Glass: windows, shopfronts and cars

Every pane you can see through can be shattered, and glass shows what it has been through. The rules are in `sim/glass.ts` (hit points by kind: house window 12, shop plate glass 36, side window 10, rear window 16, laminated windscreen 42; how a bullet, blast, shove, swing or crash lands on each; which stage a pane is in). The look is `render/glass.ts`: a `PaneSet` merges the whole panes of a building, a street or a car into one clear transparent mesh; a pane that has been hit leaves it for a frosted mesh of its own with a white web of cracks round each hit (crossing two thirds and one third of its strength it goes **cracked**, then **crazed**), and a pane that goes is taken out, leaving a few teeth of glass in its frame while loose shards (`Gibs` kind `shard`: flat slivers that skitter and never splash blood) spray off it, with a crash of glass that other people can hear.

- **Wasteland buildings.** Intact windows are panes in the building's plan (`Opening.glass`) with a collider (`mat: 'glass'`) that stops people and cars but lets the camera and a line of sight through. `Destruction` cracks them as they weaken and shatters them at zero, which turns the plan's window into a broken one. A store's wide window takes three times what a house window does.
- **City shopfronts.** The facade shader paints every ground-floor bay as a shutter or a window, chosen by a hash of the bay. `world/shopGlass.ts` makes the same choice on the CPU (the shader's hash in single precision, checked by eye against the render), so a pane of glass with its own collider stands in front of each painted window bay on the boulevard side of every ordinary building, and none in front of a shutter. A pane that has gone is also gone from the chunk's cached data, so streaming the chunk back keeps it broken.
- **Cars.** The four found-car bodies no longer have solid dark slabs for glass: the shell is open and the windscreen, the rear window (a van has none) and the side windows either side of the pillar are panes on the car's visual (`carPanes`). `game/carGlass.ts` follows a bullet's line through the car (the collider is a box, so where it struck says nothing about the glass) to the first pane it crosses; a crash hurts the glass that faces it and barely touches the rest; a blast breaks the lot by distance; a burnt-out car loses every window. A beaten-up car comes with its screen already cracked. Broken glass stays broken when the car is put away (`BodySave.glass`), and a wrench job (**Cut and fit new glass**, two scrap, once the body is straight) puts it back.
- **What breaks it.** Bullets (a pistol round breaks a house window; a shop pane takes two close up and more at range; a windscreen takes two or three), blasts, a car at a walking pace or faster (its nose takes a pane out; its own glass may crack), a swing of a weapon (a swing also breaks the window of a car you stand beside; walls are left alone), and a crash.

Not done: glass does not deform with a crumpled body, zombies do not break it, scenery wrecks and the tier chassis (buggy, trucks) keep their painted glass, and the painted windows of upper floors in the city cannot be broken.

### Lakes, boats, islands and delves

**Lakes** (`world/lakes.ts`). Each wasteland leg plans two or three lakes beside the road. A lake is a basin carved into the heightfield (`heightAt` is `baseHeight` plus `lakeAdjust`), so the terrain mesh, the physics heightfield, the far landscape and the shore tint all agree. The water level is flat, the floor is three to six metres down, and the road corridor widens into a bay around it. `waterAt(def, x, z)` is the one query for "is there water here and how deep"; wheeled vehicles, boats, people and zombies all use it. Cities have no lakes.

**What stands in and around them** (`world/lakeSites.ts`): a pier with a boathouse, flotsam and one to three boats moored at it, and one to three islands (a castaway's shack, a wrecked trawler, a lighthouse, ruins, or a cave) with loot and guards. The first lake of each leg carries a cave island. Docks are axis-aligned deck colliders you can walk and drive onto; the beach to the deck is a step the character controller takes.

**Water on screen** (`render/water.ts`): a depth texture per lake drives the tint from shallow turquoise to deep blue, scrolling ripple normals come from the procedural noise, and foam lines the shore. The ground gets a wet-sand band at the waterline, and nothing grows on the lake bed.

**Boats** (`physics/boat.ts`, `data/boats.json`, `render/boatModels.ts`). A boat is a `Vehicle` with a `BoatBody` in place of the wheeled controller (both implement `Chassis`). The hull is a Rapier box held up by six buoyancy points (critically damped, with a gentle swell), pushed by a propeller that only bites while the stern is in the water, and steered by yaw rate. The **Scrap Skiff** (52 km/h) takes two and has the bed gun; the **Swamp Airboat** (78 km/h) pushes on air, so its fan keeps some way on over mud and sand. They use the convoy's fuel and are loud: noise carries across water. Controls are the driving ones: RT throttle, LT reverse, stick to steer, Y to climb in or out. Run a boat onto a beach and she stops hard; LT shoves her back toward the water. Leaving a boat at the dock steps you onto it; leaving it in deep water puts you over the side.

**Wheels in water** (`game/waterfx.ts`): shallows drag and spray, water past the axles drowns the engine ("Engine flooded"), a swamped vehicle floats and a current carries it toward the nearest shore, and the engine restarts a couple of seconds after it dries out.

**On foot**: wading slows you; deep water means swimming (slow, no sprint, no crouch, head above the surface). The dead will not follow into water deeper than a metre.

**Delves** (`world/delve.ts`, `world/delveSites.ts`, `game/delveScene.ts`). Four kinds of way underground, each a pure function of `(theme, seed, tier)`:

| Theme | Where | Layout |
|---|---|---|
| Cave | island mouths on lakes; cinder country | cellular-automata caverns |
| Mine | an adit in the dust wastelands | rooms joined by timbered corridors |
| Bunker | a hatch in the salt flats | rooms and corridors, armoury and security doors |
| Metro | a headhouse on the sidewalk of the city legs | a long platform hall and side rooms |

Each delve is generated on a 2 m grid: a sealed guardian room at the far end, a key you find on the near side (the generator retries until the door really does separate them), chests of tiered loot (`the hoard`, `the strongroom`, `the armoury`, `the vault`), dormant dead plus the odd raider sentry scaled by tier, and a service lift that runs once the guardian is down. You always have the way back up at the entrance.

Going down is a hold-A at the mouth and takes both players, on foot. The surface scene is kept alive but suspended (a share of the day still passes up there), and `DelveScene` runs on the same `Scene` base as the leg: same combat, noise, revives and loot rules. Underground the sky is off: light comes from your flashlights, flickering lamps, braziers and crystals, set by `GameRenderer.setInterior`. If both players go down the party is carried out a little poorer. What you took, killed and unlocked is remembered for the rest of the leg (`DelveRecord`).

Tests: `tests/lakes.test.ts` (planning, determinism, docks, island access, shore and bed surfaces), `tests/boat.test.ts` (floating, thrust, turning, braking, running aground, backing off a beach), `tests/delve.test.ts` (every theme and tier is connected, populated, sealable and wall-collided; the city metro headhouse), `tests/scene.test.ts` (a boarded boat on a real lake, swimming, vehicle flooding, going down a delve and coming back up).

### The open world

The old game was a chain of legs, each one road between cliffs. `legs.json` still has them (they are what `?leg=L1` and friends
load, and the authored city is built from one of them), but the campaign now starts on **`W`, The Open Country**, a leg with an
`open` block. Everything below is `world/openWorld.ts` plus `if (def.open)` branches in `world/terrain.ts`, `world/layout.ts` and the
renderer.

**Shape.** `TerrainDef.open` holds the bounds (x from -2300 to 2300, z from -1400 to 4300; mountains close it in, the same cliff and
crag code the corridors used, now at the edge of the map), a **road network** and the **districts**. `roadX(z)` is still the
highway, so the authored set pieces, power lines, billboards, jams and roadside sites that hang off it work unchanged; it is dead
straight and level through the city. Side roads (`kind: 'road'`, asphalt ribbons) cross at the two hubs and run to the corners.
Dirt tracks (`'track'`) have no mesh: the ground shader paints them, and `surfaceAt` says hardpan. Every road is indexed in a 32 m
grid, so `nearestRoad(x, z)` is cheap enough to call from `heightAt`, scatter and the map. Ground is dunes in patches
(`duneness(def, z, x)` is 2D here), long swells of hills standing back from the highway, flat beside every road, and flat
under every site (`Site.h` is the pad height; highway sites default to the road's own).

**Places.** Beyond the highway's own sites (`planSites`), `planOpenSites` rolls one candidate per 400 m square: hamlets, farms, depots,
motels, gas stops, mast hills and ways underground (mines, caves, bunkers), each with a winding dirt track to the nearest road, and
`planOpenLakes` does the same for lakes (no bays are cut: there are no walls to stand back). Three named places are built by hand-set
parameters in `legs.json`: **Dustwell Outpost** (a few hundred metres up from the start, hire only), **Rustgate Waypoint** (north of
the city, hire, trade, garage, a safe night) and **Haven**. Each is a walled compound of stacked shipping containers with a gate on the
highway side (`SiteBuilder.hub`). `LegLayoutImpl.buildOpen` fills the rest of the map with a 2D ambient pass (`openAmbient`: rocks, dead
trees, bones, scrap, the odd fuel can, wandering dead, one roll per 60 m square), oil cans and parts along the side roads, and **raider
camps**: about half of the far depots, motels, gas stops, farms and mast hills are an ambush that goes off when you come within 170 m,
from whichever side you arrive (`prepareAmbush` puts the raiders ahead of the lead vehicle's heading). They are one buggy stronger every
1200 m from the start.

**Petah Tikva.** The city is not a new map: `absorbDistrict` builds the authored `L3P` city leg on its own, slides it north by 640 m
(`shiftZ`), and merges its lots, streets, zones, cars, zombies, props and landmark buildings into the world. A `District` is a
chunk-aligned rectangle (about 512 m wide, 2.2 km long); chunks inside it (`ChunkData.city`) take the city's ground, boulevard,
sidewalks and facades, the ground inside it is level and eases back into the desert over 70 m, and `Landscape.buildDistrictFar` draws the
whole skyline from far away, one mesh per chunk, put away as the chunk streams in. The first block is about 400 m from where you start.
While the convoy is in the district `LegScene.cityMix` eases 0 to 1, which blends the day clock's two palettes and the fog
(`lightMix`) so the sky does not jump, and `biome` flips to `'city'` for the rules that care (Noise, wildlife, car rolls, camps).

**The day.** A leg scene is torn down for the night and built again at dawn, so what the world remembers lives in
`game/worldMemory.ts`: the sets of taken pickups, done encounters, shown tips, searched containers, broken barricades, spawned
chunks, delve records and finished ambushes, the car states and the living dead. The new scene adopts them (same `Set` objects) and
the layout itself is kept as the same object while the page is open. The Ledger saves the id sets and the camp position
(`Campaign.worldSave`), so Continue rolls out where the convoy slept; cars and zombies are not kept across a reload.

**Map.** The map button opens the whole country (baked at 12 m a pixel in slices, so it does not stall a frame), with the roads drawn
from `MapFrame.roads` and places showing once someone has been near them. The minimap draws only the roads that reach its view.

**Tests.** `tests/openworld.test.ts` (terrain, roads, district, layout), `tests/openplay.test.ts` (real scenes in Node: streaming far from
the highway, the city and the desert switching rules, calling the camp, rolling out with the world remembered, Haven, the save).

### Petah Tikva Center: an authored city

Leg 3 has a third road, **Petah Tikva Center** (`L3P`), which the open world also uses as its city: a recreation of the old centre of Petah Tikva, "Em HaMoshavot" (Mother of the Colonies). It is a city leg whose block grid is drawn by hand instead of rolled: `legs.json` names a `plan`, and `world/plans/petahTikva.ts` holds it (`world/cityPlan.ts` has the types). A plan keeps the usual skeleton (a boulevard down the middle, building columns either side, cross streets between blocks) so physics, zombies, camps and set pieces all keep working, and replaces the dice with fixed block lengths, strip widths, named streets and landmark lots.

What is on the map, driving north up Haim Ozer Street (the order is the real one: City Hall to the south, then the square, then the Red Line and the Central Bus Station, then the stadium):

- **Named streets**, each announced the first time you drive into it: Haim Ozer (the spine), Jabotinsky, Herzl, Stampfer, HaBaron Hirsch, Pinsker, Krol, Ze'ev Orlov, Ussishkin, Hovevei Zion, Rothschild and HaHistadrut. Cross streets and side streets are paved asphalt (`TerrainDef.streets` also makes them asphalt underfoot).
- **Founders' Square** (כיכר המייסדים): a paved level beside Haim Ozer and a raised lawn behind it, a fountain where the first well was dug, five founders' plaques, benches and dead trees, with an encounter, *The First Well*, at the pump.
- **The Great Synagogue** (בית הכנסת הגדול) across Hovevei Zion Street from the square: a long hall with a pitched tile roof, a cupola and a four-column portico.
- **City Hall**, drawn from a photograph: a tall square tower with bands of narrow windows and a lattice mast, a four-storey wing with an entrance canopy and a blue and yellow sign over it, and a six-storey wing with a colonnade, sun-shade ledges and air-conditioning units, round a tarmac car park with painted bays and parked cars that opens onto the street.
- **Shawarma Malabes** (שווארמה מלאבס), directly across the street from City Hall: a drawn shopfront (black sign band, two white-framed boards, the red kosher badge, flame-and-knives logos, an open front with the counter and spit) with tables and chairs out on the sidewalk and something to eat inside.
- **The Red Line** (`CityPlan.rail`): Jabotinsky Road is a wide cross street with the Tel Aviv light rail down the middle of it, drawn from `PlannedStreet` kinds `rail` and `platform`: a concrete slab with two tracks, an island platform with a canopy and a red name board (Hebrew over English) at **Petah Tikva Central Station** (the real end of the line, a buffer by Haim Ozer and the bus station), **Pinsker** and **Kiryat Arye**, masts every 26 m with contact and messenger wire, and a 36 m five-module tram (`tram` prop, white with a red band) standing at each end, solid but with room to walk round.
- **The Central Bus Station** (`busStation`): a five-storey terminal hall along Haim Ozer behind a tarmac forecourt of bus bays (`bus` and `busShelter` props, one livery per operator), a pilotis canopy, a green Hebrew sign over the doors and a glass hub tower beside it, with the commuters still waiting.
- **HaMoshava Stadium** (`stadium`): two long grandstands with the seating rake as stepped blue, white and red sectors (the tall one has a cantilever roof), two low end stands, striped pitch with lines and goals (`pitch` patch), four lattice floodlight masts, and a corner left open at each end as the way in. The real one is out by the Kiryat Arye station; here it stands where the line's last stop is.
- **The ordinary buildings** (`CityPlan.vernacular: 'israeli'`) are dressed as the real ones are: cream, sand and warm-white render; stacks of balconies with solid parapets, condensers and half-lowered roller shutters on the long walls; solar water heaters on the roof; and over the ground floors on Haim Ozer a Hebrew shop sign (`render/signs.ts`, drawn on a canvas, one material per distinct sign, merged per chunk).

What is real and what is not: the street names, the order along the spine (City Hall, Founders' Square, the Red Line, the bus station), that the Red Line ends at the Central Bus Station on Orlov Street and passes Pinsker and Krol, that HaMoshava Stadium stands by Kiryat Arye station, which streets bound Founders' Square, what the square contains, that the Great Synagogue is on Hovevei Zion Street and City Hall on Haim Ozer Street, and the shape of City Hall and of the shop's front, come from published descriptions and photographs. Which side of the spine things are on, every distance, block depth and building height, and the straightening of the real street pattern onto one spine are invented to fit the engine. It is a recreation in the spirit of a game level, not a survey; the tables in `petahTikva.ts` are meant to be redrawn.

**Shopfront art.** `render/shopFront.ts` draws the shop's front on a canvas at load time, like every other texture here. It is a redraw from a photograph, with the phone numbers left off. To use a real image instead, save it as `public/shops/malabes.png` (the whole panel, 14 m by 4.8 m, so 70:24, with transparency above the sign band if wanted): it replaces the drawing once it has loaded, and with no file there the drawing stays.

## Smoothness

The world streams in chunks of 128 m, and a whole chunk costs 10 to 25 ms to make, which is a dropped frame. So nothing is made in one go
while playing. A chunk is built in slices: its data (heights a few columns at a time), then its ground mesh and colliders, then roads,
buildings, props and ground cover, each a few milliseconds (`ChunkSource.step`, `ChunkView` with `staged: true`, `LegScene.streamWork`).
A tick starts chunk work only while it is inside a small time budget (4 ms for the look-ahead, 10 ms when a chunk next to a player is
missing), nearest first, and the ground mesh tells the far landscape to step aside only once it exists. Found cars are paced the same way:
at most one comes into the world per pass, and its model is built in slices before it spawns (`prepareVehicleVisual`). Driving fast across the
open world went from about thirty over-16 ms ticks a minute to two or three. The camera reuses its scratch vectors so it makes no garbage per frame.
`tests/streaming.test.ts` pins that stepped and whole builds are identical, that a tick does a bounded amount of work, and that the ground is
under the convoy within a few ticks of a jump.

Driving feel: the wheel returns to centre faster than it turns in, and the handbrake is a controlled slide (rear grip is cut, the yaw rate is capped,
sideways speed bleeds off and the car swings back to where it is going) instead of a spin. `tests/vehicle.test.ts` covers the handbrake turn on all three tiers.

## Rendering

Everything on screen is generated in code at load time: no meshes, images or audio files ship with the game.

- **Pipeline**: both views render into one multisampled half-float target, then a bloom mip chain and a composite pass
  (ACES tone mapping, colour grading, a per-half vignette and film grain) draw to the canvas. Every post pass clamps its taps
  to the half a pixel belongs to, so one player's muzzle flash never glows into the other's view. The Low preset skips the
  post chain and draws straight to the canvas.
- **Light**: an analytic sky (sun glow, drifting clouds, stars and a moon) is captured into a cube map every second or so and
  prefiltered into the scene environment, so every surface is lit by, and reflects, the sky the player sees. three's fog
  chunks are replaced with distance fog plus a ground-hugging haze that scatters toward the sun (`render/atmosphere.ts`).
- **Materials**: models use one physically based "kit" material. Each vertex carries roughness, metalness, wear and emissive
  values, so a whole vehicle stays one draw call while mixing paint, bare steel, rubber and glass. Wear adds grime, rust and
  streaks from a triplanar map, and a detail normal map adds dents (`render/materials.ts`, `render/builder.ts`).
- **Textures** (`render/proctex.ts`): tileable gradient noise, Voronoi cells and normal maps, built on the CPU at load
  (about half a second): wind-rippled sand, cracked hardpan, bedded sandstone and gravel for the ground, a road with cracks,
  tar seal, patches and worn paint, plus grime, grass and smoke sprites.
- **Ground**: a 2 m heightfield per chunk. A splat shader blends the four ground materials by per-vertex weights sharpened with
  their own height maps. Cliff faces get visual-only crags, bulges and boulders where no wheel can reach (a test guards this),
  and a coarse far-terrain mesh with mountain relief steps aside wherever a detailed chunk is loaded. Instanced grass, sage
  bushes and pebbles sway in a shared wind and fade with distance.
- **City**: facades are drawn per pixel (concrete panel, brick, stucco or curtain wall), with interior-mapped rooms behind the
  glass, boarded and broken windows, soot, rain streaks, a shopfront band with roller shutters and signs, and rooms lit at
  night. Geometry adds ledges, cornices, parapets, rooftop plant, water towers, awnings, fire escapes and kerbed sidewalks; a
  skyline of towers stands beyond the corridor.
- **Models**: vehicles have lathed tyres with tread, rims, hubs, coil-over suspension, riveted armour, glowing lamps and
  strapped cargo; survivors and raiders have jointed elbows and knees and full kit; zombies are one instanced mesh with a
  two-joint walk, per-instance clothing and skin palettes, and inflated brutes and bloaters.

`window.__game.setPhoto({ pos, look, fov })` frames one full-screen shot from a fixed camera (pass `null` to return to the
split screen), which is how the model and scene checks were done.

## What is not in the slice

Per the blueprint's cut order and scope plan, these are Beta or Final work and are not built yet:

- Tier 4 and 5 vehicles (the data and physics parameters exist, the models, turret, plow, docking and flamethrowers do not). The Tier 3 buggy is still the top of the rebuild chain; found cars and fitted parts are how everything else grows
- The Scout, Scavenger and Heavy Vanguard (their data and hiring rows exist and are disabled)
- Legs 4 to 14, Waypoints beyond Rustgate, run modifiers, other weather than dust storms
- Rebinding the analog sticks, and a per-pad (rather than shared) gamepad scheme
- Localization beyond English, and WebGPU

The slice ends at **Haven**, at the north end of the highway, with a summary and a hint about which ending your choices lean toward. All
five endings are implemented and unit tested in `sim/endings.ts`. Beyond the slice, the open world has room for more regions
(salt and cinder ground themes exist but the map is one theme for now), more hubs and a real threat curve by region.

## Tests

`npm test` runs the data validation, loyalty bands, resource ledger and loot cuts, Signature grid, raid threat and wave
planning, ending selection, day clock, damage model, vehicle handling (acceleration, braking, turning, ride height and a
stability regression), world generation (determinism, seams, passages, barricades, set pieces), game logic (obstacle index,
campaign save round trip, input helpers, camera FOV) and rendering helpers (visual terrain detail stays out of the drivable
corridor, mesh builder attributes, procedural noise). Lakes, boats and delves have theirs (see their section above), and so does the authored city: `tests/petahtikva.test.ts` (the plan lays out and names its streets, Founders' Square, the Great Synagogue, City Hall and the shop stand where the plan says on the streets it says, the real south-to-north order, the Red Line's slab, platforms, trams and stations, the bus station and the stadium, shop signs, streets are paved and open, everything on the route is reachable by flood fill, places are announced once). The car system has its own suites: `tests/garage.test.ts` (parts, stats, fitting, repair, salvage, world-car rolls), `tests/engines.test.ts` (the engine catalogue, every engine in every chassis, bays, petrol and diesel, radiators, heat, hot rods, saves), `tests/engineplay.test.ts` (real leg scenes: attach points and reach, wrong-fuel starts and draining, overheating under load, diesel cans, spray cans, stripping a car), `tests/paint.test.ts` (panel paint rules and the recoloured geometry), `tests/garageui.test.ts` (the garage view, grouped mounts, per-wheel tyres, water and oil, and swap forecasts with a fake host), `tests/wave2.test.ts` (gearbox strain, brakes, springs, exhaust, per-wheel tyres, removable doors and bonnet, sump and water volumes), `tests/wave2play.test.ts` (real leg scenes: a tyre on one wheel, the crowbar prying a door or bonnet, a V8 drinking more fuel, oil and water, water cans), `tests/wave2render.test.ts` (bare rims, missing panels, exposed engine, exhaust and spring kits, carry models), `tests/cars.test.ts` (Rapier handling of each found chassis, and that the model sits on the ground) `tests/carplay.test.ts` (real leg scenes in Node: streaming, claiming, repairing with held buttons, stripping, siphoning, saving the fleet), `tests/oil.test.ts` (the oil model, planning a fit or stow, old saves) and `tests/haul.test.ts` (real leg scenes: lifting, bolting on, pouring, stowing, dropping, driving over loose items without taking them, taking goods by hand, running dry). Bodywork has `tests/bodywork.test.ts` (the crash, joint, dirt and mark rules, the part tags in every model, the lattice: where it folds, normals, caps, slicing, extracting and hiding a part, replaying saved dents, lamps carried along, the dirt shader hooks, the track buffer) and `tests/bodywork-scene.test.ts` (real leg scenes: a wall crash dents the nose where it hit, a gentle bump does not, a bull bar tears off and can be lifted, two-sided modules, doors, mirrors working loose first, wrecks, spare wheels that roll, bullet and blast dents, debris as an obstacle, parts stowed or kept as pickups, save round trips, hammering and welding, mud, blood, tyre marks, and the open world remembering the road overnight). Dust storms have `tests/weather.test.ts` (the day's window is fixed by seed and day, level shape, what a storm does to raiders' sight, oil burn and the map, and a real leg building and clearing a storm). Personal gear has `tests/gear.test.ts` and `tests/gearplay.test.ts` (see its section above).

Training has `tests/tutorial.test.ts`: a real open-world scene in Node walked through all twelve lessons with real held buttons and sticks (walking, sprinting, a jump, aiming and firing, taking goods and searching a crate, climbing into the moped, driving, the horn, getting out, repairing with the wrench, lifting and pouring a fuel can, the map, the pack and making camp), plus solo play, skipping, the key names in lesson text, and that nobody can bleed out.

The page also exposes `window.__game` with `advance(seconds)` for running the simulation deterministically from the console,
which is how most of the in-browser checks were done.
