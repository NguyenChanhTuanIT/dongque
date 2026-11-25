// Character outfit system: equipment slots (hat, hair, top, bottom, shoes,
// glasses), each with a catalog of items. An item is a set of mesh *parts*;
// every vertex of the (extended) kid geometry carries a `partId`, and each
// character instance gets a visibility bitmask (`instanceParts`), so the
// shader shows exactly the parts of the items that player wears.
//
// The original kid mesh is split into parts by its colorInfo (hat, t-shirt,
// shorts, sandals); extra parts (skirt, hairstyles, sunglasses) are generated
// here in low poly, rigidly skinned to the head / hips bones, so every
// animation and emote keeps working.
//
// To add a shop item later: add a part (geometry from a model or code) with a
// new PART id, then an entry in SLOTS. Up to 24 parts (float bitmask).

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';

/** Mesh parts (bit index in the visibility mask). Part 0 = body, always on. */
export const PART = {
  body: 0,
  strawHat: 1,
  tshirt: 2,
  shorts: 3,
  skirt: 4,
  sandals: 5,
  pigtails: 6,
  ponytail: 7,
  bob: 8,
  sunglasses: 9,
  /** Hair over the scalp when no hat is worn (the original head is bald under the hat). */
  hairCap: 10,
  /** Skin-colored copy of the sandals (the original feet are part of the sandals). */
  bareFeet: 11,
} as const;

export interface Item {
  label: string;
  parts: number[];
}
export interface Slot {
  id: 'hat' | 'hair' | 'top' | 'bottom' | 'shoes' | 'glasses';
  label: string;
  items: Item[];
}

/** Slot order = wire order (one byte per slot: the item index). */
export const SLOTS: Slot[] = [
  { id: 'hat', label: 'Mũ', items: [{ label: 'Không', parts: [PART.hairCap] }, { label: 'Mũ rơm', parts: [PART.strawHat] }] },
  {
    id: 'hair',
    label: 'Kiểu tóc',
    items: [
      { label: 'Mặc định', parts: [] },
      { label: 'Hai bím', parts: [PART.pigtails] },
      { label: 'Đuôi ngựa', parts: [PART.ponytail] },
      { label: 'Ngang vai', parts: [PART.bob] },
    ],
  },
  { id: 'top', label: 'Áo', items: [{ label: 'Áo phông', parts: [PART.tshirt] }] },
  { id: 'bottom', label: 'Quần / váy', items: [{ label: 'Quần short', parts: [PART.shorts] }, { label: 'Váy xoè', parts: [PART.skirt] }] },
  { id: 'shoes', label: 'Dép', items: [{ label: 'Dép', parts: [PART.sandals] }, { label: 'Chân đất', parts: [PART.bareFeet] }] },
  { id: 'glasses', label: 'Kính', items: [{ label: 'Không', parts: [] }, { label: 'Kính râm', parts: [PART.sunglasses] }] },
];

/** Item index per slot, in SLOTS order. */
export type Outfit = number[];
export const DEFAULT_OUTFIT: Outfit = [1, 0, 0, 0, 0, 0];

export const slotIndex = (id: Slot['id']) => SLOTS.findIndex((s) => s.id === id);

/** Clamp anything (storage, network) to a valid outfit. */
export function sanitizeOutfit(input: unknown): Outfit {
  const src = Array.isArray(input) || ArrayBuffer.isView(input) ? Array.from(input as ArrayLike<number>) : [];
  return SLOTS.map((slot, i) => {
    const v = Number(src[i]);
    return Number.isInteger(v) && v >= 0 && v < slot.items.length ? v : DEFAULT_OUTFIT[i];
  });
}

export function withItem(outfit: Outfit, slot: Slot['id'], item: number): Outfit {
  const next = sanitizeOutfit(outfit);
  next[slotIndex(slot)] = item;
  return sanitizeOutfit(next);
}

