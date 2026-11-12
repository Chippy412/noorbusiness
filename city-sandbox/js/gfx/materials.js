// materials.js — procedural, texture-free materials for Neon Tide.
//
// Everything here is driven by world-space position, so any geometry (boxes,
// cylinders, big merged planes) gets consistent detail without UVs.
// All lit materials are MeshStandardMaterial + onBeforeCompile, which keeps
// Three's lighting, shadows, fog and tone mapping fully intact.
//
// `shared` is ONE uniforms object referenced by every material in the game.
// sky.js (Environment.update) writes to it once per frame.

import * as THREE from 'three';

export const shared = {
  uTime: { value: 0 },                                   // seconds
  uNight: { value: 0 },                                  // 0 day .. 1 deep night
  // Extras (also maintained by Environment) used for fake glass reflections:
  uSkyColor: { value: new THREE.Color(0.07, 0.2, 0.58) },
  uHorizonColor: { value: new THREE.Color(0.42, 0.6, 0.85) },
  uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() }, // toward dominant light
  uSunColor: { value: new THREE.Color(1, 0.95, 0.86) },  // dominant light colour * relative strength
};

// ---------------------------------------------------------------------------
// Shared GLSL: hashes + value noise + fbm (prefixed `nt` to avoid clashing with
// Three's own chunks). Exported so sky.js / water.js reuse the same functions.
// ---------------------------------------------------------------------------
export const NOISE_GLSL = /* glsl */ `
float ntHash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float ntHash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float ntHash13(vec3 p3){ p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec3  ntHash33(vec3 p3){ p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }
float ntNoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = ntHash12(i), b = ntHash12(i + vec2(1.0, 0.0));
  float c = ntHash12(i + vec2(0.0, 1.0)), d = ntHash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
const mat2 NT_ROT = mat2(0.8, -0.6, 0.6, 0.8);
float ntFbm3(vec2 p){
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * ntNoise(p); p = NT_ROT * p * 2.03 + 17.1; a *= 0.5; }
  return s / 0.875;
}
float ntFbm5(vec2 p){
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * ntNoise(p); p = NT_ROT * p * 2.03 + 17.1; a *= 0.5; }
  return s / 0.96875;
}
`;

// World position / normal / object origin varyings, injected into the
// standard vertex shader (instancing aware).
const VERT_DECL = /* glsl */ `
varying vec3 vNtWorldPos;
varying vec3 vNtWorldNormal;
varying vec3 vNtOrigin;
`;
const VERT_MAIN = /* glsl */ `
{
  mat4 ntM = modelMatrix;
  #ifdef USE_INSTANCING
    ntM = modelMatrix * instanceMatrix;
  #endif
  vNtWorldPos = (ntM * vec4(transformed, 1.0)).xyz;
  vNtWorldNormal = normalize(mat3(ntM) * objectNormal);
  vNtOrigin = ntM[3].xyz;
}
`;

function injectVertex(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\n' + VERT_DECL)
    .replace('#include <project_vertex>', '#include <project_vertex>\n' + VERT_MAIN);
}

function linkShared(shader) {
  for (const k in shared) shader.uniforms[k] = shared[k];
}

const FRAG_DECL = /* glsl */ `
uniform float uTime;
uniform float uNight;
uniform vec3 uSkyColor;
uniform vec3 uHorizonColor;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
varying vec3 vNtWorldPos;
varying vec3 vNtWorldNormal;
varying vec3 vNtOrigin;
` + NOISE_GLSL;

// ---------------------------------------------------------------------------
// BUILDINGS
// ---------------------------------------------------------------------------
const BUILDING_FRAG_DECL = FRAG_DECL + /* glsl */ `
uniform float uSeed;

// Anti-aliased axis-aligned box mask. p: centred coords (m), h: half size, fw: pixel footprint.
float ntBox(vec2 p, vec2 h, vec2 fw){
  vec2 d = (h - abs(p)) / max(fw, vec2(1e-4)) + 0.5;
  return clamp(d.x, 0.0, 1.0) * clamp(d.y, 0.0, 1.0);
}
// Cheap sky lookup for fake glass reflections (no env map needed).
vec3 ntSkyReflect(vec3 r){
  float y = r.y;
  vec3 sky = mix(uHorizonColor, uSkyColor, pow(clamp(y, 0.0, 1.0), 0.5));
  // below the horizon the glass mirrors the (darker) city / ground
  vec3 ground = uHorizonColor * vec3(0.20, 0.21, 0.24);
  vec3 c = mix(ground, sky, smoothstep(-0.08, 0.06, y));
  float sd = max(dot(r, uSunDir), 0.0);
  c += uSunColor * (0.10 * pow(sd, 12.0) + 2.5 * pow(sd, 350.0));
  return c;
}
vec3 ntAccent(float h){ return 0.55 + 0.45 * cos(6.2832 * (h + vec3(0.0, 0.33, 0.67))); }
`;

