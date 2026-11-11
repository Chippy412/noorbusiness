/**
 * player.js — third-person character controller.
 *
 * Physics: one dynamic body made of two stacked spheres (a cheap capsule) with
 * rotation locked. Horizontal movement is velocity driven: every physics step
 * the body's XZ velocity is accelerated towards the velocity the input asks
 * for. Gravity, jumping and all collisions are left to the physics engine.
 *
 * `position` is the point between the feet; the body origin is height/2 above.
 */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { CONFIG } from './config.js';
import { GROUP } from './physics.js';
import { createHumanoid } from './characters.js';

const P = CONFIG.player;
const HALF_HEIGHT = P.height / 2;

export class Player {
  /** @param {{physics: import('./physics.js').Physics, scene: THREE.Scene, x:number, z:number, heading:number}} opts */
  constructor({ physics, scene, x, z, heading }) {
    this.physics = physics;
    this.enabled = true;

    /** Feet position, updated every frame. */
    this.position = new THREE.Vector3(x, 0, z);
    /** Yaw the model faces (see config.js for the convention). */
    this.heading = heading;
    this.grounded = false;

    // --- physics body -----------------------------------------------------
    const body = new CANNON.Body({
      mass: P.mass,
      material: physics.materials.slippery,
      fixedRotation: true,
      allowSleep: false,
      collisionFilterGroup: GROUP.PLAYER,
    });
    const sphere = new CANNON.Sphere(P.radius);
    const offset = HALF_HEIGHT - P.radius;
    body.addShape(sphere, new CANNON.Vec3(0, -offset, 0));
    body.addShape(sphere, new CANNON.Vec3(0, offset, 0));
    body.position.set(x, HALF_HEIGHT + 0.05, z);
    body.updateMassProperties();
    physics.world.addBody(body);
    this.body = body;

    // --- visuals ----------------------------------------------------------
    const { group, animate } = createHumanoid({ shirt: 0x21c06b, pants: 0x1f2a44 });
    this.mesh = group;
    this._animate = animate;
    this._walkPhase = 0;
    scene.add(group);

    // --- control state ----------------------------------------------------
    this._wishX = 0; // wanted horizontal velocity (world space, m/s)
    this._wishZ = 0;
    this._jumpQueued = 0;   // seconds a jump press stays valid
    this._coyote = 0;       // seconds since the ground was last felt
    this._jumpCooldown = 0;
    this._rayFrom = new CANNON.Vec3();
    this._rayTo = new CANNON.Vec3();

    physics.onPreStep((h) => this._preStep(h));
  }

  /**
   * Feed one frame of input.
   * @param {number} dirX wanted direction, world X (need not be normalised)
   * @param {number} dirZ wanted direction, world Z
   * @param {boolean} run
   * @param {boolean} jumpPressed true on the frame the jump key went down
   */
  setInput(dirX, dirZ, run, jumpPressed) {
    const len = Math.hypot(dirX, dirZ);
    const speed = len > 0 ? (run ? P.runSpeed : P.walkSpeed) / len : 0;
    this._wishX = dirX * speed;
    this._wishZ = dirZ * speed;
    if (jumpPressed) this._jumpQueued = 0.15; // small buffer: feels responsive
  }

  /** Runs once per fixed physics step. */
  _preStep(h) {
    if (!this.enabled) return;
    const body = this.body;
    const v = body.velocity;

    // Ground probe: a short ray from the body centre to just below the feet.
    this._rayFrom.copy(body.position);
    this._rayTo.set(body.position.x, body.position.y - HALF_HEIGHT - 0.18, body.position.z);
    const hit = this.physics.raycast(this._rayFrom, this._rayTo, ~GROUP.PLAYER);
    this.grounded = !!hit && v.y < 2;
    this._coyote = this.grounded ? 0 : this._coyote + h;
    this._jumpCooldown = Math.max(0, this._jumpCooldown - h);
    this._jumpQueued = Math.max(0, this._jumpQueued - h);

    // Accelerate the horizontal velocity towards the wanted velocity.
    const maxDelta = P.acceleration * h * (this.grounded ? 1 : P.airControl);
    let dx = this._wishX - v.x;
    let dz = this._wishZ - v.z;
    const d = Math.hypot(dx, dz);
    if (d > maxDelta) {
      dx *= maxDelta / d;
      dz *= maxDelta / d;
    }
    v.x += dx;
    v.z += dz;

    // Jump (allowed a moment after walking off an edge: "coyote time").
    if (this._jumpQueued > 0 && this._coyote < 0.12 && this._jumpCooldown === 0) {
      v.y = P.jumpSpeed;
      this._jumpQueued = 0;
      this._jumpCooldown = 0.3;
      this._coyote = 1;
    }
  }

  /** Per-frame: sync the model with the body and animate it. */
  update(dt) {
    if (!this.enabled) return;
    const p = this.body.interpolatedPosition;
    this.position.set(p.x, p.y - HALF_HEIGHT, p.z);

    const v = this.body.velocity;
    const speed = Math.hypot(v.x, v.z);
    if (speed > 0.5) {
      // Turn towards the direction of travel along the shortest arc.
      const target = Math.atan2(v.x, v.z);
      let diff = target - this.heading;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      this.heading += diff * Math.min(1, P.turnRate * dt);
    }

    this._walkPhase += speed * dt * 2.4;
    this._animate(this._walkPhase, this.grounded ? Math.min(1, speed / 3) : 0.6);

    this.mesh.position.copy(this.position);
    this.mesh.rotation.y = this.heading;
  }

  /** Remove the player from the world (while driving) or put it back. */
  setEnabled(enabled) {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.mesh.visible = enabled;
    if (enabled) this.physics.world.addBody(this.body);
    else this.physics.world.removeBody(this.body);
  }

  /** Place the feet at (x, y, z), facing `heading`, with the given velocity. */
  teleport(x, y, z, heading, velocity) {
    const b = this.body;
    b.position.set(x, y + HALF_HEIGHT + 0.02, z);
    b.previousPosition.copy(b.position);
    b.interpolatedPosition.copy(b.position);
    if (velocity) b.velocity.set(velocity.x, velocity.y, velocity.z);
    else b.velocity.set(0, 0, 0);
    this._wishX = this._wishZ = 0;
    this.heading = heading;
    this.position.set(x, y, z);
    this.mesh.position.copy(this.position);
    this.mesh.rotation.y = heading;
  }
}
