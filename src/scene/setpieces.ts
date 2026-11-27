// Set pieces and easter eggs: ufo, alien, sign, cats, sloth, gossip,
// skinned animated characters and interactable secrets (the hidden
// easter-egg modal triggers).

import {
  AnimationMixer,
  BoxGeometry,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Raycaster,
  Vector3,
  type MeshStandardMaterial,
  type SkinnedMesh,
} from 'three';
import { loadGltf, matteMaterials, posedBox } from './models';
import { onTick } from '../core/ticker';
import { engine } from '../engine/globals';
import { events } from '../core/events';
import { radians } from '../core/math';
import { clock } from '../engine/clock';
import { geometryLoader } from '../engine/loaders/geometries';
import { phongMaterial } from './materials';
import { SceneModule } from './SceneModule';
import { getConfig, watchConfig } from '../config/store';
import type { SecretPiece, SecretPieceConfig } from '../config/schema';

/** Apply a configured transform to a static (matrixWorldAutoUpdate=false) mesh. */
function applyTransform(mesh: Object3D, cfg: SecretPieceConfig) {
  mesh.position.set(...cfg.position);
  mesh.rotation.set(radians(cfg.rotation[0]), radians(cfg.rotation[1]), radians(cfg.rotation[2]));
  mesh.scale.setScalar(cfg.scale);
  mesh.updateMatrixWorld(true);
}

/** An easter egg: when the player gets close enough, show its text modal. */
export class Secret {
  completed = false;
  /** Live-editable from the remote config. */
  distance: number;
  text: string;
  private _mesh: Object3D;
  private _player: Object3D;

  constructor(options: { mesh: Object3D; player: Object3D; distance: number; text: string }) {
    this._mesh = options.mesh;
    this._player = options.player;
    this.distance = options.distance;
    this.text = options.text;
    events.emit('webgl_increase_easer_count');
  }

  check() {
    if (this.completed) return;
    if (this._mesh.position.distanceTo(this._player.position) < this.distance) {
      this.completed = true;
      events.emit('webgl_show_modal', this.text);
    }
  }
}

/** Animated skinned set piece (alien / cats / sloth). */
abstract class AnimatedCharacter extends SceneModule {
  declare mesh: Mesh;
  private _secret: Secret | null = null;
  protected _animRange = 10;

  protected async initCharacter(
    meshFile: string,
    bonesFile: string,
    animFile: string,
    materialOptions: Parameters<typeof phongMaterial>[0],
    piece: SecretPiece,
  ) {
    const [skinned, clip] = await Promise.all([
      geometryLoader.skin(meshFile, bonesFile),
      geometryLoader.skinAnimation(animFile),
    ]);
    skinned.material = phongMaterial(materialOptions);
    this.mesh = skinned;
    this.mesh.name = meshFile.replace('.bin', '');
    this.mesh.matrixWorldAutoUpdate = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = true;
    this.scene.add(this.mesh);
    // Transform before the first skeleton pass, as in the original.
    watchPiece(piece, this.mesh, () => this._secret);

    const mixer = new AnimationMixer(this.mesh);
    const action = mixer.clipAction(clip);
    action.enabled = true;
    action.setEffectiveTimeScale(1);
    action.setEffectiveWeight(1);
    action.play();
    mixer.update(0.1);
    this.mesh.updateMatrixWorld();
    (this.mesh as any).skeleton.computeBoneTexture();

    this.mesh.onBeforeRender = () => {
      const player = this.scene.characters?.mesh?._localObject;
      if (!player) return;
      if (this.mesh.position.distanceTo(player.position) > this._animRange) return;
      mixer.update(clock.delta * 0.001);
      this.mesh.updateMatrixWorld();
      this._secret?.check();
    };

    this.scene.ready.then(() => {
      this._secret = createSecret(this.scene, this.mesh, piece);
    });
    this.ready.resolve();
  }
}

/** Keep a set piece's transform and secret in sync with the remote config. */
function watchPiece(piece: SecretPiece, mesh: Mesh, getSecret: () => Secret | null) {
  watchConfig((config) => {
    const cfg = config.secrets[piece];
    applyTransform(mesh, cfg);
    const secret = getSecret();
    if (secret) {
      secret.text = cfg.text;
      secret.distance = cfg.distance;
    }
  });
}

