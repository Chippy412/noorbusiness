/**
 * gfx/particles.js — CPU-simulated particle system drawn with two THREE.Points:
 * one alpha-blended (smoke, dust, leaves, confetti) and one additive (sparks,
 * flames, fireworks — these glow through bloom).
 *
 * Ring buffers, no per-frame allocations. Sizes are world-space diameters (m).
 */
import * as THREE from 'three';

const VERT = /* glsl */`
attribute vec4 aState;   // x: life fraction 0..1 (>=1 dead), y: size start, z: size end, w: alpha
attribute vec3 aColor0;
attribute vec4 aColor1;  // rgb: end colour, a: twinkle amount
uniform float uScale;    // half the viewport height in pixels
uniform float uTime;
varying vec4 vColor;
void main() {
  float t = aState.x;
  if (t >= 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec4(0.0);
    return;
  }
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float size = mix(aState.y, aState.z, t);
  gl_PointSize = clamp(size * uScale * projectionMatrix[1][1] / max(-mv.z, 0.05), 0.0, 384.0);
  float fade = smoothstep(0.0, 0.06, t) * (1.0 - smoothstep(0.5, 1.0, t));
  float rnd = fract(sin(float(gl_VertexID) * 12.9898) * 43758.5453);
  float tw = 1.0 - aColor1.a * (0.5 + 0.5 * sin(uTime * (14.0 + rnd * 16.0) + rnd * 40.0));
  vColor = vec4(mix(aColor0, aColor1.rgb, t), aState.w * fade * tw);
}`;

