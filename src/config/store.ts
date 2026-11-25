// Game-side config store: loads `config/scene` from Firestore once at boot
// (bounded by a timeout so the scene never waits on the network for long),
// then keeps listening so admin edits apply live to subscribed modules.

import { DEFAULT_CONFIG, mergeWithDefaults, type SceneConfig } from './schema';
import { CONFIG_COLLECTION, CONFIG_DOC, getFirebaseApp, isFirebaseConfigured } from './firebase';

type Listener = (config: SceneConfig) => void;

let current: SceneConfig = structuredClone(DEFAULT_CONFIG);
const listeners = new Set<Listener>();

/** The active config (defaults until Firestore answers). */
export function getConfig(): SceneConfig {
  return current;
}

/**
 * Run `listener` now with the active config and again on every live update.
 * Returns an unsubscribe function.
 */
export function watchConfig(listener: Listener): () => void {
  listeners.add(listener);
  listener(current);
  return () => listeners.delete(listener);
}

function apply(data: unknown) {
  current = mergeWithDefaults(DEFAULT_CONFIG, data);
  for (const listener of listeners) {
    try {
      listener(current);
    } catch (err) {
      console.warn('[config] listener failed', err);
    }
  }
}

/**
 * Resolve once the first Firestore snapshot arrives, the request fails, or
 * `timeoutMs` passes — whichever is first. Live updates keep flowing after.
 */
export async function loadConfig(timeoutMs = 4000): Promise<SceneConfig> {
  if (!isFirebaseConfigured()) return current;

  return new Promise<SceneConfig>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve(current);
    };
    const timer = window.setTimeout(() => {
      console.warn('[config] Firestore did not answer in time, using defaults');
      settle();
    }, timeoutMs);

    (async () => {
      const app = await getFirebaseApp();
      const { getFirestore, doc, onSnapshot } = await import('firebase/firestore');
      const ref = doc(getFirestore(app), CONFIG_COLLECTION, CONFIG_DOC);
      onSnapshot(
        ref,
        (snap) => {
          apply(snap.exists() ? snap.data() : undefined);
          window.clearTimeout(timer);
          settle();
        },
        (err) => {
          console.warn('[config] Firestore read failed, using defaults', err);
          window.clearTimeout(timer);
          settle();
        },
      );
    })().catch((err) => {
      console.warn('[config] Firebase init failed, using defaults', err);
      window.clearTimeout(timer);
      settle();
    });
  });
}
