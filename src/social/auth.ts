// Email/password accounts (Firebase Auth), required to pick a display name.
// The name itself is claimed on the relay, which verifies the ID token
// (server/firebase-auth.mjs); it is remembered per account on this device.
// Each sign-in also records a profile in Firestore `users/{uid}` (email, name,
// sign-in times) for the admin panel, which can ban the account from there.

import type { User } from 'firebase/auth';
import { events } from '../core/events';
import { USERS_COLLECTION, getFirebaseApp, isFirebaseConfigured } from '../config/firebase';
import type { Profile } from '../engine/multiplayer/socket';

type Listener = (user: User | null) => void;

let current: User | null = null;
const listeners = new Set<Listener>();
let started = false;

const firebaseAuth = () => Promise.all([getFirebaseApp(), import('firebase/auth')]);
const firestore = () => Promise.all([getFirebaseApp(), import('firebase/firestore')]);
/** Error code thrown by signInWithEmail for an account banned in the admin panel. */
export const BANNED_ERROR = 'app/account-banned';
const nameKey = (uid: string) => `summertime.name.${uid}`;

export const isLoginAvailable = isFirebaseConfigured;

function isPasswordUser(user: User | null): user is User {
  return !!user && user.providerData.some((p) => p.providerId === 'password');
}

/** Signed-in email/password user, or null. */
export function currentUser(): User | null {
  return isPasswordUser(current) ? current : null;
}

/** Call `listener` now and on every sign-in / sign-out. */
export function watchUser(listener: Listener): () => void {
  listeners.add(listener);
  listener(currentUser());
  start();
  return () => listeners.delete(listener);
}

function start() {
  if (started || !isFirebaseConfigured()) return;
  started = true;
  firebaseAuth()
    .then(([app, fa]) => {
      fa.onAuthStateChanged(fa.getAuth(app), (user) => {
        current = user;
        const signedIn = currentUser();
        // Sign the relay session in (daily rewards) and, back from an earlier
        // visit, re-claim the name saved for this account ('' = stay a guest).
        events.emit('mp_profile', signedIn ? profileFor(signedIn, savedName(signedIn.uid)) : null);
        for (const l of listeners) l(signedIn);
        if (signedIn) {
          void recordLogin(signedIn).then((banned) => {
            if (!banned || current?.uid !== signedIn.uid) return;
            events.emit('auth_banned');
            void signOut();
          });
        }
      });
    })
    .catch((err) => console.warn('[auth] Firebase Auth failed to start', err));
}

export async function signInWithEmail(email: string, password: string): Promise<User> {
  const [app, fa] = await firebaseAuth();
  const { user } = await fa.signInWithEmailAndPassword(fa.getAuth(app), email, password);
  current = user;
  if (await recordLogin(user)) {
    await signOut();
    throw Object.assign(new Error('account banned'), { code: BANNED_ERROR });
  }
  return user;
}

export async function registerWithEmail(email: string, password: string): Promise<User> {
  const [app, fa] = await firebaseAuth();
  const { user } = await fa.createUserWithEmailAndPassword(fa.getAuth(app), email, password);
  current = user;
  void recordLogin(user); // queued before the name write that usually follows
  return user;
}

export async function signOut() {
  logins.clear();
  const [app, fa] = await firebaseAuth();
  await fa.signOut(fa.getAuth(app));
}

// --- Firestore profile (users/{uid}) ------------------------------------------

/** Profile writes run one after another (create before the first name update). */
let profileQueue: Promise<unknown> = Promise.resolve();
function queueProfile<T>(task: () => Promise<T>): Promise<T> {
  const run = profileQueue.then(task, task);
  profileQueue = run.catch(() => {});
  return run;
}

/** One profile sync per account and page load; resolves to "is banned". */
const logins = new Map<string, Promise<boolean>>();

/**
 * Create `users/{uid}` on first sign-in, refresh email and last sign-in time
 * after that. Never rejects: without Firestore (or before the rules are
 * deployed) the game simply keeps working and the account counts as not banned.
 */
function recordLogin(user: User): Promise<boolean> {
  let pending = logins.get(user.uid);
  if (!pending) {
    pending = queueProfile(async () => {
      const [app, fs] = await firestore();
      const ref = fs.doc(fs.getFirestore(app), USERS_COLLECTION, user.uid);
      const snap = await fs.getDoc(ref);
      if (snap.exists()) {
        if (snap.data().banned === true) return true;
        await fs.updateDoc(ref, { email: user.email ?? '', lastLoginAt: fs.serverTimestamp() });
      } else {
        const now = fs.serverTimestamp();
        await fs.setDoc(ref, { email: user.email ?? '', name: savedName(user.uid), createdAt: now, lastLoginAt: now });
      }
      return false;
    }).catch((err) => {
      console.warn('[auth] could not record the profile', err);
      return false;
    });
    logins.set(user.uid, pending);
  }
  return pending;
}

function recordName(user: User, name: string) {
  void queueProfile(async () => {
    const [app, fs] = await firestore();
    await fs.updateDoc(fs.doc(fs.getFirestore(app), USERS_COLLECTION, user.uid), { name });
  }).catch((err) => console.warn('[auth] could not save the name to the profile', err));
}

/** Vietnamese message for a Firebase Auth error code. */
export function authErrorMessage(err: unknown): string {
  const code = (err as { code?: string })?.code ?? '';
  switch (code) {
    case 'auth/invalid-email':
      return 'Email không hợp lệ.';
    case 'auth/missing-password':
      return 'Vui lòng nhập mật khẩu.';
    case 'auth/invalid-credential':
    case 'auth/invalid-login-credentials':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Email hoặc mật khẩu không đúng.';
    case 'auth/user-disabled':
    case BANNED_ERROR:
      return 'Tài khoản đã bị khoá.';
    case 'auth/email-already-in-use':
      return 'Email này đã có tài khoản, hãy đăng nhập.';
    case 'auth/weak-password':
      return 'Mật khẩu cần ít nhất 6 ký tự.';
    case 'auth/too-many-requests':
      return 'Thử quá nhiều lần, chờ một lúc rồi thử lại nhé.';
    case 'auth/network-request-failed':
      return 'Lỗi mạng, kiểm tra kết nối rồi thử lại.';
    case 'auth/operation-not-allowed':
      return 'Máy chủ chưa bật đăng nhập bằng email/mật khẩu.';
    default:
      return 'Có lỗi xảy ra, thử lại nhé.';
  }
}

export function savedName(uid: string): string {
  try {
    return localStorage.getItem(nameKey(uid)) ?? '';
  } catch {
    return '';
  }
}

/** Remember the name and claim it on the relay (the echo confirms it). */
export function setName(user: User, name: string) {
  try {
    localStorage.setItem(nameKey(user.uid), name);
  } catch {
    /* storage unavailable: the name lasts for this session */
  }
  recordName(user, name);
  events.emit('mp_profile', profileFor(user, name));
}

function profileFor(user: User, name: string): Profile {
  return { name, getToken: () => user.getIdToken() };
}
