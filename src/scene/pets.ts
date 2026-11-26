// Pets for the 'walk the dog' / 'walk the cat' emotes: a low-poly dog or cat
// that follows its owner on the right side, legs stepping with its speed, tail
// wagging, on a leash from the owner's right hand. Same approach as the other
// props: InstancedMeshes (one instance per character), the pet's own motion
// state kept per character on this client — remote players' pets follow
// their owners the same way, so everyone sees them.

import {
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type Bone,
  type BufferGeometry,
} from 'three';
import { mergeBufferGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clock } from '../engine/clock';
import { ticker } from '../core/ticker';
import type { CharacterLocal } from '../engine/characters';
import { BONE, CAT_STATE, DOG_STATE } from './emotes';

const MAX = 128;
const HIDDEN = new Matrix4().makeScale(0, 0, 0);
const UP = new Vector3(0, 1, 0);
const X = new Vector3(1, 0, 0);
const WHITE = new Color('#ffffff');

type Kind = 'dog' | 'cat';

const at = (g: BufferGeometry, x: number, y: number, z: number) => g.translate(x, y, z).toNonIndexed();
const merge = (gs: BufferGeometry[]) => mergeBufferGeometries(gs)!;

/** Body geometry per kind, local frame: +z forward, y up, origin on the ground. */
interface Shape {
  torso: BufferGeometry; // tinted (coat)
  face: BufferGeometry; // eyes + nose (dark)
  collar: BufferGeometry; // red
  tail: BufferGeometry; // tinted, pivot at its base
  leg: BufferGeometry; // tinted, pivot at its top
  tailAt: Vector3;
  tailTilt: number; // radians back from vertical
  legs: Vector3[]; // leg pivots (hips / shoulders)
  collarAt: Vector3; // leash attachment
  coats: string[];
}

function dogShape(): Shape {
  const body = new CylinderGeometry(0.1, 0.1, 0.34, 10);
  body.rotateX(Math.PI / 2);
  const earL = new BoxGeometry(0.03, 0.1, 0.055);
  earL.rotateZ(0.35);
  const earR = new BoxGeometry(0.03, 0.1, 0.055);
  earR.rotateZ(-0.35);
  const head = new SphereGeometry(0.09, 10, 8);
  head.scale(1, 1, 1.12);
  const collar = new TorusGeometry(0.062, 0.014, 6, 14);
  collar.rotateX(Math.PI / 2.6);
  const tail = new CylinderGeometry(0.02, 0.01, 0.17, 6);
  tail.translate(0, 0.085, 0);
  const leg = new CylinderGeometry(0.03, 0.026, 0.2, 6);
  leg.translate(0, -0.1, 0);
  return {
    torso: merge([
      at(body, 0, 0.27, 0),
      at(new SphereGeometry(0.1, 10, 8), 0, 0.27, 0.17),
      at(new SphereGeometry(0.1, 10, 8), 0, 0.27, -0.17),
      at(head, 0, 0.39, 0.27),
      at(new BoxGeometry(0.075, 0.065, 0.1), 0, 0.36, 0.37),
      at(earL, 0.08, 0.37, 0.25),
      at(earR, -0.08, 0.37, 0.25),
    ]),
    face: merge([
      at(new BoxGeometry(0.035, 0.028, 0.022), 0, 0.383, 0.42),
      at(new SphereGeometry(0.013, 6, 4), 0.04, 0.42, 0.345),
      at(new SphereGeometry(0.013, 6, 4), -0.04, 0.42, 0.345),
    ]),
    collar: at(collar, 0, 0.33, 0.21),
    tail: tail.toNonIndexed(),
    leg: leg.toNonIndexed(),
    tailAt: new Vector3(0, 0.31, -0.24),
    tailTilt: 0.75,
    legs: [new Vector3(0.06, 0.2, 0.15), new Vector3(-0.06, 0.2, 0.15), new Vector3(0.06, 0.2, -0.15), new Vector3(-0.06, 0.2, -0.15)],
    collarAt: new Vector3(0, 0.33, 0.24),
    coats: ['#c98b4b', '#7a5232', '#e6ddcf'],
  };
}

