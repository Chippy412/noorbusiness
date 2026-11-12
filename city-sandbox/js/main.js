/**
 * main.js — Neon Tide entry point. Creates every system, runs the frame loop
 * and owns the two state machines:
 *
 * SCREEN      title -> play <-> pause
 *                        ^-> shop (garage)
 *   Only `play` advances the simulation. The title screen shows the live world
 *   from an orbiting camera; pause and shop freeze it.
 *
 * PLAYER      ON_FOOT --[F near a car]--> DRIVING --[F]--> ON_FOOT
 *   enterVehicle(): the player's physics body leaves the world and its model
 *     is hidden, the car is marked occupied and the camera chases the car.
 *   exitVehicle(): ray casts find a free spot beside the car, the player's
 *     body is put back there and the car parks itself.
 *
 * FRAME ORDER (play)
 *   input -> controls | physics.step (fixed 60 Hz sub-steps) | sync meshes,
 *   NPCs | gameplay (items, missions, stunts, water) | camera | environment,
 *   particles, audio, HUD | render through the post-processing chain
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
import { AudioEngine } from './audio.js';
import { Environment } from './gfx/sky.js';
import { Water } from './gfx/water.js';
import { PostFX } from './gfx/postfx.js';
import { ParticleSystem } from './gfx/particles.js';
import { Progress } from './game/progress.js';
import { ItemManager, ITEM_COLORS } from './game/items.js';
import { MissionManager } from './game/missions.js';

const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

class Game {
  constructor() {
    const canvas = document.getElementById('game');
    this.progress = new Progress();

    // --- renderer & scene ---------------------------------------------------
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();

    // --- systems ------------------------------------------------------------
    this.physics = new Physics();
    this.env = new Environment({ scene: this.scene, renderer: this.renderer });
    this.env.dayLength = CONFIG.world.dayLength;
    this.env.timeOfDay = CONFIG.world.startHour;

    this.world = new World({ scene: this.scene, physics: this.physics });
    this.water = new Water({ environment: this.env, y: CONFIG.world.seaLevel });
    this.water.setLandShapes(this.world.land);
    this.scene.add(this.water.mesh);
    this.particles = new ParticleSystem({ scene: this.scene, max: 5000 });

    const spawn = this.world.spawn;
    this.player = new Player({ physics: this.physics, scene: this.scene, ...spawn.player });
    this.vehicles = spawn.vehicles.map((s, n) => {
      const v = new Vehicle({ physics: this.physics, scene: this.scene, color: CONFIG.colors.vehicles[n], ...s });
      v.onImpact = (speed, other) => this._onImpact(v, speed, other);
      return v;
    });
    this.npcs = new NPCManager({ scene: this.scene, world: this.world, vehicles: this.vehicles, count: CONFIG.npc.count });
    this._npcStates = this.npcs.npcs.map((n) => n.state);
    this._npcCooldown = this.npcs.npcs.map(() => 0);

    this.items = new ItemManager({ scene: this.scene, collected: [] });
    this.missions = new MissionManager({ scene: this.scene, world: this.world });

    this.rig = new CameraRig({ physics: this.physics, aspect: window.innerWidth / window.innerHeight });
    this.rig.yaw = spawn.player.heading + Math.PI;
    this.postfx = new PostFX({ renderer: this.renderer, scene: this.scene, camera: this.rig.camera });

    // One real headlight for the car being driven (other lights are emissive).
    this.headlight = new THREE.SpotLight(0xfff1d0, 0, 70, 0.55, 0.7, 1.4);
    this.scene.add(this.headlight, this.headlight.target);

    this.input = new Input(canvas);
    this.audio = new AudioEngine();
    this.hud = new HUD({ world: this.world });

    // --- game state ---------------------------------------------------------
    this.screen = 'title';
    this.mode = MODE.ON_FOOT;
    /** @type {Vehicle|null} */
    this.activeVehicle = null;
    this.nitroTimer = 0;
    this.respawn = null;        // { t } while a fished-out-of-the-water transition runs
    this.finale = 0;            // seconds of fireworks left
    this._safe = { x: spawn.player.x, z: spawn.player.z, heading: 0 };
    this._safeTimer = 0;
    this._air = 0;              // stunt trackers
    this._drift = { time: 0, score: 0, grace: 0 };
    this._impactCooldown = 0;
    this._yellCooldown = 0;
    this._hintTimer = 0;
    this._saveTimer = 0;
    this._fireworkTimer = 0;
    this._smokeTimer = 0;
    this._fps = 60;
    this._time = 0;
    this._last = performance.now();
    this._tmp = new THREE.Vector3();

    this._applySettings();
    this._bindUI();
    this.hud.showTitle({ hasSave: this.progress.hasSave });

    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  // ===========================================================================
  // Menus, settings, save
  // ===========================================================================

  _bindUI() {
    const hud = this.hud;
    hud.on('play', ({ newGame }) => this._startGame(newGame));
    hud.on('resume', () => this._resume());
    hud.on('quit', () => {
      this._save();
      hud.hidePause();
      this.screen = 'title';
      hud.showTitle({ hasSave: this.progress.hasSave });
    });
    hud.on('resetSave', () => {
      this.progress.reset();
      this._resetWorld();
      hud.hidePause();
      this.screen = 'title';
      hud.showTitle({ hasSave: false });
    });
    hud.on('setting', ({ key, value }) => {
      this.progress.settings[key] = value;
      this._applySettings();
      this.progress.save();
    });
    hud.on('buy', (id) => this._buy(id));
    hud.on('closeShop', () => {
      hud.hideShop();
      this.audio.play('uiBack');
      this._resume();
    });

    this.input.onLockChange = (locked) => {
      if (!locked && this.screen === 'play') this._pause();
    };
    window.addEventListener('keydown', (e) => {
      // Fallback for when the browser did not grant pointer lock.
      if (e.code === 'Escape' && this.screen === 'play' && !this.input.locked) this._pause();
    });
    window.addEventListener('resize', () => this._resize());
    window.addEventListener('beforeunload', () => {
      if (this.screen !== 'title') this._save();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.screen === 'play') this._pause();
    });
  }

  _resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.rig.resize(w / h);
    this.postfx.setSize(w, h);
  }

  _applySettings() {
    const s = this.progress.settings;
    this.audio.setVolume(s.volume);
    this.audio.setMusicEnabled(s.music);
    this.rig.sensitivity = s.sensitivity;
    this.rig.invertY = s.invertY;
    const dpr = window.devicePixelRatio || 1;
    this.renderer.setPixelRatio(s.quality === 'low' ? 1 : Math.min(dpr, s.quality === 'medium' ? 1.5 : 2));
    this.renderer.shadowMap.enabled = true;
    this.env.sun.castShadow = s.quality !== 'low';
    this.postfx.setQuality(s.quality);
    this._resize();
  }

  _startGame(newGame) {
    this.audio.resume();
    this.audio.play('ui');
    if (newGame) this.progress.reset();
    else this.progress.load();
    this._resetWorld();
    this.hud.hideTitle();
    this.screen = 'play';
    this.input.requestLock();
    if (!newGame) this.hud.toast('Welcome back, courier.', 'info');
  }

  /** Put everything back at its spawn and apply the loaded profile. */
  _resetWorld() {
    const st = this.progress.state;
    const spawn = this.world.spawn;
    if (this.mode === MODE.DRIVING) {
      this.activeVehicle.occupied = false;
      this.player.setEnabled(true);
    }
    this.mode = MODE.ON_FOOT;
    this.activeVehicle = null;
    this.player.teleport(spawn.player.x, 0, spawn.player.z, spawn.player.heading);
    this.player.stamina = 1;
    this.vehicles.forEach((v, n) => {
      const s = spawn.vehicles[n];
      v.teleport(s.x, 1, s.z, s.heading);
      v.repair();
      v.applyUpgrades(st.upgrades);
      v.setControls(0, 0, false);
    });
    this.items.setCollected(st.shards);
    this.missions.cancel();
    this.env.timeOfDay = st.hour;
    this.rig.yaw = spawn.player.heading + Math.PI;
    this.rig.pitch = 0.3;
    this.nitroTimer = 0;
    this.respawn = null;
    this.finale = 0;
    this._hintTimer = 0;
    this.hud.setFade(0);
  }

  _save() {
    this.progress.state.hour = this.env.timeOfDay;
    this.progress.save();
  }

  _pause() {
    if (this.screen !== 'play') return;
    this.screen = 'pause';
    this._save();
    this.hud.showPause({ ...this.progress.settings });
  }

  _resume() {
    this.hud.hidePause();
    this.screen = 'play';
    this.input.requestLock();
  }

  _openShop() {
    this.screen = 'shop'; // set first: releasing the lock must not open the pause menu
    this.input.releaseLock();
    this.audio.play('ui');
    this.hud.showShop({ cash: this.progress.state.cash, items: this.progress.shopItems() });
  }

  _buy(id) {
    const st = this.progress.state;
    const car = this.activeVehicle || this._nearestVehicle(30);
    if ((id === 'repair' && (!car || car.health >= 100)) || (id === 'refill' && st.nitro >= this.progress.maxNitro)) {
      this.audio.play('deny');
      return;
    }
    const item = this.progress.buy(id);
    if (!item) {
      this.audio.play('deny');
      return;
    }
    this.audio.play('buy');
    if (id === 'repair') car.repair();
    else if (id === 'refill') st.nitro = this.progress.maxNitro;
    else {
      if (id === 'nitro') st.nitro = this.progress.maxNitro;
      for (const v of this.vehicles) v.applyUpgrades(st.upgrades);
    }
    this.hud.toast(`${item.name} purchased`, 'good');
    this.hud.showShop({ cash: st.cash, items: this.progress.shopItems() });
    this._save();
  }

  /** Pay the player and celebrate rank-ups. */
  _earn(amount) {
    const rankUp = this.progress.earn(amount);
    if (!rankUp) return;
    const last = rankUp.index === CONFIG.ranks.length - 1;
    this.hud.banner(last ? 'ISLAND LEGEND' : 'RANK UP', last ? 'The whole island knows your name' : rankUp.name, 'good');
    this.audio.play('rankUp');
    if (last && !this.progress.state.legend) {
      this.progress.state.legend = true;
      this.finale = 24;
    } else {
      this.finale = Math.max(this.finale, 4);
    }
  }

  // ===========================================================================
  // Player <-> vehicle state machine
  // ===========================================================================

  /** Closest car within `range` of the player, or null. */
  _nearestVehicle(range = CONFIG.player.enterRange) {
    let best = null;
    let bestDist = range;
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
    this.audio.play('enter');
    this._air = 0;
    if (this.progress.state.tutorial < 2) {
      this.progress.state.tutorial = 2;
      this.hud.toast('W/S drive · A/D steer · Space handbrake · Shift nitro', 'info');
      this.hud.toast('Drive into a cyan beacon and press E to take a courier job.', 'info');
    }
  }

  exitVehicle() {
    const vehicle = this.activeVehicle;
    if (!vehicle) return;
    const spot = this._findExitSpot(vehicle);
    vehicle.occupied = false;
    vehicle.boosting = false;
    vehicle.setControls(0, 0, false);
    this.nitroTimer = 0;
    this.player.setEnabled(true);
    const v = vehicle.velocity; // bailing out of a moving car keeps some momentum
    this.player.teleport(spot.x, spot.y, spot.z, vehicle.heading, { x: v.x * 0.5, y: 0, z: v.z * 0.5 });
    this.mode = MODE.ON_FOOT;
    this.activeVehicle = null;
    this.audio.play('exit');
  }

  /**
   * Somewhere to stand next to the car: driver's side, passenger side, behind,
   * in front. A spot is good if nothing solid lies between the car and it and
   * there is ground underneath. Wedged in on all sides: climb onto the roof.
   */
  _findExitSpot(vehicle) {
    const { width, length } = CONFIG.vehicle.chassis;
    const h = vehicle.heading;
    const fx = Math.sin(h), fz = Math.cos(h);
    const lx = Math.cos(h), lz = -Math.sin(h);
    const side = width / 2 + 0.95;
    const ends = length / 2 + 0.95;
    const candidates = [[lx * side, lz * side], [-lx * side, -lz * side], [-fx * ends, -fz * ends], [fx * ends, fz * ends]];
    const origin = { x: vehicle.position.x, y: vehicle.position.y + 0.6, z: vehicle.position.z };

    for (const [dx, dz] of candidates) {
      const target = { x: origin.x + dx * 1.35, y: origin.y, z: origin.z + dz * 1.35 };
      if (this.physics.raycast(origin, target, GROUP.STATIC | GROUP.PROP)) continue;
      const top = { x: origin.x + dx, y: origin.y + 1.2, z: origin.z + dz };
      const ground = this.physics.raycast(top, { x: top.x, y: top.y - 5, z: top.z }, GROUP.STATIC | GROUP.PROP | GROUP.VEHICLE);
      if (!ground || ground.hitPointWorld.y > origin.y + 0.5) continue;
      return { x: top.x, y: ground.hitPointWorld.y, z: top.z };
    }
    return { x: vehicle.position.x, y: vehicle.position.y + 1.5, z: vehicle.position.z };
  }

  // ===========================================================================
  // Per-frame: input
  // ===========================================================================

  _handleInput() {
    const input = this.input;
    if (this.respawn) {
      this.player.setInput(0, 0, false, false);
      if (this.activeVehicle) this.activeVehicle.setControls(0, 0, true);
      return;
    }
    const forward = input.axis(['KeyS', 'ArrowDown'], ['KeyW', 'ArrowUp']);
    const right = input.axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']);
    const shift = input.isDown('ShiftLeft') || input.isDown('ShiftRight');
    const pos = this.mode === MODE.DRIVING ? this.activeVehicle.position : this.player.position;

    if (this.mode === MODE.ON_FOOT) {
      const fx = this.rig.forwardX, fz = this.rig.forwardZ;
      const rx = -fz, rz = fx; // camera right
      this.player.setInput(fx * forward + rx * right, fz * forward + rz * right, shift, input.wasPressed('Space'));
      if (input.wasPressed('KeyF')) {
        const vehicle = this._nearestVehicle();
        if (vehicle) this.enterVehicle(vehicle);
      }
    } else {
      const vehicle = this.activeVehicle;
      vehicle.setControls(forward, -right, input.isDown('Space')); // steerInput: +1 = left
      if (input.wasPressed('KeyR')) vehicle.resetUpright();
      if (input.wasPressed('KeyH')) this.audio.play('horn');
      if (input.wasPressed('ShiftLeft') || input.wasPressed('ShiftRight')) this._fireNitro();
      if (input.wasPressed('KeyF')) this.exitVehicle();
    }

    if (input.wasPressed('KeyE')) {
      const at = !this.missions.active && this.missions.depotAt(pos.x, pos.z);
      if (at) this._acceptJob(at.index);
      else if (this.missions.atGarage(pos.x, pos.z)) this._openShop();
    }
  }

  _fireNitro() {
    const st = this.progress.state;
    if (this.nitroTimer > 0) return;
    if (st.nitro <= 0) {
      this.audio.play('deny');
      this.hud.toast('Out of nitro — grab a blue canister', 'bad');
      return;
    }
    st.nitro--;
    this.nitroTimer = CONFIG.nitro.duration;
    this.activeVehicle.boosting = true;
    this.audio.play('nitro');
    this.rig.shake(0.25);
  }

  _acceptJob(index) {
    const job = this.missions.accept(index, this.progress.rank.index);
    this.audio.play('missionStart');
    this.hud.banner(job.title.toUpperCase(), `${money(job.payout)} · ${job.time}s on the clock`, 'info');
    if (this.progress.state.tutorial < 3) {
      this.progress.state.tutorial = 3;
      this.hud.toast('Follow the marker on the minimap. Time left over pays a bonus!', 'info');
    }
  }

  // ===========================================================================
  // Per-frame: gameplay
  // ===========================================================================

  _onImpact(vehicle, speed, other) {
    if (vehicle !== this.activeVehicle || this._impactCooldown > 0) return;
    if (other.collisionFilterGroup === GROUP.PLAYER) return;
    this._impactCooldown = 0.3;
    const soft = other.collisionFilterGroup === GROUP.PROP ? 0.3 : 1;
    const wasAlive = vehicle.health > 0;
    vehicle.damage((speed - 3.5) * 2.6 * soft);
    this.missions.notifyImpact(3.5 + (speed - 3.5) * soft);
    this.audio.play('crash', { volume: clamp01(speed / 22) });
    this.rig.shake(clamp01(speed / 25) * 0.9);
    const p = this._tmp.copy(vehicle.position);
    p.x += Math.sin(vehicle.heading) * 1.9 * Math.sign(vehicle.forwardSpeed || 1);
    p.z += Math.cos(vehicle.heading) * 1.9 * Math.sign(vehicle.forwardSpeed || 1);
    this.particles.preset('spark', p, { count: Math.round(8 + speed * 2) });
    if (wasAlive && vehicle.health <= 0) {
      this.hud.toast('Engine wrecked! Find a repair kit or visit the garage.', 'bad');
    }
  }

  _collectItems(dt, pos, driving) {
    const st = this.progress.state;
    const car = this.activeVehicle;
    const point = this._tmp.set(pos.x, pos.y + (driving ? 0.3 : 0.9), pos.z);
    const taken = this.items.update(dt, point, driving ? 2.7 : 1.5, (item) => {
      if (item.kind === 'nitro') return st.nitro < this.progress.maxNitro;
      if (item.kind === 'repair') return driving && car.health < 100;
      if (item.kind === 'energy') return !driving;
      return true;
    });
    for (const item of taken) {
      this.particles.preset('pickup', item, { color: ITEM_COLORS[item.kind] });
      switch (item.kind) {
        case 'shard': {
          st.shards.push(item.id);
          this.audio.play('coin');
          this._earn(60);
          const left = this.items.shardTotal - st.shards.length;
          this.hud.popup('TIDE SHARD', left ? `${st.shards.length} / ${this.items.shardTotal} · +$60` : 'ALL SHARDS FOUND!');
          if (!left) {
            this._earn(2500);
            this.hud.banner('SHARD HUNTER', 'Every tide shard found · +$2,500', 'good');
            this.finale = Math.max(this.finale, 10);
          }
          this._save();
          break;
        }
        case 'nitro':
          st.nitro++;
          this.audio.play('pickup');
          this.hud.toast('Nitro charge +1', 'good');
          break;
        case 'repair':
          car.repair();
          this.audio.play('pickup');
          this.hud.toast('Car repaired', 'good');
          break;
        case 'energy':
          this.player.stamina = 1;
          this.player.energy = 20;
          this.audio.play('pickup');
          this.hud.toast('Energy rush — free sprint for 20s', 'good');
          break;
        case 'cash': {
          const amount = 40 + Math.floor(Math.random() * 7) * 10;
          this._earn(amount);
          this.audio.play('cash');
          this.hud.toast(`+${money(amount)}`, 'cash');
          break;
        }
      }
    }
  }

  _updateMissions(dt, pos) {
    for (const e of this.missions.update(dt, pos)) {
      if (e.type === 'tick') this.audio.play('tick');
      else if (e.type === 'stage') {
        this.audio.play('pickup');
        this.hud.toast(e.done.kind === 'pickup' ? 'Parcel collected' : 'Dropped off — next stop!', 'good');
      } else if (e.type === 'failed') {
        this.audio.play('missionFail');
        this.hud.banner('JOB FAILED', e.reason, 'bad');
      } else if (e.type === 'complete') {
        this.progress.state.deliveries++;
        this.audio.play('missionComplete');
        this.hud.banner('DELIVERY COMPLETE', `${money(e.payout)} + ${money(e.bonus)} time bonus`, 'good');
        this.particles.preset('confetti', { x: pos.x, y: pos.y + 2, z: pos.z });
        this._earn(e.payout + e.bonus);
        if (this.progress.state.tutorial < 4) {
          this.progress.state.tutorial = 4;
          this.hud.toast('Spend cash at the Low Tide Garage (magenta beacon, west). M opens the map.', 'info');
        }
        this._save();
      }
    }
  }

  /** Airtime, drifts and near misses pay small bonuses. */
  _updateStunts(dt) {
    const v = this.activeVehicle;
    if (!v) return;

    // Airtime: paid on landing.
    if (v.airborne) {
      this._air += dt;
    } else if (this._air > 0) {
      if (this._air > 0.75) {
        const reward = Math.round((this._air * 70) / 5) * 5;
        this._earn(reward);
        this.hud.popup(`AIRTIME ${this._air.toFixed(1)}s`, `+${money(reward)}`);
        this.audio.play('stunt');
        this.rig.shake(0.35);
        this.particles.preset('dust', v.position, { count: 24 });
      }
      this._air = 0;
    }

    // Drift: accumulates while sliding, paid when the slide ends.
    const d = this._drift;
    if (v.slip > 0.45 && v.speed > 9 && !v.airborne) {
      d.time += dt;
      d.score += v.speed * dt * 1.3;
      d.grace = 0.45;
    } else if (d.time > 0 && (d.grace -= dt) <= 0) {
      if (d.time > 1.1) {
        const reward = Math.round(d.score / 5) * 5;
        this._earn(reward);
        this.hud.popup(`DRIFT ${d.time.toFixed(1)}s`, `+${money(reward)}`);
        this.audio.play('stunt');
      }
      d.time = d.score = 0;
    }

    // Near misses: brushing past a pedestrian at speed without hitting them.
    if (v.speed > 11) {
      this.npcs.npcs.forEach((n, i) => {
        if (this._npcCooldown[i] > 0 || n.state === 'KNOCKED') return;
        const dist = Math.hypot(n.position.x - v.position.x, n.position.z - v.position.z);
        if (dist < 3.3 && dist > 1.9) {
          this._npcCooldown[i] = 5;
          this._earn(20);
          this.hud.popup('NEAR MISS', '+$20');
          this.audio.play('stunt', { pitch: 1.3 });
        }
      });
    }
  }

  /** Pedestrian reactions (sound only: the AI itself lives in npc.js). */
  _updateNpcReactions(dt, pos) {
    this._yellCooldown -= dt;
    this.npcs.npcs.forEach((n, i) => {
      this._npcCooldown[i] = Math.max(0, this._npcCooldown[i] - dt);
      const prev = this._npcStates[i];
      if (n.state !== prev) {
        this._npcStates[i] = n.state;
        const near = Math.hypot(n.position.x - pos.x, n.position.z - pos.z) < 30;
        if (n.state === 'KNOCKED') {
          this._npcCooldown[i] = 8;
          this.audio.play('npcYell', { pitch: 0.8 + Math.random() * 0.6 });
        } else if (n.state === 'FLEE' && near && this._yellCooldown <= 0) {
          this._yellCooldown = 1.2;
          this.audio.play('npcYell', { volume: 0.5, pitch: 1.1 + Math.random() * 0.5 });
        }
      }
    });
  }

  /** Remember dry land to return to; start a rescue if we end up in the sea. */
  _updateWater(dt, pos, driving) {
    const shore = this.world.landDistance(pos.x, pos.z);
    if (this.respawn) {
      const r = this.respawn;
      r.t += dt;
      this.hud.setFade(r.t < 0.45 ? r.t / 0.45 : clamp01(1 - (r.t - 0.75) / 0.5));
      if (!r.moved && r.t >= 0.45) {
        r.moved = true;
        const s = this._safe;
        if (driving) this.activeVehicle.teleport(s.x, 1, s.z, s.heading);
        else this.player.teleport(s.x, 0.1, s.z, s.heading);
      }
      if (r.t > 1.25) {
        this.respawn = null;
        this.hud.setFade(0);
      }
      return shore;
    }

    const low = driving ? pos.y < 1.3 : pos.y < 0.6;
    if (shore > 1.6 && low) {
      this.respawn = { t: 0, moved: false };
      this.audio.play('splash');
      this.particles.preset('splash', { x: pos.x, y: CONFIG.world.seaLevel + 0.3, z: pos.z }, { count: 60 });
      this.hud.toast('Fished out of the bay.', 'info');
      if (driving) {
        this.activeVehicle.boosting = false;
        this.nitroTimer = 0;
      }
      return shore;
    }

    this._safeTimer -= dt;
    const steady = driving ? !this.activeVehicle.airborne && this.activeVehicle.upright > 0.8 : this.player.grounded;
    if (this._safeTimer <= 0 && shore < -9 && steady) {
      this._safeTimer = 0.5;
      this._safe.x = pos.x;
      this._safe.z = pos.z;
      this._safe.heading = driving ? this.activeVehicle.heading : this.player.heading;
    }
    return shore;
  }

  /** Tyre smoke, nitro flame, wrecked-engine smoke, footstep dust, fireworks. */
  _updateEffects(dt) {
    const v = this.activeVehicle;
    this._smokeTimer -= dt;
    if (v && this._smokeTimer <= 0) {
      this._smokeTimer = 0.04;
      const wheels = v.car.wheelInfos;
      if (v.slip > 0.5 && !v.airborne) {
        for (const i of [2, 3]) this.particles.preset('tyreSmoke', wheels[i].worldTransform.position, { count: 1 });
      }
      const fx = Math.sin(v.heading), fz = Math.cos(v.heading);
      if (v.boosting) {
        const p = this._tmp.set(v.position.x - fx * 2.2, v.position.y + 0.1, v.position.z - fz * 2.2);
        this.particles.preset('nitro', p, { velocity: { x: -fx * 9 + v.velocity.x, y: 0.5, z: -fz * 9 + v.velocity.z }, count: 4 });
      }
      if (v.health < 30) {
        const p = this._tmp.set(v.position.x + fx * 1.6, v.position.y + 0.7, v.position.z + fz * 1.6);
        this.particles.preset('engineSmoke', p, { count: v.health <= 0 ? 2 : 1 });
      }
    }

    if (this.finale > 0) {
      this.finale -= dt;
      this._fireworkTimer -= dt;
      if (this._fireworkTimer <= 0) {
        this._fireworkTimer = 0.25 + Math.random() * 0.45;
        const f = this.rig.focus;
        const colors = CONFIG.colors.neon;
        const p = { x: f.x + (Math.random() - 0.5) * 160, y: 45 + Math.random() * 45, z: f.z + (Math.random() - 0.5) * 160 };
        this.particles.preset('firework', p, { color: colors[Math.floor(Math.random() * colors.length)] });
        this.audio.play('firework', { volume: 0.7, pitch: 0.8 + Math.random() * 0.5 });
      }
    }
  }

  _prompt(pos) {
    if (this.respawn) return null;
    const driving = this.mode === MODE.DRIVING;
    const v = this.activeVehicle;
    if (driving && v.upright < 0.35 && v.speed < 3) return 'R — Flip the car back over';
    if (!this.missions.active) {
      const at = this.missions.depotAt(pos.x, pos.z);
      if (at) return `E — Take job: ${at.offer.title} · ${money(at.offer.payout)}`;
    }
    if (this.missions.atGarage(pos.x, pos.z)) return 'E — Open the garage';
    if (!driving) {
      const near = this._nearestVehicle();
      return near ? `F — Drive the ${near.name}` : null;
    }
    return v.speed < 1 ? 'F — Exit vehicle' : null;
  }

  // ===========================================================================
  // Frame
  // ===========================================================================

  _updatePlay(dt) {
    this._time += dt;
    this._impactCooldown -= dt;
    this._handleInput();
    if (this.screen !== 'play') return; // input opened the shop

    // Nitro burn.
    if (this.nitroTimer > 0) {
      this.nitroTimer -= dt;
      if (this.nitroTimer <= 0 && this.activeVehicle) this.activeVehicle.boosting = false;
    }

    this.physics.step(dt);
    this.physics.syncMeshes();
    this.player.update(dt);
    for (const v of this.vehicles) v.update();
    this.npcs.update(dt);

    const driving = this.mode === MODE.DRIVING;
    const v = this.activeVehicle;
    const pos = driving ? v.position : this.player.position;

    // Player audio events.
    if (this.player.justJumped) this.audio.play('jump');
    if (this.player.justLanded > 4) {
      this.audio.play('land', { volume: clamp01(this.player.justLanded / 14) });
      this.particles.preset('dust', this.player.position, { count: 8 });
    }
    this.player.justJumped = false;
    this.player.justLanded = 0;

    const shore = this._updateWater(dt, pos, driving);
    if (!this.respawn) {
      this._collectItems(dt, pos, driving);
      this._updateMissions(dt, pos);
      this._updateStunts(dt);
    }
    this._updateNpcReactions(dt, pos);
    this._updateEffects(dt);

    // Onboarding nudge.
    if (this.progress.state.tutorial === 0 && (this._hintTimer += dt) > 1.2) {
      this.progress.state.tutorial = 1;
      this.hud.toast('Welcome to Neon Tide! Your coupe is parked just ahead — walk over and press F.', 'info');
    }
    if ((this._saveTimer += dt) > 20) {
      this._saveTimer = 0;
      this._save();
    }

    // Camera.
    const mouse = this.input.consumeMouse();
    this.rig.update(dt, this.mode, driving ? v : this.player, mouse);

    // Headlights.
    const night = this.env.night;
    for (const car of this.vehicles) car.model.setHeadlights(car.occupied && night > 0.4);
    for (const car of this.vehicles) car.model.setNitro(car.boosting);
    if (driving && night > 0.4) {
      const fx = Math.sin(v.heading), fz = Math.cos(v.heading);
      this.headlight.intensity = 900 * clamp01((night - 0.4) * 3);
      this.headlight.position.set(v.position.x + fx * 1.8, v.position.y + 0.6, v.position.z + fz * 1.8);
      this.headlight.target.position.set(v.position.x + fx * 30, v.position.y - 1.5, v.position.z + fz * 30);
    } else {
      this.headlight.intensity = 0;
    }

    this.audio.update(dt, {
      paused: false,
      mode: this.mode,
      throttle: driving ? v.throttle : 0,
      speed: driving ? v.speed : 0,
      maxSpeed: driving ? v.maxSpeed : CONFIG.vehicle.maxSpeed,
      skid: driving ? v.slip : 0,
      nitro: driving && v.boosting,
      airborne: driving && v.airborne,
      footSpeed: driving ? 0 : Math.hypot(this.player.body.velocity.x, this.player.body.velocity.z),
      grounded: !driving && this.player.grounded,
      night,
      nearWater: clamp01((shore + 50) / 50),
    });
    this.postfx.setSpeed(driving ? clamp01((v.speed - 18) / 22) + (v.boosting ? 0.35 : 0) : 0);

    this._updateHud(pos, driving);
    this.input.endFrame();
    this._present(dt, dt);
  }

  _updateHud(pos, driving) {
    const st = this.progress.state;
    const v = this.activeVehicle;
    this.hud.update({
      mode: this.mode,
      fps: this._fps,
      prompt: this._prompt(pos),
      player: this.player,
      cameraYaw: this.rig.yaw,
      vehicles: this.vehicles,
      activeVehicle: v,
      npcs: this.npcs.npcs,
      speedKmh: driving ? v.speed * 3.6 : 0,
      gear: driving ? v.gear : 'N',
      cash: st.cash,
      rank: this.progress.rank,
      shards: { found: st.shards.length, total: this.items.shardTotal },
      deliveries: st.deliveries,
      stamina: this.player.stamina,
      carHealth: driving ? v.health / 100 : null,
      nitro: driving
        ? { charges: st.nitro, max: this.progress.maxNitro, active: this.nitroTimer > 0, burn: clamp01(this.nitroTimer / CONFIG.nitro.duration) }
        : null,
      clock: this.env.timeOfDay,
      mission: this.missions.hudState(),
      markers: this.missions.markers(),
      items: this.items.nearby(pos.x, pos.z, 120),
    });
  }

  /** Title screen: the live world from a slow aerial orbit. */
  _updateTitle(dt) {
    this._time += dt;
    this.npcs.update(dt);
    const a = this._time * 0.045 + 2.2;
    const cam = this.rig.camera;
    cam.position.set(Math.sin(a) * 235, 58 + Math.sin(this._time * 0.1) * 10, Math.cos(a) * 235);
    cam.lookAt(0, 14, 0);
    this.rig.focus.set(0, 0, 0);
    this.rig._initialised = false; // snap to the player when play starts
    this.audio.update(dt, {
      paused: true, mode: MODE.ON_FOOT, throttle: 0, speed: 0, maxSpeed: 1, skid: 0, nitro: false, airborne: false,
      footSpeed: 0, grounded: true, night: this.env.night, nearWater: 0.6,
    });
    this.postfx.setSpeed(0);
    this._present(dt, dt * 0.35);
  }

  /** Pause / shop: the world is frozen but still rendered. */
  _updatePaused(dt) {
    this.audio.update(dt, {
      paused: true, mode: this.mode, throttle: 0, speed: 0, maxSpeed: 1, skid: 0, nitro: false, airborne: false,
      footSpeed: 0, grounded: true, night: this.env.night, nearWater: 0,
    });
    this.input.consumeMouse();
    this.input.endFrame();
    this._present(dt, 0);
  }

  /** Shared tail of every frame: ambient animation and rendering. */
  _present(dt, worldDt) {
    this.env.update(worldDt, this.rig.focus, this.rig.camera);
    this.world.update(worldDt);
    this.water.update(dt, this.rig.camera);
    this.particles.update(worldDt);
    this.postfx.setNight(this.env.night);
    this.postfx.render(dt);
  }

  _loop(now) {
    requestAnimationFrame(this._loop);
    // Clamp dt so a background tab or a hitch cannot explode the simulation.
    const dt = Math.min(0.1, Math.max(0.0001, (now - this._last) / 1000));
    this._last = now;
    this._fps += (1 / dt - this._fps) * 0.05;

    if (this.screen === 'play') this._updatePlay(dt);
    else if (this.screen === 'title') this._updateTitle(dt);
    else this._updatePaused(dt);
  }
}

try {
  // Exposed for debugging from the browser console.
  window.game = new Game();
} catch (error) {
  console.error(error);
  const box = document.getElementById('fatal');
  if (box) {
    box.textContent = `Neon Tide failed to start: ${error.message}`;
    box.hidden = false;
  }
}
