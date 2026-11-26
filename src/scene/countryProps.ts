// Props of the countryside emotes (scene/emotes.ts states 19 … 27): bamboo
// flute, paper fan, watering can (+ water drops), picked flower, grain basket
// (+ thrown grains), broom, carrying pole with two buckets, open book. Same
// approach as props.ts: one InstancedMesh per piece (one instance per
// character, or a few), posed every frame from the character's baked bones
// and the emote clip's phase. Floating notes rise from flute players and
// whistlers.

import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
  type Bone,
} from 'three';
import { gsap } from 'gsap';
import { ticker } from '../core/ticker';
import type { CharacterLocal } from '../engine/characters';
import {
  BONE,
  CARRY_STATE,
  FAN_PERIOD,
  FAN_STATE,
  FEED_FLIGHT,
  FEED_PERIOD,
  FEED_RELEASE,
  FEED_STATE,
  FLUTE_STATE,
  HOLD_FLOWER_STATE,
  JUMPROPE_PERIOD,
  JUMPROPE_STATE,
  OFFER_FLOWER_STATE,
  PICK_PERIOD,
  PICK_STATE,
  READ_PERIOD,
  READ_STATE,
  SHUTTLE_KICK,
  SHUTTLE_PERIOD,
  SHUTTLE_STATE,
  SWEEP_STATE,
  WATER_STATE,
  WHISTLE_STATE,
  fanFlap,
  pickPhase,
  readTurn,
  ropeDir,
  shuttleHeight,
} from './emotes';

const MAX = 128;
const DROPS = 7;
const GRAINS = 9;
const ROPE_SEGMENTS = 14;
const HIDDEN = new Matrix4().makeScale(0, 0, 0);
const UP = new Vector3(0, 1, 0);
const WHITE = new Color('#ffffff');
/** Notes are only drawn for characters this close to the player. */
const NOTE_RANGE = 45;

function makeMesh(geometry: BufferGeometry, color: string, name: string, count = MAX, opts: { doubleSided?: boolean; tinted?: boolean; unlit?: boolean } = {}) {
  const params = opts.doubleSided ? { color, side: DoubleSide } : { color };
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

/** Unit cylinder along +y from 0 to 1 (scale y = length). */
function rod(radius: number, segments = 6) {
  const g = new CylinderGeometry(radius, radius, 1, segments);
  g.translate(0, 0.5, 0);
  return g;
}

const seedColor = (seed: number | undefined, s: number, l: number, out: Color, hueShift = 0) =>
  out.setHSL((((seed ?? 0) % 1) + hueShift + 2) % 1, s, l);
const fract = (x: number) => x - Math.floor(x);
const grow = (w: number) => Math.min(1, Math.max(0, (w - 0.35) / 0.4));
const clipPhase = (c: CharacterLocal, period: number) => (((ticker.time + c.animationOffset) % period) + period) % period / period;

function noteTexture(text: string, color: string): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.font = 'bold 96px serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(255, 250, 238, 0.95)';
  ctx.strokeText(text, 64, 68);
  ctx.fillStyle = color;
  ctx.fillText(text, 64, 68);
  return new CanvasTexture(canvas);
}