function catShape(): Shape {
  const body = new CylinderGeometry(0.065, 0.065, 0.28, 10);
  body.rotateX(Math.PI / 2);
  const earL = new ConeGeometry(0.032, 0.07, 4);
  earL.rotateZ(-0.2);
  const earR = new ConeGeometry(0.032, 0.07, 4);
  earR.rotateZ(0.2);
  const collar = new TorusGeometry(0.05, 0.01, 6, 14);
  collar.rotateX(Math.PI / 2.4);
  const tail = new CylinderGeometry(0.014, 0.01, 0.28, 6);
  tail.translate(0, 0.14, 0);
  const leg = new CylinderGeometry(0.019, 0.017, 0.15, 6);
  leg.translate(0, -0.075, 0);
  return {
    torso: merge([
      at(body, 0, 0.2, 0),
      at(new SphereGeometry(0.065, 10, 8), 0, 0.2, 0.14),
      at(new SphereGeometry(0.065, 10, 8), 0, 0.2, -0.14),
      at(new SphereGeometry(0.075, 10, 8), 0, 0.29, 0.21),
      at(earL, 0.042, 0.365, 0.2),
      at(earR, -0.042, 0.365, 0.2),
    ]),
    face: merge([
      at(new SphereGeometry(0.011, 6, 4), 0.03, 0.305, 0.275),
      at(new SphereGeometry(0.011, 6, 4), -0.03, 0.305, 0.275),
      at(new SphereGeometry(0.009, 6, 4), 0, 0.283, 0.285),
    ]),
    collar: at(collar, 0, 0.25, 0.155),
    tail: tail.toNonIndexed(),
    leg: leg.toNonIndexed(),
    tailAt: new Vector3(0, 0.23, -0.19),
    tailTilt: 0.35,
    legs: [new Vector3(0.04, 0.15, 0.11), new Vector3(-0.04, 0.15, 0.11), new Vector3(0.04, 0.15, -0.11), new Vector3(-0.04, 0.15, -0.11)],
    collarAt: new Vector3(0, 0.25, 0.17),
    coats: ['#d9893b', '#8d8a86', '#3d3836'],
  };
}

function makeMesh(geometry: BufferGeometry, color: string, name: string, count: number, tinted: boolean) {
  const mesh = new InstancedMesh(geometry, new MeshLambertMaterial({ color }), count);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.count = 0;
  for (let i = 0; i < count; i++) {
    mesh.setMatrixAt(i, HIDDEN);
    if (tinted) mesh.setColorAt(i, WHITE); // compile with instance colors
  }
  return mesh;
}

class PetMeshes {
  readonly shape: Shape;
  readonly torso: InstancedMesh;
  readonly face: InstancedMesh;
  readonly collar: InstancedMesh;
  readonly tail: InstancedMesh;
  readonly legs: InstancedMesh;
  readonly all: InstancedMesh[];
  constructor(kind: Kind) {
    this.shape = kind === 'dog' ? dogShape() : catShape();
    this.torso = makeMesh(this.shape.torso, '#ffffff', `${kind} body`, MAX, true);
    this.face = makeMesh(this.shape.face, '#241c18', `${kind} face`, MAX, false);
    this.collar = makeMesh(this.shape.collar, '#c8413a', `${kind} collar`, MAX, false);
    this.tail = makeMesh(this.shape.tail, '#ffffff', `${kind} tail`, MAX, true);
    this.legs = makeMesh(this.shape.leg, '#ffffff', `${kind} legs`, MAX * 4, true);
    this.all = [this.torso, this.face, this.collar, this.tail, this.legs];
  }
  hide(i: number) {
    for (const m of [this.torso, this.face, this.collar, this.tail]) m.setMatrixAt(i, HIDDEN);
    for (let k = 0; k < 4; k++) this.legs.setMatrixAt(i * 4 + k, HIDDEN);
  }
}

interface PetState {
  kind: Kind;
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
  private _dog = new PetMeshes('dog');
  private _cat = new PetMeshes('cat');
  private _leash: InstancedMesh;
  private _state = new WeakMap<CharacterLocal, PetState>();

  private _m = new Matrix4();
  private _m2 = new Matrix4();
  private _q = new Quaternion();
  private _v = new Vector3();
  private _target = new Vector3();
  private _hand = new Vector3();
  private _collar = new Vector3();
  private _s = new Vector3();
  private _c = new Color();

  constructor() {
    this.group.name = 'pets';
    const leash = new CylinderGeometry(0.006, 0.006, 1, 4);
    leash.translate(0, 0.5, 0);
    this._leash = makeMesh(leash, '#c8413a', 'leash', MAX, false);
    this._leash.castShadow = false;
    this.group.add(...this._dog.all, ...this._cat.all, this._leash);
  }

