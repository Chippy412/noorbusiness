/**
 * world.js — builds Neon Tide's overworld: a tropical island city.
 *
 *   - Main island: a 4x4 downtown grid (glass towers in the core, pastel
 *     low-rises around it), ringed by a park belt (west/north), a container
 *     harbour and pier (east) and a beach boulevard (south).
 *   - A bridge north to Lighthouse Key, a small islet.
 *
 * PHYSICS: the ground is one infinite plane at y = 0. Whether a point is land
 * or sea is decided analytically by `landDistance()` (signed distance to the
 * union of rounded rectangles in CONFIG.world.land); the game treats anything
 * past the shoreline as "fell in the water". Everything solid (buildings,
 * raised blocks, ramps, containers, trees, lamps...) has a static box collider.
 *
 * Data exposed for other systems:
 *   half (city grid half-size), bounds, land, roads, blocks, buildings, ramps,
 *   sidewalkNodes, depots, garage, addresses, spawn,
 *   groundHeightAt(x,z), landDistance(x,z), update(dt)
 */
import * as THREE from 'three';
import { CONFIG } from './config.js';
import {
  createBuildingMaterial, createGroundMaterial, createLampMaterial, createNeonMaterial, shared,
} from './gfx/materials.js';
import {
  getPropTemplate, createLighthouse, createGarage, createDepot, createFerrisWheel,
  createBillboard, createFountain, createBridgeArch, createRamp,
} from './gfx/models.js';

/** Small deterministic PRNG so the island is identical on every load. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Collider footprints (width, height, depth) for instanced props; absent = no collider. */
const PROP_COLLIDERS = {
  tree_round: [0.6, 5, 0.6],
  tree_pine: [0.6, 6, 0.6],
  palm: [0.5, 6, 0.5],
  street_lamp: [0.3, 6, 0.3],
  bench: [1.8, 0.9, 0.7],
  hydrant: [0.45, 0.8, 0.45],
  trash_bin: [0.6, 1.0, 0.6],
  bollard: [0.3, 0.9, 0.3],
  planter: [1.1, 0.7, 1.1],
  rock: [1.5, 1.1, 1.5],
  container: [2.44, 2.6, 6.1],
  umbrella: [0.2, 2.2, 0.2],
};

const STREETS_NS = ['Seagrass Ave', 'Coral Ave', 'Meridian Ave', 'Palm Ave', 'Harbor Ave'];
const STREETS_EW = ['Lighthouse St', 'Pelican St', 'Sunset Blvd', 'Tide St', 'Boardwalk St'];

export class World {
  /** @param {{scene: THREE.Scene, physics: import('./physics.js').Physics}} opts */
  constructor({ scene, physics }) {
    const C = CONFIG.city;
    this.scene = scene;
    this.physics = physics;
    this.rand = mulberry32(C.seed);

    this.pitch = C.blockSize + C.roadWidth;
    this.size = C.blocks * C.blockSize + (C.blocks + 1) * C.roadWidth;
    /** Half-size of the downtown grid (NPCs stay inside it). */
    this.half = this.size / 2;

    this.land = CONFIG.world.land;
    this.bounds = { minX: -330, maxX: 330, minZ: -400, maxZ: 260 };
    /** @type {{x1:number,z1:number,x2:number,z2:number,width:number,ext?:boolean}[]} */
    this.roads = [];
    this.blocks = [];
    this.buildings = [];
    this.ramps = [];
    this.sidewalkNodes = [];
    /** Named delivery addresses: {name, x, z}. */
    this.addresses = [];

    this._materials = new Map();
    this._instances = new Map(); // prop kind -> [{matrix, color}]
    this._animated = [];
    this._dummy = new THREE.Object3D();
    this._lampSpots = [];
    this._neon = CONFIG.colors.neon.map((c) => createNeonMaterial(c));

    this._buildRoadData();
    this._buildLand();
    this._buildBlocks();
    this._buildLaneLines();
    this._buildRamps();
    this._buildStreetFurniture();
    this._buildHarbour();
    this._buildBeach();
    this._buildParkBelt();
    this._buildIslet();
    this._buildServices();
    this._buildSidewalkGraph();
    this._flushInstances();
    this._buildLampPools();

    this.spawn = {
      player: { x: -2.5, z: -16, heading: 0 },
      vehicles: [
        { x: 3.5, z: -12, heading: 0, style: 'coupe' },
        { x: -150, z: 3.2, heading: Math.PI / 2, style: 'sport' },
        { x: 140, z: -3.2, heading: -Math.PI / 2, style: 'van' },
      ],
    };
  }

  // ===========================================================================
  // Queries
  // ===========================================================================

  /** Road centre line number k (0..blocks) of the downtown grid. */
  roadCenter(k) {
    return -this.half + CONFIG.city.roadWidth / 2 + k * this.pitch;
  }

