// Instanced skinned character system (port of `characterSkinnedMesh` +
// `characters$1`): up to 128 characters on one skinned mesh, per-instance
// bone matrices in a texture, blended clips, local player + networked remotes.

import {
  AnimationClip,
  AnimationMixer,
  type Bone,
  DataTexture,
  FloatType,
  Frustum,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  Object3D,
  Quaternion,
  RGBAFormat,
  Spherical,
  Vector3,
} from 'three';
import { events } from '../core/events';
import { deferred, type Deferred } from '../core/deferred';
import { ceilPowerOfTwo, clamp, fit, frictionFPS, HALF_PI, lerp, lerpCoefFPS, ratioFPS, TWO_PI } from '../core/math';
import { gsap } from 'gsap';
import { ticker } from '../core/ticker';
import { clock } from './clock';
import type { FollowCamera } from './camera';
import { Controls } from './controls';
import { CollisionPhysics } from './physics';
import { quaternionFromSpherical } from './quaternion';
import type { MultiplayerConnection, P2PClientData } from './multiplayer/types';
import type { Profile } from './multiplayer/socket';

const MAX_CHARS = 128;
/** Character ids of client-side NPCs (never collide with relay ids, which are numbers). */
const NPC_PREFIX = 'npc:';
const SECURE_EPS = 1e-4;

function secureLerp(v: number): number {
  return v > 0.9999 ? 1 : v < SECURE_EPS ? 0 : v;
}

/** Deep-clone an Object3D tree keeping skinned-mesh bone references intact. */
function cloneWithSkeleton(source: Object3D): Object3D {
  const sourceToClone = new Map<Object3D, Object3D>();
  const cloneToSource = new Map<Object3D, Object3D>();
  const result = source.clone();

  const parallelTraverse = (a: Object3D, b: Object3D, cb: (a: Object3D, b: Object3D) => void) => {
    cb(a, b);
    for (let i = 0; i < a.children.length; i++) {
      parallelTraverse(a.children[i], b.children[i], cb);
    }
  };
  parallelTraverse(source, result, (a, b) => {
    sourceToClone.set(b, a);
    cloneToSource.set(a, b);
  });

  result.traverse((obj) => {
    const skinned = obj as any;
    if (!skinned.isSkinnedMesh) return;
    const original = sourceToClone.get(obj) as any;
    skinned.skeleton = original.skeleton.clone();
    skinned.bindMatrix.copy(original.bindMatrix);
    skinned.skeleton.bones = original.skeleton.bones.map((bone: Object3D) => cloneToSource.get(bone));
    skinned.bind(skinned.skeleton, skinned.bindMatrix);
  });
  return result;
}

export interface CharacterLocal extends Object3D {
  instanceID: number;
  userData: Record<string, any>;
  acceleration: Vector3;
  velocity: Vector3;
  velocityHorizontal: number;
  spherical: Spherical;
  targetSpherical: Spherical;
  initialPosition: Vector3;
  isOnFloor: boolean;
  jumpRequested: boolean;
  animationOffset: number;
  animationWeights: number[];
  targetPosition?: Vector3;
  targetRotation?: Quaternion;
  mesh: Object3D;
}

export interface CharacterInstance {
  _localObject: CharacterLocal;
  _update(): void;
  _controls: Controls;
  _collisionPhysics: CollisionPhysics;
  _camera: { spherical: Spherical; isFollowCamera?: boolean; isPerspectiveCamera: boolean };
}

