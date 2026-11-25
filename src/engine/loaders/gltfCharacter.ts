// Rigged glTF characters (e.g. CC0 packs such as KayKit) turned into what the
// character engine expects from the original `.bin` kid: ONE SkinnedMesh whose
// bones are named `bone_<i>`, plus AnimationClips targeting those names.
//
// - Every skinned mesh of the file is merged into one geometry (non-skinned
//   props such as weapons are left out).
// - The base color texture is sampled once per vertex into a `charColor`
//   attribute (low-poly packs use flat color atlases), so the character shader
//   needs no texture.
// - The model is scaled to `height`, keeping its proportions.
// - Bones are re-ordered by `rig`: slot i of the original kid skeleton (see
//   scene/emotes.ts) gets the named bone, so the procedural emotes and the
//   props (rod, guitar) work on any humanoid. Slots the model has no bone for
//   (`null`) get a still, unweighted helper bone under `helperParents[i]`.

import {
  AnimationClip,
  Bone,
  BufferAttribute,
  BufferGeometry,
  Color,
  Matrix4,
  PropertyBinding,
  Skeleton,
  SkinnedMesh,
  Vector3,
  type KeyframeTrack,
  type Texture,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export interface GltfCharacterOptions {
  url: string;
  /** Bone name (as in the file) for every kid skeleton slot, or null for a helper bone. */
  rig: Array<string | null>;
  /** Parent bone name of each helper slot. */
  helperParents: Record<number, string>;
  /** Target height (world units) of the character in its bind pose. */
  height: number;
  /** Skinned meshes to keep (by node name); default: all of them. */
  meshes?: (name: string) => boolean;
}

export interface GltfCharacter {
  skinned: SkinnedMesh;
  /** Every animation of the file, by name, retargeted to `bone_<i>`. */
  clips: Map<string, AnimationClip>;
}

const sanitize = (name: string) => PropertyBinding.sanitizeNodeName(name);

export async function loadGltfCharacter(options: GltfCharacterOptions): Promise<GltfCharacter> {
  const gltf = await new GLTFLoader().loadAsync(options.url);
  gltf.scene.updateMatrixWorld(true);

  const sources: SkinnedMesh[] = [];
  gltf.scene.traverse((obj) => {
    const mesh = obj as SkinnedMesh;
    if (mesh.isSkinnedMesh && (!options.meshes || options.meshes(mesh.name))) sources.push(mesh);
  });
  if (!sources.length) throw new Error(`${options.url}: no skinned mesh`);
  const sourceSkeleton = sources[0].skeleton;
  for (const s of sources) {
    if (s.skeleton.bones.length !== sourceSkeleton.bones.length || s.skeleton.bones.some((b, i) => b !== sourceSkeleton.bones[i])) {
      throw new Error(`${options.url}: meshes use different skeletons`);
    }
  }

  // --- bones: kid slots first, then everything else of the file ---------------
  const byName = new Map(sourceSkeleton.bones.map((b) => [sanitize(b.name), b]));
  const ordered: Bone[] = [];
  const inverses: Matrix4[] = [];
  const inverseOf = (bone: Bone) => sourceSkeleton.boneInverses[sourceSkeleton.bones.indexOf(bone)].clone();
  options.rig.forEach((name, slot) => {
    if (name) {
      const bone = byName.get(sanitize(name));
      if (!bone) throw new Error(`${options.url}: no bone "${name}" for slot ${slot}`);
      ordered.push(bone);
      inverses.push(inverseOf(bone));
    } else {
      const parent = byName.get(sanitize(options.helperParents[slot] ?? ''));
      if (!parent) throw new Error(`${options.url}: no parent for helper slot ${slot}`);
      const helper = new Bone();
      parent.add(helper);
      ordered.push(helper);
      inverses.push(new Matrix4()); // never weighted
    }
  });
  for (const bone of sourceSkeleton.bones) {
    if (!ordered.includes(bone)) {
      ordered.push(bone);
      inverses.push(inverseOf(bone));
    }
  }
  const newIndex = new Map<Bone, number>(ordered.map((b, i) => [b, i]));
  const renamed = new Map<string, string>();
  ordered.forEach((bone, i) => {
    if (bone.name) renamed.set(sanitize(bone.name), `bone_${i}`);
    bone.name = `bone_${i}`;
  });

  // --- geometry: merge the skinned meshes ------------------------------------
  const geometry = mergeSkinned(sources, (sourceJoint) => newIndex.get(sourceSkeleton.bones[sourceJoint]) ?? 0);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const scale = options.height / Math.max(1e-6, box.max.y - Math.min(0, box.min.y));

  // --- scale everything (geometry, bone offsets, bind inverses, clips) --------
  geometry.scale(scale, scale, scale);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  for (const bone of ordered) bone.position.multiplyScalar(scale);
  for (const m of inverses) {
    m.elements[12] *= scale;
    m.elements[13] *= scale;
    m.elements[14] *= scale;
  }

  const clips = new Map<string, AnimationClip>();
  for (const clip of gltf.animations) {
    const tracks: KeyframeTrack[] = [];
    for (const track of clip.tracks) {
      const dot = track.name.lastIndexOf('.');
      const target = renamed.get(track.name.slice(0, dot));
      if (!target) continue; // props, mesh morphs…
      const t = track.clone();
      t.name = target + track.name.slice(dot);
      if (track.name.endsWith('.position')) for (let i = 0; i < t.values.length; i++) t.values[i] *= scale;
      tracks.push(t);
    }
    clips.set(clip.name, new AnimationClip(clip.name, clip.duration, tracks));
  }

  // --- the skinned mesh the engine clones ------------------------------------
  const roots = ordered.filter((b) => !(b.parent as Bone | null)?.isBone);
  const skinned = new SkinnedMesh(geometry);
  for (const root of roots) skinned.add(root);
  skinned.updateMatrixWorld(true);
  skinned.bind(new Skeleton(ordered, inverses), new Matrix4());
  skinned.normalizeSkinWeights();
  return { skinned, clips };
}

/** Concatenate skinned meshes (positions in their bind space) into one indexed geometry. */
function mergeSkinned(sources: SkinnedMesh[], remapJoint: (joint: number) => number): BufferGeometry {
  let vertices = 0;
  let indices = 0;
  for (const s of sources) {
    vertices += s.geometry.attributes.position.count;
    indices += s.geometry.index ? s.geometry.index.count : s.geometry.attributes.position.count;
  }
  const position = new Float32Array(vertices * 3);
  const normal = new Float32Array(vertices * 3);
  const charColor = new Float32Array(vertices * 3);
  const skinIndex = new Uint16Array(vertices * 4);
  const skinWeight = new Float32Array(vertices * 4);
  const index = new Uint32Array(indices);
  const v = new Vector3();
  const n = new Vector3();
  const c = new Color();
  let vAt = 0;
  let iAt = 0;
  for (const s of sources) {
    const g = s.geometry;
    const pos = g.attributes.position;
    const nor = g.attributes.normal;
    const uv = g.attributes.uv;
    const ji = g.attributes.skinIndex;
    const jw = g.attributes.skinWeight;
    const material = Array.isArray(s.material) ? s.material[0] : s.material;
    const sample = textureSampler((material as { map?: Texture | null }).map ?? null);
    const base = (material as { color?: Color }).color ?? new Color(1, 1, 1);
    const normalMatrix = new Matrix4().extractRotation(s.bindMatrix);
    for (let i = 0; i < pos.count; i++) {
      const o = vAt + i;
      v.fromBufferAttribute(pos, i).applyMatrix4(s.bindMatrix);
      position.set([v.x, v.y, v.z], o * 3);
      if (nor) {
        n.fromBufferAttribute(nor, i).applyMatrix4(normalMatrix).normalize();
        normal.set([n.x, n.y, n.z], o * 3);
      }
      sample(uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0, c);
      c.multiply(base);
      charColor.set([c.r, c.g, c.b], o * 3);
      const joints = [ji.getX(i), ji.getY(i), ji.getZ(i), ji.getW(i)];
      const weights = [jw.getX(i), jw.getY(i), jw.getZ(i), jw.getW(i)];
      for (let k = 0; k < 4; k++) {
        skinIndex[o * 4 + k] = remapJoint(joints[k]);
        skinWeight[o * 4 + k] = weights[k];
      }
    }
    if (g.index) for (let k = 0; k < g.index.count; k++) index[iAt + k] = g.index.getX(k) + vAt;
    else for (let k = 0; k < pos.count; k++) index[iAt + k] = k + vAt;
    iAt += g.index ? g.index.count : pos.count;
    vAt += pos.count;
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(position, 3));
  out.setAttribute('normal', new BufferAttribute(normal, 3));
  out.setAttribute('charColor', new BufferAttribute(charColor, 3));
  out.setAttribute('skinIndex', new BufferAttribute(skinIndex, 4));
  out.setAttribute('skinWeight', new BufferAttribute(skinWeight, 4));
  out.setIndex(new BufferAttribute(index, 1));
  if (!sources.some((s) => s.geometry.attributes.normal)) out.computeVertexNormals();
  return out;
}

/** Nearest-pixel lookup of a (glTF, flipY = false) texture, in linear color. */
function textureSampler(texture: Texture | null): (u: number, v: number, out: Color) => void {
  const image = texture?.image as CanvasImageSource & { width: number; height: number } | undefined;
  if (!image || !image.width) return (_u, _v, out) => void out.setRGB(1, 1, 1);
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(image, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const wrap = (x: number) => x - Math.floor(x);
  return (u, v, out) => {
    const x = Math.min(width - 1, Math.floor(wrap(u) * width));
    const y = Math.min(height - 1, Math.floor(wrap(v) * height));
    const p = (y * width + x) * 4;
    out.setRGB(data[p] / 255, data[p + 1] / 255, data[p + 2] / 255).convertSRGBToLinear();
  };
}