  /** Walkable ground height at (x, z): curb height on a city block, else 0. */
  groundHeightAt(x, z) {
    return this._onBlock(x) && this._onBlock(z) ? CONFIG.city.curbHeight : 0;
  }

  _onBlock(v) {
    const local = (((v + this.half) % this.pitch) + this.pitch) % this.pitch;
    return Math.abs(v) < this.half && local > CONFIG.city.roadWidth;
  }

  /** Signed distance (m) to the shoreline: negative on land, positive at sea. */
  landDistance(x, z) {
    let best = Infinity;
    for (const s of this.land) {
      const qx = Math.abs(x - s.x) - (s.hx - s.r);
      const qz = Math.abs(z - s.z) - (s.hz - s.r);
      const d = Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - s.r;
      if (d < best) best = d;
    }
    return best;
  }

  /** Distance from (x, z) to the nearest road centre line minus half its width. */
  roadDistance(x, z) {
    let best = Infinity;
    for (const r of this.roads) {
      const dx = r.x2 - r.x1, dz = r.z2 - r.z1;
      const t = Math.max(0, Math.min(1, ((x - r.x1) * dx + (z - r.z1) * dz) / (dx * dx + dz * dz)));
      const d = Math.hypot(x - (r.x1 + dx * t), z - (r.z1 + dz * t)) - r.width / 2;
      if (d < best) best = d;
    }
    return best;
  }

  /** True if a decoration may be placed here: on land, off roads, outside downtown. */
  _free(x, z, margin = 2) {
    return (
      this.landDistance(x, z) < -4 &&
      this.roadDistance(x, z) > margin &&
      (Math.abs(x) > this.half + 2 || Math.abs(z) > this.half + 2)
    );
  }

  /** Per-frame animation of set pieces. */
  update(dt) {
    for (const a of this._animated) a(dt);
  }

  // ===========================================================================
  // Builders: helpers
  // ===========================================================================

  _ground(kind, layer = 0) {
    const key = `ground:${kind}`;
    let m = this._materials.get(key);
    if (!m) {
      m = createGroundMaterial(kind);
      // Stacked flat surfaces: bias depth so layers never z-fight at distance.
      m.polygonOffset = layer > 0;
      m.polygonOffsetFactor = -layer;
      m.polygonOffsetUnits = -layer * 2;
      this._materials.set(key, m);
    }
    return m;
  }

