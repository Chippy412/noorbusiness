/**
 * hud.js — Neon Tide's whole 2D interface: in-play HUD, minimap + full map,
 * toasts / popups / banners, title screen, pause menu, garage shop, fatal box.
 *
 * This module only talks to the DOM and 2D canvases; it never imports three or
 * cannon-es. Everything it needs arrives as plain data (see HUD.update()).
 *
 * MAP CONVENTIONS
 *   world +X -> right, world +Z -> down (north-up, north = -Z).
 *   A heading h means forward = (sin h, cos h) in (x, z). On a 2D canvas,
 *   ctx.rotate(a) maps local +Y to (-sin a, cos a), so after ctx.rotate(-h) the
 *   local +Y axis points along the heading: oriented shapes are drawn with
 *   "forward" = local +Y.
 *   Compass: `cameraYaw` is the orbit angle used by camera.js, where the view
 *   direction is (-sin yaw, -cos yaw). Flip CAMERA_YAW_IS_ORBIT if main.js
 *   passes the view heading instead.
 */

const CAMERA_YAW_IS_ORBIT = true;

const DRIVING = 'DRIVING';
const MINIMAP_RADIUS_M = 110;     // world metres from the centre to the rim
const SPEEDO_MAX = 200;           // km/h at the end of the arc
const TOAST_MS = 3500;
const POPUP_MS = 1600;
const BANNER_MS = 3500;
const MAX_TOASTS = 4;
const TAU = Math.PI * 2;

const C = {
  sea: '#0a1a36', seaDeep: '#06102a', shallow1: '#0f2c52', shallow2: '#17466f',
  sand: '#d2bf8c', sandEdge: '#f0e2b6',
  blockBuildings: '#2b3358', blockPlaza: '#8a7fd0', blockPark: '#2f8f6a',
  road: '#7480ab', roadEdge: '#141a36', roadLine: 'rgba(255,255,255,0.28)',
  ramp: '#ff9a3d',
  npc: '#c9b8ff', npcFlee: '#ff5a6e',
  cyan: '#3df2ff', magenta: '#ff3ea5', amber: '#ffb648', green: '#4dffb0',
};

const MARKER_COLOR = { pickup: C.amber, dropoff: C.green, job: C.cyan, garage: C.magenta };
const ITEM_COLOR = { shard: '#7df9ff', cash: '#ffd34d', nitro: '#ff6ec0', repair: '#6dffb5', health: '#6dffb5' };

const TOAST_ICONS = {
  info: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10 9v5M10 6v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  good: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M6.3 10.3l2.6 2.6 4.8-5.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  bad: '<svg viewBox="0 0 20 20"><path d="M10 2.5 18.2 17H1.8z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M10 8v4.2M10 14.4v.4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  cash: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12.6 7.4c-.5-.8-1.4-1.2-2.6-1.2-1.5 0-2.6.7-2.6 1.9 0 2.6 5.3 1.2 5.3 3.9 0 1.2-1.1 1.9-2.7 1.9-1.300 0-2.300-.5-2.800-1.400M10 4.600v10.800" fill="none" stroke="currentColor" stroke-width="1.600" stroke-linecap="round"/></svg>',
};

// ------------------------------------------------------------------ helpers

function byId(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`HUD: missing #${id} element in index.html`);
  return el;
}

/** Cached DOM writers: nothing is touched unless the value really changed. */
function setText(el, value) {
  if (el.__t !== value) { el.__t = value; el.textContent = value; }
}
function setClass(el, name, on) {
  on = !!on;
  const cache = el.__c || (el.__c = {});
  if (cache[name] !== on) { cache[name] = on; el.classList.toggle(name, on); }
}
function setVar(el, name, value) {
  const cache = el.__v || (el.__v = {});
  if (cache[name] !== value) { cache[name] = value; el.style.setProperty(name, value); }
}
/** 0..1 -> '0.xxx' for a scaleX bar (quantised so tiny jitters do not write). */
function setBar(el, value) {
  setVar(el, '--v', String(Math.round(clamp01(value) * 500) / 500));
}

function clamp01(v) { return v > 0 ? (v < 1 ? v : 1) : 0; }
function num(v, fallback = 0) { return Number.isFinite(v) ? v : fallback; }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function money(v) {
  const n = Math.round(num(v));
  return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US');
}

const cssColorCache = new Map();
/** 0xRRGGBB -> '#rrggbb', memoised. */
function cssColor(hex) {
  let css = cssColorCache.get(hex);
  if (css === undefined) {
    css = '#' + ((Number(hex) >>> 0) & 0xffffff).toString(16).padStart(6, '0');
    cssColorCache.set(hex, css);
  }
  return css;
}
/** Blend a 0xRRGGBB colour toward the map's night palette so buildings sit in it. */
function buildingColor(hex) {
  const n = (Number(hex) >>> 0) & 0xffffff;
  const mix = (c, t) => Math.round(c * 0.5 + t * 0.5);
  return `rgb(${mix(n >> 16 & 255, 52)},${mix(n >> 8 & 255, 60)},${mix(n & 255, 110)})`;
}

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function restartAnimation(el, className) {
  el.classList.remove(className);
  void el.offsetWidth;            // force a reflow so the animation restarts
  el.classList.add(className);
}

// --------------------------------------------------------------- map icons

