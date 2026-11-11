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
    count: 8,
    walkSpeed: 1.4,
    fleeSpeed: 5.5,
    fleeRadius: 11,       // a moving vehicle closer than this scares an NPC
    calmRadius: 16,       // ...and it calms down once the vehicle is this far
    minThreatSpeed: 1.5,  // vehicles slower than this are ignored
  },

  camera: {
    fov: 60,
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

  colors: {
    sky: 0x9fd3ff,
    road: 0x2f3237,
    sidewalk: 0x9a9da3,
    plaza: 0x6f7d6a,
    laneLine: 0xf2d24b,
    ramp: 0xff8a1e,
    wall: 0x55504a,
    crate: 0xb07a3c,
    buildings: [0x4f6d8f, 0x8f5d4f, 0x6a8f4f, 0x8f834f, 0x7a4f8f, 0x4f8f86, 0x9a9a9a, 0xb5654a],
    vehicles: [0xd8322b, 0x2b6fd8],
  },
};

/** The two top-level game states. */
export const MODE = Object.freeze({ ON_FOOT: 'ON_FOOT', DRIVING: 'DRIVING' });