export interface CharacterOptions {
  animationsOptions?: Array<{ speed: number }>;
  colliderMesh: Mesh;
  radiusPercentage?: number;
  floorDetectInclination?: number;
  positionForce?: number;
  jumpForce?: number;
  damp?: number;
  /** Join the multiplayer room. Off = no network at all. */
  multiplayer?: boolean;
  /** WebSocket relay URL (server/realm.mjs); empty = same host, path /mp. */
  multiplayerUrl?: string;
  /** Emote slots (keys 1..n / menu): animation state `a` per slot (clip index - 1). */
  emoteSlots?: number[];
  /** Seconds before an emote state stops by itself (absent / 0 = until moving). */
  emoteDurations?: Record<number, number>;
  /** 'While walking' clips: emote state → clip index (upper body + run legs). */
  walkingEmoteClips?: Array<{ state: number; clip: number }>;
  /** Emote states that keep playing while the player moves. */
  mobileEmotes?: number[];
  /** Extra clips bound to a state (e.g. NPC-only poses). */
  extraClips?: Array<{ state: number; clip: number }>;
  /** Called for every character instance right after its pose is baked
   *  (bones hold that instance's pose in model space): attach props here. */
  onInstancePose?: (character: CharacterLocal, instance: number, bones: Bone[], stateWeight: (state: number) => number) => void;
  initialPosition?: number[];
  initialRadius?: number;
  camera: FollowCamera;
  relativeCameraPosition?: Vector3;
  lookatMeshOffset?: Vector3;
  skinShadows?: boolean;
  initialData?: Record<string, unknown>;
  positionCharLerp?: number;
  rotationCharLerp?: number;
  animationCharLerp?: number;
  remoteDamp?: number;
  positionDeltaLimitSnap?: number;
  inactiveTime?: number;
  customAttribUpdate?: (
    local: CharacterLocal,
    clientId: string,
    instanceId: number,
    visible: boolean,
    lerp: number,
  ) => void;
}

export class CharacterSkinnedMesh extends InstancedMesh {
  skeleton!: ReturnType<typeof cloneWithSkeleton> extends never ? never : any;
  actions: Array<{ setEffectiveWeight(w: number): void; setEffectiveTimeScale(s: number): void; enabled: boolean; play(): void }> = [];
  /** Run-cycle speed-up applied to sprinting characters (= sprint multiplier). */
  sprintAnimScale = 1.6;

  /** Blend weight of an animation state (its still + walking clips). */
  stateWeight(local: CharacterLocal, state: number): number {
    let w = 0;
    local.animationWeights.forEach((weight, i) => {
      if (i > 1 && (this.clipStates[i] ?? i - 1) === state) w += weight;
    });
    return w;
  }
  /** Animation state that activates clip i (default i - 1). */
  clipStates: number[] = [];
  /** Emote state → index of its 'while walking' clip. */
  walkingClips = new Map<number, number>();

  private _mixer: AnimationMixer;
  private _boneMatrix = new Matrix4();
  declare _localObject: CharacterLocal;

  constructor(
    skinnedMesh: import('three').SkinnedMesh,
    clips: AnimationClip[],
    options: { animationsOptions?: Array<{ speed: number }>; skinShadows?: boolean },
  ) {
    super(createInstancedGeometry(skinnedMesh.geometry), skinnedMesh.material, MAX_CHARS);
    (this as any).isSkinnedMesh = true;
    this.frustumCulled = false;
    this.matrixWorldAutoUpdate = false;
    (this as any).customDepthMaterial = (skinnedMesh as any).customDepthMaterial;
    (this as any).customDistanceMaterial = (skinnedMesh as any).customDistanceMaterial;
    this.receiveShadow = options.skinShadows !== false;
    this.castShadow = options.skinShadows !== false;

    const clone = cloneWithSkeleton(skinnedMesh) as import('three').SkinnedMesh;
    (this as any).bindMode = clone.bindMode;
    (this as any).bindMatrix = clone.bindMatrix;
    (this as any).bindMatrixInverse = clone.bindMatrixInverse;
    this.skeleton = clone.skeleton;
    clone.children.forEach((child) => this.add(child));

    this._mixer = new AnimationMixer(this);
    const animOptions = options.animationsOptions ?? [];
    this.actions = clips.map((clip, i) => {
      const action = this._mixer.clipAction(clip);
      action.setEffectiveTimeScale(animOptions[i]?.speed ?? 1);
      action.play();
      action.enabled = false;
      return action;
    });

    // Per-instance bone matrices as a texture (boneTextureSize x MAX_CHARS)
    const boneTextureSize = ceilPowerOfTwo(this.skeleton.bones.length * 4);
    const charSize = ceilPowerOfTwo(MAX_CHARS);
    const data = new Float32Array(boneTextureSize * charSize * 4);
    const boneTexture = new DataTexture(data, boneTextureSize, charSize, RGBAFormat, FloatType);
    boneTexture.needsUpdate = true;
    (this.skeleton as any).boneMatrices = data;
    (this.skeleton as any).boneTexture = boneTexture;
    (this.skeleton as any).boneTextureSize = boneTextureSize;
    (this.skeleton as any).computeBoneTexture = () => {};
    (this.skeleton as any).update = () => {};
  }

