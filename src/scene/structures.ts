// Static structures: houses, warehouses, machines, lightposts (with their
// wires), parasol, sandcastles, road blockers.

import { BufferAttribute, BufferGeometry, InstancedMesh, Mesh, Vector3 } from 'three';
import { geometryLoader } from '../engine/loaders/geometries';
import { createInstancedGeometryPatches } from '../engine/loaders/instancing';
import { makeInstanced } from './helpers';
import { phongMaterial } from './materials';
import { SceneModule } from './SceneModule';

export class Houses extends SceneModule {
  meshes: Mesh[] = [];
  protected async init() {
    const geos = await Promise.all([
      geometryLoader.load('house1.bin'),
      geometryLoader.load('house2.bin'),
      geometryLoader.load('house3.bin'),
    ]);
    this.meshes = geos.map((geometry, i) => {
      const mesh = new Mesh(geometry, phongMaterial(i === 0 ? { isHouse: true } : { isHouse2: true }));
      mesh.name = `house${i}`;
      mesh.updateMatrixWorld(true);
      mesh.matrixWorldAutoUpdate = false;
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      this.scene.add(mesh);
      return mesh;
    });
    this.ready.resolve();
  }
}

export class Warehouses extends SceneModule {
  meshes: Mesh[] = [];
  protected async init() {
    const geos = await Promise.all([
      geometryLoader.load('warehouse1.bin'),
      geometryLoader.load('warehouse2.bin'),
      geometryLoader.load('warehouse3.bin'),
    ]);
    this.meshes = geos.map((geometry, i) => {
      const mesh = new Mesh(geometry, phongMaterial({ isWarehouse: true }));
      mesh.name = `warehouse${i}`;
      mesh.updateMatrixWorld(true);
      mesh.matrixWorldAutoUpdate = false;
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      this.scene.add(mesh);
      return mesh;
    });
    this.ready.resolve();
  }
}

/**
 * Machine instances taken off the map (matched by position, within 1 m): the
 * electric box with two pipes standing on the beach, and the generator by the spawn. `yaw` is its rotation in
 * machine-instances.bin; the walk collider loses its triangles too
 * (cutRemovedMachines), so nothing invisible is left to bump into.
 */
const REMOVED_MACHINES = [
  { x: 57.12, y: 0, z: -29.92, yaw: Math.PI / 2 },
  // the generator by the spawn, at the roadside
  { x: 0.3, y: 1.66, z: -56.46, yaw: Math.PI / 2 },
];
/** machine.bin's local bounds (a bit larger): ±2.17 × 0…1.87 × ±0.8 m. */
const MACHINE_HALF_X = 2.4;
const MACHINE_HALF_Z = 1.0;
const MACHINE_TOP = 2.1;

const isRemovedMachine = (x: number, z: number) => REMOVED_MACHINES.some((m) => Math.hypot(x - m.x, z - m.z) < 1);

/** The instance data without the removed machines (same attributes). */
function withoutRemovedMachines(data: BufferGeometry): BufferGeometry {
  const pos = data.attributes.position;
  const keep: number[] = [];
  for (let i = 0; i < pos.count; i++) if (!isRemovedMachine(pos.getX(i), pos.getZ(i))) keep.push(i);
  if (keep.length === pos.count) console.warn('machines: removed machine not found in machine-instances.bin');
  const out = new BufferGeometry();
  for (const [name, attr] of Object.entries(data.attributes)) {
    const size = attr.itemSize;
    const values = new Float32Array(keep.length * size);
    const get = [attr.getX, attr.getY, attr.getZ, attr.getW];
    keep.forEach((i, k) => {
      for (let c = 0; c < size; c++) values[k * size + c] = get[c].call(attr, i);
    });
    out.setAttribute(name, new BufferAttribute(values, size));
  }
  return out;
}

/**
 * The walk collider without the removed machines: drops the triangles lying
 * inside a removed machine's box, above its foot (the ground under it stays).
 */
