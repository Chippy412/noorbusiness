// =============================================================================
//  NEON TIDE — procedural audio engine
// -----------------------------------------------------------------------------
//  Everything you hear is synthesised at runtime with the Web Audio API; there
//  are no sample files. The engine is split into:
//
//    * a master chain      (limiter -> soft clipper -> master volume)
//    * a "world" bus       (car engine, tyres, wind, footsteps, ambience) that
//                          is ducked while the game is paused
//    * an "sfx" bus        (one-shots; never ducked so menus stay audible)
//    * a "music" bus       (generative synthwave with its own glue compressor,
//                          tempo-synced delay and convolution reverb)
//
//  Signal flow:
//
//    world layers ─► worldBus ─┐
//    one-shots ───► sfxBus ────┤
//    fx reverb ────────────────┼─► preMaster ─► limiter ─► softClip ─► master ─► out
//    music ─► comp ─► radioLP ─┘
//
//  Nothing touches an AudioContext until resume() is called from a user
//  gesture, so the module is safe to construct at load time.
// =============================================================================

// ----------------------------------------------------------------------------
//  Small helpers
// ----------------------------------------------------------------------------
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

// ----------------------------------------------------------------------------
//  Music data
// ----------------------------------------------------------------------------
const BPM = 96;
const STEP = 60 / BPM / 4; // one 16th note, seconds
const LOOKAHEAD = 0.35; // how far ahead of the audio clock we schedule (s)
const BARS_PER_SECTION = 8;

// Chords in A minor / C major. `root` is the bass note, `notes` the pad voicing.
const CH = {
  Am9: { root: 33, notes: [57, 60, 64, 71] },
  Fmaj7: { root: 29, notes: [53, 57, 60, 64] },
  Cmaj7: { root: 36, notes: [55, 59, 60, 64] },
  Gadd9: { root: 31, notes: [55, 59, 62, 69] },
  Em7: { root: 28, notes: [55, 59, 62, 64] },
  Dm9: { root: 38, notes: [53, 57, 60, 64] },
};

// Four-bar progressions; each section plays one of them twice.
const PROGRESSIONS = [
  [CH.Am9, CH.Fmaj7, CH.Cmaj7, CH.Gadd9],
  [CH.Fmaj7, CH.Gadd9, CH.Em7, CH.Am9],
  [CH.Dm9, CH.Gadd9, CH.Cmaj7, CH.Am9],
  [CH.Am9, CH.Em7, CH.Fmaj7, CH.Gadd9],
];

// Arrangement energy per section (0 = ambient, 1 = light groove, 2 = full).
const ENERGY_CYCLE = [0, 1, 2, 2, 1, 2, 2, 0];

// Arpeggio patterns: indices into (chord notes + chord notes an octave up).
const ARP_PATTERNS = [
  [0, 1, 2, 3, 4, 3, 2, 1, 0, 1, 2, 3, 4, 3, 2, 1],
  [0, 2, 1, 3, 2, 4, 3, 5, 4, 3, 2, 1, 2, 1, 0, -1],
  [0, -1, 2, -1, 4, -1, 2, -1, 3, -1, 2, -1, 1, -1, 2, -1],
  [4, 2, 1, 2, 4, 2, 1, 2, 5, 2, 1, 2, 4, 2, 1, 2],
  [0, -1, -1, 2, -1, -1, 4, -1, 3, -1, -1, 2, -1, -1, 1, -1],
];

// A minor pentatonic for the lead line.
const LEAD_SCALE = [69, 72, 74, 76, 79, 81, 84];

// ----------------------------------------------------------------------------
//  Engine model constants
// ----------------------------------------------------------------------------
// Speed ratio (speed / maxSpeed) at which each gear tops out.
const GEAR_TOP = [0.19, 0.37, 0.57, 0.8, 1.08];
// Speed ratio at which we change up out of gear 1..4.
const GEAR_UP = [0.17, 0.335, 0.52, 0.735];
const IDLE_RPM = 0.14;

export class AudioEngine {
  constructor() {
    // No AudioContext here: browsers block audio before a user gesture.
    this.ctx = null;
    this._supported = true;
    this._volume = 0.8;
    this._musicOn = true;

    // --- simulation state used by update() ---------------------------------
    this._rpm = IDLE_RPM;
    this._gear = 1;
    this._shiftTimer = 0;
    this._load = 0;
    this._nitroAmt = 0;
    this._full = 0; // music "fullness" (0 on foot, 1 driving)
    this._wasDriving = false;
    this._paused = false;
    this._driving = false;
    this._stepPhase = 0.6;
    this._stepSide = 1;
    this._birdTimer = 2;

    // --- bookkeeping ---------------------------------------------------------
    this._targets = new Map(); // AudioParam -> last target (avoids redundant automation)
    this._voices = 0; // live one-shot/music voices
    this._lastPlayed = new Map(); // sfx name -> ctx time (rate limiting)
    this._timer = null;
    this._autoSuspended = false;

    // --- music sequencer state -------------------------------------------------
    this._nextStepTime = 0;
    this._step = 0;
    this._bar = 0;
    this._sectionIndex = -1;
    this._section = null;
    this._lastProg = -1;
    this._leadIdx = 3;
    this._leadNotes = null;
    this._musicStopAt = Infinity;

    this._onVisibility = this._onVisibility.bind(this);
    this._sfx = this._buildSfxTable();
  }

  // ===========================================================================
  //  Public API
  // ===========================================================================

