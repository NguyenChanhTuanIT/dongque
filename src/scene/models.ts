// glTF models from public/assets/models (Sketchfab downloads, see the README
// credits): loading, materials adapted to the scene, and baking a model into
// static geometry so it can be drawn as InstancedMeshes (pets: one instance
// per character).

import { Box3, BufferAttribute, BufferGeometry, Matrix4, Vector3, type Material, type Mesh, type Object3D, type SkinnedMesh } from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

export function loadGltf(url: string): Promise<GLTF> {
  return new GLTFLoader().loadAsync(url);
}

/**
 * Matte materials like the rest of the scene. Only the colour texture is
 * kept: the other maps (normal, emissive, metal / roughness, AO) are dropped,
 * some models put them on UV sets 1-3, which three r148 cannot read (they
 * would be pasted on the wrong UVs).
 */
export function matteMaterials(root: Object3D): void {
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    for (const material of ([] as any[]).concat(mesh.material)) {
      for (const key of ['normalMap', 'emissiveMap', 'metalnessMap', 'roughnessMap', 'aoMap', 'specularIntensityMap', 'specularColorMap']) {
        if (material[key]) material[key] = null;
      }
      if ('metalness' in material) material.metalness = 0;
      if ('roughness' in material) material.roughness = 1;
      if (material.emissive) material.emissive.setRGB(0, 0, 0);
      material.needsUpdate = true;
    }
  });
}

/**
 * Bounds of a posed model, vertex by vertex (skinned meshes included:
 * bounding boxes ignore the skeleton). `root` must have its world matrices
 * (and skeletons) up to date.
 */
export function posedBox(root: Object3D): Box3 {
  const box = new Box3();
  const v = new Vector3();
  root.traverse((o) => {
    const mesh = o as SkinnedMesh;
    if (!mesh.isMesh) return;
    const position = mesh.geometry.attributes.position;
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i);
      if (mesh.isSkinnedMesh) mesh.boneTransform(i, v);
      box.expandByPoint(v.applyMatrix4(mesh.matrixWorld));
    }
  });
  return box;
}

export interface BakedPart {
  geometry: BufferGeometry;
  material: Material | Material[];
}

export interface BakedModel {
  parts: BakedPart[];
  /** Size (m) after fitting: x width, y height, z length. */
  size: Vector3;
}

/**
 * The model as static geometry in its current pose: `height` m tall, standing
 * on y = 0, centred on x / z, turned by `yaw` (radians) so it faces +z.
 * Skinned meshes are frozen in their pose (normals recomputed).
 */
export function bakeModel(root: Object3D, height: number, yaw = 0): BakedModel {
  root.updateMatrixWorld(true);
  const box = posedBox(root);
  const size = box.getSize(new Vector3());
  const centre = box.getCenter(new Vector3());
  const s = size.y > 0 ? height / size.y : 1;
  const fit = new Matrix4().makeRotationY(yaw).multiply(new Matrix4().makeScale(s, s, s)).multiply(new Matrix4().makeTranslation(-centre.x, -box.min.y, -centre.z));
  const parts: BakedPart[] = [];
  const v = new Vector3();
  const fitted = new Box3();
  root.traverse((o) => {
    const mesh = o as SkinnedMesh;
    if (!mesh.isMesh) return;
    const source = mesh.geometry;
    const out = new BufferGeometry();
    const position = source.attributes.position;
    const baked = new Float32Array(position.count * 3);
    const toFit = new Matrix4().multiplyMatrices(fit, mesh.matrixWorld);
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i);
      if (mesh.isSkinnedMesh) mesh.boneTransform(i, v);
      v.applyMatrix4(toFit);
      baked.set([v.x, v.y, v.z], i * 3);
      fitted.expandByPoint(v);
    }
    out.setAttribute('position', new BufferAttribute(baked, 3));
    if (source.attributes.uv) out.setAttribute('uv', source.attributes.uv);
    if (source.attributes.color) out.setAttribute('color', source.attributes.color);
    if (source.index) out.setIndex(source.index);
    for (const group of source.groups) out.addGroup(group.start, group.count, group.materialIndex);
    out.computeVertexNormals();
    out.computeBoundingSphere();
    parts.push({ geometry: out, material: mesh.material });
  });
  return { parts, size: fitted.getSize(new Vector3()) };
}