/** Mission marker glyphs, centred on (x, y); `s` is the half-size in px. */
function drawMarker(ctx, kind, x, y, s, time) {
  const color = MARKER_COLOR[kind] || '#ffffff';
  ctx.save();
  ctx.translate(x, y);
  ctx.lineJoin = 'round';
  ctx.shadowColor = color;
  ctx.shadowBlur = s * 1.2;
  if (kind === 'pickup') {            // amber parcel diamond
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, -s); ctx.lineTo(s, 0); ctx.lineTo(0, s); ctx.lineTo(-s, 0);
    ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#3a2200'; ctx.lineWidth = Math.max(1, s * 0.22);
    ctx.beginPath(); ctx.moveTo(-s * 0.45, 0); ctx.lineTo(s * 0.45, 0); ctx.moveTo(0, -s * 0.45); ctx.lineTo(0, s * 0.45); ctx.stroke();
  } else if (kind === 'dropoff') {    // green flag in a pulsing ring
    const pulse = (time / 1100) % 1;
    ctx.strokeStyle = color;
    ctx.globalAlpha = 1 - pulse;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(0, 0, s * (0.9 + pulse * 1.3), 0, TAU); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(4,20,16,0.85)';
    ctx.lineWidth = Math.max(1.5, s * 0.26);
    ctx.beginPath(); ctx.arc(0, 0, s * 0.9, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-s * 0.28, -s * 0.5); ctx.lineTo(s * 0.45, -s * 0.22); ctx.lineTo(-s * 0.28, s * 0.06);
    ctx.closePath(); ctx.fill();
    ctx.lineWidth = Math.max(1, s * 0.18);
    ctx.beginPath(); ctx.moveTo(-s * 0.28, -s * 0.5); ctx.lineTo(-s * 0.28, s * 0.52); ctx.stroke();
  } else if (kind === 'garage') {     // magenta hex nut
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = i * TAU / 6 + Math.PI / 6;
      ctx.lineTo(Math.cos(a) * s, Math.sin(a) * s);
    }
    ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#2b0420';
    ctx.beginPath(); ctx.arc(0, 0, s * 0.4, 0, TAU); ctx.fill();
  } else {                            // job: cyan ◆ with a dark core
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, -s); ctx.lineTo(s * 0.82, 0); ctx.lineTo(0, s); ctx.lineTo(-s * 0.82, 0);
    ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#06203a';
    ctx.beginPath();
    ctx.moveTo(0, -s * 0.42); ctx.lineTo(s * 0.34, 0); ctx.lineTo(0, s * 0.42); ctx.lineTo(-s * 0.34, 0);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

function drawPlayerArrow(ctx, x, y, heading, size) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-heading);
  ctx.beginPath();
  ctx.moveTo(0, size);
  ctx.lineTo(size * 0.68, -size * 0.75);
  ctx.lineTo(0, -size * 0.32);
  ctx.lineTo(-size * 0.68, -size * 0.75);
  ctx.closePath();
  ctx.shadowColor = C.cyan;
  ctx.shadowBlur = size;
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineJoin = 'round';
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#0b6f8a';
  ctx.stroke();
  ctx.restore();
}

// ====================================================================== HUD

export class HUD {
  /** @param {{ world: object }} options */
  constructor({ world } = {}) {
    this.world = world || {};
    this._handlers = new Map();
    this._last = null;              // last state passed to update()
    this._lastTime = performance.now();

    this._grabElements();
    this._buildSpeedo();
    this._bindMenus();

    // --- cached / animated values
    this._cashTarget = null;
    this._cashShown = 0;
    this._cashFrom = 0;
    this._cashT = 1;
    this._rankIndex = null;
    this._nitroMax = -1;
    this._fpsStamp = -Infinity;
    this._fade = 0;
    this._timers = { popup: 0, banner: 0, cashFlash: 0 };
    this._settings = { volume: 0.8, music: true, quality: 'medium', sensitivity: 1, invertY: false };
    this._shopKey = '';
    this._mapOpen = false;

    // --- maps
    this.bounds = this._computeBounds();
    this._static = this._renderStatic();
    this._dpr = 1;
    this._miniSize = 0;
    this._compassW = 0;
    this._measure();
    window.addEventListener('resize', () => { this._measure(); if (this._mapOpen) this._sizeFullMap(); });

    window.addEventListener('keydown', (e) => this._onKey(e));

    // Hide the CSS loading state and reveal the HUD.
    document.documentElement.classList.add('hud-ready');
  }

  // ------------------------------------------------------------- events ---

  on(event, callback) {
    if (typeof callback !== 'function') return this;
    if (!this._handlers.has(event)) this._handlers.set(event, []);
    this._handlers.get(event).push(callback);
    return this;
  }

  _emit(event, payload) {
    const list = this._handlers.get(event);
    if (!list) return;
    for (const cb of list.slice()) {
      try { cb(payload); } catch (err) { console.error(`HUD '${event}' handler failed`, err); }
    }
  }

  /** True while title, pause or shop is on screen. */
  get menuOpen() {
    return this.el.title.classList.contains('open') || this.el.pause.classList.contains('open') || this.el.shop.classList.contains('open');
  }
  /** True while the full-map overlay (KeyM) is open. */
  get mapOpen() { return this._mapOpen; }

  // -------------------------------------------------------------- set-up ---

  _grabElements() {
    const ids = [
      'hud', 'mission', 'mission-idle', 'm-title', 'm-objective', 'm-payout', 'm-timer', 'm-timer-fill', 'm-time',
      'm-integrity', 'm-int-fill', 'm-int-val', 'compass-wrap', 'compass', 'cash', 'cash-delta', 'rank', 'rank-index',
      'rank-name', 'rank-pct', 'rank-fill', 'shards', 'deliveries', 'clock-wrap', 'clock', 'fps', 'toasts', 'minimap',
      'cluster', 'nitro', 'nitro-pips', 'nitro-burn-fill', 'health', 'health-val', 'health-fill', 'speedo-ticks',
      'speedo-fill', 'speed', 'gear', 'stamina', 'stamina-fill', 'prompt', 'prompt-key', 'prompt-text', 'popup',
      'popup-text', 'popup-sub', 'banner', 'banner-title', 'banner-sub', 'fade', 'fullmap', 'fullmap-canvas',
      'shop', 'shop-cash', 'shop-list', 'shop-close', 'shop-done', 'pause', 'btn-resume', 'btn-reset', 'reset-confirm',
      'btn-reset-yes', 'btn-reset-no', 'btn-quit', 'set-volume', 'out-volume', 'set-music', 'out-music', 'set-quality',
      'set-sensitivity', 'out-sensitivity', 'set-invertY', 'out-invertY', 'title', 'btn-continue', 'btn-new',
      't-save-note', 'fatal',
    ];
    this.el = {};
    for (const id of ids) {
      this.el[id.replace(/-([a-zA-Z])/g, (_, ch) => ch.toUpperCase())] = byId(id);
    }
    this.el.gearBox = this.el.gear.parentElement;
    this.miniCtx = this.el.minimap.getContext('2d');
    this.compassCtx = this.el.compass.getContext('2d');
    this.fullCtx = this.el.fullmapCanvas.getContext('2d');
  }

