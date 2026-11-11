# Block City Sandbox

A small 3D open-world sandbox in the browser: walk around a block city, get in
a car, jump ramps, scare pedestrians. Three.js for rendering, cannon-es for
rigid-body physics, both loaded from a CDN. No build step.

## Run it

ES modules do not load from `file://`, so serve the folder with any static
server and open it:

```bash
cd city-sandbox
python3 -m http.server 8000
```

Then open <http://localhost:8000>. An internet connection is needed the first
time, to fetch the two libraries from jsDelivr.

## Controls

| Key | On foot | Driving |
| --- | --- | --- |
| W A S D | Move | Throttle, reverse/brake, steer |
| Mouse | Look | Look (camera re-centres behind the car) |
| Shift | Run | |
| Space | Jump | Handbrake |
| F | Enter nearby vehicle | Exit vehicle |
| R | | Put the car back on its wheels |
| Esc | Release mouse (pause) | Release mouse (pause) |

## Code map

| File | Role |
| --- | --- |
| `js/config.js` | Every tunable number, and the coordinate conventions |
| `js/main.js` | Game loop and the on-foot / driving state machine |
| `js/physics.js` | cannon-es world, materials, collision groups, ray casts |
| `js/world.js` | City generation: roads, blocks, buildings, ramps, crates, sidewalk graph |
| `js/player.js` | Third-person character controller |
| `js/vehicle.js` | Ray-cast-wheel car |
| `js/npc.js` | Pedestrians: wander, idle, flee, get knocked over |
| `js/camera.js` | Orbit camera with wall avoidance |
| `js/hud.js` | HTML overlay and minimap |
| `js/characters.js` | Blocky humanoid model shared by player and NPCs |
| `js/input.js` | Keyboard, mouse and pointer lock |

`window.game` is exposed in the console for poking at live state.