  /** Call from a user gesture. Creates the context/graph once, resumes after. */
  resume() {
    if (!this._supported) return;
    if (!this.ctx) {
      const AC =
        typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
      if (!AC) {
        this._supported = false;
        return;
      }
      try {
        this.ctx = new AC({ latencyHint: 'interactive' });
        this._buildGraph();
      } catch (err) {
        // Audio is a nicety: if the device refuses, the game carries on silent.
        this.ctx = null;
        this._supported = false;
        return;
      }
      // The music scheduler runs on its own timer as well as from update(), so
      // a slow frame (or a menu that does not call update) never starves it.
      this._timer = setInterval(() => this._scheduleMusic(), 40);
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', this._onVisibility);
      }
    }
    this._autoSuspended = false;
    if (this.ctx.state !== 'running' && this.ctx.state !== 'closed') {
      const p = this.ctx.resume();
      if (p && p.catch) p.catch(() => {});
    }
  }

  /** Master volume, 0..1. */
  setVolume(v) {
    this._volume = clamp(num(v, 0.8), 0, 1);
    if (this.ctx) this._set(this.master.gain, this._volume * this._volume, 0.04);
  }

  /** Turn the generative soundtrack on or off (fades). */
  setMusicEnabled(on) {
    on = !!on;
    if (on === this._musicOn) return;
    this._musicOn = on;
    if (!this.ctx) return;
    // Let the fade finish before the sequencer stops creating voices.
    this._musicStopAt = on ? Infinity : this.ctx.currentTime + 2;
    this._applyMusicLevel();
  }

  /** Per-frame update of all continuous layers. */
  update(dt, state) {
    const ctx = this.ctx;
    if (!ctx || !state || ctx.state !== 'running') return;
    dt = clamp(num(dt, 0.016), 0.001, 0.1);

    // ---- read state defensively ------------------------------------------------
    const paused = !!state.paused;
    const driving = state.mode === 'DRIVING';
    const throttle = clamp(num(state.throttle, 0), -1, 1);
    const speed = Math.abs(num(state.speed, 0));
    const maxSpeed = Math.max(1, num(state.maxSpeed, 40));
    const skid = clamp(num(state.skid, 0), 0, 1);
    const nitro = !!state.nitro && driving;
    const airborne = !!state.airborne;
    const footSpeed = Math.abs(num(state.footSpeed, 0));
    const grounded = state.grounded !== false;
    const night = clamp(num(state.night, 0), 0, 1);
    const nearWater = clamp(num(state.nearWater, 0), 0, 1);
    const ratio = clamp(speed / maxSpeed, 0, 1.25);

    this._paused = paused;
    this._driving = driving;

    // ---- global ducking ----------------------------------------------------------
    this._set(this.worldBus.gain, paused ? 0.05 : 1, 0.12);
    this._full += ((driving ? 1 : 0) - this._full) * (1 - Math.exp(-dt * 1.6));
    this._applyMusicLevel();

    // =========================== CAR ENGINE ===========================
    if (driving && !this._wasDriving) {
      // Fresh start: begin in a gear appropriate to current speed.
      this._gear = 1;
      while (this._gear < 5 && ratio > GEAR_UP[this._gear - 1]) this._gear++;
      this._rpm = IDLE_RPM;
      this._shiftTimer = 0;
    }
    this._wasDriving = driving;

    if (!paused) {
      // Gear changes with hysteresis so the box does not hunt.
      if (this._shiftTimer > 0) this._shiftTimer -= dt;
      if (this._gear < 5 && ratio > GEAR_UP[this._gear - 1]) {
        this._gear++;
        this._shiftTimer = 0.2;
      } else if (this._gear > 1 && ratio < GEAR_UP[this._gear - 2] * 0.72) {
        this._gear--;
        this._shiftTimer = 0.12;
      }
      const pedal = Math.abs(throttle);
      let rpmT = IDLE_RPM + (1 - IDLE_RPM) * clamp(ratio / GEAR_TOP[this._gear - 1], 0, 1.05);
      // Clutch slip / free revving from a standstill.
      if (ratio < 0.08) rpmT = Math.max(rpmT, IDLE_RPM + pedal * 0.32 * (1 - ratio / 0.08));
      // Wheels in the air spin up freely.
      if (airborne) rpmT = Math.min(1.05, rpmT + 0.22 * pedal);
      const k = rpmT > this._rpm ? 7 : 4.5;
      this._rpm += (rpmT - this._rpm) * (1 - Math.exp(-dt * k));
      // Load: how hard the engine is being asked to work. Cut during a shift.
      const loadT = this._shiftTimer > 0 ? 0 : pedal;
      this._load += (loadT - this._load) * (1 - Math.exp(-dt * (loadT > this._load ? 9 : 6)));
      this._nitroAmt += ((nitro ? 1 : 0) - this._nitroAmt) * (1 - Math.exp(-dt * (nitro ? 5 : 3)));
    }
    const rpm = this._rpm;
    const load = this._load;
    const nz = this._nitroAmt;
    const e = this.eng;
    const f0 = (31 + rpm * 112) * (1 + 0.1 * nz);
    this._set(e.o1.frequency, f0, 0.035);
    this._set(e.o2.frequency, f0, 0.035);
    this._set(e.o3.frequency, f0 * 0.5, 0.035);
    this._set(e.o4.frequency, f0 * 2, 0.035);
    this._set(e.o5.frequency, f0 * 1.5, 0.035);
    this._set(e.am.frequency, f0 * 0.5, 0.035);
    // Lumpy at idle, smooth when singing.
    this._set(e.amDepth.gain, lerp(0.34, 0.07, clamp(rpm * 1.3, 0, 1)), 0.1);
    this._set(e.jitter.gain, lerp(26, 5, clamp(rpm * 1.4, 0, 1)), 0.1);
    // More drive and a brighter filter under load: this is the timbre change.
    this._set(e.drive.gain, 0.55 + load * 1.5 + nz * 0.5, 0.05);
    this._set(e.lp.frequency, 240 + rpm * 800 + load * (700 + rpm * 2600) + nz * 900, 0.06);
    this._set(e.rasp.frequency, 320 + rpm * 1500, 0.06);
    this._set(e.raspGain.gain, 0.015 + load * rpm * 0.16, 0.06);
    this._set(e.rumbleGain.gain, lerp(0.5, 0.15, clamp(rpm * 1.5, 0, 1)), 0.1);
    const engLevel = driving ? 0.105 + rpm * 0.05 + load * 0.1 + nz * 0.03 : 0;
    this._set(e.out.gain, engLevel, driving ? 0.07 : 0.22);

    // Nitro jet layer.
    this._set(this.jet.gain.gain, driving ? nz * 0.2 : 0, 0.08);
    this._set(this.jet.bp.frequency, 700 + nz * 900 + ratio * 700, 0.15);
    this._set(this.jet.whine.frequency, 520 + nz * 300 + ratio * 260, 0.2);

    // =========================== TYRES / WIND / ROAD ===========================
    const onRoad = driving && !airborne;
    const skidAmt = onRoad && speed > 1 ? Math.pow(skid, 1.3) : 0;
    this._set(this.skid.gain.gain, skidAmt * 0.17, skidAmt > 0 ? 0.04 : 0.09);
    this._set(this.skid.bp1.frequency, 1050 + ratio * 520 + skid * 180, 0.1);
    this._set(this.skid.bp2.frequency, 1720 + ratio * 760 + skid * 260, 0.1);

    let wind;
    if (driving) wind = Math.pow(clamp(ratio, 0, 1.2), 1.7) * 0.17 * (airborne ? 1.35 : 1);
    else wind = Math.pow(clamp(footSpeed / 9, 0, 1), 2) * 0.03 + (grounded ? 0 : 0.035);
    this._set(this.wind.gain.gain, wind, 0.25);
    this._set(this.wind.bp.frequency, 280 + (driving ? ratio : footSpeed / 30) * 1300, 0.25);
    this._set(this.road.gain.gain, onRoad ? Math.pow(clamp(ratio, 0, 1), 0.8) * 0.3 : 0, 0.12);
    this._set(this.road.lp.frequency, 80 + ratio * 240, 0.2);

    // =========================== FOOTSTEPS ===========================
    if (!paused && !driving && grounded && footSpeed > 0.5) {
      // Stride lengthens with speed, so cadence rises from ~1.8/s to ~3/s.
      const stride = 0.6 + 0.25 * footSpeed;
      this._stepPhase += (footSpeed * dt) / stride;
      if (this._stepPhase >= 1) {
        this._stepPhase -= Math.floor(this._stepPhase);
        this._footstep(clamp(footSpeed / 7, 0.25, 1));
      }
    } else if (footSpeed <= 0.5) {
      // Primed so the first step lands shortly after you set off.
      this._stepPhase = 0.6;
    }

    // =========================== AMBIENCE ===========================
    const day = 1 - night;
    const a = this.amb;
    this._set(a.city.gain, (0.05 + 0.07 * day) * (driving ? 0.6 : 1), 0.6);
    this._set(a.crickets.gain, night * night * 0.03 * (driving ? 0.35 : 1), 0.6);
    this._set(a.drone.gain, night * 0.05, 0.8);
    this._set(a.surf.gain, nearWater * 0.2, 0.5);
    if (!paused && day > 0.25) {
      this._birdTimer -= dt * day;
      if (this._birdTimer <= 0) {
        this._birdTimer = rand(0.5, 3.6);
        this._birdPhrase(day * (driving ? 0.45 : 1));
      }
    }

    this._scheduleMusic();
  }

  /** Fire a one-shot. Unknown names are ignored. */
  play(name, opts = {}) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    if (!Object.prototype.hasOwnProperty.call(this._sfx, name)) return;
    const now = ctx.currentTime;
    // Rate-limit identical sounds and cap polyphony so a physics pile-up can't
    // spawn thousands of nodes.
    const last = this._lastPlayed.get(name);
    if (last !== undefined && now - last < 0.035) return;
    if (this._voices > 160) return;
    this._lastPlayed.set(name, now);
    const o = opts || {};
    const v = clamp(num(o.volume, 1), 0, 1.5);
    const p = clamp(num(o.pitch, 1), 0.25, 4);
    if (v <= 0) return;
    try {
      this._sfx[name].call(this, now + 0.005, v, p);
    } catch (err) {
      /* a failed one-shot must never break the game loop */
    }
  }

  // ===========================================================================
  //  Graph construction
  // ===========================================================================

  _buildGraph() {
    const ctx = this.ctx;
    this.noise = {
      white: this._makeNoise('white', 2),
      pink: this._makeNoise('pink', 4),
      brown: this._makeNoise('brown', 4),
    };
    const impulse = this._makeImpulse(2.8);

    // ---- master chain ---------------------------------------------------------
    this.master = ctx.createGain();
    this.master.gain.value = this._volume * this._volume;
    this.master.connect(ctx.destination);

    // Soft clipper: perfectly linear below 0.6, then eases to a 0.9 ceiling, so
    // whatever slips past the limiter's attack can never hit digital full scale.
    this.clip = ctx.createWaveShaper();
    const N = 4096;
    const curve = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * 2 - 1;
      const ax = Math.abs(x);
      const y = ax <= 0.6 ? ax : 0.6 + 0.3 * Math.tanh((ax - 0.6) / 0.3);
      curve[i] = x < 0 ? -y : y;
    }
    this.clip.curve = curve;
    this.clip.oversample = '2x';
    this.clip.connect(this.master);

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -9;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 16;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.18;
    this.limiter.connect(this.clip);

    this.preMaster = ctx.createGain();
    this.preMaster.gain.value = 0.9;
    this.preMaster.connect(this.limiter);

    // ---- buses ------------------------------------------------------------------
    this.worldBus = this._gain(1, this.preMaster);
    this.sfxBus = this._gain(0.9, this.preMaster);

    // Reverb for effects and ambience.
    this.fxReverbIn = ctx.createConvolver();
    this.fxReverbIn.buffer = impulse;
    this.fxReverbIn.connect(this._gain(0.5, this.preMaster));

    this._buildMusicBus(impulse);
    this._buildEngine();
    this._buildRoadLayers();
    this._buildAmbience();
  }

  /** Convenience: gain node with a value, optionally connected to `dest`. */
  _gain(value, dest) {
    const g = this.ctx.createGain();
    g.gain.value = value;
    if (dest) g.connect(dest);
    return g;
  }

  _filter(type, freq, q, dest) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    if (q !== undefined) f.Q.value = q;
    if (dest) f.connect(dest);
    return f;
  }

  /** Permanently running oscillator. */
  _osc(type, freq, dest, detune) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    if (detune) o.detune.value = detune;
    if (dest) o.connect(dest);
    o.start();
    return o;
  }

  /** Permanently looping noise source, started at a random offset. */
  _loop(color, dest, rate) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise[color];
    s.loop = true;
    if (rate) s.playbackRate.value = rate;
    if (dest) s.connect(dest);
    s.start(0, Math.random() * (s.buffer.duration - 0.1));
    return s;
  }

  /**
   * Noise buffers. Pink/brown are generated slightly long and the tail is
   * cross-faded into the head so the loop point is seamless (a raw brown-noise
   * loop thumps once per cycle).
   */
  _makeNoise(color, seconds) {
    const sr = this.ctx.sampleRate;
    const len = Math.floor(sr * seconds);
    const fade = Math.floor(sr * 0.25);
    const raw = new Float32Array(len + fade);
    if (color === 'white') {
      for (let i = 0; i < raw.length; i++) raw[i] = Math.random() * 2 - 1;
    } else if (color === 'pink') {
      // Paul Kellet's economy pink filter.
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < raw.length; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        raw[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
    } else {
      // Brown: leaky integrator.
      let last = 0;
      for (let i = 0; i < raw.length; i++) {
        last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
        raw[i] = last * 3.5;
      }
    }
    const buf = this.ctx.createBuffer(1, len, sr);
    const out = buf.getChannelData(0);
    for (let i = 0; i < len; i++) out[i] = raw[i];
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      out[i] = raw[i] * Math.sqrt(t) + raw[len + i] * Math.sqrt(1 - t);
    }
    return buf;
  }

  /** Stereo reverb impulse: decaying noise that darkens as it rings out. */
  _makeImpulse(seconds) {
    const sr = this.ctx.sampleRate;
    const len = Math.floor(sr * seconds);
    const buf = this.ctx.createBuffer(2, len, sr);
    const pre = Math.floor(sr * 0.012);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      for (let i = pre; i < len; i++) {
        const t = (i - pre) / (len - pre);
        const env = Math.pow(1 - t, 2.6) * Math.exp(-t * 2.2);
        // One-pole low-pass whose coefficient rises over time: highs die first.
        const coef = 0.25 + 0.68 * t;
        lp = lp * coef + (Math.random() * 2 - 1) * (1 - coef);
        d[i] = lp * env;
      }
      // A few discrete early reflections give the tail some shape.
      for (let r = 0; r < 6; r++) {
        const idx = pre + Math.floor(sr * (0.007 + Math.random() * 0.06));
        d[idx] += (Math.random() < 0.5 ? -1 : 1) * (0.5 - r * 0.06);
      }
    }
    return buf;
  }

  // ---------------------------------------------------------------------------
  //  Music bus
  // ---------------------------------------------------------------------------
  _buildMusicBus(impulse) {
    const ctx = this.ctx;
    // Final level + "radio" filter (muffled on pause, band-limited on foot).
    this.musicGain = this._gain(0, this.preMaster);
    this.musicLP = this._filter('lowpass', 6000, 0.5, this.musicGain);

    // Glue compressor for the whole track.
    this.musicComp = ctx.createDynamicsCompressor();
    this.musicComp.threshold.value = -20;
    this.musicComp.knee.value = 12;
    this.musicComp.ratio.value = 3.5;
    this.musicComp.attack.value = 0.012;
    this.musicComp.release.value = 0.22;
    this.musicComp.connect(this.musicLP);
    this.musicMix = this._gain(1.25, this.musicComp);

    // Instrument buses. Pads and bass pass through a "sidechain" gain that the
    // kick drum pumps, the classic synthwave breathing effect.
    this.sidechain = this._gain(1, this.musicMix);
    this.padBus = this._gain(1, this.sidechain);
    this.bassBus = this._gain(0.5, this.sidechain);
    this.arpBus = this._gain(0.9, this.musicMix);
    this.leadBus = this._gain(0.7, this.musicMix);
    this.drumBus = this._gain(0.4, this.musicMix);

    // Dotted-eighth feedback delay with a darkening filter in the loop.
    this.delayIn = this._gain(1);
    const delay = ctx.createDelay(1.5);
    delay.delayTime.value = STEP * 3;
    const fbLP = this._filter('lowpass', 2600, 0.5);
    const fbHP = this._filter('highpass', 300, 0.5);
    const fb = this._gain(0.38);
    this.delayIn.connect(delay);
    delay.connect(fbLP);
    fbLP.connect(fbHP);
    fbHP.connect(fb);
    fb.connect(delay);
    fbHP.connect(this._gain(0.5, this.musicMix));

    // Music reverb (returns into the mix so the pause filter affects it too).
    this.musicRevIn = ctx.createConvolver();
    this.musicRevIn.buffer = impulse;
    this.musicRevIn.connect(this._gain(0.55, this.musicMix));
    fbHP.connect(this._gain(0.25, this.musicRevIn));

    this._applyMusicLevel();
  }

  /** Sets music level/filter from the enabled flag, pause and drive state. */
  _applyMusicLevel() {
    if (!this.ctx) return;
    const f = this._full;
    let level = 0;
    let cutoff = lerp(4200, 17000, f);
    if (this._musicOn) level = lerp(0.42, 0.78, f);
    if (this._paused) {
      level *= 0.42;
      cutoff = 900;
    }
    this._set(this.musicGain.gain, level, 0.3);
    this._set(this.musicLP.frequency, cutoff, 0.25);
    // On foot the rhythm section sits back; in the car the radio is full range.
    this._set(this.drumBus.gain, lerp(0.4, 1, f), 0.4);
    this._set(this.bassBus.gain, lerp(0.5, 1, f), 0.4);
    this._set(this.leadBus.gain, lerp(0.7, 1, f), 0.4);
  }

  // ---------------------------------------------------------------------------
  //  Car engine
  // ---------------------------------------------------------------------------
  _buildEngine() {
    const ctx = this.ctx;
    const e = (this.eng = {});
    e.out = this._gain(0, this.worldBus);

    // Tone shaping after the distortion: body resonances of an exhaust system.
    const body2 = this._filter('peaking', 430, 1.2, e.out);
    body2.gain.value = 4;
    const body1 = this._filter('peaking', 115, 1, body2);
    body1.gain.value = 5;
    e.lp = this._filter('lowpass', 400, 1.3, body1);

    // Half-order amplitude modulation = the uneven "lope" of a cammy engine.
    const amGain = this._gain(1, e.lp);
    e.amDepth = this._gain(0.3, amGain.gain);
    e.am = this._osc('sine', 20, e.amDepth);

    // Waveshaper: asymmetric tanh adds even harmonics like real combustion.
    const shaper = ctx.createWaveShaper();
    const N = 2048;
    const curve = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * 2 - 1;
      curve[i] = Math.tanh(2.6 * x + 0.25) - Math.tanh(0.25);
    }
    shaper.curve = curve;
    shaper.oversample = '2x';
    const dcBlock = this._filter('highpass', 22, 0.5, amGain);
    shaper.connect(dcBlock);
    e.drive = this._gain(0.6, shaper);

    // Oscillator stack: fundamental pair (detuned), sub, octave and a fifth.
    e.o1 = this._osc('sawtooth', 40, this._gain(0.4, e.drive), -7);
    e.o2 = this._osc('sawtooth', 40, this._gain(0.34, e.drive), 9);
    e.o3 = this._osc('square', 20, this._gain(0.3, e.drive));
    e.o4 = this._osc('sawtooth', 80, this._gain(0.14, e.drive), 5);
    e.o5 = this._osc('triangle', 60, this._gain(0.16, e.drive), -4);

    // Slow random pitch jitter so idle never sounds like a test tone.
    e.jitter = this._gain(20);
    const jLP = this._filter('lowpass', 9, 0.5, e.jitter);
    this._loop('white', jLP, 0.5);
    for (const o of [e.o1, e.o2, e.o3, e.o4, e.o5]) e.jitter.connect(o.detune);

    // Intake/exhaust rasp (band-passed noise, driven by load) and low rumble.
    e.raspGain = this._gain(0.02, amGain);
    e.rasp = this._filter('bandpass', 500, 0.9, e.raspGain);
    this._loop('white', e.rasp);
    e.rumbleGain = this._gain(0.4, amGain);
    this._loop('brown', this._filter('lowpass', 130, 0.7, e.rumbleGain));

    // ---- nitro jet --------------------------------------------------------------
    const j = (this.jet = {});
    j.gain = this._gain(0, this.worldBus);
    j.bp = this._filter('bandpass', 900, 0.6, j.gain);
    this._loop('white', j.bp);
    this._loop('pink', this._filter('lowpass', 420, 0.7, this._gain(1.6, j.gain)));
    j.whine = this._osc('sawtooth', 600, this._filter('lowpass', 1800, 2, this._gain(0.05, j.gain)));
    // Flutter on the jet so it roars rather than hisses.
    const flutter = this._gain(0.25, j.gain.gain);
    this._loop('brown', this._filter('lowpass', 18, 0.5, flutter), 0.7);
  }

  // ---------------------------------------------------------------------------
  //  Tyres, wind and road
  // ---------------------------------------------------------------------------
  _buildRoadLayers() {
    // Skid: two narrow resonances over noise = rubber squeal, plus a low scrub.
    const s = (this.skid = {});
    s.gain = this._gain(0, this.worldBus);
    s.bp1 = this._filter('bandpass', 1100, 9, this._gain(1.6, s.gain));
    s.bp2 = this._filter('bandpass', 1800, 12, this._gain(1.2, s.gain));
    const src = this._loop('white', null);
    src.connect(s.bp1);
    src.connect(s.bp2);
    src.connect(this._filter('bandpass', 380, 1, this._gain(0.35, s.gain)));
    // Wobble the resonances a little: squeal is never perfectly steady.
    const wob = this._osc('sine', 6.3, null);
    const wobDepth = this._gain(55);
    wob.connect(wobDepth);
    wobDepth.connect(s.bp1.frequency);
    wobDepth.connect(s.bp2.frequency);

    // Wind.
    const w = (this.wind = {});
    w.gain = this._gain(0, this.worldBus);
    w.bp = this._filter('bandpass', 400, 0.55, w.gain);
    this._loop('pink', w.bp);
    // Gusting.
    const gust = this._gain(0.3, w.gain.gain);
    this._loop('brown', this._filter('lowpass', 1.2, 0.5, gust), 0.3);
    gust.gain.value = 0; // scaled below via the wind gain itself (kept subtle)
    gust.gain.value = 0.02;

    // Road rumble.
    const r = (this.road = {});
    r.gain = this._gain(0, this.worldBus);
    r.lp = this._filter('lowpass', 120, 0.8, r.gain);
    this._loop('brown', r.lp);
  }

  // ---------------------------------------------------------------------------
  //  Ambience
  // ---------------------------------------------------------------------------
  _buildAmbience() {
    const ctx = this.ctx;
    const a = (this.amb = {});
    const pan = (v, dest) => {
      if (!ctx.createStereoPanner) return dest;
      const p = ctx.createStereoPanner();
      p.pan.value = v;
      p.connect(dest);
      return p;
    };

    // ---- city hum: distant traffic wash with a slow swell --------------------
    a.city = this._gain(0, this.worldBus);
    this._loop('brown', this._filter('lowpass', 190, 0.6, this._gain(0.9, a.city)));
    const traffic = this._gain(0.22, a.city);
    this._loop('pink', this._filter('bandpass', 650, 0.4, traffic));
    this._osc('sine', 0.05, this._gain(0.12, traffic.gain));
    this._osc('sine', 0.083, this._gain(0.07, traffic.gain));
    // A whisper of electrical hum from the neon.
    this._osc('sine', 60, this._gain(0.035, a.city));
    this._osc('sine', 120.4, this._gain(0.012, a.city));

    // ---- crickets: gated, pulsed high sines ------------------------------------
    a.crickets = this._gain(0, this.worldBus);
    const cricket = (freq, pulse, gateRate, panV, level) => {
      const out = this._gain(level, pan(panV, a.crickets));
      const gate = this._gain(0.5, out); // 0..1 chirp on/off
      const trem = this._gain(0.5, gate); // 0..1 fast pulse
      this._osc('sine', freq, trem);
      this._osc('sine', freq * 1.493, this._gain(0.25, trem));
      this._osc('sine', pulse, this._gain(0.5, trem.gain));
      // Square LFO, low-passed to remove clicks, opens and closes the gate.
      const sm = this._filter('lowpass', 14, 0.5, this._gain(0.5, gate.gain));
      this._osc('square', gateRate, sm);
    };
    cricket(4350, 31, 1.7, -0.6, 1);
    cricket(4820, 27, 2.3, 0.55, 0.8);
    cricket(3900, 36, 0.9, 0.1, 0.5);

    // ---- night drone: soft low fifth with a slow breath --------------------------
    a.drone = this._gain(0, this.worldBus);
    const droneLP = this._filter('lowpass', 320, 0.5, a.drone);
    const breath = this._gain(0.6, droneLP);
    this._osc('sine', 0.07, this._gain(0.3, breath.gain));
    this._osc('sine', 55, this._gain(0.5, breath));
    this._osc('sine', 55.35, this._gain(0.4, breath));
    this._osc('triangle', 82.5, this._gain(0.22, breath));
    this._osc('sine', 164.6, this._gain(0.06, breath));
    this._loop('pink', this._filter('highpass', 3500, 0.5, this._gain(0.05, a.drone)));

    // ---- ocean surf: two overlapping wave cycles ----------------------------------
    a.surf = this._gain(0, this.worldBus);
    const wave = (color, type, freq, lfoRate, freqDepth, panV, level) => {
      const g = this._gain(0.55, pan(panV, this._gain(level, a.surf)));
      const f = this._filter(type, freq, 0.5, g);
      this._loop(color, f);
      const lfo = this._osc('sine', lfoRate, null);
      lfo.connect(this._gain(0.42, g.gain));
      lfo.connect(this._gain(freqDepth, f.frequency));
    };
    wave('pink', 'lowpass', 620, 0.11, 380, -0.3, 1.5);
    wave('pink', 'lowpass', 480, 0.073, 260, 0.35, 1.2);
    wave('white', 'bandpass', 2600, 0.11, 900, 0.1, 0.16); // foam hiss
  }

  // ===========================================================================
  //  Low-level voice helpers
  // ===========================================================================

  /** setTargetAtTime wrapper that skips redundant calls. */
  _set(param, value, tc) {
    const prev = this._targets.get(param);
    if (prev !== undefined && Math.abs(prev - value) <= 1e-4 * (1 + Math.abs(value))) return;
    this._targets.set(param, value);
    param.setTargetAtTime(value, this.ctx.currentTime, tc);
  }

  /** When `src` ends, disconnect every node of the voice so it can be GC'd. */
  _dispose(src, nodes) {
    this._voices++;
    src.onended = () => {
      this._voices--;
      src.onended = null;
      for (let i = 0; i < nodes.length; i++) {
        try {
          nodes[i].disconnect();
        } catch (err) {
          /* already disconnected */
        }
      }
    };
  }

  /**
   * Connects the tail of a voice to its destination, with optional pan, reverb
   * send and delay send. Every node it creates is pushed onto `nodes`.
   */
  _route(node, o, nodes) {
    const ctx = this.ctx;
    let last = node;
    if (o.pan && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(o.pan, -1, 1);
      last.connect(p);
      nodes.push(p);
      last = p;
    }
    last.connect(o.dest || this.sfxBus);
    if (o.rev) {
      const s = this._gain(o.rev, o.revTo || this.fxReverbIn);
      last.connect(s);
      nodes.push(s);
    }
    if (o.delay) {
      const s = this._gain(o.delay, this.delayIn);
      last.connect(s);
      nodes.push(s);
    }
  }

  /** Attack / hold / exponential-decay envelope ending in silence at t+dur. */
  _envelope(g, t, dur, attack, hold, vol) {
    attack = Math.min(attack, dur * 0.5);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    if (hold > 0) g.gain.setValueAtTime(vol, t + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.01);
  }

  _voiceFilter(spec, t, dur) {
    const f = this._filter(spec.type || 'lowpass', spec.freq, spec.q);
    if (spec.to) {
      f.frequency.setValueAtTime(spec.freq, t);
      f.frequency.exponentialRampToValueAtTime(spec.to, t + (spec.time || dur));
    }
    return f;
  }

  /**
   * One oscillator voice.
   *   o = { t, freq, sweep:[[freq, atSeconds]...], type, dur, attack, hold, vol,
   *         detune, filter:{type,freq,to,q,time}, vib:{rate,depth,delay},
   *         pan, dest, rev, revTo, delay }
   */
  _tone(o) {
    const ctx = this.ctx;
    const vol = o.vol === undefined ? 0.2 : o.vol;
    if (vol <= 0.0002) return;
    const t = o.t;
    const dur = o.dur || 0.2;
    const nodes = [];
    const osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.freq, t);
    if (o.sweep) {
      for (let i = 0; i < o.sweep.length; i++) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.sweep[i][0]), t + o.sweep[i][1]);
      }
    }
    if (o.detune) osc.detune.value = o.detune;
    nodes.push(osc);

    let vib = null;
    if (o.vib) {
      vib = ctx.createOscillator();
      vib.frequency.value = o.vib.rate;
      const vg = ctx.createGain();
      const d0 = t + (o.vib.delay || 0);
      vg.gain.setValueAtTime(0, t);
      vg.gain.setValueAtTime(0, d0);
      vg.gain.linearRampToValueAtTime(o.vib.depth, d0 + 0.12);
      vib.connect(vg);
      vg.connect(osc.frequency);
      vib.start(t);
      vib.stop(t + dur + 0.05);
      nodes.push(vib, vg);
    }

    let last = osc;
    if (o.filter) {
      const f = this._voiceFilter(o.filter, t, dur);
      last.connect(f);
      nodes.push(f);
      last = f;
    }
    const g = ctx.createGain();
    this._envelope(g, t, dur, o.attack === undefined ? 0.005 : o.attack, o.hold || 0, vol);
    last.connect(g);
    nodes.push(g);
    this._route(g, o, nodes);
    osc.start(t);
    osc.stop(t + dur + 0.05);
    this._dispose(osc, nodes);
  }

  /**
   * One filtered-noise voice.
   *   o = { t, color, rate, dur, attack, hold, vol, filter, pan, dest, rev, revTo }
   */
  _noise(o) {
    const ctx = this.ctx;
    const vol = o.vol === undefined ? 0.2 : o.vol;
    if (vol <= 0.0002) return;
    const t = o.t;
    const dur = o.dur || 0.2;
    const nodes = [];
    const src = ctx.createBufferSource();
    src.buffer = this.noise[o.color || 'white'];
    src.loop = true;
    if (o.rate) src.playbackRate.value = o.rate;
    nodes.push(src);
    let last = src;
    if (o.filter) {
      const f = this._voiceFilter(o.filter, t, dur);
      last.connect(f);
      nodes.push(f);
      last = f;
    }
    const g = ctx.createGain();
    this._envelope(g, t, dur, o.attack === undefined ? 0.003 : o.attack, o.hold || 0, vol);
    last.connect(g);
    nodes.push(g);
    this._route(g, o, nodes);
    src.start(t, Math.random() * (src.buffer.duration - 0.2));
    src.stop(t + dur + 0.05);
    this._dispose(src, nodes);
  }

  // ---- reusable instrument patches (shared by jingles and the soundtrack) ----

  /** Glassy FM-ish bell: fundamental plus two inharmonic partials. */
  _bell(t, freq, dur, vol, x = {}) {
    this._tone({ ...x, t, freq, dur, vol, attack: 0.002 });
    this._tone({ ...x, t, freq: freq * 2.76, dur: dur * 0.55, vol: vol * 0.32, attack: 0.002 });
    this._tone({ ...x, t, freq: freq * 5.4, dur: dur * 0.25, vol: vol * 0.14, attack: 0.002 });
  }

  /** Detuned saw "brass" stab with a swelling filter. */
  _brass(t, freq, dur, vol, x = {}) {
    const top = Math.min(9000, freq * 7);
    for (const det of [-9, 9]) {
      this._tone({
        ...x, t, freq, dur, vol: vol * 0.5, type: 'sawtooth', detune: det,
        attack: 0.018, hold: dur * 0.55,
        filter: { freq: Math.min(top, freq * 2), to: top, q: 1.2, time: 0.07 },
        pan: (x.pan || 0) + det / 30,
      });
    }
  }

  /** Short filtered pluck. */
  _pluck(t, freq, dur, vol, x = {}) {
    this._tone({
      ...x, t, freq, dur, vol, type: x.type || 'sawtooth', attack: 0.003,
      filter: { freq: Math.min(9000, freq * 7), to: Math.max(300, freq * 1.2), q: 3, time: dur * 0.7 },
    });
  }

  // ===========================================================================
  //  Continuous-layer one-shots (footsteps, birds)
  // ===========================================================================

  _footstep(intensity) {
    const t = this.ctx.currentTime + 0.005;
    this._stepSide = -this._stepSide;
    const side = this._stepSide;
    const v = 0.55 + 0.45 * intensity;
    const tone = rand(0.9, 1.1) * (side > 0 ? 1.05 : 0.96);
    const dest = this.worldBus;
    // Heel thud, sole slap and a little grit.
    this._tone({ t, freq: 105 * tone, sweep: [[52, 0.07]], dur: 0.09, vol: 0.13 * v, dest, pan: side * 0.12 });
    this._noise({
      t, color: 'pink', dur: 0.085, vol: 0.2 * v, dest, pan: side * 0.12,
      filter: { freq: 1100 * tone, to: 320, q: 0.8 },
    });
    this._noise({
      t: t + 0.012, dur: 0.05, vol: 0.022 * v, dest, pan: side * 0.15,
      filter: { type: 'bandpass', freq: 2400 * tone, q: 1.2 },
    });
  }

  /** A little phrase of 2-6 chirps from one "bird" somewhere in the stereo field. */
  _birdPhrase(level) {
    let t = this.ctx.currentTime + 0.02;
    const pan = rand(-0.85, 0.85);
    const base = rand(2300, 4600);
    const count = 2 + ((Math.random() * 5) | 0);
    const up = Math.random() < 0.5;
    const vol = rand(0.012, 0.028) * level;
    const style = Math.random();
    for (let i = 0; i < count; i++) {
      const f = base * rand(0.92, 1.1);
      const d = rand(0.05, 0.11);
      const sweep = style < 0.6
        ? [[f * (up ? 1.35 : 0.72), d]]
        : [[f * 1.3, d * 0.5], [f * 0.85, d]]; // warble
      this._tone({
        t, freq: f, sweep, dur: d + 0.02, attack: 0.012, vol,
        dest: this.worldBus, pan, rev: 0.6,
      });
      t += d + rand(0.03, 0.12);
    }
  }

  // ===========================================================================
  //  One-shot sound effects
  // ===========================================================================

  _buildSfxTable() {
    return {
      // Sparkly shard: quick rising bell arpeggio with shimmer.
      coin(t, v, p) {
        const notes = [1318.5, 1975.5, 2637];
        notes.forEach((f, i) => {
          this._bell(t + i * 0.045, f * p, 0.38 - i * 0.05, 0.11 * v, { rev: 0.35, pan: (i - 1) * 0.25 });
        });
        this._tone({ t, freq: 988 * p, dur: 0.09, vol: 0.09 * v, type: 'triangle' });
        this._noise({ t, dur: 0.12, vol: 0.03 * v, filter: { type: 'highpass', freq: 7500 }, rev: 0.3 });
      },

      // Item pickup: bouncy upward blip.
      pickup(t, v, p) {
        this._tone({ t, freq: 392 * p, sweep: [[784 * p, 0.1]], dur: 0.16, vol: 0.14 * v, type: 'triangle' });
        this._tone({ t: t + 0.07, freq: 1175 * p, dur: 0.22, vol: 0.09 * v, rev: 0.25 });
        this._tone({ t, freq: 196 * p, sweep: [[392 * p, 0.1]], dur: 0.12, vol: 0.06 * v, type: 'square', filter: { freq: 1800 } });
      },

      // Register: mechanical clunk, then "ka-ching" bells and coin rattle.
      cash(t, v, p) {
        this._noise({ t, dur: 0.05, vol: 0.14 * v, filter: { type: 'bandpass', freq: 1800, q: 1.5 } });
        this._tone({ t, freq: 160, sweep: [[80, 0.06]], dur: 0.08, vol: 0.12 * v });
        this._bell(t + 0.07, 1568 * p, 0.55, 0.12 * v, { rev: 0.3, pan: -0.15 });
        this._bell(t + 0.15, 2093 * p, 0.7, 0.13 * v, { rev: 0.35, pan: 0.15 });
        for (let i = 0; i < 5; i++) {
          this._tone({
            t: t + 0.1 + i * 0.035 + Math.random() * 0.02, freq: rand(3200, 5200) * p,
            dur: 0.07, vol: 0.03 * v, pan: rand(-0.4, 0.4),
          });
        }
      },

      jump(t, v, p) {
        this._tone({ t, freq: 210 * p, sweep: [[520 * p, 0.15]], dur: 0.2, vol: 0.13 * v, type: 'triangle', attack: 0.01 });
        this._noise({ t, dur: 0.16, attack: 0.03, vol: 0.05 * v, filter: { type: 'bandpass', freq: 700, to: 2200, q: 1 } });
      },

      land(t, v, p) {
        this._tone({ t, freq: 120 * p, sweep: [[46, 0.11]], dur: 0.17, vol: 0.26 * v });
        this._noise({ t, color: 'pink', dur: 0.14, vol: 0.26 * v, filter: { freq: 900, to: 200, q: 0.7 } });
        this._noise({ t: t + 0.01, dur: 0.07, vol: 0.03 * v, filter: { type: 'bandpass', freq: 2600, q: 1 } });
      },

      // Car door: handle click, then the heavy shut with a latch.
      enter(t, v, p) {
        this._noise({ t, dur: 0.03, vol: 0.09 * v, filter: { type: 'bandpass', freq: 3200, q: 2 } });
        const s = t + 0.13;
        this._tone({ t: s, freq: 150 * p, sweep: [[58, 0.09]], dur: 0.16, vol: 0.3 * v });
        this._noise({ t: s, color: 'pink', dur: 0.1, vol: 0.24 * v, filter: { freq: 1400, to: 250, q: 0.8 } });
        this._noise({ t: s + 0.015, dur: 0.035, vol: 0.08 * v, filter: { type: 'bandpass', freq: 2300, q: 3 } });
        this._tone({ t: s, freq: 410, dur: 0.07, vol: 0.03 * v, type: 'square', filter: { type: 'bandpass', freq: 800, q: 4 } });
      },

      // Getting out: latch release, creak, lighter shut.
      exit(t, v, p) {
        this._noise({ t, dur: 0.035, vol: 0.1 * v, filter: { type: 'bandpass', freq: 2600, q: 2.5 } });
        this._tone({ t: t + 0.01, freq: 320 * p, sweep: [[240 * p, 0.05]], dur: 0.06, vol: 0.04 * v, type: 'square', filter: { freq: 1200 } });
        const s = t + 0.2;
        this._tone({ t: s, freq: 170 * p, sweep: [[70, 0.08]], dur: 0.13, vol: 0.22 * v });
        this._noise({ t: s, color: 'pink', dur: 0.08, vol: 0.2 * v, filter: { freq: 1700, to: 300, q: 0.8 } });
        this._noise({ t: s + 0.012, dur: 0.03, vol: 0.06 * v, filter: { type: 'bandpass', freq: 2900, q: 3 } });
      },

      // Impact scaled by intensity: body thud, bending metal, crunch, glass.
      crash(t, v) {
        const i = clamp(v, 0, 1);
        const g = 0.3 + 0.7 * i;
        this._tone({ t, freq: 95 + 30 * i, sweep: [[34, 0.16]], dur: 0.22 + 0.25 * i, vol: 0.5 * g });
        this._noise({ t, color: 'brown', dur: 0.2 + 0.2 * i, vol: 0.5 * g, filter: { freq: 500, to: 90, q: 0.7 } });
        this._noise({
          t, color: 'pink', dur: 0.16 + 0.3 * i, vol: 0.34 * g, rev: 0.2 * i,
          filter: { type: 'bandpass', freq: 1500 + 900 * i, to: 500, q: 0.7 },
        });
        // Inharmonic clang of panels.
        const partials = [233, 311, 487, 733, 1129, 1571];
        const n = 2 + Math.round(4 * i);
        for (let k = 0; k < n; k++) {
          const f = partials[k] * rand(0.9, 1.12);
          this._tone({
            t: t + Math.random() * 0.015, freq: f, sweep: [[f * 0.93, 0.3]], type: 'square',
            dur: 0.12 + 0.35 * i * Math.random() + 0.08, vol: 0.06 * g,
            filter: { type: 'bandpass', freq: f * 2.1, q: 5 }, pan: rand(-0.5, 0.5), rev: 0.25,
          });
        }
        // Glass only on proper hits.
        if (i > 0.45) {
          const amt = (i - 0.45) / 0.55;
          this._noise({ t: t + 0.02, dur: 0.25 + 0.2 * amt, vol: 0.12 * amt + 0.03, filter: { type: 'highpass', freq: 5200 }, rev: 0.3 });
          const shards = 4 + Math.round(8 * amt);
          for (let k = 0; k < shards; k++) {
            this._tone({
              t: t + 0.03 + Math.random() * (0.25 + 0.4 * amt), freq: rand(2800, 7200),
              dur: rand(0.04, 0.12), vol: 0.035 * (0.5 + amt), pan: rand(-0.7, 0.7), rev: 0.3,
            });
          }
        }
      },

      // Two-tone car horn.
      horn(t, v, p) {
        for (const [f, pan] of [[349.2, -0.15], [440, 0.15]]) {
          this._tone({
            t, freq: f * p, type: 'sawtooth', dur: 0.48, attack: 0.012, hold: 0.36, vol: 0.085 * v, pan,
            filter: { freq: 2400, q: 1.5 }, rev: 0.15,
          });
          this._tone({
            t, freq: f * p * 2.005, type: 'square', dur: 0.48, attack: 0.012, hold: 0.36, vol: 0.02 * v, pan,
            filter: { freq: 3000 },
          });
        }
      },

      // Nitro ignition: pressure pop, rising whoosh, hiss tail.
      nitro(t, v) {
        this._tone({ t, freq: 70, sweep: [[260, 0.35]], dur: 0.5, attack: 0.02, vol: 0.2 * v });
        this._noise({
          t, dur: 0.75, attack: 0.08, hold: 0.15, vol: 0.26 * v, rev: 0.25,
          filter: { type: 'bandpass', freq: 260, to: 4200, q: 1.1, time: 0.45 },
        });
        this._noise({ t: t + 0.2, dur: 0.7, attack: 0.1, vol: 0.06 * v, filter: { type: 'highpass', freq: 6000 } });
        this._noise({ t, dur: 0.04, vol: 0.14 * v, filter: { freq: 2000 } });
      },

      splash(t, v, p) {
        this._tone({ t, freq: 150 * p, sweep: [[50, 0.14]], dur: 0.22, vol: 0.24 * v });
        this._noise({ t, color: 'pink', dur: 0.2, vol: 0.3 * v, filter: { freq: 700, to: 180, q: 0.7 } });
        this._noise({
          t: t + 0.02, dur: 0.75, attack: 0.03, vol: 0.2 * v, rev: 0.3,
          filter: { type: 'bandpass', freq: 3200, to: 700, q: 0.6, time: 0.6 },
        });
        this._noise({ t: t + 0.05, dur: 0.5, attack: 0.05, vol: 0.05 * v, filter: { type: 'highpass', freq: 5000 } });
        // Droplets and bubbles.
        for (let k = 0; k < 7; k++) {
          const f = rand(380, 1100) * p;
          this._tone({
            t: t + 0.12 + Math.random() * 0.55, freq: f, sweep: [[f * 1.9, 0.05]],
            dur: 0.07, vol: 0.05 * v, pan: rand(-0.6, 0.6),
          });
        }
      },

      // Radio-call style rising stab.
      missionStart(t, v, p) {
        const s = 0.11;
        [64, 69, 76].forEach((m, i) => {
          this._pluck(t + i * s, mtof(m) * p, 0.3, 0.12 * v, { rev: 0.3, pan: (i - 1) * 0.2 });
        });
        this._brass(t + 3 * s, mtof(81) * p, 0.6, 0.13 * v, { rev: 0.4 });
        this._brass(t + 3 * s, mtof(76) * p, 0.6, 0.09 * v, { rev: 0.3 });
        this._tone({ t: t + 3 * s, freq: mtof(45) * p, type: 'sawtooth', dur: 0.6, hold: 0.3, vol: 0.12 * v, filter: { freq: 700, to: 250 } });
        this._noise({ t, dur: 0.33, attack: 0.3, vol: 0.05 * v, filter: { type: 'highpass', freq: 4000 } });
      },

      // Triumphant: run up the C major arpeggio into a big held chord.
      missionComplete(t, v, p) {
        const s = 0.1;
        [72, 76, 79, 84].forEach((m, i) => {
          this._brass(t + i * s, mtof(m) * p, 0.22, 0.13 * v, { rev: 0.25 });
        });
        const c = t + 4 * s;
        [72, 76, 79, 86, 88].forEach((m, i) => {
          this._brass(c, mtof(m) * p, 1.2, 0.075 * v, { rev: 0.45, pan: (i - 2) * 0.18 });
        });
        this._bell(c, mtof(96) * p, 1.1, 0.07 * v, { rev: 0.5 });
        this._bell(c + 0.12, mtof(100) * p, 0.9, 0.05 * v, { rev: 0.5, pan: 0.3 });
        this._tone({ t: c, freq: mtof(36) * p, type: 'sawtooth', dur: 1.2, hold: 0.6, vol: 0.16 * v, filter: { freq: 900, to: 220, time: 0.8 } });
        this._tone({ t: c, freq: mtof(48) * p, dur: 1.1, hold: 0.5, vol: 0.12 * v });
        this._noise({ t: c, dur: 1.2, vol: 0.06 * v, filter: { type: 'highpass', freq: 6000 }, rev: 0.4 });
      },

      // Deflating chromatic slump.
      missionFail(t, v, p) {
        const s = 0.2;
        [64, 63, 62].forEach((m, i) => {
          for (const det of [-12, 12]) {
            this._tone({
              t: t + i * s, freq: mtof(m) * p, type: 'sawtooth', detune: det, dur: 0.24, hold: 0.1,
              vol: 0.07 * v, filter: { freq: 2200, to: 700, q: 2 }, rev: 0.25,
            });
          }
        });
        const e = t + 3 * s;
        for (const det of [-14, 14]) {
          this._tone({
            t: e, freq: mtof(57) * p, sweep: [[mtof(57) * p, 0.25], [mtof(52) * p, 0.9]], type: 'sawtooth',
            detune: det, dur: 1, hold: 0.4, vol: 0.085 * v, filter: { freq: 1800, to: 300, q: 3, time: 0.9 },
            vib: { rate: 5, depth: 3, delay: 0.2 }, rev: 0.35,
          });
        }
        this._tone({ t: e, freq: mtof(33) * p, sweep: [[mtof(33) * p, 0.3], [mtof(28) * p, 0.9]], type: 'triangle', dur: 1, hold: 0.4, vol: 0.18 * v });
      },

      // Big fanfare: dotted pick-up, IV - V - I chords, glitter on top.
      rankUp(t, v, p) {
        const b = 0.13;
        // Pick-up figure.
        [[67, 0, 1.5], [67, 1.5, 0.5], [72, 2, 1], [76, 3, 1], [79, 4, 2]].forEach(([m, at, len]) => {
          this._brass(t + at * b, mtof(m) * p, len * b + 0.12, 0.13 * v, { rev: 0.3 });
          this._brass(t + at * b, mtof(m - 12) * p, len * b + 0.12, 0.07 * v, { rev: 0.2 });
        });
        // Chord hits: F, G, then a long C.
        const chords = [
          [6, [65, 69, 72, 77], 41, 0.3],
          [8.5, [67, 71, 74, 79], 43, 0.3],
          [11, [72, 76, 79, 84, 88], 36, 1.6],
        ];
        for (const [at, notes, bass, dur] of chords) {
          const ct = t + at * b;
          notes.forEach((m, i) => {
            this._brass(ct, mtof(m) * p, dur, 0.075 * v, { rev: 0.45, pan: (i - 2) * 0.17 });
          });
          this._tone({ t: ct, freq: mtof(bass) * p, type: 'sawtooth', dur: dur + 0.05, hold: dur * 0.5, vol: 0.17 * v, filter: { freq: 1000, to: 240, time: dur * 0.8 } });
          this._tone({ t: ct, freq: mtof(bass + 12) * p, dur, hold: dur * 0.4, vol: 0.1 * v });
          this._tone({ t: ct, freq: 130, sweep: [[45, 0.1]], dur: 0.25, vol: 0.3 * v });
          this._noise({ t: ct, dur: 0.14, vol: 0.1 * v, filter: { type: 'bandpass', freq: 2000, q: 0.7 }, rev: 0.3 });
        }
        // Cymbal swell into the final chord, then the crash.
        const fin = t + 11 * b;
        this._noise({ t: fin - 0.5, dur: 0.52, attack: 0.48, vol: 0.07 * v, filter: { type: 'highpass', freq: 5000 } });
        this._noise({ t: fin, dur: 1.8, vol: 0.1 * v, filter: { type: 'highpass', freq: 4500 }, rev: 0.5 });
        // Glitter.
        [84, 88, 91, 96, 100, 103, 108].forEach((m, i) => {
          this._bell(fin + 0.1 + i * 0.07, mtof(m) * p, 0.7, 0.05 * v, { rev: 0.5, pan: Math.sin(i * 1.7) * 0.6 });
        });
      },

      ui(t, v, p) {
        this._tone({ t, freq: 880 * p, sweep: [[1320 * p, 0.03]], dur: 0.06, vol: 0.09 * v });
        this._noise({ t, dur: 0.015, vol: 0.04 * v, filter: { type: 'highpass', freq: 3000 } });
      },

      uiBack(t, v, p) {
        this._tone({ t, freq: 620 * p, sweep: [[390 * p, 0.07]], dur: 0.1, vol: 0.09 * v, type: 'triangle' });
        this._noise({ t, dur: 0.015, vol: 0.03 * v, filter: { type: 'highpass', freq: 2500 } });
      },

      // Purchase confirmed: two rising notes and a little ching.
      buy(t, v, p) {
        this._pluck(t, 659.3 * p, 0.18, 0.11 * v, { type: 'square' });
        this._pluck(t + 0.09, 987.8 * p, 0.3, 0.11 * v, { type: 'square', rev: 0.25 });
        this._bell(t + 0.09, 1975.5 * p, 0.6, 0.09 * v, { rev: 0.35 });
        this._bell(t + 0.17, 2637 * p, 0.5, 0.06 * v, { rev: 0.35, pan: 0.25 });
      },

      // Nope: two flat buzzes.
      deny(t, v, p) {
        for (const at of [0, 0.13]) {
          this._tone({
            t: t + at, freq: 146 * p, type: 'sawtooth', dur: 0.11, hold: 0.07, attack: 0.004,
            vol: 0.13 * v, filter: { freq: 1100, q: 2 },
          });
          this._tone({
            t: t + at, freq: 155 * p, type: 'square', dur: 0.11, hold: 0.07, attack: 0.004,
            vol: 0.06 * v, filter: { freq: 900 },
          });
        }
      },

      // Timer warning: woodblock-ish tick.
      tick(t, v, p) {
        this._tone({ t, freq: 1050 * p, dur: 0.05, vol: 0.14 * v, attack: 0.001 });
        this._tone({ t, freq: 2100 * p, dur: 0.025, vol: 0.06 * v, attack: 0.001, type: 'triangle' });
        this._noise({ t, dur: 0.012, vol: 0.05 * v, filter: { type: 'bandpass', freq: 3500, q: 1 } });
      },

      // Cartoon pedestrian yelp: sawtooth "vocal cords" through moving formants.
      npcYell(t, v, p) {
        const ctx = this.ctx;
        const dur = rand(0.24, 0.36);
        const base = 235 * p * rand(0.9, 1.15);
        const nodes = [];
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(base, t);
        osc.frequency.exponentialRampToValueAtTime(base * rand(1.5, 1.9), t + dur * 0.3);
        osc.frequency.exponentialRampToValueAtTime(base * rand(0.7, 0.95), t + dur);
        // Nervous vibrato.
        const vib = ctx.createOscillator();
        vib.frequency.value = rand(18, 26);
        const vg = this._gain(base * 0.035, osc.frequency);
        vib.connect(vg);
        const out = ctx.createGain();
        this._envelope(out, t, dur, 0.015, dur * 0.45, 0.3 * v);
        // Two vowel shapes: "hey!" (e -> i) or "whoa!" (a -> o).
        const hey = Math.random() < 0.5;
        const f1 = hey ? [560, 340] : [820, 430];
        const f2 = hey ? [1850, 2350] : [1250, 820];
        const f3 = [2700, 2900];
        const k = Math.sqrt(clamp(p, 0.6, 1.8)); // smaller heads for higher voices
        [[f1, 1, 6], [f2, 0.7, 9], [f3, 0.25, 10]].forEach(([fr, gain, q]) => {
          const bp = this._filter('bandpass', fr[0] * k, q);
          bp.frequency.setValueAtTime(fr[0] * k, t);
          bp.frequency.exponentialRampToValueAtTime(fr[1] * k, t + dur);
          const g = this._gain(gain, out);
          osc.connect(bp);
          bp.connect(g);
          nodes.push(bp, g);
        });
        nodes.push(osc, vib, vg, out);
        this._route(out, { rev: 0.25, pan: rand(-0.3, 0.3) }, nodes);
        osc.start(t);
        vib.start(t);
        osc.stop(t + dur + 0.05);
        vib.stop(t + dur + 0.05);
        this._dispose(osc, nodes);
        // Breathy consonant at the front.
        this._noise({ t, dur: 0.06, vol: 0.035 * v, filter: { type: 'bandpass', freq: 2200 * k, q: 1.5 } });
      },

      // Stunt bonus: quick gliss into a bright ding.
      stunt(t, v, p) {
        this._tone({ t, freq: 880 * p, sweep: [[1760 * p, 0.07]], dur: 0.09, vol: 0.07 * v, type: 'triangle' });
        this._bell(t + 0.07, 1760 * p, 0.9, 0.13 * v, { rev: 0.45 });
        this._bell(t + 0.07, 2637 * p, 0.7, 0.07 * v, { rev: 0.45, pan: 0.25 });
        this._bell(t + 0.16, 3520 * p, 0.6, 0.045 * v, { rev: 0.5, pan: -0.25 });
      },

      // Rocket whistle, a beat of silence, boom, then crackle.
      firework(t, v, p) {
        const pan = rand(-0.5, 0.5);
        const rise = rand(0.6, 0.85);
        this._tone({
          t, freq: 850 * p, sweep: [[2500 * p, rise]], dur: rise + 0.05, attack: 0.08, hold: rise * 0.6,
          vol: 0.035 * v, vib: { rate: 24, depth: 40, delay: 0 }, pan, rev: 0.5,
        });
        this._noise({
          t, dur: rise, attack: 0.1, hold: rise * 0.5, vol: 0.03 * v, pan,
          filter: { type: 'bandpass', freq: 1500, to: 5000, q: 2, time: rise },
        });
        const b = t + rise + 0.1;
        this._tone({ t: b, freq: 130, sweep: [[38, 0.3]], dur: 0.9, vol: 0.42 * v, pan: pan * 0.5 });
        this._noise({ t: b, color: 'brown', dur: 1.3, vol: 0.5 * v, filter: { freq: 900, to: 80, q: 0.6, time: 1 }, rev: 0.6, pan: pan * 0.5 });
        this._noise({ t: b, dur: 0.3, vol: 0.14 * v, filter: { type: 'bandpass', freq: 2500, to: 600, q: 0.6 }, rev: 0.6, pan });
        for (let k = 0; k < 22; k++) {
          this._noise({
            t: b + 0.15 + Math.pow(Math.random(), 0.7) * 1.1, dur: rand(0.012, 0.035),
            vol: rand(0.02, 0.07) * v, pan: clamp(pan + rand(-0.5, 0.5), -1, 1), rev: 0.3,
            filter: { type: 'highpass', freq: rand(3000, 7000) },
          });
        }
      },
    };
  }

  // ===========================================================================
  //  Generative music
  // ===========================================================================

  /** Lookahead scheduler: queues every 16th note that falls inside the window. */
  _scheduleMusic() {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    if (!this._musicOn && now > this._musicStopAt) return;
    // If we fell behind (first run, music re-enabled, long main-thread stall)
    // restart cleanly on a bar line instead of machine-gunning missed notes.
    if (this._nextStepTime < now - 0.02) {
      if (this._nextStepTime < now - 0.5 && this._step !== 0) {
        this._step = 0;
        this._bar++;
      }
      this._nextStepTime = now + 0.08;
    }
    let guard = 0;
    while (this._nextStepTime < now + LOOKAHEAD && guard++ < 8) {
      try {
        this._musicStep(this._nextStepTime);
      } catch (err) {
        /* never let one bad note stop the sequencer */
      }
      this._nextStepTime += STEP;
      if (++this._step >= 16) {
        this._step = 0;
        this._bar++;
      }
    }
  }

  /** Picks the arrangement for the next 8 bars. */
  _newSection() {
    this._sectionIndex++;
    let energy = ENERGY_CYCLE[this._sectionIndex % ENERGY_CYCLE.length];
    // Occasionally break the cycle so the form is not predictable.
    if (this._sectionIndex > 2 && Math.random() < 0.18) energy = clamp(energy + (Math.random() < 0.5 ? -1 : 1), 0, 2);

    let p;
    do p = (Math.random() * PROGRESSIONS.length) | 0;
    while (p === this._lastProg);
    this._lastProg = p;

    // Arp: one of the hand-written figures, or a fresh random walk.
    let arp;
    if (Math.random() < 0.35) {
      arp = [];
      let idx = (Math.random() * 4) | 0;
      for (let i = 0; i < 16; i++) {
        idx = clamp(idx + pick([-2, -1, -1, 1, 1, 2]), 0, 7);
        arp.push(Math.random() < 0.14 ? -1 : idx);
      }
    } else {
      arp = energy === 0 ? pick([ARP_PATTERNS[2], ARP_PATTERNS[4], ARP_PATTERNS[0]]) : pick(ARP_PATTERNS);
    }

    this._section = {
      prog: PROGRESSIONS[p],
      energy,
      arp: energy === 0 && Math.random() < 0.2 ? null : arp,
      arpWave: Math.random() < 0.5 ? 'sawtooth' : 'square',
      arpOct: Math.random() < 0.3 ? 12 : 0,
      bass: energy === 2 ? pick(['eighths', 'eighths', 'offbeat', 'gallop']) : energy === 1 ? pick(['held', 'offbeat']) : 'held',
      lead: Math.random() < (energy === 2 ? 0.65 : energy === 1 ? 0.35 : 0.5),
      padCut: rand(900, 2100) + energy * 300,
      kickExtra: pick([-1, 10, 7, 14]),
      hat16: Math.random() < 0.5,
      openHat: Math.random() < 0.6,
      fill: pick(['toms', 'snare', 'none']),
    };
  }

  /** Writes a short melodic phrase for the coming bar into this._leadNotes. */
  _composeLead(bar, chord) {
    this._leadNotes = null;
    const sec = this._section;
    if (!sec.lead || bar === BARS_PER_SECTION - 1) return;
    // Call and response: phrases mostly on even bars, answers sometimes.
    if (Math.random() > (bar % 2 === 0 ? 0.85 : 0.45)) return;
    const slots = [0, 2, 3, 4, 6, 8, 10, 11, 12, 14];
    const count = 2 + ((Math.random() * 3) | 0);
    const chosen = new Set();
    while (chosen.size < count) chosen.add(pick(slots));
    const steps = [...chosen].sort((x, y) => x - y);
    const notes = {};
    const chordPcs = chord.notes.map((n) => n % 12);
    steps.forEach((s, i) => {
      this._leadIdx = clamp(this._leadIdx + pick([-2, -1, -1, 0, 1, 1, 2]), 0, LEAD_SCALE.length - 1);
      // Nudge long notes onto chord tones so the line agrees with the harmony.
      if (!chordPcs.includes(LEAD_SCALE[this._leadIdx] % 12)) {
        const alt = clamp(this._leadIdx + (Math.random() < 0.5 ? 1 : -1), 0, LEAD_SCALE.length - 1);
        if (chordPcs.includes(LEAD_SCALE[alt] % 12)) this._leadIdx = alt;
      }
      const next = i + 1 < steps.length ? steps[i + 1] : 16;
      notes[s] = { midi: LEAD_SCALE[this._leadIdx], len: Math.min(next - s, 7) };
    });
    this._leadNotes = notes;
  }

  /** Schedules everything that happens on one 16th-note step at time t. */
  _musicStep(t) {
    const step = this._step;
    const bar = this._bar % BARS_PER_SECTION;
    if (step === 0 && (bar === 0 || !this._section)) this._newSection();
    const sec = this._section;
    const chord = sec.prog[bar % 4];
    const lastBar = bar === BARS_PER_SECTION - 1;
    const M = { revTo: this.musicRevIn }; // route sends to the music reverb

    // ---------------- pad ----------------
    if (step === 0) {
      this._pad(chord, t, STEP * 16, sec.padCut);
      this._composeLead(bar, chord);
      if (bar === 0 && sec.energy === 2) {
        // Crash and a low boom to mark the drop.
        this._noise({ ...M, t, dur: 1.9, vol: 0.06, dest: this.drumBus, filter: { type: 'highpass', freq: 5000 }, rev: 0.5 });
        this._tone({ t, freq: 80, sweep: [[30, 0.5]], dur: 0.9, vol: 0.2, dest: this.drumBus });
      }
      if (bar === 0 && sec.energy === 0) {
        // Soft chime to open quiet sections.
        this._bell(t, mtof(chord.notes[3] + 12), 2, 0.035, { ...M, dest: this.arpBus, rev: 0.7, delay: 0.4 });
      }
    }
    // Riser into an energetic section.
    if (lastBar && step === 8) {
      const nextEnergy = ENERGY_CYCLE[(this._sectionIndex + 1) % ENERGY_CYCLE.length];
      if (nextEnergy === 2) {
        this._noise({
          ...M, t, dur: STEP * 8, attack: STEP * 7.5, vol: 0.05, dest: this.drumBus, rev: 0.3,
          filter: { type: 'bandpass', freq: 800, to: 7000, q: 1.5, time: STEP * 8 },
        });
      }
    }

    // ---------------- bass ----------------
    const bf = mtof(chord.root);
    if (sec.bass === 'held') {
      if (step === 0) {
        const d = STEP * 15;
        this._tone({ t, freq: bf * 2, dur: d, attack: 0.05, hold: d * 0.6, vol: 0.11, dest: this.bassBus });
        this._tone({
          t, freq: bf, type: 'sawtooth', dur: d, attack: 0.05, hold: d * 0.6, vol: 0.08,
          dest: this.bassBus, filter: { freq: 420, q: 1 },
        });
      }
    } else {
      let hit = false;
      let oct = 1;
      if (sec.bass === 'eighths') hit = step % 2 === 0;
      else if (sec.bass === 'offbeat') hit = step % 4 === 2 || step === 0;
      else hit = step % 4 !== 1; // gallop
      if (hit) {
        if (step === 14 || (step === 6 && bar % 2 === 1)) oct = 2;
        const acc = step % 4 === 0 ? 1 : 0.8;
        const d = STEP * (sec.bass === 'gallop' ? 0.95 : 1.7);
        this._tone({
          t, freq: bf * oct, type: 'sawtooth', dur: d, attack: 0.004, hold: d * 0.3, vol: 0.13 * acc,
          dest: this.bassBus, filter: { freq: 1100 * acc, to: 190, q: 3.5, time: d * 0.8 },
        });
        this._tone({ t, freq: bf * oct * 2, type: 'square', dur: d, vol: 0.03 * acc, dest: this.bassBus, filter: { freq: 900 } });
        this._tone({ t, freq: bf * oct, dur: d, attack: 0.004, hold: d * 0.4, vol: 0.12, dest: this.bassBus });
      }
    }

    // ---------------- arpeggio ----------------
    if (sec.arp) {
      const idx = sec.arp[step];
      if (idx >= 0) {
        const tones = chord.notes;
        const midi = tones[idx % 4] + (idx >= 4 ? 12 : 0) + sec.arpOct;
        const acc = step % 4 === 0 ? 1 : step % 2 === 0 ? 0.8 : 0.62;
        this._pluck(t, mtof(midi), 0.26, 0.05 * acc * (sec.arpWave === 'square' ? 0.75 : 1), {
          ...M, type: sec.arpWave, dest: this.arpBus, pan: step % 2 ? 0.32 : -0.32, delay: 0.42, rev: 0.22,
        });
      }
    }

    // ---------------- lead ----------------
    if (this._leadNotes && this._leadNotes[step]) {
      const n = this._leadNotes[step];
      const f = mtof(n.midi);
      const d = n.len * STEP + 0.12;
      const common = {
        ...M, t, freq: f, dur: d, attack: 0.03, hold: d * 0.55, dest: this.leadBus,
        vib: { rate: 5.4, depth: f * 0.006, delay: 0.18 }, delay: 0.4, rev: 0.4,
      };
      this._tone({ ...common, type: 'sawtooth', vol: 0.03, detune: 7, filter: { freq: 2600, to: 1400, q: 1 } });
      this._tone({ ...common, type: 'triangle', vol: 0.05, detune: -6 });
    }

    // ---------------- drums ----------------
    if (sec.energy === 0) {
      // Just a heartbeat-soft kick and a tick so the pulse never disappears.
      if (step === 0 && bar % 2 === 0) this._kick(t, 0.5, 0.15);
      if (step % 4 === 2) this._hat(t, 0.35, false);
      return;
    }
    const full = sec.energy === 2;
    const fillNow = lastBar && step >= 12 && sec.fill !== 'none';

    // Kick
    let kick = step === 0 || step === 8;
    if (full && step === sec.kickExtra && !(lastBar && step > 8)) kick = true;
    if (full && bar % 4 === 3 && step === 11) kick = true;
    if (kick) this._kick(t, full ? 1 : 0.8, full ? 0.42 : 0.28);

    // Snare / clap on 2 and 4
    if ((step === 4 || step === 12) && !fillNow) this._snare(t, full ? 1 : 0.5);
    if (full && !fillNow && step === 15 && bar % 2 === 1 && Math.random() < 0.5) this._snare(t, 0.3);

    // Hats
    if (step % 2 === 0) {
      const open = sec.openHat && full && step === 14 && bar % 2 === 1;
      this._hat(t, step % 4 === 2 ? 1 : 0.7, open);
    } else if (sec.hat16 && full && Math.random() < 0.7) {
      this._hat(t, 0.32, false);
    }

    // End-of-section fill
    if (fillNow) {
      if (sec.fill === 'toms') {
        const tf = [196, 165, 131, 98][step - 12];
        this._tone({ ...M, t, freq: tf * 1.4, sweep: [[tf, 0.06], [tf * 0.7, 0.28]], dur: 0.3, vol: 0.26, dest: this.drumBus, pan: (step - 13.5) * 0.3, rev: 0.25 });
        this._noise({ t, dur: 0.04, vol: 0.05, dest: this.drumBus, filter: { type: 'bandpass', freq: 3000, q: 1 } });
      } else {
        this._snare(t, 0.45 + (step - 12) * 0.18);
      }
    }
  }

  /** Lush detuned-saw pad chord with slow attack and a breathing filter. */
  _pad(chord, t, dur, cutoff) {
    const ctx = this.ctx;
    const rel = 1.3;
    const end = t + dur + rel;
    const nodes = [];
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1, t + 0.45);
    env.gain.setValueAtTime(1, t + dur);
    env.gain.linearRampToValueAtTime(0, end);
    const lp = this._filter('lowpass', cutoff * 0.6, 0.8, env);
    lp.frequency.setValueAtTime(cutoff * 0.6, t);
    lp.frequency.linearRampToValueAtTime(cutoff, t + dur * 0.5);
    lp.frequency.linearRampToValueAtTime(cutoff * 0.7, end);
    env.connect(this.padBus);
    const send = this._gain(0.4, this.musicRevIn);
    env.connect(send);
    nodes.push(env, lp, send);

    // The two detuned halves of each note are split left/right for width.
    let left = lp;
    let right = lp;
    if (ctx.createStereoPanner) {
      left = ctx.createStereoPanner();
      left.pan.value = -0.55;
      left.connect(lp);
      right = ctx.createStereoPanner();
      right.pan.value = 0.55;
      right.connect(lp);
      nodes.push(left, right);
    }
    let first = null;
    chord.notes.forEach((m, i) => {
      const f = mtof(m);
      for (const side of [-1, 1]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = side * (8 + i * 1.5);
        const g = this._gain(0.03);
        o.connect(g);
        g.connect(side < 0 ? left : right);
        o.start(t);
        o.stop(end + 0.05);
        nodes.push(o, g);
        if (!first) first = o;
      }
    });
    // Soft sine an octave below the top note warms the voicing.
    const sub = ctx.createOscillator();
    sub.frequency.value = mtof(chord.notes[0] - 12);
    const sg = this._gain(0.05, lp);
    sub.connect(sg);
    sub.start(t);
    sub.stop(end + 0.05);
    nodes.push(sub, sg);
    this._dispose(first, nodes);
  }

  _kick(t, vel, duck) {
    this._tone({ t, freq: 150, sweep: [[52, 0.07], [40, 0.3]], dur: 0.34, attack: 0.002, vol: 0.5 * vel, dest: this.drumBus });
    this._noise({ t, dur: 0.02, vol: 0.06 * vel, dest: this.drumBus, filter: { type: 'bandpass', freq: 3200, q: 0.8 } });
    // Sidechain pump on pads and bass.
    const g = this.sidechain.gain;
    g.setValueAtTime(1, t);
    g.linearRampToValueAtTime(1 - duck, t + 0.012);
    g.linearRampToValueAtTime(1, t + 0.26);
  }

  _snare(t, vel) {
    const M = { revTo: this.musicRevIn, dest: this.drumBus };
    this._noise({ ...M, t, dur: 0.22, vol: 0.2 * vel, filter: { type: 'bandpass', freq: 2100, q: 0.6 }, rev: 0.45 });
    this._noise({ ...M, t, dur: 0.12, vol: 0.07 * vel, filter: { type: 'highpass', freq: 6000 } });
    this._tone({ ...M, t, freq: 230, sweep: [[165, 0.08]], dur: 0.13, vol: 0.16 * vel, type: 'triangle' });
  }

  _hat(t, vel, open) {
    this._noise({
      t, dur: open ? 0.28 : 0.05, vol: (open ? 0.04 : 0.045) * vel, dest: this.drumBus,
      pan: 0.2, filter: { type: 'highpass', freq: open ? 7000 : 8500, q: 0.8 },
    });
  }

  // ===========================================================================
  //  Tab visibility
  // ===========================================================================

  /** Suspend the context while the tab is hidden and bring it back afterwards. */
  _onVisibility() {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'closed') return;
    if (document.hidden) {
      if (ctx.state === 'running') {
        this._autoSuspended = true;
        const p = ctx.suspend();
        if (p && p.catch) p.catch(() => {});
      }
    } else if (this._autoSuspended) {
      this._autoSuspended = false;
      const p = ctx.resume();
      if (p && p.catch) p.catch(() => {});
    }
  }
}
