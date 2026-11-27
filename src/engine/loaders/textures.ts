// Texture loading with caching/fallbacks (port of `textureLoader`): one cache
// keyed by `file<>mode`, KTX2 (Basis) + bitmap/exr/svg/video/image.

import {
  CompressedTexture,
  Data3DTexture,
  DataTexture,
  LinearFilter,
  NearestFilter,
  RepeatWrapping,
  sRGBEncoding,
  Texture,
  TextureLoader as ThreeTextureLoader,
  VideoTexture,
} from 'three';
import type { WebGLRenderer } from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { deferred, type Deferred } from '../../core/deferred';

const DEFAULT_TEXTURE = 'uv/uvchecker-srgb.png';
const DEFAULT_TEXTURE_BASIS = 'uv/uvchecker-srgb.ktx2';

export interface LoadedTexture extends Texture {
  _url?: string;
  _loadMode?: string;
  _loaded: Deferred<void>;
}

// Root-absolute so the loader works identically from the site root and from
// pages below it, where a relative URL would resolve to a nested
// assets/... path and 404.
const asset = (path: string) => new URL(path, window.location.origin + '/').toString();
const ktx2Loader = new KTX2Loader().setTranscoderPath(asset('assets/libs/basis/'));
const imageLoader = new ThreeTextureLoader();
const exrLoader = new EXRLoader();
const cache = new Map<string, LoadedTexture>();

const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };

/** True when the bytes really are a PNG/JPEG (not e.g. an SPA index.html fallback). */
function isImageBytes(bytes: Uint8Array): boolean {
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return png || jpeg;
}

/**
 * Load a PNG/JPEG texture byte-exact. Render's CDN (Cloudflare Polish)
 * re-encodes images served as image/* for browsers: lossy WebP (or a
 * re-compressed PNG), which destroys data textures. masks.png keeps
 * road/sand/path in RGB with alpha mostly 0, and the re-encode zeroes RGB under
 * transparent pixels, so the road and sand vanish. The build (vite.config.ts,
 * rawImageCopies) writes a `<name>.png.bin` copy of every image, served as
 * octet-stream, which the CDN leaves alone; it is decoded here through a blob:
 * URL so the <img> decode path (flipY etc.) is unchanged. Falls back to the
 * plain image URL when the copy is missing (dev server, other hosts).
 */
async function loadImageUntransformed(url: string): Promise<Texture> {
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
  const mime = IMAGE_MIME[ext];
  if (!mime || !import.meta.env.PROD) return imageLoader.loadAsync(url);

  let objectUrl: string;
  try {
    const response = await fetch(url + '.bin');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!isImageBytes(bytes)) throw new Error('not an image');
    objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
  } catch {
    return imageLoader.loadAsync(url);
  }
  try {
    return await imageLoader.loadAsync(objectUrl);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/** Must be called once with the renderer to enable compressed textures. */
export function initTextureLoader(renderer: WebGLRenderer): void {
  ktx2Loader.detectSupport(renderer);
}

export const textureLoader = {
  load(url: string = DEFAULT_TEXTURE, mode = 'default'): LoadedTexture {
    const key = `${url}_<>_${mode}`;
    const cached = cache.get(key);
    if (cached) return cached;

    const ext = url.split('.').pop() ?? '';
    const modeLower = mode.toLowerCase();
    let texture: LoadedTexture;

    if (ext.startsWith('ktx2')) {
      texture = (modeLower.includes('lut')
        ? new (Data3DTexture as any)()
        : new (CompressedTexture as any)()) as LoadedTexture;
    } else if (ext.startsWith('exr')) {
      texture = new (DataTexture as any)() as LoadedTexture;
    } else if (ext.startsWith('mp4') || ext.startsWith('webm')) {
      texture = new Texture() as LoadedTexture;
    } else {
      texture = new Texture() as LoadedTexture;
    }

    texture._url = url;
    texture._loadMode = modeLower;
    texture._loaded = deferred();
    texture.encoding = modeLower.includes('srgb') ? sRGBEncoding : texture.encoding;
    cache.set(key, texture);

    const fullUrl = /^https?:\/\//.test(url) ? url : asset('assets/images/' + url);

    setTimeout(async () => {
      let loaded: Texture | null = null;
      try {
        if (ext.startsWith('ktx2')) loaded = await ktx2Loader.loadAsync(fullUrl);
        else if (ext.startsWith('exr')) loaded = await exrLoader.loadAsync(fullUrl);
        else if (ext.startsWith('mp4') || ext.startsWith('webm')) { const video = document.createElement('video'); video.src = fullUrl; video.muted = true; video.loop = true; video.playsInline = true; await new Promise<void>((resolve, reject) => { video.addEventListener('loadeddata', () => resolve(), { once: true }); video.addEventListener('error', () => reject(new Error('video load failed')), { once: true }); video.load(); }); loaded = new VideoTexture(video); } else loaded = await loadImageUntransformed(fullUrl);
      } catch (err) {
        console.warn('Texture load:', err);
        // fallback to the uv-checker texture (original behavior)
        try {
          const fallback = ext.startsWith('ktx2') ? DEFAULT_TEXTURE_BASIS : DEFAULT_TEXTURE;
          loaded = await (ext.startsWith('ktx2') ? ktx2Loader : imageLoader).loadAsync(asset('assets/images/' + fallback));
        } catch {
          const fallbackTexture = new DataTexture(new Uint8Array([255, 0, 255, 255]), 1, 1); fallbackTexture.needsUpdate = true; loaded = fallbackTexture;
        }
      }
      if (loaded && loaded !== texture) texture.copy(loaded);
      if (modeLower.includes('repeat')) {
        texture.wrapS = RepeatWrapping;
        texture.wrapT = RepeatWrapping;
      }
      if (modeLower.includes('colordata')) {
        texture.magFilter = LinearFilter;
        texture.minFilter = LinearFilter;
        texture.generateMipmaps = false;
      } else if (modeLower.includes('nearest')) {
        texture.magFilter = NearestFilter;
        texture.minFilter = NearestFilter;
        texture.generateMipmaps = false;
      }
      if (modeLower.includes('lut')) {
        texture.magFilter = NearestFilter;
        texture.minFilter = NearestFilter;
      }
      texture.encoding = modeLower.includes('srgb') ? sRGBEncoding : texture.encoding;
      texture.needsUpdate = true;
      texture._loaded.resolve();
    }, 0);

    return texture;
  },

  /** Replace a placeholder texture with the high-quality version once ready. */
  async loadProgressive(url: string, holder: { value: any }, field = 'value' as const): Promise<void> {
    await (holder as any)[field]._loaded;
    const high = this.load(url, (holder as any)[field]._loadMode);
    await high._loaded;
    (holder as any)[field] = high;
  },
};