export class CountryProps {
  readonly group = new Group();
  // Flute
  private _flute = makeMesh(rod(0.012), '#c9a45c', 'flute');
  // Fan
  private _fan = makeMesh((() => { const g = new CircleGeometry(0.17, 12, 0, Math.PI); g.translate(0, 0.02, 0); return g; })(), '#ffffff', 'fan', MAX, { doubleSided: true, tinted: true });
  // Watering can
  private _can = makeMesh(new CylinderGeometry(0.07, 0.08, 0.15, 10), '#5f8f7a', 'watering can');
  private _spout = makeMesh(rod(0.012), '#4f7a67', 'spout');
  private _drops = makeMesh(new SphereGeometry(0.014, 6, 4), '#bfe3f5', 'water drops', MAX * DROPS, { unlit: true });
  // Flower
  private _stem = makeMesh(rod(0.004, 4), '#4f8a3c', 'flower stem');
  private _bloom = makeMesh(new SphereGeometry(0.03, 8, 6), '#ffffff', 'flower', MAX, { tinted: true });
  // Basket + grains
  private _basket = makeMesh(new CylinderGeometry(0.11, 0.08, 0.08, 10, 1, true), '#a0773f', 'basket', MAX, { doubleSided: true });
  private _grains = makeMesh(new SphereGeometry(0.012, 5, 3), '#e8c76a', 'grains', MAX * GRAINS, { unlit: true });
  // Broom
  private _handle = makeMesh(rod(0.014), '#8a5a33', 'broom handle');
  private _bristles = makeMesh((() => { const g = new ConeGeometry(0.11, 0.24, 8); g.translate(0, 0.12, 0); return g; })(), '#d8b56a', 'broom');
  // Carrying pole
  private _pole = makeMesh(rod(0.018), '#a27b45', 'carrying pole');
  private _ropes = makeMesh(rod(0.004, 3), '#d9cfb4', 'ropes', MAX * 2);
  private _buckets = makeMesh(new CylinderGeometry(0.12, 0.1, 0.2, 10), '#8a6a45', 'buckets', MAX * 2);
  private _water = makeMesh((() => { const g = new CircleGeometry(0.115, 10); g.rotateX(-Math.PI / 2); return g; })(), '#8fc9e0', 'bucket water', MAX * 2, { unlit: true });
  // Book
  private _covers = makeMesh(new BoxGeometry(0.155, 0.215, 0.012), '#ffffff', 'book covers', MAX * 2, { tinted: true });
  private _pages = makeMesh(new BoxGeometry(0.145, 0.2, 0.012), '#f6f0e1', 'book pages', MAX * 2, { unlit: true });
  // Jump rope + shuttlecock
  private _rope = makeMesh(rod(0.007, 3), '#c24d3a', 'jump rope', MAX * ROPE_SEGMENTS);
  private _cock = makeMesh(new SphereGeometry(0.02, 8, 6), '#c0392b', 'shuttle base');
  private _feathers = makeMesh((() => { const g = new ConeGeometry(0.04, 0.08, 8, 1, true); g.rotateX(Math.PI); g.translate(0, 0.05, 0); return g; })(), '#ffffff', 'shuttle feathers', MAX, { doubleSided: true, tinted: true });
  private _leaf = makeMesh((() => { const g = new PlaneGeometry(0.145, 0.2); g.translate(-0.0725, 0, 0); return g; })(), '#fffaf0', 'turning page', MAX, { doubleSided: true, unlit: true });

  private _all = [
    this._flute, this._fan, this._can, this._spout, this._drops, this._stem, this._bloom, this._basket, this._grains,
    this._handle, this._bristles, this._pole, this._ropes, this._buckets, this._water, this._covers, this._pages, this._leaf,
    this._rope, this._cock, this._feathers,
  ];
  private _per: Map<InstancedMesh, number> = new Map([
    [this._drops, DROPS], [this._grains, GRAINS], [this._ropes, 2], [this._buckets, 2], [this._water, 2], [this._covers, 2], [this._pages, 2], [this._rope, ROPE_SEGMENTS],
  ]);

  private _m = new Matrix4();
  private _q = new Quaternion();
  private _q2 = new Quaternion();
  private _s = new Vector3();
  private _c = new Color();
  private _rh = new Vector3();
  private _lh = new Vector3();
  private _p = new Vector3();
  private _a = new Vector3();
  private _b = new Vector3();
  private _d = new Vector3();
  private _fwd = new Vector3();
  private _right = new Vector3();
  private _x = new Vector3();
  private _y = new Vector3();
  private _z = new Vector3();

  // Floating notes
  private _noteTextures: CanvasTexture[] | null = null;
  private _nextNote = new WeakMap<object, number>();

  constructor(private _scene: Object3D, private _player: () => Vector3) {
    this.group.name = 'country props';
    this.group.add(...this._all);
    this._ropes.castShadow = false;
    this._drops.castShadow = false;
    this._grains.castShadow = false;
    this._water.castShadow = false;
  }

  /** Hide every piece of one character. */
  private _hide(i: number, meshes: InstancedMesh[]) {
    for (const mesh of meshes) {
      const n = this._per.get(mesh) ?? 1;
      for (let k = 0; k < n; k++) mesh.setMatrixAt(i * n + k, HIDDEN);
    }
  }

  /** Position + rotation + uniform scale. */
  private _put(mesh: InstancedMesh, index: number, at: Vector3, q: Quaternion, s: number, sy = s) {
    this._m.compose(at, q, this._s.set(s, sy, s));
    mesh.setMatrixAt(index, this._m);
  }

