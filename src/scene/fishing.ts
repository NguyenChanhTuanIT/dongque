// Fishing props for the 'fish' emote: rod in the right hand, line, bobber and
// a fish that comes out of the water on the yank. One InstancedMesh per prop
// (one instance per character, like the kids themselves); posed every frame
// from the character's baked hand bone and the emote clip's phase.

import {
  ConeGeometry,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
  type Bone,
  type BufferGeometry,
} from 'three';
import { mergeBufferGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ticker } from '../core/ticker';
import type { CharacterLocal } from '../engine/characters';
import { BONE, FISH_PERIOD, FISH_STATE, fishPull, fishRodDir } from './emotes';

const MAX_INSTANCES = 128;
const ROD_LENGTH = 1.25;
/** The grip extends a little behind the hand. */
const ROD_BEHIND = 0.12;
const UP = new Vector3(0, 1, 0);
const HIDDEN = new Matrix4().makeScale(0, 0, 0);

function rodGeometry(): BufferGeometry {
  const rod = new CylinderGeometry(0.006, 0.016, ROD_LENGTH, 6);
  rod.translate(0, ROD_LENGTH / 2 - ROD_BEHIND, 0);
  const reel = new CylinderGeometry(0.03, 0.03, 0.025, 10);
  reel.rotateZ(Math.PI / 2);
  reel.translate(0.025, 0.06, 0);
  return mergeBufferGeometries([rod.toNonIndexed(), reel.toNonIndexed()])!;
}

function fishGeometry(): BufferGeometry {
  // Hanging head-down from the hook: body along -y, tail on top.
  const body = new SphereGeometry(0.05, 10, 8);
  body.scale(0.75, 2.1, 0.45);
  body.translate(0, -0.1, 0);
  const tail = new ConeGeometry(0.045, 0.07, 3);
  tail.scale(1, 1, 0.3);
  tail.translate(0, 0.035, 0);
  return mergeBufferGeometries([body.toNonIndexed(), tail.toNonIndexed()])!;
}

function lineGeometry(): BufferGeometry {
  const line = new CylinderGeometry(0.0035, 0.0035, 1, 3);
  line.translate(0, 0.5, 0); // base at origin, length 1 along +y
  return line;
}

function makeMesh(geometry: BufferGeometry, color: string, castShadow: boolean, name: string) {
  const mesh = new InstancedMesh(geometry, new MeshLambertMaterial({ color }), MAX_INSTANCES);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.castShadow = castShadow;
  mesh.count = 0;
  for (let i = 0; i < MAX_INSTANCES; i++) mesh.setMatrixAt(i, HIDDEN);
  return mesh;
}

export class FishingGear {
  readonly group = new Group();
  private _rod = makeMesh(rodGeometry(), '#6b4a2b', true, 'fishing rod');
  private _line = makeMesh(lineGeometry(), '#2f2f2f', false, 'fishing line');
  private _bobber = makeMesh(new SphereGeometry(0.04, 10, 8), '#d8432c', true, 'bobber');
  private _fish = makeMesh(fishGeometry(), '#e8913a', true, 'fish');

  private _m = new Matrix4();
  private _q = new Quaternion();
  private _q2 = new Quaternion();
  private _hand = new Vector3();
  private _dir = new Vector3();
  private _tip = new Vector3();
  private _float = new Vector3();
  private _scale = new Vector3();

  constructor() {
    this.group.name = 'fishing gear';
    this.group.add(this._rod, this._line, this._bobber, this._fish);
  }

  private _hide(i: number) {
    this._rod.setMatrixAt(i, HIDDEN);
    this._line.setMatrixAt(i, HIDDEN);
    this._bobber.setMatrixAt(i, HIDDEN);
    this._fish.setMatrixAt(i, HIDDEN);
  }

  /** Engine hook: called per character right after its pose is baked. */
  pose = (character: CharacterLocal, i: number, bones: Bone[], stateWeight: (state: number) => number) => {
    if (i >= MAX_INSTANCES) return;
    const weight = stateWeight(FISH_STATE);
    if (weight < 0.35) {
      this._hide(i);
      return;
    }
    const phase = (((ticker.time + character.animationOffset) % FISH_PERIOD) + FISH_PERIOD) % FISH_PERIOD / FISH_PERIOD;
    const pull = fishPull(phase);
    const world = character.matrix;
    const appear = Math.min(1, (weight - 0.35) / 0.4);
    const s = appear * character.scale.x;

    // Rod: from the right hand along the clip's rod direction.
    this._hand.setFromMatrixPosition(bones[BONE.rightHand].matrixWorld).applyMatrix4(world);
    this._dir.copy(fishRodDir(phase)).applyQuaternion(character.quaternion).normalize();
    this._q.setFromUnitVectors(UP, this._dir);
    this._m.compose(this._hand, this._q, this._scale.setScalar(s));
    this._rod.setMatrixAt(i, this._m);
    this._tip.copy(this._hand).addScaledVector(this._dir, (ROD_LENGTH - ROD_BEHIND) * s);

    // Bobber: floating ahead while waiting, hanging under the tip when yanked.
    const bob = 0.015 * Math.sin(ticker.time * 3 + character.animationOffset);
    const out = this._float.set(0.25, 0.02 + bob, 2.3).applyMatrix4(world);
    const hang = this._hand.clone().copy(this._tip).add(this._scale.set(0, -0.42 * s, 0));
    const end = out.lerp(hang, pull);
    this._m.compose(end, this._q2.identity(), this._scale.setScalar(s * (1 - pull)));
    this._bobber.setMatrixAt(i, this._m);

    // Line: tip → end.
    this._dir.subVectors(end, this._tip);
    const length = this._dir.length();
    this._q.setFromUnitVectors(UP, this._dir.normalize());
    this._m.compose(this._tip, this._q, this._scale.set(s, length, s));
    this._line.setMatrixAt(i, this._m);

    // Fish: out of the water on the yank, wiggling on the hook.
    if (pull > 0.25) {
      const wiggle = 0.5 * Math.sin(ticker.time * 18);
      this._q.setFromAxisAngle(UP, wiggle).premultiply(this._q2.setFromAxisAngle(this._dir.set(0, 0, 1), 0.25 * wiggle));
      this._m.compose(end, this._q, this._scale.setScalar(s * Math.min(1, (pull - 0.25) / 0.3)));
      this._fish.setMatrixAt(i, this._m);
    } else {
      this._fish.setMatrixAt(i, HIDDEN);
    }
  };

  /** After all characters were posed this frame. */
  commit(count: number) {
    for (const mesh of [this._rod, this._line, this._bobber, this._fish]) {
      mesh.count = Math.min(count, MAX_INSTANCES);
      mesh.instanceMatrix.needsUpdate = true;
    }
  }
}