  /** Engine hook: called per character right after its pose is baked. */
  pose = (character: CharacterLocal, i: number, bones: Bone[], stateWeight: (state: number) => number) => {
    if (i >= MAX) return;
    const dogW = stateWeight(DOG_STATE);
    const catW = stateWeight(CAT_STATE);
    const w = Math.max(dogW, catW);
    if (w < 0.35) {
      this._dog.hide(i);
      this._cat.hide(i);
      this._leash.setMatrixAt(i, HIDDEN);
      this._state.delete(character);
      return;
    }
    const kind: Kind = dogW >= catW ? 'dog' : 'cat';
    const meshes = kind === 'dog' ? this._dog : this._cat;
    (kind === 'dog' ? this._cat : this._dog).hide(i);
    const s = Math.min(1, (w - 0.35) / 0.4) * character.scale.x;
    const yawO = ownerYaw(character.quaternion);
    const fwd = this._v.set(Math.sin(yawO), 0, Math.cos(yawO));
    // the spot to walk at: on the owner's right (-x local), a little ahead
    this._target.copy(character.position).addScaledVector(fwd, 0.3).add(new Vector3(-Math.cos(yawO), 0, Math.sin(yawO)).multiplyScalar(0.6));

    let st = this._state.get(character);
    if (!st || st.kind !== kind) {
      st = { kind, pos: this._target.clone(), yaw: yawO, speed: 0, phase: 0 };
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
    if (d > 1e-4) st.pos.x += (dx / d) * step, st.pos.z += (dz / d) * step;
    st.pos.y += (character.position.y - st.pos.y) * Math.min(1, dt * 8);
    st.yaw = angleLerp(st.yaw, st.speed > 0.25 ? Math.atan2(dx, dz) : yawO, Math.min(1, dt * (st.speed > 0.25 ? 8 : 2)));
    st.phase += st.speed * dt * (kind === 'dog' ? 9 : 11);

    // body
    this._q.setFromAxisAngle(UP, st.yaw);
    const base = this._m.compose(st.pos, this._q, this._s.setScalar(s));
    meshes.torso.setMatrixAt(i, base);
    meshes.face.setMatrixAt(i, base);
    meshes.collar.setMatrixAt(i, base);
    const coat = meshes.shape.coats[Math.floor((((character.userData.seed ?? 0) % 1) + 1) % 1 * 3) % 3];
    this._c.set(coat);
    meshes.torso.setColorAt(i, this._c);
    meshes.tail.setColorAt(i, this._c);
    // tail: wag fast (dog) / sway slowly (cat), livelier when standing
    const t = ticker.time + character.animationOffset;
    const wag = kind === 'dog' ? Math.sin(t * (st.speed > 0.25 ? 10 : 16)) * 0.55 : Math.sin(t * 2.2) * 0.45;
    const sh = meshes.shape;
    this._m2.makeRotationAxis(X, -sh.tailTilt).premultiply(new Matrix4().makeRotationAxis(UP, wag)).setPosition(sh.tailAt);
    meshes.tail.setMatrixAt(i, this._m2.premultiply(base));
    // legs: diagonal pairs step together
    const amp = 0.65 * Math.min(1, st.speed / 1.2);
    sh.legs.forEach((p, k) => {
      const swing = Math.sin(st!.phase + (k === 0 || k === 3 ? 0 : Math.PI)) * amp;
      this._m2.makeRotationAxis(X, swing).setPosition(p);
      meshes.legs.setMatrixAt(i * 4 + k, this._m2.premultiply(base));
      meshes.legs.setColorAt(i * 4 + k, this._c);
    });
    // leash: owner's right hand → collar
    this._hand.setFromMatrixPosition(bones[BONE.rightHand].matrixWorld).applyMatrix4(character.matrix);
    this._collar.copy(sh.collarAt).applyMatrix4(base);
    const dir = this._v.subVectors(this._collar, this._hand);
    const length = dir.length();
    this._q.setFromUnitVectors(UP, dir.normalize());
    this._leash.setMatrixAt(i, this._m2.compose(this._hand, this._q, this._s.set(s, length, s)));
  };

  /** After all characters were posed this frame. */
  commit(count: number) {
    const n = Math.min(count, MAX);
    for (const pet of [this._dog, this._cat]) {
      for (const m of [pet.torso, pet.face, pet.collar, pet.tail]) m.count = n;
      pet.legs.count = n * 4;
      for (const m of pet.all) {
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
    }
    this._leash.count = n;
    this._leash.instanceMatrix.needsUpdate = true;
  }
}