  /** A rod mesh from `a` to `b`. */
  private _rodBetween(mesh: InstancedMesh, index: number, a: Vector3, b: Vector3, s: number) {
    const dir = this._d.subVectors(b, a);
    const length = dir.length();
    if (length < 1e-5) return mesh.setMatrixAt(index, HIDDEN);
    this._q.setFromUnitVectors(UP, dir.multiplyScalar(1 / length));
    this._put(mesh, index, a, this._q, s, length);
  }

  /** Quaternion from three orthonormal axes. */
  private _basis(x: Vector3, y: Vector3, z: Vector3, out = this._q) {
    this._m.makeBasis(x, y, z);
    return out.setFromRotationMatrix(this._m);
  }

  /** Engine hook: called per character right after its pose is baked. */
  pose = (character: CharacterLocal, i: number, bones: Bone[], stateWeight: (state: number) => number) => {
    if (i >= MAX) return;
    const scale = character.scale.x;
    const w = {
      flute: grow(stateWeight(FLUTE_STATE)),
      fan: grow(stateWeight(FAN_STATE)),
      water: grow(stateWeight(WATER_STATE)),
      pick: grow(stateWeight(PICK_STATE)),
      feed: grow(stateWeight(FEED_STATE)),
      sweep: grow(stateWeight(SWEEP_STATE)),
      carry: grow(stateWeight(CARRY_STATE)),
      read: grow(stateWeight(READ_STATE)),
      rope: grow(stateWeight(JUMPROPE_STATE)),
      shuttle: grow(stateWeight(SHUTTLE_STATE)),
      flower: grow(stateWeight(OFFER_FLOWER_STATE) + stateWeight(HOLD_FLOWER_STATE)),
      whistle: stateWeight(WHISTLE_STATE),
    };
    const any = w.flute || w.fan || w.water || w.pick || w.feed || w.sweep || w.carry || w.read || w.rope || w.shuttle || w.flower;
    if (any) {
      this._rh.setFromMatrixPosition(bones[BONE.rightHand].matrixWorld).applyMatrix4(character.matrix);
      this._lh.setFromMatrixPosition(bones[BONE.leftHand].matrixWorld).applyMatrix4(character.matrix);
      this._fwd.set(0, 0, 1).applyQuaternion(character.quaternion);
      this._right.set(-1, 0, 0).applyQuaternion(character.quaternion);
    }

    if (w.flute) this._poseFlute(i, w.flute * scale);
    else this._hide(i, [this._flute]);
    if (w.fan) this._poseFan(character, i, w.fan * scale);
    else this._hide(i, [this._fan]);
    if (w.water) this._poseWater(character, i, w.water * scale);
    else this._hide(i, [this._can, this._spout, this._drops]);
    if (w.flower) this._poseFlower(character, i, w.flower * scale);
    else if (w.pick && pickPhase(clipPhase(character, PICK_PERIOD)).holding) this._poseFlower(character, i, w.pick * scale);
    else this._hide(i, [this._stem, this._bloom]);
    if (w.rope) this._poseRope(character, i, w.rope * scale);
    else this._hide(i, [this._rope]);
    if (w.shuttle) this._poseShuttle(character, i, w.shuttle * scale);
    else this._hide(i, [this._cock, this._feathers]);
    if (w.feed) this._poseFeed(character, i, w.feed * scale);
    else this._hide(i, [this._basket, this._grains]);
    if (w.sweep) this._poseBroom(character, i, w.sweep * scale);
    else this._hide(i, [this._handle, this._bristles]);
    if (w.carry) this._poseCarry(character, i, bones, w.carry * scale);
    else this._hide(i, [this._pole, this._ropes, this._buckets, this._water]);
    if (w.read) this._poseBook(character, i, w.read * scale);
    else this._hide(i, [this._covers, this._pages, this._leaf]);

    if (w.flute > 0.5 || w.whistle > 0.5) this._notes(character, bones, w.flute > 0.5);
  };

  private _poseFlute(i: number, s: number) {
    // From past the mouth (left of the left hand) to past the right hand.
    const dir = this._d.subVectors(this._rh, this._lh).normalize();
    this._a.copy(this._lh).addScaledVector(dir, -0.17 * s);
    this._b.copy(this._rh).addScaledVector(dir, 0.15 * s);
    this._rodBetween(this._flute, i, this._a, this._b, s);
  }