  /** Bake bone matrices for one instance. All instances are baked every frame:
   *  the mesh always renders, so skipping a remote leaves its pose frozen. */
  _updateAnimations(local: CharacterLocal, frameLerp: number) {
    const weights = local.animationWeights;
    const speedFactor = fit(local.velocityHorizontal, 0.001, 0.045, 1, 0);
    weights[0] = secureLerp(lerp(weights[0], speedFactor, frameLerp));
    weights[1] = 1 - weights[0];
    // Sprinting: play this instance's clips faster (by advancing its own
    // phase offset, so the shared mixer clock never jumps) so feet keep up.
    if (local.userData.sprint && this.sprintAnimScale > 1) {
      local.animationOffset += clock.delta * 0.001 * (this.sprintAnimScale - 1) * weights[1];
    }
    // Clip i plays for state clipStates[i] (default i - 1). Emotes with a
    // 'while walking' clip split their weight between the still clip and the
    // walking one by speed, like idle / run.
    const moving = 1 - speedFactor;
    for (let i = 2; i < weights.length; i++) {
      const state = this.clipStates[i] ?? i - 1;
      let target = 0;
      if (local.userData.a === state) {
        if (!this.walkingClips.has(state)) target = 1;
        else target = this.walkingClips.get(state) === i ? moving : 1 - moving;
      }
      weights[i] = secureLerp(lerp(weights[i], target, frameLerp));
    }

    this.actions.forEach((action, i) => {
      let otherWeight = 0;
      const state = this.clipStates[i] ?? i - 1;
      for (let w = weights.length - 1; w > Math.max(1, i); w--) {
        // the still / walking pair of one emote share the weight, not stack
        if (i > 1 && (this.clipStates[w] ?? w - 1) === state) continue;
        otherWeight += weights[w];
      }
      const base = 1 - clamp(otherWeight, 0, 1);
      const weight = weights[i] * base;
      action.enabled = weight > 0;
      action.setEffectiveWeight(weight);
    });
    this._mixer.setTime(ticker.time + local.animationOffset);
    this.children.forEach((child) => child.updateMatrixWorld());

    const offset = local.instanceID * this.skeleton.boneTextureSize * 4;
    for (let b = 0; b < this.skeleton.bones.length; b++) {
      this._boneMatrix.multiplyMatrices(this.skeleton.bones[b].matrixWorld, this.skeleton.boneInverses[b]);
      this._boneMatrix.toArray(this.skeleton.boneMatrices, offset + b * 16);
    }
  }

  override updateMatrixWorld(force?: boolean): void {
    super.updateMatrixWorld(force);
    const bindMode = (this as any).bindMode;
    if (bindMode === 'attached') {
      (this as any).bindMatrixInverse.copy(this.matrixWorld).invert();
    } else if (bindMode === 'detached') {
      (this as any).bindMatrixInverse.copy((this as any).bindMatrix).invert();
    }
  }
}

function createInstancedGeometry(geometry: import('three').BufferGeometry): InstancedBufferGeometry {
  const result = new InstancedBufferGeometry();
  const clone = geometry.clone();
  if (clone.index) result.setIndex(clone.index);
  for (const name of Object.keys(clone.attributes)) {
    result.setAttribute(name, clone.attributes[name]);
  }
  result.setAttribute(
    'instanceID',
    new InstancedBufferAttribute(new Int32Array(Array.from({ length: MAX_CHARS }, (_, i) => i)), 1),
  );
  return result;
}

/** The character system: local player + networked remotes, one instanced mesh. */
export class Characters extends CharacterSkinnedMesh {
  count = 1;
  connected: Deferred<void> = deferred();
  _controls!: Controls;
  _collisionPhysics!: CollisionPhysics;
  _camera!: FollowCamera;

  private _charactersObjects = new Map<string, CharacterLocal>();
  private _connection!: MultiplayerConnection;
  private _positionCharLerp: number;
  private _rotationCharLerp: number;
  private _animationCharLerp: number;
  private _remoteCharDamp: number;
  private _positionDeltaLimitSnap: number;
  private _customAttribUpdate: CharacterOptions['customAttribUpdate'];
  private _inactiveTime: number;
  private _inactiveMilliseconds = 0;
  private _emoteSlots: number[] = [2];
  private _emoteDurations: Record<number, number> = {};
  private _emoteUntil = 0;
  private _mobileEmotes = new Set<number>();
  private _onInstancePose: CharacterOptions['onInstancePose'];
  private _outfit = new Uint8Array(0);
  private _profile: Profile | null = null;
  private _dataUpdate = { p: [0, 0, 0], r: [0, 0], a: 0, sprint: false } as P2PClientData;

