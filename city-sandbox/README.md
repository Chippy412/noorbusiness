# Neon Tide

A 3D open-world courier game that runs in the browser. You are a courier on a
sun-soaked island city: take jobs from depots, race the clock across downtown,
the harbour, the beach and the bridge to Lighthouse Key, pull stunts for
bonuses, hunt hidden tide shards, and spend your earnings at the garage.

Everything is generated in code: models, shaders, the day/night sky, the ocean,
every sound effect and the music. There are no asset files and no build step.
Three.js renders, cannon-es simulates; both load from a CDN.

## Run it

ES modules do not load from `file://`, so serve the folder with any static
server and open it:

```bash
cd city-sandbox
python3 -m http.server 8000
```

Then open <http://localhost:8000>. An internet connection is needed to fetch
the two libraries from jsDelivr.

## Controls

| Key | On foot | Driving |
| --- | --- | --- |
| W A S D | Move | Throttle, brake/reverse, steer |
| Mouse | Look | Look (camera re-centres behind the car) |
| Shift | Sprint (uses stamina) | Fire a nitro charge |
| Space | Jump | Handbrake |
| F | Get in the nearest car | Get out |
| E | Take a job at a depot, open the garage | Same |
| R | | Flip the car back onto its wheels |
| H | | Horn |
| M | Full map | Full map |
| Esc | Pause menu | Pause menu |

## How to play

- **Jobs**: drive or walk into a cyan beacon and press E. Express runs,
  collections, multi-drops and fragile cargo each pay differently. Time left on
  the clock is a bonus. Crashing damages fragile cargo.
- **Stunts**: airtime off ramps, long drifts and near misses with pedestrians
  pay on the spot.
- **Pickups**: nitro canisters, repair kits, energy drinks and cash respawn
  around the island. Thirty tide shards do not: many hang in the air where
  only a good jump reaches them.
- **Garage** (magenta beacon, west side): engine, tyres, nitro tank and frame
  upgrades, repairs and refills.
- **Ranks**: lifetime earnings take you from Rookie to Island Legend.
- Drive into the sea and you are fished out at the last dry spot.
- Progress and settings save automatically in the browser.

## Code map

| File | Role |
| --- | --- |
| `js/config.js` | Every tunable number, and the coordinate conventions |
| `js/main.js` | Frame loop, screens (title/play/pause/shop), on-foot/driving state machine, gameplay glue |
| `js/physics.js` | cannon-es world, materials, collision groups, ray casts |
| `js/world.js` | The island: land, downtown grid, harbour, beach, park belt, islet, ramps, props |
| `js/player.js` | Third-person character controller with stamina |
| `js/vehicle.js` | Ray-cast-wheel cars: handling, nitro, damage, upgrades |
| `js/npc.js` | Pedestrians: wander, idle, flee, get knocked over |
| `js/camera.js` | Orbit camera: wall avoidance, speed FOV, shake |
| `js/hud.js` | HUD, minimap, menus, shop |
| `js/audio.js` | Synthesised engine, effects, ambience and music (Web Audio) |
| `js/characters.js` | Humanoid model shared by player and NPCs |
| `js/input.js` | Keyboard, mouse and pointer lock |
| `js/game/progress.js` | Save data, ranks, upgrades, settings |
| `js/game/items.js` | Pickups and collectibles |
| `js/game/missions.js` | Courier jobs and beacons |
| `js/gfx/sky.js` | Day/night sky shader, sun/moon lighting, fog |
| `js/gfx/water.js` | Ocean shader |
| `js/gfx/materials.js` | Procedural building facades, ground surfaces, neon, beacons |
| `js/gfx/postfx.js` | Bloom, colour grade, speed effects |
| `js/gfx/models.js` | Cars, props, set pieces and pickups |
| `js/gfx/particles.js` | Smoke, sparks, splashes, fireworks |

`window.game` is exposed in the console for poking at live state.
