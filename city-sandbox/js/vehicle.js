/**
 * vehicle.js — a drivable car built on cannon-es' RaycastVehicle.
 *
 * Physics model: one rigid box (the chassis) plus four ray-cast wheels. Each
 * wheel casts a ray down, a spring/damper pushes the chassis up, and tyre
 * friction turns engine, brake and steering inputs into forces. Collisions
 * with the city are ordinary rigid-body collisions of the chassis box.
 *
 * Local axes of the chassis: +Z forward, +Y up, +X is the car's left side.
 * Rear wheel drive, front wheel steering.
 */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { CONFIG } from './config.js';
import { GROUP } from './physics.js';

const V = CONFIG.vehicle;

// The collision box sits above the body origin so the centre of mass is low,
// which keeps the car from rolling over in ordinary turns.
const BOX_OFFSET_Y = 0.25;
const WHEEL_CONNECT_Y = 0.15;
const SUSPENSION_REST = 0.32;

// Sign conventions of RaycastVehicle for our axis setup (verified by test).
const ENGINE_SIGN = -1; // negative engine force accelerates towards +Z
const STEER_SIGN = 1;   // positive steering value turns towards +X (left)

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _forward = new CANNON.Vec3();
const _up = new CANNON.Vec3();
const LOCAL_FORWARD = new CANNON.Vec3(0, 0, 1);
const LOCAL_UP = new CANNON.Vec3(0, 1, 0);

export class Vehicle {
  /** @param {{physics: import('./physics.js').Physics, scene: THREE.Scene, color:number, x:number, z:number, heading:number}} opts */
  constructor({ physics, scene, color, x, z, heading }) {
    this.physics = physics;
    this.color = color;

    /** True while the player is driving this car. */
    this.occupied = false;
    // Public, read-only state refreshed every frame (see update()).
    this.position = new THREE.Vector3(x, 1, z);
    this.velocity = new THREE.Vector3();
    this.heading = heading;
    this.speed = 0;         // absolute, m/s
    this.forwardSpeed = 0;  // signed along the car's nose, m/s
    this.upright = 1;       // y component of the car's up vector (1 = level, <0 = upside down)

    // Driver input, set by the game each frame.
    this.throttle = 0;   // -1 reverse .. +1 forward
    this.steerInput = 0; // -1 right .. +1 left
    this.handbrake = false;
    this._steer = 0;     // current (smoothed) wheel angle

    // --- chassis body -----------------------------------------------------
    const { width, height, length } = V.chassis;
    const body = new CANNON.Body({
      mass: V.mass,
      material: physics.materials.chassis,
      allowSleep: false,
      collisionFilterGroup: GROUP.VEHICLE,
    });
    body.addShape(
      new CANNON.Box(new CANNON.Vec3(width / 2, height / 2, length / 2)),
      new CANNON.Vec3(0, BOX_OFFSET_Y, 0)
    );
    body.position.set(x, 1.0, z);
    body.quaternion.setFromAxisAngle(LOCAL_UP, heading);
    body.angularDamping = 0.35;
    body.linearDamping = 0.02;
    this.body = body;

    // --- ray-cast wheels --------------------------------------------------
    const car = new CANNON.RaycastVehicle({
      chassisBody: body,
      indexRightAxis: 0,
      indexUpAxis: 1,
      indexForwardAxis: 2,
    });
    const wheel = {
      radius: V.wheelRadius,
      directionLocal: new CANNON.Vec3(0, -1, 0),
      axleLocal: new CANNON.Vec3(1, 0, 0),
      suspensionRestLength: SUSPENSION_REST,
      suspensionStiffness: 38,
      dampingRelaxation: 2.6,
      dampingCompression: 4.2,
      maxSuspensionTravel: 0.28,
      maxSuspensionForce: 100000,
      frictionSlip: 2.4,
      rollInfluence: 0.04,
      customSlidingRotationalSpeed: -30,
      useCustomSlidingRotationalSpeed: true,
    };
    const wx = width / 2 - 0.12;
    const wz = length / 2 - 0.75;
    // Order: front-left, front-right, rear-left, rear-right.
    for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      car.addWheel({
        ...wheel,
        frictionSlip: sz > 0 ? 2.0 : 2.3, // more grip at the rear: stable, mild understeer
        chassisConnectionPointLocal: new CANNON.Vec3(sx * wx, WHEEL_CONNECT_Y, sz * wz),
      });
    }
    car.addToWorld(physics.world);
    this.car = car;

    // --- visuals ----------------------------------------------------------
    this.mesh = this._buildMesh(color);
    scene.add(this.mesh);

