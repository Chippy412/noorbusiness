/**
 * npc.js — pedestrians. Pure kinematic steering, no physics bodies.
 *
 * Every NPC runs a small state machine (`npc.state`):
 *
 *   WANDER  Walk at CONFIG.npc.walkSpeed along the sidewalk graph
 *           (world.sidewalkNodes) towards a target node. On arrival pick a
 *           random neighbour (not the node we just came from, unless it is a
 *           dead end); about one time in four stand around first (-> IDLE).
 *           Each NPC aims at the node points shifted by its own fixed offset
 *           (up to 0.8 m) so a crowd does not walk in single file.
 *
 *   IDLE    Stand still for 1-4 s, then continue wandering.
 *
 *   FLEE    Entered from WANDER / IDLE when a vehicle faster than
 *           CONFIG.npc.minThreatSpeed comes within CONFIG.npc.fleeRadius.
 *           Run at CONFIG.npc.fleeSpeed away from it, blended with a sideways
 *           dodge perpendicular to the vehicle's velocity (towards the side
 *           the NPC is already on), so the NPC leaves the car's path instead
 *           of sprinting down the road in front of it. Once no threatening
 *           vehicle has been inside CONFIG.npc.calmRadius for 1.5 s, go back
 *           to WANDER, heading for the nearest graph node.
 *
 *   KNOCKED Entered from any other state when a vehicle faster than 4 m/s
 *           touches the NPC. The NPC slides along the vehicle's velocity
 *           (0.6 x its speed, decaying fast), tips over in ~0.25 s, lies
 *           there for ~3 s, stands up again and resumes WANDER via the
 *           nearest node. Cartoon slapstick only.
 *
 * In every state the position is pushed out of the building footprints
 * (expanded by 0.5 m) and clamped inside the city walls, the model turns
 * smoothly towards its direction of travel, the walk cycle is driven by the
 * distance covered, and y eases towards world.groundHeightAt().
 */
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { createHumanoid } from './characters.js';

const STATE = Object.freeze({
  WANDER: 'WANDER',
  IDLE: 'IDLE',
  FLEE: 'FLEE',
  KNOCKED: 'KNOCKED',
});

// --- tunables that are local to this module --------------------------------
const LATERAL_OFFSET = 0.8;     // max per-NPC offset from the node points (m)
const IDLE_CHANCE = 0.25;       // chance to pause when reaching a node
const IDLE_MIN = 1;             // s
const IDLE_MAX = 4;             // s
const ARRIVE_EPS = 0.05;        // m, "reached the node"
const CALM_TIME = 1.5;          // s without a threat before FLEE ends
const BUILDING_MARGIN = 0.5;    // m kept between an NPC and a building
const EDGE_MARGIN = 1.5;        // m kept between an NPC and the city wall
const TURN_RATE = 10;           // 1/s, how fast the model turns
const SPEED_RATE = 8;           // 1/s, how fast the pace changes
const GROUND_RATE = 12;         // 1/s, how fast y follows the ground
const STRIDE = 3.6;             // walk-cycle radians per metre travelled

const KNOCK_MIN_SPEED = 4;      // m/s, slower vehicles just nudge past
const KNOCK_RADIUS = 1.7;       // m from the chassis centre
const KNOCK_SKIN = 0.45;        // m from the chassis footprint (bumper hits)
const KNOCK_MAX_DY = 2;         // m, vehicle must be at roughly the NPC's level
const KNOCK_IMPULSE = 0.6;      // slide speed = this x vehicle speed
const KNOCK_FRICTION = 3.5;     // 1/s exponential decay of the slide
const KNOCK_FALL_TIME = 0.25;   // s to tip over
const KNOCK_LIE_TIME = 3;       // s on the ground
const KNOCK_RISE_TIME = 0.5;    // s to stand back up
const LIE_HEIGHT = 0.17;        // lift of the origin while lying (half a body thickness)

