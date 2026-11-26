// Pets for the 'walk the dog' / 'walk the cat' emotes: a low-poly dog or cat
// that follows its owner on the right side, legs stepping with its speed, tail
// wagging, on a leash from the owner's right hand. Same approach as the other
// props: InstancedMeshes (one instance per character), the pet's own motion
// state kept per character on this client — remote players' pets follow
// their owners the same way, so everyone sees them.

import {
  BoxGeometry,
  CatmullRomCurve3,
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
  TubeGeometry,
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
const ball = (r: number, sx = 1, sy = 1, sz = 1) => new SphereGeometry(r, 12, 9).scale(sx, sy, sz);
const v = (x: number, y: number, z: number) => new Vector3(x, y, z);

/**
 * A smooth tube along a Catmull-Rom curve through `points`, tapering from
 * radius r0 at the base to r1 at the tip, with a rounded tip.
 */
function tube(points: Vector3[], r0: number, r1: number, segments = 28, radial = 8): BufferGeometry {
  const curve = new CatmullRomCurve3(points, false, 'centripetal');
  const geo = new TubeGeometry(curve, segments, 1, radial, false);
  // TubeGeometry builds rings of (radial + 1) vertices around curve.getPointAt(i / segments)
  const pos = geo.attributes.position;
  const p = new Vector3();
  const o = new Vector3();
  for (let i = 0; i <= segments; i++) {
    const u = i / segments;
    curve.getPointAt(u, p);
    const r = r0 + (r1 - r0) * u;
    for (let j = 0; j <= radial; j++) {
      const k = i * (radial + 1) + j;
      o.fromBufferAttribute(pos, k).sub(p).multiplyScalar(r).add(p);
      pos.setXYZ(k, o.x, o.y, o.z);
    }
  }
  const tip = points[points.length - 1];
  return merge([geo.toNonIndexed(), at(new SphereGeometry(r1, radial, 6), tip.x, tip.y, tip.z)]);
}

/** A leg hanging from its pivot (top), tapered, with a paw resting on the ground. */
function legGeometry(length: number, rTop: number, rBottom: number, paw: number): BufferGeometry {
  const leg = new CylinderGeometry(rBottom, rTop, length - paw, 7);
  return merge([at(leg, 0, -(length - paw) / 2, 0), at(ball(paw, 1, 0.65, 1.35), 0, -length + paw * 0.65, paw * 0.35)]);
}

interface Detail {
  name: string;
  color: string;
  geometry: BufferGeometry;
}

/** Body geometry per kind, local frame: +z forward, y up, origin on the ground. */
interface Shape {
  torso: BufferGeometry; // tinted (coat)
  accent: BufferGeometry; // tinted with a darker shade of the coat (dog ears, cat stripes)
  details: Detail[]; // fixed colours: eyes, nose, markings, collar…
  tail: BufferGeometry; // tinted, pivot at its base, already curved in the body frame
  leg: BufferGeometry; // tinted, pivot at its top
  tailAt: Vector3;
  legs: Vector3[]; // leg pivots: front right, front left, back right, back left
  collarAt: Vector3; // leash attachment
  coats: string[];
}

function dogShape(): Shape {
  const neck = new CylinderGeometry(0.058, 0.075, 0.15, 10);
  neck.rotateX(0.55);
  const muzzle = new CylinderGeometry(0.036, 0.05, 0.1, 10);
  muzzle.rotateX(Math.PI / 2);
  const ear = (side: number) => {
    const g = ball(0.062, 0.3, 1, 0.7);
    g.rotateZ(0.28 * side);
    return at(g, 0.082 * side, 0.425, 0.235);
  };
  const collar = new TorusGeometry(0.063, 0.012, 6, 16);
  collar.rotateX(-(Math.PI / 2 - 0.55));
  const tongue = new BoxGeometry(0.026, 0.006, 0.036);
  tongue.rotateX(0.35);
  return {
    torso: merge([
      at(ball(0.112, 1, 1.05, 1.1), 0, 0.3, 0.1), // chest
      at(ball(0.098, 1, 0.94, 1.9), 0, 0.29, -0.02), // belly
      at(ball(0.094), 0, 0.295, -0.14), // hips
      at(ball(0.058, 0.75, 1.15, 1.05), 0.062, 0.255, -0.14), // haunches
      at(ball(0.058, 0.75, 1.15, 1.05), -0.062, 0.255, -0.14),
      at(ball(0.05, 0.8, 1.2, 1), 0.064, 0.26, 0.13), // shoulders
      at(ball(0.05, 0.8, 1.2, 1), -0.064, 0.26, 0.13),
      at(neck, 0, 0.375, 0.17),
      at(ball(0.086, 1, 0.95, 1.05), 0, 0.455, 0.245), // head
      at(muzzle, 0, 0.425, 0.33),
      at(ball(0.036, 1, 0.9, 1), 0, 0.425, 0.375), // muzzle tip
    ]),
    accent: merge([ear(1), ear(-1)]), // floppy ears
    details: [
      {
        name: 'markings',
        color: '#f4ead8',
        geometry: merge([
          at(ball(0.072, 0.9, 1.25, 0.6), 0, 0.31, 0.18), // chest blaze
          at(ball(0.034, 1.1, 0.7, 1.2), 0, 0.408, 0.345), // chin
        ]),
      },
      {
        name: 'face',
        color: '#1e1714',
        geometry: merge([
          at(ball(0.021, 1.35, 0.95, 1), 0, 0.438, 0.405), // nose
          at(ball(0.014), 0.037, 0.475, 0.31), // eyes
          at(ball(0.014), -0.037, 0.475, 0.31),
        ]),
      },
      { name: 'tongue', color: '#e07a86', geometry: at(tongue, 0, 0.395, 0.365) },
      { name: 'collar', color: '#c8413a', geometry: at(collar, 0, 0.37, 0.185) },
      { name: 'tag', color: '#e8c24a', geometry: at(ball(0.015, 1, 1, 0.5), 0, 0.322, 0.232) },
    ],
    tail: tube([v(0, 0, 0), v(0, 0.05, -0.06), v(0, 0.12, -0.08), v(0, 0.18, -0.05)], 0.024, 0.01),
    leg: legGeometry(0.215, 0.034, 0.024, 0.028),
    tailAt: v(0, 0.33, -0.22),
    legs: [v(0.062, 0.215, 0.13), v(-0.062, 0.215, 0.13), v(0.062, 0.215, -0.15), v(-0.062, 0.215, -0.15)],
    collarAt: v(0, 0.36, 0.215),
    coats: ['#c98b4b', '#7a5232', '#e6ddcf'],
  };
}

function catShape(): Shape {
  const neck = new CylinderGeometry(0.04, 0.05, 0.08, 10);
  neck.rotateX(0.4);
  const ear = (side: number, inner: boolean) => {
    const g = inner ? new ConeGeometry(0.017, 0.04, 4) : new ConeGeometry(0.031, 0.066, 4);
    g.rotateY(Math.PI / 4);
    g.scale(1, 1, 0.45);
    g.rotateZ(-0.28 * side);
    return at(g, 0.043 * side, inner ? 0.37 : 0.375, inner ? 0.172 : 0.165);
  };
  const collar = new TorusGeometry(0.047, 0.009, 6, 16);
  collar.rotateX(-(Math.PI / 2 - 0.4));
  // tabby stripe: an arc over the back, around the body's long axis
  const stripe = (z: number, r: number) => {
    const g = new TorusGeometry(r, 0.0055, 4, 10, Math.PI * 0.55);
    g.rotateZ(Math.PI * 0.225);
    return at(g, 0, 0.212, z);
  };
  const whisker = (side: number, tilt: number) => {
    const g = new BoxGeometry(0.075, 0.0025, 0.0025);
    g.rotateZ(tilt * side);
    g.rotateY(-0.35 * side);
    return at(g, 0.05 * side, 0.293, 0.226);
  };
  const eye = (side: number) => at(ball(0.015, 1, 1.1, 0.6), 0.03 * side, 0.322, 0.229);
  const pupil = (side: number) => at(new BoxGeometry(0.0055, 0.022, 0.004), 0.03 * side, 0.322, 0.236);
  return {
    torso: merge([
      at(ball(0.068, 1, 1.05, 1.1), 0, 0.222, 0.08), // chest
      at(ball(0.066, 0.95, 0.95, 2), 0, 0.212, -0.02), // body
      at(ball(0.07), 0, 0.216, -0.11), // hips
      at(ball(0.045, 0.7, 1.15, 1.05), 0.042, 0.185, -0.11), // haunches
      at(ball(0.045, 0.7, 1.15, 1.05), -0.042, 0.185, -0.11),
      at(neck, 0, 0.27, 0.125),
      at(ball(0.07, 1.12, 0.95, 0.95), 0, 0.31, 0.17), // head
      ear(1, false),
      ear(-1, false),
    ]),
    accent: merge([
      stripe(0.035, 0.07),
      stripe(-0.02, 0.066),
      stripe(-0.075, 0.066),
      stripe(-0.125, 0.07),
      at(new BoxGeometry(0.008, 0.004, 0.05), 0, 0.376, 0.17), // forehead stripe
    ]),
    details: [
      {
        name: 'markings',
        color: '#f6f1ea',
        geometry: merge([
          at(ball(0.025), 0.018, 0.29, 0.222), // cheeks
          at(ball(0.025), -0.018, 0.29, 0.222),
          at(ball(0.045, 0.85, 1.1, 0.55), 0, 0.225, 0.135), // chest
          whisker(1, 0.12),
          whisker(1, -0.08),
          whisker(-1, 0.12),
          whisker(-1, -0.08),
        ]),
      },
      { name: 'eyes', color: '#a6c93a', geometry: merge([eye(1), eye(-1)]) },
      { name: 'face', color: '#1e1714', geometry: merge([pupil(1), pupil(-1)]) },
      { name: 'pink', color: '#e8949c', geometry: merge([at(ball(0.009, 1.4, 0.8, 0.8), 0, 0.302, 0.243), ear(1, true), ear(-1, true)]) },
      { name: 'collar', color: '#3a7fc8', geometry: at(collar, 0, 0.265, 0.14) },
      { name: 'tag', color: '#e8c24a', geometry: at(ball(0.011, 1, 1, 0.5), 0, 0.233, 0.175) },
    ],
    // raised, curling forward at the tip
    tail: tube([v(0, 0, 0), v(0, 0.03, -0.07), v(0, 0.12, -0.12), v(0, 0.22, -0.125), v(0, 0.285, -0.09), v(0, 0.3, -0.035)], 0.02, 0.013),
    leg: legGeometry(0.17, 0.025, 0.018, 0.021),
    tailAt: v(0, 0.23, -0.16),
    legs: [v(0.036, 0.17, 0.08), v(-0.036, 0.17, 0.08), v(0.042, 0.17, -0.11), v(-0.042, 0.17, -0.11)],
    collarAt: v(0, 0.255, 0.165),
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
  readonly accent: InstancedMesh;
  readonly tail: InstancedMesh;
  readonly legs: InstancedMesh;
  /** Everything placed with the body matrix (one instance per character). */
  readonly body: InstancedMesh[];
  readonly all: InstancedMesh[];
  constructor(kind: Kind) {
    this.shape = kind === 'dog' ? dogShape() : catShape();
    this.torso = makeMesh(this.shape.torso, '#ffffff', `${kind} body`, MAX, true);
    this.accent = makeMesh(this.shape.accent, '#ffffff', `${kind} accent`, MAX, true);
    this.tail = makeMesh(this.shape.tail, '#ffffff', `${kind} tail`, MAX, true);
    this.legs = makeMesh(this.shape.leg, '#ffffff', `${kind} legs`, MAX * 4, true);
    const details = this.shape.details.map((d) => makeMesh(d.geometry, d.color, `${kind} ${d.name}`, MAX, false));
    this.body = [this.torso, this.accent, ...details];
    this.all = [...this.body, this.tail, this.legs];
  }
  hide(i: number) {
    for (const m of this.body) m.setMatrixAt(i, HIDDEN);
    this.tail.setMatrixAt(i, HIDDEN);
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
  private _accent = new Color();

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
    for (const m of meshes.body) m.setMatrixAt(i, base);
    const coat = meshes.shape.coats[Math.floor((((character.userData.seed ?? 0) % 1) + 1) % 1 * 3) % 3];
    this._c.set(coat);
    meshes.torso.setColorAt(i, this._c);
    meshes.tail.setColorAt(i, this._c);
    meshes.accent.setColorAt(i, this._accent.copy(this._c).multiplyScalar(0.62));
    // tail: wag fast (dog) / sway slowly (cat), livelier when standing
    const t = ticker.time + character.animationOffset;
    const wag = kind === 'dog' ? Math.sin(t * (st.speed > 0.25 ? 10 : 16)) * 0.55 : Math.sin(t * 2.2) * 0.45;
    const sh = meshes.shape;
    this._m2.makeRotationAxis(UP, wag).setPosition(sh.tailAt);
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
      for (const m of [...pet.body, pet.tail]) m.count = n;
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
