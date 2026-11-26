// The kid character: skinned mesh, four animation clips (idle/run/air/
// bored), local physics + controls, multiplayer connection, random colors.

import { Color, InstancedBufferAttribute, Mesh, Vector3 } from 'three';
import { events } from '../core/events';
import { geometryLoader } from '../engine/loaders/geometries';
import { Characters } from '../engine/characters';
import { depthCharsMaterial, phongMaterial } from './materials';
import { SceneModule } from './SceneModule';
import { EMOTES, MOBILE_EMOTE_STATES, createEmoteClips } from './emotes';
import { FishingGear } from './fishing';
import { GuitarProp } from './guitar';
import { HandProps } from './props';
import { Pets } from './pets';
import { HighFive } from './highfive';
import { NpcManager } from './npcs';
import { DEFAULT_OUTFIT, outfitMask, sanitizeOutfit, type Outfit } from './appearance';
import { loadCharacterBody } from './characterModel';
import { canUseEmote } from '../shop/inventory';

const OUTFIT_STORAGE_KEY = 'summertime.outfit';

function loadOutfit(): Outfit {
  try {
    const raw = localStorage.getItem(OUTFIT_STORAGE_KEY);
    return raw ? sanitizeOutfit(JSON.parse(raw)) : [...DEFAULT_OUTFIT];
  } catch {
    return [...DEFAULT_OUTFIT];
  }
}
import { getConfig, watchConfig } from '../config/store';

export class CharactersModule extends SceneModule {
  declare mesh: Characters;
  seed = 0;

