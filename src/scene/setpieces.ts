// Set pieces and easter eggs: ufo, alien, sign, cats, sloth, gossip,
// skinned animated characters and interactable secrets (the hidden
// easter-egg modal triggers).

import { AnimationMixer, Mesh, Object3D } from 'three';
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
  private _mesh: Mesh;
  private _player: Object3D;

  constructor(options: { mesh: Mesh; player: Object3D; distance: number; text: string }) {
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

function createSecret(scene: SceneModule['scene'], mesh: Mesh, piece: SecretPiece): Secret {
  const cfg = getConfig().secrets[piece];
  return new Secret({
    mesh,
    player: scene.characters.mesh._localObject,
    distance: cfg.distance,
    text: cfg.text,
  });
}

export class UFO extends SceneModule {
  declare mesh: Mesh;
  private _secret: Secret | null = null;

  protected async init() {
    const geometry = await geometryLoader.load('ufo.bin');
    this.mesh = new Mesh(geometry, phongMaterial({ isUFO: true }));
    this.mesh.name = 'ufo';
    this.mesh.matrixWorldAutoUpdate = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = true;
    this.mesh.onBeforeRender = () => this._secret?.check();
    this.scene.add(this.mesh);
    watchPiece('ufo', this.mesh, () => this._secret);
    this.scene.ready.then(() => {
      this._secret = createSecret(this.scene, this.mesh, 'ufo');
    });
    this.ready.resolve();
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