  private _v0 = new Vector3();
  private _v1 = new Vector3();
  private _v2 = new Vector3();
  private _q0 = new Quaternion();
  private _f0 = new Frustum();
  private _m0 = new Matrix4();

  constructor(
    skinnedMesh: import('three').SkinnedMesh,
    clips: AnimationClip[],
    options: CharacterOptions = {} as CharacterOptions,
  ) {
    super(skinnedMesh, clips, options);
    this.name = 'Characters';
    this._positionCharLerp = options.positionCharLerp ?? 0.4;
    this._rotationCharLerp = options.rotationCharLerp ?? 0.4;
    this._animationCharLerp = options.animationCharLerp ?? 0.1;
    this._remoteCharDamp = options.remoteDamp ?? 0.625;
    this._positionDeltaLimitSnap = options.positionDeltaLimitSnap ?? 10;
    this._customAttribUpdate = options.customAttribUpdate;
    this._inactiveTime = (options.inactiveTime ?? 60) * 1000;
    this._camera = options.camera;

    this._localObject = new Object3D() as CharacterLocal;
    this._localObject.instanceID = 0;
    this._localObject.userData = { a: 0, ...(options.initialData ?? {}) };
    this._localObject.acceleration = new Vector3();
    this._localObject.velocity = new Vector3();
    this._localObject.velocityHorizontal = 0;
    this._localObject.spherical = new Spherical(1, HALF_PI);
    this._localObject.targetSpherical = this._camera.spherical.clone();
    this._localObject.targetSpherical.phi = HALF_PI;
    this._localObject.initialPosition = new Vector3();
    this._localObject.isOnFloor = false;
    this._localObject.jumpRequested = false;
    this._localObject.animationOffset = Math.random() * 100;
    this._localObject.animationWeights = this.actions.map((_, i) => (i === 0 ? 1 : 0));
    (this._localObject as any).mesh = this;
    this._charactersObjects.set('local', this._localObject);

    this._controls = new Controls(this as unknown as CharacterInstance, {
      mouseToggleCb: (active) => events.emit('webgl_mouse_toggle', active),
    });
    this._emoteSlots = options.emoteSlots ?? [2];
    this._mobileEmotes = new Set(options.mobileEmotes ?? []);
    for (const { state, clip } of options.walkingEmoteClips ?? []) {
      this.walkingClips.set(state, clip);
      this.clipStates[clip] = state;
    }
    for (const { state, clip } of options.extraClips ?? []) this.clipStates[clip] = state;
    this._onInstancePose = options.onInstancePose;
    this._emoteDurations = options.emoteDurations ?? {};
    events.on('webgl_character_emote', this._toggleEmote);
    events.on('mp_send_chat', this._sendChat);
    events.on('mp_reward', this._sendReward);
    events.on('mp_profile', this._setProfile);
    this._collisionPhysics = new CollisionPhysics(this as unknown as CharacterInstance, {
      colliderMesh: options.colliderMesh,
      radiusPercentage: options.radiusPercentage,
      floorDetectInclination: options.floorDetectInclination,
      positionForce: options.positionForce,
      jumpForce: options.jumpForce,
      damp: options.damp,
      onCollisionsReady: () => {
        this._setInitialPosition(options.initialPosition ?? [0, 0, 0], options.initialRadius ?? 2);
        (this._camera as any).isFollowCamera && this._camera.follow({
          mesh: this as unknown as any,
          relativeCameraPosition: options.relativeCameraPosition,
          lookatMeshOffset: options.lookatMeshOffset,
        });
        // Join the multiplayer room on our WebSocket relay and mirror remote
        // characters. Loaded on demand so nothing is fetched when disabled.
        if (options.multiplayer === false) return;
        void import('./multiplayer/socket').then(({ SocketConnection, defaultMultiplayerUrl }) => {
          // Names/chat go out on the event bus with our own id mapped to 'local'
          // (the key of the local character), so the UI can match characters.
          const charId = (id: string) => (id === this._connection?.selfId ? 'local' : id);
          this._connection = new SocketConnection({
            url: options.multiplayerUrl || defaultMultiplayerUrl(),
            outfit: () => this._outfit,
            profile: () => this._profile,
            data: this._dataUpdate,
            onConnect: () => {
              this.connected.resolve();
              events.emit('mp_connected', this._connection.selfId);
            },
            onDisconnect: () => events.emit('mp_disconnected'),
            addClient: (id, data) => this._addCharacter(id, data),
            removeClient: (id) => this._removeCharacter(id),
            removeAllClients: () => this._removeAllCharacters(),
            onLeave: (id) => events.emit('mp_leave', id),
            onName: (id, name) => events.emit('mp_name', charId(id), name),
            onChat: (id, text) => events.emit('mp_chat', charId(id), text),
            onNotice: (code) => events.emit('mp_notice', code),
            onWallet: (wallet) => events.emit('mp_wallet', wallet),
            onKicked: (code) => events.emit('mp_kicked', code),
          });
        });
      },
    });
  }

