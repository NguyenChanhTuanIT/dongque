// Fishing pier (cầu câu cá): a wooden pier from the east beach out to sea,
// with a T-shaped platform at the end. "Câu cá" (key 6) works anywhere on
// the part over the sea (past the hand rail) — see spots.ts. While someone
// fishes there, the bobber floats on
// the sea (fishing.ts asks pierWaterY).
//
// Placed by probing the walk collider: the beach at x ≈ 69, z = -18 is level
// with the deck; the sea floor drops below the water (y -0.815) from x ≈ 81.
// Between the sitting couple (z 0) and the kite flyers (z 22) of npcs.ts.

import { BoxGeometry, BufferGeometry, CylinderGeometry, Group, Mesh, MeshLambertMaterial, Vector3 } from 'three';
import { mergeBufferGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Characters } from '../engine/characters';
import { globalUniforms } from '../engine/globals';
import { paint } from './chickenCoops';
import { FISH_STATE, FISHING_STATES } from './emotes';
import { AreaActivity } from './spots';

/** Deck top (world y) and the pier's center line (world z). */
const DECK_Y = 0.05;
const PIER_Z = -18;
/** Walkway: x from START to PLATFORM, ±WALK_HALF across. */
const START = 69;
const PLATFORM = 83;
const WALK_HALF = 1.2;
/** Platform at the end: x from PLATFORM to END, ±PLAT_HALF across. */
const END = 87.5;
const PLAT_HALF = 3.2;
const DECK_T = 0.12;
/** Pilings go down into the sea floor. */
const BOTTOM = -2.6;
/** Hand rail along the beach part of the walkway (no fishing there). */
const RAIL_END = 80;
const RAIL_H = 0.85;
/** The map's invisible shore wall (collider) runs along x ≈ 77.7 in 2.5 m
 *  segments; the one at z -19.1 … -16.5 is cut for the walkway (z -19.2 … -16.8). */
const SHORE_X = 77.7;
const GAP_Z0 = -19.2;
const GAP_Z1 = -16.4;
/** Top of the invisible walls along the pier edges. */
const WALL_TOP = DECK_Y + 4;

/** Sea surface (sea.ts: plane at -0.815, two slow sine swells). */
const SEA_Y = -0.815;
export function seaLevel(): number {
  const t = globalUniforms.time.value;
  return SEA_Y + (Math.sin(t * 0.5 + 23.124) + Math.sin(t * 0.15 + 3213.32)) * 0.2;
}

/** Whether `p` stands on the part of the pier over the sea (past the hand rail): the fishing area. */
export function onFishingPier(p: Vector3): boolean {
  const half = (p.x < PLATFORM ? WALK_HALF : PLAT_HALF) + 0.3;
  return p.x > RAIL_END && p.x < END + 0.3 && Math.abs(p.z - PIER_Z) < half && Math.abs(p.y - DECK_Y) < 0.8;
}

/** Water height for a bobber cast from `p` if `p` is in the fishing area, else null. */
export function pierWaterY(p: Vector3): number | null {
  return onFishingPier(p) ? seaLevel() : null;
}

const PLANK_A = '#a8794c';
const PLANK_B = '#9b6e45';
const BEAM = '#6e4d30';
const PILE = '#5c4129';
const ROPE = '#d8c79a';

function box(w: number, h: number, d: number, x: number, y: number, z: number, color: string): BufferGeometry {
  const g = new BoxGeometry(w, h, d).toNonIndexed();
  g.translate(x, y, PIER_Z + z);
  return paint(g, color);
}

function pile(x: number, z: number, top: number, r = 0.11): BufferGeometry {
  const g = new CylinderGeometry(r, r, top - BOTTOM, 8).toNonIndexed();
  g.translate(x, (top + BOTTOM) / 2, PIER_Z + z);
  return paint(g, PILE);
}

