/**
 * missions.js — courier jobs.
 *
 * Every depot always has one job on offer. A job is a list of stages (drive
 * or walk into each marker in order) with a clock that starts when it is
 * accepted:
 *
 *   express   one drop-off, tight clock
 *   collect   fetch a parcel from an address, then deliver it
 *   multi     three drop-offs on one clock, pays best per metre
 *   fragile   generous clock, but every crash damages the parcel and the
 *             payout is scaled by its condition
 *
 * The manager also owns the light-pillar beacons that mark depots, the garage
 * and the current objective.
 */
import * as THREE from 'three';
import { createBeaconMaterial } from '../gfx/materials.js';

const REACH = 5.5; // metres from a marker that counts as "there"
const TYPES = [
  { id: 'express', title: 'Express Run', weight: 4, minRank: 0, pay: 1.0, time: 1.0 },
  { id: 'collect', title: 'Collection', weight: 3, minRank: 0, pay: 1.15, time: 1.05 },
  { id: 'fragile', title: 'Fragile Cargo', weight: 2, minRank: 1, pay: 1.7, time: 1.5 },
  { id: 'multi', title: 'Multi-Drop', weight: 2, minRank: 1, pay: 1.35, time: 0.95 },
];
const CARGO = ['Sushi platter', 'Vinyl crate', 'Surfboard wax', 'Neon tubes', 'Tax documents', 'Birthday cake',
  'Aquarium fish', 'Synth module', 'Flamingo statue', 'Mystery box', 'Legal papers', 'Hot pizzas'];
const COLORS = { job: 0x21e6ff, garage: 0xff3d9a, pickup: 0xffb000, dropoff: 0x3dff9a };

export class MissionManager {
  /**
   * @param {{scene: THREE.Scene, world: import('../world.js').World}} opts
   */
  constructor({ scene, world }) {
    this.world = world;
    this.active = null;
    this.completed = 0;
    this._events = [];

    // Beacons: one per depot, one for the garage, one for the objective.
    const geometry = new THREE.CylinderGeometry(2.6, 2.6, 46, 28, 1, true).translate(0, 23, 0);
    const beacon = (kind, x, z) => {
      const mesh = new THREE.Mesh(geometry, createBeaconMaterial(COLORS[kind]));
      mesh.position.set(x, 0, z);
      mesh.renderOrder = 3;
      mesh.frustumCulled = false;
      scene.add(mesh);
      return mesh;
    };
    this._depotBeacons = world.depots.map((d) => beacon('job', d.x, d.z));
    this._garageBeacon = beacon('garage', world.garage.x, world.garage.z);
    this._targetBeacons = { pickup: beacon('pickup', 0, 0), dropoff: beacon('dropoff', 0, 0) };
    this._targetBeacons.pickup.visible = this._targetBeacons.dropoff.visible = false;

    this.offers = world.depots.map((d) => this._generate(d, 0));
  }

  /** The depot (with its offer) whose marker contains (x, z), or null. */
  depotAt(x, z) {
    for (let i = 0; i < this.world.depots.length; i++) {
      const d = this.world.depots[i];
      if (Math.hypot(d.x - x, d.z - z) < REACH) return { depot: d, index: i, offer: this.offers[i] };
    }
    return null;
  }

  atGarage(x, z) {
    return Math.hypot(this.world.garage.x - x, this.world.garage.z - z) < REACH + 1;
  }

  _generate(depot, rankIndex) {
    const pool = TYPES.filter((t) => t.minRank <= rankIndex);
    let roll = Math.random() * pool.reduce((s, t) => s + t.weight, 0);
    const type = pool.find((t) => (roll -= t.weight) < 0) || pool[0];

    // Pick addresses far enough from the depot and from each other.
    const far = (a, from, min) => Math.hypot(a.x - from.x, a.z - from.z) > min;
    const pick = (from, min, used) => {
      const options = this.world.addresses.filter((a) => far(a, from, min) && !used.includes(a));
      const list = options.length ? options : this.world.addresses;
      const a = list[Math.floor(Math.random() * list.length)];
      used.push(a);
      return a;
    };
    const used = [];
    const stages = [];
    let from = depot;
    const leg = (kind, min) => {
      const a = pick(from, min, used);
      stages.push({ kind, x: a.x, z: a.z, name: a.name });
      from = a;
    };
    if (type.id === 'collect') leg('pickup', 60);
    const drops = type.id === 'multi' ? 3 : 1;
    for (let n = 0; n < drops; n++) leg('dropoff', type.id === 'multi' ? 70 : 110);

    // Manhattan-ish route length drives both the clock and the pay.
    let distance = 0;
    let p = depot;
    for (const s of stages) {
      distance += Math.abs(s.x - p.x) + Math.abs(s.z - p.z);
      p = s;
    }
    const time = Math.round((16 + distance / 10.5 + stages.length * 3) * type.time);
    const payout = Math.round(((70 + distance * 0.62) * type.pay * (1 + rankIndex * 0.12)) / 5) * 5;
    const cargo = CARGO[Math.floor(Math.random() * CARGO.length)];
    return { type: type.id, title: `${type.title}: ${cargo}`, stages, time, payout, fragile: type.id === 'fragile' };
  }