  update() {
    if (!this._collisionPhysics.collider) return;
    const delta = clock.delta;
    const ratio = ratioFPS();
    const positionLerp = lerpCoefFPS(this._positionCharLerp);
    const rotationLerp = lerpCoefFPS(this._rotationCharLerp);
    const animLerp = lerpCoefFPS(this._animationCharLerp);
    const remoteDamp = frictionFPS(this._remoteCharDamp);

    const move = this._controls.update();
    this._collisionPhysics.update(move, rotationLerp);
    this._localObject.updateMatrixWorld();
    this._localObject.userData.sprint = this._controls.sprinting;

    if (this._localObject.velocity.manhattanLength() < 1e-5) {
      this._inactiveMilliseconds += delta;
      if (this._inactiveMilliseconds > this._inactiveTime && this._localObject.userData.a === 0) {
        this._localObject.userData.a = 2;
      }
    } else {
      this._inactiveMilliseconds = 0;
      // Movement input ends the bored pose / emote; the slide to a stop after
      // releasing the keys does not (jumping switches to airborne in physics).
      const a = this._localObject.userData.a;
      if (a >= 2 && this._collisionPhysics.isMoving && !this._mobileEmotes.has(a)) this._localObject.userData.a = 0;
    }
    // Timed emotes (wave, clap) end by themselves.
    if (this._emoteUntil && clock.time >= this._emoteUntil) {
      this._emoteUntil = 0;
      if (this._localObject.userData.a >= 2) this._localObject.userData.a = 0;
    }

    // publish local state to the realm
    this._dataUpdate.p = this._localObject.position.toArray().map((v) => +Number(v).toFixed(2));
    this._dataUpdate.r = [
      +Number(this._localObject.spherical.phi % TWO_PI).toFixed(2),
      +Number(this._localObject.spherical.theta % TWO_PI).toFixed(2),
    ];
    this._dataUpdate.a = this._localObject.userData.a;
    this._dataUpdate.seed = this._localObject.userData.seed;
    this._dataUpdate.sprint = Boolean(this._localObject.userData.sprint);
    if (this._connection) {
      (this._connection as any)._data = this._dataUpdate;
    }

    if (this._camera.isPerspectiveCamera) {
      // matrixWorld/matrixWorldInverse refresh after this callback; force them
      // current so the frustum matches this frame's camera, not last frame's.
      this._camera.updateMatrixWorld();
      this._m0.multiplyMatrices(this._camera.projectionMatrix, this._camera.matrixWorldInverse);
      this._f0.setFromProjectionMatrix(this._m0);
    }

    const snap = delta > 2000;
    const posLerp = snap ? 1 : positionLerp;
    const rotLerp = snap ? 1 : rotationLerp;
    const animFactor = snap ? 0 : 1;

    let instance = 0;
    this._charactersObjects.forEach((remote, id) => {
      if (instance > 0) {
        const clientData = this._connection?._clients.get(id);
        if (clientData) {
          for (const key of Object.keys(clientData)) {
            if (key === 'p') {
              const p = clientData.p as number[];
              if (p.length !== 3) continue;
              this._v1.copy(remote.position);
              this._v0.fromArray(p);
              const teleport = this._v0.distanceTo(this._v1) > this._positionDeltaLimitSnap;
              const lerpAmount = teleport ? 1 : posLerp;
              const dampFactor = teleport ? 0 : 1;
              (remote.targetPosition ??= new Vector3()).lerp(this._v0, lerpAmount);
              remote.position.lerp((remote as any).targetPosition, lerpAmount);
              remote.velocity.add(this._v2.subVectors(remote.position, this._v1).multiplyScalar(ratio));
              remote.velocity.multiplyScalar(remoteDamp * animFactor * dampFactor);
              remote.velocityHorizontal = this._v0.copy(remote.velocity).setY(0).length();
            } else if (key === 'r') {
              const r = clientData.r as number[];
              if (r.length !== 2) continue;
              remote.spherical.phi = r[0];
              remote.spherical.theta = r[1];
              quaternionFromSpherical(remote.spherical, this._q0);
              (remote.targetRotation ??= new Quaternion()).slerp(this._q0, rotLerp);
              remote.quaternion.slerp(remote.targetRotation as Quaternion, rotLerp);
            } else {
              remote.userData[key] = clientData[key];
            }
          }
        }
      }
      this._collisionPhysics.boundingSphere.center.add(remote.position);
      const visible = this._camera.isPerspectiveCamera
        ? this._f0.intersectsSphere(this._collisionPhysics.boundingSphere)
        : true;
      this._collisionPhysics.boundingSphere.center.copy(this._collisionPhysics.boundingSphereOriginalCenter);
      this._customAttribUpdate?.(remote, id, instance, visible, animLerp);
      remote.updateMatrix();
      this.setMatrixAt(instance++, remote.matrix);
      this._updateAnimations(remote, animLerp);
      this._onInstancePose?.(remote, instance - 1, this.skeleton.bones, (state) => this.stateWeight(remote, state));
    });
    this.instanceMatrix.needsUpdate = true;
    this.skeleton.boneTexture.needsUpdate = true;
  }

