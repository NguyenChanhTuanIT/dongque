// Ambient audio controller (port of `audioController`): 5 positional loops,
// forest↔beach crossfade by player position, muting/ducking.

import { Audio, AudioListener } from 'three';
import { gsap } from 'gsap';
import { deferred, type Deferred } from '../core/deferred';
import { events } from '../core/events';
import { clock } from './clock';
import { engine } from './globals';
import { ease, fit } from '../core/math';
import type { BaseScene } from './scene';

// Root-absolute: the same URL must work from any page path.
const AUDIO_URL = '/assets/audio/';
const assetUrl = (file: string) => AUDIO_URL + file;

/** three.js Audio extended with a loop offset for GSAP-synced looping. */
export class LoopAudio extends Audio {
  loopOffset = 0;
  _progress = 0;

  /** Restart the loop from a computed position (used for sync). */
  syncLoop(time: number): void {
    this.pause();
    this._progress =
      ((time + this.loopOffset) * this.playbackRate) % (this.buffer?.duration || 1);
    this.play();
  }
}

export class AudioController {
  canPlaySound: Deferred<void> = deferred();

  private _scene: BaseScene;
  private _defaultVolume: number;
  private _multiplierVolume = 1;
  private _hasStarted = false;
  private _hasLoaded = false;
  private _listener: AudioListener | null = null;
  private _audios: Record<string, LoopAudio> = {};
  private _syncLoops: LoopAudio[] = [];
  private _syncGSAPOffset = 0;
  private _visibleState = true;
  private _muted = true;
  private _filesPreloaded: Deferred<void> = deferred();
  private _filesBuffers: ArrayBuffer[] = [];
  private _files: Array<{ name: string; url: string }> = [
    { name: 'forest', url: assetUrl('forest.mp3') },
    { name: 'beach', url: assetUrl('beach.mp3') },
    { name: 'steps', url: assetUrl('footsteps.mp3') },
    { name: 'song', url: assetUrl('song.mp3') },
    { name: 'click1', url: assetUrl('click1.mp3') },
  ];

  constructor(scene: BaseScene, defaultVolume = 1) {
    this._scene = scene;
    this._defaultVolume = defaultVolume;

    events.on('visibility_change', this._onVisibilityChange);
    events.on('webgl_audio_mute_toggle', this._muteToggle);
    events.on('webgl_audio_play_sound', this.playSound);
    events.on('webgl_audio_overlay_volume', this.overlayVolume);

    // Ambience and effects after the scene; the song (the largest file, 2 MB)
    // only once the player interacts, since nothing can play before that anyway.
    scene.uploaded.then(async () => {
      try { const buffers = await Promise.all(this._files.map(async (f) => { if (f.name === 'song') return null; const res = await fetch(f.url); if (!res.ok) throw new Error('audio preload failed'); return res.arrayBuffer(); })); this._filesBuffers = buffers as ArrayBuffer[]; } catch (error) { console.warn('Audio preload failed', error); this._filesBuffers = []; }
      this._filesPreloaded.resolve();
    });

    // Start on the first user interaction (autoplay policy). The unlock
    // listeners stay until that interaction actually happens: removing them
    // when canPlaySound resolves (1.5s into the intro) left players who had not
    // clicked yet with no AudioContext at all, so the sound button did nothing.
    const start = () => {
      removeUnlock();
      void this._start();
    };
    (engine as any).touchController?.allowClickEvents(true);
    const removeUnlock = () => { document.body.removeEventListener('click', start); events.off('touch_end', start); events.off('keydown', start); (engine as any).touchController?.allowClickEvents(false); };
    document.body.addEventListener('click', start);
    events.on('touch_end', start);
    events.on('keydown', start);
  }

  private async _start() {
    if (!this._listener) {
      this._listener = new AudioListener();
      this._listener.setMasterVolume(0);
      this._scene.add(this._listener);
    }
    await this._listener.context.resume();
    if (this._hasStarted) return;
    this._hasStarted = true;
    if (this._muted) this._muteToggle();
    await Promise.all([this._createAudios(), new Promise((r) => setTimeout(r, 500)), this.canPlaySound]);

    const click = this._audios.click1;
    if (click) { click.setLoop(false); click.stop(); click.setVolume(0.25); }
    const steps = this._audios.steps;
    if (steps) { steps.loopOffset = 0.125; this._syncLoops.push(steps); }
    this._hasLoaded = true;
    if (this._visibleState && !this._muted) {
      this._listener.gain.gain.setTargetAtTime(this._defaultVolume, this._listener.context.currentTime, 1);
    }
  }