  /** Start the job offered at depot `index`; a fresh offer replaces it. */
  accept(index, rankIndex) {
    const offer = this.offers[index];
    this.active = { ...offer, stage: 0, timeLeft: offer.time, integrity: offer.fragile ? 1 : null };
    this.offers[index] = this._generate(this.world.depots[index], rankIndex);
    this._showTarget();
    return this.active;
  }

  /** Abandon / clear the current job without reward. */
  cancel() {
    this.active = null;
    this._showTarget();
  }

  /** Crashes hurt fragile cargo. */
  notifyImpact(speed) {
    const m = this.active;
    if (!m || m.integrity === null) return;
    m.integrity = Math.max(0, m.integrity - (speed - 3.5) * 0.035);
    if (m.integrity === 0) this._fail('The cargo is wrecked');
  }

  _fail(reason) {
    this._events.push({ type: 'failed', reason, title: this.active.title });
    this.cancel();
  }

  _showTarget() {
    const m = this.active;
    const stage = m && m.stages[m.stage];
    for (const [kind, mesh] of Object.entries(this._targetBeacons)) {
      mesh.visible = !!stage && stage.kind === kind;
      if (mesh.visible) mesh.position.set(stage.x, 0, stage.z);
    }
    for (const b of this._depotBeacons) b.visible = !m;
  }

  /**
   * @param {number} dt
   * @param {{x:number,y:number,z:number}} pos the player (or their car)
   * @returns {object[]} events: {type:'stage'|'complete'|'failed'|'tick', ...}
   */
  update(dt, pos) {
    const events = this._events;
    this._events = [];
    const m = this.active;
    if (!m) return events;

    const before = Math.ceil(m.timeLeft);
    m.timeLeft -= dt;
    if (m.timeLeft <= 0) {
      this._fail('Out of time');
      return events.concat(this._events.splice(0));
    }
    if (before <= 10 && Math.ceil(m.timeLeft) < before) events.push({ type: 'tick' });

    const stage = m.stages[m.stage];
    if (Math.hypot(stage.x - pos.x, stage.z - pos.z) < REACH && pos.y < 4) {
      m.stage++;
      if (m.stage >= m.stages.length) {
        const condition = m.integrity === null ? 1 : 0.4 + 0.6 * m.integrity;
        const base = Math.round((m.payout * condition) / 5) * 5;
        const bonus = Math.round((m.timeLeft * 3) / 5) * 5;
        this.completed++;
        events.push({ type: 'complete', title: m.title, payout: base, bonus, timeLeft: m.timeLeft });
        this.cancel();
      } else {
        events.push({ type: 'stage', stage: m.stages[m.stage], done: stage });
        this._showTarget();
      }
    }
    return events;
  }

  /** Mission block for the HUD, or null. */
  hudState() {
    const m = this.active;
    if (!m) return null;
    const stage = m.stages[m.stage];
    const left = m.stages.length - m.stage;
    const verb = stage.kind === 'pickup' ? 'Collect from' : 'Deliver to';
    return {
      title: m.title,
      objective: `${verb} ${stage.name}${left > 1 ? ` (${left} stops left)` : ''}`,
      timeLeft: m.timeLeft,
      timeTotal: m.time,
      payout: m.payout,
      integrity: m.integrity,
    };
  }

  /** Map markers for the HUD. */
  markers() {
    const out = [{ x: this.world.garage.x, z: this.world.garage.z, kind: 'garage', label: this.world.garage.name }];
    const m = this.active;
    if (m) {
      const s = m.stages[m.stage];
      out.push({ x: s.x, z: s.z, kind: s.kind, label: s.name });
    } else {
      for (const d of this.world.depots) out.push({ x: d.x, z: d.z, kind: 'job', label: d.name });
    }
    return out;
  }
}