  /** Tick marks + numbers around the 270° speedometer arc. */
  _buildSpeedo() {
    let svg = '';
    for (let i = 0; i <= 20; i++) {
      const a = (135 + (i / 20) * 270) * Math.PI / 180;
      const major = i % 4 === 0;
      const r1 = 72, r2 = major ? 62 : 66;
      const cos = Math.cos(a), sin = Math.sin(a);
      svg += `<line${major ? ' class="major"' : ''} x1="${(100 + cos * r1).toFixed(1)}" y1="${(100 + sin * r1).toFixed(1)}" x2="${(100 + cos * r2).toFixed(1)}" y2="${(100 + sin * r2).toFixed(1)}"/>`;
    }
    this.el.speedoTicks.innerHTML = svg;
  }

  _bindMenus() {
    const el = this.el;

    // Title
    el.btnContinue.addEventListener('click', () => this._emit('play', { newGame: false }));
    el.btnNew.addEventListener('click', () => this._emit('play', { newGame: true }));

    // Pause
    el.btnResume.addEventListener('click', () => this._emit('resume'));
    el.btnQuit.addEventListener('click', () => this._emit('quit'));
    el.btnReset.addEventListener('click', () => this._setResetConfirm(true));
    el.btnResetNo.addEventListener('click', () => this._setResetConfirm(false));
    el.btnResetYes.addEventListener('click', () => { this._setResetConfirm(false); this._emit('resetSave'); });

    el.setVolume.addEventListener('input', () => this._changeSetting('volume', Number(el.setVolume.value)));
    el.setSensitivity.addEventListener('input', () => this._changeSetting('sensitivity', Number(el.setSensitivity.value)));
    el.setMusic.addEventListener('click', () => this._changeSetting('music', !this._settings.music));
    el.setInvertY.addEventListener('click', () => this._changeSetting('invertY', !this._settings.invertY));
    el.setQuality.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-value]');
      if (btn) this._changeSetting('quality', btn.dataset.value);
    });
    el.setQuality.addEventListener('keydown', (e) => {   // arrow keys move within the radio group
      const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!dir) return;
      e.preventDefault();
      const order = ['low', 'medium', 'high'];
      const next = order[(order.indexOf(this._settings.quality) + dir + 3) % 3];
      this._changeSetting('quality', next);
      const btn = el.setQuality.querySelector(`[data-value="${next}"]`);
      if (btn) btn.focus();
    });

    // Shop
    el.shopClose.addEventListener('click', () => this._emit('closeShop'));
    el.shopDone.addEventListener('click', () => this._emit('closeShop'));
    el.shopList.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-id]');
      if (btn && !btn.disabled) this._emit('buy', btn.dataset.id);
    });

    // Keep Tab inside whichever modal is open.
    for (const overlay of [el.title, el.pause, el.shop]) {
      overlay.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        const items = [...overlay.querySelectorAll('button, input')].filter((n) => !n.disabled && n.offsetParent !== null && n.tabIndex >= 0);
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        else if (!overlay.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      });
    }
  }

  _onKey(e) {
    if (e.code === 'KeyM' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (this.menuOpen || !this.el.fatal.hidden) return;
      this._toggleMap(!this._mapOpen);
      return;
    }
    // Enter on the title screen = Continue (if there is a save) / New Game.
    if ((e.code === 'Enter' || e.code === 'NumpadEnter') && !e.repeat && this.el.title.classList.contains('open')) {
      const active = document.activeElement;
      if (active && active.tagName === 'BUTTON' && this.el.title.contains(active)) return; // native click handles it
      e.preventDefault();
      (this.el.btnContinue.hidden ? this.el.btnNew : this.el.btnContinue).click();
    }
  }

  _measure() {
    this._dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 3);
    const mini = this.el.minimap;
    const size = Math.round(mini.clientWidth) || 200;
    this._miniSize = size;
    const px = Math.round(size * this._dpr);
    if (mini.width !== px) { mini.width = px; mini.height = px; }

    const comp = this.el.compass;
    this._compassW = comp.clientWidth;
    this._compassH = comp.clientHeight;
    if (this._compassW) {
      const cw = Math.round(this._compassW * this._dpr), ch = Math.round(this._compassH * this._dpr);
      if (comp.width !== cw || comp.height !== ch) { comp.width = cw; comp.height = ch; }
    }
    this._compassKey = '';
    this._em = parseFloat(getComputedStyle(this.el.hud).fontSize) || 16;
  }

  // ------------------------------------------------------------- update ---

  update(state) {
    if (!state) return;
    const el = this.el;
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - this._lastTime) / 1000));
    this._lastTime = now;
    this._last = state;

    const driving = state.mode === DRIVING;

    // --- mission tracker
    const m = state.mission;
    setClass(el.mission, 'off', !m);
    setClass(el.missionIdle, 'off', !!m);
    if (m) {
      setText(el.mTitle, m.title || '');
      setText(el.mObjective, m.objective || '');
      setText(el.mPayout, money(m.payout));
      const timed = m.timeLeft != null && Number.isFinite(m.timeLeft);
      setClass(el.mTimer, 'off', !timed);
      let urgent = false;
      if (timed) {
        const left = Math.max(0, m.timeLeft);
        const total = num(m.timeTotal) > 0 ? m.timeTotal : Math.max(left, 1);
        setBar(el.mTimerFill, left / total);
        urgent = left < 10;
        let text;
        if (urgent) text = left.toFixed(1);
        else { const s = Math.ceil(left); text = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
        setText(el.mTime, text);
      }
      setClass(el.mTimer, 'urgent', urgent);
      setClass(el.mission, 'urgent', urgent);
      const hasInt = m.integrity != null && Number.isFinite(m.integrity);
      setClass(el.mIntegrity, 'off', !hasInt);
      if (hasInt) {
        const v = clamp01(m.integrity);
        setBar(el.mIntFill, v);
        setText(el.mIntVal, `${Math.round(v * 100)}%`);
        setClass(el.mIntegrity, 'low', v < 0.35);
      }
    } else {
      setClass(el.mission, 'urgent', false);
    }

    // --- wallet
    const cash = num(state.cash);
    if (this._cashTarget === null) {
      this._cashTarget = this._cashShown = cash;
      setText(el.cash, money(cash));
    } else if (cash !== this._cashTarget) {
      const delta = cash - this._cashTarget;
      this._cashFrom = this._cashShown;
      this._cashTarget = cash;
      this._cashT = 0;
      el.cashDelta.textContent = (delta > 0 ? '+' : '−') + money(Math.abs(delta));
      el.cashDelta.classList.toggle('gain', delta > 0);
      el.cashDelta.classList.toggle('loss', delta < 0);
      restartAnimation(el.cashDelta, 'show');
      el.cash.classList.toggle('up', delta > 0);
      el.cash.classList.toggle('down', delta < 0);
      clearTimeout(this._timers.cashFlash);
      this._timers.cashFlash = setTimeout(() => el.cash.classList.remove('up', 'down'), 900);
    }
    if (this._cashT < 1) {
      this._cashT = Math.min(1, this._cashT + dt / 0.7);
      const k = 1 - Math.pow(1 - this._cashT, 3);
      this._cashShown = this._cashT >= 1 ? this._cashTarget : this._cashFrom + (this._cashTarget - this._cashFrom) * k;
      setText(el.cash, money(this._cashShown));
    }

    // --- rank / shards / deliveries / clock / fps
    const rank = state.rank;
    if (rank) {
      const index = num(rank.index);
      setText(el.rankIndex, `R${index + 1}`);
      setText(el.rankName, rank.name || '');
      const p = clamp01(num(rank.progress));
      setBar(el.rankFill, p);
      setText(el.rankPct, `${Math.round(p * 100)}%`);
      if (this._rankIndex !== null && index > this._rankIndex) restartAnimation(el.rank, 'flash');
      this._rankIndex = index;
    }
    if (state.shards) setText(el.shards, `${num(state.shards.found)}/${num(state.shards.total)}`);
    setText(el.deliveries, String(num(state.deliveries)));

    if (Number.isFinite(state.clock)) {
      const h24 = ((state.clock % 24) + 24) % 24;
      const totalMin = Math.floor(h24 * 60 + 1e-6) % 1440;
      const hh = Math.floor(totalMin / 60), mm = totalMin % 60;
      setText(el.clock, `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`);
      setClass(el.clockWrap, 'night', h24 < 6 || h24 >= 19);
    }

    if (now - this._fpsStamp >= 400) {
      this._fpsStamp = now;
      setText(el.fps, Number.isFinite(state.fps) ? `${Math.round(state.fps)} fps` : '-- fps');
    }

    // --- bottom-right: cluster or stamina
    setClass(el.cluster, 'off', !driving);
    setClass(el.stamina, 'off', driving);
    if (driving) {
      const kmh = Math.abs(num(state.speedKmh));
      setText(el.speed, String(Math.round(kmh)));
      const arc = Math.round(clamp01(kmh / SPEEDO_MAX) * 400) / 4;       // 0..100 in 0.25 steps
      if (arc !== this._arc) { this._arc = arc; el.speedoFill.style.strokeDasharray = `${arc} 200`; el.speedoFill.style.visibility = arc > 0 ? '' : 'hidden'; }
      const gear = state.gear == null ? 'N' : String(state.gear);
      setText(el.gear, gear);
      setClass(el.gearBox, 'rev', gear === 'R');

      const nitro = state.nitro;
      setClass(el.nitro, 'gone', !nitro);
      if (nitro) {
        const max = Math.max(0, Math.min(12, Math.round(num(nitro.max))));
        if (max !== this._nitroMax) {
          this._nitroMax = max;
          this._nitroOn = -1;
          el.nitroPips.innerHTML = '<i></i>'.repeat(max);
        }
        const charges = Math.max(0, Math.min(max, Math.round(num(nitro.charges))));
        if (charges !== this._nitroOn) {
          this._nitroOn = charges;
          const pips = el.nitroPips.children;
          for (let i = 0; i < pips.length; i++) pips[i].classList.toggle('on', i < charges);
        }
        setBar(el.nitroBurnFill, nitro.active ? num(nitro.burn) : 0);
      }
      setClass(el.cluster, 'boost', !!(nitro && nitro.active));

      const hasHealth = state.carHealth != null && Number.isFinite(state.carHealth);
      setClass(el.health, 'gone', !hasHealth);
      if (hasHealth) {
        const h = clamp01(state.carHealth);
        setBar(el.healthFill, h);
        setText(el.healthVal, String(Math.round(h * 100)));
        setClass(el.health, 'warn', h < 0.5 && h >= 0.25);
        setClass(el.health, 'crit', h < 0.25);
      }
    } else {
      const st = clamp01(num(state.stamina, 1));
      setBar(el.staminaFill, st);
      setClass(el.stamina, 'rested', st >= 0.995);
      setClass(el.stamina, 'low', st < 0.25);
    }

    // --- context prompt ("F — Enter vehicle" -> keycap + text)
    const prompt = state.prompt || '';
    if (prompt !== this._prompt) {
      this._prompt = prompt;
      if (prompt) {
        const match = /^\s*(\S(?:.{0,10}?\S)?)\s+[—–-]\s+(.+)$/.exec(prompt);
        el.prompt.classList.toggle('nokey', !match);
        el.promptKey.textContent = match ? match[1] : '';
        el.promptText.textContent = match ? match[2] : prompt;
      }
      el.prompt.classList.toggle('off', !prompt);
    }

    // --- canvases
    this._drawMinimap(state, driving, now);
    this._drawCompass(state, driving);
    if (this._mapOpen) this._drawFullMap(state, driving, now);
  }

  // ----------------------------------------------------- toasts & callouts ---

  toast(text, kind = 'info') {
    if (!TOAST_ICONS[kind]) kind = 'info';
    const box = this.el.toasts;
    const node = document.createElement('div');
    node.className = `toast ${kind}`;
    node.innerHTML = `${TOAST_ICONS[kind]}<span>${escapeHtml(text)}</span>`;
    box.appendChild(node);
    const live = box.querySelectorAll('.toast:not(.leaving)');
    for (let i = 0; i < live.length - MAX_TOASTS; i++) this._dismissToast(live[i]);
    setTimeout(() => this._dismissToast(node), TOAST_MS);
  }

  _dismissToast(node) {
    if (!node.isConnected || node.classList.contains('leaving')) return;
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 320);
  }

  popup(text, sub = '') {
    const el = this.el;
    el.popupText.textContent = text;
    el.popupSub.textContent = sub || '';
    restartAnimation(el.popup, 'show');
    clearTimeout(this._timers.popup);
    this._timers.popup = setTimeout(() => el.popup.classList.remove('show'), POPUP_MS);
  }

  banner(title, subtitle = '', kind = 'good') {
    const el = this.el;
    el.bannerTitle.textContent = title;
    el.bannerSub.textContent = subtitle || '';
    el.banner.classList.remove('good', 'bad', 'info', 'cash');
    el.banner.classList.add(['good', 'bad', 'info', 'cash'].includes(kind) ? kind : 'good');
    restartAnimation(el.banner, 'show');
    clearTimeout(this._timers.banner);
    this._timers.banner = setTimeout(() => el.banner.classList.remove('show'), BANNER_MS);
  }

  setFade(alpha) {
    const a = Math.round(clamp01(num(alpha)) * 100) / 100;
    if (a !== this._fade) { this._fade = a; this.el.fade.style.opacity = String(a); }
  }

  // --------------------------------------------------------------- menus ---

  _syncChrome() {
    const title = this.el.title.classList.contains('open');
    const modal = this.el.pause.classList.contains('open') || this.el.shop.classList.contains('open');
    this.el.hud.classList.toggle('hud-hidden', title);
    this.el.hud.classList.toggle('hud-dim', modal && !title);
    if (title || modal) this._toggleMap(false);
  }

  _open(overlay, focusEl) {
    overlay.classList.add('open');
    this._syncChrome();
    if (focusEl) { try { focusEl.focus({ preventScroll: true }); } catch (_) { /* ignore */ } }
  }

  _close(overlay) {
    if (!overlay.classList.contains('open')) return;
    if (overlay.contains(document.activeElement)) document.activeElement.blur();
    overlay.classList.remove('open');
    this._syncChrome();
  }

  showTitle({ hasSave = false } = {}) {
    const el = this.el;
    el.btnContinue.hidden = !hasSave;
    el.tSaveNote.hidden = !hasSave;
    el.pause.classList.remove('open');
    el.shop.classList.remove('open');
    this._open(el.title, hasSave ? el.btnContinue : el.btnNew);
  }
  hideTitle() { this._close(this.el.title); }

  showPause(settings) {
    if (settings) Object.assign(this._settings, settings);
    this._renderSettings();
    this._setResetConfirm(false);
    const wasOpen = this.el.pause.classList.contains('open');
    this._open(this.el.pause, wasOpen ? null : this.el.btnResume);
  }
  hidePause() { this._close(this.el.pause); }

  _changeSetting(key, value) {
    this._settings[key] = value;
    this._renderSettings();
    this._emit('setting', { key, value });
  }

  _renderSettings() {
    const el = this.el, s = this._settings;
    const volume = clamp01(num(s.volume, 0.8));
    const sens = Math.min(2, Math.max(0.4, num(s.sensitivity, 1)));
    if (Number(el.setVolume.value) !== volume) el.setVolume.value = String(volume);
    if (Number(el.setSensitivity.value) !== sens) el.setSensitivity.value = String(sens);
    el.setVolume.style.setProperty('--p', `${Math.round(volume * 100)}%`);
    el.setSensitivity.style.setProperty('--p', `${Math.round((sens - 0.4) / 1.6 * 100)}%`);
    el.outVolume.textContent = `${Math.round(volume * 100)}%`;
    el.outSensitivity.textContent = `${sens.toFixed(2)}×`;
    el.setMusic.setAttribute('aria-checked', String(!!s.music));
    el.outMusic.textContent = s.music ? 'On' : 'Off';
    el.setInvertY.setAttribute('aria-checked', String(!!s.invertY));
    el.outInvertY.textContent = s.invertY ? 'On' : 'Off';
    for (const btn of el.setQuality.children) {
      const on = btn.dataset.value === s.quality;
      btn.setAttribute('aria-checked', String(on));
      btn.tabIndex = on ? 0 : -1;
    }
  }

  _setResetConfirm(on) {
    const el = this.el;
    const hadFocus = el.resetConfirm.contains(document.activeElement) || document.activeElement === el.btnReset;
    el.btnReset.hidden = on;
    el.resetConfirm.hidden = !on;
    if (hadFocus) (on ? el.btnResetNo : el.btnReset).focus();
  }

  showShop({ cash = 0, items = [] } = {}) {
    const el = this.el;
    el.shopCash.textContent = money(cash);
    const key = JSON.stringify([cash, items]);
    if (key !== this._shopKey) {
      this._shopKey = key;
      const focusedId = el.shopList.contains(document.activeElement) ? document.activeElement.dataset.id : null;
      el.shopList.innerHTML = items.length ? items.map((it) => this._shopRow(it, cash)).join('') : '<div class="shop-empty">Nothing in stock right now.</div>';
      if (focusedId != null) {
        const again = [...el.shopList.querySelectorAll('button[data-id]')].find((b) => b.dataset.id === focusedId);
        (again && !again.disabled ? again : el.shopDone).focus();
      }
    }
    const wasOpen = el.shop.classList.contains('open');
    this._open(el.shop, wasOpen ? null : (el.shopList.querySelector('button:not(:disabled)') || el.shopDone));
  }
  hideShop() { this._close(this.el.shop); }

  _shopRow(item, cash) {
    const max = Math.max(0, Math.round(num(item.maxLevel)));
    const level = Math.max(0, Math.min(max, Math.round(num(item.level))));
    const maxed = level >= max;
    const afford = num(cash) >= num(item.price);
    let pips = '';
    for (let i = 0; i < max; i++) pips += `<i${i < level ? ' class="on"' : ''}></i>`;
    const button = maxed
      ? `<button class="btn si-buy max" type="button" data-id="${escapeHtml(item.id)}" disabled>MAX</button>`
      : `<button class="btn si-buy${afford ? ' can' : ''}" type="button" data-id="${escapeHtml(item.id)}"${afford ? '' : ' disabled'} aria-label="Buy ${escapeHtml(item.name)} for ${money(item.price)}">Buy <b class="num">${money(item.price)}</b></button>`;
    return `<div class="shop-item${maxed ? ' maxed' : ''}">
      <div class="si-name">${escapeHtml(item.name)}</div>
      <div class="si-desc">${escapeHtml(item.desc || '')}</div>
      <div class="si-level"><small>Level ${level}/${max}</small><div class="pips">${pips}</div></div>
      ${button}
    </div>`;
  }

  showFatal(message) {
    const el = this.el;
    el.fatal.textContent = String(message);
    el.fatal.hidden = false;
    for (const overlay of [el.title, el.pause, el.shop, el.fullmap]) overlay.classList.remove('open');
    this._mapOpen = false;
    el.hud.classList.add('hud-hidden');
    document.documentElement.classList.add('hud-ready');
  }

  // ------------------------------------------------------- static world ---

  _computeBounds() {
    const b = this.world.bounds;
    if (b && [b.minX, b.maxX, b.minZ, b.maxZ].every(Number.isFinite) && b.maxX > b.minX && b.maxZ > b.minZ) {
      return { minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ };
    }
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const grow = (x0, x1, z0, z1) => {
      if (![x0, x1, z0, z1].every(Number.isFinite)) return;
      minX = Math.min(minX, x0, x1); maxX = Math.max(maxX, x0, x1);
      minZ = Math.min(minZ, z0, z1); maxZ = Math.max(maxZ, z0, z1);
    };
    for (const l of this.world.land || []) grow(l.x - l.hx, l.x + l.hx, l.z - l.hz, l.z + l.hz);
    for (const r of this.world.roads || []) grow(r.x1, r.x2, r.z1, r.z2);
    for (const k of this.world.blocks || []) grow(k.minX, k.maxX, k.minZ, k.maxZ);
    if (!Number.isFinite(minX)) return { minX: -300, maxX: 300, minZ: -300, maxZ: 300 };
    const pad = 80;
    return { minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad };
  }

  /** Paint everything that never moves, once, at a fixed pixels-per-metre. */
  _renderStatic() {
    const b = this.bounds, world = this.world;
    const w = b.maxX - b.minX, h = b.maxZ - b.minZ;
    const ppm = Math.max(0.2, Math.min(3, 3072 / Math.max(w, h)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * ppm));
    canvas.height = Math.max(1, Math.round(h * ppm));
    const ctx = canvas.getContext('2d');
    ctx.scale(canvas.width / w, canvas.height / h);
    ctx.translate(-b.minX, -b.minZ);

    // Sea with a faint chart grid.
    ctx.fillStyle = C.sea;
    ctx.fillRect(b.minX, b.minZ, w, h);
    ctx.strokeStyle = 'rgba(90, 160, 255, 0.07)';
    ctx.lineWidth = 1 / ppm;
    ctx.beginPath();
    const step = 50;
    for (let x = Math.ceil(b.minX / step) * step; x < b.maxX; x += step) { ctx.moveTo(x, b.minZ); ctx.lineTo(x, b.maxZ); }
    for (let z = Math.ceil(b.minZ / step) * step; z < b.maxZ; z += step) { ctx.moveTo(b.minX, z); ctx.lineTo(b.maxX, z); }
    ctx.stroke();

    // Land: two shallow-water halos, a bright surf line, then sand.
    const land = (world.land || []).filter((l) => l && Number.isFinite(l.x) && Number.isFinite(l.z));
    const landPass = (grow, fill) => {
      ctx.fillStyle = fill;
      for (const l of land) {
        roundRectPath(ctx, l.x - l.hx - grow, l.z - l.hz - grow, (l.hx + grow) * 2, (l.hz + grow) * 2, (l.r || 0) + grow);
        ctx.fill();
      }
    };
    landPass(22, C.shallow1);
    landPass(10, C.shallow2);
    landPass(1.5, C.sandEdge);
    landPass(0, C.sand);

    // Blocks.
    for (const k of world.blocks || []) {
      ctx.fillStyle = k.type === 'park' ? C.blockPark : k.type === 'plaza' ? C.blockPlaza : C.blockBuildings;
      roundRectPath(ctx, k.minX, k.minZ, k.maxX - k.minX, k.maxZ - k.minZ, 2.5);
      ctx.fill();
    }

    // Roads: dark casing, asphalt, then a faint centre line on the wide ones.
    const roads = world.roads || [];
    ctx.lineCap = 'round';
    const roadPass = (extra, style, minWidth = 0) => {
      ctx.strokeStyle = style;
      for (const r of roads) {
        const width = num(r.width, 8);
        if (width < minWidth) continue;
        ctx.lineWidth = extra < 0 ? -extra : width + extra;
        ctx.beginPath(); ctx.moveTo(r.x1, r.z1); ctx.lineTo(r.x2, r.z2); ctx.stroke();
      }
    };
    roadPass(2.4, C.roadEdge);
    roadPass(0, C.road);
    ctx.lineCap = 'butt';
    ctx.setLineDash([4, 5]);
    roadPass(-0.7, C.roadLine, 9);
    ctx.setLineDash([]);

    // Buildings, tinted toward the night palette with a lit top-left edge.
    for (const g of world.buildings || []) {
      const gw = g.maxX - g.minX, gh = g.maxZ - g.minZ;
      ctx.fillStyle = buildingColor(g.color);
      ctx.fillRect(g.minX, g.minZ, gw, gh);
      ctx.fillStyle = 'rgba(255,255,255,0.16)';
      ctx.fillRect(g.minX, g.minZ, gw, 0.8);
      ctx.fillRect(g.minX, g.minZ, 0.8, gh);
    }

    // Ramps: `length` runs along the yaw heading.
    for (const r of world.ramps || []) {
      const rw = Math.max(num(r.width, 4), 3), rl = Math.max(num(r.length, 6), 4);
      ctx.save();
      ctx.translate(r.x, r.z);
      ctx.rotate(-(r.yaw || 0));
      ctx.fillStyle = C.ramp;
      ctx.fillRect(-rw / 2, -rl / 2, rw, rl);
      ctx.fillStyle = '#fff3d6';
      ctx.fillRect(-rw / 2, rl / 2 - 1.2, rw, 1.2);     // lip at the high (forward) end
      ctx.restore();
    }
    return canvas;
  }

  // -------------------------------------------------------------- minimap ---

  _drawMinimap(state, driving, now) {
    const ctx = this.miniCtx;
    const size = this._miniSize, R = size / 2;
    const s = R / MINIMAP_RADIUS_M;                 // CSS px per metre
    const b = this.bounds;

    const focus = driving && state.activeVehicle && state.activeVehicle.position ? state.activeVehicle : state.player;
    const cx = focus && focus.position ? num(focus.position.x) : 0;
    const cz = focus && focus.position ? num(focus.position.z) : 0;
    const heading = focus ? num(focus.heading) : 0;
    const X = (x) => R + (x - cx) * s;
    const Z = (z) => R + (z - cz) * s;

    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath(); ctx.arc(R, R, R, 0, TAU); ctx.clip();
    ctx.fillStyle = C.seaDeep;
    ctx.fillRect(0, 0, size, size);

    // Static layer: one translated + scaled blit of the pre-rendered world.
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this._static, X(b.minX), Z(b.minZ), (b.maxX - b.minX) * s, (b.maxZ - b.minZ) * s);

    const inView = (x, y, pad) => x > -pad && y > -pad && x < size + pad && y < size + pad;

    // Collectibles.
    const items = state.items || [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i], x = X(it.x), y = Z(it.z);
      if (!inView(x, y, 4)) continue;
      const color = ITEM_COLOR[it.kind] || '#fff36b';
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.3;
      ctx.beginPath(); ctx.arc(x, y, 4.2, 0, TAU); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(x, y, 2, 0, TAU); ctx.fill();
    }

    // NPCs.
    const npcs = state.npcs || [];
    for (let i = 0; i < npcs.length; i++) {
      const p = npcs[i].position;
      if (!p) continue;
      const x = X(p.x), y = Z(p.z);
      if (!inView(x, y, 3)) continue;
      const st = npcs[i].state;
      ctx.fillStyle = st === 'FLEE' || st === 'flee' ? C.npcFlee : C.npc;
      ctx.beginPath(); ctx.arc(x, y, 1.8, 0, TAU); ctx.fill();
    }

    // Vehicles.
    const vw = Math.max(2 * s, 5), vl = Math.max(4.4 * s, 10);
    const vehicles = state.vehicles || [];
    ctx.lineWidth = 1;
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      if (!v.position || (driving && v === state.activeVehicle)) continue;
      const x = X(v.position.x), y = Z(v.position.z);
      if (!inView(x, y, vl)) continue;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-num(v.heading));
      roundRectPath(ctx, -vw / 2, -vl / 2, vw, vl, 1.6);
      ctx.fillStyle = cssColor(v.color);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillRect(-vw / 2 + 1, vl / 2 - 2.4, vw - 2, 1.4);     // headlight bar at the front
      ctx.restore();
    }

    // Markers inside the disc.
    const markers = state.markers || [];
    const rim = [];
    const edge = R - 11;
    for (let i = 0; i < markers.length; i++) {
      const mk = markers[i];
      const dx = (mk.x - cx) * s, dz = (mk.z - cz) * s;
      const d = Math.hypot(dx, dz);
      if (d > edge) rim.push(mk, dx / d, dz / d);
      else drawMarker(ctx, mk.kind, R + dx, R + dz, 6.5, now);
    }

    // View cone + player arrow.
    ctx.save();
    ctx.translate(R, R);
    ctx.rotate(-heading);
    const cone = ctx.createRadialGradient(0, 0, 0, 0, 0, 44);
    cone.addColorStop(0, 'rgba(61,242,255,0.32)');
    cone.addColorStop(1, 'rgba(61,242,255,0)');
    ctx.fillStyle = cone;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, 44, Math.PI / 2 - 0.5, Math.PI / 2 + 0.5); ctx.closePath(); ctx.fill();
    ctx.restore();
    drawPlayerArrow(ctx, R, R, heading, Math.max(6, size * 0.04));

    // Inner vignette so the rim reads as glass.
    const vg = ctx.createRadialGradient(R, R, R * 0.68, R, R, R);
    vg.addColorStop(0, 'rgba(4,8,20,0)');
    vg.addColorStop(1, 'rgba(4,8,20,0.6)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, size, size);

    // Off-disc markers clamp to the rim with a direction arrow.
    for (let i = 0; i < rim.length; i += 3) {
      const mk = rim[i], ux = rim[i + 1], uz = rim[i + 2];
      const x = R + ux * edge, y = R + uz * edge;
      const color = MARKER_COLOR[mk.kind] || '#fff';
      ctx.save();
      ctx.translate(R + ux * (R - 1.5), R + uz * (R - 1.5));
      ctx.rotate(Math.atan2(uz, ux));
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-5, -3.6); ctx.lineTo(-5, 3.6); ctx.closePath(); ctx.fill();
      ctx.restore();
      drawMarker(ctx, mk.kind, x - ux * 2, y - uz * 2, 5.2, now);
    }
    ctx.restore();
  }

  // -------------------------------------------------------------- compass ---

  _drawCompass(state, driving) {
    const W = this._compassW, H = this._compassH;
    if (!W) return;
    const yaw = num(state.cameraYaw);
    const view = CAMERA_YAW_IS_ORBIT ? -yaw : Math.PI - yaw;     // bearing, clockwise from north
    const focus = driving && state.activeVehicle && state.activeVehicle.position ? state.activeVehicle : state.player;
    const px = focus && focus.position ? num(focus.position.x) : 0;
    const pz = focus && focus.position ? num(focus.position.z) : 0;
    const markers = state.markers || [];
    const key = `${Math.round(view * 400)}|${Math.round(px)}|${Math.round(pz)}|${markers.length}`;
    if (key === this._compassKey) return;
    this._compassKey = key;

    const ctx = this.compassCtx;
    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const pxPerRad = W / (Math.PI * 0.95);
    const em = H / 2.3;
    const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
    const NAMES = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 3;
    for (let i = 0; i < 24; i++) {
      const d = wrap(i * TAU / 24 - view);
      const x = W / 2 + d * pxPerRad;
      if (x < -10 || x > W + 10) continue;
      if (i % 3 === 0) {
        const name = NAMES[i / 3], cardinal = i % 6 === 0;
        ctx.fillStyle = name === 'N' ? C.magenta : cardinal ? '#eaf4ff' : 'rgba(170,190,230,0.75)';
        ctx.font = `${cardinal ? 800 : 600} ${(cardinal ? 1 : 0.68) * em}px "Avenir Next","Segoe UI","Helvetica Neue",Arial,sans-serif`;
        ctx.fillText(name, x, em * 0.72);
        ctx.fillRect(x - 0.75, em * 1.42, 1.5, em * 0.5);
      } else {
        ctx.fillStyle = 'rgba(170,190,230,0.5)';
        ctx.fillRect(x - 0.5, em * 1.6, 1, em * 0.32);
      }
    }
    // Marker ticks.
    ctx.shadowBlur = 6;
    for (let i = 0; i < markers.length; i++) {
      const mk = markers[i];
      const bearing = Math.atan2(mk.x - px, -(mk.z - pz));
      const d = wrap(bearing - view);
      const x = Math.max(W * 0.17, Math.min(W * 0.83, W / 2 + d * pxPerRad));
      const color = MARKER_COLOR[mk.kind] || '#fff';
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      const y = em * 1.72, r = em * 0.3;
      ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); ctx.fill();
    }
    ctx.shadowBlur = 0;
  }

  // ------------------------------------------------------------- full map ---

  _toggleMap(open) {
    open = !!open;
    if (open === this._mapOpen) return;
    this._mapOpen = open;
    this.el.fullmap.classList.toggle('open', open);
    if (open) {
      this._sizeFullMap();
      if (this._last) this._drawFullMap(this._last, this._last.mode === DRIVING, performance.now());
    }
  }

  _sizeFullMap() {
    const b = this.bounds;
    const w = b.maxX - b.minX, h = b.maxZ - b.minZ;
    const em = this._em || 16;
    const legend = window.innerWidth > 640 ? 13.5 * em : 0;
    const availW = Math.max(120, window.innerWidth - legend - 5 * em);
    const availH = Math.max(120, window.innerHeight - 7.5 * em);
    const k = Math.min(availW / w, availH / h);
    const cw = Math.max(1, Math.floor(w * k)), ch = Math.max(1, Math.floor(h * k));
    const canvas = this.el.fullmapCanvas;
    canvas.style.width = `${cw}px`;
    canvas.style.height = `${ch}px`;
    canvas.width = Math.round(cw * this._dpr);
    canvas.height = Math.round(ch * this._dpr);
    this._full = { w: cw, h: ch, k };
  }

  _drawFullMap(state, driving, now) {
    const f = this._full;
    if (!f) return;
    const ctx = this.fullCtx, b = this.bounds, k = f.k;
    const X = (x) => (x - b.minX) * k;
    const Z = (z) => (z - b.minZ) * k;
    const em = this._em || 16;

    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this._static, 0, 0, f.w, f.h);

    const items = state.items || [];
    for (let i = 0; i < items.length; i++) {
      ctx.fillStyle = ITEM_COLOR[items[i].kind] || '#fff36b';
      ctx.beginPath(); ctx.arc(X(items[i].x), Z(items[i].z), 2, 0, TAU); ctx.fill();
    }
    const npcs = state.npcs || [];
    for (let i = 0; i < npcs.length; i++) {
      const p = npcs[i].position;
      if (!p) continue;
      ctx.fillStyle = npcs[i].state === 'FLEE' || npcs[i].state === 'flee' ? C.npcFlee : C.npc;
      ctx.beginPath(); ctx.arc(X(p.x), Z(p.z), 1.5, 0, TAU); ctx.fill();
    }
    const vehicles = state.vehicles || [];
    const vw = Math.max(2 * k, 4.5), vl = Math.max(4.4 * k, 9);
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      if (!v.position || (driving && v === state.activeVehicle)) continue;
      ctx.save();
      ctx.translate(X(v.position.x), Z(v.position.z));
      ctx.rotate(-num(v.heading));
      roundRectPath(ctx, -vw / 2, -vl / 2, vw, vl, 1.5);
      ctx.fillStyle = cssColor(v.color);
      ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.stroke();
      ctx.restore();
    }

    const markers = state.markers || [];
    const ms = Math.max(7, em * 0.55);
    ctx.font = `700 ${Math.max(10, em * 0.72)}px "Avenir Next","Segoe UI","Helvetica Neue",Arial,sans-serif`;
    ctx.textBaseline = 'middle';
    for (let i = 0; i < markers.length; i++) {
      const mk = markers[i];
      const x = Math.max(ms, Math.min(f.w - ms, X(mk.x))), y = Math.max(ms, Math.min(f.h - ms, Z(mk.z)));
      drawMarker(ctx, mk.kind, x, y, ms, now);
      if (mk.label) {
        const tw = ctx.measureText(mk.label).width;
        const left = x + ms + 6 + tw > f.w - 4;
        ctx.textAlign = left ? 'right' : 'left';
        const tx = left ? x - ms - 6 : x + ms + 6;
        ctx.lineWidth = 3.5; ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(4,8,20,0.9)';
        ctx.strokeText(mk.label, tx, y);
        ctx.fillStyle = '#fff';
        ctx.fillText(mk.label, tx, y);
      }
    }

    const focus = driving && state.activeVehicle && state.activeVehicle.position ? state.activeVehicle : state.player;
    if (focus && focus.position) {
      const x = X(focus.position.x), y = Z(focus.position.z);
      const pulse = (now / 1400) % 1;
      ctx.strokeStyle = `rgba(61,242,255,${(1 - pulse) * 0.8})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 8 + pulse * 22, 0, TAU); ctx.stroke();
      drawPlayerArrow(ctx, x, y, num(focus.heading), Math.max(8, em * 0.6));
    }
  }
}
