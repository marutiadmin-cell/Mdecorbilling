/**
 * Whether a consignment needs an e-way bill, and for how long it is good.
 *
 * A shop ships goods within its own state and across a border. Under GST a
 * consignment over the threshold may not move without an e-way bill, and the
 * penalty is ₹10,000 or the tax sought to be evaded, whichever is higher —
 * plus the lorry being held. So this is not a convenience feature; it is the
 * difference between a truck leaving and a truck being detained.
 *
 * Every rule here was looked up rather than remembered. The awkward ones, in
 * the order they catch people out:
 *
 *  · **Job work across a state border needs one at ANY value.** The ₹50,000
 *    threshold does not apply. A fabricator sending two brackets out for
 *    galvanising is the exact case this catches.
 *  · **The intra-state threshold is not ₹50,000 everywhere.** States set
 *    their own, from ₹50,000 to ₹2,00,000, so it is configuration rather
 *    than a constant.
 *  · **The threshold is per CONSIGNMENT, not per invoice.** Three invoices
 *    in one lorry are added together.
 *  · **Validity runs from the first Part-B entry**, not from the invoice
 *    date, and it is counted in whole days per 200 km bracket.
 *  · **A document more than 180 days old cannot have one generated at all.**
 *
 * Sources: CGST Rules 138-138D, as summarised by ClearTax's e-way bill guide
 * and the NIC portal's own rules.
 */

/** The interstate threshold, fixed nationally. Exceeded, not merely met. */
export const EWAY_INTERSTATE_THRESHOLD = 50000;

/** What most states use intra-state. A shop in a state that differs sets its
 *  own — this is the default, not the law. */
export const EWAY_DEFAULT_INTRASTATE_THRESHOLD = 50000;

/** Kilometres per day of validity. */
const KM_PER_DAY_REGULAR = 200;
const KM_PER_DAY_ODC = 20;

/** A document older than this cannot have an e-way bill raised against it. */
export const EWAY_MAX_DOCUMENT_AGE_DAYS = 180;

/**
 * Part B may be skipped only for a short hop inside one state — consignor to
 * transporter, under this distance.
 */
export const PART_B_EXEMPT_KM = 50;

export type CargoKind = "regular" | "odc";

/** Why the goods are moving. Drives the sub-supply type on the portal. */
export type MovementReason =
  | "supply"
  | "export"
  | "import"
  | "job-work"
  | "job-work-return"
  | "sales-return"
  | "branch-transfer"
  | "own-use"
  | "exhibition"
  | "line-sales"
  | "skd-ckd"
  | "others";

export const MOVEMENT_LABELS: Record<MovementReason, string> = {
  supply: "Supply",
  export: "Export",
  import: "Import",
  "job-work": "Job Work",
  "job-work-return": "Job Work Returns",
  "sales-return": "Sales Return",
  "branch-transfer": "Branch Transfer",
  "own-use": "For Own Use",
  exhibition: "Exhibition or Fairs",
  "line-sales": "Line Sales",
  "skd-ckd": "SKD / CKD",
  others: "Others",
};

/** What the movement is documented by. */
export type EwayDocType =
  | "invoice"
  | "bill-of-supply"
  | "delivery-challan"
  | "credit-note"
  | "others";

export const EWAY_DOC_LABELS: Record<EwayDocType, string> = {
  invoice: "Tax Invoice",
  "bill-of-supply": "Bill of Supply",
  "delivery-challan": "Delivery Challan",
  "credit-note": "Credit Note",
  others: "Others",
};

/**
 * The eleven cases the rules exempt outright. Kept as a named list because a
 * screen that offers "no e-way bill needed" has to be able to say WHY.
 */
export type EwayExemption =
  | "non-motorised"
  | "customs-supervision"
  | "nepal-bhutan-transit"
  | "defence"
  | "empty-container"
  | "weighbridge-20km"
  | "government-rail"
  | "exempt-goods"
  | "port-to-icd"
  | "customs-bond"
  | "schedule-iii";

export const EXEMPTION_LABELS: Record<EwayExemption, string> = {
  "non-motorised": "Moved by a non-motorised conveyance",
  "customs-supervision": "Under Customs supervision or seal",
  "nepal-bhutan-transit": "Transit cargo to or from Nepal or Bhutan",
  defence: "Defence formation under the Ministry of Defence",
  "empty-container": "Empty cargo container",
  "weighbridge-20km": "Within 20 km to a weighbridge, under a delivery challan",
  "government-rail": "Rail transport by a government or local authority",
  "exempt-goods": "Goods exempted under the state's own rules",
  "port-to-icd": "From a port or airport to an ICD or CFS for clearance",
  "customs-bond": "Under a Customs bond between stations",
  "schedule-iii": "Schedule III — not a supply",
};

