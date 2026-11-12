// sky.js — day/night cycle, procedural sky dome, sun/moon light, fog, exposure.
//
// Environment owns the clock. Each update() it derives every colour of the
// scene from the sun's elevation, pushes them into the sky shader, the lights,
// the fog, renderer.toneMappingExposure and materials.shared.

import * as THREE from 'three';
import { shared, NOISE_GLSL } from './materials.js';

// GLSL for the clear-sky colour in direction d. Exported because water.js uses
// the exact same function for its reflections and its distance fade — that is
// what makes the ocean's far edge vanish into the sky.
// Requires the uniforms declared in ATMOSPHERE_UNIFORMS_GLSL.
export const ATMOSPHERE_UNIFORMS_GLSL = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunDir;       // true sun direction (may be below the horizon)
uniform vec3 uMoonDir;
uniform vec3 uSunColor;     // colour of the sun's glow
uniform float uSunGlow;
uniform vec3 uSunsetColor;
uniform float uSunsetAmt;
uniform vec3 uMoonColor;
uniform float uMoonGlow;
`;
export const ATMOSPHERE_GLSL = /* glsl */ `
vec3 ntAtmosphere(vec3 d){
  d = normalize(vec3(d.x, max(d.y, 0.0), d.z));       // below the horizon = the horizon
  float y = d.y;
  vec3 col = mix(uHorizon, uZenith, pow(y, 0.40));
  float sd = max(dot(d, uSunDir), 0.0);
  float hz = pow(1.0 - y, 7.0);
  // dawn/dusk: orange belt hugging the horizon (strongest toward the sun) with a
  // pink/magenta "belt of Venus" above it that wraps the whole sky
  col += uSunsetColor * uSunsetAmt * hz * (0.25 + 0.75 * sd * sd);
  float belt = pow(1.0 - y, 3.5) * (1.0 - hz * 0.8);
  col += vec3(0.95, 0.12, 0.34) * uSunsetAmt * belt * (0.30 + 0.30 * sd);
  // Mie-like forward scattering around the sun
  col += uSunColor * uSunGlow * (0.14 * pow(sd, 6.0) + 0.40 * pow(sd, 40.0));
  float md = max(dot(d, uMoonDir), 0.0);
  col += uMoonColor * uMoonGlow * (0.05 * pow(md, 6.0) + 0.25 * pow(md, 90.0));
  return col;
}
`;

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main(){
  vDir = position;                      // dome is centred on the camera, never rotated
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p;
}`;

const SKY_FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;
${ATMOSPHERE_UNIFORMS_GLSL}
uniform float uNight;
uniform float uTime;
uniform float uCloudTime;
uniform float uCloudCover;
uniform vec3 uCloudLit;
uniform vec3 uCloudShade;
uniform vec3 uLightDir;      // dominant light (sun or moon) for cloud shading
uniform float uSunDisc;      // HDR brightness of the sun disc
uniform float uStarRot;
${NOISE_GLSL}
${ATMOSPHERE_GLSL}

vec3 rotY(vec3 v, float a){ float c = cos(a), s = sin(a); return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z); }

