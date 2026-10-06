/**
 * Who the customer is, for GST — and the one question that decides the tax.
 *
 * A GSTIN is not an opaque string. Its first two characters are the state,
 * characters 3-12 are the holder's PAN, and the last is a checksum over the
 * rest. All three are worth reading, because all three catch a mistake before
 * it reaches a filed return:
 *
 *   · the state decides whether a bill carries CGST+SGST or IGST
 *   · the PAN must match the PAN written on the same customer
 *   · the checksum catches a transposed digit, which is the commonest way a
 *     GSTIN is wrong and the hardest to spot by eye
 *
 * The state question is the one that moves money. A supply inside the seller's
 * own state is taxed half to the centre and half to the state; a supply to
 * another state is taxed once, to the centre, as IGST. Same total, two
 * completely different invoices, and a shop billing Surat from Gujarat and
 * Mumbai from Gujarat has to get both right on the same day.
 */

/** GST state codes. The first two digits of every GSTIN. */
export const GST_STATES: Record<string, string> = {
  "01": "Jammu and Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman and Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh",
  "97": "Other Territory",
};

/** Picker-friendly, in code order. */
export const GST_STATE_LIST = Object.entries(GST_STATES).map(([code, name]) => ({ code, name }));

/** How this customer is registered, which changes what a bill may claim. */
export type GstType = "registered" | "unregistered" | "composition" | "consumer" | "sez" | "export";

export const GST_TYPE_LABELS: Record<GstType, string> = {
  registered: "Registered",
  unregistered: "Unregistered",
  composition: "Composition",
  consumer: "Consumer",
  sez: "SEZ",
  export: "Export / Overseas",
};

const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

export const normaliseGstin = (v: string | undefined): string =>
  (v ?? "").replace(/\s+/g, "").toUpperCase();

/**
 * The check character a GSTIN's first 14 characters imply.
 *
 * The published algorithm: weight each position alternately 1 and 2 from the
 * right, fold anything over 36 by adding its quotient to its remainder, and
 * the check character is whatever makes the total a multiple of 36.
 */
export function gstinCheckChar(first14: string): string | null {
  const s = first14.slice(0, 14);
  if (s.length !== 14) return null;
  let factor = 2;
  let sum = 0;
  for (let i = s.length - 1; i >= 0; i -= 1) {
    const cp = CHARS.indexOf(s[i]);
    if (cp < 0) return null;
    let digit = factor * cp;
    factor = factor === 2 ? 1 : 2;
    digit = Math.floor(digit / 36) + (digit % 36);
    sum += digit;
  }
  return CHARS[(36 - (sum % 36)) % 36];
}

export type GstinVerdict =
  | { ok: true; stateCode: string; state: string; pan: string }
  | { ok: false; problem: "empty" | "length" | "shape" | "state" | "checksum"; message: string };

/**
 * Read a GSTIN, or say exactly what is wrong with it.
 *
 * Named problems rather than a boolean, because "invalid GSTIN" tells the
 * person at the counter nothing: a wrong length is a paste that lost a
 * character, a failed checksum is a typo in a digit, and an unknown state code
 * is usually the wrong first two digits entirely.
 */
export function readGstin(raw: string | undefined): GstinVerdict {
  const v = normaliseGstin(raw);
  if (!v) return { ok: false, problem: "empty", message: "No GSTIN entered." };
  if (v.length !== 15) {
    return {
      ok: false,
      problem: "length",
      message: `A GSTIN is 15 characters — this one is ${v.length}.`,
    };
  }
  if (!GSTIN_SHAPE.test(v)) {
    return {
      ok: false,
      problem: "shape",
      message: "That is not the shape of a GSTIN — 2 digits, then a PAN, then 3 more characters.",
    };
  }
  const stateCode = v.slice(0, 2);
  if (!GST_STATES[stateCode]) {
    return {
      ok: false,
      problem: "state",
      message: `${stateCode} is not a GST state code — check the first two digits.`,
    };
  }
  if (gstinCheckChar(v) !== v[14]) {
    return {
      ok: false,
      problem: "checksum",
      message: "That GSTIN's check digit does not match — a character is mistyped.",
    };
  }
  return { ok: true, stateCode, state: GST_STATES[stateCode], pan: v.slice(2, 12) };
}

