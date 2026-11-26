// Character state codec (26 bytes), mirrored in server/realm.mjs:
//   [0]      u8   version (1)
//   [1..13]  p    3 × f32 LE   position
//   [13..21] r    2 × f32 LE   spherical phi, theta
//   [21]     u8   bits 0-6 a   0 on ground (idle↔run by speed), 1 airborne,
//                               2 bored, 3 wave, 4 clap, 5 dance, 6 sit, 7 fishing,
//                               8 prone, 9 sunbathe, 10 guitar, 11 kite,
//                               12 ice cream, 13 high five, 14 dog, 15 cat,
//                               16 … 38 countryside emotes, stone benches, play together
//                               39 … 42 fishing mini-game stages, 43 butterfly net,
//                               44 … 64 holding up a caught fish (per species)
//                               (scene/emotes.ts MAX_NET_STATE; room up to 127)
//                 bit 7    sprinting
// Older clients only read bits 0-3: states 16+ show as another pose there.
// Outfits travel separately (OUTFIT messages, see socket.ts / realm.mjs).
//   [22..26] seed f32 LE       color seed

import type { P2PClientData, P2PData } from './types';

export const STATE_VERSION = 1;
export const STATE_BYTES = 26;
/** Animation state bits of byte 21 (bit 7 = sprinting). */
const STATE_MASK = 0x7f;

/** Write the state into `out` at `offset` (defaults to a fresh buffer). */
export function encodeState(data: P2PData, out = new Uint8Array(STATE_BYTES), offset = 0): Uint8Array {
  const view = new DataView(out.buffer, out.byteOffset + offset, STATE_BYTES);
  const p = (data.p as number[]) ?? [0, 0, 0];
  const r = (data.r as number[]) ?? [0, 0];
  view.setUint8(0, STATE_VERSION);
  for (let i = 0; i < 3; i++) view.setFloat32(1 + i * 4, p[i] ?? 0, true);
  for (let i = 0; i < 2; i++) view.setFloat32(13 + i * 4, r[i] ?? 0, true);
  view.setUint8(21, (((data.a as number) ?? 0) & STATE_MASK) | (data.sprint ? 0x80 : 0));
  view.setFloat32(22, (data.seed as number) ?? 0, true);
  return out;
}

/** Read a state from `view` at `offset`; throws on a bad version. */
export function decodeState(view: DataView, offset = 0): P2PClientData {
  if (view.byteLength - offset < STATE_BYTES || view.getUint8(offset) !== STATE_VERSION) {
    throw new Error(`bad state frame at ${offset}`);
  }
  return {
    p: [view.getFloat32(offset + 1, true), view.getFloat32(offset + 5, true), view.getFloat32(offset + 9, true)],
    r: [view.getFloat32(offset + 13, true), view.getFloat32(offset + 17, true)],
    a: view.getUint8(offset + 21) & STATE_MASK,
    sprint: (view.getUint8(offset + 21) & 0x80) !== 0,
    seed: view.getFloat32(offset + 22, true),
  };
}
