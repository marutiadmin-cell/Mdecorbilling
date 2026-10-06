/**
 * The business's own paperwork: GST certificate, PAN, licences, insurance,
 * drawings, signed contracts — anything the shop needs to be able to produce
 * on demand and would otherwise hunt for in somebody's WhatsApp.
 *
 * Two halves, and they live in different places. The FILE goes to Firebase
 * Storage, because a scanned certificate is megabytes and Firestore's
 * document ceiling is one; the RECORD — what the shop calls it, when it was
 * put there, who by — goes to Firestore like everything else, so the list
 * loads offline and the search works without downloading anything.
 *
 * This module is the rules that decide whether an upload is allowed and what
 * it is called. Pure, and separate from both stores, because the answers are
 * about the shop's filing rather than about either vendor's API.
 */

/**
 * The biggest file that may be uploaded.
 *
 * Not a technical limit — Storage takes far more. It is a limit on what a
 * phone on shop wifi can actually finish, and on what the shop will wait for
 * when they are asked for the GST certificate with a customer standing there.
 * A 25MB scan is already a bad scan.
 */
export const MAX_DOC_BYTES = 25 * 1024 * 1024;

/** What a stored document knows about itself, minus the file. */
export interface BusinessDocLike {
  name: string;
  fileName?: string;
  note?: string;
}

export type UploadRefusal =
  | { ok: true }
  | { ok: false; reason: "no-file" | "no-name" | "too-big" | "duplicate-name"; message: string };

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Human size, for a list the shop reads rather than a log. */
export function prettySize(bytes: number): string {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${Math.max(0, Math.round(n))} B`;
  if (n < 1024 * 1024) return `${r1(n / 1024)} KB`;
  return `${r1(n / (1024 * 1024))} MB`;
}

/**
 * A sensible starting name for a file the shop has just chosen.
 *
 * The extension goes, because the shop names the DOCUMENT ("GST Certificate")
 * and the file keeps its own name alongside — and underscores and hyphens
 * become spaces, because a phone camera's `IMG_20260921_114233` is not a name
 * anybody typed on purpose.
 */
export function suggestedName(fileName: string): string {
  const base = String(fileName || "")
    .replace(/\.[^./\\]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return base;
}

/**
 * Whether this upload may go ahead.
 *
 * The duplicate check is on the NAME, not the file: two scans of the same
 * certificate under one name is how a vault stops being trustworthy — the
 * shop cannot tell which is current. Refused with the name said back, so the
 * person can decide to rename or to replace.
 */
export function validateUpload(
  file: { name: string; size: number } | null | undefined,
  docName: string,
  existingNames: string[],
): UploadRefusal {
  if (!file) return { ok: false, reason: "no-file", message: "Choose a file to upload." };

  const name = (docName || "").trim();
  if (!name) {
    return { ok: false, reason: "no-name", message: "Give this document a name you'll recognise." };
  }

  if (file.size > MAX_DOC_BYTES) {
    return {
      ok: false,
      reason: "too-big",
      message: `${prettySize(file.size)} is too large — the limit is ${prettySize(MAX_DOC_BYTES)}. Scan it at a lower quality, or split it.`,
    };
  }

  const clash = existingNames.find((n) => n.trim().toLowerCase() === name.toLowerCase());
  if (clash) {
    return {
      ok: false,
      reason: "duplicate-name",
      message: `"${clash}" is already saved. Use a different name, or delete that one first.`,
    };
  }

  return { ok: true };
}

/**
 * Where the file lives in Storage.
 *
 * Keyed by the record's id, so two documents can share a file name and
 * neither overwrites the other — and renaming the document later moves
 * nothing, because the path never mentioned the name the shop chose.
 *
 * The file name is still carried through, so a download arrives called what
 * it was called, but it is stripped of everything Storage treats specially.
 */
export function storagePathFor(id: string, fileName: string): string {
  const safe =
    String(fileName || "file")
      .replace(/[#?[\]*\\/]+/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "file";
  return `business-docs/${id}/${safe}`;
}

/** Whether a document answers a search box. Name, file name and note. */
export function docMatches(query: string, doc: BusinessDocLike): boolean {
  const q = (query || "").trim().toLowerCase();
  if (!q) return true;
  return q
    .split(/\s+/)
    .every((word) =>
      [doc.name, doc.fileName, doc.note].some((f) => (f || "").toLowerCase().includes(word)),
    );
}