const SHIRTS = [0xe74c3c, 0x3498db, 0x2ecc71, 0xf1c40f, 0x9b59b6, 0xe67e22,
  0x1abc9c, 0xecf0f1, 0xff6fa5, 0x34495e, 0x8e5a2b, 0x7ed6df];
const PANTS = [0x2d3436, 0x1e3799, 0x5d4037, 0x636e72, 0x273c75, 0x3c6382,
  0x6d4c41, 0x222f3e];
const SKINS = [0xe0ac69, 0xf1c27d, 0xc68642, 0x8d5524, 0xffdbac];

const TWO_PI = Math.PI * 2;
const HALF_PI = Math.PI / 2;
const HALF_W = CONFIG.vehicle.chassis.width / 2;
const HALF_L = CONFIG.vehicle.chassis.length / 2;

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const smoothstep = (t) => t * t * (3 - 2 * t);

/** Signed shortest difference b - a between two angles, in (-PI, PI]. */
function angleDelta(a, b) {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  else if (d <= -Math.PI) d += TWO_PI;
  return d;
}

/**
 * One pedestrian. Public, read-only for other modules:
 *   position {THREE.Vector3} feet position, state {string}, heading {number},
 *   group {THREE.Group}.
 */
class NPC {
  constructor(humanoid, x, z, groundY) {
    this.group = humanoid.group;
    this.group.rotation.order = 'YXZ'; // yaw first, then tip over around the local X axis
    this.animate = humanoid.animate;

    /** Logical feet position (the mesh adds a small lift while lying down). */
    this.position = new THREE.Vector3(x, groundY, z);
    this.state = STATE.IDLE;
    this.heading = Math.random() * TWO_PI;
    this.speed = 0;               // current pace along (dirX, dirZ), m/s
    this.dirX = Math.sin(this.heading);
    this.dirZ = Math.cos(this.heading);

    // sidewalk graph navigation
    this.targetNode = -1;
    this.prevNode = -1;
    this.offsetX = (Math.random() * 2 - 1) * LATERAL_OFFSET;
    this.offsetZ = (Math.random() * 2 - 1) * LATERAL_OFFSET;
    this.walkTimeout = 0;         // s left before the current leg counts as stuck

    this.timer = Math.random() * 1.5; // IDLE time left / KNOCKED time elapsed
    this.calmTimer = 0;
    this.dodgeSide = Math.random() < 0.5 ? -1 : 1; // tie-break when dead centre

    // KNOCKED
    this.slideX = 0;
    this.slideZ = 0;
    this.fallSign = 1;            // +1 falls on its face, -1 on its back
    this.tilt = 0;                // 0 upright .. 1 lying flat

    this.walkPhase = Math.random() * TWO_PI;
    this.walkAmount = 0;
  }
}

export class NPCManager {
  /**
   * @param {object} opts
   * @param {THREE.Scene} opts.scene
   * @param {object} opts.world     sidewalkNodes, buildings, half, groundHeightAt()
   * @param {Array}  opts.vehicles  objects with position, velocity, speed, heading (read only)
   * @param {number} [opts.count]   number of NPCs, defaults to CONFIG.npc.count
   */
  constructor({ scene, world, vehicles, count = CONFIG.npc.count }) {
    this.scene = scene;
    this.world = world;
    this.vehicles = vehicles || [];
    /** @type {NPC[]} */
    this.npcs = [];

    const nodes = world.sidewalkNodes || [];

    // Shuffled node indices, so every NPC starts at a different node
    // (wraps around only if there are more NPCs than nodes).
    const order = nodes.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = order[i]; order[i] = order[j]; order[j] = t;
    }

