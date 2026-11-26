// Hand props for the kite and ice-cream emotes. Same approach as fishing.ts /
// guitar.ts: one InstancedMesh per piece (one instance per character), posed
// every frame from the character's baked right hand; colors come from the
// player's color seed (instance colors), so every kite and scoop differs.

import {
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
  type Bone,
} from 'three';
import { ticker } from '../core/ticker';
import type { CharacterLocal } from '../engine/characters';
import { BONE, ICECREAM_STATE, KITE_STATE, OFFER_ICECREAM_STATE, TREAT_ICECREAM_STATE } from './emotes';

const MAX = 128;
const TAIL_BOWS = 4;
const HIDDEN = new Matrix4().makeScale(0, 0, 0);
const UP = new Vector3(0, 1, 0);

const WHITE = new Color('#ffffff');

/**
 * `tinted`: per-character colors (instance colors, created up front so the
 * shader is compiled with them) on an unlit material — bright like a toy,
 * whatever side the sun is on.
 */
function makeMesh(geometry: BufferGeometry, color: string, name: string, count = MAX, opts: { doubleSided?: boolean; tinted?: boolean; unlit?: boolean } = {}) {
  const params = { color, side: opts.doubleSided ? DoubleSide : undefined };
  const material = opts.tinted || opts.unlit ? new MeshBasicMaterial(params) : new MeshLambertMaterial(params);
  const mesh = new InstancedMesh(geometry, material, count);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.count = 0;
  for (let i = 0; i < count; i++) {
    mesh.setMatrixAt(i, HIDDEN);
    if (opts.tinted) mesh.setColorAt(i, WHITE);
  }
  return mesh;
}

/** Diamond in the XY plane (facing +z), `w` wide, from y = -h1 to y = +h2. */
function diamond(w: number, h1: number, h2: number, ySplit: number): BufferGeometry {
  const g = new BufferGeometry();
  const p = [0, h2, 0, -w / 2, ySplit, 0, 0, -h1, 0, 0, h2, 0, 0, -h1, 0, w / 2, ySplit, 0];
  g.setAttribute('position', new Float32BufferAttribute(p, 3));
  g.computeVertexNormals();
  return g;
}

/** Hue of a player from its color seed (same as the shirt color shader). */
const seedColor = (seed: number | undefined, s: number, l: number, out: Color) =>
  out.setHSL(((seed ?? 0) % 1 + 1) % 1, s, l);

export class HandProps {
  readonly group = new Group();
  // Kite
  private _sail = makeMesh(diamond(0.8, 0.75, 0.45, 0.1), '#ffffff', 'kite sail', MAX, { doubleSided: true, tinted: true });
  private _frame = makeMesh(new CylinderGeometry(0.012, 0.012, 1.2, 4), '#5a3b22', 'kite frame', MAX * 2);
  private _bows = makeMesh(diamond(0.14, 0.07, 0.07, 0), '#ffffff', 'kite tail', MAX * TAIL_BOWS, { doubleSided: true, tinted: true });
  private _string = makeMesh((() => { const g = new CylinderGeometry(0.004, 0.004, 1, 3); g.translate(0, 0.5, 0); return g; })(), '#f2efe6', 'kite string');
  // Ice cream
  private _cone = makeMesh((() => { const g = new ConeGeometry(0.034, 0.11, 10); g.rotateX(Math.PI); g.translate(0, -0.055, 0); return g; })(), '#d89a50', 'cone', MAX, { unlit: true });
  private _scoop = makeMesh(new SphereGeometry(0.042, 12, 10), '#ffffff', 'scoop', MAX, { tinted: true });

  private _all = [this._sail, this._frame, this._bows, this._string, this._cone, this._scoop];
  private _m = new Matrix4();
  private _q = new Quaternion();
  private _q2 = new Quaternion();
  private _hand = new Vector3();
  private _kite = new Vector3();
  private _fwd = new Vector3();
  private _x = new Vector3();
  private _y = new Vector3();
  private _z = new Vector3();
  private _v = new Vector3();
  private _s = new Vector3();
  private _c = new Color();

  constructor() {
    this.group.name = 'hand props';
    this.group.add(...this._all);
    this._string.castShadow = false;
  }

  private _hideKite(i: number) {
    this._sail.setMatrixAt(i, HIDDEN);
    this._string.setMatrixAt(i, HIDDEN);
    for (let k = 0; k < 2; k++) this._frame.setMatrixAt(i * 2 + k, HIDDEN);
    for (let k = 0; k < TAIL_BOWS; k++) this._bows.setMatrixAt(i * TAIL_BOWS + k, HIDDEN);
  }

