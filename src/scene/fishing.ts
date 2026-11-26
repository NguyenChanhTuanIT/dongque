// Fishing props for the 'fish' emote: rod in the right hand, line, bobber and
// a fish that comes out of the water on the yank. One InstancedMesh per prop
// (one instance per character, like the kids themselves); posed every frame
// from the character's baked hand bone and the emote clip's phase.

import {
  Color,
  Float32BufferAttribute,
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
import { BONE, FISHING_STATES, FISH_PERIOD, HOLD_FISH_STATE, HOLD_ROD_DIR, fishPull, fishRodDir, isHoldFish } from './emotes';
import { pierWaterY } from './fishingPier';
import { fishingViews, heldFish, heldFishLook } from './fishingGame';

const DEFAULT_FISH = new Color('#e8913a');

const MAX_INSTANCES = 128;
const ROD_LENGTH = 2.1;
/** How far ahead the bobber floats (m): far enough to read it clearly. */
const CAST = 4.5;
/** Line radius: thin like real line, still a visible thread. */
const LINE_R = 0.0018;
/** The grip extends a little behind the hand. */
const ROD_BEHIND = 0.12;
const UP = new Vector3(0, 1, 0);
const HIDDEN = new Matrix4().makeScale(0, 0, 0);

/** The stiff butt (grip + reel) is one piece; the rest bends, in SEGMENTS pieces. */
const BUTT = 0.42;
const SEGMENTS = 6;
const SEG_LENGTH = (ROD_LENGTH - BUTT) / SEGMENTS;
/** Rod radius at the butt's end and at the tip. */
const R_BUTT = 0.013;
const R_TIP = 0.005;

function buttGeometry(): BufferGeometry {
  const rod = new CylinderGeometry(R_BUTT, 0.016, BUTT, 6);
  rod.translate(0, BUTT / 2 - ROD_BEHIND, 0);
  const reel = new CylinderGeometry(0.03, 0.03, 0.025, 10);
  reel.rotateZ(Math.PI / 2);
  reel.translate(0.025, 0.06, 0);
  return mergeBufferGeometries([rod.toNonIndexed(), reel.toNonIndexed()])!;
}

/** One bending piece: radius 1, length 1 along +y from the origin (scaled per piece). */
function segmentGeometry(): BufferGeometry {
  const g = new CylinderGeometry(0.8, 1, 1, 6);
  g.translate(0, 0.5, 0);
  return g;
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
  const line = new CylinderGeometry(LINE_R, LINE_R, 1, 3);
  line.translate(0, 0.5, 0); // base at origin, length 1 along +y
  return line;
}

/**
 * Bobber, bigger than before so it reads from afar: red top, white bottom
 * (the white half sits in the water), with a short red antenna on top.
 */
function bobberGeometry(): BufferGeometry {
  const ball = new SphereGeometry(0.06, 12, 10).toNonIndexed();
  const antenna = new CylinderGeometry(0.008, 0.008, 0.09, 5).toNonIndexed();
  antenna.translate(0, 0.095, 0);
  const g = mergeBufferGeometries([ball, antenna])!;
  const red = new Color('#d8432c');
  const white = new Color('#f4f1ea');
  const pos = g.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let k = 0; k < pos.count; k++) (pos.getY(k) > 0.004 ? red : white).toArray(colors, k * 3);
  g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  return g;
}

function makeMesh(geometry: BufferGeometry, color: string, castShadow: boolean, name: string, perCharacter = 1, vertexColors = false) {
  const mesh = new InstancedMesh(geometry, new MeshLambertMaterial({ color, vertexColors }), MAX_INSTANCES * perCharacter);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.castShadow = castShadow;
  mesh.count = 0;
  for (let i = 0; i < MAX_INSTANCES * perCharacter; i++) mesh.setMatrixAt(i, HIDDEN);
  return mesh;
}

export class FishingGear {
  readonly group = new Group();
  private _rod = makeMesh(buttGeometry(), '#6b4a2b', true, 'fishing rod');
  /** The bending part of the rod: SEGMENTS instances per character. */
  private _segments = makeMesh(segmentGeometry(), '#7a5532', true, 'fishing rod tip', SEGMENTS);
  private _pullDir = new Vector3();
  private _segDir = new Vector3();
  private _line = makeMesh(lineGeometry(), '#2f2f2f', false, 'fishing line');
  private _bobber = makeMesh(bobberGeometry(), '#ffffff', true, 'bobber', 1, true);
  /** White material: the color is per instance (the species of a catch, see fishingGame.ts). */
  private _fish = makeMesh(fishGeometry(), '#ffffff', true, 'fish');

  private _m = new Matrix4();
  private _q = new Quaternion();
  private _q2 = new Quaternion();
  private _hand = new Vector3();
  private _dir = new Vector3();
  private _tip = new Vector3();
  private _float = new Vector3();
  private _hang = new Vector3();
  private _scale = new Vector3();

