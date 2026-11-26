// Butterflies and the butterfly net (emote 'Bắt bướm', NET_STATE):
//
//   - the net: handle + hoop and a see-through bag, in the right hand, swept
//     with the arms (netDir, the same function the clip aims the arm with);
//   - a butterfly fluttering just ahead of everyone holding a net (players,
//     remote players, NPCs), always a little out of reach, so running with
//     the net means chasing it;
//   - a few butterflies drifting over two meadows (the butterfly meadow by
//     the beach, the coop meadow), on the shared clock so every client shows
//     them in the same places.
//
// Like fishing.ts: one InstancedMesh per piece, one instance per character
// (plus the free butterflies after them), posed right after each character's
// bones are baked.

import {
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PlaneGeometry,
  Quaternion,
  TorusGeometry,
  Vector3,
  type Bone,
} from 'three';
import { mergeBufferGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ticker } from '../core/ticker';
import type { CharacterLocal } from '../engine/characters';
import { BONE, NET_PERIOD, NET_STATE, NET_WALK_PERIOD, netDir } from './emotes';

const MAX = 128;
const HIDDEN = new Matrix4().makeScale(0, 0, 0);
const UP = new Vector3(0, 1, 0);
const Z = new Vector3(0, 0, 1);

/** Net sizes: handle from just behind the hand, hoop beyond its end. */
const HANDLE = 0.85;
const BEHIND = 0.1;
const HOOP_R = 0.17;

/** Meadows with free butterflies (world x, z, ground y, radius, count). */
export const MEADOWS = [
  // The butterfly meadow, by the beach between the spawn and the pier.
  { x: 62.5, z: -37.5, y: 0, r: 5, n: 7 },
  // The coop meadow, west of the first chicken coop.
  { x: -26, z: -10.5, y: 0.01, r: 4, n: 5 },
];
const FREE = MEADOWS.reduce((n, m) => n + m.n, 0);

const WING_COLORS = ['#f2c94c', '#fff6dc', '#f2994a', '#8fc7ea', '#f4a6c6', '#b9e07a'].map((c) => new Color(c));

function netGeometry(): BufferGeometry {
  const handle = new CylinderGeometry(0.011, 0.014, HANDLE, 6).toNonIndexed();
  handle.translate(0, HANDLE / 2 - BEHIND, 0);
  const hoop = new TorusGeometry(HOOP_R, 0.011, 6, 18).toNonIndexed();
  hoop.translate(0, HANDLE - BEHIND + HOOP_R, 0);
  [handle, hoop].forEach((g) => g.deleteAttribute('uv'));
  return mergeBufferGeometries([handle, hoop])!;
}

/** The bag hangs behind the hoop (along the hoop's normal, local -z). */
function bagGeometry(): BufferGeometry {
  const bag = new ConeGeometry(HOOP_R * 0.96, 0.3, 12, 1, true);
  bag.rotateX(-Math.PI / 2); // apex toward -z
  bag.translate(0, HANDLE - BEHIND + HOOP_R, -0.15);
  return bag;
}

/** One wing: hinge on the body axis (z), spreading toward +x. */
function wingGeometry(side: 1 | -1): BufferGeometry {
  const g = new PlaneGeometry(0.085, 0.07);
  g.rotateX(-Math.PI / 2); // flat, facing up
  g.translate((side * 0.085) / 2, 0, 0.005);
  return g;
}

function makeMesh(geometry: BufferGeometry, material: MeshBasicMaterial | MeshLambertMaterial, count: number, name: string, shadow = false) {
  const mesh = new InstancedMesh(geometry, material, count);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.castShadow = shadow;
  for (let i = 0; i < count; i++) mesh.setMatrixAt(i, HIDDEN);
  return mesh;
}

const hash = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

export class Butterflies {
  readonly group = new Group();
  private _net = makeMesh(netGeometry(), new MeshLambertMaterial({ color: '#8a6a45' }), MAX, 'butterfly net', true);
  private _bag = makeMesh(
    bagGeometry(),
    new MeshBasicMaterial({ color: '#f7f3ea', transparent: true, opacity: 0.45, side: DoubleSide, depthWrite: false }),
    MAX,
    'butterfly net bag',
  );
  // Wings: unlit (bright like paper), both faces, color per butterfly.
  private _wingMaterial = new MeshBasicMaterial({ color: '#ffffff', side: DoubleSide });
  private _wingR = makeMesh(wingGeometry(1), this._wingMaterial, MAX + FREE, 'butterfly wing R');
  private _wingL = makeMesh(wingGeometry(-1), this._wingMaterial, MAX + FREE, 'butterfly wing L');

  private _m = new Matrix4();
  private _q = new Quaternion();
  private _q2 = new Quaternion();
  private _p = new Vector3();
  private _d = new Vector3();
  private _f = new Vector3();
  private _r = new Vector3();
  private _s = new Vector3(1, 1, 1);

  constructor(private _sharedTime: () => number) {
    this.group.name = 'butterflies';
    this.group.add(this._net, this._bag, this._wingR, this._wingL);
    // Instance colors from the start (the shader is compiled with them).
    for (let i = 0; i < MAX + FREE; i++) {
      const c = WING_COLORS[Math.floor(hash(i + 3) * WING_COLORS.length)];
      this._wingR.setColorAt(i, c);
      this._wingL.setColorAt(i, c);
    }
  }