// Runs right after <color_fragment>; leaves results in nt* locals that the
// later chunk patches (roughness / metalness / emissive) pick up.
const BUILDING_FRAG_MAIN = /* glsl */ `
vec3 ntN = normalize(vNtWorldNormal);
vec3 ntWall = diffuseColor.rgb;
vec3 ntAlbedo = ntWall;
float ntRough = 0.86;
float ntMetal = 0.0;
vec3 ntEmissive = vec3(0.0);
{
  vec3 wp = vNtWorldPos;
  vec3 V = normalize(cameraPosition - wp);
  float s1 = ntHash12(vec2(uSeed, 1.7)), s2 = ntHash12(vec2(uSeed, 5.3)), s3 = ntHash12(vec2(uSeed, 9.1));

  if (ntN.y > 0.5) {
    // ---- roof: darker, gravel-ish noise, a few stains ----
    float n = ntFbm3(wp.xz * 0.35 + uSeed);
    float g = ntNoise(wp.xz * 9.0);
    ntAlbedo = mix(vec3(0.085, 0.088, 0.095), ntWall * 0.32, 0.35) * (0.75 + 0.4 * n) * (0.9 + 0.2 * g);
    ntRough = 0.95;
  } else if (ntN.y > -0.5) {
    // ---- facade parameterisation ------------------------------------------
    // u runs horizontally along the wall, v is height above ground (y = 0).
    // For flat faces dot(rel, tangent) is exact for any yaw; for cylinders
    // (origin on the axis) that term is 0 and the angular term supplies the
    // arc length, snapped so a whole number of windows wraps the tower.
    #if NT_STYLE == 0
      float cellW = 2.8 + 1.0 * s1;  float floorH = 3.3 + 0.4 * s2;
      float winW = cellW * (0.60 + 0.2 * s3);  float winH = floorH * 0.56;
      const float litFrac = 0.46;
    #elif NT_STYLE == 1
      float cellW = 3.4 + 1.2 * s1;  float floorH = 3.0 + 0.2 * s2;
      float winW = 1.25 + 0.5 * s3;  float winH = 1.45;
      const float litFrac = 0.56;
    #else
      float cellW = 1.7 + 0.8 * s1;  float floorH = 3.5 + 0.4 * s2;
      float winW = cellW - 0.12;     float winH = floorH - 0.95;
      const float litFrac = 0.50;
    #endif
    vec2 nh = normalize(ntN.xz);
    vec2 tng = vec2(-nh.y, nh.x);
    vec2 rel = wp.xz - vNtOrigin.xz;
    float faceR = abs(dot(rel, nh));
    float wrapCells = max(1.0, floor(6.2832 * faceR / cellW + 0.5));
    // angle measured in a rotated frame so the atan seam never sits on an axis-aligned face
    float th = atan(nh.y * 0.8 - nh.x * 0.6, nh.x * 0.8 + nh.y * 0.6);
    float u = dot(rel, tng) + th / 6.2832 * wrapCells * cellW;
    float v = wp.y;
    vec2 fw = fwidth(vec2(u, v));
    // footprint spikes on face edges / the atan seam: clamp so AA stays sane
    fw = min(fw, vec2(cellW, floorH));
    float faceId = floor(th * 0.6366 + 0.5);

    // wall base: vertical grime streaks + soft blotches, darker near the pavement
    float grime = ntNoise(vec2(u * 0.9, v * 0.08) + uSeed);
    float blot = ntFbm3(vec2(u, v) * 0.12 + uSeed * 3.1);
    ntWall *= 0.84 + 0.2 * blot + 0.08 * grime;
    ntWall *= 0.82 + 0.18 * smoothstep(0.0, 5.0, v);
    ntAlbedo = ntWall;

    const float groundH = 4.2;
    #if NT_STYLE == 1
      float shop = step(0.45, s3);     // only some residential blocks have shops
    #else
      float shop = 1.0;
    #endif
    float glass = 0.0;        // 1 on window panes
    float frame = 0.0;        // 1 on frames / mullions
    float lit = 0.0;          // 0..1 window is lit
    vec3 litCol = vec3(0.0);
    float interior = 1.0;     // brightness modulation inside a lit window
    float blind = 0.0;        // day-time blinds drawn
    float hCell = 0.5;

    if (v < groundH && shop > 0.5) {
      // ---- ground floor: storefront glazing, sign band, plinth ----
      float sw = cellW * 2.0;
      float cu = (fract(u / sw) - 0.5) * sw;
      float idu = floor(u / sw);
      hCell = ntHash13(vec3(idu, faceId, uSeed + 7.0));
      vec2 p = vec2(cu, v - 1.75);
      float outer = ntBox(p, vec2(sw * 0.5 - 0.28, 1.3), fw);
      float inner = ntBox(p, vec2(sw * 0.5 - 0.36, 1.22), fw);
      float mull = 1.0 - ntBox(vec2(abs(cu) - sw * 0.17, 0.0), vec2(0.035, 9.0), fw);
      glass = inner * mull;
      frame = outer - glass;
      // sign band above the glazing, accent colour per building
      float band = ntBox(vec2(0.0, v - 3.62), vec2(9.0, 0.34), fw);
      vec3 acc = ntAccent(s1 + hCell * 0.15);
      float signOn = step(0.35, hCell);
      ntAlbedo = mix(ntAlbedo, mix(vec3(0.05), acc * 0.5, signOn), band);
      ntEmissive += acc * acc * band * signOn * 2.6 * smoothstep(0.2, 0.55, uNight)
                  * (0.85 + 0.15 * sin(uTime * 2.3 + hCell * 40.0));
      // plinth
      float plinth = 1.0 - smoothstep(0.42 - fw.y, 0.42 + fw.y, v);
      ntAlbedo = mix(ntAlbedo, vec3(0.045, 0.045, 0.05), plinth);
      lit = step(hCell, 0.85) * smoothstep(0.15, 0.4, uNight);
      litCol = mix(vec3(1.0, 0.80, 0.50), vec3(0.62, 0.90, 1.0), step(0.6, hCell));
      interior = 0.65 + 0.35 * ntNoise(vec2(u * 1.3, v * 2.0 + hCell * 9.0));
      interior *= 0.55 + 0.45 * smoothstep(0.5, 2.6, v);
    } else {
      // ---- upper floors: regular window grid ----
      float vv = v - groundH * shop;
      float idu = floor(u / cellW);
      float idv = floor(vv / floorH);
      float cu = (fract(u / cellW) - 0.5) * cellW;
      float cv = (fract(vv / floorH) - 0.5) * floorH;
      hCell = ntHash13(vec3(idu, idv, faceId * 13.0 + uSeed));
      float hFloor = ntHash13(vec3(idv, faceId, uSeed + 3.0));
      float h2 = fract(hCell * 57.31);
      float h3 = fract(hCell * 113.7);

      #if NT_STYLE == 0
        // office: wide ribbon windows, lighter pilasters, darker spandrels
        vec2 p = vec2(cu, cv - floorH * 0.04);
        float outer = ntBox(p, vec2(winW, winH) * 0.5 + 0.07, fw);
        float inner = ntBox(p, vec2(winW, winH) * 0.5, fw);
        float mull = 1.0 - ntBox(vec2(cu, 0.0), vec2(0.03, 9.0), fw);
        glass = inner * mull;
        frame = outer - glass;
        float pil = ntBox(vec2(abs(cu) - cellW * 0.5, 0.0), vec2(0.16, 9.0), fw);
        ntAlbedo = mix(ntAlbedo * 0.80, ntWall * 1.12, pil);
        float slab = ntBox(vec2(0.0, abs(cv) - floorH * 0.5), vec2(9.0, 0.09), fw);
        ntAlbedo = mix(ntAlbedo, ntWall * 0.6, slab * 0.7);
        float litKey = mix(hCell, hFloor, 0.55);
        litCol = mix(vec3(0.58, 0.82, 1.0), vec3(1.0, 0.74, 0.40), step(0.5, fract(hFloor * 17.3 + h2 * 0.35)));
      #elif NT_STYLE == 1
        // residential: punched windows with trim + sill, faint course lines
        vec2 p = vec2(cu, cv + 0.05);
        float outer = ntBox(p, vec2(winW, winH) * 0.5 + 0.09, fw);
        float inner = ntBox(p, vec2(winW, winH) * 0.5, fw);
        float cross = 1.0 - max(ntBox(vec2(cu, 0.0), vec2(0.025, 9.0), fw),
                                ntBox(vec2(0.0, p.y - winH * 0.18), vec2(9.0, 0.025), fw));
        glass = inner * cross;
        frame = 0.0;
        float trim = outer - inner;
        float sill = ntBox(vec2(cu, p.y + winH * 0.5 + 0.12), vec2(winW * 0.5 + 0.2, 0.06), fw);
        float course = 0.5 + 0.5 * sin(v * 6.2832 / 0.42);
        float courseFade = 1.0 - smoothstep(0.08, 0.2, fw.y);
        ntAlbedo *= 1.0 - 0.07 * smoothstep(0.75, 1.0, course) * courseFade;
        ntAlbedo = mix(ntAlbedo, vec3(0.62, 0.60, 0.56), max(trim, sill) * 0.9);
        ntAlbedo = mix(ntAlbedo, vec3(0.5), (inner - glass) * 0.9);
        float slab = ntBox(vec2(0.0, abs(cv) - floorH * 0.5), vec2(9.0, 0.05), fw);
        ntAlbedo = mix(ntAlbedo, ntWall * 0.7, slab * 0.5);
        float litKey = hCell;
        litCol = mix(vec3(1.0, 0.74, 0.40), vec3(1.0, 0.88, 0.68), h2);
        // a few TV rooms: cold, flickering
        float tv = step(0.86, h3);
        litCol = mix(litCol, vec3(0.45, 0.62, 1.0) * (0.55 + 0.45 * ntNoise(vec2(uTime * 3.0, hCell * 91.0))), tv);
      #else
        // glass tower: curtain wall, thin mullions, opaque spandrel band
        vec2 p = vec2(cu, cv + 0.3);
        glass = ntBox(p, vec2(winW, winH) * 0.5, fw);
        frame = 0.0;
        float mull = 1.0 - ntBox(vec2(cu, 0.0), vec2(cellW * 0.5 - 0.06, 9.0), fw);
        // spandrel = tinted opaque glass, mullions = dark metal
        ntAlbedo = mix(ntWall * 0.22 + vec3(0.01, 0.014, 0.02), vec3(0.035), mull);
        ntRough = mix(0.28, 0.5, mull);
        ntMetal = 0.35;
        float litKey = mix(hCell, hFloor, 0.7);
        litCol = mix(vec3(0.50, 0.84, 1.0), vec3(1.0, 0.72, 0.40), step(0.55, fract(hFloor * 31.7)));
      #endif

      // a sprinkle of neon-tinted rooms (magenta / cyan / violet) for the night skyline
      litCol = mix(litCol, ntAccent(h3 * 7.0) * vec3(1.0, 0.75, 1.0) + vec3(0.15, 0.0, 0.2), step(0.9, fract(h2 * 9.7)));
      // which windows are on, and when they switch on as dusk falls
      float thr = 0.22 + 0.5 * h2;
      lit = step(litKey, litFrac) * smoothstep(thr, thr + 0.12, uNight);
      // slow flicker on a few
      lit *= 1.0 - step(0.94, h3) * (0.3 + 0.3 * sin(uTime * (1.0 + h2 * 3.0) + hCell * 50.0));
      // fake interior: ceiling-bright top, furniture shadow at the bottom, partly drawn blinds
      float py = (cv + (floorH - winH) * 0.0) / max(winH * 0.5, 0.01);
      float blindH = mix(1.2, -0.2, h2 * h2);
      float curtain = smoothstep(blindH - 0.05, blindH + 0.05, py);
      interior = (0.72 + 0.28 * clamp(py, -1.0, 1.0)) * mix(1.0, 0.55, curtain);
      interior *= 0.75 + 0.25 * ntNoise(vec2(u * 2.1, v * 1.7) + hCell * 20.0);
      interior *= 0.6 + 0.8 * h3;
      blind = step(0.72, h3) * smoothstep(0.1 - fw.y, 0.1 + fw.y, cv + winH * (h2 - 0.5));
    }

    // ---- compose glass / frame ----
    ntAlbedo = mix(ntAlbedo, vec3(0.03, 0.032, 0.036), frame);
    ntRough = mix(ntRough, 0.45, frame);
    vec3 glassAlb = mix(vec3(0.012, 0.02, 0.03), vec3(0.42, 0.40, 0.35), blind * 0.85);
    ntAlbedo = mix(ntAlbedo, glassAlb, glass);
    ntRough = mix(ntRough, mix(0.08, 0.7, blind), glass);
    ntMetal = mix(ntMetal, 0.0, glass);

    // fake sky reflection: every pane is tilted a hair, like real glazing
    vec3 pn = normalize(ntN + (vec3(tng.x, 0.0, tng.y) * (hCell - 0.5) + vec3(0.0, fract(hCell * 7.7) - 0.5, 0.0)) * 0.07);
    float ndv = max(dot(pn, V), 0.0);
    #if NT_STYLE == 2
      float fres = 0.22 + 0.78 * pow(1.0 - ndv, 4.0);
    #else
      float fres = 0.10 + 0.90 * pow(1.0 - ndv, 4.0);
    #endif
    vec3 refl = ntSkyReflect(reflect(-V, pn));
    ntEmissive += refl * fres * glass * (1.0 - 0.8 * blind) * (1.0 - 0.6 * lit);

    // lit interiors go to emissive so bloom catches them
    ntEmissive += litCol * litCol * interior * lit * glass * 1.5;
  }
}
diffuseColor.rgb = ntAlbedo;
`;