void main(){
  vec3 d = normalize(vDir);
  vec3 col = ntAtmosphere(d);
  float above = smoothstep(-0.01, 0.015, d.y);

  // ---------------- stars + milky band (night only) ----------------
  if (uNight > 0.02 && d.y > -0.02) {
    // slow rotation of the celestial sphere about a tilted axis
    vec3 sdir = rotY(vec3(d.x, d.y * 0.8 - d.z * 0.6, d.y * 0.6 + d.z * 0.8), uStarRot);
    vec3 sp = sdir * 150.0;
    vec3 ip = floor(sp);
    vec3 rnd = ntHash33(ip);
    float dist = length(fract(sp) - 0.5 - (rnd - 0.5) * 0.55);
    float mag = step(0.955, rnd.x) * (0.25 + 0.75 * fract(rnd.x * 97.0));
    float tw = 0.7 + 0.3 * sin(uTime * (1.5 + rnd.y * 3.0) + rnd.z * 60.0);
    float star = smoothstep(0.24, 0.0, dist) * mag * tw;
    vec3 starCol = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.85, 0.7), rnd.z);
    float band = exp(-pow(dot(sdir, normalize(vec3(0.35, 0.25, 0.9))) * 3.6, 2.0));
    float dust = ntFbm3(sdir.xy * 5.0 + sdir.z * 3.0);
    vec3 milky = vec3(0.10, 0.12, 0.20) * band * (0.35 + 0.9 * dust * dust);
    float vis = uNight * uNight * smoothstep(0.0, 0.25, d.y + 0.03);
    col += (starCol * star * 2.2 + milky * 0.55) * vis;
  }

  // ---------------- sun disc ----------------
  float sd = dot(d, uSunDir);
  float disc = smoothstep(0.99962, 0.99982, sd);
  col += uSunColor * uSunDisc * disc * above;
  col += uSunColor * uSunGlow * 0.35 * pow(max(sd, 0.0), 900.0) * above;   // tight corona

  // ---------------- moon ----------------
  float md = dot(d, uMoonDir);
  if (md > 0.999) {
    float mdisc = smoothstep(0.99972, 0.99984, md);
    // crude sphere coords on the disc for maria + limb darkening
    vec3 mx = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)));
    vec3 my = cross(mx, uMoonDir);
    vec2 mp = vec2(dot(d, mx), dot(d, my)) / 0.0236;
    float limb = sqrt(max(1.0 - dot(mp, mp), 0.0));
    float maria = ntFbm3(mp * 2.2 + 4.0);
    vec3 moonCol = vec3(0.95, 0.97, 1.0) * (0.55 + 0.45 * limb) * (0.62 + 0.5 * maria);
    col = mix(col, moonCol * 2.4 * uMoonGlow, mdisc * above * smoothstep(0.0, 0.25, uMoonGlow));
  }

  // ---------------- clouds ----------------
  if (d.y > 0.0 && uCloudCover > 0.01) {
    vec2 wind = vec2(0.011, 0.004) * uCloudTime;
    vec2 uv = d.xz / (d.y + 0.16) * 1.25 + wind;
    float n = ntFbm5(uv);
    float n2 = ntFbm3(uv * 3.1 - wind * 1.7);
    float shape = n + 0.30 * (n2 - 0.5);
    float cov = mix(0.78, 0.34, uCloudCover);
    float dens = smoothstep(cov, cov + 0.20, shape);
    if (dens > 0.001) {
      // cheap self-shadowing: compare density a step toward the light
      vec2 toL = uLightDir.xz - d.xz * (uLightDir.y / max(d.y, 0.05));
      toL = toL / (length(toL) + 1e-3);
      float nL = ntFbm3((uv + toL * 0.14) * 1.0) ;
      float nH = ntFbm3(uv);
      float light = clamp(0.60 + (nH - nL) * 3.4 + (n2 - 0.5) * 0.5, 0.0, 1.0);
      light = mix(light, 1.0, (1.0 - dens) * 0.5);            // thin edges are brighter
      vec3 cc = mix(uCloudShade, uCloudLit, light);
      // silver lining / sunset fire where thin cloud sits near the sun
      float sdc = max(sd, 0.0);
      cc += uSunColor * uSunGlow * (1.0 - dens) * (0.9 * pow(sdc, 10.0) + 0.25 * pow(sdc, 3.0));
      cc += uMoonColor * uMoonGlow * (1.0 - dens) * 0.5 * pow(max(md, 0.0), 12.0);
      // aerial perspective: far clouds sink into the horizon colour
      float haze = pow(1.0 - d.y, 5.0);
      cc = mix(cc, ntAtmosphere(vec3(d.x, 0.0, d.z)), haze * 0.8);
      float alpha = dens * smoothstep(0.015, 0.16, d.y) * 0.96;
      col = mix(col, cc, alpha);
    }
  }

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ---- colour ramps keyed on the sine of the sun's elevation ------------------
const C = (r, g, b) => new THREE.Color(r, g, b);
//            e:    night      dusk       horizon    golden     day
const STOPS = [-0.34, -0.12, 0.0, 0.14, 0.38];
const ZENITH = [C(0.004, 0.009, 0.030), C(0.016, 0.030, 0.130), C(0.030, 0.100, 0.300), C(0.022, 0.160, 0.400), C(0.028, 0.150, 0.560)];
const HORIZON = [C(0.014, 0.026, 0.066), C(0.170, 0.060, 0.190), C(0.560, 0.170, 0.075), C(0.500, 0.240, 0.140), C(0.300, 0.540, 0.850)];
const SUNLIGHT = [C(1.0, 0.34, 0.10), C(1.0, 0.34, 0.10), C(1.0, 0.38, 0.12), C(1.0, 0.60, 0.30), C(1.0, 0.95, 0.85)];
const CLOUD_LIT = [C(0.045, 0.060, 0.110), C(0.30, 0.10, 0.20), C(1.00, 0.30, 0.20), C(1.00, 0.46, 0.30), C(1.0, 1.0, 1.0)];
const CLOUD_SHADE = [C(0.008, 0.012, 0.028), C(0.040, 0.026, 0.085), C(0.14, 0.07, 0.20), C(0.20, 0.13, 0.30), C(0.44, 0.54, 0.72)];
const GROUND_BOUNCE = [C(0.012, 0.016, 0.03), C(0.05, 0.04, 0.06), C(0.16, 0.11, 0.09), C(0.2, 0.17, 0.14), C(0.2, 0.19, 0.17)];
const MOON_COLOR = C(0.55, 0.69, 1.0);

