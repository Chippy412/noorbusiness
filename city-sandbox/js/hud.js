/**
 * hud.js — the HTML overlay: start/pause screen, state badge, speed readout,
 * context prompt, FPS counter and the minimap.
 *
 * This module only talks to the DOM and a 2D canvas; it never imports three or
 * cannon-es. Everything it needs arrives as plain data (see HUD.update()).
 *
 * MINIMAP CONVENTIONS (see config.js):
 *   world +X -> canvas right, world +Z -> canvas down (north-up, north = -Z).
 *   heading h means forward = (sin h, 0, cos h). On a 2D canvas, ctx.rotate(a)
 *   maps the local +Y axis to (-sin a, cos a), so after ctx.rotate(-h) the
 *   local +Y axis points along the heading. Every oriented shape below is
 *   therefore drawn with "forward" = local +Y.
 */
import { CONFIG, MODE } from './config.js';

const MAP_CSS_SIZE = 200;      // minimap edge length in CSS pixels
const FPS_REFRESH_MS = 250;    // the FPS text is refreshed at most this often

// Minimum on-map marker sizes in CSS px, so things stay visible at city scale.
const VEHICLE_MIN_WIDTH = 5;
const VEHICLE_MIN_LENGTH = 9;
const NPC_RADIUS = 2;
const ARROW_SIZE = 7;

const NPC_COLOR = '#ffd84a';
const NPC_FLEE_COLOR = '#ff4d3d';

/** 0xRRGGBB number -> '#rrggbb' string, memoised (called every frame per vehicle). */
const cssColorCache = new Map();
function cssColor(hex) {
  let css = cssColorCache.get(hex);
  if (css === undefined) {
    css = '#' + ((Number(hex) >>> 0) & 0xffffff).toString(16).padStart(6, '0');
    cssColorCache.set(hex, css);
  }
  return css;
}

/** getElementById that fails loudly: a missing node means index.html is out of sync. */
function byId(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`HUD: missing #${id} element in index.html`);
  return el;
}

export class HUD {
  /**
   * @param {{ world: { half:number, blocks:Array, buildings:Array, ramps:Array } }} options
   */
  constructor({ world }) {
    this.world = world;

    // City extent: the map shows [-half, half] on both axes. Fall back to the
    // size implied by CONFIG if the world did not provide a usable value.
    const c = CONFIG.city;
    const fallbackHalf = (c.blocks * c.blockSize + (c.blocks + 1) * c.roadWidth) / 2;
    this.half = world && world.half > 0 ? world.half : fallbackHalf;

    // --- DOM nodes ---------------------------------------------------------
    this.overlayEl = byId('overlay');
    this.badgeEl = byId('badge');
    this.speedEl = byId('speed');
    this.speedValueEl = byId('speed-value');
    this.promptEl = byId('prompt');
    this.fpsEl = byId('fps');
    this.fatalEl = byId('fatal');
    this.mapCanvas = byId('minimap');
    this.mapCtx = this.mapCanvas.getContext('2d');

    // --- cached values, so the DOM is only written when something changes ---
    this._mode = null;
    this._speedText = null;
    this._prompt = null;
    this._fpsText = null;
    this._fpsStamp = -Infinity;
    this._locked = false;
    this._startCallbacks = [];

    // --- minimap backing store + static layer ------------------------------
    this._dpr = 0;
    this._staticLayer = document.createElement('canvas');
    this._resizeMinimap();

    // Clicking anywhere on the overlay (button included — the click bubbles)
    // starts / resumes the game. main.js requests pointer lock in the callback,
    // which is allowed because we are inside a user gesture here.
    this.overlayEl.addEventListener('click', () => {
      for (const callback of this._startCallbacks) callback();
    });
  }

  /** Register a callback fired when the user clicks the start overlay. */
  onStart(callback) {
    if (typeof callback === 'function') this._startCallbacks.push(callback);
  }

