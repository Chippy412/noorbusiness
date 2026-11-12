/**
 * characters.js — smooth, stylised humanoid used by the player and the NPCs.
 *
 * The model's origin is at its feet and it faces +Z (+X is its left), so
 * `group.rotation.y = heading` makes it face its heading. Total height ≈ 1.8 m.
 *
 * Cheap by design: 11 meshes, ONE shared material (vertex colours), geometry
 * position/normal buffers shared between every character — only a small colour
 * buffer is unique per character.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Colour slots baked into the shared base geometry.
const SHIRT = 0, PANTS = 1, SKIN = 2, HAIR = 3, SHOE = 4, DARK = 5;

const HAIR_COLORS = [0x2b1d14, 0x161616, 0x5a3a1e, 0x8a5a2b, 0xc9a25a, 0x6b2f1a, 0x3d3d46, 0xb7b2a8];

const MATERIAL = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0.0 });

const HIP_Y = 0.905;
const THIGH = 0.42, UPPER_ARM = 0.27;

// ---------------------------------------------------------------- geometry

/** Non-indexed position+normal geometry tagged with a colour slot. */
function slot(geo, id) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  const n = g.attributes.position.count;
  g.setAttribute('slot', new THREE.BufferAttribute(new Float32Array(n).fill(id), 1));
  return g;
}

/** Capsule hanging down from the origin: radius r0 at y=0 tapering to r1 at y=-len. */
function taperedCapsule(r0, r1, len, radial = 8) {
  const pts = [];
  const cap = 3;
  for (let i = 0; i <= cap; i++) { // bottom hemisphere
    const a = -Math.PI / 2 + (i / cap) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.max(1e-4, r1 * Math.cos(a)), -len + r1 * Math.sin(a)));
  }
  for (let i = 0; i <= cap; i++) { // top hemisphere
    const a = (i / cap) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.max(1e-4, r0 * Math.cos(a)), r0 * Math.sin(a)));
  }
  return new THREE.LatheGeometry(pts, radial);
}

function ellipsoid(r, sx, sy, sz, ws = 10, hs = 7) {
  const g = new THREE.SphereGeometry(r, ws, hs);
  g.scale(sx, sy, sz);
  g.computeVertexNormals();
  return g;
}

let BASE = null;
function baseGeometry() {
  if (BASE) return BASE;
  const m = (list) => mergeGeometries(list, false);

  // Pelvis (origin at hip height).
  const pelvis = slot(ellipsoid(0.17, 1.02, 0.78, 0.74), PANTS).translate(0, 0.04, 0);

  // Torso (origin at the waist) — lathed barrel, flattened front-to-back, plus neck.
  const prof = [[0.001, -0.07], [0.12, -0.06], [0.15, 0.03], [0.158, 0.16], [0.18, 0.31], [0.172, 0.41],
    [0.12, 0.475], [0.06, 0.505], [0.001, 0.515]].map(([r, y]) => new THREE.Vector2(r, y));
  const torsoG = new THREE.LatheGeometry(prof, 12);
  torsoG.scale(1.14, 1, 0.68);
  torsoG.computeVertexNormals();
  const neck = new THREE.CylinderGeometry(0.052, 0.058, 0.12, 8, 1, true).translate(0, 0.54, 0);
  const torso = m([slot(torsoG, SHIRT), slot(neck, SKIN)]);

  // Head (origin at head centre): skull, hair cap, fringe, eyes, nose.
  const skull = ellipsoid(0.165, 0.95, 1.05, 1.0, 14, 10);
  const hair = new THREE.SphereGeometry(0.178, 14, 7, 0, Math.PI * 2, 0, 1.72);
  hair.scale(0.97, 1.04, 1.02).rotateX(-0.52).translate(0, 0.004, -0.006);
  hair.computeVertexNormals();
  const fringe = ellipsoid(0.07, 1.7, 0.5, 0.8, 8, 5).rotateX(-0.5).translate(0, 0.125, 0.105);
  const eyeL = ellipsoid(0.021, 1, 1.25, 0.6, 6, 5).translate(0.058, 0.012, 0.15);
  const eyeR = ellipsoid(0.021, 1, 1.25, 0.6, 6, 5).translate(-0.058, 0.012, 0.15);
  const nose = ellipsoid(0.024, 0.9, 1.0, 1.1, 6, 5).translate(0, -0.03, 0.165);
  const head = m([slot(skull, SKIN), slot(hair, HAIR), slot(fringe, HAIR), slot(eyeL, DARK), slot(eyeR, DARK), slot(nose, SKIN)]);

  // Limbs (origin at the joint, hanging down -Y).
  const upperArm = slot(taperedCapsule(0.064, 0.052, UPPER_ARM), SHIRT);
  const forearm = m([
    slot(taperedCapsule(0.05, 0.041, 0.25), SKIN),
    slot(ellipsoid(0.05, 0.85, 1.15, 1.0, 8, 6).translate(0, -0.3, 0.005), SKIN),
  ]);
  const thigh = slot(taperedCapsule(0.088, 0.068, THIGH), PANTS);
  const shin = m([
    slot(taperedCapsule(0.066, 0.05, 0.4), PANTS),
    slot(ellipsoid(0.062, 1.0, 0.74, 1.95, 8, 6).translate(0, -0.439, 0.05), SHOE),
  ]);

  BASE = { pelvis, torso, head, upperArm, forearm, thigh, shin };
  for (const g of Object.values(BASE)) { g.computeBoundingSphere(); g.computeBoundingBox(); }
  return BASE;
}