const FRAG = /* glsl */`
uniform float uBoost;
uniform float uCore;
varying vec4 vColor;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float d = dot(p, p);
  if (d > 1.0) discard;
  float a = 1.0 - d;
  a = a * a * (1.0 + uCore * a * a);
  gl_FragColor = vec4(vColor.rgb * uBoost, vColor.a * a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const _size = new THREE.Vector2();

class Layer {
  constructor(scene, max, additive) {
    this.max = max;
    this.cursor = 0;
    this.alive = 0;
    this.colorDirty = false;

    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.state = new Float32Array(max * 4);
    this.col0 = new Float32Array(max * 3);
    this.col1 = new Float32Array(max * 4);
    this.age = new Float32Array(max);
    this.life = new Float32Array(max); // 0 = dead
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);
    for (let i = 0; i < max; i++) this.state[i * 4] = 1;

    const geo = new THREE.BufferGeometry();
    const dyn = (arr, n) => {
      const a = new THREE.BufferAttribute(arr, n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    geo.setAttribute('position', (this.aPos = dyn(this.pos, 3)));
    geo.setAttribute('aState', (this.aState = dyn(this.state, 4)));
    geo.setAttribute('aColor0', (this.aCol0 = dyn(this.col0, 3)));
    geo.setAttribute('aColor1', (this.aCol1 = dyn(this.col1, 4)));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uScale: { value: 300 },
        uTime: { value: 0 },
        uBoost: { value: additive ? 1.8 : 1.0 },
        uCore: { value: additive ? 1.5 : 0.0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.uniforms = material.uniforms;

    const points = new THREE.Points(geo, material);
    points.frustumCulled = false;
    points.renderOrder = additive ? 11 : 10;
    points.visible = false;
    points.name = additive ? 'particles-additive' : 'particles';
    points.onBeforeRender = (renderer) => {
      const rt = renderer.getRenderTarget();
      const h = rt ? rt.height : renderer.getDrawingBufferSize(_size).y;
      material.uniforms.uScale.value = h * 0.5;
      material.uniformsNeedUpdate = true;
    };
    this.points = points;
    scene.add(points);
  }

  update(dt, time) {
    this.uniforms.uTime.value = time;
    if (this.alive === 0) {
      if (this.points.visible) { this.points.visible = false; this.aState.needsUpdate = true; }
      return;
    }
    const { pos, vel, state, age, life, grav, drag, max } = this;
    let alive = 0;
    for (let i = 0; i < max; i++) {
      const l = life[i];
      if (l <= 0) continue;
      const a = age[i] + dt;
      if (a >= l) {
        life[i] = 0;
        state[i * 4] = 1;
        continue;
      }
      age[i] = a;
      const j = i * 3;
      const k = Math.max(0, 1 - drag[i] * dt);
      const vx = vel[j] * k;
      const vy = (vel[j + 1] + grav[i] * dt) * k;
      const vz = vel[j + 2] * k;
      vel[j] = vx; vel[j + 1] = vy; vel[j + 2] = vz;
      pos[j] += vx * dt; pos[j + 1] += vy * dt; pos[j + 2] += vz * dt;
      state[i * 4] = a / l;
      alive++;
    }
    this.alive = alive;
    this.aPos.needsUpdate = true;
    this.aState.needsUpdate = true;
    if (this.colorDirty) {
      this.aCol0.needsUpdate = true;
      this.aCol1.needsUpdate = true;
      this.colorDirty = false;
    }
    this.points.visible = true;
  }
}

const _c0 = new THREE.Color();
const _c1 = new THREE.Color();
const ZERO = { x: 0, y: 0, z: 0 };
const FIREWORK_COLORS = [0xff4d6d, 0x5ff0ff, 0xffd23f, 0x9d7bff, 0x6dff8a, 0xff8a3d, 0xff5fd2];
const CONFETTI_COLORS = [0xff4d6d, 0x36c5f0, 0xffd23f, 0x8a5cf6, 0x3ddc84, 0xff8a3d, 0xffffff];
const LEAF_COLORS = [0x4f9a3a, 0x7fb93f, 0x2f7a3a, 0xb7c84a];

export class ParticleSystem {
  /**
   * @param {{scene: THREE.Object3D, max?: number}} o  `max` is the capacity of EACH layer
   *   (alpha-blended and additive); when a layer is full the oldest particles are recycled.
   */
  constructor({ scene, max = 4000 }) {
    this.normal = new Layer(scene, max, false);
    this.additive = new Layer(scene, max, true);
    this.time = 0;
    this._o = {};
    this._v = { x: 0, y: 0, z: 0 };
  }

  /**
   * opts: { position:{x,y,z}, velocity?:{x,y,z}, spread?, posSpread?, count?, color?, colorEnd?,
   *   size?, sizeEnd?, life?, lifeJitter? (0..1 fraction of life), gravity? (m/s², negative falls),
   *   drag?, additive?, alpha?,
   *   spreadMin? (0..1: min fraction of `spread`, 1 = a shell), twinkle? (0..1 flicker) }
   */
  emit(opts) {
    const L = opts.additive ? this.additive : this.normal;
    const p = opts.position;
    const v = opts.velocity || ZERO;
    const count = opts.count === undefined ? 1 : opts.count | 0;
    const spread = opts.spread || 0;
    const spreadMin = opts.spreadMin || 0;
    const posSpread = opts.posSpread || 0;
    const size = opts.size === undefined ? 0.3 : opts.size;
    const sizeEnd = opts.sizeEnd === undefined ? size : opts.sizeEnd;
    const life = opts.life === undefined ? 1 : opts.life;
    const jitter = opts.lifeJitter || 0;
    const gravity = opts.gravity || 0;
    const drag = opts.drag || 0;
    const alpha = opts.alpha === undefined ? 1 : opts.alpha;
    const twinkle = opts.twinkle || 0;
    _c0.set(opts.color === undefined ? 0xffffff : opts.color);
    if (opts.colorEnd === undefined) _c1.copy(_c0); else _c1.set(opts.colorEnd);

    for (let n = 0; n < count; n++) {
      const i = L.cursor;
      L.cursor = (i + 1) % L.max;
      if (L.life[i] <= 0) L.alive++;
      const j = i * 3, q = i * 4;

      let px = p.x, py = p.y, pz = p.z;
      if (posSpread > 0) {
        px += (Math.random() * 2 - 1) * posSpread;
        py += (Math.random() * 2 - 1) * posSpread;
        pz += (Math.random() * 2 - 1) * posSpread;
      }
      let vx = v.x, vy = v.y, vz = v.z;
      if (spread > 0) {
        const u = Math.random() * 2 - 1;
        const th = Math.random() * 6.2831853;
        const r = Math.sqrt(1 - u * u);
        const m = spread * (spreadMin + (1 - spreadMin) * Math.random());
        vx += r * Math.cos(th) * m; vy += u * m; vz += r * Math.sin(th) * m;
      }
      L.pos[j] = px; L.pos[j + 1] = py; L.pos[j + 2] = pz;
      L.vel[j] = vx; L.vel[j + 1] = vy; L.vel[j + 2] = vz;
      L.age[i] = 0;
      L.life[i] = Math.max(0.02, life * (1 + (Math.random() * 2 - 1) * jitter));
      L.grav[i] = gravity;
      L.drag[i] = drag;
      L.state[q] = 0; L.state[q + 1] = size; L.state[q + 2] = sizeEnd; L.state[q + 3] = alpha;
      L.col0[j] = _c0.r; L.col0[j + 1] = _c0.g; L.col0[j + 2] = _c0.b;
      L.col1[q] = _c1.r; L.col1[q + 1] = _c1.g; L.col1[q + 2] = _c1.b; L.col1[q + 3] = twinkle;
    }
    L.colorDirty = true;
    L.points.visible = true;
  }

  _reset(position) {
    const o = this._o;
    o.position = position;
    o.velocity = undefined; o.spread = 0; o.spreadMin = 0; o.posSpread = 0; o.count = 1;
    o.color = 0xffffff; o.colorEnd = undefined; o.size = 0.3; o.sizeEnd = undefined;
    o.life = 1; o.lifeJitter = 0; o.gravity = 0; o.drag = 0; o.additive = false; o.alpha = 1; o.twinkle = 0;
    return o;
  }

  _vel(x, y, z, base, k = 1) {
    const v = this._v;
    v.x = x + (base ? base.x * k : 0);
    v.y = y + (base ? base.y * k : 0);
    v.z = z + (base ? base.z * k : 0);
    return v;
  }

  /**
   * Ready-made effects. opts: { color?, velocity?, count? (overrides the main count), scale? (size multiplier) }
   * 'tyreSmoke' | 'dust' | 'spark' | 'splash' | 'pickup' | 'nitro' | 'engineSmoke' | 'firework' | 'leaves' | 'confetti'
   */
  preset(name, position, opts = {}) {
    const o = this._reset(position);
    const s = opts.scale === undefined ? 1 : opts.scale;
    const bv = opts.velocity;
    const n = (def) => (opts.count === undefined ? def : opts.count);

    switch (name) {
      case 'tyreSmoke':
        o.velocity = this._vel(0, 0.7, 0, bv, 0.15);
        o.spread = 0.6; o.posSpread = 0.12; o.count = n(2);
        o.color = opts.color ?? 0xe6e6ea; o.colorEnd = 0xa9abb3;
        o.size = 0.45 * s; o.sizeEnd = 2.0 * s; o.life = 1.2; o.lifeJitter = 0.3;
        o.gravity = 0.5; o.drag = 1.6; o.alpha = 0.34;
        this.emit(o);
        break;

      case 'dust':
        o.velocity = this._vel(0, 0.6, 0, bv, 0.2);
        o.spread = 0.9; o.posSpread = 0.15; o.count = n(3);
        o.color = opts.color ?? 0xd9c29a; o.colorEnd = 0xb8a47f;
        o.size = 0.35 * s; o.sizeEnd = 1.5 * s; o.life = 0.95; o.lifeJitter = 0.3;
        o.gravity = 0.15; o.drag = 2.2; o.alpha = 0.32;
        this.emit(o);
        break;

      case 'spark':
        o.additive = true;
        o.velocity = this._vel(0, 2.2, 0, bv, 0.5);
        o.spread = 5.5; o.spreadMin = 0.3; o.count = n(10);
        o.color = opts.color ?? 0xfff0b8; o.colorEnd = 0xff5a10;
        o.size = 0.13 * s; o.sizeEnd = 0.03 * s; o.life = 0.55; o.lifeJitter = 0.5;
        o.gravity = -9.8; o.drag = 0.6;
        this.emit(o);
        break;

      case 'splash':
        o.velocity = this._vel(0, 5.2, 0, bv, 0.3);
        o.spread = 3.2; o.posSpread = 0.25; o.count = n(18);
        o.color = opts.color ?? 0xf2fbff; o.colorEnd = 0xa6dbf2;
        o.size = 0.22 * s; o.sizeEnd = 0.42 * s; o.life = 0.9; o.lifeJitter = 0.3;
        o.gravity = -10; o.drag = 0.4; o.alpha = 0.8;
        this.emit(o);
        // soft mist
        o.velocity = this._vel(0, 1.4, 0);
        o.spread = 1.6; o.posSpread = 0.5; o.count = Math.max(1, (n(18) / 3) | 0);
        o.size = 0.9 * s; o.sizeEnd = 2.6 * s; o.life = 1.1; o.gravity = -0.6; o.drag = 1.8; o.alpha = 0.3;
        this.emit(o);
        break;

      case 'pickup': {
        const col = opts.color ?? 0x5ff0ff;
        o.additive = true;
        o.velocity = this._vel(0, 1.2, 0);
        o.spread = 4.2; o.spreadMin = 0.55; o.count = n(26);
        o.color = 0xffffff; o.colorEnd = col;
        o.size = 0.26 * s; o.sizeEnd = 0.04 * s; o.life = 0.7; o.lifeJitter = 0.35;
        o.gravity = 1.5; o.drag = 3.2; o.twinkle = 0.4;
        this.emit(o);
        // flash
        o.velocity = undefined; o.spread = 0; o.count = 1; o.twinkle = 0;
        o.color = col; o.colorEnd = col;
        o.size = 0.6 * s; o.sizeEnd = 3.2 * s; o.life = 0.32; o.lifeJitter = 0; o.gravity = 0; o.drag = 0; o.alpha = 0.55;
        this.emit(o);
        break;
      }

      case 'nitro':
        o.additive = true;
        // blue core
        o.velocity = this._vel(0, 0, 0, bv, 1);
        o.spread = 0.5; o.posSpread = 0.03; o.count = n(3);
        o.color = opts.color ?? 0xbfe6ff; o.colorEnd = 0x2a55ff;
        o.size = 0.34 * s; o.sizeEnd = 0.08 * s; o.life = 0.2; o.lifeJitter = 0.4; o.drag = 2;
        this.emit(o);
        // orange tail
        o.velocity = this._vel(0, 0.3, 0, bv, 0.7);
        o.spread = 0.9; o.count = Math.max(1, (n(3) * 0.67) | 0);
        o.color = 0xffb14d; o.colorEnd = 0xff3010;
        o.size = 0.2 * s; o.sizeEnd = 0.5 * s; o.life = 0.36; o.alpha = 0.45; o.drag = 3;
        this.emit(o);
        break;

      case 'engineSmoke':
        o.velocity = this._vel(0, 1.3, 0, bv, 0.2);
        o.spread = 0.45; o.posSpread = 0.1; o.count = n(1);
        o.color = opts.color ?? 0x26262a; o.colorEnd = 0x5c5c62;
        o.size = 0.4 * s; o.sizeEnd = 1.8 * s; o.life = 1.7; o.lifeJitter = 0.3;
        o.gravity = 1.1; o.drag = 0.9; o.alpha = 0.5;
        this.emit(o);
        break;

      case 'firework': {
        const col = opts.color ?? FIREWORK_COLORS[(Math.random() * FIREWORK_COLORS.length) | 0];
        const rays = n(70);
        const speed = 13 * s;
        o.additive = true;
        o.gravity = -2.6; o.drag = 1.7; o.count = 1; o.lifeJitter = 0.12;
        for (let r = 0; r < rays; r++) {
          const u = Math.random() * 2 - 1, th = Math.random() * 6.2831853;
          const h = Math.sqrt(1 - u * u);
          const sp = speed * (0.82 + Math.random() * 0.18);
          const dx = h * Math.cos(th), dz = h * Math.sin(th);
          for (let k = 0; k < 5; k++) { // each ray drags a fading trail
            const f = 1 - k * 0.075;
            o.velocity = this._vel(dx * sp * f, u * sp * f, dz * sp * f, bv, 1);
            o.color = k === 0 ? 0xffffff : col; o.colorEnd = col;
            o.size = (0.55 - k * 0.08) * s; o.sizeEnd = 0.1 * s;
            o.life = 1.7 - k * 0.16; o.alpha = 1 - k * 0.14; o.twinkle = k === 0 ? 0.25 : 0;
            this.emit(o);
          }
        }
        // glitter
        o.velocity = this._vel(0, 0, 0, bv, 1);
        o.spread = speed * 0.75; o.spreadMin = 0.15; o.count = (rays * 0.9) | 0;
        o.color = 0xffffff; o.colorEnd = 0xffe9b0;
        o.size = 0.22 * s; o.sizeEnd = 0.1 * s; o.life = 2.5; o.lifeJitter = 0.35;
        o.gravity = -1.6; o.drag = 2.3; o.twinkle = 1; o.alpha = 1;
        this.emit(o);
        // flash
        o.velocity = undefined; o.spread = 0; o.count = 1; o.twinkle = 0;
        o.color = 0xffffff; o.colorEnd = col;
        o.size = 5 * s; o.sizeEnd = 11 * s; o.life = 0.3; o.lifeJitter = 0; o.gravity = 0; o.drag = 0; o.alpha = 0.5;
        this.emit(o);
        break;
      }

      case 'leaves': {
        const total = n(8);
        o.velocity = this._vel(0, 1.2, 0, bv, 0.4);
        o.spread = 1.8; o.posSpread = 0.5; o.count = 1;
        o.size = 0.15 * s; o.sizeEnd = 0.12 * s; o.life = 2.6; o.lifeJitter = 0.3;
        o.gravity = -1.6; o.drag = 1.7; o.twinkle = 0.45; o.alpha = 0.95;
        for (let i = 0; i < total; i++) {
          o.color = opts.color ?? LEAF_COLORS[(Math.random() * LEAF_COLORS.length) | 0];
          o.colorEnd = o.color;
          this.emit(o);
        }
        break;
      }

      case 'confetti': {
        const total = n(48);
        o.velocity = this._vel(0, 5.5, 0, bv, 0.5);
        o.spread = 3.8; o.posSpread = 0.2; o.count = 1;
        o.size = 0.14 * s; o.sizeEnd = 0.12 * s; o.life = 2.6; o.lifeJitter = 0.3;
        o.gravity = -5.5; o.drag = 1.9; o.twinkle = 0.6; o.alpha = 1;
        for (let i = 0; i < total; i++) {
          o.color = opts.color ?? CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0];
          o.colorEnd = o.color;
          this.emit(o);
        }
        break;
      }

      default:
        break;
    }
  }

  update(dt) {
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;
    this.time += dt;
    this.normal.update(dt, this.time);
    this.additive.update(dt, this.time);
  }
}
