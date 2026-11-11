/**
 * physics.js — thin wrapper around a cannon-es world.
 *
 * Responsibilities:
 *   - owns the CANNON.World, its materials and collision groups
 *   - steps the simulation with a fixed timestep (and lets cannon interpolate
 *     body transforms for rendering, so motion is smooth at any frame rate)
 *   - helpers to create static colliders, cast rays and bind meshes to bodies
 *
 * Game code that must run once per physics step (player and vehicle control)
 * registers a callback with `onPreStep`.
 */
import * as CANNON from 'cannon-es';
import { CONFIG } from './config.js';

/** Collision groups (bit flags). Everything collides with everything; the
 *  groups exist so ray casts can pick what they are allowed to hit. */
export const GROUP = Object.freeze({
  STATIC: 1,
  PLAYER: 2,
  VEHICLE: 4,
  PROP: 8,
});

export class Physics {
  constructor() {
    const world = new CANNON.World({
      gravity: new CANNON.Vec3(0, CONFIG.physics.gravity, 0),
    });
    world.broadphase = new CANNON.SAPBroadphase(world);
    world.allowSleep = true;
    world.solver.iterations = 12;
    this.world = world;

    // Materials. `solid` is the world and props, `slippery` is the player
    // (movement is velocity driven, friction would glue it to walls) and
    // `chassis` is car bodywork (grip comes from the wheels, not the body).
    const solid = new CANNON.Material('solid');
    const slippery = new CANNON.Material('slippery');
    const chassis = new CANNON.Material('chassis');
    this.materials = { solid, slippery, chassis };

    const pair = (a, b, friction, restitution) =>
      world.addContactMaterial(new CANNON.ContactMaterial(a, b, { friction, restitution }));
    pair(solid, solid, 0.5, 0.05);
    pair(slippery, solid, 0, 0);
    pair(slippery, slippery, 0, 0);
    pair(slippery, chassis, 0, 0);
    pair(chassis, solid, 0.12, 0.1);
    pair(chassis, chassis, 0.12, 0.1);

    /** @type {{body: CANNON.Body, mesh: import('three').Object3D}[]} */
    this.bindings = [];

    // Scratch objects for ray casts.
    this._from = new CANNON.Vec3();
    this._to = new CANNON.Vec3();
    this._result = new CANNON.RaycastResult();
    this._rayOptions = { collisionFilterMask: GROUP.STATIC, skipBackfaces: true };
  }

  /** Register a function called before every fixed physics step: fn(stepSeconds). */
  onPreStep(fn) {
    this.world.addEventListener('preStep', () => fn(CONFIG.physics.fixedStep));
  }

  /** Advance the simulation by `dt` seconds of real time. */
  step(dt) {
    this.world.step(CONFIG.physics.fixedStep, dt, CONFIG.physics.maxSubSteps);
  }

  /** Infinite ground plane at y = 0. */
  addGroundPlane() {
    const body = new CANNON.Body({
      mass: 0,
      material: this.materials.solid,
      collisionFilterGroup: GROUP.STATIC,
    });
    body.addShape(new CANNON.Plane());
    body.quaternion.setFromEuler(-Math.PI / 2, 0, 0); // plane normal +Z -> +Y
    this.world.addBody(body);
    return body;
  }

  /**
   * Static box collider.
   * @param {{x:number,y:number,z:number}} center
   * @param {{x:number,y:number,z:number}} size full extents
   * @param {{x:number,y:number,z:number,w:number}} [quaternion]
   */
  addStaticBox(center, size, quaternion) {
    const body = new CANNON.Body({
      mass: 0,
      material: this.materials.solid,
      collisionFilterGroup: GROUP.STATIC,
    });
    body.addShape(new CANNON.Box(new CANNON.Vec3(size.x / 2, size.y / 2, size.z / 2)));
    body.position.set(center.x, center.y, center.z);
    if (quaternion) body.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
    this.world.addBody(body);
    return body;
  }

  /** Dynamic box prop; `mesh` follows the body automatically. */
  addDynamicBox(center, size, mass, mesh) {
    const body = new CANNON.Body({
      mass,
      material: this.materials.solid,
      collisionFilterGroup: GROUP.PROP,
    });
    body.addShape(new CANNON.Box(new CANNON.Vec3(size.x / 2, size.y / 2, size.z / 2)));
    body.position.set(center.x, center.y, center.z);
    body.sleepSpeedLimit = 0.3;
    body.sleepTimeLimit = 0.8;
    this.world.addBody(body);
    if (mesh) this.bind(body, mesh);
    return body;
  }

  /** Keep `mesh` at the (interpolated) transform of `body`. */
  bind(body, mesh) {
    this.bindings.push({ body, mesh });
  }

  /** Copy interpolated body transforms onto all bound meshes. */
  syncMeshes() {
    for (const { body, mesh } of this.bindings) {
      mesh.position.copy(body.interpolatedPosition);
      mesh.quaternion.copy(body.interpolatedQuaternion);
    }
  }

  /**
   * Closest ray hit between two points.
   * @param {{x:number,y:number,z:number}} from
   * @param {{x:number,y:number,z:number}} to
   * @param {number} [mask] collision groups the ray may hit
   * @returns {CANNON.RaycastResult|null} valid until the next raycast call
   */
  raycast(from, to, mask = GROUP.STATIC) {
    this._from.set(from.x, from.y, from.z);
    this._to.set(to.x, to.y, to.z);
    this._result.reset();
    this._rayOptions.collisionFilterMask = mask;
    this.world.raycastClosest(this._from, this._to, this._rayOptions, this._result);
    return this._result.hasHit ? this._result : null;
  }
}