/**
 * Procedural facade material.
 * @param {{color:number, seed:number, style?:number}} opts  style: 0 office grid, 1 residential, 2 glass tower
 * Notes: one program per style (shared via customProgramCacheKey); colour + seed are uniforms.
 * Cylindrical buildings should be their own mesh/instance with the origin on the axis.
 */
export function createBuildingMaterial({ color = 0x9aa3ad, seed = 0, style = 0 } = {}) {
  const st = Math.max(0, Math.min(2, style | 0));
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.86, metalness: 0 });
  const uSeed = { value: (Math.abs(seed) % 1000) + 0.37 };
  mat.userData.uSeed = uSeed;
  mat.defines = { ...(mat.defines || {}), NT_STYLE: st };
  mat.onBeforeCompile = (shader) => {
    linkShared(shader);
    shader.uniforms.uSeed = uSeed;
    injectVertex(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + BUILDING_FRAG_DECL)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + BUILDING_FRAG_MAIN)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = ntRough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = ntMetal;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += ntEmissive;');
  };
  mat.customProgramCacheKey = () => 'nt-building-' + st;
  return mat;
}

// ---------------------------------------------------------------------------
// GROUND
// ---------------------------------------------------------------------------
const GROUND_KINDS = { asphalt: 0, sidewalk: 1, grass: 2, sand: 3, plaza: 4, concrete: 5, wood: 6 };