/** Quick presets for the picker. */
export const PRESETS: Array<{ label: string; apply: (o: Outfit) => Outfit; is: (o: Outfit) => boolean }> = [
  { label: 'Nam', apply: (o) => withItem(withItem(o, 'bottom', 0), 'hair', 0), is: (o) => o[slotIndex('bottom')] === 0 },
  { label: 'Nữ', apply: (o) => withItem(withItem(o, 'bottom', 1), 'hair', o[slotIndex('hair')] || 1), is: (o) => o[slotIndex('bottom')] === 1 },
];

/** Visibility bitmask for the shader (body always visible). */
export function outfitMask(outfit: Outfit | undefined): number {
  const o = outfit ? sanitizeOutfit(outfit) : DEFAULT_OUTFIT;
  let mask = 1 << PART.body;
  SLOTS.forEach((slot, i) => {
    for (const p of slot.items[o[i]].parts) mask |= 1 << p;
  });
  return mask;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const HEAD_BONE = 14;
const HIPS_BONE = 4;
/** Upper leg bones (hip → knee), see the skeleton map in emotes.ts. */
const RIGHT_THIGH_BONE = 3;
const LEFT_THIGH_BONE = 6;
const ROW = { hat: 75, hair: 76, eyes: 77, tshirt: 74, sandals: 78 } as const;
const KIND_FIXED = 0;
const KIND_SKIN = 1;
const KIND_PLAYER = 2; // player color (the color button)

interface ExtraPart {
  geometry: BufferGeometry;
  bone: number;
  colorRow: number;
  colorKind: number;
  part: number;
  /** Per-vertex skinning copied from the kid (otherwise rigid to `bone`). */
  skin?: { index: number[]; weight: number[] };
}

/** Copy the kid triangles whose 3 vertices pass `test`, keeping their skinning. */
function copyTriangles(kid: BufferGeometry, test: (i: number) => boolean) {
  const idx = kid.index!.array as ArrayLike<number>;
  const pos = kid.attributes.position;
  const nor = kid.attributes.normal;
  const si = kid.attributes.skinIndex;
  const sw = kid.attributes.skinWeight;
  const positions: number[] = [];
  const normals: number[] = [];
  const skin = { index: [] as number[], weight: [] as number[] };
  for (let t = 0; t < idx.length; t += 3) {
    if (!test(idx[t]) || !test(idx[t + 1]) || !test(idx[t + 2])) continue;
    for (let k = 0; k < 3; k++) {
      const i = idx[t + k];
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      normals.push(nor.getX(i), nor.getY(i), nor.getZ(i));
      skin.index.push(si.getX(i), si.getY(i), si.getZ(i), si.getW(i));
      skin.weight.push(sw.getX(i), sw.getY(i), sw.getZ(i), sw.getW(i));
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  return { geometry, skin };
}

/** Which part an original kid vertex belongs to. */
function kidPart(row: number, kind: number, y: number): number {
  if (kind === KIND_PLAYER) return y < 1.0 ? PART.shorts : PART.strawHat; // shorts / hat band
  if (kind !== KIND_FIXED) return PART.body; // skin
  if (row === ROW.hat) return PART.strawHat;
  if (row === ROW.tshirt) return PART.tshirt;
  if (row === ROW.sandals) return PART.sandals;
  return PART.body; // eyes, hair under the hat
}

function boundsOf(geometry: BufferGeometry, test: (row: number, kind: number, y: number) => boolean) {
  const pos = geometry.attributes.position;
  const info = geometry.attributes.colorInfo;
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  const p = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    if (!test(Math.round(info.getX(i)), Math.round(info.getY(i)), pos.getY(i))) continue;
    p.fromBufferAttribute(pos, i);
    min.min(p);
    max.max(p);
  }
  return { min, max, center: min.clone().add(max).multiplyScalar(0.5), size: max.clone().sub(min) };
}

/** A tapered tube from `root` along `dir` with a rounded tip. */
function strand(root: Vector3, dir: Vector3, length: number, rTop: number, rBottom: number): BufferGeometry[] {
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, -1, 0), dir.clone().normalize());
  const tube = new CylinderGeometry(rTop, rBottom, length, 8, 1, true);
  tube.translate(0, -length / 2, 0);
  tube.applyQuaternion(q);
  tube.translate(root.x, root.y, root.z);
  const tip = new SphereGeometry(rBottom, 8, 6);
  const tipAt = root.clone().addScaledVector(dir.clone().normalize(), length);
  tip.translate(tipAt.x, tipAt.y, tipAt.z);
  return [tube, tip];
}

