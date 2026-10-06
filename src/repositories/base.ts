import { nanoid } from "nanoid";
import {
  collection,
  doc,
  onSnapshot,
  setDoc,
  deleteDoc,
  writeBatch,
  increment,
  getDocsFromServer,
  type WriteBatch,
  type FirestoreError,
} from "firebase/firestore";
import { signOut } from "firebase/auth";
import { db, auth, isBrowser } from "@/lib/firebase";
import { toast } from "sonner";

/** A just-deactivated (or permission-changed) user's already-open tab would
 * otherwise sit on stale cached data behind a misleading "check your
 * internet" toast — this reacts to a genuine permission-denied specifically
 * by forcing a clean sign-out, distinct from a transient connectivity blip.
 * Calling signOut here (not clearing repo caches directly) is deliberate:
 * it triggers the same onAuthStateChanged → stopRepos() path a normal
 * logout already goes through in src/routes/__root.tsx, so there's exactly
 * one place that owns "what happens when a session ends." */
let forcingSignOut = false;
export function handlePostHydrationError(err: FirestoreError, name: string) {
  console.error(`Sync error on "${name}"`, err);
  if (err.code === "permission-denied") {
    if (forcingSignOut) return;
    forcingSignOut = true;
    toast.error("Your access has changed — signing you out. Sign in again to continue.");
    signOut(auth).finally(() => {
      forcingSignOut = false;
    });
    return;
  }
  toast.error("Cloud sync interrupted — check internet, then reload");
}

export const genId = () => nanoid(10);

/**
 * Tiny global store so React can re-render live as repository data changes —
 * on first load, on background cloud sync, and on local writes. One monotonic
 * version is bumped on ANY repo change; components subscribe once (via the
 * useRepoData hook) and read whatever repos they need in render. This is what
 * lets the app open immediately after login and fill screens in as each
 * collection's data arrives, instead of blocking on all of them up front.
 */
let repoVersion = 0;
const repoStoreListeners = new Set<() => void>();

export function subscribeRepos(cb: () => void): () => void {
  repoStoreListeners.add(cb);
  return () => {
    repoStoreListeners.delete(cb);
  };
}

export function repoStoreVersion(): number {
  return repoVersion;
}

export function emitRepoChange(): void {
  repoVersion++;
  repoStoreListeners.forEach((cb) => cb());
}

/** Start a batch of writes across one or more repositories that must all
 * commit together (e.g. an invoice plus the stock adjustments it triggers) —
 * see `commitBatch`. Returns null outside the browser, matching every other
 * write path's SSR no-op. */
export function newBatch(): WriteBatch | null {
  return isBrowser ? writeBatch(db) : null;
}

/** Commit a batch started with `newBatch`. All staged writes succeed or fail
 * together — no partial state where stock moves but the invoice doesn't
 * save, or vice versa.
 *
 * Returns whether the commit landed. Callers that go on to report success to
 * the user MUST check it: the cache is updated optimistically as each write is
 * staged, so a rejected commit leaves the screens showing numbers the cloud
 * never accepted. (Firestore rolls its own pending mutation back, so the next
 * snapshot corrects the cache — but a dialog that has already said "Updated
 * 266 items" and closed has told the shopkeeper something untrue.) Fire-and-
 * forget callers can keep ignoring it; the toast still fires either way. */
export async function commitBatch(batch: WriteBatch | null, action: string): Promise<boolean> {
  if (!batch) return true;
  try {
    await batch.commit();
    return true;
  } catch (err) {
    writeError(action)(err);
    return false;
  }
}

/** Firestore rejects `undefined` field values — strip them deeply before writing. */
function stripUndefined<T>(v: T): T {
  if (Array.isArray(v)) return v.map(stripUndefined) as unknown as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val !== undefined) out[k] = stripUndefined(val);
    }
    return out as T;
  }
  return v;
}

const writeError = (action: string) => (err: unknown) => {
  console.error(`Firestore ${action} failed`, err);
  toast.error(`Could not save to cloud (${action}). Check internet & try again.`);
};

/**
 * Firestore-backed repository with the SAME synchronous API the whole app
 * already uses. A live snapshot listener keeps an in-memory cache up to date;
 * reads are served from the cache, writes update the cache immediately and
 * sync to Firestore in the background (offline persistence queues them).
 */
/** A record on its way in: everything the type needs except `id` and
 * `createdAt`, which the repository fills in — but both are still ACCEPTED,
 * because form drafts carry `id: ""`/`createdAt: ""` placeholders and
 * restore/migration paths pass whole documents. */
export type NewRecord<T> = Omit<T, "id" | "createdAt"> & {
  id?: string;
  createdAt?: string;
};

export class Repository<T extends { id: string }> {
  private cache: T[] = [];
  private unsub?: () => void;

  constructor(private name: string) {}

