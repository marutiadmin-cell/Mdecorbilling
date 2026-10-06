/**
 * Test stub for src/lib/firebase.
 *
 * The screen tests must NEVER be able to reach the client's live Firestore,
 * so this replaces the real module entirely (see the esbuild --alias in
 * package.json). `isBrowser: false` is the important part: every Repository
 * write path checks it and, when false, updates only the in-memory cache —
 * exactly the behaviour we want for seeded fixture data. `db`/`auth` are
 * never dereferenced on that path, so dummies are enough.
 */
export const DATABASE_ID = "test-only-never-a-real-database";
export const isBrowser = false;
export const db = {} as never;
export const auth = { currentUser: null } as never;
/** Undefined on purpose: the document vault's Storage helpers refuse to do
 *  anything without a real app, which is exactly what a test run should get.
 *  A stub that handed back something usable would let a test upload to the
 *  client's live bucket. */
export const firebaseApp = undefined;
/** Never actually called with isBrowser: false (the real function returns
 *  immediately in that case too), but exported so __root.tsx's import
 *  resolves against this stub. */
export async function clearOfflineCacheAndReload(): Promise<void> {}