    physics.onPreStep((h) => this._preStep(h));
    this.update();
  }

  _buildMesh(color) {
    const { width, height, length } = V.chassis;
    const group = new THREE.Group();
    const add = (w, h, d, c, x, y, z, parent = group) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color: c }));
      m.position.set(x, y, z);
      m.castShadow = true;
      parent.add(m);
      return m;
    };
    const top = BOX_OFFSET_Y + height / 2;
    add(width, height, length, color, 0, BOX_OFFSET_Y, 0);                       // body
    add(width * 0.86, 0.55, length * 0.48, 0x1d2733, 0, top + 0.27, -0.25);       // cabin / glass
    add(width * 0.88, 0.06, length * 0.5, color, 0, top + 0.57, -0.25);           // roof
    add(0.4, 0.16, 0.06, 0xfff6c9, 0.6, BOX_OFFSET_Y + 0.1, length / 2 + 0.01);   // headlights
    add(0.4, 0.16, 0.06, 0xfff6c9, -0.6, BOX_OFFSET_Y + 0.1, length / 2 + 0.01);
    add(0.4, 0.14, 0.06, 0xb3121a, 0.6, BOX_OFFSET_Y + 0.1, -length / 2 - 0.01);  // tail lights
    add(0.4, 0.14, 0.06, 0xb3121a, -0.6, BOX_OFFSET_Y + 0.1, -length / 2 - 0.01);

    // Wheels are children of the chassis group and are placed in chassis
    // space every frame, so they can never lag behind the body.
    const tyre = new THREE.CylinderGeometry(V.wheelRadius, V.wheelRadius, 0.3, 18);
    tyre.rotateZ(Math.PI / 2); // cylinder axis -> X (the axle)
    const tyreMat = new THREE.MeshLambertMaterial({ color: 0x15171a });
    const hubMat = new THREE.MeshLambertMaterial({ color: 0xc9ccd1 });
    this.wheelMeshes = [];
    for (let i = 0; i < 4; i++) {
      const w = new THREE.Mesh(tyre, tyreMat);
      w.castShadow = true;
      const hub = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.12, V.wheelRadius * 1.2), hubMat);
      w.add(hub); // a bar across the wheel makes its spin visible
      group.add(w);
      this.wheelMeshes.push(w);
    }
    return group;
  }

  /** Runs once per fixed physics step: turn driver input into wheel forces. */
  _preStep(h) {
    const body = this.body;
    body.quaternion.vmult(LOCAL_FORWARD, _forward);
    const fs = body.velocity.dot(_forward);

    let engine = 0;
    let brake = 0;
    if (!this.occupied) {
      brake = 1.5; // parked: held by the rear handbrake below (braking all four wheels hard makes the solver jitter)
      // The suspension solver leaves a tiny residual drift; bleed it off so a
      // parked car stays exactly where it was left.
      if (body.velocity.lengthSquared() < 0.25) {
        body.velocity.x *= 0.85;
        body.velocity.z *= 0.85;
        body.angularVelocity.y *= 0.85;
      }
    } else if (this.throttle > 0) {
      if (fs < -1) brake = V.brakeForce; // rolling backwards: brake first
      else engine = V.engineForce * this.throttle * Math.max(0, 1 - (fs / V.maxSpeed) ** 2);
    } else if (this.throttle < 0) {
      if (fs > 1) brake = V.brakeForce; // rolling forwards: brake first
      else engine = V.reverseForce * this.throttle * Math.max(0, 1 - (fs / V.maxReverseSpeed) ** 2);
    } else {
      brake = 1.5; // engine braking / rolling resistance
    }

    // Steering: less lock at speed, and the wheels turn at a finite rate.
    const t = Math.min(1, Math.abs(fs) / V.maxSpeed);
    const lock = V.maxSteer + (V.minSteer - V.maxSteer) * Math.sqrt(t);
    const target = (this.occupied ? this.steerInput : 0) * lock;
    const maxTurn = V.steerSpeed * h;
    this._steer += Math.max(-maxTurn, Math.min(maxTurn, target - this._steer));

    const car = this.car;
    car.setSteeringValue(STEER_SIGN * this._steer, 0);
    car.setSteeringValue(STEER_SIGN * this._steer, 1);
    car.applyEngineForce(ENGINE_SIGN * engine, 2);
    car.applyEngineForce(ENGINE_SIGN * engine, 3);
    const rearBrake = !this.occupied || this.handbrake ? V.handbrakeForce : brake;
    car.setBrake(brake, 0);
    car.setBrake(brake, 1);
    car.setBrake(rearBrake, 2);
    car.setBrake(rearBrake, 3);
  }

  /** Per-frame: refresh public state and sync the meshes. */
  update() {
    const body = this.body;
    this.position.copy(body.interpolatedPosition);
    this.velocity.copy(body.velocity);
    this.speed = this.velocity.length();

    body.quaternion.vmult(LOCAL_FORWARD, _forward);
    body.quaternion.vmult(LOCAL_UP, _up);
    this.forwardSpeed = body.velocity.dot(_forward);
    this.upright = _up.y;
    // Only update the heading when the nose is not pointing straight up/down.
    if (Math.hypot(_forward.x, _forward.z) > 0.2) this.heading = Math.atan2(_forward.x, _forward.z);

    this.mesh.position.copy(body.interpolatedPosition);
    this.mesh.quaternion.copy(body.interpolatedQuaternion);

    // Wheel world transform -> chassis-local transform.
    _q.copy(body.quaternion).invert();
    for (let i = 0; i < 4; i++) {
      this.car.updateWheelTransform(i);
      const t = this.car.wheelInfos[i].worldTransform;
      const mesh = this.wheelMeshes[i];
      _v.set(t.position.x - body.position.x, t.position.y - body.position.y, t.position.z - body.position.z);
      mesh.position.copy(_v.applyQuaternion(_q));
      mesh.quaternion.copy(t.quaternion).premultiply(_q);
    }
  }

  setControls(throttle, steerInput, handbrake) {
    this.throttle = throttle;
    this.steerInput = steerInput;
    this.handbrake = handbrake;
  }

  /** Put the car back on its wheels where it is (keeps its heading). */
  resetUpright() {
    const b = this.body;
    b.position.y += 1.2;
    b.quaternion.setFromAxisAngle(LOCAL_UP, this.heading);
    b.velocity.set(0, 0, 0);
    b.angularVelocity.set(0, 0, 0);
    b.previousPosition.copy(b.position);
    b.interpolatedPosition.copy(b.position);
    b.interpolatedQuaternion.copy(b.quaternion);
  }
}
