// Stone benches (ghế đá) in the groves west of the spawn. Each bench seats
// two players side by side, or one lying on it. Every client works out who
// is on a bench from the characters it sees (position + animation state), so
// no server logic is needed, like the high five.
//
// Spots were found by probing the walk collider: flat ground reachable from
// the spawn, near trees, the trunk behind the bench (see BENCHES).
// The benches are solid: their boxes are merged into the walk collider
// (benchCollider), and the engine pauses physics while a player sits
// (Characters.seatAt).

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { events } from '../core/events';
import type { Characters } from '../engine/characters';
import { BENCH_LIE_STATE, BENCH_SIT_STATE, EMOTES } from './emotes';

export interface BenchSpot {
  x: number;
  /** Ground height under the bench. */
  y: number;
  z: number;
  /** Direction the sitters face: (sin yaw, cos yaw); the tree is behind. */
  yaw: number;
}

/** Bench spots (world space). */
export const BENCHES: BenchSpot[] = [
  // The grove nearest the spawn (~40 m west).
  { x: -30.15, y: -0.01, z: -58.55, yaw: -0.524 },
  { x: -24.59, y: 0, z: -64.86, yaw: 0 },
  // Deeper in the western woods.
  { x: -45.11, y: 0.78, z: -39.07, yaw: 2.094 },
  { x: -47.16, y: 2.67, z: -68.14, yaw: 1.571 },
  { x: -48.97, y: 1.42, z: -20.17, yaw: -2.618 },
  { x: -22.81, y: 0.06, z: 2.44, yaw: 2.618 },
  { x: -43.59, y: 1.88, z: 12.34, yaw: 1.047 },
];

// Bench shape (bench space: +x along the seat, +z forward, y up from the ground).
const LENGTH = 1.7;
const DEPTH = 0.44;
const SEAT_TOP = 0.3;
const SLAB = 0.08;
/** Legs reach below the ground so slopes never show a gap. */
const LEG_SINK = 0.2;
/** Seats along the bench (x in bench space). */
const SEAT_X = [-0.42, 0.42];
/** Lying: the character faces -x (head at +x), shifted a bit toward the feet. */
const LIE_SHIFT = 0.05;
/** Standing up: this far in front of the seat. */
const STAND_OUT = 0.68;
/** Press F / L within this distance of a bench center. */
const REACH = 2.3;
/** Someone this close to a bench center with a bench pose is on it. */
const ON_BENCH = 1.05;

const UP = new Vector3(0, 1, 0);

function benchFrame(b: BenchSpot) {
  const forward = new Vector3(Math.sin(b.yaw), 0, Math.cos(b.yaw));
  const along = new Vector3(Math.cos(b.yaw), 0, -Math.sin(b.yaw));
  const center = new Vector3(b.x, b.y, b.z);
  return { forward, along, center };
}

/** Bench-space point → world. */
function toWorld(b: BenchSpot, x: number, y: number, z: number): Vector3 {
  const { forward, along, center } = benchFrame(b);
  return center.addScaledVector(along, x).addScaledVector(UP, y).addScaledVector(forward, z);
}

/**
 * The walk collider plus one solid box per bench (ground to seat top), so
 * players bump into benches and can hop on them. Same attributes as the
 * source (position, and normal when present), indexed.
 */