  private _poseFan(c: CharacterLocal, i: number, s: number) {
    // Facing the face, flapping about its normal.
    const flap = fanFlap(clipPhase(c, FAN_PERIOD));
    this._z.copy(this._fwd).negate();
    this._q2.setFromAxisAngle(this._z, flap);
    this._y.copy(UP).applyQuaternion(this._q2);
    this._x.crossVectors(this._y, this._z);
    this._basis(this._x, this._y, this._z);
    this._put(this._fan, i, this._rh, this._q, s);
    this._fan.setColorAt(i, seedColor(c.userData.seed, 0.55, 0.72, this._c, 0.5));
  }

  private _poseWater(c: CharacterLocal, i: number, s: number) {
    // Tilted forward to pour, the spout pointing forward and up.
    const tilt = 0.45;
    this._y.copy(UP).multiplyScalar(Math.cos(tilt)).addScaledVector(this._fwd, Math.sin(tilt)).normalize();
    this._z.copy(this._fwd).multiplyScalar(Math.cos(tilt)).addScaledVector(UP, -Math.sin(tilt)).normalize();
    this._x.crossVectors(this._y, this._z);
    this._basis(this._x, this._y, this._z);
    const body = this._p.copy(this._rh).addScaledVector(this._y, -0.1 * s);
    this._put(this._can, i, body, this._q, s);
    const base = this._a.copy(body).addScaledVector(this._z, 0.06 * s).addScaledVector(this._y, -0.03 * s);
    const spoutDir = this._d.copy(this._z).multiplyScalar(Math.cos(0.5)).addScaledVector(this._y, Math.sin(0.5)).normalize();
    const tip = this._b.copy(base).addScaledVector(spoutDir, 0.22 * s);
    this._rodBetween(this._spout, i, base, tip, s);
    // Drops falling from the tip to the ground in front.
    const ground = c.position.y;
    const fall = Math.max(0.1, tip.y - ground);
    this._q2.identity();
    for (let k = 0; k < DROPS; k++) {
      const p = fract(ticker.time * 1.4 + k / DROPS + c.animationOffset);
      this._p.copy(tip).addScaledVector(this._fwd, 0.22 * p * s);
      this._p.y = tip.y - fall * p * p;
      this._put(this._drops, i * DROPS + k, this._p, this._q2, s, s * 1.8);
    }
  }

  private _poseRope(c: CharacterLocal, i: number, s: number) {
    // A loop from hand to hand, turning around the hand axis; it sweeps the
    // ground under the feet at phase 0 (when the kid is in the air).
    const dir = ropeDir(clipPhase(c, JUMPROPE_PERIOD), this._d).applyQuaternion(c.quaternion);
    const mid = this._p.addVectors(this._rh, this._lh).multiplyScalar(0.5);
    const amplitude = Math.max(0.6 * s, mid.y - c.position.y - 0.01);
    const radial = this._z.copy(dir);
    for (let k = 0; k < ROPE_SEGMENTS; k++) {
      const s0 = k / ROPE_SEGMENTS;
      const s1 = (k + 1) / ROPE_SEGMENTS;
      this._a.lerpVectors(this._rh, this._lh, s0).addScaledVector(radial, amplitude * Math.sin(Math.PI * s0));
      this._b.lerpVectors(this._rh, this._lh, s1).addScaledVector(radial, amplitude * Math.sin(Math.PI * s1));
      this._rodBetween(this._rope, i * ROPE_SEGMENTS + k, this._a, this._b, s);
    }
  }

  private _poseShuttle(c: CharacterLocal, i: number, s: number) {
    // Up from the right foot and back down to it, base first, spinning.
    const phase = clipPhase(c, SHUTTLE_PERIOD);
    const at = this._p.set(SHUTTLE_KICK.x, shuttleHeight(phase), SHUTTLE_KICK.z).applyMatrix4(c.matrix);
    this._q.setFromAxisAngle(UP, (ticker.time + c.animationOffset) * 9);
    this._put(this._cock, i, at, this._q, s);
    this._put(this._feathers, i, at, this._q, s);
    this._feathers.setColorAt(i, seedColor(c.userData.seed, 0.6, 0.75, this._c, 0.25));
  }