/** The back faces of a shell: shrunk toward `center`, winding and normals flipped. */
function insideOf(shell: BufferGeometry, center: Vector3, shrink: number): BufferGeometry {
  const inner = shell.clone();
  inner.translate(-center.x, -center.y, -center.z);
  inner.scale(shrink, shrink, shrink);
  inner.translate(center.x, center.y, center.z);
  const index = inner.index!.array as Uint16Array | Uint32Array;
  for (let t = 0; t < index.length; t += 3) [index[t + 1], index[t + 2]] = [index[t + 2], index[t + 1]];
  const normal = inner.attributes.normal;
  for (let i = 0; i < normal.count; i++) normal.setXYZ(i, -normal.getX(i), -normal.getY(i), -normal.getZ(i));
  return inner;
}

function sphereAt(at: Vector3, r: number): BufferGeometry {
  const s = new SphereGeometry(r, 8, 6);
  s.translate(at.x, at.y, at.z);
  return s;
}

function buildExtraParts(kid: BufferGeometry): ExtraPart[] {
  const hair = boundsOf(kid, (row, kind) => kind === KIND_FIXED && row === ROW.hair);
  const eyes = boundsOf(kid, (row, kind) => kind === KIND_FIXED && row === ROW.eyes);
  const shorts = boundsOf(kid, (_row, kind, y) => kind === KIND_PLAYER && y < 1.0);
  const head = boundsOf(kid, (_row, kind, y) => kind === KIND_SKIN && y > hair.min.y);
  const rHead = hair.size.x / 2;
  const c = hair.center;
  const parts: ExtraPart[] = [];
  const add = (geos: BufferGeometry[], bone: number, colorRow: number, colorKind: number, part: number) => {
    for (const geometry of geos) parts.push({ geometry, bone, colorRow, colorKind, part });
  };

  // Hair: pigtails, one on each side below the hat brim.
  for (const side of [-1, 1]) {
    const root = new Vector3(c.x + side * rHead * 0.92, hair.min.y + 0.07, c.z - rHead * 0.25);
    add(strand(root, new Vector3(side * 0.35, -1, -0.12), 0.22, 0.045, 0.028), HEAD_BONE, ROW.hair, KIND_FIXED, PART.pigtails);
    add([sphereAt(root, 0.034)], HEAD_BONE, 0, KIND_PLAYER, PART.pigtails); // hair tie
  }
  // Hair: ponytail from the back of the head.
  const tail = new Vector3(c.x, hair.min.y + 0.11, hair.min.z + 0.01);
  add(strand(tail, new Vector3(0, -1, -0.45), 0.27, 0.055, 0.03), HEAD_BONE, ROW.hair, KIND_FIXED, PART.ponytail);
  add([sphereAt(tail, 0.038)], HEAD_BONE, 0, KIND_PLAYER, PART.ponytail);
  // Hair: shoulder-length shell around the back and sides, open at the face.
  const bob = new SphereGeometry(rHead * 1.2, 18, 9, Math.PI * (135 / 180), Math.PI * (270 / 180), Math.PI * 0.28, Math.PI * 0.6);
  bob.scale(1.05, 1.5, 1);
  bob.translate(c.x, c.y, c.z);
  // Its inside too: from the front the hair beside the face is seen from within.
  add([bob, insideOf(bob, c, 0.97)], HEAD_BONE, ROW.hair, KIND_FIXED, PART.bob);

  // Hair cap (no hat): the scalp is bare under the hat, cover its top.
  const capR = new Vector3(head.size.x * 0.54, Math.max(hair.max.y - head.center.y, head.size.y * 0.5) * 1.06, head.size.z * 0.56);
  const capCenter = new Vector3(head.center.x, head.center.y, head.center.z - head.size.z * 0.02);
  const cap = new SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.42);
  cap.scale(capR.x, capR.y, capR.z);
  cap.translate(capCenter.x, capCenter.y, capCenter.z);
  // The cap ends above the eyes, but the original hair only starts lower at
  // the back: a shell over the back and sides (open at the face) closes the
  // bare band, reaching down into the original hair.
  const napeY = hair.min.y + hair.size.y * 0.35;
  const shellEnd = Math.acos(Math.min(1, Math.max(-1, (napeY - capCenter.y) / capR.y)));
  const shell = new SphereGeometry(1, 16, 6, Math.PI * 0.8, Math.PI * 1.4, Math.PI * 0.38, Math.max(0.1, shellEnd - Math.PI * 0.38));
  shell.scale(capR.x * 1.03, capR.y * 1.03, capR.z * 1.03);
  shell.translate(capCenter.x, capCenter.y, capCenter.z);
  add([cap, shell], HEAD_BONE, ROW.hair, KIND_FIXED, PART.hairCap);

  // Bare feet: the sandals mesh is the feet, so re-use it in the skin color.
  const info = kid.attributes.colorInfo;
  const feet = copyTriangles(kid, (i) => Math.round(info.getY(i)) === KIND_FIXED && Math.round(info.getX(i)) === ROW.sandals);
  parts.push({ geometry: feet.geometry, bone: 0, colorRow: 0, colorKind: KIND_SKIN, part: PART.bareFeet, skin: feet.skin });

  // Bottom: flared skirt in the player color.
  const waist = shorts.max.y + 0.02;
  const hem = shorts.min.y + 0.04;
  // The waistband hugs the body: an ellipse fitted to the top of the shorts
  // (the kid is wide but thin there); the hem flares out evenly all around.
  const band = boundsOf(kid, (_row, kind, y) => kind === KIND_PLAYER && y < 1.0 && y > shorts.max.y - 0.06);
  const topR = { x: band.size.x / 2 + 0.008, z: band.size.z / 2 + 0.008 };
  const flare = topR.x * 0.8;
  const hemR = { x: topR.x + flare, z: topR.z + flare };
  const skirt = new CylinderGeometry(1, 1, waist - hem, 20, 4, true);
  const sp = skirt.attributes.position;
  for (let i = 0; i < sp.count; i++) {
    const t = 0.5 - sp.getY(i) / (waist - hem); // 0 waist … 1 hem
    sp.setX(i, sp.getX(i) * (topR.x + (hemR.x - topR.x) * t));
    sp.setZ(i, sp.getZ(i) * (topR.z + (hemR.z - topR.z) * t));
  }
  skirt.translate(band.center.x, (waist + hem) / 2, band.center.z);
  skirt.computeVertexNormals();
  // The waistband follows the hips, the hem more and more the thigh on its
  // side, so the skirt drapes with the legs (sitting, lying, running) instead
  // of standing out as a rigid cone.
  const skirtSkin = { index: [] as number[], weight: [] as number[] };
  for (let i = 0; i < sp.count; i++) {
    const down = Math.min(1, Math.max(0, (waist - sp.getY(i)) / (waist - hem)));
    const leg = 0.85 * down;
    const across = (sp.getX(i) - band.center.x) / hemR.x; // -1 right … 1 left
    const right = 1 - Math.min(1, Math.max(0, (across + 0.4) / 0.8));
    skirtSkin.index.push(HIPS_BONE, RIGHT_THIGH_BONE, LEFT_THIGH_BONE, 0);
    skirtSkin.weight.push(1 - leg, leg * right, leg * (1 - right), 0);
  }
  parts.push({ geometry: skirt, bone: HIPS_BONE, colorRow: 0, colorKind: KIND_PLAYER, part: PART.skirt, skin: skirtSkin });

  // Glasses: round dark lenses over the eyes, a bridge and two temples.
  const eyeGap = Math.max(eyes.size.x / 2, 0.035);
  const lensR = Math.max(eyes.size.x * 0.45, 0.032);
  const front = eyes.max.z + 0.012;
  for (const side of [-1, 1]) {
    const lens = new CylinderGeometry(lensR, lensR, 0.008, 12);
    lens.rotateX(Math.PI / 2);
    lens.translate(eyes.center.x + side * eyeGap, eyes.center.y, front);
    const temple = new BoxGeometry(0.008, 0.008, rHead * 0.95);
    temple.translate(eyes.center.x + side * (eyeGap + lensR), eyes.center.y, front - rHead * 0.47);
    add([lens, temple], HEAD_BONE, ROW.eyes, KIND_FIXED, PART.sunglasses);
  }
  const bridge = new BoxGeometry(Math.max(eyeGap * 2 - lensR * 1.6, 0.01), 0.008, 0.008);
  bridge.translate(eyes.center.x, eyes.center.y + lensR * 0.3, front);
  add([bridge], HEAD_BONE, ROW.eyes, KIND_FIXED, PART.sunglasses);
  return parts;
}