export function benchCollider(source: BufferGeometry, extraBoxes: BufferGeometry[] = []): BufferGeometry {
  const benchBoxes = BENCHES.map((b) => {
    const box = new BoxGeometry(LENGTH, SEAT_TOP + LEG_SINK, DEPTH);
    box.translate(0, (SEAT_TOP - LEG_SINK) / 2, 0);
    box.applyMatrix4(new Matrix4().compose(new Vector3(b.x, b.y, b.z), new Quaternion().setFromAxisAngle(UP, b.yaw), new Vector3(1, 1, 1)));
    return box;
  });
  // Other solid props (chicken coops) join the same collider.
  const boxes = [...benchBoxes, ...extraBoxes];
  const parts = [source, ...boxes];
  const names = ['position', ...(source.attributes.normal ? ['normal'] : [])];
  const vertexCount = parts.reduce((n, g) => n + g.attributes.position.count, 0);
  const merged = new BufferGeometry();
  for (const name of names) {
    const out = new Float32Array(vertexCount * 3);
    let at = 0;
    for (const g of parts) {
      const attr = g.attributes[name];
      for (let i = 0; i < attr.count; i++, at += 3) {
        out[at] = attr.getX(i);
        out[at + 1] = attr.getY(i);
        out[at + 2] = attr.getZ(i);
      }
    }
    merged.setAttribute(name, new BufferAttribute(out, 3));
  }
  const indexCount = parts.reduce((n, g) => n + (g.index ? g.index.count : g.attributes.position.count), 0);
  const index = new Uint32Array(indexCount);
  let at = 0;
  let base = 0;
  for (const g of parts) {
    const count = g.attributes.position.count;
    if (g.index) for (let i = 0; i < g.index.count; i++) index[at++] = g.index.getX(i) + base;
    else for (let i = 0; i < count; i++) index[at++] = i + base;
    base += count;
  }
  merged.setIndex(new BufferAttribute(index, 1));
  boxes.forEach((g) => g.dispose());
  return merged;
}

/** The stone bench meshes (slab + two legs), instanced. */
export function benchMeshes(): Group {
  const group = new Group();
  group.name = 'stone benches';
  const slab = new BoxGeometry(LENGTH, SLAB, DEPTH);
  slab.translate(0, SEAT_TOP - SLAB / 2, 0);
  const leg = new BoxGeometry(0.18, SEAT_TOP - SLAB + LEG_SINK, DEPTH - 0.08);
  leg.translate(0, (SEAT_TOP - SLAB - LEG_SINK) / 2, 0);
  const slabs = new InstancedMesh(slab, new MeshLambertMaterial({ color: '#b3aea4' }), BENCHES.length);
  const legs = new InstancedMesh(leg, new MeshLambertMaterial({ color: '#8f897f' }), BENCHES.length * 2);
  const m = new Matrix4();
  const q = new Quaternion();
  const one = new Vector3(1, 1, 1);
  BENCHES.forEach((b, i) => {
    q.setFromAxisAngle(UP, b.yaw);
    slabs.setMatrixAt(i, m.compose(new Vector3(b.x, b.y, b.z), q, one));
    SEAT_X.forEach((_, k) => legs.setMatrixAt(i * 2 + k, m.compose(toWorld(b, k ? 0.6 : -0.6, 0, 0), q, one)));
  });
  for (const mesh of [slabs, legs]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false; // instances span the map; only a few boxes
    group.add(mesh);
  }
  return group;
}

/**
 * F / L (or the emote menu): sit on a free seat of the nearest bench, or
 * lie on an empty one; again (or moving) stands up. Near a bench the chat
 * box shows the two actions (keys + tappable buttons, components/chat.ts).
 */
export class BenchSeating {
  private _promptText = '';
  private _sitSlot = EMOTES.findIndex((e) => e.state === BENCH_SIT_STATE) + 1;
  private _lieSlot = EMOTES.findIndex((e) => e.state === BENCH_LIE_STATE) + 1;

  constructor(private _characters: Characters) {
    this._characters.emoteInterceptors.push(this._onEmote);
  }