  /** Visit every player character: 'local' first, then remotes by relay id (NPCs excluded). */
  forEachCharacter(cb: (id: string, object: Object3D) => void) {
    this._charactersObjects.forEach((object, id) => {
      if (!id.startsWith(NPC_PREFIX)) cb(id, object);
    });
  }

  /**
   * Client-side NPC: drawn and animated like a player (outfit, emotes,
   * props), driven by the caller (position, quaternion, velocityHorizontal,
   * userData.a / seed / outfit), never sent over the network.
   */
  addNpc(id: string, data: P2PClientData): CharacterLocal {
    const key = NPC_PREFIX + id;
    if (!this._charactersObjects.has(key)) this._addCharacter(key, data);
    return this._charactersObjects.get(key)!;
  }

  removeNpc(id: string) {
    this._removeCharacter(NPC_PREFIX + id);
  }

  private _sendReward = (action: number, done?: (sent: boolean) => void) => {
    done?.(this._connection?.sendReward?.(action) ?? false);
  };

  private _sendChat = (text: string, done?: (sent: boolean) => void) => {
    done?.(this._connection?.sendChat?.(text) ?? false);
  };

  /** Account-verified display name, re-claimed on every reconnect; null = guest. */
  private _setProfile = (profile: Profile | null) => {
    this._profile = profile;
    void this._connection?._sendProfile?.(profile);
  };

  private _updateCharacterIDs() {
    let i = 0;
    this._charactersObjects.forEach((obj) => {
      obj.instanceID = i++;
    });
  }