  private _poseFlower(c: CharacterLocal, i: number, s: number) {
    // Upright in the hand, leaning a little forward.
    this._d.copy(UP).addScaledVector(this._fwd, 0.25).normalize();
    this._a.copy(this._rh).addScaledVector(this._d, -0.04 * s);
    this._b.copy(this._rh).addScaledVector(this._d, 0.13 * s);
    this._rodBetween(this._stem, i, this._a, this._b, s);
    this._q.identity();
    this._put(this._bloom, i, this._b, this._q, s);
    this._bloom.setColorAt(i, seedColor(c.userData.seed, 0.75, 0.68, this._c, 0.33));
  }

  private _poseFeed(c: CharacterLocal, i: number, s: number) {
    // Basket held in the left hand.
    this._q.copy(c.quaternion);
    this._put(this._basket, i, this._p.copy(this._lh).addScaledVector(UP, -0.03 * s), this._q, s);
    // Grains: thrown at FEED_RELEASE, flying in an arc, resting a moment.
    const phase = clipPhase(c, FEED_PERIOD);
    let t = (phase - FEED_RELEASE) / FEED_FLIGHT;
    if (t < 0) t += 1 / FEED_FLIGHT;
    if (t > 1.6) return this._hide(i, [this._grains]);
    const start = this._a.set(-0.32, 1.02, 0.42).applyMatrix4(c.matrix);
    const ground = c.position.y + 0.01;
    this._q2.identity();
    for (let k = 0; k < GRAINS; k++) {
      const spreadF = 0.75 + 0.45 * fract(k * 0.618);
      const spreadR = (k / (GRAINS - 1) - 0.5) * 0.9 + 0.2;
      const p = Math.min(1, t);
      this._b.copy(start).addScaledVector(this._fwd, spreadF * p * s).addScaledVector(this._right, spreadR * p * s);
      this._b.y = start.y + (ground - start.y) * p + 0.3 * s * 4 * p * (1 - p);
      this._put(this._grains, i * GRAINS + k, this._b, this._q2, s);
    }
  }

  private _poseBroom(c: CharacterLocal, i: number, s: number) {
    // The handle runs through both hands down to the ground.
    const dir = this._d.subVectors(this._lh, this._rh).normalize();
    if (dir.y > -0.2) dir.y = -0.2;
    dir.normalize();
    const ground = c.position.y + 0.04;
    const k = Math.max(0.3, (this._rh.y - ground) / -dir.y);
    const top = this._a.copy(this._rh).addScaledVector(dir, -0.16 * s);
    const bottom = this._b.copy(this._rh).addScaledVector(dir, k);
    this._rodBetween(this._handle, i, top, bottom, s);
    // Bristles: a flattened cone, wide side on the ground, tip up the handle.
    this._y.subVectors(top, bottom).normalize();
    this._x.copy(this._right).addScaledVector(this._y, -this._right.dot(this._y)).normalize();
    this._z.crossVectors(this._x, this._y);
    this._basis(this._x, this._y, this._z);
    this._m.compose(this._p.copy(bottom).addScaledVector(this._y, -0.03 * s), this._q, this._s.set(s, s, s * 0.35));
    this._bristles.setMatrixAt(i, this._m);
  }

  private _poseCarry(c: CharacterLocal, i: number, bones: Bone[], s: number) {
    // On the right shoulder, along the walking direction; buckets swing.
    const shoulder = this._p.setFromMatrixPosition(bones[BONE.chest].matrixWorld).applyMatrix4(c.matrix);
    shoulder.addScaledVector(this._right, 0.14 * s).addScaledVector(UP, 0.25 * s);
    const front = this._a.copy(shoulder).addScaledVector(this._fwd, 0.72 * s);
    const back = this._b.copy(shoulder).addScaledVector(this._fwd, -0.62 * s);
    this._rodBetween(this._pole, i, back, front, s);
    const t = ticker.time + c.animationOffset;
    for (let k = 0; k < 2; k++) {
      const end = k === 0 ? front : back;
      const swing = 0.09 * Math.sin(t * 3.2 + k * 1.3) + 0.04 * Math.min(1, c.velocityHorizontal * 40) * (k === 0 ? -1 : 1);
      this._q2.setFromAxisAngle(this._right, swing);
      const down = this._d.set(0, -1, 0).applyQuaternion(this._q2);
      const hook = this._x.copy(end).addScaledVector(down, 0.42 * s);
      this._rodBetween(this._ropes, i * 2 + k, end, hook, s);
      this._q.copy(this._q2).multiply(c.quaternion);
      const bucket = this._y.copy(hook).addScaledVector(down, 0.1 * s);
      this._put(this._buckets, i * 2 + k, bucket, this._q, s);
      this._put(this._water, i * 2 + k, this._z.copy(hook).addScaledVector(down, 0.015 * s), this._q, s);
    }
  }