  _plain(color, opts = {}) {
    const key = `plain:${color}:${opts.roughness ?? ''}`;
    let m = this._materials.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color, roughness: opts.roughness ?? 0.85, metalness: opts.metalness ?? 0 });
      this._materials.set(key, m);
    }
    return m;
  }

  /** Box mesh with an optional static collider. */
  _box(center, size, material, { collide = true, quaternion = null, shadow = true, visible = true } = {}) {
    if (visible) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), material);
      mesh.position.set(center.x, center.y, center.z);
      if (quaternion) mesh.quaternion.copy(quaternion);
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    }
    if (collide) this.physics.addStaticBox(center, size, quaternion);
  }

  /** Flat rectangle lying on the ground (visual only). */
  _decal(x, z, w, d, y, material, yaw = 0) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), material);
    mesh.rotation.set(-Math.PI / 2, 0, yaw, 'YXZ');
    mesh.rotation.y = yaw;
    mesh.position.set(x, y, z);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  /** Queue one instance of a prop template (drawn by _flushInstances). */
  _place(kind, x, y, z, yaw = 0, scale = 1, color = null, collide = true) {
    const d = this._dummy;
    d.position.set(x, y, z);
    d.rotation.set(0, yaw, 0);
    d.scale.setScalar(scale);
    d.updateMatrix();
    if (!this._instances.has(kind)) this._instances.set(kind, []);
    this._instances.get(kind).push({ matrix: d.matrix.clone(), color });

    const c = PROP_COLLIDERS[kind];
    if (collide && c) {
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      this.physics.addStaticBox(
        { x, y: y + (c[1] * scale) / 2, z },
        { x: c[0] * scale, y: c[1] * scale, z: c[2] * scale },
        q
      );
    }
  }

  /** Turn every queued prop into InstancedMeshes (one per template part). */
  _flushInstances() {
    const lampMaterial = createLampMaterial();
    const tint = new THREE.Color();
    for (const [kind, list] of this._instances) {
      const parts = getPropTemplate(kind);
      for (const part of parts) {
        const material = part.name === 'bulb' ? lampMaterial : part.material;
        const mesh = new THREE.InstancedMesh(part.geometry, material, list.length);
        list.forEach((inst, n) => {
          mesh.setMatrixAt(n, inst.matrix);
          if (inst.color !== null && part.name !== 'bulb') mesh.setColorAt(n, tint.set(inst.color));
        });
        mesh.castShadow = kind !== 'bush';
        mesh.receiveShadow = true;
        mesh.instanceMatrix.needsUpdate = true;
        this.scene.add(mesh);
      }
    }
  }

  /** Free-standing dynamic prop made from a template whose origin is its centre. */
  _dynamicProp(kind, x, y, z, size, mass) {
    const group = new THREE.Group();
    for (const part of getPropTemplate(kind)) {
      const mesh = new THREE.Mesh(part.geometry, part.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    this.scene.add(group);
    this.physics.addDynamicBox({ x, y, z }, size, mass, group);
  }

  _setPiece(group, x, y, z, yaw = 0) {
    group.position.set(x, y, z);
    group.rotation.y = yaw;
    group.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.scene.add(group);
    return group;
  }

  // ===========================================================================
  // Builders: terrain
  // ===========================================================================

  _buildRoadData() {
    const C = CONFIG.city;
    const h = this.half;
    for (let k = 0; k <= C.blocks; k++) {
      const c = this.roadCenter(k);
      this.roads.push({ x1: c, z1: -h, x2: c, z2: h, width: C.roadWidth });
      this.roads.push({ x1: -h, z1: c, x2: h, z2: c, width: C.roadWidth });
    }
    const ext = (x1, z1, x2, z2, width = 12) => this.roads.push({ x1, z1, x2, z2, width, ext: true });
    ext(0, -h, 0, -292, 11);        // north: bridge road to Lighthouse Key
    ext(h, 0, 266, 0, 11);          // east: harbour road and pier
    ext(-h, 0, -168, 0);            // west: garage road
    ext(-108, h, -108, 130);        // south connectors
    ext(0, h, 0, 130);
    ext(108, h, 108, 130);
    ext(-146, 130, 146, 130);       // beach boulevard
  }

  /** Extruded rounded-rectangle land mass with a sloping shore. */
  _landMesh(s, material, slope, y = 0) {
    const shape = new THREE.Shape();
    const { hx, hz, r } = s;
    shape.moveTo(-hx + r, -hz);
    shape.lineTo(hx - r, -hz);
    shape.absarc(hx - r, -hz + r, r, -Math.PI / 2, 0, false);
    shape.lineTo(hx, hz - r);
    shape.absarc(hx - r, hz - r, r, 0, Math.PI / 2, false);
    shape.lineTo(-hx + r, hz);
    shape.absarc(-hx + r, hz - r, r, Math.PI / 2, Math.PI, false);
    shape.lineTo(-hx, -hz + r);
    shape.absarc(-hx + r, -hz + r, r, Math.PI, Math.PI * 1.5, false);
    const thickness = slope > 1 ? 1.6 : 0.3;
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: 4,
      curveSegments: 20,
      bevelEnabled: true,
      bevelThickness: thickness,
      bevelSize: slope,
      bevelSegments: slope > 1 ? 4 : 1,
    });
    // Shape XY -> world XZ, extrusion -> downwards; top cap ends up at y.
    geometry.rotateX(Math.PI / 2);
    geometry.translate(s.x, y - thickness, s.z);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  _buildLand() {
    const [island, islet, bridge, pier] = this.land;
    this.physics.addGroundPlane();
    this._landMesh(island, this._ground('sand'), 8);
    this._landMesh(islet, this._ground('sand'), 7);
    this._landMesh(bridge, this._ground('concrete', 1), 0.4, 0.03);
    this._landMesh(pier, this._ground('wood', 1), 0.3, 0.03);

    // Grass interior (leaves a sand rim; the wide southern rim is the beach).
    const grass = this._ground('grass', 1);
    this._landMesh({ x: 0, z: -14, hx: 166, hz: 154, r: 48 }, grass, 0.01, 0.04);
    this._landMesh({ x: 0, z: -305, hx: 36, hz: 31, r: 26 }, grass, 0.01, 0.04);

    // Downtown asphalt and the roads leading out of it.
    const asphalt = this._ground('asphalt', 2);
    this._decal(0, 0, this.size, this.size, 0.06, asphalt);
    for (const r of this.roads) {
      if (!r.ext) continue;
      const len = Math.hypot(r.x2 - r.x1, r.z2 - r.z1);
      const alongX = Math.abs(r.x2 - r.x1) > Math.abs(r.z2 - r.z1);
      this._decal((r.x1 + r.x2) / 2, (r.z1 + r.z2) / 2, alongX ? len : r.width, alongX ? r.width : len, 0.07, asphalt);
    }

    // Bridge: decorative arch plus solid railings so cars stay on it.
    this._setPiece(createBridgeArch(84), bridge.x, 0.03, bridge.z);
    for (const side of [-1, 1]) {
      this._box({ x: side * 6.5, y: 0.6, z: bridge.z }, { x: 0.4, y: 1.2, z: 84 }, null, { visible: false });
    }
  }

  // ===========================================================================
  // Builders: downtown
  // ===========================================================================

  _buildBlocks() {
    const C = CONFIG.city;
    const sidewalk = this._ground('sidewalk');
    for (let j = 0; j < C.blocks; j++) {
      for (let i = 0; i < C.blocks; i++) {
        const cx = this.roadCenter(i) + this.pitch / 2;
        const cz = this.roadCenter(j) + this.pitch / 2;
        const h = C.blockSize / 2;
        let type = 'buildings';
        if (i === C.plazaBlock.i && j === C.plazaBlock.j) type = 'plaza';
        if (i === 2 && j === 2) type = 'park';
        const block = { i, j, cx, cz, minX: cx - h, maxX: cx + h, minZ: cz - h, maxZ: cz + h, type };
        this.blocks.push(block);

        // Raised slab: its rim is the sidewalk.
        this._box(
          { x: cx, y: C.curbHeight / 2, z: cz },
          { x: C.blockSize, y: C.curbHeight, z: C.blockSize },
          sidewalk,
          { shadow: false }
        );

        const inner = C.blockSize - 2 * C.sidewalkWidth;
        if (type === 'plaza') {
          this._decal(cx, cz, inner, inner, C.curbHeight + 0.02, this._ground('plaza', 1));
        } else if (type === 'park') {
          this._decal(cx, cz, inner, inner, C.curbHeight + 0.02, this._ground('grass', 1));
          this._buildPark(block, inner);
        } else {
          this._buildBuildings(block, inner);
        }
      }
    }
  }

  _buildPark(block, inner) {
    const rand = this.rand;
    const y = CONFIG.city.curbHeight;
    this._setPiece(createFountain(), block.cx, y, block.cz);
    this.physics.addStaticBox({ x: block.cx, y: y + 0.5, z: block.cz }, { x: 5, y: 1, z: 5 });
    for (let n = 0; n < 12; n++) {
      const a = (n / 12) * Math.PI * 2 + rand() * 0.3;
      const r = 9 + rand() * 6;
      this._place(n % 3 ? 'tree_round' : 'palm', block.cx + Math.cos(a) * r, y, block.cz + Math.sin(a) * r, rand() * 6, 0.85 + rand() * 0.4);
    }
    for (let n = 0; n < 4; n++) {
      const a = (n / 4) * Math.PI * 2 + Math.PI / 4;
      this._place('bench', block.cx + Math.cos(a) * 5.5, y, block.cz + Math.sin(a) * 5.5, -a + Math.PI / 2);
    }
    for (let n = 0; n < 10; n++) {
      this._place('bush', block.cx + (rand() - 0.5) * inner * 0.9, y, block.cz + (rand() - 0.5) * inner * 0.9, rand() * 6, 0.8 + rand() * 0.6);
    }
    this.addresses.push({ name: 'Fountain Park', x: block.cx, z: block.minZ - 3.5 });
  }

  /** Fill a block's inner lot with 1, 2 or 4 buildings; taller towards the core. */
  _buildBuildings(block, inner) {
    const rand = this.rand;
    const K = CONFIG.colors;
    const base = CONFIG.city.curbHeight;
    const core = 1 - Math.min(1, Math.hypot(block.cx, block.cz) / (this.half * 1.05)); // 1 centre .. 0 edge

    const r = rand();
    const cols = r < 0.25 ? 1 : 2;
    const rows = r < 0.25 ? 1 : r < 0.6 ? 1 : 2;
    const swap = rand() < 0.5;
    const nx = swap ? rows : cols;
    const nz = swap ? cols : rows;
    const cellW = inner / nx;
    const cellD = inner / nz;
    const gap = 1.2;

    for (let a = 0; a < nx; a++) {
      for (let b = 0; b < nz; b++) {
        const w = cellW - 2 * gap - rand() * 2.5;
        const d = cellD - 2 * gap - rand() * 2.5;
        const height = Math.round(7 + rand() * 9 + core * core * (25 + rand() * 55));
        const x = block.cx - inner / 2 + cellW * (a + 0.5);
        const z = block.cz - inner / 2 + cellD * (b + 0.5);
        const tower = height > 34;
        const style = tower ? 2 : height > 16 ? 0 : 1;
        const palette = tower ? K.towers : K.buildings;
        const color = palette[Math.floor(rand() * palette.length)];
        const material = createBuildingMaterial({ color, seed: Math.floor(rand() * 1e5), style });

        this._box({ x, y: base + height / 2, z }, { x: w, y: height, z: d }, material);
        let top = base + height;
        if (tower) {
          // Setback crown section (visual only: nobody can reach it).
          const h2 = Math.round(height * (0.2 + rand() * 0.25));
          this._box({ x, y: top + h2 / 2, z }, { x: w * 0.68, y: h2, z: d * 0.68 }, material, { collide: false });
          this._neonCrown(x, top + h2, z, w * 0.68, d * 0.68);
          this._neonCrown(x, top, z, w, d);
          top += h2;
          // Antenna mast.
          this._box({ x, y: top + 4, z }, { x: 0.3, y: 8, z: 0.3 }, this._plain(0x9aa3ad, { metalness: 0.6 }), { collide: false });
        } else {
          // Rooftop plant room.
          this._box(
            { x: x + (rand() - 0.5) * w * 0.3, y: top + 0.8, z: z + (rand() - 0.5) * d * 0.3 },
            { x: w * 0.3, y: 1.6, z: d * 0.3 },
            this._plain(0x6c7078),
            { collide: false }
          );
          if (rand() < 0.55) this._neonSign(block, x, z, w, d);
        }
        this.buildings.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, height, color });
      }
    }

    // One delivery address per block, in the lane beside a random edge.
    const side = Math.floor(rand() * 4);
    const off = CONFIG.city.blockSize / 2 + 3.5;
    const ax = block.cx + [0, off, 0, -off][side];
    const az = block.cz + [-off, 0, off, -0][side] + (side === 3 ? 0 : 0);
    const street = side % 2 === 0
      ? STREETS_EW[block.j + (side === 2 ? 1 : 0)]
      : STREETS_NS[block.i + (side === 1 ? 1 : 0)];
    this.addresses.push({ name: `${10 + Math.floor(rand() * 89)} ${street}`, x: ax, z: az });
  }

  /** Thin glowing band around a tower's roof line. */
  _neonCrown(x, y, z, w, d) {
    const m = this._neon[Math.floor(this.rand() * this._neon.length)];
    const t = 0.22;
    const opts = { collide: false, shadow: false };
    this._box({ x, y, z: z - d / 2 }, { x: w + t, y: t, z: t }, m, opts);
    this._box({ x, y, z: z + d / 2 }, { x: w + t, y: t, z: t }, m, opts);
    this._box({ x: x - w / 2, y, z }, { x: t, y: t, z: d + t }, m, opts);
    this._box({ x: x + w / 2, y, z }, { x: t, y: t, z: d + t }, m, opts);
  }

  /** Neon shop sign on the facade nearest the street. */
  _neonSign(block, x, z, w, d) {
    const m = this._neon[Math.floor(this.rand() * this._neon.length)];
    const toEdge = [
      [Math.abs(z - d / 2 - block.minZ), 0, -1],
      [Math.abs(block.maxZ - (z + d / 2)), 0, 1],
      [Math.abs(x - w / 2 - block.minX), -1, 0],
      [Math.abs(block.maxX - (x + w / 2)), 1, 0],
    ].sort((p, q) => p[0] - q[0])[0];
    const [, sx, sz] = toEdge;
    const len = (sx ? d : w) * (0.35 + this.rand() * 0.3);
    const y = CONFIG.city.curbHeight + 4.3;
    this._box(
      { x: x + sx * (w / 2 + 0.12), y, z: z + sz * (d / 2 + 0.12) },
      sx ? { x: 0.14, y: 0.55, z: len } : { x: len, y: 0.55, z: 0.14 },
      m,
      { collide: false, shadow: false }
    );
  }

  /** Dashed centre lines on every grid road and the long roads out of town. */
  _buildLaneLines() {
    const spots = [];
    for (let k = 0; k <= CONFIG.city.blocks; k++) {
      const c = this.roadCenter(k);
      for (let s = -this.half + 2.5; s < this.half; s += 5) {
        if (!this._onBlock(s)) continue; // inside an intersection
        spots.push({ x: c, z: s, yaw: 0 });
        spots.push({ x: s, z: c, yaw: Math.PI / 2 });
      }
    }
    for (const r of this.roads) {
      if (!r.ext) continue;
      const len = Math.hypot(r.x2 - r.x1, r.z2 - r.z1);
      const yaw = Math.atan2(r.x2 - r.x1, r.z2 - r.z1);
      for (let s = 4; s < len - 2; s += 6) {
        spots.push({ x: r.x1 + Math.sin(yaw) * s, z: r.z1 + Math.cos(yaw) * s, yaw });
      }
    }
    const mesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.24, 2.4).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({
        color: 0xf4d35e, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8,
      }),
      spots.length
    );
    spots.forEach((s, n) => {
      this._dummy.position.set(s.x, 0.09, s.z);
      this._dummy.rotation.set(0, s.yaw, 0);
      this._dummy.scale.setScalar(1);
      this._dummy.updateMatrix();
      mesh.setMatrixAt(n, this._dummy.matrix);
    });
    mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  /**
   * Stunt ramp. Physics is a tilted slab whose top face is exactly the plane
   * from the low edge (ground) to the high edge, plus blocks filling the space
   * underneath; the visual is the matching wedge model.
   */
  _addRamp(x, z, yaw, length, width, height, baseY = 0) {
    this._setPiece(createRamp(width, length, height), x, baseY, z, yaw);

    const angle = Math.atan2(height, length);
    const t = 0.4;
    const slab = Math.hypot(length, height);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-angle, yaw, 0, 'YXZ'));
    const back = (t / 2) * Math.sin(angle); // slab centre sits behind/below the top face
    this.physics.addStaticBox(
      { x: x + Math.sin(yaw) * back, y: baseY + height / 2 - (t / 2) * Math.cos(angle), z: z + Math.cos(yaw) * back },
      { x: width, y: t, z: slab },
      q
    );
    const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    for (const f of [0.55, 0.95]) {
      const h = height * f - 0.45;
      if (h < 0.2) continue;
      const along = (f - 0.5) * length - 0.2;
      this.physics.addStaticBox(
        { x: x + Math.sin(yaw) * along, y: baseY + h / 2, z: z + Math.cos(yaw) * along },
        { x: width, y: h, z: f > 0.9 ? 0.5 : length * 0.38 },
        qYaw
      );
    }
    this.ramps.push({ x, z, width, length, yaw });
  }

  _buildRamps() {
    const curb = CONFIG.city.curbHeight;
    this._addRamp(3.5, 30, 0, 8.8, 4.6, 2.2);                 // Meridian Ave jump
    this._addRamp(27, 50.5, Math.PI / 2, 8.8, 4.6, 2.2);      // Tide St jump
    this._addRamp(-40, 164, Math.PI / 2, 10, 5.5, 2.8);       // beach launcher
    this._addRamp(246, 0, Math.PI / 2, 11, 6, 3.4);           // pier's end: into the bay
    this._addRamp(0, -276, Math.PI, 9, 5, 2.4);               // Lighthouse Key

    const plaza = this.blocks.find((b) => b.type === 'plaza');
    this._addRamp(plaza.cx - 9, plaza.cz, Math.PI / 2, 6.8, 5, 2.05, curb);
    this._addRamp(plaza.cx + 9, plaza.cz, -Math.PI / 2, 6.8, 5, 2.05, curb);
    // A pyramid of loose crates and some cones to scatter.
    [3, 2, 1].forEach((count, level) => {
      for (let n = 0; n < count; n++) {
        this._dynamicProp('crate', plaza.cx + (n - (count - 1) / 2) * 1.05, curb + 0.51 + level, plaza.cz + 11, { x: 1, y: 1, z: 1 }, 22);
      }
    });
    for (let n = 0; n < 6; n++) {
      this._dynamicProp('traffic_cone', plaza.cx - 12 + n * 2.2, curb + 0.36, plaza.cz - 11, { x: 0.42, y: 0.7, z: 0.42 }, 4);
    }
    for (const [dx, dz] of [[-14, -14], [14, -14], [-14, 14], [14, 14]]) {
      this._place('planter', plaza.cx + dx, curb, plaza.cz + dz);
    }
  }

  /** Lamps, palms, hydrants and bins along every block edge and road. */
  _buildStreetFurniture() {
    const rand = this.rand;
    const y = CONFIG.city.curbHeight;
    const inset = 0.5; // from the curb, clear of where pedestrians walk
    for (const b of this.blocks) {
      const h = CONFIG.city.blockSize / 2 - inset;
      // side: [direction along the edge, outward normal]
      const sides = [[1, 0, 0, -1], [0, 1, 1, 0], [-1, 0, 0, 1], [0, -1, -1, 0]];
      for (const [ax, az, nx, nz] of sides) {
        const yaw = Math.atan2(nx, nz); // lamp arm reaches over the road
        for (const t of [-0.52, 0.52]) {
          const x = b.cx + nx * h + ax * h * t;
          const z = b.cz + nz * h + az * h * t;
          this._place('street_lamp', x, y, z, yaw);
          this._lampSpots.push({ x: x + nx * 2.2, z: z + nz * 2.2 });
        }
        if (b.type === 'buildings' && rand() < 0.75) {
          this._place('palm', b.cx + nx * h + ax * h * (rand() * 0.2 - 0.1), y, b.cz + nz * h + az * h * (rand() * 0.2 - 0.1), rand() * 6, 0.9 + rand() * 0.3);
        }
        if (rand() < 0.5) {
          const t = (rand() < 0.5 ? -1 : 1) * (0.25 + rand() * 0.12);
          this._place(rand() < 0.5 ? 'hydrant' : 'trash_bin', b.cx + nx * h + ax * h * t, y, b.cz + nz * h + az * h * t, yaw);
        }
      }
    }
    // Lamps down the long roads, alternating sides.
    for (const r of this.roads) {
      if (!r.ext) continue;
      const len = Math.hypot(r.x2 - r.x1, r.z2 - r.z1);
      const yaw = Math.atan2(r.x2 - r.x1, r.z2 - r.z1);
      const rx = Math.cos(yaw), rz = -Math.sin(yaw);
      let side = 1;
      for (let s = 10; s < len - 4; s += 24, side = -side) {
        const off = side * (r.width / 2 + 0.9);
        const x = r.x1 + Math.sin(yaw) * s + rx * off;
        const z = r.z1 + Math.cos(yaw) * s + rz * off;
        if (this.landDistance(x, z) > -1.5) continue;
        this._place('street_lamp', x, 0, z, Math.atan2(-rx * side, -rz * side));
        this._lampSpots.push({ x: x - rx * side * 2.2, z: z - rz * side * 2.2 });
      }
    }
  }

  /** Soft pools of light on the ground under every street lamp (night only). */
  _buildLampPools() {
    const material = new THREE.ShaderMaterial({
      uniforms: { uNight: shared.uNight },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -12,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uNight;
        varying vec2 vUv;
        void main() {
          float d = length(vUv - 0.5) * 2.0;
          float glow = pow(max(0.0, 1.0 - d), 2.2);
          gl_FragColor = vec4(vec3(1.0, 0.78, 0.5) * glow * 0.55 * smoothstep(0.35, 0.8, uNight), 1.0);
        }`,
    });
    const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(13, 13).rotateX(-Math.PI / 2), material, this._lampSpots.length);
    this._lampSpots.forEach((s, n) => {
      this._dummy.position.set(s.x, 0.2, s.z);
      this._dummy.rotation.set(0, 0, 0);
      this._dummy.scale.setScalar(1);
      this._dummy.updateMatrix();
      mesh.setMatrixAt(n, this._dummy.matrix);
    });
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    this.scene.add(mesh);
  }

  // ===========================================================================
  // Builders: districts outside downtown
  // ===========================================================================

  _buildHarbour() {
    const rand = this.rand;
    const colors = CONFIG.colors.containers;
    const pick = () => colors[Math.floor(rand() * colors.length)];
    // Rows of stacked shipping containers either side of the harbour road.
    for (const zSide of [-1, 1]) {
      for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 5; col++) {
          if (rand() < 0.22) continue;
          const x = 128 + col * 9.5;
          const z = zSide * (26 + row * 16);
          if (this.landDistance(x, z) > -8) continue;
          const stack = 1 + Math.floor(rand() * 3);
          for (let s = 0; s < stack; s++) this._place('container', x, s * 2.6, z, 0, 1, pick(), s === 0);
          if (stack > 1) {
            // One tall collider instead of a box per container.
            this.physics.addStaticBox({ x, y: 2.6 + (stack - 1) * 1.3, z }, { x: 2.44, y: (stack - 1) * 2.6, z: 6.1 });
          }
        }
      }
    }
    for (let n = 0; n < 8; n++) {
      this._dynamicProp('barrel', 124 + rand() * 30, 0.5, (rand() < 0.5 ? -1 : 1) * (10 + rand() * 4), { x: 0.6, y: 0.95, z: 0.6 }, 14);
    }
    for (let n = 0; n < 5; n++) {
      this._dynamicProp('crate', 200 + n * 9, 0.52, (n % 2 ? -1 : 1) * 5.5, { x: 1, y: 1, z: 1 }, 22);
    }
    for (const [x, z, yaw] of [[204, 10.5, 0.2], [222, -10.5, 3.3], [238, 10.8, -0.15]]) {
      this._place('boat', x, CONFIG.world.seaLevel, z, yaw, 1, null, false);
    }
    for (let x = 192; x < 268; x += 6) {
      for (const s of [-1, 1]) this._place('bollard', x, 0.03, s * 7.4);
    }
    this._setPiece(createBillboard(0xff3d9a), 122, 0, -118, 0.7);
    this.addresses.push({ name: 'Container Yard', x: 150, z: -4 }, { name: "Pier's End", x: 236, z: 0 });
  }

  _buildBeach() {
    const rand = this.rand;
    // Palms along the boulevard and scattered across the sand.
    for (let x = -140; x <= 140; x += 14) {
      this._place('palm', x + rand() * 3, 0, 137.5 + rand(), rand() * 6, 0.95 + rand() * 0.35);
    }
    for (let n = 0; n < 34; n++) {
      const x = (rand() - 0.5) * 290;
      const z = 146 + rand() * 34;
      if (this.landDistance(x, z) > -5 || Math.abs(x + 40) < 16 && Math.abs(z - 164) < 6) continue;
      this._place(rand() < 0.6 ? 'umbrella' : 'palm', x, 0, z, rand() * 6, 0.9 + rand() * 0.3);
    }
    const wheel = this._setPiece(createFerrisWheel(), 124, 0, 152, Math.PI / 2);
    this.physics.addStaticBox({ x: 124, y: 3, z: 152 }, { x: 5, y: 6, z: 11 });
    const rim = wheel.getObjectByName('wheel');
    if (rim) this._animated.push((dt) => (rim.rotation.x += dt * 0.12));
    this._setPiece(createBillboard(0x21e6ff), -128, 0, 142, 2.4);
    this.addresses.push({ name: 'Ferris Wheel', x: 112, z: 131 }, { name: 'Sunset Beach', x: -40, z: 131 });
  }

  _buildParkBelt() {
    const rand = this.rand;
    const tries = 420;
    for (let n = 0; n < tries; n++) {
      const x = (rand() - 0.5) * 340;
      const z = -168 + rand() * 300;
      const inHarbour = x > 118 && Math.abs(z) < 100;
      if (!this._free(x, z, 3) || inHarbour || z > 124) continue;
      const roll = rand();
      const north = z < -118;
      if (roll < 0.52) this._place(north && rand() < 0.6 ? 'tree_pine' : 'tree_round', x, 0, z, rand() * 6, 0.8 + rand() * 0.6);
      else if (roll < 0.62) this._place('palm', x, 0, z, rand() * 6, 0.9 + rand() * 0.4);
      else if (roll < 0.86) this._place('bush', x, 0, z, rand() * 6, 0.7 + rand() * 0.8);
      else if (roll < 0.95) this._place('rock', x, 0, z, rand() * 6, 0.6 + rand() * 0.9);
      else this._place('bench', x, 0, z, rand() * 6);
    }
    this._setPiece(createBillboard(0xffb000), -122, 0, -124, -2.3);
  }

  _buildIslet() {
    const rand = this.rand;
    const islet = this.land[1];
    const lighthouse = this._setPiece(createLighthouse(), islet.x + 6, 0, islet.z - 12);
    this.physics.addStaticBox({ x: islet.x + 6, y: 6, z: islet.z - 12 }, { x: 6.5, y: 12, z: 6.5 });
    const beam = lighthouse.getObjectByName('beam');
    if (beam) this._animated.push((dt) => (beam.rotation.y += dt * 0.7));
    for (let n = 0; n < 46; n++) {
      const x = islet.x + (rand() - 0.5) * 2 * islet.hx;
      const z = islet.z + (rand() - 0.5) * 2 * islet.hz;
      if (this.landDistance(x, z) > -5 || Math.abs(x) < 9 && z > -292 || Math.hypot(x - 6, z + 317) < 9) continue;
      const roll = rand();
      this._place(roll < 0.55 ? 'tree_pine' : roll < 0.8 ? 'rock' : 'bush', x, 0, z, rand() * 6, 0.7 + rand() * 0.7);
    }
    this.addresses.push({ name: 'Lighthouse Key', x: 0, z: -288 });
  }

  /** Courier depots (job kiosks) and the tuner garage. */
  _buildServices() {
    const curb = CONFIG.city.curbHeight;
    const defs = [
      { name: 'Downtown Depot', kx: -8.6, kz: -20, ky: curb, yaw: Math.PI / 2, x: -3.4, z: -20 },
      { name: 'Harbour Depot', kx: 150, kz: 8.6, ky: 0, yaw: Math.PI, x: 150, z: 2.8 },
      { name: 'Beach Depot', kx: -52, kz: 138.4, ky: 0, yaw: Math.PI, x: -52, z: 132.8 },
      { name: 'Westside Depot', kx: -140, kz: -8.6, ky: 0, yaw: 0, x: -140, z: -2.8 },
    ];
    /** Depots: walk or drive into (x, z) to pick up a job. */
    this.depots = defs.map((d) => {
      this._setPiece(createDepot(), d.kx, d.ky, d.kz, d.yaw);
      this.physics.addStaticBox({ x: d.kx, y: d.ky + 1.4, z: d.kz }, { x: 1.4, y: 2.8, z: 1.4 });
      return { name: d.name, x: d.x, z: d.z };
    });

    this._setPiece(createGarage(), -160, 0, -17);
    // Back and side walls only: the bay stays open.
    this.physics.addStaticBox({ x: -160, y: 3, z: -21.7 }, { x: 12, y: 6, z: 0.6 });
    for (const s of [-1, 1]) this.physics.addStaticBox({ x: -160 + s * 5.7, y: 3, z: -17 }, { x: 0.6, y: 6, z: 10 });
    this.garage = { name: 'Low Tide Garage', x: -160, z: -4 };
    this.addresses.push({ name: 'Low Tide Garage', x: -146, z: 3 });
  }

  /**
   * Walkable graph for NPCs: four nodes per block on the sidewalk centre
   * line, linked around the block and across the road to adjacent blocks.
   */
  _buildSidewalkGraph() {
    const C = CONFIG.city;
    const inset = C.blockSize / 2 - C.sidewalkWidth / 2 - 0.2;
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    this.blocks.forEach((block, b) => {
      const first = this.sidewalkNodes.length;
      corners.forEach(([sx, sz], k) => {
        this.sidewalkNodes.push({
          id: first + k,
          x: block.cx + sx * inset,
          z: block.cz + sz * inset,
          block: b,
          neighbors: [first + ((k + 1) % 4), first + ((k + 3) % 4)],
        });
      });
    });
    const reach = C.roadWidth + C.sidewalkWidth + 1;
    const nodes = this.sidewalkNodes;
    for (let a = 0; a < nodes.length; a++) {
      for (let b = a + 1; b < nodes.length; b++) {
        if (nodes[a].block === nodes[b].block) continue;
        if (Math.hypot(nodes[a].x - nodes[b].x, nodes[a].z - nodes[b].z) < reach) {
          nodes[a].neighbors.push(b);
          nodes[b].neighbors.push(a);
        }
      }
    }
  }
}