/** Shares position/normal with the base geometry; only the colour buffer is new. */
function tinted(base, palette) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', base.attributes.position);
  g.setAttribute('normal', base.attributes.normal);
  const slots = base.attributes.slot.array;
  const col = new Float32Array(slots.length * 3);
  for (let i = 0; i < slots.length; i++) {
    const c = palette[slots[i]];
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.boundingSphere = base.boundingSphere;
  g.boundingBox = base.boundingBox;
  return g;
}

const lerp = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------- factory

/**
 * @param {{shirt?:number, pants?:number, skin?:number, hair?:number}} colors
 * @returns {{group: THREE.Group, animate: (phase:number, amount:number, opts?:{airborne?:boolean|number, run?:number}) => void}}
 *   animate(phase, amount, opts): phase is the walk-cycle angle in radians,
 *   amount is 0 (standing still) .. 1 (full stride). opts.run (0..1) leans the
 *   body forward with a bigger arm swing; opts.airborne gives a jump pose.
 */
export function createHumanoid({ shirt = 0x2e86de, pants = 0x2d3436, skin = 0xe0ac69, hair } = {}) {
  const base = baseGeometry();
  if (hair === undefined) hair = HAIR_COLORS[(((shirt * 7) ^ (pants * 13) ^ skin) >>> 0) % HAIR_COLORS.length];

  const shoeColor = new THREE.Color(pants).multiplyScalar(0.35).lerp(new THREE.Color(0x202024), 0.5);
  const palette = [new THREE.Color(shirt), new THREE.Color(pants), new THREE.Color(skin), new THREE.Color(hair),
    shoeColor, new THREE.Color(0x15110f)];

  const geo = {};
  for (const k of Object.keys(base)) geo[k] = tinted(base[k], palette);
  const mesh = (g) => {
    const m = new THREE.Mesh(g, MATERIAL);
    m.castShadow = true;
    return m;
  };

  const group = new THREE.Group();
  const root = new THREE.Group();
  root.position.y = HIP_Y;
  group.add(root);

  const pelvis = mesh(geo.pelvis);
  root.add(pelvis);

  const chest = new THREE.Group();
  chest.position.y = 0.09;
  root.add(chest);
  chest.add(mesh(geo.torso));
  const head = mesh(geo.head);
  head.position.y = 0.64;
  chest.add(head);

  const makeLimb = (parent, x, y, upperGeo, lowerGeo, upperLen) => {
    const upper = mesh(upperGeo);
    upper.position.set(x, y, 0);
    const lower = mesh(lowerGeo);
    lower.position.y = -upperLen;
    upper.add(lower);
    parent.add(upper);
    return [upper, lower];
  };
  const [armL, foreL] = makeLimb(chest, 0.232, 0.41, geo.upperArm, geo.forearm, UPPER_ARM);
  const [armR, foreR] = makeLimb(chest, -0.232, 0.41, geo.upperArm, geo.forearm, UPPER_ARM);
  const [legL, shinL] = makeLimb(root, 0.092, 0, geo.thigh, geo.shin, THIGH);
  const [legR, shinR] = makeLimb(root, -0.092, 0, geo.thigh, geo.shin, THIGH);

  function animate(phase, amount, opts = {}) {
    const a = Math.min(1, Math.max(0, amount || 0));
    const run = Math.min(1, Math.max(0, opts.run || 0));
    const air = opts.airborne === true ? 1 : Math.min(1, Math.max(0, +opts.airborne || 0));
    const s = Math.sin(phase), c = Math.cos(phase);

    // --- walk / run cycle (rotation.x > 0 swings a hanging limb backwards)
    const stride = (0.52 + 0.3 * run) * a;
    const lift = (0.95 + 0.65 * run) * a;
    const kL = Math.max(0, -c), kR = Math.max(0, c); // leg is swinging forward
    let thL = s * stride - 0.14 * run * a;
    let thR = -s * stride - 0.14 * run * a;
    let knL = 0.1 * a + lift * kL * kL;
    let knR = 0.1 * a + lift * kR * kR;

    const swing = (0.42 + 0.5 * run) * a;
    let aLx = -s * swing, aRx = s * swing;
    let aLz = 0.07, aRz = -0.07;
    const bend = 0.1 + 0.2 * a + 1.05 * run * a;
    let eL = -(bend + 0.3 * a * Math.max(0, s));
    let eR = -(bend + 0.3 * a * Math.max(0, -s));

    let bob = -Math.min(0.12, 0.75 * (1 - Math.cos(stride))) * (0.5 - 0.5 * Math.cos(2 * phase));
    let lean = 0.04 * a + 0.26 * run * a;
    let twist = -s * (0.16 + 0.1 * run) * a;
    let rootLean = 0.06 * run * a;

    // --- jump pose
    if (air > 0) {
      thL = lerp(thL, -0.95, air); knL = lerp(knL, 1.35, air);
      thR = lerp(thR, 0.3, air); knR = lerp(knR, 0.75, air);
      aLx = lerp(aLx, -0.7, air); aRx = lerp(aRx, 0.45, air);
      aLz = lerp(aLz, 0.75, air); aRz = lerp(aRz, -0.75, air);
      eL = lerp(eL, -0.55, air); eR = lerp(eR, -0.55, air);
      bob = lerp(bob, 0, air); lean = lerp(lean, 0.12, air);
      twist = lerp(twist, 0, air); rootLean = lerp(rootLean, 0, air);
    }

    legL.rotation.x = thL; shinL.rotation.x = knL;
    legR.rotation.x = thR; shinR.rotation.x = knR;
    armL.rotation.x = aLx; armL.rotation.z = aLz; foreL.rotation.x = eL;
    armR.rotation.x = aRx; armR.rotation.z = aRz; foreR.rotation.x = eR;
    root.position.y = HIP_Y + bob;
    root.rotation.x = rootLean;
    chest.rotation.x = lean;
    chest.rotation.y = twist;
    pelvis.rotation.y = -twist * 0.5;
    head.rotation.y = -twist * 0.6;
    head.rotation.x = -lean * 0.5;
  }

  animate(0, 0);
  return { group, animate };
}