  private _addCharacter(id: string, data: P2PClientData) {
    const remote = new Object3D() as CharacterLocal;
    remote.spherical = new Spherical(1, HALF_PI);
    remote.targetPosition = new Vector3();
    remote.targetRotation = new Quaternion();
    remote.velocity = new Vector3();
    remote.velocityHorizontal = 0;
    remote.userData = { a: 0 };
    remote.animationOffset = Math.random() * 100;
    remote.animationWeights = this.actions.map((_, i) => (i === 0 ? 1 : 0));
    for (const key of Object.keys(data)) {
      if (key === 'p') {
        const p = data.p as number[];
        if (p.length !== 3) continue;
        remote.position.fromArray(p);
        remote.targetPosition.copy(remote.position);
      } else if (key === 'r') {
        const r = data.r as number[];
        if (r.length !== 2) continue;
        remote.spherical.phi = r[0] || HALF_PI;
        remote.spherical.theta = r[1] || 0;
        quaternionFromSpherical(remote.spherical, remote.targetRotation);
        remote.quaternion.copy(remote.targetRotation);
      } else {
        remote.userData[key] = data[key];
      }
    }
    this._charactersObjects.set(id, remote);
    this._updateCharacterIDs();
    this.count++;
    gsap.fromTo(
      remote.scale,
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 1, z: 1, ease: 'power2.out', duration: 0.35 },
    );
  }

  private _removeCharacter(id: string) {
    const remote = this._charactersObjects.get(id);
    if (!remote) return;
    this._charactersObjects.delete(id);
    this._updateCharacterIDs();
    this.count = Math.max(1, this.count - 1);
  }

  /** Network reset (disconnect): drop the remote players, keep local + NPCs. */
  private _removeAllCharacters() {
    const npcs = [...this._charactersObjects].filter(([id]) => id.startsWith(NPC_PREFIX));
    this._charactersObjects.clear();
    this._charactersObjects.set('local', this._localObject);
    for (const [id, npc] of npcs) this._charactersObjects.set(id, npc);
    this._updateCharacterIDs();
    this.count = this._charactersObjects.size;
  }

  private _setInitialPosition(position: number[], radius: number) {
    if (!this._collisionPhysics.collider) return;
    this._v0.set(
      (Math.random() * 2 - 1) * radius,
      (Math.random() * 2 - 1) * radius,
      (Math.random() * 2 - 1) * radius,
    );
    this._v1.fromArray(position).add(this._v0);
    const closest = this._collisionPhysics.boundsTree.closestPointToPoint(this._v1);
    this._localObject.initialPosition.copy(closest.point);
    this.snap(this._localObject.initialPosition.toArray());
  }

  /** Keys 1..n / E / Y / emote menu: start the emote in `slot` (1-based), or
   *  stop it when it is already playing. Only while grounded. */
  private _toggleEmote = (slot = 1) => {
    const local = this._localObject;
    if (!this._collisionPhysics.collider) return;
    const state = this._emoteSlots[slot - 1];
    if (state === undefined) return;
    if (local.userData.a === state) {
      local.userData.a = 0;
      this._emoteUntil = 0;
      this._inactiveMilliseconds = 0;
    } else if (local.userData.a === 0 || local.userData.a >= 2) {
      // a === 0 means grounded (physics sets 1 while airborne).
      local.userData.a = state;
      const duration = this._emoteDurations[state] ?? 0;
      this._emoteUntil = duration > 0 ? clock.time + duration : 0;
    }
  };

  /** Turn the local character toward a world point (e.g. a high-five partner). */
  faceTowards(x: number, z: number) {
    const l = this._localObject;
    const fx = x - l.position.x;
    const fz = z - l.position.z;
    if (fx * fx + fz * fz < 1e-6) return;
    // The kid faces -(sin θ, cos θ) on the ground plane.
    l.spherical.theta = l.targetSpherical.theta = Math.atan2(-fx, -fz);
  }

  /** End the current emote after `seconds` (e.g. once a high five landed). */
  endEmoteIn(seconds: number) {
    this._emoteUntil = clock.time + seconds;
  }

  /** Local outfit (item index per slot): shown here and sent to others. */
  setOutfit(outfit: number[]) {
    this._outfit = Uint8Array.from(outfit);
    this._localObject.userData.outfit = [...outfit];
    this._connection?._sendOutfit?.(this._outfit);
  }

  /** Seconds standing still before the automatic bored pose (0 = never). */
  setInactiveTime(seconds: number) {
    this._inactiveTime = seconds > 0 ? seconds * 1000 : Number.POSITIVE_INFINITY;
  }

  /** Sprint speed multiplier: drives input force and the run-cycle speed. */
  setSprintMultiplier(multiplier: number) {
    this.sprintAnimScale = Math.max(1, multiplier);
    this._controls.setSprintMultiplier(multiplier);
  }

  snap(position: number[] = [0, 0, 0]) {
    this._localObject.position.fromArray(position);
    this._localObject.velocity.setScalar(0);
    this._localObject.velocityHorizontal = 0;
    this._localObject.acceleration.setScalar(0);
  }

  dispose() {
    (this.skeleton as any).dispose?.();
    events.off('webgl_character_emote', this._toggleEmote);
    this._controls.disable();
    this._connection?._dispose();
    this._collisionPhysics.geometry?.dispose();
  }
}
