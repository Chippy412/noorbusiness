/**
 * characters.js — builds the blocky humanoid used by the player and the NPCs.
 * The model's origin is at its feet and it faces +Z, so setting
 * `group.rotation.y = heading` makes it face its heading.
 */
import * as THREE from 'three';

const box = (w, h, d, color) => {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshLambertMaterial({ color })
  );
  mesh.castShadow = true;
  return mesh;
};

/** A limb that swings around its top end (hip or shoulder). */
function limb(w, h, d, color, x, pivotY) {
  const pivot = new THREE.Group();
  pivot.position.set(x, pivotY, 0);
  const mesh = box(w, h, d, color);
  mesh.position.y = -h / 2;
  pivot.add(mesh);
  return pivot;
}

/**
 * @param {{shirt?:number, pants?:number, skin?:number}} colors
 * @returns {{group: THREE.Group, animate: (phase:number, amount:number) => void}}
 *   animate(phase, amount): phase is the walk-cycle angle in radians,
 *   amount is 0 (standing still) .. 1 (full stride).
 */
export function createHumanoid({ shirt = 0x2e86de, pants = 0x2d3436, skin = 0xe0ac69 } = {}) {
  const group = new THREE.Group();

  const torso = box(0.56, 0.65, 0.3, shirt);
  torso.position.y = 1.18;
  const head = box(0.34, 0.34, 0.34, skin);
  head.position.y = 1.7;
  const nose = box(0.08, 0.08, 0.08, 0x222222); // shows which way the model faces
  nose.position.set(0, 1.72, 0.2);

  const legL = limb(0.24, 0.85, 0.24, pants, -0.15, 0.85);
  const legR = limb(0.24, 0.85, 0.24, pants, 0.15, 0.85);
  const armL = limb(0.17, 0.62, 0.17, shirt, -0.38, 1.48);
  const armR = limb(0.17, 0.62, 0.17, shirt, 0.38, 1.48);

  group.add(torso, head, nose, legL, legR, armL, armR);

  function animate(phase, amount) {
    const swing = Math.sin(phase) * 0.8 * amount;
    legL.rotation.x = swing;
    legR.rotation.x = -swing;
    armL.rotation.x = -swing * 0.8;
    armR.rotation.x = swing * 0.8;
  }

  return { group, animate };
}