  protected async init() {
    const [body, colliderGeometry] = await Promise.all([loadCharacterBody(), geometryLoader.load('collider.bin')]);
    const { skinned, clips } = body;

    // Procedural emotes go after idle/run/air/bored: clip i plays for state a = i - 1.
    const emotes = createEmoteClips(skinned, clips[0], clips[1]);
    const walkingStart = clips.length + emotes.clips.length;
    const npcStart = walkingStart + emotes.moving.length;
    clips.push(...emotes.clips, ...emotes.moving.map((m) => m.clip), ...emotes.npc.map((n) => n.clip));
    const fishingGear = new FishingGear();
    this.scene.add(fishingGear.group);
    const guitar = new GuitarProp();
    this.scene.add(guitar.group);
    const handProps = new HandProps();
    this.scene.add(handProps.group);
    const pets = new Pets();
    this.scene.add(pets.group);
    let highFive: HighFive | null = null;
    let npcs: NpcManager | null = null;

    // Chat bubbles sit just above the tallest part (hat included).
    skinned.geometry.computeBoundingBox();
    const top = skinned.geometry.boundingBox?.max.y ?? NaN;
    const headHeight = Number.isFinite(top) && top > 0.5 && top < 4 ? top + 0.05 : 1.6;
    skinned.geometry.setAttribute('instanceSeed', new InstancedBufferAttribute(new Float32Array(128), 1));
    skinned.geometry.setAttribute('instanceParts', new InstancedBufferAttribute(new Float32Array(128), 1));
    skinned.material = phongMaterial({ isCharacters: true, charVertexColors: body.vertexColors });
    skinned.customDepthMaterial = depthCharsMaterial();
    this.changeColor();
    events.on('webgl_character_randomize_color', this.changeColor);
    events.on('webgl_character_outfit', this.setOutfit);
    events.on('webgl_character_controls_enable', this.enableControls);

    const colliderMesh = new Mesh(colliderGeometry);
    const config = getConfig();

    this.mesh = new Characters(skinned, clips, {
      // walking variants run at the run clip's speed so the legs stay in step
      animationsOptions: [{ speed: 1 }, { speed: 1.1 }, { speed: 1 }, { speed: 1 }, ...emotes.clips.map(() => ({ speed: 1 })), ...emotes.moving.map(() => ({ speed: 1.1 }))],
      walkingEmoteClips: emotes.moving.map((m, k) => ({ state: m.state, clip: walkingStart + k })),
      mobileEmotes: MOBILE_EMOTE_STATES,
      extraClips: emotes.npc.map((n, k) => ({ state: n.state, clip: npcStart + k })),
      // Slot n (key n / menu item n) plays EMOTES[n - 1].
      emoteSlots: EMOTES.map((e) => e.state),
      emoteDurations: Object.fromEntries(EMOTES.map((e) => [e.state, e.duration])),
      onInstancePose: (character, instance, bones, stateWeight) => {
        fishingGear.pose(character, instance, bones, stateWeight);
        guitar.pose(character, instance, bones, stateWeight);
        handProps.pose(character, instance, bones, stateWeight);
        pets.pose(character, instance, bones, stateWeight);
      },
      colliderMesh,
      radiusPercentage: 0.2,
      floorDetectInclination: 0.8,
      positionForce: config.player.moveForce,
      jumpForce: config.player.jumpForce,
      damp: 0.92,
      multiplayer: config.features.multiplayer,
      multiplayerUrl: config.features.multiplayerUrl || import.meta.env.VITE_MULTIPLAYER_URL,
      initialPosition: config.player.spawn,
      initialRadius: config.player.spawnRadius,
      camera: this.scene.camera,
      relativeCameraPosition: new Vector3(0, 1, -5.75),
      lookatMeshOffset: new Vector3(0, 1.1, 0.5),
      initialData: { seed: this.seed },
      customAttribUpdate: (local, _clientId, instanceId) => {
        this.mesh.geometry.attributes.instanceSeed.setX(instanceId, local.userData.seed);
        this.mesh.geometry.attributes.instanceParts.setX(instanceId, outfitMask(local.userData.outfit));
      },
    });

    this.scene.beforeRenderCbs.push(() => {
      this.mesh.geometry.attributes.instanceSeed.needsUpdate = true;
      this.mesh.geometry.attributes.instanceParts.needsUpdate = true;
      this.mesh.update();
      events.emit('webgl_characters_updated', this.scene.camera, this.mesh, headHeight);
      fishingGear.commit(this.mesh.count);
      guitar.commit(this.mesh.count);
      handProps.commit(this.mesh.count);
      pets.commit(this.mesh.count);
      highFive?.update();
      npcs?.update();
      this.scene.audioController?.updatePlayerPosition(
        this.mesh._localObject.position.toArray(),
        this.mesh._localObject.velocityHorizontal,
        this.mesh._localObject.userData.a === 0,
      );
    });

    this.scene.add(this.mesh);
    highFive = new HighFive(this.scene, this.mesh);
    npcs = new NpcManager(this.scene, this.mesh, this.scene.audioController);
    watchConfig(({ features }) => npcs?.configure(features.npcs));
    this.scene.add(this.mesh._controls.circles);
    watchConfig(({ player }) => {
      this.mesh._collisionPhysics.setForces(player.moveForce, player.jumpForce);
      this.mesh.setSprintMultiplier(player.sprintMultiplier);
      this.mesh.setInactiveTime(player.idleEmoteSeconds);
    });
    this.mesh.setOutfit(this.outfit);
    events.emit('webgl_character_update_outfit', this.outfit);
    // Shop: picnic emotes need their item; the relay corrects / restores our
    // outfit (items not owned, the account's saved outfit).
    this.mesh.emoteAllowed = canUseEmote;
    events.on('inventory_changed', () => {
      const local = this.mesh._localObject;
      if (!canUseEmote(local.userData.a)) local.userData.a = 0;
    });
    events.on('mp_own_outfit', (outfit: number[]) => {
      const next = sanitizeOutfit(outfit);
      if (next.some((v, i) => v !== this.outfit[i])) this.setOutfit(next);
    });
    this.ready.resolve();
  }

  enableControls = (enabled: boolean) => {
    if (enabled) this.mesh._controls.enable();
    else this.mesh._controls.disable();
  };

  /** Equipped items (see appearance.ts SLOTS), remembered on this device (and by the relay per account). */
  outfit: Outfit = loadOutfit();

  setOutfit = (outfit: Outfit) => {
    this.outfit = sanitizeOutfit(outfit);
    this.mesh?.setOutfit(this.outfit);
    try {
      localStorage.setItem(OUTFIT_STORAGE_KEY, JSON.stringify(this.outfit));
    } catch {
      /* storage unavailable: keep it for this session */
    }
    events.emit('webgl_character_update_outfit', this.outfit);
  };

  changeColor = () => {
    const color = Math.floor(Math.random() * 4);
    const seed = this.seed % 1;
    let hue = Math.random();
    while (Math.abs(hue - seed) < 0.2) hue = Math.random();
    this.seed = color + hue;
    if (this.mesh) this.mesh._localObject.userData.seed = this.seed;
    const c = new Color().setHSL(hue, 0.4, 0.3);
    events.emit('webgl_character_update_color', `#${c.getHexString()}`);
  };
}
