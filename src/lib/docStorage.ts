/**
 * The file half of the document vault — Firebase Storage.
 *
 * Kept apart from `businessDocs.ts` (which is the rules) and from the
 * repository (which is the record), because this is the only part that needs
 * the network to be up and the only part that can fail in ways the shop has
 * to be told about in words.
 *
 * Every failure here is turned into a sentence naming what to do. Storage
 * returns codes like `storage/unauthorized`, and a shop being shown that
 * during a demo learns nothing except that the software is broken.
 */

import { getStorage, ref, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import { firebaseApp, isBrowser } from "@/lib/firebase";

function storage() {
  if (!isBrowser || !firebaseApp) {
    throw new Error("Documents are only available in the browser.");
  }
  return getStorage(firebaseApp);
}

/** Storage's own code, in a sentence someone can act on. */
function explain(err: unknown, doing: string): Error {
  const code = (err as { code?: string })?.code ?? "";
  if (code === "storage/unauthorized") {
    return new Error(
      `Not allowed to ${doing}. The Storage security rules have not been published yet — ` +
        "see storage.rules in the project, and publish it in the Firebase console.",
    );
  }
  if (code === "storage/unknown" || code === "storage/retry-limit-exceeded") {
    return new Error(
      `Could not ${doing} — the connection dropped part-way. Try again on a better signal.`,
    );
  }
  if (code === "storage/object-not-found") {
    return new Error(
      "That file is no longer in storage — the record is here but the file is gone.",
    );
  }
  if (code === "storage/quota-exceeded") {
    return new Error("The project's storage is full. Free some space, or raise the quota.");
  }
  const msg = (err as Error)?.message ?? String(err);
  return new Error(`Could not ${doing} — ${msg}`);
}

/** Put the bytes somewhere, and say where. */
export async function uploadDoc(path: string, file: File): Promise<void> {
  try {
    await uploadBytes(ref(storage(), path), file, {
      contentType: file.type || "application/octet-stream",
      // So a download arrives named what the shop uploaded, rather than as
      // the storage key.
      contentDisposition: `attachment; filename="${file.name.replace(/"/g, "")}"`,
    });
  } catch (err) {
    throw explain(err, "upload this document");
  }
}

/** A URL the browser can fetch. Short-lived by Storage's own design. */
export async function docDownloadUrl(path: string): Promise<string> {
  try {
    return await getDownloadURL(ref(storage(), path));
  } catch (err) {
    throw explain(err, "open this document");
  }
}

/**
 * Remove the file.
 *
 * A file that is already gone is not an error worth stopping for: the record
 * is being deleted too, and refusing to finish would leave the shop with a row
 * they cannot get rid of.
 */
export async function deleteDoc(path: string): Promise<void> {
  try {
    await deleteObject(ref(storage(), path));
  } catch (err) {
    if ((err as { code?: string })?.code === "storage/object-not-found") return;
    throw explain(err, "delete this document");
  }
}