  /** Hide the overlay while the pointer is locked, show it again when it is released. */
  setPointerLocked(locked) {
    locked = !!locked;
    if (locked === this._locked) return;
    this._locked = locked;
    this.overlayEl.classList.toggle('hidden', locked);
  }

  /** Reveal the #fatal box with a message (startup failure, WebGL missing, ...). */
  showFatal(message) {
    this.fatalEl.textContent = String(message);
    this.fatalEl.hidden = false;
    // "Click to play" would be misleading once the game is dead.
    this.overlayEl.classList.add('hidden');
  }

  /**
   * Per-frame update.
   * @param {{ mode:string, player:{position:{x,y,z}, heading:number},
   *           vehicles:Array<{position:{x,y,z}, heading:number, color:number}>,
   *           activeVehicle:object|null, npcs:Array<{position:{x,y,z}, state:string}>,
   *           speedKmh:number, prompt:string|null, fps:number }} state
   */
  update(state) {
    const driving = state.mode === MODE.DRIVING;

    // State badge + speed pill visibility: only on a mode change.
    if (state.mode !== this._mode) {
      this._mode = state.mode;
      this.badgeEl.textContent = driving ? 'DRIVING' : 'ON FOOT';
      this.badgeEl.classList.toggle('driving', driving);
      this.badgeEl.classList.toggle('on-foot', !driving);
      this.speedEl.classList.toggle('hidden', !driving);
    }

    // Speed readout (whole km/h, magnitude so reversing does not show a minus sign).
    if (driving) {
      const kmh = Number.isFinite(state.speedKmh) ? Math.abs(state.speedKmh) : 0;
      const text = String(Math.round(kmh));
      if (text !== this._speedText) {
        this._speedText = text;
        this.speedValueEl.textContent = text;
      }
    }

    // Context prompt.
    const prompt = state.prompt || null;
    if (prompt !== this._prompt) {
      this._prompt = prompt;
      if (prompt) this.promptEl.textContent = prompt;
      this.promptEl.classList.toggle('hidden', !prompt);
    }

    // FPS counter: throttled so the digits are readable, written only on change.
    const now = performance.now();
    if (now - this._fpsStamp >= FPS_REFRESH_MS) {
      this._fpsStamp = now;
      const text = Number.isFinite(state.fps) ? `${Math.round(state.fps)} FPS` : '-- FPS';
      if (text !== this._fpsText) {
        this._fpsText = text;
        this.fpsEl.textContent = text;
      }
    }

    this._drawMinimap(state, driving);
  }

  // ------------------------------------------------------------- minimap ---

  /**
   * (Re)size the minimap backing store for the current devicePixelRatio and
   * re-render the static layer. Called once at construction and again if the
   * ratio changes (browser zoom, window dragged to another monitor).
   */
  _resizeMinimap() {
    this._rawDpr = window.devicePixelRatio || 1; // unclamped, for change detection
    const dpr = Math.min(Math.max(this._rawDpr, 1), 4);
    this._dpr = dpr;
    const px = Math.round(MAP_CSS_SIZE * dpr);
    this.mapCanvas.width = px;
    this.mapCanvas.height = px;
    this._staticLayer.width = px;
    this._staticLayer.height = px;
    // CSS px per world metre; all drawing happens in CSS px with a dpr transform.
    this._scale = MAP_CSS_SIZE / (2 * this.half);
    this._renderStaticLayer();
  }

  /** World x/z -> minimap CSS px. The same mapping serves both axes. */
  _toMap(v) {
    return (v + this.half) * this._scale;
  }

  /** Paint the things that never move (roads, blocks, buildings, ramps) once. */
  _renderStaticLayer() {
    const ctx = this._staticLayer.getContext('2d');
    const world = this.world || {};
    const s = this._scale;
    const colors = CONFIG.colors;

    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);

    // Roads: everything that is not a block is road, so fill the whole map.
    ctx.fillStyle = cssColor(colors.road);
    ctx.fillRect(0, 0, MAP_CSS_SIZE, MAP_CSS_SIZE);