function ramp(table, e, out) {
  if (e <= STOPS[0]) return out.copy(table[0]);
  for (let i = 1; i < STOPS.length; i++) {
    if (e <= STOPS[i]) {
      let t = (e - STOPS[i - 1]) / (STOPS[i] - STOPS[i - 1]);
      t = t * t * (3 - 2 * t);
      return out.copy(table[i - 1]).lerp(table[i], t);
    }
  }
  return out.copy(table[table.length - 1]);
}
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

const SUNRISE = 5.75, SUNSET = 19.0;          // hours; 18.5 is a proper low-sun sunset
const SHADOW_HALF = 80, SHADOW_MAP = 2048, SHADOW_DIST = 220;
const DOME_RADIUS = 1900;

export class Environment {
  /**
   * @param {{scene:THREE.Scene, renderer:THREE.WebGLRenderer, timeOfDay?:number, dayLength?:number}} o
   */
  constructor({ scene, renderer, timeOfDay = 13, dayLength = 600 }) {
    this.scene = scene;
    this.renderer = renderer;
    this.dayLength = dayLength;           // real seconds per 24 h
    this.cloudCover = 0.45;               // 0 clear .. 1 overcast (read/write)
    this.paused = false;                  // freeze the clock (clouds keep drifting)
    this._time = ((timeOfDay % 24) + 24) % 24;
    this._elapsed = 0;

    this.night = 0;
    this.sunDirection = new THREE.Vector3(0, 1, 0);
    this.sunColor = new THREE.Color();
    this.skyColor = new THREE.Color();
    this.horizonColor = new THREE.Color();
    this.fogColor = new THREE.Color();
    this.lightIntensity = 0;              // 0..1 relative strength of the dominant light

    this._sunDir = new THREE.Vector3();
    this._moonDir = new THREE.Vector3();

    // shadows are part of the look; make sure they are on
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // -------- sky dome --------
    this.skyUniforms = {
      uZenith: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uSunDir: { value: this._sunDir },
      uMoonDir: { value: this._moonDir },
      uSunColor: { value: new THREE.Color() },
      uSunGlow: { value: 1 },
      uSunsetColor: { value: new THREE.Color(1.0, 0.33, 0.07) },
      uSunsetAmt: { value: 0 },
      uMoonColor: { value: MOON_COLOR.clone() },
      uMoonGlow: { value: 0 },
      uNight: shared.uNight,
      uTime: shared.uTime,
      uCloudTime: { value: 0 },
      uCloudCover: { value: this.cloudCover },
      uCloudLit: { value: new THREE.Color() },
      uCloudShade: { value: new THREE.Color() },
      uLightDir: { value: this.sunDirection },
      uSunDisc: { value: 20 },
      uStarRot: { value: 0 },
    };
    this.dome = new THREE.Mesh(
      new THREE.SphereGeometry(DOME_RADIUS, 48, 24),
      new THREE.ShaderMaterial({
        uniforms: this.skyUniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
        side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
      }),
    );
    this.dome.renderOrder = -1;
    this.dome.frustumCulled = false;
    this.dome.name = 'SkyDome';
    scene.add(this.dome);

    // -------- lights --------
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.name = 'SunMoonLight';
    this.sun.castShadow = true;
    const sh = this.sun.shadow;
    sh.mapSize.set(SHADOW_MAP, SHADOW_MAP);
    sh.camera.left = -SHADOW_HALF; sh.camera.right = SHADOW_HALF;
    sh.camera.top = SHADOW_HALF; sh.camera.bottom = -SHADOW_HALF;
    sh.camera.near = 1; sh.camera.far = SHADOW_DIST * 2;
    sh.camera.updateProjectionMatrix();
    sh.bias = -0.0005;
    sh.normalBias = 0.06;
    scene.add(this.sun, this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
    this.hemi.name = 'SkyLight';
    scene.add(this.hemi);

    this.fog = new THREE.FogExp2(0xffffff, 0.0011);
    scene.fog = this.fog;

    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._c = new THREE.Vector3();
    this._tmpColor = new THREE.Color();
    this._apply();
  }

  get timeOfDay() { return this._time; }
  set timeOfDay(h) { this._time = ((h % 24) + 24) % 24; this._apply(); }

  /** Recompute every derived value from the current time. */
  _apply() {
    const t = this._time;
    // sun angle: 0 at sunrise, PI at sunset, 2PI at next sunrise
    let ang;
    if (t >= SUNRISE && t < SUNSET) ang = ((t - SUNRISE) / (SUNSET - SUNRISE)) * Math.PI;
    else ang = Math.PI + ((((t - SUNSET) + 24) % 24) / (24 - (SUNSET - SUNRISE))) * Math.PI;
    const tilt = 0.52;                      // arc leans toward +Z so shadows are never dead vertical
    const sx = Math.cos(ang), sv = Math.sin(ang);
    this._sunDir.set(sx, sv * Math.cos(tilt), sv * Math.sin(tilt) + 0.18).normalize();
    // moon: opposite side of the sky on its own slightly different arc
    this._moonDir.set(-sx * 0.9 + 0.2, -sv * Math.cos(0.35), sv * Math.sin(0.35) - 0.3).normalize();

    const e = this._sunDir.y;
    this.night = 1 - sstep(-0.26, 0.12, e);
    const u = this.skyUniforms;

    ramp(ZENITH, e, this.skyColor);
    ramp(HORIZON, e, this.horizonColor);
    u.uZenith.value.copy(this.skyColor);
    u.uHorizon.value.copy(this.horizonColor);
    ramp(SUNLIGHT, e, u.uSunColor.value);
    ramp(CLOUD_LIT, e, u.uCloudLit.value);
    ramp(CLOUD_SHADE, e, u.uCloudShade.value);
    u.uSunGlow.value = sstep(-0.14, 0.04, e) * lerp(0.75, 0.38, sstep(0.0, 0.5, e));
    u.uSunsetAmt.value = sstep(-0.3, -0.03, e) * (1 - sstep(0.03, 0.32, e)) * 0.5;
    u.uSunDisc.value = lerp(3.5, 22, sstep(0.0, 0.4, e));
    const moonUp = sstep(-0.05, 0.12, this._moonDir.y);
    u.uMoonGlow.value = sstep(0.1, -0.2, e) * moonUp;
    u.uCloudCover.value = this.cloudCover;
    u.uStarRot.value = (t / 24) * Math.PI * 2;

    // ---- dominant light: the sun, handing over to the moon just after sunset.
    // Both fade through zero at the hand-over so the direction swap is invisible.
    const SWITCH = -0.07;
    let intensity;
    if (e > SWITCH) {
      this.sunDirection.copy(this._sunDir);
      const k = sstep(SWITCH, 0.16, e);
      this.lightIntensity = k;
      intensity = 3.1 * k;
      this.sunColor.copy(u.uSunColor.value);
    } else {
      this.sunDirection.copy(this._moonDir);
      const k = sstep(SWITCH, -0.3, e) * (0.25 + 0.75 * moonUp);
      this.lightIntensity = k * 0.2;
      intensity = 0.5 * k;
      this.sunColor.copy(MOON_COLOR);
    }
    // keep the light from going fully horizontal (endless shadows / acne)
    if (this.sunDirection.y < 0.09) { this.sunDirection.y = 0.09; this.sunDirection.normalize(); }
    this.sun.color.copy(this.sunColor);
    this.sun.intensity = intensity;
    this.sun.castShadow = intensity > 0.02;

    // ---- ambient: sky from above, warm/dark bounce from below ----
    this.hemi.color.copy(this.skyColor).lerp(this.horizonColor, 0.55);
    ramp(GROUND_BOUNCE, e, this.hemi.groundColor);
    // normalise so ambient never collapses at night: night stays readable and blue
    const hl = Math.max(this.hemi.color.r, this.hemi.color.g, this.hemi.color.b, 1e-3);
    const amb = lerp(0.2, 0.95, 1 - this.night);       // target peak ambient radiance
    this.hemi.color.multiplyScalar(amb / hl);
    this.hemi.groundColor.multiplyScalar(lerp(2.0, 1.0, 1 - this.night));
    this.hemi.intensity = lerp(1.0, 1.15, sstep(0.0, 0.4, e));

    // ---- fog: horizon colour, a little denser in the blue hours ----
    this.fogColor.copy(this.horizonColor).lerp(this.skyColor, 0.12);
    this.fogColor.lerp(this._tmpColor.copy(u.uSunsetColor.value).multiplyScalar(0.5), u.uSunsetAmt.value * 0.18);
    this.fog.color.copy(this.fogColor);
    this.fog.density = lerp(0.00095, 0.0012, this.night);

    // ---- exposure: open up a touch at night, hold back the bright midday ----
    this.renderer.toneMappingExposure = lerp(0.95, 1.12, this.night);

    // ---- shared material uniforms ----
    shared.uNight.value = this.night;
    shared.uSkyColor.value.copy(this.skyColor);
    shared.uHorizonColor.value.copy(this.horizonColor);
    shared.uSunDir.value.copy(this.sunDirection);
    shared.uSunColor.value.copy(this.sunColor).multiplyScalar(this.lightIntensity);
  }

  /**
   * @param {number} dt seconds
   * @param {THREE.Vector3} focus point the action is centred on (shadow frustum follows it)
   * @param {THREE.Camera} camera
   */
  update(dt, focus, camera) {
    this._elapsed += dt;
    if (!this.paused && this.dayLength > 0) this._time = (this._time + (dt * 24) / this.dayLength) % 24;
    shared.uTime.value = this._elapsed;
    this.skyUniforms.uCloudTime.value = this._elapsed;
    this._apply();

    if (camera) {
      this.dome.position.copy(camera.position);
      this.dome.updateMatrixWorld();
    }

    // ---- shadow frustum: centred on focus, snapped to whole shadow texels in light space ----
    const d = this.sunDirection;
    const right = this._right.set(0, 1, 0).cross(d);
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    const up = this._up.crossVectors(d, right).normalize();
    const texel = (SHADOW_HALF * 2) / SHADOW_MAP;
    const f = focus || this._c.set(0, 0, 0);
    const fx = Math.round(f.dot(right) / texel) * texel;
    const fy = Math.round(f.dot(up) / texel) * texel;
    const fz = f.dot(d);
    const cx = right.x * fx + up.x * fy + d.x * fz;
    const cy = right.y * fx + up.y * fy + d.y * fz;
    const cz = right.z * fx + up.z * fy + d.z * fz;
    this.sun.target.position.set(cx, cy, cz);
    this.sun.position.set(cx + d.x * SHADOW_DIST, cy + d.y * SHADOW_DIST, cz + d.z * SHADOW_DIST);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
  }
}