const GROUND_FRAG_DECL = FRAG_DECL + /* glsl */ `
// Anti-aliased grid lines: returns 1 on a line of half-width w for a grid of period c.
// Fades to the line's average coverage when the grid gets sub-pixel (no moire).
float ntGrid(vec2 p, vec2 c, float w, vec2 fw){
  vec2 q = abs(fract(p / c - 0.5) - 0.5) * c;          // distance to nearest line
  vec2 l = 1.0 - smoothstep(vec2(w) - fw, vec2(w) + fw, q);
  float m = max(l.x, l.y);
  float fade = smoothstep(0.2, 0.6, max(fw.x / c.x, fw.y / c.y));
  return mix(m, 2.0 * w * (1.0 / c.x + 1.0 / c.y) * 0.5, fade);
}
`;

const GROUND_FRAG_MAIN = /* glsl */ `
vec3 ntAlbedo = diffuseColor.rgb;
float ntRough = 0.9;
{
  vec2 p = vNtWorldPos.xz;
  vec2 fw = fwidth(p);
  float px = max(fw.x, fw.y);                       // metres per pixel
  float fine = 1.0 - smoothstep(0.03, 0.25, px);    // fade for cm-scale detail
  float mid = 1.0 - smoothstep(0.3, 2.0, px);       // fade for m-scale detail
  float big = ntFbm3(p * 0.045);                    // 20 m blotches
  float med = ntFbm3(p * 0.4 + 31.0);
  float grain = ntHash12(floor(p * 40.0)) * 0.6 + ntNoise(p * 14.0) * 0.4;

  #if NT_KIND == 0
    // ---- asphalt: fine aggregate, resurfaced patches, tar seams, wet sheen at night ----
    vec3 c = vec3(0.050, 0.051, 0.057) * ntAlbedo * 12.0;
    c *= 0.78 + 0.36 * big;
    c *= 1.0 + (grain - 0.5) * 0.5 * fine;
    vec2 pc = floor(p / vec2(7.0, 5.0));
    float patch_ = step(0.84, ntHash12(pc + 3.0));
    vec2 pf = abs(fract(p / vec2(7.0, 5.0)) - 0.5);
    float inPatch = patch_ * smoothstep(0.42, 0.40, max(pf.x, pf.y));
    c = mix(c, c * 0.68, inPatch * mid);
    float crack = smoothstep(0.035, 0.0, abs(ntNoise(p * 0.55 + 7.0) - 0.5)) * step(0.55, med);
    c *= 1.0 - 0.35 * crack * fine;
    float wet = uNight * (0.45 + 0.55 * smoothstep(0.35, 0.7, ntFbm3(p * 0.12 + 5.0)));
    c *= 1.0 - 0.15 * wet;
    ntAlbedo = c;
    ntRough = mix(0.93, 0.28, wet * 0.9) + (grain - 0.5) * 0.12 * fine;
  #elif NT_KIND == 1
    // ---- sidewalk: paving slabs with per-slab tint and dark joints ----
    const vec2 slab = vec2(1.2, 1.2);
    vec2 id = floor(p / slab);
    float h = ntHash12(id);
    vec3 c = vec3(0.34, 0.335, 0.32) * ntAlbedo * 2.6;
    c *= 0.88 + 0.2 * h * mid + 0.1 * big;
    c *= 1.0 + (grain - 0.5) * 0.18 * fine;
    c *= 1.0 - 0.12 * smoothstep(0.55, 0.85, med) * mid;        // stains
    float g = ntGrid(p, slab, 0.018, fw);
    c *= 1.0 - 0.55 * g;
    ntAlbedo = c;
    ntRough = 0.88 - 0.25 * uNight * smoothstep(0.4, 0.8, big);
  #elif NT_KIND == 2
    // ---- grass: two-tone noise, mown stripes, blade-scale speckle ----
    vec3 c1 = vec3(0.045, 0.16, 0.03), c2 = vec3(0.12, 0.25, 0.045);
    float n = ntFbm3(p * 0.09 + 11.0);
    vec3 c = mix(c1, c2, smoothstep(0.25, 0.75, n)) * ntAlbedo * 2.2;
    float stripe = smoothstep(-0.25, 0.25, sin((p.x * 0.8 + p.y * 0.6) * 3.14159 / 3.5));
    c *= mix(0.86, 1.1, mix(0.5, stripe, mid));
    float blade = ntNoise(p * vec2(22.0, 31.0)) * 0.6 + ntNoise(p * 7.0) * 0.4;
    c *= 1.0 + (blade - 0.5) * 0.55 * fine;
    c = mix(c, vec3(0.2, 0.19, 0.07) * ntAlbedo * 2.2, smoothstep(0.72, 0.9, med) * 0.35);    // dry patches
    ntAlbedo = c;
    ntRough = 0.95;
  #elif NT_KIND == 3
    // ---- sand: wind ripples, sparkle, damp darkening toward the waterline ----
    vec3 c = vec3(0.74, 0.60, 0.40) * ntAlbedo * 1.55;
    vec2 w = p + 2.5 * vec2(ntNoise(p * 0.13), ntNoise(p * 0.13 + 40.0));
    float rip = sin(w.x * 5.2 + w.y * 2.1 + 3.0 * ntNoise(p * 0.5));
    c *= 1.0 + 0.07 * rip * fine;
    c *= 0.86 + 0.24 * big;
    c *= 1.0 + (grain - 0.5) * 0.2 * fine;
    float damp = 1.0 - smoothstep(-0.55, 0.15, vNtWorldPos.y + (med - 0.5) * 0.15);
    c *= mix(1.0, 0.55, damp);
    ntAlbedo = c;
    ntRough = mix(0.96, 0.35, damp);
  #elif NT_KIND == 4
    // ---- plaza: large stone tiles, two tones, inlaid border lines ----
    const vec2 tile = vec2(2.0, 2.0);
    vec2 id = floor(p / tile);
    float chk = mod(id.x + id.y, 2.0);
    float h = ntHash12(id + 9.0);
    vec3 c = mix(vec3(0.40, 0.35, 0.29), vec3(0.30, 0.275, 0.25), chk * mid + 0.5 * (1.0 - mid)) * ntAlbedo * 2.2;
    c *= 0.92 + 0.14 * h * mid + 0.08 * big;
    vec2 q = abs(fract(p / tile) - 0.5);
    float inlay = smoothstep(0.03, 0.0, abs(max(q.x, q.y) - 0.36)) * fine;
    c = mix(c, c * 0.72, inlay);
    c *= 1.0 + (grain - 0.5) * 0.12 * fine;
    c *= 1.0 - 0.6 * ntGrid(p, tile, 0.012, fw);
    ntAlbedo = c;
    ntRough = 0.62 - 0.25 * uNight * smoothstep(0.3, 0.7, big);
  #elif NT_KIND == 5
    // ---- concrete: cast panels, expansion joints, water stains ----
    vec3 c = vec3(0.30, 0.30, 0.295) * ntAlbedo * 2.6;
    c *= 0.84 + 0.26 * big;
    c *= 1.0 - 0.16 * smoothstep(0.5, 0.85, med) * mid;
    c *= 1.0 + (grain - 0.5) * 0.22 * fine;
    c *= 1.0 - 0.45 * ntGrid(p, vec2(4.0, 4.0), 0.02, fw);
    ntAlbedo = c;
    ntRough = 0.9;
  #else
    // ---- wood: pier planks (run along X, 0.24 m wide), staggered butt joints, grain ----
    const float pw = 0.24;
    float row = floor(p.y / pw);
    float h = ntHash11(row + 13.0);
    float x = p.x + h * 7.0;
    float seg = floor(x / 3.2);
    float h2 = ntHash12(vec2(row, seg));
    vec3 c = mix(vec3(0.20, 0.115, 0.055), vec3(0.34, 0.22, 0.12), h2 * mid + 0.5 * (1.0 - mid)) * ntAlbedo * 2.6;
    float gr = ntNoise(vec2(x * 1.5, p.y * 60.0) + h2 * 30.0);
    c *= 1.0 + (gr - 0.5) * 0.4 * fine;
    c *= 0.9 + 0.2 * big;
    float gapZ = abs(fract(p.y / pw) - 0.5) * pw;                 // distance from plank centre
    float gap = smoothstep(pw * 0.5 - 0.012 - fw.y, pw * 0.5 - 0.012 + fw.y, gapZ);
    float endD = abs(fract(x / 3.2) - 0.5) * 3.2;
    float endGap = smoothstep(1.6 - 0.012 - fw.x, 1.6 - 0.012 + fw.x, endD);
    float lod = 1.0 - smoothstep(0.08, 0.3, px);
    c *= 1.0 - 0.75 * max(gap, endGap) * lod - 0.1 * (1.0 - lod);
    ntAlbedo = c;
    ntRough = 0.8;
  #endif
}
diffuseColor.rgb = ntAlbedo;
`;

