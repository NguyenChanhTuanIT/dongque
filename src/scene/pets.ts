// Pets for the 'walk a dog' emotes (one emote state per dog of the shop,
// emotes.ts DOG_STATES): the dog follows its owner on the right side, on a
// leash from the owner's right hand. The dogs are glTF models (Sketchfab, see
// the README credits) baked into static geometry and drawn as InstancedMeshes
// (one instance per character); most have no rig, so walking is a little hop
// and sway, standing a slow breath. Each model loads the first time someone
// walks that dog. The pet's motion state is kept per character on this client:
// remote players' dogs follow their owners the same way, so everyone sees them.

import {
  AnimationMixer,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
  type Bone,
  type BufferGeometry,
} from 'three';
import { clock } from '../engine/clock';
import { ticker } from '../core/ticker';
import type { CharacterLocal } from '../engine/characters';
import { BONE, DOG_STATES } from './emotes';
import { bakeModel, loadGltf, matteMaterials } from './models';

const MAX = 128;
const HIDDEN = new Matrix4().makeScale(0, 0, 0);
const UP = new Vector3(0, 1, 0);
const X = new Vector3(1, 0, 0);
const Z = new Vector3(0, 0, 1);

interface DogModel {
  url: string;
  /** Height (m) the model is scaled to. */
  height: number;
  /** Turn (radians) so the model faces +z. */
  yaw: number;
}

/**
 * The shop's dogs, in DOG_STATES order (catalog pet.dog, pet.dog2, pet.dog3,
 * pet.dog4, pet.dog5). Credits and licences: README "Credits".
 */
export const DOGS: DogModel[] = [
  { url: '/assets/models/dog/dog_puppy.glb', height: 0.5, yaw: 0 },
  { url: '/assets/models/dog/low_poly_dog.glb', height: 0.5, yaw: 0 },
  { url: '/assets/models/dog/dog.glb', height: 0.55, yaw: 0 },
  { url: '/assets/models/dog/dog_with_bomb.glb', height: 0.5, yaw: Math.PI }, // modelled facing -z
  { url: '/assets/models/dog/doggy_meme_dog_ps1.glb', height: 0.5, yaw: 0 }, // shiba (also the big one in the woods, setpieces.ts)
];

function hiddenInstances(geometry: BufferGeometry, material: InstancedMesh['material'], name: string) {
  const mesh = new InstancedMesh(geometry, material, MAX);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.count = 0;
  for (let i = 0; i < MAX; i++) mesh.setMatrixAt(i, HIDDEN);
  return mesh;
}

/** One dog model: its instanced parts, loaded on first use. */
class DogMeshes {
  meshes: InstancedMesh[] = [];
  /** Leash attachment (model frame: +z forward, y up, feet on y = 0). */
  readonly collar = new Vector3();
  ready = false;
  private _loading = false;

  constructor(
    private readonly model: DogModel,
    private readonly group: Group,
  ) {}

  /** Start loading (once); the dog shows up when it is ready. */
  load() {
    if (this._loading) return;
    this._loading = true;
    loadGltf(this.model.url)
      .then((gltf) => {
        // Rigged models: the first frame of their animation (else the bind pose).
        if (gltf.animations[0]) {
          const mixer = new AnimationMixer(gltf.scene);
          mixer.clipAction(gltf.animations[0]).play();
          mixer.update(0);
        }
        matteMaterials(gltf.scene);
        const baked = bakeModel(gltf.scene, this.model.height, this.model.yaw);
        const name = this.model.url.split('/').pop()?.replace('.glb', '') ?? 'dog';
        this.meshes = baked.parts.map((part, k) => hiddenInstances(part.geometry, part.material as InstancedMesh['material'], `${name} ${k}`));
        // Neck: high up, towards the front.
        this.collar.set(0, baked.size.y * 0.72, baked.size.z * 0.3);
        this.group.add(...this.meshes);
        this.ready = true;
      })
      .catch((err) => console.warn('pets: could not load', this.model.url, err));
  }

  hide(i: number) {
    for (const m of this.meshes) m.setMatrixAt(i, HIDDEN);
  }

  place(i: number, matrix: Matrix4) {
    for (const m of this.meshes) m.setMatrixAt(i, matrix);
  }

  commit(count: number) {
    for (const m of this.meshes) {
      m.count = count;
      m.instanceMatrix.needsUpdate = true;
    }
  }
}

interface PetState {
  dog: number;
  pos: Vector3;
  yaw: number;
  speed: number;
  phase: number;
}

const ownerYaw = (q: Quaternion) => {
  const f = new Vector3(0, 0, 1).applyQuaternion(q);
  return Math.atan2(f.x, f.z);
};
const angleLerp = (a: number, b: number, t: number) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;

export class Pets {
  readonly group = new Group();
  private _dogs: DogMeshes[];
  private _leash: InstancedMesh;
  private _state = new WeakMap<CharacterLocal, PetState>();

