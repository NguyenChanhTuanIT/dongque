// Guitar prop for the 'guitar' emote: one InstancedMesh per color (one
// instance per character). Posed every frame from the character's baked
// bones: the body sits in front of the belly (from the chest bone) and the
// neck points at the left hand, so the hands always match the instrument.

import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Vector3,
  type Bone,
  type BufferGeometry,
} from 'three';
import { mergeBufferGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CharacterLocal } from '../engine/characters';
import { BONE, GUITAR_STATE } from './emotes';

const MAX_INSTANCES = 128;
const SCALE = 0.8;
const HIDDEN = new Matrix4().makeScale(0, 0, 0);

// Local frame: +x along the neck (toward the headstock), +y across the body,
// +z out of the soundboard (toward the audience). Origin = lower bout center.
function disc(r: number, depth: number, x: number, z = 0): BufferGeometry {
  const g = new CylinderGeometry(r, r, depth, 18);
  g.rotateX(Math.PI / 2);
  g.translate(x, 0, z);
  return g.toNonIndexed();
}
function box(sx: number, sy: number, sz: number, x: number, z: number): BufferGeometry {
  const g = new BoxGeometry(sx, sy, sz);
  g.translate(x, 0, z);
  return g.toNonIndexed();
}
const merge = (gs: BufferGeometry[]) => mergeBufferGeometries(gs)!;

const PARTS: Array<{ name: string; color: string; geometry: () => BufferGeometry }> = [
  { name: 'guitar body', color: '#c98a3f', geometry: () => merge([disc(0.17, 0.08, 0), disc(0.13, 0.08, 0.2)]) },
  { name: 'guitar neck', color: '#6b4a2b', geometry: () => merge([box(0.44, 0.05, 0.03, 0.54, 0.015)]) },
  { name: 'guitar dark', color: '#3b2616', geometry: () => merge([disc(0.045, 0.004, 0.13, 0.041), box(0.13, 0.075, 0.03, 0.82, 0.015), box(0.07, 0.025, 0.012, -0.08, 0.045)]) },
  { name: 'guitar strings', color: '#efe8d8', geometry: () => merge([box(0.86, 0.022, 0.004, 0.37, 0.044)]) },
];

function makeMesh(geometry: BufferGeometry, color: string, name: string) {
  const mesh = new InstancedMesh(geometry, new MeshLambertMaterial({ color }), MAX_INSTANCES);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.count = 0;
  for (let i = 0; i < MAX_INSTANCES; i++) mesh.setMatrixAt(i, HIDDEN);
  return mesh;
}

export class GuitarProp {
  readonly group = new Group();
  private _meshes = PARTS.map((p) => makeMesh(p.geometry(), p.color, p.name));

  private _m = new Matrix4();
  private _chest = new Vector3();
  private _hand = new Vector3();
  private _fwd = new Vector3();
  private _right = new Vector3();
  private _x = new Vector3();
  private _y = new Vector3();
  private _z = new Vector3();

  constructor() {
    this.group.name = 'guitar';
    this.group.add(...this._meshes);
  }

  /** Engine hook: called per character right after its pose is baked. */
  pose = (character: CharacterLocal, i: number, bones: Bone[], stateWeight: (state: number) => number) => {
    if (i >= MAX_INSTANCES) return;
    const weight = stateWeight(GUITAR_STATE);
    if (weight < 0.35) {
      for (const mesh of this._meshes) mesh.setMatrixAt(i, HIDDEN);
      return;
    }
    const world = character.matrix;
    const s = SCALE * Math.min(1, (weight - 0.35) / 0.4) * character.scale.x;
    this._fwd.set(0, 0, 1).applyQuaternion(character.quaternion);
    this._right.set(-1, 0, 0).applyQuaternion(character.quaternion); // the kid's right side is -x

    // Body: in front of the belly, a bit to the right (strumming side).
    this._chest.setFromMatrixPosition(bones[BONE.chest].matrixWorld).applyMatrix4(world);
    this._chest.addScaledVector(this._fwd, 0.17 * character.scale.x).addScaledVector(this._right, 0.05 * character.scale.x);
    this._chest.y -= 0.2 * character.scale.x;
    // Neck: toward the left hand.
    this._hand.setFromMatrixPosition(bones[BONE.leftHand].matrixWorld).applyMatrix4(world);
    this._x.subVectors(this._hand, this._chest).normalize();
    // Soundboard faces forward (orthogonalized against the neck).
    this._z.copy(this._fwd).addScaledVector(this._x, -this._fwd.dot(this._x)).normalize();
    this._y.crossVectors(this._z, this._x);
    this._m.makeBasis(this._x.multiplyScalar(s), this._y.multiplyScalar(s), this._z.multiplyScalar(s));
    this._m.setPosition(this._chest);
    for (const mesh of this._meshes) mesh.setMatrixAt(i, this._m);
  };

  /** After all characters were posed this frame. */
  commit(count: number) {
    for (const mesh of this._meshes) {
      mesh.count = Math.min(count, MAX_INSTANCES);
      mesh.instanceMatrix.needsUpdate = true;
    }
  }
}
