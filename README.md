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
npm test             # about 400 unit and simulation tests (Vitest)
```

Chrome or Edge are the reference browsers. Gamepads are only exposed to secure contexts, so use `localhost`, `127.0.0.1`
or HTTPS. Add `?debug` to the URL for a frame-time and draw-call readout and data validation at boot.

## Play

Plug in two Xbox-layout pads and press **A** to join, or share the keyboard. Anyone can press **Start** to begin. A seat
without a pad falls back to the keyboard, so you can also play on one keyboard (Player 1 on the left side, Player 2 on the
right).

### The loop

Each leg runs the same five steps, and every decision is shared:

1. **Dawn Ledger** (shared clipboard, two coloured cursors): repair, rebuild a vehicle into the next tier, upgrade five
   module slots, craft ammo and gear, hire crew, pay or short their loot cut, then pick the next road.
2. **Route choice**: two roads per junction, a wasteland road (fuel, parts, ambushes) or a city road (tech, medicine, hordes).
3. **Travel**: drive the road, dismount at scavenge zones, handle ambushes and the Roadside Encounters.
4. **Dusk Bell**: a visible clock. Reach the end of the road, then vote on a camp site and hot or cold camp.
5. **Camp**: three minutes to build defenses, then a three-wave night raid. Dawn leads straight back to the Ledger.

### Rules worth knowing

- **Signature** is the one aggro rule. Engines are **Noise** (heard by the infected in cities) and **Dust** (seen by raiders on
  the road). The meter in the top-left shows your current level. Horns, gunshots, sprinting and night headlights make it worse.
  Parking and walking is quiet.
- **Shared stocks**: Fuel, Rations, Scrap, Parts, Tech, Medicine. Fuel and Rations are one pool for both players.
- **Tether**: stay within about 300 m of your partner. The trailing player gets a slipstream bonus; the leader slows when the
  gap grows.
- **Downed, not dead**: at 0 HP you crawl for 20 s. Your partner can revive you (hold A, faster with a medkit). The run ends
  only when both of you are down, or the last vehicle is lost.
- **Crew** have a Loyalty meter and a loot cut that is withheld from every pickup. Betrayal is telegraphed by two radio
  warnings and a camp dispute before anyone deserts.
- **Roadside Encounters** are decided by both players voting in their own half. If you disagree the Encounter Lead decides, and
  overriding your partner costs a point of Trust. Three hidden axes (Mercy, Trust, Notoriety) decide the ending.

### Solo or split screen

The title screen has a **Players** switch: `2 · SPLIT SCREEN` (the default) or `1 · SOLO`. Solo gives you one scavenger,
one vehicle and the whole screen. Press A on a pad, or `F` (WASD) or `Right Shift` (arrows) on the keyboard, to take the seat.
The choice is remembered, and a run keeps the mode it started in: Continue loads a solo save as solo.

What changes when you are alone: there is no partner, so no tether, no revives and no votes. The one vote is yours, with no
Lead or Trust override. A downed player can hold `A` to use a convoy Medkit on themselves; without one, bleeding out ends
the run (there is nobody to revive you, so the "you both went down" rule becomes "you went down and could not get up").
The garage and Ledger show one vehicle, and Settings drops the Player 2 and split-screen rows.

### Controls

| | On foot | Driving | Gunner (Tier 3 bed) | Camp build |
|---|---|---|---|---|
| Left stick | Move | Steer | | Move |
| Right stick | Aim / look | Free look | Aim gun | Aim reticle |
| RT / LT | Fire / aim | Throttle / brake | Fire / zoom | Place / remove |
| RB | Tap melee, hold takedown | Fire front gun | Fire | Next element |
| LB | Swap tool | | | Previous element |
| A | Interact (hold: loot, repair, refuel, revive) | Handbrake | | Rotate |
| B | Crouch | Tap lights, hold engine off | | Hold: ready for night |
| X | Reload (hold: swap utility) | Tap horn, hold siren | | Assign watch post |
| Y | Tap: switch first / third person. Hold: enter a vehicle | Tap: switch view. Hold: exit, or bail at speed | Tap: switch view. Hold: exit | |
| D-pad ↑ | Tap ping, hold command wheel | | | |
| D-pad ↓ | Tap map: closer look, whole leg, close | Same | Same | Same |
| L3 / R3 | Sprint / reset camera | Camera distance / look back | | |
| Start / Back | Pause / hold for convoy sheet | | | |

**First and third person**: tap **Y** on a pad to switch the camera between the chase view and the eyes. It works on foot (the
camera sits at head height, you see your arms and what they hold), in the driver's seat (the camera is the driver's head: the
right stick or the mouse looks around and springs back to the road) and at a bed gun or passenger seat. Each player has their
own view, so one can drive from the cab while the other watches the road from behind. The choice is remembered. On a pad, view
and the vehicle action share Y: a quick tap switches the view, holding it (about a third of a second) gets you in or out, and
the prompt says *Hold*. Rebind either one and the share goes away. On the keyboard the view keys are `B` (Player 1) and `P`
(Player 2), and the middle mouse button.

**Keyboard**: solo play can use either layout below. Player 1 uses `W A S D` to move, `Q E` to aim, `F` to fire, `G` to interact, `R` for vehicles, `C` for
crouch and lights, `Shift` for sprint and handbrake, `Tab` for the command wheel, `V` to swap tools, `T` to reload or
honk, `Z X` to cycle build elements, `J` for the map, hold `Space` for the convoy sheet. Player 2 uses the arrow keys, `[ ]` to aim, `Right
Shift` to fire, `/` to interact, `Enter` for vehicles, `.` for crouch and lights, `Right Ctrl` for sprint and handbrake,
`Backspace` for the wheel, `N` to swap tools, `,` to reload, `; '` to cycle build elements, `K` for the map, hold `\` for the convoy sheet. Keyboard players get stronger
aim assist. `Esc` pauses.