function createSecret(scene: SceneModule['scene'], mesh: Object3D, piece: SecretPiece): Secret {
  const cfg = getConfig().secrets[piece];
  return new Secret({
    mesh,
    player: scene.characters.mesh._localObject,
    distance: cfg.distance,
    text: cfg.text,
  });
}

// --- The puppy (replaces the UFO; config key and module name stay "ufo") ----
//
// Model: "Doggy Meme Dog PS1" by rukitu, https://sketchfab.com/3d-models/doggy-meme-dog-ps1-8f9361ab396e4c21a53bc50a57a740cd
// licensed CC-BY-4.0 (credited in the about panel, src/components/ui.ts, and README).
// Loaded as glTF with its own (unlit) material and morph animation, after the
// scene is up, so it never delays the start. It stands on the ground under its configured x/z
// (the old UFO hovered, so the configured y is ignored when there is ground).

export const PUPPY_URL = '/assets/models/dog/doggy_meme_dog_ps1.glb';
/** Height (m) at scale 1; the admin "Kích thước" multiplies it. Was 0.6: tripled to make it a landmark in the woods. */
export const PUPPY_HEIGHT = 1.8;
/** Its idle animation only runs while the player is this close (m). */
const PUPPY_ANIM_RANGE = 30;

/** Where the UFO was baked into the walk collider (collider.bin), and its half size. */
const OLD_UFO = { x: -56.9402, y: 2.6553, z: 22.7015, half: 4.2, below: 2.0, above: 1.5 };

/**
 * The walk collider without the old UFO hull: drops the triangles lying
 * entirely inside its box and above the ground (the ground under it stays).
 */
export function cutUfoCollider(source: BufferGeometry): BufferGeometry {
  const pos = source.attributes.position;
  const triCount = source.index ? source.index.count / 3 : pos.count / 3;
  const vertex = (t: number, k: number) => (source.index ? source.index.getX(t * 3 + k) : t * 3 + k);
  const ground = OLD_UFO.y - OLD_UFO.below + 0.1;
  const keep: number[] = [];
  let cut = 0;
  for (let t = 0; t < triCount; t++) {
    const ids = [vertex(t, 0), vertex(t, 1), vertex(t, 2)];
    const inside = ids.every((i) => {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      return Math.abs(x - OLD_UFO.x) < OLD_UFO.half && Math.abs(z - OLD_UFO.z) < OLD_UFO.half && y > ground && y < OLD_UFO.y + OLD_UFO.above;
    });
    if (inside) cut++;
    else keep.push(...ids);
  }
  if (!cut) {
    console.warn('puppy: old UFO hull not found in the collider');
    return source;
  }
  const out = new BufferGeometry();
  for (const name of Object.keys(source.attributes)) out.setAttribute(name, source.attributes[name]);
  out.setIndex(keep);
  return out;
}

/** Height of the walk collider's surface below (x, z), or null (no ground there). */
function groundBelow(source: BufferGeometry, x: number, z: number): number | null {
  const pos = source.attributes.position;
  const triCount = source.index ? source.index.count / 3 : pos.count / 3;
  const vertex = (t: number, k: number) => (source.index ? source.index.getX(t * 3 + k) : t * 3 + k);
  let best: number | null = null;
  for (let t = 0; t < triCount; t++) {
    const a = vertex(t, 0);
    const b = vertex(t, 1);
    const c = vertex(t, 2);
    const ax = pos.getX(a), az = pos.getZ(a), bx = pos.getX(b), bz = pos.getZ(b), cx = pos.getX(c), cz = pos.getZ(c);
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(d) < 1e-9) continue;
    const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
    const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
    const l3 = 1 - l1 - l2;
    if (l1 < 0 || l2 < 0 || l3 < 0) continue;
    const y = l1 * pos.getY(a) + l2 * pos.getY(b) + l3 * pos.getY(c);
    // The lowest surface: the ground, not a roof above it.
    if (best === null || y < best) best = y;
  }
  return best;
}

/** Solid box (world space) where the puppy stands, so players bump into it. */
export function puppyColliderBoxes(collider: BufferGeometry): BufferGeometry[] {
  const cfg = getConfig().secrets.ufo;
  if (getConfig().features.modules.ufo === false) return [];
  const h = PUPPY_HEIGHT * cfg.scale;
  const ground = groundBelow(collider, cfg.position[0], cfg.position[2]) ?? cfg.position[1];
  // Square footprint: the model's facing does not matter.
  const box = new BoxGeometry(h * 0.9, h, h * 0.9);
  box.translate(cfg.position[0], ground + h / 2, cfg.position[2]);
  return [box];
}

