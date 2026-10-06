/**
 * The two papers that come before a tax invoice.
 *
 * The standard sequence, not one invented here: an enquiry arrives, the shop
 * sends a **quotation**; the customer agrees, the shop sends a **proforma
 * invoice** — often to collect an advance or to give the buyer something their
 * bank will accept; the goods go out, and only then is a **tax invoice**
 * raised.
 *
 * Three rules follow from that, and all three are about what these documents
 * must NOT do:
 *
 *  1. **Neither creates a GST liability and neither gives the buyer input
 *     credit.** GST attaches to the tax invoice. So nothing here posts to the
 *     ledger, moves stock, or appears in a GST return.
 *
 *  2. **Neither may consume a tax-invoice number.** Rule 46 wants that series
 *     consecutive and unique for the financial year; a proforma that took a
 *     number from it would leave a hole an auditor has to explain. Each kind
 *     has its own series.
 *
 *  3. **A proforma is not converted INTO a tax invoice.** A new tax invoice is
 *     raised and the proforma is marked as having led to it. The heading is
 *     what makes a document legally what it is — label a proforma "invoice"
 *     and it becomes one — so converting by relabelling is the one thing that
 *     must be impossible.
 *
 * Sources: CGST Rule 46; ClearTax and TaxAdda on the status of a proforma
 * under GST.
 */

export type EstimateKind = "quotation" | "proforma";

/** Where a quotation or proforma has got to. */
export type EstimateStatus = "open" | "converted" | "cancelled";

export interface EstimateSpec {
  kind: EstimateKind;
  /** What the document is headed. Legally load-bearing — see rule 3 above. */
  heading: string;
  label: string;
  plural: string;
  /** Default numbering prefix. Its own series, never the invoice's. */
  prefix: string;
  /** What this becomes next, or null where the chain ends at a tax invoice. */
  next: EstimateKind | null;
  /**
   * The line the document carries so it cannot be mistaken for a tax invoice.
   * Empty for a quotation, which nobody mistakes for one.
   */
  disclaimer: string;
}

const SPECS: Record<EstimateKind, EstimateSpec> = {
  quotation: {
    kind: "quotation",
    heading: "QUOTATION",
    label: "Quotation",
    plural: "Quotations",
    prefix: "QT-",
    next: "proforma",
    disclaimer: "",
  },
  proforma: {
    kind: "proforma",
    heading: "PROFORMA INVOICE",
    label: "Proforma Invoice",
    plural: "Proforma Invoices",
    prefix: "PI-",
    next: null,
    /* Said on the document itself. A proforma looks exactly like an invoice —
       that is the point of it — and the only thing separating the two for the
       person holding it is this line and the heading. */
    disclaimer: "This is not a tax invoice. No input tax credit may be claimed against it.",
  },
};

export const estimateSpec = (kind: EstimateKind): EstimateSpec => SPECS[kind];
export const ESTIMATE_KINDS = Object.keys(SPECS) as EstimateKind[];

/** The minimum shape these rules need. */
export interface EstimateLike {
  kind: EstimateKind;
  status: EstimateStatus;
  number: string;
  /** The price is only good until this date, where one is set. */
  validUntil?: string;
  convertedToId?: string;
}

/**
 * Whether this may still become the next document.
 *
 * Expiry is deliberately NOT a refusal. A quotation past its date is a price
 * the shop may still choose to honour, and that is a decision for a person
 * with the customer in front of them — the screen warns, it does not block.
 */
export function canConvert(doc: Pick<EstimateLike, "status">): boolean {
  return doc.status === "open";
}

/** Whether the price on it has passed its own date. A warning, not a state. */
export function isExpired(doc: Pick<EstimateLike, "validUntil">, today: string): boolean {
  return !!doc.validUntil && doc.validUntil < today;
}

/**
 * What a document's number tells you it is.
 *
 * Used to keep the series apart: a number issued in one series must never be
 * reachable from another, because that is how a tax invoice ends up with a
 * hole in it.
 */
export function seriesOf(
  number: string,
  prefixes: Record<EstimateKind, string>,
): EstimateKind | "invoice" {
  const n = (number ?? "").trim().toUpperCase();
  for (const kind of ESTIMATE_KINDS) {
    const p = (prefixes[kind] ?? SPECS[kind].prefix).toUpperCase();
    if (p && n.startsWith(p)) return kind;
  }
  return "invoice";
}

/**
 * Never. Not once, under any circumstance.
 *
 * Exists as a named, tested rule rather than as an absence, because "the
 * quotation screen happens not to call the stock code" is a fact about today's
 * code and "a quotation moves no stock" is a fact about the business. The
 * second one is the one worth being able to break a test over.
 */
export const ESTIMATE_MOVES_STOCK = false;
export const ESTIMATE_POSTS_TO_LEDGER = false;

/**
 * What carries forward when one document becomes the next.
 *
 * Everything that describes the deal; nothing that describes a payment. A
 * proforma may have collected an advance, but that advance is a receipt
 * against the customer, not a part of the tax invoice's own history — and
 * copying a `paid` figure onto a new document is how a bill gets marked
 * settled for money nobody received.
 */
export function carriedFields<T extends Record<string, unknown>>(doc: T): Partial<T> {
  const carry = [
    "partyId",
    "partyName",
    "partyPhone",
    "partyGstin",
    "partyAddress",
    "partyState",
    "placeOfSupply",
    "gstEnabled",
    "reverseCharge",
    "lineItems",
    "discount",
    "shippingCharge",
    "additionalCharges",
    "notes",
  ] as const;
  const out: Record<string, unknown> = {};
  for (const k of carry) {
    if (doc[k] !== undefined) out[k] = doc[k];
  }
  return out as Partial<T>;
}

/**
 * What has been received against one proforma.
 *
 * Only money IN, and only money tagged with this document. A proforma is not
 * a receivable — nothing is "settled" against it — so this is a reading of
 * the receipts the shop chose to associate with it, not a balance the ledger
 * knows about. The ledger's own view of that money is unchanged: it is an
 * advance sitting on the customer's account.
 */
export function advanceAgainst(
  estimateId: string,
  payments: { type: "in" | "out"; amount: number; againstEstimateId?: string }[],
): number {
  if (!estimateId) return 0;
  const total = payments
    .filter((p) => p.type === "in" && p.againstEstimateId === estimateId)
    .reduce((n, p) => n + (Number(p.amount) || 0), 0);
  return Math.round(total * 100) / 100;
}

/** What is still to come on a proforma, once advances are taken off. */
export function balanceAfterAdvance(total: number, advance: number): number {
  const left = (Number(total) || 0) - (Number(advance) || 0);
  // Over-paid is not negative "due" — it is nothing due, and an advance the
  // customer's account already carries.
  return Math.round(Math.max(0, left) * 100) / 100;
}