  /** Engine hook: called per character right after its pose is baked. */
  pose = (character: CharacterLocal, i: number, bones: Bone[], stateWeight: (state: number) => number) => {
    if (i >= MAX) return;
    const kiteW = stateWeight(KITE_STATE);
    // own ice cream, one held out to someone, one we were treated to
    const creamW = stateWeight(ICECREAM_STATE) + stateWeight(OFFER_ICECREAM_STATE) + stateWeight(TREAT_ICECREAM_STATE);
    const scale = character.scale.x;
    if (kiteW > 0.35 || creamW > 0.35) {
      this._hand.setFromMatrixPosition(bones[BONE.rightHand].matrixWorld).applyMatrix4(character.matrix);
    }
    if (kiteW > 0.35) this._poseKite(character, i, Math.min(1, (kiteW - 0.35) / 0.4) * scale);
    else this._hideKite(i);
    if (creamW > 0.35) this._poseIceCream(character, i, Math.min(1, (creamW - 0.35) / 0.4) * scale);
    else {
      this._cone.setMatrixAt(i, HIDDEN);
      this._scoop.setMatrixAt(i, HIDDEN);
    }
  };

  private _poseKite(character: CharacterLocal, i: number, s: number) {
    const t = ticker.time + character.animationOffset;
    this._fwd.set(0, 0, 1).applyQuaternion(character.quaternion);
    this._x.set(-1, 0, 0).applyQuaternion(character.quaternion); // the kid's right
    // High up in front, drifting in a slow figure eight.
    this._kite.copy(this._hand)
      .addScaledVector(this._fwd, 5.2 * s)
      .addScaledVector(UP, (4.2 + 0.35 * Math.sin(t * 0.9)) * s)
      .addScaledVector(this._x, 0.9 * Math.sin(t * 0.45) * s);
    // Sail faces the flyer, leaning back; it rolls a little in the wind.
    this._z.subVectors(this._hand, this._kite).normalize();
    this._y.copy(UP).addScaledVector(this._z, -UP.dot(this._z)).normalize();
    this._x.crossVectors(this._y, this._z);
    this._m.makeBasis(this._x, this._y, this._z);
    this._q.setFromRotationMatrix(this._m).multiply(this._q2.setFromAxisAngle(this._v.set(0, 0, 1), 0.25 * Math.sin(t * 1.7)));
    seedColor(character.userData.seed, 0.65, 0.58, this._c);
    this._m.compose(this._kite, this._q, this._s.setScalar(s));
    this._sail.setMatrixAt(i, this._m);
    this._sail.setColorAt(i, this._c);
    // Frame: a vertical spine and a cross spar.
    this._m.compose(this._v.set(0, -0.15, 0.01).applyQuaternion(this._q).multiplyScalar(s).add(this._kite), this._q, this._s.setScalar(s));
    this._frame.setMatrixAt(i * 2, this._m);
    this._q2.setFromAxisAngle(this._v.set(0, 0, 1), Math.PI / 2);
    this._m.compose(this._v.set(0, 0.1, 0.01).applyQuaternion(this._q).multiplyScalar(s).add(this._kite), this._q.clone().multiply(this._q2), this._s.set(s, s * 0.66, s));
    this._frame.setMatrixAt(i * 2 + 1, this._m);
    // Tail: bows hanging under the kite, waving.
    for (let k = 0; k < TAIL_BOWS; k++) {
      const down = 0.75 + 0.28 * (k + 1);
      this._v.set(0.16 * Math.sin(t * 3.1 + k * 0.9) * (k + 1) * 0.5, -down, 0).applyQuaternion(this._q).multiplyScalar(s).add(this._kite);
      this._m.compose(this._v, this._q, this._s.setScalar(s));
      this._bows.setMatrixAt(i * TAIL_BOWS + k, this._m);
      this._bows.setColorAt(i * TAIL_BOWS + k, k % 2 ? this._c : this._c.clone().offsetHSL(0.5, 0, 0));
    }
    // String: hand → bottom of the kite.
    const bottom = this._v.set(0, -0.6, 0).applyQuaternion(this._q).multiplyScalar(s).add(this._kite);
    const dir = this._y.subVectors(bottom, this._hand);
    const length = dir.length();
    this._q.setFromUnitVectors(UP, dir.normalize());
    this._m.compose(this._hand, this._q, this._s.set(s, length, s));
    this._string.setMatrixAt(i, this._m);
  }

  private _poseIceCream(character: CharacterLocal, i: number, size: number) {
    const s = size * 1.4; // readable at game distance
    // Upright cone held in the hand, scoop on top.
    this._q.copy(character.quaternion);
    this._m.compose(this._v.copy(this._hand).addScaledVector(UP, 0.06 * s), this._q, this._s.setScalar(s));
    this._cone.setMatrixAt(i, this._m);
    this._m.compose(this._v.copy(this._hand).addScaledVector(UP, 0.085 * s), this._q, this._s.setScalar(s));
    this._scoop.setMatrixAt(i, this._m);
    this._scoop.setColorAt(i, seedColor(character.userData.seed, 0.7, 0.8, this._c));
  }

  /** After all characters were posed this frame. */
  commit(count: number) {
    this._sail.count = this._string.count = this._cone.count = this._scoop.count = Math.min(count, MAX);
    this._frame.count = Math.min(count, MAX) * 2;
    this._bows.count = Math.min(count, MAX) * TAIL_BOWS;
    for (const mesh of this._all) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }
}