    for (let i = 0; i < count; i++) {
      const humanoid = createHumanoid({
        shirt: SHIRTS[(i + Math.floor(Math.random() * 3)) % SHIRTS.length],
        pants: pick(PANTS),
        skin: pick(SKINS),
      });

      let x = 0;
      let z = 0;
      let start = -1;
      if (order.length > 0) {
        start = order[i % order.length];
        x = nodes[start].x;
        z = nodes[start].z;
      }
      const npc = new NPC(humanoid, x, z, 0);
      npc.position.x += npc.offsetX;
      npc.position.z += npc.offsetZ;
      this._confine(npc);
      npc.position.y = this._groundAt(npc.position.x, npc.position.z);

      // Start out standing at the spawn node for a moment, then wander off.
      npc.targetNode = start;
      npc.prevNode = -1;

      this._syncMesh(npc);
      scene.add(npc.group);
      this.npcs.push(npc);
    }
  }

  /** @param {number} dt seconds since the last frame */
  update(dt) {
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1; // tab was in the background: don't teleport

    const npcs = this.npcs;
    for (let i = 0; i < npcs.length; i++) {
      const npc = npcs[i];

      if (npc.state !== STATE.KNOCKED) this._checkKnock(npc);

      const startX = npc.position.x;
      const startZ = npc.position.z;

      switch (npc.state) {
        case STATE.WANDER: this._updateWander(npc, dt); break;
        case STATE.IDLE: this._updateIdle(npc, dt); break;
        case STATE.FLEE: this._updateFlee(npc, dt); break;
        case STATE.KNOCKED: this._updateKnocked(npc, dt); break;
      }

      this._confine(npc);
      this._finish(npc, dt, startX, startZ);
    }
  }

  // --- states ---------------------------------------------------------------

  _updateWander(npc, dt) {
    if (this._findThreat(npc, CONFIG.npc.fleeRadius)) {
      this._enterFlee(npc);
      this._updateFlee(npc, dt);
      return;
    }

    const nodes = this.world.sidewalkNodes;
    const node = nodes ? nodes[npc.targetNode] : undefined;
    if (!node) { // no graph to walk on
      npc.speed = 0;
      return;
    }

    const dx = node.x + npc.offsetX - npc.position.x;
    const dz = node.z + npc.offsetZ - npc.position.z;
    const dist = Math.hypot(dx, dz);

    npc.speed += (CONFIG.npc.walkSpeed - npc.speed) * Math.min(1, SPEED_RATE * dt);
    const step = npc.speed * dt;

    if (dist <= step + ARRIVE_EPS) {
      npc.position.x += dx;
      npc.position.z += dz;
      this._arrive(npc);
      return;
    }

    npc.dirX = dx / dist;
    npc.dirZ = dz / dist;
    npc.position.x += npc.dirX * step;
    npc.position.z += npc.dirZ * step;

    // Blocked by something (e.g. a building between us and the node after a
    // detour): give up on this leg and try another node.
    npc.walkTimeout -= dt;
    if (npc.walkTimeout <= 0) {
      const blocked = npc.targetNode;
      const neighbors = nodes[blocked].neighbors;
      const next = neighbors && neighbors.length > 0 ? pick(neighbors) : this._nearestNode(npc, blocked);
      this._setTarget(npc, next >= 0 ? next : blocked, blocked);
    }
  }

  _updateIdle(npc, dt) {
    if (this._findThreat(npc, CONFIG.npc.fleeRadius)) {
      this._enterFlee(npc);
      this._updateFlee(npc, dt);
      return;
    }
    npc.speed = 0;
    npc.timer -= dt;
    if (npc.timer <= 0) {
      npc.state = STATE.WANDER;
      this._pickNextNode(npc);
    }
  }

  _enterFlee(npc) {
    npc.state = STATE.FLEE;
    npc.calmTimer = 0;
  }

  _updateFlee(npc, dt) {
    const threat = this._findThreat(npc, CONFIG.npc.calmRadius);

    if (!threat) {
      // Nothing scary nearby any more: slow down, catch breath, then carry on.
      npc.calmTimer += dt;
      npc.speed += (0 - npc.speed) * Math.min(1, 4 * dt);
      if (npc.calmTimer >= CALM_TIME) {
        this._resumeWander(npc);
        return;
      }
    } else {
      npc.calmTimer = 0;

      // Straight away from the vehicle...
      let ax = npc.position.x - threat.position.x;
      let az = npc.position.z - threat.position.z;
      const ad = Math.hypot(ax, az);
      if (ad > 1e-4) {
        ax /= ad; az /= ad;
      } else {
        ax = npc.dirX; az = npc.dirZ;
      }

      // ...blended with a dodge perpendicular to where the vehicle is going.
      let fx = ax;
      let fz = az;
      const vx = threat.velocity.x;
      const vz = threat.velocity.z;
      const vl = Math.hypot(vx, vz);
      if (vl > 0.1) {
        const ux = vx / vl;
        const uz = vz / vl;
        // perpendicular to the velocity, pointing to the NPC's side of the path
        let px = -uz;
        let pz = ux;
        const side = ax * px + az * pz;
        const sign = Math.abs(side) > 0.02 ? Math.sign(side) : npc.dodgeSide;
        px *= sign; pz *= sign;
        // the more directly the NPC is in front of the vehicle, the more it dodges
        const ahead = Math.max(0, ax * ux + az * uz);
        const dodge = 0.5 + 1.5 * ahead;
        fx = ax + px * dodge;
        fz = az + pz * dodge;
        const fl = Math.hypot(fx, fz);
        if (fl > 1e-4) { fx /= fl; fz /= fl; } else { fx = px; fz = pz; }
      }

      npc.dirX = fx;
      npc.dirZ = fz;
      npc.speed += (CONFIG.npc.fleeSpeed - npc.speed) * Math.min(1, SPEED_RATE * dt);
    }

    npc.position.x += npc.dirX * npc.speed * dt;
    npc.position.z += npc.dirZ * npc.speed * dt;
  }

  /** Bump test against every vehicle; switches the NPC to KNOCKED on a hit. */
  _checkKnock(npc) {
    const vehicles = this.vehicles;
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      if (!(v.speed > KNOCK_MIN_SPEED)) continue;
      if (Math.abs(v.position.y - npc.position.y) > KNOCK_MAX_DY) continue;

      const dx = npc.position.x - v.position.x;
      const dz = npc.position.z - v.position.z;
      if (Math.abs(dx) > 4 || Math.abs(dz) > 4) continue;

      let hit = dx * dx + dz * dz < KNOCK_RADIUS * KNOCK_RADIUS;
      if (!hit && Number.isFinite(v.heading)) {
        // distance to the chassis footprint, so the bumpers count as well
        const s = Math.sin(v.heading);
        const c = Math.cos(v.heading);
        const ex = Math.max(Math.abs(dx * c - dz * s) - HALF_W, 0);
        const ez = Math.max(Math.abs(dx * s + dz * c) - HALF_L, 0);
        hit = ex * ex + ez * ez < KNOCK_SKIN * KNOCK_SKIN;
      }
      if (!hit) continue;

      // Slide along the vehicle's velocity (fall back to "away from it").
      let ux = v.velocity.x;
      let uz = v.velocity.z;
      let ul = Math.hypot(ux, uz);
      if (ul < 0.1) { ux = dx; uz = dz; ul = Math.hypot(ux, uz); }
      if (ul < 1e-4) { ux = Math.sin(npc.heading); uz = Math.cos(npc.heading); ul = 1; }
      ux /= ul; uz /= ul;

      const impulse = KNOCK_IMPULSE * v.speed;
      npc.slideX = ux * impulse;
      npc.slideZ = uz * impulse;
      // pushed from behind -> fall forwards, otherwise onto the back
      npc.fallSign = ux * Math.sin(npc.heading) + uz * Math.cos(npc.heading) >= 0 ? 1 : -1;
      npc.state = STATE.KNOCKED;
      npc.timer = 0;
      npc.speed = 0;
      return;
    }
  }

  _updateKnocked(npc, dt) {
    npc.timer += dt;
    const t = npc.timer;

    // slide, with quick exponential friction
    npc.position.x += npc.slideX * dt;
    npc.position.z += npc.slideZ * dt;
    const keep = Math.exp(-KNOCK_FRICTION * dt);
    npc.slideX *= keep;
    npc.slideZ *= keep;
    npc.speed = 0;

    const riseStart = KNOCK_FALL_TIME + KNOCK_LIE_TIME;
    if (t < KNOCK_FALL_TIME) {
      npc.tilt = smoothstep(t / KNOCK_FALL_TIME);
    } else if (t < riseStart) {
      npc.tilt = 1;
    } else if (t < riseStart + KNOCK_RISE_TIME) {
      npc.tilt = 1 - smoothstep((t - riseStart) / KNOCK_RISE_TIME);
    } else {
      npc.tilt = 0;
      npc.slideX = 0;
      npc.slideZ = 0;
      this._resumeWander(npc);
    }
  }

  // --- navigation -----------------------------------------------------------

  /** Reached the target node: maybe hang around, otherwise keep walking. */
  _arrive(npc) {
    if (Math.random() < IDLE_CHANCE) {
      npc.state = STATE.IDLE;
      npc.timer = IDLE_MIN + Math.random() * (IDLE_MAX - IDLE_MIN);
      npc.speed = 0;
    } else {
      this._pickNextNode(npc);
    }
  }

  /** Choose a random neighbour of the node the NPC stands on, avoiding a U-turn. */
  _pickNextNode(npc) {
    const nodes = this.world.sidewalkNodes;
    const here = nodes ? nodes[npc.targetNode] : undefined;
    if (!here) {
      this._setTarget(npc, this._nearestNode(npc, -1), -1);
      return;
    }
    const neighbors = here.neighbors || [];
    let options = 0;
    for (let i = 0; i < neighbors.length; i++) {
      if (neighbors[i] !== npc.prevNode && nodes[neighbors[i]]) options++;
    }
    let next = -1;
    if (options > 0) {
      let k = Math.floor(Math.random() * options);
      for (let i = 0; i < neighbors.length; i++) {
        if (neighbors[i] === npc.prevNode || !nodes[neighbors[i]]) continue;
        if (k-- === 0) { next = neighbors[i]; break; }
      }
    } else if (nodes[npc.prevNode]) {
      next = npc.prevNode; // dead end: turn around
    }
    if (next < 0) { // isolated node: just stand here
      npc.state = STATE.IDLE;
      npc.timer = IDLE_MAX;
      return;
    }
    this._setTarget(npc, next, npc.targetNode);
  }

  _setTarget(npc, target, prev) {
    npc.targetNode = target;
    npc.prevNode = prev;
    const node = this.world.sidewalkNodes ? this.world.sidewalkNodes[target] : undefined;
    if (!node) return;
    const dist = Math.hypot(
      node.x + npc.offsetX - npc.position.x,
      node.z + npc.offsetZ - npc.position.z
    );
    npc.walkTimeout = (dist / CONFIG.npc.walkSpeed) * 1.5 + 4;
  }

  /** Back to WANDER after FLEE / KNOCKED, via the closest graph node. */
  _resumeWander(npc) {
    npc.state = STATE.WANDER;
    npc.calmTimer = 0;
    this._setTarget(npc, this._nearestNode(npc, -1), -1);
  }

  /** Index of the graph node closest to the NPC (ignoring `exclude`), or -1. */
  _nearestNode(npc, exclude) {
    const nodes = this.world.sidewalkNodes;
    let best = -1;
    let bestD = Infinity;
    if (!nodes) return best;
    for (let i = 0; i < nodes.length; i++) {
      if (i === exclude) continue;
      const dx = nodes[i].x - npc.position.x;
      const dz = nodes[i].z - npc.position.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // --- helpers --------------------------------------------------------------

  /** Nearest vehicle moving faster than minThreatSpeed within `radius`, or null. */
  _findThreat(npc, radius) {
    const vehicles = this.vehicles;
    const minSpeed = CONFIG.npc.minThreatSpeed;
    let best = null;
    let bestD = radius * radius;
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      if (!(v.speed > minSpeed)) continue;
      const dx = v.position.x - npc.position.x;
      const dz = v.position.z - npc.position.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = v; }
    }
    return best;
  }

  /** Push the NPC out of every (expanded) building and keep it inside the city. */
  _confine(npc) {
    const p = npc.position;
    const buildings = this.world.buildings;
    if (buildings) {
      for (let i = 0; i < buildings.length; i++) {
        const b = buildings[i];
        const minX = b.minX - BUILDING_MARGIN;
        const maxX = b.maxX + BUILDING_MARGIN;
        const minZ = b.minZ - BUILDING_MARGIN;
        const maxZ = b.maxZ + BUILDING_MARGIN;
        if (p.x <= minX || p.x >= maxX || p.z <= minZ || p.z >= maxZ) continue;
        // inside: leave through the closest face
        const toMinX = p.x - minX;
        const toMaxX = maxX - p.x;
        const toMinZ = p.z - minZ;
        const toMaxZ = maxZ - p.z;
        const m = Math.min(toMinX, toMaxX, toMinZ, toMaxZ);
        if (m === toMinX) p.x = minX;
        else if (m === toMaxX) p.x = maxX;
        else if (m === toMinZ) p.z = minZ;
        else p.z = maxZ;
      }
    }
    const lim = this.world.half - EDGE_MARGIN;
    if (lim > 0) {
      if (p.x > lim) p.x = lim; else if (p.x < -lim) p.x = -lim;
      if (p.z > lim) p.z = lim; else if (p.z < -lim) p.z = -lim;
    }
  }

  _groundAt(x, z) {
    const y = this.world.groundHeightAt ? this.world.groundHeightAt(x, z) : 0;
    return Number.isFinite(y) ? y : 0;
  }

  /** Shared end-of-frame work: ground height, facing, walk cycle, mesh. */
  _finish(npc, dt, startX, startZ) {
    const p = npc.position;
    const moved = Math.hypot(p.x - startX, p.z - startZ);

    p.y += (this._groundAt(p.x, p.z) - p.y) * Math.min(1, GROUND_RATE * dt);

    let amountTarget = 0;
    if (npc.state === STATE.WANDER || npc.state === STATE.FLEE) {
      if (npc.speed > 0.2) {
        const want = Math.atan2(npc.dirX, npc.dirZ);
        npc.heading += angleDelta(npc.heading, want) * Math.min(1, TURN_RATE * dt);
        if (npc.heading > Math.PI) npc.heading -= TWO_PI;
        else if (npc.heading < -Math.PI) npc.heading += TWO_PI;
      }
      if (moved > 1e-5) {
        // longer strides when running, so the legs don't blur
        const stride = STRIDE / (1 + npc.speed * 0.12);
        npc.walkPhase = (npc.walkPhase + moved * stride) % TWO_PI;
        amountTarget = Math.min(1, moved / dt / CONFIG.npc.walkSpeed);
      }
    }
    npc.walkAmount += (amountTarget - npc.walkAmount) * Math.min(1, 10 * dt);
    npc.animate(npc.walkPhase, npc.walkAmount);

    this._syncMesh(npc);
  }

  _syncMesh(npc) {
    const g = npc.group;
    g.position.set(npc.position.x, npc.position.y + npc.tilt * LIE_HEIGHT, npc.position.z);
    g.rotation.y = npc.heading;
    g.rotation.x = npc.tilt * npc.fallSign * HALF_PI;
  }
}