**Map and minimap**: each half has a round minimap under the clock, turned so up is where your camera looks and zoomed
out as you speed up. It shows the road, the ground, both convoys and the places worth a trip: camp, Encounters, scavenge
zones, roadside places, docks, ways underground, parked rides of yours, mined ground and any pings. Targets that are out of
range stay on the rim as small markers so the way to them is never lost. The dead appear on it only once they are chasing and
raiders only once they are on the road, so a map never gives away a sleeping horde. Tap the map button (D-pad down, `J` or
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
  sim/       pure rules with no engine imports: resources, loyalty, signature grid, raid threat, endings, damage, day clock
  physics/   Rapier world wrapper and the data-driven raycast vehicle controller
  world/     deterministic terrain, leg layout (city grid, set pieces) and per-chunk content
  render/    renderer and HDR post chain, sky and atmosphere, materials and procedural textures, terrain and road shaders,
             facades, chunk meshes, far landscape, ground cover, models (vehicles, people, zombies, props), particles, camera
  game/      scene runtime, entities (player, vehicle, zombies, raiders, crew), combat, leg scene, camp scene, game loop
  ui/        HUD, shared-cursor focus UI, overlays (title, votes, report), the Dawn Ledger, styles
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

### Cars, parts and the garage

Every car standing in the world is a real vehicle. Hatchbacks, sedans, pickups and vans (`vehicles.json` `cars`) are streamed in as the convoy approaches and put away, with their state, once it moves on (`game/cars.ts`). Each car rolls its condition from its seed: a **burnt-out hulk** (strip it for parts), a **rough runner** with at least two real faults (flat tyres, a seized engine, a leaking tank), or one **sound enough to drive**. Roadside wastelands also have stalled-traffic jams on the shoulder, and city boulevards are full of them.

- **Take any car.** Walk up and press Y. Climbing into an abandoned car claims it for the convoy and adds it to the **yard** (six vehicles). Whatever you drove last rolls out with you. A second player can ride along as passenger, or as bed gunner in a pickup with a gun mount.
- **Repair is real work.** With the wrench, hold A: the most urgent fault is fixed in turn (fire, leak, tyre, engine, weapon mount, bodywork). Each job names its cost, such as a tyre patch for 2 Scrap or an engine rebuild for 3 Parts. With no Parts, an improvised Scrap job still works so nobody is stranded. A convoy engine below 10% will not start until rebuilt.
- **Strip what you can't drive.** With the crowbar, hold A on a hulk or an abandoned car to take four stages: tyres, engine, bodywork, cabin and trunk. Raider wrecks carry better kit. The loot is fixed by the car's seed, so leaving and coming back can't reroll it. The jerrycan siphons fuel from abandoned tanks into the convoy reserve.
- **Parts are items** (`data/parts.json`, `sim/parts.ts`): 27 of them across nine slots (engine, tyres, armour, weapon mount, fuel and cargo, plus front, roof, rear and side mounts), in three qualities with a wear value. An engine, tyre set or armour kit replaces a damaged component, so swapping in a good one repairs it. Parts turn up in salvage, in yards and settlements, beside parts wrecks, and can be fabricated at camp.
- **Carry things by hand.** Loose parts, fuel cans and oil cans lie along the road, in settlements, gas stops and beside wrecks. On foot, hold A to lift one (you walk slower, can't sprint, and your gun and tools are out of reach). At one of your own vehicles, **A** puts it straight on (bolt the part on, pour the fuel in, top the oil up) and **X** stows it in the trunk for later; **X** anywhere else sets it down. Climbing in with full hands stows the load, or sets it beside the car if the trunk is full. Driving over a part or an oil can sweeps it into the trunk automatically, and leaves it where it lies if there is no room. Spare fuel, oil and crates of spare parts are visible, strapped to the boot, bed, roof or carrier (`render/cargoLoad.ts`). Code: `sim/carry.ts` (what a fit or stow does), `game/hauling.ts` (the input, prompts and carried-item state on `Player`), `LegScene` (`loose`: lifting, dropping and driving-over).
- **Engines burn oil.** Every convoy engine has a sump (`comp.oil`, 0 to 1; `sim/oil.ts`): a full one lasts about 14 km at baseline Drain, a shot-up engine bleeds it, and a worn engine burns it faster. Below 25% the engine loses power; run dry and it wrecks itself until it seizes. Cans (half a sump each) come from the roadside, settlements, and from draining an engine with the crowbar. Top up from a can in your hands, from the convoy's reserve with the jerrycan tool, or with the **Top up oil** button in the garage and workbench. A full service and an engine rebuild both put fresh oil in.
- **Fit them anywhere.** At camp the Ledger has a **Garage** tab with both players' vehicles live in side strips: fit and remove parts, fabricate, paint (twelve colours, stripes), service, assign who rolls out in what, or break a spare vehicle down. Mid-leg, wrench + X opens the **workbench** for one of your own vehicles (fitting only). Every part is visible on the model: bull bars, dozer blades, roof racks, light bars, spare wheels, side plates, fuel cans, fixed or bed-mounted guns.
- **Parts change driving.** Power, top speed, grip, suspension, off-road ability (a road car loses far more speed in sand than a buggy), armour by side, fuel capacity and burn, noise, zombie plough width, ram damage and headlight reach all come from what is fitted. Cargo space sets how many spare parts the convoy can carry.

The moped to quad to buggy chain is still the guaranteed path (rebuild at a Waypoint garage). Found cars are a faster, luckier one, with their own strengths: hatchbacks are light and quick, sedans fast and fragile off the road, pickups sturdy with a bed for a gun, vans carry the most.

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
- Legs 4 to 14, Waypoints beyond Rustgate, run modifiers, dust storms, walk-in building interiors
- Rebinding the analog sticks, and a per-pad (rather than shared) gamepad scheme
- Localization beyond English, and WebGPU

The campaign ends at **Rustgate** after three legs, with a summary and a hint about which ending your choices lean toward. All
five endings are implemented and unit tested in `sim/endings.ts`.

## Tests

`npm test` runs the data validation, loyalty bands, resource ledger and loot cuts, Signature grid, raid threat and wave
planning, ending selection, day clock, damage model, vehicle handling (acceleration, braking, turning, ride height and a
stability regression), world generation (determinism, seams, passages, barricades, set pieces), game logic (obstacle index,
campaign save round trip, input helpers, camera FOV) and rendering helpers (visual terrain detail stays out of the drivable
corridor, mesh builder attributes, procedural noise). Lakes, boats and delves have theirs (see their section above). The car system has its own suites: `tests/garage.test.ts` (parts, stats, fitting, repair, salvage, world-car rolls), `tests/cars.test.ts` (Rapier handling of each found chassis, and that the model sits on the ground) `tests/carplay.test.ts` (real leg scenes in Node: streaming, claiming, repairing with held buttons, stripping, siphoning, saving the fleet), `tests/oil.test.ts` (the oil model, planning a fit or stow, old saves) and `tests/haul.test.ts` (real leg scenes: lifting, bolting on, pouring, stowing, dropping, driving over loose items, running dry).

The page also exposes `window.__game` with `advance(seconds)` for running the simulation deterministically from the console,
which is how most of the in-browser checks were done.
