/**
 * main.js — entry point: creates every system, runs the game loop and owns
 * the player <-> vehicle state machine.
 *
 * STATE MACHINE
 *   ON_FOOT --[F near a car]--> DRIVING --[F]--> ON_FOOT
 *
 *   enterVehicle(): the player's physics body is removed from the world and
 *     its model hidden (the driver is "inside" the chassis), the car is marked
 *     occupied so it accepts input, and the camera starts chasing the car.
 *   exitVehicle(): a free spot beside the car is found with ray casts, the
 *     player's body is re-added there, and the car parks itself.
 *
 * FRAME ORDER
 *   1. read input -> player / vehicle controls
 *   2. physics.step(dt)   (fixed 60 Hz sub-steps; controls are applied in the
 *                          controllers' pre-step callbacks)
 *   3. sync meshes from interpolated physics transforms, update NPCs
 *   4. camera, HUD, render
 */
import * as THREE from 'three';
import { CONFIG, MODE } from './config.js';
import { Physics, GROUP } from './physics.js';
import { Input } from './input.js';
import { World } from './world.js';
import { Player } from './player.js';
import { Vehicle } from './vehicle.js';
import { NPCManager } from './npc.js';
import { CameraRig } from './camera.js';
import { HUD } from './hud.js';

class Game {
  constructor() {
    const canvas = document.getElementById('game');

    // --- renderer & scene ---------------------------------------------------
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(CONFIG.colors.sky);
    this.scene.fog = new THREE.Fog(CONFIG.colors.sky, 120, 420);
    this._buildLights();

    // --- systems ------------------------------------------------------------
    this.physics = new Physics();
    this.world = new World({ scene: this.scene, physics: this.physics });

    const spawn = this.world.spawn;
    this.player = new Player({ physics: this.physics, scene: this.scene, ...spawn.player });
    this.vehicles = spawn.vehicles.map(
      (s, n) =>
        new Vehicle({
          physics: this.physics,
          scene: this.scene,
          color: CONFIG.colors.vehicles[n % CONFIG.colors.vehicles.length],
          ...s,
        })
    );
    this.npcs = new NPCManager({
      scene: this.scene,
      world: this.world,
      vehicles: this.vehicles,
      count: CONFIG.npc.count,
    });

    this.rig = new CameraRig({ physics: this.physics, aspect: window.innerWidth / window.innerHeight });
    this.rig.yaw = spawn.player.heading + Math.PI; // start behind the player

    this.input = new Input(canvas);
    this.hud = new HUD({ world: this.world });

    // --- game state ---------------------------------------------------------
    this.mode = MODE.ON_FOOT;
    /** @type {Vehicle|null} */
    this.activeVehicle = null;
    this.paused = true; // until the start overlay is clicked
    this._message = null;
    this._messageTime = 0;
    this._fps = 60;
    this._last = performance.now();

    this.hud.onStart(() => {
      this.paused = false;
      this.hud.setPointerLocked(true); // hide the overlay even if the lock is refused
      this.input.requestLock();
    });
    this.input.onLockChange = (locked) => {
      this.paused = !locked;
      this.hud.setPointerLocked(locked);
    };
    window.addEventListener('resize', () => {
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.rig.resize(window.innerWidth / window.innerHeight);
    });

    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  _buildLights() {
    this.scene.add(new THREE.HemisphereLight(0xdfefff, 0x4a4a42, 1.5));
    const sun = new THREE.DirectionalLight(0xfff2d6, 2.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = 70;
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 400 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.05;
    this.scene.add(sun, sun.target);
    this.sun = sun;
    this._sunOffset = new THREE.Vector3(70, 140, 45);
  }

  // =========================================================================
  // State machine
  // =========================================================================

  /** Closest car the player could get into right now, or null. */
  _nearestVehicle() {
    let best = null;
    let bestDist = CONFIG.player.enterRange;
    for (const v of this.vehicles) {
      const d = v.position.distanceTo(this.player.position);
      if (d < bestDist) {
        best = v;
        bestDist = d;
      }
    }
    return best;
  }

  enterVehicle(vehicle) {
    this.mode = MODE.DRIVING;
    this.activeVehicle = vehicle;
    vehicle.occupied = true;
    this.player.setEnabled(false);
  }

  exitVehicle() {
    const vehicle = this.activeVehicle;
    if (!vehicle) return;
    const spot = this._findExitSpot(vehicle);
    vehicle.occupied = false;
    vehicle.setControls(0, 0, false);
    this.player.setEnabled(true);
    // Leaving a moving car carries over part of its momentum.
    const v = vehicle.velocity;
    this.player.teleport(spot.x, spot.y, spot.z, vehicle.heading, { x: v.x * 0.5, y: 0, z: v.z * 0.5 });
    this.mode = MODE.ON_FOOT;
    this.activeVehicle = null;
  }

  /**
   * Find somewhere to stand next to the car: try the driver's side, the
   * passenger side, then behind and in front. A spot is good if nothing solid
   * lies between the car and it and there is ground underneath. If every side
   * is blocked (car wedged in an alley) the player climbs out onto the roof.
   */
  _findExitSpot(vehicle) {
    const { width, length } = CONFIG.vehicle.chassis;
    const h = vehicle.heading;
    const fx = Math.sin(h), fz = Math.cos(h); // forward
    const lx = Math.cos(h), lz = -Math.sin(h); // left
    const side = width / 2 + 0.95;
    const ends = length / 2 + 0.95;
    const candidates = [
      [lx * side, lz * side],
      [-lx * side, -lz * side],
      [-fx * ends, -fz * ends],
      [fx * ends, fz * ends],
    ];
    const origin = { x: vehicle.position.x, y: vehicle.position.y + 0.6, z: vehicle.position.z };
    const solid = GROUP.STATIC | GROUP.PROP | GROUP.VEHICLE;

    for (const [dx, dz] of candidates) {
      const target = { x: origin.x + dx * 1.35, y: origin.y, z: origin.z + dz * 1.35 };
      if (this.physics.raycast(origin, target, GROUP.STATIC | GROUP.PROP)) continue; // wall in the way
      const top = { x: origin.x + dx, y: origin.y + 1.2, z: origin.z + dz };
      const bottom = { x: top.x, y: top.y - 5, z: top.z };
      const ground = this.physics.raycast(top, bottom, solid);
      if (!ground) continue;
      const groundY = ground.hitPointWorld.y;
      if (groundY > origin.y + 0.5) continue; // something tall is standing there
      return { x: top.x, y: groundY, z: top.z };
    }
    return { x: vehicle.position.x, y: vehicle.position.y + 1.5, z: vehicle.position.z };
  }

  _flash(message, seconds = 2) {
    this._message = message;
    this._messageTime = seconds;
  }

  // =========================================================================
  // Per-frame update
  // =========================================================================

  _handleInput() {
    const input = this.input;
    if (this.paused) {
      // No control while the overlay is up; cars coast to a stop.
      this.player.setInput(0, 0, false, false);
      if (this.activeVehicle) this.activeVehicle.setControls(0, 0, true);
      return;
    }

    const forward = input.axis(['KeyS', 'ArrowDown'], ['KeyW', 'ArrowUp']);
    const right = input.axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']);

    if (this.mode === MODE.ON_FOOT) {
      // Movement is relative to where the camera looks.
      const fx = this.rig.forwardX, fz = this.rig.forwardZ;
      const rx = -fz, rz = fx; // camera right = forward rotated -90 degrees about Y
      this.player.setInput(
        fx * forward + rx * right,
        fz * forward + rz * right,
        input.isDown('ShiftLeft') || input.isDown('ShiftRight'),
        input.wasPressed('Space')
      );
      if (input.wasPressed('KeyF')) {
        const vehicle = this._nearestVehicle();
        if (vehicle) this.enterVehicle(vehicle);
      }
    } else {
      const vehicle = this.activeVehicle;
      vehicle.setControls(forward, -right, input.isDown('Space')); // steerInput: +1 = left
      if (input.wasPressed('KeyR')) vehicle.resetUpright();
      if (input.wasPressed('KeyF')) this.exitVehicle();
    }
  }

  _prompt() {
    if (this._messageTime > 0) return this._message;
    if (this.mode === MODE.ON_FOOT) {
      return this._nearestVehicle() ? 'Press F to enter vehicle' : null;
    }
    const v = this.activeVehicle;
    if (v.upright < 0.35 && v.speed < 3) return 'Press R to flip the car back over';
    if (v.speed < 1) return 'Press F to exit vehicle';
    return null;
  }

  _update(dt) {
    this._handleInput();
    this.physics.step(dt);

    // Sync visuals from physics.
    this.physics.syncMeshes();
    this.player.update(dt);
    for (const v of this.vehicles) v.update();
    this.npcs.update(dt);

    // Camera follows whichever subject the current state says.
    const subject = this.mode === MODE.DRIVING ? this.activeVehicle : this.player;
    const mouse = this.input.consumeMouse();
    this.rig.update(dt, this.mode, subject, this.paused ? { x: 0, y: 0 } : mouse);

    // Keep the shadow frustum centred on the action.
    this.sun.target.position.copy(this.rig.focus);
    this.sun.position.copy(this.rig.focus).add(this._sunOffset);

    this._messageTime = Math.max(0, this._messageTime - dt);
    this.hud.update({
      mode: this.mode,
      player: this.player,
      vehicles: this.vehicles,
      activeVehicle: this.activeVehicle,
      npcs: this.npcs.npcs,
      speedKmh: this.activeVehicle ? this.activeVehicle.speed * 3.6 : 0,
      prompt: this._prompt(),
      fps: this._fps,
    });

    this.input.endFrame();
  }

  _loop(now) {
    requestAnimationFrame(this._loop);
    // Clamp dt so a background tab or a hitch cannot explode the simulation.
    const dt = Math.min(0.1, Math.max(0.0001, (now - this._last) / 1000));
    this._last = now;
    this._fps += (1 / dt - this._fps) * 0.05;

    this._update(dt);
    this.renderer.render(this.scene, this.rig.camera);
  }
}

try {
  // Exposed for debugging from the browser console.
  window.game = new Game();
} catch (error) {
  console.error(error);
  const box = document.getElementById('fatal');
  if (box) {
    box.textContent = `Block City Sandbox failed to start: ${error.message}`;
    box.hidden = false;
  }
}