export function cutRemovedMachines(source: BufferGeometry): BufferGeometry {
  const pos = source.attributes.position;
  const triCount = source.index ? source.index.count / 3 : pos.count / 3;
  const vertex = (t: number, k: number) => (source.index ? source.index.getX(t * 3 + k) : t * 3 + k);
  const v = new Vector3();
  const keep: number[] = [];
  let cut = 0;
  for (let t = 0; t < triCount; t++) {
    const ids = [vertex(t, 0), vertex(t, 1), vertex(t, 2)];
    const removed = REMOVED_MACHINES.some((m) => {
      const cos = Math.cos(-m.yaw);
      const sin = Math.sin(-m.yaw);
      let centreY = 0;
      const inside = ids.every((i) => {
        v.fromBufferAttribute(pos, i);
        const dx = v.x - m.x;
        const dz = v.z - m.z;
        const lx = dx * cos + dz * sin; // world → machine local (rotation about y)
        const lz = -dx * sin + dz * cos;
        const ly = v.y - m.y;
        centreY += ly / 3;
        return Math.abs(lx) < MACHINE_HALF_X && Math.abs(lz) < MACHINE_HALF_Z && ly > -0.1 && ly < MACHINE_TOP;
      });
      return inside && centreY > 0.1;
    });
    if (removed) {
      cut++;
      continue;
    }
    keep.push(...ids);
  }
  if (!cut) console.warn('machines: removed machine not found in the collider');
  const out = new BufferGeometry();
  for (const name of Object.keys(source.attributes)) out.setAttribute(name, source.attributes[name]);
  out.setIndex(keep);
  return out;
}

export class Machines extends SceneModule {
  meshes: InstancedMesh[] = [];
  protected async init() {
    const [base, data] = await Promise.all([geometryLoader.load('machine.bin'), geometryLoader.load('machine-instances.bin')]);
    const patches = createInstancedGeometryPatches(base, withoutRemovedMachines(data), {
      maxPerPatch: 5,
      maxDistance: 30,
    });
    const material = phongMaterial({ isMachine: true });
    this.meshes = patches.map((geometry, i) => {
      const mesh = makeInstanced(geometry, material, 'machines');
      (mesh as any).ignore = i !== 0;
      this.scene.add(mesh);
      return mesh;
    });
    this.ready.resolve();
  }
}

export class Lightposts extends SceneModule {
  meshes: InstancedMesh[] = [];
  declare meshWire: Mesh;
  protected async init() {
    const patches = await geometryLoader.instancedPatches('lightpost.bin', 'lightposts-instances.bin', {
      maxPerPatch: 5,
      maxDistance: 30,
    });
    const material = phongMaterial({ isLightPost: true });
    this.meshes = patches.map((geometry, i) => {
      const mesh = makeInstanced(geometry, material, 'lightposts');
      (mesh as any).ignore = i !== 0;
      this.scene.add(mesh);
      return mesh;
    });

    const wires = await geometryLoader.load('lightposts-wires.bin');
    this.meshWire = new Mesh(wires, phongMaterial({ isWires: true }));
    this.meshWire.name = 'lightposts wires';
    this.meshWire.updateMatrixWorld(true);
    this.meshWire.matrixWorldAutoUpdate = false;
    this.meshWire.receiveShadow = true;
    this.meshWire.castShadow = true;
    this.scene.add(this.meshWire);
    this.ready.resolve();
  }
}

export class Parasols extends SceneModule {
  declare mesh: Mesh;
  protected async init() {
    const geometry = await geometryLoader.load('parasol.bin');
    this.mesh = new Mesh(geometry, phongMaterial({ isParasol: true }));
    this.mesh.name = 'parasol';
    this.mesh.updateMatrixWorld(true);
    this.mesh.matrixWorldAutoUpdate = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = true;
    this.scene.add(this.mesh);
    this.ready.resolve();
  }
}

export class Castles extends SceneModule {
  meshes: Mesh[] = [];
  protected async init() {
    const geos = await Promise.all([geometryLoader.load('sandcastles1.bin'), geometryLoader.load('sandcastles2.bin')]);
    this.meshes = geos.map((geometry, i) => {
      const mesh = new Mesh(geometry, phongMaterial({ isCastles: true }));
      mesh.name = `castles${i}`;
      mesh.updateMatrixWorld(true);
      mesh.matrixWorldAutoUpdate = false;
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      this.scene.add(mesh);
      return mesh;
    });
    this.ready.resolve();
  }
}

export class Blockers extends SceneModule {
  meshes: Mesh[] = [];
  protected async init() {
    const geos = await Promise.all([geometryLoader.load('blockers1.bin'), geometryLoader.load('blockers2.bin')]);
    this.meshes = geos.map((geometry, i) => {
      const mesh = new Mesh(geometry, phongMaterial({ isBlocker: true }));
      mesh.name = `road blocker ${i}`;
      mesh.updateMatrixWorld(true);
      mesh.matrixWorldAutoUpdate = false;
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      this.scene.add(mesh);
      return mesh;
    });
    this.ready.resolve();
  }
}
