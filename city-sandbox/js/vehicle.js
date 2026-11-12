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
import { createCarModel } from './gfx/models.js';

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
const LOCAL_LEFT = new CANNON.Vec3(1, 0, 0);
const _left = new CANNON.Vec3();

export class Vehicle {
  /** @param {{physics: import('./physics.js').Physics, scene: THREE.Scene, color:number, x:number, z:number, heading:number, style?:string}} opts */
  constructor({ physics, scene, color, x, z, heading, style = 'coupe' }) {
    this.physics = physics;
    this.color = color;
    this.style = style;
    this.styleStats = CONFIG.vehicleStyles[style];
    this.name = this.styleStats.name;
    /** Effective multipliers = model stats x garage upgrades (see applyUpgrades). */
    this.stats = { engine: 1, topSpeed: 1, grip: 1, armor: 1 };

    this.health = 100;       // 0 = wrecked engine (limps until repaired)
    this.boosting = false;   // nitro burning
    this.airborne = false;   // no wheel touches the ground
    this.slip = 0;           // 0..1 how hard the tyres are sliding sideways
    this.braking = false;
    /** Called with (impactSpeed m/s, otherBody) on hard collisions. */
    this.onImpact = null;

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
    this._baseSlip = car.wheelInfos.map((w) => w.frictionSlip);
    this.applyUpgrades({});

    body.addEventListener('collide', (e) => {
      const impact = Math.abs(e.contact.getImpactVelocityAlongNormal());
      if (impact > 3.5 && this.onImpact) this.onImpact(impact, e.body);
    });

    // --- visuals ----------------------------------------------------------
    this.model = createCarModel({ color, style });
    this.mesh = this.model.group;
    this.wheelMeshes = this.model.wheels;
    scene.add(this.mesh);

    physics.onPreStep((h) => this._preStep(h));
    this.update();
  }

  /**
   * Recompute handling from the model's stats and the garage upgrade levels.
   * @param {{engine?:number, tires?:number, armor?:number}} levels
   */
  applyUpgrades(levels) {
    const st = this.styleStats;
    this.stats.engine = st.engine * (1 + 0.12 * (levels.engine || 0));
    this.stats.topSpeed = st.topSpeed * (1 + 0.07 * (levels.engine || 0));
    this.stats.grip = st.grip * (1 + 0.09 * (levels.tires || 0));
    this.stats.armor = st.toughness / (1 - 0.22 * Math.min(3, levels.armor || 0));
    this.car.wheelInfos.forEach((w, i) => (w.frictionSlip = this._baseSlip[i] * this.stats.grip));
  }

  /** Top speed right now (m/s), including nitro. */
  get maxSpeed() {
    return V.maxSpeed * this.stats.topSpeed * (this.boosting ? CONFIG.nitro.speedBoost : 1);
  }

  /** Apply crash damage (already scaled by the caller); returns the new health. */
  damage(amount) {
    this.health = Math.max(0, this.health - amount / this.stats.armor);
    this.model.setDamage(1 - this.health / 100);
    return this.health;
  }

  repair() {
    this.health = 100;
    this.model.setDamage(0);
  }

  /** Gear indicator for the HUD. */
  get gear() {
    const fs = this.forwardSpeed;
    if (fs < -0.6) return 'R';
    if (Math.abs(fs) < 0.6 && this.throttle === 0) return 'N';
    return String(1 + Math.min(4, Math.floor((Math.max(0, fs) / (V.maxSpeed * this.stats.topSpeed)) * 5)));
  }

  /** Runs once per fixed physics step: turn driver input into wheel forces. */
  _preStep(h) {
    const body = this.body;
    body.quaternion.vmult(LOCAL_FORWARD, _forward);
    const fs = body.velocity.dot(_forward);

    const top = this.maxSpeed;
    const power =
      V.engineForce * this.stats.engine *
      (this.boosting ? CONFIG.nitro.forceBoost : 1) *
      (this.health <= 0 ? 0.4 : 1);

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
      else engine = power * this.throttle * Math.max(0, 1 - (fs / top) ** 2);
    } else if (this.throttle < 0) {
      if (fs > 1) brake = V.brakeForce; // rolling forwards: brake first
      else engine = V.reverseForce * this.throttle * Math.max(0, 1 - (fs / V.maxReverseSpeed) ** 2);
    } else {
      brake = 1.5; // engine braking / rolling resistance
    }

    // Steering: less lock at speed, and the wheels turn at a finite rate.
    this.braking = this.occupied && (brake > 10 || this.handbrake || this.throttle < 0);
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
    this.airborne = this.car.numWheelsOnGround === 0;
    body.quaternion.vmult(LOCAL_LEFT, _left);
    const lateral = Math.abs(body.velocity.dot(_left));
    const wanted = this.airborne ? 0 : Math.min(1, Math.max(0, (lateral - 2.5) / 7));
    this.slip += (wanted - this.slip) * 0.2;
    this.model.setBraking(this.braking);
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
    this.teleport(this.body.position.x, this.body.position.y + 1.2, this.body.position.z, this.heading);
  }

  /** Move the car to (x, y, z) facing `heading`, at rest. */
  teleport(x, y, z, heading) {
    const b = this.body;
    this.heading = heading;
    b.position.set(x, y, z);
    b.quaternion.setFromAxisAngle(LOCAL_UP, this.heading);
    b.velocity.set(0, 0, 0);
    b.angularVelocity.set(0, 0, 0);
    b.previousPosition.copy(b.position);
    b.interpolatedPosition.copy(b.position);
    b.interpolatedQuaternion.copy(b.quaternion);
  }
}