export interface EwayQuestion {
  /** The value of everything in the vehicle, not of one invoice. */
  consignmentValue: number;
  /** Whether the goods cross a state border. */
  supply: "intra" | "inter";
  reason: MovementReason;
  /** The state's own intra-state threshold, where it differs from ₹50,000. */
  intrastateThreshold?: number;
  /** One of the eleven, if it applies. */
  exemption?: EwayExemption;
}

export type EwayVerdict =
  | { required: true; because: string }
  | { required: false; because: string };

/**
 * Whether this consignment may move without an e-way bill.
 *
 * Answers with a sentence either way, because "not required" is a claim
 * somebody may have to defend at a checkpoint and "₹49,900, under the
 * ₹50,000 intra-state limit" is a defence where a bare "no" is not.
 */
export function ewayRequired(q: EwayQuestion): EwayVerdict {
  if (q.exemption) {
    return { required: false, because: EXEMPTION_LABELS[q.exemption] };
  }

  /* Job work across a border needs one at any value — the threshold simply
     does not apply. This is the rule a fabricator breaks first, sending two
     brackets out for galvanising and assuming ₹50,000 protects them. */
  const jobWork = q.reason === "job-work" || q.reason === "job-work-return";
  if (jobWork && q.supply === "inter") {
    return {
      required: true,
      because: "Job work moving between states needs an e-way bill whatever it is worth.",
    };
  }

  const value = Number(q.consignmentValue) || 0;
  const limit =
    q.supply === "inter"
      ? EWAY_INTERSTATE_THRESHOLD
      : (q.intrastateThreshold ?? EWAY_DEFAULT_INTRASTATE_THRESHOLD);

  // "Exceeding", not "reaching" — a consignment of exactly the limit is under it.
  if (value > limit) {
    return {
      required: true,
      because: `The consignment is worth ${inr(value)}, over the ${
        q.supply === "inter" ? "interstate" : "state"
      } limit of ${inr(limit)}.`,
    };
  }
  return {
    required: false,
    because: `${inr(value)} is within the ${
      q.supply === "inter" ? "interstate" : "state"
    } limit of ${inr(limit)}. Remember the limit is per VEHICLE — add other invoices going with it.`,
  };
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/**
 * How many days an e-way bill is good for.
 *
 * One day per 200 km bracket for ordinary cargo, per 20 km for
 * over-dimensional. Counted from the first Part-B entry, never from the
 * invoice date — which is why a bill raised on Monday for a lorry that leaves
 * on Thursday has not been burning validity in between.
 */
export function validityDays(distanceKm: number, cargo: CargoKind = "regular"): number {
  const km = Math.max(0, Number(distanceKm) || 0);
  const per = cargo === "odc" ? KM_PER_DAY_ODC : KM_PER_DAY_REGULAR;
  return Math.max(1, Math.ceil(km / per));
}

/**
 * Whether the vehicle number may be left off.
 *
 * Only for a short hop inside one state. Part A is still mandatory — what is
 * excused is Part B, and only that.
 */
export function partBRequired(distanceKm: number, supply: "intra" | "inter"): boolean {
  if (supply === "inter") return true;
  return (Number(distanceKm) || 0) >= PART_B_EXEMPT_KM;
}

/** Whole days between two ISO dates, ignoring time. */
function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.floor((b - a) / 86_400_000);
}

/**
 * Whether an e-way bill can still be raised against this document.
 *
 * The portal refuses anything older than 180 days. Worth saying on the screen
 * rather than letting the shop find out at the portal with a lorry loaded.
 */
export function canRaiseFor(
  documentDate: string,
  todayIso: string,
): { ok: true } | { ok: false; because: string } {
  const age = daysBetween(documentDate, todayIso);
  if (age > EWAY_MAX_DOCUMENT_AGE_DAYS) {
    return {
      ok: false,
      because: `This document is ${age} days old. An e-way bill can only be raised within ${EWAY_MAX_DOCUMENT_AGE_DAYS} days of it.`,
    };
  }
  return { ok: true };
}

/** Who is expected to raise it, in the order the rules give. */
export function whoGenerates(opts: {
  supplierRegistered: boolean;
  recipientRegistered: boolean;
}): "supplier" | "recipient" | "transporter" {
  if (opts.supplierRegistered) return "supplier";
  if (opts.recipientRegistered) return "recipient";
  return "transporter";
}