  /** One butterfly: body at `pos`, heading `yaw`, wings flapping. */
  private _butterfly(i: number, pos: Vector3, yaw: number, t: number, scale: number) {
    const flap = 0.15 + 1.05 * Math.abs(Math.sin(t * 17 + i * 1.7));
    this._q.setFromAxisAngle(UP, yaw);
    this._s.setScalar(scale);
    this._q2.setFromAxisAngle(Z, flap);
    this._wingR.setMatrixAt(i, this._m.compose(pos, this._q2.premultiply(this._q), this._s));
    this._q2.setFromAxisAngle(Z, -flap);
    this._wingL.setMatrixAt(i, this._m.compose(pos, this._q2.premultiply(this._q), this._s));
  }

  private _hide(i: number) {
    this._net.setMatrixAt(i, HIDDEN);
    this._bag.setMatrixAt(i, HIDDEN);
    this._wingR.setMatrixAt(i, HIDDEN);
    this._wingL.setMatrixAt(i, HIDDEN);
  }

  /** Engine hook: per character, right after its pose is baked. */
  pose = (character: CharacterLocal, i: number, bones: Bone[], stateWeight: (state: number) => number) => {
    if (i >= MAX) return;
    const weight = stateWeight(NET_STATE);
    if (weight < 0.35) return this._hide(i);
    const s = Math.min(1, (weight - 0.35) / 0.4) * character.scale.x;
    // Clip phase: the standing sweep, or the running one (its own loop length).
    const time = ticker.time + character.animationOffset;
    const running = character.velocityHorizontal > 0.004 && NET_WALK_PERIOD > 0;
    const loop = running ? ((time % NET_WALK_PERIOD) + NET_WALK_PERIOD) % NET_WALK_PERIOD : ((time % NET_PERIOD) + NET_PERIOD) % NET_PERIOD;
    const phase = (loop / NET_PERIOD) % 1;

    // The net in the right hand.
    this._p.setFromMatrixPosition(bones[BONE.rightHand].matrixWorld).applyMatrix4(character.matrix);
    this._d.copy(netDir(phase)).applyQuaternion(character.quaternion).normalize();
    this._q.setFromUnitVectors(UP, this._d);
    this._m.compose(this._p, this._q, this._s.setScalar(s));
    this._net.setMatrixAt(i, this._m);
    this._bag.setMatrixAt(i, this._m);

    // Its butterfly: ahead of the kid, weaving left / right and up / down (shared
    // clock + the kid's color seed: the same flight on every client).
    const t = this._sharedTime();
    const seed = (character.userData as { seed?: number }).seed ?? i;
    this._f.set(0, 0, 1).applyQuaternion(character.quaternion);
    this._r.set(-1, 0, 0).applyQuaternion(character.quaternion);
    const ahead = 1.5 + 0.35 * Math.sin(t * 1.3 + seed) + (running ? 0.4 : 0);
    this._p
      .copy(character.position)
      .addScaledVector(this._f, ahead * s)
      .addScaledVector(this._r, 0.6 * Math.sin(t * 0.9 + seed * 2))
      .addScaledVector(UP, 1.05 + 0.3 * Math.sin(t * 1.7 + seed) + 0.04 * Math.sin(t * 9));
    const yaw = Math.atan2(this._f.x, this._f.z) + 0.7 * Math.sin(t * 1.1 + seed);
    this._butterfly(i, this._p, yaw, t + seed, s);
  };

  /** Per frame: the free butterflies over the meadows (shared clock). */
  update() {
    const t = this._sharedTime();
    let i = MAX;
    for (const m of MEADOWS) {
      for (let k = 0; k < m.n; k++, i++) {
        const h1 = hash(i * 3.1);
        const h2 = hash(i * 7.7);
        const a = 0.18 + 0.2 * h1;
        const b = 0.15 + 0.22 * h2;
        const x = m.x + m.r * Math.sin(t * a + h1 * 20);
        const z = m.z + m.r * 0.75 * Math.sin(t * b + h2 * 20);
        const y = m.y + 0.45 + 0.45 * (1 + Math.sin(t * 0.6 + h1 * 9)) / 2 + 0.05 * Math.sin(t * 7 + h2 * 5);
        // Heading along the path (its derivative).
        const vx = m.r * a * Math.cos(t * a + h1 * 20);
        const vz = m.r * 0.75 * b * Math.cos(t * b + h2 * 20);
        this._p.set(x, y, z);
        this._butterfly(i, this._p, Math.atan2(vx, vz), t, 1);
      }
    }
  }

  /** After all characters were posed this frame. */
  commit(count: number) {
    // Characters that left: their slots stay hidden.
    for (let i = Math.min(count, MAX); i < MAX; i++) this._hide(i);
    this._net.count = this._bag.count = Math.min(count, MAX);
    for (const mesh of [this._net, this._bag, this._wingR, this._wingL]) mesh.instanceMatrix.needsUpdate = true;
  }
}