/** The whole pier in world space (one mesh). */
function pierGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  // Dark under-deck (shows in the plank gaps) and the planks across.
  const under = DECK_Y - DECK_T / 2 - 0.02;
  parts.push(box(PLATFORM - START, DECK_T, 2 * WALK_HALF - 0.02, (START + PLATFORM) / 2, under, 0, BEAM));
  parts.push(box(END - PLATFORM, DECK_T, 2 * PLAT_HALF - 0.02, (PLATFORM + END) / 2, under, 0, BEAM));
  const planks = (x0: number, x1: number, half: number) => {
    const n = Math.round((x1 - x0) / 0.3);
    const w = (x1 - x0) / n;
    for (let k = 0; k < n; k++) {
      parts.push(box(w - 0.025, 0.05, 2 * half, x0 + w * (k + 0.5), DECK_Y - 0.025, 0, k % 3 === 1 ? PLANK_B : PLANK_A));
    }
  };
  planks(START, PLATFORM, WALK_HALF);
  planks(PLATFORM, END, PLAT_HALF);
  // Edge beams along the sides.
  for (const s of [-1, 1]) {
    parts.push(box(PLATFORM - START, 0.16, 0.1, (START + PLATFORM) / 2, DECK_Y - 0.13, s * (WALK_HALF + 0.03), BEAM));
    parts.push(box(END - PLATFORM, 0.16, 0.1, (PLATFORM + END) / 2, DECK_Y - 0.13, s * (PLAT_HALF + 0.03), BEAM));
  }
  parts.push(box(0.1, 0.16, 2 * PLAT_HALF + 0.16, END + 0.03, DECK_Y - 0.13, 0, BEAM));
  // Pilings: pairs along the walkway, a grid under the platform.
  for (let x = START + 2; x < PLATFORM; x += 2) for (const s of [-1, 1]) parts.push(pile(x, s * (WALK_HALF - 0.05), DECK_Y - 0.06));
  for (const x of [PLATFORM + 0.1, (PLATFORM + END) / 2, END - 0.1]) {
    for (const z of [-PLAT_HALF + 0.1, -1.1, 1.1, PLAT_HALF - 0.1]) parts.push(pile(x, z, DECK_Y - 0.06));
  }
  // Corner posts sticking up a little, with rope rings (boats tie up here).
  for (const x of [PLATFORM + 0.1, END - 0.1]) {
    for (const s of [-1, 1]) {
      const g = new CylinderGeometry(0.1, 0.1, 0.45, 8).toNonIndexed();
      g.translate(x, DECK_Y + 0.22, PIER_Z + s * (PLAT_HALF - 0.1));
      parts.push(paint(g, PILE));
      const ring = new CylinderGeometry(0.115, 0.115, 0.06, 8).toNonIndexed();
      ring.translate(x, DECK_Y + 0.3, PIER_Z + s * (PLAT_HALF - 0.1));
      parts.push(paint(ring, ROPE));
    }
  }
  // Hand rail on the beach part of the walkway.
  for (const s of [-1, 1]) {
    const z = s * (WALK_HALF - 0.05);
    for (let x = START + 0.3; x <= RAIL_END + 0.01; x += 1.8) parts.push(box(0.08, RAIL_H, 0.08, x, DECK_Y + RAIL_H / 2, z, BEAM));
    parts.push(box(RAIL_END - START - 0.3, 0.07, 0.09, (START + 0.3 + RAIL_END) / 2, DECK_Y + RAIL_H, z, PLANK_A));
    parts.push(box(RAIL_END - START - 0.3, 0.05, 0.05, (START + 0.3 + RAIL_END) / 2, DECK_Y + RAIL_H / 2, z, PLANK_B));
  }
  // A bait bucket and a crate on the platform.
  const bucket = new CylinderGeometry(0.15, 0.12, 0.26, 10).toNonIndexed();
  bucket.translate(PLATFORM + 0.5, DECK_Y + 0.13, PIER_Z + 1.4);
  parts.push(paint(bucket, '#5f87a8'));
  parts.push(box(0.5, 0.35, 0.4, PLATFORM + 0.45, DECK_Y + 0.175, -1.5, '#b58b57'));
  return mergeBufferGeometries(parts)!;
}

