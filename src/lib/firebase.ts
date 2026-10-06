import { initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentSingleTabManager,
  terminate,
  clearIndexedDbPersistence,
  waitForPendingWrites,
  type Firestore,
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyB0Fb0d0VMGPKvx-6ALOqYwiwbgyPj7fs0",
  authDomain: "marutidecor-c4853.firebaseapp.com",
  projectId: "marutidecor-c4853",
  storageBucket: "marutidecor-c4853.firebasestorage.app",
  messagingSenderId: "736142902054",
  appId: "1:736142902054:web:118f28b111e55eca1337e7",
  measurementId: "G-PJ08LKTFYY",
};

/** The project's own default Firestore database — no named database to
 * create first. Keep src/lib/firebaseAdmin.ts and the WhatsApp backend's
 * FIRESTORE_DATABASE_ID in step with this. */
export const DATABASE_ID = "(default)";

export const isBrowser = typeof window !== "undefined";

let app: FirebaseApp | undefined;
let authInstance: Auth | undefined;
let dbInstance: Firestore | undefined;

// The Firebase client SDK is browser-only in this app; during SSR the
// repositories return empty data (same behaviour as the old localStorage layer).
if (isBrowser) {
  app = initializeApp(firebaseConfig);
  authInstance = getAuth(app);
  // Offline-first: writes queue locally and sync when internet returns,
  // reads keep working from the persistent cache — important for a shop counter.
  //
  // Single-tab manager, not multi-tab: the app already has its own in-app
  // tab bar inside one browser tab, so real cross-browser-tab sync buys
  // nothing here. Multi-tab mode's cross-tab IndexedDB lease/lock
  // coordination is a well-known source of hangs on Safari/macOS (WebKit's
  // stricter IndexedDB behavior + background-tab throttling can stall the
  // lease handoff) — single-tab persistence keeps the same offline-cache
  // benefit without that cross-tab coordination surface.
  //
  // forceOwnership: true is essential here, not optional — without it, a
  // freshly opened/reloaded tab WAITS for any other tab already holding the
  // persistence lock to release it. If that other tab is a backgrounded or
  // already-closed Safari tab (session restore on relaunch is common on
  // macOS), the lease handoff can stall indefinitely — the app just hangs
  // on load with nothing on screen. forceOwnership makes the new tab seize
  // the lock immediately instead of waiting.
  dbInstance = initializeFirestore(
    app,
    {
      localCache: persistentLocalCache({
        tabManager: persistentSingleTabManager({ forceOwnership: true }),
      }),
    },
    DATABASE_ID,
  );
}

/** The initialised app, for the SDKs that are loaded lazily — Storage, used
 *  by the document vault. Undefined during SSR, where there is no app. */
export const firebaseApp = app;
export const auth = authInstance as Auth;
export const db = dbInstance as Firestore;

/**
 * Wipe this tab's offline Firestore cache and reload, on sign-out.
 *
 * Firestore security rules are only enforced on a server round-trip — a read
 * served from `persistentLocalCache` above bypasses them entirely. Without
 * this, a signed-out (or deactivated) user's browser keeps a full
 * offline-readable copy of every collection it ever synced: parties, sales,
 * purchases, bank balances. Call this from the ONE place sign-out is
 * detected (onAuthStateChanged in src/routes/__root.tsx), not from each
 * logout button, so it fires no matter how the session ended.
 *
 * `clearIndexedDbPersistence` requires the client fully closed first and
 * there is no partial/background way to do that — hence the reload, which
 * also lands the user back on /login via the normal boot sequence.
 *
 * NEVER clears a cache that still has writes this device hasn't gotten to
 * the server yet: a shop that saves a sale offline and logs out before
 * reconnecting must not lose that sale. `waitForPendingWrites` confirms the
 * queue is empty first; if it is not (or the device is offline and the
 * check can't resolve), the clear is skipped entirely and only the reload
 * happens — the untouched cache safely resumes sending those writes next
 * time the app opens. A closed security gap is not worth a lost invoice.
 */
export async function clearOfflineCacheAndReload(): Promise<void> {
  if (!isBrowser) return;
  if (!dbInstance) {
    window.location.reload();
    return;
  }
  try {
    await Promise.race([
      waitForPendingWrites(dbInstance),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("timeout")), 4000)),
    ]);
    await terminate(dbInstance);
    await clearIndexedDbPersistence(dbInstance);
  } catch (err) {
    console.error(
      "Skipped clearing offline cache on sign-out (unsynced writes, or still offline)",
      err,
    );
  } finally {
    window.location.reload();
  }
}