  private _m = new Matrix4();
  private _q = new Quaternion();
  private _q2 = new Quaternion();
  private _v = new Vector3();
  private _p = new Vector3();
  private _target = new Vector3();
  private _hand = new Vector3();
  private _collar = new Vector3();
  private _s = new Vector3();

  constructor() {
    this.group.name = 'pets';
    this._dogs = DOGS.map((model) => new DogMeshes(model, this.group));
    const leash = new CylinderGeometry(0.006, 0.006, 1, 4);
    leash.translate(0, 0.5, 0);
    this._leash = hiddenInstances(leash, new MeshLambertMaterial({ color: '#c8413a' }), 'leash');
    this._leash.castShadow = false;
    this.group.add(this._leash);
  }

  /** Engine hook: called per character right after its pose is baked. */
  pose = (character: CharacterLocal, i: number, bones: Bone[], stateWeight: (state: number) => number) => {
    if (i >= MAX) return;
    // The dog this character walks (the strongest of the dog states).
    let dog = -1;
    let w = 0;
    DOG_STATES.forEach((state, k) => {
      const sw = stateWeight(state);
      if (sw > w) {
        w = sw;
        dog = k;
      }
    });
    const meshes = dog >= 0 ? this._dogs[dog] : null;
    if (meshes) meshes.load();
    for (const other of this._dogs) if (other !== meshes) other.hide(i);
    if (!meshes || w < 0.35 || !meshes.ready) {
      meshes?.hide(i);
      this._leash.setMatrixAt(i, HIDDEN);
      if (!meshes || w < 0.35) this._state.delete(character);
      return;
    }
    const s = Math.min(1, (w - 0.35) / 0.4) * character.scale.x;
    const yawO = ownerYaw(character.quaternion);
    const fwd = this._v.set(Math.sin(yawO), 0, Math.cos(yawO));
    // the spot to walk at: on the owner's right (-x local), a little ahead
    this._target.copy(character.position).addScaledVector(fwd, 0.3).add(this._p.set(-Math.cos(yawO), 0, Math.sin(yawO)).multiplyScalar(0.6));

    let st = this._state.get(character);
    if (!st || st.dog !== dog) {
      st = { dog, pos: this._target.clone(), yaw: yawO, speed: 0, phase: 0 };
      this._state.set(character, st);
    }
    const dt = Math.min(0.1, clock.delta / 1000);
    const dx = this._target.x - st.pos.x;
    const dz = this._target.z - st.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > 6) st.pos.copy(this._target); // teleported / far behind: catch up at once
    const wanted = d > 0.08 ? Math.min(5.5, d * 3.2) : 0;
    st.speed += (wanted - st.speed) * Math.min(1, dt * 6);
    const step = Math.min(d, st.speed * dt);
    if (d > 1e-4) (st.pos.x += (dx / d) * step), (st.pos.z += (dz / d) * step);
    st.pos.y += (character.position.y - st.pos.y) * Math.min(1, dt * 8);
    st.yaw = angleLerp(st.yaw, st.speed > 0.25 ? Math.atan2(dx, dz) : yawO, Math.min(1, dt * (st.speed > 0.25 ? 8 : 2)));
    st.phase += st.speed * dt * 9;

    // Walking: a little hop with each step, swaying side to side and nodding.
    // Standing: a slow breath.
    const moving = Math.min(1, st.speed / 1.2);
    const t = ticker.time + character.animationOffset;
    const hop = Math.abs(Math.sin(st.phase)) * 0.035 * moving * s;
    const roll = Math.sin(st.phase) * 0.07 * moving;
    const pitch = Math.sin(st.phase * 2) * 0.04 * moving;
    const breathe = 1 + 0.018 * Math.sin(t * 2.6) * (1 - moving);
    this._q.setFromAxisAngle(UP, st.yaw).multiply(this._q2.setFromAxisAngle(Z, roll)).multiply(this._q2.setFromAxisAngle(X, pitch));
    this._p.copy(st.pos);
    this._p.y += hop;
    const base = this._m.compose(this._p, this._q, this._s.set(s, s * breathe, s));
    meshes.place(i, base);

    // leash: owner's right hand → collar
    this._hand.setFromMatrixPosition(bones[BONE.rightHand].matrixWorld).applyMatrix4(character.matrix);
    this._collar.copy(meshes.collar).applyMatrix4(base);
    const dir = this._v.subVectors(this._collar, this._hand);
    const length = dir.length();
    this._q.setFromUnitVectors(UP, dir.normalize());
    this._leash.setMatrixAt(i, this._m.compose(this._hand, this._q, this._s.set(s, length, s)));
  };

  /** After all characters were posed this frame. */
  commit(count: number) {
    const n = Math.min(count, MAX);
    for (const dog of this._dogs) dog.commit(n);
    this._leash.count = n;
    this._leash.instanceMatrix.needsUpdate = true;
  }
}