/** Solid boxes (world) for the walk collider: deck and rails. */
export function pierColliderBoxes(): BufferGeometry[] {
  const deck = (x0: number, x1: number, half: number) => {
    const g = new BoxGeometry(x1 - x0, DECK_Y - BOTTOM, 2 * half);
    g.translate((x0 + x1) / 2, (DECK_Y + BOTTOM) / 2, PIER_Z);
    return g;
  };
  const rail = (s: number) => {
    const g = new BoxGeometry(RAIL_END - START - 0.3, RAIL_H, 0.12);
    g.translate((START + 0.3 + RAIL_END) / 2, DECK_Y + RAIL_H / 2, PIER_Z + s * (WALK_HALF - 0.05));
    return g;
  };
  // Invisible walls (like the map's shore wall) along the pier edges past the
  // shore, so nobody steps or jumps off into the sea.
  const wall = (x0: number, x1: number, z0: number, z1: number) => {
    const g = new BoxGeometry(Math.max(0.1, x1 - x0), WALL_TOP - BOTTOM, Math.max(0.1, z1 - z0));
    g.translate((x0 + x1) / 2, (WALL_TOP + BOTTOM) / 2, PIER_Z + (z0 + z1) / 2);
    return g;
  };
  const e = 0.05;
  return [
    deck(START, PLATFORM + 0.01, WALK_HALF),
    deck(PLATFORM, END, PLAT_HALF),
    rail(-1),
    rail(1),
    // Close the shore wall on both sides of the gap cut for the walkway.
    wall(SHORE_X - 0.2, SHORE_X + 0.2, GAP_Z0 - PIER_Z - 0.2, -WALK_HALF + 0.1),
    wall(SHORE_X - 0.2, SHORE_X + 0.2, WALK_HALF - 0.1, GAP_Z1 - PIER_Z + 0.2),
    // Walkway sides, platform shoulders, platform sides, far end.
    wall(SHORE_X, PLATFORM, -WALK_HALF - e, -WALK_HALF - e),
    wall(SHORE_X, PLATFORM, WALK_HALF + e, WALK_HALF + e),
    wall(PLATFORM - e, PLATFORM - e, -PLAT_HALF, -WALK_HALF),
    wall(PLATFORM - e, PLATFORM - e, WALK_HALF, PLAT_HALF),
    wall(PLATFORM, END, -PLAT_HALF - e, -PLAT_HALF - e),
    wall(PLATFORM, END, PLAT_HALF + e, PLAT_HALF + e),
    wall(END + e, END + e, -PLAT_HALF, PLAT_HALF),
  ];
}

/**
 * The walk collider without the piece of the map's invisible shore wall
 * (x ≈ 77.7, 11 m tall) where the pier crosses it, so players can walk out.
 */
export function cutShoreWall(source: BufferGeometry): BufferGeometry {
  const pos = source.attributes.position;
  const triCount = source.index ? source.index.count / 3 : pos.count / 3;
  const vertex = (t: number, k: number) => (source.index ? source.index.getX(t * 3 + k) : t * 3 + k);
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const keep: number[] = [];
  let cut = 0;
  for (let t = 0; t < triCount; t++) {
    const i0 = vertex(t, 0);
    const i1 = vertex(t, 1);
    const i2 = vertex(t, 2);
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    const inGap = [a, b, c].every((v) => Math.abs(v.x - SHORE_X) < 0.4 && v.z > GAP_Z0 && v.z < GAP_Z1);
    if (inGap) {
      const n = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
      if (Math.abs(n.y) < 0.5) {
        cut++;
        continue; // a steep wall triangle in the gap
      }
    }
    keep.push(i0, i1, i2);
  }
  if (!cut) console.warn('fishing pier: shore wall gap not found in the collider');
  const out = new BufferGeometry();
  for (const name of Object.keys(source.attributes)) out.setAttribute(name, source.attributes[name]);
  out.setIndex(keep);
  return out;
}

/** The pier mesh and key 6 at its edges. */
export class FishingPier {
  readonly group = new Group();
  private _fishing: AreaActivity;

  constructor(characters: Characters) {
    this.group.name = 'fishing pier';
    const mesh = new Mesh(pierGeometry(), new MeshLambertMaterial({ vertexColors: true }));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this._fishing = new AreaActivity(characters, {
      state: FISH_STATE,
      inArea: onFishingPier,
      stages: FISHING_STATES,
      tipId: 'fishing',
      tip:
        '🎣 Cầu câu cá\n' +
        'Cầu câu ở bờ biển phía đông. Ra đoạn cầu ngoài biển rồi bấm 6 để thả câu (cần có Cần câu).\n' +
        'Phao chìm, cần rung là cá ăn: bấm Space để giật (điện thoại: nút 🎣). Bo cá: giữ để kéo; cần cong nhiều là cá kéo mạnh, thả ra kẻo đứt dây. Cá đuối sức mới kéo lên được.\n' +
        'Câu được cá thì cầm cá trên tay đi khoe với mọi người; bấm 6 trên cầu để câu tiếp.\n' +
        'Có thể vừa câu vừa đi lại trên cầu. Bấm 6 lần nữa hoặc rời khỏi cầu để thôi câu.',
    });
  }

  update() {
    this._fishing.update();
  }
}