  private _poseBook(c: CharacterLocal, i: number, s: number) {
    // Open book (model space: pages spread along x, facing the reader),
    // anchored on the left hand.
    // Right-handed basis: X toward the kid's right, H up the page, N toward the face.
    const X = this._x.set(-1, 0, 0);
    const N = this._z.set(0, 0.75, -0.66).normalize();
    const H = this._y.set(0, 0.66, 0.75).normalize();
    const center = this._p.set(-0.13, 0.015, 0.0).applyQuaternion(c.quaternion).multiplyScalar(s).add(this._lh);
    const book = this._basis(X, H, N, new Quaternion());
    const world = c.quaternion.clone().multiply(book);
    seedColor(c.userData.seed, 0.5, 0.42, this._c, 0.1);
    for (let k = 0; k < 2; k++) {
      const side = k === 0 ? 1 : -1; // right half, left half (book x points right)
      // each half's outer edge tilts toward the reader (a shallow V)
      const half = world.clone().multiply(this._q2.setFromAxisAngle(this._d.set(0, 1, 0), -side * 0.25));
      const offset = this._a.set(side * 0.077, 0, 0).applyQuaternion(half).multiplyScalar(s);
      this._put(this._covers, i * 2 + k, this._b.copy(center).add(offset), half, s);
      this._covers.setColorAt(i * 2 + k, this._c);
      const pagesAt = this._a.set(side * 0.077, 0, 0.012).applyQuaternion(half).multiplyScalar(s).add(center);
      this._put(this._pages, i * 2 + k, pagesAt, half, s);
    }
    // The page being turned: hinged at the spine, swinging right → left over the top.
    const turn = readTurn(clipPhase(c, READ_PERIOD));
    if (turn <= 0 || turn >= 1) return this._leaf.setMatrixAt(i, HIDDEN);
    // The leaf spans book -x at angle 0: start at π (right half), pass +z (toward the reader), end at 0.
    const angle = (1 - turn) * Math.PI;
    const leaf = world.clone().multiply(this._q2.setFromAxisAngle(this._d.set(0, 1, 0), angle));
    this._put(this._leaf, i, this._b.set(0, 0, 0.02).applyQuaternion(world).multiplyScalar(s).add(center), leaf, s);
  }

  /** Floating ♪ ♫ above flute players and whistlers. */
  private _notes(c: CharacterLocal, bones: Bone[], flute: boolean) {
    const now = ticker.time;
    if ((this._nextNote.get(c) ?? 0) > now) return;
    this._nextNote.set(c, now + (flute ? 0.55 : 0.7) + Math.random() * 0.4);
    if (c.position.distanceTo(this._player()) > NOTE_RANGE) return;
    this._noteTextures ??= [noteTexture('♪', '#5b4636'), noteTexture('♫', '#3f6b52'), noteTexture('♪', '#2f6f8f')];
    const texture = this._noteTextures[flute ? Math.floor(Math.random() * 2) : 2];
    const material = new SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
    const sprite = new Sprite(material);
    const head = this._p.setFromMatrixPosition(bones[BONE.head].matrixWorld).applyMatrix4(c.matrix);
    const drift = (Math.random() - 0.5) * 0.5;
    const side = this._a.set(flute ? -0.35 : 0.1, 0, 0).applyQuaternion(c.quaternion);
    sprite.position.copy(head).add(side).add(this._b.set(drift, 0.3, 0));
    sprite.renderOrder = 10;
    this._scene.add(sprite);
    gsap.fromTo(sprite.scale, { x: 0.01, y: 0.01 }, { x: 0.32, y: 0.32, duration: 0.3, ease: 'back.out(2)' });
    gsap.to(sprite.position, { y: sprite.position.y + 0.8, x: sprite.position.x + drift * 0.6, duration: 1.8, ease: 'sine.out' });
    gsap.to(material, {
      opacity: 0,
      delay: 1,
      duration: 0.8,
      onComplete: () => {
        this._scene.remove(sprite);
        material.dispose();
      },
    });
  }

  /** After all characters were posed this frame. */
  commit(count: number) {
    const n = Math.min(count, MAX);
    for (const mesh of this._all) {
      mesh.count = n * (this._per.get(mesh) ?? 1);
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }
}
