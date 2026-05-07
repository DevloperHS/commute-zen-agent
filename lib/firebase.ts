import { initializeApp, getApps, getApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';

function buildFirebaseConfig() {
  return {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? '',
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? '',
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? '',
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? '',
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? '',
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? '',
    ...(process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID
      ? { measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID }
      : {}),
  };
}

let app: FirebaseApp | undefined;
let authInstance: Auth | undefined;
let dbInstance: Firestore | undefined;

function initFirebaseClient(): void {
  if (typeof window === 'undefined') {
    return;
  }
  if (app) {
    return;
  }
  const config = buildFirebaseConfig();
  if (!config.apiKey || !config.projectId || !config.appId) {
    throw new Error(
      'Firebase is not configured. Set NEXT_PUBLIC_FIREBASE_* variables in .env.local (see .env.example).',
    );
  }
  app = !getApps().length ? initializeApp(config) : getApp();
  const databaseId = process.env.NEXT_PUBLIC_FIRESTORE_DATABASE_ID?.trim() || '(default)';
  dbInstance = getFirestore(app, databaseId);
  authInstance = getAuth(app);
}

function getAuthOrThrow(): Auth {
  initFirebaseClient();
  if (!authInstance) {
    throw new Error(
      'Firebase Auth is only available in the browser after configuration. Set NEXT_PUBLIC_FIREBASE_* in .env.local.',
    );
  }
  return authInstance;
}

function getDbOrThrow(): Firestore {
  initFirebaseClient();
  if (!dbInstance) {
    throw new Error(
      'Firestore is only available in the browser after configuration. Set NEXT_PUBLIC_FIREBASE_* in .env.local.',
    );
  }
  return dbInstance;
}

function createLazyClientRef<T extends object>(resolve: () => T): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      const real = resolve();
      const value = Reflect.get(real, prop, real);
      if (typeof value === 'function') {
        return value.bind(real);
      }
      return value;
    },
  });
}

export const auth = createLazyClientRef<Auth>(getAuthOrThrow);
export const db = createLazyClientRef<Firestore>(getDbOrThrow);