    // Axis-aligned world rectangle helper.
    const rect = (r) => {
      ctx.fillRect(this._toMap(r.minX), this._toMap(r.minZ), (r.maxX - r.minX) * s, (r.maxZ - r.minZ) * s);
    };

    // Blocks: sidewalk grey, the plaza greenish.
    for (const block of world.blocks || []) {
      ctx.fillStyle = cssColor(block.type === 'plaza' ? colors.plaza : colors.sidewalk);
      rect(block);
    }

    // Building footprints in their own colour.
    for (const building of world.buildings || []) {
      ctx.fillStyle = cssColor(building.color);
      rect(building);
    }

    // Ramps: rectangles centred on (x, z), `length` along the yaw heading.
    ctx.fillStyle = cssColor(colors.ramp);
    for (const ramp of world.ramps || []) {
      const w = Math.max(ramp.width * s, 3);
      const l = Math.max(ramp.length * s, 3);
      ctx.save();
      ctx.translate(this._toMap(ramp.x), this._toMap(ramp.z));
      ctx.rotate(-(ramp.yaw || 0));
      ctx.fillRect(-w / 2, -l / 2, w, l);
      ctx.restore();
    }
  }

  /** Blit the static layer, then draw the dynamic markers on top. */
  _drawMinimap(state, driving) {
    // Cheap per-frame check; re-rendering only happens when the ratio changed.
    if ((window.devicePixelRatio || 1) !== this._rawDpr) {
      this._rawDpr = window.devicePixelRatio || 1;
      this._resizeMinimap();
    }

    const ctx = this.mapCtx;
    const s = this._scale;

    // Static layer, 1:1 in device pixels.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this._staticLayer, 0, 0);
    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);

    // NPCs: small dots, yellow normally, red while fleeing.
    const npcs = state.npcs || [];
    for (let i = 0; i < npcs.length; i++) {
      const npc = npcs[i];
      ctx.fillStyle = npc.state === 'FLEE' ? NPC_FLEE_COLOR : NPC_COLOR;
      ctx.beginPath();
      ctx.arc(this._toMap(npc.position.x), this._toMap(npc.position.z), NPC_RADIUS, 0, Math.PI * 2);
      ctx.fill();
    }

    // Vehicles: rectangles rotated by heading, in their body colour.
    const chassis = CONFIG.vehicle.chassis;
    const vw = Math.max(chassis.width * s, VEHICLE_MIN_WIDTH);
    const vl = Math.max(chassis.length * s, VEHICLE_MIN_LENGTH);
    const vehicles = state.vehicles || [];
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
    for (let i = 0; i < vehicles.length; i++) {
      const vehicle = vehicles[i];
      ctx.save();
      ctx.translate(this._toMap(vehicle.position.x), this._toMap(vehicle.position.z));
      ctx.rotate(-vehicle.heading);
      ctx.fillStyle = cssColor(vehicle.color);
      ctx.fillRect(-vw / 2, -vl / 2, vw, vl);
      ctx.strokeRect(-vw / 2, -vl / 2, vw, vl);
      ctx.restore();
    }

    // Player arrow: on the active vehicle while driving, otherwise on the player.
    const marker = driving && state.activeVehicle ? state.activeVehicle : state.player;
    if (marker && marker.position) {
      ctx.save();
      ctx.translate(this._toMap(marker.position.x), this._toMap(marker.position.z));
      ctx.rotate(-(marker.heading || 0));
      ctx.beginPath();
      ctx.moveTo(0, ARROW_SIZE);                          // tip (forward = local +Y)
      ctx.lineTo(ARROW_SIZE * 0.62, -ARROW_SIZE * 0.72);  // rear corner
      ctx.lineTo(0, -ARROW_SIZE * 0.3);                   // notch
      ctx.lineTo(-ARROW_SIZE * 0.62, -ARROW_SIZE * 0.72); // rear corner
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1.25;
      ctx.lineJoin = 'round';
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }
}