  private async _createAudios() {
    await this._filesPreloaded;
    // The song is fetched now (first interaction), see the constructor.
    const songIndex = this._files.findIndex((f) => f.name === 'song');
    if (songIndex >= 0 && !this._filesBuffers[songIndex] && this._filesBuffers.length) {
      try {
        const res = await fetch(this._files[songIndex].url);
        if (res.ok) this._filesBuffers[songIndex] = await res.arrayBuffer();
      } catch (error) {
        console.warn('Song download failed', error);
      }
    }
    const jobs = this._files.map((file, index) => new Promise<void>((resolve) => { const buffer = this._filesBuffers[index]; if (!buffer) { resolve(); return; } this._listener!.context.decodeAudioData(buffer.slice(0), (decoded) => { const audio = new LoopAudio(this._listener!); this._audios[file.name] = audio; audio.setBuffer(decoded); audio.setLoop(true); audio.setVolume(0); audio.play(); resolve(); }, () => resolve()); }));
    await Promise.all(jobs);
  }

  private _onVisibilityChange = (visible: boolean) => {
    if (!this._hasLoaded || !this._listener) return;
    if (visible) {
      if (!this._visibleState) {
        this._visibleState = true;
        if (!this._muted) {
          this._listener.gain.gain.setTargetAtTime(this._defaultVolume, this._listener.context.currentTime, 2);
        }
      }
    } else if (this._visibleState) {
      this._visibleState = false;
      this._listener.gain.gain.setTargetAtTime(0, this._listener.context.currentTime, 0.5);
    }
  };

  /** Change the master volume (applied smoothly when audible). */
  setVolume(volume: number): void {
    this._defaultVolume = Math.max(0, Math.min(1, volume));
    if (this._hasLoaded && this._listener && !this._muted && this._visibleState) {
      this._listener.gain.gain.setTargetAtTime(this._defaultVolume, this._listener.context.currentTime, 0.5);
    }
  }

  private _muteToggle = () => {
    this._muted = !this._muted;
    events.emit('webgl_audio_update_mute', this._muted);
    if (this._hasLoaded && this._listener) {
      const target = this._muted ? 0 : this._defaultVolume;
      this._listener.gain.gain.setTargetAtTime(target, this._listener.context.currentTime, this._muted ? 0.25 : 0.5);
    }
  };

  private _syncAudioWithGsap() {
    if (!this._listener) return;
    const drift = clock.time - this._listener.context.currentTime;
    if (Math.abs(drift - this._syncGSAPOffset) > 0.025) {
      for (const loop of this._syncLoops) loop.syncLoop(clock.time);
      this._syncGSAPOffset = drift;
    }
  }

  private _optional = new Map<string, Promise<AudioBuffer | null>>();

  /** Lazily load an optional sound file; null when it is missing or undecodable. */
  private _optionalBuffer(url: string): Promise<AudioBuffer | null> {
    let p = this._optional.get(url);
    if (!p) {
      const context = this._listener!.context;
      p = fetch(url)
        .then((res) => (res.ok ? res.arrayBuffer() : null))
        .then((data) => (data ? context.decodeAudioData(data) : null))
        .catch(() => null);
      this._optional.set(url, p);
    }
    return p;
  }

  /** Play an optional one-shot sound (e.g. NPC laughter) once audio has started. */
  async playOnce(url: string, volume: number): Promise<void> {
    if (!this._hasLoaded || !this._listener || volume <= 0) return;
    const buffer = await this._optionalBuffer(url);
    if (!buffer) return;
    const audio = new Audio(this._listener);
    audio.setBuffer(buffer);
    audio.setVolume(Math.min(1, volume));
    audio.play();
  }

  /** Start an optional looping sound; null until audio has started or if the file is missing. */
  async loopSound(url: string): Promise<{ setVolume(volume: number): void; stop(): void } | null> {
    if (!this._hasLoaded || !this._listener) return null;
    const buffer = await this._optionalBuffer(url);
    if (!buffer) return null;
    const audio = new Audio(this._listener);
    audio.setBuffer(buffer);
    audio.setLoop(true);
    audio.setVolume(0);
    audio.play();
    return {
      setVolume: (volume: number) => audio.setVolume(Math.max(0, Math.min(1, volume))),
      stop: () => audio.stop(),
    };
  }

  playSound = (name: string) => {
    this._audios[name]?.stop();
    this._audios[name]?.play(0);
  };

  overlayVolume = (volume = 1) => {
    gsap.to(this, {
      _multiplierVolume: volume,
      duration: 1.35,
    });
  };

  /** Called every frame with the player's world position + speed. */
  updatePlayerPosition(position: number[] = [0, 0, 0], speed = 0, onFloor = true) {
    if (!this._hasLoaded || !this._visibleState) return;
    this._syncAudioWithGsap();
    this._audios.song?.setVolume(0.5 * this._multiplierVolume);

    // crossfade forest ↔ beach by world X position
    const blend = fit(position[0], 35, 65, 0, 1);
    (['forest', 'beach'] as const).forEach((name, i) => {
      const audio = this._audios[name];
      const volume = (i === 0 ? 1 - blend : blend) * this._multiplierVolume;
      if (!audio) return;
      audio.setVolume(volume);
      if (volume === 0) {
        if (audio.isPlaying) audio.pause();
      } else if (!audio.isPlaying) {
        audio.play();
      }
    });

    this._audios.steps?.setVolume(
      ease(fit(speed, 0.001, 0.05, 0, 1) * (onFloor ? 1 : 0), 'power2.in'),
    );
  }
}
