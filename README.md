# Iron Nomad: Road to Haven

A shared-screen survival-convoy game for the browser, for two players or one. Two scavengers (any two of Chinsky, Leo and Nar Divad, or one of them alone) start on matching 50cc scrap mopeds and
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
npm test             # about 1550 unit and simulation tests (Vitest)
```

`?training` starts the training lessons (see [Learning the game](#learning-the-game)). `?leg=W` starts a fresh run in the open world (it is what New Convoy does). Any other leg id (`?leg=L3P`, `?leg=L2C`...) starts a fresh run
straight on one of the older single-road legs, which is how a map is checked without playing up to it.

Chrome or Edge are the reference browsers. Gamepads are only exposed to secure contexts, so use `localhost`, `127.0.0.1`
or HTTPS. Add `?debug` to the URL for a frame-time and draw-call readout and data validation at boot.

### Performance and audio packaging

The game plays compact Opus versions of the WAV recordings: 64 kb/s VBR for mono, 128 kb/s for stereo. The current 265
derivatives total 8.54 MB instead of 74.65 MB of WAVs. Existing compressed foley stays in its original format. Originals
and recording credits remain in `public/audio` for editing; the production build excludes the replaced WAVs.
These are lossy audio derivatives; visual quality settings,
effect capacities and simulation rates are unchanged.

Run `npm run pack:audio` after adding or editing a WAV (requires `ffmpeg` and `ffprobe`). It reuses unchanged encodes,
checks decoded duration and channel count, and writes `src/audio/packedRecordings.json` plus derivative checksums
and original-file attribution in `public/audio/packed/sources.json`. Ordinary builds need no encoder. Builds reject
stale or damaged derivatives instead of shipping audio that no longer matches the source. Web Audio decodes each
recording once; playback reuses both the decoded buffers and cached take banks, including the anti-repeat decks.

Particle and tracer pools update live slots and upload changed buffer ranges. Their GPU slot order stays stable, so
smoke blending stays the same; idle pools submit no vertices. Terrain queries use a spatial index of building
foundations, updated as settlements append pads, while retaining the same overlap order and height calculations.
`tests/performance.test.ts` checks retirement, recycling, pending uploads, boundary lookups and exact terrain heights.

Tree batches share the original vertex buffers but index only their selected variant, instead of submitting all three
variants and rejecting two in the shader. Models, wind, leaf alpha tests, shadows, collision meshes and impostor fades
stay the same. A balanced mix submits 66.7% fewer tree triangles. Far props share prototypes across 256 m regions,
allowing each view to cull unseen regions; bounds include the maximum trip-breath displacement.

Immutable scenery caches its local transform. Animated descendants and per-view visibility still update normally.
Moving-body motion is sampled once for all vegetation chunks, convex radii are cached by shape identity, and sleeping
fallen trees stop rewriting saved poses and uploading instance matrices until they wake. Changed instances upload
only their own matrix/color ranges. Streaming shares its 4 ms calm / 10 ms urgent allowance across a browser frame's
catch-up ticks, with one indivisible build slice allowed to finish. Headless standalone ticks keep independent budgets.
Adaptive resolution retains the existing levels and limits, with 250 ms settling when reducing and 500 ms when recovering,
so GPU render targets cannot be recreated on consecutive frames.

Sight queries walk only grid cells crossed by the segment, with early exit for blocked/not-blocked checks. Sparse hearing
queries scan occupied cells when that costs less than the original grid window. Both retain exact hit/source selection,
including ties, glass, terrain height and indoor hearing rules. Character rendering scores distance once per candidate
and uses a reusable bounded heap to select the same nearest visible actors in the same order, across either one or two
cameras. Separation buckets and visibility scratch arrays are recycled between frames.

Zombie, animal and ambient-life batches upload only the active attribute prefix, keeping pending writes until the GPU
consumes them. A 12-zombie batch uploads 98% less instance data than its 600-slot capacity. Track marks upload two small
spans when their ring buffer wraps instead of rewriting all 7,000 segments; wheel-edge scratch buffers are reused.
These changes retain the existing draw limits, models, animation data and simulation rates.

Ground-cover batches cache their instance-root bounds and skip submission separately for each camera when every root is
beyond the shader's existing full-fade distance. Shadow casters and batches with moving roots retain their original
visibility. This removes triangles that the unchanged shader would already collapse to points; it keeps the original
density, fade distances, bending, wind and instance order. Flexible plants share one immutable geometry snapshot per
batch and create their scaled contact mesh only on the first nearby contact or ray query, then reuse it as before.
`tests/renderEfficiency.test.ts` checks transformed bounds, both cameras, fade boundaries, shadow/moving-root fallbacks,
and exact original collision vertices with native Rapier sensors.

The development-only `/tools/scatter-performance.html` comparison uses 19,600 grass instances in 49 batches and checks
single screen and both split orientations at three wind times. All nine comparisons matched pixels exactly. Its
top/bottom workload submitted 158,404 / 33,604 triangles. Two interleaved comparisons measured 1.23 / 0.59 ms and
0.43 / 0.17 ms GPU time (52–60% less); CPU submission in the final comparison was 0.60 / 0.40 ms. These are isolated
ground-cover measurements, not whole-game FPS gains. Start `npm run dev` to repeat it.

Production Standard A/B runs at 1280×720 and 1.4875 render pixels per CSS pixel showed effectively unchanged whole-game
average FPS in the final pair: case differences ranged from −1.68% to +1.71%. Earlier identical controls varied substantially.
These opening routes showed little ground-cover triangle reduction; the dense-vegetation comparison above measures that
workload separately. `output/render-efficiency-comparison-2026-10-07.json` retains every run and the measurement limits.

The engine CPU benchmark measured 128 city sight queries at 2.49 / 0.20 ms (12.6×), 800 hearing queries with 13 emitters
at 1.43 / 0.15 ms (9.5×), and selecting 160 characters from 3,000 candidates for two views at 0.47 / 0.032 ms (14.9×).
Those ratios apply to these isolated workloads, not whole-game FPS. `tests/engineEfficiency.test.ts` compares optimized
queries and actual render selection against the original algorithms, and checks pending uploads and ring-buffer wraps.

Production builds externalize Rapier's byte-identical WASM binary, checked against the embedded copy before packaging.
The measured JavaScript total fell from 7.26 MB to 3.16 MB, plus a separately cached 3.08 MB WASM asset: about 1.03 MB less
total output and 0.44 MB less gzip transfer. Development and Node physics tests retain the unmodified compatibility package.

Use `npm run bench:performance` for repeatable CPU subsystem comparisons. A 10,000-node, two-view transform benchmark
measured about 1.24 ms before / 0.16 ms after. The development-only `tools/render-performance.html` page compares the
original and variant tree batches, including shadows, pixels at several wind times, and asynchronous GPU timer queries
when supported. One 108-tree comparison submitted 132,936 / 44,312 triangles and measured 0.81 / 0.60 ms GPU time;
CPU submission was 0.20 / 0.30 ms because variant batching adds draw calls. Two wind times matched pixels exactly;
the initial comparison differed at one pixel. These are subsystem measurements, not whole-game FPS gains.
Start `npm run dev`, then open `/tools/render-performance.html` on that server to repeat the rendering check.
`?debug` now shows simulation/render CPU times and frame-wide draw/triangle totals, including shadows, both views,
environment captures and post-processing. CPU submission time does not measure GPU execution.

The opening screen's **Benchmark** button runs desert driving, open-country streaming, dense city streets, and night
crowds with smoke/glow effects. Every scenario runs with one player, two players split top/bottom, and two players split
left/right. Quick runs warm up for 1 second and measure for 3 seconds per case; Standard runs use 3 and 8 seconds.
Scene construction and warm-up frames are excluded. The selected graphics preset stays in effect, with adaptive
resolution held at scale 1 throughout so a slower case cannot compensate by drawing fewer pixels. Audio is muted.

Results show elapsed-time FPS, the slowest 1% average FPS, 95th-percentile frame time, simulation and render-submission
CPU times, and whole-frame draw/triangle counts. **Download results** exports JSON with settings, viewport, browser,
sample counts, 99th-percentile timings, frames over 33.3 ms, and discarded simulation steps. Display refresh and browser
frame pacing can cap FPS; CPU submission is not GPU timing. The benchmark uses isolated campaigns with seed 4242;
normal gameplay includes unseeded cosmetic randomness. It never writes saves or settings. Cancel with Esc, the on-screen
button or the controller's cancel action. Hidden tabs restart the interrupted case after returning; changing window size
or losing the graphics context cancels the run. Player mode, split orientation, joined devices, volume and render scale
return afterwards. The last completed result remains available in the Benchmark panel until the page reloads.

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
- **Heat waves and warnings**: from the third day, about one storm-free day in four is a scorcher. The clock line says `HEAT BUILDING` or `HEAT WAVE`, the heat peaks around noon and eases before the Dusk Bell, and every radiator sheds about a fifth less heat at the peak, so a build that runs warm can cook (`sim/weather.ts`, fixed by seed and day like the storms). The radio now calls a dust wall a few minutes before the first gust, gives a heads-up shortly before the Dusk Bell so you can pick a camp, and warns a driver whose tank is nearly dry. A night raid also carries whatever a wave could not spend into the next one, so the night's size tracks its threat.
- **Hunting**: game has to notice you (sight, hearing and scent on the wind), so stalk it crouched, from cover and from downwind. A kill leaves a carcass. Hold A on it to butcher: meat becomes Rations and game with a coat also gives hides for the Ledger. Carcasses keep for a minute. See [Hunting](#hunting-stalking-shot-placement-and-tracking). Everyone eats supper from the Rations at camp unless they are already full (see [Eat, drink, piss, shit](#eat-drink-piss-shit)); whoever goes unfed wakes at 65% health.
- **Shared stocks**: Fuel, Rations, Scrap, Parts, Tech, Medicine. Fuel and Rations are one pool for both players.
- **Tether**: stay within about 300 m of your partner. The trailing player gets a slipstream bonus; the leader slows when the
  gap grows.
- **Downed, not dead**: at 0 HP you crawl for 20 s. Your partner can revive you (hold A, faster with a medkit). The run ends
  only when both of you are down, or the last vehicle is lost.
- **Gear**: you wear, hold and carry a personal kit. Armour, masks and boots change what hurts you; guns, melee weapons and tools sit on a four-slot belt (LB swaps); the bag holds the rest. D-pad ← (or `3` / `I`) opens the inventory.
- **Wind, wounds and wear**: sprinting, jumping and swinging spend **stamina** (the thin blue bar under your health, shown only while it is low). Run it dry and you are *winded*: no sprint, a slower walk, weaker and slower swings, a shakier aim, until a third has come back. Bites, blades and bullets can open a **wound** (up to three at once; armour turns some away). Each drains health until it clots on its own after about 15 s or is bound, and bleeding alone never kills: it leaves you at 1 HP. **Bandages** (3 for 3 Scrap at the Ledger, also found in bunkers) bind every wound and mend 8; a **Medkit** binds and heals 60. Both sit first on the quick belt (hold the use button, lean to choose, tap to use) and busy your hands for under a second and a bit over one, so dressing a wound mid-fight costs you a shot. Weapons **wear** with use: found ones are already worn (a bar on the tile in the inventory, and a label on the HUD when low). Below 60% a gun wanders and a blade dulls; any gun can now and then **misfire**, more often as it wears and often below 30%, where real jams (stovepipes, double feeds, stuck cases) take over; the hands clear each the way its action needs (see *The hands keep busy* below). **Repair** it from the inventory for Scrap, sort the bag with **Sort**, and see rounds, dressings and health at a glance under the bag.
- **Eat, drink, piss, shit**: every scavenger has a belly, a water level, a bladder and bowels. On a pad they are four more slots at the end of the quick belt (hold D-pad ↓, lean to choose, tap); on the keyboard each has its own rebindable key (`5 6 7 8` for Player 1, `9 0 - =` for Player 2). Eating spends a Ration, drinking spends litres from the water reserve (or is free at a lake), and the other two take a few seconds standing still. Ignore them and your aim, wind and walk suffer. Nothing ever happens on its own: a full bladder just nags.
- **Foraging**: wild figs, blackberries, prickly pears, za'atar, yarrow and mushrooms grow in the open world. Hold A at one: hungry, you eat it on the spot; fed, it goes in the stores. Wear gloves in the thorns, carry a blade for herbs, and never eat a mushroom you don't know when a death cap looks much the same.
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

### Chinsky, Leo and Nar Divad

The scavengers are real people (`data/heroes.ts`): **Chinsky** (1.72 m, 80 kg) takes the left seat, Player 1, and **Leo**
(1.80 m, 66 kg) the right, Player 2. A solo run is Leo's. **Nar Divad** (1.75 m, 82 kg) is the third: the name under each
seat on the title screen steps through all three (in split screen it passes over whoever has the other seat, so nobody is
seated twice). The seat colours stay with the seat (Player 1 orange, Player 2 blue), so a solo hero wears Player 1's orange.

Each is drawn as themselves wherever they appear, on foot and in any vehicle's seat: their own face, hair and build, at
their real height (the rig is scaled to it) and as broad as their weight makes them. With nothing over the body they wear
their own clothes (Chinsky a black knit cardigan over a grey T-shirt, Leo a navy T-shirt, Nar a pale mint T-shirt with a big
dark print down its right side and a dark cord round his neck). They set out bareheaded with
the starter helmet in the bag, and wear the starter bandana down round the neck, so their faces are seen; put the helmet on
in the inventory and the hair flattens under it. Saves from before carry over: each seat becomes whoever plays it now.

Nar's head was measured off a selfie the same way as the others: a broad, ruddy face in a wide open grin (his top teeth
show: the portrait mouth takes an optional `teeth` colour for the gap between parted lips), brown eyes narrowed by it, big
ears, salt-and-pepper hair brushed up and back, and a full short beard that is dark through the moustache and the middle of
the chin and greys along the jaw (`salt` on a full beard sets the grey share in the middle and at the sides, mixed hair by
hair).

**Poses at rest.** Besides standing, the body rig (`render/humanoid.ts`, `PoseKind`) can **sit** on the ground (knees up,
elbows on the knees, forearms folded in front of the shins) and **lie** on its back (one knee up, elbows on the ground, hands
on the belly, the head resting on the ground; with a pack on, it reclines against the pack). Both breathe a little. They work
for anyone the rig draws, but nothing in play uses them yet; see them in the portrait viewer: `/portrait.html?hero=nar&pose=sheet&view=body&kit=shirt`
puts him standing, sitting and lying side by side (`pose=stand|sit|lie|sheet`, `kit=shirt` is his own T-shirt over the
starter trousers and boots). The rig's root now turns before it tips (`YXZ`), so a body lying down (also a downed player)
lies on its back along the way it faced instead of rolling onto its side when it faced anywhere but north.
### Udud

**Udud** is selectable in either seat or solo at **176 cm, 82 kg**. His supplied photograph guides the dark curls,
short brown beard, smiling face, blue rectangular prescription glasses and grey T-shirt. His seated idle leans back,
with his head upright and hands resting comfortably. After uneven pauses he raises his right hand, pushes his glasses
back up and lowers it again. Aiming, holding gear or moving interrupts the gesture; goggles and full face masks hide
his prescription glasses, as does the owner's first-person view.

Open `/portrait.html?hero=udud&view=body&yaw=25` for his canvas-chair showcase. Selecting Udud in the portrait viewer
defaults to `pose=lounge`; `pose=sit` shows his laid-back ground pose, and `pose=walk` previews the playable rig.

### Nuhat

**Nuhat** is selectable in either seat or solo at **170 cm, 73 kg**. Her portrait follows the supplied photograph:
warm brown skin, dark almond eyes, berry lipstick, long black box braids swept over her right shoulder, a cream
buttoned blouse, two fine necklaces and small gold earrings. Her starter jacket and bandana stay in her bag.

Open `/portrait.html?hero=nuhat&kit=shirt&view=body&pose=walk&expression=talking` to preview her. `pose=stand|sit|walk`
sets the body action; `expression=neutral|talking|smiling|wondering` works independently, including while sitting or
walking. Speech moves the jaw and lips through syllables and phrase pauses; the smile lifts the mouth corners and
cheeks; wondering raises the brows, tilts the head and brings a hand toward the chin when her hands are free.
These are visual animations; speech audio is not generated. Add `&ref=/characters/nuhat-reference.png` to compare
with the photograph. `Humanoid.expression` controls the expressions in other scenes. The braids sway slightly,
disappear from her own first-person camera and are removed when changing character. `tests/nuhat.test.ts` covers
selection and saves, dimensions, independent expression blending, gait, sitting, dressing and camera visibility.

### Iati

**Iati** is selectable in either seat, including solo, at **179 cm**. His portrait follows the supplied front and side photographs:
a bare receding crown with dark hair at the sides, a full dark beard, clear rectangular glasses, an open navy tropical
overshirt with turquoise foliage and orange spotted cats, purple edging, dense curled chest, belly and forearm hair,
and brown trousers. The rounded torso stays inside the overshirt. His 86 kg
build is an appearance estimate; only his height was supplied. His starter jacket and bandana are in his bag so the
shirt and face are visible, and equipping armour or face protection replaces them normally.

When standing quietly in third person, he alternates a sip from an amber bottle with a puff from a lit joint; movement,
aiming, firing, nearby enemies and hands-on work interrupt it. This idle animation does not dose him or spend supplies.
Taking alcohol or weed through the existing quick belt plays the corresponding pose and uses the existing drug rules.
Each puff produces a broad, billowing exhale that rises and fades before the next puff.

Open `/portrait.html?hero=iati&view=body&kit=shirt&pose=relax&yaw=35` for the animated model; `pose=drink` and
`pose=smoke` isolate the actions. Add `&ref=/characters/iati-reference.png` to compare against the original photograph.
Use `&ref=/characters/iati-side-reference.png` for the second photograph.
`tests/iati.test.ts` checks his height, saved selection and clothing, hand and mouth contact, shirt clearance,
smoke expansion and fading, props, and gameplay interruption.

### Amirat's barbecue garden

**Amirat** is selectable in either seat: 175 cm and 77 kg, with a portrait sculpted from the supplied doughnut and barbecue photographs:
full cheeks, a broad rounded nose, a shorter broad jaw, dense dark curls, light stubble and a toothy smile. His own clothes are an orange pullover hoodie with the hood down,
drawstrings, a kangaroo pocket and sleeves pushed up to expose his forearms. Armour covers these clothes as usual.

Choose **Amirat's garden** on the title screen, or open `/garden.html`. This inspectable 3D scene recreates the barbecue
at a single-storey family home: a long tiled patio with its house-to-lawn depth halved to 3.25 m, a pale curved cover with metal ribs over all the tiles,
lawn, exactly three small fruiting orange trees, a children's slide, a trampoline with safety net, a wooden sofa with cream cushions against the house wall,
an oval coffee table and six chairs with white legs and wooden seats. One orange tree is near the trampoline and one is in the lawn's centre.
The house and its covered patio end beside the sofa's right arm. A paved side passage connects the main garden to a front garden
one-third of the main garden's width, aligned beside the passage. Metal railings carry a semi-dark blue privacy screen on the exterior;
the front gate has a matching screen and two concrete steps on the inside, descending from the garden to the entrance.
A round ivory preparation table with bowls stands between the house door and sofa. The storage cabinet is rotated 90 degrees
against the left fence, with a compact 70-litre office refrigerator beside it; both face into the patio.
Amirat tends two tomahawk steaks with steel tongs; smoke rises from the coals.
The hanging flag strip is omitted. **Garden** shows the main layout, **Photo view** frames the man and grill, **Passage** shows the side route,
**Front gate** shows the small garden, privacy screen and entrance steps,
**Hide / Show cover** reveals the furniture layout, **Daylight / Evening** changes the lighting, and **Pause / Resume** stops the cooking animation. Drag to orbit and scroll
to zoom. His close portrait is `/portrait.html?hero=amirat&kit=shirt&view=face`.

The scene is reusable as `AmiratGarden` in `render/amiratGarden.ts`; `GARDEN_LAYOUT` defines its placements in metres.
`tests/amirat.test.ts` checks selection and saves, dimensions and object counts, complete geometry, and tongs staying
in his hand through the animation when the entire garden is moved or rotated. The production build includes both viewers.

### Mission two: Udud and Nuhat's house

The garden above is **Udud and Nuhat's house**, number 18, and it stands in the open world inside Petah Tikva: in the last
row of blocks at the city's north end, on the right of the boulevard, squeezed in between apartment blocks (the block it
took the end of keeps the rest of its lot). `open.house` in `legs.json`, numbers in `world/ududHouse.ts`. A paved driveway
crosses the pavement from the boulevard to the front gate, and the side passage leads round to the garden. The house,
fence, furniture and the people are solid (`LegLayoutImpl.buildHouse`).

**The gate is shut.** Ring the buzzer on its post (**Ring the buzzer**): it buzzes, the host answers on the intercom, and
five seconds later the gate buzzes again and swings open (it stays open: `house.gate`). Walk round into the garden and
**Iati**, on his chair by the way in, turns, takes a long drag and blows a great cloud of smoke over you: a blessing, and a
real dose of weed from the drug system (its slow, green, glowing look and all). While it lasts the party turns strange:
Lag Karab's spoon grows until its bowl is bigger than his head and his cake swells, Ro's burger swells, everyone floats up
off their seats and sways, Udud's glasses leave his face to circle his head, Nar's tea glass drifts up out of his hand, and
Amirat's steaks lift off the grill and turn in the air while he sways at it. Talk to Iati again once it wears off and he
blesses you again.

Everyone with a name who is not out on the road is at the barbecue, in their own clothes (jeans or dark trousers and
trainers; no helmets or packs). **Amirat** grills out on the lawn, facing the patio; everyone else is round the coffee table
by the sofa, crowded with takeaway (foil trays of shawarma and kebabs, hummus tubs, pitas, chips, cans), holding their food
in their hands and on their knees: **Nuhat** (telling a story) and **Udud** (in his canvas chair) nearest the house door,
**Nar Divad** with a glass of tea on the end of the sofa nearest the way out, **Iati** smoking on the chair beside him, the
**Karab brothers** across the table from the sofa (**Lag** with the cake on his knees and his big spoon, **Ro** with his
burger and beer), and **Chinsky** and **Leo** on the rest of the sofa with a pita each whenever neither is playing.
Whoever is in a player's seat is left out. Heads turn toward whoever walks up, and **Talk to ...** prompts give each of them
a few lines (`render/partyCast.ts`, `game/partyMission.ts`).

In story mode, mission two takes over when mission one ends (`story.m1`, Nar in the trike's cab): the objective and a
**HOUSE** compass pin point up the boulevard. Reaching the house sets `story.house`: Nar gets out of the cab and joins the
party, everyone waves; then ring the buzzer, go in, and Iati's blessing (or saying hello, or walking onto the patio)
completes the mission (`story.m2`). The house shows on the map once seen. Outside story mode the house and the party are
simply there, buzzer and blessing included.

`tests/ududHouse.test.ts` checks the placement and levelling, the cleared plot, a Rapier capsule walking from the driveway
through the gate and passage to the patio (and not through the house, fence or grill), the party clothes and seating,
and the merging of the garden's static meshes.

### Ro Karab

**Ro Karab**, Lag Karab's younger brother, is selectable in either seat: 175 cm and 88 kg, so he is built heavier than Lag
at the same height. His portrait (`RO` in `render/heroLooks.ts`) comes from the two supplied photos: a long straight nose,
heavy dark brows, ears that stand out, and short wavy near-black hair with grey through it (the hair is from the burger
photo). He is clean-shaven, as he usually is, though both photos show a beard. He grins with his top teeth showing. His own clothes are a charcoal pullover hoodie with the
hood down, full-length sleeves and no drawstrings (`drawstrings: null`). Two extra faces get swapped in as he eats:
`RO_BITE` (jaw wide, squinting) and `RO_LAUGH` (mouth wide open with top and bottom teeth; the face painter's new
`mouth.lowerTeeth` adds the bottom row).

`BurgerEater` in `render/burger.ts` sits him on a crate at a crate table with a double cheeseburger in a brioche bun and a
brown longneck beer. The loop lasts 12.5 s: he lifts the burger in both hands, tipped up with its top facing out as in
the photo, and takes a bite (each bite cuts a crescent from the front, with the crumb, patty, cheese and lettuce showing).
Then he chews, puts it back on the plate, takes a long pull on the beer with his head back, and laughs: first leaning
back, then bent over the table pounding it with his right fist. Free hands rest on his knees while he sits up. A burger
lasts five bites, then a new one is on the plate. Any hero can sit at it; only Ro pulls the faces. See it at
`/portrait.html?hero=ro&pose=burger&view=body&kit=shirt&yaw=-35&light=sun`, and add
`&ref=/characters/ro-burger-reference.webp` (or `ro-laugh-reference.webp`) to compare with the photos.
`tests/ro.test.ts` checks his height and build, saves, the hoodie, the teeth in both faces, the bites, and the burger
and bottle meeting his lips in time with the faces.

### Story mode: Nar's yard

**Story** on the title screen starts a run that begins somewhere else: on foot, in a ruined scrap yard on **Nar's Flat**, a
dry salt pan about 1.3 km east of Dustwell (it is a place on the open-world map like any other, and stays there in every run).
Your uncle **Nar Divad** lies out cold on a pallet in his own lean-to, to the left of the garage as you look in from its open
front, the big rusty skip beside him and a fire burning in a rusty basin out in front (look at him and the label reads
"NAR - IS HE ALIVE?"). The **Rickshaw Trike** he was building stands in pieces in the garage: the bare frame up on its stand, the 594cc twin, the motorcycle front wheel, two
*Small Wheel T2*s and the tin cab lying about the yard, with a can of petrol, an oil can, a tin of dog food on the bench and a
*Suspension Lift Kit* by the sacks. Mission one, step by step on the objective panel under your name:

1. **Check on Nar** (hold interact at his pallet). He is alive, and tells you to finish the trike.
2. **Build the trike**: the engine, the front wheel, both back wheels and the cab, each carried to its place on the frame and
   attached. The checklist ticks as each goes on; with every wheel on, the frame drops off its stand onto its tyres.
3. **Fill the tank** from the can (the trike starts dry, and so do the convoy's reserves).
4. **Help Nar into the cab**, with the trike brought near his lean-to. He rides on the bench from then on.
5. **Drive out of the yard**: mission one is done (`story.m1`), and mission two takes the objective from there.

Progress is saved in the campaign's flags (`story.checked`, `story.built`, `story.aboard`, `story.m1`), so a night or a reload
picks up where it was; whatever was put down in the yard stays there overnight. The trike is a one-off chassis (`special` in
`vehicles.json`): a three-wheeler (`physics.axles`: one 0.33 m wheel in front, two 0.26 m wheels on the back axle, rear drive)
whose wheels are **whole parts** (`physics.wholeWheels`): a wheel taken off leaves nothing on the hub, so a trike missing one sits
fixed on its stand and will not start. Each hub only takes its own kind (`PartDef.wheel`: `moto` in front, `small` behind).

### Hands on: looking at, holding and placing things

On foot, whatever you look at is named in white under the crosshair, the way a mechanic reads it: an engine as size, layout,
power, torque and fuel ("594CC I2 23HP 39NM GASOLINE", its wear, "FUEL CONSUMPTION: 0.6"), a wheel by its grip, food by what it
does for hunger and health. The buttons that do something with it are listed down the left side in your own bindings (GRAB,
RELEASE, THROW, ROTATE, MOVE, ATTACH, DETACH, EAT, STOW). Lifting is still a short hold of interact; what you look at is what you
lift. Held, it floats out in front of you along your line of sight: the **mouse wheel** brings it nearer or pushes it out, the
**swap** button (Q / LB) turns it, **fire** lets go of it exactly where it is, and **aim** throws it (it tumbles and can be
lifted again once it lies still). Let go over a deck of one of your vehicles (the rickshaw's cab, a pickup's bed, a roof) and
it stays there, at that spot and that heading, and rides along: that is how things are stored on a vehicle now. A part held to
its mount still goes on with the interact hold, and X still stows or sets down as before. **Food** is carried too: a tin of dog
food (hunger -30, health +15) or a lizard snatched off the hot ground (crouch to creep up on one; hunger -7, health +3), eaten
with the eat key. The rules are `game/grab.ts`; foods are `sim/food.ts`.

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
| RT / LT | Fire / aim (a bow: hold RT to draw, let go to loose) | Throttle / brake | Fire / zoom | Place / remove |
| RB | Tap melee, hold takedown | Fire front gun, or the sidearm if the ride has none (drive-by) | Fire | Next element |
| LB | Swap what is in hand along your belt | | | Previous element |
| A | Tap: jump (when nothing is in reach). Hold: loot, repair, refuel, revive | Handbrake | | Rotate |
| B | Crouch | Tap lights, hold engine off | | Hold: ready for night |
| X | Reload (hold: swap utility) | Tap horn, hold siren | | Assign watch post |
| Y | Get in a vehicle (one press, no hold) | Get out; hold to bail at speed | Get out | |
| D-pad ↑ | Tap ping, hold command wheel | | | |
| D-pad ↓ | Tap to take the selected drug (or eat, drink, piss, shit from the belt), hold to open the belt | Same, except piss and shit | Same, except piss and shit | Same |
| D-pad → | Tap map: closer look, whole leg, close | Same | Same | Same |
| D-pad ← | Inventory: change what you wear and hold (the game pauses) | Same | Same | Same |
| L3 / R3 | Click to sprint (stays on until you stop), or hold, per Control settings / reset camera | Camera distance / look back | | |
| Start | Pause | Same | Same | Same |
| Back | Hold: convoy sheet (on foot it is always first person) | Tap: vehicle camera, behind or the eyes. Hold: convoy sheet | Same | |

**First and third person**: on foot the game is always first person: you see your arms and what they hold. In a vehicle
(driving, at a bed gun or in a passenger seat) the camera is behind the vehicle by default, and the view button switches between
that and the eyes; the choice is remembered per player, and Control settings > Camera & play has a **Vehicle camera** row to set
it. Getting out glides the camera into your eyes instead of cutting. On a pad the view shares **Back** with the convoy sheet (tap
for the view, hold for the sheet); on the keyboard the view keys are `B` (Player 1) and `P` (Player 2), and the middle mouse button.

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
| **Painkillers** | 90 s | half damage; current drug morphing is a further 20% weaker and its remaining time is 30% shorter | a sore comedown |
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

Default spatial morphing (warp, kaleidoscope, view pulse and world breathing) is reduced by 20%; painkillers reduce it by another 20%.

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

**Keyboard**: solo play can use either layout below. Player 1 uses `W A S D` to move, the mouse to look (`Z X` to aim without it), left
click or `T` to fire, right click to aim, `E` to interact, `Space` to jump, `F` for vehicles, `C` for crouch and lights, `Shift` for
sprint and handbrake, `G` for the command wheel, `Q` to swap tools, `R` to reload, `H` to honk, `B` (or the middle mouse button) for
the vehicle camera, `1 2` to cycle build elements, `V` for the map, `Tab` for the inventory, hold `3` for the convoy sheet, `4` for the
quick belt, `5 6 7 8` to eat, drink, piss and shit, `9` to call your ride and `0` for the drugs quick pick. Player 2 uses the arrow
keys, `[ ]` to aim, `Right Shift` to fire, `/` to interact, `O` to jump, `Enter` for vehicles, `.` for crouch and lights, `J` for sprint
and handbrake, `Backspace` for the wheel, `N` to swap tools, `,` to reload, `M` to honk, `P` for the vehicle camera, `; '` to cycle build
elements, `K` for the map, `I` for the inventory, hold `\` for the convoy sheet, `U` for the quick belt, `Home End - =` to eat, drink,
piss and shit, `Page Up` to call the ride and `Page Down` for drugs. Ctrl keys are never used (Ctrl turns the other player's keys into
browser shortcuts). Keyboard players get stronger aim assist. `Esc` pauses (and backs out of a menu first).

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
sensitivity, invert look Y; the gamepad tab also has sprint as one click or hold), and a *Camera & play* tab holds the view per seat, the first-person field of view (70 to 120
degrees), the bodycam lens strength and crouch as toggle or hold. Reset a tab to its defaults at any time. Everything is saved with the other settings,
and the in-game Controls screen and the button prompts follow whatever you bind. The sticks and the D-pad menu navigation stay fixed.

**Mouse / trackpad** (the Player 1 keyboard seat): click the game to capture the pointer, then move to aim with free
yaw and pitch. Left click fires (a tap on a trackpad), right click (two-finger click) aims down sights. `Esc` releases the
pointer and pauses; click again to resume aiming. Sensitivity is under Settings. Q/E still work. The in-game Controls screen has the full table.

### What changed on 2026-10-08

- **Map and navigation.** The big map (`V` / `K` / D-pad →) opens at once and sharpens itself (a quick coarse picture, then
  full detail baked in the background, finer tiles near where you look), with hillshade, contour lines, water by depth, city
  blocks and buildings, roads by class, place names, a grid, scale bar and legend. It has a cursor (mouse, or the move keys /
  left stick on foot, the look keys / right stick while driving) and zooms (wheel, `1`/`2`, LB/RB). **Confirm** (click / `E` /
  A) drops a **waypoint**: the route follows the roads, and it shows on the compass, the minimap and as a small marker in the
  world; it clears when you arrive. **Mark** (right click / `R` / X) places a **point of interest** (Camp, Fuel, Loot, Danger,
  Car, Water, Food, Note, Star), which you can name on a keyboard, pin to the compass, rename or delete; a list of marks sits on
  the right. Waypoints and marks are saved with the campaign. On foot your feet stay put while the big map is open.
- **Call your ride**: `9` (Player 1), `Page Up` (Player 2), or CALL RIDE on the pad's command wheel. Your vehicle drives itself to
  you along the roads if it is within about 350 m; if it is further, stuck or you are indoors it turns up waiting behind you, out of
  sight. Press again to call it off.
- **Cars, hands on.** Look at any part of a car (yours or a found one) and a small card names it, with its mark, wear, key figures
  and what it would change against the spares you carry. `X` at the boot, bed or roof opens a **storage panel** in your half of the
  screen (the game keeps running): every spare, can and load with what it fits and whether it is better than what is fitted; take
  one into your hands, or **Fit now** with the wrench. Hold the sheet button for a **breakdown** of every component and the car's
  totals (power, torque, weight, top speed, 0-100, grip by ground, armour, range, space), compared with another car of yours. The
  workbench now docks beside the car instead of covering it.
- **Weight and torque.** Every part, the fuel, oil and coolant, the crew and whatever is stowed or loaded has a weight, and the
  car carries it: a loaded pickup squats, pulls away slower, stops longer and drops a gear on a hill. Engines have torque curves,
  gearboxes have real ratios with automatic shifts, and the engine sound and the small gear and rev display follow them.
- **More varied cars.** The truck and the rig have their own models (a 6x6 with drop-side, tilt or gun-box bed; a tractor with a
  tanker, container or scrap trailer). Found cars roll their own body style, bumpers, grille, lamps, rims, racks, paint (two-tone,
  faded, primer, rust), numbers and scrawls; raiders get scrap armour, spikes and cages. Fitted parts show: armour by grade, blowers
  through the bonnet, tyres by type, lifted or lowered stance. Every loose part has its own model.
- **Water stays in its banks.** Rivers have real banks (and levees where the land behind is low), the water surface is clipped to the
  ground as it is drawn, mouths drop over falls into lakes instead of floating above them, floods fill road dips and stay in their
  beds, and nothing floats in the distance any more.
- **Shooting trees.** Every hit throws chips, bark and leaves, leaves a scar and a knock; rounds landing at about the same height
  chew a notch, and when it is deep enough the tree snaps there and the top swings over, falls and crushes what is under it. A rifle
  takes a thin tree down in a few rounds, a big old tree needs a belt or explosives; a pistol mostly chips. Stumps and fallen tops
  stay through the nights.
- **The inventory** opens a small menu on whatever you pick (A / Enter / click, right click): use, apply a bandage (to yourself or a
  hurt partner close by), eat, drink, take, put on the quick belt, hold, wear, load, customise, repair, give, drop, break down, each
  with a fixed letter. A **supplies** strip shows dressings, food, water, every drug and the unknown mushrooms you picked, with what
  each does; drugs show what is in your system. `0` (Player 1) or `Page Down` (Player 2) opens a **drugs quick pick** without
  pausing.
- **Night camp is off by default** (Settings: *Night camp*). After the Dusk Bell, hold on foot to **stop for the night**: rest until
  dawn (then the Ledger), make camp, or keep moving through the night. Whoever chooses to make camp and holds out against the raid
  gets **the night's haul** at dawn: ammunition, a fairly rare part (Mk2 or Mk3, or a bolt-on kit) and a medkit, bandages or a drug.
- **Half Island mushrooms.** Liberty caps grow at the foot of every old face gum, every day. Mushrooms you do not know are always
  picked and kept by their look; eating one is how you learn it. On a trip the faces in the gums wake up (deeper, moving, with eyes
  that follow you) and faces show on other trees too, only in the tripping player's half of the screen.
- **Weapons** are rebuilt as detailed models (21 guns, melee and tools) with a close-up version for first person and a light one for
  everything else; add-on sights are see-through and replace built-in scopes, stocks replace stocks.
- **No more z-fighting**: the depth buffer is reversed and floating point (`?depth=classic` in the URL turns it off), roads, decals
  and tracks pull toward the eye by layer, and buildings, the mall, containers and furniture lost their overlapping faces.
- **Faster start**: the title is up in about a third of a second, the world is prepared in the background while you look at the menu,
  New Game reuses it behind a small loading label, shaders compile before the first frame, recordings load by priority, menus no
  longer redraw the whole 3D scene at full rate behind them, and the download is smaller (Opus audio, no reference photos).
- **Fixes**: positional sound came from the wrong side (left and right were swapped), the radio cut off the story narration, the
  pad's Start never paused, quick taps and trackpad clicks were lost, retrying from the Ledger brought back later state, raider car
  guns did double damage, burning animals stood still, wrecks threw their doors inward, the world kept moving behind the pause menu,
  and more than thirty others (see the git log of 2026-10-08).

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
  game/      scene runtime, entities (player, vehicle, zombies, raiders, crew, wildlife, travellers), combat, leg scene, camp scene, game loop,
             the training director (`tutorial.ts`)
  ui/        HUD, shared-cursor focus UI, overlays (title, votes, report), the Dawn Ledger, the inventory, the illustrated guide
             and training cards (`guide.ts`, `guideArt.ts`, `coach.ts`), styles
  input/     gamepad, keyboard and mouse sampling into per-player intents; `bindings.ts` holds the rebindable action table
  audio/     recorded Web Audio: licensed effects, engines and dynamic ambience
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

Roadside places (`world/terrain.ts` plans the sites, `world/settlements.ts` fills them): gas stop, hamlet, motel, farm, depot yard, broken overpass, wind farm and radio hill, spaced every few hundred metres and clear of the authored set pieces. Between them run power lines, billboards and lone water towers and windpumps. Each place has what its trade would have (see [Loot](#loot-what-lies-where)) and a dormant cluster of the dead. The terrain flattens a pad under each one.

Buildings and landmarks are drawn by the far landscape for the whole leg (`render/landscape.ts`, `render/ruralView.ts`, `render/landmarks.ts`), so a gas station or a wind farm shows on the horizon long before its chunk streams in. Only their colliders stream.

**Draw distance.** Each quality preset sets a view range (`QUALITY.draw`: 300 / 440 / 560 m) that pushes the fog out and thins the day haze, and how many chunks stream in full detail (`stream`: 2 rings on Low and Medium, 3 on High). Past the streamed chunks the far landscape also draws the paved roads as plain ribbons and the props that stand out (dead trees, big rocks, containers, poles, streetlights, pylons, tents, buses) as GPU instances of cheap stand-ins, one draw call per kind for the whole world (`render/farDetail.ts`). They step aside per chunk once that chunk is fully built: the far landscape's loaded-chunk mask has the ground in red and the finished chunk in green, read in the vertex shader (the instance folds to a point) and in the road's fragment shader. Each view's far plane follows the fog (`GameRenderer.fitFar`), because past the fog's end everything is horizon colour anyway; that culls more than the old fixed 2600 m plane did, so Medium draws fewer calls than before while seeing about a third further.

### Gang camps

Raiders are not just buggies that turn up out of the dust. Three gangs hold the open world, each a stretch of country (the map is cut into squares, `gangAt` in `world/gangCamps.ts`): the **Rust Jackals** (red), the **Ash Choir** (orange) and the **Salt Kings** (green and white), defined in `data/gangs.ts`. Each keeps camps, some beside the roadside places off the highway and some out on their own in the open country (never in a city, a lake or on a slope, and kept well apart).

A camp is a ring of torn fence round a fire, with tents, tarped wrecks, barrels and tyres, the gang's banners on either side of the gate and over the stash, and a stash of loot on the far side from the gate: Scrap, Parts, ammo, Rations, fuel, and from the second tier medicine, Tech and a vehicle part. Hold A to take it, as with any pickup. Further from the start the camps are stronger: tier 1 has three gunmen, tier 2 four gunmen and a sniper, tier 3 five gunmen and two snipers (the gunmen scale a little with the Aggro slider), and the stash is richer.

- **Sentries** stand on their posts once anyone comes within about 170 m (a far camp costs nothing), wander a few metres or scan the horizon, and notice people on foot the way any raider does ([Raider sight and cover](#raider-sight-and-cover)) at about half the reach while nothing is up: about 55 m walking in the open, 33 m crouched, less again standing still, and not at all behind a rock or down in a bush. A shot they hear, or a glimpse, brings one over to look. Vehicles they notice at 55 m parked and 120 m under way, longer when your Signature is high or you have just fired, and shorter in a dust storm.
- **Shoot the crew, keep the car.** A raider car's crew can be hit in their seats (`RaiderSystem.crewRayTest`): the buggy's driver sits up in its open frame, the battle-wagon's two behind its visor slits, where the armour takes 60% of each round (`crewHp`, `crewCover` in `enemies.json`). Kill them and the car rolls to a stop with the driver slumped over the wheel, counts as a kill, and is left whole (*ABANDONED*) for the crowbar, which gets more out of it than out of a burnt hulk. Shoot the car itself until its engine dies and the crew climbs out and fights on foot. A car with nobody fighting from it no longer counts for waves, map pins or "raiders nearby" (`Vehicle.hostile`).
- **The alarm** is shared. A hit raises it (a clean silent takedown with the blade does not), the whole camp turns on you, and the camp's buggies, and sometimes a battle-wagon, roll out ahead of you. A sentry gives up at 150 m from its post and walks back; with no one in sight for 14 s the camp stands down.
- **A broken camp stays broken.** Sentries you kill stay dead across nights and reloads (`WorldMemory.gangKilled`, saved with the campaign; older saves load without it). When the last one falls the radio says so and the gang's pin leaves the map. The loot you did not take stays where it lies, as everywhere else.
- **On the map.** A camp is drawn on the minimap, the whole-leg map and the compass (as a threat, labelled with the gang's name) once the convoy has come within about 420 m of it, and stays there until it is broken. The radio names a gang the first time you come near one of its camps.

Code: placement and dressing in `world/gangCamps.ts` (called from `Layout.raiderCamps`), the `tent` and `campfire` props in `render/props.ts`, sentry behaviour in `game/raiders.ts` (`Infantry.post`, `guardNotices`, `guardStep`, `alertCamp`), and the runtime in `game/gangCamps.ts`. Tests: `tests/gangcamps.test.ts`.

### Raider sight and cover

A raider (on foot, in a buggy's gun seat, a sentry, or an armed traveller you have crossed) has to **see** you before it shoots, and seeing takes a moment:

- **What shows.** A line is drawn from its eye to your head, chest and hips (`game/sight.ts`). The ground, walls, rocks, boulders, tree trunks and cars block a line outright; bushes, oleander, reeds, cane, bramble, prickly pear and fig thin it by how much leaf it crosses (`Vegetation.seeThrough`). Crouched behind a waist-high rock, only your head shows; down in a big bush, nothing does. Glass and grass hide nothing. Within 3 m you are noticed whatever you hide in; leaves stop hiding you within about 2 m.
- **Noticing builds up** (`sim/enemySight.ts`, `SIGHT`). Walking in the open by day it can pick you out at about 110 m; crouched, standing still, at night, in dust or rain, or with only part of you showing, much nearer, and more slowly. Once it is fighting you it looks harder.
- **Ears.** A shot is heard out to about 90 m (less with a suppressor) and footsteps a few metres. A noise brings it to look where it came from, roughly, but it never fires at a noise. Hit one and it knows roughly which way the round came from, and a camp's alarm passes that on.
- **Fire discipline** (`FIRE`). After it picks you up it takes 0.6 to 1.2 s to bring the gun round. Its first rounds go wide (three times the spread) and settle over about 3 s of unbroken sight, a runner is harder to hit, and a gunman's pistol holds 7 rounds and then needs 2 to 3 s to reload. It aims at whatever of you shows, so a rock in front of you takes the rounds. Lose it and it puts a round or two where you were for under a second, then stops, comes looking (gunmen walk to the spot and search round it; snipers hold and watch), and gives up after about 12 s. Nobody shoots at someone who is already down.
- **Zombies** use the same lines for spotting you on foot, though once one is on you it follows by smell and sound at close range.

Tests: `tests/enemySight.test.ts`.

### Travellers on the road

The roads of the open world are not empty. Every so often someone turns up out of sight and walks one: a **pilgrim** or two bound north, a **drifter**, a **scavenger** with a frame pack and a crowbar, a **courier** at a run, a **hunter** with a rifle across the arm, and now and then a **trader** hauling a handcart. About one party an in-game minute and a half, fewer at night and in a dust storm, never more than three at once and never in a city or in training, and none set out within 200 m of a gang camp that still stands. They walk the shoulder, mostly toward whoever is leading, and vanish again once they are far behind or the road runs out where nobody can see.

They are neutral. A trader always is. The rest mostly are too, but each rolls an attitude: **neutral** (just getting on with it), **rude** (shouts at traffic, brushes you off) or **wary** (stops to watch you, keeps their distance until they have made up their mind). A few, never a trader, are **asking for help**: a pilgrim short of food or a fever medicine, a drifter with a dry jerrycan, someone lost. They show on the compass as a `?` once you are within about 160 m, and on the minimap as a pale dot.

- **Talk.** Walk up on foot and hold A (not with a gun up, not while carrying something): the prompt names who you are talking to. Small talk is a line over the radio-style subtitle; a neutral stranger sometimes lets slip where a gang camp is, and puts it on your map. A courier has no time.
- **Help.** Asking for help opens the same shared vote as a Roadside Encounter, with their own words in it (they put it rudely or warily if that is who they are). Helping costs stock (2 Rations, 1 Medicine, 3 Fuel; pointing a lost traveller to the highway is free) and earns Mercy, sometimes Trust and a little loyalty, and a few Scrap or Parts in thanks. Turning them away costs nothing, except Mercy where it is a fever. It never hands over the Encounter Lead.
- **Trade.** The trader's cart is a panel of its own: a few lots for sale for Scrap, a few the trader will buy, a purse that runs dry. Prices wobble from one trader to the next and are usually a little worse than at a hub; what a trader pays is well under what a trader asks, so there is no profit in carrying goods between them.
- **Get out of the way.** They step off the road for a vehicle coming at them, and rude ones swear at one going by. A gun pointed at them (aiming down the sights; having it out is not enough) makes them nervous, and nervous becomes running. Gunfire anywhere near sends the unarmed running and everyone who sees it with them. The hunter is the exception: warns first, and shoots back if a gun stays on them.
- **Killing them** is murder. Shooting, running down or burning someone who was only walking costs Mercy and raises Notoriety (a trader costs twice that), the radio says so, and everyone nearby saw it. They had a little on them. Anyone who shot first is fair game, and costs nothing.

Rules (who turns up, attitudes, suspicion, requests, the cart, a road walked as a polyline) are `sim/travellers.ts`, tuned in `data/travellers.json` with all their lines in `strings.en.json` (`trav.*`, and `validateData()` checks every key). The runtime is `game/travellers.ts` (spawn, minds, movement, hits), the effect of a request is `game/travellerFx.ts`, the cart is `render/handcart.ts`, and the two screens are `Overlays.showRequest` and `Overlays.showTrade`. Hits hook into the same places as raiders: `Combat.firstHit`, `Player.computeAim`, melee, blasts, fire and `plow`. Tests: `tests/travellers.test.ts`.

### Interiors

Every roadside building can be entered. `world/interiors.ts` generates a floor plan from the building's seed: exterior and interior walls with doorways, gates and windows, rooms with a role (living room, kitchen, bedrooms, bathroom, shop floor, back office, motel rooms, a barn's stalls, warehouse racking) and a floor, stairs and an upstairs for some houses, furniture, searchable containers and damage (breached walls, a collapsed or missing roof, rubble). Layouts differ with the seed, and every room is reachable from a door to the outside. Furniture placement is rejected if it would cut a doorway or the stairs off.

The plan becomes colliders (`planAabbs`: wall pieces with the doorways left open, window sills, furniture, a sloped collider for each stair, upper-floor slabs) and geometry (`render/buildingView.ts`, `render/furniture.ts`; walls are facade-shader quads on both faces with no painted windows, so the openings are real). The terrain is levelled under each building (`TerrainDef.foundations`), so the ground inside is the floor.

When a player or vehicle is inside, that viewer's roof and all upper storeys are hidden (`BuildingView.setView`, called per view from `LegScene`), so the room can be seen from the chase camera. Furniture is only drawn near the camera. Searchable furniture (fridge, wardrobe, filing cabinet, till, workbench, safe, ...) is a loot container in a per-building `ScavZone`, using the same search-and-noise rules as the city shops. The dead are placed inside some buildings, and zombies route through doorways when a wall is in the way.

**The car trades.** Three more building looks join the house, store, motel, barn, warehouse and shack: a **garage** (a workshop hall with a car half taken apart in its bay, benches, heavy parts shelving, engine stands, tyre stacks, oil drums, a tool chest, a back office and toilet), a **tyre shop** (wall racks and floor stacks of tyres, a counter, a bench) and a **car dealership** (a glass-fronted showroom with two or three showroom cars on the floor, a sales desk, and a back strip with the parts room: shelving, a counter, a tyre rack). Warehouses and depots are pallet racking with crates, pallets and drums. A store can be a pharmacy, a clinic, a police station or a gun shop (`PlanInput.use`). New furniture: `enginestand`, `partsshelf`, `tyrerack`, `tyrestack`, `toolchest`. Garages stand in gas stops, hamlets and hubs (the Mechanic's workshop at each hub keeps a runner's starting kit: an engine, a radiator, a gearbox and tyres on its stands and bench), with tyre shops at the bigger hubs and warehouses at depots. In the cities, a `scavengeZone` set piece turns a boulevard lot into one of these real buildings through the same `SiteBuilder` (`LegLayoutImpl.addZone`), with its yard of cars: Petah Tikva has garages, a dealership, a tyre shop, a police station, a gun shop, a warehouse, pharmacies and a depot. A parked car is as solid as a cabinet: no bay cuts a doorway off.

Tests: `tests/interiors.test.ts` (reachability, door clearance, walkability by flood fill, the trades, items on the surfaces that justify them) and `tests/walk.test.ts` (a Rapier player capsule with the game's character-controller settings walks from the doorstep to every room and up the stairs).

### Loot: what lies where

There is no loose Scrap, Tech or generic Parts crate. Everything lootable is a named thing (`sim/loot.ts`): a part with its wear, a fuel, oil or water can, a spray can, a ration tin, a pill bottle, a medkit, a bandage roll, a box of rounds, or (from `sim/gunLoot.ts`) a gun. Each is generated from a **context** and put on a real host: on furniture inside a building (an engine on its stand, tyres in the rack, parts on the bench and shelves, tins on the kitchen counter, pills by the sink, cans on the drums), or on the ground within a couple of metres of the thing that justifies it (a can by the pump, a tyre by the tyre pile, a part by a wreck, rations by a bench or a bus). Nothing lies in open ground by itself, and every item lies still: a fixed heading and a natural tilt, no bobbing and no spinning (a tall beam still marks the rare parts and the fuel).

| Context | What it holds |
|---|---|
| `garage` | engines, radiators, gearboxes, tyres, springs, brakes, exhausts, panels, mounts, oil, fuel, water, spray |
| `tyreshop` | tyres almost only, oil, brakes, spray |
| `dealership` | tyres, brakes, exhausts, panels, spray, oil, a radiator, a gearbox, the odd engine; showroom cars |
| `warehouse`, `depot` | any part (engines, springs, crated bolt-on kit), fuel, oil, water, food |
| `gas_station` | fuel (petrol and diesel), oil, water, food, a spray can, a tyre |
| `wreck`, `trunk` | what a car's owner had out: panels, tyres, a radiator or gearbox, fuel, oil, water, food, pills, rounds |
| `farm` | diesel engines, gearboxes, radiators, mud tyres, diesel cans, oil, water, food |
| `kitchen`, `bedroom`, `bathroom`, `house` | food and water; rare pills, dressings, rounds; medicine and medkits; a drawer's odd gun |
| `shop`, `pharmacy`, `clinic` | food, water, oil, spray; pills, dressings, medkits |
| `police`, `military`, `gun_shop`, `bunker`, `raider`, `cache` | rounds, medkits, dressings, fuel, mounts, plus guns from `rollGunLoot` (lockers, safes, footlockers, chests, raider rigs and bodies) |
| `container`, `delve_*` | a mixed lot; delves by kind (a mine its spares and fuel, a bunker its ammunition and dressings) |

`rollItem(context, rng, { progress, depth, only, cap })` makes one item for one surface, `rollLoot(context, seed, depth, { progress })` the contents of a container; both are pure functions of the seed and both get better with `progress` (distance from the start) and `depth` (front shelf, back shelf, the deep stock). A closed container (locker, fridge, wardrobe, safe, chest) is searched by hand and hands over its named parts, tins and cans (`game/lootGrant.ts`: parts go to the trucks or onto the ground beside it, cans are set down beside it to be lifted, tins and rounds are banked). A pickup carries a `host` (`PickupHost`: the furniture or prop kind, and whether it lies `on` it or `beside` it), and `tests/loot.test.ts` checks every generated pickup in the open world and the cities against the layout itself. The two story items (`chassis`, `fragment`) are named things too: a bare frame under a tarp, a radio board at a pylon.

**Found cars** (`sim/cars.ts`). Most cars out there are in bad shape: a few are `complete`, some `rough` (core present, two real faults), most `incomplete` (the engine, radiator and gearbox are usually still in, worn, but a random handful of bonnet, doors, exhaust, brakes, springs, tyres, bumpers, mirrors and window glass is gone), some `donor` (the engine, radiator or gearbox is gone but a good bolt-on is still fitted) and some burnt-out `hulk`s (charred core and bolt-ons still on). Near the start the road is kinder (more complete and rough cars), further out the fitted kit is better. A garage's car is half taken apart (`workshop`), a showroom's whole (`showroom`). Missing parts are the vehicle's own empty mounts (`*_none` ids, bare `tyre_none` rims), so everything the garage and the crowbar do works on them. The cabin goes the same way (`rollCar` rolls it last, by grade): incomplete cars and hulks often lack seats, the wheel or the dash, donors and showroom cars keep nice ones, a runner near the start keeps its wheel and driver's seat. The cabin stage of stripping takes the fitted seats, wheel and dash and leaves the mounts empty, and seats, wheels and dashboards are in the garage, dealership, warehouse, wreck and trunk loot tables.

### Eat, drink, piss, shit

The body has four chores (`sim/needs.ts`, pure numbers; one `Needs` per player lives on the campaign next to the drugs and is saved with it, and an old save without them starts everyone well fed). **Food** and **water** are fullness, 1 down to 0, and drain with time: with no food you are hungry by nightfall and starving the day after, water goes faster, and a sprint burns more of it (weed's munchies speed up hunger). What leaves the stomach turns into waste, so the **bladder** and **bowels** fill behind eating and drinking and also build slowly on their own.

| Slot | What it does |
|---|---|
| **Eat** | Spends a whole Ration from the convoy stores, fills you by about half, and busies your hands for a moment. Refused with nothing in the stores or on a full belly. |
| **Drink** | Takes three quarters of a litre from the water reserve (the same litres the radiators drink). Standing at a lake it is free instead, but raw water upsets the stomach a third of the time. |
| **Piss** | A few seconds standing still. Leaves a puddle and a little noise. Press the key again to stop. |
| **Shit** | A long squat, with your back turned on the world. Leaves a pile. |

Piss and shit run on their own clock: walking off, firing or aiming ends them early with what is left still in you, a hit interrupts them (and is loud), tapping the button again stops them. They are refused with almost nothing to go, in a vehicle, while carrying something or swimming.

| Body | Hungry (under 30%) | Starving (under 10%) |
|---|---|---|
| Food | slower wind recovery | much slower wind recovery, a slower walk, a worse aim, health drains |
| Water | sprinting tires you faster | much faster, a slower walk, a shaky aim, dizziness, health drains (faster than starving, fastest when bone dry) |

Starving and thirst cost health but, like a wound, never the last of it: it stops falling at 20%. A bladder or bowel past 60% shows a chip, and past 85% you are clenching (a worse aim and sprint, and a slower walk for the bowels). At 100% it simply stays full: nothing ever happens on its own, you just have to go.

At camp the night does the rest: anyone under 60% fed eats supper (one Ration; an extra one with the munchies), and anyone who has been snacking through the day skips it and keeps the Ration. Anyone under 80% watered drinks a litre from the reserve. Whoever goes without wakes hollow (and an unfed one still wakes at 65% health, and a dry reserve is on the report), and everyone wakes with a fuller bladder. HUD chips (`HUNGRY`, `PARCHED`, `NEED A PISS`, `CLENCHING`) show only while something is wrong; the convoy sheet (hold Back) lists the four levels. The first warning of a run brings up a tip. Tests: `tests/needs.test.ts`.

### Foraging

The open world feeds whoever knows where to look. Wild plants are planted per chunk like the trees (`world/forage.ts`, pure and seeded, so every plant has the same id every time), drawn as instanced meshes (`render/forageRender.ts`), and each is a hold-A spot while someone on foot is within reach (`game/foraging.ts`, through the interact registry). The rules are pure (`sim/forage.ts`).

| Plant | Where it grows | A handful | Handfuls · regrows |
|---|---|---|---|
| **Wild fig** | round springs and oases, along rivers, by lakes | eaten: food; put by: 0.35 Ration | 3 · 3 days |
| **Bramble** (blackberries) | river banks, lake shores, swamp edges, the edges of woods | food and a little water; 0.25 Ration. **Thorns** | 4 · 2 days |
| **Prickly pear** (sabra) | the hedge round every old place, here and there along dry roads | food and water; 0.3 Ration. **Spines** | 3 · 3 days |
| **Za'atar** | open dry hillsides and grass | 0.25 Medicine (never eaten) | 2 · 2 days |
| **Yarrow** | meadows | packed into a bleeding wound it stops the bleed; otherwise a Bandage | 1 · 4 days |
| **Mushrooms** | under the trees in the woods | field mushrooms: food or 0.3 Ration. Liberty caps: one dose on the drug belt. Death caps: see below | 2 · 2 days |

- **Graze or keep.** Under 78% fed (or watered, for juicy fruit) you eat what you pick there and then; otherwise it goes in the convoy's stores. The prompt says which: *Eat figs · 3 left* or *Pick figs · 3 left*.
- **Hands.** Thorns and spines tear bare hands: a few points of health a handful, and a bramble can open a bleeding scratch. Any gloves do for brambles; prickly pear needs proper gloves (fingerless ones are not enough). The heroes set out bare-handed, gloves in the bag. Gloved, thorny picking is also quicker. A **blade** on the belt (knife, machete, axe, katana) cuts herbs and pads in about half the time.
- **Mushrooms are the gamble.** They fruit in about a third of patches on a dry day and in all of them after rain. A forager who does not know a kind sees only *mushrooms (unknown)*. Hungry, they eat them and find out: field mushrooms feed you, liberty caps start a trip, and **death caps** do nothing for 45 s and then make you very sick for over two minutes (health down to a quarter, water and belly drained, retching that stops you in your tracks), never fatally, and a night's sleep sees the rest through. Fed, they look them over instead, and about half the time recognise them. Once learned, a kind is picked for what it is, and known death caps are left alone. What each hero knows is theirs (`campaign.flags`, saved).
- **Memory.** Each plant remembers the handfuls taken and the day (`WorldMemory.forage`, saved), and comes back whole once its regrow days have passed. A picked plant visibly loses that share of its fruit, flowers or caps.

Tests: `tests/forage.test.ts` (the rules, where things grow, and picking in a real scene, including bare hands in the spines, a remembered plant across nights and a reload, and a death cap's poisoning).

### Gear and the inventory

Each scavenger has a personal kit (`data/gear.json`, `sim/gear.ts`) in three parts, and the inventory screen is where you change it. Press **D-pad ←** (keyboard: `3` for Player 1, `I` for Player 2; rebindable under Control settings) on foot. The game pauses, the panel opens over the *other* half of the screen, and your own camera swings into a slow orbit of your survivor so every change shows on the model.

- **Wearing** (seven slots: head, face, body, hands, legs, feet, back). Every piece changes both stats and looks. **Armour** cuts the damage from bullets, claws, blasts and rams; **spore guard** (masks) cuts bloater clouds; **fall protection** (boots, knee pads) cuts falls; **speed** and **footstep noise** trade against each other (plate is slow and loud, sneakers are quiet, trail runners are quick); **reload** and **gun spread** come from gloves and goggles; **melee** from gauntlets; and a pack, vest or cargo trousers add **bag slots**. Fire ignores armour. Clothing is built in `render/outfit.ts` from a style and two colours per slot: 31 wearable pieces across the seven slots, in three rarities. Starter pieces use your own colours; any other body armour puts an armband in your colour on the sleeve so you are still recognisable in a split screen.
- **In hand** (the belt: four slots, plus the utility). The slot in hand decides what the on-foot buttons do, and **LB** steps along the belt, then to the throwable (flare, molotov, charge or decoy horn, chosen with hold-X as before, or in the inventory). The belt holds firearms, melee weapons and the three tools (wrench, crowbar, jerrycan), so carrying a shotgun means leaving the crowbar at home. The belt always keeps one weapon. **Guns** each have their own damage, fire rate, magazine, reload, spread, range, noise and pierce. There are twenty-one: the 9mm pistol you start with, a compact 9mm, a .38 revolver (slow, hard-hitting, punches through plate) and a .44 hand cannon; a scrap SMG, a police SMG and a machine pistol; a sawn-off, a coach gun, a pump and a combat shotgun (eight or nine pellets a shot, only the first is loud); a hunting rifle (its worn scope now really magnifies a little), a lever-action, a scrap carbine, an assault rifle, a battle rifle, a marksman rifle and a bolt sniper; an LMG with a seventy-five round box; a crossbow (a slow, heavy bolt that drops, and six points of noise against a rifle's ninety: the quiet way to play); and a recurve bow, which is drawn rather than fired and shoots arrows you can pick back up (see *The bow* below). Every gun keeps its own magazine, wear and add-ons when you swap. **Melee weapons** (knife, bat, machete, fire axe, lead pipe, sledgehammer, katana) swing on RT as well as RB, each with its own damage, reach and pace; bare hands are still the old 35. Hold RB for the silent takedown as before. Ammunition is still the one shared pool of Rounds (a crossbow bolt costs one like anything else); what changed is the *round*: the rifles, the lever, the bolt and the LMG each fire a ballistic type of their own (`sim/ballistics.ts`), with their own speed, drop, penetration and brass (a short carbine case, a nickel magnum case).
- **Customising a gun** (`sim/gunmods.ts`, `render/gunMods.ts`). Add-ons are items (57 of them, `kind: "mod"` in `data/gear.json`) that sit in the bag until fitted. Every gun declares its own slots out of *optic, muzzle, barrel, underbarrel, magazine, stock and side rail*, and for each slot which families fit: a pistol takes a pistol suppressor and a micro dot, a rifle takes a rifle suppressor, a 4x or 8x scope and a bipod, a shotgun takes chokes, a tube and a shell carrier but no sight, the crossbow takes limbs and a cocking aid. Select a gun (belt or bag) and press **Customise**: the panel lists its slots, shows what is fitted, and for the slot you pick lists every fitting add-on in the bag *with what it would change before you fit it* (bullet speed, noise, kick, aim speed, magazine, reload, spread, range, zoom). It is all buttons, so it works on the pad like the rest of the screen. X on a bag add-on fits it to the gun in hand. Effects are summed into a kit (`kitOf`) and wired into the real rules: a **suppressor** cuts the shot's Signature, flash and sound (the audio takes a low-pass for it) at a cost in speed and reach; a **scope** narrows the view while aiming (the camera's field of view is divided by the zoom, the look sensitivity is too, and a long scope magnifies the wander); a **brake, compensator, grip, stock or bipod** tames the kick and sway but may slow the sights; **barrels** (three rarities per family: improved parts) trade speed, range and spread for weight; **extended magazines and drums** raise capacity at a cost in reload; a **laser** tightens the hip shot and puts a dot where the barrel points; a **torch** throws a cone of light and a pool of light where it lands (a flat additive glow on the ground or square to the beam on a wall, so no real light and no shader recompiles), and the laser's dot has a small halo. A gun with its add-ons on is drawn that way: scope tubes, cans, grips, drums and stocks are solids on the held model, and small pictures on the inventory icon and the card on the ground. Add-ons live on the weapon (`GearItem.att`), so they follow it from the belt to the bag to a partner and into the save; a damaged save drops what does not fit, and gives back what is real.
- **Where the guns are.** `rollGunLoot(context, seed, depth)` in `sim/gunLoot.ts` is a seeded loot table for world placement: `gun_shop`, `police`, `military`, `house`, `raider`, `wreck`, `bunker` or `cache`. The same arguments always give the same weapons and add-ons; guns come dressed as their source would have them (a shop stocks sights and magazines on the counter, the army has scopes and suppressors fitted, a house has a pistol or a shotgun in a drawer and nothing else). The ordinary finds (shelves, lockers, chests, trunks, raiders) now sometimes come with add-ons fitted, or are one.
- **Guns lie where they are.** Gear on the ground is a real model, not a card (`render/gearModels.ts`, `game/groundGear.ts`): the gun's own held model with its fitted add-ons, a blade or tool, armour and clothing as folded or laid-out shapes, an add-on as a small solid. Each rests on the floor, shelf or rack at a fixed heading with a slight natural tilt (a gun on its flank on the ground, belly down on a rack), never spinning or hovering; a small name tag of fixed screen size shows only within four metres. Gun shops, police stations and armouries have wall racks (`gunrack` furniture, three tiers) and a gun on the till counter, laid out by `placeGuns` in `world/interiors.ts` from `rollGunLoot` seeded by the rack itself, so the same shop always shows the same stock. Each displayed gun is a `kind: 'gear'` pickup with a `gun` roll reference; taking it (hold A) records its id in `takenPickups`, so it never comes back. A searched locker still sets its guns down beside it as lying models.
- **The bag.** Four slots plus whatever the pack, vest and pockets add (rucksack +6, duffel +10, frame pack +14). You can't take off a pack whose pockets are holding what's in your bag. From the bag: **wear** (swapping with what is worn), **put in hand** (into a chosen belt slot), **give to your partner**, or **break down** for Scrap. Selecting an item shows what it does and how it compares with what you have on. A medkit button heals you (+60 HP) from the convoy's stock.

The Dawn Ledger has a **Gear** tab with the same screen (switch between the two scavengers at the top), so you can reorganise before you roll out. The screen itself is `InventoryView` in `ui/inventory.ts`, shared by the in-game pause screen and the Ledger tab.

Gear is found, not crafted. A searched shelf or locker (deeper is better), a delve chest (a hoard always pays in rare gear), a car's cabin and trunk (a raider's wagon most often) and a fallen raider's kit can each turn one up. Finds are seeded by the container or car, so reloading can't reroll them, they skew better the further the convoy has come, and they go to your bag, then your partner's, then become Scrap, so nothing is lost on the floor. The loadout is saved with the campaign (`PlayerSave.gear`); older saves get the starter kit, and a damaged save is repaired rather than trusted (`sanitizeLoadout`).

Tests: `tests/groundgear.test.ts` (lying models for every item, guns on racks, taken guns stay taken), `tests/weapons.test.ts` (the weapon and add-on catalogue, what each add-on does to the numbers, what fits what, state following a weapon, saves and their repair, the seeded loot tables, the models and icons, and real scenes with scopes, suppressors, recoil and a crossbow), `tests/loot.test.ts` (the loot contexts, anchors on every generated pickup, the trades, found-car odds, near-start viability, the fresh-run rebuild economy, delve chests, loose things lying still), `tests/gear.test.ts` (the catalogue, capacity and stat rules, equip and unequip, sharing, save repair, loot odds) and `tests/gearplay.test.ts` (real leg scenes: armour, speed and noise, the belt and LB, each gun's numbers and magazine, melee weapons, the inventory key, saves, finds and the inventory camera).

### The bow

A **Recurve Bow** (`w_bow`, model `bow`) turns up in gun shops, houses, raider stashes, wrecks and caches. It is a gun to the
belt, the inventory and the save, but it is used differently, and its rules are pure in `sim/archery.ts`:

- **Draw and loose.** Hold RT (left mouse) and the string comes back over 0.7 s; let go and the arrow flies as hard as it was
  drawn (`loosePower`: a snatched quarter draw is a slow, weak, wild arrow, a full draw drops a walker). Under a fifth of a draw,
  letting go only eases the string down. LT still steadies and slows the walk; a drawn bow also slows you and stops a sprint.
  Full draw can be held for 1.8 s; after that the bow shakes more and more and it costs stamina, and when the wind is gone the
  string comes down on its own. There is no room to draw from a car seat.
- **Arrows** are their own stock (`campaign.items.arrow`, saved; old saves start with none), not Rounds. A found bow comes with
  a quiver of 8, and the camp crafts 6 for 3 Scrap. The next arrow goes on the string by itself after each shot (half a
  second); X nocks one by hand.
- **In the air** an arrow is an `arrow` round in `sim/ballistics.ts` (80 m/s at full draw, so it arcs and has to be led: about
  half a metre low at 40 m past its 25 m zero), drawn as an arrow, not a tracer. It sticks in what it hits rather than going
  through: a body, the ground or a plank wall stops it, a pane of glass breaks and lets it on. It barely marks a car, is hardly
  heard (3 points of noise; travellers do not react to it), and kills quietly, which keeps a herd standing (see *Hunting*).
- **Getting them back** (`game/arrows.ts`). Landed arrows stay where they hit: in the ground at the angle they came down, in a
  wall, or in a body that walks on with them in it and drops them where it falls. Walk up to one and it goes back in the quiver.
  Some break when they land (`BREAK`: few in earth, wood or flesh, most on stone and steel). Up to 48 lie about at once.
- **Seen.** In third person the bow is in the left hand, raised along the aim as it is drawn, the right arm solved onto the
  string (`Humanoid.bowPose`/`reachTo`); in first person (`ViewModel.bowBase`/`bowHands`) the bow arm comes up from the lower
  left and the draw hand sits low on the right with the arrow running in to just under the crosshair (the string's travel and
  the arrow are shortened there so the hand stays in front of the near plane). The limbs bend and the string comes back with
  the draw (`render/bow.ts` `BowRig`). The reticle closes with the draw and a ring round it fills: gold at full draw, red once
  the arm shakes. The string twangs, creaks as it loads, and an arrow thunks home.

Along the way the extra guns (everything past the first six) are now treated as guns by the rigs, so they get their sights and
flash in first person (holding one in first person used to throw every frame), and the crossbow lost its pistol flash, its
dropped pistol magazine and its sniper-rifle report.

Tests: `tests/bow.test.ts` (the draw, power, shake and breakage rules, the arrow's flight numbers, the rig bending, every gun
posed in first person, the arrow in the first-person view and the third-person arms on the string, and real leg scenes: drawing
and loosing, a tap, no arrows, a tiring hold, an arrow riding in a walker and falling out where it drops, an arrow stuck in the
ground and pulled out, breakage, the quiver with a found bow, the save).

### Ballistics, weapon handling and gore

Shots are real objects now. `Combat.shoot` still takes the same arguments, but instead of an instant ray it launches a round that `Combat.update` flies one tick at a time (`game/combat.ts`, rules in `sim/ballistics.ts`).

- **Flight.** Each round has its own muzzle speed, drag and mass (pistol, .38, SMG, shotgun pellet, hunting rifle, the raiders' sniper, vehicle guns). Gravity pulls it down and quadratic drag against the *air* slows it, so a **dust storm's wind** (`windAt` in `sim/weather.ts`, the same direction the dust leans) pushes it sideways: light, slow pellets drift most, a rifle round hardly at all. Sights are zeroed per round, so the drop only shows past that range. Pad aim assist now leads a moving target by the flight time. Speeds are game-scaled, slow enough that a long shot has real flight time, fast enough that a street is still near-instant.
- **Penetration.** A round that arrives at a wall measures the slab with a second ray from the far side and compares its remaining energy with what the material asks for (`SURFACES`): planks and plaster stop pellets but not a pistol, corrugated sheet and car bodies need a .38 or better, and nothing in the kit goes through concrete or the ground. What gets through leaves slower (so it hits softer), a little off true, with a puff and a hole on the way in. Buildings carry a `mat` on their wall boxes by look (barn and house wood, shack and warehouse sheet, shops plaster). Only the heavy rounds come out of a body, into whoever is behind it.
- **Handling** (`sim/handling.ts`, per gun model). Each shot kicks the view through four springs (muzzle climb, twitch, camera roll, push back) that snap up and settle; the shot follows the kicked view, so a long burst climbs. Aim-down-sights is a spring too: a pistol is up in about 0.13 s, the rifle takes 0.33 s and rings slightly past the mark. The barrel wanders (breathing and tremor), less behind the sights or crouched, more when moving or winded, and the arms in the model take the sway and the buck. Brass leaves the gun as it should: a pistol or SMG throws a case with each shot, a bolt rifle or pump after the action cycles, a revolver and the sawn-off hold their empties until the reload opens them. Cases (`render/brass.ts`) tumble, bounce off the floor with a ring, roll to a stop and stay.
- **Gore** (`game/gore.ts`, `render/decals.ts`, `render/gibs.ts`). Every hit sprays blood along the bullet's path and mists back at the shooter, then casts forward: the spray lands as a streaked, persistent **decal on the wall or road behind the target** (a ring buffer of 720 marks in one draw call; blood is wet red when it lands and dries to brown over a minute; bullet holes stay). Bodies leave pools and smears thrown the way the shot went, and drop facing the shooter. A round's *momentum* shoves a zombie back (a blast of pellets throws a walker about a metre, a brute barely moves) and the body reels. Heavy rounds (pellets, the rifle, vehicle guns, a .38 a little) accumulate damage per limb and take it off (`wound`): arms and legs fly as gibs with a trail of blood and a bleeding stump, a head shot takes the head, a far-overkill blow tears an arm off the body it hit, and a blast that kills tears one to three pieces off. A body without legs drags itself at a fifth of its speed, one leg is a limp, no arms halves its claws. The zombie shader hides the part and caps the stump raw red; the cut limb is a pooled instanced gib.

- **Breaking things** (`game/destruction.ts`, `sim/breach.ts`). Wall pieces of the roadside buildings have hit points by material (glass 12, plaster 150, wood 220, corrugated sheet 260; concrete and brick are untouched) and take damage from bullets, blasts and fast heavy vehicles (a ram spends its kinetic energy on the wall). **What hurts what** (`structuralMul`): a pistol, SMG or raider round does nothing to a wood or plaster wall (it leaves a small hole) but shatters glass at once and chews sheet metal slowly; a .38, shotgun pellets, a rifle and mounted guns do real harm, and blasts (charges, mines) are all damage. Intact windows are real panes (a collider that stops people), and any bullet breaks one and carries on through it. Every hit first leaves a bullet hole and dust; a piece that has had enough opens a **breach** in the building's *plan* (folding any door or window it reaches into one gap, a person wide for bullets, up to 3.8 m for a blast). Everything that reads the plan follows: the building mesh is rebuilt with the ragged opening and rubble, the wall's colliders are swapped (`wallAabbs`) so you can walk through, the dead get a new doorway, and the cached chunk data is edited in place, so streaming the chunk back keeps the hole. Splinters, plaster and sheet fly off as debris, the crash carries (noise). Flimsy barricades break under fire; reinforced ones still need a charge. Explosions (`Combat.explode` at radius 3 or more) also char the ground. A hit on a moving thing (a vehicle) leaves a spark but no hole, since a decal would stay behind in the air.
- **Marks that stay** (`render/decals.ts`, own 1100-slot pool apart from blood). A hit on a wall leaves a hole as wide as the round made it (about 9 cm of mark for a pistol, 16 cm splintered for a rifle, 21 for a mounted gun, 5 for a pellet): a black pit in a ragged ring of pale exposed material with splinters, plus chips thrown back; a heavy round leaves a bigger splintered one. A round that goes through leaves a second, ragged exit hole on the far face with debris blown on ahead. Earth and stone keep a scuffed pit. A shipping container is hollow sheet steel: a pistol round goes through one skin but not both, a rifle round goes through both. Boxes that only stand for something round (rocks, tanks, pillars) keep no mark, so none hangs in the air beside them. A wall that is wearing down cracks round the spot at two thirds and one third strength. Wood and sheet breaches throw whole planks. Marks on a stretch of wall that comes down are removed with it.

- **Muzzle and tracers** (`sim/weaponfx.ts`, `render/particles.ts`). Each gun throws its own flash down the line of the barrel: a core, a tongue of flame, burning grains and a wisp of smoke that hangs behind (a sawn-off is a fireball, a pistol a snap). Every shot also flashes one shared light on its surroundings, so night fights light the people in them. Tracers are drawn per round type, fade out over their life, are warmer and redder for raiders, and only a share of rounds are drawn (a burst of pellets or SMG fire is not a wall of lines; a rifle round always is).
- **Skips and impact sounds.** A glancing round on something hard (steel, stone, concrete, sheet, a car body; never wood, plaster or earth, never a pellet) skips off instead of stopping: it leaves at a third to two thirds of its speed, scattered a little, with 40% of its damage, a shower of sparks and a whine. Only once per round. Rounds that land now sound: a ring on metal, a dull crack in stone, plaster or wood.
- **Sustained fire opens the spread.** Each shot adds *bloom* (per gun, `BLOOM`), which widens the next shot and the reticle, and closes up between shots. A slow gun has nearly closed up before its next round; an SMG held down walks off the target (up to 2.2 times its spread), and a pistol held down opens to 1.7 times. Braced behind the sights it opens less.
- **Ground impacts** (`sim/groundImpact.ts`). Every gun uses its round's mass and remaining speed to size the strike: pellets make separate small pits, pistols small puffs, full-power rifles stronger plumes. Glancing hits leave longer marks and raise less soil. Sand throws dust and grains, mud clods, asphalt and masonry small chips; rain and grass suppress dust. Debris leaves along the surface normal and falls under gravity. Arrows and crossbow bolts land as visible shafts without firearm sparks or ricochets; bolts are shorter and do not enter the bow's quiver. Looking down with a melee weapon strikes reachable ground, with heavier tools disturbing more soil. Molotov bottles scatter glass and burning fuel without a detonation. Ground explosions throw debris and scorch according to their height; high airbursts leave no ground scorch. These effects use the existing bounded particle, fragment and decal pools. `tests/groundImpact.test.ts` covers the catalogue, materials, energy and angle, physics hits, melee contact, thrown fire and blasts.
- **Reloading.** A pistol or SMG with a round still in it reloads in 78% of the time (no slide to rack); the pump loads a **shell at a time** (each shell is a click, a full reload takes the gun's reload time, a part-empty one less) and pulling the trigger stops the loading and fires what is in. The revolver, sawn-off and rifle still take the whole reload at once.
- **Melee has weight.** Each weapon has its own swing: a knife is a flick, an axe a long chop, and the blow **lands as the arm comes through**, not on the click (about 0.13 s for the knife, 0.25 s for the axe; the weapon's blade comes over the top and down in front, and a streak is drawn along the tip's path). Each weapon has its own knockback and stagger (a bat throws a walker about 9 m/s and staggers it nearly a second, a brute barely moves), cleave (an axe goes through three bodies, a knife one), whoosh pitch, hit sound and shake. A blow that lands hangs the arm for a moment, jolts the view, rumbles the pad and sprays what it hit back along the swing.
- **Thrown fire.** A flare and a molotov are things you can see, tumbling end over end as they fly, with a trail of sparks or flame and smoke. A molotov bursts on the first body it reaches (a walker or a raider) or the ground, in a fireball with embers flung along the ground and a scorch; a burning patch now has taller flames, black smoke, flying embers and a flickering light that dies down as it burns out.

Tests: `tests/destruction.test.ts` (the breach rules, and real scenes breaching a building by gunfire, blast and ram-sized damage, barricades), `tests/ballistics.test.ts` (flight, drop, wind, penetration, the wound rules, kick and ADS springs, and real leg scenes: time of flight, a plank fence, a thick wall, a round through two bodies, a shotgun's shove, dismemberment, wall splatter, brass and kick) and `tests/weapons.test.ts` (the muzzle, tracer, bloom, reload, skip and melee tables; bloom, reloads, the pump's shells, melee timing, cleave and stagger, skips off steel and thrown fire in real leg scenes).

### Weight, inertia and weapon handling

On foot you move, and handle a gun, like a tactical shooter (`sim/gait.ts`, `sim/weaponanim.ts`, `render/humanoid.ts`).

- **The body has weight.** Speed builds over about a fifth of a second and a sprint takes most of a second to reach; braking is quicker than starting, and a reversal passes through the slow part. A rifle (0.91), pump (0.93) or fire axe (0.94) is slower to carry about than a pistol (1.0); a knife is a touch quicker.
- **The view follows the feet** (first person). The eye bobs and sways in time with the steps, wider in a sprint, smaller crouched and almost still behind the sights; it leans a little into a sidestep, dips when you land (more the harder the landing), and standing up from a crouch takes a moment instead of snapping.
- **Sprinting lowers the gun.** In a sprint the gun is carried low across the chest and cannot be fired until it is back up (a fraction of a second after you stop). Aiming cancels the sprint.
- **Drawing takes time.** Swapping to a weapon brings it up from low ready over its own time: a pistol 0.32 s, a rifle 0.72 s, a knife 0.2 s. A gun cannot be fired until it is out.
- **A wall in the way pushes the gun up.** Within the gun's length of a wall the muzzle comes up and the gun is pulled in to the chest, sooner for a long gun; with the muzzle against the wall it cannot be fired.
- **Every reload is a routine.** A pistol or SMG tips the gun, the hand goes to the belt for a fresh magazine and back, and the slide is racked; a revolver or break-action is opened muzzle up and snapped shut; a pump is canted over and takes a shell at a time (the hand goes to the pouch for each); a bolt rifle throws its bolt, takes rounds and runs it home. A pump or bolt is worked after every shot, and the case leaves at the end of the stroke.
- **The gun has weight in the hands.** It lags behind a turn of the view and swings back, rocks with the steps and bucks back toward the shoulder with each shot.
- **Iron sights are real.** Every gun has a rear and a front sight (a notch and a post with a pale dot; the rifle is aimed down its scope, an open tube with a fine crosshair). In your own first-person view, aiming puts the rear sight on the line from your eye and the sight line straight down it, close in (a handgun at 0.38 m, a long gun at 0.27 m). Recoil then plays on top of that sight picture, so each shot kicks the sights off the line.
- **Dropped magazines.** A pistol or SMG drops its empty magazine from the magazine well at the right moment of the reload (a short pistol magazine, a longer SMG one). It falls with a little of the hand's push, tumbles, clatters off the floor and stays where it lands. Revolvers and the sawn-off drop their empties as brass, and a pump or a bolt rifle drops none.
- **The muzzle flash is a flame, not a ball** (`render/muzzleFlash.ts`). From in front a white-hot core with uneven petals, from the side a tongue of fire thrown out along the barrel with a bright bulb at the muzzle; each shot has its own shape and turn, it lasts a couple of frames (`FLASH_SECS`), fading and spreading as it goes, and each card fades as it turns edge-on so it never shows as a line. Sized per gun (`MUZZLE[gun].star`/`tongue`: a pistol's is about a hand across, a sawn-off's nearly three times that); the glow sprites round it are now a soft halo. The shot's light is gentle and sits out in front of the muzzle (`MUZZLE_LIGHT_POWER`, `MUZZLE_LIGHT_AHEAD`), so it lights the surroundings without blowing out the shooter; raiders throw the same flame from the gun in their hands.
- **Smoke and shells come from the gun.** The flash, its light, the powder smoke and the ejected case start at the real muzzle and ejection port of the gun as it is drawn (in first person that means where you see it, not where the body is). Powder smoke is denser, greyer and hangs for a couple of seconds, a thin wisp curls off the barrel for a few seconds after a shot (longer after a shotgun) and off the breech as each case leaves; cases and magazines sit a little proud of the ground so they show on rough terrain, and sprites close to the lens no longer vanish.
- **First person is a body camera** (`render/viewmodel.ts`). Your own arms and weapon are drawn in the camera's space, so they sit in the same place on screen whichever way you look: two whole arms from shoulders below and behind the eye (a two-bone reach with a wrist, so the hands never leave the grips and the forearms run off the bottom of the frame), gloved hands closed round the grip with the thumbs laid forward along the frame, the support hand on the fore-end of a long gun. A handgun is held low in the middle in both hands, a long gun low with the stock in. On top of that the gun trails a turn of the view, rocks and cants with the steps, swings out against a sidestep, drops with a landing, breathes at rest, kicks back into the hands, goes low and across for a sprint, comes in to the chest for a reload (the support hand off to the belt) and up against a wall. Melee weapons are held up in the right hand and chopped over and across; bare hands jab. The body **leans** into a sidestep and into a turn of the view (harder on the move and in a sprint, hardly at all behind the sights), which rolls the view and tilts the survivor a partner sees (`leanTarget`/`stepLean` in `sim/gait.ts`). The **bodycam lens** (Control settings, *Camera & play*, 0 to 100 %, default 70 %) draws your first-person view through a wide barrel lens: the middle keeps its size, the rim takes in more and bends, with colour fringes and a darker rim (resampled with a Catmull-Rom filter, so the stretched middle does not band). A load in the arms, hands at work on a car and a greeting still use the third-person rig's forearms.
- **The hands keep busy, and clear their own jams** (`sim/gunDrills.ts`). Every weapon has its own habits, played now and then once things have been quiet a couple of seconds (no shot, no sights, no reload, no sprint): the support hand opens and re-grips, the firing hand works up the grip, a long gun is eased forward and settled back into the shoulder, the support hand slides along the fore-end or pats the magazine home, a pistol gets a press check, a revolver's cylinder is rolled under the thumb, a pump is pressed home or its port checked, a bolt handle pressed down, a lever squeezed, a crossbow bolt seated, a belt gun heaved up; a knife is rolled through the fingers, a blade flicked or turned to look along the edge, a haft slid along, a wrench tapped into the free palm. Any of them lets go the moment the trigger, the sights or a sprint need the hands. A trigger pull can also fail (rarely in a sound gun, about one in a thousand; often in a worn-out one), and each action clears it its own way: a pistol is tapped and racked (a stovepipe swept, a double feed racked three times), a rifle's charging handle run, an AK-style carbine racked with the firing hand, a police SMG's handle locked and slapped, a revolver turns to the next chamber (or its cylinder is knocked out and turned), a pump is run again or the stuck shell picked out, a break-action thrown open and the dud flicked away, a bolt gun's bolt worked (or slapped up off a stuck case), a lever gun's lever thrown, a belt gun's feed cover opened, the belt seated and the handle charged, a crossbow bolt pushed back on the latch. The round in the chamber is lost and flies out of the port, and the clearing does not refill the magazine (it used to). The hands move from spot to spot on the weapon, open their fingers for a slap or a let-go, and tuck their elbows so the lens does not cut the sleeves; a partner sees the gun turn and the support arm leave it. All numbers and every routine are in one table.

Tests: `tests/gunDrills.test.ts` (every weapon has habits and every gun its own clearing; each routine starts and ends at rest with the hands on their grips; the first-person arms stay joined and clear of the lens through every frame of every routine; a palm lands on the magazine and a hand on the slide; a knife turns in the fingers; a drill fades out cleanly; a worn gun faults, clears without filling the magazine and fires again; habits start when calm and stop for the trigger; every action clears in a real scene). `tests/bodycam.test.ts` (the gait, inertia, draw, wall, reload and rack rules; the rig's poses; the sights lined up on the eye for every gun and projected through the camera in a real scene; the magazine pool and the reload that drops it; effects starting at the drawn muzzle and port; the first-person arms: hands on the grips, bones joined, arms running off the bottom of the frame, the same on screen at any pitch, the melee swing, the lean and the lens setting; and real scenes: speed ramps, the sprint carry blocking the trigger, drawing, a wall in front, animated reloads, the first-person eye, a sidestep leaning the view).


### Cars, parts and the garage

Every car standing in the world is a real vehicle. Hatchbacks, sedans, pickups and vans (`vehicles.json` `cars`) are streamed in as the convoy approaches and put away, with their state, once it moves on (`game/cars.ts`). Each car rolls its condition from its seed: a **burnt-out hulk** (strip it for parts), a **rough runner** with at least two real faults (flat tyres, a seized engine, a leaking tank), or one **sound enough to drive**. Roadside wastelands also have stalled-traffic jams on the shoulder, and city boulevards are full of them.

- **Take any car.** Walk up and press Y. Climbing into an abandoned car claims it for the convoy and adds it to the **yard** (six vehicles). Whatever you drove last rolls out with you. A second player can ride along as passenger, or as bed gunner in a pickup with a gun mount.
- **Gunfire holes a car, it does not blow it up.** A bullet takes only a share of its damage out of the hull (`BULLET_HULL` in `sim/damage.ts`, scaled again by how hard the round is on sheet metal: a pistol round about a third of a rifle's), so a hatchback takes a few magazines of pistol fire. What a round breaks is what it lands on (`Vehicle.zoneAt`): a wheel's tyre goes easily, the engine bay takes a few rounds to kill the engine (and holes the radiator), the tank low in the tail leaks, and a door or a wing breaks nothing. Bullets alone never finish a car: shot down to a tenth of its health its engine quits and it smokes, but it stays a car you can repair or strip. Blowing one up takes a blast, a hard crash or a fire burning it out.
- **Repair is real work.** With the wrench, hold A: the most urgent fault is fixed in turn (fire, leak, tyre, engine, weapon mount, bodywork). Each job names its cost, such as a tyre patch for 2 Scrap or an engine rebuild for 3 Parts. With no Parts, an improvised Scrap job still works so nobody is stranded. A convoy engine below 10% will not start until rebuilt.
- **Strip what you can't drive.** With the crowbar, hold A on a hulk or an abandoned car to take four stages: the tyres, the engine with its gearbox and exhaust (and the oil in the sump), the bodywork and running gear (bonnet, doors, springs, brakes, radiator, every bolt-on, and the water), and the cabin and trunk. You get exactly the named parts that are fitted, as worn as they are, and the car loses exactly those (`sim/salvage.ts`, `stripBuild`): a car with no engine has none to give. No Scrap, Parts or Tech comes out; a full trunk sets the rest on the ground beside the car. Raider wrecks carry better kit, and a gun now and then (`rollGunLoot`). The loot is fixed by the car's seed, so leaving and coming back can't reroll it. The jerrycan siphons fuel from abandoned tanks into the convoy reserve.
- **Parts are items** (`data/parts.json`, `sim/parts.ts`): aftermarket parts across twenty-two slots (engine, radiator, gearbox, exhaust, springs, brakes, tyres, bonnet, both doors, armour, weapon mount, fuel and cargo, plus front, roof, rear and side mounts, and the cabin: driver, passenger and rear seats, steering wheel and dashboard), in three qualities with a wear value. Every car's factory engine, radiator, gearbox, exhaust, springs, brakes, tyres, bonnet, doors, seats, wheel and dash are parts too. An engine, radiator, tyre set or armour kit replaces a damaged component, so swapping in a good one repairs it. Parts turn up in salvage, in yards and settlements, beside parts wrecks, and can be fabricated at camp.
- **Everything is picked up by hand.** Nothing is collected by walking or driving over it: stand next to ration tins, a pill bottle, a medkit, a bandage roll, a box of rounds, a radio board or a salvaged chassis and hold A to take it straight into your stock.
- **Carry things by hand.** Loose parts, fuel cans, water cans, oil cans and spray cans lie where their [loot context](#loot-what-lies-where) puts them: on benches, shelves, engine stands and racks in buildings, beside pumps, drums, tyre piles and containers, and beside wrecks. On foot, hold A to lift one (you walk slower, can't sprint, and your gun and tools are out of reach). At one of your own vehicles, **A** puts it straight on, at the right place and in the right order (bolt the part on at its mount, pour the fuel in at the flap, top the oil up under an open bonnet: see [Working on a vehicle](#working-on-a-vehicle-where-and-in-what-order)); **X** stows it through an open boot or back door, and **X** anywhere else sets it down. Climbing in with full hands stows the load if you are at an open boot, and otherwise sets it beside the car. What you put on the outside of a car is drawn on it (`render/cargoLoad.ts`); what is stowed inside is not: see [Securing cargo](#securing-cargo-inside-in-a-holder-or-loose). Code: `sim/carry.ts` (what a fit or stow does, and what blocks it), `game/hauling.ts` (the input, prompts and carried-item state on `Player`), `LegScene` (`loose`: lifting, dropping and taking goods).
- **Work on the car with your hands.** Every car has access points: the engine bay, each wheel, the doors, the boot, the fuel flap, the underbody, a flank, the roof, the front bumper, the gun post. Walk up to one of your cars with the wrench out (or a part in your arms) and a glowing dot marks the points that have something to do; the one you are standing at (within about a metre and a half, facing it) gets a ring and a callout naming what is there and what to do first. With the wrench, hold **A** to unbolt it (a set of tyres comes off all four wheels): the part leaves the car, which visibly loses it, and flies into your arms. Carry a part to its own point and hold A to bolt it on; the old one is stowed. A worn stock part is repaired by hovering it, and anything fitted is repaired from anywhere else on the car. Every part has its own model (engine block, tyres, plate stack, gun mount, tank, roll cage...), the same in the hands, on the ground and on the car. **X** at an open boot puts what you carry inside it (secure, not drawn), **X** at the roof or a pickup's bed sets it on the outside (see below); **X** again with empty hands takes the nearest one back out. The wrench menu on **X** (`paint & oil bench`) is only for paint and oil: parts are fitted and pulled at the car, and the oil and water buttons work only while you stand at the engine bay with the bonnet open. Code: `game/carwork.ts` (wrench jobs, taking things out of the boot), `render/partModels.ts`, `render/cargoLoad.ts` (per-item deck layout), `render/workFx.ts` (`focus` markers, `eject`).
- **Engines burn oil.** Every convoy engine has a sump (`comp.oil`, 0 to 1; `sim/oil.ts`): a full one lasts about 14 km at baseline Drain, a shot-up engine bleeds it, and a worn engine burns it faster. Below 25% the engine loses power; run dry and it wrecks itself until it seizes. Cans (half a sump each) come from the roadside, settlements, and from draining an engine with the crowbar. Top up from a can in your hands, from the convoy's reserve with the jerrycan tool (both standing at the engine bay with the bonnet open), or with the **Top up oil** button in the garage (and the workbench, at the open bonnet). A full service and an engine rebuild both put fresh oil in.
- **Fit them at camp.** At camp the Ledger has a **Garage** tab with both players' vehicles live in side strips: fit and remove parts, fabricate, paint (twelve colours, stripes), service, assign who rolls out in what, or break a spare vehicle down. Mid-leg, wrench + X opens the **workbench** for one of your own vehicles (paint, spray cans, oil and water; no fitting, since that is done at the car). Every part is visible on the model: bull bars, dozer blades, roof racks, light bars, spare wheels, side plates, fuel cans, fixed or bed-mounted guns.
- **Parts change driving.** Power, top speed, grip, suspension, off-road ability (a road car loses far more speed in sand than a buggy), armour by side, fuel capacity and burn, noise, zombie plough width, ram damage and headlight reach all come from what is fitted. Cargo space sets how many spare parts the convoy can carry.

#### Engine swaps, fuels and heat

Any engine goes in any vehicle: a V8 in a hatchback, a scooter motor in a van, a petrol engine in a diesel van. Nothing is refused; the numbers decide whether it is a good idea.

- **Engines are real** (`EngineSpec` in `data/parts.json`, maths in `sim/engines.ts`): litres, kW, kilograms, a size class 1 to 5 and a fuel. 17 engines from a 50cc scooter motor to a 14.5 L rig diesel; the first three tune-up ids (`eng_i4`, `eng_v6`, `eng_v8`) are unchanged so old saves load. Each chassis is balanced around its **factory engine**, so a stock vehicle is exactly what `vehicles.json` says, and fitting another engine scales the chassis by how the two compare: output with diminishing returns (a tyre can only put so much down), weight that sags the suspension and costs grip, fuel burn, and noise (so Signature).
- **The engine bay and real sizes.** Every engine is drawn at its real size from its spec (`sim/engineSize.ts`: litres, cylinders, layout, size class; `render/engineModels.ts`: single, inline, vee, boxer, blown, turbo diesel, rig diesel, each with its own family colours, belts, hoses and wear), and every chassis has a real bay derived from its model's bonnet (`bayVolume` in `render/attachments.ts`). An engine of the bay's class or smaller sits entirely under a closed bonnet with clearance and nothing shows above it. A bigger one: *snug* raises a painted bulge in the bonnet, *tight* leaves the bonnet propped open on it, and one three classes over cannot be closed over at all (*"Does not fit under the bonnet: cut the hood or remove it"*). With the wrench at a shut bonnet you can **cut a hole in it** (hold A, permanent: the bonnet becomes `hood_cut`, a jagged opening the engine stands through, with a little less armour and better cooling), or pry the bonnet off with the crowbar. Tests: `tests/enginebay.test.ts`.
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
- **Taking things off.** In the garage every mount has a *Take it off* button. In the field, the **crowbar** pries the part you face off your own vehicle (hold A) and you carry it away or stow it with X; a shut panel is what you work on, and with it open it is what is behind it (the engine under an open bonnet, the seat behind an open door); if the panel is in the way, the first hold opens it. Parts come off carrying their wear.
- **Forecasts** (`sim/forecast.ts`) cover all of it: before you fit anything the garage says what it does to power, top speed, range, heat, gearbox strain, spring load, braking, oil and water volumes, and what no bonnet, no door or a bare wheel costs.

#### The cabin: seats, wheel and dash

The inside of a car is a set of real parts, fitted, pulled and swapped like the bonnet and the doors, and each one can be missing.

- **Slots.** `seatD` (driver), `seatP` (passenger), `seatR` (rear seat), `steer` (steering wheel) and `dash` (dashboard). A front seat fits either front mount (like a door fits either side); a rear seat only the rear. Hatch and sedan have all five; pickup and van have no rear seat (a bed or a cargo box is behind the cab); the buggy has `seatD`, `steer` and `dash` (its second seat is bolted in); bikes, quads and rigs have none. `data/index.ts` exports `INTERIOR_SLOTS`, `INTERIOR_STOCK` (factory part per slot: `seat_std`, `bench_std`, `steer_std`, `dash_std`) and `INTERIOR_NONE` (the empty part per slot: `seat_none`, `bench_none`, `steer_none`, `dash_none`). A build with an empty `fit` has all of them, so old saves load with a stock interior. To strip one, put the placeholder in the slot: `fit.seatP = newPart('seat_none')` (or `removePart`). `cabinGaps(def, fit)` (`sim/cabin.ts`, re-exported by `sim/parts.ts`) says what is missing.
- **Variants** (`data/parts.json`). Seats: torn cloth, racing bucket (+2% grip, driver only), padded leather, plated (rear and side armour). Rear seats: torn cloth bench, fold-flat bench (+1 cargo), cargo rack (+4 cargo). Wheels: small sport wheel (+10% lock), chain-wrapped (a little noisier). Dashes: cracked, gauge pod (-2% fuel burn, a brighter lamp). Each has its own model, drawn by `render/cabinModels.ts` and used on the car, in the hands (`partModelKey` returns `part:<id>`) and on the ground; the empty parts have models too: bare floor rails and a loose belt, a column stub with a loom of wires, a cross-beam with the wiring hanging out.
- **What a gap costs** (`parts.json` `interior`, rules in `sim/cabin.ts`). No steering wheel: the lock drops to 18% (a creeping hatchback can barely turn, but it still goes straight, so nobody is stranded). No driver seat: you sit on the floor (the hips and eyes drop, grip x0.94, gun spread x1.35). No passenger seat: nobody can ride beside the driver (a pickup's bed gun still has its post), and the empty mount is +1 cargo. No rear seat: +2 cargo. No dash: the lamps flicker (-30% headlight). The HUD vehicle card, the garage summary and the forecast under each candidate part all say so.
- **Garage, hands and field.** The garage has a Cabin group of mounts. `render/sockets.ts` puts a socket on each (inside the body), so a carried seat outlines the seat mount; the crowbar pries the part you face off (panels win a close call, so a door comes off first, then the seat behind it shows); the wrench unbolts it from the mount dot. Code: `sim/cabin.ts`, `render/interior.ts` (layout, `drawCabin`, `seatOccupant`), `render/cabinModels.ts`.
- **How it is drawn.** The cabin is a mesh of its own (`VehicleVisual.interior`, cached and shared between identical cars), not baked into the body shell, so swapping a seat does not rebuild the bodywork, a door that is off or a window that is broken shows the seat, the wheel and the dash in full, and a later change can swing a door, the bonnet or the boot open over it. It carries a faint light of its own (the roof keeps the sun off it). The wheel's rim is a turning mesh (`steerWheel`); the occupants are sat on the cushion with their feet on the floor (`VehicleVisual.seat`, every frame), and a car with no seat puts the driver on the floor. The old interior was a dark core box that filled the whole cabin up to the belt line, hiding the seats and the floor, with the people standing through the roof; that box now only fills the engine bay and the boot or bed.

#### Attach points and inspecting parts

- **Sockets** (`render/sockets.ts`). Every slot is a physical place on every chassis, derived from the model's own mount data: the engine under the bonnet, the radiator behind the grille, tyres at each wheel, plates on the doors, the bonnet, each door, the gearbox under the floor, the exhaust at the back. Carry a part up to a vehicle of yours and its sockets are outlined; when you are within reach the outline turns green and fills, with a tag at the spot (*"Radiator / Now: Sedan Radiator 100% / Attach Medium Race Radiator"*). Markers are small and screen-sized (`render/markers.ts`): a thin outline hugging the socket (the engine socket is the room of the bay, not the bonnet), a small dot per mount, a thin ring, and a tag of at most two short lines at about 14 px at 1080p that follows the UI scale and each split-screen half's height; all are drawn bright where in view and faint behind bodywork. Stand somewhere else and the prompt names where to go (*"Go to the engine bay at the front to fit ..."*); the outline is red while the place is right but the bonnet is shut. Hold the button to bolt it on. From afar a tyre shows an outline at every wheel; up close only the wheel it would go on.
- **Inspect tags.** Looking at a loose part (or holding the wrench or crowbar by your own car, which aims at the socket in front of you) shows a tag with its name, condition and the one number that matters (*"Medium Race Radiator / 38 % / Cooling - 190 kW"*). Held and loose engines, radiators and tyres have models of their own.

#### Spray paint

Panels (bonnet, roof, both doors, front and rear end; a bike or quad has front and rear) can each be a different colour from the rest of the vehicle (`sim/paint.ts`, baked into the model by `render/paintJob.ts`). Fresh paint covers the rust on that panel. In the garage pick *Whole vehicle* or a panel, then a swatch. In the field, a **spray can** is carried by hand like a part: you find them in car trunks, or take one from the workbench (wrench + X) in the colour you last picked; face a panel of your own vehicle, hold the button, and it is rebuilt in the new colour. Each can covers six panels and cannot be stowed, only put down. A bonnet or door that has been taken off has nothing to spray; one that is open sprays as well as one that is shut.


#### Working on a vehicle: where and in what order

Everything you do to one of your own vehicles has a place and a sequence (`sim/access.ts` is the rules table, `render/accessPoints.ts` the geometry, `game/access.ts` where you stand). Each job is done standing within about 1.5 m of its **access point**, facing it (2.3 m for the roof); standing anywhere else the prompt says where to go (*"Go to the fuel flap at the back (right side) to pour the fuel in"*), and a panel in the way gets opened first (*"Open the bonnet  ·  then fit Tuned V6"*).

| Job | Stand at | Needs |
| --- | --- | --- |
| engine, radiator, pour oil or water | bonnet (engine bay, at the nose) | bonnet open or missing |
| bonnet, doors (off or on) | their own panel | open or shut; a door is never swapped in place, the old one comes off first |
| tyres, springs, brakes | a wheel | nothing |
| gearbox, exhaust | underbody, beside the sill (either side) | nothing |
| fuel, drain the tank, siphon an abandoned car | fuel flap (rear flank, right side) | nothing |
| driver's seat, wheel, dash | driver's door | that door open or missing |
| passenger seat | passenger door | that door open or missing |
| rear seat | either door | that door open or missing |
| stow a carried item inside (X), take one back out (X, hands free) | boot, tailgate or rear doors; either door of a car with a back seat, a pickup's cab or a buggy's seat well; a bike's panniers | the lid or door open (a bike's panniers are always open) |
| put a load on the outside (X) | the roof, a pickup or buggy bed (at the tail), the jerrycan rack (flank), the spare carrier or rear cage (rear) | nothing; stand back from the doors to reach the roof |
| armour, side, rack and tanks, roof, front, rear, gun post | the flank, roof, bumper, tail or gun post | nothing |
| spray paint | face the panel | bonnet and doors present, shut or open |

- **Panels.** The bonnet, both doors and the boot lid (sedan boot, hatchback tailgate, van rear door) open and shut. With empty hands (or a tool with nothing else to do there) stand at one and hold **A** for half a second: *Open the bonnet* / *Close the bonnet*. The hood hinges up at the cowl, doors swing on their front hinge, a boot lid lifts at its front edge and a van's rear door at the roof. The panel leaves the shared body mesh as a mesh of its own on its hinge (`Bodywork`, the same machinery as parts that work loose), so the animation is a transform and the shell is never rebuilt; the engine bay (`render/bayMesh.ts`) shows under a raised bonnet and the cabin shows through an open door. A pickup's bed, a buggy's open cab, bikes and the war truck have no panel there and count as permanently open; a stripped bonnet (`hood_none`), a door off, a canvas door, or a panel torn or shot off counts as open too, and a torn-off one comes back shut when it is welded on. Opening is a little noisy (a Signature bump of 4).
- **Where the state lives.** `Vehicle.open` (what someone opened, closed by default) and `Vehicle.swing` (0 to 1, the drawn angle). `open` is kept in the build's `body.open` by `commit()`, so streaming a car out and in, the garage and the save file keep it; saves without it load with everything shut. `Vehicle.panelOpen()` is what the rules see. A vehicle at more than 5 m/s slams anything left open, and climbing in closes the door behind you. Raiders, crew and abandoned cars are never worked on this way.
- **With a tool.** The wrench and crowbar work the part at the point you stand at; if it is behind a shut panel the first hold opens it. With the panel open and the engine still in, holster the tool (any other item) and hold A to shut it again; a tool with nothing to do at an open panel offers to shut it.
- **Prompts.** The callout over the point says what state it is in (*"Bonnet closed - hold E to open"*, *"Bonnet open: Tuned V6"*) and only the points that matter for what you hold light up. `planFit` and `planStow` (`sim/carry.ts`) return the blocking reason (`need`: go somewhere, open a panel, take the old part off) that the prompts show.
- **The workbench** (wrench + X) is paint, spray cans, oil and water only: its fit and take-off buttons are disabled with a note (parts are fitted at the car), and oil and water need you at the open engine bay. The camp Garage tab is a workshop abstraction and is unchanged.
- **Tests.** `tests/access.test.ts` (the table, every chassis' points, real scenes: bonnet shut then open then shut, fuel only at the flap, boot and back door stowing, persistence, auto-slam, missing panels).


The moped to quad to buggy chain is still the guaranteed path (rebuild at a Waypoint garage). Found cars are a faster, luckier one, with their own strengths: hatchbacks are light and quick, sedans fast and fragile off the road, pickups sturdy with a bed for a gun, vans carry the most.

#### Securing cargo: inside, in a holder, or loose

Carried things are not magically glued to a car. Where you put them decides whether they survive a drive (`sim/cargo.ts` is the rules, `game/cargo.ts` the scene side, `render/cargoLoad.ts` and `render/cargoParts.ts` the drawing).

- **Sizes.** Small (cans, a steering wheel, 1 unit), medium (most parts, a small engine, 2) and large (a V8, a tyre set, a door, 4).
- **Inside is safe.** Stowing (X at an open boot, through an open door to the back seat, a pickup's cab, a buggy's seat well, a bike's panniers) puts the convoy's spares in that vehicle's secure room: two units per point of the vehicle's cargo space, roof and can racks not counted. Bikes and the buggy take nothing larger than medium. The convoy-wide total (`inventoryCap`) still applies on top; old saves with parts that have no vehicle of their own are never emptied and show up at any boot.
- **Holders are secure.** `PartDef.hold` (zone, units, biggest item): roof rack (4, medium), rack and net (8), wire basket (6, medium), steel basket (10, large), expedition basket (16, large); rear cage (4 or 8); bed tie-down kit (8) and bed net (14), both in the `utility` slot; the jerrycan rack holds four cans and the spare carrier a tyre set. What fits stays at any speed; what does not (too big, holder full) is loose.
- **Loose is not.** A bare roof, a pickup or buggy bed, or an overflowing holder keeps things while parked. Above about 3.2 m/s each load takes exposure (`looseStress`: speed, hard braking, cornering, bumps, airborne) against its own seeded tolerance (0.5 to 2.2), so loads go one at a time, then slides off as a tumbling piece (`game/debris.ts`) that lands as a pickup you can lift again; a fragile part (engine, radiator, gearbox, springs, brakes) is knocked, a can spills nothing. A bed has walls: it only gives to hard events, a roll, or an open tailgate (`walledStress`). A roll or a wreck throws everything.
- **Prompts.** Every X prompt says which it will be: *Secured in the wire roof basket* or *Loose: it will fall off when you drive*; the first loose load on a car also warns once. At a shut door X will not quietly use the roof (it says to open the door or step back). Loads are saved in the build (`VehicleBuild.cargo`), returned by a break-down, and only the convoy's own cars use any of this.

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
- **Glass as a part.** A car's glass is four fit slots, `glassF` (windscreen), `glassB` (rear window; the van has none), `glassL` and `glassR` (the windows of the left and right door, which fit either side like doors), each with a factory pane (`gls_*_std`) and an empty-frame placeholder (`gls_*_none`). Not every car has its glass: found cars come with bare frames some of the time (`glassFit` in `sim/cars.ts`, a burnt-out hulk has none left), and a car with no windscreen part has no windscreen pane. A door's window goes with the door: a door that is off, a canvas flap or an armoured slit (`window: false` in `parts.json`) shows no door glass, a door knocked off in a crash takes its pane with it, and a window will not fit a door that has no window frame. The quarter window behind the pillar is part of the body. Glass can be **taken from a car and fitted to yours**: the crowbar's bodywork stage lifts every pane out of an abandoned car, the wrench unbolts a pane from your own (hold A at the windscreen, the rear glass or a door), and the pane you carry wears what its panes took (whole, cracked, crazed; a pane that smashed is nothing to take but its frame takes a new one). Wrecks, garages, dealerships and warehouses also hold loose panes (`gls_*_pane`, laminated `gls_*_lam` at Mk2 which takes 2.2x the plain pane, and bulletproof `gls_*_bullet` at Mk3 which takes 5x and adds a little armour). The garage has a Glass group of mounts. The rules that tie the parts to the panes are `sim/glassfit.ts`; the live panes (`CarGlass.reconcile`/`syncFit`) take a new part's wear when the build changes and write theirs back when it is saved.

Not done: glass does not deform with a crumpled body, zombies do not break it, scenery wrecks and the tier chassis (buggy, trucks) keep their painted glass, and the painted windows of upper floors in the city cannot be broken.

### Lakes, boats, islands and delves

**Lakes** (`world/lakes.ts`). Each wasteland leg plans two or three lakes beside the road. A lake is a basin carved into the heightfield (`heightAt` is `baseHeight` plus `lakeAdjust`), so the terrain mesh, the physics heightfield, the far landscape and the shore tint all agree. The water level is flat, the floor is three to six metres down, and the road corridor widens into a bay around it. `waterAt(def, x, z)` is the one query for "is there water here and how deep"; wheeled vehicles, boats, people and zombies all use it. Cities have no lakes.

**What stands in and around them** (`world/lakeSites.ts`): a pier with a boathouse, flotsam and one to three boats moored at it, and one to three islands (a castaway's shack, a wrecked trawler, a lighthouse, ruins, or a cave) with loot and guards. The first lake of each leg carries a cave island. Docks are axis-aligned deck colliders you can walk and drive onto; the beach to the deck is a step the character controller takes.

**Water on screen** (`render/water.ts`): a depth texture per lake drives the tint from shallow turquoise to deep blue, scrolling ripple normals come from the procedural noise, and foam lines the shore. The ground gets a wet-sand band at the waterline, and nothing grows on the lake bed.

**Boats** (`physics/boat.ts`, `data/boats.json`, `render/boatModels.ts`). A boat is a `Vehicle` with a `BoatBody` in place of the wheeled controller (both implement `Chassis`). The hull is a Rapier box held up by six buoyancy points (critically damped, with a gentle swell), pushed by a propeller that only bites while the stern is in the water, and steered by yaw rate. The **Scrap Skiff** (52 km/h) takes two and has the bed gun; the **Swamp Airboat** (78 km/h) pushes on air, so its fan keeps some way on over mud and sand. They use the convoy's fuel and are loud: noise carries across water. Controls are the driving ones: RT throttle, LT reverse, stick to steer, Y to climb in or out. Run a boat onto a beach and she stops hard; LT shoves her back toward the water. Leaving a boat at the dock steps you onto it; leaving it in deep water puts you over the side.

**Wheels in water** (`game/waterfx.ts`): shallows drag and spray, water past the axles drowns the engine ("Engine flooded"), a swamped vehicle floats and a current carries it toward the nearest shore, and the engine restarts a couple of seconds after it dries out.

**On foot**: wading slows you; deep water means swimming. The dead will not follow into water deeper than a metre.

**Swimming** (`sim/swim.ts`, `Humanoid.swimPose`, `Player.updateSwim`). Afloat the survivor treads water upright when still and swims a
front crawl when moving: face down, the arms turning right round (in ahead, a pull under the chest, out over the water with a high
elbow), the shoulders rolling, the legs fluttering, the head turning for air. Hold sprint for a harder crawl (3.2 m/s against an easy
1.9, at a stamina cost). The crouch button ducks under (a toggle, or a hold when crouch is set to hold); ducked, looking down goes
deeper and looking up comes back, level holds the depth, and jump kicks for the surface. Under, the first-person view goes blue and
murky, the lungs run down in about 28 s (a BREATH bar shows), a long hold ends in a gasp at the surface, and out of air the water hurts
(6 HP/s) but never takes you below 8% health. Both hands are swimming: the weapon is slung and cannot be fired. Tests: `tests/swim.test.ts`.

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
trees, bones and wandering dead, one roll per 60 m square), cars left along the side roads with a part or a can beside them, and **raider
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

### Rivers, springs, swamps and the green country

The open world is no longer all dust. Its water is hand-set in `legs.json` (`open.water`, typed as `OpenWaterSpec`) the way the hubs
are: big lakes, springs, swamps and the anchors each river winds between. `world/hydro.ts` turns that into ground and water, and
everything else (the places, the rolled lakes, the gang camps, the mesas) is planned around it. The result is a country that is
desert in the south and along the highway, with a green river valley crossing it, and woods, lakes and fens to the west and north.

| Water | Where | What it is |
|---|---|---|
| **The Yarkon** | rises at the Yarkon Springs (1180, -560), crosses the highway 400 m south of the start, ends in Glasswater | a lowland river, 9 to 17 m wide |
| **The Greywater** | pours off the west rim at **Veil Falls** (37 m), down **the Seven Steps**, under the Dustwell west road, into Glasswater | the long river of the west valley |
| **The Silverrun** | off the east rim at **Silver Falls** (37 m), down **Silver Steps**, into the Black Fen | |
| Goat Brook, Thorn Brook, Fallbrook, Pine Run, Cold Brook | from springs (Fallbrook from **North Falls**, 35 m off the north rim) into a swamp or a lake | streams, 3 to 5 m wide and fordable |
| **Glasswater**, Coldmere, Stillwater | south-west, north-east, north-west | big lakes with islands, a pier and boats, built like the rolled ones |
| **Reedmarsh**, **the Black Fen** | west of Glasswater; the low basin east of the city | swamps: half shallow pools, half sodden hummocks |
| Ein Tamar, Date Spring, Sweetwater, Hart Spring | out in the dry country | oases: a spring pool with palms round it |

**Courses.** A river or stream is a centre-line sampled every 3 m (a Catmull-Rom curve through its anchors with a meander laid
over it), each sample with a water level, half-width, depth, bank width and current. The level only ever falls downstream. It is
worked out from the ground along the course, taken at its lowest across the channel and smoothed with a running median (which
keeps a cliff a cliff and irons out the dunes): the water sits a metre or so under that ground, halfway between the highest level
that never rises (it would fill every hollow) and the lowest (it would cut through every hump), so a river neither sinks into a
gorge at the first dip nor rides an embankment over it. Where the ground falls away steeply the level drops with it, and that is a
**waterfall**: the three off the mountains at the edge of the map are 35 to 37 m; the hand-set cascades (`falls` in the spec) are
put where the land itself steps down most near where the spec asks, and never deeper than the water it runs into. A course that
runs into a lake or swamp meets its level exactly, and the lake or swamp sits as low as the courses arriving in it (within 2.5 m),
so no water ever climbs.

**Ground.** `heightAt` is the base ground, then the lakes, then the water network (`hydroAdjust`): a rounded channel down to the
bed, a strip of flat floodplain, and a valley side whose width grows with how deep the course is cut (a 6 m cut has a valley about
25 m wide on each side), so gorges have slopes, not walls. A notch is cut through the rim cliff under each rim fall, and the visual
crags (`cliffDetail`) stand aside there. Spring pools are round bowls, swamps a hollow of hummocks and pools round a level. Every
query agrees: the terrain mesh, the physics heightfield, the far landscape and `waterAt`, which now answers for running water,
springs and swamps too, with the current as `flow` (metres a second down the course, and a little toward the nearer bank so a
swamped car fetches up against it). Channels, swamps and spring bowls are `mud` underfoot.

**Roads over water.** Where the highway or a side road crosses a river (`Hydro.crossings`: the Yarkon on the highway at z = -407 and
the Greywater on the Dustwell west road) the road runs over a causeway: the ground stays at road height for 3 m past the
carriageway, the channel is cut on both sides, and a **bridge** prop (`render/waterProps.ts`, drawn for the whole map like the other
landmarks) dresses it: concrete headwalls down to the river bed with the culvert mouths in them, parapets, guard rails and wing
walls. The water passes "under" the road through the culverts. A dirt track crossing running water fords it: the bed is raised to
26 cm under the surface for a few metres either side of the track, and the planner never sends a track down a gorge, over a fall,
or through a swamp or a spring.

**Green land and woods.** `finishHydro` bakes an 8 m raster of how green the land is (`lushAt`): water greens the land round it
(rivers and big lakes out to about 70 m fully and 120 to 140 m in all, streams and springs less), the spec's `greens` green whole
regions (the north-west and north-east woods, the west valley, the fen, the fields round Haven), dune seas stay sandier, the city
stays bare and so does the dusty middle round the start. `forestAt` turns lush ground into clumps of wood with clearings between,
and `woodsAt` says what grows: broadleaf, pine, fen, riparian or gum (a river planted with eucalyptus, `grove` in its spec). About a
third of the map is green and a seventh wooded.

**Trees** (`world/flora.ts`) are planted per chunk while its data is made (`ChunkSource`), from the chunk's own heightfield so they
stand on the ground that is drawn: oaks and the odd pine or poplar in the broadleaf country, pines in the northern woods, willows
and poplars within a few tens of metres of the rivers and lakes, eucalyptus out to 90 m either side of the Yarkon (four in five of
its trees, with willows, poplars and the odd oak between, as the real river's banks were planted), swamp cypress and dead snags in the swamps (they may stand in the
shallows), date palms round an oasis, lone trees in the meadows and acacias out in the dry grass at their edge. Nothing grows on a
road (a car's width of verge is left), in water, on a steep slope, on a place's pad, in a camp, by a parked car, a pickup, an
encounter, a way underground or the start. A wood has 120 to 260 trees a chunk. Each trunk keeps an obstacle box of kind `tree`
(`ChunkData.aabbs`) for navigation. Physical collisions and bullets use the rendered variant's wood triangle mesh, including branches,
with the same scale, yaw and lean; foliage remains passable. Fallen trunks leave the standing navigation obstacles.

**Green on screen.** The ground shader takes two more channels (`tdata.z` is `lushAt`, `tdata.w` is `forestAt`, packed the same
by the chunks and the far landscape): lush ground turns to meadow (fresh green, olive and yellow-green, straw at the fraying edge,
a `meadowTexture` for the blades), woods get a floor of leaf litter and moss, while rock stays rock, dunes stay sandier and road
shoulders stay worn. `render/groundMix.ts` colours the water's ground for the chunks, the far mesh and the reeds alike: dark wet
banks, gravelly beds under rivers and streams, a pale stone bowl under a spring, peat under swamp water with mossy hummocks between.
The ground cover (`render/scatter.ts`) greens and thickens with the land and has four new layers: wildflowers in six colours on the
meadows, ferns and bracken under the woods, reeds and cattails in the shallows and on damp banks, lily pads on swamp water 0.2 to
1.2 m deep.

**Trees on screen** (`render/trees.ts`) are built in code: round oaks and terebinths, conical pines, weeping willows, Lombardy poplars, date
palms with a skirt of dead fronds, flat umbrella acacias, buttressed swamp cypress with knees and hanging moss, dead snags, and
river red gums (eucalyptus: tall, pale and smooth with tan patches where the bark has shed and small dark scars, leaning or
parting low into two or three stems, sinuous limbs and an open crown of drooping sprays of sickle leaves), three variants each.
The leaf atlas is 4 x 3 cells (the gum's spray and its bark took two new ones) and the impostor atlas follows it. Wood is tapered tubes with vertex colour, foliage alpha-tested leaf cards from one atlas, so a tree is one draw; a
chunk draws one instanced mesh per species, the variants sharing it. They sway in the shared wind and cast alpha-tested shadows. Each
species is also baked into an impostor atlas at load (about 0.1 s), and between 80 and 100 m from each camera the 3D trees dither into
three crossed impostor cards. Past the streamed chunks the **far forest** (`planFarForest`, `Landscape.buildFarForest`) plants
impostors on a 9 m grid by the same rules (about 36,000 trees in 79 regions of 512 m, one draw each, about 215k triangles for the
whole map), standing on the far terrain mesh and stepping aside inside loaded chunks like it does, so the woods read out to the haze.
**Vegetation impacts** (`render/vegetation.ts`, `sim/vegetation.ts`) use mesh contacts and damped springs: grass, herbs, shrubs,
reeds and aquatic plants bend away from moving bodies and recover; heavier bodies crush soft plants. Effective mass, speed,
angular motion, scale and impact height determine the response. Species have distinct stiffness and failure work: live willow and
palm flex more than oak, while dead snags and scorched wood fail earlier. These are gameplay approximations, not measured botanical
constants. Bullets tear plants along their actual path, blades cut and blasts damage nearby growth. Sufficient work severs a tree's
roots/wood and releases a falling body made from convex pieces of its rendered limbs. Desert dead-tree props also use their own mesh.
Near meshes, impostors and forage crops follow the same motion. Crushed plants, cumulative damage and fallen poses survive streaming,
nights and saves through `WorldMemory.vegetation`; destroyed forage cannot still be harvested. Soft mesh sensors are created only near
moving bodies or projectile paths and released when idle. `tests/vegetationphysics.test.ts` covers these reactions and cleanup.

**The Concrete House.** On the Yarkon's bank toward Petah Tikva, where the river comes nearest the city, stands the Concrete House
(Beit HaBeton), the pumping station Gdaliyahu Wilbushevich built there in 1912. It is hand-set in `legs.json` (`open.heritage`:
the river, the district it faces and the gap) and planned by `world/heritage.ts` once the water is: its front wall stands 15 m from
the water's edge at the nearest point (about (95, -337), front to the south), its yaw a whole quarter turn, on a level pad that
`heightAt` sets last (built up on the river side), which the woods, the scatter and the ambient passes leave clear while the gums
stand close round it. `render/heritageProps.ts` draws it from the same numbers as a landmark: a grey rendered block with an arcade
of round arches on the front and right side, pilasters with capitals, a deep cornice, a smaller upper storey set back behind a
railed terrace with two tall arches onto it and narrow arched windows down its sides, a crenellated parapet, an open stair up the
left wall, the old pump in the hall (well head and grate, engine on its bed with a spoked flywheel, pipes), a welded mesh fence along
the front and right side with one panel down and a faded heritage plate, felled logs and a fluted stone drum in the yard. It has no
mesh collider: `heritageAabbs` gives it boxes (the wall pieces round every arch stop zombies, bullets and the camera; floors,
railings, the fence and the stair's walkable slope are physics only), and `heritageRoofAt` tells `interiorAt` it is under a roof
(the camera closes in, the rain stays off). A tool chest in the hall and a cabinet upstairs can be searched; two of the dead
wander outside. `tests/heritage.test.ts` checks the distance, the bank, the pad, the layout and the trees, and walks a Rapier capsule
in through the fallen panel, up the stair, round the terrace and into the upper room.

**The Yarkon itself.** It is a lowland river and looks like one. Its water is always cloudy (`silt` in its spec, a per-river
`uSilt` in `render/riverWater.ts`): an opaque olive-grey, greener in the deep, beige foam, still mirroring the trees. Five stony
**riffles** (`riffles`, placed by `placeRiffles` in `world/hydro.ts` clear of crossings and falls) raise the bed to about 30 cm under
the surface over some 40 m and nearly double the current there; the level never changes, so nothing climbs. The ribbon whitens
just over and below them (`riffleChurn`), grey river stones (`rock` props with `tag` 1, rounder and grey) lie across them with their
backs breaking the surface and along the banks beside them, and no reeds root in the quick water. **Giant cane** (Arundo,
`cane`) walls its banks: tall jointed culms with arching strap leaves and the odd silvery plume (`caneTexture`), in the shallows
and over the damp floodplain, where it shades the reeds out; vehicles and people push it aside like the other plants. Willows and
gums on the very lip of a bank (trees may now stand 1.3 m from any river's water) **lean out over it**, up to half a radian the
nearer the edge (`leanToward` in `world/flora.ts`; perched birds follow the crown with `leanOffset`), and both stand on **surface
roots** flaring off the foot of the trunk and diving into the ground, exposed where a bank falls away. On its open meadows (the
`gum` country with no wood) spring comes as a carpet of **poppies and white chamomile**, three flowers to each one elsewhere,
poppies with black hearts. Out on the most open, level meadow downstream of the highway, above the river and on the city's bank,
stands **the mud hut** (`open.heritage` with an `open` stretch; `meadowSample` in `world/heritage.ts`): one room of mud brick, two
small windows toward the river 28 m off, a door on the side, a flat roof of reed thatch on round beams with deep ragged eaves, and
inside a clay oven, a bench, a straw mat and clay jars, the big one worth searching. It collides as boxes like the house.
`tests/heritage.test.ts` checks the riffles (depth, current, white water, stones, the level), the cane only on the Yarkon, the
meadow's poppies and chamomile, the bank trees' crowns over the water, and the hut's place, and walks a capsule in at its door.
Both buildings are **named the first time the convoy comes within 130 m** (`waterNews`, after the lakes and before the rivers): a
banner (*The Concrete House · Pumping station · 1912*, *The mud hut · Mud hut*), a word on the radio when it has been quiet a while
(`radio.heritage.*`), and from then on a `heritage` pin on the map and the minimap, a little crenellated tower in warm stone with
the name under it, kept by the world's `mapSeen` like the water's names.

**The Half Island and Abu Rabah mill.** Four or five minutes on foot upstream of the Concrete House (about 800 m at the game's
walking pace) the Yarkon swings round an omega bend, as it does at Abu Rabah mill (`loops` in its spec; `spliceLoop`,
`prepareLoop`, `finishLoop`, `Loop` in `world/hydro.ts`). The river leaves its line, runs straight down two legs and round a
near-circle and back, so the ground inside is water all round: across the neck's mouth the legs open out until their waters run
together (`closed` in the spec), so the one way in is the crossing by the mill. At the top of the left-hand leg
the river comes round square, a straight run (`SHOULDER` in `spliceLoop`), and the mill stands lengthwise out in it, the water
under its floor and through its races (`finishLoop`, `millAt`; `millFits` checks the building and its steps keep off every other
stretch). The way in is the **crossing** beside it (`Loop.cross`): a strip of earth some 5 m wide on the mill's old foundations,
from the outer bank along the mill's door side, past its steps, and over the top of the leg, where it is a causeway with the
river running through culverts under it (`causewayAt`; its two faces of old coursed stone, low arches at the water, creepers
hanging over and big cut stones lying along the top, are `culvert` props), onto the strip of land about 4 m wide where on your right the stream opens into a little pond with a tiny island and
two old gums on it (`ISLAND_WIDEN`), and on up onto the meadow (`crossingPath`). You come to the crossing through a thicket of
giant cane, a tangle of tunnels through it (`caneTunnels`, `caneThicket` in `world/millBend.ts`): the way on out from the
crossing, ways off it and off those, some coming out, some dead ends, the canes either side leaning in over each until they
meet well over a head's height (`render/scatter.ts`). No cane grows on the island (`onIsland`: inside the loop's centre-line). Inside, the ground lies a metre over the water
at the banks and rises to a low hill in the middle (`loopPlain`), so from one side the water on the other is out of sight; low
grass on top, and all round between the grass and the water a strip of mud where the bank gums' roots run out (`innerBank`).
On the outer bank the cane stands as a wall with bushes behind it, and behind those a dirt road follows the bend round
(`ringRoad`, one of the open world's tracks, laid before the levels like every road; it keeps back from the neck and never
jumps a leg) with a track from it out to the nearest road, fording the river once well away from the neck. Along it round the far
side stands a second row of old gums, big and pale (`roadRow`). The mill (`oldMill` in `world/heritage.ts`, `OM`/`OM_WALLS`, drawn by
`oldMill` in `render/heritageProps.ts`) is a long block of honey-coloured kurkar in courses, dark and green at the waterline,
patched with plaster, three round-arched races through its base with a sluice gate wound up over one, narrow arched windows, a
barred square one, a low gable roof with white fascias and over one end the
restorers' tall lantern of grey panels and glass (`OM.lantern`), the roof of red clay tiles; it levels no ground (the river
runs under it, `y = 0` is the water), and the door in its long side, an iron gate of bars standing open, gives onto stone steps
down to the crossing, so you can walk in over the
races, past the millstones in their tuns, the sacks, the grain bin and the miller's chest (searchable). On the
meadow (`world/millBend.ts`, planned by the layout) stand seven **old eucalyptus**, a century old: forked into the eucalyptus's
own V, split open down one side, or all burls, their feet two and three metres wide, dark and fire-scarred below and going pale
into the stems (ordinary eucalyptus planted by the chunks, so they sway, burn and fall like any tree), their own leaves round
their feet (the ground shader's wood floor and flat leaf cards). In the foot of each is a **face** or two (`render/faceGums.ts`),
carved rather than painted: knot holes for eyes with the bark half rolled round them, a burl of a nose, a split for a mouth, the
dark only deep in the holes, a little lopsided and broken up by the bark; sober they are only hinted. Round their roots grow
**liberty caps**, every day (`always` forage spots), and on a trip the faces come forward: the renderer sets `FACE_TRIP` for each
view from that viewer's own trip (`faceStrength`, mushrooms most), and the feet's shader deepens the holes, raises brows, nose and
cheeks, works the mouths slowly as if they were saying something and lights the eyes from inside, all from vertex attributes. At
the landing by the pond: a fire ring, stumps of felled gums, and a **pedal boat for two** (`pedalo` in `data/boats.json`,
`physics.boat.pedal`): two seats side by side, legs on the pedals going round with the cranks and the paddle wheel
(`buildPedalo` in `render/boatModels.ts`), a brisk walking pace, no fuel, no engine, no starter; with nobody aboard it stays tied
up where it was left (`Vehicle.moorTick`). The place is named like the rest (*The Half Island · Old gums on a half island*,
`radio.bend`), its name on the map over the meadow, and the mill gets its tower pin (*Abu Rabah mill*). The eucalyptus everywhere
now vary more: three shapes (the broad old red gum, rough-barked low down under pale sweeping limbs; the many-stemmed clump; the
V), each tree's bark its own colour in the shader (white, cream, salmon, pinkish, grey-brown, `barkTint`), and each tree's crown
a little wider or narrower, taller or squatter (`treeAspect`). `tests/millbend.test.ts` checks the walk from the house, the water
all round but the neck, the 4 m crossing, the hill, the dirt road and its track out, the mud of the inner bank, the pond and its
island, the mill lengthwise in the square run at the top of the left-hand leg (and walks a capsule up its steps and through it),
the crossing beside it (the mill on the left, the causeway dry over the water, the pond on the right, no way in at the neck),
the cane thicket and its tunnels (none in them, none on the island), the row of gums on the far road, the gums, their stems, their faces sober and tripping, the liberty
caps, and in a scene the names and the pedal boat tied up, then pedalled away.

**On the green.** Grass binds the ground: where the land is lush the surface is firm soil, never loose sand, and a vehicle raises
about half the dust it would on bare ground (`LegScene.groundDust`), so its Dust signature carries less far and the green country
is the quiet way across. Make camp on the green and the camp is drawn to match (`CampLand` in `render/campArena.ts`, worked out in
`game.ts` from the camp pose): a meadow for a floor and the wood of that country (pine, broadleaf, riparian or fen) standing round
the basin outside the ground the raid crosses.

**Water on screen.** All the standing water shares one flat-water builder (`render/water.ts`): lakes as before, a swamp as an
olive-brown, nearly still sheet with drifts of scum and duckweed (a 512² depth texture each), and the nine spring pools as one clear
turquoise mesh with rings spreading from the middle and bubbles breaking over it. Running water is one ribbon for the whole map
(`render/riverWater.ts`): seven vertices across every 3 m sample, flat at its level and reaching 1.5 m over each bank so the banks
themselves cut the waterline, each carrying its depth, flow direction, speed and travel time, so ripples and foam move downstream
at the river's own speed and stretch into streaks where it is fast; there is foam along the banks, in rapids and in a boiling pool
under each fall. The drops themselves are a second mesh: a sheet that arcs off the lip, glassy at the top and roped with white
streaks below, a veil of spray just in front and a ring of spray on the pool (it never mirrors anything). Far off, the ribbon is
lifted a little so the coarse far terrain does not swallow it, and the river reads unbroken out to the haze. All of it is five draw
calls a view and no per-frame work beyond the shared time uniform.

**In the water.** Running water carries what is in it. A swimmer goes with the current at its full speed (a lake drifts them at
15% of its pull toward shore); wading deep, quick water pushes you, up to 85% of the current where it runs faster than 2.4 m/s. A
floating car goes where the river goes, and fording a quick stream leans on the body. A boat's drag is measured against the water,
so a boat left to itself drifts downstream. In the last 10 m before a lip (18 m before a tall fall) the current builds to 3.6 m/s:
come too close and you go over. Going over (the running water under you suddenly 1.4 m lower) is a splash, a jolt and the note
*Over Veil Falls!*: a person takes (drop − 4) × 1.5 damage, at most 40 and never below a fifth of their health, and a 0.5 to 2 s
stagger; a car up to 60, never enough to wreck it (`game/waterfx.ts`, `player.ts`, `physics/boat.ts`).

**Drinking** from water is free, and how clean it is depends on what it is: a spring never makes you sick, a stream rarely (8%), a
river now and then (12%), a lake often (30%), a swamp usually (65%). The note names the water: *You drink from Ein Tamar: cold
and clean* (`sim/needs.ts`).

**What you see and hear of it.** Every fall within 150 m throws mist off its foot (more for a tall or wide one) and spray down its
face if it is over 6 m. Recorded loops (`setWaterAmbience` in `audio/audio.ts`) follow the nearest water: a waterfall's roar,
heard out to 70 m plus 6 m for every metre of drop and lower for a tall one; river babble within 45 m of a channel and a quieter
trickle at a spring; insects over a swamp, loudest at dusk, and frogs after dark. The first time the convoy comes near a
waterfall (280 m for a big one), a spring, a swamp, a named lake or a river, a banner and the radio name it, and it goes on the map
and the minimap (falls at their foot, springs, swamps and lakes as pins, rivers as named lines). The map bakes the country green
where it is lush and darker where it is wooded.

**Wildlife** follows the green: each species in `wildlife.json` has a liking for bare, meadow and wooded ground. Antelope are about
four times as common on a meadow as on bare dust, wolves and bears come into the open world but only in the woods, vultures keep
to the bare ground, and about half the spawns on bare dust are skipped. Grazers on dry land wander toward the nearest water.

**Tests.** `tests/hydro.test.ts` (the plan is the same every time; no course runs uphill and each ends in its water; water all along
every course except under a causeway; no mesa in a course; both causeways dry and level with water either side; the rim falls and the
cascades; swamps half water, half mud; springs hold clear water; places, hubs and roads stay dry and tracks only ford; how green the
country is, and bare at the start and in the city; meadows are soil; the woods keep off roads, water and places, every trunk is
solid, the same trees every time), `tests/hydroplay.test.ts` (real scenes in Node: a swimmer and a loose boat go downstream, a wader
swept over Thorn Brook Falls is hurt but lives, a car on the highway bridge sits dry at road height, a spring is always clean and a
swamp seldom, a fall is named once, pinned, heard and misted, a convoy that camped in a wood wakes clear of the trees, grazers crowd
the meadows and wolves and bears keep to the woods),
`tests/waterrender.test.ts` (the river ribbon, the fall sheets, swamp and spring water, the bridge) and `tests/vegetation.test.ts`
(every tree species and variant builds, the ground packing matches the fields, ground cover in the dust and on the green).

### Living country: animals, small life, water plants and the beds

The green country and its water are lived in, from big game down to the crabs on a stream bed.

**Ten more wild animals** join the seven in `wildlife.json`, each with a model in `render/animalRender.ts` and the AI in
`game/wildlife.ts`:

| Animal | Temper | Where and how |
|---|---|---|
| **Nubian ibex** | prey | dry, rocky country and the springs; long ridged horns sweeping back |
| **Feral camel** | prey | the bare dust, in small strings; lows now and then |
| **Red fox** | prey | meadows and wood edges, alone, by day and night; curious: lets you come closer than other game, sits on its haunches to watch you, trots a few paces to see better, and pounces on mice in the grass |
| **Golden jackal** | scavenger (out by night) | keeps its distance from people (less after dark), runs from engines and the dead, comes in to eat a carcass, and the pack howls together at night, the leader first and the rest answering |
| **Water buffalo** | brute | only by water; wades in to wallow up to 1.3 m deep, walks back down to the water if it strays, warns and charges like a bear |
| **Grey heron** | wader | stands in the shallows and stabs at fish (sometimes with a splash); goes up when someone comes close and flies off along the water to other shallows, legs trailing |
| **White stork** | wader | walks the meadows pecking, in flocks; glides on the way to other open ground |
| **Mallard** | swimmer | rafts on lakes, swamps and slow rivers; paddles, up-ends to feed, quacks; swims off from a stranger and the whole raft takes off to other water when anyone comes close, splashing down at the far end |
| **Hooded crow** | bird | in the country and the city; comes down in flocks to hop and peck over open ground, and goes up when walked over |
| **Little egret** | wader | white, in small groups in the shallows and on wet meadows; bold, it lets you closer than a heron |

Wading, swimming and scavenging are new tempers (`wader`, `swimmer`, `scavenger`). A species' `land` taste can now say how much it
likes being by water (`water`) or that it lives nowhere else (`needWater`): herons and buffalo only spawn near water, and are put
at its edge. Ducks come with the water itself: when the spawner looks at open water deep and slow enough, it puts a raft there.
`nocturnal` species are more common after dark, not less. Every bird can lose a wing to a shot (`WINGED` in `sim/anatomy.ts`).

**Nerve.** Animals no longer bolt from every engine in sight. A vehicle is noticed out to an animal's sight, but it only runs
when the vehicle is near (40% of its sight) or coming straight at it fast; one going by at a distance gets a look, and then the
animal walks off. Each species has a `nerve` that scales the distances it runs at: a camel (0.45) watches you drive past and
strolls away, a buffalo (0.6) or an egret stands its ground, a deer or a hog runs much as before. Herons and ducks are flushed
from further by a car coming at them than by one going by.

**Drinking.** Grazers and hunters get thirsty: every few minutes one walks down to the nearest water within 40 m, stands at the
edge facing it with its head down for several seconds, and the herd comes too. Anything that alarms them breaks it off.

**Small life** (`game/ambientLife.ts`, drawn by `render/lifeRender.ts`) is only for the eye: nothing in it is simulated with
the game, it never touches gameplay, and it runs on render time. Around each player, a couple of spots a frame are looked at
(how green, how wooded, what water and how deep, city or not, the hour, the weather) and whatever lives there is put there,
and it leaves again when nobody is near:

- Butterflies (whites, yellows, painted ladies, blues) and bees over the meadow flowers by day; dragonflies hawking over the
  water's edge; fireflies at dusk and in the dark; gnats dancing over a swamp; flies on a fresh carcass; grasshoppers springing
  out of the grass ahead of someone walking.
- Flocks of sparrows, bulbuls, bee-eaters, hoopoes and goldfinches pecking about the ground, which go up together when someone
  comes near and land again further off; pigeons in the city that loop round and come back; swallows sweeping low over the
  water and the meadows by day, bats by night.
- Fish schooling in the water (facing into the current in a river and holding there), scattering from a wader or a boat;
  catfish and carp grubbing along the bed; fish leaping in the lakes and rivers with a plop and a ring, more at dusk.
- Frogs and turtles on the banks that go into the water when you come down to it; lizards doing push-ups on the hot ground
  and darting off.
- Under the water: freshwater crabs on the beds of streams and springs that walk sideways and scuttle off to hide; tadpoles
  wriggling about the bed of still shallows; water striders skating on the surface, a ring where each one stops.
- At the banks: crabs out on the mud; wagtails running along the waterline with their tails bobbing; parties of small birds
  and doves come down to drink at the edge, facing the water; damselflies settled on the reeds with their wings closed; a pied
  kingfisher hovering a few metres over the water, folding up to dive in with a splash, and hovering again further along.
  Water snails creep on the wet mud at the very edge (ground cover, `render/scatter.ts`).
- In the trees: small parties of birds sitting on the outside of the crowns (doves and bulbuls in the palms, sparrows,
  goldfinches and starlings in the broadleaves, jays and crows in the pines, crows and shrikes on dead snags and acacias),
  which all go to another tree on the far side when you come near (`LegScene.treesNear`).
- In the dry country: lizards, an agama doing its push-ups, a fringe-toed lizard flicking over the sand faster than the eye, a
  spiny-tailed lizard that runs for its burrow and is gone, and now and then a desert monitor, a metre of it, walking slowly
  with its tail swinging. And snakes (below).

**Snakes bite.** They are the one part of the small life that touches the game, so they run on the fixed tick
(`AmbientLife.tick`, from `Scene.tick`). They are as aggressive as real ones, which is to say defensive: none hunts you.

| Snake | Where | What it does |
|---|---|---|
| **Palestine viper** | stony dry ground, fields and scrub of the green; more about at night | lies still; feels your footsteps at about 3 m (further if you run, much closer if you creep), coils, faces you and hisses every couple of seconds; strikes whoever stays within reach of its head (about a metre), again and again; give it room and it slides off into cover |
| **Horned viper** | sand, half buried | warns only from 2 m, then strikes like the viper; sidewinds away |
| **Black whip snake** | anywhere warm, by day | off into cover at speed from 5 m; bites only when cornered, and has no venom |

Step on any of them before it knows you are there (in the dark, at a run) and it bites at once. Engines scare them off the road,
and one a wheel goes over is dead; so is one a round passes over (`AmbientLife.shootThrough`, from `Combat.firstHit`) or a blow
lands on (`AmbientLife.meleeHit`).

**Venom** (`sim/venom.ts`, on `Player.venom`): a viper's fangs do a few points (boots and armour count), then the dose works in over
a minute or so: about 45 health from a Palestine viper, 28 from a horned viper, faster while you run, slower if you keep still, and
you walk slower while it works. Unlike bleeding it can put you down: a healthy person lives through one bite untreated, but a second,
or one on top of other wounds, will not. A bandage on the belt is a pressure bandage (it spreads half as fast); a medkit draws most of
it. Going down or being revived clears it.

Everything small is set on the ground as it is drawn (`LegScene.drawnGroundAt`, which in a hollow lies a few centimetres over
`groundAt`), so a crab on a river bed is not sunk into the mesh. Only brine, ash and flood water hold no life. It is about 16 draw
calls when everything is about.

**Water plants and the beds** (`render/scatter.ts`). By the water: papyrus in the fens, yellow iris and sedge on the banks of
streams and springs, flowering oleander a little way up them (more of it in the dry country and round the oases), weed
streaming in the current of the rivers, and lily pads, some in flower, on calm lake and river margins as well as the swamps.
Under the water, by what water it is and how deep:

| Water | The bed |
|---|---|
| River or stream | cobbles everywhere it runs, thickest in the quick stretches; mud and algae and tape grass in the slack by the banks; pondweed; sunken branches under the woods; mussel and snail shells |
| Clear lake | stones in the shallows, mud and green algae, meadows of tape grass reaching for the surface, pondweed, sunken logs, shells |
| Brine or ash lake | salt-crusted stones and white salt, or grey ash silt; nothing growing |
| Spring | pale pebbles, carpets of stonewort and hornwort, the odd rust-red seep of iron |
| Swamp | black peat, pondweed and hornwort, drowned branches with one end sticking out of the water |

The plants that live under water sway with the water, slowly, not with the wind, and are sized to the depth so they never break
the surface. The stones on the beds have no colliders (the pebbles on dry ground still do). Rivers and clear lakes are clearer
than before, so the cobbles, weed and fish show down to a metre or two (a flood's silt still turns a river opaque), and the fen's
peaty pools let the plants just under the surface through. A submerged bed never takes the hardpan's dried, cracked plates
(`mixWater`): it is sand, silt and gravel, and black peat under a swamp; dry clay pans on land keep their cracks. The beds add about a tenth to the time it takes to build a watery chunk (one look at the water per point serves the
bank plants and the bed alike).

**Sound.** New calls: `quack`, `howl` (a jackal's wavering wail and yips), `bellow` (a buffalo's or a camel's low), `flutter`
(wings going up all at once) and `chirp`. `AudioEngine.setNatureAmbience` lays the living country under everything, driven by
`LegScene.updateNature`: birdsong by day (bulbul, warbler, collared dove, hoopoe and finch phrases; a few over the dust, many in the
woods and meadows, busier in the morning, hardly any in the city), cicadas in the heat of the day among trees and scrub, crickets in
the grass after dark and scops owls in the woods at night; a storm quietens all of it.

**Tests.** `tests/fauna.test.ts`: every species complete and modelled; ducks stay on the water and fly to other water; a heron
never wades deep and flies when flushed; jackals feed on a carcass, flee people and howl in chorus only at night; buffalo wallow
but never go out of their depth; crows come down to forage; water species only by water and the night ones at night; the spawner
puts rafts on open water; fish only in living water and under the surface; a school scatters; frogs go into the water; a flock
flushes and lands again; pigeons in the city; grasshoppers; flies on a carcass; crabs walk sideways and hide; tadpoles keep to the
bed; water striders skate and leave rings; bottom fish keep to the bed; butterflies by day and fireflies by night on a real meadow;
fish and dragonflies on a real river; birds in the trees fly to another tree; a kingfisher dives; wagtails and drinking birds keep
to the edge; damselflies settle over the water; a viper coils, hisses and strikes only at someone who stays in reach, a horned viper bites whoever steps on it, a whip snake bites only when cornered, and a shot, a blow or a wheel kills one; a monitor walks and a
spiny-tail runs for its burrow; a camel watches a passing car and only runs from one coming at it; a fox sits and watches you;
a herd walks down to drink; egrets keep to the shallows. `tests/venom.test.ts` (one bite survivable, two can kill, running speeds it, bandage halves it, a medkit draws it) and `tests/snakeplay.test.ts` (a viper strikes a real player in a real scene and the venom works on; a medkit draws it). `tests/vegetation.test.ts` adds snails along a stream, the beds of a river, a fen, a clear lake and a spring, nothing
of them poking out of the water, and nothing of them in the desert.

### Hunting: stalking, shot placement and tracking

Grazing game (antelope, ibex, camels, hares, foxes) no longer spots anyone on foot the moment they are inside its sight. It
builds up **awareness** from what it sees, hears and smells of you, and lets it fade when nothing is there. The rules are pure, in
`sim/hunting.ts` (`STALK`, `notice`, `SHOT`, `BED`, `carcassYield`); the animals use them in `game/wildlife.ts` (`stalk`,
`thinkPrey`, `bedDown`, `bulletHit`).

- **Eyes**: movement is what it sees. Frozen you are seen at 0.6 of its sight range, walking at its full range, running at 1.45x.
  A crouch takes off 45%, a wall, rock or wreck between you hides you outright, woods and (crouched) tall grass hide you in part,
  and day animals see less at night. Head down grazing it sees 70% as far: move while the heads are down, freeze when one comes up.
- **Ears**: your footsteps, the same noise level as the Signature meter. Crouch-walking is nearly silent; sprinting is heard 40 m off.
- **Nose**: the wind carries your scent downwind in a cone (about 23 m in the everyday breeze, up to 70 m in a dust storm). Inside
  it nothing else matters: crouched, still and hidden, it smells you and bolts. Rain washes most of the scent and the footsteps out.
- **What it does**: at 0.35 awareness it stops and stares (the herd with it); freeze and it goes back to grazing. Fully aware, it
  stares for a moment, then bolts (steady camels walk off, a hare sits tight, a fox sits down to watch). Anything that notices you
  inside its flight distance goes at once. A quiet kill (a crossbow, a suppressor, a bow) does not send the herd off: they throw
  their heads up and stare toward you, so a patient hunter can take a second.
- **HUD**: on foot near game, two chips: `SCENT ↗` (which way your scent drifts, relative to your view) and how the most watchful
  animal reads you: `UNSEEN`, `GAME UNEASY`, `GAME WATCHING`, `GAME SMELLS YOU`, `GAME SPOOKED`.

**Shot placement.** A body hit is split into the heart and lungs (low in the chest behind the foreleg: 1.5x damage, a fast bleed,
it runs a few dozen metres and drops), the gut (the back third: 0.8x, a slow bleed, and it taints the meat) and the rest. Head
shots stay 1.8x. A hit that does not drop it tells the shooter what they hit ("Lung shot: … Follow the blood."). Wounded game
bleeds a trail of drops on the ground, thicker the harder it bleeds.

**Tracking.** A badly hit animal (bleeding, under 60% of its life) that has run out of sight lies down on its brisket to stiffen,
head up, watching its back trail. Bedded, it bleeds at half the rate. It gets up and runs again the moment it notices you, so follow
the blood, come in slow and from downwind, and finish it. Something that bled out lies two and a half minutes for you to find.

**The carcass.** Rations: a clean kill (head or heart-lung, within two hits) gives 25% more on big game; a gut shot loses 35%, a
blast 50%, roadkill 40%, fire 20%, and scavengers eat into it while it lies. **Hides** come off foxes, jackals, wolves, antelope,
ibex and hogs (one), camels (two), buffalo and bears (three); a blast, a fire or a bumper ruins them, five or more holes cost one.
Hides go in the convoy stores; at the Ledger's **Tanner** sell them for 3 Scrap each, or cut two into three leather wraps
(bandages). `tests/hunting.test.ts` covers the rules and the behaviour (unseen when crouched upwind, seen walking, smelled when
downwind even behind a wall, freezing calms a staring deer, lung vs gut shot, bedding and flushing, yields, hides to the stores).

### Fire: flames, firelight and burning ground

Every fire in the game runs through one fire engine (`game/fires.ts`, on the scene as `scene.fires`): campfires, the camp's
fire ring, gang camps, Nar's cooking fire, the fire ring at a river bend's landing, cave braziers, trees lightning sets
alight, molotov pools and flares (in flight too), burning cars and wrecks, burning zombies and animals, and the grass any of
them light. What burns, and how, is `sim/combustion.ts`, plain functions the tests run bare.

- **Flames** (`render/fireRender.ts`): each fire is a handful of flame tongues, strips that stand on the fuel, turn to face
  the camera and bend downwind along their length. The shader draws the flame itself: a teardrop torn by turbulence that
  climbs it as fast as hot gas rises (a small flame flickers faster than a big one), coloured off a black-body ramp from a
  yellow-white body through orange to a cooling red fringe, soot on burning oil and rubber, a strontium red for flares. It is
  HDR and premultiplied, so a fire blooms at night and still reads against a bright sky by day. Pool fires lie on a bed of
  breathing coals; embers lift away on the wind, smoke rises and leans downwind, wood pops sparks.
- **Firelight** (`render/fireLight.ts`): three's light chunks are extended with up to eight fire lights per view, fed
  through each material's own lighting, so asphalt, paint and wet ground catch highlights and the road reflects a burning
  car. Each light is a glowing body the size of its flames (the ground beside a fire is bright, not white-hot), flickers with
  the flames and wanders as they do. Each view keeps the brightest and nearest of every fire burning; fires crowded together
  are merged into one light and saturate (a wall of flame is not a hundred campfires), and the last places fade by score so
  nothing pops. The same lights glow in the haze, rain and dust in the screen-space light pass, and light the smoke from
  below. The air over a fire shimmers: the composite bends what lies behind the flames, never what stands in front.
  Firelight is dimmed by day (the sun swamps it) and the eye stops down by a big fire at night.
- **The world answers back**: wind leans the flames by their Froude number, fans an open fire and carries smoke, embers and
  spread downwind. Rain beats fire down by how wet its fuel gets (grass drowns, a tended campfire dims to half, burning petrol
  hardly notices) and makes it steam, except under a roof. Water puts a wood fire out in a burst of steam; petrol floats, so a
  molotov that lands in a lake becomes a burning slick that drifts on the current. A held fire (a car, a body) that goes under
  vanishes in steam.
- **Grass fire**: dry ground burns on a 2.5 m grid. What there is to burn is `world/fuel.ts` (the scatter's own grass clumps,
  meadows, leaf litter under the woods; nothing on roads, asphalt, the city or water). A molotov pool, a burning car, a
  zombie on fire, a tree's falling litter or an explosion lights it; it spreads cell by cell at a rate set by how dry the land
  is (`fireDanger`, slowed by dew at night), running downwind and creeping back against it, into the trees standing in it, and
  a crown fire throws brands ahead for spot fires. Behind the front the ground is black and the grass is burnt to stubble
  (`Vegetation.burnArea`); both are remembered overnight (`WorldMemory.scorched`). Those standing in it burn; a car parked in
  it can catch.
- **Explosions** flash their light over everything round them for a moment.

`tests/fire.test.ts` covers the model (lean, flame height, rain by fuel, water, spread with and against the wind, light) and
real leg scenes in Node: a campfire's light in the view and its flicker, more fires than lights, a held fire dying down,
rain on a campfire and a grass fire, a wood fire drowned and a petrol slick floating in a lake, a grass fire running
downwind, leaving black ground that survives a save, refusing wet and bare ground, burning a player, and lightning's tree
fire as a crown fire.

### Petah Tikva Center: an authored city

Leg 3 has a third road, **Petah Tikva Center** (`L3P`), which the open world also uses as its city: a recreation of the old centre of Petah Tikva, "Em HaMoshavot" (Mother of the Colonies). It is a city leg whose block grid is drawn by hand instead of rolled: `legs.json` names a `plan`, and `world/plans/petahTikva.ts` holds it (`world/cityPlan.ts` has the types). A plan keeps the usual skeleton (a boulevard down the middle, building columns either side, cross streets between blocks) so physics, zombies, camps and set pieces all keep working, and replaces the dice with fixed block lengths, strip widths, named streets and landmark lots.

What is on the map, driving north up Haim Ozer Street (the order is the real one: City Hall to the south, then the square, then the Red Line and the Central Bus Station, then the stadium):

- **Ofer Grand Mall** (עופר הקניון הגדול פ״ת, `grandMall`, `world/mall.ts`), the first thing on the left coming into town from the south, filling the first two blocks: a real walk-in building of two 5.6 m storeys raised through the same `SiteBuilder` and plan system as every other interior (look `mall`, `genMall` in `world/interiors.ts`), so its walls, shop glass, fittings, loot, stockrooms, cutaway and dead all work as elsewhere. Outside, as in the photographs: a long block in bands of cream and pink stone, a raised grey box over the main doors with the red Ofer sign, a white ribbed cone over the court, a grey block clad in horizontal panels with walls that lean out as they rise (H&M, a sale banner), and an angular cantilevered wing on two slim columns over a blue glass corner (`render/mallView.ts`). Inside: a mall street with twenty-one shops behind glass fronts (Zara, Mango, Golf & Co, Aroma, GAP, American Eagle, Super-Pharm, Fox, Castro, Steimatzky, KSP and H&M downstairs; Bershka, Pull&Bear, Foot Locker, ACE, a food court, Shufersal, iDigital, Max Stock and Lametayel upstairs; each with its own fascia sign in its own colours, `SignTheme 'brand'`, and fitted out for what it sells: clothes rails, shelving, gondolas, coolers, counters, tables), kiosk carts, benches and planters, and a round court with an oval void through the upper floor under the cone, a white bulkhead with a ring of lights, a glass balustrade with a steel handrail, round columns, and a pair of 30° escalators climbing through the void (`Stair.kind 'escalator'`: they collide as a ramp like any stair, with sloped balustrades either side). A shattered shop window is the game's shop glass. The upper floor's colliders are marked `overhead` so they do not stop things spawning downstairs, and the storeys are only cut away when the camera is up in them, so the gallery stays in view from the court.
- **The footbridge** (`footbridge` prop, `render/footbridge.ts`): from the mall's upper-floor door beside the grey block, a cable-stayed bridge crosses Haim Ozer at the mall's first-floor height (over 4.5 m clear for buses), swings round to the south on a curve hung from one inclined white mast, and comes down a ramp into a paved plaza with a bus stop and the glass **Prima Link** tower (`mallPlaza`). It has a pale deck with green glass under it on white ribs, a big cream tube along its outer edge, white hooked posts with wires between, a fan of cables and a pink light strip under both edges. It is drawn whole by the far landscape and collides as a lean mesh of its own (deck, railing walls, tube, mast, piers), so you can walk it, or ride it.
- **Named streets**, each announced the first time you drive into it: Haim Ozer (the spine), Jabotinsky, Herzl, Stampfer, HaBaron Hirsch, Pinsker, Krol, Ze'ev Orlov, Ussishkin, Hovevei Zion, Rothschild and HaHistadrut. Cross streets and side streets are paved asphalt (`TerrainDef.streets` also makes them asphalt underfoot).
- **Founders' Square** (כיכר המייסדים): a paved level beside Haim Ozer and a raised lawn behind it, a fountain where the first well was dug, five founders' plaques, benches and dead trees, with an encounter, *The First Well*, at the pump.
- **The Great Synagogue** (בית הכנסת הגדול) across Hovevei Zion Street from the square: a long hall with a pitched tile roof, a cupola and a four-column portico.
- **City Hall**, drawn from a photograph: a tall square tower with bands of narrow windows and a lattice mast, a four-storey wing with an entrance canopy and a blue and yellow sign over it, and a six-storey wing with a colonnade, sun-shade ledges and air-conditioning units, round a tarmac car park with painted bays and parked cars that opens onto the street.
- **Shawarma Melabes** (שווארמה מלאבס), at **Haim Ozer 4**, directly across the street from City Hall: Hebrew signs with the shop's slogan, two white-framed boards and the red kosher badge, paired modelled shawarma spits, a solid stainless serving counter with salad trays, pale tiles and a framed glass doorway. Tables and chairs stand on the sidewalk with food to scavenge. The [restaurant listing](https://wolt.com/en/isr/petah-tikva/restaurant/shawarma-melabes) supplies the address and slogan; the storefront details follow the Haim Ozer street photograph in [Mynet](https://petahtikva.mynet.co.il/local_news/article/byajw1zqjl).
- **The Red Line** (`CityPlan.rail`): Jabotinsky Road is a wide cross street with the Tel Aviv light rail down the middle of it, drawn from `PlannedStreet` kinds `rail` and `platform`: a concrete slab with two tracks, an island platform with a canopy and a red name board (Hebrew over English) at **Petah Tikva Central Station** (the real end of the line, a buffer by Haim Ozer and the bus station), **Pinsker** and **Kiryat Arye**, masts every 26 m with contact and messenger wire, and a 36 m five-module tram (`tram` prop, white with a red band) standing at each end, solid but with room to walk round.
- **The Central Bus Station** (`busStation`): a five-storey terminal hall along Haim Ozer behind a tarmac forecourt of bus bays (`bus` and `busShelter` props, one livery per operator), a pilotis canopy, a green Hebrew sign over the doors and a glass hub tower beside it, with the commuters still waiting.
- **HaMoshava Stadium** (`stadium`): two long grandstands with the seating rake as stepped blue, white and red sectors (the tall one has a cantilever roof), two low end stands, striped pitch with lines and goals (`pitch` patch), four lattice floodlight masts, and a corner left open at each end as the way in. The real one is out by the Kiryat Arye station; here it stands where the line's last stop is.
- **The ordinary buildings** (`CityPlan.vernacular: 'israeli'`) are dressed as the real ones are: cream, sand and warm-white render; stacks of balconies with solid parapets, condensers and half-lowered roller shutters on the long walls; solar water heaters on the roof; and over the ground floors on Haim Ozer a Hebrew shop sign (`render/signs.ts`, drawn on a canvas, one material per distinct sign, merged per chunk).

What is real and what is not: the street names, the order along the spine (City Hall, Founders' Square, the Red Line, the bus station), that the Red Line ends at the Central Bus Station on Orlov Street and passes Pinsker and Krol, that HaMoshava Stadium stands by Kiryat Arye station, which streets bound Founders' Square, what the square contains, that the Great Synagogue is on Hovevei Zion Street and City Hall on Haim Ozer Street, and the shape of City Hall and of the shop's front, come from published descriptions and photographs, as do the look of Ofer Grand Mall (on Jabotinsky Road at the city's entrance), its court and its footbridge; which shop is where in the mall is invented. Which side of the spine things are on, every distance, block depth and building height, and the straightening of the real street pattern onto one spine are invented to fit the engine. It is a recreation in the spirit of a game level, not a survey; the tables in `petahTikva.ts` are meant to be redrawn.

**Shopfront art.** `render/shopFront.ts` draws the shop's signage and interior backdrop on a canvas at load time, and `buildShopFrontDetails` supplies the three-dimensional counter, twin spits and door frames. The phone numbers are left off. To replace the drawn backdrop, save an image as `public/shops/malabes.png` (the whole panel, 14 m by 4.8 m, so 70:24, with transparency above the sign band if wanted): it replaces the drawing once it has loaded; the modelled equipment remains in front.

The worker at Melabes (`render/shopWorker.ts`) follows the supplied appearance reference: a bald crown, grey side hair, a lined face, an open white collar and a navy jacket. The shop has a 4.8 m recessed interior with matching obstacle volumes and solid equipment. He walks around the two large spits, carves each with a long knife, and returns to offer portions across the counter. Hold interact during the serving phase to take and eat a portion; each player can take one per round. A random existing drug dose activates 30 seconds after that player eats, without spending convoy stock. Each timer follows its player across scene changes and saves. The city chunk owns his model, the scene advances his animation, and unloading the chunk releases his local geometry while retaining the shared portrait assets.

The clearer face reference adds fuller cheeks and jowls, lower-eyelid bags, a broader rounded nose, a fuller parted mouth and sparse grey crown hair above a dense side fringe. The portrait's optional age, gloss and thinning controls keep these details in his sculpted head and painted skin; the other portraits retain their own specifications.

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

Visual assets are generated in code at load time. Licensed sound recordings ship in `public/audio`; see `public/audio/CREDITS.txt` for attribution and `sources.json` for the per-file license and checksum inventory.

- **Pipeline**: both views render into one multisampled half-float target, then a bloom mip chain and a composite pass
  (ACES tone mapping, colour grading, a per-half vignette and film grain) draw to the canvas. Every post pass clamps its taps
  to the half a pixel belongs to, so one player's muzzle flash never glows into the other's view. The Low preset skips the
  post chain and draws straight to the canvas. With the post chain the canvas has the screen's own pixels (so the browser
  never stretches the picture, which put faint regular lines through fine detail) while the scene is drawn at the quality's
  resolution and the adaptive scale; the composite scales it up with a Catmull-Rom filter. The screen-space passes (AO,
  scattered light, reflections) read the unfiltered depth buffer only at pixel centres: their half-resolution samples fall
  between two depth pixels, and left to rounding the pick flipped in bands, darkening the ground in stripes.
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
- **Portrait heads** (`render/portrait.ts`, `render/portraitPaint.ts`, the people in `render/heroLooks.ts`): Chinsky's,
  Leo's and Nar's heads were measured off their photographs (landmarks in head-local metres, the selfie distortion taken out) and are
  sculpted as a signed distance field: skull, brow, eye sockets, nose, lips, jaw, chin, neck and Chinsky's beard volume.
  Rays from inside the head sample it on a grid that crowds round the face; the grid is the mesh and its UVs, and a second
  shell grown off it is the hair (Leo's quiff, Chinsky's crop, flattened under a hat). The texture (skin, brows, eyes,
  lips, beard or stubble, painted hair) is painted texel by texel from the 3D point under it, in a worker on first sight,
  with a quick low-resolution paint in the meantime. Open `/portrait.html` on the dev server for a close look at all three,
  turned, re-dressed or lit as you like (its header comment lists the URL options, including a reference photo beside them).

`window.__game.setPhoto({ pos, look, fov })` frames one full-screen shot from a fixed camera (pass `null` to return to the
split screen), which is how the model and scene checks were done.

## What is not in the slice

Per the blueprint's cut order and scope plan, these are Beta or Final work and are not built yet:

- Tier 4 and 5 vehicles (the data and physics parameters exist, the models, turret, plow, docking and flamethrowers do not). The Tier 3 buggy is still the top of the rebuild chain; found cars and fitted parts are how everything else grows
- The Scout, Scavenger and Heavy Vanguard (their data and hiring rows exist and are disabled)
- Legs 4 to 14, Waypoints beyond Rustgate, run modifiers, other weather than dust storms and heat waves
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
corridor, mesh builder attributes, procedural noise). Lakes, boats and delves have theirs (see their section above), and so does the authored city: `tests/petahtikva.test.ts` (the plan lays out and names its streets, Founders' Square, the Great Synagogue, City Hall and the shop stand where the plan says on the streets it says, the real south-to-north order, the Red Line's slab, platforms, trams and stations, the bus station and the stadium, shop signs, streets are paved and open, everything on the route is reachable by flood fill, places are announced once), and `tests/mall.test.ts` (the mall is the first thing on the left, every shop has its room, door and sign, the court's void and balustrade and the escalators, upstairs colliders overhead, the bridge's clearance over the street, and a real-Rapier walk up the bridge ramp, over the street, into the upper floor, down an escalator and out of the main doors). The car system has its own suites: `tests/garage.test.ts` (parts, stats, fitting, repair, salvage, world-car rolls), `tests/engines.test.ts` (the engine catalogue, every engine in every chassis, bays, petrol and diesel, radiators, heat, hot rods, saves), `tests/engineplay.test.ts` (real leg scenes: attach points and reach, wrong-fuel starts and draining, overheating under load, diesel cans, spray cans, stripping a car), `tests/paint.test.ts` (panel paint rules and the recoloured geometry), `tests/garageui.test.ts` (the garage view, grouped mounts, per-wheel tyres, water and oil, and swap forecasts with a fake host), `tests/wave2.test.ts` (gearbox strain, brakes, springs, exhaust, per-wheel tyres, removable doors and bonnet, sump and water volumes), `tests/wave2play.test.ts` (real leg scenes: a tyre on one wheel, the crowbar prying a door or bonnet, a V8 drinking more fuel, oil and water, water cans), `tests/wave2render.test.ts` (bare rims, missing panels, exposed engine, exhaust and spring kits, carry models), `tests/cars.test.ts` (Rapier handling of each found chassis, and that the model sits on the ground) `tests/carplay.test.ts` (real leg scenes in Node: streaming, claiming, repairing with held buttons, stripping, siphoning, saving the fleet), `tests/oil.test.ts` (the oil model, planning a fit or stow, old saves) and `tests/haul.test.ts` (real leg scenes: lifting, bolting on, pouring, stowing, dropping, driving over loose items without taking them, taking goods by hand, running dry). Bodywork has `tests/bodywork.test.ts` (the crash, joint, dirt and mark rules, the part tags in every model, the lattice: where it folds, normals, caps, slicing, extracting and hiding a part, replaying saved dents, lamps carried along, the dirt shader hooks, the track buffer) and `tests/bodywork-scene.test.ts` (real leg scenes: a wall crash dents the nose where it hit, a gentle bump does not, a bull bar tears off and can be lifted, two-sided modules, doors, mirrors working loose first, wrecks, spare wheels that roll, bullet and blast dents, debris as an obstacle, parts stowed or kept as pickups, save round trips, hammering and welding, mud, blood, tyre marks, and the open world remembering the road overnight). Dust storms have `tests/weather.test.ts` (the day's window is fixed by seed and day, level shape, what a storm does to raiders' sight, oil burn and the map, and a real leg building and clearing a storm). Personal gear has `tests/gear.test.ts` and `tests/gearplay.test.ts` (see its section above). Eating, drinking and the rest have `tests/needs.test.ts` (draining and filling, warnings that fire once, what each level does to you, saves, then real leg and camp scenes: the belt slots, rations and litres spent, a piss and a shit running their course and being cut short, supper and the night, and the keys).

Training has `tests/tutorial.test.ts`: a real open-world scene in Node walked through all twelve lessons with real held buttons and sticks (walking, sprinting, a jump, aiming and firing, taking goods and searching a crate, climbing into the moped, driving, the horn, getting out, repairing with the wrench, lifting and pouring a fuel can, the map, the pack and making camp), plus solo play, skipping, the key names in lesson text, and that nobody can bleed out.

The page also exposes `window.__game` with `advance(seconds)` for running the simulation deterministically from the console,
which is how most of the in-browser checks were done.

### Recorded audio

Effects and ambience use bundled recordings with no generated sound fallback. Vegetation rustles and wood impacts, wildlife and insects, rain, wind, fire and moving water respond to the scene; swimming, wading, wheel and boat splashes follow movement speed. Footsteps use recorded sand, grass, wood and concrete takes. Bike, car and diesel engines blend recorded idle/load sections with RPM, throttle, vehicle identity and bounded Doppler. Each event cue has at least three recorded takes or excerpts; firearm families have six. Some related cues share recordings.

Most recordings are CC0. The deer recording is CC BY 4.0 and requires the supplied attribution when distributing a commercial build. Keep `public/audio/CREDITS.txt` with distributions. Settings shows recording load status and a credits link. Radio uses captions and recorded receiver noise by default; optional browser TTS is explicitly labeled synthesized speech. The generated soundtrack has been removed; player-imported music remains available.

Playback uses shuffled take decks, with no immediate repeat across deck boundaries. A physical event shares its take and pitch between both listeners. Cue-specific hearing ranges fade smoothly; moving listeners update existing sounds, with air absorption and continuous wall occlusion. Each listener has separate enclosure reflections, sampled at four directions outdoors or supplied by interior state. Action intensity controls loudness and brightness independently of suppression. Ambient beds gently swell and crossfade between recorded takes and starting offsets. At most 64 positional playback routes and six active vehicle sources run at once. The asset bank and licenses are checked by `tests/recordings.test.ts`; `tests/audioDynamics.test.ts` covers variation, intensity, spatial updates and room separation.

Vehicle sound follows the fitted motor's fuel, layout and displacement rather than the chassis model. Real bike/car/diesel/V8 banks blend by load; motor swaps rebuild the source. Gearbox wear/strain, exhaust noise, cooling capacity, heat, oil, coolant and engine wear drive separate recorded layers. Road/off-road tires, mixed per-wheel treads, bare rims, flat tires, sliding, airborne wheels and wheel radius affect rolling texture, squeal and thump cadence. Shutdown leaves heat ticks and coolant steam audible. Crashes layer recorded panel impacts with action intensity and vehicle mass.

The current simulation supplies a final-drive ratio but no discrete selected gear; audio infers automatic gear bands from speed with hysteresis and a brief load dip. Component sounds use recorded foley and filtering where isolated component recordings are unavailable (fan, steam, flat-tire thumps and damaged gear metal). These are documented in the credits, rather than claimed as separate recordings of every engine/part.

Weapon draw, magazine removal/insertion, dry trigger, jam clearing, pump/bolt cycles, cylinder actions and individual shell loading use shuffled real recording banks. Reload landmarks follow animation progress, so cancelled reloads cannot leave queued mechanical sounds. Weapon family and size adjust playback; tactical reloads omit an unnecessary pistol rack. `tests/componentAudio.test.ts` checks customized part responses and reload timing; `tests/audio.test.ts` checks motor swap and component-loop cleanup.

Running motors and sustained component beds also crossfade to shuffled alternate recorded takes at staggered intervals, preserving current pitch and filtering; retired sources are stopped and released.
