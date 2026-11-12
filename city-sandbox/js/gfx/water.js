// water.js — stylised-realistic ocean on a single flat quad.
//
// All the detail is in the fragment shader: drag-warped multi-octave waves
// (finite-difference normals, filtered by distance), fresnel reflection of the
// *actual* procedural sky (same GLSL as the dome), sun/moon glitter, turquoise
// shallows + animated surf computed from rounded-rectangle land SDFs, and a
// distance fade into the sky's own horizon colour so the far edge is invisible.

import * as THREE from 'three';
import { shared, NOISE_GLSL } from './materials.js';
import { ATMOSPHERE_UNIFORMS_GLSL, ATMOSPHERE_GLSL } from './sky.js';

const MAX_SHAPES = 6;

const VERT = /* glsl */ `
varying vec3 vWorldPos;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const FRAG = /* glsl */ `
precision highp float;
varying vec3 vWorldPos;
${ATMOSPHERE_UNIFORMS_GLSL}
uniform float uTime;
uniform vec3 uLightDir;       // toward the dominant light (sun or moon)
uniform vec3 uLightColor;     // its colour * relative strength
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uFoamColor;
uniform float uFogDensity;
uniform float uFadeStart;
uniform float uFadeEnd;
uniform vec4 uLand[${MAX_SHAPES}];    // x, z, hx, hz
uniform float uLandR[${MAX_SHAPES}];
uniform int uLandCount;
${NOISE_GLSL}
${ATMOSPHERE_GLSL}

// signed distance (m) to the union of rounded rectangles; > 0 = open water
float landSDF(vec2 p){
  float d = 1e5;
  for (int i = 0; i < ${MAX_SHAPES}; i++) {
    if (i >= uLandCount) break;
    float r = uLandR[i];
    vec2 q = abs(p - uLand[i].xy) - (uLand[i].zw - r);
    d = min(d, length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r);
  }
  return d;
}

// Sum of sharpened sine waves where each octave drags the sample point of the
// next one — gives pointy crests and non-repeating interference.
const int WAVE_ITERS = 12;
float waves(vec2 p){
  p *= 0.16;
  float ang = 0.0, freq = 1.0, speed = 1.6, w = 1.0, sum = 0.0, wsum = 0.0;
  for (int i = 0; i < WAVE_ITERS; i++) {
    vec2 dir = vec2(sin(ang), cos(ang));
    float x = dot(dir, p) * freq + uTime * speed;
    float wave = exp(sin(x) - 1.0);
    float dx = -wave * cos(x);
    p += dir * dx * w * 0.32;
    sum += wave * w; wsum += w;
    w *= 0.82; freq *= 1.19; speed *= 1.07;
    ang += 1232.399963;
  }
  return sum / wsum;
}

