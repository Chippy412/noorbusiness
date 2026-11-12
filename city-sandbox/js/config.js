/**
 * config.js — every tunable number in the game lives here.
 *
 * COORDINATE SYSTEM (shared by Three.js and cannon-es, no conversion needed):
 *   +Y is up, the ground plane is y = 0, units are metres.
 *   A "heading" is a yaw angle in radians around +Y where
 *       forward = (sin(heading), 0, cos(heading))
 *   so heading 0 faces +Z and heading PI/2 faces +X.
 *   The minimap draws world +X to the right and world +Z downwards.
 */
export const CONFIG = {
  city: {
    blocks: 4,          // the city is blocks x blocks
    blockSize: 40,      // edge length of one block (sidewalk included)
    roadWidth: 14,
    sidewalkWidth: 3,   // outer ring of each block
    curbHeight: 0.15,   // blocks are raised this much above the road
    plazaBlock: { i: 1, j: 1 }, // block without buildings: stunt plaza
    seed: 1337,
  },

  physics: {
    gravity: -20,
    fixedStep: 1 / 60,
    maxSubSteps: 4,
  },

  player: {
    radius: 0.4,
    height: 1.8,
    mass: 75,
    walkSpeed: 4.5,
    runSpeed: 9,
    jumpSpeed: 7.5,
    airControl: 0.35,     // fraction of ground acceleration available mid-air
    acceleration: 60,     // m/s^2 towards the wanted velocity
    turnRate: 14,         // how fast the model turns to face its motion
    enterRange: 4,        // max distance to a vehicle for 'F' to work
  },

  vehicle: {
    mass: 900,
    chassis: { width: 1.9, height: 0.7, length: 4.2 },
    wheelRadius: 0.38,
    engineForce: 4200,    // N per driven wheel (rear wheel drive)
    reverseForce: 2400,
    brakeForce: 55,
    handbrakeForce: 90,
    maxSpeed: 32,         // m/s forward (~115 km/h)
    maxReverseSpeed: 9,
    maxSteer: 0.55,       // rad at standstill
    minSteer: 0.09,       // rad at top speed
    steerSpeed: 3.2,      // rad/s the wheels turn towards the target angle
  },

  npc: {
    count: 14,
    walkSpeed: 1.4,
    fleeSpeed: 5.5,
    fleeRadius: 11,       // a moving vehicle closer than this scares an NPC
    calmRadius: 16,       // ...and it calms down once the vehicle is this far
    minThreatSpeed: 1.5,  // vehicles slower than this are ignored
  },

  camera: {
    fov: 62,
    footDistance: 6.5,
    carDistance: 10.5,
    footHeight: 1.5,      // look-at height above the player's feet
    carHeight: 1.3,
    minPitch: -0.25,
    maxPitch: 1.2,
    mouseSensitivity: 0.0024,
    followLag: 10,        // higher = snappier focus point
    autoAlignDelay: 1.6,  // s without mouse input before re-centring behind the car
  },

  world: {
    seaLevel: -0.6,
    dayLength: 540,       // real seconds per in-game day
    startHour: 17.2,      // golden hour: the best first impression
    // Land masses as rounded rectangles (centre, half extents, corner radius).
    land: [
      { name: 'island', x: 0, z: 0, hx: 190, hz: 190, r: 70 },
      { name: 'islet', x: 0, z: -305, hx: 50, hz: 45, r: 38 },
      { name: 'bridge', x: 0, z: -225, hx: 7, hz: 42, r: 0.5 },
      { name: 'pier', x: 228, z: 0, hx: 42, hz: 8, r: 1 },
    ],
  },

  /** Per-model handling multipliers (applied on top of CONFIG.vehicle). */
  vehicleStyles: {
    coupe: { name: 'Marlin Coupe', engine: 1.0, topSpeed: 1.0, grip: 1.0, toughness: 1.0 },
    sport: { name: 'Vespera GT', engine: 1.3, topSpeed: 1.22, grip: 1.08, toughness: 0.8 },
    van: { name: 'Pelican Van', engine: 0.85, topSpeed: 0.85, grip: 0.95, toughness: 1.5 },
  },

  nitro: { duration: 2.6, forceBoost: 2.3, speedBoost: 1.35, startCharges: 2 },

  /** Garage upgrades. price(level) = base * (level + 1). */
  upgrades: [
    { id: 'engine', name: 'Engine Tune', desc: '+12% acceleration, +7% top speed per level', base: 400, maxLevel: 3 },
    { id: 'tires', name: 'Sticky Tyres', desc: '+9% grip per level', base: 300, maxLevel: 3 },
    { id: 'nitro', name: 'Nitro Tank', desc: '+1 nitro charge capacity per level', base: 350, maxLevel: 3 },
    { id: 'armor', name: 'Reinforced Frame', desc: '-22% crash damage per level', base: 300, maxLevel: 3 },
    { id: 'repair', name: 'Full Repair', desc: 'Fix the car you arrived in', base: 60, maxLevel: 0 },
    { id: 'refill', name: 'Nitro Refill', desc: 'Fill every nitro charge', base: 80, maxLevel: 0 },
  ],

  /** Reputation ranks by total money earned. */
  ranks: [
    { name: 'Rookie', at: 0 },
    { name: 'Runner', at: 600 },
    { name: 'Courier', at: 1800 },
    { name: 'Pro Courier', at: 4000 },
    { name: 'Ace', at: 7500 },
    { name: 'Island Legend', at: 12000 },
  ],

  colors: {
    sky: 0x9fd3ff,
    road: 0x2f3237,
    sidewalk: 0x9a9da3,
    plaza: 0x6f7d6a,
    laneLine: 0xf2d24b,
    ramp: 0xff8a1e,
    wall: 0x55504a,
    crate: 0xb07a3c,
    // Pastel coastal palette for low/mid-rise, cool glass tints for towers.
    buildings: [0xf2b5a7, 0xf6d6a8, 0xa9dcd3, 0xf4efe6, 0xe9a6b8, 0xbcd4f0, 0xffe2c2, 0xc9e8b8, 0xf7c59f, 0xd6c3ee],
    towers: [0x7fa8c9, 0x6fb3b8, 0x8e9fd1, 0xa3b8c8, 0x5f93b5, 0xb08fc7],
    neon: [0xff3d9a, 0x21e6ff, 0xffb000, 0x9d5cff, 0x3dff9a],
    containers: [0xc0392b, 0x2e86c1, 0xe67e22, 0x27ae60, 0xf1c40f, 0x8e44ad, 0xecf0f1],
    vehicles: [0xe02b3a, 0xffc61a, 0x1fb6a6],
  },
};

/** The two top-level game states. */
export const MODE = Object.freeze({ ON_FOOT: 'ON_FOOT', DRIVING: 'DRIVING' });