  constructor() {
    this.group.name = 'fishing gear';
    this.group.add(this._rod, this._segments, this._line, this._bobber, this._fish);
    // Instance colors exist from the start (the shader is compiled with them).
    for (let i = 0; i < MAX_INSTANCES; i++) this._fish.setColorAt(i, DEFAULT_FISH);
  }

  private _hide(i: number) {
    this._rod.setMatrixAt(i, HIDDEN);
    for (let k = 0; k < SEGMENTS; k++) this._segments.setMatrixAt(i * SEGMENTS + k, HIDDEN);
    this._line.setMatrixAt(i, HIDDEN);
    this._bobber.setMatrixAt(i, HIDDEN);
    this._fish.setMatrixAt(i, HIDDEN);
  }

  /**
   * Showing off a catch: the rod in the right hand, upright over the shoulder
   * with the line and bobber dangling from the tip; the fish hanging by its
   * tail from the raised left hand, broad side to the front, swaying a little.
   * Our own catch has its exact size and color; others' show their species' look.
   */
  private _poseHeld(character: CharacterLocal, i: number, bones: Bone[], weight: number, a: number) {
    this._hide(i);
    if (weight < 0.35) return;
    const appear = Math.min(1, (weight - 0.35) / 0.4) * character.scale.x;

    // Rod: straight (no pull), from the right hand.
    this._hand.setFromMatrixPosition(bones[BONE.rightHand].matrixWorld).applyMatrix4(character.matrix);
    this._dir.copy(HOLD_ROD_DIR).applyQuaternion(character.quaternion);
    this._q.setFromUnitVectors(UP, this._dir);
    this._rod.setMatrixAt(i, this._m.compose(this._hand, this._q, this._scale.setScalar(appear)));
    const p = this._tip.copy(this._hand).addScaledVector(this._dir, (BUTT - ROD_BEHIND) * appear);
    for (let k = 0; k < SEGMENTS; k++) {
      const r = (R_BUTT + (R_TIP - R_BUTT) * (k / SEGMENTS)) * appear;
      this._segments.setMatrixAt(i * SEGMENTS + k, this._m.compose(p, this._q, this._scale.set(r, SEG_LENGTH * appear, r)));
      p.addScaledVector(this._dir, SEG_LENGTH * appear);
    }
    // Line + bobber dangling from the tip, swinging with the walk.
    const swing = 0.12 * Math.sin(ticker.time * 3.1 + i);
    const end = this._hang.copy(this._tip).add(this._scale.set(swing, -0.35 * appear, 0.05));
    this._bobber.setMatrixAt(i, this._m.compose(end, this._q2.identity(), this._scale.setScalar(appear * 0.8)));
    this._dir.subVectors(end, this._tip);
    const length = this._dir.length();
    this._q.setFromUnitVectors(UP, this._dir.normalize());
    this._line.setMatrixAt(i, this._m.compose(this._tip, this._q, this._scale.set(appear, length, appear)));

    // Fish: from the raised left hand.
    const look = heldFish.get(character) ?? heldFishLook(a - HOLD_FISH_STATE);
    this._hand.setFromMatrixPosition(bones[BONE.leftHand].matrixWorld).applyMatrix4(character.matrix);
    const sway = 0.18 * Math.sin(ticker.time * 2.2 + i) + (Math.sin(ticker.time * 7 + i) > 0.97 ? 0.4 : 0); // a flap now and then
    this._q.copy(character.quaternion).multiply(this._q2.setFromAxisAngle(UP, sway));
    this._m.compose(this._hand, this._q, this._scale.setScalar(appear * look.scale));
    this._fish.setMatrixAt(i, this._m);
    this._fish.setColorAt(i, look.color);
  }