  /** Nearest bench within REACH of the local player. */
  private _nearestBench(): BenchSpot | null {
    const p = this._characters.local.position;
    let best: BenchSpot | null = null;
    let bestD = REACH;
    for (const b of BENCHES) {
      const d = Math.hypot(b.x - p.x, b.z - p.z);
      if (d < bestD && Math.abs(b.y - p.y) < 1.2) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  /** Who else is on bench `b`: taken seats, and whether someone lies on it. */
  private _occupancy(b: BenchSpot) {
    const { along, center } = benchFrame(b);
    const taken = new Set<number>();
    let lying = false;
    const offset = new Vector3();
    this._characters.forEachCharacter((id, obj) => {
      if (id === 'local') return;
      const a = (obj.userData as { a?: number }).a;
      if (a !== BENCH_SIT_STATE && a !== BENCH_LIE_STATE) return;
      offset.subVectors(obj.position, center);
      if (Math.abs(offset.y) > 1 || Math.hypot(offset.x, offset.z) > ON_BENCH) return;
      if (a === BENCH_LIE_STATE) lying = true;
      else {
        const x = offset.dot(along);
        taken.add(Math.abs(x - SEAT_X[0]) < Math.abs(x - SEAT_X[1]) ? 0 : 1);
      }
    });
    return { taken, lying };
  }

  private _onEmote = (state: number): boolean => {
    if (state !== BENCH_SIT_STATE && state !== BENCH_LIE_STATE) return false;
    const chars = this._characters;
    const local = chars.local;
    if (chars.seated && local.userData.a === state) {
      chars.leaveSeat(); // same key again: stand up
      return true;
    }
    if (local.userData.a === 1) return true; // airborne
    const bench = this._nearestBench();
    if (!bench) {
      events.emit('game_hint', 'Hãy lại gần một ghế đá (trong lùm cây phía tây) để ngồi hoặc nằm.');
      return true;
    }
    const { forward, along } = benchFrame(bench);
    const { taken, lying } = this._occupancy(bench);
    if (state === BENCH_SIT_STATE) {
      const free = [0, 1].filter((k) => !taken.has(k));
      if (lying || !free.length) {
        events.emit('game_hint', lying ? 'Có bạn đang nằm trên ghế này rồi.' : 'Ghế đá này đã đủ hai người ngồi.');
        return true;
      }
      // the free seat nearest to the player
      const p = local.position;
      const seat = free
        .map((k) => toWorld(bench, SEAT_X[k], 0, 0))
        .sort((a, b) => a.distanceToSquared(p) - b.distanceToSquared(p))[0];
      const stand = seat.clone().addScaledVector(forward, STAND_OUT).addScaledVector(UP, 0.05);
      chars.seatAt(seat, forward.x, forward.z, BENCH_SIT_STATE, stand);
    } else {
      if (lying || taken.size) {
        events.emit('game_hint', 'Ghế đang có người, chỉ nằm được khi ghế trống.');
        return true;
      }
      // head toward +x of the bench: the character faces -x
      const spot = toWorld(bench, -LIE_SHIFT, 0, 0);
      const stand = toWorld(bench, 0, 0.05, STAND_OUT);
      chars.seatAt(spot, -along.x, -along.z, BENCH_LIE_STATE, stand);
    }
    return true;
  };

  /** Per frame: the bench actions in the chat box (sent only when they change). */
  update() {
    const chars = this._characters;
    let text = '';
    const onBench = chars.local.userData.a === BENCH_SIT_STATE || chars.local.userData.a === BENCH_LIE_STATE;
    if (chars.seated && onBench) {
      text = `<span>🪑 Di chuyển để đứng dậy</span>`;
    } else if (chars.seated) {
      text = ''; // seated for something else (e.g. dancing together)
    } else if (this._nearestBench() && chars.local.userData.a !== 1) {
      const sit = EMOTES[this._sitSlot - 1];
      const lie = EMOTES[this._lieSlot - 1];
      text =
        `<span>🪑 Ghế đá</span>` +
        `<button type="button" data-slot="${this._sitSlot}" title="${sit.label}"><kbd>${sit.key}</kbd>Ngồi</button>` +
        `<button type="button" data-slot="${this._lieSlot}" title="${lie.label}"><kbd>${lie.key}</kbd>Nằm</button>`;
    }
    if (text === this._promptText) return;
    this._promptText = text;
    events.emit('chat_action', 'bench', text);
  }
}
