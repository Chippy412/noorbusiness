/**
 * progress.js — the player's persistent profile: money, reputation rank,
 * garage upgrades, collected shards, statistics and settings. Stored in
 * localStorage so the game resumes where it was left.
 */
import { CONFIG } from '../config.js';

const KEY = 'neon-tide-save-v1';

const DEFAULT_SETTINGS = { volume: 0.8, music: true, quality: 'high', sensitivity: 1, invertY: false };

function freshState() {
  return {
    cash: 0,
    earned: 0,          // lifetime earnings: drives the rank
    deliveries: 0,
    upgrades: {},       // id -> level
    shards: [],         // ids of collected shards
    nitro: CONFIG.nitro.startCharges,
    hour: CONFIG.world.startHour,
    tutorial: 0,        // onboarding step reached
    legend: false,      // finale already shown
  };
}

export class Progress {
  constructor() {
    this.state = freshState();
    this.settings = { ...DEFAULT_SETTINGS };
    this.hasSave = false;
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (raw && raw.state) {
        this._saved = raw.state;
        this.hasSave = true;
      }
      if (raw && raw.settings) Object.assign(this.settings, raw.settings);
    } catch {
      // Corrupt or unavailable storage: start clean.
    }
  }

  /** Load the stored profile (Continue). */
  load() {
    if (this._saved) this.state = { ...freshState(), ...this._saved };
  }

  /** Wipe the profile (New Game / Reset progress). Settings are kept. */
  reset() {
    this.state = freshState();
    this._saved = null;
    this.hasSave = false;
    this.save();
  }

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ state: this.state, settings: this.settings }));
      this.hasSave = true;
    } catch {
      // Private mode / quota: the game simply will not persist.
    }
  }

  get maxNitro() {
    return CONFIG.nitro.startCharges + this.level('nitro');
  }

  level(id) {
    return this.state.upgrades[id] || 0;
  }

  /** Rank from lifetime earnings: { index, name, progress 0..1 to the next rank }. */
  get rank() {
    const ranks = CONFIG.ranks;
    let index = 0;
    while (index + 1 < ranks.length && this.state.earned >= ranks[index + 1].at) index++;
    const next = ranks[index + 1];
    const progress = next ? (this.state.earned - ranks[index].at) / (next.at - ranks[index].at) : 1;
    return { index, name: ranks[index].name, progress };
  }

  /** Add earnings. Returns the new rank object if this caused a rank-up, else null. */
  earn(amount) {
    const before = this.rank.index;
    this.state.cash += amount;
    this.state.earned += amount;
    const after = this.rank;
    return after.index > before ? after : null;
  }

  /** Shop rows for the HUD. */
  shopItems() {
    return CONFIG.upgrades.map((u) => {
      const level = this.level(u.id);
      return {
        id: u.id,
        name: u.name,
        desc: u.desc,
        level,
        maxLevel: u.maxLevel,
        price: u.maxLevel ? u.base * (level + 1) : u.base,
      };
    });
  }

  /** Try to buy; returns the item row on success, null if not affordable / maxed. */
  buy(id) {
    const item = this.shopItems().find((i) => i.id === id);
    if (!item || this.state.cash < item.price) return null;
    if (item.maxLevel && item.level >= item.maxLevel) return null;
    this.state.cash -= item.price;
    if (item.maxLevel) this.state.upgrades[id] = item.level + 1;
    return item;
  }
}