/**
 * World-space procedural ground material.
 * @param {'asphalt'|'sidewalk'|'grass'|'sand'|'plaza'|'concrete'|'wood'} kind
 * @param {{tint?:number}} [opts] optional multiplicative tint (default white)
 */
export function createGroundMaterial(kind = 'asphalt', opts = {}) {
  const k = GROUND_KINDS[kind] ?? GROUND_KINDS.concrete;
  // base colour is mid-grey-normalised inside the shader; `color` acts as a tint
  const tint = new THREE.Color(opts.tint ?? 0xffffff);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 });
  mat.color.setRGB(TINT_NORM[k] * tint.r, TINT_NORM[k] * tint.g, TINT_NORM[k] * tint.b);
  mat.defines = { ...(mat.defines || {}), NT_KIND: k };
  mat.onBeforeCompile = (shader) => {
    linkShared(shader);
    injectVertex(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GROUND_FRAG_DECL)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + GROUND_FRAG_MAIN)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(ntRough, 0.05, 1.0);');
  };
  mat.customProgramCacheKey = () => 'nt-ground-' + k;
  return mat;
}
// The shader multiplies its palette by (tint * N); these are 1/N so white tint = palette as authored.
const TINT_NORM = [1 / 12, 1 / 2.6, 1 / 2.2, 1 / 1.55, 1 / 2.2, 1 / 2.6, 1 / 2.6];