/**
 * A copy of the kid geometry with the extra parts appended and a `partId`
 * attribute on every vertex (original vertices are split by colorInfo).
 */
export function withOutfitParts(kid: BufferGeometry): BufferGeometry {
  const parts = buildExtraParts(kid);
  const baseCount = kid.attributes.position.count;
  const total = baseCount + parts.reduce((n, p) => n + p.geometry.attributes.position.count, 0);
  const out = new BufferGeometry();

  for (const name of ['position', 'normal', 'colorInfo', 'skinIndex', 'skinWeight']) {
    const src = kid.attributes[name] as BufferAttribute;
    type Writable = { [i: number]: number; set(a: ArrayLike<number>, o?: number): void };
    const Typed = (src.array as any).constructor as new (n: number) => Writable;
    const array = new Typed(total * src.itemSize);
    array.set(src.array as ArrayLike<number>, 0);
    let at = baseCount;
    for (const part of parts) {
      const g = part.geometry;
      const n = g.attributes.position.count;
      for (let i = 0; i < n; i++) {
        const o = (at + i) * src.itemSize;
        if (name === 'position' || name === 'normal') {
          const a = g.attributes[name];
          array[o] = a.getX(i); array[o + 1] = a.getY(i); array[o + 2] = a.getZ(i);
        } else if (name === 'colorInfo') {
          array[o] = part.colorRow; array[o + 1] = part.colorKind;
        } else if (part.skin) {
          const from = name === 'skinIndex' ? part.skin.index : part.skin.weight;
          for (let c = 0; c < 4; c++) array[o + c] = from[i * 4 + c];
        } else if (name === 'skinIndex') {
          array[o] = part.bone; array[o + 1] = 0; array[o + 2] = 0; array[o + 3] = 0;
        } else {
          array[o] = 1; array[o + 1] = 0; array[o + 2] = 0; array[o + 3] = 0;
        }
      }
      at += n;
    }
    out.setAttribute(name, new BufferAttribute(array as any, src.itemSize, src.normalized));
  }

  const partId = new Float32Array(total);
  const info = kid.attributes.colorInfo;
  const pos = kid.attributes.position;
  for (let i = 0; i < baseCount; i++) partId[i] = kidPart(Math.round(info.getX(i)), Math.round(info.getY(i)), pos.getY(i));
  let at = baseCount;
  for (const part of parts) {
    const n = part.geometry.attributes.position.count;
    partId.fill(part.part, at, at + n);
    at += n;
  }
  out.setAttribute('partId', new BufferAttribute(partId, 1));

  const indices: number[] = Array.from(kid.index!.array as ArrayLike<number>);
  at = baseCount;
  for (const part of parts) {
    const g = part.geometry;
    if (g.index) for (const i of Array.from(g.index.array as ArrayLike<number>)) indices.push(i + at);
    else for (let i = 0; i < g.attributes.position.count; i++) indices.push(i + at);
    at += g.attributes.position.count;
  }
  out.setIndex(new BufferAttribute(new Uint32Array(indices), 1));
  out.userData = kid.userData;
  return out;
}
