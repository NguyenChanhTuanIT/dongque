// The players' body: the kid (`.bin` assets of the Relax Afternoon experiment).

import { type AnimationClip, type SkinnedMesh } from 'three';
import { geometryLoader } from '../engine/loaders/geometries';
import { withOutfitParts } from './appearance';

export interface CharacterBody {
  skinned: SkinnedMesh;
  /** idle, run, airborne, bored: animation states 0-2 (see engine/characters.ts). */
  clips: AnimationClip[];
  /** Per-vertex colors (`charColor`) instead of the kid's ramp rows. */
  vertexColors: boolean;
}

export async function loadCharacterBody(): Promise<CharacterBody> {
  const [skinned, clips] = await Promise.all([
    geometryLoader.skin('kid.bin', 'kid-bones.bin'),
    Promise.all(['kid-idle.bin', 'kid-run.bin', 'kid-air.bin', 'kid-bored.bin'].map((c) => geometryLoader.skinAnimation(c))),
  ]);
  // Outfits: every part (hat, hair styles, skirt, glasses…) is in the mesh;
  // the shader shows each player's parts from a per-instance bitmask.
  skinned.geometry = withOutfitParts(skinned.geometry);
  return { skinned, clips, vertexColors: false };
}