// ---------------------------------------------------------------------------
// EMISSIVE / FX MATERIALS
// ---------------------------------------------------------------------------

/** Street-lamp bulb / car light: dark glass by day, strongly emissive at night. */
export function createLampMaterial(color = 0xffd9a0) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0x30302e, roughness: 0.25, metalness: 0.0,
    emissive: color, emissiveIntensity: 4.0,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = shared.uNight;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;')
      .replace('#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= smoothstep(0.18, 0.5, uNight);');
  };
  mat.customProgramCacheKey = () => 'nt-lamp';
  return mat;
}

/** Neon sign: always on, subtle hum + rare stutter, brighter at night. */
export function createNeonMaterial(color = 0xff3aa0) {
  const mat = new THREE.MeshBasicMaterial({ color });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = shared.uNight;
    shader.uniforms.uTime = shared.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vNtPhase;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        { mat4 ntM = modelMatrix;
          #ifdef USE_INSTANCING
            ntM = modelMatrix * instanceMatrix;
          #endif
          vNtPhase = fract(dot(ntM[3].xyz, vec3(0.731, 0.173, 0.419))) * 100.0; }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;\nuniform float uTime;\nvarying float vNtPhase;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        { float t = uTime + vNtPhase;
          float hum = 0.94 + 0.06 * sin(t * 37.0);
          // rare stutter: a couple of quick dips every few seconds
          float k = floor(t * 0.35);
          float gate = step(0.72, fract(sin(k * 91.7 + vNtPhase) * 43758.5));
          float stutter = 1.0 - gate * 0.55 * step(0.5, fract(t * 9.0)) * step(fract(t * 0.35), 0.18);
          diffuseColor.rgb *= diffuseColor.rgb * 0.5 + 0.5;   // push saturation
          diffuseColor.rgb *= mix(1.4, 3.6, uNight) * hum * stutter; }`);
  };
  mat.customProgramCacheKey = () => 'nt-neon';
  return mat;
}

const FX_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
void main(){
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

/** Mission-marker light pillar for a vertical CylinderGeometry (uv.y = height). */
export function createBeaconMaterial(color = 0x39f0ff) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uTime: shared.uTime, uOpacity: { value: 1 } },
    vertexShader: FX_VERT,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uTime; uniform float uOpacity;
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){
        float h = clamp(vUv.y, 0.0, 1.0);
        float fade = pow(1.0 - h, 1.6);                              // dissolve with height
        // upward scrolling bands, two speeds for a shimmering feel
        float b1 = smoothstep(0.55, 1.0, sin(h * 38.0 - uTime * 5.0) * 0.5 + 0.5);
        float b2 = smoothstep(0.2, 1.0, sin(h * 9.0 - uTime * 1.7 + 1.3) * 0.5 + 0.5);
        float base = exp(-h * 14.0);                                 // hot ring at the foot
        float facing = pow(abs(dot(normalize(vN), normalize(vV))), 0.7);   // soften silhouette
        float pulse = 0.85 + 0.15 * sin(uTime * 3.0);
        float a = (0.22 + 0.5 * b1 + 0.28 * b2) * fade * pulse + base * 1.6;
        vec3 col = mix(uColor, vec3(1.0), 0.25 * b1 + 0.5 * base);
        gl_FragColor = vec4(col * a * facing * 1.1 * uOpacity, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, fog: false,
  });
}

/** Soft additive glow shell for pickups (put on a sphere slightly larger than the item). */
export function createGlowMaterial(color = 0xffe066) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uTime: shared.uTime, uOpacity: { value: 1 } },
    vertexShader: FX_VERT,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uTime; uniform float uOpacity;
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){
        float ndv = abs(dot(normalize(vN), normalize(vV)));
        // inverse fresnel: bright core that melts away toward the silhouette (no hard edge)
        float core = pow(ndv, 2.2);
        float rim = pow(1.0 - ndv, 3.0) * ndv * 2.0;                 // faint ring just inside the edge
        float pulse = 0.8 + 0.2 * sin(uTime * 3.2);
        float a = (core * 0.9 + rim * 0.5) * pulse;
        gl_FragColor = vec4(mix(uColor, vec3(1.0), core * 0.35) * a * 1.0 * uOpacity, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, side: THREE.FrontSide,
    blending: THREE.AdditiveBlending, fog: false,
  });
}