  /** Subscribe to the collection; resolves after the first snapshot arrives. */
  hydrate(): Promise<void> {
    if (!isBrowser) return Promise.resolve();
    if (this.unsub) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let first = true;
      this.unsub = onSnapshot(
        collection(db, this.name),
        (snap) => {
          this.cache = snap.docs.map((d) => d.data() as T);
          // Newest first — matches the old localStorage unshift() ordering
          this.cache.sort((a, b) =>
            (((b as Record<string, unknown>).createdAt as string) ?? "").localeCompare(
              ((a as Record<string, unknown>).createdAt as string) ?? "",
            ),
          );
          // Notify subscribers on EVERY snapshot (first load + every live
          // update), so screens fill in and stay current as data arrives.
          emitRepoChange();
          if (first) {
            first = false;
            resolve();
          }
        },
        (err) => {
          if (first) {
            console.error(`Failed to load "${this.name}"`, err);
            first = false;
            reject(err);
          } else handlePostHydrationError(err, this.name);
        },
      );
    });
  }

  /** Stop listening and clear the cache (used on logout). */
  stop() {
    this.unsub?.();
    this.unsub = undefined;
    this.cache = [];
    emitRepoChange();
  }

  all(): T[] {
    return [...this.cache];
  }

  /**
   * The same collection, read straight from the server — bypassing both this
   * repository's in-memory cache AND Firestore's own persistent local cache.
   *
   * `all()` can be arbitrarily stale: another device's write (or this one's
   * own queued-but-unsynced write) may not have reached this cache yet. That
   * is fine for almost everything the app does, but it is exactly the gap
   * that lets two concurrent writes each check a cap (e.g. "how much of this
   * bill has already been returned") against stale data and both pass. This
   * narrows that race from "however stale the cache is" to the length of one
   * network round trip — not a full fix (the check-then-write still is not
   * atomic), but a meaningful reduction without rearchitecting every write
   * path onto Firestore transactions. Throws if offline; callers should catch
   * and fall back to `all()` rather than block saving entirely.
   */
  async allFromServer(): Promise<T[]> {
    const snap = await getDocsFromServer(collection(db, this.name));
    return snap.docs.map((d) => d.data() as T);
  }

  get(id: string): T | undefined {
    return this.cache.find((i) => i.id === id);
  }

  add(item: NewRecord<T>): T {
    const record = {
      ...item,
      // `||` not `??` — form drafts carry id: "" and an empty Firestore
      // document ID throws, crashing the save
      id: item.id || genId(),
      createdAt: new Date().toISOString(),
    } as unknown as T;
    this.cache.unshift(record);
    emitRepoChange();
    if (isBrowser) {
      setDoc(doc(db, this.name, record.id), stripUndefined(record)).catch(writeError("add"));
    }
    return record;
  }

  /** Same as add(), but stages the write on a shared batch (see `newBatch`)
   * instead of writing immediately, so it commits atomically with other
   * staged writes — e.g. an invoice plus the stock adjustments it triggers. */
  addBatched(batch: WriteBatch | null, item: NewRecord<T>): T {
    const record = {
      ...item,
      id: item.id || genId(),
      createdAt: new Date().toISOString(),
    } as unknown as T;
    this.cache.unshift(record);
    emitRepoChange();
    if (isBrowser && batch) {
      batch.set(doc(db, this.name, record.id), stripUndefined(record));
    }
    return record;
  }

  update(id: string, patch: Partial<T>): T | undefined {
    const idx = this.cache.findIndex((i) => i.id === id);
    if (idx < 0) return undefined;
    const merged = { ...this.cache[idx], ...patch };
    this.cache[idx] = merged;
    emitRepoChange();
    if (isBrowser) {
      // Write the full merged record so the cloud doc always mirrors the cache
      setDoc(doc(db, this.name, id), stripUndefined(merged)).catch(writeError("update"));
    }
    return merged;
  }

  /** Batched counterpart to update() — see addBatched(). */
  updateBatched(batch: WriteBatch | null, id: string, patch: Partial<T>): T | undefined {
    const idx = this.cache.findIndex((i) => i.id === id);
    if (idx < 0) return undefined;
    const merged = { ...this.cache[idx], ...patch };
    this.cache[idx] = merged;
    emitRepoChange();
    if (isBrowser && batch) {
      batch.set(doc(db, this.name, id), stripUndefined(merged));
    }
    return merged;
  }

  /**
   * The base an atomic adjustment adds to, and whether an increment is safe
   * to use for it.
   *
   * This exists because the local cache and Firestore disagree about what
   * "add 15 to this field" means when the field is not actually a number:
   *
   *   - Firestore's increment() treats ANY non-number as 0 and replaces the
   *     field with the delta. It does not parse "5".
   *   - JavaScript's `+` CONCATENATES, so a stock that arrived as the string
   *     "5" became "5" + 15 → 515 in the cache while the cloud stored 15.
   *     Subtraction is worse: "12" - 4 is NaN, which lands as null.
   *
   * That is a permanent local-vs-cloud split — the screens show one number,
   * a reload shows another, and every later adjustment widens the gap. It is
   * the one way a bulk stock correction can look applied and then disagree
   * with itself everywhere.
   *
   * A malformed value therefore gets an ABSOLUTE write instead of an
   * increment: that keeps the value the field was holding AND heals its type.
   * The cost is the concurrency safety an increment gives, which only ever
   * applies to data that is already broken. A MISSING field keeps the
   * increment, because there Firestore's 0-base and ours already agree.
   */
  private adjustBase(idx: number, field: string): { base: number; canIncrement: boolean } {
    const raw = (this.cache[idx] as Record<string, unknown>)[field];
    if (raw == null) return { base: 0, canIncrement: true };
    if (typeof raw === "number" && Number.isFinite(raw)) return { base: raw, canIncrement: true };
    const parsed = Number(raw);
    return { base: Number.isFinite(parsed) ? parsed : 0, canIncrement: false };
  }

  /**
   * Concurrency-safe numeric change (stock, paid…). Uses Firestore's atomic
   * increment so two devices changing the same number at the same moment
   * BOTH count — an absolute write would silently lose one of them.
   */
  adjustField(
    id: string,
    field: keyof T & string,
    delta: number,
    extra?: Partial<T>,
  ): T | undefined {
    const idx = this.cache.findIndex((i) => i.id === id);
    if (idx < 0) return undefined;
    const { base, canIncrement } = this.adjustBase(idx, field);
    const next = Math.round((base + delta) * 100) / 100;
    const merged = { ...this.cache[idx], ...(extra ?? {}), [field]: next } as T;
    this.cache[idx] = merged;
    emitRepoChange();
    if (isBrowser) {
      // set+merge, NOT update: update() fails on a missing doc, and inside a
      // batch that failure would void the whole invoice write
      setDoc(
        doc(db, this.name, id),
        {
          [field]: canIncrement ? increment(Math.round(delta * 100) / 100) : next,
          ...stripUndefined(extra ?? {}),
        },
        { merge: true },
      ).catch(writeError("update"));
    }
    return merged;
  }

  /** Batched counterpart to adjustField() — see addBatched(). */
  adjustFieldBatched(
    batch: WriteBatch | null,
    id: string,
    field: keyof T & string,
    delta: number,
    extra?: Partial<T>,
  ): T | undefined {
    const idx = this.cache.findIndex((i) => i.id === id);
    if (idx < 0) return undefined;
    const { base, canIncrement } = this.adjustBase(idx, field);
    const next = Math.round((base + delta) * 100) / 100;
    const merged = { ...this.cache[idx], ...(extra ?? {}), [field]: next } as T;
    this.cache[idx] = merged;
    emitRepoChange();
    if (isBrowser && batch) {
      batch.set(
        doc(db, this.name, id),
        {
          ...stripUndefined(extra ?? {}),
          [field]: canIncrement ? increment(Math.round(delta * 100) / 100) : next,
        },
        { merge: true },
      );
    }
    return merged;
  }

  remove(id: string) {
    this.cache = this.cache.filter((i) => i.id !== id);
    emitRepoChange();
    if (isBrowser) {
      deleteDoc(doc(db, this.name, id)).catch(writeError("delete"));
    }
  }

  /** Batched counterpart to remove() — see addBatched(). */
  removeBatched(batch: WriteBatch | null, id: string) {
    this.cache = this.cache.filter((i) => i.id !== id);
    emitRepoChange();
    if (isBrowser && batch) {
      batch.delete(doc(db, this.name, id));
    }
  }

  bulkRemove(ids: string[]) {
    const set = new Set(ids);
    this.cache = this.cache.filter((i) => !set.has(i.id));
    emitRepoChange();
    if (!isBrowser) return;
    void this.batchedDelete([...set]);
  }

  /** Import records (backup restore / migration) in Firestore-safe chunks. */
  async importAll(records: T[]): Promise<void> {
    if (!isBrowser || !records.length) return;
    for (let i = 0; i < records.length; i += 400) {
      const chunk = records.slice(i, i + 400);
      const batch = writeBatch(db);
      for (const r of chunk) {
        if (!r?.id) continue;
        batch.set(doc(db, this.name, r.id), stripUndefined(r));
      }
      await batch.commit();
    }
  }

  /** Delete every document in the collection (Settings → Clear All Data). */
  async clearAll(): Promise<void> {
    const ids = this.cache.map((r) => r.id);
    this.cache = [];
    emitRepoChange();
    await this.batchedDelete(ids);
  }

  private async batchedDelete(ids: string[]): Promise<void> {
    if (!isBrowser || !ids.length) return;
    try {
      for (let i = 0; i < ids.length; i += 400) {
        const chunk = ids.slice(i, i + 400);
        const batch = writeBatch(db);
        for (const id of chunk) batch.delete(doc(db, this.name, id));
        await batch.commit();
      }
    } catch (err) {
      writeError("bulk delete")(err);
    }
  }
}