void main(){
  vec3 toCam = cameraPosition - vWorldPos;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  vec2 p = vWorldPos.xz;

  float sdf = landSDF(p);
  float sd = max(sdf, 0.0);

  // ---- wave normal: finite differences, footprint grows with distance (free filtering) ----
  float eps = max(0.12, dist * 0.006);
  float h0 = waves(p);
  float hx = waves(p + vec2(eps, 0.0));
  float hz = waves(p + vec2(0.0, eps));
  float calm = mix(0.35, 1.0, smoothstep(0.0, 30.0, sd));         // sheltered near the shore
  float amp = 3.4 * calm * (1.0 - 0.8 * smoothstep(250.0, 1300.0, dist));
  vec3 N = normalize(vec3(-(hx - h0) * amp / eps, 1.0, -(hz - h0) * amp / eps));
  // centimetre ripples close to the camera
  float rip = 1.0 - smoothstep(15.0, 90.0, dist);
  if (rip > 0.0) {
    vec2 rp = p * 1.9 + vec2(uTime * 0.6, uTime * 0.35);
    float r0 = ntNoise(rp), rx = ntNoise(rp + vec2(0.25, 0.0)), rz = ntNoise(rp + vec2(0.0, 0.25));
    N = normalize(N + vec3(r0 - rx, 0.0, r0 - rz) * 0.55 * rip);
  }

  float ndv = max(dot(N, V), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);

  // ---- reflection of the procedural sky ----
  vec3 R = reflect(-V, N);
  R.y = abs(R.y);
  vec3 refl = ntAtmosphere(R);

  // ---- water body: deep -> turquoise shallows -> pale sand at the waterline ----
  float shallow = exp(-sd / 16.0);
  float beach = exp(-sd / 3.5);
  vec3 body = mix(uDeep, uShallow, shallow * 0.9);
  body = mix(body, uShallow * vec3(1.5, 1.35, 1.0) + uFoamColor * 0.10, beach * 0.55);
  // light scattering through wave crests
  body += uShallow * 0.35 * smoothstep(0.45, 0.9, h0) * calm * (0.4 + 0.6 * max(dot(V.xz, -normalize(uLightDir.xz + 1e-4)), 0.0));

  vec3 col = mix(body, refl, fres * (1.0 - 0.35 * beach));

  // ---- sun / moon glitter: tight sparkle up close, broad path far away ----
  vec3 H = normalize(uLightDir + V);
  float ndh = max(dot(N, H), 0.0);
  float far = smoothstep(40.0, 900.0, dist);
  float sp = mix(700.0, 110.0, far);
  float spec = pow(ndh, sp) * mix(9.0, 2.2, far) + pow(ndh, 28.0) * 0.10;
  col += uLightColor * spec * (0.25 + 0.75 * fres) * smoothstep(0.0, 6.0, sd + 2.0);

  // ---- foam: breaking line at the shore + sets of bands rolling in ----
  float fn = ntFbm3(p * 0.22 + vec2(uTime * 0.03, -uTime * 0.02));
  float lace = ntNoise(p * 1.7 + vec2(uTime * 0.25, uTime * 0.1)) * 0.6 + ntNoise(p * 4.3 - uTime * 0.2) * 0.4;
  float swash = 1.3 + 0.9 * sin(uTime * 0.7 + fn * 6.0);                 // waterline breathing in and out
  float edge = smoothstep(swash + 1.2, swash - 0.4, sdf + (lace - 0.5) * 1.6);
  edge *= smoothstep(-4.0, -1.5, sdf);       // no foam sheet where land should be covering the water
  float phase = sd * 0.42 + uTime * 0.85 + fn * 5.0;
  float band = pow(0.5 + 0.5 * sin(phase), 8.0) * exp(-sd / 9.0) * smoothstep(0.42, 0.62, lace + 0.25 * exp(-sd / 4.0));
  float crest = smoothstep(0.80, 0.97, h0) * smoothstep(0.5, 0.75, lace) * calm * 0.35 * (1.0 - smoothstep(60.0, 400.0, dist));
  float foam = clamp(edge * (0.55 + 0.45 * lace) + band * 0.9 + crest, 0.0, 1.0);
  col = mix(col, uFoamColor, foam);

  // ---- distance: scene-matching exp2 fog, then a hard guarantee at the mesh edge ----
  float fd = uFogDensity * dist;
  float fog = 1.0 - exp(-fd * fd);
  fog = max(fog, smoothstep(uFadeStart, uFadeEnd, dist));
  col = mix(col, ntAtmosphere(vec3(-V.x, 0.0, -V.z)), fog);

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const DEEP_DAY = new THREE.Color(0.006, 0.060, 0.115);
const DEEP_NIGHT = new THREE.Color(0.002, 0.007, 0.018);
const SHALLOW_DAY = new THREE.Color(0.02, 0.46, 0.42);
const SHALLOW_NIGHT = new THREE.Color(0.006, 0.045, 0.06);

export class Water {
  /**
   * @param {{environment: import('./sky.js').Environment, size?:number, y?:number}} o
   */
  constructor({ environment, size = 3000, y = -0.6 }) {
    this.environment = environment;
    this.size = size;
    const sky = environment.skyUniforms;
    const land = [];
    const landR = [];
    for (let i = 0; i < MAX_SHAPES; i++) { land.push(new THREE.Vector4(0, 0, 0, 0)); landR.push(0); }

    this.uniforms = {
      // shared by reference with the sky dome
      uZenith: sky.uZenith, uHorizon: sky.uHorizon, uSunDir: sky.uSunDir, uMoonDir: sky.uMoonDir,
      uSunColor: sky.uSunColor, uSunGlow: sky.uSunGlow, uSunsetColor: sky.uSunsetColor,
      uSunsetAmt: sky.uSunsetAmt, uMoonColor: sky.uMoonColor, uMoonGlow: sky.uMoonGlow,
      uTime: shared.uTime,
      uLightDir: { value: environment.sunDirection },
      uLightColor: { value: new THREE.Color() },
      uDeep: { value: new THREE.Color() },
      uShallow: { value: new THREE.Color() },
      uFoamColor: { value: new THREE.Color() },
      uFogDensity: { value: 0.0011 },
      uFadeStart: { value: size * 0.5 * 0.45 },
      uFadeEnd: { value: size * 0.5 * 0.96 },
      uLand: { value: land },
      uLandR: { value: landR },
      uLandCount: { value: 0 },
    };

    const geo = new THREE.PlaneGeometry(size, size, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, fog: false,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.position.y = y;
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = false;
    this.mesh.name = 'Ocean';
    this._tmp = new THREE.Color();
    this._syncColors();
  }

  /** @param {{x:number,z:number,hx:number,hz:number,r:number}[]} shapes up to 6 rounded rects of land at sea level */
  setLandShapes(shapes = []) {
    const n = Math.min(shapes.length, MAX_SHAPES);
    for (let i = 0; i < n; i++) {
      const s = shapes[i];
      const r = Math.max(0, Math.min(s.r || 0, s.hx, s.hz));
      this.uniforms.uLand.value[i].set(s.x, s.z, s.hx, s.hz);
      this.uniforms.uLandR.value[i] = r;
    }
    this.uniforms.uLandCount.value = n;
  }

  _syncColors() {
    const env = this.environment;
    const u = this.uniforms;
    const day = 1 - env.night;
    u.uDeep.value.copy(DEEP_NIGHT).lerp(DEEP_DAY, day);
    u.uShallow.value.copy(SHALLOW_NIGHT).lerp(SHALLOW_DAY, day * (0.3 + 0.7 * Math.min(1, env.lightIntensity * 1.15) * (0.35 + 0.65 * env.sunColor.g)));
    // tint the body slightly by the sky so sunset water is not stubbornly teal
    u.uDeep.value.lerp(this._tmp.copy(env.horizonColor).multiplyScalar(0.12), 0.35);
    u.uLightColor.value.copy(env.sunColor).multiplyScalar(env.lightIntensity * 3.0);
    // foam is lit by sky ambient + direct light
    u.uFoamColor.value.copy(env.horizonColor).lerp(env.skyColor, 0.4).multiplyScalar(0.75)
      .add(this._tmp.copy(env.sunColor).multiplyScalar(env.lightIntensity * 0.55));
    u.uFoamColor.value.addScalar(0.02 * env.night);
    u.uFogDensity.value = env.fog ? env.fog.density : 0.0011;
  }

  /**
   * @param {number} dt
   * @param {THREE.Camera} camera
   */
  update(dt, camera) {
    this._syncColors();
    if (camera) {
      // the quad follows the camera (shading is world-space, so this is invisible)
      // which keeps its edge a constant distance away, safely inside the fade
      this.mesh.position.x = camera.position.x;
      this.mesh.position.z = camera.position.z;
    }
  }
}