/** Height of the visible terrain below (x, z), or null. */
const groundRay = new Raycaster();
function terrainBelow(scene: SceneModule['scene'], x: number, z: number): number | null {
  const terrain = (scene as any).terrain?.mesh as Mesh | undefined;
  if (!terrain) return null;
  groundRay.set(new Vector3(x, 500, z), new Vector3(0, -1, 0));
  const hits = groundRay.intersectObject(terrain, false);
  return hits.length ? hits[hits.length - 1].point.y : null;
}

export class UFO extends SceneModule {
  /** Placed from the config (position on the ground, rotation, scale); the model sits inside. */
  declare mesh: Group;
  private _secret: Secret | null = null;

  protected async init() {
    this.mesh = new Group();
    this.mesh.name = 'puppy';
    this.scene.add(this.mesh);
    const place = () => {
      const cfg = getConfig().secrets.ufo;
      const ground = terrainBelow(this.scene, cfg.position[0], cfg.position[2]);
      this.mesh.position.set(cfg.position[0], ground ?? cfg.position[1], cfg.position[2]);
      this.mesh.rotation.set(radians(cfg.rotation[0]), radians(cfg.rotation[1]), radians(cfg.rotation[2]));
      this.mesh.scale.setScalar(cfg.scale);
      if (this._secret) {
        this._secret.text = cfg.text;
        this._secret.distance = cfg.distance;
      }
    };
    place();
    watchConfig(place);
    // Do not hold the scene for the model: load it once everything else is up.
    this.ready.resolve();
    await this.scene.ready;
    place(); // the terrain exists now
    this._secret = createSecret(this.scene, this.mesh, 'ufo');
    await engine.initialSceneLoaded;
    try {
      await this.loadModel();
    } catch (err) {
      console.warn('puppy: model could not be loaded', err);
    }
  }

  private async loadModel() {
    const gltf = await loadGltf(PUPPY_URL);
    const model = gltf.scene;
    const mixer = new AnimationMixer(model);
    if (gltf.animations[0]) mixer.clipAction(gltf.animations[0]).play();
    mixer.update(0);
    model.updateMatrixWorld(true);
    matteMaterials(model);
    model.traverse((o) => {
      const mesh = o as SkinnedMesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false; // skinned bounds would cull it wrongly
    });
    // Fit: PUPPY_HEIGHT tall, feet on y = 0, centred.
    const box = posedBox(model);
    const size = box.getSize(new Vector3());
    const centre = box.getCenter(new Vector3());
    const fit = new Group();
    const s = size.y > 0 ? PUPPY_HEIGHT / size.y : 1;
    fit.scale.setScalar(s);
    fit.position.set(-centre.x * s, -box.min.y * s, -centre.z * s);
    fit.add(model);
    this.mesh.add(fit);

    // Idle animation, once per frame, only when the player is near.
    onTick((_time, delta) => {
      const player = this.scene.characters?.mesh?._localObject;
      if (!player) return;
      const near = this.mesh.position.distanceTo(player.position) < PUPPY_ANIM_RANGE;
      if (near) mixer.update(Math.min(delta, 100) / 1000);
      this._secret?.check();
    });
  }
}

// --- The forest cat: a secret, like the puppy (config key "forestCat") ---
//
// Model: "Oiiaioooooiai Cat" by Zhuier, https://sketchfab.com/3d-models/oiiaioooooiai-cat-30d27bf7fb224849b76e208a6eccdb36
// licensed CC-BY-4.0 (credited in the about panel, src/components/ui.ts, and README).
// glTF loaded once the scene is up, standing on the terrain under its configured
// x/z. It stays still: the model's spinning animation is never played. Unlit, like
// the puppy: its texture is a dark tabby photo with the shading painted in, and
// lit PBR made it a black blob in this scene's light.

export const FOREST_CAT_URL = '/assets/models/cat/cat_uia.glb';
/** Height (m) at scale 1; the admin "Kích thước" multiplies it. */
export const FOREST_CAT_HEIGHT = 0.9;

/** Solid box where the cat sits, so players bump into it. */
export function catColliderBoxes(collider: BufferGeometry): BufferGeometry[] {
  if (getConfig().features.modules.forestCat === false) return [];
  const cfg = getConfig().secrets.forestCat;
  const h = FOREST_CAT_HEIGHT * cfg.scale;
  const ground = groundBelow(collider, cfg.position[0], cfg.position[2]) ?? cfg.position[1];
  const box = new BoxGeometry(h * 0.9, h, h * 0.9);
  box.translate(cfg.position[0], ground + h / 2, cfg.position[2]);
  return [box];
}

