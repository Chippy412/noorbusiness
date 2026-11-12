/**
 * camera.js — third-person orbit camera shared by the player and vehicles.
 *
 * The rig orbits a damped "focus" point at (yaw, pitch, distance):
 *     camera = focus + distance * (sin(yaw)cos(pitch), sin(pitch), cos(yaw)cos(pitch))
 * so the horizontal view direction is (-sin(yaw), -cos(yaw)).
 *
 * Switching between on-foot and driving only changes the target the focus
 * chases and the wanted distance; because both are damped, the camera glides
 * from one subject to the other instead of cutting.
 */
import * as THREE from 'three';
import { CONFIG, MODE } from './config.js';
import { GROUP } from './physics.js';

const K = CONFIG.camera;

/** Frame-rate independent smoothing factor for "approach at `rate` per second". */
const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

export class CameraRig {
  /** @param {{physics: import('./physics.js').Physics, aspect:number}} opts */
  constructor({ physics, aspect }) {
    this.physics = physics;
    this.camera = new THREE.PerspectiveCamera(K.fov, aspect, 0.3, 2500);
    this.yaw = Math.PI; // start behind a subject that faces +Z
    this.pitch = 0.3;
    this.distance = K.footDistance;
    this.focus = new THREE.Vector3();
    this._initialised = false;
    this._idle = 0; // seconds since the mouse last moved
    this.sensitivity = 1; // user setting multiplier
    this.invertY = false;
    this._fovKick = 0;    // extra degrees from speed / nitro
    this._shake = 0;      // current shake amplitude (m)
    this._desired = new THREE.Vector3();
    this._dir = new THREE.Vector3();
  }

  /** Horizontal direction the camera looks along (unit XZ vector). */
  get forwardX() { return -Math.sin(this.yaw); }
  get forwardZ() { return -Math.cos(this.yaw); }

  /**
   * @param {number} dt
   * @param {string} mode MODE.ON_FOOT | MODE.DRIVING
   * @param {{position: THREE.Vector3, heading:number, speed?:number}} subject
   * @param {{x:number, y:number}} mouse mouse movement in pixels this frame
   */
  update(dt, mode, subject, mouse) {
    const driving = mode === MODE.DRIVING;

    // --- orbit angles from the mouse ---------------------------------------
    if (mouse.x !== 0 || mouse.y !== 0) {
      const k = K.mouseSensitivity * this.sensitivity;
      this.yaw -= mouse.x * k;
      this.pitch += mouse.y * k * (this.invertY ? -1 : 1);
      this.pitch = Math.max(K.minPitch, Math.min(K.maxPitch, this.pitch));
      this._idle = 0;
    } else {
      this._idle += dt;
    }

    // While driving and not steering the camera, swing back behind the car.
    if (driving && this._idle > K.autoAlignDelay && (subject.speed || 0) > 2) {
      const behind = subject.heading + Math.PI;
      const diff = Math.atan2(Math.sin(behind - this.yaw), Math.cos(behind - this.yaw));
      this.yaw += diff * damp(2.2, dt);
      this.pitch += (0.28 - this.pitch) * damp(1.2, dt);
    }

    // --- focus point chases the subject -------------------------------------
    const height = driving ? K.carHeight : K.footHeight;
    const tx = subject.position.x;
    const ty = subject.position.y + height;
    const tz = subject.position.z;
    if (!this._initialised) {
      this.focus.set(tx, ty, tz);
      this._initialised = true;
    } else {
      const a = damp(K.followLag, dt);
      this.focus.x += (tx - this.focus.x) * a;
      this.focus.y += (ty - this.focus.y) * a;
      this.focus.z += (tz - this.focus.z) * a;
    }

    // --- distance, shortened when something is in the way --------------------
    const wanted = driving ? K.carDistance : K.footDistance;
    const cp = Math.cos(this.pitch);
    this._dir.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    this._desired.copy(this.focus).addScaledVector(this._dir, wanted + 0.4);
    const hit = this.physics.raycast(this.focus, this._desired, GROUP.STATIC);
    const allowed = hit ? Math.max(1.2, hit.distance - 0.4) : wanted;
    if (allowed < this.distance) this.distance = allowed; // pull in at once: never clip into walls
    else this.distance += (allowed - this.distance) * damp(4, dt); // ease back out

    this.camera.position.copy(this.focus).addScaledVector(this._dir, this.distance);
    if (this._shake > 0.001) {
      this.camera.position.x += (Math.random() - 0.5) * this._shake;
      this.camera.position.y += (Math.random() - 0.5) * this._shake;
      this.camera.position.z += (Math.random() - 0.5) * this._shake;
      this._shake *= Math.exp(-7 * dt);
    }
    this.camera.lookAt(this.focus);

    // Speed sells itself through a widening field of view.
    const ratio = driving ? Math.min(1.4, (subject.speed || 0) / CONFIG.vehicle.maxSpeed) : 0;
    const kick = ratio * ratio * 14 + (subject.boosting ? 9 : 0);
    this._fovKick += (kick - this._fovKick) * damp(4, dt);
    const fov = K.fov + this._fovKick;
    if (Math.abs(fov - this.camera.fov) > 0.02) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Kick the camera (crashes, hard landings). amount ~0..1. */
  shake(amount) {
    this._shake = Math.min(1.2, Math.max(this._shake, amount));
  }

  resize(aspect) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