/** The state two digits name, or undefined. Safe on a half-typed GSTIN. */
export function stateFromGstin(
  raw: string | undefined,
): { code: string; name: string } | undefined {
  const code = normaliseGstin(raw).slice(0, 2);
  const name = GST_STATES[code];
  return name ? { code, name } : undefined;
}

/**
 * Which tax a bill between these two states carries.
 *
 * Unknown either side is treated as INTRA-state, deliberately. Every bill this
 * app has written so far has been CGST+SGST, and a party with no state
 * recorded — which is all of them until this ships — must keep printing
 * exactly what it printed yesterday. Interstate is something the shop opts
 * into by recording where the customer is.
 */
export function supplyKind(
  sellerStateCode: string | undefined,
  buyerStateCode: string | undefined,
): "intra" | "inter" {
  const a = (sellerStateCode ?? "").trim();
  const b = (buyerStateCode ?? "").trim();
  if (!a || !b) return "intra";
  return a === b ? "intra" : "inter";
}

/** How one bill's tax is split, given the supply. */
export interface TaxSplit {
  cgst: number;
  sgst: number;
  igst: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Split a tax amount the way the supply requires.
 *
 * The TOTAL never changes — this only decides which columns it appears in.
 * Halving is done once and the second half taken by subtraction, so an odd
 * paisa lands somewhere rather than vanishing: 0.05 becomes 0.02 and 0.03,
 * never 0.02 and 0.02.
 */
export function splitTax(tax: number, kind: "intra" | "inter"): TaxSplit {
  const total = r2(Number(tax) || 0);
  if (kind === "inter") return { cgst: 0, sgst: 0, igst: total };
  const cgst = r2(total / 2);
  return { cgst, sgst: r2(total - cgst), igst: 0 };
}

/** A line-item total grouped by its own GST rate, before any bill-level
 *  charge or discount is folded in. */
export interface RateBucket {
  rate: number;
  taxable: number;
}

/**
 * Spread a bill-level amount — a discount (pass it negative) or a shipping
 * charge (positive) — across each GST-rate bucket, weighted by that bucket's
 * own share of the taxable total, then tax each bucket at ITS OWN rate.
 *
 * This is the GST-compliant way to apply a whole-bill charge or discount on a
 * MULTI-RATE invoice: Section 15(3)(a) excludes a discount recorded on the
 * invoice from the taxable value, and freight billed as part of the same
 * supply is taxed as a composite supply at the rate(s) of the goods it rides
 * with — neither rule means "tax it once at some blended average rate,"
 * which is what adding the charge after tax (or not taxing it at all) used
 * to do here. A ₹100 discount on a bill that's half 5% and half 18% goods
 * reduces ₹50 of 5% taxable value and ₹50 of 18% taxable value, not ₹100 of
 * one or the other.
 *
 * Each bucket is rounded independently, so the buckets can land a paisa or
 * two off from a single combined rounding — the same kind of residual
 * `splitTax` avoids for a 2-way split by construction, but not practical to
 * eliminate across an arbitrary number of rate buckets. The invoice's own
 * whole-rupee round-off absorbs anything left over at the total, same as it
 * always has.
 *
 * `amount` of 0, or no taxable value to weigh shares against (nothing on the
 * bill carries this rate yet), returns the buckets untouched other than
 * computing their own tax — never divides by zero, never invents a split
 * from nothing.
 */
export function allocateAcrossRateBuckets(
  buckets: RateBucket[],
  amount: number,
): { rate: number; taxable: number; tax: number }[] {
  const totalTaxable = buckets.reduce((s, b) => s + b.taxable, 0);
  if (!amount || totalTaxable <= 0) {
    return buckets.map((b) => ({ rate: b.rate, taxable: b.taxable, tax: r2(b.taxable * (b.rate / 100)) }));
  }
  return buckets.map((b) => {
    const share = b.taxable / totalTaxable;
    const taxable = r2(b.taxable + amount * share);
    return { rate: b.rate, taxable, tax: r2(taxable * (b.rate / 100)) };
  });
}
