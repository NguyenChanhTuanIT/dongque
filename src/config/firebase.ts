// Firebase app bootstrap shared by the game and the admin page. The web
// config comes from VITE_FIREBASE_* env vars (see .env.example); when they are
// missing, Firebase is never loaded and the game runs on DEFAULT_CONFIG.

import type { FirebaseApp, FirebaseOptions } from 'firebase/app';

/** Firestore location of the scene config document. */
export const CONFIG_COLLECTION = 'config';
export const CONFIG_DOC = 'scene';
/** Collection whose document ids are the uids allowed to write the config. */
export const ADMINS_COLLECTION = 'admins';

const env = import.meta.env;

export const firebaseOptions: FirebaseOptions = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
};

export function isFirebaseConfigured(): boolean {
  return Boolean(firebaseOptions.apiKey && firebaseOptions.projectId && firebaseOptions.appId);
}

let appPromise: Promise<FirebaseApp> | null = null;

/** Lazily import and initialize the Firebase app (one instance per page). */
export function getFirebaseApp(): Promise<FirebaseApp> {
  appPromise ??= import('firebase/app').then(({ initializeApp }) => initializeApp(firebaseOptions));
  return appPromise;
}
