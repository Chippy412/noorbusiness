/**
 * world.js — builds the static city: ground, raised blocks (sidewalks),
 * buildings, boundary walls, stunt ramps, lane markings and a few loose crates.
 * Every solid thing gets both a Three.js mesh and a matching cannon-es collider.
 *
 * Layout: a grid of `blocks x blocks` square blocks separated (and surrounded)
 * by roads, centred on the origin. Road centre lines therefore sit at
 *     c(k) = -half + roadWidth/2 + k * (blockSize + roadWidth),  k = 0..blocks
 *
 * Besides meshes, the world exposes plain data other systems use:
 *   half, blocks, buildings, ramps, sidewalkNodes, spawn, groundHeightAt()
 */
import * as THREE from 'three';
import { CONFIG } from './config.js';

/** Small deterministic PRNG so the city is identical on every load. */
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

export class World {
  /** @param {{scene: THREE.Scene, physics: import('./physics.js').Physics}} opts */
  constructor({ scene, physics }) {
    const C = CONFIG.city;
    this.scene = scene;
    this.physics = physics;
    this.rand = mulberry32(C.seed);

    this.pitch = C.blockSize + C.roadWidth;
    this.size = C.blocks * C.blockSize + (C.blocks + 1) * C.roadWidth;
    /** The city spans [-half, half] on X and Z. */
    this.half = this.size / 2;

    /** @type {{i:number,j:number,cx:number,cz:number,minX:number,maxX:number,minZ:number,maxZ:number,type:'buildings'|'plaza'}[]} */
    this.blocks = [];
    /** @type {{minX:number,maxX:number,minZ:number,maxZ:number,height:number,color:number}[]} */
    this.buildings = [];
    /** @type {{x:number,z:number,width:number,length:number,yaw:number}[]} */
    this.ramps = [];
    /** @type {{id:number,x:number,z:number,block:number,neighbors:number[]}[]} */
    this.sidewalkNodes = [];

    this._materials = new Map();

    this._buildGround();
    this._buildBlocks();
    this._buildWalls();
    this._buildLaneLines();
    this._buildRamps();
    this._buildCrates();
    this._buildSidewalkGraph();

    // Spawn points sit on the two roads that cross at the city centre.
    this.spawn = {
      player: { x: -2.5, z: -16, heading: 0 },
      vehicles: [
        { x: 3.5, z: -12, heading: 0 },             // faces the road ramp
        { x: -20, z: -3.5, heading: -Math.PI / 2 }, // faces -X
      ],
    };
  }

  /** Road centre line number k (0..blocks). */
  roadCenter(k) {
    return -this.half + CONFIG.city.roadWidth / 2 + k * this.pitch;
  }

  /** Height of the walkable ground at (x, z): curb height on a block, 0 on a road. */
  groundHeightAt(x, z) {
    return this._onBlock(x) && this._onBlock(z) ? CONFIG.city.curbHeight : 0;
  }

  _onBlock(v) {
    const C = CONFIG.city;
    const local = (((v + this.half) % this.pitch) + this.pitch) % this.pitch;
    return Math.abs(v) < this.half && local > C.roadWidth;
  }