  /** Engine hook: called per character right after its pose is baked. */
  pose = (character: CharacterLocal, i: number, bones: Bone[], stateWeight: (state: number) => number) => {
    if (i >= MAX_INSTANCES) return;
    const a = (character.userData as { a?: number }).a ?? 0;
    if (isHoldFish(a)) return this._poseHeld(character, i, bones, stateWeight(a), a);
    // The plain fishing state and the mini-game stages share the clip.
    let weight = 0;
    for (const state of FISHING_STATES) weight += stateWeight(state);
    if (weight < 0.35) {
      this._hide(i);
      return;
    }
    const phase = (((ticker.time + character.animationOffset) % FISH_PERIOD) + FISH_PERIOD) % FISH_PERIOD / FISH_PERIOD;
    const pull = fishPull(phase);
    const world = character.matrix;
    const appear = Math.min(1, (weight - 0.35) / 0.4);
    const s = appear * character.scale.x;

    // Anglers on the pier (fishingGame.ts): bites, fight, catch, snapped line.
    // All the cues are visual: the bobber goes under, the rod trembles, and it
    // bends toward the line as hard as the fish pulls.
    const view = fishingViews.get(character) ?? null;

    // Bobber: floating ahead while waiting, hanging under the tip when yanked.
    // (The local clip offset is steered by the mini-game: not a stable seed then.)
    const bob = 0.015 * Math.sin(ticker.time * 3 + (view ? 0 : character.animationOffset));
    const reach = CAST * (1 - 0.7 * (view?.near ?? 0));
    const out = this._float.set(0.25 + (view?.side ?? 0), 0.02 + bob, reach).applyMatrix4(world);
    // From the pier: on the sea surface below (pulled under on a bite).
    const water = pierWaterY(character.position);
    // (0.2 m: the bigger bobber and its antenna go fully under.)
    if (water !== null) out.y = water + bob - 0.2 * (view?.dip ?? 0);

    // Rod: from the right hand along the clip's rod direction, trembling on a bite.
    this._hand.setFromMatrixPosition(bones[BONE.rightHand].matrixWorld).applyMatrix4(world);
    this._dir.copy(fishRodDir(phase));
    const shake = view?.shake ?? 0;
    if (shake) {
      this._dir.x += 0.05 * shake * Math.sin(ticker.time * 37);
      this._dir.y += 0.07 * shake * Math.sin(ticker.time * 29 + 1.3);
    }
    this._dir.applyQuaternion(character.quaternion).normalize();
    this._q.setFromUnitVectors(UP, this._dir);
    this._m.compose(this._hand, this._q, this._scale.setScalar(s));
    this._rod.setMatrixAt(i, this._m);
    // The flexible part curves from the rod's direction toward the line, more
    // toward the tip and the harder the pull (bend 0 = straight).
    const p = this._tip.copy(this._hand).addScaledVector(this._dir, (BUTT - ROD_BEHIND) * s);
    const bend = Math.min(0.9, view?.bend ?? 0);
    this._pullDir.subVectors(out, p).normalize();
    for (let k = 0; k < SEGMENTS; k++) {
      const f = (k + 1) / SEGMENTS;
      this._segDir.copy(this._dir).lerp(this._pullDir, bend * f * f).normalize();
      const r = (R_BUTT + (R_TIP - R_BUTT) * (k / SEGMENTS)) * s;
      this._q.setFromUnitVectors(UP, this._segDir);
      // A broken rod: only the butt and a splintered stub are left.
      if (view?.broken && k >= 1) {
        this._segments.setMatrixAt(i * SEGMENTS + k, HIDDEN);
        continue;
      }
      this._m.compose(p, this._q, this._scale.set(r, SEG_LENGTH * s * (view?.broken ? 0.6 : 1), r));
      this._segments.setMatrixAt(i * SEGMENTS + k, this._m);
      p.addScaledVector(this._segDir, SEG_LENGTH * s);
    }
    // this._tip is now the bent tip.

    const hang = this._hang.copy(this._tip).add(this._scale.set(0, -0.42 * s, 0));
    const end = out.lerp(hang, pull);
    if (view?.lineHidden) {
      // Just snapped: no line, no bobber.
      this._bobber.setMatrixAt(i, HIDDEN);
      this._line.setMatrixAt(i, HIDDEN);
    } else {
      this._m.compose(end, this._q2.identity(), this._scale.setScalar(s * (1 - pull)));
      this._bobber.setMatrixAt(i, this._m);
      // Line: tip → end.
      this._dir.subVectors(end, this._tip);
      const length = this._dir.length();
      this._q.setFromUnitVectors(UP, this._dir.normalize());
      this._m.compose(this._tip, this._q, this._scale.set(s, length, s));
      this._line.setMatrixAt(i, this._m);
    }

    // Fish: out of the water on the yank, wiggling on the hook.
    if (pull > 0.25 && !view?.lineHidden) {
      const wiggle = 0.5 * Math.sin(ticker.time * 18);
      this._q.setFromAxisAngle(UP, wiggle).premultiply(this._q2.setFromAxisAngle(this._dir.set(0, 0, 1), 0.25 * wiggle));
      const size = s * Math.min(1, (pull - 0.25) / 0.3) * (view?.fishScale ?? 1);
      this._m.compose(end, this._q, this._scale.setScalar(size));
      this._fish.setMatrixAt(i, this._m);
      this._fish.setColorAt(i, view ? view.fishColor : DEFAULT_FISH);
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
    this._segments.count = Math.min(count, MAX_INSTANCES) * SEGMENTS;
    this._segments.instanceMatrix.needsUpdate = true;
    if (this._fish.instanceColor) this._fish.instanceColor.needsUpdate = true;
  }
}