export class ForestCat extends SceneModule {
  /** Placed from the config (position on the ground, rotation, scale); the model sits inside. */
  declare mesh: Group;
  private _secret: Secret | null = null;

  protected async init() {
    this.mesh = new Group();
    this.mesh.name = 'forest cat';
    this.scene.add(this.mesh);
    const place = () => {
      const cfg = getConfig().secrets.forestCat;
      const ground = terrainBelow(this.scene, cfg.position[0], cfg.position[2]);
      this.mesh.position.set(cfg.position[0], ground ?? cfg.position[1], cfg.position[2]);
      this.mesh.rotation.set(radians(cfg.rotation[0]), radians(cfg.rotation[1]), radians(cfg.rotation[2]));
      this.mesh.scale.setScalar(cfg.scale);
      if (this._secret) {
        this._secret.text = cfg.text;
        this._secret.distance = cfg.distance;
      }
    };
    place();
    watchConfig(place);
    // Do not hold the scene for the model.
    this.ready.resolve();
    await this.scene.ready;
    place(); // the terrain exists now
    this._secret = createSecret(this.scene, this.mesh, 'forestCat');
    onTick(() => this._secret?.check());
    await engine.initialSceneLoaded;
    try {
      await this.loadModel();
    } catch (err) {
      console.warn('forest cat: model could not be loaded', err);
    }
  }

  private async loadModel() {
    const gltf = await loadGltf(FOREST_CAT_URL);
    const model = gltf.scene;
    model.updateMatrixWorld(true);
    model.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const source = mesh.material as MeshStandardMaterial;
      mesh.material = new MeshBasicMaterial({ map: source.map, side: DoubleSide });
      source.dispose();
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    });
    // Fit: FOREST_CAT_HEIGHT tall, feet on y = 0, centred.
    const box = posedBox(model);
    const size = box.getSize(new Vector3());
    const centre = box.getCenter(new Vector3());
    const fit = new Group();
    const s = size.y > 0 ? FOREST_CAT_HEIGHT / size.y : 1;
    fit.scale.setScalar(s);
    fit.position.set(-centre.x * s, -box.min.y * s, -centre.z * s);
    fit.add(model);
    this.mesh.add(fit);
  }
}

export class Alien extends AnimatedCharacter {
  protected _animRange = 30;
  protected init() {
    return super.initCharacter(
      'alien.bin',
      'alien-bones.bin',
      'alien-chill.bin',
      { isAlien: true },
      'alien',
    );
  }
}

export class Cats extends AnimatedCharacter {
  protected init() {
    return super.initCharacter(
      'cats.bin',
      'cats-bones.bin',
      'cats-anim.bin',
      { isCats: true },
      'cats',
    );
  }
}

export class Sloth extends AnimatedCharacter {
  protected init() {
    return super.initCharacter(
      'sloth.bin',
      'sloth-bones.bin',
      'sloth-anim.bin',
      { isSloth: true },
      'sloth',
    );
  }
}

export class Sign extends SceneModule {
  declare mesh: Mesh;
  protected async init() {
    const geometry = await geometryLoader.load('sign.bin');
    this.mesh = new Mesh(geometry, phongMaterial({ isSign: true }));
    this.mesh.name = 'sign';
    this.mesh.updateMatrixWorld(true);
    this.mesh.matrixWorldAutoUpdate = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = true;
    this.scene.add(this.mesh);
    this.ready.resolve();
  }
}

export class Gossip extends SceneModule {
  declare mesh: Mesh;
  private _secret: Secret | null = null;

  protected async init() {
    const geometry = await geometryLoader.load('gossip.bin');
    this.mesh = new Mesh(geometry, phongMaterial({ isGossip: true }));
    this.mesh.name = 'gossip';
    this.mesh.matrixWorldAutoUpdate = false;
    this.mesh.onBeforeRender = () => this._secret?.check();
    this.scene.add(this.mesh);
    watchPiece('gossip', this.mesh, () => this._secret);
    this.scene.ready.then(() => {
      this._secret = createSecret(this.scene, this.mesh, 'gossip');
    });
    this.ready.resolve();
  }
}