  _material(color) {
    let m = this._materials.get(color);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ color });
      this._materials.set(color, m);
    }
    return m;
  }

  /** Box with a mesh and (optionally) a static collider. Returns the mesh. */
  _box(center, size, color, { collide = true, quaternion = null, shadow = true } = {}) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), this._material(color));
    mesh.position.set(center.x, center.y, center.z);
    if (quaternion) mesh.quaternion.copy(quaternion);
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    if (collide) this.physics.addStaticBox(center, size, quaternion);
    return mesh;
  }

  _buildGround() {
    const extent = this.size + 400; // visual apron beyond the walls
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(extent, extent), this._material(CONFIG.colors.road));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);
    this.physics.addGroundPlane();
  }

  _buildBlocks() {
    const C = CONFIG.city;
    for (let j = 0; j < C.blocks; j++) {
      for (let i = 0; i < C.blocks; i++) {
        const cx = this.roadCenter(i) + this.pitch / 2;
        const cz = this.roadCenter(j) + this.pitch / 2;
        const h = C.blockSize / 2;
        const type = i === C.plazaBlock.i && j === C.plazaBlock.j ? 'plaza' : 'buildings';
        const block = { i, j, cx, cz, minX: cx - h, maxX: cx + h, minZ: cz - h, maxZ: cz + h, type };
        this.blocks.push(block);

        // Raised slab: its rim is the sidewalk.
        this._box(
          { x: cx, y: C.curbHeight / 2, z: cz },
          { x: C.blockSize, y: C.curbHeight, z: C.blockSize },
          CONFIG.colors.sidewalk,
          { shadow: false }
        );

        const inner = C.blockSize - 2 * C.sidewalkWidth;
        if (type === 'plaza') {
          // Visual-only coloured surface for the stunt plaza.
          this._box(
            { x: cx, y: C.curbHeight + 0.01, z: cz },
            { x: inner, y: 0.02, z: inner },
            CONFIG.colors.plaza,
            { collide: false, shadow: false }
          );
        } else {
          this._buildBuildings(block, inner);
        }
      }
    }
  }

  /** Fill a block's inner lot with 1, 2 or 4 buildings. */
  _buildBuildings(block, inner) {
    const rand = this.rand;
    const palette = CONFIG.colors.buildings;
    const r = rand();
    const nx = r < 0.2 ? 1 : 2;
    const nz = r < 0.2 ? 1 : r < 0.55 ? 1 : 2;
    const swap = rand() < 0.5; // randomise which axis gets split for 2-building lots
    const cols = swap ? nz : nx;
    const rows = swap ? nx : nz;
    const cellW = inner / cols;
    const cellD = inner / rows;
    const gap = 1.2;
    const base = CONFIG.city.curbHeight;

    for (let a = 0; a < cols; a++) {
      for (let b = 0; b < rows; b++) {
        const w = cellW - 2 * gap - rand() * 3;
        const d = cellD - 2 * gap - rand() * 3;
        const height = 8 + Math.floor(rand() * rand() * 38);
        const x = block.cx - inner / 2 + cellW * (a + 0.5);
        const z = block.cz - inner / 2 + cellD * (b + 0.5);
        const color = palette[Math.floor(rand() * palette.length)];

        this._box({ x, y: base + height / 2, z }, { x: w, y: height, z: d }, color);
        // Rooftop unit: visual only, gives the skyline some variety.
        this._box(
          { x: x + (rand() - 0.5) * w * 0.3, y: base + height + 0.7, z: z + (rand() - 0.5) * d * 0.3 },
          { x: w * 0.35, y: 1.4, z: d * 0.35 },
          0x3a3d42,
          { collide: false }
        );
        this.buildings.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, height, color });
      }
    }
  }

  /** Four walls keep everything inside the city. */
  _buildWalls() {
    const h = 5;
    const t = 2;
    const e = this.half + t / 2;
    const len = this.size + 2 * t;
    const color = CONFIG.colors.wall;
    this._box({ x: 0, y: h / 2, z: -e }, { x: len, y: h, z: t }, color);
    this._box({ x: 0, y: h / 2, z: e }, { x: len, y: h, z: t }, color);
    this._box({ x: -e, y: h / 2, z: 0 }, { x: t, y: h, z: len }, color);
    this._box({ x: e, y: h / 2, z: 0 }, { x: t, y: h, z: len }, color);
  }

  /** Dashed centre lines on every road, skipped inside intersections. */
  _buildLaneLines() {
    const C = CONFIG.city;
    const spots = [];
    const inRoadStrip = (v) => !this._onBlock(v);
    for (let k = 0; k <= C.blocks; k++) {
      const c = this.roadCenter(k);
      for (let s = -this.half + 2.5; s < this.half; s += 5) {
        if (inRoadStrip(s)) continue; // that is an intersection
        spots.push({ x: c, z: s, yaw: 0 });
        spots.push({ x: s, z: c, yaw: Math.PI / 2 });
      }
    }
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.25, 0.02, 2.2),
      new THREE.MeshBasicMaterial({ color: CONFIG.colors.laneLine }),
      spots.length
    );
    const dummy = new THREE.Object3D();
    spots.forEach((s, n) => {
      dummy.position.set(s.x, 0.011, s.z);
      dummy.rotation.set(0, s.yaw, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(n, dummy.matrix);
    });
    this.scene.add(mesh);
  }

  /**
   * A ramp is a tilted slab whose low edge is flush with the ground, plus a
   * support block under the high end.
   * @param {number} x centre X  @param {number} z centre Z
   * @param {number} yaw heading of the uphill direction
   * @param {number} length along the slope  @param {number} width
   * @param {number} angle slope in radians  @param {number} baseY ground height
   */
  _addRamp(x, z, yaw, length, width, angle, baseY) {
    const thickness = 0.4;
    // Local +Z is the long axis; a negative X rotation lifts the +Z end.
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-angle, yaw, 0, 'YXZ'));
    const y = baseY + (length / 2) * Math.sin(angle) - (thickness / 2) * Math.cos(angle);
    this._box({ x, y, z }, { x: width, y: thickness, z: length }, CONFIG.colors.ramp, { quaternion: q });

    const supportH = length * Math.sin(angle) - thickness - 0.2;
    if (supportH > 0.2) {
      const reach = (length / 2) * Math.cos(angle) - 0.45;
      const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      this._box(
        { x: x + Math.sin(yaw) * reach, y: baseY + supportH / 2, z: z + Math.cos(yaw) * reach },
        { x: width, y: supportH, z: 0.6 },
        0x8a4a10,
        { quaternion: qYaw }
      );
    }
    this.ramps.push({ x, z, width, length: length * Math.cos(angle), yaw });
  }

  _buildRamps() {
    const C = CONFIG.city;
    const deg = Math.PI / 180;
    // Two road ramps, each in one lane.
    this._addRamp(3.5, 30, 0, 9, 4.5, 14 * deg, 0);
    this._addRamp(27, 54 - 3.5, Math.PI / 2, 9, 4.5, 14 * deg, 0);

    // Plaza: a kicker and a landing ramp facing each other across a gap.
    const plaza = this.blocks.find((b) => b.type === 'plaza');
    if (plaza) {
      this._addRamp(plaza.cx - 9, plaza.cz, Math.PI / 2, 7, 5, 17 * deg, C.curbHeight);
      this._addRamp(plaza.cx + 9, plaza.cz, -Math.PI / 2, 7, 5, 17 * deg, C.curbHeight);
    }
  }

  /** A small pyramid of loose crates to knock over. */
  _buildCrates() {
    const plaza = this.blocks.find((b) => b.type === 'plaza');
    if (!plaza) return;
    const s = 1;
    const geometry = new THREE.BoxGeometry(s, s, s);
    const material = this._material(CONFIG.colors.crate);
    const baseY = CONFIG.city.curbHeight;
    const rows = [3, 2, 1];
    rows.forEach((count, level) => {
      for (let n = 0; n < count; n++) {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.scene.add(mesh);
        const x = plaza.cx + (n - (count - 1) / 2) * (s + 0.05);
        this.physics.addDynamicBox(
          { x, y: baseY + s / 2 + level * s + 0.01, z: plaza.cz + 11 },
          { x: s, y: s, z: s },
          25,
          mesh
        );
      }
    });
  }

  /**
   * Walkable graph for NPCs: four nodes per block on the sidewalk centre
   * line, linked around the block and across the road to adjacent blocks.
   */
  _buildSidewalkGraph() {
    const C = CONFIG.city;
    const inset = C.blockSize / 2 - C.sidewalkWidth / 2;
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
    // Crossings: nodes of different blocks that face each other across a road.
    const reach = C.roadWidth + C.sidewalkWidth + 0.5;
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
