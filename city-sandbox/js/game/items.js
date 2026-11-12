/**
 * items.js — everything you can pick up by walking or driving through it.
 *
 *   shard   30 hidden "tide shards": permanent collectibles (saved), many of
 *           them hanging in the air where only a good jump reaches them
 *   nitro   +1 nitro charge            repair  restores the car
 *   energy  stamina refill + boost     cash    money
 *
 * Consumables respawn after a while; shards never do.
 */
import { createPickup } from '../gfx/models.js';

// [x, y, z] — y is the height of the item's centre.
const SHARDS = [
  [3.5, 3.6, 40], [37, 3.6, 50.5], [-27, 3.5, -27], [259, 5.2, 0], [-10, 1, -322], [0, 3.8, -287],
  [-27, 4.4, 164], [132, 1, 152], [27, 1.2, 20], [-108, 1, -108], [108, 1, -108], [108, 1, 108],
  [-108, 1, 108], [-54, 1, 54], [54, 1, -54], [-160, 1, -17], [132.7, 1, 34], [171, 1, -50],
  [-150, 1, 60], [-150, 1, -90], [60, 1, -150], [-70, 1, -150], [60, 1, 172], [-120, 1, 165],
  [0, 1, -225], [32, 1, -300], [215, 1, 5], [146, 1, 130], [0, 1, 108], [-166, 1, 0],
];
const CONSUMABLES = {
  nitro: [[54, 0, 0], [-54, 0, -80], [0, 0, 80], [108, 0, 54], [-108, 0, -30], [180, 0, 0], [0, 0, -160], [60, 0, 130]],
  repair: [[-54, 0, 30], [54, 0, -100], [100, 0, 130], [162, 0, -3], [-130, 0, 0]],
  energy: [[27, 0.15, 34], [-27, 0.15, -40], [-8.5, 0.15, 8.5], [80, 0, 150], [-8, 0, -300], [-100, 0, 60]],
  cash: [[-80, 0, 54], [80, 0, -54], [-54, 0, 108], [108, 0, -80], [240, 0, -5], [-100, 0, 150], [3, 0, -250], [-160, 0, 40]],
};
const RESPAWN = { nitro: 45, repair: 60, energy: 40, cash: 90 };
export const ITEM_COLORS = { shard: 0x21e6ff, nitro: 0x3d8bff, repair: 0xff5a4a, energy: 0xa6ff3d, cash: 0xffc61a };

export class ItemManager {
  /** @param {{scene: import('three').Scene, collected: number[]}} opts collected = saved shard ids */
  constructor({ scene, collected }) {
    this.scene = scene;
    /** @type {{kind:string,id:number,x:number,y:number,z:number,mesh:import('three').Object3D,active:boolean,timer:number,phase:number}[]} */
    this.items = [];
    this.shardTotal = SHARDS.length;
    this._time = 0;
    this._nearby = [];

    const add = (kind, id, x, y, z) => {
      const mesh = createPickup(kind);
      mesh.position.set(x, y, z);
      scene.add(mesh);
      this.items.push({ kind, id, x, y, z, mesh, active: true, timer: 0, phase: (x * 0.37 + z * 0.11) % 6.28 });
    };
    SHARDS.forEach(([x, y, z], id) => add('shard', id, x, y, z));
    for (const [kind, list] of Object.entries(CONSUMABLES)) {
      list.forEach(([x, y, z], id) => add(kind, id, x, y + 0.95, z));
    }
    this.setCollected(collected);
  }

  /** Reset every item, hiding the shards whose ids are in `collected`. */
  setCollected(collected) {
    const found = new Set(collected);
    for (const item of this.items) {
      item.active = !(item.kind === 'shard' && found.has(item.id));
      item.timer = 0;
      item.mesh.visible = item.active;
    }
  }

  /**
   * Animate items and test for pickups.
   * @param {number} dt
   * @param {{x:number,y:number,z:number}} point collector centre
   * @param {number} radius
   * @param {(item:object) => boolean} canTake return false to leave an item (e.g. nitro when full)
   * @returns {object[]} items collected this frame
   */
  update(dt, point, radius, canTake) {
    this._time += dt;
    const taken = [];
    for (const item of this.items) {
      if (!item.active) {
        if (item.kind !== 'shard' && (item.timer -= dt) <= 0) {
          item.active = true;
          item.mesh.visible = true;
        }
        continue;
      }
      const dx = item.x - point.x, dz = item.z - point.z;
      const flat = dx * dx + dz * dz;
      if (flat > 14400) { // far away: skip the animation
        continue;
      }
      item.mesh.rotation.y = this._time * 1.6 + item.phase;
      item.mesh.position.y = item.y + Math.sin(this._time * 2.2 + item.phase) * 0.14;
      const dy = item.y - point.y;
      if (flat + dy * dy < radius * radius && canTake(item)) {
        item.active = false;
        item.mesh.visible = false;
        item.timer = RESPAWN[item.kind] || 0;
        taken.push(item);
      }
    }
    return taken;
  }

  /** Active items within `range` of (x, z), for the minimap. */
  nearby(x, z, range) {
    const out = this._nearby;
    out.length = 0;
    const r2 = range * range;
    for (const item of this.items) {
      if (item.active && (item.x - x) ** 2 + (item.z - z) ** 2 < r2) out.push(item);
    }
    return out;
  }
}
